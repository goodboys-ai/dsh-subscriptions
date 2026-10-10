/**
 * Ollama Cloud adapter tests: static catalog, chat request shape, vision
 * gating, and credential/catalog failures. All fetches are injected; the
 * fake proves the wire contract, not the live endpoint.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  DEFAULT_OLLAMA_BASE_URL,
  fetchOllamaModels,
  OLLAMA_CLOUD_ROUTE,
  OllamaAdapter,
  ollamaChatBaseURL,
} from '../src/providers/ollama.js'
import type { FetchFn } from '../src/providers/common.js'
import { OllamaWebFetchProvider, OllamaWebSearchProvider } from '../src/providers/ollama-web.js'

function sseBody(frames: unknown[]): string {
  return frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
}

const COMPLETED_SSE = sseBody([
  { choices: [{ delta: { content: 'hi' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
])

/** Route canned responses by URL; record request bodies. */
function fakeFetch(routes: Record<string, { payload: string; status?: number } | Error>): {
  fetchFn: FetchFn
  bodies: (url: string) => Record<string, unknown>[]
} {
  const seen = new Map<string, Record<string, unknown>[]>()
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const route = routes[url]
    if (route === undefined) return Promise.reject(new Error(`unexpected fetch to ${url}`))
    if (route instanceof Error) return Promise.reject(route)
    const list = seen.get(url) ?? []
    list.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    seen.set(url, list)
    return Promise.resolve(new Response(route.payload, { status: route.status ?? 200 }))
  }) as FetchFn
  return { fetchFn, bodies: url => seen.get(url) ?? [] }
}

const CHAT_URL = `${ollamaChatBaseURL(DEFAULT_OLLAMA_BASE_URL)}/chat/completions`

function options(overrides?: Partial<GenerateOptions>): GenerateOptions {
  return {
    provider: OLLAMA_CLOUD_ROUTE,
    model: 'glm-5.3-flash:cloud',
    messages: [{
      id: MessageId('m-1'),
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }],
    ...overrides,
  }
}

function imageMessage(): GenerateOptions['messages'] {
  return [{
    id: MessageId('m-img'),
    role: 'user',
    // dataBase64 present means pre-resolved: no attachment store needed.
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', mediaType: 'image/png', dataBase64: 'aGk=' },
    ],
    source: { kind: 'user' },
  }] as GenerateOptions['messages']
}

test('ollamaChatBaseURL maps the native base to its /v1 sibling', () => {
  assert.equal(ollamaChatBaseURL('https://ollama.com/api'), 'https://ollama.com/v1')
  assert.equal(ollamaChatBaseURL('https://ollama.com/api/'), 'https://ollama.com/v1')
  assert.equal(ollamaChatBaseURL('https://ollama.com/v1'), 'https://ollama.com/v1')
  assert.equal(ollamaChatBaseURL('http://localhost:11434'), 'http://localhost:11434/v1')
})

test('listModels advertises the three catalogued models when a key exists', async () => {
  // discovery:false keeps this unit on the static catalog without network.
  const adapter = new OllamaAdapter({ apiKey: async () => 'k', discovery: false })
  const models = await adapter.listModels(OLLAMA_CLOUD_ROUTE)
  assert.deepEqual(models.map(model => model.id), [
    'deepseek-v4.1-flash:cloud',
    'glm-5.3:cloud',
    'glm-5.3-flash:cloud',
  ])
  // No key means logged out: the route hides instead of advertising
  // models every request would fail for.
  const loggedOut = new OllamaAdapter({ apiKey: async () => undefined })
  assert.deepEqual(await loggedOut.listModels(OLLAMA_CLOUD_ROUTE), [])
})

test('resolveModel carries context and the family default effort', async () => {
  // Discovery has no fake here, so it must never reach the network: a
  // rejecting fetch proves resolveModel falls back to the static row.
  const adapter = new OllamaAdapter({
    apiKey: async () => 'k',
    fetchFn: (() => Promise.reject(new Error('offline'))) as FetchFn,
  })
  const glm = await adapter.resolveModel(OLLAMA_CLOUD_ROUTE, 'glm-5.3:cloud')
  assert.equal(glm.context?.contextWindow, 1_000_000)
  assert.deepEqual(glm.reasoning?.efforts.map(entry => entry.id), ['low', 'high', 'max'])
  assert.equal(glm.reasoning?.defaultEffort, 'max')
  const flash = await adapter.resolveModel(OLLAMA_CLOUD_ROUTE, 'deepseek-v4.1-flash:cloud')
  assert.equal(flash.reasoning?.defaultEffort, 'high')
  assert.deepEqual(flash.inputModalities, ['text', 'image'])
  await assert.rejects(
    adapter.resolveModel(OLLAMA_CLOUD_ROUTE, 'unknown-model'),
    (error: unknown) => error instanceof LlmError && error.code === 'UNKNOWN_MODEL',
  )
})

