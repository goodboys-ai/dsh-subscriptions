import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchKimiCodeUsage, fetchOpenCodeGoUsage } from '../src/providers/external-usage.js'

test('OpenCode Go usage maps all three windows and sends the key only upstream', async () => {
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, 'https://opencode.ai/zen/go/v1/usage')
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer secret')
    return Response.json({ usage: {
      rolling: { status: 'ok', percent: 25, resetsAt: '2026-09-28T08:00:00Z' },
      weekly: { status: 'ok', percent: 50, resetsAt: '2026-10-01T00:00:00Z' },
      monthly: { status: 'ok', percent: 75, resetsAt: '2026-10-28T00:00:00Z' },
    } })
  }) as typeof fetch
  assert.deepEqual(await fetchOpenCodeGoUsage('secret', http), {
    supported: true,
    plan: 'OpenCode Go',
    windows: [
      { kind: 'session', usedPercent: 25, fixedWindow: true, windowDurationMs: 18_000_000, resetsAt: Date.parse('2026-09-28T08:00:00Z') },
      { kind: 'weekly', usedPercent: 50, fixedWindow: true, windowDurationMs: 604_800_000, resetsAt: Date.parse('2026-10-01T00:00:00Z') },
      { kind: 'other', scope: 'Monthly', usedPercent: 75, resetsAt: Date.parse('2026-10-28T00:00:00Z') },
    ],
  })
})

test('OpenCode Go HTTP errors do not disclose the key', async () => {
  const http = (async () => new Response('', { status: 401 })) as typeof fetch
  await assert.rejects(() => fetchOpenCodeGoUsage('go-secret', http), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /HTTP 401/)
    assert.ok(!error.message.includes('go-secret'))
    return true
  })
})

test('OpenCode Go rejects a malformed response instead of showing empty quota', async () => {
  const http = (async () => Response.json({ usage: { rolling: { percent: '25' } } })) as typeof fetch
  await assert.rejects(() => fetchOpenCodeGoUsage('secret', http), /no valid windows/)
})

test('Kimi Code usage maps present ratio pools and tolerates absent windows', async () => {
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, 'https://api.kimi.com/coding/v1/usages')
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer sk-kimi-secret')
    return Response.json({ usages: {
      limit_5h: { used_ratio: 0, reset_time: '2026-09-28T08:00:00Z' },
      limit_month_total: { used_ratio: 0.42, reset_time: '2026-10-17T00:00:00Z' },
      limit_month_code: { used_ratio: 0.7, reset_time: '2026-10-17T00:00:00Z' },
    } })
  }) as typeof fetch
  assert.deepEqual(await fetchKimiCodeUsage('sk-kimi-secret', http), {
    supported: true,
    plan: 'Kimi Code',
    windows: [
      { kind: 'session', usedPercent: 0, resetsAt: Date.parse('2026-09-28T08:00:00Z') },
      { kind: 'other', scope: 'Monthly', usedPercent: 42, resetsAt: Date.parse('2026-10-17T00:00:00Z') },
    ],
  })
})

test('Kimi official CLI shape preserves summary uncertainty and explicit weekly duration', async () => {
  const http = (async () => Response.json({
    usage: { limit: '100', remaining: '60', reset_at: '2026-10-01T00:00:00Z' },
    limits: [
      { window: { duration: 300, timeUnit: 'MINUTE' }, detail: { limit: 100, used: 25 } },
      { window: { duration: 7, timeUnit: 'DAY' }, detail: { limit: 100, remaining: 50 } },
    ],
  })) as typeof fetch
  const usage = await fetchKimiCodeUsage('key', http)
  assert.deepEqual(usage.windows, [
    { kind: 'other', usedPercent: 40, resetsAt: Date.parse('2026-10-01T00:00:00Z') },
    { kind: 'session', usedPercent: 25, windowDurationMs: 18_000_000 },
    { kind: 'weekly', usedPercent: 50, windowDurationMs: 604_800_000, fixedWindow: true },
  ])
})

test('Kimi Code HTTP errors do not disclose the key', async () => {
  const http = (async () => new Response('', { status: 401 })) as typeof fetch
  await assert.rejects(() => fetchKimiCodeUsage('sk-kimi-secret', http), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /HTTP 401/)
    assert.ok(!error.message.includes('secret'))
    return true
  })
})

for (const [name, read] of [
  ['OpenCode Go', fetchOpenCodeGoUsage],
  ['Kimi Code', fetchKimiCodeUsage],
] as const) {
  test(`${name} usage rejects a malformed body without quoting it`, async () => {
    const http = (async () => new Response('sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')) as typeof fetch
    await assert.rejects(() => read('secret', http), (error: unknown) => {
      assert.ok(error instanceof SyntaxError)
      assert.equal(error.cause, undefined)
      assert.equal(error.message, 'external usage: invalid JSON: [provider response body omitted]')
      return true
    })
  })
}
