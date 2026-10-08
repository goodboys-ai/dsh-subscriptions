# Changelog

## v0.1.3 — 2026-10-08

- Usage bars keep their elapsed-time cursor whenever the provider's timing
  places the current window, including at 0% used, after a failed refresh, and
  for stale or unobserved readings. Only a current reading drives the pace
  warning; an ended, future-starting, or reset-only window still shows no
  cursor, and an unusable percentage still shows no fill.
- MiniMax standard (non-video) quotas that report a remaining percentage
  beside zero counts appear again next to the count-backed video quotas.
  Settings rows and the badge keep the model name, and status 2 without a
  usable reading no longer implies an exhausted bar.
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
