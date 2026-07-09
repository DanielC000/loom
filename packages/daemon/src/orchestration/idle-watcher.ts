import { randomUUID } from "node:crypto";
import { resolveConfig, contextWindowForModel, columnKeyForRole } from "@loom/shared";
import type { OrchestrationEventKind } from "@loom/shared";
import type { Db } from "../db.js";
import type { OrchestrationControl } from "./control.js";
import type { QueueSource, TurnRoute, QueuedMessageKind } from "../pty/host.js";

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
   */
  enqueueStdin(sessionId: string, text: string, source?: QueueSource, onDeliver?: () => void, route?: TurnRoute, kind?: QueuedMessageKind, questionId?: string): { delivered: boolean; position?: number };
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
  "merge_request", "merge_done", "merge_rejected",
  "recycle_begin", "recycle_complete", "build_gate", "kill_switch",
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
 * Asleep-at-the-Wheel watcher (idle-manager watchdog). Structural twin of ContextWatcher: each tick,
 * for every LIVE manager that is idle (`busy=false` + `lastActivity` older than the project's
 * `idleNudgeMinutes`) with NO live workers, it injects a ONE-TIME-per-episode busy-gated nudge asking
 * the manager WHY it is idle and to `idle_report` its state (then resume the loop). Agent-in-the-loop:
 * Loom can't know why a manager is idle, so it asks; the manager answers over MCP (`idle_report`).
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
 */
