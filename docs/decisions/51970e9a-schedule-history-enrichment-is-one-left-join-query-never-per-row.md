# sha:51970e9a — `listScheduleHistory` enrichment is one LEFT-JOIN query, never a per-row lookup

## Narrative

`listScheduleHistory` returns a BOUNDED, newest-first page of schedule-fire history (kinds `schedule_fired` / `schedule_fire_deferred` / `schedule_fire_failed`) plus the TOTAL count for the current filter, backing the Schedules page's lazy run-history section (`GET /api/schedules/history`). It is god-eye across ALL schedules (matching the god-eye schedules table); an optional `scheduleId` scopes it to one.

Enrichment (schedule name + the target agent's "Project / Agent" label + the spawned session id) is a SINGLE query with LEFT JOINs (events → schedules → agents → projects) — NOT a per-row lookup: this DB is synchronous (better-sqlite3), so a 100-row page resolved with one query-per-row would be 100 blocking round-trips that stall every other concurrent handler (the N+1 trap). The JOINs are LEFT so a fire whose schedule was later deleted still returns (its enrichment columns come back NULL — the durable event outlives the schedule row). `cron` falls back to the value carried in the event `detail` when the schedule row is gone.

`limit` is clamped into `[1, MAX_SCHEDULE_HISTORY_PAGE]` and the EFFECTIVE value is returned (same "read it back so Load-more can't dead-end at the clamp" contract as the archived-sessions pages). Ordered by `ts DESC, seq DESC` — `seq` is the never-reused monotonic tiebreak for same-timestamp fires.

## Do not

- Do not resolve per-row enrichment with a query-per-row loop — this DB is synchronous; a 100-row page would be 100 blocking round-trips stalling every other concurrent handler.
- Do not INNER JOIN `schedules` — a fire whose schedule was later deleted must still return, with NULL enrichment columns, since the durable event outlives the schedule row.
- Do not silently drop an out-of-range `limit` — clamp it and return the EFFECTIVE value so "Load more" can't dead-end at the clamp.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listScheduleHistory`'s doc comment), as of this tranche's HEAD. No board card cited anywhere in the block or the file; keyed to the introducing commit per the extraction program's sha-grammar carve-out. Sourced via `git blame`, then `git rev-parse --verify 51970e9a46089f36a916da5f58a6a856a376d663` (chore: schedules history) — a genuine feature commit, not a bulk move.
