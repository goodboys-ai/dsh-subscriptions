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
  headers, signal and CLI-version resolver. The `claude-cli/<version>
  (external, cli)` User-Agent the adapter already sends is what makes
  Anthropic report grants at all, so no header changed.
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
count is the **sum of `resetsLeft`**, never the length of the list — a single
grant may carry several resets. A grant with `resetsLeft === 0` is exhausted.

## What is not verified

- That Anthropic currently reports `eligible: true` for real accounts, that
  the `cedar_ember` program is rolled out, or that the response matches the
  shape above.
- Any redemption behavior.
- Rendering in a real browser.

The suite proves how this parser maps the documented shape. It does not prove
what any account's endpoint returns.

## Related

The Codex reset-credit port is recorded in
[2026-10-04-codex-manual-reset.md](2026-10-04-codex-manual-reset.md). The
upstream-port ledger is [docs/upstream-ports.json](../../upstream-ports.json);
this feature is a fork addition rather than an upstream port, so it has no
ledger entry.