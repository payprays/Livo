/**
 * Lightweight blurhash decoder — generates a CSS background from a blurhash string.
 * Blurhash utilities for image placeholder loading.
 */

const digitCharacters =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~'

function decode83(str: string): number {
  let value = 0
  for (const c of str) {
    const digit = digitCharacters.indexOf(c)
    value = value * 83 + digit
  }
  return value
}

/**
 * Get the average color from a blurhash string as a hex color.
 * Useful for simple background placeholders without full decoding.
 */
export function blurhashToAverageColor(blurhash: string): string {
  if (!blurhash || blurhash.length < 6) return '#e5e7eb'
  try {
    const value = decode83(blurhash.substring(2, 6))
    const r = value >> 16
    const g = (value >> 8) & 255
    const b = value & 255
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
  } catch {
    return '#e5e7eb'
  }
}
