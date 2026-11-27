import { getAuthHeaders, getDriveAuthHeaders } from './authClient'
import type {
  AgentAnalysisSummary,
  AgentFileRole,
  AgentSetMode,
  AgentUploadedFileReport,
  AnswerProvisionMode,
  BatchExceptionResolveResponse,
  BatchResolveExistingBankHint,
  CompositeDocumentAnalysis,
  DocumentImportCategory,
  ExtractedQuestion,
  GeminiConnectionInfo,
  ImportJobSnapshot,
  ImportStepCode,
  ParseDocumentResponse,
  QuestionDraftStatus,
  QuestionImportDraftRecord,
  QuestionType,
  SourceFileFormat,
} from '../types'

export interface AiAgentGenerateResponse extends ParseDocumentResponse {
  draft: QuestionImportDraftRecord
  documentAnalysis: CompositeDocumentAnalysis
}

export class QuestionImportError extends Error {
  step?: ImportStepCode
  stepLabel?: string
  code?: string
  httpStatus?: number
  failedProgress?: number

  constructor(
    message: string,
    options?: {
      step?: ImportStepCode
      stepLabel?: string
      code?: string
      httpStatus?: number
      failedProgress?: number
    }
  ) {
    super(message)
    this.name = 'QuestionImportError'
    this.step = options?.step
    this.stepLabel = options?.stepLabel
    this.code = options?.code
    this.httpStatus = options?.httpStatus
    this.failedProgress = options?.failedProgress
  }
}

export type JobProgressHandler = (snapshot: ImportJobSnapshot) => void

async function readJsonOrThrowDiagnostics<T>(res: Response, fallbackLabel: string): Promise<T> {
  const rawText = await res.text().catch(() => '')
  let parsed: Record<string, unknown> | null = null
  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>
    } catch {
      parsed = null
    }
  }

  if (!res.ok) {
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
      throw new QuestionImportError(parsed.error, {
        step: parsed.step as ImportStepCode | undefined,
        stepLabel: typeof parsed.stepLabel === 'string' ? parsed.stepLabel : undefined,
        code: typeof parsed.code === 'string' ? parsed.code : undefined,
        httpStatus: res.status,
      })
    }
    const snippet = rawText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180)
    const isTimeout = res.status === 502 || res.status === 504 || res.status === 408
    throw new QuestionImportError(
      isTimeout
        ? `Máy chủ phản hồi quá thời gian (HTTP ${res.status}). ${snippet || fallbackLabel}`
        : `Lỗi máy chủ HTTP ${res.status}: ${snippet || fallbackLabel}`,
      {
        step: isTimeout ? 'ai_extract' : 'read_file',
        stepLabel: isTimeout ? 'Gemini API lỗi / Quá thời gian phản hồi' : 'Không đọc được phản hồi máy chủ',
        code: `HTTP_${res.status}`,
        httpStatus: res.status,
      }
    )
  }

  if (!parsed) {
    throw new QuestionImportError(
      `Phản hồi từ máy chủ không đúng định dạng JSON (HTTP ${res.status}).`,
      {
        step: 'read_file',
        stepLabel: 'Không đọc được phản hồi máy chủ',
        code: 'INVALID_JSON_RESPONSE',
        httpStatus: res.status,
      }
    )
  }

  return parsed as T
}

async function pollImportJob<T extends ParseDocumentResponse>(
  jobId: string,
  onProgress?: JobProgressHandler,
  initialSnapshot?: ImportJobSnapshot
): Promise<T> {
  if (initialSnapshot) {
    onProgress?.(initialSnapshot)
  }

  const maxWaitMs = 5 * 60 * 1000
  const startedAt = Date.now()
  let lastProgress = initialSnapshot?.progress ?? 12

  while (Date.now() - startedAt < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 700))
    const headers = await getAuthHeaders()
    const res = await fetch(`/api/question-bank/jobs/${encodeURIComponent(jobId)}`, {
      headers,
    })

    const data = await readJsonOrThrowDiagnostics<{
      ok: boolean
      job?: ImportJobSnapshot
      error?: string
    }>(res, 'Không thể kiểm tra tiến trình xử lý tài liệu.')

    if (!data.ok || !data.job) {
      throw new QuestionImportError(
        data.error || 'Không nhận được trạng thái tiến trình từ máy chủ.',
        { failedProgress: lastProgress }
      )
    }

    const job = data.job
    lastProgress = job.progress ?? lastProgress
    onProgress?.(job)

    if (job.status === 'completed' && job.result) {
      return job.result as T
    }

    if (job.status === 'failed') {
      throw new QuestionImportError(
        job.errorMessage || 'Quá trình xử lý tài liệu gặp lỗi.',
        {
          step: job.errorStep ?? job.step,
          stepLabel: job.errorStepLabel,
          code: job.errorCode,
          failedProgress: job.progress ?? lastProgress,
        }
      )
    }
  }

  throw new QuestionImportError(
    'Quá trình xử lý tài liệu vượt quá thời gian chờ (5 phút). Vui lòng thử lại hoặc chia nhỏ tệp.',
    {
      step: 'ai_extract',
      stepLabel: 'Quá thời gian xử lý',
      code: 'JOB_POLL_TIMEOUT',
      failedProgress: lastProgress,
    }
  )
}

