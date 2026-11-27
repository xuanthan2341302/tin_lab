import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ClipboardList,
  Download,
  Eye,
  Filter,
  Loader2,
  RefreshCw,
  Save,
  Search,
  TrendingUp,
  X,
} from 'lucide-react'
import {
  downloadAdminStudentResultsExcel,
  fetchAdminStudentResults,
  reviewStudentAttemptAsAdmin,
  type StudentResultsQueryFilters,
} from '../lib/studentResultsClient'
import type {
  AdminStudentResultsResponse,
  AttemptCompletionStatus,
  StudentAttemptRecord,
} from '../types'

type SubView = 'attempts' | 'stats' | 'progress'

const STATUS_META: Record<
  AttemptCompletionStatus,
  { label: string; badgeClass: string }
> = {
  in_progress: {
    label: 'Đang làm bài',
    badgeClass: 'border-slate-300 bg-slate-100 text-[#475569]',
  },
  auto_graded: {
    label: 'Đã chấm tự động',
    badgeClass: 'border-[#2878B8]/35 bg-[#EAF3FA] text-[#123B68]',
  },
  needs_review: {
    label: 'Chờ duyệt Tự luận',
    badgeClass: 'border-[#F28C28]/40 bg-[#FEF6EC] text-[#9A520B]',
  },
  reviewed: {
    label: 'Đã duyệt điểm',
    badgeClass: 'border-[#55A747]/35 bg-[#EEF7EC] text-[#2D6A23]',
  },
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('vi-VN')
}

function formatDurationVi(
  startedAt: string,
  submittedAt: string | null,
  durationSeconds?: number | null
): string {
  let secs = durationSeconds ?? null
  if (secs === null && submittedAt) {
    const startMs = new Date(startedAt).getTime()
    const endMs = new Date(submittedAt).getTime()
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) {
      secs = Math.round((endMs - startMs) / 1000)
    }
  }
  if (secs === null || secs < 0) return '—'
  const hours = Math.floor(secs / 3600)
  const minutes = Math.floor((secs % 3600) / 60)
  const remSeconds = secs % 60
  if (hours > 0) {
    return `${hours}g ${String(minutes).padStart(2, '0')}p`
  }
  if (minutes > 0) {
    return `${minutes} phút ${String(remSeconds).padStart(2, '0')} giây`
  }
  return `${remSeconds} giây`
}

