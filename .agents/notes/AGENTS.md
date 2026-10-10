# Agent Notes — rules

Decision records for this repo. An Agent Note records a decision that the
code and docs can't carry on their own: the *why*, what was given up, and
what would prove it wrong.
Follow the [prose standard](../skills/subscription-hub-prose-standard/SKILL.md)
for what to preserve while editing a note.

## Layout

The path encodes status and kind:
`{lifecycle}/{class}/YYYY-MM-DD-topic.md`.

**Lifecycle** — the note's status; a note moves folders as it changes:

- `proposed/` — not yet built. `Status: proposed`.
- `implemented/` — shipped. `Status: implemented`. Kept current with what
  actually shipped: when the code moves a file, renames a package, or
  changes a key or default, update the note's facts in the same change
  (facts only — paths, names, structure — never the decision itself).
- `rejected/` — considered and declined.
  `Status: rejected — <why, in one line>`. Keep only while its rationale
  prevents a tempting, meaningful mistake; otherwise delete it.
- `archived/` — shipped, then replaced by a newer decision.
  `Status: archived — <successor note link>`. The body stays frozen as the
  historical record — facts are no longer updated in place — and the
  successor note links back to it.

**Class** — the kind of decision. Closed set; adding a class requires
updating this file:

- `provider` — a provider's protocol surface and what we chose to rely on.
- `architecture` — structural decisions about the shipped source.
- `process` — tooling, policy, and workflow around the code.
- `testing` — test infrastructure and strategy.

The filename date is when the topic was first proposed. There is no index
file — the tree is the index. Cross-references between notes use relative
markdown links, never bare prose, so they survive moves between folders.

## Format

Every note follows one format:

```markdown
# Agent Note: <title>

Status: implemented

## Problem
## Decision
…bespoke sections…
## Alternatives considered
## Consequences
```

- `## Problem` states the motivation, written to stand without the solution.
- `## Decision` describes shipped reality in the present tense. (In a
  `proposed/` note the section is `## Proposal` and may speak in the future
  tense; it also carries `## Acceptance criteria` and `## Risks`.)
- `## Alternatives considered` is **mandatory**: each genuine alternative
  and why it lost, one bold-led paragraph per alternative. A decision
  recorded without what it beat invites re-litigation — the failure these
  notes exist to prevent. Alternatives are recorded, never invented.
- `## Consequences` records what the trade-off cost **and** bought.

## When to write one

Write or update a note in the same PR as the change, and only for lasting
rationale that code, tests, and existing docs do not explain. Standing docs
keep current behavior and consequences readers need at the point of use;
notes own the fuller decision, alternatives, and verification boundary.
Move durable decision history out of standing docs and link to its note.

## Lint

Wrap prose at 80 columns. Run `npx --yes markdownlint-cli2@0.22.0` from the
repository root; CI runs the same pinned Markdown linter. The root
`.markdownlint-cli2.jsonc` enables only MD013, and checks Agent Notes and
`CHANGELOG.md`; it does not check the other repository Markdown. The
changelog is covered because it carries each release's user-facing claims
and nothing else was checking it. Code blocks, tables, and lines with
no whitespace past column 80 (such as an indivisible link) are exempt.
Archived notes remain frozen and are excluded from the wrapping check.

`node scripts/verify-agent-notes.mjs` (also a CI job) enforces the shape:
`{proposed,implemented,rejected,archived}/` lifecycle folders, the closed
class set,
`YYYY-MM-DD-topic.md` filenames, no index files, no legacy `docs/rfc`
homes, and the required sections — `## Problem` first,
`## Alternatives considered` always, plus `## Decision`/`## Consequences`
for implemented notes (`## Proposal`/`## Acceptance criteria`/`## Risks`
for proposed). Deliberately not linted: bilingual counterparts and frozen
archives — DSH-scale machinery this repo does not need. Run the script
before pushing a note.
