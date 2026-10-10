import { describe, expect, it } from 'vitest'
import { placeParagraph } from './useAITranslation'

describe('placeParagraph', () => {
  it('fills the gap when a later paragraph arrives first', () => {
    const list = placeParagraph([], 2, 'third')
    expect(list).toEqual(['', '', 'third'])
    // The reader checks every entry's length.
    expect(list.every((text) => typeof text === 'string')).toBe(true)
    expect(placeParagraph(list, 0, 'first')).toEqual(['first', '', 'third'])
  })
})
