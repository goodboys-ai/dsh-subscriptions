import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ClaudeSession } from '../src/auth/store.js'
import { CLAUDE_USAGE_URL, fetchClaudeUsage } from '../src/providers/claude.js'
import { OAuthEndpointError } from '../src/providers/common.js'
import type { FetchFn } from '../src/providers/common.js'

// Response fixtures follow ItsJazii/pane's observed shape, not an official API contract.
const session: ClaudeSession = { accessToken: 'fake-at', refreshToken: 'fake-rt', expiresAt: 0, scopes: 'scope' }
const version = async (): Promise<string> => '2.1.999'
const expiry = Date.parse('2099-10-22T16:00:00Z')
const grant = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, resets_total: 2, resets_left: 2, ends_at: expiry, usable_now: true, paused: false, ...overrides,
})
const windowsPayload = {
  five_hour: { utilization: 12, resets_at: '2026-10-22T16:00:00Z' },
  seven_day: { utilization: 34, resets_at: '2026-10-29T16:00:00Z' },
}
const expectedWindows = [
  { kind: 'session', usedPercent: 12, resetsAt: Date.parse('2026-10-22T16:00:00Z'), windowDurationMs: 18_000_000, fixedWindow: true },
  { kind: 'weekly', usedPercent: 34, resetsAt: Date.parse('2026-10-29T16:00:00Z'), windowDurationMs: 604_800_000, fixedWindow: true },
]
const credit = (id: string, claimable = false, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, expiresAt: expiry, resetsTotal: 2, resetsLeft: 2, usableNow: true, paused: false, claimable, ...overrides,
})
function fake(...responses: { payload: unknown; status?: number }[]): {
  fetchFn: FetchFn
  calls: { url: string; init: RequestInit | undefined }[]
} {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchFn: FetchFn = async (input, init) => {
    calls.push({ url: String(input), init })
    const response = responses[calls.length - 1]
    assert.ok(response, 'unexpected extra usage request')
    assert.equal(init?.method ?? 'GET', 'GET', 'banked reset lookup must never write')
    assert.equal(init?.body, undefined)
    return Response.json(response.payload, { status: response.status ?? 200 })
  }
  return { fetchFn, calls }
}
async function readEmber(ember: unknown, windows: Record<string, unknown> = windowsPayload) {
  return fetchClaudeUsage(session, fake({ payload: { ...windows, cedar_ember: ember } }).fetchFn, undefined, version)
}

test('Claude banked resets expose grants and only the server-selected grant is claimable', async () => {
  const usage = await readEmber({ eligible: true, next_grant_id: 'selected', cooldown_until: null,
    grants: [grant('other'), grant('selected')] })
  assert.deepEqual(usage.resetCredits, [credit('other'), credit('selected', true)])
  assert.deepEqual(usage.windows, expectedWindows, 'credit expiry must not become a resetting usage window')
  assert.equal(usage.resetCreditsError, undefined)
})

test('Claude banked resets survive the modern limits-array path', async () => {
  const usage = await readEmber({ eligible: true, next_grant_id: 'selected', grants: [grant('selected')] },
    { limits: [{ kind: 'session', percent: 12, resets_at: '2026-10-22T16:00:00Z' }] })
  assert.deepEqual(usage.resetCredits, [credit('selected', true)])
  assert.deepEqual(usage.windows, [expectedWindows[0]])
})

test('Claude banked reset query preserves the existing CLI User-Agent and caller signal at fetch', async () => {
  const { fetchFn, calls } = fake({ payload: windowsPayload })
  const signal = new AbortController().signal
  await fetchClaudeUsage(session, fetchFn, signal, version)
  assert.equal(calls[0].url, `${CLAUDE_USAGE_URL}?cedar_ember=1`)
  const headers = new Headers(calls[0].init?.headers)
  assert.equal(headers.get('user-agent'), 'claude-cli/2.1.999 (external, cli)')
  assert.equal(headers.get('authorization'), 'Bearer fake-at')
  assert.equal(headers.get('anthropic-beta'), 'oauth-2025-04-20')
  assert.equal(headers.get('accept'), 'application/json')
  assert.equal(calls[0].init?.signal, signal)
})

test('Claude banked resets hide missing, non-object, and not-exactly-eligible blocks', async () => {
  for (const ember of [undefined, null, [], 'not an object', false, 7,
    { eligible: false, grants: [grant('g')] }, { eligible: 'true', grants: [grant('g')] },
    { grants: [grant('g')] }, { eligible: true, grants: [] }, { eligible: true, grants: 'bad' }]) {
    const usage = await readEmber(ember)
    assert.equal(Object.hasOwn(usage, 'resetCredits'), false)
    assert.equal(usage.resetCreditsError, undefined)
    assert.deepEqual(usage.windows, expectedWindows)
  }
})

for (const status of [400, 403]) {
  test(`Claude banked query HTTP ${status} retries once without the parameter and retains plain windows`, async () => {
    const { fetchFn, calls } = fake({ payload: { error: 'optional query rejected' }, status }, { payload: windowsPayload })
    const signal = new AbortController().signal
    const usage = await fetchClaudeUsage(session, fetchFn, signal, version)
    assert.deepEqual(calls.map(call => call.url), [`${CLAUDE_USAGE_URL}?cedar_ember=1`, CLAUDE_USAGE_URL])
    assert.deepEqual(calls[1].init?.headers, calls[0].init?.headers)
    assert.equal(calls[1].init?.signal, signal)
    assert.deepEqual(usage.windows, expectedWindows)
    assert.equal(usage.resetCredits, undefined)
    assert.match(usage.resetCreditsError ?? '', new RegExp(`HTTP ${status}`))
  })
}

