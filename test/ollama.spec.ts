/**
 * Ollama Cloud adapter tests: the stored catalog, chat request shape, vision
 * gating, discovery normalization, and credential/catalog failures. All
 * fetches are injected; the fake proves the wire contract, not the live
 * endpoint.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  errorChain,
  LlmError,
  MessageId,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  DEFAULT_OLLAMA_BASE_URL,
  fetchOllamaModels,
  normalizeOllamaModelId,
  OLLAMA_CLOUD_ROUTE,
  OllamaAdapter,
  ollamaChatBaseURL,
} from '../src/providers/ollama.js'
import type { OllamaModelSetting } from '../src/providers/ollama-settings.js'
import type { FetchFn } from '../src/providers/common.js'
import {
  OllamaWebFetchProvider,
  OllamaWebSearchProvider,
} from '../src/providers/ollama-web.js'

function sseBody(frames: unknown[]): string {
  return (
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') +
    'data: [DONE]\n\n'
  )
}

const COMPLETED_SSE = sseBody([
  { choices: [{ delta: { content: 'hi' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
])

/** Route canned responses by URL; record request bodies. */
function fakeFetch(
  routes: Record<string, { payload: string; status?: number } | Error>,
): {
  fetchFn: FetchFn
  bodies: (url: string) => Record<string, unknown>[]
} {
  const seen = new Map<string, Record<string, unknown>[]>()
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const route = routes[url]
    if (route === undefined)
      return Promise.reject(new Error(`unexpected fetch to ${url}`))
    if (route instanceof Error) return Promise.reject(route)
    const list = seen.get(url) ?? []
    list.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    seen.set(url, list)
    return Promise.resolve(
      new Response(route.payload, { status: route.status ?? 200 }),
    )
  }) as FetchFn
  return { fetchFn, bodies: (url) => seen.get(url) ?? [] }
}

const CHAT_URL = `${ollamaChatBaseURL(DEFAULT_OLLAMA_BASE_URL)}/chat/completions`

/**
 * The catalog the Settings card would store: the three Cloud models the
 * route used to ship built in, with the capabilities `/api/show` reported.
 */
const CATALOG: readonly OllamaModelSetting[] = [
  {
    id: 'deepseek-v4.1-flash:cloud',
    name: 'DeepSeek V4.1 Flash (cloud)',
    contextWindow: 1_000_000,
    vision: true,
    thinking: true,
    efforts: ['off', 'low', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'glm-5.3:cloud',
    name: 'GLM-5.3 (cloud)',
    contextWindow: 1_000_000,
    thinking: true,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
  },
  {
    id: 'glm-5.3-flash:cloud',
    name: 'GLM-5.3-Flash (cloud)',
    contextWindow: 1_000_000,
    vision: true,
    thinking: true,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
  },
]

/**
 * Build an adapter over a live catalog snapshot, defaulting to {@link CATALOG}.
 * The route has no built-in models, so every test must state its catalog.
 */
function makeAdapter(
  options: {
    apiKey?: () => Promise<string | undefined>
    catalog?: readonly OllamaModelSetting[]
    fetchFn?: FetchFn
    discovery?: boolean
    resolveAttachments?: () => AttachmentStore | undefined
  } = {},
): OllamaAdapter {
  return new OllamaAdapter({
    apiKey: options.apiKey ?? (async () => 'k'),
    baseURL: () => DEFAULT_OLLAMA_BASE_URL,
    catalog: () => options.catalog ?? CATALOG,
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    ...(options.discovery === undefined
      ? {}
      : { discovery: options.discovery }),
    ...(options.resolveAttachments === undefined
      ? {}
      : { resolveAttachments: options.resolveAttachments }),
  })
}

function options(overrides?: Partial<GenerateOptions>): GenerateOptions {
  return {
    provider: OLLAMA_CLOUD_ROUTE,
    model: 'glm-5.3-flash:cloud',
    messages: [
      {
        id: MessageId('m-1'),
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
      },
    ],
    ...overrides,
  }
}

function imageMessage(): GenerateOptions['messages'] {
  return [
    {
      id: MessageId('m-img'),
      role: 'user',
      // dataBase64 present means pre-resolved: no attachment store needed.
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', mediaType: 'image/png', dataBase64: 'aGk=' },
      ],
      source: { kind: 'user' },
    },
  ] as GenerateOptions['messages']
}

