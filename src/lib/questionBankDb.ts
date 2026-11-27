import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import type {
  AnswerOptionKey,
  CognitiveLevel,
  ExtractedQuestion,
  QuestionBankImportRecord,
  QuestionType,
  SavedQuestionBankItem,
  SourceFileFormat,
} from '../types'
import { auth, db, handleFirestoreError, OperationType } from './firebase'

const IMPORTS_COLLECTION = 'questionBankImports'
const QUESTIONS_COLLECTION = 'questionBank'

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const VALID_ANSWER_KEYS: ReadonlyArray<AnswerOptionKey> = ['A', 'B', 'C', 'D']
const VALID_QUESTION_TYPES: ReadonlyArray<QuestionType> = [
  'multiple_choice',
  'true_false',
  'essay',
]
const VALID_COGNITIVE_LEVELS: ReadonlyArray<CognitiveLevel> = [
  'recognition',
  'understanding',
  'application',
  'unspecified',
]

function normalizeForHash(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function sha256HexBrowser(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function computeQuestionContentHashBrowser(
  questionType: QuestionType,
  questionText: string,
  parts: string[]
): Promise<string> {
  const prefix = questionType === 'multiple_choice' ? '' : `${questionType}|`
  const canonical = `${prefix}${[questionText, ...parts]
    .map(normalizeForHash)
    .join('|')}`
  return sha256HexBrowser(canonical)
}

function timestampToMs(val: unknown): number | null {
  if (val instanceof Timestamp) {
    return val.toMillis()
  }
  return null
}

function sanitizeIdSegment(input: string, maxLen: number): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, maxLen)
}

export function buildDeterministicQuestionDocId(
  ownerUid: string,
  contentHash: string
): string {
  const uidPart = sanitizeIdSegment(ownerUid, 24)
  const hashPart = contentHash.slice(0, 40)
  return `${uidPart}_${hashPart}`
}

export interface QuestionBlueprintValidationInput {
  questionType: QuestionType
  bankName?: string
  topic?: string
  lessonTitle: string
  questionNumber: string
  pageNumber: number | null
  cognitiveLevel: CognitiveLevel
  questionText: string
  optionA: string
  optionB: string
  optionC: string
  optionD: string
  answerKey: AnswerOptionKey | null
  statementA: string
  statementB: string
  statementC: string
  statementD: string
  statementAnswerA: boolean | null
  statementAnswerB: boolean | null
  statementAnswerC: boolean | null
  statementAnswerD: boolean | null
  rubric: string
  sampleAnswer?: string
  explanation?: string
}

