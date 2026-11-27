import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react'
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Cloud,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  FileText,
  FileUp,
  FlaskConical,
  FolderCheck,
  FolderOpen,
  FolderTree,
  Link2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import {
  deleteTeacherDocument,
  downloadTeacherDocument,
  fetchDocumentPreview,
  fetchTeacherDocuments,
  initializeGoogleDriveFolders,
  queueDocumentForAiAnalysis,
  runGoogleDriveSelfTest,
  uploadTeacherDocuments,
  type DocumentPreviewResult,
} from '../lib/documentLibraryClient'
import {
  connectGoogleDriveWithPopup,
  subscribeGoogleDriveToken,
} from '../lib/firebase'
import type {
  DocumentApprovalStatus,
  DocumentProcessingStatus,
  DriveSubfolderKey,
  GoogleDriveConnectionInfo,
  GoogleDriveSelfTestResult,
  ObjectStorageStatusInfo,
  TeacherDocumentRecord,
} from '../types'

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024
const MAX_BATCH_FILES = 10

const DRIVE_SUBFOLDER_OPTIONS: readonly {
  key: DriveSubfolderKey
  label: string
  description: string
}[] = [
  {
    key: '01_TAI_LIEU_GOC',
    label: '01_TAI_LIEU_GOC',
    description: 'Tài liệu gốc, đề cương, câu hỏi nguồn',
  },
  {
    key: '02_FILE_DAP_AN',
    label: '02_FILE_DAP_AN',
    description: 'File đáp án riêng, bảng đáp án, lời giải',
  },
  {
    key: '03_TAI_LIEU_TONG_HOP',
    label: '03_TAI_LIEU_TONG_HOP',
    description: 'Tài liệu ôn tập tổng hợp nhiều bài học',
  },
  {
    key: '04_DE_THI',
    label: '04_DE_THI',
    description: 'Đề thi chính thức, đề ôn tập, ma trận đề',
  },
  {
    key: '05_BAO_CAO',
    label: '05_BAO_CAO',
    description: 'Báo cáo thống kê, kết quả đối soát',
  },
] as const

const ALL_STATUSES: DocumentProcessingStatus[] = [
  'Uploaded',
  'Pending analysis',
  'Processing',
  'Completed',
  'Needs review',
  'Failed',
]

const STATUS_META: Record<
  DocumentProcessingStatus,
  { label: string; style: string; description: string }
> = {
  Uploaded: {
    label: 'Đã tải lên',
    style: 'border-[#2878B8]/30 bg-[#EAF3FA] text-[#123B68]',
    description: 'Đã lưu trữ trên Google Drive và xác minh đọc lại thành công.',
  },
  'Pending analysis': {
    label: 'Chờ AI xử lý',
    style: 'border-[#7954A1]/30 bg-[#F4EFF8] text-[#5B3C7D]',
    description: 'Đã sẵn sàng trong hàng đợi cho TIN LAB Document AI Agent.',
  },
  Processing: {
    label: 'Đang xử lý AI',
    style: 'border-[#2878B8]/40 bg-[#EAF2FF] text-[#1D5F96]',
    description: 'TIN LAB Document AI Agent đang phân tích tài liệu.',
  },
  Completed: {
    label: 'Hoàn tất AI',
    style: 'border-[#55A747]/35 bg-[#EEF7EC] text-[#2D6A23]',
    description: 'Document AI Agent đã xử lý và trích xuất xong.',
  },
  'Needs review': {
    label: 'Cần rà soát',
    style: 'border-[#F28C28]/40 bg-[#FEF6EC] text-[#9A520B]',
    description: 'Cần quản trị viên rà soát lại đáp án hoặc nội dung câu hỏi.',
  },
  Failed: {
    label: 'Lỗi xử lý',
    style: 'border-[#D94B45]/40 bg-[#FDF1F0] text-[#A92F2A]',
    description: 'Quá trình xử lý gặp sự cố, cần kiểm tra lại.',
  },
}

