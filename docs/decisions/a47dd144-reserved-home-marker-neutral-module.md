# a47dd144 — the reserved-home id markers (and, since round 2, display names) live in a neutral module

## Narrative

Each reserved home (the ungated "Platform" setup home, and the `LOOM_DEV`-gated "Loom Platform" dev
home) is identified by a daemon-GLOBAL `app_meta` key holding that ONE home's own project id — a
STABLE discriminator that survives a later rename of the project's `name`. A rename is deliberately
allowed on a reserved project via `PATCH /api/projects/:id` (`gateway/server.ts`) — only a `repoPath`
rebind, archive, and delete are refused for `p.reserved`. Before this marker existed, `setup/seed.ts`
and `platform/seed.ts` resolved "does the home already exist" purely by NAME
(`db.hasReservedProjectNamed`/`db.getReservedProjectByName`), so a rename made the next boot mint a
second, empty home under the expected name.

The two marker keys (`SETUP_HOME_PROJECT_ID_KEY`, `PLATFORM_HOME_PROJECT_ID_KEY`) are kept in this
neutral module — never in `setup/seed.ts` or `platform/seed.ts` themselves — so each seeder can
cross-validate its own marker against the OTHER home's marker (`resolveReservedHomeByMarker`'s
`otherMarkerKey`) without the two seed files importing one another.

## Round 2 (card `a47dd144`) — the two homes' own display names moved here too

For the same cross-import-avoidance reason, the two homes' display names
(`SETUP_PROJECT_NAME`/`LEGACY_SETUP_PROJECT_NAME`/`PLATFORM_PROJECT_NAME`) also moved into this
module: the id-collision check alone misses a marker that points at the OTHER home's row before that
other home's OWN marker has ever been stamped (nothing to collide against by id). Catching that case
needs each resolver to recognise the OTHER home's name (`otherNameCandidates`), which it can only do
without a cross-import if the names are defined in this shared module instead of in each other's seed
file. `setup/seed.ts` and `platform/seed.ts` re-export these under their existing names, so every
other importer of `SETUP_PROJECT_NAME`/`PLATFORM_PROJECT_NAME` is unaffected.

## Do not

- Never resolve a reserved home by name alone — a human can rename a reserved project via
  `PATCH /api/projects/:id`, so a name-only gate mints a duplicate home on the next boot after a
  rename. Resolve via the stable id marker first, falling back to a name match only as the
  pre-marker/repair path.
- Never move the two homes' display name constants back into `setup/seed.ts`/`platform/seed.ts` —
  that would force `resolveReservedHomeByMarker`'s name-collision check to either cross-import the
  two seed files (circular) or go blind to a mis-stamped marker whose target home's own marker was
  never stamped (the exact round-2 gap this fix closed).

## Source

`packages/daemon/src/projects/reserved-home-markers.ts` (module header + round-2 addition). No board
card's own body carries this narrative verbatim — extracted from the module doc comment per
`CLAUDE.md`'s comment taxonomy (card `90b19799`) at manager direction after the round-2 `worker_report`.
