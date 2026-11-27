import { useState, type FormEvent } from 'react'
import { AlertCircle, Check, X } from 'lucide-react'
import type { AnswerOptionKey, CognitiveLevel, QuestionType } from '../types'
import { validateQuestionForBlueprint } from '../lib/questionBankDb'

export interface EditableQuestionValues {
  questionType: QuestionType
  bankName: string
  topic: string
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
  sampleAnswer: string
  explanation: string
}

interface QuestionEditModalProps {
  title: string
  initialValues: EditableQuestionValues
  allowTypeChange?: boolean
  requireVerifiedAnswer?: boolean
  submitting?: boolean
  onCancel: () => void
  onSave: (values: EditableQuestionValues) => Promise<void> | void
}

const COGNITIVE_OPTIONS: { value: CognitiveLevel; label: string }[] = [
  { value: 'recognition', label: 'Nhận biết' },
  { value: 'understanding', label: 'Thông hiểu' },
  { value: 'application', label: 'Vận dụng' },
  { value: 'unspecified', label: 'Chưa xác định' },
]

const QUESTION_TYPE_OPTIONS: { value: QuestionType; label: string }[] = [
  { value: 'multiple_choice', label: 'Trắc nghiệm 4 lựa chọn (A/B/C/D)' },
  { value: 'true_false', label: 'Trắc nghiệm Đúng / Sai (4 ý a, b, c, d)' },
  { value: 'essay', label: 'Tự luận (kèm hướng dẫn chấm / Rubric)' },
]

