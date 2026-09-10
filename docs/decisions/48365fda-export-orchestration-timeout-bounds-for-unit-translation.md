# 48365fda — export the orchestration timeout MS bounds table so the Settings UI can translate units

## Narrative

`ORCHESTRATION_TIMEOUT_MS_BOUNDS` could have stayed inline in the zod schema `mcp/platform.ts`'s `orchestrationOverride` builds from. It's exported instead because the Settings UI's timeout fields are labelled and entered in SECONDS and multiply by 1000 on submit — with the bound only living inside the zod schema, the server's own out-of-range rejection quoted a raw millisecond figure into a form entered in seconds: a user who typed `2000` was told "expected number to be <=1800000" with no way to derive "max 1800s" from it. Two different project owners hit exactly this the same night and both concluded the validator itself was broken.

Duplicating the literal bound in `packages/web` instead of exporting it would just move the drift risk one layer up (the two copies could disagree). Exporting this table from `shared` lets both `mcp/platform.ts`'s validator and the Settings UI read the SAME source of truth and translate it into whichever unit the field is entered in.

## Do not

- Do not duplicate the numeric bounds as a second literal in `packages/web` — read `ORCHESTRATION_TIMEOUT_MS_BOUNDS` from `shared` instead, so the validator and the UI can never disagree.
- Do not let a rejection message quote a raw millisecond figure into a field labelled/entered in a different unit — translate it into the field's own unit first.

## Source

JSDoc in `packages/shared/src/config.ts` above `ORCHESTRATION_TIMEOUT_MS_BOUNDS`, originally lines 225-231, as of this tranche's HEAD. Relocated by card `6377d105` (tranche 1 on `shared/config.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
