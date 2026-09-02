/**
 * Card 2d8d2e42 — defence in depth behind card 45390f74 (the cheap primary fix: an anti-poll `note` on
 * `gate_status`'s live reply). That fix relies on the caller actually reading and heeding the note; this
 * module gives a repeated-identical-call loop a SEPARATE, mechanical signal that fires regardless of
 * whether any note was ever read — the real incident this defends against consumed ~800k of context in a
 * loop that never reached a turn boundary, so `ctx_input_tokens` stayed null and `ContextWatcher` was
 * structurally blind to it (the loop suppressed the very alarm that would otherwise have caught it).
 *
 * ⛔ NOT a rate limit on tool calls — real workers routinely run 88-201 turns/day, and a volume cap would
 * punish that AND miss a loop that varies its arguments. The signal is IDENTICAL-ARGS REPETITION TO THE
 * SAME TOOL, CONSECUTIVELY, WITHIN ONE TURN — never call volume, never a cross-turn count.
 *
 * ⭐ Reuses `argsHash` as already computed by `mcp/inbound-log.ts`'s `logInboundMcpRequest` for the `[mcp]`
 * log line — no parallel hash computation. `record()` is called once per inbound MCP tool-call request
 * (gateway/server.ts, threaded through every router — see that file's call sites) with the SAME hash.
 *
 * GENERALIZED PAST `gate_status` DELIBERATELY (card bound #2): tracked per (sessionId, tool) pair at the
 * single shared chokepoint every router's inbound request already passes through, rather than allowlisting
 * specific tool names (`gate_status`/`worker_status`/`gate_queue`). A tool called with genuinely varying
 * arguments (the overwhelmingly common case for a write tool, and for most reads) never accumulates a
 * streak — this only ever fires on a literal repeat, so widening the scope to every tool costs nothing in
 * false positives while catching the same shape wherever it next occurs, not only in the three tools named
 * on the card.
 *
 * SCOPE, A DELIBERATE CHOICE: tracks CONSECUTIVE identical calls only (the last call, not "N occurrences
 * anywhere in the turn") — a call to a DIFFERENT tool, or the SAME tool with DIFFERENT arguments, resets
 * the streak. This matches the actual failure shape (a tight poll loop repeating one call with nothing
 * else happening in between) and is what keeps this a same-shaped sibling of `ToolAttributionTracker`/
 * `SubagentDriftTracker` (tool-attribution.ts) rather than a second, heavier per-turn ledger.
 */

/**
 * How many consecutive identical-argsHash calls to the same tool, within one turn, before the signal
 * fires. A SUGGESTION carried verbatim from the card's own adopted recommendation (`45390f74`'s worker),
 * not a measured threshold — picked deliberately: low enough to fire long before a loop can consume
 * meaningful context (the incident this defends against ran into the hundreds of repeats), high enough
 * that an ordinary rapid double/triple recheck of a long-running gate within the SAME turn — a normal,
 * healthy pattern — never trips it. The within-one-turn scoping (reset on every Stop/StopFailure) is what
 * makes a low N safe: a manager legitimately re-polling a gate across SEPARATE turns never accumulates
 * across the reset, no matter how many turns that spans.
 */
export const REPEATED_CALL_THRESHOLD = 5;

interface Bucket {
  tool: string;
  argsHash: string;
  count: number;
}

export interface RepeatedCallResult {
  /** The consecutive-identical-call count AFTER this call (>= 1). */
  count: number;
  /**
   * True iff `count` is a positive multiple of {@link REPEATED_CALL_THRESHOLD} (fires at N, 2N, 3N, ...).
   * Firing again at each multiple — not just the first crossing — means a runaway loop keeps re-signalling
   * instead of going silent after one shot; card `45390f74`'s DoD-3 (escalating wording after N repeats)
   * rides on exactly this: `count / REPEATED_CALL_THRESHOLD` is the escalation level, with no separate
   * counter needed.
   */
  firedAtThreshold: boolean;
}

/**
 * In-memory, per-daemon-process tracker — same construction/lifetime shape as `ToolAttributionTracker`/
 * `SubagentDriftTracker` (tool-attribution.ts): NOT persisted across a daemon restart (a streak that was
 * mid-count when the daemon restarts simply resets to 0, the safe direction — it can only under-fire,
 * never over-fire on a phantom streak).
 */
export class RepeatedCallTracker {
  private readonly buckets = new Map<string, Bucket>();

  /** Called once per inbound MCP tool-call request, with the tool name and the SAME argsHash already
   *  computed for the `[mcp]` log line. Returns the updated streak state for the caller to act on. */
  record(sessionId: string, tool: string, argsHash: string): RepeatedCallResult {
    const existing = this.buckets.get(sessionId);
    const count = existing && existing.tool === tool && existing.argsHash === argsHash ? existing.count + 1 : 1;
    this.buckets.set(sessionId, { tool, argsHash, count });
    return { count, firedAtThreshold: count % REPEATED_CALL_THRESHOLD === 0 };
  }

  /** Turn boundary (Stop/StopFailure hook, pty/host.ts's `deliverHook`) — a streak must never span across
   *  it, so this drops the session's whole bucket unconditionally, regardless of its current count. */
  resetTurn(sessionId: string): void {
    this.buckets.delete(sessionId);
  }

  /** Session exit cleanup — mirrors `ToolAttributionTracker.forget`/`SubagentDriftTracker.evict`, called
   *  from every per-session cleanup point so a dead session's bucket never lingers for the rest of the
   *  daemon's process lifetime. */
  forget(sessionId: string): void {
    this.buckets.delete(sessionId);
  }
}
