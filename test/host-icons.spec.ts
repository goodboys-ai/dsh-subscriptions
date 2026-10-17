import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { hostIcon } from '../src/client/host-icons.js'
import { HOST_CONTRACT_MISS } from '../src/client/host-contract.js'

const modern = () => createElement('svg', { 'data-version': 'modern' })
const legacy = () => createElement('svg', { 'data-version': 'legacy' })

test('host icons resolve the DSH 0.1.7 name first, then the older 16px name', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  assert.equal(
    hostIcon({ IconSparkleRegular: modern, IconSparkle16: legacy }, 'Sparkle'),
    modern,
  )
  assert.equal(hostIcon({ IconSparkleRegular: modern }, 'Sparkle'), modern)
  assert.equal(hostIcon({ IconSparkle16: legacy }, 'Sparkle'), legacy)
  assert.equal(warn.mock.callCount(), 0)
})

test('a glyph the host lacks renders nothing and reports a host contract miss', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const icon = hostIcon({ IconDataOutlineRegular: modern }, 'Sparkle')
  // The slot must still render (React #130), and the miss must reach the
  // console, where the host E2E fails on it.
  assert.equal(renderToStaticMarkup(createElement(icon)), '')
  assert.equal(warn.mock.callCount(), 1)
  const message = String(warn.mock.calls[0]?.arguments[0])
  assert.ok(message.startsWith(HOST_CONTRACT_MISS), message)
  assert.match(message, /IconSparkleRegular/)
})
