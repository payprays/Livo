interface ApplicationIdentityApi {
  readonly isPackaged: boolean
  getPath(name: 'userData'): string
  setName(name: string): void
  setPath(name: 'userData', path: string): void
}

const DEVELOPMENT_APP_NAME = 'Livo Dev'

/**
 * Keep the development Electron binary on a separate macOS Safe Storage
 * identity while preserving the existing development data directory.
 *
 * Packaged Livo builds and the generic Electron binary have different code
 * signatures. If both use `livo Safe Storage`, macOS asks for Keychain access
 * every time the development binary starts.
 */
export function configureAppIdentity(
  application: ApplicationIdentityApi,
  e2eUserDataPath?: string,
  platform: NodeJS.Platform = process.platform,
): { isDev: boolean } {
  const isDev = !application.isPackaged
  if (!isDev) return { isDev }

  if (platform === 'darwin') {
    const userDataPath = e2eUserDataPath || application.getPath('userData')
    application.setName(DEVELOPMENT_APP_NAME)
    application.setPath('userData', userDataPath)
  } else if (e2eUserDataPath) {
    application.setPath('userData', e2eUserDataPath)
  }

  return { isDev }
}

// Desktops Chromium already maps to a real keyring (kwallet / libsecret).
const KEYRING_AWARE_DESKTOP =
  /GNOME|KDE|Plasma|Cinnamon|Deepin|Pantheon|UKUI|Unity|XFCE/i

/**
 * Chromium picks the Linux Safe Storage backend from a hardcoded desktop list.
 * On anything else (niri, Hyprland, sway, …) it falls back to `basic_text`,
 * `safeStorage.isEncryptionAvailable()` turns false and API keys can't be
 * saved, even when a Secret Service (gnome-keyring, KWallet) is running.
 * For those desktops, ask for libsecret explicitly. Known desktops are left
 * alone so existing kwallet-encrypted secrets stay readable.
 */
export function shouldForceLibsecret(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'linux' || env['KDE_FULL_SESSION']) return false
  const desktop = `${env['XDG_CURRENT_DESKTOP'] ?? ''}:${env['DESKTOP_SESSION'] ?? ''}`
  return !KEYRING_AWARE_DESKTOP.test(desktop)
}
