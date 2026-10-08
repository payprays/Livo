import { getDb } from '../../database'
import { htmlTextLength } from '../../../shared/html-text'
import { fetchReadableContent, resolveRelativeUrls } from './readability'

/** Fetch the page's readable text and store it on the entry (when given). */
export async function fetchAndPersistReadableContent(input: {
  url: string
  entryId?: string
}) {
  const result = await fetchReadableContent(input.url)
  const content = resolveRelativeUrls(result.content, input.url)
  // Keep the feed text when the page yields less (client-rendered pages,
  // verification walls); otherwise readability mode would show a blank page.
  const feedContent = input.entryId
    ? getDb().entries.getEntryById(input.entryId)?.content
    : undefined
  if (htmlTextLength(content) <= htmlTextLength(feedContent)) {
    throw new Error('原文页面没有比订阅内容更完整的正文')
  }

  if (input.entryId) {
    getDb().entries.updateEntry(input.entryId, {
      readabilityContent: content,
      readabilityTitle: result.title,
      readabilityExcerpt: result.excerpt,
      readabilitySiteName: result.siteName,
      readabilityLength: result.length,
      readabilityFetchedAt: Date.now(),
      readabilityError: undefined,
    })
  }

  return {
    success: true,
    title: result.title,
    content,
    excerpt: result.excerpt,
    siteName: result.siteName,
    length: result.length,
  }
}
