import { ThinkingLevel, Type } from '@google/genai'
import type {
  AgentAnalysisSummary,
  AgentConfidenceLevel,
  AgentFileRole,
  AgentMatchMethod,
  AgentPairedSet,
  AgentPipelineStepRecord,
  AgentResumeCheckpoint,
  AgentSetMode,
  AgentUploadedFileReport,
  AiAnswerSourceType,
  AiQuestionSuggestion,
  AnswerOptionKey,
  AnswerProvisionMode,
  AnswerStatus,
  BatchExceptionResolveStats,
  BatchResolveExistingBankHint,
  CognitiveLevel,
  CompositeDocumentAnalysis,
  ExceptionResolutionCategory,
  ExtractedQuestion,
  GeminiConnectionInfo,
  ImportStepCode,
  QuestionType,
  SourceFileFormat,
} from '../src/types.ts'
import {
  classifyGeminiApiError,
  GEMINI_MODEL,
  getGeminiClient,
  isGeminiAiConfigured as checkGeminiConfigured,
  updateCachedGeminiStatusFromError,
  verifyGeminiApiConnection,
} from './geminiClient.ts'
import {
  computeQuestionContentHash,
  computeStemSimilarity,
  DocumentParserError,
  extractDocumentRichText,
  extractLessonKey,
  extractQuestionCode,
  extractStructuredDocumentContent,
  parseQuestionBankDocument,
  parseSeparateAnswerKeyDocument,
  sha256Hex,
  type ParsedSeparateAnswerKeys,
  type SeparateAnswerSnippet,
} from './questionParser.ts'

export { checkGeminiConfigured as isGeminiAiConfigured }

const MAX_INLINE_PDF_BYTES = 8 * 1024 * 1024
const CHUNK_CHAR_LIMIT = 24000
const GEMINI_CONCURRENCY = 3

export type ExtractionProgressCallback = (update: {
  step: ImportStepCode
  stepLabel: string
  progress: number
}) => void

export class AiExtractionError extends Error {
  step: ImportStepCode
  code: string
  statusCode: number

  constructor(
    step: ImportStepCode,
    code: string,
    message: string,
    statusCode = 422
  ) {
    super(message)
    this.name = 'AiExtractionError'
    this.step = step
    this.code = code
    this.statusCode = statusCode
  }
}

function stripJsonMarkdownFence(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()
  }
  return trimmed
}

function extractAnswerSectionTailForAi(sourceText: string): string {
  const idx = sourceText.search(
    /(?:PHẦN\s*[CD]|BẢNG\s+ĐÁP\s+ÁN(?:\s+TỔNG\s+HỢP)?|ĐÁP\s+ÁN\s+VÀ\s+(?:HƯỚNG\s+DẪN|GIẢI\s+THÍCH)|HƯỚNG\s+DẪN\s+CHẤM)/i
  )
  if (idx !== -1 && sourceText.length - idx <= 36000) {
    return `\n\n=== THAM CHIẾU PHẦN ĐÁP ÁN TRONG TÀI LIỆU ===\n${sourceText.slice(idx)}`
  }
  if (sourceText.length > CHUNK_CHAR_LIMIT) {
    const tail = sourceText.slice(-30000)
    if (/ĐÁP\s+ÁN|HƯỚNG\s+DẪN\s+(?:CHẤM|GIẢI)|Giải\s+thích/i.test(tail)) {
      return `\n\n=== THAM CHIẾU PHẦN ĐÁP ÁN CUỐI TÀI LIỆU ===\n${tail}`
    }
  }
  return ''
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results: R[] = new Array(items.length)
  let nextIdx = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++
      results[idx] = await worker(items[idx], idx)
    }
  })
  await Promise.all(runners)
  return results
}

const VALID_MCQ_KEYS: ReadonlyArray<AnswerOptionKey> = ['A', 'B', 'C', 'D']
const VALID_COGNITIVE: ReadonlyArray<CognitiveLevel> = [
  'recognition',
  'understanding',
  'application',
  'unspecified',
]

function splitTextIntoQuestionSafeChunks(text: string, maxChars = CHUNK_CHAR_LIMIT): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.length <= maxChars) return [trimmed]

  const lines = trimmed.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  let currentLen = 0

  for (const line of lines) {
    const isQuestionBoundary = /^(?:Câu|Question)\s+\d+/i.test(line.trim())
    if (
      currentLen > maxChars * 0.72 &&
      (isQuestionBoundary || currentLen + line.length + 1 > maxChars)
    ) {
      chunks.push(current.join('\n'))
      current = [line]
      currentLen = line.length + 1
    } else {
      current.push(line)
      currentLen += line.length + 1
    }
  }

  if (current.length > 0) {
    chunks.push(current.join('\n'))
  }

  return chunks
}

function normalizeMcqKey(val: unknown): AnswerOptionKey | null {
  if (typeof val !== 'string') return null
  const upper = val.trim().toUpperCase()
  return VALID_MCQ_KEYS.includes(upper as AnswerOptionKey)
    ? (upper as AnswerOptionKey)
    : null
}

function normalizeBoolOrNull(val: unknown): boolean | null {
  if (typeof val === 'boolean') return val
  if (typeof val === 'string') {
    const v = val.trim().toLowerCase()
    if (v === 'true' || v === 'đúng' || v === 'đ') return true
    if (v === 'false' || v === 'sai' || v === 's') return false
  }
  return null
}

function normalizeCognitive(val: unknown): CognitiveLevel {
  if (typeof val === 'string' && VALID_COGNITIVE.includes(val as CognitiveLevel)) {
    return val as CognitiveLevel
  }
  return 'unspecified'
}

function normalizeQuestionType(val: unknown): QuestionType {
  if (val === 'true_false' || val === 'essay' || val === 'multiple_choice') {
    return val
  }
  return 'multiple_choice'
}

function confidenceLevelFromScore(score: number): AgentConfidenceLevel {
  if (score >= 85) return 'high'
  if (score >= 55) return 'medium'
  return 'low'
}

interface RawGeminiQuestionItem {
  questionType?: unknown
  questionCode?: unknown
  questionNumber?: unknown
  lessonTitle?: unknown
  topic?: unknown
  pageNumber?: unknown
  cognitiveLevel?: unknown
  questionText?: unknown
  optionA?: unknown
  optionB?: unknown
  optionC?: unknown
  optionD?: unknown
  answerKey?: unknown
  statementA?: unknown
  statementB?: unknown
  statementC?: unknown
  statementD?: unknown
  statementAnswerA?: unknown
  statementAnswerB?: unknown
  statementAnswerC?: unknown
  statementAnswerD?: unknown
  rubric?: unknown
  sampleAnswer?: unknown
  explanation?: unknown
  answerStatus?: unknown
  answerSource?: unknown
  answerNote?: unknown
}

function buildExtractedQuestionFromRaw(
  raw: RawGeminiQuestionItem,
  idx: number,
  meta: {
    fileName: string
    fileFormat: SourceFileFormat
    fileHash: string
    questionOrigin: 'extracted' | 'ai_generated'
    bankName?: string
  }
): ExtractedQuestion | null {
  const questionType = normalizeQuestionType(raw.questionType)
  const questionText = typeof raw.questionText === 'string' ? raw.questionText.trim() : ''
  if (questionText.length < 5) return null

  const questionNumber =
    typeof raw.questionNumber === 'string' && raw.questionNumber.trim()
      ? raw.questionNumber.trim().slice(0, 40)
      : `Câu ${idx + 1}`

  const questionCode =
    typeof raw.questionCode === 'string' && raw.questionCode.trim()
      ? raw.questionCode.trim().toUpperCase().slice(0, 40)
      : extractQuestionCode(questionText)

  const lessonTitle =
    typeof raw.lessonTitle === 'string' ? raw.lessonTitle.trim().slice(0, 200) : ''
  const topic = typeof raw.topic === 'string' ? raw.topic.trim().slice(0, 150) : ''
  const pageNumRaw = Number(raw.pageNumber)
  const pageNumber =
    Number.isInteger(pageNumRaw) && pageNumRaw >= 1 && pageNumRaw <= 5000 ? pageNumRaw : null

  const cognitiveLevel = normalizeCognitive(raw.cognitiveLevel)

  const optionA = typeof raw.optionA === 'string' ? raw.optionA.trim().slice(0, 1500) : ''
  const optionB = typeof raw.optionB === 'string' ? raw.optionB.trim().slice(0, 1500) : ''
  const optionC = typeof raw.optionC === 'string' ? raw.optionC.trim().slice(0, 1500) : ''
  const optionD = typeof raw.optionD === 'string' ? raw.optionD.trim().slice(0, 1500) : ''
  let answerKey = normalizeMcqKey(raw.answerKey)

  const statementA = typeof raw.statementA === 'string' ? raw.statementA.trim().slice(0, 1500) : ''
  const statementB = typeof raw.statementB === 'string' ? raw.statementB.trim().slice(0, 1500) : ''
  const statementC = typeof raw.statementC === 'string' ? raw.statementC.trim().slice(0, 1500) : ''
  const statementD = typeof raw.statementD === 'string' ? raw.statementD.trim().slice(0, 1500) : ''
  let statementAnswerA = normalizeBoolOrNull(raw.statementAnswerA)
  let statementAnswerB = normalizeBoolOrNull(raw.statementAnswerB)
  let statementAnswerC = normalizeBoolOrNull(raw.statementAnswerC)
  let statementAnswerD = normalizeBoolOrNull(raw.statementAnswerD)

  const rubric = typeof raw.rubric === 'string' ? raw.rubric.trim().slice(0, 4000) : ''
  const sampleAnswer =
    typeof raw.sampleAnswer === 'string' ? raw.sampleAnswer.trim().slice(0, 4000) : ''
  const explanation =
    typeof raw.explanation === 'string' ? raw.explanation.trim().slice(0, 3000) : ''

  // Structural sanity check per questionType
  if (questionType === 'multiple_choice' && (!optionA || !optionB || !optionC || !optionD)) {
    return null
  }
  if (
    questionType === 'true_false' &&
    (!statementA || !statementB || !statementC || !statementD)
  ) {
    return null
  }

  let answerStatus: AnswerStatus =
    raw.answerStatus === 'verified' ||
    raw.answerStatus === 'ai_proposed' ||
    raw.answerStatus === 'needs_review' ||
    raw.answerStatus === 'ambiguous' ||
    raw.answerStatus === 'missing'
      ? raw.answerStatus
      : 'missing'

  if (answerStatus === 'ambiguous') {
    if (questionType === 'multiple_choice') answerKey = null
  }

  let hasCompleteAnswer = false
  if (questionType === 'multiple_choice') {
    hasCompleteAnswer = answerKey !== null
    if (!hasCompleteAnswer && (answerStatus === 'verified' || answerStatus === 'ai_proposed')) {
      answerStatus = 'missing'
    } else if (hasCompleteAnswer && answerStatus !== 'ambiguous' && answerStatus !== 'needs_review') {
      answerStatus = meta.questionOrigin === 'ai_generated' ? 'ai_proposed' : 'verified'
    }
  } else if (questionType === 'true_false') {
    hasCompleteAnswer =
      statementAnswerA !== null &&
      statementAnswerB !== null &&
      statementAnswerC !== null &&
      statementAnswerD !== null
    if (!hasCompleteAnswer && (answerStatus === 'verified' || answerStatus === 'ai_proposed')) {
      answerStatus = 'missing'
    } else if (hasCompleteAnswer && answerStatus !== 'ambiguous' && answerStatus !== 'needs_review') {
      answerStatus = meta.questionOrigin === 'ai_generated' ? 'ai_proposed' : 'verified'
    }
    if (!hasCompleteAnswer) {
      statementAnswerA = statementAnswerA ?? null
      statementAnswerB = statementAnswerB ?? null
      statementAnswerC = statementAnswerC ?? null
      statementAnswerD = statementAnswerD ?? null
    }
  } else {
    hasCompleteAnswer = rubric.length >= 5
    if (!hasCompleteAnswer) {
      answerStatus = 'missing'
    } else if (answerStatus !== 'ambiguous' && answerStatus !== 'needs_review') {
      answerStatus = meta.questionOrigin === 'ai_generated' ? 'ai_proposed' : 'verified'
    }
  }

  // AI-generated composite questions NEVER auto-mark as verified; store suggestion unapplied for review
  let aiSuggestion: AiQuestionSuggestion | null = null
  let finalAnswerKey = answerKey
  let finalSa = statementAnswerA
  let finalSb = statementAnswerB
  let finalSc = statementAnswerC
  let finalSd = statementAnswerD
  let finalRubric = rubric

  if (meta.questionOrigin === 'ai_generated' && hasCompleteAnswer) {
    answerStatus = 'ai_proposed'
    aiSuggestion = {
      suggestedAnswerKey: questionType === 'multiple_choice' ? answerKey : null,
      suggestedStatementA: questionType === 'true_false' ? statementAnswerA : null,
      suggestedStatementB: questionType === 'true_false' ? statementAnswerB : null,
      suggestedStatementC: questionType === 'true_false' ? statementAnswerC : null,
      suggestedStatementD: questionType === 'true_false' ? statementAnswerD : null,
      suggestedRubric: questionType === 'essay' ? rubric.slice(0, 3000) : '',
      suggestedExplanation: explanation.slice(0, 2000),
      confidenceScore: 86,
      confidenceLevel: 'high',
      matchMethod: 'ai_generated',
      reasoning:
        'AI Agent biên soạn câu hỏi và đề xuất đáp án từ nội dung tài liệu tổng hợp — cần Super Admin xác nhận trước khi đưa vào Ngân hàng câu hỏi.',
      sourceFileName: meta.fileName,
      applied: false,
    }
    finalAnswerKey = null
    finalSa = null
    finalSb = null
    finalSc = null
    finalSd = null
    finalRubric = ''
  }

  const hashParts =
    questionType === 'multiple_choice'
      ? [optionA, optionB, optionC, optionD]
      : questionType === 'true_false'
      ? [statementA, statementB, statementC, statementD]
      : [rubric || sampleAnswer || 'essay']

  const contentHash = computeQuestionContentHash(questionType, questionText, hashParts)

  const answerSource =
    meta.questionOrigin === 'ai_generated'
      ? 'AI Agent đề xuất từ tài liệu tổng hợp (chờ xác nhận)'
      : typeof raw.answerSource === 'string' && raw.answerSource.trim()
      ? raw.answerSource.trim().slice(0, 280)
      : answerStatus === 'verified'
      ? 'Nhận diện trong tài liệu nguồn'
      : 'Chưa nhận diện được nguồn đáp án'

  const answerNote =
    meta.questionOrigin === 'ai_generated' && hasCompleteAnswer
      ? 'AI Agent đã biên soạn câu hỏi và đề xuất đáp án — nhấn "Xác nhận đề xuất AI" để phê duyệt.'
      : typeof raw.answerNote === 'string' && raw.answerNote.trim()
      ? raw.answerNote.trim().slice(0, 350)
      : answerStatus === 'verified'
      ? questionType === 'multiple_choice'
        ? `Đã nhận diện đáp án ${answerKey}.`
        : questionType === 'true_false'
        ? 'Đã nhận diện đủ 4 đáp án Đúng/Sai.'
        : 'Đã có hướng dẫn chấm (Rubric).'
      : answerStatus === 'ambiguous'
      ? 'Phát hiện dấu hiệu đáp án xung đột hoặc chưa rõ ràng, cần kiểm tra lại.'
      : 'Chưa có đáp án / biểu điểm rõ ràng trong tài liệu.'

  const confidenceScore =
    meta.questionOrigin === 'ai_generated'
      ? hasCompleteAnswer
        ? 86
        : 0
      : answerStatus === 'verified'
      ? 88
      : answerStatus === 'ai_proposed'
      ? 84
      : answerStatus === 'needs_review'
      ? 68
      : answerStatus === 'ambiguous'
      ? 35
      : 0

  return {
    tempId: `q-${idx + 1}-${contentHash.slice(0, 8)}`,
    contentHash,
    questionType,
    questionOrigin: meta.questionOrigin,
    questionCode,
    bankName: (meta.bankName ?? '').trim().slice(0, 120),
    topic,
    sourceDocumentName: meta.fileName.slice(0, 255),
    sourceDocumentHash: meta.fileHash,
    sourceFormat: meta.fileFormat,
    lessonTitle,
    questionNumber,
    pageNumber,
    cognitiveLevel,
    questionText: questionText.slice(0, 4000),
    originalQuestionText: questionText.slice(0, 4000),
    optionA,
    optionB,
    optionC,
    optionD,
    answerKey: finalAnswerKey,
    statementA,
    statementB,
    statementC,
    statementD,
    statementAnswerA: finalSa,
    statementAnswerB: finalSb,
    statementAnswerC: finalSc,
    statementAnswerD: finalSd,
    rubric: finalRubric,
    sampleAnswer,
    explanation,
    answerStatus,
    answerNote,
    answerSource,
    confidenceScore,
    confidenceLevel: confidenceLevelFromScore(confidenceScore),
    matchMethod:
      meta.questionOrigin === 'ai_generated'
        ? 'ai_generated'
        : answerStatus === 'missing'
        ? 'unmatched'
        : 'ai_semantic_match',
    aiSuggestion,
    duplicateInFile: false,
    duplicateInBank: false,
    reviewDecision: 'pending',
  }
}

const EXTRACTED_QUESTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    questionType: {
      type: Type.STRING,
      description: 'One of: multiple_choice, true_false, essay',
    },
    questionCode: { type: Type.STRING },
    questionNumber: { type: Type.STRING },
    lessonTitle: { type: Type.STRING },
    topic: { type: Type.STRING },
    pageNumber: { type: Type.INTEGER, nullable: true },
    cognitiveLevel: {
      type: Type.STRING,
      description: 'One of: recognition, understanding, application, unspecified',
    },
    questionText: { type: Type.STRING },
    optionA: { type: Type.STRING },
    optionB: { type: Type.STRING },
    optionC: { type: Type.STRING },
    optionD: { type: Type.STRING },
    answerKey: {
      type: Type.STRING,
      nullable: true,
      description:
        'Strictly A, B, C, or D ONLY when clearly marked or matched. Null if missing or ambiguous.',
    },
    statementA: { type: Type.STRING },
    statementB: { type: Type.STRING },
    statementC: { type: Type.STRING },
    statementD: { type: Type.STRING },
    statementAnswerA: { type: Type.BOOLEAN, nullable: true },
    statementAnswerB: { type: Type.BOOLEAN, nullable: true },
    statementAnswerC: { type: Type.BOOLEAN, nullable: true },
    statementAnswerD: { type: Type.BOOLEAN, nullable: true },
    rubric: { type: Type.STRING },
    sampleAnswer: { type: Type.STRING },
    explanation: { type: Type.STRING },
    answerStatus: {
      type: Type.STRING,
      description: 'Strictly: verified, missing, or ambiguous',
    },
    answerSource: {
      type: Type.STRING,
      description:
        'Vietnamese description of where answer was found (e.g. In đậm phương án B, Tô màu chữ, Bảng đáp án cuối file, Đối chiếu file đáp án riêng).',
    },
    answerNote: {
      type: Type.STRING,
      description: 'Short Vietnamese note explaining why verified, missing, or ambiguous.',
    },
  },
  required: ['questionType', 'questionNumber', 'questionText', 'answerStatus', 'answerNote'],
}

/* ============================================================================
 * STEP 1: FILE ROLE CLASSIFICATION HEURISTICS (PRE-SCREENING FOR AI AGENT)
 * ========================================================================== */

function stripDiacriticsLower(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
}

export interface AgentInputFile {
  fileId: string
  fileName: string
  fileFormat: SourceFileFormat
  buffer: Buffer
  fileSizeBytes?: number
  libraryDocumentId: string | null
  assignedRole?: AgentFileRole
}

