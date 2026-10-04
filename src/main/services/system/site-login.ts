import { BrowserWindow, session } from 'electron'
import { feedUserAgent } from '../feed/rss-parser'

// A function: `session.defaultSession` is only available once the app is ready.
const loginWebPreferences = () => ({
  session: session.defaultSession,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
})

/**
 * Opens a site in a plain browser window on the default session so the user
 * can sign in with whatever the site offers (password, passkey, OAuth).
 * Feed and full-text fetches go through `session.defaultSession.fetch`, which
 * sends the session cookies, so they see the logged-in pages afterwards.
 * Resolves once the window is closed.
 */
export function openSiteLoginWindow(
  url: string,
  parent?: BrowserWindow | null,
): Promise<{ success: boolean; error?: string }> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return Promise.resolve({ success: false, error: 'invalid_url' })
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return Promise.resolve({ success: false, error: 'invalid_url' })
  }

  const userAgent = feedUserAgent()
  const win = new BrowserWindow({
    width: 1000,
    height: 780,
    parent: parent ?? undefined,
    title: target.host,
    autoHideMenuBar: true,
    webPreferences: loginWebPreferences(),
  })
  win.webContents.setUserAgent(userAgent)
  // OAuth providers often sign in through a popup; keep it in the same session.
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      autoHideMenuBar: true,
      webPreferences: loginWebPreferences(),
    },
  }))
  win.webContents.on('did-create-window', (child) => {
    child.webContents.setUserAgent(userAgent)
  })
  void win.loadURL(target.toString(), { userAgent })

  return new Promise((resolve) => {
    win.on('closed', () => resolve({ success: true }))
  })
}
