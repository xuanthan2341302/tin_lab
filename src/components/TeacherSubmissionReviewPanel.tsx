import { useMemo, useState } from 'react'
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Clock,
  Eye,
  X,
} from 'lucide-react'
import type {
  ExamSubmissionRecord,
  GradedSubmissionAnswer,
  PublishedExam,
  PublishedExamKey,
  SubmissionGradingStatus,
} from '../types'
import { getAuthHeaders } from '../lib/authClient'
import { finalizeTeacherSubmissionReview } from '../lib/examDb'

interface TeacherSubmissionReviewPanelProps {
  submissions: ExamSubmissionRecord[]
  publishedExams: PublishedExam[]
  examKeys: PublishedExamKey[]
  onRefresh: () => Promise<void>
}

const STATUS_BADGE: Record<SubmissionGradingStatus, { label: string; style: string }> = {
  needs_teacher_review: {
    label: 'Cần giáo viên chấm / duyệt',
    style: 'border-[#F28C28]/45 bg-[#FEF6EC] text-[#9A520B]',
  },
  auto_graded: {
    label: 'Đã chấm tự động (AI & Máy chủ)',
    style: 'border-[#2878B8]/35 bg-[#EAF3FA] text-[#123B68]',
  },
  teacher_reviewed: {
    label: 'Giáo viên đã chốt điểm',
    style: 'border-[#55A747]/45 bg-[#EEF7EC] text-[#2D6A23]',
  },
}