export function validateQuestionForBlueprint(
  q: QuestionBlueprintValidationInput
): string | null {
  const stem = q.questionText.trim()
  const lesson = q.lessonTitle.trim()
  const qNum = q.questionNumber.trim()
  const bankName = (q.bankName ?? '').trim()
  const topic = (q.topic ?? '').trim()
  const explanation = (q.explanation ?? '').trim()

  if (!VALID_QUESTION_TYPES.includes(q.questionType)) {
    return 'Loại câu hỏi không hợp lệ.'
  }
  if (stem.length < 5 || stem.length > 4000) {
    return 'Nội dung câu hỏi phải có từ 5 đến 4000 ký tự.'
  }
  if (lesson.length > 200) return 'Tên bài học không được vượt quá 200 ký tự.'
  if (bankName.length > 120) return 'Tên ngân hàng câu hỏi tối đa 120 ký tự.'
  if (topic.length > 150) return 'Tên chủ đề tối đa 150 ký tự.'
  if (explanation.length > 3000) return 'Giải thích tối đa 3000 ký tự.'
  if (qNum.length < 1 || qNum.length > 40) return 'Số thứ tự câu phải từ 1 đến 40 ký tự.'
  if (!VALID_COGNITIVE_LEVELS.includes(q.cognitiveLevel)) {
    return 'Mức độ nhận thức không hợp lệ.'
  }
  if (
    q.pageNumber !== null &&
    (!Number.isInteger(q.pageNumber) || q.pageNumber < 1 || q.pageNumber > 5000)
  ) {
    return 'Số trang phải là số nguyên từ 1 đến 5000 hoặc để trống.'
  }

  if (q.questionType === 'multiple_choice') {
    const optA = q.optionA.trim()
    const optB = q.optionB.trim()
    const optC = q.optionC.trim()
    const optD = q.optionD.trim()
    if (!optA || optA.length > 1500) return 'Phương án A phải từ 1 đến 1500 ký tự.'
    if (!optB || optB.length > 1500) return 'Phương án B phải từ 1 đến 1500 ký tự.'
    if (!optC || optC.length > 1500) return 'Phương án C phải từ 1 đến 1500 ký tự.'
    if (!optD || optD.length > 1500) return 'Phương án D phải từ 1 đến 1500 ký tự.'
    if (q.answerKey === null || !VALID_ANSWER_KEYS.includes(q.answerKey)) {
      return 'Chưa có đáp án A, B, C hoặc D được xác nhận.'
    }
  } else if (q.questionType === 'true_false') {
    const sA = q.statementA.trim()
    const sB = q.statementB.trim()
    const sC = q.statementC.trim()
    const sD = q.statementD.trim()
    if (!sA || sA.length > 1500) return 'Mệnh đề a) phải từ 1 đến 1500 ký tự.'
    if (!sB || sB.length > 1500) return 'Mệnh đề b) phải từ 1 đến 1500 ký tự.'
    if (!sC || sC.length > 1500) return 'Mệnh đề c) phải từ 1 đến 1500 ký tự.'
    if (!sD || sD.length > 1500) return 'Mệnh đề d) phải từ 1 đến 1500 ký tự.'
    if (
      q.statementAnswerA === null ||
      q.statementAnswerB === null ||
      q.statementAnswerC === null ||
      q.statementAnswerD === null
    ) {
      return 'Cần xác nhận đủ đáp án Đúng/Sai cho cả 4 ý a, b, c, d.'
    }
  } else {
    const rubric = q.rubric.trim()
    const sample = (q.sampleAnswer ?? '').trim()
    if (rubric.length < 5 || rubric.length > 4000) {
      return 'Câu tự luận cần có hướng dẫn chấm (Rubric) từ 5 đến 4000 ký tự.'
    }
    if (sample.length > 4000) {
      return 'Gợi ý trả lời mẫu không được vượt quá 4000 ký tự.'
    }
  }

  return null
}

export async function fetchTeacherImports(
  ownerUid: string
): Promise<QuestionBankImportRecord[]> {
  try {
    const q = query(
      collection(db, IMPORTS_COLLECTION),
      where('ownerUid', '==', ownerUid)
    )
    const snapshot = await getDocs(q)
    const items: QuestionBankImportRecord[] = snapshot.docs.map((docSnap) => {
      const d = docSnap.data()
      return {
        id: docSnap.id,
        ownerUid: String(d.ownerUid ?? ''),
        fileName: String(d.fileName ?? ''),
        fileFormat: (['docx', 'pdf', 'txt'].includes(String(d.fileFormat))
          ? d.fileFormat
          : 'docx') as SourceFileFormat,
        fileHash: String(d.fileHash ?? ''),
        bankName: String(d.bankName ?? ''),
        totalExtracted: Number(d.totalExtracted ?? 0),
        approvedSavedCount: Number(d.approvedSavedCount ?? 0),
        rejectedCount: Number(d.rejectedCount ?? 0),
        duplicateSkippedCount: Number(d.duplicateSkippedCount ?? 0),
        mcqCount: typeof d.mcqCount === 'number' ? d.mcqCount : undefined,
        trueFalseCount: typeof d.trueFalseCount === 'number' ? d.trueFalseCount : undefined,
        essayCount: typeof d.essayCount === 'number' ? d.essayCount : undefined,
        createdAtMs: timestampToMs(d.createdAt),
      }
    })
    items.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
    return items
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, IMPORTS_COLLECTION)
  }
}

