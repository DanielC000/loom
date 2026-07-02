import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Cross-project `held` on the platform's project_task_update (card bd6a44fd, filed from platform-board
// card 00d24385). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like project-task-id-prefix.mjs:
// isolated LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService against a FAKE pty, and the REAL
// PlatformMcpRouter over an in-process MCP InMemoryTransport (no HTTP).
//
// The bug: project_task_update (the Lead's cross-project card editor) accepted title/body/columnKey/
// position/priority but NOT held — passing held:true was silently dropped, so the owner-gated hold flag
// couldn't be set on a card that isn't on the Lead's own home board. The in-project loom-tasks
// tasks_update already accepted held via the SAME backing updateProjectTask/db.updateTask path.
//
// Proves:
//   (1) held:true sets the flag on the target card, cross-project;
//   (2) held:false clears it;
//   (3) omitting held entirely leaves the stored value untouched (PATCH semantics, not clobber).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-task-held.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-pth-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo (never spawned into here, but insertProject expects a real repoPath) ---
const repo = path.join(os.tmpdir(), `loom-pth-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# project-task-held test\n");
execSync(`git init -q && git add . && git -c user.email=pth@loom -c user.name=pth commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();

const P_HOME = "12ab34cd-0000-4000-8000-000000000001"; // the Lead's own home
const P_OTHER = "aa11bb22-0000-4000-8000-000000000002"; // ANOTHER project's board
db.insertProject({ id: P_HOME, name: "Home", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: P_OTHER, name: "Other", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });

db.insertAgent({ id: "agentPL", projectId: P_HOME, name: "Platform Lead", startupPrompt: "PL", position: 0, profileId: null });
db.insertSession({ id: "PL", projectId: P_HOME, agentId: "agentPL", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform" });

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());

try {
  const router = new PlatformMcpRouter(db, svc);
  const server = router.buildServer("PL");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "project-task-held-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // A card on ANOTHER project's board (not the Lead's own home) — the cross-project case the fix targets.
  const created = await call("project_task_create", { projectId: P_OTHER, title: "fix(x): needs a hold" });
  check("setup: card created on the OTHER project, held defaults falsy", created.projectId === P_OTHER && !created.held);

  // (1) held:true sets the flag cross-project.
  const heldTrue = await call("project_task_update", { projectId: P_OTHER, taskId: created.id, held: true });
  check("(1) project_task_update: held:true returned in the response", heldTrue.held === true && !heldTrue.error);
  check("(1) project_task_update: held:true persisted to the DB", db.getTask(created.id).held === true);

  // (2) held:false clears it.
  const heldFalse = await call("project_task_update", { projectId: P_OTHER, taskId: created.id, held: false });
  check("(2) project_task_update: held:false returned in the response", heldFalse.held === false && !heldFalse.error);
  check("(2) project_task_update: held:false persisted to the DB", db.getTask(created.id).held === false);

  // (3) omitting held entirely leaves the stored value untouched (PATCH semantics).
  await call("project_task_update", { projectId: P_OTHER, taskId: created.id, held: true });
  check("(3) setup: held re-set to true before the omit-check", db.getTask(created.id).held === true);
  const omitted = await call("project_task_update", { projectId: P_OTHER, taskId: created.id, priority: "p0" });
  check("(3) project_task_update: omitting held leaves it untouched in the response", omitted.held === true && !omitted.error);
  check("(3) project_task_update: omitting held leaves it untouched in the DB", db.getTask(created.id).held === true);
  check("(3) project_task_update: the OTHER patched field still applied", db.getTask(created.id).priority === "p0");

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_task_update sets/clears held cross-project (the Lead's sanctioned path to the owner-gated hold flag on ANOTHER project's card), and omitting held never clobbers the stored value."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