export async function classifyFileForAgent(file: AgentInputFile): Promise<{
  report: AgentUploadedFileReport
  plainText: string
}> {
  const fileHash = sha256Hex(file.buffer)
  const fileSizeBytes = file.fileSizeBytes ?? file.buffer.length
  const normalizedName = stripDiacriticsLower(file.fileName.normalize('NFC'))

  let pageCount: number | null = null
  let plainText = ''
  let tableCount = 0
  const combinedLines: string[] = []

  try {
    const structured = await extractStructuredDocumentContent(file.buffer, file.fileFormat)
    pageCount = structured.pageCount
    tableCount = structured.blocks.filter((b) => b.kind === 'table').length
    for (const blk of structured.blocks) {
      if (blk.kind === 'paragraph') {
        if (blk.line.text.trim()) combinedLines.push(blk.line.text.trim())
      } else {
        for (const row of blk.rows) {
          for (const cell of row) {
            for (const cl of cell.lines) {
              if (cl.text.trim()) combinedLines.push(cl.text.trim())
            }
          }
          const joinedRow = row.map((c) => c.plain.trim()).filter(Boolean).join(' ')
          if (joinedRow) combinedLines.push(joinedRow)
        }
      }
    }
    if (combinedLines.length === 0) {
      for (const l of structured.lines) {
        if (l.text.trim()) combinedLines.push(l.text.trim())
      }
    }
    plainText = combinedLines.join('\n')
  } catch (err) {
    const step: ImportStepCode =
      err instanceof DocumentParserError ? err.step : 'read_file'
    const msg =
      err instanceof Error ? err.message : 'Không thể đọc cấu trúc tệp tài liệu.'
    return {
      plainText: '',
      report: {
        fileId: file.fileId,
        fileName: file.fileName.normalize('NFC'),
        fileFormat: file.fileFormat,
        fileHash,
        fileSizeBytes,
        libraryDocumentId: file.libraryDocumentId,
        detectedRole: file.assignedRole ?? 'question_file',
        assignedRole: file.assignedRole ?? 'question_file',
        roleConfidence: 0,
        roleReason: `Lỗi đọc tệp: ${msg}`,
        status: 'error',
        pageCount: null,
        extractedCount: 0,
        matchedAnswerCount: 0,
        errorStep: step,
        errorMessage: msg,
      },
    }
  }

  let questionLineCount = 0
  let optionLineCount = 0
  let tfLineCount = 0
  let compactKeyLines = 0
  let lessonHeadingCount = 0
  let explanationLineCount = 0

  for (const line of combinedLines) {
    if (/^(?:Câu|Cau|Question)\s+\d+/i.test(line)) questionLineCount += 1
    if (/^[ABCD]\s*[.)]\s+\S/i.test(line)) optionLineCount += 1
    if (/^[abcd]\s*[.)]\s+\S/.test(line)) tfLineCount += 1
    if (/^(?:Giải\s+thích|Hướng\s+dẫn|Lời\s+giải|Vì)\s*[:\-]/i.test(line)) {
      explanationLineCount += 1
    }
    if (
      /^(?:(?:Câu|Cau)\s*)?\d{1,3}(?:\s*\[[^\]]+\])?\s*[:.)\-]?\s+(?:(?:Đáp\s+án|Dap\s+an|Key|Chọn)\s*[:\-]?\s*)?[ABCD](?:\s|$|[.,;(])/i.test(
        line
      ) ||
      /^(?:(?:Câu|Cau)\s*)?\d{1,3}(?:\s*\[[^\]]+\])?\s*[:.)\-]?\s+(?:(?:Ý\s*)?[abcd]\s*[:.)\-]?\s*(?:Đúng|Sai|Đ|S))/i.test(
        line
      ) ||
      /^(?:Câu\s*)?\d{1,3}\s+(?:Đúng|Sai|Đ|S)\s+(?:Đúng|Sai|Đ|S)/i.test(line) ||
      /(?:\b\d{1,3}\s*[:.)\-]?\s*[ABCD]\b[\s,;|]+){2,}/i.test(line)
    ) {
      compactKeyLines += 1
    }
    if (extractLessonKey(line)) lessonHeadingCount += 1
  }

  const normalizedHead = stripDiacriticsLower(plainText.slice(0, 2000))
  const nameLooksSolutionGuide =
    /(?:huong[\s_.-]*dan[\s_.-]*giai|loi[\s_.-]*giai|giai[\s_.-]*chi[\s_.-]*tiet|bieu[\s_.-]*diem|cham[\s_.-]*chi[\s_.-]*tiet)/i.test(
      normalizedName
    )
  const textLooksSolutionGuide =
    /(?:huong\s+dan\s+giai|loi\s+giai\s+chi\s+tiet|giai\s+thich\s+chi\s+tiet|bieu\s+diem)/i.test(
      normalizedHead
    ) || explanationLineCount >= 4

  const nameLooksAnswer =
    /(?:dap[\s_.-]*an|answer[\s_.-]*key|huong[\s_.-]*dan[\s_.-]*cham|hd[\s_.-]*cham|\bkey\b)/i.test(
      normalizedName
    )
  const nameLooksComposite =
    /(?:giao[\s_.-]*trinh|de[\s_.-]*cuong|on[\s_.-]*tap|ly[\s_.-]*thuyet|bai[\s_.-]*giang|tom[\s_.-]*tat|tai[\s_.-]*lieu)/i.test(
      normalizedName
    )
  const nameLooksQuestion =
    /(?:cau[\s_.-]*hoi|ngan[\s_.-]*hang|\bde[\s_.-]*(?:thi|kiem[\s_.-]*tra|on)\b|trac[\s_.-]*nghiem)/i.test(
      normalizedName
    )
  const nameLooksIrrelevant =
    /(?:thoi[\s_.-]*khoa[\s_.-]*bieu|tkb|danh[\s_.-]*sach[\s_.-]*lop|bien[\s_.-]*ban|diem[\s_.-]*danh|lich[\s_.-]*thi|lich[\s_.-]*coi[\s_.-]*thi|ke[\s_.-]*hoach[\s_.-]*nam|cong[\s_.-]*van)/i.test(
      normalizedName
    )
  const textLooksIrrelevant =
    questionLineCount === 0 &&
    compactKeyLines === 0 &&
    optionLineCount === 0 &&
    tfLineCount === 0 &&
    /(?:thoi\s+khoa\s+bieu|danh\s+sach\s+hoc\s+sinh|bien\s+ban\s+hop|bang\s+diem\s+danh|lich\s+phan\s+cong\s+coi\s+thi)/i.test(
      normalizedHead
    )

  let detectedRole: AgentFileRole = 'question_file'
  let roleConfidence = 82
  let roleReason = ''

  const answerLineDominates =
    questionLineCount > 0 && compactKeyLines >= Math.max(2, Math.floor(questionLineCount * 0.45))

  const hasFormalQuestions =
    questionLineCount >= 2 &&
    !answerLineDominates &&
    (optionLineCount >= 2 || tfLineCount >= 2 || (!nameLooksAnswer && !nameLooksSolutionGuide && questionLineCount >= 4))

  const hasStrongAnswerSignals =
    compactKeyLines >= 3 ||
    answerLineDominates ||
    (nameLooksAnswer && optionLineCount < 4 && tfLineCount < 4) ||
    (/(?:BẢNG\s+ĐÁP\s+ÁN|ĐÁP\s+ÁN\s+(?:CHI\s+TIẾT|THAM\s+KHẢO|CHÍNH\s+THỨC))/i.test(
      plainText.slice(0, 2000)
    ) &&
      optionLineCount < 4 &&
      tfLineCount < 4)

  if ((nameLooksIrrelevant && questionLineCount === 0 && compactKeyLines === 0) || textLooksIrrelevant) {
    detectedRole = 'irrelevant_file'
    roleConfidence = 91
    roleReason =
      'Tài liệu hành chính / biểu mẫu không chứa câu hỏi hay đáp án Tin học; tự động bỏ qua.'
  } else if (
    !hasFormalQuestions &&
    (nameLooksSolutionGuide || (textLooksSolutionGuide && (compactKeyLines >= 2 || explanationLineCount >= 3)))
  ) {
    detectedRole = 'solution_guide'
    roleConfidence = nameLooksSolutionGuide ? 93 : 86
    roleReason = `Phát hiện tài liệu Hướng dẫn giải / Lời giải chi tiết (${compactKeyLines} khóa đáp án, ${explanationLineCount} đoạn giải thích).`
  } else if (hasFormalQuestions && !nameLooksAnswer && !nameLooksSolutionGuide) {
    detectedRole = 'question_file'
    roleConfidence = Math.min(97, 84 + Math.min(13, Math.floor(questionLineCount / 5)))
    roleReason = `Phát hiện ~${questionLineCount} đầu mục câu hỏi cùng ${optionLineCount} phương án A/B/C/D và ${tfLineCount} mệnh đề a/b/c/d.`
  } else if (hasStrongAnswerSignals && !hasFormalQuestions) {
    detectedRole = 'answer_file'
    roleConfidence = nameLooksAnswer ? 95 : 89
    roleReason = nameLooksAnswer
      ? `Tên file và cấu trúc bảng/danh sách (${compactKeyLines} dòng đáp án, ${tableCount} bảng) phù hợp File đáp án riêng.`
      : `Phát hiện ${compactKeyLines} dòng khóa đáp án / ${tableCount} bảng đáp án và không chứa phương án A/B/C/D.`
  } else if (
    (nameLooksComposite || (lessonHeadingCount >= 1 && optionLineCount < 4 && tfLineCount < 4)) &&
    plainText.trim().length >= 200
  ) {
    detectedRole = 'composite_file'
    roleConfidence = nameLooksComposite ? 90 : 80
    roleReason = `Nội dung văn bản liền mạch (${plainText.trim().length} ký tự, ${lessonHeadingCount} tiêu đề bài học) phù hợp Tài liệu tổng hợp.`
  } else if (questionLineCount >= 1 && (optionLineCount >= 2 || tfLineCount >= 2)) {
    detectedRole = 'question_file'
    roleConfidence = 78
    roleReason = `Có dấu hiệu câu hỏi (${questionLineCount} câu) và phương án/mệnh đề.`
  } else if (nameLooksQuestion) {
    detectedRole = 'question_file'
    roleConfidence = 72
    roleReason = 'Phân loại theo tên tài liệu câu hỏi / đề kiểm tra.'
  } else if (plainText.trim().length >= 120) {
    detectedRole = file.fileFormat === 'pdf' ? 'question_file' : 'composite_file'
    roleConfidence = 68
    roleReason =
      file.fileFormat === 'pdf'
        ? 'Tệp PDF chưa có dấu hiệu câu hỏi rõ trên lớp text; mặc định xử lý như File câu hỏi / quét AI.'
        : 'Tài liệu dạng văn bản thuyết minh hoặc tham khảo.'
  } else if (plainText.trim().length < 60 && tableCount === 0) {
    detectedRole = 'irrelevant_file'
    roleConfidence = 75
    roleReason = 'Tệp rỗng hoặc quá ngắn (< 60 ký tự), không đủ dữ liệu trích xuất.'
  } else {
    detectedRole = 'reference_file'
    roleConfidence = 60
    roleReason = 'Tài liệu ngắn hoặc ít cấu trúc câu hỏi.'
  }

  const assignedRole = file.assignedRole ?? detectedRole
  return {
    plainText,
    report: {
      fileId: file.fileId,
      fileName: file.fileName.normalize('NFC'),
      fileFormat: file.fileFormat,
      fileHash,
      fileSizeBytes,
      libraryDocumentId: file.libraryDocumentId,
      detectedRole,
      assignedRole,
      roleConfidence,
      roleReason,
      status: 'queued',
      pageCount,
      extractedCount: 0,
      matchedAnswerCount: 0,
      errorStep: null,
      errorMessage: null,
    },
  }
}

function tokenizeFileForPairing(fileName: string): string[] {
  const norm = stripDiacriticsLower(fileName.normalize('NFC'))
    .replace(/\.(docx|pdf|txt)$/i, '')
    .replace(/\b(cau\s*hoi|dap\s*an|huong\s*dan\s*giai|loi\s*giai|giai\s*chi\s*tiet|ngan\s*hang|de\s*thi|v\d+|final|ban\s*chuan)\b/g, ' ')
  return norm
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
}

function pairAgentFiles(
  agentFiles: AgentUploadedFileReport[],
  plainTexts: string[]
): AgentPairedSet[] {
  const qReports = agentFiles
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => r.status !== 'error' && r.assignedRole === 'question_file')
  const aReports = agentFiles
    .map((r, idx) => ({ r, idx }))
    .filter(
      ({ r }) =>
        r.status !== 'error' &&
        (r.assignedRole === 'answer_file' || r.assignedRole === 'solution_guide')
    )

  if (qReports.length === 0 || aReports.length === 0) return []

  const pairs: AgentPairedSet[] = []
  for (const qItem of qReports) {
    const qTokens = new Set(tokenizeFileForPairing(qItem.r.fileName))
    const qLessonNums = new Set(
      (plainTexts[qItem.idx] || '')
        .split('\n')
        .map((l) => extractLessonKey(l))
        .filter((k): k is string => Boolean(k))
    )

    const scoredAnswers: Array<{
      aName: string
      role: AgentFileRole
      score: number
      reason: string
    }> = []

    for (const aItem of aReports) {
      const aTokens = tokenizeFileForPairing(aItem.r.fileName)
      const sharedNameTokens = aTokens.filter((t) => qTokens.has(t))
      const aLessonNums = new Set(
        (plainTexts[aItem.idx] || '')
          .split('\n')
          .map((l) => extractLessonKey(l))
          .filter((k): k is string => Boolean(k))
      )
      let sharedLessons = 0
      for (const lk of qLessonNums) {
        if (aLessonNums.has(lk)) sharedLessons += 1
      }

      const nameScore = Math.min(45, sharedNameTokens.length * 18)
      const lessonScore =
        qLessonNums.size > 0 && aLessonNums.size > 0
          ? Math.round((sharedLessons / Math.max(1, qLessonNums.size)) * 55)
          : aReports.length === 1
          ? 40
          : 15
      const score = Math.min(99, Math.max(30, nameScore + lessonScore))

      const reasons: string[] = []
      if (sharedLessons > 0) reasons.push(`trùng ${sharedLessons} bài học`)
      if (sharedNameTokens.length > 0) reasons.push(`trùng mã/từ khóa tên file (${sharedNameTokens.join(', ')})`)
      if (reasons.length === 0 && aReports.length === 1) reasons.push('bộ tài liệu có 1 cặp đề – đáp án')

      scoredAnswers.push({
        aName: aItem.r.fileName,
        role: aItem.r.assignedRole,
        score,
        reason: reasons.length > 0 ? `Ghép cặp theo ${reasons.join(' & ')}` : 'Ghép cùng đợt tải lên',
      })
    }

    scoredAnswers.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.role === 'answer_file' && b.role !== 'answer_file') return -1
      if (b.role === 'answer_file' && a.role !== 'answer_file') return 1
      return 0
    })

    if (scoredAnswers.length > 0) {
      const topScore = scoredAnswers[0].score
      const chosen = scoredAnswers.filter(
        (item, idx) => idx === 0 || item.score >= Math.max(45, topScore - 30)
      )
      pairs.push({
        questionFile: qItem.r.fileName,
        answerFiles: chosen.map((c) => c.aName),
        matchBasis: `${chosen[0].reason} (${chosen[0].score}%)`,
      })
    }
  }
  return pairs
}

/* ============================================================================
 * EXISTING SINGLE-FILE & COMPOSITE FUNCTIONS (PRESERVED & HARDENED)
 * ========================================================================== */

