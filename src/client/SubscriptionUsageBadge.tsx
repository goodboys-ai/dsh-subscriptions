/**
 * Subscription usage badge: a stats pill in the composer's dock
 * (`conversation.composer.dock`), modelled on the host's own token-usage
 * pill. Collapsed, it shows the rate-limit windows of the provider behind the
 * session's CURRENT model (a GPT model → Codex usage, a Claude model → Claude
 * usage); clicking it opens a trigger-anchored dialog listing every logged-in
 * account of every provider, with long window lists collapsed into previews,
 * the current provider first and the default account (starred) first within
 * a provider. Model-scoped Antigravity usage follows the current model.
 *
 * Usage rides the `subscriptions-auth` usage endpoints on a slow
 * poll (the server shares its cache across UI surfaces); the current model
 * comes from ui-model-selection's `modelDirectories` service on a quicker
 * poll, since the host pushes nothing on a model switch. Renders nothing when
 * no connected provider reports usage.
 *
 * The collapsed pill reads only the default account — the same account
 * direct (non-pool) routes serve — so it stays one short segment even for a
 * provider with several accounts connected; the dialog shows them all.
 * Every color resolves through a `--dsw-*` design token, the dialog wears the
 * host's menu material (its translucent fill plus its backdrop blur), and
 * every user-visible string goes through the locale `t` of the
 * 'settings.subscriptions' namespace.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentType, CSSProperties } from 'react'
import { subscriptionChromeCss } from './provider-settings-styles.js'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { callSubscriptionsAuth } from './SubscriptionsSection.js'
import { UsageMeter } from './UsageMeter.js'
import { displayUsedPercent } from './usage-pace.js'
import type { AccountStatus, ProviderStatus, ProviderUsage, SubscriptionProvider, UsageWindow } from './SubscriptionsSection.js'
import type { ModelDirectoriesLike } from './SpeedSelect.js'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'
import { hostIcon } from './host-icons.js'
import { USAGE_BADGE_REFRESH_EVENT, useUsageBadgeMode } from './usage-badge-preferences.js'

/** DSH renamed the data icon in 0.1.7; retain older supported hosts too. */
export function usageBadgeIcon(icons: {
  IconDataOutlineRegular?: ComponentType
  IconDataOutline16?: ComponentType
}): ComponentType {
  return hostIcon(icons, 'DataOutline')
}
const UsageBadgeIcon = usageBadgeIcon(primitives)

/** How often the badge re-reads usage; the server also shares its own cache/negative-cache across UI surfaces. */
const USAGE_POLL_INTERVAL_MS = 15 * 60_000

/** How often the badge re-reads the session's current model (model switches arrive only by asking). */
const MODEL_POLL_INTERVAL_MS = 3000

/** How long the rotation holds one provider in `always` mode (a display cadence, not a data poll). */
const BADGE_ROTATION_INTERVAL_MS = 10_000

/** Distance between the trigger's top edge and the dialog's bottom (host stat dialogs use the same). */
const PANEL_GAP = 8

/** Distance kept between the dialog and each viewport edge. */
const PANEL_MARGIN = 12

/** Injected dependencies (slot `inject`, session-bound). */
export interface SubscriptionUsageBadgeInjected {
  /** Connection RPC caller to reach the `subscriptions-auth` endpoints. */
  rpc: ConnectionHandle['rpc']
  /** Resolve the session's effective provider and model together. */
  currentModel: () => Promise<{ provider: string; model: string } | undefined>
}

/** Props delivered by the slot outlet + inject + the locale seat. */
export type SubscriptionUsageBadgeProps = PropsRuntime<'conversation.composer.dock'>
  & Partial<SubscriptionUsageBadgeInjected>
  & Partial<PropsLocale<'settings.subscriptions'>>
  /** Override the rotation cadence (tests only; the slot never passes it). */
  & { rotationMs?: number }

/** One logged-in account's usage windows, as listed in the expanded dialog. */
export interface AccountUsageDisplay {
  /** Account key (the `usage` endpoint's `account` argument). */
  key: string
  /** Display handle (email / login), when the provider reports one. */
  account?: string
  plan?: string
  /** The account direct routes serve; the collapsed pill reads this one. */
  isDefault: boolean
  windows: UsageWindow[]
  observedAt?: number | undefined
  stale?: boolean | undefined
}

