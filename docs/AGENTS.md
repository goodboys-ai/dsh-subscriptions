# Documentation standard

Follow the
[prose standard](../.agents/skills/subscription-hub-prose-standard/SKILL.md).
Write new project-authored docs in English. Preserve existing Chinese and
bilingual material when maintaining it; the upstream README snapshots are source
copies.

Standing docs describe current behavior and the reader's contract. Keep the
configuration, failures, limitations, and consequences needed to use a feature
in its owning doc. Link to Agent Notes for the fuller rationale; a link does not
replace essential behavior at the point of use.

- `compatibility.md` owns the DSH support window, version status, and release
  procedure.
- `testing.md` owns test layers, what each verifies, and coverage limits.
- Agent Notes own durable decisions and their alternatives; dated issue, PR, and
  verification reports retain the evidence from a particular run.

Avoid test counts in standing docs because they change with the suite. Dated
verification reports may keep counts that describe the recorded run.
