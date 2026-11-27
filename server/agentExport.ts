import ExcelJS from 'exceljs'
import type {
  AgentAnalysisSummary,
  AgentMatchMethod,
  AgentUploadedFileReport,
  AnswerStatus,
  CognitiveLevel,
  ExtractedQuestion,
  QuestionType,
  ReviewDecision,
} from '../src/types.ts'

const STATUS_LABELS: Record<AnswerStatus, string> = {
  verified: 'Đã xác định đáp án từ nguồn',
  ai_proposed: 'AI đề xuất (chưa xác nhận)',
  needs_review: 'Cần kiểm tra',
  missing: 'Thiếu đáp án',
  ambiguous: 'Có xung đột đáp án',
}

const COGNITIVE_LABELS: Record<CognitiveLevel, string> = {
  recognition: 'Nhận biết',
  understanding: 'Thông hiểu',
  application: 'Vận dụng',
  unspecified: 'Chưa xác định',
}

const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  multiple_choice: 'Trắc nghiệm 4 lựa chọn',
  true_false: 'Đúng / Sai (4 ý)',
  essay: 'Tự luận',
}

const MATCH_METHOD_LABELS: Record<AgentMatchMethod, string> = {
  question_code: 'Mã câu / Mã bài (Ưu tiên 1)',
  lesson_and_number: 'Cấu trúc Bài học & Số câu (Ưu tiên 2)',
  stem_and_options: 'Nội dung câu & phương án (Ưu tiên 3)',
  context_and_explanation: 'Ngữ cảnh & phần giải thích (Ưu tiên 4)',
  inline_formatting: 'Định dạng trực tiếp (Đậm/Màu/Highlight)',
  embedded_key_table: 'Bảng đáp án nhúng trong tài liệu',
  ai_semantic_match: 'AI Agent đối chiếu ngữ nghĩa',
  ai_generated: 'AI Agent tạo từ tài liệu tổng hợp',
  manual_edit: 'Chỉnh sửa thủ công',
  unmatched: 'Chưa khớp được đáp án',
}

const REVIEW_DECISION_LABELS: Record<ReviewDecision, string> = {
  pending: 'Chờ duyệt',
  approved: 'Đã duyệt',
  rejected: 'Từ chối',
}

const FILE_ROLE_LABELS: Record<AgentUploadedFileReport['assignedRole'], string> = {
  question_file: 'File câu hỏi',
  answer_file: 'File đáp án riêng',
  solution_guide: 'File hướng dẫn giải',
  composite_file: 'Tài liệu tổng hợp',
  reference_file: 'Tài liệu tham khảo',
  irrelevant_file: 'Không liên quan (đã bỏ qua)',
}

const FILE_STATUS_LABELS: Record<AgentUploadedFileReport['status'], string> = {
  queued: 'Đang chờ',
  processing: 'Đang xử lý',
  completed: 'Hoàn tất',
  error: 'Lỗi',
}

function summarizeOptions(q: ExtractedQuestion): string {
  if (q.questionType === 'multiple_choice') {
    return [`A. ${q.optionA}`, `B. ${q.optionB}`, `C. ${q.optionC}`, `D. ${q.optionD}`]
      .filter((s) => s.length > 3)
      .join('\n')
  }
  if (q.questionType === 'true_false') {
    return [
      `a) ${q.statementA}`,
      `b) ${q.statementB}`,
      `c) ${q.statementC}`,
      `d) ${q.statementD}`,
    ]
      .filter((s) => s.length > 3)
      .join('\n')
  }
  return q.rubric ? `Rubric: ${q.rubric}` : 'Câu tự luận'
}

function summarizeConfirmedAnswer(q: ExtractedQuestion): string {
  if (q.questionType === 'multiple_choice') {
    return q.answerKey || 'Chưa chốt'
  }
  if (q.questionType === 'true_false') {
    const f = (v: boolean | null) => (v === true ? 'Đ' : v === false ? 'S' : '?')
    return `a:${f(q.statementAnswerA)} | b:${f(q.statementAnswerB)} | c:${f(
      q.statementAnswerC
    )} | d:${f(q.statementAnswerD)}`
  }
  return q.rubric ? 'Đã có Rubric' : 'Thiếu Rubric'
}

