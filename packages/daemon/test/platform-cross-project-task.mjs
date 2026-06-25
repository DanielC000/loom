import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// PL Auditor finding #4 — cross-project task boarding for the Platform Lead (mcp/platform.ts ›
// project_task_create). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like
// platform-mgmt-surface.mjs / surface-subset.mjs: a REAL Db + SessionService against a FAKE pty
// (PtyHost createPty() seam), the REAL routers driven over an in-process MCP InMemoryTransport (no
// HTTP, no external daemon).
//
// Proves the DoD:
//   (1) the platform tool boards a card on a DIFFERENT project's board — it lands on the TARGET board
//       (db.listTasks(target)) with the right title/priority/column; an explicit columnKey is honored
//       and an omitted one resolves to the project's defaultLanding ("backlog" on the default board);
//   (2) a bad/nonexistent projectId is rejected ("project not found") and creates NO card;
//   (3) TRUST GATE — project_task_create is PRESENT on loom-platform but ABSENT from the agent-facing
//       surfaces: loom-orchestration (manager AND worker) and loom-setup. A project orchestrator/
//       worker/setup-operator must NOT gain cross-project write.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-cross-project-task.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-xtask-${Date.now()}-${process.pid}`);
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
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so a spawn (never reached here) would have a valid cwd; createPty is faked ---
const repo = path.join(os.tmpdir(), `loom-xtask-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# cross-project task test repo\n");
execSync(`git init -q && git add . && git -c user.email=x@loom -c user.name=x commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// The reserved/system "Loom Platform" home (where the Lead lives) + a DIFFERENT target project board.
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pTarget", name: "Target", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
db.insertAgent({ id: "agentWork", projectId: "pTarget", name: "Work", startupPrompt: "WORK", position: 0, profileId: null });

// Sessions for the role-gate fixtures (the agent-facing surfaces resolve role/project from these).
const seedSession = (id, projectId, role, parent) => db.insertSession({
  id, projectId, agentId: projectId === "pHome" ? "agentLead" : "agentWork", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: parent ?? null,
});
seedSession("PL", "pHome", "platform", null);
seedSession("M", "pTarget", "manager", null);
seedSession("W", "pTarget", "worker", "M");

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const wakes = new WakeService({ db, pty: host, resume: () => {} }); // never ticked; TaskMcpRouter only lists tools here

const parse = (res) => JSON.parse(res.content[0].text);
const listTools = async (server) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "xtask-test", version: "0" });
  await client.connect(clientT);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names;
};

try {
  // ===================== (1) the platform tool boards a card on a DIFFERENT project's board =====================
  const platServer = new PlatformMcpRouter(db, svc).buildServer("PL");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await platServer.connect(serverT);
  const client = new Client({ name: "xtask-platform", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  check("loom-platform registers project_task_create",
    (await client.listTools()).tools.some((t) => t.name === "project_task_create"));

  const nBefore = db.listTasks("pTarget").length;
  const created = await call("project_task_create", {
    projectId: "pTarget", title: "fix(x): boarded cross-project", body: "from the Lead", priority: "p1", columnKey: "todo",
  });
  check("project_task_create returns a Task row (id, no error)", !!created.id && !created.error);
  check("the card belongs to the TARGET project (projectId=pTarget)", created.projectId === "pTarget");
  check("the card LANDED on the target board (visible via db.listTasks)",
    db.listTasks("pTarget").some((t) => t.id === created.id) && db.listTasks("pTarget").length === nBefore + 1);
  const stored = db.getTask(created.id);
  check("title/priority/column persisted identically",
    stored.title === "fix(x): boarded cross-project" && stored.body === "from the Lead" && stored.priority === "p1" && stored.columnKey === "todo");

  // Omitted columnKey lands on the project's role-resolved defaultLanding ("backlog" on the default board).
  const landed = await call("project_task_create", { projectId: "pTarget", title: "no-column card" });
  check("omitted columnKey resolves to the defaultLanding column (backlog)", landed.columnKey === "backlog" && !landed.error);
  check("omitted priority defaults to p2 (same as in-project tasks_create)", landed.priority === "p2");

  // The Lead's OWN home was NOT touched by a pTarget create (true cross-project isolation).
  check("the create did NOT leak onto the Lead's home board", db.listTasks("pHome").length === 0);

  // ===================== (2) bad/nonexistent projectId is rejected, nothing created =====================
  const nTargetNow = db.listTasks("pTarget").length;
  const bad = await call("project_task_create", { projectId: "ghost", title: "should not exist" });
  check("(2) nonexistent projectId rejected ('project not found')", bad.error === "project not found" && !bad.id);
  check("(2) the rejected create boarded NO card anywhere",
    db.listTasks("pTarget").length === nTargetNow && db.listTasks("pHome").length === 0);

  await client.close();

  // ===================== (3) TRUST GATE — ABSENT from every agent-facing surface =====================
  const platformTools = await listTools(new PlatformMcpRouter(db, svc).buildServer("PL"));
  const setupTools = await listTools(new SetupMcpRouter(db, svc).buildServer());
  const orchRouter = new OrchestrationMcpRouter(db, svc);
  const mgrTools = await listTools(orchRouter.buildServer("M", "manager"));
  const workerTools = await listTools(orchRouter.buildServer("W", "worker"));
  const taskTools = await listTools(new TaskMcpRouter(db, wakes).buildServer("pTarget", "M"));

  check("(3) project_task_create IS on loom-platform (the only home)", platformTools.includes("project_task_create"));
  check("(3) project_task_create is ABSENT from loom-setup (operator surface)", !setupTools.includes("project_task_create"));
  check("(3) project_task_create is ABSENT from loom-orchestration MANAGER surface", !mgrTools.includes("project_task_create"));
  check("(3) project_task_create is ABSENT from loom-orchestration WORKER surface", !workerTools.includes("project_task_create"));
  // Belt-and-suspenders: the in-project loom-tasks surface only carries the project-scoped tasks_create
  // (no projectId arg) — confirm the cross-project variant never leaked there either.
  check("(3) the in-project loom-tasks surface has NO cross-project create (only scoped tasks_create)",
    taskTools.includes("tasks_create") && !taskTools.includes("project_task_create"));

  // Negative control: prove the absence assertion has teeth (the gate would catch a leak).
  check("(3) negative control: a tool that DOES exist on orchestration is detected (proves teeth)",
    mgrTools.includes("worker_spawn"));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Lead's project_task_create boards a card on a DIFFERENT project's board (right title/priority/column, defaultLanding fallback, no cross-project leak), rejects a bad projectId with no write, and is present ONLY on loom-platform — ABSENT from loom-setup, loom-orchestration (manager + worker), and the in-project loom-tasks surface — so no agent surface gains cross-project write."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