test('ollamaChatBaseURL maps the native base to its /v1 sibling', () => {
  assert.equal(
    ollamaChatBaseURL('https://ollama.com/api'),
    'https://ollama.com/v1',
  )
  assert.equal(
    ollamaChatBaseURL('https://ollama.com/api/'),
    'https://ollama.com/v1',
  )
  assert.equal(
    ollamaChatBaseURL('https://ollama.com/v1'),
    'https://ollama.com/v1',
  )
  assert.equal(
    ollamaChatBaseURL('http://localhost:11434'),
    'http://localhost:11434/v1',
  )
})

test('listModels serves the stored catalog when a key exists', async () => {
  // discovery:false keeps this unit on the stored catalog without network.
  const adapter = makeAdapter({ discovery: false })
  const models = await adapter.listModels(OLLAMA_CLOUD_ROUTE)
  assert.deepEqual(
    models.map((model) => model.id),
    ['deepseek-v4.1-flash:cloud', 'glm-5.3:cloud', 'glm-5.3-flash:cloud'],
  )
  // No key means logged out: the route hides instead of advertising
  // models every request would fail for.
  const loggedOut = makeAdapter({ apiKey: async () => undefined })
  assert.deepEqual(await loggedOut.listModels(OLLAMA_CLOUD_ROUTE), [])
})

test('listModels returns nothing when no model is configured', async () => {
  // The route ships no built-in rows: an empty store must hide the picker
  // entry even though the key resolves, and chat must reject the model.
  const adapter = makeAdapter({ catalog: [], discovery: false })
  assert.deepEqual(await adapter.listModels(OLLAMA_CLOUD_ROUTE), [])
  await assert.rejects(
    adapter.resolveModel(OLLAMA_CLOUD_ROUTE, 'glm-5.3:cloud'),
    (error: unknown) =>
      error instanceof LlmError && error.code === 'UNKNOWN_MODEL',
  )
  await assert.rejects(
    (async () => {
      for await (const chunk of adapter.stream(options())) void chunk
    })(),
    (error: unknown) =>
      error instanceof LlmError && error.code === 'UNKNOWN_MODEL',
  )
})

test('resolveModel carries context and the stored default effort', async () => {
  // Discovery has no fake here, so it must never reach the network: a
  // rejecting fetch proves resolveModel falls back to the stored row.
  const adapter = makeAdapter({
    fetchFn: (() => Promise.reject(new Error('offline'))) as FetchFn,
  })
  const glm = await adapter.resolveModel(OLLAMA_CLOUD_ROUTE, 'glm-5.3:cloud')
  assert.equal(glm.context?.contextWindow, 1_000_000)
  assert.deepEqual(
    glm.reasoning?.efforts.map((entry) => entry.id),
    ['low', 'high', 'max'],
  )
  assert.equal(glm.reasoning?.defaultEffort, 'max')
  const flash = await adapter.resolveModel(
    OLLAMA_CLOUD_ROUTE,
    'deepseek-v4.1-flash:cloud',
  )
  assert.equal(flash.reasoning?.defaultEffort, 'high')
  assert.deepEqual(flash.inputModalities, ['text', 'image'])
  await assert.rejects(
    adapter.resolveModel(OLLAMA_CLOUD_ROUTE, 'unknown-model'),
    (error: unknown) =>
      error instanceof LlmError && error.code === 'UNKNOWN_MODEL',
  )
})

