import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, session: {} }))
vi.mock('../../database', () => ({ getDb: vi.fn() }))

import {
  cookieMatches,
  defaultProfilePath,
  feedCookieDomains,
  toElectronCookie,
} from './browser-cookies'

describe('feedCookieDomains', () => {
  it('syncs only the subscribed sites plus YouTube and Google', () => {
    const domains = feedCookieDomains([
      { url: 'https://linux.do/c/news/34.rss', siteUrl: 'https://linux.do' },
      { url: 'https://rss.nodeseek.com/', siteUrl: 'https://www.nodeseek.com' },
      { url: 'http://127.0.0.1:1200/feed', siteUrl: undefined },
      { url: 'not a url' },
    ])

    expect([...domains].sort()).toEqual([
      'google.com',
      'linux.do',
      'nodeseek.com',
      'youtube.com',
    ])
    expect(cookieMatches('.linux.do', domains)).toBe(true)
    expect(cookieMatches('www.nodeseek.com', domains)).toBe(true)
    expect(cookieMatches('accounts.google.com', domains)).toBe(true)
    expect(cookieMatches('.mybank.com', domains)).toBe(false)
  })
})

describe('defaultProfilePath', () => {
  it('prefers the profile the install opens over the Default=1 marker', () => {
    const ini = `[Profile1]
Name=Default Profile
IsRelative=1
Path=bl87ryvm.Default Profile
Default=1

[Profile0]
Path=9mruppn9.Default (release)

[Install15B76BAA26BA15E7]
Default=9mruppn9.Default (release)
Locked=1
`
    expect(defaultProfilePath(ini)).toBe('9mruppn9.Default (release)')
    expect(defaultProfilePath(ini.slice(0, ini.indexOf('[Install')))).toBe(
      'bl87ryvm.Default Profile',
    )
  })
})

describe('toElectronCookie', () => {
  const row = {
    name: 'SID',
    value: 'v',
    host: '.youtube.com',
    path: '/',
    expiry: 1825078455699,
    isSecure: 1,
    isHttpOnly: 0,
    sameSite: 0,
  }

  it('maps a domain cookie with a millisecond expiry', () => {
    expect(toElectronCookie(row)).toMatchObject({
      url: 'https://youtube.com/',
      domain: '.youtube.com',
      secure: true,
      httpOnly: false,
      expirationDate: 1825078455.699,
      sameSite: 'no_restriction',
    })
  })

  it('keeps host-only cookies without a domain and reads second expiries', () => {
    const cookie = toElectronCookie({
      ...row,
      name: '__Host-GAPS',
      host: 'accounts.google.com',
      expiry: 1825078455,
      sameSite: 256,
    })
    expect(cookie.domain).toBeUndefined()
    expect(cookie.url).toBe('https://accounts.google.com/')
    expect(cookie.expirationDate).toBe(1825078455)
    expect(cookie.sameSite).toBe('unspecified')
  })
})
