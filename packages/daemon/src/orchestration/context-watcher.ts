import { contextWindowForModel } from "@loom/shared";
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
  /** Fraction of the model's context window at which to nudge a manager to recycle. 0 disables. */
  ratio: number;
  /** Tick cadence; defaults to 60s (context grows slowly). Injectable so a test drives tick() directly. */
  intervalMs?: number;
}

/**
 * Context-recycle watcher (manager-recycle-by-context). Each tick, for every LIVE manager whose
 * measured context occupancy (`ctxInputTokens`, refreshed at each Stop) crosses `ratio` of its
 * MODEL window (`contextWindowForModel` — 1M for Opus/Sonnet 4.x, 200k otherwise, so the trigger
 * scales with the model), it injects a ONE-TIME nudge telling the manager to wind down: run
 * /session-end, write a continuation prompt, and call `recycle_me`. Agent-confirmed — the watcher
 * only prompts; the manager performs the handoff and Loom (recycleManager) boots the successor.
 *
 * Nudged-once: a manager is nudged a single time (tracked in-memory); the entry is dropped when it
 * goes not-live (so its recycled successor can later be nudged in turn). The nudge rides the busy-
 * gated queue, so it waits if the manager is mid-turn rather than corrupting it.
 */
export class ContextWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private nudged = new Set<string>();
  constructor(private deps: ContextWatcherDeps) {}

  tick(now: Date = new Date()): void {
    if (this.deps.ratio <= 0) return; // disabled
    const liveIds = new Set<string>();
    for (const m of this.deps.db.listLiveManagers()) {
      liveIds.add(m.id);
      if (this.nudged.has(m.id) || m.ctxInputTokens == null) continue;
      const window = contextWindowForModel(m.model);
      const r = m.ctxInputTokens / window;
      if (r < this.deps.ratio || !this.deps.pty.isAlive(m.id)) continue;

      const pct = Math.round(r * 100);
      const kw = Math.round(window / 1000);
      const msg =
        `[loom:context] Your context is ~${pct}% of your ${kw}k window — hand off before it fills. ` +
        `Wind down NOW: run /session-end to log progress to the vault, then call recycle_me with a ` +
        `self-contained continuation prompt for your successor (current goal, what's done, your in-flight ` +
        `workers + their tasks/status, next steps, key decisions). Your successor boots with this topic's ` +
        `warm-up + your continuation and inherits your workers — finish merges/reviews you can close quickly first.`;
      try { this.deps.pty.enqueueStdin(m.id, msg); } catch { /* manager not live */ }
      this.nudged.add(m.id);
      // eslint-disable-next-line no-console
      console.log(`[context-watcher] nudged manager ${m.id} to recycle (~${pct}% of ${kw}k window)`);
    }
    // Forget managers that are no longer live, so a recycled successor can be nudged when ITS turn comes.
    for (const id of [...this.nudged]) if (!liveIds.has(id)) this.nudged.delete(id);
  }

  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
