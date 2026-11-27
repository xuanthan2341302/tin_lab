import { count, desc, eq, sql } from 'drizzle-orm'
import { db } from './index.ts'
import {
  adminAuditLogs,
  adminAuthorizations,
  examAttempts,
  roleDefinitions,
  teacherDocuments,
  users,
} from './schema.ts'
import type { AdminAuthorizationStatus, UserRole } from '../types.ts'

export const AUTHORIZED_SUPER_ADMIN_LIST = [
  'sunghiep.tsbd@gmail.com',
  'secret1990.tsbd@gmail.com',
] as const

export const AUTHORIZED_SUPER_ADMIN_EMAILS = new Set<string>(AUTHORIZED_SUPER_ADMIN_LIST)

function wrapDbError(message: string, cause: unknown): Error {
  const err = new Error(message) as Error & { cause?: unknown }
  err.cause = cause
  return err
}

export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  super_admin: [
    'teacher:workspace',
    'documents:manage',
    'documents:ai_queue',
    'question_bank:manage',
    'exams:create',
    'exams:manage',
    'grading:manage',
    'student_results:view',
    'student_results:review',
    'student_results:export',
    'reports:view',
    'system:settings',
    'rbac:manage_admins',
  ],
  student: ['student:exams'],
}

export const SUPER_ADMIN_PERMISSIONS: readonly string[] = DEFAULT_ROLE_PERMISSIONS.super_admin

export async function getPermissionsForRole(role: UserRole): Promise<string[]> {
  try {
    const rows = await db
      .select({ permissions: roleDefinitions.permissions })
      .from(roleDefinitions)
      .where(eq(roleDefinitions.role, role))
      .limit(1)

    if (rows[0]?.permissions && Array.isArray(rows[0].permissions)) {
      return rows[0].permissions
    }
    return DEFAULT_ROLE_PERMISSIONS[role]
  } catch (error) {
    console.error('[TIN LAB] Failed to load role permissions:', error)
    throw wrapDbError('Không thể tải ma trận quyền hạn từ PostgreSQL.', error)
  }
}

