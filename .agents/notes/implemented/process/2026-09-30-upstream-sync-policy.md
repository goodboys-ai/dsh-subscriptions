# Agent Note: Upstream sync policy

Status: implemented

## Problem

This plugin is a downstream derivation of `V1ki/dsh-plugin-subscriptions` and
shares its provider protocol, auth store, and usage-accounting surface — areas
upstream keeps fixing. The fork also rewrote whole subsystems (the settings UI,
the RPC surface, network routing), so neither "merge upstream wholesale" nor
"ignore upstream" is viable. Without a recorded baseline and a repeatable
procedure, every sync attempt re-derives the fork point from scratch and
silently drifts: fixes land twice or not at all, and nobody can say which
upstream tag the shipped code corresponds to.

## Decision

Syncs run **git-native against upstream tags**. This repo's history contains
every upstream commit through `v0.9.5` (`75a8346`) as a literal ancestor — the
repo was derived from a full upstream clone — so `git fetch upstream --tags`
plus `git log <baseline>..<new-tag>` enumerates the exact delta, and
`git merge-base --is-ancestor` verifies any claim that a commit is already
shipped. Each commit in the delta is then either cherry-picked (files intact on
both sides) or re-implemented (files the fork rewrote; only the intent ports).
The baseline, the ported commits, and the deliberately skipped ones are recorded
in [docs/upstream-sync.md](../../../../docs/upstream-sync.md), which is updated
in the same PR as the port. The first port under this policy is upstream
`f6e1b3f` (Settings shows the CLI version Codex and Claude present, with its
source), fixing upstream issue #108.

The upstream README snapshots in `docs/` are refreshed only when the baseline
moves; their header comment names the tag they match.

## Alternatives considered

- **Wholesale upstream merges.** Impossible in the rewritten areas: the settings
  section, RPC surface, and proxy removal conflict without end, and resolving
  them re-introduces the retired plugin proxy. Merge-only also imports
  upstream's release chores, which this repo's CI owns.
- **Vendored-snapshot model (the cursor-transport pattern).** Copying upstream
  files into `vendor/` with an origin record works for the Cursor transport
  because that code has no shared history. The plugin-level upstream shares this
  repo's commit graph, so vendoring would discard the cherry-pick path and
  re-create the drift problem it solves.
- **Stop tracking upstream.** The provider protocols (Codex, Claude, Grok,
  Copilot, Antigravity) keep changing server-side; upstream is where the
  community lands the fixes first. Untracked drift shows up as user-visible bugs
  (a failed npm lookup reading as a plan limit, an empty credential poisoning
  the store) that upstream already fixed.

## Consequences

Each upstream release costs one classification pass over
`git log <baseline>..<new-tag>` — small while the delta stays small — plus the
port work itself. The sync record in `docs/upstream-sync.md` makes the shipped
baseline auditable at any time (`git merge-base --is-ancestor` against the
recorded SHA), and the snapshots' header comments tie the README evidence to a
tag. The cost: the policy depends on the shared commit graph surviving repo
surgery (a history rewrite would break the `merge-base` checks and force a
re-baseline); and re-implemented ports need their own tests, since the upstream
test may target UI this fork replaced.
