import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cb369c9d — strictShape() rolled out fleet-wide across mcp/*.ts (beyond worker_transcript, the
// only tool card 6f8742f8 originally converted). This proves the hard-reject behavior on a REPRESENTATIVE
// sample spanning three different MCP routers/surfaces: memory_write + wake_me (TaskMcpRouter, the
// loom-tasks surface every role gets) and session_message (PlatformMcpRouter, the Lead's surface) — an
// unknown/mistyped arg alongside otherwise-valid args is HARD-REJECTED naming the bad key, instead of
// being silently stripped by the SDK's default object-schema STRIP mode and running as if the extra arg
// had never been given at all. Also proves a genuine, fully-valid call still works unaffected under the
// strict schema (no regression).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like arg-name-aliases.mjs / worker-transcript-
// paging.mjs: isolated temp DB(s), the REAL routers driven over in-process MCP InMemoryTransports (no
// HTTP, no external daemon, no pty). `sessions` is a minimal STUB SessionService for the one
// PlatformMcpRouter method session_message actually calls.
//
// Run: 1) build (turbo builds shared first), 2) node test/mcp-strict-args.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function tmpDbFile(tag) {
  return path.join(os.tmpdir(), `loom-strict-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}
function rmDb(file) { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } } }

const { Db } = await import("../dist/db.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

async function connect(server, label) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: label, version: "0" });
  await client.connect(clientT);
  return client;
}

// ============================ memory_write + wake_me (TaskMcpRouter / loom-tasks) ============================
{
  const file = tmpDbFile("tasks");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "pS", name: "Strict Proj", repoPath: "/s", vaultPath: "/s", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentS", projectId: "pS", name: "Mgr", startupPrompt: "", position: 0 });
  db.insertSession({
    id: "S", projectId: "pS", agentId: "agentS", engineSessionId: null, title: null, cwd: "/s",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
  const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

  const server = new TaskMcpRouter(db, wakes).buildServer("pS", "S");
  const client = await connect(server, "mcp-strict-args-tasks-test");
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // ----------------------------- memory_write -----------------------------
  const mwOk = await call("memory_write", { key: "k1", text: "a durable fact" });
  check("memory_write({key,text}) — a genuine valid call still works under the strict schema",
    mwOk.key === "k1" && mwOk.text === "a durable fact" && !mwOk.error);

  const mwBad = await client.callTool({ name: "memory_write", arguments: { key: "k2", text: "hello", bogus: "typo" } });
  check("memory_write({key,text,bogus}) — hard-rejected (isError), not silently run with `bogus` dropped",
    mwBad.isError === true);
  check("memory_write rejection names the bad param `bogus`",
    typeof mwBad.content?.[0]?.text === "string" && mwBad.content[0].text.includes("bogus"));
  check("memory_write rejection also names a real param (key)",
    typeof mwBad.content?.[0]?.text === "string" && mwBad.content[0].text.includes("key"));
  check("memory_write({key,text,bogus}) never wrote key2 (rejected before the handler ran)",
    db.getProjectMemoryByKey("pS", "k2") == null);

  // ----------------------------- wake_me -----------------------------
  const wmOk = await call("wake_me", { delaySeconds: 60, note: "check the build" });
  check("wake_me({delaySeconds,note}) — a genuine valid call still works under the strict schema",
    typeof wmOk.wakeId === "string" && !wmOk.error);

  const wmBad = await client.callTool({ name: "wake_me", arguments: { delaySeconds: 60, note: "x", notes: "typo of note" } });
  check("wake_me({delaySeconds,note,notes}) — hard-rejected (isError), not silently run with `notes` dropped",
    wmBad.isError === true);
  check("wake_me rejection names the bad param `notes`",
    typeof wmBad.content?.[0]?.text === "string" && wmBad.content[0].text.includes("notes"));
  check("wake_me rejection also names a real param (delaySeconds)",
    typeof wmBad.content?.[0]?.text === "string" && wmBad.content[0].text.includes("delaySeconds"));
  check("wake_me({delaySeconds,note,notes}) never scheduled a second wake (rejected before the handler ran)",
    db.countPendingWakes("S") === 1);

  await client.close();
  db.close();
  rmDb(file);
}

// ============================ session_message (PlatformMcpRouter / loom-platform) ============================
{
  const file = tmpDbFile("platform");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "pP", name: "Strict Platform Proj", repoPath: "/p", vaultPath: "/p", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentP", projectId: "pP", name: "Lead", startupPrompt: "", position: 0 });
  db.insertSession({
    id: "LEAD", projectId: "pP", agentId: "agentP", engineSessionId: null, title: null, cwd: "/p",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "platform",
  });

  // Minimal stub: session_message's handler calls exactly ONE SessionService method — mirrors
  // arg-name-aliases.mjs's stub pattern for the OrchestrationMcpRouter surface.
  const calls = { messageSessionAsPlatform: [] };
  const sessions = {
    messageSessionAsPlatform(sessionId, text, callerSessionId) {
      calls.messageSessionAsPlatform.push({ sessionId, text, callerSessionId });
      return { deliveryStatus: "delivered-live" };
    },
  };

  const server = new PlatformMcpRouter(db, /** @type {any} */ (sessions)).buildServer("LEAD");
  const client = await connect(server, "mcp-strict-args-platform-test");
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  const smOk = await call("session_message", { sessionId: "S-target", text: "hello" });
  check("session_message({sessionId,text}) — a genuine valid call still works under the strict schema",
    smOk.deliveryStatus === "delivered-live" && !smOk.error);
  check("session_message({sessionId,text}) — messageSessionAsPlatform was called with the given args",
    calls.messageSessionAsPlatform.length === 1 && calls.messageSessionAsPlatform[0].text === "hello");

  const smBad = await client.callTool({ name: "session_message", arguments: { sessionId: "S-target", text: "hi", body: "typo" } });
  check("session_message({sessionId,text,body}) — hard-rejected (isError), not silently run with `body` dropped",
    smBad.isError === true);
  check("session_message rejection names the bad param `body`",
    typeof smBad.content?.[0]?.text === "string" && smBad.content[0].text.includes("body"));
  check("session_message rejection also names a real param (text)",
    typeof smBad.content?.[0]?.text === "string" && smBad.content[0].text.includes("text"));
  check("session_message({sessionId,text,body}) never reached messageSessionAsPlatform (rejected before the handler ran)",
    calls.messageSessionAsPlatform.length === 1);

  await client.close();
  db.close();
  rmDb(file);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — memory_write, wake_me (loom-tasks) and session_message (loom-platform) each hard-reject a mistyped/unknown extra arg naming the bad key + a real param, instead of the SDK silently stripping it and running as if it were never given; a genuine valid call to each still works unaffected under the strict schema."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