/** One provider's usage snapshot: every logged-in account that reports windows. */
export interface ProviderUsageDisplay {
  provider: BadgeProvider
  name: string
  /** Default account first, then the rest in the `status` endpoint's order. */
  accounts: AccountUsageDisplay[]
}

/** The account the collapsed pill reads: the default one, else the first listed. */
export function pillAccountOf(d: ProviderUsageDisplay): AccountUsageDisplay {
  return d.accounts.find(a => a.isDefault) ?? d.accounts[0]!
}

/** Brand display names (short form for the compact badge). */
export type BadgeProvider = SubscriptionProvider | 'cursor-subscription' | 'opencode-go' | 'kimi-coding' | 'minimax' | 'minimax-cn'

const PROVIDER_NAMES: Record<BadgeProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
  'cursor-subscription': 'Cursor',
  'opencode-go': 'OpenCode Go',
  'kimi-coding': 'Kimi Code',
  'minimax': 'MiniMax',
  'minimax-cn': 'MiniMax CN',
}

export interface UsageRosterEntry { provider: BadgeProvider; account: AccountStatus }

/** Key of one account's cached windows: `provider:accountKey`. */
function usageKeyOf(provider: BadgeProvider, account: AccountStatus): string {
  return `${provider}:${account.key}`
}

/**
 * Group per-account usage into the badge's provider rows, in roster order
 * (the `status` provider order, default account first) so rows don't jump
 * around as polls settle at different times. An account without windows is
 * left out, and so is a provider whose accounts all lack windows.
 * @param roster - accounts from {@link loadBadgeRoster}.
 * @param windowsOf - each account's windows, keyed `provider:accountKey`.
 * @param plans - the plan each usage call reported, same keys; the roster's plan is the fallback.
 * @returns one display per provider with at least one account that has windows.
 */
export function groupUsageDisplays(
  roster: readonly UsageRosterEntry[],
  windowsOf: ReadonlyMap<string, UsageWindow[]>,
  plans: ReadonlyMap<string, string>,
): ProviderUsageDisplay[] {
  const byProvider = new Map<BadgeProvider, ProviderUsageDisplay>()
  for (const { provider, account } of roster) {
    const key = usageKeyOf(provider, account)
    const windows = windowsOf.get(key)
    if (windows === undefined) continue
    const plan = plans.get(key) ?? account.plan
    const row: AccountUsageDisplay = {
      key: account.key,
      isDefault: account.isDefault,
      ...account.account === undefined ? {} : { account: account.account },
      ...plan === undefined ? {} : { plan },
      windows,
    }
    const display = byProvider.get(provider)
    if (display === undefined) byProvider.set(provider, { provider, name: PROVIDER_NAMES[provider], accounts: [row] })
    else display.accounts.push(row)
  }
  return [...byProvider.values()]
}

/** Read each account source independently so a failing endpoint cannot hide the others. */
export async function loadBadgeRoster(rpc: ConnectionHandle['rpc']): Promise<{
  roster: UsageRosterEntry[]
  refreshed: Set<BadgeProvider>
}> {
  const [subscriptions, cursor, external] = await Promise.allSettled([
    callSubscriptionsAuth<{ providers: Record<SubscriptionProvider, ProviderStatus> }>(rpc, 'status', {}),
    callSubscriptionsAuth<{ authenticated: boolean }>(rpc, 'cursorStatus', {}),
    callSubscriptionsAuth<Record<'opencode-go' | 'kimi-code' | 'minimax' | 'minimax-cn', { configured: boolean }>>(rpc, 'externalStatus', {}),
  ])
  const roster: UsageRosterEntry[] = []
  const refreshed = new Set<BadgeProvider>()
  if (subscriptions.status === 'fulfilled') {
    for (const provider of ['codex', 'claude', 'grok', 'copilot', 'antigravity'] as const) {
      refreshed.add(provider)
      for (const account of accountsOf(subscriptions.value.providers[provider])) roster.push({ provider, account })
    }
  }
  if (cursor.status === 'fulfilled') {
    refreshed.add('cursor-subscription')
    if (cursor.value.authenticated) roster.push({
      provider: 'cursor-subscription', account: { key: 'cursor', isDefault: true },
    })
  }
  if (external.status === 'fulfilled') {
    for (const [source, provider] of [
      ['opencode-go', 'opencode-go'], ['kimi-code', 'kimi-coding'], ['minimax', 'minimax'], ['minimax-cn', 'minimax-cn'],
    ] as const) {
      refreshed.add(provider)
      if (external.value[source]?.configured) roster.push({
        provider, account: { key: source, isDefault: true },
      })
    }
  }
  return { roster, refreshed }
}

