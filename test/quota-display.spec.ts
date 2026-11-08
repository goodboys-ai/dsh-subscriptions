import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quotaPercent, quotaText } from '../src/client/quota-display.js'
import { en, zh } from '../src/client/locales.js'

test('used/remaining handles bounds without inventing allowance', () => {
  for (const [used, remaining] of [
    [0, 100],
    [100, 0],
    [28, 72],
    [99.9, 0],
  ]) {
    assert.equal(quotaPercent(used, 'remaining'), remaining)
    assert.equal(
      quotaPercent(used, 'used'),
      Math.round(Math.min(100, Math.max(0, used))),
    )
  }
  for (const value of [
    undefined,
    null,
    NaN,
    Infinity,
    -Infinity,
    -20,
    120,
    '0',
    false,
  ]) {
    assert.equal(quotaPercent(value, 'used'), undefined)
    assert.equal(quotaPercent(value, 'remaining'), undefined)
    for (const dictionary of [en, zh])
      assert.equal(
        quotaText(value, 'remaining', (key) => dictionary[key]),
        dictionary.quotaUnknown,
      )
  }
})

test('quota text localizes direction and formatting', () => {
  for (const dictionary of [en, zh]) {
    const t = (key: keyof typeof en, params?: Record<string, unknown>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (_, name) =>
        String(params?.[name] ?? ''),
      )
    assert.equal(
      quotaText(28, 'used', t),
      t('quotaUsedPercent', { percent: 28 }),
    )
    assert.equal(
      quotaText(28, 'remaining', t),
      t('quotaRemainingPercent', { percent: 72 }),
    )
  }
})
