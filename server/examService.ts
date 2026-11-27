import crypto from 'node:crypto'
import { Type } from '@google/genai'
import { GEMINI_MODEL, getGeminiClient } from './geminiClient.ts'
import type {
  GradedSubmissionAnswer,
  Part2ScoringMode,
  PublishedExamKeyItem,
  QuestionType,
  ServerGradeResponse,
  StudentAnswerInput,
} from '../src/types.ts'

export interface SealedExamItem {
  id: string
  part: 1 | 2 | 3
  questionType: QuestionType
  points: number
  questionText: string
  answerKey?: 'A' | 'B' | 'C' | 'D'
  statementAnswerA?: boolean
  statementAnswerB?: boolean
  statementAnswerC?: boolean
  statementAnswerD?: boolean
  rubric?: string
  sampleAnswer?: string
  explanation?: string
}

export interface SealedExamPayload {
  v: 1
  examId: string
  part2ScoringMode: Part2ScoringMode
  totalPoints: number
  items: SealedExamItem[]
}

const SEAL_PREFIX = 'tinlab.seal.v1'

function getSealingKeyBuffer(): Buffer {
  const configured = process.env.EXAM_SEALING_SECRET?.trim()
  const seed = configured && configured.length >= 8
    ? `tinlab-configured:${configured}`
    : 'tinlab-fallback-seal:windy-spot-0pd8p:ai-studio-tinlab-7ba2c9ff-c091-4346-a42d-411a24aea277'
  return crypto.createHash('sha256').update(seed).digest()
}

function roundScore(val: number): number {
  return Math.round(val * 1000) / 1000
}

export function sealExamGradingPayload(payload: SealedExamPayload): string {
  const key = getSealingKeyBuffer()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const json = JSON.stringify(payload)
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    SEAL_PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.')
}

export function unsealExamGradingPayload(sealed: string): SealedExamPayload {
  const parts = sealed.split('.')
  if (parts.length !== 6 || `${parts[0]}.${parts[1]}.${parts[2]}` !== SEAL_PREFIX) {
    throw new Error('Dữ liệu niêm phong đáp án không đúng định dạng.')
  }
  const iv = Buffer.from(parts[3], 'base64url')
  const tag = Buffer.from(parts[4], 'base64url')
  const ciphertext = Buffer.from(parts[5], 'base64url')

  const key = getSealingKeyBuffer()
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  const parsed = JSON.parse(plain) as SealedExamPayload
  if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.items)) {
    throw new Error('Nội dung niêm phong đề thi không hợp lệ.')
  }
  return parsed
}

function computeTrueFalseScore(
  correctStatementsCount: number,
  maxPoints: number,
  mode: Part2ScoringMode
): number {
  if (correctStatementsCount <= 0) return 0
  if (mode === 'linear') {
    return roundScore((Math.min(4, correctStatementsCount) / 4) * maxPoints)
  }
  // tiered_2025: 1 -> 10%, 2 -> 25%, 3 -> 50%, 4 -> 100%
  if (correctStatementsCount === 1) return roundScore(maxPoints * 0.1)
  if (correctStatementsCount === 2) return roundScore(maxPoints * 0.25)
  if (correctStatementsCount === 3) return roundScore(maxPoints * 0.5)
  return roundScore(maxPoints)
}

interface AiEssayEvaluationResult {
  suggestedScore: number | null
  confidence: 'high' | 'uncertain' | 'unavailable'
  needsTeacherReview: boolean
  feedback: string
  reasonCode: 'graded' | 'uncertain' | 'not_configured' | 'error'
}

