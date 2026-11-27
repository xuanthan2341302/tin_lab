import crypto from 'node:crypto'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type {
  AgentConfidenceLevel,
  AgentMatchMethod,
  AnswerOptionKey,
  AnswerProvisionMode,
  AnswerStatus,
  CognitiveLevel,
  ExtractedQuestion,
  QuestionType,
  SourceFileFormat,
} from '../src/types.ts'

export class DocumentParserError extends Error {
  step: 'read_file' | 'parse_docx' | 'extract_structure'
  code: string

  constructor(
    step: 'read_file' | 'parse_docx' | 'extract_structure',
    code: string,
    message: string
  ) {
    super(message)
    this.name = 'DocumentParserError'
    this.step = step
    this.code = code
  }
}

export interface ExtractedLine {
  text: string
  rawHtmlTaggedText: string
  pageNumber: number | null
}

export interface ExtractedTableCell {
  plain: string
  tagged: string
  lines: ExtractedLine[]
}

export type DocumentBlock =
  | {
      kind: 'paragraph'
      line: ExtractedLine
    }
  | {
      kind: 'table'
      rows: ExtractedTableCell[][]
      pageNumber: number | null
    }

export interface ParsedDocumentContent {
  lines: ExtractedLine[]
  tableRows: string[][]
  blocks: DocumentBlock[]
  pageCount: number | null
  warnings: string[]
}

export interface RichDocumentExtractionResult {
  fileHash: string
  pageCount: number | null
  plainText: string
  richAnnotatedText: string
  tableRows: string[][]
  warnings: string[]
}

type StatementLetter = 'a' | 'b' | 'c' | 'd'
const VALID_ANSWER_KEYS: ReadonlyArray<AnswerOptionKey> = ['A', 'B', 'C', 'D']
const STATEMENT_LETTERS: ReadonlyArray<StatementLetter> = ['a', 'b', 'c', 'd']

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function normalizeForHash(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function computeQuestionContentHash(
  questionType: QuestionType,
  questionText: string,
  parts: string[]
): string {
  const prefix = questionType === 'multiple_choice' ? '' : `${questionType}|`
  const canonical = `${prefix}${[questionText, ...parts]
    .map(normalizeForHash)
    .join('|')}`
  return sha256Hex(canonical)
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/gi, (_m, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10))
    )
}

function stripTagsPreservingUnderline(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n')
  const withUnderline = withBreaks
    .replace(/<u>([\s\S]*?)<\/u>/gi, '[[U]]$1[[/U]]')
    .replace(/<mark\b[^>]*>([\s\S]*?)<\/mark>/gi, '[[HL]]$1[[/HL]]')
    .replace(/<\/?(?:strong|b|em|i|span|sup|sub|a)[^>]*>/gi, '')
  const plain = withUnderline.replace(/<[^>]+>/g, ' ')
  return decodeXmlEntities(plain)
}

