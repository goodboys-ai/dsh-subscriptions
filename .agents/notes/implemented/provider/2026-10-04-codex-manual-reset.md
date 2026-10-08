# Agent Note: Codex manual reset redemption

Status: implemented

## Problem

Codex exposes banked full-reset credits through a private ChatGPT endpoint.
A reset consumes a credit; losing the response does not prove that nothing
happened. Retrying an ambiguous submission can consume another credit.

## Decision

Reset lookup is optional: its failure is shown in Settings without dropping
ordinary usage. Redemption requires an explicit user action and an acknowledged
native confirmation dialog. The server reads fresh usage before preparing a
60-second, account-bound, single-use ticket and again before submitting it.
Only an unscoped weekly window at or above 80%, with a future reset time, is
eligible. The earliest-expiring available credit with an ID is selected;
expired credits are never submitted.

The redemption service marks the account uncertain before its single consume
POST and clears that mark only after a confirmed reset response. A timeout,
transport failure, or unexpected response leaves it blocked. This is a
process-local guard against immediate blind retries, not a durable rate limit.
Restarting the host clears it. Operators must verify credits and limits in
Codex before retrying, rather than restart to bypass the guard: a lost success
response may already have spent one credit, and a second submission may spend
another. Fresh preparation does not establish whether the earlier submission
succeeded.

This preserves the guard and limitation of upstream `b0c6220`. Upstream has no
Agent Note for this decision in its notes tree. The owning implementation is
[ResetRedemption](../../../../src/providers/reset-redemption.ts).

## Alternatives considered

**Display only.** The first upstream implementation exposed availability and
expiry without spending credits. The final upstream implementation permits
manual redemption, with confirmation and independent server checks.

**Automatic or blind retry.** Retrying after an uncertain response could spend
a second credit. The final upstream implementation intentionally submits once
and parks the account rather than treating ambiguity as failure without a
side effect.

## Consequences

Tickets and uncertain-account blocks last only for the current host process.
There is no automatic retry, automatic redemption, or in-app undo. Cache
invalidation and a forced usage refresh follow the redemption attempt; lookup
errors remain visible. Reset-credit discovery also adds an optional request to
Codex usage polling.

Offline tests cover eligibility, expiry, account binding, alias identity,
selected-credit revalidation, concurrency, uncertain outcomes, exact consume
request shape, and the Settings RPC entry path.

Two follow-on fixes from review changed the concurrency around this flow.
`prepare` now re-checks the pending and uncertain marks after its read, so a
confirmation cannot be minted while another client's submission is parked as
uncertain. The usage cache no longer lets a request that an `invalidate`
abandoned overwrite a newer result, whether that older request settles with a
value or with a failure. The client-side forced refresh after a redemption now
waits out an in-flight poll instead of being dropped behind it; without that,
the card could keep showing the pre-redemption percentage next to a success
message until the next automatic poll.

What is NOT covered: that forced-refresh sequencing has no unit test. It lives
in a React effect, so server rendering never runs it, and this repo has no
component harness that mounts the section against a stub connection. It rests
on the host E2E and on review, not on a fast test; a regression there would show
up as a stale card, not a failing suite.

What is NOT covered: the private endpoint's live contract, and the native
confirmation dialog's focus, Escape and cancel behavior, plus the collapsible
disclosure, in a real browser. The host E2E plans the reset-credits request so
the plugin loads, but asserts no redemption interaction; those UI behaviors
remain unverified and must be checked by hand before release. Live providers are
not verification fixtures either way.
