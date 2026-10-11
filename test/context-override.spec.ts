/**
 * Local context-window overrides for Ollama Cloud and Claude. The adapters are
 * driven with discovery off or faked, so these prove the precedence and the
 * cap in the resolver, not what the live endpoints advertise.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAdapter } from '../src/providers/claude.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { DEFAULT_OLLAMA_BASE_URL, effectiveContextWindow, OLLAMA_CLOUD_ROUTE, OllamaAdapter } from '../src/providers/ollama.js'
import type { OllamaModelSetting } from '../src/providers/ollama-settings.js'
import { validateOllamaSettings } from '../src/providers/ollama-settings.js'
import { ProviderSettingsStore, validatePreferences } from '../src/provider-settings.js'
import type { FetchFn } from '../src/providers/common.js'

const row = (contextWindow: number, contextOverride?: number) => ({ contextWindow, contextOverride })

test('effectiveContextWindow: override wins below the advertised window and is capped above it', () => {
  assert.equal(effectiveContextWindow(row(262_144), undefined), 262_144)
  assert.equal(effectiveContextWindow(row(262_144, 100_000), undefined), 100_000)
  // The discovered window outranks the stored snapshot as the ceiling.
  assert.equal(effectiveContextWindow(row(262_144, 500_000), 1_000_000), 500_000)
  assert.equal(effectiveContextWindow(row(1_000_000, 900_000), 262_144), 262_144)
  assert.equal(effectiveContextWindow(row(262_144), 1_000_000), 1_000_000)
})

test('ollama store accepts contextOverride only as a positive integer', () => {
  assert.equal(validateOllamaSettings({ models: [{ id: 'm', contextOverride: 4096 }] }).models?.[0]?.contextOverride, 4096)
  for (const value of [0, -1, 1.5, '4096']) {
    assert.throws(() => validateOllamaSettings({ models: [{ id: 'm', contextOverride: value }] }), /contextOverride/)
  }
  assert.equal(validateOllamaSettings({ models: [{ id: 'm' }] }).models?.[0]?.contextOverride, undefined)
})

function ollama(catalog: OllamaModelSetting[], fetchFn?: FetchFn): OllamaAdapter {
  return new OllamaAdapter({
    apiKey: async () => 'k',
    baseURL: () => DEFAULT_OLLAMA_BASE_URL,
    catalog: () => catalog,
    discovery: fetchFn !== undefined,
    ...fetchFn === undefined ? {} : { fetchFn },
  })
}

test('ollama resolveModel plans against the override, never above the stored window', async () => {
  const adapter = ollama([
    { id: 'a:cloud', contextWindow: 262_144, contextOverride: 64_000 },
    { id: 'b:cloud', contextWindow: 262_144, contextOverride: 999_999 },
    { id: 'c:cloud', contextWindow: 262_144 },
  ])
  assert.equal((await adapter.resolveModel(OLLAMA_CLOUD_ROUTE, 'a:cloud')).context?.contextWindow, 64_000)
  assert.equal((await adapter.resolveModel(OLLAMA_CLOUD_ROUTE, 'b:cloud')).context?.contextWindow, 262_144)
  assert.equal((await adapter.resolveModel(OLLAMA_CLOUD_ROUTE, 'c:cloud')).context?.contextWindow, 262_144)
})

test('ollama resolveModel caps the override at the discovered window', async () => {
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/tags')) return Response.json({ models: [{ model: 'a' }] })
    return Response.json({ capabilities: ['tools'], model_info: { 'llama.context_length': 128_000 } })
  }) as FetchFn
  const adapter = ollama([{ id: 'a:cloud', contextWindow: 262_144, contextOverride: 200_000 }], fetchFn)
  // The stored snapshot says 262144, but the endpoint now says 128000.
  assert.equal((await adapter.resolveModel(OLLAMA_CLOUD_ROUTE, 'a:cloud')).context?.contextWindow, 128_000)
})

function claude(contextWindowOf?: (model: string) => number | undefined): ClaudeAdapter {
  const session = { accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } as unknown as ClaudeSession
  return new ClaudeAdapter({
    models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1_000_000 }, { id: 'claude-haiku-5' }],
    streamIdleTimeoutMs: 1000,
    tokens: new AccountTokenManager<ClaudeSession>({
      provider: 'claude',
      displayName: 'Test',
      makeOptions: () => ({ preemptMs: 0, refresh: s => Promise.resolve(s), isPermanent: () => false }),
      io: {
        list: () => Promise.resolve([{ key: 'acct', session }]),
        get: () => Promise.resolve(session),
        save: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
    }),
    discovery: false,
    ...contextWindowOf === undefined ? {} : { contextWindowOf },
  })
}

test('claude resolveModel honours a local override, capped at the advertised window', async () => {
  const overrides: Record<string, number> = { 'claude-opus-5-5': 400_000, 'claude-haiku-5': 5_000_000 }
  const adapter = claude(model => overrides[model])
  assert.equal((await adapter.resolveModel('claude', 'claude-opus-5-5')).context?.contextWindow, 400_000)
  // 200000 is the built-in fallback when neither discovery nor config says more.
  assert.equal((await adapter.resolveModel('claude', 'claude-haiku-5')).context?.contextWindow, 200_000)
  assert.equal((await claude().resolveModel('claude', 'claude-opus-5-5')).context?.contextWindow, 1_000_000)
  assert.deepEqual(await adapter.contextLimits('claude-opus-5-5'), { default: 1_000_000, max: 1_000_000 })
})

test('provider settings accept context windows for claude and keep them per provider', async () => {
  // The validator returns a null-prototype map on purpose, so compare entries.
  const accepted = validatePreferences('claude', { contextWindows: { 'claude-opus-5-5': 400_000 } }).contextWindows
  assert.deepEqual(Object.entries(accepted ?? {}), [['claude-opus-5-5', 400_000]])
  assert.throws(() => validatePreferences('grok', { contextWindows: { m: 1000 } }), /Codex and Claude/)
  const dir = await mkdtemp(join(tmpdir(), 'context-'))
  try {
    const store = new ProviderSettingsStore(join(dir, 'settings.json'))
    await store.set('claude', { contextWindows: { m: 300_000 } })
    await store.set('codex', { contextWindows: { m: 100_000 } })
    assert.equal(store.contextWindow('m', 'claude'), 300_000)
    assert.equal(store.contextWindow('m', 'codex'), 100_000)
    assert.equal(store.contextWindow('m'), 100_000)
    assert.equal(store.contextWindow('other', 'claude'), undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('claude resolves each account against its own advertised window', async () => {
  // Two accounts list the same model with different windows, told apart by
  // bearer token. A lookup that names an account must not borrow the other
  // account's catalog, or the small account would plan against the big window.
  const sessions: Record<string, ClaudeSession> = {
    big: { accessToken: 'tok-big', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } as unknown as ClaudeSession,
    small: { accessToken: 'tok-small', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } as unknown as ClaudeSession,
  }
  const windows: Record<string, number> = { 'tok-big': 1_000_000, 'tok-small': 200_000 }
  const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>)['authorization']).replace('Bearer ', '')
    return Response.json({ data: [{ id: 'claude-x', display_name: 'X', max_input_tokens: windows[token] }] })
  }) as FetchFn
  const adapter = new ClaudeAdapter({
    models: [],
    streamIdleTimeoutMs: 1000,
    fetchFn,
    discovery: true,
    contextWindowOf: () => 400_000,
    tokens: new AccountTokenManager<ClaudeSession>({
      provider: 'claude',
      displayName: 'Test',
      makeOptions: () => ({ preemptMs: 0, refresh: s => Promise.resolve(s), isPermanent: () => false }),
      io: {
        list: () => Promise.resolve(Object.entries(sessions).map(([key, session]) => ({ key, session }))),
        get: (key?: string) => Promise.resolve(sessions[key ?? 'big']),
        save: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
    }),
  })
  assert.deepEqual(await adapter.contextLimits('claude-x', 'small'), { default: 200_000, max: 200_000 })
  assert.deepEqual(await adapter.contextLimits('claude-x', 'big'), { default: 1_000_000, max: 1_000_000 })
  // The same 400K override is capped per account: below the big window, at the small one.
  assert.equal((await adapter.resolveOwnModel('claude', 'claude-x', 'big')).context?.contextWindow, 400_000)
  assert.equal((await adapter.resolveOwnModel('claude', 'claude-x', 'small')).context?.contextWindow, 200_000)
})