export async function parseQuestionDocumentClient(params: {
  file?: File | null
  libraryDocumentId?: string | null
  answerFile?: File | null
  answerLibraryDocumentId?: string | null
  answerProvisionMode: AnswerProvisionMode
  preferredTypes: QuestionType[]
  bankName: string
  saveDraft?: boolean
  onProgress?: JobProgressHandler
}): Promise<ParseDocumentResponse> {
  const formData = new FormData()
  if (params.file) {
    formData.append('document', params.file)
  }
  if (params.libraryDocumentId) {
    formData.append('libraryDocumentId', params.libraryDocumentId)
  }
  if (params.answerProvisionMode === 'separate_answer_file') {
    if (params.answerFile) {
      formData.append('answerDocument', params.answerFile)
    }
    if (params.answerLibraryDocumentId) {
      formData.append('answerLibraryDocumentId', params.answerLibraryDocumentId)
    }
  }
  formData.append('answerProvisionMode', params.answerProvisionMode)
  formData.append('preferredTypes', JSON.stringify(params.preferredTypes))
  formData.append('bankName', params.bankName)
  formData.append('saveDraft', params.saveDraft === false ? 'false' : 'true')
  formData.append('asyncMode', 'true')

  const headers = await getDriveAuthHeaders()
  const res = await fetch('/api/question-bank/parse', {
    method: 'POST',
    headers,
    body: formData,
  })

  const payload = await readJsonOrThrowDiagnostics<
    | (ParseDocumentResponse & { jobId?: undefined })
    | { ok: true; jobId: string; job?: ImportJobSnapshot }
    | { ok: false; error?: string; code?: string; step?: ImportStepCode; stepLabel?: string }
  >(res, 'Không thể trích xuất câu hỏi từ tài liệu này.')

  if (!payload.ok) {
    throw new QuestionImportError(
      payload.error || 'Không thể trích xuất câu hỏi từ tài liệu này.',
      {
        step: payload.step,
        stepLabel: payload.stepLabel,
        code: payload.code,
        httpStatus: res.status,
      }
    )
  }

  if ('jobId' in payload && payload.jobId) {
    return pollImportJob<ParseDocumentResponse>(payload.jobId, params.onProgress, payload.job)
  }

  return payload as ParseDocumentResponse
}

export async function runAiAgentGenerateClient(params: {
  file?: File | null
  libraryDocumentId?: string | null
  mcqCount: number
  trueFalseCount: number
  essayCount: number
  adaptiveAutoCount: boolean
  topicFocus: string
  bankName: string
  onProgress?: JobProgressHandler
}): Promise<AiAgentGenerateResponse> {
  const formData = new FormData()
  if (params.file) {
    formData.append('document', params.file)
  }
  if (params.libraryDocumentId) {
    formData.append('libraryDocumentId', params.libraryDocumentId)
  }
  formData.append('mcqCount', String(params.mcqCount))
  formData.append('trueFalseCount', String(params.trueFalseCount))
  formData.append('essayCount', String(params.essayCount))
  formData.append('adaptiveAutoCount', params.adaptiveAutoCount ? 'true' : 'false')
  formData.append('topicFocus', params.topicFocus)
  formData.append('bankName', params.bankName)
  formData.append('asyncMode', 'true')

  const headers = await getDriveAuthHeaders()
  const res = await fetch('/api/question-bank/ai-agent-generate', {
    method: 'POST',
    headers,
    body: formData,
  })

  const payload = await readJsonOrThrowDiagnostics<
    | (AiAgentGenerateResponse & { jobId?: undefined })
    | { ok: true; jobId: string; job?: ImportJobSnapshot }
    | { ok: false; error?: string; code?: string; step?: ImportStepCode; stepLabel?: string }
  >(res, 'Không thể chạy AI Agent phân tích tài liệu tổng hợp.')

  if (!payload.ok) {
    throw new QuestionImportError(
      payload.error || 'Không thể chạy AI Agent phân tích tài liệu tổng hợp.',
      {
        step: payload.step,
        stepLabel: payload.stepLabel,
        code: payload.code,
        httpStatus: res.status,
      }
    )
  }

  if ('jobId' in payload && payload.jobId) {
    return pollImportJob<AiAgentGenerateResponse>(payload.jobId, params.onProgress, payload.job)
  }

  return payload as AiAgentGenerateResponse
}

