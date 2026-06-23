import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// repoPath REBIND on project_update — the elevated/human-only editable-repoPath surface + the
// live-worktree rebind guard (mcp/platform.ts project_update, POST /api/projects/:id REST, the shared
// checkRepoRebind guard, db.updateProject/listLiveWorktreeSessionsInProject). DETERMINISTIC + CLAUDE-FREE
// + NETWORK-FREE, hermetic like platform-mgmt-surface.mjs: a REAL Db + SessionService against a FAKE pty,
// the REAL PlatformMcpRouter + SetupMcpRouter driven over in-process MCP InMemoryTransport (no HTTP). Real
// temp git repos back the bind/rebind targets; the only thing faked is the claude pty.
//
// Proves the DoD:
//   (1) elevated project_update REBINDS repoPath to a valid git repo (isGitRepo) — persisted to the Db;
//   (2) a non-repo target is REJECTED (isGitRepo), stored repoPath left UNCHANGED;
//   (3) a rebind is BLOCKED while the project has a LIVE worktree session — the offending session is
//       named, stored repoPath UNCHANGED — on BOTH the MCP tool AND the shared checkRepoRebind guard
//       (which the REST PATCH path uses verbatim);
//   (4) the HARD CONSTRAINT: repoPath is NOT on the agent-facing loom-setup surface — its project_update
//       inputSchema has no repoPath, and passing one is ignored (repoPath unchanged).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-rebind.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-rebind-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { checkRepoRebind } = await import("../dist/projects/rebind.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- Real temp git repos: repoA (initial bind), repoB (a valid rebind target). Plus a non-repo dir. ---
const mkRepo = (tag) => {
  const r = path.join(os.tmpdir(), `loom-rebind-${tag}-${Date.now()}-${process.pid}`);
  fs.mkdirSync(r, { recursive: true });
  fs.writeFileSync(path.join(r, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m init`, { cwd: r });
  return r;
};
const repoA = mkRepo("A");
const repoB = mkRepo("B");
const nonRepo = path.join(os.tmpdir(), `loom-rebind-nonrepo-${Date.now()}-${process.pid}`);
fs.mkdirSync(nonRepo, { recursive: true }); // a real dir, but NOT a git repo

const now = new Date().toISOString();
const db = new Db();
// Reserved home for the Lead + the ordinary project under test (bound to repoA).
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repoA, vaultPath: repoA, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pProj", name: "Project", repoPath: repoA, vaultPath: repoA, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
db.insertAgent({ id: "agentWork", projectId: "pProj", name: "Work", startupPrompt: "WORK", position: 0, profileId: null });

const seedSession = (id, role, extra) => db.insertSession({
  id, projectId: extra?.projectId ?? "pProj", agentId: "agentWork", engineSessionId: null, title: null,
  cwd: extra?.cwd ?? repoA, processState: extra?.processState ?? "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role, parentSessionId: extra?.parent ?? null,
  worktreePath: extra?.worktreePath ?? null, branch: extra?.branch ?? null,
});
// A platform (Lead) session — the elevated caller. A setup session — the agent-facing fixture.
seedSession("PL", "platform", { projectId: "pProj" });
seedSession("SU", "setup", { projectId: "pProj" });

// Fake pty (no real claude). Same SeamHost shape as platform-mgmt-surface.mjs.
class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const parse = (res) => JSON.parse(res.content[0].text);
const connect = async (router, sessionId) => {
  const server = router.buildServer(sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "rebind-test", version: "0" });
  await client.connect(clientT);
  return { client, call: async (name, args) => parse(await client.callTool({ name, arguments: args })) };
};

try {
  const plat = await connect(new PlatformMcpRouter(db, svc), "PL");

  // (0) project_update advertises repoPath on the ELEVATED surface.
  const tools = (await plat.client.listTools()).tools;
  const puSchema = tools.find((t) => t.name === "project_update")?.inputSchema?.properties ?? {};
  check("(0) platform project_update inputSchema EXPOSES repoPath", "repoPath" in puSchema);

  // (1) Rebind to a valid git repo succeeds + persists.
  const ok1 = await plat.call("project_update", { projectId: "pProj", repoPath: repoB });
  check("(1) rebind to a valid repo succeeds", ok1.repoPath === repoB && !ok1.error);
  check("(1) rebind persisted to the Db", db.getProject("pProj").repoPath === repoB);

  // (2) A non-repo target is rejected (isGitRepo); stored repoPath unchanged (still repoB).
  const bad = await plat.call("project_update", { projectId: "pProj", repoPath: nonRepo });
  check("(2) a non-repo target is REJECTED (isGitRepo)", typeof bad.error === "string" && /not an existing git repository/.test(bad.error));
  check("(2) the rejected rebind left repoPath UNCHANGED", db.getProject("pProj").repoPath === repoB);

  // structural fields still update alongside (and without) a repoPath edit.
  const struct = await plat.call("project_update", { projectId: "pProj", name: "Renamed", vaultPath: repoB, repoPath: repoA });
  check("(1b) name + vaultPath + repoPath update together", struct.name === "Renamed" && struct.vaultPath === repoB && struct.repoPath === repoA && !struct.error);
  check("(1b) 404 on an unknown project", (await plat.call("project_update", { projectId: "ghost", repoPath: repoB })).error === "project not found");

  // (3) A LIVE worktree session BLOCKS the rebind — named, repoPath unchanged. (project currently bound to repoA.)
  seedSession("Wlive", "worker", { worktreePath: path.join(tmpHome, "wt-live"), branch: "loom/task", parent: "PL" });
  const blocked = await plat.call("project_update", { projectId: "pProj", repoPath: repoB });
  check("(3) rebind BLOCKED while a live worktree session exists", typeof blocked.error === "string" && /live worktree session/.test(blocked.error));
  check("(3) the block names the offending session", blocked.error.includes("Wlive") && Array.isArray(blocked.liveSessions) && blocked.liveSessions.some((s) => s.sessionId === "Wlive"));
  check("(3) the blocked rebind left repoPath UNCHANGED (still repoA)", db.getProject("pProj").repoPath === repoA);

  // (3b) the SHARED guard the REST PATCH path uses behaves identically.
  const guardBlocked = await checkRepoRebind(db, "pProj", repoB);
  check("(3b) checkRepoRebind (REST-shared) BLOCKS while a live worktree session exists", guardBlocked.ok === false && /live worktree session/.test(guardBlocked.error));
  const guardNonRepo = await checkRepoRebind(db, "pProj", nonRepo);
  check("(3b) checkRepoRebind REJECTS a non-repo", guardNonRepo.ok === false && /not an existing git repository/.test(guardNonRepo.error));
  // Once the worker exits, the guard clears and a rebind is allowed again.
  db.setProcessState("Wlive", "exited");
  const guardClear = await checkRepoRebind(db, "pProj", repoB);
  check("(3c) checkRepoRebind PASSES once no live worktree session remains", guardClear.ok === true);
  const ok3 = await plat.call("project_update", { projectId: "pProj", repoPath: repoB });
  check("(3c) rebind succeeds again after the worker exits", ok3.repoPath === repoB && !ok3.error);

  await plat.client.close();

  // (4) HARD CONSTRAINT — repoPath is NOT on the agent-facing loom-setup surface.
  const setup = await connect(new SetupMcpRouter(db, svc), "SU");
  const setupTools = (await setup.client.listTools()).tools;
  const setupPu = setupTools.find((t) => t.name === "project_update")?.inputSchema?.properties ?? {};
  check("(4) loom-setup project_update inputSchema has NO repoPath (human-only by design)", !("repoPath" in setupPu));
  // Even if a caller smuggles repoPath, zod strips the unknown arg → repoPath is NOT changed.
  const before = db.getProject("pProj").repoPath;
  await setup.call("project_update", { projectId: "pProj", name: "Setup-rename", repoPath: repoA });
  check("(4) a repoPath passed to loom-setup project_update is IGNORED (repoPath unchanged)", db.getProject("pProj").repoPath === before);
  await setup.client.close();
} finally {
  db.close();
  for (const d of [tmpHome, repoA, repoB, nonRepo]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — repoPath is editable ONLY on the elevated platform MCP + human REST (shared checkRepoRebind: isGitRepo + live-worktree guard), a non-repo and a live-worktree rebind are refused without mutating the binding, and repoPath is absent from the agent-facing loom-setup surface — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
