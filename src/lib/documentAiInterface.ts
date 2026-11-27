import type { DocumentAiAgentHook } from '../db/schema.ts'
import type { DocumentFileExtension, DocumentProcessingStatus } from '../types.ts'

export const DOCUMENT_PROCESSING_STATUSES: readonly DocumentProcessingStatus[] = [
  'Uploaded',
  'Pending analysis',
  'Processing',
  'Completed',
  'Needs review',
  'Failed',
] as const

export interface DocumentAiAgentInputContract {
  contractVersion: '1.0'
  documentId: string
  ownerUid: string
  originalFilename: string
  fileExtension: DocumentFileExtension
  mimeType: string
  sha256: string
  storage: {
    provider: 'google_drive' | 's3' | 'gcs'
    bucket: string
    key: string
  }
  requestedAt: string
}

export interface DocumentAiAgentOutputContract {
  jobId: string
  status: Extract<DocumentProcessingStatus, 'Completed' | 'Needs review' | 'Failed'>
  detectedLanguage: string | null
  estimatedPages: number | null
  extractedQuestionCount: number | null
  errorMessage: string | null
}

/**
 * Clean abstraction for the TIN LAB Document AI Agent.
 */
export interface TinLabDocumentAiAgentAdapter {
  enqueueAnalysis(input: DocumentAiAgentInputContract): Promise<{ jobId: string }>
}

export function isValidDocumentStatus(value: string): value is DocumentProcessingStatus {
  return (DOCUMENT_PROCESSING_STATUSES as readonly string[]).includes(value)
}

export function createInitialAiAgentHook(): DocumentAiAgentHook {
  return {
    schemaVersion: '1.0',
    agentTarget: 'tin-lab-document-ai-agent',
    readyForExtraction: true,
    queuedAt: null,
    lastJobId: null,
    lastError: null,
    summaryMetadata: {
      detectedLanguage: null,
      estimatedPages: null,
      extractedQuestionCount: null,
    },
  }
}

export function createQueuedAiAgentHook(
  previous: DocumentAiAgentHook | null | undefined
): DocumentAiAgentHook {
  const base = previous ?? createInitialAiAgentHook()
  return {
    ...base,
    schemaVersion: '1.0',
    agentTarget: 'tin-lab-document-ai-agent',
    readyForExtraction: true,
    queuedAt: new Date().toISOString(),
    lastError: null,
  }
}

export function buildDocumentAiInputContract(params: {
  id: string
  ownerUid: string
  originalFilename: string
  fileExtension: DocumentFileExtension
  mimeType: string
  sha256: string
  storageProvider: 'google_drive' | 's3' | 'gcs'
  storageBucket: string
  storageKey: string
}): DocumentAiAgentInputContract {
  return {
    contractVersion: '1.0',
    documentId: params.id,
    ownerUid: params.ownerUid,
    originalFilename: params.originalFilename,
    fileExtension: params.fileExtension,
    mimeType: params.mimeType,
    sha256: params.sha256,
    storage: {
      provider: params.storageProvider,
      bucket: params.storageBucket,
      key: params.storageKey,
    },
    requestedAt: new Date().toISOString(),
  }
}

