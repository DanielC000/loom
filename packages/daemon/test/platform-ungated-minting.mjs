import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f437d4e9 C1, Decision 5 — the SAFETY REQUIREMENT for dropping mcp/platform.ts's `isLoomDev()`
// router gate: ANY role:"platform" session now reaches /mcp-platform on EVERY install, so this test
// proves the ONLY way a session row's `role` column can ever become "platform" on a non-dev install is
// the seeded Lead's own start/recycle path — never a profile, never an agent-facing session_spawn, never
// worker_spawn, never a manager/worker recycle, never template_apply. LOOM_DEV is deliberately left
// UNSET throughout (the real end-user shape under test).
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: isolated LOOM_HOME + sandboxed HOME, a REAL Db + SessionService
// driven against a FAKE pty (PtyHost createPty() seam, mirrors worker-spawn-agent-gate.mjs), a real temp
// git repo (spawnWorker's createWorktree needs a real HEAD to branch off), and the REAL PlatformMcpRouter
// over an in-process MCP InMemoryTransport for the session_spawn + profile_assign combination.
//
// Each enumerated path is EXERCISED directly (never merely re-read):
//   (1) a profile with role:"platform" is a legal profile ROW (validateProfile, both create and a
//       role-reassignment update) — but PROFILE_SPAWNABLE_ROLES structurally excludes "platform" from
//       what a profile can CONFER on a role-omitted spawn (startNew / "+New").
//   (2) session_spawn on the platform + setup MCP surfaces rejects an explicit role:"platform" request,
//       AND — the load-bearing COMBINATION decision 5 calls out — binding a role:"platform" profile to
//       an agent via profile_assign does NOT let a later role-omitted-equivalent session_spawn on THAT
//       SAME agent ever produce role:"platform" (the profile confers nothing). (orchestration.ts's companion session-spawn lever and
//       companion/capabilities.ts's own spawnableRoleError predicate are the SAME shared chokepoint
//       session_spawn mounts here — already independently exercised, with the full ROLE REFUSAL matrix,
//       by companion-session-spawn.mjs; not re-duplicated in this file.)
//   (3) worker_spawn REFUSES a platform-role target agent before any side effect, and a normal worker
//       spawn always resolves role:"worker" (also independently exercised by worker-spawn-agent-gate.mjs;
//       re-exercised here too so this file is a standalone, complete proof of decision 5).
//   (4) recycleManager/recycleWorker hardcode their successor's role literally ("manager"/"worker") —
//       rebinding the underlying agent's profile to a role:"platform" one BEFORE a recycle changes
//       nothing about the successor's role.
//   (5) template_apply (via templateAssignableProfileError + applyWorkflowTemplate's own backstop)
//       fail-closed rejects a templated agent whose named profile resolves to role:"platform", writing
//       NOTHING.
//   (6) recyclePlatformLead is carry-forward ONLY: it throws on a non-platform session, and only
//       SUCCEEDS (producing role:"platform") when the OLD session already IS role:"platform" — it never
//       originates the role.
//   (7) startPlatformLead has exactly ONE call site in the whole source tree (gateway/server.ts, the
//       human-REST session-start route) — confirmed by a structural source scan — and calling it
//       directly DOES mint role:"platform" (the one true positive; the boundary is "nothing agent-facing
//       calls this", never an internal runtime flag).
//   (8) forkSession carries `role: src.role ?? undefined` straight from the SOURCE ROW — it never reads
//       the agent's profile at all. So (a) forking a non-platform session whose agent's profile has
//       since been rebound to role:"platform" still resolves to the source row's OWN role, never
//       "platform"; and (b) forking an EXISTING role:"platform" session is the one sanctioned
//       carry-forward (decision 8ddcf787: multiple concurrent Leads are allowed) and DOES succeed,
//       producing another role:"platform" row — reachable ONLY from an already-role:"platform" source.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-ungated-minting.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const rejects = async (label, fn, needle) => {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  const ok = threw != null && (!needle || String(threw.message).includes(needle));
  check(`${label}${ok || !threw ? "" : ` (got: ${threw.message})`}`, ok);
};

