import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card acd3c688 — stop an explicit-role spawn from carrying profile grants onto another role. Three
// agent-reachable vectors split a session's role (explicitRole ?? profileRole) from the AGENT_FORBIDDEN_
// PROFILE_KEYS-class grants, which always come from the bound profile regardless of which role wins:
//   (i)   session_spawn → spawnSessionAsPlatform → startManager (any agent, no profile-role/grant check).
//   (ii)  worker_spawn → spawnWorker (blocked only manager/platform/auditor/run profile roles — an
//         assistant/setup/operator/workspace-auditor-role profile was unchecked).
//   (iii) schedule_create (manager + platform surfaces) → the Scheduler fires startManager/startAuditor/
//         startWorkspaceAuditor directly with the schedule's agentId, no check at all.
// ROUND 2 (CR 7aeb24c9) corrections:
//   - Recycle: round 1's `recycleGrantWideningError` refused ON-ROLE recycles too (every recycle pins
//     every forbidden-key field from the OLD row regardless of the current profile, so a value
//     comparison with no role-divergence condition was simply wrong). REMOVED. Replaced with tests of
//     the real property, covered below: after a human adds a grant, recycle SUCCEEDS and carries exactly
//     the OLD row's grants (manager/platform-lead/worker) — the FULL forbidden-key set (connections,
//     capabilities, vaultWrite, browserTesting, documentConversion; harness per its own rule), round 3.
//   - A null-role profile spawned as "worker" is NOT a divergence (LEAD ruling) — tested both directions.
//   - `schedule_update`'s `kind` change resets a human-created row's `createdBy` to "agent" (fail-closed)
//     — tested in platform-mgmt-surface.mjs, NOT below (round 3 NIT: this header previously said
//     "covered below", which was wrong).
// ROUND 4 (card 08b97966, non-blocking follow-ups): `updateScheduleAsManager`'s own disabled→enabled
//     re-enable reset (LEAD RULING, item 3) IS covered below — the manager-surface half of the SAME
//     ruling that governs the Platform's `schedule_update`, which is tested in platform-mgmt-surface.mjs
//     (same manager/platform split as the `kind` reset just above). See the decision record's "Round 4"
//     section for the full ruling + the reset/rebind atomicity fix (tested in agent-profile-rebind-reach.mjs).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty seam, mirroring recycle-harness-reresolve.mjs's proven harness) + a real temp git repo
// for the worker-spawn vector (worker_spawn cuts a real worktree).
//
// RED/GREEN: this file is GREEN against the fixed sessions/service.ts + profiles/validate.ts +
// mcp/platform.ts. To see each vector RED against the pre-fix code, the worker-doctrine revert recipe was
// run manually (git diff -- the touched files > a scratch patch, git checkout HEAD -- them, rebuild,
// re-run this file, git apply the patch, rebuild again) — see the worker_report for that run's output;
// not re-run automatically here (it would require rebuilding mid-test, which this suite's sibling
// migration/guard tests also avoid).
//
// Run: 1) build (turbo builds shared first), 2) node test/explicit-role-grant-carryover.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const tmpHome = path.join(os.tmpdir(), `loom-ergc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { Scheduler, scheduleCreatedByIsHuman } = await import("../dist/orchestration/scheduler.js");