export function TeacherSubmissionReviewPanel({
  submissions,
  publishedExams,
  examKeys,
  onRefresh,
}: TeacherSubmissionReviewPanelProps) {
  const [statusFilter, setStatusFilter] = useState<SubmissionGradingStatus | 'all'>('all')
  const [selectedSubmission, setSelectedSubmission] =
    useState<ExamSubmissionRecord | null>(null)
  const [essayScores, setEssayScores] = useState<Record<string, string>>({})
  const [essayComments, setEssayComments] = useState<Record<string, string>>({})
  const [generalFeedback, setGeneralFeedback] = useState('')
  const [regradingId, setRegradingId] = useState<string | null>(null)
  const [savingReview, setSavingReview] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)

  const needsReviewCount = useMemo(
    () => submissions.filter((s) => s.gradingStatus === 'needs_teacher_review').length,
    [submissions]
  )

  const filteredSubmissions = useMemo(() => {
    return submissions.filter((s) => {
      if (statusFilter !== 'all' && s.gradingStatus !== statusFilter) return false
      return true
    })
  }, [submissions, statusFilter])

  const openSubmission = (sub: ExamSubmissionRecord) => {
    setSelectedSubmission(sub)
    setGeneralFeedback(sub.teacherFeedback)
    setReviewError(null)
    const nextScores: Record<string, string> = {}
    const nextComments: Record<string, string> = {}
    for (const ans of sub.answers) {
      if (ans.questionType === 'essay') {
        const initScore = ans.teacherScore ?? ans.aiSuggestedScore ?? 0
        nextScores[ans.questionId] = String(initScore)
        nextComments[ans.questionId] = ans.teacherComment || ''
      }
    }
    setEssayScores(nextScores)
    setEssayComments(nextComments)
  }

  const getExamMeta = (examId: string) =>
    publishedExams.find((e) => e.id === examId) ?? null

  const getKeyMeta = (examId: string) =>
    examKeys.find((k) => k.examId === examId) ?? null

  const handleRequestAiSuggestion = async (
    ans: GradedSubmissionAnswer,
    questionText: string,
    rubric: string,
    sampleAnswer: string
  ) => {
    setRegradingId(ans.questionId)
    setReviewError(null)
    try {
      const headers = await getAuthHeaders({ 'Content-Type': 'application/json' })
      const res = await fetch('/api/exams/regrade-essay', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          questionText,
          rubric,
          sampleAnswer,
          maxPoints: ans.maxPoints,
          studentAnswer: ans.essayText || '',
        }),
      })
      const data = (await res.json().catch(() => null)) as
        | {
            ok: true
            evaluation: {
              suggestedScore: number | null
              feedback: string
            }
          }
        | { ok: false; error?: string }
        | null

      if (!res.ok || !data || !data.ok) {
        setReviewError(
          (data && 'error' in data && data.error) || 'Không thể gọi gợi ý AI.'
        )
        return
      }

      if (data.evaluation.suggestedScore !== null) {
        setEssayScores((prev) => ({
          ...prev,
          [ans.questionId]: String(data.evaluation.suggestedScore),
        }))
      }
      setEssayComments((prev) => ({
        ...prev,
        [ans.questionId]: data.evaluation.feedback,
      }))
    } catch {
      setReviewError('Lỗi kết nối khi yêu cầu gợi ý chấm tự luận từ máy chủ.')
    } finally {
      setRegradingId(null)
    }
  }

  const handleFinalizeReview = async () => {
    if (!selectedSubmission) return
    setReviewError(null)
    setSavingReview(true)

    try {
      let part3Sum = 0
      const updatedAnswers: GradedSubmissionAnswer[] = selectedSubmission.answers.map(
        (ans) => {
          if (ans.questionType !== 'essay') return ans
          const rawScore = Number(essayScores[ans.questionId] ?? '0')
          if (!Number.isFinite(rawScore) || rawScore < 0 || rawScore > ans.maxPoints) {
            throw new Error(
              `Điểm tự luận phải nằm trong khoảng 0 đến ${ans.maxPoints} điểm.`
            )
          }
          const rounded = Math.round(rawScore * 1000) / 1000
          part3Sum = Math.round((part3Sum + rounded) * 1000) / 1000
          return {
            ...ans,
            teacherScore: rounded,
            earnedPoints: rounded,
            needsTeacherReview: false,
            teacherComment: (essayComments[ans.questionId] ?? '').trim(),
          }
        }
      )

      await finalizeTeacherSubmissionReview({
        submission: selectedSubmission,
        updatedAnswers,
        part3FinalScore: part3Sum,
        teacherFeedback: generalFeedback,
      })

      setSelectedSubmission(null)
      await onRefresh()
    } catch (err) {
      setReviewError(
        err instanceof Error ? err.message : 'Không thể lưu điểm duyệt bài.'
      )
    } finally {
      setSavingReview(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-bold text-[#123B68]">
              Bài nộp của Học sinh &amp; Hàng chờ chấm duyệt Tự luận ({submissions.length})
            </h3>
            <p className="text-xs text-[#65758B] mt-0.5">
              Phần I và II đã được chấm tự động trên máy chủ; các bài tự luận cần kiểm tra hoặc chưa cấu hình AI đều được giữ trong hàng chờ để giáo viên chốt điểm.
            </p>
          </div>
          {needsReviewCount > 0 && (
            <div className="inline-flex items-center gap-1.5 rounded-lg border border-[#F28C28]/45 bg-[#FEF6EC] px-3 py-1.5 text-xs font-bold text-[#9A520B]">
              <Clock className="h-3.5 w-3.5 text-[#F28C28]" />
              <span>{needsReviewCount} bài đang chờ giáo viên duyệt</span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              { id: 'all', label: `Tất cả (${submissions.length})` },
              {
                id: 'needs_teacher_review',
                label: `Cần duyệt tự luận (${needsReviewCount})`,
              },
              { id: 'auto_graded', label: 'AI / Máy chủ đã chấm' },
              { id: 'teacher_reviewed', label: 'Đã chốt điểm' },
            ] as { id: SubmissionGradingStatus | 'all'; label: string }[]
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStatusFilter(tab.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                statusFilter === tab.id
                  ? 'bg-[#123B68] text-white'
                  : 'border border-slate-200 bg-white text-[#203247] hover:bg-[#F3F6FA]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {filteredSubmissions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-[#F3F6FA] p-8 text-center text-xs text-[#65758B]">
            Chưa có bài nộp nào trong danh mục này.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-[#F3F6FA] font-semibold text-[#65758B]">
                <tr>
                  <th className="px-4 py-3">Học sinh &amp; Lớp</th>
                  <th className="px-4 py-3">Kỳ thi</th>
                  <th className="px-4 py-3 text-right">Phần I (TN)</th>
                  <th className="px-4 py-3 text-right">Phần II (Đ/S)</th>
                  <th className="px-4 py-3 text-right">Phần III (TL)</th>
                  <th className="px-4 py-3 text-right">Tổng điểm</th>
                  <th className="px-4 py-3">Trạng thái</th>
                  <th className="px-4 py-3 text-right">Chi tiết</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filteredSubmissions.map((sub) => {
                  const badge = STATUS_BADGE[sub.gradingStatus]
                  const p3Display =
                    sub.part3Max === 0
                      ? '—'
                      : sub.part3FinalScore !== null
                      ? `${sub.part3FinalScore}/${sub.part3Max}`
                      : sub.part3AiScore !== null
                      ? `~${sub.part3AiScore}/${sub.part3Max} (AI)`
                      : `Chờ chấm /${sub.part3Max}`

                  return (
                    <tr key={sub.id} className="hover:bg-[#F3F6FA]/60">
                      <td className="px-4 py-3">
                        <div className="font-bold text-[#123B68]">{sub.studentName}</div>
                        <div className="text-[11px] text-[#65758B]">
                          {sub.studentClass || 'Chưa ghi lớp'} · {sub.studentEmail}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-medium text-[#203247]">{sub.examTitle}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {sub.part1Score}/{sub.part1Max}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {sub.part2Score}/{sub.part2Max}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{p3Display}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-bold text-[#123B68]">
                        {sub.totalScore !== null
                          ? `${sub.totalScore}/${sub.totalMax}`
                          : 'Chờ duyệt'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold ${badge.style}`}
                        >
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => openSubmission(sub)}
                          className="inline-flex items-center gap-1 rounded border border-[#2878B8] bg-white px-2.5 py-1 font-semibold text-[#2878B8] hover:bg-[#2878B8] hover:text-white"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          <span>Chấm / Xem</span>
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Review Drawer / Modal */}
      {selectedSubmission && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
        >
          <div className="my-8 w-full max-w-3xl rounded-xl border border-slate-200 bg-white shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 bg-[#F3F6FA] px-6 py-4">
              <div>
                <h4 className="font-display text-base font-bold text-[#123B68]">
                  Chấm duyệt bài: {selectedSubmission.studentName} ({selectedSubmission.studentClass || '—'})
                </h4>
                <p className="text-xs text-[#65758B]">
                  {selectedSubmission.examTitle} · Phần I: {selectedSubmission.part1Score}/{selectedSubmission.part1Max}đ · Phần II: {selectedSubmission.part2Score}/{selectedSubmission.part2Max}đ
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSubmission(null)}
                className="rounded-lg p-1.5 text-[#65758B] hover:bg-slate-200/70"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-5 max-h-[78vh] overflow-y-auto">
              {selectedSubmission.answers
                .filter((a) => a.questionType === 'essay')
                .map((ans, idx) => {
                  const examMeta = getExamMeta(selectedSubmission.examId)
                  const keyMeta = getKeyMeta(selectedSubmission.examId)
                  const qMeta = examMeta?.questions.find((q) => q.id === ans.questionId)
                  const kItem = keyMeta?.items.find((k) => k.id === ans.questionId)
                  const questionText = qMeta?.questionText || `Câu tự luận #${idx + 1}`
                  const rubric = kItem?.rubric || 'Không có rubric kèm theo.'
                  const sampleAnswer = kItem?.sampleAnswer || ''

                  return (
                    <div
                      key={ans.questionId}
                      className="rounded-xl border border-slate-200 bg-[#F3F6FA]/60 p-4 space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-bold text-xs text-[#123B68]">
                          Tự luận #{idx + 1} (Tối đa {ans.maxPoints} điểm)
                        </span>
                        <button
                          type="button"
                          disabled={regradingId === ans.questionId}
                          onClick={() =>
                            void handleRequestAiSuggestion(
                              ans,
                              questionText,
                              rubric,
                              sampleAnswer
                            )
                          }
                          className="inline-flex items-center gap-1 rounded border border-[#7954A1]/40 bg-[#F4EFF8] px-2.5 py-1 text-xs font-semibold text-[#5B3C7D] hover:bg-[#e8dff2] disabled:opacity-50"
                        >
                          <Bot className="h-3.5 w-3.5" />
                          <span>
                            {regradingId === ans.questionId
                              ? 'Đang phân tích...'
                              : 'AI gợi ý chấm theo Rubric'}
                          </span>
                        </button>
                      </div>

                      <div className="text-xs font-medium text-[#123B68]">{questionText}</div>

                      <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs space-y-1">
                        <div className="font-semibold text-[#65758B]">Bài làm của học sinh:</div>
                        <p className="text-[#203247] whitespace-pre-wrap">
                          {ans.essayText?.trim() || '(Học sinh bỏ trống)'}
                        </p>
                      </div>

                      <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs space-y-1">
                        <div className="font-semibold text-[#2D6A23]">Hướng dẫn chấm (Rubric):</div>
                        <p className="text-[#203247] whitespace-pre-line">{rubric}</p>
                      </div>

                      {ans.aiFeedback && (
                        <div className="rounded-lg border border-[#2878B8]/30 bg-[#EAF3FA] p-2.5 text-xs text-[#123B68]">
                          <strong>Nhận xét từ AI:</strong> {ans.aiFeedback}
                          {ans.aiSuggestedScore !== null && ans.aiSuggestedScore !== undefined && (
                            <span className="ml-1.5 font-bold">
                              (Đề xuất: {ans.aiSuggestedScore}/{ans.maxPoints}đ)
                            </span>
                          )}
                        </div>
                      )}

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                        <div className="sm:col-span-4">
                          <label className="block text-[11px] font-semibold text-[#203247] mb-1">
                            Điểm Giáo viên chốt (0 – {ans.maxPoints})
                          </label>
                          <input
                            type="number"
                            step="0.05"
                            min={0}
                            max={ans.maxPoints}
                            value={essayScores[ans.questionId] ?? '0'}
                            onChange={(e) =>
                              setEssayScores((prev) => ({
                                ...prev,
                                [ans.questionId]: e.target.value,
                              }))
                            }
                            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold tabular-nums text-[#123B68]"
                          />
                        </div>
                        <div className="sm:col-span-8">
                          <label className="block text-[11px] font-semibold text-[#203247] mb-1">
                            Nhận xét riêng câu này
                          </label>
                          <input
                            type="text"
                            value={essayComments[ans.questionId] ?? ''}
                            onChange={(e) =>
                              setEssayComments((prev) => ({
                                ...prev,
                                [ans.questionId]: e.target.value,
                              }))
                            }
                            placeholder="Ghi chú chấm điểm gửi học sinh..."
                            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-[#203247]"
                          />
                        </div>
                      </div>
                    </div>
                  )
                })}

              {selectedSubmission.part3Max === 0 && (
                <div className="rounded-lg border border-slate-200 bg-[#F3F6FA] p-4 text-xs text-[#203247]">
                  Đề thi này không có câu Tự luận. Tổng điểm tự động:{' '}
                  <strong>
                    {selectedSubmission.part1Score + selectedSubmission.part2Score}/
                    {selectedSubmission.totalMax} điểm
                  </strong>
                  .
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-[#203247] mb-1">
                  Nhận xét chung của Giáo viên (hiển thị cho học sinh)
                </label>
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={generalFeedback}
                  onChange={(e) => setGeneralFeedback(e.target.value)}
                  placeholder="Nhận xét tổng quát bài làm..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-[#203247]"
                />
              </div>

              {reviewError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-3.5 py-2.5 text-xs text-[#A92F2A]"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
                  <span>{reviewError}</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-slate-200 bg-[#F3F6FA] px-6 py-4">
              <button
                type="button"
                onClick={() => setSelectedSubmission(null)}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-[#203247]"
              >
                Đóng
              </button>
              <button
                type="button"
                disabled={savingReview}
                onClick={() => void handleFinalizeReview()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#55A747] px-5 py-2 text-xs font-semibold text-white hover:bg-[#468c3a] disabled:opacity-50"
              >
                <CheckCircle2 className="h-4 w-4" />
                <span>{savingReview ? 'Đang chốt điểm...' : 'Xác nhận & Chốt điểm chính thức'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