export async function syncAuthenticatedUser(params: {
  uid: string
  email: string
  displayName: string
  emailVerified: boolean
}) {
  const normalizedEmail = params.email.trim().toLowerCase()
  const now = new Date()

  try {
    return await db.transaction(async (tx) => {
      let nextRole: UserRole = 'student'
      let nextSource = 'default'
      let nextStatus = 'active'

      if (!params.emailVerified) {
        nextRole = 'student'
        nextSource = 'unverified_email'
        nextStatus = 'active'
      } else if (AUTHORIZED_SUPER_ADMIN_EMAILS.has(normalizedEmail)) {
        const authRows = await tx
          .select()
          .from(adminAuthorizations)
          .where(eq(adminAuthorizations.email, normalizedEmail))
          .limit(1)

        const authEntry = authRows[0] ?? null

        // Official Super Admin allowlist accounts always hold equal, full Super Admin access
        nextRole = 'super_admin'
        nextSource = 'server_super_admin_allowlist_db_synced'
        nextStatus = 'active'

        if (!authEntry) {
          await tx.insert(adminAuthorizations).values({
            email: normalizedEmail,
            assignedRole: 'super_admin',
            status: 'active',
            isBootstrap: true,
            note: 'Tài khoản Super Admin chính thức của TIN LAB',
            grantedByUid: 'system',
            grantedByEmail: 'system',
            activatedUid: params.uid,
            activatedAt: now,
            createdAt: now,
            updatedAt: now,
          })

          await tx.insert(adminAuditLogs).values({
            actorUid: params.uid,
            actorEmail: normalizedEmail,
            action: 'BOOTSTRAP_FIRST_LOGIN_ACTIVATED',
            targetEmail: normalizedEmail,
            details: { assignedRole: 'super_admin', previousStatus: 'none' },
            createdAt: now,
          })
        } else if (
          authEntry.status !== 'active' ||
          !authEntry.activatedUid ||
          authEntry.assignedRole !== 'super_admin'
        ) {
          await tx
            .update(adminAuthorizations)
            .set({
              assignedRole: 'super_admin',
              status: 'active',
              activatedUid: params.uid,
              activatedAt: authEntry.activatedAt ?? now,
              updatedAt: now,
            })
            .where(eq(adminAuthorizations.id, authEntry.id))

          await tx.insert(adminAuditLogs).values({
            actorUid: params.uid,
            actorEmail: normalizedEmail,
            action: 'BOOTSTRAP_FIRST_LOGIN_ACTIVATED',
            targetEmail: normalizedEmail,
            details: {
              assignedRole: 'super_admin',
              previousStatus: authEntry.status,
            },
            createdAt: now,
          })
        }
      } else {
        // Current development phase: only the two authorized Super Admin emails may hold admin permissions
        nextRole = 'student'
        nextSource = 'restricted_phase_non_admin'
        nextStatus = 'active'
      }

      const roleDefRows = await tx
        .select({ permissions: roleDefinitions.permissions })
        .from(roleDefinitions)
        .where(eq(roleDefinitions.role, nextRole))
        .limit(1)

      const permissions =
        nextRole === 'super_admin'
          ? DEFAULT_ROLE_PERMISSIONS.super_admin
          : roleDefRows[0]?.permissions && Array.isArray(roleDefRows[0].permissions)
          ? roleDefRows[0].permissions
          : DEFAULT_ROLE_PERMISSIONS[nextRole]

      const upserted = await tx
        .insert(users)
        .values({
          uid: params.uid,
          email: normalizedEmail,
          displayName: params.displayName.trim(),
          role: nextRole,
          roleSource: nextSource,
          status: nextStatus,
          permissions,
          emailVerified: params.emailVerified,
          lastLoginAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: users.uid,
          set: {
            email: normalizedEmail,
            displayName: params.displayName.trim(),
            role: nextRole,
            roleSource: nextSource,
            status: nextStatus,
            permissions,
            emailVerified: params.emailVerified,
            lastLoginAt: now,
            updatedAt: now,
          },
        })
        .returning()

      return upserted[0]
    })
  } catch (error) {
    console.error('[TIN LAB] Failed to sync authenticated user:', error)
    throw wrapDbError(
      'Không thể đồng bộ hồ sơ và phân quyền tài khoản với PostgreSQL.',
      error
    )
  }
}

export async function listAdministrators() {
  try {
    return await db
      .select()
      .from(adminAuthorizations)
      .where(eq(adminAuthorizations.assignedRole, 'super_admin'))
      .orderBy(desc(adminAuthorizations.isBootstrap), desc(adminAuthorizations.createdAt))
  } catch (error) {
    console.error('[TIN LAB] Failed to list administrators:', error)
    throw wrapDbError('Không thể tải danh sách Super Admin từ PostgreSQL.', error)
  }
}

export async function listRoleDefinitions() {
  try {
    const rows = await db.select().from(roleDefinitions)
    return rows.filter((r) => r.role === 'super_admin' || r.role === 'student')
  } catch (error) {
    console.error('[TIN LAB] Failed to list role definitions:', error)
    throw wrapDbError('Không thể tải định nghĩa vai trò từ PostgreSQL.', error)
  }
}

export async function listAdminAuditLogs(limitCount = 40) {
  try {
    return await db
      .select()
      .from(adminAuditLogs)
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(limitCount)
  } catch (error) {
    console.error('[TIN LAB] Failed to list admin audit logs:', error)
    throw wrapDbError('Không thể tải nhật ký phân quyền từ PostgreSQL.', error)
  }
}

export async function upsertAdministratorAuthorization(_params: {
  actorUid: string
  actorEmail: string
  email: string
  assignedRole: string
  note: string
}): Promise<never> {
  // Restricted in current phase: no additional admins or teachers can be registered
  throw new Error('REGISTRATION_LOCKED')
}

