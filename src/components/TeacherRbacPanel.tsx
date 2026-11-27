import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Clock,
  Crown,
  History,
  Loader2,
  Lock,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react'
import {
  fetchAdminDashboardData,
  fetchSystemSettingsOverview,
  updateAdministratorAuthorizationClient,
} from '../lib/authClient'
import type {
  AdminAuditLogRecord,
  AdminAuthorizationStatus,
  AdministratorRecord,
  RoleDefinitionRecord,
  SystemSettingsOverview,
} from '../types'

interface TeacherRbacPanelProps {
  currentAdminEmail: string
}

const STATUS_BADGE: Record<
  AdminAuthorizationStatus,
  { label: string; style: string }
> = {
  active: {
    label: 'Đã kích hoạt',
    style: 'border-[#55A747]/35 bg-[#EEF7EC] text-[#2D6A23]',
  },
  pending_activation: {
    label: 'Chờ kích hoạt lần đầu',
    style: 'border-[#F28C28]/40 bg-[#FEF6EC] text-[#9A520B]',
  },
  revoked: {
    label: 'Đã thu hồi',
    style: 'border-[#D94B45]/40 bg-[#FDF1F0] text-[#A92F2A]',
  },
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  BOOTSTRAP_FIRST_LOGIN_ACTIVATED: 'Kích hoạt Super Admin lần đầu',
  ADMIN_INVITATION_ACTIVATED: 'Kích hoạt tài khoản được ủy quyền',
  ADMIN_ROLE_GRANTED: 'Cấp quyền tài khoản mới',
  ADMIN_ROLE_UPDATED: 'Cập nhật ủy quyền quản trị',
  ADMIN_AUTHORIZATION_UPDATED: 'Thay đổi trạng thái quản trị',
  ADMIN_AUTHORIZATION_REVOKED: 'Thu hồi quyền quản trị',
  ADMIN_AUTHORIZATION_DELETED: 'Xóa khỏi danh sách ủy quyền',
}

