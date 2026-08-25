// Sub-agent-call correlation (card cd0c7fee) — PURE, dependency-free unit tests, no daemon/db/pty.
// Covers the confirmed cases AND, deliberately, the correlation-FAILURE paths (unknown/ambiguous/TTL
// expiry/max-depth) — the whole point of this card was refusing to fold those into a false-definite
// answer. Run (after a build): node test/tool-attribution.mjs
import { ToolAttributionTracker, ATTRIBUTION_TTL_MS, WATCHED_TOOL_NAMES } from "../dist/pty/tool-attribution.js";
import { PRE_TOOL_USE_ATTRIBUTION_MATCHER } from "../dist/pty/claude-settings.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- confirmed cases -------------------------------------------------------------------------------
{
  const t = new ToolAttributionTracker();
  const r0 = t.consume("s1", "worker_report", 1_000);
  check("no record ever made -> unknown, not a crash", r0.state === "unknown");

  t.record("s1", "worker_report", { agentId: "sub-1", agentType: "Explore" }, 1_000);
  const r1 = t.consume("s1", "worker_report", 1_050);
  check("single fresh entry WITH agentId -> confirmed-subagent", r1.state === "confirmed-subagent");
  check("confirmed-subagent carries the agentId through", r1.agentId === "sub-1");
  check("confirmed-subagent carries the agentType through", r1.agentType === "Explore");

  t.record("s1", "worker_report", {}, 2_000); // PreToolUse fired with NO agent_id -> main-thread call
  const r2 = t.consume("s1", "worker_report", 2_010);
  check("single fresh entry with NO agentId -> confirmed-main (a positive result, not an absence)", r2.state === "confirmed-main");
  check("confirmed-main carries no agentId", r2.agentId === undefined);

  // A confirmed read is a CONSUME — the same entry cannot answer a second, later request.
  const r3 = t.consume("s1", "worker_report", 2_020);
  check("consuming again after a confirmed match -> unknown (entry was popped, not peeked)", r3.state === "unknown");
}

// --- unknown: hook never fired / arrived too late -------------------------------------------------
{
  const t = new ToolAttributionTracker();
  const r = t.consume("s2", "memory_write", 5_000);
  check("empty queue -> unknown (never silently read as confirmed-main)", r.state === "unknown");
  check("unknown carries no agentId", r.agentId === undefined);
}

// --- ambiguous: two in-flight candidates for the SAME session+tool ---------------------------------
{
  const t = new ToolAttributionTracker();
  t.record("s3", "worker_report", { agentId: "sub-a" }, 1_000);
  t.record("s3", "worker_report", { agentId: "sub-b" }, 1_010);
  const r1 = t.consume("s3", "worker_report", 1_020);
  check("two fresh candidates -> ambiguous (never guesses FIFO order across invocations)", r1.state === "ambiguous");
  check("ambiguous reports the candidate count", r1.candidateCount === 2);
  check("ambiguous carries no agentId (never a guess)", r1.agentId === undefined);

  // Required decision (manager's question): ambiguous entries are NOT consumed/drained — they age out
  // via TTL on the NEXT access instead, so a race degrades to a bounded window, never permanent blindness
  // and never a silently-drained legitimate second invocation.
  const r2 = t.consume("s3", "worker_report", 1_030);
  check("consuming again while STILL fresh -> still ambiguous (entries were left in place, not drained)", r2.state === "ambiguous");
  check("still ambiguous with the same candidate count (nothing was silently dropped)", r2.candidateCount === 2);

  const r3 = t.consume("s3", "worker_report", 1_030 + ATTRIBUTION_TTL_MS + 1);
  check("once BOTH entries age past the TTL -> unknown, not permanently ambiguous", r3.state === "unknown");
}

// --- TTL expiry: a hook fires but no MCP call ever follows -----------------------------------------
{
  const t = new ToolAttributionTracker();
  t.record("s4", "worker_report", { agentId: "sub-c" }, 1_000);
  const stillFresh = t.consume("s4", "worker_report", 1_000 + ATTRIBUTION_TTL_MS);
  check("consume AT exactly the TTL boundary is still fresh (inclusive)", stillFresh.state === "confirmed-subagent");

  t.record("s4", "worker_report", { agentId: "sub-d" }, 2_000);
  const stale = t.consume("s4", "worker_report", 2_000 + ATTRIBUTION_TTL_MS + 1);
  check("a stale entry (past TTL) -> unknown, never wrongly attributed to a LATER unrelated call", stale.state === "unknown");
}

