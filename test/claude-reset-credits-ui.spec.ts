/**
 * Claude banked limit-reset rows, rendered the way the settings card mounts them.
 *
 * `SubscriptionsSection` loads accounts in an effect, so static markup of the
 * page cannot show a grant. These cases render the disclosure and error line
 * that card mounts, which is the text a reader sees. A source search is not
 * the assertion.
 *
 * One row is one grant. The headline sums `resetsLeft` on grants that are
 * neither expired nor paused; it is not the array length.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { en, zh } from '../src/client/locales.js'
import { UsageMeter } from '../src/client/UsageMeter.js'
import {
  ResetCreditsDisclosure,
  ResetCreditsErrorLine,
  resetCreditRowName,
  resetCreditsAvailableCount,
  resetCreditsErrorText,
  showsResetCredits,
} from '../src/client/reset-credits-view.js'
import type { ResetCreditView } from '../src/client/SubscriptionsSection.js'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const HOUR = 3_600_000
const SECRET = 'Bearer sk-ant-secret-do-not-render'

const translator = (dictionary: typeof en) => (key: keyof typeof en, params?: Record<string, unknown>): string =>
  dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))

function markup(node: ReactElement): string {
  return renderToStaticMarkup(node)
}

function disclosure(
  dictionary: typeof en,
  credits: ResetCreditView[],
  options?: { use?: boolean },
): string {
  const t = translator(dictionary)
  return markup(createElement(ResetCreditsDisclosure, {
    mode: 'grants',
    credits,
    t,
    now: NOW,
    ...options?.use ? {
      useAction: {
        accountKey: 'claude-1', busy: false, disabled: false, title: 'should not appear',
        label: dictionary.resetUseButton, onUse: () => undefined,
      },
    } : {},
  }))
}

const eligible: ResetCreditView = {
  id: 'grant-ready',
  expiresAt: NOW + 48 * HOUR,
  resetsTotal: 5,
  resetsLeft: 4,
  usableNow: true,
  claimable: true,
}
const cooling: ResetCreditView = {
  id: 'grant-cool',
  expiresAt: NOW + 72 * HOUR,
  resetsTotal: 2,
  resetsLeft: 2,
  usableNow: false,
  claimable: false,
  cooldownUntil: NOW + 6 * HOUR,
}
const expired: ResetCreditView = {
  id: 'grant-old',
  expiresAt: NOW - HOUR,
  resetsTotal: 4,
  resetsLeft: 4,
  usableNow: true,
  claimable: true,
}
const paused: ResetCreditView = {
  id: 'grant-paused',
  expiresAt: NOW + 24 * HOUR,
  resetsTotal: 1,
  resetsLeft: 1,
  paused: true,
  usableNow: true,
}
const exhausted: ResetCreditView = {
  id: 'grant-empty',
  expiresAt: NOW + 24 * HOUR,
  resetsTotal: 3,
  resetsLeft: 0,
  usableNow: true,
  claimable: false,
}

test('Claude headline sums remaining resets, and an omitted list is not an empty row', () => {
  const credits = [eligible, cooling, expired, paused, exhausted]
  assert.equal(resetCreditsAvailableCount(credits, NOW, 'grants'), 6)
  assert.notEqual(resetCreditsAvailableCount(credits, NOW, 'grants'), credits.length)
  assert.equal(resetCreditsAvailableCount([eligible], NOW, 'credits'), 1)
  assert.equal(showsResetCredits('claude', undefined), false)
  assert.equal(showsResetCredits('claude', []), false)
  assert.equal(showsResetCredits('codex', []), true)
})

test('eligible, cooling, expired, paused, and exhausted grants render as text in both locales', () => {
  const credits = [eligible, cooling, expired, paused, exhausted]
  for (const dictionary of [en, zh]) {
    const t = translator(dictionary)
    const html = disclosure(dictionary, credits)
    assert.ok(html.includes(t('resetCreditsTitle')), html)
    assert.ok(html.includes(t('resetCreditsAvailable', { count: 6 })), html)
    assert.equal(html.includes(t('resetCreditsAvailable', { count: credits.length })), false, html)
    assert.ok(html.includes(t('resetCreditReadOnlyLabel')), html)
    assert.ok(html.includes(t('resetCreditReadOnly')), html)
    assert.equal(html.includes('<button'), false, html)
    assert.equal(html.includes(dictionary.resetUseButton), false, html)
    assert.equal(html.includes('role="button"'), false, html)
    assert.ok(html.includes('role="group"'), html)
    assert.equal(html.includes('cursor:default'), true, html)
    assert.equal(html.includes('data-usage-time-marker'), false)
    for (const credit of credits) {
      const name = resetCreditRowName(t, credit, NOW)
      assert.ok(html.includes(`aria-label="${name}"`), name)
    }
    assert.ok(html.includes('data-reset-state="available"'), html)
    assert.ok(html.includes('data-reset-state="notUsable"'), html)
    assert.ok(html.includes('data-reset-state="expired"'), html)
    assert.ok(html.includes('data-reset-state="paused"'), html)
    assert.ok(html.includes('data-reset-state="exhausted"'), html)
    assert.ok(html.includes('data-reset-claimable="true"'), html)
    assert.ok(html.includes(t('resetCreditCooldownUntil', { date: new Date(cooling.cooldownUntil!).toLocaleString() })), html)
    assert.ok(html.includes(t('resetCreditExpires', { date: new Date(expired.expiresAt!).toLocaleString() })), html)
    assert.equal(html.includes(t('usageResets', { date: new Date(expired.expiresAt!).toLocaleString() })), false)
  }
})

test('an ineligible Claude account has no reset row, and a failed lookup does not echo the provider', () => {
  for (const dictionary of [en, zh]) {
    const t = translator(dictionary)
    assert.equal(showsResetCredits('claude', undefined), false)
    assert.equal(showsResetCredits('claude', []), false)
    const error = resetCreditsErrorText('claude', SECRET, t)
    const errorHtml = markup(createElement(ResetCreditsErrorLine, { provider: 'claude', message: SECRET, t }))
    assert.equal(error, t('resetCreditsErrorFixed'))
    assert.ok(errorHtml.includes(t('resetCreditsErrorFixed')), errorHtml)
    assert.equal(errorHtml.includes(SECRET), false)
    assert.equal(errorHtml.includes('sk-ant'), false)
    assert.equal(errorHtml.includes('Bearer'), false)
    assert.equal(resetCreditsErrorText('codex', 'HTTP 403', t), t('resetCreditsError', { message: 'HTTP 403' }))
    const codexError = markup(createElement(ResetCreditsErrorLine, { provider: 'codex', message: 'HTTP 403', t }))
    assert.ok(codexError.includes('HTTP 403'), codexError)
  }
})

test('a claimable Claude grant stays non-actionable even if a use handler is passed', () => {
  for (const dictionary of [en, zh]) {
    const html = disclosure(dictionary, [eligible], { use: true })
    assert.equal(html.includes('<button'), false, html)
    assert.ok(html.includes('cursor:default'), html)
    assert.match(html, /<summary[^>]*cursor:pointer/)
    assert.ok(html.includes('data-reset-claimable="true"'), html)
    assert.ok(html.includes(translator(dictionary)('resetCreditAvailable')), html)
  }
})

test('a future cooldown wins over usableNow, and a past cooldown does not', () => {
  const t = translator(en)
  const held = disclosure(en, [{ ...eligible, id: 'held', usableNow: true, claimable: true, cooldownUntil: NOW + HOUR }])
  assert.ok(held.includes('data-reset-state="notUsable"'), held)
  assert.equal(held.includes('<button'), false)
  const released = disclosure(en, [{ ...cooling, id: 'released', usableNow: true, cooldownUntil: NOW - HOUR, claimable: true }])
  assert.ok(released.includes('data-reset-state="available"'), released)
  assert.ok(released.includes(t('resetCreditAvailable')))
  assert.equal(released.includes(t('resetCreditCooldownUntil', { date: new Date(NOW - HOUR).toLocaleString() })), false)
})

test('the grant expiry is not the window cursor', () => {
  const t = translator(en)
  const current = Date.now()
  const window = {
    kind: 'weekly' as const,
    usedPercent: 40,
    startsAt: current - 2 * HOUR,
    resetsAt: current + 2 * HOUR,
  }
  const meter = markup(createElement(UsageMeter, { window, t, observedAt: current }))
  const grant = disclosure(en, [{ ...eligible, expiresAt: NOW + 48 * HOUR }])
  assert.match(meter, /data-usage-time-marker/)
  assert.equal(grant.includes('data-usage-time-marker'), false)
  assert.equal(grant.includes(t('usageResets', { date: new Date(NOW + 48 * HOUR).toLocaleString() })), false)
  assert.ok(grant.includes(t('resetCreditExpires', { date: new Date(NOW + 48 * HOUR).toLocaleString() })))
})
