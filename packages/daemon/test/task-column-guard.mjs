import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card columnKey-orphan guard — CREATE side (pairs with e9256a4, which closed the UPDATE/move side).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + the REAL backing task functions
// (createProjectTask/updateProjectTask, the EXACT path the in-project loom-tasks tasks_create/tasks_update
// use) + the REAL Platform router (in-process MCP) for the cross-project project_task_create/update tools.
//
// The bug: createProjectTask stored an EXPLICIT columnKey VERBATIM with NO board-membership check, so a
// typo'd key returned an apparent-success Task that sat OFF-BOARD (Board.tsx filters strictly → invisible).
// The update/move side was already guarded (e9256a4); this closes the create side in the SHARED function, so
// BOTH the in-project tasks_create AND the cross-project project_task_create reject an unknown key identically.
//
// Proves:
//   (1) createProjectTask with a VALID columnKey → stored on that column;
//   (2) createProjectTask with an OMITTED columnKey → lands in the role-resolved defaultLanding lane;
//   (3) createProjectTask with an UNKNOWN columnKey → {error}, and NO card is inserted (not orphaned);
//   (4) the guard honors a CUSTOM/renamed board (resolved columns), not a hardcoded key set;
//   (5) updateProjectTask with an UNKNOWN columnKey is still rejected (e9256a4 — assert not regressed);
//   (6) PLATFORM project_task_create with an UNKNOWN columnKey → {error}, no card; a valid key → created;
//   (7) PLATFORM project_task_update with an UNKNOWN columnKey → {error} (the cross-project move guard).
//
// Run: 1) build (turbo builds shared first), 2) node test/task-column-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-colguard-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45321";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { createProjectTask, updateProjectTask } = await import("../dist/mcp/tasks.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db(path.join(tmpHome, "loom.db"));

// Fake pty (the router's constructor needs a SessionService; no tool here spawns).
class SeamHost extends PtyHost {
  createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());

const parse = (res) => JSON.parse(res.content[0].text);
const connect = async (server) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "colguard-test", version: "0" });
  await client.connect(clientT);
  return async (name, args) => parse(await client.callTool({ name, arguments: args }));
};

try {
  // ===================== (1)-(3) createProjectTask on the DEFAULT board =====================
  db.insertProject({ id: "pDef", name: "Def", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });

  const valid = createProjectTask(db, "pDef", { title: "valid col", columnKey: "review" });
  check("(1) create with a VALID columnKey returns a Task on that column", !valid.error && valid.columnKey === "review");
  check("(1) the card was inserted", db.getTask(valid.id)?.columnKey === "review");

  const landed = createProjectTask(db, "pDef", { title: "no col" });
  check("(2) create with an OMITTED columnKey lands in defaultLanding (backlog)", !landed.error && landed.columnKey === "backlog");

  const before = db.listTasks("pDef").length;
  const bad = createProjectTask(db, "pDef", { title: "typo col", columnKey: "reviw" });
  check("(3) ★ create with an UNKNOWN columnKey is REJECTED (returns {error})", typeof bad.error === "string" && !bad.id);
  check("(3) ★ the rejected create inserted NO card (not orphaned off-board)", db.listTasks("pDef").length === before);
  check("(3) the error names the bad key + the valid columns", bad.error.includes("reviw") && bad.error.includes("backlog"));

  // ===================== (4) the guard honors a CUSTOM board (resolved columns) =====================
  db.insertProject({ id: "pCustom", name: "Custom", repoPath: tmpHome, vaultPath: tmpHome,
    config: { kanbanColumns: [{ key: "ideas", label: "Ideas", role: "defaultLanding" }, { key: "shipped", label: "Shipped", role: "terminal" }] },
    createdAt: now, archivedAt: null, reserved: false });
  const onCustom = createProjectTask(db, "pCustom", { title: "ok", columnKey: "shipped" });
  check("(4) create accepts a column that exists on the CUSTOM board", !onCustom.error && onCustom.columnKey === "shipped");
  const offCustom = createProjectTask(db, "pCustom", { title: "no", columnKey: "review" });
  check("(4) ★ a DEFAULT-board key ('review') is rejected on the custom board (resolved, not hardcoded)", typeof offCustom.error === "string" && !offCustom.id);

  // ===================== (5) updateProjectTask UNKNOWN columnKey still rejected (e9256a4) =====================
  const upBad = await updateProjectTask(db, "pDef", valid.id, { columnKey: "nope" });
  check("(5) update with an UNKNOWN columnKey is still rejected (e9256a4 not regressed)", typeof upBad.error === "string");
  check("(5) the rejected update left the card on its original column", db.getTask(valid.id).columnKey === "review");
  const upOk = await updateProjectTask(db, "pDef", valid.id, { columnKey: "done" });
  check("(5) update with a VALID columnKey moves the card", !upOk.error && db.getTask(valid.id).columnKey === "done");

  // ===================== (6)-(7) PLATFORM cross-project task tools honor the SAME guards =====================
  const platform = await connect(new PlatformMcpRouter(db, svc).buildServer());

  const pcBefore = db.listTasks("pDef").length;
  const pcBad = await platform("project_task_create", { projectId: "pDef", title: "x-typo", columnKey: "reviw" });
  check("(6) ★ platform project_task_create with an UNKNOWN columnKey is REJECTED", typeof pcBad.error === "string" && !pcBad.id);
  check("(6) ★ the rejected cross-project create inserted NO card", db.listTasks("pDef").length === pcBefore);
  const pcOk = await platform("project_task_create", { projectId: "pDef", title: "x-ok", columnKey: "todo" });
  check("(6) platform project_task_create with a VALID columnKey is created on that column", !pcOk.error && pcOk.columnKey === "todo");

  const puBad = await platform("project_task_update", { projectId: "pDef", taskId: pcOk.id, columnKey: "nope" });
  check("(7) ★ platform project_task_update with an UNKNOWN columnKey is REJECTED", typeof puBad.error === "string");
  check("(7) the rejected cross-project update left the card put", db.getTask(pcOk.id).columnKey === "todo");
} finally {
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry WAL handle on Windows */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createProjectTask now validates an explicit columnKey against the project's RESOLVED board (the create-side mirror of e9256a4's move guard): an unknown key is rejected with a clear error and inserts NO card, instead of silently orphaning it off-board. Both the in-project tasks_create path (the shared function) and the cross-project platform project_task_create/update honor it — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
