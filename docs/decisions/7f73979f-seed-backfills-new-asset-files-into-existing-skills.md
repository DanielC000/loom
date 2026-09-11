# 7f73979f — seed backfills a brand-new asset file into an already-seeded skill

## Narrative

A present `SKILL.md` means a genuine skill (possibly UI-edited) and `seedGlobalSkills` leaves it
untouched — EXCEPT that non-`SKILL.md` asset entries (a `scripts/` helper, a `references/` doc,
`NOTICE`, …) shipped by a LATER asset update are still backfilled here (`cpSync(..., { force: false
})`), so a BRAND-NEW file lands even for a skill seeded before it existed.

This was not hypothetical: the `/orchestrate` (and web-design) skill told workers to serve static HTML
via `scripts/serve-static.mjs`, but that script was not materialized in worker worktrees whose store
copy of `orchestrate` predated the script's addition to the bundled asset — `seedGlobalSkills`'s
seed-if-absent gate on `SKILL.md` never re-visited a skill dir once its `SKILL.md` existed, so the
new, non-`SKILL.md` file never backfilled. Workers hand-rolled their own loopback server instead — the
exact rework the skill exists to avoid. Fix (commit `e247cba5`): re-run the asset copy with
`force:false` even when `SKILL.md` already exists, so new files land while every existing file
(including an edited `SKILL.md`) stays untouched.

An EXISTING reference/script file's own CONTENT updates are a separate, per-file base-tracked
fast-forward mechanism (`seedFileBaseSnapshots` / `autoFastForwardPristineSkills`, card 75a0755d) —
not this seed-if-absent copy, which only ever adds files that are wholly absent from the store.

## Do not

- Do not assume a present `SKILL.md` means the whole skill dir is up to date — a bundled asset update
  can add a file (script/reference/NOTICE) that an already-seeded store dir will never receive unless
  the non-`SKILL.md` backfill re-runs on every boot.
- Do not fold new-file backfill and existing-file content fast-forward into one mechanism — they have
  different safety properties (backfill can never clobber; content fast-forward must never clobber a
  user edit) and are deliberately kept separate (see card 75a0755d for the content-update path).

## Source

JSDoc comment in `packages/daemon/src/skills/seed.ts`, above `seedGlobalSkills`: lines 31-35 (the
`EXCEPT that non-SKILL.md asset entries…` clause and the following contrast sentence), as of this
tranche's starting HEAD (main `6129350a`). Introducing commit: `e247cba59493fed7d285ae6e6ce6bc2bd9eb72b2`
("fix(orchestrate): skill cites .claude/skills/orchestrate/scripts/serve-static.mjs to eyeball static
HTML, but that script is not materialized in worker worktrees — workers hand-roll a loopback server (the
rework the skill says to avoid)").
