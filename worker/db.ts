import { Pool } from '@neondatabase/serverless'
import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless'
import { and, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm'
import * as schema from '../src/db/schema.ts'
import {
  examAttempts,
  questionImportDrafts,
  teacherDocuments,
  users,
} from '../src/db/schema.ts'
import { normalizeClassName } from '../src/lib/studentValidation.ts'
import type { WorkerEnv } from './env.ts'
import type {
  AdminStudentResultsResponse,
  AttemptCompletionStatus,
  AttemptDetailedAnswer,
  ClassPerformanceStat,
  ExamAttemptKind,
  ExamPerformanceStat,
  ExtractedQuestion,
  RealDashboardMetricsResponse,
  RealExamStatsItem,
  RealTopicDistributionItem,
  StudentAttemptRecord,
  StudentProgressSummary,
} from '../src/types.ts'

type WorkerNeonDb = NeonDatabase<typeof schema>

const NEON_CONNECT_TIMEOUT_MS = 8000

export class WorkerDbError extends Error {
  code: string
  httpStatus: number

  constructor(message: string, code: string, httpStatus = 500) {
    super(message)
    this.name = 'WorkerDbError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

function extractPgErrorInfo(cause: unknown): { code: string; message: string } {
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

export function classifyNeonDbError(
  fallbackMessage: string,
  cause: unknown
): WorkerDbError {
  if (cause instanceof WorkerDbError) return cause

  const { code, message } = extractPgErrorInfo(cause)
  const lower = message.toLowerCase()

  if (code === '42P01') {
    return new WorkerDbError(
      'Bảng exam_attempts chưa tồn tại trên Neon PostgreSQL. Vui lòng chạy migration migrations/0001_neon_core_schema.sql.',
      'DB_TABLE_MISSING',
      500
    )
  }
  if (code === '42703') {
    return new WorkerDbError(
      'Cấu trúc cột của bảng exam_attempts trên PostgreSQL chưa đồng bộ với mã nguồn.',
      'DB_COLUMN_MISSING',
      500
    )
  }
  if (code === '42501') {
    return new WorkerDbError(
      'Tài khoản Neon PostgreSQL không đủ quyền truy cập bảng exam_attempts.',
      'DB_PERMISSION_DENIED',
      500
    )
  }
  if (
    code === '28P01' ||
    code === '28000' ||
    lower.includes('password authentication failed')
  ) {
    return new WorkerDbError(
      'Xác thực Neon PostgreSQL thất bại. Vui lòng kiểm tra Worker Secret DATABASE_URL.',
      'DB_AUTH_FAILED',
      503
    )
  }
  if (
    lower.includes('fetch failed') ||
    lower.includes('websocket') ||
    lower.includes('socket') ||
    lower.includes('econnrefused') ||
    lower.includes('connection terminated') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('enotfound') ||
    lower.includes('connect') ||
    lower.includes('dns') ||
    lower.includes('closed')
  ) {
    return new WorkerDbError(
      'Không thể kết nối tới Neon PostgreSQL. Vui lòng kiểm tra DATABASE_URL và trạng thái dự án Neon.',
      'DB_CONNECTION_FAILED',
      503
    )
  }

  return new WorkerDbError(fallbackMessage, 'DB_QUERY_FAILED', 500)
}

/**
 * Creates a per-request Neon Serverless WebSocket Pool supporting full PostgreSQL
 * interactive ACID transactions (`BEGIN` / `SELECT ... FOR UPDATE` / `COMMIT`),
 * enforces a strict connection timeout, and always closes cleanly in `finally`.
 */
export async function withNeonDb<T>(
  env: WorkerEnv,
  fn: (db: WorkerNeonDb) => Promise<T>,
  maxConnections = 1
): Promise<T> {
  const databaseUrl = env.DATABASE_URL?.trim() ?? ''
  if (!databaseUrl) {
    throw new WorkerDbError(
      'Máy chủ Worker chưa cấu hình Worker Secret DATABASE_URL cho Neon PostgreSQL.',
      'DATABASE_URL_MISSING',
      503
    )
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: maxConnections,
    connectionTimeoutMillis: NEON_CONNECT_TIMEOUT_MS,
  })
  const db = drizzle(pool, { schema })

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const workPromise = fn(db)
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new WorkerDbError(
            'Kết nối tới Neon PostgreSQL quá thời gian chờ. Vui lòng thử lại sau giây lát.',
            'DB_CONNECTION_FAILED',
            503
          )
        )
      }, NEON_CONNECT_TIMEOUT_MS + 4000)
    })

    return await Promise.race([workPromise, timeoutPromise])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    await pool.end().catch(() => undefined)
  }
}

