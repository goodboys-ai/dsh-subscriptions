# Testing strategy

The plugin is only ever used inside a DSH host, so most of what can break it
sits on the boundary between the two: host exports, slot outlets, DOM
markers, RPC routes, and the model adapter the host calls. The checks below
cover that boundary from the cheapest place that can see each failure.
Mocked unit tests prove our logic; they cannot prove the providers still
behave the way we recorded, and no automated check here calls a real
provider. That gap belongs to the manual pre-release canary.

| Check | Command | Runs | Proves |
|-------|---------|------|--------|
| Unit and integration tests | `pnpm test` | CI, every version | plugin logic, provider wire contracts against fakes |
| Host-export check | `node scripts/check-host-exports.mjs --dsh <v>` | CI, every version | `src/` compiles against that version's declarations |
| Host contract check | `node scripts/check-host-contract.mjs --dsh <v>` | CI, every version | runtime host names in `src/client/host-contract.ts` exist in that version's shipped code |
| Boot smoke test | `bash scripts/boot-smoke.sh` | CI, every version | the packed tarball installs, mounts, serves, and answers logged-out RPCs |
| Host end-to-end test (host E2E) | `bash scripts/host-e2e.sh` | CI, every version | the plugin works inside a signed-in `dsh web`, driven through Chrome |
| Nightly | `.github/workflows/nightly.yml` | schedule | mutation score, shuffled order, newest published DSH |
| Canary | manual | optional, not a release gate | real providers |

Unit and integration tests share one command: `pnpm test` compiles `test/`
and runs every spec, including the virtual-provider integration specs.
Integration is a coverage category, not a separate lane. The other checks
install a DSH version's packages, and the smoke and end-to-end tests also
boot a real DSH, so they are separate commands.

Repository checks run once in CI, without a DSH version or dependencies:

- `node scripts/verify-agent-notes.mjs`: checks Agent Note structure and
  required sections against `.agents/notes/AGENTS.md`.
- `node scripts/check-compat-docs.mjs`: checks compatibility statements
  against `dsh-versions.txt`.
- `node scripts/check-image-budget.mjs`: scans `docs/assets/pr-*/`
  recursively, caps each bitmap at 300 KiB, and forbids recordings there
  (`.gif`, `.mp4`, `.webm`, `.mov`). A recording or oversized still goes to
  an append-only assets branch. Documentation images outside that directory
  are not policed. `--dir <path>` selects a fixture repository root; exit 0
  means clean, 1 a finding, and 2 that the check could not run.

## Unit tests

All specs in `test/` cover the adapter logic: OAuth URL construction, PKCE,
token storage and refresh, usage-window classification, model-list filtering
and sorting, SSE parsing, error classification and retries, RPC validation,
and the client helpers that do not need a browser. They are offline and
repeatable.

### Network guard

`pnpm test` loads `test/hermetic.mjs` into every spec process. A TCP or TLS
connection to anything other than loopback throws `EHERMETIC` before its DNS
lookup, so a spec that forgets to mock a provider fails instead of calling
the real service with whatever credentials the machine has. The guard sits
on `net.Socket#connect`, which `fetch`, `node:http(s)`, `node:http2`,
`node:tls`, and `net.connect` all reach. Production code often catches fetch
failures, so the throw alone could be swallowed. The guard therefore also
counts refusals and fails the spec file at exit unless the spec declared
exactly that many (`globalThis.__dshHermeticExpectedRefusals`).
`test/hermetic.spec.ts` fails when the runner stops loading the guard or a
client above stops being refused.

The guard does not stop a bare `dns.lookup` or `dns.resolve`, and it does
not cover UDP. A spec that reaches DNS that way leaks the hostname, not a
credential; no test does so today.

Run a single spec file with the guard too:
`node --import ./test/hermetic.mjs --test lib-test/test/<name>.spec.js`.

### Test order

Specs must pass in any order. The nightly workflow runs the suite with
`--test-randomize` on five random seeds and prints each seed. Reproduce a
failure locally with:

```sh
node --import ./test/hermetic.mjs --test --test-randomize --test-random-seed=<seed> "lib-test/test/**/*.spec.js"
```

Module-level caches that outlive a test (the Copilot VS Code version, Grok's
OIDC discovery) have a `reset…ForTests()` hook, marked
`@internal Exported for tests only`. A spec that reads such a cache calls the
hook first; it does not rely on running before the spec that fills it.

