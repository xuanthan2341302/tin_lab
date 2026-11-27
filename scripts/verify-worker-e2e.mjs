#!/usr/bin/env node
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import {
  sealExamGradingPayloadWorker,
  unsealExamGradingPayloadWorker,
} from '../worker/crypto.ts'
import { gradePublishedExamInWorker } from '../worker/grading.ts'
import { buildStudentResultsCsvUtf8 } from '../worker/csvExport.ts'
import { pingNeonDatabase, classifyNeonDbError } from '../worker/db.ts'
import { requireSuperAdminInWorker, WorkerAuthError } from '../worker/auth.ts'

const TARGET_URL = (process.env.TARGET_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '')

async function run() {
  console.log('=== TIN LAB Cloudflare Worker E2E & Security Verification ===')
  console.log(`Target Worker URL: ${TARGET_URL}\n`)

  // 1. Verify SPA Routes + Static Assets _headers
  const spaRoutes = ['/', '/hoc-sinh', '/giao-vien', '/thong-ke', '/huong-dan', '/lien-he']
  for (const route of spaRoutes) {
    const res = await fetch(`${TARGET_URL}${route}`)
    const html = await res.text()
    assert.equal(res.status, 200, `SPA ${route} must return 200`)
    assert.equal(
      html.includes('<!doctype html') || html.includes('<html'),
      true,
      `SPA ${route} must return HTML`
    )
  }
  const fs = await import('node:fs')
  const headersFile = fs.readFileSync('public/_headers', 'utf8')
  assert.equal(headersFile.includes('/hoc-sinh') && headersFile.includes('/giao-vien'), true)
  console.log('[PASS] 1. SPA Static Assets (6/6 routes -> 200 HTML) & public/_headers noindex rules')

  // 2. Verify /api/health + Worker X-Robots-Tag
  const healthRes = await fetch(`${TARGET_URL}/api/health`)
  assert.equal(healthRes.status, 200)
  assert.equal(healthRes.headers.get('x-robots-tag'), 'noindex, nofollow')
  const health = await healthRes.json()
  assert.equal(health.ok, true)
  assert.equal(health.runtime, 'cloudflare-workers')
  assert.equal(health.databaseDriver, 'neon-serverless-websocket-transactions')
  console.log(
    `[PASS] 2. /api/health -> runtime=${health.runtime}, driver=${health.databaseDriver}, dbConfigured=${health.databaseConfigured}, dbConnected=${health.databaseConnected}`
  )

  // 3. Verify Super Admin Auth Guards (missing token, malformed JWT, fake RS256 token)
  const protectedRoutes = [
    ['POST', '/api/auth/google'],
    ['GET', '/api/auth/me'],
    ['GET', '/api/admin/student-results'],
    ['GET', '/api/admin/student-results/export'],
    ['PATCH', '/api/admin/student-results/00000000-0000-4000-8000-000000000001/review'],
    ['POST', '/api/exams/seal'],
    ['GET', '/api/admin/administrators'],
    ['POST', '/api/admin/administrators'],
    ['GET', '/api/admin/system-settings'],
  ]
  const forgedJwt =
    'eyJhbGciOiJSUzI1NiIsImtpZCI6ImZha2Uta2lkIiwidHlwIjoiSldUIn0.' +
    'eyJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vZ2VuLWxhbmctY2xpZW50LTAwNDY1OTMwODMiLCJhdWQiOiJnZW4tbGFuZy1jbGllbnQtMDA0NjU5MzA4MyIsInN1YiI6ImZha2UtdWlkIiwiZW1haWwiOiJzdW5naGllcC50c2JkQGdtYWlsLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJleHAiOjQxMDI0NDQ4MDB9.' +
    'ZmFrZS1zaWduYXR1cmUtYnl0ZXM'

  for (const [method, path] of protectedRoutes) {
    const noAuth = await fetch(`${TARGET_URL}${path}`, { method })
    assert.equal(noAuth.status, 401, `${method} ${path} without token must return 401`)
    const badAuth = await fetch(`${TARGET_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${forgedJwt}` },
    })
    assert.equal(badAuth.status, 401, `${method} ${path} with forged RS256 token must return 401`)
  }
  // Direct unit check on WorkerAuthError
  let threwAuthErr = false
  try {
    await requireSuperAdminInWorker(
      new Request('https://tin-lab.example/api/admin/student-results'),
      { FIREBASE_PROJECT_ID: 'gen-lang-client-0046593083' }
    )
  } catch (err) {
    threwAuthErr = err instanceof WorkerAuthError && err.status === 401
  }
  assert.equal(threwAuthErr, true)
  console.log(`[PASS] 3. Super Admin JWKS Auth Guards (${protectedRoutes.length}/${protectedRoutes.length} endpoints rejected unauth & forged JWT)`)

  // 4. Verify Answer Protection Before Submission
  const directGradeRes = await fetch(`${TARGET_URL}/api/exams/grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ examId: 'exam-1', sealedGradingPayload: 'x', studentAnswers: [] }),
  })
  assert.equal(directGradeRes.status, 403, 'Direct /api/exams/grade must be disabled (403)')
  assert.equal((await directGradeRes.json()).code, 'DIRECT_GRADING_DISABLED')

  // Verify Web Crypto AES-256-GCM sealing rejects missing secret, tampered ciphertext, and examId mismatch
  const testSecret = 'verify-e2e-sealing-secret-key-9876543210'
  const testEnv = { EXAM_SEALING_SECRET: testSecret }
  const sampleExam = {
    v: 1,
    examId: 'exam-security-check',
    part2ScoringMode: 'tiered_2025',
    totalPoints: 10,
    items: [
      { id: 'q1', part: 1, questionType: 'multiple_choice', points: 3, questionText: 'Câu 1', answerKey: 'C' },
      {
        id: 'q2',
        part: 2,
        questionType: 'true_false',
        points: 4,
        questionText: 'Câu 2',
        statementAnswerA: true,
        statementAnswerB: false,
        statementAnswerC: true,
        statementAnswerD: false,
      },
      { id: 'q3', part: 3, questionType: 'essay', points: 3, questionText: 'Câu 3 tự luận' },
    ],
  }
  const sealed = await sealExamGradingPayloadWorker(sampleExam, testEnv)
  assert.equal(sealed.includes('"answerKey"'), false, 'Sealed payload must not leak plaintext answerKey')
  assert.equal(sealed.includes('statementAnswerA'), false, 'Sealed payload must not leak plaintext true/false keys')

  let tamperedRejected = false
  try {
    await unsealExamGradingPayloadWorker(`${sealed.slice(0, -4)}AAAA`, testEnv)
  } catch {
    tamperedRejected = true
  }
  assert.equal(tamperedRejected, true, 'Tampered AES-GCM ciphertext must be rejected')

  let examMismatchRejected = false
  try {
    await gradePublishedExamInWorker(
      { examId: 'different-exam', sealedGradingPayload: sealed, studentAnswers: [] },
      testEnv
    )
  } catch {
    examMismatchRejected = true
  }
  assert.equal(examMismatchRejected, true, 'examId mismatch must be rejected during grading')

  const graded = await gradePublishedExamInWorker(
    {
      examId: 'exam-security-check',
      sealedGradingPayload: sealed,
      studentAnswers: [
        { questionId: 'q1', selectedOption: 'C' },
        { questionId: 'q2', statementChoices: { a: true, b: false, c: true, d: false } },
        { questionId: 'q3', essayText: 'Bài làm tự luận thử nghiệm' },
      ],
    },
    testEnv
  )
  assert.equal(graded.part1Score, 3)
  assert.equal(graded.part2Score, 4)
  assert.equal(graded.gradingStatus, 'needs_teacher_review')
  console.log('[PASS] 4. Answer Protection & Server Web Crypto AES-256-GCM Grading (tamper & mismatch blocked)')

  // 5. Verify Deferred Phase-2 Routes Return Honest 501 PHASE2_DEFERRED
  const deferredRoutes = [
    ['GET', '/api/documents'],
    ['GET', '/api/teacher/documents'],
    ['POST', '/api/teacher/documents/upload'],
    ['GET', '/api/drive/status'],
    ['GET', '/api/question-bank/drafts'],
    ['POST', '/api/question-bank/parse'],
    ['POST', '/api/ai/diagnostics'],
    ['POST', '/api/exams/regrade-essay'],
    ['POST', '/api/contact'],
  ]
  for (const [method, path] of deferredRoutes) {
    const r = await fetch(`${TARGET_URL}${path}`, { method })
    const b = await r.json()
    assert.equal(r.status, 501, `${method} ${path} must return 501`)
    assert.equal(b.code, 'PHASE2_DEFERRED')
  }
  console.log(`[PASS] 5. Phase-2 Deferred Routes (${deferredRoutes.length}/${deferredRoutes.length} return 501 PHASE2_DEFERRED)`)

  // 6. Verify Input Validation on Student Start & Submit
  const invalidStart = await fetch(`${TARGET_URL}/api/student/attempts/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentName: 'A', className: '???', examId: 'ex1', examKind: 'published' }),
  })
  assert.equal(invalidStart.status, 400)
  assert.equal((await invalidStart.json()).code, 'VALIDATION_ERROR')

  const invalidSubmit = await fetch(`${TARGET_URL}/api/student/attempts/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptId: 'not-a-uuid', examId: 'ex1', sealedGradingPayload: 'x', studentAnswers: [] }),
  })
  assert.equal(invalidSubmit.status, 400)
  console.log('[PASS] 6. Student Start & Submit Payload Validation')

  // 7. Verify Database Missing & Database Disconnected Error Handling
  const missingDbPing = await pingNeonDatabase({})
  assert.equal(missingDbPing.configured, false)
  assert.equal(missingDbPing.connected, false)
  assert.equal(missingDbPing.errorCode, 'DATABASE_URL_MISSING')

  const deadDbPing = await pingNeonDatabase({
    DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/neondb?sslmode=require',
  })
  assert.equal(deadDbPing.configured, true)
  assert.equal(deadDbPing.connected, false)
  assert.equal(deadDbPing.errorCode, 'DB_CONNECTION_FAILED')

  const classifiedDisconnect = classifyNeonDbError(
    'Fallback',
    new Error('WebSocket connection terminated unexpectedly')
  )
  assert.equal(classifiedDisconnect.httpStatus, 503)
  assert.equal(classifiedDisconnect.code, 'DB_CONNECTION_FAILED')

  if (!health.databaseConfigured) {
    const startNoDb = await fetch(`${TARGET_URL}/api/student/attempts/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentName: 'Nguyễn Văn An',
        className: '12A1',
        examId: 'exam-test-01',
        examTitle: 'Đề kiểm tra thử',
        examKind: 'published',
      }),
    })
    assert.equal(startNoDb.status, 503, 'Valid start request without DB must return 503 cleanly')
    assert.equal((await startNoDb.json()).code, 'DATABASE_URL_MISSING')
  }
  console.log('[PASS] 7. Database Missing & Disconnected Graceful 503 Handling (zero Worker crashes)')

  // 8. Verify CSV Export (UTF-8 BOM + Formula Injection Protection)
  const csv = buildStudentResultsCsvUtf8({
    includeDetailedAnswers: false,
    data: {
      ok: true,
      attempts: [
        {
          id: 1,
          attemptId: '00000000-0000-4000-8000-000000000001',
          examId: 'exam-1',
          examTitle: '=HYPERLINK("http://evil")',
          examKind: 'published',
          accessCode: 'TIN12',
          studentName: 'Trần Thị Bình',
          className: '12A2',
          rawClassName: '12a2',
          startedAt: '2026-04-01T08:00:00.000Z',
          submittedAt: '2026-04-01T08:30:00.000Z',
          durationSeconds: 1800,
          completionStatus: 'auto_graded',
          scoringMode: 'tiered_2025',
          part1Score: 3,
          part1Max: 3,
          part2Score: 4,
          part2Max: 4,
          part3Score: 0,
          part3Max: 0,
          score: 7,
          maxScore: 7,
          detailedAnswers: [],
          adminFeedback: '+CMD|calc',
          reviewedByEmail: null,
          reviewedAt: null,
        },
      ],
      availableClasses: ['12A2'],
      availableExams: [],
      classStats: [],
      examStats: [],
      studentProgress: [],
    },
  })
  assert.equal(csv.startsWith('\uFEFF'), true)
  assert.equal(csv.includes("'=HYPERLINK"), true)
  assert.equal(csv.includes("'+CMD|calc"), true)
  console.log('[PASS] 8. CSV UTF-8 BOM & Formula Injection Protection')

  // 9. Live Neon PostgreSQL Start -> Submit -> Double-Submit 409 Check (only when live DB + sealing secret configured)
  if (health.databaseConnected && health.examSealingSecretConfigured && process.env.EXAM_SEALING_SECRET) {
    const startT = performance.now()
    const liveSealed = await sealExamGradingPayloadWorker(sampleExam, {
      EXAM_SEALING_SECRET: process.env.EXAM_SEALING_SECRET,
    })
    const startRes = await fetch(`${TARGET_URL}/api/student/attempts/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentName: 'Kiểm Thử Hệ Thống',
        className: '12A1',
        examId: sampleExam.examId,
        examTitle: 'Đề kiểm tra xác minh Neon',
        examKind: 'published',
        maxScore: 10,
      }),
    })
    assert.equal(startRes.status, 201, 'Live Neon start attempt must return 201')
    const startData = await startRes.json()
    assert.equal(Boolean(startData.attempt?.attemptId), true)

    const submitPayload = {
      attemptId: startData.attempt.attemptId,
      examId: sampleExam.examId,
      sealedGradingPayload: liveSealed,
      studentAnswers: [
        { questionId: 'q1', selectedOption: 'C' },
        { questionId: 'q2', statementChoices: { a: true, b: false, c: true, d: false } },
        { questionId: 'q3', essayText: '' },
      ],
    }
    const sub1 = await fetch(`${TARGET_URL}/api/student/attempts/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submitPayload),
    })
    assert.equal(sub1.status, 200, 'Live Neon first submit must return 200')
    const sub2 = await fetch(`${TARGET_URL}/api/student/attempts/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submitPayload),
    })
    assert.equal(sub2.status, 409, 'Live Neon duplicate submit must be blocked with 409')
    console.log(
      `[PASS] 9. Live Neon ACID Transaction Flow (start -> submit -> double-submit 409) in ${Math.round(performance.now() - startT)}ms`
    )
  } else {
    console.log(
      '[SKIP] 9. Live Neon PostgreSQL write/read E2E skipped: Worker does not yet have DATABASE_URL & EXAM_SEALING_SECRET configured in this environment.'
    )
  }

  console.log('\nALL EXECUTED VERIFICATION CHECKS PASSED.')
}

run().catch((err) => {
  console.error('\n[FAIL] Verification error:', err)
  process.exit(1)
})
