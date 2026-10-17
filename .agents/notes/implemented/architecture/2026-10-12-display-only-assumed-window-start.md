# Agent Note: Display-only assumed window start

Status: implemented

## Problem

The usage cursor needs a window's start and end. Several providers report only
the end, so their cards had no cursor. The
[cursor note](2026-10-06-usage-cursor-timing-only.md) rejected inventing a start
from a window's label, because a guessed start would feed the pace warning and
paint a false yellow. That rule left a different cost: a window whose span can
be estimated acceptably from the vendor's label or client, such as a monthly
pool or Kimi's weekly summary, never showed where it stood in time.

## Decision

A reader may attach an assumed start to a window, but only for the cursor.
`UsageWindow.displayStartsAt` holds it, separate from `startsAt` and
`fixedWindow`. The two start fields are meant to be mutually exclusive; that is
a contract documented on `UsageWindow` and honoured by these readers, not a type
or runtime check. `UsageMeter` draws the cursor from the verified position first
and from `displayStartPercent` only when that is absent. Color, the "ahead of
pace" summary and the pace comparison read verified timing alone, so an
assumption can never produce a yellow warning.

The assumed start is `min(reset − span, now)`, and a window without a reset gets
none. The spans in use:

- **Kimi declared spans.** A `limits[].window` carrying a duration and unit uses
  that span (the live plan states 300 minutes; a 7 DAY entry also keeps
  `fixedWindow`, which is separate from the marker).
- **Kimi top-level `usage` summary with no usable period.** Seven days. The
  official CLI labels this object "Weekly limit" and gives no span. The span
  rests on one live account whose summary reset matched `usages.limit_7d` within
  a second. It applies to the summary object only: an anonymous `limits[]` entry
  is "Limit #n" in the CLI and gets no assumption.
- **OpenCode Go monthly and Kimi legacy `limit_month_total`.** Thirty days,
  although the cycle follows the subscription date, so the marker is
  approximate.

## Alternatives considered

**Keep the cursor off wherever the start is unreported.** This was the earlier
rule. It kept every cursor a verified fact, and it also hid timing the reader
could estimate usefully, which is the cost this note accepts.

**Feed the assumed start to pace as well.** Lost: a wrong span would then raise
a warning about a quota the user is not overspending. The separate field exists
so the worst outcome of a wrong assumption is a misplaced marker.

**Apply the weekly assumption to every Kimi row that lacks period fields.**
Lost: the official client labels only the top-level summary, so extending it to
`limits[]` entries would add an assumption with no source.

## Consequences

More windows show a cursor, and a card shows no cursor for a window the reader
cannot place. A cursor now means "where the window stands, to the best available
span", not a verified start: if Kimi's summary is a rolling window or the
monthly cycle is not thirty days, the marker is off but no color or warning
changes. Each assumption is a literal in `src/providers/external-usage.ts`, so a
vendor that publishes the real span replaces it there.

## Evidence and what it does not show

`test/usage-cursor-providers.spec.ts` renders the real meter for each assumption
and for the cases that must stay without a cursor, including the anonymous
`limits[]` entry and a summary with no reset; `test/external-usage.spec.ts` pins
the exact start. The Kimi evidence is one account's response, read once, plus
the official CLI's source. No test or check shows how Kimi defines the summary
window, what other plans return, or that the thirty-day monthly span matches any
subscription.
