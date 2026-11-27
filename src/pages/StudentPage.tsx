import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Clock,
  FileCheck2,
  GraduationCap,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import { fetchStudentPublishedExams } from '../lib/examDb'
import {
  startStudentExamAttempt,
  submitPublishedExamAttempt,
  type StartedAttemptInfo,
} from '../lib/studentResultsClient'
import {
  normalizeClassName,
  validateClassName,
  validateStudentFullName,
} from '../lib/studentValidation'
import type {
  AnswerOptionKey,
  NavPage,
  PublishedExam,
  ServerGradeResponse,
  StudentAnswerInput,
} from '../types'

interface StudentPageProps {
  onNavigate: (page: NavPage) => void
}

interface SessionAttemptLogItem {
  attemptId: string
  examTitle: string
  studentName: string
  className: string
  score: number | null
  maxScore: number
  submittedAt: string | null
  completionStatus: string
}

const OPTION_LETTERS: AnswerOptionKey[] = ['A', 'B', 'C', 'D']

function formatTime(totalSeconds: number) {
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function formatViTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('vi-VN')
}

export function StudentPage({ onNavigate }: StudentPageProps) {
  // Student identity inputs (no account/login/email/phone required)
  const [studentName, setStudentName] = useState('')
  const [studentClass, setStudentClass] = useState('')
  const [entryNameError, setEntryNameError] = useState<string | null>(null)
  const [entryClassError, setEntryClassError] = useState<string | null>(null)
  const [entryServerError, setEntryServerError] = useState<string | null>(null)
  const [startingAttempt, setStartingAttempt] = useState(false)

  // Exam selection + pre-start gate
  const [pendingExam, setPendingExam] = useState<PublishedExam | null>(null)
  const [activeAttempt, setActiveAttempt] = useState<StartedAttemptInfo | null>(null)

  // Published multi-part exams from Firestore
  const [publishedExams, setPublishedExams] = useState<PublishedExam[]>([])
  const [loadingPublished, setLoadingPublished] = useState(true)
  const [publishedError, setPublishedError] = useState<string | null>(null)
  const [accessCodeInput, setAccessCodeInput] = useState('')

  // Active Published Exam state
  const [activePublishedExam, setActivePublishedExam] = useState<PublishedExam | null>(null)
  const [mcqAnswers, setMcqAnswers] = useState<Record<string, AnswerOptionKey>>({})
  const [tfAnswers, setTfAnswers] = useState<
    Record<string, { a: boolean | null; b: boolean | null; c: boolean | null; d: boolean | null }>
  >({})
  const [essayAnswers, setEssayAnswers] = useState<Record<string, string>>({})
  const [gradingPublished, setGradingPublished] = useState(false)
  const [gradeResult, setGradeResult] = useState<ServerGradeResponse | null>(null)
  const [publishedSubmittedAt, setPublishedSubmittedAt] = useState<string | null>(null)
  const [gradeError, setGradeError] = useState<string | null>(null)

  // Timer + session-only completed attempts
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [sessionAttempts, setSessionAttempts] = useState<SessionAttemptLogItem[]>([])

  const loadPublishedExams = useCallback(async () => {
    setLoadingPublished(true)
    setPublishedError(null)
    try {
      const exams = await fetchStudentPublishedExams()
      setPublishedExams(exams)
    } catch (err) {
      setPublishedError(
        err instanceof Error ? err.message : 'Không thể tải danh sách đề thi đang mở.'
      )
    } finally {
      setLoadingPublished(false)
    }
  }, [])

  useEffect(() => {
    void loadPublishedExams()
  }, [loadPublishedExams])

  const normalizedClassPreview = useMemo(() => {
    return studentClass.trim() ? normalizeClassName(studentClass) : ''
  }, [studentClass])

  const openExamEntryGate = (exam: PublishedExam) => {
    setEntryNameError(null)
    setEntryClassError(null)
    setEntryServerError(null)
    setActivePublishedExam(null)
    setActiveAttempt(null)
    setGradeResult(null)
    setPendingExam(exam)
  }

  const handleConfirmStartAttempt = async (e: FormEvent) => {
    e.preventDefault()
    if (!pendingExam || startingAttempt) return

    const nameCheck = validateStudentFullName(studentName)
    const classCheck = validateClassName(studentClass)

    setEntryNameError(nameCheck.ok ? null : nameCheck.error)
    setEntryClassError(classCheck.ok ? null : classCheck.error)
    setEntryServerError(null)

    if (!nameCheck.ok || !classCheck.ok) {
      return
    }

    setStartingAttempt(true)
    try {
      const started = await startStudentExamAttempt({
        studentName: nameCheck.display,
        className: classCheck.normalized,
        examId: pendingExam.id,
        examTitle: pendingExam.title,
        examKind: 'published',
        accessCode: pendingExam.accessCode,
        maxScore: pendingExam.totalPoints,
        scoringMode: pendingExam.part2ScoringMode,
      })

      setStudentName(started.studentName)
      setStudentClass(started.className)
      setActiveAttempt(started)
      setActivePublishedExam(pendingExam)
      setMcqAnswers({})
      setTfAnswers({})
      setEssayAnswers({})
      setGradeResult(null)
      setPublishedSubmittedAt(null)
      setGradeError(null)
      setSecondsLeft(pendingExam.durationMinutes * 60)
      setPendingExam(null)
    } catch (err) {
      setEntryServerError(
        err instanceof Error
          ? err.message
          : 'Không thể khởi tạo phiên làm bài. Vui lòng kiểm tra thông tin.'
      )
    } finally {
      setStartingAttempt(false)
    }
  }

  const submitPublishedExam = useCallback(async () => {
    if (!activePublishedExam || !activeAttempt || gradingPublished || gradeResult) return
    setGradingPublished(true)
    setGradeError(null)
    try {
      const studentAnswers: StudentAnswerInput[] = activePublishedExam.questions.map((q) => {
        if (q.questionType === 'multiple_choice') {
          return {
            questionId: q.id,
            questionType: 'multiple_choice',
            selectedOption: mcqAnswers[q.id] ?? null,
          }
        }
        if (q.questionType === 'true_false') {
          return {
            questionId: q.id,
            questionType: 'true_false',
            statementChoices: tfAnswers[q.id] ?? {
              a: null,
              b: null,
              c: null,
              d: null,
            },
          }
        }
        return {
          questionId: q.id,
          questionType: 'essay',
          essayText: essayAnswers[q.id] ?? '',
        }
      })

      const res = await submitPublishedExamAttempt({
        attemptId: activeAttempt.attemptId,
        examId: activePublishedExam.id,
        sealedGradingPayload: activePublishedExam.sealedGradingPayload,
        studentAnswers,
      })

      setGradeResult(res.gradeResult)
      setPublishedSubmittedAt(res.submittedAt)
      setSessionAttempts((prev) => [
        {
          attemptId: res.attemptId,
          examTitle: activePublishedExam.title,
          studentName: res.studentName,
          className: res.className,
          score: res.gradeResult.totalProvisionalScore,
          maxScore: res.gradeResult.totalMax,
          submittedAt: res.submittedAt,
          completionStatus: res.completionStatus,
        },
        ...prev,
      ])
    } catch (err) {
      setGradeError(
        err instanceof Error
          ? err.message
          : 'Mất kết nối tới máy chủ chấm bài. Vui lòng thử lại.'
      )
    } finally {
      setGradingPublished(false)
    }
  }, [
    activePublishedExam,
    activeAttempt,
    gradingPublished,
    gradeResult,
    mcqAnswers,
    tfAnswers,
    essayAnswers,
  ])

  // Countdown timer for active published exam
  useEffect(() => {
    const isPublishedRunning = Boolean(activePublishedExam && !gradeResult)
    if (!isPublishedRunning) return

    const timer = window.setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          window.clearInterval(timer)
          void submitPublishedExam()
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => window.clearInterval(timer)
  }, [activePublishedExam, gradeResult, submitPublishedExam])

  const handleOpenByAccessCode = () => {
    const clean = accessCodeInput.trim().toUpperCase()
    if (!clean) return
    const found = publishedExams.find((e) => e.accessCode.toUpperCase() === clean)
    if (!found) {
      setPublishedError(`Không tìm thấy kỳ thi nào đang mở với mã phòng "${clean}".`)
      return
    }
    setPublishedError(null)
    openExamEntryGate(found)
  }

  // 0. Required Student Entry Form Gate (Shown before starting any published exam)
  if (pendingExam) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <button
          type="button"
          onClick={() => setPendingExam(null)}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2878B8] hover:text-[#123B68]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Quay lại danh sách đề thi</span>
        </button>

        <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-200 bg-[#123B68] px-6 py-5 text-white space-y-1.5">
            <div className="text-xs font-semibold text-[#7DD3FC]">
              Đề thi chính thức · Mã phòng: {pendingExam.accessCode}
            </div>
            <h1 className="font-display text-xl sm:text-2xl font-bold">
              {pendingExam.title}
            </h1>
            <div className="text-xs text-slate-200 tabular-nums">
              Thời lượng: {pendingExam.durationMinutes} phút · Thang {pendingExam.totalPoints} điểm
              (P1: {pendingExam.part1Count} TN · P2: {pendingExam.part2Count} Đ/S · P3:{' '}
              {pendingExam.part3Count} Tự luận)
            </div>
          </div>

          <div className="p-6 sm:p-8 space-y-6">
            {/* Instructions Box */}
            <div className="rounded-xl border border-[#2878B8]/25 bg-[#EAF3FA]/60 p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs font-bold text-[#123B68]">
                <BookOpen className="h-4 w-4 text-[#2878B8]" />
                <span>Hướng dẫn &amp; Quy định làm bài</span>
              </div>
              <ul className="list-disc pl-5 space-y-1 text-xs leading-relaxed text-[#203247]">
                <li>
                  Học sinh không cần tạo tài khoản, mật khẩu hoặc đăng nhập email; chỉ cần nhập đúng{' '}
                  <strong>Họ và tên</strong> và <strong>Lớp</strong> bên dưới.
                </li>
                <li>
                  Khi bấm bắt đầu, hệ thống tự động cấp một{' '}
                  <strong>Mã lượt thi duy nhất (Attempt ID)</strong> và ghi nhận thời điểm bắt đầu làm bài.
                </li>
                <li>
                  Đáp án chỉ được chấm và hiển thị sau khi nộp bài thành công; kết quả được lưu lịch sử theo từng lượt làm bài trong PostgreSQL.
                </li>
                {pendingExam.part3Count > 0 && (
                  <li>
                    Phần Tự luận được chấm theo biểu điểm (Rubric) và có thể được Super Admin rà soát, chốt điểm cuối cùng.
                  </li>
                )}
              </ul>
            </div>

            {/* Required Identity Form */}
            <form onSubmit={(e) => void handleConfirmStartAttempt(e)} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="entry-student-name"
                    className="block text-sm font-semibold text-[#123B68] mb-1.5"
                  >
                    Họ và tên học sinh <span className="text-[#D94B45]">*</span>
                  </label>
                  <input
                    id="entry-student-name"
                    type="text"
                    required
                    value={studentName}
                    onChange={(e) => {
                      setStudentName(e.target.value)
                      if (entryNameError) setEntryNameError(null)
                    }}
                    placeholder="Ví dụ: Nguyễn Minh Anh"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-[#203247] placeholder:text-[#65758B]/70 focus:border-[#2878B8] focus:outline-none focus:ring-2 focus:ring-[#2878B8]/20"
                  />
                  {entryNameError && (
                    <p className="mt-1.5 text-xs text-[#A92F2A]">{entryNameError}</p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="entry-student-class"
                    className="block text-sm font-semibold text-[#123B68] mb-1.5"
                  >
                    Lớp <span className="text-[#D94B45]">*</span>
                  </label>
                  <input
                    id="entry-student-class"
                    type="text"
                    required
                    value={studentClass}
                    onChange={(e) => {
                      setStudentClass(e.target.value)
                      if (entryClassError) setEntryClassError(null)
                    }}
                    placeholder="Ví dụ: 12A1"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-[#203247] placeholder:text-[#65758B]/70 focus:border-[#2878B8] focus:outline-none focus:ring-2 focus:ring-[#2878B8]/20"
                  />
                  {normalizedClassPreview && !entryClassError && (
                    <p className="mt-1.5 text-[11px] text-[#2D6A23]">
                      Tên lớp chuẩn hóa:{' '}
                      <strong className="font-mono">{normalizedClassPreview}</strong>
                    </p>
                  )}
                  {entryClassError && (
                    <p className="mt-1.5 text-xs text-[#A92F2A]">{entryClassError}</p>
                  )}
                </div>
              </div>

              {entryServerError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
                  <span>{entryServerError}</span>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-end gap-3 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setPendingExam(null)}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 min-h-[44px] text-sm font-semibold text-[#203247] hover:bg-[#F3F6FA]"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={startingAttempt}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#2878B8] px-6 py-2.5 min-h-[44px] text-sm font-semibold text-white hover:bg-[#123B68] disabled:opacity-60 transition-colors"
                >
                  {startingAttempt ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Đang tạo phiên làm bài...</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4" />
                      <span>Xác nhận &amp; Bắt đầu làm bài</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>
    )
  }

  // 1. Active Published Multi-Part Exam Mode
  if (activePublishedExam && activeAttempt) {
    const part1Questions = activePublishedExam.questions.filter((q) => q.part === 1)
    const part2Questions = activePublishedExam.questions.filter((q) => q.part === 2)
    const part3Questions = activePublishedExam.questions.filter((q) => q.part === 3)

    const findGraded = (qId: string) =>
      gradeResult?.gradedAnswers.find((a) => a.questionId === qId) ?? null

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-6 py-4">
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => {
                setActivePublishedExam(null)
                setActiveAttempt(null)
              }}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2878B8] hover:text-[#123B68]"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Quay lại Khu vực Học sinh</span>
            </button>
            <h1 className="font-display text-xl font-bold text-[#123B68]">
              {activePublishedExam.title}
            </h1>
            <div className="text-xs text-[#65758B] tabular-nums">
              Thí sinh: <strong className="text-[#123B68]">{activeAttempt.studentName}</strong> ·
              Lớp: <strong className="font-mono text-[#123B68]">{activeAttempt.className}</strong> ·
              Mã lượt thi:{' '}
              <strong className="font-mono text-[#2878B8]" title={activeAttempt.attemptId}>
                #{activeAttempt.attemptId.slice(0, 8)}
              </strong>{' '}
              · Bắt đầu: {formatViTime(activeAttempt.startedAt)}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="inline-flex items-center gap-2 rounded-lg border border-[#F28C28]/40 bg-[#FEF6EC] px-3.5 py-2 text-sm font-semibold text-[#9A520B] tabular-nums">
              <Clock className="h-4 w-4 text-[#F28C28]" />
              <span>{formatTime(secondsLeft)}</span>
            </div>
            {!gradeResult ? (
              <button
                type="button"
                disabled={gradingPublished}
                onClick={() => void submitPublishedExam()}
                className="inline-flex items-center gap-2 rounded-lg bg-[#2878B8] px-4 py-2.5 min-h-[44px] text-sm font-semibold text-white hover:bg-[#123B68] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {gradingPublished ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Đang chấm &amp; lưu bài...</span>
                  </>
                ) : (
                  <>
                    <FileCheck2 className="h-4 w-4" />
                    <span>Nộp bài chấm điểm</span>
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => openExamEntryGate(activePublishedExam)}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 min-h-[44px] text-sm font-semibold text-[#123B68] hover:bg-[#F3F6FA] transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Làm lượt mới</span>
              </button>
            )}
          </div>
        </div>

        {gradeError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
            <span>{gradeError}</span>
          </div>
        )}

        {gradeResult && (
          <div className="rounded-xl border border-[#2878B8]/40 bg-[#EAF3FA] p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="text-xs font-semibold text-[#123B68]">
                  Kết quả chấm bài từ máy chủ TIN LAB · Nộp lúc {formatViTime(publishedSubmittedAt)}
                </div>
                <div className="font-display text-2xl font-extrabold text-[#123B68] tabular-nums">
                  {gradeResult.totalProvisionalScore !== null
                    ? `${gradeResult.totalProvisionalScore} / ${gradeResult.totalMax} điểm`
                    : `Trắc nghiệm & Đ/S: ${gradeResult.totalObjectiveScore}đ (Chờ chấm Tự luận)`}
                </div>
                <div className="text-xs text-[#203247] tabular-nums">
                  Phần I (TN): <strong>{gradeResult.part1Score}/{gradeResult.part1Max}đ</strong> ·
                  Phần II (Đúng/Sai): <strong>{gradeResult.part2Score}/{gradeResult.part2Max}đ</strong>
                  {gradeResult.part3Max > 0 && (
                    <span>
                      {' '}
                      · Phần III (Tự luận):{' '}
                      <strong>
                        {gradeResult.part3AiScore !== null
                          ? `~${gradeResult.part3AiScore}/${gradeResult.part3Max}đ (Gợi ý theo Rubric)`
                          : `Chờ Super Admin chấm /${gradeResult.part3Max}đ`}
                      </strong>
                    </span>
                  )}
                </div>
              </div>

              <div className="inline-flex items-center gap-1.5 rounded-lg border border-[#55A747]/40 bg-[#EEF7EC] px-3.5 py-2 text-xs font-semibold text-[#2D6A23] shrink-0">
                <CheckCircle2 className="h-4 w-4 text-[#55A747]" />
                <span>Đã lưu kết quả lượt #{activeAttempt.attemptId.slice(0, 8)}</span>
              </div>
            </div>

            {gradeResult.aiNotice && (
              <div className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs text-[#203247]">
                {gradeResult.aiNotice}
              </div>
            )}
          </div>
        )}

        {/* Part 1 */}
        {part1Questions.length > 0 && (
          <section className="space-y-4">
            <h2 className="font-display text-lg font-bold text-[#123B68]">
              Phần I. Trắc nghiệm nhiều lựa chọn ({part1Questions.length} câu ·{' '}
              {activePublishedExam.part1Points} điểm)
            </h2>
            {part1Questions.map((q, idx) => {
              const graded = findGraded(q.id)
              const chosen = mcqAnswers[q.id] ?? null
              return (
                <article
                  key={q.id}
                  className="rounded-xl border border-slate-200 bg-white p-6 space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-[#2878B8] tabular-nums">
                      Câu {idx + 1} ({q.points}đ) {q.lessonTitle ? `· ${q.lessonTitle}` : ''}
                    </span>
                    {graded && (
                      <span
                        className={`font-semibold ${
                          graded.earnedPoints && graded.earnedPoints > 0
                            ? 'text-[#2D6A23]'
                            : 'text-[#A92F2A]'
                        }`}
                      >
                        {graded.earnedPoints}/{graded.maxPoints}đ
                      </span>
                    )}
                  </div>
                  <p className="text-base font-semibold text-[#123B68] leading-relaxed">
                    {q.questionText}
                  </p>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {OPTION_LETTERS.map((letter) => {
                      const optText =
                        letter === 'A'
                          ? q.optionA
                          : letter === 'B'
                          ? q.optionB
                          : letter === 'C'
                          ? q.optionC
                          : q.optionD
                      const isSelected = chosen === letter
                      const isCorrect = graded?.correctOption === letter
                      let style =
                        'border-slate-200 bg-white text-[#203247] hover:border-[#2878B8] hover:bg-[#F3F6F9]'
                      if (!gradeResult && isSelected) {
                        style = 'border-[#2878B8] bg-[#EAF3FA] text-[#123B68] font-semibold'
                      } else if (gradeResult && isCorrect) {
                        style = 'border-[#55A747] bg-[#EEF7EC] text-[#2D6A23] font-semibold'
                      } else if (gradeResult && isSelected && !isCorrect) {
                        style = 'border-[#D94B45] bg-[#FDF1F0] text-[#A92F2A]'
                      }

                      return (
                        <button
                          key={letter}
                          type="button"
                          disabled={Boolean(gradeResult)}
                          onClick={() =>
                            setMcqAnswers((prev) => ({ ...prev, [q.id]: letter }))
                          }
                          className={`flex items-start gap-2.5 rounded-lg border p-3.5 text-left text-sm transition-colors ${style}`}
                        >
                          <span className="font-mono text-xs font-bold pt-0.5">{letter}.</span>
                          <span>{optText}</span>
                        </button>
                      )
                    })}
                  </div>
                  {gradeResult && graded?.explanation && (
                    <div className="rounded-lg border border-slate-200 bg-[#F3F6F9] px-4 py-2.5 text-xs text-[#203247]">
                      <strong className="text-[#123B68]">Giải thích: </strong>
                      {graded.explanation}
                    </div>
                  )}
                </article>
              )
            })}
          </section>
        )}

        {/* Part 2 */}
        {part2Questions.length > 0 && (
          <section className="space-y-4">
            <h2 className="font-display text-lg font-bold text-[#123B68]">
              Phần II. Trắc nghiệm Đúng / Sai ({part2Questions.length} câu ·{' '}
              {activePublishedExam.part2Points} điểm)
            </h2>
            {part2Questions.map((q, idx) => {
              const graded = findGraded(q.id)
              const currentChoices = tfAnswers[q.id] ?? {
                a: null,
                b: null,
                c: null,
                d: null,
              }
              return (
                <article
                  key={q.id}
                  className="rounded-xl border border-slate-200 bg-white p-6 space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-[#7954A1] tabular-nums">
                      Câu {idx + 1} ({q.points}đ) {q.lessonTitle ? `· ${q.lessonTitle}` : ''}
                    </span>
                    {graded && (
                      <span className="font-bold text-[#123B68] tabular-nums">
                        Đúng {graded.trueFalseCorrectCount ?? 0}/4 ý · {graded.earnedPoints}/
                        {graded.maxPoints}đ
                      </span>
                    )}
                  </div>
                  <p className="text-base font-semibold text-[#123B68] leading-relaxed">
                    {q.questionText}
                  </p>
                  <div className="space-y-2.5">
                    {(
                      [
                        { letter: 'a', text: q.statementA },
                        { letter: 'b', text: q.statementB },
                        { letter: 'c', text: q.statementC },
                        { letter: 'd', text: q.statementD },
                      ] as const
                    ).map((st) => {
                      const val = currentChoices[st.letter]
                      const correctBool = graded?.correctStatements?.[st.letter]
                      return (
                        <div
                          key={st.letter}
                          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-slate-200 bg-[#F3F6FA]/50 p-3.5"
                        >
                          <div className="text-sm text-[#203247]">
                            <strong className="text-[#123B68] mr-1.5">{st.letter})</strong>
                            <span>{st.text}</span>
                            {gradeResult && correctBool !== undefined && (
                              <span
                                className={`ml-2 text-xs font-bold ${
                                  val === correctBool ? 'text-[#2D6A23]' : 'text-[#A92F2A]'
                                }`}
                              >
                                (Đáp án: {correctBool ? 'Đúng' : 'Sai'})
                              </span>
                            )}
                          </div>
                          <div className="inline-flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={Boolean(gradeResult)}
                              onClick={() =>
                                setTfAnswers((prev) => ({
                                  ...prev,
                                  [q.id]: { ...currentChoices, [st.letter]: true },
                                }))
                              }
                              className={`rounded-md border px-3.5 py-1.5 text-xs font-bold transition-colors ${
                                val === true
                                  ? 'border-[#2878B8] bg-[#2878B8] text-white'
                                  : 'border-slate-300 bg-white text-[#203247]'
                              }`}
                            >
                              Đúng
                            </button>
                            <button
                              type="button"
                              disabled={Boolean(gradeResult)}
                              onClick={() =>
                                setTfAnswers((prev) => ({
                                  ...prev,
                                  [q.id]: { ...currentChoices, [st.letter]: false },
                                }))
                              }
                              className={`rounded-md border px-3.5 py-1.5 text-xs font-bold transition-colors ${
                                val === false
                                  ? 'border-[#123B68] bg-[#123B68] text-white'
                                  : 'border-slate-300 bg-white text-[#203247]'
                              }`}
                            >
                              Sai
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </article>
              )
            })}
          </section>
        )}

        {/* Part 3 */}
        {part3Questions.length > 0 && (
          <section className="space-y-4">
            <h2 className="font-display text-lg font-bold text-[#123B68]">
              Phần III. Tự luận ({part3Questions.length} câu ·{' '}
              {activePublishedExam.part3Points} điểm)
            </h2>
            {part3Questions.map((q, idx) => {
              const graded = findGraded(q.id)
              return (
                <article
                  key={q.id}
                  className="rounded-xl border border-slate-200 bg-white p-6 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-[#55A747] tabular-nums">
                      Câu Tự luận {idx + 1} ({q.points}đ){' '}
                      {q.lessonTitle ? `· ${q.lessonTitle}` : ''}
                    </span>
                    {graded && (
                      <span className="font-bold text-[#123B68] tabular-nums">
                        {graded.needsTeacherReview
                          ? 'Đang chờ Super Admin chấm'
                          : `${graded.earnedPoints ?? graded.aiSuggestedScore ?? 0}/${graded.maxPoints}đ (AI)`}
                      </span>
                    )}
                  </div>
                  <p className="text-base font-semibold text-[#123B68] leading-relaxed">
                    {q.questionText}
                  </p>
                  <textarea
                    rows={5}
                    disabled={Boolean(gradeResult)}
                    value={essayAnswers[q.id] ?? ''}
                    onChange={(e) =>
                      setEssayAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                    }
                    placeholder="Nhập câu trả lời tự luận, đoạn mã SQL/HTML/Python hoặc lập luận của bạn..."
                    className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm text-[#203247] disabled:bg-[#F3F6FA]"
                  />
                  {graded?.aiFeedback && (
                    <div className="rounded-lg border border-[#2878B8]/30 bg-[#EAF3FA] px-4 py-2.5 text-xs text-[#123B68]">
                      <strong>Phản hồi chấm bài:</strong> {graded.aiFeedback}
                    </div>
                  )}
                </article>
              )
            })}
          </section>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Intro Banner */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-3 max-w-2xl">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-[#2878B8]">
              <GraduationCap className="h-4 w-4" />
              <span>Khu vực Học sinh · Không cần tài khoản hoặc mật khẩu</span>
            </div>
            <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-[#123B68] text-balance">
              Tham gia kỳ thi và luyện tập Tin học 12
            </h1>
            <p className="text-sm sm:text-base leading-relaxed text-[#203247]">
              Học sinh vào làm bài ngay chỉ với Họ tên và Lớp (không yêu cầu đăng nhập, email hay số điện thoại). Kết quả từng lượt thi được chấm ở máy chủ và lưu vào PostgreSQL.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <div className="inline-flex items-center gap-2 rounded-lg border border-[#55A747]/35 bg-[#EEF7EC] px-3.5 py-2.5 text-xs font-semibold text-[#2D6A23]">
              <ShieldCheck className="h-4 w-4 text-[#55A747]" />
              <span>Chế độ mở · Không cần đăng nhập</span>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('guide')}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 min-h-[44px] text-xs font-semibold text-[#123B68] hover:border-[#2878B8] hover:text-[#2878B8] transition-colors whitespace-nowrap shrink-0"
            >
              <span>Hướng dẫn làm bài →</span>
            </button>
          </div>
        </div>
      </section>

      {/* Published Exams Section */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-bold text-[#123B68]">
              Đề thi chính thức đang mở ({publishedExams.length})
            </h2>
            <p className="text-xs text-[#65758B] mt-0.5">
              Nhập mã phòng thi được giáo viên cung cấp hoặc chọn trực tiếp từ danh sách đề thi thật đang mở bên dưới.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#65758B]" />
              <input
                type="text"
                value={accessCodeInput}
                onChange={(e) => setAccessCodeInput(e.target.value.toUpperCase())}
                placeholder="Mã phòng (VD: TL12-AB12)"
                className="rounded-lg border border-slate-300 bg-[#F3F6FA] py-2 pl-8 pr-3 font-mono text-xs text-[#123B68]"
              />
            </div>
            <button
              type="button"
              onClick={handleOpenByAccessCode}
              className="rounded-lg bg-[#123B68] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#2878B8] whitespace-nowrap"
            >
              Vào phòng thi
            </button>
            <button
              type="button"
              disabled={loadingPublished}
              onClick={() => void loadPublishedExams()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-[#123B68] hover:border-[#2878B8] hover:text-[#2878B8] disabled:opacity-60"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loadingPublished ? 'animate-spin' : ''}`}
              />
              <span>Làm mới</span>
            </button>
          </div>
        </div>

        {publishedError && (
          <div className="rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]">
            {publishedError}
          </div>
        )}

        {loadingPublished ? (
          <div className="flex items-center gap-2 text-xs text-[#65758B] py-4">
            <Loader2 className="h-4 w-4 animate-spin text-[#2878B8]" />
            <span>Đang tải danh sách đề thi đang mở...</span>
          </div>
        ) : publishedExams.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-[#F3F6FA] p-8 text-center space-y-2">
            <div className="text-sm font-semibold text-[#123B68]">
              Hiện chưa có đề thi chính thức nào đang mở
            </div>
            <p className="text-xs text-[#65758B] max-w-md mx-auto">
              Danh sách này chỉ hiển thị các đề thi thật đã được giáo viên xuất bản từ ngân hàng câu hỏi TIN LAB. Vui lòng quay lại sau khi giáo viên mở phòng thi.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {publishedExams.map((exam) => (
              <div
                key={exam.id}
                className="rounded-xl border border-slate-200 bg-[#F3F6FA]/50 p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-semibold text-[#2878B8]">
                      {exam.schoolFormatLabel || exam.templateName}
                    </span>
                    <span className="font-mono font-bold text-[#123B68] bg-white px-2 py-0.5 rounded border border-slate-200">
                      {exam.accessCode}
                    </span>
                  </div>
                  <h3 className="font-display text-base font-bold text-[#123B68]">
                    {exam.title}
                  </h3>
                  <div className="text-xs text-[#65758B] tabular-nums">
                    {exam.durationMinutes} phút · {exam.totalPoints} điểm · P1: {exam.part1Count} TN · P2:{' '}
                    {exam.part2Count} Đ/S · P3: {exam.part3Count} Tự luận
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => openExamEntryGate(exam)}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#2878B8] px-4 py-2 text-xs font-semibold text-white hover:bg-[#123B68] transition-colors"
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>Làm bài thi này</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Current Browser Session Completed Attempts (No PII persisted publicly) */}
      {sessionAttempts.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-200 bg-[#F3F6FA] px-6 py-3.5 flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-[#123B68]">
              Lượt thi vừa hoàn thành trong phiên này ({sessionAttempts.length})
            </span>
            <span className="text-[11px] text-[#65758B]">
              Chỉ hiển thị tạm thời trong phiên làm việc hiện tại
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-[#F8FAFC] text-[#65758B]">
                <tr>
                  <th className="px-6 py-2.5">Mã lượt thi</th>
                  <th className="px-4 py-2.5">Học sinh &amp; Lớp</th>
                  <th className="px-4 py-2.5">Đề thi</th>
                  <th className="px-4 py-2.5 text-right">Điểm số</th>
                  <th className="px-6 py-2.5">Thời điểm nộp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 tabular-nums">
                {sessionAttempts.map((item) => (
                  <tr key={item.attemptId}>
                    <td className="px-6 py-2.5 font-mono text-[#2878B8]">
                      #{item.attemptId.slice(0, 8)}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-[#123B68]">
                      {item.studentName} ({item.className})
                    </td>
                    <td className="px-4 py-2.5 text-[#203247]">{item.examTitle}</td>
                    <td className="px-4 py-2.5 text-right font-bold text-[#123B68]">
                      {item.score !== null ? `${item.score}/${item.maxScore}` : 'Chờ duyệt'}
                    </td>
                    <td className="px-6 py-2.5 text-[#65758B]">
                      {formatViTime(item.submittedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
