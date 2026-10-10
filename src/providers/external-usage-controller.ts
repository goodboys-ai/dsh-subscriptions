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

const DEFAULT_REFS: Record<ExternalUsageSource, string> = {
  'opencode-go': 'OPENCODE_GO_API_KEY',
  'kimi-code': 'KIMI_CODING_API_KEY',
  'minimax': 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  'ollama-cloud': DEFAULT_OLLAMA_API_KEY_REF,
}

export class ExternalUsageController {
  private readonly refs: Record<ExternalUsageSource, string>
  private readonly ollamaBaseURL: string

  constructor(
    private readonly resolveCredential: ResolveCredential,
    private readonly http: typeof fetch = fetch,
    refs: Partial<Record<ExternalUsageSource, string>> = {},
    ollamaBaseURL: string = DEFAULT_OLLAMA_BASE_URL,
  ) {
    this.refs = { ...DEFAULT_REFS, ...refs }
    this.ollamaBaseURL = ollamaBaseURL
  }

  async status(): Promise<Record<ExternalUsageSource, ExternalUsageStatus>> {
    const values = await Promise.all(EXTERNAL_USAGE_SOURCES.map(async source => {
      const value = await this.resolveCredential(this.refs[source])
      return typeof value?.value === 'string' && value.value.length > 0
    }))
    return Object.fromEntries(EXTERNAL_USAGE_SOURCES.map((source, i) => [source, { configured: values[i] ?? false }])) as Record<ExternalUsageSource, ExternalUsageStatus>
  }

  async usage(source: ExternalUsageSource, signal?: AbortSignal): Promise<ProviderUsage> {
    const credential = await this.resolveCredential(this.refs[source])
    if (credential?.value === undefined || credential.value.length === 0) {
      throw new Error(`${source} API key is not configured`)
    }
    if (source === 'minimax' || source === 'minimax-cn') return fetchMiniMaxUsage(credential.value, source === 'minimax-cn' ? 'cn' : 'global', this.http, signal)
    if (source === 'ollama-cloud') return fetchOllamaUsage(credential.value, this.ollamaBaseURL, this.http, signal)
    return source === 'opencode-go'
      ? fetchOpenCodeGoUsage(credential.value, this.http, signal)
      : fetchKimiCodeUsage(credential.value, this.http, signal)
  }
}
