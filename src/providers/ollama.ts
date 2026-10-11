/**
 * Ollama Cloud provider: a key-based OpenAI-completions route with no OAuth
 * session. The credential arrives per request as a bearer key; chat posts to
 * the configured native baseURL's `/v1` sibling. The route ships no catalog:
 * only models the user stored on the Settings card are served, so an empty
 * store hides the picker entry and rejects every chat model.
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
import type { DiscoveredModel, FetchFn } from './common.js'
import type { OllamaModelSetting } from './ollama-settings.js'
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

/** Fallback context window for a row the endpoint never described. */
export const OLLAMA_DEFAULT_CONTEXT_WINDOW = 262_144

/**
 * Budget for the Settings card's explicit cloud listing. Longer than the
 * picker's discovery bound because a user waits on this one and `/api/show`
 * runs once per model.
 */
export const OLLAMA_PULL_TIMEOUT_MS = 20_000

/** Concurrency bound for `/api/show` enrichment. */
const SHOW_CONCURRENCY = 6

/** Response body bound for discovery payloads. */
const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024

/**
 * Reasoning efforts for known Cloud model families. This is capability
 * knowledge, not a catalog: `/api/show` reports that a model thinks but not
 * which levels it accepts, and the vendor publishes no per-model list, so the
 * family prefix supplies the levels the standalone plugin recorded. A stored
 * row's own `efforts` always wins; a row with none outside these families
 * carries no reasoning block.
 */
