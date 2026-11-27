import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import {
  listAllDriveFolders,
  listDriveFoldersByOwner,
  upsertDriveFolder,
} from '../src/db/documents.ts'
import type {
  DriveFolderKey,
  DriveSubfolderKey,
  GoogleDriveConnectionInfo,
  GoogleDriveFolderRecord,
} from '../src/types.ts'

export const DRIVE_TARGET_STORAGE_EMAIL = (
  process.env.DRIVE_STORAGE_ACCOUNT_EMAIL?.trim().toLowerCase() ||
  'sunghiep.tsbd@gmail.com'
)

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const DRIVE_ROOT_FOLDER_NAME = 'TIN LAB - THƯ VIỆN TÀI LIỆU'
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'

export const DRIVE_SUBFOLDER_DEFINITIONS: readonly {
  key: DriveSubfolderKey
  name: string
  label: string
  description: string
}[] = [
  {
    key: '01_TAI_LIEU_GOC',
    name: '01_TAI_LIEU_GOC',
    label: 'Tài liệu gốc',
    description: 'Lưu file câu hỏi, bài giảng, học liệu gốc (.docx, .pdf, .txt)',
  },
  {
    key: '02_FILE_DAP_AN',
    name: '02_FILE_DAP_AN',
    label: 'File đáp án',
    description: 'Lưu bảng đáp án, hướng dẫn chấm và lời giải riêng',
  },
  {
    key: '03_TAI_LIEU_TONG_HOP',
    name: '03_TAI_LIEU_TONG_HOP',
    label: 'Tài liệu tổng hợp',
    description: 'Lưu chuyên đề ôn tập và tài liệu tổng hợp nhiều bài học',
  },
  {
    key: '04_DE_THI',
    name: '04_DE_THI',
    label: 'Đề thi',
    description: 'Lưu đề thi chính thức, đề ôn tập và ma trận đề',
  },
  {
    key: '05_BAO_CAO',
    name: '05_BAO_CAO',
    label: 'Báo cáo',
    description: 'Lưu báo cáo kết quả, thống kê điểm và file xuất đối soát',
  },
] as const

export const VALID_DRIVE_SUBFOLDER_KEYS: readonly DriveSubfolderKey[] =
  DRIVE_SUBFOLDER_DEFINITIONS.map((d) => d.key)

export function isValidDriveSubfolderKey(value: unknown): value is DriveSubfolderKey {
  return (
    typeof value === 'string' &&
    (VALID_DRIVE_SUBFOLDER_KEYS as readonly string[]).includes(value)
  )
}

export function buildDriveFolderPath(folderKey: DriveFolderKey): string {
  if (folderKey === 'ROOT') {
    return DRIVE_ROOT_FOLDER_NAME
  }
  return `${DRIVE_ROOT_FOLDER_NAME} / ${folderKey}`
}

export class GoogleDriveError extends Error {
  code: string
  statusCode: number

  constructor(message: string, code: string, statusCode = 502) {
    super(message)
    this.name = 'GoogleDriveError'
    this.code = code
    this.statusCode = statusCode
  }
}

export interface DriveApiOptions {
  apiBase?: string
  uploadBase?: string
  chunkSizeBytes?: number
  skipDbPersistence?: boolean
}

const DEFAULT_API_BASE = 'https://www.googleapis.com/drive/v3'
const DEFAULT_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
// Google Drive resumable chunk size MUST be a multiple of 256 KiB (here 4 MiB)
const DEFAULT_CHUNK_SIZE_BYTES = 4 * 1024 * 1024

interface FirebaseAppletOAuthConfig {
  projectId?: string
  oAuthClientId?: string
}

let cachedOAuthConfig: FirebaseAppletOAuthConfig | null = null

export function getDriveOAuthConfigStatus(): {
  oauthClientIdConfigured: boolean
  projectId: string | null
  oAuthClientIdPresent: boolean
} {
  if (!cachedOAuthConfig) {
    try {
      const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json')
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8')
        cachedOAuthConfig = JSON.parse(raw) as FirebaseAppletOAuthConfig
      } else {
        cachedOAuthConfig = {}
      }
    } catch {
      cachedOAuthConfig = {}
    }
  }

  const hasClientId = Boolean(cachedOAuthConfig.oAuthClientId?.trim())
  return {
    oauthClientIdConfigured: hasClientId,
    projectId: cachedOAuthConfig.projectId?.trim() || null,
    oAuthClientIdPresent: hasClientId,
  }
}

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

