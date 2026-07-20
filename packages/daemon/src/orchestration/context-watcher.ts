import { randomUUID } from "node:crypto";
import { resolveConfig, contextWindowForModel } from "@loom/shared";
import type { Db } from "../db.js";

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests claude-free). */
export interface ContextPty {
  isAlive(sessionId: string): boolean;
  /** Nudge text into the session's busy-gated queue (waits if the manager is mid-turn). */
  enqueueStdin(sessionId: string, text: string): { delivered: boolean; position?: number };
}

export interface ContextWatcherDeps {
  db: Db;
  pty: ContextPty;
  /**
   * GLOBAL force override for the recycle ratio (the daemon resolves `LOOM_RECYCLE_CONTEXT_RATIO`
   * before constructing the watcher). > 0 forces this ratio for EVERY project, bypassing each
   * project's own `recycleAtContextRatio`. 0/undefined = no override — each manager's threshold is
   * resolved per-project instead (see tick()), so a project override (or its own disable-at-0) is honored.
   */
  ratio?: number;
  /** Tick cadence; defaults to 60s (context grows slowly). Injectable so a test drives tick() directly. */
  intervalMs?: number;
}

/**
 * Context-recycle watcher (manager-recycle-by-context). Each tick, for every LIVE manager whose
 * measured context occupancy (`ctxInputTokens`, refreshed at each Stop) crosses `ratio` of its
 * MODEL window (`contextWindowForModel` — 1M for Opus/Sonnet 4.x, 200k otherwise, so the trigger
 * scales with the model), it injects a nudge telling the manager to wind down: run /loom-session-end, write
 * a continuation prompt, and call `recycle_me`. Agent-confirmed — the watcher only prompts; the manager
 * performs the handoff and Loom (recycleManager) boots the successor.
 *
 * Structural twin of IdleWatcher: the nudge state is PERSISTED (`last_context_nudge_at` /
 * `context_nudge_unanswered` / `context_nudge_policy`), not an in-memory Set, so a snooze/cap/escalation
 * survives a daemon restart. A fired nudge isn't repeated for another full `recycleNudgeIntervalMinutes`
 * window; a manager that has ignored `maxUnansweredRecycleNudges` consecutive nudges (still `watching`)
 * ESCALATES ONCE — we append a `context_escalated` event (the human-facing signal the web attention
 * surface derives an alert from) and flip policy to `escalated` (so nudging stops AND the policy gate
 * emits the event exactly once). Both knobs resolve per-project via resolveConfig (mirroring the idle
 * watchdog's `idleNudgeMinutes` / `maxUnansweredNudges`).
 *
 * No reset-on-activity (unlike IdleWatcher): in-session context only grows, and a context nudge is
 * answered by RECYCLING — which makes the manager go not-live and its successor a FRESH row with default
 * 'watching' state, so the cycle re-arms naturally without a counter reset.
 */
export class ContextWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: ContextWatcherDeps) {}

  tick(now: Date = new Date()): void {
    const { db, pty, ratio: envOverride } = this.deps;
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    for (const m of db.listLiveManagers()) {
      if (m.ctxInputTokens == null) continue;

      const project = db.getProject(m.projectId);
      if (!project) continue;
      const cfg = resolveConfig(project.config).orchestration;

      // Per-project threshold: an env force override wins for every project; otherwise this project's
      // OWN resolved recycleAtContextRatio (resolveConfig already folds the platform default under any
      // project override) — and a project setting 0 disables ITS OWN watcher, not the whole ticker.
      const ratio = envOverride && envOverride > 0 ? envOverride : cfg.recycleAtContextRatio;
      if (ratio <= 0) continue; // disabled for this project

      const window = contextWindowForModel(m.model);
      const r = m.ctxInputTokens / window;
      if (r < ratio) continue; // under this project's recycle threshold

      const state = db.getContextNudgeState(m.id);
      if (!state) continue;
      if (state.policy !== "watching") continue; // already escalated → silent

      // Re-nudge cadence: a fired nudge isn't repeated for another full window. The first nudge
      // (last_context_nudge_at null) fires immediately.
      if (state.lastContextNudgeAt) {
        const sinceMin = (nowMs - Date.parse(state.lastContextNudgeAt)) / 60_000;
        if (sinceMin < cfg.recycleNudgeIntervalMinutes) continue;
      }

      if (!pty.isAlive(m.id)) continue;

      const pct = Math.round(r * 100);
      const kw = Math.round(window / 1000);

      // ESCALATE-INSTEAD-OF-NUDGE: we're at the nudge-decision point (over-ratio, cadence elapsed, alive),
      // so a manager at/over the unanswered cap has slept through every nudge → escalate ONCE instead of
      // nudging again: append a `context_escalated` event (attention.ts derives the alert; we deliberately
      // do NOT enqueue a nudge) and flip policy to 'escalated' so the policy gate above skips it next tick
      // (emit EXACTLY ONCE). A recycled successor is a fresh 'watching' row, so the cycle re-arms.
      if (state.unanswered >= cfg.maxUnansweredRecycleNudges) {
        db.appendEvent({
          id: randomUUID(), ts: nowIso, managerSessionId: m.id, kind: "context_escalated",
          detail: { reason: "unanswered_cap", unanswered: state.unanswered, pct },
        });
        db.setContextNudgePolicy(m.id, "escalated");
        // eslint-disable-next-line no-console
        console.log(`[context-watcher] ESCALATED manager ${m.id} (${state.unanswered} unanswered recycle nudges → escalated, ~${pct}% of ${kw}k window)`);
        continue;
      }

      const msg =
        `[loom:context] Your context is ~${pct}% of your ${kw}k window — hand off before it fills. ` +
        `Wind down NOW: run /loom-session-end to log progress to the vault, then call recycle_me with a ` +
        `self-contained continuation prompt for your successor (current goal, what's done, your in-flight ` +
        `workers + their tasks/status, next steps, key decisions). Your successor boots with this agent's ` +
        `warm-up + your continuation and inherits your workers — finish merges/reviews you can close quickly first.`;
      try { pty.enqueueStdin(m.id, msg); } catch { /* manager not live */ }
      db.recordContextNudge(m.id, nowIso); // stamp last_context_nudge_at + increment context_nudge_unanswered
      // eslint-disable-next-line no-console
      console.log(`[context-watcher] nudged manager ${m.id} to recycle (~${pct}% of ${kw}k window, unanswered→${state.unanswered + 1})`);
    }
  }

  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
