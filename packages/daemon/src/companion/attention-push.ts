/**
 * Loom Companion — the `attention-push` WATCHER (Companion Capability & Permission-Lever Framework §4).
 *
 * Deliberately NOT a capability-registry lever (companion/capabilities.ts): it never registers an MCP tool,
 * so there is no `register()`/`CompanionCapability` descriptor for it in `COMPANION_CAPABILITIES`. Instead
 * it is a daemon-owned, per-companion, per-tick WATCHER — a sibling of `CompanionHeartbeatWatcher` /
 * `CompanionReminderWatcher` — armed/disarmed by `CompanionController` exactly like those two. It still
 * reads its grant through the SAME `resolveCompanionGrant(db, sessionId, "attention-push")` chokepoint
 * (companion/capabilities.ts) every tick, so it is default-off + per-project-scoped identically to every
 * other lever, WITHOUT being mounted by `registerCompanionCapabilities`.
 *
 * MECHANISM: a tail-poll over the durable `orchestration_events` log keyed on `Db.listEventsSince`'s `seq`
 * cursor — NOT sqlite's own `rowid` (CR-caught correctness bug: rows are hard-deleted by
 * deleteProject/deleteSession, and sqlite REUSES a rowid once the row holding the table's current max is
 * gone, which would silently retire the watermark past a reused id and drop a real alert forever; `seq` is
 * a genuine, never-reused, monotonic column — see its doc in db.ts's SCHEMA). Also NOT the single-slot
 * `Db.setEventListener` the alert-webhook emitter (orchestration/alert-webhook.ts) already occupies — that
 * slot can hold only one subscriber, and this watcher needs its OWN per-session watermark anyway (a
 * listener callback has no natural per-companion cursor). Each tick: resolve the grant, gate on
 * live/not-parked/not-stacking (mirroring the heartbeat's disciplines), union-merge the granted projects'
 * `{alertClasses, digestMinutes}` config, scan new events since the watermark, classify + scope-filter them,
 * then either push each immediately or accumulate into a digest — see `tick()`.
 *
 * DEFAULT-OFF: `resolveCompanionGrant` returns null with no `attention-push` grant row for this session, so
 * an ungranted companion's tick is a single cheap grant lookup and nothing else — no event scan, no push,
 * byte-identical to a world where this watcher doesn't exist. The CompanionController only builds/starts one
 * per session that resolves a grant at all (see controller.ts's `rearmAttentionPushFor`).
 */
import { randomUUID } from "node:crypto";
import type { OrchestrationEvent } from "@loom/shared";
import type { Db } from "../db.js";
import type { HeartbeatPty } from "./heartbeat.js";
import { resolveCompanionGrant, type ResolvedGrantScope } from "./capabilities.js";
import { inAppHomeRoute } from "./in-app.js";

/** The trusted-daemon framing tag — also the marker the no-stacking guard matches in the pending queue
 *  (mirrors HEARTBEAT_TAG/REMINDER_TAG). */
export const ALERT_TAG = "[loom:alert]";

/** The alert-class allowlist (Framework §4's `attention-push` config schema: `alertClasses: string[]`) —
 *  exported so the grants config validator (gateway/server.ts) can reject an unknown/typo'd class at write
 *  time, and so this module's own classify() stays the single source of truth for what's valid. */
export const ATTENTION_ALERT_CLASSES = [
  "merge-gate", "worker-blocked", "worker-crashed", "decision-pending",
  "manager-idle", "context-overflow", "escalation", "usage-limit",
] as const;
export type AttentionAlertClass = (typeof ATTENTION_ALERT_CLASSES)[number];

/** Bounds one tick's tail-scan — a long-idle watermark reads at most this many rows per tick rather than
 *  an unbounded backlog (the injection-exposed-adjacent posture this repo applies to every scan surface). */
const EVENT_TAIL_LIMIT = 200;
/** Digest turn cap (Lead build sequence step 4: "bulleted, cap ~20 + '+N more'"). */
const DIGEST_MAX_LINES = 20;
/** CR fold-in [3]: immediate mode has no per-turn cap by default (unlike digest, which caps at
 *  DIGEST_MAX_LINES) — a single tick finding MORE than this many qualifying events coalesces them into ONE
 *  digest-style turn instead of firing one companion turn (one owner-facing message) PER event, so a fleet
 *  burst can't spam dozens of separate turns from a single tick. */
