import { randomUUID } from "node:crypto";
import { resolveConfig, contextPercentFor } from "@loom/shared";
import type { Db } from "../db.js";
import type { OrchestrationControl } from "./control.js";
import { checkContextExhaustion } from "./context-exhaustion.js";
import { boundedSimpleGit, withTimeout } from "../git/bounded.js";

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests claude-free). */
export interface BusyWorkerPty {
  isAlive(sessionId: string): boolean;
  /** Nudge text into the session's busy-gated queue (waits if the target is mid-turn). */
  enqueueStdin(sessionId: string, text: string): { delivered: boolean; position?: number };
  /** Card 66ff7321 — mark a session context-exhausted (holds delivery, clears busy). See
   *  PtyHost.markContextExhausted's own doc. Returns false when there's no live claude session to mark. */
  markContextExhausted(sessionId: string): boolean;
  /** @decision 5f825506 — REQUIRED (round 2) so a `PtyHost.busySinceMs` rename fails to compile
   *  rather than silently failing open; still called as `pty.busySinceMs?.(id) ?? null`. */
  busySinceMs(sessionId: string): number | null;
}

/** Total-elapsed bound for {@link tryReadLastCommitSummary} — see that function's own doc. */
const LAST_COMMIT_SUMMARY_TIMEOUT_MS = 3000;

/**
 * Card 66ff7321 — best-effort "what did it last land" for the context-exhausted notice. Bounded
 * (short timeout), NEVER THROWS and never rejects — a worktree that's mid-GC, or a git hiccup, must
 * never block anything. `cwd` is the worker's own worktree path (git/worktrees.ts), never the shared
 * canonical repo, so this is an ordinary, uncontended, read-only local git call — no canonicalGit/
 * lock involved; that's why it goes through {@link boundedSimpleGit} (the sanctioned non-canonical
 * helper — see `canonical-git-helper-guard.mjs`'s own allowlist), not `canonicalGit`.
 * @decision 66ff7321 — round 2 (CR finding): this was `execFileSync`, up to a 3s SYNCHRONOUS block
 * on the daemon's event loop per tick — async, per CLAUDE.md's event-loop discipline (the same class
 * of hazard `createWorktree`'s own async-spawn split already guards).
 *
 * Round 3 (card cb42134a): a raw child-process `execFile("git", [...])` bypasses the shared resolver
 * chokepoint `canonical-git-helper-guard.mjs` requires every src/** git call to go through — routed
 * through `boundedSimpleGit` instead, same as `git/reader.ts`/`sessions/service.ts`/`orchestration/
 * restart.ts`'s own non-canonical read-only calls. `block` is an IDLE timeout, not total-elapsed (see
 * `boundedSimpleGit`'s own doc) — wrapped in `withTimeout` to keep the real 3s total-elapsed bound.
 */
