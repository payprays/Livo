import type { AppSettings } from '../../../shared/types/index'

const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks5:'])
const DEFAULT_PROXY_BYPASS_RULES = '<local>'

type ProxyMode = AppSettings['general']['proxyMode']

export interface NormalizedProxyState {
  mode: ProxyMode
  proxyUrl: string
}

export function normalizeProxyUrl(input: string | undefined): string {
  const raw = (input || '').trim()
  if (!raw) return ''

  const firstInput = raw.split(',')[0]?.trim() || ''
  if (!firstInput) return ''

  try {
    const parsed = new URL(firstInput)
    if (!PROXY_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) return ''
    const port = parsed.port ? `:${parsed.port}` : ''
    return `${parsed.protocol}//${parsed.hostname}${port}`
  } catch {
    return ''
  }
}

export function getNormalizedProxyState(
  general: Pick<AppSettings['general'], 'proxyMode' | 'proxyUrl'>,
): NormalizedProxyState {
  const mode = general.proxyMode === 'custom' ? 'custom' : 'system'
  const proxyUrl = mode === 'custom' ? normalizeProxyUrl(general.proxyUrl) : ''
  if (mode === 'custom' && proxyUrl) {
    return { mode, proxyUrl }
  }
  return { mode: 'system', proxyUrl: '' }
}

export function buildElectronProxyConfig(state: NormalizedProxyState): {
  mode?: 'system'
  proxyRules?: string
  proxyBypassRules?: string
} {
  if (state.mode !== 'custom' || !state.proxyUrl) {
    return { mode: 'system' }
  }

  return {
    proxyRules: `${state.proxyUrl},direct://`,
    proxyBypassRules: DEFAULT_PROXY_BYPASS_RULES,
  }
}
