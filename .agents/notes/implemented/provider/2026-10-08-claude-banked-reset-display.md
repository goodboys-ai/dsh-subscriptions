# Agent Note: Claude banked reset display

Status: implemented

## Problem

Claude's OAuth usage payload can include banked limit-reset grants
(`cedar_ember`). A reader who already uses the Codex disclosure should
recognize the same place and shape. The grant's `resets_at` is an
expiration, and the redemption endpoint is undocumented, so a control that
looks clickable would offer an action this page cannot perform.

## Decision

Claude reuses the Codex closed disclosure. The server sends one row per
grant, not one row per remaining credit, and omits `resetCredits` when the
account is ineligible or the grant list is empty. The client therefore does
not render an empty disclosure.

The summary count is the sum of `resetsLeft` on grants that are neither
expired nor paused, including a grant that is cooling down. It is not
`resetCredits.length`. Each row names its state in text: available, not yet
usable, paused, exhausted, or expired. A future `cooldownUntil`, or
`usableNow: false`, is not yet usable. `expiresAt` is rendered as an expiry
and is not passed to the elapsed-time cursor.

`claimable` stays metadata. The closed summary says the list is read-only,
and each row is a text line with `cursor: default`, no button, and no
button role, even when `claimable` is true. A failed optional lookup uses
a fixed translated sentence and does not interpolate provider text.

The owning view is
[reset-credits-view.tsx](../../../../src/client/reset-credits-view.tsx).
Codex redemption remains the separate decision in
[Codex manual reset redemption](2026-10-04-codex-manual-reset.md).

## Alternatives considered

**Copy the Codex Use button and disable it.** A disabled button still
reads as a write action, and Claude has no redemption call to attach. The
shipped row has no button.

**Expand each grant into one row per remaining credit.** That matches a
third-party display whose array length is a credit count. This server keeps
one row per grant, so expanding would invent rows the payload does not
contain.

**Show an empty disclosure when the list is absent.** The data side already
omits the list for an ineligible account. An empty row would describe a
case the server does not send.

## Consequences

The page can show that a grant exists and why it cannot be used, and it
cannot spend one. A cooling grant still adds its `resetsLeft` to the
summary, so the summary can say resets are available while the row says
they are not yet usable. The row is the state; the summary is the remaining
count under the rule above.

Offline rendering covers eligible, ineligible, cooldown, expired, paused,
exhausted, and error states in English and Chinese. It does not open the
disclosure, move focus, or check contrast in a browser. The Codex note
already records that the shared disclosure is not browser-verified. Live
provider calls are not a fixture.