const repo = path.join(os.tmpdir(), `loom-ergc-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# explicit-role-grant-carryover test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=ergc@loom -c user.name=ergc");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pG", name: "G", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 50 }, permission: { startupModeCycles: 0 } }, createdAt: now, archivedAt: null });

const fakePty = () => {
  let exitCb = null;
  return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit(cb) { exitCb = cb; return { dispose() {} }; }, kill() { const cb = exitCb; exitCb = null; cb?.({ exitCode: 0 }); }, resize() {} };
};
class SeamHost extends PtyHost {
  reapExitedDescendants(_rootPid) {}
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push({ ...opts }); return fakePty(); }
  stop() {}
  isAlive() { return false; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const worktrees = [];

// ============================== (i) session_spawn / spawnSessionAsPlatform ==============================
{
  // A worker-profiled agent carrying a human-set connections grant — the card's own example of the
  // split: role "worker" matches nothing a manager spawn checks, yet the grant rides along regardless.
  db.insertProfile({ id: "profWorkerConn", name: "Connections Worker", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, connections: ["connX"] });
  db.insertAgent({ id: "aWorkerConn", projectId: "pG", name: "aWorkerConn", startupPrompt: "x", position: 0, profileId: "profWorkerConn" });

  const err = await throws(() => svc.spawnSessionAsPlatform("pG", "aWorkerConn", "manager"));
  check("(i-1) session_spawn → spawnSessionAsPlatform(role:manager) on a worker-profiled connections-grant agent THROWS", err instanceof Error);
  check("(i-1) the error names the carried grant", /connections/.test(err?.message ?? ""));
  check("(i-1) NO session row was created for this agent", db.listAllSessions().filter((s) => s.agentId === "aWorkerConn").length === 0);

  // A worker-profiled agent with NO grant — the card's own named legitimate flow (setup spawning a
  // project's first manager from a worker-profiled agent) must be unaffected.
  db.insertProfile({ id: "profWorkerPlain", name: "Plain Worker", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "aWorkerPlain", projectId: "pG", name: "aWorkerPlain", startupPrompt: "x", position: 0, profileId: "profWorkerPlain" });
  const plainMgr = svc.spawnSessionAsPlatform("pG", "aWorkerPlain", "manager");
  check("(i-2) a GRANT-FREE off-role profile spawning as manager is UNAFFECTED (the named legitimate flow)", plainMgr.role === "manager" && plainMgr.processState === "live");

  // The `harness` carve-out (card 7955458e's own silently-redirect-to-claude mechanism, not a refusal):
  // a worker-profiled agent with ONLY a mismatched codex harness (no other grant) spawning as manager
  // is NOT refused — TRANSCRIPT_ROOT_DENY_ROLES already forces it to claude before this check would fire.
  db.insertProfile({ id: "profWorkerCodexOnly", name: "Codex-only Worker", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });
  db.insertAgent({ id: "aWorkerCodexOnly", projectId: "pG", name: "aWorkerCodexOnly", startupPrompt: "x", position: 0, profileId: "profWorkerCodexOnly" });
  const codexOnlyMgr = svc.spawnSessionAsPlatform("pG", "aWorkerCodexOnly", "manager");
  check("(i-2b) a harness-ONLY mismatch (no other grant) spawning as manager is NOT refused (the role-force carve-out)", codexOnlyMgr.role === "manager" && codexOnlyMgr.harness === undefined);

  // But the SAME carve-out must NOT swallow worker_spawn's role ("worker") — it is deliberately NOT a
  // TRANSCRIPT_ROOT_DENY_ROLES member, so nothing else stops a mismatched codex harness from landing.
  db.insertProfile({ id: "profAssistantCodexOnly", name: "Codex-only Assistant", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });
  db.insertAgent({ id: "aAssistantCodexOnly", projectId: "pG", name: "aAssistantCodexOnly", startupPrompt: "x", position: 0, profileId: "profAssistantCodexOnly" });
  const mgrForCarveout = svc.startManager("aWorkerPlain", undefined, { spawnHumanAuthorized: true });
  db.insertTask({ id: "task-ergc-carveout", projectId: "pG", title: "TC", body: "", columnKey: "todo", position: 9, createdAt: now, updatedAt: now });
  const errCarveout = await throws(() => svc.spawnWorker(mgrForCarveout.id, { taskId: "task-ergc-carveout", agentId: "aAssistantCodexOnly", kickoffPrompt: "KICK" }));
  check("(i-2c) the carve-out does NOT extend to worker_spawn (role 'worker' is not a deny-role member) — still REFUSED", errCarveout instanceof Error && /harness/.test(errCarveout.message));

  // The human-REST path (spawnHumanAuthorized:true) is unaffected even for a grant-carrying off-role agent.
  const humanMgr = svc.startManager("aWorkerConn", undefined, { spawnHumanAuthorized: true });
  check("(i-3) the human-REST path (spawnHumanAuthorized:true) is NOT refused for the same grant-carrying off-role agent", humanMgr.role === "manager" && humanMgr.connections?.includes("connX"));
}

// ============================== (ii) worker_spawn ==============================
{
  // The 4 roles the PRE-EXISTING profileRole check (spawnWorker's own, unchanged by this card) does NOT
  // block: assistant/setup/operator/workspace-auditor. Pick "assistant" — a companion profile a human
  // gave a capabilities grant, spawned as a worker (the card's own example of vector ii).
  db.insertProfile({ id: "profAssistantCap", name: "Companion Rig", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null, capabilities: [{ slug: "some-capability" }] });
  db.insertAgent({ id: "aAssistantCap", projectId: "pG", name: "aAssistantCap", startupPrompt: "x", position: 0, profileId: "profAssistantCap" });

  const mgr = svc.startManager("aWorkerPlain", undefined, { spawnHumanAuthorized: true });
  const taskId = "task-ergc-1";
  db.insertTask({ id: taskId, projectId: "pG", title: "T1", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
  const sessionsBefore = db.listAllSessions().length;
  const err = await throws(() => svc.spawnWorker(mgr.id, { taskId, agentId: "aAssistantCap", kickoffPrompt: "KICK" }));
  check("(ii-1) worker_spawn on an assistant-profiled capabilities-grant agent THROWS (previously unchecked)", err instanceof Error);
  check("(ii-1) the error names the carried grant", /capabilities/.test(err?.message ?? ""));
  check("(ii-1) NO new session row was created (validated before any side effect)", db.listAllSessions().length === sessionsBefore);
  check("(ii-1) the task was NOT moved off todo", db.getTask(taskId)?.columnKey === "todo");

  // CONTROL: the pre-existing profileRole check still blocks the 4 roles it always blocked (manager here).
  db.insertProfile({ id: "profMgrRole", name: "Manager Rig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "aMgrRole", projectId: "pG", name: "aMgrRole", startupPrompt: "x", position: 0, profileId: "profMgrRole" });
  const err2 = await throws(() => svc.spawnWorker(mgr.id, { taskId: "task-ergc-2", agentId: "aMgrRole", kickoffPrompt: "KICK" }));
  check("(ii-2) CONTROL: the pre-existing manager-profile block is untouched", err2 instanceof Error && /manager-role profile/.test(err2.message));

  // A grant-free off-role (worker) agent spawns a worker normally — unaffected.
  db.insertTask({ id: "task-ergc-3", projectId: "pG", title: "T3", body: "", columnKey: "todo", position: 2, createdAt: now, updatedAt: now });
  const w = await svc.spawnWorker(mgr.id, { taskId: "task-ergc-3", agentId: "aWorkerPlain", kickoffPrompt: "KICK" });
  worktrees.push(w.worktreePath);
  check("(ii-3) an ordinary worker-profiled, grant-free worker spawn is UNAFFECTED", w.role === "worker" && w.processState === "live");

  // LEAD RULING (round 2): a null-role profile spawned as "worker" is NOT a divergence at all — a
  // role-less profile exists to BE a worker profile (e.g. "Planning & Triage" + an allow delta).
  db.insertProfile({ id: "profNullRoleGrant", name: "Null-role grant rig", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null, connections: ["null-conn"] });
  db.insertAgent({ id: "aNullRoleGrant", projectId: "pG", name: "aNullRoleGrant", startupPrompt: "x", position: 0, profileId: "profNullRoleGrant" });
  db.insertTask({ id: "task-ergc-nullrole", projectId: "pG", title: "TN", body: "", columnKey: "todo", position: 4, createdAt: now, updatedAt: now });
  const wNull = await svc.spawnWorker(mgr.id, { taskId: "task-ergc-nullrole", agentId: "aNullRoleGrant", kickoffPrompt: "KICK" });
  worktrees.push(wNull.worktreePath);
  check("(ii-4) null→worker is NOT a divergence — a grant-carrying null-role profile spawns as worker fine", wNull.role === "worker" && wNull.processState === "live");

  // But the SAME exemption must NOT extend to any OTHER null-role target — only null→worker is exempt.
  const errNullMgr = await throws(() => svc.spawnSessionAsPlatform("pG", "aNullRoleGrant", "manager"));
  check("(ii-5) null→manager is STILL checked (the exemption is scoped to worker only) — REFUSED", errNullMgr instanceof Error && /connections/.test(errNullMgr.message));
}

// ============================== (iii) schedule_create → Scheduler fire ==============================
{
  // scheduleCreatedByIsHuman: fail-closed semantics unit-checked directly (mirrors schedule-created-by-migration.mjs).
  check("(iii-0) createdBy:'human' ⇒ human-authorized", scheduleCreatedByIsHuman({ createdBy: "human" }) === true);
  check("(iii-0) createdBy:'agent' ⇒ NOT human-authorized", scheduleCreatedByIsHuman({ createdBy: "agent" }) === false);
  check("(iii-0) createdBy:null (legacy) ⇒ NOT human-authorized (fail-closed)", scheduleCreatedByIsHuman({ createdBy: null }) === false);

  // An end-to-end Scheduler.tick wired to the REAL startManager, firing an agent-created schedule
  // (createdBy:"agent") targeting the SAME grant-carrying off-role agent as (i) — must refuse, and the
  // Scheduler's own per-schedule try/catch must swallow it (never crash the tick).
  const scheduler = new Scheduler({
    db, control: new OrchestrationControl(),
    startManager: (agentId, prompt, opts) => svc.startManager(agentId, prompt, { ...opts }),
  });
  const schedId = "sched-ergc-1";
  db.insertSchedule({ id: schedId, agentId: "aWorkerConn", cron: "*/5 * * * *", enabled: true, nextFireAt: new Date(Date.now() - 60_000).toISOString(), lastFiredAt: null, createdAt: now, kind: "manager", prompt: null, createdBy: "agent" });
  const sessionsBeforeFire = db.listAllSessions().length;
  await scheduler.tick(new Date());
  check("(iii-1) an agent-created schedule targeting a grant-carrying off-role agent fires NO session (refused, swallowed by the tick's own try/catch)", db.listAllSessions().length === sessionsBeforeFire);
  const failEvt = db.listEvents("").find((e) => e.kind === "schedule_fire_failed" && e.detail?.scheduleId === schedId);
  check("(iii-1) a schedule_fire_failed event records the refusal", !!failEvt && /connections/.test(failEvt.detail?.error ?? ""));
  check("(iii-1) the schedule stays enabled (a refusal is not a permanent disable)", db.getSchedule(schedId)?.enabled === true);

  // The SAME schedule, but createdBy:"human" (the human-REST builder) — the Scheduler forwards
  // spawnHumanAuthorized:true and the fire succeeds.
  const schedId2 = "sched-ergc-2";
  const liveMgrsBefore = db.listAllSessions().filter((s) => s.agentId === "aWorkerConn" && s.role === "manager" && s.processState === "live").length;
  db.insertSchedule({ id: schedId2, agentId: "aWorkerConn", cron: "*/5 * * * *", enabled: true, nextFireAt: new Date(Date.now() - 60_000).toISOString(), lastFiredAt: null, createdAt: now, kind: "manager", prompt: null, createdBy: "human" });
  await scheduler.tick(new Date());
  const liveMgrsAfter = db.listAllSessions().filter((s) => s.agentId === "aWorkerConn" && s.role === "manager" && s.processState === "live").length;
  const newFailEvt = db.listEvents("").find((e) => e.kind === "schedule_fire_failed" && e.detail?.scheduleId === schedId2);
  check("(iii-2) a HUMAN-created schedule targeting the SAME grant-carrying off-role agent fires successfully (one new live manager session, no fresh failure event)",
    liveMgrsAfter === liveMgrsBefore + 1 && !newFailEvt);
}

// ============== updateScheduleAsManager: agent re-enable resets createdBy (card 08b97966 item 3, LEAD
// RULING) — an AGENT-originated disabled→enabled transition on a createdBy:"human" schedule resets
// createdBy to "agent" (fail-closed); a prompt/cron-only edit, an already-enabled no-op, or the reverse
// (enabled→disabled) direction all leave createdBy untouched. The PLATFORM surface's twin (schedule_update)
// is tested in platform-mgmt-surface.mjs, mirroring the existing kind-reset split — NOT duplicated here. ==
{
  const mgrS = svc.startManager("aWorkerPlain", undefined, { spawnHumanAuthorized: true });

  const schedEnableHuman = "sched-ergc-enable-human";
  db.insertSchedule({ id: schedEnableHuman, agentId: "aWorkerPlain", cron: "0 9 * * *", enabled: false, nextFireAt: new Date(Date.now() + 86400000).toISOString(), lastFiredAt: null, createdAt: now, kind: "manager", prompt: null, createdBy: "human" });
  svc.updateScheduleAsManager(mgrS.id, schedEnableHuman, { enabled: true });
  check("(sched-enable-1) an AGENT-originated disabled→enabled transition on a human-created schedule RESETS createdBy to agent (fail-closed)",
    db.getSchedule(schedEnableHuman)?.createdBy === "agent");

  // CONTROL: a prompt-only edit on a DISABLED human-created row (no enabled flip) leaves createdBy alone.
  const schedPromptHuman = "sched-ergc-prompt-human";
  db.insertSchedule({ id: schedPromptHuman, agentId: "aWorkerPlain", cron: "0 9 * * *", enabled: false, nextFireAt: new Date(Date.now() + 86400000).toISOString(), lastFiredAt: null, createdAt: now, kind: "manager", prompt: null, createdBy: "human" });
  svc.updateScheduleAsManager(mgrS.id, schedPromptHuman, { prompt: "new prompt text" });
  check("(sched-enable-2) CONTROL: a prompt-only edit (no enabled flip) leaves a human-created schedule's createdBy UNTOUCHED",
    db.getSchedule(schedPromptHuman)?.createdBy === "human");

  // CONTROL: enabled:true on an ALREADY-enabled human row — no disabled→enabled transition — is a no-op.
  const schedAlreadyEnabled = "sched-ergc-already-enabled";
  db.insertSchedule({ id: schedAlreadyEnabled, agentId: "aWorkerPlain", cron: "0 9 * * *", enabled: true, nextFireAt: new Date(Date.now() + 86400000).toISOString(), lastFiredAt: null, createdAt: now, kind: "manager", prompt: null, createdBy: "human" });
  svc.updateScheduleAsManager(mgrS.id, schedAlreadyEnabled, { enabled: true });
  check("(sched-enable-3) CONTROL: enabled:true on an ALREADY-enabled human row (no real transition) leaves createdBy UNTOUCHED",
    db.getSchedule(schedAlreadyEnabled)?.createdBy === "human");

  // CONTROL: disabled→enabled on an already agent-created row is a no-op for createdBy (stays agent).
  const schedEnableAgent = "sched-ergc-enable-agent";
  db.insertSchedule({ id: schedEnableAgent, agentId: "aWorkerPlain", cron: "0 9 * * *", enabled: false, nextFireAt: new Date(Date.now() + 86400000).toISOString(), lastFiredAt: null, createdAt: now, kind: "manager", prompt: null, createdBy: "agent" });
  svc.updateScheduleAsManager(mgrS.id, schedEnableAgent, { enabled: true });
  check("(sched-enable-4) CONTROL: disabled→enabled on an already agent-created row stays createdBy:agent",
    db.getSchedule(schedEnableAgent)?.createdBy === "agent");

  // CONTROL: the reverse direction (enabled→disabled) never resets provenance either.
  const schedDisableHuman = "sched-ergc-disable-human";
  db.insertSchedule({ id: schedDisableHuman, agentId: "aWorkerPlain", cron: "0 9 * * *", enabled: true, nextFireAt: new Date(Date.now() + 86400000).toISOString(), lastFiredAt: null, createdAt: now, kind: "manager", prompt: null, createdBy: "human" });
  svc.updateScheduleAsManager(mgrS.id, schedDisableHuman, { enabled: false });
  check("(sched-enable-5) CONTROL: enabled→disabled (the reverse direction) leaves a human-created row's createdBy UNTOUCHED",
    db.getSchedule(schedDisableHuman)?.createdBy === "human");
}

// ============================== recycle: NO grant check — pins the real property instead (round 2) ======
// CR 7aeb24c9 found round 1's recycleGrantWideningError refused ON-ROLE recycles too (every recycle pins
// every forbidden-key field from the OLD row regardless of the current profile, so a value comparison
// with no role-divergence condition was simply wrong — reproduced below with an ON-ROLE manager profile).
// Removed. These tests instead pin the REAL property recycle relies on: a grant added to the profile
// AFTER a session started never reaches the recycled successor (old-row-carry), for manager,
// platform-lead, and worker — so a FUTURE refactor that re-resolves grants from the profile goes red here.
try {
  // ---- (recycle-A) ON-ROLE manager profile: the exact CR-reproduced scenario ----
  db.insertProfile({ id: "profMgrOnRole", name: "On-role Manager Rig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "aMgrOnRole", projectId: "pG", name: "aMgrOnRole", startupPrompt: "x", position: 0, profileId: "profMgrOnRole" });
  const a1 = svc.startManager("aMgrOnRole"); // role MATCHES the profile's own role — no divergence, no bypass needed
  const a2 = await svc.recycleManager(a1.id, "handoff baseline");
  check("(recycle-A0) baseline: an on-role, grant-free manager recycles fine", a2.role === "manager");
  // A human now adds a grant to this SAME, still on-role, profile.
  db.updateProfile("profMgrOnRole", { connections: ["later-added"] });
  const a3 = await svc.recycleManager(a2.id, "handoff after-grant-added");
  check("(recycle-A1) an on-role recycle SUCCEEDS after a grant is added to the profile (the CR's exact repro — round 1 threw here)", a3.role === "manager");
  check("(recycle-A1) the successor does NOT carry the newly-added grant (old-row-carry, not profile re-resolution)", !(a3.connections ?? []).includes("later-added"));

  // ---- (recycle-B) OFF-role, already grant-carrying manager (human-started) + a SECOND grant added later ----
  db.insertProfile({ id: "profRecycleConn", name: "Recycle Conn Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, connections: ["c1"] });
  db.insertAgent({ id: "aRecycleConn", projectId: "pG", name: "aRecycleConn", startupPrompt: "x", position: 0, profileId: "profRecycleConn" });
  const m1 = svc.startManager("aRecycleConn", undefined, { spawnHumanAuthorized: true });
  check("(recycle-B0) setup: the human-started off-role manager carries the grant on its row", m1.connections?.includes("c1"));
  const m2 = await svc.recycleManager(m1.id, "handoff 1");
  check("(recycle-B1) recycling an UNCHANGED off-role/grant lineage succeeds, carries the original grant", m2.role === "manager" && m2.connections?.includes("c1"));
  // The SAME profile now ALSO gains every OTHER forbidden-key grant (round 3, MINOR 2: the full set, not
  // just capabilities) — round 1 refused the NEXT recycle here; round 2/3 must not.
  db.updateProfile("profRecycleConn", { capabilities: [{ slug: "newly-added" }], vaultWrite: true, browserTesting: true, documentConversion: true, harness: "codex" });
  const m3 = await svc.recycleManager(m2.id, "handoff 2");
  check("(recycle-B2) a grant ADDED to an already off-role profile no longer refuses the next recycle", m3.role === "manager");
  check("(recycle-B2) the successor still carries the ORIGINAL grant", m3.connections?.includes("c1"));
  check("(recycle-B2) the successor does NOT carry the NEWLY-added capabilities grant (old-row-carry)", (m3.capabilities ?? []).length === 0);
  check("(recycle-B2) the successor does NOT carry the NEWLY-added vaultWrite grant (old-row-carry)", !m3.vaultWrite);
  check("(recycle-B2) the successor does NOT carry the NEWLY-added browserTesting grant (old-row-carry)", !m3.browserTesting);
  check("(recycle-B2) the successor does NOT carry the NEWLY-added documentConversion grant (old-row-carry)", !m3.documentConversion);
  // harness is its OWN rule for manager/platform-lead (re-resolved fresh, never row-pinned — card 8d4b4433)
  // — but TRANSCRIPT_ROOT_DENY_ROLES forces any re-resolved "codex" back to claude unconditionally for
  // this role, so the newly-added codex harness still never actually lands, by a DIFFERENT mechanism than
  // old-row-carry (see the decision record's "Do not" on comparing old.harness here).
  check("(recycle-B2) the successor's harness is NOT \"codex\" despite the newly-added profile harness (role-force, not old-row-carry)", m3.harness !== "codex");

  // ---- (recycle-C) platform-lead: the same property, FULL forbidden-key set (round 3, MINOR 2) ----
  db.insertProfile({ id: "profLeadOnRole", name: "On-role Lead Rig", role: "platform", description: "", allowDelta: [], skills: null, model: null, icon: null, connections: ["lead-c1"] });
  db.insertAgent({ id: "aLeadOnRole", projectId: "pG", name: "aLeadOnRole", startupPrompt: "x", position: 0, profileId: "profLeadOnRole" });
  const l1 = svc.startPlatformLead("aLeadOnRole", { spawnHumanAuthorized: true });
  check("(recycle-C0) setup: the lead carries the ORIGINAL connections grant on its row", l1.connections?.includes("lead-c1"));
  db.updateProfile("profLeadOnRole", { capabilities: [{ slug: "newly-added" }], vaultWrite: true, browserTesting: true, documentConversion: true, harness: "codex" });
  const l2 = await svc.recyclePlatformLead(l1.id, "handoff");
  check("(recycle-C) platform-lead recycle SUCCEEDS after grants are added", l2.role === "platform");
  check("(recycle-C) the successor still carries the ORIGINAL connections grant", l2.connections?.includes("lead-c1"));
  check("(recycle-C) the successor does NOT carry the NEWLY-added capabilities grant", (l2.capabilities ?? []).length === 0);
  check("(recycle-C) the successor does NOT carry the NEWLY-added vaultWrite grant", l2.vaultWrite === false);
  check("(recycle-C) the successor does NOT carry the NEWLY-added browserTesting grant", !l2.browserTesting);
  check("(recycle-C) the successor does NOT carry the NEWLY-added documentConversion grant", !l2.documentConversion);
  // harness: same role-force rule as recycle-B2 above, not old-row-carry — see that comment.
  check("(recycle-C) the successor's harness is NOT \"codex\" despite the newly-added profile harness (role-force, not old-row-carry)", l2.harness !== "codex");

  // ---- (recycle-D) worker: the same property ----
  db.insertProfile({ id: "profWorkerRecycleConn", name: "Worker Recycle Conn", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null, connections: ["wc1"] });
  db.insertAgent({ id: "aWorkerRecycleConn", projectId: "pG", name: "aWorkerRecycleConn", startupPrompt: "x", position: 0, profileId: "profWorkerRecycleConn" });
  const mgrForW = svc.startManager("aWorkerPlain", undefined, { spawnHumanAuthorized: true });
  const wTaskId = "task-ergc-recycle-w";
  db.insertTask({ id: wTaskId, projectId: "pG", title: "TW", body: "", columnKey: "todo", position: 3, createdAt: now, updatedAt: now });
  // spawnWorker itself would REFUSE this agent (assistant + connections, vector ii) — directly seed the
  // worker row instead, mirroring an already-authorized worker that predates this card's spawnWorker fix.
  const seedW = { id: "w-ergc-1", projectId: "pG", agentId: "aWorkerRecycleConn", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", connections: ["wc1"], parentSessionId: mgrForW.id, taskId: wTaskId, worktreePath: repo, branch: null, gen: 0 };
  db.insertSession(seedW);
  const w2 = await svc.recycleWorker(mgrForW.id, seedW.id, "handoff w1");
  worktrees.push(w2.worktreePath);
  check("(recycle-D1) a pre-existing carried connections grant does NOT block a worker recycle", w2.connections?.includes("wc1"));
  // The profile now gains the FULL forbidden-key set (round 3, MINOR 2), harness included — a worker's
  // harness is ROW-PINNED (never re-resolved, unlike manager/platform-lead above), so it is old-row-carry
  // just like the other five fields, not the role-force mechanism recycle-B2/C rely on.
  db.updateProfile("profWorkerRecycleConn", { capabilities: [{ slug: "newly-added" }], vaultWrite: true, browserTesting: true, documentConversion: true, harness: "codex" });
  const w3 = await svc.recycleWorker(mgrForW.id, w2.id, "handoff w2");
  worktrees.push(w3.worktreePath);
  check("(recycle-D2) a grant ADDED to the profile no longer refuses the worker's next recycle", w3.role === "worker" && w3.connections?.includes("wc1"));
  check("(recycle-D2) the successor does NOT carry the newly-added capabilities grant (old-row-carry)", (w3.capabilities ?? []).length === 0);
  check("(recycle-D2) the successor does NOT carry the newly-added vaultWrite grant (old-row-carry)", !w3.vaultWrite);
  check("(recycle-D2) the successor does NOT carry the newly-added browserTesting grant (old-row-carry)", !w3.browserTesting);
  check("(recycle-D2) the successor does NOT carry the newly-added documentConversion grant (old-row-carry)", !w3.documentConversion);
  check("(recycle-D2) the successor's harness stays ROW-PINNED to the OLD row's value, not the newly-added codex (old-row-carry, not role-force)", w3.harness !== "codex");
} finally {
  try { const { removeWorktree } = await import("../dist/git/worktrees.js"); for (const wt of worktrees) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } } catch { /* best-effort */ }
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — all three vectors (session_spawn, worker_spawn, schedule_create→Scheduler) refuse an explicit-role spawn that would carry a profile's forbidden-key grant onto an off-role session, the human-REST/legitimate-flow/null-role-worker/harness-carve-out paths are unaffected, and recycle (manager, platform-lead, worker) ALWAYS succeeds regardless of a later grant edit — carrying exactly the old row's grants, never a newly-added one (round 2: no check, a pinned property instead)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
