// Card 8ef582d0: per-call MCP latency + outcome class recorded at the ANSWERING router (mcp/call-record.ts).
// Unit half: instrumentServer against a fake McpServer (registration passed through byte-identically; ok /
// refused / throw / isError classification; leading-whitespace + non-text-first-block safety; a recorder write
// failure is swallowed and counted; bounded buffer drops and counts). Integration half: a REAL TaskMcpRouter
// behind the REAL gateway, driven by a real SDK client, then read back via the human REST route; arguments
// never appear in a row or in the log. Hermetic: temp LOOM_HOME, ephemeral port.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { mcpAuthStub, mcpAuthRequestInit } from "./_mcp-auth.mjs";

const TMP = mkdtempManaged("loom-mcpcall-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(45219 + (process.pid % 900));
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const rec = await import("../dist/mcp/call-record.js");
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const txt = (t) => ({ content: [{ type: "text", text: t }] });

// ---------- (1) classifyToolResult ----------
{
  const c = rec.classifyToolResult;
  check("(1) plain ok payload -> ok", c(txt('{"id":"x"}')).outcome === "ok");
  check("(1) {error} envelope -> refused/envelope", c(txt('{"error":"nope"}')).outcome === "refused" && c(txt('{"error":"nope"}')).errClass === "envelope");
  check("(1) leading whitespace before the envelope still -> refused", c(txt('  \n\t {  "error" : "x"}')).outcome === "refused");
  check("(1) isError:true -> error/is-error", c({ isError: true, content: [] }).outcome === "error" && c({ isError: true, content: [] }).errClass === "is-error");
  check("(1) non-text first block -> ok, no throw", c({ content: [{ type: "image", data: "x" }] }).outcome === "ok");
  check("(1) empty content / undefined / null / string -> ok, no throw", c({ content: [] }).outcome === "ok" && c(undefined).outcome === "ok" && c(null).outcome === "ok" && c("x").outcome === "ok");
  check("(1) text with a LATER error key (not at the top) -> ok", c(txt('{"items":[],"error":"x"}')).outcome === "ok");
  check("(1) hostile getter on result never throws out of classify", (() => { try { c({ get content() { throw new Error("x"); } }); return true; } catch { return false; } })());
}

// ---------- (2) instrumentServer on a fake server ----------
const rows = [];
rec.startMcpCallRecorder((batch) => { rows.push(...batch); });
{
  const registered = [];
  const fake = { registerTool(name, config, cb) { registered.push({ name, config, cb }); return { name }; } };
  rec.instrumentServer(fake, { router: "fake", sessionId: "S1" });
  const cfgA = { description: "d", inputSchema: { a: 1 }, annotations: { readOnlyHint: true } };
  const ret = fake.registerTool("t_ok", cfgA, async (args, extra) => txt(JSON.stringify({ args, extra })));
  fake.registerTool("t_err", {}, async () => txt('{"error":"SECRET-ARG-TEXT"}'));
  fake.registerTool("t_throw", {}, async () => { throw new Error("SECRET-THROW-TEXT"); });
  fake.registerTool("t_iserr", {}, async () => ({ isError: true, content: [{ type: "text", text: "x" }] }));
  check("(2) config object passed through by identity (name/description/inputSchema/annotations untouched)", registered[0].config === cfgA && registered[0].name === "t_ok");
  check("(2) registerTool return value passed through", ret && ret.name === "t_ok");
  const r1 = await registered[0].cb({ q: 1 }, { z: 2 });
  check("(2) handler receives its args unchanged and result is returned unchanged", r1.content[0].text === JSON.stringify({ args: { q: 1 }, extra: { z: 2 } }));
  await registered[1].cb({});
  let thrown = null;
  try { await registered[2].cb({}); } catch (e) { thrown = e; }
  check("(2) a throwing handler still throws the ORIGINAL error to the SDK", thrown && thrown.message === "SECRET-THROW-TEXT");
  await registered[3].cb({});
  rec.flushMcpCalls();
  const by = Object.fromEntries(rows.filter((r) => r.router === "fake").map((r) => [r.tool, r]));
  check("(2) ok row", by.t_ok?.outcome === "ok" && by.t_ok.errClass === null && by.t_ok.sessionId === "S1");
  check("(2) refused row (envelope)", by.t_err?.outcome === "refused" && by.t_err.errClass === "envelope");
  check("(2) throw row (error/throw)", by.t_throw?.outcome === "error" && by.t_throw.errClass === "throw");
  check("(2) isError row", by.t_iserr?.outcome === "error" && by.t_iserr.errClass === "is-error");
  check("(2) durations are non-negative numbers and startedAt is epoch ms", rows.every((r) => r.durationMs >= 0 && r.startedAt > 1.6e12));
  const dump = JSON.stringify(rows);
  check("(2) no argument/result/error text anywhere in the recorded rows", !dump.includes("SECRET") && !dump.includes('"q"'));
  // undefined session (optional-session routers' tools/list build) records nothing
  rows.length = 0;
  const fake2 = { registerTool(name, config, cb) { registered.push({ name, config, cb }); } };
  rec.instrumentServer(fake2, { router: "fake2", sessionId: undefined });
  fake2.registerTool("t_nosess", {}, async () => txt("{}"));
  await registered[registered.length - 1].cb({});
  rec.flushMcpCalls();
  check("(2) sessionId undefined -> nothing recorded", rows.length === 0);
}

// ---------- (3) recorder robustness ----------
{
  rec.stopMcpCallRecorder();
  let calls = 0;
  rec.startMcpCallRecorder(() => { calls++; throw new Error("db down"); });
  rec.recordMcpCall({ sessionId: "s", router: "r", tool: "t", startedAt: 1, durationMs: 1, outcome: "ok", errClass: null });
  let threw = false;
  try { rec.flushMcpCalls(); } catch { threw = true; }
  check("(3) a failing writer is swallowed (flush does not throw) and counted", !threw && calls === 1 && rec.mcpCallStats().writeFailures === 1);
  for (let i = 0; i < rec.MCP_CALL_BUFFER_MAX + 25; i++) rec.recordMcpCall({ sessionId: "s", router: "r", tool: "t", startedAt: 1, durationMs: 1, outcome: "ok", errClass: null });
  const st = rec.mcpCallStats();
  check(`(3) buffer is bounded; overflow dropped and counted (buffered=${st.buffered}, dropped=${st.dropped})`, st.buffered === rec.MCP_CALL_BUFFER_MAX && st.dropped === 25);
  rec.stopMcpCallRecorder();
  rec.recordMcpCall({ sessionId: "s", router: "r", tool: "t", startedAt: 1, durationMs: 1, outcome: "ok", errClass: null });
  check("(3) a stopped recorder buffers nothing", rec.mcpCallStats().buffered === 0);
  // stop flushes (graceful shutdown)
  const got = [];
  rec.startMcpCallRecorder((b) => got.push(...b));
  rec.recordMcpCall({ sessionId: "s", router: "r", tool: "t", startedAt: 1, durationMs: 1, outcome: "ok", errClass: null });
  rec.stopMcpCallRecorder();
  check("(3) stop performs a final flush", got.length === 1);
}

// ---------- (4) real router behind the real gateway + store + REST read ----------
{
  const now = new Date().toISOString();
  const db = new Db(path.join(TMP, "loom.db"));
  db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });
  db.insertSession({ id: "S", projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker" });
  rec.startMcpCallRecorder((batch) => db.insertMcpCalls(batch, rec.MCP_CALL_PER_SESSION_CAP), () => { db.pruneMcpCalls(Date.now() - rec.MCP_CALL_MAX_AGE_MS); });
  const stub = {};
  const ptyAuth = mcpAuthStub();
  const token = ptyAuth.registerTestMcpSession("S");
  const app = await buildServer({
    db, pty: { markMcpSeen: () => {}, ...ptyAuth }, sessions: stub, mcp: new TaskMcpRouter(db, {}), orchMcp: stub,
    platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
    control: stub, usageStatus: stub, requestShutdown: () => {},
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const BASE = `http://127.0.0.1:${app.server.address().port}`;
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.map(String).join(" ")); orig(...a); };
  const client = new Client({ name: "mcp-call-record-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/S`), mcpAuthRequestInit(token)));
  const before = (await client.listTools()).tools.length;
  await client.callTool({ name: "tasks_list", arguments: { limit: 3 } });
  await client.callTool({ name: "tasks_get", arguments: { id: "no-such-card-ZZSECRETZZ" } });
  await client.close();
  console.log = orig;
  const res = await fetch(`${BASE}/api/sessions/S/mcp-calls`);
  const body = await res.json();
  check("(4) REST read 200", res.status === 200 && Array.isArray(body.calls));
  const list = body.calls.find((c) => c.tool === "tasks_list");
  const get = body.calls.find((c) => c.tool === "tasks_get");
  check(`(4) tasks_list recorded ok on router=task (${JSON.stringify(list)})`, list?.outcome === "ok" && list.router === "task" && list.durationMs >= 0);
  check(`(4) tasks_get on a missing card recorded refused/envelope (${JSON.stringify(get)})`, get?.outcome === "refused" && get.errClass === "envelope");
  check("(4) only tools/call is recorded (no initialize/tools/list rows)", body.calls.length === 2 && before > 0);
  check("(4) rows carry only the allowed keys", body.calls.every((c) => Object.keys(c).sort().join() === "durationMs,errClass,id,outcome,router,startedAt,tool"));
  check("(4) response carries recorder counters", body.dropped === 0 && body.writeFailures === 0);
  check("(4) argument text never reaches the row store or the log", !JSON.stringify(body).includes("ZZSECRETZZ") && !logs.join("\n").includes("ZZSECRETZZ"));
  check("(4) unknown session -> 404", (await fetch(`${BASE}/api/sessions/nope/mcp-calls`)).status === 404);
  check("(4) bad limit -> 400", (await fetch(`${BASE}/api/sessions/S/mcp-calls?limit=abc`)).status === 400);
  check("(4) limit=1 honoured", (await (await fetch(`${BASE}/api/sessions/S/mcp-calls?limit=1`)).json()).calls.length === 1);

  // retention: per-session cap, age prune, and session-delete cascade
  db.insertMcpCalls(Array.from({ length: 30 }, (_, i) => ({ sessionId: "S", router: "task", tool: "t" + i, startedAt: Date.now(), durationMs: 1, outcome: "ok", errClass: null })), 10);
  check("(4) per-session cap trims to the newest N", db.listMcpCalls("S", 500).length === 10 && db.listMcpCalls("S", 1)[0].tool === "t29");
  db.insertMcpCalls([{ sessionId: "S", router: "task", tool: "old", startedAt: 1000, durationMs: 1, outcome: "ok", errClass: null }], 500);
  check("(4) age prune removes only old rows", db.pruneMcpCalls(Date.now() - rec.MCP_CALL_MAX_AGE_MS) === 1 && db.listMcpCalls("S", 500).length === 10);
  db.deleteSession("S");
  check("(4) deleteSession sweeps the session's call rows", db.listMcpCalls("S", 500).length === 0);

  rec.stopMcpCallRecorder();
  await app.close();
  db.close();
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
