// Card bcef7e48: the per-call MCP log (mcp_call_log, card 8ef582d0) carries the sub-agent attribution the
// gateway already computes. Drives the REAL path end to end, claude-free: a real PtyHost (fake pty via the
// seam host) receives a real PreToolUse hook through the REAL /internal/hook route; a real MCP client then
// calls the tool through the REAL /mcp/:sessionId route (gateway computeAttributions -> TaskMcpRouter.handle ->
// buildServer -> instrumentServer); the recorder writes into a real Db and the row is read back through the
// REAL human REST route. Asserts:
//   - a call whose PreToolUse carried agent_id is stored as confirmed-subagent WITH agentId/agentType;
//   - a call whose PreToolUse had no agent_id is stored as confirmed-main (and ONLY that is "session");
//   - a watched call with no hook entry is stored as "unknown", never confirmed-main;
//   - an UNWATCHED tool is stored as null ("not tracked"), never confirmed-main;
//   - an old-shape mcp_call_log table (pre-migration, no attribution columns, with rows) upgrades in place:
//     columns added, old rows read null, new rows round-trip.
// Hermetic: temp LOOM_HOME, ephemeral port.
// Run (after a build): node test/mcp-call-attribution.mjs
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { mcpAuthRequestInit } from "./_mcp-auth.mjs";

const TMP = mkdtempManaged("loom-mcpattr-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(47229 + (process.pid % 900));
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const rec = await import("../dist/mcp/call-record.js");
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const hookTokens = new Map();
const mcpTokens = new Map();
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts, hookToken, mcpToken) {
    hookTokens.set(opts.sessionId, hookToken);
    mcpTokens.set(opts.sessionId, mcpToken);
    return super.createPty(opts, hookToken, mcpToken);
  }
}

