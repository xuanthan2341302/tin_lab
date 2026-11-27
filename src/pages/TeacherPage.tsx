import { useCallback, useEffect, useState } from 'react'
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth'
import {
  AlertCircle,
  AlertTriangle,
  Award,
  BarChart3,
  BookMarked,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Crown,
  Database,
  FileEdit,
  FileSpreadsheet,
  FileText,
  FileUp,
  FolderArchive,
  Layers,
  LayoutTemplate,
  Loader2,
  LogOut,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { AdminStudentResultsPanel } from '../components/AdminStudentResultsPanel'
import { ExamBuilderPublisher } from '../components/ExamBuilderPublisher'
import { ExamTemplateManager } from '../components/ExamTemplateManager'
import { QuestionBankImporter } from '../components/QuestionBankImporter'
import { SavedQuestionBankPanel } from '../components/SavedQuestionBankPanel'
import { TeacherDocumentLibrary } from '../components/TeacherDocumentLibrary'
import { TeacherRbacPanel } from '../components/TeacherRbacPanel'
import { TeacherSubmissionReviewPanel } from '../components/TeacherSubmissionReviewPanel'
import {
  AdminAuthError,
  logoutAdminSession,
  verifyGoogleAdminSession,
} from '../lib/authClient'
import { fetchAdminDashboardMetrics } from '../lib/dashboardClient'
import {
  fetchTeacherPublishedExamKeys,
  fetchTeacherPublishedExams,
  fetchTeacherSubmissions,
  fetchTeacherTemplates,
} from '../lib/examDb'
import {
  auth,
  clearGoogleDriveToken,
  googleProvider,
  setGoogleDriveToken,
} from '../lib/firebase'
import {
  fetchTeacherImports,
  fetchTeacherQuestionBank,
} from '../lib/questionBankDb'
import type {
  AuthenticatedAccountProfile,
  ExamSubmissionRecord,
  ExamTemplate,
  NavPage,
  PublishedExam,
  PublishedExamKey,
  QuestionBankImportRecord,
  RealDashboardMetricsResponse,
  SavedQuestionBankItem,
  TeacherDocumentRecord,
} from '../types'

interface TeacherPageProps {
  onNavigate: (page: NavPage) => void
}

function GoogleBrandMark() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h6.44a5.5 5.5 0 0 1-2.39 3.61v3h3.87c2.26-2.08 3.57-5.15 3.57-8.64Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.87-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.72-4.95H1.28v3.1A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.29A7.2 7.2 0 0 1 4.9 12c0-.8.14-1.57.38-2.29V6.61H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.39l4-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.76c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.61l4 3.1C6.23 6.87 8.88 4.76 12 4.76Z"
      />
    </svg>
  )
}

type WorkspaceTab =
  | 'results'
  | 'documents'
  | 'import'
  | 'bank'
  | 'templates'
  | 'publish'
  | 'review'
  | 'rbac'

