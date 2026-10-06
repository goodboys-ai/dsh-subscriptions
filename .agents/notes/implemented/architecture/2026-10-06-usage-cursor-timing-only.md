# Agent Note: Usage cursor depends on timing only

Status: implemented

## Problem

The elapsed-time cursor disappeared whenever a reading was stale: after a
failed refresh, after five minutes, with no observation time, or with an
unusable percentage. The window's start, end and fixed duration had not
changed, so the cursor's place in time was still known. Its disappearance
looked like a provider that sometimes lacks a cursor, and it removed the one
cue that does not age.

The cursor was tied to freshness because freshness protects the pace warning.
Yellow compares a percentage read in the past with a clock read now. That
comparison needs a current reading. Where the window stands in time does not.

## Decision

`UsageMeter` computes the cursor from the window's own timing alone, through
`elapsedPercent`. The percentage, `stale`, `observedAt` and the percentage's
validity do not enter. It is drawn at 0% used, for a stale or old reading, and
for an unusable percentage whose interval is known. It is absent when the
timing cannot place it: no reset, a reset in the past, a start in the future,
or a reset with neither a start nor a provider-verified fixed duration.

Freshness still gates comparison. Yellow, the "ahead of pace" summary and the
ahead/behind points use the cursor only for a fresh reading. A stale or old
reading keeps its absolute green or red color and its stale label, and its
tooltip states time elapsed without comparing it with the old percentage.
Near exhaustion is red whatever the freshness, as before.

No provider gains timing. Antigravity reports a reset only. Kimi's five-hour
limit has unverified rolling semantics. OpenCode Go's monthly window is
anchored to the subscription date. Grok and Cursor show no cursor when the
response omits the period start. These stay without a cursor because the
provider has not said where the window began, not because of their percentage.

## Alternatives considered

**Keep hiding the cursor on stale readings.** This was the earlier behavior.
It treats a cursor as a claim about the reading, which it is not, and it makes
the cursor vanish on a rate-limited refresh when the timing is unchanged.

**Show the cursor but keep the ahead/behind text for stale readings.** This
would keep the tooltip uniform. It would also compare an old percentage with
today's clock, the comparison the freshness rule exists to prevent.

**Infer a start for providers that report only a reset.** This would give
every provider a cursor. It would also invent a start from a window's label,
which the earlier decision rejected, and it would be wrong for the first-use
and subscription-anchored windows above.

**Tolerate small clock skew when the start is in the future.** A window that
just began and a browser clock a few seconds behind the provider produce a
start after now, and the cursor is dropped. OpenCode Go's idle rolling window
is the concrete case: its reset is the gateway's clock plus the window, so for
a five-hour window the derived start is the gateway's time of the request. A
browser clock that trails the gateway by more than the time since that request
hides the cursor at 0%. A tolerance would still be a guess. Nobody has measured
the skew, and a start in the future can also describe a window that has not
begun. It is left out; a measured case can add it.

## Consequences

A provider that reports its window keeps a cursor through failed refreshes and
at 0%, so presence says only that the timing is known. A stale reading shows a
cursor beside a stale label, so a reader can see that the numbers are old and
the cursor is current.

One case can mislead, and one provider is known to produce it. OpenCode's
public gateway source reports an idle rolling window as 0% with a reset of the
request time plus the whole configured window. The plugin treats that window as
five hours, so the cursor sits at the start of a window that has not begun. A
fresh reading shows that start, as it did before this change. An old reading
keeps advancing the cursor along a window that may still be idle. Its reset
countdown was already stale in the same way, and the stale label and the lack
of any pace warning limit the harm. Telling an idle window from one just
started would need a guess about clock skew, which is left out; a measured case
would justify withholding the cursor for an unused reading of that window.
Whether other providers answer an idle window this way is unobserved.

Verification used parsers fed bodies shaped after each provider's public
schema and the real `UsageMeter`, rendered to markup and in Chrome. It did not
use a live account, so which real responses lack timing at 0% is unconfirmed.