### Property tests

`test/*.property.spec.ts` use [fast-check](https://fast-check.dev/) for
parsers and translators whose inputs come from a provider or a transport:
SSE framing across arbitrary read splits, JWT payload decoding, rate-limit
reset parsing, and tool-call pairing in the Anthropic and Chat Completions
translators. Each file states the invariant it checks. A failing run prints
the seed and the shrunk counterexample; turn that counterexample into an
ordinary example test next to the fix.

## Host-export check

`node scripts/check-host-exports.mjs --dsh <version>` / `--all`

Installs that DSH version's `@deepseek-ai/*` packages into a temp dir, then
runs the repo's own `tsc --noEmit` over `src/` with `@deepseek-ai/*`
redirected at the temp install. Only packages whose current pin is a DSH
prerelease move; cordis and schemastery keep their own versions. If `src/`
compiles, every host export the plugin references by type exists in that
version. `--all` covers every version in `dsh-versions.txt` with installs
cached per version.

Catches: a host that renamed or removed a typed export, which would stop the
whole plugin tree from loading. The TypeScript build catches this only for
the pinned version.

## Host contract check

`node scripts/check-host-contract.mjs --dsh <version>` / `--all` (run
`pnpm build` first)

The client bundle reads host modules at runtime, so some host names are
invisible to the compiler: a renamed icon export compiles against old
declarations and renders `undefined`; a slot outlet the host stops rendering
never mounts our entry; a removed DOM marker only breaks layout; an undefined
theme token styles nothing. Each of these assumptions is listed once in
`src/client/host-contract.ts`, next to the host package that owns it: icons,
slots, context services, DOM markers, theme tokens, the slot renderer's crash
diagnostics, and the shell's static module table.

The script installs that DSH version's host packages and checks every entry
against their shipped JavaScript. It also checks that every module
`lib/client.js` loads is a key of the shell's module table, because the
shell serves no other module. A failing entry names the package and what the
client loses.

The check is textual: it proves each name ships in the package that should
own it, not that the host still uses it the way the client expects. A slot
name that survives only in dead code passes here. The host E2E covers the
runtime path for the slots, markers, and icons it renders.

Two pieces keep the manifest honest:

- `test/host-contract.spec.ts` scans `src/client` for host names (slot
  injections, context services, `var(--dsw-…)` tokens, `[data-…]` selectors,
  `hostIcon()` names, value imports from `@deepseek-ai/*`, named or
  namespace). A name the code uses but the manifest omits fails, and so does
  a manifest entry no code uses. The scan reads string literals in any quote
  style but no computed names, and the spec's self-tests pin the forms it
  must catch. A new way of reaching the host needs a new pattern there.
- `hostIcon()` (`src/client/host-icons.ts`) resolves a glyph under either
  host naming and logs `HOST_CONTRACT_MISS` when neither exists, so a missed
  name shows in the browser console and in the host E2E instead of as an
  empty icon.

## Boot smoke test

`DSH_VERSION=<v> bash scripts/boot-smoke.sh`

Creates an isolated `DSH_HOME` (a `mktemp` dir; never the user's real
profiles), installs this plugin into the `web` profile with `dsh plugin add`,
boots `dsh web --no-open --port 0`, and asserts:

- the plugin installs. This is a real gate: DSH's plugin manager enforces
  `@deepseek-ai/*` peer versions at install time (semver with
  `includePrerelease`; an out-of-range host is rejected unless the user
  grants an exact `dsh plugin allow-version` exemption). The bounded peer
  range (`>=0.1.7-rc.2 <0.3.0-0`, see `docs/compatibility.md`) admits the
  whole support window, so the same release installs on every gated
  version. (Dated evidence: with exact `0.1.7-rc.2` peers, installing on
  `0.2.0-rc.1` was *rejected* on 2026-09-29; the range form was verified
  to install on all three gated versions on 2026-09-30.);
- the web UI completes its trust handshake: the printed `?token=` URL is
  single-use (first GET → 303 + session cookie), then the app page answers
  HTTP 200 with the cookie;
- the served app page references `subscription-hub/client.js`, and its
  versioned URL returns non-empty JavaScript;
- with that session cookie, POST `/api/subscriptions-auth.status`,
  `externalStatus`, and `cursorStatus` in the browser's `client-request`
  envelope. A fresh profile reports the five OAuth providers with empty
  account lists, OpenCode Go and Kimi Code unconfigured, and Cursor
  unauthenticated. `externalUsage` for each of those two sources returns the
  unconfigured-key error without calling the usage host;
- the log contains no cordis patch skips (`name mismatch` style silent skips)
  and no module-load failures.

It needs no browser and no fixture profile. It also runs without a network
guard: a logged-out profile sends no provider request, and the checks above
include the refusal of `externalUsage` before any usage host is contacted.
A regression that made the logged-out server call out would pass here, so
the host E2E, which refuses every unplanned request, is the check for it.

`SMOKE_ALLOW_BUILDS=1` writes the README's `allowBuilds` entry into the temp
profile first, for a GitHub install on a DSH version that refuses the
package's `prepare` script otherwise.

Install the **packed tarball** (`pnpm pack`, without `node_modules`) rather
than the raw checkout when checking packed layout: `@deepseek-ai/*` must
resolve from the host. CI does this; a raw-directory install is useful for
quick iteration. The README's GitHub install builds through `prepare` on the
user's machine, so CI's tarball smoke does not prove the two installs produce
identical bytes.

CI's `pack` job builds one tarball from the repo's pinned dependencies, and
the `boot-smoke` and `host-e2e` matrices use that identical artifact on every
DSH version. There is deliberately no per-version artifact.

Catches: the plugin installs but does not load, the client bundle is not
served, the auth or external-usage routes are not registered, or the patch
that registers providers is silently skipped.

## Integration tests with virtual providers

`test/fakes/*.ts` + `test/*-integration.spec.ts`. Every provider route has
one: Codex, Claude, Grok, GitHub Copilot, Google Antigravity, Cursor.

A **virtual provider** is a fetch-level router (`t.mock.method(globalThis,
'fetch', router)`) that simulates the provider's HTTP surface:

- `GET <authorize-url>` → 302 redirect to the *real* loopback callback server
  with `?code=…&state=…` (no browser needed; the real `OAuthFlowManager`
  validates state, PKCE, and the callback path),
- `POST <token-url>` → token JSON with a fake JWT carrying the namespaced
  claims the real code reads (`https://api.openai.com/auth.chatgpt_account_id`),
- usage / models / completions endpoints → canned payloads exercising the real
  parsing: window classification by duration, catalog sorting and visibility
  filtering, SSE stream translation.

Each `test/<provider>-integration.spec.ts` drives the real code end to end:
login flow → code exchange → refresh → usage → catalog discovery → (where the
transport allows it) a model run through the real adapter's `stream()`.
Localhost URLs pass through to the real `fetch` so the loopback callback
server under test is genuine. Every spec also asserts the *wire details* the
fake observed: grant types, form vs JSON encoding, PKCE verifier echo,
authorization headers, request bodies.

The fakes deliberately probe edge behavior, not just the happy path: refresh
responses that omit `refresh_token` (retention from storage), unknown
endpoints answering 404 (no silent pass-through to production), revoked
tokens failing loudly, forged callback state rejected by the real callback
server. Each fake's header records where its payload shapes come from and
what it does not prove.

`test/usage-bar.spec.ts` stands up every usage source at once from one
signed-in profile and checks the roster, the per-account fetch, and the
grouping the composer bar renders. The rendered bar is the host E2E's job.

**Cursor generation is covered at the adapter layer, not the socket layer.**
Cursor's generation transport speaks ConnectRPC over a raw `node:http2`
session (`/agent.v1.AgentService/Run`), which a fetch-level mock cannot
intercept. The specs inject a canned `createAgentRun` instead: the real
`CursorCompatAdapter.stream()` drives a fake run that yields protobuf-encoded
server frames (built with a test-local writer whose field numbers are
literals read from the vendored decoders). This proves the adapter logic that
is ours: model remapping, tool-message projection, frame-to-chunk
translation, usage accounting. It does not prove the HTTP/2 framing, TLS, or
the real Cursor server; those stay with the manual pre-release canary.
Cursor's fetch-level contract (browser-login poll, token refresh, usage,
protobuf model discovery) is fully covered.