export async function usageOf(rpc: ConnectionHandle['rpc'], { provider, account }: UsageRosterEntry): Promise<ProviderUsage> {
  if (provider === 'cursor-subscription') return callSubscriptionsAuth(rpc, 'cursorUsage', {})
  if (provider === 'opencode-go' || provider === 'kimi-coding' || provider === 'minimax' || provider === 'minimax-cn') {
    return callSubscriptionsAuth(rpc, 'externalUsage', { source: provider === 'kimi-coding' ? 'kimi-code' : provider })
  }
  return callSubscriptionsAuth(rpc, 'usage', { provider, account: account.key })
}

/**
 * The `currentModel` half of the inject face: the session's effective
 * model selection through ui-model-selection's `modelDirectories` service,
 * resolved lazily per call (the service may register after this plugin, and
 * a shell without it reports "unknown"; the badge keeps the most recent
 * subscription selected in this view, or stays hidden).
 */
export function createCurrentModelReader(
  models: () => ModelDirectoriesLike | undefined,
  sessionId: string,
): SubscriptionUsageBadgeInjected['currentModel'] {
  return async () => {
    const directories = models()
    if (directories === undefined) return undefined
    const { current } = await directories.directoryFor(sessionId).load()
    return current ?? undefined
  }
}

/**
 * Compact time-remaining label derived from the window's `resetsAt` timestamp:
 * "6d18h" (days+hours), "1h58m" (hours+minutes), or "42m" (minutes only).
 * Falls back to the scope/kind abbreviation when no reset time is known.
 */