test('a stored row supplies its own efforts and context', async () => {
  const adapter = makeAdapter({
    catalog: [
      {
        id: 'kimi-k3:cloud',
        name: 'Kimi K3',
        contextWindow: 131_072,
        vision: true,
        thinking: true,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
    ],
    discovery: false,
  })
  const resolved = await adapter.resolveModel(
    OLLAMA_CLOUD_ROUTE,
    'kimi-k3:cloud',
  )
  assert.equal(resolved.name, 'Kimi K3')
  assert.equal(resolved.context?.contextWindow, 131_072)
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  assert.deepEqual(
    resolved.reasoning?.efforts.map((entry) => entry.id),
    ['low', 'medium', 'high'],
  )
  assert.equal(resolved.reasoning?.defaultEffort, 'medium')
})

test('stream posts max_tokens and finishes on the chat wire', async () => {
  const seen: {
    headers: Record<string, string>
    body: Record<string, unknown>
  }[] = []
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return new Response(COMPLETED_SSE)
  }) as FetchFn
  const adapter = makeAdapter({ fetchFn })
  const chunks: { type: string }[] = []
  for await (const chunk of adapter.stream(
    options({
      tools: [
        { name: 'bash', description: 'run', parameters: { type: 'object' } },
      ],
      reasoningEffort: ReasoningEffortId('high'),
    }),
  ))
    chunks.push(chunk as { type: string })
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(seen.length, 1)
  const [call] = seen
  const body = call?.body ?? {}
  assert.equal(body['model'], 'glm-5.3-flash:cloud')
  // The adapter sets no request-level cap of its own; the catalog row's
  // default rides as max_tokens.
  assert.equal(body['max_tokens'], 32_768)
  assert.equal(body['reasoning_effort'], 'high')
  assert.deepEqual(
    (body['tools'] as { function: { name: string } }[]).map(
      (tool) => tool.function.name,
    ),
    ['bash'],
  )
  assert.equal(
    (body['stream_options'] as Record<string, unknown>)['include_usage'],
    true,
  )
  assert.equal(call?.headers['authorization'], 'Bearer k')
})

test("stream maps a selected 'off' effort to the wire spelling 'none'", async () => {
  const bodies: Record<string, unknown>[] = []
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(
      JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    )
    return new Response(COMPLETED_SSE)
  }) as FetchFn
  const adapter = makeAdapter({ fetchFn, discovery: false })
  for await (const chunk of adapter.stream(
    options({
      model: 'deepseek-v4.1-flash:cloud',
      reasoningEffort: ReasoningEffortId('off'),
    }),
  ))
    void chunk
  assert.equal(bodies[0]?.['reasoning_effort'], 'none')
})

test('stream without a key fails before provider I/O', async () => {
  const adapter = makeAdapter({
    apiKey: async () => undefined,
    fetchFn: (() => Promise.reject(new Error('must not fetch'))) as FetchFn,
  })
  await assert.rejects(
    (async () => {
      for await (const chunk of adapter.stream(options())) void chunk
    })(),
    (error: unknown) =>
      error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
})

test('non-vision models never send image bytes', async () => {
  const { fetchFn, bodies } = fakeFetch({
    [CHAT_URL]: { payload: COMPLETED_SSE },
  })
  const adapter = makeAdapter({ fetchFn })
  for await (const chunk of adapter.stream(
    options({ model: 'glm-5.3:cloud', messages: imageMessage() }),
  ))
    void chunk
  const sent = JSON.stringify(bodies(CHAT_URL)[0])
  assert.ok(!sent.includes('image_url'), `vision bytes leaked: ${sent}`)
  const { fetchFn: visionFetch, bodies: visionBodies } = fakeFetch({
    [CHAT_URL]: { payload: COMPLETED_SSE },
  })
  // The store is never touched for pre-resolved bytes; its presence alone
  // satisfies the resolution precondition.
  const visionAdapter = makeAdapter({
    fetchFn: visionFetch,
    resolveAttachments: () => ({}) as AttachmentStore,
  })
  for await (const chunk of visionAdapter.stream(
    options({ messages: imageMessage() }),
  ))
    void chunk
  assert.ok(JSON.stringify(visionBodies(CHAT_URL)[0]).includes('image_url'))
})

const TAGS_URL = `${DEFAULT_OLLAMA_BASE_URL}/tags`
const SHOW_URL = `${DEFAULT_OLLAMA_BASE_URL}/show`

/** Discovery fake: canned tags plus per-model show payloads. */
function fakeDiscovery(tags: unknown, shows: Record<string, unknown>): FetchFn {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === TAGS_URL)
      return new Response(JSON.stringify(tags), { status: 200 })
    if (url === SHOW_URL) {
      const id = (JSON.parse(String(init?.body ?? '{}')) as { model?: string })
        .model
      const payload = id === undefined ? undefined : shows[id]
      if (payload === undefined)
        return new Response('no such model', { status: 404 })
      return new Response(JSON.stringify(payload), { status: 200 })
    }
    return Promise.reject(new Error(`unexpected fetch to ${url}`))
  }) as FetchFn
}

