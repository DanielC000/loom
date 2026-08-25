/**
 * Card cd0c7fee: correlates a `PreToolUse` hook firing (which carries `agent_id`/`agent_type` ONLY when
 * the hook fires inside a subagent call — verified against code.claude.com/docs/en/hooks, "Common Input
 * Fields": "Present only when the hook fires inside a subagent call") to the MCP tool-call request it
 * precedes, so a sub-agent's own call to a Loom tool can eventually be told apart from the top-level
 * session's own call. The MCP request itself carries nothing to correlate with directly — `mcp/server.ts`
 * `handle()` binds identity by URL path only, and Claude Code sends no protocol-level marker to the MCP
 * server for a subagent call (confirmed against the primary docs, not assumed: no `_meta`/header carries
 * `agent_id`) — so correlation happens ENTIRELY here, daemon-side, by session + tool name + timing.
 *
 * ORDERING GUARANTEE THIS RELIES ON (code.claude.com/docs/en/hooks: PreToolUse "Before a tool call
 * executes. Can block it" — Claude Code blocks the tool call until its own PreToolUse hook process
 * exits): for one invocation X, the daemon receives X's PreToolUse POST strictly before X's tool
 * executes, and thus before X's MCP request (if X is an MCP tool). This is a PER-INVOCATION guarantee
 * ONLY — it says nothing about the relative arrival order between TWO DIFFERENT invocations of the SAME
 * tool on the SAME session (a parallel tool-call batch can fire both PreToolUse hooks and both MCP
 * requests interleaved in either order). That is exactly the "ambiguous" state below, and it is handled
 * by refusing to guess an order the guarantee doesn't cover — never by trusting FIFO across invocations.
 *
 * FAIL-OPEN BY DESIGN (card cd0c7fee, owner-approved 2026-08-24): "unknown" (no correlated hook found)
 * and "ambiguous" (>1 fresh candidate, genuinely indistinguishable) are both distinct, honestly-labelled
 * states — NEVER silently folded into "confirmed-main" the way `x ?? false` folded unknown into a
 * reassuring definite answer elsewhere (project memory `unknown-folded-into-a-definite-answer`). Nothing
 * in this module refuses or blocks anything — it only classifies. Enforcement (refusing a sub-agent's
 * `worker_report`/`memory_write`) is a deliberately separate, not-yet-built follow-up (a live sibling
 * worker currently owns `mcp/orchestration.ts`, where that would land).
 *
 * AMBIGUOUS entries are deliberately left in the queue rather than drained or FIFO-guessed at consume
 * time: draining would make a genuinely in-flight second invocation degrade to "unknown" for no reason,
 * and guessing an order would risk mis-attributing a main-thread call as a sub-agent's (the fail-closed
 * direction the card explicitly rejects). Instead every entry — ambiguous or not — ages out lazily via
 * {@link ATTRIBUTION_TTL_MS} on the NEXT access (record or consume), so a race's "every call on this
 * session+tool reads ambiguous" window is bounded by the TTL, not permanent.
 *
 * NOT persisted across a daemon restart (in-memory, per-process only) — a hook that fired just before a
 * restart simply degrades to "unknown" on the other side, which is the safe direction for a fail-open
 * design: a lost entry can only ever under-attribute, never over-attribute.
 */

export type ToolAttributionState = "confirmed-subagent" | "confirmed-main" | "unknown" | "ambiguous";

export interface ToolAttributionResult {
  state: ToolAttributionState;
  agentId?: string;
  agentType?: string;
  /** Only set for "ambiguous" — how many fresh, genuinely indistinguishable candidates were pending. */
  candidateCount?: number;
}

