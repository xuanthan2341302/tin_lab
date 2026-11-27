import { useState, type FormEvent } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Mail,
  Send,
  ShieldCheck,
} from 'lucide-react'
import type { NavPage } from '../types'

interface ContactPageProps {
  onNavigate: (page: NavPage) => void
}

interface ContactFormValues {
  fullName: string
  email: string
  phone: string
  subject: string
  message: string
  website: string // Honeypot field for spam bots
}

interface ContactResponsePayload {
  ok?: boolean
  code?: string
  message?: string
  error?: string
  fieldErrors?: Record<string, string>
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const PHONE_PATTERN = /^[0-9+\s().-]{8,20}$/

export function ContactPage({ onNavigate }: ContactPageProps) {
  const [formValues, setFormValues] = useState<ContactFormValues>({
    fullName: '',
    email: '',
    phone: '',
    subject: '',
    message: '',
    website: '',
  })
  const [formStartedAt, setFormStartedAt] = useState<number>(() => Date.now())
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitResult, setSubmitResult] = useState<{
    type: 'success' | 'warning' | 'error'
    text: string
  } | null>(null)

  const validateClient = (values: ContactFormValues): Record<string, string> => {
    const errors: Record<string, string> = {}
    const fullName = values.fullName.trim()
    const email = values.email.trim()
    const phone = values.phone.trim()
    const subject = values.subject.trim()
    const message = values.message.trim()

    if (fullName.length < 2 || fullName.length > 100) {
      errors.fullName = 'Vui lòng nhập họ và tên (tối thiểu 2 ký tự).'
    }
    if (!EMAIL_PATTERN.test(email)) {
      errors.email = 'Vui lòng nhập địa chỉ email hợp lệ.'
    }
    if (phone.length > 0 && !PHONE_PATTERN.test(phone)) {
      errors.phone = 'Số điện thoại không hợp lệ (8–20 ký tự số).'
    }
    if (subject.length < 3 || subject.length > 150) {
      errors.subject = 'Vui lòng nhập chủ đề liên hệ (tối thiểu 3 ký tự).'
    }
    if (message.length < 10 || message.length > 3000) {
      errors.message = 'Vui lòng nhập nội dung tin nhắn tối thiểu 10 ký tự.'
    }
    return errors
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitResult(null)

    const clientErrors = validateClient(formValues)
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors)
      setSubmitResult({
        type: 'error',
        text: 'Vui lòng kiểm tra và hoàn thiện các trường thông tin bắt buộc.',
      })
      return
    }

    setFieldErrors({})
    setSubmitting(true)

    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formValues,
          formStartedAt,
        }),
      })

      let payload: ContactResponsePayload = {}
      try {
        payload = (await response.json()) as ContactResponsePayload
      } catch {
        payload = {}
      }

      if (response.ok && payload.ok) {
        setSubmitResult({
          type: 'success',
          text:
            payload.message ||
            'Tin nhắn của bạn đã được gửi thành công tới sunghiep.tsbd@gmail.com.',
        })
        setFormValues({
          fullName: '',
          email: '',
          phone: '',
          subject: '',
          message: '',
          website: '',
        })
        setFormStartedAt(Date.now())
      } else if (
        response.status === 503 ||
        response.status === 501 ||
        payload.code === 'EMAIL_NOT_CONFIGURED' ||
        payload.code === 'PHASE2_DEFERRED'
      ) {
        setSubmitResult({
          type: 'warning',
          text:
            payload.error ||
            'Dịch vụ gửi email trên máy chủ chưa được cấu hình hoặc tạm hoãn ở Giai đoạn 1. Vui lòng liên hệ trực tiếp qua email bên cạnh.',
        })
      } else {
        if (payload.fieldErrors) {
          setFieldErrors(payload.fieldErrors)
        }
        setSubmitResult({
          type: 'error',
          text:
            payload.error ||
            'Không thể gửi yêu cầu liên hệ lúc này. Vui lòng thử lại sau.',
        })
      }
    } catch {
      setSubmitResult({
        type: 'error',
        text: 'Lỗi kết nối tới máy chủ backend (/api/contact). Vui lòng kiểm tra kết nối mạng và thử lại.',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8">
        <div className="space-y-2 max-w-2xl">
          <div className="inline-flex items-center gap-2 text-xs font-semibold text-[#2878B8]">
            <Mail className="h-4 w-4" />
            <span>Liên hệ &amp; Hỗ trợ TIN LAB</span>
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-[#123B68] text-balance">
            Gửi phản hồi hoặc yêu cầu hỗ trợ
          </h1>
          <p className="text-sm sm:text-base leading-relaxed text-[#203247]">
            Nếu bạn cần hỗ trợ kỹ thuật, góp ý học liệu Tin học 12 hoặc trao đổi triển khai
            cho nhà trường, vui lòng gửi thông tin qua biểu mẫu bên dưới.
          </p>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Contact Form */}
        <section className="lg:col-span-8 rounded-xl border border-slate-200 bg-white p-6 sm:p-8">
          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            {/* Honeypot anti-spam field hidden from real users */}
            <div
              aria-hidden="true"
              className="absolute -left-[9999px] h-0 w-0 overflow-hidden opacity-0"
            >
              <label htmlFor="contact-website">Trang web</label>
              <input
                id="contact-website"
                name="website"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={formValues.website}
                onChange={(e) =>
                  setFormValues((prev) => ({ ...prev, website: e.target.value }))
                }
              />
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="contact-fullname"
                  className="block text-sm font-medium text-[#203247] mb-1.5"
                >
                  Họ và tên <span className="text-[#D94B45]">*</span>
                </label>
                <input
                  id="contact-fullname"
                  name="fullName"
                  type="text"
                  required
                  value={formValues.fullName}
                  onChange={(e) =>
                    setFormValues((prev) => ({ ...prev, fullName: e.target.value }))
                  }
                  placeholder="Nhập họ và tên của bạn"
                  aria-invalid={Boolean(fieldErrors.fullName)}
                  className={`w-full rounded-lg border px-3.5 py-2.5 text-sm text-[#203247] placeholder:text-[#65758B]/70 focus:outline-none focus:ring-2 ${
                    fieldErrors.fullName
                      ? 'border-[#D94B45] focus:border-[#D94B45] focus:ring-[#D94B45]/20'
                      : 'border-slate-300 focus:border-[#2878B8] focus:ring-[#2878B8]/20'
                  }`}
                />
                {fieldErrors.fullName && (
                  <p className="mt-1.5 text-xs text-[#A92F2A]">{fieldErrors.fullName}</p>
                )}
              </div>

              <div>
                <label
                  htmlFor="contact-email"
                  className="block text-sm font-medium text-[#203247] mb-1.5"
                >
                  Địa chỉ email <span className="text-[#D94B45]">*</span>
                </label>
                <input
                  id="contact-email"
                  name="email"
                  type="email"
                  required
                  value={formValues.email}
                  onChange={(e) =>
                    setFormValues((prev) => ({ ...prev, email: e.target.value }))
                  }
                  placeholder="ban@example.com"
                  aria-invalid={Boolean(fieldErrors.email)}
                  className={`w-full rounded-lg border px-3.5 py-2.5 text-sm text-[#203247] placeholder:text-[#65758B]/70 focus:outline-none focus:ring-2 ${
                    fieldErrors.email
                      ? 'border-[#D94B45] focus:border-[#D94B45] focus:ring-[#D94B45]/20'
                      : 'border-slate-300 focus:border-[#2878B8] focus:ring-[#2878B8]/20'
                  }`}
                />
                {fieldErrors.email && (
                  <p className="mt-1.5 text-xs text-[#A92F2A]">{fieldErrors.email}</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="contact-phone"
                  className="block text-sm font-medium text-[#203247] mb-1.5"
                >
                  Số điện thoại (tùy chọn)
                </label>
                <input
                  id="contact-phone"
                  name="phone"
                  type="tel"
                  value={formValues.phone}
                  onChange={(e) =>
                    setFormValues((prev) => ({ ...prev, phone: e.target.value }))
                  }
                  placeholder="Ví dụ: 0912 345 678"
                  aria-invalid={Boolean(fieldErrors.phone)}
                  className={`w-full rounded-lg border px-3.5 py-2.5 text-sm text-[#203247] placeholder:text-[#65758B]/70 focus:outline-none focus:ring-2 ${
                    fieldErrors.phone
                      ? 'border-[#D94B45] focus:border-[#D94B45] focus:ring-[#D94B45]/20'
                      : 'border-slate-300 focus:border-[#2878B8] focus:ring-[#2878B8]/20'
                  }`}
                />
                {fieldErrors.phone && (
                  <p className="mt-1.5 text-xs text-[#A92F2A]">{fieldErrors.phone}</p>
                )}
              </div>

              <div>
                <label
                  htmlFor="contact-subject"
                  className="block text-sm font-medium text-[#203247] mb-1.5"
                >
                  Chủ đề <span className="text-[#D94B45]">*</span>
                </label>
                <input
                  id="contact-subject"
                  name="subject"
                  type="text"
                  required
                  value={formValues.subject}
                  onChange={(e) =>
                    setFormValues((prev) => ({ ...prev, subject: e.target.value }))
                  }
                  placeholder="Ví dụ: Hỗ trợ tài khoản giáo viên"
                  aria-invalid={Boolean(fieldErrors.subject)}
                  className={`w-full rounded-lg border px-3.5 py-2.5 text-sm text-[#203247] placeholder:text-[#65758B]/70 focus:outline-none focus:ring-2 ${
                    fieldErrors.subject
                      ? 'border-[#D94B45] focus:border-[#D94B45] focus:ring-[#D94B45]/20'
                      : 'border-slate-300 focus:border-[#2878B8] focus:ring-[#2878B8]/20'
                  }`}
                />
                {fieldErrors.subject && (
                  <p className="mt-1.5 text-xs text-[#A92F2A]">{fieldErrors.subject}</p>
                )}
              </div>
            </div>

            <div>
              <label
                htmlFor="contact-message"
                className="block text-sm font-medium text-[#203247] mb-1.5"
              >
                Nội dung tin nhắn <span className="text-[#D94B45]">*</span>
              </label>
              <textarea
                id="contact-message"
                name="message"
                rows={5}
                required
                value={formValues.message}
                onChange={(e) =>
                  setFormValues((prev) => ({ ...prev, message: e.target.value }))
                }
                placeholder="Mô tả chi tiết nội dung bạn cần trao đổi hoặc hỗ trợ..."
                aria-invalid={Boolean(fieldErrors.message)}
                className={`w-full rounded-lg border px-3.5 py-2.5 text-sm text-[#203247] placeholder:text-[#65758B]/70 focus:outline-none focus:ring-2 ${
                  fieldErrors.message
                    ? 'border-[#D94B45] focus:border-[#D94B45] focus:ring-[#D94B45]/20'
                    : 'border-slate-300 focus:border-[#2878B8] focus:ring-[#2878B8]/20'
                }`}
              />
              {fieldErrors.message && (
                <p className="mt-1.5 text-xs text-[#A92F2A]">{fieldErrors.message}</p>
              )}
            </div>

            {submitResult && (
              <div
                role="status"
                className={`flex items-start gap-3 rounded-lg border px-4 py-3.5 text-xs sm:text-sm leading-relaxed ${
                  submitResult.type === 'success'
                    ? 'border-[#55A747]/40 bg-[#EEF7EC] text-[#2E6B24]'
                    : submitResult.type === 'warning'
                    ? 'border-[#F28C28]/45 bg-[#FEF6EC] text-[#9A520B]'
                    : 'border-[#D94B45]/40 bg-[#FDF1F0] text-[#A92F2A]'
                }`}
              >
                {submitResult.type === 'success' ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-[#55A747] mt-0.5" />
                ) : submitResult.type === 'warning' ? (
                  <AlertTriangle className="h-5 w-5 shrink-0 text-[#F28C28] mt-0.5" />
                ) : (
                  <AlertCircle className="h-5 w-5 shrink-0 text-[#D94B45] mt-0.5" />
                )}
                <span>{submitResult.text}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
              <div className="inline-flex items-center gap-2 text-xs text-[#65758B]">
                <ShieldCheck className="h-4 w-4 text-[#55A747] shrink-0" />
                <span>Xử lý an toàn qua máy chủ và có kiểm tra chống spam</span>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#2878B8] px-6 py-3 min-h-[44px] text-sm font-semibold text-white hover:bg-[#123B68] disabled:opacity-60 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
              >
                <Send className="h-4 w-4" />
                <span>{submitting ? 'Đang gửi...' : 'Gửi tin nhắn'}</span>
              </button>
            </div>
          </form>
        </section>

        {/* Contact Details Side Card */}
        <aside className="lg:col-span-4 space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
            <h2 className="font-display text-base font-bold text-[#123B68]">
              Thông tin tiếp nhận
            </h2>
            <div className="space-y-3 text-sm">
              <div className="border-b border-slate-100 pb-3">
                <div className="text-xs text-[#65758B]">Email tiếp nhận liên hệ</div>
                <div className="mt-1 font-mono text-xs sm:text-sm font-semibold text-[#123B68] break-all">
                  sunghiep.tsbd@gmail.com
                </div>
              </div>
              <div className="border-b border-slate-100 pb-3">
                <div className="text-xs text-[#65758B]">Phạm vi hỗ trợ</div>
                <div className="mt-1 text-xs leading-relaxed text-[#203247]">
                  Giải đáp thắc mắc sử dụng TIN LAB, góp ý ngân hàng câu hỏi Tin học 12 và hỗ trợ triển khai cho giáo viên, học sinh.
                </div>
              </div>
              <div>
                <div className="text-xs text-[#65758B]">Tài liệu tham khảo nhanh</div>
                <button
                  type="button"
                  onClick={() => onNavigate('guide')}
                  className="mt-1 text-xs font-semibold text-[#2878B8] hover:text-[#123B68]"
                >
                  Xem Hướng dẫn sử dụng →
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