test('fetchOllamaModels normalizes listing ids and maps capabilities', async () => {
  const requested: string[] = []
  const inner = fakeDiscovery(
    // The live endpoint lists bare names; the fetcher normalizes them to the
    // wire ids the chat endpoint takes.
    { models: [{ model: 'glm-5.3' }, { name: 'deepseek-v4.1-flash' }] },
    {
      // The endpoint publishes its own level list and default; they win over
      // the family fallback.
      'glm-5.3': {
        capabilities: ['tools', 'thinking', 'cloud'],
        thinking: { values: ['low', 'medium', 'high'], default: 'medium' },
        parameters: 'num_ctx 1048576',
      },
      // A thinking model whose level list is missing falls back to the
      // recorded family levels.
      'deepseek-v4.1-flash': {
        capabilities: ['vision', 'tools', 'thinking', 'cloud'],
        model_info: { 'llama.context_length': 1000000 },
      },
    },
  )
  // Record the raw id each `/api/show` asked about: normalization happens
  // after enrichment, so the endpoint still sees the id it published.
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === SHOW_URL)
      requested.push(
        (JSON.parse(String(init?.body ?? '{}')) as { model: string }).model,
      )
    return inner(input, init)
  }) as FetchFn
  const models = await fetchOllamaModels({
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    apiKey: 'k',
    fetchFn,
  })
  assert.deepEqual(
    models.map((model) => model.id),
    ['glm-5.3:cloud', 'deepseek-v4.1-flash:cloud'],
  )
  assert.deepEqual(
    models.map((model) => model.rawId),
    ['glm-5.3', 'deepseek-v4.1-flash'],
  )
  assert.deepEqual(requested.sort(), ['deepseek-v4.1-flash', 'glm-5.3'])
  assert.equal(models[0]?.contextWindow, 1048576)
  assert.equal(models[0]?.thinking, true)
  assert.deepEqual(models[0]?.inputModalities, ['text'])
  assert.deepEqual(
    models[0]?.reasoning?.efforts.map((effort) => effort.id),
    ['low', 'medium', 'high'],
  )
  assert.equal(models[0]?.reasoning?.defaultEffort, 'medium')
  assert.deepEqual(models[1]?.inputModalities, ['text', 'image'])
  assert.deepEqual(
    models[1]?.reasoning?.efforts.map((effort) => effort.id),
    ['off', 'low', 'high', 'max'],
  )
  assert.equal(models[1]?.reasoning?.defaultEffort, 'high')
})

test('a false thinking value maps to the off level', async () => {
  const models = await fetchOllamaModels({
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    apiKey: 'k',
    fetchFn: fakeDiscovery(
      { models: [{ model: 'glm-5.3' }] },
      {
        'glm-5.3': {
          capabilities: ['thinking'],
          thinking: { values: [false, 'low', 'high', 'max'], default: 'high' },
        },
      },
    ),
  })
  assert.deepEqual(
    models[0]?.reasoning?.efforts.map((effort) => effort.id),
    ['off', 'low', 'high', 'max'],
  )
  assert.equal(models[0]?.reasoning?.defaultEffort, 'high')
})

