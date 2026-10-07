# Agent Note: Always-show badge rotation

Status: implemented

## Problem

The composer usage pill follows the session's current model. When that
model has no quota source and the view holds no earlier subscription
selection, the pill disappears entirely, so users lose the at-a-glance
quota readout exactly when they switch to an API-key model. The user asked
for an option that keeps a bar visible at all times, cycling through the
providers we have usage for when the current provider is not one of ours.

## Decision

The status-bar quota display preference gains a third mode, `always`,
alongside `recent` and `hidden`. The badge resolves the pill through
`rotatingDisplay(displays, current, step)`:

- A provider with usage matching the session's current model pins the
  pill; the rotation never moves it. `always` reads the live selection,
  not the retained subscription — retention is a `recent` behavior.
- Without a match, the pill shows one provider at a time, walking the
  display order (roster order: Codex, Claude, Grok, Copilot, Antigravity,
  Cursor, then the external sources) and wrapping around. The rotation
  index is taken modulo the current provider count, so providers appearing
  or dropping out stay in range; the provider under a given tick may shift
  when the roster changes.
- No provider reports usage means no pill, in every mode.

The step advances on a 10-second interval that runs only while `always`
is selected; the interval is a display cadence, not a data poll — usage
still refreshes on the shared 15-minute poll. The compact readout is
model-scoped only while the pill shows the current model's provider; a
rotated provider reads at account level (Antigravity shows its model
count, not a model that is not in use). The expanded dialog leads with
the provider the pill was showing when it opened and holds that order
while open, so a dialog does not reorder under a reading user.

The mode persists in the same browser-local key with the same validation
and cross-tab synchronization; unknown stored values fall back to
`recent`. The settings select gains a third option in both locales.

## Alternatives considered

**Rotate only when no subscription selection is retained.** Rejected: the
retained subscription pins the pill forever in `recent` mode, which is the
behavior the new mode exists to escape. `always` ignores retention for the
pill and rotates whenever the current model itself has no usage.

**Random or weighted provider order.** Roster order is predictable and
matches the dialog's ordering; a weighted scheme would need a rationale
the display cadence does not have.

**Rotating through individual accounts rather than providers.** The pill
already reads only the default account per provider; account-level
rotation would multiply cycle length without adding information.

**A per-provider pin list or manual cycle order.** Rejected for the same
reason the pace presets rejected a threshold editor: one extra option,
zero extra configuration.

## Verification and limits

Unit tests pin the rotation: a matching provider holds at any step, the
sequence walks and wraps in display order, negative and non-finite steps
stay in range, a roster change at one step re-bases the index (in range,
but the provider under the tick may shift), a provider gaining usage while
current stops the rotation, and an empty roster renders nothing. The
offline Playwright check switches to `always`, verifies the pin under a
subscription model, then the Codex → Grok → Antigravity → Codex cycle
after switching to an API model — the retained subscription must not pin
— with a shortened cadence injected through the component's test-only
`rotationMs` prop. It also checks that a pinned Antigravity model keeps
its model-scoped readout, and that a dialog opened from a rotated pill
leads with the provider shown. The production cadence (10 seconds) is not
exercised in the browser check; the cadence constant itself is a
verification limit.

## Consequences

The pill stays informative on API-key models at the cost of a moving
target: the provider shown changes under the user every 10 seconds while
no quota-backed model is active. Pinning on any matching provider keeps
the common case (a subscription model in use) as stable as `recent`.
One more localized option and a rotation interval buy a persistent
readout without new configuration. Revisit the cadence if 10 seconds
proves too fast to read the compact segment.
