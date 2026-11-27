import fs from 'node:fs'
import path from 'node:path'
import { GoogleGenAI } from '@google/genai'

export const GEMINI_MODEL = 'gemini-4-hydrogen'
export const GEMINI_API_ENDPOINT =
  'Gemini Developer API (generativelanguage.googleapis.com via @google/genai)'
export const GEMINI_CONFIG_SOURCE = 'process.env.GEMINI_API_KEY (Server Runtime)'

export type GeminiConnectionState =
  | 'connected'
  | 'not_configured'
  | 'invalid_key'
  | 'permission_denied'
  | 'quota_exceeded'
  | 'error'

export interface GeminiSafeDiagnostics {
  exists: boolean
  keyLength: number
  startsWithAIza: boolean
  detectedKeyType: string
  configSource: string
  apiEndpoint: string
  hadFormattingArtifacts: boolean
  overrideCheck: {
    hasLocalDotEnv: boolean
    hasGoogleApiKeyVar: boolean
    hasVertexAiFlag: boolean
    runtimeEnv: string
  }
}

export interface GeminiConnectionInfo {
  state: GeminiConnectionState
  connected: boolean
  configured: boolean
  model: string
  checkedAt: string
  message: string
  setupGuide: string
  errorCode?: string
  diagnostics?: GeminiSafeDiagnostics
}

const SETUP_GUIDE_VI =
  'Mở Settings > Secrets trên thanh điều khiển dự án để cập nhật GEMINI_API_KEY bằng khóa API hợp lệ từ Google AI Studio (bắt đầu bằng AIza..., dài khoảng 39 ký tự, không bọc dấu ngoặc kép hoặc khoảng trắng). Nếu ứng dụng đã xuất bản (Published), hãy bấm Republish / Deploy lại sau khi cập nhật Secret để phiên bản Published nhận cấu hình mới.'

const CACHE_TTL_MS = 45_000
let cachedStatus: { checkedAtMs: number; info: GeminiConnectionInfo } | null = null

function buildOverrideCheck() {
  const hasLocalDotEnv =
    fs.existsSync(path.resolve(process.cwd(), '.env')) ||
    fs.existsSync(path.resolve(process.cwd(), '.env.local'))
  return {
    hasLocalDotEnv,
    hasGoogleApiKeyVar: Boolean(process.env.GOOGLE_API_KEY?.trim()),
    hasVertexAiFlag: Boolean(process.env.GOOGLE_GENAI_USE_VERTEXAI?.trim()),
    runtimeEnv: process.env.NODE_ENV || 'development',
  }
}

function detectKeyType(
  collapsed: string,
  issue: 'missing' | 'placeholder' | 'aistudio_default_placeholder' | null
): string {
  if (issue === 'missing' || !collapsed) return 'Chưa thiết lập (Trống)'
  if (issue === 'aistudio_default_placeholder') {
    return 'Giá trị giữ chỗ mặc định của AI Studio (17 ký tự — Secret thật chưa được áp dụng vào Server Runtime)'
  }
  if (issue === 'placeholder') return 'Giá trị mẫu (Placeholder)'
  if (collapsed.startsWith('AIza')) {
    if (collapsed.length >= 35 && collapsed.length <= 45) {
      return 'Google AI Studio / Gemini API Key (định dạng chuẩn AIza...)'
    }
    return 'Khóa tiền tố AIza nhưng độ dài bất thường (có thể bị thiếu hoặc thừa ký tự)'
  }
  if (/^AQ\./.test(collapsed)) {
    return 'Google AI Studio / Gemini API Key (khóa dịch vụ AI Studio định dạng AQ...)'
  }
  if (/^ya29\./.test(collapsed)) {
    return 'OAuth Access Token (không phải Gemini API Key)'
  }
  return 'Định dạng không xác định (không bắt đầu bằng AIza... hoặc AQ...)'
}