export async function fetchTeacherQuestionBank(
  ownerUid: string
): Promise<SavedQuestionBankItem[]> {
  try {
    const q = query(
      collection(db, QUESTIONS_COLLECTION),
      where('ownerUid', '==', ownerUid)
    )
    const snapshot = await getDocs(q)
    const items: SavedQuestionBankItem[] = snapshot.docs.map((docSnap) => {
      const d = docSnap.data()
      const hasExplicitQuestionType =
        typeof d.questionType === 'string' &&
        VALID_QUESTION_TYPES.includes(d.questionType as QuestionType)
      const questionType: QuestionType = hasExplicitQuestionType
        ? (d.questionType as QuestionType)
        : 'multiple_choice'

      return {
        id: docSnap.id,
        ownerUid: String(d.ownerUid ?? ''),
        importId: String(d.importId ?? ''),
        contentHash: String(d.contentHash ?? ''),
        questionType,
        hasExplicitQuestionType,
        questionOrigin:
          d.questionOrigin === 'ai_generated'
            ? 'ai_generated'
            : d.questionOrigin === 'extracted'
            ? 'extracted'
            : undefined,
        answerSource: typeof d.answerSource === 'string' ? d.answerSource : undefined,
        bankName: String(d.bankName ?? ''),
        topic: String(d.topic ?? ''),
        sourceDocumentName: String(d.sourceDocumentName ?? ''),
        sourceDocumentHash: String(d.sourceDocumentHash ?? ''),
        sourceFormat: (['docx', 'pdf', 'txt'].includes(String(d.sourceFormat))
          ? d.sourceFormat
          : 'docx') as SourceFileFormat,
        lessonTitle: String(d.lessonTitle ?? ''),
        questionNumber: String(d.questionNumber ?? ''),
        pageNumber: typeof d.pageNumber === 'number' ? d.pageNumber : null,
        cognitiveLevel: (VALID_COGNITIVE_LEVELS.includes(d.cognitiveLevel)
          ? d.cognitiveLevel
          : 'unspecified') as CognitiveLevel,
        questionText: String(d.questionText ?? ''),
        optionA: String(d.optionA ?? ''),
        optionB: String(d.optionB ?? ''),
        optionC: String(d.optionC ?? ''),
        optionD: String(d.optionD ?? ''),
        answerKey: (VALID_ANSWER_KEYS.includes(d.answerKey)
          ? d.answerKey
          : 'A') as AnswerOptionKey,
        statementA: String(d.statementA ?? ''),
        statementB: String(d.statementB ?? ''),
        statementC: String(d.statementC ?? ''),
        statementD: String(d.statementD ?? ''),
        statementAnswerA: Boolean(d.statementAnswerA),
        statementAnswerB: Boolean(d.statementAnswerB),
        statementAnswerC: Boolean(d.statementAnswerC),
        statementAnswerD: Boolean(d.statementAnswerD),
        rubric: String(d.rubric ?? ''),
        sampleAnswer: String(d.sampleAnswer ?? ''),
        explanation: String(d.explanation ?? ''),
        createdAtMs: timestampToMs(d.createdAt),
        updatedAtMs: timestampToMs(d.updatedAt),
      }
    })
    items.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
    return items
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, QUESTIONS_COLLECTION)
  }
}

export interface SaveApprovedImportParams {
  ownerUid: string
  fileName: string
  fileFormat: SourceFileFormat
  fileHash: string
  bankName: string
  allExtractedQuestions: ExtractedQuestion[]
}

export interface SaveApprovedImportResult {
  importId: string
  savedCount: number
  skippedDuplicates: number
}

