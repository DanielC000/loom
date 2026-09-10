# 6d5a6280 — `Question.permissionScopeHint` is the asker's suggestion, never the human's decision

## Narrative

`Question.permissionScope` (the DB column `permission_scope`) used to read exactly like the human's decided answer, but it is only what the asking agent typed at ask time, and it can silently disagree with both the request body prose and with `decidedScope` — the human's actual answer-time grant.

The fix was a rename, not just a doc-comment: `permissionScope` became `permissionScopeHint` (the DB column itself is unchanged, only the mapped field/label), and the doc comments were strengthened so the distinction is visible in the name itself, not just in a comment a reader can skip.

This is cited in `packages/daemon/src/profiles/field-consumers.ts`'s header as one of the two prior "structured field that lies" instances (alongside `cb7d6998`) that motivated building `PROFILE_FIELD_CONSUMERS` as a machine-readable registry rather than relying on doc comments a human might or might not read — see `docs/decisions/d34dd208-structured-field-that-lies-class.md` for that registry's own decision record. Unlike the Profile-field instances that registry actually bounds, this one is a Question/Request field, not a Profile field — it is cited there as a precedent for the general failure shape (a structured field whose apparent meaning silently diverges from what a reader would assume), not as an instance the registry itself covers.

## Do not

- Do not read `permissionScopeHint` as the human's decision — it is the asking agent's suggestion at ask time. Use `decidedScope` for what was actually granted.
- Do not assume the rename alone is the whole fix — the point is that the distinction had to be visible in the field's NAME, because a correct doc comment on the old name was already there and was not sufficient (see project memory `shipping-a-detector-is-not-someone-reading-it` for the general form of this lesson).

## Source

Inline comment in `packages/daemon/src/db.ts`, above the `permission_scope` column in the `questions` table DDL (around line 1187, pre-tranche-1 numbering), introduced by commit `360c78d75e0557b9a157d5d10e48957bc3edc89b` ("fix(mcp): rename permission ask's scope hint to distinguish it from the decided grant"). Cited in `packages/daemon/src/profiles/field-consumers.ts`'s header (lines 1-34, pre-tranche-1 numbering). Relocated by card `612cb81c` (tranche 1).
