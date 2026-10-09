# Claude banked limit resets — evidence and limits

## What this feature is

Claude (Anthropic) surfaces banked limit resets — the `cedar_ember` program —
through the same OAuth usage endpoint the plugin already calls. This port makes
them visible next to Codex's reset credits.

It is **read-only on purpose**. There is no redemption call, and
`claimable` on a credit is metadata that must never render as an action.

## Why read-only

The response shape is not an Anthropic contract. It comes from one independent
implementation (ItsJazii/pane, read at
`https://raw.githubusercontent.com/ItsJazii/pane/main/src-tauri/src/providers/claude.rs`).
A single third-party reading does not authorise an irreversible write that
spends a credit: its organization scope, idempotency, and success
confirmation are all unverified. The Codex redemption port carries the same
risk, and is likewise unverified against a live account.

Adding redemption later needs recorded evidence from a real account and is its
own change.

## What the port does

- Requests `GET /api/oauth/usage?cedar_ember=1`, keeping the adapter's existing
  headers, signal and CLI-version resolver, including the existing
  `claude-cli/<version> (external, cli)` User-Agent. This port changes no
  header; whether live Anthropic responses require that identity to report
  grants is not verified.
- On **400/403** from the parameterised call, retries once without the
  parameter and keeps the plain session and weekly windows. A rejected
  optional block must never cost the user their quota. 401/429/500 keep their
  existing handling and do not retry.
- A missing, non-object, ineligible or grant-less block exposes no credits
  rather than an empty list, so the UI never renders an empty row.
- Grants are validated one by one; a malformed grant is dropped without losing
  its neighbours. Expiry parses as ISO-8601, epoch seconds, or epoch
  milliseconds.
- A grant's expiry maps to `expiresAt` only. It is never a usage-window reset
  and takes no part in the elapsed-time cursor.

## Counting

One row per grant, with the server's original grant id. The available reset
count is the **sum of `resetsLeft` on grants that are neither expired nor
paused**, never the length of the list — a single grant may carry several
resets. The parser clamps `resetsLeft` to `0…resetsTotal` and omits exhausted
grants (`resetsLeft === 0`). Non-paused, unexpired grants still contribute to
the headline while cooling down or marked not usable now; their rows disclose
that state.

## What is not verified

- That Anthropic currently reports `eligible: true` for real accounts, that
  the `cedar_ember` program is rolled out, or that the response matches the
  shape above.
- Any redemption behavior.

The Settings panel and Claude banked-reset disclosure were visually inspected from light- and dark-theme captures in a real DSH 0.2.0-rc.2 browser using frozen provider fixtures. This does not verify live Anthropic responses, other host versions, keyboard/focus/contrast behavior, or redemption (not implemented).

The suite proves how this parser maps the documented shape. It does not prove
what any account's endpoint returns.

## Related

The Codex reset-credit port is recorded in
[2026-10-04-codex-manual-reset.md](../.agents/notes/implemented/provider/2026-10-04-codex-manual-reset.md). The
upstream-port ledger is [docs/upstream-ports.json](upstream-ports.json);
this feature is a fork addition rather than an upstream port, so it has no
ledger entry.