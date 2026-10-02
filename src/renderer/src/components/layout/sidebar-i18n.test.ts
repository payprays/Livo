import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// i18nDefault(zh, en) / tWithDefault(key, zh, en) are the fallbacks shown when
// a locale key is missing. English in the zh slot leaks into the Chinese UI.
describe('Sidebar inline i18n fallbacks', () => {
  it('passes Chinese text as the zh argument', () => {
    const source = readFileSync(join(__dirname, 'Sidebar.tsx'), 'utf-8')
    const calls = [
      ...source.matchAll(/i18nDefault\(\s*'([^']*)'/g),
      ...source.matchAll(/tWithDefault\(\s*'[^']*',\s*'([^']*)'/g),
    ]
    expect(calls.length).toBeGreaterThan(0)
    const englishZh = calls
      .map((match) => match[1])
      .filter((zh) => !/[\u4e00-\u9fff]/.test(zh))
    expect(englishZh).toEqual([])
  })
})