export async function pingNeonDatabase(env: WorkerEnv): Promise<{
  configured: boolean
  connected: boolean
  latencyMs: number | null
  errorCode: string | null
  errorMessage: string | null
}> {
  const databaseUrl = env.DATABASE_URL?.trim() ?? ''
  if (!databaseUrl) {
    return {
      configured: false,
      connected: false,
      latencyMs: null,
      errorCode: 'DATABASE_URL_MISSING',
      errorMessage: 'Chưa cấu hình Worker Secret DATABASE_URL cho Neon PostgreSQL.',
    }
  }

  const started = Date.now()
  try {
    await withNeonDb(env, async (db) => {
      await db.execute(sql`SELECT 1 AS ok`)
    })
    return {
      configured: true,
      connected: true,
      latencyMs: Date.now() - started,
      errorCode: null,
      errorMessage: null,
    }
  } catch (err) {
    const classified = classifyNeonDbError(
      'Không thể kết nối tới Neon PostgreSQL.',
      err
    )
    return {
      configured: true,
      connected: false,
      latencyMs: Date.now() - started,
      errorCode: classified.code,
      errorMessage: classified.message,
    }
  }
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

function computeDurationSeconds(
  startedAtIso: string,
  submittedAtIso: string | null
): number | null {
  if (!submittedAtIso) return null
  const startMs = new Date(startedAtIso).getTime()
  const endMs = new Date(submittedAtIso).getTime()
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    return null
  }
  return Math.round((endMs - startMs) / 1000)
}

export function serializeAttemptRowWorker(
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
    scoringMode: row.scoringMode ?? 'tiered_2025',
    part1Score: Number(row.part1Score ?? 0),
    part1Max: Number(row.part1Max ?? 0),
    part2Score: Number(row.part2Score ?? 0),
    part2Max: Number(row.part2Max ?? 0),
    part3Score:
      row.part3Score !== null && row.part3Score !== undefined
        ? Number(row.part3Score)
        : null,
    part3Max: Number(row.part3Max ?? 0),
    score:
      row.score !== null && row.score !== undefined ? Number(row.score) : null,
    maxScore: Number(row.maxScore ?? 10),
    detailedAnswers: parseDetailedAnswersSafe(row.detailedAnswers),
    adminFeedback: row.adminFeedback || '',
    reviewedByEmail: row.reviewedByEmail ?? null,
    reviewedAt: toIsoStringSafe(row.reviewedAt),
  }
}

