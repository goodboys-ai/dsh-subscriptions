import type { SubagentSpeedTier } from '../provider-settings.js'
import type { AccountCatalogRow } from './account-preferences.js'

/** What the model editor shows for the current filter state. */
export type ModelListState = 'provider-empty' | 'filter-empty' | 'rows'

/** Distinguish an empty provider from a query that filtered out every row. */
export function modelListState(total: number, matched: number): ModelListState {
  if (total === 0) return 'provider-empty'
  return matched === 0 ? 'filter-empty' : 'rows'
}

/**
 * Retain saved model ids when discovery returns no rows. A temporary catalog
 * failure must not hide the visibility or subagent-speed settings they edit.
 */
export function savedModelIds(
  visibleModels: readonly string[] | undefined,
  subagentSpeeds: Readonly<Record<string, SubagentSpeedTier>> | undefined,
): string[] {
  return [
    ...new Set([
      ...(visibleModels ?? []),
      ...Object.keys(subagentSpeeds ?? {}),
    ]),
  ]
}

/** Which notice replaces inert model controls. */
export type ModelEditorNotice = 'noAccount' | 'discoveryFailed' | 'noModels'

/**
 * Use account discovery evidence to explain an empty provider. Connected
 * accounts with failed discovery need a retry, not another login prompt.
 */
export function modelEditorNotice(
  accounts: readonly AccountCatalogRow[] | undefined,
): ModelEditorNotice {
  // Account-neutral editors such as Cursor use the neutral empty-catalog copy.
  if (accounts === undefined) return 'noModels'
  if (accounts.length === 0) return 'noAccount'
  return accounts.every((account) => account.unavailable === true)
    ? 'discoveryFailed'
    : 'noModels'
}

/** Everything the component needs to choose rows or one explanatory notice. */
export interface ModelEditorState {
  listState: ModelListState
  /** Rendered only when `listState` is `provider-empty`. */
  noticeKey: (typeof NOTICE_KEYS)[ModelEditorNotice]
}

/** Locale keys for the three empty states. */
export const NOTICE_KEYS = {
  noAccount: 'modelDefaultsNoAccount',
  discoveryFailed: 'modelDefaultsDiscoveryFailed',
  noModels: 'modelDefaultsNoModels',
} as const

/** Combine discovered and saved rows, filter results, and discovery evidence. */
export function modelEditorState(input: {
  discovered: number
  saved: number
  matched: number
  accounts: readonly AccountCatalogRow[] | undefined
}): ModelEditorState {
  return {
    listState: modelListState(input.discovered + input.saved, input.matched),
    noticeKey: NOTICE_KEYS[modelEditorNotice(input.accounts)],
  }
}
