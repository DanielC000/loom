import type { Session } from "@loom/shared";
import type { Db } from "../db.js";
import { claudeAdapter } from "../pty/claude-adapter.js";
import { codexAdapter } from "../pty/codex-adapter.js";
import { IncrementalContextStatsReader } from "./context.js";

/** Mirrors `contextTelemetryFor` in orchestration/context-watcher.ts and mcp/orchestration.ts — the SAME
 *  adapter capability flag, duplicated a third time rather than exported/imported (the existing two
 *  copies already duplicate it with no shared source; see codex-adapter.ts's own header for why it's
 *  `false` there). */
const contextTelemetryFor = (harness: Session["harness"]): boolean =>
  (harness === "codex" ? codexAdapter : claudeAdapter).capabilities.contextTelemetry;

export interface MidTurnContextSamplerDeps {
  db: Db;
  /** Tick cadence (ms); defaults to 60s. Injectable so a test drives tick() directly. */
  intervalMs?: number;
}

/**
 * Mid-turn context sampler. See `docs/decisions/c5b234aa-mid-turn-sampler-race-guard.md` for the
 * motivating incident (worker `09e8c9f1`'s silent mid-turn exhaustion) and why this is a standalone
 * ticker rather than folded into `ContextWatcher.tick()` — including the CORRECTION there that the
 * separation does NOT, by itself, make every existing `ctxUpdatedAt`/`ctxInputTokens` consumer safe
 * against a value that now advances far more often than once per turn (see `checkEmergencyOccupancy`'s
 * own per-turn de-dup fix, `orchestration/context-watcher.ts`, and the audit on card c5b234aa).
 *
 * SCOPE: every LIVE session with `busy:true`, `engineSessionId` set, AND `contextTelemetryFor(harness)`
 * true (claude today — codex has no hook relay to ever populate these fields regardless, see
 * codex-adapter.ts's own doc, card a1916267) — role-agnostic, mirroring the Stop hook's own "done for
 * EVERY session" posture. An idle session is skipped: its reading is already correct from its last Stop.
 *
 * RACE — see `Db.setContextCountersIfUnchanged`'s own doc: this sampler reads, awaits, then writes. If the
 * turn ENDS during that await, the Stop handler's write is authoritative and must never be clobbered by
 * this sampler's now-stale mid-turn reading landing after it — so every write here goes through the
 * compare-and-set setter, never the plain one, guarded by the `ctx_updated_at` snapshot taken BEFORE the
 * async read began.
 */
export class MidTurnContextSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private reader = new IncrementalContextStatsReader();
  /** Re-entrancy guard for the periodic timer only (mirrors UsageSampler): an overlapping fire is a
   *  no-op — a skipped periodic tick is harmless, the next one catches up. */
  private ticking = false;

  constructor(private deps: MidTurnContextSamplerDeps) {}

  /** One sampler pass: for every live, busy, context-telemetry-capable session, read its transcript's
   *  newly-appended bytes and race-guard-write a fresh mid-turn reading. Never throws. */
  async tick(): Promise<void> {
    const { db } = this.deps;
    for (const s of db.listLiveSessions()) {
      if (!s.busy || !s.engineSessionId || !contextTelemetryFor(s.harness)) continue;
      // Snapshot BEFORE the await — this is the value `setContextCountersIfUnchanged` compares against,
      // so a Stop write landing during the read below is correctly detected and never overwritten.
      const expectedCtxUpdatedAt = s.ctxUpdatedAt ?? null;
      let sample;
      try {
        sample = await this.reader.read(s.id, s.cwd, s.engineSessionId);
      } catch {
        continue; // never let one session's read failure abort the tick for the rest of the fleet
      }
      if (!sample) continue; // nothing NEW this tick (no appended bytes, a still-buffered partial line,
      // or a complete new line with no usage field yet) — see IncrementalContextStatsReader.read's own
      // doc for why it returns null rather than a stale cached value in every one of those cases.
      db.setContextCountersIfUnchanged(
        s.id, { ctxInputTokens: sample.inputTokens, ctxTurns: sample.turns, model: sample.model },
        expectedCtxUpdatedAt,
      );
    }
  }

  /** Drop ONE session's incremental-reader cache (on session exit — it never ticks again). */
  onSessionExit(sessionId: string): void { this.reader.drop(sessionId); }

  start(): void {
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.tick().catch(() => { /* never let a bad tick kill the loop */ }).finally(() => { this.ticking = false; });
    }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