const OLLAMA_REASONING_FAMILIES: readonly { prefix: string; efforts: readonly string[]; defaultEffort: string }[] = [
  // The vendor's `/api/show` publishes thinking values [false, low, high,
  // max] with default high; `false` rides as `off` and maps to the wire
  // spelling `none`. No `medium`: the vendor lists none.
  { prefix: 'deepseek-v4.1-flash', efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' },
  { prefix: 'glm-5.3', efforts: ['low', 'high', 'max'], defaultEffort: 'max' },
]

function reasoningFamily(id: string): { efforts: readonly string[]; defaultEffort: string } | undefined {
  return OLLAMA_REASONING_FAMILIES.find(family => id.startsWith(family.prefix))
}

/** One catalog row the adapter serves, with every fallback already applied. */
interface OllamaCatalogRow {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  vision: boolean
  efforts: string[]
  defaultEffort: string | undefined
}

export interface OllamaAdapterOptions {
  /** Resolve the API key per request; `undefined` means unconfigured. */
  apiKey: () => Promise<string | undefined>
  /**
   * Live native base URL (`https://ollama.com/api`); chat maps it to `/v1`.
   * Read per request so a Settings save takes effect without a restart.
   */
  baseURL: () => string
  /**
   * Live catalog snapshot, in picker order. The Settings store (or a
   * non-empty config override) is the only source; an empty list means the
   * route serves no model.
   */
  catalog: () => readonly OllamaModelSetting[]
  /** Per-model default-effort override, winning over the stored row. */
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

/**
 * Normalize one listing id to the wire id the chat endpoint accepts. The
 * Cloud listing advertises bare names (`glm-5.3`) while its chat wire wants
 * the `:cloud` tag; a local daemon reached through a custom base URL takes
 * the bare name, so only the official host gets the tag. An id that already
 * carries a tag is returned unchanged.
 * @param id - the id as listed by `/api/tags`.
 * @param baseURL - the native base URL the listing came from.
 * @returns the id to store and send on the chat wire.
 */
export function normalizeOllamaModelId(id: string, baseURL: string): string {
  if (id.includes(':')) return id
  let host: string
  try {
    host = new URL(baseURL).hostname
  } catch {
    return id
  }
  return /(^|\.)ollama\.com$/.test(host) ? `${id}:cloud` : id
}

/** Whether the failure is a rejected key. Only a 401 hides the route: a
 * 403 may be a transient scope denial, so it falls back to the stored
 * catalog like any other discovery miss. */
function isUnauthorized(error: unknown): boolean {
  return error instanceof LlmError && error.code === 'AUTH'
    && error.failure?.status === 401
}

/**
 * Find a discovered row for a catalog id, tolerating a listing endpoint that
 * still reports bare names (`glm-5.3` for catalogued `glm-5.3:cloud`).
 */
function discoveredFor(catalogId: string, discovered: readonly DiscoveredModel[] | undefined): DiscoveredModel | undefined {
  return discovered?.find(row => row.id === catalogId)
    ?? discovered?.find(row => row.id === catalogId.replace(/:cloud$/, ''))
}

function reasoningFor(row: OllamaCatalogRow, configuredDefault: string | undefined): DiscoveredModel['reasoning'] {
  const base = row.efforts.length === 0
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

/** One discovered Cloud model, with the capability flags the card badges. */
export interface OllamaDiscoveredModel extends DiscoveredModel {
  /** The id exactly as `/api/tags` published it, before wire normalization. */
  rawId: string
  /** The endpoint advertised the `thinking` capability. */
  thinking: boolean
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

function discoveredFromShow(id: string, rawId: string, show: Record<string, unknown>): OllamaDiscoveredModel {
  const rawCapabilities = show['capabilities']
  const capabilities = new Set(Array.isArray(rawCapabilities)
    ? rawCapabilities.filter((entry): entry is string => typeof entry === 'string')
    : [])
  const vision = capabilities.has('vision')
  const thinking = capabilities.has('thinking')
  const family = thinking ? reasoningFamily(id) : undefined
  const contextWindow = extractContextWindow(show)
  return {
    id,
    rawId,
    name: id,
    thinking,
    ...contextWindow === undefined ? {} : { contextWindow },
    inputModalities: vision ? ['text', 'image'] : ['text'],
    ...family === undefined ? {} : {
      reasoning: {
        efforts: family.efforts.map(effort => ({ id: ReasoningEffortId(effort), name: effortDisplayName(effort) })),
        defaultEffort: ReasoningEffortId(family.defaultEffort),
      },
    },
  }
}

/**
 * List Cloud models via `/api/tags`, enriching through `/api/show`. A failed
 * enrichment degrades to an id-only row; a failed listing fails. Listing ids
 * are normalized to their wire form ({@link normalizeOllamaModelId}) while
 * `/api/show` still receives the id the endpoint published.
 */
export async function fetchOllamaModels(options: OllamaDiscoveryOptions): Promise<OllamaDiscoveredModel[]> {
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
  const entries: { raw: string; wire: string }[] = []
  for (const entry of listed) {
    const record = recordOf(entry)
    const raw = record === undefined
      ? undefined
      : typeof record['model'] === 'string' ? record['model'] : typeof record['name'] === 'string' ? record['name'] : undefined
    if (raw === undefined || raw.length === 0) continue
    const wire = normalizeOllamaModelId(raw, options.baseURL)
    if (seen.has(wire)) continue
    seen.add(wire)
    entries.push({ raw, wire })
  }
  if (entries.length === 0) throw new LlmError('ollama models endpoint returned an empty catalog', 'DISCOVERY_FAILED')
  const out = new Array<OllamaDiscoveredModel>(entries.length)
  let cursor = 0
  const enrich = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= entries.length) return
      const { raw, wire } = entries[index]!
      try {
        const showResponse = await fetchFn(`${base}/show`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...discoveryHeaders(options.apiKey) },
          body: JSON.stringify({ model: raw }),
          ...options.signal === undefined ? {} : { signal: options.signal },
        })
        if (!showResponse.ok) throw await httpLlmError(showResponse, 'ollama model details')
        const show = recordOf(await readBoundedJson(showResponse, 'ollama model details', MAX_DISCOVERY_BYTES))
        out[index] = show === undefined
          ? { id: wire, rawId: raw, name: wire, thinking: false }
          : discoveredFromShow(wire, raw, show)
      } catch {
        // One model's enrichment never sinks the listing.
        out[index] = { id: wire, rawId: raw, name: wire, thinking: false }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, entries.length) }, enrich))
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

  /** Drop the discovery snapshot so the next picker pass re-reads the endpoint. */
  invalidateModels(): void { this.catalogCache.invalidate() }

  private rows(): OllamaCatalogRow[] {
    return this.options.catalog().map(entry => {
      const family = reasoningFamily(entry.id)
      return {
        id: entry.id,
        name: entry.name ?? entry.id,
        contextWindow: entry.contextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW,
        maxTokens: entry.maxTokens ?? OLLAMA_DEFAULT_MAX_TOKENS,
        vision: entry.vision === true,
        efforts: entry.efforts !== undefined && entry.efforts.length > 0
          ? [...entry.efforts]
          : [...family?.efforts ?? []],
        defaultEffort: entry.defaultEffort ?? family?.defaultEffort,
      }
    })
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Ollama Cloud' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const catalog = this.rows()
    // No stored model means no catalog: the route ships no built-in rows, so
    // an empty store hides the picker entry instead of advertising models
    // the user never adopted.
    if (catalog.length === 0) return []
    // No key means logged out: hide the route instead of advertising
    // models every request would fail for.
    const apiKey = await this.options.apiKey()
    if (apiKey === undefined) return []
    if (this.options.discovery === false) return this.staticList(provider, catalog)
    try {
      const discovered = await withTimeout(
        signal => this.catalogCache.get(() => fetchOllamaModels({
          baseURL: this.options.baseURL(),
          apiKey,
          fetchFn: this.options.fetchFn,
          signal,
        })),
        DISCOVERY_TIMEOUT_MS,
      )
      // A timeout resolves undefined: treat it like any other discovery
      // miss and serve the stored catalog.
      if (discovered === undefined) return this.staticList(provider, catalog)
      // Discovery enriches the stored allowlist but never extends it: the
      // user adopted an exact catalog, so unmatched discoveries stay out of
      // the picker.
      return catalog.map(entry => {
        const match = discoveredFor(entry.id, discovered)
        if (match === undefined) {
          return {
            provider,
            id: entry.id,
            name: entry.name,
            inputModalities: entry.vision ? ['text', 'image'] : ['text'],
          }
        }
        // The picker keeps the stored friendly name: discovered rows carry
        // listing ids that would read as a rename every refresh. Discovery
        // enriches capabilities only.
        return {
          provider,
          id: entry.id,
          name: entry.name,
          inputModalities: match.inputModalities ?? (entry.vision ? ['text', 'image'] : ['text']),
        }
      })
    } catch (error: unknown) {
      if (isDiscoveryAborted(error)) throw error
      // Keys are stateless, so any other failure falls back to the stored
      // catalog; a 401 instead hides the route like a logout.
      if (isMissingOrInvalidCredential(error) || isUnauthorized(error)) return []
      this.options.onWarn?.(`ollama-cloud model discovery failed; using the stored catalog (${errorChain(error)})`)
      return this.staticList(provider, catalog)
    }
  }

  private staticList(provider: string, catalog: readonly OllamaCatalogRow[]): LlmModelInfo[] {
    return catalog.map(entry => ({
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.rows().find(row => row.id === model)
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
          baseURL: this.options.baseURL(),
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
      ? reasoningFor(entry, configuredDefault)
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
      const entry = this.rows().find(row => row.id === options.model)
      if (entry === undefined) throw new LlmError(`ollama-cloud has no configured model "${options.model}"`, 'UNKNOWN_MODEL')
      const requestMessages = entry.vision ? options.messages : withoutImages(options.messages)
      const resolved = await resolveImages(requestMessages, this.options.resolveAttachments?.(), watchdog.signal)
      const body = ollamaChatRequestBody(
        options,
        toChatMessages(resolved, options.system),
        options.maxTokens ?? entry.maxTokens,
      )
      const chatBase = ollamaChatBaseURL(this.options.baseURL())
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
