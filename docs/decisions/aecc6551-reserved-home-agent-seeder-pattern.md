# aecc6551 — reserved-home agent seeder pattern (two gotchas)

## Narrative

`packages/daemon/src/setup/seed.ts` seeds several standing agents (Workspace Auditor, Elevated
Operator, Companion — and the operator agent itself) into the one reserved "Platform" setup home.
Each of these seeders repeats the same two hazards, and later sites cite them as "gotcha #1" /
"gotcha #2" rather than re-deriving them:

**Gotcha #1 — resolve the reserved home by NAME, never a name-agnostic reserved lookup.** More
than one reserved project can exist in the same install (this ungated "Platform" setup home, and
the separate `LOOM_DEV`-gated "Loom Platform" dev home). A name-agnostic reserved-project lookup
would have no way to tell them apart and risks seeding or renaming the wrong one. Every seeder here
resolves via `db.getReservedProjectByName(SETUP_PROJECT_NAME)`, never a bare "any reserved project"
query. First named at `seedSetupAgentRename` (commit `7ef34ce2`).

**Gotcha #2 — seed each standing agent via its OWN separate boot-time, name-presence-keyed
function, never by folding it into `seedSetupHome`.** `seedSetupHome` is seed-if-absent for the
WHOLE home: it no-ops entirely once the reserved project row exists. If a new bundled agent (the
Workspace Auditor, later the Elevated Operator and Companion) were added by extending
`seedSetupHome` itself, an install that already has the home from an earlier version would never
receive the new agent — the whole function would already be no-opping on the home's presence
before it got anywhere near the new agent-seeding code. A separate seeder, run at boot AFTER
`seedSetupHome` and keyed on that one agent's own name-presence check, backfills the agent onto
existing installs on upgrade AND still covers a fresh install in the same boot (where
`seedSetupHome` creates the home + first agent, then this seeder adds its own on the same pass) —
without any structural change to `seedSetupHome` that could risk the original seed or its
name-scoped idempotency. First explained at `seedSetupAuditorAgent` (commit `aecc6551`, "B4").

Both gotchas recur verbatim (or near-verbatim) at every later standing-agent seeder added to this
file — `seedSetupAuditorAgent`, `seedOperatorAgent`, `seedCompanionAgent` — each restating them
independently rather than pointing at one place. This record is that one place.

## Source

Gotcha #1 introduced by commit `7ef34ce2` ("refactor(platform): rebrand Setup Assistant operator
→ Platform + agent-rename migration (A2)", 2026-06-23). Gotcha #2 introduced by commit `aecc6551`
("feat(platform): seed bundled Workspace Auditor profile + agent into the Getting Started home
(B4)", 2026-06-23). No board card cites either — this is why the anchor is keyed on the `aecc6551`
commit sha rather than a card id (see `CLAUDE.md`'s `sha:` decision-anchor sigil).