/**
 * Card e6ef5062: the single source of truth for "was this call positively confirmed as a sub-agent's own
 * call" — collapses what used to be four independent hand-typed `=== "confirmed-subagent"` string
 * comparisons (mcp/server.ts, sessions/service.ts ×2, plus this file's own `SubagentDriftTracker`) into
 * one typed predicate. Typed against {@link ToolAttributionState} (a 4-member union), so a typo or rename
 * at any call site is a COMPILE ERROR, not a comparison that silently reads `false` forever — the same
 * silent-all-clear failure mode this whole module exists to make legible, one level up.
 */
export function isConfirmedSubagent(state: ToolAttributionState | undefined | null): boolean {
  return state === "confirmed-subagent";
}

export interface ToolAttributionEntry {
  /** Present only when the firing PreToolUse hook was inside a subagent call. */
  agentId?: string;
  agentType?: string;
  /** Claude Code's own per-invocation id (`tool_use_id`) — carried for future diagnostics; it does NOT
   *  reach the MCP request (see this file's own doc), so it is never used to correlate here today. */
  toolUseId?: string;
}

/**
 * The only tools this correlation currently tracks — kept narrow per card cd0c7fee (the two DoD-2 cares
 * about). Widen here, and `claude-settings.ts`'s `PRE_TOOL_USE_ATTRIBUTION_MATCHER`, TOGETHER, if scope
 * ever grows; a tool name outside this set is simply never recorded, so `consume` for it always reads
 * "unknown". ⚠️ A drift between the two is SILENT and fails toward the reassuring side: a tool present
 * here but missing from the matcher never gets a PreToolUse hook fired for it, so `consume` reads
 * "unknown" for it forever — nothing breaks, nothing logs, nobody looks; the detector just quietly stops
 * detecting for that one tool. `test/tool-attribution.mjs`'s "matcher/WATCHED_TOOL_NAMES agree" block
 * makes this mechanical rather than a comment a future editor has to remember to honor — run it after
 * editing either side.
 */
export const WATCHED_TOOL_NAMES: ReadonlySet<string> = new Set(["worker_report", "memory_write"]);

/**
 * Card 3cc3b726: the two MCP server ids that can register a watched tool — the only ids that matter for
 * the attribution queue's qualified key (`mcp__<server>__<tool>`, see `keyFor`'s own doc below). Exported
 * so `pty/host.ts`'s `buildMcpServers` (which mints these as the client's own MCP server names) and
 * `gateway/server.ts`'s `computeAttributions` (which reconstructs the SAME qualified key at consume time,
 * from the route it's handling) share ONE definition instead of two independently-typed literal strings
 * that could silently drift apart. `test/tool-attribution-join.mjs` is the test that actually PINS this
 * join across both real production sites — read it before touching either side.
 */
export const LOOM_TASKS_SERVER_ID = "loom-tasks";
export const LOOM_ORCHESTRATION_SERVER_ID = "loom-orchestration";

/** How long a PreToolUse entry stays eligible for correlation. Generous for local-loopback + hook-process
 *  spawn overhead; tight enough that it can never span into an unrelated LATER call in the same turn. */
export const ATTRIBUTION_TTL_MS = 8_000;

/** Defensive cap, independent of TTL pruning (which only runs lazily, on access): bounds memory under a
 *  pathological burst of PreToolUse fires with no intervening consume. */
const MAX_ENTRIES_PER_KEY = 8;

interface StoredEntry extends ToolAttributionEntry {
  receivedAt: number;
}

/**
 * Card 3cc3b726: `toolName` is expected to be the FULL qualified `mcp__<server>__<tool>` form (what
 * `deliverHook`'s PreToolUse case records under, and what `gateway/server.ts`'s `computeAttributions`
 * reconstructs before calling `consume()`) — NOT the bare tool name. Two different MCP routers can each
 * register a tool sharing the same bare name (e.g. `memory_write`: loom-tasks' project memory vs.
 * loom-orchestration's companion-private memory), and a single session (a companion) can mount both on
 * the SAME sessionId; keying by bare name alone let one router's call destructively consume an entry
 * recorded for the other's pending call. This function itself is agnostic to that distinction — it just
 * concatenates whatever string it's given — the qualification discipline lives entirely in the two
 * callers named above. `test/tool-attribution-join.mjs` PINS that the two callers actually agree (drives
 * a real PreToolUse hook through `deliverHook`, then consumes through the REAL `/mcp/:sessionId` HTTP
 * route so `gateway/server.ts`'s own reconstruction is what runs, with a mismatched-server-id negative
 * control) — read that test rather than trusting this comment to keep the two sides in sync by hand.
 */
