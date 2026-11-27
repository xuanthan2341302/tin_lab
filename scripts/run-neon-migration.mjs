#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { neon } from '@neondatabase/serverless'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

// Load local env files if present (never overrides already-exported env vars)
dotenv.config({ path: path.join(rootDir, '.env') })
dotenv.config({ path: path.join(rootDir, '.dev.vars') })

const databaseUrl = (process.env.DATABASE_URL || '').trim()
if (!databaseUrl) {
  console.error(
    '[TIN LAB Migration] Thiếu biến môi trường DATABASE_URL.\n' +
      'Cách chạy: DATABASE_URL="postgresql://..." npm run db:migrate:neon'
  )
  process.exit(1)
}

const migrationPath = path.join(rootDir, 'migrations', '0001_neon_core_schema.sql')
if (!fs.existsSync(migrationPath)) {
  console.error(`[TIN LAB Migration] Không tìm thấy tệp migration: ${migrationPath}`)
  process.exit(1)
}

const rawSql = fs.readFileSync(migrationPath, 'utf8')
// Remove single-line SQL comments and split safely on statement terminators
const statements = rawSql
  .replace(/--[^\n]*\n/g, '\n')
  .split(';')
  .map((stmt) => stmt.trim())
  .filter((stmt) => stmt.length > 0)

const sql = neon(databaseUrl)

async function run() {
  console.log(`[TIN LAB Migration] Bắt đầu chạy ${statements.length} câu lệnh an toàn (IF NOT EXISTS)...`)

  for (let i = 0; i < statements.length; i += 1) {
    const stmt = statements[i]
    const firstLine = stmt.split('\n')[0].slice(0, 80)
    try {
      await sql.query(stmt)
      console.log(`  [${i + 1}/${statements.length}] OK: ${firstLine}`)
    } catch (err) {
      console.error(`  [${i + 1}/${statements.length}] LỖI ở câu lệnh: ${firstLine}`)
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    }
  }

  const tables = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('exam_attempts', 'users', 'role_definitions', 'admin_authorizations', 'admin_audit_logs')
    ORDER BY table_name
  `

  const indexes = await sql`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'exam_attempts'
    ORDER BY indexname
  `

  console.log('\n[TIN LAB Migration] Hoàn tất an toàn (không ghi đè / không xóa dữ liệu).')
  console.log(
    '  Bảng đã xác nhận:',
    tables.map((row) => row.table_name).join(', ')
  )
  console.log(
    '  Chỉ mục trên exam_attempts:',
    indexes.map((row) => row.indexname).join(', ')
  )
}

run().catch((err) => {
  console.error('[TIN LAB Migration] Lỗi không mong đợi:', err instanceof Error ? err.message : err)
  process.exit(1)
})
