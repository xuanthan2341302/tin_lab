import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  userMessage: string
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    userMessage: '',
  }

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let message =
      'Đã xảy ra sự cố không mong muốn khi hiển thị giao diện hoặc kết nối dữ liệu.'

    if (error.message.includes('Missing or insufficient permissions') || error.message.includes('"operationType"')) {
      message =
        'Tài khoản hiện tại không đủ quyền truy cập hoặc xác thực email chưa hoàn tất cho thao tác cơ sở dữ liệu này.'
    } else if (error.message.includes('the client is offline')) {
      message =
        'Không thể kết nối tới cơ sở dữ liệu Firestore. Vui lòng kiểm tra kết nối mạng và thử lại.'
    }

    return {
      hasError: true,
      userMessage: message,
    }
  }

  public componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('TIN LAB ErrorBoundary caught error:', error.message, info.componentStack)
  }

  private handleReset = () => {
    this.setState({ hasError: false, userMessage: '' })
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#F3F6FA] flex items-center justify-center p-4">
          <div className="max-w-lg w-full rounded-xl border border-[#D94B45]/30 bg-white p-6 sm:p-8 shadow-sm space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#FDF1F0] text-[#D94B45]">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <h1 className="font-display text-lg font-bold text-[#123B68]">
                  Không thể hoàn tất thao tác
                </h1>
                <p className="text-sm leading-relaxed text-[#203247]">
                  {this.state.userMessage}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                onClick={this.handleReset}
                className="inline-flex items-center gap-2 rounded-lg bg-[#2878B8] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#123B68] transition-colors"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Thử lại</span>
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-[#123B68] hover:bg-[#F3F6F9] transition-colors"
              >
                <span>Tải lại trang</span>
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
