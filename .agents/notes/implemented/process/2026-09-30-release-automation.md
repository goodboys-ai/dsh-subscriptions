# Agent Note: Tag-driven release automation

Status: implemented

## Problem

Releases were fully manual: the maintainer pushed a `v*` tag by hand, then wrote
a GitHub Release from scratch — supported DSH versions, peer range, install
command, prerelease flag — copying the same compatibility facts out of
`docs/compatibility.md` every time. Hand-copied facts drift: a release notes
page stating the wrong window is user-facing misinformation that the install
gate cannot correct. There was also no enforcement that a tag equals
`package.json` `version` or that it points at a main commit, so a mistagged or
side-branch release was one command away.

## Decision

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which auto-creates
the GitHub Release directly (no draft). The `verify` job fails unless the tag
(minus `v`) exactly equals `package.json` `version` and the tagged commit is an
ancestor of `origin/main` — releases ride the PR flow. The `gate-evidence` job
requires a `success` `CI gate` check-run on the tagged SHA via the check-runs
API: CI runs on pushes to main, so the merge commit a tag points at has its own
check-runs, and trusting them avoids re-running the per-version matrix. It also
runs a light inline sanity on the tag (`pnpm install --frozen-lockfile`,
`pnpm build`, `pnpm test`, `verify-agent-notes.mjs`, `check-compat-docs.mjs`) as
a backstop. The `release` job renders the fixed `## DSH compatibility` section
with `scripts/render-release-compat.mjs` (derived from `dsh-versions.txt` and
the shared peer range, failing on any peer disagreement), appends
`releases/generate-notes` output under it, and creates the release with title =
tag, adding `--prerelease` when the version contains `-`. A rerun guard fails
when the release already exists, since the `v*` tag ruleset (id 24254540) makes
tags immutable. The release PR also adds one terse section to `CHANGELOG.md`
before the tag is pushed; the workflow does not touch it.

## Alternatives considered

- **Fully manual releases.** Zero machinery, but every release re-derives the
  compatibility statement by hand and nothing stops a tag that mismatches the
  package version or never passed CI. The workflow removes both failure modes at
  the cost of one YAML file.
- **Draft-first releases.** A draft lets a human review the rendered notes
  before publishing, but it adds a manual step to every release and the compat
  section is mechanical — there is nothing to review that the derivation did not
  already decide. Auto-created releases keep the tag push the single human
  action.
- **Re-running the full per-version matrix on every tag.** Proves the gate on
  the exact tagged tree inside the release run, but the tagged commit is the
  merge commit CI already gated on main, so it duplicates a matrix that takes
  far longer and can flake for unrelated reasons. The check-runs query plus the
  light inline sanity covers the same tree at a fraction of the cost.
- **Auto-generated notes only, without the compat section.** Zero maintenance,
  but the notes then say nothing about DSH compatibility — the fact users most
  need before installing — and nothing keeps them aligned with the window. The
  mechanical section costs one script and never drifts.
- **npm publishing in the same workflow.** Tempting to ship in one push, but it
  needs the scoped package rename and `publishConfig` decisions that this PR
  deliberately does not make. Deferred to a follow-up PR so this one ships
  reviewable machinery only.
- **Requiring signed tags.** Provenance would be stronger, but the `v*` ruleset
  already blocks tag deletion and non-fast-forward updates, and the repo has no
  signing infrastructure today. Deferred until supply-chain requirements demand
  it.

## Consequences

A release is now: merge the version PR, wait for CI on main, push the tag. The
compat statement in every release is derived, never copied, so it cannot
contradict `dsh-versions.txt`. The cost: `gate-evidence` trusts the check-runs
API, so a tag pushed before CI finishes on main fails with a clear message and
must be retried after — tags are immutable, so the retry needs a new tag, which
the version-mismatch guard already forces. If CI ever stops running on main
pushes, the check-runs query finds no gate and the light inline sanity becomes
the only evidence; the workflow comment and this note name that dependency so
the fallback is a deliberate edit, not a surprise.
