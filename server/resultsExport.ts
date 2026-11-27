import ExcelJS from 'exceljs'
import type {
  AdminStudentResultsResponse,
  AttemptCompletionStatus,
  AttemptDetailedAnswer,
} from '../src/types.ts'

const STATUS_LABELS: Record<AttemptCompletionStatus, string> = {
  in_progress: 'Đang làm bài',
  auto_graded: 'Đã chấm tự động',
  needs_review: 'Chờ Super Admin duyệt',
  reviewed: 'Đã duyệt điểm',
}

function formatViDateTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
}

function formatDurationVi(startedAt: string, submittedAt: string | null, durationSeconds?: number | null): string {
  let secs = durationSeconds ?? null
  if (secs === null && submittedAt) {
    const startMs = new Date(startedAt).getTime()
    const endMs = new Date(submittedAt).getTime()
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) {
      secs = Math.round((endMs - startMs) / 1000)
    }
  }
  if (secs === null || secs < 0) return '—'
  const hours = Math.floor(secs / 3600)
  const minutes = Math.floor((secs % 3600) / 60)
  const remSeconds = secs % 60
  if (hours > 0) {
    return `${hours} giờ ${String(minutes).padStart(2, '0')} phút`
  }
  if (minutes > 0) {
    return `${minutes} phút ${String(remSeconds).padStart(2, '0')} giây`
  }
  return `${remSeconds} giây`
}

function summarizeStudentAnswer(ans: AttemptDetailedAnswer): string {
  if (ans.questionType === 'multiple_choice') {
    if (!ans.selectedOption) return '(Bỏ trống)'
    return ans.selectedOptionText
      ? `${ans.selectedOption}. ${ans.selectedOptionText}`
      : ans.selectedOption
  }
  if (ans.questionType === 'true_false') {
    const ch = ans.statementChoices
    if (!ch) return '(Bỏ trống)'
    const fmt = (val: boolean | null | undefined) =>
      val === true ? 'Đúng' : val === false ? 'Sai' : '—'
    return `a:${fmt(ch.a)} | b:${fmt(ch.b)} | c:${fmt(ch.c)} | d:${fmt(ch.d)}`
  }
  return ans.essayText?.trim() || '(Bỏ trống)'
}

function summarizeCorrectAnswer(ans: AttemptDetailedAnswer): string {
  if (ans.questionType === 'multiple_choice') {
    if (!ans.correctOption) return '—'
    return ans.correctOptionText
      ? `${ans.correctOption}. ${ans.correctOptionText}`
      : ans.correctOption
  }
  if (ans.questionType === 'true_false') {
    const st = ans.correctStatements
    if (!st) return '—'
    const fmt = (val: boolean) => (val ? 'Đúng' : 'Sai')
    return `a:${fmt(st.a)} | b:${fmt(st.b)} | c:${fmt(st.c)} | d:${fmt(st.d)}`
  }
  return 'Chấm theo biểu điểm (Rubric)'
}

