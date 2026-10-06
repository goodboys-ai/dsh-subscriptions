# Agent Note: MiniMax percentage-only windows

Status: implemented

## Problem

The MiniMax usage UI showed only the video model's windows. The parser
required a positive `*_total_count` before it read the explicit
`*_remaining_percent`, so a window whose counts are zero was dropped whatever
its percentage said.

MiniMax's own client and its public issue tracker describe that shape as
normal for time-based plans. A standard (non-video) model returns zero counts
with `current_interval_remaining_percent` and `current_weekly_remaining_percent`
set, while the video model carries real counts. The official CLI had the same
defect for time-based plans and fixed it by taking the percentage first. A
response of that shape therefore kept `video` and lost every standard model,
and a response with only standard models failed with "no supported finite
quota windows".

## Decision

A window's used share comes from the explicit remaining percentage when it is
a finite number, scaled by `weekly_boost_permille` for the weekly window, with
no requirement on the counts. Only when no percentage exists does the legacy
rule apply: the count is the quota remaining, and a positive finite total is
required, so a zero total never produces a bar.

Everything that kept a window off the screen before still does. Status 3
(unlimited, or a model with no bucket in the plan), a boost of zero or less, a
percentage outside the valid range after scaling (including a weekly pool
boosted past 100% remaining), and a row with neither a usable percentage nor
usable counts are omitted. Start and end times are attached only when both are
valid millisecond bounds, so a window without them has no time fields. A
non-numeric percentage is not read.

The external usage card labels session and weekly rows with their model scope,
as the badge dialog and the subscription cards already did. Two models'
weekly rows would otherwise read the same. The monthly pool, which is a scope
on an `other` window, keeps its label, and windows without a scope keep theirs.
The card is shared, so a Kimi limit that carries a `name` now shows it too
("5-hour window · Coding"), matching the dialog, where it was already shown.

The order stays the API's. The pill shows the first two windows and the dialog
previews four, so the order decides what the pill shows. No ordering rule was
added because nothing establishes which model a user cares about, and the pill
already follows the account's own list.

## Evidence and what it does not show

Sources are the [CLI quota table renderer](https://raw.githubusercontent.com/MiniMax-AI/cli/main/src/output/quota-table.ts)
and its [test fixtures](https://raw.githubusercontent.com/MiniMax-AI/cli/main/test/output/quota-table.test.ts),
the [quota type definitions](https://raw.githubusercontent.com/MiniMax-AI/cli/main/src/types/api.ts),
[CLI issue 165](https://github.com/MiniMax-AI/cli/issues/165) (zero counts with
percentages on time-based plans, fixed in the CLI), and the
[M Plan usage rules](https://platform.minimax.io/docs/m-plan/usage-rules.md),
which give non-video models a five-hour and a weekly window and video only a
weekly one.

Tests use bodies shaped after those fixtures. They prove how this parser maps
that shape. They do not prove what any account's endpoint returns, and no live
response was used. Whether a given user's standard model arrives in this shape,
or is absent because the account or plan does not include it, cannot be
determined from the code.

## Alternatives considered

**Derive counts from the percentage.** This would let the old guard stay. It
invents counts the API did not send, and MiniMax's own CLI states the same
objection in its tests ("without deriving counts from percent").

**Reject percentage-only windows unless the status is 1.** This looks safer
but also hides the case MiniMax reports as exhausted (status 2 with 0%
remaining), which is the one a user most needs to see.

**Show boosted weekly pools above 100%.** The CLI renders up to 150%, but the
documentation does not say whether the multiplier is capacity or extra quota,
and the meter has no way to draw above 100%. These windows stay omitted until a
non-percentage presentation exists.

**Sort standard models first.** This would make the pill show the standard
model whenever the API lists video first. It rests on a guess about relative
importance and on API ordering nobody has documented; revisit it if a real
response shows video listed first.

**Add a notice when windows are omitted.** This would explain a missing model,
but it is new UI and copy for a case no evidence shows to be common.

## Consequences

Accounts whose standard models report percentages with zero counts now show
those models, with the five-hour window's start and end and so a time cursor.
A model the plan does not include is reported with status 3 on both windows
and zero totals (the CLI's own "not in plan" test), so it stays absent: the
plugin does not turn "no bucket" into a bar.

Two limits remain.

- The CLI's own fixture for an in-plan standard model has zero counts, a
  percentage and no `*_status` field at all. A row for a model outside the plan
  that also omits `*_status` would look the same and would be shown with its
  percentage. The CLI draws it the same way; no status-less not-in-plan
  response has been reported.
- A user-filed issue on MiniMax's tracker reports a zero-count response whose
  remaining percentage stayed frozen while `remains_time` kept counting down.
  MiniMax has not confirmed it. The percentage is now trusted exactly where
  counts cannot corroborate it, and the plugin does not detect that case, so
  such a reading would be shown as reported.

The CN host `www.minimax.cn` also has no documentation beside the global
host's. That is unchanged here.