function keyFor(sessionId: string, toolName: string): string {
  return `${sessionId} ${toolName}`;
}

/**
 * In-memory, per-daemon-process correlation queue. Pure and dependency-free (mirrors `session-name.ts`'s
 * own "pure, dependency-free helpers" precedent) — one instance lives on `PtyHost`, constructed with no
 * opts, so every existing hermetic test that builds a `PtyHost` stays byte-identical.
 */
export class ToolAttributionTracker {
  private readonly queues = new Map<string, StoredEntry[]>();

  /** Called from the PreToolUse hook dispatch (`pty/host.ts`'s `deliverHook`). `now` is injectable for
   *  tests; defaults to the real clock. */
  record(sessionId: string, toolName: string, entry: ToolAttributionEntry, now = Date.now()): void {
    const key = keyFor(sessionId, toolName);
    const list = this.pruned(key, now);
    list.push({ ...entry, receivedAt: now });
    while (list.length > MAX_ENTRIES_PER_KEY) list.shift();
    this.queues.set(key, list);
  }

  /**
   * Called at MCP-request time (`gateway/server.ts`, via `PtyHost.consumeToolAttribution`). Consumes
   * (removes) the matched entry ONLY in the unambiguous single-candidate case — see this module's own doc
   * for why the ambiguous case is left in place to age out via TTL instead of being drained or guessed.
   *
   * ⚠️ "confirmed-main" IS A POSITIVE ASSERTION BUILT ON AN ABSENCE (round-2 review, card cd0c7fee): it
   * fires whenever a fresh PreToolUse entry exists with NO `agentId`, on the documented present-iff-
   * subagent contract. Sound today — but there is no version floor (deliberate, see the card), so if a
   * future Claude Code renames or stops populating `agent_id`, PreToolUse keeps firing (entries keep
   * arriving — the queue is NOT empty, so this never degrades to "unknown"), every entry just permanently
   * lacks `agentId`, and every call reads "confirmed-main" — a confident "all clear", not a visible gap.
   * At enforcement time (not built yet) that would mean silently permitting every sub-agent call instead
   * of failing open on an honest "unknown".
   *
   * ⭐⭐ CARD e6ef5062 CORRECTED THE CROSS-CHECK THIS PARAGRAPH ONCE PROPOSED — the original design (a bare
   * `stops > 0` with `confirmedSubagent === 0` comparison, see `SubagentDriftTracker`'s history) does NOT
   * discriminate: a session running sub-agents that simply never call a watched tool logs EXACTLY that
   * signature in perfectly healthy operation (`agent_id` arriving normally, just never observed because no
   * watched-tool call happened during a live sub-agent's turn) — the SAME reading a genuinely blind session
   * produces. `SubagentDriftTracker` now wires BOTH `SubagentStart` and `SubagentStop` (per-session live
   * count, incremented/decremented on each) and correlates it against every watched-tool attribution
   * result at CONSUME time: the live count brackets each sub-agent's own start/stop, so a watched-tool call
   * observed while it is >0 is CONSISTENT WITH having originated inside that live sub-agent — a real
   * lifecycle-hook signal, not a guess. ⚠️ Card aed28554 — MEASURED, 2026-08-25: a main-turn watched call CAN
   * land inside a live sub-agent window. This file's own ORDERING GUARANTEE (above) is a PER-INVOCATION
   * guarantee — Claude Code blocks the invoking turn until ITS OWN Task-tool call returns — and says nothing
   * about a Task call and a sibling watched-tool call dispatched as PARALLEL tool calls from the SAME
   * assistant message; reproduced 1 of 4 attempts by doing exactly that (a Task call + a sibling
   * `memory_write` from one message) — the sibling's PreToolUse/consume landed inside the live window on
   * attempt 1, and after it on attempts 2-4; the relative order is a real race, observed both ways (full
   * trace: project memory `subagent-drift-blind-false-positive-confirmed`). So "consistent with" is the
   * honest strength of this signal, not "KNOWN"/"proven" — a result that is NOT
   * "confirmed-subagent" under `live > 0` (`confirmed-main`, `unknown`, or `ambiguous`) is a genuine,
   * per-event drift OBSERVATION worth surfacing, not a certified misattribution. In the common case — no
   * watched tool called while any sub-agent is live — the signal correctly stays silent in BOTH healthy and
   * blind operation, because there is genuinely no data to discriminate on either way; it no longer reads
   * that silence as an alarm.
   */
  consume(sessionId: string, toolName: string, now = Date.now()): ToolAttributionResult {
    const key = keyFor(sessionId, toolName);
    const list = this.pruned(key, now);
    if (list.length === 0) return { state: "unknown" };
    if (list.length > 1) return { state: "ambiguous", candidateCount: list.length };
    const entry = list[0]!; // list.length === 1, checked above
    list.splice(0, 1);
    if (list.length === 0) this.queues.delete(key); else this.queues.set(key, list);
    return entry.agentId
      ? { state: "confirmed-subagent", agentId: entry.agentId, agentType: entry.agentType }
      : { state: "confirmed-main" };
  }

