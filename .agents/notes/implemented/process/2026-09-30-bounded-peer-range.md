# Agent Note: Bounded peer range

Status: implemented

## Problem

The
[2026-09-29 exact-version disjunction](../archived/process/2026-09-29-exact-peer-disjunction.md)
pins the six `@deepseek-ai/dsh-*` peers to an exact-version disjunction that the
DSH plugin manager enforces at install time. Every host RC the plugin has not
explicitly listed rejects installation for users on that version — observed
verbatim:

```text
dsh: installation rejected: Plugin dsh-subscription-hub@0.1.0 is incompatible with dsh 0.2.0-rc.1 ...
```

— even when the plugin code is already verified compatible there (the full gate
on `0.2.0-rc.1` went green on 2026-09-29, and its host surface is byte-identical
to `rc.2`). The original decision never argued for "each new RC on the same line
immediately replaces its predecessor, with no parallel period"; that behavior
fell out of the window-definition sentence, not from a considered trade-off.
Meanwhile, two mature DSH plugins in the ecosystem —
`omdsh-dev/DSH-better-sidebar` (caret `^0.2.0-rc.1`) and `ccch1mneyyy/dsh-TUI`
(a 17-version cumulative disjunction with the real compatibility contract in
`contract.ts` plus a runtime drift warning) — both follow the pattern "peers
wider than the verified set, truth recorded elsewhere, runtime/docs communicate
the gap".

## Decision

The six `@deepseek-ai/dsh-*` peerDependencies are declared as a **bounded
interval**: `>=<window floor> <(newest gated minor line + 1).0-0`, currently
`>=0.1.7-rc.2 <0.3.0-0`. The floor moves with the window floor; the ceiling
slides when a new minor line passes the gate (after `0.3.0-rc.1` gates, the
ceiling becomes `<0.4.0-0`). The ceiling must carry the `-0` suffix: under
`includePrerelease` semantics, `<0.3.0` admits `0.3.0-rc.1`, while `<0.3.0-0`
blocks the entire `0.3.0` line (verified against the `semver` package directly).

The technical premise is verified, not assumed. The DSH 0.2.0-rc.2 plugin
manager evaluates `@deepseek-ai/dsh-*` peers with
`semver.satisfies(runtimeVersion, range, { includePrerelease: true })` in
`evaluatePluginCompatibility` (dsh-app-boot), so an interval matches prerelease
runtimes. End-to-end, a packed tarball carrying the interval peers passes
`dsh plugin add` plus boot smoke on both `0.2.0-rc.1` and `0.2.0-rc.2`. The
pnpm-level missing-peer warning is inherent to the host-injection model and
appears with an exact disjunction just the same — it is unrelated to range
width.

The supported distribution path is `dsh plugin add`; a raw
`npm install dsh-subscriptions` into a consumer project is not one, and the
distinction decides whether the interval matches at all. npm's Arborist
evaluates peer ranges with default semver semantics — no `includePrerelease` —
so a prerelease host matches only when some comparator carries its exact
`major.minor.patch` tuple: `0.1.7-rc.x` installs because the floor comparator is
`>=0.1.7-rc.2`, but `0.2.0-rc.2` has no such comparator in the interval and npm
aborts with `ERESOLVE` (observed with npm 11.8.0 and 12.2.0). pnpm and the
awesome-dsh-plugins registry prover both evaluate with
`includePrerelease: true`, matching the plugin manager, so neither rejects the
install. The npm-only failure is accepted rather than patched with an extra
`|| 0.2.0-rc.x` disjunct: such a disjunct would have to be re-added per RC, and
nothing in the supported flow reads npm's verdict. If a future distribution
channel installs through npm, this paragraph is the trigger to revisit.

What "supported" means is unchanged: the set of versions in `dsh-versions.txt`
that passed the full gate (build, tests, host-export and host contract checks,
boot smoke, host E2E), which CI still runs per window version. The peer interval
is deliberately wider than the verified set: versions inside the interval but
outside the window "may work, but unsupported and at your own risk".

The window rule is revised alongside: the newest gated RC of each of the three
most recent minor lines, plus — in the newest minor line only — its immediately
preceding gated RC kept as a transition entry, capped at four versions.

Users outside the interval (below the floor, or on a new minor line) take the
experimental exemption
`dsh plugin allow-version <pkg@version> --dsh-version <exact> --accept-risk` (a
profile-level `compatibility.json` with exact-version mappings).

The nightly next-host job becomes a pure tripwire: it pre-flights unverified new
versions inside the interval daily, and a red light triggers a fast PR that
tightens the interval (lower the ceiling or add an exclusion disjunct) as the
emergency brake.

## Alternatives considered

- **Strict exact disjunction + transition window.** Promises the hardest (peers
  exactly equal the verified set), but every host RC becomes an install
  rejection plus a maintenance event, and the rejected same-line versions are
  usually verified-compatible anyway (`0.2.0-rc.1` passed the full gate and
  exposes a byte-identical plugin surface to `rc.2`) — maximal strictness for
  little extra safety.
- **Unbounded floor (`>=0.1.7-rc.2`).** Makes "unverified future minor lines
  install by default" the default promise — and 0.x host breaking changes are
  routine; the existence of `compat.ts` (the `CallId`/`ToolCallId` rename)
  proves rename-class breaks really happened. The original note's "overbroad
  promise ships broken installs" argument still holds, so the ceiling stays.
- **Cumulative exact disjunction (dsh-TUI style, add-only).** The install
  surface is exact but inflates over time, and peers no longer reflect any
  support semantics (the TUI itself admits peers are wider than its validation
  list, backstopped by a drift warning). The bounded interval expresses the same
  "allow" with two bounds while keeping the two real constraints: the floor
  (build API lower bound) and the minor-line boundary.
- **Single caret pin (better-sidebar style `^0.2.0-rc.1`).** Under
  `includePrerelease` this is equivalent to "the whole current minor line
  admitted"; same expressiveness as the bounded interval, but one caret disjunct
  per minor line degrades into multiple caret disjuncts beyond two lines — less
  direct than a single interval.

## Consequences

Maintenance events drop from "one per host RC" to "one per minor line", and
freshly-out-of-window users like `rc.1` are no longer hard-rejected. The cost:
an ungated version inside the interval (e.g. a future `0.2.1-rc.1`) installs by
default and may break. Mitigations: the nightly tripwire finds it within 24h, an
emergency-tightening PR lands fast, README and `docs/compatibility.md` state
"outside the window, at your own risk" explicitly, and (follow-up) the plugin
emits a drift warning on out-of-window hosts at startup.

This note supersedes the exact-disjunction decision in
[2026-09-29-exact-peer-disjunction.md](../archived/process/2026-09-29-exact-peer-disjunction.md);
that note's core argument — a peer declaration is an install-time-enforced
promise — still stands and is why this note keeps both bounds. The window rule
(including the transition clause) is implemented in `docs/compatibility.md` and
the `dsh-versions.txt` file header.
