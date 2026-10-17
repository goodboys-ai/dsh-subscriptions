import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/**
 * One model the Ollama Cloud route serves. The route ships no catalog of its
 * own: this list is the catalog, in the order the picker shows it. Adoption
 * fills the capability fields from the endpoint's `/api/tags` + `/api/show`
 * reply; every field except `id` is optional so a hand-written row still
 * works.
 */
export interface OllamaModelSetting {
  /** Wire model id; must be non-empty and unique within the list. */
  id: string
  /** Selector label; defaults to the id. */
  name?: string
  /** Known combined request/response context capacity in tokens. */
  contextWindow?: number
  /**
   * The user's local context-window choice. Unlike `contextWindow`, which
   * snapshots what the endpoint advertised, this records only an explicit
   * edit: absent follows the endpoint. The runtime caps it at the advertised
   * window and it never widens the API's real capacity.
   */
  contextOverride?: number
  /** Per-request output cap; defaults to the route's fallback. */
  maxTokens?: number
  /** The endpoint advertised the `vision` capability. */
  vision?: boolean
  /** The endpoint advertised the `thinking` capability. */
  thinking?: boolean
  /** Advertised reasoning efforts, in picker order; empty means non-reasoning. */
  efforts?: string[]
  /** Effort preselected when the session picks none; must be one of `efforts`. */
  defaultEffort?: string
}

/**
 * Durable, non-secret Ollama Cloud configuration. Every field is optional and
 * its absence means "no override": the effective value then falls back to the
 * plugin config and, last, to the built-in default. The API key itself never
 * appears here; `apiKeyRef` only names a DSH credential.
 */
export interface OllamaSettings {
  /** The route's catalog, in picker order. `[]` hides every model. */
  models?: OllamaModelSetting[]
  /** Register the web search/fetch providers; the config value is the default. */
  web?: boolean
  /** Native base URL; the config value is the default. */
  baseURL?: string
  /** Credential reference naming the API key; the config value is the default. */
  apiKeyRef?: string
}

function fail(message: string): never {
  throw new Error(message)
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    fail(`${field} must be a non-empty string`)
  return value
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${field} must be a positive integer`)
  }
  return value
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`)
  return value
}

/**
 * Accept only an absolute http(s) base URL with no credentials, query, or
 * fragment, and return its trimmed form. The route appends `/tags`, `/show`,
 * and `/v1/chat/completions` to this value, so anything else would build a URL
 * that cannot work — and a non-official host receives the referenced
 * credential, which the dialog tells the user.
 * @param value - the candidate URL.
 * @returns the trimmed URL to store.
 * @throws when the value is not a usable absolute http(s) URL.
 */
export function validateOllamaBaseURL(value: unknown): string {
  const raw = readNonEmptyString(value, 'baseURL')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail('baseURL must be an absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    fail('baseURL must use http or https')
  if (url.username !== '' || url.password !== '')
    fail('baseURL must not carry credentials')
  if (url.search !== '' || url.hash !== '')
    fail('baseURL must not carry a query or fragment')
  return raw.trim()
}

/** Credential references are looked up by name, so whitespace is always a typo. */
function readApiKeyRef(value: unknown): string {
  const raw = readNonEmptyString(value, 'apiKeyRef')
  if (/\s/.test(raw)) fail('apiKeyRef must not contain whitespace')
  return raw
}

function readEfforts(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    fail(`${field} must be a non-empty array`)
  const efforts: string[] = []
  for (const entry of value) {
    const effort = readNonEmptyString(entry, `${field} entries`)
    if (!efforts.includes(effort)) efforts.push(effort)
  }
  return efforts
}

function readModel(entry: unknown, index: number): OllamaModelSetting {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`models[${index}] must be an object`)
  }
  const record = entry as Record<string, unknown>
  // The id is the wire id, so surrounding whitespace is always a paste
  // artifact; trim it before the duplicate check sees it.
  const model: OllamaModelSetting = {
    id: readNonEmptyString(record.id, `models[${index}].id`).trim(),
  }
  if (record.name !== undefined)
    model.name = readNonEmptyString(record.name, `models[${index}].name`)
  if (record.contextWindow !== undefined) {
    model.contextWindow = readPositiveInteger(
      record.contextWindow,
      `models[${index}].contextWindow`,
    )
  }
  if (record.contextOverride !== undefined) {
    model.contextOverride = readPositiveInteger(
      record.contextOverride,
      `models[${index}].contextOverride`,
    )
  }
  if (record.maxTokens !== undefined) {
    model.maxTokens = readPositiveInteger(
      record.maxTokens,
      `models[${index}].maxTokens`,
    )
  }
  if (record.vision !== undefined)
    model.vision = readBoolean(record.vision, `models[${index}].vision`)
  if (record.thinking !== undefined)
    model.thinking = readBoolean(record.thinking, `models[${index}].thinking`)
  if (record.efforts !== undefined)
    model.efforts = readEfforts(record.efforts, `models[${index}].efforts`)
  if (record.defaultEffort !== undefined) {
    const effort = readNonEmptyString(
      record.defaultEffort,
      `models[${index}].defaultEffort`,
    )
    // The runtime rejects a default the model does not advertise, so a
    // mismatch is a store bug rather than something to carry forward.
    if (model.efforts !== undefined && !model.efforts.includes(effort)) {
      fail(`models[${index}].defaultEffort must be one of its efforts`)
    }
    model.defaultEffort = effort
  }
  return model
}