export async function extractQuestionsWithGemini(params: {
  buffer: Buffer
  fileName: string
  fileFormat: SourceFileFormat
  answerProvisionMode: AnswerProvisionMode
  preferredTypes?: QuestionType[]
  separateAnswerFile?: {
    buffer: Buffer
    fileName: string
    fileFormat: SourceFileFormat
  } | null
  bankName?: string
  onProgress?: ExtractionProgressCallback
}): Promise<{
  fileName: string
  fileFormat: SourceFileFormat
  fileHash: string
  pageCount: number | null
  parserEngine: 'gemini_hybrid' | 'deterministic'
  questions: ExtractedQuestion[]
  warnings: string[]
}> {
  const fileHash = sha256Hex(params.buffer)
  const preferredTypes =
    params.preferredTypes && params.preferredTypes.length > 0
      ? params.preferredTypes
      : (['multiple_choice', 'true_false', 'essay'] as QuestionType[])

  params.onProgress?.({
    step: 'parse_docx',
    stepLabel:
      params.fileFormat === 'docx'
        ? 'Đang giải mã cấu trúc XML, bảng Word và định dạng DOCX...'
        : params.fileFormat === 'pdf'
        ? 'Đang trích xuất văn bản và bố cục từng trang PDF...'
        : 'Đang đọc nội dung tệp văn bản...',
    progress: 22,
  })

  const [deterministic, richDoc, separateRich, separateParsed] = await Promise.all([
    parseQuestionBankDocument(params.buffer, params.fileName, params.fileFormat, {
      answerProvisionMode: params.answerProvisionMode,
      separateAnswerFile: params.separateAnswerFile ?? null,
    }),
    extractDocumentRichText(params.buffer, params.fileFormat),
    params.separateAnswerFile
      ? extractDocumentRichText(
          params.separateAnswerFile.buffer,
          params.separateAnswerFile.fileFormat
        )
      : Promise.resolve(null),
    params.separateAnswerFile
      ? parseSeparateAnswerKeyDocument(
          params.separateAnswerFile.buffer,
          params.separateAnswerFile.fileFormat
        )
      : Promise.resolve(null),
  ])

  const warnings = [...deterministic.warnings]
  const ai = getGeminiClient()

  params.onProgress?.({
    step: 'extract_structure',
    stepLabel:
      deterministic.questions.length > 0
        ? `Đã nhận diện ${deterministic.questions.length} câu hỏi theo cấu trúc Chủ đề / Bài / Loại...`
        : 'Đang phân tích cấu trúc câu hỏi trong tài liệu...',
    progress: 42,
  })

  if (!ai) {
    if (deterministic.questions.length === 0) {
      throw new AiExtractionError(
        'extract_structure',
        'NO_QUESTIONS_FOUND',
        'Không tìm thấy cấu trúc câu hỏi (Câu X / phương án A, B, C, D / bảng Đúng-Sai / Tự luận) trong tài liệu và GEMINI_API_KEY chưa được cấu hình.',
        422
      )
    }

    params.onProgress?.({
      step: 'match_answers',
      stepLabel: `Đã đối chiếu đáp án cho ${deterministic.questions.filter((q) => q.answerStatus === 'verified').length}/${deterministic.questions.length} câu hỏi...`,
      progress: 85,
    })

    warnings.push(
      'GEMINI_API_KEY chưa được cấu hình trên máy chủ (Settings > Secrets) nên hệ thống sử dụng bộ tách cấu trúc nội bộ.'
    )
    return {
      fileName: params.fileName,
      fileFormat: params.fileFormat,
      fileHash,
      pageCount: deterministic.pageCount,
      parserEngine: 'deterministic',
      questions: deterministic.questions.map((q) => ({
        ...q,
        bankName: (params.bankName ?? '').trim().slice(0, 120),
        questionOrigin: 'extracted',
      })),
      warnings,
    }
  }

  // Fast & faithful path for structured DOCX/TXT: preserve verbatim wording
  const deterministicList = deterministic.questions
  const verifiedDetCount = deterministicList.filter((q) => q.answerStatus === 'verified').length
  const unmatchedDet = deterministicList.filter((q) => q.answerStatus !== 'verified')

  if (
    (params.fileFormat === 'docx' || params.fileFormat === 'txt') &&
    deterministicList.length >= 1 &&
    verifiedDetCount >= deterministicList.length * 0.6
  ) {
    const finalQuestions = deterministicList.map((q) => ({
      ...q,
      bankName: (params.bankName ?? '').trim().slice(0, 120),
      questionOrigin: 'extracted' as const,
    }))

    if (
      unmatchedDet.length > 0 &&
      (params.answerProvisionMode === 'separate_answer_file' ||
        /ĐÁP\s+ÁN|HƯỚNG\s+DẪN|Giải\s+thích|\[IN_ĐẬM\]|\[TÔ_NỀN\]|\[MÀU_CHỮ/i.test(
          richDoc.richAnnotatedText
        ))
    ) {
      params.onProgress?.({
        step: 'ai_extract',
        stepLabel: `Đang nhờ Gemini AI rà soát bổ sung ${unmatchedDet.length} câu chưa rõ đáp án...`,
        progress: 65,
      })

      try {
        const refAnswerText =
          params.answerProvisionMode === 'separate_answer_file' && separateRich
            ? separateRich.plainText.slice(0, 35000)
            : extractAnswerSectionTailForAi(richDoc.richAnnotatedText) ||
              richDoc.richAnnotatedText.slice(-30000)

        if (refAnswerText.trim().length > 20) {
          const batchSize = 30
          const batches: ExtractedQuestion[][] = []
          for (let i = 0; i < unmatchedDet.length; i += batchSize) {
            batches.push(unmatchedDet.slice(i, i + batchSize))
          }

          await runWithConcurrency(batches, GEMINI_CONCURRENCY, async (batch) => {
            const batchPayload = batch.map((q) => ({
              tempId: q.tempId,
              lessonTitle: q.lessonTitle,
              questionType: q.questionType,
              questionNumber: q.questionNumber,
              questionText: q.questionText.slice(0, 300),
            }))

            const enrichPrompt = [
              'Bạn là hệ thống đối chiếu đáp án chính xác cho TIN LAB.',
              'Dưới đây là danh sách các câu hỏi CHƯA XÁC ĐỊNH ĐƯỢC ĐÁP ÁN trong tài liệu.',
              'Hãy đối chiếu theo đúng phân cấp Bài học (lessonTitle) + Loại câu + Số câu với phần đáp án tham chiếu bên dưới.',
              'NGUYÊN TẮC: TUYỆT ĐỐI KHÔNG ĐƯỢC ĐOÁN ĐÁP ÁN nếu không thấy trong phần đáp án tham chiếu. Chỉ điền khi có căn cứ rõ ràng, giữ null nếu vẫn thiếu.',
              '',
              'Danh sách câu cần đối chiếu:',
              JSON.stringify(batchPayload),
              '',
              refAnswerText,
            ].join('\n')

            const resp = await ai.models.generateContent({
              model: GEMINI_MODEL,
              contents: enrichPrompt,
              config: {
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    matches: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          tempId: { type: Type.STRING },
                          answerKey: { type: Type.STRING, nullable: true },
                          statementAnswerA: { type: Type.BOOLEAN, nullable: true },
                          statementAnswerB: { type: Type.BOOLEAN, nullable: true },
                          statementAnswerC: { type: Type.BOOLEAN, nullable: true },
                          statementAnswerD: { type: Type.BOOLEAN, nullable: true },
                          rubric: { type: Type.STRING },
                          explanation: { type: Type.STRING },
                          answerSource: { type: Type.STRING },
                          confidenceScore: { type: Type.INTEGER },
                          reasoning: { type: Type.STRING },
                        },
                        required: ['tempId'],
                      },
                    },
                  },
                  required: ['matches'],
                },
              },
            })

            const raw = resp.text?.trim()
            if (!raw) return
            const parsed = JSON.parse(stripJsonMarkdownFence(raw)) as {
              matches?: Array<{
                tempId?: string
                answerKey?: string | null
                statementAnswerA?: boolean | null
                statementAnswerB?: boolean | null
                statementAnswerC?: boolean | null
                statementAnswerD?: boolean | null
                rubric?: string
                explanation?: string
                answerSource?: string
                confidenceScore?: number
                reasoning?: string
              }>
            }

            const byId = new Map(finalQuestions.map((q) => [q.tempId, q]))
            for (const m of parsed.matches ?? []) {
              const target = m.tempId ? byId.get(m.tempId) : undefined
              if (!target || target.answerStatus === 'verified') continue

              const conf = Number.isFinite(Number(m.confidenceScore))
                ? Math.max(0, Math.min(100, Math.round(Number(m.confidenceScore))))
                : 82

              if (target.questionType === 'multiple_choice') {
                const key = normalizeMcqKey(m.answerKey)
                if (key) {
                  if (conf >= 50) {
                    const isProposed = conf >= 80
                    target.answerStatus = isProposed ? 'ai_proposed' : 'needs_review'
                    target.confidenceScore = conf
                    target.confidenceLevel = confidenceLevelFromScore(conf)
                    target.matchMethod = 'ai_semantic_match'
                    target.answerSource = isProposed
                      ? `AI đề xuất chưa xác nhận (${conf}%)`
                      : `Đề xuất AI độ tin cậy trung bình (${conf}%)`
                    target.answerNote = isProposed
                      ? `AI đề xuất đáp án ${key} (${conf}% tin cậy) — cần Super Admin xác nhận.`
                      : `AI đề xuất đáp án ${key} (${conf}% tin cậy) — cần Super Admin kiểm tra.`
                    target.aiSuggestion = {
                      suggestedAnswerKey: key,
                      suggestedStatementA: null,
                      suggestedStatementB: null,
                      suggestedStatementC: null,
                      suggestedStatementD: null,
                      suggestedRubric: '',
                      suggestedExplanation: m.explanation?.trim() ?? '',
                      confidenceScore: conf,
                      confidenceLevel: confidenceLevelFromScore(conf),
                      matchMethod: 'ai_semantic_match',
                      reasoning: m.reasoning?.trim() || 'Đối chiếu ngữ nghĩa từ tài liệu nguồn.',
                      sourceFileName: target.sourceDocumentName,
                      applied: false,
                    }
                  }
                  if (m.explanation?.trim() && !target.explanation) {
                    target.explanation = m.explanation.trim().slice(0, 3000)
                  }
                }
              } else if (target.questionType === 'true_false') {
                const sa = normalizeBoolOrNull(m.statementAnswerA)
                const sb = normalizeBoolOrNull(m.statementAnswerB)
                const sc = normalizeBoolOrNull(m.statementAnswerC)
                const sd = normalizeBoolOrNull(m.statementAnswerD)
                if (sa !== null && sb !== null && sc !== null && sd !== null) {
                  if (conf >= 50) {
                    const isProposed = conf >= 80
                    target.answerStatus = isProposed ? 'ai_proposed' : 'needs_review'
                    target.confidenceScore = conf
                    target.confidenceLevel = confidenceLevelFromScore(conf)
                    target.matchMethod = 'ai_semantic_match'
                    target.answerSource = isProposed
                      ? `AI đề xuất Đúng/Sai chưa xác nhận (${conf}%)`
                      : `Đề xuất AI Đúng/Sai (${conf}%)`
                    target.answerNote = `AI đề xuất 4 đáp án Đúng/Sai (${conf}% tin cậy) — chờ Super Admin xác nhận.`
                    target.aiSuggestion = {
                      suggestedAnswerKey: null,
                      suggestedStatementA: sa,
                      suggestedStatementB: sb,
                      suggestedStatementC: sc,
                      suggestedStatementD: sd,
                      suggestedRubric: '',
                      suggestedExplanation: m.explanation?.trim() ?? '',
                      confidenceScore: conf,
                      confidenceLevel: confidenceLevelFromScore(conf),
                      matchMethod: 'ai_semantic_match',
                      reasoning: m.reasoning?.trim() || 'Đối chiếu ngữ nghĩa Đúng/Sai.',
                      sourceFileName: target.sourceDocumentName,
                      applied: false,
                    }
                  }
                  if (m.explanation?.trim() && !target.explanation) {
                    target.explanation = m.explanation.trim().slice(0, 3000)
                  }
                }
              } else if (target.questionType === 'essay' && m.rubric && m.rubric.trim().length >= 5) {
                const rubText = m.rubric.trim().slice(0, 4000)
                const isProposed = conf >= 80
                target.answerStatus = isProposed ? 'ai_proposed' : 'needs_review'
                target.answerSource = `AI đề xuất Rubric (${conf}%)`
                target.answerNote = 'AI đề xuất Rubric tự luận — chờ Super Admin xác nhận.'
                target.confidenceScore = conf
                target.confidenceLevel = confidenceLevelFromScore(conf)
                target.matchMethod = 'ai_semantic_match'
                target.aiSuggestion = {
                  suggestedAnswerKey: null,
                  suggestedStatementA: null,
                  suggestedStatementB: null,
                  suggestedStatementC: null,
                  suggestedStatementD: null,
                  suggestedRubric: rubText,
                  suggestedExplanation: m.explanation?.trim() ?? '',
                  confidenceScore: conf,
                  confidenceLevel: confidenceLevelFromScore(conf),
                  matchMethod: 'ai_semantic_match',
                  reasoning: m.reasoning?.trim() || 'AI đề xuất biểu điểm tự luận.',
                  sourceFileName: target.sourceDocumentName,
                  applied: false,
                }
              }
            }
          })
        }
      } catch (enrichErr) {
        updateCachedGeminiStatusFromError(enrichErr)
        const classified = classifyGeminiApiError(enrichErr)
        warnings.push(
          `${classified.userMessage} Đã giữ nguyên ${verifiedDetCount} câu hỏi có đáp án từ cấu trúc DOCX.`
        )
      }
    }

    params.onProgress?.({
      step: 'match_answers',
      stepLabel: `Đã đối chiếu xong ${finalQuestions.filter((q) => q.answerStatus === 'verified').length}/${finalQuestions.length} câu hỏi theo từng Bài học...`,
      progress: 86,
    })

    return {
      fileName: params.fileName,
      fileFormat: params.fileFormat,
      fileHash,
      pageCount: deterministic.pageCount,
      parserEngine: 'gemini_hybrid',
      questions: finalQuestions,
      warnings,
    }
  }

  const typeLabelHints = preferredTypes
    .map((t) =>
      t === 'multiple_choice'
        ? 'Trắc nghiệm 4 lựa chọn (multiple_choice)'
        : t === 'true_false'
        ? 'Đúng/Sai 4 ý a,b,c,d (true_false)'
        : 'Tự luận (essay)'
    )
    .join(', ')

  const answerModeInstruction =
    params.answerProvisionMode === 'separate_answer_file' && params.separateAnswerFile
      ? [
          `CHẾ ĐỘ ĐÁP ÁN: Đáp án nằm trong FILE ĐÁP ÁN RIÊNG ("${params.separateAnswerFile.fileName}").`,
          '- Hãy đối chiếu từng câu hỏi trong file đề với file đáp án riêng theo đúng Bài học + Loại câu + Số câu.',
          '- Ghi rõ answerSource = "Đối chiếu file đáp án riêng (<tên file> · Bài X · Câu Y)".',
          '- Nếu không tìm thấy câu tương ứng trong file đáp án riêng -> đặt answerStatus = "missing" và giải thích rõ.',
          '- Nếu file đáp án riêng có 2 đáp án mâu thuẫn cho cùng 1 câu -> đặt answerStatus = "ambiguous".',
        ].join('\n')
      : [
          'CHẾ ĐỘ ĐÁP ÁN: Đáp án nằm ngay trong file câu hỏi (embedded_in_file).',
          '- Kiểm tra kỹ các thẻ định dạng đã đánh dấu từ file gốc như [IN_ĐẬM]...[/IN_ĐẬM], [TÔ_NỀN]...[/TÔ_NỀN], [MÀU_CHỮ:#...]...[/MÀU_CHỮ], [GẠCH_CHÂN]...[/GẠCH_CHÂN], ký hiệu dấu sao (*), bảng Đúng/Sai, đáp án ở cuối mỗi bài hoặc Phần C cuối tài liệu.',
          '- Lưu ý: nếu số câu (ví dụ Câu 1..25) lặp lại ở mỗi Bài học, bắt buộc phải ghép đúng theo Bài học tương ứng, tuyệt đối không ghép nhầm từ bài khác.',
          '- Ghi rõ dấu hiệu tìm thấy vào answerSource.',
        ].join('\n')

  const baseInstructions = [
    'Bạn là hệ thống trích xuất câu hỏi khảo thí chuyên nghiệp cho TIN LAB.',
    'NHIỆM VỤ: Trích xuất TOÀN BỘ câu hỏi có trong đoạn tài liệu bên dưới mà KHÔNG GIỚI HẠN SỐ LƯỢNG.',
    `Dạng câu hỏi ưu tiên / dự kiến có trong tài liệu: ${typeLabelHints}. Nếu tài liệu có thêm dạng khác trong 3 dạng chuẩn (multiple_choice, true_false, essay), hãy phân loại đúng.`,
    'NGUYÊN TẮC BẮT BUỘC:',
    '1. Giữ nguyên văn gốc câu hỏi và các phương án / mệnh đề (không tự ý viết lại đề). Loại bỏ các thẻ đánh dấu định dạng nội bộ ([IN_ĐẬM], [MÀU_CHỮ:...], [TÔ_NỀN], [GẠCH_CHÂN]) khỏi text đầu ra.',
    '2. TUYỆT ĐỐI KHÔNG TỰ ĐOÁN ĐÁP ÁN bằng kiến thức riêng khi tài liệu không đánh dấu/không có đáp án. Nếu không có đáp án rõ ràng, bắt buộc đặt answerKey = null (hoặc statementAnswer = null), answerStatus = "missing".',
    '3. Nếu có nhiều đáp án xung đột hoặc dấu hiệu mơ hồ, đặt answerStatus = "ambiguous", answerKey = null.',
    '4. Nhận diện lessonTitle, topic, questionCode và cognitiveLevel: recognition (Nhận biết), understanding (Thông hiểu), application (Vận dụng), hoặc unspecified.',
    answerModeInstruction,
  ].join('\n')

  try {
    const aiExtractedAll: ExtractedQuestion[] = []
    const canUseSinglePdfMultimodal =
      params.fileFormat === 'pdf' &&
      params.buffer.length <= MAX_INLINE_PDF_BYTES &&
      richDoc.plainText.length <= CHUNK_CHAR_LIMIT

    const separateAnswerTextSnippet = separateRich
      ? `\n\n=== NỘI DUNG FILE ĐÁP ÁN RIÊNG (${params.separateAnswerFile?.fileName}) ===\n${separateRich.plainText.slice(
          0,
          35000
        )}`
      : ''

    params.onProgress?.({
      step: 'ai_extract',
      stepLabel: 'Đang gọi Gemini AI phân tích nội dung tài liệu...',
      progress: 55,
    })

    if (canUseSinglePdfMultimodal) {
      const parts: Array<
        { text: string } | { inlineData: { mimeType: string; data: string } }
      > = [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: params.buffer.toString('base64'),
          },
        },
      ]

      if (
        params.answerProvisionMode === 'separate_answer_file' &&
        params.separateAnswerFile?.fileFormat === 'pdf' &&
        params.separateAnswerFile.buffer.length <= MAX_INLINE_PDF_BYTES
      ) {
        parts.push({
          inlineData: {
            mimeType: 'application/pdf',
            data: params.separateAnswerFile.buffer.toString('base64'),
          },
        })
      }

      parts.push({
        text: `${baseInstructions}\n\n(Đính kèm file PDF gốc để bạn quan sát trực tiếp chữ in đậm, tô màu, tô nền, gạch chân, bảng đáp án. Dưới đây là văn bản hỗ trợ số trang):\n${richDoc.richAnnotatedText.slice(
          0,
          24000
        )}${separateAnswerTextSnippet}`,
      })

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts }],
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              questions: {
                type: Type.ARRAY,
                items: EXTRACTED_QUESTION_SCHEMA,
              },
            },
            required: ['questions'],
          },
        },
      })

      const rawJson = response.text?.trim()
      if (rawJson) {
        const parsedJson = JSON.parse(stripJsonMarkdownFence(rawJson)) as {
          questions?: RawGeminiQuestionItem[]
        }
        const list = Array.isArray(parsedJson.questions) ? parsedJson.questions : []
        list.forEach((rawItem, idx) => {
          const built = buildExtractedQuestionFromRaw(rawItem, idx, {
            fileName: params.fileName,
            fileFormat: params.fileFormat,
            fileHash,
            questionOrigin: 'extracted',
            bankName: params.bankName,
          })
          if (built) aiExtractedAll.push(built)
        })
      }
    } else {
      const sourceText = richDoc.richAnnotatedText || richDoc.plainText || ''
      const chunks = splitTextIntoQuestionSafeChunks(sourceText, CHUNK_CHAR_LIMIT)
      const embeddedAnswerTail =
        params.answerProvisionMode === 'embedded_in_file' && chunks.length > 1
          ? extractAnswerSectionTailForAi(sourceText)
          : ''

      let completedChunks = 0
      const chunkLists = await runWithConcurrency(chunks, GEMINI_CONCURRENCY, async (chunkText, cIdx) => {
        const prompt = [
          baseInstructions,
          chunks.length > 1
            ? `(Đoạn ${cIdx + 1}/${chunks.length} của tài liệu "${params.fileName}")`
            : `(Toàn bộ nội dung tài liệu "${params.fileName}")`,
          '',
          '=== NỘI DUNG TÀI LIỆU CẦN TRÍCH XUẤT ===',
          chunkText,
          cIdx < chunks.length - 1 ? embeddedAnswerTail : '',
          separateAnswerTextSnippet,
        ]
          .filter(Boolean)
          .join('\n')

        const response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: prompt,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                questions: {
                  type: Type.ARRAY,
                  items: EXTRACTED_QUESTION_SCHEMA,
                },
              },
              required: ['questions'],
            },
          },
        })

        completedChunks += 1
        const pct = Math.min(82, 52 + Math.round((completedChunks / Math.max(1, chunks.length)) * 30))
        params.onProgress?.({
          step: 'ai_extract',
          stepLabel: `Gemini AI đã xử lý đoạn ${completedChunks}/${chunks.length}...`,
          progress: pct,
        })

        const rawJson = response.text?.trim()
        if (!rawJson) return [] as ExtractedQuestion[]
        const parsedJson = JSON.parse(stripJsonMarkdownFence(rawJson)) as {
          questions?: RawGeminiQuestionItem[]
        }
        const list = Array.isArray(parsedJson.questions) ? parsedJson.questions : []
        const builtItems: ExtractedQuestion[] = []
        for (const rawItem of list) {
          const built = buildExtractedQuestionFromRaw(rawItem, builtItems.length, {
            fileName: params.fileName,
            fileFormat: params.fileFormat,
            fileHash,
            questionOrigin: 'extracted',
            bankName: params.bankName,
          })
          if (built) builtItems.push(built)
        }
        return builtItems
      })

      for (const chunkItems of chunkLists) {
        for (const item of chunkItems) {
          aiExtractedAll.push({
            ...item,
            tempId: `q-${aiExtractedAll.length + 1}-${item.contentHash.slice(0, 8)}`,
          })
        }
      }
    }

    params.onProgress?.({
      step: 'match_answers',
      stepLabel: 'Đang đối chiếu đáp án và kiểm tra chống trùng lặp...',
      progress: 86,
    })

    if (aiExtractedAll.length === 0) {
      if (deterministic.questions.length > 0) {
        warnings.push(
          'AI không trả về danh sách câu hỏi mới; đã giữ nguyên kết quả trích xuất từ bộ tách cấu trúc.'
        )
        return {
          fileName: params.fileName,
          fileFormat: params.fileFormat,
          fileHash,
          pageCount: deterministic.pageCount,
          parserEngine: 'deterministic',
          questions: deterministic.questions.map((q) => ({
            ...q,
            bankName: (params.bankName ?? '').trim().slice(0, 120),
            questionOrigin: 'extracted',
          })),
          warnings,
        }
      }
      throw new AiExtractionError(
        'extract_structure',
        'NO_QUESTIONS_FOUND',
        'Không tìm thấy cấu trúc câu hỏi (Câu X / A, B, C, D / bảng Đúng-Sai / Tự luận) trong tài liệu này.',
        422
      )
    }

    const detByHash = new Map<string, ExtractedQuestion>()
    for (const dq of deterministic.questions) {
      detByHash.set(dq.contentHash, dq)
    }

    const seenHashes = new Set<string>()
    const merged: ExtractedQuestion[] = aiExtractedAll.map((aiQ, idx) => {
      const detMatch = detByHash.get(aiQ.contentHash)
      let finalQ: ExtractedQuestion = { ...aiQ }

      if (detMatch) {
        if (
          finalQ.answerStatus === 'missing' &&
          detMatch.answerStatus === 'verified'
        ) {
          finalQ = {
            ...finalQ,
            questionText: detMatch.originalQuestionText || detMatch.questionText,
            originalQuestionText: detMatch.originalQuestionText || detMatch.questionText,
            answerKey: detMatch.answerKey,
            statementAnswerA: detMatch.statementAnswerA,
            statementAnswerB: detMatch.statementAnswerB,
            statementAnswerC: detMatch.statementAnswerC,
            statementAnswerD: detMatch.statementAnswerD,
            rubric: detMatch.rubric || finalQ.rubric,
            explanation: finalQ.explanation || detMatch.explanation,
            answerStatus: 'verified',
            answerSource: detMatch.answerSource || finalQ.answerSource,
            answerNote: detMatch.answerNote || finalQ.answerNote,
            confidenceScore: detMatch.confidenceScore ?? finalQ.confidenceScore,
            confidenceLevel: detMatch.confidenceLevel ?? finalQ.confidenceLevel,
            matchMethod: detMatch.matchMethod ?? finalQ.matchMethod,
          }
        } else if (detMatch.answerStatus === 'ambiguous') {
          finalQ = {
            ...finalQ,
            answerKey: null,
            answerStatus: 'ambiguous',
            answerSource: detMatch.answerSource || finalQ.answerSource,
            answerNote: detMatch.answerNote || finalQ.answerNote,
            confidenceScore: 35,
            confidenceLevel: 'low',
          }
        } else if (
          finalQ.questionType === 'multiple_choice' &&
          finalQ.answerStatus === 'verified' &&
          detMatch.answerStatus === 'verified' &&
          finalQ.answerKey &&
          detMatch.answerKey &&
          finalQ.answerKey !== detMatch.answerKey
        ) {
          finalQ = {
            ...finalQ,
            answerKey: null,
            answerStatus: 'ambiguous',
            answerSource: `${finalQ.answerSource} vs ${detMatch.answerSource}`,
            answerNote: `Xung đột giữa nhận diện AI (${aiQ.answerKey}) và dấu hiệu định dạng/bảng đáp án (${detMatch.answerKey}). Cần kiểm tra lại.`,
            confidenceScore: 35,
            confidenceLevel: 'low',
          }
        }
        if (finalQ.pageNumber === null && detMatch.pageNumber !== null) {
          finalQ.pageNumber = detMatch.pageNumber
        }
        if (!finalQ.lessonTitle && detMatch.lessonTitle) {
          finalQ.lessonTitle = detMatch.lessonTitle
        }
        if (!finalQ.questionCode && detMatch.questionCode) {
          finalQ.questionCode = detMatch.questionCode
        }
      }

      if (
        finalQ.answerStatus === 'missing' &&
        params.answerProvisionMode === 'separate_answer_file' &&
        separateParsed
      ) {
        const numMatch = finalQ.questionNumber.match(/\d+/)
        if (numMatch) {
          const numKey = String(parseInt(numMatch[0], 10))
          const lKey = extractLessonKey(finalQ.lessonTitle) ?? '__root__'
          if (finalQ.questionType === 'multiple_choice') {
            const sep = separateParsed.registry.lookupMcq(lKey, numKey, lKey !== '__root__')
            if (sep.entry && !sep.entry.ambiguous && sep.entry.keys.size === 1) {
              const foundKey = Array.from(sep.entry.keys)[0]
              finalQ.answerKey = foundKey
              finalQ.answerStatus = 'verified'
              finalQ.answerSource = `Đối chiếu file đáp án riêng (${params.separateAnswerFile?.fileName} · ${finalQ.questionNumber})`
              finalQ.answerNote = `Đã đối chiếu đáp án ${foundKey} từ file đáp án riêng.`
              finalQ.confidenceScore = 94
              finalQ.confidenceLevel = 'high'
              finalQ.matchMethod = 'lesson_and_number'
            }
          } else if (finalQ.questionType === 'essay') {
            const sepEssay = separateParsed.registry.lookupEssay(lKey, numKey, lKey !== '__root__')
            if (sepEssay && sepEssay.rubricParts.length > 0) {
              finalQ.rubric = sepEssay.rubricParts.join('\n').trim().slice(0, 4000)
              if (finalQ.rubric.length >= 5) {
                finalQ.answerStatus = 'verified'
                finalQ.answerSource = `Đối chiếu file đáp án riêng (${params.separateAnswerFile?.fileName} · ${finalQ.questionNumber})`
                finalQ.answerNote = 'Đã đối chiếu hướng dẫn chấm từ file đáp án riêng.'
                finalQ.confidenceScore = 92
                finalQ.confidenceLevel = 'high'
                finalQ.matchMethod = 'lesson_and_number'
              }
            }
          }
        }
      }

      const duplicateInFile = seenHashes.has(finalQ.contentHash)
      seenHashes.add(finalQ.contentHash)

      return {
        ...finalQ,
        tempId: `q-${idx + 1}-${finalQ.contentHash.slice(0, 8)}`,
        duplicateInFile,
      }
    })

    for (const dq of deterministic.questions) {
      if (!seenHashes.has(dq.contentHash)) {
        seenHashes.add(dq.contentHash)
        merged.push({
          ...dq,
          tempId: `q-${merged.length + 1}-${dq.contentHash.slice(0, 8)}`,
          bankName: (params.bankName ?? '').trim().slice(0, 120),
          questionOrigin: 'extracted',
          duplicateInFile: false,
        })
      }
    }

    return {
      fileName: params.fileName,
      fileFormat: params.fileFormat,
      fileHash,
      pageCount: deterministic.pageCount,
      parserEngine: 'gemini_hybrid',
      questions: merged,
      warnings: warnings.filter(
        (w) => !w.startsWith('Bộ tách cấu trúc chưa tìm thấy')
      ),
    }
  } catch (err) {
    if (err instanceof DocumentParserError || err instanceof AiExtractionError) {
      throw err
    }

    updateCachedGeminiStatusFromError(err)
    const classified = classifyGeminiApiError(err)
    console.warn(`[TIN LAB] Gemini hybrid extraction failed: ${classified.errorCode}`)

    if (deterministic.questions.length === 0) {
      throw new AiExtractionError(
        'ai_extract',
        classified.errorCode,
        classified.userMessage,
        classified.httpStatus
      )
    }

    warnings.push(
      `${classified.userMessage} Hệ thống đã trả về ${deterministic.questions.length} câu hỏi từ bộ tách cấu trúc nội bộ.`
    )
    return {
      fileName: params.fileName,
      fileFormat: params.fileFormat,
      fileHash,
      pageCount: deterministic.pageCount,
      parserEngine: 'deterministic',
      questions: deterministic.questions.map((q) => ({
        ...q,
        bankName: (params.bankName ?? '').trim().slice(0, 120),
        questionOrigin: 'extracted',
      })),
      warnings,
    }
  }
}

export async function analyzeAndGenerateWithAiAgent(params: {
  buffer: Buffer
  fileName: string
  fileFormat: SourceFileFormat
  mcqCount: number
  trueFalseCount: number
  essayCount: number
  adaptiveAutoCount?: boolean
  topicFocus?: string
  bankName?: string
  onProgress?: ExtractionProgressCallback
}): Promise<{
  fileName: string
  fileFormat: SourceFileFormat
  fileHash: string
  pageCount: number | null
  documentAnalysis: CompositeDocumentAnalysis
  questions: ExtractedQuestion[]
  warnings: string[]
}> {
  const ai = getGeminiClient()
  if (!ai) {
    throw new AiExtractionError(
      'ai_extract',
      'AI_NOT_CONFIGURED',
      'GEMINI_API_KEY chưa được cấu hình trên máy chủ (Settings > Secrets). Không thể chạy AI Agent phân tích và tạo câu hỏi từ tài liệu tổng hợp.',
      503
    )
  }

  params.onProgress?.({
    step: 'parse_docx',
    stepLabel: 'Đang đọc nội dung văn bản từ tài liệu tổng hợp...',
    progress: 25,
  })

  const fileHash = sha256Hex(params.buffer)
  const richDoc = await extractDocumentRichText(params.buffer, params.fileFormat)
  const warnings = [...richDoc.warnings]

  const cleanText = richDoc.plainText.trim()
  if (cleanText.length < 40 && !(params.fileFormat === 'pdf' && params.buffer.length > 100)) {
    throw new AiExtractionError(
      'extract_structure',
      'INSUFFICIENT_DOCUMENT_TEXT',
      'Không tìm thấy cấu trúc nội dung đủ dài để AI Agent phân tích (văn bản trống hoặc quá ngắn).',
      422
    )
  }

  params.onProgress?.({
    step: 'ai_extract',
    stepLabel: 'Gemini AI Agent đang phân tích cấu trúc bài học và biên soạn câu hỏi...',
    progress: 55,
  })

  const safeMcq = Math.max(0, Math.min(30, Math.floor(params.mcqCount)))
  const safeTf = Math.max(0, Math.min(15, Math.floor(params.trueFalseCount)))
  const safeEssay = Math.max(0, Math.min(10, Math.floor(params.essayCount)))

  const generationTargetInstruction = params.adaptiveAutoCount
    ? [
        '- Tự động xác định số lượng câu hỏi tối ưu dựa trên độ dày kiến thức của tài liệu (không gò bó phải đúng 4 câu; thường từ 8 đến 20 câu phủ đều các bài học/chủ đề phát hiện được), bao gồm cả Trắc nghiệm 4 lựa chọn (multiple_choice), Đúng/Sai 4 ý (true_false) và Tự luận (essay).',
      ].join('\n')
    : [
        `- Tạo CHÍNH XÁC số lượng câu hỏi theo yêu cầu sau (tổng ${safeMcq + safeTf + safeEssay} câu):`,
        `  + ${safeMcq} câu Trắc nghiệm 4 lựa chọn (questionType = "multiple_choice", có optionA, optionB, optionC, optionD và answerKey chính xác A/B/C/D).`,
        `  + ${safeTf} câu Đúng/Sai 4 ý (questionType = "true_false", mỗi câu có đủ 4 mệnh đề statementA, statementB, statementC, statementD và 4 giá trị boolean statementAnswerA..D).`,
        `  + ${safeEssay} câu Tự luận (questionType = "essay", có rubric chấm điểm chi tiết theo ý và sampleAnswer gợi ý).`,
      ].join('\n')

  const focusNote = params.topicFocus?.trim()
    ? `\nTrọng tâm kiến thức giáo viên yêu cầu nhấn mạnh: ${params.topicFocus.trim()}`
    : ''

  const agentPrompt = [
    'Bạn là TIN LAB AI Agent – Chuyên gia khảo thí & biên soạn đề thi Tin học THPT chuẩn GDPT 2018.',
    'NHIỆM VỤ GỒM 2 PHẦN:',
    'PHẦN 1 (documentAnalysis): Phân tích cấu trúc tài liệu học liệu tổng hợp (giáo trình, đề cương, bài giảng, tài liệu ôn tập):',
    '- Tóm tắt nội dung cốt lõi (documentSummary).',
    '- Liệt kê danh sách Chủ đề / Chương (detectedTopics) và Bài học (detectedLessons).',
    '- Phân rã thành các đơn vị kiến thức trọng tâm (knowledgeUnits: lessonTitle, topic, keyConcepts).',
    '',
    'PHẦN 2 (questions): Từ các đơn vị kiến thức đã phân tích trong tài liệu trên, tự biên soạn bộ câu hỏi mới kèm đáp án chuẩn và giải thích rõ ràng:',
    generationTargetInstruction,
    '- Phân bổ mức độ nhận thức hợp lý giữa recognition (Nhận biết), understanding (Thông hiểu), application (Vận dụng).',
    '- Mỗi câu hỏi phải gắn chính xác lessonTitle, topic, cognitiveLevel, answerKey/statementAnswerA..D/rubric, và explanation (giải thích căn cứ từ nội dung tài liệu).',
    '- KHÔNG sao chép mơ hồ hoặc tạo phương án nhiễu vô nghĩa. Mọi đáp án phải chính xác tuyệt đối về mặt khoa học Tin học và bám sát tài liệu.',
    '- Đặt answerStatus = "ai_proposed" và answerSource = "AI Agent đề xuất từ cấu trúc tài liệu".',
    focusNote,
  ]
    .filter(Boolean)
    .join('\n')

  const canAttachPdf =
    params.fileFormat === 'pdf' && params.buffer.length <= MAX_INLINE_PDF_BYTES

  const contentsPayload = canAttachPdf
    ? [
        {
          role: 'user' as const,
          parts: [
            {
              inlineData: {
                mimeType: 'application/pdf',
                data: params.buffer.toString('base64'),
              },
            },
            {
              text: `${agentPrompt}\n\n=== VĂN BẢN HỖ TRỢ TỪ TÀI LIỆU "${params.fileName}" ===\n${cleanText.slice(
                0,
                40000
              )}`,
            },
          ],
        },
      ]
    : `${agentPrompt}\n\n=== NỘI DUNG TÀI LIỆU TỔNG HỢP ("${params.fileName}") ===\n${cleanText.slice(
        0,
        65000
      )}`

  if (cleanText.length > 65000 && !canAttachPdf) {
    warnings.push(
      'Tài liệu có dung lượng văn bản rất lớn (> 65.000 ký tự); AI Agent đã phân tích 65.000 ký tự đầu tiên để tổng hợp cấu trúc và câu hỏi.'
    )
  }

  let response
  try {
    response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: contentsPayload,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            documentAnalysis: {
              type: Type.OBJECT,
              properties: {
                documentSummary: { type: Type.STRING },
                detectedTopics: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                detectedLessons: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                knowledgeUnits: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      lessonTitle: { type: Type.STRING },
                      topic: { type: Type.STRING },
                      keyConcepts: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                    },
                    required: ['lessonTitle', 'topic', 'keyConcepts'],
                  },
                },
              },
              required: [
                'documentSummary',
                'detectedTopics',
                'detectedLessons',
                'knowledgeUnits',
              ],
            },
            questions: {
              type: Type.ARRAY,
              items: EXTRACTED_QUESTION_SCHEMA,
            },
          },
          required: ['documentAnalysis', 'questions'],
        },
      },
    })
  } catch (err) {
    updateCachedGeminiStatusFromError(err)
    const classified = classifyGeminiApiError(err)
    throw new AiExtractionError(
      'ai_extract',
      classified.errorCode,
      classified.userMessage,
      classified.httpStatus
    )
  }

  const rawJson = response.text?.trim()
  if (!rawJson) {
    throw new AiExtractionError(
      'ai_extract',
      'GEMINI_EMPTY_RESPONSE',
      'Gemini API lỗi: Máy chủ AI không trả về dữ liệu phân tích.',
      502
    )
  }

  params.onProgress?.({
    step: 'match_answers',
    stepLabel: 'Đang chuẩn hóa bộ câu hỏi và đáp án do AI Agent tạo...',
    progress: 86,
  })

  const parsed = JSON.parse(stripJsonMarkdownFence(rawJson)) as {
    documentAnalysis?: Partial<CompositeDocumentAnalysis>
    questions?: RawGeminiQuestionItem[]
  }

  const analysis: CompositeDocumentAnalysis = {
    documentSummary:
      typeof parsed.documentAnalysis?.documentSummary === 'string'
        ? parsed.documentAnalysis.documentSummary.trim()
        : 'AI Agent đã phân tích cấu trúc tài liệu.',
    detectedTopics: Array.isArray(parsed.documentAnalysis?.detectedTopics)
      ? parsed.documentAnalysis!.detectedTopics
          .map((t) => String(t).trim())
          .filter(Boolean)
      : [],
    detectedLessons: Array.isArray(parsed.documentAnalysis?.detectedLessons)
      ? parsed.documentAnalysis!.detectedLessons
          .map((l) => String(l).trim())
          .filter(Boolean)
      : [],
    knowledgeUnits: Array.isArray(parsed.documentAnalysis?.knowledgeUnits)
      ? parsed.documentAnalysis!.knowledgeUnits.map((u) => ({
          lessonTitle: String(u?.lessonTitle ?? '').trim(),
          topic: String(u?.topic ?? '').trim(),
          keyConcepts: Array.isArray(u?.keyConcepts)
            ? u.keyConcepts.map((k) => String(k).trim()).filter(Boolean)
            : [],
        }))
      : [],
  }

  const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : []
  const seenHashes = new Set<string>()
  const generatedQuestions: ExtractedQuestion[] = []

  rawQuestions.forEach((rawItem) => {
    const built = buildExtractedQuestionFromRaw(rawItem, generatedQuestions.length, {
      fileName: params.fileName,
      fileFormat: params.fileFormat,
      fileHash,
      questionOrigin: 'ai_generated',
      bankName: params.bankName,
    })
    if (!built) return

    const duplicateInFile = seenHashes.has(built.contentHash)
    seenHashes.add(built.contentHash)

    generatedQuestions.push({
      ...built,
      questionOrigin: 'ai_generated',
      answerSource:
        built.answerStatus === 'ai_proposed'
          ? 'AI Agent đề xuất từ tài liệu tổng hợp (chờ xác nhận)'
          : built.answerSource,
      duplicateInFile,
    })
  })

  return {
    fileName: params.fileName,
    fileFormat: params.fileFormat,
    fileHash,
    pageCount: richDoc.pageCount,
    documentAnalysis: analysis,
    questions: generatedQuestions,
    warnings,
  }
}

