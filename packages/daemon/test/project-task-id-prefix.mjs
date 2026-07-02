import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Unambiguous project id-PREFIX resolution on the platform cross-project TASK tools (card 98c4aa23,
// filed from platform-board card 27ee3bc6). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like
// agent-id-prefix.mjs: isolated LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService against a FAKE
// pty, and the REAL PlatformMcpRouter over an in-process MCP InMemoryTransport (no HTTP).
//
// The bug: project_get/profile_read resolve an unambiguous 8-char id-prefix (mcp/id-prefix.ts ›
// getByIdPrefix), but project_task_create/project_task_get/project_task_update did an EXACT-id lookup
// only — a valid prefix returned a misleading "project not found" (implying a bad project, when the id
// was merely a prefix the write path didn't resolve).
//
// Proves, for ALL THREE task tools:
//   (1) an unambiguous 8-char project-id prefix resolves and the write lands on the RIGHT project;
//   (2) an AMBIGUOUS prefix is rejected, the error naming BOTH candidate ids (never a silent pick);
//   (3) an unknown id/prefix still 404s "project not found" (regression — historical contract preserved);
//   (4) the exact full id still resolves (regression).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-task-id-prefix.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-ptip-${Date.now()}-${process.pid}`);
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
const repo = path.join(os.tmpdir(), `loom-ptip-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# project-task-id-prefix test\n");
execSync(`git init -q && git add . && git -c user.email=ptip@loom -c user.name=ptip commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();

// CRAFTED UUID-shaped project ids: one with a UNIQUE 8-char prefix, two that SHARE an 8-char prefix.
const P_SOLO = "12ab34cd-0000-4000-8000-000000000001"; // unique prefix "12ab34cd"
const P_DUP_A = "feedface-0000-4000-8000-00000000000a"; // shares prefix "feedface" with…
const P_DUP_B = "feedface-0000-4000-8000-00000000000b"; // …this one
db.insertProject({ id: P_SOLO, name: "Solo", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: P_DUP_A, name: "Alpha", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: P_DUP_B, name: "Bravo", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });

db.insertAgent({ id: "agentPL", projectId: P_SOLO, name: "Platform Lead", startupPrompt: "PL", position: 0, profileId: null });
db.insertSession({ id: "PL", projectId: P_SOLO, agentId: "agentPL", engineSessionId: null, title: null, cwd: repo,
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
  const client = new Client({ name: "project-task-id-prefix-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // ===================== project_task_create =====================
  const created = await call("project_task_create", { projectId: "12ab34cd", title: "fix(x): via prefix" });
  check("(1) project_task_create: unambiguous prefix resolves, card lands on P_SOLO", created.projectId === P_SOLO && !created.error);
  check("(1) project_task_create: full exact id still resolves (regression)",
    (await call("project_task_create", { projectId: P_SOLO, title: "exact id" })).projectId === P_SOLO);
  const ambCreate = await call("project_task_create", { projectId: "feedface", title: "should not land" });
  check("(2) project_task_create: ambiguous prefix rejected, naming BOTH candidate ids",
    typeof ambCreate.error === "string" && ambCreate.error.includes("ambiguous") && ambCreate.error.includes(P_DUP_A) && ambCreate.error.includes(P_DUP_B));
  check("(2) project_task_create: the ambiguous call created NO card", db.listTasks(P_DUP_A).length === 0 && db.listTasks(P_DUP_B).length === 0);
  const unknownCreate = await call("project_task_create", { projectId: "99999999", title: "ghost" });
  check("(3) project_task_create: unknown prefix -> 'project not found' (regression)", unknownCreate.error === "project not found");
  const shortCreate = await call("project_task_create", { projectId: "ghost", title: "too short" });
  check("(3) project_task_create: too-short/non-matching id -> 'project not found' (regression)", shortCreate.error === "project not found");

  // ===================== project_task_get =====================
  const read = await call("project_task_get", { projectId: "12ab34cd", taskId: created.id });
  check("(1) project_task_get: unambiguous prefix resolves, reads the card back", read.id === created.id && !read.error);
  const ambGet = await call("project_task_get", { projectId: "feedface", taskId: created.id });
  check("(2) project_task_get: ambiguous prefix rejected, naming BOTH candidate ids",
    typeof ambGet.error === "string" && ambGet.error.includes("ambiguous") && ambGet.error.includes(P_DUP_A) && ambGet.error.includes(P_DUP_B));
  const unknownGet = await call("project_task_get", { projectId: "99999999", taskId: created.id });
  check("(3) project_task_get: unknown prefix -> 'project not found' (regression)", unknownGet.error === "project not found");

  // ===================== project_task_update =====================
  const moved = await call("project_task_update", { projectId: "12ab34cd", taskId: created.id, priority: "p0" });
  check("(1) project_task_update: unambiguous prefix resolves, patch persists", moved.priority === "p0" && !moved.error);
  check("(1) project_task_update: patch persisted to the DB", db.getTask(created.id).priority === "p0");
  const ambUpdate = await call("project_task_update", { projectId: "feedface", taskId: created.id, priority: "p3" });
  check("(2) project_task_update: ambiguous prefix rejected, naming BOTH candidate ids",
    typeof ambUpdate.error === "string" && ambUpdate.error.includes("ambiguous") && ambUpdate.error.includes(P_DUP_A) && ambUpdate.error.includes(P_DUP_B));
  check("(2) project_task_update: the ambiguous call did NOT mutate the card", db.getTask(created.id).priority === "p0");
  const unknownUpdate = await call("project_task_update", { projectId: "99999999", taskId: created.id, priority: "p3" });
  check("(3) project_task_update: unknown prefix -> 'project not found' (regression)", unknownUpdate.error === "project not found");
  check("(3) project_task_update: the rejected update did NOT mutate the card", db.getTask(created.id).priority === "p0");

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_task_create/get/update accept an unambiguous 8-char project-id prefix (same resolver as project_get), reject an ambiguous prefix by naming both candidate ids without mutating anything, and still 404 'project not found' on an unknown id/prefix or resolve an exact full id (regressions preserved)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
