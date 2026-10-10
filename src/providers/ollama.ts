/**
 * Ollama Cloud provider: a key-based OpenAI-completions route with no OAuth
 * session. The credential arrives per request as a bearer key; chat posts to
 * the configured native baseURL's `/v1` sibling, and only catalogued models
 * are served.
 */

import {
  attributionHeaders,
  EMPTY_RESPONSE_CODE,
  errorChain,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  DISCOVERY_TIMEOUT_MS,
  effortDisplayName,
  httpLlmError,
  idleWatchdog,
  isDiscoveryAborted,
  isMissingOrInvalidCredential,
  mapFetchFailure,
  mergeReasoning,
  ModelCatalogCache,
  readBoundedJson,
  withTimeout,
} from './common.js'
import type { DiscoveredModel, FetchFn, ModelEntry } from './common.js'
import { hostFetch } from '../http.js'
import { resolveImages } from '../translate/resolved.js'
import { streamChatCompletions, toChatMessages, toChatTools } from '../translate/chat-completions.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

/** Route id owned by this adapter. Not a member of the OAuth `PROVIDER_IDS`. */
export const OLLAMA_CLOUD_ROUTE = 'ollama-cloud'

/** Default credential reference naming the Ollama Cloud API key. */
export const DEFAULT_OLLAMA_API_KEY_REF = 'OLLAMA_API_KEY'

/** Default native base URL; chat maps it to its `/v1` sibling. */
export const DEFAULT_OLLAMA_BASE_URL = 'https://ollama.com/api'

/** Fallback per-request output cap; Ollama publishes no per-model limit. */
export const OLLAMA_DEFAULT_MAX_TOKENS = 32_768

/** Concurrency bound for `/api/show` enrichment. */
const SHOW_CONCURRENCY = 6

/** Response body bound for discovery payloads. */
const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024

/** One built-in catalog row: static capabilities for a Cloud model. */
export interface OllamaBuiltinModel {
  /** Wire model id, including the `:cloud` tag. */
  id: string
  /** Selector label. */
  name: string
  /** Combined request/response context capacity. */
  contextWindow: number
  /** Whether the model accepts image input. */
  vision: boolean
  /** Advertised reasoning efforts; empty means non-reasoning. */
  efforts: string[]
  /** Effort preselected when the session picks none. */
  defaultEffort?: string
}

/**
 * Built-in catalog. Context windows and modalities mirror the Ollama
 * registry; effort families mirror the upstream ollama adapter (the v4.1
 * flash default is `high` because the vendor publishes no default and the
 * generic family offers none).
 */
export const OLLAMA_BUILTIN_MODELS: readonly OllamaBuiltinModel[] = [
  {
    id: 'deepseek-v4.1-flash:cloud',
    name: 'DeepSeek V4.1 Flash (cloud)',
    contextWindow: 1_000_000,
    vision: true,
    // The vendor's `/api/show` publishes thinking values
    // [false, low, high, max] with default high; `false` rides as `off`
    // and maps to the wire spelling `none` (upstream parity). No `medium:
    // the vendor lists none.
    efforts: ['off', 'low', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'glm-5.3:cloud',
    name: 'GLM-5.3 (cloud)',
    contextWindow: 1_000_000,
    vision: false,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
  },
  {
    id: 'glm-5.3-flash:cloud',
    name: 'GLM-5.3-Flash (cloud)',
    contextWindow: 1_000_000,
    vision: true,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
  },
]

export interface OllamaAdapterOptions {
  /** Resolve the API key per request; `undefined` means unconfigured. */
  apiKey: () => Promise<string | undefined>
  /** Native base URL (`https://ollama.com/api`); chat maps it to `/v1`. */
  baseURL?: string
  /** Catalog override; non-empty replaces the built-in rows wholesale. */
  models?: ModelEntry[]
  /** Per-model default-effort override, winning over the built-in row. */
  defaultEffortOf?: (model: string) => string | undefined
  /** Live discovery via `/api/tags` + `/api/show` (default true). */
  discovery?: boolean
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  streamIdleTimeoutMs?: number
  onWarn?: (message: string) => void
}

/** Map a native base URL to its OpenAI-compatible chat sibling. */
export function ollamaChatBaseURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '')
  if (trimmed.endsWith('/v1')) return trimmed
  if (trimmed.endsWith('/api')) return `${trimmed.slice(0, -'/api'.length)}/v1`
  return `${trimmed}/v1`
}

function builtinRow(id: string): OllamaBuiltinModel | undefined {
  return OLLAMA_BUILTIN_MODELS.find(entry => entry.id === id)
}

