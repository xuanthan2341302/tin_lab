import { and, desc, eq } from 'drizzle-orm'
import { db } from './index.ts'
import {
  googleDriveFolders,
  teacherDocuments,
  type DocumentAiAgentHook,
} from './schema.ts'
import type {
  DocumentFileExtension,
  DocumentProcessingStatus,
  DriveFolderKey,
  DriveSubfolderKey,
  GoogleDriveFolderRecord,
} from '../types.ts'

function wrapDbError(message: string, cause: unknown): Error {
  const err = new Error(message) as Error & { cause?: unknown }
  err.cause = cause
  return err
}

function serializeDriveFolderRow(
  row: typeof googleDriveFolders.$inferSelect
): GoogleDriveFolderRecord {
  return {
    folderKey: row.folderKey as DriveFolderKey,
    folderName: row.folderName,
    driveFolderId: row.driveFolderId,
    parentDriveFolderId: row.parentDriveFolderId ?? null,
    folderPath: row.folderPath,
    webViewLink: row.webViewLink ?? null,
    ownerEmail: row.ownerEmail,
    verifiedAt: row.verifiedAt.toISOString(),
  }
}

export async function listDriveFoldersByOwner(
  ownerEmail: string
): Promise<GoogleDriveFolderRecord[]> {
  try {
    const normalized = ownerEmail.trim().toLowerCase()
    const rows = await db
      .select()
      .from(googleDriveFolders)
      .where(eq(googleDriveFolders.ownerEmail, normalized))
      .orderBy(googleDriveFolders.folderKey)
    return rows.map(serializeDriveFolderRow)
  } catch (error) {
    console.error('[TIN LAB] Failed to list Google Drive folders:', error)
    throw wrapDbError('Không thể đọc danh sách thư mục Google Drive từ PostgreSQL.', error)
  }
}

export async function listAllDriveFolders(): Promise<GoogleDriveFolderRecord[]> {
  try {
    const rows = await db
      .select()
      .from(googleDriveFolders)
      .orderBy(googleDriveFolders.folderKey)
    return rows.map(serializeDriveFolderRow)
  } catch (error) {
    console.error('[TIN LAB] Failed to list all Google Drive folders:', error)
    throw wrapDbError('Không thể đọc cấu hình thư mục Google Drive từ PostgreSQL.', error)
  }
}

export async function upsertDriveFolder(params: {
  ownerEmail: string
  folderKey: DriveFolderKey
  folderName: string
  driveFolderId: string
  parentDriveFolderId: string | null
  folderPath: string
  webViewLink: string | null
}): Promise<GoogleDriveFolderRecord> {
  try {
    const normalizedEmail = params.ownerEmail.trim().toLowerCase()
    const now = new Date()
    const [row] = await db
      .insert(googleDriveFolders)
      .values({
        ownerEmail: normalizedEmail,
        folderKey: params.folderKey,
        folderName: params.folderName,
        driveFolderId: params.driveFolderId,
        parentDriveFolderId: params.parentDriveFolderId,
        folderPath: params.folderPath,
        webViewLink: params.webViewLink,
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [googleDriveFolders.ownerEmail, googleDriveFolders.folderKey],
        set: {
          folderName: params.folderName,
          driveFolderId: params.driveFolderId,
          parentDriveFolderId: params.parentDriveFolderId,
          folderPath: params.folderPath,
          webViewLink: params.webViewLink,
          verifiedAt: now,
          updatedAt: now,
        },
      })
      .returning()

    return serializeDriveFolderRow(row)
  } catch (error) {
    console.error('[TIN LAB] Failed to upsert Google Drive folder:', error)
    throw wrapDbError('Không thể lưu mã thư mục Google Drive vào PostgreSQL.', error)
  }
}

