import type { NextFunction, Request, Response } from 'express'
import type { DecodedIdToken } from 'firebase-admin/auth'
import { adminAuth } from '../lib/firebase-admin.ts'
import {
  AUTHORIZED_SUPER_ADMIN_EMAILS,
  SUPER_ADMIN_PERMISSIONS,
  syncAuthenticatedUser,
} from '../db/users.ts'
import type { UserRole } from '../types.ts'

export const UNAUTHORIZED_ADMIN_MESSAGE =
  'Tài khoản Google này chưa được cấp quyền quản trị TIN LAB.'

export interface AuthenticatedDbUser {
  id: number
  uid: string
  email: string
  displayName: string
  role: UserRole
  roleSource: string
  status: string
  permissions: string[]
  emailVerified: boolean
  dbSyncStatus: 'synced' | 'allowlist_only' | 'skipped'
}

export interface AuthRequest extends Request {
  authToken?: DecodedIdToken
  dbUser?: AuthenticatedDbUser
}

const DB_SYNC_TIMEOUT_MS = 2500

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isAuthorizedSuperAdminEmail(email: string): boolean {
  return AUTHORIZED_SUPER_ADMIN_EMAILS.has(normalizeEmail(email))
}

export function evaluateSuperAdminAuthorization(input: {
  email: string
  emailVerified: boolean
  role: UserRole
  status: string
}):
  | { allowed: true }
  | { allowed: false; code: string; statusCode: number; error: string } {
  const normalizedEmail = normalizeEmail(input.email)

  if (!input.emailVerified) {
    return {
      allowed: false,
      code: 'EMAIL_NOT_VERIFIED',
      statusCode: 403,
      error:
        'Địa chỉ email của tài khoản Google này chưa được xác minh. Bắt buộc phải xác minh email trước khi truy cập quyền quản trị TIN LAB.',
    }
  }

  if (input.status === 'revoked') {
    return {
      allowed: false,
      code: 'ACCOUNT_REVOKED',
      statusCode: 403,
      error: 'Quyền quản trị của tài khoản Google này đã bị tạm thu hồi.',
    }
  }

  if (input.role !== 'super_admin' || !isAuthorizedSuperAdminEmail(normalizedEmail)) {
    return {
      allowed: false,
      code: 'ADMIN_EMAIL_NOT_AUTHORIZED',
      statusCode: 403,
      error: UNAUTHORIZED_ADMIN_MESSAGE,
    }
  }

  return { allowed: true }
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`PostgreSQL sync timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function resolveAuthenticatedUserFromToken(
  decoded: {
    uid: string
    email?: string
    email_verified?: boolean
    name?: unknown
  },
  options?: {
    syncUserFn?: typeof syncAuthenticatedUser
    dbSyncTimeoutMs?: number
  }
): Promise<
  | { ok: true; user: AuthenticatedDbUser }
  | { ok: false; statusCode: number; code: string; error: string }
> {
  const rawEmail = typeof decoded.email === 'string' ? decoded.email.trim() : ''
  if (!rawEmail) {
    return {
      ok: false,
      statusCode: 401,
      code: 'MISSING_EMAIL',
      error: 'Tài khoản Google không cung cấp địa chỉ email hợp lệ.',
    }
  }

  const normalizedEmail = normalizeEmail(rawEmail)
  const emailVerified = Boolean(decoded.email_verified)
  const displayName = typeof decoded.name === 'string' ? decoded.name.trim() : ''

  // Never auto-register or grant admin access to unverified or non-allowlisted Google accounts.
  if (!emailVerified || !isAuthorizedSuperAdminEmail(normalizedEmail)) {
    return {
      ok: true,
      user: {
        id: 0,
        uid: decoded.uid,
        email: normalizedEmail,
        displayName,
        role: 'student',
        roleSource: emailVerified ? 'not_authorized_super_admin' : 'unverified_email',
        status: 'denied',
        permissions: [],
        emailVerified,
        dbSyncStatus: 'skipped',
      },
    }
  }

  // Identity is cryptographically verified by Firebase Admin SDK and matched the
  // immutable server-side Super Admin allowlist. Sync with PostgreSQL best-effort
  // so database unavailability or socket drift never locks out official Super Admins.
  const syncFn = options?.syncUserFn ?? syncAuthenticatedUser
  const timeoutMs = options?.dbSyncTimeoutMs ?? DB_SYNC_TIMEOUT_MS

  try {
    const synced = await runWithTimeout(
      syncFn({
        uid: decoded.uid,
        email: normalizedEmail,
        displayName,
        emailVerified: true,
      }),
      timeoutMs
    )

    return {
      ok: true,
      user: {
        id: synced.id,
        uid: decoded.uid,
        email: normalizedEmail,
        displayName: synced.displayName || displayName,
        role: 'super_admin',
        roleSource: 'server_super_admin_allowlist_db_synced',
        status: 'active',
        permissions: [...SUPER_ADMIN_PERMISSIONS],
        emailVerified: true,
        dbSyncStatus: 'synced',
      },
    }
  } catch (err) {
    console.warn(
      '[TIN LAB] PostgreSQL user sync unavailable for verified Super Admin; granting Super Admin via server-side allowlist:',
      err instanceof Error ? err.message : String(err)
    )

    return {
      ok: true,
      user: {
        id: 0,
        uid: decoded.uid,
        email: normalizedEmail,
        displayName,
        role: 'super_admin',
        roleSource: 'server_super_admin_allowlist',
        status: 'active',
        permissions: [...SUPER_ADMIN_PERMISSIONS],
        emailVerified: true,
        dbSyncStatus: 'allowlist_only',
      },
    }
  }
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      ok: false,
      code: 'UNAUTHORIZED',
      error: 'Bạn cần đăng nhập bằng tài khoản Google quản trị để thực hiện thao tác này.',
    })
    return
  }

  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) {
    res.status(401).json({
      ok: false,
      code: 'UNAUTHORIZED',
      error: 'Thiếu mã xác thực phiên đăng nhập Google.',
    })
    return
  }

  let decoded: DecodedIdToken
  try {
    decoded = await adminAuth.verifyIdToken(token)
  } catch (err) {
    console.error(
      '[TIN LAB] Firebase ID token verification failed:',
      err instanceof Error ? err.message : err
    )
    res.status(401).json({
      ok: false,
      code: 'INVALID_TOKEN',
      error: 'Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.',
    })
    return
  }

  const resolved = await resolveAuthenticatedUserFromToken(decoded)
  if (!resolved.ok) {
    res.status(resolved.statusCode).json({
      ok: false,
      code: resolved.code,
      error: resolved.error,
    })
    return
  }

  req.authToken = decoded
  req.dbUser = resolved.user
  next()
}

export function requireSuperAdminRole(req: AuthRequest, res: Response, next: NextFunction) {
  const user = req.dbUser
  if (!user) {
    res.status(401).json({
      ok: false,
      code: 'UNAUTHORIZED',
      error: 'Chưa xác thực người dùng.',
    })
    return
  }

  const decision = evaluateSuperAdminAuthorization({
    email: user.email,
    emailVerified: user.emailVerified,
    role: user.role,
    status: user.status,
  })

  if (!decision.allowed) {
    res.status(decision.statusCode).json({
      ok: false,
      code: decision.code,
      error: decision.error,
    })
    return
  }

  next()
}

// Legacy alias kept only so any internal route strictly enforces Super Admin permissions
export const requireTeacherRole = requireSuperAdminRole
