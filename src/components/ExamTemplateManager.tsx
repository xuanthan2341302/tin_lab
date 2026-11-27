import { useState, type FormEvent } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Edit3,
  LayoutTemplate,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'
import type { ExamTemplate, Part2ScoringMode } from '../types'
import {
  createExamTemplate,
  deleteExamTemplate,
  PRESET_45M_TEMPLATE_INPUT,
  updateExamTemplate,
  validateExamTemplateInput,
  type ExamTemplateInput,
} from '../lib/examDb'

interface ExamTemplateManagerProps {
  ownerUid: string
  emailVerified: boolean
  templates: ExamTemplate[]
  onRefresh: () => Promise<void>
  onUseTemplate?: (template: ExamTemplate) => void
}

const DEFAULT_FORM_VALUES: ExamTemplateInput = {
  ...PRESET_45M_TEMPLATE_INPUT,
  name: '',
}

export function ExamTemplateManager({
  ownerUid,
  emailVerified,
  templates,
  onRefresh,
  onUseTemplate,
}: ExamTemplateManagerProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<ExamTemplateInput>(DEFAULT_FORM_VALUES)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const cognitiveSum = form.recognitionPct + form.understandingPct + form.applicationPct
  const partsPointSum =
    Math.round(
      ((form.part1Enabled ? Number(form.part1Points) : 0) +
        (form.part2Enabled ? Number(form.part2Points) : 0) +
        (form.part3Enabled ? Number(form.part3Points) : 0)) *
        1000
    ) / 1000

  const startCreateCustom = () => {
    setEditingId(null)
    setForm({ ...DEFAULT_FORM_VALUES })
    setError(null)
    setSuccess(null)
    setShowForm(true)
  }

  const startEdit = (tpl: ExamTemplate) => {
    setEditingId(tpl.id)
    setForm({
      name: tpl.name,
      description: tpl.description,
      schoolFormatLabel: tpl.schoolFormatLabel,
      durationMinutes: tpl.durationMinutes,
      totalPoints: tpl.totalPoints,
      part1Enabled: tpl.part1Enabled,
      part1Title: tpl.part1Title,
      part1Count: tpl.part1Count,
      part1Points: tpl.part1Points,
      part2Enabled: tpl.part2Enabled,
      part2Title: tpl.part2Title,
      part2Count: tpl.part2Count,
      part2Points: tpl.part2Points,
      part2ScoringMode: tpl.part2ScoringMode,
      part3Enabled: tpl.part3Enabled,
      part3Title: tpl.part3Title,
      part3Count: tpl.part3Count,
      part3Points: tpl.part3Points,
      recognitionPct: tpl.recognitionPct,
      understandingPct: tpl.understandingPct,
      applicationPct: tpl.applicationPct,
    })
    setError(null)
    setSuccess(null)
    setShowForm(true)
  }

  const handleDuplicate = (tpl: ExamTemplate) => {
    setEditingId(null)
    setForm({
      name: `${tpl.name} (Bản sao)`.slice(0, 150),
      description: tpl.description,
      schoolFormatLabel: tpl.schoolFormatLabel,
      durationMinutes: tpl.durationMinutes,
      totalPoints: tpl.totalPoints,
      part1Enabled: tpl.part1Enabled,
      part1Title: tpl.part1Title,
      part1Count: tpl.part1Count,
      part1Points: tpl.part1Points,
      part2Enabled: tpl.part2Enabled,
      part2Title: tpl.part2Title,
      part2Count: tpl.part2Count,
      part2Points: tpl.part2Points,
      part2ScoringMode: tpl.part2ScoringMode,
      part3Enabled: tpl.part3Enabled,
      part3Title: tpl.part3Title,
      part3Count: tpl.part3Count,
      part3Points: tpl.part3Points,
      recognitionPct: tpl.recognitionPct,
      understandingPct: tpl.understandingPct,
      applicationPct: tpl.applicationPct,
    })
    setError(null)
    setSuccess(null)
    setShowForm(true)
  }

  const handleCreatePreset45m = async () => {
    if (!emailVerified) return
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      await createExamTemplate(ownerUid, PRESET_45M_TEMPLATE_INPUT)
      setSuccess('Đã tạo mẫu đề chuẩn 45 phút (12 TN · 4 Đúng/Sai · Tự luận · 10 điểm).')
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể tạo mẫu đề chuẩn.')
    } finally {
      setSaving(false)
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    const validationErr = validateExamTemplateInput(form)
    if (validationErr) {
      setError(validationErr)
      return
    }

    setSaving(true)
    try {
      if (editingId) {
        await updateExamTemplate(editingId, form)
        setSuccess('Đã cập nhật cấu trúc đề thi.')
      } else {
        await createExamTemplate(ownerUid, form)
        setSuccess('Đã tạo cấu trúc đề thi mới.')
      }
      setShowForm(false)
      setEditingId(null)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể lưu cấu trúc đề thi.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    setError(null)
    try {
      await deleteExamTemplate(id)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể xóa cấu trúc đề thi.')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center justify-between">
          <div>
            <h3 className="font-display text-base font-bold text-[#123B68]">
              Quản lý cấu trúc đề thi &amp; Ma trận điểm (Không giới hạn định dạng)
            </h3>
            <p className="text-xs text-[#65758B] mt-0.5">
              Giáo viên tự cấu hình thời lượng, số câu và điểm cho từng phần (TN 4 lựa chọn, Đúng/Sai 4 ý, Tự luận) và tỷ lệ Nhận biết / Thông hiểu / Vận dụng theo quy định từng trường.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={!emailVerified || saving}
              onClick={() => void handleCreatePreset45m()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#2878B8] bg-[#EAF3FA] px-3.5 py-2 text-xs font-semibold text-[#123B68] hover:bg-[#d8eaf7] disabled:opacity-50 transition-colors"
            >
              <Sparkles className="h-3.5 w-3.5 text-[#2878B8]" />
              <span>Tạo nhanh mẫu chuẩn 45p (10đ)</span>
            </button>
            <button
              type="button"
              disabled={!emailVerified}
              onClick={startCreateCustom}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#2878B8] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#123B68] disabled:opacity-50 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Tạo cấu trúc mới</span>
            </button>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[#D94B45]/40 bg-[#FDF1F0] px-4 py-3 text-xs text-[#A92F2A]"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#D94B45]" />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-[#55A747]/40 bg-[#EEF7EC] px-4 py-3 text-xs font-medium text-[#2D6A23]"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[#55A747]" />
            <span>{success}</span>
          </div>
        )}

        {showForm && (
          <form
            onSubmit={handleSubmit}
            className="rounded-xl border border-[#2878B8]/35 bg-[#F3F6FA]/70 p-5 space-y-5"
          >
            <div className="flex items-center justify-between">
              <h4 className="font-display text-sm font-bold text-[#123B68]">
                {editingId ? 'Chỉnh sửa cấu trúc đề thi' : 'Tạo cấu trúc đề thi mới'}
              </h4>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="text-xs font-semibold text-[#65758B] hover:text-[#123B68]"
              >
                Đóng biểu mẫu
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-12">
              <div className="sm:col-span-5">
                <label className="block text-xs font-semibold text-[#203247] mb-1">
                  Tên cấu trúc đề thi *
                </label>
                <input
                  type="text"
                  required
                  maxLength={150}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Ví dụ: Đề kiểm tra 45 phút Tin 12 - Định dạng 3 phần"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247]"
                />
              </div>

              <div className="sm:col-span-3">
                <label className="block text-xs font-semibold text-[#203247] mb-1">
                  Nhãn trường / Tổ CM
                </label>
                <input
                  type="text"
                  maxLength={120}
                  value={form.schoolFormatLabel}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, schoolFormatLabel: e.target.value }))
                  }
                  placeholder="GDPT 2018 · Tin 12"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247]"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-[#203247] mb-1">
                  Phút
                </label>
                <input
                  type="number"
                  min={5}
                  max={180}
                  value={form.durationMinutes}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, durationMinutes: Number(e.target.value) || 45 }))
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm tabular-nums text-[#203247]"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-[#203247] mb-1">
                  Tổng điểm
                </label>
                <input
                  type="number"
                  step="0.25"
                  min={1}
                  max={100}
                  value={form.totalPoints}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, totalPoints: Number(e.target.value) || 10 }))
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm tabular-nums text-[#203247]"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#203247] mb-1">
                Mô tả cấu trúc
              </label>
              <input
                type="text"
                maxLength={1000}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Ghi chú phạm vi kiến thức hoặc quy định chấm điểm..."
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-[#203247]"
              />
            </div>

            {/* 3 Parts Configuration */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {/* Part 1 */}
              <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
                <label className="flex items-center justify-between gap-2 text-xs font-bold text-[#123B68]">
                  <span>Phần I · Trắc nghiệm A/B/C/D</span>
                  <input
                    type="checkbox"
                    checked={form.part1Enabled}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, part1Enabled: e.target.checked }))
                    }
                    className="h-4 w-4 accent-[#2878B8]"
                  />
                </label>
                <input
                  type="text"
                  disabled={!form.part1Enabled}
                  value={form.part1Title}
                  onChange={(e) => setForm((f) => ({ ...f, part1Title: e.target.value }))}
                  className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs disabled:bg-slate-100"
                />
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] text-[#65758B] mb-0.5">Số câu</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      disabled={!form.part1Enabled}
                      value={form.part1Count}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, part1Count: Number(e.target.value) || 0 }))
                      }
                      className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums disabled:bg-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#65758B] mb-0.5">Tổng điểm</label>
                    <input
                      type="number"
                      step="0.25"
                      min={0}
                      max={100}
                      disabled={!form.part1Enabled}
                      value={form.part1Points}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, part1Points: Number(e.target.value) || 0 }))
                      }
                      className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums disabled:bg-slate-100"
                    />
                  </div>
                </div>
              </div>

              {/* Part 2 */}
              <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
                <label className="flex items-center justify-between gap-2 text-xs font-bold text-[#123B68]">
                  <span>Phần II · Đúng / Sai (4 ý)</span>
                  <input
                    type="checkbox"
                    checked={form.part2Enabled}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, part2Enabled: e.target.checked }))
                    }
                    className="h-4 w-4 accent-[#2878B8]"
                  />
                </label>
                <input
                  type="text"
                  disabled={!form.part2Enabled}
                  value={form.part2Title}
                  onChange={(e) => setForm((f) => ({ ...f, part2Title: e.target.value }))}
                  className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs disabled:bg-slate-100"
                />
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] text-[#65758B] mb-0.5">Số câu</label>
                    <input
                      type="number"
                      min={0}
                      max={50}
                      disabled={!form.part2Enabled}
                      value={form.part2Count}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, part2Count: Number(e.target.value) || 0 }))
                      }
                      className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums disabled:bg-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#65758B] mb-0.5">Tổng điểm</label>
                    <input
                      type="number"
                      step="0.25"
                      min={0}
                      max={100}
                      disabled={!form.part2Enabled}
                      value={form.part2Points}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, part2Points: Number(e.target.value) || 0 }))
                      }
                      className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums disabled:bg-slate-100"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] text-[#65758B] mb-0.5">
                    Thang chấm mỗi câu Đúng/Sai
                  </label>
                  <select
                    disabled={!form.part2Enabled}
                    value={form.part2ScoringMode}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        part2ScoringMode: e.target.value as Part2ScoringMode,
                      }))
                    }
                    className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs disabled:bg-slate-100"
                  >
                    <option value="tiered_2025">Bậc thang 2025 (1:10%, 2:25%, 3:50%, 4:100%)</option>
                    <option value="linear">Tuyến tính (mỗi ý đúng 25%)</option>
                  </select>
                </div>
              </div>

              {/* Part 3 */}
              <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
                <label className="flex items-center justify-between gap-2 text-xs font-bold text-[#123B68]">
                  <span>Phần III · Tự luận (Rubric)</span>
                  <input
                    type="checkbox"
                    checked={form.part3Enabled}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, part3Enabled: e.target.checked }))
                    }
                    className="h-4 w-4 accent-[#2878B8]"
                  />
                </label>
                <input
                  type="text"
                  disabled={!form.part3Enabled}
                  value={form.part3Title}
                  onChange={(e) => setForm((f) => ({ ...f, part3Title: e.target.value }))}
                  className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs disabled:bg-slate-100"
                />
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] text-[#65758B] mb-0.5">Số câu</label>
                    <input
                      type="number"
                      min={0}
                      max={20}
                      disabled={!form.part3Enabled}
                      value={form.part3Count}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, part3Count: Number(e.target.value) || 0 }))
                      }
                      className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums disabled:bg-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#65758B] mb-0.5">Tổng điểm</label>
                    <input
                      type="number"
                      step="0.25"
                      min={0}
                      max={100}
                      disabled={!form.part3Enabled}
                      value={form.part3Points}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, part3Points: Number(e.target.value) || 0 }))
                      }
                      className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums disabled:bg-slate-100"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Cognitive Distribution */}
            <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-[#123B68]">
                  Phân bố mức độ nhận thức mục tiêu (%)
                </span>
                <span
                  className={`text-xs font-semibold tabular-nums ${
                    cognitiveSum === 100 ? 'text-[#2D6A23]' : 'text-[#D94B45]'
                  }`}
                >
                  Tổng tỷ lệ: {cognitiveSum}% {cognitiveSum === 100 ? '(Hợp lệ)' : '(Phải = 100%)'}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] text-[#65758B] mb-0.5">Nhận biết (%)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={form.recognitionPct}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, recognitionPct: Number(e.target.value) || 0 }))
                    }
                    className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-[#65758B] mb-0.5">Thông hiểu (%)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={form.understandingPct}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, understandingPct: Number(e.target.value) || 0 }))
                    }
                    className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-[#65758B] mb-0.5">Vận dụng (%)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={form.applicationPct}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, applicationPct: Number(e.target.value) || 0 }))
                    }
                    className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
              <div className="text-xs text-[#65758B] tabular-nums">
                Tổng điểm cộng các phần:{' '}
                <strong
                  className={
                    Math.abs(partsPointSum - form.totalPoints) <= 0.01
                      ? 'text-[#2D6A23]'
                      : 'text-[#D94B45]'
                  }
                >
                  {partsPointSum} / {form.totalPoints} điểm
                </strong>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-[#203247]"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-[#123B68] px-5 py-2 text-xs font-semibold text-white hover:bg-[#2878B8] disabled:opacity-50"
                >
                  {saving ? 'Đang lưu...' : editingId ? 'Lưu cập nhật' : 'Tạo cấu trúc đề'}
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Saved Templates List */}
        {templates.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-[#F3F6FA] p-8 text-center space-y-3">
            <LayoutTemplate className="mx-auto h-8 w-8 text-[#65758B]" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[#123B68]">
                Chưa có cấu trúc đề thi nào được lưu
              </p>
              <p className="text-xs text-[#65758B]">
                Nhấn "Tạo nhanh mẫu chuẩn 45p (10đ)" để khởi tạo cấu trúc 3 phần (12 TN · 4 Đúng/Sai · Tự luận) hoặc tạo mẫu riêng cho trường của bạn.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {templates.map((tpl) => (
              <div
                key={tpl.id}
                className="rounded-xl border border-slate-200 bg-white p-5 space-y-3 flex flex-col justify-between"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-semibold text-[#2878B8]">
                        {tpl.schoolFormatLabel || 'Cấu trúc đề thi tùy chỉnh'}
                      </div>
                      <h4 className="font-display text-sm font-bold text-[#123B68]">
                        {tpl.name}
                      </h4>
                    </div>
                    <div className="shrink-0 rounded-md border border-[#123B68]/20 bg-[#F3F6FA] px-2.5 py-1 text-xs font-bold tabular-nums text-[#123B68]">
                      {tpl.durationMinutes} phút · {tpl.totalPoints}đ
                    </div>
                  </div>

                  {tpl.description && (
                    <p className="text-xs text-[#65758B] leading-relaxed">
                      {tpl.description}
                    </p>
                  )}

                  <div className="grid grid-cols-3 gap-2 text-xs pt-1">
                    <div className="rounded-lg border border-slate-200 bg-[#F3F6FA] p-2">
                      <div className="text-[11px] text-[#65758B]">Phần I (TN)</div>
                      <div className="font-bold text-[#123B68] tabular-nums">
                        {tpl.part1Enabled ? `${tpl.part1Count} câu · ${tpl.part1Points}đ` : 'Tắt'}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-[#F3F6FA] p-2">
                      <div className="text-[11px] text-[#65758B]">Phần II (Đ/S)</div>
                      <div className="font-bold text-[#123B68] tabular-nums">
                        {tpl.part2Enabled ? `${tpl.part2Count} câu · ${tpl.part2Points}đ` : 'Tắt'}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-[#F3F6FA] p-2">
                      <div className="text-[11px] text-[#65758B]">Phần III (TL)</div>
                      <div className="font-bold text-[#123B68] tabular-nums">
                        {tpl.part3Enabled ? `${tpl.part3Count} câu · ${tpl.part3Points}đ` : 'Tắt'}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#65758B] pt-1 tabular-nums">
                    <span>
                      Nhận thức: {tpl.recognitionPct}% NB · {tpl.understandingPct}% TH ·{' '}
                      {tpl.applicationPct}% VD
                    </span>
                    {tpl.part2Enabled && (
                      <span>
                        Đ/S: {tpl.part2ScoringMode === 'tiered_2025' ? 'Bậc thang 2025' : 'Tuyến tính'}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3">
                  {onUseTemplate ? (
                    <button
                      type="button"
                      onClick={() => onUseTemplate(tpl)}
                      className="rounded-lg bg-[#2878B8] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#123B68] transition-colors"
                    >
                      Dùng mẫu này tạo đề →
                    </button>
                  ) : (
                    <span />
                  )}

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleDuplicate(tpl)}
                      title="Nhân bản cấu trúc"
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-[#203247] hover:bg-[#F3F6FA]"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      <span>Nhân bản</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(tpl)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-[#123B68] hover:border-[#2878B8]"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                      <span>Sửa</span>
                    </button>
                    <button
                      type="button"
                      disabled={deletingId === tpl.id}
                      onClick={() => void handleDelete(tpl.id)}
                      className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white p-1.5 text-[#D94B45] hover:border-[#D94B45] hover:bg-[#FDF1F0]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