  /**
   * Card 7b8a3b25: drops every queued entry for `sessionId`, regardless of tool name or staleness.
   * `record`/`consume` only prune LAZILY, on access — the interrupted path (a `PreToolUse` hook fires
   * and the matching MCP request never arrives because the session died mid-turn) never accesses that
   * key again, so nothing would otherwise prune it for the rest of the daemon's process lifetime. Call
   * this from every per-session cleanup point instead. Keys are `` `${sessionId} ${toolName}` `` — the
   * space separator means a plain prefix match can't cross into another session's keys even when one
   * session id is a literal prefix of another's (e.g. "s1" vs "s10": "s10 tool" does not start with
   * "s1 ").
   */
  forget(sessionId: string): void {
    const prefix = `${sessionId} `;
    for (const key of this.queues.keys()) {
      if (key.startsWith(prefix)) this.queues.delete(key);
    }
  }

  /** Filters stale entries (older than {@link ATTRIBUTION_TTL_MS}) and writes the pruned result straight
   *  back into the map (dropping the key entirely once empty) — every caller (record AND consume,
   *  including the ambiguous/read-only consume path) self-heals the stored state on every access, so a
   *  stale entry never survives past the access that should have pruned it. */
  private pruned(key: string, now: number): StoredEntry[] {
    const existing = this.queues.get(key);
    if (!existing || existing.length === 0) {
      this.queues.delete(key);
      return [];
    }
    const fresh = existing.filter((e) => now - e.receivedAt <= ATTRIBUTION_TTL_MS);
    if (fresh.length === 0) this.queues.delete(key);
    else this.queues.set(key, fresh);
    return fresh;
  }
}

/**
 * Card 8d158088 (the enforcement half of cd0c7fee): parses the tool name(s) out of an inbound MCP
 * JSON-RPC request body, restricted to `watched`. Mirrors `mcp/inbound-log.ts`'s own inline body-parsing
 * exactly (a streamable-HTTP body may be a single request or a batch array) — pulled out here as ONE
 * shared definition so `gateway/server.ts` can compute each watched tool's attribution ONCE per request
 * and thread that SAME result to both the `[mcp]` log line and the tool handler that enforces it, instead
 * of parsing the body a second, independently-driftable way. See `consume()`'s own doc above for why a
 * second, independent call would silently read "unknown" forever (consume() is destructive/single-shot).
 *
 * `method === "tools/call"` gated (card e6ef5062 nitpick): a JSON-RPC request carrying `params.name` under
 * some OTHER method would otherwise still be treated as a watched tool call and destructively consume a
 * pending correlation entry. Not reachable today — the only client is Claude Code's own MCP transport,
 * which always sends `tools/call` for a tool invocation — but the guard makes the intent exact rather than
 * relying on that being true forever.
 */
