/**
 * Standardize the catch-all → `{ success: false }` pattern used by IPC handlers.
 *
 * Replaces repetitive:
 * ```
 * catch (error) {
 *   return { success: false, error: String(error) }
 * }
 * ```
 *
 * with:
 * ```
 * catch (error) {
 *   return toHandlerError(error)
 * }
 * ```
 */
export function toHandlerError(
  error: unknown,
  fallbackMessage = '未知错误',
): { success: false; error: string } {
  return {
    success: false,
    error:
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : String(error || fallbackMessage),
  }
}
