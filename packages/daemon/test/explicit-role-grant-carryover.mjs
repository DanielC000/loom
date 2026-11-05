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
// Card be9cb999 round 2, item 2: this test calls startPlatformLead with an arbitrary agent id (no
// sanctioned marker/profile) — it's about explicit-role grant carryover, not f437d4e9 Decision 5/6's
// end-user-Lead restriction, which applies only on a non-dev install. Pin LOOM_DEV=1 so the test keeps
// exercising the generic grant-carryover mechanics unaffected.
process.env.LOOM_DEV = "1";

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
  sweepOrphanedDescendants(_rootPid) {}
  reapExitedDescendants(_rootPid) {} async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
  async captureRootCreationRow(_pid) { return null; }
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
  db.insertProfile({ id: "profWorkerConn", name: "Connections Worker", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
  // @decision afe1bc90 — the grant is an AGENT-row field now (a profile carries none), set on the agent.
  db.insertAgent({ id: "aWorkerConn", projectId: "pG", name: "aWorkerConn", startupPrompt: "x", position: 0, profileId: "profWorkerConn", connections: ["connX"] });

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
  db.insertProfile({ id: "profAssistantCap", name: "Companion Rig", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "aAssistantCap", projectId: "pG", name: "aAssistantCap", startupPrompt: "x", position: 0, profileId: "profAssistantCap", capabilities: [{ slug: "some-capability" }] });

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
  db.insertProfile({ id: "profNullRoleGrant", name: "Null-role grant rig", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "aNullRoleGrant", projectId: "pG", name: "aNullRoleGrant", startupPrompt: "x", position: 0, profileId: "profNullRoleGrant" });
  db.insertTask({ id: "task-ergc-nullrole", projectId: "pG", title: "TN", body: "", columnKey: "todo", position: 4, createdAt: now, updatedAt: now });
  const wNull = await svc.spawnWorker(mgr.id, { taskId: "task-ergc-nullrole", agentId: "aNullRoleGrant", kickoffPrompt: "KICK" });
  worktrees.push(wNull.worktreePath);
  check("(ii-4) null→worker is NOT a divergence — a grant-free null-role profile spawns as worker fine", wNull.role === "worker" && wNull.processState === "live");

  // @decision afe1bc90 — the null→worker exemption covered a grant on the null-role PROFILE, which no longer
  // exists; an AGENT-row grant is never exempt (ii-6). So (ii-4) now proves only the grant-free spawn, and the
  // agent is granted afterwards so (ii-5) keeps proving null→manager is checked.
  db.updateAgent("aNullRoleGrant", { connections: ["null-conn"] });
  // But the SAME exemption must NOT extend to any OTHER null-role target — only null→worker is exempt.
  const errNullMgr = await throws(() => svc.spawnSessionAsPlatform("pG", "aNullRoleGrant", "manager"));
  check("(ii-5) null→manager is STILL checked (the exemption is scoped to worker only) — REFUSED", errNullMgr instanceof Error && /connections/.test(errNullMgr.message));

  // Card caca806c item 1(c), Code Review MAJOR ruling (c): the null→worker exemption does NOT cover a
  // PROFILE-LESS agent that itself carries its OWN connections/capabilities (card caca806c's agent-level
  // grant surface) — `resolved.connections`/`capabilities` with no bound profile is EXACTLY the agent's
  // own grants (resolveProfile's backstop), so this is a real divergence the exemption must not swallow.
  db.insertAgent({ id: "aNullRoleAgentConnGrant", projectId: "pG", name: "aNullRoleAgentConnGrant", startupPrompt: "x", position: 0, profileId: null, connections: ["agent-level-conn"] });
  db.insertTask({ id: "task-ergc-nullrole-agentconn", projectId: "pG", title: "TNAC", body: "", columnKey: "todo", position: 5, createdAt: now, updatedAt: now });
  const sessionsBeforeNAC = db.listAllSessions().length;
  const errNullAgentConn = await throws(() => svc.spawnWorker(mgr.id, { taskId: "task-ergc-nullrole-agentconn", agentId: "aNullRoleAgentConnGrant", kickoffPrompt: "KICK" }));
  check("(ii-6) a PROFILE-LESS agent carrying its OWN connections grant, spawned as worker, is REFUSED (the null→worker exemption does not cover agent-level grants)",
    errNullAgentConn instanceof Error && /connections/.test(errNullAgentConn.message));
  check("(ii-6) NO new session row was created", db.listAllSessions().length === sessionsBeforeNAC);

  // Same shape, via the agent's OWN capabilities array instead of connections.
  db.insertAgent({ id: "aNullRoleAgentCapGrant", projectId: "pG", name: "aNullRoleAgentCapGrant", startupPrompt: "x", position: 0, profileId: null, capabilities: [{ slug: "agent-level-cap" }] });
  db.insertTask({ id: "task-ergc-nullrole-agentcap", projectId: "pG", title: "TNAP", body: "", columnKey: "todo", position: 6, createdAt: now, updatedAt: now });
  const errNullAgentCap = await throws(() => svc.spawnWorker(mgr.id, { taskId: "task-ergc-nullrole-agentcap", agentId: "aNullRoleAgentCapGrant", kickoffPrompt: "KICK" }));
  check("(ii-6b) ...and via capabilities instead of connections, SAME refusal", errNullAgentCap instanceof Error && /capabilities/.test(errNullAgentCap.message));

  // NEGATIVE CONTROL: a genuinely grant-free, profile-less agent still spawns as worker fine — the
  // exemption stays intact for the case it actually exists for.
  db.insertAgent({ id: "aNullRoleAgentNoGrant", projectId: "pG", name: "aNullRoleAgentNoGrant", startupPrompt: "x", position: 0, profileId: null });
  db.insertTask({ id: "task-ergc-nullrole-nograd", projectId: "pG", title: "TNG", body: "", columnKey: "todo", position: 7, createdAt: now, updatedAt: now });
  const wNoGrant = await svc.spawnWorker(mgr.id, { taskId: "task-ergc-nullrole-nograd", agentId: "aNullRoleAgentNoGrant", kickoffPrompt: "KICK" });
  worktrees.push(wNoGrant.worktreePath);
  check("(ii-6c) NEGATIVE CONTROL: a profile-less, grant-FREE agent still spawns as worker fine", wNoGrant.role === "worker" && wNoGrant.processState === "live");

  // Round 3 CRITICAL (Code Review, reproduced end to end): (ii-6)'s refusal was gated on
  // `agentHasNoProfile` (`!profile` at the call site) — so REBINDING a grant-carrying, profile-less
  // agent onto a GRANT-FREE role:null profile made `agentHasNoProfile` false (a profile is now bound)
  // and the carried-grant check never ran at all, even though the agent's own grant is unchanged.
  db.insertProfile({ id: "profNullRoleNoGrant", name: "Null-role no-grant rig", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "aRebindToNullNoGrant", projectId: "pG", name: "aRebindToNullNoGrant", startupPrompt: "x", position: 0, profileId: null, connections: ["agent-level-conn-rebind"] });
  const rebound = svc.assignAgentProfile(mgr.id, "aRebindToNullNoGrant", "profNullRoleNoGrant");
  check("(ii-7) rebind onto a grant-free role:null profile SUCCEEDS (null→null is not a role change)", rebound.profileId === "profNullRoleNoGrant");
  db.insertTask({ id: "task-ergc-rebind-nullrole", projectId: "pG", title: "TRNR", body: "", columnKey: "todo", position: 8, createdAt: now, updatedAt: now });
  const sessionsBeforeRebind = db.listAllSessions().length;
  const errRebindThenSpawn = await throws(() => svc.spawnWorker(mgr.id, { taskId: "task-ergc-rebind-nullrole", agentId: "aRebindToNullNoGrant", kickoffPrompt: "KICK" }));
  check("(ii-7) ...then worker_spawn on it is REFUSED (the agent's own grant must still be seen post-rebind)",
    errRebindThenSpawn instanceof Error && /connections/.test(errRebindThenSpawn.message));
  check("(ii-7) NO new session row was created", db.listAllSessions().length === sessionsBeforeRebind);

  // Same bypass, reached without a rebind at all: a human grants an agent that is ALREADY bound to a
  // grant-free role:null profile (e.g. via the agent-edit REST surface) — `agentHasNoProfile` is false
  // from the start here too.
  db.insertAgent({ id: "aBoundNullRoleGrant", projectId: "pG", name: "aBoundNullRoleGrant", startupPrompt: "x", position: 0, profileId: "profNullRoleNoGrant", connections: ["agent-level-conn-bound"] });
  db.insertTask({ id: "task-ergc-bound-nullrole", projectId: "pG", title: "TBNR", body: "", columnKey: "todo", position: 9, createdAt: now, updatedAt: now });
  const sessionsBeforeBound = db.listAllSessions().length;
  const errBoundThenSpawn = await throws(() => svc.spawnWorker(mgr.id, { taskId: "task-ergc-bound-nullrole", agentId: "aBoundNullRoleGrant", kickoffPrompt: "KICK" }));
  check("(ii-8) a human-granted agent already bound to a grant-free role:null profile: worker_spawn is REFUSED",
    errBoundThenSpawn instanceof Error && /connections/.test(errBoundThenSpawn.message));
  check("(ii-8) NO new session row was created", db.listAllSessions().length === sessionsBeforeBound);

  // @decision afe1bc90 (CR B1/R9) — (ii-4) at AGENT level: a grant FANNED OUT from a role:null profile keeps the
  // null→worker exemption it had before the migration. The fan-out is the REAL migration (profile columns seeded
  // raw, marker cleared, backfill re-run), so the durable provenance is written by the code under test.
  db.insertProfile({ id: "profNullFan", name: "Null-role fan-out rig", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "aFanOut", projectId: "pG", name: "aFanOut", startupPrompt: "x", position: 0, profileId: "profNullFan" });
  // The same profile's other agent ALREADY carried its own grant before the migration (caca806c-era): keeps the refusal.
  db.insertAgent({ id: "aFanOwn", projectId: "pG", name: "aFanOwn", startupPrompt: "x", position: 0, profileId: "profNullFan", connections: ["own-conn"] });
  // R11: the agent's OWN connection is ALSO on the null-role profile (overlap) — the own grant must keep its refusal.
  db.insertAgent({ id: "aFanDup", projectId: "pG", name: "aFanDup", startupPrompt: "x", position: 0, profileId: "profNullFan", connections: ["fan-conn"] });
  db.db.prepare("UPDATE profiles SET connections = ?, capabilities = ? WHERE id = ?").run(JSON.stringify(["fan-conn"]), JSON.stringify([{ slug: "fan-cap" }]), "profNullFan");
  db.db.prepare("DELETE FROM app_meta WHERE key = ?").run("profile_credential_grants_fanout_done");
  check("(ii-4b) setup: the real fan-out re-ran", db.backfillProfileCredentialGrantsToAgentsOnce() !== undefined);
  check("(ii-4b) setup: the fan-out put the profile's grants on BOTH agents' rows", db.getAgent("aFanOut").connections.includes("fan-conn") && db.getAgent("aFanOwn").connections.includes("fan-conn"));
  db.insertTask({ id: "task-ergc-fanout", projectId: "pG", title: "TFO", body: "", columnKey: "todo", position: 10, createdAt: now, updatedAt: now });
  let wFan = null;
  const errFan = await throws(async () => { wFan = await svc.spawnWorker(mgr.id, { taskId: "task-ergc-fanout", agentId: "aFanOut", kickoffPrompt: "KICK" }); });
  if (wFan) worktrees.push(wFan.worktreePath);
  check("(ii-4) a FANNED-OUT connection + capability on a role:null-profile agent still spawns as worker (pre-migration reach preserved)",
    errFan === null && !!wFan && wFan.role === "worker" && wFan.processState === "live");
  db.insertTask({ id: "task-ergc-fanown", projectId: "pG", title: "TFW", body: "", columnKey: "todo", position: 11, createdAt: now, updatedAt: now });
  const sessionsBeforeFanOwn = db.listAllSessions().length;
  const errFanOwn = await throws(() => svc.spawnWorker(mgr.id, { taskId: "task-ergc-fanown", agentId: "aFanOwn", kickoffPrompt: "KICK" }));
  check("(ii-4c) an agent-OWN pre-existing grant (same agent also got the fan-out) is STILL refused", errFanOwn instanceof Error && /connections/.test(errFanOwn.message));
  check("(ii-4c) NO new session row was created", db.listAllSessions().length === sessionsBeforeFanOwn);
  // R11: own connection that is ALSO on the profile is refused at spawn AND absent from the exemption record.
  const exDup = db.getFanoutExemption("aFanDup");
  check("(ii-4e) own-AND-profile connection is absent from getFanoutExemption (connections empty; only the fanned-out capability is exempt)",
    exDup.connections.length === 0 && JSON.stringify(exDup.capabilities) === JSON.stringify(["fan-cap"]));
  db.insertTask({ id: "task-ergc-fandup", projectId: "pG", title: "TFD", body: "", columnKey: "todo", position: 13, createdAt: now, updatedAt: now });
  const sessionsBeforeFanDup = db.listAllSessions().length;
  const errFanDup = await throws(() => svc.spawnWorker(mgr.id, { taskId: "task-ergc-fandup", agentId: "aFanDup", kickoffPrompt: "KICK" }));
  check("(ii-4e) ...and spawning it as worker is REFUSED (own grant overlapping the profile's keeps its refusal)", errFanDup instanceof Error && /connections/.test(errFanDup.message));
  check("(ii-4e) NO new session row was created", db.listAllSessions().length === sessionsBeforeFanDup);
  // A grant a human adds AFTER the migration to the fanned-out agent is not exempt.
  db.updateAgent("aFanOut", { connections: [...db.getAgent("aFanOut").connections, "later-human-conn"] });
  db.insertTask({ id: "task-ergc-fanlater", projectId: "pG", title: "TFL", body: "", columnKey: "todo", position: 12, createdAt: now, updatedAt: now });
  const errFanLater = await throws(() => svc.spawnWorker(mgr.id, { taskId: "task-ergc-fanlater", agentId: "aFanOut", kickoffPrompt: "KICK" }));
  check("(ii-4d) a connection added to the fanned-out agent AFTER the migration is refused (exemption is per-grant provenance, not per-agent)", errFanLater instanceof Error && /connections/.test(errFanLater.message));

  // MUTANT PROOF (lesson 298/319; run BY HAND against this file, same posture as this file's own
  // header RED/GREEN note above — a live in-process monkeypatch is not possible here: ESM named-export
  // bindings are read-only, reassigning `explicitRoleGrantCarryoverError` on the imported module
  // namespace throws "Cannot assign to read only property" rather than swapping the implementation, so
  // this is NOT wired into the automated run): with the null→worker branch's new carried-grant check
  // temporarily removed (reverting to the unconditional `return null;` it used to be), re-running (ii-6)
  // alone flips from REFUSED to the agent-level grant spawning through unchecked — see the worker_report
  // for this round's run of that recipe.
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
  db.updateAgent("aMgrOnRole", { connections: ["later-added"] });
  const a3 = await svc.recycleManager(a2.id, "handoff after-grant-added");
  check("(recycle-A1) an on-role recycle SUCCEEDS after a grant is added to the profile (the CR's exact repro — round 1 threw here)", a3.role === "manager");
  check("(recycle-A1) the successor does NOT carry the newly-added grant (old-row-carry, not profile re-resolution)", !(a3.connections ?? []).includes("later-added"));

  // ---- (recycle-B) OFF-role, already grant-carrying manager (human-started) + a SECOND grant added later ----
  db.insertProfile({ id: "profRecycleConn", name: "Recycle Conn Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "aRecycleConn", projectId: "pG", name: "aRecycleConn", startupPrompt: "x", position: 0, profileId: "profRecycleConn", connections: ["c1"] });
  const m1 = svc.startManager("aRecycleConn", undefined, { spawnHumanAuthorized: true });
  check("(recycle-B0) setup: the human-started off-role manager carries the grant on its row", m1.connections?.includes("c1"));
  const m2 = await svc.recycleManager(m1.id, "handoff 1");
  check("(recycle-B1) recycling an UNCHANGED off-role/grant lineage succeeds, carries the original grant", m2.role === "manager" && m2.connections?.includes("c1"));
  // The SAME profile now ALSO gains every OTHER forbidden-key grant (round 3, MINOR 2: the full set, not
  // just capabilities) — round 1 refused the NEXT recycle here; round 2/3 must not.
  db.updateProfile("profRecycleConn", { vaultWrite: true, browserTesting: true, documentConversion: true, harness: "codex" });
  db.updateAgent("aRecycleConn", { capabilities: [{ slug: "newly-added" }] });
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
  db.insertProfile({ id: "profLeadOnRole", name: "On-role Lead Rig", role: "platform", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "aLeadOnRole", projectId: "pG", name: "aLeadOnRole", startupPrompt: "x", position: 0, profileId: "profLeadOnRole", connections: ["lead-c1"] });
  const l1 = svc.startPlatformLead("aLeadOnRole", { spawnHumanAuthorized: true });
  check("(recycle-C0) setup: the lead carries the ORIGINAL connections grant on its row", l1.connections?.includes("lead-c1"));
  db.updateProfile("profLeadOnRole", { vaultWrite: true, browserTesting: true, documentConversion: true, harness: "codex" });
  db.updateAgent("aLeadOnRole", { capabilities: [{ slug: "newly-added" }] });
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
  db.insertProfile({ id: "profWorkerRecycleConn", name: "Worker Recycle Conn", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "aWorkerRecycleConn", projectId: "pG", name: "aWorkerRecycleConn", startupPrompt: "x", position: 0, profileId: "profWorkerRecycleConn", connections: ["wc1"] });
  const mgrForW = svc.startManager("aWorkerPlain", undefined, { spawnHumanAuthorized: true });
  const wTaskId = "task-ergc-recycle-w";
  db.insertTask({ id: wTaskId, projectId: "pG", title: "TW", body: "", columnKey: "todo", position: 3, createdAt: now, updatedAt: now });
  // spawnWorker itself would REFUSE this agent (assistant + connections, vector ii) — directly seed the
  // worker row instead, mirroring an already-authorized worker that predates this card's spawnWorker fix.
  const seedW = { id: "w-ergc-1", projectId: "pG", agentId: "aWorkerRecycleConn", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", connections: ["wc1"], parentSessionId: mgrForW.id, taskId: wTaskId, worktreePath: repo, branch: null, gen: 0 };
  db.insertSession(seedW);
  const w2 = await svc.recycleWorker(mgrForW.id, seedW.id, "handoff w1");
  worktrees.push(w2.worktreePath);
  // seedW was inserted directly (never through pty.spawn), so it has no backing live-pty entry — the
  // real onExit chain that normally flips a recycled predecessor's processState to "exited" (which
  // claimTaskWorktreeRefusal's @decision 641cc62c live-worker check depends on for the NEXT recycle on
  // this task, below) can never fire for it. A genuinely-spawned predecessor (e.g. w2 itself, recycled
  // next) gets this transition for free via its real live-pty entry; seedW needs it simulated here.
  db.setProcessState(seedW.id, "exited");
  check("(recycle-D1) a pre-existing carried connections grant does NOT block a worker recycle", w2.connections?.includes("wc1"));
  // The profile now gains the FULL forbidden-key set (round 3, MINOR 2), harness included — a worker's
  // harness is ROW-PINNED (never re-resolved, unlike manager/platform-lead above), so it is old-row-carry
  // just like the other five fields, not the role-force mechanism recycle-B2/C rely on.
  db.updateProfile("profWorkerRecycleConn", { vaultWrite: true, browserTesting: true, documentConversion: true, harness: "codex" });
  db.updateAgent("aWorkerRecycleConn", { capabilities: [{ slug: "newly-added" }] });
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

// ============================== (plain) forcePlain drops BOTH grant sources (card caca806c round 4) ==============================
{
  db.insertProfile({ id: "profPlainGrant", name: "Plain grant rig", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null });
  // Agent-row grants only, no profile (the exact round-4 hole), AND agent-row + profile-conn grants.
  db.insertAgent({ id: "aPlainAgentOnly", projectId: "pG", name: "aPlainAgentOnly", startupPrompt: "x", position: 0, profileId: null, connections: ["agent-conn"], capabilities: [{ slug: "agent-cap" }] });
  db.insertAgent({ id: "aPlainBoth", projectId: "pG", name: "aPlainBoth", startupPrompt: "x", position: 0, profileId: "profPlainGrant", connections: ["agent-conn"], capabilities: [{ slug: "agent-cap" }] });
  const viaPlatform = svc.spawnSessionAsPlatform("pG", "aPlainAgentOnly", "plain");
  check("(plain-1) spawnSessionAsPlatform(plain) on an AGENT-ROW-grant agent: session is role-null", viaPlatform.role == null);
  check("(plain-1) ...and carries NO connections (agent-row grant stripped)", (viaPlatform.connections ?? []).length === 0);
  check("(plain-1) ...and carries NO capabilities (agent-row grant stripped)", (viaPlatform.capabilities ?? []).length === 0);
  const bothPlain = svc.spawnSessionAsPlatform("pG", "aPlainBoth", "plain");
  check("(plain-2) a plain spawn on an agent with profile AND agent grants carries neither source", (bothPlain.connections ?? []).length === 0 && (bothPlain.capabilities ?? []).length === 0);
  const restPlain = svc.startNew("aPlainAgentOnly", { forcePlain: true });
  check("(plain-3) the human REST path (startNew forcePlain) hits the same chokepoint: no grants", (restPlain.connections ?? []).length === 0 && (restPlain.capabilities ?? []).length === 0);
  // Positive control: a NON-plain spawn of the same agent still carries the agent-row grants (union intact).
  const nonPlain = svc.startNew("aPlainAgentOnly");
  check("(plain-4) control: a non-plain startNew of the same agent STILL carries its agent-row grants", (nonPlain.connections ?? []).includes("agent-conn") && (nonPlain.capabilities ?? []).some((c) => c.slug === "agent-cap"));
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — all three vectors (session_spawn, worker_spawn, schedule_create→Scheduler) refuse an explicit-role spawn that would carry a profile's forbidden-key grant onto an off-role session, the human-REST/legitimate-flow/null-role-worker/harness-carve-out paths are unaffected, and recycle (manager, platform-lead, worker) ALWAYS succeeds regardless of a later grant edit — carrying exactly the old row's grants, never a newly-added one (round 2: no check, a pinned property instead)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
