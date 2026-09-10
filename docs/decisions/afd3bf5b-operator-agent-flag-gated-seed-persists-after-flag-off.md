# afd3bf5b — the Elevated Operator agent row is flag-gated at seed time, but persists once seeded

## Narrative

`seedOperatorAgent` (Bucket 2b "Bounded Elevated Operator", `packages/daemon/src/setup/seed.ts`)
seeds the bundled Elevated Operator agent into the reserved "Platform" setup home, mirroring the
sibling seeders (`seedSetupAuditorAgent`, `seedCompanionAgent`) — SEED-IF-ABSENT BY AGENT-NAME,
scoped to the reserved home by name (gotcha #1, see
[[aecc6551-reserved-home-agent-seeder-pattern]]) — except this one is additionally FLAG-GATED: it
only seeds while `platform.operatorEnabled` is on, read LIVE via `isOperatorEnabled` — the same
helper the router and the REST gate both use, so the seed check and the runtime-access check never
drift independently.

A fresh install with the flag off never grows the agent row at all. Once seeded, the row
deliberately PERSISTS across a later flag-off: the row itself is inert on its own, and the surface
it drives 404s the moment the flag flips off, so leaving the row in place costs nothing — flipping
the flag is not treated as a retroactive-delete trigger. This mirrors every other seed-if-absent
agent in this file, none of which are ever retroactively deleted by a later config change.

The agent row and the operator SESSION are two separate concerns, deliberately kept apart: seeding
this agent row is not spawning a session. There is deliberately NO first-run auto-launch anywhere
for the operator — an operator is opt-in and elevated, and must NEVER auto-spawn. Session creation
stays human-REST-only, via `startOperator` (see
[[89d8e17d-elevated-operator-is-create-only-and-caller-flag-gated]] for that separate decision
about the session-spawn path itself).

## Do not

- Do not fold this seeder into `seedSetupHome` — same gotcha #2 as the other reserved-home
  seeders: `seedSetupHome` no-ops once the home exists, so a new agent added there would never
  backfill onto an existing install.
- Do not add a first-run auto-launch for the operator agent — it is opt-in and elevated by design;
  session creation must stay human-REST-only.
- Do not treat a `platform.operatorEnabled` flag-off as a signal to delete the already-seeded
  agent row — the row is inert on its own, and the surface gate (not row absence) is what actually
  enforces the flag.

## Source

Inline comment in `packages/daemon/src/setup/seed.ts` (`seedOperatorAgent`'s doc), extracted at
tranche 2. Introduced by commit `afd3bf5bd` ("feat(platform): scoped opt-in operator elevated
surface for end-user installs (Bucket 2b — needs an owner security decision)"). No board card
cites this decision — keyed on the `sha:` commit form (see `CLAUDE.md`'s `@decision sha:` sigil).
