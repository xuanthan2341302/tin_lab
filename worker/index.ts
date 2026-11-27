import {
  buildServerProfile,
  requireSuperAdminInWorker,
  verifyFirebaseIdTokenInWorker,
  WorkerAuthError,
} from './auth.ts'
import {
  isExamSealingSecretConfigured,
  sealExamGradingPayloadWorker,
  type SealedExamItem,
} from './crypto.ts'
import { buildStudentResultsCsvUtf8 } from './csvExport.ts'
import {
  bestEffortSyncSuperAdminUserWorker,
  createExamAttemptInWorker,
  getWorkerDashboardMetrics,
  listExamAttemptsForAdminWorker,
  pingNeonDatabase,
  reviewExamAttemptAsAdminWorker,
  submitAndCompleteAttemptTransactionWorker,
  WorkerDbError,
} from './db.ts'
import {
  AUTHORIZED_SUPER_ADMIN_LIST,
  PHASE2_DEFERRED_FEATURES,
  SUPER_ADMIN_PERMISSIONS,
  errorResponse,
  jsonResponse,
  resolveFirebaseProjectId,
  type WorkerEnv,
} from './env.ts'
import { gradePublishedExamInWorker } from './grading.ts'
import {
  validateClassName,
  validateStudentFullName,
} from '../src/lib/studentValidation.ts'
import type {
  AttemptDetailedAnswer,
  Part2ScoringMode,
  StudentAnswerInput,
} from '../src/types.ts'

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_JSON_BODY_BYTES = 1024 * 1024 // 1 MB safety limit for API JSON payloads

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') || '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new WorkerAuthError('Dữ liệu gửi lên vượt quá giới hạn cho phép.', 413, 'PAYLOAD_TOO_LARGE')
  }
  const text = await request.text()
  if (text.length > MAX_JSON_BODY_BYTES) {
    throw new WorkerAuthError('Dữ liệu gửi lên vượt quá giới hạn cho phép.', 413, 'PAYLOAD_TOO_LARGE')
  }
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    throw new WorkerAuthError('Nội dung JSON không hợp lệ.', 400, 'INVALID_JSON')
  }
}

function handleWorkerError(err: unknown, fallbackMessage: string): Response {
  if (err instanceof WorkerAuthError) {
    return errorResponse(err.status, err.message, err.code)
  }
  if (err instanceof WorkerDbError) {
    return errorResponse(err.httpStatus, err.message, err.code)
  }
  const message =
    err instanceof Error && err.message.trim() ? err.message : fallbackMessage
  return errorResponse(500, message, 'INTERNAL_ERROR')
}