async function parseDriveErrorMessage(res: Response): Promise<{
  reason: string
  message: string
}> {
  const text = await res.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as {
      error?: {
        message?: string
        errors?: { reason?: string; message?: string }[]
      }
    }
    const reason = parsed.error?.errors?.[0]?.reason || ''
    const message = parsed.error?.message || text || `HTTP ${res.status}`
    return { reason, message }
  } catch {
    return { reason: '', message: text.slice(0, 300) || `HTTP ${res.status}` }
  }
}

async function throwDriveResponseError(res: Response, actionLabel: string): Promise<never> {
  const { reason, message } = await parseDriveErrorMessage(res)
  if (res.status === 401) {
    throw new GoogleDriveError(
      'Phiên kết nối Google Drive đã hết hạn hoặc không hợp lệ. Vui lòng nhấn "Kết nối Google Drive" để cấp lại quyền truy cập.',
      'DRIVE_TOKEN_EXPIRED',
      401
    )
  }
  if (res.status === 403) {
    if (reason === 'accessNotConfigured' || /has not been used|not enabled/i.test(message)) {
      throw new GoogleDriveError(
        `Google Drive API chưa được kích hoạt trên dự án Google Cloud (${message}).`,
        'DRIVE_API_NOT_ENABLED',
        403
      )
    }
    if (reason === 'insufficientPermissions' || /insufficient/i.test(message)) {
      throw new GoogleDriveError(
        'Tài khoản Google chưa cấp đủ quyền drive.file cho TIN LAB. Vui lòng nhấn "Kết nối Google Drive" và chấp thuận quyền truy cập tệp ứng dụng tạo.',
        'DRIVE_INSUFFICIENT_SCOPE',
        403
      )
    }
    throw new GoogleDriveError(
      `Google Drive từ chối quyền khi ${actionLabel}: ${message}`,
      'DRIVE_ACCESS_DENIED',
      403
    )
  }
  if (res.status === 404) {
    throw new GoogleDriveError(
      `Không tìm thấy tệp hoặc thư mục trên Google Drive khi ${actionLabel}.`,
      'DRIVE_NOT_FOUND',
      404
    )
  }
  if (res.status === 429) {
    throw new GoogleDriveError(
      'Google Drive đang giới hạn tần suất yêu cầu (429). Vui lòng thử lại sau vài giây.',
      'DRIVE_RATE_LIMITED',
      429
    )
  }
  throw new GoogleDriveError(
    `Lỗi Google Drive API khi ${actionLabel} (HTTP ${res.status}): ${message}`,
    'DRIVE_API_ERROR',
    res.status >= 500 ? 502 : res.status
  )
}

export interface DriveAccountIdentity {
  emailAddress: string
  displayName: string
  storageQuota: {
    limitBytes: number | null
    usageBytes: number | null
    usageInDriveBytes: number | null
  }
}

export async function verifyDriveTokenIdentity(
  accessToken: string,
  options?: DriveApiOptions
): Promise<DriveAccountIdentity> {
  const token = accessToken.trim()
  if (!token) {
    throw new GoogleDriveError(
      'Chưa có phiên kết nối Google Drive. Vui lòng nhấn "Kết nối Google Drive" bằng tài khoản quản trị.',
      'DRIVE_TOKEN_MISSING',
      401
    )
  }

  const apiBase = options?.apiBase || DEFAULT_API_BASE
  const url = `${apiBase}/about?fields=user(emailAddress,displayName),storageQuota(limit,usage,usageInDrive)`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  })

  if (!res.ok) {
    await throwDriveResponseError(res, 'kiểm tra tài khoản Google Drive')
  }

  const data = (await res.json()) as {
    user?: { emailAddress?: string; displayName?: string }
    storageQuota?: { limit?: string; usage?: string; usageInDrive?: string }
  }

  const emailAddress = (data.user?.emailAddress || '').trim().toLowerCase()
  if (!emailAddress) {
    throw new GoogleDriveError(
      'Không xác định được email chủ sở hữu Google Drive từ phiên OAuth hiện tại.',
      'DRIVE_IDENTITY_MISSING',
      401
    )
  }

  const toNullableInt = (val?: string) => {
    if (!val) return null
    const parsed = Number(val)
    return Number.isFinite(parsed) ? parsed : null
  }

  return {
    emailAddress,
    displayName: data.user?.displayName || emailAddress,
    storageQuota: {
      limitBytes: toNullableInt(data.storageQuota?.limit),
      usageBytes: toNullableInt(data.storageQuota?.usage),
      usageInDriveBytes: toNullableInt(data.storageQuota?.usageInDrive),
    },
  }
}