export function stripInternalMarkers(text: string): string {
  return text
    .replace(/\[\[\/?(?:U|B|HL|CLR(?::[^\]]+)?)\]\]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

export function formatInternalMarkersForAi(text: string): string {
  return text
    .replace(/\[\[U\]\]/g, '[GẠCH_CHÂN]')
    .replace(/\[\[\/U\]\]/g, '[/GẠCH_CHÂN]')
    .replace(/\[\[B\]\]/g, '[IN_ĐẬM]')
    .replace(/\[\[\/B\]\]/g, '[/IN_ĐẬM]')
    .replace(/\[\[HL\]\]/g, '[TÔ_NỀN]')
    .replace(/\[\[\/HL\]\]/g, '[/TÔ_NỀN]')
    .replace(/\[\[CLR:([^\]]+)\]\]/g, '[MÀU_CHỮ:$1]')
    .replace(/\[\[\/CLR\]\]/g, '[/MÀU_CHỮ]')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/* ============================================================================
 * DOCX XML PARSING (WITH WORD NUMBERING, TABLES IN DOCUMENT ORDER & STYLES)
 * ========================================================================== */

interface NumberingLevelDef {
  numFmt: string
  lvlText: string
  start: number
}

interface ParsedNumberingModel {
  abstractLevels: Map<string, Map<number, NumberingLevelDef>>
  numToAbstract: Map<string, string>
  numOverrides: Map<string, Map<number, NumberingLevelDef>>
  styleNumPr: Map<string, { numId: string; ilvl: number }>
}

function formatNumberingCounter(numFmt: string, val: number): string {
  const safeVal = Math.max(1, val)
  switch (numFmt) {
    case 'upperLetter': {
      const idx = (safeVal - 1) % 26
      return String.fromCharCode(65 + idx)
    }
    case 'lowerLetter': {
      const idx = (safeVal - 1) % 26
      return String.fromCharCode(97 + idx)
    }
    case 'lowerRoman':
    case 'upperRoman': {
      const numerals: [number, string][] = [
        [1000, 'M'],
        [900, 'CM'],
        [500, 'D'],
        [400, 'CD'],
        [100, 'C'],
        [90, 'XC'],
        [50, 'L'],
        [40, 'XL'],
        [10, 'X'],
        [9, 'IX'],
        [5, 'V'],
        [4, 'IV'],
        [1, 'I'],
      ]
      let rem = safeVal
      let out = ''
      for (const [n, sym] of numerals) {
        while (rem >= n) {
          out += sym
          rem -= n
        }
      }
      return numFmt === 'lowerRoman' ? out.toLowerCase() : out
    }
    case 'bullet':
    case 'none':
      return ''
    default:
      return String(safeVal)
  }
}

async function parseDocxNumberingAndStyles(zip: JSZip): Promise<ParsedNumberingModel> {
  const abstractLevels = new Map<string, Map<number, NumberingLevelDef>>()
  const numToAbstract = new Map<string, string>()
  const numOverrides = new Map<string, Map<number, NumberingLevelDef>>()
  const styleNumPr = new Map<string, { numId: string; ilvl: number }>()

  const numberingFile = zip.file('word/numbering.xml')
  if (numberingFile) {
    const numXml = await numberingFile.async('string')
    const absRegex =
      /<w:abstractNum\b[^>]*w:abstractNumId=["'](\d+)["'][^>]*>([\s\S]*?)<\/w:abstractNum>/gi
    let am: RegExpExecArray | null
    while ((am = absRegex.exec(numXml)) !== null) {
      const absId = am[1]
      const body = am[2]
      const lvls = new Map<number, NumberingLevelDef>()
      const lvlRegex = /<w:lvl\b[^>]*w:ilvl=["'](\d+)["'][^>]*>([\s\S]*?)<\/w:lvl>/gi
      let lm: RegExpExecArray | null
      while ((lm = lvlRegex.exec(body)) !== null) {
        const ilvl = Number(lm[1])
        const lBody = lm[2]
        const fmtMatch = lBody.match(/<w:numFmt\b[^>]*w:val=["']([^"']+)["']/i)
        const txtMatch = lBody.match(/<w:lvlText\b[^>]*w:val=["']([^"']*)["']/i)
        const startMatch = lBody.match(/<w:start\b[^>]*w:val=["'](\d+)["']/i)
        lvls.set(ilvl, {
          numFmt: fmtMatch?.[1] || 'decimal',
          lvlText: decodeXmlEntities(txtMatch?.[1] ?? '%1.'),
          start: startMatch ? Number(startMatch[1]) : 1,
        })
      }
      abstractLevels.set(absId, lvls)
    }

    const numRegex = /<w:num\b[^>]*w:numId=["'](\d+)["'][^>]*>([\s\S]*?)<\/w:num>/gi
    let nm: RegExpExecArray | null
    while ((nm = numRegex.exec(numXml)) !== null) {
      const numId = nm[1]
      const nBody = nm[2]
      const absRef = nBody.match(/<w:abstractNumId\b[^>]*w:val=["'](\d+)["']/i)
      if (absRef) {
        numToAbstract.set(numId, absRef[1])
      }
      const ovRegex = /<w:lvlOverride\b[^>]*w:ilvl=["'](\d+)["'][^>]*>([\s\S]*?)<\/w:lvlOverride>/gi
      let om: RegExpExecArray | null
      while ((om = ovRegex.exec(nBody)) !== null) {
        const ilvl = Number(om[1])
        const oBody = om[2]
        const startOv = oBody.match(/<w:startOverride\b[^>]*w:val=["'](\d+)["']/i)
        const absId = absRef?.[1]
        const baseDef = absId ? abstractLevels.get(absId)?.get(ilvl) : undefined
        if (baseDef || startOv) {
          const map = numOverrides.get(numId) ?? new Map<number, NumberingLevelDef>()
          map.set(ilvl, {
            numFmt: baseDef?.numFmt || 'decimal',
            lvlText: baseDef?.lvlText || '%1.',
            start: startOv ? Number(startOv[1]) : baseDef?.start ?? 1,
          })
          numOverrides.set(numId, map)
        }
      }
    }
  }

  const stylesFile = zip.file('word/styles.xml')
  if (stylesFile) {
    const stylesXml = await stylesFile.async('string')
    const stRegex = /<w:style\b[^>]*w:styleId=["']([^"']+)["'][^>]*>([\s\S]*?)<\/w:style>/gi
    let sm: RegExpExecArray | null
    while ((sm = stRegex.exec(stylesXml)) !== null) {
      const styleId = sm[1]
      const sBody = sm[2]
      const numIdMatch = sBody.match(/<w:numId\b[^>]*w:val=["'](\d+)["']/i)
      if (numIdMatch && numIdMatch[1] !== '0') {
        const ilvlMatch = sBody.match(/<w:ilvl\b[^>]*w:val=["'](\d+)["']/i)
        styleNumPr.set(styleId, {
          numId: numIdMatch[1],
          ilvl: ilvlMatch ? Number(ilvlMatch[1]) : 0,
        })
      }
    }
  }

  return { abstractLevels, numToAbstract, numOverrides, styleNumPr }
}

class DocxNumberingTracker {
  private model: ParsedNumberingModel
  private counters = new Map<string, number>()

  constructor(model: ParsedNumberingModel) {
    this.model = model
  }

  resolveParagraphPrefix(pXml: string, plainText: string): string {
    if (!plainText.trim()) return ''

    const pPrMatch = pXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/i)
    if (!pPrMatch) return ''
    const pPr = pPrMatch[0]

    let numId: string | null = null
    let ilvl = 0

    const numIdMatch = pPr.match(/<w:numId\b[^>]*w:val=["'](\d+)["']/i)
    if (numIdMatch) {
      if (numIdMatch[1] === '0') return ''
      numId = numIdMatch[1]
      const ilvlMatch = pPr.match(/<w:ilvl\b[^>]*w:val=["'](\d+)["']/i)
      ilvl = ilvlMatch ? Number(ilvlMatch[1]) : 0
    } else {
      const styleMatch = pPr.match(/<w:pStyle\b[^>]*w:val=["']([^"']+)["']/i)
      if (styleMatch && this.model.styleNumPr.has(styleMatch[1])) {
        const ref = this.model.styleNumPr.get(styleMatch[1])!
        numId = ref.numId
        ilvl = ref.ilvl
      }
    }

    if (!numId) return ''

    const absId = this.model.numToAbstract.get(numId)
    const def =
      this.model.numOverrides.get(numId)?.get(ilvl) ??
      (absId ? this.model.abstractLevels.get(absId)?.get(ilvl) : undefined)
    if (!def || def.numFmt === 'bullet' || def.numFmt === 'none') return ''

    const counterKey = `${numId}:${ilvl}`
    const current = this.counters.has(counterKey)
      ? this.counters.get(counterKey)! + 1
      : def.start
    this.counters.set(counterKey, current)

    // Reset deeper levels when an outer level increments
    for (const k of Array.from(this.counters.keys())) {
      const [kNumId, kLvlStr] = k.split(':')
      if (kNumId === numId && Number(kLvlStr) > ilvl) {
        this.counters.delete(k)
      }
    }

    const formatted = formatNumberingCounter(def.numFmt, current)
    if (!formatted) return ''

    let label = def.lvlText
      .replace(/%\d+/g, (tok) => {
        const refLvl = Number(tok.slice(1)) - 1
        if (refLvl === ilvl) return formatted
        const parentCount = this.counters.get(`${numId}:${refLvl}`)
        if (parentCount !== undefined) {
          const parentDef =
            this.model.numOverrides.get(numId)?.get(refLvl) ??
            (absId ? this.model.abstractLevels.get(absId)?.get(refLvl) : undefined)
          return formatNumberingCounter(parentDef?.numFmt || 'decimal', parentCount)
        }
        return formatted
      })
      .trim()

    if (!label) return ''
    if (!/[.:)]$/.test(label)) {
      label += '.'
    }

    const trimmedPlain = plainText.trim()
    // Avoid duplicating if the paragraph text already carries an explicit label
    if (
      /^(?:Câu|Question)\s+\d+/i.test(trimmedPlain) ||
      /^[ABCD]\s*[.)]\s+/i.test(trimmedPlain) ||
      /^[abcd]\s*[.)]\s+/i.test(trimmedPlain) ||
      /^\d{1,3}\s*[.)]\s+/.test(trimmedPlain)
    ) {
      return ''
    }

    return `${label} `
  }
}

function extractXmlRunStyleSignals(rPrXml: string): {
  isBold: boolean
  isUnderline: boolean
  isHighlight: boolean
  colorHex: string | null
} {
  if (!rPrXml) {
    return { isBold: false, isUnderline: false, isHighlight: false, colorHex: null }
  }

  const bMatch = rPrXml.match(/<w:b\b(?:\s+[^>]*w:val=["']([^"']+)["'])?[^>]*\/?>/i)
  const isBold = Boolean(
    bMatch && bMatch[1]?.toLowerCase() !== 'false' && bMatch[1] !== '0'
  )

  const uMatch = rPrXml.match(/<w:u\b(?:\s+[^>]*w:val=["']([^"']+)["'])?[^>]*\/?>/i)
  const isUnderline = Boolean(uMatch && uMatch[1]?.toLowerCase() !== 'none')

  const hlMatch = rPrXml.match(/<w:highlight\b[^>]*w:val=["']([^"']+)["'][^>]*\/?>/i)
  const hasHighlight = Boolean(hlMatch && hlMatch[1].toLowerCase() !== 'none')

  const shdMatch = rPrXml.match(/<w:shd\b[^>]*w:fill=["']([^"']+)["'][^>]*\/?>/i)
  const shdFill = shdMatch?.[1]?.toUpperCase() ?? ''
  const hasShading = Boolean(
    shdFill && shdFill !== 'AUTO' && shdFill !== 'NONE' && shdFill !== 'FFFFFF'
  )

  const colorMatch = rPrXml.match(/<w:color\b[^>]*w:val=["']([^"']+)["'][^>]*\/?>/i)
  const rawColor = colorMatch?.[1]?.toUpperCase() ?? ''
  const colorHex =
    rawColor &&
    rawColor !== 'AUTO' &&
    rawColor !== '000000' &&
    rawColor !== '000001' &&
    rawColor !== 'FFFFFF'
      ? `#${rawColor}`
      : null

  return {
    isBold,
    isUnderline,
    isHighlight: hasHighlight || hasShading,
    colorHex,
  }
}

function extractWordDrawingHints(pXml: string): string[] {
  if (!/<w:drawing\b|<w:pict\b|<v:imagedata\b/i.test(pXml)) {
    return []
  }
  const hints: string[] = []
  const docPrRegex = /<wp:docPr\b([^>]*?)\/?>/gi
  let dm: RegExpExecArray | null
  while ((dm = docPrRegex.exec(pXml)) !== null) {
    const attrs = dm[1]
    const descr = attrs.match(/\bdescr=["']([^"']*)["']/i)?.[1]
    const title = attrs.match(/\btitle=["']([^"']*)["']/i)?.[1]
    const name = attrs.match(/\bname=["']([^"']*)["']/i)?.[1]
    const best = decodeXmlEntities((descr || title || name || '').trim())
    if (best && !/^Picture\s+\d+$/i.test(best) && !/^Image\s+\d+$/i.test(best)) {
      hints.push(`[Hình minh họa: ${best.slice(0, 120)}]`)
    } else {
      hints.push('[Hình minh họa]')
    }
  }
  if (hints.length === 0) {
    const vmlTitle = pXml.match(/\b(?:o:title|alt)=["']([^"']+)["']/i)?.[1]
    if (vmlTitle) {
      hints.push(`[Hình minh họa: ${decodeXmlEntities(vmlTitle).trim().slice(0, 120)}]`)
    } else {
      hints.push('[Hình minh họa]')
    }
  }
  return Array.from(new Set(hints))
}

function extractTaggedTextFromWordParagraphXml(pXml: string): {
  plain: string
  tagged: string
} {
  const runRegex = /<w:r\b[\s\S]*?<\/w:r>/gi
  const runs = pXml.match(runRegex) ?? []
  const drawingHints = extractWordDrawingHints(pXml)

  let taggedOut = ''
  let plainOut = ''

  for (const rXml of runs) {
    const rPrMatch = rXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/i)
    const signals = extractXmlRunStyleSignals(rPrMatch?.[0] ?? '')

    let runText = ''
    const tokenRegex =
      /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:delText\b[^>]*>[\s\S]*?<\/w:delText>|<w:tab\s*\/?>|<w:br\b[^>]*\/?>|<w:cr\s*\/?>/gi
    let tm: RegExpExecArray | null
    while ((tm = tokenRegex.exec(rXml)) !== null) {
      const full = tm[0].toLowerCase()
      if (full.startsWith('<w:deltext')) {
        continue
      } else if (full.startsWith('<w:tab')) {
        runText += ' '
      } else if (full.startsWith('<w:br') || full.startsWith('<w:cr')) {
        if (!/w:type=["']page["']/i.test(tm[0])) {
          runText += '\n'
        }
      } else if (typeof tm[1] === 'string') {
        runText += decodeXmlEntities(tm[1])
      }
    }

    if (!runText) continue
    plainOut += runText

    const hasMeaningfulChars = runText.trim().length > 0
    if (!hasMeaningfulChars) {
      taggedOut += runText
      continue
    }

    let wrapped = runText
    if (signals.isUnderline) wrapped = `[[U]]${wrapped}[[/U]]`
    if (signals.isBold) wrapped = `[[B]]${wrapped}[[/B]]`
    if (signals.isHighlight) wrapped = `[[HL]]${wrapped}[[/HL]]`
    if (signals.colorHex) wrapped = `[[CLR:${signals.colorHex}]]${wrapped}[[/CLR]]`
    taggedOut += wrapped
  }

  let plainFinal = plainOut.replace(/[ \t]+/g, ' ').trim()
  let taggedFinal = taggedOut.replace(/[ \t]+/g, ' ').trim()

  if (drawingHints.length > 0) {
    const suffix = drawingHints.join(' ')
    plainFinal = plainFinal ? `${plainFinal} ${suffix}` : suffix
    taggedFinal = taggedFinal ? `${taggedFinal} ${suffix}` : suffix
  }

  return {
    plain: plainFinal,
    tagged: taggedFinal,
  }
}

function findBalancedXmlElementEnd(xml: string, startIdx: number, tagName: string): number {
  const openToken = `<${tagName}`
  const closeToken = `</${tagName}>`
  // Handle self-closing tag right at startIdx
  const gtIdx = xml.indexOf('>', startIdx)
  if (gtIdx === -1) return xml.length
  if (xml[gtIdx - 1] === '/') {
    return gtIdx + 1
  }

  let depth = 1
  let pos = gtIdx + 1
  const len = xml.length

  while (pos < len && depth > 0) {
    const nextOpen = xml.indexOf(openToken, pos)
    const nextClose = xml.indexOf(closeToken, pos)

    if (nextClose === -1) {
      return len
    }

    if (nextOpen !== -1 && nextOpen < nextClose) {
      const afterChar = xml[nextOpen + openToken.length]
      if (afterChar === ' ' || afterChar === '>' || afterChar === '/' || afterChar === '\t' || afterChar === '\n' || afterChar === '\r') {
        const innerGt = xml.indexOf('>', nextOpen)
        if (innerGt !== -1 && xml[innerGt - 1] !== '/') {
          depth += 1
        }
        pos = innerGt !== -1 ? innerGt + 1 : nextOpen + openToken.length
      } else {
        pos = nextOpen + openToken.length
      }
    } else {
      depth -= 1
      pos = nextClose + closeToken.length
    }
  }

  return pos
}

function extractTopLevelBlocksFromXml(containerXml: string): Array<{ kind: 'p' | 'tbl'; xml: string }> {
  const items: Array<{ kind: 'p' | 'tbl'; xml: string }> = []
  let pos = 0
  const len = containerXml.length

  while (pos < len) {
    const nextP = containerXml.indexOf('<w:p', pos)
    const nextTbl = containerXml.indexOf('<w:tbl', pos)

    let chosenKind: 'p' | 'tbl' | null = null
    let chosenIdx = -1

    const isValidStart = (idx: number, tag: string) => {
      if (idx === -1) return false
      const ch = containerXml[idx + tag.length]
      return ch === ' ' || ch === '>' || ch === '/' || ch === '\t' || ch === '\n' || ch === '\r'
    }

    const validP = isValidStart(nextP, '<w:p')
    const validTbl = isValidStart(nextTbl, '<w:tbl')

    if (validP && validTbl) {
      if (nextP < nextTbl) {
        chosenKind = 'p'
        chosenIdx = nextP
      } else {
        chosenKind = 'tbl'
        chosenIdx = nextTbl
      }
    } else if (validP) {
      chosenKind = 'p'
      chosenIdx = nextP
    } else if (validTbl) {
      chosenKind = 'tbl'
      chosenIdx = nextTbl
    } else {
      // Advance past partial false prefix like <w:pPr or <w:tblPr
      const minRaw =
        nextP !== -1 && nextTbl !== -1
          ? Math.min(nextP, nextTbl)
          : nextP !== -1
          ? nextP
          : nextTbl
      if (minRaw === -1) break
      pos = minRaw + 4
      continue
    }

    const endIdx = findBalancedXmlElementEnd(
      containerXml,
      chosenIdx,
      chosenKind === 'p' ? 'w:p' : 'w:tbl'
    )
    items.push({
      kind: chosenKind,
      xml: containerXml.slice(chosenIdx, endIdx),
    })
    pos = endIdx
  }

  return items
}

function parseWordTableXml(
  tblXml: string,
  pageNumber: number | null,
  numberingTracker: DocxNumberingTracker
): ExtractedTableCell[][] {
  const rows: ExtractedTableCell[][] = []
  let pos = 0

  while (pos < tblXml.length) {
    const trIdx = tblXml.indexOf('<w:tr', pos)
    if (trIdx === -1) break
    const afterTr = tblXml[trIdx + 5]
    if (afterTr !== ' ' && afterTr !== '>' && afterTr !== '/') {
      pos = trIdx + 5
      continue
    }
    const trEnd = findBalancedXmlElementEnd(tblXml, trIdx, 'w:tr')
    const trXml = tblXml.slice(trIdx, trEnd)
    pos = trEnd

    const cells: ExtractedTableCell[] = []
    let tcPos = 0
    while (tcPos < trXml.length) {
      const tcIdx = trXml.indexOf('<w:tc', tcPos)
      if (tcIdx === -1) break
      const afterTc = trXml[tcIdx + 5]
      if (afterTc !== ' ' && afterTc !== '>' && afterTc !== '/') {
        tcPos = tcIdx + 5
        continue
      }
      const tcEnd = findBalancedXmlElementEnd(trXml, tcIdx, 'w:tc')
      const tcXml = trXml.slice(tcIdx, tcEnd)
      tcPos = tcEnd

      // Extract paragraphs directly inside this cell (without recursing infinitely, keeping order)
      const cellParagraphs = extractTopLevelBlocksFromXml(
        tcXml.replace(/^<w:tc\b[^>]*>|<\/w:tc>$/gi, '')
      )
      const cellLines: ExtractedLine[] = []
      const plainParts: string[] = []
      const taggedParts: string[] = []

      for (const blk of cellParagraphs) {
        if (blk.kind === 'p') {
          const { plain, tagged } = extractTaggedTextFromWordParagraphXml(blk.xml)
          if (!plain) continue
          const prefix = numberingTracker.resolveParagraphPrefix(blk.xml, plain)
          const fullTagged = prefix ? `${prefix}${tagged}` : tagged
          for (const sub of fullTagged.split(/\r?\n/)) {
            const cleanSub = stripInternalMarkers(sub)
            if (cleanSub) {
              cellLines.push({
                text: cleanSub,
                rawHtmlTaggedText: sub.trim(),
                pageNumber,
              })
              plainParts.push(cleanSub)
              taggedParts.push(sub.trim())
            }
          }
        } else if (blk.kind === 'tbl') {
          const nestedRows = parseWordTableXml(blk.xml, pageNumber, numberingTracker)
          for (const nr of nestedRows) {
            for (const nc of nr) {
              if (nc.plain) {
                cellLines.push(...nc.lines)
                plainParts.push(nc.plain)
                taggedParts.push(nc.tagged)
              }
            }
          }
        }
      }

      cells.push({
        plain: plainParts.join(' ').replace(/\s+/g, ' ').trim(),
        tagged: taggedParts.join(' ').replace(/\s+/g, ' ').trim(),
        lines: cellLines,
      })
    }

    if (cells.some((c) => c.plain.length > 0)) {
      rows.push(cells)
    }
  }

  return rows
}

async function extractDocxXmlDetails(buffer: Buffer): Promise<{
  pageCount: number | null
  lines: ExtractedLine[]
  tableRows: string[][]
  blocks: DocumentBlock[]
  hasExplicitPageMarkers: boolean
}> {
  const isZipHeader =
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
  if (!isZipHeader) {
    throw new DocumentParserError(
      'parse_docx',
      'INVALID_DOCX_ZIP',
      'Không nhận diện được DOCX: Tệp không đúng cấu trúc nén ZIP chuẩn của Microsoft Word (.docx).'
    )
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch (err) {
    throw new DocumentParserError(
      'parse_docx',
      'CORRUPT_DOCX_ARCHIVE',
      `Không nhận diện được DOCX: Tệp bị hỏng hoặc không thể giải nén (${
        err instanceof Error ? err.message : 'ZIP error'
      }).`
    )
  }

  if (zip.file('EncryptedPackage') || zip.file('EncryptionInfo')) {
    throw new DocumentParserError(
      'parse_docx',
      'DOCX_PASSWORD_PROTECTED',
      'Không nhận diện được DOCX: Tài liệu đang được đặt mật khẩu hoặc mã hóa bảo vệ.'
    )
  }

  const docXmlFile = zip.file('word/document.xml')
  if (!docXmlFile) {
    throw new DocumentParserError(
      'parse_docx',
      'MISSING_DOCUMENT_XML',
      'Không nhận diện được DOCX: Thiếu phần nội dung chính word/document.xml bên trong tệp.'
    )
  }

  const rawXml = await docXmlFile.async('string')
  // Remove alternate-content fallback duplicates & tracked deletions, unwrap sdt/ins wrappers cleanly
  const cleanedXml = rawXml
    .replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/gi, '')
    .replace(/<\/?mc:AlternateContent\b[^>]*>/gi, '')
    .replace(/<\/?mc:Choice\b[^>]*>/gi, '')
    .replace(/<w:del\b[\s\S]*?<\/w:del>/gi, '')
    .replace(/<\/?w:ins\b[^>]*>/gi, '')
    .replace(/<w:sdtPr\b[\s\S]*?<\/w:sdtPr>/gi, '')
    .replace(/<w:sdtEndPr\b[\s\S]*?<\/w:sdtEndPr>/gi, '')
    .replace(/<\/?w:sdt\b[^>]*>/gi, '')
    .replace(/<\/?w:sdtContent\b[^>]*>/gi, '')

  const hasExplicitPageMarkers =
    /<w:br\b[^>]*w:type=["']page["'][^>]*\/?>/i.test(cleanedXml) ||
    /<w:lastRenderedPageBreak\s*\/?>/i.test(cleanedXml) ||
    /<w:pageBreakBefore\b(?![^>]*w:val=["'](?:false|0)["'])/i.test(cleanedXml)

  const bodyMatch = cleanedXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i)
  const bodyXml = bodyMatch?.[1] ?? cleanedXml

  const numberingModel = await parseDocxNumberingAndStyles(zip)
  const numberingTracker = new DocxNumberingTracker(numberingModel)

  const topBlocks = extractTopLevelBlocksFromXml(bodyXml)
  const blocks: DocumentBlock[] = []
  const flatLines: ExtractedLine[] = []
  const tableRows: string[][] = []
  let currentPage = 1

  for (const blk of topBlocks) {
    if (blk.kind === 'p') {
      const pXml = blk.xml
      const hadPageBreakBefore = /<w:pageBreakBefore\b(?![^>]*w:val=["'](?:false|0)["'])/i.test(pXml)
      if (hadPageBreakBefore) {
        currentPage += 1
      }
      const pPage = hasExplicitPageMarkers ? currentPage : null

      const { plain, tagged } = extractTaggedTextFromWordParagraphXml(pXml)
      if (tagged && plain) {
        const prefix = numberingTracker.resolveParagraphPrefix(pXml, plain)
        const fullTagged = prefix ? `${prefix}${tagged}` : tagged
        for (const subLine of fullTagged.split(/\r?\n/)) {
          const clean = stripInternalMarkers(subLine)
          if (clean.length > 0) {
            const lineObj: ExtractedLine = {
              text: clean,
              rawHtmlTaggedText: subLine.trim(),
              pageNumber: pPage,
            }
            blocks.push({ kind: 'paragraph', line: lineObj })
            flatLines.push(lineObj)
          }
        }
      }

      const manualBreaks = (
        pXml.match(/<w:br\b[^>]*w:type=["']page["'][^>]*\/?>/gi) ?? []
      ).length
      const renderedBreaks = (pXml.match(/<w:lastRenderedPageBreak\s*\/?>/gi) ?? []).length
      const breakCount =
        manualBreaks + (hadPageBreakBefore ? Math.max(0, renderedBreaks - 1) : renderedBreaks)
      if (breakCount > 0) {
        currentPage += breakCount
      }
    } else {
      const pPage = hasExplicitPageMarkers ? currentPage : null
      const parsedRows = parseWordTableXml(blk.xml, pPage, numberingTracker)
      if (parsedRows.length > 0) {
        blocks.push({ kind: 'table', rows: parsedRows, pageNumber: pPage })
        for (const row of parsedRows) {
          tableRows.push(row.map((c) => c.plain))
        }
      }
      const breakCount = (
        blk.xml.match(
          /<w:br\b[^>]*w:type=["']page["'][^>]*\/?>|<w:lastRenderedPageBreak\s*\/?>/gi
        ) ?? []
      ).length
      if (breakCount > 0) {
        currentPage += breakCount
      }
    }
  }

  const pageCount = hasExplicitPageMarkers ? Math.max(1, currentPage) : null
  return {
    pageCount,
    lines: flatLines,
    tableRows,
    blocks,
    hasExplicitPageMarkers,
  }
}

async function extractFromDocx(buffer: Buffer): Promise<ParsedDocumentContent> {
  const warnings: string[] = []
  const xmlDetails = await extractDocxXmlDetails(buffer)

  if (!xmlDetails.hasExplicitPageMarkers) {
    warnings.push(
      'Tệp DOCX không chứa dấu ngắt trang cố định trong XML nên số trang từng câu để trống.'
    )
  }

  // Only fallback to mammoth raw text if XML yielded completely empty blocks
  if (xmlDetails.blocks.length === 0) {
    try {
      const rawResult = await mammoth.extractRawText({ buffer })
      const lines: ExtractedLine[] = []
      const blocks: DocumentBlock[] = []
      for (const line of rawResult.value.split(/\r?\n/)) {
        const clean = line.trim()
        if (clean.length > 0) {
          const lineObj: ExtractedLine = {
            text: clean,
            rawHtmlTaggedText: clean,
            pageNumber: null,
          }
          lines.push(lineObj)
          blocks.push({ kind: 'paragraph', line: lineObj })
        }
      }
      if (blocks.length === 0) {
        throw new DocumentParserError(
          'parse_docx',
          'EMPTY_DOCX_CONTENT',
          'Không nhận diện được DOCX: Tài liệu không chứa văn bản hoặc bảng hợp lệ.'
        )
      }
      return {
        lines,
        tableRows: xmlDetails.tableRows,
        blocks,
        pageCount: null,
        warnings,
      }
    } catch (fallbackErr) {
      if (fallbackErr instanceof DocumentParserError) throw fallbackErr
      throw new DocumentParserError(
        'parse_docx',
        'EMPTY_DOCX_CONTENT',
        'Không nhận diện được DOCX: Không thể đọc văn bản từ cấu trúc tệp Word.'
      )
    }
  }

  return {
    lines: xmlDetails.lines,
    tableRows: xmlDetails.tableRows,
    blocks: xmlDetails.blocks,
    pageCount: xmlDetails.pageCount,
    warnings,
  }
}

/* ============================================================================
 * PDF & TXT EXTRACTION
 * ========================================================================== */

interface PdfTextItemLike {
  str?: string
  transform?: number[]
  width?: number
  fontName?: string
}

async function extractFromPdf(buffer: Buffer): Promise<ParsedDocumentContent> {
  const warnings: string[] = []
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    useSystemFonts: true,
  })

  const pdfDoc = await loadingTask.promise
  const lines: ExtractedLine[] = []
  const blocks: DocumentBlock[] = []

  try {
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum)
      const content = await page.getTextContent()
      const styles = (content.styles ?? {}) as Record<
        string,
        { fontFamily?: string } | undefined
      >

      const rows: {
        y: number
        items: { x: number; width: number; text: string; isBold: boolean }[]
      }[] = []

      for (const rawItem of content.items as PdfTextItemLike[]) {
        const text = typeof rawItem.str === 'string' ? rawItem.str : ''
        if (!text.trim()) continue

        const transform = Array.isArray(rawItem.transform)
          ? rawItem.transform
          : [1, 0, 0, 1, 0, 0]
        const x = Number(transform[4] ?? 0)
        const y = Number(transform[5] ?? 0)
        const width = Number(rawItem.width ?? 0)

        const fontFamily =
          (rawItem.fontName && styles[rawItem.fontName]?.fontFamily) ||
          rawItem.fontName ||
          ''
        const isBold = /bold|black|heavy|demi/i.test(fontFamily)

        let targetRow = rows.find((r) => Math.abs(r.y - y) <= 3.5)
        if (!targetRow) {
          targetRow = { y, items: [] }
          rows.push(targetRow)
        }
        targetRow.items.push({ x, width, text, isBold })
      }

      rows.sort((a, b) => b.y - a.y)

      for (const row of rows) {
        row.items.sort((a, b) => a.x - b.x)
        let lineText = ''
        let taggedLine = ''
        let prevEnd = -1

        for (const item of row.items) {
          if (lineText.length > 0) {
            const gap = item.x - prevEnd
            const sep = gap > 2.2 ? (gap > 18 ? '   ' : ' ') : ''
            lineText += sep
            taggedLine += sep
          }
          lineText += item.text
          taggedLine += item.isBold && item.text.trim() ? `[[B]]${item.text}[[/B]]` : item.text
          prevEnd = item.x + item.width
        }

        const clean = lineText.replace(/\s+/g, ' ').trim()
        if (clean.length > 0) {
          const lineObj: ExtractedLine = {
            text: clean,
            rawHtmlTaggedText: taggedLine.replace(/\s+/g, ' ').trim(),
            pageNumber: pageNum,
          }
          lines.push(lineObj)
          blocks.push({ kind: 'paragraph', line: lineObj })
        }
      }
    }
  } finally {
    const maybeDoc = pdfDoc as unknown as {
      cleanup?: () => Promise<void> | void
      destroy?: () => Promise<void> | void
    }
    if (typeof maybeDoc.destroy === 'function') {
      await maybeDoc.destroy()
    } else if (typeof maybeDoc.cleanup === 'function') {
      await maybeDoc.cleanup()
    }
    if (typeof loadingTask.destroy === 'function') {
      await loadingTask.destroy()
    }
  }

  return {
    lines,
    tableRows: [],
    blocks,
    pageCount: pdfDoc.numPages,
    warnings,
  }
}

async function extractFromTxt(buffer: Buffer): Promise<ParsedDocumentContent> {
  const raw = buffer.toString('utf8').replace(/^\uFEFF/, '')
  const lines: ExtractedLine[] = []
  const blocks: DocumentBlock[] = []
  const tableRows: string[][] = []

  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    if (trimmed.includes('\t')) {
      const cells = trimmed.split('\t').map((c) => c.trim()).filter(Boolean)
      if (cells.length >= 2) tableRows.push(cells)
    } else if (trimmed.includes('|')) {
      const cells = trimmed
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
      if (cells.length >= 2) tableRows.push(cells)
    }
    const lineObj: ExtractedLine = {
      text: trimmed,
      rawHtmlTaggedText: trimmed,
      pageNumber: null,
    }
    lines.push(lineObj)
    blocks.push({ kind: 'paragraph', line: lineObj })
  }

  return {
    lines,
    tableRows,
    blocks,
    pageCount: null,
    warnings: [],
  }
}

function normalizeParsedContentNfc(parsed: ParsedDocumentContent): ParsedDocumentContent {
  const normLine = (line: ExtractedLine): ExtractedLine => ({
    text: line.text.normalize('NFC'),
    rawHtmlTaggedText: line.rawHtmlTaggedText.normalize('NFC'),
    pageNumber: line.pageNumber,
  })
  const lines = parsed.lines.map(normLine)
  const tableRows = parsed.tableRows.map((row) => row.map((c) => c.normalize('NFC')))
  const blocks: DocumentBlock[] = parsed.blocks.map((blk) => {
    if (blk.kind === 'paragraph') {
      return { kind: 'paragraph', line: normLine(blk.line) }
    }
    return {
      kind: 'table',
      pageNumber: blk.pageNumber,
      rows: blk.rows.map((row) =>
        row.map((cell) => ({
          plain: cell.plain.normalize('NFC'),
          tagged: cell.tagged.normalize('NFC'),
          lines: cell.lines.map(normLine),
        }))
      ),
    }
  })
  return {
    lines,
    tableRows,
    blocks,
    pageCount: parsed.pageCount,
    warnings: parsed.warnings.map((w) => w.normalize('NFC')),
  }
}

export async function extractStructuredDocumentContent(
  buffer: Buffer,
  fileFormat: SourceFileFormat
): Promise<ParsedDocumentContent> {
  if (!buffer || buffer.length === 0) {
    throw new DocumentParserError(
      'read_file',
      'EMPTY_FILE',
      'Không đọc được file: Dữ liệu tệp trống (0 byte).'
    )
  }
  const raw =
    fileFormat === 'docx'
      ? await extractFromDocx(buffer)
      : fileFormat === 'pdf'
      ? await extractFromPdf(buffer)
      : await extractFromTxt(buffer)
  return normalizeParsedContentNfc(raw)
}

export async function extractDocumentRichText(
  buffer: Buffer,
  fileFormat: SourceFileFormat
): Promise<RichDocumentExtractionResult> {
  const fileHash = sha256Hex(buffer)
  const parsed = await extractStructuredDocumentContent(buffer, fileFormat)

  const plainParts: string[] = []
  const richParts: string[] = []
  let lastPage: number | null = null

  for (const blk of parsed.blocks) {
    const pNum = blk.kind === 'paragraph' ? blk.line.pageNumber : blk.pageNumber
    if (pNum !== null && pNum !== lastPage) {
      plainParts.push(`\n--- [Trang ${pNum}] ---`)
      richParts.push(`\n--- [Trang ${pNum}] ---`)
      lastPage = pNum
    }

    if (blk.kind === 'paragraph') {
      plainParts.push(blk.line.text)
      richParts.push(formatInternalMarkersForAi(blk.line.rawHtmlTaggedText || blk.line.text))
    } else {
      plainParts.push('[BẢNG]')
      richParts.push('[BẢNG]')
      for (const row of blk.rows) {
        plainParts.push(row.map((c) => c.plain).join(' | '))
        richParts.push(row.map((c) => formatInternalMarkersForAi(c.tagged || c.plain)).join(' | '))
      }
      plainParts.push('[/BẢNG]')
      richParts.push('[/BẢNG]')
    }
  }

  if (parsed.blocks.length === 0 && parsed.tableRows.length > 0) {
    const tableBlock = [
      '\n[BẢNG DỮ LIỆU TRONG TÀI LIỆU]',
      ...parsed.tableRows.map((row) => row.join(' | ')),
      '[/BẢNG DỮ LIỆU]',
    ].join('\n')
    plainParts.push(tableBlock)
    richParts.push(tableBlock)
  }

  return {
    fileHash,
    pageCount: parsed.pageCount,
    plainText: plainParts.join('\n').trim(),
    richAnnotatedText: richParts.join('\n').trim(),
    tableRows: parsed.tableRows,
    warnings: parsed.warnings,
  }
}

/* ============================================================================
 * HIERARCHICAL STRUCTURAL PARSING: TÀI LIỆU -> CHỦ ĐỀ -> BÀI -> LOẠI -> CÂU -> ĐÁP ÁN
 * ========================================================================== */

export function detectCognitiveLevel(text: string): CognitiveLevel | null {
  const normalized = text.toLowerCase()

  if (
    /\[\s*vdc?\s*\]|\(\s*vdc?\s*\)|vận dụng(?:\s+cao)?|mức(?:\s+độ)?\s*[34]\b/i.test(
      normalized
    )
  ) {
    return 'application'
  }
  if (/\[\s*th\s*\]|\(\s*th\s*\)|thông hiểu|mức(?:\s+độ)?\s*2\b/i.test(normalized)) {
    return 'understanding'
  }
  if (/\[\s*nb\s*\]|\(\s*nb\s*\)|nhận biết|mức(?:\s+độ)?\s*1\b/i.test(normalized)) {
    return 'recognition'
  }
  return null
}

export function detectSectionQuestionType(line: string): QuestionType | null {
  const trimmed = line.trim()
  if (trimmed.length > 160) return null
  if (
    /(?:^|\b)(?:PHẦN|Phần|I\.|II\.|1\.|A\.)?\s*(?:TRẮC\s+NGHIỆM\s+(?:NHIỀU\s+LỰA\s+CHỌN|4\s+LỰA\s+CHỌN|KHÁCH\s+QUAN)|PHẦN\s+(?:I|1)\b(?:\s*[:.\-])?\s*(?:TRẮC\s+NGHIỆM|CÂU\s+HỎI\s+NHIỀU\s+LỰA\s+CHỌN)?)/i.test(
      trimmed
    ) &&
    !/đúng\s*[\/\-]\s*sai/i.test(trimmed)
  ) {
    return 'multiple_choice'
  }
  if (
    /(?:PHẦN|Phần)\s*(?:II|2)\b(?:\s*[:.\-])?\s*(?:CÂU\s+HỎI\s+)?(?:TRẮC\s+NGHIỆM\s+)?ĐÚNG\s*[\/\-]?\s*SAI|(?:^|\b)(?:CÂU\s+HỎI\s+)?(?:TRẮC\s+NGHIỆM\s+)?ĐÚNG\s*[\/\-]\s*SAI\b/i.test(
      trimmed
    )
  ) {
    return 'true_false'
  }
  if (
    /^(?:PHẦN|Phần)\s*(?:III|3)\b|(?:^|\b)(?:CÂU\s+HỎI\s+)?TỰ\s+LUẬN\b/i.test(trimmed)
  ) {
    return 'essay'
  }
  return null
}

export function extractQuestionCode(text: string): string {
  const trimmed = text.trim()
  const explicit = trimmed.match(/(?:\bMã(?:\s+câu(?:\s+hỏi)?)?\s*[:\-]\s*|\[\s*Mã\s*[:\-]\s*)([A-Z0-9][A-Z0-9._\-]{1,28})/i)
  if (explicit) {
    return explicit[1].toUpperCase()
  }
  const bracketed = trimmed.match(/\[\s*([A-Z][A-Z0-9]{1,}(?:[\-_][A-Z0-9]+)+)\s*\]/)
  if (bracketed) {
    return bracketed[1].toUpperCase()
  }
  return ''
}

export function normalizeForStemMatch(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\[(?:nb|th|vd|vdc|đs|tl)\]/gi, ' ')
    .replace(/^(?:câu|question)\s*\d+[a-z]?\s*[:.)\-]?\s*/i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function computeStemSimilarity(a: string, b: string): number {
  const na = normalizeForStemMatch(a)
  const nb = normalizeForStemMatch(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.length >= 16 && nb.length >= 16 && (na.includes(nb) || nb.includes(na))) {
    const shorter = Math.min(na.length, nb.length)
    const longer = Math.max(na.length, nb.length)
    return 0.78 + 0.22 * (shorter / longer)
  }
  const tokA = new Set(na.split(' ').filter((w) => w.length >= 2))
  const tokB = new Set(nb.split(' ').filter((w) => w.length >= 2))
  if (tokA.size === 0 || tokB.size === 0) return 0
  let inter = 0
  for (const w of tokA) {
    if (tokB.has(w)) inter += 1
  }
  const union = tokA.size + tokB.size - inter
  const jaccard = union > 0 ? inter / union : 0
  const containment = inter / Math.min(tokA.size, tokB.size)
  return Math.max(jaccard, containment * 0.85)
}

export function extractTopicKey(line: string): string | null {
  const trimmed = line.trim()
  if (trimmed.length < 4 || trimmed.length > 180) return null
  if (/^(?:Câu|Question)\s+\d+/i.test(trimmed)) return null
  const m = trimmed.match(/^(?:Chủ\s+đề|Chuyên\s+đề|Chương)\s+([A-Z0-9IVX]+)\b/i)
  if (m) {
    return `topic:${m[1].toUpperCase()}`
  }
  return null
}

export function extractLessonKey(line: string): string | null {
  const trimmed = line.trim()
  if (trimmed.length < 4 || trimmed.length > 220) return null
  if (/^(?:Câu|Cau|Question)\s+\d+/i.test(trimmed)) return null

  const unwrapped = trimmed.replace(/^[\[\(]\s*|\s*[\]\)]$/g, '').trim()

  const upperOptionHeaderMatch = unwrapped.match(
    /^[ABCD]\.\s+(?:ĐÁP\s+ÁN[^:.\n]{0,40}\s+)?(BÀI|TIẾT)\s+(?:SỐ\s+)?([A-Z]?\d+[A-Z]?)(?:\s*[:.\-\u2013\u2014\]\)]|$|\s)/
  )
  if (upperOptionHeaderMatch) {
    const rawId = upperOptionHeaderMatch[2].toUpperCase()
    const normalizedId = /^\d+$/.test(rawId) ? String(parseInt(rawId, 10)) : rawId
    return `lesson:${normalizedId}`
  }

  const numbered = unwrapped.match(
    /^(?:(?:(?:Đáp\s+án|Dap\s+an|Hướng\s+dẫn(?:\s+(?:giải|chấm))?|Lời\s+giải|Bảng\s+đáp\s+án)(?:\s+(?:câu\s+hỏi(?:\s+ôn\s+tập)?|trắc\s+nghiệm|đúng\s*[\/\-]?\s*sai|tự\s+luận|chi\s+tiết|tham\s+khảo|ôn\s+tập))?\s*[:\-]?\s*|Chủ\s+đề\s+[A-Z0-9IVX]+\s*[\-–:.]?\s*|[IVX]+\.\s*|Phần\s+[A-Z0-9IVX]+\s*[\-–:.]?\s*|\d+[.)]\s+)?)(?:Bài(?:\s+học)?|Bai(?:\s+hoc)?|Tiết)\s+(?:số\s+)?([A-Z]?\d+[A-Z]?)(?:\s*[:.\-\u2013\u2014\]\)]|$|\s)/i
  )
  if (numbered) {
    const rawId = numbered[1].toUpperCase()
    const normalizedId = /^\d+$/.test(rawId) ? String(parseInt(rawId, 10)) : rawId
    return `lesson:${normalizedId}`
  }

  const sectionSym = unwrapped.match(/^§\s*(\d+[a-z]?)\b/i)
  if (sectionSym) {
    return `lesson:${String(parseInt(sectionSym[1], 10))}`
  }

  return null
}

function isTopicHeader(line: string): boolean {
  if (isAnswerSectionHeader(line).isHeader) return false
  return extractTopicKey(line) !== null
}

function isLessonHeader(line: string): boolean {
  if (isAnswerSectionHeader(line).isHeader) return false
  return extractLessonKey(line) !== null
}

export function isAnswerSectionHeader(line: string): {
  isHeader: boolean
  isGlobalSection: boolean
} {
  const trimmed = line.trim()
  if (trimmed.length > 120) return { isHeader: false, isGlobalSection: false }
  if (/^(?:Câu|Question)\s+\d+/i.test(trimmed)) {
    return { isHeader: false, isGlobalSection: false }
  }
  // Never treat normal MCQ options like "B. Đáp án đúng là..." or "D. Đáp án khác" as answer section headers
  if (
    /^[ABCD]\s*[.)]\s+/i.test(trimmed) &&
    !/^[CD]\.\s*(?:BẢNG\s+)?(?:ĐÁP\s+ÁN|HƯỚNG\s+DẪN\s+(?:CHẤM|GIẢI)|LỜI\s+GIẢI)(?:\s+VÀ\s+(?:HƯỚNG\s+DẪN|GIẢI\s+THÍCH|LỜI\s+GIẢI|BIỂU\s+ĐIỂM))?\s*:?\s*$/i.test(
      trimmed
    )
  ) {
    return { isHeader: false, isGlobalSection: false }
  }

  const isGlobal =
    /^(?:(?:PHẦN|Phần)\s*[BCD]|(?:III|IV)\.\s*)\s*[:.\-\u2013\u2014]?\s*(?:BẢNG\s+)?(?:ĐÁP\s+ÁN|HƯỚNG\s+DẪN\s+(?:CHẤM|GIẢI)|LỜI\s+GIẢI)/i.test(
      trimmed
    ) ||
    /^[CD]\.\s*(?:BẢNG\s+)?(?:ĐÁP\s+ÁN|HƯỚNG\s+DẪN\s+(?:CHẤM|GIẢI)|LỜI\s+GIẢI)(?:\s+VÀ\s+(?:HƯỚNG\s+DẪN|GIẢI\s+THÍCH|LỜI\s+GIẢI|BIỂU\s+ĐIỂM))?\s*:?\s*$/i.test(
      trimmed
    ) ||
    /^(?:BẢNG\s+ĐÁP\s+ÁN\s+TỔNG\s+HỢP|ĐÁP\s+ÁN\s+VÀ\s+(?:HƯỚNG\s+DẪN\s+)?GIẢI\s+THÍCH)/i.test(
      trimmed
    )

  if (isGlobal) {
    return { isHeader: true, isGlobalSection: true }
  }

  const isLocalOrGeneric =
    /^(?:[IVX]+\.\s*|(?:PHẦN|Phần)\s+[A-ZIVX0-9]+[:.\s]+)?(?:BẢNG\s+ĐÁP\s+ÁN|ĐÁP\s+ÁN(?:\s+(?:THAM\s+KHẢO|CHI\s+TIẾT|CHÍNH\s+THỨC|TRẮC\s+NGHIỆM|ĐÚNG\s*[\/\-]?\s*SAI|TỰ\s+LUẬN|(?:BÀI|TIẾT|CHỦ\s+ĐỀ)\s+[A-Z0-9IVX]+|VÀ\s+(?:HƯỚNG\s+DẪN|GIẢI\s+THÍCH|LỜI\s+GIẢI|BIỂU\s+ĐIỂM)))?|HƯỚNG\s+DẪN\s+(?:CHẤM|GIẢI)(?:\s+VÀ\s+ĐÁP\s+ÁN)?)\b[^?\n]{0,60}:?\s*$/i.test(
      trimmed
    )

  if (isLocalOrGeneric) {
    return { isHeader: true, isGlobalSection: false }
  }

  return { isHeader: false, isGlobalSection: false }
}

function isLessonOrSectionHeader(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length < 4 || trimmed.length > 200) return false
  if (isAnswerSectionHeader(trimmed).isHeader) return true
  if (/^(?:Câu|Question)\s+\d+/i.test(trimmed)) return false
  if (detectSectionQuestionType(trimmed) !== null) return true
  if (extractTopicKey(trimmed) !== null || extractLessonKey(trimmed) !== null) return true

  return /^(?:Mức(?:\s+độ)?|[IVX]+\.|PHẦN\s+[A-Z0-9IVX]+)\s+[^\n]{2,}/i.test(trimmed)
}

export interface AnswerKeyMapEntry {
  keys: Set<AnswerOptionKey>
  ambiguous: boolean
  reason?: string
  explanation?: string
}

export interface TrueFalseSectionEntry {
  statements: Record<StatementLetter, Set<boolean>>
  ambiguous: Record<StatementLetter, boolean>
  explanationParts: string[]
}

export interface EssaySectionRubricEntry {
  rubricParts: string[]
  sampleParts: string[]
}

interface ScopedKeyContext {
  lessonKey: string
  topicKey: string
  questionTypeHint: QuestionType | 'any'
}

class ScopedAnswerRegistry {
  mcqByLesson = new Map<string, AnswerKeyMapEntry>()
  tfByLesson = new Map<string, TrueFalseSectionEntry>()
  essayByLesson = new Map<string, EssaySectionRubricEntry>()
  explanationsByLesson = new Map<string, string[]>()

  mcqGlobal = new Map<string, AnswerKeyMapEntry>()
  tfGlobal = new Map<string, TrueFalseSectionEntry>()
  essayGlobal = new Map<string, EssaySectionRubricEntry>()
  explanationsGlobal = new Map<string, string[]>()

  private makeKey(lessonKey: string, qNum: string): string {
    return `${lessonKey}|${qNum}`
  }

  private makeExpKey(lessonKey: string, qType: QuestionType | 'any', qNum: string): string {
    return `${lessonKey}|${qType}|${qNum}`
  }

  recordMcq(ctx: ScopedKeyContext, qNum: string, token: string, explanation?: string) {
    const lessonScoped = ctx.lessonKey !== '__root__'
    const targetMap = lessonScoped ? this.mcqByLesson : this.mcqGlobal
    const mapKey = lessonScoped ? this.makeKey(ctx.lessonKey, qNum) : qNum
    recordAnswerCandidate(targetMap, mapKey, token, explanation)
    if (explanation?.trim()) {
      this.recordExplanation(ctx, 'multiple_choice', qNum, explanation.trim())
    }
  }

  recordTf(
    ctx: ScopedKeyContext,
    qNum: string,
    letter: StatementLetter,
    val: boolean | null,
    explanation?: string
  ) {
    const lessonScoped = ctx.lessonKey !== '__root__'
    const targetMap = lessonScoped ? this.tfByLesson : this.tfGlobal
    const mapKey = lessonScoped ? this.makeKey(ctx.lessonKey, qNum) : qNum
    recordTrueFalseCandidate(targetMap, mapKey, letter, val, explanation)
    if (explanation?.trim()) {
      this.recordExplanation(ctx, 'true_false', qNum, explanation.trim())
    }
  }

  recordEssay(ctx: ScopedKeyContext, qNum: string, textPart: string) {
    const trimmed = textPart.trim()
    if (!trimmed) return
    const lessonScoped = ctx.lessonKey !== '__root__'
    const targetMap = lessonScoped ? this.essayByLesson : this.essayGlobal
    const mapKey = lessonScoped ? this.makeKey(ctx.lessonKey, qNum) : qNum
    const entry = targetMap.get(mapKey) ?? { rubricParts: [], sampleParts: [] }
    entry.rubricParts.push(trimmed)
    targetMap.set(mapKey, entry)
  }

  recordExplanation(
    ctx: ScopedKeyContext,
    qType: QuestionType | 'any',
    qNum: string,
    explanation: string
  ) {
    const clean = explanation.trim()
    if (!clean) return
    const lessonScoped = ctx.lessonKey !== '__root__'
    const targetMap = lessonScoped ? this.explanationsByLesson : this.explanationsGlobal
    const key = lessonScoped
      ? this.makeExpKey(ctx.lessonKey, qType, qNum)
      : `${qType}|${qNum}`
    const arr = targetMap.get(key) ?? []
    if (!arr.includes(clean)) arr.push(clean)
    targetMap.set(key, arr)
  }

  lookupMcq(
    lessonKey: string,
    qNum: string,
    isGlobalNumberRepeated: boolean
  ): {
    entry: AnswerKeyMapEntry | null
    ambiguousConflictReason: string | null
    scopeLabel: string
    explanation: string
  } {
    if (lessonKey !== '__root__') {
      const scopedKey = this.makeKey(lessonKey, qNum)
      const scoped = this.mcqByLesson.get(scopedKey)
      if (scoped) {
        const exp =
          this.explanationsByLesson.get(this.makeExpKey(lessonKey, 'multiple_choice', qNum)) ??
          this.explanationsByLesson.get(this.makeExpKey(lessonKey, 'any', qNum)) ??
          []
        return {
          entry: scoped,
          ambiguousConflictReason: null,
          scopeLabel: `${lessonKey.replace('lesson:', 'Bài ')}`,
          explanation: scoped.explanation || exp.join(' '),
        }
      }
    }

    const glob = this.mcqGlobal.get(qNum)
    if (glob) {
      if (isGlobalNumberRepeated) {
        return {
          entry: null,
          ambiguousConflictReason: `Số thứ tự Câu ${qNum} lặp lại ở nhiều bài trong tài liệu và bảng đáp án tổng hợp không ghi rõ thuộc Bài nào nên không tự ghép.`,
          scopeLabel: 'Bảng đáp án tổng hợp',
          explanation: '',
        }
      }
      const exp =
        this.explanationsGlobal.get(`multiple_choice|${qNum}`) ??
        this.explanationsGlobal.get(`any|${qNum}`) ??
        []
      return {
        entry: glob,
        ambiguousConflictReason: null,
        scopeLabel: 'Bảng đáp án cuối tài liệu',
        explanation: glob.explanation || exp.join(' '),
      }
    }

    return { entry: null, ambiguousConflictReason: null, scopeLabel: '', explanation: '' }
  }

  lookupTf(
    lessonKey: string,
    qNum: string,
    isGlobalNumberRepeated: boolean
  ): {
    entry: TrueFalseSectionEntry | null
    ambiguousConflictReason: string | null
    scopeLabel: string
    explanation: string
  } {
    if (lessonKey !== '__root__') {
      const scopedKey = this.makeKey(lessonKey, qNum)
      const scoped = this.tfByLesson.get(scopedKey)
      if (scoped) {
        const exp =
          this.explanationsByLesson.get(this.makeExpKey(lessonKey, 'true_false', qNum)) ??
          this.explanationsByLesson.get(this.makeExpKey(lessonKey, 'any', qNum)) ??
          []
        return {
          entry: scoped,
          ambiguousConflictReason: null,
          scopeLabel: `${lessonKey.replace('lesson:', 'Bài ')}`,
          explanation: [...scoped.explanationParts, ...exp].join(' ').trim(),
        }
      }
    }

    const glob = this.tfGlobal.get(qNum)
    if (glob) {
      if (isGlobalNumberRepeated) {
        return {
          entry: null,
          ambiguousConflictReason: `Câu Đúng/Sai số ${qNum} lặp lại ở nhiều bài và phần đáp án không ghi rõ thuộc Bài nào.`,
          scopeLabel: 'Bảng đáp án tổng hợp',
          explanation: '',
        }
      }
      const exp =
        this.explanationsGlobal.get(`true_false|${qNum}`) ??
        this.explanationsGlobal.get(`any|${qNum}`) ??
        []
      return {
        entry: glob,
        ambiguousConflictReason: null,
        scopeLabel: 'Phần đáp án cuối tài liệu',
        explanation: [...glob.explanationParts, ...exp].join(' ').trim(),
      }
    }

    return { entry: null, ambiguousConflictReason: null, scopeLabel: '', explanation: '' }
  }

  lookupEssay(
    lessonKey: string,
    qNum: string,
    isGlobalNumberRepeated: boolean
  ): EssaySectionRubricEntry | null {
    if (lessonKey !== '__root__') {
      const scoped = this.essayByLesson.get(this.makeKey(lessonKey, qNum))
      if (scoped) return scoped
    }
    if (!isGlobalNumberRepeated && this.essayGlobal.has(qNum)) {
      return this.essayGlobal.get(qNum)!
    }
    return null
  }
}

function recordAnswerCandidate(
  map: Map<string, AnswerKeyMapEntry>,
  qKey: string,
  token: string,
  explanation?: string
) {
  const cleaned = token.trim().toUpperCase()
  const entry = map.get(qKey) ?? {
    keys: new Set<AnswerOptionKey>(),
    ambiguous: false,
  }

  if (explanation?.trim() && !entry.explanation) {
    entry.explanation = explanation.trim()
  }

  const singleMatch = cleaned.match(/^([ABCD])$/)
  if (singleMatch) {
    const key = singleMatch[1] as AnswerOptionKey
    if (entry.keys.size > 0 && !entry.keys.has(key)) {
      entry.ambiguous = true
      entry.reason = 'Bảng đáp án có nhiều đáp án khác nhau cho cùng câu hỏi.'
    }
    entry.keys.add(key)
    map.set(qKey, entry)
    return
  }

  const multiMatches = cleaned.match(/[ABCD]/g)
  if (multiMatches && multiMatches.length >= 2) {
    for (const k of multiMatches) {
      entry.keys.add(k as AnswerOptionKey)
    }
    entry.ambiguous = true
    entry.reason = `Đáp án ghi không duy nhất ("${cleaned}").`
    map.set(qKey, entry)
  } else if (/[?-]|chưa|trống/i.test(cleaned)) {
    entry.ambiguous = true
    entry.reason = `Đáp án đánh dấu chưa rõ ràng ("${cleaned}").`
    map.set(qKey, entry)
  }
}

function parseBoolToken(raw: string): boolean | null {
  const v = raw.trim().toLowerCase()
  if (v === 'đ' || v === 'đúng' || v === 'd' || v === 'true' || v === 't' || v === 'x' || v === '✓') {
    return true
  }
  if (v === 's' || v === 'sai' || v === 'f' || v === 'false') {
    return false
  }
  return null
}

function parseStrictTrueFalseToken(raw: string): boolean | null {
  const v = raw.trim().toLowerCase()
  if (v === 'đ' || v === 'đúng' || v === 'true' || v === 't') return true
  if (v === 's' || v === 'sai' || v === 'false' || v === 'f') return false
  // Accept uppercase D only when explicitly D / S in Vietnamese tables (Đ/S without diacritics)
  if (raw.trim() === 'D') return true
  if (raw.trim() === 'S') return false
  return null
}

function getOrCreateTfEntry(
  map: Map<string, TrueFalseSectionEntry>,
  qKey: string
): TrueFalseSectionEntry {
  let existing = map.get(qKey)
  if (!existing) {
    existing = {
      statements: {
        a: new Set<boolean>(),
        b: new Set<boolean>(),
        c: new Set<boolean>(),
        d: new Set<boolean>(),
      },
      ambiguous: { a: false, b: false, c: false, d: false },
      explanationParts: [],
    }
    map.set(qKey, existing)
  }
  return existing
}

function recordTrueFalseCandidate(
  map: Map<string, TrueFalseSectionEntry>,
  qKey: string,
  letter: StatementLetter,
  val: boolean | null,
  explanation?: string
) {
  const entry = getOrCreateTfEntry(map, qKey)
  if (explanation?.trim() && !entry.explanationParts.includes(explanation.trim())) {
    entry.explanationParts.push(explanation.trim())
  }
  if (val === null) {
    entry.ambiguous[letter] = true
    return
  }
  if (entry.statements[letter].size > 0 && !entry.statements[letter].has(val)) {
    entry.ambiguous[letter] = true
  }
  entry.statements[letter].add(val)
}

function parseAnswerLineWithContext(
  text: string,
  ctx: ScopedKeyContext,
  registry: ScopedAnswerRegistry
): { matchedType: 'tf' | 'mcq' | null; activeQNum: string | null } {
  const trimmed = text.trim()

  // Pattern 1: True/False full sequence on one line: "Câu 1: a) Đúng, b) Sai, c) Đúng, d) Sai" or "1. a-Đ b-S c-Đ d-S"
  const tfPrefixMatch = trimmed.match(
    /^(?:Câu\s*)?(\d{1,3})\s*[:.)\-]\s*((?:[abcd]\s*[:.)\-]?\s*(?:Đúng|Sai|Đ|S|D|True|False)\b(?:\s*[,;.\-\/]+\s*|\s+(?=[abcd]\s*[:.)\-]?))?){2,4})(?:\s*[.,;\-\u2013\u2014]*\s*(.+))?$/i
  )
  if (tfPrefixMatch) {
    const qNum = String(parseInt(tfPrefixMatch[1], 10))
    let exp = (tfPrefixMatch[3] ?? '').trim()
    if (exp.startsWith('(') && /\)\s*\.?$/.test(exp)) {
      exp = exp.replace(/^\(/, '').replace(/\)\s*\.?$/, '').trim()
    }
    exp = exp.replace(/^(?:Giải\s+thích|Hướng\s+dẫn|Lời\s+giải)\s*[:\-]?\s*/i, '').trim()
    const subRegex = /([abcd])\s*[:.)\-]?\s*(Đúng|Sai|Đ|S|D|True|False)/gi
    let sm: RegExpExecArray | null
    while ((sm = subRegex.exec(tfPrefixMatch[2])) !== null) {
      const letter = sm[1].toLowerCase() as StatementLetter
      const boolVal =
        sm[2].length === 1 && sm[2].toUpperCase() === 'D'
          ? true
          : parseBoolToken(sm[2])
      registry.recordTf(ctx, qNum, letter, boolVal, exp || undefined)
    }
    return { matchedType: 'tf', activeQNum: qNum }
  }

  // Pattern 2: Positional 4 Đ/S sequence: "Câu 1: Đúng - Sai - Đúng - Sai"
  const tfSeqMatch = trimmed.match(
    /^(?:Câu\s*)?(\d{1,3})\s*[:.)\-]\s*(Đúng|Sai|Đ|S)\s*[-,\/\s]+\s*(Đúng|Sai|Đ|S)\s*[-,\/\s]+\s*(Đúng|Sai|Đ|S)\s*[-,\/\s]+\s*(Đúng|Sai|Đ|S)(?:\s*[.:;\-\u2013\u2014]*\s*(.+))?$/i
  )
  if (tfSeqMatch) {
    const qNum = String(parseInt(tfSeqMatch[1], 10))
    let exp = (tfSeqMatch[6] ?? '').trim()
    if (exp.startsWith('(') && /\)\s*\.?$/.test(exp)) {
      exp = exp.replace(/^\(/, '').replace(/\)\s*\.?$/, '').trim()
    }
    exp = exp.replace(/^(?:Giải\s+thích|Hướng\s+dẫn|Lời\s+giải)\s*[:\-]?\s*/i, '').trim()
    STATEMENT_LETTERS.forEach((letter, idx) => {
      registry.recordTf(
        ctx,
        qNum,
        letter,
        parseStrictTrueFalseToken(tfSeqMatch[idx + 2]),
        exp || undefined
      )
    })
    return { matchedType: 'tf', activeQNum: qNum }
  }

  // Pattern 3: Single MCQ line with optional explanation or code:
  // "Câu 1: A (Giải thích: ...)" or "Câu 1. Chọn đáp án B. Vì ..." or "Câu 1 [Mã: X]: Đáp án đúng là C"
  const singleMcqWithExp = trimmed.match(
    /^(?:Câu\s*)?(\d{1,3})(?:\s*(?:\[[^\]]+\]|\([^)]+\)))?\s*[:.)\-]\s*(?:(?:Đáp\s+án(?:\s+đúng(?:\s+là)?)?|Chọn(?:\s+đáp\s+án)?|Key)\s*[:\-]?\s*)?([ABCD])\.?(?:\s*(?:[.)\-:\u2013\u2014]|\()\s*(.+))?$/i
  )
  if (singleMcqWithExp && !/\b[abcd]\s*[:.)\-]\s*(?:Đúng|Sai)/i.test(trimmed)) {
    const qNum = String(parseInt(singleMcqWithExp[1], 10))
    let trailing = (singleMcqWithExp[3] ?? '').trim()
    if (trailing.endsWith(')') && !trailing.includes('(')) {
      trailing = trailing.slice(0, -1).trim()
    }
    if (!/^(?:\d{1,3}\s*[:.)\-]\s*[ABCD])/i.test(trailing)) {
      const cleanedExp = trailing.replace(/^(?:Giải\s+thích|Hướng\s+dẫn|Vì)\s*[:\-]?\s*/i, '')
      registry.recordMcq(ctx, qNum, singleMcqWithExp[2], cleanedExp || undefined)
      return { matchedType: 'mcq', activeQNum: qNum }
    }
  }

  // Pattern 4: Multiple compact pairs on one line: "1.A  2.B  3.C  4.D" or "1. A.  2. B." or "1-A; 2-B"
  const pairRegex =
    /(?:^|[\s,;|])(?:Câu\s*)?(\d{1,3})\s*[:.)\-]?\s*([ABCD](?:\s*(?:\/|,|hoặc)\s*[ABCD])*|\?)\.?(?=\s|$|[,;|])/gi
  let match: RegExpExecArray | null
  let foundMcqPairs = 0
  let lastNum: string | null = null
  const pendingPairs: Array<{ qNum: string; val: string }> = []

  while ((match = pairRegex.exec(trimmed)) !== null) {
    const fullTok = match[0]
    const hasSep = /[:.)\-]/.test(fullTok)
    pendingPairs.push({
      qNum: String(parseInt(match[1], 10)),
      val: match[2],
    })
    if (hasSep) foundMcqPairs += 1
    lastNum = String(parseInt(match[1], 10))
  }

  if (pendingPairs.length >= 2 || (pendingPairs.length === 1 && foundMcqPairs === 1)) {
    for (const p of pendingPairs) {
      registry.recordMcq(ctx, p.qNum, p.val)
    }
    return { matchedType: 'mcq', activeQNum: lastNum }
  }

  return { matchedType: null, activeQNum: null }
}