/* ============================================================================
 * 7-STEP MULTI-FILE DOCUMENT AI AGENT ORCHESTRATOR (TIN LAB DOCUMENT AI AGENT)
 * ========================================================================== */

interface AnswerPack {
  fileName: string
  parsed: ParsedSeparateAnswerKeys
}

function getNumericKey(questionNumber: string): string {
  const m = questionNumber.match(/\d+/)
  return m ? String(parseInt(m[0], 10)) : ''
}

function resolveSnippetAnswerFromPack(
  q: ExtractedQuestion,
  snippet: SeparateAnswerSnippet,
  pack: AnswerPack
): {
  answerKey: AnswerOptionKey | null
  tfAnswers: { a: boolean; b: boolean; c: boolean; d: boolean } | null
  rubric: string
  explanation: string
} {
  let answerKey = snippet.answerKey
  let explanation = snippet.explanation
  let rubric = snippet.rubric
  let tfAnswers: { a: boolean; b: boolean; c: boolean; d: boolean } | null = null

  if (snippet.tfAnswers) {
    const { a, b, c, d } = snippet.tfAnswers
    if (a !== undefined && b !== undefined && c !== undefined && d !== undefined) {
      tfAnswers = { a, b, c, d }
    }
  }

  if (snippet.questionNumber) {
    const qNum = snippet.questionNumber
    const lKey = snippet.lessonKey || '__root__'
    if (q.questionType === 'multiple_choice' && !answerKey) {
      const reg = pack.parsed.registry.lookupMcq(lKey, qNum, false)
      if (reg.entry && !reg.entry.ambiguous && reg.entry.keys.size === 1) {
        answerKey = Array.from(reg.entry.keys)[0]
        if (!explanation && reg.explanation) explanation = reg.explanation
      }
    } else if (q.questionType === 'true_false' && !tfAnswers) {
      const regTf = pack.parsed.registry.lookupTf(lKey, qNum, false)
      if (regTf.entry) {
        const s = regTf.entry.statements
        if (s.a.size === 1 && s.b.size === 1 && s.c.size === 1 && s.d.size === 1) {
          tfAnswers = {
            a: Array.from(s.a)[0],
            b: Array.from(s.b)[0],
            c: Array.from(s.c)[0],
            d: Array.from(s.d)[0],
          }
          if (!explanation && regTf.explanation) explanation = regTf.explanation
        }
      }
    } else if (q.questionType === 'essay' && !rubric) {
      const regEssay = pack.parsed.registry.lookupEssay(lKey, qNum, false)
      if (regEssay && regEssay.rubricParts.length > 0) {
        rubric = regEssay.rubricParts.join('\n').trim()
      }
    }
  }

  return { answerKey, tfAnswers, rubric, explanation }
}

function applyConflictToQuestion(q: ExtractedQuestion, sourceLabel: string, reason: string) {
  q.answerStatus = 'ambiguous'
  if (q.questionType === 'multiple_choice') q.answerKey = null
  if (q.questionType === 'true_false') {
    q.statementAnswerA = null
    q.statementAnswerB = null
    q.statementAnswerC = null
    q.statementAnswerD = null
  }
  q.answerSource = q.answerSource ? `${q.answerSource} vs ${sourceLabel}` : sourceLabel
  q.answerNote = reason
  q.confidenceScore = 35
  q.confidenceLevel = 'low'
}

function runSecondaryDeepSearchPass(
  questions: ExtractedQuestion[],
  answerPacks: AnswerPack[]
): number {
  if (answerPacks.length === 0) return 0
  let rescuedCount = 0

  for (const q of questions) {
    if (q.questionOrigin === 'ai_generated') continue
    if (q.answerStatus !== 'missing' && q.answerStatus !== 'needs_review') continue

    const qNum = getNumericKey(q.questionNumber)
    const lKey = extractLessonKey(q.lessonTitle) ?? '__root__'

    // 1. Cross-check snippets matching option text or explanation keywords
    let bestHit: {
      pack: AnswerPack
      snip: SeparateAnswerSnippet
      resolved: ReturnType<typeof resolveSnippetAnswerFromPack>
      score: number
      reason: string
    } | null = null

    for (const pack of answerPacks) {
      for (const snip of pack.parsed.snippets) {
        if (
          lKey !== '__root__' &&
          snip.lessonKey !== '__root__' &&
          snip.lessonKey !== lKey
        ) {
          continue
        }

        const resolved = resolveSnippetAnswerFromPack(q, snip, pack)
        const hasAns =
          (q.questionType === 'multiple_choice' && resolved.answerKey !== null) ||
          (q.questionType === 'true_false' && resolved.tfAnswers !== null) ||
          (q.questionType === 'essay' && resolved.rubric.length >= 5)
        if (!hasAns) continue

        // Direct numeric+lesson match where stem overlaps strongly
        const stemSim =
          snip.stemSnippet.length >= 14
            ? computeStemSimilarity(q.questionText, snip.stemSnippet)
            : 0

        // Option text overlap (useful when solution guide quotes the winning option text)
        let optionContainment = 0
        if (q.questionType === 'multiple_choice' && resolved.answerKey) {
          const optText =
            resolved.answerKey === 'A'
              ? q.optionA
              : resolved.answerKey === 'B'
              ? q.optionB
              : resolved.answerKey === 'C'
              ? q.optionC
              : q.optionD
          if (optText && optText.length >= 8) {
            optionContainment = computeStemSimilarity(optText, `${snip.explanation} ${snip.rawLine}`)
          }
        }

        const sameNumBoost = qNum && snip.questionNumber === qNum ? 0.14 : 0
        const combinedScore = Math.min(
          0.99,
          Math.max(stemSim, optionContainment) + sameNumBoost
        )

        if (combinedScore >= 0.78 && (!bestHit || combinedScore > bestHit.score)) {
          bestHit = {
            pack,
            snip,
            resolved,
            score: combinedScore,
            reason:
              optionContainment >= stemSim
                ? `Đối chiếu sâu phương án & lời giải (${Math.round(combinedScore * 100)}%)`
                : `Đối chiếu sâu thân câu hỏi & số câu (${Math.round(combinedScore * 100)}%)`,
          }
        }
      }

      // 2. For True/False questions missing or partial: scan rawText blocks near lesson + Câu N
      if (q.questionType === 'true_false' && qNum && !bestHit) {
        const rawLines = pack.parsed.rawText.split('\n')
        let scanLesson = '__root__'
        const nearbyLines: string[] = []
        let capturing = false

        for (let idx = 0; idx < rawLines.length; idx++) {
          const ln = rawLines[idx].trim()
          if (!ln) continue
          const lk = extractLessonKey(ln)
          if (lk) {
            scanLesson = lk
            capturing = false
            continue
          }
          if (lKey !== '__root__' && scanLesson !== '__root__' && scanLesson !== lKey) {
            continue
          }
          const qStart = ln.match(/^(?:Câu\s*)?(\d{1,3})\s*[:.)\-]/i)
          if (qStart) {
            const foundNum = String(parseInt(qStart[1], 10))
            if (foundNum === qNum) {
              capturing = true
              nearbyLines.push(ln)
              continue
            } else if (capturing) {
              break
            }
          } else if (capturing) {
            if (/^[abcd]\s*[).:\-]/i.test(ln) || nearbyLines.length < 5) {
              nearbyLines.push(ln)
            }
            if (nearbyLines.length >= 8) break
          }
        }

        if (nearbyLines.length > 0 && (lKey === '__root__' || scanLesson === lKey)) {
          const joinedBlock = nearbyLines.join(' ')
          const tfPairs = Array.from(
            joinedBlock.matchAll(/([abcd])\s*[:.)\-]?\s*(Đúng|Sai|Đ|S|True|False)\b/gi)
          )
          const mapTf: Partial<Record<'a' | 'b' | 'c' | 'd', boolean>> = {}
          for (const pm of tfPairs) {
            const letter = pm[1].toLowerCase() as 'a' | 'b' | 'c' | 'd'
            const val = /^(?:đúng|đ|true)$/i.test(pm[2])
            if (mapTf[letter] === undefined) mapTf[letter] = val
          }
          if (
            mapTf.a !== undefined &&
            mapTf.b !== undefined &&
            mapTf.c !== undefined &&
            mapTf.d !== undefined
          ) {
            q.statementAnswerA = mapTf.a
            q.statementAnswerB = mapTf.b
            q.statementAnswerC = mapTf.c
            q.statementAnswerD = mapTf.d
            q.answerStatus = 'verified'
            q.confidenceScore = 88
            q.confidenceLevel = 'high'
            q.matchMethod = 'lesson_and_number'
            q.answerSource = `Đối chiếu sâu Đúng/Sai · ${pack.fileName}`
            q.answerNote = 'Tìm thấy đủ 4 đáp án Đúng/Sai trong phần nội dung chi tiết.'
            rescuedCount += 1
            break
          }
        }
      }
    }

    if (bestHit && q.answerStatus !== 'verified') {
      const pct = Math.min(95, Math.round(bestHit.score * 100))
      if (q.questionType === 'multiple_choice' && bestHit.resolved.answerKey) {
        q.answerKey = bestHit.resolved.answerKey
        q.answerStatus = 'verified'
        q.confidenceScore = pct
        q.confidenceLevel = 'high'
        q.matchMethod = 'stem_and_options'
        q.answerSource = `${bestHit.reason} · ${bestHit.pack.fileName}`
        q.answerNote = `Đã xác định đáp án ${bestHit.resolved.answerKey} qua đối chiếu sâu từ tài liệu nguồn.`
        if (!q.explanation && bestHit.resolved.explanation) {
          q.explanation = bestHit.resolved.explanation.slice(0, 3000)
        }
        rescuedCount += 1
      } else if (q.questionType === 'true_false' && bestHit.resolved.tfAnswers) {
        q.statementAnswerA = bestHit.resolved.tfAnswers.a
        q.statementAnswerB = bestHit.resolved.tfAnswers.b
        q.statementAnswerC = bestHit.resolved.tfAnswers.c
        q.statementAnswerD = bestHit.resolved.tfAnswers.d
        q.answerStatus = 'verified'
        q.confidenceScore = pct
        q.confidenceLevel = 'high'
        q.matchMethod = 'stem_and_options'
        q.answerSource = `${bestHit.reason} · ${bestHit.pack.fileName}`
        q.answerNote = 'Đã xác định đủ 4 đáp án Đúng/Sai qua đối chiếu sâu từ tài liệu nguồn.'
        rescuedCount += 1
      } else if (q.questionType === 'essay' && bestHit.resolved.rubric.length >= 5) {
        q.rubric = bestHit.resolved.rubric.slice(0, 4000)
        q.answerStatus = 'verified'
        q.confidenceScore = pct
        q.confidenceLevel = 'high'
        q.matchMethod = 'stem_and_options'
        q.answerSource = `${bestHit.reason} · ${bestHit.pack.fileName}`
        q.answerNote = 'Đã xác định Rubric tự luận qua đối chiếu sâu.'
        rescuedCount += 1
      }
    }
  }

  return rescuedCount
}

function buildCompactAnswerContextSnippets(
  files: AgentInputFile[],
  agentFiles: AgentUploadedFileReport[],
  answerPacks: AnswerPack[],
  plainTexts: string[]
): Array<{ fileName: string; role: AgentFileRole; rawExcerpt: string }> {
  const MAX_TOTAL_CHARS = 58000
  let usedChars = 0
  const out: Array<{ fileName: string; role: AgentFileRole; rawExcerpt: string }> = []

  for (const pack of answerPacks) {
    if (usedChars >= MAX_TOTAL_CHARS) break
    const rep = agentFiles.find((r) => r.fileName === pack.fileName)
    const remaining = MAX_TOTAL_CHARS - usedChars
    const excerpt = pack.parsed.rawText.slice(0, Math.min(20000, remaining)).trim()
    if (excerpt) {
      out.push({
        fileName: pack.fileName,
        role: rep?.assignedRole ?? 'answer_file',
        rawExcerpt: excerpt,
      })
      usedChars += excerpt.length
    }
  }

  // Also include answer tail from embedded question_file if no separate answer packs exist
  if (out.length === 0) {
    for (let i = 0; i < files.length; i++) {
      if (usedChars >= MAX_TOTAL_CHARS) break
      const rep = agentFiles[i]
      if (!rep || rep.assignedRole !== 'question_file') continue
      const tail = extractAnswerSectionTailForAi(plainTexts[i] || '')
      if (tail.trim()) {
        const remaining = MAX_TOTAL_CHARS - usedChars
        const excerpt = tail.trim().slice(0, Math.min(18000, remaining))
        out.push({
          fileName: rep.fileName,
          role: 'question_file',
          rawExcerpt: excerpt,
        })
        usedChars += excerpt.length
      }
    }
  }

  return out
}