interface DriveFileApiObject {
  id: string
  name: string
  mimeType: string
  size?: string
  parents?: string[]
  webViewLink?: string
  md5Checksum?: string
  trashed?: boolean
  createdTime?: string
  modifiedTime?: string
}

export async function getDriveFileMetadata(
  accessToken: string,
  driveFileId: string,
  options?: DriveApiOptions
): Promise<DriveFileApiObject> {
  const apiBase = options?.apiBase || DEFAULT_API_BASE
  const fields = encodeURIComponent(
    'id,name,mimeType,size,parents,webViewLink,md5Checksum,trashed,createdTime,modifiedTime'
  )
  const res = await fetch(`${apiBase}/files/${encodeURIComponent(driveFileId)}?fields=${fields}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })

  if (!res.ok) {
    await throwDriveResponseError(res, 'đọc siêu dữ liệu tệp trên Google Drive')
  }

  return (await res.json()) as DriveFileApiObject
}

async function findExistingDriveFolder(params: {
  accessToken: string
  name: string
  parentId?: string | null
  options?: DriveApiOptions
}): Promise<DriveFileApiObject | null> {
  const apiBase = params.options?.apiBase || DEFAULT_API_BASE
  const clauses = [
    `name = '${escapeDriveQueryLiteral(params.name)}'`,
    `mimeType = '${DRIVE_FOLDER_MIME}'`,
    'trashed = false',
  ]
  if (params.parentId) {
    clauses.push(`'${escapeDriveQueryLiteral(params.parentId)}' in parents`)
  }
  const q = encodeURIComponent(clauses.join(' and '))
  const fields = encodeURIComponent('files(id,name,mimeType,parents,webViewLink,trashed)')
  const url = `${apiBase}/files?q=${q}&fields=${fields}&pageSize=5&spaces=drive`

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      Accept: 'application/json',
    },
  })

  if (!res.ok) {
    await throwDriveResponseError(res, `tìm thư mục "${params.name}"`)
  }

  const data = (await res.json()) as { files?: DriveFileApiObject[] }
  const match = (data.files ?? []).find((f) => !f.trashed)
  return match ?? null
}

async function createDriveFolder(params: {
  accessToken: string
  name: string
  parentId?: string | null
  options?: DriveApiOptions
}): Promise<DriveFileApiObject> {
  const apiBase = params.options?.apiBase || DEFAULT_API_BASE
  const fields = encodeURIComponent('id,name,mimeType,parents,webViewLink,trashed')
  const body: Record<string, unknown> = {
    name: params.name,
    mimeType: DRIVE_FOLDER_MIME,
    appProperties: {
      app: 'tin-lab',
    },
  }
  if (params.parentId) {
    body.parents = [params.parentId]
  }

  const res = await fetch(`${apiBase}/files?fields=${fields}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    await throwDriveResponseError(res, `tạo thư mục "${params.name}"`)
  }

  return (await res.json()) as DriveFileApiObject
}

async function verifyFolderIdIsAlive(params: {
  accessToken: string
  folderId: string
  expectedParentId?: string | null
  options?: DriveApiOptions
}): Promise<DriveFileApiObject | null> {
  try {
    const meta = await getDriveFileMetadata(params.accessToken, params.folderId, params.options)
    if (meta.trashed || meta.mimeType !== DRIVE_FOLDER_MIME) {
      return null
    }
    if (
      params.expectedParentId &&
      Array.isArray(meta.parents) &&
      !meta.parents.includes(params.expectedParentId)
    ) {
      return null
    }
    return meta
  } catch (err) {
    if (err instanceof GoogleDriveError && err.code === 'DRIVE_NOT_FOUND') {
      return null
    }
    throw err
  }
}

