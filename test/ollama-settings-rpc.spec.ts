/**
 * Ollama Cloud settings RPC tests: the `ollamaSettings` / `ollamaSetSettings`
 * store endpoints, the one-time-key `ollamaModels` listing, and the
 * mount-to-picker path that proves the stored catalog is the only catalog.
 * Drives the real plugin wiring with a fake host connection, fake llm, and
 * fake credentials; DSH_HOME is redirected to a temp dir so the store file
 * never leaks. Global fetch is replaced with an offline stub for the whole
 * file, because every `listModels` pass tries discovery first.
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { WebFetchProvider, WebSearchProvider } from '@deepseek-ai/dsh-web'
import type { RpcResult } from '../src/compat.js'
import { createFakeConnection } from './fake-connection.js'
import type { FakeConnectionHandler } from './fake-connection.js'
import {
  DEFAULT_OLLAMA_API_KEY_REF,
  DEFAULT_OLLAMA_BASE_URL,
  OLLAMA_CLOUD_ROUTE,
} from '../src/providers/ollama.js'

const HOME = mkdtempSync(join(tmpdir(), 'ollama-settings-rpc-test-'))
// Suite-level hook: the mkdtemp is top-level, so there is no test context to hang t.after on.
after(() => { rmSync(HOME, { recursive: true, force: true }) })

/**
 * Credential values keyed by reference name, so a test can prove which
 * reference a consumer resolved: the default `OLLAMA_API_KEY` and a custom
 * name must not read each other's value.
 */
const CREDENTIALS: Record<string, string> = {
  OLLAMA_API_KEY: 'stored-key',
  CUSTOM_OLLAMA_KEY: 'custom-key',
}

/** The store path the plugin resolves under the redirected DSH home. */
function settingsPath(): string {
  return join(HOME, 'plugins', 'subscriptions', 'ollama-settings.json')
}

const plugin = await import('../src/index.js')

// Discovery would otherwise reach ollama.com; a failing fetch makes the
// adapter fall back to the stored catalog, which is what these tests assert.
const realFetch = globalThis.fetch
const offlineFetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
globalThis.fetch = offlineFetch
after(() => { globalThis.fetch = realFetch })

interface FakeLlm {
  registered: string[]
  replaced: string[]
  adapters: Map<string, LlmAdapter>
}

/** Providers the plugin registered on the fake web seam. */
interface FakeWeb {
  search: WebSearchProvider[]
  fetch: WebFetchProvider[]
}

/** One settings view, as the card receives it. */
interface SettingsView {
  provider: string
  settings: { models?: { id: string }[]; web?: boolean; baseURL?: string; apiKeyRef?: string }
  effective: { baseURL: string; apiKeyRef: string; web: boolean }
  models: { id: string; name: string; vision: boolean; thinking: boolean; contextWindow?: number }[]
  configOverridesModels: boolean
}

/** One listing candidate, as the adoption checklist receives it. */
interface Candidate {
  id: string
  rawId: string
  name: string
  vision: boolean
  thinking: boolean
  contextWindow?: number
  efforts: string[]
  defaultEffort?: string
}

/**
 * Mount the plugin with a fake llm, credentials, web seam, and connection.
 * @param options - `ollamaModels` pins a non-empty config catalog, which
 *   must win over the store.
 */
