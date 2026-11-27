import { lazy, Suspense, useEffect, useState } from 'react'
import { Header } from './components/Header'
import { ContactPage } from './pages/ContactPage'
import { GuidePage } from './pages/GuidePage'
import { HomePage } from './pages/HomePage'
import { StatisticsPage } from './pages/StatisticsPage'
import type { NavPage } from './types'

const StudentPage = lazy(() =>
  import('./pages/StudentPage').then((mod) => ({ default: mod.StudentPage }))
)
const TeacherPage = lazy(() =>
  import('./pages/TeacherPage').then((mod) => ({ default: mod.TeacherPage }))
)

const PUBLISHED_BASE_URL =
  'https://ais-pre-fra34bcjqzk4pbluowypxl-385969079523.asia-east1.run.app'

const PAGE_ROUTES: Record<
  NavPage,
  {
    path: string
    title: string
    description: string
    indexable: boolean
  }
> = {
  home: {
    path: '/',
    title: 'TIN LAB – Nền tảng học tập và thi trực tuyến môn Tin học 12',
    description:
      'TIN LAB là nền tảng học tập, ôn luyện chuyên đề và thi trực tuyến môn Tin học lớp 12 dành cho học sinh và giáo viên THPT.',
    indexable: true,
  },
  student: {
    path: '/hoc-sinh',
    title: 'Khu vực Học sinh – TIN LAB',
    description:
      'Không gian luyện tập và làm bài thi trực tuyến môn Tin học 12 dành cho học sinh.',
    indexable: false,
  },
  teacher: {
    path: '/giao-vien',
    title: 'Đăng nhập quản trị – TIN LAB',
    description:
      'Cổng đăng nhập quản trị (Super Admin) bằng Google OAuth và quản lý học liệu, đề thi, kết quả học sinh trên TIN LAB.',
    indexable: false,
  },
  stats: {
    path: '/thong-ke',
    title: 'Thống kê dữ liệu thực tế – TIN LAB',
    description:
      'Tổng quan số liệu thực tế về tài liệu, ngân hàng câu hỏi, đề thi xuất bản và kết quả học sinh môn Tin học 12 trên TIN LAB.',
    indexable: true,
  },
  guide: {
    path: '/huong-dan',
    title: 'Hướng dẫn sử dụng – TIN LAB',
    description:
      'Hướng dẫn chi tiết dành cho học sinh tham gia làm bài thi và giáo viên quản lý học liệu, đề thi trên TIN LAB.',
    indexable: true,
  },
  contact: {
    path: '/lien-he',
    title: 'Liên hệ hỗ trợ – TIN LAB',
    description:
      'Gửi yêu cầu hỗ trợ kỹ thuật, góp ý học liệu hoặc liên hệ triển khai nền tảng TIN LAB môn Tin học 12.',
    indexable: true,
  },
}

function resolvePageFromPathname(pathname: string): NavPage {
  const normalized = pathname.replace(/\/+$/, '') || '/'
  const entry = (Object.entries(PAGE_ROUTES) as [NavPage, (typeof PAGE_ROUTES)[NavPage]][]).find(
    ([, meta]) => meta.path === normalized
  )
  return entry ? entry[0] : 'home'
}

export default function App() {
  const [activePage, setActivePage] = useState<NavPage>(() =>
    resolvePageFromPathname(window.location.pathname)
  )
  const [selectedRole, setSelectedRole] = useState<'student' | 'teacher' | null>(null)

  useEffect(() => {
    const onPopState = () => {
      setActivePage(resolvePageFromPathname(window.location.pathname))
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    const meta = PAGE_ROUTES[activePage]
    document.title = meta.title

    const descEl = document.querySelector('meta[name="description"]')
    if (descEl) {
      descEl.setAttribute('content', meta.description)
    }

    const robotsEl = document.querySelector('meta[name="robots"]')
    if (robotsEl) {
      robotsEl.setAttribute(
        'content',
        meta.indexable ? 'index, follow' : 'noindex, nofollow'
      )
    }

    const canonicalEl = document.querySelector('link[rel="canonical"]')
    if (canonicalEl) {
      canonicalEl.setAttribute('href', `${PUBLISHED_BASE_URL}${meta.path}`)
    }
  }, [activePage])

  const handleNavigate = (page: NavPage) => {
    const targetPath = PAGE_ROUTES[page].path
    if (window.location.pathname !== targetPath) {
      window.history.pushState({ page }, '', targetPath)
    }
    setActivePage(page)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const renderPage = () => {
    switch (activePage) {
      case 'home':
        return (
          <HomePage
            onNavigate={handleNavigate}
            selectedRole={selectedRole}
            onSelectRole={setSelectedRole}
          />
        )
      case 'student':
        return (
          <Suspense
            fallback={
              <div className="rounded-xl border border-slate-200 bg-white p-8 text-sm text-[#65758B]">
                Đang tải khu vực Học sinh...
              </div>
            }
          >
            <StudentPage onNavigate={handleNavigate} />
          </Suspense>
        )
      case 'teacher':
        return (
          <Suspense
            fallback={
              <div className="rounded-xl border border-slate-200 bg-white p-8 text-sm text-[#65758B]">
                Đang tải khu vực Quản trị...
              </div>
            }
          >
            <TeacherPage onNavigate={handleNavigate} />
          </Suspense>
        )
      case 'stats':
        return <StatisticsPage onNavigate={handleNavigate} />
      case 'guide':
        return <GuidePage onNavigate={handleNavigate} />
      case 'contact':
        return <ContactPage onNavigate={handleNavigate} />
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#F3F6FA] text-[#203247]">
      <Header
        activePage={activePage}
        selectedRole={selectedRole}
        onSelectRole={setSelectedRole}
        onNavigate={handleNavigate}
      />

      <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {renderPage()}
      </main>

      <footer className="border-t border-slate-200/90 bg-white">
        <div className="mx-auto flex max-w-[1320px] flex-col sm:flex-row items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8 text-xs text-[#65758B]">
          <div>
            © 2026 TIN LAB – Nền tảng học tập và thi trực tuyến môn Tin học 12
          </div>
          <div className="flex items-center gap-5">
            <button
              type="button"
              onClick={() => handleNavigate('guide')}
              className="font-medium text-[#2878B8] hover:text-[#123B68] transition-colors whitespace-nowrap"
            >
              Hướng dẫn sử dụng
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('contact')}
              className="font-medium text-[#2878B8] hover:text-[#123B68] transition-colors whitespace-nowrap"
            >
              Liên hệ
            </button>
          </div>
        </div>
      </footer>
    </div>
  )
}