export async function ensureDriveLibraryFolders(
  accessToken: string,
  ownerEmail: string,
  options?: DriveApiOptions
): Promise<{
  rootFolder: GoogleDriveFolderRecord
  folders: GoogleDriveFolderRecord[]
  folderMap: Record<DriveFolderKey, GoogleDriveFolderRecord>
}> {
  const normalizedOwner = ownerEmail.trim().toLowerCase()
  const existingDbFolders = options?.skipDbPersistence
    ? []
    : await listDriveFoldersByOwner(normalizedOwner)
  const dbMap = new Map<DriveFolderKey, GoogleDriveFolderRecord>(
    existingDbFolders.map((f) => [f.folderKey, f])
  )

  const saveFolder = async (record: {
    folderKey: DriveFolderKey
    folderName: string
    driveFolderId: string
    parentDriveFolderId: string | null
    folderPath: string
    webViewLink: string | null
  }): Promise<GoogleDriveFolderRecord> => {
    if (options?.skipDbPersistence) {
      return {
        ...record,
        ownerEmail: normalizedOwner,
        verifiedAt: new Date().toISOString(),
      }
    }
    return upsertDriveFolder({
      ownerEmail: normalizedOwner,
      ...record,
    })
  }

  // 1. Ensure Root Folder: TIN LAB - THƯ VIỆN TÀI LIỆU
  const cachedRoot = dbMap.get('ROOT')
  let rootMeta: DriveFileApiObject | null = null
  if (cachedRoot) {
    rootMeta = await verifyFolderIdIsAlive({
      accessToken,
      folderId: cachedRoot.driveFolderId,
      options,
    })
  }
  if (!rootMeta) {
    rootMeta = await findExistingDriveFolder({
      accessToken,
      name: DRIVE_ROOT_FOLDER_NAME,
      options,
    })
  }
  if (!rootMeta) {
    rootMeta = await createDriveFolder({
      accessToken,
      name: DRIVE_ROOT_FOLDER_NAME,
      options,
    })
  }

  const rootFolder = await saveFolder({
    folderKey: 'ROOT',
    folderName: DRIVE_ROOT_FOLDER_NAME,
    driveFolderId: rootMeta.id,
    parentDriveFolderId: null,
    folderPath: DRIVE_ROOT_FOLDER_NAME,
    webViewLink: rootMeta.webViewLink ?? null,
  })

  const folderMap = {
    ROOT: rootFolder,
  } as Record<DriveFolderKey, GoogleDriveFolderRecord>

  const orderedFolders: GoogleDriveFolderRecord[] = [rootFolder]

  // 2. Ensure 5 Subfolders inside Root
  for (const sub of DRIVE_SUBFOLDER_DEFINITIONS) {
    const cachedSub = dbMap.get(sub.key)
    let subMeta: DriveFileApiObject | null = null
    if (cachedSub) {
      subMeta = await verifyFolderIdIsAlive({
        accessToken,
        folderId: cachedSub.driveFolderId,
        expectedParentId: rootFolder.driveFolderId,
        options,
      })
    }
    if (!subMeta) {
      subMeta = await findExistingDriveFolder({
        accessToken,
        name: sub.name,
        parentId: rootFolder.driveFolderId,
        options,
      })
    }
    if (!subMeta) {
      subMeta = await createDriveFolder({
        accessToken,
        name: sub.name,
        parentId: rootFolder.driveFolderId,
        options,
      })
    }

    const savedSub = await saveFolder({
      folderKey: sub.key,
      folderName: sub.name,
      driveFolderId: subMeta.id,
      parentDriveFolderId: rootFolder.driveFolderId,
      folderPath: buildDriveFolderPath(sub.key),
      webViewLink: subMeta.webViewLink ?? null,
    })
    folderMap[sub.key] = savedSub
    orderedFolders.push(savedSub)
  }

  return {
    rootFolder,
    folders: orderedFolders,
    folderMap,
  }
}