function isLikelyAnswerTable(rows: ExtractedTableCell[][]): boolean {
  if (rows.length === 0) return false
  let signalHits = 0
  let hasDungSaiCols = false
  let hasBoolCheckmarks = false
  let hasQuestionTableStatements = false

  for (const row of rows) {
    const rawLower = row.map((c) => c.plain.trim().toLowerCase())
    if (
      rawLower.some((c) => c === 'đúng' || c === 'đ') &&
      rawLower.some((c) => c === 'sai' || c === 's')
    ) {
      hasDungSaiCols = true
    }

    const cleaned = row.map((c) => c.plain.trim()).filter(Boolean)
    if (cleaned.length < 2) {
      if (
        cleaned.length === 1 &&
        /^(?:Câu\s*)?\d{1,3}\s*[:.)\-]\s*(?:[ABCD]\b|(?:[abcd]\s*[:.)\-]?\s*(?:Đúng|Sai|Đ|S)))/i.test(
          cleaned[0]
        )
      ) {
        signalHits += 2
      }
      continue
    }

    if (
      cleaned.some((c) => /^(?:Câu|Đáp\s+án|Mã\s+đề|TT|STT|Ý|Mệnh\s+đề)$/i.test(c)) &&
      cleaned.some((c) => /^(?:Đáp\s+án|ĐA|Chọn|Đúng|Sai|(?:Ý\s*)?[abcd])$/i.test(c))
    ) {
      signalHits += 3
    }

    for (let i = 0; i < cleaned.length - 1; i++) {
      const isQNumCell = /^(?:Câu\s*)?\d{1,3}\s*[:.)\-]?$/i.test(cleaned[i])
      const next = cleaned[i + 1]
      if (
        isQNumCell &&
        (/^(?:Đáp\s+án\s*[:\-]?\s*)?[ABCD](?:\s*(?:\/|,|hoặc)\s*[ABCD])*\.?$/i.test(next) ||
          parseStrictTrueFalseToken(next) !== null ||
          /(?:[abcd]\s*[:.)\-]?\s*(?:Đúng|Sai|Đ|S|D|True|False)\b){2,}/i.test(next) ||
          /^(?:Đúng|Sai|Đ|S)\s*[-,\/\s]+\s*(?:Đúng|Sai|Đ|S)\s*[-,\/\s]+\s*(?:Đúng|Sai|Đ|S)\s*[-,\/\s]+\s*(?:Đúng|Sai|Đ|S)$/i.test(
            next
          ))
      ) {
        signalHits += 2
      }
    }

    // Detect checkmark marks inside Dung/Sai tables vs full question statement tables
    if (hasDungSaiCols) {
      if (cleaned.some((c) => /^(?:x|✓|✔|☑|đ|s)$/i.test(c))) {
        hasBoolCheckmarks = true
      }
      if (cleaned.some((c) => /^[abcd]\s*[).:]\s+\S{15,}/i.test(c))) {
        hasQuestionTableStatements = true
      }
    }

    if (cleaned.some((c) => /^(?:Câu\s*)?\d{1,3}\s*[:.)\-]\s*[ABCD]\.?$/i.test(c))) {
      signalHits += 2
    }
  }

  if (hasDungSaiCols && hasBoolCheckmarks && !hasQuestionTableStatements) {
    return true
  }

  // Horizontal matrix: [Câu/1/2/3...] followed by [Đáp án/A/B/C...] OR [a/b/c/d] -> [Đ/S/Đ/S]
  if (rows.length >= 2) {
    for (let r = 0; r < rows.length - 1; r++) {
      const r1 = rows[r].map((c) => c.plain.trim())
      const r2 = rows[r + 1].map((c) => c.plain.trim())
      const numCols = r1.filter((c) => /^(?:Câu\s*)?\d{1,3}\s*[:.)\-]?$/i.test(c)).length
      const keyCols = r2.filter((c) => /^[ABCD]\.?$/i.test(c)).length
      if (numCols >= 2 && keyCols >= 2) {
        return true
      }
      const tfHdrCols = r1.filter((c) => /^(?:Ý\s*|Mệnh\s+đề\s*)?[abcd]$/i.test(c)).length
      const tfValCols = r2.filter((c) => parseStrictTrueFalseToken(c) !== null).length
      if (tfHdrCols === 4 && tfValCols >= 2) {
        return true
      }
    }
  }

  return signalHits >= 3
}