/** Whether the failure is a rejected key. Only a 401 hides the route: a
 * 403 may be a transient scope denial, so it falls back to the static
 * catalog like any other discovery miss. */
function isUnauthorized(error: unknown): boolean {
  return error instanceof LlmError && error.code === 'AUTH'
    && error.failure?.status === 401
}

/**
 * Find a discovered row for a static catalog id, tolerating the listing
 * endpoint's bare names (`glm-5.3` for catalogued `glm-5.3:cloud`).
 */
function discoveredFor(staticId: string, discovered: readonly DiscoveredModel[] | undefined): DiscoveredModel | undefined {
  return discovered?.find(row => row.id === staticId)
    ?? discovered?.find(row => row.id === staticId.replace(/:cloud$/, ''))
}

function reasoningFor(row: OllamaBuiltinModel | undefined, configuredDefault: string | undefined): DiscoveredModel['reasoning'] {
  const base = row === undefined || row.efforts.length === 0
    ? undefined
    : {
      efforts: row.efforts.map(effort => ({ id: ReasoningEffortId(effort), name: effortDisplayName(effort) })),
      ...(row.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(row.defaultEffort) }),
    }
  return mergeReasoning(configuredDefault, base, { extendable: true })
}

/** Strip image blocks for models that cannot accept vision input. Runs before
 * image resolution so a text-only model never requires the attachment store. */
function withoutImages(messages: readonly RequestMessage[]): RequestMessage[] {
  return messages.map(message => ({
    ...message,
    content: message.content.filter(block => block.type !== 'image'),
  })) as RequestMessage[]
}

export interface OllamaDiscoveryOptions {
  baseURL: string
  apiKey: string | undefined
  fetchFn?: FetchFn | undefined
  signal?: AbortSignal | undefined
}

function discoveryHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    'accept': 'application/json',
    ...apiKey === undefined ? {} : { 'authorization': `Bearer ${apiKey}` },
    ...attributionHeaders(),
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseNumCtx(parameters: unknown): number | undefined {
  if (typeof parameters !== 'string') return undefined
  const match = /(?:^|\s)num_ctx\s+(\d+)/.exec(parameters)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Prefer an explicit `num_ctx`, else any `*.context_length` in model info. */
function extractContextWindow(show: Record<string, unknown>): number | undefined {
  const numCtx = parseNumCtx(show['parameters'])
  if (numCtx !== undefined) return numCtx
  const info = recordOf(show['model_info'])
  if (info !== undefined) {
    for (const [key, value] of Object.entries(info)) {
      if (key.endsWith('context_length') && typeof value === 'number'
        && Number.isSafeInteger(value) && value > 0) return value
    }
  }
  return undefined
}

/** Reasoning family for a discovered id, mirroring the built-in rows. */
function familyFor(id: string): OllamaBuiltinModel | undefined {
  if (id.startsWith('glm-5.3')) return builtinRow('glm-5.3:cloud')
  if (id.startsWith('deepseek-v4.1-flash')) return builtinRow('deepseek-v4.1-flash:cloud')
  return builtinRow(id)
}

function discoveredFromShow(id: string, show: Record<string, unknown>): DiscoveredModel {
  const rawCapabilities = show['capabilities']
  const capabilities = new Set(Array.isArray(rawCapabilities)
    ? rawCapabilities.filter((entry): entry is string => typeof entry === 'string')
    : [])
  const vision = capabilities.has('vision')
  const thinking = capabilities.has('thinking')
  const family = thinking ? familyFor(id) : undefined
  const contextWindow = extractContextWindow(show)
  return {
    id,
    name: id,
    ...contextWindow === undefined ? {} : { contextWindow },
    inputModalities: vision ? ['text', 'image'] : ['text'],
    ...family === undefined ? {} : {
      reasoning: {
        efforts: family.efforts.map(effort => ({ id: ReasoningEffortId(effort), name: effortDisplayName(effort) })),
        ...(family.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(family.defaultEffort) }),
      },
    },
  }
}

/**
 * List Cloud models via `/api/tags`, enriching through `/api/show`.
 * A failed enrichment degrades to an id-only row; a failed listing fails.
 */
