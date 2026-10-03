/**
 * ResizeHandle — Draggable panel resize handle.
 * Zero-width element with an invisible 6px hit area and a visible line on hover/drag.
 */
export function ResizeHandle({
  onMouseDown,
}: {
  onMouseDown: (e: React.MouseEvent) => void
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="group relative z-10 w-0 flex-shrink-0"
    >
      {/* Invisible wider hit area */}
      <div className="absolute inset-y-0 -left-[3px] w-[6px] cursor-col-resize">
        {/* Visible line on hover / drag */}
        <div className="group-hover:bg-accent/40 group-active:bg-accent absolute inset-y-0 left-[2px] w-[2px] bg-transparent transition-colors" />
      </div>
    </div>
  )
}
