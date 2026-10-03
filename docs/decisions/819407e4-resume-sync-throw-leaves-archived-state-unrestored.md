# 819407e4 — `resume()` restores the pre-resume archive state on a synchronous spawn throw

`resume()` (`sessions/service.ts`) clears `archived_at` via `db.restoreSession()` before `pty.spawn()`,
relying on a comment that claimed "onExit re-archives" on failure. That's only true for a throw that
happens AFTER a real OS process exists — `archiveOnExit` is wired to the real pty `onExit` handler
(`index.ts`), which never fires for a throw from `restoreSession` itself or a synchronous `pty.spawn`
failure (no process was ever created, so no exit event is ever emitted). `reconcileFailedSpawn` (the
shared catch helper) only sets `processState:"exited"` — it never touches `archived_at`. Net effect: the
row ends `processState:"exited"` + `archived_at:NULL`, which shows up as a dead zombie on the live rail
(`listAllSessions`/`getSessionListItemById` filter only on `archived_at IS NULL`) instead of in Archive.

## Do not

- Do not unconditionally call `archiveSession` in resume()'s catch — `resume()` also runs on rows that
  were never archived to begin with (a human resuming a dead session straight off the live rail,
  crash-recovery of a never-archived row); archiving those on failure is a behaviour change, not a
  restore. Gate on `wasArchived` (captured from `session.archivedAt` BEFORE `restoreSession` clears it).
- Do not fold this into the shared `reconcileFailedSpawn` helper — it's called from 14 other live-flip
  spawn sites where the row is freshly created and was never archived; archiving those would be wrong.
- Do not let the re-archive's own DB error mask the original spawn-failure error — wrap it in its own
  try/catch, best-effort, so the original `e` is still what gets rethrown.
