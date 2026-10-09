import test from 'node:test'
import assert from 'node:assert/strict'
import { ResetRedemption } from '../src/providers/reset-redemption.js'
import { consumeCodexResetCredit } from '../src/providers/codex.js'
import type { ProviderUsage } from '../src/providers/common.js'

function usage(percent = 90): ProviderUsage {
  return { supported: true, windows: [{ kind: 'weekly', usedPercent: percent, resetsAt: Date.now() + 60000 }], resetCredits: [{ id: 'later', expiresAt: Date.now() + 60000 }, { id: 'first', expiresAt: Date.now() + 30000 }] }
}
const signal = new AbortController().signal

test('manual reset blocks low/missing usage and selects earliest expiry', async () => {
  let snapshot = usage(79)
  const calls: string[] = []
  const service = new ResetRedemption(async () => snapshot, async (_, id) => { calls.push(id) }, () => {}, async account => account)
  await assert.rejects(service.prepare('a', signal), /80%/)
  snapshot = usage()
  const confirmation = await service.prepare('a', signal)
  await service.redeem('a', confirmation.ticket, signal)
  assert.deepEqual(calls, ['first'])
  await assert.rejects(service.redeem('a', confirmation.ticket, signal), /expired/)
  snapshot = { supported: true }
  await assert.rejects(service.prepare('a', signal), /80%/)
})

test('manual reset rechecks usage, binds account and parks uncertain submissions', async () => {
  let snapshot = usage()
  let calls = 0
  const service = new ResetRedemption(async () => snapshot, async () => { calls++; throw new Error('timeout') }, () => {}, async account => account)
  let confirmation = await service.prepare('a', signal)
  await assert.rejects(service.redeem('b', confirmation.ticket, signal), /expired/)
  confirmation = await service.prepare('a', signal)
  snapshot = usage(10)
  await assert.rejects(service.redeem('a', confirmation.ticket, signal), /80%/)
  assert.equal(calls, 0)
  snapshot = usage()
  confirmation = await service.prepare('a', signal)
  await assert.rejects(service.redeem('a', confirmation.ticket, signal), /could not be confirmed/)
  await assert.rejects(service.prepare('a', signal), /outcome is uncertain/)
  assert.equal(calls, 1)
})

test('expired confirmation and removed credit never submit a reset', async t => {
  let snapshot = usage()
  let calls = 0
  const service = new ResetRedemption(async () => snapshot, async () => { calls++ }, () => {}, async account => account)
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  snapshot = usage()
  const expired = await service.prepare('a', signal)
  t.mock.timers.tick(60_001)
  await assert.rejects(service.redeem('a', expired.ticket, signal), /expired/)
  snapshot = usage()
  const removed = await service.prepare('a', signal)
  snapshot.resetCredits = []
  await assert.rejects(service.redeem('a', removed.ticket, signal), /no longer available/)
  assert.equal(calls, 0)
})

test('in-flight redemption blocks another confirmation and invalidates usage once', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let invalidations = 0
  let calls = 0
  const service = new ResetRedemption(async () => usage(), async () => { calls++; await pending }, () => { invalidations++ }, async account => account)
  const confirmation = await service.prepare('a', signal)
  const redemption = service.redeem('a', confirmation.ticket, signal)
  await assert.rejects(service.prepare('a', signal), /pending/)
  await assert.rejects(service.redeem('a', confirmation.ticket, signal), /expired/)
  release()
  await redemption
  assert.equal(calls, 1)
  assert.equal(invalidations, 1)
})

test('unexpected consume responses are not silently accepted or retried', async () => {
  let calls = 0
  await assert.rejects(consumeCodexResetCredit({ accessToken: 'fake', refreshToken: 'fake', accountId: 'a', expiresAt: 0 }, 'credit', 'request', async () => {
    calls++
    return new Response(JSON.stringify({ code: 'unknown' }), { status: 200 })
  }, signal), /not confirmed/)
  assert.equal(calls, 1)
})