function buildQuestionFirestorePayload(
  q: ExtractedQuestion & { contentHash: string },
  ownerUid: string,
  importId: string,
  sourceDocumentHash: string,
  sourceFormat: SourceFileFormat,
  bankNameOverride: string
): Record<string, unknown> {
  const effectiveBank = (bankNameOverride || q.bankName || '').trim().slice(0, 120)
  const rawAnswerSource = (q.answerSource ?? '').trim()
  const formattedAnswerSource =
    q.aiProposedMarked && !rawAnswerSource.startsWith('[*]')
      ? `[*] ${rawAnswerSource || 'AI đề xuất'}`
      : rawAnswerSource
  const base: Record<string, unknown> = {
    ownerUid,
    importId,
    contentHash: q.contentHash,
    questionType: q.questionType,
    questionOrigin: q.questionOrigin === 'ai_generated' ? 'ai_generated' : 'extracted',
    answerSource: formattedAnswerSource.slice(0, 300),
    bankName: effectiveBank,
    topic: q.topic.trim().slice(0, 150),
    sourceDocumentName: q.sourceDocumentName.trim().slice(0, 255),
    sourceDocumentHash,
    sourceFormat,
    lessonTitle: q.lessonTitle.trim().slice(0, 200),
    questionNumber: q.questionNumber.trim().slice(0, 40),
    pageNumber: q.pageNumber,
    cognitiveLevel: q.cognitiveLevel,
    questionText: q.questionText.trim().slice(0, 4000),
    explanation: q.explanation.trim().slice(0, 3000),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }

  if (q.questionType === 'multiple_choice') {
    base.optionA = q.optionA.trim().slice(0, 1500)
    base.optionB = q.optionB.trim().slice(0, 1500)
    base.optionC = q.optionC.trim().slice(0, 1500)
    base.optionD = q.optionD.trim().slice(0, 1500)
    base.answerKey = q.answerKey
  } else if (q.questionType === 'true_false') {
    base.statementA = q.statementA.trim().slice(0, 1500)
    base.statementB = q.statementB.trim().slice(0, 1500)
    base.statementC = q.statementC.trim().slice(0, 1500)
    base.statementD = q.statementD.trim().slice(0, 1500)
    base.statementAnswerA = Boolean(q.statementAnswerA)
    base.statementAnswerB = Boolean(q.statementAnswerB)
    base.statementAnswerC = Boolean(q.statementAnswerC)
    base.statementAnswerD = Boolean(q.statementAnswerD)
  } else {
    base.rubric = q.rubric.trim().slice(0, 4000)
    base.sampleAnswer = q.sampleAnswer.trim().slice(0, 4000)
  }

  return base
}

