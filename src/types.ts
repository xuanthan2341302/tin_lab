export type NavPage =
  | 'home'
  | 'student'
  | 'teacher'
  | 'stats'
  | 'guide'
  | 'contact'

export interface ExamQuestion {
  id: string
  topic: string
  prompt: string
  options: string[]
}

export interface PracticeExam {
  id: string
  title: string
  topicGroup: string
  durationMinutes: number
  level: string
  description: string
  questions: ExamQuestion[]
}

export interface RealTopicDistributionItem {
  topicName: string
  extractedCount: number
  draftCount: number
  exceptionCount: number
  approvedBankCount: number
}

export interface RealExamStatsItem {
  examId: string
  examTitle: string
  examKind: ExamAttemptKind
  attemptCount: number
  completedCount: number
  gradedCount: number
  averageScore: number | null
  completionRate: number | null
  maxScore: number
}

export interface RealDashboardActivityItem {
  id: string
  kind: 'document' | 'draft' | 'exam'
  title: string
  detail: string
  timestamp: string
}

export interface RealDashboardMetricsResponse {
  ok: true
  generatedAt: string
  dataSources: {
    postgresAvailable: boolean
    postgresErrorCode: string | null
    postgresNotice: string | null
    firestoreAvailable: boolean
    firestoreNotice: string | null
    postgresTables: string[]
    firestoreCollections: string[]
  }
  metrics: {
    uploadedDocumentsCount: number
    draftBatchesCount: number
    extractedQuestionsCount: number
    draftQuestionsCount: number
    exceptionQuestionsCount: number
    readyDraftQuestionsCount: number
    committedDraftQuestionsCount: number
    approvedBankQuestionsCount: number | null
    publishedExamsCount: number | null
    studentAttemptsTotal: number
    studentAttemptsCompleted: number
    studentAttemptsInProgress: number
    studentAttemptsGraded: number
    studentAttemptsNeedsReview: number
    averageScore: number | null
    completionRate: number | null
  }
  topicBreakdown: RealTopicDistributionItem[]
  examPerformance: RealExamStatsItem[]
  recentActivities: RealDashboardActivityItem[]
}

export type SourceFileFormat = 'docx' | 'pdf' | 'txt'
export type DocumentImportCategory = 'question_document' | 'composite_document'
export type AnswerProvisionMode = 'embedded_in_file' | 'separate_answer_file'
export type QuestionOrigin = 'extracted' | 'ai_generated'
export type QuestionType = 'multiple_choice' | 'true_false' | 'essay'
export type CognitiveLevel =
  | 'recognition'
  | 'understanding'
  | 'application'
  | 'unspecified'
export type AnswerOptionKey = 'A' | 'B' | 'C' | 'D'
export type AnswerStatus =
  | 'verified'
  | 'ai_proposed'
  | 'needs_review'
  | 'missing'
  | 'ambiguous'
export type ReviewDecision = 'pending' | 'approved' | 'rejected'
export type Part2ScoringMode = 'tiered_2025' | 'linear'

export type GeminiConnectionState =
  | 'connected'
  | 'not_configured'
  | 'invalid_key'
  | 'permission_denied'
  | 'quota_exceeded'
  | 'error'

export interface GeminiConnectionInfo {
  state: GeminiConnectionState
  connected: boolean
  configured: boolean
  model: string
  checkedAt: string
  message: string
  setupGuide: string
  errorCode?: string
  diagnostics?: {
    exists: boolean
    keyLength: number
    startsWithAIza: boolean
    detectedKeyType: string
    configSource: string
    apiEndpoint: string
    hadFormattingArtifacts: boolean
    overrideCheck: {
      hasLocalDotEnv: boolean
      hasGoogleApiKeyVar: boolean
      hasVertexAiFlag: boolean
      runtimeEnv: string
    }
  }
}

export type AgentFileRole =
  | 'question_file'
  | 'answer_file'
  | 'solution_guide'
  | 'composite_file'
  | 'reference_file'
  | 'irrelevant_file'

export interface AgentPairedSet {
  questionFile: string
  answerFiles: string[]
  matchBasis: string
}

export interface AgentResumeCheckpoint {
  completedStages: string[]
  updatedAt: string
  answerContextSnippets?: { fileName: string; role?: AgentFileRole; rawExcerpt: string }[]
  pairedSets?: AgentPairedSet[]
}

