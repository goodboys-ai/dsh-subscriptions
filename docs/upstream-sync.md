# Upstream sync

This plugin derives from [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions)
(npm `dsh-plugin-subscriptions`). The fork rewrote the settings UI, retired
the plugin-level proxy in favor of host-managed network routing, added the
Cursor/OpenCode Go/Kimi Code integrations, and widened the DSH compatibility
window — areas where a wholesale merge can never apply. Provider protocol
fixes, auth-store robustness, and usage accounting still land upstream,
though, and this repo tracks them selectively.

## Sync point

The machine-readable record is [upstream-ports.json](upstream-ports.json): one
entry per upstream commit since the baseline, with how this fork treated it.
`node scripts/check-upstream-ports.mjs` fails when a commit is unclassified,
when a ported entry names a commit that is not in our history, or when a decline
rests on a host-capability claim the published host package contradicts. This
section is the human summary; the JSON is the source of truth.

- **Baseline:** upstream `v0.9.5` — commit `75a83460b27f869d6972c6d0a2b39d76ca49eabb` (2026-09-28).
- **Reviewed up to:** upstream `v0.9.8` — commit `85e6c6c9`.
- **Already covered before this ledger existed:** `f6e1b3f1` (the Settings card
  shows the CLI version Codex and Claude present, upstream issue
  [#108](https://github.com/V1ki/dsh-plugin-subscriptions/issues/108)). Ported
  under a fork commit that is not a descendant of the upstream sha, which is
  why the ledger exists.
- **Ported since:** Codex reasoning-effort `ultra` handling (`0c65c7d0`,
  `527f4d90`); Codex reset credits, end to end (`62453f2f`, `9c0ae036`,
  `d7a7f752`, `53577040`, `b0c6220a`); the Claude prompt-cache TTL setting
  (`f2622e49`, `8a80d4e4`); the Claude image-request budget (`eb429662`); and
  the native-UI restyle (`080450d0`).
- **Deliberately not taken:** upstream's release and CI work (`564be625`,
  `800a08f5`, `69ac9c37`, `74f44a29`, `d8ab13e9`) and its peer-range move
  (`867136be`) — this repo versions and releases on its own policy, and its
  bounded range already admits the DSH versions upstream is adding.
- **Open decisions:** `998cea06` and `a85fb93a` (display names) collide with
  this fork's own localized naming; `f359301e` (hourly catalog refresh)
  changes list freshness; `c5cc37fe` is being split, since its release
  mechanics do not apply but its account-scoped replay and SSE stream cleanup
  are real gaps here.

## How the baseline was determined

1. `docs/upstream-README.md` is a snapshot of upstream's README; it diffs
   smallest against the `v0.9.5` tag (11 changed lines: one added header
   comment, one `web_search` wording line, and the Proxy section replaced
   by the fork's Network routing note).
2. `src/auth/store.ts` and `src/client/fast-command.ts` in this repo are
   byte-identical to upstream at `v0.9.5`; every other shared file differs
   only by the fork's mechanical renames (`proxiedFetch` → `hostFetch`,
   package name) or the deliberate proxy-layer removal.
3. This repo's git history contains every upstream commit through `v0.9.5`
   as a literal ancestor (the repo was derived from a full upstream clone);
   `git merge-base --is-ancestor 75a8346 HEAD` confirms it.

## Re-sync procedure

The shared commit graph makes syncs git-native — no patch archaeology:

```sh
git remote add upstream https://github.com/V1ki/dsh-plugin-subscriptions.git
git fetch upstream --tags
git log --oneline 75a8346..v0.9.6   # replace with the new tag
```

Classify each commit: cherry-pick directly when the touched files survive
here mostly intact; re-implement when the commit targets a rewritten area
(the settings section, the RPC surface, the proxy) and only its intent
applies. After porting, update the Sync point section above: move the
baseline to the new tag, list what was ported or re-implemented on top, and
note any commits deliberately skipped with the reason.

The upstream README snapshots (`docs/upstream-README.md`,
`docs/upstream-README.zh.md`) are refreshed only when the baseline moves;
their header comment records which tag each snapshot matches.

The Cursor transport is a separate vendor record, not an upstream sync:
see [cursor-origin.md](cursor-origin.md).
