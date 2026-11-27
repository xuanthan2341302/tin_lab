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
  CognitiveLevel,
  ExamSubmissionRecord,
  ExamTemplate,
  GradedSubmissionAnswer,
  Part2ScoringMode,
  PublishedExam,
  PublishedExamKey,
  PublishedExamKeyItem,
  SanitizedExamQuestion,
  SavedQuestionBankItem,
  SubmissionGradingStatus,
} from '../types'
import { auth, db, handleFirestoreError, OperationType } from './firebase'

const TEMPLATES_COLLECTION = 'examTemplates'
const PUBLISHED_EXAMS_COLLECTION = 'publishedExams'
const PUBLISHED_KEYS_COLLECTION = 'publishedExamKeys'
const SUBMISSIONS_COLLECTION = 'examSubmissions'

function timestampToMs(val: unknown): number | null {
  if (val instanceof Timestamp) {
    return val.toMillis()
  }
  return null
}

function roundScore(val: number): number {
  return Math.round(val * 1000) / 1000
}

export type ExamTemplateInput = Omit<
  ExamTemplate,
  'id' | 'ownerUid' | 'createdAtMs' | 'updatedAtMs'
>

export const PRESET_45M_TEMPLATE_INPUT: ExamTemplateInput = {
  name: 'Đề kiểm tra 45 phút Tin học 12 (Chuẩn 3 phần · 10 điểm)',
  description:
    'Cấu trúc mới: Phần I (12 câu TN nhiều lựa chọn · 3.0đ), Phần II (4 câu Đúng/Sai x 4 ý · 4.0đ), Phần III (Tự luận có Rubric · 3.0đ). Tỷ lệ 40% Nhận biết · 30% Thông hiểu · 30% Vận dụng.',
  schoolFormatLabel: 'Chương trình GDPT 2018 · Định dạng mới 3 phần',
  durationMinutes: 45,
  totalPoints: 10,
  part1Enabled: true,
  part1Title: 'Phần I. Trắc nghiệm nhiều lựa chọn',
  part1Count: 12,
  part1Points: 3,
  part2Enabled: true,
  part2Title: 'Phần II. Trắc nghiệm Đúng / Sai (mỗi câu 4 ý a, b, c, d)',
  part2Count: 4,
  part2Points: 4,
  part2ScoringMode: 'tiered_2025',
  part3Enabled: true,
  part3Title: 'Phần III. Tự luận',
  part3Count: 2,
  part3Points: 3,
  recognitionPct: 40,
  understandingPct: 30,
  applicationPct: 30,
}

export function validateExamTemplateInput(input: ExamTemplateInput): string | null {
  if (!input.name.trim() || input.name.trim().length > 150) {
    return 'Tên cấu trúc đề thi phải từ 1 đến 150 ký tự.'
  }
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > 180) {
    return 'Thời lượng làm bài phải là số nguyên từ 5 đến 180 phút.'
  }
  if (!Number.isFinite(input.totalPoints) || input.totalPoints <= 0 || input.totalPoints > 100) {
    return 'Tổng điểm đề thi phải lớn hơn 0 và tối đa 100.'
  }

  const p1Pts = input.part1Enabled ? Number(input.part1Points) : 0
  const p2Pts = input.part2Enabled ? Number(input.part2Points) : 0
  const p3Pts = input.part3Enabled ? Number(input.part3Points) : 0

  if (input.part1Enabled && (input.part1Count < 1 || p1Pts <= 0)) {
    return 'Phần I đang bật nhưng số câu hoặc điểm số bằng 0.'
  }
  if (input.part2Enabled && (input.part2Count < 1 || p2Pts <= 0)) {
    return 'Phần II đang bật nhưng số câu hoặc điểm số bằng 0.'
  }
  if (input.part3Enabled && (input.part3Count < 1 || p3Pts <= 0)) {
    return 'Phần III đang bật nhưng số câu hoặc điểm số bằng 0.'
  }

  const sumParts = roundScore(p1Pts + p2Pts + p3Pts)
  if (Math.abs(sumParts - Number(input.totalPoints)) > 0.01) {
    return `Tổng điểm các phần đang bật (${sumParts}đ) chưa khớp tổng điểm cấu trúc (${input.totalPoints}đ).`
  }

  if (
    !Number.isInteger(input.recognitionPct) ||
    !Number.isInteger(input.understandingPct) ||
    !Number.isInteger(input.applicationPct) ||
    input.recognitionPct < 0 ||
    input.understandingPct < 0 ||
    input.applicationPct < 0 ||
    input.recognitionPct + input.understandingPct + input.applicationPct !== 100
  ) {
    return 'Tổng tỷ lệ phân bố nhận thức (Nhận biết + Thông hiểu + Vận dụng) phải bằng đúng 100%.'
  }

  return null
}

