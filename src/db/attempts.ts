import { and, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm'
import { db, getPostgresConnectionDiagnostics } from './index.ts'
import { examAttempts } from './schema.ts'
import { normalizeClassName } from '../lib/studentValidation.ts'
import type {
  AdminStudentResultsResponse,
  AttemptCompletionStatus,
  AttemptDetailedAnswer,
  ClassPerformanceStat,
  ExamAttemptKind,
  ExamPerformanceStat,
  StudentAttemptRecord,
  StudentProgressSummary,
} from '../types.ts'

export interface ClassifiedDbError extends Error {
  code?: string
  httpStatus?: number
  cause?: unknown
}

function extractPgErrorMetadata(cause: unknown): {
  code: string
  message: string
} {
  let current: unknown = cause
  const seen = new Set<unknown>()
  let code = ''
  const messages: string[] = []

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const rec = current as Record<string, unknown>
    if (typeof rec.code === 'string' && rec.code.trim()) {
      code = rec.code.trim()
    }
    if (typeof rec.message === 'string' && rec.message.trim()) {
      messages.push(rec.message.trim())
    }
    current = rec.cause
  }

  if (messages.length === 0 && typeof cause === 'string') {
    messages.push(cause)
  }

  return { code, message: messages.join(' | ') }
}

export function wrapDbError(fallbackMessage: string, cause: unknown): ClassifiedDbError {
  const { code, message } = extractPgErrorMetadata(cause)
  const lower = message.toLowerCase()
  const diag = getPostgresConnectionDiagnostics()

  let userMessage = fallbackMessage
  let errorCode = 'DB_QUERY_FAILED'
  let httpStatus = 500

  if (code === 'ENOENT' || lower.includes('enoent')) {
    errorCode = 'DB_SOCKET_NOT_FOUND'
    httpStatus = 503
    userMessage = `Không tìm thấy Unix socket Cloud SQL PostgreSQL (${diag.configuredHostLabel}). Kiểm tra cấu hình SQL_HOST và instance Cloud SQL đang gắn với ứng dụng.`
  } else if (
    lower.includes('connection terminated unexpectedly') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE'
  ) {
    errorCode = 'DB_CONNECTION_TERMINATED'
    httpStatus = 503
    userMessage =
      'Kết nối tới Cloud SQL PostgreSQL bị ngắt đột ngột. Kiểm tra quyền IAM cloudsql.instances.connect của Service Account và trạng thái Cloud SQL Proxy.'
  } else if (
    code === 'ETIMEDOUT' ||
    lower.includes('timeout') ||
    lower.includes('timed out')
  ) {
    errorCode = 'DB_TIMEOUT'
    httpStatus = 503
    userMessage = 'Hết thời gian chờ kết nối tới cơ sở dữ liệu PostgreSQL. Vui lòng thử lại sau.'
  } else if (code === '42P01') {
    errorCode = 'DB_TABLE_MISSING'
    httpStatus = 500
    userMessage =
      'Bảng lưu kết quả học sinh (exam_attempts) chưa tồn tại trong cơ sở dữ liệu PostgreSQL hiện tại.'
  } else if (code === '42703') {
    errorCode = 'DB_COLUMN_MISSING'
    httpStatus = 500
    userMessage =
      'Cấu trúc cột của bảng exam_attempts trong PostgreSQL chưa đồng bộ với phiên bản mã nguồn.'
  } else if (code === '42501') {
    errorCode = 'DB_PERMISSION_DENIED'
    httpStatus = 500
    userMessage =
      'Tài khoản cơ sở dữ liệu không đủ quyền truy vấn bảng exam_attempts (kiểm tra quyền GRANT hoặc chính sách RLS trên PostgreSQL).'
  } else if (code === '28P01' || code === '28000') {
    errorCode = 'DB_AUTH_FAILED'
    httpStatus = 503
    userMessage =
      'Xác thực kết nối PostgreSQL thất bại. Kiểm tra biến môi trường SQL_USER và SQL_PASSWORD.'
  } else if (code === '3D000') {
    errorCode = 'DB_DATABASE_NOT_FOUND'
    httpStatus = 503
    userMessage = `Cơ sở dữ liệu PostgreSQL "${diag.databaseName}" không tồn tại trên máy chủ Cloud SQL.`
  }

  const err = new Error(userMessage) as ClassifiedDbError
  err.code = errorCode
  err.httpStatus = httpStatus
  err.cause = cause
  return err
}

function roundScore(val: number): number {
  return Math.round(val * 100) / 100
}