const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });
const SIDS = { sub: "S-sub", main: "S-main", unk: "S-unk", amb: "S-amb", orch: "S-orch" };
for (const id of Object.values(SIDS)) {
  db.insertSession({ id, projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker" });
}
rec.startMcpCallRecorder((batch) => db.insertMcpCalls(batch, rec.MCP_CALL_PER_SESSION_CAP));

const host = new TestPtyHost({ onEngineSessionId() {}, onBusy() {}, onRateLimited() {}, onExit() {}, onContextStats() {} });
let app;
try {
  for (const id of Object.values(SIDS)) {
    host.spawn({ sessionId: id, cwd: "/x", permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  }
  const stub = {};
  const sessionsStub = { workerReport: async () => ({ reported: true, deliveryStatus: "delivered-live" }) };
  app = await buildServer({
    db, pty: host, sessions: sessionsStub, mcp: new TaskMcpRouter(db, {}),
    orchMcp: new OrchestrationMcpRouter(db, sessionsStub), platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
    control: stub, usageStatus: stub, requestShutdown: () => {},
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const BASE = `http://127.0.0.1:${app.server.address().port}`;

  const postHook = (sessionId, hook) => app.inject({ method: "POST", url: "/internal/hook", remoteAddress: "127.0.0.1", payload: { sessionId, hook, token: hookTokens.get(sessionId) } });
  const call = async (sessionId, name, args, mount = "mcp") => {
    const client = new Client({ name: "mcp-call-attr-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/${mount}/${sessionId}`), mcpAuthRequestInit(mcpTokens.get(sessionId))));
    await client.callTool({ name, arguments: args });
    await client.close();
  };
  const rowFor = async (sessionId, tool) => {
    const body = await (await fetch(`${BASE}/api/sessions/${sessionId}/mcp-calls`)).json();
    return body.calls.find((c) => c.tool === tool);
  };

  check("setup: hooks accepted", (await postHook(SIDS.sub, { hook_event_name: "PreToolUse", tool_name: "mcp__loom-tasks__memory_write", agent_id: "sub-1", agent_type: "Explore" })).statusCode === 200
    && (await postHook(SIDS.main, { hook_event_name: "PreToolUse", tool_name: "mcp__loom-tasks__memory_write" })).statusCode === 200);

  await call(SIDS.sub, "memory_write", { key: "k-sub", text: "hello" });
  await call(SIDS.main, "memory_write", { key: "k-main", text: "hello" });
  await call(SIDS.unk, "memory_write", { key: "k-unk", text: "hello" });
  await call(SIDS.main, "tasks_list", { limit: 1 });

  const sub = await rowFor(SIDS.sub, "memory_write");
  check(`sub-agent call -> confirmed-subagent with agentId/agentType (${JSON.stringify(sub)})`, sub?.attribution === "confirmed-subagent" && sub.agentId === "sub-1" && sub.agentType === "Explore");
  const main = await rowFor(SIDS.main, "memory_write");
  check(`session call -> confirmed-main, no agent fields (${JSON.stringify(main)})`, main?.attribution === "confirmed-main" && main.agentId === null && main.agentType === null);
  const unk = await rowFor(SIDS.unk, "memory_write");
  check(`watched call with no hook entry -> unknown, NOT confirmed-main (${JSON.stringify(unk)})`, unk?.attribution === "unknown" && unk.agentId === null);
  const unwatched = await rowFor(SIDS.main, "tasks_list");
  check(`unwatched tool -> null (not tracked), NOT confirmed-main (${JSON.stringify(unwatched)})`, unwatched?.attribution === null && unwatched.agentId === null && unwatched.agentType === null);

  // AMBIGUOUS: two pending PreToolUse entries for the same (session, tool), then ONE call. The tracker must not
  // guess; the row reads "ambiguous" and is never confirmed-main (nor confirmed-subagent).
  const ambHook = { hook_event_name: "PreToolUse", tool_name: "mcp__loom-tasks__memory_write" };
  check("setup: two ambiguous-case hooks accepted", (await postHook(SIDS.amb, ambHook)).statusCode === 200 && (await postHook(SIDS.amb, { ...ambHook, agent_id: "sub-amb", agent_type: "Explore" })).statusCode === 200);
  await call(SIDS.amb, "memory_write", { key: "k-amb", text: "hello" });
  const amb = await rowFor(SIDS.amb, "memory_write");
  check(`two pending entries -> ambiguous, NOT confirmed-main (${JSON.stringify(amb)})`, amb?.attribution === "ambiguous" && amb.agentId === null && amb.agentType === null);

  // ORCHESTRATION router (/mcp-orch): a sub-agent's worker_report is recorded as confirmed-subagent on router=orchestration.
  check("setup: orchestration hook accepted", (await postHook(SIDS.orch, { hook_event_name: "PreToolUse", tool_name: "mcp__loom-orchestration__worker_report", agent_id: "sub-orch", agent_type: "general-purpose" })).statusCode === 200);
  await call(SIDS.orch, "worker_report", { status: "progress", summary: "x" }, "mcp-orch");
  const orch = await rowFor(SIDS.orch, "worker_report");
  check(`orchestration sub-agent call -> confirmed-subagent on router=orchestration (${JSON.stringify(orch)})`, orch?.router === "orchestration" && orch.attribution === "confirmed-subagent" && orch.agentId === "sub-orch" && orch.agentType === "general-purpose");

  check("rows carry exactly the documented key set", [sub, main, unk, unwatched, amb, orch].every((c) => Object.keys(c).sort().join() === "agentId,agentType,attribution,durationMs,errClass,id,outcome,router,startedAt,tool"));
} finally {
  try { await app?.close(); } catch { /* ignore */ }
  for (const id of Object.values(SIDS)) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
  rec.stopMcpCallRecorder();
  try { db.close(); } catch { /* ignore */ }
}

// ---------- migration: an OLD-shape table (no attribution columns) with rows upgrades in place ----------
{
  const file = path.join(TMP, "old-shape.db");
  const raw = new Database(file);
  raw.exec(`CREATE TABLE mcp_call_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, router TEXT NOT NULL, tool TEXT NOT NULL,
    started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, outcome TEXT NOT NULL, err_class TEXT);
    CREATE INDEX idx_mcp_call_log_session ON mcp_call_log(session_id, id);
    INSERT INTO mcp_call_log (session_id, router, tool, started_at, duration_ms, outcome, err_class) VALUES ('OLD','task','tasks_list',1700000000000,5,'ok',NULL);`);
  raw.close();
  let upgraded = null;
  let bootError = null;
  try { upgraded = new Db(file); } catch (e) { bootError = e; }
  check(`migration: booting Db on an old-shape table does not throw (${bootError?.message ?? "ok"})`, upgraded !== null);
  if (upgraded) {
    const old = upgraded.listMcpCalls("OLD", 10);
    check("migration: pre-existing row survives and reads null attribution/agent fields", old.length === 1 && old[0].tool === "tasks_list" && old[0].attribution === null && old[0].agentId === null && old[0].agentType === null);
    upgraded.insertMcpCalls([{ sessionId: "OLD", router: "task", tool: "memory_write", startedAt: 1700000000001, durationMs: 1, outcome: "ok", errClass: null, attribution: "confirmed-subagent", agentId: "z", agentType: "T" }], 500);
    const fresh = upgraded.listMcpCalls("OLD", 10)[0];
    check("migration: new row round-trips attribution/agentId/agentType", fresh.attribution === "confirmed-subagent" && fresh.agentId === "z" && fresh.agentType === "T");
    upgraded.close();
    const again = new Db(file); // idempotent second boot
    check("migration: second boot is idempotent", again.listMcpCalls("OLD", 10).length === 2);
    again.close();
  }
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