export async function buildStudentResultsWorkbookBuffer(params: {
  data: AdminStudentResultsResponse
  includeDetailedAnswers: boolean
}): Promise<Buffer> {
  const { data, includeDetailedAnswers } = params
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'TIN LAB Super Admin'
  workbook.created = new Date()

  // Sheet 1: Filtered Student Attempts Summary
  const summarySheet = workbook.addWorksheet('Ket_qua_hoc_sinh', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  summarySheet.columns = [
    { header: 'STT', key: 'stt', width: 7 },
    { header: 'Mã lượt thi (Attempt ID)', key: 'attemptId', width: 38 },
    { header: 'Họ và tên học sinh', key: 'studentName', width: 26 },
    { header: 'Lớp', key: 'className', width: 14 },
    { header: 'Mã đề thi', key: 'examId', width: 22 },
    { header: 'Tên bài thi / Đề thi', key: 'examTitle', width: 36 },
    { header: 'Loại đề', key: 'examKind', width: 14 },
    { header: 'Thời điểm bắt đầu', key: 'startedAt', width: 22 },
    { header: 'Thời điểm nộp bài', key: 'submittedAt', width: 22 },
    { header: 'Thời gian làm bài', key: 'duration', width: 18 },
    { header: 'Phần I (TN)', key: 'part1Score', width: 12 },
    { header: 'Phần II (Đ/S)', key: 'part2Score', width: 13 },
    { header: 'Phần III (TL)', key: 'part3Score', width: 13 },
    { header: 'Tổng điểm', key: 'score', width: 12 },
    { header: 'Thang điểm', key: 'maxScore', width: 12 },
    { header: 'Trạng thái', key: 'status', width: 22 },
    { header: 'Nhận xét của Admin', key: 'adminFeedback', width: 32 },
  ]

  const headerRow1 = summarySheet.getRow(1)
  headerRow1.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow1.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF123B68' },
  }
  headerRow1.alignment = { vertical: 'middle', horizontal: 'center' }
  headerRow1.height = 24

  data.attempts.forEach((att, idx) => {
    summarySheet.addRow({
      stt: idx + 1,
      attemptId: att.attemptId,
      studentName: att.studentName,
      className: att.className,
      examId: att.examId,
      examTitle: att.examTitle,
      examKind: att.examKind === 'published' ? 'Đề chính thức' : 'Đề luyện tập',
      startedAt: formatViDateTime(att.startedAt),
      submittedAt: formatViDateTime(att.submittedAt),
      duration: formatDurationVi(att.startedAt, att.submittedAt, att.durationSeconds),
      part1Score: att.part1Max > 0 ? att.part1Score : null,
      part2Score: att.part2Max > 0 ? att.part2Score : null,
      part3Score: att.part3Max > 0 ? att.part3Score : null,
      score: att.score,
      maxScore: att.maxScore,
      status: STATUS_LABELS[att.completionStatus],
      adminFeedback: att.adminFeedback || '',
    })
  })

  // Sheet 2: Class & Exam Statistics
  const statsSheet = workbook.addWorksheet('Thong_ke_lop_va_de', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  statsSheet.columns = [
    { header: 'Nhóm thống kê', key: 'group', width: 18 },
    { header: 'Tên lớp / Tên đề thi', key: 'name', width: 36 },
    { header: 'Số lượt làm bài', key: 'attemptCount', width: 16 },
    { header: 'Số bài có điểm', key: 'gradedCount', width: 16 },
    { header: 'Số học sinh', key: 'studentCount', width: 14 },
    { header: 'Điểm trung bình', key: 'averageScore', width: 16 },
    { header: 'Thấp nhất', key: 'minScore', width: 12 },
    { header: 'Cao nhất / Tối đa', key: 'maxScore', width: 18 },
  ]

  const headerRow2 = statsSheet.getRow(1)
  headerRow2.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow2.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2878B8' },
  }
  headerRow2.height = 24

  for (const c of data.classStats) {
    statsSheet.addRow({
      group: 'Theo lớp',
      name: c.className,
      attemptCount: c.attemptCount,
      gradedCount: c.gradedCount,
      studentCount: c.studentIdentityCount,
      averageScore: c.averageScore,
      minScore: c.minScore,
      maxScore: c.maxScore,
    })
  }

  for (const e of data.examStats) {
    statsSheet.addRow({
      group: 'Theo đề thi',
      name: e.examTitle,
      attemptCount: e.attemptCount,
      gradedCount: e.gradedCount,
      studentCount: null,
      averageScore: e.averageScore,
      minScore: null,
      maxScore: e.maxScore,
    })
  }

  // Sheet 3 (Optional): Detailed Per-Question Answer Records
  if (includeDetailedAnswers) {
    const detailSheet = workbook.addWorksheet('Chi_tiet_cau_tra_loi', {
      views: [{ state: 'frozen', ySplit: 1 }],
    })

    detailSheet.columns = [
      { header: 'Mã lượt thi (Attempt ID)', key: 'attemptId', width: 38 },
      { header: 'Họ và tên', key: 'studentName', width: 24 },
      { header: 'Lớp', key: 'className', width: 12 },
      { header: 'Đề thi', key: 'examTitle', width: 30 },
      { header: 'Phần', key: 'part', width: 8 },
      { header: 'Mã câu hỏi', key: 'questionId', width: 16 },
      { header: 'Dạng câu hỏi', key: 'questionType', width: 16 },
      { header: 'Nội dung câu hỏi', key: 'questionText', width: 42 },
      { header: 'Câu trả lời của học sinh', key: 'studentAnswer', width: 34 },
      { header: 'Đáp án chuẩn', key: 'correctAnswer', width: 34 },
      { header: 'Điểm đạt được', key: 'earnedPoints', width: 14 },
      { header: 'Điểm tối đa', key: 'maxPoints', width: 14 },
      { header: 'Nhận xét / Giải thích', key: 'notes', width: 38 },
    ]

    const headerRow3 = detailSheet.getRow(1)
    headerRow3.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    headerRow3.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF123B68' },
    }
    headerRow3.height = 24

    for (const att of data.attempts) {
      for (const ans of att.detailedAnswers) {
        detailSheet.addRow({
          attemptId: att.attemptId,
          studentName: att.studentName,
          className: att.className,
          examTitle: att.examTitle,
          part: `Phần ${ans.part}`,
          questionId: ans.questionId,
          questionType:
            ans.questionType === 'multiple_choice'
              ? 'Trắc nghiệm'
              : ans.questionType === 'true_false'
              ? 'Đúng/Sai'
              : 'Tự luận',
          questionText: ans.questionText || '',
          studentAnswer: summarizeStudentAnswer(ans),
          correctAnswer: summarizeCorrectAnswer(ans),
          earnedPoints: ans.earnedPoints,
          maxPoints: ans.maxPoints,
          notes: ans.adminComment || ans.aiFeedback || ans.explanation || '',
        })
      }
    }
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}