export type AgentSetMode =
  | 'auto'
  | 'question_embedded'
  | 'question_plus_separate_answers'
  | 'composite_study'
  | 'mixed_bundle'

export type AgentConfidenceLevel = 'high' | 'medium' | 'low'

export type AgentMatchMethod =
  | 'question_code'
  | 'lesson_and_number'
  | 'stem_and_options'
  | 'context_and_explanation'
  | 'inline_formatting'
  | 'embedded_key_table'
  | 'ai_semantic_match'
  | 'ai_generated'
  | 'manual_edit'
  | 'unmatched'

export type AiAnswerSourceType =
  | 'source_document'
  | 'separate_answer_file'
  | 'composite_document'
  | 'existing_bank'
  | 'ai_knowledge'
  | 'none'

export type ExceptionResolutionCategory =
  | 'found_in_source'
  | 'ai_proposed_star'
  | 'needs_review'
  | 'not_found'
  | 'invalid_or_duplicate'
  | 'skipped_in_import'

export interface AiQuestionSuggestion {
  suggestedAnswerKey: AnswerOptionKey | null
  suggestedStatementA: boolean | null
  suggestedStatementB: boolean | null
  suggestedStatementC: boolean | null
  suggestedStatementD: boolean | null
  suggestedRubric: string
  suggestedExplanation: string
  confidenceScore: number
  confidenceLevel: AgentConfidenceLevel
  matchMethod: AgentMatchMethod
  reasoning: string
  sourceFileName: string
  sourceReference?: string
  sourceType?: AiAnswerSourceType
  processedAt?: string
  markedAsAiProposed?: boolean
  applied: boolean
}

