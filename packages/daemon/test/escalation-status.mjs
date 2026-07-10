import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Manager-facing, READ-ONLY, origin-project-scoped `escalation_status` (orchestration surface) — closes
// the gap where a manager re-escalates work the Platform Lead already claimed. DETERMINISTIC + CLAUDE-FREE
// + NETWORK-FREE, hermetic like platform-messaging.mjs: a REAL Db + SessionService driven against a FAKE
// pty, the REAL OrchestrationMcpRouter, over an in-process MCP InMemoryTransport (no HTTP, no daemon).
//
// Proves the DoD:
//   (a) a manager sees its OWN project's escalation, and its `status` transitions correctly as the
//       Platform task's column moves: pending (still in the landing lane) → in_progress (moved off
//       landing into a working lane) → resolved (moved into the terminal/done-role column) → closed
//       (the Platform task is deleted). The CURRENT title (post-move) is read back, not the filed one —
//       except once `closed`, where there's no live row left, so it falls back to the originally-filed
//       title.
//   (b) SCOPING — a manager filing from project A cannot see project B's escalation: neither via a direct
//       taskId query (returns {found:false}, not an error — never confirms/denies existence) nor in its
//       own list.
//   (c) origin-project scoping survives a manager "recycle" — a DIFFERENT managerSessionId in the SAME
//       project still sees the escalation its predecessor filed (scoped by originProjectId, not by
//       managerSessionId).
//   (d) escalation_status is on the manager surface; absent from the worker surface.
//
// Run: 1) build (turbo builds shared first), 2) node test/escalation-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-esc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so any spawn has a valid cwd (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-esc-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# escalation-status test repo\n");
execSync(`git init -q && git add . && git -c user.email=esc@loom -c user.name=esc commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// The reserved/system "Loom Platform" home — platform_escalate files here; escalation_status reads it back.
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
// Two ordinary projects — escalation_status must never leak project A's escalations to project B.
db.insertProject({ id: "pA", name: "Project A", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pB", name: "Project B", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentA", projectId: "pA", name: "WorkA", startupPrompt: "WORK-A", position: 0, profileId: null });
db.insertAgent({ id: "agentB", projectId: "pB", name: "WorkB", startupPrompt: "WORK-B", position: 0, profileId: null });

const seedSession = (id, projectId, agentId, role) => db.insertSession({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: null,
});
seedSession("MGR_A", "pA", "agentA", "manager");   // files the escalations under test
seedSession("MGR_A2", "pA", "agentA", "manager");  // a DIFFERENT session, SAME project — simulates a recycled successor
seedSession("MGR_B", "pB", "agentB", "manager");   // a different project's manager — must see NOTHING of pA's escalations
seedSession("W_A", "pA", "agentA", "worker");      // a worker — escalation_status must not be on its surface

// Fake pty: no real claude spawn is exercised by this test (no live Lead nudge path needed).
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.spawned = []; this.stopped = []; this.enqueued = []; }
  createPty(opts) { this.spawned.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop(id, mode) { this.stopped.push({ id, mode }); }
  enqueueStdin(id, text) { this.enqueued.push({ id, text }); return { delivered: true }; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const orch = new OrchestrationMcpRouter(db, svc);

const parse = (res) => JSON.parse(res.content[0].text);

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "esc-test", version: "0" });
  await client.connect(clientT);
  return client;
}

async function callAs(sessionId, role, name, args) {
  const client = await connect(orch.buildServer(sessionId, role));
  const res = parse(await client.callTool({ name, arguments: args ?? {} }));
  await client.close();
  return res;
}

try {
  // ===================== (d) surface presence =====================
  const mgrClient = await connect(orch.buildServer("MGR_A", "manager"));
  const mgrTools = (await mgrClient.listTools()).tools.map((t) => t.name);
  check("(d) escalation_status is registered on the MANAGER surface", mgrTools.includes("escalation_status"));
  await mgrClient.close();
  const wkrClient = await connect(orch.buildServer("W_A", "worker"));
  const wkrTools = (await wkrClient.listTools()).tools.map((t) => t.name);
  check("(d) escalation_status is ABSENT from the worker surface", !wkrTools.includes("escalation_status"));
  await wkrClient.close();

  // ===================== (a) file two escalations from project A, then walk one through its lifecycle =====
  const esc1 = await callAs("MGR_A", "manager", "platform_escalate", {
    title: "worker_merge gate hangs on a slow build", detail: "Three workers stalled 4+ min.", severity: "high",
  });
  check("(a) platform_escalate filed T1", !!esc1.taskId && !esc1.error);
  const t1 = esc1.taskId;

  // list (no taskId) — MGR_A sees exactly its one escalation so far, status pending (still in the landing lane).
  const list1 = await callAs("MGR_A", "manager", "escalation_status", {});
  check("(a) list (no taskId) returns found:true + a 1-item escalations array",
    list1.found === true && Array.isArray(list1.escalations) && list1.escalations.length === 1 && list1.escalations[0].taskId === t1);
  check("(a) fresh escalation reads back as 'pending' (still in the Platform board's landing lane)",
    list1.escalations[0].status === "pending" && list1.escalations[0].columnKey === "backlog");

  // direct taskId query — same status.
  const st1a = await callAs("MGR_A", "manager", "escalation_status", { taskId: t1 });
  check("(a) direct taskId query for T1 returns found:true + status pending",
    st1a.found === true && st1a.escalation.taskId === t1 && st1a.escalation.status === "pending" &&
    st1a.escalation.title === "worker_merge gate hangs on a slow build");

  // The Lead picks it up: moves the card off the landing lane into a working lane, and refines its title.
  db.updateTask(t1, { columnKey: "review", title: "Fix: worker_merge gate hangs on slow build (picked up)" });
  const st1b = await callAs("MGR_A", "manager", "escalation_status", { taskId: t1 });
  check("(a) moved off the landing lane → status in_progress, CURRENT (refined) title is read back",
    st1b.escalation.status === "in_progress" && st1b.escalation.columnKey === "review" &&
    st1b.escalation.title === "Fix: worker_merge gate hangs on slow build (picked up)");

  // The Lead resolves it: moves the card into the terminal/done-role column.
  db.updateTask(t1, { columnKey: "done" });
  const st1c = await callAs("MGR_A", "manager", "escalation_status", { taskId: t1 });
  check("(a) moved into the terminal column → status resolved", st1c.escalation.status === "resolved" && st1c.escalation.columnKey === "done");

  // The task is later deleted/archived off the board entirely.
  db.deleteTask(t1);
  const st1d = await callAs("MGR_A", "manager", "escalation_status", { taskId: t1 });
  check("(a) a deleted Platform task reads back as status closed, with a null columnKey",
    st1d.found === true && st1d.escalation.status === "closed" && st1d.escalation.columnKey === null);
  check("(a) closed escalation falls back to the ORIGINALLY-FILED title (no live row left to read a refined one)",
    st1d.escalation.title === "worker_merge gate hangs on a slow build");

  // ===================== (c) recycle survival — a 2nd manager session, SAME project, files T2 =====================
  const esc2 = await callAs("MGR_A", "manager", "platform_escalate", {
    title: "second escalation from project A", detail: "filed under MGR_A, read back under MGR_A2", severity: "low",
  });
  const t2 = esc2.taskId;
  const recycled = await callAs("MGR_A2", "manager", "escalation_status", { taskId: t2 });
  check("(c) a DIFFERENT managerSessionId in the SAME project (simulated recycle) still sees T2",
    recycled.found === true && recycled.escalation.taskId === t2 && recycled.escalation.status === "pending");
  const recycledList = await callAs("MGR_A2", "manager", "escalation_status", {});
  check("(c) MGR_A2's list includes BOTH T1 (closed) and T2 (pending) — origin-project scoped, not session-scoped",
    recycledList.escalations.length === 2 &&
    recycledList.escalations.some((e) => e.taskId === t1 && e.status === "closed") &&
    recycledList.escalations.some((e) => e.taskId === t2 && e.status === "pending"));

  // ===================== (b) scoping — project B must see NOTHING of project A's escalations =====================
  const bDirect = await callAs("MGR_B", "manager", "escalation_status", { taskId: t2 });
  check("(b) a manager from a DIFFERENT project querying another project's real taskId gets found:false (no leak)",
    bDirect.found === false && bDirect.error === undefined);
  const bList = await callAs("MGR_B", "manager", "escalation_status", {});
  check("(b) that same manager's own list is empty — it filed nothing", bList.found === true && bList.escalations.length === 0);
  const bGhost = await callAs("MGR_B", "manager", "escalation_status", { taskId: "not-a-real-task-id" });
  check("(b) an unknown taskId ALSO returns found:false — indistinguishable from 'another project's real id'",
    bGhost.found === false);

  // Defense in depth: the service method itself rejects a non-manager caller.
  let svcRejected = false;
  try { svc.escalationStatus("W_A", {}); } catch (e) { svcRejected = /manager-only/.test(e.message); }
  check("(d) svc.escalationStatus rejects a non-manager caller (manager-only guard)", svcRejected);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — escalation_status is manager-gated and origin-project-scoped: a manager reads its own project's filed escalations (status pending→in_progress→resolved→closed as the Platform task's column/existence changes, current title read back live), a different project's manager gets found:false for both a real foreign taskId and an unknown one (never leaking which), and a different managerSessionId in the SAME project (recycle) still sees escalations its predecessor filed — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
