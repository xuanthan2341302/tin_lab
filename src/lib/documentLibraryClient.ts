import { auth, getGoogleDriveToken } from './firebase'
import { getDriveAuthHeaders } from './authClient'
import type {
  DocumentProcessingStatus,
  DriveSubfolderKey,
  GoogleDriveConnectionInfo,
  GoogleDriveFolderRecord,
  GoogleDriveSelfTestResult,
  ObjectStorageStatusInfo,
  TeacherDocumentRecord,
} from '../types'

export interface DocumentListResponse {
  storage: ObjectStorageStatusInfo
  drive: GoogleDriveConnectionInfo | null
  documents: TeacherDocumentRecord[]
}

export interface UploadDocumentsResponse {
  ok: boolean
  code?: string
  error?: string
  uploaded: TeacherDocumentRecord[]
  errors: { filename: string; code: string; error: string }[]
}

export type DocumentPreviewResult =
  | {
      kind: 'pdf'
      filename: string
      blobUrl: string
    }
  | {
      kind: 'text'
      filename: string
      text: string
    }

export async function fetchGoogleDriveStatus(): Promise<{
  drive: GoogleDriveConnectionInfo
  storage: ObjectStorageStatusInfo
}> {
  const headers = await getDriveAuthHeaders()
  const res = await fetch('/api/drive/status', { headers, cache: 'no-store' })
  const data = (await res.json().catch(() => null)) as
    | {
        ok: true
        drive: GoogleDriveConnectionInfo
        storage: ObjectStorageStatusInfo
      }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể kiểm tra trạng thái kết nối Google Drive.'
    )
  }

  return {
    drive: data.drive,
    storage: data.storage,
  }
}

export async function initializeGoogleDriveFolders(): Promise<{
  accountEmail: string
  folders: GoogleDriveFolderRecord[]
  drive: GoogleDriveConnectionInfo
}> {
  const headers = await getDriveAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch('/api/drive/init-folders', {
    method: 'POST',
    headers,
    cache: 'no-store',
  })
  const data = (await res.json().catch(() => null)) as
    | {
        ok: true
        accountEmail: string
        folders: GoogleDriveFolderRecord[]
        drive: GoogleDriveConnectionInfo
      }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể khởi tạo cây thư mục thư viện trên Google Drive.'
    )
  }

  return {
    accountEmail: data.accountEmail,
    folders: data.folders,
    drive: data.drive,
  }
}

export async function runGoogleDriveSelfTest(): Promise<{
  result: GoogleDriveSelfTestResult
  drive: GoogleDriveConnectionInfo
  document: TeacherDocumentRecord
}> {
  const headers = await getDriveAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch('/api/drive/self-test', {
    method: 'POST',
    headers,
    cache: 'no-store',
  })
  const data = (await res.json().catch(() => null)) as
    | {
        ok: true
        result: GoogleDriveSelfTestResult
        drive: GoogleDriveConnectionInfo
        document: TeacherDocumentRecord
      }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Kiểm thử tải lên và đọc lại tệp mẫu trên Google Drive thất bại.'
    )
  }

  return {
    result: data.result,
    drive: data.drive,
    document: data.document,
  }
}

export async function fetchTeacherDocuments(): Promise<DocumentListResponse> {
  const headers = await getDriveAuthHeaders()
  const res = await fetch('/api/teacher/documents', { headers, cache: 'no-store' })
  const data = (await res.json().catch(() => null)) as
    | {
        ok: true
        storage: ObjectStorageStatusInfo
        drive?: GoogleDriveConnectionInfo
        documents: TeacherDocumentRecord[]
      }
    | {
        ok: false
        storage?: ObjectStorageStatusInfo
        error?: string
      }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể tải thư viện tài liệu từ máy chủ.'
    )
  }

  return {
    storage: data.storage,
    drive: data.drive ?? data.storage.drive ?? null,
    documents: data.documents,
  }
}

