/**
 * Loom Companion — the ZERO-REPLY detector (card 48e8d289, split from `dbba993f`'s DoD-4).
 *
 * @decision 48e8d289 — cause-agnostic: detects a companion whose turns stop producing `chat_reply` (the
 * incident: 113 silent turns before the owner noticed by typing "Hello?") without diagnosing WHY.
 *
 * @decision 343441bd — consumes `pty/host.ts`'s `onTurnCompleted` (the completed-turn counter);
 * `checkCompanionReplyHealth` no-ops with no `companion_config` row, so wiring it in is fully additive.
 *
 * @decision 8bda9fc6 — surfaces via a PULL read (`GET /api/companion/status`) only, never pushed to the
 * companion itself, which cannot report its own silence.
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
 * `incrementTurnSeq` has already bumped `session.turnSeq`). No-op for any session with no
 * `companion_config` row, or a disabled one — the ONLY gate, matching "per ENABLED companion session".
 *
 * @decision 48e8d289 — a NULL `lastChatReplyTurnSeq` is a lazy baseline (first observation: seed and
 * return, no alert) — never read as a huge spurious streak against NULL.
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
