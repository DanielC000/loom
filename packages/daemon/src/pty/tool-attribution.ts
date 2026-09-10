/**
 * Correlates a `PreToolUse` hook firing (carries `agent_id`/`agent_type` only inside a subagent call) to
 * the MCP tool-call request it precedes, so a sub-agent's own call to a Loom tool can be told apart from
 * the top-level session's own call — done entirely daemon-side, by session + tool name + timing, since
 * neither the hook nor the MCP request carries a shared correlation id (`mcp/server.ts`'s `handle()`
 * binds identity by URL path only; Claude Code sends no protocol-level marker for a subagent call).
 *
 * @decision cd0c7fee — the PreToolUse-before-MCP ordering guarantee is PER-INVOCATION ONLY: it says
 * nothing about relative arrival order between two invocations of the same tool on the same session.
 * Never trust FIFO across invocations — that's exactly what produces the "ambiguous" state.
 *
 * @decision cd0c7fee — fail-open by design: "unknown"/"ambiguous" are honest, never folded into
 * "confirmed-main". Not persisted across a restart — a lost entry can only under-attribute, never
 * over-attribute. See record for the ambiguous-entries-age-via-TTL rationale.
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
   * (removes) the matched entry ONLY in the unambiguous single-candidate case — the ambiguous case is
   * left in place to age out via TTL instead of being drained or guessed (@decision cd0c7fee).
   *
   * @decision cd0c7fee — "confirmed-main" is a positive assertion built on an ABSENCE (a fresh entry
   * with no `agentId`), with no version floor: a future Claude Code that stops populating `agent_id`
   * would read every call as a confident false "all clear". See record for the full case.
   *
   * @decision e6ef5062 — cross-checked against a live sub-agent count (`SubagentDriftTracker`) instead
   * of the non-discriminating `stops`/`confirmedSubagent` comparison it replaced. See record for why
   * the original couldn't tell healthy operation from blindness.
   *
   * @decision aed28554 — that cross-check is "consistent with", not proof: a main-turn watched call CAN
   * land inside a live sub-agent window (measured 2026-08-25, reproduced 1 of 4 attempts). See record.
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
 * @decision 8d158088 — the enforcement half of cd0c7fee: parses ONLY `tools/call` requests naming a
 * watched tool (mirrors `mcp/inbound-log.ts`'s body-parsing) so attribution is computed ONCE per
 * request and shared, never re-derived — a second `consume()` call always reads "unknown". See record.
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
 * Per-session sub-agent-lifecycle drift tracker, wired to both `SubagentStart` and `SubagentStop`
 * (`claude-settings.ts`, dispatched in `pty/host.ts`'s `deliverHook`). `live` counts in-flight
 * sub-agent invocations; `recordAttribution` is the actual discriminator, called from
 * `PtyHost.consumeToolAttribution` with EVERY watched-tool result.
 *
 * @decision e6ef5062 — replaces the non-discriminating `stops > 0 && confirmedSubagent === 0`
 * counters (card 8d158088): that comparison logged identically for a healthy session that simply
 * never calls a watched tool during a sub-agent's turn as for a genuinely blind one. See record.
 *
 * @decision e6ef5062 — `blindWhileLive` increments only when a watched-tool result is NOT
 * "confirmed-subagent" while `live > 0`, so healthy and blind operation now provably diverge on the
 * identical event rather than sharing one ambiguous signature. See record for who reads this and when.
 *
 * @decision aed28554 — `live > 0` is "consistent with" a sub-agent origin, not proof: a main-turn
 * watched call CAN land inside a live sub-agent window (measured 2026-08-25). `evict()` below bounds
 * the companion leak (an unmatched `SubagentStart`). See record.
 *
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
