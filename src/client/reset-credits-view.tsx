/**
 * Shared usage-limit-reset disclosure.
 *
 * Codex and Claude use the same closed `<details>` row. Codex may offer Use
 * on the earliest unexpired credit. Claude is read-only: `claimable` is
 * server metadata and never becomes a control. `expiresAt` is when the grant
 * expires, not a window reset, so it is never passed to the elapsed-time
 * cursor.
 */
import type { SubscriptionsKey } from './locales.js'
import { subscriptionCardStyles as cardStyles } from './subscription-card-styles.js'
import type { ResetCreditView, SubscriptionsSectionInjected } from './SubscriptionsSection.js'

type Translate = SubscriptionsSectionInjected['t']

/** How one grant reads. Color is not the only carrier; the state word is in the row name. */
export type ResetCreditState = 'available' | 'notUsable' | 'paused' | 'exhausted' | 'expired'

const STATE_KEYS: Record<ResetCreditState, SubscriptionsKey> = {
  available: 'resetCreditAvailable',
  notUsable: 'resetCreditNotUsable',
  paused: 'resetCreditPaused',
  exhausted: 'resetCreditExhausted',
  expired: 'resetCreditExpired',
}

/**
 * Classify one grant. Expired outranks every other flag. A future
 * `cooldownUntil` or `usableNow: false` is not usable even when `claimable`
 * is true. `claimable` does not change the word: it is not an action.
 */
export function resetCreditState(credit: ResetCreditView, now: number): ResetCreditState {
  if (credit.expiresAt !== undefined && credit.expiresAt <= now) return 'expired'
  if (credit.paused === true) return 'paused'
  if (credit.resetsLeft === 0) return 'exhausted'
  if ((credit.cooldownUntil !== undefined && credit.cooldownUntil > now) || credit.usableNow === false) return 'notUsable'
  return 'available'
}

/**
 * Headline count. Codex passes one entry per credit, so the count is the
 * list length. Claude passes one entry per grant, so the count is the sum of
 * `resetsLeft` on grants that are neither expired nor paused. A missing
 * `resetsLeft` adds nothing; the row says the count is unavailable.
 */
export function resetCreditsAvailableCount(
  credits: readonly ResetCreditView[],
  now: number,
  mode: 'credits' | 'grants',
): number {
  if (mode === 'credits') return credits.length
  let sum = 0
  for (const credit of credits) {
    const state = resetCreditState(credit, now)
    if (state === 'expired' || state === 'paused') continue
    if (typeof credit.resetsLeft === 'number' && Number.isFinite(credit.resetsLeft) && credit.resetsLeft > 0) {
      sum += credit.resetsLeft
    }
  }
  return sum
}

/** Codex Use control. Absent for Claude, which must not render a button. */
export interface ResetCreditUseAction {
  accountKey: string
  busy: boolean
  disabled: boolean
  title: string
  label: string
  onUse: () => void
}

function expiryText(t: Translate, credit: ResetCreditView): string {
  return credit.expiresAt === undefined
    ? t('resetCreditExpiryUnknown')
    : t('resetCreditExpires', { date: new Date(credit.expiresAt).toLocaleString() })
}

function remainingText(t: Translate, credit: ResetCreditView): string {
  const left = credit.resetsLeft
  const total = credit.resetsTotal
  const hasLeft = typeof left === 'number' && Number.isFinite(left)
  const hasTotal = typeof total === 'number' && Number.isFinite(total)
  if (hasLeft && hasTotal) return t('resetCreditRemaining', { left, total })
  if (hasLeft) return t('resetCreditLeft', { left })
  return t('resetCreditRemainingUnknown')
}

/** Accessible name of one Claude grant row: state, remaining, and expiry, not a control name. */
export function resetCreditRowName(t: Translate, credit: ResetCreditView, now: number): string {
  const state = resetCreditState(credit, now)
  const parts = [t('resetCreditFull'), t(STATE_KEYS[state]), remainingText(t, credit), expiryText(t, credit)]
  if (state === 'notUsable' && credit.cooldownUntil !== undefined && credit.cooldownUntil > now) {
    parts.push(t('resetCreditCooldownUntil', { date: new Date(credit.cooldownUntil).toLocaleString() }))
  }
  return parts.join(', ')
}

/** Claude omits an empty grant list; Codex still shows a defined, possibly empty, list. */
export function showsResetCredits(
  provider: 'codex' | 'claude',
  credits: readonly ResetCreditView[] | undefined,
): boolean {
  if (provider === 'codex') return credits !== undefined
  return (credits?.length ?? 0) > 0
}