function parseTfPairsFromCellOrLines(cell: ExtractedTableCell): Array<{
  letter: StatementLetter
  val: boolean | null
  exp: string
}> {
  const results: Array<{ letter: StatementLetter; val: boolean | null; exp: string }> = []
  const seen = new Set<StatementLetter>()

  const scanText = (text: string) => {
    const regex =
      /(?:^|[\s;,|])(?:Ý\s*)?([abcd])\s*[:.)\-]?\s*(Đúng|Sai|Đ|S|D|True|False|\?)(?:\s*\(([^)]+)\)|\s*[:\-]\s*([^a-d\n]{4,}))?/gi
    let m: RegExpExecArray | null
    while ((m = regex.exec(text)) !== null) {
      const letter = m[1].toLowerCase() as StatementLetter
      const rawBool = m[2]
      const val =
        rawBool === '?'
          ? null
          : rawBool.length === 1 && rawBool.toUpperCase() === 'D'
          ? true
          : parseBoolToken(rawBool)
      const exp = (m[3] || m[4] || '').trim()
      if (!seen.has(letter)) {
        seen.add(letter)
        results.push({ letter, val, exp })
      }
    }
  }

  for (const l of cell.lines) {
    scanText(l.text)
  }
  if (results.length < 2) {
    scanText(cell.plain)
  }

  // Fallback positional 4-token sequence inside one cell: "Đúng - Sai - Đúng - Sai"
  if (results.length === 0) {
    const seq = cell.plain
      .trim()
      .match(
        /^(Đúng|Sai|Đ|S)\s*[-,\/\s]+\s*(Đúng|Sai|Đ|S)\s*[-,\/\s]+\s*(Đúng|Sai|Đ|S)\s*[-,\/\s]+\s*(Đúng|Sai|Đ|S)(?:\s*[-–:;.]\s*(.+))?$/i
      )
    if (seq) {
      STATEMENT_LETTERS.forEach((letter, idx) => {
        results.push({
          letter,
          val: parseStrictTrueFalseToken(seq[idx + 1]),
          exp: idx === 0 && seq[5] ? seq[5].trim() : '',
        })
      })
    }
  }

  return results
}

function parseAnswerTableIntoRegistry(
  rows: ExtractedTableCell[][],
  ctx: ScopedKeyContext,
  registry: ScopedAnswerRegistry
): SeparateAnswerSnippet[] {
  const emittedSnippets: SeparateAnswerSnippet[] = []
  let activeTfQNum: string | null = null
  let dungColIdx = -1
  let saiColIdx = -1
  let tfHorizCols: Partial<Record<StatementLetter, number>> | null = null
  let isExplicitAnswerTable = false

  for (let r = 0; r < rows.length; r++) {
    const rawRow = rows[r]
    const cleaned = rawRow.map((c) => c.plain.trim()).filter((c) => c.length > 0)
    if (cleaned.length === 0) continue

    const joinedRow = cleaned.join(' | ')
    const rowCode = extractQuestionCode(joinedRow)

    // Detect table-level header switches (Lesson / Topic / Section Question Type)
    if (cleaned.length <= 2 || cleaned.every((c) => c === cleaned[0])) {
      const joined = cleaned[0] === cleaned[1] ? cleaned[0] : cleaned.join(' ')
      const tKey = extractTopicKey(joined)
      if (tKey) {
        ctx.topicKey = tKey
      }
      const lKey = extractLessonKey(joined)
      if (lKey) {
        ctx.lessonKey = lKey
        activeTfQNum = null
        dungColIdx = -1
        saiColIdx = -1
        tfHorizCols = null
        const sType = detectSectionQuestionType(joined)
        if (sType) ctx.questionTypeHint = sType
        continue
      }
      const sType = detectSectionQuestionType(joined)
      if (sType && joined.length < 120) {
        ctx.questionTypeHint = sType
        activeTfQNum = null
        dungColIdx = -1
        saiColIdx = -1
        tfHorizCols = null
        continue
      }
    }

    // Check column headers row: [Câu | Đáp án | Giải thích] or [Câu | Mệnh đề | Đúng | Sai] or [Câu | a | b | c | d]
    const lowerCells = rawRow.map((c) => c.plain.trim().toLowerCase())
    const dIdx = lowerCells.findIndex((c) => c === 'đúng' || c === 'đ')
    const sIdx = lowerCells.findIndex((c) => c === 'sai' || c === 's')
    if (
      dIdx !== -1 &&
      sIdx !== -1 &&
      lowerCells.some((c) => /^(?:câu|ý|mệnh\s+đề|nội\s+dung|stt)$/i.test(c))
    ) {
      dungColIdx = dIdx
      saiColIdx = sIdx
      isExplicitAnswerTable = true
      continue
    }

    if (
      lowerCells.some((c) => /^(?:câu|đáp\s+án|đ\.?a|hướng\s+dẫn|mã)$/i.test(c)) &&
      lowerCells.some((c) =>
        /^(?:đáp\s+án(?:\s+đúng)?|đ\.?a|chọn|hướng\s+dẫn(?:\s+chấm)?|biểu\s+điểm|giải\s+thích)$/i.test(
          c
        )
      )
    ) {
      isExplicitAnswerTable = true
      const aCol = lowerCells.findIndex((c) => /^(?:ý\s*|mệnh\s+đề\s*)?a$/i.test(c))
      const bCol = lowerCells.findIndex((c) => /^(?:ý\s*|mệnh\s+đề\s*)?b$/i.test(c))
      const cCol = lowerCells.findIndex((c) => /^(?:ý\s*|mệnh\s+đề\s*)?c$/i.test(c))
      const dCol = lowerCells.findIndex((c) => /^(?:ý\s*|mệnh\s+đề\s*)?d$/i.test(c))
      if (aCol !== -1 && bCol !== -1 && cCol !== -1 && dCol !== -1) {
        tfHorizCols = { a: aCol, b: bCol, c: cCol, d: dCol }
      }
      continue
    }

    // Header row with only [Câu | a | b | c | d]
    {
      const aCol = lowerCells.findIndex((c) => /^(?:ý\s*|mệnh\s+đề\s*)?a$/i.test(c))
      const bCol = lowerCells.findIndex((c) => /^(?:ý\s*|mệnh\s+đề\s*)?b$/i.test(c))
      const cCol = lowerCells.findIndex((c) => /^(?:ý\s*|mệnh\s+đề\s*)?c$/i.test(c))
      const dCol = lowerCells.findIndex((c) => /^(?:ý\s*|mệnh\s+đề\s*)?d$/i.test(c))
      if (aCol !== -1 && bCol !== -1 && cCol !== -1 && dCol !== -1) {
        tfHorizCols = { a: aCol, b: bCol, c: cCol, d: dCol }
        isExplicitAnswerTable = true
        continue
      }
    }

    // Horizontal TF matrix row when tfHorizCols is active: [Câu 1 | Đ | S | Đ | S | Giải thích]
    if (tfHorizCols) {
      const qMatch = cleaned[0].match(/^(?:Câu\s*)?(\d{1,3})\s*[:.)\-]?$/i)
      if (qMatch) {
        const qNum = String(parseInt(qMatch[1], 10))
        const tfAnswers: Partial<Record<StatementLetter, boolean>> = {}
        const expCell =
          rawRow.length > Math.max(...Object.values(tfHorizCols).map((n) => n ?? 0)) + 1
            ? rawRow[rawRow.length - 1]?.plain.trim() || ''
            : ''
        for (const letter of STATEMENT_LETTERS) {
          const col = tfHorizCols[letter]
          if (col !== undefined && rawRow[col]) {
            const val = parseStrictTrueFalseToken(rawRow[col].plain.trim())
            registry.recordTf(ctx, qNum, letter, val, expCell || undefined)
            if (val !== null) tfAnswers[letter] = val
          }
        }
        if (Object.keys(tfAnswers).length > 0) {
          activeTfQNum = qNum
          emittedSnippets.push({
            questionCode: rowCode,
            lessonKey: ctx.lessonKey,
            questionNumber: qNum,
            questionTypeHint: 'true_false',
            answerKey: null,
            tfAnswers,
            rubric: '',
            explanation: expCell,
            stemSnippet: joinedRow.slice(0, 300),
            rawLine: joinedRow.slice(0, 400),
          })
          continue
        }
      }
    }

    // Checkmark table: [Câu 1 | a) ... | x | ] using rawRow dungColIdx/saiColIdx
    if (dungColIdx !== -1 && saiColIdx !== -1) {
      const qCell = rawRow[0]?.plain.trim() || ''
      const qMatch = qCell.match(/^(?:Câu\s*)?(\d{1,3})\s*[:.)\-]?$/i)
      if (qMatch) {
        activeTfQNum = String(parseInt(qMatch[1], 10))
      }
      const subCell = rawRow.find(
        (c, idx) =>
          !(qMatch && idx === 0) &&
          idx !== dungColIdx &&
          idx !== saiColIdx &&
          /^(?:(?:Ý\s*)?[abcd](?:\s*[).:\-\s]|\s*$))/i.test(c.plain.trim())
      )
      const letterMatch = subCell?.plain.trim().match(/^(?:Ý\s*)?([abcd])\b/i)
      const dMark = rawRow[dungColIdx] ? detectColumnBoolMark(rawRow[dungColIdx]) : false
      const sMark = rawRow[saiColIdx] ? detectColumnBoolMark(rawRow[saiColIdx]) : false
      if (activeTfQNum && letterMatch && (dMark || sMark)) {
        const letter = letterMatch[1].toLowerCase() as StatementLetter
        const val = dMark && !sMark ? true : sMark && !dMark ? false : null
        const expParts = rawRow
          .filter(
            (_, idx) =>
              idx !== dungColIdx &&
              idx !== saiColIdx &&
              idx !== 0 &&
              rawRow[idx].plain.trim().length > 8
          )
          .map((c) => c.plain.trim())
        const exp = expParts.join(' ')
        registry.recordTf(ctx, activeTfQNum, letter, val, exp || undefined)
        emittedSnippets.push({
          questionCode: rowCode,
          lessonKey: ctx.lessonKey,
          questionNumber: activeTfQNum,
          questionTypeHint: 'true_false',
          answerKey: null,
          tfAnswers: val !== null ? { [letter]: val } : null,
          rubric: '',
          explanation: exp,
          stemSnippet: joinedRow.slice(0, 300),
          rawLine: joinedRow.slice(0, 400),
        })
        continue
      }
    }

    // Horizontal MCQ matrix header row: [Câu | 1 | 2 | 3 ...] followed by [Đáp án | A | B | C ...]
    if (r + 1 < rows.length) {
      const headerRow = rows[r].map((c) => c.plain.trim())
      const nextRow = rows[r + 1].map((c) => c.plain.trim())
      const minCols = Math.min(headerRow.length, nextRow.length)
      if (minCols >= 2) {
        let numericCols = 0
        let ansCols = 0
        for (let c = 0; c < minCols; c++) {
          if (/^(?:Câu\s*)?(\d{1,3})\s*[:.)\-]?$/i.test(headerRow[c])) numericCols += 1
          if (/^[ABCD](?:\s*(?:\/|,|hoặc)\s*[ABCD])*\.?$/i.test(nextRow[c])) ansCols += 1
        }
        if (numericCols >= 2 && ansCols >= 2) {
          for (let c = 0; c < minCols; c++) {
            const qMatch = headerRow[c].match(/^(?:Câu\s*)?(\d{1,3})\s*[:.)\-]?$/i)
            const aMatch = nextRow[c]
              .replace(/\.$/, '')
              .match(/^([ABCD](?:\s*(?:\/|,|hoặc)\s*[ABCD])*|\?)$/i)
            if (qMatch && aMatch) {
              const qNum = String(parseInt(qMatch[1], 10))
              registry.recordMcq(ctx, qNum, aMatch[1])
              const singleK = /^[ABCD]$/i.test(aMatch[1])
                ? (aMatch[1].toUpperCase() as AnswerOptionKey)
                : null
              emittedSnippets.push({
                questionCode: rowCode,
                lessonKey: ctx.lessonKey,
                questionNumber: qNum,
                questionTypeHint: 'multiple_choice',
                answerKey: singleK,
                tfAnswers: null,
                rubric: '',
                explanation: '',
                stemSnippet: `Câu ${qNum}: ${aMatch[1]}`,
                rawLine: `Câu ${qNum}: ${aMatch[1]}`,
              })
            }
          }
          r += 1
          continue
        }
      }
    }

    // Row format for 4-column True/False answer: [Câu 1 | Đúng | Sai | Đúng | Sai] or [Câu 1 | a) Đúng | b) Sai | ...]
    const qFirst = cleaned[0].match(/^(?:Câu\s*)?(\d{1,3})\s*[:.)\-]?$/i)
    const parseTfCell = (cellText: string): boolean | null => {
      const stripped = cellText
        .trim()
        .replace(/^(?:Ý\s*)?[abcd]\s*[:.)\-]?\s*/i, '')
        .trim()
      return parseStrictTrueFalseToken(stripped)
    }
    if (
      qFirst &&
      cleaned.length >= 5 &&
      cleaned.slice(1, 5).every((c) => parseTfCell(c) !== null)
    ) {
      const qNum = String(parseInt(qFirst[1], 10))
      const extraExp = cleaned.slice(5).join(' ').trim()
      const tfAnswers: Partial<Record<StatementLetter, boolean>> = {}
      STATEMENT_LETTERS.forEach((letter, idx) => {
        const val = parseTfCell(cleaned[idx + 1])
        registry.recordTf(ctx, qNum, letter, val, extraExp || undefined)
        if (val !== null) tfAnswers[letter] = val
      })
      activeTfQNum = qNum
      emittedSnippets.push({
        questionCode: rowCode,
        lessonKey: ctx.lessonKey,
        questionNumber: qNum,
        questionTypeHint: 'true_false',
        answerKey: null,
        tfAnswers,
        rubric: '',
        explanation: extraExp,
        stemSnippet: joinedRow.slice(0, 300),
        rawLine: joinedRow.slice(0, 400),
      })
      continue
    }

    // Collapsed 2-column / 3-column TF row: [Câu 1 | a) Đúng b) Sai c) Đúng d) Sai | Giải thích]
    if (qFirst && rawRow.length >= 2) {
      const nonEmptyRawCells = rawRow.filter((c) => c.plain.trim().length > 0)
      if (nonEmptyRawCells.length >= 2) {
        const tfPairs = parseTfPairsFromCellOrLines(nonEmptyRawCells[1])
        if (tfPairs.length >= 2) {
          const qNum = String(parseInt(qFirst[1], 10))
          const trailingExp = nonEmptyRawCells
            .slice(2)
            .map((c) => c.plain.trim())
            .filter((t) => t.length > 5 && !/^(?:Câu\s*)?\d{1,3}\s*[:.)\-]?$/i.test(t))
            .join(' ')
          const tfAnswers: Partial<Record<StatementLetter, boolean>> = {}
          const pairExps: string[] = []
          for (const p of tfPairs) {
            const combinedExp = [p.exp, trailingExp].filter(Boolean).join(' ').trim()
            registry.recordTf(ctx, qNum, p.letter, p.val, combinedExp || undefined)
            if (p.val !== null) tfAnswers[p.letter] = p.val
            if (p.exp) pairExps.push(`${p.letter}) ${p.exp}`)
          }
          activeTfQNum = qNum
          emittedSnippets.push({
            questionCode: rowCode,
            lessonKey: ctx.lessonKey,
            questionNumber: qNum,
            questionTypeHint: 'true_false',
            answerKey: null,
            tfAnswers,
            rubric: '',
            explanation: [trailingExp, ...pairExps].filter(Boolean).join('; '),
            stemSnippet: joinedRow.slice(0, 300),
            rawLine: joinedRow.slice(0, 400),
          })
          continue
        }
      }
    }

    // Row format for vertical True/False answer table:
    // [Câu 1 | a) ... | Đúng | Giải thích] or [a) | Đúng | Giải thích] or [Câu 1 | a) Đúng]
    const cell0Q = cleaned[0].match(/^(?:Câu\s*)?(\d{1,3})\s*[:.)\-]?$/i)
    if (cell0Q) {
      activeTfQNum = String(parseInt(cell0Q[1], 10))
    }

    const tfSubCellIdx = cleaned.findIndex(
      (c, idx) =>
        !(cell0Q && idx === 0) &&
        /^(?:(?:Ý\s*)?[abcd](?:\s*[).:\-\s]|\s*$))/i.test(c)
    )
    if (activeTfQNum && tfSubCellIdx !== -1 && cleaned.length >= tfSubCellIdx + 2) {
      const letterMatch = cleaned[tfSubCellIdx].match(/^(?:Ý\s*)?([abcd])\b/i)
      const valCell = cleaned
        .slice(tfSubCellIdx + 1)
        .find((c) => parseStrictTrueFalseToken(c) !== null)
      if (letterMatch && valCell !== undefined) {
        const letter = letterMatch[1].toLowerCase() as StatementLetter
        const val = parseStrictTrueFalseToken(valCell)
        const expParts = cleaned
          .slice(tfSubCellIdx + 1)
          .filter((c) => c !== valCell && c.length > 5)
        const exp = expParts.join(' ')
        registry.recordTf(ctx, activeTfQNum, letter, val, exp || undefined)
        emittedSnippets.push({
          questionCode: rowCode,
          lessonKey: ctx.lessonKey,
          questionNumber: activeTfQNum,
          questionTypeHint: 'true_false',
          answerKey: null,
          tfAnswers: val !== null ? { [letter]: val } : null,
          rubric: '',
          explanation: exp,
          stemSnippet: joinedRow.slice(0, 300),
          rawLine: joinedRow.slice(0, 400),
        })
        continue
      }
    }

    // Vertical TF where statement and Đ/S are inside the same cell: [a) Đúng ...]
    if (activeTfQNum) {
      let matchedInlineTf = false
      for (const cellText of cleaned) {
        const singleTf = cellText.match(
          /^(?:Ý\s*)?([abcd])\s*[:.)\-]\s*(Đúng|Sai|Đ|S|True|False)\b(.*)$/i
        )
        if (singleTf) {
          const letter = singleTf[1].toLowerCase() as StatementLetter
          const val = parseBoolToken(singleTf[2])
          const exp = singleTf[3].replace(/^[.\-:\s]+/, '').trim()
          registry.recordTf(ctx, activeTfQNum, letter, val, exp || undefined)
          emittedSnippets.push({
            questionCode: rowCode,
            lessonKey: ctx.lessonKey,
            questionNumber: activeTfQNum,
            questionTypeHint: 'true_false',
            answerKey: null,
            tfAnswers: val !== null ? { [letter]: val } : null,
            rubric: '',
            explanation: exp,
            stemSnippet: joinedRow.slice(0, 300),
            rawLine: joinedRow.slice(0, 400),
          })
          matchedInlineTf = true
        }
      }
      if (matchedInlineTf) continue
    }

    // Pair columns: [1 | A | 2 | B | 3 | C] or [Câu 1: | B. | Giải thích ...] or [Câu 1 | Đáp án B]
    let matchedAnyPair = false
    for (let i = 0; i < cleaned.length; i++) {
      if (i + 1 < cleaned.length) {
        const qMatch = cleaned[i].match(/^(?:Câu\s*)?(\d{1,3})\s*[:.)\-]?$/i)
        const nextCell = cleaned[i + 1]
        const aMatch = nextCell.match(
          /^(?:(?:Đáp\s+án(?:\s+đúng)?|Chọn)\s*[:\-]?\s*)?([ABCD](?:\s*(?:\/|,|hoặc)\s*[ABCD])*|\?)\.?$/i
        )
        const labeledWithText =
          !aMatch &&
          (isExplicitAnswerTable ||
            /^(?:Đáp\s+án|Chọn)\s+/i.test(nextCell) ||
            ctx.questionTypeHint === 'multiple_choice')
            ? nextCell.match(/^(?:(?:Đáp\s+án(?:\s+đúng)?|Chọn)\s*[:\-]?\s*)?([ABCD])\s*[.)\-:]\s+(.+)$/i)
            : null

        if (qMatch && (aMatch || labeledWithText)) {
          const qNum = String(parseInt(qMatch[1], 10))
          const ansToken = (aMatch?.[1] ?? labeledWithText?.[1] ?? '').toUpperCase()
          const inlineBodyExp = labeledWithText?.[2]?.trim() ?? ''
          let exp = inlineBodyExp
          if (
            i + 2 < cleaned.length &&
            !/^(?:Câu\s*)?\d{1,3}\s*[:.)\-]?$/i.test(cleaned[i + 2]) &&
            !/^[ABCD]\.?$/i.test(cleaned[i + 2])
          ) {
            exp = [exp, cleaned[i + 2]].filter(Boolean).join(' ')
            i += 2
          } else {
            i += 1
          }
          registry.recordMcq(ctx, qNum, ansToken, exp || undefined)
          const singleK = /^[ABCD]$/.test(ansToken) ? (ansToken as AnswerOptionKey) : null
          emittedSnippets.push({
            questionCode: rowCode,
            lessonKey: ctx.lessonKey,
            questionNumber: qNum,
            questionTypeHint: 'multiple_choice',
            answerKey: singleK,
            tfAnswers: null,
            rubric: '',
            explanation: exp,
            stemSnippet: joinedRow.slice(0, 300),
            rawLine: joinedRow.slice(0, 400),
          })
          matchedAnyPair = true
          continue
        }

        // Essay rubric table row: [Câu 1 | <rubric text > 15 chars>]
        if (
          qMatch &&
          nextCell.length > 15 &&
          !/^[ABCD]\b/i.test(nextCell) &&
          (ctx.questionTypeHint === 'essay' || isExplicitAnswerTable)
        ) {
          const qNum = String(parseInt(qMatch[1], 10))
          const rubricText = cleaned.slice(i + 1).join(' | ')
          registry.recordEssay(ctx, qNum, rubricText)
          emittedSnippets.push({
            questionCode: rowCode,
            lessonKey: ctx.lessonKey,
            questionNumber: qNum,
            questionTypeHint: 'essay',
            answerKey: null,
            tfAnswers: null,
            rubric: rubricText,
            explanation: '',
            stemSnippet: rubricText.slice(0, 300),
            rawLine: joinedRow.slice(0, 400),
          })
          matchedAnyPair = true
          break
        }
      }

      const lineResult = parseAnswerLineWithContext(cleaned[i], ctx, registry)
      if (lineResult.matchedType) {
        matchedAnyPair = true
        const qNum = lineResult.activeQNum ?? ''
        const singleKMatch = cleaned[i].match(/\b([ABCD])\.?\s*(?:[.\-:(]\s*(.+))?$/i)
        emittedSnippets.push({
          questionCode: rowCode,
          lessonKey: ctx.lessonKey,
          questionNumber: qNum,
          questionTypeHint: lineResult.matchedType === 'tf' ? 'true_false' : 'multiple_choice',
          answerKey:
            lineResult.matchedType === 'mcq' && singleKMatch
              ? (singleKMatch[1].toUpperCase() as AnswerOptionKey)
              : null,
          tfAnswers: null,
          rubric: '',
          explanation: singleKMatch?.[2]?.trim() ?? '',
          stemSnippet: cleaned[i].slice(0, 300),
          rawLine: cleaned[i].slice(0, 400),
        })
      }
    }

    // If a cell wasn't matched as pair but had multi-line cells inside, parse lines cleanly
    if (!matchedAnyPair) {
      for (const cell of rawRow) {
        for (const cLine of cell.lines) {
          const lKey = extractLessonKey(cLine.text)
          if (lKey) {
            ctx.lessonKey = lKey
            continue
          }
          parseAnswerLineWithContext(cLine.text, ctx, registry)
        }
      }
    }
  }

  return emittedSnippets
}

