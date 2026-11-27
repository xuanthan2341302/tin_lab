#!/usr/bin/env node
import { performance } from 'node:perf_hooks'

const TARGET_URL = (process.env.TARGET_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '')
const CONCURRENCY_LEVELS = (process.env.CONCURRENCY_LEVELS || '10,20,40')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const ROUNDS_PER_LEVEL = Math.max(1, Number(process.env.ROUNDS_PER_LEVEL || '2'))

const SCENARIOS = [
  { name: 'SPA /', method: 'GET', path: '/', expectedStatuses: [200] },
  { name: 'SPA /hoc-sinh', method: 'GET', path: '/hoc-sinh', expectedStatuses: [200] },
  { name: 'SPA /giao-vien', method: 'GET', path: '/giao-vien', expectedStatuses: [200] },
  { name: 'SPA /thong-ke', method: 'GET', path: '/thong-ke', expectedStatuses: [200] },
  { name: 'API /api/health', method: 'GET', path: '/api/health', expectedStatuses: [200] },
  {
    name: 'API /api/dashboard/metrics',
    method: 'GET',
    path: '/api/dashboard/metrics',
    expectedStatuses: [200],
  },
  {
    name: 'API /api/student/attempts/start (validation)',
    method: 'POST',
    path: '/api/student/attempts/start',
    body: JSON.stringify({ studentName: 'A', className: '?', examId: 'demo', examKind: 'published' }),
    expectedStatuses: [400],
  },
  {
    name: 'API /api/admin/student-results (auth guard)',
    method: 'GET',
    path: '/api/admin/student-results',
    expectedStatuses: [401],
  },
  {
    name: 'API /api/documents (phase2 deferred)',
    method: 'GET',
    path: '/api/documents',
    expectedStatuses: [501],
  },
]

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1)
  )
  return sortedValues[idx]
}

async function runSingleRequest(scenario) {
  const start = performance.now()
  try {
    const res = await fetch(`${TARGET_URL}${scenario.path}`, {
      method: scenario.method,
      headers: scenario.body ? { 'Content-Type': 'application/json' } : undefined,
      body: scenario.body,
    })
    await res.text()
    const elapsedMs = performance.now() - start
    const ok = scenario.expectedStatuses.includes(res.status)
    return { ok, status: res.status, elapsedMs, scenario: scenario.name, error: null }
  } catch (err) {
    const elapsedMs = performance.now() - start
    return {
      ok: false,
      status: 0,
      elapsedMs,
      scenario: scenario.name,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function runConcurrencyLevel(concurrency) {
  const results = []
  const levelStart = performance.now()

  for (let round = 0; round < ROUNDS_PER_LEVEL; round += 1) {
    const tasks = Array.from({ length: concurrency }, (_, i) => {
      const scenario = SCENARIOS[(round * concurrency + i) % SCENARIOS.length]
      return runSingleRequest(scenario)
    })
    const batchResults = await Promise.all(tasks)
    results.push(...batchResults)
  }

  const totalElapsedMs = performance.now() - levelStart
  const latencies = results.map((r) => r.elapsedMs).sort((a, b) => a - b)
  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  const avgMs =
    latencies.reduce((sum, v) => sum + v, 0) / Math.max(1, latencies.length)
  const rps = (results.length / Math.max(1, totalElapsedMs)) * 1000
  const memMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10

  const failureDetails = results
    .filter((r) => !r.ok)
    .slice(0, 5)
    .map((r) => `${r.scenario} -> HTTP ${r.status}${r.error ? ` (${r.error})` : ''}`)

  return {
    concurrency,
    totalRequests: results.length,
    passed,
    failed,
    errorRatePct: Math.round((failed / Math.max(1, results.length)) * 10000) / 100,
    minMs: Math.round(latencies[0] * 10) / 10,
    avgMs: Math.round(avgMs * 10) / 10,
    p50Ms: Math.round(percentile(latencies, 50) * 10) / 10,
    p95Ms: Math.round(percentile(latencies, 95) * 10) / 10,
    maxMs: Math.round(latencies[latencies.length - 1] * 10) / 10,
    rps: Math.round(rps * 10) / 10,
    memMb,
    failureDetails,
  }
}

async function main() {
  console.log(`=== TIN LAB Cloudflare Worker Load Test ===`)
  console.log(`Target URL : ${TARGET_URL}`)
  console.log(`Levels     : ${CONCURRENCY_LEVELS.join(', ')} concurrent requests (${ROUNDS_PER_LEVEL} rounds each)`)

  const healthRes = await fetch(`${TARGET_URL}/api/health`).catch(() => null)
  if (!healthRes || !healthRes.ok) {
    console.error(`ERROR: Không kết nối được ${TARGET_URL}/api/health. Hãy khởi chạy server trước.`)
    process.exit(1)
  }
  const health = await healthRes.json()
  console.log(
    `Runtime    : ${health.runtime} | DB configured: ${health.databaseConfigured} | DB connected: ${health.databaseConnected}`
  )
  console.log('')

  let hasFailures = false
  for (const level of CONCURRENCY_LEVELS) {
    const summary = await runConcurrencyLevel(level)
    if (summary.failed > 0) hasFailures = true
    console.log(
      `[Concurrency ${String(summary.concurrency).padStart(2, ' ')}] ` +
        `reqs=${summary.totalRequests} | ok=${summary.passed}/${summary.totalRequests} ` +
        `| err=${summary.errorRatePct}% | avg=${summary.avgMs}ms | p50=${summary.p50Ms}ms ` +
        `| p95=${summary.p95Ms}ms | max=${summary.maxMs}ms | rps=${summary.rps}/s | clientRSS=${summary.memMb}MB`
    )
    if (summary.failureDetails.length > 0) {
      console.log('   Failures:', summary.failureDetails.join('; '))
    }
  }

  if (hasFailures) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('Load test failed:', err)
  process.exit(1)
})