export async function fetchTeacherTemplates(ownerUid: string): Promise<ExamTemplate[]> {
  try {
    const q = query(collection(db, TEMPLATES_COLLECTION), where('ownerUid', '==', ownerUid))
    const snap = await getDocs(q)
    const items: ExamTemplate[] = snap.docs.map((docSnap) => {
      const d = docSnap.data()
      return {
        id: docSnap.id,
        ownerUid: String(d.ownerUid ?? ''),
        name: String(d.name ?? ''),
        description: String(d.description ?? ''),
        schoolFormatLabel: String(d.schoolFormatLabel ?? ''),
        durationMinutes: Number(d.durationMinutes ?? 45),
        totalPoints: Number(d.totalPoints ?? 10),
        part1Enabled: Boolean(d.part1Enabled),
        part1Title: String(d.part1Title ?? 'Phần I. Trắc nghiệm nhiều lựa chọn'),
        part1Count: Number(d.part1Count ?? 0),
        part1Points: Number(d.part1Points ?? 0),
        part2Enabled: Boolean(d.part2Enabled),
        part2Title: String(d.part2Title ?? 'Phần II. Đúng / Sai'),
        part2Count: Number(d.part2Count ?? 0),
        part2Points: Number(d.part2Points ?? 0),
        part2ScoringMode: (d.part2ScoringMode === 'linear' ? 'linear' : 'tiered_2025') as Part2ScoringMode,
        part3Enabled: Boolean(d.part3Enabled),
        part3Title: String(d.part3Title ?? 'Phần III. Tự luận'),
        part3Count: Number(d.part3Count ?? 0),
        part3Points: Number(d.part3Points ?? 0),
        recognitionPct: Number(d.recognitionPct ?? 40),
        understandingPct: Number(d.understandingPct ?? 30),
        applicationPct: Number(d.applicationPct ?? 30),
        createdAtMs: timestampToMs(d.createdAt),
        updatedAtMs: timestampToMs(d.updatedAt),
      }
    })
    items.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
    return items
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, TEMPLATES_COLLECTION)
  }
}