export function TeacherPage({ onNavigate }: TeacherPageProps) {
  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [rbacChecking, setRbacChecking] = useState(false)
  const [accountProfile, setAccountProfile] =
    useState<AuthenticatedAccountProfile | null>(null)
  const [rbacError, setRbacError] = useState<string | null>(null)
  const [deniedNotice, setDeniedNotice] = useState<{
    email: string
    message: string
  } | null>(null)

  const [authActionLoading, setAuthActionLoading] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('results')
  const [savedQuestions, setSavedQuestions] = useState<SavedQuestionBankItem[]>([])
  const [importRecords, setImportRecords] = useState<QuestionBankImportRecord[]>([])
  const [templates, setTemplates] = useState<ExamTemplate[]>([])
  const [publishedExams, setPublishedExams] = useState<PublishedExam[]>([])
  const [examKeys, setExamKeys] = useState<PublishedExamKey[]>([])
  const [submissions, setSubmissions] = useState<ExamSubmissionRecord[]>([])
  const [selectedTemplateForBuilder, setSelectedTemplateForBuilder] = useState<string | null>(
    null
  )
  const [preselectedLibraryDoc, setPreselectedLibraryDoc] =
    useState<TeacherDocumentRecord | null>(null)

  const [bankLoading, setBankLoading] = useState(false)
  const [bankError, setBankError] = useState<string | null>(null)
  const [adminMetrics, setAdminMetrics] =
    useState<RealDashboardMetricsResponse | null>(null)
  const [adminMetricsLoading, setAdminMetricsLoading] = useState(false)
  const [isCloudflarePhase1, setIsCloudflarePhase1] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: { runtime?: string; mode?: string } | null) => {
        if (active && payload?.runtime === 'cloudflare-workers') {
          setIsCloudflarePhase1(true)
        }
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const clearWorkspaceData = useCallback(() => {
    setSavedQuestions([])
    setImportRecords([])
    setTemplates([])
    setPublishedExams([])
    setExamKeys([])
    setSubmissions([])
    setPreselectedLibraryDoc(null)
    setBankError(null)
    setAdminMetrics(null)
  }, [])

  const loadAdminMetrics = useCallback(async () => {
    setAdminMetricsLoading(true)
    try {
      const res = await fetchAdminDashboardMetrics()
      setAdminMetrics(res)
    } catch {
      setAdminMetrics(null)
    } finally {
      setAdminMetricsLoading(false)
    }
  }, [])

  const loadTeacherWorkspace = useCallback(
    async (uid: string) => {
      setBankLoading(true)
      setBankError(null)
      void loadAdminMetrics()
      try {
        const [questions, imports, tpls, pubExams, keys, subs] = await Promise.all([
          fetchTeacherQuestionBank(uid),
          fetchTeacherImports(uid),
          fetchTeacherTemplates(uid),
          fetchTeacherPublishedExams(uid),
          fetchTeacherPublishedExamKeys(uid),
          fetchTeacherSubmissions(uid),
        ])
        setSavedQuestions(questions)
        setImportRecords(imports)
        setTemplates(tpls)
        setPublishedExams(pubExams)
        setExamKeys(keys)
        setSubmissions(subs)
      } catch (err) {
        setBankError(
          err instanceof Error
            ? err.message
            : 'Không thể tải dữ liệu đề thi từ Cloud Firestore.'
        )
      } finally {
        setBankLoading(false)
      }
    },
    [loadAdminMetrics]
  )

  const verifyServerSuperAdminRole = useCallback(
    async (firebaseUser: User, forceRefresh = false) => {
      setRbacChecking(true)
      setRbacError(null)
      try {
        const profile = await verifyGoogleAdminSession(forceRefresh)
        if (profile.isSuperAdmin) {
          setDeniedNotice(null)
          setAuthError(null)
          setAccountProfile(profile)
          void loadTeacherWorkspace(firebaseUser.uid)
        } else {
          setAccountProfile(null)
          clearWorkspaceData()
          setDeniedNotice({
            email: firebaseUser.email || '',
            message: 'Tài khoản Google này chưa được cấp quyền quản trị TIN LAB.',
          })
          await signOut(auth).catch(() => undefined)
          clearGoogleDriveToken()
        }
      } catch (err) {
        setAccountProfile(null)
        clearWorkspaceData()

        if (err instanceof AdminAuthError && err.status === 403) {
          // Immediately clear unauthorized Google session so no stale client login remains
          setDeniedNotice({
            email: firebaseUser.email || '',
            message:
              err.message ||
              'Tài khoản Google này chưa được cấp quyền quản trị TIN LAB.',
          })
          clearGoogleDriveToken()
          await signOut(auth).catch(() => undefined)
        } else {
          setRbacError(
            err instanceof Error
              ? err.message
              : 'Không thể xác minh tài khoản quản trị với máy chủ.'
          )
        }
      } finally {
        setRbacChecking(false)
      }
    },
    [clearWorkspaceData, loadTeacherWorkspace]
  )

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser)
      setAuthReady(true)
      if (nextUser) {
        void verifyServerSuperAdminRole(nextUser, false)
      } else {
        setAccountProfile(null)
        setRbacError(null)
        clearWorkspaceData()
      }
    })
    return () => unsubscribe()
  }, [clearWorkspaceData, verifyServerSuperAdminRole])

  const handleGoogleSignIn = async () => {
    setAuthError(null)
    setRbacError(null)
    setDeniedNotice(null)
    setAuthActionLoading(true)
    try {
      const result = await signInWithPopup(auth, googleProvider)
      const credential = GoogleAuthProvider.credentialFromResult(result)
      if (credential?.accessToken) {
        setGoogleDriveToken(credential.accessToken, result.user.email)
      }
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code ?? '')
          : ''
      const msg = err instanceof Error ? err.message : String(err)
      if (code === 'auth/popup-closed-by-user' || msg.includes('popup-closed-by-user')) {
        setAuthError('Cửa sổ đăng nhập Google đã bị đóng trước khi hoàn tất.')
      } else if (code === 'auth/popup-blocked' || msg.includes('popup-blocked')) {
        setAuthError(
          'Trình duyệt đang chặn cửa sổ đăng nhập Google. Vui lòng cho phép popup cho trang này rồi thử lại.'
        )
      } else if (
        code === 'auth/unauthorized-domain' ||
        msg.includes('unauthorized-domain')
      ) {
        setAuthError(
          `Tên miền hiện tại (${window.location.hostname}) chưa được thêm vào Authorized domains trong Firebase Authentication. Vui lòng thêm tên miền này trong Firebase Console → Authentication → Settings → Authorized domains.`
        )
      } else {
        setAuthError('Không thể mở đăng nhập bằng Google lúc này. Vui lòng thử lại.')
      }
    } finally {
      setAuthActionLoading(false)
    }
  }

  const handleSignOut = async () => {
    setAuthError(null)
    setRbacError(null)
    setDeniedNotice(null)
    setAuthActionLoading(true)
    try {
      clearGoogleDriveToken()
      await logoutAdminSession()
      await signOut(auth)
      setAccountProfile(null)
      clearWorkspaceData()
    } catch {
      setAuthError('Không thể đăng xuất lúc này. Vui lòng thử lại.')
    } finally {
      setAuthActionLoading(false)
    }
  }

  const pendingReviewCount = submissions.filter(
    (s) => s.gradingStatus === 'needs_teacher_review'
  ).length

  return (
    <div className="space-y-8">
      {/* Admin Area Intro */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-3 max-w-2xl">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-[#2878B8]">
              <Users className="h-4 w-4" />
              <span>Cổng Quản trị TIN LAB (Super Admin) · Học liệu &amp; Khảo thí Tin học 12</span>
            </div>
            <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-[#123B68] text-balance">
              Quản trị kết quả học sinh, thư viện tài liệu và ngân hàng đề thi
            </h1>
            <p className="text-sm sm:text-base leading-relaxed text-[#203247]">
              Khu vực quản trị sử dụng xác thực Google OAuth và kiểm tra danh sách Super Admin trực tiếp ở phía máy chủ. Học sinh không cần tài khoản để làm bài luyện tập và kiểm tra.
            </p>
          </div>

          <button
            type="button"
            onClick={() => onNavigate('stats')}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 min-h-[44px] text-sm font-semibold text-[#123B68] hover:bg-[#F3F6F9] hover:border-[#2878B8] hover:text-[#2878B8] transition-colors whitespace-nowrap shrink-0"
          >
            <BarChart3 className="h-4 w-4 text-[#2878B8]" />
            <span>Xem trang Thống kê thực tế</span>
          </button>
        </div>
      </section>

      {/* Authentication, RBAC Verification, or Super Admin Workspace */}
      {!authReady || (user && rbacChecking) ? (
        <section className="rounded-xl border border-slate-200 bg-white p-8 flex items-center gap-3 text-sm text-[#65758B]">
          <Loader2 className="h-5 w-5 animate-spin text-[#2878B8]" />
          <span>Đang xác thực tài khoản Google và kiểm tra quyền quản trị trên máy chủ...</span>
        </section>
      ) : !user ? (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 space-y-5">
            <div className="space-y-1.5">
              <h2 className="font-display text-lg font-bold text-[#123B68]">
                Đăng nhập quản trị
              </h2>
              <p className="text-xs leading-relaxed text-[#65758B]">
                Chọn tài khoản Google Super Admin đã được cấp quyền để truy cập bảng điều khiển quản trị, kết quả học sinh và ngân hàng câu hỏi TIN LAB.
              </p>
            </div>

            {deniedNotice && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-[#D94B45]/45 bg-[#FDF1F0] px-3.5 py-3 text-xs text-[#A92F2A]"
              >
                <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
                <div className="space-y-1">
                  <div className="font-bold text-[#8E221E]">{deniedNotice.message}</div>
                  {deniedNotice.email && (
                    <div className="text-[11px] text-[#A92F2A]/90">
                      Email vừa chọn: <strong className="font-mono">{deniedNotice.email}</strong>. Phiên tạm đã được đăng xuất tự động — bạn có thể chọn lại tài khoản Google Super Admin khác bên dưới.
                    </div>
                  )}
                </div>
              </div>
            )}

            {authError && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-3.5 py-3 text-xs text-[#A92F2A]"
              >
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
                <span>{authError}</span>
              </div>
            )}

            <button
              type="button"
              disabled={authActionLoading}
              onClick={() => void handleGoogleSignIn()}
              className="w-full inline-flex items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white px-5 py-3 min-h-[46px] text-sm font-semibold text-[#123B68] shadow-xs hover:border-[#2878B8] hover:bg-[#F3F6FA] disabled:opacity-60 transition-colors whitespace-nowrap"
            >
              {authActionLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin text-[#2878B8]" />
                  <span>Đang mở xác thực Google...</span>
                </>
              ) : (
                <>
                  <GoogleBrandMark />
                  <span>Đăng nhập bằng Google</span>
                </>
              )}
            </button>

            <div className="rounded-lg border border-slate-200 bg-[#F3F6FA] p-3.5 text-xs text-[#65758B] leading-relaxed">
              Hệ thống không sử dụng mật khẩu riêng cho trang quản trị và không cho phép tự đăng ký. Danh tính Google được gửi về máy chủ để xác minh chữ ký ID Token và đối chiếu danh sách Super Admin được cấp phép.
            </div>

            <div className="border-t border-slate-200 pt-4 flex items-center justify-between gap-3 text-xs">
              <span className="text-[#65758B]">Học sinh làm bài không cần đăng nhập</span>
              <button
                type="button"
                onClick={() => onNavigate('student')}
                className="font-semibold text-[#2878B8] hover:text-[#123B68] whitespace-nowrap shrink-0"
              >
                Vào khu vực Học sinh →
              </button>
            </div>
          </div>

          <div className="lg:col-span-7 space-y-4">
            <h2 className="font-display text-lg font-bold text-[#123B68]">
              Chức năng dành riêng cho Super Admin
            </h2>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#EAF3FA] text-[#2878B8] border border-[#2878B8]/20">
                  <BarChart3 className="h-5 w-5" />
                </div>
                <h3 className="font-display text-base font-bold text-[#123B68]">
                  Kết quả học sinh &amp; Xuất CSV / Excel
                </h3>
                <p className="text-xs leading-relaxed text-[#65758B]">
                  Tìm kiếm, lọc theo lớp/đề/ngày, theo dõi tiến độ nhiều lượt, thống kê điểm trung bình và xuất tệp CSV UTF-8 tương thích Microsoft Excel.
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#F4EFF8] text-[#7954A1] border border-[#7954A1]/20">
                  <FolderArchive className="h-5 w-5" />
                </div>
                <h3 className="font-display text-base font-bold text-[#123B68]">
                  Thư viện Tài liệu (PDF, DOCX, TXT)
                </h3>
                <p className="text-xs leading-relaxed text-[#65758B]">
                  Lưu trữ học liệu trên Object Storage, xem trước, tải về và nhập ngân hàng câu hỏi đa định dạng.
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#EEF7EC] text-[#55A747] border border-[#55A747]/20">
                  <ClipboardList className="h-5 w-5" />
                </div>
                <h3 className="font-display text-base font-bold text-[#123B68]">
                  Cấu trúc đề thi &amp; Xuất bản
                </h3>
                <p className="text-xs leading-relaxed text-[#65758B]">
                  Tùy chỉnh mẫu 45 phút 3 phần (12 TN · 4 Đúng/Sai · Tự luận - 10đ) và xuất bản mã phòng thi cho học sinh.
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-5 flex flex-col justify-between space-y-3">
                <div className="space-y-2">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#FEF6EC] text-[#F28C28] border border-[#F28C28]/20">
                    <FileSpreadsheet className="h-5 w-5" />
                  </div>
                  <h3 className="font-display text-base font-bold text-[#123B68]">
                    Chấm tự động &amp; Duyệt Tự luận
                  </h3>
                  <p className="text-xs leading-relaxed text-[#65758B]">
                    Trắc nghiệm &amp; Đúng/Sai được chấm tự động theo đáp án chuẩn; câu Tự luận chấm theo Rubric và duyệt điểm cuối.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('guide')}
                  className="text-left text-xs font-semibold text-[#2878B8] hover:text-[#123B68]"
                >
                  Mở Hướng dẫn sử dụng →
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : rbacError ? (
        <section className="rounded-xl border border-[#F28C28]/45 bg-white p-6 sm:p-8 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div className="flex items-start gap-3.5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#F28C28]/35 bg-[#FEF6EC] text-[#C86D14]">
                <AlertCircle className="h-5 w-5" />
              </div>
              <div className="space-y-1.5">
                <h2 className="font-display text-lg font-bold text-[#123B68]">
                  Không thể xác minh quyền quản trị với máy chủ
                </h2>
                <p className="text-xs leading-relaxed text-[#203247] max-w-2xl">
                  {rbacError}
                </p>
                <div className="pt-1 text-xs text-[#65758B]">
                  Tài khoản Google hiện tại:{' '}
                  <strong className="text-[#123B68]">{user.email}</strong>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={rbacChecking}
                onClick={() => void verifyServerSuperAdminRole(user, true)}
                className="inline-flex items-center gap-2 rounded-lg bg-[#2878B8] px-4 py-2 text-xs font-semibold text-white hover:bg-[#123B68] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${rbacChecking ? 'animate-spin' : ''}`} />
                <span>Thử xác minh lại</span>
              </button>
              <button
                type="button"
                disabled={authActionLoading}
                onClick={() => void handleSignOut()}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-[#203247] hover:bg-[#F3F6FA] hover:text-[#D94B45] transition-colors whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Đăng xuất</span>
              </button>
            </div>
          </div>
        </section>
      ) : !accountProfile || !accountProfile.isSuperAdmin ? (
        <section className="rounded-xl border border-[#D94B45]/35 bg-white p-6 sm:p-8 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div className="flex items-start gap-3.5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#D94B45]/30 bg-[#FDF1F0] text-[#D94B45]">
                <ShieldAlert className="h-5 w-5" />
              </div>
              <div className="space-y-1.5">
                <h2 className="font-display text-lg font-bold text-[#123B68]">
                  Tài khoản Google này chưa được cấp quyền quản trị TIN LAB.
                </h2>
                <p className="text-xs leading-relaxed text-[#203247] max-w-2xl">
                  Máy chủ đã xác thực tài khoản Google của bạn nhưng email này không nằm trong danh sách Super Admin chính thức của TIN LAB.
                </p>
                <div className="pt-1 text-xs text-[#65758B]">
                  Email đã xác thực:{' '}
                  <strong className="text-[#123B68]">{user.email}</strong> · Quyền từ máy chủ:{' '}
                  <strong className="text-[#A92F2A]">Không có quyền quản trị</strong>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onNavigate('student')}
                className="inline-flex items-center gap-2 rounded-lg bg-[#2878B8] px-4 py-2 text-xs font-semibold text-white hover:bg-[#123B68] transition-colors whitespace-nowrap shrink-0"
              >
                <BookMarked className="h-3.5 w-3.5" />
                <span>Chuyển sang khu vực Học sinh</span>
              </button>
              <button
                type="button"
                disabled={authActionLoading}
                onClick={() => void handleSignOut()}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-[#203247] hover:bg-[#F3F6FA] hover:text-[#D94B45] transition-colors whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Đăng xuất</span>
              </button>
            </div>
          </div>
        </section>
      ) : (
        <div className="space-y-6">
          {/* Signed-in Super Admin Bar + Workspace Tabs */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#123B68] text-xs font-bold text-white">
                  SA
                </div>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-base font-bold text-[#123B68]">
                      {accountProfile.displayName || user.displayName || 'Super Admin TIN LAB'}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-md border border-[#7954A1]/35 bg-[#F4EFF8] px-2 py-0.5 text-[11px] font-semibold text-[#5B3C7D]">
                      <Crown className="h-3 w-3" />
                      <span>Quyền máy chủ: Super Admin ({accountProfile.role})</span>
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-md border border-[#55A747]/35 bg-[#EEF7EC] px-2 py-0.5 text-[11px] font-semibold text-[#2D6A23]">
                      <CheckCircle2 className="h-3 w-3" />
                      <span>Đã xác thực Google</span>
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#65758B]">
                    <span>
                      Email đã xác thực:{' '}
                      <strong className="font-medium text-[#203247]">
                        {accountProfile.email}
                      </strong>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Trạng thái:{' '}
                      <strong className="font-medium text-[#2D6A23]">
                        Đang hoạt động (Toàn quyền quản trị)
                      </strong>
                    </span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                disabled={authActionLoading}
                onClick={() => void handleSignOut()}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-[#203247] hover:bg-[#F3F6FA] hover:text-[#D94B45] transition-colors self-start sm:self-auto whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Đăng xuất</span>
              </button>
            </div>

            {bankError && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]"
              >
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
                <span>{bankError}</span>
              </div>
            )}

            <div className="border-t border-slate-200 pt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('results')}
                className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs sm:text-sm font-semibold transition-colors ${
                  activeTab === 'results'
                    ? 'bg-[#123B68] text-white'
                    : 'border border-slate-200 bg-[#F3F6FA] text-[#203247] hover:bg-slate-200/70'
                }`}
              >
                <BarChart3 className="h-4 w-4" />
                <span>Kết quả học sinh</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('documents')}
                className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs sm:text-sm font-semibold transition-colors ${
                  activeTab === 'documents'
                    ? 'bg-[#123B68] text-white'
                    : 'border border-slate-200 bg-[#F3F6FA] text-[#203247] hover:bg-slate-200/70'
                }`}
              >
                <FolderArchive className="h-4 w-4" />
                <span>
                  Thư viện tài liệu{isCloudflarePhase1 ? ' (Tạm hoãn GĐ 2)' : ''}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('import')}
                className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs sm:text-sm font-semibold transition-colors ${
                  activeTab === 'import'
                    ? 'bg-[#123B68] text-white'
                    : 'border border-slate-200 bg-[#F3F6FA] text-[#203247] hover:bg-slate-200/70'
                }`}
              >
                <FileUp className="h-4 w-4" />
                <span>
                  Nhập tài liệu &amp; AI Agent{isCloudflarePhase1 ? ' (Tạm hoãn GĐ 2)' : ''}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('bank')}
                className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs sm:text-sm font-semibold transition-colors tabular-nums ${
                  activeTab === 'bank'
                    ? 'bg-[#123B68] text-white'
                    : 'border border-slate-200 bg-[#F3F6FA] text-[#203247] hover:bg-slate-200/70'
                }`}
              >
                <Database className="h-4 w-4" />
                <span>Ngân hàng câu hỏi ({savedQuestions.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('templates')}
                className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs sm:text-sm font-semibold transition-colors tabular-nums ${
                  activeTab === 'templates'
                    ? 'bg-[#123B68] text-white'
                    : 'border border-slate-200 bg-[#F3F6FA] text-[#203247] hover:bg-slate-200/70'
                }`}
              >
                <LayoutTemplate className="h-4 w-4" />
                <span>Cấu trúc đề thi ({templates.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('publish')}
                className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs sm:text-sm font-semibold transition-colors tabular-nums ${
                  activeTab === 'publish'
                    ? 'bg-[#123B68] text-white'
                    : 'border border-slate-200 bg-[#F3F6FA] text-[#203247] hover:bg-slate-200/70'
                }`}
              >
                <Send className="h-4 w-4" />
                <span>Tạo &amp; Xuất bản đề ({publishedExams.length})</span>
              </button>

              {submissions.length > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveTab('review')}
                  className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs sm:text-sm font-semibold transition-colors tabular-nums ${
                    activeTab === 'review'
                      ? 'bg-[#123B68] text-white'
                      : 'border border-slate-200 bg-[#F3F6FA] text-[#203247] hover:bg-slate-200/70'
                  }`}
                >
                  <ClipboardCheck className="h-4 w-4" />
                  <span>
                    Bài nộp Firestore ({submissions.length})
                    {pendingReviewCount > 0 ? ` · ${pendingReviewCount} chờ duyệt` : ''}
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setActiveTab('rbac')}
                className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs sm:text-sm font-semibold transition-colors ${
                  activeTab === 'rbac'
                    ? 'bg-[#123B68] text-white'
                    : 'border border-slate-200 bg-[#F3F6FA] text-[#203247] hover:bg-slate-200/70'
                }`}
              >
                <ShieldCheck className="h-4 w-4" />
                <span>Quản trị &amp; Phân quyền</span>
              </button>
            </div>
          </section>

          {/* Real 7-Metric Admin Overview Strip (Zero Mock Data) */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-sm font-bold text-[#123B68]">
                  Tổng quan dữ liệu hệ thống (Số liệu thực tế)
                </h2>
                <p className="text-[11px] text-[#65758B]">
                  Phân tách rõ tài liệu gốc, câu hỏi trích xuất, bản nháp, ngoại lệ, ngân hàng chính thức, đề thi xuất bản và kết quả học sinh.
                </p>
              </div>
              <button
                type="button"
                disabled={adminMetricsLoading || bankLoading}
                onClick={() => void loadTeacherWorkspace(user.uid)}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-[#123B68] hover:border-[#2878B8] hover:text-[#2878B8] disabled:opacity-60 transition-colors"
              >
                <RefreshCw
                  className={`h-3 w-3 ${adminMetricsLoading || bankLoading ? 'animate-spin' : ''}`}
                />
                <span>Làm mới chỉ số</span>
              </button>
            </div>

            {adminMetrics &&
              !adminMetrics.dataSources.postgresAvailable &&
              adminMetrics.dataSources.postgresNotice && (
                <div
                  role="status"
                  className="flex items-start gap-2 rounded-lg border border-[#F28C28]/40 bg-[#FEF6EC] px-3.5 py-2.5 text-xs text-[#9A520B]"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#F28C28]" />
                  <span>{adminMetrics.dataSources.postgresNotice}</span>
                </div>
              )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
              <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3 space-y-1">
                <div className="flex items-center justify-between text-[11px] font-medium text-[#65758B]">
                  <span>Tài liệu tải lên</span>
                  <FileText className="h-3.5 w-3.5 text-[#3C7F31]" />
                </div>
                <div className="font-display text-xl font-extrabold text-[#123B68] tabular-nums">
                  {adminMetrics?.metrics.uploadedDocumentsCount ?? 0}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3 space-y-1">
                <div className="flex items-center justify-between text-[11px] font-medium text-[#65758B]">
                  <span>Đã trích xuất</span>
                  <Layers className="h-3.5 w-3.5 text-[#2878B8]" />
                </div>
                <div className="font-display text-xl font-extrabold text-[#123B68] tabular-nums">
                  {adminMetrics?.metrics.extractedQuestionsCount ?? 0}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3 space-y-1">
                <div className="flex items-center justify-between text-[11px] font-medium text-[#65758B]">
                  <span>Bản nháp</span>
                  <FileEdit className="h-3.5 w-3.5 text-[#123B68]" />
                </div>
                <div className="font-display text-xl font-extrabold text-[#123B68] tabular-nums">
                  {adminMetrics?.metrics.draftQuestionsCount ?? 0}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3 space-y-1">
                <div className="flex items-center justify-between text-[11px] font-medium text-[#65758B]">
                  <span>Ngoại lệ</span>
                  <AlertTriangle className="h-3.5 w-3.5 text-[#C86D14]" />
                </div>
                <div className="font-display text-xl font-extrabold text-[#C86D14] tabular-nums">
                  {adminMetrics?.metrics.exceptionQuestionsCount ?? 0}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3 space-y-1">
                <div className="flex items-center justify-between text-[11px] font-medium text-[#65758B]">
                  <span>Ngân hàng chính thức</span>
                  <Database className="h-3.5 w-3.5 text-[#3B5BDB]" />
                </div>
                <div className="font-display text-xl font-extrabold text-[#123B68] tabular-nums">
                  {savedQuestions.length}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3 space-y-1">
                <div className="flex items-center justify-between text-[11px] font-medium text-[#65758B]">
                  <span>Đề đã xuất bản</span>
                  <ClipboardCheck className="h-3.5 w-3.5 text-[#7954A1]" />
                </div>
                <div className="font-display text-xl font-extrabold text-[#123B68] tabular-nums">
                  {publishedExams.length}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3 space-y-1">
                <div className="flex items-center justify-between text-[11px] font-medium text-[#65758B]">
                  <span>Kết quả HS</span>
                  <Award className="h-3.5 w-3.5 text-[#2D6A23]" />
                </div>
                <div className="font-display text-xl font-extrabold text-[#123B68] tabular-nums">
                  {adminMetrics?.metrics.studentAttemptsTotal ?? 0}
                </div>
                <div className="text-[10px] text-[#65758B] truncate tabular-nums">
                  {adminMetrics?.metrics.averageScore !== null &&
                  adminMetrics?.metrics.averageScore !== undefined
                    ? `TB: ${adminMetrics.metrics.averageScore}/10`
                    : 'Chưa có dữ liệu điểm'}
                </div>
              </div>
            </div>
          </section>

          {activeTab === 'results' && <AdminStudentResultsPanel />}

          {activeTab === 'documents' &&
            (isCloudflarePhase1 ? (
              <section className="rounded-xl border border-[#F28C28]/40 bg-white p-6 sm:p-8 space-y-4">
                <div className="flex items-start gap-3.5">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#F28C28]/35 bg-[#FEF6EC] text-[#C86D14]">
                    <FolderArchive className="h-5 w-5" />
                  </div>
                  <div className="space-y-1.5">
                    <h2 className="font-display text-lg font-bold text-[#123B68]">
                      Thư viện tài liệu Google Drive chưa khả dụng ở Giai đoạn 1
                    </h2>
                    <p className="text-xs sm:text-sm leading-relaxed text-[#203247] max-w-2xl">
                      Phiên bản vận hành cơ bản trên Cloudflare Workers tập trung vào độ ổn định và miễn phí cho 10–40 học sinh làm bài đồng thời. Chức năng tải lên DOCX/PDF và lưu trữ Google Drive được giữ nguyên mã nguồn và dữ liệu hiện có để kích hoạt lại ở Giai đoạn 2.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setActiveTab('results')}
                    className="rounded-lg bg-[#2878B8] px-4 py-2 text-xs font-semibold text-white hover:bg-[#123B68] transition-colors"
                  >
                    Mở bảng Kết quả học sinh
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('bank')}
                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-[#123B68] hover:bg-[#F3F6FA] transition-colors"
                  >
                    Xem Ngân hàng câu hỏi hiện có
                  </button>
                </div>
              </section>
            ) : (
              <TeacherDocumentLibrary
                onOpenInImporter={(doc) => {
                  setPreselectedLibraryDoc(doc)
                  setActiveTab('import')
                }}
              />
            ))}

          {activeTab === 'import' &&
            (isCloudflarePhase1 ? (
              <section className="rounded-xl border border-[#F28C28]/40 bg-white p-6 sm:p-8 space-y-4">
                <div className="flex items-start gap-3.5">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#F28C28]/35 bg-[#FEF6EC] text-[#C86D14]">
                    <FileUp className="h-5 w-5" />
                  </div>
                  <div className="space-y-1.5">
                    <h2 className="font-display text-lg font-bold text-[#123B68]">
                      Nhập tài liệu &amp; AI Agent chưa khả dụng ở Giai đoạn 1
                    </h2>
                    <p className="text-xs sm:text-sm leading-relaxed text-[#203247] max-w-2xl">
                      Tính năng tải lên tệp DOCX/PDF, phân tích đề bằng AI Agent và xử lý ngoại lệ hàng loạt được tạm hoãn trên Cloudflare Workers (Giai đoạn 1). Toàn bộ mã nguồn xử lý tài liệu, ngân hàng câu hỏi và đề thi đã xuất bản hiện có vẫn được giữ nguyên vẹn cho Giai đoạn 2.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setActiveTab('bank')}
                    className="rounded-lg bg-[#2878B8] px-4 py-2 text-xs font-semibold text-white hover:bg-[#123B68] transition-colors"
                  >
                    Xem Ngân hàng câu hỏi hiện có
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('publish')}
                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-[#123B68] hover:bg-[#F3F6FA] transition-colors"
                  >
                    Tạo &amp; Xuất bản đề thi
                  </button>
                </div>
              </section>
            ) : (
              <QuestionBankImporter
                ownerUid={user.uid}
                emailVerified={user.emailVerified}
                existingBank={savedQuestions}
                existingImports={importRecords}
                preselectedLibraryDoc={preselectedLibraryDoc}
                onClearPreselectedLibraryDoc={() => setPreselectedLibraryDoc(null)}
                onSavedToDb={() => loadTeacherWorkspace(user.uid)}
                onViewSavedBank={() => setActiveTab('bank')}
              />
            ))}

          {activeTab === 'bank' && (
            <SavedQuestionBankPanel
              ownerUid={user.uid}
              emailVerified={user.emailVerified}
              questions={savedQuestions}
              imports={importRecords}
              loading={bankLoading}
              onRefresh={() => loadTeacherWorkspace(user.uid)}
              onSwitchToImport={() => setActiveTab('import')}
            />
          )}

          {activeTab === 'templates' && (
            <ExamTemplateManager
              ownerUid={user.uid}
              emailVerified={user.emailVerified}
              templates={templates}
              onRefresh={() => loadTeacherWorkspace(user.uid)}
              onUseTemplate={(tpl) => {
                setSelectedTemplateForBuilder(tpl.id)
                setActiveTab('publish')
              }}
            />
          )}

          {activeTab === 'publish' && (
            <ExamBuilderPublisher
              ownerUid={user.uid}
              teacherName={user.displayName || user.email || 'Super Admin TIN LAB'}
              emailVerified={user.emailVerified}
              templates={templates}
              initialTemplateId={selectedTemplateForBuilder}
              questions={savedQuestions}
              publishedExams={publishedExams}
              onRefresh={() => loadTeacherWorkspace(user.uid)}
              onNeedTemplates={() => setActiveTab('templates')}
            />
          )}

          {activeTab === 'review' && (
            <TeacherSubmissionReviewPanel
              submissions={submissions}
              publishedExams={publishedExams}
              examKeys={examKeys}
              onRefresh={() => loadTeacherWorkspace(user.uid)}
            />
          )}

          {activeTab === 'rbac' && (
            <TeacherRbacPanel currentAdminEmail={accountProfile.email} />
          )}
        </div>
      )}
    </div>
  )
}
