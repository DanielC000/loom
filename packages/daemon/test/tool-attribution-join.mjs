// Card 3cc3b726 (round 2, manager review): tool-attribution.mjs proves the ToolAttributionTracker keys
// correctly given qualified strings — it does NOT prove the two REAL production sites actually agree on
// WHAT qualified string to use. Those two sites are:
//   - RECORD: `pty/host.ts`'s `deliverHook` PreToolUse case, which now records under `hook.tool_name`
//     verbatim (the full `mcp__<server>__<tool>` string Claude Code's own hook relay reports).
//   - CONSUME: `gateway/server.ts`'s `computeAttributions`, which RECONSTRUCTS that same qualified string
//     as `mcp__${server}__${tool}` from the route it's handling (LOOM_TASKS_SERVER_ID for /mcp/:sessionId,
//     LOOM_ORCHESTRATION_SERVER_ID for /mcp-orch/:sessionId), before calling `consumeToolAttribution`.
//
// If that reconstruction is ever wrong (a rename, a typo, a copy-paste that swaps the two ids), record
// and consume silently stop joining — every attribution reads "unknown" forever, `memory_write`'s
// enforcement silently refuses nothing, and nothing about the daemon's own behavior signals this; it
// looks fully operational (this card's own failure mode, one level up). A unit test against the tracker
// alone (tool-attribution.mjs) cannot catch that, because it never calls either real production function.
//
// HERMETIC + CLAUDE-FREE: real Db, real PtyHost (fake pty via the `createSeamHost()` seam — same fixture
// `hook-cross-session-forge.mjs` uses), and the REAL gateway/server.ts `buildServer()` with the REAL
// TaskMcpRouter mounted. RECORD is driven through the REAL `/internal/hook` HTTP route (`deliverHook`,
// exactly the path a real hook-relay POST takes); CONSUME is driven through the REAL `/mcp/:sessionId`
// route via an actual MCP client `memory_write` call (`computeAttributions`, exactly the path a real
// Claude Code tool call takes) — neither side is hand-simulated or stubbed, so this exercises the ACTUAL
// join, not a replica of it.
//
// RED-PROOF (the negative control IS the falsification, not a manual revert): the positive case alone is
// NOT a valid proof — a `consumeToolAttribution` that always returned "confirmed-subagent" regardless of
// its argument would pass it too. The negative control records under a MISMATCHED server id (the bare
// tool's OTHER real router) and asserts the genuinely-different route's consume reads "unknown" — a
// broken/tautological consume would fail THIS check, only a correctly-keyed join passes both.
//
// Run (after a build): node test/tool-attribution-join.mjs
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-attr-join-");
process.env.LOOM_HOME = TMP;
const PORT = 46229 + (process.pid % 900);
process.env.LOOM_PORT = String(PORT);
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { LOOM_ORCHESTRATION_SERVER_ID } = await import("../dist/pty/tool-attribution.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Captures the REAL per-session hook token spawn() mints — needed to present a valid token to the REAL
// /internal/hook route (mirrors hook-cross-session-forge.mjs's own seam).
const tokensBySessionId = new Map();
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts, hookToken) {
    tokensBySessionId.set(opts.sessionId, hookToken);
    return super.createPty(opts, hookToken);
  }
}

const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });
const SID_POS = "S-join-pos";
const SID_NEG = "S-join-neg";
for (const id of [SID_POS, SID_NEG]) {
  db.insertSession({
    id, projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker",
  });
}

const host = new TestPtyHost({ onEngineSessionId() {}, onBusy() {}, onRateLimited() {}, onExit() {}, onContextStats() {} });