function toIsoStringSafe(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

function parseDetailedAnswersSafe(raw: unknown): AttemptDetailedAnswer[] {
  if (Array.isArray(raw)) return raw as AttemptDetailedAnswer[]
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as AttemptDetailedAnswer[]) : []
    } catch {
      return []
    }
  }
  return []
}

function computeDurationSeconds(startedAtIso: string, submittedAtIso: string | null): number | null {
  if (!submittedAtIso) return null
  const startMs = new Date(startedAtIso).getTime()
  const endMs = new Date(submittedAtIso).getTime()
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    return null
  }
  return Math.round((endMs - startMs) / 1000)
}

export function serializeAttemptRow(
  row: typeof examAttempts.$inferSelect
): StudentAttemptRecord {
  const statusRaw = row.completionStatus
  const completionStatus: AttemptCompletionStatus =
    statusRaw === 'auto_graded' ||
    statusRaw === 'needs_review' ||
    statusRaw === 'reviewed'
      ? statusRaw
      : 'in_progress'

  const startedAtIso =
    toIsoStringSafe(row.startedAt) ??
    toIsoStringSafe(row.createdAt) ??
    new Date(0).toISOString()
  const submittedAtIso = toIsoStringSafe(row.submittedAt)

  return {
    id: row.id,
    attemptId: row.attemptId,
    examId: row.examId ?? '',
    examTitle: row.examTitle ?? '',
    examKind: row.examKind === 'published' ? 'published' : 'practice',
    accessCode: row.accessCode ?? '',
    studentName: row.studentName ?? '',
    studentNameNormalized: row.studentNameNormalized ?? '',
    className: row.className ?? '',
    rawClassName: row.rawClassName ?? row.className ?? '',
    startedAt: startedAtIso,
    submittedAt: submittedAtIso,
    durationSeconds: computeDurationSeconds(startedAtIso, submittedAtIso),
    completionStatus,
    scoringMode: row.scoringMode ?? 'practice_10',
    part1Score: Number(row.part1Score ?? 0),
    part1Max: Number(row.part1Max ?? 0),
    part2Score: Number(row.part2Score ?? 0),
    part2Max: Number(row.part2Max ?? 0),
    part3Score: row.part3Score !== null && row.part3Score !== undefined ? Number(row.part3Score) : null,
    part3Max: Number(row.part3Max ?? 0),
    score: row.score !== null && row.score !== undefined ? Number(row.score) : null,
    maxScore: Number(row.maxScore ?? 10),
    detailedAnswers: parseDetailedAnswersSafe(row.detailedAnswers),
    adminFeedback: row.adminFeedback || '',
    reviewedByEmail: row.reviewedByEmail ?? null,
    reviewedAt: toIsoStringSafe(row.reviewedAt),
  }
}

