/**
 * Codex Speed toggle: one small control in the composer's right tool row
 * (`conversation.input.right`), switching the session between standard routing
 * and the fast (priority) service tier — the Codex desktop app's Speed menu.
 * The choice is per session and lives in the node half (in-memory); this
 * component holds only viewing state. The control renders nothing until the
 * first load proves the session's current model is a codex model whose catalog
 * advertises the fast tier.
 *
 * Every color resolves through a `--dsw-alias-*` design token and every
 * user-visible string goes through the locale `t` of the
 * 'settings.subscriptions' namespace, same as the settings section.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type {
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { callSubscriptionsAuth } from './SubscriptionsSection.js'
import { subscriptionChromeCss } from './provider-settings-styles.js'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

/** One session's speed choice: standard routing or the fast (priority) tier. */
export type SpeedTier = 'standard' | 'fast'

/** `speed` endpoint value, mirrored from the node half. */
export interface SpeedState {
  tier: SpeedTier
  fastModels: string[]
}

/** What {@link SpeedSelect} renders from: visibility plus the current tier. */
export interface SpeedSelectState {
  visible: boolean
  tier: SpeedTier
}

/**
 * Minimal structural face of ui-model-selection's `ctx.modelDirectories`
 * service (the sanctioned cross-plugin channel: cordis services, not value
 * imports — same mirroring discipline as ToolCallOwnerProps). Both dsh lines
 * ship it with this shape; it replaces rc.2's `connection.api.sessions.models`
 * read, which the 0.1.2-alpha removed along with the whole `.api` face.
 */
/** Selected model pushed by ui-model-selection's directory store. */
export interface ModelSelectionSnapshot {
  current: { provider: string; model: string } | null
}

/**
 * The directory store (`ModelDirectory.store`). Present on hosts that publish
 * selection changes; absent on a directory that only offers `load()`.
 */
export interface ModelSelectionStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): ModelSelectionSnapshot
}

export interface ModelDirectoriesLike {
  /** Resolve one session's shared model directory (throws for unknown sessions). */
  directoryFor(sessionId: string): {
    /** Load the directory; `current` is the session's effective model selection. */
    load(): Promise<ModelSelectionSnapshot>
    /** Pushes selection changes. Missing when the host only offers `load()`. */
    store?: ModelSelectionStore
  }
}

/** Injected dependencies of {@link SpeedSelect} (slot `inject`, session-bound). */
export interface SpeedSelectInjected {
  /** Load the session's speed state; `visible` false keeps the control hidden. */
  loadSpeed: () => Promise<SpeedSelectState>
  /** Set the session's speed tier; resolves false when the write failed. */
  setSpeed: (tier: SpeedTier) => Promise<boolean>
  /**
   * Subscribe to the session's selected model. The listener runs when
   * `provider` or `model` changes, and once when a directory that was missing
   * at subscribe time becomes available. The returned function detaches it.
   */
  watchModel: (listener: () => void) => () => void
}

/**
 * Props delivered by the slot outlet: the framework session kit and InputZone
 * owner share (unused — everything arrives session-bound through the inject
 * face), the injected callbacks, and the locale seat.
 */
export type SpeedSelectProps = PropsRuntime<'conversation.input.right'> &
  Partial<SpeedSelectInjected> &
  Partial<PropsLocale<'settings.subscriptions'>>

/**
 * The `loadSpeed` half of the inject face: the plugin's own speed state plus
 * the host's current model selection (the visibility gate). A session whose
 * model selection is unavailable (an addressed subagent) answers hidden.
 * Any other model-directory failure throws, so the caller keeps its last
 * known state instead of locking the toggle away.
 *
 * `sessionId` is a plain string: slot and command contexts brand it through
 * different dsh-session copies, and only the service boundary needs one.
 *
 * `models` resolves lazily per call: the ui-model-selection service may
 * register after this plugin applies, and a shell without it (no model seat
 * at all) simply keeps the toggle hidden.
 */
export function createSpeedLoader(
  connection: ConnectionHandle,
  models: () => ModelDirectoriesLike | undefined,
  sessionId: string,
): SpeedSelectInjected['loadSpeed'] {
  return async () => {
    const state = await callSubscriptionsAuth<SpeedState>(
      connection.rpc,
      'speed',
      { sessionId },
    )
    const directories = models()
    if (directories === undefined) return { visible: false, tier: state.tier }
    let current: ModelSelectionSnapshot['current']
    try {
      const loaded = await directories.directoryFor(sessionId).load()
      current = loaded.current
    } catch (error) {
      if (!modelSelectionUnavailable(error)) throw error
      return { visible: false, tier: state.tier }
    }
    const visible =
      current !== null &&
      current.provider === 'codex' &&
      state.fastModels.includes(current.model)
    return { visible, tier: state.tier }
  }
}

/** Host copy for a session that has no model seat (an addressed subagent). */
const MODEL_SELECTION_UNAVAILABLE = 'model selection is unavailable'

function modelSelectionUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(MODEL_SELECTION_UNAVAILABLE)
}