export async function saveApprovedQuestionsToFirestore(
  params: SaveApprovedImportParams
): Promise<SaveApprovedImportResult> {
  const currentUser = auth.currentUser
  if (!currentUser || currentUser.uid !== params.ownerUid) {
    throw new Error('Phiên đăng nhập Giáo viên không hợp lệ. Vui lòng đăng nhập lại.')
  }
  if (!currentUser.emailVerified) {
    throw new Error(
      'Tài khoản Google chưa xác minh email (emailVerified = false), không thể lưu dữ liệu theo quy tắc bảo mật.'
    )
  }
  if (!ID_PATTERN.test(params.ownerUid) || !SHA256_PATTERN.test(params.fileHash)) {
    throw new Error('Mã định danh hoặc mã băm tệp không hợp lệ.')
  }

  const existingBank = await fetchTeacherQuestionBank(params.ownerUid)
  const existingHashes = new Set(existingBank.map((q) => q.contentHash))

  const approvedPool = params.allExtractedQuestions.filter(
    (q) => q.reviewDecision === 'approved' && !q.skippedInImport
  )

  if (approvedPool.length === 0) {
    throw new Error('Chưa có câu hỏi nào được duyệt để lưu vào ngân hàng.')
  }

  const readyToWrite: ExtractedQuestion[] = []
  const seenInBatch = new Set<string>()
  let skippedDuplicates = 0

  for (const item of approvedPool) {
    const hashParts =
      item.questionType === 'multiple_choice'
        ? [item.optionA, item.optionB, item.optionC, item.optionD]
        : item.questionType === 'true_false'
        ? [item.statementA, item.statementB, item.statementC, item.statementD]
        : [item.rubric || item.sampleAnswer || 'essay']

    const freshHash = await computeQuestionContentHashBrowser(
      item.questionType,
      item.questionText,
      hashParts
    )

    if (existingHashes.has(freshHash) || seenInBatch.has(freshHash)) {
      skippedDuplicates += 1
      continue
    }

    if (item.answerStatus !== 'verified') {
      throw new Error(
        `Câu "${item.questionNumber}" đang ở trạng thái "${item.answerStatus}" (chưa xác nhận đáp án từ nguồn hoặc đề xuất AI). Vui lòng xác nhận trước khi lưu vào ngân hàng.`
      )
    }

    const validationError = validateQuestionForBlueprint(item)
    if (validationError) {
      throw new Error(
        `Câu "${item.questionNumber}" chưa đạt điều kiện lưu: ${validationError}`
      )
    }

    seenInBatch.add(freshHash)
    readyToWrite.push({
      ...item,
      contentHash: freshHash,
    })
  }

  if (readyToWrite.length === 0) {
    throw new Error(
      'Tất cả các câu được chọn đều đã tồn tại trong ngân hàng câu hỏi (trùng lặp).'
    )
  }

  const rejectedCount = params.allExtractedQuestions.filter(
    (q) => q.reviewDecision === 'rejected'
  ).length
  const totalDuplicatesInList =
    params.allExtractedQuestions.filter(
      (q) => q.duplicateInFile || q.duplicateInBank
    ).length + skippedDuplicates

  const mcqCount = readyToWrite.filter((q) => q.questionType === 'multiple_choice').length
  const trueFalseCount = readyToWrite.filter((q) => q.questionType === 'true_false').length
  const essayCount = readyToWrite.filter((q) => q.questionType === 'essay').length

  const importId = `imp_${Date.now()}_${params.fileHash.slice(0, 12)}`
  const importRef = doc(db, IMPORTS_COLLECTION, importId)
  const trimmedBankName = params.bankName.trim().slice(0, 120)

  const importPayload = {
    ownerUid: params.ownerUid,
    fileName: params.fileName.trim().slice(0, 255) || 'tai-lieu',
    fileFormat: params.fileFormat,
    fileHash: params.fileHash,
    bankName: trimmedBankName,
    totalExtracted: Math.min(5000, params.allExtractedQuestions.length),
    approvedSavedCount: Math.min(5000, readyToWrite.length),
    rejectedCount: Math.min(5000, rejectedCount),
    duplicateSkippedCount: Math.min(5000, totalDuplicatesInList),
    mcqCount,
    trueFalseCount,
    essayCount,
    createdAt: serverTimestamp(),
  }

  const CHUNK_SIZE = 400

  try {
    for (let start = 0; start < readyToWrite.length; start += CHUNK_SIZE) {
      const chunk = readyToWrite.slice(start, start + CHUNK_SIZE)
      const batch = writeBatch(db)

      if (start === 0) {
        batch.set(importRef, importPayload)
      }

      for (const q of chunk) {
        const questionId = buildDeterministicQuestionDocId(params.ownerUid, q.contentHash)
        const questionRef = doc(db, QUESTIONS_COLLECTION, questionId)
        batch.set(
          questionRef,
          buildQuestionFirestorePayload(
            q,
            params.ownerUid,
            importId,
            params.fileHash,
            params.fileFormat,
            trimmedBankName
          )
        )
      }

      await batch.commit()
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `${IMPORTS_COLLECTION}/${importId}`)
  }

  return {
    importId,
    savedCount: readyToWrite.length,
    skippedDuplicates,
  }
}

export interface ManualQuestionCreateInput extends QuestionBlueprintValidationInput {
  ownerUid: string
}

