import { useMemo, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Lock,
  Plus,
  Send,
  Sparkles,
  Trash2,
  Unlock,
  Wand2,
} from 'lucide-react'
import type {
  CognitiveLevel,
  ExamTemplate,
  PublishedExam,
  QuestionType,
  SavedQuestionBankItem,
} from '../types'
import {
  deletePublishedExam,
  publishExamToFirestore,
  togglePublishedExamStatus,
  validateExamComposition,
  type SelectedExamQuestionEntry,
} from '../lib/examDb'

interface ExamBuilderPublisherProps {
  ownerUid: string
  teacherName: string
  emailVerified: boolean
  templates: ExamTemplate[]
  initialTemplateId?: string | null
  questions: SavedQuestionBankItem[]
  publishedExams: PublishedExam[]
  onRefresh: () => Promise<void>
  onNeedTemplates: () => void
}

function roundScore(val: number): number {
  return Math.round(val * 1000) / 1000
}

function generateAccessCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = 'TL12-'
  for (let i = 0; i < 4; i++) {
    out += chars[Math.floor(Math.random() * chars.length)]
  }
  return out
}

const COGNITIVE_LABELS: Record<CognitiveLevel, string> = {
  recognition: 'Nhận biết',
  understanding: 'Thông hiểu',
  application: 'Vận dụng',
  unspecified: 'Chưa XĐ',
}