export async function runDocumentAiAgentPipeline(params: {
  files: AgentInputFile[]
  setMode: AgentSetMode
  bankName?: string
  preferredTypes?: QuestionType[]
  compositeConfig?: {
    mcqCount: number
    trueFalseCount: number
    essayCount: number
    adaptiveAutoCount: boolean
    topicFocus: string
  }
  onProgress?: ExtractionProgressCallback
}): Promise<{
  primaryFileName: string
  primaryFileFormat: SourceFileFormat
  primaryFileHash: string
  pageCount: number | null
  documentCategory: 'question_document' | 'composite_document'
  answerProvisionMode: AnswerProvisionMode
  answerFileName: string | null
  questions: ExtractedQuestion[]
  agentFiles: AgentUploadedFileReport[]
  agentSummary: AgentAnalysisSummary
  documentAnalysis: CompositeDocumentAnalysis
  warnings: string[]
}> {
  const safeBankName = (params.bankName ?? '').trim().slice(0, 120)
  const warnings: string[] = []
  const executedSteps: AgentPipelineStepRecord[] = []

  // =========================================================================
  // STEP 1: Analyze & classify uploaded files + smart pairing
  // =========================================================================
  params.onProgress?.({
    step: 'read_file',
    stepLabel: `Bước 1/7: AI Agent đang phân loại vai trò ${params.files.length} tệp tài liệu...`,
    progress: 12,
  })

  const classifiedList = await Promise.all(params.files.map((f) => classifyFileForAgent(f)))
  const agentFiles: AgentUploadedFileReport[] = classifiedList.map((c) => c.report)
  const plainTexts: string[] = classifiedList.map((c) => c.plainText)

  // Respect explicit setMode when caller didn't manually lock roles
  for (let i = 0; i < agentFiles.length; i++) {
    const rep = agentFiles[i]
    const input = params.files[i]
    if (rep.status === 'error') continue
    if (!input.assignedRole && rep.assignedRole !== 'irrelevant_file') {
      if (params.setMode === 'composite_study') {
        rep.assignedRole = 'composite_file'
      } else if (params.setMode === 'question_embedded' && agentFiles.length === 1) {
        rep.assignedRole = 'question_file'
      }
    }
  }

  const pairedSets = pairAgentFiles(agentFiles, plainTexts)
  const preReadErrors = agentFiles.filter((f) => f.status === 'error').length
  executedSteps.push({
    stepNumber: 1,
    title: 'Phân tích, phân loại & ghép cặp tài liệu',
    status: preReadErrors === agentFiles.length ? 'failed' : preReadErrors > 0 ? 'partial' : 'completed',
    detail: `Đã phân loại ${agentFiles.length} tệp (${agentFiles.filter((f) => f.assignedRole === 'question_file').length} câu hỏi, ${agentFiles.filter((f) => f.assignedRole === 'answer_file').length} đáp án, ${agentFiles.filter((f) => f.assignedRole === 'solution_guide').length} hướng dẫn giải, ${agentFiles.filter((f) => f.assignedRole === 'composite_file').length} tổng hợp, ${agentFiles.filter((f) => f.assignedRole === 'irrelevant_file').length} bỏ qua).`,
  })

  // Check Gemini live status once at start if any file needs AI
  const needsCompositeAi = agentFiles.some(
    (f) => f.status !== 'error' && f.assignedRole === 'composite_file'
  )
  const hasPdfQuestions = agentFiles.some(
    (f) => f.status !== 'error' && f.assignedRole === 'question_file' && f.fileFormat === 'pdf'
  )
  const hasAnswerFiles = agentFiles.some(
    (f) =>
      f.status !== 'error' &&
      (f.assignedRole === 'answer_file' || f.assignedRole === 'solution_guide')
  )

  let geminiStatus: GeminiConnectionInfo | null = null
  let aiErrorMessage: string | null = null
  let aiUsed = false

  if (needsCompositeAi || hasPdfQuestions || hasAnswerFiles || checkGeminiConfigured()) {
    geminiStatus = await verifyGeminiApiConnection(false)
    if (!geminiStatus.connected) {
      aiErrorMessage = geminiStatus.message
    }
  }

  // =========================================================================
  // STEP 2 & 3: Extract Questions / Answers / Composite Hybrid Knowledge
  // =========================================================================
  params.onProgress?.({
    step: 'extract_structure',
    stepLabel: 'Bước 2–3/7: Đang trích xuất câu hỏi, mệnh đề, Chủ đề, Bài học & Mã câu...',
    progress: 34,
  })

  const extractedByFileIndex = new Map<number, ExtractedQuestion[]>()
  const answerPacks: AnswerPack[] = []
  const mergedTopics = new Set<string>()
  const mergedLessons = new Set<string>()
  const mergedUnits: CompositeDocumentAnalysis['knowledgeUnits'] = []
  const mergedSummaries: string[] = []

  for (let i = 0; i < params.files.length; i++) {
    const file = params.files[i]
    const rep = agentFiles[i]
    if (rep.status === 'error') continue

    if (rep.assignedRole === 'irrelevant_file') {
      rep.status = 'completed'
      rep.extractedCount = 0
      rep.matchedAnswerCount = 0
      continue
    }

    rep.status = 'processing'

    try {
      if (rep.assignedRole === 'question_file') {
        const parsed = await parseQuestionBankDocument(file.buffer, file.fileName, file.fileFormat, {
          answerProvisionMode: 'embedded_in_file',
        })
        rep.pageCount = parsed.pageCount ?? rep.pageCount
        warnings.push(...parsed.warnings)

        let fileQuestions: ExtractedQuestion[] = parsed.questions.map((q) => ({
          ...q,
          bankName: safeBankName,
          questionOrigin: 'extracted' as const,
        }))

        // Hybrid AI rescue for PDF or complex files where deterministic found < 2 questions
        if (fileQuestions.length < 2) {
          if (geminiStatus?.connected) {
            try {
              params.onProgress?.({
                step: 'ai_extract',
                stepLabel: `Đang dùng Gemini AI trích xuất cấu trúc từ "${file.fileName}"...`,
                progress: 48,
              })
              aiUsed = true
              const aiRes = await extractQuestionsWithGemini({
                buffer: file.buffer,
                fileName: file.fileName,
                fileFormat: file.fileFormat,
                answerProvisionMode: 'embedded_in_file',
                preferredTypes: params.preferredTypes,
                bankName: safeBankName,
              })
              if (aiRes.questions.length > fileQuestions.length) {
                fileQuestions = aiRes.questions
              }
              warnings.push(...aiRes.warnings)
            } catch (aiErr) {
              updateCachedGeminiStatusFromError(aiErr)
              const classified = classifyGeminiApiError(aiErr)
              aiErrorMessage = classified.userMessage
              geminiStatus = await verifyGeminiApiConnection(false)
              if (fileQuestions.length === 0) {
                rep.status = 'error'
                rep.errorStep = 'ai_extract'
                rep.errorMessage = classified.userMessage
                continue
              }
              warnings.push(`${file.fileName}: ${classified.userMessage}`)
            }
          } else if (fileQuestions.length === 0) {
            rep.status = 'error'
            rep.errorStep = 'extract_structure'
            rep.errorMessage =
              geminiStatus && !geminiStatus.connected
                ? `Không trích xuất được câu hỏi từ bố cục tệp và Gemini AI chưa sẵn sàng (${geminiStatus.errorCode || geminiStatus.state}).`
                : 'Không nhận diện được cấu trúc câu hỏi (Câu X / A, B, C, D / Đúng-Sai / Tự luận) trong tệp này.'
            continue
          }
        }

        extractedByFileIndex.set(i, fileQuestions)
        rep.extractedCount = fileQuestions.length
        rep.matchedAnswerCount = fileQuestions.filter((q) => q.answerStatus === 'verified').length
        rep.status = 'completed'

        for (const q of fileQuestions) {
          if (q.topic) mergedTopics.add(q.topic)
          if (q.lessonTitle) mergedLessons.add(q.lessonTitle)
        }
      } else if (rep.assignedRole === 'answer_file' || rep.assignedRole === 'solution_guide') {
        const parsedAns = await parseSeparateAnswerKeyDocument(file.buffer, file.fileFormat)
        answerPacks.push({ fileName: rep.fileName, parsed: parsedAns })
        warnings.push(...parsedAns.warnings)
        const countKeys =
          parsedAns.mcqMap.size +
          parsedAns.tfMap.size +
          parsedAns.essayRubricMap.size +
          parsedAns.byCode.size
        rep.extractedCount = Math.max(countKeys, parsedAns.snippets.length)
        rep.status = 'completed'
        if (rep.extractedCount === 0) {
          warnings.push(
            `File đáp án / hướng dẫn giải "${rep.fileName}" chưa nhận diện được bảng đáp án chuẩn; AI Agent sẽ dùng nội dung văn bản để đối chiếu sâu.`
          )
        }
      } else if (rep.assignedRole === 'composite_file') {
        // Hybrid Composite Mode: first extract any formal existing questions, then optionally generate new questions
        let existingFormal: ExtractedQuestion[] = []
        try {
          const preParsed = await parseQuestionBankDocument(file.buffer, file.fileName, file.fileFormat, {
            answerProvisionMode: 'embedded_in_file',
          })
          rep.pageCount = preParsed.pageCount ?? rep.pageCount
          existingFormal = preParsed.questions.map((q) => ({
            ...q,
            bankName: safeBankName,
            questionOrigin: 'extracted' as const,
          }))
        } catch {
          existingFormal = []
        }

        let generatedQuestions: ExtractedQuestion[] = []
        if (geminiStatus?.connected) {
          params.onProgress?.({
            step: 'ai_extract',
            stepLabel: `AI Agent đang phân tích tài liệu tổng hợp "${file.fileName}"...`,
            progress: 54,
          })
          aiUsed = true
          const cfg = params.compositeConfig ?? {
            mcqCount: 8,
            trueFalseCount: 2,
            essayCount: 2,
            adaptiveAutoCount: true,
            topicFocus: '',
          }
          const gen = await analyzeAndGenerateWithAiAgent({
            buffer: file.buffer,
            fileName: file.fileName,
            fileFormat: file.fileFormat,
            mcqCount: cfg.mcqCount,
            trueFalseCount: cfg.trueFalseCount,
            essayCount: cfg.essayCount,
            adaptiveAutoCount: cfg.adaptiveAutoCount,
            topicFocus: cfg.topicFocus,
            bankName: safeBankName,
          })

          rep.pageCount = gen.pageCount ?? rep.pageCount
          warnings.push(...gen.warnings)
          generatedQuestions = gen.questions

          if (gen.documentAnalysis.documentSummary) {
            mergedSummaries.push(`${file.fileName}: ${gen.documentAnalysis.documentSummary}`)
          }
          gen.documentAnalysis.detectedTopics.forEach((t) => mergedTopics.add(t))
          gen.documentAnalysis.detectedLessons.forEach((l) => mergedLessons.add(l))
          mergedUnits.push(...gen.documentAnalysis.knowledgeUnits)
        } else if (existingFormal.length > 0) {
          warnings.push(
            `${file.fileName}: Đã trích xuất ${existingFormal.length} câu hỏi có sẵn trong tài liệu tổng hợp. Gemini AI chưa sẵn sàng (${geminiStatus?.message || 'chưa kết nối'}) nên chưa tạo thêm câu hỏi mới.`
          )
        } else {
          rep.status = 'error'
          rep.errorStep = 'ai_extract'
          rep.errorMessage =
            geminiStatus?.message ||
            'Gemini API chưa kết nối hợp lệ nên không thể sinh câu hỏi từ tài liệu tổng hợp. Hãy kiểm tra GEMINI_API_KEY trong Settings > Secrets.'
          aiErrorMessage = rep.errorMessage
          continue
        }

        // Deduplicate: keep existing formal questions first, append distinct AI-generated proposals
        const seenCompositeHashes = new Set(existingFormal.map((q) => q.contentHash))
        const combinedComposite: ExtractedQuestion[] = [...existingFormal]
        for (const gq of generatedQuestions) {
          if (!seenCompositeHashes.has(gq.contentHash)) {
            seenCompositeHashes.add(gq.contentHash)
            combinedComposite.push(gq)
          }
        }

        rep.extractedCount = combinedComposite.length
        rep.matchedAnswerCount = combinedComposite.filter((q) => q.answerStatus === 'verified').length
        rep.status = 'completed'
        extractedByFileIndex.set(i, combinedComposite)
      } else {
        // reference_file
        rep.status = 'completed'
        rep.extractedCount = 0
      }
    } catch (fileErr) {
      if (
        fileErr instanceof AiExtractionError &&
        (fileErr.code === 'API_KEY_INVALID' ||
          fileErr.code === 'PERMISSION_DENIED' ||
          fileErr.code === 'AI_NOT_CONFIGURED')
      ) {
        aiErrorMessage = fileErr.message
        geminiStatus = await verifyGeminiApiConnection(false)
      }
      rep.status = 'error'
      rep.errorStep =
        fileErr instanceof AiExtractionError || fileErr instanceof DocumentParserError
          ? fileErr.step
          : 'extract_structure'
      rep.errorMessage =
        fileErr instanceof Error
          ? fileErr.message
          : `Lỗi khi xử lý tệp "${file.fileName}".`
    }
  }

  const allQuestions: ExtractedQuestion[] = []
  for (let i = 0; i < params.files.length; i++) {
    const items = extractedByFileIndex.get(i)
    if (items && items.length > 0) {
      allQuestions.push(...items)
    }
  }

  const step23Failed = agentFiles.filter((f) => f.status === 'error').length
  executedSteps.push({
    stepNumber: 2,
    title: 'Trích xuất câu hỏi, lựa chọn A/B/C/D, Đúng/Sai & Tự luận',
    status:
      allQuestions.length === 0 && step23Failed > 0
        ? 'failed'
        : step23Failed > 0
        ? 'partial'
        : 'completed',
    detail: `Trích xuất được ${allQuestions.length} câu hỏi và ${answerPacks.length} bộ đáp án / hướng dẫn giải.`,
  })
  executedSteps.push({
    stepNumber: 3,
    title: 'Nhận diện Chủ đề, Bài học, Số câu & Mã câu',
    status: allQuestions.length > 0 ? 'completed' : 'skipped',
    detail: `Nhận diện ${mergedLessons.size} bài học, ${mergedTopics.size} chủ đề, ${allQuestions.filter((q) => Boolean(q.questionCode)).length} câu có mã định danh.`,
  })

  // =========================================================================
  // STEP 4 & 5: Strict 4-Tier Answer Matching + Secondary Deep Search + Confidence
  // =========================================================================
  params.onProgress?.({
    step: 'match_answers',
    stepLabel: 'Bước 4–5/7: Đang đối chiếu đáp án theo 4 tầng ưu tiên & chấm độ tin cậy...',
    progress: 72,
  })

  let ranTier4Ai = false

  if (answerPacks.length > 0 && params.setMode !== 'question_embedded') {
    const globalKeyCountsByType = new Map<string, number>()
    const lessonKeyCountsByType = new Map<string, number>()

    for (const q of allQuestions) {
      if (q.questionOrigin === 'ai_generated') continue
      const numKey = getNumericKey(q.questionNumber)
      if (!numKey) continue
      const lKey = extractLessonKey(q.lessonTitle) ?? '__root__'
      const gKey = `${q.questionType}:${numKey}`
      globalKeyCountsByType.set(gKey, (globalKeyCountsByType.get(gKey) ?? 0) + 1)
      const lk = `${lKey}:${q.questionType}:${numKey}`
      lessonKeyCountsByType.set(lk, (lessonKeyCountsByType.get(lk) ?? 0) + 1)
    }

    for (const q of allQuestions) {
      if (q.questionOrigin === 'ai_generated') continue

      const qCode = q.questionCode || extractQuestionCode(q.questionText)
      if (qCode) q.questionCode = qCode

      const numKey = getNumericKey(q.questionNumber)
      const lKey = extractLessonKey(q.lessonTitle) ?? '__root__'
      const isGlobalRepeated = numKey
        ? (globalKeyCountsByType.get(`${q.questionType}:${numKey}`) ?? 0) > 1
        : false
      const isLessonRepeated = numKey
        ? (lessonKeyCountsByType.get(`${lKey}:${q.questionType}:${numKey}`) ?? 0) > 1
        : false

      let matchedThisStep = false

      // --- TIER 1: Question Code / Lesson Code ---
      if (qCode) {
        const codeHits: Array<{
          fileName: string
          answerKey: AnswerOptionKey | null
          tfAnswers: { a: boolean; b: boolean; c: boolean; d: boolean } | null
          rubric: string
          explanation: string
        }> = []

        let codeConflictDetail: string | null = null
        for (const pack of answerPacks) {
          const snip = pack.parsed.byCode.get(qCode)
          if (snip) {
            if (snip.ambiguousConflict) {
              codeConflictDetail =
                snip.conflictDetail ||
                `Có nhiều đáp án xung đột cho mã câu ${qCode} trong tệp ${pack.fileName}.`
            }
            const resolved = resolveSnippetAnswerFromPack(q, snip, pack)
            if (resolved.answerKey || resolved.tfAnswers || resolved.rubric) {
              codeHits.push({ fileName: pack.fileName, ...resolved })
            }
          }
        }

        if (codeConflictDetail) {
          applyConflictToQuestion(q, `Mã câu ${qCode}`, codeConflictDetail)
          matchedThisStep = true
        } else if (codeHits.length > 0) {
          if (q.questionType === 'multiple_choice') {
            const distinctKeys = new Set(
              codeHits.map((h) => h.answerKey).filter((k): k is AnswerOptionKey => k !== null)
            )
            if (
              distinctKeys.size > 1 ||
              (q.answerKey && distinctKeys.size === 1 && !distinctKeys.has(q.answerKey))
            ) {
              applyConflictToQuestion(
                q,
                `Mã câu ${qCode} (${codeHits.map((h) => h.fileName).join(', ')})`,
                `Xung đột đáp án cho mã câu ${qCode} giữa các nguồn đáp án.`
              )
              matchedThisStep = true
            } else if (distinctKeys.size === 1) {
              const key = Array.from(distinctKeys)[0]
              q.answerKey = key
              q.answerStatus = 'verified'
              q.confidenceScore = 98
              q.confidenceLevel = 'high'
              q.matchMethod = 'question_code'
              q.answerSource = `Mã câu ${qCode} · ${codeHits[0].fileName}`
              q.answerNote = `Khớp chính xác theo mã câu ${qCode} (${key}).`
              if (!q.explanation && codeHits[0].explanation) {
                q.explanation = codeHits[0].explanation.slice(0, 3000)
              }
              matchedThisStep = true
            }
          } else if (q.questionType === 'true_false') {
            const firstTf = codeHits.find((h) => h.tfAnswers)?.tfAnswers
            if (firstTf) {
              q.statementAnswerA = firstTf.a
              q.statementAnswerB = firstTf.b
              q.statementAnswerC = firstTf.c
              q.statementAnswerD = firstTf.d
              q.answerStatus = 'verified'
              q.confidenceScore = 98
              q.confidenceLevel = 'high'
              q.matchMethod = 'question_code'
              q.answerSource = `Mã câu ${qCode} · ${codeHits[0].fileName}`
              q.answerNote = `Khớp Đúng/Sai theo mã câu ${qCode}.`
              if (!q.explanation && codeHits[0].explanation) {
                q.explanation = codeHits[0].explanation.slice(0, 3000)
              }
              matchedThisStep = true
            }
          } else if (q.questionType === 'essay') {
            const firstRubric = codeHits.find((h) => h.rubric.length >= 5)?.rubric
            if (firstRubric) {
              q.rubric = firstRubric.slice(0, 4000)
              q.answerStatus = 'verified'
              q.confidenceScore = 96
              q.confidenceLevel = 'high'
              q.matchMethod = 'question_code'
              q.answerSource = `Mã câu ${qCode} · ${codeHits[0].fileName}`
              q.answerNote = `Khớp Rubric tự luận theo mã câu ${qCode}.`
              matchedThisStep = true
            }
          }
        }
      }

      if (matchedThisStep) continue

      // --- TIER 2: Lesson Structure & Question Number (never cross-lesson!) ---
      if (numKey) {
        if (isLessonRepeated) {
          const anyLessonEntry = answerPacks.some(
            (p) =>
              p.parsed.registry.mcqByLesson.has(`${lKey}|${numKey}`) ||
              p.parsed.registry.tfByLesson.has(`${lKey}|${numKey}`)
          )
          if (anyLessonEntry) {
            applyConflictToQuestion(
              q,
              `${q.lessonTitle || 'Cùng bài'} · ${q.questionNumber}`,
              `Số thứ tự ${q.questionNumber} lặp lại trong cùng bài học (${q.lessonTitle || 'chưa rõ bài'}) nên đánh dấu Cần kiểm tra / Xung đột.`
            )
            continue
          }
        } else {
          if (q.questionType === 'multiple_choice') {
            const candidates = new Set<AnswerOptionKey>()
            const srcLabels: string[] = []
            let conflictReason: string | null = null
            let foundExp = ''

            for (const pack of answerPacks) {
              const sep = pack.parsed.registry.lookupMcq(lKey, numKey, isGlobalRepeated)
              if (sep.ambiguousConflictReason) {
                continue
              }
              if (sep.entry) {
                if (sep.entry.ambiguous) {
                  conflictReason = sep.entry.reason || `Xung đột trong ${pack.fileName}`
                }
                sep.entry.keys.forEach((k) => candidates.add(k))
                srcLabels.push(`${pack.fileName} · ${sep.scopeLabel || q.questionNumber}`)
                if (!foundExp && sep.explanation) foundExp = sep.explanation
              }
            }

            if (conflictReason || candidates.size > 1) {
              applyConflictToQuestion(
                q,
                srcLabels.join(' vs ') || 'File đáp án riêng',
                conflictReason ||
                  `Phát hiện nhiều đáp án khác nhau (${Array.from(candidates).sort().join(', ')}).`
              )
              matchedThisStep = true
            } else if (candidates.size === 1) {
              const sepKey = Array.from(candidates)[0]
              if (q.answerStatus === 'verified' && q.answerKey && q.answerKey !== sepKey) {
                applyConflictToQuestion(
                  q,
                  srcLabels.join(' + '),
                  `Xung đột giữa đáp án đánh dấu trong file đề (${q.answerKey}) và file đáp án riêng (${sepKey}).`
                )
              } else {
                q.answerKey = sepKey
                q.answerStatus = 'verified'
                q.confidenceScore = lKey !== '__root__' ? 96 : 92
                q.confidenceLevel = 'high'
                q.matchMethod = 'lesson_and_number'
                q.answerSource = `File đáp án riêng (${srcLabels.join(' + ')})`
                q.answerNote = `Khớp đáp án ${sepKey} theo cấu trúc ${lKey !== '__root__' ? q.lessonTitle : 'số câu'}.`
                if (!q.explanation && foundExp) q.explanation = foundExp.slice(0, 3000)
              }
              matchedThisStep = true
            }
          } else if (q.questionType === 'true_false') {
            const mergedTf: Record<'a' | 'b' | 'c' | 'd', Set<boolean>> = {
              a: new Set(q.statementAnswerA !== null ? [q.statementAnswerA] : []),
              b: new Set(q.statementAnswerB !== null ? [q.statementAnswerB] : []),
              c: new Set(q.statementAnswerC !== null ? [q.statementAnswerC] : []),
              d: new Set(q.statementAnswerD !== null ? [q.statementAnswerD] : []),
            }
            const srcLabels: string[] = []
            let conflictFound = false
            let foundExp = ''

            for (const pack of answerPacks) {
              const sep = pack.parsed.registry.lookupTf(lKey, numKey, isGlobalRepeated)
              if (sep.ambiguousConflictReason) continue
              if (sep.entry) {
                srcLabels.push(`${pack.fileName} · ${sep.scopeLabel || q.questionNumber}`)
                if (!foundExp && sep.explanation) foundExp = sep.explanation
                ;(['a', 'b', 'c', 'd'] as const).forEach((l) => {
                  if (sep.entry!.ambiguous[l]) conflictFound = true
                  sep.entry!.statements[l].forEach((v) => mergedTf[l].add(v))
                })
              }
            }

            if (srcLabels.length > 0) {
              const conflictedLetters = (['a', 'b', 'c', 'd'] as const).filter(
                (l) => mergedTf[l].size > 1
              )
              if (conflictFound || conflictedLetters.length > 0) {
                applyConflictToQuestion(
                  q,
                  srcLabels.join(' vs '),
                  `Xung đột đáp án Đúng/Sai ở ý ${conflictedLetters.join(', ')} giữa file đề và file đáp án.`
                )
                matchedThisStep = true
              } else {
                const sa = mergedTf.a.size === 1 ? Array.from(mergedTf.a)[0] : null
                const sb = mergedTf.b.size === 1 ? Array.from(mergedTf.b)[0] : null
                const sc = mergedTf.c.size === 1 ? Array.from(mergedTf.c)[0] : null
                const sd = mergedTf.d.size === 1 ? Array.from(mergedTf.d)[0] : null
                const presentCount = [sa, sb, sc, sd].filter((v) => v !== null).length
                if (presentCount === 4) {
                  q.statementAnswerA = sa
                  q.statementAnswerB = sb
                  q.statementAnswerC = sc
                  q.statementAnswerD = sd
                  q.answerStatus = 'verified'
                  q.confidenceScore = lKey !== '__root__' ? 96 : 92
                  q.confidenceLevel = 'high'
                  q.matchMethod = 'lesson_and_number'
                  q.answerSource = `File đáp án riêng (${srcLabels.join(' + ')})`
                  q.answerNote = 'Khớp đủ 4 đáp án Đúng/Sai theo Bài học & Số câu.'
                  if (!q.explanation && foundExp) q.explanation = foundExp.slice(0, 3000)
                  matchedThisStep = true
                } else if (presentCount > 0) {
                  q.statementAnswerA = sa
                  q.statementAnswerB = sb
                  q.statementAnswerC = sc
                  q.statementAnswerD = sd
                  q.answerStatus = 'needs_review'
                  q.confidenceScore = 65
                  q.confidenceLevel = 'medium'
                  q.matchMethod = 'lesson_and_number'
                  q.answerSource = `File đáp án riêng (${srcLabels.join(' + ')})`
                  q.answerNote = `Chỉ nhận diện được ${presentCount}/4 ý Đúng/Sai, cần kiểm tra bổ sung các ý còn thiếu.`
                  matchedThisStep = true
                }
              }
            }
          } else if (q.questionType === 'essay') {
            for (const pack of answerPacks) {
              const sepEssay = pack.parsed.registry.lookupEssay(lKey, numKey, isGlobalRepeated)
              if (sepEssay && sepEssay.rubricParts.length > 0) {
                const rText = sepEssay.rubricParts.join('\n').trim()
                if (rText.length >= 5) {
                  q.rubric = rText.slice(0, 4000)
                  q.answerStatus = 'verified'
                  q.confidenceScore = 94
                  q.confidenceLevel = 'high'
                  q.matchMethod = 'lesson_and_number'
                  q.answerSource = `File đáp án riêng (${pack.fileName} · ${q.questionNumber})`
                  q.answerNote = 'Đã đối chiếu hướng dẫn chấm tự luận từ file đáp án riêng.'
                  matchedThisStep = true
                  break
                }
              }
            }
          }
        }
      }

      if (matchedThisStep || q.answerStatus === 'verified' || q.answerStatus === 'ambiguous') {
        continue
      }

      // --- TIER 3: Question Stem & Options Text Similarity ---
      const combinedQueryText =
        q.questionType === 'multiple_choice'
          ? `${q.questionText} ${q.optionA} ${q.optionB} ${q.optionC} ${q.optionD}`
          : q.questionType === 'true_false'
          ? `${q.questionText} ${q.statementA} ${q.statementB}`
          : q.questionText

      let bestSim = 0
      let bestMatch: {
        pack: AnswerPack
        snippet: SeparateAnswerSnippet
        resolved: ReturnType<typeof resolveSnippetAnswerFromPack>
      } | null = null

      for (const pack of answerPacks) {
        for (const snip of pack.parsed.snippets) {
          if (
            lKey !== '__root__' &&
            snip.lessonKey !== '__root__' &&
            snip.lessonKey !== lKey
          ) {
            continue
          }
          if (snip.stemSnippet.length < 18) continue

          const simStem = computeStemSimilarity(q.questionText, snip.stemSnippet)
          const simCombined = computeStemSimilarity(combinedQueryText, snip.rawLine)
          const sim = Math.max(simStem, simCombined)
          if (sim > bestSim && sim >= 0.55) {
            const resolved = resolveSnippetAnswerFromPack(q, snip, pack)
            if (resolved.answerKey || resolved.tfAnswers || resolved.rubric.length >= 5) {
              bestSim = sim
              bestMatch = { pack, snippet: snip, resolved }
            }
          }
        }
      }

      if (bestMatch) {
        const score = Math.min(94, Math.round(bestSim * 100))
        const { pack, resolved } = bestMatch
        if (bestSim >= 0.78) {
          if (q.questionType === 'multiple_choice' && resolved.answerKey) {
            q.answerKey = resolved.answerKey
            q.answerStatus = 'verified'
            q.confidenceScore = Math.max(88, score)
            q.confidenceLevel = 'high'
            q.matchMethod = 'stem_and_options'
            q.answerSource = `Khớp nội dung câu hỏi · ${pack.fileName}`
            q.answerNote = `Khớp theo nội dung câu hỏi (độ tương đồng ${score}%) -> Đáp án ${resolved.answerKey}.`
            if (!q.explanation && resolved.explanation) {
              q.explanation = resolved.explanation.slice(0, 3000)
            }
          } else if (q.questionType === 'true_false' && resolved.tfAnswers) {
            q.statementAnswerA = resolved.tfAnswers.a
            q.statementAnswerB = resolved.tfAnswers.b
            q.statementAnswerC = resolved.tfAnswers.c
            q.statementAnswerD = resolved.tfAnswers.d
            q.answerStatus = 'verified'
            q.confidenceScore = Math.max(88, score)
            q.confidenceLevel = 'high'
            q.matchMethod = 'stem_and_options'
            q.answerSource = `Khớp nội dung câu Đúng/Sai · ${pack.fileName}`
            q.answerNote = `Khớp 4 ý Đúng/Sai theo nội dung câu hỏi (${score}%).`
          } else if (q.questionType === 'essay' && resolved.rubric.length >= 5) {
            q.rubric = resolved.rubric.slice(0, 4000)
            q.answerStatus = 'verified'
            q.confidenceScore = Math.max(86, score)
            q.confidenceLevel = 'high'
            q.matchMethod = 'stem_and_options'
            q.answerSource = `Khớp nội dung tự luận · ${pack.fileName}`
            q.answerNote = `Khớp Rubric theo nội dung câu hỏi (${score}%).`
          }
        } else {
          q.answerStatus = 'needs_review'
          q.confidenceScore = score
          q.confidenceLevel = confidenceLevelFromScore(score)
          q.matchMethod = 'stem_and_options'
          q.answerSource = `Đề xuất từ ${pack.fileName} (tương đồng ${score}%)`
          q.answerNote = `Tìm thấy đoạn trùng một phần nội dung (${score}%), xếp vào Cần kiểm tra để Super Admin xác nhận.`
          q.aiSuggestion = {
            suggestedAnswerKey: resolved.answerKey,
            suggestedStatementA: resolved.tfAnswers?.a ?? null,
            suggestedStatementB: resolved.tfAnswers?.b ?? null,
            suggestedStatementC: resolved.tfAnswers?.c ?? null,
            suggestedStatementD: resolved.tfAnswers?.d ?? null,
            suggestedRubric: resolved.rubric.slice(0, 1500),
            suggestedExplanation: resolved.explanation.slice(0, 1500),
            confidenceScore: score,
            confidenceLevel: confidenceLevelFromScore(score),
            matchMethod: 'stem_and_options',
            reasoning: `Độ tương đồng nội dung câu hỏi đạt ${score}% với đoạn trong "${pack.fileName}".`,
            sourceFileName: pack.fileName,
            applied: false,
          }
        }
      }
    }

    // --- DETERMINISTIC SECONDARY DEEP SEARCH PASS (before calling Gemini Tier 4) ---
    runSecondaryDeepSearchPass(allQuestions, answerPacks)

    // --- TIER 4: Context & Explanation Semantic Matching via Gemini AI (NEVER auto-marks verified!) ---
    const remainingMissing = allQuestions.filter(
      (q) => q.questionOrigin !== 'ai_generated' && q.answerStatus === 'missing'
    )

    if (remainingMissing.length > 0 && geminiStatus?.connected) {
      const aiClient = getGeminiClient()
      if (aiClient) {
        const combinedAnswerContext = answerPacks
          .map((p) => `=== FILE ĐÁP ÁN: ${p.fileName} ===\n${p.parsed.rawText.slice(0, 18000)}`)
          .join('\n\n')
          .slice(0, 38000)

        if (combinedAnswerContext.trim().length > 20) {
          params.onProgress?.({
            step: 'ai_extract',
            stepLabel: `Đang dùng AI Agent đối chiếu ngữ nghĩa ${remainingMissing.length} câu chưa khớp...`,
            progress: 82,
          })
          aiUsed = true
          ranTier4Ai = true

          const batches: ExtractedQuestion[][] = []
          for (let i = 0; i < remainingMissing.length; i += 15) {
            batches.push(remainingMissing.slice(i, i + 15))
          }

          try {
            await runWithConcurrency(batches, 2, async (batch) => {
              const payload = batch.map((q) => ({
                tempId: q.tempId,
                questionType: q.questionType,
                questionCode: q.questionCode || '',
                lessonTitle: q.lessonTitle,
                questionNumber: q.questionNumber,
                questionText: q.questionText.slice(0, 320),
                optionsOrStatements:
                  q.questionType === 'multiple_choice'
                    ? { A: q.optionA, B: q.optionB, C: q.optionC, D: q.optionD }
                    : q.questionType === 'true_false'
                    ? { a: q.statementA, b: q.statementB, c: q.statementC, d: q.statementD }
                    : undefined,
              }))

              const prompt = [
                'Bạn là TIN LAB Document AI Agent thực hiện ĐỐI CHIẾU TẦNG 4 (Ngữ cảnh & Giải thích).',
                'Hãy tìm đáp án cho từng câu hỏi dưới đây dựa DUY NHẤT vào nội dung File Đáp Án kèm theo.',
                'QUY TẮC CỨNG:',
                '- Không bao giờ tự đoán đáp án khi không có căn cứ trong File Đáp Án.',
                '- Không ghép chéo hai câu thuộc hai Bài học khác nhau chỉ vì trùng số thứ tự.',
                '- Trả confidenceScore (0..100): >=80 nếu khớp ngữ cảnh/giải thích rõ ràng, 50..79 nếu cần giáo viên kiểm tra thêm, <50 hoặc null nếu không tìm thấy.',
                '',
                'Câu hỏi chưa khớp:',
                JSON.stringify(payload),
                '',
                combinedAnswerContext,
              ].join('\n')

              const resp = await aiClient.models.generateContent({
                model: GEMINI_MODEL,
                contents: prompt,
                config: {
                  thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                  responseMimeType: 'application/json',
                  responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                      matches: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            tempId: { type: Type.STRING },
                            answerKey: { type: Type.STRING, nullable: true },
                            statementAnswerA: { type: Type.BOOLEAN, nullable: true },
                            statementAnswerB: { type: Type.BOOLEAN, nullable: true },
                            statementAnswerC: { type: Type.BOOLEAN, nullable: true },
                            statementAnswerD: { type: Type.BOOLEAN, nullable: true },
                            rubric: { type: Type.STRING },
                            explanation: { type: Type.STRING },
                            confidenceScore: { type: Type.INTEGER },
                            reasoning: { type: Type.STRING },
                            sourceFileName: { type: Type.STRING },
                          },
                          required: ['tempId', 'confidenceScore'],
                        },
                      },
                    },
                    required: ['matches'],
                  },
                },
              })

              const raw = resp.text?.trim()
              if (!raw) return
              const parsed = JSON.parse(stripJsonMarkdownFence(raw)) as {
                matches?: Array<{
                  tempId?: string
                  answerKey?: string | null
                  statementAnswerA?: boolean | null
                  statementAnswerB?: boolean | null
                  statementAnswerC?: boolean | null
                  statementAnswerD?: boolean | null
                  rubric?: string
                  explanation?: string
                  confidenceScore?: number
                  reasoning?: string
                  sourceFileName?: string
                }>
              }

              const byId = new Map(batch.map((q) => [q.tempId, q]))
              for (const m of parsed.matches ?? []) {
                const q = m.tempId ? byId.get(m.tempId) : undefined
                if (!q || q.answerStatus !== 'missing') continue
                const conf = Math.max(0, Math.min(100, Math.round(Number(m.confidenceScore) || 0)))
                if (conf < 50) continue

                const key = normalizeMcqKey(m.answerKey)
                const sa = normalizeBoolOrNull(m.statementAnswerA)
                const sb = normalizeBoolOrNull(m.statementAnswerB)
                const sc = normalizeBoolOrNull(m.statementAnswerC)
                const sd = normalizeBoolOrNull(m.statementAnswerD)
                const rub = m.rubric?.trim() ?? ''

                const hasValidProposal =
                  (q.questionType === 'multiple_choice' && key !== null) ||
                  (q.questionType === 'true_false' &&
                    sa !== null &&
                    sb !== null &&
                    sc !== null &&
                    sd !== null) ||
                  (q.questionType === 'essay' && rub.length >= 5)

                if (!hasValidProposal) continue

                const srcFile = m.sourceFileName?.trim() || answerPacks[0].fileName
                const suggestion: AiQuestionSuggestion = {
                  suggestedAnswerKey: q.questionType === 'multiple_choice' ? key : null,
                  suggestedStatementA: q.questionType === 'true_false' ? sa : null,
                  suggestedStatementB: q.questionType === 'true_false' ? sb : null,
                  suggestedStatementC: q.questionType === 'true_false' ? sc : null,
                  suggestedStatementD: q.questionType === 'true_false' ? sd : null,
                  suggestedRubric: q.questionType === 'essay' ? rub.slice(0, 3000) : '',
                  suggestedExplanation: m.explanation?.trim().slice(0, 2000) ?? '',
                  confidenceScore: conf,
                  confidenceLevel: confidenceLevelFromScore(conf),
                  matchMethod: 'context_and_explanation',
                  reasoning: m.reasoning?.trim() || 'Đối chiếu ngữ cảnh và phần giải thích.',
                  sourceFileName: srcFile,
                  applied: false,
                }
                q.aiSuggestion = suggestion
                q.confidenceScore = conf
                q.confidenceLevel = confidenceLevelFromScore(conf)
                q.matchMethod = 'context_and_explanation'
                if (m.explanation?.trim() && !q.explanation) {
                  q.explanation = m.explanation.trim().slice(0, 3000)
                }

                if (conf >= 80) {
                  q.answerStatus = 'ai_proposed'
                  q.answerSource = `AI đề xuất (chưa xác nhận) · ${srcFile} (${conf}%)`
                  q.answerNote = `AI Agent đề xuất đáp án với độ tin cậy ${conf}% — chờ Super Admin xác nhận.`
                } else {
                  q.answerStatus = 'needs_review'
                  q.answerSource = `Đề xuất AI (${srcFile} · ${conf}%)`
                  q.answerNote = `AI đề xuất đáp án (${conf}% tin cậy) — giữ ở trạng thái Cần kiểm tra để Super Admin duyệt.`
                }
              }
            })
          } catch (tier4Err) {
            updateCachedGeminiStatusFromError(tier4Err)
            const classified = classifyGeminiApiError(tier4Err)
            aiErrorMessage = classified.userMessage
            geminiStatus = await verifyGeminiApiConnection(false)
            warnings.push(classified.userMessage)
          }
        }
      }
    }
  }

  // Update per-file matchedAnswerCount
  for (let i = 0; i < params.files.length; i++) {
    const rep = agentFiles[i]
    const items = extractedByFileIndex.get(i)
    if (items) {
      rep.matchedAnswerCount = items.filter((q) => q.answerStatus === 'verified').length
    }
  }

  // Re-index tempIds and duplicateInFile across entire set
  const seenHashes = new Set<string>()
  const finalQuestions: ExtractedQuestion[] = allQuestions.map((q, idx) => {
    const dup = seenHashes.has(q.contentHash)
    seenHashes.add(q.contentHash)
    return {
      ...q,
      tempId: `q-${idx + 1}-${q.contentHash.slice(0, 8)}`,
      originalQuestionText: q.originalQuestionText || q.questionText,
      confidenceScore: q.confidenceScore ?? (q.answerStatus === 'verified' ? 92 : 0),
      confidenceLevel:
        q.confidenceLevel ??
        confidenceLevelFromScore(q.confidenceScore ?? (q.answerStatus === 'verified' ? 92 : 0)),
      matchMethod: q.matchMethod ?? (q.answerStatus === 'verified' ? 'embedded_key_table' : 'unmatched'),
      duplicateInFile: dup,
      reviewDecision: dup ? 'rejected' : q.reviewDecision,
    }
  })

  const verifiedCount = finalQuestions.filter((q) => q.answerStatus === 'verified').length
  const aiProposedCount = finalQuestions.filter((q) => q.answerStatus === 'ai_proposed').length
  const needsReviewCount = finalQuestions.filter((q) => q.answerStatus === 'needs_review').length
  const missingCount = finalQuestions.filter((q) => q.answerStatus === 'missing').length
  const ambiguousCount = finalQuestions.filter((q) => q.answerStatus === 'ambiguous').length
  const duplicateCount = finalQuestions.filter((q) => q.duplicateInFile).length
  const averageConfidence =
    finalQuestions.length > 0
      ? Math.round(
          finalQuestions.reduce((sum, q) => sum + (q.confidenceScore ?? 0), 0) /
            finalQuestions.length
        )
      : 0

  executedSteps.push({
    stepNumber: 4,
    title: 'Đối chiếu câu hỏi với đáp án (4 tầng + tìm sâu)',
    status: answerPacks.length > 0 || verifiedCount > 0 ? 'completed' : 'partial',
    detail: `Đã khớp từ nguồn ${verifiedCount}/${finalQuestions.length} câu; AI đề xuất ${aiProposedCount} câu; phát hiện ${ambiguousCount} xung đột.`,
  })
  executedSteps.push({
    stepNumber: 5,
    title: 'Tính điểm tin cậy (0–100) cho từng câu hỏi',
    status: finalQuestions.length > 0 ? 'completed' : 'skipped',
    detail: `Độ tin cậy trung bình toàn bộ tài liệu: ${averageConfidence}%.`,
  })
  executedSteps.push({
    stepNumber: 6,
    title: 'Phân loại 5 trạng thái & tách hàng đợi ngoại lệ',
    status: finalQuestions.length > 0 ? 'completed' : 'skipped',
    detail: `Từ nguồn: ${verifiedCount} · AI đề xuất: ${aiProposedCount} · Cần kiểm tra: ${needsReviewCount} · Thiếu đáp án: ${missingCount} · Xung đột: ${ambiguousCount}.`,
  })
  executedSteps.push({
    stepNumber: 7,
    title: 'Tổng hợp kết quả, lưu Checkpoint & sẵn sàng xuất Excel',
    status: 'completed',
    detail: 'Sẵn sàng duyệt hàng loạt từ nguồn, xử lý ngoại lệ, xuất .xlsx và lưu PostgreSQL.',
  })

  const primaryReport =
    agentFiles.find((f) => f.assignedRole === 'question_file' && f.status === 'completed') ??
    agentFiles.find((f) => f.status === 'completed') ??
    agentFiles[0]

  const firstAnswerFile =
    agentFiles.find(
      (f) => f.assignedRole === 'answer_file' || f.assignedRole === 'solution_guide'
    )?.fileName ?? null

  const completedFiles = agentFiles.filter((f) => f.status === 'completed').length
  const failedFiles = agentFiles.filter((f) => f.status === 'error').length

  const agentSummary: AgentAnalysisSummary = {
    totalFiles: agentFiles.length,
    completedFiles,
    failedFiles,
    totalQuestions: finalQuestions.length,
    verifiedCount,
    aiProposedCount,
    needsReviewCount,
    missingCount,
    ambiguousCount,
    duplicateCount,
    averageConfidence,
    aiUsed,
    aiConnectionState: geminiStatus?.state ?? (checkGeminiConfigured() ? 'error' : 'not_configured'),
    aiErrorMessage,
    executedSteps,
  }

  const documentCategory: 'question_document' | 'composite_document' =
    agentFiles.every((f) => f.assignedRole === 'composite_file' || f.assignedRole === 'irrelevant_file') &&
    finalQuestions.some((q) => q.questionOrigin === 'ai_generated')
      ? 'composite_document'
      : 'question_document'

  const answerProvisionMode: AnswerProvisionMode = firstAnswerFile
    ? 'separate_answer_file'
    : 'embedded_in_file'

  const completedStages = [
    'classify_files',
    'extract_questions',
    'match_tier1_code',
    'match_tier2_lesson',
    'match_tier3_stem',
    'secondary_deep_search',
  ]
  if (ranTier4Ai || aiUsed) completedStages.push('match_tier4_ai')

  const checkpoint: AgentResumeCheckpoint = {
    completedStages,
    updatedAt: new Date().toISOString(),
    pairedSets,
    answerContextSnippets: buildCompactAnswerContextSnippets(
      params.files,
      agentFiles,
      answerPacks,
      plainTexts
    ),
  }

  const documentAnalysis: CompositeDocumentAnalysis = {
    documentSummary:
      mergedSummaries.join('\n\n') ||
      `TIN LAB Document AI Agent đã xử lý ${completedFiles}/${agentFiles.length} tệp: trích xuất ${finalQuestions.length} câu hỏi (${verifiedCount} từ nguồn, ${aiProposedCount} AI đề xuất, ${needsReviewCount} cần kiểm tra, ${missingCount} thiếu đáp án, ${ambiguousCount} xung đột).`,
    detectedTopics: Array.from(mergedTopics),
    detectedLessons: Array.from(mergedLessons),
    knowledgeUnits: mergedUnits,
    agentFiles,
    agentSummary,
    pairedSets,
    checkpoint,
  }

  return {
    primaryFileName: primaryReport?.fileName ?? params.files[0]?.fileName ?? 'tai-lieu.docx',
    primaryFileFormat: primaryReport?.fileFormat ?? params.files[0]?.fileFormat ?? 'docx',
    primaryFileHash: primaryReport?.fileHash ?? sha256Hex('empty'),
    pageCount: primaryReport?.pageCount ?? null,
    documentCategory,
    answerProvisionMode,
    answerFileName: firstAnswerFile,
    questions: finalQuestions,
    agentFiles,
    agentSummary,
    documentAnalysis,
    warnings: Array.from(new Set(warnings)),
  }
}