export function sanitizeGeminiApiKey(raw = process.env.GEMINI_API_KEY): {
  apiKey: string | null
  issue: 'missing' | 'placeholder' | 'aistudio_default_placeholder' | null
  diagnostics: GeminiSafeDiagnostics
} {
  const overrideCheck = buildOverrideCheck()

  if (!raw) {
    return {
      apiKey: null,
      issue: 'missing',
      diagnostics: {
        exists: false,
        keyLength: 0,
        startsWithAIza: false,
        detectedKeyType: detectKeyType('', 'missing'),
        configSource: GEMINI_CONFIG_SOURCE,
        apiEndpoint: GEMINI_API_ENDPOINT,
        hadFormattingArtifacts: false,
        overrideCheck,
      },
    }
  }

  let cleaned = raw.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
  if (/^(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|API_KEY)\s*=\s*/i.test(cleaned)) {
    cleaned = cleaned
      .replace(/^(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|API_KEY)\s*=\s*/i, '')
      .trim()
  }
  // Strip accidental surrounding quotes from .env or secret paste
  while (
    (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length >= 2) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'") && cleaned.length >= 2)
  ) {
    cleaned = cleaned.slice(1, -1).trim()
  }
  // Strip any accidental whitespace / newlines inside a pasted key
  const collapsed = cleaned.replace(/\s+/g, '')
  const hadFormattingArtifacts = collapsed !== raw

  if (!collapsed) {
    return {
      apiKey: null,
      issue: 'missing',
      diagnostics: {
        exists: false,
        keyLength: 0,
        startsWithAIza: false,
        detectedKeyType: detectKeyType('', 'missing'),
        configSource: GEMINI_CONFIG_SOURCE,
        apiEndpoint: GEMINI_API_ENDPOINT,
        hadFormattingArtifacts,
        overrideCheck,
      },
    }
  }

  const lower = collapsed.toLowerCase()
  const isAiStudioDefaultPlaceholder = lower === 'my_gemini_api_key'
  const isPlaceholder =
    isAiStudioDefaultPlaceholder ||
    collapsed.length < 12 ||
    lower.includes('your_api_key') ||
    lower.includes('your-gemini') ||
    lower.includes('replace_me') ||
    lower.includes('placeholder') ||
    /^<[^>]+>$/.test(collapsed)

  const issue: 'missing' | 'placeholder' | 'aistudio_default_placeholder' | null =
    isAiStudioDefaultPlaceholder
      ? 'aistudio_default_placeholder'
      : isPlaceholder
      ? 'placeholder'
      : null

  const diagnostics: GeminiSafeDiagnostics = {
    exists: true,
    keyLength: collapsed.length,
    startsWithAIza: collapsed.startsWith('AIza'),
    detectedKeyType: detectKeyType(collapsed, issue),
    configSource: GEMINI_CONFIG_SOURCE,
    apiEndpoint: GEMINI_API_ENDPOINT,
    hadFormattingArtifacts,
    overrideCheck,
  }

  if (issue) {
    return { apiKey: null, issue, diagnostics }
  }

  return { apiKey: collapsed, issue: null, diagnostics }
}

export function isGeminiAiConfigured(): boolean {
  return sanitizeGeminiApiKey().apiKey !== null
}

export function getGeminiClient(): GoogleGenAI | null {
  const { apiKey } = sanitizeGeminiApiKey()
  if (!apiKey) return null
  return new GoogleGenAI({
    apiKey,
    vertexai: false,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  })
}

