/**
 * Subscriptions settings section: one card per subscription provider with an
 * OAuth login/logout flow driven by the node half's `/subscriptions-auth` RPC
 * channel. Login state lives server-side; the page polls `status` only while
 * a login attempt is busy, so an idle page never polls. All state is local
 * React state — the page has no store.
 *
 * Every color resolves through a `--dsw-alias-*` design token (the ui-theme
 * design-platform.css values flip under `body[data-ds-dark-theme]`), and
 * every user-visible string goes through the locale-bound `t` of the
 * 'settings.subscriptions' namespace. Buttons and inputs take the
 * ModelsSection vocabulary minus hover rules, which inline styles cannot
 * express.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { en } from './locales.js'
import { resetActionBlock } from './reset-action.js'
import { ProviderAccountManager } from './ProviderAccountManager.js'
import { ExternalUsageCards } from './ExternalUsageCards.js'
import { CursorCard } from './CursorCard.js'
import { UsageMeter } from './UsageMeter.js'
import { displayUsedPercent } from './usage-pace.js'
import { UsageBadgeDisplaySetting } from './UsageBadgeDisplaySetting.js'
import { USAGE_BADGE_REFRESH_EVENT } from './usage-badge-preferences.js'
import { subscriptionCardStyles as cardStyles } from './subscription-card-styles.js'
import type { SubscriptionsKey } from './locales.js'

import { callSubscriptionsAuth, SubscriptionsAuthError } from './subscriptions-rpc.js'
export { callSubscriptionsAuth } from './subscriptions-rpc.js'

/** Poll cadence while a provider login attempt is busy. */
const POLL_INTERVAL_MS = 2000

/**
 * Model count above which the expanded default-effort list also offers a name
 * filter; below it the list is short enough to scan.
 */
const MODEL_FILTER_THRESHOLD = 8

/** Subscription provider ids, fixed by the node half's OAuth adapters. */
export type SubscriptionProvider = 'codex' | 'claude' | 'grok' | 'copilot' | 'antigravity'

/** One logged-in account as answered by the `status` endpoint. */
export interface AccountStatus {
  key: string
  account?: string
  expiresAt?: number
  plan?: string
  isDefault: boolean
}

/** One provider's login state as answered by the `status` endpoint. */
export interface ProviderStatus {
  busy: boolean
  accounts: AccountStatus[]
  detail?: string
  /** The CLI version the route presents (Codex, Claude), and where it came from. */
  clientVersion?: { version: string; source: ClientVersionSource }
}

/** Where a presented CLI version came from; the tag names the source so a stale one is visible. */
export type ClientVersionSource = 'npm' | 'local' | 'fallback' | 'config'

const CLIENT_VERSION_SOURCES: Record<ClientVersionSource, SubscriptionsKey> = {
  npm: 'clientVersionNpm',
  local: 'clientVersionLocal',
  fallback: 'clientVersionFallback',
  config: 'clientVersionConfig',
}

/** `status` endpoint value: the node half owns this shape. */
interface StatusResponse {
  providers: Record<SubscriptionProvider, ProviderStatus>
}

/** One rate-limit window as answered by the `usage` endpoint. */
export interface UsageWindow {
  kind: 'session' | 'weekly' | 'other'
  scope?: string
  usedPercent: number
  resetsAt?: number
  startsAt?: number
  windowDurationMs?: number
  fixedWindow?: boolean
}

/** `usage` endpoint value: the node half owns this shape. */
export interface ProviderUsage {
  observedAt?: number
  stale?: boolean
  supported: boolean
  windows?: UsageWindow[]
  plan?: string
  resetCredits?: { id?: string; grantedAt?: number; expiresAt?: number }[]
  resetCreditsError?: string
}

/** One model's default-effort picker state as answered by `modelDefaults`. */
export interface ModelDefaultView {
  id: string
  name: string
  /** Advertised effort levels, in catalog order (empty when the model has no reasoning). */
  efforts: { id: string; name: string }[]
  /** The user-configured default effort, when set. */
  configured?: string
}

/** `modelDefaults` endpoint value: one provider's picker state. */
export interface ModelDefaultsCatalog {
  provider: SubscriptionProvider
  models: ModelDefaultView[]
}

/** `login` endpoint value: the URL the user completes OAuth at. */
interface LoginResponse {
  authorizeUrl: string
  /** Device-flow providers (copilot): the code the user types at authorizeUrl. */
  userCode?: string
}

