import type Database from 'better-sqlite3'
import type {
  AIDigestCandidate,
  AIDigestPreset,
  AIDigestRun,
} from '../../../shared/types'
import { digestRunFromRow } from '../row-mappers'

export interface IDigestRepository {
  getDigestWindow(
    preset: AIDigestPreset,
    now?: number,
  ): { windowStartAt: number; windowEndAt: number }
  listDigestCandidates(options: DigestCandidateOptions): AIDigestCandidate[]
  listAIDigestRuns(limit?: number): AIDigestRun[]
  upsertAIDigestRun(
    input: Omit<AIDigestRun, 'id' | 'createdAt' | 'updatedAt'>,
  ): AIDigestRun
  updateAIDigestRun(
    id: string,
    updates: Partial<Omit<AIDigestRun, 'id' | 'createdAt'>>,
  ): AIDigestRun | null
}

export interface DigestCandidateOptions {
  preset: AIDigestPreset
  feedId?: string
  /** Sidebar folder (feed category). */
  folder?: string
  limit?: number
  now?: number
}

export class DigestRepository implements IDigestRepository {
  constructor(private readonly db: Database.Database) {}

  getDigestWindow(
    preset: AIDigestPreset,
    now = Date.now(),
  ): { windowStartAt: number; windowEndAt: number } {
    const date = new Date(now)
    const start = new Date(date)
    start.setHours(0, 0, 0, 0)
    if (preset === 'week') {
      const day = start.getDay()
      const diffToMonday = (day + 6) % 7
      start.setDate(start.getDate() - diffToMonday)
    }
    return { windowStartAt: start.getTime(), windowEndAt: now }
  }

  listDigestCandidates(options: DigestCandidateOptions): AIDigestCandidate[] {
    const { windowStartAt, windowEndAt } = this.getDigestWindow(
      options.preset,
      options.now,
    )
    const limit = Math.max(1, Math.min(options.limit ?? 300, 500))

    let where = `e.published_at >= ? AND e.published_at <= ?
        AND f.show_in_all = 1`
    const params: unknown[] = [windowStartAt, windowEndAt]
    if (options.feedId) {
      where += ' AND e.feed_id = ?'
      params.push(options.feedId)
    } else if (options.folder) {
      where += ' AND f.category = ?'
      params.push(options.folder)
    } else {
      // The whole-library digest reads articles and posts, not pictures or videos.
      where += ' AND f.view IN (0, 1)'
    }

    // Each feed's newest entry first, then each feed's second newest, and so
    // on, so a few busy forums cannot fill every slot.
    const sql = `
      SELECT e.id, e.title, e.summary, e.content, e.readability_content,
             e.ai_summary, e.url, e.published_at, f.title as feed_title,
             ROW_NUMBER() OVER (
               PARTITION BY e.feed_id ORDER BY e.published_at DESC
             ) AS feed_rank
      FROM entries e
      INNER JOIN feeds f ON f.id = e.feed_id
      WHERE ${where}
      ORDER BY feed_rank, e.published_at DESC
      LIMIT ?
    `
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string
      title: string | null
      summary: string | null
      content: string | null
      readability_content: string | null
      ai_summary: string | null
      url: string
      published_at: number
      feed_title: string
    }>

    const stripText = (value: string | null | undefined): string =>
      (value || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

    const candidates: AIDigestCandidate[] = []
    for (const row of rows) {
      const content = stripText(
        row.readability_content || row.content || row.summary,
      )
      const summary = stripText(row.ai_summary || row.summary)
      if (!row.title && !content && !summary) continue
      candidates.push({
        id: row.id,
        title: row.title || summary.slice(0, 80) || content.slice(0, 80),
        summary,
        content,
        feedTitle: row.feed_title,
        url: row.url,
        publishedAt: row.published_at,
      })
    }
    return candidates
  }

  listAIDigestRuns(limit = 20): AIDigestRun[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM ai_digest_runs
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `,
      )
      .all(Math.max(1, Math.min(limit, 100)))
    return rows.map(digestRunFromRow)
  }

  upsertAIDigestRun(
    input: Omit<AIDigestRun, 'id' | 'createdAt' | 'updatedAt'>,
  ): AIDigestRun {
    const now = Date.now()
    const existing = this.db
      .prepare(
        `
      SELECT * FROM ai_digest_runs
      WHERE preset = ? AND feed_id IS ? AND folder IS ? AND window_start_at = ?
    `,
      )
      .get(
        input.preset,
        input.feedId ?? null,
        input.folder ?? null,
        input.windowStartAt,
      ) as { id: string } | undefined

    if (existing) {
      this.db
        .prepare(
          `
        UPDATE ai_digest_runs SET
          title = ?, status = ?, window_end_at = ?,
          source_entry_ids = ?, candidate_count = ?,
          content = ?, error = ?, updated_at = ?
        WHERE id = ?
      `,
        )
        .run(
          input.title,
          input.status,
          input.windowEndAt,
          JSON.stringify(input.sourceEntryIds),
          input.candidateCount,
          input.content ?? null,
          input.error ?? null,
          now,
          existing.id,
        )
      return digestRunFromRow(
        this.db
          .prepare('SELECT * FROM ai_digest_runs WHERE id = ?')
          .get(existing.id),
      )
    }

    const id = `digest-${now}-${Math.random().toString(36).slice(2, 8)}`
    this.db
      .prepare(
        `
      INSERT INTO ai_digest_runs
        (id, preset, feed_id, folder, title, status, window_start_at, window_end_at,
         source_entry_ids, candidate_count, content, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.preset,
        input.feedId ?? null,
        input.folder ?? null,
        input.title,
        input.status,
        input.windowStartAt,
        input.windowEndAt,
        JSON.stringify(input.sourceEntryIds),
        input.candidateCount,
        input.content ?? null,
        input.error ?? null,
        now,
        now,
      )
    return digestRunFromRow(
      this.db.prepare('SELECT * FROM ai_digest_runs WHERE id = ?').get(id),
    )
  }

  updateAIDigestRun(
    id: string,
    updates: Partial<Omit<AIDigestRun, 'id' | 'createdAt'>>,
  ): AIDigestRun | null {
    const existing = this.db
      .prepare('SELECT * FROM ai_digest_runs WHERE id = ?')
      .get(id)
    if (!existing) return null

    const merged = {
      ...digestRunFromRow(existing),
      ...updates,
      updatedAt: Date.now(),
    }
    this.db
      .prepare(
        `
      UPDATE ai_digest_runs SET
        preset = ?, feed_id = ?, title = ?, status = ?,
        window_start_at = ?, window_end_at = ?,
        source_entry_ids = ?, candidate_count = ?,
        content = ?, error = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        merged.preset,
        merged.feedId ?? null,
        merged.title,
        merged.status,
        merged.windowStartAt,
        merged.windowEndAt,
        JSON.stringify(merged.sourceEntryIds),
        merged.candidateCount,
        merged.content ?? null,
        merged.error ?? null,
        merged.updatedAt,
        id,
      )
    return digestRunFromRow(
      this.db.prepare('SELECT * FROM ai_digest_runs WHERE id = ?').get(id),
    )
  }
}
