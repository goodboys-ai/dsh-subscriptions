/**
 * Draft rules of the Ollama Cloud settings dialog, kept free of React and the
 * DOM so they can be unit tested. The node half owns the shapes below; the
 * client restates them locally because the browser bundle does not import
 * node-side modules.
 */

/** One model entry as stored in the route settings. */
export interface OllamaModelSetting {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  vision?: boolean
  thinking?: boolean
  efforts?: string[]
  defaultEffort?: string
}

/** One model row of the editable draft (same fields as the stored entry). */
export interface OllamaModelDraft {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  vision?: boolean
  thinking?: boolean
  efforts?: string[]
  defaultEffort?: string
}

/** The editable settings draft; every field is an override of the deployment value. */
export interface OllamaSettingsDraft {
  models?: OllamaModelDraft[]
  web?: boolean
  baseURL?: string
  apiKeyRef?: string
}

/** `ollamaSettings` endpoint value. */
export interface OllamaSettingsView {
  provider: 'ollama-cloud'
  settings: {
    models?: OllamaModelSetting[]
    web?: boolean
    baseURL?: string
    apiKeyRef?: string
  }
  effective: { baseURL: string; apiKeyRef: string; web: boolean }
  models: {
    id: string
    name: string
    vision: boolean
    thinking: boolean
    contextWindow?: number
    /** Advertised reasoning levels and the endpoint default, when the model reasons. */
    efforts?: { id: string; name: string }[]
    defaultEffort?: string
  }[]
  configOverridesModels: boolean
}

/** One cloud catalog entry returned by the `ollamaModels` endpoint. */
export interface OllamaCloudCandidate {
  /** Normalized wire id; this is what the store keeps. */
  id: string
  /** Listing id before normalization. */
  rawId: string
  /** Display basename. */
  name: string
  vision: boolean
  thinking: boolean
  contextWindow?: number
  efforts: string[]
  defaultEffort?: string
}

/**
 * Append the checked candidates to the draft's model list. Existing rows are
 * never replaced or reordered, ids already present are skipped, and adopted
 * rows keep the candidate order. Optional fields are set only when the
 * candidate advertises a value, because `exactOptionalPropertyTypes` (and the
 * store) must not see an explicit `undefined`.
 * @param current - the draft list before adoption.
 * @param candidates - the cloud list as fetched, in display order.
 * @param selectedIds - ids the user checked.
 * @returns a new list; the input array is not mutated.
 */
export function adoptCandidates(
  current: readonly OllamaModelDraft[] | undefined,
  candidates: readonly OllamaCloudCandidate[],
  selectedIds: readonly string[],
): OllamaModelDraft[] {
  const models = [...(current ?? [])]
  const present = new Set(models.map(model => model.id))
  const selected = new Set(selectedIds)
  for (const candidate of candidates) {
    if (!selected.has(candidate.id) || present.has(candidate.id)) continue
    present.add(candidate.id)
    models.push({
      id: candidate.id,
      name: candidate.name,
      ...(candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow }),
      ...(candidate.vision ? { vision: true } : {}),
      ...(candidate.thinking ? { thinking: true } : {}),
      ...(candidate.efforts.length ? { efforts: [...candidate.efforts] } : {}),
      ...(candidate.defaultEffort ? { defaultEffort: candidate.defaultEffort } : {}),
    })
  }
  return models
}

/**
 * Swap one model with its neighbour. An id that is absent or a move past
 * either end returns the same order.
 * @param models - the current list.
 * @param id - the row to move.
 * @param delta - `-1` moves up, `1` moves down.
 * @returns a new list; the input array is not mutated.
 */
export function moveModel(models: readonly OllamaModelDraft[], id: string, delta: -1 | 1): OllamaModelDraft[] {
  const next = [...models]
  const index = next.findIndex(model => model.id === id)
  const target = index + delta
  if (index === -1 || target < 0 || target >= next.length) return next
  const moved = next[index]
  next[index] = next[target]
  next[target] = moved
  return next
}

/**
 * Drop one model from the list.
 * @param models - the current list.
 * @param id - the row to drop; an unknown id leaves the list unchanged.
 * @returns a new list; the input array is not mutated.
 */
export function removeModel(models: readonly OllamaModelDraft[], id: string): OllamaModelDraft[] {
  return models.filter(model => model.id !== id)
}

/**
 * Short context-window label for a model row.
 * @param contextWindow - the advertised window in tokens.
 * @returns `'1M'`, `'262K'`, the bare number below 1000, or `undefined` when unknown.
 */
export function contextLabel(contextWindow: number | undefined): string | undefined {
  if (contextWindow === undefined) return undefined
  if (contextWindow < 1000) return String(contextWindow)
  if (contextWindow >= 1_000_000) {
    const millions = contextWindow / 1_000_000
    return `${Number.isInteger(millions) ? millions : Number(millions.toFixed(1))}M`
  }
  return `${Math.round(contextWindow / 1000)}K`
}