To add a virtual provider for a future route, copy the pattern in
`test/fakes/fake-codex.ts`: a router keyed on that provider's endpoint URLs
written as independent literals — deliberately not imported from the
production source, so the fake can disagree with the code when the provider
drifts — plus helpers minting whatever credentials its session parser
requires; reuse the real `FlowSpec` for the authorize step; then add
`test/<provider>-integration.spec.ts` following the existing specs'
structure: login → refresh → usage → models → stream.

Catches: regressions in *our* flow logic — broken form encoding, claim-path
drift in our parsers, mishandled refresh grants, SSE translation bugs. The
strategy and its limits are recorded in the
[virtual-provider fakes](../.agents/notes/implemented/testing/2026-09-29-virtual-provider-fakes.md)
agent note.

**It does not prove the provider still honors the contract.** A fake can only
replay what we recorded. When the provider changes, these tests stay green
and the plugin breaks in production. That gap is handled by the manual
canary, not by more fakes.

## Host end-to-end test (host E2E)

`DSH_VERSION=<v> bash scripts/host-e2e.sh` (needs Chrome or Chromium; set
`CHROME_BIN` when it is not on `PATH` as `google-chrome` or `chromium`)

Run `pnpm build` first. `dsh plugin add` installs the checkout as it stands,
so a directory `PLUGIN_SOURCE` is installed with its current `lib/`: without a
rebuild the run exercises the previous build, and a source change under test
can pass on stale output. CI packs a tarball from the built tree, so only
local runs against a checkout hit this.