export function windowLabel(w: UsageWindow): string {
  if (w.resetsAt === undefined || !Number.isFinite(w.resetsAt)) {
    if (w.scope !== undefined && w.scope !== '') return w.scope
    switch (w.kind) {
      case 'session': return '5h'
      case 'weekly': return 'Wk'
      default: return 'W'
    }
  }
  const ms = Math.max(0, w.resetsAt - Date.now())
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d${hours % 24}h`
  if (hours > 0) return `${hours}h${minutes % 60}m`
  return `${Math.max(1, minutes)}m`
}

/**
 * One compact segment piece (`6d1h 25%`); an unusable provider percentage
 * renders as the no-data dash, consistent with the meter's unavailable state.
 */
function windowSegment(label: string, w: UsageWindow): string {
  const percent = displayUsedPercent(w.usedPercent)
  return percent === undefined ? `${label} —` : `${label} ${percent}%`
}

/** Keep model quotas separate: matching percentages do not imply a shared pool. */
export function prioritizeWindows(windows: readonly UsageWindow[], model?: string): UsageWindow[] {
  return model === undefined ? [...windows] : [
    ...windows.filter(w => w.scope === model),
    ...windows.filter(w => w.scope !== model),
  ]
}

/** Small previews keep a live model catalog from taking over the dialog. */
export const WINDOW_PREVIEW_LIMIT = 4
export function previewWindows(windows: readonly UsageWindow[], model?: string, provider?: BadgeProvider) {
  const ordered = prioritizeWindows(windows, model)
  // Antigravity has many model-specific quotas: preview only the current model.
  const limit = provider === 'antigravity'
    ? Math.min(2, model === undefined ? 0 : windows.filter(w => w.scope === model).length)
    : WINDOW_PREVIEW_LIMIT
  return { shown: ordered.slice(0, limit), hidden: ordered.slice(limit) }
}

/** Bounded readout; Antigravity quotas belong to individual models, not the account. */
export function compactSegment(d: ProviderUsageDisplay, model?: string, t: Translate = fallbackTranslate): string {
  const windows = pillAccountOf(d).windows
  if (d.provider === 'antigravity') {
    const matching = model === undefined ? [] : windows.filter(w => w.scope === model)
    if (matching.length === 0) {
      return `${d.name} ${t(model === undefined ? 'usageBadgeModelCount' : 'usageBadgeModelUnavailable', {
        count: new Set(windows.map(w => w.scope).filter(Boolean)).size,
      })}`
    }
    const parts = matching.slice(0, 2).map(w => windowSegment(w.kind === 'weekly' ? t('usageWeekly') : t('usageWindow'), w))
    return `${d.name} ${parts.join(' · ')}`
  }
  const parts = windows.slice(0, 2).map(w => windowSegment(windowLabel(w), w))
  if (windows.length > 2) parts.push(`+${windows.length - 2}`)
  return `${d.name} ${parts.join(' · ')}`
}

type ModelSelection = { provider: string; model: string }

/** Remember only the most recent subscription in this view, including its model scope. */
export function retainSubscriptionSelection(
  previous: ModelSelection | undefined,
  current: ModelSelection | undefined,
): ModelSelection | undefined {
  return current !== undefined && Object.hasOwn(PROVIDER_NAMES, current.provider) ? current : previous
}

/** At most one provider; no known selection or no usage means no badge. */
export function collapsedDisplays(
  displays: readonly ProviderUsageDisplay[],
  current: string | undefined,
): readonly ProviderUsageDisplay[] {
  const match = displays.find(d => d.provider === current)
  return match === undefined ? [] : [match]
}

/**
 * `always` mode: the current model's provider while it reports usage,
 * otherwise the rotation steps through the providers that do, in display
 * order, wrapping around. The index is taken modulo the current provider
 * count, so providers appearing or dropping out stay inside range; the
 * sequence itself may shift when the roster changes. Unlike `recent`, the
 * retained subscription does not pin the pill — that retention is exactly
 * what this mode exists to escape.
 * @param displays - providers with usage, in display order.
 * @param current - the provider of the session's current model.
 * @param step - rotation tick; consecutive ticks advance one provider.
 */
export function rotatingDisplay(
  displays: readonly ProviderUsageDisplay[],
  current: string | undefined,
  step: number,
): readonly ProviderUsageDisplay[] {
  if (displays.length === 0) return []
  const match = displays.find(d => d.provider === current)
  if (match !== undefined) return [match]
  const index = Number.isFinite(step) ? Math.floor(step) : 0
  return [displays[((index % displays.length) + displays.length) % displays.length]!]
}

/** Order for the expanded dialog: the current provider first, the rest in poll order. */
export function expandedDisplays(
  displays: readonly ProviderUsageDisplay[],
  current: string | undefined,
): readonly ProviderUsageDisplay[] {
  const match = displays.find(d => d.provider === current)
  return match === undefined ? displays : [match, ...displays.filter(d => d !== match)]
}

/**
 * A provider's logged-in accounts, the effective default first. When no
 * account is flagged default the first listed stands in, matching what
 * direct routes fall back to.
 */
function accountsOf(status: ProviderStatus | undefined): AccountStatus[] {
  if (status === undefined || status.accounts.length === 0) return []
  const fallback = status.accounts.find(a => a.isDefault) ?? status.accounts[0]!
  return status.accounts
    .map(a => (a === fallback ? { ...a, isDefault: true } : a))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  return en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Localized label of one usage window (kind, plus the model scope when named). */
function usageWindowLabel(t: Translate, window: UsageWindow): string {
  const base = window.kind === 'session'
    ? t('usageSession')
    : window.kind === 'weekly' ? t('usageWeekly') : t('usageWindow')
  return window.scope !== undefined && window.scope !== '' ? `${base} · ${window.scope}` : base
}

/**
 * The composer subscription-usage badge: a pill reading e.g.
 * `Codex 6d1h 25%` for the current model's provider, opening a dialog with
 * every provider's accounts and their windows. Returns null when no data is
 * available.
 */
export function SubscriptionUsageBadge({ rpc, currentModel, t, rotationMs }: SubscriptionUsageBadgeProps) {
  const translate: Translate = t ?? fallbackTranslate
  const [displays, setDisplays] = useState<ProviderUsageDisplay[]>([])
  const [selection, setSelection] = useState<ModelSelection | undefined>(undefined)
  const [lastSubscription, setLastSubscription] = useState<ModelSelection | undefined>(undefined)
  const displayMode = useUsageBadgeMode()
  const current = selection?.provider
  const badgeSelection = retainSubscriptionSelection(lastSubscription, selection)
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  // Rotation tick for `always` mode; the interval runs only in that mode.
  const [rotation, setRotation] = useState(0)
  // The provider the pill showed when the dialog opened; an open dialog
  // keeps leading with it while the rotation keeps ticking underneath.
  const [dialogLead, setDialogLead] = useState<string | undefined>(undefined)
  const inflightRef = useRef(false)
  const mountedRef = useRef(true)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Always-rendered, invisible marker in the dock: locates the composer bar
  // (and the host stats row inside it) even while the pill itself is portaled.
  const seatRef = useRef<HTMLSpanElement | null>(null)
  // The inject face may be re-evaluated (new callback identities) on
  // re-render; the model poll mounts once and reads through this ref.
  const currentRef = useRef(currentModel)
  currentRef.current = currentModel
  // Last-known-good windows per account (keyed `provider:accountKey`), kept
  // across a failed poll (e.g. a 429 during the server's own negative-cache
  // cooldown) so a row doesn't flicker away — it only disappears once the
  // account actually logs out or a fetch succeeds but reports the window as
  // unsupported. Observation metadata (freshness) shares this lifecycle: an
  // entry is dropped wherever its windows are dropped.
  const lastKnownRef = useRef(new Map<string, UsageWindow[]>())
  const observationsRef = useRef(new Map<string, { observedAt?: number | undefined; stale: boolean }>())

  const refresh = useCallback(async (): Promise<void> => {
    if (rpc === undefined || inflightRef.current) return
    inflightRef.current = true
    try {
      const { roster, refreshed } = await loadBadgeRoster(rpc)
      if (!mountedRef.current) return

      const lastKnown = lastKnownRef.current
      // Drop last-known state for anything no longer logged in — that is a
      // real signal, unlike a fetch failure.
      const live = new Set(roster.map(({ provider, account }) => usageKeyOf(provider, account)))
      for (const key of lastKnown.keys()) {
        if (refreshed.has(key.split(':', 1)[0] as BadgeProvider) && !live.has(key)) {
          lastKnown.delete(key)
          observationsRef.current.delete(key)
        }
      }

      const results = await Promise.allSettled(
        roster.map(async ({ provider, account }) => {
          const usage = await usageOf(rpc, { provider, account })
          return { provider, account, usage }
        }),
      )
      if (!mountedRef.current) return

      for (const { provider, account } of roster) {
        const key = usageKeyOf(provider, account)
        observationsRef.current.set(key, { ...observationsRef.current.get(key), stale: true })
      }
      const plans = new Map<string, string>()
      for (const r of results) {
        if (r.status !== 'fulfilled') continue // keep whatever is cached for this account
        const { provider, account, usage } = r.value
        const key = usageKeyOf(provider, account)
        if (usage.plan !== undefined) plans.set(key, usage.plan)
        if (!usage.supported || !usage.windows || usage.windows.length === 0) {
          lastKnown.delete(key)
          observationsRef.current.delete(key)
          continue
        }
        lastKnown.set(key, usage.windows)
        observationsRef.current.set(key, { observedAt: usage.observedAt ?? Date.now(), stale: usage.stale === true })
      }

      setDisplays(previous => [
        ...groupUsageDisplays(roster, lastKnown, plans).map(display => ({ ...display,
          accounts: display.accounts.map(account => ({ ...account,
            ...observationsRef.current.get(`${display.provider}:${account.key}`),
          })),
        })),
        ...previous.filter(display => !refreshed.has(display.provider)).map(display => ({ ...display,
          accounts: display.accounts.map(account => ({ ...account, stale: true })),
        })),
      ])
    } catch {
      // Keep cached numbers, but never present failed observations as current.
      if (mountedRef.current) setDisplays(previous => previous.map(display => ({ ...display,
        accounts: display.accounts.map(account => ({ ...account, stale: true })),
      })))
    } finally {
      inflightRef.current = false
    }
  }, [rpc])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Hidden renders nothing, so it polls nothing; showing it again refreshes at once.
  useEffect(() => {
    if (displayMode === 'hidden') return
    void refresh()
    const timer = setInterval(() => { void refresh() }, USAGE_POLL_INTERVAL_MS)
    window.addEventListener(USAGE_BADGE_REFRESH_EVENT, refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener(USAGE_BADGE_REFRESH_EVENT, refresh)
    }
  }, [refresh, displayMode])

  useEffect(() => {
    if (currentRef.current === undefined) return
    let cancelled = false
    let inflight = false
    const reload = (): void => {
      const read = currentRef.current
      if (read === undefined || inflight) return
      inflight = true
      void read().then(
        (model) => {
          if (cancelled) return
          setLastSubscription(previous => retainSubscriptionSelection(previous, model))
          setSelection(model)
        },
        () => { /* keep the last known provider; the next tick retries */ },
      ).finally(() => { inflight = false })
    }
    reload()
    const timer = setInterval(reload, MODEL_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  // Sit on the host's stats row when there is one. Every dock entry is its
  // own row in the composer bar, so a badge rendered in place lands under the
  // shipped time/token pills; the host marks its pill row with
  // `data-composer-stats`, and rendering into it makes the badge a third pill
  // on that line. The marker is watched (the row mounts only once the session
  // has steps or tokens, and unmounts with them) and older hosts without it
  // keep the in-place row.
  const [statsRow, setStatsRow] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const seat = seatRef.current
    if (seat === null) return
    const scope = statsScopeOf(seat)
    if (scope === null) return
    const find = (): HTMLElement | null => scope.querySelector<HTMLElement>('[data-composer-stats]')
    setStatsRow(find())
    const observer = new MutationObserver(() => { setStatsRow(find()) })
    observer.observe(scope, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    if (displayMode === 'hidden') setOpen(false)
  }, [displayMode])

  // `always` mode advances the rotation on its own cadence; other modes
  // never advance, so the pill never changes on its own.
  useEffect(() => {
    if (displayMode !== 'always') return
    const interval = rotationMs !== undefined && Number.isFinite(rotationMs) && rotationMs > 0
      ? rotationMs
      : BADGE_ROTATION_INTERVAL_MS
    const timer = setInterval(() => { setRotation(step => step + 1) }, interval)
    return () => { clearInterval(timer) }
  }, [displayMode, rotationMs])

  const seat = <span ref={seatRef} style={styles.seat} aria-hidden />
  // `always` follows the live model, not the retained subscription: the
  // retention pins the pill in `recent`, which is what this mode escapes.
  const collapsed = displayMode === 'always'
    ? rotatingDisplay(displays, current, rotation)
    : collapsedDisplays(displays, badgeSelection?.provider)
  if (displayMode === 'hidden' || collapsed.length === 0) return seat

  // Model scope only while the pill shows the current model's provider;
  // a rotated provider has no live model, so it reads at account level.
  const pillModel = displayMode === 'always'
    ? (current === collapsed[0]?.provider ? selection?.model : undefined)
    : badgeSelection?.model
  const label = compactSegment(collapsed[0]!, pillModel, translate)
  // The dialog opens from the badge, so it follows the provider and model the
  // badge shows (a retained subscription when the current model is not one).
  // In `always` mode the pill moves under the cursor, so an open dialog keeps
  // the provider that was showing when it opened instead of reordering live.
  const dialogProvider = open && displayMode === 'always' ? dialogLead : badgeSelection?.provider
  const dialogModel = open && displayMode === 'always'
    ? (dialogLead === current ? selection?.model : undefined)
    : badgeSelection?.model
  const expanded = expandedDisplays(displays, dialogProvider)
  const title = translate('usageBadgeTitle')

  const toggle = (): void => {
    const next = !open
    setDialogLead(collapsed[0]?.provider)
    setOpen(next)
    if (next) void refresh()
  }

  const pill = (
    <span ref={rootRef} style={styles.anchor}>
      <style>{subscriptionChromeCss}</style>
      <button
        type="button"
        className="dsh-subscription-usage-pill"
        style={{ ...styles.pill, ...(hover || open ? styles.pillActive : {}) }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${title} · ${label}`}
        title={title}
        onMouseEnter={() => { setHover(true) }}
        onMouseLeave={() => { setHover(false) }}
        onClick={toggle}
      >
        <UsageBadgeIcon />
        <span style={styles.label}>{label}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={title}
          className="dsh-subscription-usage-panel"
          style={{ ...styles.panel, ...(pos ?? MEASURE_STYLE) }}
        >
          <div style={styles.title}>
            <span style={styles.titleLabel}>
              <UsageBadgeIcon />
              {title}
            </span>
          </div>
          <div style={styles.titleRule} aria-hidden />
          {expanded.map((d, index) => (
            <section key={d.provider} style={index === 0 ? undefined : styles.section}>
              <div style={styles.providerRow}>
                <span style={styles.providerName}>
                  {d.name}
                  {d.provider === current && <span style={styles.currentTag}>{translate('usageBadgeCurrent')}</span>}
                </span>
                {d.accounts.length === 1 && <AccountMeta account={d.accounts[0]!} translate={translate} />}
              </div>
              {d.accounts.map((account, accountIndex) => (
                <div key={account.key} style={accountIndex === 0 ? undefined : styles.accountBlock}>
                  {d.accounts.length > 1 && (
                    <div style={styles.accountRow}>
                      <AccountMeta account={account} translate={translate} />
                    </div>
                  )}
                  <AccountWindows
                    key={`${d.provider}:${dialogModel ?? ''}`}
                    windows={account.windows}
                    observedAt={account.observedAt} stale={account.stale}
                    model={d.provider === dialogProvider ? dialogModel : undefined}
                    provider={d.provider}
                    translate={translate}
                  />
                </div>
              ))}
            </section>
          ))}
        </div>,
        document.body,
      )}
    </span>
  )

  return (
    <>
      {seat}
      {statsRow !== null && statsRow.isConnected ? createPortal(pill, statsRow) : pill}
    </>
  )
}