export async function evaluateEssayWithGemini(params: {
  questionText: string
  rubric: string
  sampleAnswer?: string
  maxPoints: number
  studentAnswer: string
}): Promise<AiEssayEvaluationResult> {
  const trimmedAnswer = params.studentAnswer.trim()
  if (trimmedAnswer.length < 3) {
    return {
      suggestedScore: 0,
      confidence: 'high',
      needsTeacherReview: false,
      feedback: 'Thí sinh bỏ trống hoặc chưa nhập nội dung câu trả lời tự luận.',
      reasonCode: 'graded',
    }
  }

  const ai = getGeminiClient()
  if (!ai) {
    return {
      suggestedScore: null,
      confidence: 'unavailable',
      needsTeacherReview: true,
      feedback:
        'Chưa cấu hình GEMINI_API_KEY trên máy chủ nên hệ thống không chấm tự động. Câu tự luận đã được chuyển sang hàng chờ Giáo viên chấm trực tiếp.',
      reasonCode: 'not_configured',
    }
  }

  const prompt = [
    'Bạn là trợ lý chấm bài tự luận môn Tin học THPT theo đúng biểu điểm (rubric) do giáo viên phê duyệt.',
    'Quy tắc chấm:',
    '- Chỉ dựa vào đề bài, biểu điểm/hướng dẫn chấm và đáp án tham khảo bên dưới.',
    '- Không cộng điểm cho nội dung ngoài biểu điểm.',
    '- Nếu bài làm của học sinh dùng cách diễn đạt khác nhưng đúng bản chất, trình bày lập luận hoặc mã giả/SQL/HTML/CSS đúng, hãy chấm theo mức độ đáp ứng từng ý trong biểu điểm.',
    '- Đặt confidence = "uncertain" nếu câu trả lời mơ hồ, thiếu ý trung tâm khiến khó phân định mức điểm, hoặc có cách làm lạ cần giáo viên xem lại.',
    `- Điểm tối đa của câu hỏi này là ${params.maxPoints} điểm. suggestedScore phải nằm trong khoảng [0, ${params.maxPoints}].`,
    '',
    `ĐỀ BÀI:\n${params.questionText}`,
    '',
    `HƯỚNG DẪN CHẤM / BIỂU ĐIỂM (RUBRIC):\n${params.rubric}`,
    params.sampleAnswer ? `\nGỢI Ý TRẢ LỜI MẪU:\n${params.sampleAnswer}` : '',
    '',
    `BÀI LÀM CỦA HỌC SINH:\n${trimmedAnswer}`,
  ]
    .filter(Boolean)
    .join('\n')

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            suggestedScore: {
              type: Type.NUMBER,
              description: `Suggested numeric score between 0 and ${params.maxPoints}`,
            },
            confidence: {
              type: Type.STRING,
              description: 'Must be either "high" or "uncertain"',
            },
            feedback: {
              type: Type.STRING,
              description: 'Concise Vietnamese explanation matching rubric criteria',
            },
          },
          required: ['suggestedScore', 'confidence', 'feedback'],
        },
      },
    })

    const rawText = response.text?.trim()
    if (!rawText) {
      return {
        suggestedScore: null,
        confidence: 'unavailable',
        needsTeacherReview: true,
        feedback: 'AI không trả về dữ liệu chấm điểm. Đã chuyển giáo viên chấm trực tiếp.',
        reasonCode: 'error',
      }
    }

    const parsed = JSON.parse(rawText) as {
      suggestedScore?: unknown
      confidence?: unknown
      feedback?: unknown
    }

    const numScore = Number(parsed.suggestedScore)
    if (!Number.isFinite(numScore)) {
      return {
        suggestedScore: null,
        confidence: 'unavailable',
        needsTeacherReview: true,
        feedback: 'Kết quả chấm AI không đúng định dạng điểm số. Cần giáo viên chấm trực tiếp.',
        reasonCode: 'error',
      }
    }

    const clampedScore = roundScore(Math.max(0, Math.min(params.maxPoints, numScore)))
    const isUncertain = parsed.confidence !== 'high'
    const feedbackText =
      typeof parsed.feedback === 'string' && parsed.feedback.trim().length > 0
        ? parsed.feedback.trim().slice(0, 1500)
        : 'Đã đối chiếu sơ bộ theo hướng dẫn chấm.'

    return {
      suggestedScore: clampedScore,
      confidence: isUncertain ? 'uncertain' : 'high',
      needsTeacherReview: isUncertain,
      feedback: isUncertain
        ? `[Cần giáo viên duyệt lại] ${feedbackText}`
        : feedbackText,
      reasonCode: isUncertain ? 'uncertain' : 'graded',
    }
  } catch (err) {
    console.error(
      '[TIN LAB] Gemini essay grading failed:',
      err instanceof Error ? err.message : err
    )
    return {
      suggestedScore: null,
      confidence: 'unavailable',
      needsTeacherReview: true,
      feedback:
        'Dịch vụ chấm AI tạm thời gặp lỗi kết nối. Câu tự luận được chuyển sang hàng chờ Giáo viên chấm trực tiếp.',
      reasonCode: 'error',
    }
  }
}

