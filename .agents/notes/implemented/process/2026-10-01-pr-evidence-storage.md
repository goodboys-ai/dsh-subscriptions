# Agent Note: PR evidence storage

Status: implemented

## Problem

PR evidence and upstream documentation have different lifetimes. The two
usage-dialog comparison stills were committed in `docs/images/` alongside the
ten upstream README screenshots, making a review artifact look like part of the
README mirror. A naming convention alone does not answer where a megabyte
recording belongs. Every clone and CI fetch pays for media in the code branch's
reachable history, even after a later commit removes it.

## Decision

PR-only still screenshots live at
`docs/assets/pr-<number>/<subject>-<state>[-<theme>].png`, in lowercase
kebab-case; `before-after` denotes a comparison. A still is evidence for a state
(appearance, layout, an A/B difference); a recording is evidence for a behavior
(a sequence, timing, a transient state). The medium follows what needs proving,
not a blanket requirement to animate every visible change.

Every bitmap under `docs/assets/pr-*/` is capped at 300 KiB (307200 bytes).
Recordings (`.gif`, `.mp4`, `.webm`, `.mov`) are rejected there regardless of
size. The cap is absolute and directory-scoped, not base-relative over the whole
repository: it needs no base ref or fetch-depth and behaves the same locally, in
CI, and after a merge. The ten upstream README screenshots in `docs/images/` are
not policed; `screenshots.json` stays a mirror of that README, not a registry
for PR evidence.

Recordings, GIFs, and oversized stills go to a media-only orphan branch named
`<series>-assets`, embedded as
`https://github.com/<owner>/<repo>/blob/<branch>/<name>?raw=true`. The branch is
append-only and never rewritten: published files are not replaced, the branch is
not deleted, and it is never force-pushed.

The two files in `docs/assets/pr-27/` are 50059 and 59407 bytes, 109466
combined, moved byte for byte out of `docs/images/` by `358c4bd` with no
re-encoding.

`scripts/check-image-budget.mjs` enforces the byte cap and recording ban in the
`repo-checks` CI job, which installs no pnpm. It uses Node built-ins and scans
PR directories recursively. Exit 0 means clean, 1 reports offending files, and 2
means the scan cannot run. `test/image-budget.spec.ts` drives the script as a
user does, through its CLI over temporary fixture roots. Nine specs cover the
exact boundary, one byte over, four recording extensions, an oversized
documentation bitmap outside the directory, and the two exit-2 roots (missing
and not a directory). These prove the scan's boundary and CLI failures, not
image validity, naming, assets publication, or the availability of a GitHub
embed; those remain review responsibilities.

## Alternatives considered

**Commit every PR medium, recordings included.** Multica keeps PR evidence in
per-PR directories and caps each bitmap at 300 KiB in
`scripts/check-image-budget.mjs`, with `docs/assets/pr-5537/` as an example.
That gives stills a cheap, reviewable home, but recordings are megabytes and
permanent in code history. This repository adopts the stills home, not the
all-media policy.

**Send every PR medium to an assets branch, stills included.**
Deepseek-harness's `.agents/skills/record-browser-gif/SKILL.md` mandates a
demonstration GIF on an orphan `<series>-assets` branch and rejects committing
it to the PR branch. That proves behavior well. Here a still proves a state, and
about 107 KiB does not justify a second publication chain, an append-only ref,
and byte re-verification by hand. The assets branch remains the escape hatch for
behavioral evidence and larger files.

**Keep screenshots in docs/images/ and only agree on a name.** That directory
means the upstream README, not PR evidence. Renaming the files still mixes
ownership and leaves “where does a megabyte GIF go?” unanswered.

**Track the budget against a git base ref.** Multica's script allows an
oversized bitmap to pass when it shrinks relative to the base. This repo's
absolute cap needs neither that exception nor a history fetch in the
`repo-checks` job; a base-relative check adds context-dependent verdicts without
strengthening the chosen rule.

**Store media with Git LFS.** Deepseek-harness's archived process note
`2026-07-26-gui-pr-gif-evidence-and-assets-branch.md` records the cost: LFS
still couples media to the code branch and adds an infrastructure dependency to
every clone and CI fetch. An orphan branch separates reachability without adding
another storage protocol.

**Attach media as a GitHub drag-and-drop upload.** The same archived note
rejects user-attachment uploads because they are unavailable to a command-line
workflow, cannot be re-derived from the repository, and leave the media's
lifecycle outside it. A named, append-only ref keeps publication under
repository control.

## Consequences

Small state evidence is reviewable with the code, while recordings and oversized
stills stay out of the default branch's reachable history. The absolute scan
gives the same answer without git history or dependencies. The split costs a
second publication workflow for assets-branch media and manual review of naming,
format choice, published bytes, and embeds.

The 300 KiB cap is per file, not a total: enough compliant stills still grow the
repository. Roughly 5 MiB of PR-only media, or a maintenance burden of pinning
media commits, reopens the question of putting all evidence on the assets
branch. Commit-pinned raw URLs depend on GitHub keeping those commits reachable;
append-only refs preserve that reachability but are another maintenance
obligation. An assets branch does not save server storage: it keeps the default
branch's reachable history clean.