export async function resumeIncompleteAgentQuestions(params: {
  draftAnalysis?: CompositeDocumentAnalysis | null
  questions: ExtractedQuestion[]
  mode: 'continue_incomplete' | 'rematch_selected'
  selectedTempIds?: string[]
  answerContextOverrides?: Array<{ fileName: string; text: string }>
  onProgress?: ExtractionProgressCallback
}): Promise<{
  questions: ExtractedQuestion[]
  agentSummary: AgentAnalysisSummary
  documentAnalysis: CompositeDocumentAnalysis
  processedCount: number
  updatedCount: number
  warnings: string[]
}> {
  const warnings: string[] = []
  const workingQuestions: ExtractedQuestion[] = params.questions.map((q) => ({ ...q }))
  const selectedSet = new Set(params.selectedTempIds ?? [])

  const targetIndices: number[] = []
  for (let i = 0; i < workingQuestions.length; i++) {
    const q = workingQuestions[i]
    // Never mutate already verified or approved questions
    if (q.answerStatus === 'verified' || q.reviewDecision === 'approved') {
      continue
    }
    if (params.mode === 'rematch_selected') {
      if (selectedSet.has(q.tempId)) targetIndices.push(i)
    } else {
      if (
        q.answerStatus === 'missing' ||
        q.answerStatus === 'needs_review' ||
        q.answerStatus === 'ambiguous'
      ) {
        targetIndices.push(i)
      }
    }
  }

  let updatedCount = 0
  const savedSnippets = params.draftAnalysis?.checkpoint?.answerContextSnippets ?? []
  const overrideContexts = params.answerContextOverrides ?? []

  // Combine saved checkpoint excerpts & any extra answer context
  const contextBlocks = [
    ...savedSnippets.map((s) => `=== NGUỒN ĐÃ LƯU: ${s.fileName} ===\n${s.rawExcerpt}`),
    ...overrideContexts.map((o) => `=== NGUỒN BỔ SUNG: ${o.fileName} ===\n${o.text.slice(0, 18000)}`),
  ]
  const combinedAnswerContext = contextBlocks.join('\n\n').slice(0, 42000)

  // First try deterministic quick check if answerContextOverrides or savedSnippets contain TXT answer lines
  if (targetIndices.length > 0 && contextBlocks.length > 0) {
    try {
      const packs: AnswerPack[] = []
      for (const s of savedSnippets) {
        if (s.rawExcerpt.trim().length > 10) {
          const parsedAns = await parseSeparateAnswerKeyDocument(
            Buffer.from(s.rawExcerpt, 'utf8'),
            'txt'
          )
          packs.push({ fileName: s.fileName, parsed: parsedAns })
        }
      }
      for (const ov of overrideContexts) {
        if (ov.text.trim().length > 10) {
          const parsedAns = await parseSeparateAnswerKeyDocument(
            Buffer.from(ov.text, 'utf8'),
            'txt'
          )
          packs.push({ fileName: ov.fileName, parsed: parsedAns })
        }
      }
      if (packs.length > 0) {
        const subset = targetIndices.map((idx) => workingQuestions[idx])
        // First check structured lesson_and_number keys from overrides / saved snippets
        for (const q of subset) {
          if (q.answerStatus === 'verified') continue
          const numKey = getNumericKey(q.questionNumber)
          if (!numKey) continue
          const lKey = extractLessonKey(q.lessonTitle) ?? '__root__'
          for (const pack of [...packs].reverse()) {
            if (q.questionType === 'multiple_choice') {
              const hit = pack.parsed.registry.lookupMcq(lKey, numKey, lKey === '__root__')
              if (hit.entry && !hit.entry.ambiguous && hit.entry.keys.size === 1) {
                const key = Array.from(hit.entry.keys)[0]
                q.answerKey = key
                q.answerStatus = 'verified'
                q.confidenceScore = 94
                q.confidenceLevel = 'high'
                q.matchMethod = 'lesson_and_number'
                q.answerSource = `Đối chiếu lại (${pack.fileName} · ${hit.scopeLabel})`
                q.answerNote = `Đã đối chiếu đáp án ${key} theo Bài học & Số câu.`
                if (!q.explanation && hit.explanation) {
                  q.explanation = hit.explanation.slice(0, 3000)
                }
                updatedCount += 1
                break
              }
            } else if (q.questionType === 'true_false') {
              const hit = pack.parsed.registry.lookupTf(lKey, numKey, lKey === '__root__')
              if (hit.entry) {
                const sa = !hit.entry.ambiguous.a && hit.entry.statements.a.size === 1 ? Array.from(hit.entry.statements.a)[0] : null
                const sb = !hit.entry.ambiguous.b && hit.entry.statements.b.size === 1 ? Array.from(hit.entry.statements.b)[0] : null
                const sc = !hit.entry.ambiguous.c && hit.entry.statements.c.size === 1 ? Array.from(hit.entry.statements.c)[0] : null
                const sd = !hit.entry.ambiguous.d && hit.entry.statements.d.size === 1 ? Array.from(hit.entry.statements.d)[0] : null
                if (sa !== null && sb !== null && sc !== null && sd !== null) {
                  q.statementAnswerA = sa
                  q.statementAnswerB = sb
                  q.statementAnswerC = sc
                  q.statementAnswerD = sd
                  q.answerStatus = 'verified'
                  q.confidenceScore = 94
                  q.confidenceLevel = 'high'
                  q.matchMethod = 'lesson_and_number'
                  q.answerSource = `Đối chiếu lại (${pack.fileName} · ${hit.scopeLabel})`
                  q.answerNote = 'Đã đối chiếu đủ 4 đáp án Đúng/Sai theo Bài học & Số câu.'
                  if (!q.explanation && hit.explanation) {
                    q.explanation = hit.explanation.slice(0, 3000)
                  }
                  updatedCount += 1
                  break
                }
              }
            } else if (q.questionType === 'essay') {
              const hit = pack.parsed.registry.lookupEssay(lKey, numKey, lKey === '__root__')
              if (hit && hit.rubricParts.length > 0) {
                const rub = hit.rubricParts.join('\n').trim().slice(0, 4000)
                if (rub.length >= 5) {
                  q.rubric = rub
                  q.answerStatus = 'verified'
                  q.confidenceScore = 92
                  q.confidenceLevel = 'high'
                  q.matchMethod = 'lesson_and_number'
                  q.answerSource = `Đối chiếu lại (${pack.fileName})`
                  q.answerNote = 'Đã đối chiếu Rubric tự luận theo Bài học & Số câu.'
                  updatedCount += 1
                  break
                }
              }
            }
          }
        }
        const stillUnverified = subset.filter((q) => q.answerStatus !== 'verified')
        if (stillUnverified.length > 0) {
          const rescued = runSecondaryDeepSearchPass(stillUnverified, packs)
          updatedCount += rescued
        }
      }
    } catch {
      // Non-fatal deterministic pass
    }
  }

  const remainingIndices = targetIndices.filter(
    (idx) => workingQuestions[idx].answerStatus !== 'verified'
  )

  const geminiStatus = await verifyGeminiApiConnection(false)
  let aiUsed = false
  let aiErrorMessage: string | null = geminiStatus.connected ? null : geminiStatus.message

  if (remainingIndices.length > 0) {
    if (!geminiStatus.connected) {
      warnings.push(
        `${geminiStatus.message} Hãy cấu hình GEMINI_API_KEY trong Settings > Secrets để AI Agent tiếp tục đối chiếu ${remainingIndices.length} câu chưa hoàn thành.`
      )
    } else {
      const aiClient = getGeminiClient()
      if (aiClient) {
        aiUsed = true
        params.onProgress?.({
          step: 'ai_extract',
          stepLabel: `AI Agent đang xử lý ${remainingIndices.length} câu chưa hoàn thành...`,
          progress: 55,
        })

        const batches: number[][] = []
        for (let i = 0; i < remainingIndices.length; i += 15) {
          batches.push(remainingIndices.slice(i, i + 15))
        }

        try {
          await runWithConcurrency(batches, 2, async (idxBatch) => {
            const payload = idxBatch.map((idx) => {
              const q = workingQuestions[idx]
              return {
                tempId: q.tempId,
                questionType: q.questionType,
                questionCode: q.questionCode || '',
                lessonTitle: q.lessonTitle,
                questionNumber: q.questionNumber,
                questionText: q.questionText.slice(0, 350),
                optionsOrStatements:
                  q.questionType === 'multiple_choice'
                    ? { A: q.optionA, B: q.optionB, C: q.optionC, D: q.optionD }
                    : q.questionType === 'true_false'
                    ? { a: q.statementA, b: q.statementB, c: q.statementC, d: q.statementD }
                    : undefined,
                previousNote: q.answerNote,
              }
            })

            const hasSourceContext = combinedAnswerContext.trim().length > 20
            const prompt = [
              'Bạn là TIN LAB Document AI Agent đang thực hiện ĐỐI CHIẾU BỔ SUNG / XỬ LÝ CÂU CHƯA HOÀN THÀNH.',
              hasSourceContext
                ? 'Hãy đối chiếu từng câu hỏi với nguồn đáp án/giải thích đính kèm bên dưới để đề xuất đáp án chính xác và giải thích.'
                : 'Chưa có file đáp án riêng đính kèm; hãy phân tích chuyên sâu nội dung câu hỏi Tin học và các phương án để ĐỀ XUẤT đáp án (mọi đề xuất sẽ được Super Admin duyệt trước khi lưu).',
              'Không ghép chéo câu hỏi thuộc hai Bài học khác nhau nếu có file đáp án.',
              'Trả về confidenceScore (0..100).',
              '',
              'Danh sách câu cần xử lý:',
              JSON.stringify(payload),
              hasSourceContext ? `\n=== NGỮ CẢNH ĐÁP ÁN ===\n${combinedAnswerContext}` : '',
            ]
              .filter(Boolean)
              .join('\n')

            const resp = await aiClient.models.generateContent({
              model: GEMINI_MODEL,
              contents: prompt,
              config: {
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    matches: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          tempId: { type: Type.STRING },
                          answerKey: { type: Type.STRING, nullable: true },
                          statementAnswerA: { type: Type.BOOLEAN, nullable: true },
                          statementAnswerB: { type: Type.BOOLEAN, nullable: true },
                          statementAnswerC: { type: Type.BOOLEAN, nullable: true },
                          statementAnswerD: { type: Type.BOOLEAN, nullable: true },
                          rubric: { type: Type.STRING },
                          explanation: { type: Type.STRING },
                          confidenceScore: { type: Type.INTEGER },
                          reasoning: { type: Type.STRING },
                          sourceFileName: { type: Type.STRING },
                        },
                        required: ['tempId', 'confidenceScore'],
                      },
                    },
                  },
                  required: ['matches'],
                },
              },
            })

            const raw = resp.text?.trim()
            if (!raw) return
            const parsed = JSON.parse(stripJsonMarkdownFence(raw)) as {
              matches?: Array<{
                tempId?: string
                answerKey?: string | null
                statementAnswerA?: boolean | null
                statementAnswerB?: boolean | null
                statementAnswerC?: boolean | null
                statementAnswerD?: boolean | null
                rubric?: string
                explanation?: string
                confidenceScore?: number
                reasoning?: string
                sourceFileName?: string
              }>
            }

            const byId = new Map(idxBatch.map((idx) => [workingQuestions[idx].tempId, workingQuestions[idx]]))
            for (const m of parsed.matches ?? []) {
              const q = m.tempId ? byId.get(m.tempId) : undefined
              if (!q || q.answerStatus === 'verified') continue
              const conf = Math.max(0, Math.min(100, Math.round(Number(m.confidenceScore) || 0)))
              if (conf < 50) continue

              const key = normalizeMcqKey(m.answerKey)
              const sa = normalizeBoolOrNull(m.statementAnswerA)
              const sb = normalizeBoolOrNull(m.statementAnswerB)
              const sc = normalizeBoolOrNull(m.statementAnswerC)
              const sd = normalizeBoolOrNull(m.statementAnswerD)
              const rub = m.rubric?.trim() ?? ''

              const hasProposal =
                (q.questionType === 'multiple_choice' && key !== null) ||
                (q.questionType === 'true_false' &&
                  sa !== null &&
                  sb !== null &&
                  sc !== null &&
                  sd !== null) ||
                (q.questionType === 'essay' && rub.length >= 5)

              if (!hasProposal) continue

              const srcFile =
                m.sourceFileName?.trim() ||
                savedSnippets[0]?.fileName ||
                q.sourceDocumentName
              q.aiSuggestion = {
                suggestedAnswerKey: q.questionType === 'multiple_choice' ? key : null,
                suggestedStatementA: q.questionType === 'true_false' ? sa : null,
                suggestedStatementB: q.questionType === 'true_false' ? sb : null,
                suggestedStatementC: q.questionType === 'true_false' ? sc : null,
                suggestedStatementD: q.questionType === 'true_false' ? sd : null,
                suggestedRubric: q.questionType === 'essay' ? rub.slice(0, 3000) : '',
                suggestedExplanation: m.explanation?.trim().slice(0, 2000) ?? '',
                confidenceScore: conf,
                confidenceLevel: confidenceLevelFromScore(conf),
                matchMethod: hasSourceContext ? 'context_and_explanation' : 'ai_semantic_match',
                reasoning: m.reasoning?.trim() || 'AI Agent đề xuất sau khi đối chiếu lại.',
                sourceFileName: srcFile,
                applied: false,
              }
              q.confidenceScore = conf
              q.confidenceLevel = confidenceLevelFromScore(conf)
              q.matchMethod = hasSourceContext ? 'context_and_explanation' : 'ai_semantic_match'
              if (m.explanation?.trim() && !q.explanation) {
                q.explanation = m.explanation.trim().slice(0, 3000)
              }

              if (conf >= 80) {
                q.answerStatus = 'ai_proposed'
                q.answerSource = `AI đề xuất (chưa xác nhận) · ${srcFile} (${conf}%)`
                q.answerNote = `AI Agent đề xuất đáp án (${conf}%) sau khi đối chiếu lại — chờ Super Admin xác nhận.`
              } else {
                q.answerStatus = 'needs_review'
                q.answerSource = `Đề xuất AI (${srcFile} · ${conf}%)`
                q.answerNote = `AI đề xuất đáp án (${conf}%) — giữ ở trạng thái Cần kiểm tra.`
              }
              updatedCount += 1
            }
          })
        } catch (err) {
          updateCachedGeminiStatusFromError(err)
          const classified = classifyGeminiApiError(err)
          aiErrorMessage = classified.userMessage
          warnings.push(classified.userMessage)
        }
      }
    }
  }

  const verifiedCount = workingQuestions.filter((q) => q.answerStatus === 'verified').length
  const aiProposedCount = workingQuestions.filter((q) => q.answerStatus === 'ai_proposed').length
  const needsReviewCount = workingQuestions.filter((q) => q.answerStatus === 'needs_review').length
  const missingCount = workingQuestions.filter((q) => q.answerStatus === 'missing').length
  const ambiguousCount = workingQuestions.filter((q) => q.answerStatus === 'ambiguous').length
  const duplicateCount = workingQuestions.filter((q) => q.duplicateInFile).length
  const averageConfidence =
    workingQuestions.length > 0
      ? Math.round(
          workingQuestions.reduce((sum, q) => sum + (q.confidenceScore ?? 0), 0) /
            workingQuestions.length
        )
      : 0

  const prevAnalysis = params.draftAnalysis
  const prevSummary = prevAnalysis?.agentSummary
  const prevFiles = prevAnalysis?.agentFiles ?? []

  const agentSummary: AgentAnalysisSummary = {
    totalFiles: prevSummary?.totalFiles ?? prevFiles.length ?? 1,
    completedFiles: prevSummary?.completedFiles ?? prevFiles.length ?? 1,
    failedFiles: prevSummary?.failedFiles ?? 0,
    totalQuestions: workingQuestions.length,
    verifiedCount,
    aiProposedCount,
    needsReviewCount,
    missingCount,
    ambiguousCount,
    duplicateCount,
    averageConfidence,
    aiUsed: Boolean(prevSummary?.aiUsed || aiUsed),
    aiConnectionState: geminiStatus.state,
    aiErrorMessage,
    executedSteps: [
      ...(prevSummary?.executedSteps ?? []),
      {
        stepNumber: (prevSummary?.executedSteps?.length ?? 7) + 1,
        title:
          params.mode === 'rematch_selected'
            ? 'Đối chiếu lại các câu hỏi được chọn'
            : 'AI Agent tiếp tục xử lý câu chưa hoàn thành',
        status: (updatedCount > 0 ? 'completed' : aiErrorMessage ? 'partial' : 'completed') as AgentPipelineStepRecord['status'],
        detail: `Đã kiểm tra ${targetIndices.length} câu, cập nhật đề xuất mới cho ${updatedCount} câu.`,
      },
    ].slice(-12),
  }

  const prevCheckpoint = prevAnalysis?.checkpoint
  const completedStages = Array.from(
    new Set([
      ...(prevCheckpoint?.completedStages ?? []),
      params.mode === 'rematch_selected' ? 'rematch_selected' : 'resume_incomplete',
    ])
  )

  const documentAnalysis: CompositeDocumentAnalysis = {
    documentSummary:
      prevAnalysis?.documentSummary ??
      `Đã cập nhật trạng thái xử lý: ${verifiedCount} từ nguồn, ${aiProposedCount} AI đề xuất, ${needsReviewCount} cần kiểm tra, ${missingCount} thiếu đáp án.`,
    detectedTopics: prevAnalysis?.detectedTopics ?? [],
    detectedLessons: prevAnalysis?.detectedLessons ?? [],
    knowledgeUnits: prevAnalysis?.knowledgeUnits ?? [],
    agentFiles: prevFiles,
    agentSummary,
    pairedSets: prevAnalysis?.pairedSets ?? prevCheckpoint?.pairedSets ?? [],
    checkpoint: {
      completedStages,
      updatedAt: new Date().toISOString(),
      pairedSets: prevAnalysis?.pairedSets ?? prevCheckpoint?.pairedSets ?? [],
      answerContextSnippets: savedSnippets,
    },
  }

  return {
    questions: workingQuestions,
    agentSummary,
    documentAnalysis,
    processedCount: targetIndices.length,
    updatedCount,
    warnings,
  }
}

