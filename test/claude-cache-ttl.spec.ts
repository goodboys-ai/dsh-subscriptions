/**
 * The adapter's cache TTL option reaches every marker on the request wire.
 * Fetch is stubbed; these tests do not establish live cache hits or pricing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ClaudeAdapter } from '../src/providers/claude.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { cacheControl, markMessageCache, toAnthropicSystem } from '../src/translate/anthropic.js'
import type { PromptCacheTtl } from '../src/translate/anthropic.js'

const session: ClaudeSession = { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scopes: 'scope' }

function tokens(): AccountTokenManager<ClaudeSession> {
  return new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Test',
    makeOptions: () => ({ preemptMs: 0, refresh: s => Promise.resolve(s), isPermanent: () => false }),
    io: {
      list: () => Promise.resolve([{ key: 'acct', session }]),
      get: () => Promise.resolve(session),
      save: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
  })
}

/** Send one turn through the adapter with fetch stubbed; return its POST body. */
async function sentBody(promptCacheTtl: PromptCacheTtl | undefined): Promise<{ system: Record<string, unknown>[], messages: { content: Record<string, unknown>[] }[] }> {
  const original = globalThis.fetch
  let body = ''
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = String(init?.body)
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'stop here' } }), { status: 400 })
  }) as typeof globalThis.fetch
  try {
    const adapter = new ClaudeAdapter({
      models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
      streamIdleTimeoutMs: 1000,
      tokens: tokens(),
      discovery: false,
      resolveCliVersion: async () => '2.1.999',
      ...promptCacheTtl === undefined ? {} : { promptCacheTtl },
    })
    const options: GenerateOptions = {
      provider: 'claude',
      model: 'claude-opus-5-5',
      system: 'be brief',
      messages: [{ id: MessageId('m'), role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
      maxTokens: 1_000,
    }
    await assert.rejects(async () => { for await (const _chunk of adapter.stream(options)) { /* drain */ } })
    return JSON.parse(body) as never
  } finally {
    globalThis.fetch = original
  }
}

const markers = (body: Awaited<ReturnType<typeof sentBody>>): unknown[] =>
  [...body.system, ...body.messages.flatMap(entry => entry.content)]
    .filter(block => block.cache_control !== undefined)
    .map(block => block.cache_control)

test('a Claude turn sends five-minute cache marks unless the adapter is told otherwise', async () => {
  for (const ttl of [undefined, '5m'] as const) {
    const body = await sentBody(ttl)
    assert.deepEqual(markers(body), [{ type: 'ephemeral' }, { type: 'ephemeral' }], `promptCacheTtl=${String(ttl)}`)
  }
})

test('a Claude turn sends one-hour cache marks when the adapter is configured for them', async () => {
  const body = await sentBody('1h')
  assert.deepEqual(
    markers(body),
    [{ type: 'ephemeral', ttl: '1h' }, { type: 'ephemeral', ttl: '1h' }],
    'both the tools+system mark and the conversation tail mark carry the one-hour TTL',
  )
})

test('cacheControl spells five minutes by omitting ttl, and one hour explicitly', () => {
  assert.deepEqual(cacheControl(), { type: 'ephemeral' })
  assert.deepEqual(cacheControl('5m'), { type: 'ephemeral' })
  assert.deepEqual(cacheControl('1h'), { type: 'ephemeral', ttl: '1h' })
  assert.notEqual(cacheControl('1h'), cacheControl('1h'), 'every mark is its own object')
})

test('markMessageCache and toAnthropicSystem apply one TTL to every mark they place', () => {
  const content: Record<string, unknown>[] = Array.from(
    { length: 40 },
    (_, index) => ({ type: 'text', text: `b${index}` }),
  )
  markMessageCache([{ role: 'user', content }], '1h')
  const marked = content.filter(block => 'cache_control' in block)
  assert.equal(marked.length, 3)
  for (const block of marked) assert.deepEqual(block.cache_control, { type: 'ephemeral', ttl: '1h' })

  assert.deepEqual(toAnthropicSystem('explicit', undefined, '1h'), [
    { type: 'text', text: toAnthropicSystem()[0]!.text },
    { type: 'text', text: 'explicit', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ])
})

