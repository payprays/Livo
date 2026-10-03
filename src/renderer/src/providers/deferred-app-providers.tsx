import { AppCommandProvider } from './AppCommandProvider'
import { GlobalShortcutsProvider } from './GlobalShortcutsProvider'
import { OverlayStackProvider } from './OverlayStackProvider'
import { QueryVisibilityRefreshProvider } from './QueryVisibilityRefreshProvider'
import { UpdateCheckProvider } from './UpdateCheckProvider'

export function DeferredAppProviders() {
  return (
    <OverlayStackProvider>
      <AppCommandProvider>
        <GlobalShortcutsProvider>
          <QueryVisibilityRefreshProvider>
            <UpdateCheckProvider />
          </QueryVisibilityRefreshProvider>
        </GlobalShortcutsProvider>
      </AppCommandProvider>
    </OverlayStackProvider>
  )
}