export async function fetchOllamaModels(options: OllamaDiscoveryOptions): Promise<DiscoveredModel[]> {
  const fetchFn = options.fetchFn ?? hostFetch
  const base = options.baseURL.replace(/\/+$/, '')
  let tagsResponse: Response | undefined
  let transportError: unknown
  // The listing gets two attempts; only transport failures retry.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      tagsResponse = await fetchFn(`${base}/tags`, {
        headers: discoveryHeaders(options.apiKey),
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      transportError = undefined
      break
    } catch (error: unknown) {
      transportError = error
    }
  }
  if (tagsResponse === undefined) throw transportError
  if (!tagsResponse.ok) throw await httpLlmError(tagsResponse, 'ollama models')
  const tags = recordOf(await readBoundedJson(tagsResponse, 'ollama models', MAX_DISCOVERY_BYTES))
  const listed = tags?.['models']
  if (!Array.isArray(listed)) throw new Error('ollama models endpoint returned no models array')
  const seen = new Set<string>()
  const ids: string[] = []
  for (const entry of listed) {
    const record = recordOf(entry)
    const id = record === undefined
      ? undefined
      : typeof record['model'] === 'string' ? record['model'] : typeof record['name'] === 'string' ? record['name'] : undefined
    if (id === undefined || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (ids.length === 0) throw new LlmError('ollama models endpoint returned an empty catalog', 'DISCOVERY_FAILED')
  const out = new Array<DiscoveredModel>(ids.length)
  let cursor = 0
  const enrich = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= ids.length) return
      const id = ids[index]!
      try {
        const showResponse = await fetchFn(`${base}/show`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...discoveryHeaders(options.apiKey) },
          body: JSON.stringify({ model: id }),
          ...options.signal === undefined ? {} : { signal: options.signal },
        })
        if (!showResponse.ok) throw await httpLlmError(showResponse, 'ollama model details')
        const show = recordOf(await readBoundedJson(showResponse, 'ollama model details', MAX_DISCOVERY_BYTES))
        out[index] = show === undefined ? { id, name: id } : discoveredFromShow(id, show)
      } catch {
        // One model's enrichment never sinks the listing.
        out[index] = { id, name: id }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, ids.length) }, enrich))
  return out
}

export function ollamaChatRequestBody(
  options: GenerateOptions,
  messages: Record<string, unknown>[],
  maxTokens: number | undefined,
): Record<string, unknown> {
  return {
    model: options.model,
    messages,
    ...options.tools !== undefined && options.tools.length > 0
      ? { tools: toChatTools(options.tools), tool_choice: 'auto' }
      : {},
    // Ollama takes `max_tokens`. The catalog row supplies the default
    // (32,768, matching upstream); a row without one rides without it.
    ...maxTokens !== undefined ? { max_tokens: maxTokens } : {},
    // `off` rides as `none` (upstream parity); any other effort rides
    // verbatim. Only advertised efforts ever reach this branch.
    ...options.reasoningEffort !== undefined
      ? { reasoning_effort: String(options.reasoningEffort) === 'off' ? 'none' : String(options.reasoningEffort) }
      : {},
    stream: true,
    stream_options: { include_usage: true },
  }
}

export class OllamaAdapter extends LlmAdapter {
  private readonly catalogCache = new ModelCatalogCache()

  constructor(private readonly options: OllamaAdapterOptions) {
    super()
  }

  private catalog(): { id: string; name: string; contextWindow: number; maxTokens: number; vision: boolean; efforts: string[]; defaultEffort: string | undefined }[] {
    if (this.options.models !== undefined && this.options.models.length > 0) {
      return this.options.models.map(entry => {
        const row = builtinRow(entry.id)
        return {
          id: entry.id,
          name: entry.name ?? row?.name ?? entry.id,
          contextWindow: entry.contextWindow ?? row?.contextWindow ?? 262_144,
          maxTokens: entry.maxTokens ?? OLLAMA_DEFAULT_MAX_TOKENS,
          vision: (entry.inputModalities ?? (row?.vision === true ? ['text', 'image'] as const : ['text'] as const)).includes('image'),
          efforts: row?.efforts ?? [],
          defaultEffort: row?.defaultEffort,
        }
      })
    }
    return OLLAMA_BUILTIN_MODELS.map(row => ({
      id: row.id,
      name: row.name,
      contextWindow: row.contextWindow,
      maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
      vision: row.vision,
      efforts: row.efforts,
      defaultEffort: row.defaultEffort,
    }))
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Ollama Cloud' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // No key means logged out: hide the route instead of advertising
    // models every request would fail for.
    const apiKey = await this.options.apiKey()
    if (apiKey === undefined) return []
    if (this.options.discovery === false) return this.staticList(provider)
    try {
      const discovered = await withTimeout(
        signal => this.catalogCache.get(() => fetchOllamaModels({
          baseURL: this.options.baseURL ?? DEFAULT_OLLAMA_BASE_URL,
          apiKey,
          fetchFn: this.options.fetchFn,
          signal,
        })),
        DISCOVERY_TIMEOUT_MS,
      )
      // A timeout resolves undefined: treat it like any other discovery
      // miss and serve the static catalog.
      if (discovered === undefined) return this.staticList(provider)
      // Discovery enriches the static allowlist but never extends it: the
      // listing endpoint advertises bare names (`glm-5.3`) the chat wire
      // would reject, so unmatched discoveries stay out of the picker.
      return this.catalog().map(entry => {
        const match = discovered.find(row => row.id === entry.id)
          ?? discovered.find(row => row.id === entry.id.replace(/:cloud$/, ''))
        if (match === undefined) {
          return {
            provider,
            id: entry.id,
            name: entry.name,
            inputModalities: entry.vision ? ['text', 'image'] : ['text'],
          }
        }
        // The picker keeps the static friendly name: discovered rows carry
        // bare listing ids (`glm-5.3`) that would read as a rename every
        // refresh. Discovery enriches capabilities only.
        return {
          provider,
          id: entry.id,
          name: entry.name,
          inputModalities: match.inputModalities ?? (entry.vision ? ['text', 'image'] : ['text']),
        }
      })
    } catch (error: unknown) {
      if (isDiscoveryAborted(error)) throw error
      // Keys are stateless, so any other failure falls back to the static
      // catalog; a 401 instead hides the route like a logout.
      if (isMissingOrInvalidCredential(error) || isUnauthorized(error)) return []
      this.options.onWarn?.(`ollama-cloud model discovery failed; using the built-in catalog (${errorChain(error)})`)
      return this.staticList(provider)
    }
  }