export async function createExamTemplate(
  ownerUid: string,
  input: ExamTemplateInput
): Promise<string> {
  const err = validateExamTemplateInput(input)
  if (err) throw new Error(err)

  const currentUser = auth.currentUser
  if (!currentUser || currentUser.uid !== ownerUid || !currentUser.emailVerified) {
    throw new Error('Cần đăng nhập tài khoản Giáo viên đã xác minh email.')
  }

  const templateId = `tpl_${Date.now()}_${ownerUid.slice(0, 6)}`
  const ref = doc(db, TEMPLATES_COLLECTION, templateId)

  const batch = writeBatch(db)
  batch.set(ref, {
    ownerUid,
    name: input.name.trim().slice(0, 150),
    description: input.description.trim().slice(0, 1000),
    schoolFormatLabel: input.schoolFormatLabel.trim().slice(0, 120),
    durationMinutes: Math.round(input.durationMinutes),
    totalPoints: Number(input.totalPoints),
    part1Enabled: input.part1Enabled,
    part1Title: input.part1Title.trim().slice(0, 120),
    part1Count: input.part1Enabled ? Math.round(input.part1Count) : 0,
    part1Points: input.part1Enabled ? Number(input.part1Points) : 0,
    part2Enabled: input.part2Enabled,
    part2Title: input.part2Title.trim().slice(0, 120),
    part2Count: input.part2Enabled ? Math.round(input.part2Count) : 0,
    part2Points: input.part2Enabled ? Number(input.part2Points) : 0,
    part2ScoringMode: input.part2ScoringMode,
    part3Enabled: input.part3Enabled,
    part3Title: input.part3Title.trim().slice(0, 120),
    part3Count: input.part3Enabled ? Math.round(input.part3Count) : 0,
    part3Points: input.part3Enabled ? Number(input.part3Points) : 0,
    recognitionPct: Math.round(input.recognitionPct),
    understandingPct: Math.round(input.understandingPct),
    applicationPct: Math.round(input.applicationPct),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  try {
    await batch.commit()
    return templateId
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `${TEMPLATES_COLLECTION}/${templateId}`)
  }
}

export async function updateExamTemplate(
  templateId: string,
  input: ExamTemplateInput
): Promise<void> {
  const err = validateExamTemplateInput(input)
  if (err) throw new Error(err)

  const ref = doc(db, TEMPLATES_COLLECTION, templateId)
  try {
    await updateDoc(ref, {
      name: input.name.trim().slice(0, 150),
      description: input.description.trim().slice(0, 1000),
      schoolFormatLabel: input.schoolFormatLabel.trim().slice(0, 120),
      durationMinutes: Math.round(input.durationMinutes),
      totalPoints: Number(input.totalPoints),
      part1Enabled: input.part1Enabled,
      part1Title: input.part1Title.trim().slice(0, 120),
      part1Count: input.part1Enabled ? Math.round(input.part1Count) : 0,
      part1Points: input.part1Enabled ? Number(input.part1Points) : 0,
      part2Enabled: input.part2Enabled,
      part2Title: input.part2Title.trim().slice(0, 120),
      part2Count: input.part2Enabled ? Math.round(input.part2Count) : 0,
      part2Points: input.part2Enabled ? Number(input.part2Points) : 0,
      part2ScoringMode: input.part2ScoringMode,
      part3Enabled: input.part3Enabled,
      part3Title: input.part3Title.trim().slice(0, 120),
      part3Count: input.part3Enabled ? Math.round(input.part3Count) : 0,
      part3Points: input.part3Enabled ? Number(input.part3Points) : 0,
      recognitionPct: Math.round(input.recognitionPct),
      understandingPct: Math.round(input.understandingPct),
      applicationPct: Math.round(input.applicationPct),
      updatedAt: serverTimestamp(),
    })
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${TEMPLATES_COLLECTION}/${templateId}`)
  }
}

export async function deleteExamTemplate(templateId: string): Promise<void> {
  const ref = doc(db, TEMPLATES_COLLECTION, templateId)
  try {
    await deleteDoc(ref)
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `${TEMPLATES_COLLECTION}/${templateId}`)
  }
}

export interface SelectedExamQuestionEntry {
  question: SavedQuestionBankItem
  part: 1 | 2 | 3
  points: number
}

export interface ExamCompositionValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  actualTotalPoints: number
  part1ActualCount: number
  part1ActualPoints: number
  part2ActualCount: number
  part2ActualPoints: number
  part3ActualCount: number
  part3ActualPoints: number
  cognitiveActualCounts: Record<CognitiveLevel, number>
  cognitiveActualPct: {
    recognition: number
    understanding: number
    application: number
    unspecified: number
  }
}

export function validateExamComposition(
  template: ExamTemplate,
  selected: SelectedExamQuestionEntry[]
): ExamCompositionValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  const p1 = selected.filter((s) => s.part === 1)
  const p2 = selected.filter((s) => s.part === 2)
  const p3 = selected.filter((s) => s.part === 3)

  const part1ActualPoints = roundScore(p1.reduce((acc, s) => acc + s.points, 0))
  const part2ActualPoints = roundScore(p2.reduce((acc, s) => acc + s.points, 0))
  const part3ActualPoints = roundScore(p3.reduce((acc, s) => acc + s.points, 0))
  const actualTotalPoints = roundScore(part1ActualPoints + part2ActualPoints + part3ActualPoints)

  if (template.part1Enabled) {
    if (p1.length !== template.part1Count) {
      errors.push(`Phần I cần đúng ${template.part1Count} câu (hiện đã chọn ${p1.length} câu).`)
    }
    if (Math.abs(part1ActualPoints - template.part1Points) > 0.02) {
      errors.push(`Tổng điểm Phần I là ${part1ActualPoints}đ, chưa khớp mẫu ${template.part1Points}đ.`)
    }
  } else if (p1.length > 0) {
    errors.push('Cấu trúc đề đang tắt Phần I nhưng vẫn có câu hỏi Phần I được chọn.')
  }

  if (template.part2Enabled) {
    if (p2.length !== template.part2Count) {
      errors.push(`Phần II cần đúng ${template.part2Count} câu Đúng/Sai (hiện có ${p2.length} câu).`)
    }
    if (Math.abs(part2ActualPoints - template.part2Points) > 0.02) {
      errors.push(`Tổng điểm Phần II là ${part2ActualPoints}đ, chưa khớp mẫu ${template.part2Points}đ.`)
    }
  } else if (p2.length > 0) {
    errors.push('Cấu trúc đề đang tắt Phần II nhưng vẫn có câu hỏi Phần II được chọn.')
  }

  if (template.part3Enabled) {
    if (p3.length !== template.part3Count) {
      errors.push(`Phần III cần đúng ${template.part3Count} câu Tự luận (hiện có ${p3.length} câu).`)
    }
    if (Math.abs(part3ActualPoints - template.part3Points) > 0.02) {
      errors.push(`Tổng điểm Phần III là ${part3ActualPoints}đ, chưa khớp mẫu ${template.part3Points}đ.`)
    }
  } else if (p3.length > 0) {
    errors.push('Cấu trúc đề đang tắt Phần III nhưng vẫn có câu hỏi Phần III được chọn.')
  }

  if (Math.abs(actualTotalPoints - template.totalPoints) > 0.02) {
    errors.push(`Tổng điểm toàn đề (${actualTotalPoints}đ) phải bằng ${template.totalPoints}đ theo cấu trúc mẫu.`)
  }

  for (const s of selected) {
    if (s.points <= 0) {
      errors.push(`Câu "${s.question.questionNumber}" phải có điểm lớn hơn 0.`)
    }
    if (s.question.questionType === 'essay' && s.question.rubric.trim().length < 5) {
      errors.push(`Câu tự luận "${s.question.questionNumber}" thiếu hướng dẫn chấm (Rubric).`)
    }
  }

  const cognitiveActualCounts: Record<CognitiveLevel, number> = {
    recognition: 0,
    understanding: 0,
    application: 0,
    unspecified: 0,
  }
  for (const s of selected) {
    cognitiveActualCounts[s.question.cognitiveLevel] += 1
  }

  const totalCount = selected.length || 1
  const recognition = Math.round((cognitiveActualCounts.recognition / totalCount) * 100)
  const understanding = Math.round((cognitiveActualCounts.understanding / totalCount) * 100)
  const application = Math.round((cognitiveActualCounts.application / totalCount) * 100)
  const unspecified = Math.round((cognitiveActualCounts.unspecified / totalCount) * 100)

  if (selected.length > 0) {
    if (cognitiveActualCounts.unspecified > 0) {
      errors.push(
        `Có ${cognitiveActualCounts.unspecified} câu đang ở mức "Chưa xác định". Vui lòng gán mức Nhận biết / Thông hiểu / Vận dụng trước khi xuất bản.`
      )
    } else {
      const tolerancePct = Math.max(8, Math.ceil(100 / Math.max(1, selected.length)))
      if (
        Math.abs(recognition - template.recognitionPct) > tolerancePct ||
        Math.abs(understanding - template.understandingPct) > tolerancePct ||
        Math.abs(application - template.applicationPct) > tolerancePct
      ) {
        errors.push(
          `Phân bố mức độ nhận thức thực tế (${recognition}% NB · ${understanding}% TH · ${application}% VD) lệch quá xa chuẩn cấu trúc (${template.recognitionPct}% / ${template.understandingPct}% / ${template.applicationPct}%).`
        )
      } else if (
        recognition !== template.recognitionPct ||
        understanding !== template.understandingPct ||
        application !== template.applicationPct
      ) {
        warnings.push(
          `Tỷ lệ nhận thức làm tròn đạt ${recognition}% NB · ${understanding}% TH · ${application}% VD (mục tiêu mẫu: ${template.recognitionPct}% / ${template.understandingPct}% / ${template.applicationPct}%).`
        )
      }
    }
  }

  return {
    valid: errors.length === 0 && selected.length > 0,
    errors,
    warnings,
    actualTotalPoints,
    part1ActualCount: p1.length,
    part1ActualPoints,
    part2ActualCount: p2.length,
    part2ActualPoints,
    part3ActualCount: p3.length,
    part3ActualPoints,
    cognitiveActualCounts,
    cognitiveActualPct: {
      recognition,
      understanding,
      application,
      unspecified,
    },
  }
}

export async function publishExamToFirestore(params: {
  ownerUid: string
  teacherName: string
  template: ExamTemplate
  title: string
  accessCode: string
  selectedQuestions: SelectedExamQuestionEntry[]
}): Promise<string> {
  const currentUser = auth.currentUser
  if (!currentUser || currentUser.uid !== params.ownerUid || !currentUser.emailVerified) {
    throw new Error('Cần đăng nhập tài khoản Giáo viên đã xác minh email.')
  }

  const check = validateExamComposition(params.template, params.selectedQuestions)
  if (!check.valid) {
    throw new Error(check.errors[0] || 'Đề thi chưa đạt yêu cầu cấu trúc.')
  }

  const cleanTitle = params.title.trim().slice(0, 200)
  const cleanCode = params.accessCode.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '')
  if (cleanTitle.length < 3) {
    throw new Error('Tên đề thi phải có ít nhất 3 ký tự.')
  }
  if (cleanCode.length < 4 || cleanCode.length > 20) {
    throw new Error('Mã phòng thi (Access Code) phải gồm 4–20 ký tự chữ hoa, số hoặc gạch ngang.')
  }

  const examId = `exam_${Date.now()}_${params.ownerUid.slice(0, 6)}`
  const ordered = [...params.selectedQuestions].sort((a, b) => a.part - b.part)

  const sanitizedQuestions: SanitizedExamQuestion[] = ordered.map((entry, idx) => {
    const q = entry.question
    const base: SanitizedExamQuestion = {
      id: q.id,
      part: entry.part,
      orderIndex: idx + 1,
      questionType: q.questionType,
      lessonTitle: q.lessonTitle,
      topic: q.topic,
      cognitiveLevel: q.cognitiveLevel,
      questionText: q.questionText,
      points: roundScore(entry.points),
    }
    if (q.questionType === 'multiple_choice') {
      base.optionA = q.optionA
      base.optionB = q.optionB
      base.optionC = q.optionC
      base.optionD = q.optionD
    } else if (q.questionType === 'true_false') {
      base.statementA = q.statementA
      base.statementB = q.statementB
      base.statementC = q.statementC
      base.statementD = q.statementD
    }
    return base
  })

  const keyItems: PublishedExamKeyItem[] = ordered.map((entry) => {
    const q = entry.question
    const item: PublishedExamKeyItem = {
      id: q.id,
      part: entry.part,
      questionType: q.questionType,
      points: roundScore(entry.points),
      explanation: q.explanation,
    }
    if (q.questionType === 'multiple_choice') {
      item.answerKey = q.answerKey
    } else if (q.questionType === 'true_false') {
      item.statementAnswerA = q.statementAnswerA
      item.statementAnswerB = q.statementAnswerB
      item.statementAnswerC = q.statementAnswerC
      item.statementAnswerD = q.statementAnswerD
    } else {
      item.rubric = q.rubric
      item.sampleAnswer = q.sampleAnswer
    }
    return item
  })

  const sealItems = ordered.map((entry) => ({
    id: entry.question.id,
    part: entry.part,
    questionType: entry.question.questionType,
    points: roundScore(entry.points),
    questionText: entry.question.questionText,
    ...(entry.question.questionType === 'multiple_choice'
      ? { answerKey: entry.question.answerKey }
      : entry.question.questionType === 'true_false'
      ? {
          statementAnswerA: entry.question.statementAnswerA,
          statementAnswerB: entry.question.statementAnswerB,
          statementAnswerC: entry.question.statementAnswerC,
          statementAnswerD: entry.question.statementAnswerD,
        }
      : {
          rubric: entry.question.rubric,
          sampleAnswer: entry.question.sampleAnswer,
        }),
    explanation: entry.question.explanation,
  }))

  const idToken = await currentUser.getIdToken()

  const sealRes = await fetch('/api/exams/seal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      examId,
      part2ScoringMode: params.template.part2ScoringMode,
      totalPoints: params.template.totalPoints,
      items: sealItems,
    }),
  })
  const sealData = (await sealRes.json().catch(() => null)) as
    | { ok: true; sealedGradingPayload: string }
    | { ok: false; error?: string }
    | null

  if (!sealRes.ok || !sealData || !sealData.ok) {
    throw new Error(
      (sealData && 'error' in sealData && sealData.error) ||
        'Không thể niêm phong đáp án đề thi trên máy chủ.'
    )
  }

  const examRef = doc(db, PUBLISHED_EXAMS_COLLECTION, examId)
  const keyRef = doc(db, PUBLISHED_KEYS_COLLECTION, examId)

  const batch = writeBatch(db)
  batch.set(examRef, {
    ownerUid: params.ownerUid,
    teacherName: (params.teacherName || 'Giáo viên TIN LAB').trim().slice(0, 120),
    templateId: params.template.id,
    templateName: params.template.name,
    title: cleanTitle,
    schoolFormatLabel: params.template.schoolFormatLabel,
    accessCode: cleanCode,
    status: 'published',
    durationMinutes: params.template.durationMinutes,
    totalPoints: params.template.totalPoints,
    part1Count: check.part1ActualCount,
    part1Points: check.part1ActualPoints,
    part2Count: check.part2ActualCount,
    part2Points: check.part2ActualPoints,
    part2ScoringMode: params.template.part2ScoringMode,
    part3Count: check.part3ActualCount,
    part3Points: check.part3ActualPoints,
    recognitionPct: check.cognitiveActualPct.recognition,
    understandingPct: check.cognitiveActualPct.understanding,
    applicationPct: check.cognitiveActualPct.application,
    questions: sanitizedQuestions,
    sealedGradingPayload: sealData.sealedGradingPayload,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  batch.set(keyRef, {
    ownerUid: params.ownerUid,
    examId,
    title: cleanTitle,
    items: keyItems,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  try {
    await batch.commit()
    return examId
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `${PUBLISHED_EXAMS_COLLECTION}/${examId}`)
  }
}

function mapPublishedExamDoc(id: string, d: Record<string, unknown>): PublishedExam {
  return {
    id,
    ownerUid: String(d.ownerUid ?? ''),
    teacherName: String(d.teacherName ?? ''),
    templateId: String(d.templateId ?? ''),
    templateName: String(d.templateName ?? ''),
    title: String(d.title ?? ''),
    schoolFormatLabel: String(d.schoolFormatLabel ?? ''),
    accessCode: String(d.accessCode ?? ''),
    status: d.status === 'closed' ? 'closed' : 'published',
    durationMinutes: Number(d.durationMinutes ?? 45),
    totalPoints: Number(d.totalPoints ?? 10),
    part1Count: Number(d.part1Count ?? 0),
    part1Points: Number(d.part1Points ?? 0),
    part2Count: Number(d.part2Count ?? 0),
    part2Points: Number(d.part2Points ?? 0),
    part2ScoringMode: d.part2ScoringMode === 'linear' ? 'linear' : 'tiered_2025',
    part3Count: Number(d.part3Count ?? 0),
    part3Points: Number(d.part3Points ?? 0),
    recognitionPct: Number(d.recognitionPct ?? 40),
    understandingPct: Number(d.understandingPct ?? 30),
    applicationPct: Number(d.applicationPct ?? 30),
    questions: Array.isArray(d.questions) ? (d.questions as SanitizedExamQuestion[]) : [],
    sealedGradingPayload: String(d.sealedGradingPayload ?? ''),
    createdAtMs: timestampToMs(d.createdAt),
    updatedAtMs: timestampToMs(d.updatedAt),
  }
}

export async function fetchTeacherPublishedExams(
  ownerUid: string
): Promise<PublishedExam[]> {
  try {
    const q = query(
      collection(db, PUBLISHED_EXAMS_COLLECTION),
      where('ownerUid', '==', ownerUid)
    )
    const snap = await getDocs(q)
    const items = snap.docs.map((docSnap) =>
      mapPublishedExamDoc(docSnap.id, docSnap.data() as Record<string, unknown>)
    )
    items.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
    return items
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, PUBLISHED_EXAMS_COLLECTION)
  }
}

export async function fetchTeacherPublishedExamKeys(
  ownerUid: string
): Promise<PublishedExamKey[]> {
  try {
    const q = query(
      collection(db, PUBLISHED_KEYS_COLLECTION),
      where('ownerUid', '==', ownerUid)
    )
    const snap = await getDocs(q)
    return snap.docs.map((docSnap) => {
      const d = docSnap.data()
      return {
        id: docSnap.id,
        ownerUid: String(d.ownerUid ?? ''),
        examId: String(d.examId ?? ''),
        title: String(d.title ?? ''),
        items: Array.isArray(d.items) ? (d.items as PublishedExamKeyItem[]) : [],
        createdAtMs: timestampToMs(d.createdAt),
        updatedAtMs: timestampToMs(d.updatedAt),
      }
    })
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, PUBLISHED_KEYS_COLLECTION)
  }
}

export async function fetchStudentPublishedExams(): Promise<PublishedExam[]> {
  try {
    const q = query(
      collection(db, PUBLISHED_EXAMS_COLLECTION),
      where('status', '==', 'published')
    )
    const snap = await getDocs(q)
    const items = snap.docs.map((docSnap) =>
      mapPublishedExamDoc(docSnap.id, docSnap.data() as Record<string, unknown>)
    )
    items.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
    return items
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, PUBLISHED_EXAMS_COLLECTION)
  }
}

export async function togglePublishedExamStatus(
  examId: string,
  nextStatus: 'published' | 'closed'
): Promise<void> {
  const ref = doc(db, PUBLISHED_EXAMS_COLLECTION, examId)
  try {
    await updateDoc(ref, {
      status: nextStatus,
      updatedAt: serverTimestamp(),
    })
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${PUBLISHED_EXAMS_COLLECTION}/${examId}`)
  }
}

