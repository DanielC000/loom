import { randomUUID } from "node:crypto";
import { resolveConfig, contextWindowForModel, columnKeyForRole } from "@loom/shared";
import type { OrchestrationEventKind } from "@loom/shared";
import type { Db } from "../db.js";
import type { OrchestrationControl } from "./control.js";
import type { QueueSource, TurnRoute, QueuedMessageKind } from "../pty/host.js";
import { computeBoardDelta, formatBoardDeltaDigest } from "./board-read.js";

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests claude-free). */
export interface IdlePty {
  isAlive(sessionId: string): boolean;
  /**
   * Nudge text into the session's busy-gated queue (waits if the target is mid-turn). `source`/`route`/
   * `kind`/`questionId` mirror PtyHost.enqueueStdin's own optional tail — the answered-stuck watchdog
   * passes `kind:"agent"` so its re-nudge drains as a distinct one-per-turn message, not a coalesced
   * warning, and `questionId` so a LATER `question_pull` can purge this exact nudge via the SAME
   * `purgeQueuedByQuestionIds` path the answer-route push-nudge already uses (card bbc46336) — without
   * this tag a watchdog nudge still sitting queued when the question is pulled survives the purge and
   * drains later as a stale "pull it" message for an already-consumed question.
   *
   * The real PtyHost.enqueueStdin returns a richer `EnqueueResult` (see pty/host.ts) with THREE possible
   * outcomes, collapsed here to the two this watcher needs to distinguish (mirrors ContextPty — card
   * f6d72db8): `delivered:true` (handed straight to submit() this turn) or `delivered:false, queued:true`
   * (durably held, lands at the next turn boundary) both mean the nudge was ACCEPTED; `delivered:false`
   * with `queued` falsy means it was NOT accepted at all (e.g. the target went not-live between our own
   * `isAlive` check above and this call) — tick()/tickAnsweredStuckQuestions() below must not treat that
   * as a sent nudge.
   */
  enqueueStdin(sessionId: string, text: string, source?: QueueSource, onDeliver?: () => void, route?: TurnRoute, kind?: QueuedMessageKind, questionId?: string): { delivered: boolean; position?: number; queued?: boolean };
}

export interface IdleWatcherDeps {
  db: Db;
  pty: IdlePty;
  /** §17a pause registry — a human-paused manager is never nudged (parity with worker_spawn). */
  control: OrchestrationControl;
  /**
   * ContextWatcher's GLOBAL force override (mirrors ContextWatcherDeps.ratio): a manager at/over the
   * EFFECTIVE recycle ratio has a recycle nudge pending → idle defers. > 0 forces this ratio for every
   * project; 0 = no override, so tick() falls back to THIS project's own resolved recycleAtContextRatio.
   */
  recycleRatio: number;
  /**
   * Idle-WORKER coverage (board card b9d479b0): re-fires the SAME reconciled worker→manager nudge
   * SessionService.notifyManagerOfIdleWorker already fires ONCE on a worker's busy→false edge — injected
   * so the periodic idle-worker loop below (tickIdleWorkers) never RE-IMPLEMENTS its queued-report /
   * parked-awaiting-ack / broken-spawn reconciliation. A second, drifted copy of that logic would
   * reintroduce board card 99efaab3's exact false alarm ("did NOT call worker_report" for a worker whose
   * report is merely queued) — this keeps it single-sourced.
   */
  notifyIdleWorker: (workerSessionId: string) => void;
  /**
   * SessionService.isWorkerGenuinelyStranded (CR blocker #2 fold-in) — single-sources the SAME
   * reconciliation `notifyIdleWorker` uses, exposed as a pure predicate so the manager loop's OWN idle
   * message can narrow "live worker(s)" to genuinely-unreported ones before asserting "unreported —
   * nobody else watches this". Without this, the message would fire that claim for a worker that's
   * actually rate-limited, already reported (awaiting merge), or parked awaiting an ack — exactly the
   * misleading shape board card 99efaab3 exists to prevent.
   */
  isWorkerStranded: (workerSessionId: string) => boolean;
  /** Tick cadence; defaults to 60s. Injectable so a test drives tick() directly. */
  intervalMs?: number;
}

/**
 * Manager orchestration-event kinds that prove the manager is BACK AT THE WHEEL (genuine new work).
 * A nudged manager that produces one of these AFTER its last nudge is re-armed (resetIdleNudgeState).
 * Deliberately excludes `idle_report` (the manager's ANSWER to a nudge — it sets policy itself, and
 * counting it as "activity" would undo the snooze/suppress it just chose) and the system-driven
 * `schedule_fired`/`wake_*` events (not the manager waking up on its own).
 */
const ORCH_ACTIVITY_KINDS: ReadonlySet<OrchestrationEventKind> = new Set<OrchestrationEventKind>([
  "spawn_worker", "message_worker", "stop_worker",
  "merge_request", "merge_done", "merge_rejected", "merge_cancelled",
  "recycle_begin", "recycle_complete", "build_gate", "kill_switch", "deploy",
]);

/**
 * Answered-stuck-question re-nudge window (manager→human decision inbox, follow-up to card 8701bdbb):
 * a `questions` row the human answered but the asking manager never `question_pull`ed past this many
 * minutes gets ONE re-nudge (see tickAnsweredStuckQuestions below). A clear new constant rather than a
 * per-project config key — the human has ALREADY acted here; this only paces how long we wait before
 * nagging the manager to go check its own inbox, so it doesn't need the same per-project tuning surface
 * as idleNudgeMinutes/idleWorkerMinutes. Shorter than the 45min idle-manager default: the human is the
 * one left waiting on an answer it already gave, so this should nag sooner than a manager that's merely
 * idle with no one waiting on it.
 */
const ANSWERED_QUESTION_STUCK_MINUTES = 15;

/**
 * Idle-nudge board-scan throttle (card a193398f — perf: bound the idle-nudge re-drain). The board scan
 * below (nonTerminal/openCards) is only NEEDED once per nudge decision, but a "nothing actionable" outcome
 * doesn't call recordIdleNudge (last_idle_nudge_at never advances), so without this throttle the FULL scan
 * — db.listTasks(projectId) (every column incl. body, every row incl. done) plus a pending-question lookup
 * per non-terminal card — reran on EVERY 60s tick, indefinitely, for as long as a manager sat idle-eligible
 * with nothing to nudge: cost scaling with board_size × idle-TICK-count, not board_size × nudge_count as
 * intended. Deliberately SHORTER than any real idleNudgeMinutes (default 45) so a due nudge is never
 * delayed by more than this window — a manager whose board gains actionable work is caught within a few
 * minutes instead of instantly, in exchange for not re-deriving the whole board every single tick. Purely
 * a re-SCAN cadence; the nudge-firing predicate/cap/escalation/parked-lane discount are untouched.
 */
const IDLE_SCAN_THROTTLE_MINUTES = 5;

