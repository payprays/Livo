import { useEffect, type RefObject } from 'react'

import {
  getFocusedHotkeyScope,
  registerOverlayHotkeyScope,
  setFocusedHotkeyScope,
  type HotkeyScope,
} from '../lib/hotkey-scope'

export function useOverlayHotkeyScope(scope: HotkeyScope, active: boolean) {
  useEffect(() => {
    if (!active) return
    return registerOverlayHotkeyScope(scope)
  }, [active, scope])
}

export function useFocusableHotkeyScope(
  scope: HotkeyScope,
  ref: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const element = ref.current
    if (!element) return

    const handleFocusIn = () => {
      setFocusedHotkeyScope(scope)
    }

    const handlePointerDown = () => {
      setFocusedHotkeyScope(scope)
    }

    const handleFocusOut = () => {
      window.setTimeout(() => {
        const active = document.activeElement
        // Focus falls back to <body> when the focused control gets disabled or
        // unmounted (e.g. the AI summary button while it runs). The user has not
        // moved elsewhere, so keep the scope and its shortcuts (J/K) alive.
        if (!active || active === document.body) return
        if (!element.contains(active)) {
          if (getFocusedHotkeyScope() === scope) {
            setFocusedHotkeyScope(null)
          }
        }
      }, 0)
    }

    element.addEventListener('focusin', handleFocusIn)
    element.addEventListener('pointerdown', handlePointerDown)
    element.addEventListener('focusout', handleFocusOut)

    if (element.contains(document.activeElement)) {
      setFocusedHotkeyScope(scope)
    }

    return () => {
      element.removeEventListener('focusin', handleFocusIn)
      element.removeEventListener('pointerdown', handlePointerDown)
      element.removeEventListener('focusout', handleFocusOut)
    }
  }, [ref, scope])
}
