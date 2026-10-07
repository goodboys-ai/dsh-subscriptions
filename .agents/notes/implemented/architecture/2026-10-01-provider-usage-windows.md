# Agent Note: Provider usage windows

Status: implemented

## Problem

Claude and Codex quota bars lacked elapsed markers despite known reset windows.
Dark neutral fills were almost invisible. External Kimi parsing also differed
from its official CLI, and MiniMax subscription usage was absent.

## Decision

Keep absolute green/red fills when timing is unknown or readings are stale.
Only fresh reliable intervals enable yellow warnings. Elapsed markers need
only the window's own timing; see the
[cursor note](2026-10-06-usage-cursor-timing-only.md).
Invalid percentages never receive a fabricated fill.

Codex uses its reported duration with reset. Claude session and weekly buckets
supply five-hour and seven-day durations in both supported response shapes.
OpenCode Go's five-hour counter is first-use anchored; weekly resets at UTC
Monday. Its monthly window is a subscription-anchored calendar month, so reset
alone does not establish the start and must not be treated as thirty days.

Kimi reads the official CLI's `usage` and `limits[].detail/window` count schema
while retaining legacy ratio compatibility. Summary labels do not prove a weekly
period. Only explicit seven-day limits or legacy weekly pools assert a fixed
window. Five-hour rolling semantics remain unverified; no fixed start is
invented. New plans need not expose weekly pools.

MiniMax adds global and China usage-only sources using DSH's conventional
`MINIMAX_API_KEY` and `MINIMAX_CN_API_KEY` credential references. Configuring a
subscription key in the host model settings therefore requires no second key.
Usage-only integrations reuse the host's credential references rather than
introducing a parallel configuration. Key presence means configured, not that
subscription quota is available; key type and the quota response determine
support. Finite quotas preserve model scope and API millisecond bounds.
Explicit remaining percentages win and need no counts; absent percentages use
the official CLI's legacy remaining-count convention, which does need a
positive total (see the
[percentage-only note](../provider/2026-10-06-minimax-percentage-only-windows.md)).
Unlimited and boosted-above-100% pools
are omitted rather than forced into finite bars. HTTP and business errors fail
without exposing keys. Pay-as-you-go keys are not subscription credentials.

## Sources

- [OpenCode quota implementation](https://github.com/anomalyco/opencode/blob/dev/packages/console/core/src/subscription.ts)
- [OpenCode date boundaries](https://github.com/anomalyco/opencode/blob/dev/packages/console/core/src/util/date.ts)
- [Kimi membership](https://www.kimi.com/code/docs/en/kimi-code/membership)
- [Kimi CLI usage parser](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/ui/shell/usage.py)
- [MiniMax quota schema](https://github.com/MiniMax-AI/cli/blob/main/src/types/api.ts)
- [MiniMax compatibility resolver](https://github.com/MiniMax-AI/cli/blob/main/src/utils/quota.ts)
- [MiniMax reset rules](https://platform.minimax.io/docs/m-plan/usage-rules.md)

## Verification and limits

Adapter tests exercise fixed-window metadata through elapsed percentage and
color classification, not only object shape. Kimi tests cover official counts,
remaining values and uncertain summary timing. MiniMax tests cover millisecond
bounds, explicit percentages with and without counts, legacy counts, region
routing and error states.
No real account credentials or live quota responses were used. Official source
fixtures prove parsing, not deployment parity or each account's plan semantics.

## Alternatives considered

**Gray fallback.** Rejected after actual dark-mode usage showed valid quota
fills nearly disappearing into the track. Stale labels retain the caveat.

**Infer every period from its label.** Rejected because monthly calendar bounds
are ambiguous and Kimi rolling semantics are not established by a label.

**Separate subscription credential references.** Rejected because DSH model
settings save keys under the conventional provider references; inventing
`*_SUBSCRIPTION_API_KEY` names leaves already configured subscriptions
undetected and requires users to configure the same key twice.

**Use ordinary MiniMax inference keys.** Rejected because the official client
routes pay-as-you-go keys to balance queries, not subscription quota endpoints.

## Consequences

The UI remains visible without guessing calendar-month boundaries. MiniMax is
usage-only and does not register models or add an OAuth login. Unsupported
unlimited or boosted pools need a richer non-percentage UI before they can be
shown accurately. Kimi five-hour markers require stronger reset evidence.
