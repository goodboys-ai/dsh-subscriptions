import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cursorUserId, fetchCursorUsage } from '../src/providers/cursor-usage.js'

function token(sub: string): string {
  return `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`
}

test('Cursor usage reads individual dashboard pools and legacy requests with a local cookie', async () => {
  const access = token('github|user_123')
  const urls: string[] = []
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url))
    const headers = init?.headers as Record<string, string>
    assert.equal(headers.cookie, `WorkosCursorSessionToken=user_123::${access}`)
    assert.equal(headers.origin, 'https://cursor.com')
    return String(url).includes('usage-summary')
      ? Response.json({
        membershipType: 'pro', billingCycleStart: '2026-09-15T00:00:00Z', billingCycleEnd: '2026-10-15T00:00:00Z',
        individualUsage: { plan: { totalPercentUsed: 40, autoPercentUsed: 12.5, apiPercentUsed: 67 } },
      })
      : Response.json({ 'gpt-4': { numRequests: 30, maxRequestUsage: 100 } })
  }) as typeof fetch
  const result = await fetchCursorUsage(access, http)
  assert.deepEqual(urls.sort(), [
    'https://cursor.com/api/usage-summary',
    'https://cursor.com/api/usage?user=user_123',
  ])
  assert.deepEqual(result, {
    supported: true, plan: 'pro', windows: [
      { kind: 'other', scope: 'Included', usedPercent: 40, startsAt: Date.parse('2026-09-15T00:00:00Z'), resetsAt: Date.parse('2026-10-15T00:00:00Z') },
      { kind: 'other', scope: 'Cursor Models', usedPercent: 12.5, startsAt: Date.parse('2026-09-15T00:00:00Z'), resetsAt: Date.parse('2026-10-15T00:00:00Z') },
      { kind: 'other', scope: 'Other Models', usedPercent: 67, startsAt: Date.parse('2026-09-15T00:00:00Z'), resetsAt: Date.parse('2026-10-15T00:00:00Z') },
      { kind: 'other', scope: 'Included requests', usedPercent: 30, startsAt: Date.parse('2026-09-15T00:00:00Z'), resetsAt: Date.parse('2026-10-15T00:00:00Z') },
    ],
  })
  assert.ok(!JSON.stringify(result).includes(access))
})

test('Cursor usage survives one failed endpoint but rejects absent quota facts', async () => {
  const access = token('user_123')
  const summaryOnly = (async (url: string | URL | Request) => String(url).includes('usage-summary')
    ? Response.json({ individualUsage: { plan: { totalPercentUsed: 22 } } })
    : new Response('', { status: 503 })) as typeof fetch
  assert.deepEqual((await fetchCursorUsage(access, summaryOnly)).windows,
    [{ kind: 'other', scope: 'Included', usedPercent: 22 }])
  const empty = (async () => Response.json({})) as typeof fetch
  await assert.rejects(() => fetchCursorUsage(access, empty), /no quota windows/)
  const failed = (async () => new Response('', { status: 401 })) as typeof fetch
  await assert.rejects(() => fetchCursorUsage(access, failed), /HTTP 401/)
})

test('Cursor user-id decoding rejects malformed and unsafe JWT subjects', () => {
  assert.equal(cursorUserId(token('google-oauth2|user_123')), 'user_123')
  assert.equal(cursorUserId('not-a-jwt'), undefined)
  assert.equal(cursorUserId(token('user;bad')), undefined)
})

test('Cursor usage rejects a malformed dashboard body without quoting it', async () => {
  // Both endpoints fail, so the reader rethrows the first parse error; with one
  // healthy endpoint the failure is swallowed by design and nothing is displayed.
  const http = (async () => new Response('sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')) as typeof fetch
  await assert.rejects(() => fetchCursorUsage(token('user_123'), http), (error: unknown) => {
    assert.ok(error instanceof SyntaxError)
    assert.equal(error.cause, undefined)
    assert.equal(error.message, 'Cursor usage: invalid JSON: [provider response body omitted]')
    return true
  })
})
