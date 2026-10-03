import { QueryClient } from '@tanstack/react-query'

const DEFAULT_STALE_TIME_MS = 30_000
const DEFAULT_GC_TIME_MS = 5 * 60_000
const DO_NOT_RETRY_STATUS_CODES = new Set([400, 401, 403, 404, 422])

let rendererQueryClient: QueryClient | null = null

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: {
      persist?: boolean
    }
  }
}

function getErrorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null

  const record = error as Record<string, unknown>
  const candidates = [
    record['status'],
    record['statusCode'],
    typeof record['response'] === 'object' && record['response']
      ? (record['response'] as Record<string, unknown>)['status']
      : null,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate
    }
  }

  return null
}

export function getRendererQueryClient(): QueryClient {
  if (!rendererQueryClient) {
    rendererQueryClient = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: DEFAULT_STALE_TIME_MS,
          gcTime: DEFAULT_GC_TIME_MS,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
          retry(failureCount, error) {
            const statusCode = getErrorStatusCode(error)
            if (
              statusCode !== null &&
              DO_NOT_RETRY_STATUS_CODES.has(statusCode)
            ) {
              return false
            }
            return failureCount < 2
          },
        },
      },
    })
  }

  return rendererQueryClient
}
