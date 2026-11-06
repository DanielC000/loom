// Card 3bbc5533: a watched tool repeated within ONE MCP request body (a JSON-RPC batch) must not be over-attributed.
// computeAttributions consumes at most once per (session, tool) and stores one result under the bare name, which
// every call to that tool in the body shares; with ONE pending PreToolUse entry and TWO calls, the second is really
// unknown. The fix stores "ambiguous" for a bare name that appears more than once in the body.
// Drives the REAL path (real PtyHost seam, real /internal/hook, real /mcp/:sessionId, real recorder + Db, REST read-back).
// Asserts:
//   - batch of 2x memory_write + ONE pending entry (even a sub-agent one) -> BOTH call-log rows "ambiguous", no agent fields;
//   - control: batch of two DIFFERENT watched tools (memory_write + memory_forget), one pending entry each ->
//     independent results (confirmed-subagent / confirmed-main), unchanged by the fix;
//   - control: a single call still reads confirmed-subagent.
// Hermetic: temp LOOM_HOME, ephemeral port. Run (after a build): node test/mcp-batch-repeated-watched-tool.mjs
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-mcpbatch-");
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
const SIDS = { dup: "S-dup", diff: "S-diff", single: "S-single", two: "S-two" };
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
  const rpc = (id, name) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: name === "memory_forget" ? { key: "k" } : { key: "k", text: "hello" } } });
  const postBody = async (sessionId, body) => {
    const res = await fetch(`${BASE}/mcp/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${mcpTokens.get(sessionId)}` },
      body: JSON.stringify(body),
    });
    await res.text();
    return res.status;
  };
  const rowsFor = async (sessionId, tool) => {
    const body = await (await fetch(`${BASE}/api/sessions/${sessionId}/mcp-calls`)).json();
    return body.calls.filter((c) => c.tool === tool);
  };

  // Case 1: ONE pending sub-agent entry, a batch carrying TWO memory_write calls.
  check("setup: dup hook accepted", (await postHook(SIDS.dup, { hook_event_name: "PreToolUse", tool_name: "mcp__loom-tasks__memory_write", agent_id: "sub-1", agent_type: "Explore" })).statusCode === 200);
  const dupStatus = await postBody(SIDS.dup, [rpc(1, "memory_write"), rpc(2, "memory_write")]);
  const dup = await rowsFor(SIDS.dup, "memory_write");
  check(`batch POST accepted (status ${dupStatus}) and BOTH calls logged (${dup.length})`, dupStatus === 200 && dup.length === 2);
  check(`both repeated-tool rows are ambiguous, never confirmed-* (${JSON.stringify(dup.map((c) => c.attribution))})`, dup.length === 2 && dup.every((c) => c.attribution === "ambiguous" && c.agentId === null && c.agentType === null));

  // Case 1b: the batch's single consume DRAINED the one pending entry — a follow-up single call with no new hook reads
  // "unknown" (not an inherited confirmed-subagent).
  await postBody(SIDS.dup, [rpc(3, "memory_write")]);
  const dupAfter = await rowsFor(SIDS.dup, "memory_write");
  check(`follow-up single call after the drain reads unknown (${JSON.stringify(dupAfter.map((c) => c.attribution))})`, dupAfter.length === 3 && dupAfter.filter((c) => c.attribution === "unknown").length === 1);

  // Case 1c: the realistic shape — TWO pending entries, a batch of TWO same-tool calls -> ambiguous for both.
  const h2 = { hook_event_name: "PreToolUse", tool_name: "mcp__loom-tasks__memory_write" };
  await postHook(SIDS.two, h2);
  await postHook(SIDS.two, { ...h2, agent_id: "sub-4", agent_type: "Explore" });
  await postBody(SIDS.two, [rpc(1, "memory_write"), rpc(2, "memory_write")]);
  const two = await rowsFor(SIDS.two, "memory_write");
  check(`2 entries / 2 calls -> both ambiguous (${JSON.stringify(two.map((c) => c.attribution))})`, two.length === 2 && two.every((c) => c.attribution === "ambiguous" && c.agentId === null));

  // Case 2 (control): two DIFFERENT watched tools in one batch keep independent results.
  await postHook(SIDS.diff, { hook_event_name: "PreToolUse", tool_name: "mcp__loom-tasks__memory_write", agent_id: "sub-2", agent_type: "Explore" });
  await postHook(SIDS.diff, { hook_event_name: "PreToolUse", tool_name: "mcp__loom-tasks__memory_forget" });
  await postBody(SIDS.diff, [rpc(1, "memory_write"), rpc(2, "memory_forget")]);
  const w = (await rowsFor(SIDS.diff, "memory_write"))[0];
  const f = (await rowsFor(SIDS.diff, "memory_forget"))[0];
  check(`different tools stay independent: memory_write=confirmed-subagent/sub-2, memory_forget=confirmed-main (${JSON.stringify([w?.attribution, w?.agentId, f?.attribution])})`,
    w?.attribution === "confirmed-subagent" && w.agentId === "sub-2" && f?.attribution === "confirmed-main");

  // Case 3 (control): a single call is untouched.
  await postHook(SIDS.single, { hook_event_name: "PreToolUse", tool_name: "mcp__loom-tasks__memory_write", agent_id: "sub-3", agent_type: "Explore" });
  await postBody(SIDS.single, [rpc(1, "memory_write")]);
  const s = (await rowsFor(SIDS.single, "memory_write"))[0];
  check(`single call in a batch -> confirmed-subagent (${JSON.stringify(s?.attribution)})`, s?.attribution === "confirmed-subagent" && s.agentId === "sub-3");
} finally {
  try { await app?.close(); } catch { /* ignore */ }
  for (const id of Object.values(SIDS)) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
  rec.stopMcpCallRecorder();
  try { db.close(); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
