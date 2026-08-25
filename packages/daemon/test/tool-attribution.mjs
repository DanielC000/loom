// Sub-agent-call correlation (card cd0c7fee) — PURE, dependency-free unit tests, no daemon/db/pty.
// Covers the confirmed cases AND, deliberately, the correlation-FAILURE paths (unknown/ambiguous/TTL
// expiry/max-depth) — the whole point of this card was refusing to fold those into a false-definite
// answer. Run (after a build): node test/tool-attribution.mjs
import { ToolAttributionTracker, ATTRIBUTION_TTL_MS, WATCHED_TOOL_NAMES, SubagentDriftTracker, isConfirmedSubagent, extractWatchedToolCalls } from "../dist/pty/tool-attribution.js";
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

// --- isConfirmedSubagent: the single collapsed predicate (card e6ef5062, DoD-4) --------------------
{
  check("isConfirmedSubagent(\"confirmed-subagent\") -> true", isConfirmedSubagent("confirmed-subagent") === true);
  check("isConfirmedSubagent(\"confirmed-main\") -> false", isConfirmedSubagent("confirmed-main") === false);
  check("isConfirmedSubagent(\"unknown\") -> false", isConfirmedSubagent("unknown") === false);
  check("isConfirmedSubagent(\"ambiguous\") -> false", isConfirmedSubagent("ambiguous") === false);
  check("isConfirmedSubagent(undefined) -> false (never throws on an absent attribution)", isConfirmedSubagent(undefined) === false);
}

// --- extractWatchedToolCalls: method-gated (card e6ef5062 nitpick 5b) --------------------------------
{
  const call = { method: "tools/call", params: { name: "worker_report" } };
  const notACall = { method: "tools/list", params: { name: "worker_report" } };
  check("a real tools/call for a watched tool is extracted", extractWatchedToolCalls(call, WATCHED_TOOL_NAMES).length === 1);
  check("the SAME params.name under a non-\"tools/call\" method is NOT extracted (method-gated, not name-only)",
    extractWatchedToolCalls(notACall, WATCHED_TOOL_NAMES).length === 0);
  check("a batch mixes correctly — only the real tools/call entry counts",
    extractWatchedToolCalls([call, notACall], WATCHED_TOOL_NAMES).length === 1);
}

// ====================================================================================================
// --- SubagentDriftTracker: THE CORE OF THIS CARD (e6ef5062) — prove the tell actually DISCRIMINATES.
// The predecessor detector (card 8d158088) alarmed on `stops>0, confirmedSubagent===0`, which is ALSO the
// signature of perfectly healthy operation whenever a sub-agent simply never calls a watched tool — it
// could not tell the two states apart. This suite proves the redesigned tracker CAN: the SAME lifecycle
// shape (a live sub-agent, a watched-tool call observed during it) must produce DIFFERENT tracker output
// depending on whether `agent_id` arrived on that call or not.
// ====================================================================================================

// --- HEALTHY: agent_id arrives on a watched-tool call made while a sub-agent is live -----------------
{
  const d = new SubagentDriftTracker();
  d.recordStart("h1");
  const healthy = d.recordAttribution("h1", "confirmed-subagent");
  check("HEALTHY: confirmed-subagent while live -> confirmedSubagent bumps", healthy.confirmedSubagent === 1);
  check("HEALTHY: confirmed-subagent while live -> blindWhileLive stays 0", healthy.blindWhileLive === 0);
  check("HEALTHY: confirmed-subagent while live -> not flagged as a blind event", healthy.blindEvent === false);
  const stopped = d.recordStop("h1");
  check("HEALTHY: live count returns to 0 once the sub-agent stops", stopped.live === 0);
}

// --- BLIND: agent_id is ABSENT on a watched-tool call made while a sub-agent is live (the drift itself) -
{
  const d = new SubagentDriftTracker();
  d.recordStart("b1");
  const blind = d.recordAttribution("b1", "confirmed-main"); // agent_id failed to arrive
  check("BLIND: confirmed-main while live -> blindWhileLive bumps", blind.blindWhileLive === 1);
  check("BLIND: confirmed-main while live -> flagged as a blind event", blind.blindEvent === true);
  check("BLIND: confirmed-main while live -> confirmedSubagent stays 0", blind.confirmedSubagent === 0);
}

