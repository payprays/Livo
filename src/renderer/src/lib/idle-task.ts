export function scheduleIdleTask(
  callback: () => void,
  options: { timeout: number; fallbackDelay: number },
): () => void {
  if (typeof window === 'undefined') return () => {}

  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(callback, {
      timeout: options.timeout,
    })
    return () => window.cancelIdleCallback(handle)
  }

  const handle = window.setTimeout(callback, options.fallbackDelay)
  return () => window.clearTimeout(handle)
}
