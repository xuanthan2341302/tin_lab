import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  Award,
  BarChart3,
  BookOpen,
  ClipboardCheck,
  Database,
  FileEdit,
  FileText,
  Layers,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react'
import { fetchPublicDashboardMetrics } from '../lib/dashboardClient'
import { fetchStudentPublishedExams } from '../lib/examDb'
import type {
  NavPage,
  PublishedExam,
  RealDashboardMetricsResponse,
} from '../types'

interface StatisticsPageProps {
  onNavigate: (page: NavPage) => void
}

export function StatisticsPage({ onNavigate }: StatisticsPageProps) {
  const [data, setData] = useState<RealDashboardMetricsResponse | null>(null)
  const [openExams, setOpenExams] = useState<PublishedExam[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const loadStats = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [metricsRes, examsRes] = await Promise.allSettled([
      fetchPublicDashboardMetrics(),
      fetchStudentPublishedExams(),
    ])

    if (metricsRes.status === 'fulfilled') {
      setData(metricsRes.value)
    } else {
      setData(null)
      setError(
        metricsRes.reason instanceof Error
          ? metricsRes.reason.message
          : 'Không thể truy vấn dữ liệu thống kê thực tế từ máy chủ.'
      )
    }

    if (examsRes.status === 'fulfilled') {
      setOpenExams(examsRes.value)
    } else {
      setOpenExams([])
    }

    setLoading(false)
  }, [])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  const filteredTopics = useMemo(() => {
    const list = data?.topicBreakdown ?? []
    const q = searchQuery.trim().toLowerCase()
    if (!q) return list
    return list.filter((item) => item.topicName.toLowerCase().includes(q))
  }, [data, searchQuery])

  const metrics = data?.metrics
  const uploadedDocumentsCount = metrics?.uploadedDocumentsCount ?? 0
  const draftBatchesCount = metrics?.draftBatchesCount ?? 0
  const extractedQuestionsCount = metrics?.extractedQuestionsCount ?? 0
  const draftQuestionsCount = metrics?.draftQuestionsCount ?? 0
  const exceptionQuestionsCount = metrics?.exceptionQuestionsCount ?? 0
  const readyDraftQuestionsCount = metrics?.readyDraftQuestionsCount ?? 0
  const approvedBankCount = metrics?.approvedBankQuestionsCount ?? 0
  const publishedExamsCount =
    metrics?.publishedExamsCount !== null &&
    metrics?.publishedExamsCount !== undefined
      ? metrics.publishedExamsCount
      : openExams.length
  const studentAttemptsTotal = metrics?.studentAttemptsTotal ?? 0
  const studentAttemptsCompleted = metrics?.studentAttemptsCompleted ?? 0
  const studentAttemptsGraded = metrics?.studentAttemptsGraded ?? 0
  const averageScore = metrics?.averageScore ?? null
  const completionRate = metrics?.completionRate ?? null

  const examPerformance = data?.examPerformance ?? []

  const sevenMetricCards = [
    {
      id: 'documents',
      label: '1. Tài liệu đã tải lên',
      value: String(uploadedDocumentsCount),
      detail: 'Bảng PostgreSQL: teacher_documents',
      icon: FileText,
      tone: 'bg-[#EEF7EC] text-[#3C7F31]',
    },
    {
      id: 'extracted',
      label: '2. Câu hỏi đã trích xuất',
      value: String(extractedQuestionsCount),
      detail: `Tổng từ ${draftBatchesCount} đợt trích xuất (question_import_drafts)`,
      icon: Layers,
      tone: 'bg-[#EAF3FA] text-[#2878B8]',
    },
    {
      id: 'draft',
      label: '3. Câu hỏi bản nháp',
      value: String(draftQuestionsCount),
      detail: `Sẵn sàng duyệt: ${readyDraftQuestionsCount} câu (đang ở trạng thái draft)`,
      icon: FileEdit,
      tone: 'bg-[#F3F6FA] text-[#123B68]',
    },
    {
      id: 'exception',
      label: '4. Câu hỏi ngoại lệ',
      value: String(exceptionQuestionsCount),
      detail: 'Thiếu đáp án, cần kiểm tra hoặc trùng lặp trong bản nháp',
      icon: AlertTriangle,
      tone: 'bg-[#FEF6EC] text-[#C86D14]',
    },
    {
      id: 'approved',
      label: '5. Đã duyệt vào ngân hàng chính thức',
      value: String(approvedBankCount),
      detail: 'Kho ngân hàng câu hỏi chính thức (questionBank)',
      icon: Database,
      tone: 'bg-[#EAF2FF] text-[#3B5BDB]',
    },
    {
      id: 'published',
      label: '6. Đề thi đã xuất bản',
      value: String(publishedExamsCount),
      detail: 'Đề thi đang mở cho học sinh (publishedExams)',
      icon: ClipboardCheck,
      tone: 'bg-[#F4EFF8] text-[#7954A1]',
    },
    {
      id: 'attempts',
      label: '7. Kết quả học sinh thực tế',
      value: `${studentAttemptsTotal} lượt`,
      detail: `Đã nộp: ${studentAttemptsCompleted} · Đã chấm điểm: ${studentAttemptsGraded} (exam_attempts)`,
      icon: Award,
      tone: 'bg-[#EEF7EC] text-[#2D6A23]',
    },
  ]

  const maxTopicCount = Math.max(
    1,
    ...filteredTopics.map((t) => Math.max(t.extractedCount, t.approvedBankCount))
  )

  return (
    <div className="space-y-6">
      {/* Header & Refresh */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-[#2878B8]">
              <BarChart3 className="h-4 w-4" />
              <span>Bảng điều khiển Thống kê · Dữ liệu thực tế</span>
            </div>
            <h1 className="font-display text-2xl font-extrabold text-[#123B68]">
              Thống kê dữ liệu thực tế TIN LAB
            </h1>
            <p className="text-xs text-[#65758B]">
              Toàn bộ chỉ số được truy vấn trực tiếp từ PostgreSQL và kho đề thi thực tế. Khi chưa phát sinh dữ liệu, hệ thống hiển thị 0 hoặc &ldquo;Chưa có dữ liệu&rdquo;.
            </p>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={() => void loadStats()}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-[#123B68] hover:border-[#2878B8] hover:text-[#2878B8] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Làm mới số liệu</span>
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
            <span>{error}</span>
          </div>
        )}

        {!error &&
          data &&
          !data.dataSources.postgresAvailable &&
          data.dataSources.postgresNotice && (
            <div
              role="status"
              className="flex items-start gap-2.5 rounded-lg border border-[#F28C28]/40 bg-[#FEF6EC] px-4 py-3 text-xs text-[#9A520B]"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#F28C28]" />
              <span>{data.dataSources.postgresNotice}</span>
            </div>
          )}

        {/* Real Student Score & Completion Strip (ONLY calculated when real attempts exist) */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 border-t border-slate-200 pt-5">
          <div className="rounded-lg border border-slate-200 bg-[#F3F6F9] p-4">
            <div className="text-xs font-medium text-[#65758B]">
              Điểm trung bình thực tế
            </div>
            <div className="mt-1 font-display text-2xl font-extrabold text-[#123B68] tabular-nums">
              {averageScore !== null ? `${averageScore} / 10.0` : 'Chưa có dữ liệu'}
            </div>
            <div className="mt-1 text-xs text-[#65758B] tabular-nums">
              {studentAttemptsGraded > 0
                ? `Tính trên ${studentAttemptsGraded} lượt làm bài đã chấm điểm`
                : 'Chỉ tính khi có kết quả làm bài thực tế'}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-[#F3F6F9] p-4">
            <div className="text-xs font-medium text-[#65758B]">
              Tỷ lệ hoàn thành thực tế
            </div>
            <div className="mt-1 font-display text-2xl font-extrabold text-[#123B68] tabular-nums">
              {completionRate !== null ? `${completionRate}%` : 'Chưa có dữ liệu'}
            </div>
            <div className="mt-1 text-xs text-[#65758B] tabular-nums">
              {studentAttemptsTotal > 0
                ? `${studentAttemptsCompleted} / ${studentAttemptsTotal} lượt đã nộp bài`
                : 'Chỉ tính khi có lượt làm bài thực tế'}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-[#F3F6F9] p-4">
            <div className="text-xs font-medium text-[#65758B]">
              Số chuyên đề có dữ liệu thực tế
            </div>
            <div className="mt-1 font-display text-2xl font-extrabold text-[#123B68] tabular-nums">
              {data?.topicBreakdown.length ?? 0}
            </div>
            <div className="mt-1 text-xs text-[#65758B] tabular-nums">
              Ngân hàng chính thức: {approvedBankCount} · Trích xuất: {extractedQuestionsCount}
            </div>
          </div>
        </div>
      </section>

      {/* 7 Distinct Real Indicators */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-bold text-[#123B68]">
              Phân tách 7 chỉ số dữ liệu thực tế của hệ thống
            </h2>
            <p className="text-xs text-[#65758B] mt-0.5">
              Phân biệt rõ học liệu gốc, câu hỏi trích xuất, bản nháp, ngoại lệ, ngân hàng chính thức, đề thi xuất bản và kết quả học sinh.
            </p>
          </div>
          {loading && (
            <span className="inline-flex items-center gap-1.5 text-xs text-[#2878B8]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Đang tải...</span>
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {sevenMetricCards.map((item) => {
            const Icon = item.icon
            return (
              <div
                key={item.id}
                className="rounded-xl border border-slate-200 bg-[#F8FAFC] p-4 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[#123B68]">
                    {item.label}
                  </span>
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${item.tone}`}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                </div>
                <div className="font-display text-2xl font-extrabold text-[#123B68] tabular-nums">
                  {item.value}
                </div>
                <div className="text-[11px] leading-snug text-[#65758B]">
                  {item.detail}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* Real Topic Breakdown */}
      <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="font-display text-base font-bold text-[#123B68]">
              Phân bố câu hỏi theo chuyên đề thực tế
            </h2>
            <p className="text-xs text-[#65758B] mt-0.5">
              Tổng hợp trực tiếp từ các câu hỏi đã trích xuất (question_import_drafts) và ngân hàng chính thức (questionBank)
            </p>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#65758B]" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm chuyên đề..."
              aria-label="Tìm kiếm chuyên đề thực tế"
              className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-[#203247] placeholder:text-[#65758B]/70 focus:border-[#2878B8] focus:outline-none focus:ring-2 focus:ring-[#2878B8]/20"
            />
          </div>
        </div>

        {filteredTopics.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <BookOpen className="h-7 w-7 text-slate-300 mx-auto" />
            <div className="text-sm font-semibold text-[#123B68]">
              Chưa có dữ liệu chuyên đề thực tế
            </div>
            <p className="text-xs text-[#65758B] max-w-md mx-auto">
              {searchQuery.trim()
                ? 'Không tìm thấy chuyên đề nào khớp với từ khóa tìm kiếm.'
                : 'Hệ thống sẽ tự động hiển thị biểu đồ và bảng phân bố khi có câu hỏi trích xuất hoặc câu hỏi đã duyệt vào ngân hàng chính thức.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-[#F3F6F9] text-xs font-semibold text-[#65758B]">
                <tr>
                  <th className="px-6 py-3">Chuyên đề</th>
                  <th className="px-4 py-3 w-48">Tỷ trọng</th>
                  <th className="px-4 py-3 text-right">Đã trích xuất</th>
                  <th className="px-4 py-3 text-right">Bản nháp</th>
                  <th className="px-4 py-3 text-right">Ngoại lệ</th>
                  <th className="px-6 py-3 text-right">Ngân hàng chính thức</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 tabular-nums">
                {filteredTopics.map((row) => {
                  const barPct = Math.max(
                    6,
                    Math.round(
                      (Math.max(row.extractedCount, row.approvedBankCount) /
                        maxTopicCount) *
                        100
                    )
                  )
                  return (
                    <tr key={row.topicName} className="hover:bg-[#F3F6F9]/70">
                      <td className="px-6 py-3.5 font-medium text-[#203247]">
                        {row.topicName}
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="h-2 w-full overflow-hidden rounded-full bg-[#F3F6FA]">
                          <div
                            className="h-full rounded-full bg-[#2878B8]"
                            style={{ width: `${barPct}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-[#203247]">
                        {row.extractedCount}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-[#65758B]">
                        {row.draftCount}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-[#C86D14]">
                        {row.exceptionCount}
                      </td>
                      <td className="px-6 py-3.5 text-right font-mono font-semibold text-[#123B68]">
                        {row.approvedBankCount}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Real Student Performance by Exam */}
      <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="font-display text-base font-bold text-[#123B68]">
            Thống kê kết quả học sinh thực tế theo đề thi
          </h2>
          <p className="text-xs text-[#65758B] mt-0.5">
            Tổng hợp điểm trung bình và tỷ lệ hoàn thành từ bảng PostgreSQL exam_attempts (không lộ thông tin cá nhân học sinh)
          </p>
        </div>

        {examPerformance.length === 0 ? (
          <div className="p-8 text-center space-y-1.5">
            <div className="text-sm font-semibold text-[#123B68]">
              Chưa có dữ liệu kết quả học sinh
            </div>
            <p className="text-xs text-[#65758B]">
              Điểm trung bình và tỷ lệ hoàn thành theo từng đề thi sẽ xuất hiện sau khi học sinh thực hiện bài thi.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-[#F3F6F9] text-xs font-semibold text-[#65758B]">
                <tr>
                  <th className="px-6 py-3">Đề thi</th>
                  <th className="px-4 py-3 text-right">Tổng lượt</th>
                  <th className="px-4 py-3 text-right">Đã nộp</th>
                  <th className="px-4 py-3 text-right">Tỷ lệ hoàn thành</th>
                  <th className="px-6 py-3 text-right">Điểm trung bình</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 tabular-nums">
                {examPerformance.map((row) => (
                  <tr key={row.examId} className="hover:bg-[#F3F6F9]/70">
                    <td className="px-6 py-3.5 font-medium text-[#203247]">
                      {row.examTitle}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-[#203247]">
                      {row.attemptCount}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-[#203247]">
                      {row.completedCount}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-[#2878B8] font-semibold">
                      {row.completionRate !== null
                        ? `${row.completionRate}%`
                        : 'Chưa có dữ liệu'}
                    </td>
                    <td className="px-6 py-3.5 text-right font-mono font-semibold text-[#123B68]">
                      {row.averageScore !== null
                        ? `${row.averageScore} / ${row.maxScore}`
                        : 'Chưa có dữ liệu'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-[#F3F6F9] px-6 py-3.5 text-xs text-[#65758B]">
          <span>
            Học sinh có thể vào làm đề thi chính thức đang mở ngay mà không cần tài khoản.
          </span>
          <button
            type="button"
            onClick={() => onNavigate('student')}
            className="font-semibold text-[#2878B8] hover:text-[#123B68] whitespace-nowrap shrink-0"
          >
            Chuyển tới khu vực Học sinh →
          </button>
        </div>
      </section>
    </div>
  )
}
