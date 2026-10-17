# Agent Note: Single-tarball CI

Status: implemented

## Problem

One plugin revision must work across the whole DSH support window. If each
matrix job rewrites dependencies and packs its own tarball, CI tests a different
package on each DSH version and cannot establish that one package works across
the window. The packed layout and cordis patch must also be checked on a clean
install rather than inferred from a source build.

## Decision

CI packs **exactly one tarball**, from the repository's pinned dependencies (the
window floor), in the `pack` job. The `boot-smoke` and `host-e2e` matrices
download that same tarball artifact and boot it on every DSH version in
`dsh-versions.txt`. The per-version `build-and-test` jobs only swap
`devDependencies` to run the build, the test suite, and the host-export check
against each DSH line — they never pack. There is deliberately no per-version
artifact.

Why the tarball and not the checkout: a raw-directory install carries
`node_modules` and never exercises the packed layout. The tarball checks
`@deepseek-ai/*` resolving from the host (no `node_modules` shipped), the
`files` allowlist (`lib`, `vendor/cursor`, `cordis.patch.yml`), and the cordis
patch applying to a clean tree. `boot-smoke.sh` builds an isolated `DSH_HOME` (a
`mktemp` dir, never the user's real profiles), installs with `dsh plugin add`,
boots `dsh web --no-open --port 0`, and asserts the trust handshake (single-use
`?token=` URL → 303 + session cookie → app page 200), that the served HTML
references `subscription-hub/client.js`, that the bundle responds with non-empty
JavaScript, that the logged-out `/api/subscriptions-auth` routes for provider
status, external-usage status, Cursor status, and unconfigured OpenCode Go /
Kimi Code usage answer, and that the log shows no cordis patch skips or
module-load failures. The host E2E installs the same tarball into a signed-in
profile; see [host contract and host E2E](2026-09-29-host-contract-and-e2e.md).

The smoke test also exercises installer dependencies: it caught a missing pnpm
setup in CI because `dsh plugin add` invokes pnpm (`47e05213`).

## Alternatives considered

- **Per-version pack (the original flow).** Described above. Rejected on review:
  it verified N artifacts and shipped an (N+1)th.
- **Boot the raw checkout instead of the tarball.** Faster iteration, and fine
  for local development (`boot-smoke.sh` supports it), but it skips every
  packed-layout check that distinguishes a release from a checkout. The
  packed-layout check requires the tarball.
- **Smoke-test a single DSH version.** Cheaper, but the peer disjunction exists
  to span the window — installing on one version would leave the cross-version
  install claim (the whole point of the disjunction) to the solver's word. The
  matrix boots the identical bytes everywhere.

## Consequences

Every supported DSH version boots the same tarball bytes, and the peer
disjunction is exercised through a real plugin install. The `pack` job is a
dependency of each boot-smoke and host-e2e job; a packaging mistake fails the
matrix. The README's GitHub install runs `prepare` on the user's machine, so
this tarball check does not establish byte identity with that install path.