test('stream posts max_tokens and finishes on the chat wire', async () => {
  const seen: { headers: Record<string, string>; body: Record<string, unknown> }[] = []
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return new Response(COMPLETED_SSE)
  }) as FetchFn
  const adapter = new OllamaAdapter({ apiKey: async () => 'k', fetchFn })
  const chunks: { type: string }[] = []
  for await (const chunk of adapter.stream(options({
    tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
    reasoningEffort: ReasoningEffortId('high'),
  }))) chunks.push(chunk as { type: string })
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(seen.length, 1)
  const [call] = seen
  const body = call?.body ?? {}
  assert.equal(body['model'], 'glm-5.3-flash:cloud')
  // The adapter sets no request-level cap of its own; the catalog row's
  // default rides as max_tokens.
  assert.equal(body['max_tokens'], 32_768)
  assert.equal(body['reasoning_effort'], 'high')
  assert.deepEqual((body['tools'] as { function: { name: string } }[]).map(tool => tool.function.name), ['bash'])
  assert.equal((body['stream_options'] as Record<string, unknown>)['include_usage'], true)
  assert.equal(call?.headers['authorization'], 'Bearer k')
})

test("stream maps a selected 'off' effort to the wire spelling 'none'", async () => {
  const bodies: Record<string, unknown>[] = []
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return new Response(COMPLETED_SSE)
  }) as FetchFn
  const adapter = new OllamaAdapter({ apiKey: async () => 'k', fetchFn, discovery: false })
  for await (const chunk of adapter.stream(options({
    model: 'deepseek-v4.1-flash:cloud',
    reasoningEffort: ReasoningEffortId('off'),
  }))) void chunk
  assert.equal(bodies[0]?.['reasoning_effort'], 'none')
})

test('stream without a key fails before provider I/O', async () => {
  const adapter = new OllamaAdapter({
    apiKey: async () => undefined,
    fetchFn: (() => Promise.reject(new Error('must not fetch'))) as FetchFn,
  })
  await assert.rejects(
    (async () => { for await (const chunk of adapter.stream(options())) void chunk })(),
    (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
})

test('non-vision models never send image bytes', async () => {
  const { fetchFn, bodies } = fakeFetch({ [CHAT_URL]: { payload: COMPLETED_SSE } })
  const adapter = new OllamaAdapter({ apiKey: async () => 'k', fetchFn })
  for await (const chunk of adapter.stream(options({ model: 'glm-5.3:cloud', messages: imageMessage() }))) void chunk
  const sent = JSON.stringify(bodies(CHAT_URL)[0])
  assert.ok(!sent.includes('image_url'), `vision bytes leaked: ${sent}`)
  const { fetchFn: visionFetch, bodies: visionBodies } = fakeFetch({ [CHAT_URL]: { payload: COMPLETED_SSE } })
  // The store is never touched for pre-resolved bytes; its presence alone
  // satisfies the resolution precondition.
  const visionAdapter = new OllamaAdapter({
    apiKey: async () => 'k',
    fetchFn: visionFetch,
    resolveAttachments: () => ({}) as AttachmentStore,
  })
  for await (const chunk of visionAdapter.stream(options({ messages: imageMessage() }))) void chunk
  assert.ok(JSON.stringify(visionBodies(CHAT_URL)[0]).includes('image_url'))
})

const TAGS_URL = `${DEFAULT_OLLAMA_BASE_URL}/tags`
const SHOW_URL = `${DEFAULT_OLLAMA_BASE_URL}/show`

/** Discovery fake: canned tags plus per-model show payloads. */
function fakeDiscovery(tags: unknown, shows: Record<string, unknown>): FetchFn {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === TAGS_URL) return new Response(JSON.stringify(tags), { status: 200 })
    if (url === SHOW_URL) {
      const id = (JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model
      const payload = id === undefined ? undefined : shows[id]
      if (payload === undefined) return new Response('no such model', { status: 404 })
      return new Response(JSON.stringify(payload), { status: 200 })
    }
    return Promise.reject(new Error(`unexpected fetch to ${url}`))
  }) as FetchFn
}