/* ============================================================================
 * BATCH EXCEPTION RESOLUTION ENGINE (SOURCE -> EXISTING BANK -> GEMINI AI)
 * ========================================================================== */

function isStructurallyValidExceptionCandidate(q: ExtractedQuestion): boolean {
  const stem = (q.questionText ?? '').trim()
  if (stem.length < 5) return false
  if (q.questionType === 'multiple_choice') {
    return Boolean(
      q.optionA?.trim() &&
        q.optionB?.trim() &&
        q.optionC?.trim() &&
        q.optionD?.trim()
    )
  }
  if (q.questionType === 'true_false') {
    return Boolean(
      q.statementA?.trim() &&
        q.statementB?.trim() &&
        q.statementC?.trim() &&
        q.statementD?.trim()
    )
  }
  return true
}

function tryMatchFromExistingQuestionBank(
  q: ExtractedQuestion,
  hints: BatchResolveExistingBankHint[]
): {
  matched: boolean
  sourceLabel?: string
  answerKey?: AnswerOptionKey
  statementAnswers?: [boolean, boolean, boolean, boolean]
  rubric?: string
  explanation?: string
  similarity?: number
} {
  if (hints.length === 0) return { matched: false }

  let bestHint: BatchResolveExistingBankHint | null = null
  let bestSim = 0

  for (const hint of hints) {
    if (hint.questionType !== q.questionType) continue
    const sim = computeStemSimilarity(q.questionText, hint.questionText)
    if (sim > bestSim) {
      bestSim = sim
      bestHint = hint
    }
  }

  if (!bestHint || bestSim < 0.88) {
    return { matched: false }
  }

  const label = bestHint.sourceDocumentName
    ? `Ngân hàng câu hỏi hiện có (${bestHint.sourceDocumentName})`
    : 'Ngân hàng câu hỏi hiện có'

  if (q.questionType === 'multiple_choice') {
    const hintKey = normalizeMcqKey(bestHint.answerKey)
    if (!hintKey) return { matched: false }
    const hintOpts: Record<AnswerOptionKey, string> = {
      A: (bestHint.optionA ?? '').trim(),
      B: (bestHint.optionB ?? '').trim(),
      C: (bestHint.optionC ?? '').trim(),
      D: (bestHint.optionD ?? '').trim(),
    }
    const qOpts: Record<AnswerOptionKey, string> = {
      A: (q.optionA ?? '').trim(),
      B: (q.optionB ?? '').trim(),
      C: (q.optionC ?? '').trim(),
      D: (q.optionD ?? '').trim(),
    }

    const correctHintText = hintOpts[hintKey]
    if (!correctHintText) return { matched: false }

    // Map correct answer text to the exact option slot in q (handles shuffled options safely)
    let matchedSlot: AnswerOptionKey | null = null
    let matchedSlotSim = 0
    let matchedOptionCount = 0

    for (const qKey of VALID_MCQ_KEYS) {
      const qOptText = qOpts[qKey]
      if (!qOptText) continue
      const simWithCorrect = computeStemSimilarity(qOptText, correctHintText)
      if (simWithCorrect > matchedSlotSim) {
        matchedSlotSim = simWithCorrect
        matchedSlot = qKey
      }
      const matchesAnyHintOpt = VALID_MCQ_KEYS.some(
        (hk) => hintOpts[hk] && computeStemSimilarity(qOptText, hintOpts[hk]) >= 0.78
      )
      if (matchesAnyHintOpt) matchedOptionCount += 1
    }

    if (matchedSlot && matchedSlotSim >= 0.82 && matchedOptionCount >= 3) {
      return {
        matched: true,
        sourceLabel: label,
        answerKey: matchedSlot,
        explanation: bestHint.explanation?.trim() || undefined,
        similarity: bestSim,
      }
    }
    return { matched: false }
  }

  if (q.questionType === 'true_false') {
    const hAns = [
      normalizeBoolOrNull(bestHint.statementAnswerA),
      normalizeBoolOrNull(bestHint.statementAnswerB),
      normalizeBoolOrNull(bestHint.statementAnswerC),
      normalizeBoolOrNull(bestHint.statementAnswerD),
    ]
    if (hAns.some((v) => v === null)) return { matched: false }
    const hTexts = [
      (bestHint.statementA ?? '').trim(),
      (bestHint.statementB ?? '').trim(),
      (bestHint.statementC ?? '').trim(),
      (bestHint.statementD ?? '').trim(),
    ]
    const qTexts = [
      (q.statementA ?? '').trim(),
      (q.statementB ?? '').trim(),
      (q.statementC ?? '').trim(),
      (q.statementD ?? '').trim(),
    ]

    const mapped: boolean[] = []
    for (const qt of qTexts) {
      let bestIdx = -1
      let bestStSim = 0
      for (let i = 0; i < 4; i++) {
        const s = computeStemSimilarity(qt, hTexts[i])
        if (s > bestStSim) {
          bestStSim = s
          bestIdx = i
        }
      }
      if (bestIdx === -1 || bestStSim < 0.8) {
        return { matched: false }
      }
      mapped.push(hAns[bestIdx] as boolean)
    }

    return {
      matched: true,
      sourceLabel: label,
      statementAnswers: [mapped[0], mapped[1], mapped[2], mapped[3]],
      explanation: bestHint.explanation?.trim() || undefined,
      similarity: bestSim,
    }
  }

  // Essay
  const rub = (bestHint.rubric ?? '').trim()
  if (bestSim >= 0.9 && rub.length >= 5) {
    return {
      matched: true,
      sourceLabel: label,
      rubric: rub.slice(0, 4000),
      explanation: bestHint.explanation?.trim() || undefined,
      similarity: bestSim,
    }
  }
  return { matched: false }
}

function classifyEvidenceSourceType(raw: unknown): AiAnswerSourceType | 'insufficient_evidence' {
  if (typeof raw !== 'string') return 'insufficient_evidence'
  const v = raw.trim().toLowerCase()
  if (v === 'source_document') return 'source_document'
  if (v === 'separate_answer_file') return 'separate_answer_file'
  if (v === 'composite_document') return 'composite_document'
  if (v === 'existing_bank') return 'existing_bank'
  if (v === 'ai_knowledge') return 'ai_knowledge'
  return 'insufficient_evidence'
}

function sourceTypeLabelVi(sourceType: AiAnswerSourceType): string {
  switch (sourceType) {
    case 'source_document':
      return 'Tài liệu gốc'
    case 'separate_answer_file':
      return 'File đáp án riêng'
    case 'composite_document':
      return 'Tài liệu tổng hợp'
    case 'existing_bank':
      return 'Ngân hàng câu hỏi hiện có'
    case 'ai_knowledge':
      return 'Kiến thức chuyên môn AI'
    default:
      return 'Chưa có nguồn'
  }
}

