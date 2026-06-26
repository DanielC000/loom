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
const { listProjectTasks, updateProjectTask, DEFAULT_TASK_SUMMARY_CAP } = await import("../dist/mcp/tasks.js");

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

  // ===================== (4) cross-project task READ / UPDATE / LIST — the finish-the-surface tools ==========
  const platTools4 = (await client.listTools()).tools.map((t) => t.name);
  check("(4) loom-platform registers project_task_get + project_task_update + list_all_tasks",
    platTools4.includes("project_task_get") && platTools4.includes("project_task_update") && platTools4.includes("list_all_tasks"));

  // create → read → move → re-prioritize a card on ANOTHER project's board, end-to-end.
  const card = await call("project_task_create", { projectId: "pTarget", title: "feat(x): lifecycle card", body: "v1", priority: "p2", columnKey: "backlog" });
  check("(4) e2e create: card on pTarget (id, no error)", !!card.id && !card.error);
  const read1 = await call("project_task_get", { projectId: "pTarget", taskId: card.id });
  check("(4) e2e read: project_task_get returns the FULL card (body included)", read1.id === card.id && read1.body === "v1" && !read1.error);
  const moved = await call("project_task_update", { projectId: "pTarget", taskId: card.id, columnKey: "in_progress", priority: "p0" });
  check("(4) e2e move + re-prioritize: returns the patched row", moved.columnKey === "in_progress" && moved.priority === "p0" && !moved.error);
  check("(4) e2e move + re-prioritize persisted to the DB", db.getTask(card.id).columnKey === "in_progress" && db.getTask(card.id).priority === "p0");

  // Column-move guard: a move to a NON-EXISTENT column is rejected and the card is left unchanged.
  const badMove = await call("project_task_update", { projectId: "pTarget", taskId: card.id, columnKey: "no_such_col" });
  check("(4) move to an unknown column is rejected (column-existence guard)", /unknown column/.test(badMove.error || ""));
  check("(4) the rejected move left the card on its prior column", db.getTask(card.id).columnKey === "in_progress");

  // Cross-project guard: a taskId that belongs to a DIFFERENT project resolves to not-found (no leak/edit).
  const homeCard = await call("project_task_create", { projectId: "pHome", title: "home-only card" });
  check("(4) cross-project get: a pHome card is NOT readable as a pTarget card", /not found/.test((await call("project_task_get", { projectId: "pTarget", taskId: homeCard.id })).error || ""));
  const xUpd = await call("project_task_update", { projectId: "pTarget", taskId: homeCard.id, priority: "p0" });
  check("(4) cross-project update: a pHome card is NOT editable via pTarget", /not found/.test(xUpd.error || ""));
  check("(4) the cross-project update did NOT mutate the home card", db.getTask(homeCard.id).priority !== "p0");
  // Unknown project → 404 on both read + update.
  check("(4) project_task_get 404s an unknown project", (await call("project_task_get", { projectId: "ghost", taskId: card.id })).error === "project not found");
  check("(4) project_task_update 404s an unknown project", (await call("project_task_update", { projectId: "ghost", taskId: card.id, priority: "p1" })).error === "project not found");

  // The SHARED backing path is used by the in-project tasks_update too: column-existence guard applies there.
  const badIn = updateProjectTask(db, "pTarget", card.id, { columnKey: "still_not_a_col" });
  check("(4) the in-project updateProjectTask ALSO rejects an unknown column (shared guard)", /unknown column/.test(badIn.error || ""));
  const goodIn = updateProjectTask(db, "pTarget", card.id, { columnKey: "review" });
  check("(4) a valid in-project move is accepted (review exists on the default board)", goodIn.columnKey === "review" && !goodIn.error);

  // list_all_tasks aggregates across projects; projectId narrows; done excluded; summary drops body.
  const doneCard = await call("project_task_create", { projectId: "pTarget", title: "done card", columnKey: "done" });
  const agg = await call("list_all_tasks", {});
  check("(4) list_all_tasks aggregates cross-project (sees both the pTarget + pHome cards)",
    Array.isArray(agg) && agg.some((t) => t.id === card.id) && agg.some((t) => t.id === homeCard.id));
  check("(4) list_all_tasks default is a SUMMARY (no body) and EXCLUDES done cards",
    agg.every((t) => t.body === undefined) && !agg.some((t) => t.id === doneCard.id));
  const targetFull = await call("list_all_tasks", { projectId: "pTarget", includeBody: true });
  check("(4) list_all_tasks projectId filter + includeBody returns full rows scoped to that project",
    targetFull.length > 0 && targetFull.every((t) => t.projectId === "pTarget" && typeof t.body === "string"));
  check("(4) list_all_tasks narrows an unknown project to []", (await call("list_all_tasks", { projectId: "ghost" })).length === 0);

  // ===================== (5) bounded-read pagination + a measured cap =====================
  db.insertProject({ id: "pBulk", name: "Bulk", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const BULK = DEFAULT_TASK_SUMMARY_CAP + 5;
  for (let i = 0; i < BULK; i++) {
    db.insertTask({ id: `bulk-${i}`, projectId: "pBulk", title: `b${i}`, body: "x".repeat(40), columnKey: "backlog", position: i, priority: "p2", createdAt: now, updatedAt: now });
  }
  // Unit: listProjectTasks honors offset/limit (pure slicing).
  const sliced = listProjectTasks(db, "pBulk", { limit: 10, offset: 5 });
  check("(5) listProjectTasks honors limit/offset", sliced.length === 10 && sliced[0].id === "bulk-5");
  // list_all_tasks default is CAPPED; an explicit limit pages past it; offset skips.
  const capped = await call("list_all_tasks", { projectId: "pBulk", includeBody: true });
  check(`(5) list_all_tasks default is capped at ${DEFAULT_TASK_SUMMARY_CAP} (got ${capped.length})`, capped.length === DEFAULT_TASK_SUMMARY_CAP);
  const pagedPast = await call("list_all_tasks", { projectId: "pBulk", includeBody: true, limit: DEFAULT_TASK_SUMMARY_CAP + 50 });
  check("(5) list_all_tasks pages past the cap with an explicit limit", pagedPast.length === BULK);
  const aggOff = await call("list_all_tasks", { projectId: "pBulk", limit: 10, offset: 5 });
  check("(5) list_all_tasks honors limit/offset", aggOff.length === 10);
  // The in-project tasks_list surface caps its default read too.
  const inProjServer = new TaskMcpRouter(db, wakes).buildServer("pBulk", "S");
  const [ipT, ipS] = InMemoryTransport.createLinkedPair();
  await inProjServer.connect(ipS);
  const ipClient = new Client({ name: "xtask-inproj", version: "0" });
  await ipClient.connect(ipT);
  const ipList = parse(await ipClient.callTool({ name: "tasks_list", arguments: { includeBody: true } }));
  check(`(5) in-project tasks_list default is capped at ${DEFAULT_TASK_SUMMARY_CAP} (got ${ipList.length})`, ipList.length === DEFAULT_TASK_SUMMARY_CAP);
  const ipPaged = parse(await ipClient.callTool({ name: "tasks_list", arguments: { includeBody: true, limit: DEFAULT_TASK_SUMMARY_CAP + 50 } }));
  check("(5) in-project tasks_list pages past the cap with an explicit limit", ipPaged.length === BULK);
  await ipClient.close();

  // ===================== (6) enumeration gaps — profiles + schedules =====================
  const enumTools = (await client.listTools()).tools.map((t) => t.name);
  check("(6) loom-platform registers list_all_profiles + list_all_schedules + schedule_get + schedule_delete",
    ["list_all_profiles", "list_all_schedules", "schedule_get", "schedule_delete"].every((n) => enumTools.includes(n)));
  const prof = await call("profile_create", { profile: { name: "Bulk Rig", role: "worker" } });
  check("(6) list_all_profiles enumerates a created profile", (await call("list_all_profiles", {})).some((p) => p.id === prof.id));
  const sched = await call("schedule_create", { agentId: "agentWork", cron: "0 9 * * *" });
  check("(6) schedule_create returns a schedule id", !!sched.id && !sched.error);
  check("(6) list_all_schedules (no filter) enumerates it", (await call("list_all_schedules", {})).some((s) => s.id === sched.id));
  check("(6) list_all_schedules narrows by project (agentWork is in pTarget)", (await call("list_all_schedules", { projectId: "pTarget" })).some((s) => s.id === sched.id));
  check("(6) list_all_schedules excludes other projects (pHome has no such schedule)", !(await call("list_all_schedules", { projectId: "pHome" })).some((s) => s.id === sched.id));
  check("(6) schedule_get reads it back", (await call("schedule_get", { scheduleId: sched.id })).id === sched.id);
  check("(6) schedule_delete retires it", (await call("schedule_delete", { scheduleId: sched.id })).deleted === true && !db.getSchedule(sched.id));
  check("(6) schedule_get 404s a retired/unknown id", (await call("schedule_get", { scheduleId: sched.id })).error === "schedule not found");
  check("(6) schedule_delete 404s an unknown id", (await call("schedule_delete", { scheduleId: "ghost" })).error === "schedule not found");

  // ===================== (7) project_configure unset / replace path =====================
  db.insertProject({ id: "pCfg", name: "Cfg", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
  await call("project_configure", { projectId: "pCfg", config: { docLint: true, obsidian: { autoStart: true }, orchestration: { maxConcurrentWorkers: 3 } } });
  check("(7) project_configure set several keys", db.getProject("pCfg").config.docLint === true && db.getProject("pCfg").config.obsidian.autoStart === true);
  await call("project_configure", { projectId: "pCfg", unset: ["docLint"] });
  check("(7) unset removes a top-level key, preserves the rest", db.getProject("pCfg").config.docLint === undefined && db.getProject("pCfg").config.obsidian.autoStart === true);
  await call("project_configure", { projectId: "pCfg", unset: ["orchestration.maxConcurrentWorkers"] });
  check("(7) unset removes a NESTED dot-path key", db.getProject("pCfg").config.orchestration?.maxConcurrentWorkers === undefined);
  check("(7) unset of an absent path is a harmless no-op (obsidian still set)", (await call("project_configure", { projectId: "pCfg", unset: ["nope.not.here"] })) && db.getProject("pCfg").config.obsidian.autoStart === true);
  await call("project_configure", { projectId: "pCfg", config: { docLint: false }, replace: true });
  check("(7) replace:true swaps the WHOLE override (obsidian gone, only docLint remains)",
    db.getProject("pCfg").config.docLint === false && db.getProject("pCfg").config.obsidian === undefined);

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
  // The new cross-project task read/update + aggregate are platform-only too (no agent surface gains them).
  for (const t of ["project_task_get", "project_task_update", "list_all_tasks"]) {
    check(`(3) ${t} IS on loom-platform and ABSENT from setup/manager/worker`,
      platformTools.includes(t) && !setupTools.includes(t) && !mgrTools.includes(t) && !workerTools.includes(t));
  }
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
  ? "\n✅ ALL PASS — the Lead's cross-project task surface is complete: project_task_create boards a card on a DIFFERENT project's board, and project_task_get/update + list_all_tasks let the Lead read→move→re-prioritize it end-to-end (column-existence guard on move — shared with in-project tasks_update; cross-project + unknown-project guards; done-excluded summary aggregate). tasks_list / list_all_tasks paginate (limit/offset) and cap the default read. Enumeration is filled (list_all_profiles/list_all_schedules + schedule_get/delete) and project_configure can unset (dot-path) / replace. All new tools are present ONLY on loom-platform — ABSENT from loom-setup, loom-orchestration (manager + worker), and the in-project loom-tasks surface — so no agent surface gains cross-project write."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