The plugin inside a real, signed-in `dsh web`, the way a user meets it. The
script:

1. installs the plugin into an isolated web profile and copies in
   `test/fixtures/host-e2e-profile/`: fake OAuth sessions for all five OAuth
   providers, and fake credential refs for Cursor, OpenCode Go, and Kimi
   Code. None of them is a real provider login. Real credential variables in
   the parent environment are unset before launch;
2. points the host's first-use workspace (`workspace-controller`
   `documentsDirectory`, set through a `--patch` overlay) at the temp home,
   so a fresh profile opens a workspace by itself;
3. boots `dsh web` with `scripts/host-e2e-preload.mjs`, which answers each
   provider request the plugin makes, matched by exact method and URL, with a
   fixture, and refuses everything else that leaves loopback. A fixture
   request whose credential header differs from the fixture's exact value
   gets 401 and is logged as such, and the driver then fails the run. So only
   a pass proves the plugin sent the credential it read from the profile;
4. runs `scripts/host-e2e.mjs`, which asserts:
   - the `usage`, `cursorUsage`, and `externalUsage` RPCs return the fixture
     percentages (exact up to float rounding), and Copilot reports no usage
     support. MiniMax returns four model-scoped windows with exact boundaries;
     the other sources return one window each. A row showing another source's
     number fails;
   - MiniMax's percentage-only standard windows and count-backed video windows
     remain distinct in Settings and the badge dialog. Their current windows
     have time markers, including the standard model at 0% used;
   - the host's model picker lists the plugin's `GPT-6-Astra`;
   - a message to that model streams through the plugin's Codex adapter,
     and the canned reply renders in the transcript;
   - the usage pill (`Codex 5h 11%`) renders inside the host's stats row
     (`data-composer-stats`). Its dialog has one section per source, each
     named for that source and showing only that source's fixture windows,
     with no unexpected section. The badge fills the dialog from RPCs that
     settle at their own pace, so the driver polls until it matches, and
     after a deadline fails on what the dialog then shows;
   - the dialog wears the host's menu material — the `--dsw-specific-menu`
     fill and the `--dsw-menu-backdrop-filter` blur — in the light and dark
     themes, and the collapsed pill stays transparent. The driver switches
     themes through the host's Appearance cubes and compares the dialog's
     computed fill and blur against probes resolving the same tokens, saving
     a screenshot per theme. The switch waits for the theme to settle rather
     than for the first attribute change: on DSH 0.1.7-rc.2 the preference
     lands asynchronously and the theme is re-adopted after the panel closes,
     which can put the page back on the previous theme mid-pass. The fill is
     translucent by design, so a dialog that keeps it without the blur
     leaves the transcript behind it readable;
   - the plugin's settings section renders inside the host's settings
     panel: the panel opens from the host's settings trigger, the nav lists
     the Subscriptions entry, and the section body shows the intro copy,
     one card per fixture-signed-in provider, the Cursor and built-in
     provider usage cards, and the status-bar quota display control with
     its two options. Flipping that control to Hidden persists to
     localStorage, and after a page reload the control still reads Hidden;
   - no slot rendered its crash face (`data-slot-error`), the console shows
     no `slot entry crashed in` or `HOST_CONTRACT_MISS` line, the page threw
     no uncaught exception, and the page requested nothing outside loopback.
     The slot renderer catches an entry's crash, so these are its only
     trace;
   - every provider request hit a fixture with the fixture credential, every
     fixture marked required was hit, the Codex request named the plugin's
     model, and every refusal is one planned in
     `scripts/host-e2e-fixture.mjs` (model-catalog discovery and Cursor's
     HTTP/2 transport, whose failure the plugin must survive). A planned URL
     matches exactly or with a query string; a longer path is unplanned;