export function TeacherRbacPanel({ currentAdminEmail }: TeacherRbacPanelProps) {
  const [administrators, setAdministrators] = useState<AdministratorRecord[]>([])
  const [roleDefinitions, setRoleDefinitions] = useState<RoleDefinitionRecord[]>([])
  const [auditLogs, setAuditLogs] = useState<AdminAuditLogRecord[]>([])
  const [systemSettings, setSystemSettings] = useState<SystemSettingsOverview | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [dashboard, settings] = await Promise.all([
        fetchAdminDashboardData(),
        fetchSystemSettingsOverview(),
      ])
      setAdministrators(dashboard.administrators)
      setRoleDefinitions(dashboard.roleDefinitions)
      setAuditLogs(dashboard.auditLogs)
      setSystemSettings(settings)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Không thể tải dữ liệu phân quyền Super Admin.'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const handleToggleRevoke = async (entry: AdministratorRecord) => {
    const nextStatus: AdminAuthorizationStatus =
      entry.status === 'revoked' ? 'active' : 'revoked'
    setBusyId(entry.id)
    setError(null)
    setNotice(null)
    try {
      const updated = await updateAdministratorAuthorizationClient({
        id: entry.id,
        status: nextStatus,
      })
      setNotice(
        updated.status === 'revoked'
          ? `Đã tạm thu hồi quyền quản trị của ${updated.email}.`
          : `Đã khôi phục quyền Super Admin cho ${updated.email} (${STATUS_BADGE[updated.status].label}).`
      )
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể thay đổi trạng thái.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Phase-1 Access Policy Banner */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-[#7954A1]">
              <Crown className="h-4 w-4" />
              <span>Quản trị Super Admin · Phân quyền PostgreSQL</span>
            </div>
            <h2 className="font-display text-lg font-bold text-[#123B68]">
              Danh sách hai tài khoản Super Admin được ủy quyền
            </h2>
            <p className="text-xs leading-relaxed text-[#65758B] max-w-3xl">
              Trong giai đoạn phát triển hiện tại, chỉ đúng hai tài khoản Super Admin đã xác minh email có toàn quyền quản trị ngang nhau. Tính năng đăng ký vai trò Giáo viên và tự đăng ký tài khoản quản trị đã được tắt để đảm bảo an toàn hệ thống; học sinh làm bài trực tiếp không cần tài khoản.
            </p>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={() => void loadAll()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-[#123B68] hover:bg-[#F3F6FA] disabled:opacity-60 transition-colors self-start sm:self-auto"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Làm mới</span>
          </button>
        </div>

        <div className="flex items-start gap-2.5 rounded-lg border border-[#2878B8]/25 bg-[#EAF3FA]/70 px-4 py-3 text-xs text-[#123B68]">
          <Lock className="h-4 w-4 shrink-0 mt-0.5 text-[#2878B8]" />
          <span>
            Chế độ kiểm soát truy cập chặt chẽ: Không cho phép thêm tài khoản quản trị mới hoặc đăng ký vai trò Giáo viên từ giao diện công khai hay API. Mọi thao tác quản trị đều xác thực Firebase ID Token + vai trò <code className="font-mono font-semibold">super_admin</code> trong PostgreSQL.
          </span>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
            <span>{error}</span>
          </div>
        )}

        {notice && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-[#55A747]/40 bg-[#EEF7EC] px-4 py-3 text-xs text-[#2D6A23]"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-[#55A747]" />
            <span>{notice}</span>
          </div>
        )}
      </section>

      {/* Authorized Super Admin Table */}
      <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-[#F3F6FA] px-6 py-3.5">
          <div className="text-xs font-bold text-[#123B68]">
            Tài khoản Super Admin được phép truy cập ({administrators.length})
          </div>
          <span className="text-[11px] text-[#65758B]">
            Bảo vệ chống tự thu hồi &amp; bảo vệ Super Admin cuối cùng
          </span>
        </div>

        {loading ? (
          <div className="flex items-center gap-3 px-6 py-8 text-sm text-[#65758B]">
            <Loader2 className="h-4 w-4 animate-spin text-[#2878B8]" />
            <span>Đang tải danh sách quản trị viên từ PostgreSQL...</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-[#F8FAFC] text-xs font-semibold text-[#65758B]">
                <tr>
                  <th className="px-6 py-3">Email</th>
                  <th className="px-4 py-3">Vai trò</th>
                  <th className="px-4 py-3">Trạng thái tài khoản</th>
                  <th className="px-4 py-3">Ghi chú / Kích hoạt</th>
                  <th className="px-6 py-3 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {administrators.map((entry) => {
                  const isSelf =
                    entry.email.toLowerCase() === currentAdminEmail.toLowerCase()
                  const isBusy = busyId === entry.id
                  const badge = STATUS_BADGE[entry.status]

                  return (
                    <tr key={entry.id} className="hover:bg-[#F3F6FA]/60">
                      <td className="px-6 py-3.5">
                        <div className="font-medium text-[#203247]">
                          {entry.email}
                          {isSelf && (
                            <span className="ml-2 text-[11px] font-semibold text-[#2878B8]">
                              (Tài khoản đang đăng nhập)
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-[#65758B]">
                          Cấp ủy quyền: {entry.grantedByEmail}
                        </div>
                      </td>

                      <td className="px-4 py-3.5">
                        <span className="inline-flex items-center gap-1 rounded-md border border-[#7954A1]/35 bg-[#F4EFF8] px-2 py-0.5 text-[11px] font-semibold text-[#5B3C7D] whitespace-nowrap">
                          <Crown className="h-3 w-3" />
                          <span>Super Admin</span>
                        </span>
                      </td>

                      <td className="px-4 py-3.5">
                        <span
                          className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${badge.style}`}
                        >
                          {entry.status === 'pending_activation' && (
                            <Clock className="h-3 w-3" />
                          )}
                          <span>{badge.label}</span>
                        </span>
                      </td>

                      <td className="px-4 py-3.5 text-xs text-[#65758B]">
                        <div>{entry.note || 'Tài khoản quản trị cấp cao TIN LAB'}</div>
                        {entry.activatedAt && (
                          <div className="text-[11px] tabular-nums mt-0.5">
                            Kích hoạt: {new Date(entry.activatedAt).toLocaleDateString('vi-VN')}
                          </div>
                        )}
                      </td>

                      <td className="px-6 py-3.5">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={isSelf || isBusy}
                            onClick={() => void handleToggleRevoke(entry)}
                            title={
                              isSelf
                                ? 'Không thể tự thu hồi quyền của chính bạn'
                                : entry.status === 'revoked'
                                ? 'Khôi phục quyền'
                                : 'Tạm thu hồi quyền'
                            }
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-[#203247] hover:border-[#F28C28] hover:text-[#9A520B] disabled:opacity-40"
                          >
                            <Ban className="h-3 w-3" />
                            <span>
                              {entry.status === 'revoked' ? 'Khôi phục' : 'Tạm thu hồi'}
                            </span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* System Settings & PostgreSQL Role Permissions Matrix */}
      {systemSettings && (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 space-y-4">
            <div className="flex items-center gap-2 text-sm font-bold text-[#123B68]">
              <Server className="h-4 w-4 text-[#2878B8]" />
              <span>Cài đặt Hệ thống &amp; Hạ tầng Máy chủ</span>
            </div>

            <dl className="divide-y divide-slate-100 text-xs">
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#65758B]">Cơ sở dữ liệu kết quả &amp; RBAC</dt>
                <dd className="font-semibold text-[#2D6A23]">
                  {systemSettings.databaseEngine}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5 gap-3">
                <dt className="text-[#65758B]">Kho lưu trữ tài liệu gốc</dt>
                <dd
                  className={`font-semibold text-right ${
                    systemSettings.objectStorage.configured
                      ? 'text-[#2D6A23]'
                      : 'text-[#9A520B]'
                  }`}
                >
                  {systemSettings.objectStorage.provider === 'google_drive'
                    ? systemSettings.objectStorage.drive?.connected
                      ? `Google Drive (${systemSettings.objectStorage.drive.connectedAccountEmail})`
                      : `Google Drive API (${systemSettings.objectStorage.drive?.targetStorageEmail || 'sunghiep.tsbd@gmail.com'})`
                    : systemSettings.objectStorage.configured
                    ? `${systemSettings.objectStorage.provider?.toUpperCase()} (${systemSettings.objectStorage.bucket})`
                    : 'Chưa cấu hình kho lưu trữ'}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#65758B]">Dịch vụ Email SMTP</dt>
                <dd
                  className={`font-semibold ${
                    systemSettings.emailConfigured ? 'text-[#2D6A23]' : 'text-[#9A520B]'
                  }`}
                >
                  {systemSettings.emailConfigured ? 'Đã cấu hình' : 'Chưa cấu hình SMTP'}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#65758B]">Super Admin (Hoạt động / Chờ)</dt>
                <dd className="font-mono font-semibold tabular-nums text-[#123B68]">
                  {systemSettings.counts.superAdminsActive} /{' '}
                  {systemSettings.counts.superAdminsPending}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#65758B]">Lượt thi đã ghi nhận (PostgreSQL)</dt>
                <dd className="font-mono font-semibold tabular-nums text-[#123B68]">
                  {systemSettings.counts.totalExamAttempts} lượt
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#65758B]">Tài khoản quản trị / Tài liệu</dt>
                <dd className="font-mono font-semibold tabular-nums text-[#123B68]">
                  {systemSettings.counts.totalUsers} tài khoản ·{' '}
                  {systemSettings.counts.totalDocuments} tệp
                </dd>
              </div>
            </dl>
          </div>

          <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-6 space-y-4">
            <div className="flex items-center gap-2 text-sm font-bold text-[#123B68]">
              <ShieldCheck className="h-4 w-4 text-[#7954A1]" />
              <span>Định nghĩa Vai trò &amp; Quyền hạn (PostgreSQL role_definitions)</span>
            </div>

            <div className="space-y-3">
              {roleDefinitions.map((def) => (
                <div
                  key={def.role}
                  className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3.5 space-y-1.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold text-[#123B68]">
                      {def.displayName}
                    </span>
                    <span className="font-mono text-[11px] text-[#65758B]">{def.role}</span>
                  </div>
                  <p className="text-[11px] text-[#65758B] leading-relaxed">
                    {def.description}
                  </p>
                  <div className="pt-1 font-mono text-[11px] text-[#203247] break-words">
                    {def.permissions.join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Audit Logs */}
      {auditLogs.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-200 bg-[#F3F6FA] px-6 py-3.5 text-xs font-bold text-[#123B68]">
            <History className="h-4 w-4 text-[#2878B8]" />
            <span>Nhật ký thay đổi phân quyền gần đây ({auditLogs.length})</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-[#F8FAFC] text-[#65758B]">
                <tr>
                  <th className="px-6 py-2.5">Thời gian</th>
                  <th className="px-4 py-2.5">Hành động</th>
                  <th className="px-4 py-2.5">Người thực hiện</th>
                  <th className="px-6 py-2.5">Tài khoản mục tiêu</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-[#F3F6FA]/60">
                    <td className="px-6 py-2.5 tabular-nums text-[#65758B] whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString('vi-VN')}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-[#123B68]">
                      {AUDIT_ACTION_LABELS[log.action] || log.action}
                    </td>
                    <td className="px-4 py-2.5 text-[#203247]">{log.actorEmail}</td>
                    <td className="px-6 py-2.5 text-[#203247]">{log.targetEmail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
