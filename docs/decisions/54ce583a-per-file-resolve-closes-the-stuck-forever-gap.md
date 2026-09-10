# 54ce583a — per-file resolve closes the "stuck forever" gap for a customized-and-updated reference file

Source: commit `54ce583a9`, no board card.

## Narrative

Before `resolveSkillFile` (commit `54ce583a912f9eae41c8bfc2bdfa9aeebfe06b22`, no board card), a bundled skill's non-SKILL.md file that was BOTH customized (the user edited it) AND had a shipped update was permanently skipped by `advancePristineExtraFiles` — correctly, since auto-advancing would discard the edit. But that left the file's badge with no way to clear: the only remedy was Reset, which discards the WHOLE skill directory, not just that one file. `resolveSkillFile` is the non-destructive escape hatch for exactly this state, giving the user a per-file choice (`take:"mine"` or `take:"shipped"`) instead of an all-or-nothing directory wipe.

`expectedShippedHash` exists because `assets/**` is read LIVE from the package dir (no daemon restart needed to pick up a merged asset change — see `CLAUDE.md`'s "Caveat" on `packages/daemon/assets/**`): the shipped content the user saw when they opened the diff can literally change before they click a resolve button. Without the hash check, `take:"shipped"` would silently overwrite `mine` with content the displayed diff never showed — a discard behind a diff that no longer reflects reality, precisely the defect the whole per-file resolve feature exists to close, reappearing as a race. The same guard protects `take:"mine"` too, since it writes `base := shipped` and could otherwise record a base the user never actually saw.

## Do not

- Do not let `take:"shipped"` or `take:"mine"` skip the `expectedShippedHash` check — both write state derived from `shipped`, and either can silently disagree with what the user was shown.
- Do not route SKILL.md through this per-file resolve — it already has its own 3-way merge/adopt/reset flow, and a second "resolved" notion for that one file would be a footgun, not a convenience.
- Do not have `take:"mine"` go through `advanceExtraFile` or write a `.pre-ff-backups` entry — nothing is being overwritten, so a backup there would misrepresent itself as a copy of discarded content.

## Source

JSDoc comment in `packages/daemon/src/skills/store.ts`, above `resolveSkillFile`: lines 726-756 (pre-tranche), as of this tranche's HEAD (main `ca6192ec`). Introducing commit: `54ce583a912f9eae41c8bfc2bdfa9aeebfe06b22` ("feat(skills): per-file diff + non-destructive resolve beyond SKILL.md"), no board card id anywhere in the block or the commit message.