test('normalizeOllamaModelId tags only the official Cloud host', () => {
  assert.equal(
    normalizeOllamaModelId('glm-5.3', DEFAULT_OLLAMA_BASE_URL),
    'glm-5.3:cloud',
  )
  assert.equal(
    normalizeOllamaModelId('glm-5.3:cloud', DEFAULT_OLLAMA_BASE_URL),
    'glm-5.3:cloud',
  )
  // A local daemon takes the bare name; only the Cloud wire needs the tag.
  assert.equal(
    normalizeOllamaModelId('glm-5.3', 'http://localhost:11434'),
    'glm-5.3',
  )
  assert.equal(
    normalizeOllamaModelId('qwen3:8b', 'http://localhost:11434'),
    'qwen3:8b',
  )
})

test('a failed show degrades to an id-only row; a failed listing fails', async () => {
  const models = await fetchOllamaModels({
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    apiKey: 'k',
    fetchFn: fakeDiscovery({ models: [{ model: 'new-model:cloud' }] }, {}),
  })
  assert.deepEqual(
    models.map((model) => model.id),
    ['new-model:cloud'],
  )
  assert.equal(models[0]?.thinking, false)
  await assert.rejects(
    fetchOllamaModels({
      baseURL: DEFAULT_OLLAMA_BASE_URL,
      apiKey: 'k',
      fetchFn: fakeDiscovery({ models: [] }, {}),
    }),
    /empty catalog/,
  )
})

test('listModels falls back to the stored catalog when discovery fails', async () => {
  const failing: FetchFn = (() => Promise.reject(new Error('down'))) as FetchFn
  const adapter = makeAdapter({ fetchFn: failing })
  const models = await adapter.listModels(OLLAMA_CLOUD_ROUTE)
  assert.deepEqual(
    models.map((model) => model.id),
    ['deepseek-v4.1-flash:cloud', 'glm-5.3:cloud', 'glm-5.3-flash:cloud'],
  )
})

test('listModels advertises the stored allowlist even when discovery lists more', async () => {
  // Regression test for picker entries no request could serve: discovery may
  // enrich the stored rows but never extend the picker, so a model the user
  // never adopted stays out.
  const adapter = makeAdapter({
    fetchFn: fakeDiscovery(
      { models: [{ model: 'glm-5.3' }, { model: 'kimi-k3' }] },
      {
        'glm-5.3': {
          capabilities: ['tools', 'thinking', 'cloud'],
          parameters: 'num_ctx 262144',
        },
      },
    ),
  })
  const models = await adapter.listModels(OLLAMA_CLOUD_ROUTE)
  assert.deepEqual(
    models.map((model) => model.id),
    ['deepseek-v4.1-flash:cloud', 'glm-5.3:cloud', 'glm-5.3-flash:cloud'],
  )
})

test('listModels hides the route when the key is rejected', async () => {
  const denied: FetchFn = (async () =>
    new Response('', { status: 401 })) as FetchFn
  const adapter = makeAdapter({ apiKey: async () => 'bad', fetchFn: denied })
  assert.deepEqual(await adapter.listModels(OLLAMA_CLOUD_ROUTE), [])
})

test('a 403 falls back to the stored catalog instead of hiding the route', async () => {
  const forbidden: FetchFn = (async () =>
    new Response('', { status: 403 })) as FetchFn
  const adapter = makeAdapter({ fetchFn: forbidden })
  const models = await adapter.listModels(OLLAMA_CLOUD_ROUTE)
  assert.deepEqual(
    models.map((model) => model.id),
    ['deepseek-v4.1-flash:cloud', 'glm-5.3:cloud', 'glm-5.3-flash:cloud'],
  )
})

