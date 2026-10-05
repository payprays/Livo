/**
 * Shared video URL parsing + stream-selection helpers.
 *
 * Previously these regexes and instance lists were duplicated across the
 * desktop main process and several renderer modules
 * (`youtube-playback.ts`, `entry-video-source.ts`, `MediaPlayer.tsx`, ...).
 * Centralising them here keeps detection consistent on both ends.
 */

// ── YouTube ───────────────────────────────────────────────────────────────

// Matches the 11-char video id from watch / embed / shorts / youtu.be forms.
// `watch\?.*v=` tolerates other query params appearing before `v=`.
const YOUTUBE_ID_RE =
  /(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/

/** Extract a YouTube video id from a URL. Returns `null` for non-YouTube URLs. */
export function extractYouTubeId(url: string): string | null {
  const match = (url || '').match(YOUTUBE_ID_RE)
  return match?.[1] ?? null
}

/** Build a privacy-friendly YouTube embed iframe URL for a given video id. */
export function buildYoutubeIframeUrl(videoId: string): string {
  return `https://www.youtube.com/embed/${videoId}?controls=1&autoplay=1&mute=0`
}

// ── Direct / embeddable detection ───────────────────────────────────────────

const DIRECT_VIDEO_RE = /\.(mp4|webm|ogg|mov)(\?|$)/i

/**
 * Whether a URL points at a directly-playable video file (mp4/webm/ogg/mov)
 * that a native `<video>` element can load without an embed shim.
 */
export function isDirectVideoUrl(url: string): boolean {
  return DIRECT_VIDEO_RE.test(url || '')
}

const EMBEDDABLE_VIDEO_RE =
  /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/|bilibili\.com\/video\/|b23\.tv\/|vimeo\.com\/\d+|ted\.com\/talks\/|download\.ted\.com\/)/i

/**
 * Whether a URL is from a platform we know how to embed/resolve (YouTube,
 * Bilibili, Vimeo, TED). Used to decide if an entry's own `url` is playable.
 */
export function isEmbeddableVideoUrl(url: string): boolean {
  return EMBEDDABLE_VIDEO_RE.test(url || '')
}
