import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../../shared/ipc-contracts'
import { registerChannel } from '../../ipc/register-channel'
import { getEventBus } from '../system/event-bus'
import { startLocalApiServer, type LocalApiServer } from './local-api-server'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/livo-local-api-test'),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../system/logger', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}))

const TOKEN = 'test-token'
let server: LocalApiServer
let base: string

beforeAll(async () => {
  registerChannel(IPC.APP_GET_VERSION, () => 'fixed-version')
  server = await startLocalApiServer({ port: 0, token: TOKEN })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
  await server.close()
})

function callIpc(headers: Record<string, string>) {
  return fetch(`${base}/api/ipc/${IPC.APP_GET_VERSION}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ args: [] }),
  })
}

describe('local API server', () => {
  it('rejects IPC calls without a token', async () => {
    const res = await callIpc({})
    expect(res.status).toBe(401)
  })

  it('invokes the registered handler and returns an IPC envelope', async () => {
    const res = await callIpc({ 'X-Livo-Token': TOKEN })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, data: 'fixed-version' })
  })

  it('streams event bus events to SSE clients', async () => {
    const controller = new AbortController()
    const res = await fetch(`${base}/api/events?token=${TOKEN}`, {
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    // 等到握手注释到达，确保 sink 已注册。
    while (!text.includes(': connected')) {
      text += decoder.decode((await reader.read()).value)
    }

    const payload = { newEntries: 3, feedId: 'feed-1' }
    getEventBus().send('feeds:updated', payload)

    while (!text.includes('\n\ndata: ') || !text.endsWith('\n\n')) {
      text += decoder.decode((await reader.read()).value)
    }
    const line = text.split('\n').find((l) => l.startsWith('data: '))!
    expect(JSON.parse(line.slice('data: '.length))).toEqual({
      channel: 'feeds:updated',
      args: [payload],
    })
    controller.abort()
  })
})