export async function createManualQuestionInFirestore(
  input: ManualQuestionCreateInput
): Promise<string> {
  const currentUser = auth.currentUser
  if (!currentUser || currentUser.uid !== input.ownerUid) {
    throw new Error('Phiên đăng nhập Giáo viên không hợp lệ.')
  }
  if (!currentUser.emailVerified) {
    throw new Error('Tài khoản Google chưa xác minh email nên không thể tạo câu hỏi.')
  }

  const validationError = validateQuestionForBlueprint(input)
  if (validationError) {
    throw new Error(validationError)
  }

  const hashParts =
    input.questionType === 'multiple_choice'
      ? [input.optionA, input.optionB, input.optionC, input.optionD]
      : input.questionType === 'true_false'
      ? [input.statementA, input.statementB, input.statementC, input.statementD]
      : [input.rubric || input.sampleAnswer || 'essay']

  const contentHash = await computeQuestionContentHashBrowser(
    input.questionType,
    input.questionText,
    hashParts
  )

  const existingBank = await fetchTeacherQuestionBank(input.ownerUid)
  if (existingBank.some((item) => item.contentHash === contentHash)) {
    throw new Error('Câu hỏi này đã tồn tại trong Ngân hàng câu hỏi.')
  }

  const importId = `man_${Date.now()}_${sanitizeIdSegment(input.ownerUid, 8)}`
  const batchHash = await sha256HexBrowser(`${importId}:${contentHash}`)
  const questionId = buildDeterministicQuestionDocId(input.ownerUid, contentHash)

  const bankName = (input.bankName ?? '').trim().slice(0, 120)
  const importRef = doc(db, IMPORTS_COLLECTION, importId)
  const questionRef = doc(db, QUESTIONS_COLLECTION, questionId)

  const batch = writeBatch(db)
  batch.set(importRef, {
    ownerUid: input.ownerUid,
    fileName: `Nhập thủ công · ${input.questionNumber.trim()}`.slice(0, 255),
    fileFormat: 'docx',
    fileHash: batchHash,
    bankName,
    totalExtracted: 1,
    approvedSavedCount: 1,
    rejectedCount: 0,
    duplicateSkippedCount: 0,
    mcqCount: input.questionType === 'multiple_choice' ? 1 : 0,
    trueFalseCount: input.questionType === 'true_false' ? 1 : 0,
    essayCount: input.questionType === 'essay' ? 1 : 0,
    createdAt: serverTimestamp(),
  })

  const payload: Record<string, unknown> = {
    ownerUid: input.ownerUid,
    importId,
    contentHash,
    questionType: input.questionType,
    bankName,
    topic: (input.topic ?? '').trim().slice(0, 150),
    sourceDocumentName: 'Nhập thủ công trên TIN LAB',
    sourceDocumentHash: batchHash,
    sourceFormat: 'docx',
    lessonTitle: input.lessonTitle.trim().slice(0, 200),
    questionNumber: input.questionNumber.trim().slice(0, 40),
    pageNumber: input.pageNumber,
    cognitiveLevel: input.cognitiveLevel,
    questionText: input.questionText.trim().slice(0, 4000),
    explanation: (input.explanation ?? '').trim().slice(0, 3000),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }

  if (input.questionType === 'multiple_choice') {
    payload.optionA = input.optionA.trim().slice(0, 1500)
    payload.optionB = input.optionB.trim().slice(0, 1500)
    payload.optionC = input.optionC.trim().slice(0, 1500)
    payload.optionD = input.optionD.trim().slice(0, 1500)
    payload.answerKey = input.answerKey
  } else if (input.questionType === 'true_false') {
    payload.statementA = input.statementA.trim().slice(0, 1500)
    payload.statementB = input.statementB.trim().slice(0, 1500)
    payload.statementC = input.statementC.trim().slice(0, 1500)
    payload.statementD = input.statementD.trim().slice(0, 1500)
    payload.statementAnswerA = Boolean(input.statementAnswerA)
    payload.statementAnswerB = Boolean(input.statementAnswerB)
    payload.statementAnswerC = Boolean(input.statementAnswerC)
    payload.statementAnswerD = Boolean(input.statementAnswerD)
  } else {
    payload.rubric = input.rubric.trim().slice(0, 4000)
    payload.sampleAnswer = (input.sampleAnswer ?? '').trim().slice(0, 4000)
  }

  batch.set(questionRef, payload)

  try {
    await batch.commit()
    return questionId
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `${QUESTIONS_COLLECTION}/${questionId}`)
  }
}

