/**
 * IPC handlers for video URL resolution.
 *
 * - VIDEO_RESOLVE: Invidious/Piped proxy -> direct .mp4 URLs
 * - VIDEO_YT_STATUS: Legacy compatibility stub; account linking was removed.
 */
import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/types'
import { classifyExternalUrl } from '../../shared/url-policy'
import { registerChannel } from '../ipc/register-channel'
import { toHandlerError } from '../ipc/handler-error'
import { classifyNetworkFetchUrl } from '../services/system/network-url-policy'
import { resolveVideoUrl } from '../services/video/video-proxy'

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

type VideoWindowUrlValidation =
  | {
      allowed: true
      url: string
      origin: string
    }
  | {
      allowed: false
      error: string
    }

async function validateVideoWindowUrl(
  url: string,
): Promise<VideoWindowUrlValidation> {
  const policy = classifyExternalUrl(url)
  if (policy.blocked) {
    return { allowed: false, error: policy.blockedReason || 'blocked_url' }
  }
  if (policy.suspicious) {
    return { allowed: false, error: 'suspicious_url' }
  }

  const networkPolicy = await classifyNetworkFetchUrl(policy.url)
  if (!networkPolicy.allowed) {
    return {
      allowed: false,
      error: networkPolicy.blockedReason || 'blocked_url',
    }
  }

  try {
    return {
      allowed: true,
      url: policy.url,
      origin: new URL(policy.url).origin,
    }
  } catch {
    return { allowed: false, error: 'malformed' }
  }
}

async function validateAndLoadVideoNavigation(
  videoWin: BrowserWindow,
  initialOrigin: string,
  nextUrl: string,
  approveNavigation: (url: string) => void,
): Promise<void> {
  const navigationUrl = await validateVideoWindowUrl(nextUrl)
  if (!navigationUrl.allowed || navigationUrl.origin !== initialOrigin) {
    return
  }

  approveNavigation(navigationUrl.url)
  await videoWin.loadURL(navigationUrl.url)
}

export function registerVideoHandlers(): void {
  // 鈹€鈹€ Invidious/Piped video resolution 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  registerChannel(IPC.VIDEO_RESOLVE, async (_event, url: string) => {
    return resolveVideoUrl(url)
  })

  registerChannel(IPC.VIDEO_OPEN_IN_APP, async (_event, url: string) => {
    try {
      const initialUrl = await validateVideoWindowUrl(url)
      if (!initialUrl.allowed) {
        return { success: false, error: initialUrl.error }
      }
      let approvedNavigationUrl: string | null = initialUrl.url

      const videoWin = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      })
      videoWin.webContents.setUserAgent(DESKTOP_UA)
      videoWin.webContents.setWindowOpenHandler(() => {
        return { action: 'deny' }
      })
      const handleNavigation = (
        event: { preventDefault: () => void },
        nextUrl: string,
      ): void => {
        if (nextUrl === approvedNavigationUrl) {
          approvedNavigationUrl = null
          return
        }
        event.preventDefault()
        void validateAndLoadVideoNavigation(
          videoWin,
          initialUrl.origin,
          nextUrl,
          (approvedUrl) => {
            approvedNavigationUrl = approvedUrl
          },
        )
      }
      videoWin.webContents.on('will-navigate', handleNavigation)
      videoWin.webContents.on('will-redirect', handleNavigation)

      await videoWin.loadURL(initialUrl.url)
      return { success: true }
    } catch (err) {
      return toHandlerError(err)
    }
  })

  // Legacy YouTube account status: account linking was removed, never linked.
  registerChannel(IPC.VIDEO_YT_STATUS, async () => ({
    loggedIn: false,
    name: null,
  }))
}
