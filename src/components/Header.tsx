import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  BarChart3,
  Bell,
  BookOpen,
  GraduationCap,
  Home,
  LogIn,
  Mail,
  Menu,
  Search,
  Users,
  X,
} from 'lucide-react'
import type { NavPage } from '../types'
import { Logo } from './Logo'

export interface NavItemConfig {
  id: NavPage
  label: string
  icon: typeof Home
}

export const NAV_ITEMS: NavItemConfig[] = [
  { id: 'home', label: 'Trang chủ', icon: Home },
  { id: 'student', label: 'Học sinh', icon: GraduationCap },
  { id: 'teacher', label: 'Quản trị', icon: Users },
  { id: 'stats', label: 'Thống kê', icon: BarChart3 },
  { id: 'guide', label: 'Hướng dẫn sử dụng', icon: BookOpen },
  { id: 'contact', label: 'Liên hệ', icon: Mail },
]

interface SearchSuggestion {
  id: string
  title: string
  subtitle: string
  targetPage: NavPage
}

const STATIC_SEARCH_ENTRIES: SearchSuggestion[] = [
  {
    id: 'nav-home',
    title: 'Trang chủ TIN LAB',
    subtitle: 'Tổng quan nền tảng học tập Tin học 12',
    targetPage: 'home',
  },
  {
    id: 'nav-student',
    title: 'Khu vực Học sinh & Làm bài thi',
    subtitle: 'Luyện tập trắc nghiệm, thi thử trực tuyến',
    targetPage: 'student',
  },
  {
    id: 'nav-teacher',
    title: 'Đăng nhập quản trị (Super Admin)',
    subtitle: 'Quản lý kết quả học sinh, học liệu, ngân hàng câu hỏi và đề thi',
    targetPage: 'teacher',
  },
  {
    id: 'nav-stats',
    title: 'Thống kê dữ liệu thực tế',
    subtitle: 'Số liệu ngân hàng câu hỏi, đề thi và kết quả học sinh từ hệ thống',
    targetPage: 'stats',
  },
  {
    id: 'nav-guide',
    title: 'Hướng dẫn sử dụng TIN LAB',
    subtitle: 'Quy trình dành cho học sinh và giáo viên',
    targetPage: 'guide',
  },
  {
    id: 'nav-contact',
    title: 'Liên hệ & Gửi phản hồi',
    subtitle: 'Hỗ trợ kỹ thuật và góp ý qua biểu mẫu',
    targetPage: 'contact',
  },
]

const SYSTEM_NOTICES: { id: string; title: string; detail: string; page: NavPage }[] = [
  {
    id: 'n1',
    title: 'Cổng thi trực tuyến học sinh Tin học 12',
    detail: 'Học sinh vào làm đề thi đã xuất bản chỉ cần nhập Họ tên và Lớp.',
    page: 'student',
  },
  {
    id: 'n2',
    title: 'Thống kê dữ liệu thực tế',
    detail: 'Các chỉ số tại Trang chủ và Thống kê được tổng hợp trực tiếp từ cơ sở dữ liệu.',
    page: 'stats',
  },
  {
    id: 'n3',
    title: 'Cổng liên hệ hỗ trợ giáo viên & học sinh',
    detail: 'Gửi góp ý học liệu hoặc yêu cầu kỹ thuật trực tiếp.',
    page: 'contact',
  },
]

interface HeaderProps {
  activePage: NavPage
  selectedRole: 'student' | 'teacher' | null
  onSelectRole: (role: 'student' | 'teacher') => void
  onNavigate: (page: NavPage) => void
}