/* ============================================================================
 * MCQ STYLE FORMATTING & SPLIT HELPERS
 * ========================================================================== */

interface OptionStyleSignals {
  hasAsterisk: boolean
  hasUnderline: boolean
  hasHighlight: boolean
  hasColor: boolean
  hasBoldBody: boolean
}

function createEmptySignals(): OptionStyleSignals {
  return {
    hasAsterisk: false,
    hasUnderline: false,
    hasHighlight: false,
    hasColor: false,
    hasBoldBody: false,
  }
}

function scanStyleSignalsInTaggedSpan(
  rawTaggedLine: string,
  optStart: number,
  bodyStart: number,
  optEnd: number,
  hasAsterisk: boolean
): OptionStyleSignals {
  let bDepth = 0
  let uDepth = 0
  let hlDepth = 0
  let clrDepth = 0

  let hasUnderline = false
  let hasHighlight = false
  let hasColor = false
  let totalBodyChars = 0
  let boldBodyChars = 0

  const tagRegex = /\[\[(\/?)(U|B|HL|CLR)(?::[^\]]+)?\]\]/g
  let cursor = 0

  const accumulateText = (segStart: number, segEnd: number) => {
    if (segEnd <= optStart || segStart >= optEnd || segEnd <= segStart) return

    const prefixFrom = Math.max(segStart, optStart)
    const prefixTo = Math.min(segEnd, bodyStart)
    if (prefixTo > prefixFrom) {
      const prefixNonWs = rawTaggedLine.slice(prefixFrom, prefixTo).replace(/\s+/g, '').length
      if (prefixNonWs > 0) {
        if (uDepth > 0) hasUnderline = true
        if (hlDepth > 0) hasHighlight = true
        if (clrDepth > 0) hasColor = true
      }
    }

    const bodyFrom = Math.max(segStart, bodyStart)
    const bodyTo = Math.min(segEnd, optEnd)
    if (bodyTo > bodyFrom) {
      const bodyNonWs = rawTaggedLine.slice(bodyFrom, bodyTo).replace(/\s+/g, '').length
      if (bodyNonWs > 0) {
        totalBodyChars += bodyNonWs
        if (bDepth > 0) boldBodyChars += bodyNonWs
        if (uDepth > 0) hasUnderline = true
        if (hlDepth > 0) hasHighlight = true
        if (clrDepth > 0) hasColor = true
      }
    }
  }

  let tagMatch: RegExpExecArray | null
  while ((tagMatch = tagRegex.exec(rawTaggedLine)) !== null) {
    if (tagMatch.index >= optEnd) break
    accumulateText(cursor, tagMatch.index)

    const isClosing = tagMatch[1] === '/'
    const tagType = tagMatch[2]
    if (tagType === 'B') bDepth = Math.max(0, bDepth + (isClosing ? -1 : 1))
    else if (tagType === 'U') uDepth = Math.max(0, uDepth + (isClosing ? -1 : 1))
    else if (tagType === 'HL') hlDepth = Math.max(0, hlDepth + (isClosing ? -1 : 1))
    else if (tagType === 'CLR') clrDepth = Math.max(0, clrDepth + (isClosing ? -1 : 1))

    cursor = tagMatch.index + tagMatch[0].length
  }

  if (cursor < optEnd) {
    accumulateText(cursor, optEnd)
  }

  const hasBoldBody =
    totalBodyChars > 0 &&
    boldBodyChars >= Math.min(totalBodyChars, 2) &&
    boldBodyChars / totalBodyChars >= 0.6

  return {
    hasAsterisk,
    hasUnderline,
    hasHighlight,
    hasColor,
    hasBoldBody,
  }
}

function splitInlineOptions(
  line: string,
  rawTaggedLine: string
): {
  segments: {
    key: AnswerOptionKey
    cleanText: string
    rawBody: string
    signals: OptionStyleSignals
  }[]
  prefixClean: string
} | null {
  const markerWrap = '(?:\\[\\[(?:U|B|HL|CLR:[^\\]]+)\\]\\])*'
  const markerCloseWrap = '(?:\\[\\[\\/(?:U|B|HL|CLR)\\]\\])*'
  const optionRegex = new RegExp(
    `(?:^|\\s)(${markerWrap}\\*?${markerWrap}[ABCD]${markerCloseWrap})\\s*([.)])${markerCloseWrap}(?=\\s|$)`,
    'g'
  )

  const matches: {
    index: number
    optStart: number
    fullMatchLen: number
    key: AnswerOptionKey
    hasAsterisk: boolean
    rawToken: string
  }[] = []

  let m: RegExpExecArray | null
  while ((m = optionRegex.exec(rawTaggedLine)) !== null) {
    const rawToken = m[1]
    const cleanToken = stripInternalMarkers(rawToken)
    const hasAsterisk = cleanToken.startsWith('*')
    const letter = cleanToken.replace('*', '').toUpperCase() as AnswerOptionKey
    if (!VALID_ANSWER_KEYS.includes(letter)) continue

    if (matches.length === 0) {
      const leadingText = stripInternalMarkers(rawTaggedLine.slice(0, m.index))
      if (leadingText.length > 0 && letter !== 'A') {
        continue
      }
    }

    const leadingWsLen = m[0].length - m[0].trimStart().length
    matches.push({
      index: m.index,
      optStart: m.index + leadingWsLen,
      fullMatchLen: m[0].length,
      key: letter,
      hasAsterisk,
      rawToken,
    })
  }

  if (matches.length === 0) return null

  const firstKey = matches[0].key
  const prefixClean = stripInternalMarkers(rawTaggedLine.slice(0, matches[0].index))

  if (prefixClean.length > 0 && matches.length === 1 && firstKey !== 'A') {
    return null
  }
  if (
    prefixClean.length > 0 &&
    !/^(?:Câu|Question|\d+[.)])/i.test(line) &&
    matches.length < 2
  ) {
    return null
  }

  const segments: {
    key: AnswerOptionKey
    cleanText: string
    rawBody: string
    signals: OptionStyleSignals
  }[] = []

  for (let i = 0; i < matches.length; i++) {
    const bodyStart = matches[i].index + matches[i].fullMatchLen
    const end = i + 1 < matches.length ? matches[i + 1].index : rawTaggedLine.length
    const rawBody = rawTaggedLine.slice(bodyStart, end).trim()
    const cleanText = stripInternalMarkers(rawBody)

    const signals = scanStyleSignalsInTaggedSpan(
      rawTaggedLine,
      matches[i].optStart,
      bodyStart,
      end,
      matches[i].hasAsterisk
    )

    segments.push({
      key: matches[i].key,
      cleanText,
      rawBody,
      signals,
    })
  }

  return { segments, prefixClean }
}

function resolveMcqSignalsFromFormatting(
  optionSignals: Record<AnswerOptionKey, OptionStyleSignals>
): { keys: AnswerOptionKey[]; sourceLabel: string | null } {
  const asteriskKeys = VALID_ANSWER_KEYS.filter((k) => optionSignals[k].hasAsterisk)
  if (asteriskKeys.length > 0) {
    return {
      keys: asteriskKeys,
      sourceLabel: 'Đánh dấu dấu sao (*) trong file câu hỏi',
    }
  }

  const hlKeys = VALID_ANSWER_KEYS.filter((k) => optionSignals[k].hasHighlight)
  if (hlKeys.length > 0 && hlKeys.length < 4) {
    return {
      keys: hlKeys,
      sourceLabel: 'Tô màu nền (Highlight/Shading) trong file câu hỏi',
    }
  }

  const colorKeys = VALID_ANSWER_KEYS.filter((k) => optionSignals[k].hasColor)
  if (colorKeys.length > 0 && colorKeys.length < 4) {
    return {
      keys: colorKeys,
      sourceLabel: 'Tô màu chữ đáp án trong file câu hỏi',
    }
  }

  const underlineKeys = VALID_ANSWER_KEYS.filter((k) => optionSignals[k].hasUnderline)
  if (underlineKeys.length > 0 && underlineKeys.length < 4) {
    return {
      keys: underlineKeys,
      sourceLabel: 'Gạch chân đáp án trong file câu hỏi',
    }
  }

  const boldKeys = VALID_ANSWER_KEYS.filter((k) => optionSignals[k].hasBoldBody)
  if (boldKeys.length > 0 && boldKeys.length < 4) {
    return {
      keys: boldKeys,
      sourceLabel: 'In đậm nội dung phương án trong file câu hỏi',
    }
  }

  return { keys: [], sourceLabel: null }
}

function parseTrueFalseStatementLine(
  line: string,
  allowUppercaseLetter = false
): {
  letter: StatementLetter
  text: string
  inlineAnswer: boolean | null
} | null {
  const m = allowUppercaseLetter
    ? line.match(/^\s*(?:Ý\s+)?([abcdABCD])\s*[).:]\s+(.+)$/)
    : line.match(/^\s*(?:Ý\s+)?([abcd])\s*[).:]\s+(.+)$/)
  if (!m) return null
  const letter = m[1].toLowerCase() as StatementLetter
  let body = m[2].trim()
  let inlineAnswer: boolean | null = null

  const tailMatch = body.match(
    /\s*(?:\(\s*(Đúng|Sai|Đ|S)\s*\)|\[\s*(Đúng|Sai|Đ|S)\s*\]|\-\s*(Đúng|Sai|Đ|S))\s*\.?\s*$/i
  )
  if (tailMatch) {
    const token = tailMatch[1] || tailMatch[2] || tailMatch[3] || ''
    inlineAnswer = parseBoolToken(token)
    body = body.slice(0, tailMatch.index).trim()
  }

  return { letter, text: body, inlineAnswer }
}

function parseInlineAnswerLine(line: string): {
  keys: AnswerOptionKey[]
  tfAnswers: Partial<Record<StatementLetter, boolean | null>> | null
  ambiguousReason: string | null
  matched: boolean
} {
  const tfInlineMatch = line.match(
    /^\s*(?:\[|\()?(?:Đáp\s+án(?:\s+đúng)?|ĐA|Key)\s*[:\-]\s*([^\])\n]+)(?:\]|\))?\s*\.?\s*$/i
  )
  if (tfInlineMatch) {
    const rawVal = tfInlineMatch[1].trim()
    const pairMatches = Array.from(
      rawVal.matchAll(/([abcd])\s*[:.)\-]?\s*(Đúng|Sai|Đ|S|True|False|\?)/gi)
    )
    if (pairMatches.length >= 2) {
      const tfAnswers: Partial<Record<StatementLetter, boolean | null>> = {}
      for (const pm of pairMatches) {
        const letter = pm[1].toLowerCase() as StatementLetter
        tfAnswers[letter] = parseBoolToken(pm[2])
      }
      return { keys: [], tfAnswers, ambiguousReason: null, matched: true }
    }

    const seqMatch = rawVal.match(
      /^(Đúng|Sai|Đ|S)\s*[-,\/\s]+\s*(Đúng|Sai|Đ|S)\s*[-,\/\s]+\s*(Đúng|Sai|Đ|S)\s*[-,\/\s]+\s*(Đúng|Sai|Đ|S)$/i
    )
    if (seqMatch) {
      return {
        keys: [],
        tfAnswers: {
          a: parseStrictTrueFalseToken(seqMatch[1]),
          b: parseStrictTrueFalseToken(seqMatch[2]),
          c: parseStrictTrueFalseToken(seqMatch[3]),
          d: parseStrictTrueFalseToken(seqMatch[4]),
        },
        ambiguousReason: null,
        matched: true,
      }
    }
  }

  if (
    /^(?:BẢNG\s+ĐÁP\s+ÁN|ĐÁP\s+ÁN\s+(?:BÀI|TIẾT|PHẦN|CHỦ\s+ĐỀ|TRẮC\s+NGHIỆM|TỰ\s+LUẬN|THAM\s+KHẢO|CHI\s+TIẾT|CHÍNH\s+THỨC|TỔNG\s+HỢP))/i.test(
      line.trim()
    )
  ) {
    return { keys: [], tfAnswers: null, ambiguousReason: null, matched: false }
  }

  const match = line.match(
    /^\s*(?:\[|\()?(?:Đáp\s+án(?:\s+đúng)?|Dap\s+an(?:\s+dung)?|ĐA|Chọn|Key)\s*[:\-]\s*([^\])\n]+)(?:\]|\))?\s*\.?\s*$|^\s*(?:\[|\()?(?:Đáp\s+án(?:\s+đúng)?|Dap\s+an(?:\s+dung)?|ĐA|Chọn|Key)\s+([ABCD](?:\s*(?:\/|,|hoặc)\s*[ABCD])*)(?:\]|\))?\s*\.?\s*$/i
  )
  if (!match) {
    return { keys: [], tfAnswers: null, ambiguousReason: null, matched: false }
  }

  const rawValue = (match[1] ?? match[2] ?? '').trim()
  const value = rawValue.toUpperCase()
  if (/^[ABCD]$/.test(value)) {
    return {
      keys: [value as AnswerOptionKey],
      tfAnswers: null,
      ambiguousReason: null,
      matched: true,
    }
  }

  const letters = Array.from(new Set(value.match(/[ABCD]/g) ?? [])) as AnswerOptionKey[]
  if (letters.length > 1) {
    return {
      keys: letters,
      tfAnswers: null,
      ambiguousReason: `Dòng đáp án chứa nhiều phương án ("${rawValue}").`,
      matched: true,
    }
  }

  return {
    keys: [],
    tfAnswers: null,
    ambiguousReason: `Dòng đáp án không xác định rõ A/B/C/D ("${rawValue}").`,
    matched: true,
  }
}

