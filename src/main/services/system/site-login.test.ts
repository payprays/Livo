import { describe, expect, it, vi } from 'vitest'

const { app, openExternal, syncBrowserCookies } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('events')
  return {
    app: new EventEmitter(),
    openExternal: vi.fn(async () => {}),
    syncBrowserCookies: vi.fn(async () => {}),
  }
})

vi.mock('electron', () => ({ app, shell: { openExternal } }))
vi.mock('./browser-cookies', () => ({ syncBrowserCookies }))

import { openSiteLogin } from './site-login'

describe('openSiteLogin', () => {
  it('opens the browser and syncs cookies once the user comes back', async () => {
    let done = false
    const result = openSiteLogin('https://linux.do').then((r) => {
      done = true
      return r
    })
    await vi.waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://linux.do/'),
    )

    // A focus without leaving first (e.g. Livo already focused) is not "back".
    app.emit('browser-window-focus')
    await Promise.resolve()
    expect(syncBrowserCookies).not.toHaveBeenCalled()

    app.emit('browser-window-blur')
    app.emit('browser-window-focus')
    await expect(result).resolves.toEqual({ success: true })
    expect(done).toBe(true)
    expect(syncBrowserCookies).toHaveBeenCalledTimes(1)
  })

  it('rejects non-web URLs without opening anything', async () => {
    openExternal.mockClear()
    await expect(openSiteLogin('file:///etc/passwd')).resolves.toEqual({
      success: false,
      error: 'invalid_url',
    })
    expect(openExternal).not.toHaveBeenCalled()
  })
})
