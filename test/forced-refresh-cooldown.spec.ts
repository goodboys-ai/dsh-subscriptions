/**
 * The forced-refresh cooldown clear, end to end: the Settings "Refresh"
 * button (a `usage` RPC with `force: true`) must lift the account's pool
 * cooldowns so the next request retries it instead of failing with the
 * pool-exhausted error. The wiring under test — the `onUsageForced` argument
 * of `new SubscriptionsAuthController(...)` inside `apply()` — is invisible
 * to the unit-level usage specs (they pass their own fake callback), so this
 * spec drives the REAL plugin: the real `apply()`, the real pool route, the
 * real codex adapter, and the real `usage` RPC endpoint.
 *
 * The virtual provider answers the Responses endpoint with a 500, which
 * `httpLlmError` maps to SERVER and `classifyPoolFailure` parks as a
 * transient member cooldown. The adapter-call counter is what proves the
 * cooldown: a cooling member is filtered by `select()` before the adapter is
 * ever asked to stream, so "rejected without a call" is a cooldown refusal,
 * not a different failure.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import type { AccountAwareAdapter } from '../src/providers/accounts.js'
import { saveAccountSession } from '../src/auth/store.js'
import * as plugin from '../src/index.js'
import { createFakeConnection } from './fake-connection.js'

const MODEL = 'gpt-5.3-codex'
const ACCOUNT = 'acct'

/** Brand a string as a GenerateOptions sessionId (the loop-stamped session identity). */
const SessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

const OPTIONS: GenerateOptions = {
  provider: 'codex',
  model: MODEL,
  sessionId: SessionId('forced-refresh-session'),
  messages: [
    {
      id: MessageId('user'),
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    },
  ],
}

/** Drain a stream, returning the text-delta payload; the error propagates. */
async function collect(
  stream: AsyncIterable<{ type: string; text?: string }>,
): Promise<string> {
  let text = ''
  for await (const chunk of stream)
    if (chunk.type === 'text-delta') text += chunk.text
  return text
}

/**
 * Install the plugin with the pool enabled and one codex account, and drive
 * the cooldown lifecycle through the real routes.
 *
 * The fake fetch is deliberately minimal: catalog discovery answers with the
 * single pooled model (the pool assembles members from each account's
 * discovered catalog), the usage endpoint answers a normal snapshot, and the
 * Responses endpoint 500s — the only failure the pool classifier turns into
 * a cooldown that a forced refresh is meant to lift.
 */
test('a forced usage refresh lifts the pool cooldown; a non-forced one does not', async () => {
  const home = await mkdtemp(join(tmpdir(), 'forced-refresh-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapters = new Map<string, AccountAwareAdapter>()
  ctx.provide('llm', {
    registerAdapter: (routes: string[], adapter: AccountAwareAdapter) => {
      adapters.set(routes[0], adapter)
      return Object.assign(() => {}, { replace: () => {} })
    },
  })
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)

  const original = globalThis.fetch
  let responsesCalls = 0
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://chatgpt.com/backend-api/codex/models')) {
      return Response.json({
        models: [{ slug: MODEL, display_name: 'GPT-5.3 Codex' }],
      })
    }
    if (url.startsWith('https://chatgpt.com/backend-api/wham/usage')) {
      return Response.json({
        plan_type: 'plus',
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 18_000,
            reset_after_seconds: 3600,
          },
        },
      })
    }
    if (
      url.startsWith(
        'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      )
    ) {
      return Response.json({ credits: [] })
    }
    if (url === 'https://chatgpt.com/backend-api/codex/responses') {
      responsesCalls += 1
      return new Response('boom', { status: 500 })
    }
    throw new Error(`forced-refresh fixture has no route for ${url}`)
  }) as typeof fetch

  const runtime = ctx.plugin(plugin, {
    providers: ['codex'],
    pool: { enabled: true, strategy: 'priority', autoAccounts: true },
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(
      connection.registered(),
      'the subscriptions-auth Fetch routes were registered',
    )
    await saveAccountSession('codex', ACCOUNT, {
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3600_000,
      accountId: ACCOUNT,
      idToken: '',
    })
    const call = (endpoint: string, payload: unknown) =>
      connection.handler(endpoint, payload, new AbortController().signal)
    const route = adapters.get('codex')!

    // The pool route owns the model only once discovery has listed the
    // account's catalog; without that, stream() would answer "unknown pool
    // model" and never reach member selection.
    let owns = false
    for (let attempt = 0; attempt < 50 && !owns; attempt += 1) {
      owns = await route.resolveModel('codex', MODEL).then(
        () => true,
        () => false,
      )
      if (!owns) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(
      owns,
      'the pool route owns the model once the account catalog is discovered',
    )

    // (1) The first request fails and parks the member on a cooldown.
    await assert.rejects(() => collect(route.stream(OPTIONS)))
    assert.equal(responsesCalls, 1, 'the failing request reached the adapter')

    // (2) The cooldown refusal must NOT reach the adapter: select() filters
    // the cooling member out, and the exhausted error names the cooldown.
    await assert.rejects(
      () => collect(route.stream(OPTIONS)),
      (error: unknown) =>
        error instanceof Error &&
        /cooling down|exhausted|no usable member/i.test(error.message),
    )
    assert.equal(
      responsesCalls,
      1,
      'the cooling member was refused without an adapter call',
    )

    // (3) The Settings "Refresh" button: a forced usage refresh is the
    // user's "retry now" and lifts that account's cooldowns.
    const usage = await call('usage', {
      provider: 'codex',
      account: ACCOUNT,
      force: true,
    })
    assert.ok(usage.ok, 'the forced usage refresh answered')

    // (4) The member serves again.
    await assert.rejects(() => collect(route.stream(OPTIONS)))
    assert.equal(responsesCalls, 2, 'the forced refresh lifted the cooldown')

    // Negative control: the failure in (4) re-parked the member, so the
    // stream is refused again without an adapter call — and a NON-forced
    // usage call (the Settings page opening) must leave it parked.
    await assert.rejects(() => collect(route.stream(OPTIONS)))
    assert.equal(
      responsesCalls,
      2,
      'the cooldown from the (4) failure still refused the member',
    )
    const unforced = await call('usage', {
      provider: 'codex',
      account: ACCOUNT,
    })
    assert.ok(unforced.ok, 'the non-forced usage call answered')
    await assert.rejects(() => collect(route.stream(OPTIONS)))
    assert.equal(
      responsesCalls,
      2,
      'a non-forced usage call left the cooldown in place',
    )
  } finally {
    globalThis.fetch = original
    await runtime.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
