import { randomUUID } from "node:crypto";
import { resolveConfig, contextWindowForModel } from "@loom/shared";
import type { OrchestrationConfig, Session } from "@loom/shared";
import type { Db } from "../db.js";

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests claude-free). */
export interface ContextPty {
  isAlive(sessionId: string): boolean;
  /**
   * Nudge text into the session's busy-gated queue (waits if the manager is mid-turn). The real
   * PtyHost.enqueueStdin returns a richer `EnqueueResult` (see pty/host.ts) with THREE possible
   * outcomes, collapsed here to the two this watcher needs to distinguish: `delivered:true` (handed
   * straight to submit() this turn) or `delivered:false, queued:true` (durably held, lands at the
   * next turn boundary) both mean the nudge was ACCEPTED; `delivered:false` with `queued` falsy means
   * it was NOT accepted at all (e.g. the session went not-live between our own isAlive check above and
   * this call) — card 49fdcbbc: tick() below must not treat that as a sent nudge.
   */
  enqueueStdin(sessionId: string, text: string): { delivered: boolean; position?: number; queued?: boolean };
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
 *
 * BLIND-TURN advisory (card fdf1291f) — a SECOND, independent signal, checked every tick alongside the
 * ratio logic above: `ctxInputTokens`/`ctxUpdatedAt` refresh ONLY at the Stop hook (end of a LOGICAL
 * turn), so a manager that issues hundreds of tool round-trips inside ONE turn (never reaching Stop) is
 * invisible to the ratio check above for the ENTIRE duration — the worst case, since a long tool-looping
 * turn is both the fastest way to burn context and the thing that suppresses the only signal measuring
 * it (the incident this card investigates: ~65min blind, ending only because a human intervened). The fix
 * is NOT a numeric occupancy estimate composed from `session_usage_samples` — those columns are
 * per-interval BILLED-USAGE deltas, not context occupancy, and composing them into a % would need the
 * turn-to-turn prompt-cache hit rate (unknowable from that table alone — a broken cache prefix inflates
 * them by an unbounded factor; see `cacheHitRatio`'s doc) — shipping a wrong number here would be worse
 * than the blindness it replaces. Instead this reuses BusyWorkerWatcher's PROVEN signal (`busy` +
 * `lastActivity` staleness — `lastActivity` only moves at turn EDGES for a manager exactly as it does for
 * a worker), scoped to managers, gated by `managerBlindTurnMinutes`; `session_usage_samples` is consulted
 * ONLY as a best-effort diagnostic (confirms genuine token flow during the gap, reported alongside the
 * alert) via `getUsageActivitySince`, never as the trigger itself. On trip it appends ONE
 * `context_blind_turn` event (once per episode, mirroring `worker_stuck`'s de-dup) — a SOFT, human-facing
 * advisory only. It deliberately does NOT attempt a queued nudge: the busy-gated stdin queue is exactly
 * the mechanism that can't reach a manager stuck mid-turn (it lands, unread, at the next turn boundary —
 * the very event that isn't arriving), and building an actual turn-interrupt is sibling card 9f279c7b's
 * concern, not this watcher's.
 */
export class ContextWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: ContextWatcherDeps) {}