export async function gradeExamSubmission(params: {
  examId: string
  sealedGradingPayload: string
  studentAnswers: StudentAnswerInput[]
}): Promise<ServerGradeResponse> {
  const unsealed = unsealExamGradingPayload(params.sealedGradingPayload)
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
  let part3AiAccum = 0
  let essayCount = 0
  let hasUncertainEssay = false
  let hasNotConfiguredEssay = false
  let hasErroredEssay = false
  let hasUnavailableAiScore = false

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

    // Part 3: Essay
    essayCount += 1
    part3Max = roundScore(part3Max + item.points)
    const essayText = typeof submitted?.essayText === 'string' ? submitted.essayText : ''

    const aiEval = await evaluateEssayWithGemini({
      questionText: item.questionText,
      rubric: item.rubric || 'Chấm theo độ chính xác và lập luận đầy đủ.',
      sampleAnswer: item.sampleAnswer,
      maxPoints: item.points,
      studentAnswer: essayText,
    })

    if (aiEval.reasonCode === 'not_configured') {
      hasNotConfiguredEssay = true
      hasUnavailableAiScore = true
    } else if (aiEval.reasonCode === 'error') {
      hasErroredEssay = true
      hasUnavailableAiScore = true
    } else if (aiEval.reasonCode === 'uncertain') {
      hasUncertainEssay = true
    }

    if (aiEval.suggestedScore !== null) {
      part3AiAccum = roundScore(part3AiAccum + aiEval.suggestedScore)
    }

    gradedAnswers.push({
      questionId: item.id,
      part: item.part,
      questionType: 'essay',
      questionText: item.questionText,
      maxPoints: item.points,
      earnedPoints: aiEval.needsTeacherReview ? null : aiEval.suggestedScore,
      essayText,
      aiSuggestedScore: aiEval.suggestedScore,
      aiConfidence: aiEval.confidence,
      needsTeacherReview: aiEval.needsTeacherReview,
      aiFeedback: aiEval.feedback,
      teacherScore: null,
      teacherComment: '',
      explanation: item.explanation || '',
    })
  }

  const totalObjectiveScore = roundScore(part1Score + part2Score)
  const needsTeacherReview =
    hasNotConfiguredEssay || hasErroredEssay || hasUncertainEssay

  let aiEssayStatus: ServerGradeResponse['aiEssayStatus'] = 'no_essay'
  let aiNotice: string | null = null
  let part3AiScore: number | null = null
  let totalProvisionalScore: number | null = totalObjectiveScore

  if (essayCount > 0) {
    part3AiScore = hasUnavailableAiScore ? null : roundScore(part3AiAccum)
    if (hasNotConfiguredEssay) {
      aiEssayStatus = 'not_configured'
      aiNotice =
        'Phần I & II đã được chấm tự động trên máy chủ. Máy chủ chưa cấu hình GEMINI_API_KEY nên phần III (Tự luận) đã được đánh dấu chờ Giáo viên chấm trực tiếp.'
      totalProvisionalScore = null
    } else if (hasErroredEssay) {
      aiEssayStatus = 'error'
      aiNotice =
        'Phần I & II đã được chấm tự động trên máy chủ. Dịch vụ AI tạm thời không phản hồi nên phần III (Tự luận) đang chờ Giáo viên chấm trực tiếp.'
      totalProvisionalScore = null
    } else if (hasUncertainEssay) {
      aiEssayStatus = 'uncertain_review_required'
      aiNotice =
        'Phần I & II đã được chấm tự động. Có câu Tự luận AI đánh giá chưa chắc chắn nên bài thi được gắn cờ chờ Giáo viên rà soát và chốt điểm.'
      totalProvisionalScore =
        part3AiScore !== null ? roundScore(totalObjectiveScore + part3AiScore) : null
    } else {
      aiEssayStatus = 'graded'
      aiNotice =
        'AI đã chấm sơ bộ phần Tự luận theo hướng dẫn chấm của giáo viên. Giáo viên vẫn có thể rà soát và điều chỉnh điểm cuối cùng.'
      totalProvisionalScore =
        part3AiScore !== null ? roundScore(totalObjectiveScore + part3AiScore) : null
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

export function convertKeyItemToSealed(
  item: PublishedExamKeyItem,
  questionText: string
): SealedExamItem {
  return {
    id: item.id,
    part: item.part,
    questionType: item.questionType,
    points: item.points,
    questionText,
    answerKey: item.answerKey,
    statementAnswerA: item.statementAnswerA,
    statementAnswerB: item.statementAnswerB,
    statementAnswerC: item.statementAnswerC,
    statementAnswerD: item.statementAnswerD,
    rubric: item.rubric,
    sampleAnswer: item.sampleAnswer,
    explanation: item.explanation,
  }
}
