# Compatibility policy

How this plugin tracks DeepSeek Harness (DSH) releases: which versions are
supported, what "supported" means, how the plugin itself is versioned, and
how a plugin release is published.

## Support window

DSH is a fast-moving developer preview: every release so far has been a
prerelease (`-alpha`, `-rc`) and breaking changes are routine. This plugin
supports a **sliding window of gated DSH releases**: the newest fully gated
RC of each of the latest three minor lines, plus — in the newest minor line
only — its immediately preceding gated RC as a transition entry, at most
four versions. Only two minor lines exist so far (`0.1.x`, `0.2.x`), so the
window currently holds three versions. A version enters the window only
after the full gate passes on it; when a newer gated RC arrives, older RCs
of that minor line drop until at most two remain; when a fourth minor line
arrives, the oldest minor line drops. `dsh-versions.txt` at the repo root
is the single source of truth for the window; the CI matrix and the table
below derive from it.

One release covers the whole window, and the install gate is wider than the
window by design: the six `@deepseek-ai/dsh-*` `peerDependencies` are **one
bounded range** (currently `>=0.1.7-rc.2 <0.3.0-0`) whose lower bound is the
window floor and whose upper bound excludes the minor line after the newest
gated one. DSH's plugin manager enforces peers at install time with
`includePrerelease` semver, so the range admits every RC of the gated minor
lines, including RCs the gate has not run yet; the `-0` suffix on the upper
bound is load-bearing, because `<0.3.0` would admit `0.3.0-rc.1` while
`<0.3.0-0` excludes the whole next minor line. Installs on ungated versions
inside the range succeed but are unsupported (see below); versions outside
the range are rejected at install unless the user grants an exact
`dsh plugin allow-version` exemption. When the window adds a version, add
its `dsh-versions.txt` entry in the same PR and merge only after the full
gate passes on every listed version; the range bounds move only when the
floor leaves the window or a new minor line passes the gate — those, not
per-RC releases, are the maintenance events. The nightly `next-host` job is
the tripwire for range-admitted untested versions; a red run triggers a PR
that narrows the range (a lower upper bound or an exclusion disjunct). The
`devDependencies` stay pinned exact at the window floor, so the build never
uses APIs newer than the oldest supported DSH. CI packs exactly one tarball
from those pinned dependencies and boots that same tarball on every DSH
version in the window, in both the boot smoke and the host E2E — there is
no per-version artifact.

The rationale lives in agent notes:
[bounded peer range](../.agents/notes/implemented/process/2026-09-30-bounded-peer-range.md)
(superseding [exact-version peer disjunction](../.agents/notes/archived/process/2026-09-29-exact-peer-disjunction.md))
and [single-tarball CI](../.agents/notes/implemented/testing/2026-09-29-single-tarball-ci.md).

## What "supported" means

A DSH version is **supported** when the CI matrix ran all of these against it
and everything was green:

