import { useState } from 'react'
import {
  BookOpen,
  ChevronDown,
  GraduationCap,
  HelpCircle,
  Users,
} from 'lucide-react'
import type { NavPage } from '../types'

interface GuidePageProps {
  onNavigate: (page: NavPage) => void
}

const STUDENT_STEPS = [
  {
    step: '01.',
    title: 'Truy cập khu vực Học sinh',
    description:
      'Từ thanh điều hướng phía trên (hoặc menu trên điện thoại), chọn mục "Học sinh" để mở cổng ôn tập và thi trực tuyến mà không cần tài khoản.',
  },
  {
    step: '02.',
    title: 'Chọn bộ đề và điền Họ tên, Lớp học',
    description:
      'Chọn bộ đề ôn tập hoặc đề kiểm tra được phát hành, sau đó nhập đầy đủ Họ và tên cùng Lớp học (ví dụ: 12A1) để hệ thống cấp mã lượt làm bài.',
  },
  {
    step: '03.',
    title: 'Hoàn thành bài làm trong thời gian quy định',
    description:
      'Chọn đáp án A, B, C, D, trả lời câu hỏi Đúng/Sai hoặc tự luận. Đồng hồ đếm ngược sẽ theo dõi thời gian làm bài trực tiếp.',
  },
  {
    step: '04.',
    title: 'Nộp bài và xem kết quả chi tiết',
    description:
      'Nhấn "Nộp bài" để hệ thống chấm điểm khách quan ngay lập tức, lưu lịch sử lượt thi và hiển thị giải thích từng câu để tự củng cố kiến thức.',
  },
]

const TEACHER_STEPS = [
  {
    step: '01.',
    title: 'Mở trang Đăng nhập quản trị (/giao-vien)',
    description:
      'Chọn mục "Quản trị" trên thanh điều hướng hoặc truy cập trực tiếp đường dẫn /giao-vien để mở cổng đăng nhập dành cho Super Admin.',
  },
  {
    step: '02.',
    title: 'Đăng nhập bằng Google với tài khoản Super Admin',
    description:
      'Nhấn nút "Đăng nhập bằng Google" và chọn một trong hai tài khoản Google Super Admin được cấp phép. Máy chủ sẽ xác minh danh tính và quyền truy cập trước khi mở khu vực quản trị.',
  },
  {
    step: '03.',
    title: 'Quản lý tài liệu, ngân hàng câu hỏi & phát hành đề',
    description:
      'Tải lên tài liệu, bóc tách câu hỏi, cấu hình ma trận đề thi và phát hành bài kiểm tra cho học sinh truy cập trực tiếp.',
  },
  {
    step: '04.',
    title: 'Theo dõi kết quả học sinh & xuất báo cáo Excel',
    description:
      'Tra cứu bài làm theo họ tên, lớp học, mã lượt làm bài, chấm bổ sung câu tự luận, theo dõi tiến độ nhiều lần làm và xuất file .xlsx.',
  },
]

const FAQ_ITEMS = [
  {
    id: 'faq-1',
    question: 'Học sinh có cần tạo tài khoản hay mật khẩu trước khi làm bài không?',
    answer:
      'Không. Học sinh truy cập trực tiếp mục "Học sinh", chọn đề thi và nhập Họ tên cùng Lớp học là có thể làm bài ngay mà không cần tài khoản, mật khẩu hay đăng nhập.',
  },
  {
    id: 'faq-2',
    question: 'Các số liệu trong trang Thống kê được lấy từ đâu?',
    answer:
      'Toàn bộ chỉ số tài liệu, câu hỏi trích xuất, bản nháp, ngoại lệ, đề thi đã xuất bản và kết quả học sinh đều được truy vấn trực tiếp từ cơ sở dữ liệu thực tế (PostgreSQL & Cloud Firestore). Nếu hệ thống chưa có dữ liệu ở mục nào, giao diện sẽ hiển thị 0 hoặc "Chưa có dữ liệu".',
  },
  {
    id: 'faq-3',
    question: 'Làm thế nào để giáo viên hoặc nhà trường liên hệ triển khai và hỗ trợ kỹ thuật?',
    answer:
      'Vui lòng mở mục "Liên hệ" trên thanh điều hướng, điền đầy đủ họ tên, email, chủ đề và nội dung để gửi yêu cầu trực tiếp tới bộ phận quản trị qua email.',
  },
]