export async function createTeacherDocumentRecord(params: {
  id: string
  ownerUid: string
  originalFilename: string
  fileExtension: DocumentFileExtension
  mimeType: string
  fileSizeBytes: number
  sha256: string
  storageProvider: 'google_drive' | 's3' | 'gcs'
  storageBucket: string
  storageKey: string
  driveFileId?: string | null
  driveFolderKey?: DriveSubfolderKey | null
  driveFolderId?: string | null
  driveFolderPath?: string | null
  driveWebViewLink?: string | null
  driveVerifiedAt?: Date | null
  driveOwnerEmail?: string | null
  processingStatus: DocumentProcessingStatus
  statusNote: string
  aiAgentHook: DocumentAiAgentHook
}) {
  try {
    const now = new Date()
    const rows = await db
      .insert(teacherDocuments)
      .values({
        id: params.id,
        ownerUid: params.ownerUid,
        originalFilename: params.originalFilename,
        fileExtension: params.fileExtension,
        mimeType: params.mimeType,
        fileSizeBytes: params.fileSizeBytes,
        sha256: params.sha256,
        storageProvider: params.storageProvider,
        storageBucket: params.storageBucket,
        storageKey: params.storageKey,
        driveFileId: params.driveFileId ?? null,
        driveFolderKey: params.driveFolderKey ?? '01_TAI_LIEU_GOC',
        driveFolderId: params.driveFolderId ?? null,
        driveFolderPath: params.driveFolderPath ?? null,
        driveWebViewLink: params.driveWebViewLink ?? null,
        driveVerifiedAt: params.driveVerifiedAt ?? null,
        driveOwnerEmail: params.driveOwnerEmail ?? null,
        processingStatus: params.processingStatus,
        statusNote: params.statusNote,
        aiAgentHook: params.aiAgentHook,
        lastStatusUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    return rows[0]
  } catch (error) {
    console.error('[TIN LAB] Failed to insert teacher document record:', error)
    throw wrapDbError('Không thể lưu thông tin tài liệu vào cơ sở dữ liệu PostgreSQL.', error)
  }
}

export async function listTeacherDocumentsByOwner(ownerUid: string) {
  try {
    return await db
      .select()
      .from(teacherDocuments)
      .where(eq(teacherDocuments.ownerUid, ownerUid))
      .orderBy(desc(teacherDocuments.createdAt))
  } catch (error) {
    console.error('[TIN LAB] Failed to list teacher documents:', error)
    throw wrapDbError('Không thể tải danh sách tài liệu từ PostgreSQL.', error)
  }
}

export async function listAllTeacherDocuments() {
  try {
    return await db
      .select()
      .from(teacherDocuments)
      .orderBy(desc(teacherDocuments.createdAt))
  } catch (error) {
    console.error('[TIN LAB] Failed to list all teacher documents:', error)
    throw wrapDbError('Không thể tải danh sách tài liệu từ PostgreSQL.', error)
  }
}

export async function getTeacherDocumentById(documentId: string, ownerUid?: string) {
  try {
    const condition = ownerUid
      ? and(eq(teacherDocuments.id, documentId), eq(teacherDocuments.ownerUid, ownerUid))
      : eq(teacherDocuments.id, documentId)

    const rows = await db
      .select()
      .from(teacherDocuments)
      .where(condition)
      .limit(1)

    return rows[0] ?? null
  } catch (error) {
    console.error('[TIN LAB] Failed to fetch teacher document:', error)
    throw wrapDbError('Không thể truy vấn chi tiết tài liệu từ PostgreSQL.', error)
  }
}

export async function updateTeacherDocumentStatus(params: {
  documentId: string
  ownerUid?: string
  processingStatus: DocumentProcessingStatus
  statusNote: string
  aiAgentHook: DocumentAiAgentHook
}) {
  try {
    const now = new Date()
    const condition = params.ownerUid
      ? and(
          eq(teacherDocuments.id, params.documentId),
          eq(teacherDocuments.ownerUid, params.ownerUid)
        )
      : eq(teacherDocuments.id, params.documentId)

    const rows = await db
      .update(teacherDocuments)
      .set({
        processingStatus: params.processingStatus,
        statusNote: params.statusNote,
        aiAgentHook: params.aiAgentHook,
        lastStatusUpdatedAt: now,
        updatedAt: now,
      })
      .where(condition)
      .returning()

    return rows[0] ?? null
  } catch (error) {
    console.error('[TIN LAB] Failed to update teacher document status:', error)
    throw wrapDbError('Không thể cập nhật trạng thái xử lý tài liệu.', error)
  }
}

export async function deleteTeacherDocumentById(documentId: string, ownerUid?: string) {
  try {
    const condition = ownerUid
      ? and(eq(teacherDocuments.id, documentId), eq(teacherDocuments.ownerUid, ownerUid))
      : eq(teacherDocuments.id, documentId)

    const rows = await db
      .delete(teacherDocuments)
      .where(condition)
      .returning()

    return rows[0] ?? null
  } catch (error) {
    console.error('[TIN LAB] Failed to delete teacher document record:', error)
    throw wrapDbError('Không thể xóa bản ghi tài liệu khỏi PostgreSQL.', error)
  }
}
