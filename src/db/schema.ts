import { relations } from 'drizzle-orm'
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type {
  AttemptDetailedAnswer,
  CompositeDocumentAnalysis,
  ExtractedQuestion,
} from '../types.ts'

export interface DocumentAiAgentHook {
  schemaVersion: '1.0'
  agentTarget: 'tin-lab-document-ai-agent'
  readyForExtraction: boolean
  queuedAt: string | null
  lastJobId: string | null
  lastError: string | null
  summaryMetadata: {
    detectedLanguage: string | null
    estimatedPages: number | null
    extractedQuestionCount: number | null
  }
}

export const roleDefinitions = pgTable('role_definitions', {
  role: text('role').primaryKey(),
  displayName: text('display_name').notNull(),
  description: text('description').notNull(),
  permissions: jsonb('permissions').$type<string[]>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull().default(''),
  role: text('role').notNull().default('student'),
  roleSource: text('role_source').notNull().default('default'),
  status: text('status').notNull().default('active'),
  permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
  emailVerified: boolean('email_verified').notNull().default(false),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const adminAuthorizations = pgTable('admin_authorizations', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  assignedRole: text('assigned_role').notNull().default('super_admin'),
  status: text('status').notNull().default('pending_activation'),
  isBootstrap: boolean('is_bootstrap').notNull().default(false),
  note: text('note').notNull().default(''),
  grantedByUid: text('granted_by_uid').notNull().default('system'),
  grantedByEmail: text('granted_by_email').notNull().default('system'),
  activatedUid: text('activated_uid'),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const adminAuditLogs = pgTable('admin_audit_logs', {
  id: serial('id').primaryKey(),
  actorUid: text('actor_uid').notNull(),
  actorEmail: text('actor_email').notNull(),
  action: text('action').notNull(),
  targetEmail: text('target_email').notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const teacherAllowlist = pgTable('teacher_allowlist', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  note: text('note').notNull().default(''),
  grantedByUid: text('granted_by_uid').notNull().default('system'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const teacherDocuments = pgTable('teacher_documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerUid: text('owner_uid')
    .notNull()
    .references(() => users.uid, { onDelete: 'cascade' }),
  originalFilename: text('original_filename').notNull(),
  fileExtension: text('file_extension').notNull(),
  mimeType: text('mime_type').notNull(),
  fileSizeBytes: integer('file_size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  storageProvider: text('storage_provider').notNull(),
  storageBucket: text('storage_bucket').notNull(),
  storageKey: text('storage_key').notNull(),
  driveFileId: text('drive_file_id'),
  driveFolderKey: text('drive_folder_key').default('01_TAI_LIEU_GOC'),
  driveFolderId: text('drive_folder_id'),
  driveFolderPath: text('drive_folder_path'),
  driveWebViewLink: text('drive_web_view_link'),
  driveVerifiedAt: timestamp('drive_verified_at', { withTimezone: true }),
  driveOwnerEmail: text('drive_owner_email'),
  processingStatus: text('processing_status').notNull().default('Uploaded'),
  statusNote: text('status_note').notNull().default(''),
  aiAgentHook: jsonb('ai_agent_hook').$type<DocumentAiAgentHook>().notNull(),
  lastStatusUpdatedAt: timestamp('last_status_updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const googleDriveFolders = pgTable(
  'google_drive_folders',
  {
    id: serial('id').primaryKey(),
    ownerEmail: text('owner_email').notNull(),
    folderKey: text('folder_key').notNull(),
    folderName: text('folder_name').notNull(),
    driveFolderId: text('drive_folder_id').notNull(),
    parentDriveFolderId: text('parent_drive_folder_id'),
    folderPath: text('folder_path').notNull(),
    webViewLink: text('web_view_link'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('google_drive_folders_owner_key_idx').on(table.ownerEmail, table.folderKey)]
)

export const questionImportDrafts = pgTable('question_import_drafts', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerUid: text('owner_uid')
    .notNull()
    .references(() => users.uid, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  bankName: text('bank_name').notNull().default(''),
  documentCategory: text('document_category').notNull().default('question_document'),
  answerProvisionMode: text('answer_provision_mode').notNull().default('embedded_in_file'),
  sourceDocumentName: text('source_document_name').notNull(),
  sourceFormat: text('source_format').notNull(),
  sourceFileHash: text('source_file_hash').notNull(),
  answerFileName: text('answer_file_name'),
  libraryDocumentId: uuid('library_document_id'),
  status: text('status').notNull().default('draft'),
  documentAnalysis: jsonb('document_analysis').$type<CompositeDocumentAnalysis | null>(),
  questions: jsonb('questions').$type<ExtractedQuestion[]>().notNull().default([]),
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const examAttempts = pgTable(
  'exam_attempts',
  {
    id: serial('id').primaryKey(),
    attemptId: uuid('attempt_id').defaultRandom().notNull().unique(),
    examId: text('exam_id').notNull(),
    examTitle: text('exam_title').notNull(),
    examKind: text('exam_kind').notNull().default('practice'),
    accessCode: text('access_code').notNull().default(''),
    studentName: text('student_name').notNull(),
    studentNameNormalized: text('student_name_normalized').notNull(),
    className: text('class_name').notNull(),
    rawClassName: text('raw_class_name').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    completionStatus: text('completion_status').notNull().default('in_progress'),
    scoringMode: text('scoring_mode').notNull().default('practice_10'),
    part1Score: doublePrecision('part1_score').notNull().default(0),
    part1Max: doublePrecision('part1_max').notNull().default(0),
    part2Score: doublePrecision('part2_score').notNull().default(0),
    part2Max: doublePrecision('part2_max').notNull().default(0),
    part3Score: doublePrecision('part3_score'),
    part3Max: doublePrecision('part3_max').notNull().default(0),
    score: doublePrecision('score'),
    maxScore: doublePrecision('max_score').notNull().default(10),
    detailedAnswers: jsonb('detailed_answers')
      .$type<AttemptDetailedAnswer[]>()
      .notNull()
      .default([]),
    adminFeedback: text('admin_feedback').notNull().default(''),
    reviewedByEmail: text('reviewed_by_email'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('exam_attempts_class_name_idx').on(table.className),
    index('exam_attempts_exam_id_idx').on(table.examId),
    index('exam_attempts_started_at_idx').on(table.startedAt),
    index('exam_attempts_completion_status_idx').on(table.completionStatus),
    index('exam_attempts_class_exam_started_idx').on(
      table.className,
      table.examId,
      table.startedAt
    ),
  ]
)

export const usersRelations = relations(users, ({ many }) => ({
  documents: many(teacherDocuments),
  questionDrafts: many(questionImportDrafts),
}))

export const teacherDocumentsRelations = relations(teacherDocuments, ({ one }) => ({
  owner: one(users, {
    fields: [teacherDocuments.ownerUid],
    references: [users.uid],
  }),
}))

export const questionImportDraftsRelations = relations(questionImportDrafts, ({ one }) => ({
  owner: one(users, {
    fields: [questionImportDrafts.ownerUid],
    references: [users.uid],
  }),
}))