  private staticList(provider: string): LlmModelInfo[] {
    return this.catalog().map(entry => ({
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.catalog().find(row => row.id === model)
    // The pass-through native behavior is deliberately absent: an
    // uncatalogued id fails here instead of 404ing at the gateway.
    if (entry === undefined) throw new LlmError(`ollama-cloud has no configured model "${model}"`, 'UNKNOWN_MODEL')
    // Discovery carries the key when one exists; keyless endpoints still
    // list, and no secret rides a metadata fetch it cannot use. The fetch
    // shares the picker bound so a hung listing cannot stall resolution.
    const discoveryKey = this.options.discovery === false ? undefined : await this.options.apiKey()
    const discovered = this.options.discovery === false
      ? undefined
      : await withTimeout(
        signal => this.catalogCache.resolve(() => fetchOllamaModels({
          baseURL: this.options.baseURL ?? DEFAULT_OLLAMA_BASE_URL,
          apiKey: discoveryKey,
          fetchFn: this.options.fetchFn,
          signal,
        })),
        DISCOVERY_TIMEOUT_MS,
      ).then(
        models => discoveredFor(model, models ?? undefined),
        () => undefined,
      )
    const modalities = discovered?.inputModalities ?? (entry.vision ? ['text', 'image'] as const : ['text'] as const)
    const configuredDefault = this.options.defaultEffortOf?.(model) ?? entry.defaultEffort
    const reasoning = discovered?.reasoning === undefined
      ? reasoningFor(builtinRow(model), configuredDefault)
      : mergeReasoning(configuredDefault, discovered.reasoning, { extendable: true })
    return {
      provider,
      id: model,
      name: entry.name,
      inputModalities: [...modalities],
      context: { contextWindow: discovered?.contextWindow ?? entry.contextWindow },
      defaultMaxTokens: entry.maxTokens,
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs ?? 300_000)
    try {
      const apiKey = await this.options.apiKey()
      if (apiKey === undefined) throw new LlmError('ollama-cloud API key is not configured', 'MISSING_CREDENTIAL')
      const entry = this.catalog().find(row => row.id === options.model)
      if (entry === undefined) throw new LlmError(`ollama-cloud has no configured model "${options.model}"`, 'UNKNOWN_MODEL')
      const requestMessages = entry.vision ? options.messages : withoutImages(options.messages)
      const resolved = await resolveImages(requestMessages, this.options.resolveAttachments?.(), watchdog.signal)
      const body = ollamaChatRequestBody(
        options,
        toChatMessages(resolved, options.system),
        options.maxTokens ?? entry.maxTokens,
      )
      const chatBase = ollamaChatBaseURL(this.options.baseURL ?? DEFAULT_OLLAMA_BASE_URL)
      const fetchFn = this.options.fetchFn ?? hostFetch
      const response = await fetchFn(`${chatBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'accept': 'text/event-stream',
          'content-type': 'application/json',
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal: watchdog.signal,
      })
      if (!response.ok) throw await httpLlmError(response, 'ollama-cloud API')
      if (response.body === null) {
        throw new LlmError('ollama-cloud API returned no response body', EMPTY_RESPONSE_CODE)
      }
      const pulse = (): void => { watchdog.pulse() }
      yield* streamChatCompletions(response.body, pulse)
    } catch (error: unknown) {
      throw mapFetchFailure('ollama-cloud API', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }
}
