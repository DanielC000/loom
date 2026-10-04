# aecc6551 — reserved-home agent seeder pattern (two gotchas)

## Narrative

`packages/daemon/src/setup/seed.ts` seeds several standing agents (Workspace Auditor, Elevated
Operator, Companion — and the operator agent itself) into the one reserved "Platform" setup home.
Each of these seeders repeats the same two hazards, and later sites cite them as "gotcha #1" /
"gotcha #2" rather than re-deriving them:

**Gotcha #1 — resolve the reserved home by a STABLE id marker, falling back to name, never a
name-agnostic reserved lookup.** More than one reserved project can exist in the same install (this
ungated "Platform" setup home, and the separate `LOOM_DEV`-gated "Loom Platform" dev home). A
name-agnostic reserved-project lookup would have no way to tell them apart and risks seeding or
renaming the wrong one. A pure name-scoped lookup isn't enough either: a human can rename a reserved
project's `name` via `PATCH /api/projects/:id` (only `repoPath` rebind/archive/delete are refused for
`p.reserved`), so a name-only gate would see no match after a rename and mint a second, empty home on
the next boot (card `a47dd144`). Every seeder here resolves via `resolveSetupHome`/
`resolvePlatformHome` (`projects/reserved-home-markers.ts`'s `resolveReservedHomeByMarker`): a stable
app_meta id marker FIRST, falling back to the same specific-name match as before (current name, then
any legacy literal; ARCHIVE-AGNOSTIC — `getReservedProjectByNameIncludingArchived` — so an archived
home still counts as already-seeded rather than growing a second, live duplicate beside it) only for
an install that pre-dates the marker, backfilling it the instant a match is found. The marked row is
validated before being trusted — it must exist, be `reserved`, and be neither the OTHER home's marked
id NOR a row named for the other home's own name candidates (round 2, card `a47dd144`, closing the gap
where the id-check alone missed a mis-stamped marker when the OTHER home's own marker was never
stamped) — so a stale, mis-stamped, id-colliding, or name-colliding marker falls through to the name
match instead of being trusted; a marker whose row carries some OTHER, unrelated name is still
accepted, since there's nothing left to disambiguate it against. First named at `seedSetupAgentRename`
(commit `7ef34ce2`); upgraded to the marker scheme (and its round-2 name-collision check) by card
`a47dd144`.

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

## Scope note (card `a47dd144`, 2026-10-04 + round 2)

Every lookup this record's narrative describes (`setup/seed.ts`'s `seedSetupHome`,
`seedSetupAgentRename`, `seedSetupAuditorAgent`, `seedOperatorAgent`, `seedCompanionAgent`, and
`platform/seed.ts`'s `seedPlatformHome`/`migratePlatformPrompts`) resolves via the marker scheme
described in gotcha #1 above. `seedSetupProjectRename` (the "Getting Started" → "Platform"
legacy-literal migration) is NOT part of this: it is itself a by-name rename of a specific old
literal, not a "find the home" lookup, so it is unaffected and keeps resolving by name directly.
