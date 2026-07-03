import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform Manager P2 — the Lead's cross-project management surface (mcp/platform.ts). DETERMINISTIC +
// CLAUDE-FREE + NETWORK-FREE, hermetic like worker-spawn-agent-gate.mjs / profile-spawn.mjs: a REAL Db +
// SessionService driven against a FAKE pty (PtyHost createPty()/stop() seam), and the REAL
// PlatformMcpRouter driven over an in-process MCP InMemoryTransport (no HTTP, no external daemon). A real
// temp git repo backs the manager/plain spawn cwd; the only thing faked is the claude pty.
//
// Proves the DoD:
//   (a) every P2 tool works for a platform session (visible via the Db) — list_all_*, profile_*,
//       session_spawn (manager|plain), session_stop, project_update/archive, schedule_create/update;
//   (b) the role gate holds — resolveRole() is the exact predicate handle() 404s on: platform → surface,
//       manager/worker/plain → null (no surface). (platform-scope.mjs proves the live-HTTP 404 too.)
//   (c) session_spawn REJECTS role:"platform" AND role:"worker" (and any other) — the single most
//       important invariant — and creates NO session; it SUCCEEDS only for manager|plain;
//   (d) project_archive REFUSES a reserved/system project (the Lead can't archive its own home);
//   (e) profile_delete / agent_delete (task 2c9b2960) mirror the human DELETE /api/profiles/:id and
//       /api/agents/:id EXACTLY: profile_delete has NO in-use guard (an assigned profileId just dangles
//       safely); agent_delete refuses while the agent has a LIVE session; both 404 on an unknown id.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-mgmt-surface.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-p2-${Date.now()}-${process.pid}`);
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
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so a manager/plain spawn has a valid cwd (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-p2-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# platform P2 test repo\n");
execSync(`git init -q && git add . && git -c user.email=p2@loom -c user.name=p2 commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// The reserved/system "Loom Platform" home (P1) — project_archive must REFUSE it.
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
// An ordinary project (the spawn/update target) + a throwaway one to archive.
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pArch", name: "ToArchive", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
// Agents: a Lead in the home; a worker-agent + a manager-agent in the ordinary project.
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
db.insertAgent({ id: "agentWork", projectId: "pOrd", name: "Work", startupPrompt: "WORK", position: 0, profileId: null });
db.insertAgent({ id: "agentMgr", projectId: "pOrd", name: "Mgr", startupPrompt: "MGR", position: 1, profileId: null });
// A human-authored profile (the only kind that exists pre-P2) — profile_assign target.
db.insertProfile({ id: "profQA", name: "QA Tester", role: "worker", description: "qa rig", allowDelta: [], skills: null, model: null, icon: "🧪", browserTesting: true });
// One session per role (bound to pOrd/agentWork) — the role-gate fixtures.
const seedSession = (id, role, parent) => db.insertSession({
  id, projectId: "pOrd", agentId: "agentWork", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: parent ?? null,
});
seedSession("PL", "platform", null);
seedSession("M", "manager", null);
seedSession("W", "worker", "M");
seedSession("P", null, null);

// Fake pty: capture createPty (spawn) + stop calls; no real claude, no real signals.
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.spawned = []; this.stopped = []; }
  createPty(opts) { this.spawned.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop(id, mode) { this.stopped.push({ id, mode }); } // capture; don't drive real signal handling
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const router = new PlatformMcpRouter(db, svc);

const parse = (res) => JSON.parse(res.content[0].text);

try {
  // ===================== (b) ROLE GATE — resolveRole is the predicate handle() 404s on =====================
  check("(b) platform session PL HAS the surface (resolveRole truthy)", !!router.resolveRole("PL"));
  check("(b) manager session M gets NO surface (resolveRole null)", router.resolveRole("M") === null);
  check("(b) worker session W gets NO surface (resolveRole null)", router.resolveRole("W") === null);
  check("(b) plain session P gets NO surface (resolveRole null)", router.resolveRole("P") === null);
  check("(b) an unknown session gets NO surface", router.resolveRole("ghost") === null);

  // --- Connect a REAL MCP client to the router's tool server over an in-memory transport (no HTTP).
  // buildServer() is the same McpServer handle() builds per request; the role gate above guards entry. ---
  const server = router.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "platform-p2-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  // 0) Surface: every P2 tool is registered (alongside the P1 three).
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const expected = [
    "list_all_projects", "list_all_agents", "list_all_sessions",
    "profile_create", "profile_update", "profile_assign", "profile_delete", "agent_delete",
    "session_spawn", "session_stop", "project_update", "project_archive",
    "schedule_create", "schedule_update",
  ];
  check(`(a) surface includes all P2 tools (missing: ${expected.filter((t) => !tools.includes(t)).join(",") || "none"})`,
    expected.every((t) => tools.includes(t)));
  check("(a) P1 tools still present", ["project_create", "agent_create", "project_configure"].every((t) => tools.includes(t)));

  // ===================== (a) CROSS-PROJECT READS =====================
  const projs = await call("list_all_projects", {});
  check("list_all_projects: includes the reserved home AND ordinary projects",
    projs.some((p) => p.id === "pHome") && projs.some((p) => p.id === "pOrd") && projs.some((p) => p.id === "pArch"));
  const allAgents = await call("list_all_agents", {});
  check("list_all_agents (no filter): aggregates across projects (lead + work + mgr)",
    ["agentLead", "agentWork", "agentMgr"].every((id) => allAgents.some((a) => a.id === id)));
  const ordAgents = await call("list_all_agents", { projectId: "pOrd" });
  check("list_all_agents (projectId): narrows to that project only",
    ordAgents.length === 2 && ordAgents.every((a) => a.projectId === "pOrd"));
  const allSess = await call("list_all_sessions", {});
  check("list_all_sessions (no filter): returns the seeded sessions, enriched with names",
    allSess.some((s) => s.id === "PL" && s.projectName === "Ordinary" && s.agentName === "Work"));
  const ordSess = await call("list_all_sessions", { projectId: "pOrd" });
  check("list_all_sessions (projectId): all rows belong to that project", ordSess.length >= 4 && ordSess.every((s) => s.projectId === "pOrd"));

  // ===================== (a) PROFILES (the human-equivalent elevation, gated to platform) =====================
  const nProfBefore = db.listProfiles().length;
  const pc = await call("profile_create", { profile: { name: "Reviewer", role: "worker", allowDelta: ["Bash(git diff:*)"] } });
  check("profile_create: returns a profile with an id", !!pc.id && !pc.error);
  check("profile_create: persists to the Db (role + allowDelta survive)",
    db.getProfile(pc.id)?.role === "worker" && db.getProfile(pc.id)?.allowDelta.length === 1 && db.listProfiles().length === nProfBefore + 1);
  const pcBad = await call("profile_create", { profile: { name: "Bad", bogusField: 1 } });
  check("profile_create: an unknown field is rejected (strict validator), nothing created",
    typeof pcBad.error === "string" && !pcBad.id && db.listProfiles().length === nProfBefore + 1);
  const pcBadRole = await call("profile_create", { profile: { name: "BadRole", role: "wizard" } });
  check("profile_create: an invalid role is rejected", typeof pcBadRole.error === "string" && !pcBadRole.id);

  const pu = await call("profile_update", { profileId: pc.id, patch: { description: "edited", icon: "🔍" } });
  check("profile_update: partial patch merges + persists", pu.description === "edited" && pu.icon === "🔍" && pu.role === "worker" && !pu.error);
  check("profile_update: 404 on an unknown id", (await call("profile_update", { profileId: "ghost", patch: { name: "x" } })).error === "profile not found");
  const puBad = await call("profile_update", { profileId: pc.id, patch: { role: "wizard" } });
  check("profile_update: an invalid merged result is rejected; stored profile unchanged",
    typeof puBad.error === "string" && db.getProfile(pc.id)?.role === "worker");

  const pa = await call("profile_assign", { agentId: "agentWork", profileId: "profQA" });
  check("profile_assign: assigns an existing profile", pa.profileId === "profQA" && !pa.error);
  check("profile_assign: persists to the agent row", db.getAgent("agentWork")?.profileId === "profQA");
  check("profile_assign: 404 on an unknown agent", (await call("profile_assign", { agentId: "ghost", profileId: "profQA" })).error === "agent not found");
  check("profile_assign: 404 on an unknown profile (never mints one)", (await call("profile_assign", { agentId: "agentWork", profileId: "ghost" })).error === "profile not found");

  // ===================== profile_delete / agent_delete (task 2c9b2960) =====================
  // Unused profile → deletes cleanly (reuses db.deleteProfile, same as the human REST path).
  db.insertProfile({ id: "profUnused", name: "Unused", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
  const pd = await call("profile_delete", { profileId: "profUnused" });
  check("profile_delete: an unused profile deletes cleanly", pd.deleted === true && pd.profileId === "profUnused" && !db.getProfile("profUnused"));
  check("profile_delete: 404 on an unknown id", (await call("profile_delete", { profileId: "ghost" })).error === "profile not found");
  // Mirrors the human DELETE /api/profiles/:id EXACTLY: NO in-use guard — an agent still assigned the
  // profile (agentWork → profQA, assigned above) does NOT block deletion; the profileId just dangles
  // and resolves to the plain backstop (resolveProfile), per db.deleteProfile's doc comment.
  const pdInUse = await call("profile_delete", { profileId: "profQA" });
  check("profile_delete: an IN-USE profile still deletes (matches the human path's cascade-to-null, no refuse)",
    pdInUse.deleted === true && !db.getProfile("profQA"));
  check("profile_delete: the assigned agent's profileId is left dangling (safe backstop), not force-cleared",
    db.getAgent("agentWork")?.profileId === "profQA");

  // agent_delete: an agent with no live sessions deletes cleanly (cascades sessions/schedules/runs).
  db.insertAgent({ id: "agentDel", projectId: "pOrd", name: "ToDelete", startupPrompt: "", position: 2, profileId: null });
  const ad = await call("agent_delete", { agentId: "agentDel" });
  check("agent_delete: an agent with no live sessions deletes cleanly", ad.deleted === true && ad.agentId === "agentDel" && !db.getAgent("agentDel"));
  check("agent_delete: 404 on an unknown id", (await call("agent_delete", { agentId: "ghost" })).error === "agent not found");
  // Live-session guard: mirrors the human DELETE /api/agents/:id — refuses while a session is LIVE.
  db.insertAgent({ id: "agentLive", projectId: "pOrd", name: "LiveAgent", startupPrompt: "", position: 3, profileId: null });
  const liveSessId = "sessLive-agentLive";
  db.insertSession({
    id: liveSessId, projectId: "pOrd", agentId: "agentLive", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: null, parentSessionId: null,
  });
  const adLive = await call("agent_delete", { agentId: "agentLive" });
  check("agent_delete: an agent with a LIVE session is REFUSED (stop the fleet first)",
    typeof adLive.error === "string" && /live sessions/.test(adLive.error) && !adLive.deleted);
  check("agent_delete: the refused agent + its live session both survive", !!db.getAgent("agentLive") && !!db.getSession(liveSessId));

  // ===================== (c) session_spawn — the load-bearing invariant =====================
  const nSessBefore = db.listAllSessions().length;
  const spawnPlat = await call("session_spawn", { projectId: "pOrd", agentId: "agentMgr", role: "platform" });
  check("(c) session_spawn REJECTS role:\"platform\" (no self-elevation)", typeof spawnPlat.error === "string" && /platform/i.test(spawnPlat.error) && !spawnPlat.id);
  const spawnWorker = await call("session_spawn", { projectId: "pOrd", agentId: "agentMgr", role: "worker" });
  check("(c) session_spawn REJECTS role:\"worker\" (manager-owned)", typeof spawnWorker.error === "string" && !spawnWorker.id);
  const spawnBogus = await call("session_spawn", { projectId: "pOrd", agentId: "agentMgr", role: "admin" });
  check("(c) session_spawn REJECTS any other role", typeof spawnBogus.error === "string" && !spawnBogus.id);
  check("(c) the three rejected spawns created NO session", db.listAllSessions().length === nSessBefore);

  // SUCCEEDS for manager|plain.
  const spawnMgr = await call("session_spawn", { projectId: "pOrd", agentId: "agentMgr", role: "manager" });
  check("(c) session_spawn SUCCEEDS for role:\"manager\" (returns a live manager session)", !!spawnMgr.id && spawnMgr.role === "manager" && !spawnMgr.error);
  check("(c) the manager session persists with role=manager in the target project", db.getSession(spawnMgr.id)?.role === "manager" && db.getSession(spawnMgr.id)?.projectId === "pOrd");
  check("(c) the manager spawn drove the (fake) pty with role=manager", host.spawned.some((o) => o.sessionId === spawnMgr.id && o.role === "manager"));
  const spawnPlain = await call("session_spawn", { projectId: "pOrd", agentId: "agentWork", role: "plain" });
  check("(c) session_spawn SUCCEEDS for role:\"plain\" (vanilla, role null)", !!spawnPlain.id && (spawnPlain.role === null || spawnPlain.role === undefined) && !spawnPlain.error);
  check("(c) the plain spawn drove the (fake) pty with no role", host.spawned.some((o) => o.sessionId === spawnPlain.id && !o.role));
  // guardrails: unknown project / agent / agent-not-in-project.
  check("session_spawn: unknown project rejected", (await call("session_spawn", { projectId: "ghost", agentId: "agentMgr", role: "manager" })).error === "project not found");
  check("session_spawn: unknown agent rejected", (await call("session_spawn", { projectId: "pOrd", agentId: "ghost", role: "manager" })).error === "agent not found");
  check("session_spawn: agent-not-in-the-given-project rejected", /does not belong/.test((await call("session_spawn", { projectId: "pArch", agentId: "agentMgr", role: "manager" })).error));

  // ===================== (a) session_stop — cross-project, not parent-scoped =====================
  const stopRes = await call("session_stop", { sessionId: spawnMgr.id, mode: "hard" });
  check("session_stop: stops a session by id (routes to pty.stop hard)", stopRes.stopped === true && host.stopped.some((s) => s.id === spawnMgr.id && s.mode === "hard"));
  const stopGraceful = await call("session_stop", { sessionId: spawnPlain.id });
  check("session_stop: defaults to graceful when mode omitted", stopGraceful.stopped === true && host.stopped.some((s) => s.id === spawnPlain.id && s.mode === "graceful"));
  check("session_stop: 404 on an unknown session", (await call("session_stop", { sessionId: "ghost" })).error === "session not found");

  // ===================== (a) PROJECT update + (d) archive (reserved refused) =====================
  const projUpd = await call("project_update", { projectId: "pOrd", name: "Ordinary-2", vaultPath: "C:/tmp/ord2" });
  check("project_update: updates name + vaultPath", projUpd.name === "Ordinary-2" && projUpd.vaultPath === "C:/tmp/ord2" && !projUpd.error);
  check("project_update: persists to the Db", db.getProject("pOrd")?.name === "Ordinary-2");
  check("project_update: 404 on an unknown project", (await call("project_update", { projectId: "ghost", name: "x" })).error === "project not found");

  const arch = await call("project_archive", { projectId: "pArch" });
  check("project_archive: archives an ordinary project", arch.archived === true && !arch.error);
  check("project_archive: the archived project leaves the live list", !db.listAllProjects().some((p) => p.id === "pArch"));
  const archReserved = await call("project_archive", { projectId: "pHome" });
  check("(d) project_archive REFUSES the reserved/system home", typeof archReserved.error === "string" && /reserved/i.test(archReserved.error));
  check("(d) the reserved home is STILL live (not archived)", db.listAllProjects().some((p) => p.id === "pHome"));
  check("project_archive: 404 on an unknown project", (await call("project_archive", { projectId: "ghost" })).error === "project not found");

  // ===================== (a) SCHEDULES (cross-project; explicit agentId) =====================
  const sc = await call("schedule_create", { agentId: "agentMgr", cron: "0 9 * * *" });
  check("schedule_create: returns a schedule with an id + computed nextFireAt", !!sc.id && !!sc.nextFireAt && !sc.error);
  check("schedule_create: persists to the Db", !!db.getSchedule(sc.id));
  check("schedule_create: invalid cron rejected", (await call("schedule_create", { agentId: "agentMgr", cron: "not a cron" })).error === "invalid cron expression");
  check("schedule_create: unknown agent rejected", (await call("schedule_create", { agentId: "ghost", cron: "0 9 * * *" })).error === "agent not found");
  const su = await call("schedule_update", { scheduleId: sc.id, enabled: false, cron: "30 8 * * *" });
  check("schedule_update: applies enabled=false + new cron", su.enabled === false && su.cron === "30 8 * * *" && !su.error);
  check("schedule_update: invalid cron rejected", (await call("schedule_update", { scheduleId: sc.id, cron: "bogus" })).error === "invalid cron expression");
  check("schedule_update: 404 on an unknown schedule", (await call("schedule_update", { scheduleId: "ghost", enabled: true })).error === "schedule not found");

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the platform P2 management surface works for a platform session (reads / profiles / session_spawn|stop / project update+archive / schedules), the role gate holds (manager/worker/plain → no surface), session_spawn NEVER mints a platform or worker session (only manager|plain) and creates nothing on rejection, and project_archive refuses the reserved home — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