export async function createExamAttemptRecord(params: {
  examId: string
  examTitle: string
  examKind: ExamAttemptKind
  accessCode?: string
  studentName: string
  studentNameNormalized: string
  className: string
  rawClassName: string
  maxScore: number
  scoringMode: string
}): Promise<StudentAttemptRecord> {
  const now = new Date()
  try {
    const [inserted] = await db
      .insert(examAttempts)
      .values({
        examId: params.examId,
        examTitle: params.examTitle,
        examKind: params.examKind,
        accessCode: params.accessCode ?? '',
        studentName: params.studentName,
        studentNameNormalized: params.studentNameNormalized,
        className: params.className,
        rawClassName: params.rawClassName,
        startedAt: now,
        submittedAt: null,
        completionStatus: 'in_progress',
        scoringMode: params.scoringMode,
        part1Score: 0,
        part1Max: 0,
        part2Score: 0,
        part2Max: 0,
        part3Score: null,
        part3Max: 0,
        score: null,
        maxScore: params.maxScore,
        detailedAnswers: [],
        adminFeedback: '',
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    return serializeAttemptRow(inserted)
  } catch (error) {
    console.error('[TIN LAB] Failed to create exam attempt:', error)
    throw wrapDbError('Không thể khởi tạo phiên làm bài trong cơ sở dữ liệu.', error)
  }
}

export async function getExamAttemptByAttemptId(
  attemptId: string
): Promise<StudentAttemptRecord | null> {
  try {
    const rows = await db
      .select()
      .from(examAttempts)
      .where(eq(examAttempts.attemptId, attemptId))
      .limit(1)
    return rows[0] ? serializeAttemptRow(rows[0]) : null
  } catch (error) {
    console.error('[TIN LAB] Failed to fetch attempt by attemptId:', error)
    throw wrapDbError('Không thể truy vấn thông tin lượt làm bài.', error)
  }
}

export async function completeExamAttemptRecord(params: {
  attemptId: string
  examId: string
  scoringMode: string
  part1Score: number
  part1Max: number
  part2Score: number
  part2Max: number
  part3Score: number | null
  part3Max: number
  score: number | null
  maxScore: number
  completionStatus: 'auto_graded' | 'needs_review'
  detailedAnswers: AttemptDetailedAnswer[]
}): Promise<StudentAttemptRecord> {
  const now = new Date()
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(examAttempts)
        .where(eq(examAttempts.attemptId, params.attemptId))
        .limit(1)
      const existing = rows[0] ?? null

      if (!existing) {
        throw new Error('ATTEMPT_NOT_FOUND')
      }
      if (existing.examId !== params.examId) {
        throw new Error('EXAM_MISMATCH')
      }
      if (existing.completionStatus !== 'in_progress') {
        throw new Error('ATTEMPT_ALREADY_SUBMITTED')
      }

      const [updated] = await tx
        .update(examAttempts)
        .set({
          submittedAt: now,
          completionStatus: params.completionStatus,
          scoringMode: params.scoringMode,
          part1Score: params.part1Score,
          part1Max: params.part1Max,
          part2Score: params.part2Score,
          part2Max: params.part2Max,
          part3Score: params.part3Score,
          part3Max: params.part3Max,
          score: params.score,
          maxScore: params.maxScore,
          detailedAnswers: params.detailedAnswers,
          updatedAt: now,
        })
        .where(eq(examAttempts.id, existing.id))
        .returning()

      return serializeAttemptRow(updated)
    })
  } catch (error) {
    if (
      error instanceof Error &&
      ['ATTEMPT_NOT_FOUND', 'EXAM_MISMATCH', 'ATTEMPT_ALREADY_SUBMITTED'].includes(
        error.message
      )
    ) {
      throw error
    }
    console.error('[TIN LAB] Failed to complete exam attempt:', error)
    throw wrapDbError('Không thể lưu kết quả bài làm vào PostgreSQL.', error)
  }
}

