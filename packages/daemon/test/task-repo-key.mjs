import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Multi-repo epic 49136451 phase 1: Task.repoKey round-trips through the in-project loom-tasks MCP
// (tasks_create/tasks_update), the elevated loom-platform cross-project MCP (project_task_create/
// project_task_update), and the human REST task routes (POST /api/projects/:id/tasks, POST
// /api/tasks/:id) — validated against the OWNING project's `repos` registry on every surface, an unknown
// key REJECTED with the whole patch/create left unwritten, and repoKey RESET to null when a card is
// relocated to a different project's board (a registry key is project-scoped). HERMETIC + CLAUDE-FREE +
// NETWORK-FREE, modeled on platform-cross-project-task.mjs + worker-task-id-prefix.mjs.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-repo-key.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-taskrepokey-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45323";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db(path.join(tmpHome, "test.db"));

db.insertProject({
  id: "pA", name: "Project A", repoPath: "C:/a", vaultPath: "C:/a", config: {}, createdAt: now, archivedAt: null, reserved: false,
  repos: [{ key: "svc-a", path: "C:/a/svc-a" }, { key: "svc-b", path: "C:/a/svc-b", gateCommand: "pytest" }],
});
db.insertProject({ id: "pB", name: "Project B", repoPath: "C:/b", vaultPath: "C:/b", config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
db.insertAgent({ id: "agentLead", projectId: "pA", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
db.insertSession({ id: "PL", projectId: "pA", agentId: "agentLead", engineSessionId: null, title: null, cwd: "C:/a", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform", parentSessionId: null });
// Real sessions with real roles for PART A's actor-gate assertions (code-review ruling: repoKey WRITES
// are a dispatch decision restricted to manager/platform — tasks_update itself is reachable by a worker
// too, so a bare unregistered sessionId like the pre-fix "S" would silently resolve to role:undefined,
// which is exactly the "no role" case the guard must ALSO reject — insert real rows so PART A exercises
// the actual manager-allowed / worker-denied split, not an accidental undefined-role pass-through).
db.insertAgent({ id: "agentMgr", projectId: "pA", name: "Manager", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentWorker", projectId: "pA", name: "Worker", startupPrompt: "WORK", position: 0, profileId: null });
db.insertSession({ id: "S", projectId: "pA", agentId: "agentMgr", engineSessionId: null, title: null, cwd: "C:/a", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
db.insertSession({ id: "W", projectId: "pA", agentId: "agentWorker", engineSessionId: null, title: null, cwd: "C:/a", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "S" });

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

const parse = (res) => JSON.parse(res.content[0].text);
const connectServer = async (server) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "task-repo-key-test", version: "0" });
  await client.connect(clientT);
  return { client, call: async (name, args) => parse(await client.callTool({ name, arguments: args })) };
};

try {
  // =====================================================================================================
  // PART A — in-project loom-tasks (tasks_create / tasks_update), project pA
  // =====================================================================================================
  {
    const inProj = await connectServer(new TaskMcpRouter(db, wakes).buildServer("pA", "S"));

    // (A1) tasks_create with a valid repoKey round-trips it.
    const created = await inProj.call("tasks_create", { title: "Card 1", repoKey: "svc-a" });
    check("(A1) tasks_create with a valid repoKey -> no error", !created.error);
    check("(A1) round-trips repoKey", created.repoKey === "svc-a");
    check("(A1) persisted to the Db", db.getTask(created.id)?.repoKey === "svc-a");

    // (A2) tasks_create omitting repoKey defaults to null (primary).
    const created2 = await inProj.call("tasks_create", { title: "Card 2" });
    check("(A2) tasks_create omitting repoKey -> null default", created2.repoKey === null);

    // (A3) tasks_create with repoKey "primary" is accepted as the explicit spelling of null.
    const created3 = await inProj.call("tasks_create", { title: "Card 3", repoKey: "primary" });
    check("(A3) tasks_create with repoKey \"primary\" -> repoKey null", created3.repoKey === null);

    // (A4) tasks_create with an UNKNOWN repoKey is rejected, no card created.
    const beforeCount = db.listTasks("pA").length;
    const badCreate = await inProj.call("tasks_create", { title: "Bad Card", repoKey: "ghost" });
    check("(A4) tasks_create with an unknown repoKey -> {error}", typeof badCreate.error === "string" && /ghost/.test(badCreate.error));
    check("(A4) no card was created on rejection", db.listTasks("pA").length === beforeCount);

    // (A5) tasks_update sets repoKey on an existing (repoKey-less) card, TRIMMED ack includes it.
    const upd = await inProj.call("tasks_update", { id: created2.id, repoKey: "svc-b" });
    check("(A5) tasks_update sets repoKey -> no error", !upd.error);
    check("(A5) trimmed ack includes repoKey", upd.repoKey === "svc-b");
    check("(A5) persisted to the Db", db.getTask(created2.id)?.repoKey === "svc-b");
    check("(A5) 'changed' names repoKey", Array.isArray(upd.changed) && upd.changed.includes("repoKey"));

    // (A6) tasks_update with an UNKNOWN repoKey is a WHOLE-PATCH REJECT — nothing written, including a
    // title change bundled in the SAME call (mirrors the held-clear whole-patch-reject convention).
    const beforeTitle = db.getTask(created2.id)?.title;
    const badUpd = await inProj.call("tasks_update", { id: created2.id, title: "Should Not Apply", repoKey: "ghost" });
    check("(A6) tasks_update with an unknown repoKey -> {error}", typeof badUpd.error === "string" && /ghost/.test(badUpd.error));
    check("(A6) repoKey UNCHANGED after the rejected patch", db.getTask(created2.id)?.repoKey === "svc-b");
    check("(A6) title UNCHANGED too (whole-patch reject, not partial)", db.getTask(created2.id)?.title === beforeTitle);

    // (A7) tasks_update with repoKey null RESETS to primary.
    const reset = await inProj.call("tasks_update", { id: created2.id, repoKey: null });
    check("(A7) tasks_update repoKey:null -> resets to primary", reset.repoKey === null);
    check("(A7) persisted to the Db", db.getTask(created2.id)?.repoKey === null);

    await inProj.client.close();

    // ===== (A8)-(A10) the repoKey AUTHORITY restriction (code-review ruling): repoKey is a dispatch
    // decision — a WORKER can reach this SAME tasks_update tool, but must NOT be able to set/clear it,
    // while tasks_create stays open to a worker (filing a follow-up card on its own repo is legitimate). =====
    const asWorker = await connectServer(new TaskMcpRouter(db, wakes).buildServer("pA", "W"));

    // (A8) a WORKER's tasks_create WITH a repoKey is still allowed (create is deliberately NOT gated).
    const workerCreated = await asWorker.call("tasks_create", { title: "Worker's Own Card", repoKey: "svc-a" });
    check("(A8) a worker's tasks_create with repoKey is allowed (create is not actor-gated)", !workerCreated.error && workerCreated.repoKey === "svc-a");

    // (A9) a WORKER's tasks_update attempting to SET repoKey is REFUSED — whole patch rejected.
    const beforeWorkerTitle = db.getTask(workerCreated.id)?.title;
    const workerSetDenied = await asWorker.call("tasks_update", { id: workerCreated.id, title: "Worker Retarget Attempt", repoKey: "svc-b" });
    check("(A9) a worker's tasks_update setting repoKey -> {error}", typeof workerSetDenied.error === "string" && /manager|dispatch/i.test(workerSetDenied.error));
    check("(A9) repoKey UNCHANGED after the denial", db.getTask(workerCreated.id)?.repoKey === "svc-a");
    check("(A9) whole patch rejected — title UNCHANGED too", db.getTask(workerCreated.id)?.title === beforeWorkerTitle);

    // (A10) a WORKER's tasks_update attempting to CLEAR repoKey (null) is ALSO refused — the guard covers
    // both set and clear, not just a non-null value.
    const workerClearDenied = await asWorker.call("tasks_update", { id: workerCreated.id, repoKey: null });
    check("(A10) a worker's tasks_update clearing repoKey (null) -> {error}", typeof workerClearDenied.error === "string");
    check("(A10) repoKey still UNCHANGED", db.getTask(workerCreated.id)?.repoKey === "svc-a");

    // (A11) control: the SAME worker CAN still update a field repoKey-adjacent (title) — the guard is
    // repoKey-specific, not a blanket worker tasks_update lockout.
    const workerTitleOk = await asWorker.call("tasks_update", { id: workerCreated.id, title: "Worker Can Still Rename" });
    check("(A11) control: a worker's tasks_update WITHOUT repoKey still succeeds", !workerTitleOk.error && db.getTask(workerCreated.id)?.title === "Worker Can Still Rename");

    await asWorker.client.close();
  }

  // =====================================================================================================
  // PART B — elevated loom-platform cross-project (project_task_create / project_task_update)
  // =====================================================================================================
  {
    class SeamHost extends PtyHost {
      createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
      stop() {}
    }
    const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
    const svc = new SessionService(db, host, new OrchestrationControl());
    const plat = await connectServer(new PlatformMcpRouter(db, svc).buildServer("PL"));

    // (B1) project_task_create with a valid repoKey on a DIFFERENT project's board round-trips it.
    const created = await plat.call("project_task_create", { projectId: "pA", title: "Cross Card", repoKey: "svc-a" });
    check("(B1) project_task_create with a valid repoKey -> no error", !created.error);
    check("(B1) round-trips repoKey", created.repoKey === "svc-a");
    check("(B1) persisted to the Db", db.getTask(created.id)?.repoKey === "svc-a");

    // (B2) project_task_create with an UNKNOWN repoKey against the TARGET project's registry is rejected
    // (pB has an EMPTY registry — "svc-a" only exists on pA).
    const beforeCount = db.listTasks("pB").length;
    const badCreate = await plat.call("project_task_create", { projectId: "pB", title: "Bad Cross Card", repoKey: "svc-a" });
    check("(B2) project_task_create with a repoKey unknown to the TARGET project -> {error}", typeof badCreate.error === "string" && /svc-a/.test(badCreate.error));
    check("(B2) no card was created on pB", db.listTasks("pB").length === beforeCount);

    // (B3) project_task_update sets/clears repoKey identically, whole-patch-reject on an unknown key.
    const upd = await plat.call("project_task_update", { projectId: "pA", taskId: created.id, repoKey: "svc-b" });
    check("(B3) project_task_update sets repoKey", upd.repoKey === "svc-b");
    const badUpd = await plat.call("project_task_update", { projectId: "pA", taskId: created.id, title: "Nope", repoKey: "ghost" });
    check("(B3) unknown repoKey -> {error}, whole patch rejected", typeof badUpd.error === "string" && db.getTask(created.id)?.repoKey === "svc-b" && db.getTask(created.id)?.title !== "Nope");

    await plat.client.close();
  }

  // =====================================================================================================
  // PART C — human REST task routes (POST /api/projects/:id/tasks, POST /api/tasks/:id)
  // =====================================================================================================
  {
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      // (C1) POST /api/projects/:id/tasks with a valid repoKey round-trips it.
      const created = await app.inject({ method: "POST", url: "/api/projects/pA/tasks", payload: { title: "REST Card", repoKey: "svc-a" } });
      check("(C1) POST task create with a valid repoKey -> 201", created.statusCode === 201);
      check("(C1) round-trips repoKey", created.json().repoKey === "svc-a");

      // (C2) POST /api/projects/:id/tasks with an UNKNOWN repoKey is rejected (400), no card created.
      const beforeCount = db.listTasks("pA").length;
      const badCreate = await app.inject({ method: "POST", url: "/api/projects/pA/tasks", payload: { title: "Bad REST Card", repoKey: "ghost" } });
      check("(C2) POST task create with an unknown repoKey -> 400", badCreate.statusCode === 400);
      check("(C2) error names the offending key", /ghost/.test(badCreate.json().error ?? ""));
      check("(C2) no card was created on rejection", db.listTasks("pA").length === beforeCount);

      // (C3) POST /api/tasks/:id updates repoKey.
      const upd = await app.inject({ method: "POST", url: `/api/tasks/${created.json().id}`, payload: { repoKey: "svc-b" } });
      check("(C3) POST task update with a valid repoKey -> 200", upd.statusCode === 200);
      check("(C3) persisted", db.getTask(created.json().id)?.repoKey === "svc-b");

      // (C4) POST /api/tasks/:id with an UNKNOWN repoKey is rejected (400), value unchanged.
      const badUpd = await app.inject({ method: "POST", url: `/api/tasks/${created.json().id}`, payload: { repoKey: "ghost" } });
      check("(C4) POST task update with an unknown repoKey -> 400", badUpd.statusCode === 400);
      check("(C4) repoKey UNCHANGED after rejection", db.getTask(created.json().id)?.repoKey === "svc-b");
    } finally {
      // buildServer doesn't own db lifecycle here — db closed once at the very end.
    }
  }

  // =====================================================================================================
  // PART D — relocateTask RESETS repoKey (a registry key is project-scoped; carrying it across a
  // relocate would dangle or silently coincide with a different repo on the destination board).
  // =====================================================================================================
  {
    const taskId = db.listTasks("pA").find((t) => t.repoKey === "svc-b")?.id;
    check("(D0) precondition: found a pA card with repoKey svc-b to relocate", !!taskId);
    db.relocateTask(taskId, { projectId: "pB", columnKey: "backlog", position: 1 });
    const relocated = db.getTask(taskId);
    check("(D1) relocateTask moved the card to the destination project", relocated?.projectId === "pB");
    check("(D1) relocateTask RESET repoKey to null (was project-scoped to pA's registry)", relocated?.repoKey === null);
  }
} finally {
  db.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Task.repoKey round-trips through tasks_create/tasks_update, project_task_create/project_task_update, and the human REST task routes — all validated against the OWNING project's repos registry, an unknown key rejected with the whole write left unapplied (create: no card; update: whole-patch reject, not partial) — and relocateTask resets repoKey to null when a card crosses project boards."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
