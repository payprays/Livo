/**
 * Data hydration layer - loads data from backend into memory store before React renders.
 * This avoids blocking the UI with serial IPC calls during bootstrap.
 */

import { useSettingsStore } from '../store/settings-store'
import { serializeFeedsForCache, useFeedStore } from '../store/feed-store'
import { useActionsStore } from '../store/actions-store'
import { useEntryStore } from '../store/entry-store'
import { writeDefaultHomeSnapshotCache } from '../lib/reader-snapshot-cache'
import {
  buildListCacheKey,
  cacheEntrySnapshots,
  setCachedListResult,
} from '../lib/entry-cache'
import type {
  ActionRule,
  AppHydratePayload,
  AppSettings,
  FeedWithCount,
} from '../../../shared/types'

const DEFAULT_INITIAL_SNAPSHOT_LIMIT = 20

function logStartupTiming(label: string, startTime: number): number {
  const duration = performance.now() - startTime
  console.log(`[Startup] ${label} ${duration.toFixed(0)}ms`)
  return duration
}

/**
 * Hydrate stores from localStorage cache immediately (synchronous).
 * This gives the UI instant data to render while IPC loads fresh data.
 */
export function hydrateFromLocalCache(): void {
  const startTime = performance.now()

  useSettingsStore.getState().hydrateFromCache()
  useFeedStore.getState().hydrateFromCache()

  logStartupTiming('hydrate.localCache', startTime)
}

export interface HydrateResult {
  settings: AppSettings | null
  feeds: FeedWithCount[]
  rules: ActionRule[]
  initialSnapshot: AppHydratePayload['initialSnapshot']
  timings: {
    settings: number
    feeds: number
    rules: number
    total: number
  }
}

/**
 * Load all critical application data from backend and write to stores.
 * This runs in the background after the shell renders with cached data.
 */
export async function hydrateDataToMemory(): Promise<HydrateResult> {
  const startTime = performance.now()
  const timings = {
    settings: 0,
    feeds: 0,
    rules: 0,
    total: 0,
  }

  let settings: AppSettings | null = null
  let feeds: FeedWithCount[] = []
  let initialSnapshot: AppHydratePayload['initialSnapshot'] = null

  try {
    const batchStart = performance.now()
    const batch = await window.api.app.hydrate()
    const batchDuration = logStartupTiming('hydrate.batch', batchStart)

    settings = batch.settings
    feeds = batch.feeds
    initialSnapshot = batch.initialSnapshot ?? null
    timings.settings = batchDuration
    timings.feeds = batchDuration
  } catch {
    console.warn(
      '[Hydrate] Batch hydration failed, falling back to individual calls',
    )
    const [settingsResult, feedsResult] = await Promise.allSettled([
      window.api.settings.get(),
      window.api.feeds.list(),
    ])
    settings =
      settingsResult.status === 'fulfilled' ? settingsResult.value : null
    feeds = feedsResult.status === 'fulfilled' ? feedsResult.value : []
  }

  const rules: ActionRule[] = []
  timings.rules = 0

  if (settings) {
    useSettingsStore.setState({ settings, isLoaded: true })
  }

  if (feeds !== null && feeds !== undefined) {
    // Always update feeds from IPC, even if empty array.
    // This ensures the store reflects the true backend state.
    useFeedStore.setState({ feeds, isLoading: false })
    // Save to localStorage cache for next startup
    try {
      localStorage.setItem('livo-feeds-cache', serializeFeedsForCache(feeds))
    } catch {
      /* ignore quota errors */
    }
  }

  if (initialSnapshot) {
    applyInitialSnapshot(initialSnapshot)
  }

  useActionsStore.getState().loadRules()

  timings.total = performance.now() - startTime

  console.log('[Hydrate] Data hydration complete:', {
    settings: !!settings,
    feedCount: feeds.length,
    ruleCount: rules.length,
    timings,
  })

  return {
    settings,
    feeds,
    rules,
    initialSnapshot,
    timings,
  }
}

function applyInitialSnapshot(
  initialSnapshot: NonNullable<AppHydratePayload['initialSnapshot']>,
): void {
  const pageSize =
    initialSnapshot.entries.length || DEFAULT_INITIAL_SNAPSHOT_LIMIT
  writeDefaultHomeSnapshotCache(
    {
      scope: { type: 'all' },
      limit: pageSize,
      compact: true,
      maxContentLength: 520,
    },
    initialSnapshot,
  )
  setCachedListResult(buildListCacheKey({}), {
    entries: initialSnapshot.entries,
    hasMore: initialSnapshot.nextCursor !== null,
  })
  useEntryStore.setState((state) =>
    state.entries.length > 0
      ? state
      : {
          entries: cacheEntrySnapshots(initialSnapshot.entries),
          isLoading: false,
          isLoadingMore: false,
          hasMoreEntries: initialSnapshot.nextCursor !== null,
          paginationSource: 'snapshot',
          paginationQueryKey: JSON.stringify({
            snapshot: true,
            feedId: '',
            feedIds: [],
            starred: false,
            unreadOnly: false,
            pageSize,
          }),
          paginationOptions: {
            feedId: undefined,
            feedIds: undefined,
            starred: undefined,
            unreadOnly: undefined,
          },
          paginationPageSize: pageSize,
          snapshotNextCursor: initialSnapshot.nextCursor,
        },
  )
}
