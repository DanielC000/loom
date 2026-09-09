# b37750a4 — backfill missing `archived_at` from each row's own real end-time, one-shot

## Narrative

Card b37750a4: sessions that EXITED before auto-archive-on-exit shipped never got `archived_at` stamped, so they're invisible in both the live rail (exited rows are pruned) and the project Archive tab (which filters `archived_at IS NOT NULL`). `backfillArchivedAtOnce` stamps `archived_at` on every such legacy row so the trees appear.

It uses each row's REAL end-time — `COALESCE(last_activity, created_at)`, NOT `now()` — so the Archive's `archived_at DESC` ordering keeps these in chronological position rather than collapsing them all to the migration instant at the top. Predicate `process_state = 'exited'` ONLY: the `ProcessState` union is `none|starting|live|exited` — there is NO `'dead'` (that's a `Resumability` value), so `'exited'` is the whole terminal set. `'none'` is EXCLUDED — it's a shell/non-engine placeholder row, never a real stopped session (mirrors `onExit`, which archives only real DB engine rows). `role='run'` is EXCLUDED — ephemeral Agent Run sessions must never clutter the Archive (same exclusion as `onExit`). Already-archived rows are untouched, so pre-existing auto-archived sessions keep their original `archived_at`.

It runs one-shot via an `app_meta` marker (same fire-exactly-once pattern as the first-run setup flag / column-role backfill): marker checked FIRST, stamped LAST — a second invocation is a clean no-op. SAFE re: `resumeFleetOnBoot`: a session it resumes is un-archived by `restoreSession` regardless, and this matches only already-`'exited'` rows (a crashed session about to be recovered+resumed is still `'live'`/`'starting'` at this point, so it isn't touched here).

## Do not

- Do not stamp `archived_at` to `now()` on backfill — use `COALESCE(last_activity, created_at)`, or the Archive's chronological ordering collapses every legacy row to the migration instant.
- Do not widen the predicate to include `process_state='none'` or `role='run'` — those must never clutter the Archive, same exclusions `onExit` already applies.

## Source

Inline comment in `packages/daemon/src/db.ts` (`backfillArchivedAtOnce`): lines 5088-5111, as of this tranche's HEAD.
