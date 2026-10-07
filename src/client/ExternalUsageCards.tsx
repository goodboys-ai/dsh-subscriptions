import { useCallback, useEffect, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProviderUsage, SubscriptionsSectionInjected, UsageWindow } from './SubscriptionsSection.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { subscriptionCardStyles as styles } from './subscription-card-styles.js'
import { USAGE_BADGE_REFRESH_EVENT } from './usage-badge-preferences.js'
import { UsageMeter } from './UsageMeter.js'
import { displayUsedPercent } from './usage-pace.js'

type Source = 'opencode-go' | 'kimi-code' | 'minimax' | 'minimax-cn'
type Translate = SubscriptionsSectionInjected['t']

const SOURCES: readonly { id: Source; name: string; ref: string }[] = [
  { id: 'opencode-go', name: 'OpenCode Go', ref: 'OPENCODE_GO_API_KEY' },
  { id: 'kimi-code', name: 'Kimi Code', ref: 'KIMI_CODING_API_KEY' },
  { id: 'minimax', name: 'MiniMax', ref: 'MINIMAX_API_KEY' },
  { id: 'minimax-cn', name: 'MiniMax CN', ref: 'MINIMAX_CN_API_KEY' },
]

type Status = Record<Source, { configured: boolean }>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Row label of one window on an external usage card. A session or weekly
 * window appends the model it belongs to when the provider names one (MiniMax
 * reports a window per model), so two models' weekly rows stay distinguishable.
 * The monthly pool is a scope on an `other` window, not a model.
 * @param t - section translate.
 * @param window - the reported window.
 * @returns the localized label, e.g. "Weekly · general".
 */
export function externalUsageWindowLabel(t: Translate, window: UsageWindow): string {
  const named = window.scope !== undefined && window.scope !== ''
  if (window.kind === 'other') {
    return window.scope === 'Monthly' ? t('usageMonthly') : named ? window.scope! : t('usageWindow')
  }
  const base = window.kind === 'session' ? t('usageSession') : t('usageWeekly')
  return named ? `${base} · ${window.scope}` : base
}

/** Quota cards for API-key providers already available through DSH itself. */
export function ExternalUsageCards({ rpc, t }: { rpc: ConnectionHandle['rpc']; t: Translate }) {
  const [status, setStatus] = useState<Status>()
  const [statusError, setStatusError] = useState<string>()
  const [usage, setUsage] = useState<Partial<Record<Source, ProviderUsage>>>({})
  const [observedAt, setObservedAt] = useState<Partial<Record<Source, number>>>({})
  const [errors, setErrors] = useState<Partial<Record<Source, string>>>({})
  const [loading, setLoading] = useState<Partial<Record<Source, boolean>>>({})

  const refresh = useCallback(async (source: Source) => {
    setLoading(prev => ({ ...prev, [source]: true }))
    try {
      const value = await callSubscriptionsAuth<ProviderUsage>(rpc, 'externalUsage', { source })
      setUsage(prev => ({ ...prev, [source]: value }))
      // Prefer the server's observation time; a cached reading must not look fresh.
      setObservedAt(prev => ({ ...prev, [source]: value.observedAt ?? Date.now() }))
      setErrors(prev => ({ ...prev, [source]: undefined }))
      window.dispatchEvent(new Event(USAGE_BADGE_REFRESH_EVENT))
    } catch (error) {
      setErrors(prev => ({ ...prev, [source]: errorText(error) }))
    } finally {
      setLoading(prev => ({ ...prev, [source]: false }))
    }
  }, [rpc])

  const refreshStatus = useCallback(async () => {
    try {
      const value = await callSubscriptionsAuth<Status>(rpc, 'externalStatus', {})
      setStatus(value)
      setStatusError(undefined)
      for (const { id } of SOURCES) if (value[id]?.configured) void refresh(id)
    } catch (error) { setStatusError(errorText(error)) }
  }, [rpc, refresh])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  return <>
    {SOURCES.map(({ id, name, ref }) => {
      const configured = status?.[id]?.configured === true
      const snapshot = usage[id]
      return <div key={id} style={styles.card}>
        <div style={styles.header}>
          <span style={{ ...styles.dot, background: configured
            ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-dimmed)' }} />
          <span style={styles.name}>{name}</span>
        </div>
        {!(status === undefined && statusError !== undefined) && <p style={styles.status}>
          {status === undefined ? t('checking')
            : configured ? t('externalUsageConnected') : t('externalUsageNotConfigured')}
        </p>}
        {statusError !== undefined && <p style={styles.error}>
          {t('externalUsageUnavailable', { message: statusError })}</p>}
        {status !== undefined && !configured && <p style={styles.status}>{t('externalUsageConfigure', { ref })}</p>}
        {configured && <div style={styles.account}>
          <div style={styles.accountHeader}>
            <span style={styles.defaultStar} title={t('defaultBadge')}>★</span>
            <span style={styles.accountName}>{t('externalUsageApiKey')}</span>
          </div>
          <div style={styles.usage}>
            <div style={styles.usageHeader}>
              <span style={styles.usageTitle}>{t('usageTitle')}</span>
              {snapshot?.plan !== undefined && <span style={styles.usagePlan}>{t('usagePlan', { plan: snapshot.plan })}</span>}
              <button type="button" style={styles.usageRefresh} disabled={loading[id] === true}
                onClick={() => { void refresh(id) }}>{t('usageRefresh')}</button>
            </div>
            {loading[id] === true && snapshot === undefined && <p style={styles.status}>{t('usageLoading')}</p>}
            {errors[id] !== undefined && <p style={styles.error}>{t('usageError', { message: errors[id] })}</p>}
            {snapshot?.windows?.length === 0 && <p style={styles.status}>{t('usageEmpty')}</p>}
            {snapshot?.windows?.map((window, index) => {
              const percent = displayUsedPercent(window.usedPercent)
              const label = externalUsageWindowLabel(t, window)
              return <div key={index} style={styles.usageRow}>
                <div style={styles.usageMeta}>
                  <span>{label}</span>
                  <span>{percent === undefined ? t('usageMeterInvalid') : `${percent}%`}{window.resetsAt === undefined ? ''
                    : ` · ${t('usageResets', { date: new Date(window.resetsAt).toLocaleString() })}`}</span>
                </div>
                <UsageMeter window={window} t={t} observedAt={observedAt[id]} stale={errors[id] !== undefined || snapshot?.stale === true} />
              </div>
            })}
          </div>
        </div>}
        {!configured && <div style={styles.actions}>
          <button type="button" style={styles.button} onClick={() => { void refreshStatus() }}>
            {t('usageRefresh')}
          </button>
        </div>}
      </div>
    })}
  </>
}
