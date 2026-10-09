# Changelog

## v0.1.4 — 2026-10-08

- Codex accounts can spend a banked usage-limit reset from the account card,
  and the card shows how many are left. The reset is confirmed before it is
  sent, and an ambiguous response parks the account until you check it, so a
  retry cannot spend a second credit.
- Claude accounts show their banked limit resets, with the remaining count and
  when each one lapses. This is display only: the shape comes from an
  independent implementation rather than a published contract, and spending a
  credit is irreversible, so no control is offered.
- A Claude request whose images exceed the provider limit now hands them to the
  host's compaction image offload instead of failing the turn. This fixes
  oversized-image requests that previously failed with an HTTP error.
- The model catalog no longer loses one account's models when two accounts
  save at the same time. Each save now merges onto the latest on-disk state.
- A failed account-pool member reports its own failure instead of a synthetic
  rate limit, so a revoked credential or a provider outage no longer reads as
  quota exhaustion. Genuine quota exhaustion keeps its existing message,
  recovery hint and retry behavior.
- Antigravity tool results keep their error flag on every path. A failed tool
  call whose output was JSON previously reached the model looking successful.
- Provider response text was removed from the error paths audited for this
  release: the shared HTTP and OAuth converters, the rate-limit warning, the
  two translate failure helpers and the four malformed-SSE handlers. Errors
  keep their local classification, HTTP status and recovery hint, and say that
  the provider's response body was omitted. This is deliberate: a provider can
  echo back a credential, and matching known token shapes cannot be relied on
  to catch every form. This is not yet every path — the video-generation tool,
  the device-code login failure, the OAuth callback page and the Cursor stream
  still carry provider text and are being fixed next.
- An abandoned SSE stream now cancels its body instead of leaving it unread.
  Replay captured by v0.1.4 is wrapped with concrete provider, account and model
  identity. Legacy unwrapped replay — including histories captured before
  upgrading — carries no originating-account identity, so as upstream does, it
  is still passed through when its provider and model match the concrete route:
  a same-provider, same-model account switch can reuse it. See
  [the port report](docs/replay-sse-port-verification.md) for that limit.
- Settings and the usage dialog follow the host's native controls and theme,
  including dark mode. Prompt-cache TTL is configurable, and the status-bar
  quota display can pin one provider or rotate through them.
- The repository now carries a checked ledger of what was taken from upstream,
  what was declined and why. Per-PR CI checks local ledger consistency; the separate
  scheduled/manual upstream audit checks remote commits after a successful
  fetch and reports fetch/setup failures separately from ledger findings, and
  a decline that rests on a host capability is re-verified against the published
  package, which is the specific mistake that produced this ledger.
- Live-provider gaps, not verified by this release: no live account was used to
  exercise the Codex reset endpoint or Claude's banked-reset block, so what
  those endpoints actually return remains unconfirmed. Native confirmation
  dialog focus, Escape and cancel handling, and the always-show rotation timer
  were not checked in a running browser. The Settings panel and the Claude
  reset row were checked by eye in the light and dark themes.

## v0.1.3 — 2026-10-08

- Usage bars keep their elapsed-time cursor whenever the provider's timing
  places the current window, including at 0% used, after a failed refresh, and
  for stale or unobserved readings. Only a current reading drives the pace
  warning; an ended, future-starting, or reset-only window still shows no
  cursor, and an unusable percentage still shows no fill.
- MiniMax standard (non-video) quotas that report a remaining percentage
  beside zero counts appear again next to the count-backed video quotas.
  Settings rows and the badge keep the model name, and a status-2 row without
  a usable reading does not imply an exhausted bar.
- Settings → Subscriptions → Status-bar quota display gains **Always show**,
  which rotates through the providers that report usage every 10 seconds while
  the current model has no quota source, so the pill never disappears.
- README screenshots show the current pill and dialog.

## v0.1.2 — 2026-10-02

- Usage meters show elapsed-time markers and Standard, Relaxed, or Remaining
  coloring presets. Provider timing and MiniMax usage handling were fixed.
- Built-in Codex and Copilot fallback catalogs include GPT-6-era models;
  live provider discovery remains authoritative.
- The subscription usage dialog uses the host's backdrop blur alongside its
  translucent menu fill, keeping the transcript behind it from showing sharply.
- The Plugin Manager card and the Settings plugin inventory now show a
  localized title and description (`DSH Subscriptions` / `订阅中心`) instead
  of falling back to the English package description, and the plugin card
  shows a dedicated icon.
- Live-provider canaries are optional rather than a stable-release gate;
  remaining live-provider gaps must be disclosed in release notes.

## v0.1.1 — 2026-10-01

- Settings shows the CLI version Codex and Claude present, with its source (npm latest / local CLI / built-in / configured), ported from upstream `f6e1b3f` so a failed npm lookup no longer reads as a plan limit.
- Renamed the npm package from `@goodboys-ai/dsh-subscription-hub` to `dsh-subscriptions`. Install with `dsh plugin --profile web add dsh-subscriptions`; if the old scoped package is installed, remove it first — installing both registers the same adapters twice and breaks plugin load. The GitHub repository moved to `goodboys-ai/dsh-subscriptions` (the old slug redirects); the scoped package was deprecated with a pointer to the new name.

## v0.1.0 — 2026-09-30

- First release. DSH support window and bounded peer range: see docs/compatibility.md.
- Published to npm as `@goodboys-ai/dsh-subscription-hub` (trusted publishing; prereleases on the alpha dist-tag).