/**
 * Nearest ancestor of the dock seat that can contain the host's stats row:
 * the composer bar. Bounded so a badge in an unfamiliar layout never adopts
 * some other composer's pills.
 */
function statsScopeOf(seat: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = seat.parentElement
  for (let depth = 0; node !== null && depth < 4; depth++) {
    if (node.querySelector('[data-composer-stats]') !== null) return node
    node = node.parentElement
  }
  return seat.parentElement
}

/**
 * One account's handle and plan: `★ ys@example.com · 计划：pro`. The star
 * marks the default account (the one direct routes serve and the collapsed
 * pill reads), the same glyph Settings → 订阅 uses.
 */
function AccountMeta({ account, translate }: { account: AccountUsageDisplay; translate: Translate }) {
  const parts = [account.account, account.plan === undefined ? undefined : translate('usagePlan', { plan: account.plan })]
    .filter((part): part is string => part !== undefined && part !== '')
  return (
    <span style={styles.providerMeta} title={account.account}>
      {account.isDefault && <span style={styles.defaultStar} aria-label="default">★ </span>}
      {parts.join(' · ')}
    </span>
  )
}

/** Preview each account independently; all remaining quotas stay accessible. */
export function AccountWindows({ windows, model, provider, translate, observedAt, stale }: {
  windows: readonly UsageWindow[]; model: string | undefined; provider?: BadgeProvider; translate: Translate
  observedAt?: number | undefined; stale?: boolean | undefined
}) {
  const { shown, hidden } = previewWindows(windows, model, provider)
  const rows = (items: readonly UsageWindow[]) => (
    <dl style={styles.details}>
      {items.map((w, i) => (
        <WindowRow key={i} label={`${usageWindowLabel(translate, w)}${model !== undefined && w.scope === model ? ` · ${translate('usageBadgeCurrent')}` : ''}`} window={w} t={translate} observedAt={observedAt} stale={stale} />
      ))}
    </dl>
  )
  return <>
    {rows(shown)}
    {hidden.length > 0 && <details style={styles.moreWindows}>
      <summary style={styles.moreSummary}>{translate('usageBadgeMoreWindows', { count: hidden.length })}</summary>
      {rows(hidden)}
    </details>}
  </>
}

