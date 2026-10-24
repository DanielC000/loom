# 3b65028c — orphaned `PROJECTS_WORK_ROOT` dirs are surfaced, never auto-removed

From card `8e32605d`'s own Code Review: after a permanent project delete, a work dir under
`PROJECTS_WORK_ROOT` that failed to remove (killed after its removal budget, or failed cleanly after
`DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_ATTEMPTS` — see `projects/work-dir.ts`'s `deleteProjectWorkDir`) was
never revisited. The DB row is gone by the time this happens, no sweep walked `PROJECTS_WORK_ROOT` for
orphans, and `projectsWorkRootBytes` (`sessions/project-work-dir-usage.ts`, decision `5eace211`/Decision 5)
only ever sums bytes for KNOWN project ids — so an orphaned dir was invisible even in that fleet-wide
figure. The only trail was one `console.warn` line in `deleteProjectWorkDir`.

`sessions/orphaned-project-work-dirs.ts` closes the visibility gap: it enumerates top-level directory
entries under `PROJECTS_WORK_ROOT` whose name matches no real project row (active OR archived), and
surfaces a count + a bounded list on `served_status` / `GET /api/deploy-status` (both backed by
`buildServedStatus`), mirroring how `staleWorktreeLeftovers` is already reported there. It is cached and
background-refreshed, same architecture as `project-work-dir-usage.ts`/`scratch-largest-dirs.ts` — never a
fresh scan on `served_status`'s own read path.

## Do not

- Do not add any deletion or re-removal sweep to this module, or wire its output into one elsewhere — an
  automatic re-delete is a worktree-deletion-class change needing its own card and Code Review. This
  project has a past P0 (card `bd9fc808`): a retry loop over a hung `fs.rm` leaked the libuv threadpool
  and stuck the daemon. Visibility first; a human decides what (if anything) deletes an orphan.
- Do not add byte-size measurement (or any `fs.stat`/`measureDirSize` call) to the scan — it must stay a
  single-level `readdirSync`, cheap enough to run in the background on the same throttle as its siblings.
  A human who wants to size one up before deciding whether to clean it up by hand can do so directly.
- Do not compute this inline on `served-status.ts`'s own read path — route it through the cache +
  background-refresh module (`getCachedOrphanedProjectWorkDirs`/`kickOrphanedProjectWorkDirsRefresh`),
  same posture as `projectsWorkRootBytes`/`scratchLargestDirs`.
- Do not widen the "known ids" set to anything other than `db.listAllProjects()` ∪ `db.listArchivedProjects()`
  — a dir matching either must never be reported as an orphan.

## Round 2 (Lead review of 8c67248a) — bystander dirs, and a DB failure must never read as "everything is orphaned"

Two correctness fixes found at review, both about the figure telling the truth rather than merely
running:

1. **Bystander dirs.** `LOOM_PROJECT_WORK_ROOT` is a human-settable override (decision `5eace211`,
   Decision 2) that "could point at an existing populated directory with nothing to do with Loom" —
   `projectsWorkRootBytes`'s own doc on `served-status.ts` names this exact hazard as a "bystander
   directory", scoped away from by walking only known project ids. The orphan scan has no such built-in
   immunity: it enumerates the root directly, so an unrelated directory the human's override root happens
   to also hold would be reported as an "orphan" forever. The only thing Loom itself ever creates directly
   under `PROJECTS_WORK_ROOT` is a per-project dir named by its UUID project id (`projectWorkDir`,
   paths.ts) — so `findOrphanedProjectWorkDirs` now also requires a candidate's name to match
   `UUID_SHAPE_RE` (exported from paths.ts for this reuse, mirroring decision `98039b36`'s "one shared
   check, never a second independently-written copy") before it can even be considered.
2. **DB read failure.** The original code degraded a failed `db.listAllProjects()`/`listArchivedProjects()`
   to an EMPTY known-id set, which would then report every real (UUID-shaped) project's own work dir as
   "orphaned" — a false alarm in the worst possible direction, surfacing a visibility feature as a scare
   during exactly the kind of transient DB hiccup it should be most conservative about. `refreshOrphaned
   ProjectWorkDirs` now skips the scan entirely on a DB read failure, logs a `console.warn`, and returns
   the EXISTING cache unchanged (never overwriting it with a bad result).

## Do not (round 2 additions)

- Do not drop the `UUID_SHAPE_RE` filter, or re-derive a second UUID-shape regex independently of
  `paths.ts`'s own — route every "is this dir name a Loom-assigned project id" check through the one
  shared, exported `UUID_SHAPE_RE`.
- Do not let a `db.listAllProjects()`/`listArchivedProjects()` failure degrade to an empty known-id set
  and then run the scan anyway — that reports every real project dir as orphaned. On a DB read failure,
  skip the scan and keep the previous cache, with a warn.