export function AdminStudentResultsPanel() {
  const [data, setData] = useState<AdminStudentResultsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [subView, setSubView] = useState<SubView>('attempts')

  // Filters
  const [searchText, setSearchText] = useState('')
  const [classFilter, setClassFilter] = useState('ALL')
  const [examFilter, setExamFilter] = useState('ALL')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // Excel export state
  const [exportingMode, setExportingMode] = useState<'summary' | 'detailed' | null>(null)

  // Selected attempt modal / review state
  const [selectedAttempt, setSelectedAttempt] = useState<StudentAttemptRecord | null>(null)
  const [essayScoresDraft, setEssayScoresDraft] = useState<
    Record<string, { score: string; comment: string }>
  >({})
  const [adminFeedbackDraft, setAdminFeedbackDraft] = useState('')
  const [savingReview, setSavingReview] = useState(false)

  const currentFilters = useMemo<StudentResultsQueryFilters>(
    () => ({
      q: searchText,
      className: classFilter,
      examId: examFilter,
      status: statusFilter,
      dateFrom,
      dateTo,
    }),
    [searchText, classFilter, examFilter, statusFilter, dateFrom, dateTo]
  )

  const loadResults = useCallback(async (filters: StudentResultsQueryFilters) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchAdminStudentResults(filters)
      setData(res)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Không thể tải danh sách kết quả học sinh.'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadResults(currentFilters)
  }, [loadResults, currentFilters])

  const openAttemptDetail = (attempt: StudentAttemptRecord) => {
    setSelectedAttempt(attempt)
    setAdminFeedbackDraft(attempt.adminFeedback || '')
    const draft: Record<string, { score: string; comment: string }> = {}
    for (const ans of attempt.detailedAnswers) {
      if (ans.questionType === 'essay') {
        const initScore =
          ans.adminScore ?? ans.earnedPoints ?? ans.aiSuggestedScore ?? 0
        draft[ans.questionId] = {
          score: String(initScore),
          comment: ans.adminComment || '',
        }
      }
    }
    setEssayScoresDraft(draft)
  }

  const handleSaveReview = async () => {
    if (!selectedAttempt || savingReview) return
    setSavingReview(true)
    setError(null)
    setNotice(null)
    try {
      const payloadScores: Record<string, { score: number; comment: string }> = {}
      for (const [qId, val] of Object.entries(essayScoresDraft)) {
        const parsed = Number(val.score)
        payloadScores[qId] = {
          score: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
          comment: val.comment,
        }
      }

      const updated = await reviewStudentAttemptAsAdmin({
        attemptId: selectedAttempt.attemptId,
        essayScores: payloadScores,
        adminFeedback: adminFeedbackDraft,
      })

      setSelectedAttempt(updated)
      setNotice(
        `Đã lưu điểm duyệt cho học sinh ${updated.studentName} (${updated.className}) — Tổng điểm: ${updated.score ?? '—'}/${updated.maxScore}.`
      )
      await loadResults(currentFilters)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Không thể lưu điểm duyệt vào PostgreSQL.'
      )
    } finally {
      setSavingReview(false)
    }
  }

  const handleExportExcel = async (includeDetails: boolean) => {
    if (exportingMode) return
    setExportingMode(includeDetails ? 'detailed' : 'summary')
    setError(null)
    setNotice(null)
    try {
      const filename = await downloadAdminStudentResultsExcel({
        filters: currentFilters,
        includeDetails,
      })
      setNotice(`Đã xuất tệp kết quả thành công: ${filename}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể xuất tệp kết quả học sinh.')
    } finally {
      setExportingMode(null)
    }
  }

  const resetFilters = () => {
    setSearchText('')
    setClassFilter('ALL')
    setExamFilter('ALL')
    setStatusFilter('ALL')
    setDateFrom('')
    setDateTo('')
  }

  const summaryCounts = useMemo(() => {
    const attempts = data?.attempts ?? []
    const graded = attempts.filter((a) => a.score !== null)
    const avg =
      graded.length > 0
        ? Math.round(
            (graded.reduce((acc, a) => acc + (a.score ?? 0), 0) / graded.length) * 100
          ) / 100
        : null
    const pending = attempts.filter((a) => a.completionStatus === 'needs_review').length
    return {
      total: attempts.length,
      graded: graded.length,
      average: avg,
      pending,
    }
  }, [data])

  return (
    <div className="space-y-6">
      {/* Header & Excel Export Toolbar */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-[#2878B8]">
              <ClipboardList className="h-4 w-4" />
              <span>Bảng điều khiển Super Admin · Lưu trữ PostgreSQL</span>
            </div>
            <h2 className="font-display text-lg font-bold text-[#123B68]">
              Kết quả học sinh
            </h2>
            <p className="text-xs leading-relaxed text-[#65758B] max-w-2xl">
              Theo dõi toàn bộ lượt làm bài luyện tập và bài kiểm tra chính thức theo họ tên, lớp đã chuẩn hóa, mã phiên làm bài (Attempt ID), lịch sử nhiều lần làm và thống kê điểm trung bình.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadResults(currentFilters)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-[#123B68] hover:bg-[#F3F6FA] disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Làm mới</span>
            </button>

            <button
              type="button"
              disabled={Boolean(exportingMode) || loading || summaryCounts.total === 0}
              onClick={() => void handleExportExcel(false)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#2878B8] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#123B68] disabled:opacity-50 transition-colors"
            >
              {exportingMode === 'summary' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span>Xuất CSV (Excel)</span>
            </button>

            <button
              type="button"
              disabled={Boolean(exportingMode) || loading || summaryCounts.total === 0}
              onClick={() => void handleExportExcel(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#2878B8] bg-[#EAF3FA] px-3.5 py-2 text-xs font-semibold text-[#123B68] hover:bg-[#2878B8] hover:text-white disabled:opacity-50 transition-colors"
            >
              {exportingMode === 'detailed' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span>Xuất CSV kèm chi tiết câu trả lời</span>
            </button>
          </div>
        </div>

        {/* Summary KPI Strip */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3.5">
            <div className="text-[11px] font-medium text-[#65758B]">Tổng lượt làm bài</div>
            <div className="font-display text-2xl font-extrabold text-[#123B68] tabular-nums mt-0.5">
              {summaryCounts.total}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3.5">
            <div className="text-[11px] font-medium text-[#65758B]">Đã nộp &amp; có điểm</div>
            <div className="font-display text-2xl font-extrabold text-[#2878B8] tabular-nums mt-0.5">
              {summaryCounts.graded}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3.5">
            <div className="text-[11px] font-medium text-[#65758B]">Điểm trung bình (lọc)</div>
            <div className="font-display text-2xl font-extrabold text-[#2D6A23] tabular-nums mt-0.5">
              {summaryCounts.average !== null ? summaryCounts.average : '—'}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3.5">
            <div className="text-[11px] font-medium text-[#65758B]">Chờ duyệt Tự luận</div>
            <div className="font-display text-2xl font-extrabold text-[#9A520B] tabular-nums mt-0.5">
              {summaryCounts.pending}
            </div>
          </div>
        </div>

        {/* Search & Multi-Filters */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 pt-1">
          <div className="lg:col-span-2 relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#65758B]" />
            <input
              type="search"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Tìm tên học sinh, lớp hoặc mã Attempt ID..."
              className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-xs text-[#203247] focus:border-[#2878B8] focus:outline-none"
            />
          </div>

          <select
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            aria-label="Lọc theo lớp"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-[#203247] focus:border-[#2878B8] focus:outline-none"
          >
            <option value="ALL">Tất cả các lớp</option>
            {(data?.availableClasses ?? []).map((cls) => (
              <option key={cls} value={cls}>
                Lớp {cls}
              </option>
            ))}
          </select>

          <select
            value={examFilter}
            onChange={(e) => setExamFilter(e.target.value)}
            aria-label="Lọc theo đề thi"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-[#203247] focus:border-[#2878B8] focus:outline-none"
          >
            <option value="ALL">Tất cả bài thi / đề thi</option>
            {(data?.availableExams ?? []).map((ex) => (
              <option key={ex.examId} value={ex.examId}>
                {ex.examTitle}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Lọc theo trạng thái"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-[#203247] focus:border-[#2878B8] focus:outline-none"
          >
            <option value="ALL">Mọi trạng thái</option>
            <option value="auto_graded">Đã chấm tự động</option>
            <option value="needs_review">Chờ duyệt Tự luận</option>
            <option value="reviewed">Đã duyệt điểm</option>
            <option value="in_progress">Đang làm bài</option>
          </select>

          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              title="Từ ngày"
              aria-label="Từ ngày"
              className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-[#203247]"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              title="Đến ngày"
              aria-label="Đến ngày"
              className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-[#203247]"
            />
          </div>
        </div>

        {(searchText ||
          classFilter !== 'ALL' ||
          examFilter !== 'ALL' ||
          statusFilter !== 'ALL' ||
          dateFrom ||
          dateTo) && (
          <div className="flex items-center justify-between text-xs text-[#65758B]">
            <span className="inline-flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-[#2878B8]" />
              <span>Đang áp dụng bộ lọc · Hiển thị {summaryCounts.total} kết quả</span>
            </span>
            <button
              type="button"
              onClick={resetFilters}
              className="font-semibold text-[#2878B8] hover:text-[#123B68]"
            >
              Xóa bộ lọc
            </button>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
            <span>{error}</span>
          </div>
        )}

        {notice && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-[#55A747]/40 bg-[#EEF7EC] px-4 py-3 text-xs text-[#2D6A23]"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-[#55A747]" />
            <span>{notice}</span>
          </div>
        )}

        {/* Sub-view Switcher */}
        <div className="border-t border-slate-200 pt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setSubView('attempts')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
              subView === 'attempts'
                ? 'bg-[#123B68] text-white'
                : 'border border-slate-200 bg-[#F3F6FA] text-[#203247] hover:bg-slate-200/70'
            }`}
          >
            <ClipboardList className="h-3.5 w-3.5" />
            <span>Bảng lượt làm bài ({data?.attempts.length ?? 0})</span>
          </button>

          <button
            type="button"
            onClick={() => setSubView('stats')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
              subView === 'stats'
                ? 'bg-[#123B68] text-white'
                : 'border border-slate-200 bg-[#F3F6FA] text-[#203247] hover:bg-slate-200/70'
            }`}
          >
            <BarChart3 className="h-3.5 w-3.5" />
            <span>Thống kê theo Lớp &amp; Đề thi</span>
          </button>

          <button
            type="button"
            onClick={() => setSubView('progress')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
              subView === 'progress'
                ? 'bg-[#123B68] text-white'
                : 'border border-slate-200 bg-[#F3F6FA] text-[#203247] hover:bg-slate-200/70'
            }`}
          >
            <TrendingUp className="h-3.5 w-3.5" />
            <span>Tiến độ nhiều lượt ({data?.studentProgress.length ?? 0})</span>
          </button>
        </div>
      </section>

      {/* Main Content View */}
      {loading && !data ? (
        <section className="rounded-xl border border-slate-200 bg-white p-8 flex items-center gap-3 text-sm text-[#65758B]">
          <Loader2 className="h-5 w-5 animate-spin text-[#2878B8]" />
          <span>Đang tải kết quả học sinh từ PostgreSQL...</span>
        </section>
      ) : subView === 'attempts' ? (
        <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          {!data || data.attempts.length === 0 ? (
            <div className="p-8 text-center text-xs text-[#65758B]">
              Chưa có lượt làm bài nào khớp với điều kiện tìm kiếm.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="border-b border-slate-200 bg-[#F8FAFC] text-xs font-semibold text-[#65758B]">
                  <tr>
                    <th className="px-5 py-3">Học sinh &amp; Lớp</th>
                    <th className="px-4 py-3">Bài thi / Đề thi</th>
                    <th className="px-4 py-3">Bắt đầu / Nộp bài</th>
                    <th className="px-4 py-3 text-right">Điểm số</th>
                    <th className="px-4 py-3">Trạng thái</th>
                    <th className="px-5 py-3 text-right">Chi tiết</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {data.attempts.map((att) => {
                    const meta = STATUS_META[att.completionStatus]
                    return (
                      <tr key={att.attemptId} className="hover:bg-[#F3F6FA]/70">
                        <td className="px-5 py-3.5">
                          <div className="font-semibold text-[#123B68]">
                            {att.studentName}
                          </div>
                          <div className="text-[11px] text-[#65758B]">
                            Lớp:{' '}
                            <span className="font-mono font-semibold text-[#203247]">
                              {att.className}
                            </span>
                            {att.rawClassName !== att.className && (
                              <span className="ml-1 text-[#65758B]">
                                (nhập: {att.rawClassName})
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="font-medium text-[#203247] line-clamp-2">
                            {att.examTitle}
                          </div>
                          <div className="text-[11px] text-[#65758B] font-mono mt-0.5">
                            {att.examKind === 'published' ? 'Chính thức' : 'Luyện tập'} ·{' '}
                            <span title={att.attemptId}>
                              #{att.attemptId.slice(0, 8)}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-xs text-[#65758B] tabular-nums whitespace-nowrap">
                          <div>Bắt đầu: {formatDateTime(att.startedAt)}</div>
                          <div>Nộp bài: {formatDateTime(att.submittedAt)}</div>
                          <div className="text-[11px] text-[#2878B8] font-medium">
                            Thời lượng: {formatDurationVi(att.startedAt, att.submittedAt, att.durationSeconds)}
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-right tabular-nums">
                          <div className="font-display text-base font-extrabold text-[#123B68]">
                            {att.score !== null ? `${att.score} / ${att.maxScore}` : '—'}
                          </div>
                          {att.examKind === 'published' && (
                            <div className="text-[11px] text-[#65758B]">
                              P1: {att.part1Score} · P2: {att.part2Score}
                              {att.part3Max > 0
                                ? ` · P3: ${att.part3Score ?? '?'}`
                                : ''}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          <span
                            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${meta.badgeClass}`}
                          >
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <button
                            type="button"
                            onClick={() => openAttemptDetail(att)}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-[#123B68] hover:border-[#2878B8] hover:text-[#2878B8]"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            <span>Xem</span>
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
      ) : subView === 'stats' ? (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Class Performance Table */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 bg-[#F3F6FA] px-5 py-3.5 text-xs font-bold text-[#123B68]">
              Thống kê điểm trung bình theo Lớp ({data?.classStats.length ?? 0} lớp)
            </div>
            {!data || data.classStats.length === 0 ? (
              <div className="p-6 text-xs text-[#65758B]">Chưa có dữ liệu theo lớp.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-[#F8FAFC] text-[#65758B]">
                    <tr>
                      <th className="px-5 py-2.5">Lớp</th>
                      <th className="px-3 py-2.5 text-right">Học sinh</th>
                      <th className="px-3 py-2.5 text-right">Lượt thi</th>
                      <th className="px-3 py-2.5 text-right">Điểm TB</th>
                      <th className="px-5 py-2.5 text-right">Thấp / Cao</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 tabular-nums">
                    {data.classStats.map((c) => (
                      <tr key={c.className} className="hover:bg-[#F3F6FA]/60">
                        <td className="px-5 py-3 font-mono font-bold text-[#123B68]">
                          {c.className}
                        </td>
                        <td className="px-3 py-3 text-right text-[#203247]">
                          {c.studentIdentityCount}
                        </td>
                        <td className="px-3 py-3 text-right text-[#203247]">
                          {c.gradedCount}/{c.attemptCount}
                        </td>
                        <td className="px-3 py-3 text-right font-bold text-[#2878B8]">
                          {c.averageScore !== null ? c.averageScore : '—'}
                        </td>
                        <td className="px-5 py-3 text-right text-[#65758B]">
                          {c.minScore !== null && c.maxScore !== null
                            ? `${c.minScore} – ${c.maxScore}`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Exam Performance Table */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 bg-[#F3F6FA] px-5 py-3.5 text-xs font-bold text-[#123B68]">
              Thống kê điểm trung bình theo Bài thi ({data?.examStats.length ?? 0} đề)
            </div>
            {!data || data.examStats.length === 0 ? (
              <div className="p-6 text-xs text-[#65758B]">Chưa có dữ liệu theo bài thi.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-[#F8FAFC] text-[#65758B]">
                    <tr>
                      <th className="px-5 py-2.5">Tên đề thi</th>
                      <th className="px-3 py-2.5">Loại</th>
                      <th className="px-3 py-2.5 text-right">Đã nộp</th>
                      <th className="px-5 py-2.5 text-right">Điểm TB</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 tabular-nums">
                    {data.examStats.map((ex) => (
                      <tr key={ex.examId} className="hover:bg-[#F3F6FA]/60">
                        <td className="px-5 py-3 font-medium text-[#123B68]">
                          {ex.examTitle}
                        </td>
                        <td className="px-3 py-3 text-[#65758B]">
                          {ex.examKind === 'published' ? 'Chính thức' : 'Luyện tập'}
                        </td>
                        <td className="px-3 py-3 text-right text-[#203247]">
                          {ex.gradedCount}/{ex.attemptCount}
                        </td>
                        <td className="px-5 py-3 text-right font-bold text-[#2878B8]">
                          {ex.averageScore !== null
                            ? `${ex.averageScore}/${ex.maxScore}`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      ) : (
        /* Learning Progress Across Multiple Attempts */
        <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-200 bg-[#F3F6FA] px-6 py-3.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold text-[#123B68]">
              Tiến độ học tập theo từng học sinh (Họ tên + Lớp chuẩn hóa)
            </span>
            <span className="text-[11px] text-[#65758B]">
              Chỉ nhóm các lượt trùng khớp cả Họ tên và Lớp; không gộp mơ hồ học sinh trùng tên khác lớp.
            </span>
          </div>

          {!data || data.studentProgress.length === 0 ? (
            <div className="p-8 text-center text-xs text-[#65758B]">
              Chưa có dữ liệu tiến độ học tập.
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {data.studentProgress.map((sp) => (
                <div key={sp.identityKey} className="p-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <span className="font-display text-sm font-bold text-[#123B68]">
                        {sp.studentName}
                      </span>
                      <span className="ml-2 font-mono text-xs font-semibold text-[#2878B8]">
                        Lớp {sp.className}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-4 text-xs tabular-nums">
                      <span className="text-[#65758B]">
                        Số lượt: <strong className="text-[#123B68]">{sp.attemptCount}</strong>
                      </span>
                      <span className="text-[#65758B]">
                        TB:{' '}
                        <strong className="text-[#2878B8]">
                          {sp.averageScore !== null ? sp.averageScore : '—'}
                        </strong>
                      </span>
                      <span className="text-[#65758B]">
                        Cao nhất:{' '}
                        <strong className="text-[#2D6A23]">
                          {sp.bestScore !== null ? sp.bestScore : '—'}
                        </strong>
                      </span>
                      {sp.scoreDelta !== null && (
                        <span
                          className={`font-bold ${
                            sp.scoreDelta >= 0 ? 'text-[#2D6A23]' : 'text-[#A92F2A]'
                          }`}
                        >
                          Tiến bộ: {sp.scoreDelta >= 0 ? `+${sp.scoreDelta}` : sp.scoreDelta}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {sp.attempts.map((att, idx) => (
                      <div
                        key={att.attemptId}
                        className="rounded-lg border border-slate-200 bg-[#F8FAFC] px-3 py-1.5 text-[11px] tabular-nums"
                      >
                        <span className="font-semibold text-[#65758B]">Lần {idx + 1}:</span>{' '}
                        <span className="font-bold text-[#123B68]">
                          {att.score !== null ? `${att.score}/${att.maxScore}` : 'Chưa nộp'}
                        </span>{' '}
                        <span className="text-[#65758B]">· {att.examTitle}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Attempt Detail & Admin Review Modal */}
      {selectedAttempt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Chi tiết bài làm học sinh"
        >
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 bg-[#123B68] px-6 py-4 text-white">
              <div>
                <div className="text-xs text-slate-200 font-mono">
                  Attempt ID: {selectedAttempt.attemptId}
                </div>
                <h3 className="font-display text-lg font-bold">
                  {selectedAttempt.studentName} · Lớp {selectedAttempt.className}
                </h3>
                <div className="text-xs text-slate-200 mt-0.5">
                  {selectedAttempt.examTitle} · Điểm:{' '}
                  <strong>
                    {selectedAttempt.score !== null
                      ? `${selectedAttempt.score}/${selectedAttempt.maxScore}`
                      : 'Chờ duyệt'}
                  </strong>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedAttempt(null)}
                aria-label="Đóng chi tiết"
                className="rounded-lg p-1.5 text-slate-200 hover:bg-white/10 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4 rounded-xl border border-slate-200 bg-[#F8FAFC] p-4 text-xs">
                <div>
                  <span className="text-[#65758B]">Thời điểm bắt đầu:</span>
                  <div className="font-semibold text-[#123B68] tabular-nums mt-0.5">
                    {formatDateTime(selectedAttempt.startedAt)}
                  </div>
                </div>
                <div>
                  <span className="text-[#65758B]">Thời điểm nộp bài:</span>
                  <div className="font-semibold text-[#123B68] tabular-nums mt-0.5">
                    {formatDateTime(selectedAttempt.submittedAt)}
                  </div>
                </div>
                <div>
                  <span className="text-[#65758B]">Thời gian làm bài:</span>
                  <div className="font-semibold text-[#2878B8] tabular-nums mt-0.5">
                    {formatDurationVi(
                      selectedAttempt.startedAt,
                      selectedAttempt.submittedAt,
                      selectedAttempt.durationSeconds
                    )}
                  </div>
                </div>
                <div>
                  <span className="text-[#65758B]">Trạng thái &amp; Duyệt:</span>
                  <div className="font-semibold text-[#123B68] mt-0.5">
                    {STATUS_META[selectedAttempt.completionStatus].label}
                    {selectedAttempt.reviewedByEmail
                      ? ` (${selectedAttempt.reviewedByEmail})`
                      : ''}
                  </div>
                </div>
              </div>

              {/* Per-Question Answers */}
              <div className="space-y-3">
                <h4 className="font-display text-sm font-bold text-[#123B68]">
                  Chi tiết từng câu hỏi ({selectedAttempt.detailedAnswers.length} câu)
                </h4>

                {selectedAttempt.detailedAnswers.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-300 p-5 text-xs text-[#65758B]">
                    Phiên làm bài này chưa có dữ liệu câu trả lời được nộp.
                  </div>
                ) : (
                  selectedAttempt.detailedAnswers.map((ans, idx) => (
                    <div
                      key={`${ans.questionId}-${idx}`}
                      className="rounded-xl border border-slate-200 bg-white p-4 space-y-2.5 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-bold text-[#2878B8]">
                          Câu {idx + 1} (Phần {ans.part} ·{' '}
                          {ans.questionType === 'multiple_choice'
                            ? 'Trắc nghiệm'
                            : ans.questionType === 'true_false'
                            ? 'Đúng/Sai'
                            : 'Tự luận'}
                          )
                        </span>
                        <span className="font-mono font-bold text-[#123B68] tabular-nums">
                          {ans.earnedPoints ?? 'Chờ chấm'} / {ans.maxPoints} đ
                        </span>
                      </div>

                      {ans.questionText && (
                        <p className="font-semibold text-[#123B68] text-sm">
                          {ans.questionText}
                        </p>
                      )}

                      {ans.questionType === 'multiple_choice' && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                          <div className="rounded-lg bg-[#F3F6FA] px-3 py-2">
                            <span className="text-[#65758B]">Học sinh chọn: </span>
                            <strong className="text-[#123B68]">
                              {ans.selectedOption || '(Bỏ trống)'}
                              {ans.selectedOptionText ? `. ${ans.selectedOptionText}` : ''}
                            </strong>
                          </div>
                          <div className="rounded-lg bg-[#EEF7EC] px-3 py-2">
                            <span className="text-[#2D6A23]">Đáp án chuẩn: </span>
                            <strong className="text-[#2D6A23]">
                              {ans.correctOption || '—'}
                              {ans.correctOptionText ? `. ${ans.correctOptionText}` : ''}
                            </strong>
                          </div>
                        </div>
                      )}

                      {ans.questionType === 'true_false' && (
                        <div className="rounded-lg bg-[#F3F6FA] px-3 py-2 font-mono text-[11px]">
                          Học sinh: a={String(ans.statementChoices?.a ?? '—')}, b=
                          {String(ans.statementChoices?.b ?? '—')}, c=
                          {String(ans.statementChoices?.c ?? '—')}, d=
                          {String(ans.statementChoices?.d ?? '—')} · Chuẩn: a=
                          {String(ans.correctStatements?.a)}, b=
                          {String(ans.correctStatements?.b)}, c=
                          {String(ans.correctStatements?.c)}, d=
                          {String(ans.correctStatements?.d)} (Đúng{' '}
                          {ans.trueFalseCorrectCount ?? 0}/4 ý)
                        </div>
                      )}

                      {ans.questionType === 'essay' && (
                        <div className="space-y-2.5 pt-1">
                          <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3 whitespace-pre-wrap text-[#203247]">
                            <div className="text-[11px] font-semibold text-[#65758B] mb-1">
                              Bài làm tự luận của học sinh:
                            </div>
                            {ans.essayText?.trim() || '(Học sinh bỏ trống)'}
                          </div>

                          {ans.aiFeedback && (
                            <div className="rounded-lg border border-[#2878B8]/25 bg-[#EAF3FA] p-2.5 text-[#123B68]">
                              <strong>Gợi ý từ AI ({ans.aiSuggestedScore ?? '—'}đ): </strong>
                              {ans.aiFeedback}
                            </div>
                          )}

                          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 pt-1">
                            <div className="sm:col-span-4">
                              <label className="block text-[11px] font-semibold text-[#123B68] mb-1">
                                Điểm duyệt (tối đa {ans.maxPoints}đ)
                              </label>
                              <input
                                type="number"
                                step="0.25"
                                min={0}
                                max={ans.maxPoints}
                                value={essayScoresDraft[ans.questionId]?.score ?? '0'}
                                onChange={(e) =>
                                  setEssayScoresDraft((prev) => ({
                                    ...prev,
                                    [ans.questionId]: {
                                      score: e.target.value,
                                      comment: prev[ans.questionId]?.comment ?? '',
                                    },
                                  }))
                                }
                                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-[#123B68]"
                              />
                            </div>
                            <div className="sm:col-span-8">
                              <label className="block text-[11px] font-semibold text-[#123B68] mb-1">
                                Nhận xét câu tự luận
                              </label>
                              <input
                                type="text"
                                value={essayScoresDraft[ans.questionId]?.comment ?? ''}
                                onChange={(e) =>
                                  setEssayScoresDraft((prev) => ({
                                    ...prev,
                                    [ans.questionId]: {
                                      score: prev[ans.questionId]?.score ?? '0',
                                      comment: e.target.value,
                                    },
                                  }))
                                }
                                placeholder="Ghi chú chấm bài theo biểu điểm..."
                                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-[#203247]"
                              />
                            </div>
                          </div>
                        </div>
                      )}

                      {ans.explanation && (
                        <div className="text-[11px] text-[#65758B]">
                          <strong>Giải thích: </strong>
                          {ans.explanation}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* Admin Overall Review / Feedback Box */}
              {selectedAttempt.completionStatus !== 'in_progress' && (
                <div className="rounded-xl border border-slate-200 bg-[#F3F6FA] p-4 space-y-3">
                  <label className="block text-xs font-bold text-[#123B68]">
                    Nhận xét chung &amp; Xác nhận duyệt bài (Super Admin)
                  </label>
                  <textarea
                    rows={2}
                    value={adminFeedbackDraft}
                    onChange={(e) => setAdminFeedbackDraft(e.target.value)}
                    placeholder="Nhập nhận xét cho bài thi (tùy chọn)..."
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-[#203247]"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedAttempt(null)}
                      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-[#203247]"
                    >
                      Đóng
                    </button>
                    <button
                      type="button"
                      disabled={savingReview}
                      onClick={() => void handleSaveReview()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#2878B8] px-4 py-2 text-xs font-semibold text-white hover:bg-[#123B68] disabled:opacity-50"
                    >
                      {savingReview ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      <span>Lưu kết quả duyệt</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