const IMMEDIATE_BURST_CAP = 10;
/** CR fold-in [5]: a hard cap on one rendered alert line, so an unbounded source field (e.g. question_ask's
 *  `title`, an agent-authored `z.string()` with no length limit) can never produce a pathologically long
 *  chat line. Applied once, at the end of `alertLine`, regardless of which case produced the text. */
const ALERT_LINE_MAX_CHARS = 200;
/** CR fold-in [5]: a tighter cap on the title specifically (nested inside the quoted "..." in the
 *  decision-pending line) — keeps a long title from dominating the line before the overall cap even
 *  applies. */
const ALERT_TITLE_MAX_CHARS = 100;

/** Truncate `s` to at most `maxChars`, appending an ellipsis marker when cut. A no-op when already short
 *  enough — never lengthens or otherwise mutates a line that's already within bounds. */
function truncateText(s: string, maxChars: number): string {
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
}

/** Frame a single immediate alert as a clearly-marked, no-stacking-guarded turn. */
export function framedAlert(text: string): string {
  return `${ALERT_TAG} ${text}`;
}

/** Frame a bundled digest turn — bulleted, capped at DIGEST_MAX_LINES with a "+N more" tail. Also reused by
 *  the immediate-mode burst cap (IMMEDIATE_BURST_CAP) for its own coalesced turn — same shape, different
 *  caller. */
export function framedDigest(lines: string[]): string {
  const shown = lines.slice(0, DIGEST_MAX_LINES);
  const extra = lines.length - shown.length;
  const bullets = shown.map((l) => `• ${l}`).join("\n");
  return `${ALERT_TAG} ${lines.length} alert${lines.length === 1 ? "" : "s"}:\n${bullets}${extra > 0 ? `\n+${extra} more` : ""}`;
}

/**
 * Classify one orchestration event into an `AttentionAlertClass`, or null if it isn't a subscribed signal
 * source (see the build spec's ALERT-CLASS MAP). `detail` is read through a cast — matches every other
 * `detail` consumer in this codebase (attention.ts, alert-webhook.ts). NOTE: `merge_done` is a signal the
 * spec's build sequence names in its SIGNAL SOURCES inventory but the ALERT-CLASS MAP deliberately does NOT
 * map to any class ("merge-gate" lists only merge_rejected/merge_request) — a landed merge is the
 * RESOLUTION of a merge_request, not its own alert (matches web/attention.ts's latestMerge pairing, which
 * treats merge_done as clearing the pending state rather than raising a new one) — confirmed correct by
 * Code Review, KEEP AS-IS.
 */
export function classify(kind: string, detail: Record<string, unknown> | undefined): AttentionAlertClass | null {
  switch (kind) {
    case "merge_rejected":
    case "merge_request":
      return "merge-gate";
    case "worker_stuck":
      return "worker-blocked";
    case "worker_report":
      return detail?.status === "blocked" ? "worker-blocked" : null;
    case "worker_exited_without_report":
    case "session_recovery_abandoned":
      return "worker-crashed";
    case "question_asked":
      return "decision-pending";
    case "idle_escalated":
      return "manager-idle";
    case "idle_report":
      return detail?.state === "done" ? "manager-idle" : null;
    case "context_escalated":
      return "context-overflow";
    case "platform_escalate":
      return "escalation";
    case "session_rate_limited":
      return "usage-limit";
    default:
      return null;
  }
}

/** Render ONE terse chat line for a classified event: `{project}: <what> — <who>` (8-char id slices),
 *  bounded to ALERT_LINE_MAX_CHARS (CR fold-in [5] — an unbounded source field, e.g. question_ask's title,
 *  must never produce a pathologically long line). */