  tick(now: Date = new Date()): void {
    const { db, pty, ratio: envOverride } = this.deps;
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    for (const m of db.listLiveManagers()) {
      const project = db.getProject(m.projectId);
      if (!project) continue;
      const cfg = resolveConfig(project.config).orchestration;

      // BLIND-TURN advisory (card fdf1291f) — the second, turn-boundary-independent input (see the class
      // doc above). Runs for EVERY live manager, armed or not, BEFORE (and regardless of) the
      // ctxInputTokens null-skip just below — that skip is exactly the blind spot this closes.
      this.checkBlindTurn(db, pty, m, cfg, nowMs, nowIso);

      if (m.ctxInputTokens == null) continue;

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
      // Card 49fdcbbc: use the return value instead of discarding it. `delivered:true` (handed straight
      // to submit()) and `delivered:false, queued:true` (durably held — the doc on EnqueueResult says
      // this WILL land at the next turn boundary unless redelivery is later exhausted, an async failure
      // this synchronous call can't see) both mean the nudge was ACCEPTED, so both are recorded the same
      // way — that is the explicit "queued should probably count" call from the card, made because we
      // have no cheaper way here to tell queued-then-delivered from queued-and-later-parked. Anything else
      // (not accepted — e.g. the session died between our own isAlive check above and this call, or the
      // stub throws) must NOT stamp the cooldown or increment the escalation counter: an undelivered nudge
      // must not buy silence, and it must not count a strike toward a human-facing escalation that reads
      // "this manager has slept through every nudge" when it may never have been told at all.
      let result: { delivered: boolean; queued?: boolean };
      let threw = false;
      try { result = pty.enqueueStdin(m.id, msg); } catch { threw = true; result = { delivered: false, queued: false }; }
      if (!result.delivered && !result.queued) {
        // State what was OBSERVED, not an inferred cause: enqueueStdin's real implementation never
        // actually throws for "manager not live" (that path returns deliveryState:"dropped" instead —
        // see the interface doc above), so a caught throw here is NOT known to mean that. Naming an
        // unestablished cause is exactly the failure this card exists to remove.
        // eslint-disable-next-line no-console
        console.log(`[context-watcher] nudge to manager ${m.id} was NOT accepted (${threw ? "enqueueStdin threw" : "enqueueStdin reported neither delivered nor queued"}) — not recording a sent nudge, not counting a strike`);
        continue;
      }
      db.recordContextNudge(m.id, nowIso); // stamp last_context_nudge_at + increment context_nudge_unanswered
      // eslint-disable-next-line no-console
      console.log(`[context-watcher] nudged manager ${m.id} to recycle (${result.delivered ? "delivered" : "queued, lands next turn"}; ~${pct}% of ${kw}k window, unanswered→${state.unanswered + 1})`);
    }
  }

  /**
   * BLIND-TURN advisory — see the class doc's own section for the full rationale. Signal: `busy` +
   * `lastActivity` staleness, exactly BusyWorkerWatcher's proven mechanism for the identical worker-side
   * gap, scoped to managers. `lastActivity` on a busy session is stamped at the CURRENT turn's start (a
   * rising edge) and never touched again until the falling edge at Stop — so for a busy manager, `now -
   * lastActivity` is precisely how long it has been in ONE uninterrupted turn, independent of whether
   * `ctxInputTokens` has EVER been set. Deliberately does NOT require `ctxInputTokens == null`: a manager
   * that already has a STALE (non-null) reading from a PRIOR turn and is now mid a NEW long blind turn is
   * the more dangerous, recurring form of this gap (its last known occupancy could already be high), and
   * excluding it would silently miss that case.
   */
  private checkBlindTurn(db: Db, pty: ContextPty, m: Session, cfg: OrchestrationConfig, nowMs: number, nowIso: string): void {
    if (cfg.managerBlindTurnMinutes <= 0) return; // disabled for this project
    if (!m.busy) return; // idle → lastActivity means nothing here; not this watchdog's concern

    const lastActivityMs = Date.parse(m.lastActivity);
    const busyForMin = (nowMs - lastActivityMs) / 60_000;
    if (busyForMin < cfg.managerBlindTurnMinutes) return;

    if (!pty.isAlive(m.id)) return; // db says live but pty is gone → skip (nothing to surface about)

    // Once-per-episode: skip if we already flagged THIS turn (an event stamped strictly after it began).
    // A Stop eventually landing advances lastActivity past it (the NEXT turn's rising edge), re-arming —
    // mirrors BusyWorkerWatcher's identical `worker_stuck` de-dup.
    const already = db.getLatestEventForManagerByKind(m.id, "context_blind_turn");
    if (already && already.ts > m.lastActivity) return;

    const n = Math.round(busyForMin);
    // Best-effort diagnostic ONLY — see getUsageActivitySince's own doc for why this can't be the trigger
    // itself. A sampler outage (activity === null) must NOT suppress the alert; it just can't confirm
    // genuine token flow, so the event says so plainly instead of guessing a number.
    const activity = db.getUsageActivitySince(m.id, m.lastActivity);

    db.appendEvent({
      id: randomUUID(), ts: nowIso, managerSessionId: m.id, kind: "context_blind_turn",
      detail: { minutesBusy: n, tokensSinceLastKnown: activity?.totalTokens ?? null, sampleCount: activity?.sampleCount ?? 0 },
    });
    // eslint-disable-next-line no-console
    console.log(`[context-watcher] manager ${m.id} BLIND ~${n}m in one turn (no Stop → ctx unmeasured)` +
      (activity ? ` — ~${activity.totalTokens} tokens recorded since (${activity.sampleCount} sample(s))` : " — no usage samples recorded yet"));
  }

  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
