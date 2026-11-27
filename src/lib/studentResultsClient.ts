import { getAuthHeaders } from './authClient'
import type {
  AdminStudentResultsResponse,
  AttemptDetailedAnswer,
  ExamAttemptKind,
  ServerGradeResponse,
  StudentAnswerInput,
  StudentAttemptRecord,
} from '../types'

export interface StartedAttemptInfo {
  attemptId: string
  examId: string
  examTitle: string
  examKind: ExamAttemptKind
  studentName: string
  className: string
  startedAt: string
}

export interface PracticeSubmitResult {
  ok: true
  kind: 'practice'
  attemptId: string
  studentName: string
  className: string
  startedAt: string
  submittedAt: string | null
  completionStatus: string
  score: number | null
  maxScore: number
  correctCount: number
  totalQuestions: number
  detailedAnswers: AttemptDetailedAnswer[]
}

export interface PublishedSubmitResult {
  ok: true
  kind: 'published'
  attemptId: string
  studentName: string
  className: string
  startedAt: string
  submittedAt: string | null
  completionStatus: string
  gradeResult: ServerGradeResponse
}

export async function startStudentExamAttempt(params: {
  studentName: string
  className: string
  examId: string
  examTitle: string
  examKind: ExamAttemptKind
  accessCode?: string
  maxScore?: number
  scoringMode?: string
}): Promise<StartedAttemptInfo> {
  const res = await fetch('/api/student/attempts/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  const data = (await res.json().catch(() => null)) as
    | { ok: true; attempt: StartedAttemptInfo }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể bắt đầu phiên làm bài. Vui lòng kiểm tra họ tên và lớp.'
    )
  }

  return data.attempt
}

export async function submitPracticeExamAttempt(params: {
  attemptId: string
  examId: string
  studentAnswers: StudentAnswerInput[]
}): Promise<PracticeSubmitResult> {
  const res = await fetch('/api/student/attempts/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  const data = (await res.json().catch(() => null)) as
    | PracticeSubmitResult
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể nộp bài luyện tập lên máy chủ.'
    )
  }

  return data
}

export async function submitPublishedExamAttempt(params: {
  attemptId: string
  examId: string
  sealedGradingPayload: string
  studentAnswers: StudentAnswerInput[]
}): Promise<PublishedSubmitResult> {
  const res = await fetch('/api/student/attempts/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  const data = (await res.json().catch(() => null)) as
    | PublishedSubmitResult
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể nộp và chấm bài thi trên máy chủ.'
    )
  }

  return data
}

export interface StudentResultsQueryFilters {
  q?: string
  className?: string
  examId?: string
  status?: string
  dateFrom?: string
  dateTo?: string
}

function buildResultsQueryString(
  filters: StudentResultsQueryFilters,
  extra?: Record<string, string>
): string {
  const params = new URLSearchParams()
  if (filters.q?.trim()) params.set('q', filters.q.trim())
  if (filters.className && filters.className !== 'ALL') {
    params.set('className', filters.className)
  }
  if (filters.examId && filters.examId !== 'ALL') {
    params.set('examId', filters.examId)
  }
  if (filters.status && filters.status !== 'ALL') {
    params.set('status', filters.status)
  }
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom)
  if (filters.dateTo) params.set('dateTo', filters.dateTo)
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      params.set(k, v)
    }
  }
  const str = params.toString()
  return str ? `?${str}` : ''
}

export async function fetchAdminStudentResults(
  filters: StudentResultsQueryFilters = {}
): Promise<AdminStudentResultsResponse> {
  const headers = await getAuthHeaders()
  const qs = buildResultsQueryString(filters)
  const res = await fetch(`/api/admin/student-results${qs}`, {
    method: 'GET',
    headers,
  })
  const data = (await res.json().catch(() => null)) as
    | AdminStudentResultsResponse
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể tải dữ liệu Kết quả học sinh.'
    )
  }

  return data
}

export async function reviewStudentAttemptAsAdmin(params: {
  attemptId: string
  essayScores: Record<string, { score: number; comment: string }>
  adminFeedback: string
}): Promise<StudentAttemptRecord> {
  const headers = await getAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch(
    `/api/admin/student-results/${encodeURIComponent(params.attemptId)}/review`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        essayScores: params.essayScores,
        adminFeedback: params.adminFeedback,
      }),
    }
  )
  const data = (await res.json().catch(() => null)) as
    | { ok: true; attempt: StudentAttemptRecord }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể lưu điểm duyệt của Super Admin.'
    )
  }

  return data.attempt
}

export async function downloadAdminStudentResultsExcel(params: {
  filters: StudentResultsQueryFilters
  includeDetails: boolean
}): Promise<string> {
  const headers = await getAuthHeaders()
  const qs = buildResultsQueryString(params.filters, {
    includeDetails: params.includeDetails ? '1' : '0',
  })
  const res = await fetch(`/api/admin/student-results/export${qs}`, {
    method: 'GET',
    headers,
  })

  if (!res.ok) {
    const errPayload = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(
      errPayload?.error || 'Không thể xuất tệp kết quả học sinh lúc này.'
    )
  }

  const blob = await res.blob()
  const contentType = (res.headers.get('Content-Type') || '').toLowerCase()
  const defaultExt = contentType.includes('text/csv') ? 'csv' : 'xlsx'
  const disposition = res.headers.get('Content-Disposition') || ''
  const match = disposition.match(/filename="?([^"]+)"?/i)
  const filename =
    match?.[1] ||
    (params.includeDetails
      ? `tin-lab-ket-qua-chi-tiet.${defaultExt}`
      : `tin-lab-ket-qua-hoc-sinh.${defaultExt}`)

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)

  return filename
}
