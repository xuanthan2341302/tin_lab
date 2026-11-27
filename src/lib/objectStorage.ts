import {
  DRIVE_ROOT_FOLDER_NAME,
  DRIVE_TARGET_STORAGE_EMAIL,
  getDriveOAuthConfigStatus,
} from '../../server/googleDriveService.ts'
import type { GoogleDriveConnectionInfo, ObjectStorageStatusInfo } from '../types.ts'

/**
 * TIN LAB storage status now uses Google Drive API (replacing S3/R2/GCS).
 * Primary original files live in the Super Admin's Google Drive under
 * "TIN LAB - THƯ VIỆN TÀI LIỆU", while PostgreSQL stores metadata & Drive File IDs.
 */
export function getStorageConfigStatus(
  driveStatus?: GoogleDriveConnectionInfo
): ObjectStorageStatusInfo {
  const oauth = getDriveOAuthConfigStatus()

  if (driveStatus) {
    return {
      configured: driveStatus.configured,
      provider: 'google_drive',
      bucket: DRIVE_ROOT_FOLDER_NAME,
      endpoint: `Google Drive (${driveStatus.connectedAccountEmail || driveStatus.targetStorageEmail})`,
      missingRequirements: driveStatus.configured
        ? []
        : ['Google Drive OAuth 2.0 (firebase-applet-config.json)'],
      message: driveStatus.message,
      drive: driveStatus,
    }
  }

  return {
    configured: oauth.oauthClientIdConfigured,
    provider: 'google_drive',
    bucket: DRIVE_ROOT_FOLDER_NAME,
    endpoint: `Google Drive (${DRIVE_TARGET_STORAGE_EMAIL})`,
    missingRequirements: oauth.oauthClientIdConfigured
      ? []
      : ['Google Drive OAuth 2.0 (firebase-applet-config.json)'],
    message: oauth.oauthClientIdConfigured
      ? `Đã chuyển kho lưu trữ tài liệu sang Google Drive API (${DRIVE_TARGET_STORAGE_EMAIL} · ${DRIVE_ROOT_FOLDER_NAME}).`
      : 'Chưa cấu hình OAuth 2.0 cho Google Drive API.',
  }
}

export function buildDocumentStorageKey(params: {
  folderKey: string
  documentId: string
  safeFilename: string
}): string {
  const cleaned = params.safeFilename
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120)

  return `${DRIVE_ROOT_FOLDER_NAME}/${params.folderKey}/${params.documentId}-${cleaned || 'document'}`
}