async function mount(
  options: { ollamaModels?: { id: string; name?: string }[] } = {},
): Promise<{ handler: FakeConnectionHandler; fake: FakeLlm; web: FakeWeb }> {
  process.env.DSH_HOME = HOME
  rmSync(settingsPath(), { force: true })
  const fake: FakeLlm = { registered: [], replaced: [], adapters: new Map() }
  const web: FakeWeb = { search: [], fetch: [] }
  const ctx = new Context()
  const fakeLlm = {
    listProviders: async (): Promise<{ id: string; name: string }[]> =>
      [{ id: OLLAMA_CLOUD_ROUTE, name: 'Ollama Cloud' }],
    listModels: async (): Promise<{ id: string; name: string }[]> => [],
    resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: model }),
    registerAdapter: (providers: string[], adapter: LlmAdapter) => {
      fake.registered.push(...providers)
      for (const provider of providers) fake.adapters.set(provider, adapter)
      return Object.assign(() => {}, { replace: (next: string[]) => { fake.replaced.push(...next) } })
    },
  }
  ctx.provide('llm', fakeLlm)
  // The name decides the value, so a consumer that resolves the wrong
  // reference reads a different secret and the assertion catches it.
  ctx.provide('credentials', {
    resolve: async (ref: CredentialRef) => {
      const value = CREDENTIALS[String(ref)]
      return value === undefined ? undefined : { value, source: 'env' }
    },
    set: async () => undefined,
    unset: async () => undefined,
  } satisfies Pick<CredentialProvider, 'resolve' | 'set' | 'unset'> as unknown as CredentialProvider)
  ctx.provide('web', {
    registerSearchProvider: (provider: WebSearchProvider) => { web.search.push(provider); return () => {} },
    registerFetchProvider: (provider: WebFetchProvider) => { web.fetch.push(provider); return () => {} },
  })
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  ctx.plugin(plugin, {
    providers: [],
    ...options.ollamaModels === undefined ? {} : { ollama: { models: options.ollamaModels } },
  })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(connection.registered(), 'the subscriptions-auth routes were registered')
  return { handler: connection.handler, fake, web }
}

/** Let a deferred cordis inject callback run before the next assertion. */
async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

async function call(
  handler: FakeConnectionHandler,
  endpoint: string,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  return handler(endpoint, payload, new AbortController().signal)
}

async function view(handler: FakeConnectionHandler): Promise<SettingsView> {
  const result = await call(handler, 'ollamaSettings', {})
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  return result.value as SettingsView
}

test('listModels follows the stored catalog through three stages', async () => {
  const { handler, fake } = await mount()
  const adapter = fake.adapters.get(OLLAMA_CLOUD_ROUTE)
  assert.ok(adapter !== undefined, 'the ollama route registered an adapter')

  // Stage 1: nothing configured. The route ships no built-in models, so the
  // picker stays hidden even though the credential resolves.
  assert.deepEqual(await adapter.listModels(OLLAMA_CLOUD_ROUTE), [])
  assert.deepEqual((await view(handler)).models, [])

  // Stage 2: adopting two models makes them the catalog, in stored order,
  // and re-announces the route so the picker re-queries.
  const saved = await call(handler, 'ollamaSetSettings', {
    settings: {
      models: [
        {
          id: 'glm-5.3:cloud',
          name: 'GLM-5.3',
          contextWindow: 1_000_000,
          thinking: true,
          efforts: ['low', 'high', 'max'],
          defaultEffort: 'max',
        },
        { id: 'kimi-k3:cloud', name: 'Kimi K3', vision: true },
      ],
    },
  })
  assert.deepEqual(saved, { ok: true, value: { ok: true } })
  assert.deepEqual(fake.replaced, [OLLAMA_CLOUD_ROUTE])
  const listed = await adapter.listModels(OLLAMA_CLOUD_ROUTE)
  assert.deepEqual(listed.map(model => model.id), ['glm-5.3:cloud', 'kimi-k3:cloud'])
  assert.deepEqual(listed[0]?.inputModalities, ['text'])
  assert.deepEqual(listed[1]?.inputModalities, ['text', 'image'])
  const resolved = await adapter.resolveModel(OLLAMA_CLOUD_ROUTE, 'glm-5.3:cloud')
  assert.equal(resolved.context?.contextWindow, 1_000_000)
  assert.equal(resolved.reasoning?.defaultEffort, 'max')

  // Stage 3: clearing the list hides the picker and rejects chat again.
  await call(handler, 'ollamaSetSettings', { settings: { models: [] } })
  assert.deepEqual(await adapter.listModels(OLLAMA_CLOUD_ROUTE), [])
  await assert.rejects(adapter.resolveModel(OLLAMA_CLOUD_ROUTE, 'glm-5.3:cloud'), /no configured model/)
})

