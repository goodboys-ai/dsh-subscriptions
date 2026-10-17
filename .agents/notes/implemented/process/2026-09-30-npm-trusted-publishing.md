# Agent Note: npm trusted publishing

Status: implemented

## Problem

The plugin had no npm distribution: `package.json` carried `private: true`, and
the unscoped name `dsh-subscription-hub` was already taken on npm by an unknown
third party. Meanwhile the npm ecosystem moved to tokenless publishing — classic
automation tokens were revoked in December 2025 and mandatory 2FA arrived in
2026 — so any publish path built on long-lived CI secrets would start out
already obsolete. Distribution still matters: npm gives the plugin a reserved
name, a provenance anchor, and a `pnpm add` install path that skips the GitHub
`prepare` build, and DSH's plugin manager already accepts registry specs
(`dsh plugin add <name>` resolves through pnpm). One bootstrap constraint shapes
the whole flow: npm only lets a trusted publisher be configured for a package
that already exists, so the first publish cannot be done by CI.

## Decision

The package was first published as `@goodboys-ai/dsh-subscription-hub` (the
`goodboys-ai` npm org is ours; the unscoped name was then squatted) and is now
`dsh-subscriptions` — the rename rationale and its alternatives live in
[2026-09-30-package-rename.md](2026-09-30-package-rename.md). The
trusted-publishing mechanics below are unchanged by the rename; only the package
name and the one-time bootstrap repeat. `private: true` is removed and
`"publishConfig": {"access": "public"}` added; the GitHub repo slug
`goodboys-ai/dsh-subscription-hub` was unchanged at rename time and became
`goodboys-ai/dsh-subscriptions` on 2026-10-01 (the old slug redirects
indefinitely). Publishing is OIDC trusted publishing — the workflow mints an
id-token, npm verifies it against the trusted publisher configured on npmjs.com
for repo `goodboys-ai/dsh-subscriptions` + workflow `release.yml` + no
environment — so no token exists to leak or expire. The CI call is
`npm publish --provenance --access public` (the documented OIDC path), not
`pnpm publish`. A version containing `-` publishes under the `alpha` dist-tag so
`latest` keeps pointing at the newest stable release. The `npm-publish` job runs
in parallel with GitHub Release creation and skips a version npm already has,
which covers reruns and the manual bootstrap: for the scoped name the maintainer
published `0.1.0-rc.0` to `alpha` by hand, configured the trusted publisher on
npmjs.com, and CI took over from `v0.1.0` onward; the rename repeats that
bootstrap once for `dsh-subscriptions` (manual first publish, trusted-publisher
re-registration, then CI) — completed 2026-10-01 with the manual
`dsh-subscriptions@0.1.0` publish (alpha and latest), the trusted publisher
registered against the new repo slug, and the scoped package deprecated.

Install verification (2026-09-30, against the installed CLI and the npx cache
for every window version) found `dsh plugin add` DOES accept npm registry specs:
`@deepseek-ai/dsh-plugin-manager`'s `parseInstallSpec` classifies a bare or
scoped package name as `kind: "registry"` and the install path runs
`pnpm add <spec>` after a `pnpm view` registry check. So the canonical install
is `dsh plugin --profile web add dsh-subscriptions`, with the `github:` ref
documented as the source alternative.

## Alternatives considered

- **Unscoped name `dsh-subscription-hub`.** Squatted by an unknown third party;
  recovering it is a dispute process with no guaranteed outcome. Scoping under
  our own org is immediate, unambiguous, and matches the repo owner.
- **Token-based CI publish.** Classic tokens are revoked (Dec 2025); granular
  tokens expire and are strictly weaker than OIDC — they prove possession of a
  secret, not which workflow run used it. Trusted publishing is the only path
  that carries provenance and needs no secret storage.
- **`pnpm publish`.** Works, but the OIDC exchange is documented against
  `npm publish`; fewer moving parts on the supported path outweigh package
  manager uniformity here.
- **Never publishing to npm.** The name stays exposed to future squatting,
  installs always run the GitHub `prepare` build (which DSH `0.1.7-rc.2` blocks
  by default), and releases carry no provenance anchor. The cost of publishing —
  one workflow job and one manual bootstrap — is small against those losses.

## Consequences

Users can install from npm (`dsh plugin --profile web add dsh-subscriptions`)
without triggering the `prepare` build that GitHub installs need on DSH
`0.1.7-rc.2`, and every CI publish carries npm provenance. The maintainer owed
one manual `0.1.0-rc.0` publish plus the npmjs.com trusted-publisher
configuration before the first tag (done for the scoped name; the rename repeats
both for `dsh-subscriptions`); a mismatch there fails CI with E404/E403, which
the workflow comment names. The `alpha` dist-tag policy means prerelease users
opt in explicitly while `latest` stays stable. The `cordis.patch.yml`
`insert.name` is a resolved module specifier — dsh-app-boot resolves it through
`node_modules/<name>/package.json` — so it MUST equal the installed package name
(`dsh-subscriptions` after the rename); only display/log identities (log
prefixes, the Cordis `export const name`, browser module ID) follow the same
short name.