/** One `dt`/`dd` pair: window name → `25% · 6d1h`, with the bar underneath. */
function WindowRow({ label, window: w, t, observedAt, stale }: { label: string; window: UsageWindow; t: Translate; observedAt?: number | undefined; stale?: boolean | undefined }) {
  const percent = displayUsedPercent(w.usedPercent)
  return (
    <>
      <dt style={styles.dt}>{label}</dt>
      <dd style={styles.dd}>
        {percent === undefined ? t('usageMeterInvalid') : `${percent}%`}
        {w.resetsAt !== undefined && Number.isFinite(w.resetsAt) && <span style={styles.reset}> · {windowLabel(w)}</span>}
      </dd>
      <UsageMeter window={w} t={t} style={styles.bar} observedAt={observedAt} stale={stale} />
    </>
  )
}

/**
 * Unplaced portal panel: hidden but laid out so the clamp measures real
 * dimensions (the `useAnchoredPosition` measure pass).
 */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

const styles: Record<string, CSSProperties> = {
  seat: { display: 'none' },
  anchor: { minWidth: 0, maxWidth: '100%', display: 'inline-flex' },
  // Mirrors the host StatsPills pill so the badge reads as a sibling of the
  // shipped time/token pills.
  pill: {
    boxSizing: 'border-box', maxWidth: '100%',
    color: 'var(--dsw-alias-label-tertiary)',
    font: 'inherit', fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
    fontVariantNumeric: 'tabular-nums', lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))', whiteSpace: 'nowrap',
    background: 'transparent', border: 'none', borderRadius: 999,
    alignItems: 'center', gap: 6, padding: '1px 8px', display: 'inline-flex', cursor: 'pointer',
  },
  pillActive: {
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-secondary)',
  },
  label: { textOverflow: 'ellipsis', minWidth: 0, overflow: 'hidden' },
  // Mirrors the host stat-dialog panel. The menu fill is translucent by
  // design and only the host's backdrop blur keeps it readable as a surface:
  // without the blur the transcript behind the dialog stays sharp and shows
  // through the fill.
  panel: {
    position: 'fixed', zIndex: 1100, boxSizing: 'border-box',
    background: 'var(--dsw-specific-menu)',
    backdropFilter: 'var(--dsw-menu-backdrop-filter)',
    width: 'max-content', minWidth: 'min(300px, 100vw - 24px)', maxWidth: 'min(440px, 100vw - 24px)',
    maxHeight: 'min(560px, 100dvh - 24px)', overflowY: 'auto', overscrollBehavior: 'contain',
    boxShadow: 'var(--dsw-elevation-prominent)',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'default',
    border: 0, borderRadius: 'var(--dsw-radius-lg, 16px)', padding: 16, fontSize: 12, lineHeight: '18px',
  },
  title: {
    color: 'var(--dsw-alias-label-primary)', display: 'flex',
    justifyContent: 'space-between', gap: 16, marginBottom: 8, fontWeight: 500,
  },
  titleLabel: { alignItems: 'center', gap: 6, minWidth: 0, display: 'inline-flex' },
  titleRule: { borderTop: '0.5px solid var(--dsw-alias-border-l2)', marginBottom: 10 },
  section: { marginTop: 12, paddingTop: 10, borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
  providerRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, marginBottom: 6,
  },
  providerName: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 },
  currentTag: {
    fontSize: 10, lineHeight: '14px', fontWeight: 400, padding: '0 5px', borderRadius: 7,
    color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  providerMeta: {
    color: 'var(--dsw-alias-label-tertiary)', minWidth: 0, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  // Same star and color as the default-account marker in Settings → 订阅.
  defaultStar: { color: 'var(--dsw-alias-state-warn-label)' },
  accountBlock: { marginTop: 8 },
  accountRow: { display: 'flex', marginBottom: 4 },
  details: {
    color: 'var(--dsw-alias-label-tertiary)', display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) max-content', gap: '4px 16px', margin: 0,
  },
  moreWindows: { marginTop: 8 },
  moreSummary: { cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 },
  dt: { minWidth: 0, margin: 0, overflowWrap: 'anywhere' },
  dd: {
    minWidth: 0, margin: 0, color: 'var(--dsw-alias-label-secondary)',
    fontVariantNumeric: 'tabular-nums', textAlign: 'right',
  },
  reset: { color: 'var(--dsw-alias-label-tertiary)' },
  bar: {
    gridColumn: '1 / -1', height: 4, borderRadius: 2, overflow: 'hidden',
    background: 'var(--dsw-alias-border-l2)', marginBottom: 2,
  },
}