export function alertLine(e: OrchestrationEvent, alertClass: AttentionAlertClass, projectName: string): string {
  const detail = e.detail ?? {};
  const w8 = e.workerSessionId ? `w:${e.workerSessionId.slice(0, 8)}` : null;
  const m8 = `m:${e.managerSessionId.slice(0, 8)}`;
  const task8 = e.taskId ? `task:${e.taskId.slice(0, 8)}` : null;
  const who = [w8 ?? m8, task8].filter((s): s is string => !!s).join(" ");
  let line: string;
  switch (e.kind) {
    case "merge_rejected":
      line = `${projectName}: merge rejected — ${who}`;
      break;
    case "merge_request":
      line = `${projectName}: merge request awaiting review — ${who}`;
      break;
    case "worker_report":
      line = `${projectName}: worker blocked — ${who}`;
      break;
    case "worker_stuck":
      line = `${projectName}: worker stuck${typeof detail.minutesBusy === "number" ? ` (${detail.minutesBusy}m)` : ""} — ${who}`;
      break;
    case "worker_exited_without_report":
      line = `${projectName}: worker exited without report — ${who}`;
      break;
    case "session_recovery_abandoned":
      line = `${projectName}: crash-loop, auto-resume gave up — ${who}`;
      break;
    case "question_asked": {
      const title = typeof detail.title === "string" ? truncateText(detail.title, ALERT_TITLE_MAX_CHARS) : "untitled";
      line = `${projectName}: decision needed — "${title}" (${m8})`;
      break;
    }
    case "idle_escalated":
      line = `${projectName}: manager asleep, unanswered idle nudges — ${m8}`;
      break;
    case "idle_report":
      line = `${projectName}: manager queue drained — ${m8}`;
      break;
    case "context_escalated":
      line = `${projectName}: manager context overflow risk — ${m8}`;
      break;
    case "platform_escalate": {
      const title = typeof detail.title === "string" ? truncateText(detail.title, ALERT_TITLE_MAX_CHARS) : "untitled";
      line = `${projectName}: escalated to platform — "${title}" (${m8})`;
      break;
    }
    case "session_rate_limited":
      line = `${projectName}: usage limit reached, parked — s:${e.managerSessionId.slice(0, 8)}`;
      break;
    default:
      line = `${projectName}: ${alertClass} — ${m8}`;
  }
  return truncateText(line, ALERT_LINE_MAX_CHARS);
}

export interface AttentionPushWatcherDeps {
  db: Db;
  pty: HeartbeatPty;
  /** The bound companion session id this watcher pushes into (an EXISTING long-lived session). */
  sessionId: string;
  /** Watcher tick cadence in ms; defaults to 60s (mirrors the other per-tick watchers). */
  tickMs?: number;
}

type EventWithSeq = OrchestrationEvent & { seq: number };
type Qualifying = { e: EventWithSeq; cls: AttentionAlertClass; projectName: string };

