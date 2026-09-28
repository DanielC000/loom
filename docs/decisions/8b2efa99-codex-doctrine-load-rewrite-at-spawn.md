# 8b2efa99 — the codex "load your doctrine skill" rewrite happens at spawn, not in the seeds

## Narrative

The seeded agent prompts (`setup/templates.ts`, `setup/seed.ts`, `platform/seed.ts`) open with "Load your **/X** doctrine skill first". A claude session satisfies that through its skill loader (`ROLE_DOCTRINE_SKILL`, `skills/inject.ts`). Codex has no skill-invocation tool, so for a codex session the first instruction dangled. Card `4bb795bb` (C1) added the `[loom:role-doctrine]` pointer atop a codex non-worker kickoff; this card makes the seeded sentence point at that delivery.

**Where the split happens: at spawn, in `withCodexRoleDoctrine` (`pty/codex-doctrine.ts`), applied only to the codex kickoff (`spawnCodexProcess`, `pty/host.ts`).** Seed time was rejected because:

- Seeded prompts live in the DB and are seed-if-absent: a reseed never reaches an existing row, and rewriting existing rows would clobber user edits.
- The claude-resolved prompt must stay byte-identical. A seed-time change edits the one string both harnesses read; a spawn-time transform on the codex-only path cannot touch the claude prompt or the stored row by construction.

The transform is keyed on the exact seeded clause (`Load your **/<skill>** doctrine skill first`) and rewrites only that clause, so a user-edited prompt without it passes through byte-identical and the rest of the seeded sentence still reads on. Three outcomes: non-worker with a pointer -> refers to the pointer; worker -> refers to the condensed `AGENTS.md` doctrine; anything else (store file missing, a different skill name) -> states the doctrine is unavailable rather than instructing a load.

## Do not

- Do not rewrite the seeded prompt constants or the stored `agents.startup_prompt` rows to fix this: it changes the claude prompt and clobbers user edits.
- Do not widen the match beyond the exact seeded clause to "catch" edited prompts — an edited prompt is the user's, and guessing at it risks corrupting it.
- Do not point the rewritten wording at the pointer when `codexRoleDoctrinePointer` returned null (missing store file) — it would name a pointer that was never delivered.

## Source

`packages/daemon/src/pty/codex-doctrine.ts`, `adaptDoctrineLoadForCodex`; test `packages/daemon/test/codex-doctrine-skill-load-rewrite.mjs`.
