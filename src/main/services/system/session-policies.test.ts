import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const defaultSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    webRequest: {
      onBeforeSendHeaders: vi.fn(),
      onHeadersReceived: vi.fn(),
    },
  }
  return { defaultSession }
})

vi.mock('electron', () => ({
  session: {
    defaultSession: mocks.defaultSession,
  },
}))

import { registerSessionPolicies } from './session-policies'

describe('session policies', () => {
  it('denies permission requests and checks for the default session', () => {
    registerSessionPolicies()

    expect(mocks.defaultSession.setPermissionRequestHandler).toHaveBeenCalled()
    expect(mocks.defaultSession.setPermissionCheckHandler).toHaveBeenCalled()

    const defaultRequestHandler =
      mocks.defaultSession.setPermissionRequestHandler.mock.calls[0]?.[0]
    const callback = vi.fn()
    defaultRequestHandler?.({}, 'media', callback)
    expect(callback).toHaveBeenCalledWith(false)

    const defaultCheckHandler =
      mocks.defaultSession.setPermissionCheckHandler.mock.calls[0]?.[0]
    expect(
      defaultCheckHandler?.({}, 'geolocation', 'https://evil.example'),
    ).toBe(false)
  })
})