/**
 * Appended to every idle-manager nudge (card a193398f): the message already embeds current, cheaply-
 * computed counts (openTodos/stranded/live-worker) — this line tells the manager those counts are fresh
 * so it doesn't reflexively re-pull the whole board/worker list/Requests just to confirm what the nudge
 * already told it. Short + additive; doesn't touch the branch copy above it.
 */
const IDLE_NUDGE_BOUNDED_HINT =
  " These counts are already current — no need to re-pull the whole board, worker list, or Requests just " +
  "to confirm them; only fetch details if you're about to act on a specific card.";

/**
 * Asleep-at-the-Wheel watcher (idle-manager watchdog) — also covers platform (Lead) sessions (card
 * 98b3725c). Structural twin of ContextWatcher: each tick, for every LIVE manager OR platform session
 * that is idle (`busy=false` + `lastActivity` older than the project's `idleNudgeMinutes`) with NO live
 * workers, it injects a ONE-TIME-per-episode busy-gated nudge asking it WHY it is idle and to
 * `idle_report` its state (then resume the loop). Agent-in-the-loop: Loom can't know why a manager/Lead
 * is idle, so it asks; it answers over MCP (`idle_report` — on the orchestration router for a manager,
 * the platform router for a Lead, both backed by the same `SessionService.recordIdleReport`). A Lead
 * never parents a worker (see `db.listLivePlatformSessions`'s doc), so the worker-shaped checks below
 * (`db.listWorkers`, `tickIdleWorkers`) simply see an empty set for it — the manager loop is reused
 * verbatim, not specialized.
 *
 * Unlike ContextWatcher's in-memory `nudged` Set, the "once per episode" mark is PERSISTED
 * (`last_idle_nudge_at`): a re-nudge only fires after another full `idleNudgeMinutes` of continued
 * idleness, and at most `maxUnansweredNudges` times. A manager that has slept through every nudge
 * (unanswered ≥ cap, still `watching`) ESCALATES ONCE (Task 4): we append an `idle_escalated` event —
 * the human-facing signal the web attention surface derives an alert from — and flip policy to
 * `suppressed` (so nudging stops AND the policy gate fires the event exactly once). This is all PERSISTED,
 * so a snooze/cap/escalation is honored across a daemon restart.
 *
 * Skips silently when: snoozed/suppressed (policy ≠ watching, or an active snooze window); the manager
 * has a live BUSY worker (legitimately waiting on a building worker); human-paused; a context-recycle
 * nudge is pending (recycle takes precedence); or the project disabled it (`idleNudgeMinutes === 0`).
 * Reset-on-activity re-arms a manager that returned to real work.
 *
 * IDLE-WORKER coverage (board card b9d479b0, `tickIdleWorkers` below): the manager loop above and
 * BusyWorkerWatcher (which only covers `busy=true` workers) left a two-path asymmetry — a live worker
 * that went idle (`busy=false`) WITHOUT calling worker_report was watched by NOBODY, and the manager
 * loop used to skip its own idle-manager nudge for ANY live worker (busy or idle), suppressing exactly
 * the nudge that would have caught it. Each tick, for every LIVE worker that's idle with its task still
 * unreported and stale beyond `idleWorkerMinutes`, we RE-fire the same reconciled worker→manager nudge
 * SessionService.notifyManagerOfIdleWorker already fires once on the busy→false edge (injected as
 * `notifyIdleWorker`, never re-implemented here) on the same persisted once-per-window cadence as the
 * manager loop (the session's own `idle_nudge_state` columns — workers never call idle_report, so only
 * `last_idle_nudge_at` paces them; policy/snooze stay at the 'watching' default).
 *
 * STALE-REQUEST coverage (card 99d41588, `tickStaleRequests` below): a wholly SEPARATE clock from every
 * loop above — keyed on `questions.created_at` (a Request's own age), never a session's idle/suppression
 * state. Closes the residual gap the manager loop's own `hasOwnPendingRequest` discount deliberately
 * leaves open: a session correctly suppressed because it's blocked ONLY on its own pending owner Request
 * never gets idle-nudged, so its `unanswered` counter never increments and it can never reach
 * `maxUnansweredNudges`'s `idle_escalated` — meaning that Request could otherwise sit forever with no
 * path to alert a human. `tickStaleRequests` reaches it (and any other pending Request, regardless of the
 * asking session's activity) directly off the request row itself.
 */