export class IdleWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Answered-stuck-question storm guard: tracks question ids already re-nudged this answered→still-
   * answered window (no schema change — see tickAnsweredStuckQuestions). A daemon restart clears this,
   * re-nudging once more; benign, since that's rare and one extra manager nudge is harmless.
   */
  private nudgedAnsweredQuestions = new Set<string>();
  constructor(private deps: IdleWatcherDeps) {}

  tick(now: Date = new Date()): void {
    const { db, pty, control, recycleRatio } = this.deps;
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    for (const m of db.listLiveManagers()) {
      const project = db.getProject(m.projectId);
      if (!project) continue;
      const cfg = resolveConfig(project.config).orchestration;
      const idleMinutes = cfg.idleNudgeMinutes;
      if (idleMinutes === 0) continue; // disabled for this project

      // Reset-on-activity: a manager that produced genuine orchestration work AFTER its last nudge is
      // back at the wheel — re-arm it (watching / unanswered 0 / snooze clear) before we evaluate.
      let state = db.getIdleNudgeState(m.id);
      if (!state) continue;
      if (state.lastIdleNudgeAt && this.producedActivitySince(m.id, state.lastIdleNudgeAt)) {
        db.resetIdleNudgeState(m.id);
        state = db.getIdleNudgeState(m.id);
        if (!state) continue;
      }

      // Timed snooze expiry: a manager that reported `waiting` is silent only UNTIL snooze_until
      // ("silent until then" — reuses wake_me semantics; persisted, so honored across a restart).
      // Once it elapses, re-arm to 'watching' (clears the snooze) so the normal predicate evaluates
      // it again this/next tick. ONLY for 'snoozed' — 'suppressed' (blocked_human/done) stays sticky
      // until genuine activity or a human reclaims it (Task 4). unanswered is already 0 for a manager
      // that answered `waiting`, so the reset is safe.
      if (state.policy === "snoozed" && state.snoozeUntil && nowIso >= state.snoozeUntil) {
        db.resetIdleNudgeState(m.id);
        state = db.getIdleNudgeState(m.id);
        if (!state) continue;
      }

      // --- the full trigger predicate (skip silently if ANY fails) ---
      if (m.busy) continue;                                              // mid-turn → not idle
      if (state.policy !== "watching") continue;                         // snoozed (within window) / suppressed
      if (state.snoozeUntil && nowIso < state.snoozeUntil) continue;     // defensive: active snooze on a watching row
      // NOTE: the unanswered≥cap case is NOT a skip here — it ESCALATES at the nudge-decision point below
      // (it must pass the SAME predicate a nudge does: unpaused, no live worker, not recycle-pending,
      // idle≥window-since-last-nudge, alive — so a human/recycle-owned manager is never escalated).
      if (control.isPaused(m.id)) continue;                              // human-paused

      // Live BUSY worker — a manager waiting on a building/turning worker is legitimately idle (don't
      // nudge). Board card b9d479b0 (two-path asymmetry): this used to skip on ANY live worker, busy OR
      // idle — silencing the manager exactly when its worker was idle-and-stranded and needed it most.
      // An idle (busy=false) live worker is NOT a reason to skip: tickIdleWorkers below covers it on its
      // own cadence, but the manager itself should also be nudged to go check on a stranded worker rather
      // than sit idle waiting on nothing.
      const liveWorkers = db.listWorkers(m.id).filter((w) => w.processState === "live");
      const liveBusyWorkers = liveWorkers.filter((w) => w.busy).length;
      if (liveBusyWorkers > 0) continue;

      // Competing recycle nudge: a near-full manager should recycle, not spawn. Mirror ContextWatcher's
      // own per-project threshold (env force override, else THIS project's resolved recycleAtContextRatio,
      // already computed above as cfg) so idle precedence never disagrees with the recycle trigger.
      const effectiveRecycleRatio = recycleRatio > 0 ? recycleRatio : cfg.recycleAtContextRatio;
      if (effectiveRecycleRatio > 0 && m.ctxInputTokens != null) {
        if (m.ctxInputTokens / contextWindowForModel(m.model) >= effectiveRecycleRatio) continue;
      }

      // Idle long enough? The re-nudge cadence is gated on the LATER of lastActivity and the last
      // nudge, so a fired nudge isn't repeated for another full idleNudgeMinutes window.
      const lastActivityMs = Date.parse(m.lastActivity);
      const lastNudgeMs = state.lastIdleNudgeAt ? Date.parse(state.lastIdleNudgeAt) : 0;
      const idleSinceMs = Math.max(lastActivityMs, lastNudgeMs);
      const idleForMin = (nowMs - idleSinceMs) / 60_000;
      if (idleForMin < idleMinutes) continue;

      if (!pty.isAlive(m.id)) continue;

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
        continue;
      }

      // Count ALL actionable cards (role-resolved), not just the workReady lane: a task is actionable when
      // its column is NOT the terminal lane AND it is NOT held AND it is NOT deferred — every other
      // non-held/non-deferred lane (intake/defaultLanding/workReady/active/review/parked) is pending work a
      // manager should be driving. Counting only workReady mis-told an idle manager "0 todo" while actionable
      // cards sat in inbox/active/review. Mirrors resumeFleetOnBoot's "pending board work" definition
      // (sessions/service.ts) so the two stay consistent. `held` (Board Hold Model redesign) is the SOLE owner
      // brake now, checked in ANY column — a legit card titled with uppercase HOLD/CONFIRM is counted/nudges
      // unless explicitly flagged held (card 788274a9 hardened the old OWNER_HELD_TITLE_RE false-positive
      // away). `deferred` is the manager's OWN sequencing marker (orthogonal to `held`, never checked by
      // worker_spawn) — discounted from the count the same way, so a manager's deliberate defer never
      // triggers a recurring idle nudge.
      const cols = resolveConfig(project.config).kanbanColumns;
      const terminalKey = columnKeyForRole(cols, "terminal");
      const nonTerminal = db.listTasks(m.projectId).filter((t) => t.columnKey !== terminalKey);
      const openCards = nonTerminal.filter((t) => t.held !== true && t.deferred !== true);
      // Narrow liveWorkers (all idle at this point — a live BUSY one would have skipped above) to
      // GENUINELY STRANDED ones (CR blocker #2): a live worker that's rate-limited, already reported
      // (awaiting merge), or parked awaiting an ack is NOT "unreported" and nobody needs to check on it
      // — asserting otherwise is exactly board card 99efaab3's false-alarm shape. Single-sources the SAME
      // reconciliation `notifyIdleWorker`/tickIdleWorkers use via the injected isWorkerStranded.
      const strandedWorkers = liveWorkers.filter((w) => this.deps.isWorkerStranded(w.id));
      // If EVERY non-terminal card is held/deferred (≥1 exists, 0 genuinely-actionable) AND there's no
      // genuinely-stranded worker to check on either, the manager has nothing it can action and no way
      // to clear the gate → skip silently instead of deadlock-nudging. A truly empty board (no cards at
      // all) still nudges — the manager should `idle_report 'done'`. But board card b9d479b0: a live
      // STRANDED worker is independently actionable (check on it / worker_message it) even when every
      // OTHER card is deliberately held/deferred — don't let this skip re-silence exactly the manager
      // that should be checking on its stranded worker.
      if (strandedWorkers.length === 0 && nonTerminal.length > 0 && openCards.length === 0) continue;
      const openTodos = openCards.length;
      const n = Math.round((nowMs - lastActivityMs) / 60_000);
      // Three honest cases: a genuinely-stranded live worker (say so specifically); a live worker that's
      // NOT stranded (rate-limited/reported/parked — say nothing false about it either way); or no live
      // workers at all. Never assert "unreported" or "no live workers" when it isn't true (99efaab3).
      const msg = strandedWorkers.length > 0
        ? `[loom:idle] You've been idle ~${n} min and your ${strandedWorkers.length} live worker(s) are ALSO idle and unreported — ` +
          `nobody else watches this. Check on them first: worker_transcript / worker_status, then worker_message or ` +
          `worker_merge as appropriate. ${openTodos} other actionable task(s) pending. Then call idle_report with your ` +
          `state: 'working' (back at it), 'waiting' (on a long worker or external thing — optionally pass minutes), ` +
          `'blocked_human' (need a human decision/credential/access), or 'done' (the queue is genuinely drained).`
        : liveWorkers.length > 0
        ? `[loom:idle] You've been idle ~${n} min with ${openTodos} actionable task(s) pending. ` +
          `Why are you idle? If you simply dropped the orchestration loop, pick up the next task NOW. ` +
          `Then call idle_report with your state: 'working' (back at it), 'waiting' (on a long worker or ` +
          `external thing — optionally pass minutes), 'blocked_human' (need a human decision/credential/access), ` +
          `or 'done' (the queue is genuinely drained). Resume the loop if appropriate.`
        : `[loom:idle] You've been idle ~${n} min with no live workers and ${openTodos} actionable task(s). ` +
          `Why are you idle? If you simply dropped the orchestration loop, pick up the next task NOW. ` +
          `Then call idle_report with your state: 'working' (back at it), 'waiting' (on a long worker or ` +
          `external thing — optionally pass minutes), 'blocked_human' (need a human decision/credential/access), ` +
          `or 'done' (the queue is genuinely drained). Resume the loop if appropriate.`;
      try { pty.enqueueStdin(m.id, msg); } catch { /* manager not live */ }
      db.recordIdleNudge(m.id, nowIso); // stamp last_idle_nudge_at + increment idle_nudge_unanswered
      // eslint-disable-next-line no-console
      console.log(`[idle-watcher] nudged idle manager ${m.id} (~${n}m idle, ${openTodos} actionable, unanswered→${state.unanswered + 1})`);
    }

    this.tickIdleWorkers(nowMs, nowIso);
    this.tickAnsweredStuckQuestions(nowMs);
  }

  /**
   * Answered-stuck-question watchdog (follow-up to card 8701bdbb): a `questions` row the human answered
   * (`POST /api/questions/:id/answer`) but the asking manager never `question_pull`ed, stuck past
   * ANSWERED_QUESTION_STUCK_MINUTES, re-nudges that MANAGER — never the human, who already answered and
   * would only see noise. Skips silently when the asking session isn't a live manager, is human-paused,
   * is rate-limited/parked (it'll auto-resume on its own), or has itself flagged non-'watching' via
   * idle_report (waiting/blocked_human/escalated) — reusing the SAME idle-nudge-state policy the manager
   * idle loop above reads, so a manager legitimately not watching its inbox right now isn't nagged twice.
   * Nudged EXACTLY ONCE per answered→still-answered window via the in-memory `nudgedAnsweredQuestions`
   * Set (no schema change): pruned the moment a question leaves 'answered' (pulled/consumed), so the Set
   * stays bounded and a hypothetical future re-answer of the same id isn't silenced by a stale entry.
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

      const m = db.getSession(q.sessionId);
      if (!m || m.role !== "manager" || m.processState !== "live") continue; // asking session isn't a live manager
      if (!pty.isAlive(m.id)) continue;
      if (control.isPaused(m.id)) continue; // human-paused (own scope or global)
      if (m.rateLimitedUntil && Date.parse(m.rateLimitedUntil) > nowMs) continue; // rate-limited/parked

      const state = db.getIdleNudgeState(m.id);
      if (state && state.policy !== "watching") continue; // manager itself flagged waiting/suppressed

      const msg = `[loom:answered-stuck] Your decision "${q.title}" was answered a while ago but you haven't pulled it — call question_pull to fetch it.`;
      // Tag with q.id (mirrors the answer-route push-nudge, card bbc46336) so a LATER question_pull that
      // consumes this question purges this exact nudge if it's still queued when it goes stale — otherwise
      // a manager behind on turns sees a "pull it" nudge for a question it already pulled.
      try { pty.enqueueStdin(m.id, msg, "system", undefined, undefined, "agent", q.id); } catch { /* manager not live */ }
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