/** Injected dependencies of {@link SubscriptionsSection} (slot `inject`). */
export interface SubscriptionsSectionInjected {
  /** Generic logical-RPC caller over the Connection transport. */
  rpc: ConnectionHandle['rpc']
  /** Section copy: translate a 'settings.subscriptions' key with `{name}` template params. */
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type SubscriptionsSectionProps = Partial<SubscriptionsSectionInjected>

/** Card display metadata, in page order (names are brand names, not translated). */
const PROVIDERS: readonly { id: SubscriptionProvider; name: string }[] = [
  { id: 'codex', name: 'Codex (ChatGPT)' },
  { id: 'claude', name: 'Claude' },
  { id: 'grok', name: 'Grok (X Premium)' },
  { id: 'copilot', name: 'GitHub Copilot' },
  { id: 'antigravity', name: 'Google Antigravity' },
]

/** Human text of an action failure, SubscriptionsAuthError or not. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Copy a keyed map without the entries whose key is not in `live`. */
function dropStale<T>(map: Record<string, T>, live: ReadonlySet<string>): Record<string, T> {
  const stale = Object.keys(map).filter(key => !live.has(key))
  if (stale.length === 0) return map
  const next = { ...map }
  for (const key of stale) delete next[key]
  return next
}

/**
 * English-dictionary fallback for a missing inject `t` (standalone renders);
 * the slot inject always supplies the locale-bound one.
 * @param key - dictionary key.
 * @param params - `{name}` template params.
 * @returns the template with params substituted.
 */
function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

const styles: Record<string, CSSProperties> = {
  section: {
    display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560,
    color: 'var(--dsw-alias-label-primary)',
  },
  intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '22px' },
  card: cardStyles.card,
  cardHeader: cardStyles.header,
  dot: cardStyles.dot,
  name: cardStyles.name,
  statusLine: cardStyles.status,
  clientVersion: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' },
  errorLine: cardStyles.error,
  actions: cardStyles.actions,
  button: cardStyles.button,
  usage: cardStyles.usage,
  usageHeader: cardStyles.usageHeader,
  usageTitle: cardStyles.usageTitle,
  usagePlan: cardStyles.usagePlan,
  usageRefresh: cardStyles.usageRefresh,
  usageRow: cardStyles.usageRow,
  usageMeta: cardStyles.usageMeta,
  accountRow: cardStyles.account,
  accountHeader: cardStyles.accountHeader,
  accountName: cardStyles.accountName,
  starButton: {
    border: 'none', background: 'transparent', padding: 0,
    font: 'inherit', fontSize: 14, lineHeight: '20px', cursor: 'pointer',
    color: 'var(--dsw-alias-state-warn-label)',
  },
  deviceCode: {
    marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6,
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-1)',
  },
  deviceCodeText: {
    fontFamily: 'monospace', fontSize: 18, lineHeight: '24px', letterSpacing: 2,
    color: 'var(--dsw-alias-label-primary)', userSelect: 'all',
  },
  modalOverlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    background: 'rgba(0, 0, 0, 0.45)',
  },
  modal: {
    width: 460, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto',
    boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12,
    padding: '16px 18px', borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
  },
  modalHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  modalTitle: { fontWeight: 600, fontSize: 15, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
}

/** Status dot color for one provider state. */
function dotColor(status: ProviderStatus | undefined): string {
  if (status?.busy === true) return 'var(--dsw-alias-state-warn-label)'
  if ((status?.accounts.length ?? 0) > 0) return 'var(--dsw-alias-state-success-primary)'
  return 'var(--dsw-alias-label-dimmed)'
}

/**
 * Whether a provider has at least one connected account. Multi-account made
 * "logged in" a property of the account list rather than a flag, so every
 * logged-in test goes through this one predicate.
 * @param status - the provider's last reported state, possibly absent.
 * @returns true when the provider serves at least one account.
 */
function hasAccount(status: ProviderStatus | undefined): boolean {
  return (status?.accounts.length ?? 0) > 0
}

/**
 * One-line status text for one provider state.
 * @param t - section translate.
 * @param status - the provider's last reported state.
 * @returns the localized status line.
 */
function statusText(t: SubscriptionsSectionInjected['t'], status: ProviderStatus | undefined): string {
  if (status === undefined) return t('checking')
  if (status.busy) return t('loginInProgress')
  if (status.accounts.length > 0) return t('loggedInCount', { count: status.accounts.length })
  return t('notLoggedIn')
}

/**
 * The CLI version a route presents, beside the provider name; nothing for
 * routes without one. The source word (npm / local / built-in / configured)
 * is the fix for upstream issue #108: a failed npm lookup must read as a
 * fallback, never as a plan limit.
 */
export function clientVersionText(
  t: SubscriptionsSectionInjected['t'],
  clientVersion: ProviderStatus['clientVersion'],
): string {
  if (clientVersion === undefined) return ''
  return t('clientVersion', { version: clientVersion.version, source: t(CLIENT_VERSION_SOURCES[clientVersion.source]) })
}

