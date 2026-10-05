import { app, session } from 'electron'
import BetterSqlite3 from 'better-sqlite3'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { isAbsolute, join } from 'path'
import { getDb } from '../../database'

// Sign-ins come from the user's browser: Livo copies the cookies of the
// subscribed sites (and YouTube, whose embeds ask flagged IPs to sign in).
// ponytail: Firefox-family browsers only (plain-text cookies.sqlite); Chromium
// browsers encrypt cookies with a keyring key.
const PROFILE_ROOTS = [
  '.config/zen',
  '.zen',
  '.mozilla/firefox',
  '.librewolf',
  '.floorp',
]
const ALWAYS_SYNCED = ['youtube.com', 'google.com']
const SYNC_INTERVAL_MS = 60 * 60 * 1000
const FOCUS_SYNC_GAP_MS = 60 * 1000
const SAME_SITE = ['no_restriction', 'lax', 'strict'] as const

export interface FirefoxCookieRow {
  name: string
  value: string
  host: string
  path: string
  expiry: number
  isSecure: number
  isHttpOnly: number
  sameSite: number
}

/** The profile the browser opens: its [Install…] Default, else Default=1. */
export function defaultProfilePath(ini: string): string | undefined {
  const sections = ini.split(/^\[/m).map((block) => {
    const [head = '', ...lines] = block.split('\n')
    const values: Record<string, string> = {}
    for (const line of lines) {
      const i = line.indexOf('=')
      if (i > 0) values[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    return { head, values }
  })
  return (
    sections.find((s) => s.head.startsWith('Install') && s.values.Default)
      ?.values.Default ??
    sections.find((s) => s.values.Default === '1')?.values.Path
  )
}

export function toElectronCookie(
  row: FirefoxCookieRow,
): Electron.CookiesSetDetails {
  const host = row.host.replace(/^\./, '')
  return {
    url: `https://${host}${row.path}`,
    name: row.name,
    value: row.value,
    // Host-only cookies (no leading dot) must not get a domain, or
    // __Host- cookies are rejected.
    domain: row.host.startsWith('.') ? row.host : undefined,
    path: row.path,
    secure: row.isSecure === 1,
    httpOnly: row.isHttpOnly === 1,
    // Newer Firefox stores milliseconds, older versions seconds.
    expirationDate: row.expiry > 1e11 ? row.expiry / 1000 : row.expiry,
    sameSite: SAME_SITE[row.sameSite] ?? 'unspecified',
  }
}

// ponytail: last two labels, so a.example.co.uk maps to co.uk (too broad);
// use a public-suffix list if that matters.
function siteDomain(host: string): string {
  return host.split('.').slice(-2).join('.')
}

/** Cookie domains of the subscribed feeds: feed and site hosts. */
export function feedCookieDomains(
  feeds: Array<{ url: string; siteUrl?: string }>,
): Set<string> {
  const domains = new Set(ALWAYS_SYNCED)
  for (const feed of feeds) {
    for (const url of [feed.url, feed.siteUrl]) {
      try {
        const { hostname } = new URL(url ?? '')
        // Skip IPs and single-label hosts such as localhost.
        if (hostname.includes('.') && !/^[\d.]+$/.test(hostname))
          domains.add(siteDomain(hostname))
      } catch {
        // Not a URL.
      }
    }
  }
  return domains
}

export function cookieMatches(host: string, domains: Set<string>): boolean {
  return domains.has(siteDomain(host.replace(/^\./, '')))
}

function findCookieDb(): string | undefined {
  for (const root of PROFILE_ROOTS) {
    const dir = join(homedir(), root)
    let ini: string
    try {
      ini = readFileSync(join(dir, 'profiles.ini'), 'utf8')
    } catch {
      continue
    }
    const profile = defaultProfilePath(ini)
    if (!profile) continue
    const db = join(
      isAbsolute(profile) ? profile : join(dir, profile),
      'cookies.sqlite',
    )
    if (existsSync(db)) return db
  }
  return undefined
}

function readSyncedCookies(
  dbPath: string,
  domains: Set<string>,
): FirefoxCookieRow[] {
  // The browser keeps the file open; read a private copy (with its WAL).
  const dir = mkdtempSync(join(tmpdir(), 'livo-cookies-'))
  try {
    const copy = join(dir, 'cookies.sqlite')
    copyFileSync(dbPath, copy)
    if (existsSync(`${dbPath}-wal`))
      copyFileSync(`${dbPath}-wal`, `${copy}-wal`)
    const db = new BetterSqlite3(copy)
    try {
      const rows = db
        .prepare(
          // Skip partitioned and container cookies.
          `SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite
           FROM moz_cookies WHERE originAttributes = ''`,
        )
        .all() as FirefoxCookieRow[]
      return rows.filter((row) => cookieMatches(row.host, domains))
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function syncBrowserCookies(): Promise<void> {
  if (!syncEnabled()) return
  const dbPath = findCookieDb()
  if (!dbPath) return
  const rows = readSyncedCookies(
    dbPath,
    feedCookieDomains(getDb().feeds.getAllFeeds()),
  )
  const results = await Promise.allSettled(
    rows.map((row) =>
      session.defaultSession.cookies.set(toElectronCookie(row)),
    ),
  )
  const failed = results.filter((r) => r.status === 'rejected').length
  console.log(
    `[browser-cookies] synced ${rows.length - failed}/${rows.length} cookies`,
  )
}

// Never copy the user's real sign-ins into isolated test profiles.
const syncEnabled = () =>
  process.env['LIVO_E2E'] !== '1' || process.env['LIVO_BROWSER_COOKIES'] === '1'

/** Sync at startup, hourly, and when the user switches back to Livo. */
export function startBrowserCookieSync(): void {
  let lastRun = 0
  const run = () => {
    lastRun = Date.now()
    syncBrowserCookies().catch((error) =>
      console.warn('[browser-cookies] sync failed:', error),
    )
  }
  run()
  setInterval(run, SYNC_INTERVAL_MS).unref()
  app.on('browser-window-focus', () => {
    if (Date.now() - lastRun > FOCUS_SYNC_GAP_MS) run()
  })
}
