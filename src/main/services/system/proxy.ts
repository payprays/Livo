import { session } from 'electron'
import type { AppSettings } from '../../../shared/types/index'
import {
  buildElectronProxyConfig,
  getNormalizedProxyState,
  type NormalizedProxyState,
} from './proxy-policy'

export {
  buildElectronProxyConfig,
  getNormalizedProxyState,
  normalizeProxyUrl,
  type NormalizedProxyState,
} from './proxy-policy'

export async function applyProxySettings(
  settings: Pick<AppSettings, 'general'>,
): Promise<NormalizedProxyState> {
  const normalized = getNormalizedProxyState(settings.general)
  await session.defaultSession.setProxy(buildElectronProxyConfig(normalized))
  return normalized
}