5. greps the server log for load and patch failures.

Chrome does not load the Node preload, so the driver fences the browser
separately: a proxy on a dead local port, resolver rules that fail every
hostname but localhost, and no background networking. Every non-loopback
request the page attempts shows in the CDP network events and fails the run.

Clicking through the host UI to reach those states (onboarding, workspace,
model menu) is harness, not assertion. When the host does not open its
default workspace, the driver creates one under the temp home through the
directory picker. A harness step that fails is retried once in a fresh
browser. A failed assertion is never retried, and neither is an attempt in
which the page showed a slot crash, a contract miss, an uncaught exception,
or a non-loopback request, even when a harness step failed first. The page
is checked once more after its evidence is saved, so a late crash or request
still fails the run. Exit 1 is a product failure, exit 2 a harness failure. Every RPC call and browser step
has a timeout, so a hung server or browser ends as a failure, not a stuck
job.

Evidence goes to `HOST_E2E_ARTIFACTS` (by default a temp dir the script
removes after a pass): the RPC answers (`rpc/`), and for each browser
attempt its screenshot, DOM, console, and page requests
(`browser-attempt-N/`). The browser evidence is saved on a pass too, so a
later failure in the request log still has the page state. On failure the
script adds the server log, the install log, and the provider request log;
CI uploads the directory as `host-e2e-evidence-<version>`. The temp DSH home
is always removed unless `KEEP_SMOKE_HOME=1`.

The fixture values the preload serves and the driver expects live in one
module, `scripts/host-e2e-fixture.mjs`, so they cannot drift apart.

Catches: a host change that hides the model, breaks streaming into the
transcript, stops the usage bar from rendering in the stats row, makes a
slot entry crash, or leaves the plugin's settings section unrendered in the
host's settings panel; a usage RPC or dialog row that shows the wrong
account or source; a settings control whose copy drifts from the locale
dictionary or whose preference write does not survive a reload; and a
request, from the server or the page, that the plugin started making
without a planned fixture.

It does not prove: live provider behavior, Cursor generation (raw HTTP/2,
refused here), or UI paths other than the ones above. Login flows are covered
by the integration tests against fakes and by the canary against real
providers.

## Exit codes

The host-export check, the host contract check, the boot smoke, and the
host E2E share one exit-code meaning, so the nightly job can open issues
only for real breaks. Exit 1 is a finding about the plugin on that DSH
version, and only an explicitly recognised one: a compiler diagnostic in a
source file, a missing contract name or host package, the host refusing the
plugin's peers, or a failed assertion. Exit 2 is everything else, because
it means the check did not run: npm or the registry, a file it could not
read or write, a failed download or temp dir, a `dsh plugin add` failure
without a peer refusal, Chrome, or the host UI harness. An unexpected
exception therefore exits 2, and a finding the scripts do not yet recognise
surfaces as a job failure without an issue rather than as a false break.

## Nightly

`.github/workflows/nightly.yml` runs on a schedule and on demand:

