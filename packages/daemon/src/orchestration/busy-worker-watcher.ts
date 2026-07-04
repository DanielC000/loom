import { randomUUID } from "node:crypto";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import type { OrchestrationControl } from "./control.js";

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests claude-free). */
export interface BusyWorkerPty {
  isAlive(sessionId: string): boolean;
  /** Nudge text into the session's busy-gated queue (waits if the target is mid-turn). */
  enqueueStdin(sessionId: string, text: string): { delivered: boolean; position?: number };
}

export interface BusyWorkerWatcherDeps {
  db: Db;
  pty: BusyWorkerPty;
  /** §17a pause registry — a human-paused worker or its manager is never surfaced (parity with IdleWatcher). */
  control: OrchestrationControl;
  /** Tick cadence; defaults to 60s. Injectable so a test drives tick() directly. */
  intervalMs?: number;
}

/**
 * Busy-worker LONG-TURN advisory. STRUCTURAL TWIN of IdleWatcher, but for the inverse failure: where
 * IdleWatcher nudges an IDLE manager, this surfaces a LIVE WORKER that's been `busy` in one long turn to
 * its OWNING MANAGER. Motivated by the cc9a41cc incident: a worker hung `busy` ~77min with an empty
 * transcript / no commits, undetected until a manual `worker_status`.
 *
 * SIGNAL — `busy` + `lastActivity` staleness, and ONLY that. Justified by the spawn/PTY mechanics:
 * `db.setBusy` re-stamps `last_activity` on EVERY turn edge (rising at turn start, falling at
 * end-of-turn — see PtyHost.setBusy), and nothing else bumps it mid-turn. So for a `busy=true` session,
 * `now - lastActivity` is exactly how long the worker has been in ONE uninterrupted turn: a worker
 * churning through turns keeps a fresh `lastActivity` (each edge re-stamps it); a worker in one long turn
 * past the window has a stale one.
 *
 * WHY NOT ALSO GATE ON PTY OUTPUT (tried and reverted): PtyHost's own `healIfStuck` already clears
 * `busy=false` once pty output has been stale ≥`busyStaleMs` (5min) — so a session can never stay
 * `busy=true` with stale output for a full `stuckWorkerMinutes` window (30–60min by construction); an
 * "AND no recent pty output" gate is provably unreachable dead code, not a real second signal. Nor is
 * there a cheap progress proxy that helps: `ctxTurns`/commit counts don't advance mid-turn either, and a
 * live-repainting hung TUI is indistinguishable from a legitimate long build/test gate on pty bytes
 * alone. So `lastActivity` staleness is the ONLY signal, and this watcher is deliberately a SOFT,
 * INFORMATIONAL advisory ("this worker has been busy a while, likely a long gate") rather than a hang
 * detector — the manager decides whether it's worth a look. `healIfStuck` (5min, output-based) already
 * catches the actually-silent-hang case; this catches the long-single-turn case it can't.
 *
 * ONCE PER EPISODE — persisted, self-resetting, no new column. On trip we append ONE `worker_stuck`
 * orchestration event (filed under the owning manager; the durable, human-/manager-facing signal) and
 * enqueue a busy-gated nudge to that manager. The "already flagged this episode" mark is the event
 * itself: we skip if a `worker_stuck` event already exists with `ts > lastActivity` (i.e. fired AFTER
 * the current turn began). When the worker makes progress, `lastActivity` advances past that event → the
 * guard clears → a later long turn can fire again. Persisted in the events table, so the once-per-episode
 * mark survives a daemon restart (mirrors IdleWatcher's persisted mark).
 *
 * NEVER a hard kill, never framed as a hang — surfacing only; the manager decides (check in / re-nudge /
 * recycle, or ignore it as an expected long gate). Skips silently when: the worker is idle (`busy=false`
 * — not this watcher's concern; that's awaiting-review / IdleWatcher territory); not stale long enough;
 * the owning manager is missing/not-live (nothing to surface to — orphans are boot-reconcile's job); the
 * worker or its manager is human-paused; or the project disabled it (`stuckWorkerMinutes === 0`).
 */
export class BusyWorkerWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: BusyWorkerWatcherDeps) {}

  tick(now: Date = new Date()): void {
    const { db, pty, control } = this.deps;
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    for (const w of db.listLiveWorkers()) {
      if (!w.busy) continue;                                   // idle worker → not this watchdog's job
      if (!pty.isAlive(w.id)) continue;                        // db says live but pty is gone → skip

      const project = db.getProject(w.projectId);
      if (!project) continue;
      const windowMin = resolveConfig(project.config).orchestration.stuckWorkerMinutes;
      if (windowMin === 0) continue;                           // disabled for this project

      // Stale long enough? lastActivity on a busy session == the current turn's start instant.
      const lastActivityMs = Date.parse(w.lastActivity);
      const busyForMin = (nowMs - lastActivityMs) / 60_000;
      if (busyForMin < windowMin) continue;

      // Surface to the OWNING MANAGER — it must exist and be live for the signal to be actionable.
      const managerId = w.parentSessionId;
      if (!managerId) continue;                                // no owner to surface to (shouldn't happen for a worker)
      const manager = db.getSession(managerId);
      if (!manager || manager.processState !== "live") continue; // orphaned → boot-reconcile's concern, not ours

      // Human-paused (worker's own scope, the manager's scope, or global) → don't surface (parity with IdleWatcher).
      if (control.isPaused(w.id) || control.isPaused(managerId)) continue;

      // Once-per-episode: skip if we already flagged THIS long turn (a worker_stuck event stamped after
      // the current turn began). Progress advances lastActivity past it, re-arming a future episode.
      const alreadyFlagged = db.listEventsForWorker(w.id)
        .some((e) => e.kind === "worker_stuck" && e.ts > w.lastActivity);
      if (alreadyFlagged) continue;

      const n = Math.round(busyForMin);
      db.appendEvent({
        id: randomUUID(), ts: nowIso, managerSessionId: managerId, workerSessionId: w.id,
        taskId: w.taskId ?? null, kind: "worker_stuck",
        detail: { reason: "busy_no_progress", minutesBusy: n },
      });
      const msg =
        `[loom:worker-busy-long] worker ${w.id.slice(0, 8)}${w.taskId ? ` (task ${w.taskId.slice(0, 8)})` : ""} has been ` +
        `in a single turn ~${n}min — likely a long build/test gate. If that's unexpected, check on it with ` +
        `worker_status; re-nudge (worker_message) or recycle if it's genuinely stuck. (Informational — Loom does ` +
        `not auto-kill the worker.)`;
      try { pty.enqueueStdin(managerId, msg); } catch { /* manager not live */ }
      // eslint-disable-next-line no-console
      console.log(`[busy-worker-watcher] worker ${w.id} busy ~${n}m in one turn → advisory to manager ${managerId}`);
    }
  }

  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
