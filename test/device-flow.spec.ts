/**
 * The GitHub device-authorization flow engine: device-code request shape,
 * token polling (authorization_pending / slow_down / denial / expiry), busy
 * tracking, and cancellation. All fetches are injected; no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import './keep-alive.js'
import { DeviceFlowManager } from '../src/auth/device-flow.js'
import type { DeviceFlowSpec } from '../src/auth/device-flow.js'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'

/** A fetch implementation replaying queued responses per URL; records request bodies. */
function fakeFetch(script: Record<string, unknown[]>): {
  fetchFn: typeof fetch
  bodies: (url: string) => string[]
} {
  const queues = new Map(Object.entries(script).map(([url, responses]) => [url, [...responses]]))
  const bodies = new Map<string, string[]>()
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const queue = queues.get(url)
    if (queue === undefined || queue.length === 0) {
      return Promise.reject(new Error(`unexpected fetch to ${url}`))
    }
    const list = bodies.get(url) ?? []
    list.push(typeof init?.body === 'string' ? init.body : '')
    bodies.set(url, list)
    const payload = queue.shift()
    if (payload instanceof Response) return Promise.resolve(payload)
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
  }) as typeof fetch
  return { fetchFn, bodies: url => bodies.get(url) ?? [] }
}

function spec(fetchFn: typeof fetch): DeviceFlowSpec {
  return {
    clientId: 'client-1',
    scope: 'read:user',
    deviceCodeUrl: DEVICE_CODE_URL,
    tokenUrl: TOKEN_URL,
    fetchFn,
  }
}

const DEVICE_CODE = {
  device_code: 'dc-1',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  // Fractional intervals keep the tests fast; GitHub sends integers ≥ 5.
  interval: 0.01,
  expires_in: 60,
}

test('device flow: pending polls resolve to the access token', async () => {
  const { fetchFn, bodies } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE],
    [TOKEN_URL]: [
      { error: 'authorization_pending' },
      { error: 'authorization_pending' },
      { access_token: 'gh-token' },
    ],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))
  assert.equal(attempt.userCode, 'ABCD-1234')
  assert.equal(attempt.verificationUrl, 'https://github.com/login/device')
  assert.equal(manager.isBusy('copilot'), true)

  // The device-code request carries the client id and scope, form-encoded.
  const [deviceBody] = bodies(DEVICE_CODE_URL)
  assert.equal(new URLSearchParams(deviceBody).get('client_id'), 'client-1')
  assert.equal(new URLSearchParams(deviceBody).get('scope'), 'read:user')

  assert.equal(await attempt.waitToken(), 'gh-token')
  assert.equal(manager.isBusy('copilot'), false)

  // Every poll presents the device code with the device-code grant type.
  for (const body of bodies(TOKEN_URL)) {
    const params = new URLSearchParams(body)
    assert.equal(params.get('device_code'), 'dc-1')
    assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
  }
})

test('device flow: slow_down keeps polling and still resolves', async () => {
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE],
    [TOKEN_URL]: [
      { error: 'slow_down' },
      { access_token: 'gh-token' },
    ],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))
  assert.equal(await attempt.waitToken(), 'gh-token')
})

test('device flow: access_denied rejects the login', async () => {
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE],
    [TOKEN_URL]: [{ error: 'access_denied', error_description: 'customer-input SHORT_SECRET!' }],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))
  await assert.rejects(attempt.waitToken(), (caught: unknown) => {
    assert.ok(caught instanceof Error)
    assert.equal(caught.constructor, Error)
    assert.equal(caught.message, 'login declined on the GitHub authorization page')
    assert.doesNotMatch(caught.message, /customer-input SHORT_SECRET!/)
    return true
  })
  assert.equal(manager.isBusy('copilot'), false)
})

