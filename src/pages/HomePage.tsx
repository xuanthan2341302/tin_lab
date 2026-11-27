import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Award,
  BookOpen,
  ClipboardCheck,
  Database,
  FileText,
  GraduationCap,
  Loader2,
  RefreshCw,
  Users,
} from 'lucide-react'
import { fetchPublicDashboardMetrics } from '../lib/dashboardClient'
import { fetchStudentPublishedExams } from '../lib/examDb'
import type {
  NavPage,
  PublishedExam,
  RealDashboardMetricsResponse,
} from '../types'

interface HomePageProps {
  onNavigate: (page: NavPage) => void
  selectedRole: 'student' | 'teacher' | null
  onSelectRole: (role: 'student' | 'teacher') => void
}

const TOPIC_BAR_COLORS = ['#3B5BDB', '#2878B8', '#55A747', '#7954A1', '#F28C28']

export function HomePage({
  onNavigate,
  selectedRole,
  onSelectRole,
}: HomePageProps) {
  const [dashboardData, setDashboardData] =
    useState<RealDashboardMetricsResponse | null>(null)
  const [openExams, setOpenExams] = useState<PublishedExam[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    const [metricsRes, examsRes] = await Promise.allSettled([
      fetchPublicDashboardMetrics(),
      fetchStudentPublishedExams(),
    ])

    if (metricsRes.status === 'fulfilled') {
      setDashboardData(metricsRes.value)
    } else {
      setDashboardData(null)
      setLoadError(
        metricsRes.reason instanceof Error
          ? metricsRes.reason.message
          : 'Không thể tải dữ liệu thống kê thực tế từ máy chủ.'
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
    void loadDashboard()
  }, [loadDashboard])

  const handleQuickEnter = (role: 'student' | 'teacher') => {
    onSelectRole(role)
    onNavigate(role)
  }

  const metrics = dashboardData?.metrics
  const uploadedDocumentsCount = metrics?.uploadedDocumentsCount ?? 0
  const draftBatchesCount = metrics?.draftBatchesCount ?? 0
  const extractedQuestionsCount = metrics?.extractedQuestionsCount ?? 0
  const draftQuestionsCount = metrics?.draftQuestionsCount ?? 0
  const exceptionQuestionsCount = metrics?.exceptionQuestionsCount ?? 0
  const approvedBankCount = metrics?.approvedBankQuestionsCount ?? 0
  const publishedExamsCount =
    metrics?.publishedExamsCount !== null &&
    metrics?.publishedExamsCount !== undefined
      ? metrics.publishedExamsCount
      : openExams.length
  const studentAttemptsTotal = metrics?.studentAttemptsTotal ?? 0
  const studentAttemptsCompleted = metrics?.studentAttemptsCompleted ?? 0
  const studentAttemptsInProgress = metrics?.studentAttemptsInProgress ?? 0
  const averageScore = metrics?.averageScore ?? null
  const completionRate = metrics?.completionRate ?? null

  const topicBreakdown = dashboardData?.topicBreakdown ?? []
  const maxTopicTotal = Math.max(
    1,
    ...topicBreakdown.map((t) => Math.max(t.extractedCount, t.approvedBankCount))
  )

  // Real student attempt status doughnut (only rendered when studentAttemptsTotal > 0)
  const completedPct =
    studentAttemptsTotal > 0
      ? Math.round((studentAttemptsCompleted / studentAttemptsTotal) * 100)
      : 0
  const inProgressPct =
    studentAttemptsTotal > 0 ? Math.max(0, 100 - completedPct) : 0
  const radius = 52
  const circumference = 2 * Math.PI * radius
  const realDoughnutSegments =
    studentAttemptsTotal > 0
      ? [
          {
            label: 'Đã nộp bài',
            count: studentAttemptsCompleted,
            pct: completedPct,
            color: '#3B5BDB',
          },
          {
            label: 'Đang làm dở',
            count: studentAttemptsInProgress,
            pct: inProgressPct,
            color: '#F28C28',
          },
        ]
      : []

  let cumulativePct = 0

  const kpiCards = [
    {
      id: 'approved-bank',
      label: 'Ngân hàng câu hỏi chính thức',
      value: String(approvedBankCount),
      detail: `Trích xuất: ${extractedQuestionsCount} · Nháp: ${draftQuestionsCount} · Ngoại lệ: ${exceptionQuestionsCount}`,
      icon: Database,
      bg: 'bg-[#EAF2FF]',
      color: 'text-[#3B5BDB]',
    },
    {
      id: 'documents',
      label: 'Tài liệu đã tải lên',
      value: String(uploadedDocumentsCount),
      detail:
        draftBatchesCount > 0
          ? `${draftBatchesCount} đợt trích xuất câu hỏi đã lưu`
          : 'Chưa có đợt trích xuất nào',
      icon: FileText,
      bg: 'bg-[#EEF7EC]',
      color: 'text-[#55A747]',
    },
    {
      id: 'published-exams',
      label: 'Đề thi đã xuất bản',
      value: String(publishedExamsCount),
      detail:
        publishedExamsCount > 0
          ? 'Đang mở cho học sinh tham gia'
          : 'Chưa có đề thi nào đang mở',
      icon: ClipboardCheck,
      bg: 'bg-[#FEF6EC]',
      color: 'text-[#F28C28]',
    },
    {
      id: 'student-results',
      label: 'Kết quả học sinh thực tế',
      value:
        studentAttemptsTotal > 0
          ? `${studentAttemptsTotal} lượt`
          : '0 lượt',
      detail:
        averageScore !== null
          ? `Điểm TB: ${averageScore}/10 · Hoàn thành: ${completionRate ?? 0}%`
          : studentAttemptsTotal > 0
          ? `Hoàn thành: ${completionRate ?? 0}% · Chưa có bài chấm điểm`
          : 'Điểm TB: Chưa có dữ liệu',
      icon: Award,
      bg: 'bg-[#F4EFF8]',
      color: 'text-[#7954A1]',
    },
  ]

  return (
    <div className="space-y-6">
      {/* MAIN DASHBOARD HERO: Two-column section */}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-stretch">
        {/* Left: Large Welcome Card */}
        <div className="lg:col-span-8 flex flex-col justify-between rounded-xl border border-slate-200/90 bg-white p-6 sm:p-7 shadow-[0_1px_3px_rgba(18,59,104,0.05)]">
          <div className="space-y-3.5">
            <div className="text-xs font-semibold text-[#3B5BDB]">
              Chương trình Tin học 12 · THPT
            </div>
            <h1 className="font-display text-2xl sm:text-3xl lg:text-[32px] font-extrabold leading-tight tracking-tight text-[#123B68]">
              TIN LAB – Nền tảng học tập
              <br />
              và thi trực tuyến môn Tin học 12
            </h1>
            <p className="max-w-2xl text-sm sm:text-[15px] leading-relaxed text-[#65758B]">
              Không gian học tập hệ thống, luyện tập trắc nghiệm theo từng chuyên đề và tổ
              chức kiểm tra trực tuyến dành cho học sinh và giáo viên môn Tin học 12.
            </p>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 pt-2">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => handleQuickEnter('student')}
                className="inline-flex items-center gap-2 rounded-lg bg-[#3B5BDB] px-5 py-2.5 min-h-[42px] text-sm font-semibold text-white hover:bg-[#2B46B8] transition-colors whitespace-nowrap shrink-0 shadow-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B5BDB]"
              >
                <GraduationCap className="h-4 w-4" />
                <span>Vào khu vực Học sinh</span>
              </button>
              <button
                type="button"
                onClick={() => handleQuickEnter('teacher')}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-2.5 min-h-[42px] text-sm font-semibold text-[#123B68] hover:border-[#3B5BDB] hover:text-[#3B5BDB] hover:bg-[#F3F6FA] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B5BDB]"
              >
                <Users className="h-4 w-4" />
                <span>Đăng nhập quản trị</span>
              </button>
            </div>

            {selectedRole && (
              <span className="text-xs text-[#65758B]">
                Vai trò đang chọn:{' '}
                <strong className="text-[#123B68]">
                  {selectedRole === 'student' ? 'Học sinh' : 'Quản trị viên'}
                </strong>
              </span>
            )}
          </div>
        </div>

        {/* Right: Trọng tâm ôn luyện lớp 12 card */}
        <div className="lg:col-span-4 flex flex-col justify-between rounded-xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-[0_1px_3px_rgba(18,59,104,0.05)]">
          <div className="space-y-3.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-base font-bold text-[#123B68]">
                Trọng tâm ôn luyện lớp 12
              </h2>
              <BookOpen className="h-4 w-4 text-[#3B5BDB] shrink-0" />
            </div>

            <ul className="divide-y divide-slate-100 text-xs sm:text-[13px]">
              <li className="flex items-center justify-between gap-2 py-2.5">
                <span className="font-medium text-[#203247]">
                  Mạng máy tính &amp; Trí tuệ nhân tạo
                </span>
                <span className="font-mono text-xs font-semibold text-[#3B5BDB] shrink-0 tabular-nums">
                  Chủ đề A, B
                </span>
              </li>
              <li className="flex items-center justify-between gap-2 py-2.5">
                <span className="font-medium text-[#203247]">
                  Tạo trang web (HTML5 &amp; CSS3)
                </span>
                <span className="font-mono text-xs font-semibold text-[#55A747] shrink-0 tabular-nums">
                  Chủ đề F
                </span>
              </li>
              <li className="flex items-center justify-between gap-2 py-2.5">
                <span className="font-medium text-[#203247]">
                  Cơ sở dữ liệu &amp; An toàn thông tin
                </span>
                <span className="font-mono text-xs font-semibold text-[#7954A1] shrink-0 tabular-nums">
                  Chủ đề D, E
                </span>
              </li>
            </ul>
          </div>

          <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => onNavigate('guide')}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#3B5BDB] hover:text-[#123B68] transition-colors"
            >
              <span>Hướng dẫn sử dụng</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onNavigate('student')}
              className="text-xs font-semibold text-[#65758B] hover:text-[#123B68] transition-colors"
            >
              Vào khu vực Học sinh →
            </button>
          </div>
        </div>
      </section>

      {/* REAL STATISTICS DASHBOARD */}
      <section aria-labelledby="dashboard-stats-heading" className="space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            id="dashboard-stats-heading"
            className="font-display text-sm font-extrabold tracking-wide text-[#123B68]"
          >
            PHẦN DASHBOARD THỐNG KÊ
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-[#65758B]">
              Số liệu thực tế từ cơ sở dữ liệu TIN LAB
            </span>
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadDashboard()}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-[#123B68] hover:border-[#3B5BDB] hover:text-[#3B5BDB] disabled:opacity-60 transition-colors"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
              <span>Làm mới</span>
            </button>
          </div>
        </div>

        {loadError && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-xl border border-[#D94B45]/35 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
            <span>{loadError}</span>
          </div>
        )}

        {!loadError &&
          dashboardData &&
          !dashboardData.dataSources.postgresAvailable &&
          dashboardData.dataSources.postgresNotice && (
            <div
              role="status"
              className="flex items-start gap-2.5 rounded-xl border border-[#F28C28]/40 bg-[#FEF6EC] px-4 py-3 text-xs text-[#9A520B]"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#F28C28]" />
              <span>{dashboardData.dataSources.postgresNotice}</span>
            </div>
          )}

        {loading && !dashboardData ? (
          <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-6 text-xs text-[#65758B]">
            <Loader2 className="h-4 w-4 animate-spin text-[#3B5BDB]" />
            <span>Đang truy vấn số liệu thực tế từ hệ thống...</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {kpiCards.map((card) => {
              const Icon = card.icon
              return (
                <div
                  key={card.id}
                  className="flex items-start gap-3.5 rounded-xl border border-slate-200/90 bg-white p-4 sm:p-5 shadow-[0_1px_3px_rgba(18,59,104,0.05)]"
                >
                  <div
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${card.bg} ${card.color}`}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-xs font-medium text-[#65758B] truncate">
                      {card.label}
                    </div>
                    <div className="font-display text-2xl font-extrabold text-[#123B68] tabular-nums">
                      {card.value}
                    </div>
                    <div className="text-[11px] leading-snug text-[#65758B]">
                      {card.detail}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ACTIVITY & ACCESS SECTION - 3-column real data layout */}
      <section aria-labelledby="activity-access-heading" className="space-y-3.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="activity-access-heading"
            className="font-display text-sm font-extrabold tracking-wide text-[#123B68]"
          >
            PHẦN HOẠT ĐỘNG VÀ TRUY CẬP
          </h2>
          <button
            type="button"
            onClick={() => onNavigate('stats')}
            className="text-xs font-semibold text-[#3B5BDB] hover:text-[#123B68] transition-colors whitespace-nowrap"
          >
            Xem thống kê đầy đủ →
          </button>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* Column 1: Open Published Exams & Quick Access */}
          <div className="flex flex-col justify-between rounded-xl border border-slate-200/90 bg-white p-5 shadow-[0_1px_3px_rgba(18,59,104,0.05)]">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3">
                <h3 className="font-display text-sm font-bold text-[#123B68]">
                  Đề thi đang mở &amp; Truy cập nhanh
                </h3>
                <span className="font-mono text-[11px] font-semibold text-[#65758B] tabular-nums">
                  {publishedExamsCount} đề
                </span>
              </div>

              {openExams.length > 0 ? (
                <ul className="divide-y divide-slate-100">
                  {openExams.slice(0, 3).map((exam) => (
                    <li key={exam.id}>
                      <button
                        type="button"
                        onClick={() => onNavigate('student')}
                        className="flex w-full items-start justify-between gap-2 py-2.5 text-left hover:text-[#3B5BDB] transition-colors"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-[#203247] line-clamp-2">
                            {exam.title}
                          </div>
                          <div className="text-[11px] text-[#65758B] mt-0.5 tabular-nums">
                            Mã phòng: <strong className="font-mono">{exam.accessCode}</strong> ·{' '}
                            {exam.durationMinutes} phút · {exam.totalPoints}đ
                          </div>
                        </div>
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[#3B5BDB] mt-0.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-200 bg-[#F8FAFC] p-4 text-xs text-[#65758B] leading-relaxed">
                  Chưa có đề thi chính thức nào đang mở. Giáo viên quản trị có thể duyệt ngân hàng câu hỏi và xuất bản đề thi tại khu vực Quản trị.
                </div>
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2.5 border-t border-slate-100 pt-4">
              <button
                type="button"
                onClick={() => handleQuickEnter('student')}
                className="rounded-lg bg-[#3B5BDB] px-3 py-2 text-xs font-semibold text-white hover:bg-[#2B46B8] transition-colors whitespace-nowrap"
              >
                Khu vực Học sinh
              </button>
              <button
                type="button"
                onClick={() => handleQuickEnter('teacher')}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-[#123B68] hover:border-[#3B5BDB] hover:text-[#3B5BDB] transition-colors whitespace-nowrap"
              >
                Đăng nhập quản trị
              </button>
            </div>
          </div>

          {/* Column 2: Real Topic Distribution */}
          <div className="flex flex-col justify-between rounded-xl border border-slate-200/90 bg-white p-5 shadow-[0_1px_3px_rgba(18,59,104,0.05)]">
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3">
                <h3 className="font-display text-sm font-bold text-[#123B68]">
                  Phân bố câu hỏi theo chuyên đề
                </h3>
                <span className="font-mono text-[11px] font-semibold text-[#65758B] tabular-nums">
                  {topicBreakdown.length} chuyên đề
                </span>
              </div>

              {topicBreakdown.length > 0 ? (
                <div className="space-y-3">
                  {topicBreakdown.slice(0, 5).map((topic, idx) => {
                    const displayCount = Math.max(
                      topic.extractedCount,
                      topic.approvedBankCount
                    )
                    const widthPct = Math.max(
                      6,
                      Math.round((displayCount / maxTopicTotal) * 100)
                    )
                    return (
                      <div key={topic.topicName} className="space-y-1">
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="font-medium text-[#203247] truncate">
                            {topic.topicName}
                          </span>
                          <span className="font-mono text-[11px] font-semibold text-[#65758B] tabular-nums shrink-0">
                            {topic.approvedBankCount > 0
                              ? `${topic.approvedBankCount} chính thức`
                              : `${topic.extractedCount} trích xuất`}
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-[#F3F6FA]">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${widthPct}%`,
                              backgroundColor:
                                TOPIC_BAR_COLORS[idx % TOPIC_BAR_COLORS.length],
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-200 bg-[#F8FAFC] p-4 text-xs text-[#65758B] leading-relaxed">
                  Chưa có dữ liệu chuyên đề thực tế. Số liệu sẽ tự động hiển thị khi có câu hỏi trích xuất hoặc câu hỏi đã duyệt trong hệ thống.
                </div>
              )}
            </div>

            <div className="mt-4 border-t border-slate-100 pt-3 flex items-center justify-between text-[11px] text-[#65758B] tabular-nums">
              <span>
                Chính thức: {approvedBankCount} · Trích xuất: {extractedQuestionsCount}
              </span>
              <button
                type="button"
                onClick={() => onNavigate('stats')}
                className="font-semibold text-[#3B5BDB] hover:text-[#123B68]"
              >
                Chi tiết →
              </button>
            </div>
          </div>

          {/* Column 3: Real Student Attempt Completion */}
          <div className="flex flex-col justify-between rounded-xl border border-slate-200/90 bg-white p-5 shadow-[0_1px_3px_rgba(18,59,104,0.05)]">
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <h3 className="font-display text-sm font-bold text-[#123B68]">
                Trạng thái bài làm học sinh
              </h3>
              <span className="font-mono text-[11px] font-semibold text-[#65758B] tabular-nums">
                {studentAttemptsTotal} lượt
              </span>
            </div>

            {studentAttemptsTotal > 0 ? (
              <div className="my-4 flex flex-col items-center justify-center gap-4 sm:flex-row lg:flex-col xl:flex-row">
                <div className="relative h-32 w-32 shrink-0">
                  <svg
                    viewBox="0 0 132 132"
                    className="h-full w-full -rotate-90"
                    role="img"
                    aria-label={`Tỷ lệ hoàn thành bài làm học sinh thực tế: ${completionRate ?? completedPct}%`}
                  >
                    {realDoughnutSegments.map((seg) => {
                      const segLength = (seg.pct / 100) * circumference
                      const dashArray = `${segLength} ${circumference - segLength}`
                      const dashOffset = -((cumulativePct / 100) * circumference)
                      cumulativePct += seg.pct
                      return (
                        <circle
                          key={seg.label}
                          cx="66"
                          cy="66"
                          r={radius}
                          fill="transparent"
                          stroke={seg.color}
                          strokeWidth="16"
                          strokeDasharray={dashArray}
                          strokeDashoffset={dashOffset}
                        />
                      )
                    })}
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                    <span className="font-display text-xl font-extrabold text-[#123B68] tabular-nums">
                      {completionRate ?? completedPct}%
                    </span>
                    <span className="text-[10px] font-medium text-[#65758B]">
                      Hoàn thành
                    </span>
                  </div>
                </div>

                <ul className="w-full space-y-2 text-xs">
                  {realDoughnutSegments.map((seg) => (
                    <li
                      key={seg.label}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="flex items-center gap-2 text-[#203247] min-w-0">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-xs"
                          style={{ backgroundColor: seg.color }}
                          aria-hidden="true"
                        />
                        <span className="truncate">{seg.label}</span>
                      </span>
                      <span className="font-mono font-semibold text-[#123B68] tabular-nums shrink-0">
                        {seg.count} ({seg.pct}%)
                      </span>
                    </li>
                  ))}
                  <li className="flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
                    <span className="text-[#65758B]">Điểm trung bình</span>
                    <span className="font-mono font-semibold text-[#123B68] tabular-nums">
                      {averageScore !== null ? `${averageScore} / 10` : 'Chưa có dữ liệu'}
                    </span>
                  </li>
                </ul>
              </div>
            ) : (
              <div className="my-4 rounded-lg border border-dashed border-slate-200 bg-[#F8FAFC] p-5 text-center space-y-1.5">
                <div className="font-display text-base font-bold text-[#123B68]">
                  Chưa có dữ liệu
                </div>
                <p className="text-xs text-[#65758B] leading-relaxed">
                  Chưa có lượt làm bài thực tế nào của học sinh được ghi nhận trong PostgreSQL.
                </p>
              </div>
            )}

            <div className="border-t border-slate-100 pt-3 flex items-center justify-between text-[11px] text-[#65758B]">
              <span>Nguồn: bảng exam_attempts (PostgreSQL)</span>
              <button
                type="button"
                onClick={() => onNavigate('stats')}
                className="font-semibold text-[#3B5BDB] hover:text-[#123B68]"
              >
                Báo cáo →
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
