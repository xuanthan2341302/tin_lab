import { desc, eq } from 'drizzle-orm'
import { db } from './index.ts'
import { questionImportDrafts } from './schema.ts'
import type {
  AnswerProvisionMode,
  CompositeDocumentAnalysis,
  DocumentImportCategory,
  ExtractedQuestion,
  QuestionDraftStatus,
  QuestionImportDraftRecord,
  SourceFileFormat,
} from '../types.ts'

function serializeDraft(
  row: typeof questionImportDrafts.$inferSelect
): QuestionImportDraftRecord {
  const questions = Array.isArray(row.questions) ? row.questions : []
  const approvedCount = questions.filter((q) => q.reviewDecision === 'approved').length
  return {
    id: row.id,
    ownerUid: row.ownerUid,
    title: row.title,
    bankName: row.bankName,
    documentCategory: (row.documentCategory === 'composite_document'
      ? 'composite_document'
      : 'question_document') as DocumentImportCategory,
    answerProvisionMode: (row.answerProvisionMode === 'separate_answer_file'
      ? 'separate_answer_file'
      : 'embedded_in_file') as AnswerProvisionMode,
    sourceDocumentName: row.sourceDocumentName,
    sourceFormat: (['docx', 'pdf', 'txt'].includes(row.sourceFormat)
      ? row.sourceFormat
      : 'docx') as SourceFileFormat,
    sourceFileHash: row.sourceFileHash,
    answerFileName: row.answerFileName ?? null,
    libraryDocumentId: row.libraryDocumentId ?? null,
    status: (['draft', 'committed', 'archived'].includes(row.status)
      ? row.status
      : 'draft') as QuestionDraftStatus,
    documentAnalysis: row.documentAnalysis ?? null,
    questions,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    totalCount: questions.length,
    approvedCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function createQuestionImportDraft(params: {
  ownerUid: string
  title: string
  bankName?: string
  documentCategory: DocumentImportCategory
  answerProvisionMode: AnswerProvisionMode
  sourceDocumentName: string
  sourceFormat: SourceFileFormat
  sourceFileHash: string
  answerFileName?: string | null
  libraryDocumentId?: string | null
  status?: QuestionDraftStatus
  documentAnalysis?: CompositeDocumentAnalysis | null
  questions: ExtractedQuestion[]
  warnings?: string[]
}): Promise<QuestionImportDraftRecord> {
  const now = new Date()
  const [inserted] = await db
    .insert(questionImportDrafts)
    .values({
      ownerUid: params.ownerUid,
      title: params.title.trim().slice(0, 200) || params.sourceDocumentName.slice(0, 200),
      bankName: (params.bankName ?? '').trim().slice(0, 120),
      documentCategory: params.documentCategory,
      answerProvisionMode: params.answerProvisionMode,
      sourceDocumentName: params.sourceDocumentName.slice(0, 255),
      sourceFormat: params.sourceFormat,
      sourceFileHash: params.sourceFileHash,
      answerFileName: params.answerFileName ? params.answerFileName.slice(0, 255) : null,
      libraryDocumentId: params.libraryDocumentId ?? null,
      status: params.status ?? 'draft',
      documentAnalysis: params.documentAnalysis ?? null,
      questions: params.questions,
      warnings: params.warnings ?? [],
      createdAt: now,
      updatedAt: now,
    })
    .returning()

  return serializeDraft(inserted)
}

export async function listQuestionImportDraftsByOwner(
  _ownerUid?: string
): Promise<QuestionImportDraftRecord[]> {
  const rows = await db
    .select()
    .from(questionImportDrafts)
    .orderBy(desc(questionImportDrafts.updatedAt))
    .limit(100)

  return rows.map(serializeDraft)
}

export async function getQuestionImportDraftById(
  draftId: string,
  _ownerUid?: string
): Promise<QuestionImportDraftRecord | null> {
  const rows = await db
    .select()
    .from(questionImportDrafts)
    .where(eq(questionImportDrafts.id, draftId))
    .limit(1)

  return rows[0] ? serializeDraft(rows[0]) : null
}

export async function updateQuestionImportDraft(params: {
  draftId: string
  ownerUid?: string
  title?: string
  bankName?: string
  status?: QuestionDraftStatus
  documentAnalysis?: CompositeDocumentAnalysis | null
  questions?: ExtractedQuestion[]
  warnings?: string[]
}): Promise<QuestionImportDraftRecord | null> {
  const patch: Partial<typeof questionImportDrafts.$inferInsert> = {
    updatedAt: new Date(),
  }
  if (typeof params.title === 'string') {
    patch.title = params.title.trim().slice(0, 200)
  }
  if (typeof params.bankName === 'string') {
    patch.bankName = params.bankName.trim().slice(0, 120)
  }
  if (params.status) {
    patch.status = params.status
  }
  if (params.documentAnalysis !== undefined) {
    patch.documentAnalysis = params.documentAnalysis
  }
  if (Array.isArray(params.questions)) {
    patch.questions = params.questions
  }
  if (Array.isArray(params.warnings)) {
    patch.warnings = params.warnings
  }

  const [updated] = await db
    .update(questionImportDrafts)
    .set(patch)
    .where(eq(questionImportDrafts.id, params.draftId))
    .returning()

  return updated ? serializeDraft(updated) : null
}

export async function deleteQuestionImportDraftById(
  draftId: string,
  _ownerUid?: string
): Promise<boolean> {
  // CRITICAL: Only deletes the question draft row in PostgreSQL.
  // NEVER deletes original files stored on Google Drive or teacher_documents.
  const rows = await db
    .delete(questionImportDrafts)
    .where(eq(questionImportDrafts.id, draftId))
    .returning()

  return rows.length > 0
}

