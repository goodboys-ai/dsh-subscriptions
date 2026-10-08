# Replay and SSE correctness port verification

## Baseline and scope

The port branch is `fix/port-replay-sse-lifecycle`, based on integration
commit `48a4bd8` from `port/upstream-sync-2026-10`, not `origin/main`.
The upstream reference is `85e6c6c`; the sliced commit is
`c5cc37fe7ac431dd3dad0821857573b5ac1e7d5b`.

Only these correctness hunks were retained:

- `src/translate/sse.ts`: await `reader.cancel()` before releasing the lock
  in `finally`; cancellation errors cannot replace the stream outcome.
  Framing and parsing remain byte-for-byte unchanged outside `finally`.
- `src/providers/replay.ts`: retain upstream's complete replay-envelope
  algorithm. Its SHA-256 key binds provider, concrete account and concrete
  model. Matching envelopes unwrap into concrete source metadata; mismatched
  or unsupported envelopes lose replay only in the request copy. Finish
  chunks wrap opaque provider replay. Durable history is not mutated.
- `src/providers/account-preferences.ts`: use that helper for independent
  and direct fallback streams, without changing route selection.
- `src/providers/pool.ts`: use the helper for each concrete member attempt,
  without changing selection, health, usage, retry or failover behavior.
- `src/providers/copilot.ts`: identity-free requests have no replay scope;
  capture and lookup skip undefined scopes. Session and first-message-id
  scopes continue to isolate account, conversation and model.

The requested upstream inspection found no `c5cc37f` hunks in
`src/providers/accounts.ts` or `src/translate/responses.ts`. Their existing
seams already support the port; neither file changed.

## Compatibility and omitted hunks

The implementation uses the existing `stream`/`streamAccount` interfaces at
our `0.1.7-rc.2` development floor. No public API, route identity, account
preference or capability-resolution behavior changed. Provider-private
`replayState.response` now contains the upstream account envelope; callers
must continue treating it as opaque. Same-account/model replay remains
available behind public aliases instead of being lost during translation.
Switching accounts or models excludes newly captured private replay rather
than reusing the previous account's signed request prefix.

The following upstream changes were deliberately omitted:

- Release/version, README, dependency, lockfile, peer-range and matrix
  changes: the fork deliberately retains its compatibility-window floor.
- `PreparedAdapterCall`, prepared account/member binding, provider-info and
  retry-policy forwarding: these change host/routing contracts beyond the
  requested replay slice and require newer APIs.
- `withAbortSignal` and its catalog/discovery/routing call sites: they harden
  cancellation of shared catalog waits, not replay identity. The replay
  helper needs no abort shim; existing stream signals still pass through.
- Leading-usage buffering, terminal-error failover and pre-attempt cleanup
  changes in the pool: independent retry/failover behavior, not replay.
- Codex routing, compatibility shims, resolved/offloaded-image handling,
  Antigravity tool-error translation and unrelated test/release mechanics:
  outside the two requested correctness slices.
- Auth RPC, client and registration changes: explicitly out of scope.

No provider usage/reset logic or host E2E was changed or run. No live
provider/account access, dependency install, push, tag, PR or subagent was
used. Repository commands and generated build/test output stayed in the
port worktree after its requested creation.

## Evidence adaptation

The upstream `test/sse-lifecycle.spec.ts` retains all four cases and all
assertions. The upstream `test/account-replay.spec.ts` keeps the real
`LlmRuntime` entry path, fake account adapter, Antigravity translation and
both independent/pool modes. All upstream imports exist at the fork floor;
no replacement import or compatibility helper was needed.

Replay evidence adds direct fallback routing, model changes behind a stable
pool alias, unsupported envelope versions, returning to the original scope
and explicit legacy compatibility. The upstream Copilot identity-free
regression was also retained using our existing helpers and tool history.

The account-preferences fixture previously cast a request without required
`messages` to `GenerateOptions`. Its helper now supplies `messages: []` and
uses a checked return type. No assertion was weakened and production does
not accept incomplete requests just to satisfy that fixture.

## Red/green verification

The new upstream specs and the direct/Copilot regressions were compiled and
run before any source edits, against unchanged integration source. No stash,
external scratch checkout or source reversal was necessary.

Actual pre-port output (long assertion prefix wrapped for readability):

```text
Adapted pre-port specs exit: 1
AssertionError [ERR_ASSERTION]: same route must preserve signed thinking
AssertionError [ERR_ASSERTION]:
different account must not inherit private replay
true !== false
SSE consumer-return cancels the unread response body
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
0 !== 1
SSE provider-finish cancels the unread response body
0 !== 1
SSE malformed cancels the unread response body
0 !== 1
Copilot pre-port exit: 1
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ [
+   'PRIVATE'
+ ]
- []
```

Independent and pool routes failed the upstream same-route preservation
assertion because alias source metadata never became concrete-model
metadata. The additional direct case exposed actual cross-account replay.
Each SSE case failed because the unread body was never cancelled. Copilot
reused private reasoning across requests without conversation identity.

After the source port, targeted account replay, SSE lifecycle and Copilot
specs reported:

```text
Final focused regressions and build exit: 0
ℹ tests 45
ℹ pass 45
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

The full requested `pnpm test` run reported:

```text
Full pnpm test exit: 0
ℹ tests 750
ℹ pass 750
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

A separate hermetic run of `usage-pace`, `usage-cursor-providers`,
`minimax-usage`, `reset-redemption`, `pool-usage` and `claude-cache-ttl`
reported 65 tests, 65 passes and zero failures, cancellations or skips.

The requested `pnpm build` reported:

```text
> tsc && tsdown
ℹ tsdown v0.15.12 powered by rolldown v1.0.0-beta.45
✔ [dsh-subscriptions/client] Build complete in 72ms
```

`git diff --check` passed. Protected manifests, version matrix, entrypoint,
auth RPC, client sources and provider usage/reset sources were unchanged.
Raw logs remain locally in ignored `reports/replay-sse-lifecycle/`.

## Maintainer decision: legacy replay

Newly captured replay is strictly bound to the originating provider,
account and model. Legacy unwrapped replay has no originating-account
identity. As upstream does, this port passes it through when its provider
and model match the concrete route, and strips it for mismatching routes.
The code comment and a compatibility test make that limitation explicit.

If a user switches accounts mid-session and the provider/model match, the
previous account's signed request prefix can still be reused from legacy
history. Absolute account isolation cannot be claimed for these histories.

Maintainers must decide whether a separate change should fail closed on all
legacy replay. That would discard replay from existing direct histories,
including legitimate same-account continuations, and can lose signed
reasoning continuity users currently retain. This port deliberately
preserves upstream behavior rather than silently making that tradeoff.
