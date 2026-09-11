# sha:8e8324cd — the automatic DB backup service exists because a 2026-06-04 prod-wipe survived only by luck

Source: commit `8e8324cd`, no board card ("feat(daemon): automatic SQLite DB backup system (boot + periodic + pre-restart, rotated)"). Condensed, not verbatim.

## Narrative

A 2026-06-04 prod-wipe survived only by LUCK: the destructive DELETEs were still sitting in the WAL, and the main file happened to hold a 23-minute-old checkpoint. This automatic backup service exists so durable, automatic recovery no longer depends on that luck, for ANY cause of DB loss.

The service snapshots via better-sqlite3's ONLINE backup API (`db.backup(dest)`) rather than a flat file-copy specifically because of that same incident: a flat file-copy of an open WAL DB can capture a torn/stale main file — exactly the failure mode that nearly lost the DB in the first place. The online backup API is safe to run against a live WAL DB.

## Source

Inline comment in `packages/daemon/src/orchestration/db-backup.ts`, at the top of the file (above the backup config resolver), as of main `db57bdc4`. Relocated by card `f7552bf6` (runtime-subsystem residue, closing sweep). Condensed and reworded, not verbatim.