export interface StudentResultsFilterInput {
  q?: string
  className?: string
  examId?: string
  status?: string
  dateFrom?: string
  dateTo?: string
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function buildAdminAttemptsWhereClause(filters: StudentResultsFilterInput = {}) {
  const conditions = []

  const qTrim = (filters.q ?? '').trim()
  if (qTrim) {
    const pattern = `%${qTrim}%`
    const normalizedPattern = `%${qTrim.toLowerCase()}%`
    conditions.push(
      or(
        ilike(examAttempts.studentName, pattern),
        ilike(examAttempts.studentNameNormalized, normalizedPattern),
        ilike(examAttempts.className, pattern),
        ilike(examAttempts.rawClassName, pattern),
        ilike(examAttempts.examTitle, pattern),
        sql`CAST(${examAttempts.attemptId} AS TEXT) ILIKE ${pattern}`
      )
    )
  }

  const classFilter = filters.className ? normalizeClassName(filters.className) : ''
  if (classFilter && classFilter !== 'ALL') {
    conditions.push(eq(examAttempts.className, classFilter))
  }

  const examFilter = (filters.examId ?? '').trim()
  if (examFilter && examFilter !== 'ALL') {
    conditions.push(eq(examAttempts.examId, examFilter))
  }

  const statusFilter = (filters.status ?? '').trim()
  if (
    statusFilter === 'in_progress' ||
    statusFilter === 'auto_graded' ||
    statusFilter === 'needs_review' ||
    statusFilter === 'reviewed'
  ) {
    conditions.push(eq(examAttempts.completionStatus, statusFilter))
  }

  if (filters.dateFrom && ISO_DATE_RE.test(filters.dateFrom.trim())) {
    const fromDate = new Date(`${filters.dateFrom.trim()}T00:00:00.000+07:00`)
    if (!Number.isNaN(fromDate.getTime())) {
      conditions.push(gte(examAttempts.startedAt, fromDate))
    }
  }

  if (filters.dateTo && ISO_DATE_RE.test(filters.dateTo.trim())) {
    const toDate = new Date(`${filters.dateTo.trim()}T23:59:59.999+07:00`)
    if (!Number.isNaN(toDate.getTime())) {
      conditions.push(lte(examAttempts.startedAt, toDate))
    }
  }

  return conditions.length > 0 ? and(...conditions) : undefined
}

export async function listExamAttemptsForAdmin(
  filters: StudentResultsFilterInput = {}
): Promise<AdminStudentResultsResponse> {
  try {
    const whereClause = buildAdminAttemptsWhereClause(filters)

    const [filteredRows, metaRows] = await Promise.all([
      db
        .select()
        .from(examAttempts)
        .where(whereClause)
        .orderBy(desc(examAttempts.startedAt)),
      db
        .selectDistinct({
          className: examAttempts.className,
          examId: examAttempts.examId,
          examTitle: examAttempts.examTitle,
          examKind: examAttempts.examKind,
        })
        .from(examAttempts),
    ])

    const attempts = filteredRows.map(serializeAttemptRow)

    // Compute class-level performance stats
    const classMap = new Map<
      string,
      {
        attemptCount: number
        scores: number[]
        studentKeys: Set<string>
      }
    >()

    // Compute exam-level performance stats
    const examMap = new Map<
      string,
      {
        examTitle: string
        examKind: ExamAttemptKind
        attemptCount: number
        scores: number[]
        maxScore: number
      }
    >()

    // Compute per-student learning progress explicitly keyed by (normalized name + normalized class)
    const progressMap = new Map<
      string,
      {
        studentName: string
        className: string
        records: StudentAttemptRecord[]
      }
    >()

    for (const att of attempts) {
      // Class stats
      let cEntry = classMap.get(att.className)
      if (!cEntry) {
        cEntry = { attemptCount: 0, scores: [], studentKeys: new Set() }
        classMap.set(att.className, cEntry)
      }
      cEntry.attemptCount += 1
      cEntry.studentKeys.add(att.studentNameNormalized)
      if (att.score !== null) {
        cEntry.scores.push(att.score)
      }

      // Exam stats
      let eEntry = examMap.get(att.examId)
      if (!eEntry) {
        eEntry = {
          examTitle: att.examTitle,
          examKind: att.examKind,
          attemptCount: 0,
          scores: [],
          maxScore: att.maxScore,
        }
        examMap.set(att.examId, eEntry)
      }
      eEntry.attemptCount += 1
      if (att.score !== null) {
        eEntry.scores.push(att.score)
      }

      // Learning progress across multiple attempts (exact name + class scope only)
      const identityKey = `${att.studentNameNormalized}::${att.className}`
      let pEntry = progressMap.get(identityKey)
      if (!pEntry) {
        pEntry = {
          studentName: att.studentName,
          className: att.className,
          records: [],
        }
        progressMap.set(identityKey, pEntry)
      }
      pEntry.records.push(att)
    }

    const classStats: ClassPerformanceStat[] = Array.from(classMap.entries())
      .map(([className, data]) => {
        const gradedCount = data.scores.length
        const avg =
          gradedCount > 0
            ? roundScore(data.scores.reduce((a, b) => a + b, 0) / gradedCount)
            : null
        return {
          className,
          attemptCount: data.attemptCount,
          gradedCount,
          studentIdentityCount: data.studentKeys.size,
          averageScore: avg,
          minScore: gradedCount > 0 ? Math.min(...data.scores) : null,
          maxScore: gradedCount > 0 ? Math.max(...data.scores) : null,
        }
      })
      .sort((a, b) => a.className.localeCompare(b.className, 'vi'))

    const examStats: ExamPerformanceStat[] = Array.from(examMap.entries())
      .map(([examId, data]) => {
        const gradedCount = data.scores.length
        const avg =
          gradedCount > 0
            ? roundScore(data.scores.reduce((a, b) => a + b, 0) / gradedCount)
            : null
        return {
          examId,
          examTitle: data.examTitle,
          examKind: data.examKind,
          attemptCount: data.attemptCount,
          gradedCount,
          averageScore: avg,
          maxScore: data.maxScore,
        }
      })
      .sort((a, b) => b.attemptCount - a.attemptCount)

    const studentProgress: StudentProgressSummary[] = Array.from(progressMap.entries())
      .map(([identityKey, data]) => {
        const chronological = [...data.records].sort(
          (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
        )
        const graded = chronological.filter((r) => r.score !== null)
        const gradedScores = graded.map((r) => r.score as number)
        const firstScore = gradedScores.length > 0 ? gradedScores[0] : null
        const latestScore =
          gradedScores.length > 0 ? gradedScores[gradedScores.length - 1] : null
        const bestScore = gradedScores.length > 0 ? Math.max(...gradedScores) : null
        const averageScore =
          gradedScores.length > 0
            ? roundScore(gradedScores.reduce((a, b) => a + b, 0) / gradedScores.length)
            : null
        const scoreDelta =
          gradedScores.length >= 2 && firstScore !== null && latestScore !== null
            ? roundScore(latestScore - firstScore)
            : null

        return {
          identityKey,
          studentName: data.studentName,
          className: data.className,
          attemptCount: chronological.length,
          gradedCount: graded.length,
          latestScore,
          bestScore,
          averageScore,
          firstScore,
          scoreDelta,
          attempts: chronological.map((r) => ({
            attemptId: r.attemptId,
            examTitle: r.examTitle,
            score: r.score,
            maxScore: r.maxScore,
            submittedAt: r.submittedAt,
            startedAt: r.startedAt,
            completionStatus: r.completionStatus,
          })),
        }
      })
      .sort((a, b) => {
        if (b.attemptCount !== a.attemptCount) return b.attemptCount - a.attemptCount
        return a.className.localeCompare(b.className, 'vi')
      })

    const classSet = new Set<string>()
    const examOptionMap = new Map<
      string,
      { examId: string; examTitle: string; examKind: ExamAttemptKind }
    >()
    for (const m of metaRows) {
      if (m.className) classSet.add(m.className)
      if (m.examId && !examOptionMap.has(m.examId)) {
        examOptionMap.set(m.examId, {
          examId: m.examId,
          examTitle: m.examTitle,
          examKind: m.examKind === 'published' ? 'published' : 'practice',
        })
      }
    }

    return {
      ok: true,
      attempts,
      totalCount: attempts.length,
      classStats,
      examStats,
      studentProgress,
      availableClasses: Array.from(classSet).sort((a, b) => a.localeCompare(b, 'vi')),
      availableExams: Array.from(examOptionMap.values()).sort((a, b) =>
        a.examTitle.localeCompare(b.examTitle, 'vi')
      ),
    }
  } catch (error) {
    console.error('[TIN LAB] Failed to query student results for admin:', error)
    throw wrapDbError('Không thể truy vấn danh sách kết quả học sinh từ PostgreSQL.', error)
  }
}

export async function reviewExamAttemptAsAdmin(params: {
  attemptId: string
  reviewerEmail: string
  essayScores: Record<string, { score: number; comment: string }>
  adminFeedback: string
}): Promise<StudentAttemptRecord> {
  const now = new Date()
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(examAttempts)
        .where(eq(examAttempts.attemptId, params.attemptId))
        .limit(1)
      const existing = rows[0] ?? null
      if (!existing) {
        throw new Error('ATTEMPT_NOT_FOUND')
      }

      const currentAnswers = Array.isArray(existing.detailedAnswers)
        ? existing.detailedAnswers
        : []

      let nextPart3Score = 0
      const updatedAnswers: AttemptDetailedAnswer[] = currentAnswers.map((ans) => {
        if (ans.questionType !== 'essay') {
          return ans
        }
        const override = params.essayScores[ans.questionId]
        const rawScore =
          override && Number.isFinite(override.score)
            ? override.score
            : ans.adminScore ?? ans.earnedPoints ?? ans.aiSuggestedScore ?? 0
        const clampedScore = roundScore(Math.max(0, Math.min(ans.maxPoints, rawScore)))
        nextPart3Score = roundScore(nextPart3Score + clampedScore)

        return {
          ...ans,
          earnedPoints: clampedScore,
          adminScore: clampedScore,
          adminComment:
            override?.comment !== undefined
              ? override.comment.trim().slice(0, 1000)
              : ans.adminComment || '',
          needsAdminReview: false,
        }
      })

      const clampedPart3 = roundScore(
        Math.min(Number(existing.part3Max ?? 0), nextPart3Score)
      )
      const totalScore = roundScore(
        Math.min(
          Number(existing.maxScore ?? 10),
          Number(existing.part1Score ?? 0) + Number(existing.part2Score ?? 0) + clampedPart3
        )
      )

      const [updated] = await tx
        .update(examAttempts)
        .set({
          part3Score: clampedPart3,
          score: totalScore,
          completionStatus: 'reviewed',
          detailedAnswers: updatedAnswers,
          adminFeedback: params.adminFeedback.trim().slice(0, 2000),
          reviewedByEmail: params.reviewerEmail,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(eq(examAttempts.id, existing.id))
        .returning()

      return serializeAttemptRow(updated)
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'ATTEMPT_NOT_FOUND') {
      throw error
    }
    console.error('[TIN LAB] Failed to review exam attempt:', error)
    throw wrapDbError('Không thể cập nhật điểm duyệt bài làm trong PostgreSQL.', error)
  }
}