export function GuidePage({ onNavigate }: GuidePageProps) {
  const [activeTrack, setActiveTrack] = useState<'all' | 'student' | 'teacher'>('all')
  const [openFaqId, setOpenFaqId] = useState<string | null>('faq-1')

  return (
    <div className="space-y-8">
      {/* Header */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-2 max-w-2xl">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-[#2878B8]">
              <BookOpen className="h-4 w-4" />
              <span>Hướng dẫn sử dụng nền tảng TIN LAB</span>
            </div>
            <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-[#123B68] text-balance">
              Quy trình học tập và tổ chức thi trực tuyến Tin học 12
            </h1>
            <p className="text-sm sm:text-base leading-relaxed text-[#203247]">
              Hướng dẫn chi tiết dành cho học sinh khi tham gia luyện tập, làm bài thi và
              dành cho giáo viên trong việc tạo đề và quản lý kết quả.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-[#F3F6F9] border border-slate-200 p-1 self-start">
            <button
              type="button"
              onClick={() => setActiveTrack('all')}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                activeTrack === 'all'
                  ? 'bg-[#2878B8] text-white shadow-xs'
                  : 'text-[#65758B] hover:text-[#123B68]'
              }`}
            >
              Xem tất cả
            </button>
            <button
              type="button"
              onClick={() => setActiveTrack('student')}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                activeTrack === 'student'
                  ? 'bg-[#2878B8] text-white shadow-xs'
                  : 'text-[#65758B] hover:text-[#123B68]'
              }`}
            >
              Dành cho Học sinh
            </button>
            <button
              type="button"
              onClick={() => setActiveTrack('teacher')}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                activeTrack === 'teacher'
                  ? 'bg-[#2878B8] text-white shadow-xs'
                  : 'text-[#65758B] hover:text-[#123B68]'
              }`}
            >
              Dành cho Quản trị viên
            </button>
          </div>
        </div>
      </section>

      {/* Two guide tracks */}
      <div
        className={`grid grid-cols-1 gap-6 ${
          activeTrack === 'all' ? 'lg:grid-cols-2' : ''
        }`}
      >
        {(activeTrack === 'all' || activeTrack === 'student') && (
          <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#EAF3FA] text-[#2878B8] border border-[#2878B8]/20">
                  <GraduationCap className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold text-[#123B68]">
                    Hướng dẫn dành cho Học sinh
                  </h2>
                  <p className="text-xs text-[#65758B]">
                    Cách truy cập phòng luyện tập và làm bài thi
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('student')}
                className="text-xs font-semibold text-[#2878B8] hover:text-[#123B68] whitespace-nowrap shrink-0"
              >
                Vào thi ngay →
              </button>
            </div>

            <ol className="space-y-4">
              {STUDENT_STEPS.map((item) => (
                <li
                  key={item.step}
                  className="flex gap-4 border-b border-slate-100 pb-4 last:border-b-0 last:pb-0"
                >
                  <span className="font-mono text-sm font-bold text-[#2878B8] tabular-nums shrink-0 pt-0.5">
                    {item.step}
                  </span>
                  <div className="space-y-1">
                    <h3 className="text-sm font-bold text-[#123B68]">{item.title}</h3>
                    <p className="text-xs sm:text-sm leading-relaxed text-[#65758B]">
                      {item.description}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {(activeTrack === 'all' || activeTrack === 'teacher') && (
          <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#123B68] text-white">
                  <Users className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold text-[#123B68]">
                    Hướng dẫn dành cho Quản trị viên
                  </h2>
                  <p className="text-xs text-[#65758B]">
                    Cách đăng nhập bằng Google, tạo đề thi và quản lý kết quả
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('teacher')}
                className="text-xs font-semibold text-[#2878B8] hover:text-[#123B68] whitespace-nowrap shrink-0"
              >
                Đăng nhập quản trị →
              </button>
            </div>

            <ol className="space-y-4">
              {TEACHER_STEPS.map((item) => (
                <li
                  key={item.step}
                  className="flex gap-4 border-b border-slate-100 pb-4 last:border-b-0 last:pb-0"
                >
                  <span className="font-mono text-sm font-bold text-[#7954A1] tabular-nums shrink-0 pt-0.5">
                    {item.step}
                  </span>
                  <div className="space-y-1">
                    <h3 className="text-sm font-bold text-[#123B68]">{item.title}</h3>
                    <p className="text-xs sm:text-sm leading-relaxed text-[#65758B]">
                      {item.description}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      {/* Interactive FAQ Accordion */}
      <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2">
            <HelpCircle className="h-4 w-4 text-[#2878B8]" />
            <h2 className="font-display text-base font-bold text-[#123B68]">
              Câu hỏi thường gặp
            </h2>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('contact')}
            className="text-xs font-semibold text-[#2878B8] hover:text-[#123B68] whitespace-nowrap shrink-0"
          >
            Gửi câu hỏi khác →
          </button>
        </div>

        <div className="divide-y divide-slate-200">
          {FAQ_ITEMS.map((faq) => {
            const isOpen = openFaqId === faq.id
            return (
              <div key={faq.id}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpenFaqId(isOpen ? null : faq.id)}
                  className="flex w-full items-center justify-between gap-4 px-6 py-4 text-left hover:bg-[#F3F6F9] transition-colors"
                >
                  <span className="text-sm font-semibold text-[#123B68]">
                    {faq.question}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-[#65758B] transition-transform ${
                      isOpen ? 'rotate-180 text-[#2878B8]' : ''
                    }`}
                  />
                </button>
                {isOpen && (
                  <div className="px-6 pb-4 text-xs sm:text-sm leading-relaxed text-[#203247]">
                    {faq.answer}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
