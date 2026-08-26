/**
 * Loom Companion — the ZERO-REPLY detector (card 48e8d289, split from `dbba993f`'s DoD-4).
 *
 * CAUSE-AGNOSTIC detectability half of the incident that motivated it: a companion session emitted 113
 * turns and called `chat_reply` ZERO times, and the first sign anything was wrong was the owner typing
 * "Hello?" — nothing in the system noticed. Whatever CAUSES a companion to go silent (an MCP tool-list
 * caching gap, a prompt bug, a genuinely-thinking-not-replying stretch that never resolves), this module
 * makes the silence itself VISIBLE instead of relying on a human eventually noticing.
 *
 * The hook is `pty/host.ts`'s existing `onTurnCompleted` (card 343441bd's completed-turn counter),
 * SCOPED to companion sessions — `checkCompanionReplyHealth` is a no-op for any session with no
 * `companion_config` row, so wiring it unconditionally into `onTurnCompleted` (index.ts) is fully
 * additive: every non-companion session's path stays byte-identical. This deliberately reuses the
 * existing per-tick-watcher FAMILY's conventions (idle-watcher.ts, busy-worker-watcher.ts,
 * companion/heartbeat.ts) — a durable once-per-streak event, dedup state that survives a restart — but is
 * itself a stateless function called from a turn-completion hook, not a `setInterval` watcher: there is
 * no natural "tick" for "did this session's turns stop replying", only "a turn just completed".
 *
 * DEFAULT-need-not-be-armed: this runs for every companion session with NO configuration (no cadence to
 * set, unlike the heartbeat) — `enabled` on the companion_config row is the only gate, matching "per
 * ENABLED companion session" in the card's DoD.
 *
 * SURFACING (settled by card 8bda9fc6): this module still deliberately PUSHES nothing to the owner (no
 * chat_reply, no attention-push, no notification) — a silent companion structurally cannot report its own
 * silence, so the companion is exactly the wrong channel. It writes (1) a durable
 * `companion_zero_reply_detected` orchestration event and (2) a `console.warn`, both internal/operational.
 * The OWNER-visible half is a PULL: `buildCompanionReplyStatus` below feeds the dedicated runtime read
 * `GET /api/companion/status[/:sessionId]`, which the web cockpit's companion CHAT panel renders as an
 * alert banner — the surface the owner is already looking at while waiting for the reply that never came.
 * It is deliberately NOT folded into `maskCompanionConfig` (the config-masking edge a human edits and PUTs
 * back): config and runtime telemetry have different lifetimes and must not share a shape.
 */
import { randomUUID } from "node:crypto";
import type { CompanionReplyStatus, OrchestrationEvent } from "@loom/shared";

/**
 * THRESHOLD (card DoD-5 — argued, not defaulted): 113 turns silent (the incident) is absurdly late; 1
 * turn is noise — a companion legitimately takes a turn without replying (reading a heartbeat prompt,
 * running tool calls before it has anything worth saying, a `decisions_list` check that finds nothing
 * new). 20 is chosen as comfortably above ordinary multi-tool-call turns (a companion's normal working
 * set is a handful of tool calls before it either replies or the turn just ends with nothing to say) while
 * catching a genuine stuck streak at roughly 1/6th the depth of the incident that motivated this card —
 * early enough that a human waiting on a reply notices Loom flagged it before they'd think to ask
 * themselves, rather than 113 turns in. It errs toward SENSITIVE: a false-positive here costs a
 * console/event line nobody has to act on; a false-negative reproduces exactly the incident this card
 * exists to catch.
 */
export const DEFAULT_ZERO_REPLY_TURN_THRESHOLD = 20;

/** The slice of Db the health check needs (injectable so the check unit-tests claude-free). */
export interface ReplyWatchDb {
  getCompanionConfig(sessionId: string): { enabled: boolean; lastChatReplyTurnSeq: number | null; zeroReplyAlertTurnSeq: number | null } | undefined;
  getSession(sessionId: string): { turnSeq?: number } | undefined;
  recordCompanionChatReply(sessionId: string, turnSeq: number): void;
  markCompanionZeroReplyAlert(sessionId: string, turnSeq: number): void;
  appendEvent(evt: OrchestrationEvent): void;
}

