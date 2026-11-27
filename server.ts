import crypto from 'node:crypto'
import express from 'express'
import type { Request, Response } from 'express'
import mammoth from 'mammoth'
import multer from 'multer'
import nodemailer from 'nodemailer'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createTeacherDocumentRecord,
  deleteTeacherDocumentById,
  getTeacherDocumentById,
  listAllTeacherDocuments,
  updateTeacherDocumentStatus,
} from './src/db/documents.ts'
import {
  completeExamAttemptRecord,
  createExamAttemptRecord,
  getExamAttemptByAttemptId,
  listExamAttemptsForAdmin,
  reviewExamAttemptAsAdmin,
} from './src/db/attempts.ts'
import { getRealDashboardMetrics } from './src/db/dashboard.ts'
import {
  AUTHORIZED_SUPER_ADMIN_LIST,
  DEFAULT_ROLE_PERMISSIONS,
  listAdminAuditLogs,
  listAdministrators,
  listRoleDefinitions,
  getSystemGovernanceCounts,
  updateAdministratorAuthorization,
} from './src/db/users.ts'
import {
  validateClassName,
  validateStudentFullName,
} from './src/lib/studentValidation.ts'
import {
  buildDocumentAiInputContract,
  createInitialAiAgentHook,
  createQueuedAiAgentHook,
  isValidDocumentStatus,
} from './src/lib/documentAiInterface.ts'
import {
  buildDocumentStorageKey,
  getStorageConfigStatus,
} from './src/lib/objectStorage.ts'
import {
  DRIVE_ROOT_FOLDER_NAME,
  GoogleDriveError,
  buildDriveFolderPath,
  buildGoogleDriveConnectionStatus,
  buildSampleVerificationDocxBuffer,
  downloadDriveFileBuffer,
  ensureDriveLibraryFolders,
  isValidDriveSubfolderKey,
  trashDriveFile,
  uploadFileToDriveResumable,
  verifyDriveTokenIdentity,
} from './server/googleDriveService.ts'
import {
  evaluateSuperAdminAuthorization,
  requireAuth,
  requireSuperAdminRole,
  type AuthRequest,
} from './src/middleware/auth.ts'
import {
  DocumentParserError,
  parseQuestionBankDocument,
} from './server/questionParser.ts'
import {
  evaluateEssayWithGemini,
  gradeExamSubmission,
  sealExamGradingPayload,
  type SealedExamItem,
} from './server/examService.ts'
import {
  getServerPracticeExamById,
  gradePracticeExamAttempt,
} from './server/practiceExams.ts'
import { buildStudentResultsWorkbookBuffer } from './server/resultsExport.ts'
import { buildDocumentAgentExcelBuffer } from './server/agentExport.ts'
import {
  getCachedGeminiConnectionInfo,
  verifyGeminiApiConnection,
} from './server/geminiClient.ts'
import {
  createQuestionImportDraft,
  deleteQuestionImportDraftById,
  getQuestionImportDraftById,
  listQuestionImportDraftsByOwner,
  updateQuestionImportDraft,
} from './src/db/drafts.ts'
import {
  AiExtractionError,
  analyzeAndGenerateWithAiAgent,
  classifyFileForAgent,
  extractQuestionsWithGemini,
  isGeminiAiConfigured,
  resolveExceptionQuestionsBatch,
  resumeIncompleteAgentQuestions,
  runDocumentAiAgentPipeline,
  type AgentInputFile,
} from './server/documentAiAgent.ts'
import type {
  AgentAnalysisSummary,
  AgentFileRole,
  AgentSetMode,
  AgentUploadedFileReport,
  AnswerProvisionMode,
  AttemptDetailedAnswer,
  BatchResolveExistingBankHint,
  CompositeDocumentAnalysis,
  DocumentApprovalStatus,
  DocumentFileExtension,
  DocumentImportCategory,
  DriveSubfolderKey,
  ExtractedQuestion,
  GoogleDriveSelfTestResult,
  ImportJobSnapshot,
  ImportStepCode,
  ParseDocumentResponse,
  Part2ScoringMode,
  QuestionDraftStatus,
  QuestionImportDraftRecord,
  QuestionType,
  SourceFileFormat,
  StudentAnswerInput,
  TeacherDocumentRecord,
} from './src/types.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '2mb' }))

const DEFAULT_PUBLIC_URL =
  'https://ais-pre-fra34bcjqzk4pbluowypxl-385969079523.asia-east1.run.app'

// Prevent search engine indexing of private teacher, student exam, and API routes
app.use((req: Request, res: Response, next) => {
  if (
    req.path.startsWith('/hoc-sinh') ||
    req.path.startsWith('/giao-vien') ||
    req.path.startsWith('/api/')
  ) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  }
  next()
})

app.get('/robots.txt', (_req: Request, res: Response, next) => {
  const configuredUrl = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '')
  if (!configuredUrl || configuredUrl === DEFAULT_PUBLIC_URL) {
    next()
    return
  }
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /',
      'Allow: /huong-dan',
      'Allow: /lien-he',
      'Allow: /thong-ke',
      'Allow: /googlec63c64710272aece.html',
      'Disallow: /hoc-sinh',
      'Disallow: /giao-vien',
      'Disallow: /api/',
      '',
      `Sitemap: ${configuredUrl}/sitemap.xml`,
      '',
    ].join('\n')
  )
})