// --- ⭐⭐ THE DISCRIMINATION ITSELF: identical lifecycle shape, only agent_id presence differs, and the
// tracker's own output DIFFERS between the two — this is the DoD-2 bar, not merely "does it fire" -------
{
  const healthyTracker = new SubagentDriftTracker();
  healthyTracker.recordStart("same-shape");
  const healthyResult = healthyTracker.recordAttribution("same-shape", "confirmed-subagent");

  const blindTracker = new SubagentDriftTracker();
  blindTracker.recordStart("same-shape");
  const blindResult = blindTracker.recordAttribution("same-shape", "confirmed-main");

  check("SAME lifecycle shape (one SubagentStart, one watched-tool call while live) produces a DIFFERENT blindEvent between healthy and blind",
    healthyResult.blindEvent !== blindResult.blindEvent);
  check("...and a DIFFERENT blindWhileLive count", healthyResult.blindWhileLive !== blindResult.blindWhileLive);
}

// --- ⭐⭐ THE COMMON CASE (the predecessor's actual bug): a sub-agent runs but NEVER calls a watched tool.
// The original detector alarmed here (stops>0, confirmedSubagent===0). The redesigned one must NOT — in
// this case there is genuinely no data to discriminate on, in EITHER healthy or blind operation, and it
// must read the same (silent) in both, rather than reading as an alarm regardless of ground truth.
{
  const healthyNoCall = new SubagentDriftTracker();
  healthyNoCall.recordStart("quiet-h");
  const healthyStopped = healthyNoCall.recordStop("quiet-h"); // sub-agent ran and stopped; never called a watched tool
  check("COMMON CASE (healthy ground truth): a quiet sub-agent -> blindWhileLive stays 0, not a false alarm",
    healthyStopped.blindWhileLive === 0);
  check("COMMON CASE (healthy ground truth): stops still counts the real lifecycle event", healthyStopped.stops === 1);

  const blindNoCall = new SubagentDriftTracker();
  blindNoCall.recordStart("quiet-b");
  const blindStopped = blindNoCall.recordStop("quiet-b"); // same shape, but agent_id would ALSO never have been asked for
  check("COMMON CASE (blind ground truth, same shape): ALSO reads blindWhileLive===0 — correctly silent, not a guess either way",
    blindStopped.blindWhileLive === 0);
  check("...i.e. the predecessor's exact false-alarm signature (stops>0, confirmedSubagent===0) no longer reads as drift on its own",
    healthyStopped.stops > 0 && healthyStopped.confirmedSubagent === 0 && healthyStopped.blindWhileLive === 0);
}

// --- live count is floored at 0 (a stray SubagentStop with no matching Start can't go negative) -------
{
  const d = new SubagentDriftTracker();
  const stopped = d.recordStop("no-start");
  check("SubagentStop with no prior Start -> live floors at 0, not negative", stopped.live === 0);
}

// --- multiple concurrent sub-agents: live count tracks depth, not just presence ------------------------
{
  const d = new SubagentDriftTracker();
  d.recordStart("multi");
  d.recordStart("multi");
  const whileTwoLive = d.recordAttribution("multi", "unknown");
  check("two concurrent sub-agents live -> an unattributed call while EITHER is live still flags blind", whileTwoLive.blindEvent === true);
  const afterOneStop = d.recordStop("multi");
  check("one Stop only decrements by one -> still live", afterOneStop.live === 1);
  const stillBlind = d.recordAttribution("multi", "ambiguous");
  check("still live after one stop -> a second unattributed call still flags blind", stillBlind.blindEvent === true);
  const afterSecondStop = d.recordStop("multi");
  check("second Stop -> live back to 0", afterSecondStop.live === 0);
  const noLongerLive = d.recordAttribution("multi", "unknown");
  check("once fully stopped -> an unattributed call is no longer flagged (correctly silent, no data to discriminate)", noLongerLive.blindEvent === false);
}

// --- sessions are independent: one session's live sub-agent never taints another's reading -------------
{
  const d = new SubagentDriftTracker();
  d.recordStart("sess-A");
  const crossSession = d.recordAttribution("sess-B", "confirmed-main");
  check("a DIFFERENT session's watched-tool call is never flagged blind off session-A's live sub-agent", crossSession.blindEvent === false);
}

