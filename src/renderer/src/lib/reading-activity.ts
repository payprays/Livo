const STORAGE_KEY = 'livo.reading.activity.v1'
const MAX_DAYS = 400

export type ReadingActivity = Record<string, number>

export function toDayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function getReadingActivity(): ReadingActivity {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const result: ReadingActivity = {}
    for (const [key, value] of Object.entries(parsed as ReadingActivity)) {
      const count = Number(value)
      if (
        /^\d{4}-\d{2}-\d{2}$/.test(key) &&
        Number.isFinite(count) &&
        count > 0
      ) {
        result[key] = Math.floor(count)
      }
    }
    return result
  } catch {
    return {}
  }
}

function pruneOldDays(activity: ReadingActivity): ReadingActivity {
  const keys = Object.keys(activity)
  if (keys.length <= MAX_DAYS) return activity
  const kept = keys.sort().slice(keys.length - MAX_DAYS)
  const result: ReadingActivity = {}
  for (const key of kept) result[key] = activity[key]
  return result
}

export function recordReadActivity(count = 1): void {
  if (count <= 0) return
  try {
    const activity = getReadingActivity()
    const key = toDayKey(new Date())
    activity[key] = (activity[key] ?? 0) + count
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pruneOldDays(activity)))
    window.dispatchEvent(new CustomEvent('reading-activity-updated'))
  } catch {
    // Ignore storage write errors.
  }
}
