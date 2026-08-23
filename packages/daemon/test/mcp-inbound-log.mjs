// Card 98c4a651: MCP tool calls were the only inbound path with NO log trace — pty writes get
// `[pty-write]`, hooks get `[hook]`/`[submit]`, MCP got nothing (re-verified 2026-08-23: `Grep '\[mcp[-\]]'
// packages/daemon/src` → 0 matches, positive-controlled against `\[hook\]|\[pty-write\]|\[submit\]` → 27
// matches in pty/host.ts — the gap was still open when this test was written). This proves the fix:
// mcp/inbound-log.ts's `logInboundMcpRequest`, wired into gateway/server.ts's REAL route handlers (not a
// hand-mirrored replica — this test boots the ACTUAL buildServer()), emits one `[mcp]` line per inbound
// MCP HTTP request, driven by a REAL @modelcontextprotocol/sdk client over a REAL http.listen() socket —
// the positive control the card's own DoD-3 demands ("a shipped-but-silent logger is precisely the
// failure mode this card exists to end... the line appearing in the actual log output is the control").
//
// Covers TWO of the four routers named in the card (/mcp, /mcp-orch) end-to-end through gateway/server.ts
// — the other two (/mcp-platform, /mcp-setup) share the exact same one-line call in the exact same file,
// wired identically (see gateway/server.ts), so are not independently re-exercised here; that equivalence
// is what the shared-chokepoint choice buys. Also asserts the line's SHAPE never carries tool arguments —
// only length + a non-reversible hash — per card 16c93a50's still-open (unanswered) content-in-durable-
// logs policy: this instrument stays on the identity/shape side of that line regardless of what 16c93a50
// eventually decides. Hermetic like gateway-hardening.mjs: buildServer() + a real ephemeral TCP port, no
// external daemon, temp LOOM_HOME.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-mcplog-");
process.env.LOOM_HOME = TMP;
const PORT = 45219 + (process.pid % 900); // cosmetic only — the test binds an ephemeral port (listen(0))
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

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function captureLogs() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); original(...args); };
  return { lines, restore: () => { console.log = original; } };
}

const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });
db.insertSession({
  id: "S", projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker",
});
db.insertSession({
  id: "M", projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

const stub = {};
const app = await buildServer({
  db, pty: { markMcpSeen: () => {} }, sessions: stub,
  mcp: new TaskMcpRouter(db, {}), // wakes stub — untouched by tasks_list, the only tool this test calls on it
  orchMcp: new OrchestrationMcpRouter(db, {}),
  platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
  control: stub, usageStatus: stub, requestShutdown: () => {},
});
await app.listen({ port: 0, host: "127.0.0.1" });
const { port } = app.server.address();
const BASE = `http://127.0.0.1:${port}`;

// ============================ (1) /mcp/:sessionId (loom-tasks, TaskMcpRouter) ============================
{
  const client = new Client({ name: "mcp-log-test-task", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/S`)));
  // Capture starts AFTER the initialize handshake — connect() itself sends its own initialize +
  // notifications/initialized requests, each producing their own [mcp] line (see test (3) below), which
  // would otherwise pollute an "exactly one line" assertion scoped to the tools/call below.
  const cap = captureLogs();
  const result = await client.callTool({ name: "tasks_list", arguments: { limit: 5 } });
  check("(1) the real tool call itself still succeeds (tasks_list responds)", Array.isArray(result.content));
  await client.close();
  await new Promise((r) => setTimeout(r, 30));
  cap.restore();

  // The transport also lazily opens its server-push GET stream around this same call (an unrelated
  // `method=-` line, no body) — so select the tools/call line specifically rather than assume it's alone.
  const mcpLines = cap.lines.filter((l) => l.startsWith("[mcp] "));
  const callLines = mcpLines.filter((l) => l.includes("method=tools/call"));
  check(`(1) exactly one [mcp] line for the tools/call request (got ${callLines.length} of ${mcpLines.length} total: ${JSON.stringify(mcpLines)})`,
    callLines.length === 1);
  const line = callLines[0] ?? "";
  check("(1) line names the real sessionId (S)", line.includes(" S router="));
  check("(1) line names router=task", line.includes("router=task"));
  check("(1) line names method=tools/call", line.includes("method=tools/call"));
  check("(1) line names tool=tasks_list", line.includes("tool=tasks_list"));
  check("(1) line carries argsLen (a length, not the arguments text)", /argsLen=\d+/.test(line));
  check("(1) line carries a non-empty argsHash, not the raw args", /argsHash=[0-9a-f]{6,}/.test(line));
  check("(1) line does NOT leak the raw serialized arguments (no JSON braces or the field name 'limit')",
    !line.includes("{") && !line.includes("limit"));
  check("(1) line carries a monotonic seq=", /seq=\d+/.test(line));
  check("(1) line carries an ISO timestamp", /at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line));
}

// ============================ (2) /mcp-orch/:sessionId (loom-orchestration, OrchestrationMcpRouter) ============================
{
  const client = new Client({ name: "mcp-log-test-orch", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp-orch/M`)));
  const cap = captureLogs(); // see (1) — capture only the tools/call, not the initialize handshake
  const result = await client.callTool({ name: "my_context", arguments: {} });
  check("(2) the real tool call itself still succeeds (my_context responds)", Array.isArray(result.content));
  await client.close();
  await new Promise((r) => setTimeout(r, 30));
  cap.restore();

  const mcpLines = cap.lines.filter((l) => l.startsWith("[mcp] "));
  const callLines = mcpLines.filter((l) => l.includes("method=tools/call"));
  check(`(2) exactly one [mcp] line for the tools/call request (got ${callLines.length} of ${mcpLines.length} total: ${JSON.stringify(mcpLines)})`,
    callLines.length === 1);
  const line = callLines[0] ?? "";
  check("(2) line names the real sessionId (M)", line.includes(" M router="));
  check("(2) line names router=orchestration", line.includes("router=orchestration"));
  check("(2) line names tool=my_context", line.includes("tool=my_context"));
}

// ============================ (3) a non-tools/call request (e.g. tools/list) still logs, with tool=- ============================
{
  const cap = captureLogs();
  const client = new Client({ name: "mcp-log-test-list", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/S`)));
  await client.listTools();
  await client.close();
  await new Promise((r) => setTimeout(r, 30));
  cap.restore();

  // initialize + tools/list both traverse the route — at least one line, and none of them ever crash on a
  // request with no params.arguments (method != tools/call).
  const mcpLines = cap.lines.filter((l) => l.startsWith("[mcp] "));
  check(`(3) non-tools/call MCP requests (initialize/tools/list) also produce [mcp] lines (got ${mcpLines.length})`,
    mcpLines.length >= 1);
  check("(3) a tools/list line names method=tools/list with tool=-",
    mcpLines.some((l) => l.includes("method=tools/list") && l.includes("tool=-")));
}

await app.close();
db.close();

console.log(failures === 0
  ? "\n✅ ALL PASS — MCP inbound requests now emit an [mcp] log line (identity/shape only) across both routers exercised."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
