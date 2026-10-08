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

Offline tests cover eligibility, expiry, account binding, selected-credit
revalidation, concurrency, uncertain outcomes, exact consume request shape,
and the Settings RPC entry path. They do not prove the private endpoint's live
contract or native-dialog focus and disclosure behavior in a browser. Host E2E
owns those UI checks with fake accounts; live providers are not verification
fixtures.
