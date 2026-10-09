import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { providerSettingsCss, subscriptionChromeCss } from '../src/client/provider-settings-styles.js'
import { en, zh } from '../src/client/locales.js'
import { UsageBadgeDisplaySetting } from '../src/client/UsageBadgeDisplaySetting.js'

// Render plugin rows only; the host positioning hooks and icon require a browser.
const primitives = `data:text/javascript,${encodeURIComponent(`
  export const IconDataOutlineRegular = () => null
  export const useAnchoredPosition = () => ({})
  export const useDismissOnOutsidePointer = () => {}
`)}`
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === '@deepseek-ai/dsh-client-ui-primitives'
      ? { url: primitives, shortCircuit: true } : nextResolve(specifier, context)
  },
})
const { AccountWindows, windowLabel } = await import('../src/client/SubscriptionUsageBadge.js')
hooks.deregister()

function translate(dictionary: typeof en | typeof zh) {
  return (key: keyof typeof en, params?: Record<string, unknown>) =>
    dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

const source = (file: string) => readFileSync(`src/client/${file}`, 'utf8')

test('native control states stay scoped and do not restyle meter internals', () => {
  const scope = ':is(.dsh-subscription-manager, .dsh-subscriptions-settings)'
  for (const selector of ['button:hover:not(:disabled)', 'button:active:not(:disabled)',
    'button:disabled', 'button:focus-visible', 'select:focus-visible', 'summary:focus-visible']) {
    assert.ok(providerSettingsCss.includes(`${scope} ${selector}`), selector)
  }
  for (const token of ['--dsw-alias-bg-layer-3', '--dsw-alias-border-l4', '--dsw-alias-button-primary-fill',
    '--dsw-focus-ring-color', '--dsw-radius-panel']) assert.ok(providerSettingsCss.includes(token), token)
  assert.doesNotMatch(providerSettingsCss, /color-scheme|body\[data-ds-dark-theme\]/)
  assert.match(subscriptionChromeCss, /\.dsh-subscription-usage-panel\s*\{[^}]*--dsw-elevation-stroke-color/s)
  assert.match(subscriptionChromeCss, /\.dsh-subscription-speed button:disabled/)
  assert.doesNotMatch(providerSettingsCss + subscriptionChromeCss, /data-usage-time-marker|data-usage-color|\bspan\s*\{|\bdiv\s*\{/)
})

test('restyled dialog rows keep timing-only cursors, including stale and invalid readings', () => {
  const now = Date.now()
  for (const dictionary of [en, zh]) {
    const t = translate(dictionary)
    for (const reading of [
      { usedPercent: 0, observedAt: now }, { usedPercent: 80, observedAt: now, stale: true },
      { usedPercent: 80 }, { usedPercent: NaN, observedAt: now },
    ]) {
      const html = renderToStaticMarkup(createElement(AccountWindows, {
        windows: [{ kind: 'weekly', scope: 'general', usedPercent: reading.usedPercent,
          startsAt: now - 100_000, resetsAt: now + 100_000 }],
        model: undefined, translate: t, observedAt: reading.observedAt,
        ...('stale' in reading ? { stale: reading.stale } : {}),
      }))
      assert.match(html, /data-usage-time-marker/)
      assert.ok(html.includes(`${t('usageWeekly')} · general`), html)
      assert.doesNotMatch(html, /data-usage-color="yellow"/)
      if (Number.isNaN(reading.usedPercent)) assert.ok(html.includes(t('usageMeterInvalid')), html)
    }
    for (const timing of [{}, { resetsAt: now + 100_000 },
      { startsAt: now - 100_000, resetsAt: now - 1 },
      { startsAt: now + 50_000, resetsAt: now + 100_000 }]) {
      const html = renderToStaticMarkup(createElement(AccountWindows, {
        windows: [{ kind: 'weekly', usedPercent: 0, ...timing }], model: undefined, translate: t,
      }))
      assert.doesNotMatch(html, /data-usage-time-marker/)
    }
  }
})

test('native display setting keeps always mode and all color presets in both locales', () => {
  for (const dictionary of [en, zh]) {
    const t = translate(dictionary)
    const html = renderToStaticMarkup(createElement(UsageBadgeDisplaySetting, { t }))
    assert.ok(html.includes(`aria-label="${t('usageBadgeDisplay')}"`), html)
    assert.ok(html.includes(`<option value="always">${t('usageBadgeDisplayAlways')}</option>`), html)
    for (const value of ['standard', 'relaxed', 'remaining']) assert.ok(html.includes(`value="${value}"`), value)
    assert.match(html, /--dsw-alias-settings-card-fill/)
  }
})

test('compact time labels retain the fork format, fallback and minute semantics', t => {
  const now = 1_000_000
  mock.method(Date, 'now', () => now)
  t.after(() => mock.restoreAll())
  const label = (ms: number) => windowLabel({ kind: 'weekly', usedPercent: 0, resetsAt: now + ms })
  assert.equal(label((6 * 24 + 18) * 3_600_000), '6d18h')
  assert.equal(label((60 + 58) * 60_000), '1h58m')
  assert.equal(label(42 * 60_000), '42m')
  assert.equal(label(-1), '1m')
  assert.equal(windowLabel({ kind: 'weekly', scope: 'general', usedPercent: 0 }), 'general')
})

// Wiring guards complement the pure rotation/redemption tests, not browser clicks.
test('restyle leaves the ten-second rotation and meter observation plumbing intact', () => {
  const badge = source('SubscriptionUsageBadge.tsx')
  assert.match(badge, /BADGE_ROTATION_INTERVAL_MS = 10_000/)
  assert.match(badge, /if \(displayMode !== 'always'\) return/)
  assert.match(badge, /: BADGE_ROTATION_INTERVAL_MS/)
  assert.match(badge, /displayMode === 'always'\s*\? rotatingDisplay/)
  assert.match(badge, /<UsageMeter[^>]*observedAt=\{observedAt\} stale=\{stale\}/)
  const settings = source('SubscriptionsSection.tsx')
  assert.match(settings, /<UsageMeter[^>]*observedAt=\{observedAt\[usageKey\]\} stale=\{usageError !== undefined \|\| usage.stale === true\}/)
})

test('Codex disclosure, chevron and guarded confirmation wiring survive the restyle', () => {
  const settings = source('SubscriptionsSection.tsx')
  const disclosure = source('reset-credits-view.tsx')
  assert.match(settings, /<ResetCreditsDisclosure/)
  assert.match(disclosure, /<details className="subscriptions-reset-credits"/)
  assert.match(disclosure, /<svg aria-hidden="true" width="12" height="12"/)
  assert.ok(disclosure.includes('.subscriptions-reset-credits[open] > summary > svg { transform: rotate(90deg); }'))
  assert.match(disclosure, /aria-disabled=\{useAction.disabled\}/)
  assert.match(disclosure, /if \(!useAction.disabled\) useAction.onUse\(\)/)
  assert.match(settings, /if \(!resetDisabled\) void prepareReset\(account.key\)/)
  assert.match(settings, /resetDialogRef.current\?\.showModal\(\)/)
  assert.match(settings, /aria-labelledby="subscriptions-reset-title"/)
  assert.match(settings, /disabled=\{!resetAcknowledged \|\| resetBusy\}/)
  assert.match(settings, /void consumeReset\(\)/)
  const owner: Record<string, string> = {
    resetCreditsTitle: disclosure,
    resetUseButton: settings,
    resetUseConfirmTitle: settings,
    resetUseAcknowledge: settings,
    resetUseConfirm: settings,
  }
  for (const dictionary of [en, zh]) {
    for (const key of ['resetCreditsTitle', 'resetUseButton', 'resetUseConfirmTitle', 'resetUseAcknowledge', 'resetUseConfirm'] as const) {
      assert.ok(dictionary[key], key)
      assert.ok(owner[key].includes(`t('${key}')`), key)
    }
  }
})