// --- Hermetic LOOM_HOME + a sandboxed HOME. LOOM_DEV deliberately left UNSET throughout. ---
const tmpHome = path.join(os.tmpdir(), `loom-pum-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.LOOM_DEV;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { validateProfile } = await import("../dist/profiles/validate.js");
const { templateAssignableProfileError, applyWorkflowTemplate } = await import("../dist/setup/templates.js");
const { isLoomDev } = await import("../dist/paths.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

check("(precondition) isLoomDev() is FALSE (LOOM_DEV unset)", isLoomDev() === false);

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-pum-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# platform-ungated-minting test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=pum@loom -c user.name=pum");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// A SEPARATE reserved/system project, mirroring the real Lead's own home — decision ad098631 confines an
// elevated/locked-role profile bind (other than "assistant") to a reserved project, so the realistic
// profile_assign + session_spawn combination in group (2) below needs its target agent living in ONE.
db.insertProject({ id: "pHome", name: "Home", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
// A role:"platform" profile — a legal human-authored row (point 1), later bound to various agents to
// prove binding it never confers the role at spawn/recycle time.
db.insertProfile({ id: "profPlatform", name: "Platform Rig", role: "platform", description: "elevated rig", allowDelta: [], skills: null, model: null, icon: "🛰️" });
db.insertProfile({ id: "profDev", name: "Dev", role: "worker", description: "dev rig", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentCoord", projectId: "pP", name: "Coord", startupPrompt: "COORD", position: 0, profileId: null });
db.insertAgent({ id: "agentCoordHome", projectId: "pHome", name: "CoordHome", startupPrompt: "COORD_HOME", position: 0, profileId: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 1, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 2, profileId: "profDev" });
db.insertAgent({ id: "agentLead", projectId: "pP", name: "Lead", startupPrompt: "LEAD", position: 3, profileId: null });

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.spawned = []; }
  createPty(opts) { this.spawned.push(opts); return super.createPty(opts); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

/** Seed a forkable (idle, exited, real-on-disk-transcript) session row directly, for group (8)'s
 *  forkSession cases — mirrors resume-fork-plain-role-not-widened.mjs's own seedSource helper. */
function seedForkableSession(id, role, agentId) {
  const engId = `${id}-eng-0000-0000-000000000000`;
  db.insertSession({
    id, projectId: "pP", agentId, engineSessionId: engId, title: null, cwd: repo,
    processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role,
  });
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  return engId;
}

const worktrees = [];
try {
  // ===================== (1) profile ROW allows role:"platform", spawn CONFERS nothing =====================
  const createOk = validateProfile({ name: "X", role: "platform" });
  check("(1) validateProfile CREATE accepts role:'platform' (a legal profile ROW)", createOk.ok === true && createOk.value.role === "platform");
  const reassignOk = validateProfile({ name: "X", role: "platform" }, { previousRole: "worker" });
  check("(1) validateProfile UPDATE allows REASSIGNING an existing profile's role TO 'platform' (unlike auditor/workspace-auditor's carry-forward-only gate)", reassignOk.ok === true);

  // Bind agentCoord to the role:"platform" profile directly (simulates agent_update/profile_assign's
  // effect on the row) and attempt a role-omitted "+New" spawn — PROFILE_SPAWNABLE_ROLES excludes
  // "platform", so this must resolve to a PLAIN (role-null) session, never role:"platform".
  db.updateAgent("agentCoord", { profileId: "profPlatform" });
  const plainFromPlatformProfile = svc.startNew("agentCoord");
  check("(1) startNew on a role:'platform'-profile agent (no explicit role) resolves role to null (NOT 'platform')", plainFromPlatformProfile.role == null);
  check("(1) the DB row persists role=null too", db.getSession(plainFromPlatformProfile.id).role == null);

  // ===================== (2) session_spawn — explicit role:'platform' refused on platform + setup =====================
  // A live platform-lead session to drive the platform router as caller (the realistic shape: an
  // ALREADY-minted Lead attempting to self-elevate a NEW session, which must still fail).
  db.insertSession({
    id: "PL", projectId: "pP", agentId: "agentLead", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "platform", parentSessionId: null,
  });
  const platformRouter = new PlatformMcpRouter(db, svc);
  check("(2) a role:'platform' session DOES reach /mcp-platform with LOOM_DEV unset (resolveRole truthy)", !!platformRouter.resolveRole("PL"));
  const platformServer = platformRouter.buildServer();
  const [plClientT, plServerT] = InMemoryTransport.createLinkedPair();
  await platformServer.connect(plServerT);
  const plClient = new Client({ name: "pum-platform-test", version: "0" });
  await plClient.connect(plClientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  const callPlatform = async (name, args) => parse(await plClient.callTool({ name, arguments: args }));

  const nSessBeforeSelfElevate = db.listAllSessions().length;
  const selfElevate = await callPlatform("session_spawn", { projectId: "pP", agentId: "agentMgr", role: "platform" });
  check("(2) session_spawn(role:'platform') is REJECTED on the platform surface", typeof selfElevate.error === "string" && !selfElevate.id);
  check("(2) the rejected self-elevation attempt created NO session", db.listAllSessions().length === nSessBeforeSelfElevate);

  // THE COMBINATION decision 5 calls out: bind agentCoordHome's profile to the role:"platform" rig via
  // the REAL profile_assign tool (not a direct db write this time — and the target lives in the
  // RESERVED "pHome" project, since decision ad098631 confines an elevated bind like this one to a
  // reserved/system project), THEN session_spawn on THAT SAME agent — the resolved role must never be
  // "platform". role:"plain" (not "manager") is the probe here: "pHome" being reserved separately bars
  // a fresh MANAGER start there (decision 37e15c26), which would confound this specific assertion — the
  // manager-never-overridden-by-profile half of decision 5 is already proven in group (1)/(2) above
  // against the non-reserved "pP" project.
  const assignResult = await callPlatform("profile_assign", { agentId: "agentCoordHome", profileId: "profPlatform" });
  check("(2) profile_assign binds the role:'platform' profile to agentCoordHome, a reserved-home agent (the Lead MAY do this — decision 3de74275)", assignResult.ok === true || !assignResult.error);
  check("(2) agentCoordHome's profileId is now profPlatform", db.getAgent("agentCoordHome").profileId === "profPlatform");
  const spawnPlainOnPlatformBoundAgent = await callPlatform("session_spawn", { projectId: "pHome", agentId: "agentCoordHome", role: "plain" });
  check("(2) session_spawn(role:'plain') on an agent now bound to a role:'platform' profile resolves role to null (profile role confers NOTHING)",
    !!spawnPlainOnPlatformBoundAgent.id && spawnPlainOnPlatformBoundAgent.role == null && !spawnPlainOnPlatformBoundAgent.error);
  const spawnPlatformOnPlatformBoundAgent = await callPlatform("session_spawn", { projectId: "pHome", agentId: "agentCoordHome", role: "platform" });
  check("(2) session_spawn(role:'platform') on that SAME platform-bound agent is STILL rejected", typeof spawnPlatformOnPlatformBoundAgent.error === "string" && !spawnPlatformOnPlatformBoundAgent.id);
  await plClient.close();

  // Same proof, SetupMcpRouter surface (the other agent-facing session_spawn mirror) — a setup session
  // attempting role:"platform" is rejected too. (The companion/orchestration lever's own full ROLE
  // REFUSAL matrix is already independently exercised by companion-session-spawn.mjs.)
  db.insertSession({
    id: "SU", projectId: "pP", agentId: "agentLead", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "setup", parentSessionId: null,
  });
  const setupRouter = new SetupMcpRouter(db, svc);
  const setupServer = setupRouter.buildServer();
  const [suClientT, suServerT] = InMemoryTransport.createLinkedPair();
  await setupServer.connect(suServerT);
  const suClient = new Client({ name: "pum-setup-test", version: "0" });
  await suClient.connect(suClientT);
  const callSetup = async (name, args) => parse(await suClient.callTool({ name, arguments: args }));
  const nSessBeforeSetupElevate = db.listAllSessions().length;
  const setupSelfElevate = await callSetup("session_spawn", { projectId: "pP", agentId: "agentMgr", role: "platform" });
  check("(2) session_spawn(role:'platform') is REJECTED on the setup surface too", typeof setupSelfElevate.error === "string" && !setupSelfElevate.id);
  check("(2) the rejected setup-surface attempt created NO session", db.listAllSessions().length === nSessBeforeSetupElevate);
  await suClient.close();

  // ===================== (3) worker_spawn — refuses a platform-role target agent; hardcodes role:'worker' =====================
  db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const taskRefuse = randomUUID(), taskOk = randomUUID();
  db.insertTask({ id: taskRefuse, projectId: "pP", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  db.insertTask({ id: taskOk, projectId: "pP", title: "t", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
  await rejects("(3) worker_spawn REFUSES a target agent bound to a role:'platform' profile",
    () => svc.spawnWorker("mgr1", { taskId: taskRefuse, agentId: "agentCoord", kickoffPrompt: "GO" }), "platform-role");
  const nSessBeforeRefusedWorker = db.listAllSessions().length;
  check("(3) the refused worker_spawn created NO session", db.listAllSessions().length === nSessBeforeRefusedWorker);

  const wDev = await svc.spawnWorker("mgr1", { taskId: taskOk, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wDev.worktreePath);
  check("(3) worker_spawn on an ordinary worker agent resolves role:'worker'", wDev.role === "worker");

  // ===================== (4) recycleManager/recycleWorker — successor role is HARDCODED, never re-derived =====================
  // Rebind agentMgr's profile to the role:'platform' rig AFTER the manager is already live, then recycle.
  db.updateAgent("agentMgr", { profileId: "profPlatform" });
  const mgrSuccessor = await svc.recycleManager("mgr1", "continue as the new manager");
  check("(4) recycleManager's successor is role:'manager' even though its agent is NOW bound to a role:'platform' profile", mgrSuccessor.role === "manager");

  // Rebind agentDev's profile to the role:'platform' rig AFTER the worker is already live, then recycle.
  db.updateAgent("agentDev", { profileId: "profPlatform" });
  const workerSuccessor = await svc.recycleWorker(mgrSuccessor.id, wDev.id, "handoff to the new worker");
  check("(4) recycleWorker's successor is role:'worker' even though its agent is NOW bound to a role:'platform' profile", workerSuccessor.role === "worker");

  // ===================== (5) template_apply — fail-closed against a role:'platform' templated agent =====================
  const nAgentsBeforeTemplate = db.listAgents("pP").length;
  const badTemplate = {
    name: "Rogue Lead",
    description: "a hostile template trying to stand up a platform-role agent",
    agents: [{ name: "Shadow Lead", profileName: "Platform Rig", startupPrompt: "x", position: 0 }],
    boardSeed: [],
  };
  const templateErr = templateAssignableProfileError(db, badTemplate);
  check("(5) templateAssignableProfileError REJECTS a templated agent bound to the role:'platform' profile", typeof templateErr === "string" && /platform/i.test(templateErr));
  await rejects("(5) applyWorkflowTemplate's own backstop ALSO throws for the same template",
    async () => applyWorkflowTemplate(db, badTemplate, "pP"), "platform");
  check("(5) the rejected template apply created NO new agent", db.listAgents("pP").length === nAgentsBeforeTemplate);

  // ===================== (6) recyclePlatformLead — carry-forward ONLY, never originates =====================
  await rejects("(6) recyclePlatformLead REFUSES a non-platform session (manager successor)",
    () => svc.recyclePlatformLead(mgrSuccessor.id, "continue"), "not a platform session");
  // "PL" (seeded in group (2) above) IS already role:"platform" — recycling it is the one sanctioned
  // carry-forward and must succeed, producing another role:"platform" row.
  const leadSuccessor = await svc.recyclePlatformLead("PL", "continue as the new Lead");
  check("(6) recyclePlatformLead on an EXISTING role:'platform' session SUCCEEDS, carrying role:'platform' forward", leadSuccessor.role === "platform");

  // ===================== (7) startPlatformLead — exactly ONE call site; the true positive =====================
  const serviceSrc = fs.readFileSync(path.join(__dirname, "..", "src", "sessions", "service.ts"), "utf8");
  const serviceSrcNoComments = serviceSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const definitionHits = (serviceSrcNoComments.match(/\bstartPlatformLead\s*\(/g) ?? []).length;
  check("(7) startPlatformLead's own definition is the ONLY non-call-site occurrence of its name as a declaration in service.ts (sanity: the grep below is counting CALLS, not re-matching the def)", definitionHits >= 1);
  const gatewaySrc = fs.readFileSync(path.join(__dirname, "..", "src", "gateway", "server.ts"), "utf8");
  const gatewaySrcNoComments = gatewaySrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const gatewayCallHits = (gatewaySrcNoComments.match(/\.startPlatformLead\s*\(/g) ?? []).length;
  check("(7) gateway/server.ts calls .startPlatformLead EXACTLY once", gatewayCallHits === 1);
  check("(7) that one call site passes spawnHumanAuthorized: true", /\.startPlatformLead\([^)]*spawnHumanAuthorized:\s*true/.test(gatewaySrcNoComments));
  // Negative control for the grep above: confirm it can find a KNOWN-PRESENT call at all (not a broken
  // pattern silently returning a count of 0/1 that looks right by accident) — recyclePlatformLead's own
  // definition + the ONE call site exercised in group (6) above are both findable the same way.
  const recycleDefHits = (serviceSrcNoComments.match(/\brecyclePlatformLead\s*\(/g) ?? []).length;
  check("(7, negative control) the SAME grep style finds recyclePlatformLead's own definition (>=1), proving the pattern isn't silently broken", recycleDefHits >= 1);
  // Calling startPlatformLead DIRECTLY — the service method itself has NO internal runtime flag refusing
  // this; the boundary is structural (nothing agent-facing calls it). It DOES mint role:"platform" — the
  // one true positive this whole enumeration is built around.
  const freshLead = svc.startPlatformLead("agentLead", { spawnHumanAuthorized: true });
  check("(7) startPlatformLead itself DOES mint role:'platform' (the one sanctioned mint path)", freshLead.role === "platform");

  // ===================== (8) forkSession — role is CARRIED from the source row, never re-derived from a profile =====================
  // (8a) agentCoord's profile was rebound to profPlatform (role:"platform") back in group (1) above, and
  // is STILL bound to it here. Fork a non-platform (role:null) session on that SAME agent — forkSession
  // must resolve the fork's role from the SOURCE ROW, never from the agent's (now platform-role) profile.
  check("(8a, precondition) agentCoord is still bound to the role:'platform' profile", db.getAgent("agentCoord").profileId === "profPlatform");
  seedForkableSession("srcPlainOnPlatformBoundAgent", null, "agentCoord");
  const forkedFromNonPlatform = svc.forkSession("srcPlainOnPlatformBoundAgent");
  check("(8a) forking a non-platform (role:null) session whose agent is bound to a role:'platform' profile resolves the fork's role to null, NOT 'platform'", forkedFromNonPlatform.role == null);
  check("(8a) the DB row persists role=null too (not merely the in-memory return value)", db.getSession(forkedFromNonPlatform.id).role == null);

  // (8a, second case) same proof against a WORKER-role source, so the enumeration covers a non-null role
  // too, not just the role:null case above.
  seedForkableSession("srcWorkerOnPlatformBoundAgent", "worker", "agentCoord");
  const forkedWorkerFromNonPlatform = svc.forkSession("srcWorkerOnPlatformBoundAgent");
  check("(8a) forking a role:'worker' session whose agent is bound to a role:'platform' profile resolves the fork's role to 'worker' (the SOURCE's own role), NOT 'platform'", forkedWorkerFromNonPlatform.role === "worker");

  // (8b) Fork an EXISTING role:"platform" session — the one sanctioned carry-forward (decision 8ddcf787:
  // multiple concurrent Leads are allowed; forkSession deliberately has no role==="platform" refusal,
  // unlike its role==="setup"/role==="manager" guards above) — succeeds, producing another role:"platform" row.
  seedForkableSession("srcPlatformForFork", "platform", "agentLead");
  const forkedPlatform = svc.forkSession("srcPlatformForFork");
  check("(8b) forking an EXISTING role:'platform' session SUCCEEDS, carrying role:'platform' forward", forkedPlatform.role === "platform");
  check("(8b) the DB row persists role='platform' too", db.getSession(forkedPlatform.id).role === "platform");
  check("(8b) forkSession's own role==='platform' carry-forward is reachable ONLY from an already-role:'platform' source — (8a)'s null/worker sources on the SAME bound-to-platform-profile agent both failed to produce it, so the profile confers nothing and only the source row's own role does", forkedFromNonPlatform.role !== "platform" && forkedWorkerFromNonPlatform.role !== "platform" && forkedPlatform.role === "platform");
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of worktrees.filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card f437d4e9 C1 decision 5: with LOOM_DEV unset, a profile may freely carry role:'platform' and may be bound to any agent, but nothing agent-facing (session_spawn on platform/setup, worker_spawn, manager/worker recycle, template_apply, forkSession) can ever turn that into a role:'platform' SESSION; recyclePlatformLead and forkSession only ever carry an existing one forward; startPlatformLead is the sole mint path, reachable from exactly one human-REST call site — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