app.get('/sitemap.xml', (_req: Request, res: Response, next) => {
  const configuredUrl = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '')
  if (!configuredUrl || configuredUrl === DEFAULT_PUBLIC_URL) {
    next()
    return
  }
  const urls = [
    { loc: `${configuredUrl}/`, changefreq: 'weekly', priority: '1.0' },
    { loc: `${configuredUrl}/huong-dan`, changefreq: 'monthly', priority: '0.8' },
    { loc: `${configuredUrl}/lien-he`, changefreq: 'monthly', priority: '0.7' },
    { loc: `${configuredUrl}/thong-ke`, changefreq: 'monthly', priority: '0.6' },
  ]
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(
      (u) =>
        `  <url>\n    <loc>${u.loc}</loc>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
    ),
    '</urlset>',
  ].join('\n')
  res.type('application/xml').send(body)
})

interface RateLimitEntry {
  count: number
  resetAt: number
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000
const RATE_LIMIT_MAX = 5
const rateLimitStore = new Map<string, RateLimitEntry>()

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim()
  }
  return req.ip || 'unknown'
}

function checkRateLimit(ip: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now()
  if (rateLimitStore.size > 1000) {
    for (const [key, entry] of rateLimitStore.entries()) {
      if (entry.resetAt <= now) {
        rateLimitStore.delete(key)
      }
    }
  }

  const current = rateLimitStore.get(ip)
  if (!current || current.resetAt <= now) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return { allowed: true, retryAfterSeconds: 0 }
  }

  if (current.count >= RATE_LIMIT_MAX) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    }
  }

  current.count += 1
  return { allowed: true, retryAfterSeconds: 0 }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const PHONE_REGEX = /^[0-9+\s().-]{8,20}$/
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

app.get('/api/health', (_req: Request, res: Response) => {
  const smtpConfigured = Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim()
  )
  const storageStatus = getStorageConfigStatus()
  const cachedAi = getCachedGeminiConnectionInfo()
  res.json({
    ok: true,
    emailConfigured: smtpConfigured,
    objectStorageConfigured: storageStatus.configured,
    objectStorageProvider: storageStatus.provider,
    aiConfigured: isGeminiAiConfigured(),
    aiConnected: cachedAi?.connected ?? null,
    aiState: cachedAi?.state ?? (isGeminiAiConfigured() ? 'unknown' : 'not_configured'),
  })
})

/* ============================================================================
 * PHASE 1: SUPER ADMIN ROLE-BASED ACCESS CONTROL (POSTGRESQL RBAC)
 * ========================================================================== */

function serializeAdministrator(
  row: Awaited<ReturnType<typeof listAdministrators>>[number]
) {
  return {
    id: row.id,
    email: row.email,
    assignedRole: 'super_admin' as const,
    status: row.status,
    isBootstrap: row.isBootstrap,
    note: row.note,
    grantedByUid: row.grantedByUid,
    grantedByEmail: row.grantedByEmail,
    activatedUid: row.activatedUid ?? null,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

app.get('/api/auth/me', requireAuth, (req: AuthRequest, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store')
  const user = req.dbUser!
  const authDecision = evaluateSuperAdminAuthorization({
    email: user.email,
    emailVerified: user.emailVerified,
    role: user.role,
    status: user.status,
  })
  const isSuperAdmin = authDecision.allowed

  res.json({
    ok: true,
    authenticated: true,
    profile: {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.emailVerified,
      role: isSuperAdmin ? 'super_admin' : 'student',
      roleSource: user.roleSource,
      status: user.status,
      permissions: isSuperAdmin ? user.permissions : [],
      isSuperAdmin,
      dbSyncStatus: user.dbSyncStatus,
    },
  })
})

app.post(
  '/api/auth/google',
  requireAuth,
  requireSuperAdminRole,
  (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store')
    const user = req.dbUser!

    res.json({
      ok: true,
      authenticated: true,
      profile: {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        emailVerified: user.emailVerified,
        role: user.role,
        roleSource: user.roleSource,
        status: user.status,
        permissions: user.permissions,
        isSuperAdmin: true,
        dbSyncStatus: user.dbSyncStatus,
      },
    })
  }
)

app.post('/api/auth/logout', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store')
  res.json({ ok: true })
})

app.get(
  '/api/admin/administrators',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    try {
      const [administrators, roleDefs, auditLogs] = await Promise.all([
        listAdministrators(),
        listRoleDefinitions(),
        listAdminAuditLogs(40),
      ])

      res.json({
        ok: true,
        administrators: administrators.map(serializeAdministrator),
        roleDefinitions: roleDefs.map((r) => ({
          role: r.role,
          displayName: r.displayName,
          description: r.description,
          permissions: r.permissions,
          updatedAt: r.updatedAt.toISOString(),
        })),
        auditLogs: auditLogs.map((l) => ({
          id: l.id,
          actorUid: l.actorUid,
          actorEmail: l.actorEmail,
          action: l.action,
          targetEmail: l.targetEmail,
          details: l.details,
          createdAt: l.createdAt.toISOString(),
        })),
      })
    } catch (err) {
      console.warn(
        '[TIN LAB] Falling back to server-side Super Admin policy list for /api/admin/administrators:',
        err instanceof Error ? err.message : String(err)
      )
      const nowIso = new Date().toISOString()
      const currentUser = req.dbUser!
      res.json({
        ok: true,
        administrators: AUTHORIZED_SUPER_ADMIN_LIST.map((email, idx) => ({
          id: idx + 1,
          email,
          assignedRole: 'super_admin' as const,
          status: 'active' as const,
          isBootstrap: true,
          note: 'Tài khoản Super Admin chính thức (chính sách server-side)',
          grantedByUid: 'system',
          grantedByEmail: 'system',
          activatedUid: email === currentUser.email ? currentUser.uid : null,
          activatedAt: email === currentUser.email ? nowIso : null,
          createdAt: nowIso,
          updatedAt: nowIso,
        })),
        roleDefinitions: [
          {
            role: 'super_admin',
            displayName: 'Super Admin',
            description:
              'Toàn quyền quản trị TIN LAB (áp dụng ngang nhau cho hai tài khoản Super Admin chính thức).',
            permissions: DEFAULT_ROLE_PERMISSIONS.super_admin,
            updatedAt: nowIso,
          },
          {
            role: 'student',
            displayName: 'Học sinh',
            description: 'Làm bài luyện tập và kiểm tra không cần tài khoản quản trị.',
            permissions: DEFAULT_ROLE_PERMISSIONS.student,
            updatedAt: nowIso,
          },
        ],
        auditLogs: [],
      })
    }
  }
)

app.post(
  '/api/admin/administrators',
  requireAuth,
  requireSuperAdminRole,
  (_req: AuthRequest, res: Response) => {
    res.status(403).json({
      ok: false,
      code: 'REGISTRATION_LOCKED',
      error:
        'Trong giai đoạn phát triển hiện tại, chỉ hai tài khoản Super Admin được ủy quyền mới có quyền quản trị và không cho phép đăng ký vai trò Giáo viên hoặc thêm quản trị viên khác.',
    })
  }
)

app.patch(
  '/api/admin/administrators/:id',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    const numericId = Number(idParam)
    if (!Number.isInteger(numericId) || numericId <= 0) {
      res.status(400).json({ ok: false, error: 'Mã tài khoản quản trị không hợp lệ.' })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const status =
      body.status === 'active' ||
      body.status === 'pending_activation' ||
      body.status === 'revoked'
        ? body.status
        : undefined
    const note =
      typeof body.note === 'string' ? body.note.trim().slice(0, 200) : undefined

    if (body.assignedRole !== undefined && body.assignedRole !== 'super_admin') {
      res.status(403).json({
        ok: false,
        error: 'Vai trò Giáo viên đã bị gỡ bỏ trong giai đoạn hiện tại. Chỉ duy trì quyền Super Admin.',
      })
      return
    }
    if (body.status !== undefined && !status) {
      res.status(400).json({ ok: false, error: 'Giá trị trạng thái không hợp lệ.' })
      return
    }

    try {
      const updated = await updateAdministratorAuthorization({
        actorUid: req.dbUser!.uid,
        actorEmail: req.dbUser!.email,
        id: numericId,
        status,
        note,
      })
      res.json({
        ok: true,
        administrator: serializeAdministrator(updated),
      })
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'NOT_FOUND') {
          res.status(404).json({ ok: false, error: 'Không tìm thấy tài khoản trong danh sách.' })
          return
        }
        if (err.message === 'CANNOT_MODIFY_SELF') {
          res.status(400).json({
            ok: false,
            code: 'CANNOT_MODIFY_SELF',
            error:
              'Biện pháp bảo vệ: Không thể tự thu hồi chính tài khoản Super Admin đang đăng nhập.',
          })
          return
        }
        if (err.message === 'AUTHORIZED_SUPER_ADMIN_PROTECTED') {
          res.status(403).json({
            ok: false,
            code: 'AUTHORIZED_SUPER_ADMIN_PROTECTED',
            error:
              'Hai tài khoản Super Admin chính thức của TIN LAB được bảo vệ cố định và không thể bị thu hồi quyền quản trị.',
          })
          return
        }
        if (err.message === 'LAST_SUPER_ADMIN_PROTECTED') {
          res.status(409).json({
            ok: false,
            code: 'LAST_SUPER_ADMIN_PROTECTED',
            error:
              'Biện pháp bảo vệ: Hệ thống phải duy trì ít nhất một Super Admin đang hoạt động.',
          })
          return
        }
      }
      res.status(500).json({
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : 'Không thể cập nhật quyền tài khoản quản trị.',
      })
    }
  }
)

app.delete(
  '/api/admin/administrators/:id',
  requireAuth,
  requireSuperAdminRole,
  (_req: AuthRequest, res: Response) => {
    res.status(403).json({
      ok: false,
      code: 'AUTHORIZED_SUPER_ADMIN_PROTECTED',
      error:
        'Hai tài khoản Super Admin gốc được bảo vệ cố định trong giai đoạn phát triển hiện tại.',
    })
  }
)

app.get(
  '/api/admin/system-settings',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const smtpConfigured = Boolean(
      process.env.SMTP_HOST?.trim() &&
        process.env.SMTP_USER?.trim() &&
        process.env.SMTP_PASS?.trim()
    )

    try {
      const accessToken = extractDriveAccessToken(req)
      const [driveStatus, roleDefs, counts] = await Promise.all([
        buildGoogleDriveConnectionStatus({ accessToken }),
        listRoleDefinitions(),
        getSystemGovernanceCounts(),
      ])
      const objectStorage = getStorageConfigStatus(driveStatus)

      res.json({
        ok: true,
        settings: {
          databaseEngine: 'PostgreSQL (Cloud SQL)',
          emailConfigured: smtpConfigured,
          objectStorage,
          roleDefinitions: roleDefs.map((r) => ({
            role: r.role,
            displayName: r.displayName,
            description: r.description,
            permissions: r.permissions,
            updatedAt: r.updatedAt.toISOString(),
          })),
          counts,
        },
      })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : 'Không thể tải cấu hình hệ thống từ PostgreSQL.',
      })
    }
  }
)

/* ============================================================================
 * GOOGLE DRIVE DOCUMENT LIBRARY (GOOGLE DRIVE API v3 + POSTGRESQL)
 * ========================================================================== */

const MAX_LIBRARY_FILE_BYTES = 20 * 1024 * 1024
const MAX_LIBRARY_FILES_PER_BATCH = 10

const documentLibraryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_LIBRARY_FILE_BYTES,
    files: MAX_LIBRARY_FILES_PER_BATCH,
  },
})

function extractDriveAccessToken(req: Request): string {
  const headerVal = req.headers['x-google-drive-token']
  if (typeof headerVal === 'string') return headerVal.trim()
  if (Array.isArray(headerVal) && headerVal[0]) return headerVal[0].trim()
  return ''
}

function decodeUploadFilename(rawName: string): string {
  try {
    const decoded = Buffer.from(rawName, 'latin1').toString('utf8')
    if (!decoded.includes('\uFFFD') && decoded !== rawName) {
      return decoded
    }
  } catch {
    // Fallback to rawName
  }
  return rawName
}

function computeApprovalStatus(draft: QuestionImportDraftRecord | null | undefined): {
  extractedQuestionCount: number
  approvedQuestionCount: number
  approvalStatus: DocumentApprovalStatus
  approvalStatusLabel: string
} {
  if (!draft || draft.totalCount === 0) {
    return {
      extractedQuestionCount: 0,
      approvedQuestionCount: 0,
      approvalStatus: 'not_extracted',
      approvalStatusLabel: 'Chưa trích xuất',
    }
  }
  const total = draft.totalCount
  const approved = draft.approvedCount
  if (draft.status === 'committed' || (total > 0 && approved >= total)) {
    return {
      extractedQuestionCount: total,
      approvedQuestionCount: approved,
      approvalStatus: 'approved',
      approvalStatusLabel: `Đã duyệt (${approved}/${total})`,
    }
  }
  if (approved > 0) {
    return {
      extractedQuestionCount: total,
      approvedQuestionCount: approved,
      approvalStatus: 'partial',
      approvalStatusLabel: `Đang duyệt (${approved}/${total})`,
    }
  }
  return {
    extractedQuestionCount: total,
    approvedQuestionCount: 0,
    approvalStatus: 'pending',
    approvalStatusLabel: `Chờ duyệt (${total} câu)`,
  }
}

function serializeDocumentRecord(
  row: Awaited<ReturnType<typeof listAllTeacherDocuments>>[number],
  linkedDraft?: QuestionImportDraftRecord | null
): TeacherDocumentRecord {
  const ext: DocumentFileExtension =
    row.fileExtension === 'pdf' || row.fileExtension === 'docx' ? row.fileExtension : 'txt'
  const status = isValidDocumentStatus(row.processingStatus)
    ? row.processingStatus
    : 'Uploaded'

  const hasOriginalFile = Boolean(row.driveFileId && row.driveFileId.trim())
  const folderKey: DriveSubfolderKey | null = isValidDriveSubfolderKey(row.driveFolderKey)
    ? row.driveFolderKey
    : hasOriginalFile
    ? '01_TAI_LIEU_GOC'
    : null

  const approval = computeApprovalStatus(linkedDraft)
  const extractedCount =
    approval.extractedQuestionCount > 0
      ? approval.extractedQuestionCount
      : row.aiAgentHook?.summaryMetadata?.extractedQuestionCount ?? 0

  return {
    id: row.id,
    ownerUid: row.ownerUid,
    originalFilename: row.originalFilename,
    fileExtension: ext,
    mimeType: row.mimeType,
    fileSizeBytes: row.fileSizeBytes,
    sha256: row.sha256,
    storageProvider:
      row.storageProvider === 'google_drive'
        ? 'google_drive'
        : row.storageProvider === 'gcs'
        ? 'gcs'
        : 's3',
    storageBucket: row.storageBucket,
    storageKey: row.storageKey,
    driveFileId: row.driveFileId ?? null,
    driveFolderKey: folderKey,
    driveFolderId: row.driveFolderId ?? null,
    driveFolderPath:
      row.driveFolderPath ?? (folderKey ? buildDriveFolderPath(folderKey) : null),
    driveWebViewLink: row.driveWebViewLink ?? null,
    driveVerifiedAt: row.driveVerifiedAt ? row.driveVerifiedAt.toISOString() : null,
    driveOwnerEmail: row.driveOwnerEmail ?? null,
    hasOriginalFile,
    originalFileStatusLabel: hasOriginalFile ? 'Đã lưu trên Google Drive' : 'Chưa có file gốc',
    extractedQuestionCount: extractedCount,
    approvedQuestionCount: approval.approvedQuestionCount,
    approvalStatus: approval.approvalStatus,
    approvalStatusLabel: approval.approvalStatusLabel,
    linkedDraftId: linkedDraft?.id ?? row.aiAgentHook?.lastJobId ?? null,
    recordOrigin: 'document',
    processingStatus: status,
    statusNote: row.statusNote,
    aiAgentHook: row.aiAgentHook,
    lastStatusUpdatedAt: row.lastStatusUpdatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeLegacyDraftAsLibraryItem(
  draft: QuestionImportDraftRecord
): TeacherDocumentRecord {
  const approval = computeApprovalStatus(draft)
  const mimeType =
    draft.sourceFormat === 'pdf'
      ? 'application/pdf'
      : draft.sourceFormat === 'txt'
      ? 'text/plain; charset=utf-8'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

  const hasIssues = draft.questions.some(
    (q) =>
      q.answerStatus === 'missing' ||
      q.answerStatus === 'ambiguous' ||
      q.answerStatus === 'needs_review'
  )

  return {
    id: `draft:${draft.id}`,
    ownerUid: draft.ownerUid,
    originalFilename: draft.sourceDocumentName || draft.title,
    fileExtension: draft.sourceFormat,
    mimeType,
    fileSizeBytes: 0,
    sha256: draft.sourceFileHash,
    storageProvider: 'google_drive',
    storageBucket: DRIVE_ROOT_FOLDER_NAME,
    storageKey: '',
    driveFileId: null,
    driveFolderKey: null,
    driveFolderId: null,
    driveFolderPath: null,
    driveWebViewLink: null,
    driveVerifiedAt: null,
    driveOwnerEmail: null,
    hasOriginalFile: false,
    originalFileStatusLabel: 'Chưa có file gốc',
    extractedQuestionCount: approval.extractedQuestionCount,
    approvedQuestionCount: approval.approvedQuestionCount,
    approvalStatus: approval.approvalStatus,
    approvalStatusLabel: approval.approvalStatusLabel,
    linkedDraftId: draft.id,
    recordOrigin: 'legacy_draft',
    processingStatus: hasIssues ? 'Needs review' : 'Completed',
    statusNote: `Bản nháp cũ từ PostgreSQL (${draft.title}) · Chưa gắn tệp gốc trên Google Drive.`,
    aiAgentHook: {
      schemaVersion: '1.0',
      agentTarget: 'tin-lab-document-ai-agent',
      readyForExtraction: false,
      queuedAt: null,
      lastJobId: draft.id,
      lastError: null,
      summaryMetadata: {
        detectedLanguage: 'vi',
        estimatedPages: null,
        extractedQuestionCount: draft.totalCount,
      },
    },
    lastStatusUpdatedAt: draft.updatedAt,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  }
}

function detectValidatedLibraryFile(
  filename: string,
  mimeType: string,
  buffer: Buffer
):
  | { ok: true; extension: DocumentFileExtension; canonicalMime: string }
  | { ok: false; code: string; error: string } {
  const lower = filename.toLowerCase().trim()

  if (lower.endsWith('.doc')) {
    return {
      ok: false,
      code: 'LEGACY_DOC_UNSUPPORTED',
      error:
        'Hệ thống chỉ hỗ trợ .pdf, .docx và .txt (không hỗ trợ định dạng .doc cũ). Vui lòng lưu lại dưới dạng .docx hoặc .pdf.',
    }
  }

  let expectedExt: DocumentFileExtension | null = null
  if (lower.endsWith('.pdf')) expectedExt = 'pdf'
  else if (lower.endsWith('.docx')) expectedExt = 'docx'
  else if (lower.endsWith('.txt')) expectedExt = 'txt'

  if (!expectedExt) {
    return {
      ok: false,
      code: 'UNSUPPORTED_FILE_TYPE',
      error: `Định dạng tệp "${filename}" không được hỗ trợ. Chỉ chấp nhận tệp .pdf, .docx hoặc .txt.`,
    }
  }

  if (buffer.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_FILE',
      error: `Tệp "${filename}" đang trống (0 byte).`,
    }
  }

  if (expectedExt === 'pdf') {
    const header = buffer.subarray(0, 5).toString('ascii')
    const allowedMimes = ['application/pdf', 'application/x-pdf', 'application/octet-stream']
    if (header !== '%PDF-' || (mimeType && !allowedMimes.includes(mimeType))) {
      return {
        ok: false,
        code: 'INVALID_PDF_SIGNATURE',
        error: `Tệp "${filename}" không có chữ ký PDF hợp lệ (%PDF-).`,
      }
    }
    return { ok: true, extension: 'pdf', canonicalMime: 'application/pdf' }
  }

  if (expectedExt === 'docx') {
    const isZipHeader =
      buffer.length >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
      (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)

    if (!isZipHeader) {
      return {
        ok: false,
        code: 'INVALID_DOCX_SIGNATURE',
        error: `Tệp "${filename}" không phải tệp DOCX hợp lệ.`,
      }
    }
    return {
      ok: true,
      extension: 'docx',
      canonicalMime:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }
  }

  if (buffer.includes(0x00)) {
    return {
      ok: false,
      code: 'INVALID_TXT_CONTENT',
      error: `Tệp "${filename}" chứa dữ liệu nhị phân, không phải văn bản thuần .txt hợp lệ.`,
    }
  }

  return { ok: true, extension: 'txt', canonicalMime: 'text/plain; charset=utf-8' }
}

app.get(
  '/api/drive/status',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store')
    try {
      const accessToken = extractDriveAccessToken(req)
      const drive = await buildGoogleDriveConnectionStatus({ accessToken })
      res.json({
        ok: true,
        drive,
        storage: getStorageConfigStatus(drive),
      })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : 'Không thể kiểm tra trạng thái kết nối Google Drive.',
      })
    }
  }
)

app.post(
  '/api/drive/init-folders',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store')
    const accessToken = extractDriveAccessToken(req)
    if (!accessToken) {
      res.status(401).json({
        ok: false,
        code: 'DRIVE_TOKEN_MISSING',
        error:
          'Chưa có phiên kết nối Google Drive. Vui lòng nhấn "Kết nối Google Drive" bằng tài khoản quản trị để khởi tạo cây thư mục.',
      })
      return
    }

    try {
      const identity = await verifyDriveTokenIdentity(accessToken)
      const ensured = await ensureDriveLibraryFolders(accessToken, identity.emailAddress)
      const drive = await buildGoogleDriveConnectionStatus({ accessToken })
      res.json({
        ok: true,
        accountEmail: identity.emailAddress,
        rootFolder: ensured.rootFolder,
        folders: ensured.folders,
        drive,
      })
    } catch (err) {
      const status = err instanceof GoogleDriveError ? err.statusCode : 502
      res.status(status).json({
        ok: false,
        code: err instanceof GoogleDriveError ? err.code : 'DRIVE_INIT_FAILED',
        error:
          err instanceof Error
            ? err.message
            : 'Không thể khởi tạo cây thư mục trên Google Drive.',
      })
    }
  }
)

app.post(
  '/api/drive/self-test',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store')
    const accessToken = extractDriveAccessToken(req)
    if (!accessToken) {
      res.status(401).json({
        ok: false,
        code: 'DRIVE_TOKEN_MISSING',
        error:
          'Chưa có phiên kết nối Google Drive. Vui lòng nhấn "Kết nối Google Drive" trước khi chạy kiểm thử tải lên và đọc lại.',
      })
      return
    }

    const steps: GoogleDriveSelfTestResult['steps'] = []
    try {
      // Step 1: Verify Drive token identity
      const identity = await verifyDriveTokenIdentity(accessToken)
      steps.push({
        step: 'Xác thực OAuth Google Drive API',
        status: 'passed',
        detail: `Đã xác thực tài khoản ${identity.emailAddress} với phạm vi drive.file.`,
      })

      // Step 2: Ensure folder tree
      const ensured = await ensureDriveLibraryFolders(accessToken, identity.emailAddress)
      const targetFolder = ensured.folderMap['01_TAI_LIEU_GOC']
      steps.push({
        step: 'Kiểm tra / tạo cây thư mục thư viện',
        status: 'passed',
        detail: `Đã xác nhận thư mục gốc "${ensured.rootFolder.folderName}" và 5 thư mục con (lưu Folder ID vào PostgreSQL).`,
      })

      // Step 3: Build sample valid DOCX & resumable upload + read-back verification
      const now = new Date()
      const stamp = now
        .toISOString()
        .replace(/[-:]/g, '')
        .replace('T', '_')
        .slice(0, 15)
      const sampleFilename = `TINLAB_KiemThu_Drive_${stamp}.docx`
      const sampleMime =
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      const sampleBuffer = await buildSampleVerificationDocxBuffer({
        accountEmail: identity.emailAddress,
        folderPath: targetFolder.folderPath,
        testedAtIso: now.toISOString(),
      })

      const documentId = crypto.randomUUID()
      const uploaded = await uploadFileToDriveResumable({
        accessToken,
        folderId: targetFolder.driveFolderId,
        filename: sampleFilename,
        mimeType: sampleMime,
        buffer: sampleBuffer,
        appProperties: {
          documentId,
          folderKey: '01_TAI_LIEU_GOC',
          selfTest: 'true',
        },
      })

      steps.push({
        step: 'Tải lên tệp DOCX mẫu (Resumable Upload)',
        status: 'passed',
        detail: `Đã tải "${sampleFilename}" (${uploaded.sizeBytes} byte) vào ${targetFolder.folderPath} (Drive File ID: ${uploaded.fileId}).`,
      })

      steps.push({
        step: 'Đọc lại tệp từ Google Drive & đối chiếu toàn vẹn',
        status: 'passed',
        detail: `Đọc lại thành công ${uploaded.readBackSizeBytes} byte · Khớp dung lượng & SHA-256 (${uploaded.sha256.slice(0, 16)}…).`,
      })

      // Step 4: Save metadata into PostgreSQL teacher_documents
      const storageKey = buildDocumentStorageKey({
        folderKey: '01_TAI_LIEU_GOC',
        documentId,
        safeFilename: sampleFilename,
      })

      const docRow = await createTeacherDocumentRecord({
        id: documentId,
        ownerUid: req.dbUser!.uid,
        originalFilename: sampleFilename,
        fileExtension: 'docx',
        mimeType: sampleMime,
        fileSizeBytes: uploaded.sizeBytes,
        sha256: uploaded.sha256,
        storageProvider: 'google_drive',
        storageBucket: DRIVE_ROOT_FOLDER_NAME,
        storageKey,
        driveFileId: uploaded.fileId,
        driveFolderKey: '01_TAI_LIEU_GOC',
        driveFolderId: targetFolder.driveFolderId,
        driveFolderPath: targetFolder.folderPath,
        driveWebViewLink: uploaded.webViewLink,
        driveVerifiedAt: uploaded.verifiedAt,
        driveOwnerEmail: identity.emailAddress,
        processingStatus: 'Uploaded',
        statusNote: 'Tệp DOCX kiểm thử kết nối Google Drive API — đã xác minh đọc lại thành công.',
        aiAgentHook: createInitialAiAgentHook(),
      })

      steps.push({
        step: 'Lưu Drive File ID và metadata vào PostgreSQL',
        status: 'passed',
        detail: `Đã lưu bản ghi tài liệu ${docRow.id} vào bảng teacher_documents.`,
      })

      const drive = await buildGoogleDriveConnectionStatus({ accessToken })
      const result: GoogleDriveSelfTestResult = {
        ok: true,
        testedAt: now.toISOString(),
        accountEmail: identity.emailAddress,
        rootFolderPath: ensured.rootFolder.folderPath,
        targetFolderKey: '01_TAI_LIEU_GOC',
        targetFolderPath: targetFolder.folderPath,
        targetFolderId: targetFolder.driveFolderId,
        uploadedFileId: uploaded.fileId,
        uploadedFileName: sampleFilename,
        uploadedSizeBytes: uploaded.sizeBytes,
        readBackSizeBytes: uploaded.readBackSizeBytes,
        sizeMatched: uploaded.sizeMatched,
        sha256Matched: uploaded.sha256Matched,
        sha256: uploaded.sha256,
        mimeType: sampleMime,
        webViewLink: uploaded.webViewLink,
        documentId: docRow.id,
        steps,
      }

      res.json({
        ok: true,
        result,
        drive,
        document: serializeDocumentRecord(docRow, null),
      })
    } catch (err) {
      const status = err instanceof GoogleDriveError ? err.statusCode : 502
      const message =
        err instanceof Error
          ? err.message
          : 'Kiểm thử tải lên và đọc lại Google Drive thất bại.'
      steps.push({
        step: 'Kiểm thử Google Drive',
        status: 'failed',
        detail: message,
      })
      res.status(status).json({
        ok: false,
        code: err instanceof GoogleDriveError ? err.code : 'DRIVE_SELF_TEST_FAILED',
        error: message,
        steps,
      })
    }
  }
)

app.get(
  '/api/teacher/documents',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store')
    const accessToken = extractDriveAccessToken(req)
    try {
      const [driveStatus, docRows, draftRows] = await Promise.all([
        buildGoogleDriveConnectionStatus({ accessToken }),
        listAllTeacherDocuments(),
        listQuestionImportDraftsByOwner(),
      ])

      const storage = getStorageConfigStatus(driveStatus)

      // Map drafts to libraryDocumentId (latest draft per document)
      const draftByDocId = new Map<string, QuestionImportDraftRecord>()
      for (const draft of draftRows) {
        if (draft.libraryDocumentId && !draftByDocId.has(draft.libraryDocumentId)) {
          draftByDocId.set(draft.libraryDocumentId, draft)
        }
      }

      const existingDocIds = new Set(docRows.map((d) => d.id))
      const serializedDocs = docRows.map((row) =>
        serializeDocumentRecord(row, draftByDocId.get(row.id) ?? null)
      )

      // Include legacy drafts that have no original Drive document so teachers see real PostgreSQL data
      // honestly labeled "Chưa có file gốc" (never faking Drive files!)
      const legacyDraftDocs = draftRows
        .filter((d) => !d.libraryDocumentId || !existingDocIds.has(d.libraryDocumentId))
        .map(serializeLegacyDraftAsLibraryItem)

      const combined = [...serializedDocs, ...legacyDraftDocs].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )

      res.json({
        ok: true,
        storage,
        drive: driveStatus,
        documents: combined,
      })
    } catch (err) {
      res.status(500).json({
        ok: false,
        storage: getStorageConfigStatus(),
        error: err instanceof Error ? err.message : 'Không thể tải danh sách tài liệu.',
      })
    }
  }
)

app.post(
  '/api/teacher/documents/upload',
  requireAuth,
  requireSuperAdminRole,
  (req: AuthRequest, res: Response) => {
    const accessToken = extractDriveAccessToken(req)
    if (!accessToken) {
      res.status(401).json({
        ok: false,
        code: 'DRIVE_TOKEN_MISSING',
        error:
          'Chưa kết nối Google Drive trong phiên này. Vui lòng nhấn "Kết nối Google Drive" bằng tài khoản quản trị trước khi tải tệp lên.',
      })
      return
    }

    documentLibraryUpload.array('documents', MAX_LIBRARY_FILES_PER_BATCH)(
      req,
      res,
      async (uploadErr: unknown) => {
        if (uploadErr) {
          if (uploadErr instanceof multer.MulterError) {
            if (uploadErr.code === 'LIMIT_FILE_SIZE') {
              res.status(413).json({
                ok: false,
                code: 'FILE_TOO_LARGE',
                error: 'Có tệp vượt quá dung lượng tối đa cho phép (20 MB / tệp).',
              })
              return
            }
            if (uploadErr.code === 'LIMIT_FILE_COUNT' || uploadErr.code === 'LIMIT_UNEXPECTED_FILE') {
              res.status(400).json({
                ok: false,
                code: 'TOO_MANY_FILES',
                error: `Tối đa ${MAX_LIBRARY_FILES_PER_BATCH} tệp trong một lần tải lên.`,
              })
              return
            }
          }
          res.status(400).json({
            ok: false,
            code: 'UPLOAD_ERROR',
            error: 'Không thể tiếp nhận tệp tải lên. Vui lòng kiểm tra lại.',
          })
          return
        }

        const files = Array.isArray(req.files) ? req.files : []
        if (files.length === 0) {
          res.status(400).json({
            ok: false,
            code: 'MISSING_FILES',
            error: 'Vui lòng chọn ít nhất một tệp PDF, DOCX hoặc TXT để tải lên.',
          })
          return
        }

        const body = (req.body ?? {}) as Record<string, unknown>
        const targetFolderKey: DriveSubfolderKey = isValidDriveSubfolderKey(body.folderKey)
          ? body.folderKey
          : '01_TAI_LIEU_GOC'

        let identity
        let ensuredFolders
        try {
          identity = await verifyDriveTokenIdentity(accessToken)
          ensuredFolders = await ensureDriveLibraryFolders(accessToken, identity.emailAddress)
        } catch (driveErr) {
          const status = driveErr instanceof GoogleDriveError ? driveErr.statusCode : 502
          res.status(status).json({
            ok: false,
            code: driveErr instanceof GoogleDriveError ? driveErr.code : 'DRIVE_AUTH_FAILED',
            error:
              driveErr instanceof Error
                ? driveErr.message
                : 'Không thể xác thực hoặc khởi tạo thư mục trên Google Drive.',
          })
          return
        }

        const targetFolder = ensuredFolders.folderMap[targetFolderKey]
        const uploaded: TeacherDocumentRecord[] = []
        const errors: { filename: string; code: string; error: string }[] = []

        for (const file of files) {
          const originalFilename = decodeUploadFilename(file.originalname || 'tai-lieu')
          const validation = detectValidatedLibraryFile(
            originalFilename,
            file.mimetype || '',
            file.buffer
          )

          if (!validation.ok) {
            errors.push({
              filename: originalFilename,
              code: validation.code,
              error: validation.error,
            })
            continue
          }

          const documentId = crypto.randomUUID()
          const storageKey = buildDocumentStorageKey({
            folderKey: targetFolderKey,
            documentId,
            safeFilename: originalFilename,
          })

          let driveUpload
          try {
            driveUpload = await uploadFileToDriveResumable({
              accessToken,
              folderId: targetFolder.driveFolderId,
              filename: originalFilename,
              mimeType: validation.canonicalMime,
              buffer: file.buffer,
              appProperties: {
                documentId,
                folderKey: targetFolderKey,
                ownerUid: req.dbUser!.uid,
              },
            })
          } catch (storageErr) {
            console.error(
              '[TIN LAB] Google Drive upload failed:',
              storageErr instanceof Error ? storageErr.message : storageErr
            )
            errors.push({
              filename: originalFilename,
              code:
                storageErr instanceof GoogleDriveError
                  ? storageErr.code
                  : 'DRIVE_UPLOAD_FAILED',
              error:
                storageErr instanceof Error
                  ? storageErr.message
                  : `Không thể tải tệp "${originalFilename}" lên Google Drive.`,
            })
            continue
          }

          try {
            const record = await createTeacherDocumentRecord({
              id: documentId,
              ownerUid: req.dbUser!.uid,
              originalFilename,
              fileExtension: validation.extension,
              mimeType: validation.canonicalMime,
              fileSizeBytes: driveUpload.sizeBytes,
              sha256: driveUpload.sha256,
              storageProvider: 'google_drive',
              storageBucket: DRIVE_ROOT_FOLDER_NAME,
              storageKey,
              driveFileId: driveUpload.fileId,
              driveFolderKey: targetFolderKey,
              driveFolderId: targetFolder.driveFolderId,
              driveFolderPath: targetFolder.folderPath,
              driveWebViewLink: driveUpload.webViewLink,
              driveVerifiedAt: driveUpload.verifiedAt,
              driveOwnerEmail: identity.emailAddress,
              processingStatus: 'Uploaded',
              statusNote: `Đã lưu và xác minh đọc lại trên Google Drive (${targetFolder.folderPath}).`,
              aiAgentHook: createInitialAiAgentHook(),
            })
            uploaded.push(serializeDocumentRecord(record, null))
          } catch (dbErr) {
            // Roll back Google Drive upload to avoid orphan files
            try {
              await trashDriveFile(accessToken, driveUpload.fileId)
            } catch {
              // Best-effort cleanup
            }
            errors.push({
              filename: originalFilename,
              code: 'DATABASE_SAVE_FAILED',
              error:
                dbErr instanceof Error
                  ? dbErr.message
                  : `Không thể lưu metadata tệp "${originalFilename}" vào PostgreSQL.`,
            })
          }
        }

        if (uploaded.length === 0 && errors.length > 0) {
          res.status(400).json({
            ok: false,
            code: errors[0].code,
            error: errors[0].error,
            uploaded,
            errors,
          })
          return
        }

        res.status(uploaded.length > 0 ? 201 : 400).json({
          ok: uploaded.length > 0,
          uploaded,
          errors,
        })
      }
    )
  }
)

app.get(
  '/api/teacher/documents/:id/preview',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const docId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    if (!UUID_REGEX.test(docId)) {
      res.status(400).json({ ok: false, error: 'Mã tài liệu không hợp lệ.' })
      return
    }

    const accessToken = extractDriveAccessToken(req)
    if (!accessToken) {
      res.status(401).json({
        ok: false,
        code: 'DRIVE_TOKEN_MISSING',
        error:
          'Vui lòng nhấn "Kết nối Google Drive" để đọc nội dung xem trước tệp gốc từ Google Drive.',
      })
      return
    }

    try {
      const doc = await getTeacherDocumentById(docId)
      if (!doc) {
        res.status(404).json({ ok: false, error: 'Không tìm thấy tài liệu.' })
        return
      }
      if (!doc.driveFileId) {
        res.status(404).json({
          ok: false,
          code: 'NO_DRIVE_ORIGINAL_FILE',
          error: 'Tài liệu này chưa có file gốc trên Google Drive.',
        })
        return
      }

      const buffer = await downloadDriveFileBuffer(accessToken, doc.driveFileId)

      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Cache-Control', 'private, no-store')

      if (doc.fileExtension === 'pdf') {
        const encodedName = encodeURIComponent(doc.originalFilename)
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedName}`)
        res.send(buffer)
        return
      }

      if (doc.fileExtension === 'txt') {
        const text = buffer.toString('utf8')
        res.json({
          ok: true,
          previewType: 'text',
          filename: doc.originalFilename,
          text,
        })
        return
      }

      const extracted = await mammoth.extractRawText({ buffer })
      res.json({
        ok: true,
        previewType: 'text',
        filename: doc.originalFilename,
        text: extracted.value || '(Tài liệu DOCX không có nội dung văn bản thuần)',
      })
    } catch (err) {
      console.error('[TIN LAB] Document preview failed:', err instanceof Error ? err.message : err)
      const status = err instanceof GoogleDriveError ? err.statusCode : 502
      res.status(status).json({
        ok: false,
        code: err instanceof GoogleDriveError ? err.code : 'DRIVE_PREVIEW_FAILED',
        error:
          err instanceof Error
            ? err.message
            : 'Không thể đọc tệp từ Google Drive để xem trước.',
      })
    }
  }
)

