import type { UsageWindow } from './SubscriptionsSection.js'

/**
 * Keep model-scoped Google quotas aligned with the saved model-picker selection.
 * Account-wide windows and other providers are unaffected; an absent selection
 * follows discovery, while an empty selection hides every model-scoped window.
 */
export function visibleUsageWindows(
  provider: string,
  windows: UsageWindow[] | undefined,
  visibleModels: string[] | undefined,
): UsageWindow[] {
  if (windows === undefined) return []
  if (provider !== 'antigravity' || visibleModels === undefined) return windows
  return windows.filter(
    (window) => !window.scope || visibleModels.includes(window.scope),
  )
}
