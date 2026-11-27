import { auth, getGoogleDriveToken } from './firebase'
import type {
  AdminAuditLogRecord,
  AdminAuthorizationStatus,
  AdministratorRecord,
  AuthenticatedAccountProfile,
  RoleDefinitionRecord,
  SystemSettingsOverview,
} from '../types'

export class AdminAuthError extends Error {
  code: string
  status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'AdminAuthError'
    this.code = code
    this.status = status
  }
}

export async function getAuthHeaders(
  extraHeaders?: Record<string, string>,
  forceRefreshToken = false
): Promise<Record<string, string>> {
  const user = auth.currentUser
  if (!user) {
    throw new AdminAuthError(
      'Bạn chưa đăng nhập bằng tài khoản Google quản trị.',
      'UNAUTHORIZED',
      401
    )
  }
  const token = await user.getIdToken(forceRefreshToken)
  return {
    Authorization: `Bearer ${token}`,
    ...(extraHeaders ?? {}),
  }
}

export async function getDriveAuthHeaders(
  extraHeaders?: Record<string, string>,
  forceRefreshToken = false
): Promise<Record<string, string>> {
  const baseHeaders = await getAuthHeaders(extraHeaders, forceRefreshToken)
  const driveToken = getGoogleDriveToken()
  if (driveToken) {
    baseHeaders['X-Google-Drive-Token'] = driveToken
  }
  return baseHeaders
}

export async function verifyGoogleAdminSession(
  forceRefreshToken = false
): Promise<AuthenticatedAccountProfile> {
  const headers = await getAuthHeaders(
    { 'Content-Type': 'application/json' },
    forceRefreshToken
  )
  const res = await fetch('/api/auth/google', {
    method: 'POST',
    headers,
    cache: 'no-store',
  })
  const data = (await res.json().catch(() => null)) as
    | { ok: true; profile: AuthenticatedAccountProfile }
    | { ok: false; code?: string; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    const code = (data && 'code' in data && data.code) || 'AUTH_VERIFICATION_FAILED'
    const message =
      (data && 'error' in data && data.error) ||
      (res.status === 403
        ? 'Tài khoản Google này chưa được cấp quyền quản trị TIN LAB.'
        : 'Không thể xác minh tài khoản quản trị với máy chủ.')
    throw new AdminAuthError(message, code, res.status)
  }

  return data.profile
}

export async function logoutAdminSession(): Promise<void> {
  await fetch('/api/auth/logout', {
    method: 'POST',
    cache: 'no-store',
  }).catch(() => undefined)
}

export async function fetchAuthenticatedProfile(): Promise<AuthenticatedAccountProfile> {
  const headers = await getAuthHeaders()
  const res = await fetch('/api/auth/me', {
    method: 'GET',
    headers,
    cache: 'no-store',
  })
  const data = (await res.json().catch(() => null)) as
    | { ok: true; profile: AuthenticatedAccountProfile }
    | { ok: false; code?: string; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new AdminAuthError(
      (data && 'error' in data && data.error) ||
        'Không thể xác minh quyền Super Admin với máy chủ.',
      (data && 'code' in data && data.code) || 'AUTH_VERIFICATION_FAILED',
      res.status
    )
  }

  return data.profile
}

export interface AdminDashboardPayload {
  administrators: AdministratorRecord[]
  roleDefinitions: RoleDefinitionRecord[]
  auditLogs: AdminAuditLogRecord[]
}

export async function fetchAdminDashboardData(): Promise<AdminDashboardPayload> {
  const headers = await getAuthHeaders()
  const res = await fetch('/api/admin/administrators', { headers })
  const data = (await res.json().catch(() => null)) as
    | ({ ok: true } & AdminDashboardPayload)
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể tải danh sách Super Admin.'
    )
  }

  return {
    administrators: data.administrators,
    roleDefinitions: data.roleDefinitions,
    auditLogs: data.auditLogs,
  }
}

export async function fetchSystemSettingsOverview(): Promise<SystemSettingsOverview> {
  const headers = await getDriveAuthHeaders()
  const res = await fetch('/api/admin/system-settings', { headers })
  const data = (await res.json().catch(() => null)) as
    | { ok: true; settings: SystemSettingsOverview }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể tải thông số cấu hình hệ thống.'
    )
  }

  return data.settings
}

export async function updateAdministratorAuthorizationClient(params: {
  id: number
  status?: AdminAuthorizationStatus
  note?: string
}): Promise<AdministratorRecord> {
  const headers = await getAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch(`/api/admin/administrators/${params.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      status: params.status,
      note: params.note,
    }),
  })
  const data = (await res.json().catch(() => null)) as
    | { ok: true; administrator: AdministratorRecord }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể cập nhật trạng thái tài khoản quản trị.'
    )
  }

  return data.administrator
}