/* ============================================================================
 * SEPARATE ANSWER DOCUMENT PARSER
 * ========================================================================== */

export interface SeparateAnswerSnippet {
  questionCode: string
  lessonKey: string
  questionNumber: string
  questionTypeHint: QuestionType | 'any'
  answerKey: AnswerOptionKey | null
  tfAnswers: Partial<Record<StatementLetter, boolean>> | null
  rubric: string
  explanation: string
  stemSnippet: string
  rawLine: string
  ambiguousConflict?: boolean
  conflictDetail?: string
}

export interface ParsedSeparateAnswerKeys {
  mcqMap: Map<string, AnswerKeyMapEntry>
  tfMap: Map<string, TrueFalseSectionEntry>
  essayRubricMap: Map<string, EssaySectionRubricEntry>
  byCode: Map<string, SeparateAnswerSnippet>
  snippets: SeparateAnswerSnippet[]
  hasLessonHeaders: boolean
  registry: ScopedAnswerRegistry
  rawText: string
  warnings: string[]
}

export async function parseSeparateAnswerKeyDocument(
  buffer: Buffer,
  fileFormat: SourceFileFormat
): Promise<ParsedSeparateAnswerKeys> {
  const extracted = await extractStructuredDocumentContent(buffer, fileFormat)
  const registry = new ScopedAnswerRegistry()
  const byCode = new Map<string, SeparateAnswerSnippet>()
  const recordByCode = (code: string, snippet: SeparateAnswerSnippet) => {
    if (!code) return
    const existing = byCode.get(code)
    if (!existing) {
      byCode.set(code, snippet)
      return
    }
    if (
      existing.answerKey &&
      snippet.answerKey &&
      existing.answerKey !== snippet.answerKey
    ) {
      existing.ambiguousConflict = true
      existing.conflictDetail = `Có nhiều đáp án xung đột cho mã câu ${code} (${existing.answerKey} và ${snippet.answerKey}).`
    }
  }
  const snippets: SeparateAnswerSnippet[] = []
  let hasLessonHeaders = false
  const ctx: ScopedKeyContext = {
    lessonKey: '__root__',
    topicKey: '__root__',
    questionTypeHint: 'any',
  }

  let activeEssayNum: string | null = null
  let activeLastQNum: string | null = null
  let activeLastQType: QuestionType | null = null

  for (const blk of extracted.blocks) {
    if (blk.kind === 'table') {
      const prevLesson = ctx.lessonKey
      const tableSnippets = parseAnswerTableIntoRegistry(blk.rows, ctx, registry)
      if (ctx.lessonKey !== '__root__' || ctx.lessonKey !== prevLesson) {
        hasLessonHeaders = true
      }
      for (const snip of tableSnippets) {
        snippets.push(snip)
        recordByCode(snip.questionCode, snip)
      }
      if (tableSnippets.length === 0) {
        for (const row of blk.rows) {
          const joined = row.map((c) => c.plain.trim()).filter(Boolean).join(' | ')
          if (joined) {
            const rowLKey = extractLessonKey(joined)
            if (rowLKey) hasLessonHeaders = true
            const code = extractQuestionCode(joined)
            const qm = joined.match(/(?:Câu\s*)?(\d{1,3})\b/i)
            const ansM = row.map((c) => c.plain.trim()).find((c) => /^[ABCD]\.?$/i.test(c))
            if (code || ansM) {
              const snippet: SeparateAnswerSnippet = {
                questionCode: code,
                lessonKey: rowLKey ?? ctx.lessonKey,
                questionNumber: qm ? String(parseInt(qm[1], 10)) : '',
                questionTypeHint: ctx.questionTypeHint,
                answerKey: ansM ? (ansM.replace('.', '').toUpperCase() as AnswerOptionKey) : null,
                tfAnswers: null,
                rubric: '',
                explanation: '',
                stemSnippet: joined.slice(0, 300),
                rawLine: joined.slice(0, 400),
              }
              snippets.push(snippet)
              recordByCode(code, snippet)
            }
          }
        }
      }
      activeEssayNum = null
      continue
    }

    const clean = blk.line.text
    const lineCode = extractQuestionCode(clean)
    const ansHeader = isAnswerSectionHeader(clean)
    if (ansHeader.isHeader) {
      const hdrTopic = extractTopicKey(clean)
      if (hdrTopic) ctx.topicKey = hdrTopic
      const hdrLesson = extractLessonKey(clean)
      if (hdrLesson) {
        ctx.lessonKey = hdrLesson
        hasLessonHeaders = true
      }
      const hdrType = detectSectionQuestionType(clean)
      if (hdrType) ctx.questionTypeHint = hdrType
      activeEssayNum = null
      activeLastQNum = null
      activeLastQType = null
      continue
    }

    const tKey = extractTopicKey(clean)
    if (tKey) {
      ctx.topicKey = tKey
      activeEssayNum = null
      continue
    }
    const lKey = extractLessonKey(clean)
    if (lKey) {
      ctx.lessonKey = lKey
      hasLessonHeaders = true
      activeEssayNum = null
      continue
    }
    const secType = detectSectionQuestionType(clean)
    if (secType) {
      ctx.questionTypeHint = secType
      activeEssayNum = null
      continue
    }

    const parsedAns = parseAnswerLineWithContext(clean, ctx, registry)
    if (parsedAns.matchedType) {
      activeEssayNum = null
      activeLastQNum = parsedAns.activeQNum
      activeLastQType = parsedAns.matchedType === 'tf' ? 'true_false' : 'multiple_choice'
      const singleKeyMatch = clean.match(/\b([ABCD])\.?(?:\s*[.\-:\u2013\u2014(]\s*(.+))?$/i)
      const snippet: SeparateAnswerSnippet = {
        questionCode: lineCode,
        lessonKey: ctx.lessonKey,
        questionNumber: parsedAns.activeQNum ?? '',
        questionTypeHint: activeLastQType,
        answerKey:
          activeLastQType === 'multiple_choice' && singleKeyMatch
            ? (singleKeyMatch[1].toUpperCase() as AnswerOptionKey)
            : null,
        tfAnswers: null,
        rubric: '',
        explanation: singleKeyMatch?.[2]?.trim() ?? '',
        stemSnippet: clean.slice(0, 300),
        rawLine: clean.slice(0, 400),
      }
      snippets.push(snippet)
      recordByCode(lineCode, snippet)
      continue
    }

    // Continuation explanation lines inside answer key
    if (activeLastQNum && activeLastQType && /^(?:Giải\s+thích|Hướng\s+dẫn|Vì)\s*[:\-]/i.test(clean)) {
      registry.recordExplanation(
        ctx,
        activeLastQType,
        activeLastQNum,
        clean.replace(/^(?:Giải\s+thích|Hướng\s+dẫn|Vì)\s*[:\-]\s*/i, '')
      )
      continue
    }

    // Continuation True/False sub-statements: a) Đúng ... b) Sai ...
    if (activeLastQNum) {
      const subTf = clean.match(/^([abcd])\s*[).:\-]\s*(Đúng|Sai|Đ|S|True|False)\b(.*)$/i)
      if (subTf) {
        const letter = subTf[1].toLowerCase() as StatementLetter
        const val = parseBoolToken(subTf[2])
        const expText = subTf[3].replace(/^[.\-\s:]+/, '').trim()
        registry.recordTf(ctx, activeLastQNum, letter, val, expText || undefined)
        activeLastQType = 'true_false'
        continue
      }
    }

    const essayStart = clean.match(/^(?:Câu\s*)?(\d{1,3})\s*[:.)\-]\s*(.+)$/i)
    if (essayStart && essayStart[2].length > 15 && !/^[ABCD]\b/i.test(essayStart[2])) {
      activeEssayNum = String(parseInt(essayStart[1], 10))
      registry.recordEssay(ctx, activeEssayNum, essayStart[2].trim())
      const snippet: SeparateAnswerSnippet = {
        questionCode: lineCode,
        lessonKey: ctx.lessonKey,
        questionNumber: activeEssayNum,
        questionTypeHint: 'essay',
        answerKey: null,
        tfAnswers: null,
        rubric: essayStart[2].trim(),
        explanation: '',
        stemSnippet: essayStart[2].trim().slice(0, 300),
        rawLine: clean.slice(0, 400),
      }
      snippets.push(snippet)
      recordByCode(lineCode, snippet)
    } else if (activeEssayNum && !/^(?:Câu\s*)?\d{1,3}\s*[:.)\-]/i.test(clean)) {
      registry.recordEssay(ctx, activeEssayNum, clean)
    } else if (lineCode || clean.length >= 12) {
      const snippet: SeparateAnswerSnippet = {
        questionCode: lineCode,
        lessonKey: ctx.lessonKey,
        questionNumber: '',
        questionTypeHint: ctx.questionTypeHint,
        answerKey: null,
        tfAnswers: null,
        rubric: '',
        explanation: '',
        stemSnippet: clean.slice(0, 300),
        rawLine: clean.slice(0, 400),
      }
      snippets.push(snippet)
      recordByCode(lineCode, snippet)
    }
  }

  // Fallback for TXT pipe/tab tables without document blocks
  if (extracted.blocks.every((b) => b.kind !== 'table') && extracted.tableRows.length > 0) {
    const fakeCells = extracted.tableRows.map((row) =>
      row.map((txt) => ({
        plain: txt,
        tagged: txt,
        lines: [{ text: txt, rawHtmlTaggedText: txt, pageNumber: null }],
      }))
    )
    parseAnswerTableIntoRegistry(fakeCells, ctx, registry)
  }

  const rawTextParts = [
    ...extracted.lines.map((l) => l.text),
    ...(extracted.tableRows.length > 0
      ? extracted.tableRows.map((r) => r.join(' | '))
      : []),
  ]

  return {
    mcqMap: registry.mcqGlobal,
    tfMap: registry.tfGlobal,
    essayRubricMap: registry.essayGlobal,
    byCode,
    snippets,
    hasLessonHeaders,
    registry,
    rawText: rawTextParts.join('\n'),
    warnings: extracted.warnings,
  }
}

/* ============================================================================
 * WORKING QUESTION STATE & WORD TABLE TRUE/FALSE RECOGNIZER
 * ========================================================================== */

interface WorkingQuestion {
  questionTypeHint: QuestionType | null
  questionNumber: string
  questionCode: string
  numericKey: string | null
  lessonTitle: string
  lessonKey: string
  topic: string
  topicKey: string
  pageNumber: number | null
  cognitiveLevel: CognitiveLevel
  stemLines: string[]
  options: Record<AnswerOptionKey, string[]>
  optionSignals: Record<AnswerOptionKey, OptionStyleSignals>
  statements: Record<StatementLetter, string[]>
  statementCandidates: Record<StatementLetter, Set<boolean>>
  statementAmbiguous: Record<StatementLetter, boolean>
  currentOption: AnswerOptionKey | null
  currentStatement: StatementLetter | null
  inlineCandidates: Set<AnswerOptionKey>
  inlineSources: Set<string>
  inlineAmbiguousReasons: string[]
  rubricLines: string[]
  sampleAnswerLines: string[]
  explanationLines: string[]
  activeMetaBlock: 'rubric' | 'sample' | 'explanation' | null
}

function createWorkingQuestion(params: {
  questionTypeHint: QuestionType | null
  questionNumber: string
  questionCode?: string
  numericKey: string | null
  lessonTitle: string
  lessonKey: string
  topic: string
  topicKey: string
  pageNumber: number | null
  cognitiveLevel: CognitiveLevel
}): WorkingQuestion {
  return {
    questionTypeHint: params.questionTypeHint,
    questionNumber: params.questionNumber,
    questionCode: params.questionCode ?? '',
    numericKey: params.numericKey,
    lessonTitle: params.lessonTitle,
    lessonKey: params.lessonKey,
    topic: params.topic,
    topicKey: params.topicKey,
    pageNumber: params.pageNumber,
    cognitiveLevel: params.cognitiveLevel,
    stemLines: [],
    options: { A: [], B: [], C: [], D: [] },
    optionSignals: {
      A: createEmptySignals(),
      B: createEmptySignals(),
      C: createEmptySignals(),
      D: createEmptySignals(),
    },
    statements: { a: [], b: [], c: [], d: [] },
    statementCandidates: {
      a: new Set<boolean>(),
      b: new Set<boolean>(),
      c: new Set<boolean>(),
      d: new Set<boolean>(),
    },
    statementAmbiguous: { a: false, b: false, c: false, d: false },
    currentOption: null,
    currentStatement: null,
    inlineCandidates: new Set<AnswerOptionKey>(),
    inlineSources: new Set<string>(),
    inlineAmbiguousReasons: [],
    rubricLines: [],
    sampleAnswerLines: [],
    explanationLines: [],
    activeMetaBlock: null,
  }
}

function lookAheadLooksLikeQuestions(blocks: DocumentBlock[], startIndex: number): boolean {
  let seenQuestionHeader = false
  let seenOptionOrStmt = false
  let limit = 0

  for (let i = startIndex; i < blocks.length && limit < 18; i++) {
    const blk = blocks[i]
    limit += 1
    if (blk.kind === 'table') {
      const flat = blk.rows.flat().map((c) => c.plain).join(' ')
      if (/^(?:a|b|c|d)\s*[).]/i.test(flat) || /\b[abcd]\)\s+[^\n]{8,}/.test(flat)) {
        return true
      }
      if (isLikelyAnswerTable(blk.rows)) {
        return false
      }
      continue
    }

    const txt = blk.line.text.trim()
    if (/^(?:Câu|Question)\s+\d+/i.test(txt)) {
      seenQuestionHeader = true
      // Check if it looks like an answer line ("Câu 1: A" or "Câu 1: a) Đúng b) Sai")
      if (/^(?:Câu|Question)\s+\d+\s*[:.)\-]\s*(?:[ABCD]\b(?:\s*$|\s*[.\-]|.*Giải\s+thích)|(?:[abcd]\s*[:.)\-]?\s*(?:Đúng|Sai|Đ|S)))/i.test(txt)) {
        return false
      }
    }
    if (/^[ABCD]\s*[.)]\s+\S{2,}/.test(txt) || /^[abcd]\s*[).:]\s+\S{5,}/.test(txt)) {
      seenOptionOrStmt = true
    }
    if (seenQuestionHeader && seenOptionOrStmt) return true
  }

  return false
}

function detectColumnBoolMark(cell: ExtractedTableCell): boolean {
  const t = cell.plain.trim().toLowerCase()
  return (
    t === 'x' ||
    t === '✓' ||
    t === '✔' ||
    t === 'đ' ||
    t === 's' ||
    t === 'đúng' ||
    t === 'sai' ||
    t === '☑' ||
    t === 'true' ||
    t === '1'
  )
}

function tryConsumeWordTableAsTrueFalse(params: {
  rows: ExtractedTableCell[][]
  pageNumber: number | null
  currentQuestion: WorkingQuestion | null
  currentLessonTitle: string
  currentLessonKey: string
  currentTopic: string
  currentTopicKey: string
  sectionCognitiveLevel: CognitiveLevel
  sectionQuestionType: QuestionType | null
  flushCurrent: () => void
  setCurrent: (wq: WorkingQuestion) => void
  onCompletedQuestion: (wq: WorkingQuestion) => void
}): boolean {
  const { rows } = params
  if (rows.length === 0) return false

  // Detect optional header row [STT/Ý | Nội dung/Phát biểu | Đúng | Sai]
  let dungColIdx = -1
  let saiColIdx = -1
  let contentStartRow = 0

  const firstRowNonEmpty = rows[0].map((c) => c.plain.trim()).filter(Boolean)
  const firstRowFirstCell = firstRowNonEmpty[0] || ''
  const firstRowLooksLikeStatementOrQuestion =
    /^[abcd]\s*[).:]/i.test(firstRowFirstCell) ||
    (/^[abcd]$/i.test(firstRowFirstCell) && firstRowNonEmpty.length >= 2) ||
    /^(?:Câu|Question)\s+\d+/i.test(firstRowFirstCell)

  const firstRowLower = rows[0].map((c) => c.plain.trim().toLowerCase())
  if (
    !firstRowLooksLikeStatementOrQuestion &&
    firstRowLower.some(
      (c) =>
        c === 'lệnh/ý' ||
        c === 'ý' ||
        c === 'stt' ||
        c === 'mệnh đề' ||
        c === 'phát biểu' ||
        c === 'nội dung' ||
        ((c.includes('nội dung') || c.includes('mệnh đề') || c.includes('phát biểu')) &&
          c.length <= 45)
    )
  ) {
    dungColIdx = firstRowLower.findIndex((c) => c === 'đúng' || c === 'đ')
    saiColIdx = firstRowLower.findIndex((c) => c === 'sai' || c === 's')
    contentStartRow = 1
  }

  // Count how many rows look like True/False statements a), b), c), d)
  let tfRowCount = 0
  for (let r = contentStartRow; r < rows.length; r++) {
    const cells = rows[r].map((c) => c.plain.trim()).filter(Boolean)
    if (cells.length === 0) continue
    if (
      /^[abcd]\s*[).:]/i.test(cells[0]) ||
      (/^[abcd]$/i.test(cells[0]) && cells.length >= 2)
    ) {
      tfRowCount += 1
    }
  }

  if (tfRowCount < 2 && !(params.sectionQuestionType === 'true_false' && tfRowCount >= 1)) {
    return false
  }

  // Ensure an active working question exists or is created from rows inside the table
  let activeQ = params.currentQuestion
  const tableHadExplicitQuestionHeader = rows
    .slice(contentStartRow)
    .some((r) => /^(?:Câu|Question)\s+\d+/i.test(r.map((c) => c.plain.trim()).filter(Boolean)[0] || ''))

  // If currentQuestion already has all 4 statements filled and table starts new statements, flush first
  if (
    activeQ &&
    (activeQ.statements.d.length > 0 || activeQ.options.D.length > 0) &&
    !tableHadExplicitQuestionHeader
  ) {
    params.flushCurrent()
    activeQ = null
  }

  for (let r = contentStartRow; r < rows.length; r++) {
    const rowCells = rows[r]
    const nonEmptyCells = rowCells.map((c) => c.plain.trim()).filter(Boolean)
    if (nonEmptyCells.length === 0) continue

    const firstCell = nonEmptyCells[0]
    const qMatch = firstCell.match(
      /^(?:Câu|Question)\s+(\d+[a-z]?)(?:\s*(?:\[[^\]]+\]|\([^)]+\)))?\s*[:.)\-]?\s*(.*)$/i
    )
    if (qMatch) {
      if (activeQ) {
        params.flushCurrent()
      }
      const rawNum = qMatch[1].trim()
      const rest = nonEmptyCells.length > 1 && !qMatch[2] ? nonEmptyCells.slice(1).join(' ') : qMatch[2].trim()
      const cog = detectCognitiveLevel(firstCell) ?? params.sectionCognitiveLevel
      const numMatch = rawNum.match(/\d+/)
      activeQ = createWorkingQuestion({
        questionTypeHint: 'true_false',
        questionNumber: `Câu ${rawNum}`,
        numericKey: numMatch ? String(parseInt(numMatch[0], 10)) : null,
        lessonTitle: params.currentLessonTitle,
        lessonKey: params.currentLessonKey,
        topic: params.currentTopic,
        topicKey: params.currentTopicKey,
        pageNumber: params.pageNumber,
        cognitiveLevel: cog,
      })
      if (rest) {
        activeQ.stemLines.push(rest)
      }
      params.setCurrent(activeQ)
      continue
    }

    // Row might be a stem row like "Cho bài toán..." if no question yet
    let stmtLetter: StatementLetter | null = null
    let stmtBody = ''
    let colBoolAnswer: boolean | null = null

    const cellLabelMatch = firstCell.match(/^([abcd])\s*[).:]?$/i)
    if (cellLabelMatch && nonEmptyCells.length >= 2) {
      stmtLetter = cellLabelMatch[1].toLowerCase() as StatementLetter
      stmtBody = nonEmptyCells[1]
    } else {
      const parsedStmt = parseTrueFalseStatementLine(firstCell, true)
      if (parsedStmt) {
        stmtLetter = parsedStmt.letter
        stmtBody = parsedStmt.text
        colBoolAnswer = parsedStmt.inlineAnswer
      }
    }

    if (stmtLetter && stmtBody) {
      if (!activeQ) {
        activeQ = createWorkingQuestion({
          questionTypeHint: 'true_false',
          questionNumber: 'Câu 1',
          numericKey: '1',
          lessonTitle: params.currentLessonTitle,
          lessonKey: params.currentLessonKey,
          topic: params.currentTopic,
          topicKey: params.currentTopicKey,
          pageNumber: params.pageNumber,
          cognitiveLevel: params.sectionCognitiveLevel,
        })
        params.setCurrent(activeQ)
      }
      activeQ.questionTypeHint = 'true_false'
      activeQ.currentStatement = stmtLetter

      // Strip trailing Đ/S column value if embedded in statement body
      const inlineCheck = parseTrueFalseStatementLine(`${stmtLetter}) ${stmtBody}`, true)
      if (inlineCheck) {
        stmtBody = inlineCheck.text
        if (colBoolAnswer === null && inlineCheck.inlineAnswer !== null) {
          colBoolAnswer = inlineCheck.inlineAnswer
        }
      }

      activeQ.statements[stmtLetter].push(stmtBody)

      // Check Đúng / Sai columns in rowCells
      if (colBoolAnswer === null) {
        if (dungColIdx !== -1 && saiColIdx !== -1) {
          const dMarked = rowCells[dungColIdx] ? detectColumnBoolMark(rowCells[dungColIdx]) : false
          const sMarked = rowCells[saiColIdx] ? detectColumnBoolMark(rowCells[saiColIdx]) : false
          if (dMarked && !sMarked) {
            colBoolAnswer = true
          } else if (sMarked && !dMarked) {
            colBoolAnswer = false
          } else if (dMarked && sMarked) {
            activeQ.statementAmbiguous[stmtLetter] = true
          }
        } else {
          // Check remaining cells for explicit Đúng / Sai token
          const tailStart = /^([abcd])\s*[).:]?$/i.test(firstCell) ? 2 : 1
          for (let ci = tailStart; ci < nonEmptyCells.length; ci++) {
            const parsedBool = parseStrictTrueFalseToken(nonEmptyCells[ci])
            if (parsedBool !== null) {
              colBoolAnswer = parsedBool
              break
            }
          }
        }
      }

      if (colBoolAnswer !== null) {
        activeQ.statementCandidates[stmtLetter].add(colBoolAnswer)
        activeQ.inlineSources.add('Bảng Đúng/Sai trong tài liệu')
      }
    } else if (activeQ && activeQ.stemLines.length === 0 && nonEmptyCells.length >= 1) {
      activeQ.stemLines.push(nonEmptyCells.join(' '))
    }
  }

  return true
}