export type UpdateSavedQuestionFields = QuestionBlueprintValidationInput

export async function updateSavedQuestionInFirestore(
  questionId: string,
  fields: UpdateSavedQuestionFields
): Promise<void> {
  const err = validateQuestionForBlueprint(fields)
  if (err) {
    throw new Error(err)
  }

  const payload: Record<string, unknown> = {
    questionType: fields.questionType,
    bankName: (fields.bankName ?? '').trim().slice(0, 120),
    topic: (fields.topic ?? '').trim().slice(0, 150),
    lessonTitle: fields.lessonTitle.trim().slice(0, 200),
    questionNumber: fields.questionNumber.trim().slice(0, 40),
    pageNumber: fields.pageNumber,
    cognitiveLevel: fields.cognitiveLevel,
    questionText: fields.questionText.trim().slice(0, 4000),
    explanation: (fields.explanation ?? '').trim().slice(0, 3000),
    updatedAt: serverTimestamp(),
  }

  if (fields.questionType === 'multiple_choice') {
    payload.optionA = fields.optionA.trim().slice(0, 1500)
    payload.optionB = fields.optionB.trim().slice(0, 1500)
    payload.optionC = fields.optionC.trim().slice(0, 1500)
    payload.optionD = fields.optionD.trim().slice(0, 1500)
    payload.answerKey = fields.answerKey
  } else if (fields.questionType === 'true_false') {
    payload.statementA = fields.statementA.trim().slice(0, 1500)
    payload.statementB = fields.statementB.trim().slice(0, 1500)
    payload.statementC = fields.statementC.trim().slice(0, 1500)
    payload.statementD = fields.statementD.trim().slice(0, 1500)
    payload.statementAnswerA = Boolean(fields.statementAnswerA)
    payload.statementAnswerB = Boolean(fields.statementAnswerB)
    payload.statementAnswerC = Boolean(fields.statementAnswerC)
    payload.statementAnswerD = Boolean(fields.statementAnswerD)
  } else {
    payload.rubric = fields.rubric.trim().slice(0, 4000)
    payload.sampleAnswer = (fields.sampleAnswer ?? '').trim().slice(0, 4000)
  }

  const ref = doc(db, QUESTIONS_COLLECTION, questionId)
  try {
    await updateDoc(ref, payload)
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${QUESTIONS_COLLECTION}/${questionId}`)
  }
}

export async function migrateLegacyQuestionsDefaults(
  legacyItems: SavedQuestionBankItem[],
  defaultBankName: string
): Promise<number> {
  const candidates = legacyItems.filter((item) => !item.hasExplicitQuestionType)
  if (candidates.length === 0) return 0

  const trimmedBank = defaultBankName.trim().slice(0, 120)
  const CHUNK_SIZE = 400
  let updatedCount = 0

  try {
    for (let start = 0; start < candidates.length; start += CHUNK_SIZE) {
      const chunk = candidates.slice(start, start + CHUNK_SIZE)
      const batch = writeBatch(db)
      for (const item of chunk) {
        const ref = doc(db, QUESTIONS_COLLECTION, item.id)
        batch.update(ref, {
          questionType: 'multiple_choice',
          bankName: item.bankName || trimmedBank,
          updatedAt: serverTimestamp(),
        })
        updatedCount += 1
      }
      await batch.commit()
    }
    return updatedCount
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, QUESTIONS_COLLECTION)
  }
}

export async function deleteSavedQuestionFromFirestore(
  questionId: string
): Promise<void> {
  const ref = doc(db, QUESTIONS_COLLECTION, questionId)
  try {
    await deleteDoc(ref)
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `${QUESTIONS_COLLECTION}/${questionId}`)
  }
}
