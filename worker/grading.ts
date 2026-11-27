import { unsealExamGradingPayloadWorker } from './crypto.ts'
import type { WorkerEnv } from './env.ts'
import type {
  GradedSubmissionAnswer,
  Part2ScoringMode,
  ServerGradeResponse,
  StudentAnswerInput,
} from '../src/types.ts'

function roundScore(val: number): number {
  return Math.round(val * 1000) / 1000
}

/**
 * Exact Part 2 (True/False 4 statements) scoring rule preserved from server/examService.ts:
 * - tiered_2025: 1 -> 10%, 2 -> 25%, 3 -> 50%, 4 -> 100%
 * - linear: (correct / 4) * maxPoints
 */
export function computeTrueFalseScore(
  correctStatementsCount: number,
  maxPoints: number,
  mode: Part2ScoringMode
): number {
  if (correctStatementsCount <= 0) return 0
  if (mode === 'linear') {
    return roundScore((Math.min(4, correctStatementsCount) / 4) * maxPoints)
  }
  if (correctStatementsCount === 1) return roundScore(maxPoints * 0.1)
  if (correctStatementsCount === 2) return roundScore(maxPoints * 0.25)
  if (correctStatementsCount === 3) return roundScore(maxPoints * 0.5)
  return roundScore(maxPoints)
}

/**
 * Server-side grading for published exams in Cloudflare Workers (Phase 1 basic mode).
 * Grades Part 1 (Multiple Choice) and Part 2 (True/False) deterministically from the
 * AES-GCM sealed payload; marks non-empty Part 3 (Essay) answers for Super Admin review
 * without requiring Gemini API.
 */
export async function gradePublishedExamInWorker(
  params: {
    examId: string
    sealedGradingPayload: string
    studentAnswers: StudentAnswerInput[]
  },
  env: WorkerEnv
): Promise<ServerGradeResponse> {
  const unsealed = await unsealExamGradingPayloadWorker(
    params.sealedGradingPayload,
    env
  )

  if (unsealed.examId !== params.examId) {
    throw new Error('Mã đề thi không khớp với gói niêm phong chấm điểm.')
  }

  const answerByQuestionId = new Map<string, StudentAnswerInput>()
  for (const ans of params.studentAnswers) {
    if (ans && typeof ans.questionId === 'string') {
      answerByQuestionId.set(ans.questionId, ans)
    }
  }

  let part1Score = 0
  let part1Max = 0
  let part2Score = 0
  let part2Max = 0
  let part3Max = 0
  let essayCount = 0
  let hasEssayPendingReview = false

  const gradedAnswers: GradedSubmissionAnswer[] = []

  for (const item of unsealed.items) {
    const submitted = answerByQuestionId.get(item.id)

    if (item.questionType === 'multiple_choice' || item.part === 1) {
      part1Max = roundScore(part1Max + item.points)
      const chosen = submitted?.selectedOption ?? null
      const correct = item.answerKey ?? null
      const isCorrect = chosen !== null && correct !== null && chosen === correct
      const earned = isCorrect ? roundScore(item.points) : 0
      part1Score = roundScore(part1Score + earned)

      gradedAnswers.push({
        questionId: item.id,
        part: item.part,
        questionType: 'multiple_choice',
        questionText: item.questionText,
        maxPoints: item.points,
        earnedPoints: earned,
        selectedOption: chosen,
        correctOption: correct,
        explanation: item.explanation || '',
      })
      continue
    }

    if (item.questionType === 'true_false' || item.part === 2) {
      part2Max = roundScore(part2Max + item.points)
      const choices = submitted?.statementChoices ?? {
        a: null,
        b: null,
        c: null,
        d: null,
      }
      const correctMap = {
        a: Boolean(item.statementAnswerA),
        b: Boolean(item.statementAnswerB),
        c: Boolean(item.statementAnswerC),
        d: Boolean(item.statementAnswerD),
      }
      let correctCount = 0
      if (choices.a !== null && choices.a === correctMap.a) correctCount += 1
      if (choices.b !== null && choices.b === correctMap.b) correctCount += 1
      if (choices.c !== null && choices.c === correctMap.c) correctCount += 1
      if (choices.d !== null && choices.d === correctMap.d) correctCount += 1

      const earned = computeTrueFalseScore(
        correctCount,
        item.points,
        unsealed.part2ScoringMode
      )
      part2Score = roundScore(part2Score + earned)

      gradedAnswers.push({
        questionId: item.id,
        part: item.part,
        questionType: 'true_false',
        questionText: item.questionText,
        maxPoints: item.points,
        earnedPoints: earned,
        statementChoices: choices,
        correctStatements: correctMap,
        trueFalseCorrectCount: correctCount,
        explanation: item.explanation || '',
      })
      continue
    }

    // Part 3: Essay (Phase 1 basic mode: blank -> 0, non-blank -> Super Admin review queue)
    essayCount += 1
    part3Max = roundScore(part3Max + item.points)
    const essayText =
      typeof submitted?.essayText === 'string' ? submitted.essayText.slice(0, 12000) : ''
    const trimmed = essayText.trim()

    if (trimmed.length < 3) {
      gradedAnswers.push({
        questionId: item.id,
        part: item.part,
        questionType: 'essay',
        questionText: item.questionText,
        maxPoints: item.points,
        earnedPoints: 0,
        essayText,
        aiSuggestedScore: 0,
        aiConfidence: 'high',
        needsTeacherReview: false,
        aiFeedback: 'Thí sinh bỏ trống hoặc chưa nhập nội dung câu trả lời tự luận.',
        teacherScore: null,
        teacherComment: '',
        explanation: item.explanation || '',
      })
    } else {
      hasEssayPendingReview = true
      gradedAnswers.push({
        questionId: item.id,
        part: item.part,
        questionType: 'essay',
        questionText: item.questionText,
        maxPoints: item.points,
        earnedPoints: null,
        essayText,
        aiSuggestedScore: null,
        aiConfidence: 'unavailable',
        needsTeacherReview: true,
        aiFeedback:
          'Phần Tự luận đã được lưu và chuyển sang hàng chờ Super Admin chấm điểm trực tiếp theo biểu điểm (Rubric).',
        teacherScore: null,
        teacherComment: '',
        explanation: item.explanation || '',
      })
    }
  }

  const totalObjectiveScore = roundScore(part1Score + part2Score)
  const needsTeacherReview = hasEssayPendingReview

  let aiEssayStatus: ServerGradeResponse['aiEssayStatus'] = 'no_essay'
  let aiNotice: string | null = null
  let part3AiScore: number | null = null
  let totalProvisionalScore: number | null = totalObjectiveScore

  if (essayCount > 0) {
    if (hasEssayPendingReview) {
      aiEssayStatus = 'not_configured'
      aiNotice =
        'Phần I & II đã được chấm tự động trên máy chủ. Phần III (Tự luận) đã được lưu vào hàng chờ Super Admin chấm trực tiếp.'
      part3AiScore = null
      totalProvisionalScore = null
    } else {
      aiEssayStatus = 'graded'
      part3AiScore = 0
      totalProvisionalScore = totalObjectiveScore
    }
  }

  return {
    ok: true,
    examId: params.examId,
    part1Score,
    part1Max,
    part2Score,
    part2Max,
    part3AiScore,
    part3Max,
    totalObjectiveScore,
    totalProvisionalScore,
    totalMax: roundScore(part1Max + part2Max + part3Max),
    gradingStatus: needsTeacherReview ? 'needs_teacher_review' : 'auto_graded',
    aiEssayStatus,
    aiNotice,
    gradedAnswers,
  }
}