/** Stable identity of a model selection. Empty when nothing is selected. */
export function modelSelectionKey(
  current: ModelSelectionSnapshot['current'] | undefined,
): string {
  if (current == null) return ''
  return JSON.stringify([current.provider, current.model])
}

/**
 * How often a host without a directory store is re-read, and how often a
 * missing directory service is retried. Neither interval calls
 * `subscriptions-auth.speed`.
 */
export const MODEL_DIRECTORY_POLL_INTERVAL_MS = 3000

/**
 * Mount reads of `speed`, including the first attempt. Further failures stop
 * instead of polling for the life of the composer.
 */
export const SPEED_MOUNT_READ_ATTEMPTS = 4

/** Fired after `/fast` writes a tier, so an open composer re-reads `speed`. */
export const SPEED_CHANGED_EVENT = 'dsh:subscriptions:speed-changed'

/** Tell mounted Speed controls that this page changed a session tier. */
export function notifySpeedChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(SPEED_CHANGED_EVENT))
}

/**
 * Subscribe to the session's selected model. A directory store notifies the
 * listener only when `provider` or `model` changes. A directory with no store
 * is re-read on {@link MODEL_DIRECTORY_POLL_INTERVAL_MS}; a service that is
 * not registered yet, or whose `directoryFor` throws, is retried on that same
 * interval. The first successful attach after a miss notifies once, so a
 * mount that ran before the service existed reads `speed` again.
 */
export function createModelSelectionWatch(
  models: () => ModelDirectoriesLike | undefined,
  sessionId: string,
): SpeedSelectInjected['watchModel'] {
  return (listener) => {
    let stopped = false
    let unsubscribeStore: (() => void) | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    let mode: 'seek' | 'store' | 'poll' = 'seek'
    let lastKey: string | undefined

    const stopTimer = (): void => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    const changed = (
      current: ModelSelectionSnapshot['current'] | undefined,
    ): boolean => {
      const next = modelSelectionKey(current)
      if (lastKey === undefined) {
        lastKey = next
        return false
      }
      if (next === lastKey) return false
      lastKey = next
      return true
    }
    const attach = (late: boolean): void => {
      if (stopped || mode !== 'seek') return
      let directory:
        ReturnType<ModelDirectoriesLike['directoryFor']> | undefined
      try {
        directory = models()?.directoryFor(sessionId)
      } catch {
        return
      }
      if (directory === undefined) return
      const store = directory.store
      if (store !== undefined) {
        mode = 'store'
        stopTimer()
        lastKey = modelSelectionKey(store.getSnapshot().current)
        unsubscribeStore = store.subscribe(() => {
          if (!stopped && changed(store.getSnapshot().current)) listener()
        })
        if (late) listener()
        return
      }
      mode = 'poll'
      stopTimer()
      let force = late
      const seed = (): void => {
        void directory.load().then(
          (state) => {
            if (stopped || mode !== 'poll') return
            const identityChanged = changed(state.current)
            const forced = force
            force = false
            if (identityChanged || forced) listener()
          },
          () => {
            /* keep the last model; the next tick retries */
          },
        )
      }
      seed()
      timer = setInterval(seed, MODEL_DIRECTORY_POLL_INTERVAL_MS)
    }

    attach(false)
    if (mode === 'seek')
      timer = setInterval(() => {
        attach(true)
      }, MODEL_DIRECTORY_POLL_INTERVAL_MS)
    return () => {
      stopped = true
      unsubscribeStore?.()
      stopTimer()
    }
  }
}

/** The `setSpeed` half of the inject face: boolean outcome for the component's busy state. */
export function createSpeedSetter(
  connection: ConnectionHandle,
  sessionId: string,
): SpeedSelectInjected['setSpeed'] {
  return (tier) =>
    callSubscriptionsAuth(connection.rpc, 'setSpeed', { sessionId, tier }).then(
      () => true,
      () => false,
    )
}

/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate(key: SubscriptionsKey): string {
  return en[key]
}

const TIERS: readonly SpeedTier[] = ['standard', 'fast']

/**
 * The composer Speed control: a trigger reading `速度 · 快速`/`速度 · 标准`
 * that opens a two-row menu (standard/fast with descriptions, check mark on
 * the current tier). It reads `subscriptions-auth.speed` on mount, when the
 * menu opens, when {@link SpeedSelectInjected.watchModel} reports a new
 * selected model, and when {@link notifySpeedChanged} fires. Until the first
 * read succeeds, a failure is retried on
 * {@link MODEL_DIRECTORY_POLL_INTERVAL_MS}, at most
 * {@link SPEED_MOUNT_READ_ATTEMPTS} times; after that, a failed read keeps
 * the last known state.
 */
