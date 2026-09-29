/**
 * Web build of `window.api`: a thin HTTP client for the desktop app's local API.
 * All data, fetching and AI run in the desktop process; see
 * src/main/services/local-api/local-api-server.ts.
 */

import type { ElectronAPI } from '../preload/index'
import { createApi } from '../shared/api-factory'
import {
  type IpcChannel,
  isIpcEnvelope,
  unwrapIpcEnvelope,
} from '../shared/ipc-contracts'
import { classifyExternalUrl } from '../shared/url-policy'

const TOKEN_KEY = 'livo-api-token'
const BASE_KEY = 'livo-api-base'
const DEFAULT_BASE = 'http://127.0.0.1:27412'

type EventHandler = (...args: unknown[]) => void

function openExternalUrlForWeb(url: string):
  | { success: true }
  | {
      success: false
      error: string
    } {
  const policy = classifyExternalUrl(url)
  if (policy.blocked) {
    return { success: false, error: policy.blockedReason || 'blocked_url' }
  }
  if (policy.suspicious) {
    return { success: false, error: 'suspicious_url' }
  }

  try {
    window.open(policy.url, '_blank', 'noopener,noreferrer')
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

function resolveConnection(): { base: string; token: string } {
  const meta = document
    .querySelector('meta[name="livo-api-token"]')
    ?.getAttribute('content')
  if (meta) return { base: location.origin, token: meta }

  const url = new URL(location.href)
  const queryToken = url.searchParams.get('token')
  if (queryToken) {
    localStorage.setItem(TOKEN_KEY, queryToken)
    url.searchParams.delete('token')
    history.replaceState(history.state, '', url)
  }
  return {
    base: localStorage.getItem(BASE_KEY) || DEFAULT_BASE,
    token: queryToken || localStorage.getItem(TOKEN_KEY) || '',
  }
}

export function createWebAPI(
  { base, token } = resolveConnection(),
): ElectronAPI {
  const invoke = async <T>(
    channel: IpcChannel,
    ...args: unknown[]
  ): Promise<T> => {
    const res = await fetch(`${base}/api/ipc/${channel}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Livo-Token': token },
      body: JSON.stringify({ args }),
    })
    const body: unknown = await res.json().catch(() => undefined)
    if (!res.ok && !isIpcEnvelope(body)) throw new Error(`HTTP ${res.status}`)
    return unwrapIpcEnvelope(body as T)
  }

  const listeners = new Map<string, Set<EventHandler>>()
  let source: EventSource | null = null
  const on = (channel: string, handler: EventHandler) => {
    if (!source) {
      source = new EventSource(
        `${base}/api/events?token=${encodeURIComponent(token)}`,
      )
      source.onmessage = (message) => {
        const { channel: ch, args } = JSON.parse(message.data) as {
          channel: string
          args: unknown[]
        }
        listeners.get(ch)?.forEach((h) => h(...args))
      }
    }
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(handler)
    return () => {
      listeners.get(channel)?.delete(handler)
    }
  }

  const api = createApi({ invoke, on, platform: 'web' })
  const ok = async () => ({ success: true })
  const noop = async () => {}

  return {
    ...api,
    app: {
      ...api.app,
      openExternal: async (url: string) => openExternalUrlForWeb(url),
      rendererReady: ok,
      readyToShowMainWindow: ok,
    },
    // 原生菜单会弹在桌面窗口上；返回 null 让渲染层关闭菜单（与旧 Web 版一致）。
    menu: { showContextMenu: async () => ({ id: null }) },
    windowControls: {
      ...api.windowControls,
      minimize: noop,
      maximizeToggle: noop,
      close: noop,
    },
  }
}

/** Create the API and make sure the desktop app's local API is reachable. */
export async function initWebPlatform(): Promise<ElectronAPI> {
  const connection = resolveConnection()
  const { base, token } = connection
  const res = await fetch(`${base}/api/health`).catch(() => null)
  if (!res?.ok) throw new Error(`local API unreachable at ${base}`)
  if (!token) throw new Error('missing local API token (open with ?token=…)')
  return createWebAPI(connection)
}
