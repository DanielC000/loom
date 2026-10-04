# db1e4bb8 — the reserved setup-home rename backfill is boot-ordered before seedSetupHome (no longer the sole double-seed guard — see card a47dd144 round 2)

## Narrative

`seedSetupProjectRename` is the GUARDED one-shot rename of the reserved "Getting Started" →
"Platform" setup home row, for installs that seeded the home before that rename shipped
(`packages/daemon/src/setup/seed.ts`). It is the project-level analog of `seedSetupAgentRename`
(see [[aecc6551-reserved-home-agent-seeder-pattern]] for that sibling's own gotchas).

`seedSetupHome`'s absence-check is no longer keyed on the NEW name only (card `a47dd144` superseded
this in MECHANISM): it resolves via `resolveSetupHome` — a stable app_meta id marker first, falling
back to a name match that tries the CURRENT name (`SETUP_PROJECT_NAME`, "Platform") before the
LEGACY literal (`LEGACY_SETUP_PROJECT_NAME`, "Getting Started"). Every OTHER resolver
(`getReservedProjectByName`, `/api/setup/home`, the workspace-audit suggest target) looks up the new
name only — `resolveSetupHome`'s own legacy-literal fallback candidate is the one exception.

Because of that fallback, running `seedSetupHome` BEFORE the rename backfill no longer mints a
duplicate home even on a pre-rename install (verified 2026-10-04, card `a47dd144` round 2):
`resolveSetupHome` finds the existing row via its legacy-name candidate, no-ops, and backfills the
marker to that row's id; the rename then still finds and renames the SAME row on its own next run.
The original boot order (rename THEN `seedSetupHome`) remains what boot actually does and stays the
most direct path to a correctly-renamed row with no transient legacy-named state — but it is no
longer the thing standing between a clean install and a double-seed defect the way it was when this
record was written; that defect is now also closed structurally, at the resolver level, as a second
line of defense.

The rename is scoped tightly so it only ever touches that one home: it matches the RESERVED home
under the EXACT old literal (`getReservedProjectByName`/`hasReservedProjectNamed` are
`reserved=1` only, so an ordinary user project happening to be named "Getting Started" is never
touched), and it refuses outright if a reserved home already holds the new name — a
collision/already-migrated guard that stops it from ever creating a duplicate or clobbering a
distinct, already-migrated "Platform" home.

Idempotent by NAME-MATCH, no marker needed: once the rename lands, the old literal is gone, so a
re-run finds nothing and no-ops. It also no-ops on a fresh install (seed already created
"Platform" directly), on a user-renamed home (any other name), and if the rename were ever
reverted (new name equals the legacy one).

## Do not

- Do not run this backfill after `seedSetupHome` without a reason — it is no longer the sole thing
  preventing a double-seed (see above, card `a47dd144` round 2), but it is still boot's documented
  order and the most direct path to a correctly-renamed row with no transient legacy-named state.
- Do not widen the match beyond the exact legacy literal or beyond `reserved=1` homes — either
  would risk touching a user's own ordinary project that happens to share the old name.

## Source

Inline comment in `packages/daemon/src/setup/seed.ts` (`seedSetupProjectRename`'s doc), extracted
at tranche 2. Introduced by commit `db1e4bb87` ("feat(setup): rename reserved home 'Getting
Started' → 'Platform' + expose it for the project picker"). No board card cites this decision —
keyed on the `sha:` commit form (see `CLAUDE.md`'s `@decision sha:` sigil).
