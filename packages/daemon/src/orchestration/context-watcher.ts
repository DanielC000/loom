import { createHash, randomUUID } from "node:crypto";
import { resolveConfig, contextWindowForModel } from "@loom/shared";
import type { OrchestrationConfig, Session } from "@loom/shared";
import type { Db } from "../db.js";
import type { PtyHost } from "../pty/host.js";
import { contextTelemetryFor } from "../pty/adapter.js";
import { checkContextExhaustion, checkRecoveryEvidence } from "./context-exhaustion.js";

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests claude-free).
 *  Card 1837a542: `isComposerDirty` is the OWNER's unsubmitted raw-terminal draft (`composerLen > 0`, the same gate the
 *  drain defers on) and is `Pick`ed from PtyHost so a rename fails to compile. It is deliberately NOT
 *  `getComposerDirtyLen` (characters Loom's own submit() may have stranded). Called as `pty.isComposerDirty?.(id)`
 *  so a fixture that omits it reads as "no draft". */
export interface ContextPty extends Pick<PtyHost, "isComposerDirty"> {
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
  /** Card 66ff7321 — mark a session context-exhausted (holds delivery, clears busy). See
   *  PtyHost.markContextExhausted's own doc. Returns false when there's no live claude session to mark. */
  markContextExhausted(sessionId: string): boolean;
  /** @decision 5f825506 — REQUIRED (round 2) so a `PtyHost.busySinceMs` rename fails to compile
   *  rather than silently failing open; still called as `pty.busySinceMs?.(id) ?? null`. */
  busySinceMs(sessionId: string): number | null;
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
  /**
   * Daemon-internal emergency-recycle interrupt hook (card 9f279c7b, Trigger A — see
   * `checkEmergencyOccupancy`'s own doc). Wraps `SessionService.redirectManagerForEmergencyRecycle` —
   * injected rather than imported directly so this file (and its tests) stay SessionService-free, exactly
   * like `pty` above is an injected slice of PtyHost rather than the real thing. Optional: a caller (or a
   * test harness that only cares about the ratio/blind-turn logic) that omits it just gets Trigger A
   * permanently no-op — never throws, mirrors every other optional callback in this watcher family.
   */
  emergencyInterrupt?: (managerSessionId: string, text: string) => EmergencyInterruptOutcome;
  /**
   * Daemon-internal WORKER context-interrupt hook (card dacc6d9e, Trigger D — see
   * `checkWorkerContextInterrupt`'s own doc). Wraps `SessionService.redirectWorkerForContextInterrupt` —
   * injected for the SAME SessionService-free reason as `emergencyInterrupt` above. Takes the WORKER's own
   * session id only (the method derives its owning manager internally). Optional, same no-op-when-omitted
   * contract as `emergencyInterrupt`.
   */
  workerContextInterrupt?: (workerSessionId: string, text: string) => EmergencyInterruptOutcome;
  /**
   * Loom-authored owner chat message for an exhausted Companion (index.ts wraps
   * `CompanionController.notifyOwnerContextExhausted`). Called at most once per exhaustion episode (deduped
   * durably in app_meta by the inbox notice id). Optional: omitted ⇒ no chat message, inbox notice only.
   * Must not throw; a rejection is recorded as a send-failed event and never retried.
   */
  notifyCompanionOwner?: (companionSessionId: string, kind?: "exhausted" | "auto-recycled") => Promise<{ outcome: "sent" | "no-binding" | "send-failed"; channel?: string; reason?: string }>;
  /**
   * Card 1837a542 — the SAME recycle the human `POST /api/companion/:sessionId/recycle` runs (index.ts wraps
   * `CompanionController.recycle`; never a second implementation). Invoked at most once per exhaustion
   * episode, and only for a Companion whose owner set `autoRecycleOnExhaustion`. Optional: omitted ⇒ the
   * opt-in is inert and behavior is exactly the notice-only path.
   */
  recycleCompanion?: (companionSessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

/**
 * `emergencyInterrupt`'s return shape — deliberately NOT `RedirectResult` (sessions/service.ts's private
 * type): this file has no business knowing that shape, only the honest subset it needs to log and record
 * (card 9f279c7b DoD-5 — do not inherit `49fdcbbc`'s "discard the real outcome, stamp success anyway" bug).
 * `fired:false` means the interrupt was NOT attempted at all (e.g. `reason:"merge-danger-window"`) — the
 * caller (index.ts) must not report `delivered`/`interrupting` in that case, since neither ever ran.
 */
export interface EmergencyInterruptOutcome {
  fired: boolean;
  reason?: string;
  delivered?: boolean;
  interrupting?: boolean;
}

/**
 * The ordinary (queued, busy-gated) recycle nudge's own text prefix — exported so
 * `SessionService.carryPendingToSuccessor`'s DoD-4 purge (sessions/service.ts) can find and drop a
 * still-queued copy at recycle time, sharing this ONE literal instead of a second hand-typed copy that
 * could silently drift from it.
 */
export const CONTEXT_RECYCLE_NUDGE_PREFIX = "[loom:context]";

/**
 * The "how to hand off" tail shared by every ordinary recycle nudge (ratio path, turn-count path, and
 * `SessionService.switchHarnessNow`) — one literal so the wording cannot drift between them.
 */
export const RECYCLE_WIND_DOWN_INSTRUCTIONS =
  `Wind down NOW: run /loom-session-end to log progress to the vault, then call recycle_me with a ` +
  `self-contained continuation prompt for your successor (current goal, what's done, your in-flight ` +
  `workers + their tasks/status, next steps, key decisions). Your successor boots with this agent's ` +
  `warm-up + your continuation and inherits your workers — finish merges/reviews you can close quickly first.`;

/**
 * The emergency (Trigger A) interrupt's own wire tag — see `checkEmergencyOccupancy`'s doc for why this
 * is a bespoke tag rather than `frameFromManager`'s `[loom:from-manager]` shape (the target here IS the
 * manager; there is no "from-manager" to speak of). Exported for the SAME reason as the prefix above: the
 * DoD-4 purge and `SessionService.redirectManagerForEmergencyRecycle`'s own frame builder share this one
 * literal.
 */
export const CONTEXT_EMERGENCY_REDIRECT_TAG = "loom:context-emergency:redirect";

/**
 * The worker context-interrupt (Trigger D) wire tag — the worker-scoped twin of
 * `CONTEXT_EMERGENCY_REDIRECT_TAG` above, same bespoke-tag reasoning (the target IS the worker; this is a
 * Loom-originated interrupt, not a real manager redirect, so it never rides `frameFromManager`'s
 * `[loom:from-manager]` shape). Exported for `SessionService.redirectWorkerForContextInterrupt`'s own
 * frame builder to share this one literal.
 */
export const WORKER_CONTEXT_INTERRUPT_TAG = "loom:worker-context-interrupt:redirect";

/**
 * The manager-facing notice prefix for the soft worker-context warning (Trigger C) — distinct from the
 * manager-facing notice `checkWorkerContextInterrupt` pushes after Trigger D fires (that one uses the
 * literal `[loom:worker-context-interrupt]`, never this constant, so the two are never confused by a
 * reader grepping for either).
 */
export const WORKER_CONTEXT_WARN_PREFIX = "[loom:worker-context-high]";

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
 * No reset-on-activity (unlike IdleWatcher): a context nudge is answered by RECYCLING — which makes the
 * manager go not-live and its successor a FRESH row with default 'watching' state, so the cycle re-arms
 * naturally without a counter reset. (Occupancy is NOT guaranteed to only grow within one session —
 * auto-compact can shrink it mid-session; see the accepted residual in
 * `docs/decisions/9f279c7b-contextwatcher-emergency-recycle-interrupt-trigger-a.md`. The re-arm above
 * doesn't rely on monotonic growth — it relies on a recycle minting a fresh row.)
 *
 * BLIND-TURN advisory (Trigger B, `checkBlindTurn` below) — a second, independent signal, checked every
 * tick regardless of `ctxInputTokens`; advisory-only, never a queued nudge (can't reach a stuck manager).
 * @decision fdf1291f — reuses BusyWorkerWatcher's busy+lastActivity signal, never a numeric occupancy estimate.
 *
 * EMERGENCY INTERRUPT (Trigger A, `checkEmergencyOccupancy` below) — a third signal that BYPASSES the
 * queue once a second, harder floor is crossed; Trigger B deliberately never escalates into it.
 * @decision 9f279c7b — reuses `worker_redirect`'s deliverRedirect primitive; refuses during merge-danger.
 *
 * WORKER CONTEXT WARN (Trigger C, `checkWorkerContextWarn` below) + WORKER CONTEXT INTERRUPT (Trigger D,
 * `checkWorkerContextInterrupt` below) — card dacc6d9e, part B of epic 8c7dfc65, the worker-scoped twins
 * of Triggers A/B/the ordinary ratio nudge, over a THIRD loop (`db.listLiveWorkers()`). Trigger C pushes
 * an informational `[loom:worker-context-high]` notice to the OWNING MANAGER once `workerContextWarnRatio`
 * is crossed — never a nudge to the worker itself (a worker has no wind-down/recycle doctrine of its own).
 * Trigger D Esc-interrupts the worker directly once `workerContextInterruptRatio` is crossed WHILE the
 * worker is busy (an idle worker, including one `awaitingReview`, isn't burning context and must not be
 * forced to re-report) and no gate (merge-confirm or the worker's own run_gate self-check) is live for its
 * session id (`SessionService.hasLiveGateForSession`) — see `checkWorkerContextInterrupt`'s own doc. Both
 * fire AT MOST ONCE EVER per worker session id, like Trigger A, for the identical reason (the interrupt's
 * own Esc→settle→drain mutates `busy`/`lastActivity`/`turnSeq`).
 */
export class ContextWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: ContextWatcherDeps) {}

  tick(now: Date = new Date()): void {
    const { db, pty, ratio: envOverride } = this.deps;
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    for (const m of db.listLiveManagers()) {
      // Card 66ff7321 — CONTEXT-EXHAUSTION detection, checked FIRST and unconditionally for every busy
      // manager, same shape as BusyWorkerWatcher's own worker-side check (see that file's doc for why
      // this must be tick-detected: no Stop/StopFailure hook ever fires for this failure).
      if (this.checkContextExhaustion(db, pty, m, nowIso)) continue;
      // Round 2: an ALREADY-exhausted session (marked on an earlier tick) must also skip every ordinary
      // signal below — see isAlreadyContextExhausted's own doc.
      if (this.isAlreadyContextExhausted(m)) continue;

      const project = db.getProject(m.projectId);
      if (!project) continue;
      const cfg = resolveConfig(project.config).orchestration;

      // BLIND-TURN advisory (card fdf1291f) — the second, turn-boundary-independent input (see the class
      // doc above). Runs for EVERY live manager, armed or not, BEFORE (and regardless of) the
      // ctxInputTokens null-skip just below — that skip is exactly the blind spot this closes.
      this.checkBlindTurn(db, pty, m, cfg, nowMs, nowIso);

      // TURN-COUNT FALLBACK (card 5b1f7ec6): a harness with `contextTelemetry:false` (codex) NEVER measures
      // `ctxInputTokens`, so the ratio path below can never fire for it. Gated on the ADAPTER capability, not
      // on the null alone — a claude manager that merely hasn't completed a Stop yet is also null and must
      // stay on the plain `continue` (claude behaviour byte-identical).
      if (m.ctxInputTokens == null) {
        if (!contextTelemetryFor(m.harness)) this.checkTurnCountRecycle(db, pty, m, cfg, envOverride, nowMs, nowIso);
        continue;
      }

      const window = contextWindowForModel(m.model);
      const r = m.ctxInputTokens / window;

      // EMERGENCY INTERRUPT (card 9f279c7b, Trigger A — see the class doc above). Checked BEFORE, and
      // independent of, the ordinary ratio/policy logic below: it must still fire even when the ordinary
      // nudge is disabled for this project (ratio 0) or already escalated (policy 'escalated'), and it
      // must not share that nudge's re-nudge cadence — a stuck-mid-turn manager needs the interrupt on
      // ITS OWN de-dup, not queued behind the routine nudge's cooldown.
      this.checkEmergencyOccupancy(db, m, cfg, r, window, nowIso);

      // Per-project threshold: an env force override wins for every project; otherwise this project's
      // OWN resolved recycleAtContextRatio (resolveConfig already folds the platform default under any
      // project override) — and a project setting 0 disables ITS OWN watcher, not the whole ticker.
      const ratio = envOverride && envOverride > 0 ? envOverride : cfg.recycleAtContextRatio;
      if (ratio <= 0) continue; // disabled for this project
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
        `${CONTEXT_RECYCLE_NUDGE_PREFIX} Your context is ~${pct}% of your ${kw}k window — hand off before it fills. ` +
        RECYCLE_WIND_DOWN_INSTRUCTIONS;
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

    // PLATFORM LEAD turn-count fallback (card a1263b45). The Lead is `role:'platform'`, so the manager loop
    // above never sees it — and it has NO ratio-based nudge either (claude Leads are deliberately unwatched
    // here; only IdleWatcher covers them). So this loop runs ONLY the telemetry-less turn-count fallback,
    // gated on the adapter capability: a claude Lead is skipped outright (byte-identical to before).
    for (const lead of db.listLivePlatformSessions()) {
      // Card 66ff7321 — CONTEXT-EXHAUSTION detection, same shape as the manager loop above, checked
      // BEFORE the claude-lead skip just below: this detector applies regardless of ctx-telemetry
      // capability (a codex lead's transcript simply never matches, no separate gate needed).
      if (this.checkContextExhaustion(db, pty, lead, nowIso)) continue;
      if (this.isAlreadyContextExhausted(lead)) continue;
      if (contextTelemetryFor(lead.harness)) continue;
      const project = db.getProject(lead.projectId);
      if (!project) continue;
      const cfg = resolveConfig(project.config).orchestration;
      this.checkTurnCountRecycle(db, pty, lead, cfg, envOverride, nowMs, nowIso);
    }

    // COMPANION (assistant-role) context-exhaustion — detection + owner notice ONLY. A Companion has no
    // recycle path and no ratio nudges (it has no wind-down doctrine), so this loop runs nothing but the
    // exhaustion check. Its owner-facing channel IS the dead session, hence the daemon-authored inbox notice.
    for (const a of db.listLiveAssistants()) {
      if (this.checkAssistantContextExhaustion(db, pty, a, nowIso)) continue;
      // Already marked on an earlier tick: re-assert the notice by its deterministic id. No-op when it exists
      // (covers every later tick AND a daemon restart); heals a crash between the mark and the notice insert.
      if (a.contextExhaustedAt != null) {
        this.afterAssistantExhausted(db, pty, a, this.ensureAssistantExhaustionNotice(db, a, a.contextExhaustedAt));
      } else {
        this.endAssistantEpisodeIfRecovered(db, a);
      }
    }

    // WORKER CONTEXT (Triggers C/D, card dacc6d9e) — a third, separate loop (workers are a structurally
    // different session kind from managers/leads, with a different owning-manager-notify shape; same
    // reasoning BusyWorkerWatcher is its own class rather than a worker branch bolted onto this one).
    for (const w of db.listLiveWorkers()) {
      // Card 66ff7321 / dacc6d9e round 3 (CR round 2 finding) — this loop must stay READ-ONLY for
      // exhaustion: `BusyWorkerWatcher` owns marking (`pty.markContextExhausted`) and filing/notifying
      // (`worker_context_exhausted`) for a WORKER session, on its own identical, same-cadence detection.
      // Calling this class's OWN marking method (`checkContextExhaustion` below) here raced that —
      // ContextWatcher starts before BusyWorkerWatcher and Node fires equal-interval timers in creation
      // order, so this loop deterministically won the race, permanently stealing the mark: it filed
      // `manager_context_exhausted` under the WORKER's own session id and starved
      // `BusyWorkerWatcher`'s own `worker_context_exhausted` event/notice (whose loser-side `if (marked)`
      // guard then always no-ops) — the event the companion's attention-push classifier and any
      // `worker_context_exhausted`-gated event trigger depend on. See docs/decisions/dacc6d9e-*.md round 3.
      if (this.isAlreadyContextExhausted(w)) continue;
      if (this.isWorkerContextExhaustedUnmarked(pty, w)) continue;
      if (!contextTelemetryFor(w.harness)) continue; // codex: no ctx telemetry, never measured
      if (w.ctxInputTokens == null) continue; // claude, pre-first-Stop/pre-first-mid-turn-sample
      const project = db.getProject(w.projectId);
      if (!project) continue;
      const cfg = resolveConfig(project.config).orchestration;
      const window = contextWindowForModel(w.model);
      const r = w.ctxInputTokens / window;
      this.checkWorkerContextWarn(db, pty, w, cfg, r, window, nowIso);
      this.checkWorkerContextInterrupt(db, w, cfg, r, window, nowIso);
    }
  }

  /**
   * TURN-COUNT recycle fallback for a manager whose harness has no context telemetry (card 5b1f7ec6). Sends
   * the SAME ordinary, queued recycle nudge (`CONTEXT_RECYCLE_NUDGE_PREFIX`) as the ratio path — never the
   * emergency interrupt (that needs a real occupancy reading, see `checkEmergencyOccupancy`) — with the same
   * per-project cadence, unanswered-cap escalation and DoD-4 purge behaviour. Signal: `turnSeq`, the
   * completed-turn counter codex's own turn-completion chokepoint bumps (pty/host.ts `onTurnCompleted`), vs
   * `recycleAtTurnsNoTelemetry`. A project that disabled recycle nudging (`recycleAtContextRatio` 0, no env
   * force) disables this too.
   */
  private checkTurnCountRecycle(db: Db, pty: ContextPty, m: Session, cfg: OrchestrationConfig, envOverride: number | undefined, nowMs: number, nowIso: string): void {
    const limit = cfg.recycleAtTurnsNoTelemetry;
    if (limit <= 0) return; // fallback disabled for this project
    if (!(envOverride && envOverride > 0) && cfg.recycleAtContextRatio <= 0) return; // recycle nudging disabled
    const turns = m.turnSeq ?? 0;
    if (turns < limit) return;

    const state = db.getContextNudgeState(m.id);
    if (!state) return;
    if (state.policy !== "watching") return; // already escalated → silent
    if (state.lastContextNudgeAt) {
      const sinceMin = (nowMs - Date.parse(state.lastContextNudgeAt)) / 60_000;
      if (sinceMin < cfg.recycleNudgeIntervalMinutes) return;
    }
    if (!pty.isAlive(m.id)) return;

    if (state.unanswered >= cfg.maxUnansweredRecycleNudges) {
      db.appendEvent({
        id: randomUUID(), ts: nowIso, managerSessionId: m.id, kind: "context_escalated",
        detail: { reason: "unanswered_cap", unanswered: state.unanswered, pct: null, turns },
      });
      db.setContextNudgePolicy(m.id, "escalated");
      // eslint-disable-next-line no-console
      console.log(`[context-watcher] ESCALATED manager ${m.id} (${state.unanswered} unanswered recycle nudges → escalated, ${turns} turns, no context telemetry)`);
      return;
    }

    const msg =
      `${CONTEXT_RECYCLE_NUDGE_PREFIX} You have completed ${turns} turns this session and your harness reports no ` +
      `context telemetry, so your context can't be measured — hand off before it fills. ` +
      RECYCLE_WIND_DOWN_INSTRUCTIONS;
    let result: { delivered: boolean; queued?: boolean };
    let threw = false;
    try { result = pty.enqueueStdin(m.id, msg); } catch { threw = true; result = { delivered: false, queued: false }; }
    if (!result.delivered && !result.queued) {
      // eslint-disable-next-line no-console
      console.log(`[context-watcher] turn-count nudge to manager ${m.id} was NOT accepted (${threw ? "enqueueStdin threw" : "enqueueStdin reported neither delivered nor queued"}) — not recording a sent nudge, not counting a strike`);
      return;
    }
    db.recordContextNudge(m.id, nowIso);
    // eslint-disable-next-line no-console
    console.log(`[context-watcher] nudged manager ${m.id} to recycle by turn count (${result.delivered ? "delivered" : "queued, lands next turn"}; ${turns} turns >= ${limit}, no context telemetry, unanswered→${state.unanswered + 1})`);
  }

  /**
   * Card 66ff7321 — CONTEXT-EXHAUSTION detection, manager/platform twin of
   * `BusyWorkerWatcher`'s own worker-side check (see that file's doc for the full mechanism and why
   * this must be tick-detected rather than hook-delivered). Returns `true` iff this session was found
   * exhausted THIS tick (whether or not a fresh mark was actually applied) — the caller's signal to
   * `continue` past the rest of this session's ordinary context-nudge logic, which would otherwise
   * read a now-false `busy` and a stale `ctxInputTokens` reading.
   *
   * No direct nudge — there is no owning parent to push into (a manager/platform session is the top
   * of its own lineage). Surfaced via the SAME human-attention classification `context_escalated`/
   * `context_blind_turn` already use (companion/attention-push.ts `classify()` → "context-overflow")
   * plus `lastError`, never a new push channel.
   */
  private checkContextExhaustion(db: Db, pty: ContextPty, m: Session, nowIso: string): boolean {
    if (!m.busy || m.harness === "codex" || !m.engineSessionId) return false;
    const exhaustion = checkContextExhaustion(m.cwd, m.engineSessionId, m.harness, pty.busySinceMs?.(m.id) ?? null);
    if (!exhaustion) return false;
    const marked = pty.markContextExhausted(m.id);
    if (marked) {
      db.setContextExhausted(m.id, nowIso, `Context exhausted — the engine rejected the next prompt as too long (${exhaustion.matchedText}).`);
      db.appendEvent({
        id: randomUUID(), ts: nowIso, managerSessionId: m.id, kind: "manager_context_exhausted",
        detail: { error: exhaustion.error ?? null },
      });
      // eslint-disable-next-line no-console
      console.log(`[context-watcher] manager/platform ${m.id} CONTEXT-EXHAUSTED (${exhaustion.error ?? "unknown error"}) — busy cleared, queue held, surfaced via lastError/attention-push`);
    }
    return true;
  }

  /**
   * Companion twin of `checkContextExhaustion` above: same detector, same mark + `lastError`, but a DISTINCT
   * event kind (`assistant_context_exhausted` — the manager kind's web/fleet consumers say "recycle it",
   * which no Companion path supports) and an owner notice through the inbox instead of a push into the
   * dead session. Returns true iff exhaustion was found this tick.
   */
  private checkAssistantContextExhaustion(db: Db, pty: ContextPty, a: Session, nowIso: string): boolean {
    if (!a.busy || a.harness === "codex" || !a.engineSessionId) return false;
    const exhaustion = checkContextExhaustion(a.cwd, a.engineSessionId, a.harness, pty.busySinceMs?.(a.id) ?? null);
    if (!exhaustion) return false;
    const marked = pty.markContextExhausted(a.id);
    if (marked) {
      db.setContextExhausted(a.id, nowIso, `Context exhausted — the engine rejected the next prompt as too long (${exhaustion.matchedText}).`);
      const noticeId = this.ensureAssistantExhaustionNotice(db, a, nowIso);
      db.appendEvent({
        id: randomUUID(), ts: nowIso, managerSessionId: a.id, kind: "assistant_context_exhausted",
        detail: { error: exhaustion.error ?? null, noticeId },
      });
      // eslint-disable-next-line no-console
      console.log(`[context-watcher] companion ${a.id} CONTEXT-EXHAUSTED (${exhaustion.error ?? "unknown error"}) — busy cleared, queue held, owner notice filed`);
      this.afterAssistantExhausted(db, pty, a, noticeId);
    }
    return true;
  }

  /**
   * What happens once per tick for an exhausted Companion whose notice is in force. Flag OFF (the default) or
   * no recycle hook wired: exactly the pre-existing path — the ONE owner chat message, "press Recycle".
   *
   * @decision 1837a542 — never retry; claim BEFORE the recycle, never while deferred; no second episode key.
   *
   * Flag ON: run the same recycle the human button runs, at most once per episode.
   *   - DEFER while the composer holds an unsubmitted draft: no claim, no recycle, no chat message; the next tick
   *     re-checks, with no upper bound (an abandoned draft holds auto-recycle off; the owner can still press
   *     Recycle). A draft is never destroyed.
   *   - The episode claim is app_meta `ASSISTANT_AUTO_RECYCLE_META_PREFIX+id` = the notice id, taken BEFORE the
   *     recycle runs: at most one attempt per episode, no retry on any outcome. The notice id IS the episode
   *     identity 62279e05's chat claim already uses; a new episode files a new id.
   *   - The owner's ONE chat message waits for the outcome: "auto-recycled" on success, the ordinary
   *     "exhausted, press Recycle" on failure.
   */
  private afterAssistantExhausted(db: Db, pty: ContextPty, a: Session, noticeId: string | null): void {
    const recycle = this.deps.recycleCompanion;
    let auto = false;
    try { auto = !!recycle && !!noticeId && db.getCompanionConfig(a.id)?.autoRecycleOnExhaustion === true; } catch { auto = false; }
    if (!auto || !recycle || !noticeId) { this.maybeNotifyAssistantOwnerChat(db, a, noticeId, "exhausted"); return; }
    let draft = false;
    try { draft = pty.isComposerDirty?.(a.id) === true; } catch { draft = false; }
    if (draft) return; // never destroy the owner's unfinished draft; retried next tick
    const key = `${ASSISTANT_AUTO_RECYCLE_META_PREFIX}${a.id}`;
    try {
      if (!db.claimMeta(key, noticeId)) return; // already attempted (or in flight) this episode
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[context-watcher] could not claim the auto-recycle for companion ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[context-watcher] companion ${a.id} exhausted with auto-recycle ON — recycling onto a fresh session`);
    let p: ReturnType<typeof recycle>;
    try { p = recycle(a.id); } catch (err) { p = Promise.reject(err); }
    void p.then(
      (r) => (r.ok ? this.onAutoRecycled(db, a, noticeId) : this.onAutoRecycleFailed(db, a, noticeId, r.error)),
      (err) => this.onAutoRecycleFailed(db, a, noticeId, err instanceof Error ? err.message : String(err)),
    );
  }

  private onAutoRecycled(db: Db, a: Session, noticeId: string): void {
    try {
      db.appendEvent({
        id: randomUUID(), ts: new Date().toISOString(), managerSessionId: a.id,
        kind: "assistant_auto_recycle", detail: { outcome: "recycled", noticeId },
      });
      // The recycle dismissed the "has run out of context" notice; leave the owner an UNREAD record of what happened.
      const name = this.assistantDisplayName(db, a);
      this.insertAssistantNotice(db, a, assistantExhaustionNoticeId(a.id, `auto-recycled|${noticeId}`),
        `${name}${ASSISTANT_AUTO_RECYCLED_TITLE_SUFFIX}`,
        `${name} (session ${a.id.slice(0, 8)}) hit its context limit and, because you turned on auto-recycle for it, ` +
        `Loom recycled it onto a fresh session. It keeps its chat bindings, memory and grants, and anything queued ` +
        `meanwhile was delivered. It lost the earlier conversation context, and its trust window and any inline ` +
        `authored-content grant are closed. You can turn auto-recycle off on this Companion's page.`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[context-watcher] could not record the auto-recycle for companion ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[context-watcher] companion ${a.id} AUTO-RECYCLED`);
    this.maybeNotifyAssistantOwnerChat(db, a, noticeId, "auto-recycled");
  }

  /** A failed auto-recycle is never retried. The original "press Recycle" notice stays open and a SECOND, fresh
   *  (unread) notice says the automatic attempt failed — the notice store has no re-surface-on-edit, so a new row
   *  is the way to put it back in front of the owner. */
  private onAutoRecycleFailed(db: Db, a: Session, noticeId: string, reason: string): void {
    // SUPERSEDED: the owner recovered it by hand while this attempt was in flight (or the recycle refused for "not
    // exhausted"). Record that and tell the owner NOTHING — a "failed" notice or "press Recycle" message about a
    // Companion that is already healthy would be false. The signal is the episode's OWN notice being DISMISSED
    // (the manual recycle and the recovery sweep both dismiss it), NEVER `contextExhaustedAt == null`: that mark
    // also goes null transiently on ANY turn's busy rising edge (handleBusyEdge), e.g. an owner message sent
    // mid-attempt, after which the turn fails and re-marks into the SAME open notice — a real failure that must
    // not be swallowed (the claim is held, so nothing would ever tell the owner).
    let superseded = false;
    try { superseded = db.getQuestion(noticeId)?.dismissedAt != null; } catch { superseded = false; }
    if (superseded) {
      try {
        db.appendEvent({
          id: randomUUID(), ts: new Date().toISOString(), managerSessionId: a.id,
          kind: "assistant_auto_recycle", detail: { outcome: "superseded", noticeId },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[context-watcher] could not record the superseded auto-recycle for companion ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      // eslint-disable-next-line no-console
      console.log(`[context-watcher] companion ${a.id} auto-recycle attempt superseded (no longer exhausted) — owner not notified`);
      return;
    }
    try {
      db.appendEvent({
        id: randomUUID(), ts: new Date().toISOString(), managerSessionId: a.id,
        kind: "assistant_auto_recycle", detail: { outcome: "failed", noticeId, reason: reason.slice(0, 200) },
      });
      const name = this.assistantDisplayName(db, a);
      this.insertAssistantNotice(db, a, assistantExhaustionNoticeId(a.id, `auto-recycle-failed|${noticeId}`),
        `${name}${ASSISTANT_AUTO_RECYCLE_FAILED_TITLE_SUFFIX}`,
        `${name} (session ${a.id.slice(0, 8)}) hit its context limit and Loom tried to recycle it automatically, but ` +
        `the recycle failed (${reason.slice(0, 200)}). Loom will not retry. Open this Companion's page and press ` +
        `"Recycle onto a fresh session" to bring it back.`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[context-watcher] could not record the failed auto-recycle for companion ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[context-watcher] companion ${a.id} AUTO-RECYCLE FAILED (${reason.slice(0, 200)}) — not retrying; owner told`);
    this.maybeNotifyAssistantOwnerChat(db, a, noticeId, "exhausted");
  }

  private assistantDisplayName(db: Db, a: Session): string {
    return db.getCompanionConfig(a.id)?.name?.trim() || db.getAgent(a.agentId)?.name || "Your Companion";
  }

  /** File one daemon-authored inbox `notice` for a Companion (same row shape as the exhaustion notice;
   *  `insertQuestion` directly, so the per-agent notice throttle is bypassed). Idempotent on a deterministic id. */
  private insertAssistantNotice(db: Db, a: Session, id: string, title: string, body: string): void {
    if (db.getQuestion(id)) return;
    const now = new Date().toISOString();
    db.insertQuestion({
      id, sessionId: a.id, filedBySessionId: a.id, projectId: a.projectId, type: "notice",
      title, body,
      options: null, recommendation: null, taskId: null,
      permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null,
      decidedScope: null, decidedExpiresAt: null,
      credentialEnvVar: null, credentialByteLength: null, provisionTarget: null, fulfillmentTarget: null,
      provisionConnectionId: null, provisionBindingState: "none",
      state: "notice", chosenOption: null, note: null,
      createdAt: now, answeredAt: now, consumedAt: null,
      cancelledReason: null, cancelledBy: null, cancelledAt: null,
      escalatedAt: null, acknowledgedUntil: null, readAt: null, dismissedAt: null, attachments: [],
    });
  }

  /**
   * End an exhaustion episode whose Companion healed WITHOUT a recycle (e.g. a human-composer /compact: the
   * rising edge cleared the DB mark and the notice was left open, because `retireAssistantExhaustionNotice
   * OnRecovery` fires only on a completed turn). Signal: an episode claim exists for this Companion, the mark
   * is clear, the session is idle (a retry in flight is busy, so a restart's clear-then-fail transient is NOT
   * mistaken for recovery) and its transcript shows POSITIVE recovery evidence (`hasRecoveryEvidenceInTail`:
   * a non-synthetic assistant record, summary or compact_boundary after the marker — a user record alone, or
   * a missing/unreadable/empty transcript, means keep watching). Then (1) clear the claim FIRST, so a failed
   * dismiss below can never silence the next episode (the next exhaustion would reuse the still-open notice
   * id, and an empty claim differs from it), and (2) dismiss the open notice, best-effort — retried on later
   * ticks while an open notice remains (keyed on the open notice, not the claim). Cost: one meta read and
   * one questions read per tick; the transcript is read only when a claim or an open notice exists.
   */
  private endAssistantEpisodeIfRecovered(db: Db, a: Session): void {
    if (!this.deps.notifyCompanionOwner || a.busy || a.harness === "codex" || !a.engineSessionId) return;
    const key = `${ASSISTANT_EXHAUSTION_CHAT_META_PREFIX}${a.id}`;
    const autoKey = `${ASSISTANT_AUTO_RECYCLE_META_PREFIX}${a.id}`;
    let open: string[];
    try {
      const claimed = !!db.getMeta(key);
      const autoClaimed = !!db.getMeta(autoKey);
      open = db.listQuestionsForSession(a.id)
        .filter((q) => q.type === "notice" && q.dismissedAt == null && isRetirableAssistantExhaustionTitle(q.title))
        .map((q) => q.id);
      // Nothing to end and nothing to retire: the transcript is not even read.
      if (!claimed && !autoClaimed && open.length === 0) return;
      // POSITIVE evidence only: a missing/unreadable/empty transcript, or a user record alone, is "keep watching".
      if (!checkRecoveryEvidence(a.cwd, a.engineSessionId, a.harness)) return;
      // Card 1837a542: the auto-recycle claim ends WITH the episode, cleared FIRST like the chat claim, so a notice
      // left open across the recovery (the next episode reuses its id) can never silence the next auto-recycle.
      if (autoClaimed) db.setMeta(autoKey, "");
      if (claimed) db.setMeta(key, "");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[context-watcher] could not end the exhaustion episode for companion ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Retried on later ticks while an open notice remains (keyed on the open notice, not the claim).
    try {
      if (open.length > 0) db.dismissNotices(open, new Date().toISOString());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[context-watcher] could not dismiss the recovered exhaustion notice for companion ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Send the owner ONE plain chat message for this exhaustion episode, at most once. The episode key is the
   * inbox notice id in force (see ensureAssistantExhaustionNotice); it is CLAIMED in app_meta BEFORE the
   * send, so the guarantee is at-most-once (a crash between claim and send loses the message, never
   * duplicates it — the inbox notice stays the durable path). A new episode files a new notice id, so it
   * sends again. No retry on any outcome. Logs/events carry the outcome + channel name only, never text.
   */
  private maybeNotifyAssistantOwnerChat(db: Db, a: Session, noticeId: string | null, kind: "exhausted" | "auto-recycled"): void {
    const notify = this.deps.notifyCompanionOwner;
    if (!notify || !noticeId) return;
    const key = `${ASSISTANT_EXHAUSTION_CHAT_META_PREFIX}${a.id}`;
    try {
      if (!db.claimMeta(key, noticeId)) return;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[context-watcher] could not claim the exhaustion chat notice for companion ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const record = (detail: { outcome: string; channel?: string; reason?: string }): void => {
      try {
        db.appendEvent({
          id: randomUUID(), ts: new Date().toISOString(), managerSessionId: a.id,
          kind: "assistant_exhaustion_chat_notice", detail: { ...detail, noticeId },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[context-watcher] could not record the exhaustion chat notice outcome for companion ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    let p: ReturnType<NonNullable<ContextWatcherDeps["notifyCompanionOwner"]>>;
    try { p = notify(a.id, kind); } catch (err) {
      record({ outcome: "send-failed", reason: err instanceof Error ? err.name : "error" });
      return;
    }
    void p.then(
      (r) => record({ outcome: r.outcome, ...(r.channel ? { channel: r.channel } : {}), ...(r.reason ? { reason: r.reason } : {}) }),
      (err) => record({ outcome: "send-failed", reason: err instanceof Error ? err.name : "error" }),
    );
  }

  /**
   * File the owner-facing inbox notice for one Companion exhaustion episode, EXACTLY once. Two dedupes:
   * (1) the row id is a deterministic v4-shaped UUID of (session, episode stamp), so a repeat tick or a
   * post-restart tick carrying the SAME stamp finds it and does nothing; (2) an UNDISMISSED exhaustion
   * notice for the same session blocks a new one even under a different stamp — after a daemon restart the
   * in-memory hold is gone, the next delivery clears the DB mark, the turn fails again and the re-mark
   * carries a fresh stamp for what is still one episode to the owner. Once the owner dismisses the notice a
   * later exhaustion files a fresh one. Returns the notice id in force (null if it could not be filed).
   *
   * Written via `db.insertQuestion`, not the `question_ask` builder, so the per-agent `maxNoticesPerHour`
   * throttle is bypassed (daemon-authored, once per episode). Fixed text, no transcript content;
   * `sessionId` and `filedBySessionId` are the Companion's own id (FK + inbox agent-name join).
   */
  private ensureAssistantExhaustionNotice(db: Db, a: Session, episodeStamp: string): string | null {
    const id = assistantExhaustionNoticeId(a.id, episodeStamp);
    try {
      if (db.getQuestion(id)) return id;
      const open = db.listQuestionsForSession(a.id).find(
        (q) => q.type === "notice" && q.dismissedAt == null && q.title.endsWith(ASSISTANT_EXHAUSTION_TITLE_SUFFIX),
      );
      if (open) return open.id;
      const name = db.getCompanionConfig(a.id)?.name?.trim() || db.getAgent(a.agentId)?.name || "Your Companion";
      db.insertQuestion({
        id, sessionId: a.id, filedBySessionId: a.id, projectId: a.projectId, type: "notice",
        title: `${name}${ASSISTANT_EXHAUSTION_TITLE_SUFFIX}`,
        body:
          `${name} (session ${a.id.slice(0, 8)}) hit its context limit: the engine rejected the next prompt as too ` +
          `long, so it will not answer any more messages or alerts.\n\n` +
          `What you can do now: open this Companion's page in Loom and press "Recycle onto a fresh session". ` +
          `It keeps its chat bindings, memory and grants, restarts with a clean context, and delivers anything ` +
          `queued meanwhile. (Its trust window and any inline authored-content grant are closed.)` +
          (db.getCompanionConfig(a.id)?.autoRecycleOnExhaustion === true
            ? `\n\nAuto-recycle is ON for this Companion, so Loom will recycle it by itself (it waits while there is an ` +
              `unfinished draft in its terminal). If this notice is still open after a while, press Recycle yourself.`
            : ``),
        options: null, recommendation: null, taskId: null,
        permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null,
        decidedScope: null, decidedExpiresAt: null,
        credentialEnvVar: null, credentialByteLength: null, provisionTarget: null, fulfillmentTarget: null,
        provisionConnectionId: null, provisionBindingState: "none",
        state: "notice", chosenOption: null, note: null,
        createdAt: episodeStamp, answeredAt: episodeStamp, consumedAt: null,
        cancelledReason: null, cancelledBy: null, cancelledAt: null,
        escalatedAt: null, acknowledgedUntil: null, readAt: null, dismissedAt: null, attachments: [],
      });
      return id;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[context-watcher] could not file the exhaustion notice for companion ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Round 2 (CR finding, reviewer 6ba057e4): `checkContextExhaustion` above only returns `true` on the
   * TICK it first marks a session — on every LATER tick `m.busy` already reads false (the mark cleared
   * it), so that method's own `!m.busy` guard returns `false` and the caller does NOT `continue`,
   * falling through into the recycle-ratio nudge, the unanswered-cap escalation, and the emergency
   * interrupt with a now-stale `ctxInputTokens` reading — none of which can ever reach an engine that
   * will never produce another Stop. Call this SEPARATELY, right after `checkContextExhaustion`, on
   * EVERY tick (not just the marking one) to skip all of that for as long as the mark stands.
   */
  private isAlreadyContextExhausted(m: Session): boolean {
    return m.contextExhaustedAt != null;
  }

  /**
   * Card dacc6d9e round 3 — the WORKER loop's own exhaustion detect-and-skip, deliberately NEVER
   * marking or filing anything (see the worker loop's own comment for why: `BusyWorkerWatcher` is the
   * sole marker/notifier for a worker session). Mirrors `checkContextExhaustion`'s own guard + pure
   * tail-read, minus the `pty.markContextExhausted`/`db.setContextExhausted`/event-append side effects.
   */
  private isWorkerContextExhaustedUnmarked(pty: ContextPty, w: Session): boolean {
    if (!w.busy || w.harness === "codex" || !w.engineSessionId) return false;
    return checkContextExhaustion(w.cwd, w.engineSessionId, w.harness, pty.busySinceMs?.(w.id) ?? null) != null;
  }

  /**
   * EMERGENCY INTERRUPT (Trigger A) — needs a REAL `ctxInputTokens` reading; the null gap is
   * `checkBlindTurn`'s (Trigger B's) job, deliberately not this method's.
   * @decision 9f279c7b — fires AT MOST ONCE PER SESSION ID; a refusal never advances that state.
   * @decision c5b234aa — round 4: NO re-arm key at all (see the decision record for why three
   *   successive per-turn keys — per-reading, `lastActivity`, `turnSeq` — each reopened the same
   *   cascade from a different direction). A recycle mints a fresh session id, which re-arms naturally.
   */
  private checkEmergencyOccupancy(db: Db, m: Session, cfg: OrchestrationConfig, r: number, window: number, nowIso: string): void {
    if (cfg.emergencyRecycleAtContextRatio <= 0) return; // disabled for this project
    if (r < cfg.emergencyRecycleAtContextRatio) return; // under the emergency floor
    if (!this.deps.pty.isAlive(m.id)) return;
    if (!this.deps.emergencyInterrupt) return; // no daemon-internal hook wired (e.g. a narrower test harness)

    // Card c5b234aa (Code Review round 4) — ANY prior fire for this session id, ever (legacy-shaped
    // event included — presence alone is enough, no field on it is even read), blocks a second one for
    // the life of this session. No re-arm key at all: see the decision record for why.
    if (db.getLatestEventForManagerByKind(m.id, "context_emergency_interrupt")) return;

    const pct = Math.round(r * 100);
    const kw = Math.round(window / 1000);
    const msg =
      `Your context is ~${pct}% of your ${kw}k window — this is the EMERGENCY floor, not the routine ` +
      `recycle nudge. This interrupt may have landed mid-edit or mid-tool-call: first finish or safely ` +
      `abandon the single step that was in flight (reconcile your working tree if you were mid-edit; do ` +
      `not start anything new), then immediately run /loom-session-end and call recycle_me with a ` +
      `self-contained continuation prompt for your successor (current goal, what's done, your in-flight ` +
      `workers + their tasks/status, next steps, key decisions). Do not resume normal orchestration after ` +
      `this message — hand off now.`;

    const outcome = this.deps.emergencyInterrupt(m.id, msg);
    if (!outcome.fired) {
      // eslint-disable-next-line no-console
      console.log(`[context-watcher] EMERGENCY interrupt for manager ${m.id} (~${pct}% of ${kw}k window) NOT fired (${outcome.reason ?? "unknown"}) — will retry next tick`);
      return; // no event recorded — retrying next tick is exactly the point, see this method's own doc
    }
    db.appendEvent({
      id: randomUUID(), ts: nowIso, managerSessionId: m.id, kind: "context_emergency_interrupt",
      detail: { pct, delivered: outcome.delivered ?? null, interrupting: outcome.interrupting ?? null },
    });
    // eslint-disable-next-line no-console
    console.log(`[context-watcher] EMERGENCY interrupt FIRED for manager ${m.id} (~${pct}% of ${kw}k window; delivered=${outcome.delivered}, interrupting=${outcome.interrupting})`);
  }

  /**
   * WORKER CONTEXT WARN (Trigger C, card dacc6d9e) — see the class doc's own section. Pushes an
   * informational `[loom:worker-context-high]` notice to the OWNING MANAGER once `workerContextWarnRatio`
   * is crossed; never a nudge/interrupt to the worker itself. Fires AT MOST ONCE EVER per worker session
   * id (`listEventsForWorkerKinds` presence check, no re-arm key) — safe because `ctxInputTokens` only
   * grows while a session is live (auto-compact is owner-disabled; a manual human `/compact` is an
   * accepted gap here, same posture as the manager's own once-per-session checks) and this notice never
   * touches the worker's own `busy`/`lastActivity`/`turnSeq`, so — unlike Trigger D below — it cannot
   * re-arm itself. Re-arms only via `worker_recycle` (a fresh session id).
   */
  private checkWorkerContextWarn(db: Db, pty: ContextPty, w: Session, cfg: OrchestrationConfig, r: number, window: number, nowIso: string): void {
    if (cfg.workerContextWarnRatio <= 0) return; // disabled for this project
    if (r < cfg.workerContextWarnRatio) return; // under the warn floor

    const managerId = w.parentSessionId;
    if (!managerId) return; // no owner to notify (shouldn't happen for a worker)
    const manager = db.getSession(managerId);
    if (!manager || manager.processState !== "live") return; // orphaned → boot-reconcile's concern, not ours

    if (db.listEventsForWorkerKinds(w.id, ["worker_context_high"]).length > 0) return; // already fired, ever

    const pct = Math.round(r * 100);
    const kw = Math.round(window / 1000);
    const msg =
      `${WORKER_CONTEXT_WARN_PREFIX} worker ${w.id}${w.taskId ? ` (task ${w.taskId.slice(0, 8)})` : ""} ` +
      `is at ~${pct}% of its ${kw}k window — approaching exhaustion (auto-compact is OFF). Consider ` +
      `worker_recycle before it runs out, or nudge it to commit and report now.`;
    let result: { delivered: boolean; queued?: boolean };
    let threw = false;
    try { result = pty.enqueueStdin(managerId, msg); } catch { threw = true; result = { delivered: false, queued: false }; }
    if (!result.delivered && !result.queued) {
      // eslint-disable-next-line no-console
      console.log(`[context-watcher] worker-context-high notice to manager ${managerId} for worker ${w.id} was NOT accepted (${threw ? "enqueueStdin threw" : "enqueueStdin reported neither delivered nor queued"}) — not recording a fire`);
      return;
    }
    db.appendEvent({
      id: randomUUID(), ts: nowIso, managerSessionId: managerId, workerSessionId: w.id,
      taskId: w.taskId ?? null, kind: "worker_context_high",
      detail: { pct },
    });
    // eslint-disable-next-line no-console
    console.log(`[context-watcher] worker ${w.id} context-high (~${pct}% of ${kw}k window) → notice to manager ${managerId}`);
  }

  /**
   * WORKER CONTEXT INTERRUPT (Trigger D, card dacc6d9e) — see the class doc's own section. Needs a REAL
   * `ctxInputTokens` reading AND the worker to be currently BUSY: an idle worker (including one already
   * `awaitingReview` — it reported done/blocked) isn't burning context, and forcing a fresh "commit and
   * report" turn onto it would make it RE-report and clear the review state its manager is actively
   * acting on — manager review correction 1, card dacc6d9e. Also skipped while the worker is parked on a
   * rate limit (`rateLimitedUntil` in the future): it isn't taking a turn right now either, so there is
   * nothing to interrupt and nothing burning context. Neither refusal records an event, so the interrupt
   * can still fire later once the worker actually goes busy above the floor — same shape as the
   * gate-in-flight refusal `SessionService.redirectWorkerForContextInterrupt` returns.
   * @decision dacc6d9e — never add a per-turn re-arm key here (per-reading/lastActivity/turnSeq all
   *   broke the manager's identical Trigger A in three successive rounds, since this interrupt's own
   *   Esc→settle→drain mutates those same fields): fire AT MOST ONCE EVER per worker session id instead.
   * @decision dacc6d9e — fires ONLY on a reading measured DURING THE CURRENT TURN (`w.ctxUpdatedAt`
   *   strictly later than `w.lastActivity`) — never on a stale pre-turn reading carried into a recovery
   *   turn by a busy rising edge that clears exhaustion but not `ctxInputTokens`/`ctxUpdatedAt`.
   */
  private checkWorkerContextInterrupt(db: Db, w: Session, cfg: OrchestrationConfig, r: number, window: number, nowIso: string): void {
    if (cfg.workerContextInterruptRatio <= 0) return; // disabled for this project
    if (r < cfg.workerContextInterruptRatio) return; // under the interrupt floor
    if (!w.busy) return; // idle (incl. awaitingReview) → nothing to interrupt, no turn burning context
    if (!w.ctxUpdatedAt || Date.parse(w.ctxUpdatedAt) <= Date.parse(w.lastActivity)) return; // stale pre-turn reading
    if (w.rateLimitedUntil && Date.parse(w.rateLimitedUntil) > Date.parse(nowIso)) return; // parked, not taking a turn
    if (!this.deps.pty.isAlive(w.id)) return;
    if (!this.deps.workerContextInterrupt) return; // no daemon-internal hook wired (e.g. a narrower test harness)

    const managerId = w.parentSessionId;
    if (!managerId) return; // no owner to notify (shouldn't happen for a worker)

    // Any prior fire for this session id, ever, blocks a second one — see this method's own doc.
    if (db.listEventsForWorkerKinds(w.id, ["worker_context_interrupt"]).length > 0) return;

    const pct = Math.round(r * 100);
    const kw = Math.round(window / 1000);
    const msg =
      `Your context is at ~${pct}%, near exhaustion (auto-compact is OFF). This interrupt may have landed ` +
      `mid-edit or mid-tool-call: first finish or safely abandon the current edit (reconcile your working ` +
      `tree if you were mid-edit; do not start anything new). Then commit your work as a NEW commit (never ` +
      `amend), worker_report status progress with where you are, then STOP and wait for your manager.`;

    const outcome = this.deps.workerContextInterrupt(w.id, msg);
    if (!outcome.fired) {
      // eslint-disable-next-line no-console
      console.log(`[context-watcher] worker-context interrupt for worker ${w.id} (~${pct}% of ${kw}k window) NOT fired (${outcome.reason ?? "unknown"}) — will retry next tick`);
      return; // no event recorded — retrying next tick is exactly the point, same shape as Trigger A
    }
    db.appendEvent({
      id: randomUUID(), ts: nowIso, managerSessionId: managerId, workerSessionId: w.id,
      taskId: w.taskId ?? null, kind: "worker_context_interrupt",
      detail: { pct, delivered: outcome.delivered ?? null, interrupting: outcome.interrupting ?? null },
    });
    // eslint-disable-next-line no-console
    console.log(`[context-watcher] worker-context interrupt FIRED for worker ${w.id} (~${pct}% of ${kw}k window; delivered=${outcome.delivered}, interrupting=${outcome.interrupting})`);

    // Manager review correction 3, card dacc6d9e: tell the owning manager directly that this fired —
    // it must not learn about it only from the worker's own next report. Best-effort: the durable event
    // above already stands regardless of whether this notice is accepted.
    const noticeMsg =
      `[loom:worker-context-interrupt] worker ${w.id}${w.taskId ? ` (task ${w.taskId.slice(0, 8)})` : ""} ` +
      `is at ~${pct}% context — Loom told it to commit and report. Recycle it once it reports.`;
    try { this.deps.pty.enqueueStdin(managerId, noticeMsg); } catch { /* manager not live — the durable event stands */ }
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

/** app_meta key prefix of the per-Companion "owner already messaged for this episode" claim; value = notice id. */
export const ASSISTANT_EXHAUSTION_CHAT_META_PREFIX = "companion_exhaustion_chat_sent:";

export const ASSISTANT_EXHAUSTION_TITLE_SUFFIX = " has run out of context and cannot reply";

/** app_meta key prefix of the per-Companion "auto-recycle already attempted for this episode" claim; value = notice id. */
export const ASSISTANT_AUTO_RECYCLE_META_PREFIX = "companion_auto_recycle_claim:";

/** Title suffixes of the two follow-up notices an auto-recycle files. Deliberately NOT ending in
 *  `ASSISTANT_EXHAUSTION_TITLE_SUFFIX`, so the recycle's own dismissal of exhaustion notices never sweeps them up. */
export const ASSISTANT_AUTO_RECYCLED_TITLE_SUFFIX = " was automatically recycled onto a fresh session";
export const ASSISTANT_AUTO_RECYCLE_FAILED_TITLE_SUFFIX = " could not be recycled automatically";

/** Notices a recovery (a manual recycle, or the sweep that sees a healed Companion) retires: the exhaustion notice
 *  and the "could not be recycled automatically" one. NOT the "was automatically recycled" success notice, which
 *  is a record the owner reads and dismisses themself. */
export function isRetirableAssistantExhaustionTitle(title: string): boolean {
  return title.endsWith(ASSISTANT_EXHAUSTION_TITLE_SUFFIX) || title.endsWith(ASSISTANT_AUTO_RECYCLE_FAILED_TITLE_SUFFIX);
}

/** Deterministic v4-SHAPED UUID of (session, episode stamp): every question id is a v4 UUID (QUESTION_ID_RE). */
export function assistantExhaustionNoticeId(sessionId: string, episodeStamp: string): string {
  const b = createHash("sha256").update(`ctxexh|${sessionId}|${episodeStamp}`).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
