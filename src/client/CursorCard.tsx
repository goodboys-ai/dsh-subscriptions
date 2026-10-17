import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ProviderUsage,
  SubscriptionsSectionInjected,
} from './SubscriptionsSection.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { ProviderAccountManager } from './ProviderAccountManager.js'
import { USAGE_BADGE_REFRESH_EVENT } from './usage-badge-preferences.js'
import { subscriptionCardStyles as styles } from './subscription-card-styles.js'
import { UsageMeter } from './UsageMeter.js'
import { displayUsedPercent } from './usage-pace.js'

type Translate = SubscriptionsSectionInjected['t']
type CursorStatus = {
  authenticated: boolean
  busy: boolean
  expiresAt?: number
  error?: string
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Cursor's single connected account, rendered with the same card and Manage dialog as the other providers. */
export function CursorCard({
  rpc,
  t,
}: {
  rpc: ConnectionHandle['rpc']
  t: Translate
}) {
  const [status, setStatus] = useState<CursorStatus>()
  const [usage, setUsage] = useState<ProviderUsage>()
  const [observedAt, setObservedAt] = useState<number>()
  const [usageStale, setUsageStale] = useState(false)
  const [authorizeUrl, setAuthorizeUrl] = useState<string>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [manage, setManage] = useState(false)
  const authenticated = useRef<boolean>()

  const refreshStatus = useCallback(async () => {
    try {
      const value = await callSubscriptionsAuth<CursorStatus>(
        rpc,
        'cursorStatus',
        {},
      )
      setStatus(value)
      if (authenticated.current !== value.authenticated) {
        authenticated.current = value.authenticated
        window.dispatchEvent(new Event(USAGE_BADGE_REFRESH_EVENT))
      }
      if (value.authenticated) setAuthorizeUrl(undefined)
      if (value.error) setError(value.error)
    } catch (failure) {
      setError(message(failure))
    }
  }, [rpc])

  const refreshUsage = useCallback(async () => {
    setLoading(true)
    try {
      const value = await callSubscriptionsAuth<ProviderUsage>(
        rpc,
        'cursorUsage',
        {},
      )
      setUsage(value)
      // Prefer the server's observation time; a cached reading must not look fresh.
      setObservedAt(value.observedAt ?? Date.now())
      setUsageStale(value.stale === true)
      setError(undefined)
      window.dispatchEvent(new Event(USAGE_BADGE_REFRESH_EVENT))
    } catch (failure) {
      setError(message(failure))
      setUsageStale(true)
    } finally {
      setLoading(false)
    }
  }, [rpc])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])
  useEffect(() => {
    if (status?.busy !== true) return
    const timer = setInterval(() => {
      void refreshStatus()
    }, 2000)
    return () => clearInterval(timer)
  }, [status?.busy, refreshStatus])
  useEffect(() => {
    if (status?.authenticated === true) void refreshUsage()
  }, [status?.authenticated, refreshUsage])

  const login = async () => {
    setError(undefined)
    try {
      const value = await callSubscriptionsAuth<{ authorizeUrl: string }>(
        rpc,
        'cursorLogin',
        {},
      )
      setAuthorizeUrl(value.authorizeUrl)
      window.open(value.authorizeUrl, '_blank', 'noopener')
      await refreshStatus()
    } catch (failure) {
      setError(message(failure))
    }
  }
  const cancel = async () => {
    try {
      await callSubscriptionsAuth(rpc, 'cursorCancel', {})
      setAuthorizeUrl(undefined)
      await refreshStatus()
    } catch (failure) {
      setError(message(failure))
    }
  }
  const logout = async () => {
    if (
      !window.confirm(
        t('logoutAccountConfirm', { account: 'Cursor', provider: 'Cursor' }),
      )
    )
      return
    try {
      await callSubscriptionsAuth(rpc, 'cursorLogout', {})
      setUsage(undefined)
      setObservedAt(undefined)
      setUsageStale(false)
      await refreshStatus()
    } catch (failure) {
      setError(message(failure))
    }
  }

  const connected = status?.authenticated === true
  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span
          style={{
            ...styles.dot,
            background: status?.busy
              ? 'var(--dsw-alias-state-warn-label)'
              : connected
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-label-dimmed)',
          }}
        />
        <span style={styles.name}>{t('cursorTitle')}</span>
      </div>
      <p style={styles.status}>
        {status === undefined
          ? t('checking')
          : status.busy
            ? t('loginInProgress')
            : connected
              ? t('loggedInCount', { count: 1 })
              : t('notLoggedIn')}
      </p>
      {error !== undefined && <p style={styles.error}>{error}</p>}
      {connected && (
        <div style={styles.account}>
          <div style={styles.accountHeader}>
            <span style={styles.defaultStar} title={t('defaultBadge')}>
              ★
            </span>
            <span style={styles.accountName}>Cursor</span>
            {status.expiresAt !== undefined && (
              <span style={styles.status}>
                {t('accountExpires', {
                  date: new Date(status.expiresAt).toLocaleString(),
                })}
              </span>
            )}
            <button
              type="button"
              style={{ ...styles.button, marginLeft: 'auto', flexShrink: 0 }}
              onClick={() => {
                void logout()
              }}
            >
              {t('logout')}
            </button>
          </div>
          <div style={styles.usage}>
            <div style={styles.usageHeader}>
              <span style={styles.usageTitle}>{t('usageTitle')}</span>
              {usage?.plan !== undefined && (
                <span style={styles.status}>
                  {t('usagePlan', { plan: usage.plan })}
                </span>
              )}
              <button
                type="button"
                style={styles.usageRefresh}
                disabled={loading}
                onClick={() => {
                  void refreshUsage()
                }}
              >
                {t('usageRefresh')}
              </button>
            </div>
            {loading && usage === undefined && (
              <p style={styles.status}>{t('usageLoading')}</p>
            )}
            {usage?.windows?.length === 0 && (
              <p style={styles.status}>{t('usageEmpty')}</p>
            )}
            {usage?.windows?.map((window, index) => {
              const percent = displayUsedPercent(window.usedPercent)
              const label =
                window.scope === 'Included'
                  ? t('cursorIncluded')
                  : window.scope === 'Cursor Models'
                    ? t('cursorModels')
                    : window.scope === 'Other Models'
                      ? t('cursorOtherModels')
                      : window.scope === 'Included requests'
                        ? t('cursorIncludedRequests')
                        : (window.scope ?? t('usageWindow'))
              return (
                <div key={index} style={styles.usageRow}>
                  <div style={styles.usageMeta}>
                    <span>{label}</span>
                    <span>
                      {percent === undefined
                        ? t('usageMeterInvalid')
                        : `${percent}%`}
                      {window.resetsAt === undefined
                        ? ''
                        : ` · ${t('usageResets', { date: new Date(window.resetsAt).toLocaleString() })}`}
                    </span>
                  </div>
                  <UsageMeter
                    window={window}
                    t={t}
                    observedAt={observedAt}
                    stale={usageStale}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
      <div style={styles.actions}>
        {status?.authenticated === false && !status.busy && (
          <button
            type="button"
            style={styles.button}
            onClick={() => {
              void login()
            }}
          >
            {t('login')}
          </button>
        )}
        <button
          type="button"
          style={styles.button}
          aria-haspopup="dialog"
          onClick={() => setManage(true)}
        >
          {t('accountsManage')}
        </button>
        {status?.busy === true && (
          <button
            type="button"
            style={styles.button}
            onClick={() => {
              void cancel()
            }}
          >
            {t('cancel')}
          </button>
        )}
      </div>
      {status?.busy === true && authorizeUrl !== undefined && (
        <a href={authorizeUrl} target="_blank" rel="noopener noreferrer">
          {t('cursorOpenLogin')}
        </a>
      )}
      {manage && (
        <ProviderAccountManager
          provider="cursor-subscription"
          name="Cursor"
          rpc={rpc}
          t={t}
          onClose={() => setManage(false)}
        />
      )}
    </div>
  )
}
