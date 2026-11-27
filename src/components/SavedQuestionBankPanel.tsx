import { useMemo, useState } from 'react'
import {
  CheckCircle2,
  Database,
  Edit3,
  FileText,
  History,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react'
import type {
  CognitiveLevel,
  QuestionBankImportRecord,
  QuestionOrigin,
  QuestionType,
  SavedQuestionBankItem,
} from '../types'
import {
  createManualQuestionInFirestore,
  deleteSavedQuestionFromFirestore,
  migrateLegacyQuestionsDefaults,
  updateSavedQuestionInFirestore,
} from '../lib/questionBankDb'
import { QuestionEditModal, type EditableQuestionValues } from './QuestionEditModal'

interface SavedQuestionBankPanelProps {
  ownerUid: string
  emailVerified: boolean
  questions: SavedQuestionBankItem[]
  imports: QuestionBankImportRecord[]
  loading: boolean
  onRefresh: () => Promise<void>
  onSwitchToImport: () => void
}

const COGNITIVE_LABELS: Record<CognitiveLevel, string> = {
  recognition: 'Nhận biết',
  understanding: 'Thông hiểu',
  application: 'Vận dụng',
  unspecified: 'Chưa xác định',
}

const COGNITIVE_STYLE: Record<CognitiveLevel, string> = {
  recognition: 'text-[#2D6A23] bg-[#EEF7EC] border-[#55A747]/30',
  understanding: 'text-[#123B68] bg-[#EAF3FA] border-[#2878B8]/30',
  application: 'text-[#5B3C7D] bg-[#F4EFF8] border-[#7954A1]/30',
  unspecified: 'text-[#65758B] bg-slate-100 border-slate-200',
}

const TYPE_LABELS: Record<QuestionType, string> = {
  multiple_choice: 'TN 4 lựa chọn',
  true_false: 'Đúng / Sai (4 ý)',
  essay: 'Tự luận',
}

function formatDateTime(ms: number | null): string {
  if (!ms) return 'Đang đồng bộ'
  return new Date(ms).toLocaleString('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  })
}

const EMPTY_MANUAL_VALUES: EditableQuestionValues = {
  questionType: 'multiple_choice',
  bankName: '',
  topic: '',
  lessonTitle: '',
  questionNumber: 'Câu mới',
  pageNumber: null,
  cognitiveLevel: 'recognition',
  questionText: '',
  optionA: '',
  optionB: '',
  optionC: '',
  optionD: '',
  answerKey: 'A',
  statementA: '',
  statementB: '',
  statementC: '',
  statementD: '',
  statementAnswerA: true,
  statementAnswerB: false,
  statementAnswerC: true,
  statementAnswerD: false,
  rubric: '',
  sampleAnswer: '',
  explanation: '',
}

export function SavedQuestionBankPanel({
  ownerUid,
  emailVerified,
  questions,
  imports,
  loading,
  onRefresh,
  onSwitchToImport,
}: SavedQuestionBankPanelProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const [levelFilter, setLevelFilter] = useState<CognitiveLevel | 'all'>('all')
  const [typeFilter, setTypeFilter] = useState<QuestionType | 'all'>('all')
  const [originFilter, setOriginFilter] = useState<QuestionOrigin | 'ai_starred' | 'all'>('all')
  const [bankFilter, setBankFilter] = useState<string>('all')
  const [docFilter, setDocFilter] = useState<string>('all')

  const [editingItem, setEditingItem] = useState<SavedQuestionBankItem | null>(null)
  const [creatingNew, setCreatingNew] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [migratingLegacy, setMigratingLegacy] = useState(false)
  const [legacyBankLabel, setLegacyBankLabel] = useState('Ngân hàng Tin học 12 (Gốc)')

  const legacyWithoutType = useMemo(
    () => questions.filter((q) => !q.hasExplicitQuestionType),
    [questions]
  )

  const uniqueSources = useMemo(() => {
    const names = Array.from(new Set(questions.map((q) => q.sourceDocumentName).filter(Boolean)))
    return names.sort((a, b) => a.localeCompare(b, 'vi'))
  }, [questions])

  const uniqueBanks = useMemo(() => {
    const names = Array.from(new Set(questions.map((q) => q.bankName).filter(Boolean)))
    return names.sort((a, b) => a.localeCompare(b, 'vi'))
  }, [questions])

  const countsByType = useMemo(() => {
    let mcq = 0
    let tf = 0
    let essay = 0
    for (const q of questions) {
      if (q.questionType === 'true_false') tf += 1
      else if (q.questionType === 'essay') essay += 1
      else mcq += 1
    }
    return { mcq, tf, essay }
  }, [questions])

  const filteredQuestions = useMemo(() => {
    const q = searchTerm.trim().toLowerCase()
    return questions.filter((item) => {
      if (levelFilter !== 'all' && item.cognitiveLevel !== levelFilter) return false
      if (typeFilter !== 'all' && item.questionType !== typeFilter) return false
      if (originFilter === 'ai_starred') {
        const isStarred =
          Boolean(item.answerSource?.startsWith('[*]')) ||
          Boolean(item.answerSource?.includes('AI đề xuất'))
        if (!isStarred) return false
      } else if (originFilter !== 'all') {
        const effectiveOrigin: QuestionOrigin =
          item.questionOrigin === 'ai_generated' ? 'ai_generated' : 'extracted'
        if (effectiveOrigin !== originFilter) return false
      }
      if (bankFilter === '__ungrouped__' && item.bankName !== '') return false
      if (bankFilter !== 'all' && bankFilter !== '__ungrouped__' && item.bankName !== bankFilter) {
        return false
      }
      if (docFilter !== 'all' && item.sourceDocumentName !== docFilter) return false
      if (!q) return true
      return (
        item.questionText.toLowerCase().includes(q) ||
        item.lessonTitle.toLowerCase().includes(q) ||
        item.topic.toLowerCase().includes(q) ||
        item.bankName.toLowerCase().includes(q) ||
        item.sourceDocumentName.toLowerCase().includes(q) ||
        item.optionA.toLowerCase().includes(q) ||
        item.optionB.toLowerCase().includes(q) ||
        item.statementA.toLowerCase().includes(q) ||
        item.rubric.toLowerCase().includes(q)
      )
    })
  }, [questions, searchTerm, levelFilter, typeFilter, originFilter, bankFilter, docFilter])

  const handleSaveEdit = async (values: EditableQuestionValues) => {
    if (!editingItem) return
    setSavingEdit(true)
    setActionError(null)
    setActionSuccess(null)
    try {
      await updateSavedQuestionInFirestore(editingItem.id, values)
      setEditingItem(null)
      setActionSuccess('Đã cập nhật câu hỏi trong cơ sở dữ liệu.')
      await onRefresh()
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Không thể cập nhật câu hỏi trong cơ sở dữ liệu.'
      )
      throw err
    } finally {
      setSavingEdit(false)
    }
  }

  const handleCreateManual = async (values: EditableQuestionValues) => {
    setSavingEdit(true)
    setActionError(null)
    setActionSuccess(null)
    try {
      await createManualQuestionInFirestore({
        ownerUid,
        ...values,
      })
      setCreatingNew(false)
      setActionSuccess('Đã thêm câu hỏi mới vào Ngân hàng câu hỏi.')
      await onRefresh()
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Không thể tạo câu hỏi mới.'
      )
      throw err
    } finally {
      setSavingEdit(false)
    }
  }

  const handleConfirmDelete = async (id: string) => {
    setDeletingId(id)
    setActionError(null)
    try {
      await deleteSavedQuestionFromFirestore(id)
      setConfirmDeleteId(null)
      await onRefresh()
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Không thể xóa câu hỏi khỏi cơ sở dữ liệu.'
      )
    } finally {
      setDeletingId(null)
    }
  }

  const handleMigrateLegacy = async () => {
    if (legacyWithoutType.length === 0) return
    setMigratingLegacy(true)
    setActionError(null)
    setActionSuccess(null)
    try {
      const updated = await migrateLegacyQuestionsDefaults(
        legacyWithoutType,
        legacyBankLabel.trim() || 'Ngân hàng Tin học 12 (Gốc)'
      )
      setActionSuccess(
        `Đã gắn nhãn định dạng trắc nghiệm 4 lựa chọn cho ${updated} câu hỏi hiện có mà không làm thay đổi bất kỳ nội dung gốc nào.`
      )
      await onRefresh()
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Không thể cập nhật nhãn cho câu hỏi hiện có.'
      )
    } finally {
      setMigratingLegacy(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Safe non-destructive compatibility helper for existing ~150 questions */}
      {legacyWithoutType.length > 0 && (
        <div className="rounded-xl border border-[#2878B8]/35 bg-[#EAF3FA]/65 p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-bold text-[#123B68]">
              <Sparkles className="h-4 w-4 text-[#2878B8]" />
              <span>
                Phát hiện {legacyWithoutType.length} câu hỏi từ phiên bản trước vẫn đang hoạt động bình thường
              </span>
            </div>
            <p className="text-xs text-[#203247] leading-relaxed">
              Các câu hỏi cũ tự động tương thích với định dạng <strong>Trắc nghiệm 4 lựa chọn</strong>. Bạn có thể tùy chọn gắn nhãn metadata và tên ngân hàng hàng loạt (giữ nguyên 100% nội dung và đáp án gốc).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <input
              type="text"
              maxLength={120}
              value={legacyBankLabel}
              onChange={(e) => setLegacyBankLabel(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-[#203247]"
              placeholder="Tên nhóm ngân hàng..."
            />
            <button
              type="button"
              disabled={migratingLegacy || !emailVerified}
              onClick={() => void handleMigrateLegacy()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#123B68] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#2878B8] disabled:opacity-60 transition-colors"
            >
              <span>{migratingLegacy ? 'Đang gắn nhãn...' : 'Gắn nhãn metadata (an toàn)'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Header & Controls */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-bold text-[#123B68]">
              Ngân hàng câu hỏi đã lưu trên cơ sở dữ liệu ({questions.length} câu)
            </h3>
            <p className="text-xs text-[#65758B] mt-0.5 tabular-nums">
              {countsByType.mcq} Trắc nghiệm 4 lựa chọn · {countsByType.tf} Đúng/Sai 4 ý · {countsByType.essay} Tự luận
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!emailVerified}
              onClick={() => setCreatingNew(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#2878B8] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#123B68] disabled:opacity-50 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Thêm câu hỏi thủ công</span>
            </button>
            <button
              type="button"
              onClick={() => void onRefresh()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-[#123B68] hover:bg-[#F3F6FA] disabled:opacity-60 transition-colors"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>{loading ? 'Đang tải...' : 'Làm mới'}</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
          <div className="relative md:col-span-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#65758B]" />
            <input
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Tìm câu hỏi, bài học, chủ đề..."
              className="w-full rounded-lg border border-slate-300 bg-[#F3F6FA] py-2 pl-9 pr-3 text-sm text-[#203247] focus:border-[#2878B8] focus:bg-white focus:outline-none"
            />
          </div>
          <div className="md:col-span-2">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as QuestionType | 'all')}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247]"
            >
              <option value="all">Tất cả dạng câu</option>
              <option value="multiple_choice">TN 4 lựa chọn</option>
              <option value="true_false">Đúng / Sai (4 ý)</option>
              <option value="essay">Tự luận</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <select
              value={originFilter}
              onChange={(e) =>
                setOriginFilter(e.target.value as QuestionOrigin | 'ai_starred' | 'all')
              }
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247]"
            >
              <option value="all">Mọi nguồn tạo</option>
              <option value="extracted">Trích xuất nguyên bản</option>
              <option value="ai_starred">Đáp án * AI đề xuất</option>
              <option value="ai_generated">AI Agent tạo mới</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value as CognitiveLevel | 'all')}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247]"
            >
              <option value="all">Tất cả mức độ</option>
              <option value="recognition">Nhận biết</option>
              <option value="understanding">Thông hiểu</option>
              <option value="application">Vận dụng</option>
              <option value="unspecified">Chưa xác định</option>
            </select>
          </div>
          <div className="md:col-span-3 grid grid-cols-2 gap-2">
            <select
              value={bankFilter}
              onChange={(e) => setBankFilter(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-[#203247]"
            >
              <option value="all">Mọi ngân hàng</option>
              <option value="__ungrouped__">Chưa phân ngân hàng</option>
              {uniqueBanks.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <select
              value={docFilter}
              onChange={(e) => setDocFilter(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-[#203247]"
            >
              <option value="all">Mọi tài liệu nguồn</option>
              {uniqueSources.map((src) => (
                <option key={src} value={src}>
                  {src}
                </option>
              ))}
            </select>
          </div>
        </div>

        {actionSuccess && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-[#55A747]/40 bg-[#EEF7EC] px-4 py-3 text-xs font-medium text-[#2D6A23]"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[#55A747]" />
            <span>{actionSuccess}</span>
          </div>
        )}

        {actionError && (
          <div
            role="alert"
            className="rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]"
          >
            {actionError}
          </div>
        )}

        {questions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-[#F3F6FA] p-8 text-center space-y-3">
            <Database className="mx-auto h-8 w-8 text-[#65758B]" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[#123B68]">
                Chưa có câu hỏi nào được lưu trong cơ sở dữ liệu
              </p>
              <p className="text-xs text-[#65758B]">
                Hãy tải lên tài liệu DOCX hoặc PDF hoặc thêm câu hỏi thủ công để bắt đầu xây dựng ngân hàng câu hỏi.
              </p>
            </div>
            <button
              type="button"
              onClick={onSwitchToImport}
              className="inline-flex items-center gap-2 rounded-lg bg-[#2878B8] px-4 py-2 text-xs font-semibold text-white hover:bg-[#123B68] transition-colors"
            >
              <span>Tải tài liệu nhập câu hỏi ngay</span>
            </button>
          </div>
        ) : filteredQuestions.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-[#F3F6FA] p-6 text-center text-xs text-[#65758B]">
            Không tìm thấy câu hỏi nào khớp với bộ lọc hiện tại.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-[#F3F6FA] text-xs font-semibold text-[#65758B]">
                <tr>
                  <th className="px-4 py-3 w-48">Nguồn &amp; Phân loại</th>
                  <th className="px-4 py-3">Nội dung câu hỏi &amp; Phương án / Rubric</th>
                  <th className="px-4 py-3 w-28">Mức độ</th>
                  <th className="px-4 py-3 w-28 text-center">Đáp án</th>
                  <th className="px-4 py-3 w-32 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filteredQuestions.map((item) => (
                  <tr key={item.id} className="align-top hover:bg-[#F3F6FA]/60">
                    <td className="px-4 py-3.5 space-y-1">
                      <div className="font-semibold text-xs text-[#123B68]">
                        {item.questionNumber}
                        {item.pageNumber !== null && (
                          <span className="ml-1.5 font-normal text-[#65758B] tabular-nums">
                            · Trang {item.pageNumber}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-semibold text-[#2878B8]">
                        {TYPE_LABELS[item.questionType]}
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        <span
                          className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                            item.questionOrigin === 'ai_generated'
                              ? 'border-[#7954A1]/30 bg-[#F4EFF8] text-[#5B3C7D]'
                              : 'border-slate-200 bg-[#F8FAFC] text-[#203247]'
                          }`}
                        >
                          {item.questionOrigin === 'ai_generated'
                            ? 'AI Agent tạo mới'
                            : 'Trích xuất nguyên bản'}
                        </span>
                        {(item.answerSource?.startsWith('[*]') ||
                          item.answerSource?.includes('AI đề xuất')) && (
                          <span
                            className="inline-block rounded border border-[#7954A1]/40 bg-[#F4EFF8] px-1.5 py-0.5 text-[10px] font-bold text-[#5B3C7D]"
                            title="Câu hỏi sử dụng đáp án do AI đề xuất (không thay đổi nội dung câu hỏi gốc)"
                          >
                            * AI đề xuất
                          </span>
                        )}
                      </div>
                      {item.bankName && (
                        <div className="text-[11px] font-medium text-[#5B3C7D]">
                          Ngân hàng: {item.bankName}
                        </div>
                      )}
                      <div className="text-xs text-[#203247] leading-snug">
                        {item.lessonTitle || item.topic || 'Chưa gắn bài học'}
                      </div>
                      <div className="flex items-center gap-1 text-[11px] text-[#65758B]">
                        <FileText className="h-3 w-3 shrink-0" />
                        <span className="truncate max-w-[155px]" title={item.sourceDocumentName}>
                          {item.sourceDocumentName}
                        </span>
                      </div>
                      {item.answerSource && (
                        <div className="text-[10px] text-[#65758B] leading-snug">
                          Nguồn ĐÁ: {item.answerSource}
                        </div>
                      )}
                    </td>

                    <td className="px-4 py-3.5 space-y-2">
                      <p className="text-sm font-medium text-[#203247] leading-relaxed">
                        {item.questionText}
                      </p>

                      {item.questionType === 'multiple_choice' && (
                        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 text-xs">
                          {(['A', 'B', 'C', 'D'] as const).map((letter) => {
                            const text =
                              letter === 'A'
                                ? item.optionA
                                : letter === 'B'
                                ? item.optionB
                                : letter === 'C'
                                ? item.optionC
                                : item.optionD
                            const isCorrect = item.answerKey === letter
                            return (
                              <div
                                key={letter}
                                className={`rounded-md border px-2.5 py-1.5 ${
                                  isCorrect
                                    ? 'border-[#55A747]/40 bg-[#EEF7EC] text-[#2D6A23] font-semibold'
                                    : 'border-slate-200 bg-white text-[#203247]'
                                }`}
                              >
                                <span className="font-bold mr-1">{letter}.</span>
                                <span>{text}</span>
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {item.questionType === 'true_false' && (
                        <div className="space-y-1 text-xs">
                          {(
                            [
                              { l: 'a', t: item.statementA, ans: item.statementAnswerA },
                              { l: 'b', t: item.statementB, ans: item.statementAnswerB },
                              { l: 'c', t: item.statementC, ans: item.statementAnswerC },
                              { l: 'd', t: item.statementD, ans: item.statementAnswerD },
                            ] as const
                          ).map((row) => (
                            <div
                              key={row.l}
                              className="flex items-start justify-between gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1"
                            >
                              <span>
                                <strong className="text-[#123B68]">{row.l})</strong> {row.t}
                              </span>
                              <span
                                className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold ${
                                  row.ans ? 'bg-[#EEF7EC] text-[#2D6A23]' : 'bg-[#FDF1F0] text-[#A92F2A]'
                                }`}
                              >
                                {row.ans ? 'Đúng' : 'Sai'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {item.questionType === 'essay' && (
                        <div className="rounded-lg border border-slate-200 bg-[#F3F6FA] p-2.5 text-xs space-y-1">
                          <div className="font-semibold text-[#123B68]">Hướng dẫn chấm (Rubric):</div>
                          <p className="text-[#203247] whitespace-pre-line">{item.rubric}</p>
                        </div>
                      )}

                      {item.explanation && (
                        <div className="text-xs text-[#65758B]">
                          <strong className="text-[#123B68]">Giải thích:</strong> {item.explanation}
                        </div>
                      )}
                    </td>

                    <td className="px-4 py-3.5">
                      <span
                        className={`inline-block rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
                          COGNITIVE_STYLE[item.cognitiveLevel]
                        }`}
                      >
                        {COGNITIVE_LABELS[item.cognitiveLevel]}
                      </span>
                    </td>

                    <td className="px-4 py-3.5 text-center">
                      {item.questionType === 'multiple_choice' ? (
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[#55A747]/40 bg-[#EEF7EC] text-xs font-bold text-[#2D6A23]">
                          {item.answerKey}
                        </span>
                      ) : item.questionType === 'true_false' ? (
                        <span className="inline-flex items-center rounded-md border border-[#55A747]/40 bg-[#EEF7EC] px-2 py-1 text-[11px] font-bold text-[#2D6A23]">
                          {item.statementAnswerA ? 'Đ' : 'S'}-{item.statementAnswerB ? 'Đ' : 'S'}-
                          {item.statementAnswerC ? 'Đ' : 'S'}-{item.statementAnswerD ? 'Đ' : 'S'}
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-md border border-[#7954A1]/30 bg-[#F4EFF8] px-2 py-1 text-[11px] font-semibold text-[#5B3C7D]">
                          Rubric
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3.5 text-right">
                      {confirmDeleteId === item.id ? (
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={deletingId === item.id}
                            onClick={() => void handleConfirmDelete(item.id)}
                            className="rounded-md bg-[#D94B45] px-2.5 py-1 text-xs font-semibold text-white hover:bg-[#b53732]"
                          >
                            {deletingId === item.id ? 'Đang xóa' : 'Xóa'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-[#203247]"
                          >
                            Hủy
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setEditingItem(item)}
                            title="Chỉnh sửa câu hỏi"
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-[#123B68] hover:border-[#2878B8] hover:text-[#2878B8]"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            <span>Sửa</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(item.id)}
                            title="Xóa khỏi ngân hàng"
                            className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white p-1.5 text-[#D94B45] hover:border-[#D94B45] hover:bg-[#FDF1F0]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Import History Table */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-3">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-[#2878B8]" />
          <h3 className="font-display text-sm font-bold text-[#123B68]">
            Lịch sử các đợt nhập tài liệu ({imports.length})
          </h3>
        </div>
        {imports.length === 0 ? (
          <p className="text-xs text-[#65758B]">
            Chưa có đợt nhập tài liệu nào được ghi nhận trên Firestore.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-[#F3F6FA] font-semibold text-[#65758B]">
                <tr>
                  <th className="px-4 py-2.5">Tệp nguồn</th>
                  <th className="px-4 py-2.5">Nhóm ngân hàng</th>
                  <th className="px-4 py-2.5">Định dạng</th>
                  <th className="px-4 py-2.5 text-right">Đã trích xuất</th>
                  <th className="px-4 py-2.5 text-right">Đã lưu</th>
                  <th className="px-4 py-2.5 text-right">Bỏ qua trùng</th>
                  <th className="px-4 py-2.5 text-right">Thời gian</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {imports.map((imp) => (
                  <tr key={imp.id} className="hover:bg-[#F3F6FA]/60">
                    <td className="px-4 py-2.5 font-medium text-[#123B68]">{imp.fileName}</td>
                    <td className="px-4 py-2.5 text-[#65758B]">{imp.bankName || '—'}</td>
                    <td className="px-4 py-2.5 uppercase text-[#65758B]">{imp.fileFormat}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-[#203247]">
                      {imp.totalExtracted}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-[#2D6A23]">
                      {imp.approvedSavedCount}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-[#65758B]">
                      {imp.duplicateSkippedCount}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-[#65758B]">
                      {formatDateTime(imp.createdAtMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editingItem && (
        <QuestionEditModal
          title={`Chỉnh sửa câu hỏi · ${editingItem.questionNumber}`}
          initialValues={{
            questionType: editingItem.questionType,
            bankName: editingItem.bankName,
            topic: editingItem.topic,
            lessonTitle: editingItem.lessonTitle,
            questionNumber: editingItem.questionNumber,
            pageNumber: editingItem.pageNumber,
            cognitiveLevel: editingItem.cognitiveLevel,
            questionText: editingItem.questionText,
            optionA: editingItem.optionA,
            optionB: editingItem.optionB,
            optionC: editingItem.optionC,
            optionD: editingItem.optionD,
            answerKey: editingItem.answerKey,
            statementA: editingItem.statementA,
            statementB: editingItem.statementB,
            statementC: editingItem.statementC,
            statementD: editingItem.statementD,
            statementAnswerA: editingItem.statementAnswerA,
            statementAnswerB: editingItem.statementAnswerB,
            statementAnswerC: editingItem.statementAnswerC,
            statementAnswerD: editingItem.statementAnswerD,
            rubric: editingItem.rubric,
            sampleAnswer: editingItem.sampleAnswer,
            explanation: editingItem.explanation,
          }}
          allowTypeChange={false}
          requireVerifiedAnswer
          submitting={savingEdit}
          onCancel={() => setEditingItem(null)}
          onSave={handleSaveEdit}
        />
      )}

      {creatingNew && (
        <QuestionEditModal
          title="Thêm câu hỏi mới vào Ngân hàng"
          initialValues={EMPTY_MANUAL_VALUES}
          allowTypeChange
          requireVerifiedAnswer
          submitting={savingEdit}
          onCancel={() => setCreatingNew(false)}
          onSave={handleCreateManual}
        />
      )}
    </div>
  )
}
