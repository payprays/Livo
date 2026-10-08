import type {
  AIDigestPreset,
  AIDigestRun,
  EntryAISummarySession,
  EntryAITranslationSegment,
  EntryAITranslationSession,
  Entry,
  Feed,
  FeverAccount,
  FeverFeedMapping,
  FeverItemMapping,
  FeverSyncState,
  MediaItem,
} from '../../shared/types'
import { FeedViewType } from '../../shared/types'

export function feedFromRow(row: unknown): Feed {
  const r = row as {
    id: string
    title: string
    url: string
    site_url: string | null
    description: string | null
    image_url: string | null
    folder: string | null
    category: string | null
    view: number
    max_entries: number | null
    show_in_all: number
    last_fetched: number | null
    etag: string | null
    last_modified: string | null
    fetch_source: Feed['fetchSource'] | null
    upstream_url: string | null
    remote_feed_id: string | null
    provider: Feed['provider'] | null
    last_refresh_status: Feed['lastRefreshStatus'] | null
    last_refresh_attempted_at: number | null
    last_refresh_error: string | null
    last_refresh_raw_error: string | null
    error_count: number
    created_at: number
  }
  return {
    id: r.id,
    title: r.title,
    url: r.url,
    siteUrl: r.site_url || undefined,
    description: r.description || undefined,
    imageUrl: r.image_url || undefined,
    folder: r.folder || undefined,
    category: r.category || undefined,
    view: r.view as FeedViewType,
    maxEntries: r.max_entries ?? undefined,
    showInAll: r.show_in_all === 1,
    lastFetched: r.last_fetched ?? undefined,
    etag: r.etag || undefined,
    lastModified: r.last_modified || undefined,
    fetchSource: r.fetch_source || undefined,
    upstreamUrl: r.upstream_url || undefined,
    remoteFeedId: r.remote_feed_id || undefined,
    provider: r.provider || 'local',
    lastRefreshStatus: r.last_refresh_status || undefined,
    lastRefreshAttemptedAt: r.last_refresh_attempted_at ?? undefined,
    lastRefreshError: r.last_refresh_error || undefined,
    lastRefreshRawError: r.last_refresh_raw_error || undefined,
    errorCount: r.error_count,
    createdAt: r.created_at,
  }
}

export function entryAISummarySessionFromRow(
  row: unknown,
): EntryAISummarySession {
  const r = row as {
    id: string
    entry_id: string
    status: EntryAISummarySession['status']
    draft_text: string | null
    final_text: string | null
    error_code: string | null
    error_message: string | null
    raw_error_message: string | null
    model: string | null
    source_hash: string | null
    run_id: string | null
    created_at: number
    updated_at: number
    finished_at: number | null
  }
  return {
    id: r.id,
    entryId: r.entry_id,
    status: r.status,
    draftText: r.draft_text || '',
    finalText: r.final_text || undefined,
    errorCode: r.error_code || undefined,
    errorMessage: r.error_message || undefined,
    rawErrorMessage: r.raw_error_message || undefined,
    model: r.model || undefined,
    sourceHash: r.source_hash || undefined,
    runId: r.run_id || undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at ?? undefined,
  }
}

function parseTranslationSegments(value: unknown): EntryAITranslationSegment[] {
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const segment = item as Partial<EntryAITranslationSegment>
        const status =
          segment.status === 'running' ||
          segment.status === 'succeeded' ||
          segment.status === 'failed' ||
          segment.status === 'skipped'
            ? segment.status
            : 'queued'
        return {
          index: Number(segment.index) || 0,
          sourceText: String(segment.sourceText || ''),
          translatedText: String(segment.translatedText || ''),
          status,
          errorMessage: segment.errorMessage
            ? String(segment.errorMessage)
            : undefined,
        }
      })
  } catch {
    return []
  }
}

export function entryAITranslationSessionFromRow(
  row: unknown,
): EntryAITranslationSession {
  const r = row as {
    id: string
    entry_id: string
    target_language: string
    status: EntryAITranslationSession['status']
    segments_json: unknown
    error_code: string | null
    error_message: string | null
    model: string | null
    config_fingerprint: string | null
    run_id: string | null
    created_at: number
    updated_at: number
    finished_at: number | null
  }
  return {
    id: r.id,
    entryId: r.entry_id,
    targetLanguage: r.target_language,
    status: r.status,
    segments: parseTranslationSegments(r.segments_json),
    errorCode: r.error_code || undefined,
    errorMessage: r.error_message || undefined,
    model: r.model || undefined,
    configFingerprint: r.config_fingerprint || undefined,
    runId: r.run_id || undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at ?? undefined,
  }
}