/**
 * One check pass, called once per completed turn for `sessionId` (from `onTurnCompleted`, AFTER
 * `incrementTurnSeq` has already bumped `session.turnSeq` for the just-completed turn). No-op for any
 * session with no companion_config row, or a disabled one — the ONLY gate, matching "per ENABLED
 * companion session".
 *
 * Lazy baseline: a row whose `lastChatReplyTurnSeq` is NULL (a brand-new companion's first-ever
 * completed turn, or a pre-migration legacy row that backfilled to NULL) is treated as "first
 * observation" — seeded to the session's CURRENT turn_seq and returned early, WITHOUT alerting. This is
 * what keeps an upgraded long-lived companion from instantly tripping the detector on its very first
 * post-migration turn (it would otherwise see turnSeq - NULL as a huge, spurious streak).
 *
 * `console.warn` fires alongside the durable event on every genuine (non-deduped) trip — an operational
 * log line, mirroring the daemon's other swallowed-fault console warnings (e.g. alert-webhook.ts).
 */
export function checkCompanionReplyHealth(
  db: ReplyWatchDb,
  sessionId: string,
  now: Date = new Date(),
  threshold: number = DEFAULT_ZERO_REPLY_TURN_THRESHOLD,
): void {
  const config = db.getCompanionConfig(sessionId);
  if (!config || !config.enabled) return;
  const session = db.getSession(sessionId);
  if (!session) return;
  const turnSeq = session.turnSeq ?? 0;

  if (config.lastChatReplyTurnSeq == null) {
    // First observation for this session — start the clock now, no alert (see the lazy-baseline doc above).
    db.recordCompanionChatReply(sessionId, turnSeq);
    return;
  }

  const turnsSinceLastReply = turnSeq - config.lastChatReplyTurnSeq;
  if (turnsSinceLastReply < threshold) return;

  // Already alerted for THIS streak (no reply has landed since — lastChatReplyTurnSeq is unchanged since
  // the alert was recorded) → stay silent. A reply landing clears zeroReplyAlertTurnSeq back to null
  // (recordCompanionChatReply), so the NEXT streak crossing the threshold alerts again.
  if (config.zeroReplyAlertTurnSeq != null) return;

  db.markCompanionZeroReplyAlert(sessionId, turnSeq);
  console.warn(
    `[companion] session ${sessionId} has completed ${turnsSinceLastReply} turns with zero chat_reply ` +
      `deliveries (threshold ${threshold}) — it may be silently stuck.`,
  );
  db.appendEvent({
    id: randomUUID(),
    ts: now.toISOString(),
    managerSessionId: sessionId,
    kind: "companion_zero_reply_detected",
    detail: { turnsSinceLastReply, threshold, turnSeq },
  });
}

/**
 * The READ side of the same state (card 8bda9fc6 — "give the alert a named reader"). Pure derivation,
 * deliberately colocated with `checkCompanionReplyHealth` above so the two can never drift: the detector
 * decides WHEN to alert, this decides WHAT a reader sees, and both read the same three counters.
 *
 * `alerting` intentionally mirrors the detector's OWN dedup condition (`zeroReplyAlertTurnSeq != null`)
 * rather than recomputing `turnsSinceLastReply >= threshold` — that field is what a landing reply CLEARS
 * (`recordCompanionChatReply`), so it is the one that goes false the instant the companion recovers. A
 * recomputation would keep reading "alerting" for a companion that has just replied, until the next turn.
 *
 * Adds NO persisted state: every input already exists on the `companion_config` row + the session row.
 */
export function buildCompanionReplyStatus(
  row: { sessionId: string; name: string; enabled: boolean; lastChatReplyTurnSeq: number | null; zeroReplyAlertTurnSeq: number | null },
  turnSeq: number,
  threshold: number = DEFAULT_ZERO_REPLY_TURN_THRESHOLD,
): CompanionReplyStatus {
  return {
    sessionId: row.sessionId,
    name: row.name,
    enabled: row.enabled,
    turnSeq,
    lastChatReplyTurnSeq: row.lastChatReplyTurnSeq,
    zeroReplyAlertTurnSeq: row.zeroReplyAlertTurnSeq,
    // null (not 0) with no baseline yet: "the detector has not observed this session" is a different fact
    // from "zero turns have elapsed since a reply", and a reader must be able to tell them apart.
    turnsSinceLastReply: row.lastChatReplyTurnSeq == null ? null : turnSeq - row.lastChatReplyTurnSeq,
    threshold,
    alerting: row.enabled && row.zeroReplyAlertTurnSeq != null,
  };
}
