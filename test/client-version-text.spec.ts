/**
 * Unit tests for the Settings card's CLI-version tag text (`clientVersionText`).
 * The tag names the version's source (npm / local CLI / built-in / configured)
 * so a failed npm lookup reads as a fallback, never as a plan limit
 * (upstream dsh-plugin-subscriptions issue #108). Pure formatting: no DOM,
 * no React — the section renders the returned string beside the provider name.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientVersionText } from '../src/client/SubscriptionsSection.js'
import type { SubscriptionsSectionInjected } from '../src/client/SubscriptionsSection.js'
import { en, zh } from '../src/client/locales.js'

const translator =
  (dictionary: typeof en): SubscriptionsSectionInjected['t'] =>
  (key, params) =>
    dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) =>
      String(params?.[name] ?? ''),
    )

test('the tag shows the version and its source in both locales', () => {
  const enT = translator(en)
  assert.equal(
    clientVersionText(enT, { version: '0.157.1', source: 'npm' }),
    'CLI 0.157.1 · latest on npm',
  )
  assert.equal(
    clientVersionText(enT, { version: '2.1.283', source: 'fallback' }),
    'CLI 2.1.283 · built-in',
  )
  assert.equal(
    clientVersionText(enT, { version: '2.1.290', source: 'local' }),
    'CLI 2.1.290 · local CLI',
  )
  assert.equal(
    clientVersionText(enT, { version: '0.153.4', source: 'config' }),
    'CLI 0.153.4 · configured',
  )
  const zhT = translator(zh)
  assert.equal(
    clientVersionText(zhT, { version: '2.1.283', source: 'fallback' }),
    'CLI 2.1.283 · 内置版本',
  )
  assert.equal(
    clientVersionText(zhT, { version: '2.1.290', source: 'local' }),
    'CLI 2.1.290 · 本机 CLI',
  )
})

test('routes without a presented version show nothing', () => {
  assert.equal(clientVersionText(translator(en), undefined), '')
})