export function QuestionEditModal({
  title,
  initialValues,
  allowTypeChange = false,
  requireVerifiedAnswer = false,
  submitting = false,
  onCancel,
  onSave,
}: QuestionEditModalProps) {
  const [questionType, setQuestionType] = useState<QuestionType>(initialValues.questionType)
  const [bankName, setBankName] = useState(initialValues.bankName)
  const [topic, setTopic] = useState(initialValues.topic)
  const [lessonTitle, setLessonTitle] = useState(initialValues.lessonTitle)
  const [questionNumber, setQuestionNumber] = useState(initialValues.questionNumber)
  const [pageNumberInput, setPageNumberInput] = useState(
    initialValues.pageNumber !== null ? String(initialValues.pageNumber) : ''
  )
  const [cognitiveLevel, setCognitiveLevel] = useState<CognitiveLevel>(
    initialValues.cognitiveLevel
  )
  const [questionText, setQuestionText] = useState(initialValues.questionText)

  // MCQ
  const [optionA, setOptionA] = useState(initialValues.optionA)
  const [optionB, setOptionB] = useState(initialValues.optionB)
  const [optionC, setOptionC] = useState(initialValues.optionC)
  const [optionD, setOptionD] = useState(initialValues.optionD)
  const [answerKey, setAnswerKey] = useState<AnswerOptionKey | null>(initialValues.answerKey)

  // True/False
  const [statementA, setStatementA] = useState(initialValues.statementA)
  const [statementB, setStatementB] = useState(initialValues.statementB)
  const [statementC, setStatementC] = useState(initialValues.statementC)
  const [statementD, setStatementD] = useState(initialValues.statementD)
  const [statementAnswerA, setStatementAnswerA] = useState<boolean | null>(
    initialValues.statementAnswerA
  )
  const [statementAnswerB, setStatementAnswerB] = useState<boolean | null>(
    initialValues.statementAnswerB
  )
  const [statementAnswerC, setStatementAnswerC] = useState<boolean | null>(
    initialValues.statementAnswerC
  )
  const [statementAnswerD, setStatementAnswerD] = useState<boolean | null>(
    initialValues.statementAnswerD
  )

  // Essay & Explanation
  const [rubric, setRubric] = useState(initialValues.rubric)
  const [sampleAnswer, setSampleAnswer] = useState(initialValues.sampleAnswer)
  const [explanation, setExplanation] = useState(initialValues.explanation)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedPage = pageNumberInput.trim()
    let parsedPage: number | null = null
    if (trimmedPage !== '') {
      const n = Number(trimmedPage)
      if (!Number.isInteger(n) || n < 1 || n > 5000) {
        setError('Số trang phải là số nguyên từ 1 đến 5000 hoặc để trống.')
        return
      }
      parsedPage = n
    }

    const nextValues: EditableQuestionValues = {
      questionType,
      bankName: bankName.trim(),
      topic: topic.trim(),
      lessonTitle: lessonTitle.trim(),
      questionNumber: questionNumber.trim(),
      pageNumber: parsedPage,
      cognitiveLevel,
      questionText: questionText.trim(),
      optionA: optionA.trim(),
      optionB: optionB.trim(),
      optionC: optionC.trim(),
      optionD: optionD.trim(),
      answerKey,
      statementA: statementA.trim(),
      statementB: statementB.trim(),
      statementC: statementC.trim(),
      statementD: statementD.trim(),
      statementAnswerA,
      statementAnswerB,
      statementAnswerC,
      statementAnswerD,
      rubric: rubric.trim(),
      sampleAnswer: sampleAnswer.trim(),
      explanation: explanation.trim(),
    }

    if (requireVerifiedAnswer) {
      const validationMsg = validateQuestionForBlueprint(nextValues)
      if (validationMsg) {
        setError(validationMsg)
        return
      }
    } else {
      const tempCheck = validateQuestionForBlueprint({
        ...nextValues,
        answerKey: nextValues.answerKey ?? 'A',
        statementAnswerA: nextValues.statementAnswerA ?? true,
        statementAnswerB: nextValues.statementAnswerB ?? true,
        statementAnswerC: nextValues.statementAnswerC ?? true,
        statementAnswerD: nextValues.statementAnswerD ?? true,
        rubric: nextValues.rubric || 'Chờ giáo viên bổ sung biểu điểm chi tiết.',
      })
      if (tempCheck) {
        setError(tempCheck)
        return
      }
    }

    try {
      await onSave(nextValues)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Không thể lưu chỉnh sửa câu hỏi.'
      )
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-question-title"
    >
      <div className="my-8 w-full max-w-3xl rounded-xl border border-slate-200 bg-white shadow-xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 bg-[#F3F6FA] px-6 py-4">
          <h2
            id="edit-question-title"
            className="font-display text-base font-bold text-[#123B68]"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            aria-label="Đóng hộp thoại"
            className="rounded-lg p-1.5 text-[#65758B] hover:bg-slate-200/70 hover:text-[#123B68] transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[82vh] overflow-y-auto">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-12">
            <div className="sm:col-span-6">
              <label className="block text-xs font-semibold text-[#203247] mb-1">
                Định dạng câu hỏi
              </label>
              <select
                value={questionType}
                disabled={!allowTypeChange}
                onChange={(e) => setQuestionType(e.target.value as QuestionType)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247] disabled:bg-slate-100 disabled:text-[#65758B] focus:border-[#2878B8] focus:outline-none"
              >
                {QUESTION_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-6">
              <label className="block text-xs font-semibold text-[#203247] mb-1">
                Tên Ngân hàng câu hỏi / Bộ đề nguồn
              </label>
              <input
                type="text"
                maxLength={120}
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="Ví dụ: Ngân hàng Tin 12 · HK1 2025"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-[#203247] focus:border-[#2878B8] focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-12">
            <div className="sm:col-span-3">
              <label className="block text-xs font-semibold text-[#203247] mb-1">
                Số câu
              </label>
              <input
                type="text"
                maxLength={40}
                value={questionNumber}
                onChange={(e) => setQuestionNumber(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-[#203247] focus:border-[#2878B8] focus:outline-none"
              />
            </div>

            <div className="sm:col-span-6">
              <label className="block text-xs font-semibold text-[#203247] mb-1">
                Bài học
              </label>
              <input
                type="text"
                maxLength={200}
                value={lessonTitle}
                onChange={(e) => setLessonTitle(e.target.value)}
                placeholder="Ví dụ: Bài 1. Làm quen với Trí tuệ nhân tạo"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-[#203247] focus:border-[#2878B8] focus:outline-none"
              />
            </div>

            <div className="sm:col-span-3">
              <label className="block text-xs font-semibold text-[#203247] mb-1">
                Trang
              </label>
              <input
                type="number"
                min={1}
                max={5000}
                value={pageNumberInput}
                onChange={(e) => setPageNumberInput(e.target.value)}
                placeholder="Trống"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums text-[#203247] focus:border-[#2878B8] focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-[#203247] mb-1">
                Chuyên đề / Chủ đề
              </label>
              <input
                type="text"
                maxLength={150}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="Ví dụ: Chủ đề A · Máy tính và Xã hội tri thức"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-[#203247] focus:border-[#2878B8] focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#203247] mb-1">
                Mức độ nhận thức
              </label>
              <select
                value={cognitiveLevel}
                onChange={(e) => setCognitiveLevel(e.target.value as CognitiveLevel)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247] focus:border-[#2878B8] focus:outline-none"
              >
                {COGNITIVE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#203247] mb-1">
              Nội dung câu hỏi (giữ nguyên văn gốc)
            </label>
            <textarea
              rows={3}
              maxLength={4000}
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm leading-relaxed text-[#203247] focus:border-[#2878B8] focus:outline-none"
            />
          </div>

          {/* Multiple Choice Options */}
          {questionType === 'multiple_choice' && (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-[#F3F6FA]/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-[#123B68]">
                  4 Phương án &amp; Đáp án đúng
                </span>
                <div className="inline-flex items-center gap-1.5">
                  <span className="text-xs text-[#65758B]">Đáp án đúng:</span>
                  {(['A', 'B', 'C', 'D'] as AnswerOptionKey[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setAnswerKey(key)}
                      className={`rounded-md border px-2.5 py-1 text-xs font-bold transition-colors ${
                        answerKey === key
                          ? 'border-[#55A747] bg-[#55A747] text-white'
                          : 'border-slate-300 bg-white text-[#203247] hover:bg-[#F3F6FA]'
                      }`}
                    >
                      {key}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-[#203247] mb-1">
                    Phương án A
                  </label>
                  <input
                    type="text"
                    maxLength={1500}
                    value={optionA}
                    onChange={(e) => setOptionA(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#203247] mb-1">
                    Phương án B
                  </label>
                  <input
                    type="text"
                    maxLength={1500}
                    value={optionB}
                    onChange={(e) => setOptionB(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#203247] mb-1">
                    Phương án C
                  </label>
                  <input
                    type="text"
                    maxLength={1500}
                    value={optionC}
                    onChange={(e) => setOptionC(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#203247] mb-1">
                    Phương án D
                  </label>
                  <input
                    type="text"
                    maxLength={1500}
                    value={optionD}
                    onChange={(e) => setOptionD(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247]"
                  />
                </div>
              </div>
            </div>
          )}

          {/* True / False 4 statements */}
          {questionType === 'true_false' && (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-[#F3F6FA]/60 p-4">
              <div className="text-xs font-bold text-[#123B68]">
                4 Mệnh đề a, b, c, d &amp; Đáp án Đúng / Sai cho từng ý
              </div>
              {(
                [
                  {
                    letter: 'a',
                    text: statementA,
                    setText: setStatementA,
                    ans: statementAnswerA,
                    setAns: setStatementAnswerA,
                  },
                  {
                    letter: 'b',
                    text: statementB,
                    setText: setStatementB,
                    ans: statementAnswerB,
                    setAns: setStatementAnswerB,
                  },
                  {
                    letter: 'c',
                    text: statementC,
                    setText: setStatementC,
                    ans: statementAnswerC,
                    setAns: setStatementAnswerC,
                  },
                  {
                    letter: 'd',
                    text: statementD,
                    setText: setStatementD,
                    ans: statementAnswerD,
                    setAns: setStatementAnswerD,
                  },
                ] as const
              ).map((row) => (
                <div
                  key={row.letter}
                  className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-lg border border-slate-200 bg-white p-2.5"
                >
                  <span className="font-mono text-xs font-bold text-[#123B68] w-6 shrink-0">
                    {row.letter})
                  </span>
                  <input
                    type="text"
                    maxLength={1500}
                    value={row.text}
                    onChange={(e) => row.setText(e.target.value)}
                    placeholder={`Nội dung ý ${row.letter})...`}
                    className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-[#203247]"
                  />
                  <div className="inline-flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => row.setAns(true)}
                      className={`rounded px-2.5 py-1 text-xs font-bold border transition-colors ${
                        row.ans === true
                          ? 'border-[#55A747] bg-[#55A747] text-white'
                          : 'border-slate-300 bg-white text-[#203247]'
                      }`}
                    >
                      Đúng
                    </button>
                    <button
                      type="button"
                      onClick={() => row.setAns(false)}
                      className={`rounded px-2.5 py-1 text-xs font-bold border transition-colors ${
                        row.ans === false
                          ? 'border-[#D94B45] bg-[#D94B45] text-white'
                          : 'border-slate-300 bg-white text-[#203247]'
                      }`}
                    >
                      Sai
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Essay Rubric & Sample */}
          {questionType === 'essay' && (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-[#F3F6FA]/60 p-4">
              <div>
                <label className="block text-xs font-bold text-[#123B68] mb-1">
                  Hướng dẫn chấm / Biểu điểm chi tiết (Rubric) *
                </label>
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={rubric}
                  onChange={(e) => setRubric(e.target.value)}
                  placeholder="Ví dụ: Nêu đúng khái niệm (+0.5đ); viết đúng câu lệnh SQL SELECT...WHERE (+1.0đ)..."
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#203247] mb-1">
                  Gợi ý trả lời mẫu (tùy chọn)
                </label>
                <textarea
                  rows={2}
                  maxLength={4000}
                  value={sampleAnswer}
                  onChange={(e) => setSampleAnswer(e.target.value)}
                  placeholder="Bài giải hoặc đoạn mã tham khảo giúp AI và giáo viên đối chiếu..."
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247]"
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-[#203247] mb-1">
              Giải thích đáp án chi tiết (hiển thị cho học sinh sau khi nộp bài)
            </label>
            <textarea
              rows={2}
              maxLength={3000}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              placeholder="Ví dụ: Căn cứ theo chuẩn HTML5 thẻ <a> dùng thuộc tính href..."
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-[#203247]"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-3.5 py-2.5 text-xs text-[#A92F2A]"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-[#203247] hover:bg-[#F3F6FA] transition-colors"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-[#2878B8] px-4 py-2 text-sm font-semibold text-white hover:bg-[#123B68] disabled:opacity-60 transition-colors"
            >
              <Check className="h-4 w-4" />
              <span>{submitting ? 'Đang lưu...' : 'Lưu câu hỏi'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