test('fetchOllamaModels maps capabilities and num_ctx', async () => {
  const models = await fetchOllamaModels({
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    apiKey: 'k',
    fetchFn: fakeDiscovery(
      // The live endpoint lists bare names; the raw fetcher keeps them.
      { models: [{ model: 'glm-5.3' }, { name: 'deepseek-v4.1-flash' }] },
      {
        'glm-5.3': { capabilities: ['tools', 'thinking', 'cloud'], parameters: 'num_ctx 1048576' },
        'deepseek-v4.1-flash': {
          capabilities: ['vision', 'tools', 'thinking', 'cloud'],
          model_info: { 'llama.context_length': 1000000 },
        },
      },
    ),
  })
  assert.deepEqual(models.map(model => model.id), ['glm-5.3', 'deepseek-v4.1-flash'])
  assert.equal(models[0]?.contextWindow, 1048576)
  assert.deepEqual(models[0]?.inputModalities, ['text'])
  assert.deepEqual(models[1]?.inputModalities, ['text', 'image'])
  assert.equal(models[1]?.reasoning?.defaultEffort, 'high')
})

test('a failed show degrades to an id-only row; a failed listing fails', async () => {
  const models = await fetchOllamaModels({
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    apiKey: 'k',
    fetchFn: fakeDiscovery({ models: [{ model: 'new-model:cloud' }] }, {}),
  })
  assert.deepEqual(models.map(model => model.id), ['new-model:cloud'])
  await assert.rejects(
    fetchOllamaModels({
      baseURL: DEFAULT_OLLAMA_BASE_URL,
      apiKey: 'k',
      fetchFn: fakeDiscovery({ models: [] }, {}),
    }),
    /empty catalog/,
  )
})

test('listModels falls back to the static catalog when discovery fails', async () => {
  const failing: FetchFn = (() => Promise.reject(new Error('down'))) as FetchFn
  const adapter = new OllamaAdapter({ apiKey: async () => 'k', fetchFn: failing })
  const models = await adapter.listModels(OLLAMA_CLOUD_ROUTE)
  assert.deepEqual(models.map(model => model.id), [
    'deepseek-v4.1-flash:cloud',
    'glm-5.3:cloud',
    'glm-5.3-flash:cloud',
  ])
})

test('listModels advertises the static allowlist even when discovery lists bare names', async () => {
  // Regression test for picker entries no request could serve: the live
  // endpoint lists bare names the chat wire rejects, so discovery may
  // enrich the static rows but never extend the picker.
  const adapter = new OllamaAdapter({
    apiKey: async () => 'k',
    fetchFn: fakeDiscovery(
      { models: [{ model: 'glm-5.3' }, { model: 'kimi-k3' }] },
      { 'glm-5.3': { capabilities: ['tools', 'thinking', 'cloud'], parameters: 'num_ctx 262144' } },
    ),
  })
  const models = await adapter.listModels(OLLAMA_CLOUD_ROUTE)
  assert.deepEqual(models.map(model => model.id), [
    'deepseek-v4.1-flash:cloud',
    'glm-5.3:cloud',
    'glm-5.3-flash:cloud',
  ])
})

test('listModels hides the route when the key is rejected', async () => {
  const denied: FetchFn = (async () => new Response('', { status: 401 })) as FetchFn
  const adapter = new OllamaAdapter({ apiKey: async () => 'bad', fetchFn: denied })
  assert.deepEqual(await adapter.listModels(OLLAMA_CLOUD_ROUTE), [])
})

test('a 403 falls back to the static catalog instead of hiding the route', async () => {
  const forbidden: FetchFn = (async () => new Response('', { status: 403 })) as FetchFn
  const adapter = new OllamaAdapter({ apiKey: async () => 'k', fetchFn: forbidden })
  const models = await adapter.listModels(OLLAMA_CLOUD_ROUTE)
  assert.deepEqual(models.map(model => model.id), [
    'deepseek-v4.1-flash:cloud',
    'glm-5.3:cloud',
    'glm-5.3-flash:cloud',
  ])
})

test('discovery enriches capabilities but keeps the static display name', async () => {
  const adapter = new OllamaAdapter({
    apiKey: async () => 'k',
    fetchFn: fakeDiscovery(
      { models: [{ model: 'glm-5.3' }] },
      { 'glm-5.3': { capabilities: ['tools', 'thinking', 'cloud'], parameters: 'num_ctx 262144' } },
    ),
  })
  const models = await adapter.listModels(OLLAMA_CLOUD_ROUTE)
  const glm = models.find(model => model.id === 'glm-5.3:cloud')
  assert.equal(glm?.name, 'GLM-5.3 (cloud)')
  const resolved = await adapter.resolveModel(OLLAMA_CLOUD_ROUTE, 'glm-5.3:cloud')
  assert.equal(resolved.name, 'GLM-5.3 (cloud)')
  assert.equal(resolved.context?.contextWindow, 262144)
})

