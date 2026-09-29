import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApi } from '../shared/api-factory'
import { createWebAPI } from './web-api'

const connection = { base: 'http://127.0.0.1:27412', token: 'test-token' }

describe('web api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('forwards calls to the local API and unwraps the IPC envelope', async () => {
    const feeds = [{ id: 'feed-1', title: 'Feed' }]
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: feeds }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await createWebAPI(connection).feeds.list()

    expect(result).toEqual(feeds)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe('http://127.0.0.1:27412/api/ipc/feed:list')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Livo-Token']).toBe(
      'test-token',
    )
    expect(JSON.parse(init.body as string)).toEqual({ args: [] })
  })

  it('only overrides members that already exist on the shared api', () => {
    const fakeTransport = {
      invoke: async <T>() => undefined as T,
      on: () => () => {},
      platform: 'test',
    }
    expect(Object.keys(createWebAPI(connection)).sort()).toEqual(
      Object.keys(createApi(fakeTransport)).sort(),
    )
  })
})
