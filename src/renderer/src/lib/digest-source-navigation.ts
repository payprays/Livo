import { ROUTES } from '../router/route-paths'

export type DigestSourceNavigationInput = {
  id: string
  status: 'available' | 'missing'
}

export function getDigestSourceEntryRoute(
  source: DigestSourceNavigationInput,
): string | null {
  return source.status === 'available' ? ROUTES.entry(source.id) : null
}

/**
 * The digest prompt asks the model to cite source entry ids in brackets. Raw
 * UUIDs are unreadable, so show them as [n], matching the numbered source list.
 */
export function numberDigestCitations(
  content: string,
  sourceIds: string[],
): string {
  return sourceIds.reduce(
    (text, id, index) => text.split(id).join(`[${index + 1}]`),
    content,
  )
}