export async function fetchGeminiAiStatusClient(refresh = false): Promise<GeminiConnectionInfo> {
  const headers = await getAuthHeaders()
  const res = await fetch(`/api/question-bank/ai-status${refresh ? '?refresh=1' : ''}`, {
    headers,
  })
  const data = (await res.json().catch(() => null)) as
    | { ok: true; status: GeminiConnectionInfo }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) || 'Không thể kiểm tra trạng thái Gemini API.'
    )
  }
  return data.status
}

export async function classifyAgentFilesClient(params: {
  files: File[]
  libraryDocumentIds?: string[]
}): Promise<AgentUploadedFileReport[]> {
  const formData = new FormData()
  for (const f of params.files) {
    formData.append('documents', f)
  }
  if (params.libraryDocumentIds && params.libraryDocumentIds.length > 0) {
    formData.append('libraryDocumentIds', JSON.stringify(params.libraryDocumentIds))
  }

  const headers = await getDriveAuthHeaders()
  const res = await fetch('/api/question-bank/agent/classify', {
    method: 'POST',
    headers,
    body: formData,
  })
  const data = (await res.json().catch(() => null)) as
    | { ok: true; files: AgentUploadedFileReport[] }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) || 'Không thể tự động phân loại vai trò tài liệu.'
    )
  }
  return data.files
}

export async function runDocumentAiAgentAnalyzeClient(params: {
  files: File[]
  libraryDocumentIds?: string[]
  fileRoles?: Record<string, AgentFileRole>
  setMode: AgentSetMode
  bankName: string
  preferredTypes?: QuestionType[]
  mcqCount?: number
  trueFalseCount?: number
  essayCount?: number
  adaptiveAutoCount?: boolean
  topicFocus?: string
  saveDraft?: boolean
  onProgress?: JobProgressHandler
}): Promise<ParseDocumentResponse> {
  const formData = new FormData()
  for (const f of params.files) {
    formData.append('documents', f)
  }
  if (params.libraryDocumentIds && params.libraryDocumentIds.length > 0) {
    formData.append('libraryDocumentIds', JSON.stringify(params.libraryDocumentIds))
  }
  if (params.fileRoles) {
    formData.append('fileRoles', JSON.stringify(params.fileRoles))
  }
  formData.append('setMode', params.setMode)
  formData.append('bankName', params.bankName)
  if (params.preferredTypes) {
    formData.append('preferredTypes', JSON.stringify(params.preferredTypes))
  }
  if (typeof params.mcqCount === 'number') formData.append('mcqCount', String(params.mcqCount))
  if (typeof params.trueFalseCount === 'number')
    formData.append('trueFalseCount', String(params.trueFalseCount))
  if (typeof params.essayCount === 'number') formData.append('essayCount', String(params.essayCount))
  formData.append('adaptiveAutoCount', params.adaptiveAutoCount ? 'true' : 'false')
  if (params.topicFocus) formData.append('topicFocus', params.topicFocus)
  formData.append('saveDraft', params.saveDraft === false ? 'false' : 'true')
  formData.append('asyncMode', 'true')

  const headers = await getDriveAuthHeaders()
  const res = await fetch('/api/question-bank/agent/analyze', {
    method: 'POST',
    headers,
    body: formData,
  })

  const payload = await readJsonOrThrowDiagnostics<
    | (ParseDocumentResponse & { jobId?: undefined })
    | { ok: true; jobId: string; job?: ImportJobSnapshot }
    | { ok: false; error?: string; code?: string; step?: ImportStepCode; stepLabel?: string }
  >(res, 'Không thể chạy TIN LAB Document AI Agent.')

  if (!payload.ok) {
    throw new QuestionImportError(
      payload.error || 'Không thể chạy TIN LAB Document AI Agent.',
      {
        step: payload.step,
        stepLabel: payload.stepLabel,
        code: payload.code,
        httpStatus: res.status,
      }
    )
  }

  if ('jobId' in payload && payload.jobId) {
    return pollImportJob<ParseDocumentResponse>(payload.jobId, params.onProgress, payload.job)
  }

  return payload as ParseDocumentResponse
}

