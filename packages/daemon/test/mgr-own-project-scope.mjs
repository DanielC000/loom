import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// HOLE #1 — manager self-service writes are scoped to the CALLER'S OWN project. The manager self-service
// methods (project_update/_archive, agent_update/_assign_profile, schedule_create/_update) take a target id
// as a PARAM; without an own-project guard a prompt-injected/confused manager could reconfigure or archive
// ANY project — including the reserved Loom Platform home — breaking the documented invariant that
// platform_escalate is the manager's ONE cross-project write. The guard lives at the SERVICE chokepoint
// (requireOwnProject), so every router/caller path inherits it.
//
// HERMETIC + CLAUDE-FREE (real Db + SessionService against a no-op fake pty, in the style of
// user-audit-handoff.mjs). Proves, per the DoD:
//   - a manager CANNOT project_update / project_archive a DIFFERENT project (esp. the reserved home), nor
//     agent_update / agent_assign_profile / agent_delete / schedule_create / schedule_update a target in
//     another project — each REJECTS and makes NO write;
//   - a SAME-project target still SUCCEEDS (regression guard);
//   - missing agent / missing schedule are rejected (no silent escape);
//   - profile_delete (task 2c9b2960, the SHARED-rig hazard) additionally REJECTS a profile referenced by
//     an agent OUTSIDE the caller's project — naming the blocking agent + project — INCLUDING a foreign
//     agent in an ARCHIVED (soft-deleted, restorable) project, since archived ≠ gone — while an unused
//     profile, or one referenced ONLY within the caller's own project, still deletes.
//
// Run: 1) build (turbo builds shared first), 2) node test/mgr-own-project-scope.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// Assert fn throws (the service rejects → the router turns it into an {error} envelope) with an optional
// message matcher; returns the thrown message for further inspection.
const rejects = (label, fn, re) => {
  let msg = null;
  try { fn(); } catch (e) { msg = (e instanceof Error ? e.message : String(e)); }
  check(label, msg !== null && (re ? re.test(msg) : true));
  return msg;
};

