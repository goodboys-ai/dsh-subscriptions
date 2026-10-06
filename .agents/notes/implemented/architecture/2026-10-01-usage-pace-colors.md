# Agent Note: Usage pace colors

Status: implemented

## Problem

Absolute usage bars cannot show whether quota consumption leads time progress.
Watchdog's used/elapsed ratio highlights early bursts but can label low usage
red, conflicting with red meaning near exhaustion. A flexible threshold editor
would add complexity the user explicitly rejects.

## Decision

One browser-local Usage coloring dropdown selects Standard (default, 10-point
allowance), Relaxed (15 points), or Remaining quota only (no yellow). All meters
use the same preset. Persistence validates values, falls back to Standard and
synchronizes same-origin tabs. Display preferences never change routing or
enforcement.

Validity and freshness precede pace warnings. Invalid percentages show no fill.
Failed refreshes, observations older than five minutes and expired readings
retain absolute green/red colors with an accessible stale explanation. The
marker does not depend on freshness; see the
[cursor note](2026-10-06-usage-cursor-timing-only.md). Unknown
pace also retains green/red: gray fills were barely visible in dark mode.
The pool cache preserves the original observation timestamp and explicitly
reports stale fallback after failures; successful RPC receipt is not sufficient
evidence of freshness.

Valid reported usage at least 90% is red in every preset. Below that, the
absolute fallback is green. Pace presets require fresh readings and reliable
time progress: yellow when unrounded used minus elapsed is at least the preset
allowance, otherwise green. Compare unrounded values and round only labels.

The marker uses explicit valid start/end intervals, currently supplied by Grok
periods and Cursor billing cycles. A duration enables inferred starts only with
provider-specific metadata (`fixedWindow`). Codex uses the duration reported
alongside its reset. Claude recognizes its five-hour session and seven-day
weekly buckets in both response shapes. Unknown kinds and reset-only windows
without a known duration do not acquire invented starts. Genuine sliding quotas
have no linear pace marker.

Settings reuse the neighboring native select, label, spacing, hint and theme
tokens. Short preset-specific hints explain yellow and red; meter tooltips
expose the applicable warning, remaining quota, elapsed progress and reset
countdown. Labels do not rely on color alone.

## Alternatives considered

**Watchdog pressure ratio.** Rejected because small early bursts can produce red
at low usage. Percentage-point allowances tolerate bursts without presenting a
constant-consumption forecast.

**Any usage above elapsed turns yellow.** Normal bursts and rounding make this
noisy. Standard permits a 10-point lead before warning.

**15-point default.** More forgiving for batch work but delays short-window
warnings. Keep it as Relaxed rather than the default.

**Absolute colors only.** Cannot communicate pace; retained as the
remaining-only opt-out.

**Separate mode/allowance controls, numeric inputs and per-provider overrides.**
Rejected after the user's simple-configuration request. Three presets cover two
tolerances and a distinct opt-out without an extra control.

## Verification and limits

Kimi K3-256K and Grok 4.7 (xhigh) independently flagged stale/invalid coloring
and kind-based interval inference. Their findings informed the implementation;
Grok supported all three simplified presets. Its lengthy helper suggestion was
not adopted, particularly the blanket unknown-timing wording that contradicted
fresh red and remaining-only green.

Unit tests cover unrounded boundaries, all presets, invalid/unknown/expired
timing, observation aging, failure-cache timestamps, localized meter labels and
preference synchronization. Real DSH 0.2.0-rc.2 host-e2e exercises baseline and
candidate with the same isolated provider fixtures and viewport, captures
usage-dialog/settings screenshots, and verifies the coloring dropdown's values,
saved selection and reload persistence. These fixtures prove rendering and host
integration, not live provider interval semantics. No new fixed-duration
assumption is enabled without provider evidence.

Both locales render in server-side component tests; actual host screenshots
cover English in light and dark themes at the driver's default viewport.
Chinese-language and narrow-layout host screenshots remain a verification limit.

## Consequences

Yellow describes pace and red describes little remaining quota; neither predicts
interruption. Freshness handling prevents cached numbers from gaining pace
warnings solely as time advances; accessible stale labels qualify their retained
absolute colors. Unknown intervals keep visible green/red bars without markers;
a known interval keeps its marker even when the reading is stale.
One additional dropdown, localized labels and observation metadata
buy clearer semantics without provider-specific tuning. Revisit the defaults
only if real usage shows frequent unactionable or late yellow warnings.
