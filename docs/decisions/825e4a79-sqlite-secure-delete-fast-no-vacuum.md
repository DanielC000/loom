# 825e4a79 — `PRAGMA secure_delete = FAST`, no automatic VACUUM; what the purge migrations do and don't scrub

## Context

Code Review `ddd96e27` of `5a5d7312` flagged a residual: the `alertWebhook`/`sessionEnv` purge migrations
(`Db.migratePurgeLegacyAlertWebhookHistory`/`migratePurgeLegacySessionEnvHistory`, `db.ts`) `UPDATE` rows
to mask a legacy cleartext value, but neither `PRAGMA secure_delete` nor `VACUUM` appears anywhere in
`packages/daemon/src` — so the premise was that the OLD cleartext bytes likely survive in SQLite free
pages / the WAL until something scrubs them.

**Measured, not assumed.** Built the real `Db` class (`packages/daemon/dist/db.js`, better-sqlite3
3.49.2) against a throwaway file: wrote ~60 ordinary `recordProjectConfigChange` rows (well under the
200-row-per-project ring buffer cap, so the row under test survives to be migrated rather than evicted),
inserted ONE legacy row directly (bypassing `recordProjectConfigChange`, simulating a genuine pre-fix
write) holding a real cleartext webhook URL, wrote ~60 more rows, then `PRAGMA wal_checkpoint(TRUNCATE)`.
**Positive control:** the raw file bytes DO contain the cleartext URL at this point — confirming the scan
mechanism can actually find a real hit, not just report a true negative by construction. Reopened the
`Db` (this runs the real boot migration), checkpointed again, then scanned the raw bytes of the main
file, `-wal`, and `-shm` for the full URL and a short fragment of it.

**Result: in both `secure_delete=OFF` (the pre-existing default) and `secure_delete=ON`, neither the full
URL nor a short fragment of it was found in the raw on-disk bytes after the migration's `UPDATE` +
checkpoint.** This directly contradicts the strong form of the review's premise, for this scenario.

**The measured scope, exactly, and no further:**
- SQLite 3.49.2 as bundled by better-sqlite3, on this build/platform.
- `journal_mode = WAL`, checkpointed (`wal_checkpoint(TRUNCATE)`) after the write.
- A `TEXT` value SHRINKING (a long URL → the short fixed `https://***` placeholder) — the shape every
  real `alertWebhook` purge actually is. A `sessionEnv` secret rotated to same-length bullet filler is a
  different, strictly more benign case (exact-size overwrite), not separately measured here.
- This does **not** generalize to a different SQLite build, version, or page size/layout — the
  underlying b-tree free-space mechanics that produced this result were not traced; only the outcome was
  measured, on one build, under one access pattern.
- This says nothing about filesystem-level recovery of overwritten disk sectors (undelete tools, disk
  forensics) — that is outside SQLite's control either way, with or without `secure_delete`.

**Write-path cost of `secure_delete=ON`:** 2000 `recordProjectConfigChange` writes, with the 200-row
ring buffer evicting throughout (so real steady-state churn, not a cold empty table): ~0.48–0.60ms/write
either way across repeated runs — no measurable difference from `OFF`, well within run-to-run noise.

**VACUUM cost:** a synthetic single-table DB was built to match the real `~/.loom/loom.db` SIZE
(254,054,400 bytes — read via `stat` only; the real file was never opened) with ~560k rows, 30% deleted
for realistic free-page churn. `VACUUM` took ~2.7s (255.5MB → 170.3MB). This is a rough proxy only — the
real schema has many more tables and indexes VACUUM must also rewrite, so the real cost is likely higher
than this single-table number — but is enough to show the operation is not free, and its cost is
unbounded as the DB grows (no proxy at all for how it scales past this one measured point).

**Backups** (`orchestration/db-backup.ts`, `~/.loom/backups/`, names/sizes read via `ls`/`stat` only —
no backup file's contents were ever opened): the AUTO snapshots (`backups/auto/loom-<ISO>.db`, default
`{intervalMinutes:60, keep:48, enabled:true}`, `config.ts`) rotate by mtime after `keep` (48) — any
pre-fix snapshot ages out within that window. Several MANUAL `pre-*` backup directories
(`pre-agents-rename-*`, `manual-pre-qa-cleanup-*`) exist on this host; `rotateBackups`'s own doc comment
states it only ever touches `loom-*.db` files in the auto dir and never these — they are **not** rotated
by any mechanism in this codebase and retain whatever cleartext existed at the time they were taken,
indefinitely, until a human removes them.

## Decision

1. Set `PRAGMA secure_delete = FAST` on the daemon's one write connection (`Db`'s constructor, `db.ts`,
   immediately after `journal_mode = WAL`) — cheap, no migration (a per-connection pragma, not persisted
   in the DB file), and negligible measured write cost. This is defense-in-depth for a scenario this
   measurement did not reproduce on this build — not a fix for a confirmed live leak, and not a
   retroactive scrub of anything already on disk.
   - `orchestration/db-backup.ts`'s `conn = new Database(src)` is the only other `better-sqlite3`
     connection the daemon opens. It is read-only in effect — `takeBackup` only ever calls
     `conn.backup(dest)`, never `UPDATE`/`DELETE`/`exec` on `conn` — so `secure_delete` has nothing to
     act on there and was deliberately left unset on that connection.
2. Do **not** run `VACUUM` automatically, at boot or anywhere else. See "Do not" below.
3. Document the backup residual; do not act on it. See "Do not" below.

## Do not

- Do not add an automatic `VACUUM` (at boot, on a timer, or anywhere else triggered without a human
  asking for it): it takes an EXCLUSIVE lock (blocks every other DB access for its duration), needs
  roughly 2x the DB's disk space for the temporary rewritten copy, and its cost is unbounded as the DB
  grows — all for a risk this measurement found near-zero on the live write path. If a VACUUM/scrub
  capability is wanted later, it must be a human-triggered, opt-in operation (a REST/CLI action), never
  an automatic one.
- Do not read the measured result above as "no residue risk, full stop." It is scoped to one SQLite
  build/version under WAL+checkpoint with a shrinking TEXT value. A different build, page layout, or
  journal mode was not tested and may behave differently — `secure_delete=FAST` stays on for exactly this
  reason.
- Do not delete, scrub, or open any file under `~/.loom/backups/` (auto or manual) from code or from an
  agent session. Backups are the owner's data; removing one is irreversible. If the manual `pre-*`
  backups' indefinite retention of pre-fix cleartext is ever to be addressed, that is a separate,
  explicitly human-authorized follow-up — not something this record's investigation or fix does.
- Do not set `secure_delete` on `orchestration/db-backup.ts`'s connection — it never deletes or updates
  anything, so the pragma would be a no-op there; if that module ever starts mutating the source
  connection, revisit this.

Related: card `5a5d7312` (`fix(gateway): stop project config history retaining rotated-out alert webhook
URLs in cleartext` — the fix this review followed from; no separate decision record exists for it) and
`docs/decisions/e5c82138-unify-three-sessionenv-config-projection-maskers.md` (the sibling `sessionEnv`
masking work in the same area).
