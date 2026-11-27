import fs from 'node:fs'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.ts'

declare global {
  var _postgresPool: Pool | undefined
}

const CLOUDSQL_SOCKET_ROOT = '/app/cloudsql'

export interface PostgresConnectionDiagnostics {
  configuredHostLabel: string
  resolvedHostLabel: string
  isUnixSocket: boolean
  configuredSocketExists: boolean
  resolvedSocketExists: boolean
  fallbackUsed: boolean
  databaseName: string
  userName: string
}

function hasPgSocketFile(dirPath: string): boolean {
  try {
    return fs.existsSync(path.join(dirPath, '.s.PGSQL.5432'))
  } catch {
    return false
  }
}

function findAvailableCloudSqlSocket(): string | null {
  try {
    if (!fs.existsSync(CLOUDSQL_SOCKET_ROOT)) return null
    const entries = fs.readdirSync(CLOUDSQL_SOCKET_ROOT)
    for (const entry of entries) {
      const candidate = path.join(CLOUDSQL_SOCKET_ROOT, entry)
      if (hasPgSocketFile(candidate)) {
        return candidate
      }
    }
  } catch {
    // Ignore filesystem inspection errors
  }
  return null
}

function resolveSqlHost(logWarning = false): { host: string | undefined; fallbackUsed: boolean } {
  const configured = process.env.SQL_HOST?.trim()
  if (!configured) {
    const detected = findAvailableCloudSqlSocket()
    return { host: detected ?? undefined, fallbackUsed: Boolean(detected) }
  }

  if (configured.startsWith(`${CLOUDSQL_SOCKET_ROOT}/`)) {
    if (hasPgSocketFile(configured)) {
      return { host: configured, fallbackUsed: false }
    }
    const detected = findAvailableCloudSqlSocket()
    if (detected && detected !== configured) {
      if (logWarning) {
        console.warn(
          `[TIN LAB] SQL_HOST socket "${path.basename(configured)}" not found in ${CLOUDSQL_SOCKET_ROOT}; using mounted socket "${path.basename(detected)}".`
        )
      }
      return { host: detected, fallbackUsed: true }
    }
  }

  return { host: configured, fallbackUsed: false }
}

export function getPostgresConnectionDiagnostics(): PostgresConnectionDiagnostics {
  const configured = process.env.SQL_HOST?.trim() || ''
  const { host: resolved, fallbackUsed } = resolveSqlHost(false)
  const resolvedStr = resolved || ''
  const isUnixSocket =
    configured.startsWith(`${CLOUDSQL_SOCKET_ROOT}/`) ||
    resolvedStr.startsWith(`${CLOUDSQL_SOCKET_ROOT}/`)

  return {
    configuredHostLabel: configured ? path.basename(configured) : '(unset)',
    resolvedHostLabel: resolvedStr ? path.basename(resolvedStr) : '(unset)',
    isUnixSocket,
    configuredSocketExists: configured ? hasPgSocketFile(configured) : false,
    resolvedSocketExists: resolvedStr ? hasPgSocketFile(resolvedStr) : false,
    fallbackUsed,
    databaseName: process.env.SQL_DB_NAME || '(unset)',
    userName: process.env.SQL_USER || '(unset)',
  }
}

export const createPool = () => {
  if (!global._postgresPool) {
    const { host } = resolveSqlHost(true)
    global._postgresPool = new Pool({
      host,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      max: 10,
      connectionTimeoutMillis: 15000,
    })

    global._postgresPool.on('error', (err) => {
      console.error('[TIN LAB] Unexpected error on idle PostgreSQL pool client:', err)
    })
  }
  return global._postgresPool
}

const pool = createPool()

export const db = drizzle(pool, { schema })
