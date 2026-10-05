/** Folders named in `order` come first, in that order; the rest keep their place after them. */
export function sortFolders<T>(
  entries: [string, T][],
  order: string[],
): [string, T][] {
  const rank = new Map(order.map((name, i) => [name, i]))
  const last = order.length
  return [...entries].sort(
    (a, b) => (rank.get(a[0]) ?? last) - (rank.get(b[0]) ?? last),
  )
}

/** Drops `folder` onto `target`: after it when dragged down, before it when dragged up. */
export function moveFolder(
  names: string[],
  folder: string,
  target: string,
): string[] {
  const from = names.indexOf(folder)
  const to = names.indexOf(target)
  if (from < 0 || to < 0 || from === to) return names
  const next = names.filter((name) => name !== folder)
  next.splice(to, 0, folder)
  return next
}