export async function createExamAttemptInWorker(
  env: WorkerEnv,
  params: {
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
  }
): Promise<StudentAttemptRecord> {
  const now = new Date()
  const attemptId = crypto.randomUUID()

  try {
    return await withNeonDb(env, async (db) => {
      const [inserted] = await db
        .insert(examAttempts)
        .values({
          attemptId,
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

      return serializeAttemptRowWorker(inserted)
    })
  } catch (err) {
    throw classifyNeonDbError(
      'Không thể khởi tạo phiên làm bài trong Neon PostgreSQL.',
      err
    )
  }
}

export async function getExamAttemptByAttemptIdWorker(
  env: WorkerEnv,
  attemptId: string
): Promise<StudentAttemptRecord | null> {
  try {
    return await withNeonDb(env, async (db) => {
      const rows = await db
        .select()
        .from(examAttempts)
        .where(eq(examAttempts.attemptId, attemptId))
        .limit(1)
      return rows[0] ? serializeAttemptRowWorker(rows[0]) : null
    })
  } catch (err) {
    throw classifyNeonDbError(
      'Không thể truy vấn thông tin lượt làm bài từ Neon PostgreSQL.',
      err
    )
  }
}

export interface ComputedAttemptSubmission {
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
}

/**
 * Executes student exam submission inside a real PostgreSQL ACID transaction
 * (`BEGIN` -> `SELECT ... FOR UPDATE` -> pure server grading -> `UPDATE ... RETURNING *` -> `COMMIT`).
 * Uses a single Neon WebSocket connection and strictly prevents race-condition duplicate submissions.
 */
export async function submitAndCompleteAttemptTransactionWorker<TExtra>(
  env: WorkerEnv,
  params: {
    attemptId: string
    examId: string
    computeSubmission: (existing: StudentAttemptRecord) => Promise<{
      submission: ComputedAttemptSubmission
      extra: TExtra
    }>
  }
): Promise<{ saved: StudentAttemptRecord; extra: TExtra }> {
  const now = new Date()

  try {
    return await withNeonDb(env, async (db) => {
      return await db.transaction(async (tx) => {
        const lockedRows = await tx
          .select()
          .from(examAttempts)
          .where(eq(examAttempts.attemptId, params.attemptId))
          .for('update')
          .limit(1)

        const locked = lockedRows[0] ?? null
        if (!locked) {
          throw new WorkerDbError(
            'Không tìm thấy phiên làm bài hợp lệ.',
            'ATTEMPT_NOT_FOUND',
            404
          )
        }
        if (locked.examId !== params.examId) {
          throw new WorkerDbError(
            'Mã đề thi không khớp với phiên làm bài.',
            'EXAM_MISMATCH',
            400
          )
        }
        if (locked.completionStatus !== 'in_progress') {
          throw new WorkerDbError(
            'Phiên làm bài này đã được nộp và ghi nhận kết quả trước đó.',
            'ATTEMPT_ALREADY_SUBMITTED',
            409
          )
        }

        const existingSerialized = serializeAttemptRowWorker(locked)
        const { submission, extra } = await params.computeSubmission(existingSerialized)

        const [updated] = await tx
          .update(examAttempts)
          .set({
            submittedAt: now,
            completionStatus: submission.completionStatus,
            scoringMode: submission.scoringMode,
            part1Score: submission.part1Score,
            part1Max: submission.part1Max,
            part2Score: submission.part2Score,
            part2Max: submission.part2Max,
            part3Score: submission.part3Score,
            part3Max: submission.part3Max,
            score: submission.score,
            maxScore: submission.maxScore,
            detailedAnswers: submission.detailedAnswers,
            updatedAt: now,
          })
          .where(eq(examAttempts.id, locked.id))
          .returning()

        return {
          saved: serializeAttemptRowWorker(updated),
          extra,
        }
      })
    })
  } catch (err) {
    if (err instanceof WorkerDbError) throw err
    throw classifyNeonDbError(
      'Không thể lưu kết quả bài làm vào Neon PostgreSQL.',
      err
    )
  }
}

export interface WorkerResultsFilters {
  q?: string
  className?: string
  examId?: string
  status?: string
  dateFrom?: string
  dateTo?: string
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function buildAdminWhereClause(filters: WorkerResultsFilters = {}) {
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

export async function listExamAttemptsForAdminWorker(
  env: WorkerEnv,
  filters: WorkerResultsFilters = {}
): Promise<AdminStudentResultsResponse> {
  try {
    const { filteredRows, metaRows } = await withNeonDb(
      env,
      async (db) => {
        const whereClause = buildAdminWhereClause(filters)
        const [rows, meta] = await Promise.all([
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
        return { filteredRows: rows, metaRows: meta }
      },
      2
    )

    const attempts = filteredRows.map(serializeAttemptRowWorker)

    const classMap = new Map<
      string,
      { attemptCount: number; scores: number[]; studentKeys: Set<string> }
    >()
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
    const progressMap = new Map<
      string,
      { studentName: string; className: string; records: StudentAttemptRecord[] }
    >()

    for (const att of attempts) {
      let cEntry = classMap.get(att.className)
      if (!cEntry) {
        cEntry = { attemptCount: 0, scores: [], studentKeys: new Set() }
        classMap.set(att.className, cEntry)
      }
      cEntry.attemptCount += 1
      cEntry.studentKeys.add(att.studentNameNormalized)
      if (att.score !== null) cEntry.scores.push(att.score)

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
      if (att.score !== null) eEntry.scores.push(att.score)

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

    const studentProgress: StudentProgressSummary[] = Array.from(
      progressMap.entries()
    )
      .map(([identityKey, data]) => {
        const chronological = [...data.records].sort(
          (a, b) =>
            new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
        )
        const graded = chronological.filter((r) => r.score !== null)
        const gradedScores = graded.map((r) => r.score as number)
        const firstScore = gradedScores.length > 0 ? gradedScores[0] : null
        const latestScore =
          gradedScores.length > 0 ? gradedScores[gradedScores.length - 1] : null
        const bestScore =
          gradedScores.length > 0 ? Math.max(...gradedScores) : null
        const averageScore =
          gradedScores.length > 0
            ? roundScore(
                gradedScores.reduce((a, b) => a + b, 0) / gradedScores.length
              )
            : null
        const scoreDelta =
          gradedScores.length >= 2 &&
          firstScore !== null &&
          latestScore !== null
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
        if (b.attemptCount !== a.attemptCount)
          return b.attemptCount - a.attemptCount
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
      availableClasses: Array.from(classSet).sort((a, b) =>
        a.localeCompare(b, 'vi')
      ),
      availableExams: Array.from(examOptionMap.values()).sort((a, b) =>
        a.examTitle.localeCompare(b.examTitle, 'vi')
      ),
    }
  } catch (err) {
    throw classifyNeonDbError(
      'Không thể truy vấn danh sách kết quả học sinh từ Neon PostgreSQL.',
      err
    )
  }
}

/**
 * Updates essay scores & admin feedback atomically inside a PostgreSQL transaction
 * using `SELECT ... FOR UPDATE` so concurrent Super Admin reviews cannot overwrite each other.
 */
export async function reviewExamAttemptAsAdminWorker(
  env: WorkerEnv,
  params: {
    attemptId: string
    reviewerEmail: string
    essayScores: Record<string, { score: number; comment: string }>
    adminFeedback: string
  }
): Promise<StudentAttemptRecord> {
  const now = new Date()

  try {
    return await withNeonDb(env, async (db) => {
      return await db.transaction(async (tx) => {
        const existingRows = await tx
          .select()
          .from(examAttempts)
          .where(eq(examAttempts.attemptId, params.attemptId))
          .for('update')
          .limit(1)
        const existing = existingRows[0] ?? null

        if (!existing) {
          throw new WorkerDbError(
            'Không tìm thấy bài thi của học sinh.',
            'ATTEMPT_NOT_FOUND',
            404
          )
        }

        const currentAnswers = parseDetailedAnswersSafe(existing.detailedAnswers)
        let nextPart3Score = 0
        const updatedAnswers: AttemptDetailedAnswer[] = currentAnswers.map(
          (ans) => {
            if (ans.questionType !== 'essay') return ans
            const override = params.essayScores[ans.questionId]
            const rawScore =
              override && Number.isFinite(override.score)
                ? override.score
                : ans.adminScore ?? ans.earnedPoints ?? ans.aiSuggestedScore ?? 0
            const clampedScore = roundScore(
              Math.max(0, Math.min(ans.maxPoints, rawScore))
            )
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
          }
        )

        const clampedPart3 = roundScore(
          Math.min(Number(existing.part3Max ?? 0), nextPart3Score)
        )
        const totalScore = roundScore(
          Math.min(
            Number(existing.maxScore ?? 10),
            Number(existing.part1Score ?? 0) +
              Number(existing.part2Score ?? 0) +
              clampedPart3
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

        return serializeAttemptRowWorker(updated)
      })
    })
  } catch (err) {
    if (err instanceof WorkerDbError) throw err
    throw classifyNeonDbError(
      'Không thể cập nhật điểm duyệt bài làm trong Neon PostgreSQL.',
      err
    )
  }
}

export async function bestEffortSyncSuperAdminUserWorker(
  env: WorkerEnv,
  params: {
    uid: string
    email: string
    displayName: string
    emailVerified: boolean
    permissions: string[]
  }
): Promise<'synced' | 'allowlist_only'> {
  if (!env.DATABASE_URL?.trim()) return 'allowlist_only'
  try {
    await withNeonDb(env, async (db) => {
      const now = new Date()
      await db
        .insert(users)
        .values({
          uid: params.uid,
          email: params.email,
          displayName: params.displayName,
          role: 'super_admin',
          roleSource: 'worker_super_admin_allowlist_db_synced',
          status: 'active',
          permissions: params.permissions,
          emailVerified: params.emailVerified,
          lastLoginAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: users.uid,
          set: {
            email: params.email,
            displayName: params.displayName,
            role: 'super_admin',
            roleSource: 'worker_super_admin_allowlist_db_synced',
            status: 'active',
            permissions: params.permissions,
            emailVerified: params.emailVerified,
            lastLoginAt: now,
            updatedAt: now,
          },
        })
    })
    return 'synced'
  } catch {
    return 'allowlist_only'
  }
}

function isExtractedQuestionException(q: ExtractedQuestion): boolean {
  if (q.skippedInImport) return false
  if (q.duplicateInFile || q.duplicateInBank) return true
  if (q.answerStatus !== 'verified') return true
  if (q.questionType === 'multiple_choice') {
    if (!q.answerKey || !['A', 'B', 'C', 'D'].includes(q.answerKey)) return true
  } else if (q.questionType === 'true_false') {
    if (
      q.statementAnswerA === null ||
      q.statementAnswerB === null ||
      q.statementAnswerC === null ||
      q.statementAnswerD === null
    ) {
      return true
    }
  } else if (q.questionType === 'essay') {
    if (!q.rubric || q.rubric.trim().length < 5) return true
  }
  return false
}

export async function getWorkerDashboardMetrics(
  env: WorkerEnv
): Promise<RealDashboardMetricsResponse> {
  let postgresAvailable = true
  let postgresErrorCode: string | null = null
  let postgresNotice: string | null = null

  let uploadedDocumentsCount = 0
  let draftBatchesCount = 0
  let extractedQuestionsCount = 0
  let draftQuestionsCount = 0
  let exceptionQuestionsCount = 0
  let readyDraftQuestionsCount = 0
  let committedDraftQuestionsCount = 0

  let studentAttemptsTotal = 0
  let studentAttemptsCompleted = 0
  let studentAttemptsInProgress = 0
  let studentAttemptsGraded = 0
  let studentAttemptsNeedsReview = 0
  let averageScore: number | null = null
  let completionRate: number | null = null

  const topicMap = new Map<string, RealTopicDistributionItem>()
  const examPerformance: RealExamStatsItem[] = []

  try {
    await withNeonDb(
      env,
      async (db) => {
        const attemptRows = await db
          .select({
            examId: examAttempts.examId,
            examTitle: examAttempts.examTitle,
            examKind: examAttempts.examKind,
            startedAt: examAttempts.startedAt,
            submittedAt: examAttempts.submittedAt,
            completionStatus: examAttempts.completionStatus,
            score: examAttempts.score,
            maxScore: examAttempts.maxScore,
          })
          .from(examAttempts)
          .orderBy(desc(examAttempts.startedAt))

        studentAttemptsTotal = attemptRows.length
        let normalizedScore10Sum = 0

        const examAggMap = new Map<
          string,
          {
            examId: string
            examTitle: string
            examKind: ExamAttemptKind
            attemptCount: number
            completedCount: number
            gradedCount: number
            scoreSum: number
            maxScore: number
          }
        >()

        for (const att of attemptRows) {
          const isCompleted =
            att.submittedAt !== null ||
            att.completionStatus === 'auto_graded' ||
            att.completionStatus === 'needs_review' ||
            att.completionStatus === 'reviewed'

          if (isCompleted) studentAttemptsCompleted += 1
          else studentAttemptsInProgress += 1

          if (att.completionStatus === 'needs_review') {
            studentAttemptsNeedsReview += 1
          }

          const maxSc =
            Number(att.maxScore ?? 10) > 0 ? Number(att.maxScore ?? 10) : 10
          const hasScore =
            att.score !== null &&
            att.score !== undefined &&
            Number.isFinite(Number(att.score))

          if (hasScore) {
            studentAttemptsGraded += 1
            normalizedScore10Sum += (Number(att.score) / maxSc) * 10
          }

          let ex = examAggMap.get(att.examId)
          if (!ex) {
            ex = {
              examId: att.examId,
              examTitle: att.examTitle,
              examKind: att.examKind === 'published' ? 'published' : 'practice',
              attemptCount: 0,
              completedCount: 0,
              gradedCount: 0,
              scoreSum: 0,
              maxScore: maxSc,
            }
            examAggMap.set(att.examId, ex)
          }
          ex.attemptCount += 1
          if (isCompleted) ex.completedCount += 1
          if (hasScore) {
            ex.gradedCount += 1
            ex.scoreSum += Number(att.score)
          }
        }

        if (studentAttemptsGraded > 0) {
          averageScore = roundScore(normalizedScore10Sum / studentAttemptsGraded)
        }
        if (studentAttemptsTotal > 0) {
          completionRate = Math.round(
            (studentAttemptsCompleted / studentAttemptsTotal) * 100
          )
        }

        for (const ex of examAggMap.values()) {
          examPerformance.push({
            examId: ex.examId,
            examTitle: ex.examTitle,
            examKind: ex.examKind,
            attemptCount: ex.attemptCount,
            completedCount: ex.completedCount,
            gradedCount: ex.gradedCount,
            averageScore:
              ex.gradedCount > 0 ? roundScore(ex.scoreSum / ex.gradedCount) : null,
            completionRate:
              ex.attemptCount > 0
                ? Math.round((ex.completedCount / ex.attemptCount) * 100)
                : null,
            maxScore: ex.maxScore,
          })
        }
        examPerformance.sort((a, b) => b.attemptCount - a.attemptCount)

        // Optional Phase-2 tables (gracefully skipped if not yet present in Phase-1 Neon DB)
        try {
          const [docRows, draftRows] = await Promise.all([
            db.select({ id: teacherDocuments.id }).from(teacherDocuments),
            db
              .select({
                status: questionImportDrafts.status,
                questions: questionImportDrafts.questions,
              })
              .from(questionImportDrafts),
          ])

          uploadedDocumentsCount = docRows.length
          draftBatchesCount = draftRows.length

          for (const draft of draftRows) {
            const qs = Array.isArray(draft.questions) ? draft.questions : []
            extractedQuestionsCount += qs.length
            const isDraftBatch = draft.status === 'draft'
            const isCommittedBatch = draft.status === 'committed'

            for (const q of qs) {
              const topicName =
                (q.topic ?? '').trim() ||
                (q.lessonTitle ?? '').trim() ||
                'Chưa phân chuyên đề'
              let entry = topicMap.get(topicName)
              if (!entry) {
                entry = {
                  topicName,
                  extractedCount: 0,
                  draftCount: 0,
                  exceptionCount: 0,
                  approvedBankCount: 0,
                }
                topicMap.set(topicName, entry)
              }
              entry.extractedCount += 1

              if (isCommittedBatch) {
                if (!q.skippedInImport && q.reviewDecision === 'approved') {
                  committedDraftQuestionsCount += 1
                }
              } else if (isDraftBatch && !q.skippedInImport) {
                draftQuestionsCount += 1
                entry.draftCount += 1
                if (isExtractedQuestionException(q)) {
                  exceptionQuestionsCount += 1
                  entry.exceptionCount += 1
                } else {
                  readyDraftQuestionsCount += 1
                }
              }
            }
          }
        } catch {
          // Optional Phase 2 tables not created yet — keep exact 0 values honestly
        }
      },
      2
    )
  } catch (err) {
    const classified = classifyNeonDbError(
      'Không thể truy vấn số liệu thực tế từ Neon PostgreSQL.',
      err
    )
    postgresAvailable = false
    postgresErrorCode = classified.code
    postgresNotice = classified.message
  }

  const topicBreakdown = Array.from(topicMap.values()).sort(
    (a, b) => b.extractedCount - a.extractedCount
  )

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    dataSources: {
      postgresAvailable,
      postgresErrorCode,
      postgresNotice,
      firestoreAvailable: false,
      firestoreNotice:
        'Ngân hàng câu hỏi chính thức và đề thi xuất bản được đọc trực tiếp từ Cloud Firestore trên trình duyệt.',
      postgresTables: [
        'exam_attempts',
        'teacher_documents',
        'question_import_drafts',
      ],
      firestoreCollections: ['questionBank', 'publishedExams'],
    },
    metrics: {
      uploadedDocumentsCount,
      draftBatchesCount,
      extractedQuestionsCount,
      draftQuestionsCount,
      exceptionQuestionsCount,
      readyDraftQuestionsCount,
      committedDraftQuestionsCount,
      approvedBankQuestionsCount: null,
      publishedExamsCount: null,
      studentAttemptsTotal,
      studentAttemptsCompleted,
      studentAttemptsInProgress,
      studentAttemptsGraded,
      studentAttemptsNeedsReview,
      averageScore,
      completionRate,
    },
    topicBreakdown,
    examPerformance,
    recentActivities: [],
  }
}
