import type { AIDigestPreset } from '../../../shared/types'
import { getDb } from '../../database'
import { logWarn } from '../system/logger'
import { settingsProvider } from '../system/settings-provider'
import { generateAIDigest } from './ai-pipeline'

const CHECK_INTERVAL_MS = 60_000
const RECOMMENDED_CATEGORY = 'Recommended'

/**
 * Presets whose scheduled digest is due: the day digest every day, plus the
 * week digest on Sunday, once `time` (HH:MM) has passed and the whole-library
 * run for that window was not updated since. `lastDone` returns that run's
 * updatedAt.
 */
export function dueDigestPresets(
  time: string,
  now: number,
  lastDone: (preset: AIDigestPreset) => number | undefined,
): AIDigestPreset[] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return []
  const slot = new Date(now).setHours(Number(match[1]), Number(match[2]), 0, 0)
  if (now < slot) return []
  const presets: AIDigestPreset[] =
    new Date(now).getDay() === 0 ? ['today', 'week'] : ['today']
  return presets.filter((preset) => (lastDone(preset) ?? 0) < slot)
}

function lastWholeLibraryRun(preset: AIDigestPreset, now: number) {
  const db = getDb()
  const { windowStartAt } = db.digests.getDigestWindow(preset, now)
  return db.digests
    .listAIDigestRuns(100)
    .find(
      (run) =>
        run.preset === preset &&
        !run.folder &&
        !run.feedId &&
        run.windowStartAt === windowStartAt,
    )?.updatedAt
}

function digestFolders(): string[] {
  const names = new Set<string>()
  for (const feed of getDb().feeds.getAllFeeds()) {
    const name = feed.category?.trim()
    if (name && name !== RECOMMENDED_CATEGORY && feed.showInAll) names.add(name)
  }
  return [...names]
}

let running = false

// One digest per folder that has entries, then the whole-library one; that
// last run marks the slot done, so a crash midway retries on the next check.
// ponytail: a slot missed while Livo was closed runs on the same day only;
// the day window is always midnight to now.
async function runDueDigests(): Promise<void> {
  if (running || !settingsProvider.get().summary.digestSchedule) return
  const now = Date.now()
  const presets = dueDigestPresets(
    settingsProvider.get().summary.digestTime,
    now,
    (preset) => lastWholeLibraryRun(preset, now),
  )
  if (presets.length === 0) return
  running = true
  try {
    for (const preset of presets) {
      for (const folder of digestFolders()) {
        const hasEntries =
          getDb().digests.listDigestCandidates({ preset, folder, limit: 1 })
            .length > 0
        if (hasEntries) await generateAIDigest({ preset, folder })
      }
      await generateAIDigest({ preset })
    }
  } catch (error) {
    logWarn('[digest-schedule] scheduled digest failed', error)
  } finally {
    running = false
  }
}

export function startDigestSchedule(): void {
  setInterval(() => void runDueDigests(), CHECK_INTERVAL_MS).unref()
  // Turning the schedule on (or moving its time) past today's slot runs it now.
  settingsProvider.onChange(() => void runDueDigests())
  void runDueDigests()
}
