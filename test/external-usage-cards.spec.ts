/**
 * Row labels on the external usage cards (OpenCode Go, Kimi Code, MiniMax).
 *
 * MiniMax reports one scope per model, so a standard model and the video model
 * each have a weekly window. Without the scope the two rows read the same and
 * a reader cannot tell which model a bar belongs to. The badge dialog and the
 * subscription cards already append the scope; these cases pin that the
 * external cards do too, and that the scope-free windows of the other sources
 * keep their labels.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { externalUsageWindowLabel } from '../src/client/ExternalUsageCards.js'
import { en, zh } from '../src/client/locales.js'
import type { UsageWindow } from '../src/client/SubscriptionsSection.js'

const translator = (dictionary: typeof en) => (key: keyof typeof en, params?: Record<string, unknown>): string =>
  dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))

test('windows of different MiniMax models are told apart by scope', () => {
  const t = translator(en)
  const label = (window: UsageWindow) => externalUsageWindowLabel(t, window)
  assert.equal(label({ kind: 'session', scope: 'general', usedPercent: 6 }), '5-hour window · general')
  assert.equal(label({ kind: 'weekly', scope: 'general', usedPercent: 2 }), 'Weekly · general')
  assert.equal(label({ kind: 'weekly', scope: 'video', usedPercent: 0 }), 'Weekly · video')
  assert.equal(label({ kind: 'other', scope: 'video', usedPercent: 0 }), 'video')
  assert.notEqual(label({ kind: 'weekly', scope: 'general', usedPercent: 2 }), label({ kind: 'weekly', scope: 'video', usedPercent: 0 }))
  // An empty scope names no model.
  assert.equal(label({ kind: 'weekly', scope: '', usedPercent: 2 }), 'Weekly')
})

test('windows without a scope, and the monthly pool, keep their labels in both locales', () => {
  for (const dictionary of [en, zh]) {
    const t = translator(dictionary)
    const label = (window: UsageWindow) => externalUsageWindowLabel(t, window)
    assert.equal(label({ kind: 'session', usedPercent: 1 }), dictionary.usageSession)
    assert.equal(label({ kind: 'weekly', usedPercent: 1 }), dictionary.usageWeekly)
    assert.equal(label({ kind: 'other', usedPercent: 1 }), dictionary.usageWindow)
    // The monthly pool is a scope on an `other` window, not a model: no "Window · Monthly".
    assert.equal(label({ kind: 'other', scope: 'Monthly', usedPercent: 1 }), dictionary.usageMonthly)
  }
})
