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

/** How long a PreToolUse entry stays eligible for correlation. Generous for local-loopback + hook-process
 *  spawn overhead; tight enough that it can never span into an unrelated LATER call in the same turn. */
export const ATTRIBUTION_TTL_MS = 8_000;

/** Defensive cap, independent of TTL pruning (which only runs lazily, on access): bounds memory under a
 *  pathological burst of PreToolUse fires with no intervening consume. */
const MAX_ENTRIES_PER_KEY = 8;

interface StoredEntry extends ToolAttributionEntry {
  receivedAt: number;
}

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
   * A CHEAP, INDEPENDENT CROSS-CHECK EXISTS FOR A FUTURE READER/ENFORCEMENT-CARD PRECONDITION (this is a
   * proposal to verify then, not something this module implements): `SubagentStart`/`SubagentStop` are
   * documented as their OWN distinct hook events (code.claude.com/docs/en/hooks), separate from
   * PreToolUse/PostToolUse and NOT gated on the `agent_id` field surviving on tool-call hooks — they fire
   * from the subagent LIFECYCLE itself, a different mechanism. If Loom ever wires either (not done today —
   * Loom wires neither, see sessions/service.ts's own wired-hook comment), a bare COUNT of subagent turns
   * per session, cross-referenced against how many "confirmed-subagent" results this tracker actually
   * produced, is the drift detector: count > 0 with zero confirmed-subagent results (all confirmed-main/
   * unknown instead) means the field stopped arriving, not that no subagent ever called a watched tool.
   * NOT the same as the card's excluded `isSidechain`/transcript-parsing fallback — this is a first-class
   * documented hook EVENT TYPE, not internal/unstable transcript schema.
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
