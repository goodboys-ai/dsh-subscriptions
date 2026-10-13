# Agent Note: Local context-window override

Status: implemented

## Problem

A session plans its history and compaction against the context window its
provider reports. Codex let the user lower that number per model; Claude and
Ollama Cloud did not, so a user who wanted shorter, cheaper sessions on those
routes had no setting for it.

Copying the Codex input onto the other two routes is not enough, because the
rule for a user's value depends on where each route gets its window:

- Codex and Claude read the window from the vendor's model listing.
- Ollama Cloud reads it from `/api/show`, and the adoption dialog also
  stored that number in the model row. A stored number cannot say whether
  the user chose it or the dialog copied it, so a vendor change could never
  take effect for an adopted row, and a user's choice could not be told
  apart from a snapshot.

## Decision

The override is a ceiling on planning, never a way to claim more room. A
Codex, Claude or Ollama model plans against
`min(override ?? advertised, advertised)`. A blank override follows the
vendor, so a later vendor change reaches every model the user left alone.

**Codex.** Unchanged: `contextWindows[model]` in the provider settings,
capped at the account's `max_context_window`
(`CodexAdapter.contextLimits`).

**Claude.** The same `contextWindows` map, now accepted for `claude` by
`validatePreferences` and read with `ProviderSettingsStore.contextWindow(model,
'claude')`. Anthropic's listing carries one window and no separate maximum,
so the advertised window is both the default and the ceiling
(`ClaudeAdapter.contextLimits`). The override can only lower the window. The
shared model editor shows the same input for both providers.

**Ollama Cloud.** A new `contextOverride` field on each stored model row,
separate from `contextWindow`. `contextWindow` stays an offline snapshot of
what the endpoint advertised; `contextOverride` records only an explicit
edit and adoption never copies into it. At resolve time
`effectiveContextWindow` takes the discovered window as the ceiling and
falls back to the stored snapshot only when discovery is off or failed. The
Ollama dialog edits it in a per-row input next to the effort selector,
using the existing "Context (tokens)" strings; text that is not a positive
integer disables Save and flags the row.

The settings text states that the number controls local history and
compaction, not the API's capacity.

## Alternatives considered

**Reuse `contextWindow` for the Ollama override.** Lost: the field already
holds the adopted snapshot, so an override would be indistinguishable from
it, and the vendor default could not keep updating for rows the user never
touched. This is the same reason the default reasoning effort is stored
only when the user picks it.

**No ceiling for Ollama and Claude.** Lost: a mistyped or stale value would
plan past what the model accepts, and the request would fail at the vendor
with an error the user cannot connect to a setting. Codex already caps, and
the ceiling is free because discovery supplies it.

**Let the override raise the window above what the vendor advertises.**
Lost: it cannot add capacity the API does not have, and the Codex hint text
already promises the opposite.

**Move the Claude override into the account manager instead of the shared
editor.** Lost: the editor already renders the input per model and the
settings store is already keyed by provider, so the Claude change is a
validator and lookup change rather than a new surface.

## Consequences

All three routes now share one meaning for a blank field and one cap rule,
and Ollama keeps its vendor default live for untouched rows. The cost is a
second field on the Ollama row that readers must not confuse with the
snapshot, and a Claude override that can only go down.

An override stored while the endpoint advertised a larger window silently
shrinks the effective value when the vendor later lowers it; the input's
placeholder shows the advertised number, but only while discovery works.

## Evidence and what it does not show

`test/context-override.spec.ts` covers the cap and precedence for the
Ollama and Claude adapters, the store validators, per-provider lookup, and
per-account Claude bounds through the real adapter with a token-keyed fake
listing. `test/ollama-settings-manager.spec.ts` executes the real dialog
through the hook dispatcher in `test/component-harness.ts`: untick and
re-tick restore, Select none then Select all, the effort selector against a
stale snapshot, the context input's validation and Save gating, and the
bounds line preferring the latest fetch. Removing the stash, the
row-efforts-first selector, the latest-fetch preference for bounds, the Save
gate, or the gate's restriction to ticked rows each makes a test fail.
Writing invalid text into the draft is not caught: the gate blocks Save and
any later edit overwrites the field, so that guard is defence in depth.

All of it uses injected fetches and fixtures. No check reads a live vendor
window. The dialog is inspected as a JSX tree, so React reconciliation,
layout, focus, the native dialog and screen-reader behavior are untested,
and the pool route (smallest member window) is covered only by its existing
tests plus the per-account Claude test.
