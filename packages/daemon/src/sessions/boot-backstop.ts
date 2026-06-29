import type { Db } from "../db.js";
import type { Session } from "@loom/shared";
import { snapshotTranscript } from "./transcript.js";

/**
 * Crash-path backstop for the auto-archive model (card b37750a4). A daemon crash/kill fires NO pty
 * onExit, so the auto-archive + transcript snapshot that onExit normally runs never happened for the
 * sessions `recoverStaleSessions()` just reconciled to `exited`. Do BOTH here, best-effort, while the
 * engine JSONL still exists (before sweepDeadSessions / Claude can prune it) — so a crash-recovered
 * stopped session lands in Archive WITH a readable transcript, consistent with the model. This is the
 * ONLY snapshot point on the crash path (the manual archive's backstop is gone).
 *
 * EXCLUDES role==='run' — ephemeral Agent Run sessions are finalized + GC'd via onRunSessionExit and
 * must never clutter the project Archive tab. A session resumed later (restart-intent / crash-recovery)
 * clears its archived_at on resume, so archiving here is harmless for the resumed fleet. Never throws.
 */
export function snapshotAndArchiveRecovered(db: Db, recovered: Session[]): void {
  for (const s of recovered) {
    if (s.role === "run") continue;
    try { if (s.engineSessionId) snapshotTranscript(s.cwd, s.engineSessionId, s.projectId, s.id); } catch { /* best-effort — never gate boot */ }
    try { db.archiveSession(s.id); } catch { /* best-effort — never gate boot */ }
  }
}
