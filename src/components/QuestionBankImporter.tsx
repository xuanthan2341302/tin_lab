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
  ArchiveX,
  BookOpen,
  Bot,
  Check,
  CheckCheck,
  CheckCircle2,
  Database,
  Download,
  Edit3,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  FileUp,
  FolderOpen,
  History,
  Layers,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import type {
  AgentAnalysisSummary,
  AgentFileRole,
  AgentMatchMethod,
  AgentSetMode,
  AgentUploadedFileReport,
  AiAnswerSourceType,
  AnswerOptionKey,
  AnswerProvisionMode,
  AnswerStatus,
  BatchResolveExistingBankHint,
  CognitiveLevel,
  CompositeDocumentAnalysis,
  DocumentImportCategory,
  ExtractedQuestion,
  GeminiConnectionInfo,
  ImportJobSnapshot,
  ImportStepCode,
  QuestionBankImportRecord,
  QuestionImportDraftRecord,
  QuestionType,
  ReviewDecision,
  SavedQuestionBankItem,
  SourceFileFormat,
  TeacherDocumentRecord,
} from '../types'
import {
  computeQuestionContentHashBrowser,
  saveApprovedQuestionsToFirestore,
  validateQuestionForBlueprint,
} from '../lib/questionBankDb'
import { fetchTeacherDocuments } from '../lib/documentLibraryClient'
import {
  classifyAgentFilesClient,
  createQuestionImportDraftClient,
  deleteQuestionImportDraftClient,
  exportAgentExcelReportClient,
  fetchGeminiAiStatusClient,
  fetchQuestionImportDrafts,
  QuestionImportError,
  resolveExceptionQuestionsBatchClient,
  retryIncompleteAgentClient,
  runDocumentAiAgentAnalyzeClient,
  updateQuestionImportDraftClient,
} from '../lib/questionDraftClient'
import { QuestionEditModal, type EditableQuestionValues } from './QuestionEditModal'

interface QuestionBankImporterProps {
  ownerUid: string
  emailVerified: boolean
  existingBank: SavedQuestionBankItem[]
  existingImports: QuestionBankImportRecord[]
  preselectedLibraryDoc?: TeacherDocumentRecord | null
  onClearPreselectedLibraryDoc?: () => void
  onSavedToDb: () => Promise<void>
  onViewSavedBank: () => void
}

type ExtractionStage = 'idle' | 'uploading' | 'parsing' | 'deduping' | 'ready' | 'error'
type ValidFilter = 'all' | 'pending' | 'approved' | 'rejected' | 'ai_starred'
type IssueFilter =
  | 'all'
  | 'ai_proposed'
  | 'needs_review'
  | 'missing'
  | 'invalid_or_duplicate'
  | 'skipped'

interface QueuedAgentFile {
  clientKey: string
  file?: File
  libraryDoc?: TeacherDocumentRecord
  fileName: string
  fileSizeBytes: number
  fileFormat: SourceFileFormat
  detectedRole: AgentFileRole
  assignedRole: AgentFileRole
  roleConfidence: number
  roleReason: string
  status: 'queued' | 'processing' | 'completed' | 'error'
  pageCount: number | null
  extractedCount: number
  matchedAnswerCount: number
  errorStep: ImportStepCode | null
  errorMessage: string | null
}

const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_QUEUE_FILES = 20

const COGNITIVE_LABELS: Record<CognitiveLevel, string> = {
  recognition: 'Nhận biết',
  understanding: 'Thông hiểu',
  application: 'Vận dụng',
  unspecified: 'Chưa xác định',
}

const COGNITIVE_STYLE: Record<CognitiveLevel, string> = {
  recognition: 'text-[#2D6A23] bg-[#EEF7EC] border-[#55A747]/30',
  understanding: 'text-[#123B68] bg-[#EAF3FA] border-[#2878B8]/30',
  application: 'text-[#5B3C7D] bg-[#F4EFF8] border-[#7954A1]/30',
  unspecified: 'text-[#65758B] bg-slate-100 border-slate-200',
}

const TYPE_LABELS: Record<QuestionType, string> = {
  multiple_choice: 'Trắc nghiệm 4 lựa chọn',
  true_false: 'Đúng / Sai (4 ý)',
  essay: 'Tự luận',
}

const FILE_ROLE_LABELS: Record<AgentFileRole, string> = {
  question_file: 'File câu hỏi',
  answer_file: 'File đáp án riêng',
  solution_guide: 'Hướng dẫn giải / Rubric',
  composite_file: 'Tài liệu tổng hợp',
  reference_file: 'Tài liệu tham khảo',
  irrelevant_file: 'Tài liệu không liên quan',
}

const SET_MODE_OPTIONS: { value: AgentSetMode; label: string; desc: string }[] = [
  {
    value: 'auto',
    label: 'Tự động nhận diện bộ tài liệu',
    desc: 'Agent tự phân loại từng file (câu hỏi, đáp án riêng, tài liệu tổng hợp) và ghép nối theo 4 tầng.',
  },
  {
    value: 'question_embedded',
    label: 'Câu hỏi có đáp án trong file',
    desc: 'Nhận diện đánh dấu (*), in đậm, tô màu chữ, highlight, gạch chân hoặc bảng đáp án cuối file.',
  },
  {
    value: 'question_plus_separate_answers',
    label: 'File câu hỏi + File đáp án riêng',
    desc: 'Ghép theo Mã câu -> Bài học + Số câu -> Nội dung -> Ngữ cảnh/AI. Tuyệt đối không ghép nhầm bài.',
  },
  {
    value: 'composite_study',
    label: 'Tài liệu tổng hợp (AI Agent tạo đề)',
    desc: 'Đọc giáo trình, đề cương, tài liệu ôn tập và biên soạn câu hỏi + đáp án dưới dạng Bản nháp.',
  },
  {
    value: 'mixed_bundle',
    label: 'Bộ nhiều tài liệu kết hợp',
    desc: 'Xử lý đồng thời nhiều file câu hỏi, nhiều file đáp án và tài liệu tổng hợp trong một phiên.',
  },
]

const MATCH_METHOD_LABELS: Record<AgentMatchMethod, string> = {
  question_code: 'Ưu tiên 1 · Mã câu',
  lesson_and_number: 'Ưu tiên 2 · Bài học & Số câu',
  stem_and_options: 'Ưu tiên 3 · Nội dung câu hỏi',
  context_and_explanation: 'Ưu tiên 4 · Ngữ cảnh & Giải thích',
  inline_formatting: 'Định dạng đánh dấu trong file',
  embedded_key_table: 'Bảng đáp án kèm trong file',
  ai_semantic_match: 'AI Agent đối chiếu ngữ nghĩa',
  ai_generated: 'AI Agent biên soạn từ học liệu',
  manual_edit: 'Chỉnh sửa thủ công',
  unmatched: 'Chưa đối chiếu được',
}

const ANSWER_STATUS_LABELS: Record<AnswerStatus, string> = {
  verified: 'Đã xác định từ nguồn',
  ai_proposed: 'AI đề xuất (*)',
  needs_review: 'Cần kiểm tra thêm',
  missing: 'Không tìm được đáp án',
  ambiguous: 'Có xung đột / Không hợp lệ',
}

const AI_SOURCE_TYPE_LABELS: Record<AiAnswerSourceType, string> = {
  source_document: 'Tìm thấy trong tài liệu gốc',
  separate_answer_file: 'Tìm thấy trong file đáp án riêng',
  composite_document: 'Tìm thấy trong tài liệu tổng hợp',
  existing_bank: 'Đối chiếu từ ngân hàng câu hỏi hiện có',
  ai_knowledge: 'AI suy luận từ kiến thức chuyên môn',
  none: 'Không đủ căn cứ xác định đáp án',
}

const EXCEPTION_BATCH_CHUNK_SIZE = 8
const HIGH_CONFIDENCE_AI_THRESHOLD = 85

function isQuestionStarredAi(q: ExtractedQuestion): boolean {
  return Boolean(
    q.aiProposedMarked ||
      q.aiSuggestion?.markedAsAiProposed ||
      q.answerSource?.startsWith('[*]') ||
      q.aiSourceType === 'ai_knowledge'
  )
}

function isQuestionInvalidOrDuplicate(q: ExtractedQuestion): boolean {
  if (q.duplicateInFile || q.duplicateInBank) return true
  if (q.exceptionCategory === 'invalid_or_duplicate') return true
  if (q.answerStatus === 'ambiguous') return true
  const structural = validateQuestionForBlueprint({
    ...q,
    answerKey: q.answerKey ?? 'A',
    statementAnswerA: q.statementAnswerA ?? true,
    statementAnswerB: q.statementAnswerB ?? true,
    statementAnswerC: q.statementAnswerC ?? true,
    statementAnswerD: q.statementAnswerD ?? true,
    rubric: q.rubric || 'placeholder',
  })
  return structural !== null
}

function resolveClientFormat(fileName: string): SourceFileFormat | null {
  const lower = fileName.toLowerCase().trim()
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.txt')) return 'txt'
  return null
}

function validateUploadCandidate(file: File): string | null {
  const lower = file.name.toLowerCase().trim()
  if (lower.endsWith('.doc')) {
    return `"${file.name}": Hệ thống chỉ hỗ trợ .docx, .pdf hoặc .txt (không hỗ trợ tệp .doc cũ).`
  }
  if (!resolveClientFormat(file.name)) {
    return `"${file.name}": Vui lòng chọn tệp .docx, .pdf hoặc .txt.`
  }
  if (file.size === 0) {
    return `"${file.name}": Tệp đang trống (0 byte).`
  }
  if (file.size > MAX_FILE_BYTES) {
    return `"${file.name}": Vượt quá giới hạn tối đa 20 MB.`
  }
  return null
}

function heuristicRoleFromName(fileName: string): AgentFileRole {
  const lower = fileName.normalize('NFC').toLowerCase()
  if (
    /(hướng\s*dẫn\s*giải|huong[\s_-]*dan[\s_-]*giai|lời\s*giải|loi[\s_-]*giai|hướng\s*dẫn\s*chấm|huong[\s_-]*dan[\s_-]*cham|\brubric\b)/i.test(
      lower
    )
  ) {
    return 'solution_guide'
  }
  if (/(đáp\s*án|dap[\s_-]*an|answer[\s_-]*key|\bkey\b)/i.test(lower)) {
    return 'answer_file'
  }
  if (/(giáo\s*trình|giao[\s_-]*trinh|đề\s*cương|de[\s_-]*cuong|lý\s*thuyết|ly[\s_-]*thuyet|tóm\s*tắt)/i.test(lower)) {
    return 'composite_file'
  }
  if (/(tham\s*khảo|tham[\s_-]*khao|phụ\s*lục|phu[\s_-]*luc)/i.test(lower)) {
    return 'reference_file'
  }
  if (/(biên\s*bản|bien[\s_-]*ban|kế\s*hoạch|ke[\s_-]*hoach|thời\s*khóa\s*biểu|hóa\s*đơn)/i.test(lower)) {
    return 'irrelevant_file'
  }
  return 'question_file'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatDateVi(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  })
}

