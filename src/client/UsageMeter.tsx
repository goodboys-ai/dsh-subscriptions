import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { UsageWindow, SubscriptionsSectionInjected } from './SubscriptionsSection.js'
import { elapsedPercent, isUsageFresh, resetCountdownParts, usageBarColor, usageColorState, validUsage } from './usage-pace.js'
import type { CountdownPart, UsageObservation } from './usage-pace.js'
import { useUsageColorPreset } from './usage-color-preferences.js'
import type { SubscriptionsKey } from './locales.js'

/** Singular/plural locale keys per countdown unit (zh maps both to one string). */
const UNIT_KEYS: Record<CountdownPart['unit'], [SubscriptionsKey, SubscriptionsKey]> = {
  day: ['usageUnitDay', 'usageUnitDays'],
  hour: ['usageUnitHour', 'usageUnitHours'],
  minute: ['usageUnitMinute', 'usageUnitMinutes'],
}

export function UsageMeter({ window: quota, t, style, observedAt, stale }: {
  window: UsageWindow; t: SubscriptionsSectionInjected['t']; style?: CSSProperties
} & UsageObservation) {
  const preset = useUsageColorPreset()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  // Use render time for new readings, without trusting a future observation timestamp.
  const current = Math.max(now, Date.now())
  const valid = validUsage(quota.usedPercent)
  const used = valid ? quota.usedPercent : 0
  const fresh = isUsageFresh(quota, { observedAt, stale }, current)
  // The cursor is where the window stands in time. It needs only the window's
  // own timing, so it stays for an unused, stale, aged or unobserved reading.
  const elapsed = elapsedPercent(quota, current)
  // Comparing usage with elapsed time is meaningful only while the percentage
  // is current; an old one is not set against today's clock.
  const pace = fresh ? elapsed : undefined
  const state = usageColorState(quota.usedPercent, pace, preset, fresh)
  const lead = pace === undefined ? 0 : Math.round(used - pace)
  const label = [
    valid ? t('usageMeterUsed', { used: Math.round(used), remaining: Math.round(100 - used) }) : t('usageMeterInvalid'),
    // An invalid reading already states unavailability; the stale line would repeat it.
    !valid ? '' : !fresh ? t('usageMeterStale') : state === 'red' ? t('usageMeterNearLimit')
      : pace === undefined && preset !== 'remaining' ? t('usageMeterUnknownTime')
        : state === 'yellow' ? t('usageMeterAhead') : t('usageMeterNoWarning'),
    elapsed === undefined ? '' : t('usageMeterPace', { elapsed: Math.round(elapsed) }),
    pace === undefined ? '' : lead > 0 ? t('usageMeterPaceAhead', { points: lead })
      : lead < 0 ? t('usageMeterPaceBehind', { points: -lead }) : t('usageMeterPaceEven'),
    quota.resetsAt !== undefined && quota.resetsAt > current ? t('usageMeterReset', {
      duration: resetCountdownParts(quota.resetsAt - current)
        .map(part => t(UNIT_KEYS[part.unit][part.count === 1 ? 0 : 1], { count: part.count }))
        .join(' '),
    }) : '',
  ].filter(Boolean).join(' · ')
  return <div role="img" aria-label={label} title={label} data-usage-color={state} style={{
    height: 6, borderRadius: 3, overflow: 'hidden',
    background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
    ...style, position: 'relative',
  }}>
    <div style={{ height: '100%', borderRadius: 'inherit', width: `${used}%`,
      background: usageBarColor(quota.usedPercent, pace, preset, fresh) }} />
    {elapsed !== undefined && <span aria-hidden="true" data-usage-time-marker style={{
      position: 'absolute', left: `clamp(0px, calc(${elapsed}% - 1px), calc(100% - 2px))`,
      top: 0, bottom: 0, width: 2, background: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 0 0 1px var(--dsw-alias-bg-layer-1)',
    }} />}
  </div>
}
