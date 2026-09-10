# 75a0755d — reset must re-sync EVERY tracked file's base, not just SKILL.md's

## Narrative

Card 75a0755d (CR M1): `resetSkillToBundled` restores a bundled skill by `rmSync` + `cpSync` of the whole directory from the asset, which correctly rewrites every reference doc / helper script file to shipped bytes on disk. But the base-snapshot re-sync that ran after it originally only touched SKILL.md's own base file. That left every OTHER tracked file's base stuck at its pre-reset value: `mine` was now shipped, but `base` still pointed at the old, pre-reset content, so the file read `customized:true` AND `updateAvailable:true` forever after — a permanently-wrong divergence flag reintroduced by the one action whose entire job is "discard and re-sync". The fix re-syncs `base` for the whole directory (SKILL.md's base plus every non-binary tracked file's base), not just SKILL.md's.

This same card (CR M2) also widened `skillUpdateAvailable`'s adopt/preview guard so it goes true when only a non-SKILL.md file has an update, matching what `listSkills` already showed in the badge (see `packages/daemon/src/skills/store.ts`, above `skillUpdateAvailable`).

## Do not

- Do not add a new tracked-file kind to the skill directory without also covering it in `resetSkillToBundled`'s per-file base re-sync loop — a partial re-sync is what caused this bug the first time.
- Do not treat "reset re-synced SKILL.md" as sufficient evidence the whole directory is back in sync — verify the per-file base loop actually ran for every non-binary tracked file.

## Source

JSDoc comment in `packages/daemon/src/skills/store.ts`, above `resetSkillToBundled`: lines 831-857 (pre-tranche), as of this tranche's HEAD (main `ca6192ec`). Introducing commit for this paragraph: `b2e701b129c11ddf3825348eee9a2a8039d46b81` ("fix(skills): fast-forward reference/ files for pristine skills, not just SKILL.md").
