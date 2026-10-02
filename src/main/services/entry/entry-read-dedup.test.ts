import { describe, expect, it } from 'vitest'
import type { Entry } from '../../../shared/types'
import { dedupeEntriesForRead, getEntryReadDedupKey } from './entry-read-dedup'

function createEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'entry-1',
    feedId: 'feed-1',
    title: 'Example',
    url: 'https://example.com/post',
    content: '',
    summary: '',
    publishedAt: Date.now(),
    isRead: false,
    isStarred: false,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('entry read dedup', () => {
  it('prefers richer entries when deduping for read', () => {
    const now = Date.now()
    const entries = [
      createEntry({
        id: 'a',
        url: 'https://www.instagram.com/p/ABC123/',
        content: 'short',
        publishedAt: now,
      }),
      createEntry({
        id: 'b',
        url: 'https://picnob.com/post/ABC123/',
        content: 'much longer content',
        publishedAt: now + 1_000,
      }),
    ]

    const result = dedupeEntriesForRead(entries, () => {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('much longer content')
  })

  it('dedupes near-identical content across feeds for read display', () => {
    const now = Date.now()
    const articleContent =
      'Local-first RSS apps keep articles on the device, make reading reliable offline, reduce server lock-in, and still allow optional sync when a user needs multiple devices. This helps readers search archives quickly and avoid losing saved articles.'
    const entries = [
      createEntry({
        id: 'a',
        feedId: 'feed-a',
        title: 'Why local RSS matters',
        url: 'https://example.com/local-rss',
        content: articleContent,
        isRead: true,
        publishedAt: now,
      }),
      createEntry({
        id: 'b',
        feedId: 'feed-b',
        title: 'Local readers and offline reliability',
        url: 'https://mirror.example.net/offline-reader',
        content: articleContent,
        isStarred: true,
        publishedAt: now + 60_000,
      }),
    ]

    const result = dedupeEntriesForRead(entries, () => {})

    expect(result).toHaveLength(1)
    expect(result[0].isRead).toBe(false)
    expect(result[0].isStarred).toBe(true)
  })

  it('keeps templated posts of the same feed apart when titles differ', () => {
    const now = Date.now()
    // Same boilerplate body; only the title tells the issues apart.
    const body =
      'Welcome to the weekly cloud security digest. This week we cover new IAM features, detection rules, threat research, open source tooling, conference talks and the usual roundup of links from around the community.'
    const entries = [167, 179].map((issue, index) =>
      createEntry({
        id: `issue-${issue}`,
        title: `AWS Security Digest Issue ${issue}`,
        url: `https://example.com/issues/${issue}`,
        content: body,
        publishedAt: now + index * 60_000,
      }),
    )

    const result = dedupeEntriesForRead(entries, () => {})

    expect(result.map((entry) => entry.id).sort()).toEqual([
      'issue-167',
      'issue-179',
    ])
  })

  it('keeps read dedupe keys aligned with canonical urls', () => {
    const direct = getEntryReadDedupKey(
      createEntry({
        url: 'https://www.instagram.com/p/ABC123/',
      }),
    )
    const mirrored = getEntryReadDedupKey(
      createEntry({
        url: 'https://picnob.com/post/ABC123/',
      }),
    )

    expect(direct).toBe(mirrored)
  })
})

describe('entry read dedup for date-only feeds', () => {
  it('keeps posts that share a midnight timestamp apart', () => {
    const midnight = Date.UTC(2026, 8, 30)
    const entries = ['first', 'second', 'third'].map((slug) =>
      createEntry({
        id: slug,
        title: `Post ${slug}`,
        url: `https://blog.example.com/${slug}/`,
        content: `Body of the ${slug} post with its own words.`,
        media: [
          { url: `https://blog.example.com/${slug}-a.png`, type: 'photo' },
          { url: `https://blog.example.com/${slug}-b.png`, type: 'photo' },
        ],
        publishedAt: midnight,
      }),
    )

    const result = dedupeEntriesForRead(entries, () => {})

    expect(result).toHaveLength(3)
  })
})
