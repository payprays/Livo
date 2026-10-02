import { describe, expect, it } from 'vitest'
import {
  getDigestSourceEntryRoute,
  numberDigestCitations,
} from './digest-source-navigation'

describe('getDigestSourceEntryRoute', () => {
  it('returns encoded entry route for available digest sources', () => {
    expect(
      getDigestSourceEntryRoute({
        id: 'feed/entry 1',
        status: 'available',
      }),
    ).toBe('/entry/feed%2Fentry%201')
  })

  it('does not navigate to missing digest sources', () => {
    expect(
      getDigestSourceEntryRoute({
        id: 'missing-entry',
        status: 'missing',
      }),
    ).toBeNull()
  })
})

describe('numberDigestCitations', () => {
  it('replaces cited source ids with their 1-based list number', () => {
    expect(
      numberDigestCitations('趋势 A（aa-1、bb-2）。趋势 B（bb-2）', [
        'aa-1',
        'bb-2',
      ]),
    ).toBe('趋势 A（[1]、[2]）。趋势 B（[2]）')
  })
})