/* ============================================================================
 * MAIN QUESTION BANK DOCUMENT PARSER
 * ========================================================================== */

export async function parseQuestionBankDocument(
  buffer: Buffer,
  fileName: string,
  fileFormat: SourceFileFormat,
  options?: {
    answerProvisionMode?: AnswerProvisionMode
    separateAnswerFile?: {
      buffer: Buffer
      fileName: string
      fileFormat: SourceFileFormat
    } | null
  }
): Promise<{
  fileName: string
  fileFormat: SourceFileFormat
  fileHash: string
  pageCount: number | null
  questions: ExtractedQuestion[]
  warnings: string[]
}> {
  const fileHash = sha256Hex(buffer)
  const answerMode: AnswerProvisionMode =
    options?.answerProvisionMode ?? 'embedded_in_file'

  const extracted = await extractStructuredDocumentContent(buffer, fileFormat)
  const warnings = [...extracted.warnings]
  const answerRegistry = new ScopedAnswerRegistry()

  let separateParsed: ParsedSeparateAnswerKeys | null = null
  if (answerMode === 'separate_answer_file' && options?.separateAnswerFile) {
    separateParsed = await parseSeparateAnswerKeyDocument(
      options.separateAnswerFile.buffer,
      options.separateAnswerFile.fileFormat
    )
    warnings.push(...separateParsed.warnings)
  }

  const workingQuestions: WorkingQuestion[] = []
  let currentQuestion: WorkingQuestion | null = null
  let currentLessonTitle = ''
  let currentLessonKey = '__root__'
  let currentTopic = ''
  let currentTopicKey = '__root__'
  let sectionCognitiveLevel: CognitiveLevel = 'unspecified'
  let sectionQuestionType: QuestionType | null = null

  let inAnswerSection = false
  let inGlobalAnswerSection = false
  const answerCtx: ScopedKeyContext = {
    lessonKey: '__root__',
    topicKey: '__root__',
    questionTypeHint: 'any',
  }
  let activeEssayAnswerKeyNum: string | null = null
  let activeAnswerLastQNum: string | null = null
  let activeAnswerLastQType: QuestionType | null = null

  const flushCurrentQuestion = () => {
    if (!currentQuestion) return
    const stem = currentQuestion.stemLines.join(' ').replace(/\s+/g, ' ').trim()
    const hasMcq =
      currentQuestion.options.A.length > 0 &&
      currentQuestion.options.B.length > 0 &&
      currentQuestion.options.C.length > 0 &&
      currentQuestion.options.D.length > 0
    const hasTf =
      currentQuestion.statements.a.length > 0 &&
      currentQuestion.statements.b.length > 0 &&
      currentQuestion.statements.c.length > 0 &&
      currentQuestion.statements.d.length > 0
    const isEssay =
      currentQuestion.questionTypeHint === 'essay' ||
      (sectionQuestionType === 'essay' && !hasMcq && !hasTf)

    if (stem.length >= 5 && (hasMcq || hasTf || isEssay)) {
      workingQuestions.push(currentQuestion)
    } else if (stem.length >= 5) {
      warnings.push(
        `Đã bỏ qua "${currentQuestion.questionNumber}" (${currentQuestion.lessonTitle || 'Ngoài bài'}) vì chưa đủ 4 lựa chọn A/B/C/D, 4 mệnh đề a/b/c/d hoặc đánh dấu Tự luận.`
      )
    }
    currentQuestion = null
  }

  const processParagraphLine = (lineObj: ExtractedLine, blockIdx: number) => {
    const cleanLine = lineObj.text
    const rawLine = lineObj.rawHtmlTaggedText

    const isLikelyActiveOptionLine =
      Boolean(currentQuestion && currentQuestion.options.A.length > 0 && /^[BCD]\s*[.)]\s+/.test(cleanLine))

    const ansHeader = isLikelyActiveOptionLine
      ? { isHeader: false, isGlobalSection: false }
      : isAnswerSectionHeader(cleanLine)
    if (ansHeader.isHeader) {
      flushCurrentQuestion()
      inAnswerSection = true
      if (ansHeader.isGlobalSection) {
        inGlobalAnswerSection = true
      }
      const headerLessonKey = extractLessonKey(cleanLine)
      answerCtx.lessonKey = ansHeader.isGlobalSection
        ? '__root__'
        : headerLessonKey ?? currentLessonKey
      answerCtx.topicKey = ansHeader.isGlobalSection ? '__root__' : currentTopicKey
      const headerType = detectSectionQuestionType(cleanLine)
      answerCtx.questionTypeHint = headerType ?? 'any'
      activeEssayAnswerKeyNum = null
      activeAnswerLastQNum = null
      activeAnswerLastQType = null
      return
    }

    if (inAnswerSection) {
      const nextTopicKey = extractTopicKey(cleanLine)
      const nextLessonKey = extractLessonKey(cleanLine)

      // Decide whether a new Topic/Lesson heading starts a new Question Lesson (Doc 1)
      // or switches lesson scope inside Global Part C Answers (Doc 2)
      if (nextTopicKey || nextLessonKey) {
        const isQuestionsAhead =
          !inGlobalAnswerSection &&
          lookAheadLooksLikeQuestions(extracted.blocks, blockIdx + 1)

        if (isQuestionsAhead) {
          inAnswerSection = false
          activeEssayAnswerKeyNum = null
          activeAnswerLastQNum = null
          activeAnswerLastQType = null
          // Fall through to normal header handling below!
        } else {
          if (nextTopicKey) {
            answerCtx.topicKey = nextTopicKey
          }
          if (nextLessonKey) {
            answerCtx.lessonKey = nextLessonKey
          }
          const subType = detectSectionQuestionType(cleanLine)
          if (subType) {
            answerCtx.questionTypeHint = subType
          }
          activeEssayAnswerKeyNum = null
          activeAnswerLastQNum = null
          activeAnswerLastQType = null
          return
        }
      } else {
        const subType = detectSectionQuestionType(cleanLine)
        if (subType && cleanLine.length <= 120) {
          answerCtx.questionTypeHint = subType
          activeEssayAnswerKeyNum = null
          activeAnswerLastQNum = null
          activeAnswerLastQType = null
          return
        }

        // Parse answer lines inside answer section
        if (answerMode === 'embedded_in_file') {
          const parsedAns = parseAnswerLineWithContext(cleanLine, answerCtx, answerRegistry)
          if (parsedAns.matchedType) {
            activeEssayAnswerKeyNum = null
            activeAnswerLastQNum = parsedAns.activeQNum
            activeAnswerLastQType =
              parsedAns.matchedType === 'tf' ? 'true_false' : 'multiple_choice'
            return
          }

          if (
            activeAnswerLastQNum &&
            activeAnswerLastQType &&
            /^(?:Giải\s+thích|Hướng\s+dẫn|Vì|Lời\s+giải)\s*[:\-]/i.test(cleanLine)
          ) {
            answerRegistry.recordExplanation(
              answerCtx,
              activeAnswerLastQType,
              activeAnswerLastQNum,
              cleanLine.replace(/^(?:Giải\s+thích|Hướng\s+dẫn|Vì|Lời\s+giải)\s*[:\-]\s*/i, '')
            )
            return
          }

          if (activeAnswerLastQNum) {
            const subTf = cleanLine.match(
              /^([abcd])\s*[).:\-]\s*(Đúng|Sai|Đ|S|True|False)\b(.*)$/i
            )
            if (subTf) {
              const letter = subTf[1].toLowerCase() as StatementLetter
              const val = parseBoolToken(subTf[2])
              const expText = subTf[3].replace(/^[.\-\s:]+/, '').trim()
              answerRegistry.recordTf(
                answerCtx,
                activeAnswerLastQNum,
                letter,
                val,
                expText || undefined
              )
              activeAnswerLastQType = 'true_false'
              return
            }
          }

          const essayKeyStart = cleanLine.match(/^(?:Câu\s*)?(\d{1,3})\s*[:.)\-]\s*(.+)$/i)
          if (
            essayKeyStart &&
            essayKeyStart[2].length > 18 &&
            !/^[ABCD]\b/i.test(essayKeyStart[2])
          ) {
            activeEssayAnswerKeyNum = String(parseInt(essayKeyStart[1], 10))
            answerRegistry.recordEssay(
              answerCtx,
              activeEssayAnswerKeyNum,
              essayKeyStart[2].trim()
            )
            return
          }

          if (activeEssayAnswerKeyNum && !/^\d{1,3}\s*[:.)\-]/.test(cleanLine)) {
            answerRegistry.recordEssay(answerCtx, activeEssayAnswerKeyNum, cleanLine)
            return
          }

          if (
            activeAnswerLastQNum &&
            activeAnswerLastQType &&
            cleanLine.length > 10 &&
            !/^(?:Câu\s*)?\d{1,3}\s*[:.)\-]/.test(cleanLine)
          ) {
            answerRegistry.recordExplanation(
              answerCtx,
              activeAnswerLastQType,
              activeAnswerLastQNum,
              cleanLine
            )
          }
        }
        return
      }
    }

    if (currentQuestion) {
      const rubricMatch = cleanLine.match(
        /^(?:Hướng\s+dẫn\s+chấm|Tiêu\s+chí\s+chấm|Biểu\s+điểm|Rubric)\s*[:\-]\s*(.*)$/i
      )
      if (rubricMatch) {
        currentQuestion.activeMetaBlock = 'rubric'
        if (rubricMatch[1].trim()) {
          currentQuestion.rubricLines.push(rubricMatch[1].trim())
        }
        return
      }

      const sampleMatch = cleanLine.match(
        /^(?:Gợi\s+ý\s+(?:trả\s+lời|đáp\s+án)|Lời\s+giải\s+mẫu|Bài\s+giải\s+tham\s+khảo)\s*[:\-]\s*(.*)$/i
      )
      if (sampleMatch) {
        currentQuestion.activeMetaBlock = 'sample'
        if (sampleMatch[1].trim()) {
          currentQuestion.sampleAnswerLines.push(sampleMatch[1].trim())
        }
        return
      }

      const explanationMatch = cleanLine.match(
        /^(?:Giải\s+thích|Hướng\s+dẫn\s+giải)\s*[:\-]\s*(.*)$/i
      )
      if (explanationMatch) {
        currentQuestion.activeMetaBlock = 'explanation'
        if (explanationMatch[1].trim()) {
          currentQuestion.explanationLines.push(explanationMatch[1].trim())
        }
        return
      }

      const inlineAns = parseInlineAnswerLine(cleanLine)
      if (inlineAns.matched) {
        currentQuestion.activeMetaBlock = null
        if (inlineAns.tfAnswers) {
          for (const letter of STATEMENT_LETTERS) {
            const val = inlineAns.tfAnswers[letter]
            if (val !== undefined) {
              if (val === null) {
                currentQuestion.statementAmbiguous[letter] = true
              } else {
                currentQuestion.statementCandidates[letter].add(val)
              }
            }
          }
          currentQuestion.inlineSources.add('Dòng đáp án ngay dưới câu hỏi')
        } else {
          for (const k of inlineAns.keys) {
            currentQuestion.inlineCandidates.add(k)
          }
          if (inlineAns.keys.length > 0) {
            currentQuestion.inlineSources.add('Dòng đáp án ghi rõ dưới câu hỏi')
          }
          if (inlineAns.ambiguousReason) {
            currentQuestion.inlineAmbiguousReasons.push(inlineAns.ambiguousReason)
          }
        }
        return
      }
    }

    const explicitQMatch = cleanLine.match(
      /^(?:Câu|Cau|Question)\s+(\d+[a-z]?)(?:\s*(?:\[[^\]]+\]|\([^)]+\)))?\s*[:.)\-]?\s*(.*)$/i
    )
    const numericQMatch =
      !explicitQMatch &&
      // Do not mistake "1. Bài học..." or compact answer line "1. A  2. B" for a question start
      !/^\d{1,3}\s*[.)]\s*(?:[ABCD](?:\s+\d{1,3}\s*[.)]\s*[ABCD])+)$/i.test(cleanLine)
        ? cleanLine.match(/^(\d{1,3})\s*[.)]\s+(.+)$/)
        : null

    if (explicitQMatch || numericQMatch) {
      const rawNum = (explicitQMatch?.[1] ?? numericQMatch?.[1] ?? '').trim()
      const restOfClean = (explicitQMatch?.[2] ?? numericQMatch?.[2] ?? '').trim()

      // Guard: numeric line like "1. A" when inside answer tail without header
      if (numericQMatch && /^[ABCD]$/i.test(restOfClean)) {
        if (answerMode === 'embedded_in_file') {
          answerCtx.lessonKey = currentLessonKey
          answerCtx.topicKey = currentTopicKey
          parseAnswerLineWithContext(cleanLine, answerCtx, answerRegistry)
        }
        return
      }

      // Guard: compact answer line like "1.A 2.B 3.C" even without answer header
      if (
        answerMode === 'embedded_in_file' &&
        /^(?:\d{1,3}\s*[:.)\-]?\s*[ABCD][\s,;|]+){2,}\d{1,3}\s*[:.)\-]?\s*[ABCD]\s*$/i.test(
          cleanLine
        )
      ) {
        flushCurrentQuestion()
        answerCtx.lessonKey = currentLessonKey
        answerCtx.topicKey = currentTopicKey
        parseAnswerLineWithContext(cleanLine, answerCtx, answerRegistry)
        return
      }

      flushCurrentQuestion()

      const detectedCog = detectCognitiveLevel(cleanLine) ?? sectionCognitiveLevel
      const numericKeyMatch = rawNum.match(/\d+/)

      let qTypeHint: QuestionType | null = sectionQuestionType
      if (/\[\s*TL\s*\]|\(\s*Tự\s+luận\s*\)/i.test(cleanLine)) {
        qTypeHint = 'essay'
      } else if (/\[\s*ĐS\s*\]|\(\s*Đúng\s*[\/\-]?\s*Sai\s*\)/i.test(cleanLine)) {
        qTypeHint = 'true_false'
      }

      const rawRestStart = rawLine.replace(
        /^(?:(?:Câu|Cau|Question)\s+\d+[a-z]?|\d{1,3})(?:\s*(?:\[[^\]]+\]|\([^)]+\)))?\s*[:.)\-]?\s*/i,
        ''
      )
      const splitInline = splitInlineOptions(restOfClean, rawRestStart)

      const newQ = createWorkingQuestion({
        questionTypeHint: qTypeHint,
        questionNumber: `Câu ${rawNum}`,
        questionCode: extractQuestionCode(cleanLine),
        numericKey: numericKeyMatch ? String(parseInt(numericKeyMatch[0], 10)) : null,
        lessonTitle: currentLessonTitle,
        lessonKey: currentLessonKey,
        topic: currentTopic,
        topicKey: currentTopicKey,
        pageNumber: lineObj.pageNumber,
        cognitiveLevel: detectedCog,
      })

      if (splitInline) {
        if (splitInline.prefixClean) {
          newQ.stemLines.push(splitInline.prefixClean)
        }
        for (const seg of splitInline.segments) {
          newQ.options[seg.key].push(seg.cleanText)
          newQ.currentOption = seg.key
          const prevSig = newQ.optionSignals[seg.key]
          newQ.optionSignals[seg.key] = {
            hasAsterisk: prevSig.hasAsterisk || seg.signals.hasAsterisk,
            hasUnderline: prevSig.hasUnderline || seg.signals.hasUnderline,
            hasHighlight: prevSig.hasHighlight || seg.signals.hasHighlight,
            hasColor: prevSig.hasColor || seg.signals.hasColor,
            hasBoldBody: prevSig.hasBoldBody || seg.signals.hasBoldBody,
          }
        }
      } else if (restOfClean) {
        newQ.stemLines.push(restOfClean)
      }

      currentQuestion = newQ
      return
    }

    const isMidMcqOption =
      Boolean(
        currentQuestion &&
          currentQuestion.options.A.length > 0 &&
          currentQuestion.options.D.length === 0 &&
          /^[BCD]\s*[.)]\s+/.test(cleanLine)
      )

    if (!isMidMcqOption && isLessonOrSectionHeader(cleanLine)) {
      const detectedType = detectSectionQuestionType(cleanLine)
      const headerCog = detectCognitiveLevel(cleanLine)
      const tKey = extractTopicKey(cleanLine)
      const lKey = extractLessonKey(cleanLine)

      if (tKey) {
        flushCurrentQuestion()
        currentTopic = cleanLine.slice(0, 150)
        currentTopicKey = tKey
        if (!currentLessonTitle) {
          currentLessonTitle = cleanLine.slice(0, 200)
        }
        if (detectedType !== null) sectionQuestionType = detectedType
        if (headerCog) sectionCognitiveLevel = headerCog
        return
      }

      if (lKey) {
        flushCurrentQuestion()
        currentLessonTitle = cleanLine.slice(0, 200)
        currentLessonKey = lKey
        if (detectedType !== null) sectionQuestionType = detectedType
        if (headerCog) sectionCognitiveLevel = headerCog
        return
      }

      if (detectedType !== null) {
        flushCurrentQuestion()
        sectionQuestionType = detectedType
        if (headerCog) sectionCognitiveLevel = headerCog
        return
      }

      if (/^(?:Mức(?:\s+độ)?|[IVX]+\.)\s*(?:Nhận biết|Thông hiểu|Vận dụng)/i.test(cleanLine)) {
        flushCurrentQuestion()
        if (headerCog) sectionCognitiveLevel = headerCog
        return
      }
    }

    // Compact answer line appearing outside explicit "ĐÁP ÁN" header at end of a lesson
    if (
      answerMode === 'embedded_in_file' &&
      /^(?:(?:Câu\s*)?\d{1,3}\s*[:.)\-]?\s*[ABCD][\s,;|]+){2,}(?:Câu\s*)?\d{1,3}\s*[:.)\-]?\s*[ABCD]\s*$/i.test(
        cleanLine
      )
    ) {
      flushCurrentQuestion()
      answerCtx.lessonKey = currentLessonKey
      answerCtx.topicKey = currentTopicKey
      parseAnswerLineWithContext(cleanLine, answerCtx, answerRegistry)
      return
    }

    if (!currentQuestion) {
      const standaloneCog = detectCognitiveLevel(cleanLine)
      if (standaloneCog && cleanLine.length <= 50) {
        sectionCognitiveLevel = standaloneCog
      }
      return
    }

    if (currentQuestion.activeMetaBlock === 'rubric') {
      currentQuestion.rubricLines.push(cleanLine)
      return
    }
    if (currentQuestion.activeMetaBlock === 'sample') {
      currentQuestion.sampleAnswerLines.push(cleanLine)
      return
    }
    if (currentQuestion.activeMetaBlock === 'explanation') {
      currentQuestion.explanationLines.push(cleanLine)
      return
    }

    const tfStmt = parseTrueFalseStatementLine(
      cleanLine,
      currentQuestion.questionTypeHint === 'true_false' ||
        sectionQuestionType === 'true_false'
    )
    if (
      tfStmt &&
      currentQuestion.currentOption === null &&
      (currentQuestion.questionTypeHint === 'true_false' ||
        sectionQuestionType === 'true_false' ||
        /^[abcd]$/.test(cleanLine.trim().charAt(0)))
    ) {
      currentQuestion.statements[tfStmt.letter].push(tfStmt.text)
      currentQuestion.currentStatement = tfStmt.letter
      currentQuestion.questionTypeHint = 'true_false'
      if (tfStmt.inlineAnswer !== null) {
        currentQuestion.statementCandidates[tfStmt.letter].add(tfStmt.inlineAnswer)
        currentQuestion.inlineSources.add('Đánh dấu Đ/S ngay trên từng mệnh đề')
      }
      return
    }

    const splitOpts = splitInlineOptions(cleanLine, rawLine)
    if (splitOpts && currentQuestion.currentStatement === null) {
      if (splitOpts.prefixClean && currentQuestion.currentOption === null) {
        currentQuestion.stemLines.push(splitOpts.prefixClean)
      } else if (splitOpts.prefixClean && currentQuestion.currentOption !== null) {
        currentQuestion.options[currentQuestion.currentOption].push(splitOpts.prefixClean)
      }

      for (const seg of splitOpts.segments) {
        currentQuestion.options[seg.key].push(seg.cleanText)
        currentQuestion.currentOption = seg.key
        const prevSig = currentQuestion.optionSignals[seg.key]
        currentQuestion.optionSignals[seg.key] = {
          hasAsterisk: prevSig.hasAsterisk || seg.signals.hasAsterisk,
          hasUnderline: prevSig.hasUnderline || seg.signals.hasUnderline,
          hasHighlight: prevSig.hasHighlight || seg.signals.hasHighlight,
          hasColor: prevSig.hasColor || seg.signals.hasColor,
          hasBoldBody: prevSig.hasBoldBody || seg.signals.hasBoldBody,
        }
      }
      return
    }

    const extraCog = detectCognitiveLevel(cleanLine)
    if (
      extraCog &&
      currentQuestion.cognitiveLevel === 'unspecified' &&
      cleanLine.length <= 40
    ) {
      currentQuestion.cognitiveLevel = extraCog
    }

    if (currentQuestion.currentStatement !== null) {
      currentQuestion.statements[currentQuestion.currentStatement].push(cleanLine)
    } else if (currentQuestion.currentOption !== null) {
      currentQuestion.options[currentQuestion.currentOption].push(cleanLine)
      const contSignals = scanStyleSignalsInTaggedSpan(rawLine, 0, 0, rawLine.length, false)
      const prevSig = currentQuestion.optionSignals[currentQuestion.currentOption]
      currentQuestion.optionSignals[currentQuestion.currentOption] = {
        hasAsterisk: prevSig.hasAsterisk || contSignals.hasAsterisk,
        hasUnderline: prevSig.hasUnderline || contSignals.hasUnderline,
        hasHighlight: prevSig.hasHighlight || contSignals.hasHighlight,
        hasColor: prevSig.hasColor || contSignals.hasColor,
        hasBoldBody: prevSig.hasBoldBody || contSignals.hasBoldBody,
      }
    } else {
      currentQuestion.stemLines.push(cleanLine)
    }
  }

  for (let bIdx = 0; bIdx < extracted.blocks.length; bIdx++) {
    const blk = extracted.blocks[bIdx]
    if (blk.kind === 'paragraph') {
      processParagraphLine(blk.line, bIdx)
      continue
    }

    // Handle Word Table in exact document order
    if (inAnswerSection || isLikelyAnswerTable(blk.rows)) {
      if (answerMode === 'embedded_in_file') {
        if (!inAnswerSection) {
          flushCurrentQuestion()
          answerCtx.lessonKey = currentLessonKey
          answerCtx.topicKey = currentTopicKey
          answerCtx.questionTypeHint = sectionQuestionType ?? 'any'
        }
        parseAnswerTableIntoRegistry(blk.rows, answerCtx, answerRegistry)
      }
      continue
    }

    const handledAsTf = tryConsumeWordTableAsTrueFalse({
      rows: blk.rows,
      pageNumber: blk.pageNumber,
      currentQuestion,
      currentLessonTitle,
      currentLessonKey,
      currentTopic,
      currentTopicKey,
      sectionCognitiveLevel,
      sectionQuestionType,
      flushCurrent: flushCurrentQuestion,
      setCurrent: (wq) => {
        currentQuestion = wq
      },
      onCompletedQuestion: (wq) => {
        workingQuestions.push(wq)
        if (currentQuestion === wq) currentQuestion = null
      },
    })
    if (handledAsTf) continue

    // General content table (e.g. 2x2 options A/B/C/D or question rows inside table): process cell lines
    for (const row of blk.rows) {
      for (const cell of row) {
        for (const cLine of cell.lines) {
          processParagraphLine(cLine, bIdx)
        }
      }
    }
  }

  // Also parse TXT tableRows if any (since TXT blocks don't emit table blocks)
  if (
    fileFormat === 'txt' &&
    extracted.tableRows.length > 0 &&
    answerMode === 'embedded_in_file'
  ) {
    const fakeCells = extracted.tableRows.map((row) =>
      row.map((txt) => ({
        plain: txt,
        tagged: txt,
        lines: [{ text: txt, rawHtmlTaggedText: txt, pageNumber: null }],
      }))
    )
    parseAnswerTableIntoRegistry(fakeCells, answerCtx, answerRegistry)
  }

  flushCurrentQuestion()

  // Count numericKey occurrences globally AND per (lessonKey, questionType)
  const globalKeyCountsByType = new Map<string, number>()
  const lessonKeyCountsByType = new Map<string, number>()

  for (const wq of workingQuestions) {
    if (!wq.numericKey) continue
    const qType: QuestionType =
      wq.statements.a.length > 0 && wq.statements.d.length > 0
        ? 'true_false'
        : wq.options.A.length > 0 && wq.options.D.length > 0
        ? 'multiple_choice'
        : 'essay'
    const gKey = `${qType}:${wq.numericKey}`
    globalKeyCountsByType.set(gKey, (globalKeyCountsByType.get(gKey) ?? 0) + 1)

    const lKey = `${wq.lessonKey}:${qType}:${wq.numericKey}`
    lessonKeyCountsByType.set(lKey, (lessonKeyCountsByType.get(lKey) ?? 0) + 1)
  }

  const seenContentHashes = new Set<string>()

  const questions: ExtractedQuestion[] = workingQuestions.map((wq, idx) => {
    const questionText = wq.stemLines.join(' ').replace(/\s+/g, ' ').trim()
    const hasMcq =
      wq.options.A.length > 0 &&
      wq.options.B.length > 0 &&
      wq.options.C.length > 0 &&
      wq.options.D.length > 0
    const hasTf =
      wq.statements.a.length > 0 &&
      wq.statements.b.length > 0 &&
      wq.statements.c.length > 0 &&
      wq.statements.d.length > 0

    const questionType: QuestionType = hasTf
      ? 'true_false'
      : hasMcq
      ? 'multiple_choice'
      : 'essay'

    const optionA = wq.options.A.join(' ').replace(/\s+/g, ' ').trim()
    const optionB = wq.options.B.join(' ').replace(/\s+/g, ' ').trim()
    const optionC = wq.options.C.join(' ').replace(/\s+/g, ' ').trim()
    const optionD = wq.options.D.join(' ').replace(/\s+/g, ' ').trim()

    const statementA = wq.statements.a.join(' ').replace(/\s+/g, ' ').trim()
    const statementB = wq.statements.b.join(' ').replace(/\s+/g, ' ').trim()
    const statementC = wq.statements.c.join(' ').replace(/\s+/g, ' ').trim()
    const statementD = wq.statements.d.join(' ').replace(/\s+/g, ' ').trim()

    const rubricText = wq.rubricLines.join('\n').trim()
    const sampleText = wq.sampleAnswerLines.join('\n').trim()
    let explanationText = wq.explanationLines.join(' ').trim()

    const isGlobalRepeated = wq.numericKey
      ? (globalKeyCountsByType.get(`${questionType}:${wq.numericKey}`) ?? 0) > 1
      : false
    const isLessonRepeated = wq.numericKey
      ? (lessonKeyCountsByType.get(`${wq.lessonKey}:${questionType}:${wq.numericKey}`) ?? 0) > 1
      : false

    let finalRubric = rubricText
    let essaySource = finalRubric ? 'Hướng dẫn chấm ghi kèm ngay dưới câu hỏi' : ''

    if (questionType === 'essay' && !finalRubric && wq.numericKey && !isLessonRepeated) {
      if (answerMode === 'separate_answer_file' && separateParsed) {
        const sepEssay = separateParsed.registry.lookupEssay(
          wq.lessonKey,
          wq.numericKey,
          isGlobalRepeated
        )
        if (sepEssay && sepEssay.rubricParts.length > 0) {
          finalRubric = sepEssay.rubricParts.join('\n').trim()
          essaySource = `Đối chiếu file đáp án riêng (${options?.separateAnswerFile?.fileName})`
        }
      } else {
        const scopedEssay = answerRegistry.lookupEssay(
          wq.lessonKey,
          wq.numericKey,
          isGlobalRepeated
        )
        if (scopedEssay && scopedEssay.rubricParts.length > 0) {
          finalRubric = scopedEssay.rubricParts.join('\n').trim()
          essaySource = 'Mục Hướng dẫn chấm trong tài liệu'
        }
      }
    }

    const hashParts =
      questionType === 'multiple_choice'
        ? [optionA, optionB, optionC, optionD]
        : questionType === 'true_false'
        ? [statementA, statementB, statementC, statementD]
        : [finalRubric || sampleText || 'essay']

    const contentHash = computeQuestionContentHash(questionType, questionText, hashParts)
    const duplicateInFile = seenContentHashes.has(contentHash)
    seenContentHashes.add(contentHash)

    let answerKey: AnswerOptionKey | null = null
    let statementAnswerA: boolean | null = null
    let statementAnswerB: boolean | null = null
    let statementAnswerC: boolean | null = null
    let statementAnswerD: boolean | null = null
    let answerStatus: AnswerStatus = 'missing'
    let answerNote = ''
    let answerSource = ''

    if (questionType === 'multiple_choice') {
      const allCandidates = new Set<AnswerOptionKey>(wq.inlineCandidates)
      const sources = new Set<string>(wq.inlineSources)
      const notes: string[] = [...wq.inlineAmbiguousReasons]
      let forceAmbiguous = wq.inlineAmbiguousReasons.length > 0

      const fmtResolved = resolveMcqSignalsFromFormatting(wq.optionSignals)
      if (fmtResolved.keys.length === 1) {
        allCandidates.add(fmtResolved.keys[0])
        if (fmtResolved.sourceLabel) sources.add(fmtResolved.sourceLabel)
      } else if (fmtResolved.keys.length > 1) {
        fmtResolved.keys.forEach((k) => allCandidates.add(k))
        forceAmbiguous = true
        notes.push(
          `Nhiều phương án (${fmtResolved.keys.join(', ')}) cùng được đánh dấu định dạng (${fmtResolved.sourceLabel}).`
        )
      }

      if (answerMode === 'separate_answer_file' && separateParsed && wq.numericKey) {
        if (isLessonRepeated) {
          forceAmbiguous = true
          notes.push(
            `Số thứ tự ${wq.questionNumber} lặp lại trong cùng bài (${wq.lessonTitle || 'chưa rõ bài'}) nên không thể đối chiếu an toàn.`
          )
        } else {
          const sepMatch = separateParsed.registry.lookupMcq(
            wq.lessonKey,
            wq.numericKey,
            isGlobalRepeated
          )
          if (sepMatch.ambiguousConflictReason) {
            forceAmbiguous = true
            notes.push(sepMatch.ambiguousConflictReason)
          } else if (sepMatch.entry) {
            sepMatch.entry.keys.forEach((k) => allCandidates.add(k))
            sources.add(
              `Đối chiếu file đáp án riêng (${options?.separateAnswerFile?.fileName} · ${
                sepMatch.scopeLabel || wq.questionNumber
              })`
            )
            if (sepMatch.entry.ambiguous) {
              forceAmbiguous = true
              if (sepMatch.entry.reason) notes.push(sepMatch.entry.reason)
            }
            if (!explanationText && sepMatch.explanation) {
              explanationText = sepMatch.explanation
            }
          }
        }
      } else if (answerMode === 'embedded_in_file' && wq.numericKey) {
        if (isLessonRepeated) {
          // Only flag ambiguous if we actually found a numeric entry for that lesson
          const lessonHasEntry = answerRegistry.mcqByLesson.has(
            `${wq.lessonKey}|${wq.numericKey}`
          )
          if (lessonHasEntry) {
            forceAmbiguous = true
            notes.push(
              `Số thứ tự ${wq.questionNumber} lặp lại nhiều lần trong cùng ${
                wq.lessonTitle || 'một bài'
              }.`
            )
          }
        } else {
          const scopedMatch = answerRegistry.lookupMcq(
            wq.lessonKey,
            wq.numericKey,
            isGlobalRepeated
          )
          if (scopedMatch.ambiguousConflictReason) {
            forceAmbiguous = true
            notes.push(scopedMatch.ambiguousConflictReason)
          } else if (scopedMatch.entry) {
            scopedMatch.entry.keys.forEach((k) => allCandidates.add(k))
            sources.add(
              scopedMatch.scopeLabel
                ? `Đáp án ${scopedMatch.scopeLabel} trong tài liệu`
                : 'Bảng đáp án trong tài liệu'
            )
            if (scopedMatch.entry.ambiguous) {
              forceAmbiguous = true
              if (scopedMatch.entry.reason) notes.push(scopedMatch.entry.reason)
            }
            if (!explanationText && scopedMatch.explanation) {
              explanationText = scopedMatch.explanation
            }
          }
        }
      }

      if (forceAmbiguous || allCandidates.size > 1) {
        answerStatus = 'ambiguous'
        answerKey = null
        if (allCandidates.size > 1) {
          notes.push(
            `Phát hiện nhiều đáp án ứng viên (${Array.from(allCandidates).sort().join(', ')}).`
          )
        }
        answerNote = notes.join(' ') || 'Phát hiện xung đột đáp án, cần Super Admin kiểm tra lại.'
        answerSource = Array.from(sources).join(' + ') || 'Xung đột nguồn đáp án'
      } else if (allCandidates.size === 1) {
        answerKey = Array.from(allCandidates)[0]
        answerStatus = 'verified'
        answerSource = Array.from(sources).join(' + ') || 'Nhận diện tự động trong tài liệu'
        answerNote = `Đã nhận diện đáp án ${answerKey}.`
      } else {
        answerStatus = 'missing'
        answerKey = null
        answerSource =
          answerMode === 'separate_answer_file'
            ? `Không khớp được trong file đáp án (${options?.separateAnswerFile?.fileName || 'chưa có file'})`
            : 'Không tìm thấy dấu hiệu đáp án tương ứng'
        answerNote =
          answerMode === 'separate_answer_file'
            ? `Không tìm thấy đáp án khớp cho ${wq.questionNumber} (${wq.lessonTitle || 'tài liệu'}) trong file đáp án riêng.`
            : `Chưa tìm thấy đáp án cho ${wq.questionNumber} (${
                wq.lessonTitle || 'tài liệu'
              }) bằng định dạng hay mục đáp án tương ứng.`
      }
    } else if (questionType === 'true_false') {
      const merged: Record<StatementLetter, Set<boolean>> = {
        a: new Set(wq.statementCandidates.a),
        b: new Set(wq.statementCandidates.b),
        c: new Set(wq.statementCandidates.c),
        d: new Set(wq.statementCandidates.d),
      }
      const amb: Record<StatementLetter, boolean> = { ...wq.statementAmbiguous }
      const sources = new Set<string>(wq.inlineSources)
      const notes: string[] = []

      if (answerMode === 'separate_answer_file' && separateParsed && wq.numericKey) {
        if (isLessonRepeated) {
          STATEMENT_LETTERS.forEach((l) => {
            amb[l] = true
          })
          notes.push(`Trùng số thứ tự ${wq.questionNumber} trong phần Đúng/Sai của cùng bài.`)
        } else {
          const sepMatch = separateParsed.registry.lookupTf(
            wq.lessonKey,
            wq.numericKey,
            isGlobalRepeated
          )
          if (sepMatch.ambiguousConflictReason) {
            STATEMENT_LETTERS.forEach((l) => {
              amb[l] = true
            })
            notes.push(sepMatch.ambiguousConflictReason)
          } else if (sepMatch.entry) {
            STATEMENT_LETTERS.forEach((l) => {
              sepMatch.entry!.statements[l].forEach((v) => merged[l].add(v))
              if (sepMatch.entry!.ambiguous[l]) amb[l] = true
            })
            sources.add(
              `Đối chiếu file đáp án riêng (${options?.separateAnswerFile?.fileName} · ${
                sepMatch.scopeLabel || wq.questionNumber
              })`
            )
            if (!explanationText && sepMatch.explanation) {
              explanationText = sepMatch.explanation
            }
          }
        }
      } else if (answerMode === 'embedded_in_file' && wq.numericKey) {
        if (isLessonRepeated) {
          const lessonHasEntry = answerRegistry.tfByLesson.has(
            `${wq.lessonKey}|${wq.numericKey}`
          )
          if (lessonHasEntry) {
            STATEMENT_LETTERS.forEach((l) => {
              amb[l] = true
            })
            notes.push(`Trùng số thứ tự ${wq.questionNumber} trong phần Đúng/Sai của cùng bài.`)
          }
        } else {
          const scopedMatch = answerRegistry.lookupTf(
            wq.lessonKey,
            wq.numericKey,
            isGlobalRepeated
          )
          if (scopedMatch.ambiguousConflictReason) {
            STATEMENT_LETTERS.forEach((l) => {
              amb[l] = true
            })
            notes.push(scopedMatch.ambiguousConflictReason)
          } else if (scopedMatch.entry) {
            STATEMENT_LETTERS.forEach((l) => {
              scopedMatch.entry!.statements[l].forEach((v) => merged[l].add(v))
              if (scopedMatch.entry!.ambiguous[l]) amb[l] = true
            })
            sources.add(
              scopedMatch.scopeLabel
                ? `Đáp án Đúng/Sai (${scopedMatch.scopeLabel})`
                : 'Phần đáp án Đúng/Sai cuối tài liệu'
            )
            if (!explanationText && scopedMatch.explanation) {
              explanationText = scopedMatch.explanation
            }
          }
        }
      }

      const resolved: Partial<Record<StatementLetter, boolean>> = {}
      let hasAmbiguous = false
      let missingCount = 0

      for (const l of STATEMENT_LETTERS) {
        if (amb[l] || merged[l].size > 1) {
          hasAmbiguous = true
          notes.push(`Ý ${l}) có nhiều giá trị Đúng/Sai xung đột.`)
        } else if (merged[l].size === 1) {
          resolved[l] = Array.from(merged[l])[0]
        } else {
          missingCount += 1
        }
      }

      statementAnswerA = resolved.a ?? null
      statementAnswerB = resolved.b ?? null
      statementAnswerC = resolved.c ?? null
      statementAnswerD = resolved.d ?? null

      if (hasAmbiguous) {
        answerStatus = 'ambiguous'
        answerNote = notes.join(' ')
        answerSource = Array.from(sources).join(' + ') || 'Xung đột đáp án Đúng/Sai'
      } else if (missingCount > 0) {
        answerStatus = 'missing'
        answerNote = `Thiếu đáp án Đúng/Sai cho ${missingCount}/4 ý (a, b, c, d).`
        answerSource =
          Array.from(sources).join(' + ') ||
          (answerMode === 'separate_answer_file'
            ? 'Thiếu dữ liệu khớp trong file đáp án riêng'
            : 'Chưa tìm thấy đủ đáp án 4 ý')
      } else {
        answerStatus = 'verified'
        answerNote = 'Đã nhận diện đủ 4 đáp án Đúng/Sai (a, b, c, d).'
        answerSource = Array.from(sources).join(' + ') || 'Nhận diện tự động trong tài liệu'
      }
    } else {
      if (finalRubric.length >= 5) {
        answerStatus = 'verified'
        answerNote = 'Đã nhận diện hướng dẫn chấm (Rubric) cho câu tự luận.'
        answerSource = essaySource || 'Trích xuất từ tài liệu'
      } else {
        answerStatus = 'missing'
        answerNote =
          'Câu tự luận chưa có hướng dẫn chấm (Rubric) trong tài liệu nguồn.'
        answerSource =
          answerMode === 'separate_answer_file'
            ? 'Không tìm thấy hướng dẫn chấm trong file đáp án riêng'
            : 'Chưa thấy Rubric trong file câu hỏi'
      }
    }

    const derivedConfidenceScore =
      answerStatus === 'verified'
        ? answerSource.includes('file đáp án') || answerSource.includes('Bảng đáp án') || answerSource.includes('Phần')
          ? 96
          : 92
        : answerStatus === 'ambiguous'
        ? 35
        : 0
    const derivedConfidenceLevel: AgentConfidenceLevel =
      derivedConfidenceScore >= 85 ? 'high' : derivedConfidenceScore >= 55 ? 'medium' : 'low'
    const derivedMatchMethod: AgentMatchMethod =
      answerStatus === 'missing'
        ? 'unmatched'
        : answerSource.includes('file đáp án riêng') || answerSource.includes('Đáp án Bài') || answerSource.includes('Bảng đáp án')
        ? 'lesson_and_number'
        : answerSource.includes('In đậm') || answerSource.includes('Tô màu') || answerSource.includes('Gạch chân') || answerSource.includes('dấu sao')
        ? 'inline_formatting'
        : 'embedded_key_table'

    return {
      tempId: `q-${idx + 1}-${contentHash.slice(0, 8)}`,
      contentHash,
      questionType,
      questionOrigin: 'extracted',
      questionCode: wq.questionCode || extractQuestionCode(questionText),
      bankName: '',
      topic: wq.topic.slice(0, 150),
      sourceDocumentName: fileName.slice(0, 255),
      sourceDocumentHash: fileHash,
      sourceFormat: fileFormat,
      lessonTitle: wq.lessonTitle.slice(0, 200),
      questionNumber: wq.questionNumber.slice(0, 40),
      pageNumber: wq.pageNumber,
      cognitiveLevel: wq.cognitiveLevel,
      questionText: questionText.slice(0, 4000),
      originalQuestionText: questionText.slice(0, 4000),
      optionA: optionA.slice(0, 1500),
      optionB: optionB.slice(0, 1500),
      optionC: optionC.slice(0, 1500),
      optionD: optionD.slice(0, 1500),
      answerKey,
      statementA: statementA.slice(0, 1500),
      statementB: statementB.slice(0, 1500),
      statementC: statementC.slice(0, 1500),
      statementD: statementD.slice(0, 1500),
      statementAnswerA,
      statementAnswerB,
      statementAnswerC,
      statementAnswerD,
      rubric: finalRubric.slice(0, 4000),
      sampleAnswer: sampleText.slice(0, 4000),
      explanation: explanationText.slice(0, 3000),
      answerStatus,
      answerNote,
      answerSource,
      confidenceScore: derivedConfidenceScore,
      confidenceLevel: derivedConfidenceLevel,
      matchMethod: derivedMatchMethod,
      aiSuggestion: null,
      duplicateInFile,
      duplicateInBank: false,
      reviewDecision: 'pending',
    }
  })

  if (questions.length === 0) {
    warnings.push(
      'Bộ tách cấu trúc chưa tìm thấy câu hỏi theo chuẩn Câu X / A,B,C,D / bảng Đúng-Sai. Hệ thống sẽ thử phân tích bằng Gemini AI nếu đã cấu hình.'
    )
  }

  return {
    fileName,
    fileFormat,
    fileHash,
    pageCount: extracted.pageCount,
    questions,
    warnings,
  }
}
