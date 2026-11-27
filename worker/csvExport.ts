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
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
}

function formatDurationVi(
  startedAt: string,
  submittedAt: string | null,
  durationSeconds?: number | null
): string {
  let secs = durationSeconds ?? null
  if (secs === null && submittedAt) {
    const startMs = new Date(startedAt).getTime()
    const endMs = new Date(submittedAt).getTime()
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) {
      secs = Math.round((endMs - startMs) / 1000)
    }
  }
  if (secs === null || secs < 0) return ''
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
      val === true ? 'Đúng' : val === false ? 'Sai' : '-'
    return `a:${fmt(ch.a)} | b:${fmt(ch.b)} | c:${fmt(ch.c)} | d:${fmt(ch.d)}`
  }
  return ans.essayText?.trim() || '(Bỏ trống)'
}

function summarizeCorrectAnswer(ans: AttemptDetailedAnswer): string {
  if (ans.questionType === 'multiple_choice') {
    if (!ans.correctOption) return ''
    return ans.correctOptionText
      ? `${ans.correctOption}. ${ans.correctOptionText}`
      : ans.correctOption
  }
  if (ans.questionType === 'true_false') {
    const st = ans.correctStatements
    if (!st) return ''
    const fmt = (val: boolean) => (val ? 'Đúng' : 'Sai')
    return `a:${fmt(st.a)} | b:${fmt(st.b)} | c:${fmt(st.c)} | d:${fmt(st.d)}`
  }
  return 'Chấm theo biểu điểm (Rubric)'
}

/**
 * Escapes a single CSV cell per RFC 4180 and mitigates Excel formula injection
 * for text values starting with =, +, -, @, tab, or CR.
 */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : ''
  }
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(',')
}

/**
 * Builds an Excel-ready UTF-8 CSV (with UTF-8 BOM `\uFEFF` and CRLF line endings)
 * so Vietnamese diacritics display accurately when double-clicked in Microsoft Excel.
 */
export function buildStudentResultsCsvUtf8(params: {
  data: AdminStudentResultsResponse
  includeDetailedAnswers: boolean
}): string {
  const { data, includeDetailedAnswers } = params
  const lines: string[] = []

  if (!includeDetailedAnswers) {
    lines.push(
      csvRow([
        'STT',
        'Mã lượt thi (Attempt ID)',
        'Họ và tên học sinh',
        'Lớp',
        'Mã đề thi',
        'Tên bài thi / Đề thi',
        'Loại đề',
        'Thời điểm bắt đầu',
        'Thời điểm nộp bài',
        'Thời gian làm bài',
        'Phần I (TN)',
        'Phần II (Đ/S)',
        'Phần III (TL)',
        'Tổng điểm',
        'Thang điểm',
        'Trạng thái',
        'Người duyệt',
        'Nhận xét của Admin',
      ])
    )

    data.attempts.forEach((att, idx) => {
      lines.push(
        csvRow([
          idx + 1,
          att.attemptId,
          att.studentName,
          att.className,
          att.examId,
          att.examTitle,
          att.examKind === 'published' ? 'Đề chính thức' : 'Đề luyện tập',
          formatViDateTime(att.startedAt),
          formatViDateTime(att.submittedAt),
          formatDurationVi(att.startedAt, att.submittedAt, att.durationSeconds),
          att.part1Max > 0 ? att.part1Score : '',
          att.part2Max > 0 ? att.part2Score : '',
          att.part3Max > 0 ? (att.part3Score ?? '') : '',
          att.score ?? '',
          att.maxScore,
          STATUS_LABELS[att.completionStatus],
          att.reviewedByEmail ?? '',
          att.adminFeedback || '',
        ])
      )
    })
  } else {
    lines.push(
      csvRow([
        'Mã lượt thi (Attempt ID)',
        'Họ và tên học sinh',
        'Lớp',
        'Đề thi',
        'Thời điểm nộp bài',
        'Thời gian làm bài',
        'Phần',
        'Mã câu hỏi',
        'Dạng câu hỏi',
        'Nội dung câu hỏi',
        'Câu trả lời của học sinh',
        'Đáp án chuẩn',
        'Điểm đạt được',
        'Điểm tối đa',
        'Tổng điểm bài thi',
        'Trạng thái bài thi',
        'Nhận xét / Giải thích',
      ])
    )

    for (const att of data.attempts) {
      const submittedStr = formatViDateTime(att.submittedAt)
      const durationStr = formatDurationVi(
        att.startedAt,
        att.submittedAt,
        att.durationSeconds
      )
      const statusStr = STATUS_LABELS[att.completionStatus]

      if (att.detailedAnswers.length === 0) {
        lines.push(
          csvRow([
            att.attemptId,
            att.studentName,
            att.className,
            att.examTitle,
            submittedStr,
            durationStr,
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            att.score ?? '',
            statusStr,
            att.adminFeedback || '',
          ])
        )
        continue
      }

      for (const ans of att.detailedAnswers) {
        lines.push(
          csvRow([
            att.attemptId,
            att.studentName,
            att.className,
            att.examTitle,
            submittedStr,
            durationStr,
            `Phần ${ans.part}`,
            ans.questionId,
            ans.questionType === 'multiple_choice'
              ? 'Trắc nghiệm'
              : ans.questionType === 'true_false'
              ? 'Đúng/Sai'
              : 'Tự luận',
            ans.questionText || '',
            summarizeStudentAnswer(ans),
            summarizeCorrectAnswer(ans),
            ans.earnedPoints ?? '',
            ans.maxPoints,
            att.score ?? '',
            statusStr,
            ans.adminComment || ans.aiFeedback || ans.explanation || '',
          ])
        )
      }
    }
  }

  return `\uFEFF${lines.join('\r\n')}\r\n`
}