/**
 * Localized label of one usage window (kind, plus the model scope when named).
 * @param t - section translate.
 * @param window - the reported window.
 * @returns e.g. "5-hour window" or "Weekly · Opus".
 */
function usageWindowLabel(t: SubscriptionsSectionInjected['t'], window: UsageWindow): string {
  const base = window.kind === 'session'
    ? t('usageSession')
    : window.kind === 'weekly' ? t('usageWeekly') : t('usageWindow')
  return window.scope !== undefined && window.scope !== '' ? `${base} · ${window.scope}` : base
}

/** Meter fill color lives with the pace logic: fresh 90%+ is red, pace presets add a yellow lead threshold. */
export { usageBarColor } from './usage-pace.js'

/** What one provider's collapsible default-effort section renders. */
export interface ModelDefaultsView {
  /** Models with reasoning levels, after the name filter — one row each. */
  shown: ModelDefaultView[]
  /** Models with reasoning levels before filtering (the header total). */
  total: number
  /** How many of those carry a user override (the header count). */
  overridden: number
  /** Models without reasoning levels: one count line, never a row each. */
  withoutEfforts: number
  /** Whether the list is long enough to deserve a filter box. */
  showFilter: boolean
}

/**
 * Derive one provider's default-effort section from its catalog and filter.
 * Pure so the collapsed-header counts and the filter stay testable without a
 * DOM: rows come only from models that advertise levels, the count of the rest
 * rides as one line, and the filter matches display name or model id.
 * @param models - the provider's catalog models, or undefined while loading.
 * @param filter - the raw filter input (trimmed and lowercased here).
 * @returns the section's rows and header counts.
 */
export function deriveModelDefaultsView(
  models: readonly ModelDefaultView[] | undefined,
  filter: string,
): ModelDefaultsView {
  const all = models ?? []
  const withEfforts = all.filter(model => model.efforts.length > 0)
  const query = filter.trim().toLowerCase()
  const shown = query === ''
    ? withEfforts
    : withEfforts.filter(model => model.name.toLowerCase().includes(query)
      || model.id.toLowerCase().includes(query))
  return {
    shown,
    total: withEfforts.length,
    overridden: withEfforts.filter(model => model.configured !== undefined).length,
    withoutEfforts: all.length - withEfforts.length,
    showFilter: withEfforts.length > MODEL_FILTER_THRESHOLD,
  }
}

/** Inputs of the default-effort fetch decision (see {@link shouldFetchModelDefaults}). */
export interface ModelDefaultsFetchInput {
  /** Providers that currently have at least one account. */
  loggedIn: readonly SubscriptionProvider[]
  /** Providers whose disclosure is open. */
  open: readonly SubscriptionProvider[]
  /** The account signature the last completed fetch was answered for. */
  loadedFor: string | undefined
  /** The account signature of the current status snapshot. */
  signature: string
  /** Whether the last attempt failed (a failure latches until Retry). */
  failed: boolean
}

/**
 * Whether the default-effort catalog needs (re)fetching.
 *
 * Fetching is gated on an *attempt* signature rather than on the payload
 * being empty: an empty answer is a legitimate result (a narrowed
 * `config.providers`, or a catalog that is momentarily unavailable), and
 * treating it as "not loaded yet" re-ran this effect forever. The signature
 * also covers the accounts, so logging a second provider in refetches
 * instead of leaving that card on the previous answer.
 * @param input - the decision inputs.
 * @returns true when the caller should start a fetch.
 */
export function shouldFetchModelDefaults(input: ModelDefaultsFetchInput): boolean {
  if (input.failed) return false
  if (input.loggedIn.length === 0) return false
  // Only an open disclosure pays for the per-model live resolve.
  if (!input.open.some(provider => input.loggedIn.includes(provider))) return false
  return input.loadedFor !== input.signature
}

/**
 * Stable signature of the accounts a catalog answer depends on. A change
 * means a previous answer is stale (an account arrived or left), so the next
 * open disclosure refetches.
 * @param statuses - the per-provider status snapshot.
 * @returns a signature string, stable across renders with equal accounts.
 */
export function modelDefaultsSignature(
  statuses: Partial<Record<SubscriptionProvider, ProviderStatus>>,
): string {
  return PROVIDERS
    .map(({ id }) => `${id}:${(statuses[id]?.accounts ?? []).map(account => account.key).sort().join(',')}`)
    .join('|')
}

/**
 * The Subscriptions settings page component.
 * @param props - the slot inject face ({@link SubscriptionsSectionInjected}).
 * @returns the section body, or a notice while the RPC face is absent.
 */