test('a ticket cannot be spent when its window closes during the read', async t => {
  let calls = 0
  let reads = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  // The weekly window and the credit stay valid past the ticket, so only the
  // confirmation window can reject this submission.
  const live = { supported: true, windows: [{ kind: 'weekly' as const, usedPercent: 90, resetsAt: 3_600_000 }],
    resetCredits: [{ id: 'credit', expiresAt: 3_600_000 }] } satisfies ProviderUsage
  // The FIRST read backs prepare(); the SECOND one is the re-check inside
  // redeem(), and it is the one that must outlive the ticket.
  const read = async (): Promise<ProviderUsage> => {
    if (++reads === 2) await gate
    return live
  }
  const service = new ResetRedemption(read, async () => { calls++ }, () => {}, async account => account)
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const confirmation = await service.prepare('a', signal)
  const redemption = service.redeem('a', confirmation.ticket, signal)
  // Let redeem() pass its entry check and reach the read before time passes.
  await Promise.resolve()
  assert.equal(reads, 2, 'redeem should be inside the re-check read')
  t.mock.timers.tick(60_001)
  release()
  await assert.rejects(redemption, /Confirmation expired/)
  assert.equal(calls, 0, 'no reset may be submitted on an expired confirmation')
})

test('a redeemed credit is submitted once, and the service passes its own ids', async () => {
  const seen: { creditId: string; requestId: string }[] = []
  const service = new ResetRedemption(async () => usage(), async (_account, creditId, requestId) => {
    seen.push({ creditId, requestId })
  }, () => {}, async account => account)
  const confirmation = await service.prepare('a', signal)
  await service.redeem('a', confirmation.ticket, signal)
  assert.equal(seen.length, 1, 'exactly one submission')
  assert.equal(seen[0]?.creditId, 'first', 'the earliest-expiring available credit')
  assert.ok(seen[0]?.requestId && seen[0].requestId.length > 0, 'each submission carries its own request id')
})

// The seam above proves the state machine submits once; this proves what goes
// on the wire for that one submission.
test('the consume call posts one reset with the credit and request ids', async () => {
  const sent: { url: string; init: RequestInit }[] = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} })
    return Response.json({ code: 'reset' })
  }) as unknown as typeof fetch
  await consumeCodexResetCredit(
    { accessToken: 'fake-access', refreshToken: 'fake-refresh', accountId: 'acct-1', expiresAt: 0 },
    'credit-7', 'req-9', fetcher, signal,
  )
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume')
  assert.equal(sent[0]?.init.method, 'POST')
  assert.deepEqual(JSON.parse(String(sent[0]?.init.body)), { redeem_request_id: 'req-9', credit_id: 'credit-7' })
  const headers = sent[0]?.init.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer fake-access')
  assert.equal(headers['chatgpt-account-id'], 'acct-1')
})

test('an alias of a parked account cannot prepare or submit a second reset', async () => {
  // One real account reachable by two references; the session layer maps both
  // to the same accountId, which is what the guards must key on.
  const aliases = new Map([['acct-canonical', 'acct-1'], ['user@example.com', 'acct-1'], ['ws-77', 'acct-1']])
  const canonical = async (account: string) => aliases.get(account) ?? account
  let calls = 0
  const service = new ResetRedemption(async () => usage(), async () => { calls++; throw new Error('timeout') }, () => {}, canonical)

  const first = await service.prepare('acct-canonical', signal)
  await assert.rejects(service.redeem('acct-canonical', first.ticket, signal), /could not be confirmed/)
  // The account is now parked as uncertain. Every other reference to it must
  // stay blocked, and no second submission may leave the process.
  for (const alias of ['user@example.com', 'ws-77', 'acct-canonical']) {
    await assert.rejects(service.prepare(alias, signal), /uncertain/)
  }
  assert.equal(calls, 1)
})


test('a prepare that reads across an uncertain redemption is refused a ticket', async () => {
  // The hazard is a prepare blocked on its read while another client's
  // redemption ends ambiguously. Minting a ticket then would leave the account
  // parked and handable at the same time. A completed, successful redemption
  // deliberately clears the park and must still allow a later prepare.
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let reads = 0
  const live = (): ProviderUsage => ({ supported: true,
    windows: [{ kind: 'weekly', usedPercent: 90, resetsAt: Date.now() + 3_600_000 }],
    resetCredits: [{ id: 'credit', expiresAt: Date.now() + 3_600_000 }] })
  let attempt = 0
  const service = new ResetRedemption(async () => {
    if (++reads === 1) await gate
    return live()
  }, async () => { attempt += 1; throw new Error('ambiguous response') }, () => {}, async account => account)

  const preparing = service.prepare('a', signal)
  const first = await service.prepare('a', signal)
  // This one fails in flight, so the account stays parked as uncertain.
  await assert.rejects(service.redeem('a', first.ticket, signal), /could not be confirmed/)
  release()
  await assert.rejects(preparing, /pending or its outcome is uncertain/)
  assert.equal(attempt, 1, 'the ambiguous submission is the only one that leaves the process')
  await assert.rejects(service.prepare('a', signal), /outcome is uncertain/)
})
