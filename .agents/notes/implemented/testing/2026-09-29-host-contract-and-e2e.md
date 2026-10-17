# Agent Note: Host contract manifest and host E2E

Status: implemented

## Problem

The plugin runs only inside a DSH host, and the client bundle reads host modules
at runtime. Several failures therefore pass `tsc`, the unit suite, and the boot
smoke, and show up only in a user's browser:

- DSH 0.1.7 renamed its 16px glyphs from `Icon<Name>16` to `Icon<Name>Regular`.
  The old name compiled against the pinned declarations, rendered `undefined`,
  and crashed the usage badge slot (upstream #116) and then the image and video
  tool views (`659151a`).
- The slot renderer catches an entry's crash and logs
  `slot entry crashed in '<slot>'`. The page keeps working and the feature is
  just gone, so nothing reaches the page's error handlers.
- A slot outlet, DOM marker, or theme token the host drops leaves no error at
  all. The video tool view's placeholder background used an undefined token
  (`--dsw-alias-fill-tertiary`) until the manifest check below flagged it.

Hand-made host fakes in unit tests cannot see any of this: they encode what we
believe the host provides, which is exactly the belief that went stale.

## Decision

**One manifest of runtime host assumptions.** `src/client/host-contract.ts`
lists the host names the client uses that the compiler cannot check: icons,
slots, context services, DOM markers, theme tokens, slot-crash diagnostics, and
the shell's static module table, each next to the host package that owns it. The
module has no imports, so plain Node scripts load it directly.

- `scripts/check-host-contract.mjs --dsh <v>` checks that each entry appears in
  that version's published JavaScript, per CI matrix version and nightly against
  the newest DSH on npm. The check is textual; the E2E covers the runtime path
  of what it renders.
- `test/host-contract.spec.ts` scans `src/client` and fails both when code uses
  an unlisted host name and when a listed name is no longer used. The scan reads
  literals in any quote style and namespace-import members, and its self-tests
  pin those forms. A name computed at runtime, or a new way of reaching the
  host, escapes it; the E2E and code review are the backstop there.
- `hostIcon()` logs `HOST_CONTRACT_MISS` when a glyph is missing under both
  namings, so a miss is visible in the browser console.

**A host E2E that asserts the plugin-host contract, not host UI.**
`scripts/host-e2e.sh` boots `dsh web` with a fake signed-in profile and a
network preload, and `scripts/host-e2e.mjs` drives it through headless Chrome
over CDP. It asserts what the plugin promises the host and the user: usage RPC
values, the model in the picker, a streamed reply in the transcript, the pill
inside the host's stats row with each source's own percentage in its dialog, no
crashed slot, and no unplanned request from the server or the page. Onboarding,
workspace, and menu clicks are harness steps; a failed harness step is retried
once and reported as a harness failure (exit 2). A failed assertion is never
retried (exit 1), and an attempt whose page crashed a slot, missed a contract
name, threw, or left loopback counts as a failed assertion even when a harness
step also failed, so a retry cannot hide it.

Specific choices inside the E2E:

- **Default workspace instead of the directory picker.** A `--patch` overlay
  sets `workspace-controller` `documentsDirectory` to the temp home, and the
  host opens its first-use workspace there on both supported versions. The
  picker is kept only as a fallback; its first listing resets a typed path when
  it lands late, which made the earlier driver flaky.
- **One fixture module.** `scripts/host-e2e-fixture.mjs` holds the reply text,
  the model, each source's percentage, and the planned refusals. The preload
  serves those values and the driver expects them, so neither side can drift
  alone. The driver never imports the preload, because the preload patches the
  network of whichever process loads it.
- **Refuse by default, match exactly.** The preload answers requests whose
  method and URL exactly match a planned fixture, and only with the exact
  fixture credential; it refuses every other non-loopback fetch and TCP
  connection, and logs both. Model catalog discovery is refused on purpose,
  which also checks that the picker falls back to the static model list offline.
  Any refusal not listed in the fixture module fails the run, and so does a
  required fixture nobody requested, so a new provider request needs a
  deliberate fixture or refusal.
- **Fence the browser too.** Chrome does not load the preload. It runs with a
  proxy on a dead local port and resolver rules that fail every hostname but
  localhost, and the driver fails the run on any non-loopback request in the CDP
  network events. The preload does not stop DNS lookups; neither guard sends a
  request, but a refused hostname may still be resolved.
- **Crash signals come from the host contract.** The driver reads the crash log
  line and error attribute from `HOST_CONTRACT.diagnostics`, and
  `check-host-contract.mjs` checks that the renderer still emits them. If a host
  changes how it reports a slot crash, the contract check fails rather than the
  E2E going blind.
- **Evidence.** The driver saves the RPC answers and, for each browser attempt,
  a screenshot, DOM, console log, page requests, and summary, on a pass too,
  since a later request-log check can still fail. On failure the shell adds the
  server, install, and provider request logs. CI uploads them as
  `host-e2e-evidence-<version>`.
- **Bounded waits.** Every RPC call and CDP command has a timeout, and a closed
  CDP socket fails every pending call, so a wedged host or browser ends the run
  instead of holding the CI job.

The boot smoke keeps only the logged-out checks and needs no browser.

The host-export and host contract checks, the boot smoke, and the host E2E exit
1 only for a finding they explicitly recognise (a compiler diagnostic, a missing
contract name or host package, the host refusing the plugin's peers, a failed
assertion) and exit 2 for everything else, including unexpected exceptions. The
nightly job opens an issue only for exit 1. The other default was tried first
and kept leaking: every uncaught setup error (an npm outage, an unreadable file,
a failed `mktemp`) exited 1 and would have opened a false compatibility issue.
With this default, a finding the scripts do not yet recognise fails the job
without an issue, which is noisy but never a false report.

## Verification

Each assertion was seen to fail against a mutant of the packed plugin on DSH
0.2.0-rc.1 (2026-09-29): the pill rendered outside the stats row, a composer
slot entry that throws on render, and a Codex translator that drops text deltas.
Each mutant failed as a product failure with a message naming the broken
promise, and the crash mutant's console line was reported. The unmodified
tarball passes on 0.1.7-rc.2 and 0.2.0-rc.1.

## Alternatives considered

**Extend the boot smoke with the browser checks.** The first version of this
work did that. It mixed a fast, browser-free install gate with a slow,
browser-driven one, so a picker timing problem failed the install gate and the
logged-out checks could not run without Chrome. Separate jobs keep the cheap
gate cheap and give the E2E its own evidence and retry policy.

**Playwright instead of raw CDP.** Upstream #116 checked its badge with a
Playwright script against a synthetic page. Playwright would add a large dev
dependency and its own browser download to a repo whose CI image already has
Chrome, and the driver needs only navigation, evaluation, key input, console
capture, and a screenshot, which are a few CDP calls.

**Assert host UI details (labels, layout) in the E2E.** Host UI changes every
release and is not ours to test. Asserting it would turn host redesigns into red
builds with nothing to fix in the plugin. The E2E uses host UI only to reach
states, and fails on it only as a harness failure.

**Keep host assumptions in each call site.** Before the manifest, the icon
naming, slot keys, and markers were scattered through `src/client`. Nothing
could check them against a published host, and nothing noticed an assumption
nobody used any more.

## Consequences

Drift in the listed runtime names is caught per DSH version before a user sees
it, and nightly against the newest DSH before it enters the window. A slot crash
anywhere on the E2E's path fails CI with the crashing slot named.

The cost: a CI job that needs Chrome and boots DSH per version, a manifest every
client change that reads a new host name must update, and a harness that follows
host UI changes (onboarding labels, the model menu). A harness break shows as
exit 2 with a screenshot, and is fixed in the driver, not the plugin. The E2E
covers one provider's generation path (Codex) and the usage bar; other
providers' generation stays with the integration tests and the canary.