export async function deletePublishedExam(examId: string): Promise<void> {
  const batch = writeBatch(db)
  batch.delete(doc(db, PUBLISHED_EXAMS_COLLECTION, examId))
  batch.delete(doc(db, PUBLISHED_KEYS_COLLECTION, examId))
  try {
    await batch.commit()
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `${PUBLISHED_EXAMS_COLLECTION}/${examId}`)
  }
}

export async function submitExamAttemptToFirestore(params: {
  exam: PublishedExam
  studentUid: string
  studentName: string
  studentClass: string
  studentEmail: string
  gradeResult: {
    part1Score: number
    part1Max: number
    part2Score: number
    part2Max: number
    part3AiScore: number | null
    part3Max: number
    totalProvisionalScore: number | null
    totalMax: number
    gradingStatus: 'auto_graded' | 'needs_teacher_review'
    gradedAnswers: GradedSubmissionAnswer[]
  }
}): Promise<string> {
  const currentUser = auth.currentUser
  if (!currentUser || currentUser.uid !== params.studentUid || !currentUser.emailVerified) {
    throw new Error('Cần đăng nhập Google đã xác minh email để lưu bài thi vào hệ thống.')
  }

  const submissionId = `sub_${Date.now()}_${params.studentUid.slice(0, 6)}`
  const ref = doc(db, SUBMISSIONS_COLLECTION, submissionId)

  const batch = writeBatch(db)
  batch.set(ref, {
    examId: params.exam.id,
    teacherUid: params.exam.ownerUid,
    studentUid: params.studentUid,
    studentName: (params.studentName || 'Học sinh TIN LAB').trim().slice(0, 120),
    studentClass: params.studentClass.trim().slice(0, 40),
    studentEmail: params.studentEmail.trim().slice(0, 150),
    examTitle: params.exam.title,
    part1Score: params.gradeResult.part1Score,
    part1Max: params.gradeResult.part1Max,
    part2Score: params.gradeResult.part2Score,
    part2Max: params.gradeResult.part2Max,
    part3AiScore: params.gradeResult.part3AiScore,
    part3FinalScore: null,
    part3Max: params.gradeResult.part3Max,
    totalScore:
      params.gradeResult.gradingStatus === 'auto_graded'
        ? params.gradeResult.totalProvisionalScore
        : null,
    totalMax: params.gradeResult.totalMax,
    gradingStatus: params.gradeResult.gradingStatus,
    answers: params.gradeResult.gradedAnswers,
    teacherFeedback: '',
    submittedAt: serverTimestamp(),
    reviewedAt: null,
  })

  try {
    await batch.commit()
    return submissionId
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `${SUBMISSIONS_COLLECTION}/${submissionId}`)
  }
}