test('web search posts the query and drops url-less rows', async () => {
  const seen: { url: string; body: Record<string, unknown> }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    if (String(input).endsWith('/web_search')) {
      // Official shape: {title, url, content}.
      return Response.json({ results: [
        { url: 'https://example.com/a', title: 'A', content: 's' },
        { title: 'no url' },
      ] })
    }
    // Official shape: {title, content, links}.
    return Response.json({ title: 'A', content: '# hi', links: ['https://example.com/a'] })
  }) as FetchFn
  const options = { apiKey: async () => 'k' as string | undefined, baseURL: DEFAULT_OLLAMA_BASE_URL, fetchFn }
  const search = new OllamaWebSearchProvider(options)
  assert.equal(search.available(), true)
  const result = await search.search({ query: 'q', maxResults: 50 })
  assert.deepEqual(result, {
    sources: [{ url: 'https://example.com/a', title: 'A', snippet: 's' }],
    truncated: false,
  })
  assert.equal(seen[0]?.body['max_results'], 10)
  const fetch = new OllamaWebFetchProvider(options)
  assert.deepEqual(await fetch.fetch({ url: 'https://example.com/a' }), {
    url: 'https://example.com/a',
    statusCode: 200,
    body: { kind: 'text', content: '# hi' },
    truncated: false,
  })
})

test('web providers fail loudly without a key and never follow redirects', async () => {
  const loggedOut = new OllamaWebSearchProvider({ apiKey: async () => undefined, baseURL: DEFAULT_OLLAMA_BASE_URL })
  await assert.rejects(() => loggedOut.search({ query: 'q' }), /OLLAMA_API_KEY/)
  const redirecting = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal((init as { redirect?: string }).redirect, 'error')
      // Realistic undici shape: the redirect rejection nests in `cause`.
      throw new TypeError('fetch failed', { cause: new Error('redirect mode is set to error') })
    }) as FetchFn,
  })
  await assert.rejects(() => redirecting.search({ query: 'q' }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'OLLAMA_WEB_REDIRECT')
})

test('web HTTP and decode failures never retry and keep their codes', async () => {
  let calls = 0
  const failing = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    fetchFn: (async () => {
      calls += 1
      return new Response('nope', { status: 500 })
    }) as FetchFn,
  })
  await assert.rejects(() => failing.search({ query: 'q' }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'OLLAMA_WEB_BAD_RESPONSE')
  assert.equal(calls, 1)
  const garbled = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    fetchFn: (async () => new Response('not json{{', { status: 200 })) as FetchFn,
  })
  await assert.rejects(() => garbled.search({ query: 'q' }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'OLLAMA_WEB_BAD_REPLY')
})

test('web timeouts and transport failures retry once, then carry codes', async () => {
  let calls = 0
  const hanging = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    fetchFn: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      calls += 1
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as FetchFn,
    requestTimeoutMs: 20,
  })
  await assert.rejects(() => hanging.search({ query: 'q' }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'OLLAMA_WEB_TIMEOUT')
  assert.equal(calls, 2)
  let transportCalls = 0
  const broken = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    fetchFn: (async () => {
      transportCalls += 1
      throw new TypeError('fetch failed')
    }) as FetchFn,
  })
  await assert.rejects(() => broken.search({ query: 'q' }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'OLLAMA_WEB_TRANSPORT')
  assert.equal(transportCalls, 2)
})

test('a body-read timeout reports TIMEOUT and retries like a connect timeout', async () => {
  let calls = 0
  const stalled = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    // Headers arrive, the body never does: the stream errors when the
    // attempt timer aborts it, like a real transport would.
    fetchFn: ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return Promise.resolve(new Response(stream, { status: 200 }))
    }) as FetchFn,
    requestTimeoutMs: 20,
  })
  await assert.rejects(() => stalled.search({ query: 'q' }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'OLLAMA_WEB_TIMEOUT')
  assert.equal(calls, 2)
})

test('a malformed reply carries no provider bytes in its chain', async () => {
  const garbled = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    fetchFn: (async () => new Response('REDACTED malformed provider response', { status: 200 })) as FetchFn,
  })
  const error = await garbled.search({ query: 'q' }).then(
    () => { throw new Error('must not succeed') },
    (failure: unknown) => failure,
  )
  assert.ok(error instanceof Error)
  assert.equal((error as { code?: string }).code, 'OLLAMA_WEB_BAD_REPLY')
  assert.ok(!String(error).includes('REDACTED'))
})

test('an oversized reply fails without buffering it whole', async () => {
  let calls = 0
  const huge = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    fetchFn: (async () => {
      calls += 1
      // Declared over the cap: rejected before the first body read.
      return new Response('{}', {
        status: 200,
        headers: { 'content-length': String(4 * 1024 * 1024) },
      })
    }) as FetchFn,
  })
  await assert.rejects(() => huge.search({ query: 'q' }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'OLLAMA_WEB_BAD_REPLY')
  assert.equal(calls, 1)
})