/** The error line the settings card mounts. Claude never interpolates provider text. */
export function ResetCreditsErrorLine({ provider, message, t }: {
  provider: 'codex' | 'claude'
  message: string
  t: Translate
}) {
  return <p style={cardStyles.error}>{resetCreditsErrorText(provider, message, t)}</p>
}

/** Fixed sentence for Claude. Codex may include the lookup message; Claude must not. */
export function resetCreditsErrorText(
  provider: 'codex' | 'claude',
  message: string,
  t: Translate,
): string {
  return provider === 'claude' ? t('resetCreditsErrorFixed') : t('resetCreditsError', { message })
}

const summaryStyle = {
  ...cardStyles.usageMeta, cursor: 'pointer', listStyle: 'none', justifyContent: 'flex-start', gap: 6,
} as const

/**
 * The closed disclosure both providers share. Claude rows are plain text:
 * no button, no `role="button"`, and `cursor: default`, including when
 * `claimable` is true.
 */
export function ResetCreditsDisclosure({
  mode,
  credits,
  t,
  now = Date.now(),
  nextCredit,
  useAction,
  statusMessage,
}: {
  mode: 'credits' | 'grants'
  credits: readonly ResetCreditView[]
  t: Translate
  now?: number
  nextCredit?: ResetCreditView
  useAction?: ResetCreditUseAction
  statusMessage?: string
}) {
  const count = resetCreditsAvailableCount(credits, now, mode)
  return (
    <details className="subscriptions-reset-credits" style={cardStyles.usageRow}>
      <summary style={summaryStyle}>
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
          <path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{t('resetCreditsTitle')}</span>
        {mode === 'grants' && <span>{t('resetCreditReadOnlyLabel')}</span>}
        <span style={{ marginLeft: 'auto' }}>{t('resetCreditsAvailable', { count })}</span>
      </summary>
      <style>{
        '.subscriptions-reset-credits > summary::-webkit-details-marker { display: none; }'
        + '.subscriptions-reset-credits[open] > summary > svg { transform: rotate(90deg); }'
      }</style>
      <div style={{ paddingLeft: 18, marginTop: 6 }}>
        {mode === 'grants' && <p style={cardStyles.status}>{t('resetCreditReadOnly')}</p>}
        {credits.map((credit, index) => {
          const state = resetCreditState(credit, now)
          const showUse = mode === 'credits' && useAction !== undefined && credit === nextCredit
          return (
            <div
              key={credit.id ?? index}
              data-reset-state={mode === 'grants' ? state : undefined}
              data-reset-claimable={mode === 'grants' && credit.claimable === true ? 'true' : undefined}
              role={mode === 'grants' ? 'group' : undefined}
              aria-label={mode === 'grants' ? resetCreditRowName(t, credit, now) : undefined}
              style={{ ...cardStyles.usageMeta, minHeight: 28, gap: 12, cursor: mode === 'grants' ? 'default' : undefined }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {t('resetCreditFull')}
                {mode === 'grants' && (
                  <span aria-hidden="true" data-reset-state-word={state}>{t(STATE_KEYS[state])}</span>
                )}
                {showUse && (
                  <button type="button" aria-disabled={useAction.disabled}
                    title={useAction.title}
                    style={{ minHeight: 22, height: 22, padding: '0 7px', borderRadius: 6,
                      opacity: useAction.disabled ? 0.35 : 1, cursor: useAction.disabled ? 'not-allowed' : 'pointer' }}
                    onClick={() => { if (!useAction.disabled) useAction.onUse() }}>
                    {useAction.busy ? t('resetUseChecking') : useAction.label}
                  </button>
                )}
              </span>
              <span style={{ textAlign: 'right' }}>
                {mode === 'grants' && <span aria-hidden="true">{remainingText(t, credit)} · </span>}
                {mode === 'grants' && state === 'notUsable' && credit.cooldownUntil !== undefined && credit.cooldownUntil > now && (
                  <span aria-hidden="true">{t('resetCreditCooldownUntil', { date: new Date(credit.cooldownUntil).toLocaleString() })} · </span>
                )}
                <span aria-hidden={mode === 'grants' ? true : undefined}>{expiryText(t, credit)}</span>
              </span>
            </div>
          )
        })}
        {statusMessage !== undefined && statusMessage !== '' && <p role="status" style={cardStyles.status}>{statusMessage}</p>}
      </div>
    </details>
  )
}
