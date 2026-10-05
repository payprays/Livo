/**
 * SettingsProvider — canonical owner of application settings state.
 *
 * Replaces the module-level `let cachedSettings` singleton in
 * settings-handlers.ts.  Callers use `provider.get()` for the current
 * snapshot and `provider.onChange(fn)` to react to updates instead of
 * capturing stale references.
 */
import { app, safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import type { AppSettings } from '../../../shared/types'
import {
  cloneDefaultSettings,
  mergeSettings,
  normalizeSettings,
} from '../../../shared/settings'
import {
  preserveRedactedSettingsSecrets,
  redactSettingsSecrets,
} from '../../../shared/settings-secrets'
import { getEventBus } from './event-bus'
import { applyProxySettings } from './proxy'

export type SettingsChangeListener = (settings: AppSettings) => void

const ENCRYPTED_SETTING_SECRET_PREFIX = 'safeStorage:'

// Ciphertexts this process could not decrypt, by field. They belong to another
// keyring key (a dev build opening the real profile, a locked keyring) and are
// written back untouched while the field stays empty, instead of being wiped.
// ponytail: clearing such a key in the same session restores it; set a new
// key instead.
const undecryptableSecrets = new Map<string, string>()

function cloneSettings(settings: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(settings)) as AppSettings
}

function canEncryptSettingsSecret(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encryptSettingsSecret(value: string, field: string): string {
  if (!value.trim()) return undecryptableSecrets.get(field) ?? ''
  if (!canEncryptSettingsSecret()) return ''
  try {
    return `${ENCRYPTED_SETTING_SECRET_PREFIX}${safeStorage
      .encryptString(value)
      .toString('base64')}`
  } catch {
    return ''
  }
}

function decryptSettingsSecret(
  value: unknown,
  field: string,
): {
  value: string
  shouldRewrite: boolean
} {
  if (typeof value !== 'string' || !value) {
    return { value: '', shouldRewrite: false }
  }

  if (!value.startsWith(ENCRYPTED_SETTING_SECRET_PREFIX)) {
    return { value, shouldRewrite: true }
  }

  try {
    const encrypted = value.slice(ENCRYPTED_SETTING_SECRET_PREFIX.length)
    return {
      value: safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
      shouldRewrite: false,
    }
  } catch {
    undecryptableSecrets.set(field, value)
    return { value: '', shouldRewrite: false }
  }
}

function shouldProtectProxyUrl(value: string): boolean {
  if (!value.trim()) return false
  try {
    const parsed = new URL(value)
    return !!parsed.username || !!parsed.password
  } catch {
    return /\/\/[^/?#\s]+@/.test(value)
  }
}

function isStoredSettingsSecret(value: string): boolean {
  return value.startsWith(ENCRYPTED_SETTING_SECRET_PREFIX)
}

function decodeStoredSettingsSecrets(raw: Partial<AppSettings>): boolean {
  let shouldRewrite = false
  if (
    raw.general?.proxyUrl &&
    (isStoredSettingsSecret(raw.general.proxyUrl) ||
      shouldProtectProxyUrl(raw.general.proxyUrl))
  ) {
    const proxyUrl = decryptSettingsSecret(
      raw.general.proxyUrl,
      'general.proxyUrl',
    )
    raw.general.proxyUrl = proxyUrl.value
    shouldRewrite ||= proxyUrl.shouldRewrite
  }

  if (raw.ai) {
    const apiKey = decryptSettingsSecret(raw.ai.apiKey, 'ai.apiKey')
    raw.ai.apiKey = apiKey.value
    shouldRewrite ||= apiKey.shouldRewrite

    if (raw.ai.apiKeys) {
      raw.ai.apiKeys = Object.fromEntries(
        Object.entries(raw.ai.apiKeys).map(([provider, value]) => {
          const decoded = decryptSettingsSecret(value, `ai.apiKeys.${provider}`)
          shouldRewrite ||= decoded.shouldRewrite
          return [provider, decoded.value]
        }),
      )
    }
  }

  if (raw.aggregator) {
    const apiKey = decryptSettingsSecret(
      raw.aggregator.apiKey,
      'aggregator.apiKey',
    )
    raw.aggregator.apiKey = apiKey.value
    shouldRewrite ||= apiKey.shouldRewrite

    const deviceId = decryptSettingsSecret(
      raw.aggregator.deviceId,
      'aggregator.deviceId',
    )
    raw.aggregator.deviceId = deviceId.value
    shouldRewrite ||= deviceId.shouldRewrite
  }

  return shouldRewrite
}

function encodeSettingsForDisk(settings: AppSettings): AppSettings {
  const stored = cloneSettings(settings)
  if (
    shouldProtectProxyUrl(stored.general.proxyUrl) ||
    !stored.general.proxyUrl
  ) {
    stored.general.proxyUrl = encryptSettingsSecret(
      stored.general.proxyUrl,
      'general.proxyUrl',
    )
  }
  stored.ai.apiKey = encryptSettingsSecret(stored.ai.apiKey, 'ai.apiKey')
  if (stored.ai.apiKeys) {
    stored.ai.apiKeys = Object.fromEntries(
      Object.entries(stored.ai.apiKeys).map(([provider, value]) => [
        provider,
        encryptSettingsSecret(value, `ai.apiKeys.${provider}`),
      ]),
    )
  }
  stored.aggregator.apiKey = encryptSettingsSecret(
    stored.aggregator.apiKey,
    'aggregator.apiKey',
  )
  stored.aggregator.deviceId = encryptSettingsSecret(
    stored.aggregator.deviceId,
    'aggregator.deviceId',
  )
  return stored
}

class SettingsProvider {
  private current: AppSettings | null = null

  private readonly listeners = new Set<SettingsChangeListener>()

  /** Return the canonical settings snapshot. Loads from disk on first call. */
  get(): AppSettings {
    if (!this.current) this.current = this.loadFromDisk()
    return this.current
  }

  /**
   * Apply a partial update, persist to disk, re-apply proxy config,
   * broadcast to renderer windows, and notify in-process listeners.
   */
  async update(partial: Partial<AppSettings>): Promise<AppSettings> {
    const current = this.get()
    this.current = mergeSettings(
      current,
      preserveRedactedSettingsSecrets(current, partial),
    )
    this.persist()
    await applyProxySettings(this.current)
    getEventBus().send('settings:changed', redactSettingsSecrets(this.current))
    this.notifyListeners()
    return this.current
  }

  /**
   * Register a listener that fires whenever settings change.
   * Returns an unsubscribe function.
   */
  onChange(listener: SettingsChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ---- internal ----

  private loadFromDisk(): AppSettings {
    const settingsPath = getSettingsPath()
    if (existsSync(settingsPath)) {
      try {
        const raw = readFileSync(settingsPath, 'utf-8')
        const parsed = JSON.parse(raw) as Partial<AppSettings>
        const shouldRewrite = decodeStoredSettingsSecrets(parsed)
        const settings = normalizeSettings(parsed)
        if (shouldRewrite) {
          this.current = settings
          this.persist()
        }
        return settings
      } catch {
        return cloneDefaultSettings()
      }
    }
    return cloneDefaultSettings()
  }

  private persist(): void {
    const settingsPath = getSettingsPath()
    const dir = join(settingsPath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify(encodeSettingsForDisk(this.current!), null, 2),
    )
  }

  private notifyListeners(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.current!)
      } catch {
        // Don't let a broken listener break the update chain.
      }
    }
  }
}

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'data', 'settings.json')
}

/** Singleton instance — created once in settings-handlers.ts. */
export const settingsProvider = new SettingsProvider()
