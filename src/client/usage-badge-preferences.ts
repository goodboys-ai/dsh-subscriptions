import { useSyncExternalStore } from 'react'

/**
 * Display-only preference: no credentials or account history are stored.
 * `recent` pins the current/most-recent provider; `always` keeps a provider
 * visible at all times, rotating through the others when the current model
 * has no quota source; `hidden` shows nothing.
 */
export type UsageBadgeMode = 'recent' | 'always' | 'hidden'
const MODE_KEY = 'dsh.subscriptions.usageBadgeMode'
const MODE_EVENT = 'dsh:subscriptions:usage-badge-mode'
export const USAGE_BADGE_REFRESH_EVENT = 'dsh:subscriptions:usage-refresh'

/** Read the browser preference; blocked storage retains the default display. */
export function readUsageBadgeMode(): UsageBadgeMode {
  if (typeof window === 'undefined') return 'recent'
  try {
    const value = window.localStorage.getItem(MODE_KEY)
    return value === 'hidden' || value === 'always' ? value : 'recent'
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error
    return 'recent'
  }
}

/** Save first, then notify; the settings control reports a rejected write. */
export function setUsageBadgeMode(mode: UsageBadgeMode): void {
  if (mode !== 'recent' && mode !== 'always' && mode !== 'hidden') throw new TypeError('Invalid subscription usage display mode')
  window.localStorage.setItem(MODE_KEY, mode)
  window.dispatchEvent(new Event(MODE_EVENT))
}

/** Same-tab writes need a custom event; other tabs use the storage event. */
export function subscribeUsageBadgeMode(notify: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === MODE_KEY || event.key === null) notify()
  }
  window.addEventListener(MODE_EVENT, notify)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(MODE_EVENT, notify)
    window.removeEventListener('storage', onStorage)
  }
}

/** Shared React snapshot used by the settings control and every mounted badge. */
export function useUsageBadgeMode(): UsageBadgeMode {
  return useSyncExternalStore(subscribeUsageBadgeMode, readUsageBadgeMode, () => 'recent')
}
