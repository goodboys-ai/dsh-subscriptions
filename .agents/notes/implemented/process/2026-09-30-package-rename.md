# Agent Note: Package rename to dsh-subscriptions

Status: implemented

## Problem

The published package name `@goodboys-ai/dsh-subscription-hub` is awkward
everywhere a user types or reads it: the install command, the plugin identity in
logs and diagnostics, and UI copy. The obvious unscoped name
`dsh-subscription-hub` was squatted on npm by an unknown third party at
publication time and later unpublished — re-registration was unavailable when we
tried (npm reserves unpublished names per its policy as we understand it; we
verified only that the name could not be registered, not the policy itself).
Staying on the scoped name is safe; it is also permanently clunky, and the
install-command friction compounds with every user.

## Decision

The npm package and the plugin identity are renamed to `dsh-subscriptions`:
`package.json` `name`, the Cordis `export const name`, the browser bundle module
ID, the `cordis.patch.yml` insert entry, log prefixes, and the canonical install
command (`dsh plugin --profile web add dsh-subscriptions`). The GitHub
repository slug `goodboys-ai/dsh-subscription-hub` is unchanged — GitHub
installs, the trusted-publisher repo binding, and all repo URLs keep working.
(Update 2026-10-01: the repository was subsequently renamed to
`goodboys-ai/dsh-subscriptions`; the old slug redirects indefinitely, and the
npm trusted publisher was registered against the new slug. The bootstrap below
was completed the same day: manual first publish of `dsh-subscriptions@0.1.0`,
trusted-publisher registration, and deprecation of the scoped package.) The
`v0.1.0` release stays published under the scoped name as history; the rename
repeats the npm bootstrap for the new name (one manual publish, then
trusted-publisher re-registration, per
[2026-09-30-npm-trusted-publishing.md](2026-09-30-npm-trusted-publishing.md)),
and the scoped package is deprecated with a pointer once the new name's first
publish succeeds. Installing both packages side by side registers the same
adapters twice and breaks plugin load, so the docs tell users to remove the old
package first.

## Alternatives considered

- **Keep the scoped name.** Zero migration risk, but the install and diagnostic
  friction is permanent, and every release cements the awkward name further. The
  rename cost is one bootstrap plus one deprecation — small while the package
  has ~zero users.
- **Attempt to recover the unscoped `dsh-subscription-hub`.** Observed
  unavailable after the squatter's unpublish; the reservation policy itself was
  not independently verified. Not an option, recorded so nobody re-investigates.
- **Rename the GitHub repo to match.** Breaks every existing clone, the
  trusted-publisher binding, and the `github:` install refs for no user benefit;
  the repo slug is not user-typed the way the package name is.

## Consequences

The maintainer owes a second manual bootstrap (first publish + trusted publisher
registration) for `dsh-subscriptions`, and the scoped package must be deprecated
after the new name's first publish. `v0.1.0` is orphaned under the old name —
acceptable with ~zero users, and the GitHub source install path covers anyone
who pinned it. The rename sweeps every identity surface at once (the #19 F1
lesson: a partial rename that leaves `cordis.patch.yml` `insert.name`, the
bundle ID, or the boot-smoke grep patterns pointing at the old name breaks
plugin load in ways CI catches only when the sweep is complete);
`test/package-identity.spec.ts` pins the chain so a future partial rename fails
the gate.
