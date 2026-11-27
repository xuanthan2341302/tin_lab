interface LogoProps {
  variant?: 'dark' | 'light'
}

export function Logo({ variant = 'dark' }: LogoProps) {
  const isDarkSurface = variant === 'dark'

  return (
    <div className="flex items-center gap-3 min-w-0">
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
          isDarkSurface
            ? 'border-white/20 bg-white/10 text-white'
            : 'border-[#2878B8]/25 bg-[#F3F6F9] text-[#123B68]'
        }`}
        aria-hidden="true"
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect
            x="3"
            y="4"
            width="18"
            height="14"
            rx="2.5"
            stroke="currentColor"
            strokeWidth="1.9"
          />
          <path
            d="M8.5 9.5L11 11.5L8.5 13.5"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12.5 13.5H15.5"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
          <path
            d="M9 20.5H15"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div className="min-w-0">
        <div
          className={`font-display text-base font-extrabold tracking-tight whitespace-nowrap ${
            isDarkSurface ? 'text-white' : 'text-[#123B68]'
          }`}
        >
          TIN LAB
        </div>
        <div
          className={`text-[11px] font-medium truncate ${
            isDarkSurface ? 'text-slate-200/85' : 'text-[#65758B]'
          }`}
        >
          Tin học 12 · THPT
        </div>
      </div>
    </div>
  )
}