function summarizeAiSuggestion(q: ExtractedQuestion): string {
  const s = q.aiSuggestion
  if (!s) return '—'
  let proposed = ''
  if (q.questionType === 'multiple_choice') {
    proposed = s.suggestedAnswerKey ? `Đề xuất: ${s.suggestedAnswerKey}` : 'Không đủ căn cứ'
  } else if (q.questionType === 'true_false') {
    const f = (v: boolean | null) => (v === true ? 'Đ' : v === false ? 'S' : '?')
    proposed = `Đề xuất: a:${f(s.suggestedStatementA)} b:${f(s.suggestedStatementB)} c:${f(
      s.suggestedStatementC
    )} d:${f(s.suggestedStatementD)}`
  } else {
    proposed = s.suggestedRubric
      ? `Đề xuất Rubric: ${s.suggestedRubric.slice(0, 120)}`
      : 'Không có đề xuất'
  }
  const stateTag = s.applied ? '[Đã áp dụng]' : '[Chờ xác nhận]'
  return `${stateTag} ${proposed} (${s.confidenceScore}% · ${s.reasoning || ''})`.trim()
}

function styleHeaderRow(row: ExcelJS.Row, fgHex = 'FF123B68') {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: fgHex },
  }
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  row.height = 26
}

export async function buildDocumentAgentExcelBuffer(params: {
  title: string
  bankName: string
  agentFiles: AgentUploadedFileReport[]
  agentSummary: AgentAnalysisSummary | null
  questions: ExtractedQuestion[]
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'TIN LAB DOCUMENT AI AGENT'
  workbook.created = new Date()

  // 1. Overview Sheet
  const overviewSheet = workbook.addWorksheet('Tong_quan_AI_Agent', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })
  overviewSheet.columns = [
    { header: 'Hạng mục', key: 'metric', width: 34 },
    { header: 'Giá trị', key: 'value', width: 58 },
  ]
  styleHeaderRow(overviewSheet.getRow(1), 'FF123B68')

  const total = params.questions.length
  const verified = params.questions.filter((q) => q.answerStatus === 'verified').length
  const aiProposed = params.questions.filter((q) => q.answerStatus === 'ai_proposed').length
  const needsReview = params.questions.filter((q) => q.answerStatus === 'needs_review').length
  const missing = params.questions.filter((q) => q.answerStatus === 'missing').length
  const ambiguous = params.questions.filter((q) => q.answerStatus === 'ambiguous').length
  const duplicates = params.questions.filter(
    (q) => q.duplicateInFile || q.duplicateInBank
  ).length
  const avgConfidence =
    params.agentSummary?.averageConfidence ??
    (total > 0
      ? Math.round(
          params.questions.reduce((acc, q) => acc + (q.confidenceScore ?? 0), 0) / total
        )
      : 0)

  const summaryRows: Array<[string, string | number]> = [
    ['Hệ thống xử lý', 'TIN LAB DOCUMENT AI AGENT'],
    ['Tên phiên / Bộ tài liệu', params.title || '—'],
    ['Ngân hàng câu hỏi', params.bankName || 'Chưa đặt tên'],
    ['Thời điểm xuất báo cáo', new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })],
    ['Tổng số file đã xử lý', params.agentSummary?.totalFiles ?? params.agentFiles.length],
    ['Số file hoàn tất / lỗi', `${params.agentSummary?.completedFiles ?? params.agentFiles.filter((f) => f.status === 'completed').length} hoàn tất / ${params.agentSummary?.failedFiles ?? params.agentFiles.filter((f) => f.status === 'error').length} lỗi`],
    ['Tổng số câu hỏi', total],
    ['Đã xác định từ nguồn (verified)', verified],
    ['AI đề xuất chưa xác nhận (ai_proposed)', aiProposed],
    ['Cần kiểm tra (needs_review)', needsReview],
    ['Thiếu đáp án (missing)', missing],
    ['Có xung đột đáp án (ambiguous)', ambiguous],
    ['Câu trùng lặp (tệp / ngân hàng)', duplicates],
    ['Độ tin cậy trung bình', `${avgConfidence}%`],
    ['Trạng thái Gemini AI', params.agentSummary?.aiConnectionState || 'unknown'],
    ['Thông báo lỗi AI (nếu có)', params.agentSummary?.aiErrorMessage || 'Không có'],
  ]

  for (const [metric, value] of summaryRows) {
    overviewSheet.addRow({ metric, value })
  }

  if (params.agentFiles.length > 0) {
    overviewSheet.addRow({ metric: '', value: '' })
    const fileSecHeader = overviewSheet.addRow({
      metric: 'CHI TIẾT CÁC FILE TRONG BỘ TÀI LIỆU',
      value: 'Vai trò · Trạng thái · Số câu / Ghi chú',
    })
    fileSecHeader.font = { bold: true, color: { argb: 'FF123B68' } }

    for (const f of params.agentFiles) {
      const roleLabel = FILE_ROLE_LABELS[f.assignedRole] ?? f.assignedRole
      const statusLabel = FILE_STATUS_LABELS[f.status] ?? f.status
      const detail =
        f.status === 'error'
          ? `${roleLabel} | ${statusLabel} (${f.errorStep || 'unknown'}): ${f.errorMessage || ''}`
          : `${roleLabel} (${f.roleConfidence}%) | ${statusLabel} · ${f.pageCount ?? '?'} trang · ${f.extractedCount} câu · ${f.roleReason}`
      overviewSheet.addRow({ metric: f.fileName, value: detail })
    }
  }

  // 2. Questions Sheet
  const listSheet = workbook.addWorksheet('Danh_sach_cau_hoi', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })
  listSheet.columns = [
    { header: 'STT', key: 'stt', width: 7 },
    { header: 'Mã câu', key: 'questionCode', width: 16 },
    { header: 'File nguồn', key: 'sourceDocumentName', width: 26 },
    { header: 'Chủ đề', key: 'topic', width: 22 },
    { header: 'Bài học', key: 'lessonTitle', width: 28 },
    { header: 'Trang', key: 'pageNumber', width: 9 },
    { header: 'Dạng câu', key: 'questionType', width: 20 },
    { header: 'Mức độ nhận thức', key: 'cognitiveLevel', width: 18 },
    { header: 'Số câu', key: 'questionNumber', width: 12 },
    { header: 'Câu hỏi gốc', key: 'originalQuestionText', width: 46 },
    { header: 'Phương án / Mệnh đề', key: 'options', width: 42 },
    { header: 'Đáp án đã chốt', key: 'confirmedAnswer', width: 18 },
    { header: 'Trạng thái', key: 'answerStatus', width: 22 },
    { header: 'Độ tin cậy (%)', key: 'confidenceScore', width: 14 },
    { header: 'Phương pháp khớp', key: 'matchMethod', width: 28 },
    { header: 'Nguồn đáp án', key: 'answerSource', width: 32 },
    { header: 'Đề xuất AI Agent', key: 'aiSuggestion', width: 38 },
    { header: 'Ghi chú / Giải thích', key: 'notes', width: 38 },
    { header: 'Quyết định duyệt', key: 'reviewDecision', width: 16 },
  ]
  styleHeaderRow(listSheet.getRow(1), 'FF123B68')

  params.questions.forEach((q, idx) => {
    const row = listSheet.addRow({
      stt: idx + 1,
      questionCode: q.questionCode || '—',
      sourceDocumentName: q.sourceDocumentName,
      topic: q.topic || '—',
      lessonTitle: q.lessonTitle || '—',
      pageNumber: q.pageNumber ?? '—',
      questionType: QUESTION_TYPE_LABELS[q.questionType],
      cognitiveLevel: COGNITIVE_LABELS[q.cognitiveLevel],
      questionNumber: q.questionNumber,
      originalQuestionText: q.originalQuestionText || q.questionText,
      options: summarizeOptions(q),
      confirmedAnswer: summarizeConfirmedAnswer(q),
      answerStatus: STATUS_LABELS[q.answerStatus],
      confidenceScore: q.confidenceScore ?? 0,
      matchMethod: MATCH_METHOD_LABELS[q.matchMethod ?? 'unmatched'],
      answerSource: q.answerSource || '—',
      aiSuggestion: summarizeAiSuggestion(q),
      notes: [q.answerNote, q.explanation].filter(Boolean).join('\n'),
      reviewDecision: REVIEW_DECISION_LABELS[q.reviewDecision],
    })
    row.alignment = { vertical: 'top', wrapText: true }
  })

  // 3. Needs review / Missing / Ambiguous / Duplicates Sheet
  const attentionSheet = workbook.addWorksheet('Can_kiem_tra_va_xung_dot', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })
  attentionSheet.columns = [
    { header: 'STT', key: 'stt', width: 7 },
    { header: 'File nguồn', key: 'sourceDocumentName', width: 26 },
    { header: 'Bài học / Chủ đề', key: 'lessonTopic', width: 28 },
    { header: 'Số câu / Mã câu', key: 'numCode', width: 18 },
    { header: 'Vấn đề', key: 'issueLabel', width: 24 },
    { header: 'Độ tin cậy (%)', key: 'confidenceScore', width: 14 },
    { header: 'Câu hỏi gốc', key: 'originalQuestionText', width: 46 },
    { header: 'Đề xuất AI Agent', key: 'aiSuggestion', width: 40 },
    { header: 'Lý do & Gợi ý xử lý', key: 'actionHint', width: 44 },
  ]
  styleHeaderRow(attentionSheet.getRow(1), 'FF9A520B')

  const attentionItems = params.questions.filter(
    (q) => q.answerStatus !== 'verified' || q.duplicateInFile || q.duplicateInBank
  )

  attentionItems.forEach((q, idx) => {
    const issueLabel =
      q.duplicateInFile || q.duplicateInBank
        ? q.duplicateInBank
          ? 'Trùng trong Ngân hàng'
          : 'Trùng trong tệp'
        : STATUS_LABELS[q.answerStatus]

    const actionHint =
      q.answerStatus === 'ai_proposed' && q.aiSuggestion && !q.aiSuggestion.applied
        ? 'AI Agent đề xuất đáp án; kiểm tra và bấm "Xác nhận đề xuất AI" để phê duyệt.'
        : q.answerStatus === 'needs_review' && q.aiSuggestion && !q.aiSuggestion.applied
        ? 'Kiểm tra đề xuất AI Agent; bấm "Áp dụng đề xuất AI" hoặc sửa đáp án trực tiếp.'
        : q.answerStatus === 'ambiguous'
        ? 'Có xung đột giữa các nguồn đáp án; đối chiếu tài liệu gốc và chọn đáp án đúng.'
        : q.answerStatus === 'missing'
        ? 'Thiếu đáp án trong nguồn; bổ sung đáp án / Rubric thủ công trước khi duyệt.'
        : 'Câu trùng lặp; hệ thống tự động loại khỏi lần nhập chính thức.'

    const row = attentionSheet.addRow({
      stt: idx + 1,
      sourceDocumentName: q.sourceDocumentName,
      lessonTopic: [q.lessonTitle, q.topic].filter(Boolean).join(' · ') || '—',
      numCode: [q.questionNumber, q.questionCode].filter(Boolean).join(' / '),
      issueLabel,
      confidenceScore: q.confidenceScore ?? 0,
      originalQuestionText: q.originalQuestionText || q.questionText,
      aiSuggestion: summarizeAiSuggestion(q),
      actionHint: `${q.answerNote || ''}\n→ ${actionHint}`.trim(),
    })
    row.alignment = { vertical: 'top', wrapText: true }
  })

  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}