function tryReadLastCommitSummary(cwd: string): Promise<string | null> {
  try {
    // boundedSimpleGit/simple-git construction is SYNCHRONOUS and throws (GitConstructError) when `cwd`
    // doesn't exist on disk right now — a real case (a worktree mid-GC/removal) the old execFile("git",
    // ["-C", cwd, …]) shape never hit this way (a bad `-C` target failed INSIDE the async callback, not
    // at call time) — so this must stay inside the same try as the construction, not just the .catch below.
    const git = boundedSimpleGit(cwd, LAST_COMMIT_SUMMARY_TIMEOUT_MS);
    return withTimeout(git.raw(["log", "-1", "--format=%h %s"]), LAST_COMMIT_SUMMARY_TIMEOUT_MS, "git log -1 (last commit summary)")
      .then((stdout) => {
        const line = (stdout ?? "").trim();
        return line || null;
      })
      .catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
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
 * its OWNING MANAGER.
 *
 * SIGNAL — `busy` + `lastActivity` staleness, and ONLY that. Justified by the spawn/PTY mechanics:
 * `db.setBusy` re-stamps `last_activity` on EVERY turn edge (rising at turn start, falling at
 * end-of-turn — see PtyHost.setBusy), and nothing else bumps it mid-turn. So for a `busy=true` session,
 * `now - lastActivity` is exactly how long the worker has been in ONE uninterrupted turn: a worker
 * churning through turns keeps a fresh `lastActivity` (each edge re-stamps it); a worker in one long turn
 * past the window has a stale one. `lastActivity` staleness is the ONLY signal, and this watcher is
 * deliberately a SOFT, INFORMATIONAL advisory ("this worker has been busy a while, likely a long gate")
 * rather than a hang detector — the manager decides whether it's worth a look. `healIfStuck` (5min,
 * output-based) already catches the actually-silent-hang case; this catches the long-single-turn case it
 * can't.
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
 *
 * @decision cc9a41cc — motivated by an incident where a worker hung `busy` for an extended period with
 * an empty transcript and no commits, undetected until a manual `worker_status`.
 *
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

      // Card 66ff7321 — CONTEXT-EXHAUSTION detection, checked FIRST and unconditionally for every busy
      // claude worker (no staleness window — the terminal record is dispositive the instant it's seen).
      // No Stop/StopFailure hook ever fires for this failure (empirically verified), so this tick is
      // the ONLY place it can be caught. Claude-only: a codex transcript is a different wire format
      // entirely and would simply never match, but skip the wasted read outright.
      if (w.harness !== "codex" && w.engineSessionId) {
        const exhaustion = checkContextExhaustion(w.cwd, w.engineSessionId, w.harness, pty.busySinceMs?.(w.id) ?? null);
        if (exhaustion) {
          const marked = pty.markContextExhausted(w.id);
          if (marked) {
            // The DB mark is a fact about the WORKER, independent of whether anyone's listening — stamp
            // it regardless of manager liveness (mirrors a real exhaustion: true whether or not it's
            // ever reported). The durable event + notice, below, mirror the ordinary busy-long path's
            // OWN liveness gate ("the owning manager must exist and be live for the signal to be
            // actionable") for consistency.
            db.setContextExhausted(w.id, nowIso, `Context exhausted — the engine rejected the next prompt as too long (${exhaustion.matchedText}).`);
            const managerId = w.parentSessionId;
            const manager = managerId ? db.getSession(managerId) : null;
            if (managerId && manager && manager.processState === "live") {
              db.appendEvent({
                id: randomUUID(), ts: nowIso, managerSessionId: managerId, workerSessionId: w.id,
                taskId: w.taskId ?? null, kind: "worker_context_exhausted",
                detail: { error: exhaustion.error ?? null },
              });
              // Round 2 — tryReadLastCommitSummary is now async (no event-loop-blocking execFileSync);
              // the notice build + enqueue moves into its `.then()` so `tick()` itself stays fully
              // synchronous. The durable event above is already appended before this fires, so nothing
              // load-bearing waits on the git read — only the human-facing notice text's last-commit
              // detail lags by however long the bounded read takes.
              tryReadLastCommitSummary(w.cwd).then((lastCommit) => {
                const msg =
                  `[loom:worker-context-exhausted] worker ${w.id}${w.taskId ? ` (task ${w.taskId.slice(0, 8)})` : ""} ` +
                  `just hit the terminal "${exhaustion.matchedText}" — its context is EXHAUSTED and it can no longer take a turn. ` +
                  `busy has been cleared and any queued direction is HELD (not drained into the dead turn). ` +
                  `worker_recycle it — this keeps its worktree/branch intact for the successor.` +
                  (lastCommit ? ` Its branch's last commit: ${lastCommit}.` : "");
                try { pty.enqueueStdin(managerId, msg); } catch { /* manager not live — the durable event stands */ }
                // eslint-disable-next-line no-console
                console.log(`[busy-worker-watcher] worker ${w.id} CONTEXT-EXHAUSTED (${exhaustion.error ?? "unknown error"}) → notice to manager ${managerId}`);
              }).catch(() => { /* tryReadLastCommitSummary's own Promise never rejects — belt and braces */ });
            } else {
              // eslint-disable-next-line no-console
              console.log(`[busy-worker-watcher] worker ${w.id} CONTEXT-EXHAUSTED (${exhaustion.error ?? "unknown error"}) — no live owning manager to notify (orphan; boot-reconcile's concern)`);
            }
          }
          continue; // handled (or already marked by a prior tick) — skip the ordinary busy-long check below
        }
      }

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
      // Card c5b234aa: the mid-turn sampler keeps `w.ctxInputTokens` fresh WHILE this worker is still
      // busy (not just at its last Stop), so this reads the LIVE occupancy, not a stale pre-turn one.
      const ctxPct = contextPercentFor(w.ctxInputTokens, w.model);
      db.appendEvent({
        id: randomUUID(), ts: nowIso, managerSessionId: managerId, workerSessionId: w.id,
        taskId: w.taskId ?? null, kind: "worker_stuck",
        detail: { reason: "busy_no_progress", minutesBusy: n, ctxPct },
      });
      const msg =
        `[loom:worker-busy-long] worker ${w.id}${w.taskId ? ` (task ${w.taskId.slice(0, 8)})` : ""} has been ` +
        `in a single turn ~${n}min (context: ${ctxPct != null ? `~${ctxPct}%` : "unknown"}) — likely a long build/test gate. ` +
        `If that's unexpected, check on it with worker_status; re-nudge (worker_message) or recycle if it's genuinely ` +
        `stuck. (Informational — Loom does not auto-kill the worker.)`;
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