export function ExamBuilderPublisher({
  ownerUid,
  teacherName,
  emailVerified,
  templates,
  initialTemplateId,
  questions,
  publishedExams,
  onRefresh,
  onNeedTemplates,
}: ExamBuilderPublisherProps) {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    initialTemplateId || templates[0]?.id || ''
  )
  const [title, setTitle] = useState('')
  const [accessCode, setAccessCode] = useState<string>(() => generateAccessCode())
  const [bankFilter, setBankFilter] = useState<string>('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedEntries, setSelectedEntries] = useState<SelectedExamQuestionEntry[]>([])

  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publishSuccess, setPublishSuccess] = useState<string | null>(null)
  const [busyExamId, setBusyExamId] = useState<string | null>(null)
  const [copiedCode, setCopiedCode] = useState<string | null>(null)

  const activeTemplate = useMemo(() => {
    if (templates.length === 0) return null
    return templates.find((t) => t.id === selectedTemplateId) ?? templates[0]
  }, [templates, selectedTemplateId])

  const uniqueBanks = useMemo(() => {
    const names = Array.from(new Set(questions.map((q) => q.bankName).filter(Boolean)))
    return names.sort((a, b) => a.localeCompare(b, 'vi'))
  }, [questions])

  const selectedIds = useMemo(
    () => new Set(selectedEntries.map((s) => s.question.id)),
    [selectedEntries]
  )

  const filteredPool = useMemo(() => {
    const s = searchTerm.trim().toLowerCase()
    return questions.filter((q) => {
      if (bankFilter !== 'all' && q.bankName !== bankFilter) return false
      if (!s) return true
      return (
        q.questionText.toLowerCase().includes(s) ||
        q.lessonTitle.toLowerCase().includes(s) ||
        q.topic.toLowerCase().includes(s)
      )
    })
  }, [questions, bankFilter, searchTerm])

  const validation = useMemo(() => {
    if (!activeTemplate) return null
    return validateExamComposition(activeTemplate, selectedEntries)
  }, [activeTemplate, selectedEntries])

  const distributePointsEvenly = (count: number, totalPartPoints: number): number[] => {
    if (count <= 0) return []
    const each = roundScore(totalPartPoints / count)
    const arr = Array.from({ length: count }, () => each)
    const diff = roundScore(totalPartPoints - each * count)
    arr[arr.length - 1] = roundScore(arr[arr.length - 1] + diff)
    return arr
  }

  const handleAutoSelectFromMatrix = () => {
    if (!activeTemplate) return
    setPublishError(null)
    setPublishSuccess(null)

    const pool =
      bankFilter === 'all'
        ? questions
        : questions.filter((q) => q.bankName === bankFilter)

    const totalNeeded =
      (activeTemplate.part1Enabled ? activeTemplate.part1Count : 0) +
      (activeTemplate.part2Enabled ? activeTemplate.part2Count : 0) +
      (activeTemplate.part3Enabled ? activeTemplate.part3Count : 0)

    const targetCounts: Record<'recognition' | 'understanding' | 'application', number> = {
      recognition: Math.round((totalNeeded * activeTemplate.recognitionPct) / 100),
      understanding: Math.round((totalNeeded * activeTemplate.understandingPct) / 100),
      application: 0,
    }
    targetCounts.application = Math.max(
      0,
      totalNeeded - targetCounts.recognition - targetCounts.understanding
    )

    const remainingCog = { ...targetCounts }
    const usedIds = new Set<string>()
    const nextSelected: SelectedExamQuestionEntry[] = []

    const pickForPart = (
      qType: QuestionType,
      partNum: 1 | 2 | 3,
      countNeeded: number,
      partTotalPts: number
    ) => {
      if (countNeeded <= 0) return
      const candidates = pool.filter(
        (q) => q.questionType === qType && !usedIds.has(q.id)
      )

      const picked: SavedQuestionBankItem[] = []
      const levels: ('recognition' | 'understanding' | 'application')[] = [
        'application',
        'understanding',
        'recognition',
      ]

      // First pass: satisfy remaining cognitive quotas
      for (const lvl of levels) {
        if (picked.length >= countNeeded) break
        const ofLevel = candidates.filter(
          (c) => c.cognitiveLevel === lvl && !usedIds.has(c.id)
        )
        for (const cand of ofLevel) {
          if (picked.length >= countNeeded) break
          if (remainingCog[lvl] > 0) {
            picked.push(cand)
            usedIds.add(cand.id)
            remainingCog[lvl] -= 1
          }
        }
      }

      // Second pass: fill remaining slots with specified levels first, then any remaining
      for (const cand of candidates) {
        if (picked.length >= countNeeded) break
        if (!usedIds.has(cand.id) && cand.cognitiveLevel !== 'unspecified') {
          picked.push(cand)
          usedIds.add(cand.id)
        }
      }
      for (const cand of candidates) {
        if (picked.length >= countNeeded) break
        if (!usedIds.has(cand.id)) {
          picked.push(cand)
          usedIds.add(cand.id)
        }
      }

      const ptsArr = distributePointsEvenly(picked.length, partTotalPts)
      picked.forEach((q, idx) => {
        nextSelected.push({
          question: q,
          part: partNum,
          points: ptsArr[idx] ?? 0,
        })
      })
    }

    if (activeTemplate.part1Enabled) {
      pickForPart('multiple_choice', 1, activeTemplate.part1Count, activeTemplate.part1Points)
    }
    if (activeTemplate.part2Enabled) {
      pickForPart('true_false', 2, activeTemplate.part2Count, activeTemplate.part2Points)
    }
    if (activeTemplate.part3Enabled) {
      pickForPart('essay', 3, activeTemplate.part3Count, activeTemplate.part3Points)
    }

    setSelectedEntries(nextSelected)
    if (!title.trim()) {
      setTitle(`${activeTemplate.name.split('(')[0].trim()} · Đề chính thức`)
    }
  }

  const addQuestionToExam = (q: SavedQuestionBankItem) => {
    if (!activeTemplate || selectedIds.has(q.id)) return
    const part: 1 | 2 | 3 =
      q.questionType === 'multiple_choice' ? 1 : q.questionType === 'true_false' ? 2 : 3
    const partTargetCount =
      part === 1
        ? activeTemplate.part1Count
        : part === 2
        ? activeTemplate.part2Count
        : activeTemplate.part3Count
    const partTargetPoints =
      part === 1
        ? activeTemplate.part1Points
        : part === 2
        ? activeTemplate.part2Points
        : activeTemplate.part3Points

    const defaultPts =
      partTargetCount > 0 ? roundScore(partTargetPoints / partTargetCount) : 0.25

    setSelectedEntries((prev) => [...prev, { question: q, part, points: defaultPts }])
  }

  const removeQuestionFromExam = (id: string) => {
    setSelectedEntries((prev) => prev.filter((e) => e.question.id !== id))
  }

  const updateQuestionPoints = (id: string, pts: number) => {
    setSelectedEntries((prev) =>
      prev.map((e) => (e.question.id === id ? { ...e, points: Math.max(0, pts) } : e))
    )
  }

  const handlePublish = async () => {
    if (!activeTemplate || !validation?.valid) return
    setPublishing(true)
    setPublishError(null)
    setPublishSuccess(null)
    try {
      const examId = await publishExamToFirestore({
        ownerUid,
        teacherName,
        template: activeTemplate,
        title,
        accessCode,
        selectedQuestions: selectedEntries,
      })
      setPublishSuccess(
        `Đã xuất bản đề thi "${title}" (Mã phòng: ${accessCode.toUpperCase()} · ID: ${examId}). Học sinh có thể vào làm bài ngay.`
      )
      setSelectedEntries([])
      setTitle('')
      setAccessCode(generateAccessCode())
      await onRefresh()
    } catch (err) {
      setPublishError(
        err instanceof Error ? err.message : 'Không thể xuất bản đề thi lên Firestore.'
      )
    } finally {
      setPublishing(false)
    }
  }

  const handleToggleStatus = async (exam: PublishedExam) => {
    setBusyExamId(exam.id)
    try {
      await togglePublishedExamStatus(
        exam.id,
        exam.status === 'published' ? 'closed' : 'published'
      )
      await onRefresh()
    } finally {
      setBusyExamId(null)
    }
  }

  const handleDeleteExam = async (examId: string) => {
    setBusyExamId(examId)
    try {
      await deletePublishedExam(examId)
      await onRefresh()
    } finally {
      setBusyExamId(null)
    }
  }

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedCode(code)
      window.setTimeout(() => setCopiedCode(null), 1800)
    } catch {
      // Ignore clipboard failure
    }
  }

  return (
    <div className="space-y-6">
      {templates.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center space-y-3">
          <Sparkles className="mx-auto h-8 w-8 text-[#2878B8]" />
          <div className="space-y-1">
            <h3 className="font-display text-base font-bold text-[#123B68]">
              Cần có ít nhất 1 cấu trúc đề thi mẫu trước khi tạo đề
            </h3>
            <p className="text-xs text-[#65758B]">
              Hãy sang tab Cấu trúc đề thi để tạo mẫu chuẩn 45 phút (12 TN · 4 Đúng/Sai · Tự luận) hoặc tự thiết kế cấu trúc riêng.
            </p>
          </div>
          <button
            type="button"
            onClick={onNeedTemplates}
            className="rounded-lg bg-[#2878B8] px-4 py-2 text-xs font-semibold text-white hover:bg-[#123B68]"
          >
            Mở Cấu trúc đề thi (Mẫu) →
          </button>
        </section>
      ) : (
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-base font-bold text-[#123B68]">
                Lắp ráp &amp; Xuất bản đề thi theo cấu trúc cấu hình sẵn
              </h3>
              <p className="text-xs text-[#65758B] mt-0.5">
                Hệ thống kiểm tra tổng điểm, số lượng câu từng phần và tỷ lệ nhận thức trước khi niêm phong đáp án lên máy chủ.
              </p>
            </div>
            {activeTemplate && (
              <button
                type="button"
                onClick={handleAutoSelectFromMatrix}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#2878B8] bg-[#EAF3FA] px-4 py-2 text-xs font-semibold text-[#123B68] hover:bg-[#d6e9f7] transition-colors"
              >
                <Wand2 className="h-3.5 w-3.5 text-[#2878B8]" />
                <span>Chọn tự động từ Ngân hàng theo ma trận</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-12">
            <div className="sm:col-span-5">
              <label className="block text-xs font-semibold text-[#203247] mb-1">
                1. Chọn cấu trúc đề thi mẫu *
              </label>
              <select
                value={activeTemplate?.id ?? ''}
                onChange={(e) => {
                  setSelectedTemplateId(e.target.value)
                  setSelectedEntries([])
                }}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247]"
              >
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name} ({tpl.durationMinutes}p · {tpl.totalPoints}đ)
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-5">
              <label className="block text-xs font-semibold text-[#203247] mb-1">
                2. Tên kỳ thi / Đề thi xuất bản *
              </label>
              <input
                type="text"
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ví dụ: Kiểm tra giữa kì I · Tin học 12A1"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-[#203247]"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-[#203247] mb-1">
                3. Mã phòng thi *
              </label>
              <input
                type="text"
                maxLength={20}
                value={accessCode}
                onChange={(e) =>
                  setAccessCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm font-bold text-[#123B68]"
              />
            </div>
          </div>

          {publishError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
              <span>{publishError}</span>
            </div>
          )}

          {publishSuccess && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-[#55A747]/40 bg-[#EEF7EC] px-4 py-3 text-xs font-medium text-[#2D6A23]"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-[#55A747]" />
              <span>{publishSuccess}</span>
            </div>
          )}

          {/* Split Builder: Question Bank Pool (Left) vs Selected & Validation (Right) */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Pool */}
            <div className="lg:col-span-6 rounded-xl border border-slate-200 bg-[#F3F6FA]/60 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-display text-xs font-bold text-[#123B68]">
                  Kho câu hỏi đã lưu ({filteredPool.length} câu khả dụng)
                </h4>
                <select
                  value={bankFilter}
                  onChange={(e) => setBankFilter(e.target.value)}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-[#203247]"
                >
                  <option value="all">Mọi ngân hàng câu hỏi</option>
                  {uniqueBanks.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>

              <input
                type="search"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Lọc nhanh theo nội dung, bài học, chủ đề..."
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-[#203247]"
              />

              <div className="max-h-96 overflow-y-auto space-y-2 pr-1">
                {filteredPool.slice(0, 80).map((q) => {
                  const alreadyPicked = selectedIds.has(q.id)
                  return (
                    <div
                      key={q.id}
                      className="rounded-lg border border-slate-200 bg-white p-3 flex items-start justify-between gap-3"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="font-bold text-[#123B68]">{q.questionNumber}</span>
                          <span className="text-[#2878B8] font-semibold">
                            {q.questionType === 'multiple_choice'
                              ? 'TN 4 lựa chọn'
                              : q.questionType === 'true_false'
                              ? 'Đúng/Sai 4 ý'
                              : 'Tự luận'}
                          </span>
                          <span className="text-[#65758B]">
                            · {COGNITIVE_LABELS[q.cognitiveLevel]}
                          </span>
                        </div>
                        <p className="text-xs text-[#203247] line-clamp-2">{q.questionText}</p>
                        {q.lessonTitle && (
                          <div className="text-[11px] text-[#65758B] truncate">{q.lessonTitle}</div>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={alreadyPicked}
                        onClick={() => addQuestionToExam(q)}
                        className="shrink-0 inline-flex items-center gap-1 rounded-md border border-[#2878B8] px-2.5 py-1 text-xs font-semibold text-[#2878B8] hover:bg-[#2878B8] hover:text-white disabled:border-slate-200 disabled:text-slate-400 disabled:hover:bg-transparent"
                      >
                        <Plus className="h-3 w-3" />
                        <span>{alreadyPicked ? 'Đã chọn' : 'Thêm'}</span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Selected + Live Matrix Validation */}
            <div className="lg:col-span-6 space-y-4">
              {validation && activeTemplate && (
                <div
                  className={`rounded-xl border p-4 space-y-2.5 ${
                    validation.valid
                      ? 'border-[#55A747]/45 bg-[#EEF7EC]'
                      : 'border-[#F28C28]/45 bg-[#FEF6EC]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-bold text-[#123B68]">
                    <span>Kiểm tra ma trận trước khi xuất bản</span>
                    <span className="tabular-nums">
                      {validation.actualTotalPoints} / {activeTemplate.totalPoints} điểm
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-[11px] tabular-nums">
                    <div className="rounded bg-white/80 p-2 border border-slate-200">
                      <div className="text-[#65758B]">Phần I (TN)</div>
                      <div className="font-bold text-[#123B68]">
                        {validation.part1ActualCount}/{activeTemplate.part1Count} ·{' '}
                        {validation.part1ActualPoints}/{activeTemplate.part1Points}đ
                      </div>
                    </div>
                    <div className="rounded bg-white/80 p-2 border border-slate-200">
                      <div className="text-[#65758B]">Phần II (Đ/S)</div>
                      <div className="font-bold text-[#123B68]">
                        {validation.part2ActualCount}/{activeTemplate.part2Count} ·{' '}
                        {validation.part2ActualPoints}/{activeTemplate.part2Points}đ
                      </div>
                    </div>
                    <div className="rounded bg-white/80 p-2 border border-slate-200">
                      <div className="text-[#65758B]">Phần III (TL)</div>
                      <div className="font-bold text-[#123B68]">
                        {validation.part3ActualCount}/{activeTemplate.part3Count} ·{' '}
                        {validation.part3ActualPoints}/{activeTemplate.part3Points}đ
                      </div>
                    </div>
                  </div>

                  <div className="text-[11px] text-[#203247] tabular-nums">
                    Nhận thức thực tế:{' '}
                    <strong>
                      {validation.cognitiveActualPct.recognition}% NB ·{' '}
                      {validation.cognitiveActualPct.understanding}% TH ·{' '}
                      {validation.cognitiveActualPct.application}% VD
                    </strong>{' '}
                    (Mục tiêu: {activeTemplate.recognitionPct}% / {activeTemplate.understandingPct}% /{' '}
                    {activeTemplate.applicationPct}%)
                  </div>

                  {validation.errors.length > 0 && (
                    <ul className="space-y-1 text-xs text-[#A92F2A]">
                      {validation.errors.map((err, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-[#D94B45]" />
                          <span>{err}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {validation.valid && (
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-[#2D6A23]">
                      <CheckCircle2 className="h-4 w-4 text-[#55A747]" />
                      <span>Đạt chuẩn cấu trúc đề! Đáp án sẽ được niêm phong khi xuất bản.</span>
                    </div>
                  )}
                </div>
              )}

              <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-display text-xs font-bold text-[#123B68]">
                    Câu hỏi trong đề ({selectedEntries.length} câu)
                  </h4>
                  {selectedEntries.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedEntries([])}
                      className="text-xs font-medium text-[#D94B45] hover:underline"
                    >
                      Xóa chọn tất cả
                    </button>
                  )}
                </div>

                {selectedEntries.length === 0 ? (
                  <p className="text-xs text-[#65758B] py-4 text-center">
                    Chưa có câu hỏi nào. Nhấn &ldquo;Chọn tự động từ Ngân hàng theo ma trận&rdquo; hoặc thêm từng câu bên trái.
                  </p>
                ) : (
                  <div className="max-h-72 overflow-y-auto divide-y divide-slate-200">
                    {selectedEntries.map((entry, idx) => (
                      <div key={entry.question.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <span className="font-bold text-[#123B68] mr-1.5">
                            #{idx + 1} (P{entry.part})
                          </span>
                          <span className="text-[#203247] truncate">
                            {entry.question.questionText.slice(0, 75)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <input
                            type="number"
                            step="0.05"
                            min={0.05}
                            max={20}
                            value={entry.points}
                            onChange={(e) =>
                              updateQuestionPoints(entry.question.id, Number(e.target.value) || 0)
                            }
                            className="w-16 rounded border border-slate-300 px-1.5 py-1 text-right tabular-nums text-xs"
                          />
                          <span className="text-[#65758B]">đ</span>
                          <button
                            type="button"
                            onClick={() => removeQuestionFromExam(entry.question.id)}
                            className="p-1 text-[#D94B45] hover:bg-[#FDF1F0] rounded"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  disabled={!emailVerified || !validation?.valid || publishing}
                  onClick={() => void handlePublish()}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-[#123B68] px-4 py-2.5 min-h-[44px] text-sm font-semibold text-white hover:bg-[#2878B8] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Send className="h-4 w-4" />
                  <span>{publishing ? 'Đang niêm phong & xuất bản...' : 'Xuất bản đề thi cho Học sinh'}</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Published Exams Management Table */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-display text-base font-bold text-[#123B68]">
            Đề thi đã xuất bản ({publishedExams.length})
          </h3>
          <span className="text-xs text-[#65758B]">
            Đáp án &amp; Rubric gốc lưu tách biệt trong kho bảo mật giáo viên
          </span>
        </div>

        {publishedExams.length === 0 ? (
          <p className="text-xs text-[#65758B]">
            Chưa có đề thi nào được xuất bản.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-[#F3F6FA] font-semibold text-[#65758B]">
                <tr>
                  <th className="px-4 py-3">Tên đề thi</th>
                  <th className="px-4 py-3">Mã phòng</th>
                  <th className="px-4 py-3">Cấu trúc 3 phần</th>
                  <th className="px-4 py-3">Trạng thái</th>
                  <th className="px-4 py-3 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {publishedExams.map((exam) => (
                  <tr key={exam.id} className="hover:bg-[#F3F6FA]/60">
                    <td className="px-4 py-3">
                      <div className="font-bold text-[#123B68]">{exam.title}</div>
                      <div className="text-[11px] text-[#65758B] tabular-nums">
                        {exam.durationMinutes} phút · {exam.totalPoints}đ · {exam.recognitionPct}%/
                        {exam.understandingPct}%/{exam.applicationPct}%
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => void copyCode(exam.accessCode)}
                        className="inline-flex items-center gap-1 rounded border border-slate-300 bg-[#F3F6FA] px-2 py-1 font-mono font-bold text-[#123B68] hover:border-[#2878B8]"
                      >
                        <span>{exam.accessCode}</span>
                        <ClipboardCheck className="h-3 w-3 text-[#2878B8]" />
                      </button>
                      {copiedCode === exam.accessCode && (
                        <span className="ml-1.5 text-[11px] text-[#2D6A23] font-medium">
                          Đã chép
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-[#203247]">
                      P1: {exam.part1Count} ({exam.part1Points}đ) · P2: {exam.part2Count} (
                      {exam.part2Points}đ) · P3: {exam.part3Count} ({exam.part3Points}đ)
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-semibold ${
                          exam.status === 'published'
                            ? 'bg-[#EEF7EC] text-[#2D6A23]'
                            : 'bg-slate-100 text-[#65758B]'
                        }`}
                      >
                        {exam.status === 'published' ? 'Đang mở thi' : 'Đã đóng'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busyExamId === exam.id}
                          onClick={() => void handleToggleStatus(exam)}
                          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 font-semibold text-[#123B68] hover:bg-[#F3F6FA]"
                        >
                          {exam.status === 'published' ? (
                            <>
                              <Lock className="h-3 w-3" />
                              <span>Đóng đề</span>
                            </>
                          ) : (
                            <>
                              <Unlock className="h-3 w-3" />
                              <span>Mở lại</span>
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          disabled={busyExamId === exam.id}
                          onClick={() => void handleDeleteExam(exam.id)}
                          className="rounded border border-slate-300 bg-white p-1.5 text-[#D94B45] hover:border-[#D94B45] hover:bg-[#FDF1F0]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