export async function uploadTeacherDocuments(params: {
  files: File[]
  folderKey: DriveSubfolderKey
  onProgress: (percent: number) => void
}): Promise<UploadDocumentsResponse> {
  const user = auth.currentUser
  if (!user) {
    throw new Error('Bạn chưa đăng nhập tài khoản quản trị.')
  }
  const driveToken = getGoogleDriveToken()
  if (!driveToken) {
    throw new Error(
      'Chưa kết nối Google Drive trong phiên này. Vui lòng nhấn "Kết nối Google Drive" trước khi tải tệp lên.'
    )
  }
  const token = await user.getIdToken()

  return new Promise<UploadDocumentsResponse>((resolve, reject) => {
    const formData = new FormData()
    formData.append('folderKey', params.folderKey)
    for (const file of params.files) {
      formData.append('documents', file)
    }

    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/teacher/documents/upload', true)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('X-Google-Drive-Token', driveToken)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        const pct = Math.min(92, Math.round((event.loaded / event.total) * 100))
        params.onProgress(pct)
      }
    }

    xhr.onload = () => {
      params.onProgress(100)
      let parsed: UploadDocumentsResponse | null = null
      try {
        parsed = JSON.parse(xhr.responseText) as UploadDocumentsResponse
      } catch {
        parsed = null
      }

      if (xhr.status >= 200 && xhr.status < 300 && parsed) {
        resolve(parsed)
        return
      }

      const errorMsg =
        parsed?.error ||
        (xhr.status === 401
          ? 'Phiên Google Drive đã hết hạn. Vui lòng nhấn "Kết nối Google Drive" lại.'
          : 'Không thể tải tệp lên Google Drive.')
      reject(new Error(errorMsg))
    }

    xhr.onerror = () => {
      reject(new Error('Lỗi kết nối mạng khi đang tải tệp lên Google Drive.'))
    }

    xhr.send(formData)
  })
}

export async function fetchDocumentPreview(
  doc: TeacherDocumentRecord
): Promise<DocumentPreviewResult> {
  const headers = await getDriveAuthHeaders()
  const res = await fetch(`/api/teacher/documents/${doc.id}/preview`, {
    headers,
    cache: 'no-store',
  })

  if (!res.ok) {
    const errPayload = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(errPayload?.error || 'Không thể mở bản xem trước tài liệu từ Google Drive.')
  }

  const contentType = res.headers.get('Content-Type') || ''
  if (contentType.includes('application/pdf')) {
    const blob = await res.blob()
    const blobUrl = URL.createObjectURL(blob)
    return {
      kind: 'pdf',
      filename: doc.originalFilename,
      blobUrl,
    }
  }

  const json = (await res.json()) as {
    ok: boolean
    filename?: string
    text?: string
    error?: string
  }
  return {
    kind: 'text',
    filename: json.filename || doc.originalFilename,
    text: json.text || '',
  }
}

export async function downloadTeacherDocument(doc: TeacherDocumentRecord): Promise<void> {
  const headers = await getDriveAuthHeaders()
  const res = await fetch(`/api/teacher/documents/${doc.id}/download`, {
    headers,
    cache: 'no-store',
  })
  if (!res.ok) {
    const errPayload = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(errPayload?.error || 'Không thể tải xuống tệp gốc từ Google Drive.')
  }

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = doc.originalFilename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function deleteTeacherDocument(documentId: string): Promise<void> {
  const headers = await getDriveAuthHeaders()
  const res = await fetch(`/api/teacher/documents/${documentId}`, {
    method: 'DELETE',
    headers,
  })
  const data = (await res.json().catch(() => null)) as
    | { ok: true }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error((data && 'error' in data && data.error) || 'Không thể xóa tài liệu.')
  }
}

export async function queueDocumentForAiAnalysis(
  documentId: string
): Promise<TeacherDocumentRecord> {
  const headers = await getDriveAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch(`/api/teacher/documents/${documentId}/queue-analysis`, {
    method: 'POST',
    headers,
  })
  const data = (await res.json().catch(() => null)) as
    | { ok: true; document: TeacherDocumentRecord }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể chuyển tài liệu sang hàng đợi Document AI.'
    )
  }
  return data.document
}

export async function updateTeacherDocumentWorkflowStatus(params: {
  documentId: string
  processingStatus: DocumentProcessingStatus
  statusNote?: string
}): Promise<TeacherDocumentRecord> {
  const headers = await getDriveAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch(`/api/teacher/documents/${params.documentId}/status`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      processingStatus: params.processingStatus,
      statusNote: params.statusNote ?? '',
    }),
  })
  const data = (await res.json().catch(() => null)) as
    | { ok: true; document: TeacherDocumentRecord }
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) || 'Không thể cập nhật trạng thái tài liệu.'
    )
  }
  return data.document
}