- **mutation**: `pnpm test:mutation` runs [StrykerJS](https://stryker-mutator.io/)
  over the translators and the pool and rate-limit bookkeeping
  (`stryker.config.mjs` lists the files and specs). The score goes to the job
  summary and the HTML report to an artifact. Thresholds only color the
  report until a baseline exists; the job does not fail on a low score. A
  surviving mutant in a changed file is a missing assertion.
- **shuffled-repeat**: the suite five times with random seeds (see
  [Test order](#test-order)).
- **next-host**: the newest DSH on npm when it is not yet in
  `dsh-versions.txt`; a version already there is skipped, because CI covers
  it. When the candidate sits outside the peer range (below the floor or on
  a newer minor line), the release tarball would be refused, so the job
  packs a nightly-only tarball whose peers also admit it. Its checks
  answer "would the plugin work if this version joined the window?", not
  "does the release install on it". It runs the host-export check, host
  contract check, boot smoke, and host E2E, each even when an earlier one
  failed, and opens or updates a tracking issue that names the checks that
  found a break (exit 1). A setup failure (the build, Chrome) or a check
  that could not run (exit 2, see [Exit codes](#exit-codes)) fails the
  job without an issue. The nightly tarball's peers admit the candidate,
  so a peer refusal there (exit 1) means the host changed how it checks
  peers, which is itself a break.

## Bug replay

A regression test is only worth keeping if it fails when its bug comes back.
Each row below re-introduced a past bug in current code and recorded which
check failed. Add a row when a fix lands with its test, and state in the PR
which test failed before the fix.

Issue and PR numbers refer to the upstream tracker,
`V1ki/dsh-plugin-subscriptions`. The upstream rows were last replayed on
2026-09-29 against `pnpm test`; the dialog-surface row was replayed on
2026-10-01 against `bash scripts/host-e2e.sh`; the usage-cursor row was
replayed on 2026-10-06 against `pnpm test`.

| Bug | What broke | Re-introduced as | Specs that failed |
|---|---|---|---|
| Plugin display metadata | The card and Settings inventory fell back to English package metadata in Chinese UI | Remove the locale export or duplicate English metadata into `zh.json` | `package-identity` (source and manifest checks; packed assets and rendering verified separately) |
| Usage dialog surface | The dialog kept the host's translucent menu fill without its backdrop blur, so the transcript behind it stayed readable through the panel | `styles.panel` drops `backdrop-filter` | host E2E (`host-e2e.mjs`, dialog surface) |
| Usage cursor tied to freshness | The elapsed-time cursor vanished at 0% used, after a failed refresh, and once a reading was five minutes old, though the window's timing was unchanged | `UsageMeter` computes the cursor only when `isUsageFresh` holds | `usage-pace`, `usage-cursor-providers` |
| [PR #116](https://github.com/V1ki/dsh-plugin-subscriptions/pull/116) | DSH 0.1.7 renamed the host icons, and the badge lost its glyphs | `hostIcon` reads only `Icon<Name>16` | `host-icons`, `subscription-usage-badge` |
| [#80](https://github.com/V1ki/dsh-plugin-subscriptions/issues/80) | Every `/subscriptions-auth` RPC answered 405, so login was impossible | Routes registered as `/subscriptions-auth/<endpoint>` instead of `/api/subscriptions-auth.<endpoint>` | `login`, `rpc`, `model-defaults-rpc`, `provider-settings-rpc`, `usage-bar` |
| [#22](https://github.com/V1ki/dsh-plugin-subscriptions/issues/22) | A settled background subagent put `tool_use` in a user message, and Claude answered 400 from then on | `tool-call` blocks become `tool_use` in every role | `translate` |
| [#24](https://github.com/V1ki/dsh-plugin-subscriptions/issues/24) | The Claude route sent no `cache_control`, so every request reprocessed the whole prompt | `markMessageCache` does nothing; separately, the system block gets no breakpoint | `translate`, `models`, `anthropic-messages.property` |
| [#27](https://github.com/V1ki/dsh-plugin-subscriptions/issues/27) | A closed rate-limit window failed the turn instead of waiting | The configured wait no longer widens the retry ceiling | `rate-limit` |
| [#46](https://github.com/V1ki/dsh-plugin-subscriptions/issues/46) | A failed usage snapshot was not cached, so `quota_aware` hit the rate-limited endpoint on every request | No cooldown entry after a failed refresh | `pool-usage`, `pool`, `usage` |
| Concurrent model-catalog saves | Two accounts saving at once lost one account's catalog section: each writer merged onto a snapshot read before the other's rename | `save`/`clear` do a whole-file read-modify-write with no per-path serialization | `catalog-store` |
| Antigravity tool-result error flag | A failed tool result whose output parsed as JSON reached the model as a success, so the answer treated the tool as having worked | `toolResultValue` returns the parsed object without merging `isError`; the tool-role path never passes `message.isError` | `antigravity` (translate decoder) |
| MiniMax percentage-only windows | The usage UI showed only the video model: standard models report zero counts with an explicit remaining percentage, and the parser dropped any window without a positive total | `fetchMiniMaxUsage` requires `total_count > 0` before reading the percentage; the external card label drops the model scope | `minimax-usage`, `external-usage-controller`, `subscription-usage-badge`; baseline label-expression replay |

The MiniMax row was replayed on 2026-10-06 against `pnpm test`. The current
host E2E also checks MiniMax's fixture windows through the RPC and both UI
locations. Neither layer proves a real account's entitlement or response.

The dialog-surface row is the first bug the host E2E's own checks catch. The
rest of that driver was checked against injected faults before a bug covered
it: the pill rendered outside the stats row, a slot entry that throws, and
dropped Codex text deltas. Each ended the run with a product failure.

## Pre-release canary (manual — not a test layer)

Automated tests never touch production provider servers, so provider-side
drift has no automated coverage by design. The manual canary is optional
and does not gate stable releases. When running it, use an isolated profile
on each supported DSH version, log in to each subscription provider, read
usage where available, and run one model request per provider. Also check
the usage-only sources and any changed provider tools. The README's
[verification section](../README.md#verification-and-limits) records live
checks and remaining gaps; release notes disclose unverified live behavior.

## What "tested" means in the compatibility table

A ✅ in `docs/compatibility.md` means the CI gate was green on that DSH
version: build, `pnpm test`, the host-export and host contract checks, the
boot smoke, and the host E2E.
Provider canary status is recorded separately in the README verification
section.

## Credentials policy for tests

No test, at any layer, in CI or locally, uses real provider credentials.
The unit suite and the host E2E also cannot reach a production provider
server: `pnpm test` refuses non-loopback connections, and the host E2E
answers provider URLs from fixtures and refuses the rest, in the server and
in Chrome. The integration tests and the host E2E use fake JWTs and fake
tokens by construction.

Two gaps remain. The guards stop connections, not name lookups, so a
refused hostname may still reach DNS. The boot smoke runs without a guard:
its profile is logged out, so the plugin has no provider to call, but a
regression that made an outbound request anyway would not fail it (see
[Boot smoke test](#boot-smoke-test)).

The manual pre-release canary is the only thing that ever touches a real
account, and it is done by the maintainer, in an isolated profile. If a test
needs a secret, the test is wrong.

## Coverage limits

What the checks above do **not** prove, stated with the mechanism that keeps
each limit honest.

- **The host E2E depends on the host opening its default workspace.**
  `scripts/host-e2e.sh` points the host's first-use workspace at the temp
  home through a `--patch` overlay, and `scripts/host-e2e.mjs` then waits
  for the composer to become editable. When it does not, the driver silently
  falls back to driving the host's directory-picker UI and creating a
  workspace by hand — the run passes, just with a different log line. A host
  change that stops opening the default workspace therefore does not fail
  the E2E; it changes which path the suite exercised.
- **The host contract check covers the entries `src/client/host-contract.ts`
  enumerates, not every host surface the client touches.**
  `scripts/check-host-contract.mjs` checks the manifest's listed names, and
  `test/host-contract.spec.ts` only requires the forms its scanners read
  (slot injections, context services, `var(--dsw-…)` tokens, `[data-…]`
  attribute selectors, `hostIcon()` names, value imports). A host name
  reached another way — for example the settings-panel selector
  `div[role="dialog"][aria-modal="true"]:has(> nav)` in
  `src/client/index.ts` — is invisible to both, and a host change there
  fails no check.
- **The unit suite runs in Node, not in a browser DOM.** `pnpm test` is
  `node --test` over the compiled specs; no jsdom or happy-dom stands in for
  the host page. The browser fixtures under `test/` (for example
  `test/account-manager-browser.mjs`) are opt-in manual scripts driven
  through Playwright, not part of `pnpm test`, so a client change that only
  misbehaves against a real DOM is caught by the host E2E or not at all.
- **The nightly job is an early warning, not a gate.** The mutation,
  shuffled-repeat, and next-host steps run with `continue-on-error`, and
  the mutation thresholds only color the report — the job does not fail on
  a low score. A red nightly step signals investigation; it does not block
  a release the way the CI gate does.
