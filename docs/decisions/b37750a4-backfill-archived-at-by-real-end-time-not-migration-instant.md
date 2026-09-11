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

## Resume gating must check archivedAt too, not just processState (web-side consequence)

Auto-archive-on-exit (this same card) stamps `archivedAt` in the SAME `onExit` handler that flips `processState` to `"exited"`, and the rail/god-eye lists (`listAllSessions`) exclude archived rows outright. So gating a Resume affordance on `processState === "exited"` alone is already too late by the time any poll observes a row: it either hasn't archived yet (a window of effectively zero) or has archived and vanished from the rail entirely (UI-audit findings #14/#15). `canResumeSession` (`packages/web/src/lib/sessions.ts`) gates on EITHER signal — still-exited-but-not-yet-archived, OR already archived (`archivedAt` set) — so Resume has a durable path through the Archive, not just the ephemeral rail window. A caller that folds archived sessions back into its own list (e.g. the Overview fleet accordion) gets a working Resume through that path too. `resume()`/`resumeSession` un-archives + respawns in one call regardless of which state it finds the row in, so both branches call the exact same mutation. Shared by `SessionActions` and `RunHistory` so the two surfaces don't drift onto separate resume mechanisms.

### Do not (2)

- Do not gate a Resume affordance on a bare `processState === "exited"` check — a session can leave "exited" for "archived" within the same `onExit` handler that set it, so a caller sourced from a list that excludes archived rows would otherwise never see the exited state long enough to offer Resume.
- Do not implement Resume gating twice (once per surface) — `SessionActions` and `RunHistory` both call the shared `canResumeSession`, so they can't drift onto separate mechanisms.

### Source (2)

Inline comment in `packages/web/src/components/SessionActions.tsx` (the component's top-of-file doc) and `packages/web/src/lib/sessions.ts` (`canResumeSession`'s own JSDoc, lines 92-103, uncondensed and out of this program's scope since under the 15-line flag threshold), as of commit `b645773be0e2cf5f702d42b80a4cb26f6e392f0d` (`fix(web): route SessionActions resume through Archive`). Extracted from the `SessionActions.tsx` site by card `7071275f`; wording condensed, no substantive detail dropped — the fuller narrative already lived in `lib/sessions.ts`'s own JSDoc, untouched by this extraction.
