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
  // DOM replacement can keep the same RefObject identities. A mutation observer
  // rebinds the size observer without re-running this effect after every render.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const update = (): void => {
      const anchor = anchorRef.current
      const panel = panelRef.current
      if (!anchor || !panel) return
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
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(update)
    let observedAnchor: HTMLElement | null = null
    let observedPanel: HTMLElement | null = null
    const syncObserver = (): void => {
      const anchor = anchorRef.current
      const panel = panelRef.current
      if (anchor !== observedAnchor || panel !== observedPanel) {
        observer?.disconnect()
        observedAnchor = anchor
        observedPanel = panel
        if (anchor) observer?.observe(anchor)
        if (panel) observer?.observe(panel)
      }
      update()
    }
    syncObserver()
    const mutations = new MutationObserver(syncObserver)
    mutations.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      mutations.disconnect()
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchorRef, panelRef, side, align, gap, margin])
  return position
}

// The optional host hook is absent from RC2's types as well as its runtime.
const hostAnchoredPosition = (
  primitives as unknown as {
    useAnchoredPosition?: (
      options: SubscriptionAnchorOptions,
    ) => CSSProperties | null
  }
).useAnchoredPosition

// Select once at module load, so no component conditionally changes hook order.
export const useSubscriptionAnchoredPosition =
  hostAnchoredPosition ?? useFallbackAnchoredPosition
