import { useLayoutEffect, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

export interface SubscriptionAnchorOptions {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  panelRef: RefObject<HTMLElement | null>
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  gap: number
  margin: number
}

/**
 * Fallback for hosts without useAnchoredPosition. Measure real viewport rects
 * and update on scroll, resize, and panel size changes while the dialog is open.
 */
function useFallbackAnchoredPosition(
  options: SubscriptionAnchorOptions,
): CSSProperties | null {
  const {
    open,
    anchorRef,
    panelRef,
    side = 'bottom',
    align = 'start',
    gap,
    margin,
  } = options
  const [position, setPosition] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    const update = (): void => {
      const anchorRect = anchor.getBoundingClientRect()
      const panelRect = panel.getBoundingClientRect()
      const wantedLeft =
        align === 'end' ? anchorRect.right - panelRect.width : anchorRect.left
      const wantedTop =
        side === 'top'
          ? anchorRect.top - panelRect.height - gap
          : anchorRect.bottom + gap
      const left = Math.min(
        Math.max(margin, wantedLeft),
        Math.max(margin, window.innerWidth - panelRect.width - margin),
      )
      const top = Math.min(
        Math.max(margin, wantedTop),
        Math.max(margin, window.innerHeight - panelRect.height - margin),
      )
      setPosition((previous) =>
        previous?.position === 'fixed' &&
        previous.left === left &&
        previous.top === top
          ? previous
          : { position: 'fixed', left, top },
      )
    }
    update()
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(update)
    observer?.observe(anchor)
    observer?.observe(panel)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchorRef, panelRef, side, align, gap, margin])
  return position
}

// Select once at module load, so no component conditionally changes hook order.
export const useSubscriptionAnchoredPosition =
  primitives.useAnchoredPosition ?? useFallbackAnchoredPosition
