export type EntryContentLayout =
  | 'readability'
  | 'bilingual'
  | 'html'
  | 'audio-only'
  | 'detail-fallback'
  | 'empty'

export function getEntryContentLayout({
  isReadabilityMode,
  hasReadableContent,
  hasArticleContent,
  showTranslation,
  hasAudio,
  showEntryDetailFallback,
}: {
  isReadabilityMode: boolean
  hasReadableContent: boolean
  hasArticleContent: boolean
  showTranslation: boolean
  hasAudio: boolean
  showEntryDetailFallback: boolean
}): EntryContentLayout {
  // Translation follows the displayed source (see EntryContent paragraphs), so
  // it may sit on top of readability content too.
  if (isReadabilityMode && hasReadableContent) {
    return showTranslation ? 'bilingual' : 'readability'
  }
  if (hasArticleContent) return showTranslation ? 'bilingual' : 'html'
  if (hasAudio) return 'audio-only'
  if (showEntryDetailFallback) return 'detail-fallback'
  return 'empty'
}
