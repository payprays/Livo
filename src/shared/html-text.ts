/** Length of the visible text in an HTML fragment (tags, entities and whitespace removed). */
export function htmlTextLength(html: string | undefined | null): number {
  return (html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&[#\w]+;/g, ' ')
    .replace(/\s+/g, '').length
}