test('discovery enriches capabilities but keeps the stored display name', async () => {
  const adapter = makeAdapter({
    fetchFn: fakeDiscovery(
      { models: [{ model: 'glm-5.3' }] },
      {
        'glm-5.3': {
          capabilities: ['tools', 'thinking', 'cloud'],
          parameters: 'num_ctx 262144',
        },
      },
    ),
  })
  const models = await adapter.listModels(OLLAMA_CLOUD_ROUTE)
  const glm = models.find((model) => model.id === 'glm-5.3:cloud')
  assert.equal(glm?.name, 'GLM-5.3 (cloud)')
  const resolved = await adapter.resolveModel(
    OLLAMA_CLOUD_ROUTE,
    'glm-5.3:cloud',
  )
  assert.equal(resolved.name, 'GLM-5.3 (cloud)')
  assert.equal(resolved.context?.contextWindow, 262144)
})

test('a discovery hit takes the endpoint levels over the stored row', async () => {
  const adapter = makeAdapter({
    catalog: [
      {
        id: 'glm-5.3:cloud',
        name: 'GLM-5.3',
        contextWindow: 262_144,
        thinking: true,
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'max',
      },
    ],
    fetchFn: fakeDiscovery(
      { models: [{ model: 'glm-5.3' }] },
      {
        'glm-5.3': {
          capabilities: ['tools', 'thinking', 'cloud'],
          thinking: { values: ['low', 'high'], default: 'high' },
        },
      },
    ),
  })
  const resolved = await adapter.resolveModel(
    OLLAMA_CLOUD_ROUTE,
    'glm-5.3:cloud',
  )
  // A published vendor set is closed: the stored `max` and the family
  // table must not widen it, or a gateway-retracted level would ride
  // the wire and 400.
  assert.deepEqual(
    resolved.reasoning?.efforts.map((effort) => effort.id),
    ['low', 'high'],
  )
  // The endpoint's default wins over the stored `max`.
  assert.equal(resolved.reasoning?.defaultEffort, 'high')
})

test('a stored user default outranks the vendor default within the offered set', async () => {
  const catalog: OllamaModelSetting[] = [
    {
      id: 'kimi-k3:cloud',
      thinking: true,
      efforts: ['low', 'high'],
      defaultEffort: 'low',
    },
  ]
  const vendorDefault = makeAdapter({
    catalog,
    fetchFn: fakeDiscovery(
      { models: [{ model: 'kimi-k3:cloud' }] },
      {
        'kimi-k3:cloud': {
          capabilities: ['thinking'],
          thinking: { values: ['low', 'high'], default: 'high' },
        },
      },
    ),
  })
  // The user's stored default wins over the vendor's; the selector's
  // priority is user, then vendor, then the family table.
  assert.equal(
    (await vendorDefault.resolveModel(OLLAMA_CLOUD_ROUTE, 'kimi-k3:cloud'))
      .reasoning?.defaultEffort,
    'low',
  )
  // With no user default stored (`defaultEffortOf` absent, and the
  // adoption flow no longer copies the vendor value into the row), the
  // vendor's default serves when it names one, else the resolved model
  // carries none for this familyless model rather than inventing one.
  const noStoredDefault = makeAdapter({
    catalog: catalog.map(({ defaultEffort: _ignored, ...row }) => row),
    fetchFn: fakeDiscovery(
      { models: [{ model: 'kimi-k3:cloud' }] },
      // The vendor publishes no default, so none is resolved.
      {
        'kimi-k3:cloud': {
          capabilities: ['thinking'],
          thinking: { values: ['low', 'high'] },
        },
      },
    ),
  })
  assert.equal(
    (await noStoredDefault.resolveModel(OLLAMA_CLOUD_ROUTE, 'kimi-k3:cloud'))
      .reasoning?.defaultEffort,
    undefined,
  )
})