- `pnpm build` (TypeScript compiles against that version's `@deepseek-ai/*` APIs)
- `pnpm test` (the full unit + integration suite, including the virtual-provider
  end-to-end tests in `docs/testing.md`)
- `scripts/check-host-exports.mjs` (`src/` type-checks against that
  version's published declarations)
- `scripts/check-host-contract.mjs` (every runtime host name listed in
  `src/client/host-contract.ts` — icons, slots, services, DOM markers, theme
  tokens, crash diagnostics, and the shell's module table — appears in that
  version's shipped code)
- `scripts/boot-smoke.sh` (an isolated web profile boots with the plugin,
  the cordis patch applies without skips, the client bundle serves as
  JavaScript, and the logged-out auth and external-usage RPCs answer)
- `scripts/host-e2e.sh` (with the fake profile under
  `test/fixtures/host-e2e-profile/`, the usage RPCs return every fixture
  value, the model picker lists the plugin's Codex model, one message streams
  through the plugin into the transcript, the usage pill renders in the
  host's stats row with each source's own percentage in its dialog, no slot
  entry crashes, and neither the server nor the page makes an unplanned
  request)

Status legend:

- ✅ **tested** — the full gate (build, full test suite, host-export and
  host contract checks, boot smoke, host E2E) was green on this combination.
- ⚠️ **untested** — inside the window but the gate hasn't run it yet
  (typically a brand-new RC, less than a few days old).
- ❌ **known-broken** — the gate is red or a specific incompatibility is
  documented; see the notes column.

Anything outside the window is unsupported. Versions inside the peer range
but outside the window install and may work, but CI doesn't check them and
issues against them are closed as "upgrade or wait for the window".
Versions outside the range are rejected at install unless the user grants an
exact exemption:
`dsh plugin --profile web allow-version dsh-subscriptions@<version> --dsh-version <exact> --accept-risk`.
That exemption is an at-your-own-risk escape hatch, not support.

## Compatibility table

The source targets `0.1.3`, with peers `>=0.1.7-rc.2 <0.3.0-0`. Gate
results below were first recorded locally on 2026-09-30 and confirmed by
main CI on 2026-10-02. The CI matrix runs identical gates on every push. A
cell becomes ✅ only from a green gate run, never from "it should work".

| DSH | build | tests | host exports | host contract | boot smoke | host E2E | Notes |
|-----|-------|-------|--------------|---------------|------------|----------|-------|
| `0.1.7-rc.2` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | window floor; devDeps pin here |
| `0.2.0-rc.1` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | transition entry for the newest line |
| `0.2.0-rc.2` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | packed-tarball install verified |

The boot smoke and host E2E installed the packed tarball (no
`node_modules`). The host E2E used the host's default workspace on every version, without the directory picker.

## Plugin versioning

The plugin uses semver independently of DSH (`0.1.0`, `0.1.1`, …). During the
`0.x` series, use a patch for compatible fixes or DSH support expansion that
keeps the old window, and a minor for a new provider, a breaking setting, or
dropped DSH support. A peer-range move still requires a new plugin version
and tag; it does not create one plugin release line per DSH minor. The
current source version `0.1.3` supports a three-version window
(`0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`), so its minor version cannot
identify one DSH minor. The peer range and CI matrix state host
compatibility; plugin patches can ship between DSH releases.

Every release tag matches `package.json` (`v0.1.0` for version `0.1.0`). Once
that tag is published, users can pin with it. The `v0.1.0` release predates
the package rename, so its npm pin uses the scoped name under which it was
published:

```sh
dsh plugin --profile web add @goodboys-ai/dsh-subscription-hub@0.1.0
```

Releases from the rename onward pin under the new name, e.g.
`dsh plugin --profile web add dsh-subscriptions@0.1.1`. Any release can also
be installed from GitHub source:

```sh
dsh plugin --profile web add github:goodboys-ai/dsh-subscriptions#v0.1.0
```

That tag is the **downgrade path** — DSH itself offers no downgrade tooling.
Never move or reuse a release tag. Protect `v*` tags against updates and
deletion with a GitHub [tag ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
or [immutable releases](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes)
before the first release.

Branch strategy: `main` always tracks the newest DSH in the window.
Maintenance branches per DSH minor line are cut only when someone actually
needs a fix on an old line that the current range no longer covers; they are
not pre-created.

## Release process

1. **Prepare a PR.** Set the intended plugin version in `package.json` and
   draft release notes. Update the README and compatibility table for changed
   behavior. When adding a DSH RC, update `dsh-versions.txt` in this PR; move
   the peer range's bounds in the same PR when the floor leaves or when a new
   minor line passes the gate, and move the pinned dev dependencies and
   lockfile to the new floor when the old floor leaves. A minor line keeps at
   most its two newest gated RCs; a fourth minor line drops the oldest line.
   There is no release-watch job; check DSH releases manually until one is
   added.
2. **Run the gate.** Require the PR's `CI gate`: per-version build, tests,
   host-export and host contract checks, plus the boot smoke and host E2E
   of one packed tarball on every listed DSH version. A host E2E
   failure uploads `host-e2e-evidence-<version>` (screenshot, DOM, console,
   server log); read it before rerunning. If a version fails, fix the plugin
   or narrow the window and peers in the PR. Record a new ✅ in the
   compatibility table only after its gate passes. Before adding a DSH RC,
   the nightly `next-host` job has usually run these checks against it
   already, on a nightly-only tarball whose peers admit it; an open
   `Nightly: DSH <version> breaks …` issue names the checks that failed.
3. **Disclose live coverage.** The [manual canary](testing.md#pre-release-canary-manual--not-a-test-layer)
   is optional and does not gate a stable release. When run, use isolated
   profiles to check provider login, usage, and a model request, plus
   usage-only sources and changed tools. Record the date and each result in
   the README's [verification section](../README.md#verification-and-limits).
   State remaining live-provider gaps in the GitHub Release; passing the
   automated gate does not prove that providers still accept live requests.
4. **Check the merge commit.** Merge through a PR and confirm its CI gate.
   CI boots a packed tarball, while a GitHub source install also runs
   `prepare`. On each supported DSH version, install
   `github:goodboys-ai/dsh-subscriptions#<merge-sha>` in an isolated
   profile and confirm the plugin loads after restart. `scripts/boot-smoke.sh`
   with `PLUGIN_SOURCE` set to that spec and `SMOKE_ALLOW_BUILDS=1` does
   this. The flag adds the README's `allowBuilds` entry to the temp profile,
   which DSH versions that block `prepare`
   (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, currently `0.1.7-rc.2`) need.
   If this fails, fix it through another PR before tagging.
5. **Publish from `main`.** Create `vX.Y.Z` at the checked merge commit and
   push it. The `v*` tag ruleset (id 24254540) makes tags immutable — never
   move or reuse one. Pushing the tag triggers `release.yml`, which verifies
   the tag equals `package.json` `version`, that the tagged commit is an
   ancestor of `origin/main`, and that the tagged SHA carries a green `CI
   gate` check-run (CI runs on main pushes, so the merge commit has its own
   check-runs; the workflow also runs a light inline sanity on the tag).
   It then auto-creates the GitHub Release — title = tag, prerelease when the
   version contains `-` — with the mechanical `## DSH compatibility`
   section (rendered from `dsh-versions.txt` and `package.json` by
   `scripts/render-release-compat.mjs`) above the auto-generated PR/commit
   notes. In parallel, the `npm-publish` job publishes the package to npm as
   `dsh-subscriptions` via OIDC trusted publishing (no
   tokens): versions containing `-` publish under the `alpha` dist-tag so
   `latest` keeps pointing at the newest stable; a version npm already has is
   skipped, which covers reruns and the manually bootstrapped first publish.
   The first publish ever (a `0.1.0-rc.0` under `alpha`) was done manually
   by the maintainer, because npm only lets a trusted publisher be
   configured for a package that already exists; the CI job took over from
   `v0.1.0` onward. The one-time bootstrap for the new name was completed
   on 2026-10-01: the maintainer published `dsh-subscriptions@0.1.0`
   manually (`npm publish --access public --tag alpha` from the release
   checkout — npm also tagged it `latest` as the first version), registered
   the trusted publisher on npmjs.com for package `dsh-subscriptions` +
   repo `goodboys-ai/dsh-subscriptions` + workflow `release.yml` + no
   environment, and deprecated the scoped package via
   `npm deprecate @goodboys-ai/dsh-subscription-hub@'*' 'Moved to dsh-subscriptions'`.
   These steps would only recur if the package name changed again; the CI
   job takes over from the next tag onward. The published
   `dsh-subscriptions@0.1.0` tarball's repository metadata still carries
   the old repo slug (it was published before the repo rename); redirects
   cover it, and the metadata self-heals from `v0.1.1` onward. Note the
   first release under the new name cannot reuse `v0.1.0` — that tag already
   exists for the scoped package — so the release PR bumps `package.json`
   to the next version first.

   Manual fallback if the workflow is unavailable:
   `gh release create vX.Y.Z --title vX.Y.Z --notes-file <notes>`, adding
   `--prerelease` for prerelease versions, and `npm publish --access public`
   for npm (interactive 2FA; provenance is CI-only — `--provenance` requires
   the OIDC `id-token` a local run does not have). The release PR also adds
   one terse section to `CHANGELOG.md` before the tag is pushed.

## What this policy deliberately does not promise

- **Provider-side changes.** When ChatGPT, Claude, Grok, Copilot, Antigravity,
  or Cursor change their login or API surface, the plugin can break on *every*
  DSH version at once. Neither the DSH matrix nor offline virtual-provider
  tests detect provider-side drift. The optional manual canary in
  [testing.md](testing.md) checks live behavior; unverified live behavior
  does not block a stable release and must be disclosed.
- **Forward compatibility.** A new DSH RC can break the plugin; the policy
  guarantees a *process* (detect → gate → disclose → tag), not that `main` works
  on a DSH released yesterday. The nightly `next-host` job shortens the
  detect step: it runs the host-export and host contract checks, the boot
  smoke, and the host E2E against the newest published DSH and opens an issue when one of them finds a break.