export async function downloadDriveFileBuffer(
  accessToken: string,
  driveFileId: string,
  options?: DriveApiOptions
): Promise<Buffer> {
  const apiBase = options?.apiBase || DEFAULT_API_BASE
  const res = await fetch(
    `${apiBase}/files/${encodeURIComponent(driveFileId)}?alt=media`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  )

  if (!res.ok) {
    await throwDriveResponseError(res, 'tải nội dung tệp từ Google Drive')
  }

  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

export interface VerifiedDriveUploadResult {
  fileId: string
  name: string
  mimeType: string
  sizeBytes: number
  readBackSizeBytes: number
  sha256: string
  sha256Matched: boolean
  sizeMatched: boolean
  webViewLink: string | null
  parents: string[]
  verifiedAt: Date
}

/**
 * Uploads a file to Google Drive via the v3 Resumable Upload protocol (chunked for large files),
 * then immediately verifies the stored file by reading back metadata and binary content (size + SHA-256).
 * Files stay strictly private in the Super Admin's My Drive (no public permissions are ever created).
 */
export async function uploadFileToDriveResumable(params: {
  accessToken: string
  folderId: string
  filename: string
  mimeType: string
  buffer: Buffer
  appProperties?: Record<string, string>
  options?: DriveApiOptions
}): Promise<VerifiedDriveUploadResult> {
  const uploadBase = params.options?.uploadBase || DEFAULT_UPLOAD_BASE
  const chunkSize = params.options?.chunkSizeBytes || DEFAULT_CHUNK_SIZE_BYTES
  const totalBytes = params.buffer.length
  const expectedSha256 = crypto.createHash('sha256').update(params.buffer).digest('hex')

  if (totalBytes === 0) {
    throw new GoogleDriveError(
      `Tệp "${params.filename}" trống (0 byte), không thể tải lên Google Drive.`,
      'EMPTY_FILE',
      400
    )
  }

  // Step 1: Initiate resumable upload session
  const fields = encodeURIComponent(
    'id,name,mimeType,size,parents,webViewLink,md5Checksum,trashed,createdTime'
  )
  const initUrl = `${uploadBase}/files?uploadType=resumable&fields=${fields}`
  const metadataPayload = {
    name: params.filename,
    parents: [params.folderId],
    appProperties: {
      app: 'tin-lab',
      ...(params.appProperties ?? {}),
    },
  }

  const initRes = await fetch(initUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': params.mimeType,
      'X-Upload-Content-Length': String(totalBytes),
    },
    body: JSON.stringify(metadataPayload),
  })

  if (!initRes.ok) {
    await throwDriveResponseError(initRes, `khởi tạo phiên tải lên resumable cho "${params.filename}"`)
  }

  const uploadSessionUrl = initRes.headers.get('location')
  if (!uploadSessionUrl) {
    throw new GoogleDriveError(
      'Google Drive không trả về URL phiên tải lên resumable (Location header).',
      'DRIVE_RESUMABLE_SESSION_MISSING',
      502
    )
  }

  // Step 2: Upload bytes in resumable chunks
  let uploadedFileMeta: DriveFileApiObject | null = null
  let offset = 0

  while (offset < totalBytes) {
    const end = Math.min(offset + chunkSize, totalBytes)
    const chunk = params.buffer.subarray(offset, end)
    const contentRange = `bytes ${offset}-${end - 1}/${totalBytes}`

    const putRes = await fetch(uploadSessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': params.mimeType,
        'Content-Length': String(chunk.length),
        'Content-Range': contentRange,
      },
      body: new Uint8Array(chunk),
    })

    if (putRes.status === 308) {
      // Resume Incomplete: advance offset based on Range header if returned
      const rangeHeader = putRes.headers.get('range')
      if (rangeHeader) {
        const match = /bytes=0-(\d+)/i.exec(rangeHeader)
        if (match) {
          offset = Number(match[1]) + 1
          continue
        }
      }
      offset = end
      continue
    }

    if (putRes.status === 200 || putRes.status === 201) {
      uploadedFileMeta = (await putRes.json()) as DriveFileApiObject
      break
    }

    await throwDriveResponseError(
      putRes,
      `tải phân đoạn dữ liệu (${contentRange}) cho "${params.filename}"`
    )
  }

  if (!uploadedFileMeta?.id) {
    throw new GoogleDriveError(
      `Không nhận được Drive File ID sau khi tải "${params.filename}" lên Google Drive.`,
      'DRIVE_UPLOAD_INCOMPLETE',
      502
    )
  }

  // Step 3: Mandatory read-back verification (metadata + binary integrity)
  const verifiedMeta = await getDriveFileMetadata(
    params.accessToken,
    uploadedFileMeta.id,
    params.options
  )

  if (verifiedMeta.trashed) {
    throw new GoogleDriveError(
      `Tệp "${params.filename}" trên Google Drive đang ở trạng thái đã xóa (trashed).`,
      'DRIVE_VERIFY_TRASHED',
      502
    )
  }

  const readBackBuffer = await downloadDriveFileBuffer(
    params.accessToken,
    uploadedFileMeta.id,
    params.options
  )

  const readBackSha256 = crypto.createHash('sha256').update(readBackBuffer).digest('hex')
  const metaSize = verifiedMeta.size ? Number(verifiedMeta.size) : readBackBuffer.length
  const sizeMatched = readBackBuffer.length === totalBytes && metaSize === totalBytes
  const sha256Matched = readBackSha256 === expectedSha256

  if (!sizeMatched || !sha256Matched) {
    throw new GoogleDriveError(
      `Kiểm tra đọc lại tệp "${params.filename}" từ Google Drive không khớp dữ liệu gốc (gốc: ${totalBytes} byte, đọc lại: ${readBackBuffer.length} byte).`,
      'DRIVE_VERIFY_MISMATCH',
      502
    )
  }

  return {
    fileId: verifiedMeta.id,
    name: verifiedMeta.name || params.filename,
    mimeType: verifiedMeta.mimeType || params.mimeType,
    sizeBytes: totalBytes,
    readBackSizeBytes: readBackBuffer.length,
    sha256: expectedSha256,
    sha256Matched,
    sizeMatched,
    webViewLink: verifiedMeta.webViewLink ?? uploadedFileMeta.webViewLink ?? null,
    parents: verifiedMeta.parents ?? [params.folderId],
    verifiedAt: new Date(),
  }
}