test('ollamaSettings reports stored overrides and effective defaults', async () => {
  const { handler } = await mount()
  const initial = await view(handler)
  assert.equal(initial.provider, 'ollama-cloud')
  assert.deepEqual(initial.settings, {})
  assert.deepEqual(initial.effective, {
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    apiKeyRef: DEFAULT_OLLAMA_API_KEY_REF,
    web: false,
  })
  assert.deepEqual(initial.models, [])
  assert.equal(initial.configOverridesModels, false)

  await call(handler, 'ollamaSetSettings', {
    settings: {
      baseURL: 'http://localhost:11434',
      apiKeyRef: 'LOCAL_OLLAMA_KEY',
      web: true,
      models: [{
        id: 'glm-5.3:cloud',
        name: 'GLM-5.3',
        contextWindow: 262_144,
        thinking: true,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      }],
    },
  })
  const next = await view(handler)
  assert.deepEqual(next.effective, {
    baseURL: 'http://localhost:11434',
    apiKeyRef: 'LOCAL_OLLAMA_KEY',
    web: true,
  })
  assert.deepEqual(next.models, [{
    id: 'glm-5.3:cloud',
    name: 'GLM-5.3',
    vision: false,
    thinking: true,
    contextWindow: 262_144,
  }])
})

test('ollamaSetSettings rejects unusable payloads without touching the store', async () => {
  const { handler } = await mount()
  const badModel = await call(handler, 'ollamaSetSettings', { settings: { models: [{ id: '' }] } })
  assert.equal(badModel.ok, false)
  if (!badModel.ok) assert.equal(badModel.error.code, 'bad-request')
  const notObject = await call(handler, 'ollamaSetSettings', { settings: null })
  assert.equal(notObject.ok, false)
  const missing = await call(handler, 'ollamaSetSettings', {})
  assert.equal(missing.ok, false)
  const badURL = await call(handler, 'ollamaSetSettings', { settings: { baseURL: 'ftp://ollama.com' } })
  assert.equal(badURL.ok, false)
  // None of the rejected writes reached the store.
  assert.equal(existsSync(settingsPath()), false)
  assert.deepEqual((await view(handler)).settings, {})
})

test('a non-empty config catalog overrides the store and says so', async () => {
  const { handler, fake } = await mount({ ollamaModels: [{ id: 'pinned:cloud', name: 'Pinned' }] })
  await call(handler, 'ollamaSetSettings', { settings: { models: [{ id: 'stored:cloud' }] } })
  const settings = await view(handler)
  assert.equal(settings.configOverridesModels, true)
  assert.deepEqual(settings.models.map(model => model.id), ['pinned:cloud'])
  const adapter = fake.adapters.get(OLLAMA_CLOUD_ROUTE)
  assert.deepEqual((await adapter!.listModels(OLLAMA_CLOUD_ROUTE)).map(model => model.id), ['pinned:cloud'])
})

test('ollamaModels lists candidates with a one-time key and stores nothing', async () => {
  const { handler } = await mount()
  const seen: { url: string; authorization: string | undefined; body: string }[] = []
  const listingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = String(init?.body ?? '')
    seen.push({ url, authorization: headers['authorization'], body })
    if (url.endsWith('/tags')) {
      // The live endpoint lists bare names and may repeat a tagged one.
      return Response.json({ models: [{ model: 'glm-5.3' }, { model: 'glm-5.3:cloud' }] })
    }
    if (url.endsWith('/show')) {
      const id = (JSON.parse(body) as { model: string }).model
      return id === 'glm-5.3'
        ? Response.json({ capabilities: ['tools', 'thinking', 'cloud'], parameters: 'num_ctx 262144' })
        : new Response('missing', { status: 404 })
    }
    return Promise.reject(new Error(`unexpected fetch to ${url}`))
  }) as unknown as typeof fetch
  globalThis.fetch = listingFetch
  try {
    const result = await call(handler, 'ollamaModels', { apiKey: 'one-time-key' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    const candidates = (result.value as { models: Candidate[] }).models
    // The duplicate normalizes to one wire id; the raw listing id is kept for
    // display, and `/api/show` still asked about the id the endpoint published.
    assert.deepEqual(candidates.map(candidate => candidate.id), ['glm-5.3:cloud'])
    assert.equal(candidates[0]?.rawId, 'glm-5.3')
    assert.equal(candidates[0]?.name, 'glm-5.3')
    assert.equal(candidates[0]?.thinking, true)
    assert.equal(candidates[0]?.contextWindow, 262_144)
    assert.deepEqual(candidates[0]?.efforts, ['low', 'high', 'max'])
    assert.equal(candidates[0]?.defaultEffort, 'max')
    assert.ok(seen.every(entry => entry.authorization === 'Bearer one-time-key'))
    assert.deepEqual(seen.filter(entry => entry.url.endsWith('/show')).map(entry => JSON.parse(entry.body)), [{ model: 'glm-5.3' }])
    // The typed key was never persisted and the listing never wrote a store.
    assert.equal(existsSync(settingsPath()), false)
    assert.deepEqual((await view(handler)).settings, {})
  } finally {
    globalThis.fetch = offlineFetch
  }
})