export function entryFromRow(row: unknown): Entry {
  const r = row as {
    id: string
    feed_id: string
    title: string
    url: string
    content: string | null
    summary: string | null
    readability_content: string | null
    readability_title: string | null
    readability_excerpt: string | null
    readability_site_name: string | null
    readability_length: number | null
    readability_fetched_at: number | null
    readability_error: string | null
    ai_summary: string | null
    ai_summary_generated_at: number | null
    ai_summary_error: string | null
    notified_at: number | null
    author: string | null
    author_avatar: string | null
    image_url: string | null
    media: string | null
    published_at: number
    is_read: number
    is_starred: number
    read_progress: number | null
    is_listened: number
    listen_progress: number | null
    created_at: number
  }
  let media: MediaItem[] | undefined
  if (r.media) {
    try {
      media = JSON.parse(r.media)
    } catch {
      media = undefined
    }
  }
  return {
    id: r.id,
    feedId: r.feed_id,
    title: r.title,
    url: r.url,
    content: r.content || undefined,
    summary: r.summary || undefined,
    readabilityContent: r.readability_content || undefined,
    readabilityTitle: r.readability_title || undefined,
    readabilityExcerpt: r.readability_excerpt || undefined,
    readabilitySiteName: r.readability_site_name || undefined,
    readabilityLength: r.readability_length ?? undefined,
    readabilityFetchedAt: r.readability_fetched_at ?? undefined,
    readabilityError: r.readability_error || undefined,
    aiSummary: r.ai_summary || undefined,
    aiSummaryGeneratedAt: r.ai_summary_generated_at ?? undefined,
    aiSummaryError: r.ai_summary_error || undefined,
    notifiedAt: r.notified_at ?? undefined,
    author: r.author || undefined,
    authorAvatar: r.author_avatar || undefined,
    imageUrl: r.image_url || undefined,
    media,
    publishedAt: r.published_at,
    isRead: r.is_read === 1,
    isStarred: r.is_starred === 1,
    readProgress: r.read_progress ?? undefined,
    isListened: r.is_listened === 1,
    listenProgress: r.listen_progress ?? undefined,
    createdAt: r.created_at,
  }
}

export function digestRunFromRow(row: unknown): AIDigestRun {
  const r = row as {
    id: string
    preset: string
    feed_id: string | null
    folder: string | null
    title: string
    status: AIDigestRun['status']
    window_start_at: number
    window_end_at: number
    source_entry_ids: string | null
    candidate_count: number
    content: string | null
    error: string | null
    created_at: number
    updated_at: number
  }
  let sourceEntryIds: string[] = []
  if (r.source_entry_ids) {
    try {
      sourceEntryIds = JSON.parse(r.source_entry_ids)
    } catch {
      sourceEntryIds = []
    }
  }
  return {
    id: r.id,
    preset: r.preset as AIDigestPreset,
    feedId: r.feed_id || undefined,
    folder: r.folder || undefined,
    title: r.title,
    status: r.status,
    windowStartAt: r.window_start_at,
    windowEndAt: r.window_end_at,
    sourceEntryIds,
    candidateCount: r.candidate_count,
    content: r.content || undefined,
    error: r.error || undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function feverAccountFromRow(row: unknown): FeverAccount {
  const r = row as {
    id: string
    base_url: string
    username: string
    api_key: string
    enabled: number
    auto_sync: number
    sync_interval_min: number
    last_sync_at: number | null
    last_error: string | null
    created_at: number
  }
  return {
    id: r.id,
    baseUrl: r.base_url,
    username: r.username,
    apiKey: r.api_key,
    enabled: r.enabled === 1,
    autoSync: r.auto_sync === 1,
    syncIntervalMin: r.sync_interval_min,
    lastSyncAt: r.last_sync_at ?? undefined,
    lastError: r.last_error || undefined,
    createdAt: r.created_at,
  }
}

export function feverFeedMappingFromRow(row: unknown): FeverFeedMapping {
  const r = row as {
    account_id: string
    fever_feed_id: number
    local_feed_id: string
    remote_group: string | null
    remote_title: string | null
    remote_url: string | null
    is_active: number
    last_seen_at: number
  }
  return {
    accountId: r.account_id,
    feverFeedId: r.fever_feed_id,
    localFeedId: r.local_feed_id,
    remoteGroup: r.remote_group || undefined,
    remoteTitle: r.remote_title || undefined,
    remoteUrl: r.remote_url || undefined,
    isActive: r.is_active === 1,
    lastSeenAt: r.last_seen_at,
  }
}

export function feverItemMappingFromRow(row: unknown): FeverItemMapping {
  const r = row as {
    account_id: string
    fever_item_id: number
    fever_feed_id: number
    local_feed_id: string
    local_entry_id: string
    remote_is_read: number
    remote_is_starred: number
    is_active: number
    last_seen_at: number
  }
  return {
    accountId: r.account_id,
    feverItemId: r.fever_item_id,
    feverFeedId: r.fever_feed_id,
    localFeedId: r.local_feed_id,
    localEntryId: r.local_entry_id,
    remoteIsRead: r.remote_is_read === 1,
    remoteIsStarred: r.remote_is_starred === 1,
    isActive: r.is_active === 1,
    lastSeenAt: r.last_seen_at,
  }
}

export function feverSyncStateFromRow(row: unknown): FeverSyncState {
  const r = row as {
    account_id: string
    last_item_id: number
    last_sync_at: number | null
    last_full_sync_at: number | null
    last_error: string | null
  }
  return {
    accountId: r.account_id,
    lastItemId: r.last_item_id,
    lastSyncAt: r.last_sync_at ?? undefined,
    lastFullSyncAt: r.last_full_sync_at ?? undefined,
    lastError: r.last_error || undefined,
  }
}
