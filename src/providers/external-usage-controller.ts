import { fetchMiniMaxUsage } from './minimax-usage.js'
import { fetchKimiCodeUsage, fetchOllamaUsage, fetchOpenCodeGoUsage } from './external-usage.js'
import { DEFAULT_OLLAMA_API_KEY_REF, DEFAULT_OLLAMA_BASE_URL } from './ollama.js'
import type { ProviderUsage } from './common.js'

/** Usage-only sources whose model routes are supplied by the DSH base install. */
export type ExternalUsageSource = 'opencode-go' | 'kimi-code' | 'minimax' | 'minimax-cn' | 'ollama-cloud'

export const EXTERNAL_USAGE_SOURCES: readonly ExternalUsageSource[] = ['opencode-go', 'kimi-code', 'minimax', 'minimax-cn', 'ollama-cloud']

export interface ExternalUsageStatus {
  configured: boolean
}

type ResolveCredential = (name: string) => Promise<{ value: string } | undefined>

/**
 * A setting the controller reads per call. The function form keeps the Ollama
 * reference and base URL live: the Settings card can change them after the
 * controller was constructed.
 */
type LiveValue = string | (() => string)

function valueOf(value: LiveValue): string {
  return typeof value === 'function' ? value() : value
}

const DEFAULT_REFS: Record<ExternalUsageSource, string> = {
  'opencode-go': 'OPENCODE_GO_API_KEY',
  'kimi-code': 'KIMI_CODING_API_KEY',
  'minimax': 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  'ollama-cloud': DEFAULT_OLLAMA_API_KEY_REF,
}

export class ExternalUsageController {
  private readonly refs: Record<ExternalUsageSource, LiveValue>
  private readonly ollamaBaseURL: LiveValue

  constructor(
    private readonly resolveCredential: ResolveCredential,
    private readonly http: typeof fetch = fetch,
    refs: Partial<Record<ExternalUsageSource, LiveValue>> = {},
    ollamaBaseURL: LiveValue = DEFAULT_OLLAMA_BASE_URL,
  ) {
    this.refs = { ...DEFAULT_REFS, ...refs }
    this.ollamaBaseURL = ollamaBaseURL
  }

  async status(): Promise<Record<ExternalUsageSource, ExternalUsageStatus>> {
    const values = await Promise.all(EXTERNAL_USAGE_SOURCES.map(async source => {
      const value = await this.resolveCredential(valueOf(this.refs[source]))
      return typeof value?.value === 'string' && value.value.length > 0
    }))
    return Object.fromEntries(EXTERNAL_USAGE_SOURCES.map((source, i) => [source, { configured: values[i] ?? false }])) as Record<ExternalUsageSource, ExternalUsageStatus>
  }

  async usage(source: ExternalUsageSource, signal?: AbortSignal): Promise<ProviderUsage> {
    // Snapshot the endpoint facts before the first await: a save that
    // switches the ref or host mid-flight must not send the old
    // reference's key to the new host.
    const ref = valueOf(this.refs[source])
    const ollamaBase = valueOf(this.ollamaBaseURL)
    const credential = await this.resolveCredential(ref)
    if (credential?.value === undefined || credential.value.length === 0) {
      throw new Error(`${source} API key is not configured`)
    }
    if (source === 'minimax' || source === 'minimax-cn') return fetchMiniMaxUsage(credential.value, source === 'minimax-cn' ? 'cn' : 'global', this.http, signal)
    if (source === 'ollama-cloud') return fetchOllamaUsage(credential.value, ollamaBase, this.http, signal)
    return source === 'opencode-go'
      ? fetchOpenCodeGoUsage(credential.value, this.http, signal)
      : fetchKimiCodeUsage(credential.value, this.http, signal)
  }
}
