import { initializeApp } from 'firebase/app'
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
} from 'firebase/auth'
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore'
import firebaseConfig from '../../firebase-applet-config.json'

const app = initializeApp(firebaseConfig)

const firestoreDatabaseId = (
  firebaseConfig as { firestoreDatabaseId?: string }
).firestoreDatabaseId

export const db =
  firestoreDatabaseId && firestoreDatabaseId !== '(default)'
    ? getFirestore(app, firestoreDatabaseId)
    : getFirestore(app)

export const auth = getAuth(app)

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

export const googleProvider = new GoogleAuthProvider()
googleProvider.addScope(GOOGLE_DRIVE_SCOPE)
googleProvider.setCustomParameters({ prompt: 'select_account' })

// Strict in-memory Google Drive OAuth access token cache.
// NEVER persisted to localStorage, sessionStorage, or cookies.
interface InMemoryDriveTokenState {
  accessToken: string
  email: string | null
  grantedAt: number
}

let inMemoryDriveToken: InMemoryDriveTokenState | null = null
const driveTokenListeners = new Set<() => void>()

function notifyDriveTokenListeners() {
  for (const listener of driveTokenListeners) {
    try {
      listener()
    } catch {
      // Ignore subscriber errors
    }
  }
}

export function setGoogleDriveToken(accessToken: string, email?: string | null): void {
  const trimmed = accessToken.trim()
  if (!trimmed) return
  inMemoryDriveToken = {
    accessToken: trimmed,
    email: email ? email.trim().toLowerCase() : auth.currentUser?.email?.toLowerCase() ?? null,
    grantedAt: Date.now(),
  }
  notifyDriveTokenListeners()
}

export function getGoogleDriveToken(): string | null {
  return inMemoryDriveToken?.accessToken ?? null
}

export function getGoogleDriveTokenMeta(): {
  hasToken: boolean
  email: string | null
  grantedAt: number | null
} {
  return {
    hasToken: Boolean(inMemoryDriveToken?.accessToken),
    email: inMemoryDriveToken?.email ?? null,
    grantedAt: inMemoryDriveToken?.grantedAt ?? null,
  }
}

export function clearGoogleDriveToken(): void {
  if (!inMemoryDriveToken) return
  inMemoryDriveToken = null
  notifyDriveTokenListeners()
}

export function subscribeGoogleDriveToken(listener: () => void): () => void {
  driveTokenListeners.add(listener)
  return () => {
    driveTokenListeners.delete(listener)
  }
}

onAuthStateChanged(auth, (nextUser) => {
  if (!nextUser) {
    clearGoogleDriveToken()
  }
})

/**
 * Initiates client-side Google OAuth 2.0 popup with least-privilege drive.file scope.
 * Caches the resulting Google Drive access token strictly in memory for backend API calls.
 */
export async function connectGoogleDriveWithPopup(
  preferredEmail?: string
): Promise<{ accessToken: string; email: string | null }> {
  const driveProvider = new GoogleAuthProvider()
  driveProvider.addScope(GOOGLE_DRIVE_SCOPE)
  const customParams: Record<string, string> = {
    prompt: 'select_account consent',
  }
  if (preferredEmail && preferredEmail.includes('@')) {
    customParams.login_hint = preferredEmail.trim().toLowerCase()
  }
  driveProvider.setCustomParameters(customParams)

  const result = await signInWithPopup(auth, driveProvider)
  const credential = GoogleAuthProvider.credentialFromResult(result)
  const accessToken = credential?.accessToken?.trim() || ''

  if (!accessToken) {
    throw new Error(
      'Google không trả về mã truy cập Google Drive (access token). Vui lòng thử lại và chấp thuận quyền drive.file.'
    )
  }

  const email = result.user.email?.trim().toLowerCase() ?? null
  setGoogleDriveToken(accessToken, email)
  return { accessToken, email }
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'))
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.')
    }
  }
}

void testConnection()

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string
  operationType: OperationType
  path: string | null
  authInfo: {
    userId?: string | null
    email?: string | null
    emailVerified?: boolean | null
    isAnonymous?: boolean | null
    tenantId?: string | null
    providerInfo?: {
      providerId?: string | null
      email?: string | null
    }[]
  }
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo))
  throw new Error(JSON.stringify(errInfo))
}
