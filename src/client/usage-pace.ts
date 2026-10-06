import type { UsageWindow } from './SubscriptionsSection.js'
import type { UsageColorPreset } from './usage-color-preferences.js'

export interface UsageObservation { observedAt?: number | undefined; stale?: boolean | undefined }
export type UsageColorState = 'neutral' | 'red' | 'yellow' | 'green'
export const USAGE_FRESHNESS_MS = 5 * 60_000
export function validUsage(used: number): boolean {
  return Number.isFinite(used) && used >= 0 && used <= 100
}

/**
 * Rounded share for display, or undefined when the provider's number is
 * unusable. Callers must show the unavailable state rather than clamp an
 * out-of-range reading into 0% or 100%.
 */
export function displayUsedPercent(used: number): number | undefined {
  return validUsage(used) ? Math.round(used) : undefined
}

export interface CountdownPart { unit: 'day' | 'hour' | 'minute'; count: number }

/**
 * Reset countdown as the two largest nonzero whole units, rounded up so a
 * window never announces zero remaining time. Always at least one minute.
 */
export function resetCountdownParts(ms: number): CountdownPart[] {
  const total = Math.max(1, Math.ceil(ms / 60_000))
  const parts: CountdownPart[] = [
    { unit: 'day', count: Math.floor(total / 1440) },
    { unit: 'hour', count: Math.floor((total % 1440) / 60) },
    { unit: 'minute', count: total % 60 },
  ]
  return parts.filter(part => part.count > 0).slice(0, 2)
}
/**
 * Whether the reported percentage still describes the window now. Only a fresh
 * reading may be compared with the current time (pace warnings); an old one
 * keeps its absolute color. This does not decide whether the time cursor is
 * drawn: where the window stands in time never depends on the reading.
 */
export function isUsageFresh(window: UsageWindow, observation: UsageObservation, now = Date.now()): boolean {
  return validUsage(window.usedPercent) && observation.stale !== true
    && observation.observedAt !== undefined && Number.isFinite(observation.observedAt)
    && observation.observedAt <= now && now - observation.observedAt <= USAGE_FRESHNESS_MS
    && (window.resetsAt === undefined || Number.isFinite(window.resetsAt) && window.resetsAt > now)
}

/**
 * How far through its window the clock is, from the window's own timing alone.
 * It ignores the percentage and how recently it was read, so an unused,
 * stale, aged or unobserved reading keeps its cursor whenever the timing
 * places it. Returns undefined when the timing cannot: only an explicit
 * interval or a provider-verified fixed duration supports linear pace, and no
 * start is invented from a window's kind or label.
 */
export function elapsedPercent(window: UsageWindow, now = Date.now()): number | undefined {
  const end = window.resetsAt
  if (end === undefined || !Number.isFinite(end) || end <= now) return undefined
  const duration = window.windowDurationMs
  const start = window.startsAt ?? (window.fixedWindow === true && duration !== undefined && Number.isFinite(duration) && duration > 0 ? end - duration : undefined)
  if (start === undefined || !Number.isFinite(start) || start >= end || start > now) return undefined
  return Math.min(100, Math.max(0, (now - start) / (end - start) * 100))
}
export function usageColorState(used: number, elapsed: number | undefined, preset: UsageColorPreset, fresh: boolean): UsageColorState {
  if (!validUsage(used)) return 'neutral'
  if (used >= 90) return 'red'
  // Missing pace or stale observations retain the last reported absolute color.
  if (!fresh || preset === 'remaining' || elapsed === undefined) return 'green'
  return used - elapsed >= (preset === 'relaxed' ? 15 : 10) ? 'yellow' : 'green'
}
export function usageBarColor(used: number, elapsed?: number, preset: UsageColorPreset = 'standard', fresh = true): string {
  const state = usageColorState(used, elapsed, preset, fresh)
  return state === 'red' ? 'var(--dsw-alias-state-error-primary)'
    : state === 'yellow' ? 'var(--dsw-alias-state-warn-label)'
      : 'var(--dsw-alias-state-success-primary)'
}