test('device flow: an expired device code rejects the login', async () => {
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE],
    [TOKEN_URL]: [{ error: 'expired_token', error_description: 'customer-input SHORT_SECRET!' }],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))
  await assert.rejects(attempt.waitToken(), (caught: unknown) => {
    assert.ok(caught instanceof Error)
    assert.equal(caught.constructor, Error)
    assert.equal(caught.message, 'the device code expired before authorization completed')
    assert.doesNotMatch(caught.message, /customer-input SHORT_SECRET!/)
    return true
  })
  assert.equal(manager.isBusy('copilot'), false)
})

for (const payload of [
  { error: 'unrecognized', error_description: 'customer-input SHORT_SECRET!' },
  { error: 'customer-input SHORT_SECRET!' },
  {},
]) {
  test(`device flow: default polling failure omits provider text (${JSON.stringify(payload)})`, async () => {
    const { fetchFn, bodies } = fakeFetch({
      [DEVICE_CODE_URL]: [DEVICE_CODE],
      [TOKEN_URL]: [Response.json(payload, { status: 400 })],
    })
    const manager = new DeviceFlowManager()
    const attempt = await manager.start('copilot', spec(fetchFn))
    await assert.rejects(attempt.waitToken(), (caught: unknown) => {
      assert.ok(caught instanceof Error)
      assert.equal(caught.constructor, Error)
      assert.doesNotMatch(caught.message, /customer-input SHORT_SECRET!/)
      assert.equal(caught.message,
        'copilot device-flow polling failed (HTTP 400): [provider response body omitted]')
      return true
    })
    assert.equal(manager.isBusy('copilot'), false)
    assert.equal(manager.pending('copilot'), undefined)
    assert.equal(bodies(TOKEN_URL).length, 1, 'the default branch settles without retrying')
  })
}

test('device flow: cancel rejects waitToken and frees the provider slot', async () => {
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE, DEVICE_CODE],
    [TOKEN_URL]: [{ error: 'authorization_pending' }, { access_token: 'gh-token' }],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))
  attempt.cancel()
  await assert.rejects(attempt.waitToken(), /cancelled/)
  assert.equal(manager.isBusy('copilot'), false)
  assert.equal(manager.pending('copilot'), undefined)

  // A fresh attempt may start right away for the same provider.
  const again = await manager.start('copilot', spec(fetchFn))
  assert.equal(again.userCode, 'ABCD-1234')
  again.cancel()
})

test('device flow: a second concurrent attempt for one provider is refused', async () => {
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE, DEVICE_CODE],
    [TOKEN_URL]: [{ error: 'authorization_pending' }],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))
  await assert.rejects(manager.start('copilot', spec(fetchFn)), /already in progress/)
  attempt.cancel()
})

test('device flow: a malformed device-code response fails the start', async () => {
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [{ device_code: 'dc-1' }],
  })
  const manager = new DeviceFlowManager()
  await assert.rejects(manager.start('copilot', spec(fetchFn)), /missing/)
  assert.equal(manager.isBusy('copilot'), false)
})

test('device flow: a malformed device-code response fails the start without quoting the body', async () => {
  // Node's parse error quotes a bounded excerpt of the input, so a body that
  // begins with a credential would otherwise reach the Settings error line.
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [new Response('sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')],
  })
  const manager = new DeviceFlowManager()
  await assert.rejects(manager.start('copilot', spec(fetchFn)), (caught: unknown) => {
    assert.ok(caught instanceof SyntaxError)
    assert.equal(caught.cause, undefined)
    assert.equal(caught.message, 'device code request: invalid JSON: [provider response body omitted]')
    return true
  })
  assert.equal(manager.isBusy('copilot'), false)
})

test('device flow: a malformed token-poll response fails the login without quoting the body', async () => {
  const { fetchFn, bodies } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE],
    [TOKEN_URL]: [new Response('sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))
  await assert.rejects(attempt.waitToken(), (caught: unknown) => {
    assert.ok(caught instanceof SyntaxError)
    assert.equal(caught.cause, undefined)
    assert.equal(caught.message, 'device token poll: invalid JSON: [provider response body omitted]')
    return true
  })
  assert.equal(bodies(TOKEN_URL).length, 1, 'a parse failure settles the login without polling again')
  assert.equal(manager.isBusy('copilot'), false)
})
