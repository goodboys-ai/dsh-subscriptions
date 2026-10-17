# Contributing to DSH Subscription Hub

Use a topic branch or fork and submit a pull request. Changes to `main` go
through PR review and the CI gate. The
[PR template](.github/PULL_REQUEST_TEMPLATE.md) asks for the problem, a concise
thinking path, verification, compatibility risks, and AI disclosure.

In the thinking path, connect an existing project constraint or failure to the
chosen approach and its meaningful trade-offs. In AI disclosure, name the tool
and share a relevant prompt, conversation link, or summary of the work delegated
to it; use `N/A` when no AI tool was used.

The title starts with a topic and a colon: `fix: ...` or `fix(scope): ...`. The
topics are `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `ci`, `build`,
and `style`. A scope is optional. When present it is lowercase words separated
by commas or hyphens, as in `fix(auth,tools): ...` or `fix(host-e2e): ...`. The
description uses the template headings in that order. Each section has an
answer. Related issue is `None` or an issue link. The verification bullets and
the AI disclosure fields keep the template's labels, with the answer on that
same line. A paragraph in the description is one line.
`node scripts/check-pr-template.mjs` enforces this in `repo-checks`. Pass
`--event` the GitHub event file, or `--title` and `--body-file` locally. An
event that is not a pull request skips the title and body checks after the
template file parses. Exit 1 is a finding; exit 2 means the check did not run.

Repository markdown (`docs/`, `README.md`, this file, `.agents/notes/`) is
wrapped at 80 columns by Prettier: it is read in an editor and reviewed as a
diff, and GitHub renders those files with soft line breaks, so the wrap does not
show on the page. Only prose written for a surface GitHub renders as a
standalone body — PR descriptions and issue/PR comments — is written one line
per paragraph, because there a single newline inside a paragraph is a hard line
break, so a wrapped body shows as sentences broken mid-line. A Markdown table
row is at most 120 characters; `node scripts/check-markdown-tables.mjs` checks
that in `repo-checks`.

JavaScript, TypeScript, and Markdown are formatted with Prettier
(`pnpm format`). JavaScript and TypeScript are linted with ESLint (`pnpm lint`).
`pnpm install` installs a pre-commit hook that runs both on the staged files
when this checkout is the git root; a dependency install skips the hook.
Archived notes and the upstream README snapshots are not formatted. Agent Notes
and `CHANGELOG.md` also keep the 80-column markdownlint check.

## Set up and check a change

CI uses Node.js 24, and `package.json` pins pnpm 10.33.2. From a checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The test suite uses fake provider responses and must run without real provider
credentials or calls to production provider servers. `pnpm test` refuses any
connection that leaves loopback and fails the spec that tried, so mock every
provider request a new test makes. If you change an Agent Note, also run
`node scripts/verify-agent-notes.mjs`.

Run checks that cover the change and report the commands and results in the PR.
[testing.md](docs/testing.md) lists what each check covers:

- DSH compatibility or packaging: the host-export and host contract checks
  (`--all`) and the isolated boot smoke.
- Client UI, the usage bar, model registration, or streaming: the host E2E,
  `bash scripts/host-e2e.sh`. It needs Chrome or Chromium (`CHROME_BIN`).
- A client change that reads a new host name (icon, slot, service, DOM marker,
  theme token, host export): add it to `src/client/host-contract.ts`;
  `test/host-contract.spec.ts` fails until you do. Name it with a literal, not a
  computed string, so the scan can see it.
- A plugin change that makes a new provider request in the host E2E path: add a
  fixture or a planned refusal to `scripts/host-e2e-fixture.mjs`; the host E2E
  fails on any request it did not plan.

Every script creates a temporary `DSH_HOME` and does not use an existing DSH
profile. CI builds one tarball and runs it on every version in
`dsh-versions.txt`; see the [compatibility policy](docs/compatibility.md) before
changing that window.

A bug fix comes with a test that fails without the fix. Say in the PR which test
that is, and add a row to the bug replay table in
[testing.md](docs/testing.md#bug-replay) when the bug is user-visible.

## Provider and UI changes

Add or update offline adapter and virtual-provider tests for changed request or
response behavior. These tests check the plugin's side of a recorded provider
contract; they do not prove that a provider still accepts it. The optional
manual canary in [testing.md](docs/testing.md) covers live provider behavior in
an isolated profile; it does not gate stable releases. Disclose remaining
live-provider gaps in the release notes.

For visible UI changes, include a screenshot or recording and state what was
checked. Update the owning documentation or Agent Note when behavior or a
durable decision changes. Follow the
[prose standard](.agents/skills/subscription-hub-prose-standard/SKILL.md) for
comments, docs, and user-visible text.

A still proves a state (appearance, layout, an A/B difference); a recording
proves a behavior (a sequence, timing, a transient state). PR-only stills at or
below 300 KiB each live at
`docs/assets/pr-<number>/<subject>-<state>[-<theme>].png`, in lowercase
kebab-case; use `before-after` for a comparison. Documentation images stay in
the docs directory that owns them and are not added to `screenshots.json`.
Recordings, GIFs, and larger stills go to a media-only orphan branch named
`<series>-assets`, never the pull-request branch, and are embedded as
`https://github.com/<owner>/<repo>/blob/<branch>/<name>?raw=true`. These
branches are append-only: never replace a published file, delete the branch, or
force-push it. The
[PR evidence storage note](.agents/notes/implemented/process/2026-10-01-pr-evidence-storage.md)
carries the rationale.
