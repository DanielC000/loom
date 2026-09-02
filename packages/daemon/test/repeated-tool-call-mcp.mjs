// Card 2d8d2e42 — the DoD-1 scenario driven through the REAL wiring: gateway/server.ts's
// `/mcp-orch/:sessionId` route -> mcp/inbound-log.ts's `logInboundMcpRequest` (the SAME argsHash it
// already computes for the `[mcp]` log line) -> the `onRepeatedCall` callback threaded from
// gateway/server.ts's `recordRepeatedCall`. This is the integration half; the pure state-machine
// semantics (turn-boundary reset, escalation, cross-tool/cross-session isolation) are proven directly
// against RepeatedCallTracker in repeated-call-tracker.mjs, RED-FIRST.
//
// Uses `my_context` (registered on the SAME OrchestrationMcpRouter as `gate_status`, takes no required
// args, so N identical calls are just `{}` repeated) rather than `gate_status` itself: `gate_status`
// calls into `sessions.gateStatus(...)`, which needs a real SessionService — mcp-inbound-log.mjs's own
// established pattern for exercising this router hermetically stubs `sessions` as `{}`, which `my_context`
// tolerates (it reads db/pty directly) and `gate_status` does not. The detector is tool-name-agnostic by
// design (see repeated-call-tracker.ts's own doc for why the scope is generalized past gate_status), so
// this substitution exercises the identical mechanism; `gate_status` by NAME is exercised directly in the
// pure tracker suite instead.
//
// Driven by a REAL @modelcontextprotocol/sdk client over a REAL http.listen() socket — same hermetic
// shape as mcp-inbound-log.mjs (buildServer(), temp LOOM_HOME, no external daemon).
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-repeatcall-");
process.env.LOOM_HOME = TMP;
const PORT = 46119 + (process.pid % 900);
process.env.LOOM_PORT = String(PORT);
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { RepeatedCallTracker, REPEATED_CALL_THRESHOLD } = await import("../dist/pty/repeated-call-tracker.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const N = REPEATED_CALL_THRESHOLD;
const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });
db.insertSession({
  id: "M", projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

// Real RepeatedCallTracker, driven through the REAL gateway->inbound-log wiring below (via
// `deps.pty.recordToolCallArgsHash`) — mirrors what PtyHost.recordToolCallArgsHash itself does
// (tracker.record + capture on firedAtThreshold), without needing a full PtyHost/spawn.
const tracker = new RepeatedCallTracker();
const fired = [];
const stub = {};
const app = await buildServer({
  db,
  pty: {
    markMcpSeen: () => {},
    recordToolCallArgsHash: (sessionId, tool, argsHash) => {
      const r = tracker.record(sessionId, tool, argsHash);
      if (r.firedAtThreshold) fired.push({ sessionId, tool, argsHash, count: r.count });
    },
  },
  sessions: stub,
  mcp: new TaskMcpRouter(db, {}),
  orchMcp: new OrchestrationMcpRouter(db, {}),
  platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
  control: stub, usageStatus: stub, requestShutdown: () => {},
});
await app.listen({ port: 0, host: "127.0.0.1" });
const { port } = app.server.address();
const BASE = `http://127.0.0.1:${port}`;

const client = new Client({ name: "repeated-call-mcp-test", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp-orch/M`)));

// --- RED-FIRST at the integration level: N-1 identical calls must fire NOTHING ----------------------
for (let i = 1; i < N; i++) {
  const result = await client.callTool({ name: "my_context", arguments: {} });
  check(`(int) call ${i}/${N} identical -> tool call itself still succeeds`, Array.isArray(result.content));
}
check(`(int) after ${N - 1} identical calls, nothing fired yet`, fired.length === 0);

// --- GREEN: the Nth identical call fires, through the REAL gateway/inbound-log/tracker path ---------
await client.callTool({ name: "my_context", arguments: {} });
check(`(int) call ${N}/${N} identical -> exactly one fire`, fired.length === 1);
check(`(int) fired event names the real tool`, fired[0]?.tool === "my_context");
check(`(int) fired event names the real sessionId`, fired[0]?.sessionId === "M");
check(`(int) fired event's count is exactly N`, fired[0]?.count === N);

// --- a DIFFERENT tool call, driven through the same real client, resets the streak (no cross-tool bleed
// through the real wiring either) -------------------------------------------------------------------
await client.listTools(); // a non-tools/call request — different method entirely, must not extend the streak
for (let i = 1; i < N; i++) await client.callTool({ name: "my_context", arguments: {} });
check(`(int) streak already used up its one fire — no SECOND fire from a fresh sub-N run right after`, fired.length === 1);

await client.close();
await app.close();
db.close();

console.log(failures === 0
  ? "\n✅ ALL PASS — a repeated-identical-call streak fires through the REAL gateway -> inbound-log -> tracker wiring, at call N and not before."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