export function QuestionBankImporter({
  ownerUid,
  emailVerified,
  existingBank,
  existingImports,
  preselectedLibraryDoc = null,
  onClearPreselectedLibraryDoc,
  onSavedToDb,
  onViewSavedBank,
}: QuestionBankImporterProps) {
  const multiFileInputRef = useRef<HTMLInputElement>(null)
  const retryFileInputRef = useRef<HTMLInputElement>(null)
  const [retryTargetClientKey, setRetryTargetClientKey] = useState<string | null>(null)

  // Gemini Live Connection Status (server-side check, zero API key inputs)
  const [aiStatus, setAiStatus] = useState<GeminiConnectionInfo | null>(null)
  const [checkingAiStatus, setCheckingAiStatus] = useState(false)

  // Step 1: Agent queue & config
  const [queuedFiles, setQueuedFiles] = useState<QueuedAgentFile[]>([])
  const [setMode, setSetMode] = useState<AgentSetMode>('auto')
  const [preferredTypes, setPreferredTypes] = useState<QuestionType[]>([
    'multiple_choice',
    'true_false',
    'essay',
  ])
  const [bankNameInput, setBankNameInput] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const [classifyingQueue, setClassifyingQueue] = useState(false)

  // Library quick picker modal
  const [showLibraryPicker, setShowLibraryPicker] = useState(false)
  const [libraryDocs, setLibraryDocs] = useState<TeacherDocumentRecord[]>([])
  const [loadingLibraryDocs, setLoadingLibraryDocs] = useState(false)
  const [libraryPickerError, setLibraryPickerError] = useState<string | null>(null)

  // Composite generation parameters
  const [adaptiveAutoCount, setAdaptiveAutoCount] = useState(true)
  const [mcqCount, setMcqCount] = useState(8)
  const [trueFalseCount, setTrueFalseCount] = useState(2)
  const [essayCount, setEssayCount] = useState(2)
  const [topicFocus, setTopicFocus] = useState('')

  // Processing state
  const [stage, setStage] = useState<ExtractionStage>('idle')
  const [progressPercent, setProgressPercent] = useState(0)
  const [stageMessage, setStageMessage] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)
  const [failedStepLabel, setFailedStepLabel] = useState<string | null>(null)
  const [failedStepCode, setFailedStepCode] = useState<string | null>(null)
  const [retryingFileKey, setRetryingFileKey] = useState<string | null>(null)

  // Active parsed session
  const [parsedDoc, setParsedDoc] = useState<{
    fileName: string
    fileFormat: SourceFileFormat
    fileHash: string
    pageCount: number | null
    documentCategory: DocumentImportCategory
    answerProvisionMode: AnswerProvisionMode
    answerFileName: string | null
    parserEngine: 'gemini_hybrid' | 'deterministic' | 'gemini_agent'
    warnings: string[]
  } | null>(null)
  const [documentAnalysis, setDocumentAnalysis] =
    useState<CompositeDocumentAnalysis | null>(null)
  const [agentFiles, setAgentFiles] = useState<AgentUploadedFileReport[]>([])
  const [agentSummary, setAgentSummary] = useState<AgentAnalysisSummary | null>(null)
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null)
  const [questions, setQuestions] = useState<ExtractedQuestion[]>([])

  // PostgreSQL Drafts
  const [drafts, setDrafts] = useState<QuestionImportDraftRecord[]>([])
  const [loadingDrafts, setLoadingDrafts] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [exportingExcel, setExportingExcel] = useState(false)
  const [draftNotice, setDraftNotice] = useState<string | null>(null)

  // Review state
  const [issueFilter, setIssueFilter] = useState<IssueFilter>('all')
  const [validFilter, setValidFilter] = useState<ValidFilter>('all')
  const [typeFilter, setTypeFilter] = useState<QuestionType | 'all'>('all')
  const [selectedValidIds, setSelectedValidIds] = useState<Set<string>>(new Set())
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(new Set())
  const [runningResumeAgent, setRunningResumeAgent] = useState(false)
  const [editingQuestion, setEditingQuestion] = useState<ExtractedQuestion | null>(null)

  // Bulk Exception AI Agent state
  const [batchResolving, setBatchResolving] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{
    currentBatch: number
    totalBatches: number
    processed: number
    total: number
    foundInSource: number
    aiProposed: number
    needsReview: number
    notFound: number
    invalidOrDuplicate: number
    failed: number
  } | null>(null)
  const [lastBatchReport, setLastBatchReport] = useState<{
    totalRequested: number
    foundInSource: number
    aiProposed: number
    needsReview: number
    notFound: number
    invalidOrDuplicate: number
    failed: number
    aiUnavailable: boolean
    aiErrorMessage: string | null
  } | null>(null)
  const [failedBatchTempIds, setFailedBatchTempIds] = useState<string[]>([])

  // Firestore commit state
  const [savingToDb, setSavingToDb] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<{
    importId: string
    savedCount: number
    skippedDuplicates: number
  } | null>(null)

  const existingBankHashes = useMemo(
    () => new Set(existingBank.map((item) => item.contentHash)),
    [existingBank]
  )

  const checkAiStatus = useCallback(async (refresh = false) => {
    setCheckingAiStatus(true)
    try {
      const status = await fetchGeminiAiStatusClient(refresh)
      setAiStatus(status)
    } catch {
      // Non-fatal; fallback status stays unchanged
    } finally {
      setCheckingAiStatus(false)
    }
  }, [])

  const loadDrafts = useCallback(async () => {
    setLoadingDrafts(true)
    try {
      const res = await fetchQuestionImportDrafts()
      setDrafts(res.drafts)
    } catch {
      // Non-fatal if drafts fetch momentarily fails
    } finally {
      setLoadingDrafts(false)
    }
  }, [])

  useEffect(() => {
    void checkAiStatus(false)
    void loadDrafts()
  }, [checkAiStatus, loadDrafts])

  // Add preselected Library document into the Agent queue when passed from Library tab
  useEffect(() => {
    if (!preselectedLibraryDoc) return
    setParseError(null)
    setQueuedFiles((prev) => {
      if (prev.some((q) => q.libraryDoc?.id === preselectedLibraryDoc.id)) {
        return prev
      }
      if (prev.length >= MAX_QUEUE_FILES) {
        return prev
      }
      const heuristicRole = heuristicRoleFromName(preselectedLibraryDoc.originalFilename)
      const entry: QueuedAgentFile = {
        clientKey: `lib-${preselectedLibraryDoc.id}`,
        libraryDoc: preselectedLibraryDoc,
        fileName: preselectedLibraryDoc.originalFilename,
        fileSizeBytes: preselectedLibraryDoc.fileSizeBytes,
        fileFormat: preselectedLibraryDoc.fileExtension,
        detectedRole: heuristicRole,
        assignedRole: heuristicRole,
        roleConfidence: 65,
        roleReason: 'Đang kiểm tra vai trò từ nội dung tài liệu...',
        status: 'queued',
        pageCount: null,
        extractedCount: 0,
        matchedAnswerCount: 0,
        errorStep: null,
        errorMessage: null,
      }
      return [...prev, entry]
    })
    if (!bankNameInput.trim()) {
      setBankNameInput(
        preselectedLibraryDoc.originalFilename.replace(/\.(docx|pdf|txt)$/i, '').slice(0, 100)
      )
    }
    setClassifyingQueue(true)
    void classifyAgentFilesClient({
      files: [],
      libraryDocumentIds: [preselectedLibraryDoc.id],
    })
      .then((reports) => {
        const rep = reports[0]
        if (!rep) return
        setQueuedFiles((prev) =>
          prev.map((q) =>
            q.libraryDoc?.id === preselectedLibraryDoc.id
              ? {
                  ...q,
                  detectedRole: rep.detectedRole,
                  assignedRole: rep.assignedRole,
                  roleConfidence: rep.roleConfidence,
                  roleReason: rep.roleReason,
                  pageCount: rep.pageCount,
                  status: rep.status === 'error' ? 'error' : 'queued',
                  errorStep: rep.errorStep,
                  errorMessage: rep.errorMessage,
                }
              : q
          )
        )
      })
      .catch(() => {
        // Keep heuristic classification
      })
      .finally(() => {
        setClassifyingQueue(false)
      })
  }, [preselectedLibraryDoc, bankNameInput])

  const matchingPriorImport = useMemo(() => {
    if (!parsedDoc || parsedDoc.documentCategory === 'composite_document') return null
    return existingImports.find((imp) => imp.fileHash === parsedDoc.fileHash) ?? null
  }, [parsedDoc, existingImports])

  const markBankDuplicatesAndNormalize = useCallback(
    (rawList: ExtractedQuestion[]): ExtractedQuestion[] => {
      return rawList.map((q) => {
        const isDuplicateInBank = existingBankHashes.has(q.contentHash)
        const isDuplicate = q.duplicateInFile || isDuplicateInBank
        const normalizedStatus = q.answerStatus
        return {
          ...q,
          originalQuestionText: q.originalQuestionText || q.questionText,
          duplicateInBank: isDuplicateInBank,
          reviewDecision: isDuplicate
            ? 'rejected'
            : normalizedStatus !== 'verified' && q.reviewDecision === 'approved'
            ? 'pending'
            : q.reviewDecision,
        }
      })
    },
    [existingBankHashes]
  )

  const recomputeIntraFileDuplicates = useCallback(
    (list: ExtractedQuestion[]): ExtractedQuestion[] => {
      const seen = new Set<string>()
      return list.map((item) => {
        const dupInFile = seen.has(item.contentHash)
        seen.add(item.contentHash)
        const dupInBank = existingBankHashes.has(item.contentHash)
        const isDuplicate = dupInFile || dupInBank
        return {
          ...item,
          duplicateInFile: dupInFile,
          duplicateInBank: dupInBank,
          reviewDecision: isDuplicate ? 'rejected' : item.reviewDecision,
        }
      })
    },
    [existingBankHashes]
  )

  const isQuestionValidForApproval = useCallback((q: ExtractedQuestion): boolean => {
    if (q.skippedInImport) return false
    if (q.duplicateInFile || q.duplicateInBank) return false
    if (q.answerStatus !== 'verified') return false
    return validateQuestionForBlueprint(q) === null
  }, [])

  const { validQuestions, issueQuestions, activeIssueQuestions, skippedIssueQuestions } = useMemo(() => {
    const valid: ExtractedQuestion[] = []
    const issues: ExtractedQuestion[] = []
    const activeIssues: ExtractedQuestion[] = []
    const skipped: ExtractedQuestion[] = []
    for (const q of questions) {
      if (isQuestionValidForApproval(q)) {
        valid.push(q)
      } else {
        issues.push(q)
        if (q.skippedInImport) {
          skipped.push(q)
        } else {
          activeIssues.push(q)
        }
      }
    }
    return {
      validQuestions: valid,
      issueQuestions: issues,
      activeIssueQuestions: activeIssues,
      skippedIssueQuestions: skipped,
    }
  }, [questions, isQuestionValidForApproval])

  const highConfidenceAiProposals = useMemo(() => {
    return activeIssueQuestions.filter((q) => {
      if (isQuestionInvalidOrDuplicate(q)) return false
      const hasProposal =
        q.answerStatus === 'ai_proposed' || Boolean(q.aiSuggestion && !q.aiSuggestion.applied)
      if (!hasProposal) return false
      const conf = q.aiSuggestion?.confidenceScore ?? q.confidenceScore ?? 0
      return conf >= HIGH_CONFIDENCE_AI_THRESHOLD
    })
  }, [activeIssueQuestions])

  const stats = useMemo(() => {
    let verifiedCount = 0
    let aiProposedCount = 0
    let aiStarredValidCount = 0
    let needsReviewCount = 0
    let missingCount = 0
    let ambiguousCount = 0
    let duplicateCount = 0
    let skippedCount = 0
    let approvedCount = 0
    let approvedAiStarredCount = 0
    let rejectedCount = 0
    let mcqCountTotal = 0
    let tfCountTotal = 0
    let essayCountTotal = 0
    let confidenceSum = 0
    let confidenceCount = 0

    for (const q of questions) {
      if (q.questionType === 'multiple_choice') mcqCountTotal += 1
      else if (q.questionType === 'true_false') tfCountTotal += 1
      else essayCountTotal += 1

      if (q.skippedInImport) {
        skippedCount += 1
      } else {
        if (q.duplicateInFile || q.duplicateInBank) duplicateCount += 1

        if (q.answerStatus === 'verified') {
          verifiedCount += 1
          if (isQuestionStarredAi(q)) aiStarredValidCount += 1
        } else if (q.answerStatus === 'ai_proposed') aiProposedCount += 1
        else if (q.answerStatus === 'needs_review') needsReviewCount += 1
        else if (q.answerStatus === 'ambiguous') ambiguousCount += 1
        else missingCount += 1

        if (q.reviewDecision === 'approved') {
          approvedCount += 1
          if (isQuestionStarredAi(q)) approvedAiStarredCount += 1
        } else if (q.reviewDecision === 'rejected') rejectedCount += 1
      }

      if (typeof q.confidenceScore === 'number') {
        confidenceSum += q.confidenceScore
        confidenceCount += 1
      }
    }

    return {
      total: questions.length,
      verifiedCount,
      aiProposedCount,
      aiStarredValidCount,
      needsReviewCount,
      missingCount,
      ambiguousCount,
      skippedCount,
      needsAttentionCount: activeIssueQuestions.length,
      validCount: validQuestions.length,
      duplicateCount,
      approvedCount,
      approvedAiStarredCount,
      rejectedCount,
      mcqCount: mcqCountTotal,
      tfCount: tfCountTotal,
      essayCount: essayCountTotal,
      averageConfidence:
        confidenceCount > 0 ? Math.round(confidenceSum / confidenceCount) : agentSummary?.averageConfidence ?? 0,
    }
  }, [questions, activeIssueQuestions.length, validQuestions.length, agentSummary?.averageConfidence])

  const issueCategoryCounts = useMemo(() => {
    let aiProposed = 0
    let needsReview = 0
    let notFound = 0
    let invalidOrDup = 0
    for (const q of activeIssueQuestions) {
      if (isQuestionInvalidOrDuplicate(q)) {
        invalidOrDup += 1
      } else if (q.answerStatus === 'ai_proposed' || q.exceptionCategory === 'ai_proposed_star') {
        aiProposed += 1
      } else if (q.answerStatus === 'needs_review' || q.exceptionCategory === 'needs_review') {
        needsReview += 1
      } else {
        notFound += 1
      }
    }
    return {
      activeAll: activeIssueQuestions.length,
      aiProposed,
      needsReview,
      notFound,
      invalidOrDup,
      skipped: skippedIssueQuestions.length,
    }
  }, [activeIssueQuestions, skippedIssueQuestions.length])

  const filteredIssueQuestions = useMemo(() => {
    if (issueFilter === 'skipped') {
      return skippedIssueQuestions
    }
    return activeIssueQuestions.filter((q) => {
      const invalidOrDup = isQuestionInvalidOrDuplicate(q)
      if (issueFilter === 'invalid_or_duplicate') return invalidOrDup
      if (issueFilter === 'ai_proposed') {
        return !invalidOrDup && (q.answerStatus === 'ai_proposed' || q.exceptionCategory === 'ai_proposed_star')
      }
      if (issueFilter === 'needs_review') {
        return !invalidOrDup && (q.answerStatus === 'needs_review' || q.exceptionCategory === 'needs_review')
      }
      if (issueFilter === 'missing') {
        return (
          !invalidOrDup &&
          q.answerStatus !== 'ai_proposed' &&
          q.answerStatus !== 'needs_review'
        )
      }
      return true
    })
  }, [activeIssueQuestions, skippedIssueQuestions, issueFilter])

  const filteredValidQuestions = useMemo(() => {
    return validQuestions.filter((q) => {
      if (typeFilter !== 'all' && q.questionType !== typeFilter) return false
      if (validFilter === 'pending') return q.reviewDecision === 'pending'
      if (validFilter === 'approved') return q.reviewDecision === 'approved'
      if (validFilter === 'rejected') return q.reviewDecision === 'rejected'
      if (validFilter === 'ai_starred') return isQuestionStarredAi(q)
      return true
    })
  }, [validQuestions, validFilter, typeFilter])

  const showCompositeOptions = useMemo(() => {
    if (setMode === 'composite_study' || setMode === 'mixed_bundle') return true
    return queuedFiles.some((f) => f.assignedRole === 'composite_file')
  }, [setMode, queuedFiles])

  const togglePreferredType = (t: QuestionType) => {
    setPreferredTypes((prev) => {
      if (prev.includes(t)) {
        if (prev.length === 1) return prev
        return prev.filter((item) => item !== t)
      }
      return [...prev, t]
    })
  }

  const resetSession = () => {
    setStage('idle')
    setProgressPercent(0)
    setStageMessage('')
    setParseError(null)
    setFailedStepLabel(null)
    setFailedStepCode(null)
    setParsedDoc(null)
    setDocumentAnalysis(null)
    setAgentFiles([])
    setAgentSummary(null)
    setActiveDraftId(null)
    setQuestions([])
    setQueuedFiles([])
    setSelectedValidIds(new Set())
    setSelectedIssueIds(new Set())
    setValidFilter('all')
    setIssueFilter('all')
    setTypeFilter('all')
    setSaveError(null)
    setSaveSuccess(null)
    setDraftNotice(null)
    setBatchProgress(null)
    setLastBatchReport(null)
    setFailedBatchTempIds([])
    if (multiFileInputRef.current) multiFileInputRef.current.value = ''
    onClearPreselectedLibraryDoc?.()
  }

  const addLocalFilesToQueue = async (incomingFiles: FileList | File[]) => {
    const fileArray = Array.from(incomingFiles)
    if (fileArray.length === 0) return

    setParseError(null)
    setFailedStepLabel(null)
    setFailedStepCode(null)

    const validationErrors: string[] = []
    const validFiles: { clientKey: string; file: File; format: SourceFileFormat }[] = []

    for (const f of fileArray) {
      const err = validateUploadCandidate(f)
      if (err) {
        validationErrors.push(err)
        continue
      }
      const fmt = resolveClientFormat(f.name)
      if (!fmt) continue
      const existsInQueue = queuedFiles.some(
        (q) => q.file && q.fileName === f.name && q.fileSizeBytes === f.size
      )
      if (existsInQueue) continue
      validFiles.push({
        clientKey: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        file: f,
        format: fmt,
      })
    }

    if (validationErrors.length > 0) {
      setParseError(validationErrors.join(' '))
    }

    if (validFiles.length === 0) return

    const remainingSlots = Math.max(0, MAX_QUEUE_FILES - queuedFiles.length)
    const accepted = validFiles.slice(0, remainingSlots)
    if (validFiles.length > remainingSlots) {
      setParseError(
        `Tối đa ${MAX_QUEUE_FILES} tệp trong một bộ xử lý AI Agent. Đã tiếp nhận ${accepted.length} tệp đầu tiên.`
      )
    }

    if (!bankNameInput.trim() && accepted[0]) {
      setBankNameInput(
        accepted[0].file.name.replace(/\.(docx|pdf|txt)$/i, '').slice(0, 100)
      )
    }

    const placeholders: QueuedAgentFile[] = accepted.map((item) => {
      const heuristic = heuristicRoleFromName(item.file.name)
      return {
        clientKey: item.clientKey,
        file: item.file,
        fileName: item.file.name,
        fileSizeBytes: item.file.size,
        fileFormat: item.format,
        detectedRole: heuristic,
        assignedRole: heuristic,
        roleConfidence: 60,
        roleReason: 'Đang phân tích tự động vai trò tệp...',
        status: 'queued',
        pageCount: null,
        extractedCount: 0,
        matchedAnswerCount: 0,
        errorStep: null,
        errorMessage: null,
      }
    })

    setQueuedFiles((prev) => [...prev, ...placeholders])
    setClassifyingQueue(true)

    try {
      const reports = await classifyAgentFilesClient({
        files: accepted.map((a) => a.file),
      })
      setQueuedFiles((prev) =>
        prev.map((q) => {
          const idx = accepted.findIndex((a) => a.clientKey === q.clientKey)
          if (idx === -1) return q
          const rep = reports[idx]
          if (!rep) return q
          return {
            ...q,
            detectedRole: rep.detectedRole,
            assignedRole: rep.assignedRole,
            roleConfidence: rep.roleConfidence,
            roleReason: rep.roleReason,
            pageCount: rep.pageCount,
            status: rep.status === 'error' ? 'error' : 'queued',
            errorStep: rep.errorStep,
            errorMessage: rep.errorMessage,
          }
        })
      )
    } catch {
      // Keep heuristic roles if auto-classify fails
    } finally {
      setClassifyingQueue(false)
    }
  }

  const handleOpenLibraryPicker = async () => {
    setShowLibraryPicker(true)
    setLoadingLibraryDocs(true)
    setLibraryPickerError(null)
    try {
      const res = await fetchTeacherDocuments()
      setLibraryDocs(
        res.documents.filter((d) => d.hasOriginalFile && d.recordOrigin === 'document')
      )
    } catch (err) {
      setLibraryPickerError(
        err instanceof Error ? err.message : 'Không thể tải danh sách tài liệu thư viện.'
      )
    } finally {
      setLoadingLibraryDocs(false)
    }
  }

  const handleAddLibraryDocToQueue = async (doc: TeacherDocumentRecord) => {
    if (queuedFiles.some((q) => q.libraryDoc?.id === doc.id)) {
      setShowLibraryPicker(false)
      return
    }
    if (queuedFiles.length >= MAX_QUEUE_FILES) {
      setLibraryPickerError(`Tối đa ${MAX_QUEUE_FILES} tệp trong một bộ tài liệu.`)
      return
    }

    const heuristic = heuristicRoleFromName(doc.originalFilename)
    const clientKey = `lib-${doc.id}`
    const placeholder: QueuedAgentFile = {
      clientKey,
      libraryDoc: doc,
      fileName: doc.originalFilename,
      fileSizeBytes: doc.fileSizeBytes,
      fileFormat: doc.fileExtension,
      detectedRole: heuristic,
      assignedRole: heuristic,
      roleConfidence: 60,
      roleReason: 'Đang phân tích vai trò tài liệu từ thư viện...',
      status: 'queued',
      pageCount: null,
      extractedCount: 0,
      matchedAnswerCount: 0,
      errorStep: null,
      errorMessage: null,
    }

    setQueuedFiles((prev) => [...prev, placeholder])
    if (!bankNameInput.trim()) {
      setBankNameInput(doc.originalFilename.replace(/\.(docx|pdf|txt)$/i, '').slice(0, 100))
    }
    setShowLibraryPicker(false)
    setClassifyingQueue(true)
    try {
      const reports = await classifyAgentFilesClient({
        files: [],
        libraryDocumentIds: [doc.id],
      })
      const rep = reports[0]
      if (rep) {
        setQueuedFiles((prev) =>
          prev.map((q) =>
            q.clientKey === clientKey
              ? {
                  ...q,
                  detectedRole: rep.detectedRole,
                  assignedRole: rep.assignedRole,
                  roleConfidence: rep.roleConfidence,
                  roleReason: rep.roleReason,
                  pageCount: rep.pageCount,
                  status: rep.status === 'error' ? 'error' : 'queued',
                  errorStep: rep.errorStep,
                  errorMessage: rep.errorMessage,
                }
              : q
          )
        )
      }
    } catch {
      // Keep heuristic role
    } finally {
      setClassifyingQueue(false)
    }
  }

  const handleRoleChange = (clientKey: string, nextRole: AgentFileRole) => {
    setQueuedFiles((prev) =>
      prev.map((q) => (q.clientKey === clientKey ? { ...q, assignedRole: nextRole } : q))
    )
  }

  const handleRemoveQueuedFile = (clientKey: string) => {
    setQueuedFiles((prev) => {
      const target = prev.find((q) => q.clientKey === clientKey)
      if (target?.libraryDoc?.id && target.libraryDoc.id === preselectedLibraryDoc?.id) {
        onClearPreselectedLibraryDoc?.()
      }
      return prev.filter((q) => q.clientKey !== clientKey)
    })
  }

  const syncQueueFromReports = (reports: AgentUploadedFileReport[]) => {
    setQueuedFiles((prev) =>
      prev.map((q) => {
        const matched = reports.find(
          (r) =>
            (q.libraryDoc?.id && r.libraryDocumentId === q.libraryDoc.id) ||
            r.fileName.normalize('NFC') === q.fileName.normalize('NFC')
        )
        if (!matched) return q
        return {
          ...q,
          detectedRole: matched.detectedRole,
          assignedRole: matched.assignedRole,
          roleConfidence: matched.roleConfidence,
          roleReason: matched.roleReason,
          status: matched.status,
          pageCount: matched.pageCount,
          extractedCount: matched.extractedCount,
          matchedAnswerCount: matched.matchedAnswerCount,
          errorStep: matched.errorStep,
          errorMessage: matched.errorMessage,
        }
      })
    )
  }

  const handleRunDocumentAiAgent = async () => {
    setParseError(null)
    setFailedStepLabel(null)
    setFailedStepCode(null)
    setSaveError(null)
    setSaveSuccess(null)
    setDraftNotice(null)

    if (queuedFiles.length === 0) {
      setStage('error')
      setProgressPercent(8)
      setFailedStepLabel('Không đọc được file')
      setStageMessage('Chưa chọn tệp tài liệu nào')
      setParseError(
        'Vui lòng chọn ít nhất 1 tệp (.docx, .pdf hoặc .txt) hoặc chọn từ Thư viện để TIN LAB Document AI Agent phân tích.'
      )
      return
    }

    if (showCompositeOptions && !adaptiveAutoCount && mcqCount + trueFalseCount + essayCount <= 0) {
      setStage('error')
      setProgressPercent(8)
      setFailedStepLabel('Cấu hình tài liệu tổng hợp')
      setStageMessage('Số lượng câu cần AI tạo đang bằng 0')
      setParseError('Vui lòng bật tự động hoặc chọn ít nhất 1 câu hỏi cho tài liệu tổng hợp.')
      return
    }

    const localFiles: File[] = []
    const libraryIds: string[] = []
    const roleMap: Record<string, AgentFileRole> = {}

    queuedFiles.forEach((q) => {
      if (q.file) {
        const idx = localFiles.length
        localFiles.push(q.file)
        roleMap[q.fileName] = q.assignedRole
        roleMap[q.fileName.normalize('NFC')] = q.assignedRole
        roleMap[String(idx)] = q.assignedRole
      } else if (q.libraryDoc) {
        libraryIds.push(q.libraryDoc.id)
        roleMap[q.libraryDoc.id] = q.assignedRole
        roleMap[q.fileName] = q.assignedRole
        roleMap[q.fileName.normalize('NFC')] = q.assignedRole
      }
    })

    setQueuedFiles((prev) =>
      prev.map((q) => ({
        ...q,
        status: 'processing',
        errorStep: null,
        errorMessage: null,
      }))
    )
    setStage('uploading')
    setProgressPercent(8)
    setStageMessage(
      `Đang gửi ${queuedFiles.length} tài liệu tới TIN LAB Document AI Agent...`
    )

    try {
      const handleJobProgress = (job: ImportJobSnapshot) => {
        setProgressPercent(job.progress)
        setStageMessage(job.stepLabel)
        if (job.step === 'save_draft') {
          setStage('deduping')
        } else {
          setStage('parsing')
        }
      }

      const data = await runDocumentAiAgentAnalyzeClient({
        files: localFiles,
        libraryDocumentIds: libraryIds,
        fileRoles: roleMap,
        setMode,
        bankName: bankNameInput.trim(),
        preferredTypes,
        mcqCount,
        trueFalseCount,
        essayCount,
        adaptiveAutoCount,
        topicFocus,
        saveDraft: true,
        onProgress: handleJobProgress,
      })

      setStage('deduping')
      setProgressPercent(96)
      setStageMessage('Đang đối chiếu trùng lặp & phân loại 4 trạng thái câu hỏi...')

      const marked = markBankDuplicatesAndNormalize(data.questions)
      setParsedDoc({
        fileName: data.fileName,
        fileFormat: data.fileFormat,
        fileHash: data.fileHash,
        pageCount: data.pageCount,
        documentCategory: data.documentCategory ?? 'question_document',
        answerProvisionMode: data.answerProvisionMode ?? 'embedded_in_file',
        answerFileName: data.answerFileName ?? null,
        parserEngine: data.parserEngine ?? 'gemini_agent',
        warnings: data.warnings,
      })
      setDocumentAnalysis(data.documentAnalysis ?? null)
      const filesReports = data.agentFiles ?? data.documentAnalysis?.agentFiles ?? []
      const summaryReport = data.agentSummary ?? data.documentAnalysis?.agentSummary ?? null
      setAgentFiles(filesReports)
      setAgentSummary(summaryReport)
      syncQueueFromReports(filesReports)

      setActiveDraftId(data.draftId ?? null)
      if (data.draftSaveError) {
        setSaveError(
          `Lỗi lưu bản nháp PostgreSQL: ${data.draftSaveError}. Dữ liệu câu hỏi đã phân tích vẫn hiển thị bên dưới.`
        )
      }

      setQuestions(marked)
      setSelectedValidIds(new Set())
      setSelectedIssueIds(new Set())
      setStage('ready')
      setProgressPercent(100)

      const verifiedTotal = marked.filter((q) => q.answerStatus === 'verified').length
      const aiProposedTotal = marked.filter((q) => q.answerStatus === 'ai_proposed').length
      const needsReviewTotal = marked.filter((q) => q.answerStatus === 'needs_review').length
      setStageMessage(
        `AI Agent hoàn tất: ${marked.length} câu hỏi (${verifiedTotal} từ nguồn, ${aiProposedTotal} AI đề xuất, ${needsReviewTotal} cần kiểm tra).`
      )
      if (data.draftId) {
        setDraftNotice('Đã tự động lưu phiên phân tích AI Agent vào Bản nháp PostgreSQL.')
      }
      void loadDrafts()
      void checkAiStatus(false)
    } catch (err) {
      setStage('error')
      setQueuedFiles((prev) =>
        prev.map((q) =>
          q.status === 'processing'
            ? {
                ...q,
                status: 'error',
                errorStep: err instanceof QuestionImportError ? err.step ?? 'read_file' : 'read_file',
                errorMessage: err instanceof Error ? err.message : 'Lỗi xử lý tệp.',
              }
            : q
        )
      )
      if (err instanceof QuestionImportError) {
        setProgressPercent((prev) => Math.max(12, err.failedProgress ?? prev))
        setFailedStepLabel(err.stepLabel || 'Lỗi Document AI Agent')
        setFailedStepCode(err.code || null)
        setStageMessage(`Dừng tại bước: ${err.stepLabel || 'Phân tích tài liệu'}`)
        setParseError(err.message)
      } else {
        setProgressPercent((prev) => Math.max(12, prev))
        setFailedStepLabel('Lỗi Document AI Agent')
        setStageMessage('Dừng tại bước: Phân tích tài liệu')
        setParseError(
          err instanceof Error
            ? err.message
            : 'Lỗi kết nối hoặc máy chủ không phản hồi khi chạy Document AI Agent.'
        )
      }
    }
  }

  const handleRetryFailedFile = async (
    targetFileName: string,
    overrideFile?: File,
    clientKeyHint?: string
  ) => {
    const queueItem =
      queuedFiles.find(
        (q) =>
          (clientKeyHint && q.clientKey === clientKeyHint) ||
          q.fileName.normalize('NFC') === targetFileName.normalize('NFC')
      ) ?? null
    const reportItem =
      agentFiles.find((f) => f.fileName.normalize('NFC') === targetFileName.normalize('NFC')) ?? null

    const localRetryFile = overrideFile || queueItem?.file || null
    const libraryDocId = !localRetryFile
      ? queueItem?.libraryDoc?.id || reportItem?.libraryDocumentId || null
      : null

    if (!localRetryFile && !libraryDocId) {
      // Prompt user to re-pick the failed file from disk since a historical draft lacks binary bytes
      setRetryTargetClientKey(targetFileName)
      retryFileInputRef.current?.click()
      return
    }

    const targetRole: AgentFileRole =
      queueItem?.assignedRole ?? reportItem?.assignedRole ?? heuristicRoleFromName(targetFileName)

    const retryKey = queueItem?.clientKey || reportItem?.fileId || targetFileName
    setRetryingFileKey(retryKey)
    setParseError(null)
    setSaveError(null)

    try {
      const helperAnswerFiles: File[] = []
      const helperLibraryIds: string[] = libraryDocId ? [libraryDocId] : []
      const roleMap: Record<string, AgentFileRole> = {}

      if (localRetryFile) {
        roleMap[localRetryFile.name] = targetRole
        roleMap[localRetryFile.name.normalize('NFC')] = targetRole
        roleMap['0'] = targetRole
      } else if (libraryDocId) {
        roleMap[libraryDocId] = targetRole
        roleMap[targetFileName] = targetRole
        roleMap[targetFileName.normalize('NFC')] = targetRole
      }

      // If retrying a question file, include available answer/reference files from queue for matching
      if (targetRole === 'question_file') {
        queuedFiles.forEach((q) => {
          if (q.assignedRole !== 'answer_file' && q.assignedRole !== 'reference_file') return
          if (q.file) {
            const idx = 1 + helperAnswerFiles.length
            helperAnswerFiles.push(q.file)
            roleMap[q.fileName] = q.assignedRole
            roleMap[q.fileName.normalize('NFC')] = q.assignedRole
            roleMap[String(idx)] = q.assignedRole
          } else if (q.libraryDoc && q.libraryDoc.id !== libraryDocId) {
            helperLibraryIds.push(q.libraryDoc.id)
            roleMap[q.libraryDoc.id] = q.assignedRole
            roleMap[q.fileName] = q.assignedRole
          }
        })
      }

      const filesToSend = localRetryFile ? [localRetryFile, ...helperAnswerFiles] : helperAnswerFiles

      const retryRes = await runDocumentAiAgentAnalyzeClient({
        files: filesToSend,
        libraryDocumentIds: helperLibraryIds,
        fileRoles: roleMap,
        setMode: targetRole === 'composite_file' ? 'composite_study' : setMode,
        bankName: bankNameInput.trim(),
        preferredTypes,
        mcqCount,
        trueFalseCount,
        essayCount,
        adaptiveAutoCount,
        topicFocus,
        saveDraft: false,
      })

      const retryNameNfc = (localRetryFile?.name || targetFileName).normalize('NFC')
      const incomingForTarget = retryRes.questions.filter(
        (q) =>
          q.sourceDocumentName.normalize('NFC') === retryNameNfc ||
          retryRes.agentFiles?.length === 1
      )

      const mergedQuestions = recomputeIntraFileDuplicates([
        ...questions.filter((q) => q.sourceDocumentName.normalize('NFC') !== targetFileName.normalize('NFC')),
        ...markBankDuplicatesAndNormalize(incomingForTarget),
      ])

      const updatedFileReport = retryRes.agentFiles?.find(
        (r) => r.fileName.normalize('NFC') === retryNameNfc
      ) ?? retryRes.agentFiles?.[0]

      const nextAgentFiles = agentFiles.some(
        (f) => f.fileName.normalize('NFC') === targetFileName.normalize('NFC')
      )
        ? agentFiles.map((f) =>
            f.fileName.normalize('NFC') === targetFileName.normalize('NFC') && updatedFileReport
              ? updatedFileReport
              : f
          )
        : updatedFileReport
        ? [...agentFiles, updatedFileReport]
        : agentFiles

      const completedFiles = nextAgentFiles.filter((f) => f.status === 'completed').length
      const failedFiles = nextAgentFiles.filter((f) => f.status === 'error').length
      const nextSummary: AgentAnalysisSummary | null = agentSummary
        ? {
            ...agentSummary,
            totalFiles: nextAgentFiles.length,
            completedFiles,
            failedFiles,
            totalQuestions: mergedQuestions.length,
            verifiedCount: mergedQuestions.filter((q) => q.answerStatus === 'verified').length,
            aiProposedCount: mergedQuestions.filter((q) => q.answerStatus === 'ai_proposed').length,
            needsReviewCount: mergedQuestions.filter((q) => q.answerStatus === 'needs_review').length,
            missingCount: mergedQuestions.filter((q) => q.answerStatus === 'missing').length,
            ambiguousCount: mergedQuestions.filter((q) => q.answerStatus === 'ambiguous').length,
            duplicateCount: mergedQuestions.filter((q) => q.duplicateInFile || q.duplicateInBank)
              .length,
          }
        : retryRes.agentSummary ?? null

      setQuestions(mergedQuestions)
      setAgentFiles(nextAgentFiles)
      setAgentSummary(nextSummary)

      if (updatedFileReport) {
        syncQueueFromReports([updatedFileReport])
      }
      if (localRetryFile && queueItem) {
        setQueuedFiles((prev) =>
          prev.map((q) => (q.clientKey === queueItem.clientKey ? { ...q, file: localRetryFile } : q))
        )
      }

      const nextAnalysis: CompositeDocumentAnalysis | null = documentAnalysis
        ? {
            ...documentAnalysis,
            agentFiles: nextAgentFiles,
            agentSummary: nextSummary ?? undefined,
          }
        : nextSummary || nextAgentFiles.length > 0
        ? {
            documentSummary: `Khôi phục xử lý tệp ${retryNameNfc}.`,
            detectedTopics: [],
            detectedLessons: [],
            knowledgeUnits: [],
            agentFiles: nextAgentFiles,
            agentSummary: nextSummary ?? undefined,
          }
        : null

      setDocumentAnalysis(nextAnalysis)

      if (activeDraftId) {
        await updateQuestionImportDraftClient({
          draftId: activeDraftId,
          documentAnalysis: nextAnalysis,
          questions: mergedQuestions,
          warnings: [
            ...(parsedDoc?.warnings ?? []),
            `Đã thử lại thành công tệp "${retryNameNfc}" (+${incomingForTarget.length} câu).`,
          ],
        })
        await loadDrafts()
      }

      setStage('ready')
      setDraftNotice(
        `Đã xử lý lại thành công tệp "${retryNameNfc}" và đồng bộ ${incomingForTarget.length} câu hỏi vào danh sách.`
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Thử lại tệp lỗi không thành công.'
      setParseError(`Thử lại tệp "${targetFileName}" thất bại: ${msg}`)
    } finally {
      setRetryingFileKey(null)
      setRetryTargetClientKey(null)
    }
  }

  const handleLoadDraft = (draft: QuestionImportDraftRecord) => {
    setParseError(null)
    setFailedStepLabel(null)
    setFailedStepCode(null)
    setSaveError(null)
    setSaveSuccess(null)
    setDraftNotice(
      `Đang mở bản nháp "${draft.title}" (cập nhật lúc ${formatDateVi(draft.updatedAt)}).`
    )
    const marked = markBankDuplicatesAndNormalize(draft.questions)
    if (draft.bankName) {
      setBankNameInput(draft.bankName)
    }
    setParsedDoc({
      fileName: draft.sourceDocumentName,
      fileFormat: draft.sourceFormat,
      fileHash: draft.sourceFileHash,
      pageCount: null,
      documentCategory: draft.documentCategory,
      answerProvisionMode: draft.answerProvisionMode,
      answerFileName: draft.answerFileName,
      parserEngine:
        draft.documentCategory === 'composite_document' ? 'gemini_agent' : 'gemini_hybrid',
      warnings: draft.warnings,
    })
    setDocumentAnalysis(draft.documentAnalysis)
    setAgentFiles(draft.documentAnalysis?.agentFiles ?? [])
    setAgentSummary(draft.documentAnalysis?.agentSummary ?? null)
    setActiveDraftId(draft.id)
    setQuestions(marked)
    setSelectedValidIds(new Set())
    setSelectedIssueIds(new Set())
    setStage('ready')
    setProgressPercent(100)
    setStageMessage(`Đã tải bản nháp gồm ${marked.length} câu hỏi từ PostgreSQL.`)
  }

  const handleSaveDraftManual = async () => {
    if (!parsedDoc || questions.length === 0) return
    setSavingDraft(true)
    setDraftNotice(null)
    setSaveError(null)

    const updatedAnalysis: CompositeDocumentAnalysis | null = documentAnalysis
      ? {
          ...documentAnalysis,
          agentFiles: agentFiles.length > 0 ? agentFiles : documentAnalysis.agentFiles,
          agentSummary: agentSummary
            ? {
                ...agentSummary,
                totalQuestions: questions.length,
                verifiedCount: stats.verifiedCount,
                aiProposedCount: stats.aiProposedCount,
                needsReviewCount: stats.needsReviewCount,
                missingCount: stats.missingCount,
                ambiguousCount: stats.ambiguousCount,
                duplicateCount: stats.duplicateCount,
                averageConfidence: stats.averageConfidence,
              }
            : documentAnalysis.agentSummary,
        }
      : null

    try {
      if (activeDraftId) {
        await updateQuestionImportDraftClient({
          draftId: activeDraftId,
          bankName: bankNameInput.trim(),
          documentAnalysis: updatedAnalysis,
          questions,
          warnings: parsedDoc.warnings,
        })
        setDraftNotice('Đã cập nhật bản nháp vào cơ sở dữ liệu PostgreSQL.')
      } else {
        const created = await createQuestionImportDraftClient({
          title: `${parsedDoc.fileName} (${questions.length} câu)`,
          bankName: bankNameInput.trim(),
          documentCategory: parsedDoc.documentCategory,
          answerProvisionMode: parsedDoc.answerProvisionMode,
          sourceDocumentName: parsedDoc.fileName,
          sourceFormat: parsedDoc.fileFormat,
          sourceFileHash: parsedDoc.fileHash,
          answerFileName: parsedDoc.answerFileName,
          documentAnalysis: updatedAnalysis,
          questions,
          warnings: parsedDoc.warnings,
        })
        setActiveDraftId(created.id)
        setDraftNotice('Đã lưu bản nháp mới vào cơ sở dữ liệu PostgreSQL.')
      }
      await loadDrafts()
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Không thể lưu bản nháp vào PostgreSQL.'
      )
    } finally {
      setSavingDraft(false)
    }
  }

  const handleDeleteDraft = async (draftId: string) => {
    try {
      await deleteQuestionImportDraftClient(draftId)
      if (activeDraftId === draftId) {
        setActiveDraftId(null)
      }
      setDrafts((prev) => prev.filter((d) => d.id !== draftId))
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Không thể xóa bản nháp.')
    }
  }

  const handleExportExcel = async () => {
    if (!parsedDoc || questions.length === 0) return
    setExportingExcel(true)
    setSaveError(null)
    try {
      await exportAgentExcelReportClient({
        draftId: activeDraftId,
        title: parsedDoc.fileName,
        bankName: bankNameInput.trim(),
        agentFiles,
        agentSummary: agentSummary
          ? {
              ...agentSummary,
              totalQuestions: questions.length,
              verifiedCount: stats.verifiedCount,
              aiProposedCount: stats.aiProposedCount,
              needsReviewCount: stats.needsReviewCount,
              missingCount: stats.missingCount,
              ambiguousCount: stats.ambiguousCount,
              duplicateCount: stats.duplicateCount,
              averageConfidence: stats.averageConfidence,
            }
          : null,
        questions,
      })
      setDraftNotice('Đã xuất báo cáo kiểm tra 3 sheet định dạng Excel (.xlsx).')
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Không thể xuất báo cáo Excel (.xlsx).'
      )
    } finally {
      setExportingExcel(false)
    }
  }

  const confirmSingleAiProposal = (q: ExtractedQuestion): ExtractedQuestion => {
    const s = q.aiSuggestion
    const nowIso = q.aiProcessedAt || s?.processedAt || new Date().toISOString()
    if (s && !s.applied) {
      const nextAnswerKey =
        q.questionType === 'multiple_choice'
          ? s.suggestedAnswerKey ?? q.answerKey
          : q.answerKey
      const nextStA =
        q.questionType === 'true_false'
          ? s.suggestedStatementA ?? q.statementAnswerA
          : q.statementAnswerA
      const nextStB =
        q.questionType === 'true_false'
          ? s.suggestedStatementB ?? q.statementAnswerB
          : q.statementAnswerB
      const nextStC =
        q.questionType === 'true_false'
          ? s.suggestedStatementC ?? q.statementAnswerC
          : q.statementAnswerC
      const nextStD =
        q.questionType === 'true_false'
          ? s.suggestedStatementD ?? q.statementAnswerD
          : q.statementAnswerD
      const nextRubric =
        q.questionType === 'essay' && s.suggestedRubric
          ? s.suggestedRubric
          : q.rubric

      const candidate: ExtractedQuestion = {
        ...q,
        // NEVER alter questionText or originalQuestionText when confirming or marking *
        originalQuestionText: q.originalQuestionText || q.questionText,
        answerKey: nextAnswerKey,
        statementAnswerA: nextStA,
        statementAnswerB: nextStB,
        statementAnswerC: nextStC,
        statementAnswerD: nextStD,
        rubric: nextRubric,
        explanation: q.explanation || s.suggestedExplanation,
        aiProposedMarked: true,
        aiSourceType: q.aiSourceType ?? s.sourceType ?? 'ai_knowledge',
        aiProcessedAt: nowIso,
        aiBatchError: null,
        skippedInImport: false,
        skippedAt: null,
        aiSuggestion: {
          ...s,
          applied: true,
          markedAsAiProposed: true,
          processedAt: nowIso,
        },
      }
      const structurallyValid = validateQuestionForBlueprint(candidate) === null
      const sourceRefText = s.sourceReference || s.sourceFileName || q.sourceDocumentName
      const starredSource = `[*] AI đề xuất (${s.confidenceScore}% · Đã chấp nhận · ${sourceRefText})`.slice(
        0,
        295
      )
      return {
        ...candidate,
        answerStatus: structurallyValid ? 'verified' : 'needs_review',
        reviewDecision: structurallyValid ? 'approved' : 'pending',
        exceptionCategory: structurallyValid ? 'ai_proposed_star' : 'needs_review',
        answerSource: starredSource,
        answerNote: structurallyValid
          ? `Super Admin đã chấp nhận đáp án * AI đề xuất (${s.confidenceScore}%): ${s.reasoning}`
          : q.answerNote,
        confidenceScore: Math.max(q.confidenceScore ?? 0, s.confidenceScore),
        confidenceLevel: structurallyValid ? 'high' : candidate.confidenceLevel,
      }
    }

    const candidate: ExtractedQuestion = {
      ...q,
      originalQuestionText: q.originalQuestionText || q.questionText,
      aiProposedMarked: true,
      aiSourceType: q.aiSourceType ?? 'ai_knowledge',
      aiProcessedAt: nowIso,
      aiBatchError: null,
      skippedInImport: false,
      skippedAt: null,
      aiSuggestion: q.aiSuggestion
        ? { ...q.aiSuggestion, applied: true, markedAsAiProposed: true, processedAt: nowIso }
        : q.aiSuggestion,
    }
    const structurallyValid = validateQuestionForBlueprint(candidate) === null
    const conf = Math.max(q.confidenceScore ?? 0, 88)
    return {
      ...candidate,
      answerStatus: structurallyValid ? 'verified' : 'needs_review',
      reviewDecision: structurallyValid ? 'approved' : 'pending',
      exceptionCategory: structurallyValid ? 'ai_proposed_star' : 'needs_review',
      answerSource: `[*] AI đề xuất (${conf}% · Đã chấp nhận · ${q.sourceDocumentName})`.slice(
        0,
        295
      ),
      answerNote: structurallyValid
        ? 'Super Admin đã chấp nhận đáp án * AI đề xuất.'
        : 'Đề xuất AI chưa đủ cấu trúc bắt buộc, cần bổ sung thủ công.',
      confidenceScore: conf,
      confidenceLevel: structurallyValid ? 'high' : candidate.confidenceLevel,
    }
  }

  const persistDraftQuestionsBestEffort = useCallback(
    async (nextQuestions: ExtractedQuestion[]) => {
      if (!activeDraftId) return
      try {
        await updateQuestionImportDraftClient({
          draftId: activeDraftId,
          bankName: bankNameInput.trim(),
          questions: nextQuestions,
        })
      } catch {
        // Non-blocking best-effort sync to PostgreSQL draft
      }
    },
    [activeDraftId, bankNameInput]
  )

  const handleConfirmAiProposal = (tempId: string) => {
    setSaveError(null)
    let updatedSnapshot: ExtractedQuestion[] | null = null
    setQuestions((prev) => {
      const next = prev.map((q) => {
        if (q.tempId !== tempId) return q
        if (q.duplicateInFile || q.duplicateInBank || q.skippedInImport) return q
        return confirmSingleAiProposal(q)
      })
      updatedSnapshot = next
      return next
    })
    setSelectedIssueIds((prev) => {
      if (!prev.has(tempId)) return prev
      const next = new Set(prev)
      next.delete(tempId)
      return next
    })
    if (updatedSnapshot) {
      void persistDraftQuestionsBestEffort(updatedSnapshot)
    }
  }

  const handleBatchConfirmAiProposals = () => {
    if (selectedIssueIds.size === 0) return
    setSaveError(null)
    let confirmedCount = 0
    let updatedSnapshot: ExtractedQuestion[] | null = null
    setQuestions((prev) => {
      const next = prev.map((q) => {
        if (!selectedIssueIds.has(q.tempId)) return q
        if (q.duplicateInFile || q.duplicateInBank || q.skippedInImport) return q
        if (q.answerStatus !== 'ai_proposed' && !(q.aiSuggestion && !q.aiSuggestion.applied)) {
          return q
        }
        const updated = confirmSingleAiProposal(q)
        if (updated.answerStatus === 'verified') confirmedCount += 1
        return updated
      })
      updatedSnapshot = next
      return next
    })
    setSelectedIssueIds(new Set())
    if (confirmedCount > 0) {
      setDraftNotice(
        `Đã chấp nhận và chuyển ${confirmedCount} câu có đáp án * AI đề xuất sang danh sách hợp lệ (giữ nguyên đánh dấu * và nguồn tham chiếu).`
      )
      if (updatedSnapshot) {
        void persistDraftQuestionsBestEffort(updatedSnapshot)
      }
    }
  }

  const handleAcceptAllHighConfidenceAi = () => {
    if (highConfidenceAiProposals.length === 0) return
    setSaveError(null)
    const targetIds = new Set(highConfidenceAiProposals.map((q) => q.tempId))
    let acceptedCount = 0
    let updatedSnapshot: ExtractedQuestion[] | null = null
    setQuestions((prev) => {
      const next = prev.map((q) => {
        if (!targetIds.has(q.tempId)) return q
        const updated = confirmSingleAiProposal(q)
        if (updated.answerStatus === 'verified') acceptedCount += 1
        return updated
      })
      updatedSnapshot = next
      return next
    })
    setSelectedIssueIds((prev) => {
      const next = new Set(prev)
      targetIds.forEach((id) => next.delete(id))
      return next
    })
    if (acceptedCount > 0) {
      setDraftNotice(
        `Đã chấp nhận hàng loạt ${acceptedCount} đáp án AI có độ tin cậy cao (≥${HIGH_CONFIDENCE_AI_THRESHOLD}%) và giữ nguyên dấu * AI đề xuất.`
      )
      if (updatedSnapshot) {
        void persistDraftQuestionsBestEffort(updatedSnapshot)
      }
    }
  }

  // BATCH ACTION 1: "AI tự tìm và bổ sung đáp án" (chunked in batches of 8 with live progress + fault isolation)
  const handleBatchAiResolveExceptions = async (retryOnlyTempIds?: string[]) => {
    setSaveError(null)
    setParseError(null)
    setDraftNotice(null)

    const activeSelectedIds = Array.from(selectedIssueIds).filter((id) =>
      activeIssueQuestions.some((q) => q.tempId === id)
    )

    let targetQuestions: ExtractedQuestion[] = []
    if (retryOnlyTempIds && retryOnlyTempIds.length > 0) {
      const retrySet = new Set(retryOnlyTempIds)
      targetQuestions = activeIssueQuestions.filter((q) => retrySet.has(q.tempId))
    } else if (activeSelectedIds.length > 0) {
      const selSet = new Set(activeSelectedIds)
      targetQuestions = activeIssueQuestions.filter((q) => selSet.has(q.tempId))
    } else {
      targetQuestions = activeIssueQuestions.filter((q) => !isQuestionInvalidOrDuplicate(q))
      if (targetQuestions.length === 0) {
        targetQuestions = activeIssueQuestions
      }
    }

    if (targetQuestions.length === 0) {
      setDraftNotice('Không có câu ngoại lệ nào đang hoạt động để AI xử lý.')
      return
    }

    const existingBankHints: BatchResolveExistingBankHint[] = existingBank
      .slice(0, 400)
      .map((item) => ({
        id: item.id,
        questionType: item.questionType,
        questionText: item.questionText,
        lessonTitle: item.lessonTitle,
        optionA: item.optionA,
        optionB: item.optionB,
        optionC: item.optionC,
        optionD: item.optionD,
        answerKey: item.answerKey,
        statementA: item.statementA,
        statementB: item.statementB,
        statementC: item.statementC,
        statementD: item.statementD,
        statementAnswerA: item.statementAnswerA,
        statementAnswerB: item.statementAnswerB,
        statementAnswerC: item.statementAnswerC,
        statementAnswerD: item.statementAnswerD,
        rubric: item.rubric,
        explanation: item.explanation,
        sourceDocumentName: item.sourceDocumentName,
      }))

    const chunks: ExtractedQuestion[][] = []
    for (let i = 0; i < targetQuestions.length; i += EXCEPTION_BATCH_CHUNK_SIZE) {
      chunks.push(targetQuestions.slice(i, i + EXCEPTION_BATCH_CHUNK_SIZE))
    }

    setBatchResolving(true)
    setLastBatchReport(null)
    const cumulative = {
      processed: 0,
      foundInSource: 0,
      aiProposed: 0,
      needsReview: 0,
      notFound: 0,
      invalidOrDuplicate: 0,
      failed: 0,
      aiUnavailable: false,
      aiErrorMessage: null as string | null,
    }
    const nextFailedIds = new Set<string>()
    let workingQuestions = [...questions]

    setBatchProgress({
      currentBatch: 0,
      totalBatches: chunks.length,
      processed: 0,
      total: targetQuestions.length,
      foundInSource: 0,
      aiProposed: 0,
      needsReview: 0,
      notFound: 0,
      invalidOrDuplicate: 0,
      failed: 0,
    })

    try {
      for (let batchIdx = 0; batchIdx < chunks.length; batchIdx += 1) {
        const chunk = chunks[batchIdx]
        setBatchProgress({
          currentBatch: batchIdx + 1,
          totalBatches: chunks.length,
          processed: cumulative.processed,
          total: targetQuestions.length,
          foundInSource: cumulative.foundInSource,
          aiProposed: cumulative.aiProposed,
          needsReview: cumulative.needsReview,
          notFound: cumulative.notFound,
          invalidOrDuplicate: cumulative.invalidOrDuplicate,
          failed: cumulative.failed,
        })

        try {
          const res = await resolveExceptionQuestionsBatchClient({
            draftId: activeDraftId,
            questions: chunk,
            documentAnalysis,
            existingBankHints,
            allowAiKnowledgeFallback: true,
          })

          const updatedById = new Map<string, ExtractedQuestion>()
          for (const u of res.questions) {
            updatedById.set(u.tempId, u)
          }

          workingQuestions = workingQuestions.map((existing) => {
            const replacement = updatedById.get(existing.tempId)
            if (!replacement) return existing
            // Preserve original question text strictly
            return {
              ...replacement,
              questionText: existing.questionText,
              originalQuestionText: existing.originalQuestionText || existing.questionText,
            }
          })

          setQuestions(markBankDuplicatesAndNormalize(workingQuestions))

          cumulative.processed += chunk.length
          cumulative.foundInSource += res.stats.foundInSourceCount
          cumulative.aiProposed += res.stats.aiProposedCount
          cumulative.needsReview += res.stats.needsReviewCount
          cumulative.notFound += res.stats.notFoundCount
          cumulative.invalidOrDuplicate += res.stats.invalidOrDuplicateCount
          cumulative.failed += res.stats.failedCount
          if (res.aiUnavailable) cumulative.aiUnavailable = true
          if (res.aiErrorMessage && !cumulative.aiErrorMessage) {
            cumulative.aiErrorMessage = res.aiErrorMessage
          }
          for (const fid of res.failedTempIds) {
            nextFailedIds.add(fid)
          }
        } catch (chunkErr) {
          const errMsg =
            chunkErr instanceof Error
              ? chunkErr.message
              : 'Lỗi kết nối khi xử lý lô câu hỏi ngoại lệ.'
          const chunkIds = new Set(chunk.map((item) => item.tempId))
          workingQuestions = workingQuestions.map((existing) =>
            chunkIds.has(existing.tempId)
              ? {
                  ...existing,
                  aiBatchError: errMsg,
                  aiProcessedAt: new Date().toISOString(),
                }
              : existing
          )
          setQuestions(markBankDuplicatesAndNormalize(workingQuestions))
          cumulative.processed += chunk.length
          cumulative.failed += chunk.length
          if (!cumulative.aiErrorMessage) cumulative.aiErrorMessage = errMsg
          chunk.forEach((item) => nextFailedIds.add(item.tempId))
        }

        setBatchProgress({
          currentBatch: batchIdx + 1,
          totalBatches: chunks.length,
          processed: cumulative.processed,
          total: targetQuestions.length,
          foundInSource: cumulative.foundInSource,
          aiProposed: cumulative.aiProposed,
          needsReview: cumulative.needsReview,
          notFound: cumulative.notFound,
          invalidOrDuplicate: cumulative.invalidOrDuplicate,
          failed: cumulative.failed,
        })
      }

      const finalFailedList = Array.from(nextFailedIds)
      setFailedBatchTempIds(finalFailedList)
      setLastBatchReport({
        totalRequested: targetQuestions.length,
        foundInSource: cumulative.foundInSource,
        aiProposed: cumulative.aiProposed,
        needsReview: cumulative.needsReview,
        notFound: cumulative.notFound,
        invalidOrDuplicate: cumulative.invalidOrDuplicate,
        failed: cumulative.failed,
        aiUnavailable: cumulative.aiUnavailable,
        aiErrorMessage: cumulative.aiErrorMessage,
      })

      setSelectedIssueIds(new Set())
      void persistDraftQuestionsBestEffort(markBankDuplicatesAndNormalize(workingQuestions))
      void checkAiStatus(false)

      setDraftNotice(
        `AI Agent đã hoàn tất xử lý ${targetQuestions.length} câu ngoại lệ: ${cumulative.foundInSource} câu tìm thấy trong nguồn, ${cumulative.aiProposed} câu AI đề xuất (*), ${cumulative.needsReview} câu cần kiểm tra thêm, ${cumulative.notFound} câu không đủ căn cứ${cumulative.failed > 0 ? `, ${cumulative.failed} câu lỗi có thể thử lại` : ''}.`
      )
    } finally {
      setBatchResolving(false)
    }
  }

  // BATCH ACTION 2: "Đánh dấu * câu hỏi AI đề xuất" (metadata + answerSource only; NEVER touches questionText)
  const handleMarkAiProposedWithStar = () => {
    setSaveError(null)
    const nowIso = new Date().toISOString()
    const hasSelection = selectedIssueIds.size > 0
    let markedCount = 0
    let updatedSnapshot: ExtractedQuestion[] | null = null

    setQuestions((prev) => {
      const next = prev.map((q) => {
        if (q.skippedInImport) return q
        if (hasSelection && !selectedIssueIds.has(q.tempId)) return q
        const isAiCandidate =
          q.answerStatus === 'ai_proposed' ||
          q.exceptionCategory === 'ai_proposed_star' ||
          q.aiSourceType === 'ai_knowledge' ||
          Boolean(q.aiSuggestion && q.aiSuggestion.sourceType === 'ai_knowledge') ||
          Boolean(q.aiSuggestion && q.answerStatus !== 'verified')
        if (!isAiCandidate) return q

        const currentSource = (q.answerSource ?? '').trim()
        const nextSource = currentSource.startsWith('[*]')
          ? currentSource
          : `[*] ${currentSource || 'AI đề xuất'}`.slice(0, 295)

        markedCount += 1
        return {
          ...q,
          // Strictly preserve original question stem
          questionText: q.questionText,
          originalQuestionText: q.originalQuestionText || q.questionText,
          aiProposedMarked: true,
          aiSourceType: q.aiSourceType ?? q.aiSuggestion?.sourceType ?? 'ai_knowledge',
          aiProcessedAt: q.aiProcessedAt ?? q.aiSuggestion?.processedAt ?? nowIso,
          answerSource: nextSource,
          aiSuggestion: q.aiSuggestion
            ? {
                ...q.aiSuggestion,
                markedAsAiProposed: true,
                processedAt: q.aiSuggestion.processedAt ?? nowIso,
              }
            : q.aiSuggestion,
        }
      })
      updatedSnapshot = next
      return next
    })

    if (markedCount > 0) {
      setDraftNotice(
        `Đã gắn dấu * (AI đề xuất) kèm siêu dữ liệu nguồn & thời điểm xử lý cho ${markedCount} câu hỏi (giữ nguyên 100% nội dung câu hỏi gốc).`
      )
      if (updatedSnapshot) {
        void persistDraftQuestionsBestEffort(updatedSnapshot)
      }
    } else {
      setDraftNotice(
        'Chưa có câu hỏi nào do AI đề xuất trong phạm vi đang chọn. Hãy chạy "AI tự tìm và bổ sung đáp án" trước.'
      )
    }
  }

  // BATCH ACTION 3: "Loại bỏ tất cả khỏi đợt nhập" (non-destructive skip; preserves original doc & PostgreSQL)
  const handleSkipAllVisibleExceptions = () => {
    setSaveError(null)
    const nowIso = new Date().toISOString()
    const activeSelectedIds = Array.from(selectedIssueIds).filter((id) =>
      activeIssueQuestions.some((q) => q.tempId === id)
    )
    const targetList =
      activeSelectedIds.length > 0
        ? activeIssueQuestions.filter((q) => activeSelectedIds.includes(q.tempId))
        : issueFilter === 'skipped'
        ? activeIssueQuestions
        : filteredIssueQuestions.filter((q) => !q.skippedInImport)

    if (targetList.length === 0) {
      setDraftNotice('Không có câu ngoại lệ nào cần loại bỏ khỏi đợt nhập hiện tại.')
      return
    }

    const targetIds = new Set(targetList.map((q) => q.tempId))
    let updatedSnapshot: ExtractedQuestion[] | null = null

    setQuestions((prev) => {
      const next = prev.map((q) => {
        if (!targetIds.has(q.tempId)) return q
        return {
          ...q,
          skippedInImport: true,
          skippedAt: nowIso,
          exceptionCategory: 'skipped_in_import' as const,
          reviewDecision: 'rejected' as const,
        }
      })
      updatedSnapshot = next
      return next
    })

    setSelectedIssueIds((prev) => {
      const next = new Set(prev)
      targetIds.forEach((id) => next.delete(id))
      return next
    })

    setDraftNotice(
      `Đã chuyển ${targetIds.size} câu ngoại lệ sang trạng thái "Bỏ qua trong đợt nhập" (không xóa khỏi tài liệu gốc hay PostgreSQL — có thể khôi phục bất kỳ lúc nào).`
    )
    if (updatedSnapshot) {
      void persistDraftQuestionsBestEffort(updatedSnapshot)
    }
  }

  const handleSkipSingleException = (tempId: string) => {
    setSaveError(null)
    const nowIso = new Date().toISOString()
    let updatedSnapshot: ExtractedQuestion[] | null = null
    setQuestions((prev) => {
      const next = prev.map((q) =>
        q.tempId === tempId
          ? {
              ...q,
              skippedInImport: true,
              skippedAt: nowIso,
              exceptionCategory: 'skipped_in_import' as const,
              reviewDecision: 'rejected' as const,
            }
          : q
      )
      updatedSnapshot = next
      return next
    })
    setSelectedIssueIds((prev) => {
      if (!prev.has(tempId)) return prev
      const next = new Set(prev)
      next.delete(tempId)
      return next
    })
    if (updatedSnapshot) {
      void persistDraftQuestionsBestEffort(updatedSnapshot)
    }
  }

  const handleRestoreSkippedQuestions = (tempIds?: string[]) => {
    setSaveError(null)
    const targetIds =
      tempIds && tempIds.length > 0
        ? new Set(tempIds)
        : new Set(skippedIssueQuestions.map((q) => q.tempId))

    if (targetIds.size === 0) return

    let restoredCount = 0
    let updatedSnapshot: ExtractedQuestion[] | null = null

    setQuestions((prev) => {
      const next = prev.map((q) => {
        if (!targetIds.has(q.tempId) || !q.skippedInImport) return q
        restoredCount += 1
        return {
          ...q,
          skippedInImport: false,
          skippedAt: null,
          exceptionCategory:
            q.answerStatus === 'ai_proposed'
              ? ('ai_proposed_star' as const)
              : q.answerStatus === 'needs_review'
              ? ('needs_review' as const)
              : isQuestionInvalidOrDuplicate(q)
              ? ('invalid_or_duplicate' as const)
              : ('not_found' as const),
          reviewDecision: q.duplicateInFile || q.duplicateInBank ? ('rejected' as const) : ('pending' as const),
        }
      })
      updatedSnapshot = next
      return next
    })

    if (restoredCount > 0) {
      if (issueFilter === 'skipped' && restoredCount >= skippedIssueQuestions.length) {
        setIssueFilter('all')
      }
      setDraftNotice(
        `Đã khôi phục ${restoredCount} câu hỏi từ danh sách bỏ qua để tiếp tục xử lý.`
      )
      if (updatedSnapshot) {
        void persistDraftQuestionsBestEffort(updatedSnapshot)
      }
    }
  }

  const handleToggleSelectIssue = (tempId: string) => {
    setSelectedIssueIds((prev) => {
      const next = new Set(prev)
      if (next.has(tempId)) next.delete(tempId)
      else next.add(tempId)
      return next
    })
  }

  const handleToggleSelectAllVisibleIssues = () => {
    const visibleIds = filteredIssueQuestions.map((q) => q.tempId)
    const allSelected =
      visibleIds.length > 0 && visibleIds.every((id) => selectedIssueIds.has(id))
    if (allSelected) {
      setSelectedIssueIds((prev) => {
        const next = new Set(prev)
        visibleIds.forEach((id) => next.delete(id))
        return next
      })
    } else {
      setSelectedIssueIds((prev) => {
        const next = new Set(prev)
        visibleIds.forEach((id) => next.add(id))
        return next
      })
    }
  }

  const handleContinueIncompleteWithAgent = async () => {
    setSaveError(null)
    setParseError(null)
    setRunningResumeAgent(true)
    try {
      const res = await retryIncompleteAgentClient({
        draftId: activeDraftId,
        mode: 'continue_incomplete',
        questions,
        documentAnalysis,
      })
      const marked = markBankDuplicatesAndNormalize(res.questions)
      setQuestions(marked)
      setAgentSummary(res.agentSummary)
      setDocumentAnalysis(res.documentAnalysis)
      if (res.draftId && !activeDraftId) {
        setActiveDraftId(res.draftId)
      }
      if (res.warnings.length > 0 && parsedDoc) {
        setParsedDoc({
          ...parsedDoc,
          warnings: Array.from(new Set([...parsedDoc.warnings, ...res.warnings])),
        })
      }
      setDraftNotice(
        `AI Agent đã xử lý ${res.processedCount} câu chưa hoàn thành (cập nhật đề xuất mới cho ${res.updatedCount} câu).`
      )
      void loadDrafts()
      void checkAiStatus(false)
    } catch (err) {
      setParseError(
        err instanceof Error
          ? err.message
          : 'Không thể chạy AI Agent tiếp tục xử lý các câu chưa hoàn thành.'
      )
    } finally {
      setRunningResumeAgent(false)
    }
  }

  const handleRematchSelectedIssues = async () => {
    if (selectedIssueIds.size === 0) return
    setSaveError(null)
    setParseError(null)
    setRunningResumeAgent(true)
    try {
      const res = await retryIncompleteAgentClient({
        draftId: activeDraftId,
        mode: 'rematch_selected',
        selectedTempIds: Array.from(selectedIssueIds),
        questions,
        documentAnalysis,
      })
      const marked = markBankDuplicatesAndNormalize(res.questions)
      setQuestions(marked)
      setAgentSummary(res.agentSummary)
      setDocumentAnalysis(res.documentAnalysis)
      setSelectedIssueIds(new Set())
      if (res.warnings.length > 0 && parsedDoc) {
        setParsedDoc({
          ...parsedDoc,
          warnings: Array.from(new Set([...parsedDoc.warnings, ...res.warnings])),
        })
      }
      setDraftNotice(
        `AI Agent đã đối chiếu lại ${res.processedCount} câu được chọn (cập nhật ${res.updatedCount} câu).`
      )
      void loadDrafts()
      void checkAiStatus(false)
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : 'Không thể đối chiếu lại các câu hỏi đã chọn.'
      )
    } finally {
      setRunningResumeAgent(false)
    }
  }

  const handleSetDecision = (tempId: string, decision: ReviewDecision) => {
    setSaveError(null)
    setQuestions((prev) =>
      prev.map((q) => {
        if (q.tempId !== tempId) return q
        if (decision === 'approved' && !isQuestionValidForApproval(q)) {
          return q
        }
        return {
          ...q,
          reviewDecision: decision,
        }
      })
    )
  }

  const handleApproveAllVerifiedFromSource = () => {
    setSaveError(null)
    let changed = 0
    setQuestions((prev) =>
      prev.map((q) => {
        if (!isQuestionValidForApproval(q) || q.reviewDecision === 'rejected') return q
        if (q.reviewDecision !== 'approved') changed += 1
        return {
          ...q,
          reviewDecision: 'approved',
        }
      })
    )
    setDraftNotice(
      changed > 0
        ? `Đã duyệt hàng loạt ${changed} câu hỏi đã xác định từ nguồn.`
        : 'Các câu hỏi đã xác định từ nguồn (không bị từ chối) đều đã ở trạng thái Đã duyệt.'
    )
  }

  const handleApproveAllValid = () => {
    setSaveError(null)
    setQuestions((prev) =>
      prev.map((q) => {
        if (!isQuestionValidForApproval(q)) return q
        return {
          ...q,
          reviewDecision: 'approved',
        }
      })
    )
  }

  const handleApproveSelectedValid = () => {
    if (selectedValidIds.size === 0) return
    setSaveError(null)
    setQuestions((prev) =>
      prev.map((q) => {
        if (!selectedValidIds.has(q.tempId) || !isQuestionValidForApproval(q)) return q
        return { ...q, reviewDecision: 'approved' }
      })
    )
    setSelectedValidIds(new Set())
  }

  const handleToggleSelectValid = (tempId: string) => {
    setSelectedValidIds((prev) => {
      const next = new Set(prev)
      if (next.has(tempId)) next.delete(tempId)
      else next.add(tempId)
      return next
    })
  }

  const handleToggleSelectAllVisibleValid = () => {
    const visibleIds = filteredValidQuestions.map((q) => q.tempId)
    const allSelected =
      visibleIds.length > 0 && visibleIds.every((id) => selectedValidIds.has(id))
    if (allSelected) {
      setSelectedValidIds((prev) => {
        const next = new Set(prev)
        visibleIds.forEach((id) => next.delete(id))
        return next
      })
    } else {
      setSelectedValidIds((prev) => {
        const next = new Set(prev)
        visibleIds.forEach((id) => next.add(id))
        return next
      })
    }
  }

  const handleResetAllToPending = () => {
    setSaveError(null)
    setSelectedValidIds(new Set())
    setSelectedIssueIds(new Set())
    setQuestions((prev) =>
      prev.map((q) => ({
        ...q,
        reviewDecision: q.duplicateInFile || q.duplicateInBank ? 'rejected' : 'pending',
      }))
    )
  }

  const handleSaveEditedRow = async (values: EditableQuestionValues) => {
    if (!editingQuestion) return
    const hashParts =
      values.questionType === 'multiple_choice'
        ? [values.optionA, values.optionB, values.optionC, values.optionD]
        : values.questionType === 'true_false'
        ? [values.statementA, values.statementB, values.statementC, values.statementD]
        : [values.rubric || values.sampleAnswer || 'essay']

    const freshHash = await computeQuestionContentHashBrowser(
      values.questionType,
      values.questionText,
      hashParts
    )

    setQuestions((prev) => {
      const updated = prev.map((q) => {
        if (q.tempId !== editingQuestion.tempId) return q
        const verified =
          values.questionType === 'multiple_choice'
            ? values.answerKey !== null
            : values.questionType === 'true_false'
            ? values.statementAnswerA !== null &&
              values.statementAnswerB !== null &&
              values.statementAnswerC !== null &&
              values.statementAnswerD !== null
            : values.rubric.trim().length >= 5

        return {
          ...q,
          contentHash: freshHash,
          originalQuestionText: q.originalQuestionText || q.questionText,
          questionType: values.questionType,
          bankName: values.bankName,
          topic: values.topic,
          lessonTitle: values.lessonTitle,
          questionNumber: values.questionNumber,
          pageNumber: values.pageNumber,
          cognitiveLevel: values.cognitiveLevel,
          questionText: values.questionText,
          optionA: values.optionA,
          optionB: values.optionB,
          optionC: values.optionC,
          optionD: values.optionD,
          answerKey: values.answerKey,
          statementA: values.statementA,
          statementB: values.statementB,
          statementC: values.statementC,
          statementD: values.statementD,
          statementAnswerA: values.statementAnswerA,
          statementAnswerB: values.statementAnswerB,
          statementAnswerC: values.statementAnswerC,
          statementAnswerD: values.statementAnswerD,
          rubric: values.rubric,
          sampleAnswer: values.sampleAnswer,
          explanation: values.explanation,
          answerStatus: verified ? ('verified' as const) : ('missing' as const),
          matchMethod: 'manual_edit' as const,
          confidenceScore: verified ? 100 : q.confidenceScore ?? 0,
          confidenceLevel: verified ? ('high' as const) : ('low' as const),
          answerSource: verified
            ? 'Super Admin chỉnh sửa & bổ sung thủ công'
            : q.answerSource || 'Chưa đủ đáp án',
          answerNote: verified
            ? 'Đã bổ sung đầy đủ đáp án / biểu điểm khi rà soát.'
            : 'Chưa đủ đáp án hoặc biểu điểm.',
          reviewDecision:
            !verified && q.reviewDecision === 'approved'
              ? ('pending' as const)
              : q.reviewDecision,
        }
      })
      return recomputeIntraFileDuplicates(updated)
    })

    setEditingQuestion(null)
  }

  const handleCommitApprovedToDb = async () => {
    if (!parsedDoc) return
    setSaveError(null)
    setSaveSuccess(null)

    if (!emailVerified) {
      setSaveError(
        'Tài khoản Google chưa xác minh email nên không thể ghi vào cơ sở dữ liệu.'
      )
      return
    }

    if (stats.approvedCount === 0) {
      setSaveError(
        'Vui lòng nhấn "Duyệt" ít nhất 1 câu hỏi hợp lệ trước khi lưu vào Ngân hàng câu hỏi.'
      )
      return
    }

    setSavingToDb(true)
    try {
      const result = await saveApprovedQuestionsToFirestore({
        ownerUid,
        fileName: parsedDoc.fileName,
        fileFormat: parsedDoc.fileFormat,
        fileHash: parsedDoc.fileHash,
        bankName: bankNameInput.trim(),
        allExtractedQuestions: questions,
      })

      if (activeDraftId) {
        try {
          await updateQuestionImportDraftClient({
            draftId: activeDraftId,
            status: 'committed',
            bankName: bankNameInput.trim(),
            questions,
          })
          await loadDrafts()
        } catch {
          // Non-blocking draft status sync
        }
      }

      setSaveSuccess(result)
      await onSavedToDb()
    } catch (err) {
      setSaveError(
        err instanceof Error
          ? err.message
          : 'Không thể lưu câu hỏi vào cơ sở dữ liệu Firestore. Vui lòng thử lại.'
      )
    } finally {
      setSavingToDb(false)
    }
  }

  const canCommit =
    stage === 'ready' &&
    stats.approvedCount > 0 &&
    !savingToDb &&
    emailVerified &&
    saveSuccess === null

  return (
    <div className="space-y-6">
      {/* Hidden input for re-attaching missing binary file during draft retry */}
      <input
        ref={retryFileInputRef}
        type="file"
        accept=".docx,.pdf,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
        className="hidden"
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const picked = e.target.files?.[0]
          const targetName = retryTargetClientKey
          e.target.value = ''
          if (picked && targetName) {
            void handleRetryFailedFile(targetName, picked)
          } else {
            setRetryTargetClientKey(null)
          }
        }}
      />

      {/* Saved Drafts Quick Switcher */}
      {drafts.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold text-[#123B68]">
              <History className="h-4 w-4 text-[#2878B8]" />
              <span>Bản nháp đã lưu trên PostgreSQL ({drafts.length})</span>
            </div>
            {loadingDrafts && <Loader2 className="h-3.5 w-3.5 animate-spin text-[#2878B8]" />}
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {drafts.slice(0, 6).map((d) => {
              const isActive = activeDraftId === d.id
              return (
                <div
                  key={d.id}
                  className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
                    isActive
                      ? 'border-[#2878B8] bg-[#EAF3FA]/65'
                      : 'border-slate-200 bg-[#F8FAFC]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleLoadDraft(d)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="font-semibold text-[#123B68] truncate" title={d.title}>
                      {d.title}
                    </div>
                    <div className="text-[11px] text-[#65758B] flex flex-wrap items-center gap-1.5 mt-0.5 tabular-nums">
                      <span>
                        {d.documentCategory === 'composite_document'
                          ? 'Tài liệu tổng hợp'
                          : 'AI Agent'}
                      </span>
                      <span>·</span>
                      <span>{d.totalCount} câu</span>
                      <span>·</span>
                      <span
                        className={
                          d.status === 'committed'
                            ? 'text-[#2D6A23] font-semibold'
                            : 'text-[#9A520B]'
                        }
                      >
                        {d.status === 'committed' ? 'Đã lưu ngân hàng' : 'Bản nháp'}
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteDraft(d.id)}
                    title="Xóa bản nháp"
                    className="shrink-0 rounded p-1 text-[#65758B] hover:bg-white hover:text-[#D94B45]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Live Gemini API Connection Strip (Zero API key inputs — Settings > Secrets guidance only) */}
      {aiStatus && (
        <section
          className={`rounded-xl border px-4 py-3 text-xs ${
            aiStatus.connected
              ? 'border-[#55A747]/40 bg-[#EEF7EC]/75 text-[#2D6A23]'
              : 'border-[#F28C28]/50 bg-[#FEF6EC] text-[#7D4208]'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              {aiStatus.connected ? (
                <Wifi className="h-4 w-4 shrink-0 mt-0.5 text-[#2D6A23]" />
              ) : (
                <WifiOff className="h-4 w-4 shrink-0 mt-0.5 text-[#9A520B]" />
              )}
              <div className="space-y-0.5">
                <div className="font-bold flex flex-wrap items-center gap-2">
                  <span>
                    Trạng thái Gemini API:{' '}
                    {aiStatus.connected
                      ? 'Đã kết nối'
                      : aiStatus.state === 'invalid_key'
                      ? 'Khóa API không hợp lệ (400 API_KEY_INVALID)'
                      : aiStatus.state === 'permission_denied'
                      ? 'Thiếu quyền truy cập Gemini API'
                      : aiStatus.state === 'quota_exceeded'
                      ? 'Vượt hạn mức Gemini API'
                      : 'Chưa kết nối'}
                  </span>
                  <span className="font-mono text-[11px] opacity-80">· {aiStatus.model}</span>
                </div>
                <p className="leading-relaxed">{aiStatus.message}</p>
                {aiStatus.diagnostics && (
                  <div className="mt-1.5 rounded-lg border border-current/15 bg-white/60 px-3 py-2 text-[11px] font-mono tabular-nums space-y-0.5 text-[#203247]">
                    <div>
                      GEMINI_API_KEY:{' '}
                      <strong>{aiStatus.diagnostics.exists ? 'Có tồn tại' : 'Không tồn tại'}</strong>
                      {' · '}Độ dài: <strong>{aiStatus.diagnostics.keyLength}</strong> ký tự
                    </div>
                    <div>
                      Loại khóa nhận diện: <strong>{aiStatus.diagnostics.detectedKeyType}</strong>
                    </div>
                    <div>
                      Nguồn đọc: <strong>{aiStatus.diagnostics.configSource}</strong>
                      {' · '}Môi trường: <strong>{aiStatus.diagnostics.overrideCheck.runtimeEnv}</strong>
                      {aiStatus.diagnostics.overrideCheck.hasLocalDotEnv ? ' · Có tệp .env cục bộ' : ' · Không bị ghi đè bởi .env cục bộ'}
                    </div>
                    <div>
                      Endpoint: <strong>{aiStatus.diagnostics.apiEndpoint}</strong>
                      {' · '}Model gọi thử: <strong>{aiStatus.model}</strong>
                      {aiStatus.diagnostics.hadFormattingArtifacts
                        ? ' · Đã tự làm sạch khoảng trắng/dấu ngoặc thừa'
                        : ''}
                    </div>
                  </div>
                )}
                {!aiStatus.connected && aiStatus.setupGuide && (
                  <p className="text-[11px] leading-relaxed text-[#6F3A06] pt-1">
                    <strong>Hướng dẫn khắc phục:</strong> {aiStatus.setupGuide} Bộ phân tích cấu trúc DOCX/PDF vẫn hoạt động tự động (không cần AI) cho tài liệu câu hỏi &amp; bảng đáp án.
                  </p>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void checkAiStatus(true)}
              disabled={checkingAiStatus}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#123B68] hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${checkingAiStatus ? 'animate-spin' : ''}`} />
              <span>{checkingAiStatus ? 'Đang kiểm tra...' : 'Kiểm tra kết nối'}</span>
            </button>
          </div>
        </section>
      )}

      {/* Step 1: TIN LAB DOCUMENT AI AGENT — Multi-File Upload & Pipeline Config */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#123B68] text-white">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-display text-base font-bold text-[#123B68]">
                TIN LAB DOCUMENT AI AGENT
              </h3>
              <p className="text-xs text-[#65758B] mt-0.5">
                Tiếp nhận 1 hoặc nhiều tệp (.docx, .pdf, .txt): file câu hỏi, file đáp án riêng, tài liệu tổng hợp. Tự phân loại vai trò, trích xuất giữ nguyên văn và đối chiếu đáp án 4 tầng theo từng Bài học.
              </p>
            </div>
          </div>

          {(parsedDoc || queuedFiles.length > 0) && (
            <button
              type="button"
              onClick={resetSession}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#203247] hover:bg-[#F3F6FA] whitespace-nowrap shrink-0"
            >
              <Trash2 className="h-3.5 w-3.5 text-[#65758B]" />
              <span>Làm mới bộ tài liệu</span>
            </button>
          )}
        </div>

        {/* Agent Processing Mode Selector */}
        <div className="space-y-2">
          <div className="text-xs font-bold text-[#123B68]">
            Chế độ xử lý bộ tài liệu:
          </div>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
            {SET_MODE_OPTIONS.map((opt) => {
              const active = setMode === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setSetMode(opt.value)
                    setParseError(null)
                  }}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    active
                      ? 'border-[#2878B8] bg-[#EAF3FA]/65 ring-1 ring-[#2878B8]'
                      : 'border-slate-200 bg-[#F8FAFC] hover:border-slate-300 hover:bg-white'
                  }`}
                >
                  <div className="text-xs font-bold text-[#123B68]">{opt.label}</div>
                  <p className="mt-1 text-[11px] leading-snug text-[#65758B]">{opt.desc}</p>
                </button>
              )
            })}
          </div>
        </div>

        {/* Multi-file Dropzone + Library Picker Button */}
        <div
          onDragOver={(e: DragEvent<HTMLDivElement>) => {
            e.preventDefault()
            setDragActive(true)
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e: DragEvent<HTMLDivElement>) => {
            e.preventDefault()
            setDragActive(false)
            if (e.dataTransfer.files?.length) {
              void addLocalFilesToQueue(e.dataTransfer.files)
            }
          }}
          className={`rounded-xl border-2 border-dashed p-5 text-center transition-colors ${
            dragActive
              ? 'border-[#2878B8] bg-[#EAF3FA]'
              : queuedFiles.length > 0
              ? 'border-[#2878B8]/50 bg-[#F8FAFC]'
              : 'border-slate-300 bg-[#F3F6FA]/70 hover:border-[#2878B8]/70'
          }`}
        >
          <input
            ref={multiFileInputRef}
            type="file"
            multiple
            accept=".docx,.pdf,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              if (e.target.files?.length) {
                void addLocalFilesToQueue(e.target.files)
              }
              e.target.value = ''
            }}
            className="hidden"
            id="agent-multi-file-input"
          />
          <FileUp className="mx-auto h-8 w-8 text-[#2878B8]" />
          <div className="mt-2 text-sm font-semibold text-[#123B68]">
            Kéo thả cùng lúc File câu hỏi, File đáp án riêng hoặc Giáo trình (.docx / .pdf / .txt)
          </div>
          <p className="mt-1 text-xs text-[#65758B]">
            Hỗ trợ tối đa {MAX_QUEUE_FILES} tệp (mỗi tệp ≤ 20 MB). AI Agent tự nhận diện vai trò từng tệp và bạn có thể chỉnh lại trước khi chạy.
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2.5">
            <label
              htmlFor="agent-multi-file-input"
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[#2878B8]/40 bg-white px-4 py-2 text-xs font-semibold text-[#123B68] hover:border-[#2878B8] hover:text-[#2878B8] transition-colors whitespace-nowrap shrink-0"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              <span>Chọn tệp từ máy tính</span>
            </label>
            <button
              type="button"
              onClick={() => void handleOpenLibraryPicker()}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-[#203247] hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              <BookOpen className="h-3.5 w-3.5 text-[#2878B8]" />
              <span>Chọn từ Thư viện tài liệu</span>
            </button>
          </div>
        </div>

        {/* Queued Files Table with Role Override & Per-File Recovery */}
        {queuedFiles.length > 0 && (
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-[#F3F6FA] px-4 py-2.5 text-xs">
              <div className="font-bold text-[#123B68] tabular-nums">
                Danh sách tài liệu đầu vào ({queuedFiles.length} tệp)
              </div>
              {classifyingQueue && (
                <div className="inline-flex items-center gap-1.5 text-[#2878B8] font-medium">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Đang tự động phân loại vai trò...</span>
                </div>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-[#F8FAFC] font-semibold text-[#65758B]">
                  <tr>
                    <th className="px-4 py-2.5">Tên tệp &amp; Kích thước</th>
                    <th className="px-4 py-2.5 w-56">Vai trò xử lý (có thể đổi)</th>
                    <th className="px-4 py-2.5">Nhận diện AI Agent &amp; Kết quả</th>
                    <th className="px-4 py-2.5 w-36 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {queuedFiles.map((qf) => (
                    <tr key={qf.clientKey} className="align-top bg-white">
                      <td className="px-4 py-2.5 space-y-0.5">
                        <div className="font-semibold text-[#123B68] break-all">{qf.fileName}</div>
                        <div className="text-[11px] text-[#65758B] tabular-nums">
                          {qf.fileFormat.toUpperCase()} · {formatBytes(qf.fileSizeBytes)}
                          {qf.pageCount ? ` · ${qf.pageCount} trang` : ''}
                          {qf.libraryDoc ? ' · Từ Thư viện' : ''}
                        </div>
                      </td>

                      <td className="px-4 py-2.5">
                        <select
                          value={qf.assignedRole}
                          onChange={(e) =>
                            handleRoleChange(qf.clientKey, e.target.value as AgentFileRole)
                          }
                          disabled={stage === 'uploading' || stage === 'parsing' || stage === 'deduping'}
                          className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-[#203247] focus:border-[#2878B8] focus:outline-none"
                        >
                          {(Object.keys(FILE_ROLE_LABELS) as AgentFileRole[]).map((role) => (
                            <option key={role} value={role}>
                              {FILE_ROLE_LABELS[role]}
                            </option>
                          ))}
                        </select>
                      </td>

                      <td className="px-4 py-2.5 space-y-1">
                        <div className="text-[11px] text-[#65758B] leading-snug">
                          <span className="font-semibold text-[#203247] tabular-nums">
                            {FILE_ROLE_LABELS[qf.detectedRole]} ({qf.roleConfidence}%):
                          </span>{' '}
                          {qf.roleReason}
                        </div>
                        {qf.status === 'completed' && (
                          <div className="text-[11px] font-semibold text-[#2D6A23] tabular-nums">
                            Hoàn tất · {qf.extractedCount} câu · {qf.matchedAnswerCount} ĐÁ khớp
                          </div>
                        )}
                        {qf.status === 'error' && qf.errorMessage && (
                          <div className="text-[11px] font-medium text-[#A92F2A]">
                            Lỗi{qf.errorStep ? ` (${qf.errorStep})` : ''}: {qf.errorMessage}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-2.5 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          {qf.status === 'error' && (
                            <button
                              type="button"
                              disabled={retryingFileKey !== null}
                              onClick={() =>
                                void handleRetryFailedFile(qf.fileName, undefined, qf.clientKey)
                              }
                              className="inline-flex items-center gap-1 rounded-md border border-[#2878B8]/40 bg-[#EAF3FA] px-2 py-1 text-[11px] font-semibold text-[#123B68] hover:bg-[#dcecf8] whitespace-nowrap shrink-0"
                            >
                              <RotateCcw className="h-3 w-3" />
                              <span>Thử lại</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRemoveQueuedFile(qf.clientKey)}
                            title="Gỡ tệp khỏi hàng đợi"
                            className="rounded p-1.5 text-[#65758B] hover:bg-[#FDF1F0] hover:text-[#D94B45]"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Bank Name + Preferred Question Types */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="lg:col-span-6">
            <label className="block text-xs font-semibold text-[#203247] mb-1">
              Tên Ngân hàng / Bộ câu hỏi (tùy chọn)
            </label>
            <input
              type="text"
              maxLength={120}
              value={bankNameInput}
              onChange={(e) => setBankNameInput(e.target.value)}
              placeholder="Ví dụ: Ngân hàng Tin 12 · Học kì I (2025)"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247] focus:border-[#2878B8] focus:outline-none"
            />
          </div>

          <div className="lg:col-span-6">
            <label className="block text-xs font-semibold text-[#203247] mb-1.5">
              Dạng câu hỏi ưu tiên trích xuất / tạo
            </label>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { id: 'multiple_choice', label: 'Trắc nghiệm 4 lựa chọn' },
                  { id: 'true_false', label: 'Đúng / Sai (4 ý)' },
                  { id: 'essay', label: 'Tự luận' },
                ] as { id: QuestionType; label: string }[]
              ).map((item) => {
                const active = preferredTypes.includes(item.id)
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => togglePreferredType(item.id)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? 'border-[#2878B8] bg-[#EAF3FA] text-[#123B68]'
                        : 'border-slate-300 bg-white text-[#65758B]'
                    }`}
                  >
                    {active && <Check className="h-3.5 w-3.5 text-[#2878B8]" />}
                    <span>{item.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Conditional Composite Study Parameters */}
        {showCompositeOptions && (
          <div className="rounded-xl border border-[#7954A1]/30 bg-[#F4EFF8]/45 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-bold text-[#5B3C7D]">
                Cấu hình AI Agent cho Tài liệu tổng hợp (giáo trình / đề cương):
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-[#123B68]">
                <input
                  type="checkbox"
                  checked={adaptiveAutoCount}
                  onChange={(e) => setAdaptiveAutoCount(e.target.checked)}
                />
                <span>Tự động điều chỉnh số câu theo độ dài tài liệu</span>
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
              <div className={adaptiveAutoCount ? 'lg:col-span-12' : 'lg:col-span-6'}>
                <label className="block text-[11px] font-semibold text-[#203247] mb-1">
                  Trọng tâm chủ đề cần ưu tiên (tùy chọn)
                </label>
                <input
                  type="text"
                  maxLength={200}
                  value={topicFocus}
                  onChange={(e) => setTopicFocus(e.target.value)}
                  placeholder="Ví dụ: Tập trung Bài 3–Bài 6 Mạng máy tính & CSS..."
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-[#203247]"
                />
              </div>
              {!adaptiveAutoCount && (
                <>
                  <div className="lg:col-span-2">
                    <label className="block text-[11px] font-semibold text-[#203247] mb-1">
                      TN 4 lựa chọn
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={30}
                      value={mcqCount}
                      onChange={(e) =>
                        setMcqCount(Math.max(0, Math.min(30, Number(e.target.value) || 0)))
                      }
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm tabular-nums text-[#203247]"
                    />
                  </div>
                  <div className="lg:col-span-2">
                    <label className="block text-[11px] font-semibold text-[#203247] mb-1">
                      Đúng / Sai (4 ý)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={15}
                      value={trueFalseCount}
                      onChange={(e) =>
                        setTrueFalseCount(Math.max(0, Math.min(15, Number(e.target.value) || 0)))
                      }
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm tabular-nums text-[#203247]"
                    />
                  </div>
                  <div className="lg:col-span-2">
                    <label className="block text-[11px] font-semibold text-[#203247] mb-1">
                      Tự luận (Rubric)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={essayCount}
                      onChange={(e) =>
                        setEssayCount(Math.max(0, Math.min(10, Number(e.target.value) || 0)))
                      }
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm tabular-nums text-[#203247]"
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Primary CTA */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="text-xs text-[#65758B]">
            Quy trình 7 bước: Phân loại tệp → Trích xuất câu hỏi → Phát hiện Bài học/Chủ đề → Ghép đáp án 4 tầng → Chấm độ tin cậy → Gắn 4 trạng thái → Xuất bản nháp.
          </div>

          <button
            type="button"
            disabled={
              queuedFiles.length === 0 ||
              stage === 'uploading' ||
              stage === 'parsing' ||
              stage === 'deduping'
            }
            onClick={() => void handleRunDocumentAiAgent()}
            className="inline-flex items-center gap-2 rounded-lg bg-[#123B68] px-5 py-2.5 min-h-[42px] text-sm font-semibold text-white hover:bg-[#2878B8] disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
          >
            {stage === 'uploading' || stage === 'parsing' || stage === 'deduping' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            <span>AI Agent phân tích tài liệu</span>
          </button>
        </div>

        {/* Progress Bar */}
        {stage !== 'idle' && (
          <div className="rounded-lg border border-slate-200 bg-[#F3F6FA] p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-3 text-xs font-semibold">
              <div className="flex items-center gap-2 text-[#123B68]">
                {stage === 'uploading' || stage === 'parsing' || stage === 'deduping' ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#2878B8]" />
                ) : stage === 'ready' ? (
                  <CheckCircle2 className="h-4 w-4 text-[#55A747]" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-[#D94B45]" />
                )}
                <span>{stageMessage || 'Trạng thái xử lý tài liệu'}</span>
              </div>
              <span className="tabular-nums text-[#123B68]">{progressPercent}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-slate-200">
              <div
                className={`h-full transition-all duration-300 ${
                  stage === 'error'
                    ? 'bg-[#D94B45]'
                    : stage === 'ready'
                    ? 'bg-[#55A747]'
                    : 'bg-[#2878B8]'
                }`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {parseError && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs leading-relaxed text-[#A92F2A]"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
            <div className="space-y-1">
              {failedStepLabel && (
                <div className="flex flex-wrap items-center gap-2 font-bold text-[#8E221E]">
                  <span>Bước lỗi: {failedStepLabel}</span>
                  {failedStepCode && (
                    <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-[10px] border border-[#D94B45]/30">
                      {failedStepCode}
                    </code>
                  )}
                </div>
              )}
              <div>{parseError}</div>
            </div>
          </div>
        )}

        {parsedDoc && questions.length > 0 && stats.verifiedCount === 0 && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-[#F28C28]/45 bg-[#FEF6EC] px-4 py-3 text-xs leading-relaxed text-[#9A520B]"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-[#F28C28]" />
            <div>
              <strong>Chưa xác nhận được đáp án chính thức:</strong> Đã trích xuất {questions.length} câu hỏi nhưng chưa có câu nào đạt độ chắc chắn để tự động chốt đáp án. Hệ thống giữ nguyên ở khu vực Cần kiểm tra và tuyệt đối không tự đoán đáp án.
            </div>
          </div>
        )}

        {draftNotice && (
          <div
            role="status"
            className="flex items-start gap-2.5 rounded-lg border border-[#2878B8]/35 bg-[#EAF3FA] px-4 py-3 text-xs text-[#123B68]"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-[#2878B8]" />
            <span>{draftNotice}</span>
          </div>
        )}
      </section>

      {/* Agent Executed Pipeline Steps & Multi-file Breakdown */}
      {(agentSummary || agentFiles.length > 0) && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-[#2878B8]" />
              <h3 className="font-display text-base font-bold text-[#123B68]">
                Nhật ký xử lý Document AI Agent &amp; Trạng thái từng tệp
              </h3>
            </div>
            {agentSummary && (
              <div className="text-xs text-[#65758B] tabular-nums">
                Hoàn tất {agentSummary.completedFiles}/{agentSummary.totalFiles} tệp · Độ tin cậy trung bình{' '}
                <strong className="text-[#123B68]">{agentSummary.averageConfidence}%</strong>
              </div>
            )}
          </div>

          {agentSummary?.aiErrorMessage && (
            <div className="rounded-lg border border-[#F28C28]/45 bg-[#FEF6EC] px-3.5 py-2.5 text-xs text-[#9A520B]">
              <strong>Lưu ý Gemini AI trong phiên này:</strong> {agentSummary.aiErrorMessage}
            </div>
          )}

          {agentFiles.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-[#F8FAFC] font-semibold text-[#65758B]">
                  <tr>
                    <th className="px-3.5 py-2.5">Tệp nguồn</th>
                    <th className="px-3.5 py-2.5">Vai trò</th>
                    <th className="px-3.5 py-2.5">Trạng thái</th>
                    <th className="px-3.5 py-2.5 text-right tabular-nums">Câu trích xuất</th>
                    <th className="px-3.5 py-2.5 text-right tabular-nums">Khớp đáp án</th>
                    <th className="px-3.5 py-2.5 text-right">Khôi phục</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {agentFiles.map((af) => (
                    <tr key={af.fileId} className="bg-white">
                      <td className="px-3.5 py-2.5">
                        <div className="font-semibold text-[#123B68]">{af.fileName}</div>
                        <div className="text-[11px] text-[#65758B] tabular-nums">
                          {af.fileFormat.toUpperCase()} · {formatBytes(af.fileSizeBytes)}
                          {af.pageCount ? ` · ${af.pageCount} trang` : ''}
                        </div>
                      </td>
                      <td className="px-3.5 py-2.5 text-[#203247]">
                        <div>{FILE_ROLE_LABELS[af.assignedRole]}</div>
                        <div className="text-[11px] text-[#65758B] tabular-nums">
                          Tin cậy phân loại: {af.roleConfidence}%
                        </div>
                      </td>
                      <td className="px-3.5 py-2.5">
                        {af.status === 'completed' ? (
                          <span className="font-semibold text-[#2D6A23]">Hoàn tất</span>
                        ) : af.status === 'error' ? (
                          <div className="space-y-0.5">
                            <span className="font-semibold text-[#A92F2A]">
                              Lỗi{af.errorStep ? ` (${af.errorStep})` : ''}
                            </span>
                            {af.errorMessage && (
                              <div className="text-[11px] text-[#A92F2A]">{af.errorMessage}</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-[#65758B]">{af.status}</span>
                        )}
                      </td>
                      <td className="px-3.5 py-2.5 text-right tabular-nums font-semibold text-[#123B68]">
                        {af.extractedCount}
                      </td>
                      <td className="px-3.5 py-2.5 text-right tabular-nums font-semibold text-[#2D6A23]">
                        {af.matchedAnswerCount}
                      </td>
                      <td className="px-3.5 py-2.5 text-right">
                        {af.status === 'error' ? (
                          <button
                            type="button"
                            disabled={retryingFileKey !== null}
                            onClick={() => void handleRetryFailedFile(af.fileName)}
                            className="inline-flex items-center gap-1 rounded-md border border-[#2878B8]/40 bg-[#EAF3FA] px-2.5 py-1 text-[11px] font-semibold text-[#123B68] hover:bg-[#dcecf8] whitespace-nowrap shrink-0"
                          >
                            {retryingFileKey && retryingFileKey.includes(af.fileName) ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3 w-3" />
                            )}
                            <span>Thử lại tệp lỗi</span>
                          </button>
                        ) : (
                          <span className="text-[#65758B]">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {documentAnalysis?.pairedSets && documentAnalysis.pairedSets.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3.5 space-y-2">
              <div className="text-xs font-bold text-[#123B68]">
                Ghép cặp đề – đáp án thông minh ({documentAnalysis.pairedSets.length} cặp):
              </div>
              <div className="space-y-1.5">
                {documentAnalysis.pairedSets.map((pair, pIdx) => (
                  <div
                    key={`${pair.questionFile}-${pIdx}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs"
                  >
                    <div className="text-[#203247]">
                      <strong className="text-[#123B68]">{pair.questionFile}</strong>
                      <span className="mx-1.5 text-[#65758B]">→</span>
                      <span className="font-medium text-[#2D6A23]">
                        {pair.answerFiles.join(', ')}
                      </span>
                    </div>
                    <span className="text-[11px] text-[#65758B]">{pair.matchBasis}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {agentSummary && agentSummary.executedSteps.length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {agentSummary.executedSteps.map((st) => (
                <div
                  key={st.stepNumber}
                  className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-2.5 text-xs space-y-0.5"
                >
                  <div className="flex items-center justify-between gap-1 font-bold text-[#123B68] tabular-nums">
                    <span>
                      Bước {st.stepNumber}: {st.title}
                    </span>
                    <span
                      className={
                        st.status === 'completed'
                          ? 'text-[#2D6A23]'
                          : st.status === 'partial'
                          ? 'text-[#9A520B]'
                          : st.status === 'failed'
                          ? 'text-[#A92F2A]'
                          : 'text-[#65758B]'
                      }
                    >
                      {st.status === 'completed'
                        ? 'Xong'
                        : st.status === 'partial'
                        ? 'Một phần'
                        : st.status === 'failed'
                        ? 'Lỗi'
                        : 'Bỏ qua'}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#65758B] leading-snug">{st.detail}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Composite Document Topic/Lesson Analysis Summary */}
      {documentAnalysis &&
        (documentAnalysis.detectedTopics.length > 0 ||
          documentAnalysis.detectedLessons.length > 0) && (
          <section className="rounded-xl border border-[#7954A1]/35 bg-white p-5 sm:p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-[#7954A1]" />
              <h3 className="font-display text-base font-bold text-[#123B68]">
                Cấu trúc Chủ đề &amp; Bài học phát hiện trong tài liệu
              </h3>
            </div>
            {documentAnalysis.documentSummary && (
              <p className="text-xs sm:text-sm leading-relaxed text-[#203247] bg-[#F4EFF8]/50 rounded-lg border border-[#7954A1]/20 p-3.5">
                {documentAnalysis.documentSummary}
              </p>
            )}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <div className="text-xs font-bold text-[#123B68] mb-1.5 tabular-nums">
                  Chủ đề phát hiện ({documentAnalysis.detectedTopics.length}):
                </div>
                <ul className="list-disc pl-5 space-y-1 text-xs text-[#203247]">
                  {documentAnalysis.detectedTopics.map((t, idx) => (
                    <li key={idx}>{t}</li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="text-xs font-bold text-[#123B68] mb-1.5 tabular-nums">
                  Bài học / Đơn vị kiến thức ({documentAnalysis.detectedLessons.length}):
                </div>
                <ul className="list-disc pl-5 space-y-1 text-xs text-[#203247]">
                  {documentAnalysis.detectedLessons.map((l, idx) => (
                    <li key={idx}>{l}</li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        )}

      {matchingPriorImport && parsedDoc && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-[#F28C28]/50 bg-[#FEF6EC] p-4 text-xs leading-relaxed text-[#9A520B]"
        >
          <ShieldAlert className="h-5 w-5 shrink-0 text-[#F28C28]" />
          <div className="space-y-1">
            <p className="font-bold text-sm">
              Cảnh báo chống nhập trùng tài liệu (SHA-256 trùng khớp)
            </p>
            <p>
              Tệp <strong>{parsedDoc.fileName}</strong> có nội dung giống hệt tài liệu{' '}
              <strong>{matchingPriorImport.fileName}</strong> đã được nhập trước đó. Các câu hỏi đã tồn tại trong ngân hàng được tự động tách vào khu vực Trùng lặp.
            </p>
          </div>
        </div>
      )}

      {parsedDoc && parsedDoc.warnings.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-bold text-[#123B68]">
            <AlertTriangle className="h-4 w-4 text-[#F28C28]" />
            <span>Lưu ý từ trình xử lý ({parsedDoc.fileName})</span>
          </div>
          <ul className="list-disc pl-5 space-y-1 text-xs text-[#65758B]">
            {parsedDoc.warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Step 2: Review Dashboard, Excel Export & 4-Status Question Tables */}
      {parsedDoc && questions.length > 0 && (
        <div className="space-y-6">
          <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-base font-bold text-[#123B68]">
                  2. Màn hình kiểm tra, đối chiếu &amp; phê duyệt câu hỏi ({parsedDoc.fileName})
                </h3>
                <p className="text-xs text-[#65758B] mt-0.5 tabular-nums">
                  {stats.mcqCount} Trắc nghiệm · {stats.tfCount} Đúng/Sai · {stats.essayCount} Tự luận
                  {stats.averageConfidence > 0
                    ? ` · Độ tin cậy trung bình ${stats.averageConfidence}%`
                    : ''}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={exportingExcel}
                  onClick={() => void handleExportExcel()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#55A747]/45 bg-[#EEF7EC] px-3 py-2 text-xs font-semibold text-[#2D6A23] hover:bg-[#dfefd9] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  {exportingExcel ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  <span>Xuất báo cáo Excel (.xlsx)</span>
                </button>
                <button
                  type="button"
                  disabled={savingDraft || saveSuccess !== null}
                  onClick={() => void handleSaveDraftManual()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#2878B8]/40 bg-[#EAF3FA] px-3 py-2 text-xs font-semibold text-[#123B68] hover:bg-[#dcecf8] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  {savingDraft ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  <span>Lưu bản nháp</span>
                </button>
                <button
                  type="button"
                  onClick={handleResetAllToPending}
                  disabled={saveSuccess !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-[#203247] hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Đặt lại trạng thái</span>
                </button>
              </div>
            </div>

            {/* 7 Clean Metric Cards */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3">
                <div className="text-[11px] font-medium text-[#65758B]">Tổng số câu</div>
                <div className="mt-1 text-lg font-extrabold tabular-nums text-[#123B68]">
                  {stats.total}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3">
                <div className="text-[11px] font-medium text-[#65758B]">Xác định từ nguồn</div>
                <div className="mt-1 text-lg font-extrabold tabular-nums text-[#2D6A23]">
                  {stats.verifiedCount}
                </div>
              </div>
              <div className="rounded-lg border border-[#7954A1]/35 bg-[#F4EFF8]/70 p-3">
                <div className="text-[11px] font-medium text-[#5B3C7D]">AI đề xuất</div>
                <div className="mt-1 text-lg font-extrabold tabular-nums text-[#5B3C7D]">
                  {stats.aiProposedCount}
                </div>
              </div>
              <div className="rounded-lg border border-[#2878B8]/35 bg-[#EAF3FA]/60 p-3">
                <div className="text-[11px] font-medium text-[#123B68]">Cần kiểm tra</div>
                <div className="mt-1 text-lg font-extrabold tabular-nums text-[#123B68]">
                  {stats.needsReviewCount}
                </div>
              </div>
              <div className="rounded-lg border border-[#F28C28]/40 bg-[#FEF6EC]/60 p-3">
                <div className="text-[11px] font-medium text-[#9A520B]">Thiếu đáp án</div>
                <div className="mt-1 text-lg font-extrabold tabular-nums text-[#9A520B]">
                  {stats.missingCount}
                </div>
              </div>
              <div className="rounded-lg border border-[#D94B45]/35 bg-[#FDF1F0]/70 p-3">
                <div className="text-[11px] font-medium text-[#A92F2A]">Xung đột / Trùng</div>
                <div className="mt-1 text-lg font-extrabold tabular-nums text-[#A92F2A]">
                  {stats.ambiguousCount + stats.duplicateCount}
                </div>
              </div>
              <div className="rounded-lg border border-[#55A747]/40 bg-[#EEF7EC]/75 p-3">
                <div className="text-[11px] font-semibold text-[#2D6A23]">Đã duyệt chờ lưu</div>
                <div className="mt-1 text-lg font-extrabold tabular-nums text-[#2D6A23]">
                  {stats.approvedCount}
                </div>
              </div>
            </div>

            {/* Exception-First Bulk Actions */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-slate-200 pt-3">
              <div className="text-xs text-[#65758B]">
                Quy trình kiểm duyệt ngoại lệ: Duyệt nhanh các câu đã xác định từ nguồn, sau đó xử lý các câu ngoại lệ bên dưới.
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleApproveAllVerifiedFromSource}
                  disabled={saveSuccess !== null || validQuestions.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#2D6A23] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#23521b] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <FileCheck2 className="h-3.5 w-3.5" />
                  <span>Duyệt tất cả câu đã xác định từ nguồn ({validQuestions.length})</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleContinueIncompleteWithAgent()}
                  disabled={
                    runningResumeAgent ||
                    saveSuccess !== null ||
                    stats.needsReviewCount + stats.missingCount + stats.ambiguousCount === 0
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#7954A1]/45 bg-[#F4EFF8] px-3.5 py-2 text-xs font-semibold text-[#5B3C7D] hover:bg-[#ebe0f5] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  {runningResumeAgent ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Bot className="h-3.5 w-3.5" />
                  )}
                  <span>AI Agent tiếp tục xử lý các câu chưa hoàn thành</span>
                </button>
              </div>
            </div>
          </section>

          {/* SECTION 2A: Exception Queue — Bulk AI Agent Resolution, * Marking, Non-Destructive Skip/Restore */}
          {issueQuestions.length > 0 && (
            <section className="rounded-xl border border-[#F28C28]/50 bg-white overflow-hidden">
              <div className="border-b border-[#F28C28]/30 bg-[#FEF6EC] px-5 py-4 space-y-3.5">
                <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="h-5 w-5 text-[#F28C28] shrink-0 mt-0.5" />
                    <div>
                      <h4 className="font-display text-sm sm:text-base font-bold text-[#9A520B] tabular-nums">
                        Khu vực Ngoại lệ cần xử lý ({activeIssueQuestions.length} đang chờ
                        {skippedIssueQuestions.length > 0
                          ? ` · ${skippedIssueQuestions.length} đã bỏ qua`
                          : ''}
                        )
                      </h4>
                      <p className="text-xs text-[#7D4208] mt-0.5 leading-relaxed">
                        AI Agent xử lý hàng loạt theo lô 8 câu: tìm trong tài liệu gốc, file đáp án, ngân hàng hiện có trước khi suy luận chuyên môn. Mọi đáp án AI suy luận được gắn nhãn <strong>* AI đề xuất</strong> mà <strong>không sửa văn bản câu hỏi gốc</strong>.
                      </p>
                    </div>
                  </div>
                </div>

                {/* 3 Primary Bulk Action Buttons */}
                {saveSuccess === null && (
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <button
                      type="button"
                      disabled={batchResolving || runningResumeAgent || activeIssueQuestions.length === 0}
                      onClick={() => void handleBatchAiResolveExceptions()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#123B68] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#2878B8] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                    >
                      {batchResolving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      <span>
                        {batchResolving
                          ? `Đang xử lý (${batchProgress?.processed ?? 0}/${batchProgress?.total ?? 0})...`
                          : selectedIssueIds.size > 0
                          ? `AI tự tìm và bổ sung đáp án (${selectedIssueIds.size} câu đã chọn)`
                          : `AI tự tìm và bổ sung đáp án (${activeIssueQuestions.length} câu)`}
                      </span>
                    </button>

                    <button
                      type="button"
                      disabled={batchResolving || activeIssueQuestions.length === 0}
                      onClick={handleMarkAiProposedWithStar}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[#7954A1]/45 bg-[#F4EFF8] px-3.5 py-2 text-xs font-semibold text-[#5B3C7D] hover:bg-[#eae0f4] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Bot className="h-3.5 w-3.5" />
                      <span>Đánh dấu * câu hỏi AI đề xuất</span>
                    </button>

                    <button
                      type="button"
                      disabled={
                        batchResolving ||
                        (issueFilter === 'skipped'
                          ? activeIssueQuestions.length === 0
                          : filteredIssueQuestions.length === 0)
                      }
                      onClick={handleSkipAllVisibleExceptions}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[#D94B45]/40 bg-white px-3.5 py-2 text-xs font-semibold text-[#A92F2A] hover:bg-[#FDF1F0] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                    >
                      <ArchiveX className="h-3.5 w-3.5" />
                      <span>
                        {selectedIssueIds.size > 0
                          ? `Loại bỏ ${selectedIssueIds.size} câu khỏi đợt nhập`
                          : 'Loại bỏ tất cả khỏi đợt nhập'}
                      </span>
                    </button>
                  </div>
                )}

                {/* Contextual Bulk Actions: High-Confidence 1-Click Accept, Selected Confirm, Retry Failed, Restore Skipped */}
                {saveSuccess === null &&
                  (highConfidenceAiProposals.length > 0 ||
                    failedBatchTempIds.length > 0 ||
                    skippedIssueQuestions.length > 0 ||
                    selectedIssueIds.size > 0) && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-[#F28C28]/25 pt-3">
                      {highConfidenceAiProposals.length > 0 && (
                        <button
                          type="button"
                          disabled={batchResolving}
                          onClick={handleAcceptAllHighConfidenceAi}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-[#2D6A23] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#23521b] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 tabular-nums"
                        >
                          <CheckCheck className="h-3.5 w-3.5" />
                          <span>
                            Chấp nhận tất cả đáp án AI có độ tin cậy cao (≥
                            {HIGH_CONFIDENCE_AI_THRESHOLD}%) ({highConfidenceAiProposals.length})
                          </span>
                        </button>
                      )}

                      {selectedIssueIds.size > 0 &&
                        issueQuestions.some(
                          (q) =>
                            selectedIssueIds.has(q.tempId) &&
                            !q.skippedInImport &&
                            !isQuestionInvalidOrDuplicate(q) &&
                            (q.answerStatus === 'ai_proposed' ||
                              Boolean(q.aiSuggestion && !q.aiSuggestion.applied))
                        ) && (
                          <button
                            type="button"
                            disabled={batchResolving}
                            onClick={handleBatchConfirmAiProposals}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-[#5B3C7D] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#472e63] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>Chấp nhận đề xuất AI đã chọn</span>
                          </button>
                        )}

                      {selectedIssueIds.size > 0 && (
                        <button
                          type="button"
                          disabled={batchResolving || runningResumeAgent}
                          onClick={() => void handleRematchSelectedIssues()}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[#123B68]/30 bg-white px-3 py-1.5 text-xs font-semibold text-[#123B68] hover:bg-[#EAF3FA] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          <span>Đối chiếu lại từ nguồn ({selectedIssueIds.size})</span>
                        </button>
                      )}

                      {failedBatchTempIds.length > 0 && (
                        <button
                          type="button"
                          disabled={batchResolving}
                          onClick={() => void handleBatchAiResolveExceptions(failedBatchTempIds)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[#D94B45]/45 bg-[#FDF1F0] px-3 py-1.5 text-xs font-semibold text-[#A92F2A] hover:bg-[#fbe3e1] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 tabular-nums"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span>Thử lại các câu thất bại ({failedBatchTempIds.length})</span>
                        </button>
                      )}

                      {skippedIssueQuestions.length > 0 && (
                        <button
                          type="button"
                          disabled={batchResolving}
                          onClick={() => handleRestoreSkippedQuestions()}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#203247] hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 tabular-nums"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span>
                            Khôi phục tất cả câu đã bỏ qua ({skippedIssueQuestions.length})
                          </span>
                        </button>
                      )}
                    </div>
                  )}

                {/* Live Batch Progress Bar */}
                {batchResolving && batchProgress && (
                  <div className="rounded-lg border border-[#2878B8]/35 bg-white p-3.5 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2 font-semibold text-[#123B68] tabular-nums">
                        <Loader2 className="h-4 w-4 animate-spin text-[#2878B8]" />
                        <span>
                          AI Agent đang xử lý lô {batchProgress.currentBatch}/{batchProgress.totalBatches} · Đã xong{' '}
                          {batchProgress.processed}/{batchProgress.total} câu
                        </span>
                      </div>
                      <span className="font-bold text-[#2878B8] tabular-nums">
                        {batchProgress.total > 0
                          ? Math.round((batchProgress.processed / batchProgress.total) * 100)
                          : 0}
                        %
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                      <div
                        className="h-full rounded-full bg-[#2878B8] transition-all duration-300"
                        style={{
                          width: `${
                            batchProgress.total > 0
                              ? Math.min(100, Math.round((batchProgress.processed / batchProgress.total) * 100))
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#65758B] tabular-nums">
                      <span className="text-[#2D6A23] font-medium">
                        Trong nguồn: {batchProgress.foundInSource}
                      </span>
                      <span className="text-[#5B3C7D] font-medium">
                        AI đề xuất (*): {batchProgress.aiProposed}
                      </span>
                      <span className="text-[#123B68] font-medium">
                        Cần kiểm tra: {batchProgress.needsReview}
                      </span>
                      <span className="text-[#9A520B] font-medium">
                        Không đủ căn cứ: {batchProgress.notFound}
                      </span>
                      {batchProgress.failed > 0 && (
                        <span className="text-[#A92F2A] font-medium">
                          Lỗi: {batchProgress.failed}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Post-Batch Summary Banner */}
                {!batchResolving && lastBatchReport && (
                  <div
                    role="status"
                    className={`rounded-lg border px-3.5 py-2.5 text-xs space-y-1.5 ${
                      lastBatchReport.aiUnavailable || lastBatchReport.failed > 0
                        ? 'border-[#F28C28]/45 bg-white text-[#203247]'
                        : 'border-[#55A747]/40 bg-[#EEF7EC]/80 text-[#203247]'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-bold text-[#123B68] tabular-nums">
                        Kết quả phân loại tự động ({lastBatchReport.totalRequested} câu đã chạy):
                      </span>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold tabular-nums">
                        <span className="text-[#2D6A23]">
                          Tìm thấy trong nguồn: {lastBatchReport.foundInSource}
                        </span>
                        <span className="text-[#5B3C7D]">
                          AI đề xuất (*): {lastBatchReport.aiProposed}
                        </span>
                        <span className="text-[#123B68]">
                          Cần kiểm tra thêm: {lastBatchReport.needsReview}
                        </span>
                        <span className="text-[#9A520B]">
                          Không tìm được đáp án: {lastBatchReport.notFound}
                        </span>
                        {lastBatchReport.invalidOrDuplicate > 0 && (
                          <span className="text-[#A92F2A]">
                            Không hợp lệ / Trùng: {lastBatchReport.invalidOrDuplicate}
                          </span>
                        )}
                        {lastBatchReport.failed > 0 && (
                          <span className="text-[#A92F2A]">
                            Thất bại: {lastBatchReport.failed}
                          </span>
                        )}
                      </div>
                    </div>
                    {lastBatchReport.aiErrorMessage && (
                      <div className="text-[11px] text-[#A92F2A] leading-snug">
                        Lưu ý hệ thống AI: {lastBatchReport.aiErrorMessage}
                      </div>
                    )}
                  </div>
                )}

                {/* 6-Group Classification Tabs */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      { id: 'all', label: `Cần xử lý (${issueCategoryCounts.activeAll})` },
                      {
                        id: 'ai_proposed',
                        label: `AI đề xuất (*) (${issueCategoryCounts.aiProposed})`,
                      },
                      {
                        id: 'needs_review',
                        label: `Cần kiểm tra thêm (${issueCategoryCounts.needsReview})`,
                      },
                      {
                        id: 'missing',
                        label: `Không tìm được đáp án (${issueCategoryCounts.notFound})`,
                      },
                      {
                        id: 'invalid_or_duplicate',
                        label: `Không hợp lệ / Trùng (${issueCategoryCounts.invalidOrDup})`,
                      },
                      {
                        id: 'skipped',
                        label: `Bỏ qua trong đợt nhập (${issueCategoryCounts.skipped})`,
                      },
                    ] as { id: IssueFilter; label: string }[]
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setIssueFilter(tab.id)}
                      className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                        issueFilter === tab.id
                          ? tab.id === 'ai_proposed'
                            ? 'bg-[#5B3C7D] text-white'
                            : tab.id === 'skipped'
                            ? 'bg-slate-700 text-white'
                            : 'bg-[#9A520B] text-white'
                          : 'border border-[#F28C28]/35 bg-white text-[#7D4208] hover:bg-[#FEF6EC]'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              {filteredIssueQuestions.length === 0 ? (
                <div className="p-6 text-center text-xs text-[#65758B]">
                  {issueFilter === 'skipped'
                    ? 'Chưa có câu hỏi nào ở trạng thái "Bỏ qua trong đợt nhập".'
                    : activeIssueQuestions.length === 0
                    ? 'Tất cả câu ngoại lệ đã được xử lý hoặc chuyển sang "Bỏ qua trong đợt nhập". Bạn có thể hoàn tất lưu các câu hợp lệ ở khu vực bên dưới.'
                    : 'Không có câu hỏi nào trong nhóm phân loại này.'}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-slate-200 bg-[#F8FAFC] text-xs font-semibold text-[#65758B]">
                      <tr>
                        <th className="px-3 py-3 w-10 text-center">
                          <input
                            type="checkbox"
                            aria-label="Chọn tất cả câu ngoại lệ đang hiển thị"
                            checked={
                              filteredIssueQuestions.length > 0 &&
                              filteredIssueQuestions.every((q) => selectedIssueIds.has(q.tempId))
                            }
                            onChange={handleToggleSelectAllVisibleIssues}
                          />
                        </th>
                        <th className="px-4 py-3 w-48">Câu, Mã &amp; Nguồn</th>
                        <th className="px-4 py-3">Nội dung gốc &amp; Đề xuất AI Agent</th>
                        <th className="px-4 py-3 w-64">Phân loại &amp; Độ tin cậy</th>
                        <th className="px-4 py-3 w-44 text-right">Xử lý</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {filteredIssueQuestions.map((q) => {
                        const isDup = q.duplicateInFile || q.duplicateInBank
                        const isSkipped = Boolean(q.skippedInImport)
                        const isStarred = isQuestionStarredAi(q)
                        const structuralError = validateQuestionForBlueprint({
                          ...q,
                          answerKey: q.answerKey ?? 'A',
                          statementAnswerA: q.statementAnswerA ?? true,
                          statementAnswerB: q.statementAnswerB ?? true,
                          statementAnswerC: q.statementAnswerC ?? true,
                          statementAnswerD: q.statementAnswerD ?? true,
                          rubric: q.rubric || 'placeholder',
                        })
                        const wasEditedFromOriginal =
                          Boolean(q.originalQuestionText) && q.originalQuestionText !== q.questionText
                        const sourceType = q.aiSourceType ?? q.aiSuggestion?.sourceType

                        return (
                          <tr
                            key={q.tempId}
                            className={`align-top ${
                              isSkipped
                                ? 'bg-slate-50/90 opacity-85'
                                : q.answerStatus === 'ai_proposed' && !isDup
                                ? 'bg-[#F4EFF8]/35'
                                : 'bg-[#FEF6EC]/15'
                            }`}
                          >
                            <td className="px-3 py-3.5 text-center">
                              <input
                                type="checkbox"
                                aria-label={`Chọn ngoại lệ ${q.questionNumber}`}
                                checked={selectedIssueIds.has(q.tempId)}
                                onChange={() => handleToggleSelectIssue(q.tempId)}
                              />
                            </td>
                            <td className="px-4 py-3.5 space-y-1.5">
                              <div className="flex flex-wrap items-center gap-1.5 font-bold text-xs text-[#123B68] tabular-nums">
                                <span>{q.questionNumber}</span>
                                {isStarred && !isSkipped && (
                                  <span
                                    className="inline-block rounded border border-[#7954A1]/45 bg-[#F4EFF8] px-1.5 py-0.5 text-[10px] font-bold text-[#5B3C7D]"
                                    title="Đáp án do AI đề xuất (không sửa văn bản câu hỏi gốc)"
                                  >
                                    * AI đề xuất
                                  </span>
                                )}
                                {q.questionCode && (
                                  <span className="font-mono text-[11px] text-[#2878B8]">
                                    [{q.questionCode}]
                                  </span>
                                )}
                                {q.pageNumber !== null && (
                                  <span className="font-normal text-[#65758B]">
                                    · Tr.{q.pageNumber}
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] font-semibold text-[#2878B8]">
                                {TYPE_LABELS[q.questionType]}
                              </div>
                              {q.lessonTitle && (
                                <div className="text-[11px] text-[#203247] leading-snug">
                                  {q.lessonTitle}
                                </div>
                              )}
                              <div
                                className="text-[11px] text-[#65758B] truncate max-w-[175px]"
                                title={q.sourceDocumentName}
                              >
                                {q.sourceDocumentName}
                              </div>
                            </td>

                            <td className="px-4 py-3.5 space-y-2">
                              <p className="text-sm font-medium text-[#203247] leading-relaxed">
                                {q.questionText}
                              </p>
                              {wasEditedFromOriginal && (
                                <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] text-[#65758B]">
                                  <strong>Văn bản gốc ban đầu:</strong> {q.originalQuestionText}
                                </div>
                              )}

                              {q.questionType === 'multiple_choice' && (
                                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 text-xs text-[#65758B]">
                                  <div className={q.answerKey === 'A' ? 'font-semibold text-[#5B3C7D]' : ''}>
                                    A. {q.optionA}
                                  </div>
                                  <div className={q.answerKey === 'B' ? 'font-semibold text-[#5B3C7D]' : ''}>
                                    B. {q.optionB}
                                  </div>
                                  <div className={q.answerKey === 'C' ? 'font-semibold text-[#5B3C7D]' : ''}>
                                    C. {q.optionC}
                                  </div>
                                  <div className={q.answerKey === 'D' ? 'font-semibold text-[#5B3C7D]' : ''}>
                                    D. {q.optionD}
                                  </div>
                                </div>
                              )}
                              {q.questionType === 'true_false' && (
                                <div className="space-y-1 text-xs text-[#65758B]">
                                  <div>
                                    a) {q.statementA} ({q.statementAnswerA === null ? '?' : q.statementAnswerA ? 'Đúng' : 'Sai'})
                                  </div>
                                  <div>
                                    b) {q.statementB} ({q.statementAnswerB === null ? '?' : q.statementAnswerB ? 'Đúng' : 'Sai'})
                                  </div>
                                  <div>
                                    c) {q.statementC} ({q.statementAnswerC === null ? '?' : q.statementAnswerC ? 'Đúng' : 'Sai'})
                                  </div>
                                  <div>
                                    d) {q.statementD} ({q.statementAnswerD === null ? '?' : q.statementAnswerD ? 'Đúng' : 'Sai'})
                                  </div>
                                </div>
                              )}
                              {q.questionType === 'essay' && q.rubric && (
                                <div className="rounded-md border border-slate-200 bg-[#F8FAFC] px-2.5 py-1.5 text-xs text-[#203247]">
                                  <strong>Rubric đề xuất:</strong> {q.rubric}
                                </div>
                              )}

                              {/* Inline Batch Error if this item failed */}
                              {q.aiBatchError && !isSkipped && (
                                <div className="rounded-md border border-[#D94B45]/40 bg-[#FDF1F0] px-2.5 py-1.5 text-[11px] text-[#A92F2A]">
                                  <strong>Lỗi xử lý lô:</strong> {q.aiBatchError}
                                </div>
                              )}

                              {/* AI Agent Suggestion Card */}
                              {q.aiSuggestion && !q.aiSuggestion.applied && !isSkipped && (
                                <div className="rounded-lg border border-[#7954A1]/35 bg-[#F4EFF8]/65 p-3 text-xs space-y-1.5">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="font-bold text-[#5B3C7D] flex items-center gap-1.5 tabular-nums">
                                      <Sparkles className="h-3.5 w-3.5" />
                                      <span>
                                        * Đề xuất AI Agent ({q.aiSuggestion.confidenceScore}%)
                                      </span>
                                    </div>
                                    {!isDup && saveSuccess === null && (
                                      <button
                                        type="button"
                                        onClick={() => handleConfirmAiProposal(q.tempId)}
                                        className="inline-flex items-center gap-1 rounded-md bg-[#5B3C7D] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#472e63] whitespace-nowrap shrink-0"
                                      >
                                        <Check className="h-3 w-3" />
                                        <span>Chấp nhận đáp án (*)</span>
                                      </button>
                                    )}
                                  </div>
                                  <div className="text-[#203247] leading-snug space-y-1">
                                    {q.questionType === 'multiple_choice' && q.aiSuggestion.suggestedAnswerKey && (
                                      <div>
                                        <strong>Đáp án gợi ý:</strong> Phương án{' '}
                                        <span className="font-bold text-[#5B3C7D]">
                                          {q.aiSuggestion.suggestedAnswerKey}
                                        </span>
                                      </div>
                                    )}
                                    {q.questionType === 'true_false' && (
                                      <div>
                                        <strong>Đáp án 4 ý gợi ý:</strong>{' '}
                                        <span className="font-bold text-[#5B3C7D] tabular-nums">
                                          {`${q.aiSuggestion.suggestedStatementA === null ? '?' : q.aiSuggestion.suggestedStatementA ? 'Đ' : 'S'}-${q.aiSuggestion.suggestedStatementB === null ? '?' : q.aiSuggestion.suggestedStatementB ? 'Đ' : 'S'}-${q.aiSuggestion.suggestedStatementC === null ? '?' : q.aiSuggestion.suggestedStatementC ? 'Đ' : 'S'}-${q.aiSuggestion.suggestedStatementD === null ? '?' : q.aiSuggestion.suggestedStatementD ? 'Đ' : 'S'}`}
                                        </span>
                                      </div>
                                    )}
                                    {q.questionType === 'essay' && q.aiSuggestion.suggestedRubric && (
                                      <div>
                                        <strong>Rubric gợi ý:</strong> {q.aiSuggestion.suggestedRubric}
                                      </div>
                                    )}
                                    {q.aiSuggestion.suggestedExplanation && (
                                      <div className="text-[#203247]">
                                        <strong>Giải thích:</strong> {q.aiSuggestion.suggestedExplanation}
                                      </div>
                                    )}
                                    <div className="text-[#65758B]">
                                      <strong>Nguồn tham chiếu:</strong>{' '}
                                      {q.aiSuggestion.sourceReference ||
                                        q.aiSuggestion.sourceFileName ||
                                        (sourceType ? AI_SOURCE_TYPE_LABELS[sourceType] : 'Kiến thức chuyên môn')}
                                    </div>
                                    {q.aiSuggestion.reasoning && (
                                      <div className="text-[#65758B]">
                                        <strong>Căn cứ:</strong> {q.aiSuggestion.reasoning}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </td>

                            <td className="px-4 py-3.5 space-y-1.5">
                              {isSkipped ? (
                                <span className="inline-block rounded-md border border-slate-300 bg-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-700">
                                  Bỏ qua trong đợt nhập
                                </span>
                              ) : isDup ? (
                                <span className="inline-block rounded-md border border-[#D94B45]/40 bg-[#FDF1F0] px-2 py-0.5 text-[11px] font-bold text-[#A92F2A]">
                                  {q.duplicateInBank ? 'Trùng trong Ngân hàng' : 'Trùng trong bộ tệp'}
                                </span>
                              ) : structuralError ? (
                                <span className="inline-block rounded-md border border-[#D94B45]/40 bg-[#FDF1F0] px-2 py-0.5 text-[11px] font-bold text-[#A92F2A]">
                                  Không hợp lệ cấu trúc
                                </span>
                              ) : q.answerStatus === 'ai_proposed' ? (
                                <span className="inline-block rounded-md border border-[#7954A1]/40 bg-[#F4EFF8] px-2 py-0.5 text-[11px] font-bold text-[#5B3C7D]">
                                  * AI đề xuất đáp án
                                </span>
                              ) : q.answerStatus === 'ambiguous' ? (
                                <span className="inline-block rounded-md border border-[#D94B45]/40 bg-[#FDF1F0] px-2 py-0.5 text-[11px] font-bold text-[#A92F2A]">
                                  {ANSWER_STATUS_LABELS.ambiguous}
                                </span>
                              ) : q.answerStatus === 'needs_review' ? (
                                <span className="inline-block rounded-md border border-[#2878B8]/40 bg-[#EAF3FA] px-2 py-0.5 text-[11px] font-bold text-[#123B68]">
                                  {ANSWER_STATUS_LABELS.needs_review}
                                </span>
                              ) : (
                                <span className="inline-block rounded-md border border-[#F28C28]/45 bg-[#FEF6EC] px-2 py-0.5 text-[11px] font-bold text-[#9A520B]">
                                  {ANSWER_STATUS_LABELS.missing}
                                </span>
                              )}

                              {sourceType && !isSkipped && (
                                <div className="text-[11px] font-semibold text-[#5B3C7D]">
                                  {AI_SOURCE_TYPE_LABELS[sourceType]}
                                </div>
                              )}

                              {typeof q.confidenceScore === 'number' && !isSkipped && (
                                <div className="text-[11px] font-semibold text-[#123B68] tabular-nums">
                                  Độ tin cậy: {q.confidenceScore}%
                                  {q.matchMethod ? ` · ${MATCH_METHOD_LABELS[q.matchMethod]}` : ''}
                                </div>
                              )}

                              {q.answerSource && (
                                <div className="text-[11px] font-medium text-[#203247] leading-snug">
                                  Nguồn: {q.answerSource}
                                </div>
                              )}

                              {(q.aiProcessedAt || q.skippedAt) && (
                                <div className="text-[10px] text-[#65758B] tabular-nums">
                                  {isSkipped && q.skippedAt
                                    ? `Bỏ qua lúc: ${formatDateVi(q.skippedAt)}`
                                    : q.aiProcessedAt
                                    ? `AI xử lý: ${formatDateVi(q.aiProcessedAt)}`
                                    : ''}
                                </div>
                              )}

                              <div className="text-[11px] text-[#65758B] leading-snug">
                                {structuralError || q.answerNote}
                              </div>
                            </td>

                            <td className="px-4 py-3.5 text-right space-y-1.5">
                              <div className="flex flex-col items-end gap-1.5">
                                {isSkipped ? (
                                  saveSuccess === null && (
                                    <button
                                      type="button"
                                      onClick={() => handleRestoreSkippedQuestions([q.tempId])}
                                      className="inline-flex items-center gap-1 rounded-md border border-[#2878B8]/45 bg-[#EAF3FA] px-2.5 py-1.5 text-xs font-semibold text-[#123B68] hover:bg-[#dcecf8] whitespace-nowrap shrink-0"
                                    >
                                      <RotateCcw className="h-3.5 w-3.5" />
                                      <span>Khôi phục để xử lý</span>
                                    </button>
                                  )
                                ) : (
                                  <>
                                    {!isDup &&
                                      !structuralError &&
                                      saveSuccess === null &&
                                      (q.answerStatus === 'ai_proposed' ||
                                        Boolean(q.aiSuggestion && !q.aiSuggestion.applied)) && (
                                        <button
                                          type="button"
                                          onClick={() => handleConfirmAiProposal(q.tempId)}
                                          className="inline-flex items-center gap-1 rounded-md bg-[#5B3C7D] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[#472e63] whitespace-nowrap shrink-0"
                                        >
                                          <Check className="h-3.5 w-3.5" />
                                          <span>Chấp nhận (*)</span>
                                        </button>
                                      )}
                                    {q.aiBatchError && saveSuccess === null && (
                                      <button
                                        type="button"
                                        disabled={batchResolving}
                                        onClick={() => void handleBatchAiResolveExceptions([q.tempId])}
                                        className="inline-flex items-center gap-1 rounded-md border border-[#D94B45]/45 bg-[#FDF1F0] px-2.5 py-1 text-xs font-semibold text-[#A92F2A] hover:bg-[#fbe3e1] whitespace-nowrap shrink-0"
                                      >
                                        <RotateCcw className="h-3 w-3" />
                                        <span>Thử lại câu này</span>
                                      </button>
                                    )}
                                    {saveSuccess === null && (
                                      <button
                                        type="button"
                                        onClick={() => setEditingQuestion(q)}
                                        className="inline-flex items-center gap-1 rounded-md border border-[#2878B8]/40 bg-[#EAF3FA] px-2.5 py-1.5 text-xs font-semibold text-[#123B68] hover:bg-[#dcecf8] whitespace-nowrap shrink-0"
                                      >
                                        <Edit3 className="h-3.5 w-3.5" />
                                        <span>Bổ sung / Sửa</span>
                                      </button>
                                    )}
                                    {saveSuccess === null && (
                                      <button
                                        type="button"
                                        onClick={() => handleSkipSingleException(q.tempId)}
                                        className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-[#65758B] hover:border-[#D94B45]/40 hover:bg-[#FDF1F0] hover:text-[#A92F2A] whitespace-nowrap shrink-0"
                                      >
                                        <ArchiveX className="h-3 w-3" />
                                        <span>Bỏ qua đợt này</span>
                                      </button>
                                    )}
                                  </>
                                )}
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
          )}

          {/* SECTION 2B: Valid Questions Ready for Approval */}
          <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 bg-[#F3F6FA] p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="font-display text-sm sm:text-base font-bold text-[#123B68] tabular-nums">
                    Câu hỏi đã xác định từ nguồn / đã xác nhận ({validQuestions.length} câu)
                  </h4>
                  <p className="text-xs text-[#65758B] mt-0.5">
                    Chỉ chứa các câu có đáp án hợp lệ từ tài liệu nguồn hoặc đề xuất AI đã được Super Admin xác nhận, không trùng lặp.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {selectedValidIds.size > 0 && saveSuccess === null && (
                    <button
                      type="button"
                      onClick={handleApproveSelectedValid}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#2878B8] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#123B68] transition-colors whitespace-nowrap shrink-0"
                    >
                      <Check className="h-3.5 w-3.5" />
                      <span>Duyệt {selectedValidIds.size} câu đã chọn</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleApproveAllValid}
                    disabled={saveSuccess !== null || validQuestions.length === 0}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#55A747]/45 bg-[#EEF7EC] px-3.5 py-2 text-xs font-semibold text-[#2D6A23] hover:bg-[#dfefd9] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    <FileCheck2 className="h-3.5 w-3.5" />
                    <span>Duyệt hàng loạt tất cả ({validQuestions.length})</span>
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  {(
                    [
                      { id: 'all', label: `Tất cả hợp lệ (${validQuestions.length})` },
                      {
                        id: 'pending',
                        label: `Chờ duyệt (${
                          validQuestions.filter((q) => q.reviewDecision === 'pending').length
                        })`,
                      },
                      {
                        id: 'approved',
                        label: `Đã duyệt (${
                          validQuestions.filter((q) => q.reviewDecision === 'approved').length
                        })`,
                      },
                      {
                        id: 'rejected',
                        label: `Đã từ chối (${
                          validQuestions.filter((q) => q.reviewDecision === 'rejected').length
                        })`,
                      },
                      {
                        id: 'ai_starred',
                        label: `AI đề xuất (*) (${stats.aiStarredValidCount})`,
                      },
                    ] as { id: ValidFilter; label: string }[]
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setValidFilter(tab.id)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                        validFilter === tab.id
                          ? tab.id === 'ai_starred'
                            ? 'bg-[#5B3C7D] text-white'
                            : 'bg-[#123B68] text-white'
                          : 'border border-slate-200 bg-white text-[#203247] hover:bg-slate-50'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value as QuestionType | 'all')}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-[#203247]"
                >
                  <option value="all">Tất cả dạng câu hỏi</option>
                  <option value="multiple_choice">Trắc nghiệm 4 lựa chọn</option>
                  <option value="true_false">Đúng / Sai 4 ý</option>
                  <option value="essay">Tự luận</option>
                </select>
              </div>
            </div>

            {filteredValidQuestions.length === 0 ? (
              <div className="p-8 text-center text-xs text-[#65758B]">
                {validQuestions.length === 0
                  ? 'Chưa có câu nào đủ điều kiện duyệt trong danh sách hợp lệ. Hãy kiểm tra hoặc áp dụng đề xuất ở khu vực phía trên.'
                  : 'Không có câu hỏi nào khớp với bộ lọc hiện tại.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-200 bg-[#F3F6FA] text-xs font-semibold text-[#65758B]">
                    <tr>
                      <th className="px-3 py-3 w-10 text-center">
                        <input
                          type="checkbox"
                          aria-label="Chọn tất cả câu hợp lệ đang hiển thị"
                          checked={
                            filteredValidQuestions.length > 0 &&
                            filteredValidQuestions.every((q) => selectedValidIds.has(q.tempId))
                          }
                          onChange={handleToggleSelectAllVisibleValid}
                        />
                      </th>
                      <th className="px-4 py-3 w-48">Câu, Mã &amp; Nguồn</th>
                      <th className="px-4 py-3">Nội dung câu hỏi &amp; Phương án / Rubric</th>
                      <th className="px-4 py-3 w-32">Mức độ</th>
                      <th className="px-4 py-3 w-64">Đáp án &amp; Độ tin cậy</th>
                      <th className="px-4 py-3 w-40 text-right">Phê duyệt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {filteredValidQuestions.map((q) => (
                      <tr
                        key={q.tempId}
                        className={`align-top ${
                          q.reviewDecision === 'approved'
                            ? 'bg-[#EEF7EC]/35'
                            : q.reviewDecision === 'rejected'
                            ? 'bg-slate-50/80 opacity-75'
                            : 'bg-white'
                        }`}
                      >
                        <td className="px-3 py-3.5 text-center">
                          <input
                            type="checkbox"
                            aria-label={`Chọn ${q.questionNumber}`}
                            checked={selectedValidIds.has(q.tempId)}
                            onChange={() => handleToggleSelectValid(q.tempId)}
                          />
                        </td>

                        <td className="px-4 py-3.5 space-y-1.5">
                          <div className="font-bold text-xs text-[#123B68] tabular-nums">
                            {q.questionNumber}
                            {q.questionCode && (
                              <span className="ml-1.5 font-mono text-[11px] text-[#2878B8]">
                                [{q.questionCode}]
                              </span>
                            )}
                            {q.pageNumber !== null && (
                              <span className="ml-1.5 font-normal text-[#65758B]">
                                · Trang {q.pageNumber}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] font-semibold text-[#2878B8]">
                            {TYPE_LABELS[q.questionType]}
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            <span
                              className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                                q.questionOrigin === 'ai_generated'
                                  ? 'border-[#7954A1]/30 bg-[#F4EFF8] text-[#5B3C7D]'
                                  : 'border-slate-200 bg-[#F8FAFC] text-[#203247]'
                              }`}
                            >
                              {q.questionOrigin === 'ai_generated'
                                ? 'AI Agent biên soạn'
                                : 'Trích xuất nguyên bản'}
                            </span>
                            {isQuestionStarredAi(q) && (
                              <span
                                className="inline-block rounded border border-[#7954A1]/45 bg-[#F4EFF8] px-1.5 py-0.5 text-[10px] font-bold text-[#5B3C7D]"
                                title="Đáp án do AI đề xuất (giữ nguyên văn bản câu hỏi gốc)"
                              >
                                * AI đề xuất
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-[#203247] leading-snug">
                            {q.lessonTitle || q.topic || 'Chưa gắn bài học'}
                          </div>
                          <div className="flex items-center gap-1 text-[11px] text-[#65758B]">
                            <FileText className="h-3 w-3 shrink-0" />
                            <span className="truncate max-w-[140px]" title={q.sourceDocumentName}>
                              {q.sourceDocumentName}
                            </span>
                          </div>
                        </td>

                        <td className="px-4 py-3.5 space-y-2">
                          <p className="text-sm font-medium text-[#203247] leading-relaxed">
                            {q.questionText}
                          </p>

                          {q.questionType === 'multiple_choice' && (
                            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 text-xs">
                              {(['A', 'B', 'C', 'D'] as AnswerOptionKey[]).map((letter) => {
                                const text =
                                  letter === 'A'
                                    ? q.optionA
                                    : letter === 'B'
                                    ? q.optionB
                                    : letter === 'C'
                                    ? q.optionC
                                    : q.optionD
                                const isSelected = q.answerKey === letter
                                return (
                                  <div
                                    key={letter}
                                    className={`rounded-md border px-2.5 py-1.5 ${
                                      isSelected
                                        ? 'border-[#55A747]/45 bg-[#EEF7EC] text-[#2D6A23] font-semibold'
                                        : 'border-slate-200 bg-white text-[#203247]'
                                    }`}
                                  >
                                    <span className="font-bold mr-1">{letter}.</span>
                                    <span>{text}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {q.questionType === 'true_false' && (
                            <div className="space-y-1.5 text-xs">
                              {(
                                [
                                  { letter: 'a', text: q.statementA, ans: q.statementAnswerA },
                                  { letter: 'b', text: q.statementB, ans: q.statementAnswerB },
                                  { letter: 'c', text: q.statementC, ans: q.statementAnswerC },
                                  { letter: 'd', text: q.statementD, ans: q.statementAnswerD },
                                ] as const
                              ).map((st) => (
                                <div
                                  key={st.letter}
                                  className="flex items-start justify-between gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5"
                                >
                                  <div>
                                    <span className="font-bold text-[#123B68] mr-1">
                                      {st.letter})
                                    </span>
                                    <span className="text-[#203247]">{st.text}</span>
                                  </div>
                                  <span
                                    className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold ${
                                      st.ans === true
                                        ? 'bg-[#EEF7EC] text-[#2D6A23]'
                                        : 'bg-[#FDF1F0] text-[#A92F2A]'
                                    }`}
                                  >
                                    {st.ans === true ? 'Đúng' : 'Sai'}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}

                          {q.questionType === 'essay' && (
                            <div className="rounded-lg border border-slate-200 bg-[#F3F6FA] p-2.5 text-xs space-y-1">
                              <div className="font-semibold text-[#123B68]">
                                Hướng dẫn chấm (Rubric):
                              </div>
                              <p className="text-[#203247] whitespace-pre-line">{q.rubric}</p>
                              {q.sampleAnswer && (
                                <p className="text-[#65758B] pt-1">
                                  <strong>Gợi ý đáp án:</strong> {q.sampleAnswer}
                                </p>
                              )}
                            </div>
                          )}

                          {q.explanation && (
                            <div className="rounded-md bg-[#F8FAFC] px-2.5 py-1.5 text-xs text-[#65758B] border border-slate-200/70">
                              <strong className="text-[#123B68]">Giải thích:</strong>{' '}
                              {q.explanation}
                            </div>
                          )}
                        </td>

                        <td className="px-4 py-3.5">
                          <span
                            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
                              COGNITIVE_STYLE[q.cognitiveLevel]
                            }`}
                          >
                            <Layers className="h-3 w-3" />
                            <span>{COGNITIVE_LABELS[q.cognitiveLevel]}</span>
                          </span>
                        </td>

                        <td className="px-4 py-3.5 space-y-1.5">
                          <div className="rounded-md border border-[#55A747]/35 bg-[#EEF7EC] px-2.5 py-2 text-xs text-[#2D6A23] space-y-1">
                            <div className="flex items-center justify-between gap-1">
                              <span className="font-bold">Đã nhận diện đáp án</span>
                              <span className="rounded bg-white px-1.5 py-0.5 text-[11px] font-extrabold text-[#2D6A23] border border-[#55A747]/30 tabular-nums">
                                {q.questionType === 'multiple_choice'
                                  ? q.answerKey
                                  : q.questionType === 'true_false'
                                  ? `${q.statementAnswerA ? 'Đ' : 'S'}-${q.statementAnswerB ? 'Đ' : 'S'}-${q.statementAnswerC ? 'Đ' : 'S'}-${q.statementAnswerD ? 'Đ' : 'S'}`
                                  : 'Rubric'}
                              </span>
                            </div>
                            {typeof q.confidenceScore === 'number' && (
                              <div className="text-[11px] font-semibold text-[#123B68] tabular-nums">
                                Độ tin cậy: {q.confidenceScore}%
                                {q.matchMethod ? ` · ${MATCH_METHOD_LABELS[q.matchMethod]}` : ''}
                              </div>
                            )}
                            {q.answerSource && (
                              <div className="text-[11px] font-medium text-[#123B68] leading-snug">
                                Nguồn: {q.answerSource}
                              </div>
                            )}
                            {q.answerNote && (
                              <div className="text-[11px] opacity-90 leading-snug">
                                {q.answerNote}
                              </div>
                            )}
                          </div>
                        </td>

                        <td className="px-4 py-3.5 text-right">
                          <div className="flex flex-col items-end gap-1.5">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                disabled={saveSuccess !== null}
                                onClick={() => handleSetDecision(q.tempId, 'approved')}
                                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                                  q.reviewDecision === 'approved'
                                    ? 'bg-[#55A747] text-white'
                                    : 'border border-slate-300 bg-white text-[#2D6A23] hover:bg-[#EEF7EC] disabled:opacity-40'
                                }`}
                              >
                                <Check className="h-3.5 w-3.5" />
                                <span>Duyệt</span>
                              </button>

                              <button
                                type="button"
                                disabled={saveSuccess !== null}
                                onClick={() => handleSetDecision(q.tempId, 'rejected')}
                                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                                  q.reviewDecision === 'rejected'
                                    ? 'bg-[#D94B45] text-white'
                                    : 'border border-slate-300 bg-white text-[#A92F2A] hover:bg-[#FDF1F0] disabled:opacity-40'
                                }`}
                              >
                                <X className="h-3.5 w-3.5" />
                                <span>Từ chối</span>
                              </button>
                            </div>

                            {saveSuccess === null && (
                              <button
                                type="button"
                                onClick={() => setEditingQuestion(q)}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-[#123B68] hover:border-[#2878B8] hover:text-[#2878B8] whitespace-nowrap shrink-0"
                              >
                                <Edit3 className="h-3 w-3" />
                                <span>Sửa chi tiết</span>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Commit Footer */}
            <div className="border-t border-slate-200 bg-[#F3F6FA] p-5 sm:p-6 space-y-4">
              {saveError && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs leading-relaxed text-[#A92F2A]"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
                  <span>{saveError}</span>
                </div>
              )}

              {saveSuccess && (
                <div
                  role="status"
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-[#55A747]/40 bg-[#EEF7EC] px-4 py-3.5 text-xs text-[#2D6A23]"
                >
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-[#55A747]" />
                    <div className="space-y-0.5">
                      <div className="font-bold text-sm">
                        Đã lưu thành công {saveSuccess.savedCount} câu hỏi vào Ngân hàng câu hỏi chính thức!
                      </div>
                      <div>
                        Mã đợt nhập:{' '}
                        <span className="font-mono font-semibold">{saveSuccess.importId}</span>
                        {saveSuccess.skippedDuplicates > 0 && (
                          <span>
                            {' '}
                            · Đã bỏ qua {saveSuccess.skippedDuplicates} câu trùng lặp
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={onViewSavedBank}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#2D6A23] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#23521b] whitespace-nowrap shrink-0"
                  >
                    <Database className="h-3.5 w-3.5" />
                    <span>Xem Ngân hàng câu hỏi</span>
                  </button>
                </div>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="text-xs text-[#65758B] leading-relaxed space-y-1">
                  <div>
                    Sẵn sàng lưu <strong className="text-[#123B68] tabular-nums">{stats.approvedCount} câu đã duyệt</strong>{' '}
                    ({stats.approvedCount - stats.approvedAiStarredCount} từ nguồn chính thức
                    {stats.approvedAiStarredCount > 0
                      ? ` · ${stats.approvedAiStarredCount} có dấu * AI đề xuất`
                      : ''}
                    ) vào Ngân hàng câu hỏi chính thức (Cloud Firestore).
                  </div>
                  <div>
                    {activeIssueQuestions.length > 0 || skippedIssueQuestions.length > 0
                      ? `Các câu ngoại lệ còn lại (${activeIssueQuestions.length} đang chờ${skippedIssueQuestions.length > 0 ? `, ${skippedIssueQuestions.length} bỏ qua trong đợt nhập` : ''}) được giữ an toàn trong Bản nháp và không cản trở việc hoàn tất đợt nhập.`
                      : 'Không còn câu ngoại lệ tồn đọng trong đợt nhập này.'}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!canCommit}
                  onClick={() => void handleCommitApprovedToDb()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#123B68] px-5 py-3 min-h-[44px] text-sm font-semibold text-white hover:bg-[#2878B8] disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
                >
                  {savingToDb ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Đang lưu vào Ngân hàng...</span>
                    </>
                  ) : (
                    <>
                      <Database className="h-4 w-4" />
                      <span>
                        Lưu {stats.approvedCount} câu đã duyệt vào Ngân hàng chính thức
                      </span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* Library Quick Picker Modal */}
      {showLibraryPicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 bg-[#F3F6FA] px-5 py-3.5">
              <div className="font-display text-sm font-bold text-[#123B68]">
                Chọn học liệu từ Thư viện tài liệu máy chủ
              </div>
              <button
                type="button"
                onClick={() => setShowLibraryPicker(false)}
                className="rounded-lg p-1 text-[#65758B] hover:bg-slate-200/70"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-5 max-h-[65vh] overflow-y-auto space-y-3">
              {loadingLibraryDocs && (
                <div className="flex items-center gap-2 text-xs text-[#2878B8] py-4 justify-center">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Đang tải danh sách tài liệu...</span>
                </div>
              )}
              {libraryPickerError && (
                <div className="rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] p-3 text-xs text-[#A92F2A]">
                  {libraryPickerError}
                </div>
              )}
              {!loadingLibraryDocs && libraryDocs.length === 0 && !libraryPickerError && (
                <div className="text-center text-xs text-[#65758B] py-6">
                  Thư viện tài liệu chưa có tệp nào được lưu trữ. Bạn có thể chọn trực tiếp tệp từ máy tính.
                </div>
              )}
              {libraryDocs.map((doc) => {
                const alreadyAdded = queuedFiles.some((q) => q.libraryDoc?.id === doc.id)
                return (
                  <div
                    key={doc.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-[#123B68] truncate">
                        {doc.originalFilename}
                      </div>
                      <div className="text-[11px] text-[#65758B] tabular-nums">
                        {doc.fileExtension.toUpperCase()} · {formatBytes(doc.fileSizeBytes)} ·{' '}
                        {formatDateVi(doc.createdAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={alreadyAdded}
                      onClick={() => void handleAddLibraryDocToQueue(doc)}
                      className="rounded-lg border border-[#2878B8]/40 bg-[#EAF3FA] px-3 py-1.5 text-xs font-semibold text-[#123B68] hover:bg-[#dcecf8] disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      {alreadyAdded ? 'Đã thêm' : 'Thêm vào Agent'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {editingQuestion && (
        <QuestionEditModal
          title={`Chỉnh sửa câu hỏi · ${editingQuestion.questionNumber}`}
          initialValues={{
            questionType: editingQuestion.questionType,
            bankName: editingQuestion.bankName || bankNameInput,
            topic: editingQuestion.topic,
            lessonTitle: editingQuestion.lessonTitle,
            questionNumber: editingQuestion.questionNumber,
            pageNumber: editingQuestion.pageNumber,
            cognitiveLevel: editingQuestion.cognitiveLevel,
            questionText: editingQuestion.questionText,
            optionA: editingQuestion.optionA,
            optionB: editingQuestion.optionB,
            optionC: editingQuestion.optionC,
            optionD: editingQuestion.optionD,
            answerKey: editingQuestion.answerKey,
            statementA: editingQuestion.statementA,
            statementB: editingQuestion.statementB,
            statementC: editingQuestion.statementC,
            statementD: editingQuestion.statementD,
            statementAnswerA: editingQuestion.statementAnswerA,
            statementAnswerB: editingQuestion.statementAnswerB,
            statementAnswerC: editingQuestion.statementAnswerC,
            statementAnswerD: editingQuestion.statementAnswerD,
            rubric: editingQuestion.rubric,
            sampleAnswer: editingQuestion.sampleAnswer,
            explanation: editingQuestion.explanation,
          }}
          allowTypeChange
          onCancel={() => setEditingQuestion(null)}
          onSave={handleSaveEditedRow}
        />
      )}
    </div>
  )
}