test('ollamaModels falls back to the stored credential and surfaces a rejection', async () => {
  const { handler } = await mount()
  const seen: (string | undefined)[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(((init?.headers ?? {}) as Record<string, string>)['authorization'])
    return new Response('denied', { status: 401 })
  }) as unknown as typeof fetch
  try {
    const denied = await call(handler, 'ollamaModels', {})
    assert.equal(denied.ok, false)
    assert.deepEqual(seen, ['Bearer stored-key'])
    // The pull payload itself is validated like every other endpoint.
    const emptyKey = await call(handler, 'ollamaModels', { apiKey: '' })
    assert.equal(emptyKey.ok, false)
    if (!emptyKey.ok) assert.equal(emptyKey.error.code, 'bad-request')
    // The draft address passes the store's URL check, not just a type check.
    const badURL = await call(handler, 'ollamaModels', { baseURL: 'ftp://ollama.com' })
    assert.equal(badURL.ok, false)
    if (!badURL.ok) assert.equal(badURL.error.code, 'bad-request')
  } finally {
    globalThis.fetch = offlineFetch
  }
})

test('saving the reference and base URL moves usage to the same target', async () => {
  const { handler } = await mount()
  const seen: { url: string; authorization: string | undefined }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      authorization: ((init?.headers ?? {}) as Record<string, string>)['authorization'],
    })
    return Response.json({ included: { allowance_usd: 10, balance_usd: 7.5 } })
  }) as unknown as typeof fetch
  try {
    const initial = await call(handler, 'externalUsage', { source: 'ollama-cloud' })
    assert.equal(initial.ok, true)
    assert.deepEqual(seen.at(-1), {
      url: `${DEFAULT_OLLAMA_BASE_URL}/balance`,
      authorization: 'Bearer stored-key',
    })
    await call(handler, 'ollamaSetSettings', {
      settings: { apiKeyRef: 'CUSTOM_OLLAMA_KEY', baseURL: 'http://localhost:11434' },
    })
    const moved = await call(handler, 'externalUsage', { source: 'ollama-cloud' })
    assert.equal(moved.ok, true)
    // The saved reference and address reach the usage reader too, and the
    // custom name resolves to its own value, not the default reference's.
    assert.deepEqual(seen.at(-1), {
      url: 'http://localhost:11434/balance',
      authorization: 'Bearer custom-key',
    })
  } finally {
    globalThis.fetch = offlineFetch
  }
})

test('the web switch registers the providers once and gates them live', async () => {
  const { handler, web } = await mount()
  // Off by default: nothing joins the web seam.
  assert.deepEqual([web.search.length, web.fetch.length], [0, 0])
  await call(handler, 'ollamaSetSettings', { settings: { web: true } })
  await tick()
  assert.deepEqual([web.search.length, web.fetch.length], [1, 1])
  assert.equal(web.search[0]?.available(), true)
  assert.equal(web.fetch[0]?.available(), true)
  // Turning it off gates the existing registration instead of removing it.
  await call(handler, 'ollamaSetSettings', { settings: { web: false } })
  await tick()
  assert.deepEqual([web.search.length, web.fetch.length], [1, 1])
  assert.equal(web.search[0]?.available(), false)
  assert.equal(web.fetch[0]?.available(), false)
  // Back on: still one registration, available again.
  await call(handler, 'ollamaSetSettings', { settings: { web: true } })
  await tick()
  assert.deepEqual([web.search.length, web.fetch.length], [1, 1])
  assert.equal(web.search[0]?.available(), true)
})