export class AttentionPushWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The tail-poll cursor — every event with seq <= this has been examined. Seeded on start() from the
   *  durable log (own prior pushes, or a fresh baseline); advanced as pushes/flushes land. Tracks
   *  `orchestration_events.seq` (a never-reused monotonic column), NEVER sqlite's own rowid — see the
   *  module doc for why rowid is unsafe here. */
  private watermark = 0;
  /** Epoch ms of the last digest flush; null until the first flush (digest mode only). */
  private lastDigestFlushAt: number | null = null;
  /** Defer-once-per-streak tracking (mirrors the heartbeat's deferredSinceLastFire — see its doc for the
   *  bounded-log-growth rationale). Cleared on any real push (immediate or digest flush). */
  private deferredSinceLastPush = false;

  constructor(private deps: AttentionPushWatcherDeps) {}

  /**
   * One trigger pass. Conservative order: grant → live → session exists → not parked → not stacking →
   * config → scan → classify/scope-filter → push. Never throws (the interval swallows anyway; the
   * controller's caller also wraps every tick — belt and suspenders, matching the sibling watchers).
   */
  tick(now: Date = new Date()): void {
    const { db, pty, sessionId } = this.deps;

    // DEFAULT-OFF fast path: no grant ⇒ one cheap lookup, nothing else (no event scan, no db.getSession).
    const scope = resolveCompanionGrant(db, sessionId, "attention-push");
    if (!scope) return;

    // Not live → SKIP (do NOT resume a stopped companion just to alert it). Retry next tick, no event.
    if (!pty.isAlive(sessionId)) return;

    const session = db.getSession(sessionId);
    if (!session) return; // the companion session row is gone — nothing to push to.

    // Rate-limit PARKED → DEFER (respect the park; don't enqueue → no spam). Watermark untouched (the whole
    // tick bails BEFORE reading any events), so the next non-deferred tick re-scans from the same point.
    if (session.rateLimitedUntil != null) {
      this.deferOnce(now, { reason: "rate-limited", until: session.rateLimitedUntil });
      return;
    }
    // No-stacking: a prior unconsumed [loom:alert] turn → don't stack a second. Same watermark-preserving
    // bail as the park branch above.
    if (pty.getPending(sessionId).some((t) => t.startsWith(ALERT_TAG))) {
      this.deferOnce(now, { reason: "pending" });
      return;
    }

    const { alertClasses, digestMinutes } = this.resolveConfig(scope);
    if (alertClasses.size === 0) return; // nothing subscribed (no config set on any granted project) — no-op.

    const scanned = db.listEventsSince(this.watermark, EVENT_TAIL_LIMIT) as EventWithSeq[];
    if (scanned.length === 0) return; // nothing new since the watermark.

    const qualifying: Qualifying[] = [];
    for (const e of scanned) {
      const cls = classify(e.kind, e.detail);
      if (!cls || !alertClasses.has(cls)) continue;
      const projectId = db.getSession(e.managerSessionId)?.projectId;
      if (!projectId || !scope.projectIds.has(projectId)) continue; // out of this grant's scope
      const projectName = db.getProject(projectId)?.name ?? "?";
      qualifying.push({ e, cls, projectName });
    }

    if (digestMinutes > 0) this.tickDigest(now, qualifying, digestMinutes, scanned);
    else this.tickImmediate(now, qualifying, scanned);
  }

  /**
   * Arm the interval. Seeds the watermark from the durable log so a daemon restart never replays history —
   * see `seedWatermark`'s doc.
   */
  start(): void {
    this.seedWatermark();
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.tickMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // ---- internals -------------------------------------------------------------------------------

  /** Union-merge the granted projects' `attention-push` config (Lead fork 4): the union of every granted
   *  project's `alertClasses` (invalid/unknown entries silently dropped — the REST validator already
   *  rejects those at write time; this is defense-in-depth, never throws on a stale/bad row), and the MIN
   *  of every granted project's POSITIVE `digestMinutes` (0/absent excluded from the min — digest mode is
   *  OFF unless at least one granted project opted into it). An empty/absent `alertClasses` on a project
   *  contributes NOTHING to the union (confirmed correct by Code Review, KEEP AS-IS — matches the
   *  framework's default-deny posture: an owner must explicitly opt into the classes they want pushed). */
  private resolveConfig(scope: ResolvedGrantScope): { alertClasses: Set<AttentionAlertClass>; digestMinutes: number } {
    const alertClasses = new Set<AttentionAlertClass>();
    let digestMinutes = 0;
    for (const pid of scope.projectIds) {
      const cfg = scope.configFor(pid) as { alertClasses?: unknown; digestMinutes?: unknown };
      if (Array.isArray(cfg.alertClasses)) {
        // Companion "lead mode" wildcard (companion/capabilities.ts's synthesizeLeadModeScope) — "*" is
        // reachable ONLY through that internal synthesis path (the REST grant-config validator only ever
        // accepts a literal class name), and expands to every currently-known class here rather than
        // being duplicated as a literal list in capabilities.ts (which would drift if a class is ever
        // added/renamed here without a matching edit there).
        if (cfg.alertClasses.includes("*")) {
          for (const c of ATTENTION_ALERT_CLASSES) alertClasses.add(c);
        } else {
          for (const c of cfg.alertClasses) {
            if (typeof c === "string" && (ATTENTION_ALERT_CLASSES as readonly string[]).includes(c)) {
              alertClasses.add(c as AttentionAlertClass);
            }
          }
        }
      }
      if (typeof cfg.digestMinutes === "number" && cfg.digestMinutes > 0) {
        digestMinutes = digestMinutes === 0 ? cfg.digestMinutes : Math.min(digestMinutes, cfg.digestMinutes);
      }
    }
    return { alertClasses, digestMinutes };
  }

  /**
   * Immediate mode: push each qualifying event as its OWN framed turn, oldest-first — UNLESS this single
   * tick found MORE than IMMEDIATE_BURST_CAP qualifying events (CR fold-in [3]), in which case they're
   * coalesced into ONE digest-style turn instead of one companion turn PER event (a fleet burst must not
   * spam dozens of separate owner-facing messages from a single tick — digest mode already caps its bundled
   * turn at DIGEST_MAX_LINES; immediate mode had no equivalent cap before this fold-in).
   *
   * Every row in `scanned` is TERMINAL by the time this runs — a qualifying row is delivered, a
   * non-qualifying row (wrong class or out of scope) is a PERMANENT skip (never re-classifies differently on
   * a later tick) — so the watermark always advances to the LAST SCANNED row's seq, even when `qualifying`
   * is empty. Build-review fix: the prior version only advanced past DELIVERED rows, so a run of
   * ≥EVENT_TAIL_LIMIT consecutive non-qualifying events (routine on a fleet the companion only subscribes a
   * slice of) left `qualifying` permanently empty and the watermark permanently stuck re-scanning the same
   * stalled window — attention-push would go silent forever. Only a TRANSIENT defer (rate-limit park /
   * no-stacking) may hold the watermark, and both of those bail the whole tick BEFORE `scanned` is ever read
   * (see `tick()`) — so every row that reaches this method is unconditionally consumed.
   */
  private tickImmediate(now: Date, qualifying: Qualifying[], scanned: EventWithSeq[]): void {
    if (qualifying.length > IMMEDIATE_BURST_CAP) {
      // No home configured ⇒ fall back to the session's implicit in-app route (always deliverable — see
      // inAppHomeRoute's doc) so this proactive push still lands somewhere instead of chat_reply resolving
      // `no-target`.
      const home = this.deps.db.getCompanionHome(this.deps.sessionId) ?? inAppHomeRoute(this.deps.sessionId);
      const lines = qualifying.map(({ e, cls, projectName }) => alertLine(e, cls, projectName));
      // proactive:true (proactive event-line producer) — a daemon-driven alert push, tagged for the web
      // chat's amber event line.
      this.deps.pty.enqueueStdin(this.deps.sessionId, framedDigest(lines), "system", undefined, home, "agent", undefined, undefined, true);
      this.deferredSinceLastPush = false;
      for (const { e, cls } of qualifying) {
        this.emit(now, "companion_alert_pushed", { sourceSeq: e.seq, alertClass: cls, sourceKind: e.kind });
      }
    } else if (qualifying.length > 0) {
      // Same in-app fallback as the digest branch above.
      const home = this.deps.db.getCompanionHome(this.deps.sessionId) ?? inAppHomeRoute(this.deps.sessionId);
      for (const { e, cls, projectName } of qualifying) {
        // kind:"agent" — a daemon-driven push turn, must land as its own turn (never mashed with a sibling).
        // proactive:true — see the digest branch above.
        this.deps.pty.enqueueStdin(this.deps.sessionId, framedAlert(alertLine(e, cls, projectName)), "system", undefined, home, "agent", undefined, undefined, true);
        this.deferredSinceLastPush = false;
        this.emit(now, "companion_alert_pushed", { sourceSeq: e.seq, alertClass: cls, sourceKind: e.kind });
      }
    }
    this.watermark = scanned[scanned.length - 1]!.seq; // consume the WHOLE scanned window — see doc above.
  }

  /**
   * Digest mode (Lead fork 5, v1 = the RE-SCAN BUFFER): the "buffer" is re-derived from
   * `listEventsSince(watermark)` every tick — there is no separately-persisted buffer, ONE source of truth.
   * A NOT-YET-DUE flush must keep every UN-FLUSHED qualifying row visible for the next re-scan (the
   * accumulating buffer), but — same stall fix as `tickImmediate` — must still consume any non-qualifying
   * rows in the window (permanent skips), or a long run of unsubscribed noise ahead of the qualifying rows
   * would wedge the watermark just as badly. So: a pure non-qualifying window advances past all of it; a
   * not-yet-due window with qualifying rows advances to JUST BEFORE the first qualifying row (seq values are
   * integers and `listEventsSince` is strictly `> watermark`, so that row — and everything after it — is
   * still re-scanned next tick); a DUE flush delivers one bundled turn, records a `companion_alert_pushed`
   * row PER underlying source (not one row per digest — keeps the audit trail as granular as immediate
   * mode; a restart-reseed via `seedWatermark`'s MAX sourceSeq converges correctly either way), then
   * advances past the WHOLE scanned window (qualifying flushed, non-qualifying permanently skipped).
   */
  private tickDigest(now: Date, qualifying: Qualifying[], digestMinutes: number, scanned: EventWithSeq[]): void {
    if (qualifying.length === 0) {
      this.watermark = scanned[scanned.length - 1]!.seq; // pure non-qualifying window — nothing to buffer.
      return;
    }
    const dueFlush = this.lastDigestFlushAt == null || now.getTime() - this.lastDigestFlushAt >= digestMinutes * 60_000;
    if (!dueFlush) {
      this.watermark = qualifying[0]!.e.seq - 1; // consume leading non-qualifying rows; keep the buffer visible.
      return;
    }
    // No home configured ⇒ fall back to the session's implicit in-app route — see tickImmediate's digest
    // branch above.
    const home = this.deps.db.getCompanionHome(this.deps.sessionId) ?? inAppHomeRoute(this.deps.sessionId);
    const lines = qualifying.map(({ e, cls, projectName }) => alertLine(e, cls, projectName));
    // proactive:true — see tickImmediate's digest branch above.
    this.deps.pty.enqueueStdin(this.deps.sessionId, framedDigest(lines), "system", undefined, home, "agent", undefined, undefined, true);
    this.lastDigestFlushAt = now.getTime();
    this.deferredSinceLastPush = false;
    for (const { e, cls } of qualifying) {
      this.emit(now, "companion_alert_pushed", { sourceSeq: e.seq, alertClass: cls, sourceKind: e.kind });
    }
    this.watermark = scanned[scanned.length - 1]!.seq;
  }

  /**
   * Restart-safe watermark seed: the MAX `sourceSeq` across this session's own durable
   * `companion_alert_pushed` events (never replay an alert already pushed), else — a companion that has
   * NEVER pushed one — the current global max event seq (`Db.getMaxEventSeq`), so a brand-new grant fires
   * nothing for pre-existing backlog and only reacts to activity from this point forward. (KNOWN, ACCEPTED
   * per Code Review — a companion that has NEVER pushed AND is re-armed after a restart re-seeds to
   * whatever the CURRENT max is at that moment, not the max at its original start() — a narrow, rare window
   * mirroring the reminder/heartbeat watchers' own conservative-restart posture; not fixed here.)
   */
  private seedWatermark(): void {
    let max = 0;
    for (const e of this.deps.db.listEvents(this.deps.sessionId)) {
      if (e.kind !== "companion_alert_pushed") continue;
      const seq = (e.detail as { sourceSeq?: number } | undefined)?.sourceSeq;
      if (typeof seq === "number" && seq > max) max = seq;
    }
    this.watermark = max > 0 ? max : this.deps.db.getMaxEventSeq();
  }

  /** Emit a `companion_alert_deferred` event AT MOST ONCE per defer streak (bounded log growth — mirrors
   *  the heartbeat/reminder watchers' identical discipline). */
  private deferOnce(now: Date, detail: Record<string, unknown>): void {
    if (this.deferredSinceLastPush) return;
    this.deferredSinceLastPush = true;
    this.emit(now, "companion_alert_deferred", detail);
  }

  private emit(now: Date, kind: "companion_alert_pushed" | "companion_alert_deferred", detail: Record<string, unknown>): void {
    this.deps.db.appendEvent({
      id: randomUUID(), ts: now.toISOString(),
      managerSessionId: this.deps.sessionId, kind, detail,
    });
  }
}
