/**
 * Ollama-native web capabilities: search and fetch ride the Cloud
 * `/api/web_search` + `/api/web_fetch` endpoints independently of the
 * selected chat model. Both providers share the `ollama-cloud` id because
 * the seam addresses each capability kind separately.
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from '@deepseek-ai/dsh-web'
import type { FetchFn } from './common.js'
import { hostFetch } from '../http.js'

/** Shared provider id for both web capabilities. */
export const OLLAMA_WEB_PROVIDER_ID = 'ollama-cloud'

/** Per-attempt budget; the seam owns overall cancellation. */
export const OLLAMA_WEB_TIMEOUT_MS = 15_000

/** Search result cap applied at the request layer. */
export const OLLAMA_WEB_MAX_RESULTS = 10

export interface OllamaWebOptions {
  /** Resolve the API key per call; `undefined` means unconfigured. */
  apiKey: () => Promise<string | undefined>
  /** Native base URL; web endpoints ride it unchanged (no `/v1` mapping). */
  baseURL: string
  /** Local gate; absent counts as enabled. Read on every call. */
  enabled?: () => boolean
  fetchFn?: FetchFn
  requestTimeoutMs?: number
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

function isRedirectFailure(error: unknown): boolean {
  // Real fetch failures nest: undici reports `fetch failed` on top with the
  // redirect rejection in `cause`. Walk the chain instead of reading only
  // the outer message.
  for (let current = error; current instanceof Error; current = current.cause as Error | undefined) {
    if (/redirect/i.test(current.message)) return true
  }
  return false
}

async function postJson(
  url: string,
  apiKey: string,
  payload: Record<string, unknown>,
  options: OllamaWebOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  const fetchFn = options.fetchFn ?? hostFetch
  const timeoutMs = options.requestTimeoutMs ?? OLLAMA_WEB_TIMEOUT_MS
  let lastError: unknown
  // Exactly two attempts; only a timeout or a pre-response transport
  // failure retries. HTTP errors, malformed replies, missing credentials,
  // redirects, and caller cancellation never retry.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    throwIfAborted(signal)
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('ollama web request timed out'))
    }, timeoutMs)
    if (typeof (timer as { unref?: unknown }).unref === 'function') {
      (timer as unknown as { unref(): void }).unref()
    }
    const onCallerAbort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
          'authorization': `Bearer ${apiKey}`,
          ...attributionHeaders(),
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new WebError(
          `ollama web request failed (HTTP ${String(response.status)})`,
          'OLLAMA_WEB_BAD_RESPONSE',
        )
      }
      try {
        return await response.json() as unknown
      } catch (error: unknown) {
        throw new WebError('ollama web request returned a malformed reply', 'OLLAMA_WEB_BAD_REPLY', { cause: error })
      }
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      // Classified failures carry their own code and never retry.
      if (error instanceof WebError) throw error
      if (isRedirectFailure(error)) {
        throw new WebError('ollama web request redirected; redirects are not followed', 'OLLAMA_WEB_REDIRECT')
      }
      if (timedOut) {
        if (attempt >= 2) throw new WebError('ollama web request timed out', 'OLLAMA_WEB_TIMEOUT', { cause: error })
        continue
      }
      if (attempt >= 2) {
        throw new WebError('ollama web request transport failed', 'OLLAMA_WEB_TRANSPORT', { cause: error })
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
    }
  }
  throw new WebError('ollama web request failed', 'OLLAMA_WEB_TRANSPORT')
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function resolveWebKey(options: OllamaWebOptions, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  const apiKey = await options.apiKey()
  if (apiKey === undefined) {
    throw new WebError(
      'Ollama web search requires an Ollama Cloud API key; configure OLLAMA_API_KEY',
      'OLLAMA_WEB_MISSING_CREDENTIAL',
    )
  }
  return apiKey
}

/** Search provider behind DSH's stock web_search tool. */
export class OllamaWebSearchProvider implements WebSearchProvider {
  readonly id = OLLAMA_WEB_PROVIDER_ID

  constructor(private readonly options: OllamaWebOptions) {}

  available(): boolean {
    try {
      new URL(this.options.baseURL)
    } catch {
      return false
    }
    return this.options.enabled?.() ?? true
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const apiKey = await resolveWebKey(this.options, signal)
    const base = this.options.baseURL.replace(/\/+$/, '')
    const payload = await postJson(`${base}/web_search`, apiKey, {
      query: request.query,
      ...(request.maxResults === undefined ? {} : { max_results: Math.min(request.maxResults, OLLAMA_WEB_MAX_RESULTS) }),
    }, this.options, signal)
    const results = recordOf(payload)?.['results']
    if (!Array.isArray(results)) throw new WebError('ollama web search returned no results array', 'OLLAMA_WEB_BAD_REPLY')
    const sources = results.flatMap(entry => {
      const record = recordOf(entry)
      const url = record?.['url']
      if (typeof url !== 'string' || url.length === 0) return []
      return [{
        url,
        ...(typeof record?.['title'] === 'string' ? { title: record?.['title'] as string } : {}),
        ...(typeof record?.['snippet'] === 'string' ? { snippet: record?.['snippet'] as string } : {}),
      }]
    })
    return { sources, truncated: false }
  }
}

/** Fetch provider behind DSH's stock web_fetch tool. */
export class OllamaWebFetchProvider implements WebFetchProvider {
  readonly id = OLLAMA_WEB_PROVIDER_ID

  constructor(private readonly options: OllamaWebOptions) {}

  available(): boolean {
    try {
      new URL(this.options.baseURL)
    } catch {
      return false
    }
    return this.options.enabled?.() ?? true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const apiKey = await resolveWebKey(this.options, signal)
    const base = this.options.baseURL.replace(/\/+$/, '')
    const payload = await postJson(`${base}/web_fetch`, apiKey, { url: request.url }, this.options, signal)
    const record = recordOf(payload)
    const url = record?.['url']
    const statusCode = record?.['status_code'] ?? record?.['statusCode'] ?? record?.['status']
    const content = recordOf(record?.['body'])?.['content'] ?? record?.['content']
    if (typeof url !== 'string' || typeof statusCode !== 'number' || typeof content !== 'string') {
      throw new WebError('ollama web fetch returned a malformed reply', 'OLLAMA_WEB_BAD_REPLY')
    }
    return { url, statusCode, body: { kind: 'text', content }, truncated: false }
  }
}