export function SubscriptionsSection(props: SubscriptionsSectionProps) {
  const { rpc } = props
  const t = props.t ?? fallbackTranslate
  const [statuses, setStatuses] = useState<Partial<Record<SubscriptionProvider, ProviderStatus>>>({})
  const [errors, setErrors] = useState<Partial<Record<SubscriptionProvider, string>>>({})
  const [manualDrafts, setManualDrafts] = useState<Record<SubscriptionProvider, string>>({
    codex: '', claude: '', grok: '', copilot: '', antigravity: '',
  })
  /** Pending device-flow codes (copilot), shown while the attempt polls. */
  const [deviceCodes, setDeviceCodes] = useState<Partial<Record<SubscriptionProvider, { userCode: string; verificationUrl: string }>>>({})
  const [copiedCode, setCopiedCode] = useState<SubscriptionProvider | undefined>(undefined)
  /** Usage snapshots keyed `${provider}:${accountKey}` — every account tracks its own windows. */
  const [usages, setUsages] = useState<Record<string, ProviderUsage>>({})
  const [observedAt, setObservedAt] = useState<Record<string, number>>({})
  const [usageErrors, setUsageErrors] = useState<Record<string, string>>({})
  const [usageLoading, setUsageLoading] = useState<Record<string, boolean>>({})
  const [resetConfirmation, setResetConfirmation] = useState<{ account: string; ticket: string; expiresAt: number; creditExpiresAt?: number; weeklyUsedPercent: number }>()
  const [resetBusy, setResetBusy] = useState(false)
  const [resetAcknowledged, setResetAcknowledged] = useState(false)
  const [resetMessage, setResetMessage] = useState('')
  const [resetAccount, setResetAccount] = useState<string>()
  const resetDialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (resetConfirmation) resetDialogRef.current?.showModal()
    else resetDialogRef.current?.close()
  }, [resetConfirmation])
  const resetInflight = useRef(false)
  const mountedRef = useRef(true)
  const pollersRef = useRef(new Map<SubscriptionProvider, ReturnType<typeof setInterval>>())
  /** Accounts with a `usage` call in flight; guards the auto-fetch effect against re-entry. */
  const usageInflightRef = useRef(new Set<string>())
  const usageRosterSignatureRef = useRef<string>()
  const [managedProvider, setManagedProvider] = useState<{ id: SubscriptionProvider; name: string }>()
  const setProviderError = useCallback((provider: SubscriptionProvider, message: string | undefined): void => {
    if (!mountedRef.current) return
    setErrors((prev) => {
      const next = { ...prev }
      if (message === undefined) delete next[provider]
      else next[provider] = message
      return next
    })
  }, [])

  const stopPolling = useCallback((provider: SubscriptionProvider): void => {
    const poller = pollersRef.current.get(provider)
    if (poller !== undefined) {
      clearInterval(poller)
      pollersRef.current.delete(provider)
    }
  }, [])

  /** Refetch every provider's status; stop a provider's poller once its attempt settles. */
  const refresh = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return
    let response: StatusResponse
    try {
      response = await callSubscriptionsAuth<StatusResponse>(rpc, 'status', {})
    } catch (error) {
      // A failed poll must not kill the page; busy providers keep polling and
      // the action paths report their own errors. But staying silent turns a
      // persistent failure into an endless "Checking…" — show it instead.
      const message = error instanceof Error ? error.message : String(error)
      for (const { id } of PROVIDERS) setProviderError(id, message)
      return
    }
    if (!mountedRef.current) return
    setStatuses(response.providers)
    const signature = PROVIDERS.map(({ id }) => `${id}:${response.providers[id].accounts
      .map(account => `${account.key}:${account.isDefault}`).join(',')}`).join(';')
    if (signature !== usageRosterSignatureRef.current) {
      usageRosterSignatureRef.current = signature
      window.dispatchEvent(new Event(USAGE_BADGE_REFRESH_EVENT))
    }
    // The poll recovered: drop any error line a previous failed poll left.
    for (const { id } of PROVIDERS) setProviderError(id, undefined)
    for (const { id } of PROVIDERS) {
      const status = response.providers[id]
      if (status.accounts.length > 0 || !status.busy) {
        stopPolling(id)
        // The attempt settled (success, timeout, or cancel): drop the code card.
        setDeviceCodes((prev) => {
          if (prev[id] === undefined) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
    }
  }, [rpc, stopPolling, setProviderError])

  const startPolling = useCallback((provider: SubscriptionProvider): void => {
    if (pollersRef.current.has(provider)) return
    pollersRef.current.set(provider, setInterval(() => { void refresh() }, POLL_INTERVAL_MS))
  }, [refresh])

  // Initial load; every busy provider (e.g. an attempt started before a page
  // reload) resumes polling. Teardown clears pollers and the mounted guard.
  useEffect(() => {
    mountedRef.current = true
    void refresh().then(() => {
      if (!mountedRef.current) return
      setStatuses((current) => {
        for (const { id } of PROVIDERS) {
          if (current[id]?.busy === true) startPolling(id)
        }
        return current
      })
    })
    return () => {
      mountedRef.current = false
      for (const poller of pollersRef.current.values()) clearInterval(poller)
      pollersRef.current.clear()
    }
  }, [refresh, startPolling])

  const loadUsage = useCallback(async (provider: SubscriptionProvider, account: string, force = false): Promise<void> => {
    const key = `${provider}:${account}`
    if (rpc === undefined || usageInflightRef.current.has(key)) return
    usageInflightRef.current.add(key)
    setUsageLoading(prev => ({ ...prev, [key]: true }))
    try {
      const usage = await callSubscriptionsAuth<ProviderUsage>(rpc, 'usage', { provider, account, ...force ? { force: true } : {} })
      if (!mountedRef.current) return
      setUsages(prev => ({ ...prev, [key]: usage }))
      setObservedAt(prev => ({ ...prev, [key]: usage.observedAt ?? Date.now() }))
      window.dispatchEvent(new Event(USAGE_BADGE_REFRESH_EVENT))
      setUsageErrors((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    } catch (error) {
      if (mountedRef.current) setUsageErrors(prev => ({ ...prev, [key]: messageOf(error) }))
    } finally {
      usageInflightRef.current.delete(key)
      if (mountedRef.current) setUsageLoading(prev => ({ ...prev, [key]: false }))
    }
  }, [rpc])

  async function prepareReset(account: string): Promise<void> {
    if (!rpc || resetInflight.current) return
    resetInflight.current = true
    setResetBusy(true)
    setResetAccount(account)
    setResetConfirmation(undefined)
    setResetMessage('')
    try {
      const result = await callSubscriptionsAuth<Omit<NonNullable<typeof resetConfirmation>, 'account'>>(rpc, 'prepareReset', { account })
      setResetAcknowledged(false)
      setResetConfirmation({ ...result, account })
    } catch (error) { setResetMessage(messageOf(error)) }
    finally { resetInflight.current = false; setResetBusy(false) }
  }

  async function consumeReset(): Promise<void> {
    if (!rpc || !resetConfirmation || !resetAcknowledged || resetInflight.current) return
    const { account, ticket } = resetConfirmation
    resetInflight.current = true
    setResetBusy(true)
    setResetConfirmation(undefined)
    try {
      await callSubscriptionsAuth(rpc, 'consumeReset', { account, ticket })
      setResetMessage(t('resetUseSuccess'))
    } catch (error) { setResetMessage(messageOf(error)) }
    finally {
      await loadUsage('codex', account, true)
      resetInflight.current = false; setResetBusy(false)
    }
  }

  // Fetch usage once an account is logged in; drop the snapshots of accounts
  // that vanished so a re-login refetches. A failed lookup does not auto-retry
  // — the per-account Refresh button is the retry path.
  useEffect(() => {
    const live = new Set<string>()
    for (const { id } of PROVIDERS) {
      for (const account of statuses[id]?.accounts ?? []) {
        const key = `${id}:${account.key}`
        live.add(key)
        if (usages[key] === undefined && usageErrors[key] === undefined) void loadUsage(id, account.key)
      }
    }
    setUsages(prev => dropStale(prev, live))
    setUsageErrors(prev => dropStale(prev, live))
  }, [statuses, usages, usageErrors, loadUsage])

  const login = useCallback(async (provider: SubscriptionProvider, method?: 'oauth' | 'keychain'): Promise<void> => {
    if (rpc === undefined) return
    setProviderError(provider, undefined)
    try {
      const response = await callSubscriptionsAuth<LoginResponse>(rpc, 'login', {
        provider,
        ...method === undefined ? {} : { method },
      })
      if (typeof response.authorizeUrl === 'string' && response.authorizeUrl === '') {
        // Instant login (e.g. imported from Claude Code credentials)
        await refresh()
        return
      }
      if (typeof response.authorizeUrl !== 'string') {
        throw new SubscriptionsAuthError(t('loginMissingUrl'))
      }
      if (!mountedRef.current) return
      // Optimistic busy so Cancel and the manual fallback appear before the first poll tick.
      setStatuses(prev => ({
        ...prev,
        [provider]: { accounts: prev[provider]?.accounts ?? [], ...prev[provider], busy: true },
      }))
      if (typeof response.userCode === 'string' && response.userCode.length > 0) {
        // Device flow: show the code card instead of opening the page blind —
        // the user copies the code first, then opens the verification page.
        setDeviceCodes(prev => ({ ...prev, [provider]: { userCode: response.userCode as string, verificationUrl: response.authorizeUrl } }))
      } else {
        window.open(response.authorizeUrl, '_blank', 'noopener')
      }
      startPolling(provider)
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
  }, [rpc, t, setProviderError, startPolling])

  const cancel = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    stopPolling(provider)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'cancel', { provider })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, stopPolling, setProviderError, refresh])

  const submitManual = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    const input = manualDrafts[provider].trim()
    if (input === '') return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'manual', { provider, input })
      if (mountedRef.current) setManualDrafts(prev => ({ ...prev, [provider]: '' }))
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, manualDrafts, setProviderError, refresh])

  const logout = useCallback(async (provider: SubscriptionProvider, account: string, display: string, name: string): Promise<void> => {
    if (rpc === undefined) return
    if (!window.confirm(t('logoutAccountConfirm', { provider: name, account: display }))) return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'logout', { provider, account })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, t, setProviderError, refresh])

  const setDefault = useCallback(async (provider: SubscriptionProvider, account: string): Promise<void> => {
    if (rpc === undefined) return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'setDefault', { provider, account })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, setProviderError, refresh])

  const copyDeviceCode = useCallback((provider: SubscriptionProvider, userCode: string): void => {
    void navigator.clipboard?.writeText(userCode).then(() => {
      if (!mountedRef.current) return
      setCopiedCode(provider)
      setTimeout(() => {
        if (mountedRef.current) {
          setCopiedCode(current => current === provider ? undefined : current)
        }
      }, 1500)
    }).catch(() => undefined)
  }, [])

  if (rpc === undefined) {
    return <p style={styles.intro}>{t('unavailable')}</p>
  }

  return (
    <div style={styles.section}>
      <p style={styles.intro}>{t('intro')}</p>
      <UsageBadgeDisplaySetting t={t} />
      {PROVIDERS.map(({ id, name }) => {
        const status = statuses[id]
        const busy = status?.busy === true
        const deviceCode = deviceCodes[id]
        const accounts = status?.accounts ?? []
        return (
          <div key={id} style={styles.card}>
            <div style={styles.cardHeader}>
              <span style={{ ...styles.dot, background: dotColor(status) }} />
              <span style={styles.name}>{name}</span>
              {status?.clientVersion !== undefined && (
                <span style={styles.clientVersion} title={t('clientVersionHint')}>
                  {clientVersionText(t, status.clientVersion)}
                </span>
              )}
            </div>
            <p style={styles.statusLine}>{statusText(t, status)}</p>
            {status?.detail !== undefined && status.detail !== '' && (
              <p style={styles.statusLine}>{status.detail}</p>
            )}
            {errors[id] !== undefined && <p style={styles.errorLine}>{errors[id]}</p>}
            {accounts.map((account) => {
              const usageKey = `${id}:${account.key}`
              const usage = usages[usageKey]
              const usageError = usageErrors[usageKey]
              const display = account.account ?? account.key
              const sortedCredits = [...(usage?.resetCredits ?? [])].sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))
              const nextReset = sortedCredits.find(c => c.expiresAt === undefined || c.expiresAt > Date.now())
              const resetBlock = usage ? resetActionBlock(usage) : 'resetUseRefresh'
              const resetDisabled = resetBusy || resetBlock !== undefined
              // Providers without a usage endpoint answer supported:false — no block.
              const showUsage = usage?.supported !== false
                && (usage !== undefined || usageError !== undefined || usageLoading[usageKey] === true)
              return (
                <div key={account.key} style={styles.accountRow}>
                  <div style={styles.accountHeader}>
                    <button
                      type="button"
                      style={styles.starButton}
                      title={account.isDefault ? t('defaultBadge') : t('setDefault')}
                      onClick={() => {
                        if (!account.isDefault) void setDefault(id, account.key)
                      }}
                    >
                      {account.isDefault ? '★' : '☆'}
                    </button>
                    <span style={styles.accountName}>{display}</span>
                    {account.plan !== undefined && (
                      <span style={styles.usagePlan}>{account.plan}</span>
                    )}
                    {account.expiresAt !== undefined && (
                      <span style={styles.statusLine}>
                        {t('accountExpires', { date: new Date(account.expiresAt).toLocaleString() })}
                      </span>
                    )}
                    <button
                      type="button"
                      style={{ ...styles.button, marginLeft: 'auto', flexShrink: 0 }}
                      onClick={() => { void logout(id, account.key, display, name) }}
                    >
                      {t('logout')}
                    </button>
                  </div>
                  {showUsage && (
                    <div style={styles.usage}>
                      <div style={styles.usageHeader}>
                        <span style={styles.usageTitle}>{t('usageTitle')}</span>
                        {usage?.plan !== undefined && (
                          <span style={styles.usagePlan}>{t('usagePlan', { plan: usage.plan })}</span>
                        )}
                        <button
                          type="button"
                          style={{ ...styles.usageRefresh, ...usageLoading[usageKey] === true ? { opacity: 0.5, cursor: 'default' } : {} }}
                          disabled={usageLoading[usageKey] === true}
                          onClick={() => { void loadUsage(id, account.key, true) }}
                        >
                          {t('usageRefresh')}
                        </button>
                      </div>
                      {usage === undefined && usageError === undefined && (
                        <p style={styles.statusLine}>{t('usageLoading')}</p>
                      )}
                      {usageError !== undefined && (
                        <p style={styles.errorLine}>{t('usageError', { message: usageError })}</p>
                      )}
                      {usage?.windows !== undefined && usage.windows.length === 0 && (
                        <p style={styles.statusLine}>{t('usageEmpty')}</p>
                      )}
                      {(usage?.windows ?? []).map((window, index) => {
                        const percent = displayUsedPercent(window.usedPercent)
                        return (
                          <div key={index} style={styles.usageRow}>
                            <div style={styles.usageMeta}>
                              <span>{usageWindowLabel(t, window)}</span>
                              <span>
                                {percent === undefined ? t('usageMeterInvalid') : `${percent}%`}
                                {window.resetsAt !== undefined
                                  && ` · ${t('usageResets', { date: new Date(window.resetsAt).toLocaleString() })}`}
                              </span>
                            </div>
                            <UsageMeter window={window} t={t} observedAt={observedAt[usageKey]} stale={usageError !== undefined || usage.stale === true} />
                          </div>
                        )
                      })}
                      {id === 'codex' && usage?.resetCreditsError !== undefined && (
                        <p style={styles.errorLine}>{t('resetCreditsError', { message: usage.resetCreditsError })}</p>
                      )}
                      {id === 'codex' && usage?.resetCredits !== undefined && (
                        <details className="subscriptions-reset-credits" style={styles.usageRow}>
                          <summary style={{ ...styles.usageMeta, cursor: 'pointer', listStyle: 'none', justifyContent: 'flex-start', gap: 6 }}>
                            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
                              <path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <span>{t('resetCreditsTitle')}</span>
                            <span style={{ marginLeft: 'auto' }}>{t('resetCreditsAvailable', { count: usage.resetCredits.length })}</span>
                          </summary>
                          <style>{
                            '.subscriptions-reset-credits > summary::-webkit-details-marker { display: none; }'
                            + '.subscriptions-reset-credits[open] > summary > svg { transform: rotate(90deg); }'
                          }</style>
                          <div style={{ paddingLeft: 18, marginTop: 6 }}>
                            {sortedCredits.map((credit, index) => (
                              <div key={credit.id ?? index} style={{ ...styles.usageMeta, minHeight: 28, gap: 12 }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                                  {t('resetCreditFull')}
                                  {credit === nextReset && (
                                    <button type="button" aria-disabled={resetDisabled}
                                      title={t(resetBusy ? 'resetUseChecking' : resetBlock ?? 'resetUseReady')}
                                      style={{ ...styles.button, height: 22, padding: '0 7px', borderRadius: 6,
                                        opacity: resetDisabled ? 0.35 : 1, cursor: resetDisabled ? 'not-allowed' : 'pointer' }}
                                      onClick={() => { if (!resetDisabled) void prepareReset(account.key) }}>
                                      {resetBusy && resetAccount === account.key ? t('resetUseChecking') : t('resetUseButton')}
                                    </button>
                                  )}
                                </span>
                                <span style={{ textAlign: 'right' }}>{credit.expiresAt === undefined ? t('resetCreditExpiryUnknown') : t('resetCreditExpires', { date: new Date(credit.expiresAt).toLocaleString() })}</span>
                              </div>
                            ))}
                            {resetAccount === account.key && resetMessage && <p role="status" style={styles.statusLine}>{resetMessage}</p>}
                          </div>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            <div style={styles.actions}>
              {!busy && accounts.length === 0 && (
                <button type="button" style={styles.button} onClick={() => { void login(id) }}>
                  {t('login')}
                </button>
              )}
              {!busy && accounts.length > 0 && id === 'claude' && (
                <>
                  <button type="button" style={styles.button} onClick={() => { void login(id, 'oauth') }}>
                    {t('addAccountOAuth')}
                  </button>
                  <button type="button" style={styles.button} onClick={() => { void login(id, 'keychain') }}>
                    {t('addAccountKeychain')}
                  </button>
                </>
              )}
              {!busy && accounts.length > 0 && id !== 'claude' && (
                <button type="button" style={styles.button} onClick={() => { void login(id) }}>
                  {t('addAccount')}
                </button>
              )}
              <button type="button" style={styles.button} aria-haspopup="dialog"
                onClick={() => setManagedProvider({ id, name })}>
                {t('accountsManage')}
              </button>
              {busy && (
                <button type="button" style={styles.button} onClick={() => { void cancel(id) }}>
                  {t('cancel')}
                </button>
              )}
            </div>
            {!busy && accounts.length > 0 && (
              <p style={styles.statusLine}>{t('addAccountHint')}</p>
            )}

            {busy && deviceCode !== undefined && (
              <div style={styles.deviceCode}>
                <span style={styles.statusLine}>{t('deviceCodePrompt')}</span>
                <span style={styles.deviceCodeText}>{deviceCode.userCode}</span>
                <div style={styles.actions}>
                  <button type="button" style={styles.button} onClick={() => { copyDeviceCode(id, deviceCode.userCode) }}>
                    {copiedCode === id ? t('deviceCodeCopied') : t('deviceCodeCopy')}
                  </button>
                  <button
                    type="button"
                    style={styles.button}
                    onClick={() => { window.open(deviceCode.verificationUrl, '_blank', 'noopener') }}
                  >
                    {t('deviceCodeOpenPage')}
                  </button>
                </div>
              </div>
            )}
            {busy && deviceCode === undefined && (
              <details style={styles.manual}>
                <summary>{t('manualSummary')}</summary>
                <div style={styles.manualRow}>
                  <input
                    style={styles.manualInput}
                    value={manualDrafts[id]}
                    placeholder={t('manualPlaceholder')}
                    onChange={event => setManualDrafts(prev => ({ ...prev, [id]: event.target.value }))}
                  />
                  <button type="button" style={styles.button} onClick={() => { void submitManual(id) }}>
                    {t('submit')}
                  </button>
                </div>
              </details>
            )}
          </div>
        )
      })}
      <CursorCard rpc={rpc} t={t} />
      <ExternalUsageCards rpc={rpc} t={t} />
      {managedProvider && <ProviderAccountManager provider={managedProvider.id} name={managedProvider.name}
        rpc={rpc} t={t} onClose={() => setManagedProvider(undefined)} />}
      <style>{'.subscriptions-reset-dialog::backdrop { background: rgba(0,0,0,.5); }'}</style>
      <dialog ref={resetDialogRef} className="subscriptions-reset-dialog"
        aria-labelledby="subscriptions-reset-title" onCancel={() => setResetConfirmation(undefined)}
        onClose={() => setResetConfirmation(undefined)}
        style={{ ...styles.modal, display: resetConfirmation ? 'flex' : 'none', margin: 'auto', color: 'var(--dsw-alias-label-primary)' }}>
        {resetConfirmation && <>
          <h3 id="subscriptions-reset-title" style={{ ...styles.modalTitle, margin: 0 }}>{t('resetUseConfirmTitle')}</h3>
          <p style={{ ...styles.statusLine, overflowWrap: 'anywhere' }}>{statuses.codex?.accounts.find(a => a.key === resetConfirmation.account)?.account ?? resetConfirmation.account}</p>
          <div style={{ ...styles.usageMeta, gap: 12 }}>
            <span>{t('usageWeekly')}</span><strong>{Math.round(resetConfirmation.weeklyUsedPercent)}%</strong>
          </div>
          <div style={styles.usageMeta}>
            <span>{resetConfirmation.creditExpiresAt === undefined ? t('resetCreditExpiryUnknown') : t('resetCreditExpires', { date: new Date(resetConfirmation.creditExpiresAt).toLocaleString() })}</span>
          </div>
          <p style={{ ...styles.statusLine, margin: '4px 0' }}>{t('resetUseWarning')}</p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }}>
            <input type="checkbox" checked={resetAcknowledged} onChange={e => setResetAcknowledged(e.target.checked)} />
            {t('resetUseAcknowledge')}
          </label>
          <div style={{ ...styles.actions, justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" autoFocus style={styles.button} onClick={() => setResetConfirmation(undefined)}>{t('cancel')}</button>
            <button type="button" style={{ ...styles.button, opacity: resetAcknowledged ? 1 : 0.35,
              cursor: resetAcknowledged ? 'pointer' : 'not-allowed' }} disabled={!resetAcknowledged || resetBusy}
              onClick={() => { void consumeReset() }}>{t('resetUseConfirm')}</button>
          </div>
        </>}
      </dialog>
    </div>
  )
}
