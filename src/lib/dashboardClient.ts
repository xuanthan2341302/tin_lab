import { getAuthHeaders } from './authClient'
import type { RealDashboardMetricsResponse } from '../types'

export async function fetchPublicDashboardMetrics(): Promise<RealDashboardMetricsResponse> {
  const res = await fetch('/api/dashboard/metrics', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  const data = (await res.json().catch(() => null)) as
    | RealDashboardMetricsResponse
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể tải dữ liệu thống kê thực tế từ máy chủ.'
    )
  }

  return data
}

export async function fetchAdminDashboardMetrics(): Promise<RealDashboardMetricsResponse> {
  const headers = await getAuthHeaders({ Accept: 'application/json' })
  const res = await fetch('/api/admin/dashboard-metrics', {
    method: 'GET',
    headers,
  })
  const data = (await res.json().catch(() => null)) as
    | RealDashboardMetricsResponse
    | { ok: false; error?: string }
    | null

  if (!res.ok || !data || !data.ok) {
    throw new Error(
      (data && 'error' in data && data.error) ||
        'Không thể tải dữ liệu tổng quan quản trị từ máy chủ.'
    )
  }

  return data
}