function mapSubmissionDoc(id: string, d: Record<string, unknown>): ExamSubmissionRecord {
  return {
    id,
    examId: String(d.examId ?? ''),
    teacherUid: String(d.teacherUid ?? ''),
    studentUid: String(d.studentUid ?? ''),
    studentName: String(d.studentName ?? ''),
    studentClass: String(d.studentClass ?? ''),
    studentEmail: String(d.studentEmail ?? ''),
    examTitle: String(d.examTitle ?? ''),
    part1Score: Number(d.part1Score ?? 0),
    part1Max: Number(d.part1Max ?? 0),
    part2Score: Number(d.part2Score ?? 0),
    part2Max: Number(d.part2Max ?? 0),
    part3AiScore: typeof d.part3AiScore === 'number' ? d.part3AiScore : null,
    part3FinalScore: typeof d.part3FinalScore === 'number' ? d.part3FinalScore : null,
    part3Max: Number(d.part3Max ?? 0),
    totalScore: typeof d.totalScore === 'number' ? d.totalScore : null,
    totalMax: Number(d.totalMax ?? 10),
    gradingStatus: (
      d.gradingStatus === 'teacher_reviewed' || d.gradingStatus === 'needs_teacher_review'
        ? d.gradingStatus
        : 'auto_graded'
    ) as SubmissionGradingStatus,
    answers: Array.isArray(d.answers) ? (d.answers as GradedSubmissionAnswer[]) : [],
    teacherFeedback: String(d.teacherFeedback ?? ''),
    submittedAtMs: timestampToMs(d.submittedAt),
    reviewedAtMs: timestampToMs(d.reviewedAt),
  }
}

