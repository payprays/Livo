import { describe, expect, it } from 'vitest'
import { moveFolder, sortFolders } from './folder-order'

describe('folder order', () => {
  it('drops a folder after a lower target and before a higher one', () => {
    expect(moveFolder(['A', 'B', 'C', 'D'], 'A', 'C')).toEqual([
      'B',
      'C',
      'A',
      'D',
    ])
    expect(moveFolder(['A', 'B', 'C', 'D'], 'D', 'B')).toEqual([
      'A',
      'D',
      'B',
      'C',
    ])
  })

  it('puts saved folders first and keeps new ones after them', () => {
    const entries: [string, number][] = [
      ['A', 1],
      ['New', 2],
      ['B', 3],
    ]
    expect(sortFolders(entries, ['B', 'A']).map(([name]) => name)).toEqual([
      'B',
      'A',
      'New',
    ])
  })
})
