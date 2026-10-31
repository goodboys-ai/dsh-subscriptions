import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visibleUsageWindows } from '../src/client/usage-window-filter.js'
import type { UsageWindow } from '../src/client/SubscriptionsSection.js'
import { en, zh } from '../src/client/locales.js'

const windows: UsageWindow[] = [
  { kind: 'other', scope: 'gemini-3-flash', usedPercent: 30 },
  { kind: 'weekly', scope: 'gemini-3-flash', usedPercent: 60 },
  { kind: 'weekly', scope: 'gemini-2.5-pro', usedPercent: 80 },
]

test('Antigravity usage follows visible models and preserves empty semantics', () => {
  assert.strictEqual(
    visibleUsageWindows('antigravity', windows, undefined),
    windows,
  )
  assert.deepEqual(visibleUsageWindows('antigravity', windows, []), [])
  assert.deepEqual(
    visibleUsageWindows('antigravity', windows, ['gemini-3-flash']),
    windows.slice(0, 2),
  )
  assert.deepEqual(
    visibleUsageWindows('antigravity', windows, ['unavailable-model']),
    [],
  )
  assert.deepEqual(
    visibleUsageWindows('antigravity', undefined, ['gemini-3-flash']),
    [],
  )
  assert.deepEqual(visibleUsageWindows('antigravity', [], undefined), [])
})

test('visibility keeps account-wide windows and other providers unchanged', () => {
  const unscoped: UsageWindow[] = [
    { kind: 'session', usedPercent: 10 },
    { kind: 'weekly', scope: '', usedPercent: 30 },
  ]
  assert.deepEqual(
    visibleUsageWindows('antigravity', [...windows, ...unscoped], []),
    unscoped,
  )
  for (const provider of ['codex', 'claude', 'grok', 'copilot']) {
    assert.strictEqual(visibleUsageWindows(provider, windows, []), windows)
  }
})

test('filtered-empty usage has distinct bilingual copy', () => {
  for (const locale of [en, zh]) {
    assert.ok(locale.usageNoVisibleModels)
    assert.notEqual(locale.usageNoVisibleModels, locale.usageEmpty)
  }
})
