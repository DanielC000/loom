import type { Db } from "../db.js";
import type { Session } from "@loom/shared";
import { snapshotTranscript } from "./transcript.js";
import { reconcileStrandedRecycleSettlesEarly, type RecycleSettleEarlyResult } from "./recycle-settle-reconcile.js";
import { deriveCrashOrphanedWorkers, deriveCrashOrphanedManagers, type CrashOrphanedWorker } from "../orchestration/crash-orphaned-workers.js";

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
    try { if (s.engineSessionId) snapshotTranscript(s.cwd, s.engineSessionId, s.projectId, s.id, s.harness); } catch { /* best-effort — never gate boot */ }
    try { db.archiveSession(s.id); } catch { /* best-effort — never gate boot */ }
  }
}

export interface BootRecoveryPrefixResult {
  early: RecycleSettleEarlyResult;
  recovered: Session[];
  crashOrphanedWorkers: CrashOrphanedWorker[];
  crashOrphanedManagers: string[];
}

/**
 * @decision 08c81809 — Code Review round 3 finding 6: the exact pre-`PtyHost` boot prefix that matters
 * for recycle-settle recovery, extracted to ONE place so `index.ts` and
 * `test/recycle-settle-lost-to-restart.mjs`'s own `runRealBootSequenceUpToResume` can never silently
 * drift apart on ordering — both now call this SAME function rather than each re-typing the sequence.
 * Order is LOAD-BEARING (see `reconcileStrandedRecycleSettlesEarly`'s own doc for why): the early,
 * DB-only recycle-settle reconcile MUST run before `recoverStaleSessions()` (which unconditionally flips
 * every live/starting session to exited, after which a reparent moves zero rows) and before
 * `deriveCrashOrphanedWorkers`/`deriveCrashOrphanedManagers` (which snapshot `recoverStaleSessions()`'s
 * own return value, invisible to a reparent performed later). `snapshotAndArchiveRecovered` runs last,
 * after both derivations have already read the un-archived rows. Deliberately narrower than index.ts's
 * FULL pre-PtyHost boot sequence — `sweepDeadSessions`/`watchClaudeProjects`/`watchCodexSessions` (dead-
 * transcript detection, unrelated to recycle-settle) are NOT part of this shared prefix and the test never
 * replicated them either; only the four calls actually load-bearing for THIS card's ordering live here.
 */
export function runBootRecoveryPrefix(db: Db): BootRecoveryPrefixResult {
  const early = reconcileStrandedRecycleSettlesEarly(db);
  const recovered = db.recoverStaleSessions();
  const crashOrphanedWorkers = deriveCrashOrphanedWorkers(db, recovered);
  const crashOrphanedManagers = deriveCrashOrphanedManagers(db, recovered, crashOrphanedWorkers);
  snapshotAndArchiveRecovered(db, recovered);
  return { early, recovered, crashOrphanedWorkers, crashOrphanedManagers };
}
