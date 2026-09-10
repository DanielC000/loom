# 5ddc2289 — auto-retire orphaned bundled-skill store dirs left behind by a rename or unbundle

## Narrative

Card 5ddc2289 (see also card 187873f9): `seedGlobalSkills()` is seed-IF-ABSENT — it adds a new/renamed bundled-skill name but never removes the OLD store dir once that skill stops being bundled (a rename, e.g. `pickup` -> `loom-pickup`, or an unbundle, e.g. `codescape`/`research` dropped from the published release only — see `RETIRED_BUNDLED_SKILL_NAMES` in `store.ts`). The orphaned dir lingers in the store forever: `injectSkills` mirrors the WHOLE store into every session, so every spawn keeps injecting a skill nothing references anymore, spending `skillListingBudgetFraction` on dead weight.

`retireOrphanedBundledSkillDirs()` closes this at boot. Growing the hardcoded `RETIRED_BUNDLED_SKILL_NAMES` allowlist is how a future rename or unbundle gets auto-retired too — it is deliberately hardcoded, never derived (e.g. from "no matching asset dir"), because asset-absence alone can't distinguish a retired bundled skill from a user's own UI-created skill of the same name.

## Do not

- Do not derive the retirement list from "no matching asset dir" instead of the hardcoded allowlist — asset-absence alone can't tell a retired bundled skill apart from a user-created skill sharing that name.
- Do not retire a dir whose base snapshot is missing — a missing base is not proof of pristine (it could be a user-created dir sharing a retired name); leave it untouched, fail-closed, same posture as a user-created asset-less skill.
- Do not let this function touch `~/.claude/skills` (the user's personal store) — it only ever walks `SKILLS_DIR`/`SKILL_BASE_DIR`.

## Source

JSDoc comment in `packages/daemon/src/skills/store.ts`, above `retireOrphanedBundledSkillDirs`: lines 488-508, as of this tranche's HEAD (main `ca6192ec`).