export interface AgentUploadedFileReport {
  fileId: string
  fileName: string
  fileFormat: SourceFileFormat
  fileHash: string
  fileSizeBytes: number
  libraryDocumentId: string | null
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

export interface AgentPipelineStepRecord {
  stepNumber: number
  title: string
  status: 'completed' | 'partial' | 'skipped' | 'failed'
  detail: string
}

export interface AgentAnalysisSummary {
  totalFiles: number
  completedFiles: number
  failedFiles: number
  totalQuestions: number
  verifiedCount: number
  aiProposedCount?: number
  needsReviewCount: number
  missingCount: number
  ambiguousCount: number
  duplicateCount: number
  averageConfidence: number
  aiUsed: boolean
  aiConnectionState: GeminiConnectionState
  aiErrorMessage: string | null
  executedSteps: AgentPipelineStepRecord[]
}

export interface ExtractedQuestion {
  tempId: string
  contentHash: string
  questionType: QuestionType
  questionOrigin?: QuestionOrigin
  questionCode?: string
  bankName: string
  topic: string
  sourceDocumentName: string
  sourceDocumentHash: string
  sourceFormat: SourceFileFormat
  lessonTitle: string
  questionNumber: string
  pageNumber: number | null
  cognitiveLevel: CognitiveLevel
  questionText: string
  originalQuestionText?: string
  // Multiple-choice fields
  optionA: string
  optionB: string
  optionC: string
  optionD: string
  answerKey: AnswerOptionKey | null
  // True/False 4-statement fields
  statementA: string
  statementB: string
  statementC: string
  statementD: string
  statementAnswerA: boolean | null
  statementAnswerB: boolean | null
  statementAnswerC: boolean | null
  statementAnswerD: boolean | null
  // Essay fields
  rubric: string
  sampleAnswer: string
  explanation: string
  answerStatus: AnswerStatus
  answerNote: string
  answerSource?: string
  confidenceScore?: number
  confidenceLevel?: AgentConfidenceLevel
  matchMethod?: AgentMatchMethod
  aiSuggestion?: AiQuestionSuggestion | null
  aiProposedMarked?: boolean
  aiSourceType?: AiAnswerSourceType
  aiProcessedAt?: string | null
  aiBatchError?: string | null
  skippedInImport?: boolean
  skippedAt?: string | null
  exceptionCategory?: ExceptionResolutionCategory
  duplicateInFile: boolean
  duplicateInBank: boolean
  reviewDecision: ReviewDecision
}

export interface BatchResolveExistingBankHint {
  id: string
  questionType: QuestionType
  questionText: string
  lessonTitle?: string
  sourceDocumentName?: string
  optionA?: string
  optionB?: string
  optionC?: string
  optionD?: string
  answerKey?: AnswerOptionKey | null
  statementA?: string
  statementB?: string
  statementC?: string
  statementD?: string
  statementAnswerA?: boolean | null
  statementAnswerB?: boolean | null
  statementAnswerC?: boolean | null
  statementAnswerD?: boolean | null
  rubric?: string
  explanation?: string
}

export interface BatchExceptionResolveStats {
  totalRequested: number
  processedCount: number
  foundInSourceCount: number
  aiProposedCount: number
  needsReviewCount: number
  notFoundCount: number
  invalidOrDuplicateCount: number
  failedCount: number
}

export interface BatchExceptionResolveResponse {
  ok: true
  questions: ExtractedQuestion[]
  stats: BatchExceptionResolveStats
  failedTempIds: string[]
  aiUsed: boolean
  aiUnavailable: boolean
  aiConnectionState: GeminiConnectionState
  aiErrorMessage: string | null
  warnings: string[]
}

export interface CompositeDocumentAnalysis {
  documentSummary: string
  detectedTopics: string[]
  detectedLessons: string[]
  knowledgeUnits: {
    lessonTitle: string
    topic: string
    keyConcepts: string[]
  }[]
  agentFiles?: AgentUploadedFileReport[]
  agentSummary?: AgentAnalysisSummary
  pairedSets?: AgentPairedSet[]
  checkpoint?: AgentResumeCheckpoint
}

export interface ParseDocumentResponse {
  ok: true
  fileName: string
  fileFormat: SourceFileFormat
  fileHash: string
  pageCount: number | null
  documentCategory?: DocumentImportCategory
  answerProvisionMode?: AnswerProvisionMode
  answerFileName?: string | null
  parserEngine?: 'gemini_hybrid' | 'deterministic' | 'gemini_agent'
  documentAnalysis?: CompositeDocumentAnalysis | null
  agentFiles?: AgentUploadedFileReport[]
  agentSummary?: AgentAnalysisSummary | null
  draftId?: string | null
  draftSaveError?: string | null
  questions: ExtractedQuestion[]
  warnings: string[]
}

export type ImportStepCode =
  | 'read_file'
  | 'parse_docx'
  | 'extract_structure'
  | 'ai_extract'
  | 'match_answers'
  | 'save_draft'
  | 'completed'

export interface ImportJobSnapshot {
  id: string
  status: 'running' | 'completed' | 'failed'
  step: ImportStepCode
  stepLabel: string
  progress: number
  errorCode?: string
  errorStep?: ImportStepCode
  errorStepLabel?: string
  errorMessage?: string
  result?: ParseDocumentResponse
}

export type QuestionDraftStatus = 'draft' | 'committed' | 'archived'

export interface QuestionImportDraftRecord {
  id: string
  ownerUid: string
  title: string
  bankName: string
  documentCategory: DocumentImportCategory
  answerProvisionMode: AnswerProvisionMode
  sourceDocumentName: string
  sourceFormat: SourceFileFormat
  sourceFileHash: string
  answerFileName: string | null
  libraryDocumentId: string | null
  status: QuestionDraftStatus
  documentAnalysis: CompositeDocumentAnalysis | null
  questions: ExtractedQuestion[]
  warnings: string[]
  totalCount: number
  approvedCount: number
  createdAt: string
  updatedAt: string
}

export interface QuestionBankImportRecord {
  id: string
  ownerUid: string
  fileName: string
  fileFormat: SourceFileFormat
  fileHash: string
  bankName: string
  totalExtracted: number
  approvedSavedCount: number
  rejectedCount: number
  duplicateSkippedCount: number
  mcqCount?: number
  trueFalseCount?: number
  essayCount?: number
  createdAtMs: number | null
}

export interface SavedQuestionBankItem {
  id: string
  ownerUid: string
  importId: string
  contentHash: string
  questionType: QuestionType
  hasExplicitQuestionType: boolean
  questionOrigin?: QuestionOrigin
  answerSource?: string
  bankName: string
  topic: string
  sourceDocumentName: string
  sourceDocumentHash: string
  sourceFormat: SourceFileFormat
  lessonTitle: string
  questionNumber: string
  pageNumber: number | null
  cognitiveLevel: CognitiveLevel
  questionText: string
  optionA: string
  optionB: string
  optionC: string
  optionD: string
  answerKey: AnswerOptionKey
  statementA: string
  statementB: string
  statementC: string
  statementD: string
  statementAnswerA: boolean
  statementAnswerB: boolean
  statementAnswerC: boolean
  statementAnswerD: boolean
  rubric: string
  sampleAnswer: string
  explanation: string
  createdAtMs: number | null
  updatedAtMs: number | null
}

export interface ExamTemplate {
  id: string
  ownerUid: string
  name: string
  description: string
  schoolFormatLabel: string
  durationMinutes: number
  totalPoints: number
  part1Enabled: boolean
  part1Title: string
  part1Count: number
  part1Points: number
  part2Enabled: boolean
  part2Title: string
  part2Count: number
  part2Points: number
  part2ScoringMode: Part2ScoringMode
  part3Enabled: boolean
  part3Title: string
  part3Count: number
  part3Points: number
  recognitionPct: number
  understandingPct: number
  applicationPct: number
  createdAtMs: number | null
  updatedAtMs: number | null
}

export interface SanitizedExamQuestion {
  id: string
  part: 1 | 2 | 3
  orderIndex: number
  questionType: QuestionType
  lessonTitle: string
  topic: string
  cognitiveLevel: CognitiveLevel
  questionText: string
  points: number
  optionA?: string
  optionB?: string
  optionC?: string
  optionD?: string
  statementA?: string
  statementB?: string
  statementC?: string
  statementD?: string
}

export interface PublishedExamKeyItem {
  id: string
  part: 1 | 2 | 3
  questionType: QuestionType
  points: number
  answerKey?: AnswerOptionKey
  statementAnswerA?: boolean
  statementAnswerB?: boolean
  statementAnswerC?: boolean
  statementAnswerD?: boolean
  rubric?: string
  sampleAnswer?: string
  explanation?: string
}

export interface PublishedExam {
  id: string
  ownerUid: string
  teacherName: string
  templateId: string
  templateName: string
  title: string
  schoolFormatLabel: string
  accessCode: string
  status: 'published' | 'closed'
  durationMinutes: number
  totalPoints: number
  part1Count: number
  part1Points: number
  part2Count: number
  part2Points: number
  part2ScoringMode: Part2ScoringMode
  part3Count: number
  part3Points: number
  recognitionPct: number
  understandingPct: number
  applicationPct: number
  questions: SanitizedExamQuestion[]
  sealedGradingPayload: string
  createdAtMs: number | null
  updatedAtMs: number | null
}

export interface PublishedExamKey {
  id: string
  ownerUid: string
  examId: string
  title: string
  items: PublishedExamKeyItem[]
  createdAtMs: number | null
  updatedAtMs: number | null
}

export interface StudentAnswerInput {
  questionId: string
  questionType: QuestionType
  selectedOption?: AnswerOptionKey | null
  statementChoices?: {
    a: boolean | null
    b: boolean | null
    c: boolean | null
    d: boolean | null
  }
  essayText?: string
}

export interface GradedSubmissionAnswer {
  questionId: string
  part: 1 | 2 | 3
  questionType: QuestionType
  questionText?: string
  maxPoints: number
  earnedPoints: number | null
  selectedOption?: AnswerOptionKey | null
  correctOption?: AnswerOptionKey | null
  statementChoices?: {
    a: boolean | null
    b: boolean | null
    c: boolean | null
    d: boolean | null
  }
  correctStatements?: {
    a: boolean
    b: boolean
    c: boolean
    d: boolean
  }
  trueFalseCorrectCount?: number
  essayText?: string
  aiSuggestedScore?: number | null
  aiConfidence?: 'high' | 'uncertain' | 'unavailable'
  needsTeacherReview?: boolean
  aiFeedback?: string
  teacherScore?: number | null
  teacherComment?: string
  explanation?: string
}

export interface ServerGradeResponse {
  ok: true
  examId: string
  part1Score: number
  part1Max: number
  part2Score: number
  part2Max: number
  part3AiScore: number | null
  part3Max: number
  totalObjectiveScore: number
  totalProvisionalScore: number | null
  totalMax: number
  gradingStatus: 'auto_graded' | 'needs_teacher_review'
  aiEssayStatus: 'graded' | 'uncertain_review_required' | 'not_configured' | 'error' | 'no_essay'
  aiNotice: string | null
  gradedAnswers: GradedSubmissionAnswer[]
}

export type SubmissionGradingStatus =
  | 'auto_graded'
  | 'needs_teacher_review'
  | 'teacher_reviewed'

export interface ExamSubmissionRecord {
  id: string
  examId: string
  teacherUid: string
  studentUid: string
  studentName: string
  studentClass: string
  studentEmail: string
  examTitle: string
  part1Score: number
  part1Max: number
  part2Score: number
  part2Max: number
  part3AiScore: number | null
  part3FinalScore: number | null
  part3Max: number
  totalScore: number | null
  totalMax: number
  gradingStatus: SubmissionGradingStatus
  answers: GradedSubmissionAnswer[]
  teacherFeedback: string
  submittedAtMs: number | null
  reviewedAtMs: number | null
}

export type UserRole = 'super_admin' | 'student'

export type AdminAuthorizationStatus = 'pending_activation' | 'active' | 'revoked'

export interface AuthenticatedAccountProfile {
  uid: string
  email: string
  displayName: string
  emailVerified: boolean
  role: UserRole
  roleSource: string
  status: string
  permissions: string[]
  isSuperAdmin: boolean
  dbSyncStatus?: 'synced' | 'allowlist_only' | 'skipped'
}

export interface AdministratorRecord {
  id: number
  email: string
  assignedRole: 'super_admin'
  status: AdminAuthorizationStatus
  isBootstrap: boolean
  note: string
  grantedByUid: string
  grantedByEmail: string
  activatedUid: string | null
  activatedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RoleDefinitionRecord {
  role: UserRole
  displayName: string
  description: string
  permissions: string[]
  updatedAt: string
}

export interface AdminAuditLogRecord {
  id: number
  actorUid: string
  actorEmail: string
  action: string
  targetEmail: string
  details: Record<string, unknown>
  createdAt: string
}

export interface SystemSettingsOverview {
  databaseEngine: 'PostgreSQL (Cloud SQL)' | 'PostgreSQL (Neon Serverless)'
  emailConfigured: boolean
  objectStorage: ObjectStorageStatusInfo
  roleDefinitions: RoleDefinitionRecord[]
  counts: {
    totalUsers: number
    superAdminsActive: number
    superAdminsPending: number
    totalDocuments: number
    totalExamAttempts: number
  }
}

export type ExamAttemptKind = 'practice' | 'published'

export type AttemptCompletionStatus =
  | 'in_progress'
  | 'auto_graded'
  | 'needs_review'
  | 'reviewed'

export interface AttemptDetailedAnswer {
  questionId: string
  part: 1 | 2 | 3
  questionType: QuestionType
  questionText: string
  topic?: string
  maxPoints: number
  earnedPoints: number | null
  selectedOption?: AnswerOptionKey | null
  correctOption?: AnswerOptionKey | null
  selectedOptionText?: string
  correctOptionText?: string
  statementChoices?: {
    a: boolean | null
    b: boolean | null
    c: boolean | null
    d: boolean | null
  }
  correctStatements?: {
    a: boolean
    b: boolean
    c: boolean
    d: boolean
  }
  trueFalseCorrectCount?: number
  essayText?: string
  aiSuggestedScore?: number | null
  aiConfidence?: 'high' | 'uncertain' | 'unavailable'
  needsAdminReview?: boolean
  aiFeedback?: string
  adminScore?: number | null
  adminComment?: string
  explanation?: string
}

export interface StudentAttemptRecord {
  id: number
  attemptId: string
  examId: string
  examTitle: string
  examKind: ExamAttemptKind
  accessCode: string
  studentName: string
  studentNameNormalized: string
  className: string
  rawClassName: string
  startedAt: string
  submittedAt: string | null
  durationSeconds?: number | null
  completionStatus: AttemptCompletionStatus
  scoringMode: string
  part1Score: number
  part1Max: number
  part2Score: number
  part2Max: number
  part3Score: number | null
  part3Max: number
  score: number | null
  maxScore: number
  detailedAnswers: AttemptDetailedAnswer[]
  adminFeedback: string
  reviewedByEmail: string | null
  reviewedAt: string | null
}

export interface ClassPerformanceStat {
  className: string
  attemptCount: number
  gradedCount: number
  studentIdentityCount: number
  averageScore: number | null
  minScore: number | null
  maxScore: number | null
}

export interface ExamPerformanceStat {
  examId: string
  examTitle: string
  examKind: ExamAttemptKind
  attemptCount: number
  gradedCount: number
  averageScore: number | null
  maxScore: number
}

export interface StudentProgressSummary {
  identityKey: string
  studentName: string
  className: string
  attemptCount: number
  gradedCount: number
  latestScore: number | null
  bestScore: number | null
  averageScore: number | null
  firstScore: number | null
  scoreDelta: number | null
  attempts: {
    attemptId: string
    examTitle: string
    score: number | null
    maxScore: number
    submittedAt: string | null
    startedAt: string
    completionStatus: AttemptCompletionStatus
  }[]
}

export interface AdminStudentResultsResponse {
  ok: true
  attempts: StudentAttemptRecord[]
  totalCount: number
  classStats: ClassPerformanceStat[]
  examStats: ExamPerformanceStat[]
  studentProgress: StudentProgressSummary[]
  availableClasses: string[]
  availableExams: { examId: string; examTitle: string; examKind: ExamAttemptKind }[]
}

export interface TeacherAllowlistEntry {
  id: number
  email: string
  note: string
  grantedByUid: string
  createdAt: string
}

export type DocumentProcessingStatus =
  | 'Uploaded'
  | 'Pending analysis'
  | 'Processing'
  | 'Completed'
  | 'Needs review'
  | 'Failed'

export type DocumentFileExtension = 'pdf' | 'docx' | 'txt'

export interface DocumentAiAgentHookDto {
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

export type DriveFolderKey =
  | 'ROOT'
  | '01_TAI_LIEU_GOC'
  | '02_FILE_DAP_AN'
  | '03_TAI_LIEU_TONG_HOP'
  | '04_DE_THI'
  | '05_BAO_CAO'

export type DriveSubfolderKey = Exclude<DriveFolderKey, 'ROOT'>

export interface GoogleDriveFolderRecord {
  folderKey: DriveFolderKey
  folderName: string
  driveFolderId: string
  parentDriveFolderId: string | null
  folderPath: string
  webViewLink: string | null
  ownerEmail: string
  verifiedAt: string
}

export interface GoogleDriveConnectionInfo {
  configured: boolean
  connected: boolean
  oauthClientIdConfigured: boolean
  targetStorageEmail: string
  connectedAccountEmail: string | null
  connectedDisplayName: string | null
  scope: string
  authMode: 'oauth_session_token'
  rootFolderName: string
  foldersInitialized: boolean
  folders: GoogleDriveFolderRecord[]
  storageQuota?: {
    limitBytes: number | null
    usageBytes: number | null
    usageInDriveBytes: number | null
  } | null
  message: string
  errorCode?: string | null
}

export interface GoogleDriveSelfTestResult {
  ok: boolean
  testedAt: string
  accountEmail: string
  rootFolderPath: string
  targetFolderKey: DriveSubfolderKey
  targetFolderPath: string
  targetFolderId: string
  uploadedFileId: string
  uploadedFileName: string
  uploadedSizeBytes: number
  readBackSizeBytes: number
  sizeMatched: boolean
  sha256Matched: boolean
  sha256: string
  mimeType: string
  webViewLink: string | null
  documentId: string | null
  steps: {
    step: string
    status: 'passed' | 'failed'
    detail: string
  }[]
}

export interface ObjectStorageStatusInfo {
  configured: boolean
  provider: 'google_drive' | 's3' | 'gcs' | null
  bucket: string | null
  endpoint: string | null
  missingRequirements: string[]
  message: string
  drive?: GoogleDriveConnectionInfo
}

export type DocumentApprovalStatus = 'not_extracted' | 'pending' | 'partial' | 'approved'

export interface TeacherDocumentRecord {
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
  driveFileId: string | null
  driveFolderKey: DriveSubfolderKey | null
  driveFolderId: string | null
  driveFolderPath: string | null
  driveWebViewLink: string | null
  driveVerifiedAt: string | null
  driveOwnerEmail: string | null
  hasOriginalFile: boolean
  originalFileStatusLabel: string
  extractedQuestionCount: number
  approvedQuestionCount: number
  approvalStatus: DocumentApprovalStatus
  approvalStatusLabel: string
  linkedDraftId: string | null
  recordOrigin: 'document' | 'legacy_draft'
  processingStatus: DocumentProcessingStatus
  statusNote: string
  aiAgentHook: DocumentAiAgentHookDto
  lastStatusUpdatedAt: string
  createdAt: string
  updatedAt: string
}