// --- TTL expiry does not leak an unrelated LATER call across two different tool names ---------------
{
  const t = new ToolAttributionTracker();
  t.record("s5", "worker_report", { agentId: "sub-e" }, 1_000);
  const other = t.consume("s5", "memory_write", 1_010);
  check("an entry recorded for one tool name never answers a DIFFERENT tool name on the same session", other.state === "unknown");
  const same = t.consume("s5", "worker_report", 1_020);
  check("...and the original entry is still there, unaffected by the cross-tool probe", same.state === "confirmed-subagent");
}

// --- max-depth safety cap: a pathological burst with no intervening consume ------------------------
{
  const t = new ToolAttributionTracker();
  for (let i = 0; i < 20; i++) t.record("s6", "worker_report", { agentId: `sub-${i}` }, 1_000 + i);
  // Still just "ambiguous" (>1), not a crash or unbounded growth — candidateCount is capped, never 20.
  const r = t.consume("s6", "worker_report", 1_100);
  check("a runaway burst never grows unbounded (capped at MAX_ENTRIES_PER_KEY=8, not 20)", r.state === "ambiguous" && r.candidateCount === 8);
}

// --- WATCHED_TOOL_NAMES: the two DoD-2 tools, and only those (scope, not a behavior test of the set itself) --
{
  check("WATCHED_TOOL_NAMES includes worker_report", WATCHED_TOOL_NAMES.has("worker_report"));
  check("WATCHED_TOOL_NAMES includes memory_write", WATCHED_TOOL_NAMES.has("memory_write"));
  check("WATCHED_TOOL_NAMES does not include an arbitrary unrelated tool", !WATCHED_TOOL_NAMES.has("tasks_get"));
}

// --- matcher/WATCHED_TOOL_NAMES agree (round-2 review) ---------------------------------------------
// The hazard: a tool added to ONE side and not the other fails SILENTLY, toward the reassuring side — the
// un-matched tool's PreToolUse hook never fires, `consume()` reads "unknown" for it forever, nothing
// breaks, nothing logs, nobody looks. This makes the "keep the two files in sync by hand" comments in
// claude-settings.ts and tool-attribution.ts mechanical instead of just a request a future editor has to
// remember to honor: derive the matcher's alternatives, strip the `mcp__<server>__` prefix from each the
// SAME way host.ts's own PreToolUse dispatch does (split on "__", drop the first two segments), and
// assert the resulting set is EXACTLY WATCHED_TOOL_NAMES — extra on either side fails this just as loudly
// as a missing entry (a matcher entry with no corresponding watched name would silently attribute a tool
// nothing ever consumes for; a watched name with no matcher entry is the hazard described above).
{
  const bareNamesFromMatcher = PRE_TOOL_USE_ATTRIBUTION_MATCHER.split("|").map((full) => {
    const parts = full.split("__");
    return parts.length >= 3 ? parts.slice(2).join("__") : full;
  });
  const matcherSet = new Set(bareNamesFromMatcher);
  const watchedSet = new Set(WATCHED_TOOL_NAMES);

  check("the matcher has no duplicate/degenerate alternatives (parses to as many names as '|'-segments)", bareNamesFromMatcher.length === matcherSet.size);
  check("every matcher alternative, prefix-stripped, is in WATCHED_TOOL_NAMES (no orphaned matcher entry)",
    bareNamesFromMatcher.every((n) => watchedSet.has(n)));
  check("every WATCHED_TOOL_NAMES entry has a matching matcher alternative (no silently-unmatched watched tool)",
    [...watchedSet].every((n) => matcherSet.has(n)));
  check("the two sets are EXACTLY equal, not just overlapping", matcherSet.size === watchedSet.size && bareNamesFromMatcher.every((n) => watchedSet.has(n)));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmed-subagent/confirmed-main both resolve and consume correctly; unknown, ambiguous, TTL-expiry, cross-tool-name, and burst-depth are all classified honestly rather than folded into a false-definite answer; ambiguous entries are left in place (not drained) and self-resolve only once genuinely stale; and the PreToolUse matcher / WATCHED_TOOL_NAMES agree exactly, mechanically, not just by comment."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