export async function updateAdministratorAuthorization(params: {
  actorUid: string
  actorEmail: string
  id: number
  status?: AdminAuthorizationStatus
  note?: string
}) {
  const actorEmail = params.actorEmail.trim().toLowerCase()
  const now = new Date()

  try {
    return await db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(adminAuthorizations)
        .where(eq(adminAuthorizations.id, params.id))
        .limit(1)
      const target = existingRows[0] ?? null
      if (!target || !AUTHORIZED_SUPER_ADMIN_EMAILS.has(target.email.toLowerCase())) {
        throw new Error('NOT_FOUND')
      }

      const nextStatus = params.status ?? (target.status as AdminAuthorizationStatus)
      const nextNote = params.note !== undefined ? params.note.trim() : target.note

      if (nextStatus === 'revoked') {
        throw new Error('AUTHORIZED_SUPER_ADMIN_PROTECTED')
      }

      const matchingUserRows = await tx
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${target.email.toLowerCase()}`)
        .limit(1)
      const matchingUser = matchingUserRows[0] ?? null

      let resolvedStatus = nextStatus
      let resolvedActivatedUid = target.activatedUid
      let resolvedActivatedAt = target.activatedAt

      if (nextStatus === 'active' && !matchingUser?.emailVerified) {
        resolvedStatus = 'pending_activation'
      } else if (nextStatus === 'active' && matchingUser?.emailVerified) {
        resolvedActivatedUid = matchingUser.uid
        resolvedActivatedAt = target.activatedAt ?? now
      }

      const updatedRows = await tx
        .update(adminAuthorizations)
        .set({
          assignedRole: 'super_admin',
          status: resolvedStatus,
          note: nextNote,
          activatedUid: resolvedActivatedUid,
          activatedAt: resolvedActivatedAt,
          updatedAt: now,
        })
        .where(eq(adminAuthorizations.id, target.id))
        .returning()

      if (matchingUser) {
        const effectiveRole: UserRole = matchingUser.emailVerified
          ? 'super_admin'
          : 'student'

        await tx
          .update(users)
          .set({
            role: effectiveRole,
            roleSource: matchingUser.emailVerified
              ? 'server_super_admin_allowlist_db_synced'
              : 'unverified_email',
            status: 'active',
            permissions: DEFAULT_ROLE_PERMISSIONS[effectiveRole],
            updatedAt: now,
          })
          .where(eq(users.id, matchingUser.id))
      }

      await tx.insert(adminAuditLogs).values({
        actorUid: params.actorUid,
        actorEmail,
        action: 'ADMIN_AUTHORIZATION_UPDATED',
        targetEmail: target.email,
        details: {
          nextStatus: resolvedStatus,
        },
        createdAt: now,
      })

      return updatedRows[0]
    })
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'NOT_FOUND',
        'CANNOT_MODIFY_SELF',
        'LAST_SUPER_ADMIN_PROTECTED',
        'AUTHORIZED_SUPER_ADMIN_PROTECTED',
      ].includes(error.message)
    ) {
      throw error
    }
    console.error('[TIN LAB] Failed to update administrator authorization:', error)
    throw wrapDbError('Không thể cập nhật trạng thái quản trị.', error)
  }
}

export async function deleteAdministratorAuthorization(): Promise<never> {
  throw new Error('AUTHORIZED_SUPER_ADMIN_PROTECTED')
}

export async function getSystemGovernanceCounts() {
  try {
    const [userCountRow] = await db.select({ total: count() }).from(users)
    const [docCountRow] = await db.select({ total: count() }).from(teacherDocuments)
    const [attemptCountRow] = await db.select({ total: count() }).from(examAttempts)
    const admins = await db
      .select()
      .from(adminAuthorizations)
      .where(eq(adminAuthorizations.assignedRole, 'super_admin'))

    let superAdminsActive = 0
    let superAdminsPending = 0

    for (const a of admins) {
      if (a.status === 'active') superAdminsActive += 1
      else if (a.status === 'pending_activation') superAdminsPending += 1
    }

    return {
      totalUsers: Number(userCountRow?.total ?? 0),
      superAdminsActive,
      superAdminsPending,
      totalDocuments: Number(docCountRow?.total ?? 0),
      totalExamAttempts: Number(attemptCountRow?.total ?? 0),
    }
  } catch (error) {
    console.error('[TIN LAB] Failed to load governance counts:', error)
    throw wrapDbError('Không thể tải thống kê quản trị từ PostgreSQL.', error)
  }
}