export function SpeedSelect({
  loadSpeed,
  setSpeed,
  watchModel,
  t,
}: SpeedSelectProps) {
  const translate = t ?? fallbackTranslate
  const [state, setState] = useState<SpeedSelectState | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // The inject face may be re-evaluated (new callback identities) on re-render;
  // the mount effect reads through these refs, so identity churn neither
  // resubscribes nor multiplies in-flight loads.
  const loadRef = useRef(loadSpeed)
  loadRef.current = loadSpeed
  const watchRef = useRef(watchModel)
  watchRef.current = watchModel

  useEffect(() => {
    if (loadRef.current === undefined) return
    let cancelled = false
    let inflight = false
    let again = false
    let loadedOnce = false
    let failures = 0
    let retry: ReturnType<typeof setInterval> | undefined
    const stopRetry = (): void => {
      if (retry === undefined) return
      clearInterval(retry)
      retry = undefined
    }
    const reload = (): void => {
      const load = loadRef.current
      if (load === undefined) return
      if (inflight) {
        again = true
        return
      }
      inflight = true
      void load()
        .then(
          (loaded) => {
            if (cancelled) return
            loadedOnce = true
            stopRetry()
            setState(loaded)
          },
          () => {
            failures += 1
            if (failures >= SPEED_MOUNT_READ_ATTEMPTS) stopRetry()
          },
        )
        .finally(() => {
          inflight = false
          if (cancelled || !again) return
          again = false
          reload()
        })
    }
    reload()
    retry = setInterval(() => {
      if (!loadedOnce) reload()
    }, MODEL_DIRECTORY_POLL_INTERVAL_MS)
    const unsubscribe = watchRef.current?.(reload)
    const onSpeedChanged = (): void => {
      reload()
    }
    window.addEventListener(SPEED_CHANGED_EVENT, onSpeedChanged)
    return () => {
      cancelled = true
      unsubscribe?.()
      stopRetry()
      window.removeEventListener(SPEED_CHANGED_EVENT, onSpeedChanged)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
    }
  }, [open])

  if (
    loadSpeed === undefined ||
    setSpeed === undefined ||
    state === null ||
    !state.visible
  ) {
    return null
  }

  const choose = (tier: SpeedTier): void => {
    if (busy) return
    if (tier === state.tier) {
      setOpen(false)
      return
    }
    setBusy(true)
    void setSpeed(tier).then((ok) => {
      setBusy(false)
      if (ok) {
        setState({ visible: true, tier })
        setOpen(false)
      }
    })
  }

  const show = (): void => {
    setOpen(true)
    const load = loadRef.current
    if (load === undefined) return
    void load().then(setState, () => {
      /* keep showing the last good state */
    })
  }

  const tierName = (tier: SpeedTier): string =>
    translate(tier === 'fast' ? 'speedFast' : 'speedStandard')
  const tierDescription = (tier: SpeedTier): string =>
    translate(
      tier === 'fast' ? 'speedFastDescription' : 'speedStandardDescription',
    )
  const triggerLabel = `${translate('speed')} · ${tierName(state.tier)}`

  return (
    <div
      ref={rootRef}
      className="dsh-subscription-speed"
      style={styles.root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          setOpen(false)
        }
      }}
    >
      <style>{subscriptionChromeCss}</style>
      {open && (
        <div style={styles.menu} role="menu" aria-label={translate('speed')}>
          {TIERS.map((tier) => (
            <button
              key={tier}
              type="button"
              role="menuitemradio"
              aria-checked={tier === state.tier}
              style={styles.item}
              disabled={busy}
              onClick={() => {
                choose(tier)
              }}
            >
              <span style={styles.itemCheck}>
                {tier === state.tier ? '✓' : ''}
              </span>
              <span style={styles.itemText}>
                <span style={styles.itemName}>{tierName(tier)}</span>
                <span style={styles.itemDescription}>
                  {tierDescription(tier)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        style={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerLabel}
        disabled={busy}
        onClick={() => {
          if (open) setOpen(false)
          else show()
        }}
      >
        {triggerLabel}
      </button>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  root: { position: 'relative', display: 'inline-flex' },
  trigger: {
    border: '0.5px solid var(--dsw-alias-border-l3)',
    borderRadius: 'var(--dsw-radius-sm, 8px)',
    background: 'var(--dsh-subscription-speed-hover, transparent)',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'inherit',
    fontSize: 12,
    lineHeight: '18px',
    padding: '2px 8px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  menu: {
    position: 'absolute',
    bottom: '100%',
    right: 0,
    marginBottom: 4,
    minWidth: 180,
    padding: 4,
    zIndex: 20,
    background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2))',
    border: 0,
    boxShadow: 'var(--dsw-elevation-prominent)',
    borderRadius: 'var(--dsw-radius-lg, 16px)',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  item: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    width: '100%',
    border: 'none',
    borderRadius: 'var(--dsw-radius-sm, 8px)',
    background: 'var(--dsh-subscription-speed-hover, transparent)',
    padding: '6px 8px',
    cursor: 'pointer',
    font: 'inherit',
    textAlign: 'left',
  },
  itemCheck: {
    width: 14,
    flexShrink: 0,
    fontSize: 12,
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-primary)',
  },
  itemText: { display: 'flex', flexDirection: 'column' },
  itemName: {
    fontSize: 12,
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-primary)',
  },
  itemDescription: {
    fontSize: 11,
    lineHeight: '16px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
}
