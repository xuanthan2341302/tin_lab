import firebaseConfig from '../firebase-applet-config.json'

export interface WorkerEnv {
  DATABASE_URL?: string
  FIREBASE_PROJECT_ID?: string
  EXAM_SEALING_SECRET?: string
  ASSETS?: Fetcher
}

export const AUTHORIZED_SUPER_ADMIN_LIST = [
  'sunghiep.tsbd@gmail.com',
  'secret1990.tsbd@gmail.com',
] as const

export const AUTHORIZED_SUPER_ADMIN_EMAILS = new Set<string>(
  AUTHORIZED_SUPER_ADMIN_LIST
)

export const SUPER_ADMIN_PERMISSIONS: string[] = [
  'teacher:workspace',
  'question_bank:manage',
  'exams:create',
  'exams:manage',
  'grading:manage',
  'student_results:view',
  'student_results:review',
  'student_results:export',
  'reports:view',
  'system:settings',
  'rbac:manage_admins',
]

export const PHASE2_DEFERRED_FEATURES = [
  'document_upload_docx_pdf',
  'ai_agent_document_analysis',
  'auto_question_extraction',
  'google_drive_document_library',
  'advanced_xlsx_export',
  'smtp_contact_email',
] as const

export function resolveFirebaseProjectId(env: WorkerEnv): string {
  const fromEnv = env.FIREBASE_PROJECT_ID?.trim()
  if (fromEnv) return fromEnv
  const fromConfig =
    typeof firebaseConfig.projectId === 'string' ? firebaseConfig.projectId.trim() : ''
  return fromConfig
}

export function jsonResponse(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...(init.headers ?? {}),
  })
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers,
  })
}

export function errorResponse(
  status: number,
  error: string,
  code?: string,
  extra?: Record<string, unknown>
): Response {
  return jsonResponse(
    {
      ok: false,
      ...(code ? { code } : {}),
      error,
      ...(extra ?? {}),
    },
    { status, headers: { 'Cache-Control': 'no-store' } }
  )
}
