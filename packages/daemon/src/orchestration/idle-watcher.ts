import { randomUUID } from "node:crypto";
import { resolveConfig, contextWindowForModel, columnKeyForRole } from "@loom/shared";
import type { OrchestrationEventKind, Task } from "@loom/shared";
import type { Db } from "../db.js";
import type { OrchestrationControl } from "./control.js";
import type { QueueSource, TurnRoute, QueuedMessageKind } from "../pty/host.js";
import type { IdleWorkerNotifyOutcome } from "../sessions/service.js";
import { computeBoardDelta, formatBoardDeltaDigest } from "./board-read.js";
import { requestAnsweredTriggerNotice } from "./deferred-trigger-notice.js";
import { isLikelyNearClaudeUsageLimit } from "./usage-awareness.js";

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests claude-free). */
export interface IdlePty {
  isAlive(sessionId: string): boolean;
  /**
   * Nudge text into the session's busy-gated queue (waits if the target is mid-turn). `source`/`route`/
   * `kind`/`questionId` mirror PtyHost.enqueueStdin's own optional tail — the answered-stuck watchdog
   * passes `kind:"agent"` so its re-nudge drains as a distinct one-per-turn message, not a coalesced
   * warning, and `questionId` so a LATER `question_pull` can purge this exact nudge
   * via the SAME path the answer-route push-nudge already uses.
   *
   * @decision bbc46336
   *
   * The real PtyHost.enqueueStdin returns a richer `EnqueueResult` (see pty/host.ts) with THREE possible
   * outcomes, collapsed here to the two this watcher needs to distinguish: `delivered:true` or
   * `delivered:false, queued:true` both mean the nudge was ACCEPTED; `delivered:false` with `queued`
   * falsy means it was NOT accepted at all.
   * @decision f6d72db8 — only an ACCEPTED result (`delivered || queued`) may stamp a nudge cooldown or
   * count an escalation strike; an unaccepted attempt must never buy silence or count as a strike toward
   * "slept through every nudge".
   */
  enqueueStdin(sessionId: string, text: string, source?: QueueSource, onDeliver?: () => void, route?: TurnRoute, kind?: QueuedMessageKind, questionId?: string): { delivered: boolean; position?: number; queued?: boolean };
  /**
   * Card d1521fca (MCP-silence watchdog): epoch ms `sessionId` was last seen on `router` (any MCP
   * method/tool), or `undefined` if never seen / not live. See `PtyHost.getMcpRouterLastSeen`.
   * Optional — mirrors `recordToolCallArgsHash?.` elsewhere in this codebase: a minimal test stub for
   * `deps.pty` predating this card stays a harmless no-op (classifyMcpSilence sees "nothing established"
   * rather than throwing) instead of every such stub needing to grow three new methods it doesn't care
   * about just to keep constructing an `IdleWatcher`.
   */
  getMcpRouterLastSeen?(sessionId: string, router: string): number | undefined;
  /**
   * This session's OWN observed cadence for `router` — the gap (ms) between its last two sightings — or
   * `undefined` until a second sighting exists. See `PtyHost.getMcpRouterCadenceMs`. Optional — see
   * `getMcpRouterLastSeen`'s own doc just above for why.
   */
  getMcpRouterCadenceMs?(sessionId: string, router: string): number | undefined;
  /**
   * Every router name `sessionId` has EVER been seen on (>=1 sighting). See `PtyHost.getMcpRoutersSeen`.
   * Optional — see `getMcpRouterLastSeen`'s own doc just above for why.
   */
  getMcpRoutersSeen?(sessionId: string): string[];
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
  notifyIdleWorker: (workerSessionId: string) => IdleWorkerNotifyOutcome | void;
  /**
   * SessionService.isWorkerGenuinelyStranded (CR blocker #2 fold-in) — single-sources the SAME
   * reconciliation `notifyIdleWorker` uses, exposed as a pure predicate so the manager loop's OWN idle
   * message can narrow "live worker(s)" to genuinely-unreported ones before asserting "unreported —
   * nobody else watches this". Without this, the message would fire that claim for a worker that's
   * actually rate-limited, already reported (awaiting merge), or parked awaiting an ack — exactly the
   * misleading shape board card 99efaab3 exists to prevent.
   */
  isWorkerStranded: (workerSessionId: string) => boolean;
  /**
   * Card d1521fca (MCP-silence watchdog, WORKER shape — the b5668822 incident): deliver an already-built
   * notice to `parentSessionId` (the silent worker's own owning manager). Mirrors
   * SessionService.notifyMcpSilenceParent — a durable nudge, never a raw `enqueueStdin`, so a
   * parked/offline manager still gets it. Returns whether the nudge was accepted, recorded verbatim in
   * the durable `mcp_silence_detected` event's `detail.notifiedParent`. Optional for the SAME reason as
   * `IdlePty`'s own new optional getters — unreachable by a pre-existing test stub unless its `pty`
   * ALSO implements those getters (nothing is ever judged stale without them), but kept optional anyway
   * for symmetry and so a future minimal stub never needs a dummy no-op just to satisfy the type.
   */
  notifyMcpSilenceParent?: (parentSessionId: string, text: string, taskId: string | null) => { notifiedParent: boolean };
  /**
   * Card d1521fca (MCP-silence watchdog, MANAGER/LEAD shape — the a7c072c4 incident): deliver an
   * already-built notice to the Platform Lead about `sessionId` (a manager, or the Lead itself — which
   * has no parent to notify). Mirrors SessionService.notifyMcpSilenceLead — reuses the latest still-open
   * Platform board task for this session (never files a second one for a shape change within the same
   * open episode) plus a best-effort live Lead nudge (skipped when `sessionId` IS the live Lead itself).
   * Returns `leadBoardTaskId` so the caller can record it in `mcp_silence_detected`'s own detail — the
   * SAME field a LATER call reads back to find the task to reuse. Optional — see
   * `notifyMcpSilenceParent`'s own doc.
   */
  notifyMcpSilenceLead?: (sessionId: string, text: string) => { leadNotified: boolean; leadBoardTaskId?: string };
  /** Tick cadence; defaults to 60s. Injectable so a test drives tick() directly. */
  intervalMs?: number;
  /**
   * Card 86c9bdbd: "are we near the Claude usage limit?" — defaults to the global awareness record
   * (mirrors Scheduler/PollService/WakeService/EventTriggerService's own `isUsageLimited` seam —
   * scheduler.ts, poll.ts, wake.ts, event-triggers.ts — same shape, same default). Injectable so a test
   * can drive the limit-skip deterministically without ever touching the real on-disk awareness file.
   * The optional 2nd arg is the resolved recency window (ms); a test stub may ignore it.
   */
  isUsageLimited?: (now: Date, recencyWindowMs?: number) => boolean;
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
  "merge_request", "merge_done", "merge_rejected", "merge_cancelled", "merge_landing_started", "merge_landing_aborted",
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
 * MCP-silence watchdog (card d1521fca, tickMcpSilence below) — a live session's own OBSERVED cadence
 * per MCP router (`PtyHost.getMcpRouterCadenceMs`) is multiplied by this factor to derive its
 * STALE threshold, floored at MCP_SILENCE_STALE_FLOOR_MS. Both incidents this watchdog exists for
 * (b5668822, a7c072c4) showed a ~6min cadence; a 3x multiplier (~18min there) is comfortably past
 * ordinary jitter/backoff without waiting unreasonably long to notice a genuine outage. The floor
 * guards a session with an unusually tight observed cadence (e.g. a burst of rapid calls) from
 * tripping on a tiny, harmless gap.
 */
export const MCP_SILENCE_STALE_MULTIPLIER = 3;
export const MCP_SILENCE_STALE_FLOOR_MS = 10 * 60_000;

/**
 * MCP-silence watchdog, ALL-SILENT shape only (card d1521fca): "don't fire on a session that has simply
 * been idle with no turns" — if EVERY established router has gone stale, additionally require this
 * session's own `lastActivity` to be more recent than this bound, or the episode is a long-dormant,
 * nothing-is-wrong session rather than the a7c072c4 shape (a session that WAS actively turning/writing/
 * hooking right up until its MCP traffic stopped). Deliberately generous — this is a floor against
 * ancient dormancy, not a tight "must be busy right now" gate (the ASYMMETRIC shape needs no such gate
 * at all: a fresh sibling router already proves ongoing engagement).
 */
const MCP_SILENCE_ALL_SILENT_MAX_DORMANT_MINUTES = 120;

// @decision d1521fca — tick-lag detection + two-evaluation confirmation exist to kill a real replayed
// false-positive class (9 of 13 sessions flagged on the first tick after a host stall); never drop
// either half, and never derive their windows from a constant disconnected from intervalMs.
export const MCP_SILENCE_LAG_MULTIPLIER = 3;

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
 * Asleep-at-the-Wheel watcher (idle-manager watchdog) — also covers platform (Lead) sessions.
 * @decision 98b3725c — never special-case a Lead as exempt from this idle-watchdog coverage; the manager
 * loop below is reused verbatim (a Lead never parents a worker, so `db.listWorkers`/`tickIdleWorkers`
 * simply see an empty set for it) — it gets the identical watching/snoozed/suppressed policy a manager does.
 *
 * Structural twin of ContextWatcher: each tick, for every LIVE manager OR platform session that is idle
 * (`busy=false` + `lastActivity` older than the project's `idleNudgeMinutes`) with NO live workers, it
 * injects a ONE-TIME-per-episode busy-gated nudge asking it WHY it is idle and to `idle_report` its
 * state (then resume the loop). Agent-in-the-loop: Loom can't know why a manager/Lead is idle, so it
 * asks; it answers over MCP (`idle_report` — on the orchestration router for a manager, the platform
 * router for a Lead, both backed by the same `SessionService.recordIdleReport`).
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
 * @decision b9d479b0 — never re-implement worker-idle classification here: `tickIdleWorkers` below must
 * re-fire the SAME reconciled worker→manager nudge `SessionService.notifyManagerOfIdleWorker` already
 * fires once on the busy→false edge (via the injected `notifyIdleWorker`), never a second drifted copy.
 *
 * @decision 99d41588 — STALE-REQUEST coverage (`tickStaleRequests` below) must stay keyed on
 * `questions.created_at` alone, never any session's idle/suppression state — a manager correctly
 * own-Request-suppressed would otherwise never get an `idle_escalated` and could go unescalated forever.
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
  /**
   * Card d1521fca (MCP-silence watchdog): one entry per session CURRENTLY in a notified MCP-silence
   * episode — `shape`/`staleRouters` identify the episode so a CHANGED shape (e.g. a second router also
   * going stale) re-notifies as a new episode rather than being silently absorbed into the old one. Same
   * in-memory, pruned-to-live-sessions pattern as `lastSkipReason`/`lastIdleScanAt` above — a daemon
   * restart mid-episode just re-notifies once more, the same accepted tradeoff this file already makes
   * elsewhere (see `mcp_silence_detected`'s own doc, `packages/shared/src/types.ts`). Deleted once the
   * session's own routers recover (clears the episode so a FUTURE recurrence notifies again).
   */
  private mcpSilenceEpisodes = new Map<string, { shape: "asymmetric" | "all-silent"; staleRouters: string[] }>();
  /**
   * Card d1521fca, Code Review round (see the module-level decision note above) — a
   * session newly seen stale sits HERE, never notified, until a LATER evaluation at least
   * `MCP_SILENCE_STALE_FLOOR_MS` after `firstSeenAt` still finds it stale (see `evaluateMcpSilence`).
   * Cleared for a session the moment it's no longer stale at all (recovered before confirming) OR on a
   * detected tick lag (see `lastTickAt` below) — a lagged tick's own staleness readings are unreliable,
   * so any "first seen stale" timestamp recorded before the lag must not count toward confirmation
   * after it. Same in-memory, pruned-to-live-sessions pattern as its siblings above.
   */
  private mcpSilencePending = new Map<string, { shape: "asymmetric" | "all-silent"; staleRouters: string[]; firstSeenAt: number }>();
  /** Card d1521fca — epoch ms of the previous `tick()` call, for lag detection; `null` before the first
   *  tick, which is never treated as lagged (nothing to compare against). */
  private lastTickAt: number | null = null;
  /** Card d1521fca — while `nowMs` is before this, `tickMcpSilence` skips its ENTIRE sweep (a detected
   *  tick lag's grace period); `0` means no grace in effect. */
  private mcpSilenceGraceUntilMs = 0;
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

    // Card d1521fca (MCP-silence watchdog, Code Review round — see this file's module-level decision
    // note): detect THIS daemon's own tick lag BEFORE any other tick() work — a stall severe enough to
    // starve the host also starves setInterval, so a big gap since the last tick means every session's
    // apparent MCP staleness this tick is unreliable, not just real.
    const intervalMs = this.deps.intervalMs ?? 60_000;
    if (this.lastTickAt !== null && nowMs - this.lastTickAt > intervalMs * MCP_SILENCE_LAG_MULTIPLIER) {
      this.mcpSilencePending.clear();
      this.mcpSilenceGraceUntilMs = nowMs + MCP_SILENCE_STALE_FLOOR_MS;
      // eslint-disable-next-line no-console
      console.log(`[idle-watcher] tick lag detected (${nowMs - this.lastTickAt}ms since last tick, interval=${intervalMs}ms) — MCP-silence evaluation paused until ${new Date(this.mcpSilenceGraceUntilMs).toISOString()}`);
    }
    this.lastTickAt = nowMs;

    // Card 86c9bdbd: the SAME daemon-global signal worker_spawn's own refusal reads
    // (isLikelyNearClaudeUsageLimit + the SAME resolveConfig recencyWindowMs — see
    // sessions/service.ts's worker_spawn usage-limit check) — no second notion of "usage-limited".
    // Computed ONCE per tick (not per manager): the signal is a single daemon-global file, not
    // per-project, so re-deriving it per manager would be wasted work for the same answer.
    // `this.deps.isUsageLimited` is the SAME injectable seam Scheduler/PollService/WakeService/
    // EventTriggerService already use (see IdleWatcherDeps' own doc) — defaults to the real awareness
    // record, so production behavior is unchanged; a test can drive it deterministically instead.
    const usageRecencyWindowMs = resolveConfig(undefined, db.getPlatformConfig()).platform.rateLimit.recencyWindowMs;
    const usageLimited = (this.deps.isUsageLimited ?? isLikelyNearClaudeUsageLimit)(now, usageRecencyWindowMs);

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
      // Card 86c9bdbd: anchor on the LATER of lastIdleNudgeAt (when a nudge was last actually sent) and
      // idleDispositionAt (when the manager last told us 'waiting'/'done' via idle_report) — never
      // lastIdleNudgeAt alone. lastIdleNudgeAt is frozen at the PREVIOUS nudge and is never advanced by
      // idle_report (it means something different elsewhere in this file — see idleForMin below — so it
      // must not be overloaded), so genuine activity the manager produced BEFORE its own idle_report call
      // (e.g. a merge it finished while winding down) used to look identical to activity produced AFTER —
      // both land "after lastIdleNudgeAt" — and wiped a snooze the manager had JUST deliberately set,
      // fully aware of that earlier activity. Comparing against the later of the two anchors means only
      // activity that happens after the manager's own most recent disposition call can still re-arm it.
      const resetAnchor = this.laterIso(state.lastIdleNudgeAt, state.idleDispositionAt);
      if (resetAnchor && this.producedActivitySince(m.id, resetAnchor)) {
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

      // Card 86c9bdbd, DoD-2: while the account is likely near a Claude usage limit, worker_spawn would
      // refuse anyway — nudging "pick up the next task NOW" just burns another manager turn on an
      // already-exhausted allowance and invites exactly that refused retry. Skip silently, mirroring the
      // human-paused skip above (same "global off-switch" shape, including suppressing the escalate-on-
      // unanswered-cap branch below — a human already knows their own usage is capped). logSkipIfChanged
      // rate-limits this to ONE log line per manager per transition INTO this reason, not one per tick.
      if (usageLimited) { this.logSkipIfChanged(m.id, "usage-limited"); continue; }

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
      // (sessions/service.ts) so the two stay consistent.
      // @decision 788274a9 — `held` is the SOLE owner brake, checked in ANY column; never infer it from a
      // card's title text — a legitimately-titled card starting with a hold-like word is a false positive.
      //
      // `deferred` is the manager's OWN sequencing marker (orthogonal to `held`, never checked by
      // worker_spawn) — discounted from the count the same way, so a manager's deliberate defer never
      // triggers a recurring idle nudge. The REVIEW lane is ALSO discounted: a card there is awaiting the
      // manager's OWN merge review, not dispatchable work — role-resolved via columnKeyForRole (never a
      // hardcoded "review" key) so a project with renamed/reordered columns still identifies it correctly.
      // Likewise a card carrying a PENDING (unanswered) connected owner Request (db.listQuestionsForTask,
      // the same taskId→questions linkage tasks_get's connected-requests summary and task_requests_list
      // use) is blocked on the owner, not the manager — discounted the same way; a card whose request is
      // already answered/consumed is NOT discounted (it's actionable again).
      // @decision a193398f — the board scan below is throttled per-manager (never affects WHETHER a nudge
      // fires, only how often it's re-derived); never use IDLE_SCAN_THROTTLE_MINUTES unconditionally — floor
      // it at this manager's own `idleMinutes`, or a short-configured project's cadence gets stretched.
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
      // cards at all) still nudges — the manager should `idle_report 'done'`.
      // @decision b9d479b0 — a live STRANDED worker must not be re-silenced by this skip even when every
      // other card is non-actionable.
      //
      // @decision c90e9525 — neither may an undocumented manual deferral
      // (no `deferredReason` recorded) — both stay independently actionable here.
      //
      // @decision 8e87f3b5 — never short-circuit the moment a session has its own pending Request; fold
      // `hasOwnPendingRequest` into this "nothing else actionable" skip instead, so other actionable board
      // work still nudges. Never let the escalate-on-unanswered-cap branch be gated by this predicate.
      const nothingElseActionable =
        strandedWorkers.length === 0 && !hasReviewCards && openCards.length === 0 && undocumentedManualDeferrals.length === 0;
      if (nothingElseActionable && (nonTerminal.length > 0 || hasOwnPendingRequest)) {
        // Card cdd10965's first-party specimen: a truly-empty board parked ONLY on the session's own
        // pending owner Request (cb56cf80's original carve-out) is diagnostically distinct from "real
        // cards exist but none of them are actionable" — name the two apart rather than folding both into
        // one generic "nothing-actionable".
        const reason = nonTerminal.length === 0 && hasOwnPendingRequest ? "own-pending-request" : "nothing-actionable";
        // Card 275ac184: capture whether this is a fresh episode BEFORE logSkipIfChanged overwrites the
        // tracker (it doesn't return that itself) — the board_quiet_cause event fires exactly once per
        // quiet EPISODE, on the transition INTO this reason, never once per tick for a board that stays
        // quiet for the same reason across many ticks.
        const isNewQuietEpisode = this.lastSkipReason.get(m.id) !== reason;
        this.logSkipIfChanged(m.id, reason);
        if (isNewQuietEpisode) this.emitQuietBoardCauseEvent(m.id, m.projectId, nowIso, reason, nonTerminal, reviewKey, excludedColumnKeys, parkedKey, isPlatform, hasPendingQuestion);
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

    this.tickIdleWorkers(nowMs, nowIso, usageLimited);
    this.tickAnsweredStuckQuestions(nowMs);
    this.tickStaleRequests(nowMs, nowIso);
    this.tickMcpSilence(nowMs);
  }

  /**
   * @decision 275ac184 — priority order is FIXED, first-match-wins: `ownerRequest → ownerHeld →
   * managerReview → managerDeferred → deadEndLane → leadOwnerFlow`. Never reorder it, and never treat a
   * non-zero `unknown` as a real cause — it means some card matched none of the six predicates.
   */
  private causeForQuietTask(
    t: Task,
    reviewKey: string | undefined,
    excludedColumnKeys: ReadonlySet<string>,
    parkedKey: string | undefined,
    isPlatform: boolean,
    hasPendingQuestion: (taskId: string) => boolean,
  ): "ownerRequest" | "ownerHeld" | "managerReview" | "managerDeferred" | "deadEndLane" | "leadOwnerFlow" | "unknown" {
    if (hasPendingQuestion(t.id)) return "ownerRequest";
    if (t.held === true) return "ownerHeld";
    if (t.columnKey === reviewKey) return "managerReview";
    if (t.deferred === true && t.deferredStuck !== true) return "managerDeferred";
    if (excludedColumnKeys.has(t.columnKey)) return "deadEndLane";
    if (isPlatform && t.columnKey === parkedKey) return "leadOwnerFlow";
    return "unknown";
  }

  /**
   * The RELEASE computation — deliberately INDEPENDENT of causeForQuietTask's priority-ordered LABEL
   * above. A card can be labeled `ownerRequest` there (request checked first) while ALSO being held or
   * deferred — this asks the narrower, honest question the label alone can't answer: is the pending
   * Request the card's ONE AND ONLY blocking condition, such that answering it TODAY would actually make
   * the card actionable? This is the mechanism behind the card's own fleet-wide finding — "answering all
   * N pending Requests here would release ZERO cards" — a card that's ALSO deferred stays blocked no
   * matter what the Request's answer is.
   */
  private isSoleBlockerPendingRequest(
    t: Task,
    excludedColumnKeys: ReadonlySet<string>,
    parkedKey: string | undefined,
    isPlatform: boolean,
    hasPendingQuestion: (taskId: string) => boolean,
  ): boolean {
    return hasPendingQuestion(t.id)
      && t.held !== true
      && (t.deferred !== true || t.deferredStuck === true)
      && !excludedColumnKeys.has(t.columnKey)
      && !(isPlatform && t.columnKey === parkedKey);
  }

  /**
   * Card 275ac184 — emits the `board_quiet_cause` event exactly once per quiet episode (caller already
   * gated on the reason having just CHANGED into "nothing-actionable"/"own-pending-request"). Builds the
   * mutually-exclusive `causeCounts` partition (causeForQuietTask above) over every non-terminal card, the
   * `ownerBlocked`/`selfParked` roll-ups + coarse `classification`, and the RELEASE SET (isSoleBlockerPendingRequest
   * above): for each pending Request linked to a non-terminal card, the card id(s) it would ACTUALLY
   * release if answered today. `db.listPendingQuestionsWithTaskId` is ONE batched query for the whole
   * project (never a per-card round trip) — the legacy 8-char task-id-PREFIX matching mirrors
   * listQuestionsForTask/listPendingQuestionTaskIds exactly (see that method's own doc).
   */
  private emitQuietBoardCauseEvent(
    managerId: string,
    projectId: string,
    nowIso: string,
    reason: "nothing-actionable" | "own-pending-request",
    nonTerminal: Task[],
    reviewKey: string | undefined,
    excludedColumnKeys: ReadonlySet<string>,
    parkedKey: string | undefined,
    isPlatform: boolean,
    hasPendingQuestion: (taskId: string) => boolean,
  ): void {
    const { db } = this.deps;
    const causeCounts = {
      ownerRequest: 0, ownerHeld: 0, managerReview: 0, managerDeferred: 0, deadEndLane: 0, leadOwnerFlow: 0, unknown: 0,
    };
    const soleBlockerTaskIds = new Set<string>();
    for (const t of nonTerminal) {
      const cause = this.causeForQuietTask(t, reviewKey, excludedColumnKeys, parkedKey, isPlatform, hasPendingQuestion);
      causeCounts[cause]++;
      if (this.isSoleBlockerPendingRequest(t, excludedColumnKeys, parkedKey, isPlatform, hasPendingQuestion)) soleBlockerTaskIds.add(t.id);
    }
    const ownerBlocked = causeCounts.ownerRequest + causeCounts.ownerHeld;
    const selfParked = causeCounts.managerReview + causeCounts.managerDeferred + causeCounts.deadEndLane + causeCounts.leadOwnerFlow;
    const classification: "starved-on-owner" | "self-parked" | "mixed" | "session-blocked" | "none" =
      reason === "own-pending-request" ? "session-blocked"
      : ownerBlocked > 0 && selfParked === 0 ? "starved-on-owner"
      : selfParked > 0 && ownerBlocked === 0 ? "self-parked"
      : ownerBlocked > 0 && selfParked > 0 ? "mixed"
      : "none"; // defensive — unreachable: reason==="nothing-actionable" implies nonTerminal.length>0, and
                // openCards.length===0 there already proves ownerBlocked+selfParked>0 (every card matched)

    const releaseByQuestion = new Map<string, string[]>();
    const questionIds = new Set<string>();
    if (causeCounts.ownerRequest > 0) {
      const nonTerminalIds = new Set(nonTerminal.map((t) => t.id));
      for (const row of db.listPendingQuestionsWithTaskId(projectId)) {
        const matchedTaskIds = row.taskId.length === 8
          ? nonTerminal.filter((t) => t.id.startsWith(`${row.taskId}-`)).map((t) => t.id)
          : nonTerminalIds.has(row.taskId) ? [row.taskId] : [];
        if (matchedTaskIds.length === 0) continue; // this Request isn't linked to a card on THIS board's non-terminal set
        questionIds.add(row.id);
        const releasedTaskIds = matchedTaskIds.filter((id) => soleBlockerTaskIds.has(id));
        if (releasedTaskIds.length > 0) releaseByQuestion.set(row.id, [...(releaseByQuestion.get(row.id) ?? []), ...releasedTaskIds]);
      }
    }
    if (causeCounts.unknown > 0) {
      // eslint-disable-next-line no-console
      console.log(`[idle-watcher] board_quiet_cause for ${managerId}: ${causeCounts.unknown} card(s) matched NO known cause — investigate`);
    }
    db.appendEvent({
      id: randomUUID(), ts: nowIso, managerSessionId: managerId, kind: "board_quiet_cause",
      detail: {
        reason, totalNonTerminal: nonTerminal.length, causeCounts, ownerBlocked, selfParked, classification,
        questionIds: [...questionIds],
        releasable: [...releaseByQuestion.entries()].map(([questionId, taskIds]) => ({ questionId, taskIds })),
      },
    });
    // eslint-disable-next-line no-console
    console.log(`[idle-watcher] board_quiet_cause ${managerId} reason=${reason} classification=${classification} causeCounts=${JSON.stringify(causeCounts)} releasable=${releaseByQuestion.size}`);
  }

  /**
   * @decision 99d41588 — never gate this watchdog on manager idle/suppression state; keep it keyed on
   * `questions.created_at` alone, and never read or mutate `idle_nudge_state` from here — the two must
   * stay independent, or a manager correctly own-Request-suppressed could go permanently unescalated.
   *
   * `Db.listStalePendingQuestions` is called with `beforeIso=now` (trivially true of any still-pending
   * row) rather than a precomputed cutoff, because the actual age THRESHOLD is per-project
   * (`orchestration.staleRequestMinutes`) — one global cutoff can't do that filtering, so it's applied
   * here per-row instead, against each row's own project's resolved config. Skips a Request whose project
   * is gone (defensive/TOCTOU) or which has the watchdog disabled (`staleRequestMinutes === 0`), or whose
   * age hasn't yet crossed that project's threshold.
   *
   * `Db.markQuestionEscalated`'s own guarded UPDATE (`state='pending' AND escalated_at IS NULL`) is what
   * makes this fire EXACTLY ONCE per Request — see the decision record for why no "cleared" event exists.
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
   * Answered-stuck-question watchdog: a `questions` row the human answered
   * (`POST /api/questions/:id/answer`) but the asking manager never `question_pull`ed, stuck past
   * ANSWERED_QUESTION_STUCK_MINUTES, re-nudges that MANAGER — never the human, who already answered and
   * would only see noise.
   * @decision 8701bdbb — never route this re-nudge to the exact asking session id: mirrors the
   * recycle-reparenting precedent, so a recycle successor (already reparented via `reparentQuestions`)
   * is still reached.
   * @decision f88e91f0 — resolve it instead by AGENT LINEAGE (`db.getLiveSessionForAgent`, whoever is
   * CURRENTLY live for the asker's agent), so a fresh non-recycle respawn is also reached.
   *
   * Skips silently when there's no live session for that agent, it isn't a manager, is human-paused, is
   * rate-limited/parked (it'll auto-resume on its own), or has itself flagged non-'watching' via
   * idle_report — reusing the SAME idle-nudge-state policy the manager idle loop above reads. Nudged
   * EXACTLY ONCE per answered→still-answered window via the in-memory `nudgedAnsweredQuestions` Set (no
   * schema change): pruned the moment a question leaves 'answered', so a future re-answer isn't silenced
   * by a stale entry.
   *
   * ⚠️ Its audience for the appended `requestAnsweredTriggerNotice` pointer (card c07b9ab4) is narrower
   * than the answer route's own nudge: only a LIVE session with `role === "manager"` is ever reached
   * here (see the skip conditions above) — fine for the pointer's purpose, since a manager is who acts
   * on a deferred card, but worth stating rather than leaving implicit.
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

      // Card c07b9ab4: append the SAME request-answered deferred-trigger appendix the initial
      // answer-time nudge carries (see requestAnsweredTriggerNotice's own doc) — this re-nudge fires
      // EXACTLY when that first appendix was missed (the watchdog's own firing condition is "no
      // question_pull yet"), so it is the one delivery that most needs the pointer. `q.projectId` comes
      // straight off the full Question row (db.ts's toQuestion), same as the answer route's
      // `updated.projectId` — no narrower projection here to work around.
      const msg = `[loom:answered-stuck] Your decision "${q.title}" was answered a while ago but you haven't pulled it — call question_pull to fetch it.` +
        requestAnsweredTriggerNotice(db, q.projectId, q.id);
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
   * worker or its owning manager is human-paused, the worker isn't actually alive, the account is likely
   * near a Claude usage limit (card bf4c9cf5 — a worker re-nudge spends a turn of an exhausted allowance
   * exactly like the manager nudge card 86c9bdbd already suppresses; THE SAME `usageLimited` value
   * computed once per tick() above is passed in here rather than re-derived, so there is only ever one
   * notion of "usage-limited" per tick), or the project disabled it (`idleWorkerMinutes === 0`).
   * Otherwise re-nudges once per `idleWorkerMinutes` window via `notifyIdleWorker` — never re-implementing
   * its reconciliation (board card 99efaab3 requirement).
   */
  private tickIdleWorkers(nowMs: number, nowIso: string, usageLimited: boolean): void {
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
      // Card bf4c9cf5: mirrors the manager loop's own usage-limit skip (card 86c9bdbd) — a worker re-nudge
      // during the limit just burns another turn of an already-exhausted allowance.
      if (usageLimited) continue;
      if (!pty.isAlive(w.id)) continue;

      const state = db.getIdleNudgeState(w.id);
      if (!state) continue;
      const lastActivityMs = Date.parse(w.lastActivity);
      const lastNudgeMs = state.lastIdleNudgeAt ? Date.parse(state.lastIdleNudgeAt) : 0;
      const idleSinceMs = Math.max(lastActivityMs, lastNudgeMs);
      const idleForMin = (nowMs - idleSinceMs) / 60_000;
      if (idleForMin < idleWorkerMin) continue;

      // @decision 2ff893f3 — ONLY "suppressed-mid-first-turn" skips the stamp, never a plain "none" —
      // a pre-existing "none" kind (not-stranded/parked-gate/…) keeps its old unconditional pacing.
      const outcome = this.deps.notifyIdleWorker(w.id);
      if (outcome === "suppressed-mid-first-turn") { this.logSkipIfChanged(w.id, "worker-notice-suppressed"); continue; }
      db.recordIdleNudge(w.id, nowIso); // stamp last_idle_nudge_at (paces the re-nudge; unanswered unused for workers)
      // eslint-disable-next-line no-console
      console.log(`[idle-watcher] re-nudged idle-unreported worker ${w.id} (~${Math.round(idleForMin)}m idle)`);
    }
  }

  /**
   * MCP-silence watchdog — a HEALTH check, not a "nothing to do" check: independent of the idle-nudge
   * state machine above (idleNudgeMinutes, snooze/suppress policy, usage-limit skip), so a manager that
   * correctly snoozed its idle nudge is still checked.
   *
   * GRACE: if `nowMs` is still inside a post-lag grace window (`mcpSilenceGraceUntilMs`, armed by
   * `tick()`'s own lag detection), the ENTIRE sweep is skipped for this tick.
   *
   * Covers every live worker (notify its parent manager) and every live manager/platform session
   * (notify the Platform Lead — it has no parent). Prunes `mcpSilenceEpisodes`/`mcpSilencePending` to
   * currently-live session ids first, mirroring `lastIdleScanAt`/`lastSkipReason`'s own pattern.
   *
   * @decision d1521fca — never drop the grace-window skip or let a confirmation-ladder worsening
   * short-circuit it; either one alone reproduces the replayed false positive (9 of 13 live sessions
   * flagged on one post-stall tick).
   */
  private tickMcpSilence(nowMs: number): void {
    if (nowMs < this.mcpSilenceGraceUntilMs) return;
    const { db } = this.deps;
    const workers = db.listLiveWorkers();
    const managers = db.listLiveManagers();
    const platforms = db.listLivePlatformSessions();
    const liveIds = new Set<string>([...workers.map((w) => w.id), ...managers.map((m) => m.id), ...platforms.map((p) => p.id)]);
    for (const id of this.mcpSilenceEpisodes.keys()) if (!liveIds.has(id)) this.mcpSilenceEpisodes.delete(id);
    for (const id of this.mcpSilencePending.keys()) if (!liveIds.has(id)) this.mcpSilencePending.delete(id);

    for (const w of workers) this.evaluateMcpSilence(w.id, w.parentSessionId ?? null, w.taskId ?? null, w.lastActivity, w.harness === "codex", nowMs);
    for (const m of managers) this.evaluateMcpSilence(m.id, null, null, m.lastActivity, m.harness === "codex", nowMs);
    for (const p of platforms) this.evaluateMcpSilence(p.id, null, null, p.lastActivity, p.harness === "codex", nowMs);
  }

  /**
   * Classifies `sessionId`'s current MCP-silence state from its own per-router cadence, or `null` if
   * there's nothing established to compare yet (a brand-new session, or one that's never been seen on
   * ≥2 occasions on any router — see `PtyHost.getMcpRouterCadenceMs`'s own doc for why a single sighting
   * has no interval to measure). A router this session has NEVER been seen on at all is never considered
   * — only routers it demonstrably uses are judged "silent", so a role that legitimately mounts only one
   * router never collides with the ASYMMETRIC shape.
   *
   * @decision d1521fca — never let `isCodex` exclude the ASYMMETRIC shape too; only ALL-SILENT is
   * excluded for codex (no keepalive evidence there, so a false recycle would discard real work).
   */
  private classifyMcpSilence(sessionId: string, isCodex: boolean, nowMs: number): { shape: "asymmetric" | "all-silent"; staleRouters: string[]; freshRouters: string[]; staleForMs: number } | null {
    const { pty } = this.deps;
    const stale: string[] = [];
    const fresh: string[] = [];
    let maxStaleForMs = 0;
    for (const router of pty.getMcpRoutersSeen?.(sessionId) ?? []) {
      const cadenceMs = pty.getMcpRouterCadenceMs?.(sessionId, router);
      if (cadenceMs === undefined) continue; // only one sighting so far — nothing to compare against yet
      const lastSeen = pty.getMcpRouterLastSeen?.(sessionId, router);
      if (lastSeen === undefined) continue; // defensive — unreachable if cadenceMs resolved above
      const thresholdMs = Math.max(MCP_SILENCE_STALE_FLOOR_MS, MCP_SILENCE_STALE_MULTIPLIER * cadenceMs);
      const sinceMs = nowMs - lastSeen;
      if (sinceMs > thresholdMs) { stale.push(router); maxStaleForMs = Math.max(maxStaleForMs, sinceMs); }
      else fresh.push(router);
    }
    if (stale.length === 0) return null;
    if (isCodex && fresh.length === 0) return null; // ALL-SILENT excluded for codex — see this method's own doc
    return { shape: fresh.length > 0 ? "asymmetric" : "all-silent", staleRouters: stale, freshRouters: fresh, staleForMs: maxStaleForMs };
  }

  /**
   * One session's worth of the MCP-silence watchdog tick — see `tickMcpSilence`'s own doc.
   *
   * Confirmation ladder: a session's FIRST evaluation showing staleness beyond whatever is already
   * confirmed (see "beyond", below) is NEVER notified on that same evaluation — it is recorded in
   * `mcpSilencePending` instead, and only promoted to a notified `mcpSilenceEpisodes` entry once a
   * LATER evaluation, at least `MCP_SILENCE_STALE_FLOOR_MS` after the first such sighting, still shows
   * it. This applies UNIFORMLY whether or not a confirmed episode already exists.
   *
   * "Beyond" is a SUBSET test, not an equality test: if the current stale-router set is a SUBSET of (or
   * equal to) the confirmed episode's own set — things got better or stayed the same, never worse —
   * this is NEVER notified, not even through the ladder; it is quietly reconciled into the confirmed
   * bookkeeping. Only a stale set that is NOT a subset is a candidate for the ladder at all.
   *
   * @decision d1521fca — never skip this ladder for a shape change on an already-confirmed episode, and
   * never notify a stale set that's a subset of the confirmed one; both reproduce a real false-positive
   * (a stall-induced ALL-SILENT re-notify, and a partial recovery announced as new silence).
   */
  private evaluateMcpSilence(
    sessionId: string, parentSessionId: string | null, taskId: string | null, lastActivityIso: string, isCodex: boolean, nowMs: number,
  ): void {
    const { pty, db } = this.deps;
    if (!pty.isAlive(sessionId)) { this.mcpSilenceEpisodes.delete(sessionId); this.mcpSilencePending.delete(sessionId); return; }
    const result = this.classifyMcpSilence(sessionId, isCodex, nowMs);
    if (!result) { this.mcpSilenceEpisodes.delete(sessionId); this.mcpSilencePending.delete(sessionId); return; }
    if (result.shape === "all-silent") {
      const dormantMinutes = (nowMs - Date.parse(lastActivityIso)) / 60_000;
      if (dormantMinutes > MCP_SILENCE_ALL_SILENT_MAX_DORMANT_MINUTES) {
        // Simply idle with no turns — not this watchdog's concern (the ordinary idle-nudge loop above
        // already covers "nothing to do"). See MCP_SILENCE_ALL_SILENT_MAX_DORMANT_MINUTES's own doc.
        this.mcpSilenceEpisodes.delete(sessionId);
        this.mcpSilencePending.delete(sessionId);
        return;
      }
    }
    const sortedStale = [...result.staleRouters].sort();

    const confirmedEpisode = this.mcpSilenceEpisodes.get(sessionId);
    if (confirmedEpisode && sortedStale.every((r) => confirmedEpisode.staleRouters.includes(r))) {
      // The current reading is a SUBSET of (or equal to) the confirmed baseline — never notify, even
      // through the ladder. Any in-flight "worsening beyond this baseline" pending candidate is now
      // moot (whatever it was tracking has itself recovered back to, or below, this baseline).
      this.mcpSilencePending.delete(sessionId);
      const unchanged = sortedStale.length === confirmedEpisode.staleRouters.length
        && sortedStale.every((r, i) => r === confirmedEpisode.staleRouters[i]);
      if (!unchanged) this.mcpSilenceEpisodes.set(sessionId, { shape: result.shape, staleRouters: sortedStale });
      return;
    }

    // Either no confirmed episode yet, or the current reading has something genuinely NEW stale beyond
    // the confirmed baseline — both run through the SAME two-evaluation confirmation ladder.
    const pending = this.mcpSilencePending.get(sessionId);
    if (!pending) {
      this.mcpSilencePending.set(sessionId, { shape: result.shape, staleRouters: sortedStale, firstSeenAt: nowMs });
      return; // first sighting of this (new-beyond-baseline) staleness — wait for a later confirming evaluation
    }
    if (nowMs - pending.firstSeenAt < MCP_SILENCE_STALE_FLOOR_MS) {
      // Still within the confirmation window — keep the ORIGINAL firstSeenAt as the anchor, but track
      // the latest shape/routers so a worsening/changing signal is what actually gets notified once
      // confirmed, not a stale snapshot from the first sighting.
      this.mcpSilencePending.set(sessionId, { shape: result.shape, staleRouters: sortedStale, firstSeenAt: pending.firstSeenAt });
      return;
    }
    // Confirmed: still stale (and still beyond the prior baseline) at least one keepalive period after
    // the first sighting — promote and notify.
    this.mcpSilencePending.delete(sessionId);

    const staleForMin = Math.round(result.staleForMs / 60_000);
    const routerWord = result.staleRouters.length > 1 ? "routes" : "route";
    const whatHappened = result.shape === "asymmetric"
      ? `its loom-${result.staleRouters.join("/")} MCP ${routerWord} went silent ~${staleForMin}+ min ago while its loom-${result.freshRouters.join("/")} ${result.freshRouters.length > 1 ? "routes" : "route"} kept working`
      : `every one of its MCP routes (loom-${result.staleRouters.join(", loom-")}) went silent together ~${staleForMin}+ min ago`;

    let notifiedParent: boolean | undefined;
    let leadNotified: boolean | undefined;
    let leadBoardTaskId: string | undefined;
    if (parentSessionId) {
      const text = `[loom:mcp-silence] worker ${sessionId}${taskId ? ` (task ${taskId})` : ""}: ${whatHappened}, even though the pty is still live. This looks like an MCP connection wedge, not a worker that's merely idle — it will likely not self-recover. Check worker_transcript, and if it's genuinely stuck, worker_recycle it (a fresh process gets a fresh MCP connection).`;
      notifiedParent = this.deps.notifyMcpSilenceParent?.(parentSessionId, text, taskId)?.notifiedParent;
    } else {
      const text = `[loom:mcp-silence] session ${sessionId}: ${whatHappened}, even though the pty is still live. This looks like an MCP connection wedge, not a session that's merely idle — it will likely not self-recover on its own. Check its live screen and, if genuinely stuck, session_stop + respawn (or recycle, for a manager).`;
      const outcome = this.deps.notifyMcpSilenceLead?.(sessionId, text);
      leadNotified = outcome?.leadNotified;
      leadBoardTaskId = outcome?.leadBoardTaskId;
    }
    this.mcpSilenceEpisodes.set(sessionId, { shape: result.shape, staleRouters: sortedStale });
    // Mirrors `worker_stuck`'s own convention: a WORKER-shape event carries its owning manager's id as
    // `managerSessionId` with `workerSessionId` set to the silent session itself; a MANAGER/LEAD-shape
    // event (no parent) carries the silent session's own id as `managerSessionId`, `workerSessionId`
    // left absent. `notifiedParent`/`leadNotified`/`leadBoardTaskId` (Code Review round) are each
    // omitted (never a fabricated `false`/absent placeholder) when their shape didn't apply — e.g. a
    // WORKER-shape event never carries `leadBoardTaskId`, since no Lead task was ever filed for it.
    db.appendEvent({
      id: randomUUID(), ts: new Date(nowMs).toISOString(),
      managerSessionId: parentSessionId ?? sessionId, workerSessionId: parentSessionId ? sessionId : undefined, taskId,
      kind: "mcp_silence_detected",
      detail: {
        shape: result.shape, staleRouters: sortedStale, freshRouters: result.freshRouters, staleForMs: result.staleForMs,
        ...(notifiedParent !== undefined ? { notifiedParent } : {}),
        ...(leadNotified !== undefined ? { leadNotified } : {}),
        ...(leadBoardTaskId !== undefined ? { leadBoardTaskId } : {}),
      },
    });
    // eslint-disable-next-line no-console
    console.log(`[idle-watcher] mcp-silence ${sessionId} shape=${result.shape} stale=${sortedStale.join(",")} fresh=${result.freshRouters.join(",")} staleForMin=${staleForMin}`);
  }

  /** True if the manager appended a genuine orchestration-work event strictly after `sinceIso`. */
  private producedActivitySince(managerId: string, sinceIso: string): boolean {
    for (const e of this.deps.db.listEvents(managerId)) {
      if (e.ts > sinceIso && ORCH_ACTIVITY_KINDS.has(e.kind)) return true;
    }
    return false;
  }

  /** The later of two nullable ISO timestamps (string comparison is safe for ISO-8601 UTC); null iff both are. */
  private laterIso(a: string | null, b: string | null): string | null {
    if (!a) return b;
    if (!b) return a;
    return a > b ? a : b;
  }

  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
