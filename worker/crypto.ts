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

export function isExamSealingSecretConfigured(env: WorkerEnv): boolean {
  const secret = env.EXAM_SEALING_SECRET?.trim() ?? ''
  return secret.length >= 16
}

/**
 * Derives an AES-256-GCM CryptoKey from EXAM_SEALING_SECRET using SHA-256.
 * Matches Node.js createHash('sha256').update(`tinlab-configured:${secret}`) byte-for-byte
 * so exams sealed on Node.js and Cloudflare Workers interoperate seamlessly when sharing
 * the same EXAM_SEALING_SECRET.
 */
async function importSealingAesKey(env: WorkerEnv): Promise<CryptoKey> {
  const configured = env.EXAM_SEALING_SECRET?.trim() ?? ''
  if (configured.length < 16) {
    throw new Error(
      'Máy chủ Worker chưa cấu hình EXAM_SEALING_SECRET (tối thiểu 16 ký tự). Vui lòng thiết lập Worker Secret EXAM_SEALING_SECRET.'
    )
  }

  const keyMaterial = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`tinlab-configured:${configured}`)
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