export async function fetchTeacherSubmissions(
  teacherUid: string
): Promise<ExamSubmissionRecord[]> {
  try {
    const q = query(
      collection(db, SUBMISSIONS_COLLECTION),
      where('teacherUid', '==', teacherUid)
    )
    const snap = await getDocs(q)
    const items = snap.docs.map((docSnap) =>
      mapSubmissionDoc(docSnap.id, docSnap.data() as Record<string, unknown>)
    )
    items.sort((a, b) => (b.submittedAtMs ?? 0) - (a.submittedAtMs ?? 0))
    return items
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, SUBMISSIONS_COLLECTION)
  }
}

export async function fetchStudentSubmissions(
  studentUid: string
): Promise<ExamSubmissionRecord[]> {
  try {
    const q = query(
      collection(db, SUBMISSIONS_COLLECTION),
      where('studentUid', '==', studentUid)
    )
    const snap = await getDocs(q)
    const items = snap.docs.map((docSnap) =>
      mapSubmissionDoc(docSnap.id, docSnap.data() as Record<string, unknown>)
    )
    items.sort((a, b) => (b.submittedAtMs ?? 0) - (a.submittedAtMs ?? 0))
    return items
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, SUBMISSIONS_COLLECTION)
  }
}

export async function finalizeTeacherSubmissionReview(params: {
  submission: ExamSubmissionRecord
  updatedAnswers: GradedSubmissionAnswer[]
  part3FinalScore: number
  teacherFeedback: string
}): Promise<void> {
  const { submission } = params
  const clampedPart3 = roundScore(
    Math.max(0, Math.min(submission.part3Max, params.part3FinalScore))
  )
  const finalTotal = roundScore(
    Math.min(
      submission.totalMax,
      submission.part1Score + submission.part2Score + clampedPart3
    )
  )

  const ref = doc(db, SUBMISSIONS_COLLECTION, submission.id)
  try {
    await updateDoc(ref, {
      part3FinalScore: clampedPart3,
      totalScore: finalTotal,
      gradingStatus: 'teacher_reviewed',
      answers: params.updatedAnswers,
      teacherFeedback: params.teacherFeedback.trim().slice(0, 2000),
      reviewedAt: serverTimestamp(),
    })
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${SUBMISSIONS_COLLECTION}/${submission.id}`)
  }
}
