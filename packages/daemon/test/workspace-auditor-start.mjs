import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// End-User Platform tier B5 — the on-demand LAUNCH path for the end-user Workspace Auditor
// (SessionService.startWorkspaceAuditor + the human-REST role dispatch). DETERMINISTIC + CLAUDE-FREE +
// NETWORK-FREE, hermetic like audit-surface.mjs / user-audit-surface.mjs: a REAL Db + SessionService driven
// against a FAKE pty (PtyHost createPty() seam), the REAL routers over an in-process MCP InMemoryTransport
// (no HTTP, no external daemon). A real temp git repo backs the spawn cwd; the only thing faked is claude.
//
// Proves the DoD:
//   (a) ROLE-LOCKED + SURFACE — startWorkspaceAuditor produces a session with role "workspace-auditor",
//       persisted in the reserved home, and drives the (fake) pty with role "workspace-auditor". The spawn
//       map (buildMcpServers) mounts loom-user-audit ONLY (+ loom-tasks) — never platform/orch/audit/setup.
//   (b) ROLE LOCKED REGARDLESS OF PROFILE — an agent whose profile carries a DIFFERENT role ("worker", a
//       profile-spawnable one) STILL spawns a "workspace-auditor" session: the EXPLICIT caller role wins,
//       so the surface is keyed off the SESSION role, never the profile role (a mis-seeded rig can't change it).
//   (c) CREATE-ONLY, NOT a singleton (gotcha #9) — two startWorkspaceAuditor calls yield TWO DISTINCT live
//       sessions (no live-reuse), UNLIKE startSetup (which reuses its single live session). Repeated "Review
//       my workspace" clicks each get a fresh ephemeral run, never an attach to a stale finished one.
//   (d) NO AGENT MCP PATH can mint it (human-REST only) — the platform AND setup routers' session_spawn (the
//       only cross-project spawn agent tools) REFUSE role "workspace-auditor" and create nothing; and the
//       loom-user-audit surface itself exposes NO spawn/start tool. The role is also absent from the mintable
//       profile enum (validateProfile) + the operator surface (setupRoleError) — the B1 caller-set guards.
//
// Run: 1) build (turbo builds shared first), 2) node test/workspace-auditor-start.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const ROLE = "workspace-auditor";
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-b5-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost, buildMcpServers } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { WorkspaceAuditMcpRouter } = await import("../dist/mcp/user-audit.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { validateProfile } = await import("../dist/profiles/validate.js");
const { setupRoleError } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so a spawn has a valid cwd (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-b5-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# B5 test repo\n");
execSync(`git init -q && git add . && git -c user.email=b5@loom -c user.name=b5 commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// The reserved "Getting Started" home (B4) holds the operator + the Workspace Auditor agent.
db.insertProject({ id: "pSetup", name: "Getting Started", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
// The Workspace Auditor agent — no profile (the B4 seeded profile's role is COSMETIC; the session role is
// locked server-side regardless). startWorkspaceAuditor locks the role no matter what the profile says.
db.insertAgent({ id: "agentWsa", projectId: "pSetup", name: "Workspace Auditor", startupPrompt: "AUDIT", position: 0, profileId: null });
// (b) fixture: an agent whose profile carries a DIFFERENT, profile-SPAWNABLE role ("worker"). The explicit
// caller role must STILL win — proving the lock is keyed off the caller, not the profile.
db.insertProfile({ id: "profWk", name: "WkRig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentWkProfiled", projectId: "pSetup", name: "WkProfiled", startupPrompt: "WK", position: 1, profileId: "profWk" });
// The operator (setup) agent — used for the create-only CONTRAST (startSetup IS a singleton).
db.insertAgent({ id: "agentSetup", projectId: "pSetup", name: "Platform", startupPrompt: "OP", position: 2, profileId: null });
// A platform caller fixture (drives the platform router's session_spawn for the (d) refusal assertions).
db.insertAgent({ id: "agentMgr", projectId: "pOrd", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });

// Fake pty: capture createPty (spawn) calls; no real claude.
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.spawned = []; }
  createPty(opts) { this.spawned.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
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

try {
  // ============ (a) ROLE-LOCKED + SURFACE ============
  const a1 = svc.startWorkspaceAuditor("agentWsa");
  check("(a) startWorkspaceAuditor: returns a role:\"workspace-auditor\" session", a1.role === ROLE);
  check("(a) startWorkspaceAuditor: persists role + the reserved home", db.getSession(a1.id)?.role === ROLE && db.getSession(a1.id)?.projectId === "pSetup");
  check("(a) startWorkspaceAuditor: is LIVE after spawn", db.getSession(a1.id)?.processState === "live");
  check("(a) startWorkspaceAuditor: drove the (fake) pty with role=workspace-auditor", host.spawned.some((o) => o.sessionId === a1.id && o.role === ROLE));

  const map = buildMcpServers({ sessionId: a1.id, port: 4317, role: ROLE });
  check("(a) buildMcpServers(workspace-auditor): mounts loom-user-audit", !!map["loom-user-audit"]);
  check("(a) buildMcpServers(workspace-auditor): still has loom-tasks", !!map["loom-tasks"]);
  check("(a) buildMcpServers(workspace-auditor): does NOT mount loom-platform / loom-orchestration / loom-audit / loom-setup",
    !map["loom-platform"] && !map["loom-orchestration"] && !map["loom-audit"] && !map["loom-setup"]);

  // ============ (b) ROLE LOCKED REGARDLESS OF PROFILE ============
  const aWk = svc.startWorkspaceAuditor("agentWkProfiled");
  check("(b) profile role 'worker' is OVERRIDDEN — the session role is LOCKED to workspace-auditor (caller wins)",
    aWk.role === ROLE && db.getSession(aWk.id)?.role === ROLE);
  check("(b) the (fake) pty for the worker-profiled agent was driven with role=workspace-auditor (not worker)",
    host.spawned.some((o) => o.sessionId === aWk.id && o.role === ROLE));

  // ============ (c) CREATE-ONLY, NOT a singleton (gotcha #9) ============
  const a2 = svc.startWorkspaceAuditor("agentWsa");
  check("(c) two startWorkspaceAuditor calls → TWO DISTINCT sessions (no singleton reuse)", a1.id !== a2.id);
  check("(c) BOTH are live workspace-auditor sessions on the home", a2.role === ROLE && db.getSession(a2.id)?.processState === "live" && db.getSession(a1.id)?.processState === "live");
  const wsaLive = db.liveSessions("agentWsa").filter((s) => s.role === ROLE);
  check("(c) the home agent has ≥2 live workspace-auditor sessions (each Review = a fresh run)", wsaLive.length >= 2);
  // CONTRAST: startSetup IS a singleton — a 2nd call reuses the same live row (proves the difference is real).
  const s1 = svc.startSetup("agentSetup");
  const s2 = svc.startSetup("agentSetup");
  check("(c) CONTRAST: startSetup REUSES its single live session (singleton) — proves create-only ≠ singleton", s1.id === s2.id);

  // ============ (d) NO AGENT MCP PATH can mint it (human-REST only) ============
  // The mintable-profile guard + operator-surface guard (B1) — a profile/operator can never mint the role.
  check("(d) validateProfile REJECTS role:'workspace-auditor' (not profile-mintable)", validateProfile({ name: "X", role: ROLE }).ok === false);
  check("(d) setupRoleError('workspace-auditor') returns an error (operator/Setup surface can never mint it)",
    typeof setupRoleError(ROLE) === "string" && setupRoleError(ROLE).length > 0);

  // The platform router's session_spawn (the cross-project agent lifecycle tool) — must REFUSE the role.
  db.insertSession({ id: "PL", projectId: "pSetup", agentId: "agentSetup", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform", parentSessionId: null });
  const platformRouter = new PlatformMcpRouter(db, svc);
  const pServer = platformRouter.buildServer();
  const [pcT, psT] = InMemoryTransport.createLinkedPair();
  await pServer.connect(psT);
  const pClient = new Client({ name: "b5-platform", version: "0" });
  await pClient.connect(pcT);
  const nBefore = db.listAllSessions().length;
  const spawnWsa = parse(await pClient.callTool({ name: "session_spawn", arguments: { projectId: "pOrd", agentId: "agentMgr", role: ROLE } }));
  check("(d) platform session_spawn REFUSES role:\"workspace-auditor\" (no self-mint)", typeof spawnWsa.error === "string" && !spawnWsa.id);
  check("(d) the rejected workspace-auditor spawn created NO session", db.listAllSessions().length === nBefore);
  await pClient.close();

  // The setup router's session_spawn (the operator's lifecycle tool) — must ALSO refuse it.
  db.insertSession({ id: "SU", projectId: "pSetup", agentId: "agentSetup", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "setup", parentSessionId: null });
  const setupRouter = new SetupMcpRouter(db, svc);
  const suServer = setupRouter.buildServer();
  const [scT, ssT] = InMemoryTransport.createLinkedPair();
  await suServer.connect(ssT);
  const suClient = new Client({ name: "b5-setup", version: "0" });
  await suClient.connect(scT);
  const nBefore2 = db.listAllSessions().length;
  const spawnWsa2 = parse(await suClient.callTool({ name: "session_spawn", arguments: { projectId: "pOrd", agentId: "agentMgr", role: ROLE } }));
  check("(d) setup session_spawn REFUSES role:\"workspace-auditor\" (operator can never mint it)", typeof spawnWsa2.error === "string" && !spawnWsa2.id);
  check("(d) the rejected setup spawn created NO session", db.listAllSessions().length === nBefore2);
  await suClient.close();

  // The loom-user-audit surface itself — NO spawn/start/lifecycle tool (read + 2 inert suggest-writes only).
  const wsaRouter = new WorkspaceAuditMcpRouter(db, svc);
  const wsaServer = wsaRouter.buildServer(a1.id);
  const [wcT, wsT] = InMemoryTransport.createLinkedPair();
  await wsaServer.connect(wsT);
  const wClient = new Client({ name: "b5-user-audit", version: "0" });
  await wClient.connect(wcT);
  const wTools = (await wClient.listTools()).tools.map((t) => t.name);
  check("(d) loom-user-audit surface exposes NO spawn/start/lifecycle tool (read + suggest only)",
    ["session_spawn", "session_start", "startWorkspaceAuditor", "session_stop", "session_message"].every((t) => !wTools.includes(t)));
  await wClient.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — startWorkspaceAuditor locks the session role to \"workspace-auditor\" (regardless of profile) onto the loom-user-audit surface, is CREATE-ONLY (two calls → two distinct sessions, unlike the setup singleton), and NO agent MCP path can mint it (platform + setup session_spawn refuse it; the role is non-profile-mintable; the loom-user-audit surface has no spawn tool) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