export async function trashDriveFile(
  accessToken: string,
  driveFileId: string,
  options?: DriveApiOptions
): Promise<void> {
  const apiBase = options?.apiBase || DEFAULT_API_BASE
  const res = await fetch(`${apiBase}/files/${encodeURIComponent(driveFileId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({ trashed: true }),
  })

  if (!res.ok && res.status !== 404) {
    await throwDriveResponseError(res, 'chuyển tệp vào thùng rác Google Drive')
  }
}

export async function buildGoogleDriveConnectionStatus(params?: {
  accessToken?: string | null
  options?: DriveApiOptions
}): Promise<GoogleDriveConnectionInfo> {
  const oauthConfig = getDriveOAuthConfigStatus()
  const persistedFolders = await listAllDriveFolders().catch(() => [])
  const hasAllSixFolders =
    persistedFolders.some((f) => f.folderKey === 'ROOT') &&
    DRIVE_SUBFOLDER_DEFINITIONS.every((sub) =>
      persistedFolders.some((f) => f.folderKey === sub.key)
    )

  const token = params?.accessToken?.trim() || ''

  if (!oauthConfig.oauthClientIdConfigured) {
    return {
      configured: false,
      connected: false,
      oauthClientIdConfigured: false,
      targetStorageEmail: DRIVE_TARGET_STORAGE_EMAIL,
      connectedAccountEmail: null,
      connectedDisplayName: null,
      scope: DRIVE_SCOPE,
      authMode: 'oauth_session_token',
      rootFolderName: DRIVE_ROOT_FOLDER_NAME,
      foldersInitialized: hasAllSixFolders,
      folders: persistedFolders,
      storageQuota: null,
      message: 'Chưa phát hiện cấu hình OAuth 2.0 Client ID cho Google Drive trong firebase-applet-config.json.',
      errorCode: 'OAUTH_NOT_CONFIGURED',
    }
  }

  if (!token) {
    return {
      configured: true,
      connected: false,
      oauthClientIdConfigured: true,
      targetStorageEmail: DRIVE_TARGET_STORAGE_EMAIL,
      connectedAccountEmail: null,
      connectedDisplayName: null,
      scope: DRIVE_SCOPE,
      authMode: 'oauth_session_token',
      rootFolderName: DRIVE_ROOT_FOLDER_NAME,
      foldersInitialized: hasAllSixFolders,
      folders: persistedFolders,
      storageQuota: null,
      message: hasAllSixFolders
        ? `Google Drive API đã cấu hình (${DRIVE_TARGET_STORAGE_EMAIL}). Nhấn "Kết nối Google Drive" để kích hoạt phiên tải lên / đọc tệp gốc.`
        : `Google Drive API đã sẵn sàng cho ${DRIVE_TARGET_STORAGE_EMAIL}. Nhấn "Kết nối Google Drive" để khởi tạo cây thư mục thư viện.`,
      errorCode: null,
    }
  }

  try {
    const identity = await verifyDriveTokenIdentity(token, params?.options)
    const ownerFolders = persistedFolders.filter(
      (f) => f.ownerEmail === identity.emailAddress
    )
    const ownerFoldersInitialized =
      ownerFolders.some((f) => f.folderKey === 'ROOT') &&
      DRIVE_SUBFOLDER_DEFINITIONS.every((sub) =>
        ownerFolders.some((f) => f.folderKey === sub.key)
      )

    const isPreferredAccount = identity.emailAddress === DRIVE_TARGET_STORAGE_EMAIL

    return {
      configured: true,
      connected: true,
      oauthClientIdConfigured: true,
      targetStorageEmail: DRIVE_TARGET_STORAGE_EMAIL,
      connectedAccountEmail: identity.emailAddress,
      connectedDisplayName: identity.displayName,
      scope: DRIVE_SCOPE,
      authMode: 'oauth_session_token',
      rootFolderName: DRIVE_ROOT_FOLDER_NAME,
      foldersInitialized: ownerFoldersInitialized,
      folders: ownerFolders.length > 0 ? ownerFolders : persistedFolders,
      storageQuota: identity.storageQuota,
      message: isPreferredAccount
        ? `Đã kết nối Google Drive (${identity.emailAddress}) với quyền tối thiểu drive.file.`
        : `Đã kết nối Google Drive (${identity.emailAddress}). Khuyến nghị dùng tài khoản lưu trữ chính ${DRIVE_TARGET_STORAGE_EMAIL}.`,
      errorCode: null,
    }
  } catch (err) {
    const driveErr = err instanceof GoogleDriveError ? err : null
    return {
      configured: true,
      connected: false,
      oauthClientIdConfigured: true,
      targetStorageEmail: DRIVE_TARGET_STORAGE_EMAIL,
      connectedAccountEmail: null,
      connectedDisplayName: null,
      scope: DRIVE_SCOPE,
      authMode: 'oauth_session_token',
      rootFolderName: DRIVE_ROOT_FOLDER_NAME,
      foldersInitialized: hasAllSixFolders,
      folders: persistedFolders,
      storageQuota: null,
      message:
        driveErr?.message ||
        'Không thể xác minh phiên Google Drive hiện tại. Vui lòng kết nối lại.',
      errorCode: driveErr?.code || 'DRIVE_CHECK_FAILED',
    }
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Generates a real, valid OpenXML (.docx) file buffer for live Google Drive upload & read-back verification.
 */
export async function buildSampleVerificationDocxBuffer(params: {
  accountEmail: string
  folderPath: string
  testedAtIso: string
}): Promise<Buffer> {
  const zip = new JSZip()

  const lines = [
    'TIN LAB - KIEM THU LUU TRU GOOGLE DRIVE API',
    `Tai khoan luu tru: ${params.accountEmail}`,
    `Thu muc dich: ${params.folderPath}`,
    `Thoi diem kiem thu: ${params.testedAtIso}`,
    'Noi dung mau: Cau 1. Giao thuc truyen tai sieu van ban tren Web la gi? A. FTP  B. HTTP  C. SMTP  D. DNS. Dap an: B.',
  ]

  const paragraphsXml = lines
    .map(
      (line) =>
        `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`
    )
    .join('')

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  )

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  )

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphsXml}
    <w:sectPr/>
  </w:body>
</w:document>`
  )

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  })
  return buffer
}
