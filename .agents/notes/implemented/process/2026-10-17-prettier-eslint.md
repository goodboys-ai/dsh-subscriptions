# Agent Note: Prettier and ESLint

Status: implemented

## Problem

JavaScript and TypeScript had no formatter and no linter. Style drifted, and
unused imports landed. Markdown was wrapped by hand, and that wrap split code
spans across lines.

## Decision

Prettier formats JavaScript, TypeScript, and Markdown at 80 columns, without
semicolons, with single quotes. Markdown prose uses `proseWrap: always`, so a
code span stays intact instead of breaking at the column. The root `proseWrap`
stays `preserve`: applying `always` to YAML folded a workflow command mid-line.
ESLint uses its recommended rules, typescript-eslint recommended,
`react-hooks/rules-of-hooks`, and `react-hooks/exhaustive-deps`. `pnpm lint`
fails on warnings. Generated `lib/` and `lib-test/`, and `vendor/`, are
excluded. Test files may use `any` because the doubles poke React internals and
host globals.

Archived notes stay out of Prettier: their bodies are frozen. The upstream
README snapshots stay out too. Agent Notes and the changelog still have the
markdownlint 80-column check. A long verbatim error in a note is a fenced block,
which that check skips, rather than an inline span Prettier must keep on one
line. A table row is at most 120 characters
(`node scripts/check-markdown-tables.mjs`). markdownlint still skips tables: an
aligned command table does not fit in 80 columns. The upstream README snapshots
are excluded from the table check as well.

`pnpm install` points git hooks at `.husky` only when this checkout is the git
root. An install under `node_modules` skips that step and still builds the
client bundle. The pre-commit hook runs ESLint and Prettier on staged files. CI
runs `pnpm format:check` and `pnpm lint` once, in a job that does not depend on
a DSH version.

## Alternatives considered

**Use Biome for both jobs.** One binary is less to install. This repo already
relies on typescript-eslint's recommended rules and a separate markdown
line-length check. Biome would replace both with a third policy.

**Leave Markdown to the hand wrap.** `proseWrap: preserve` pulls a wrapped code
span onto the next line without its indent. `proseWrap: always` reflows to the
same 80-column contract and keeps the span whole.

**Limit tables to 80 columns with the prose check.** A three-column command
table does not fit in 80 once Prettier pads each column. 120 keeps that table on
one line.

**Format archived notes too.** Their bodies are the historical record and are
not updated in place. Prettier would also swap an emphasis marker there.

**Turn on type-checked ESLint.** `tsc` already runs on every CI version leg. A
second typed pass is slower and overlaps that gate.

**Enable the React Compiler hook rules.** They judge effect patterns the client
already uses. `rules-of-hooks` and `exhaustive-deps` are the stable pair.

## Consequences

The first adoption reformats the existing sources, including repository
Markdown. A later edit that Prettier or ESLint rejects fails the lint job and
the pre-commit hook. Dependency installs do not gain a hook. Markdown outside
Agent Notes and `CHANGELOG.md` is formatted, and only those two stay under the
markdownlint line-length check.