app.get(
  '/api/teacher/documents/:id/download',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const docId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    if (!UUID_REGEX.test(docId)) {
      res.status(400).json({ ok: false, error: 'Mã tài liệu không hợp lệ.' })
      return
    }

    const accessToken = extractDriveAccessToken(req)
    if (!accessToken) {
      res.status(401).json({
        ok: false,
        code: 'DRIVE_TOKEN_MISSING',
        error:
          'Vui lòng nhấn "Kết nối Google Drive" để tải xuống tệp gốc từ Google Drive.',
      })
      return
    }

    try {
      const doc = await getTeacherDocumentById(docId)
      if (!doc) {
        res.status(404).json({ ok: false, error: 'Không tìm thấy tài liệu.' })
        return
      }
      if (!doc.driveFileId) {
        res.status(404).json({
          ok: false,
          code: 'NO_DRIVE_ORIGINAL_FILE',
          error: 'Tài liệu này chưa có file gốc trên Google Drive.',
        })
        return
      }

      const buffer = await downloadDriveFileBuffer(accessToken, doc.driveFileId)

      const encodedName = encodeURIComponent(doc.originalFilename)
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('Content-Type', doc.mimeType)
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedName}`)
      res.send(buffer)
    } catch (err) {
      console.error('[TIN LAB] Document download failed:', err instanceof Error ? err.message : err)
      const status = err instanceof GoogleDriveError ? err.statusCode : 502
      res.status(status).json({
        ok: false,
        code: err instanceof GoogleDriveError ? err.code : 'DRIVE_DOWNLOAD_FAILED',
        error:
          err instanceof Error
            ? err.message
            : 'Không thể tải xuống tệp từ Google Drive lúc này.',
      })
    }
  }
)

app.delete(
  '/api/teacher/documents/:id',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const docId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    if (!UUID_REGEX.test(docId)) {
      res.status(400).json({ ok: false, error: 'Mã tài liệu không hợp lệ.' })
      return
    }

    try {
      const doc = await getTeacherDocumentById(docId)
      if (!doc) {
        res.status(404).json({ ok: false, error: 'Không tìm thấy tài liệu.' })
        return
      }

      if (doc.driveFileId) {
        const accessToken = extractDriveAccessToken(req)
        if (!accessToken) {
          res.status(401).json({
            ok: false,
            code: 'DRIVE_TOKEN_MISSING',
            error:
              'Vui lòng kết nối Google Drive trước khi chuyển tệp gốc vào thùng rác Google Drive.',
          })
          return
        }
        await trashDriveFile(accessToken, doc.driveFileId)
      }

      await deleteTeacherDocumentById(doc.id)
      res.json({ ok: true, id: doc.id })
    } catch (err) {
      console.error('[TIN LAB] Document delete failed:', err instanceof Error ? err.message : err)
      const status = err instanceof GoogleDriveError ? err.statusCode : 502
      res.status(status).json({
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : 'Không thể xóa tài liệu khỏi Google Drive hoặc PostgreSQL.',
      })
    }
  }
)

app.post(
  '/api/teacher/documents/:id/queue-analysis',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const docId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    if (!UUID_REGEX.test(docId)) {
      res.status(400).json({ ok: false, error: 'Mã tài liệu không hợp lệ.' })
      return
    }

    try {
      const doc = await getTeacherDocumentById(docId)
      if (!doc) {
        res.status(404).json({ ok: false, error: 'Không tìm thấy tài liệu.' })
        return
      }

      const updatedHook = createQueuedAiAgentHook(doc.aiAgentHook)
      const updated = await updateTeacherDocumentStatus({
        documentId: doc.id,
        processingStatus: 'Pending analysis',
        statusNote: 'Đã đánh dấu chờ TIN LAB Document AI Agent trích xuất từ Google Drive.',
        aiAgentHook: updatedHook,
      })

      if (!updated) {
        res.status(404).json({ ok: false, error: 'Không tìm thấy tài liệu để cập nhật.' })
        return
      }

      const serialized = serializeDocumentRecord(updated, null)
      const contract = buildDocumentAiInputContract({
        id: serialized.id,
        ownerUid: serialized.ownerUid,
        originalFilename: serialized.originalFilename,
        fileExtension: serialized.fileExtension,
        mimeType: serialized.mimeType,
        sha256: serialized.sha256,
        storageProvider: serialized.storageProvider,
        storageBucket: serialized.storageBucket,
        storageKey: serialized.storageKey,
      })

      res.json({
        ok: true,
        document: serialized,
        aiAgentInputContract: contract,
      })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Không thể chuyển trạng thái chờ phân tích.',
      })
    }
  }
)

app.patch(
  '/api/teacher/documents/:id/status',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const docId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    if (!UUID_REGEX.test(docId)) {
      res.status(400).json({ ok: false, error: 'Mã tài liệu không hợp lệ.' })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const nextStatus = typeof body.processingStatus === 'string' ? body.processingStatus.trim() : ''
    const statusNote =
      typeof body.statusNote === 'string' ? body.statusNote.trim().slice(0, 500) : ''

    if (!isValidDocumentStatus(nextStatus)) {
      res.status(400).json({
        ok: false,
        error:
          'Trạng thái xử lý không hợp lệ. Giá trị hợp lệ: Uploaded, Pending analysis, Processing, Completed, Needs review, Failed.',
      })
      return
    }

    try {
      const doc = await getTeacherDocumentById(docId)
      if (!doc) {
        res.status(404).json({ ok: false, error: 'Không tìm thấy tài liệu.' })
        return
      }

      const updated = await updateTeacherDocumentStatus({
        documentId: doc.id,
        processingStatus: nextStatus,
        statusNote,
        aiAgentHook: doc.aiAgentHook,
      })

      res.json({
        ok: true,
        document: updated ? serializeDocumentRecord(updated, null) : null,
      })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Không thể cập nhật trạng thái tài liệu.',
      })
    }
  }
)

/* ============================================================================
 * EXISTING TIN LAB ROUTES (SECURED WITH TEACHER RBAC WHERE APPLICABLE)
 * ========================================================================== */

app.post('/api/contact', async (req: Request, res: Response) => {
  const ip = getClientIp(req)
  const limit = checkRateLimit(ip)
  if (!limit.allowed) {
    res.status(429).json({
      ok: false,
      code: 'RATE_LIMITED',
      error: `Bạn đã gửi quá nhiều yêu cầu liên hệ. Vui lòng thử lại sau ${limit.retryAfterSeconds} giây.`,
    })
    return
  }

  const body = (req.body ?? {}) as Record<string, unknown>

  // Honeypot anti-spam check
  if (typeof body.website === 'string' && body.website.trim().length > 0) {
    res.status(400).json({
      ok: false,
      code: 'SPAM_DETECTED',
      error: 'Yêu cầu không hợp lệ do hệ thống phát hiện dấu hiệu gửi tự động.',
    })
    return
  }

  // Minimum human interaction time check
  if (typeof body.formStartedAt === 'number' && Number.isFinite(body.formStartedAt)) {
    const elapsedMs = Date.now() - body.formStartedAt
    if (elapsedMs < 1200) {
      res.status(400).json({
        ok: false,
        code: 'TOO_FAST',
        error: 'Thao tác gửi quá nhanh. Vui lòng kiểm tra lại thông tin trước khi gửi.',
      })
      return
    }
  }

  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''

  const fieldErrors: Record<string, string> = {}

  if (fullName.length < 2 || fullName.length > 100) {
    fieldErrors.fullName = 'Vui lòng nhập họ và tên hợp lệ (từ 2 đến 100 ký tự).'
  }
  if (!EMAIL_REGEX.test(email) || email.length > 150) {
    fieldErrors.email = 'Vui lòng nhập địa chỉ email hợp lệ.'
  }
  if (phone.length > 0 && !PHONE_REGEX.test(phone)) {
    fieldErrors.phone = 'Số điện thoại không đúng định dạng (8–20 ký tự số).'
  }
  if (subject.length < 3 || subject.length > 150) {
    fieldErrors.subject = 'Vui lòng nhập chủ đề (từ 3 đến 150 ký tự).'
  }
  if (message.length < 10 || message.length > 3000) {
    fieldErrors.message = 'Nội dung tin nhắn phải có từ 10 đến 3000 ký tự.'
  }

  if (Object.keys(fieldErrors).length > 0) {
    res.status(400).json({
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Thông tin biểu mẫu chưa hợp lệ. Vui lòng kiểm tra các trường được đánh dấu.',
      fieldErrors,
    })
    return
  }

  const smtpHost = process.env.SMTP_HOST?.trim()
  const smtpPort = Number(process.env.SMTP_PORT || '587')
  const smtpSecure = process.env.SMTP_SECURE === 'true' || smtpPort === 465
  const smtpUser = process.env.SMTP_USER?.trim()
  const smtpPass = process.env.SMTP_PASS?.trim()
  const smtpFrom = process.env.SMTP_FROM?.trim() || smtpUser
  const contactTo = process.env.CONTACT_TO_EMAIL?.trim() || 'sunghiep.tsbd@gmail.com'

  if (!smtpHost || !smtpUser || !smtpPass || !smtpFrom) {
    res.status(503).json({
      ok: false,
      code: 'EMAIL_NOT_CONFIGURED',
      error:
        'Hệ thống gửi email trên máy chủ chưa được cấu hình (thiếu SMTP_HOST, SMTP_USER hoặc SMTP_PASS). Tin nhắn chưa được gửi đi — cần hoàn tất cấu hình dịch vụ email phía backend.',
    })
    return
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: Number.isFinite(smtpPort) ? smtpPort : 587,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    })

    const submittedAt = new Date().toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
    })

    const textContent = [
      'TIN LAB – Liên hệ mới từ biểu mẫu trên hệ thống',
      '--------------------------------------------------',
      `Họ và tên: ${fullName}`,
      `Email: ${email}`,
      `Số điện thoại: ${phone || 'Không cung cấp'}`,
      `Chủ đề: ${subject}`,
      `Thời gian gửi: ${submittedAt}`,
      '',
      'Nội dung tin nhắn:',
      message,
    ].join('\n')

    const htmlContent = `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; line-height: 1.6; max-width: 640px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
        <div style="background: #0b1f3a; color: #ffffff; padding: 20px 24px;">
          <div style="font-size: 12px; letter-spacing: 0.08em; color: #7dd3fc; font-weight: 700;">TIN LAB · TIN HỌC 12</div>
          <h2 style="margin: 6px 0 0; font-size: 18px;">Liên hệ mới từ người dùng</h2>
        </div>
        <div style="padding: 24px; background: #ffffff;">
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px;">
            <tr>
              <td style="padding: 8px 0; color: #475569; width: 140px; vertical-align: top;">Họ và tên:</td>
              <td style="padding: 8px 0; font-weight: 600;">${escapeHtml(fullName)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #475569; vertical-align: top;">Email:</td>
              <td style="padding: 8px 0;">${escapeHtml(email)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #475569; vertical-align: top;">Số điện thoại:</td>
              <td style="padding: 8px 0;">${escapeHtml(phone || 'Không cung cấp')}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #475569; vertical-align: top;">Chủ đề:</td>
              <td style="padding: 8px 0; font-weight: 600;">${escapeHtml(subject)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #475569; vertical-align: top;">Thời gian:</td>
              <td style="padding: 8px 0;">${escapeHtml(submittedAt)}</td>
            </tr>
          </table>
          <div style="padding: 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; white-space: pre-wrap; font-size: 14px;">${escapeHtml(message)}</div>
        </div>
      </div>
    `

    await transporter.sendMail({
      from: `TIN LAB Support <${smtpFrom}>`,
      to: contactTo,
      replyTo: `${fullName} <${email}>`,
      subject: `[TIN LAB] ${subject}`,
      text: textContent,
      html: htmlContent,
    })

    res.status(200).json({
      ok: true,
      message: `Đã gửi liên hệ thành công tới ${contactTo}. Chúng tôi sẽ phản hồi qua email trong thời gian sớm nhất.`,
    })
  } catch (err) {
    console.error('[TIN LAB] Contact email delivery failed:', err instanceof Error ? err.message : err)
    res.status(502).json({
      ok: false,
      code: 'EMAIL_SEND_FAILED',
      error:
        'Không thể kết nối tới máy chủ gửi email SMTP. Vui lòng kiểm tra lại cấu hình SMTP hoặc thử lại sau.',
    })
  }
})

const MAX_QUESTION_FILE_BYTES = 20 * 1024 * 1024

const questionBankUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_QUESTION_FILE_BYTES,
    files: 2,
  },
})

const agentMultiUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_QUESTION_FILE_BYTES,
    files: 20,
  },
})

function resolveDocumentFormat(fileName: string, mimeType: string): SourceFileFormat | null {
  const lower = fileName.toLowerCase().trim()
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.txt')) return 'txt'
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'docx'
  }
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.startsWith('text/plain')) return 'txt'
  return null
}

function parsePreferredTypesParam(raw: unknown): QuestionType[] {
  const valid: QuestionType[] = ['multiple_choice', 'true_false', 'essay']
  if (Array.isArray(raw)) {
    const filtered = raw.filter((v): v is QuestionType =>
      typeof v === 'string' && valid.includes(v as QuestionType)
    )
    return filtered.length > 0 ? filtered : valid
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter((v): v is QuestionType =>
          typeof v === 'string' && valid.includes(v as QuestionType)
        )
        if (filtered.length > 0) return filtered
      }
    } catch {
      const split = raw
        .split(',')
        .map((s) => s.trim())
        .filter((v): v is QuestionType => valid.includes(v as QuestionType))
      if (split.length > 0) return split
    }
  }
  return valid
}

async function resolveUploadedOrLibraryDocument(params: {
  uploadedFile?: Express.Multer.File
  libraryDocumentId?: string
  ownerUid: string
  fieldLabel: string
  driveAccessToken?: string
}): Promise<
  | {
      ok: true
      buffer: Buffer
      fileName: string
      fileFormat: SourceFileFormat
      libraryDocumentId: string | null
    }
  | { ok: false; status: number; code: string; error: string }
> {
  if (params.uploadedFile && params.uploadedFile.buffer && params.uploadedFile.buffer.length > 0) {
    const originalName = decodeUploadFilename(params.uploadedFile.originalname || 'tai-lieu')
    if (originalName.toLowerCase().endsWith('.doc')) {
      return {
        ok: false,
        status: 415,
        code: 'LEGACY_DOC_UNSUPPORTED',
        error: `${params.fieldLabel}: Hệ thống chỉ hỗ trợ .docx, .pdf hoặc .txt (không hỗ trợ tệp .doc cũ).`,
      }
    }
    const format = resolveDocumentFormat(originalName, params.uploadedFile.mimetype || '')
    if (!format) {
      return {
        ok: false,
        status: 415,
        code: 'UNSUPPORTED_FORMAT',
        error: `${params.fieldLabel}: Định dạng tệp không hợp lệ. Chỉ chấp nhận .docx, .pdf hoặc .txt.`,
      }
    }
    return {
      ok: true,
      buffer: params.uploadedFile.buffer,
      fileName: originalName,
      fileFormat: format,
      libraryDocumentId: null,
    }
  }

  if (params.libraryDocumentId && UUID_REGEX.test(params.libraryDocumentId)) {
    const doc = await getTeacherDocumentById(params.libraryDocumentId)
    if (!doc) {
      return {
        ok: false,
        status: 404,
        code: 'LIBRARY_DOC_NOT_FOUND',
        error: `${params.fieldLabel}: Không tìm thấy tài liệu trong Thư viện Tài liệu.`,
      }
    }
    if (!doc.driveFileId) {
      return {
        ok: false,
        status: 404,
        code: 'NO_DRIVE_ORIGINAL_FILE',
        error: `${params.fieldLabel}: Tài liệu "${doc.originalFilename}" chưa có file gốc trên Google Drive.`,
      }
    }
    const driveToken = params.driveAccessToken?.trim() || ''
    if (!driveToken) {
      return {
        ok: false,
        status: 401,
        code: 'DRIVE_TOKEN_MISSING',
        error: `${params.fieldLabel}: Vui lòng nhấn "Kết nối Google Drive" trong mục Thư viện Tài liệu để AI Agent đọc tệp gốc từ Google Drive.`,
      }
    }
    try {
      const buffer = await downloadDriveFileBuffer(driveToken, doc.driveFileId)
      const format: SourceFileFormat =
        doc.fileExtension === 'pdf' || doc.fileExtension === 'txt' ? doc.fileExtension : 'docx'
      return {
        ok: true,
        buffer,
        fileName: doc.originalFilename,
        fileFormat: format,
        libraryDocumentId: doc.id,
      }
    } catch (err) {
      const status = err instanceof GoogleDriveError ? err.statusCode : 502
      return {
        ok: false,
        status,
        code: err instanceof GoogleDriveError ? err.code : 'DRIVE_READ_FAILED',
        error:
          err instanceof Error
            ? `${params.fieldLabel}: ${err.message}`
            : `${params.fieldLabel}: Không thể đọc tệp gốc từ Google Drive.`,
      }
    }
  }

  return {
    ok: false,
    status: 400,
    code: 'MISSING_FILE',
    error: `${params.fieldLabel}: Vui lòng chọn tệp .docx, .pdf hoặc .txt.`,
  }
}

const IMPORT_STEP_LABELS: Record<ImportStepCode, string> = {
  read_file: 'Không đọc được file',
  parse_docx: 'Không nhận diện được DOCX',
  extract_structure: 'Không tìm thấy cấu trúc câu hỏi',
  ai_extract: 'Gemini API lỗi',
  match_answers: 'Không tìm thấy đáp án',
  save_draft: 'Lỗi lưu dữ liệu',
  completed: 'Hoàn tất xử lý',
}

interface InternalImportJob {
  ownerUid: string
  createdAt: number
  snapshot: ImportJobSnapshot
}

const importJobsStore = new Map<string, InternalImportJob>()
const IMPORT_JOB_TTL_MS = 30 * 60 * 1000

function pruneExpiredImportJobs() {
  const cutoff = Date.now() - IMPORT_JOB_TTL_MS
  for (const [id, entry] of importJobsStore.entries()) {
    if (entry.createdAt < cutoff) {
      importJobsStore.delete(id)
    }
  }
}

function classifyImportError(err: unknown): {
  step: ImportStepCode
  stepLabel: string
  code: string
  status: number
  message: string
} {
  if (err instanceof DocumentParserError) {
    return {
      step: err.step,
      stepLabel: IMPORT_STEP_LABELS[err.step],
      code: err.code,
      status: 422,
      message: err.message,
    }
  }
  if (err instanceof AiExtractionError) {
    return {
      step: err.step,
      stepLabel: IMPORT_STEP_LABELS[err.step],
      code: err.code,
      status: err.statusCode || 422,
      message: err.message,
    }
  }
  const msg = err instanceof Error ? err.message : 'Lỗi không xác định khi xử lý tài liệu.'
  let step: ImportStepCode = 'extract_structure'
  if (/file|tệp|storage|trống|0 byte/i.test(msg)) {
    step = 'read_file'
  } else if (/docx|zip|word|document\.xml|mật khẩu/i.test(msg)) {
    step = 'parse_docx'
  } else if (/gemini|api|json|quota|429|timeout/i.test(msg)) {
    step = 'ai_extract'
  } else if (/postgres|sql|database|lưu|draft|bản nháp/i.test(msg)) {
    step = 'save_draft'
  }
  return {
    step,
    stepLabel: IMPORT_STEP_LABELS[step],
    code: 'PARSE_FAILED',
    status: 422,
    message: msg,
  }
}

app.get(
  '/api/question-bank/jobs/:jobId',
  requireAuth,
  requireSuperAdminRole,
  (req: AuthRequest, res: Response) => {
    pruneExpiredImportJobs()
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
    const entry = importJobsStore.get(jobId)
    if (!entry || entry.ownerUid !== req.dbUser!.uid) {
      res.status(404).json({
        ok: false,
        step: 'read_file',
        stepLabel: IMPORT_STEP_LABELS.read_file,
        code: 'JOB_NOT_FOUND',
        error: 'Không tìm thấy phiên xử lý tài liệu (có thể đã hết hạn hoặc máy chủ vừa khởi động lại).',
      })
      return
    }
    res.json({ ok: true, job: entry.snapshot })
  }
)

app.post(
  '/api/question-bank/parse',
  requireAuth,
  requireSuperAdminRole,
  (req: AuthRequest, res: Response) => {
    questionBankUpload.fields([
      { name: 'document', maxCount: 1 },
      { name: 'answerDocument', maxCount: 1 },
    ])(req, res, async (uploadErr: unknown) => {
      if (uploadErr) {
        if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            ok: false,
            step: 'read_file',
            stepLabel: IMPORT_STEP_LABELS.read_file,
            code: 'FILE_TOO_LARGE',
            error: 'Không đọc được file: Tệp tải lên vượt quá giới hạn tối đa 20 MB.',
          })
          return
        }
        res.status(400).json({
          ok: false,
          step: 'read_file',
          stepLabel: IMPORT_STEP_LABELS.read_file,
          code: 'UPLOAD_ERROR',
          error: 'Không đọc được file: Không thể tiếp nhận tệp tải lên. Vui lòng thử lại.',
        })
        return
      }

      const filesMap = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>
      const body = (req.body ?? {}) as Record<string, unknown>

      const libraryDocumentId =
        typeof body.libraryDocumentId === 'string' ? body.libraryDocumentId.trim() : ''
      const answerLibraryDocumentId =
        typeof body.answerLibraryDocumentId === 'string'
          ? body.answerLibraryDocumentId.trim()
          : ''

      const driveAccessToken = extractDriveAccessToken(req)
      const mainResolved = await resolveUploadedOrLibraryDocument({
        uploadedFile: filesMap.document?.[0],
        libraryDocumentId,
        ownerUid: req.dbUser!.uid,
        fieldLabel: 'File câu hỏi',
        driveAccessToken,
      })

      if (!mainResolved.ok) {
        res.status(mainResolved.status).json({
          ok: false,
          step: 'read_file',
          stepLabel: IMPORT_STEP_LABELS.read_file,
          code: mainResolved.code,
          error: mainResolved.error,
        })
        return
      }

      const answerProvisionMode: AnswerProvisionMode =
        body.answerProvisionMode === 'separate_answer_file'
          ? 'separate_answer_file'
          : 'embedded_in_file'

      let separateAnswerFile: {
        buffer: Buffer
        fileName: string
        fileFormat: SourceFileFormat
      } | null = null

      if (answerProvisionMode === 'separate_answer_file') {
        const sepResolved = await resolveUploadedOrLibraryDocument({
          uploadedFile: filesMap.answerDocument?.[0],
          libraryDocumentId: answerLibraryDocumentId,
          ownerUid: req.dbUser!.uid,
          fieldLabel: 'File đáp án riêng',
          driveAccessToken,
        })
        if (!sepResolved.ok) {
          res.status(sepResolved.status).json({
            ok: false,
            step: 'read_file',
            stepLabel: IMPORT_STEP_LABELS.read_file,
            code: 'MISSING_SEPARATE_ANSWER_FILE',
            error:
              'Không đọc được file đáp án riêng: Vui lòng tải lên tệp đáp án (.docx, .pdf hoặc .txt).',
          })
          return
        }
        separateAnswerFile = {
          buffer: sepResolved.buffer,
          fileName: sepResolved.fileName,
          fileFormat: sepResolved.fileFormat,
        }
      }

      const preferredTypes = parsePreferredTypesParam(body.preferredTypes)
      const bankName = typeof body.bankName === 'string' ? body.bankName.trim().slice(0, 120) : ''
      const shouldSaveDraft = body.saveDraft !== 'false'
      const asyncMode = body.asyncMode === 'true' || body.asyncMode === true
      const ownerUid = req.dbUser!.uid

      const runParsePipeline = async (
        onProgress?: (u: { step: ImportStepCode; stepLabel: string; progress: number }) => void
      ): Promise<ParseDocumentResponse> => {
        const result = await extractQuestionsWithGemini({
          buffer: mainResolved.buffer,
          fileName: mainResolved.fileName,
          fileFormat: mainResolved.fileFormat,
          answerProvisionMode,
          preferredTypes,
          separateAnswerFile,
          bankName,
          onProgress,
        })

        let draftId: string | null = null
        let draftSaveError: string | null = null
        if (shouldSaveDraft && result.questions.length > 0) {
          onProgress?.({
            step: 'save_draft',
            stepLabel: `Đang lưu bản nháp ${result.questions.length} câu hỏi vào PostgreSQL...`,
            progress: 94,
          })
          try {
            const draft = await createQuestionImportDraft({
              ownerUid,
              title: `${mainResolved.fileName} (${result.questions.length} câu)`,
              bankName,
              documentCategory: 'question_document',
              answerProvisionMode,
              sourceDocumentName: mainResolved.fileName,
              sourceFormat: mainResolved.fileFormat,
              sourceFileHash: result.fileHash,
              answerFileName: separateAnswerFile?.fileName ?? null,
              libraryDocumentId: mainResolved.libraryDocumentId,
              status: 'draft',
              documentAnalysis: null,
              questions: result.questions,
              warnings: result.warnings,
            })
            draftId = draft.id
          } catch (draftErr) {
            draftSaveError =
              draftErr instanceof Error
                ? draftErr.message
                : 'Không thể ghi bản nháp vào PostgreSQL.'
            console.error('[TIN LAB] Failed to auto-save parse draft:', draftSaveError)
          }
        }

        if (mainResolved.libraryDocumentId) {
          try {
            const docRow = await getTeacherDocumentById(
              mainResolved.libraryDocumentId,
              ownerUid
            )
            if (docRow) {
              const needsReviewCount = result.questions.filter(
                (q) => q.answerStatus !== 'verified'
              ).length
              await updateTeacherDocumentStatus({
                documentId: docRow.id,
                ownerUid,
                processingStatus: needsReviewCount > 0 ? 'Needs review' : 'Completed',
                statusNote: `Đã trích xuất ${result.questions.length} câu hỏi (${needsReviewCount} câu cần kiểm tra đáp án).`,
                aiAgentHook: {
                  ...docRow.aiAgentHook,
                  readyForExtraction: true,
                  lastJobId: draftId || `parse-${Date.now()}`,
                  lastError: draftSaveError,
                  summaryMetadata: {
                    detectedLanguage: 'vi',
                    estimatedPages: result.pageCount,
                    extractedQuestionCount: result.questions.length,
                  },
                },
              })
            }
          } catch {
            // Non-blocking library status update
          }
        }

        const warnings = [...result.warnings]
        if (draftSaveError) {
          warnings.unshift(
            `Lỗi lưu dữ liệu bản nháp PostgreSQL: ${draftSaveError}. Bạn vẫn có thể rà soát và bấm "Lưu bản nháp" hoặc "Lưu vào Ngân hàng chính thức".`
          )
        }

        return {
          ok: true,
          fileName: result.fileName,
          fileFormat: result.fileFormat,
          fileHash: result.fileHash,
          pageCount: result.pageCount,
          documentCategory: 'question_document' as DocumentImportCategory,
          answerProvisionMode,
          answerFileName: separateAnswerFile?.fileName ?? null,
          parserEngine: result.parserEngine,
          documentAnalysis: null,
          draftId,
          draftSaveError,
          questions: result.questions,
          warnings,
        }
      }

      if (asyncMode) {
        pruneExpiredImportJobs()
        const jobId = crypto.randomUUID()
        const initialSnapshot: ImportJobSnapshot = {
          id: jobId,
          status: 'running',
          step: 'read_file',
          stepLabel: `Đã đọc tệp "${mainResolved.fileName}", bắt đầu giải mã tài liệu...`,
          progress: 12,
        }
        importJobsStore.set(jobId, {
          ownerUid,
          createdAt: Date.now(),
          snapshot: initialSnapshot,
        })

        void (async () => {
          try {
            const payload = await runParsePipeline((u) => {
              const job = importJobsStore.get(jobId)
              if (!job) return
              job.snapshot = {
                ...job.snapshot,
                step: u.step,
                stepLabel: u.stepLabel,
                progress: u.progress,
              }
            })
            const job = importJobsStore.get(jobId)
            if (job) {
              job.snapshot = {
                id: jobId,
                status: 'completed',
                step: 'completed',
                stepLabel: `Hoàn tất trích xuất ${payload.questions.length} câu hỏi.`,
                progress: 100,
                result: payload,
              }
            }
          } catch (err) {
            const classified = classifyImportError(err)
            console.error('[TIN LAB] Async parse job failed:', classified.step, classified.message)
            const job = importJobsStore.get(jobId)
            if (job) {
              job.snapshot = {
                ...job.snapshot,
                status: 'failed',
                progress: Math.max(12, job.snapshot.progress),
                errorCode: classified.code,
                errorStep: classified.step,
                errorStepLabel: classified.stepLabel,
                errorMessage: classified.message,
              }
            }
          }
        })()

        res.status(202).json({
          ok: true,
          jobId,
          job: initialSnapshot,
        })
        return
      }

      try {
        const payload = await runParsePipeline()
        res.json(payload)
      } catch (err) {
        const classified = classifyImportError(err)
        console.error('[TIN LAB] Question bank parse failed:', classified.step, classified.message)
        res.status(classified.status).json({
          ok: false,
          step: classified.step,
          stepLabel: classified.stepLabel,
          code: classified.code,
          error: classified.message,
        })
      }
    })
  }
)

app.post(
  '/api/question-bank/ai-agent-generate',
  requireAuth,
  requireSuperAdminRole,
  (req: AuthRequest, res: Response) => {
    questionBankUpload.fields([{ name: 'document', maxCount: 1 }])(
      req,
      res,
      async (uploadErr: unknown) => {
        if (uploadErr) {
          if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({
              ok: false,
              step: 'read_file',
              stepLabel: IMPORT_STEP_LABELS.read_file,
              code: 'FILE_TOO_LARGE',
              error: 'Không đọc được file: Tệp tải lên vượt quá giới hạn tối đa 20 MB.',
            })
            return
          }
          res.status(400).json({
            ok: false,
            step: 'read_file',
            stepLabel: IMPORT_STEP_LABELS.read_file,
            code: 'UPLOAD_ERROR',
            error: 'Không đọc được file: Không thể tiếp nhận tài liệu tổng hợp. Vui lòng thử lại.',
          })
          return
        }

        const filesMap = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>
        const body = (req.body ?? {}) as Record<string, unknown>
        const libraryDocumentId =
          typeof body.libraryDocumentId === 'string' ? body.libraryDocumentId.trim() : ''

        const resolved = await resolveUploadedOrLibraryDocument({
          uploadedFile: filesMap.document?.[0],
          libraryDocumentId,
          ownerUid: req.dbUser!.uid,
          fieldLabel: 'Tài liệu tổng hợp',
          driveAccessToken: extractDriveAccessToken(req),
        })

        if (!resolved.ok) {
          res.status(resolved.status).json({
            ok: false,
            step: 'read_file',
            stepLabel: IMPORT_STEP_LABELS.read_file,
            code: resolved.code,
            error: resolved.error,
          })
          return
        }

        const adaptiveAutoCount = body.adaptiveAutoCount === 'true' || body.adaptiveAutoCount === true
        const mcqCount = Number.isFinite(Number(body.mcqCount)) ? Number(body.mcqCount) : 8
        const trueFalseCount = Number.isFinite(Number(body.trueFalseCount))
          ? Number(body.trueFalseCount)
          : 2
        const essayCount = Number.isFinite(Number(body.essayCount)) ? Number(body.essayCount) : 2
        const topicFocus = typeof body.topicFocus === 'string' ? body.topicFocus.trim() : ''
        const bankName = typeof body.bankName === 'string' ? body.bankName.trim().slice(0, 120) : ''
        const asyncMode = body.asyncMode === 'true' || body.asyncMode === true
        const ownerUid = req.dbUser!.uid

        const runAgentPipeline = async (
          onProgress?: (u: { step: ImportStepCode; stepLabel: string; progress: number }) => void
        ) => {
          const generated = await analyzeAndGenerateWithAiAgent({
            buffer: resolved.buffer,
            fileName: resolved.fileName,
            fileFormat: resolved.fileFormat,
            mcqCount,
            trueFalseCount,
            essayCount,
            adaptiveAutoCount,
            topicFocus,
            bankName,
            onProgress,
          })

          onProgress?.({
            step: 'save_draft',
            stepLabel: `Đang lưu bản nháp ${generated.questions.length} câu hỏi vào PostgreSQL...`,
            progress: 94,
          })

          let draft
          try {
            draft = await createQuestionImportDraft({
              ownerUid,
              title: `[AI Agent] ${resolved.fileName} (${generated.questions.length} câu)`,
              bankName,
              documentCategory: 'composite_document',
              answerProvisionMode: 'embedded_in_file',
              sourceDocumentName: resolved.fileName,
              sourceFormat: resolved.fileFormat,
              sourceFileHash: generated.fileHash,
              answerFileName: null,
              libraryDocumentId: resolved.libraryDocumentId,
              status: 'draft',
              documentAnalysis: generated.documentAnalysis,
              questions: generated.questions,
              warnings: generated.warnings,
            })
          } catch (dbErr) {
            throw new AiExtractionError(
              'save_draft',
              'DRAFT_SAVE_FAILED',
              `Lỗi lưu dữ liệu bản nháp PostgreSQL: ${
                dbErr instanceof Error ? dbErr.message : 'Lỗi cơ sở dữ liệu'
              }`,
              500
            )
          }

          if (resolved.libraryDocumentId) {
            try {
              const docRow = await getTeacherDocumentById(
                resolved.libraryDocumentId,
                ownerUid
              )
              if (docRow) {
                await updateTeacherDocumentStatus({
                  documentId: docRow.id,
                  ownerUid,
                  processingStatus: 'Completed',
                  statusNote: `AI Agent đã phân tích và tạo bản nháp gồm ${generated.questions.length} câu hỏi.`,
                  aiAgentHook: {
                    ...docRow.aiAgentHook,
                    readyForExtraction: true,
                    lastJobId: draft.id,
                    lastError: null,
                    summaryMetadata: {
                      detectedLanguage: 'vi',
                      estimatedPages: generated.pageCount,
                      extractedQuestionCount: generated.questions.length,
                    },
                  },
                })
              }
            } catch {
              // Non-blocking status sync
            }
          }

          return {
            ok: true as const,
            fileName: generated.fileName,
            fileFormat: generated.fileFormat,
            fileHash: generated.fileHash,
            pageCount: generated.pageCount,
            documentCategory: 'composite_document' as DocumentImportCategory,
            answerProvisionMode: 'embedded_in_file' as AnswerProvisionMode,
            answerFileName: null,
            parserEngine: 'gemini_agent' as const,
            documentAnalysis: generated.documentAnalysis,
            draftId: draft.id,
            draft,
            questions: generated.questions,
            warnings: generated.warnings,
          }
        }

        if (asyncMode) {
          pruneExpiredImportJobs()
          const jobId = crypto.randomUUID()
          const initialSnapshot: ImportJobSnapshot = {
            id: jobId,
            status: 'running',
            step: 'read_file',
            stepLabel: `Đã tiếp nhận tài liệu "${resolved.fileName}", chuẩn bị chạy AI Agent...`,
            progress: 12,
          }
          importJobsStore.set(jobId, {
            ownerUid,
            createdAt: Date.now(),
            snapshot: initialSnapshot,
          })

          void (async () => {
            try {
              const payload = await runAgentPipeline((u) => {
                const job = importJobsStore.get(jobId)
                if (!job) return
                job.snapshot = {
                  ...job.snapshot,
                  step: u.step,
                  stepLabel: u.stepLabel,
                  progress: u.progress,
                }
              })
              const job = importJobsStore.get(jobId)
              if (job) {
                job.snapshot = {
                  id: jobId,
                  status: 'completed',
                  step: 'completed',
                  stepLabel: `AI Agent đã hoàn tất biên soạn ${payload.questions.length} câu hỏi.`,
                  progress: 100,
                  result: payload,
                }
              }
            } catch (err) {
              const classified = classifyImportError(err)
              console.error('[TIN LAB] Async AI Agent job failed:', classified.step, classified.message)
              const job = importJobsStore.get(jobId)
              if (job) {
                job.snapshot = {
                  ...job.snapshot,
                  status: 'failed',
                  progress: Math.max(12, job.snapshot.progress),
                  errorCode: classified.code,
                  errorStep: classified.step,
                  errorStepLabel: classified.stepLabel,
                  errorMessage: classified.message,
                }
              }
            }
          })()

          res.status(202).json({
            ok: true,
            jobId,
            job: initialSnapshot,
          })
          return
        }

        try {
          const payload = await runAgentPipeline()
          res.json(payload)
        } catch (err) {
          const classified = classifyImportError(err)
          console.error('[TIN LAB] AI Agent generate failed:', classified.step, classified.message)
          res.status(classified.status).json({
            ok: false,
            step: classified.step,
            stepLabel: classified.stepLabel,
            code: classified.code,
            error: classified.message,
          })
        }
      }
    )
  }
)

/* ============================================================================
 * TIN LAB DOCUMENT AI AGENT ROUTES (STATUS, MULTI-FILE CLASSIFY, 7-STEP ANALYZE, EXCEL EXPORT)
 * ========================================================================== */

const VALID_AGENT_ROLES: ReadonlyArray<AgentFileRole> = [
  'question_file',
  'answer_file',
  'solution_guide',
  'composite_file',
  'reference_file',
  'irrelevant_file',
]

const VALID_AGENT_MODES: ReadonlyArray<AgentSetMode> = [
  'auto',
  'question_embedded',
  'question_plus_separate_answers',
  'composite_study',
  'mixed_bundle',
]

function parseStringArrayParam(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean)
    } catch {
      return []
    }
  }
  return []
}

function parseRoleOverridesParam(raw: unknown): Record<string, AgentFileRole> {
  const out: Record<string, AgentFileRole> = {}
  if (!raw) return out
  let obj: Record<string, unknown> | null = null
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>
      }
    } catch {
      return out
    }
  } else if (typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>
  }
  if (!obj) return out
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && VALID_AGENT_ROLES.includes(v as AgentFileRole)) {
      out[k] = v as AgentFileRole
    }
  }
  return out
}

app.get(
  '/api/question-bank/ai-status',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true'
    const status = await verifyGeminiApiConnection(forceRefresh)
    res.json({ ok: true, status })
  }
)

app.post(
  '/api/question-bank/agent/classify',
  requireAuth,
  requireSuperAdminRole,
  (req: AuthRequest, res: Response) => {
    agentMultiUpload.array('documents', 20)(req, res, async (uploadErr: unknown) => {
      if (uploadErr) {
        if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            ok: false,
            code: 'FILE_TOO_LARGE',
            error: 'Có tệp vượt quá giới hạn tối đa 20 MB.',
          })
          return
        }
        res.status(400).json({
          ok: false,
          code: 'UPLOAD_ERROR',
          error: 'Không thể tiếp nhận danh sách tệp tải lên.',
        })
        return
      }

      const uploadedFiles = Array.isArray(req.files) ? req.files : []
      const body = (req.body ?? {}) as Record<string, unknown>
      const libraryDocIds = parseStringArrayParam(body.libraryDocumentIds)
      const ownerUid = req.dbUser!.uid

      if (uploadedFiles.length === 0 && libraryDocIds.length === 0) {
        res.status(400).json({
          ok: false,
          code: 'MISSING_FILE',
          error: 'Vui lòng chọn ít nhất 1 tệp (.docx, .pdf, .txt) để AI Agent phân loại.',
        })
        return
      }

      const reports: AgentUploadedFileReport[] = []

      for (let idx = 0; idx < uploadedFiles.length; idx++) {
        const f = uploadedFiles[idx]
        const resolved = await resolveUploadedOrLibraryDocument({
          uploadedFile: f,
          ownerUid,
          fieldLabel: `Tệp ${idx + 1}`,
        })
        if (!resolved.ok) {
          const decodedName = decodeUploadFilename(f.originalname || `file-${idx + 1}`)
          reports.push({
            fileId: `upload-${idx}-${Date.now()}`,
            fileName: decodedName,
            fileFormat: resolveDocumentFormat(decodedName, f.mimetype || '') ?? 'docx',
            fileHash: '',
            fileSizeBytes: f.size,
            libraryDocumentId: null,
            detectedRole: 'question_file',
            assignedRole: 'question_file',
            roleConfidence: 0,
            roleReason: resolved.error,
            status: 'error',
            pageCount: null,
            extractedCount: 0,
            matchedAnswerCount: 0,
            errorStep: 'read_file',
            errorMessage: resolved.error,
          })
          continue
        }

        const classified = await classifyFileForAgent({
          fileId: `upload-${idx}-${resolved.fileName}`,
          fileName: resolved.fileName,
          fileFormat: resolved.fileFormat,
          buffer: resolved.buffer,
          fileSizeBytes: f.size,
          libraryDocumentId: null,
        })
        reports.push(classified.report)
      }

      const driveAccessToken = extractDriveAccessToken(req)
      for (const libId of libraryDocIds) {
        const resolved = await resolveUploadedOrLibraryDocument({
          libraryDocumentId: libId,
          ownerUid,
          fieldLabel: 'Tài liệu thư viện',
          driveAccessToken,
        })
        if (!resolved.ok) {
          reports.push({
            fileId: `lib-${libId}`,
            fileName: libId,
            fileFormat: 'docx',
            fileHash: '',
            fileSizeBytes: 0,
            libraryDocumentId: libId,
            detectedRole: 'question_file',
            assignedRole: 'question_file',
            roleConfidence: 0,
            roleReason: resolved.error,
            status: 'error',
            pageCount: null,
            extractedCount: 0,
            matchedAnswerCount: 0,
            errorStep: 'read_file',
            errorMessage: resolved.error,
          })
          continue
        }
        const classified = await classifyFileForAgent({
          fileId: `lib-${libId}`,
          fileName: resolved.fileName,
          fileFormat: resolved.fileFormat,
          buffer: resolved.buffer,
          fileSizeBytes: resolved.buffer.length,
          libraryDocumentId: libId,
        })
        reports.push(classified.report)
      }

      res.json({ ok: true, files: reports })
    })
  }
)

app.post(
  '/api/question-bank/agent/analyze',
  requireAuth,
  requireSuperAdminRole,
  (req: AuthRequest, res: Response) => {
    agentMultiUpload.array('documents', 20)(req, res, async (uploadErr: unknown) => {
      if (uploadErr) {
        if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            ok: false,
            step: 'read_file',
            stepLabel: IMPORT_STEP_LABELS.read_file,
            code: 'FILE_TOO_LARGE',
            error: 'Không đọc được file: Có tệp vượt quá giới hạn tối đa 20 MB.',
          })
          return
        }
        res.status(400).json({
          ok: false,
          step: 'read_file',
          stepLabel: IMPORT_STEP_LABELS.read_file,
          code: 'UPLOAD_ERROR',
          error: 'Không thể tiếp nhận bộ tệp tài liệu tải lên.',
        })
        return
      }

      const uploadedFiles = Array.isArray(req.files) ? req.files : []
      const body = (req.body ?? {}) as Record<string, unknown>
      const libraryDocIds = parseStringArrayParam(body.libraryDocumentIds)
      const roleOverrides = parseRoleOverridesParam(body.fileRoles)
      const setMode: AgentSetMode = VALID_AGENT_MODES.includes(body.setMode as AgentSetMode)
        ? (body.setMode as AgentSetMode)
        : 'auto'
      const bankName = typeof body.bankName === 'string' ? body.bankName.trim().slice(0, 120) : ''
      const preferredTypes = parsePreferredTypesParam(body.preferredTypes)
      const shouldSaveDraft = body.saveDraft !== 'false'
      const asyncMode = body.asyncMode === 'true' || body.asyncMode === true
      const ownerUid = req.dbUser!.uid

      const compositeConfig = {
        adaptiveAutoCount:
          body.adaptiveAutoCount === 'true' || body.adaptiveAutoCount === true,
        mcqCount: Number.isFinite(Number(body.mcqCount)) ? Number(body.mcqCount) : 8,
        trueFalseCount: Number.isFinite(Number(body.trueFalseCount))
          ? Number(body.trueFalseCount)
          : 2,
        essayCount: Number.isFinite(Number(body.essayCount)) ? Number(body.essayCount) : 2,
        topicFocus: typeof body.topicFocus === 'string' ? body.topicFocus.trim() : '',
      }

      if (uploadedFiles.length === 0 && libraryDocIds.length === 0) {
        res.status(400).json({
          ok: false,
          step: 'read_file',
          stepLabel: IMPORT_STEP_LABELS.read_file,
          code: 'MISSING_FILE',
          error: 'Vui lòng chọn ít nhất 1 tệp (.docx, .pdf, .txt) để AI Agent phân tích.',
        })
        return
      }

      const agentInputFiles: AgentInputFile[] = []
      const earlyFileErrors: AgentUploadedFileReport[] = []

      for (let idx = 0; idx < uploadedFiles.length; idx++) {
        const f = uploadedFiles[idx]
        const resolved = await resolveUploadedOrLibraryDocument({
          uploadedFile: f,
          ownerUid,
          fieldLabel: `Tệp ${idx + 1}`,
        })
        if (!resolved.ok) {
          const decodedName = decodeUploadFilename(f.originalname || `file-${idx + 1}`)
          earlyFileErrors.push({
            fileId: `upload-${idx}-${decodedName}`,
            fileName: decodedName,
            fileFormat: resolveDocumentFormat(decodedName, f.mimetype || '') ?? 'docx',
            fileHash: '',
            fileSizeBytes: f.size,
            libraryDocumentId: null,
            detectedRole: roleOverrides[decodedName] ?? 'question_file',
            assignedRole: roleOverrides[decodedName] ?? 'question_file',
            roleConfidence: 0,
            roleReason: resolved.error,
            status: 'error',
            pageCount: null,
            extractedCount: 0,
            matchedAnswerCount: 0,
            errorStep: 'read_file',
            errorMessage: resolved.error,
          })
          continue
        }

        const override =
          roleOverrides[resolved.fileName] ??
          roleOverrides[resolved.fileName.normalize('NFC')] ??
          roleOverrides[String(idx)]

        agentInputFiles.push({
          fileId: `upload-${idx}-${resolved.fileName}`,
          fileName: resolved.fileName,
          fileFormat: resolved.fileFormat,
          buffer: resolved.buffer,
          fileSizeBytes: f.size,
          libraryDocumentId: null,
          assignedRole: override,
        })
      }

      const driveAccessToken = extractDriveAccessToken(req)
      for (const libId of libraryDocIds) {
        const resolved = await resolveUploadedOrLibraryDocument({
          libraryDocumentId: libId,
          ownerUid,
          fieldLabel: 'Tài liệu thư viện',
          driveAccessToken,
        })
        if (!resolved.ok) {
          earlyFileErrors.push({
            fileId: `lib-${libId}`,
            fileName: libId,
            fileFormat: 'docx',
            fileHash: '',
            fileSizeBytes: 0,
            libraryDocumentId: libId,
            detectedRole: roleOverrides[libId] ?? 'question_file',
            assignedRole: roleOverrides[libId] ?? 'question_file',
            roleConfidence: 0,
            roleReason: resolved.error,
            status: 'error',
            pageCount: null,
            extractedCount: 0,
            matchedAnswerCount: 0,
            errorStep: 'read_file',
            errorMessage: resolved.error,
          })
          continue
        }
        const override =
          roleOverrides[libId] ??
          roleOverrides[resolved.fileName] ??
          roleOverrides[resolved.fileName.normalize('NFC')]
        agentInputFiles.push({
          fileId: `lib-${libId}`,
          fileName: resolved.fileName,
          fileFormat: resolved.fileFormat,
          buffer: resolved.buffer,
          fileSizeBytes: resolved.buffer.length,
          libraryDocumentId: libId,
          assignedRole: override,
        })
      }

      if (agentInputFiles.length === 0) {
        res.status(422).json({
          ok: false,
          step: 'read_file',
          stepLabel: IMPORT_STEP_LABELS.read_file,
          code: 'ALL_FILES_UNREADABLE',
          error:
            earlyFileErrors[0]?.errorMessage ||
            'Tất cả tệp tải lên đều không hợp lệ hoặc không thể đọc được.',
        })
        return
      }

      const executeMultiAgent = async (
        onProgress?: (u: { step: ImportStepCode; stepLabel: string; progress: number }) => void
      ): Promise<ParseDocumentResponse> => {
        const result = await runDocumentAiAgentPipeline({
          files: agentInputFiles,
          setMode,
          bankName,
          preferredTypes,
          compositeConfig,
          onProgress,
        })

        const combinedFiles = [...result.agentFiles, ...earlyFileErrors]
        const combinedSummary = {
          ...result.agentSummary,
          totalFiles: combinedFiles.length,
          failedFiles: combinedFiles.filter((f) => f.status === 'error').length,
          completedFiles: combinedFiles.filter((f) => f.status === 'completed').length,
        }
        const combinedDocAnalysis = {
          ...result.documentAnalysis,
          agentFiles: combinedFiles,
          agentSummary: combinedSummary,
        }
        const combinedWarnings = [
          ...earlyFileErrors.map((e) => `${e.fileName}: ${e.errorMessage}`),
          ...result.warnings,
        ]

        let draftId: string | null = null
        let draftSaveError: string | null = null
        if (shouldSaveDraft && (result.questions.length > 0 || combinedFiles.length > 0)) {
          onProgress?.({
            step: 'save_draft',
            stepLabel: `Đang lưu kết quả ${result.questions.length} câu hỏi vào PostgreSQL...`,
            progress: 94,
          })
          try {
            const title =
              combinedFiles.length > 1
                ? `[AI Agent · ${combinedFiles.length} file] ${result.primaryFileName} (${result.questions.length} câu)`
                : `${result.primaryFileName} (${result.questions.length} câu)`

            const draft = await createQuestionImportDraft({
              ownerUid,
              title,
              bankName,
              documentCategory: result.documentCategory,
              answerProvisionMode: result.answerProvisionMode,
              sourceDocumentName: result.primaryFileName,
              sourceFormat: result.primaryFileFormat,
              sourceFileHash: result.primaryFileHash,
              answerFileName: result.answerFileName,
              libraryDocumentId: agentInputFiles[0]?.libraryDocumentId ?? null,
              status: 'draft',
              documentAnalysis: combinedDocAnalysis,
              questions: result.questions,
              warnings: combinedWarnings,
            })
            draftId = draft.id
          } catch (dbErr) {
            draftSaveError =
              dbErr instanceof Error ? dbErr.message : 'Không thể ghi bản nháp vào PostgreSQL.'
          }
        }

        // Sync library documents status non-blockingly
        for (const fRep of combinedFiles) {
          if (!fRep.libraryDocumentId) continue
          try {
            const docRow = await getTeacherDocumentById(fRep.libraryDocumentId, ownerUid)
            if (docRow) {
              await updateTeacherDocumentStatus({
                documentId: docRow.id,
                ownerUid,
                processingStatus:
                  fRep.status === 'error'
                    ? 'Failed'
                    : (combinedSummary.aiProposedCount ?? 0) +
                        combinedSummary.needsReviewCount +
                        combinedSummary.missingCount +
                        combinedSummary.ambiguousCount >
                      0
                    ? 'Needs review'
                    : 'Completed',
                statusNote:
                  fRep.errorMessage ||
                  `AI Agent đã xử lý (${result.questions.length} câu trong bộ tài liệu).`,
                aiAgentHook: {
                  ...docRow.aiAgentHook,
                  readyForExtraction: true,
                  lastJobId: draftId || `agent-${Date.now()}`,
                  lastError: fRep.errorMessage,
                  summaryMetadata: {
                    detectedLanguage: 'vi',
                    estimatedPages: fRep.pageCount,
                    extractedQuestionCount: fRep.extractedCount,
                  },
                },
              })
            }
          } catch {
            // non-blocking
          }
        }

        return {
          ok: true,
          fileName: result.primaryFileName,
          fileFormat: result.primaryFileFormat,
          fileHash: result.primaryFileHash,
          pageCount: result.pageCount,
          documentCategory: result.documentCategory,
          answerProvisionMode: result.answerProvisionMode,
          answerFileName: result.answerFileName,
          parserEngine: 'gemini_agent',
          documentAnalysis: combinedDocAnalysis,
          agentFiles: combinedFiles,
          agentSummary: combinedSummary,
          draftId,
          draftSaveError,
          questions: result.questions,
          warnings: combinedWarnings,
        }
      }

      if (asyncMode) {
        pruneExpiredImportJobs()
        const jobId = crypto.randomUUID()
        const initialSnapshot: ImportJobSnapshot = {
          id: jobId,
          status: 'running',
          step: 'read_file',
          stepLabel: `TIN LAB Document AI Agent đã tiếp nhận ${agentInputFiles.length} tệp...`,
          progress: 10,
        }
        importJobsStore.set(jobId, {
          ownerUid,
          createdAt: Date.now(),
          snapshot: initialSnapshot,
        })

        void (async () => {
          try {
            const payload = await executeMultiAgent((u) => {
              const job = importJobsStore.get(jobId)
              if (!job) return
              job.snapshot = {
                ...job.snapshot,
                step: u.step,
                stepLabel: u.stepLabel,
                progress: u.progress,
              }
            })
            const job = importJobsStore.get(jobId)
            if (job) {
              job.snapshot = {
                id: jobId,
                status: 'completed',
                step: 'completed',
                stepLabel: `AI Agent đã hoàn tất phân tích ${payload.agentFiles?.length ?? 1} tệp (${payload.questions.length} câu hỏi).`,
                progress: 100,
                result: payload,
              }
            }
          } catch (err) {
            const classified = classifyImportError(err)
            const job = importJobsStore.get(jobId)
            if (job) {
              job.snapshot = {
                ...job.snapshot,
                status: 'failed',
                progress: Math.max(12, job.snapshot.progress),
                errorCode: classified.code,
                errorStep: classified.step,
                errorStepLabel: classified.stepLabel,
                errorMessage: classified.message,
              }
            }
          }
        })()

        res.status(202).json({
          ok: true,
          jobId,
          job: initialSnapshot,
        })
        return
      }

      try {
        const payload = await executeMultiAgent()
        res.json(payload)
      } catch (err) {
        const classified = classifyImportError(err)
        res.status(classified.status).json({
          ok: false,
          step: classified.step,
          stepLabel: classified.stepLabel,
          code: classified.code,
          error: classified.message,
        })
      }
    })
  }
)

app.post(
  '/api/question-bank/agent/export-excel',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        draftId?: string
        title?: string
        bankName?: string
        agentFiles?: AgentUploadedFileReport[]
        agentSummary?: AgentAnalysisSummary | null
        questions?: ExtractedQuestion[]
      }

      let title = (body.title || '').trim()
      let bankName = (body.bankName || '').trim()
      let agentFiles = Array.isArray(body.agentFiles) ? body.agentFiles : []
      let agentSummary = body.agentSummary ?? null
      let questions = Array.isArray(body.questions) ? body.questions : []

      if (questions.length === 0 && body.draftId && UUID_REGEX.test(body.draftId)) {
        const draft = await getQuestionImportDraftById(body.draftId, req.dbUser!.uid)
        if (!draft) {
          res.status(404).json({ ok: false, error: 'Không tìm thấy bản nháp cần xuất Excel.' })
          return
        }
        title = title || draft.title
        bankName = bankName || draft.bankName
        questions = draft.questions
        agentFiles = draft.documentAnalysis?.agentFiles ?? agentFiles
        agentSummary = draft.documentAnalysis?.agentSummary ?? agentSummary
      }

      if (questions.length === 0) {
        res.status(400).json({ ok: false, error: 'Không có câu hỏi nào để xuất báo cáo Excel.' })
        return
      }

      const buffer = await buildDocumentAgentExcelBuffer({
        title: title || 'Bao_cao_TIN_LAB_Document_AI_Agent',
        bankName,
        agentFiles,
        agentSummary,
        questions,
      })

      const dateSlug = new Date().toISOString().slice(0, 10)
      const filename = `tin-lab-document-agent-${dateSlug}.xlsx`
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(buffer)
    } catch (err) {
      console.error('[TIN LAB] Agent Excel export failed:', err)
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Không thể xuất file báo cáo Excel.',
      })
    }
  }
)

app.post(
  '/api/question-bank/agent/retry-incomplete',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        draftId?: string | null
        mode?: 'continue_incomplete' | 'rematch_selected'
        selectedTempIds?: string[]
        questions?: ExtractedQuestion[]
        documentAnalysis?: Record<string, unknown> | null
      }

      const mode =
        body.mode === 'rematch_selected' ? 'rematch_selected' : 'continue_incomplete'
      const selectedTempIds = Array.isArray(body.selectedTempIds)
        ? body.selectedTempIds.map((id) => String(id).trim()).filter(Boolean)
        : []

      let draftRecord = null as Awaited<ReturnType<typeof getQuestionImportDraftById>>
      if (body.draftId && UUID_REGEX.test(body.draftId)) {
        draftRecord = await getQuestionImportDraftById(body.draftId, req.dbUser!.uid)
        if (!draftRecord) {
          res.status(404).json({ ok: false, error: 'Không tìm thấy bản nháp cần tiếp tục xử lý.' })
          return
        }
      }

      const questions =
        Array.isArray(body.questions) && body.questions.length > 0
          ? body.questions
          : draftRecord?.questions ?? []

      if (questions.length === 0) {
        res.status(400).json({
          ok: false,
          error: 'Không có danh sách câu hỏi nào để AI Agent xử lý tiếp.',
        })
        return
      }

      const draftAnalysis =
        (body.documentAnalysis as typeof draftRecord extends infer T
          ? T extends { documentAnalysis: infer D }
            ? D
            : never
          : never) ??
        draftRecord?.documentAnalysis ??
        null

      const result = await resumeIncompleteAgentQuestions({
        draftAnalysis,
        questions,
        mode,
        selectedTempIds,
      })

      if (draftRecord) {
        await updateQuestionImportDraft({
          draftId: draftRecord.id,
          ownerUid: req.dbUser!.uid,
          questions: result.questions,
          documentAnalysis: result.documentAnalysis,
          warnings: Array.from(new Set([...(draftRecord.warnings ?? []), ...result.warnings])),
        })
      }

      res.json({
        ok: true,
        draftId: draftRecord?.id ?? null,
        questions: result.questions,
        agentSummary: result.agentSummary,
        documentAnalysis: result.documentAnalysis,
        processedCount: result.processedCount,
        updatedCount: result.updatedCount,
        warnings: result.warnings,
      })
    } catch (err) {
      console.error('[TIN LAB] Agent retry-incomplete failed:', err)
      res.status(500).json({
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : 'Không thể tiếp tục xử lý các câu chưa hoàn thành.',
      })
    }
  }
)

app.post(
  '/api/question-bank/agent/resolve-exceptions',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        draftId?: string | null
        questions?: ExtractedQuestion[]
        documentAnalysis?: CompositeDocumentAnalysis | null
        existingBankHints?: BatchResolveExistingBankHint[]
        allowAiKnowledgeFallback?: boolean
        autoMarkAiProposed?: boolean
      }

      const rawQuestions = Array.isArray(body.questions) ? body.questions : []
      if (rawQuestions.length === 0) {
        res.status(400).json({
          ok: false,
          error: 'Không có câu hỏi ngoại lệ nào trong lô cần xử lý.',
        })
        return
      }
      if (rawQuestions.length > 100) {
        res.status(400).json({
          ok: false,
          error: 'Mỗi lô xử lý tối đa 100 câu hỏi để đảm bảo ổn định API.',
        })
        return
      }

      let draftAnalysis: CompositeDocumentAnalysis | null = body.documentAnalysis ?? null
      if (!draftAnalysis && body.draftId && UUID_REGEX.test(body.draftId)) {
        try {
          const draftRecord = await getQuestionImportDraftById(body.draftId, req.dbUser!.uid)
          if (draftRecord?.documentAnalysis) {
            draftAnalysis = draftRecord.documentAnalysis
          }
        } catch {
          // Non-blocking: proceed cleanly even if PostgreSQL draft lookup is temporarily unavailable
        }
      }

      const existingBankHints = Array.isArray(body.existingBankHints)
        ? body.existingBankHints.slice(0, 600)
        : []

      const result = await resolveExceptionQuestionsBatch({
        questions: rawQuestions,
        draftAnalysis,
        existingBankHints,
        allowAiKnowledgeFallback: body.allowAiKnowledgeFallback !== false,
        autoMarkAiProposed: body.autoMarkAiProposed !== false,
        subBatchSize: 8,
      })

      res.json({
        ok: true,
        questions: result.questions,
        stats: result.stats,
        failedTempIds: result.failedTempIds,
        aiUsed: result.aiUsed,
        aiUnavailable: result.aiUnavailable,
        aiConnectionState: result.aiConnectionState,
        aiErrorMessage: result.aiErrorMessage,
        warnings: result.warnings,
      })
    } catch (err) {
      console.error('[TIN LAB] Agent resolve-exceptions failed:', err)
      res.status(500).json({
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : 'Không thể chạy AI Agent xử lý hàng loạt câu ngoại lệ.',
      })
    }
  }
)

app.get(
  '/api/question-bank/drafts',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    try {
      const drafts = await listQuestionImportDraftsByOwner(req.dbUser!.uid)
      res.json({
        ok: true,
        aiConfigured: isGeminiAiConfigured(),
        drafts,
      })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Không thể tải danh sách bản nháp.',
      })
    }
  }
)

app.get(
  '/api/question-bank/drafts/:id',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ ok: false, error: 'Mã bản nháp không hợp lệ.' })
      return
    }
    try {
      const draft = await getQuestionImportDraftById(id, req.dbUser!.uid)
      if (!draft) {
        res.status(404).json({ ok: false, error: 'Không tìm thấy bản nháp.' })
        return
      }
      res.json({ ok: true, draft })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Không thể tải bản nháp.',
      })
    }
  }
)

app.post(
  '/api/question-bank/drafts',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const sourceDocumentName =
      typeof body.sourceDocumentName === 'string' ? body.sourceDocumentName.trim() : ''
    const sourceFileHash =
      typeof body.sourceFileHash === 'string' ? body.sourceFileHash.trim() : ''
    const sourceFormat: SourceFileFormat =
      body.sourceFormat === 'pdf' || body.sourceFormat === 'txt' ? body.sourceFormat : 'docx'
    const documentCategory: DocumentImportCategory =
      body.documentCategory === 'composite_document' ? 'composite_document' : 'question_document'
    const answerProvisionMode: AnswerProvisionMode =
      body.answerProvisionMode === 'separate_answer_file'
        ? 'separate_answer_file'
        : 'embedded_in_file'
    const questions = Array.isArray(body.questions)
      ? (body.questions as ExtractedQuestion[])
      : []

    if (!sourceDocumentName || !/^[a-f0-9]{64}$/i.test(sourceFileHash)) {
      res.status(400).json({ ok: false, error: 'Thiếu thông tin tài liệu nguồn hợp lệ để lưu nháp.' })
      return
    }

    try {
      const draft = await createQuestionImportDraft({
        ownerUid: req.dbUser!.uid,
        title: title || `${sourceDocumentName} (${questions.length} câu)`,
        bankName: typeof body.bankName === 'string' ? body.bankName : '',
        documentCategory,
        answerProvisionMode,
        sourceDocumentName,
        sourceFormat,
        sourceFileHash,
        answerFileName: typeof body.answerFileName === 'string' ? body.answerFileName : null,
        libraryDocumentId:
          typeof body.libraryDocumentId === 'string' && UUID_REGEX.test(body.libraryDocumentId)
            ? body.libraryDocumentId
            : null,
        status: 'draft',
        documentAnalysis: (body.documentAnalysis ?? null) as never,
        questions,
        warnings: Array.isArray(body.warnings) ? body.warnings.map(String) : [],
      })
      res.status(201).json({ ok: true, draft })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Không thể lưu bản nháp vào PostgreSQL.',
      })
    }
  }
)

app.patch(
  '/api/question-bank/drafts/:id',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ ok: false, error: 'Mã bản nháp không hợp lệ.' })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const status =
      body.status === 'draft' || body.status === 'committed' || body.status === 'archived'
        ? (body.status as QuestionDraftStatus)
        : undefined

    try {
      const updated = await updateQuestionImportDraft({
        draftId: id,
        ownerUid: req.dbUser!.uid,
        title: typeof body.title === 'string' ? body.title : undefined,
        bankName: typeof body.bankName === 'string' ? body.bankName : undefined,
        status,
        documentAnalysis:
          body.documentAnalysis !== undefined ? (body.documentAnalysis as never) : undefined,
        questions: Array.isArray(body.questions)
          ? (body.questions as ExtractedQuestion[])
          : undefined,
        warnings: Array.isArray(body.warnings) ? body.warnings.map(String) : undefined,
      })
      if (!updated) {
        res.status(404).json({ ok: false, error: 'Không tìm thấy bản nháp cần cập nhật.' })
        return
      }
      res.json({ ok: true, draft: updated })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Không thể cập nhật bản nháp.',
      })
    }
  }
)

app.delete(
  '/api/question-bank/drafts/:id',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ ok: false, error: 'Mã bản nháp không hợp lệ.' })
      return
    }
    try {
      const deleted = await deleteQuestionImportDraftById(id, req.dbUser!.uid)
      if (!deleted) {
        res.status(404).json({ ok: false, error: 'Không tìm thấy bản nháp cần xóa.' })
        return
      }
      res.json({ ok: true, id })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Không thể xóa bản nháp.',
      })
    }
  }
)

app.post('/api/exams/seal', requireAuth, requireSuperAdminRole, (req: AuthRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const examId = typeof body.examId === 'string' ? body.examId.trim() : ''
  const part2ScoringMode =
    body.part2ScoringMode === 'linear' ? 'linear' : ('tiered_2025' as Part2ScoringMode)
  const totalPoints = Number(body.totalPoints)
  const items = Array.isArray(body.items) ? (body.items as SealedExamItem[]) : []

  if (!examId || !/^[a-zA-Z0-9_-]+$/.test(examId)) {
    res.status(400).json({ ok: false, error: 'Mã đề thi (examId) không hợp lệ.' })
    return
  }
  if (!Number.isFinite(totalPoints) || totalPoints <= 0 || totalPoints > 100) {
    res.status(400).json({ ok: false, error: 'Tổng điểm đề thi không hợp lệ.' })
    return
  }
  if (items.length === 0 || items.length > 150) {
    res.status(400).json({ ok: false, error: 'Danh sách câu hỏi cần niêm phong không hợp lệ.' })
    return
  }

  try {
    const sealedGradingPayload = sealExamGradingPayload({
      v: 1,
      examId,
      part2ScoringMode,
      totalPoints,
      items,
    })
    res.json({ ok: true, sealedGradingPayload })
  } catch (err) {
    console.error('[TIN LAB] Exam seal failed:', err instanceof Error ? err.message : err)
    res.status(500).json({ ok: false, error: 'Không thể mã hóa gói chấm điểm cho đề thi.' })
  }
})

app.post('/api/exams/grade', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const examId = typeof body.examId === 'string' ? body.examId.trim() : ''
  const sealedGradingPayload =
    typeof body.sealedGradingPayload === 'string' ? body.sealedGradingPayload.trim() : ''
  const studentAnswers = Array.isArray(body.studentAnswers)
    ? (body.studentAnswers as StudentAnswerInput[])
    : []

  if (!examId || !sealedGradingPayload) {
    res.status(400).json({
      ok: false,
      error: 'Thiếu mã đề thi hoặc gói dữ liệu chấm điểm hợp lệ.',
    })
    return
  }

  try {
    const result = await gradeExamSubmission({
      examId,
      sealedGradingPayload,
      studentAnswers,
    })
    res.json(result)
  } catch (err) {
    console.error('[TIN LAB] Exam grade failed:', err instanceof Error ? err.message : err)
    res.status(400).json({
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Không thể chấm bài thi trên máy chủ. Vui lòng thử lại.',
    })
  }
})

app.post(
  '/api/exams/regrade-essay',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const questionText = typeof body.questionText === 'string' ? body.questionText.trim() : ''
    const rubric = typeof body.rubric === 'string' ? body.rubric.trim() : ''
    const sampleAnswer = typeof body.sampleAnswer === 'string' ? body.sampleAnswer.trim() : ''
    const studentAnswer = typeof body.studentAnswer === 'string' ? body.studentAnswer : ''
    const maxPoints = Number(body.maxPoints)

    if (!questionText || !rubric || !Number.isFinite(maxPoints) || maxPoints <= 0) {
      res.status(400).json({
        ok: false,
        error: 'Thiếu đề bài, biểu điểm hoặc thang điểm để AI gợi ý chấm tự luận.',
      })
      return
    }

    const evaluation = await evaluateEssayWithGemini({
      questionText,
      rubric,
      sampleAnswer,
      maxPoints,
      studentAnswer,
    })

    res.json({ ok: true, evaluation })
  }
)

/* ============================================================================
 * PART 2, 3, 5, 6: STUDENT NO-LOGIN ATTEMPT ENTRY, SERVER GRADING & PERSISTENCE
 * ========================================================================== */

function sendStudentResultsDbError(
  res: Response,
  err: unknown,
  fallbackMessage: string,
  defaultStatus = 500
) {
  const classified = err as { code?: unknown; httpStatus?: unknown; message?: unknown } | null
  const code = typeof classified?.code === 'string' ? classified.code : 'DB_QUERY_FAILED'
  const status =
    typeof classified?.httpStatus === 'number' && classified.httpStatus >= 400
      ? classified.httpStatus
      : defaultStatus
  const message =
    err instanceof Error && err.message.trim() ? err.message : fallbackMessage
  res.status(status).json({
    ok: false,
    code,
    error: message,
  })
}

app.post('/api/student/attempts/start', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const rawName = typeof body.studentName === 'string' ? body.studentName : ''
  const rawClass = typeof body.className === 'string' ? body.className : ''
  const examId = typeof body.examId === 'string' ? body.examId.trim() : ''
  const examKind = body.examKind === 'published' ? 'published' : 'practice'
  const accessCode = typeof body.accessCode === 'string' ? body.accessCode.trim().slice(0, 30) : ''
  const rawExamTitle = typeof body.examTitle === 'string' ? body.examTitle.trim().slice(0, 200) : ''
  const rawMaxScore = Number(body.maxScore)
  const rawScoringMode =
    typeof body.scoringMode === 'string' ? body.scoringMode.trim().slice(0, 40) : ''

  const nameValidation = validateStudentFullName(rawName)
  const classValidation = validateClassName(rawClass)
  const fieldErrors: Record<string, string> = {}

  if (!nameValidation.ok) {
    fieldErrors.studentName = nameValidation.error
  }
  if (!classValidation.ok) {
    fieldErrors.className = classValidation.error
  }

  if (Object.keys(fieldErrors).length > 0 || !nameValidation.ok || !classValidation.ok) {
    res.status(400).json({
      ok: false,
      code: 'VALIDATION_ERROR',
      error:
        (!nameValidation.ok && nameValidation.error) ||
        (!classValidation.ok && classValidation.error) ||
        'Thông tin thí sinh chưa hợp lệ.',
      fieldErrors,
    })
    return
  }

  if (!examId || !/^[a-zA-Z0-9_-]{2,80}$/.test(examId)) {
    res.status(400).json({ ok: false, error: 'Mã đề thi không hợp lệ.' })
    return
  }

  let resolvedTitle = rawExamTitle
  let resolvedMaxScore = Number.isFinite(rawMaxScore) && rawMaxScore > 0 ? rawMaxScore : 10
  let resolvedScoringMode = rawScoringMode || 'tiered_2025'

  if (examKind === 'practice') {
    const serverExam = getServerPracticeExamById(examId)
    if (!serverExam) {
      res.status(404).json({ ok: false, error: 'Không tìm thấy đề luyện tập tương ứng.' })
      return
    }
    resolvedTitle = serverExam.title
    resolvedMaxScore = 10
    resolvedScoringMode = 'practice_10'
  } else if (!resolvedTitle) {
    res.status(400).json({ ok: false, error: 'Thiếu tiêu đề bài thi.' })
    return
  }

  try {
    const attempt = await createExamAttemptRecord({
      examId,
      examTitle: resolvedTitle,
      examKind,
      accessCode,
      studentName: nameValidation.display,
      studentNameNormalized: nameValidation.normalized,
      className: classValidation.normalized,
      rawClassName: classValidation.rawClean,
      maxScore: resolvedMaxScore,
      scoringMode: resolvedScoringMode,
    })

    res.status(201).json({
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
    })
  } catch (err) {
    sendStudentResultsDbError(
      res,
      err,
      'Không thể khởi tạo phiên làm bài trong cơ sở dữ liệu.',
      500
    )
  }
})

app.post('/api/student/attempts/submit', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const attemptId = typeof body.attemptId === 'string' ? body.attemptId.trim() : ''
  const examId = typeof body.examId === 'string' ? body.examId.trim() : ''
  const studentAnswers = Array.isArray(body.studentAnswers)
    ? (body.studentAnswers as StudentAnswerInput[])
    : []
  const sealedGradingPayload =
    typeof body.sealedGradingPayload === 'string' ? body.sealedGradingPayload.trim() : ''

  if (!UUID_REGEX.test(attemptId)) {
    res.status(400).json({ ok: false, error: 'Mã phiên làm bài (Attempt ID) không hợp lệ.' })
    return
  }
  if (!examId) {
    res.status(400).json({ ok: false, error: 'Thiếu mã đề thi khi nộp bài.' })
    return
  }

  try {
    const existing = await getExamAttemptByAttemptId(attemptId)
    if (!existing) {
      res.status(404).json({ ok: false, error: 'Không tìm thấy phiên làm bài hợp lệ.' })
      return
    }
    if (existing.examId !== examId) {
      res.status(400).json({ ok: false, error: 'Mã đề thi không khớp với phiên làm bài.' })
      return
    }
    if (existing.completionStatus !== 'in_progress') {
      res.status(409).json({
        ok: false,
        code: 'ATTEMPT_ALREADY_SUBMITTED',
        error: 'Phiên làm bài này đã được nộp và ghi nhận kết quả trước đó.',
      })
      return
    }

    if (existing.examKind === 'practice') {
      const serverExam = getServerPracticeExamById(examId)
      if (!serverExam) {
        res.status(404).json({ ok: false, error: 'Không tìm thấy đề luyện tập trên máy chủ.' })
        return
      }

      const gradedPractice = gradePracticeExamAttempt({
        exam: serverExam,
        studentAnswers,
      })

      const saved = await completeExamAttemptRecord({
        attemptId,
        examId,
        scoringMode: gradedPractice.scoringMode,
        part1Score: gradedPractice.part1Score,
        part1Max: gradedPractice.part1Max,
        part2Score: gradedPractice.part2Score,
        part2Max: gradedPractice.part2Max,
        part3Score: gradedPractice.part3Score,
        part3Max: gradedPractice.part3Max,
        score: gradedPractice.score,
        maxScore: gradedPractice.maxScore,
        completionStatus: gradedPractice.completionStatus,
        detailedAnswers: gradedPractice.detailedAnswers,
      })

      res.json({
        ok: true,
        kind: 'practice',
        attemptId: saved.attemptId,
        studentName: saved.studentName,
        className: saved.className,
        startedAt: saved.startedAt,
        submittedAt: saved.submittedAt,
        completionStatus: saved.completionStatus,
        score: saved.score,
        maxScore: saved.maxScore,
        correctCount: gradedPractice.correctCount,
        totalQuestions: gradedPractice.totalQuestions,
        detailedAnswers: saved.detailedAnswers,
      })
      return
    }

    // Published multi-part exam
    if (!sealedGradingPayload) {
      res.status(400).json({
        ok: false,
        error: 'Thiếu gói niêm phong đáp án của đề thi để chấm điểm trên máy chủ.',
      })
      return
    }

    const gradeResult = await gradeExamSubmission({
      examId,
      sealedGradingPayload,
      studentAnswers,
    })

    const mappedDetails: AttemptDetailedAnswer[] = gradeResult.gradedAnswers.map((item) => ({
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
    }))

    const completionStatus =
      gradeResult.gradingStatus === 'needs_teacher_review' ? 'needs_review' : 'auto_graded'

    const saved = await completeExamAttemptRecord({
      attemptId,
      examId,
      scoringMode: existing.scoringMode || 'tiered_2025',
      part1Score: gradeResult.part1Score,
      part1Max: gradeResult.part1Max,
      part2Score: gradeResult.part2Score,
      part2Max: gradeResult.part2Max,
      part3Score: gradeResult.part3AiScore,
      part3Max: gradeResult.part3Max,
      score: gradeResult.totalProvisionalScore,
      maxScore: gradeResult.totalMax,
      completionStatus,
      detailedAnswers: mappedDetails,
    })

    res.json({
      ok: true,
      kind: 'published',
      attemptId: saved.attemptId,
      studentName: saved.studentName,
      className: saved.className,
      startedAt: saved.startedAt,
      submittedAt: saved.submittedAt,
      completionStatus: saved.completionStatus,
      gradeResult,
    })
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'ATTEMPT_NOT_FOUND') {
        res.status(404).json({ ok: false, error: 'Không tìm thấy lượt làm bài.' })
        return
      }
      if (err.message === 'ATTEMPT_ALREADY_SUBMITTED') {
        res.status(409).json({ ok: false, error: 'Lượt làm bài này đã được nộp trước đó.' })
        return
      }
    }
    console.error('[TIN LAB] Student attempt submission failed:', err instanceof Error ? err.message : err)
    const classified = err as { httpStatus?: unknown } | null
    const isDbError = typeof classified?.httpStatus === 'number'
    sendStudentResultsDbError(
      res,
      err,
      'Không thể chấm và lưu kết quả bài thi trên máy chủ.',
      isDbError ? 500 : 400
    )
  }
})

/* ============================================================================
 * PART 4 & 5: SUPER ADMIN STUDENT RESULTS DASHBOARD & EXCEL (.XLSX) EXPORT
 * ========================================================================== */

app.get(
  '/api/admin/student-results',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    const className = typeof req.query.className === 'string' ? req.query.className : ''
    const examId = typeof req.query.examId === 'string' ? req.query.examId : ''
    const status = typeof req.query.status === 'string' ? req.query.status : ''
    const dateFrom = typeof req.query.dateFrom === 'string' ? req.query.dateFrom : ''
    const dateTo = typeof req.query.dateTo === 'string' ? req.query.dateTo : ''

    try {
      const payload = await listExamAttemptsForAdmin({
        q,
        className,
        examId,
        status,
        dateFrom,
        dateTo,
      })
      res.json(payload)
    } catch (err) {
      sendStudentResultsDbError(
        res,
        err,
        'Không thể truy vấn danh sách kết quả học sinh từ PostgreSQL.',
        500
      )
    }
  }
)

app.patch(
  '/api/admin/student-results/:attemptId/review',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const attemptId = Array.isArray(req.params.attemptId)
      ? req.params.attemptId[0]
      : req.params.attemptId
    if (!UUID_REGEX.test(attemptId)) {
      res.status(400).json({ ok: false, error: 'Mã lượt làm bài (Attempt ID) không hợp lệ.' })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const adminFeedback =
      typeof body.adminFeedback === 'string' ? body.adminFeedback.trim().slice(0, 2000) : ''
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
        comment: typeof val.comment === 'string' ? val.comment.trim().slice(0, 1000) : '',
      }
    }

    try {
      const updated = await reviewExamAttemptAsAdmin({
        attemptId,
        reviewerEmail: req.dbUser!.email,
        essayScores: sanitizedEssayScores,
        adminFeedback,
      })
      res.json({ ok: true, attempt: updated })
    } catch (err) {
      if (err instanceof Error && err.message === 'ATTEMPT_NOT_FOUND') {
        res.status(404).json({ ok: false, error: 'Không tìm thấy bài thi của học sinh.' })
        return
      }
      sendStudentResultsDbError(
        res,
        err,
        'Không thể lưu đánh giá của Super Admin.',
        500
      )
    }
  }
)

app.get(
  '/api/admin/student-results/export',
  requireAuth,
  requireSuperAdminRole,
  async (req: AuthRequest, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    const className = typeof req.query.className === 'string' ? req.query.className : ''
    const examId = typeof req.query.examId === 'string' ? req.query.examId : ''
    const status = typeof req.query.status === 'string' ? req.query.status : ''
    const dateFrom = typeof req.query.dateFrom === 'string' ? req.query.dateFrom : ''
    const dateTo = typeof req.query.dateTo === 'string' ? req.query.dateTo : ''
    const includeDetails =
      req.query.includeDetails === '1' || req.query.includeDetails === 'true'

    try {
      const payload = await listExamAttemptsForAdmin({
        q,
        className,
        examId,
        status,
        dateFrom,
        dateTo,
      })
      const buffer = await buildStudentResultsWorkbookBuffer({
        data: payload,
        includeDetailedAnswers: includeDetails,
      })

      const dateTag = new Date().toISOString().slice(0, 10)
      const filename = includeDetails
        ? `tin-lab-ket-qua-chi-tiet-${dateTag}.xlsx`
        : `tin-lab-ket-qua-hoc-sinh-${dateTag}.xlsx`

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.send(buffer)
    } catch (err) {
      console.error('[TIN LAB] Excel export failed:', err instanceof Error ? err.message : err)
      sendStudentResultsDbError(
        res,
        err,
        'Không thể xuất tệp Excel (.xlsx) kết quả học sinh.',
        500
      )
    }
  }
)

/* ============================================================================
 * PART 7: REAL DASHBOARD & STATISTICS METRICS (ZERO MOCK / ZERO DEMO DATA)
 * ========================================================================== */

app.get('/api/dashboard/metrics', async (_req: Request, res: Response) => {
  try {
    const payload = await getRealDashboardMetrics({ includeAdminDetails: false })
    res.setHeader('Cache-Control', 'no-store')
    res.json(payload)
  } catch (err) {
    console.error('[TIN LAB] Public dashboard metrics failed:', err instanceof Error ? err.message : err)
    res.status(500).json({
      ok: false,
      error: 'Không thể tải dữ liệu thống kê thực tế từ hệ thống.',
    })
  }
})

app.get(
  '/api/admin/dashboard-metrics',
  requireAuth,
  requireSuperAdminRole,
  async (_req: AuthRequest, res: Response) => {
    try {
      const payload = await getRealDashboardMetrics({ includeAdminDetails: true })
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(payload)
    } catch (err) {
      console.error('[TIN LAB] Admin dashboard metrics failed:', err instanceof Error ? err.message : err)
      res.status(500).json({
        ok: false,
        error: 'Không thể tải tổng quan dữ liệu quản trị từ hệ thống.',
      })
    }
  }
)

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production'
  const port = Number(process.env.PORT || '3000')

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite')
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    })
    app.use(vite.middlewares)
  } else {
    const distDir = path.resolve(__dirname, 'dist')
    const publicDir = path.resolve(__dirname, 'public')
    app.use(express.static(distDir))
    app.use(express.static(publicDir))
    app.get('/{*splat}', (req: Request, res: Response) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ ok: false, error: 'API endpoint not found' })
        return
      }
      res.sendFile(path.join(distDir, 'index.html'))
    })
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(
      `TIN LAB server running at http://0.0.0.0:${port} (${isProd ? 'production' : 'development'})`
    )
  })
}

startServer().catch((err) => {
  console.error('Failed to start TIN LAB server:', err)
  process.exit(1)
})
