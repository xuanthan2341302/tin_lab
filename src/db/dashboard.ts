import { desc } from 'drizzle-orm'
import { getFirestore } from 'firebase-admin/firestore'
import { getApp, getApps, initializeApp } from 'firebase-admin/app'
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' }
import { db } from './index.ts'
import { examAttempts, questionImportDrafts, teacherDocuments } from './schema.ts'
import { wrapDbError } from './attempts.ts'
import type {
  ExtractedQuestion,
  RealDashboardActivityItem,
  RealDashboardMetricsResponse,
  RealExamStatsItem,
  RealTopicDistributionItem,
} from '../types.ts'

function round2(val: number): number {
  return Math.round(val * 100) / 100
}

function isExtractedQuestionException(q: ExtractedQuestion): boolean {
  if (q.skippedInImport) return false
  if (q.duplicateInFile || q.duplicateInBank) return true
  if (q.answerStatus !== 'verified') return true

  if (q.questionType === 'multiple_choice') {
    if (!q.answerKey || !['A', 'B', 'C', 'D'].includes(q.answerKey)) return true
    if (!q.optionA?.trim() || !q.optionB?.trim() || !q.optionC?.trim() || !q.optionD?.trim()) {
      return true
    }
  } else if (q.questionType === 'true_false') {
    if (
      q.statementAnswerA === null ||
      q.statementAnswerB === null ||
      q.statementAnswerC === null ||
      q.statementAnswerD === null
    ) {
      return true
    }
  } else if (q.questionType === 'essay') {
    if (!q.rubric || q.rubric.trim().length < 5) return true
  }

  return false
}

function normalizeTopicLabel(topic?: string | null, lessonTitle?: string | null): string {
  const cleanTopic = (topic ?? '').trim()
  if (cleanTopic) return cleanTopic
  const cleanLesson = (lessonTitle ?? '').trim()
  if (cleanLesson) return cleanLesson
  return 'Chưa phân chuyên đề'
}

interface FirestoreRealCounts {
  available: boolean
  notice: string | null
  approvedBankQuestionsCount: number | null
  publishedExamsCount: number | null
  approvedTopics: Map<string, number>
  publishedExamsList: {
    id: string
    title: string
    accessCode: string
    status: string
    totalQuestions: number
    durationMinutes: number
  }[]
}