test('the family table fills levels neither the endpoint nor the row reports', async () => {
  const adapter = makeAdapter({
    catalog: [
      { id: 'glm-5.3-flash:cloud', name: 'GLM-5.3-Flash', thinking: true },
    ],
    fetchFn: fakeDiscovery(
      { models: [{ model: 'glm-5.3-flash' }] },
      { 'glm-5.3-flash': { capabilities: ['tools', 'thinking', 'cloud'] } },
    ),
  })
  const resolved = await adapter.resolveModel(
    OLLAMA_CLOUD_ROUTE,
    'glm-5.3-flash:cloud',
  )
  assert.deepEqual(
    resolved.reasoning?.efforts.map((effort) => effort.id),
    ['low', 'high', 'max'],
  )
  assert.equal(resolved.reasoning?.defaultEffort, 'max')
})

test('web search posts the query and drops url-less rows', async () => {
  const seen: { url: string; body: Record<string, unknown> }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    if (String(input).endsWith('/web_search')) {
      // Official shape: {title, url, content}.
      return Response.json({
        results: [
          { url: 'https://example.com/a', title: 'A', content: 's' },
          { title: 'no url' },
        ],
      })
    }
    // Official shape: {title, content, links}.
    return Response.json({
      title: 'A',
      content: '# hi',
      links: ['https://example.com/a'],
    })
  }) as FetchFn
  const options = {
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    fetchFn,
  }
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

test('web providers read the base URL and the switch live', async () => {
  let enabled = false
  let base = DEFAULT_OLLAMA_BASE_URL
  const seen: string[] = []
  const fetchFn = (async (input: RequestInfo | URL) => {
    seen.push(String(input))
    return Response.json({ results: [] })
  }) as FetchFn
  const provider = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: () => base,
    enabled: () => enabled,
    fetchFn,
  })
  // Off by default: unavailable, and a pinned profile's call is refused
  // before any provider I/O.
  assert.equal(provider.available(), false)
  await assert.rejects(
    () => provider.search({ query: 'q' }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === 'OLLAMA_WEB_DISABLED',
  )
  assert.deepEqual(seen, [])
  enabled = true
  base = 'http://localhost:11434'
  assert.equal(provider.available(), true)
  await provider.search({ query: 'q' })
  assert.deepEqual(seen, ['http://localhost:11434/web_search'])
})

test('web providers fail loudly without a key and never follow redirects', async () => {
  const loggedOut = new OllamaWebSearchProvider({
    apiKey: async () => undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
  })
  await assert.rejects(() => loggedOut.search({ query: 'q' }), /OLLAMA_API_KEY/)
  const redirecting = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal((init as { redirect?: string }).redirect, 'error')
      // Realistic undici shape: the redirect rejection nests in `cause`.
      throw new TypeError('fetch failed', {
        cause: new Error('redirect mode is set to error'),
      })
    }) as FetchFn,
  })
  await assert.rejects(
    () => redirecting.search({ query: 'q' }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === 'OLLAMA_WEB_REDIRECT',
  )
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
  await assert.rejects(
    () => failing.search({ query: 'q' }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === 'OLLAMA_WEB_BAD_RESPONSE',
  )
  assert.equal(calls, 1)
  const garbled = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    fetchFn: (async () =>
      new Response('not json{{', { status: 200 })) as FetchFn,
  })
  await assert.rejects(
    () => garbled.search({ query: 'q' }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === 'OLLAMA_WEB_BAD_REPLY',
  )
})

test('web timeouts and transport failures retry once, then carry codes', async () => {
  let calls = 0
  const hanging = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    fetchFn: ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        calls += 1
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })) as FetchFn,
    requestTimeoutMs: 20,
  })
  await assert.rejects(
    () => hanging.search({ query: 'q' }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === 'OLLAMA_WEB_TIMEOUT',
  )
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
  await assert.rejects(
    () => broken.search({ query: 'q' }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === 'OLLAMA_WEB_TRANSPORT',
  )
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
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError')),
          )
        },
      })
      return Promise.resolve(new Response(stream, { status: 200 }))
    }) as FetchFn,
    requestTimeoutMs: 20,
  })
  await assert.rejects(
    () => stalled.search({ query: 'q' }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === 'OLLAMA_WEB_TIMEOUT',
  )
  assert.equal(calls, 2)
})