export function classifyGeminiApiError(err: unknown): {
  state: Exclude<GeminiConnectionState, 'connected'>
  errorCode: string
  httpStatus: number
  userMessage: string
  setupGuide: string
} {
  const rawMessage = err instanceof Error ? err.message : String(err ?? '')
  const upper = rawMessage.toUpperCase()

  if (
    upper.includes('API_KEY_INVALID') ||
    upper.includes('API KEY NOT VALID') ||
    (upper.includes('INVALID_ARGUMENT') && upper.includes('API KEY'))
  ) {
    return {
      state: 'invalid_key',
      errorCode: 'API_KEY_INVALID',
      httpStatus: 400,
      userMessage:
        'Khóa GEMINI_API_KEY hiện tại trên máy chủ bị Gemini Developer API từ chối (400 INVALID_ARGUMENT – API_KEY_INVALID). Hệ thống giữ nguyên kết quả phân tích cấu trúc nội bộ và không tự tạo kết quả AI giả.',
      setupGuide: SETUP_GUIDE_VI,
    }
  }

  if (
    upper.includes('PERMISSION_DENIED') ||
    upper.includes('403') ||
    upper.includes('API_KEY_SERVICE_BLOCKED') ||
    upper.includes('BILLING')
  ) {
    return {
      state: 'permission_denied',
      errorCode: 'PERMISSION_DENIED',
      httpStatus: 403,
      userMessage:
        'Khóa GEMINI_API_KEY bị từ chối quyền truy cập Generative Language API (403 PERMISSION_DENIED). Vui lòng kiểm tra quyền API trên Google Cloud / AI Studio.',
      setupGuide: SETUP_GUIDE_VI,
    }
  }

  if (
    upper.includes('RESOURCE_EXHAUSTED') ||
    upper.includes('429') ||
    upper.includes('QUOTA') ||
    upper.includes('RATE_LIMIT')
  ) {
    return {
      state: 'quota_exceeded',
      errorCode: 'QUOTA_EXCEEDED',
      httpStatus: 429,
      userMessage:
        'Gemini API tạm thời vượt giới hạn lượt gọi / hạn mức (429 RESOURCE_EXHAUSTED). Hệ thống vẫn giữ kết quả tách cấu trúc; bạn có thể thử chạy lại bước AI sau ít phút.',
      setupGuide: SETUP_GUIDE_VI,
    }
  }

  if (
    upper.includes('UNAVAILABLE') ||
    upper.includes('503') ||
    upper.includes('HIGH DEMAND') ||
    upper.includes('OVERLOADED')
  ) {
    return {
      state: 'error',
      errorCode: 'MODEL_TEMPORARILY_OVERLOADED',
      httpStatus: 503,
      userMessage:
        'Khóa GEMINI_API_KEY đã được xác thực hợp lệ, nhưng model Gemini đang tạm thời quá tải (503 UNAVAILABLE). Vui lòng thử bấm "Kiểm tra kết nối" lại sau vài giây.',
      setupGuide: '',
    }
  }

  if (upper.includes('AI_NOT_CONFIGURED')) {
    return {
      state: 'not_configured',
      errorCode: 'AI_NOT_CONFIGURED',
      httpStatus: 503,
      userMessage:
        'Máy chủ chưa cấu hình khóa GEMINI_API_KEY hợp lệ nên tính năng AI ngữ nghĩa đang ở trạng thái Chưa kết nối.',
      setupGuide: SETUP_GUIDE_VI,
    }
  }

  // Redact any accidental key-like token from error string before returning
  const safeSnippet = rawMessage
    .replace(/AIza[0-9A-Za-z\-_]{12,}/g, '[REDACTED_KEY]')
    .replace(/key=[^&\s"']+/gi, 'key=[REDACTED]')
    .slice(0, 240)

  return {
    state: 'error',
    errorCode: 'GEMINI_API_ERROR',
    httpStatus: 502,
    userMessage: `Không thể kết nối Gemini API (${safeSnippet || 'Lỗi máy chủ AI'}).`,
    setupGuide: SETUP_GUIDE_VI,
  }
}

export function getCachedGeminiConnectionInfo(): GeminiConnectionInfo | null {
  if (!cachedStatus) return null
  return cachedStatus.info
}

export async function verifyGeminiApiConnection(
  forceRefresh = false
): Promise<GeminiConnectionInfo> {
  const now = Date.now()
  if (!forceRefresh && cachedStatus && now - cachedStatus.checkedAtMs < CACHE_TTL_MS) {
    return cachedStatus.info
  }

  const sanitized = sanitizeGeminiApiKey()
  if (!sanitized.apiKey) {
    const isAiStudioDefault = sanitized.issue === 'aistudio_default_placeholder'
    const info: GeminiConnectionInfo = {
      state: 'not_configured',
      connected: false,
      configured: false,
      model: GEMINI_MODEL,
      checkedAt: new Date(now).toISOString(),
      errorCode: isAiStudioDefault
        ? 'AI_STUDIO_DEFAULT_PLACEHOLDER'
        : sanitized.issue === 'placeholder'
        ? 'INVALID_PLACEHOLDER_KEY'
        : 'AI_NOT_CONFIGURED',
      message: isAiStudioDefault
        ? 'Server Runtime hiện đang nhận giá trị giữ chỗ mặc định 17 ký tự của AI Studio thay vì khóa API thật (khóa Gemini chuẩn dài 39 ký tự và bắt đầu bằng AIza...). Secret thật chưa được áp dụng vào tiến trình backend hiện tại.'
        : sanitized.issue === 'placeholder'
        ? 'Biến GEMINI_API_KEY đang chứa giá trị mẫu (placeholder), chưa phải khóa API thật.'
        : 'Chưa cấu hình GEMINI_API_KEY trên máy chủ (trạng thái: Chưa kết nối).',
      setupGuide: SETUP_GUIDE_VI,
      diagnostics: sanitized.diagnostics,
    }
    cachedStatus = { checkedAtMs: now, info }
    return info
  }

  const ai = new GoogleGenAI({
    apiKey: sanitized.apiKey,
    vertexai: false,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  })

  try {
    const runProbe = async () => {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Gemini connectivity probe timed out after 12s')), 12_000)
      })
      return Promise.race([
        ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: 'OK',
        }),
        timeoutPromise,
      ])
    }

    try {
      await runProbe()
    } catch (firstErr) {
      const firstMsg = (firstErr instanceof Error ? firstErr.message : String(firstErr ?? '')).toUpperCase()
      if (firstMsg.includes('503') || firstMsg.includes('UNAVAILABLE') || firstMsg.includes('HIGH DEMAND')) {
        await new Promise((r) => setTimeout(r, 1500))
        await runProbe()
      } else {
        throw firstErr
      }
    }

    const info: GeminiConnectionInfo = {
      state: 'connected',
      connected: true,
      configured: true,
      model: GEMINI_MODEL,
      checkedAt: new Date(now).toISOString(),
      message: `Đã kết nối Gemini Developer API thành công (model ${GEMINI_MODEL}).`,
      setupGuide: '',
      diagnostics: sanitized.diagnostics,
    }
    cachedStatus = { checkedAtMs: now, info }
    return info
  } catch (err) {
    const classified = classifyGeminiApiError(err)
    console.warn(
      `[TIN LAB] Gemini connectivity verification failed: ${classified.errorCode} (keyLength=${sanitized.diagnostics.keyLength}, startsWithAIza=${sanitized.diagnostics.startsWithAIza})`
    )
    const info: GeminiConnectionInfo = {
      state: classified.state,
      connected: false,
      configured: true,
      model: GEMINI_MODEL,
      checkedAt: new Date(now).toISOString(),
      errorCode: classified.errorCode,
      message: classified.userMessage,
      setupGuide: classified.setupGuide,
      diagnostics: sanitized.diagnostics,
    }
    cachedStatus = { checkedAtMs: now, info }
    return info
  }
}

export function updateCachedGeminiStatusFromError(err: unknown): void {
  const classified = classifyGeminiApiError(err)
  const sanitized = sanitizeGeminiApiKey()
  cachedStatus = {
    checkedAtMs: Date.now(),
    info: {
      state: classified.state,
      connected: false,
      configured: classified.state !== 'not_configured',
      model: GEMINI_MODEL,
      checkedAt: new Date().toISOString(),
      errorCode: classified.errorCode,
      message: classified.userMessage,
      setupGuide: classified.setupGuide,
      diagnostics: sanitized.diagnostics,
    },
  }
}