const APPROVAL_META: Record<DocumentApprovalStatus, { style: string }> = {
  approved: {
    style: 'border-[#55A747]/35 bg-[#EEF7EC] text-[#2D6A23]',
  },
  partial: {
    style: 'border-[#2878B8]/35 bg-[#EAF3FA] text-[#123B68]',
  },
  pending: {
    style: 'border-[#F28C28]/40 bg-[#FEF6EC] text-[#9A520B]',
  },
  not_extracted: {
    style: 'border-slate-200 bg-[#F8FAFC] text-[#65758B]',
  },
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDateVi(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface TeacherDocumentLibraryProps {
  onOpenInImporter?: (doc: TeacherDocumentRecord) => void
}

export function TeacherDocumentLibrary({
  onOpenInImporter,
}: TeacherDocumentLibraryProps = {}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [documents, setDocuments] = useState<TeacherDocumentRecord[]>([])
  const [storageInfo, setStorageInfo] = useState<ObjectStorageStatusInfo | null>(null)
  const [driveInfo, setDriveInfo] = useState<GoogleDriveConnectionInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Google Drive connection & verification state
  const [connectingDrive, setConnectingDrive] = useState(false)
  const [initializingFolders, setInitializingFolders] = useState(false)
  const [runningSelfTest, setRunningSelfTest] = useState(false)
  const [driveActionError, setDriveActionError] = useState<string | null>(null)
  const [driveActionNotice, setDriveActionNotice] = useState<string | null>(null)
  const [selfTestResult, setSelfTestResult] = useState<GoogleDriveSelfTestResult | null>(null)

  // Upload state
  const [selectedFolderKey, setSelectedFolderKey] =
    useState<DriveSubfolderKey>('01_TAI_LIEU_GOC')
  const [dragActive, setDragActive] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadNotice, setUploadNotice] = useState<string | null>(null)

  // Filter & row actions
  const [statusFilter, setStatusFilter] = useState<DocumentProcessingStatus | 'all'>('all')
  const [folderFilter, setFolderFilter] = useState<DriveSubfolderKey | 'all' | 'no_file'>('all')
  const [busyDocId, setBusyDocId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [previewDoc, setPreviewDoc] = useState<TeacherDocumentRecord | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewResult, setPreviewResult] = useState<DocumentPreviewResult | null>(null)

  const [confirmDeleteDoc, setConfirmDeleteDoc] = useState<TeacherDocumentRecord | null>(null)

  const loadLibrary = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetchTeacherDocuments()
      setStorageInfo(res.storage)
      setDriveInfo(res.drive ?? res.storage.drive ?? null)
      setDocuments(res.documents)
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : 'Không thể tải danh sách tài liệu từ PostgreSQL.'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadLibrary()
  }, [loadLibrary])

  useEffect(() => {
    return subscribeGoogleDriveToken(() => {
      void loadLibrary()
    })
  }, [loadLibrary])

  useEffect(() => {
    return () => {
      if (previewResult && previewResult.kind === 'pdf') {
        URL.revokeObjectURL(previewResult.blobUrl)
      }
    }
  }, [previewResult])

  const closePreview = () => {
    if (previewResult && previewResult.kind === 'pdf') {
      URL.revokeObjectURL(previewResult.blobUrl)
    }
    setPreviewDoc(null)
    setPreviewResult(null)
    setPreviewError(null)
  }

  const handleConnectGoogleDrive = async () => {
    setConnectingDrive(true)
    setDriveActionError(null)
    setDriveActionNotice(null)
    try {
      const targetEmail = driveInfo?.targetStorageEmail || 'sunghiep.tsbd@gmail.com'
      const { email } = await connectGoogleDriveWithPopup(targetEmail)
      // Immediately ensure folder tree on Google Drive and persist Folder IDs in PostgreSQL
      const initRes = await initializeGoogleDriveFolders()
      setDriveInfo(initRes.drive)
      setDriveActionNotice(
        `Đã kết nối Google Drive (${email || initRes.accountEmail}) và đồng bộ cây thư mục "${initRes.drive.rootFolderName}" cùng 5 thư mục con vào PostgreSQL.`
      )
      await loadLibrary()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('popup-closed-by-user')) {
        setDriveActionError('Cửa sổ ủy quyền Google Drive đã bị đóng trước khi hoàn tất.')
      } else if (msg.includes('popup-blocked')) {
        setDriveActionError(
          'Trình duyệt đang chặn popup Google OAuth. Vui lòng cho phép popup cho trang này rồi thử lại.'
        )
      } else {
        setDriveActionError(msg || 'Không thể kết nối Google Drive lúc này.')
      }
    } finally {
      setConnectingDrive(false)
    }
  }

  const handleInitFolders = async () => {
    setInitializingFolders(true)
    setDriveActionError(null)
    setDriveActionNotice(null)
    try {
      const res = await initializeGoogleDriveFolders()
      setDriveInfo(res.drive)
      setDriveActionNotice(
        `Đã kiểm tra và lưu 6 mã thư mục Google Drive (1 gốc + 5 thư mục con) cho tài khoản ${res.accountEmail} vào PostgreSQL.`
      )
    } catch (err) {
      setDriveActionError(
        err instanceof Error ? err.message : 'Không thể khởi tạo cây thư mục Google Drive.'
      )
    } finally {
      setInitializingFolders(false)
    }
  }

  const handleRunDriveSelfTest = async () => {
    setRunningSelfTest(true)
    setDriveActionError(null)
    setDriveActionNotice(null)
    try {
      const res = await runGoogleDriveSelfTest()
      setSelfTestResult(res.result)
      setDriveInfo(res.drive)
      setDocuments((prev) => [
        res.document,
        ...prev.filter((d) => d.id !== res.document.id),
      ])
      setDriveActionNotice(
        `Kiểm thử thành công! Đã tải lên và đọc lại tệp "${res.result.uploadedFileName}" (${res.result.readBackSizeBytes} byte, khớp SHA-256) trong ${res.result.targetFolderPath}.`
      )
    } catch (err) {
      setDriveActionError(
        err instanceof Error
          ? err.message
          : 'Kiểm thử tải lên và đọc lại Google Drive thất bại.'
      )
    } finally {
      setRunningSelfTest(false)
    }
  }

  const validateAndStageFiles = (incomingList: FileList | File[]) => {
    setUploadError(null)
    setUploadNotice(null)

    const incoming = Array.from(incomingList)
    if (incoming.length === 0) return

    const valid: File[] = []
    const rejectedMessages: string[] = []

    for (const file of incoming) {
      const lower = file.name.toLowerCase()
      if (lower.endsWith('.doc')) {
        rejectedMessages.push(
          `"${file.name}": Không hỗ trợ tệp .doc cũ. Chỉ chấp nhận .pdf, .docx, .txt.`
        )
        continue
      }
      if (!lower.endsWith('.pdf') && !lower.endsWith('.docx') && !lower.endsWith('.txt')) {
        rejectedMessages.push(
          `"${file.name}": Định dạng không hợp lệ. Chỉ chấp nhận .pdf, .docx hoặc .txt.`
        )
        continue
      }
      if (file.size === 0) {
        rejectedMessages.push(`"${file.name}": Tệp đang trống (0 byte).`)
        continue
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        rejectedMessages.push(
          `"${file.name}": Dung lượng (${formatBytes(file.size)}) vượt quá giới hạn 20 MB.`
        )
        continue
      }
      valid.push(file)
    }

    const combined = [...selectedFiles, ...valid].slice(0, MAX_BATCH_FILES)
    if (selectedFiles.length + valid.length > MAX_BATCH_FILES) {
      rejectedMessages.push(`Tối đa ${MAX_BATCH_FILES} tệp trong một lần tải lên.`)
    }

    if (rejectedMessages.length > 0) {
      setUploadError(rejectedMessages.join(' '))
    }

    setSelectedFiles(combined)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      validateAndStageFiles(e.target.files)
    }
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      validateAndStageFiles(e.dataTransfer.files)
    }
  }

  const handleUploadBatch = async () => {
    if (selectedFiles.length === 0 || uploading) return
    setUploadError(null)
    setUploadNotice(null)
    setUploading(true)
    setUploadProgress(5)

    try {
      const result = await uploadTeacherDocuments({
        files: selectedFiles,
        folderKey: selectedFolderKey,
        onProgress: setUploadProgress,
      })

      if (result.uploaded.length > 0) {
        setDocuments((prev) => [...result.uploaded, ...prev])
        setSelectedFiles([])
        setUploadNotice(
          `Đã tải lên ${result.uploaded.length} tệp vào Google Drive (${selectedFolderKey}), xác minh đọc lại toàn vẹn và lưu Drive File ID vào PostgreSQL.`
        )
      }

      if (result.errors.length > 0) {
        setUploadError(result.errors.map((e) => `${e.filename}: ${e.error}`).join(' | '))
      }
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : 'Không thể tải tài liệu lên Google Drive.'
      )
    } finally {
      setUploading(false)
      setUploadProgress(0)
    }
  }

  const handleOpenPreview = async (doc: TeacherDocumentRecord) => {
    if (!doc.hasOriginalFile) return
    closePreview()
    setPreviewDoc(doc)
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const result = await fetchDocumentPreview(doc)
      setPreviewResult(result)
    } catch (err) {
      setPreviewError(
        err instanceof Error ? err.message : 'Không thể tải bản xem trước tài liệu từ Google Drive.'
      )
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleDownload = async (doc: TeacherDocumentRecord) => {
    if (!doc.hasOriginalFile) return
    setBusyDocId(doc.id)
    setActionError(null)
    try {
      await downloadTeacherDocument(doc)
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Không thể tải xuống tệp gốc từ Google Drive.'
      )
    } finally {
      setBusyDocId(null)
    }
  }

  const handleQueueAi = async (doc: TeacherDocumentRecord) => {
    if (doc.recordOrigin !== 'document') return
    setBusyDocId(doc.id)
    setActionError(null)
    try {
      const updated = await queueDocumentForAiAnalysis(doc.id)
      setDocuments((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : 'Không thể chuyển tài liệu sang trạng thái chờ Document AI.'
      )
    } finally {
      setBusyDocId(null)
    }
  }

  const handleConfirmDelete = async () => {
    if (!confirmDeleteDoc) return
    const target = confirmDeleteDoc
    setBusyDocId(target.id)
    setActionError(null)
    try {
      await deleteTeacherDocument(target.id)
      setDocuments((prev) => prev.filter((item) => item.id !== target.id))
      setConfirmDeleteDoc(null)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Không thể xóa tài liệu.')
    } finally {
      setBusyDocId(null)
    }
  }

  const driveConnected = Boolean(driveInfo?.connected)

  const statusCounts = useMemo(() => {
    const counts: Record<DocumentProcessingStatus, number> = {
      Uploaded: 0,
      'Pending analysis': 0,
      Processing: 0,
      Completed: 0,
      'Needs review': 0,
      Failed: 0,
    }
    for (const doc of documents) {
      counts[doc.processingStatus] += 1
    }
    return counts
  }, [documents])

  const filteredDocuments = useMemo(() => {
    return documents.filter((d) => {
      if (statusFilter !== 'all' && d.processingStatus !== statusFilter) return false
      if (folderFilter === 'no_file') return !d.hasOriginalFile
      if (folderFilter !== 'all') return d.driveFolderKey === folderFilter
      return true
    })
  }, [documents, statusFilter, folderFilter])

  const driveDocumentsCount = useMemo(
    () => documents.filter((d) => d.hasOriginalFile).length,
    [documents]
  )
  const legacyNoFileCount = useMemo(
    () => documents.filter((d) => !d.hasOriginalFile).length,
    [documents]
  )

  return (
    <div className="space-y-6">
      {/* Google Drive API Connection & Folder Tree Management */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Cloud className="h-5 w-5 text-[#2878B8]" />
              <h2 className="font-display text-lg font-bold text-[#123B68]">
                Thư viện Tài liệu · Lưu trữ Google Drive API
              </h2>
            </div>
            <p className="text-xs leading-relaxed text-[#65758B] max-w-2xl">
              Toàn bộ tệp gốc (.docx, .pdf, .txt), file đáp án, đề thi và báo cáo được lưu riêng tư
              trong Google Drive của Super Admin (<strong>{driveInfo?.targetStorageEmail || 'sunghiep.tsbd@gmail.com'}</strong>).
              PostgreSQL chỉ lưu Drive File ID, mã thư mục, trạng thái AI, câu hỏi và kết quả thi.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={connectingDrive || initializingFolders || runningSelfTest}
              onClick={() => void handleConnectGoogleDrive()}
              className="inline-flex items-center gap-2 rounded-lg bg-[#2878B8] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#123B68] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
            >
              {connectingDrive ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Link2 className="h-3.5 w-3.5" />
              )}
              <span>
                {driveConnected ? 'Kết nối lại Google Drive' : 'Kết nối Google Drive'}
              </span>
            </button>

            <button
              type="button"
              disabled={!driveConnected || initializingFolders || runningSelfTest}
              onClick={() => void handleInitFolders()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-[#123B68] hover:bg-[#F3F6FA] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {initializingFolders ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FolderTree className="h-3.5 w-3.5 text-[#2878B8]" />
              )}
              <span>Đồng bộ 5 thư mục</span>
            </button>

            <button
              type="button"
              disabled={!driveConnected || runningSelfTest || initializingFolders}
              onClick={() => void handleRunDriveSelfTest()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#55A747]/45 bg-[#EEF7EC] px-3 py-2 text-xs font-semibold text-[#2D6A23] hover:bg-[#e1f2de] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {runningSelfTest ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FlaskConical className="h-3.5 w-3.5" />
              )}
              <span>Kiểm thử tải lên &amp; đọc lại DOCX</span>
            </button>

            <button
              type="button"
              disabled={loading}
              onClick={() => void loadLibrary()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-[#123B68] hover:bg-[#F3F6FA] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Làm mới</span>
            </button>
          </div>
        </div>

        {/* Google Drive Connection Status Banner */}
        {driveConnected && driveInfo ? (
          <div className="rounded-xl border border-[#55A747]/35 bg-[#EEF7EC] p-4 space-y-2.5 text-xs text-[#2D6A23]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold">
                <ShieldCheck className="h-4 w-4 text-[#55A747] shrink-0" />
                <span>
                  Đã kết nối Google Drive: <strong>{driveInfo.connectedAccountEmail}</strong>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-[#2D6A23]/85 tabular-nums">
                <span>Phạm vi: drive.file (tối thiểu)</span>
                {driveInfo.storageQuota?.limitBytes ? (
                  <span>
                    Dung lượng Drive: {formatBytes(driveInfo.storageQuota.usageBytes || 0)} /{' '}
                    {formatBytes(driveInfo.storageQuota.limitBytes)}
                  </span>
                ) : null}
              </div>
            </div>
            <p className="text-[11px] text-[#2D6A23]/90 leading-relaxed">
              {driveInfo.message} Tệp luôn được lưu riêng tư trong My Drive cá nhân, tải lên bằng
              giao thức Resumable Upload và kiểm tra đọc lại SHA-256 ngay sau khi lưu.
            </p>
          </div>
        ) : (
          <div
            role="status"
            className="rounded-xl border border-[#F28C28]/45 bg-[#FEF6EC] p-4 space-y-2 text-xs text-[#7D4208]"
          >
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-[#F28C28]" />
              <div className="space-y-1">
                <div className="font-bold text-[#9A520B]">
                  Chưa kích hoạt phiên kết nối Google Drive trong tab hiện tại
                </div>
                <p className="leading-relaxed">
                  {driveInfo?.message ||
                    storageInfo?.message ||
                    'Nhấn nút "Kết nối Google Drive" bằng tài khoản sunghiep.tsbd@gmail.com để cấp quyền tối thiểu (drive.file), khởi tạo cây thư mục và tải tệp gốc lên Google Drive.'}
                </p>
              </div>
            </div>
          </div>
        )}

        {driveActionError && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
            <span>{driveActionError}</span>
          </div>
        )}

        {driveActionNotice && (
          <div
            role="status"
            className="flex items-start gap-2.5 rounded-lg border border-[#55A747]/40 bg-[#EEF7EC] px-4 py-3 text-xs text-[#2D6A23]"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-[#55A747]" />
            <span>{driveActionNotice}</span>
          </div>
        )}

        {/* Folder Architecture Tree (Persisted IDs in PostgreSQL) */}
        <div className="rounded-xl border border-slate-200 bg-[#F8FAFC] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold text-[#123B68]">
              <FolderCheck className="h-4 w-4 text-[#2878B8]" />
              <span>Cây thư mục chuẩn: {driveInfo?.rootFolderName || 'TIN LAB - THƯ VIỆN TÀI LIỆU'}</span>
            </div>
            <span className="text-[11px] font-medium text-[#65758B] tabular-nums">
              {driveInfo?.foldersInitialized
                ? 'Đã lưu đủ 6 Folder ID trong PostgreSQL'
                : 'Tự động kiểm tra & tạo khi kết nối Google Drive (không tạo trùng)'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
            {DRIVE_SUBFOLDER_OPTIONS.map((sub) => {
              const saved = driveInfo?.folders.find((f) => f.folderKey === sub.key)
              const isSelected = selectedFolderKey === sub.key
              return (
                <button
                  key={sub.key}
                  type="button"
                  onClick={() => setSelectedFolderKey(sub.key)}
                  className={`text-left rounded-lg border p-3 transition-colors ${
                    isSelected
                      ? 'border-[#2878B8] bg-[#EAF3FA]/70'
                      : 'border-slate-200 bg-white hover:border-[#2878B8]/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono text-[11px] font-bold text-[#123B68] truncate">
                      {sub.label}
                    </span>
                    {saved ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#55A747]" />
                    ) : (
                      <Clock className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-[#65758B] line-clamp-2">
                    {sub.description}
                  </div>
                  <div className="mt-1.5 font-mono text-[10px] text-[#65758B] truncate">
                    {saved ? `ID: ${saved.driveFolderId.slice(0, 14)}…` : 'Chưa khởi tạo'}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Live Self-Test Verification Report */}
        {selfTestResult && (
          <div className="rounded-xl border border-[#55A747]/40 bg-white p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
              <div className="flex items-center gap-2 text-xs font-bold text-[#2D6A23]">
                <CheckCircle2 className="h-4 w-4 text-[#55A747]" />
                <span>Kết quả kiểm thử Google Drive thực tế (Tải lên &amp; Đọc lại DOCX)</span>
              </div>
              <span className="font-mono text-[11px] text-[#65758B] tabular-nums">
                {formatDateVi(selfTestResult.testedAt)}
              </span>
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              <div className="rounded-lg bg-[#F8FAFC] p-2.5 border border-slate-200">
                <dt className="text-[11px] text-[#65758B]">Đường dẫn thư mục</dt>
                <dd className="mt-0.5 font-semibold text-[#123B68] break-words">
                  {selfTestResult.targetFolderPath}
                </dd>
              </div>
              <div className="rounded-lg bg-[#F8FAFC] p-2.5 border border-slate-200">
                <dt className="text-[11px] text-[#65758B]">Tệp mẫu &amp; Drive File ID</dt>
                <dd className="mt-0.5 font-mono text-[11px] text-[#123B68] break-all">
                  {selfTestResult.uploadedFileName}
                  <div className="text-[#65758B]">{selfTestResult.uploadedFileId}</div>
                </dd>
              </div>
              <div className="rounded-lg bg-[#F8FAFC] p-2.5 border border-slate-200">
                <dt className="text-[11px] text-[#65758B]">Đối chiếu dung lượng</dt>
                <dd className="mt-0.5 font-mono font-semibold text-[#2D6A23] tabular-nums">
                  Gửi: {selfTestResult.uploadedSizeBytes} B · Đọc lại:{' '}
                  {selfTestResult.readBackSizeBytes} B (
                  {selfTestResult.sizeMatched ? 'KHỚP' : 'LỆCH'})
                </dd>
              </div>
              <div className="rounded-lg bg-[#F8FAFC] p-2.5 border border-slate-200">
                <dt className="text-[11px] text-[#65758B]">Đối chiếu SHA-256</dt>
                <dd className="mt-0.5 font-mono text-[11px] font-semibold text-[#2D6A23] break-all">
                  {selfTestResult.sha256Matched ? 'KHỚP 100%' : 'KHÔNG KHỚP'} ·{' '}
                  {selfTestResult.sha256.slice(0, 14)}…
                </dd>
              </div>
            </dl>

            <ol className="space-y-1.5 text-xs">
              {selfTestResult.steps.map((s, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-[#55A747]" />
                  <span>
                    <strong className="text-[#123B68]">{s.step}:</strong>{' '}
                    <span className="text-[#203247]">{s.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Upload Dropzone */}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragActive(true)
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
          className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
            dragActive
              ? 'border-[#2878B8] bg-[#EAF3FA]/60'
              : 'border-slate-300 bg-[#F3F6FA]/60 hover:border-[#2878B8]/60'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            onChange={handleFileInputChange}
            className="hidden"
          />

          <div className="mx-auto flex max-w-xl flex-col items-center space-y-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white border border-slate-200 text-[#2878B8]">
              <FileUp className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[#123B68]">
                Tải tài liệu trực tiếp lên Google Drive ({selectedFolderKey})
              </div>
              <div className="text-xs text-[#65758B]">
                Hỗ trợ <strong>DOCX (.docx)</strong>, <strong>PDF (.pdf)</strong>, và{' '}
                <strong>TXT (.txt)</strong> · Tối đa 20 MB/tệp · Giao thức Resumable Upload &amp;
                xác minh đọc lại tự động
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
              <label className="inline-flex items-center gap-2 text-xs text-[#123B68] font-medium">
                <span>Thư mục lưu:</span>
                <select
                  value={selectedFolderKey}
                  onChange={(e) => setSelectedFolderKey(e.target.value as DriveSubfolderKey)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-mono font-semibold text-[#123B68] focus:border-[#2878B8] focus:outline-none"
                >
                  {DRIVE_SUBFOLDER_OPTIONS.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      {opt.label} — {opt.description}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 min-h-[38px] text-xs font-semibold text-[#123B68] hover:border-[#2878B8] hover:text-[#2878B8] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
              >
                <FolderOpen className="h-4 w-4" />
                <span>Chọn tệp tài liệu</span>
              </button>

              {selectedFiles.length > 0 && (
                <button
                  type="button"
                  disabled={uploading || !driveConnected}
                  onClick={() => void handleUploadBatch()}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#2878B8] px-4 py-2 min-h-[38px] text-xs font-semibold text-white hover:bg-[#123B68] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  {uploading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Đang tải lên Drive ({uploadProgress}%)</span>
                    </>
                  ) : (
                    <>
                      <FileUp className="h-4 w-4" />
                      <span>Tải lên {selectedFiles.length} tệp vào Google Drive</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Staged Files List & Real Progress Bar */}
        {selectedFiles.length > 0 && (
          <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-4 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-[#123B68]">
                Danh sách chờ tải lên {selectedFolderKey} ({selectedFiles.length} tệp)
              </span>
              {!uploading && (
                <button
                  type="button"
                  onClick={() => setSelectedFiles([])}
                  className="text-[#65758B] hover:text-[#D94B45] font-medium"
                >
                  Xóa danh sách chọn
                </button>
              )}
            </div>

            <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
              {selectedFiles.map((file, idx) => (
                <li
                  key={`${file.name}-${file.size}-${idx}`}
                  className="flex items-center justify-between gap-3 px-3.5 py-2 text-xs"
                >
                  <div className="min-w-0 flex items-center gap-2.5">
                    <FileText className="h-4 w-4 shrink-0 text-[#2878B8]" />
                    <span className="font-medium text-[#203247] truncate">{file.name}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-mono text-[11px] text-[#65758B] tabular-nums">
                      {formatBytes(file.size)}
                    </span>
                    {!uploading && (
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedFiles((prev) => prev.filter((_, i) => i !== idx))
                        }
                        aria-label={`Bỏ tệp ${file.name}`}
                        className="text-[#65758B] hover:text-[#D94B45]"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {uploading && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-[11px] font-medium text-[#123B68] tabular-nums">
                  <span>Đang tải lên Google Drive (Resumable Upload) &amp; kiểm tra đọc lại...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded bg-slate-200">
                  <div
                    className="h-full bg-[#2878B8] transition-all duration-150"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {uploadError && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
            <span>{uploadError}</span>
          </div>
        )}

        {uploadNotice && (
          <div
            role="status"
            className="flex items-start gap-2.5 rounded-lg border border-[#55A747]/40 bg-[#EEF7EC] px-4 py-3 text-xs text-[#2D6A23]"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-[#55A747]" />
            <span>{uploadNotice}</span>
          </div>
        )}
      </section>

      {/* Real Document Library Table (9 Required Columns) */}
      <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="border-b border-slate-200 bg-[#F3F6FA] px-6 py-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-[#7954A1]" />
              <h3 className="font-display text-base font-bold text-[#123B68]">
                Danh sách tài liệu thư viện ({documents.length})
              </h3>
            </div>
            <div className="text-[11px] text-[#65758B] tabular-nums">
              Có file gốc trên Drive: <strong className="text-[#123B68]">{driveDocumentsCount}</strong>{' '}
              · Bản nháp cũ chưa có file gốc:{' '}
              <strong className="text-[#9A520B]">{legacyNoFileCount}</strong>
            </div>
          </div>

          {/* Interactive Filters: Folder + AI Status */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setFolderFilter('all')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors tabular-nums ${
                folderFilter === 'all'
                  ? 'bg-[#123B68] text-white'
                  : 'bg-white border border-slate-200 text-[#203247] hover:border-[#2878B8]'
              }`}
            >
              Mọi thư mục ({documents.length})
            </button>
            {DRIVE_SUBFOLDER_OPTIONS.map((sub) => (
              <button
                key={sub.key}
                type="button"
                onClick={() => setFolderFilter(sub.key)}
                className={`rounded-md px-2.5 py-1 text-xs font-mono transition-colors ${
                  folderFilter === sub.key
                    ? 'bg-[#2878B8] text-white'
                    : 'bg-white border border-slate-200 text-[#65758B] hover:border-[#2878B8] hover:text-[#123B68]'
                }`}
              >
                {sub.label}
              </button>
            ))}
            {legacyNoFileCount > 0 && (
              <button
                type="button"
                onClick={() => setFolderFilter('no_file')}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors tabular-nums ${
                  folderFilter === 'no_file'
                    ? 'bg-[#9A520B] text-white'
                    : 'bg-white border border-[#F28C28]/40 text-[#9A520B] hover:bg-[#FEF6EC]'
                }`}
              >
                Chưa có file gốc ({legacyNoFileCount})
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setStatusFilter('all')}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors tabular-nums ${
                statusFilter === 'all'
                  ? 'bg-[#203247] text-white'
                  : 'bg-white border border-slate-200 text-[#65758B] hover:border-[#2878B8]'
              }`}
            >
              Mọi trạng thái AI ({documents.length})
            </button>
            {ALL_STATUSES.map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors tabular-nums ${
                  statusFilter === st
                    ? 'bg-[#203247] text-white'
                    : 'bg-white border border-slate-200 text-[#65758B] hover:border-[#2878B8]'
                }`}
              >
                {STATUS_META[st].label} ({statusCounts[st]})
              </button>
            ))}
          </div>
        </div>

        {(loadError || actionError) && (
          <div className="px-6 pt-4">
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
              <span>{loadError || actionError}</span>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-3 px-6 py-10 text-sm text-[#65758B]">
            <Loader2 className="h-5 w-5 animate-spin text-[#2878B8]" />
            <span>Đang tải danh sách tài liệu từ PostgreSQL...</span>
          </div>
        ) : filteredDocuments.length === 0 ? (
          <div className="px-6 py-10 text-center space-y-2">
            <div className="text-sm font-semibold text-[#123B68]">
              {documents.length === 0
                ? 'Chưa có tài liệu nào trong thư viện'
                : 'Không có tài liệu nào phù hợp với bộ lọc hiện tại'}
            </div>
            <p className="text-xs text-[#65758B]">
              {documents.length === 0
                ? 'Kết nối Google Drive rồi tải lên tệp DOCX, PDF hoặc TXT để lưu trữ lâu dài và trích xuất bằng AI Agent.'
                : 'Chọn lại "Mọi thư mục" và "Mọi trạng thái AI" để xem toàn bộ danh sách.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-[#F8FAFC] text-[11px] font-semibold text-[#65758B]">
                <tr>
                  <th className="px-4 py-3">Tên file</th>
                  <th className="px-3 py-3">Loại file</th>
                  <th className="px-3 py-3 text-right">Dung lượng</th>
                  <th className="px-3 py-3">Ngày tải lên</th>
                  <th className="px-3 py-3">Thư mục lưu</th>
                  <th className="px-3 py-3">Trạng thái xử lý AI</th>
                  <th className="px-3 py-3 text-right">Số câu trích xuất</th>
                  <th className="px-3 py-3">Trạng thái duyệt</th>
                  <th className="px-4 py-3 text-right">Xem &amp; tải file gốc</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filteredDocuments.map((doc) => {
                  const meta = STATUS_META[doc.processingStatus]
                  const approvalStyle = APPROVAL_META[doc.approvalStatus].style
                  const isBusy = busyDocId === doc.id
                  const isDriveFile = doc.hasOriginalFile && doc.recordOrigin === 'document'
                  const canQueue =
                    isDriveFile &&
                    (doc.processingStatus === 'Uploaded' || doc.processingStatus === 'Failed')

                  return (
                    <tr key={doc.id} className="hover:bg-[#F3F6FA]/60 align-top">
                      {/* 1. Tên file */}
                      <td className="px-4 py-3 max-w-[230px]">
                        <div
                          className="font-semibold text-[#203247] truncate"
                          title={doc.originalFilename}
                        >
                          {doc.originalFilename}
                        </div>
                        {doc.statusNote && (
                          <div
                            className="text-[11px] text-[#65758B] truncate mt-0.5"
                            title={doc.statusNote}
                          >
                            {doc.statusNote}
                          </div>
                        )}
                      </td>

                      {/* 2. Loại file */}
                      <td className="px-3 py-3 font-mono text-[11px] font-semibold uppercase text-[#123B68] whitespace-nowrap">
                        {doc.fileExtension}
                      </td>

                      {/* 3. Dung lượng */}
                      <td className="px-3 py-3 text-right font-mono text-[11px] tabular-nums text-[#203247] whitespace-nowrap">
                        {doc.hasOriginalFile ? formatBytes(doc.fileSizeBytes) : '—'}
                      </td>

                      {/* 4. Ngày tải lên */}
                      <td className="px-3 py-3 text-[11px] tabular-nums text-[#65758B] whitespace-nowrap">
                        {formatDateVi(doc.createdAt)}
                      </td>

                      {/* 5. Thư mục lưu */}
                      <td className="px-3 py-3 whitespace-nowrap">
                        {doc.hasOriginalFile && doc.driveFolderKey ? (
                          <div className="space-y-0.5">
                            <span className="inline-flex items-center gap-1 rounded border border-[#2878B8]/30 bg-[#EAF3FA] px-2 py-0.5 font-mono text-[11px] font-semibold text-[#123B68]">
                              {doc.driveFolderKey}
                            </span>
                            {doc.driveOwnerEmail && (
                              <div className="text-[10px] text-[#65758B]">
                                Drive: {doc.driveOwnerEmail}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded border border-[#F28C28]/40 bg-[#FEF6EC] px-2 py-0.5 text-[11px] font-semibold text-[#9A520B]">
                            Chưa có file gốc
                          </span>
                        )}
                      </td>

                      {/* 6. Trạng thái xử lý AI */}
                      <td className="px-3 py-3 whitespace-nowrap">
                        <span
                          title={meta.description}
                          className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-semibold ${meta.style}`}
                        >
                          {doc.processingStatus === 'Pending analysis' && (
                            <Clock className="h-3 w-3" />
                          )}
                          <span>{meta.label}</span>
                        </span>
                      </td>

                      {/* 7. Số câu hỏi trích xuất */}
                      <td className="px-3 py-3 text-right font-mono text-xs font-bold tabular-nums text-[#123B68] whitespace-nowrap">
                        {doc.extractedQuestionCount > 0
                          ? `${doc.extractedQuestionCount} câu`
                          : '0'}
                      </td>

                      {/* 8. Trạng thái duyệt */}
                      <td className="px-3 py-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${approvalStyle}`}
                        >
                          {doc.approvalStatusLabel}
                        </span>
                      </td>

                      {/* 9. Xem và tải file gốc */}
                      <td className="px-4 py-3">
                        {isDriveFile ? (
                          <div className="flex items-center justify-end gap-1.5 flex-wrap">
                            <button
                              type="button"
                              disabled={isBusy || !driveConnected}
                              onClick={() => void handleOpenPreview(doc)}
                              title={
                                driveConnected
                                  ? 'Xem trước tệp gốc từ Google Drive'
                                  : 'Kết nối Google Drive để xem trước'
                              }
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-[#123B68] hover:border-[#2878B8] hover:text-[#2878B8] disabled:opacity-45 whitespace-nowrap shrink-0"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              <span>Xem</span>
                            </button>

                            <button
                              type="button"
                              disabled={isBusy || !driveConnected}
                              onClick={() => void handleDownload(doc)}
                              title={
                                driveConnected
                                  ? 'Tải xuống tệp gốc từ Google Drive'
                                  : 'Kết nối Google Drive để tải xuống'
                              }
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-[#123B68] hover:border-[#2878B8] hover:text-[#2878B8] disabled:opacity-45 whitespace-nowrap shrink-0"
                            >
                              <Download className="h-3.5 w-3.5" />
                              <span>Tải gốc</span>
                            </button>

                            {doc.driveWebViewLink && (
                              <a
                                href={doc.driveWebViewLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Mở tệp trên Google Drive"
                                className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white p-1 text-[#2878B8] hover:border-[#2878B8]"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            )}

                            {onOpenInImporter && (
                              <button
                                type="button"
                                disabled={isBusy || !driveConnected}
                                onClick={() => onOpenInImporter(doc)}
                                title="Nạp lại tệp gốc từ Google Drive vào TIN LAB Document AI Agent"
                                className="inline-flex items-center gap-1 rounded-md border border-[#2878B8]/40 bg-[#EAF3FA] px-2 py-1 text-[11px] font-semibold text-[#123B68] hover:bg-[#dcecf8] disabled:opacity-45 whitespace-nowrap shrink-0"
                              >
                                <Bot className="h-3.5 w-3.5 text-[#2878B8]" />
                                <span>Xử lý AI</span>
                              </button>
                            )}

                            {canQueue && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleQueueAi(doc)}
                                title="Đánh dấu sẵn sàng chờ Document AI Agent"
                                className="inline-flex items-center gap-1 rounded-md border border-[#7954A1]/35 bg-[#F4EFF8] px-2 py-1 text-[11px] font-medium text-[#5B3C7D] hover:bg-[#EAE0F3] disabled:opacity-50 whitespace-nowrap shrink-0"
                              >
                                <FileCode2 className="h-3.5 w-3.5" />
                                <span>Chờ AI</span>
                              </button>
                            )}

                            <button
                              type="button"
                              disabled={isBusy || !driveConnected}
                              onClick={() => setConfirmDeleteDoc(doc)}
                              title="Chuyển tệp vào thùng rác Google Drive và xóa khỏi danh sách"
                              className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white p-1 text-[#65758B] hover:border-[#D94B45]/50 hover:text-[#D94B45] disabled:opacity-45"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="text-right text-[11px] font-medium text-[#9A520B]">
                            Chưa có file gốc
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Preview Modal */}
      {previewDoc && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Xem trước ${previewDoc.originalFilename}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
        >
          <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-[#F3F6FA] px-5 py-3.5">
              <div className="min-w-0">
                <div className="font-display text-sm font-bold text-[#123B68] truncate">
                  {previewDoc.originalFilename}
                </div>
                <div className="text-[11px] text-[#65758B] tabular-nums">
                  {previewDoc.fileExtension.toUpperCase()} · {formatBytes(previewDoc.fileSizeBytes)}{' '}
                  · {previewDoc.driveFolderPath || 'Google Drive'}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleDownload(previewDoc)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#123B68] hover:border-[#2878B8] whitespace-nowrap shrink-0"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Tải file gốc</span>
                </button>
                <button
                  type="button"
                  onClick={closePreview}
                  aria-label="Đóng xem trước"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-[#203247] hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-5 bg-white">
              {previewLoading ? (
                <div className="flex items-center justify-center gap-3 py-16 text-sm text-[#65758B]">
                  <Loader2 className="h-5 w-5 animate-spin text-[#2878B8]" />
                  <span>Đang đọc tệp gốc trực tiếp từ Google Drive...</span>
                </div>
              ) : previewError ? (
                <div className="rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] p-4 text-xs text-[#A92F2A]">
                  {previewError}
                </div>
              ) : previewResult?.kind === 'pdf' ? (
                <iframe
                  title={previewResult.filename}
                  src={previewResult.blobUrl}
                  className="h-[68vh] w-full rounded-lg border border-slate-200"
                />
              ) : previewResult?.kind === 'text' ? (
                <pre className="whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-[#F8FAFC] p-4 font-sans text-xs sm:text-sm leading-relaxed text-[#203247]">
                  {previewResult.text}
                </pre>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Explicit Delete Confirmation Modal (Required before trashing a Google Drive file) */}
      {confirmDeleteDoc && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Xác nhận xóa tài liệu trên Google Drive"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 space-y-4 shadow-xl">
            <h3 className="font-display text-base font-bold text-[#123B68]">
              Xác nhận xóa tài liệu gốc trên Google Drive?
            </h3>
            <p className="text-xs leading-relaxed text-[#203247]">
              Tài liệu <strong>{confirmDeleteDoc.originalFilename}</strong> (thư mục{' '}
              <span className="font-mono">{confirmDeleteDoc.driveFolderKey}</span>) sẽ được chuyển
              vào Thùng rác của Google Drive và gỡ bản ghi khỏi thư viện PostgreSQL. Các bản nháp
              câu hỏi đã trích xuất sẽ không bị xóa tự động.
            </p>
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                disabled={busyDocId === confirmDeleteDoc.id}
                onClick={() => setConfirmDeleteDoc(null)}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-[#203247] hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={busyDocId === confirmDeleteDoc.id}
                onClick={() => void handleConfirmDelete()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#D94B45] px-4 py-2 text-xs font-semibold text-white hover:bg-[#B83833] disabled:opacity-60"
              >
                {busyDocId === confirmDeleteDoc.id && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                <span>Xác nhận xóa</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
