// Diagnostic-only regression guard (board investigation 4248a527): OrchestrationMcpRouter.handle()'s
// `res.on("close")` path now console.warns when a /mcp-orch request's connection drops before the
// response completes (a silent-drop recurrence would otherwise be invisible server-side), but must stay
// SILENT on a normal completed request (no log spam). HERMETIC like my-context-gate.mjs: isolated temp
// DB, imports dist/*, NO real daemon/Fastify — wires a bare node:http server around router.handle()
// directly (mirrors gateway/server.ts's `/mcp-orch/:sessionId` hijack-straight-to-router wiring).
//
// The abort case is made DETERMINISTIC, not a timing race: the test buffers every response write/end
// for the tool call and only flushes them on a delayed timer, so the client's abort always lands well
// before the server would have finished responding — no reliance on real-world socket-close timing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function tmpDbFile(tag) {
  return path.join(os.tmpdir(), `loom-orch-abort-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}
function rmDb(file) { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } } }

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

function seedDb(file) {
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });
  db.insertSession({
    id: "M", projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  return db;
}

// Wires a bare http server straight to router.handle(), same shape as gateway/server.ts's
// `app.all("/mcp-orch/:sessionId", ...)` route (hijack the raw req/res to the router). `onBody` lets a
// test inspect/react to each parsed JSON-RPC body — e.g. to stall only the tools/call response, never
// the client's own initialize handshake.
function startServer(router, sessionId, onBody) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    if (onBody) onBody(body, res);
    await router.handle(req, res, sessionId, body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Buffers every write/end on `res` and only replays them after `ms` — so `res.writableEnded` stays
// false (the production check's signal for "not yet completed") until the timer fires, regardless of
// whether the transport writes the body via write()+end() or a single end(body) call.
function stallResponse(res, ms) {
  const realWrite = res.write.bind(res);
  const realEnd = res.end.bind(res);
  const queued = [];
  res.write = (...args) => { queued.push(() => realWrite(...args)); return true; };
  res.end = (...args) => {
    queued.push(() => realEnd(...args));
    setTimeout(() => { for (const fn of queued) fn(); }, ms);
  };
}

function captureWarnings() {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  return { warnings, restore: () => { console.warn = original; } };
}

// ============================ (1) normal completed request → NO abort warning ============================
{
  const file = tmpDbFile("normal");
  const db = seedDb(file);
  const router = new OrchestrationMcpRouter(db, {});
  const server = await startServer(router, "M");
  const { port } = server.address();
  const cap = captureWarnings();

  const client = new Client({ name: "orch-abort-warn-normal", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp-orch/M`)));
  const result = await client.callTool({ name: "my_context", arguments: {} });
  const parsed = JSON.parse(result.content[0].text);
  check("(1) a normal tools/call completes and returns my_context's payload", "ctxInputTokens" in parsed);
  await client.close();
  await new Promise((r) => setTimeout(r, 50)); // let the server-side res 'close' fire before we check

  cap.restore();
  check("(1) a NORMALLY completed request logs NO diagnostic warning",
    !cap.warnings.some((w) => /aborted/i.test(w)));

  await new Promise((r) => server.close(r));
  db.close();
  rmDb(file);
}

// ================== (2) client aborts mid-request → exactly one warning, naming the sessionId ==================
{
  const file = tmpDbFile("abort");
  const db = seedDb(file);
  const router = new OrchestrationMcpRouter(db, {});
  const server = await startServer(router, "M", (body, res) => {
    if (body?.method === "tools/call") stallResponse(res, 300); // only stall the call under test
  });
  const { port } = server.address();
  const cap = captureWarnings();

  const client = new Client({ name: "orch-abort-warn-abort", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp-orch/M`)));

  const callPromise = client.callTool({ name: "my_context", arguments: {} });
  const abortTimer = new Promise((r) => setTimeout(r, 30)).then(() => client.close().catch(() => {}));
  let threw = false;
  try { await callPromise; } catch { threw = true; }
  await abortTimer;
  check("(2) the client-aborted call never resolves normally on the client side", threw);

  await new Promise((r) => setTimeout(r, 100)); // let the server-side res 'close' fire (well before the 300ms stall)

  cap.restore();
  const aborted = cap.warnings.filter((w) => /aborted/i.test(w));
  check(`(2) an ABORTED request logs exactly one diagnostic warning (got ${JSON.stringify(cap.warnings)})`,
    aborted.length === 1);
  check("(2) the warning names the sessionId (M)", aborted.length === 1 && aborted[0].includes("sessionId=M"));
  check("(2) the warning names the in-flight method (tools/call)",
    aborted.length === 1 && aborted[0].includes("method=tools/call"));
  check("(2) the warning names the in-flight tool (my_context)",
    aborted.length === 1 && aborted[0].includes("tool=my_context"));

  await new Promise((r) => setTimeout(r, 350)); // let the stalled real write/end flush so the server can close cleanly
  await new Promise((r) => server.close(r));
  db.close();
  rmDb(file);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — /mcp-orch warns (sessionId + in-flight method/tool) ONLY on an aborted/incomplete request, and stays silent on a normal completed one."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
