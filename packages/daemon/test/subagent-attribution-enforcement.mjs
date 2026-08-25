// Card 8d158088 — the ENFORCEMENT half of cd0c7fee's correlation mechanism: memory_write refuses ONLY a
// POSITIVELY CONFIRMED sub-agent call; worker_report NEVER refuses (attribute-and-allow, always) since it
// is a worker's ONLY channel up and a wrongful refusal would strand it with no way to report at all. Both
// "unknown" and "ambiguous" (the two correlation-FAILURE states) MUST fail open for BOTH tools — that is
// the non-negotiable rule this test is red-proofing (CLAUDE.md, card 8d158088's own DoD-2).
//
// Driven end-to-end through the REAL gateway/server.ts buildServer() + a REAL @modelcontextprotocol/sdk
// client over a REAL http.listen() socket (mirrors mcp-inbound-log.mjs's harness) — this exercises the
// ACTUAL thread-don't-requery path (gateway/server.ts computes attribution once, threads it through
// TaskMcpRouter.handle/OrchestrationMcpRouter.handle into the tool handlers), not a hand-rolled replica
// that could silently diverge from the real wiring. `pty.consumeToolAttribution` is stubbed so each test
// case can dictate exactly which ToolAttributionResult the handler sees, independent of the real
// PreToolUse-correlation timing tool-attribution.mjs already covers in isolation.
//
// Run (after a build): node test/subagent-attribution-enforcement.mjs
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-subagent-enforce-");
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

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });
db.insertSession({
  id: "S", projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker",
});

// Controllable stub: whatever this holds is what `deps.pty.consumeToolAttribution` returns for the NEXT
// watched-tool call, regardless of (sessionId, toolName) — each test case sets it immediately before
// making its one client call, so there is never ambiguity about which case a result belongs to.
let nextAttribution;
const pty = { markMcpSeen: () => {}, consumeToolAttribution: () => nextAttribution };

// Captures whatever OrchestrationMcpRouter's worker_report handler actually passed through to
// sessions.workerReport — the thing under test for the attribute-and-allow path (never the refusal path;
// worker_report has none).
let capturedReport;
const sessions = {
  workerReport: async (sessionId, report) => {
    capturedReport = report;
    return { reported: true, deliveryStatus: "delivered-live" };
  },
};

const stub = {};
const app = await buildServer({
  db, pty, sessions,
  mcp: new TaskMcpRouter(db, {}),
  orchMcp: new OrchestrationMcpRouter(db, sessions),
  platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
  control: stub, usageStatus: stub, requestShutdown: () => {},
});
await app.listen({ port: 0, host: "127.0.0.1" });
const { port } = app.server.address();
const BASE = `http://127.0.0.1:${port}`;

async function callMemoryWrite(key, text) {
  const client = new Client({ name: "subagent-enforce-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/S`)));
  const result = await client.callTool({ name: "memory_write", arguments: { key, text } });
  await client.close();
  return result;
}

async function callWorkerReport(summary) {
  const client = new Client({ name: "subagent-enforce-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp-orch/S`)));
  const result = await client.callTool({ name: "worker_report", arguments: { status: "progress", summary } });
  await client.close();
  return result;
}

function toolJson(result) {
  return JSON.parse(result.content?.[0]?.text ?? "{}");
}

async function memoryKeyExists(key) {
  const client = new Client({ name: "subagent-enforce-test-read", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/S`)));
  const result = await client.callTool({ name: "memory_read", arguments: { key } });
  await client.close();
  const parsed = toolJson(result);
  return !parsed.error;
}

// ============================ memory_write: fail-open on both correlation-failure states ============================
{
  nextAttribution = { state: "unknown" };
  const r = toolJson(await callMemoryWrite("k-unknown", "hello"));
  check("(memory_write) 'unknown' attribution -> NOT refused (no error)", r.error === undefined);
  check("(memory_write) 'unknown' -> the note was actually written", await memoryKeyExists("k-unknown"));
}
{
  nextAttribution = { state: "ambiguous", candidateCount: 2 };
  const r = toolJson(await callMemoryWrite("k-ambiguous", "hello"));
  check("(memory_write) 'ambiguous' attribution -> NOT refused (no error)", r.error === undefined);
  check("(memory_write) 'ambiguous' -> the note was actually written", await memoryKeyExists("k-ambiguous"));
}
{
  nextAttribution = { state: "confirmed-main" };
  const r = toolJson(await callMemoryWrite("k-main", "hello"));
  check("(memory_write) 'confirmed-main' attribution -> NOT refused (no error)", r.error === undefined);
  check("(memory_write) 'confirmed-main' -> the note was actually written", await memoryKeyExists("k-main"));
}

// ============================ memory_write: the ONE state that DOES refuse ============================
{
  nextAttribution = { state: "confirmed-subagent", agentId: "sub-1", agentType: "Explore" };
  const r = toolJson(await callMemoryWrite("k-subagent", "hello"));
  check("(memory_write) 'confirmed-subagent' attribution -> REFUSED (error present)", typeof r.error === "string");
  check("(memory_write) refusal names the sub-agent's agentType", r.error?.includes("Explore"));
  check("(memory_write) 'confirmed-subagent' -> the note was NOT written (refusal is real, not cosmetic)", !(await memoryKeyExists("k-subagent")));
}

// ============================ worker_report: NEVER refuses, on ANY attribution state (the non-negotiable rule) ============================
for (const [label, attribution] of [
  ["unknown", { state: "unknown" }],
  ["ambiguous", { state: "ambiguous", candidateCount: 2 }],
  ["confirmed-main", { state: "confirmed-main" }],
  ["confirmed-subagent", { state: "confirmed-subagent", agentId: "sub-2", agentType: "general-purpose" }],
]) {
  nextAttribution = attribution;
  capturedReport = undefined;
  const r = toolJson(await callWorkerReport(`report under ${label}`));
  check(`(worker_report) '${label}' attribution -> call SUCCEEDS (no refusal field, reported:true)`, r.reported === true && r.refused === undefined);
  check(`(worker_report) '${label}' -> the SAME attribution was threaded through to sessions.workerReport`,
    capturedReport?.subagentAttribution?.state === attribution.state);
}

await app.close();
db.close();

console.log(failures === 0
  ? "\n✅ ALL PASS — memory_write refuses ONLY a confirmed-subagent call and fails open on unknown/ambiguous/confirmed-main; worker_report never refuses on any attribution state, and threads the real result through to sessions.workerReport for the durable-record surface."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