/**
 * Validate one settings document, dropping unknown keys and duplicate model
 * ids (first wins, matching the Cursor store's visible-model handling).
 * @param input - the parsed store document or an RPC payload.
 * @throws when a known field has the wrong type or an unusable value.
 */
export function validateOllamaSettings(input: unknown): OllamaSettings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('Ollama settings must be an object')
  }
  const record = input as Record<string, unknown>
  const settings: OllamaSettings = {}
  if (record.models !== undefined) {
    if (!Array.isArray(record.models)) fail('models must be an array')
    const seen = new Set<string>()
    const models: OllamaModelSetting[] = []
    for (const [index, entry] of record.models.entries()) {
      const model = readModel(entry, index)
      if (seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
    settings.models = models
  }
  if (record.web !== undefined) settings.web = readBoolean(record.web, 'web')
  if (record.baseURL !== undefined)
    settings.baseURL = validateOllamaBaseURL(record.baseURL)
  if (record.apiKeyRef !== undefined)
    settings.apiKeyRef = readApiKeyRef(record.apiKeyRef)
  return settings
}

/**
 * Durable Ollama Cloud configuration under the DSH home directory. Writes are
 * serialized and atomic (temp file with mode 0600, then rename), so a crash
 * never leaves a half-written document and a concurrent writer cannot lose an
 * earlier save.
 */
export class OllamaSettingsStore {
  private current: OllamaSettings = {}
  private writes: Promise<void> = Promise.resolve()
  /** Set when the stored file existed but was unreadable or invalid. */
  private corrupt: string | undefined

  constructor(
    readonly path = dshHomePath(
      'plugins',
      'subscriptions',
      'ollama-settings.json',
    ),
    private readonly onCorrupt?: (message: string) => void,
  ) {
    try {
      this.current = validateOllamaSettings(
        JSON.parse(readFileSync(path, 'utf8')) as unknown,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A broken file must not take the whole plugin down: degrade to
        // defaults, keep the file untouched for manual recovery, and let
        // the next save overwrite it.
        this.corrupt = error instanceof Error ? error.message : String(error)
        // The raw V8 message quotes the offending bytes; the log keeps a
        // fixed diagnosis and corruption() carries the detail for callers
        // that surface it outside log lines.
        this.onCorrupt?.(
          `Ollama settings at ${path} are unreadable and ignored; defaults serve until the next save.`,
        )
      }
    }
  }

  /** Why the stored file is ignored, when it is. */
  corruption(): string | undefined {
    return this.corrupt
  }

  get(): OllamaSettings {
    return structuredClone(this.current)
  }

  /** The stored catalog, or `undefined` when the store carries no override. */
  models(): readonly OllamaModelSetting[] | undefined {
    return this.current.models
  }

  web(): boolean | undefined {
    return this.current.web
  }

  baseURL(): string | undefined {
    return this.current.baseURL
  }

  apiKeyRef(): string | undefined {
    return this.current.apiKeyRef
  }

  set(input: unknown): Promise<void> {
    const validated = validateOllamaSettings(input)
    const run = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(validated, null, 2), {
          mode: 0o600,
        })
        await rename(temporary, this.path)
      } finally {
        await rm(temporary, { force: true })
      }
      this.current = validated
      this.corrupt = undefined
    })
    this.writes = run.catch(() => undefined)
    return run
  }
}