export function extractWatchedToolCalls(body: unknown, watched: ReadonlySet<string>): string[] {
  const entries = Array.isArray(body) ? body : [body];
  const names: string[] = [];
  for (const entry of entries) {
    const parsed = entry as { method?: unknown; params?: { name?: unknown } } | undefined;
    if (parsed?.method !== "tools/call") continue;
    const name = parsed.params?.name;
    if (typeof name === "string" && watched.has(name)) names.push(name);
  }
  return names;
}

/**
 * Card e6ef5062 (replaces the non-discriminating counters card 8d158088 originally shipped — see this
 * file's own `consume()` doc for why the original `stops`/`confirmedSubagent` comparison could not tell
 * healthy operation from blindness): per-session sub-agent-lifecycle drift tracker, now wired to BOTH
 * `SubagentStart` and `SubagentStop` (`claude-settings.ts`, dispatched in `pty/host.ts`'s `deliverHook`).
 *
 * `live` is a per-session count of currently in-flight sub-agent invocations — incremented on
 * `SubagentStart`, decremented (floored at 0) on `SubagentStop`, and evicted entirely on session exit (see
 * `evict()` below — card aed28554 bounds a `SubagentStart` with no matching `SubagentStop`, e.g. a
 * killed/crashed sub-agent, to the session's own lifetime rather than leaving `live` stuck >0 forever).
 * Any watched-tool call observed while `live > 0` is CONSISTENT WITH having originated inside that live
 * sub-agent — a real lifecycle-hook signal, not a guess — but this is NOT a proof: card aed28554 MEASURED
 * (2026-08-25) the boundary this file's own ORDERING GUARANTEE (top of file) does not close — that
 * guarantee is PER-INVOCATION only, and says nothing about a Task call and a sibling watched-tool call
 * dispatched as PARALLEL tool calls from the SAME assistant message. A main-turn watched call CAN land
 * inside a live sub-agent window: reproduced 1 of 4 attempts by dispatching a Task call and a sibling
 * `memory_write` from one message — the sibling's PreToolUse/consume landed inside the live window on
 * attempt 1 and after it on attempts 2-4, so the relative order is a real race, observed both ways (full
 * trace: project memory `subagent-drift-blind-false-positive-confirmed`). `recordAttribution` is the actual
 * discriminator: called from `PtyHost.consumeToolAttribution` with EVERY watched-tool result (not just
 * "confirmed-subagent"), it counts
 * `blindWhileLive` whenever the result is NOT "confirmed-subagent" (i.e. `confirmed-main`/`unknown`/
 * `ambiguous`) while `live > 0` at that moment — a genuine, per-event drift OBSERVATION worth surfacing, not
 * a certified misattribution. `stops` and `confirmedSubagent` are kept as supporting context on the same
 * log line, not as the tell itself.
 *
 * ⭐⭐ WHY THIS DISCRIMINATES WHERE THE ORIGINAL DIDN'T: the common case — a session running sub-agents that
 * never call a watched tool — now produces `blindWhileLive === 0` in BOTH healthy and blind operation
 * (there is genuinely no data to discriminate on either way), instead of the original design's false
 * alarm (`stops > 0, confirmedSubagent === 0` in that SAME common healthy case). And when a watched tool
 * IS called during a live sub-agent's turn, `blindWhileLive` increments if and only if `agent_id` failed
 * to arrive on that specific call — healthy and blind operation now provably diverge in the tracker's own
 * output for the identical event, not just "does it ever fire".
 *
 * ⭐ WHO READS THIS, AND WHEN: the Loom lead/manager greps `[subagent-drift]` in the daemon log WHEN
 * diagnosing whether enforcement (card 8d158088) might be silently blind — e.g. after a Claude Code
 * upgrade, or on a report that a sub-agent's `worker_report`/`memory_write` went through unattributed more
 * than expected. NOT a periodic check nobody will run — mirrors `mcp/inbound-log.ts`'s own "WHO READS
 * THIS" precedent for the `[mcp]` line. A non-zero `blindWhileLive` is logged distinctly (its own line, on
 * the event that produced it) so it doesn't wait to be noticed in an aggregate.
 * ⚠️ ADVISORY ONLY — same posture as the rest of this module: nothing here refuses or blocks anything.
 */