// ====================================================================================================
// --- Card 3cc3b726: two routers sharing a bare tool NAME must not share a queue KEY ------------------
// `memory_write` is registered on BOTH the task router (project memory) and the orchestration router
// (companion-private memory), and a companion session mounts both on the SAME sessionId. Prove the
// FAILURE mode first (bare keying really does let one router's call steal the other's pending entry),
// then prove the FIX (qualifying the key by the full `mcp__<server>__<tool>` name keeps them isolated) —
// a control that never demonstrated the failure would be an unfalsifiable green (see this project's own
// "prove your check can fail" discipline).
// ====================================================================================================

// --- RED: bare-name keying lets loom-orchestration's call destructively consume loom-tasks' entry -----
{
  const t = new ToolAttributionTracker();
  // A subagent's call reaches the task router's memory_write; its PreToolUse hook records under the
  // (pre-fix) BARE key.
  t.record("comp1", "memory_write", { agentId: "sub-task" }, 1_000);
  // Before the task-router request is actually processed, the SAME session's orchestration-router
  // memory_write call (companion's own private-memory tool, unrelated) consumes under the SAME bare key.
  const stolen = t.consume("comp1", "memory_write", 1_005);
  check("RED (bare keying): loom-orchestration's call reads the entry that was really loom-tasks'", stolen.state === "confirmed-subagent" && stolen.agentId === "sub-task");
  // The real loom-tasks request now arrives to find its own entry already gone.
  const starved = t.consume("comp1", "memory_write", 1_010);
  check("RED (bare keying): the real loom-tasks call is left reading unknown — the entry was stolen, not shared", starved.state === "unknown");
}

// --- GREEN: qualifying the key by the full mcp__<server>__<tool> name keeps the two routers isolated ---
{
  const t = new ToolAttributionTracker();
  t.record("comp2", "mcp__loom-tasks__memory_write", { agentId: "sub-task" }, 1_000);
  // The orchestration router's OWN memory_write call consumes its OWN qualified key — there is nothing
  // recorded under it (its PreToolUse hook is deliberately not wired — see claude-settings.ts's matcher),
  // so it correctly reads "unknown" instead of stealing loom-tasks' entry.
  const ownQuery = t.consume("comp2", "mcp__loom-orchestration__memory_write", 1_005);
  check("GREEN (qualified keying): loom-orchestration's call never sees loom-tasks' entry", ownQuery.state === "unknown");
  // The real loom-tasks request still finds its own entry intact.
  const preserved = t.consume("comp2", "mcp__loom-tasks__memory_write", 1_010);
  check("GREEN (qualified keying): loom-tasks' own call still resolves its own entry correctly", preserved.state === "confirmed-subagent" && preserved.agentId === "sub-task");
}

// --- GREEN: the reverse direction — loom-tasks never sees a loom-orchestration entry either ------------
{
  const t = new ToolAttributionTracker();
  t.record("comp3", "mcp__loom-orchestration__memory_write", { agentId: "sub-companion" }, 1_000);
  const crossRouter = t.consume("comp3", "mcp__loom-tasks__memory_write", 1_005);
  check("GREEN (qualified keying, reverse direction): loom-tasks' call never sees loom-orchestration's entry", crossRouter.state === "unknown");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmed-subagent/confirmed-main both resolve and consume correctly; unknown, ambiguous, TTL-expiry, cross-tool-name, and burst-depth are all classified honestly rather than folded into a false-definite answer; ambiguous entries are left in place (not drained) and self-resolve only once genuinely stale; the PreToolUse matcher / WATCHED_TOOL_NAMES agree exactly, mechanically, not just by comment; extractWatchedToolCalls is method-gated; isConfirmedSubagent collapses to one predicate; SubagentDriftTracker's redesigned drift tell DISCRIMINATES healthy from blind operation on the identical lifecycle shape, while staying correctly silent (not a false alarm) on the predecessor's own failure signature; and (card 3cc3b726) bare-name keying is PROVEN to let loom-tasks' and loom-orchestration's same-named memory_write tools steal each other's queue entries, while qualifying the key by the full mcp__<server>__<tool> name is PROVEN to keep them isolated in both directions."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
