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
  /** The user's explicit local context window; absent follows the endpoint. */
  contextOverride?: number
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
  /** The user's explicit local context window; absent follows the endpoint. */
  contextOverride?: number
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
      // The vendor's default is not copied: defaultEffort in the store is
      // the user's explicit choice only, so the resolver's priority
      // (user, then vendor, then family) keeps the vendor default live
      // in discovery while the selector stays an override.
      ...(candidate.efforts.length ? { efforts: [...candidate.efforts] } : {}),
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

/**
 * Rename one model row. An empty display name deletes the field so the
 * validator keeps accepting the draft; a blank id leaves the list unchanged.
 * @param models - the current list.
 * @param id - the row to rename; an unknown id leaves the list unchanged.
 * @param name - the new display name; whitespace trims before storing.
 * @returns a new list; the input array is not mutated.
 */
export function renameModel(models: readonly OllamaModelDraft[], id: string, name: string): OllamaModelDraft[] {
  return models.map(model => {
    if (model.id !== id) return model
    const next = { ...model }
    if (name === '') delete next.name
    else next.name = name
    return next
  })
}

/**
 * Set or clear one model row's default reasoning effort. An empty choice
 * deletes the field so the resolver falls back to the vendor or family
 * default.
 * @param models - the current list.
 * @param id - the row to edit; an unknown id leaves the list unchanged.
 * @param effort - the chosen level, or `''` to clear.
 * @returns a new list; the input array is not mutated.
 */
export function setModelEffort(models: readonly OllamaModelDraft[], id: string, effort: string): OllamaModelDraft[] {
  return models.map(model => {
    if (model.id !== id) return model
    if (effort === '') {
      const next = { ...model }
      delete next.defaultEffort
      return next
    }
    return { ...model, defaultEffort: effort }
  })
}

/**
 * Set or clear one model row's local context-window override. `undefined`
 * deletes the field so the model follows the endpoint again; the runtime
 * caps a stored value at the advertised window.
 * @param models - the current list.
 * @param id - the row to edit; an unknown id leaves the list unchanged.
 * @param tokens - a positive safe integer, or `undefined` to clear.
 * @returns a new list; the input array is not mutated.
 */
export function setModelContext(
  models: readonly OllamaModelDraft[],
  id: string,
  tokens: number | undefined,
): OllamaModelDraft[] {
  return models.map(model => {
    if (model.id !== id) return model
    const next = { ...model }
    if (tokens === undefined) delete next.contextOverride
    else next.contextOverride = tokens
    return next
  })
}

/**
 * Parse the context input's text. Only a positive safe integer is a value;
 * an empty string clears the override.
 * @param text - what the user typed.
 * @returns the number, `undefined` for blank, or `null` for text to reject.
 */
export function parseContextInput(text: string): number | undefined | null {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Models the user unticked in this dialog, kept by id so a re-tick restores them. */
export type OllamaStash = ReadonlyMap<string, OllamaModelDraft>

/**
 * Untick one model: drop it from the list and keep its full row (display
 * name, default effort, context, ...) in the stash so ticking it again is
 * lossless, even when the cloud listing no longer carries the id.
 * @param models - the current list.
 * @param stash - the stash before this untick.
 * @param id - the row to untick; an absent id changes nothing.
 * @returns the new list and stash; neither input is mutated.
 */
export function untickModel(
  models: readonly OllamaModelDraft[],
  stash: OllamaStash,
  id: string,
): { models: OllamaModelDraft[]; stash: OllamaStash } {
  const row = models.find(model => model.id === id)
  if (row === undefined) return { models: [...models], stash }
  return { models: removeModel(models, id), stash: new Map(stash).set(id, row) }
}

/**
 * Tick one model: restore its stashed row when this dialog unticked it,
 * otherwise adopt it from the fetched candidates (which never copies the
 * vendor default effort). A model already in the list, or unknown to both
 * sources, leaves the list unchanged.
 * @param models - the current list.
 * @param stash - rows unticked earlier in this dialog.
 * @param candidates - the cloud list as fetched.
 * @param id - the row to tick.
 * @returns a new list and the stash without the restored row.
 */
export function tickModel(
  models: readonly OllamaModelDraft[],
  stash: OllamaStash,
  candidates: readonly OllamaCloudCandidate[],
  id: string,
): { models: OllamaModelDraft[]; stash: OllamaStash } {
  if (models.some(model => model.id === id)) return { models: [...models], stash }
  const stashed = stash.get(id)
  if (stashed === undefined) return { models: adoptCandidates(models, candidates, [id]), stash }
  const next = new Map(stash)
  next.delete(id)
  return { models: [...models, stashed], stash: next }
}

/**
 * Tick every listed id in order. Rows already in the list stay where they
 * are; restored and adopted rows append in the given order.
 * @param models - the current list.
 * @param stash - rows unticked earlier in this dialog.
 * @param candidates - the cloud list as fetched.
 * @param ids - the ids to tick, typically the filtered view.
 * @returns the new list and stash; neither input is mutated.
 */
export function tickModels(
  models: readonly OllamaModelDraft[],
  stash: OllamaStash,
  candidates: readonly OllamaCloudCandidate[],
  ids: readonly string[],
): { models: OllamaModelDraft[]; stash: OllamaStash } {
  let state = { models: [...models], stash }
  for (const id of ids) state = tickModel(state.models, state.stash, candidates, id)
  return state
}

/**
 * Untick every listed id, stashing each removed row. Ids outside the list,
 * such as filtered-out rows, are untouched.
 * @param models - the current list.
 * @param stash - the stash before this untick.
 * @param ids - the ids to untick, typically the filtered view.
 * @returns the new list and stash; neither input is mutated.
 */
export function untickModels(
  models: readonly OllamaModelDraft[],
  stash: OllamaStash,
  ids: readonly string[],
): { models: OllamaModelDraft[]; stash: OllamaStash } {
  let state = { models: [...models], stash }
  for (const id of ids) state = untickModel(state.models, state.stash, id)
  return state
}

/** One effort choice shown in a row's selector. */
export interface EffortOption { id: string; name: string; unavailable?: boolean }

/**
 * The effort choices for one ticked row. The row's own `efforts` decide the
 * ids because the store rejects a default outside them, so the selector must
 * never offer anything else. A snapshot of the endpoint (`labels`) may only
 * supply friendlier names for the same ids. A saved default the list no
 * longer contains is kept visible and marked unavailable instead of
 * silently reading as "follow the provider".
 * @param row - the draft row.
 * @param fetched - efforts from this dialog's latest fetch, when it returned the row.
 * @param labels - the opened dialog's snapshot of named efforts for the id.
 * @returns the options in picker order.
 */
export function effortOptions(
  row: OllamaModelDraft,
  fetched: readonly string[] | undefined,
  labels: readonly { id: string; name: string }[] | undefined,
): EffortOption[] {
  const ids = row.efforts ?? fetched ?? labels?.map(entry => entry.id) ?? []
  const options: EffortOption[] = ids.map(id => ({ id, name: labels?.find(entry => entry.id === id)?.name ?? id }))
  if (row.defaultEffort !== undefined && !ids.includes(row.defaultEffort)) {
    options.push({ id: row.defaultEffort, name: row.defaultEffort, unavailable: true })
  }
  return options
}
