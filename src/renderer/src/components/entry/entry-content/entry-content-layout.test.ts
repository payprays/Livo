import { describe, expect, it } from 'vitest'
import { getEntryContentLayout } from './entry-content-layout'

describe('getEntryContentLayout', () => {
  it('prioritizes readability content over feed content', () => {
    const base = {
      isReadabilityMode: true,
      hasReadableContent: true,
      hasArticleContent: true,
      hasAudio: false,
      showEntryDetailFallback: false,
    }

    expect(getEntryContentLayout({ ...base, showTranslation: false })).toBe(
      'readability',
    )
    // Translation of the readability text is shown bilingual, not hidden.
    expect(getEntryContentLayout({ ...base, showTranslation: true })).toBe(
      'bilingual',
    )
  })

  it('selects bilingual or plain html for normal article content', () => {
    const base = {
      isReadabilityMode: false,
      hasReadableContent: false,
      hasArticleContent: true,
      hasAudio: false,
      showEntryDetailFallback: false,
    }

    expect(getEntryContentLayout({ ...base, showTranslation: true })).toBe(
      'bilingual',
    )
    expect(getEntryContentLayout({ ...base, showTranslation: false })).toBe(
      'html',
    )
  })

  it('falls through to audio, detail fallback, then empty state', () => {
    const base = {
      isReadabilityMode: false,
      hasReadableContent: false,
      hasArticleContent: false,
      showTranslation: false,
    }

    expect(
      getEntryContentLayout({
        ...base,
        hasAudio: true,
        showEntryDetailFallback: true,
      }),
    ).toBe('audio-only')
    expect(
      getEntryContentLayout({
        ...base,
        hasAudio: false,
        showEntryDetailFallback: true,
      }),
    ).toBe('detail-fallback')
    expect(
      getEntryContentLayout({
        ...base,
        hasAudio: false,
        showEntryDetailFallback: false,
      }),
    ).toBe('empty')
  })
})
