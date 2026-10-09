import { describe, expect, it, vi } from 'vitest'

vi.mock('../../database', () => ({ getDb: vi.fn() }))
vi.mock('../system/settings-provider', () => ({ settingsProvider: {} }))
vi.mock('./ai-pipeline', () => ({ generateAIDigest: vi.fn() }))

import { dueDigestPresets } from './digest-schedule'

// 2026-10-10 is a Saturday, 2026-10-11 a Sunday.
const at = (day: number, h: number, m = 0) =>
  new Date(2026, 9, day, h, m).getTime()

describe('dueDigestPresets', () => {
  it('runs the day digest once after its time, and the week digest on Sunday', () => {
    const none = () => undefined
    expect(dueDigestPresets('21:00', at(10, 20, 59), none)).toEqual([])
    expect(dueDigestPresets('21:00', at(10, 21, 0), none)).toEqual(['today'])
    expect(dueDigestPresets('21:00', at(11, 23, 0), none)).toEqual([
      'today',
      'week',
    ])
    // Done after today's slot: not again. Done earlier (by hand): run anyway.
    expect(dueDigestPresets('21:00', at(10, 22), () => at(10, 21, 5))).toEqual(
      [],
    )
    expect(dueDigestPresets('21:00', at(10, 22), () => at(10, 9))).toEqual([
      'today',
    ])
  })

  it('ignores a malformed time', () => {
    expect(dueDigestPresets('25:00', at(10, 23), () => undefined)).toEqual([])
  })
})