test('Claude banked query fallback is bounded and plain usage failures still propagate', async () => {
  const { fetchFn, calls } = fake({ payload: {}, status: 400 }, { payload: {}, status: 403 })
  await assert.rejects(fetchClaudeUsage(session, fetchFn, undefined, version), (error: unknown) => {
    assert.ok(error instanceof OAuthEndpointError)
    assert.equal(error.status, 403)
    return true
  })
  assert.equal(calls.length, 2)
})

test('Claude banked query does not retry authentication, rate-limit, or server errors', async () => {
  for (const status of [401, 429, 500]) {
    const { fetchFn, calls } = fake({ payload: {}, status })
    await assert.rejects(fetchClaudeUsage(session, fetchFn, undefined, version), (error: unknown) => {
      assert.ok(error instanceof OAuthEndpointError)
      assert.equal(error.status, status)
      return true
    })
    assert.equal(calls.length, 1)
  }
})

test('Claude grant expiry parses epoch seconds, milliseconds, and ISO; bad grants drop individually', async () => {
  const ends = Date.parse('2026-10-22T16:00:00Z')
  const usage = await readEmber({ eligible: true, grants: [
    grant('seconds', { ends_at: ends / 1000 }), grant('millis', { ends_at: ends }),
    grant('iso', { ends_at: '2026-10-22T16:00:00+00:00' }),
    grant('bad-date', { ends_at: 'not-a-date' }), grant('numeric-string', { ends_at: String(ends / 1000) }),
    grant('null-expiry', { ends_at: null }), grant('', {}), grant('no-total', { resets_total: 0 }),
    grant('no-left', { resets_left: undefined }), grant('fraction', { resets_left: 1.5 }),
    grant('bad-flag', { paused: 'false' }), null, [], 'invalid',
    grant('after-bad', { ends_at: ends }),
  ] })
  assert.deepEqual(usage.resetCredits, ['seconds', 'millis', 'iso', 'after-bad'].map(id => credit(id, false, { expiresAt: ends })))
  assert.deepEqual(usage.windows, expectedWindows)
})

test('Claude window resets parse epoch seconds, milliseconds, and ISO in both response shapes', async () => {
  const reset = Date.parse('2026-10-22T16:00:00Z')
  for (const resets_at of [reset / 1000, reset, '2026-10-22T16:00:00Z']) {
    const legacy = await readEmber(undefined, { five_hour: { utilization: 12, resets_at } })
    const modern = await readEmber(undefined, { limits: [{ kind: 'session', percent: 12, resets_at }] })
    assert.deepEqual(legacy.windows, [expectedWindows[0]])
    assert.deepEqual(modern.windows, [expectedWindows[0]])
  }
})

test('Claude cooldown parses all timestamp forms and leaves grants display-only while future', async () => {
  const future = Date.parse('2099-01-01T00:00:00Z')
  for (const cooldown_until of [future / 1000, future, '2099-01-01T00:00:00Z']) {
    const usage = await readEmber({ eligible: true, next_grant_id: 'selected', cooldown_until, grants: [grant('selected')] })
    assert.deepEqual(usage.resetCredits, [credit('selected', false, { cooldownUntil: future })])
  }
  const past = await readEmber({ eligible: true, next_grant_id: 'selected', cooldown_until: '2020-01-01T00:00:00Z', grants: [grant('selected')] })
  assert.deepEqual(past.resetCredits, [credit('selected', true, { cooldownUntil: Date.parse('2020-01-01T00:00:00Z') })])
  const unknown = await readEmber({ eligible: true, next_grant_id: 'selected', cooldown_until: 'bad', grants: [grant('selected')] })
  assert.deepEqual(unknown.resetCredits, [credit('selected')], 'unknown cooldown must not advertise claimability')
})

test('Claude unusable, paused, unselected, and expired grants cannot advertise claimability', async () => {
  const missingUsable = credit('selected')
  delete missingUsable.usableNow
  const cases = [
    { wire: { usable_now: false }, expected: credit('selected', false, { usableNow: false }) },
    { wire: { paused: true }, expected: credit('selected', false, { paused: true }) },
    { wire: { usable_now: undefined }, expected: missingUsable },
    { wire: { ends_at: 1_600_000_000 }, expected: credit('selected', false, { expiresAt: 1_600_000_000_000 }) },
  ]
  for (const { wire, expected } of cases) {
    const usage = await readEmber({ eligible: true, next_grant_id: 'selected', grants: [grant('selected', wire)] })
    assert.deepEqual(usage.resetCredits, [expected])
  }
  const usage = await readEmber({ eligible: true, grants: [grant('selected')] })
  assert.deepEqual(usage.resetCredits, [credit('selected')])
})

test('Claude counts clamp to total, omit depleted grants, and duplicate ids cannot advertise multiple claims', async () => {
  const usage = await readEmber({ eligible: true, next_grant_id: 'selected', grants: [
    grant('selected', { resets_left: 5 }), grant('selected'), grant('empty', { resets_left: 0 }),
    grant('negative', { resets_left: -2 }),
  ] })
  assert.deepEqual(usage.resetCredits, [credit('selected', true), credit('selected')])
})
