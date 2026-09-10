# db1e4bb8 — the reserved setup-home rename backfill must run before seedSetupHome, or it orphans the old row

## Narrative

`seedSetupProjectRename` is the GUARDED one-shot rename of the reserved "Getting Started" →
"Platform" setup home row, for installs that seeded the home before that rename shipped
(`packages/daemon/src/setup/seed.ts`). It is the project-level analog of `seedSetupAgentRename`
(see [[aecc6551-reserved-home-agent-seeder-pattern]] for that sibling's own gotchas).

`seedSetupHome` is seed-if-absent, keyed on the NEW name (`SETUP_PROJECT_NAME`, "Platform"). An
install seeded before the rename still carries its reserved home row under the OLD
`LEGACY_SETUP_PROJECT_NAME` literal ("Getting Started"), which every resolver
(`getReservedProjectByName`, `/api/setup/home`, the workspace-audit suggest target) now looks up
under the new name.

The rename backfill therefore **must run at boot BEFORE `seedSetupHome`**: `seedSetupHome`'s
absence-check keys on the NEW name only, so if it ran first on a pre-rename install it would see
no "Platform" home and mint a SECOND, empty one beside the old "Getting Started" row — orphaning
the user's real home and its boards under the legacy name, invisible to every resolver that now
looks up "Platform". Renaming the existing row in place first avoids that outcome entirely.

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

- Do not run this backfill after `seedSetupHome` — `seedSetupHome`'s name-scoped absence-check
  cannot see the pre-rename row, so it would mint a second, empty "Platform" home and strand the
  user's real one under the legacy name.
- Do not widen the match beyond the exact legacy literal or beyond `reserved=1` homes — either
  would risk touching a user's own ordinary project that happens to share the old name.

## Source

Inline comment in `packages/daemon/src/setup/seed.ts` (`seedSetupProjectRename`'s doc), extracted
at tranche 2. Introduced by commit `db1e4bb87` ("feat(setup): rename reserved home 'Getting
Started' → 'Platform' + expose it for the project picker"). No board card cites this decision —
keyed on the `sha:` commit form (see `CLAUDE.md`'s `@decision sha:` sigil).
