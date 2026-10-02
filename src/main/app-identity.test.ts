import { describe, expect, it, vi } from 'vitest'
import { configureAppIdentity, shouldForceLibsecret } from './app-identity'

function createApp(isPackaged: boolean) {
  return {
    isPackaged,
    getPath: vi.fn(() => '/Users/test/Library/Application Support/livo'),
    setName: vi.fn(),
    setPath: vi.fn(),
  }
}

describe('configureAppIdentity', () => {
  it('uses a separate macOS development identity without moving dev data', () => {
    const app = createApp(false)

    const result = configureAppIdentity(app, undefined, 'darwin')

    expect(result).toEqual({ isDev: true })
    expect(app.setName).toHaveBeenCalledWith('Livo Dev')
    expect(app.setPath).toHaveBeenCalledWith(
      'userData',
      '/Users/test/Library/Application Support/livo',
    )
  })

  it('keeps the isolated E2E user-data directory on macOS', () => {
    const app = createApp(false)

    configureAppIdentity(app, '/tmp/livo-e2e', 'darwin')

    expect(app.setName).toHaveBeenCalledWith('Livo Dev')
    expect(app.setPath).toHaveBeenCalledWith('userData', '/tmp/livo-e2e')
    expect(app.getPath).not.toHaveBeenCalled()
  })

  it('does not rename development builds on other platforms', () => {
    const app = createApp(false)

    configureAppIdentity(app, '/tmp/livo-e2e', 'win32')

    expect(app.setName).not.toHaveBeenCalled()
    expect(app.setPath).toHaveBeenCalledWith('userData', '/tmp/livo-e2e')
    expect(app.getPath).not.toHaveBeenCalled()
  })

  it('does not change the packaged application identity', () => {
    const app = createApp(true)

    const result = configureAppIdentity(app, undefined, 'darwin')

    expect(result).toEqual({ isDev: false })
    expect(app.setName).not.toHaveBeenCalled()
    expect(app.setPath).not.toHaveBeenCalled()
    expect(app.getPath).not.toHaveBeenCalled()
  })
})

describe('shouldForceLibsecret', () => {
  it('forces libsecret only on Linux desktops Chromium does not recognise', () => {
    expect(shouldForceLibsecret({ XDG_CURRENT_DESKTOP: 'niri' }, 'linux')).toBe(
      true,
    )
    expect(shouldForceLibsecret({}, 'linux')).toBe(true)
    expect(shouldForceLibsecret({ XDG_CURRENT_DESKTOP: 'KDE' }, 'linux')).toBe(
      false,
    )
    expect(
      shouldForceLibsecret({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, 'linux'),
    ).toBe(false)
    expect(shouldForceLibsecret({ DESKTOP_SESSION: 'plasma' }, 'linux')).toBe(
      false,
    )
    expect(shouldForceLibsecret({ KDE_FULL_SESSION: 'true' }, 'linux')).toBe(
      false,
    )
    expect(
      shouldForceLibsecret({ XDG_CURRENT_DESKTOP: 'niri' }, 'darwin'),
    ).toBe(false)
  })
})