export function Header({
  activePage,
  selectedRole,
  onSelectRole,
  onNavigate,
}: HeaderProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)

  const searchContainerRef = useRef<HTMLDivElement>(null)
  const headerActionsRef = useRef<HTMLDivElement>(null)

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return []
    return STATIC_SEARCH_ENTRIES.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q)
    ).slice(0, 6)
  }, [searchQuery])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileMenuOpen(false)
        setSearchOpen(false)
        setNotifOpen(false)
        setProfileOpen(false)
      }
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (searchContainerRef.current && !searchContainerRef.current.contains(target)) {
        setSearchOpen(false)
      }
      if (headerActionsRef.current && !headerActionsRef.current.contains(target)) {
        setNotifOpen(false)
        setProfileOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mousedown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onPointerDown)
    }
  }, [])

  const navigateAndClose = (page: NavPage) => {
    setMobileMenuOpen(false)
    setSearchOpen(false)
    setNotifOpen(false)
    setProfileOpen(false)
    onNavigate(page)
  }

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (searchResults.length > 0) {
      navigateAndClose(searchResults[0].targetPage)
      setSearchQuery('')
    }
  }

  return (
    <header className="sticky top-0 z-30 w-full shadow-xs">
      {/* HEADER ROW 1: White full-width bar — TIN LAB logo left; search, notifications, login/profile right */}
      <div className="w-full border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-[1320px] items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => navigateAndClose('home')}
            className="rounded-lg text-left shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B5BDB]"
          >
            <Logo variant="light" />
          </button>

          <div className="flex items-center gap-2.5 sm:gap-3">
            {/* Desktop/Tablet Search */}
            <div
              ref={searchContainerRef}
              className="relative hidden md:block w-64 lg:w-80"
            >
              <form onSubmit={handleSearchSubmit} role="search">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#65758B]" />
                <input
                  type="search"
                  value={searchQuery}
                  onFocus={() => setSearchOpen(true)}
                  onChange={(e) => {
                    setSearchQuery(e.target.value)
                    setSearchOpen(true)
                  }}
                  placeholder="Tìm khu vực, chức năng TIN LAB..."
                  aria-label="Tìm kiếm nội dung TIN LAB"
                  className="w-full rounded-lg border border-slate-200 bg-[#F3F6FA] py-2 pl-9 pr-3 text-sm text-[#203247] placeholder:text-[#65758B] focus:border-[#2878B8] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#2878B8]/15"
                />
              </form>

              {searchOpen && searchQuery.trim().length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1.5 rounded-xl border border-slate-200 bg-white shadow-lg overflow-hidden z-40">
                  {searchResults.length === 0 ? (
                    <div className="px-4 py-3 text-xs text-[#65758B]">
                      Không tìm thấy mục phù hợp với “{searchQuery.trim()}”.
                    </div>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {searchResults.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => {
                              navigateAndClose(item.targetPage)
                              setSearchQuery('')
                            }}
                            className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-[#F3F6FA] transition-colors"
                          >
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-[#123B68] truncate">
                                {item.title}
                              </div>
                              <div className="text-[11px] text-[#65758B] truncate">
                                {item.subtitle}
                              </div>
                            </div>
                            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[#2878B8]" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/* Notification Bell + Teacher Login/Profile + Mobile Hamburger */}
            <div ref={headerActionsRef} className="relative flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setNotifOpen((prev) => !prev)
                  setProfileOpen(false)
                }}
                aria-label="Thông báo hệ thống"
                aria-expanded={notifOpen}
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-[#203247] hover:bg-[#F3F6FA] hover:text-[#2878B8] transition-colors focus-visible:outline-2 focus-visible:outline-[#2878B8]"
              >
                <Bell className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => {
                  setProfileOpen((prev) => !prev)
                  setNotifOpen(false)
                }}
                aria-label="Đăng nhập quản trị và truy cập nhanh"
                aria-expanded={profileOpen}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 sm:px-3 py-1.5 min-h-[40px] text-xs sm:text-sm font-semibold text-[#123B68] hover:border-[#2878B8] hover:text-[#2878B8] hover:bg-[#F3F6FA] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-[#2878B8]"
              >
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#123B68] text-[10px] font-bold text-white">
                  {selectedRole === 'teacher'
                    ? 'SA'
                    : selectedRole === 'student'
                    ? 'HS'
                    : 'TL'}
                </span>
                <span className="hidden sm:inline">Đăng nhập quản trị</span>
              </button>

              {/* Mobile Hamburger Menu Button */}
              <button
                type="button"
                onClick={() => setMobileMenuOpen((prev) => !prev)}
                aria-label={mobileMenuOpen ? 'Đóng menu điều hướng' : 'Mở menu điều hướng'}
                aria-expanded={mobileMenuOpen}
                className="md:hidden inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-[#123B68] hover:bg-[#F3F6FA] transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-[#2878B8]"
              >
                {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </button>

              {notifOpen && (
                <div className="absolute right-0 top-full mt-2 w-80 max-w-[90vw] rounded-xl border border-slate-200 bg-white shadow-lg overflow-hidden z-40">
                  <div className="border-b border-slate-200 px-4 py-3 text-xs font-bold text-[#123B68]">
                    Thông tin hệ thống
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {SYSTEM_NOTICES.map((notice) => (
                      <li key={notice.id}>
                        <button
                          type="button"
                          onClick={() => navigateAndClose(notice.page)}
                          className="block w-full px-4 py-3 text-left hover:bg-[#F3F6FA] transition-colors"
                        >
                          <div className="text-xs font-semibold text-[#123B68]">
                            {notice.title}
                          </div>
                          <div className="mt-0.5 text-[11px] text-[#65758B] leading-snug">
                            {notice.detail}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {profileOpen && (
                <div className="absolute right-0 top-full mt-2 w-64 rounded-xl border border-slate-200 bg-white shadow-lg overflow-hidden z-40">
                  <div className="border-b border-slate-200 px-4 py-3">
                    <div className="text-xs font-bold text-[#123B68]">
                      Truy cập khu vực
                    </div>
                    <div className="text-[11px] text-[#65758B] mt-0.5">
                      {selectedRole === 'teacher'
                        ? 'Khu vực Super Admin'
                        : selectedRole === 'student'
                        ? 'Học sinh (Không cần đăng nhập)'
                        : 'Chọn cổng truy cập'}
                    </div>
                  </div>
                  <div className="p-1.5 space-y-1">
                    <button
                      type="button"
                      onClick={() => {
                        onSelectRole('teacher')
                        navigateAndClose('teacher')
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold text-[#123B68] hover:bg-[#EAF2FF] hover:text-[#2859C5]"
                    >
                      <span className="inline-flex items-center gap-2">
                        <LogIn className="h-3.5 w-3.5 text-[#2878B8]" />
                        <span>Đăng nhập quản trị</span>
                      </span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectRole('student')
                        navigateAndClose('student')
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium text-[#203247] hover:bg-[#EAF2FF] hover:text-[#2859C5]"
                    >
                      <span>Vào khu vực Học sinh</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => navigateAndClose('guide')}
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium text-[#203247] hover:bg-[#EAF2FF] hover:text-[#2859C5]"
                    >
                      <span>Hướng dẫn sử dụng</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* HEADER ROW 2: Full-width horizontal navigation bar on desktop & tablet (one single row) */}
      <nav
        aria-label="Điều hướng chính"
        className="hidden md:block w-full bg-[#123B68] text-white border-b border-[#0E2F54]"
      >
        <div className="mx-auto w-full max-w-[1320px] px-4 sm:px-6 lg:px-8">
          <ul className="flex flex-row items-center justify-between flex-nowrap w-full py-1.5 gap-2">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon
              const isActive = activePage === item.id

              return (
                <li key={item.id} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => navigateAndClose(item.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`inline-flex items-center gap-2 rounded-md px-3 lg:px-5 py-2 text-xs lg:text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                      isActive
                        ? 'bg-[#2878B8] text-white font-semibold shadow-xs'
                        : 'text-slate-100/90 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </nav>

      {/* Mobile horizontal-header dropdown drawer (no vertical sidebar) */}
      {mobileMenuOpen && (
        <nav
          aria-label="Menu điều hướng di động"
          className="md:hidden w-full border-b border-[#0E2F54] bg-[#123B68] text-white shadow-lg"
        >
          <div className="px-4 pt-3 pb-2">
            <form onSubmit={handleSearchSubmit} role="search" className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Tìm khu vực, chức năng TIN LAB..."
                aria-label="Tìm kiếm nội dung TIN LAB"
                className="w-full rounded-lg border border-white/20 bg-white/10 py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-300 focus:border-white/50 focus:outline-none"
              />
            </form>
          </div>

          <ul className="px-4 pb-3 space-y-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon
              const isActive = activePage === item.id

              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => navigateAndClose(item.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 min-h-[44px] text-sm font-medium transition-colors text-left ${
                      isActive
                        ? 'bg-[#2878B8] text-white font-semibold'
                        : 'text-slate-100 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
      )}
    </header>
  )
}
