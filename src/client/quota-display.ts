import { useEffect, useState } from 'react'
import type { SubscriptionsKey } from './locales.js'
import type { QuotaDisplayMode } from './usage-badge-preferences.js'

type Translate = (
  key: SubscriptionsKey,
  params?: Record<string, unknown>,
) => string

/** Tick only presentation; never fetches usage or routing state. */
export function useQuotaClock(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** Never coerce missing or non-finite telemetry into a full allowance. */
export function quotaPercent(
  used: unknown,
  mode: QuotaDisplayMode,
): number | undefined {
  if (
    typeof used !== 'number' ||
    !Number.isFinite(used) ||
    used < 0 ||
    used > 100
  )
    return undefined
  return Math.round(mode === 'remaining' ? 100 - used : used)
}

export function quotaText(
  used: unknown,
  mode: QuotaDisplayMode,
  t: Translate,
): string {
  const percent = quotaPercent(used, mode)
  return percent === undefined
    ? t('quotaUnknown')
    : t(mode === 'remaining' ? 'quotaRemainingPercent' : 'quotaUsedPercent', {
        percent,
      })
}
