import type { Part2ScoringMode, QuestionType } from '../src/types.ts'
import type { WorkerEnv } from './env.ts'

export interface SealedExamItem {
  id: string
  part: 1 | 2 | 3
  questionType: QuestionType
  points: number
  questionText: string
  answerKey?: 'A' | 'B' | 'C' | 'D'
  statementAnswerA?: boolean
  statementAnswerB?: boolean
  statementAnswerC?: boolean
  statementAnswerD?: boolean
  rubric?: string
  sampleAnswer?: string
  explanation?: string
}

export interface SealedExamPayload {
  v: 1
  examId: string
  part2ScoringMode: Part2ScoringMode
  totalPoints: number
  items: SealedExamItem[]
}

const SEAL_PREFIX = 'tinlab.seal.v1'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (padded.length % 4)) % 4
  const binary = atob(padded + '='.repeat(padLen))
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

function resolveSealingKeyMaterial(env: WorkerEnv): { source: 'explicit' | 'database'; value: string } | null {
  const explicit = env.EXAM_SEALING_SECRET?.trim() ?? ''
  if (explicit.length >= 16) return { source: 'explicit', value: explicit }

  // The Neon connection string is already a high-entropy Cloudflare Worker Secret.
  // Use it as a domain-separated fallback so the first exam can be published without
  // requiring a second manual secret. Keep the database credential stable while exams
  // sealed with this fallback remain in use. EXAM_SEALING_SECRET, when configured,
  // always takes precedence.
  const databaseUrl = env.DATABASE_URL?.trim() ?? ''
  if (databaseUrl.length >= 32) return { source: 'database', value: databaseUrl }
  return null
}

export function isExamSealingSecretConfigured(env: WorkerEnv): boolean {
  return resolveSealingKeyMaterial(env) !== null
}

/**
 * Derives an AES-256-GCM CryptoKey using a domain-separated secret.
 * An explicit EXAM_SEALING_SECRET takes precedence. When it is absent, the
 * high-entropy DATABASE_URL Worker Secret is used as a stable fallback.
 */
async function importSealingAesKey(env: WorkerEnv): Promise<CryptoKey> {
  const resolved = resolveSealingKeyMaterial(env)
  if (!resolved) {
    throw new Error(
      'Máy chủ Worker cần DATABASE_URL hoặc EXAM_SEALING_SECRET để niêm phong đáp án đề thi.'
    )
  }

  const keyMaterial = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(
      resolved.source === 'explicit'
        ? `tinlab-configured:${resolved.value}`
        : `tinlab-database-sealing-v1:${resolved.value}`
    )
  )

  return crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function sealExamGradingPayloadWorker(
  payload: SealedExamPayload,
  env: WorkerEnv
): Promise<string> {
  const key = await importSealingAesKey(env)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = encoder.encode(JSON.stringify(payload))

  const encryptedBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    plaintext
  )
  const encryptedBytes = new Uint8Array(encryptedBuf)
  // Web Crypto appends the 16-byte GCM authentication tag at the end of ciphertext
  const ciphertext = encryptedBytes.subarray(0, encryptedBytes.length - 16)
  const tag = encryptedBytes.subarray(encryptedBytes.length - 16)

  return [
    SEAL_PREFIX,
    toBase64Url(iv),
    toBase64Url(tag),
    toBase64Url(ciphertext),
  ].join('.')
}

export async function unsealExamGradingPayloadWorker(
  sealed: string,
  env: WorkerEnv
): Promise<SealedExamPayload> {
  const parts = sealed.split('.')
  if (parts.length !== 6 || `${parts[0]}.${parts[1]}.${parts[2]}` !== SEAL_PREFIX) {
    throw new Error('Dữ liệu niêm phong đáp án không đúng định dạng.')
  }

  const iv = fromBase64Url(parts[3])
  const tag = fromBase64Url(parts[4])
  const ciphertext = fromBase64Url(parts[5])

  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Gói niêm phong đáp án không hợp lệ.')
  }

  const key = await importSealingAesKey(env)
  const combined = new Uint8Array(ciphertext.length + tag.length)
  combined.set(ciphertext, 0)
  combined.set(tag, ciphertext.length)

  try {
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      combined
    )
    const parsed = JSON.parse(decoder.decode(plainBuf)) as SealedExamPayload
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.items)) {
      throw new Error('Nội dung niêm phong đề thi không hợp lệ.')
    }
    return parsed
  } catch (err) {
    if (err instanceof Error && err.message.includes('EXAM_SEALING_SECRET')) {
      throw err
    }
    throw new Error(
      'Không thể giải mã gói đáp án đề thi. Kiểm tra EXAM_SEALING_SECRET khớp với khóa khi xuất bản đề thi.'
    )
  }
}