export class IdleWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Answered-stuck-question storm guard: tracks question ids already re-nudged this answered→still-
   * answered window (no schema change — see tickAnsweredStuckQuestions). A daemon restart clears this,
   * re-nudging once more; benign, since that's rare and one extra manager nudge is harmless.
   */
  private nudgedAnsweredQuestions = new Set<string>();
  /**
   * IDLE_SCAN_THROTTLE_MINUTES cache (card a193398f): per-manager last-scanned-at, in-memory only —
   * mirrors the nudgedAnsweredQuestions precedent above (no schema migration; a daemon restart just costs
   * one extra scan per manager, harmless). Pruned each tick to the currently-live manager/platform set so
   * it can never grow unboundedly across recycles/restarts.
   */
  private lastIdleScanAt = new Map<string, number>();
  /**
   * Skip-reason change-tracker (card cdd10965 — the observability gap: a SKIPPED session used to leave
   * zero trace, indistinguishable from "the watchdog never ticked"). Scoped to the MANAGER/PLATFORM loop
   * in tick() ONLY — tickIdleWorkers/tickAnsweredStuckQuestions already log their own delivery failures
   * and are a different loop with a different specimen; this does not cover them. Same in-memory,
   * pruned-to-live-managers pattern as lastIdleScanAt above (a daemon restart just re-logs the current
   * reason once more, harmless). Bounds log volume to state TRANSITIONS rather than one line per tick per
   * live manager: measured, an actively-orchestrating manager flips `busy`↔`under-window` (or
   * `busy`↔`live-busy-worker`) roughly twice per turn, i.e. ~2 lines × ~120 bytes ≈ 240 bytes per turn —
   * immaterial against the per-turn submit-write/prompt-echo/MCP-handshake traffic already in this log;
   * a genuinely idle manager produces ~1 line per idle episode, not one per 60s tick.
   */
  private lastSkipReason = new Map<string, string>();
  constructor(private deps: IdleWatcherDeps) {}

  /**
   * Emit `[idle-watcher] skip <id> reason=<reason>` ONLY when `reason` differs from the last one recorded
   * for this session — see lastSkipReason's own doc for the volume rationale and scope (manager/platform
   * loop only). Session id + a bare reason code ONLY, never message content, a card title, or a count
   * (DoD-3 — this log is shared across every tenant on the host).
   */
  private logSkipIfChanged(sessionId: string, reason: string): void {
    if (this.lastSkipReason.get(sessionId) === reason) return;
    this.lastSkipReason.set(sessionId, reason);
    // eslint-disable-next-line no-console
    console.log(`[idle-watcher] skip ${sessionId} reason=${reason}`);
  }

  tick(now: Date = new Date()): void {
    const { db, pty, control, recycleRatio } = this.deps;
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    // Platform (Lead) sessions get the SAME coverage as managers (card 98b3725c) — merged from a
    // SEPARATE query rather than widening listLiveManagers, which ContextWatcher also reads (recycle-
    // by-context) and must not silently start covering Lead sessions too. Reusing the manager loop
    // verbatim is safe by construction: a Lead never parents a worker (spawnSessionAsPlatform spawns
    // free-standing manager/plain sessions, no parentSessionId), so db.listWorkers(leadId) below is
    // always [] for it — the manager-shaped worker-checks silently no-op instead of forcing a manager
    // assumption onto the Lead.
    const managers = [...db.listLiveManagers(), ...db.listLivePlatformSessions()];
    // Prune the scan-throttle cache to currently-live managers/platforms only (card a193398f) — bounds
    // its memory to the live fleet instead of accumulating an entry per manager id ever seen.
    const liveManagerIds = new Set(managers.map((mm) => mm.id));
    for (const id of this.lastIdleScanAt.keys()) if (!liveManagerIds.has(id)) this.lastIdleScanAt.delete(id);
    for (const id of this.lastSkipReason.keys()) if (!liveManagerIds.has(id)) this.lastSkipReason.delete(id);

    for (const m of managers) {
      const project = db.getProject(m.projectId);
      if (!project) { this.logSkipIfChanged(m.id, "no-project"); continue; } // defensive/TOCTOU — see logSkipIfChanged callers' doc below
      const cfg = resolveConfig(project.config).orchestration;
      const idleMinutes = cfg.idleNudgeMinutes;
      if (idleMinutes === 0) { this.logSkipIfChanged(m.id, "disabled"); continue; } // disabled for this project

      // Reset-on-activity: a manager that produced genuine orchestration work AFTER its last nudge is
      // back at the wheel — re-arm it (watching / unanswered 0 / snooze clear) before we evaluate.
      // NOTE on the three `!state` sites below: unreachable by my reading of db.ts:5224-5235 —
      // getIdleNudgeState returns undefined ONLY when the session row itself is missing, but `m` came
      // from listLiveManagers()/listLivePlatformSessions() moments ago, so the row necessarily exists
      // (TOCTOU aside). Kept as a distinct reason code anyway (card cdd10965 amendment): if this ever
      // DOES fire in production, that's a real bug signal worth naming, not silencing.
      let state = db.getIdleNudgeState(m.id);
      if (!state) { this.logSkipIfChanged(m.id, "no-idle-state"); continue; }
      if (state.lastIdleNudgeAt && this.producedActivitySince(m.id, state.lastIdleNudgeAt)) {
        db.resetIdleNudgeState(m.id);
        state = db.getIdleNudgeState(m.id);
        if (!state) { this.logSkipIfChanged(m.id, "no-idle-state"); continue; }
      }

      // Timed snooze expiry: a manager that reported `waiting` is silent only UNTIL snooze_until
      // ("silent until then" — reuses wake_me semantics; persisted, so honored across a restart).
      // Once it elapses, re-arm to 'watching' (clears the snooze) so the normal predicate evaluates
      // it again this/next tick. ONLY for 'snoozed' — 'suppressed' (done) stays sticky
      // until genuine activity or a human reclaims it (Task 4). unanswered is already 0 for a manager
      // that answered `waiting`, so the reset is safe.
      if (state.policy === "snoozed" && state.snoozeUntil && nowIso >= state.snoozeUntil) {
        db.resetIdleNudgeState(m.id);
        state = db.getIdleNudgeState(m.id);
        if (!state) { this.logSkipIfChanged(m.id, "no-idle-state"); continue; }
      }

      // --- the full trigger predicate (skip silently if ANY fails) ---
      if (m.busy) { this.logSkipIfChanged(m.id, "busy"); continue; }                      // mid-turn → not idle
      if (state.policy !== "watching") { this.logSkipIfChanged(m.id, state.policy); continue; } // snoozed (within window) / suppressed
      // defensive: active snooze on a watching row — unreachable by my reading (policy!=="watching" above
      // already excludes any snoozed row; a "watching" row should always have snoozeUntil cleared).
      if (state.snoozeUntil && nowIso < state.snoozeUntil) { this.logSkipIfChanged(m.id, "active-snooze"); continue; }
      // NOTE: the unanswered≥cap case is NOT a skip here — it ESCALATES at the nudge-decision point below
      // (it must pass the SAME predicate a nudge does: unpaused, no live worker, not recycle-pending,
      // idle≥window-since-last-nudge, alive — so a human/recycle-owned manager is never escalated).
      if (control.isPaused(m.id)) { this.logSkipIfChanged(m.id, "human-paused"); continue; }

      // OWN pending owner Request (card cb56cf80, narrowed by card 8e87f3b5): a manager/Lead correctly
      // parked on an OPEN owner-facing question_ask IT ITSELF filed is not idle — it's blocked on the
      // owner, and the answer already fires a push-nudge as the wake, so an idle nudge here is pure noise
      // WHEN THERE'S NOTHING ELSE TO DO. SESSION-scoped (db.hasPendingQuestionForSession) and taskId-
      // INDEPENDENT — unlike the per-card listQuestionsForTask discount below, this catches Requests filed
      // with taskId:null, which owner Requests very often are. Deliberately NOT a `continue` here: card
      // 8e87f3b5 found this used to fully silence the manager even when OTHER actionable board work sat
      // untouched (own-Request suppression should never dominate unrelated dispatchable work). Folded
      // into the "genuinely nothing actionable" skip below instead, alongside openCards/stranded-worker/
      // review-lane/deferral — so a session with its own pending Request AND other actionable work still
      // gets nudged for that other work, while one with NO other actionable work stays silently suppressed
      // (cb56cf80's original intent, preserved for that case). A session with no pending own-Request (or
      // whose Request has since been answered) is unaffected either way.
      const hasOwnPendingRequest = db.hasPendingQuestionForSession(m.id);

      // Live BUSY worker — a manager waiting on a building/turning worker is legitimately idle (don't
      // nudge). Board card b9d479b0 (two-path asymmetry): this used to skip on ANY live worker, busy OR
      // idle — silencing the manager exactly when its worker was idle-and-stranded and needed it most.
      // An idle (busy=false) live worker is NOT a reason to skip: tickIdleWorkers below covers it on its
      // own cadence, but the manager itself should also be nudged to go check on a stranded worker rather
      // than sit idle waiting on nothing.
      const liveWorkers = db.listWorkers(m.id).filter((w) => w.processState === "live");
      const liveBusyWorkers = liveWorkers.filter((w) => w.busy).length;
      if (liveBusyWorkers > 0) { this.logSkipIfChanged(m.id, "live-busy-worker"); continue; }

      // Competing recycle nudge: a near-full manager should recycle, not spawn. Mirror ContextWatcher's
      // own per-project threshold (env force override, else THIS project's resolved recycleAtContextRatio,
      // already computed above as cfg) so idle precedence never disagrees with the recycle trigger.
      const effectiveRecycleRatio = recycleRatio > 0 ? recycleRatio : cfg.recycleAtContextRatio;
      if (effectiveRecycleRatio > 0 && m.ctxInputTokens != null) {
        if (m.ctxInputTokens / contextWindowForModel(m.model) >= effectiveRecycleRatio) {
          this.logSkipIfChanged(m.id, "recycle-pending");
          continue;
        }
      }

      // Idle long enough? The re-nudge cadence is gated on the LATER of lastActivity and the last
      // nudge, so a fired nudge isn't repeated for another full idleNudgeMinutes window.
      const lastActivityMs = Date.parse(m.lastActivity);
      const lastNudgeMs = state.lastIdleNudgeAt ? Date.parse(state.lastIdleNudgeAt) : 0;
      const idleSinceMs = Math.max(lastActivityMs, lastNudgeMs);
      const idleForMin = (nowMs - idleSinceMs) / 60_000;
      if (idleForMin < idleMinutes) { this.logSkipIfChanged(m.id, "under-window"); continue; }

      if (!pty.isAlive(m.id)) { this.logSkipIfChanged(m.id, "not-alive"); continue; }

      // ESCALATE-INSTEAD-OF-NUDGE (Task 4): we're at the nudge-decision point, so the manager has
      // already cleared the FULL nudge predicate (unpaused, no live worker, not recycle-pending,
      // idle≥window-since-last-nudge, alive). If it's also at/over the unanswered cap it slept through
      // every nudge → escalate ONCE instead of nudging again: append an `idle_escalated` event (the
      // human-facing signal — attention.ts derives the alert from it; we deliberately do NOT enqueue a
      // nudge or raise a notification) and flip policy to 'suppressed'. That stops nudging AND makes the
      // `policy !== 'watching'` gate above skip this manager next tick, so we emit EXACTLY ONCE.
      // Genuine new activity (reset-on-activity above) clears it back to 'watching' and re-arms the cycle.
      if (state.unanswered >= cfg.maxUnansweredNudges) {
        this.deps.db.appendEvent({
          id: randomUUID(), ts: nowIso, managerSessionId: m.id, kind: "idle_escalated",
          detail: { reason: "unanswered_cap", unanswered: state.unanswered },
        });
        db.setIdleNudgePolicy(m.id, "suppressed");
        // eslint-disable-next-line no-console
        console.log(`[idle-watcher] ESCALATED idle manager ${m.id} (${state.unanswered} unanswered nudges → suppressed)`);
        // Not a new log line (already logged above) — just stamp the change-tracker so a LATER skip that
        // happens to share a reason from before this escalation isn't silently suppressed as "unchanged".
        this.lastSkipReason.set(m.id, "escalated");
        continue;
      }

      // Count ALL actionable cards (role-resolved), not just the workReady lane: a task is actionable when
      // its column is NOT the terminal lane AND it is NOT held AND it is NOT deferred — every other
      // non-held/non-deferred lane (intake/defaultLanding/workReady/active/parked) is pending work a
      // manager should be driving. Counting only workReady mis-told an idle manager "0 todo" while actionable
      // cards sat in inbox/active. Mirrors resumeFleetOnBoot's "pending board work" definition
      // (sessions/service.ts) so the two stay consistent. `held` (Board Hold Model redesign) is the SOLE owner
      // brake now, checked in ANY column — a legit card titled with uppercase HOLD/CONFIRM is counted/nudges
      // unless explicitly flagged held (card 788274a9 hardened the old OWNER_HELD_TITLE_RE false-positive
      // away). `deferred` is the manager's OWN sequencing marker (orthogonal to `held`, never checked by
      // worker_spawn) — discounted from the count the same way, so a manager's deliberate defer never
      // triggers a recurring idle nudge. The REVIEW lane is ALSO discounted (card follow-up): a card there
      // is awaiting the manager's OWN merge review, not dispatchable work — role-resolved via
      // columnKeyForRole (never a hardcoded "review" key) so a project with renamed/reordered columns still
      // identifies it correctly. Likewise a card carrying a PENDING (unanswered) connected owner Request
      // (db.listQuestionsForTask, the same taskId→questions linkage tasks_get's connected-requests summary
      // and task_requests_list use) is blocked on the owner, not the manager — discounted the same way; a
      // card whose request is already answered/consumed is NOT discounted (it's actionable again).
      // Scan throttle (card a193398f): the board scan below is the expensive part of this predicate
      // (a full db.listTasks(projectId) plus, historically, one listQuestionsForTask query PER non-terminal
      // card). A "nothing actionable" outcome doesn't advance last_idle_nudge_at, so without this throttle
      // it reran every 60s tick indefinitely. Skip re-scanning within the throttle window of the last scan
      // for THIS manager — short enough that a due nudge is never meaningfully delayed. Only ever SKIPS a
      // re-derivation; never affects whether a nudge fires once scanned.
      //
      // CR follow-up: idleMinutes is project/env-overridable with NO floor, so a project configuring it
      // below IDLE_SCAN_THROTTLE_MINUTES would have its actionable re-nudge cadence silently stretched to
      // the throttle window instead. Floor the EFFECTIVE throttle at this manager's own idleMinutes so it
      // can never exceed that manager's configured nudge cadence, for any config.
      const effectiveScanThrottleMinutes = Math.min(IDLE_SCAN_THROTTLE_MINUTES, idleMinutes);
      const lastScanMs = this.lastIdleScanAt.get(m.id) ?? 0;
      if (nowMs - lastScanMs < effectiveScanThrottleMinutes * 60_000) { this.logSkipIfChanged(m.id, "scan-throttled"); continue; }
      this.lastIdleScanAt.set(m.id, nowMs);

      const cols = resolveConfig(project.config).kanbanColumns;
      const terminalKey = columnKeyForRole(cols, "terminal");
      const reviewKey = columnKeyForRole(cols, "review");
      // Card cb56cf80/f98f3e43: a platform (Lead) session is driven through this SAME manager loop
      // (see the class doc), but its board's "parked" lane is where the Lead's own doctrine puts
      // decision-gated / owner-flow work — waiting on an owner call, not a task the Lead itself can
      // drive. Counting those as "actionable" pressures the Lead to drain exactly the owner-gated
      // backlog /platform-lead forbids. Manager behavior is UNCHANGED (isPlatform is false, so the
      // extra parked-role exclusion below never applies to a manager's own board).
      const isPlatform = m.role === "platform";
      const parkedKey = columnKeyForRole(cols, "parked");
      // A column flagged excludeFromIdleWatchdog (e.g. a "Dropped" parking lane) is a genuine dead-end —
      // its cards are discounted the same way held/deferred/pending-request cards are, so the lane never
      // needs per-card deferred:true toil to stop nagging the idle watchdog. Mirrors hasPendingBoardWork
      // (orchestration/wake-impact.ts) so the two "actionable board work" definitions stay consistent.
      const excludedColumnKeys = new Set(cols.filter((c) => c.excludeFromIdleWatchdog === true).map((c) => c.key));
      const nonTerminal = db.listTasks(m.projectId).filter((t) => t.columnKey !== terminalKey);
      // Batched pending-request check (card a193398f): ONE query for the whole project instead of one
      // listQuestionsForTask call PER non-terminal card (the N+1 this scan used to run every throttle
      // window). listPendingQuestionTaskIds returns raw task_id values as stored — a legacy row (pre-
      // a3f1319f) may carry an 8-char PREFIX rather than the full task id, so prefix rows are matched the
      // same way listQuestionsForTask itself does (`taskId.startsWith(prefix + "-")`), just against an
      // in-memory set instead of a per-card SQL round trip.
      const pendingQuestionTaskIds = db.listPendingQuestionTaskIds(m.projectId);
      const pendingLegacyPrefixes = [...pendingQuestionTaskIds].filter((id) => id.length === 8);
      const hasPendingQuestion = (taskId: string): boolean =>
        pendingQuestionTaskIds.has(taskId) || pendingLegacyPrefixes.some((p) => taskId.startsWith(`${p}-`));
      // Card 93669813: `deferred` alone no longer discounts a card whose deferral is STUCK — its
      // blocker can no longer be shown to resolve (deleted, or closed 0-commit with no proven merge;
      // see Task.deferredStuck's own doc) — a plain "still waiting on a live blocker" deferral is
      // correctly discounted (t.deferred === true && t.deferredStuck !== true), but a stuck one is
      // exactly the unreachable-forever state this card exists to stop hiding, so it counts as
      // actionable again rather than silently pinning the board's "backlog drained" signal forever.
      const openCards = nonTerminal.filter((t) =>
        t.held !== true
        && (t.deferred !== true || t.deferredStuck === true)
        && t.columnKey !== reviewKey
        && !excludedColumnKeys.has(t.columnKey)
        && !(isPlatform && t.columnKey === parkedKey)
        && !hasPendingQuestion(t.id),
      );
      // Card 40deea6f: name the actionable cards in the nudge itself (id + title + held/deferred flags) —
      // the watcher already computed openCards to COUNT them, so surfacing the same set costs nothing
      // extra and saves the manager from burning several tasks_get calls hunting which card "N actionable"
      // meant (real incident: orch 80472fe5 spent 3 sequential lookups + narration turns on exactly this).
      // Capped at 10 (matches the DENY-GLOB listing convention in sessions/service.ts) so a large board
      // doesn't blow the nudge up into an unreadable wall of text — id + title + flags only, never bodies.
      const ACTIONABLE_LIST_CAP = 10;
      const actionableList = openCards
        .slice(0, ACTIONABLE_LIST_CAP)
        .map((t) => `${t.id.slice(0, 8)} ${t.title} (held:${t.held === true}, deferred:${t.deferred === true}${t.deferredStuck === true ? " STUCK" : ""})`)
        .join("; ");
      const actionableSuffix = openCards.length === 0
        ? ""
        : `: ${actionableList}${openCards.length > ACTIONABLE_LIST_CAP ? `, +${openCards.length - ACTIONABLE_LIST_CAP} more` : ""}`;
      // Narrow liveWorkers (all idle at this point — a live BUSY one would have skipped above) to
      // GENUINELY STRANDED ones (CR blocker #2): a live worker that's rate-limited, already reported
      // (awaiting merge), or parked awaiting an ack is NOT "unreported" and nobody needs to check on it
      // — asserting otherwise is exactly board card 99efaab3's false-alarm shape. Single-sources the SAME
      // reconciliation `notifyIdleWorker`/tickIdleWorkers use via the injected isWorkerStranded.
      const strandedWorkers = liveWorkers.filter((w) => this.deps.isWorkerStranded(w.id));
      // A card sitting in review IS independently actionable by the MANAGER itself (go merge it) even
      // though it's excluded from the dispatch-facing `openCards` tally above — unlike held/deferred/
      // pending-request (genuinely nothing the manager can do until someone else acts), review-lane work
      // is squarely the manager's own next step. So its presence must NOT feed the "nothing to do at all"
      // skip below, or a done-and-awaiting-merge worker's card would silently stop nudging its manager to
      // go merge it (regression risk on the existing worker-report → review-lane → idle-nudge coverage).
      const hasReviewCards = nonTerminal.some((t) => t.columnKey === reviewKey);
      // Card c90e9525: a MANUAL deferral (deferred:true, no deferredUntilTaskId — route (a) has its own
      // self-explaining release condition, the named blocker task, and is excluded here) with NO
      // `deferredReason` recorded is exactly the byte-identical "parked-by-design vs. forgotten" defect
      // this card fixes — the `updateProjectTask` guard (mcp/tasks.ts) refuses to CREATE one going
      // forward, so this set is bounded to legacy rows that predate that guard, and it SHRINKS to zero as
      // each one is backfilled with a reason via tasks_update. Chosen surfacing behavior: NOT a new nag
      // cadence of its own — it rides the SAME idle-nudge cadence/throttle already gated above (only
      // reached once a manager is ALREADY idle past its configured idleNudgeMinutes), so a documented
      // (has a reason) deferral, however old, is NEVER mentioned here — "reason recorded" is the quiet
      // signal, not age (the card's own §WHAT THE DEFECT ACTUALLY IS is explicit that age alone cannot
      // tell a legitimately long-parked epic from a forgotten card). Same discount axes as `openCards`
      // MINUS the deferred exclusion itself (held/review/excluded-lane/platform-parked/pending-request
      // still silence it — those are independent "nothing to do" signals, not this one).
      const undocumentedManualDeferrals = nonTerminal.filter((t) =>
        t.held !== true
        && t.deferred === true
        && t.deferredUntilTaskId == null
        && t.deferredStuck !== true
        && !t.deferredReason
        && t.columnKey !== reviewKey
        && !excludedColumnKeys.has(t.columnKey)
        && !(isPlatform && t.columnKey === parkedKey)
        && !hasPendingQuestion(t.id),
      );
      // If EVERY non-terminal card is non-actionable (held/deferred/pending-request — ≥1 exists, 0
      // genuinely-actionable) AND there's no review-lane card to merge AND no genuinely-stranded worker to
      // check on either AND no undocumented manual deferral to flag, the manager has nothing it can action
      // and no way to clear the gate → skip silently instead of deadlock-nudging. A truly empty board (no
      // cards at all) still nudges — the manager should `idle_report 'done'`. But board card b9d479b0: a
      // live STRANDED worker is independently actionable (check on it / worker_message it) even when every
      // OTHER card is non-actionable — don't let this skip re-silence exactly the manager that should be
      // checking on its stranded worker. The undocumented-deferral case is the SAME shape: it must not be
      // swallowed by this skip either, or a board that's ENTIRELY undocumented-deferred cards would never
      // once get flagged (card c90e9525's central defect, reproduced inside this very skip if left out).
      //
      // Card 8e87f3b5: the session's OWN pending owner Request (hasOwnPendingRequest, computed above) folds
      // in HERE rather than short-circuiting earlier — it only silences the nudge when there's genuinely
      // nothing else actionable either (nothingElseActionable), so a session parked on its own Request WITH
      // other actionable work in play still gets nudged for that work. It also OVERRIDES the "truly empty
      // board still nudges" carve-out immediately above: a session correctly parked on its own Request with
      // zero cards at all is exactly cb56cf80's original "blocked on the owner, stay quiet" case, not a
      // dropped-the-loop case that should `idle_report 'done'`. NOTE: this skip is evaluated AFTER the
      // ESCALATE-INSTEAD-OF-NUDGE block above, so a session that slept through its unanswered-nudge cap
      // still escalates to the human even while its own-Request suppression would otherwise apply here —
      // the escalation is a distinct human-facing signal, never itself gated by this predicate.
      const nothingElseActionable =
        strandedWorkers.length === 0 && !hasReviewCards && openCards.length === 0 && undocumentedManualDeferrals.length === 0;
      if (nothingElseActionable && (nonTerminal.length > 0 || hasOwnPendingRequest)) {
        // Card cdd10965's first-party specimen: a truly-empty board parked ONLY on the session's own
        // pending owner Request (cb56cf80's original carve-out) is diagnostically distinct from "real
        // cards exist but none of them are actionable" — name the two apart rather than folding both into
        // one generic "nothing-actionable".
        const reason = nonTerminal.length === 0 && hasOwnPendingRequest ? "own-pending-request" : "nothing-actionable";
        this.logSkipIfChanged(m.id, reason);
        continue;
      }
      const openTodos = openCards.length;
      const n = Math.round((nowMs - lastActivityMs) / 60_000);
      // Three honest cases: a genuinely-stranded live worker (say so specifically); a live worker that's
      // NOT stranded (rate-limited/reported/parked — say nothing false about it either way); or no live
      // workers at all. Never assert "unreported" or "no live workers" when it isn't true (99efaab3).
      // A platform (Lead) session gets its OWN copy (card f98f3e43): a Lead never parents a worker (the
      // class doc), so it always falls into the "no live workers" shape below — but the MANAGER copy
      // there ("dropped the orchestration loop / pick up the next task NOW") pressures exactly the
      // owner-backlog-drain anti-pattern /platform-lead forbids. Swap in copy that just asks it to
      // confirm its actual disposition (parked-waiting on an owner call, or genuinely converged) instead
      // of framing idleness as a dropped dispatch loop. The MANAGER branches below are byte-identical.
      const msg = isPlatform
        ? `[loom:idle] You've been idle ~${n} min. Confirm your disposition: are you parked-waiting on an ` +
          `owner decision (or other external thing), or has your loop genuinely converged with nothing left ` +
          `to drive? Call idle_report with your state: 'working' (back at it), 'waiting' (parked — optionally ` +
          `pass minutes), or 'done' (converged, nothing left to drive). Need an owner decision? File a Request ` +
          `via question_ask instead.`
        : strandedWorkers.length > 0
        ? `[loom:idle] You've been idle ~${n} min and your ${strandedWorkers.length} live worker(s) are ALSO idle and unreported — ` +
          `nobody else watches this. Check on them first: worker_transcript / worker_status, then worker_message or ` +
          `worker_merge as appropriate. ${openTodos} other actionable task(s) pending${actionableSuffix}. Then call idle_report with your ` +
          `state: 'working' (back at it), 'waiting' (on a long worker or external thing — optionally pass minutes), ` +
          `or 'done' (the queue is genuinely drained). Need a human decision/credential/access? File a Request via question_ask instead.`
        : liveWorkers.length > 0
        ? `[loom:idle] You've been idle ~${n} min with ${openTodos} actionable task(s) pending${actionableSuffix}. ` +
          `Why are you idle? If you simply dropped the orchestration loop, pick up the next task NOW. ` +
          `Then call idle_report with your state: 'working' (back at it), 'waiting' (on a long worker or ` +
          `external thing — optionally pass minutes), or 'done' (the queue is genuinely drained). Need a human ` +
          `decision/credential/access? File a Request via question_ask instead. Resume the loop if appropriate.`
        : `[loom:idle] You've been idle ~${n} min with no live workers and ${openTodos} actionable task(s)${actionableSuffix}. ` +
          `Why are you idle? If you simply dropped the orchestration loop, pick up the next task NOW. ` +
          `Then call idle_report with your state: 'working' (back at it), 'waiting' (on a long worker or ` +
          `external thing — optionally pass minutes), or 'done' (the queue is genuinely drained). Need a human ` +
          `decision/credential/access? File a Request via question_ask instead. Resume the loop if appropriate.`;
      // Card c90e9525: a low-key, non-nagging mention of any undocumented manual deferral — bundled into
      // whichever nudge already fired above for OTHER reasons (or, via the skip guard above, the ONLY
      // reason this nudge fired at all). Never phrased as actionable work or a request to un-defer
      // anything (DoD-1: never auto-clear) — just "here's what would silence this permanently".
      const deferralIds = undocumentedManualDeferrals.slice(0, ACTIONABLE_LIST_CAP).map((t) => t.id.slice(0, 8)).join(", ");
      const undocumentedDeferralSuffix = undocumentedManualDeferrals.length === 0
        ? ""
        : ` (Also: ${undocumentedManualDeferrals.length} manually-deferred card(s) have no reason recorded — legacy, ` +
          `predates this field, not actionable — add one via tasks_update(deferredReason:...) to silence this ` +
          `permanently: ${deferralIds}${undocumentedManualDeferrals.length > ACTIONABLE_LIST_CAP ? `, +${undocumentedManualDeferrals.length - ACTIONABLE_LIST_CAP} more` : ""}.)`;
      // Card 9c8e256e: what changed on the board since THIS recipient's own last tasks_list read (never a
      // wall-clock window — see board-read.ts). Applied to every nudge variant above (isPlatform/stranded/
      // liveWorkers/none all flow through this ONE insertion point) so the digest is never a half-fix
      // covering only one shape. A "not computed" delta is never phrased so it could be mistaken for a
      // measured empty one (DoD-3) — see formatBoardDeltaDigest's own three-way contract.
      const boardDeltaSuffix = ` ${formatBoardDeltaDigest(computeBoardDelta(db, m.id, m.projectId, nonTerminal))}`;
      // Card a193398f: append the bounded-recheck hint to the MANAGER branches only (they cite the
      // openTodos/stranded/live-worker counts this hint refers to) — the platform (Lead) branch above
      // doesn't surface those counts, so the hint wouldn't make sense appended there.
      const finalMsg = isPlatform
        ? msg + undocumentedDeferralSuffix + boardDeltaSuffix
        : msg + undocumentedDeferralSuffix + boardDeltaSuffix + IDLE_NUDGE_BOUNDED_HINT;
      // Card f6d72db8: use the return value instead of discarding it — mirrors ContextWatcher's own fix
      // (card 49fdcbbc, same enqueueStdin contract). `delivered:true` and `delivered:false, queued:true`
      // both mean the nudge was ACCEPTED, so both are recorded the same way; anything else (not accepted
      // — e.g. the manager went not-live between our own isAlive check above and this call — or the call
      // throws) must NOT stamp the cooldown or increment the escalation counter: an undelivered nudge must
      // not buy silence, and it must not count a strike toward a human-facing escalation that reads "this
      // manager has slept through every nudge" when it may never have been told at all.
      let result: { delivered: boolean; queued?: boolean };
      let threw = false;
      try { result = pty.enqueueStdin(m.id, finalMsg); } catch { threw = true; result = { delivered: false, queued: false }; }
      if (!result.delivered && !result.queued) {
        // State what was OBSERVED, not an inferred cause (mirrors context-watcher.ts's own wording).
        // eslint-disable-next-line no-console
        console.log(`[idle-watcher] nudge to manager ${m.id} was NOT accepted (${threw ? "enqueueStdin threw" : "enqueueStdin reported neither delivered nor queued"}) — not recording a sent nudge, not counting a strike`);
        // Not a new log line (already logged above) — see the escalate branch's own comment on why this
        // sentinel matters: without it, a later skip sharing a stale reason from before this attempt would
        // be silently suppressed as "unchanged".
        this.lastSkipReason.set(m.id, "nudge-not-accepted");
        continue;
      }
      db.recordIdleNudge(m.id, nowIso); // stamp last_idle_nudge_at + increment idle_nudge_unanswered
      // eslint-disable-next-line no-console
      console.log(`[idle-watcher] nudged idle manager ${m.id} (~${n}m idle, ${openTodos} actionable, unanswered→${state.unanswered + 1})`);
      this.lastSkipReason.set(m.id, "nudged"); // same sentinel rationale as above
    }

    this.tickIdleWorkers(nowMs, nowIso);
    this.tickAnsweredStuckQuestions(nowMs);
    this.tickStaleRequests(nowMs, nowIso);
  }

  /**
   * Stale-owner-Request watchdog (card 99d41588). Independent of the manager idle-nudge loop above:
   * keyed on `questions.created_at` (the Request's own clock), never any asking session's idle/
   * suppression state — so it correctly reaches a Request whose asking session is currently busy/live
   * doing unrelated work, AND a Request whose session is correctly own-Request-suppressed by
   * cb56cf80/8e87f3b5 (that suppression's own `unanswered` idle-nudge counter never increments for a
   * suppressed session, so it can never reach `maxUnansweredNudges` — this loop is the ONLY path such a
   * Request ever gets a human-facing signal at all). Deliberately never reads or mutates
   * `idle_nudge_state` — a different clock for a different subject, per the card's own DoD.
   *
   * `Db.listStalePendingQuestions` is called with `beforeIso=now` (trivially true of any still-pending
   * row) rather than a precomputed cutoff, because the actual age THRESHOLD is per-project
   * (`orchestration.staleRequestMinutes`) — one global cutoff can't do that filtering, so it's applied
   * here per-row instead, against each row's own project's resolved config. Skips a Request whose project
   * is gone (defensive/TOCTOU) or which has the watchdog disabled (`staleRequestMinutes === 0`), or whose
   * age hasn't yet crossed that project's threshold.
   *
   * `Db.markQuestionEscalated`'s own guarded UPDATE (`state='pending' AND escalated_at IS NULL`) is what
   * makes this fire EXACTLY ONCE per Request: a later tick never re-returns an already-stamped row from
   * `listStalePendingQuestions`, and the guard refuses the stamp anyway if the row was answered/cancelled
   * between the scan and this write — in which case NO event is appended, since an already-resolved
   * Request needs no alert.
   */
  private tickStaleRequests(nowMs: number, nowIso: string): void {
    const { db } = this.deps;
    for (const q of db.listStalePendingQuestions(nowIso)) {
      const project = db.getProject(q.projectId);
      if (!project) continue; // defensive/TOCTOU — mirrors the manager loop's own "no-project" skip above
      const staleMinutes = resolveConfig(project.config).orchestration.staleRequestMinutes;
      if (staleMinutes === 0) continue; // disabled for this project
      const ageMinutes = (nowMs - Date.parse(q.createdAt)) / 60_000;
      if (ageMinutes < staleMinutes) continue;
      if (!db.markQuestionEscalated(q.id, nowIso)) continue; // lost race (answered/cancelled/already escalated) — no alert
      db.appendEvent({
        id: randomUUID(), ts: nowIso, managerSessionId: q.sessionId, kind: "request_escalated",
        detail: { questionId: q.id, title: q.title, ageMinutes: Math.round(ageMinutes) },
      });
      // eslint-disable-next-line no-console
      console.log(`[idle-watcher] ESCALATED stale Request ${q.id} (~${Math.round(ageMinutes)}m pending, session ${q.sessionId})`);
    }
  }

  /**
   * Answered-stuck-question watchdog (follow-up to card 8701bdbb): a `questions` row the human answered
   * (`POST /api/questions/:id/answer`) but the asking manager never `question_pull`ed, stuck past
   * ANSWERED_QUESTION_STUCK_MINUTES, re-nudges that MANAGER — never the human, who already answered and
   * would only see noise. Routed by AGENT LINEAGE, not the exact asking session id (card f88e91f0):
   * `db.getLiveSessionForAgent` resolves whoever is CURRENTLY live for the asker's agent — a recycle
   * successor OR a fresh non-recycle respawn on the same agent — so this nudge reaches a live successor
   * instead of nagging a session id whose pty is already gone. Skips silently when there's no live
   * session for that agent, it isn't a manager, is human-paused, is rate-limited/parked (it'll
   * auto-resume on its own), or has itself flagged non-'watching' via idle_report (waiting/done/
   * escalated) — reusing the SAME idle-nudge-state policy the manager idle loop above reads, so a manager
   * legitimately not watching its inbox right now isn't nagged twice. Nudged EXACTLY ONCE per
   * answered→still-answered window via the in-memory `nudgedAnsweredQuestions` Set (no schema change):
   * pruned the moment a question leaves 'answered' (pulled/consumed), so the Set stays bounded and a
   * hypothetical future re-answer of the same id isn't silenced by a stale entry.
   */
  private tickAnsweredStuckQuestions(nowMs: number): void {
    const { db, pty, control } = this.deps;

    for (const id of this.nudgedAnsweredQuestions) {
      const q = db.getQuestion(id);
      if (!q || q.state !== "answered") this.nudgedAnsweredQuestions.delete(id);
    }

    const beforeIso = new Date(nowMs - ANSWERED_QUESTION_STUCK_MINUTES * 60_000).toISOString();
    for (const q of db.listAnsweredStuckQuestions(beforeIso)) {
      if (this.nudgedAnsweredQuestions.has(q.id)) continue; // already nudged this window

      const asker = db.getSession(q.sessionId);
      if (!asker) continue; // defensive — the FK on questions.session_id makes this unreachable in practice
      const m = db.getLiveSessionForAgent(asker.agentId);
      if (!m || m.role !== "manager") continue; // no live manager for this agent right now
      if (!pty.isAlive(m.id)) continue;
      if (control.isPaused(m.id)) continue; // human-paused (own scope or global)
      if (m.rateLimitedUntil && Date.parse(m.rateLimitedUntil) > nowMs) continue; // rate-limited/parked

      const state = db.getIdleNudgeState(m.id);
      if (state && state.policy !== "watching") continue; // manager itself flagged waiting/suppressed

      const msg = `[loom:answered-stuck] Your decision "${q.title}" was answered a while ago but you haven't pulled it — call question_pull to fetch it.`;
      // Tag with q.id (mirrors the answer-route push-nudge, card bbc46336) so a LATER question_pull that
      // consumes this question purges this exact nudge if it's still queued when it goes stale — otherwise
      // a manager behind on turns sees a "pull it" nudge for a question it already pulled.
      // Card f6d72db8, decided-separately per its DoD: this site's discard was the SAME shape as the
      // manager-nudge path above, but its consequence is materially different — marking a question
      // "nudged" only suppresses it from `nudgedAnsweredQuestions` (no DB cooldown, no unanswered strike,
      // so it can never escalate a human on an unsent message). Still worth the same fix: without it, a
      // genuinely-undelivered "pull it" re-nudge is marked nudged anyway and never re-fires for the rest
      // of the process lifetime (this Set has no other expiry/cadence) — a real, if lesser, bug. Same
      // acceptance check as the manager path (and ContextWatcher, card 49fdcbbc): only an ACCEPTED
      // (delivered or durably queued) attempt marks this question nudged.
      let result: { delivered: boolean; queued?: boolean };
      let threw = false;
      try { result = pty.enqueueStdin(m.id, msg, "system", undefined, undefined, "agent", q.id); } catch { threw = true; result = { delivered: false, queued: false }; }
      if (!result.delivered && !result.queued) {
        // eslint-disable-next-line no-console
        console.log(`[idle-watcher] re-nudge for answered-but-unpulled question ${q.id} was NOT accepted (${threw ? "enqueueStdin threw" : "enqueueStdin reported neither delivered nor queued"}) — not marking it nudged`);
        continue;
      }
      this.nudgedAnsweredQuestions.add(q.id);
      // eslint-disable-next-line no-console
      console.log(`[idle-watcher] re-nudged manager ${m.id} for answered-but-unpulled question ${q.id}`);
    }
  }

  /**
   * Idle-WORKER coverage (board card b9d479b0 primary fix) — see the class doc above. Skips silently
   * when: the worker is busy (BusyWorkerWatcher's concern), parentless/taskless, already reported/merged
   * (its task left the active lane — the SAME proxy notifyManagerOfIdleWorker itself re-checks, so this
   * is just a cheap pre-filter that avoids touching idle_nudge_state for an obviously-done worker), the
   * worker or its owning manager is human-paused, the worker isn't actually alive, or the project
   * disabled it (`idleWorkerMinutes === 0`). Otherwise re-nudges once per `idleWorkerMinutes` window via
   * `notifyIdleWorker` — never re-implementing its reconciliation (board card 99efaab3 requirement).
   */
  private tickIdleWorkers(nowMs: number, nowIso: string): void {
    const { db, pty, control } = this.deps;
    for (const w of db.listLiveWorkers()) {
      if (w.busy) continue;                                    // BusyWorkerWatcher's concern
      // TASKLESS intentionally skipped here (CR-flagged asymmetry, card 2514e6e1-follow-up): this whole
      // periodic re-nudge reconciles via board-column state (the "already reported/merged" pre-filter
      // just below, and notifyIdleWorker's own classifyIdleWorker underneath) — meaningless for a worker
      // with no card. Broken-spawn coverage for a taskless worker fires ONCE, on the busy→false edge, via
      // SessionService.notifyManagerOfIdleWorker directly (index.ts's onBusy hook, not this periodic
      // tick) — the manager that spawned a taskless worker is expected to actively await + worker_stop it
      // directly rather than lean on this periodic safety net.
      if (!w.parentSessionId || !w.taskId) continue;            // no owning manager/task to nudge

      const project = db.getProject(w.projectId);
      if (!project) continue;
      const resolved = resolveConfig(project.config);
      const idleWorkerMin = resolved.orchestration.idleWorkerMinutes;
      if (idleWorkerMin === 0) continue;                        // disabled for this project

      // Already reported/merged? Task left the active lane → nothing to nudge.
      const activeKey = columnKeyForRole(resolved.kanbanColumns, "active");
      const task = db.getTask(w.taskId);
      if (!task || task.columnKey !== activeKey) continue;

      if (control.isPaused(w.id) || control.isPaused(w.parentSessionId)) continue; // human-paused
      if (!pty.isAlive(w.id)) continue;

      const state = db.getIdleNudgeState(w.id);
      if (!state) continue;
      const lastActivityMs = Date.parse(w.lastActivity);
      const lastNudgeMs = state.lastIdleNudgeAt ? Date.parse(state.lastIdleNudgeAt) : 0;
      const idleSinceMs = Math.max(lastActivityMs, lastNudgeMs);
      const idleForMin = (nowMs - idleSinceMs) / 60_000;
      if (idleForMin < idleWorkerMin) continue;

      this.deps.notifyIdleWorker(w.id);
      db.recordIdleNudge(w.id, nowIso); // stamp last_idle_nudge_at (paces the re-nudge; unanswered unused for workers)
      // eslint-disable-next-line no-console
      console.log(`[idle-watcher] re-nudged idle-unreported worker ${w.id} (~${Math.round(idleForMin)}m idle)`);
    }
  }

  /** True if the manager appended a genuine orchestration-work event strictly after `sinceIso`. */
  private producedActivitySince(managerId: string, sinceIso: string): boolean {
    for (const e of this.deps.db.listEvents(managerId)) {
      if (e.ts > sinceIso && ORCH_ACTIVITY_KINDS.has(e.kind)) return true;
    }
    return false;
  }

  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