async function handleApiRequest(
  request: Request,
  env: WorkerEnv
): Promise<Response> {
  const url = new URL(request.url)
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  const method = request.method.toUpperCase()

  try {
    /* 1. GET /api/health */
    if (pathname === '/api/health' && method === 'GET') {
      const dbStatus = await pingNeonDatabase(env)
      const projectId = resolveFirebaseProjectId(env)
      return jsonResponse(
        {
          ok: true,
          runtime: 'cloudflare-workers',
          mode: 'basic-operations-phase-1',
          databaseEngine: 'Neon PostgreSQL',
          databaseDriver: 'neon-serverless-websocket-transactions',
          databaseConfigured: dbStatus.configured,
          databaseConnected: dbStatus.connected,
          databaseLatencyMs: dbStatus.latencyMs,
          databaseErrorCode: dbStatus.errorCode,
          databaseError: dbStatus.errorMessage,
          firebaseProjectIdConfigured: Boolean(projectId),
          examSealingSecretConfigured: isExamSealingSecretConfigured(env),
          emailConfigured: false,
          objectStorageConfigured: false,
          objectStorageProvider: null,
          aiConfigured: false,
          aiConnected: false,
          aiState: 'not_configured',
          phase2DeferredFeatures: PHASE2_DEFERRED_FEATURES,
          checkedAt: new Date().toISOString(),
        },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    }

    /* 2. Auth endpoints (Web Crypto / JWKS Firebase ID Token verification) */
    if (pathname === '/api/auth/me' && method === 'GET') {
      const identity = await verifyFirebaseIdTokenInWorker(request, env)
      const profile = buildServerProfile(identity, 'allowlist_only')
      return jsonResponse(
        {
          ok: true,
          authenticated: true,
          profile,
        },
        { headers: { 'Cache-Control': 'private, no-store' } }
      )
    }

    if (pathname === '/api/auth/google' && method === 'POST') {
      const adminProfile = await requireSuperAdminInWorker(request, env)
      const dbSyncStatus = await bestEffortSyncSuperAdminUserWorker(env, {
        uid: adminProfile.uid,
        email: adminProfile.email,
        displayName: adminProfile.displayName,
        emailVerified: adminProfile.emailVerified,
        permissions: adminProfile.permissions,
      })
      return jsonResponse(
        {
          ok: true,
          authenticated: true,
          profile: {
            ...adminProfile,
            dbSyncStatus,
            roleSource:
              dbSyncStatus === 'synced'
                ? 'worker_super_admin_allowlist_db_synced'
                : 'worker_super_admin_allowlist',
          },
        },
        { headers: { 'Cache-Control': 'private, no-store' } }
      )
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      return jsonResponse(
        { ok: true },
        { headers: { 'Cache-Control': 'private, no-store' } }
      )
    }

    /* 3. Student Exam Attempt Start (Unauthenticated, strict server validation) */
    if (pathname === '/api/student/attempts/start' && method === 'POST') {
      const body = await readJsonBody(request)
      const rawName = typeof body.studentName === 'string' ? body.studentName : ''
      const rawClass = typeof body.className === 'string' ? body.className : ''
      const examId = typeof body.examId === 'string' ? body.examId.trim() : ''
      const examKind = body.examKind === 'published' ? 'published' : 'practice'
      const accessCode =
        typeof body.accessCode === 'string' ? body.accessCode.trim().slice(0, 30) : ''
      const rawExamTitle =
        typeof body.examTitle === 'string' ? body.examTitle.trim().slice(0, 200) : ''
      const rawMaxScore = Number(body.maxScore)
      const rawScoringMode =
        typeof body.scoringMode === 'string' ? body.scoringMode.trim().slice(0, 40) : ''

      const nameValidation = validateStudentFullName(rawName)
      const classValidation = validateClassName(rawClass)
      const fieldErrors: Record<string, string> = {}

      if (!nameValidation.ok) fieldErrors.studentName = nameValidation.error
      if (!classValidation.ok) fieldErrors.className = classValidation.error

      if (
        Object.keys(fieldErrors).length > 0 ||
        !nameValidation.ok ||
        !classValidation.ok
      ) {
        return errorResponse(
          400,
          (!nameValidation.ok && nameValidation.error) ||
            (!classValidation.ok && classValidation.error) ||
            'Thông tin thí sinh chưa hợp lệ.',
          'VALIDATION_ERROR',
          { fieldErrors }
        )
      }

      if (!examId || !/^[a-zA-Z0-9_-]{2,80}$/.test(examId)) {
        return errorResponse(400, 'Mã đề thi không hợp lệ.', 'VALIDATION_ERROR')
      }

      if (examKind !== 'published') {
        return errorResponse(
          400,
          'Phiên bản hiện tại chỉ hỗ trợ làm các đề thi chính thức đã xuất bản (published).',
          'UNSUPPORTED_EXAM_KIND'
        )
      }

      if (!rawExamTitle) {
        return errorResponse(400, 'Thiếu tiêu đề bài thi.', 'VALIDATION_ERROR')
      }

      const resolvedMaxScore =
        Number.isFinite(rawMaxScore) && rawMaxScore > 0 && rawMaxScore <= 100
          ? rawMaxScore
          : 10
      const resolvedScoringMode =
        rawScoringMode === 'linear' ? 'linear' : 'tiered_2025'

      const attempt = await createExamAttemptInWorker(env, {
        examId,
        examTitle: rawExamTitle,
        examKind: 'published',
        accessCode,
        studentName: nameValidation.display,
        studentNameNormalized: nameValidation.normalized,
        className: classValidation.normalized,
        rawClassName: classValidation.rawClean,
        maxScore: resolvedMaxScore,
        scoringMode: resolvedScoringMode,
      })

      return jsonResponse(
        {
          ok: true,
          attempt: {
            attemptId: attempt.attemptId,
            examId: attempt.examId,
            examTitle: attempt.examTitle,
            examKind: attempt.examKind,
            studentName: attempt.studentName,
            className: attempt.className,
            startedAt: attempt.startedAt,
          },
        },
        { status: 201, headers: { 'Cache-Control': 'no-store' } }
      )
    }

    /* 4. Student Exam Attempt Submit & Server Grading (Prevents Resubmission) */
    if (pathname === '/api/student/attempts/submit' && method === 'POST') {
      const body = await readJsonBody(request)
      const attemptId = typeof body.attemptId === 'string' ? body.attemptId.trim() : ''
      const examId = typeof body.examId === 'string' ? body.examId.trim() : ''
      const studentAnswers = Array.isArray(body.studentAnswers)
        ? (body.studentAnswers as StudentAnswerInput[])
        : []
      const sealedGradingPayload =
        typeof body.sealedGradingPayload === 'string'
          ? body.sealedGradingPayload.trim()
          : ''

      if (!UUID_REGEX.test(attemptId)) {
        return errorResponse(
          400,
          'Mã phiên làm bài (Attempt ID) không hợp lệ.',
          'VALIDATION_ERROR'
        )
      }
      if (!examId) {
        return errorResponse(400, 'Thiếu mã đề thi khi nộp bài.', 'VALIDATION_ERROR')
      }
      if (!sealedGradingPayload) {
        return errorResponse(
          400,
          'Thiếu gói niêm phong đáp án của đề thi để chấm điểm trên máy chủ.',
          'VALIDATION_ERROR'
        )
      }

      const { saved, extra: gradeResult } =
        await submitAndCompleteAttemptTransactionWorker(env, {
          attemptId,
          examId,
          computeSubmission: async (existing) => {
            const graded = await gradePublishedExamInWorker(
              {
                examId,
                sealedGradingPayload,
                studentAnswers,
              },
              env
            )

            const mappedDetails: AttemptDetailedAnswer[] = graded.gradedAnswers.map(
              (item) => ({
                questionId: item.questionId,
                part: item.part,
                questionType: item.questionType,
                questionText: item.questionText || '',
                maxPoints: item.maxPoints,
                earnedPoints: item.earnedPoints,
                selectedOption: item.selectedOption,
                correctOption: item.correctOption,
                statementChoices: item.statementChoices,
                correctStatements: item.correctStatements,
                trueFalseCorrectCount: item.trueFalseCorrectCount,
                essayText: item.essayText,
                aiSuggestedScore: item.aiSuggestedScore,
                aiConfidence: item.aiConfidence,
                needsAdminReview: item.needsTeacherReview,
                aiFeedback: item.aiFeedback,
                adminScore: item.teacherScore,
                adminComment: item.teacherComment,
                explanation: item.explanation,
              })
            )

            const completionStatus =
              graded.gradingStatus === 'needs_teacher_review'
                ? 'needs_review'
                : 'auto_graded'

            return {
              submission: {
                scoringMode: existing.scoringMode || 'tiered_2025',
                part1Score: graded.part1Score,
                part1Max: graded.part1Max,
                part2Score: graded.part2Score,
                part2Max: graded.part2Max,
                part3Score: graded.part3AiScore,
                part3Max: graded.part3Max,
                score: graded.totalProvisionalScore,
                maxScore: graded.totalMax,
                completionStatus,
                detailedAnswers: mappedDetails,
              },
              extra: graded,
            }
          },
        })

      return jsonResponse(
        {
          ok: true,
          kind: 'published',
          attemptId: saved.attemptId,
          studentName: saved.studentName,
          className: saved.className,
          startedAt: saved.startedAt,
          submittedAt: saved.submittedAt,
          completionStatus: saved.completionStatus,
          gradeResult,
        },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    }

    /* 4b. Block direct unauthenticated grading endpoint to prevent pre-submission answer probing */
    if (pathname === '/api/exams/grade' && method === 'POST') {
      return errorResponse(
        403,
        'Chấm điểm trực tiếp không qua phiên làm bài đã bị vô hiệu hóa để bảo mật đáp án. Vui lòng nộp bài qua /api/student/attempts/submit.',
        'DIRECT_GRADING_DISABLED'
      )
    }

    /* 5. Exam Sealing for Super Admin Publishing Flow */
    if (pathname === '/api/exams/seal' && method === 'POST') {
      await requireSuperAdminInWorker(request, env)
      const body = await readJsonBody(request)
      const examId = typeof body.examId === 'string' ? body.examId.trim() : ''
      const part2ScoringMode: Part2ScoringMode =
        body.part2ScoringMode === 'linear' ? 'linear' : 'tiered_2025'
      const totalPoints = Number(body.totalPoints)
      const items = Array.isArray(body.items) ? (body.items as SealedExamItem[]) : []

      if (!examId || !/^[a-zA-Z0-9_-]{2,80}$/.test(examId)) {
        return errorResponse(400, 'Mã đề thi (examId) không hợp lệ.', 'VALIDATION_ERROR')
      }
      if (!Number.isFinite(totalPoints) || totalPoints <= 0 || totalPoints > 100) {
        return errorResponse(400, 'Tổng điểm đề thi không hợp lệ.', 'VALIDATION_ERROR')
      }
      if (items.length === 0 || items.length > 150) {
        return errorResponse(
          400,
          'Danh sách câu hỏi cần niêm phong không hợp lệ.',
          'VALIDATION_ERROR'
        )
      }

      const sealedGradingPayload = await sealExamGradingPayloadWorker(
        {
          v: 1,
          examId,
          part2ScoringMode,
          totalPoints,
          items,
        },
        env
      )
      return jsonResponse(
        { ok: true, sealedGradingPayload },
        { headers: { 'Cache-Control': 'private, no-store' } }
      )
    }

    /* 6. Super Admin: List Student Results */
    if (pathname === '/api/admin/student-results' && method === 'GET') {
      await requireSuperAdminInWorker(request, env)
      const payload = await listExamAttemptsForAdminWorker(env, {
        q: url.searchParams.get('q') ?? '',
        className: url.searchParams.get('className') ?? '',
        examId: url.searchParams.get('examId') ?? '',
        status: url.searchParams.get('status') ?? '',
        dateFrom: url.searchParams.get('dateFrom') ?? '',
        dateTo: url.searchParams.get('dateTo') ?? '',
      })
      return jsonResponse(payload, {
        headers: { 'Cache-Control': 'private, no-store' },
      })
    }

    /* 7. Super Admin: Export Student Results as UTF-8 CSV (Excel-compatible) */
    if (pathname === '/api/admin/student-results/export' && method === 'GET') {
      await requireSuperAdminInWorker(request, env)
      const includeDetailsParam = url.searchParams.get('includeDetails')
      const includeDetailedAnswers =
        includeDetailsParam === '1' || includeDetailsParam === 'true'

      const payload = await listExamAttemptsForAdminWorker(env, {
        q: url.searchParams.get('q') ?? '',
        className: url.searchParams.get('className') ?? '',
        examId: url.searchParams.get('examId') ?? '',
        status: url.searchParams.get('status') ?? '',
        dateFrom: url.searchParams.get('dateFrom') ?? '',
        dateTo: url.searchParams.get('dateTo') ?? '',
      })

      const csvContent = buildStudentResultsCsvUtf8({
        data: payload,
        includeDetailedAnswers,
      })

      const dateTag = new Date().toISOString().slice(0, 10)
      const filename = includeDetailedAnswers
        ? `tin-lab-ket-qua-chi-tiet-${dateTag}.csv`
        : `tin-lab-ket-qua-hoc-sinh-${dateTag}.csv`

      return new Response(csvContent, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }

    /* 8. Super Admin: Review / Adjust Essay Score */
    const reviewMatch = pathname.match(/^\/api\/admin\/student-results\/([^/]+)\/review$/)
    if (reviewMatch && method === 'PATCH') {
      const admin = await requireSuperAdminInWorker(request, env)
      const attemptId = decodeURIComponent(reviewMatch[1])
      if (!UUID_REGEX.test(attemptId)) {
        return errorResponse(
          400,
          'Mã lượt làm bài (Attempt ID) không hợp lệ.',
          'VALIDATION_ERROR'
        )
      }

      const body = await readJsonBody(request)
      const adminFeedback =
        typeof body.adminFeedback === 'string'
          ? body.adminFeedback.trim().slice(0, 2000)
          : ''
      const rawEssayScores =
        body.essayScores && typeof body.essayScores === 'object'
          ? (body.essayScores as Record<string, { score?: unknown; comment?: unknown }>)
          : {}

      const sanitizedEssayScores: Record<string, { score: number; comment: string }> = {}
      for (const [qId, val] of Object.entries(rawEssayScores)) {
        if (!val || typeof val !== 'object') continue
        const numScore = Number(val.score)
        if (!Number.isFinite(numScore) || numScore < 0) continue
        sanitizedEssayScores[qId] = {
          score: numScore,
          comment:
            typeof val.comment === 'string' ? val.comment.trim().slice(0, 1000) : '',
        }
      }

      const updated = await reviewExamAttemptAsAdminWorker(env, {
        attemptId,
        reviewerEmail: admin.email,
        essayScores: sanitizedEssayScores,
        adminFeedback,
      })

      return jsonResponse(
        { ok: true, attempt: updated },
        { headers: { 'Cache-Control': 'private, no-store' } }
      )
    }

    /* 9. Real Dashboard Metrics (Public PII-free & Admin) */
    if (pathname === '/api/dashboard/metrics' && method === 'GET') {
      const payload = await getWorkerDashboardMetrics(env)
      return jsonResponse(payload, { headers: { 'Cache-Control': 'no-store' } })
    }

    if (pathname === '/api/admin/dashboard-metrics' && method === 'GET') {
      await requireSuperAdminInWorker(request, env)
      const payload = await getWorkerDashboardMetrics(env)
      return jsonResponse(payload, {
        headers: { 'Cache-Control': 'private, no-store' },
      })
    }

    /* 10. Super Admin Governance Read-Only Views (so RBAC tab works cleanly) */
    if (pathname === '/api/admin/administrators' && method === 'GET') {
      const admin = await requireSuperAdminInWorker(request, env)
      const nowIso = new Date().toISOString()
      return jsonResponse(
        {
          ok: true,
          administrators: AUTHORIZED_SUPER_ADMIN_LIST.map((email, idx) => ({
            id: idx + 1,
            email,
            assignedRole: 'super_admin' as const,
            status: 'active' as const,
            isBootstrap: true,
            note: 'Tài khoản Super Admin chính thức (chính sách phía máy chủ Cloudflare Worker)',
            grantedByUid: 'system',
            grantedByEmail: 'system',
            activatedUid: email === admin.email ? admin.uid : null,
            activatedAt: email === admin.email ? nowIso : null,
            createdAt: nowIso,
            updatedAt: nowIso,
          })),
          roleDefinitions: [
            {
              role: 'super_admin',
              displayName: 'Super Admin',
              description:
                'Toàn quyền quản trị kết quả học sinh, duyệt điểm tự luận, xuất CSV và xuất bản đề thi trên TIN LAB.',
              permissions: SUPER_ADMIN_PERMISSIONS,
              updatedAt: nowIso,
            },
            {
              role: 'student',
              displayName: 'Học sinh',
              description:
                'Làm bài thi trực tuyến không cần tài khoản bằng Họ và tên và Lớp.',
              permissions: ['student:exams'],
              updatedAt: nowIso,
            },
          ],
          auditLogs: [],
        },
        { headers: { 'Cache-Control': 'private, no-store' } }
      )
    }

    if (pathname === '/api/admin/system-settings' && method === 'GET') {
      await requireSuperAdminInWorker(request, env)
      const metricsPayload = await getWorkerDashboardMetrics(env)
      const nowIso = new Date().toISOString()
      return jsonResponse(
        {
          ok: true,
          settings: {
            databaseEngine: 'PostgreSQL (Neon Serverless)',
            emailConfigured: false,
            objectStorage: {
              configured: false,
              provider: null,
              bucket: null,
              endpoint: null,
              missingRequirements: [
                'Google Drive Document Library được giữ lại cho Giai đoạn 2 (chưa kích hoạt trên Cloudflare Workers Giai đoạn 1).',
              ],
              message:
                'Chức năng lưu trữ tài liệu Google Drive tạm hoãn trên phiên bản Cloudflare Workers cơ bản (Giai đoạn 1).',
            },
            roleDefinitions: [
              {
                role: 'super_admin',
                displayName: 'Super Admin',
                description:
                  'Hai tài khoản quản trị chính thức được kiểm tra bằng Firebase ID Token + JWKS phía máy chủ.',
                permissions: SUPER_ADMIN_PERMISSIONS,
                updatedAt: nowIso,
              },
            ],
            counts: {
              totalUsers: AUTHORIZED_SUPER_ADMIN_LIST.length,
              superAdminsActive: AUTHORIZED_SUPER_ADMIN_LIST.length,
              superAdminsPending: 0,
              totalDocuments: metricsPayload.metrics.uploadedDocumentsCount,
              totalExamAttempts: metricsPayload.metrics.studentAttemptsTotal,
            },
          },
        },
        { headers: { 'Cache-Control': 'private, no-store' } }
      )
    }

    /* 10b. Fixed 2-Super-Admin Policy Guard (no self-signup or dynamic privilege mutation) */
    if (
      (pathname === '/api/admin/administrators' && method === 'POST') ||
      (/^\/api\/admin\/administrators\/[^/]+$/.test(pathname) &&
        (method === 'PATCH' || method === 'DELETE'))
    ) {
      await requireSuperAdminInWorker(request, env)
      return errorResponse(
        403,
        'Danh sách Super Admin của TIN LAB được cố định phía máy chủ gồm đúng 2 email chính thức và không thể tự thay đổi qua giao diện.',
        'FIXED_SUPER_ADMIN_POLICY'
      )
    }

    /* 11. Deferred Phase-2 Routes (Explicit 501 — never fake success) */
    if (
      pathname.startsWith('/api/documents') ||
      pathname.startsWith('/api/teacher/documents') ||
      pathname.startsWith('/api/question-bank') ||
      pathname.startsWith('/api/question-drafts') ||
      pathname.startsWith('/api/ai/') ||
      pathname.startsWith('/api/drive') ||
      pathname === '/api/exams/regrade-essay' ||
      pathname === '/api/contact'
    ) {
      return errorResponse(
        501,
        'Chức năng này chưa khả dụng trên phiên bản vận hành cơ bản Cloudflare Workers (Giai đoạn 1) và sẽ được kích hoạt ở Giai đoạn 2.',
        'PHASE2_DEFERRED'
      )
    }

    return errorResponse(404, 'API endpoint không tồn tại.', 'NOT_FOUND')
  } catch (err) {
    return handleWorkerError(err, 'Lỗi xử lý yêu cầu trên Cloudflare Worker.')
  }
}

function withNoIndexIfPrivate(pathname: string, response: Response): Response {
  if (
    pathname.startsWith('/hoc-sinh') ||
    pathname.startsWith('/giao-vien') ||
    pathname.startsWith('/api/')
  ) {
    const cloned = new Response(response.body, response)
    cloned.headers.set('X-Robots-Tag', 'noindex, nofollow')
    return cloned
  }
  return response
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      const apiRes = await handleApiRequest(request, env)
      return withNoIndexIfPrivate(url.pathname, apiRes)
    }

    // Serve static frontend assets + SPA fallback via Cloudflare Static Assets binding
    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request)
      return withNoIndexIfPrivate(url.pathname, assetRes)
    }

    return errorResponse(404, 'Static assets binding is not configured.', 'NO_ASSETS')
  },
} satisfies ExportedHandler<WorkerEnv>