export async function exportAgentExcelReportClient(params: {
  draftId?: string | null
  title?: string
  bankName?: string
  agentFiles?: AgentUploadedFileReport[]
  agentSummary?: AgentAnalysisSummary | null
  questions: ExtractedQuestion[]
}): Promise<void> {
  const headers = await getAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch('/api/question-bank/agent/export-excel', {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  })

  if (!res.ok) {
    const errJson = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(errJson?.error || 'Không thể xuất báo cáo Excel (.xlsx).')
  }

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `tin-lab-document-agent-${new Date().toISOString().slice(0, 10)}.xlsx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function retryIncompleteAgentClient(params: {
  draftId?: string | null
  mode: 'continue_incomplete' | 'rematch_selected'
  selectedTempIds?: string[]
  questions: ExtractedQuestion[]
  documentAnalysis?: CompositeDocumentAnalysis | null
}): Promise<{
  draftId: string | null
  questions: ExtractedQuestion[]
  agentSummary: AgentAnalysisSummary
  documentAnalysis: CompositeDocumentAnalysis
  processedCount: number
  updatedCount: number
  warnings: string[]
}> {
  const headers = await getAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch('/api/question-bank/agent/retry-incomplete', {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  })
  const data = (await res.json().catch(() => null)) as
    | {
        ok: true
        draftId: string | null
        questions: ExtractedQuestion[]
        agentSummary: AgentAnalysisSummary
        documentAnalysis: CompositeDocumentAnalysis
        processedCount: number
        updatedCount: number
        warnings: string[]
      }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể chạy lại AI Agent cho các câu chưa hoàn thành.'
    )
  }
  return {
    draftId: data.draftId,
    questions: data.questions,
    agentSummary: data.agentSummary,
    documentAnalysis: data.documentAnalysis,
    processedCount: data.processedCount,
    updatedCount: data.updatedCount,
    warnings: data.warnings,
  }
}

export async function resolveExceptionQuestionsBatchClient(params: {
  draftId?: string | null
  questions: ExtractedQuestion[]
  documentAnalysis?: CompositeDocumentAnalysis | null
  existingBankHints?: BatchResolveExistingBankHint[]
  allowAiKnowledgeFallback?: boolean
  autoMarkAiProposed?: boolean
}): Promise<BatchExceptionResolveResponse> {
  const headers = await getAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch('/api/question-bank/agent/resolve-exceptions', {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  })
  const data = (await res.json().catch(() => null)) as
    | BatchExceptionResolveResponse
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể chạy AI Agent tự tìm và bổ sung đáp án cho lô câu ngoại lệ này.'
    )
  }

  return data
}

export async function fetchQuestionImportDrafts(): Promise<{
  aiConfigured: boolean
  drafts: QuestionImportDraftRecord[]
}> {
  const headers = await getAuthHeaders()
  const res = await fetch('/api/question-bank/drafts', { headers })
  const data = (await res.json().catch(() => null)) as
    | { ok: true; aiConfigured: boolean; drafts: QuestionImportDraftRecord[] }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) || 'Không thể tải danh sách bản nháp.'
    )
  }
  return {
    aiConfigured: Boolean(data.aiConfigured),
    drafts: data.drafts,
  }
}

export async function createQuestionImportDraftClient(params: {
  title: string
  bankName: string
  documentCategory: DocumentImportCategory
  answerProvisionMode: AnswerProvisionMode
  sourceDocumentName: string
  sourceFormat: SourceFileFormat
  sourceFileHash: string
  answerFileName?: string | null
  libraryDocumentId?: string | null
  documentAnalysis?: CompositeDocumentAnalysis | null
  questions: ExtractedQuestion[]
  warnings: string[]
}): Promise<QuestionImportDraftRecord> {
  const headers = await getAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch('/api/question-bank/drafts', {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  })
  const data = (await res.json().catch(() => null)) as
    | { ok: true; draft: QuestionImportDraftRecord }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) || 'Không thể lưu bản nháp vào PostgreSQL.'
    )
  }
  return data.draft
}

export async function updateQuestionImportDraftClient(params: {
  draftId: string
  title?: string
  bankName?: string
  status?: QuestionDraftStatus
  documentAnalysis?: CompositeDocumentAnalysis | null
  questions?: ExtractedQuestion[]
  warnings?: string[]
}): Promise<QuestionImportDraftRecord> {
  const headers = await getAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch(`/api/question-bank/drafts/${params.draftId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(params),
  })
  const data = (await res.json().catch(() => null)) as
    | { ok: true; draft: QuestionImportDraftRecord }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) || 'Không thể cập nhật bản nháp.'
    )
  }
  return data.draft
}

export async function deleteQuestionImportDraftClient(draftId: string): Promise<void> {
  const headers = await getAuthHeaders()
  const res = await fetch(`/api/question-bank/drafts/${draftId}`, {
    method: 'DELETE',
    headers,
  })
  const data = (await res.json().catch(() => null)) as
    | { ok: true }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) || 'Không thể xóa bản nháp.'
    )
  }
}
