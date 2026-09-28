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

## Extension (card 2f1c7846): every OTHER by-name skill instruction gets a note, not a rewrite

The exact-clause rewrite leaves two by-name instructions dangling for a codex session: the seeded Web Designer's "also invoke the **web-design** skill by name", and free-form DB-resident briefs (a Step 0 "Run `/worker`"). They cannot be rewritten without guessing at user text, which the rulings above forbid. Instead `withCodexRoleDoctrine` also prepends one `[loom:skills-note]` paragraph (`codexSkillsNote`) telling the session how to READ such an instruction: open `<SKILLS_DIR>/<name>/SKILL.md`. Order is pointer, note, brief; the brief is byte-identical.

- **The list is computed at spawn**, from store dirs that hold a `SKILL.md`, intersected with the session's profile-pinned `skills` subset when non-empty (the role's own doctrine skill is kept, as `injectSkills` does) — so the note can never name a missing or out-of-profile file. `opts.skills` is threaded from the codex kickoff call in `pty/host.ts`.
- **A worker's `/worker` is the condensed `AGENTS.md`, never the store copy.** `worker` is dropped from a worker's list and the note says so. The store file is ~57 KB (~14k tokens) and written for claude tools; the condensed doctrine is deliberate (card `887e10b8`).
- **One alias rule only:** a name not listed, but `loom-<name>` listed, means `loom-<name>` (bundled skills carry that prefix to avoid colliding with personal skills, `@decision d63585ca`). `/pickup` therefore resolves when only `loom-pickup` is in the store.
- **Emitted unconditionally** (no sniffing of the brief for skill mentions, which can false-negative), except when the list is empty and the role is not worker. Cost: roughly 130-160 tokens per fresh codex kickoff; worst case measured at 757 chars with the whole real skill set listed. Claude never reaches this path.
- **Not proven:** the tests prove the note's content, ordering, filtering and wiring, not that a real codex model obeys it.

### Do not

- Do not rewrite the user's brief, or add a second exact-string rewrite coupled to a seed constant (e.g. the Web Designer sentence): the note already covers it and the rewrite only adds fragility.
- Do not add aliasing or fuzzy matching beyond `loom-<name>`.
- Do not point a worker at the full store `worker` SKILL.md: it duplicates the condensed `AGENTS.md` at ~14k tokens.
- Do not list a skill the session cannot read (no `SKILL.md`, or outside its pinned subset).

## Source

`packages/daemon/src/pty/codex-doctrine.ts`, `adaptDoctrineLoadForCodex` and `codexSkillsNote`; tests `packages/daemon/test/codex-doctrine-skill-load-rewrite.mjs` and `packages/daemon/test/codex-skills-note.mjs`.
