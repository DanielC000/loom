import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import { resumeDocSizeWarning, resolveResumeDocPath } from "../sessions/resume-doc-notes.js";

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests claude-free). */
export interface ResumeDocPty {
  isAlive(sessionId: string): boolean;
  /** Nudge text into the session's busy-gated queue (waits if the manager is mid-turn). */
  enqueueStdin(sessionId: string, text: string): { delivered: boolean; position?: number };
}

export interface ResumeDocWatcherDeps {
  db: Db;
  pty: ResumeDocPty;
  /** Tick cadence; defaults to 60s. Callers wire this to the resolved `idleWatchMs` cadence (no
   *  dedicated config knob for this watcher — it shares the sibling watchdogs' pace). */
  intervalMs?: number;
  /** How long a fired nudge is suppressed before re-firing for the SAME manager, ms. Defaults to 30
   *  minutes. NOT persisted — see the class docstring for why an in-memory cooldown is sufficient here. */
  cooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS = 30 * 60_000;

/**
 * Resume-doc-size watcher (card 809cc4b5) — the mid-session PROACTIVE half of the resume-doc size-budget
 * nudge. `composeManagerStartupPrompt` (`sessions/manager-prompt.ts`) already warns a manager at
 * SPAWN/RECYCLE time if its resume doc is already oversized, but that's too late for a single long-lived
 * manager session that keeps rewriting its doc without ever recycling — nothing warns until the doc is
 * ALREADY past the harness Read cap. This watcher closes that gap: a periodic tick over every LIVE
 * manager, deriving its resume-doc path via the SAME `resolveResumeDocPath` (`sessions/resume-doc-notes.ts`)
 * `composeManagerStartupPrompt` calls — honoring a project's `orchestration.resumeDocFilename` override
 * (card c1f2f095) instead of a second hardcoded guess — and nudging with the SAME `resumeDocSizeWarning`
 * check used at spawn time — one threshold, one message, two trigger points.
 *
 * Structural twin of ContextWatcher/IdleWatcher, but SIMPLER on purpose: unlike context occupancy (which
 * only grows within a session and needs an explicit recycle to reset), a resume doc's size is
 * SELF-CLEARING — the moment a manager rotates it (the nudge's own ask), the file shrinks back under
 * threshold and the very next tick naturally stops nudging. There is no "acknowledged" state to survive
 * a restart, so the cooldown is a plain IN-MEMORY `Map`, not a persisted DB column: a daemon restart just
 * clears it, and the worst case is one extra nudge on the next tick if the doc is still oversized — never
 * a correctness issue, and deliberately cheaper than ContextWatcher's persisted escalation state.
 *
 * Bounded + never-throw like every other watcher tick: `resumeDocSizeWarning` itself never throws (a
 * missing file — a fresh project with no doc yet — or a permission/lock error is a silent no-op), and
 * this tick() additionally wraps each manager's own iteration so one bad project/session lookup can never
 * abort the rest of the sweep.
 */
export class ResumeDocWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastNudgeAtMs = new Map<string, number>();
  constructor(private deps: ResumeDocWatcherDeps) {}

  tick(now: number = Date.now()): void {
    const { db, pty, cooldownMs = DEFAULT_COOLDOWN_MS } = this.deps;

    for (const m of db.listLiveManagers()) {
      try {
        if (!pty.isAlive(m.id)) continue;

        const project = db.getProject(m.projectId ?? "");
        if (!project) continue;

        // Card c1f2f095: resolve via the SAME `resolveResumeDocPath` composeManagerStartupPrompt uses,
        // honoring this project's `orchestration.resumeDocFilename` override — one source of truth, so
        // this watcher can never check a different file than the one the manager was actually told about.
        const resumeDoc = resolveResumeDocPath(project.vaultPath, resolveConfig(project.config).orchestration.resumeDocFilename);
        const note = resumeDocSizeWarning(resumeDoc);
        if (!note) {
          // Under threshold (or the doc doesn't exist / can't be stat'd) — clear any stale cooldown so a
          // FUTURE regrowth past threshold nudges fresh instead of inheriting a stale cooldown window.
          this.lastNudgeAtMs.delete(m.id);
          continue;
        }

        const last = this.lastNudgeAtMs.get(m.id);
        if (last != null && now - last < cooldownMs) continue;

        try { pty.enqueueStdin(m.id, note); } catch { /* manager not live */ }
        this.lastNudgeAtMs.set(m.id, now);
      } catch {
        /* never let one manager's failure abort the sweep */
      }
    }
  }

  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
