---
name: subscription-hub-prose-standard
description:
  Use when writing, reviewing, or trimming project-authored prose in
  dsh-subscriptions, including docs, Agent Notes, code comments, tests, UI copy,
  model-visible text, and diagnostics.
---

# Subscription Hub prose standard

Write enough to preserve the contract, then remove reasoning transcripts,
repetition, and decoration. This is editorial guidance, not a script or a
deletion target. Use the requested files or PR as the scope. For a review,
report findings; edit when the task authorizes changes.

Leave `vendor/cursor/` and the upstream README snapshots out of broad prose
passes. They are imported sources; inspect them only when needed as evidence or
when the task explicitly targets them. Edit the owning source before generated
`lib/` output and rebuild derivatives instead of hand-editing them.

## Preserve the complete proposition

Before changing a passage, identify its actor and action; conditions, timing,
and ordering; must/may/never distinctions; exceptions; ownership; side effects;
failures; and consequences. Shorter text is useful only when those facts survive
and the result is clearer. Add or restore prose when code and types do not
communicate a needed contract.

Keep behavior, failures, ownership, and consequences where a caller or
maintainer needs them. Give a full explanation one home and link to it for
rationale, algorithms, or history; essential contract facts may repeat at their
point of use. Keep non-obvious rationale nearby when omitting it could cause
misuse or an incorrect simplification. Name the exact API, field, check, or
failure before using broad terms such as "surface" or "gate".

## Coverage by location

- **Public JSDoc:** document caller-visible return distinctions, failures, side
  effects, ownership, timing, cancellation, and durability where the type and
  implementation do not make them clear. Provider adapters also need their auth,
  token, refresh, and usage contracts at the relevant API.
- **Internal and module comments:** explain non-obvious invariants, race
  ordering, security boundaries, responsibilities, and surprising failures. Do
  not narrate control flow or restate code.
- **Tests:** explain why a non-obvious fixture, assertion, accommodation, or
  real entry path is necessary. State what a fake proves and what remains
  untested; do not inventory cases or walk through assertions.
- **README and docs:** state configuration, behavior, failures, limitations, and
  observable verification. Keep the needed local contract and link to the owner
  of extended detail. Follow [docs/AGENTS.md](../../../docs/AGENTS.md) for
  document ownership and language.
- **Agent Notes:** retain unique rationale, genuine alternatives, consequences,
  shipped verification evidence, and named coverage gaps. Implemented notes
  describe current behavior, not a completed task list. Follow the
  [note rules](../../notes/AGENTS.md).
- **UI and model-visible text:** wording is behavior. Inspect changed UI copy in
  its rendered context, including accessibility names and tooltips; check tool
  descriptions and results through their owning request path.
- **Diagnostics:** name the failed subject, violated rule, and correction when
  they are not obvious. Do not narrate internal execution.

Preserve searchable mechanism names and meaningful emphasis on requirements,
timing, and exceptions. Remove decorative emphasis and explanations repeated
from another owner.

## Review and verification

Read the owning code or document before judging a passage. Classify each
candidate as keep, add, trim, restore, or restructure; do not shorten prose to
meet an arbitrary count. Recheck analogous passages after finding a rule. Run
the narrow checks that match the changed surface: note lint and relative links
for notes, build or tests for code comments that describe behavior, and rendered
or request-path checks for user-visible text. Report the inspected scope and
checks actually run.