test('a malformed reply carries no provider bytes in its chain', async () => {
  const garbled = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    fetchFn: (async () =>
      new Response('REDACTED malformed provider response', {
        status: 200,
      })) as FetchFn,
  })
  const error = await garbled.search({ query: 'q' }).then(
    () => {
      throw new Error('must not succeed')
    },
    (failure: unknown) => failure,
  )
  assert.ok(error instanceof Error)
  assert.equal((error as { code?: string }).code, 'OLLAMA_WEB_BAD_REPLY')
  // The chained diagnostic must not quote the offending bytes either.
  assert.ok(!String(error).includes('REDACTED'))
  assert.ok(!errorChain(error).includes('REDACTED'))
  assert.equal((error as { cause?: unknown }).cause, undefined)
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
  await assert.rejects(
    () => huge.search({ query: 'q' }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === 'OLLAMA_WEB_BAD_REPLY',
  )
  assert.equal(calls, 1)
})

test('an undeclared oversized stream stops early and cancels', async () => {
  let cancelled = false
  let pulls = 0
  const chunk = new TextEncoder().encode('x'.repeat(256 * 1024))
  const streaming = new OllamaWebSearchProvider({
    apiKey: async () => 'k' as string | undefined,
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    fetchFn: (async () =>
      new Response(
        new ReadableStream({
          // Endless 256 KiB chunks with no content-length: the 2 MiB cap
          // must trip after a bounded prefix, and the live stream must be
          // cancelled instead of left hanging behind the rejection.
          pull(controller) {
            pulls += 1
            controller.enqueue(chunk)
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 200 },
      )) as FetchFn,
  })
  await assert.rejects(
    () => streaming.search({ query: 'q' }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === 'OLLAMA_WEB_BAD_REPLY',
  )
  assert.equal(cancelled, true)
  assert.ok(pulls <= 12, `read ${String(pulls)} chunks past the cap`)
})

test('no stored default with discovery off falls back to the family default', async () => {
  // Adoption stops copying the vendor default, so a fresh row has none;
  // the family table must still serve as the last resort on the
  // no-discovery path, matching what the discovered path resolves.
  const adapter = makeAdapter({
    catalog: [
      {
        id: 'glm-5.3:cloud',
        name: 'GLM-5.3',
        thinking: true,
        efforts: ['low', 'high', 'max'],
      },
    ],
    discovery: false,
  })
  const resolved = await adapter.resolveModel(
    OLLAMA_CLOUD_ROUTE,
    'glm-5.3:cloud',
  )
  assert.deepEqual(
    resolved.reasoning?.efforts.map((effort) => effort.id),
    ['low', 'high', 'max'],
  )
  assert.equal(resolved.reasoning?.defaultEffort, 'max')
})

test('a user default outside a retracted vendor set falls back instead of riding the wire', async () => {
  // The stored `max` no longer sits inside the vendor's offered levels;
  // the resolver must not send it.
  const adapter = makeAdapter({
    catalog: [
      {
        id: 'glm-5.3:cloud',
        thinking: true,
        efforts: ['max'],
        defaultEffort: 'max',
      },
    ],
    fetchFn: fakeDiscovery(
      { models: [{ model: 'glm-5.3' }] },
      {
        'glm-5.3': {
          capabilities: ['thinking'],
          thinking: { values: ['low', 'high'], default: 'high' },
        },
      },
    ),
  })
  const resolved = await adapter.resolveModel(
    OLLAMA_CLOUD_ROUTE,
    'glm-5.3:cloud',
  )
  assert.deepEqual(
    resolved.reasoning?.efforts.map((effort) => effort.id),
    ['low', 'high'],
  )
  assert.equal(resolved.reasoning?.defaultEffort, 'high')
})
