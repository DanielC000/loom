import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform Manager P1 — reserved "Loom Platform" home + seeded Lead/Auditor agents + the spawn invariant.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE, modeled on profiles.mjs / browser-testing-spawn.mjs: isolated
// LOOM_HOME + sandboxed HOME, a REAL Db + SessionService driven against a FAKE pty (PtyHost.createPty
// seam), a real temp git repo backing spawnWorker's createWorktree. Proves:
//   (a) seedPlatformHome is idempotent — a second seed/boot adds nothing (no duplicate project/agents);
//   (b) the reserved project is EXCLUDED from db.listProjects() (the picker) and INCLUDED in
//       db.listAllProjects() (the inclusive admin feed); an ordinary project shows in BOTH;
//   (c) the two agents (Platform Lead / Platform Auditor) are seeded with NON-empty default prompts and
//       bound to the bundled Platform-lead / Platform-audit profiles (role platform), and the two
//       doctrine skills (platform-lead / platform-audit) seed into the Loom skill store;
//   (d) THE INVARIANT — no agent/MCP path can spawn a platform-role session: spawnWorker (what
//       worker_spawn calls) hardcodes role=worker and REJECTS a platform-profile agent; the ONLY platform
//       spawn is startPlatformLead (the human REST path), which takes NO role param from any agent.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-home.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (resume()/transcript reads stay under temp). Set BEFORE
// importing dist so paths.js (LOOM_HOME/SKILLS_DIR) and the Db resolve to the throwaway env. ---
const tmpHome = path.join(os.tmpdir(), `loom-ph-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { seedPlatformHome, PLATFORM_PROJECT_NAME } = await import("../dist/platform/seed.js");
const { seedGlobalSkills } = await import("../dist/skills/seed.js");
const { SKILLS_DIR } = await import("../dist/paths.js");

const db = new Db();

// ===================== (a) seed + idempotency =====================
// Profiles first (the platform agents bind to them by name), then the platform home — the boot order.
seedDefaultProfiles(db);
const seeded1 = seedPlatformHome(db);
check("(a) first seed reports the project + both agents",
  seeded1.includes(`project:${PLATFORM_PROJECT_NAME}`) &&
  seeded1.includes("agent:Platform Lead") && seeded1.includes("agent:Platform Auditor"));

const reservedAfter1 = db.listAllProjects().filter((p) => p.reserved);
check("(a) exactly ONE reserved project after the first seed", reservedAfter1.length === 1);
const platformProject = reservedAfter1[0];
const agentsAfter1 = db.listAgents(platformProject.id);
check("(a) exactly TWO agents seeded into the reserved project", agentsAfter1.length === 2);

// Second seed AND a fresh re-open (a second boot) must both no-op — never clobber, never duplicate.
const seeded2 = seedPlatformHome(db);
check("(a) second seed in the same process is a no-op (returns [])", seeded2.length === 0);
db.close();
const db2 = new Db();
const seeded3 = seedPlatformHome(db2); // simulate the NEXT boot opening the persisted DB
check("(a) re-seed on a fresh DB handle (second boot) is a no-op", seeded3.length === 0);
check("(a) still exactly ONE reserved project after re-seed", db2.listAllProjects().filter((p) => p.reserved).length === 1);
check("(a) still exactly TWO platform agents after re-seed", db2.listAgents(platformProject.id).length === 2);
db2.close();

const db3 = new Db();

// ===================== (b) picker exclusion vs inclusive admin feed =====================
// Add an ORDINARY project so we prove the picker still returns normal projects while hiding the reserved one.
const now = new Date().toISOString();
db3.insertProject({ id: "pOrd", name: "Ordinary Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });

const picker = db3.listProjects();
const all = db3.listAllProjects();
check("(b) listProjects() (the picker) EXCLUDES the reserved project",
  !picker.some((p) => p.reserved) && !picker.some((p) => p.name === PLATFORM_PROJECT_NAME));
check("(b) listProjects() still includes the ordinary project", picker.some((p) => p.id === "pOrd"));
check("(b) listAllProjects() INCLUDES the reserved project", all.some((p) => p.name === PLATFORM_PROJECT_NAME && p.reserved));
check("(b) listAllProjects() also includes the ordinary project", all.some((p) => p.id === "pOrd"));
// getProject is unfiltered — the reserved project stays addressable by id (admin / Mission Control routes).
check("(b) getProject() resolves the reserved project by id (still addressable)",
  db3.getProject(platformProject.id)?.reserved === true);
// Mission Control reads names via the sessions JOIN (no reserved filter) — proven structurally here: the
// reserved project's row is fetchable, so a session in it enriches with its project name (listAllSessions).
check("(b) reserved project row carries its name for the Mission-Control sessions JOIN",
  db3.getProject(platformProject.id)?.name === PLATFORM_PROJECT_NAME);

// ===================== (c) agents bound to platform profiles + doctrine skills seeded =====================
const byName = new Map(db3.listAgents(platformProject.id).map((a) => [a.name, a]));
const lead = byName.get("Platform Lead");
const auditor = byName.get("Platform Auditor");
const profById = new Map(db3.listProfiles().map((p) => [p.id, p]));
check("(c) Platform Lead seeded with a NON-empty default startupPrompt",
  typeof lead?.startupPrompt === "string" && lead.startupPrompt.length > 200);
check("(c) Platform Lead bound to the Platform-lead profile (role platform)",
  profById.get(lead?.profileId)?.name === "Platform-lead" && profById.get(lead?.profileId)?.role === "platform");
check("(c) Platform Lead prompt references its /platform-lead doctrine skill", lead.startupPrompt.includes("/platform-lead"));
check("(c) Platform Auditor seeded with a NON-empty default startupPrompt",
  typeof auditor?.startupPrompt === "string" && auditor.startupPrompt.length > 200);
check("(c) Platform Auditor bound to the Platform-audit profile (role platform)",
  profById.get(auditor?.profileId)?.name === "Platform-audit" && profById.get(auditor?.profileId)?.role === "platform");
check("(c) Platform Auditor prompt references its /platform-audit skill + the read+file-only posture",
  auditor.startupPrompt.includes("/platform-audit") && /READ \+ FILE-ONLY/i.test(auditor.startupPrompt));
// Both bundled platform profiles exist as platform-role rigs.
const profsByName = new Map(db3.listProfiles().map((p) => [p.name, p]));
check("(c) both bundled platform profiles present + role=platform",
  profsByName.get("Platform-lead")?.role === "platform" && profsByName.get("Platform-audit")?.role === "platform");
// The two doctrine skills seed into the Loom skill store (the real seedGlobalSkills path over the assets).
seedGlobalSkills();
for (const skill of ["platform-lead", "platform-audit"]) {
  const md = path.join(SKILLS_DIR, skill, "SKILL.md");
  const exists = fs.existsSync(md);
  check(`(c) bundled skill '${skill}' seeded into the store`, exists);
  if (exists) check(`(c) skill '${skill}' SKILL.md has the matching name frontmatter`,
    fs.readFileSync(md, "utf8").includes(`name: ${skill}`));
}

// ===================== (d) THE INVARIANT — no agent/MCP path mints a platform session =====================
// A real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off.
const repo = path.join(os.tmpdir(), `loom-ph-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# platform-home test\n");
execSync(`git init -q && git add . && git -c user.email=ph@loom -c user.name=ph commit -q -m init`, { cwd: repo });

// An ORDINARY project + a manager + a worker agent (the orchestration side), plus reuse the seeded
// platform Lead agent (the platform side) to prove spawnWorker rejects a platform-profile agent.
db3.insertProject({ id: "pRepo", name: "Repo", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db3.insertAgent({ id: "aMgr", projectId: "pRepo", name: "Mgr", startupPrompt: "M", position: 0, profileId: null });
db3.insertAgent({ id: "aDev", projectId: "pRepo", name: "Dev", startupPrompt: "D", position: 1, profileId: null });
db3.insertSession({ id: "mgr1", projectId: "pRepo", agentId: "aMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit(id) { db3.setProcessState(id, "exited"); } };
const host = new SeamHost(events);
const svc = new SessionService(db3, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

let worktrees = [];
try {
  // The agent-facing spawn (what the worker_spawn MCP tool calls) ALWAYS yields role=worker.
  const w = await svc.spawnWorker("mgr1", { taskId: "tW1", agentId: "aDev", kickoffPrompt: "GO" });
  worktrees.push(w.worktreePath);
  check("(d) spawnWorker yields a WORKER-role session (never platform)", w.role === "worker");
  check("(d) spawnWorker spawn opts.role === 'worker' (hardcoded)", optsFor(w.id)?.role === "worker");
  check("(d) the persisted worker row is role=worker", db3.getSession(w.id).role === "worker");

  // spawnWorker takes NO role param — its only inputs are taskId/agentId/kickoffPrompt. Passing an extra
  // role is simply ignored by the service signature (proves there's no agent-supplied role channel).
  const w2 = await svc.spawnWorker("mgr1", { taskId: "tW2", agentId: "aDev", kickoffPrompt: "GO", role: "platform" });
  worktrees.push(w2.worktreePath);
  check("(d) an injected role:'platform' arg is IGNORED — still a worker", w2.role === "worker");

  // spawnWorker REJECTS a platform-profile agent (the seeded Platform Lead) — a manager can't point a
  // worker at a platform rig to smuggle a platform session into being.
  let rejected = false;
  try { await svc.spawnWorker("mgr1", { taskId: "tW3", agentId: lead.id, kickoffPrompt: "GO" }); }
  catch (e) { rejected = /platform/i.test(e.message); }
  check("(d) spawnWorker REJECTS a platform-profile agent (no self-elevation)", rejected);

  // The ONLY platform spawn is startPlatformLead — the human REST path — and it DOES produce platform.
  // (Confirms the capability exists for the human, while no agent path above can reach it.)
  const ld = svc.startPlatformLead(lead.id);
  check("(d) startPlatformLead (human REST path) yields a platform-role session", ld.role === "platform");
  check("(d) startPlatformLead spawn opts.role === 'platform'", optsFor(ld.id)?.role === "platform");
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of worktrees.filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db3.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — reserved 'Loom Platform' home seeds idempotently, is hidden from the picker but in the inclusive feed, ships the Lead/Auditor agents with real prompts + doctrine skills, and NO agent/MCP path can mint a platform-role session (only startPlatformLead via human REST)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
