import { useSyncExternalStore } from 'react'

export type UsageColorPreset = 'standard' | 'relaxed' | 'remaining'
const KEY = 'dsh.subscriptions.usageColorPreset'
const EVENT = 'dsh:subscriptions:usage-color-preset'
export function isUsageColorPreset(value: unknown): value is UsageColorPreset {
  return value === 'standard' || value === 'relaxed' || value === 'remaining'
}
export function readUsageColorPreset(): UsageColorPreset {
  if (typeof window === 'undefined') return 'standard'
  try {
    const value = window.localStorage.getItem(KEY)
    return isUsageColorPreset(value) ? value : 'standard'
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'SecurityError')
      throw error
    return 'standard'
  }
}
export function setUsageColorPreset(value: UsageColorPreset): void {
  if (!isUsageColorPreset(value))
    throw new TypeError('Invalid usage coloring preset')
  window.localStorage.setItem(KEY, value)
  window.dispatchEvent(new Event(EVENT))
}
export function subscribeUsageColorPreset(notify: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) notify()
  }
  window.addEventListener(EVENT, notify)
  window.addEventListener('storage', storage)
  return () => {
    window.removeEventListener(EVENT, notify)
    window.removeEventListener('storage', storage)
  }
}
export function useUsageColorPreset(): UsageColorPreset {
  return useSyncExternalStore(
    subscribeUsageColorPreset,
    readUsageColorPreset,
    () => 'standard',
  )
}