export async function resolveExceptionQuestionsBatch(params: {
  questions: ExtractedQuestion[]
  draftAnalysis?: CompositeDocumentAnalysis | null
  existingBankHints?: BatchResolveExistingBankHint[]
  sourceContextOverrides?: Array<{ fileName: string; role?: AgentFileRole; text: string }>
  allowAiKnowledgeFallback?: boolean
  autoMarkAiProposed?: boolean
  subBatchSize?: number
}): Promise<{
  questions: ExtractedQuestion[]
  stats: BatchExceptionResolveStats
  failedTempIds: string[]
  aiUsed: boolean
  aiUnavailable: boolean
  aiConnectionState: GeminiConnectionInfo['state']
  aiErrorMessage: string | null
  warnings: string[]
}> {
  const nowIso = new Date().toISOString()
  const warnings: string[] = []
  const allowAiKnowledge = params.allowAiKnowledgeFallback !== false
  const autoMarkAiProposed = params.autoMarkAiProposed !== false
  const subBatchSize = Math.max(1, Math.min(12, Math.floor(params.subBatchSize ?? 8)))
  const bankHints = params.existingBankHints ?? []

  // Deep-clone questions while strictly preserving originalQuestionText & questionText
  const working: ExtractedQuestion[] = params.questions.map((q) => ({
    ...q,
    originalQuestionText: q.originalQuestionText || q.questionText,
    aiBatchError: null,
  }))

  const stats: BatchExceptionResolveStats = {
    totalRequested: working.length,
    processedCount: 0,
    foundInSourceCount: 0,
    aiProposedCount: 0,
    needsReviewCount: 0,
    notFoundCount: 0,
    invalidOrDuplicateCount: 0,
    failedCount: 0,
  }
  const failedTempIdSet = new Set<string>()

  // Step 0: Guard duplicates, skipped items, and structurally invalid items
  const eligibleIndices: number[] = []
  for (let i = 0; i < working.length; i++) {
    const q = working[i]
    if (q.skippedInImport) {
      q.exceptionCategory = 'skipped_in_import'
      continue
    }
    if (q.duplicateInFile || q.duplicateInBank || !isStructurallyValidExceptionCandidate(q)) {
      q.exceptionCategory = 'invalid_or_duplicate'
      q.aiProcessedAt = nowIso
      stats.invalidOrDuplicateCount += 1
      stats.processedCount += 1
      continue
    }
    if (q.answerStatus === 'verified') {
      q.exceptionCategory = 'found_in_source'
      stats.foundInSourceCount += 1
      stats.processedCount += 1
      continue
    }
    eligibleIndices.push(i)
  }

  // Step 1: Deterministic matching from saved source/answer excerpts & overrides
  const savedSnippets = params.draftAnalysis?.checkpoint?.answerContextSnippets ?? []
  const overrideContexts = params.sourceContextOverrides ?? []

  const contextBlocks = [
    ...savedSnippets.map(
      (s) =>
        `=== NGUỒN (${s.role || 'source_document'}): ${s.fileName} ===\n${s.rawExcerpt}`
    ),
    ...overrideContexts.map(
      (o) =>
        `=== NGUỒN (${o.role || 'source_document'}): ${o.fileName} ===\n${o.text.slice(0, 18000)}`
    ),
  ]
  const combinedSourceContext = contextBlocks.join('\n\n').slice(0, 42000)

  if (eligibleIndices.length > 0 && contextBlocks.length > 0) {
    try {
      const packs: Array<AnswerPack & { sourceType: AiAnswerSourceType }> = []
      for (const s of savedSnippets) {
        if (s.rawExcerpt.trim().length > 10) {
          const parsedAns = await parseSeparateAnswerKeyDocument(
            Buffer.from(s.rawExcerpt, 'utf8'),
            'txt'
          )
          const st: AiAnswerSourceType =
            s.role === 'answer_file' || s.role === 'solution_guide'
              ? 'separate_answer_file'
              : s.role === 'composite_file'
              ? 'composite_document'
              : 'source_document'
          packs.push({ fileName: s.fileName, parsed: parsedAns, sourceType: st })
        }
      }
      for (const ov of overrideContexts) {
        if (ov.text.trim().length > 10) {
          const parsedAns = await parseSeparateAnswerKeyDocument(
            Buffer.from(ov.text, 'utf8'),
            'txt'
          )
          const st: AiAnswerSourceType =
            ov.role === 'answer_file' || ov.role === 'solution_guide'
              ? 'separate_answer_file'
              : ov.role === 'composite_file'
              ? 'composite_document'
              : 'source_document'
          packs.push({ fileName: ov.fileName, parsed: parsedAns, sourceType: st })
        }
      }

      if (packs.length > 0) {
        const subset = eligibleIndices.map((idx) => working[idx])
        for (const q of subset) {
          if (q.answerStatus === 'verified') continue
          const qCode = q.questionCode || extractQuestionCode(q.questionText)
          let matchedByCode = false
          if (qCode) {
            for (const pack of [...packs].reverse()) {
              const snip = pack.parsed.byCode.get(qCode)
              if (!snip || snip.ambiguousConflict) continue
              if (q.questionType === 'multiple_choice' && snip.answerKey) {
                q.answerKey = snip.answerKey
                q.answerStatus = 'verified'
                q.aiProposedMarked = false
                q.aiSourceType = pack.sourceType
                q.aiProcessedAt = nowIso
                q.exceptionCategory = 'found_in_source'
                q.confidenceScore = 98
                q.confidenceLevel = 'high'
                q.matchMethod = 'question_code'
                q.answerSource = `Tìm thấy trong ${sourceTypeLabelVi(pack.sourceType)}: ${pack.fileName} (Mã ${qCode})`
                q.answerNote = `Đã tìm thấy đáp án ${snip.answerKey} theo mã câu ${qCode} trong nguồn chính thức (${pack.fileName}).`
                if (!q.explanation && snip.explanation) {
                  q.explanation = snip.explanation.slice(0, 3000)
                }
                q.aiSuggestion = null
                stats.foundInSourceCount += 1
                stats.processedCount += 1
                matchedByCode = true
                break
              } else if (
                q.questionType === 'true_false' &&
                snip.tfAnswers &&
                typeof snip.tfAnswers.a === 'boolean' &&
                typeof snip.tfAnswers.b === 'boolean' &&
                typeof snip.tfAnswers.c === 'boolean' &&
                typeof snip.tfAnswers.d === 'boolean'
              ) {
                q.statementAnswerA = snip.tfAnswers.a
                q.statementAnswerB = snip.tfAnswers.b
                q.statementAnswerC = snip.tfAnswers.c
                q.statementAnswerD = snip.tfAnswers.d
                q.answerStatus = 'verified'
                q.aiProposedMarked = false
                q.aiSourceType = pack.sourceType
                q.aiProcessedAt = nowIso
                q.exceptionCategory = 'found_in_source'
                q.confidenceScore = 98
                q.confidenceLevel = 'high'
                q.matchMethod = 'question_code'
                q.answerSource = `Tìm thấy trong ${sourceTypeLabelVi(pack.sourceType)}: ${pack.fileName} (Mã ${qCode})`
                q.answerNote = `Đã tìm thấy đủ 4 đáp án Đúng/Sai theo mã câu ${qCode} trong nguồn chính thức (${pack.fileName}).`
                if (!q.explanation && snip.explanation) {
                  q.explanation = snip.explanation.slice(0, 3000)
                }
                q.aiSuggestion = null
                stats.foundInSourceCount += 1
                stats.processedCount += 1
                matchedByCode = true
                break
              } else if (q.questionType === 'essay' && snip.rubric && snip.rubric.trim().length >= 5) {
                q.rubric = snip.rubric.trim().slice(0, 4000)
                q.answerStatus = 'verified'
                q.aiProposedMarked = false
                q.aiSourceType = pack.sourceType
                q.aiProcessedAt = nowIso
                q.exceptionCategory = 'found_in_source'
                q.confidenceScore = 96
                q.confidenceLevel = 'high'
                q.matchMethod = 'question_code'
                q.answerSource = `Tìm thấy trong ${sourceTypeLabelVi(pack.sourceType)}: ${pack.fileName} (Mã ${qCode})`
                q.answerNote = `Đã tìm thấy hướng dẫn chấm theo mã câu ${qCode} trong nguồn chính thức (${pack.fileName}).`
                q.aiSuggestion = null
                stats.foundInSourceCount += 1
                stats.processedCount += 1
                matchedByCode = true
                break
              }
            }
          }
          if (matchedByCode) continue

          const numKey = getNumericKey(q.questionNumber)
          if (!numKey) continue
          const lKey = extractLessonKey(q.lessonTitle) ?? '__root__'
          for (const pack of [...packs].reverse()) {
            if (q.questionType === 'multiple_choice') {
              const hit = pack.parsed.registry.lookupMcq(lKey, numKey, lKey === '__root__')
              if (hit.entry && !hit.entry.ambiguous && hit.entry.keys.size === 1) {
                const key = Array.from(hit.entry.keys)[0]
                q.answerKey = key
                q.answerStatus = 'verified'
                q.aiProposedMarked = false
                q.aiSourceType = pack.sourceType
                q.aiProcessedAt = nowIso
                q.exceptionCategory = 'found_in_source'
                q.confidenceScore = 95
                q.confidenceLevel = 'high'
                q.matchMethod = 'lesson_and_number'
                q.answerSource = `Tìm thấy trong ${sourceTypeLabelVi(pack.sourceType)}: ${pack.fileName} (${hit.scopeLabel})`
                q.answerNote = `Đã tìm thấy đáp án ${key} trong nguồn chính thức (${pack.fileName}).`
                if (!q.explanation && hit.explanation) {
                  q.explanation = hit.explanation.slice(0, 3000)
                }
                q.aiSuggestion = null
                stats.foundInSourceCount += 1
                stats.processedCount += 1
                break
              }
            } else if (q.questionType === 'true_false') {
              const hit = pack.parsed.registry.lookupTf(lKey, numKey, lKey === '__root__')
              if (hit.entry) {
                const sa =
                  !hit.entry.ambiguous.a && hit.entry.statements.a.size === 1
                    ? Array.from(hit.entry.statements.a)[0]
                    : null
                const sb =
                  !hit.entry.ambiguous.b && hit.entry.statements.b.size === 1
                    ? Array.from(hit.entry.statements.b)[0]
                    : null
                const sc =
                  !hit.entry.ambiguous.c && hit.entry.statements.c.size === 1
                    ? Array.from(hit.entry.statements.c)[0]
                    : null
                const sd =
                  !hit.entry.ambiguous.d && hit.entry.statements.d.size === 1
                    ? Array.from(hit.entry.statements.d)[0]
                    : null
                if (sa !== null && sb !== null && sc !== null && sd !== null) {
                  q.statementAnswerA = sa
                  q.statementAnswerB = sb
                  q.statementAnswerC = sc
                  q.statementAnswerD = sd
                  q.answerStatus = 'verified'
                  q.aiProposedMarked = false
                  q.aiSourceType = pack.sourceType
                  q.aiProcessedAt = nowIso
                  q.exceptionCategory = 'found_in_source'
                  q.confidenceScore = 95
                  q.confidenceLevel = 'high'
                  q.matchMethod = 'lesson_and_number'
                  q.answerSource = `Tìm thấy trong ${sourceTypeLabelVi(pack.sourceType)}: ${pack.fileName} (${hit.scopeLabel})`
                  q.answerNote = `Đã tìm thấy đủ 4 đáp án Đúng/Sai trong nguồn chính thức (${pack.fileName}).`
                  if (!q.explanation && hit.explanation) {
                    q.explanation = hit.explanation.slice(0, 3000)
                  }
                  q.aiSuggestion = null
                  stats.foundInSourceCount += 1
                  stats.processedCount += 1
                  break
                }
              }
            } else if (q.questionType === 'essay') {
              const hit = pack.parsed.registry.lookupEssay(lKey, numKey, lKey === '__root__')
              if (hit && hit.rubricParts.length > 0) {
                const rub = hit.rubricParts.join('\n').trim().slice(0, 4000)
                if (rub.length >= 5) {
                  q.rubric = rub
                  q.answerStatus = 'verified'
                  q.aiProposedMarked = false
                  q.aiSourceType = pack.sourceType
                  q.aiProcessedAt = nowIso
                  q.exceptionCategory = 'found_in_source'
                  q.confidenceScore = 93
                  q.confidenceLevel = 'high'
                  q.matchMethod = 'lesson_and_number'
                  q.answerSource = `Tìm thấy trong ${sourceTypeLabelVi(pack.sourceType)}: ${pack.fileName}`
                  q.answerNote = `Đã tìm thấy hướng dẫn chấm (Rubric) trong nguồn chính thức (${pack.fileName}).`
                  q.aiSuggestion = null
                  stats.foundInSourceCount += 1
                  stats.processedCount += 1
                  break
                }
              }
            }
          }
        }

        const afterDirect = subset.filter((q) => q.answerStatus !== 'verified')
        if (afterDirect.length > 0) {
          const beforeIds = new Set(
            afterDirect.filter((q) => q.answerStatus === 'verified').map((q) => q.tempId)
          )
          runSecondaryDeepSearchPass(afterDirect, packs)
          for (const q of afterDirect) {
            if (q.answerStatus === 'verified' && !beforeIds.has(q.tempId)) {
              q.aiProposedMarked = false
              q.aiSourceType = packs[0]?.sourceType ?? 'source_document'
              q.aiProcessedAt = nowIso
              q.exceptionCategory = 'found_in_source'
              q.aiSuggestion = null
              stats.foundInSourceCount += 1
              stats.processedCount += 1
            }
          }
        }
      }
    } catch {
      // Non-fatal deterministic pass
    }
  }

  // Step 2: Cross-reference Existing Question Bank for remaining unresolved items
  if (bankHints.length > 0) {
    for (const idx of eligibleIndices) {
      const q = working[idx]
      if (q.answerStatus === 'verified') continue
      const match = tryMatchFromExistingQuestionBank(q, bankHints)
      if (!match.matched) continue

      const simPct = Math.round((match.similarity ?? 0.92) * 100)
      if (q.questionType === 'multiple_choice' && match.answerKey) {
        q.answerKey = match.answerKey
      } else if (q.questionType === 'true_false' && match.statementAnswers) {
        q.statementAnswerA = match.statementAnswers[0]
        q.statementAnswerB = match.statementAnswers[1]
        q.statementAnswerC = match.statementAnswers[2]
        q.statementAnswerD = match.statementAnswers[3]
      } else if (q.questionType === 'essay' && match.rubric) {
        q.rubric = match.rubric
      } else {
        continue
      }

      q.answerStatus = 'verified'
      q.aiProposedMarked = false
      q.aiSourceType = 'existing_bank'
      q.aiProcessedAt = nowIso
      q.exceptionCategory = 'found_in_source'
      q.confidenceScore = Math.min(98, Math.max(90, simPct))
      q.confidenceLevel = 'high'
      q.matchMethod = 'stem_and_options'
      q.answerSource = `Tìm thấy trong ${match.sourceLabel} (khớp nội dung ${simPct}%)`
      q.answerNote = `Đã đối chiếu khớp đáp án chính thức từ ${match.sourceLabel}.`
      if (!q.explanation && match.explanation) {
        q.explanation = match.explanation.slice(0, 3000)
      }
      q.aiSuggestion = null
      stats.foundInSourceCount += 1
      stats.processedCount += 1
    }
  }

  // Step 3: Remaining unresolved questions -> Gemini AI Agent (sub-batched with per-batch fault isolation)
  const remainingForAiIndices = eligibleIndices.filter(
    (idx) => working[idx].answerStatus !== 'verified'
  )

  let aiUsed = false
  let aiUnavailable = false
  const geminiStatus = await verifyGeminiApiConnection(false)
  let aiConnectionState: GeminiConnectionInfo['state'] = geminiStatus.state
  let aiErrorMessage: string | null = geminiStatus.connected ? null : geminiStatus.message

  if (remainingForAiIndices.length > 0) {
    const aiClient = geminiStatus.connected ? getGeminiClient() : null
    if (!aiClient) {
      aiUnavailable = true
      const reason =
        geminiStatus.message ||
        'AI Agent chưa kết nối được Gemini API nên không thể tự đề xuất đáp án cho các câu chưa có trong nguồn.'
      aiErrorMessage = reason
      warnings.push(reason)
      for (const idx of remainingForAiIndices) {
        const q = working[idx]
        q.aiBatchError = reason
        q.aiProcessedAt = nowIso
        failedTempIdSet.add(q.tempId)
      }
      stats.failedCount = failedTempIdSet.size
    } else {
      aiUsed = true
      const subBatches: number[][] = []
      for (let i = 0; i < remainingForAiIndices.length; i += subBatchSize) {
        subBatches.push(remainingForAiIndices.slice(i, i + subBatchSize))
      }

      await runWithConcurrency(subBatches, 2, async (idxBatch) => {
        const payload = idxBatch.map((idx) => {
          const q = working[idx]
          return {
            tempId: q.tempId,
            questionType: q.questionType,
            questionCode: q.questionCode || '',
            lessonTitle: q.lessonTitle,
            topic: q.topic,
            questionNumber: q.questionNumber,
            sourceDocumentName: q.sourceDocumentName,
            questionText: q.questionText.slice(0, 1200),
            options:
              q.questionType === 'multiple_choice'
                ? {
                    A: q.optionA.slice(0, 500),
                    B: q.optionB.slice(0, 500),
                    C: q.optionC.slice(0, 500),
                    D: q.optionD.slice(0, 500),
                  }
                : undefined,
            statements:
              q.questionType === 'true_false'
                ? {
                    a: q.statementA.slice(0, 500),
                    b: q.statementB.slice(0, 500),
                    c: q.statementC.slice(0, 500),
                    d: q.statementD.slice(0, 500),
                  }
                : undefined,
            existingRubric: q.questionType === 'essay' ? q.rubric.slice(0, 500) : undefined,
            previousNote: q.answerNote,
          }
        })

        const hasSourceContext = combinedSourceContext.trim().length > 20
        const prompt = [
          'Bạn là TIN LAB Document AI Agent chuyên môn Tin học THPT (Chương trình GDPT 2018).',
          'Nhiệm vụ: Xử lý hàng loạt các câu hỏi ngoại lệ thiếu đáp án / cần kiểm tra.',
          '',
          'QUY TẮC BẮT BUỘC (TUYỆT ĐỐI TUÂN THỦ):',
          '1. Đọc kỹ đề câu hỏi, đầy đủ 4 phương án (A/B/C/D) hoặc 4 mệnh đề Đúng/Sai (a/b/c/d) hoặc yêu cầu Tự luận và ngữ cảnh tài liệu nguồn bên dưới.',
          '2. ƯU TIÊN TÌM TRONG TÀI LIỆU NGUỒN TRƯỚC: Nếu tìm thấy căn cứ rõ ràng trong ngữ cảnh tài liệu gốc / file đáp án riêng / tài liệu tổng hợp đính kèm, đặt evidenceType = "source_document" hoặc "separate_answer_file" hoặc "composite_document" và trích dẫn chính xác tên file / đoạn đối chiếu vào sourceReference.',
          allowAiKnowledge
            ? '3. NẾU KHÔNG TÌM THẤY TRONG NGUỒN: Bạn có thể vận dụng kiến thức chuyên môn Tin học THPT chuẩn xác để ĐỀ XUẤT đáp án, bắt buộc đặt evidenceType = "ai_knowledge", giải thích ngắn gọn rõ ràng bằng tiếng Việt trong explanation, nêu nguyên lý/căn cứ chuyên môn trong sourceReference và chấm confidenceScore trung thực (0..100).'
            : '3. Chỉ đối chiếu từ tài liệu nguồn; nếu không có trong nguồn thì đặt evidenceType = "insufficient_evidence".',
          '4. KHÔNG TỰ ĐIỀN ĐÁP ÁN KHI KHÔNG ĐỦ CĂN CỨ: Nếu câu hỏi thiếu hình vẽ, thiếu bảng dữ liệu, thiếu đoạn mã nguồn, câu hỏi bị cắt cụt, hoặc mơ hồ nhiều đáp án đúng -> BẮT BUỘC đặt evidenceType = "insufficient_evidence", giữ answerKey = null (hoặc statementAnswer = null, rubric = ""), confidenceScore <= 40, và giải thích rõ lý do trong reasoning.',
          '5. Không thay đổi nội dung câu hỏi gốc. Trả về đúng 1 phần tử cho MỖI tempId trong danh sách.',
          '',
          'Danh sách câu hỏi cần xử lý:',
          JSON.stringify(payload),
          hasSourceContext
            ? `\n=== NGỮ CẢNH TÀI LIỆU GỐC & FILE ĐÁP ÁN ===\n${combinedSourceContext}`
            : '\n(Không có trích đoạn file đáp án riêng đính kèm — hãy phân tích câu hỏi & kiến thức chuyên môn Tin học THPT, đánh dấu evidenceType = "ai_knowledge" nếu đủ căn cứ, hoặc "insufficient_evidence" nếu thiếu dữ kiện.)',
        ].join('\n')

        const executeGeminiCall = () =>
          aiClient.models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt,
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  results: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        tempId: { type: Type.STRING },
                        evidenceType: {
                          type: Type.STRING,
                          description:
                            'One of: source_document, separate_answer_file, composite_document, ai_knowledge, insufficient_evidence',
                        },
                        answerKey: { type: Type.STRING, nullable: true },
                        statementAnswerA: { type: Type.BOOLEAN, nullable: true },
                        statementAnswerB: { type: Type.BOOLEAN, nullable: true },
                        statementAnswerC: { type: Type.BOOLEAN, nullable: true },
                        statementAnswerD: { type: Type.BOOLEAN, nullable: true },
                        rubric: { type: Type.STRING },
                        explanation: { type: Type.STRING },
                        sourceReference: { type: Type.STRING },
                        reasoning: { type: Type.STRING },
                        confidenceScore: { type: Type.INTEGER },
                      },
                      required: ['tempId', 'evidenceType', 'confidenceScore', 'reasoning'],
                    },
                  },
                },
                required: ['results'],
              },
            },
          })

        try {
          let resp
          try {
            resp = await executeGeminiCall()
          } catch (firstErr) {
            const msgUpper = (
              firstErr instanceof Error ? firstErr.message : String(firstErr ?? '')
            ).toUpperCase()
            if (
              msgUpper.includes('429') ||
              msgUpper.includes('503') ||
              msgUpper.includes('UNAVAILABLE') ||
              msgUpper.includes('RESOURCE_EXHAUSTED')
            ) {
              await new Promise((r) => setTimeout(r, 1500))
              resp = await executeGeminiCall()
            } else {
              throw firstErr
            }
          }

          const raw = resp.text?.trim()
          if (!raw) {
            throw new Error('Gemini API trả về phản hồi rỗng cho lô câu hỏi này.')
          }

          const parsed = JSON.parse(stripJsonMarkdownFence(raw)) as {
            results?: Array<{
              tempId?: string
              evidenceType?: string
              answerKey?: string | null
              statementAnswerA?: boolean | null
              statementAnswerB?: boolean | null
              statementAnswerC?: boolean | null
              statementAnswerD?: boolean | null
              rubric?: string
              explanation?: string
              sourceReference?: string
              reasoning?: string
              confidenceScore?: number
            }>
          }

          const resultById = new Map(
            (parsed.results ?? [])
              .filter((r) => typeof r.tempId === 'string' && r.tempId.trim())
              .map((r) => [r.tempId!.trim(), r])
          )

          for (const idx of idxBatch) {
            const q = working[idx]
            const r = resultById.get(q.tempId)
            if (!r) {
              q.aiBatchError = 'Mô hình AI không trả về kết quả cho câu hỏi này — có thể bấm Thử lại.'
              q.aiProcessedAt = nowIso
              failedTempIdSet.add(q.tempId)
              continue
            }

            const evidenceType = classifyEvidenceSourceType(r.evidenceType)
            const conf = Math.max(0, Math.min(100, Math.round(Number(r.confidenceScore) || 0)))
            const key = normalizeMcqKey(r.answerKey)
            const sa = normalizeBoolOrNull(r.statementAnswerA)
            const sb = normalizeBoolOrNull(r.statementAnswerB)
            const sc = normalizeBoolOrNull(r.statementAnswerC)
            const sd = normalizeBoolOrNull(r.statementAnswerD)
            const rub = (r.rubric ?? '').trim().slice(0, 4000)
            const expl = (r.explanation ?? '').trim().slice(0, 2500)
            const reasoning =
              (r.reasoning ?? '').trim().slice(0, 600) ||
              'AI Agent đã phân tích nội dung câu hỏi và nguồn tham chiếu.'
            const sourceRef =
              (r.sourceReference ?? '').trim().slice(0, 220) ||
              (evidenceType === 'ai_knowledge'
                ? 'Kiến thức chuyên môn Tin học THPT'
                : savedSnippets[0]?.fileName || q.sourceDocumentName)

            const hasCompleteAnswer =
              (q.questionType === 'multiple_choice' && key !== null) ||
              (q.questionType === 'true_false' &&
                sa !== null &&
                sb !== null &&
                sc !== null &&
                sd !== null) ||
              (q.questionType === 'essay' && rub.length >= 5)

            q.aiProcessedAt = nowIso
            q.aiBatchError = null

            // Insufficient evidence or low confidence -> NEVER fill an answer
            if (
              evidenceType === 'insufficient_evidence' ||
              !hasCompleteAnswer ||
              conf < 50
            ) {
              q.answerStatus = 'missing'
              q.aiProposedMarked = false
              q.aiSourceType = 'none'
              q.exceptionCategory = 'not_found'
              q.confidenceScore = Math.min(conf, 45)
              q.confidenceLevel = 'low'
              q.matchMethod = 'unmatched'
              q.aiSuggestion = null
              q.answerSource = 'Không đủ căn cứ xác định đáp án'
              q.answerNote = reasoning
              stats.notFoundCount += 1
              stats.processedCount += 1
              continue
            }

            const isFromOfficialSource =
              evidenceType === 'source_document' ||
              evidenceType === 'separate_answer_file' ||
              evidenceType === 'composite_document' ||
              evidenceType === 'existing_bank'

            // High-confidence answer directly proven in provided source documents
            if (isFromOfficialSource && conf >= 85) {
              if (q.questionType === 'multiple_choice' && key) {
                q.answerKey = key
              } else if (
                q.questionType === 'true_false' &&
                sa !== null &&
                sb !== null &&
                sc !== null &&
                sd !== null
              ) {
                q.statementAnswerA = sa
                q.statementAnswerB = sb
                q.statementAnswerC = sc
                q.statementAnswerD = sd
              } else if (q.questionType === 'essay' && rub.length >= 5) {
                q.rubric = rub
              }

              q.answerStatus = 'verified'
              q.aiProposedMarked = false
              q.aiSourceType = evidenceType
              q.exceptionCategory = 'found_in_source'
              q.confidenceScore = conf
              q.confidenceLevel = 'high'
              q.matchMethod = 'context_and_explanation'
              q.answerSource = `Tìm thấy trong ${sourceTypeLabelVi(evidenceType)}: ${sourceRef} (${conf}%)`
              q.answerNote = reasoning
              if (expl && !q.explanation) {
                q.explanation = expl
              }
              q.aiSuggestion = null
              stats.foundInSourceCount += 1
              stats.processedCount += 1
              continue
            }

            // AI-proposed answer (either domain knowledge or medium-high source inference)
            const isAiProposedStar = conf >= 75
            const markedStar = autoMarkAiProposed && (evidenceType === 'ai_knowledge' || isAiProposedStar)
            const category: ExceptionResolutionCategory = isAiProposedStar
              ? 'ai_proposed_star'
              : 'needs_review'

            q.aiSuggestion = {
              suggestedAnswerKey: q.questionType === 'multiple_choice' ? key : null,
              suggestedStatementA: q.questionType === 'true_false' ? sa : null,
              suggestedStatementB: q.questionType === 'true_false' ? sb : null,
              suggestedStatementC: q.questionType === 'true_false' ? sc : null,
              suggestedStatementD: q.questionType === 'true_false' ? sd : null,
              suggestedRubric: q.questionType === 'essay' ? rub.slice(0, 3000) : '',
              suggestedExplanation: expl.slice(0, 2000),
              confidenceScore: conf,
              confidenceLevel: confidenceLevelFromScore(conf),
              matchMethod: isFromOfficialSource ? 'context_and_explanation' : 'ai_semantic_match',
              reasoning,
              sourceFileName: isFromOfficialSource
                ? savedSnippets[0]?.fileName || q.sourceDocumentName
                : 'Kiến thức chuyên môn AI (Tin học THPT)',
              sourceReference: sourceRef,
              sourceType: evidenceType,
              processedAt: nowIso,
              markedAsAiProposed: markedStar,
              applied: false,
            }

            q.answerStatus = isAiProposedStar ? 'ai_proposed' : 'needs_review'
            q.aiProposedMarked = markedStar
            q.aiSourceType = evidenceType
            q.exceptionCategory = category
            q.confidenceScore = conf
            q.confidenceLevel = confidenceLevelFromScore(conf)
            q.matchMethod = isFromOfficialSource ? 'context_and_explanation' : 'ai_semantic_match'
            q.answerSource =
              evidenceType === 'ai_knowledge'
                ? `[*] AI đề xuất (${conf}%) · ${sourceRef}`
                : `[*] AI suy luận từ nguồn (${conf}%) · ${sourceRef}`
            q.answerNote = isAiProposedStar
              ? `AI đề xuất đáp án (${conf}% tin cậy) — đã gắn nhãn * AI đề xuất, chưa ghi đè câu hỏi gốc.`
              : `Đề xuất AI độ tin cậy trung bình (${conf}%) — cần kiểm tra thêm trước khi chấp nhận.`
            if (expl && !q.explanation) {
              q.explanation = expl
            }

            if (isAiProposedStar) {
              stats.aiProposedCount += 1
            } else {
              stats.needsReviewCount += 1
            }
            stats.processedCount += 1
          }
        } catch (err) {
          updateCachedGeminiStatusFromError(err)
          const classified = classifyGeminiApiError(err)
          aiConnectionState = classified.state
          aiErrorMessage = classified.userMessage
          warnings.push(classified.userMessage)
          for (const idx of idxBatch) {
            const q = working[idx]
            q.aiBatchError = classified.userMessage
            q.aiProcessedAt = nowIso
            failedTempIdSet.add(q.tempId)
          }
        }
      })

      stats.failedCount = failedTempIdSet.size
    }
  }

  return {
    questions: working,
    stats,
    failedTempIds: Array.from(failedTempIdSet),
    aiUsed,
    aiUnavailable,
    aiConnectionState,
    aiErrorMessage,
    warnings: Array.from(new Set(warnings)),
  }
}