const tmpHome = path.join(os.tmpdir(), `loom-mgrscope-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45418";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const db = new Db(path.join(tmpHome, "loom.db"));

// pMine = the manager's OWN ordinary project. pOther = a DIFFERENT project, modelled as the reserved
// Loom Platform home (the highest-value cross-project target the card calls out).
db.insertProject({ id: "pMine", name: "Mine", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pOther", name: "Loom Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertAgent({ id: "aMine", projectId: "pMine", name: "Dev", startupPrompt: "MINE", position: 0, profileId: null });
db.insertAgent({ id: "aOther", projectId: "pOther", name: "Platform Lead", startupPrompt: "OTHER", position: 0, profileId: null });
db.insertProfile({ id: "profX", name: "QA Tester", role: "worker", description: "browser rig", allowDelta: [], skills: null, model: null, icon: null });
// agent_delete / profile_delete fixtures (task 2c9b2960): a throwaway own-project agent to delete,
// an unused profile, and a profile referenced ONLY by an agent in the FOREIGN project (a separate
// aOtherProf, not the pre-existing aOther fixture — keeps the agent_assign_profile cases above untouched)
// — the cross-project-safety hazard the manager profile_delete guard exists to catch.
db.insertAgent({ id: "aMineDel", projectId: "pMine", name: "ToDelete", startupPrompt: "", position: 1, profileId: null });
db.insertAgent({ id: "aOtherProf", projectId: "pOther", name: "OtherProfiled", startupPrompt: "", position: 1, profileId: "profShared" });
db.insertProfile({ id: "profUnusedMgr", name: "Unused", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
// An ARCHIVED (soft-deleted, RESTORABLE) foreign project whose agent still references a profile — the
// external-reference scan must cover archived projects too (archived is not gone; skipping it would let
// a manager delete a rig that dangles the instant the project is restored).
db.insertProject({ id: "pArchived", name: "ArchivedFar", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: now, reserved: false });
db.insertAgent({ id: "aArchivedProf", projectId: "pArchived", name: "ArchivedAgent", startupPrompt: "", position: 0, profileId: "profArchived" });
db.insertProfile({ id: "profArchived", name: "ArchivedRef", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profShared", name: "Shared", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
// A pre-existing schedule in EACH project (target the manager will try to cross-edit).
db.insertSchedule({ id: "schMine", agentId: "aMine", cron: "0 * * * *", enabled: true, nextFireAt: now, lastFiredAt: null, createdAt: now, kind: "manager" });
db.insertSchedule({ id: "schOther", agentId: "aOther", cron: "0 * * * *", enabled: true, nextFireAt: now, lastFiredAt: null, createdAt: now, kind: "manager" });

// The manager session lives in pMine. (Role MUST be "manager" — requireManager gates first.)
db.insertSession({
  id: "M", projectId: "pMine", agentId: "aMine", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager", parentSessionId: null,
});

// Fake pty — these methods never enqueue stdin, but SessionService needs the dep.
const pty = { enqueueStdin: () => ({ delivered: false }) };
const svc = new SessionService(db, pty, new OrchestrationControl());

try {
  // ════════ project_update — cross-project REJECTED, no write; own-project OK ════════
  rejects("project_update on a FOREIGN project (the reserved home) → rejected",
    () => svc.updateProjectStructural("M", "pOther", { name: "PWNED" }), /outside your project/);
  check("project_update made NO write to the foreign project", db.getProject("pOther").name === "Loom Platform");
  const upd = svc.updateProjectStructural("M", "pMine", { name: "Mine Renamed" });
  check("project_update on the manager's OWN project SUCCEEDS (regression guard)",
    upd.name === "Mine Renamed" && db.getProject("pMine").name === "Mine Renamed");

  // ════════ project_archive — cross-project REJECTED, no write; own-project OK ════════
  rejects("project_archive on the reserved Loom Platform home → rejected",
    () => svc.archiveProjectAsManager("M", "pOther"), /outside your project/);
  check("project_archive did NOT archive the foreign project", db.getProject("pOther").archivedAt === null);

  // ════════ agent_assign_profile — cross-project REJECTED, no write; own-project OK ════════
  rejects("agent_assign_profile on an agent in ANOTHER project → rejected",
    () => svc.assignAgentProfile("M", "aOther", "profX"), /outside your project/);
  check("agent_assign_profile made NO write to the foreign agent", db.getAgent("aOther").profileId === null);
  rejects("agent_assign_profile on a MISSING agent → rejected", () => svc.assignAgentProfile("M", "ghost", "profX"), /agent not found/);
  const assigned = svc.assignAgentProfile("M", "aMine", "profX");
  check("agent_assign_profile on the manager's OWN agent SUCCEEDS", assigned.profileId === "profX" && db.getAgent("aMine").profileId === "profX");

  // ════════ agent_update — cross-project REJECTED, no write; own-project OK ════════
  rejects("agent_update on an agent in ANOTHER project → rejected",
    () => svc.updateAgentPreset("M", "aOther", { name: "PWNED", startupPrompt: "INJECTED" }), /outside your project/);
  check("agent_update made NO write to the foreign agent",
    db.getAgent("aOther").name === "Platform Lead" && db.getAgent("aOther").startupPrompt === "OTHER");
  rejects("agent_update on a MISSING agent → rejected", () => svc.updateAgentPreset("M", "ghost", { name: "x" }), /agent not found/);
  const agUpd = svc.updateAgentPreset("M", "aMine", { name: "Dev 2" });
  check("agent_update on the manager's OWN agent SUCCEEDS", agUpd.name === "Dev 2" && db.getAgent("aMine").name === "Dev 2");

  // ════════ schedule_create — cross-project target agent REJECTED, no write; own-project OK ════════
  const schedBefore = db.listSchedules().length;
  rejects("schedule_create targeting an agent in ANOTHER project → rejected",
    () => svc.createSchedule("M", { agentId: "aOther", cron: "0 * * * *" }), /outside your project/);
  check("schedule_create made NO write (no new schedule row)", db.listSchedules().length === schedBefore);
  const created = svc.createSchedule("M", { agentId: "aMine", cron: "*/5 * * * *" });
  check("schedule_create for the manager's OWN agent SUCCEEDS", !!db.getSchedule(created.id) && db.getSchedule(created.id).agentId === "aMine");

  // ════════ schedule_update — cross-project schedule REJECTED, no write; own-project OK ════════
  rejects("schedule_update on a schedule whose agent is in ANOTHER project → rejected",
    () => svc.updateScheduleAsManager("M", "schOther", { enabled: false }), /outside your project/);
  check("schedule_update made NO write to the foreign schedule", db.getSchedule("schOther").enabled === true);
  rejects("schedule_update on a MISSING schedule → rejected", () => svc.updateScheduleAsManager("M", "ghost", { enabled: false }), /schedule not found/);
  const schUpd = svc.updateScheduleAsManager("M", "schMine", { enabled: false });
  check("schedule_update on the manager's OWN schedule SUCCEEDS", schUpd.enabled === false && db.getSchedule("schMine").enabled === false);

  // ════════ agent_delete — cross-project REJECTED, no write; own-project OK (task 2c9b2960) ════════
  rejects("agent_delete on an agent in ANOTHER project → rejected",
    () => svc.deleteAgentAsManager("M", "aOther"), /outside your project/);
  check("agent_delete made NO write to the foreign agent", !!db.getAgent("aOther"));
  rejects("agent_delete on a MISSING agent → rejected", () => svc.deleteAgentAsManager("M", "ghost"), /agent not found/);
  const delAgent = svc.deleteAgentAsManager("M", "aMineDel");
  check("agent_delete on the manager's OWN agent SUCCEEDS", delAgent.deleted === true && !db.getAgent("aMineDel"));

  // ════════ profile_delete — shared-profile-safe: rejects a profile used OUTSIDE the caller's project,
  // naming the blocker; an unused profile or one used ONLY within-project still deletes (task 2c9b2960) ════════
  const delShared = rejects("profile_delete on a profile referenced by an agent in ANOTHER project → rejected (names the blocker)",
    () => svc.deleteProfileAsManager("M", "profShared"), /outside your project/);
  check("profile_delete error NAMES the blocking agent + project", /aOther/.test(delShared) && /pOther/.test(delShared));
  check("profile_delete made NO write to the foreign-referenced profile", !!db.getProfile("profShared"));
  // ARCHIVED (soft-deleted, RESTORABLE) foreign project — its agent's reference must STILL block delete
  // (archived is not gone; the scan covers listAllProjects + listArchivedProjects).
  const delArchived = rejects("profile_delete on a profile referenced ONLY by an agent in an ARCHIVED foreign project → rejected (names the blocker)",
    () => svc.deleteProfileAsManager("M", "profArchived"), /outside your project/);
  check("profile_delete error NAMES the archived project's blocking agent + project", /aArchivedProf/.test(delArchived) && /pArchived/.test(delArchived));
  check("profile_delete made NO write to the archived-project-referenced profile", !!db.getProfile("profArchived"));
  rejects("profile_delete on a MISSING profile → rejected", () => svc.deleteProfileAsManager("M", "ghost"), /profile not found/);
  const delUnused = svc.deleteProfileAsManager("M", "profUnusedMgr");
  check("profile_delete on an UNUSED profile SUCCEEDS", delUnused.deleted === true && !db.getProfile("profUnusedMgr"));
  // profX is assigned to aMine (the manager's OWN agent, from the agent_assign_profile case above) —
  // a reference CONFINED to the caller's own project must NOT block delete (regression guard).
  check("profX is referenced only within the caller's own project (aMine)", db.getAgent("aMine").profileId === "profX");
  const delOwnUse = svc.deleteProfileAsManager("M", "profX");
  check("profile_delete on a profile used ONLY within the caller's own project SUCCEEDS", delOwnUse.deleted === true && !db.getProfile("profX"));

  // ════════ same-project archive SUCCEEDS (the regression-guard half for archive — done last) ════════
  const arch = svc.archiveProjectAsManager("M", "pMine");
  check("project_archive on the manager's OWN project SUCCEEDS", arch.archived === true && db.getProject("pMine").archivedAt !== null);
} finally {
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — manager self-service writes are own-project-scoped: project_update/_archive, agent_update/_assign_profile, agent_delete, schedule_create/_update all REJECT a target in another project (incl. the reserved home) with NO write, while a same-project target still succeeds; profile_delete additionally REJECTS a profile referenced by an agent OUTSIDE the caller's project — INCLUDING one in an archived/restorable foreign project — naming the blocker, while an unused or within-project-only reference still deletes — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