let app;
try {
  host.spawn({ sessionId: SID_POS, cwd: "/x", permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.spawn({ sessionId: SID_NEG, cwd: "/x", permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const tokenPos = tokensBySessionId.get(SID_POS);
  const tokenNeg = tokensBySessionId.get(SID_NEG);
  check("setup: both sessions minted real hook tokens", !!tokenPos && !!tokenNeg);

  const stub = {};
  app = await buildServer({
    db, pty: host, sessions: stub,
    mcp: new TaskMcpRouter(db, {}),
    orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
    control: stub, usageStatus: stub, requestShutdown: () => {},
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address();
  const BASE = `http://127.0.0.1:${port}`;

  const postHook = (sessionId, hook, token) => app.inject({
    method: "POST", url: "/internal/hook", remoteAddress: "127.0.0.1",
    payload: { sessionId, hook, token },
  });

  async function callMemoryWrite(sessionId, key) {
    const client = new Client({ name: "attr-join-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${sessionId}`)));
    const result = await client.callTool({ name: "memory_write", arguments: { key, text: "hello" } });
    await client.close();
    return JSON.parse(result.content?.[0]?.text ?? "{}");
  }

  // ============================ POSITIVE: the join must actually resolve ============================
  // RECORD via the REAL /internal/hook route, using the qualified name deliverHook is documented to
  // record verbatim, exactly as Claude Code's own hook relay would report for a REAL loom-tasks call.
  const posHook = await postHook(SID_POS, { hook_event_name: "PreToolUse", tool_name: "mcp__loom-tasks__memory_write", agent_id: "sub-pos", agent_type: "Explore" }, tokenPos);
  check("setup: the PreToolUse hook itself was accepted (200)", posHook.statusCode === 200);
  // CONSUME via the REAL /mcp/:sessionId route — gateway/server.ts's own computeAttributions runs for
  // real here, reconstructing whatever qualified key its code actually produces for this route.
  const posResult = await callMemoryWrite(SID_POS, "k-pos");
  check(
    "JOIN (positive): record(mcp__loom-tasks__memory_write) via deliverHook + consume via the REAL /mcp/:sessionId route -> the call is REFUSED, i.e. the join resolved to confirmed-subagent, not unknown",
    typeof posResult.error === "string" && posResult.error.includes("Explore"),
  );

  // ======================= NEGATIVE CONTROL: mismatched server id must NOT join =======================
  // Records under the OTHER real router's qualified name for the SAME bare tool (loom-orchestration's
  // companion-private memory_write) — a genuinely different key from what /mcp/:sessionId's own consume
  // reconstructs (loom-tasks). If gateway/server.ts's reconstruction were broken in a way that made it
  // resolve ANY entry regardless of server id (e.g. a stray bare-name fallback, or a hardcoded constant
  // that silently collapsed both ids to the same string), this call would ALSO be refused — exactly the
  // failure the positive check alone cannot catch. A correct join must read "unknown" here instead.
  check("setup: the mismatched server id is genuinely the OTHER real router's id, not a typo of loom-tasks", LOOM_ORCHESTRATION_SERVER_ID === "loom-orchestration");
  const negHook = await postHook(SID_NEG, { hook_event_name: "PreToolUse", tool_name: `mcp__${LOOM_ORCHESTRATION_SERVER_ID}__memory_write`, agent_id: "sub-neg", agent_type: "Explore" }, tokenNeg);
  check("setup: the mismatched-server-id hook was itself accepted (200) — proves it reached record(), not rejected upstream", negHook.statusCode === 200);
  const negResult = await callMemoryWrite(SID_NEG, "k-neg");
  check(
    "JOIN (negative control): a mcp__loom-orchestration__memory_write entry is NOT seen by /mcp/:sessionId's (loom-tasks') consume -> NOT refused (attribution unknown, not confirmed-subagent)",
    negResult.error === undefined,
  );
} finally {
  try { await app?.close(); } catch { /* ignore */ }
  try { host.stop(SID_POS, "hard"); } catch { /* ignore */ }
  try { host.stop(SID_NEG, "hard"); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the attribution queue's record (deliverHook, /internal/hook) and consume " +
    "(computeAttributions, /mcp/:sessionId) sites, driven through their REAL production code paths " +
    "end-to-end, actually agree on the qualified mcp__<server>__<tool> key: a record for loom-tasks' " +
    "memory_write resolves through loom-tasks' own consume, and a mismatched-server-id record " +
    "(loom-orchestration's memory_write) does NOT — proven by a negative control that a tautological " +
    "or broken consume() could not also pass."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