async function fetchFirestoreRealCountsSafe(): Promise<FirestoreRealCounts> {
  const approvedTopics = new Map<string, number>()
  const publishedExamsList: FirestoreRealCounts['publishedExamsList'] = []

  try {
    const app = getApps().length
      ? getApp()
      : initializeApp({ projectId: firebaseConfig.projectId })
    const configuredDbId = (firebaseConfig as { firestoreDatabaseId?: string }).firestoreDatabaseId
    const fsDb =
      configuredDbId && configuredDbId !== '(default)'
        ? getFirestore(app, configuredDbId)
        : getFirestore(app)

    const [bankSnap, examsSnap] = await Promise.all([
      fsDb.collection('questionBank').select('topic', 'lessonTitle').get(),
      fsDb
        .collection('publishedExams')
        .select('title', 'accessCode', 'status', 'durationMinutes', 'part1Count', 'part2Count', 'part3Count')
        .get(),
    ])

    for (const docSnap of bankSnap.docs) {
      const d = docSnap.data()
      const label = normalizeTopicLabel(
        typeof d.topic === 'string' ? d.topic : '',
        typeof d.lessonTitle === 'string' ? d.lessonTitle : ''
      )
      approvedTopics.set(label, (approvedTopics.get(label) ?? 0) + 1)
    }

    let openPublishedCount = 0
    for (const docSnap of examsSnap.docs) {
      const d = docSnap.data()
      const status = typeof d.status === 'string' ? d.status : 'published'
      if (status === 'published') {
        openPublishedCount += 1
      }
      const totalQuestions =
        Number(d.part1Count ?? 0) + Number(d.part2Count ?? 0) + Number(d.part3Count ?? 0)
      publishedExamsList.push({
        id: docSnap.id,
        title: typeof d.title === 'string' ? d.title : docSnap.id,
        accessCode: typeof d.accessCode === 'string' ? d.accessCode : '',
        status,
        totalQuestions,
        durationMinutes: Number(d.durationMinutes ?? 45),
      })
    }

    return {
      available: true,
      notice: null,
      approvedBankQuestionsCount: bankSnap.size,
      publishedExamsCount: openPublishedCount,
      approvedTopics,
      publishedExamsList,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[TIN LAB] Server Firestore read skipped for dashboard metrics:', msg.slice(0, 200))
    return {
      available: false,
      notice:
        'Chưa thể đọc đồng bộ trực tiếp từ Cloud Firestore ở phía máy chủ; các chỉ số ngân hàng chính thức và đề thi xuất bản sẽ được đồng bộ từ phiên Firestore trên trình duyệt khi khả dụng.',
      approvedBankQuestionsCount: null,
      publishedExamsCount: null,
      approvedTopics,
      publishedExamsList,
    }
  }
}

export async function getRealDashboardMetrics(options: {
  includeAdminDetails: boolean
}): Promise<RealDashboardMetricsResponse> {
  const firestoreData = await fetchFirestoreRealCountsSafe()

  let postgresAvailable = true
  let postgresNotice: string | null = null
  let postgresErrorCode: string | null = null

  let uploadedDocumentsCount = 0
  let draftBatchesCount = 0
  let extractedQuestionsCount = 0
  let draftQuestionsCount = 0
  let exceptionQuestionsCount = 0
  let readyDraftQuestionsCount = 0
  let committedDraftQuestionsCount = 0

  let studentAttemptsTotal = 0
  let studentAttemptsCompleted = 0
  let studentAttemptsInProgress = 0
  let studentAttemptsGraded = 0
  let studentAttemptsNeedsReview = 0
  let averageScore: number | null = null
  let completionRate: number | null = null

  const topicMap = new Map<
    string,
    {
      topicName: string
      extractedCount: number
      draftCount: number
      exceptionCount: number
      approvedBankCount: number
    }
  >()

  const ensureTopic = (topicName: string) => {
    let entry = topicMap.get(topicName)
    if (!entry) {
      entry = {
        topicName,
        extractedCount: 0,
        draftCount: 0,
        exceptionCount: 0,
        approvedBankCount: 0,
      }
      topicMap.set(topicName, entry)
    }
    return entry
  }

  // Merge Firestore approved bank topic counts first (if server Firestore read succeeded)
  for (const [topicName, countVal] of firestoreData.approvedTopics.entries()) {
    const entry = ensureTopic(topicName)
    entry.approvedBankCount += countVal
  }

  const examPerformance: RealExamStatsItem[] = []
  const recentActivities: RealDashboardActivityItem[] = []

  try {
    const [docRows, draftRows, attemptRows] = await Promise.all([
      db
        .select({
          id: teacherDocuments.id,
          originalFilename: teacherDocuments.originalFilename,
          processingStatus: teacherDocuments.processingStatus,
          createdAt: teacherDocuments.createdAt,
        })
        .from(teacherDocuments)
        .orderBy(desc(teacherDocuments.createdAt)),
      db
        .select({
          id: questionImportDrafts.id,
          title: questionImportDrafts.title,
          sourceDocumentName: questionImportDrafts.sourceDocumentName,
          status: questionImportDrafts.status,
          questions: questionImportDrafts.questions,
          updatedAt: questionImportDrafts.updatedAt,
        })
        .from(questionImportDrafts)
        .orderBy(desc(questionImportDrafts.updatedAt)),
      db
        .select({
          id: examAttempts.id,
          examId: examAttempts.examId,
          examTitle: examAttempts.examTitle,
          examKind: examAttempts.examKind,
          startedAt: examAttempts.startedAt,
          submittedAt: examAttempts.submittedAt,
          completionStatus: examAttempts.completionStatus,
          score: examAttempts.score,
          maxScore: examAttempts.maxScore,
        })
        .from(examAttempts)
        .orderBy(desc(examAttempts.startedAt)),
    ])

    uploadedDocumentsCount = docRows.length
    draftBatchesCount = draftRows.length

    for (const draft of draftRows) {
      const qs = Array.isArray(draft.questions) ? draft.questions : []
      extractedQuestionsCount += qs.length
      const isDraftBatch = draft.status === 'draft'
      const isCommittedBatch = draft.status === 'committed'

      for (const q of qs) {
        const topicName = normalizeTopicLabel(q.topic, q.lessonTitle)
        const topicEntry = ensureTopic(topicName)
        topicEntry.extractedCount += 1

        if (isCommittedBatch) {
          if (!q.skippedInImport && q.reviewDecision === 'approved') {
            committedDraftQuestionsCount += 1
          }
        } else if (isDraftBatch && !q.skippedInImport) {
          draftQuestionsCount += 1
          topicEntry.draftCount += 1
          if (isExtractedQuestionException(q)) {
            exceptionQuestionsCount += 1
            topicEntry.exceptionCount += 1
          } else {
            readyDraftQuestionsCount += 1
          }
        }
      }
    }

    // Aggregate real student attempt metrics (zero PII exposed on public route)
    studentAttemptsTotal = attemptRows.length
    let normalizedScore10Sum = 0

    const examAggMap = new Map<
      string,
      {
        examId: string
        examTitle: string
        examKind: 'practice' | 'published'
        attemptCount: number
        completedCount: number
        gradedCount: number
        scoreSum: number
        maxScore: number
      }
    >()

    for (const att of attemptRows) {
      const isCompleted =
        att.submittedAt !== null ||
        att.completionStatus === 'auto_graded' ||
        att.completionStatus === 'needs_review' ||
        att.completionStatus === 'reviewed'

      if (isCompleted) {
        studentAttemptsCompleted += 1
      } else {
        studentAttemptsInProgress += 1
      }

      if (att.completionStatus === 'needs_review') {
        studentAttemptsNeedsReview += 1
      }

      const maxSc = Number(att.maxScore ?? 10) > 0 ? Number(att.maxScore ?? 10) : 10
      const hasScore = att.score !== null && att.score !== undefined && Number.isFinite(Number(att.score))
      if (hasScore) {
        studentAttemptsGraded += 1
        normalizedScore10Sum += (Number(att.score) / maxSc) * 10
      }

      let ex = examAggMap.get(att.examId)
      if (!ex) {
        ex = {
          examId: att.examId,
          examTitle: att.examTitle,
          examKind: att.examKind === 'published' ? 'published' : 'practice',
          attemptCount: 0,
          completedCount: 0,
          gradedCount: 0,
          scoreSum: 0,
          maxScore: maxSc,
        }
        examAggMap.set(att.examId, ex)
      }
      ex.attemptCount += 1
      if (isCompleted) ex.completedCount += 1
      if (hasScore) {
        ex.gradedCount += 1
        ex.scoreSum += Number(att.score)
      }
    }

    if (studentAttemptsGraded > 0) {
      averageScore = round2(normalizedScore10Sum / studentAttemptsGraded)
    }
    if (studentAttemptsTotal > 0) {
      completionRate = Math.round((studentAttemptsCompleted / studentAttemptsTotal) * 100)
    }

    for (const ex of examAggMap.values()) {
      examPerformance.push({
        examId: ex.examId,
        examTitle: ex.examTitle,
        examKind: ex.examKind,
        attemptCount: ex.attemptCount,
        completedCount: ex.completedCount,
        gradedCount: ex.gradedCount,
        averageScore: ex.gradedCount > 0 ? round2(ex.scoreSum / ex.gradedCount) : null,
        completionRate:
          ex.attemptCount > 0 ? Math.round((ex.completedCount / ex.attemptCount) * 100) : null,
        maxScore: ex.maxScore,
      })
    }
    examPerformance.sort((a, b) => b.attemptCount - a.attemptCount)

    // Real admin-only activity feed (never leaks filenames/drafts to anonymous visitors)
    if (options.includeAdminDetails) {
      for (const d of docRows.slice(0, 4)) {
        recentActivities.push({
          id: `doc-${d.id}`,
          kind: 'document',
          title: d.originalFilename,
          detail: `Tài liệu đã tải lên · Trạng thái: ${d.processingStatus}`,
          timestamp: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt),
        })
      }
      for (const dr of draftRows.slice(0, 4)) {
        const countQ = Array.isArray(dr.questions) ? dr.questions.length : 0
        recentActivities.push({
          id: `draft-${dr.id}`,
          kind: 'draft',
          title: dr.title || dr.sourceDocumentName,
          detail: `Bản nháp câu hỏi (${countQ} câu · ${dr.status})`,
          timestamp: dr.updatedAt instanceof Date ? dr.updatedAt.toISOString() : String(dr.updatedAt),
        })
      }
      recentActivities.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    }
  } catch (err) {
    const classified = wrapDbError(
      'Không thể truy vấn số liệu thực tế từ PostgreSQL.',
      err
    )
    postgresAvailable = false
    postgresErrorCode = classified.code ?? 'DB_QUERY_FAILED'
    postgresNotice = classified.message
  }

  const topicBreakdown: RealTopicDistributionItem[] = Array.from(topicMap.values()).sort(
    (a, b) =>
      b.approvedBankCount +
      b.extractedCount -
      (a.approvedBankCount + a.extractedCount)
  )

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    dataSources: {
      postgresAvailable,
      postgresErrorCode,
      postgresNotice,
      firestoreAvailable: firestoreData.available,
      firestoreNotice: firestoreData.notice,
      postgresTables: ['teacher_documents', 'question_import_drafts', 'exam_attempts'],
      firestoreCollections: ['questionBank', 'publishedExams'],
    },
    metrics: {
      uploadedDocumentsCount,
      draftBatchesCount,
      extractedQuestionsCount,
      draftQuestionsCount,
      exceptionQuestionsCount,
      readyDraftQuestionsCount,
      committedDraftQuestionsCount,
      approvedBankQuestionsCount: firestoreData.approvedBankQuestionsCount,
      publishedExamsCount: firestoreData.publishedExamsCount,
      studentAttemptsTotal,
      studentAttemptsCompleted,
      studentAttemptsInProgress,
      studentAttemptsGraded,
      studentAttemptsNeedsReview,
      averageScore,
      completionRate,
    },
    topicBreakdown,
    examPerformance,
    recentActivities: recentActivities.slice(0, 6),
  }
}
