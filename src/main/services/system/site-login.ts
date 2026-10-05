import { app, shell } from 'electron'
import { syncBrowserCookies } from './browser-cookies'

/**
 * Opens a site in the user's browser to sign in there. Livo copies that
 * browser's cookies (see browser-cookies.ts), so once the user switches back
 * the feed and full-text fetches see the signed-in pages.
 * Resolves after the user has left Livo and come back, with cookies synced.
 */
export async function openSiteLogin(
  url: string,
): Promise<{ success: boolean; error?: string }> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return { success: false, error: 'invalid_url' }
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { success: false, error: 'invalid_url' }
  }

  // Listen before opening: the browser may take focus right away.
  const cameBack = new Promise<void>((resolve) =>
    app.once('browser-window-blur', () =>
      app.once('browser-window-focus', () => resolve()),
    ),
  )
  await shell.openExternal(target.toString())
  await cameBack
  await syncBrowserCookies()
  return { success: true }
}