export class SubagentDriftTracker {
  private readonly counts = new Map<string, { stops: number; confirmedSubagent: number; live: number; blindWhileLive: number }>();

  private bucket(sessionId: string): { stops: number; confirmedSubagent: number; live: number; blindWhileLive: number } {
    let b = this.counts.get(sessionId);
    if (!b) {
      b = { stops: 0, confirmedSubagent: 0, live: 0, blindWhileLive: 0 };
      this.counts.set(sessionId, b);
    }
    return b;
  }

  /** Called from `deliverHook`'s `SubagentStart` case. */
  recordStart(sessionId: string): void {
    this.bucket(sessionId).live += 1;
  }

  /** Called from `deliverHook`'s `SubagentStop` case. Returns the updated counts for that same log line. */
  recordStop(sessionId: string): { stops: number; confirmedSubagent: number; live: number; blindWhileLive: number } {
    const b = this.bucket(sessionId);
    b.stops += 1;
    if (b.live > 0) b.live -= 1;
    return { ...b };
  }

  /**
   * Called from `PtyHost.consumeToolAttribution` with EVERY watched-tool result (the actual discriminator
   * — see this class's own doc above). Returns the updated counts plus `blindEvent` (whether THIS specific
   * call is the one that just incremented `blindWhileLive`), so the caller can log a distinct line only
   * when something new actually happened, not on every confirmed/quiescent call.
   */
  recordAttribution(sessionId: string, state: ToolAttributionState): { stops: number; confirmedSubagent: number; live: number; blindWhileLive: number; blindEvent: boolean } {
    const b = this.bucket(sessionId);
    if (isConfirmedSubagent(state)) {
      b.confirmedSubagent += 1;
      return { ...b, blindEvent: false };
    }
    if (b.live > 0) {
      b.blindWhileLive += 1;
      return { ...b, blindEvent: true };
    }
    return { ...b, blindEvent: false };
  }

  /**
   * Card aed28554: bounds the OTHER leak the merge gate for e6ef5062 flagged — a `SubagentStart` with no
   * matching `SubagentStop` (a killed/interrupted/crashed sub-agent, or a daemon restart mid-flight) would
   * otherwise leave `live > 0` for that session FOREVER, so every later non-confirmed watched call on that
   * session logs `BLIND` regardless of ground truth. Called from `pty/host.ts`'s pty `onExit` handler —
   * fires on EVERY exit path (a deliberate stop, a crash, a clean session end), the same "covers every
   * exit path" precedent `Live.pending`/`mcpSeenWaiters` cleanup already uses there. This bounds the leak
   * to the session's own lifetime (the same bound `e6ef5062`'s own skipped DoD-6 accepted for the
   * analogous bucket-eviction case) rather than leaving it unbounded in time — a session that exits is a
   * session no watched-tool call can ever arrive for again, so there is nothing left for a stale `live`
   * count to mis-attribute.
   */
  evict(sessionId: string): void {
    this.counts.delete(sessionId);
  }
}
