import { createRemoteJWKSet, jwtVerify } from 'jose'
import {
  AUTHORIZED_SUPER_ADMIN_EMAILS,
  SUPER_ADMIN_PERMISSIONS,
  resolveFirebaseProjectId,
  type WorkerEnv,
} from './env.ts'
import type { AuthenticatedAccountProfile } from '../src/types.ts'

// Google's official JWKS endpoint for Firebase Auth ID tokens (RS256)
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
  )
)

export interface VerifiedFirebaseIdentity {
  uid: string
  email: string
  displayName: string
  emailVerified: boolean
}

export class WorkerAuthError extends Error {
  status: number
  code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'WorkerAuthError'
    this.status = status
    this.code = code
  }
}

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return null
  const token = authHeader.slice(7).trim()
  return token.length > 20 ? token : null
}

/**
 * Verifies a Firebase ID Token strictly on the server using Web Crypto + Google JWKS.
 * Checks cryptographic RS256 signature, issuer, audience, expiration, subject, and auth_time.
 */
export async function verifyFirebaseIdTokenInWorker(
  request: Request,
  env: WorkerEnv
): Promise<VerifiedFirebaseIdentity> {
  const token = extractBearerToken(request)
  if (!token) {
    throw new WorkerAuthError(
      'Bạn cần đăng nhập bằng tài khoản Google quản trị để thực hiện thao tác này.',
      401,
      'UNAUTHORIZED'
    )
  }

  const projectId = resolveFirebaseProjectId(env)
  if (!projectId) {
    throw new WorkerAuthError(
      'Máy chủ Worker chưa cấu hình FIREBASE_PROJECT_ID để xác minh danh tính Google.',
      503,
      'FIREBASE_PROJECT_NOT_CONFIGURED'
    )
  }

  const expectedIssuer = `https://securetoken.google.com/${projectId}`

  try {
    const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
      issuer: expectedIssuer,
      audience: projectId,
      algorithms: ['RS256'],
    })

    const sub = typeof payload.sub === 'string' ? payload.sub.trim() : ''
    if (!sub || sub.length > 128) {
      throw new WorkerAuthError(
        'Mã định danh tài khoản Google (sub) không hợp lệ.',
        401,
        'INVALID_TOKEN'
      )
    }

    const authTime = typeof payload.auth_time === 'number' ? payload.auth_time : 0
    const nowSec = Math.floor(Date.now() / 1000)
    if (authTime > nowSec + 300) {
      throw new WorkerAuthError(
        'Thời gian xác thực phiên Google không hợp lệ.',
        401,
        'INVALID_TOKEN'
      )
    }

    const email =
      typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
    const emailVerified = payload.email_verified === true
    const displayName =
      typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) : ''

    if (!email) {
      throw new WorkerAuthError(
        'Tài khoản Google không cung cấp địa chỉ email hợp lệ.',
        401,
        'EMAIL_MISSING'
      )
    }

    return {
      uid: sub,
      email,
      displayName,
      emailVerified,
    }
  } catch (err) {
    if (err instanceof WorkerAuthError) throw err
    throw new WorkerAuthError(
      'Phiên đăng nhập Google đã hết hạn hoặc chữ ký ID Token không hợp lệ. Vui lòng đăng nhập lại.',
      401,
      'INVALID_TOKEN'
    )
  }
}

export function buildServerProfile(
  identity: VerifiedFirebaseIdentity,
  dbSyncStatus: 'synced' | 'allowlist_only' | 'skipped' = 'allowlist_only'
): AuthenticatedAccountProfile {
  const normalizedEmail = identity.email.trim().toLowerCase()
  const isSuperAdmin =
    identity.emailVerified === true &&
    AUTHORIZED_SUPER_ADMIN_EMAILS.has(normalizedEmail)

  return {
    uid: identity.uid,
    email: normalizedEmail,
    displayName: identity.displayName || normalizedEmail,
    emailVerified: identity.emailVerified,
    role: isSuperAdmin ? 'super_admin' : 'student',
    roleSource: isSuperAdmin
      ? dbSyncStatus === 'synced'
        ? 'worker_super_admin_allowlist_db_synced'
        : 'worker_super_admin_allowlist'
      : identity.emailVerified
      ? 'non_admin_email'
      : 'unverified_email',
    status: 'active',
    permissions: isSuperAdmin ? SUPER_ADMIN_PERMISSIONS : [],
    isSuperAdmin,
    dbSyncStatus,
  }
}

export async function requireSuperAdminInWorker(
  request: Request,
  env: WorkerEnv
): Promise<AuthenticatedAccountProfile> {
  const identity = await verifyFirebaseIdTokenInWorker(request, env)
  if (!identity.emailVerified) {
    throw new WorkerAuthError(
      'Tài khoản Google của bạn chưa xác minh địa chỉ email.',
      403,
      'EMAIL_NOT_VERIFIED'
    )
  }

  const profile = buildServerProfile(identity, 'allowlist_only')
  if (!profile.isSuperAdmin) {
    throw new WorkerAuthError(
      'Tài khoản Google này chưa được cấp quyền quản trị TIN LAB.',
      403,
      'FORBIDDEN_NOT_SUPER_ADMIN'
    )
  }

  return profile
}
