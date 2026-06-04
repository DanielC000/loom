import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Profiles CRUD seam test (Agents→Profiles P3). HERMETIC + CLAUDE-FREE like profiles.mjs /
// profile-spawn.mjs: isolated LOOM_HOME, a REAL Db + SessionService driven against a FAKE pty (the
// PtyHost createPty() seam) — no daemon, no real claude, no network. Covers the P3 BACKEND seam bits
// the REST endpoints sit on top of:
//   (1) deleteProfile — round-trips, and an agent whose profile_id now dangles resolves to the plain
//       backstop (getProfile → undefined ⇒ resolveProfile's role-null path), proving delete is SAFE;
//   (2) resetProfileToBundled — restores a UI-edited bundled profile to its shipped fields by NAME
//       (id + agent assignment preserved); returns false for an unknown id AND a non-bundled name;
//   (3) updateAgent — SETS and CLEARS profile_id (the UI's assign / unassign);
//   (4) spawn force-plain — a manager-profile agent spawns role=manager + the profile's allowDelta by
//       DEFAULT (the prompt is always the agent's own), but { forcePlain: true } BYPASSES the profile
//       ENTIRELY (full backstop: role null, NO allow delta) — asserted at the resolveAgentSpawn/DB seam.
// Run: 1) build (turbo builds shared first), 2) node test/profiles-crud.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs) — set BEFORE importing
// dist (paths.ts reads it at import time) and create logs/ so the spawn's createWriteStream succeeds.
const tmpHome = path.join(os.tmpdir(), `loom-pcrud-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const repo = path.join(tmpHome, "repo"); // startNew runs in project.repoPath (no worktree) — a dir suffices
fs.mkdirSync(repo, { recursive: true });

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { seedDefaultProfiles, resetProfileToBundled, BUNDLED_PROFILES } = await import("../dist/profiles/seed.js");
const { resolveProfile, resolveConfig } = await import("@loom/shared");
const baseAllow = resolveConfig({}).permission.allow; // the config allow a full-backstop spawn must equal

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });

try {
  // ===================== (1) deleteProfile — round-trip + SAFE dangling-assignment backstop =====================
  db.insertProfile({ id: "delMe", name: "Disposable", role: "worker", description: "tmp", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "tDangle", projectId: "pP", name: "Dangle", startupPrompt: "agent own prompt", position: 0, profileId: "delMe" });
  check("(1) profile present before delete", db.getProfile("delMe")?.name === "Disposable");
  db.deleteProfile("delMe");
  check("(1) deleteProfile removes the row (getProfile → undefined)", db.getProfile("delMe") === undefined);
  // The agent still references the deleted id; the spawn path resolves it → backstop (plain, role null).
  const dangleAgent = db.getAgent("tDangle");
  check("(1) agent row still carries the now-dangling profileId", dangleAgent?.profileId === "delMe");
  const dangleResolved = resolveProfile(dangleAgent, db.getProfile(dangleAgent.profileId)); // getProfile → undefined
  check("(1) dangling profileId resolves to the plain backstop (role null, agent's own prompt)",
    dangleResolved.role === null && dangleResolved.startupPrompt === "agent own prompt" && dangleResolved.allow.length === 0);
  db.deleteProfile("nope-not-here"); // idempotent — deleting an unknown id is a no-op, not an error
  check("(1) deleteProfile on an unknown id is a harmless no-op", true);

  // ===================== (2) resetProfileToBundled — restore by NAME; false on unknown/non-bundled =====================
  seedDefaultProfiles(db);
  const dev = db.listProfiles().find((p) => p.name === "Dev");
  check("(2) precondition: bundled 'Dev' profile seeded", !!dev && dev.role === "worker");
  // Edit every writable field away from the shipped values, then reset.
  db.updateProfile(dev.id, { role: "manager", description: "HACKED", allowDelta: ["Bash(rm:*)"], skills: ["x"], model: "m", icon: "💀" });
  const edited = db.getProfile(dev.id);
  check("(2) profile edited away from bundled", edited.role === "manager" && edited.description === "HACKED" && edited.icon === "💀");
  const ok = resetProfileToBundled(db, dev.id);
  const bundledDev = BUNDLED_PROFILES.find((b) => b.name === "Dev");
  const reset = db.getProfile(dev.id);
  check("(2) resetProfileToBundled returns true for a bundled profile", ok === true);
  check("(2) reset restores EVERY field to the shipped bundled values",
    reset.role === bundledDev.role && reset.description === bundledDev.description &&
    JSON.stringify(reset.allowDelta) === JSON.stringify(bundledDev.allowDelta) &&
    reset.skills === bundledDev.skills && reset.model === bundledDev.model && reset.icon === bundledDev.icon);
  check("(2) reset preserves the row id (same profile, restored in place)", reset.id === dev.id);
  check("(2) resetProfileToBundled → false for an unknown id", resetProfileToBundled(db, "no-such-id") === false);
  // A user-created (non-bundled-name) profile can't be reset.
  db.insertProfile({ id: "custom1", name: "My Custom Profile", role: null, description: "mine", allowDelta: [], skills: null, model: null, icon: null });
  check("(2) resetProfileToBundled → false for a non-bundled name", resetProfileToBundled(db, "custom1") === false);

  // ===================== (3) updateAgent — SET and CLEAR profile_id =====================
  db.insertAgent({ id: "tAssign", projectId: "pP", name: "Assign", startupPrompt: "", position: 1, profileId: null });
  check("(3) agent starts profile-less", db.getAgent("tAssign").profileId === null);
  db.updateAgent("tAssign", { profileId: dev.id }); // SET
  check("(3) updateAgent SETS profile_id", db.getAgent("tAssign").profileId === dev.id);
  db.updateAgent("tAssign", { name: "Renamed" }); // patch WITHOUT profileId leaves the assignment intact
  check("(3) a patch omitting profileId leaves the assignment as-is", db.getAgent("tAssign").profileId === dev.id && db.getAgent("tAssign").name === "Renamed");
  db.updateAgent("tAssign", { profileId: null }); // CLEAR
  check("(3) updateAgent CLEARS profile_id (profileId: null)", db.getAgent("tAssign").profileId === null);

  // ===================== (4) spawn force-plain — FULL backstop (bypass the profile ENTIRELY) =====================
  // Ruling: force-plain = "spawn as if this agent had no profile" — role null, NO allow delta. The
  // injected prompt is ALWAYS the agent's own (a profile carries no prompt), so force-plain's distinct
  // effect is on ROLE + ALLOW. Two manager-profile agents off the SAME profile show it:
  //   • tMgrOwn  (own prompt "AGENT_OWN")  → both default and force-plain inject the agent's own prompt;
  //   • the contrast is role/allow: default → manager + allowDelta; force-plain → role null + no allow.
  const PROFILE_ALLOW = "Bash(echo PROFILE_OK:*)";
  db.insertProfile({ id: "profMgr", name: "Orchestrator-ForcePlain", role: "manager", description: "rig blurb (never injected)", allowDelta: [PROFILE_ALLOW], skills: null, model: null, icon: null });
  db.insertAgent({ id: "tMgrOwn", projectId: "pP", name: "ManagedOwn", startupPrompt: "AGENT_OWN", position: 2, profileId: "profMgr" });
  db.insertAgent({ id: "tMgrBlank", projectId: "pP", name: "ManagedBlank", startupPrompt: "", position: 3, profileId: "profMgr" });

  class SeamHost extends PtyHost {
    constructor(events) { super(events); this.capture = []; }
    createPty(opts) {
      this.capture.push(opts);
      return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} };
    }
  }
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const host = new SeamHost(events);
  const svc = new SessionService(db, host, new OrchestrationControl());
  const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

  // --- DEFAULT (no override) → the profile applies: role=manager + allowDelta; the injected prompt is
  //     ALWAYS the agent's own (no merge — a blank agent prompt stays blank).
  const sAuto = svc.startNew("tMgrOwn");
  const oAuto = optsFor(sAuto.id);
  check("(4) default on a manager-profile agent → role=manager (returned + DB + spawn opts)",
    sAuto.role === "manager" && db.getSession(sAuto.id).role === "manager" && oAuto?.role === "manager");
  check("(4) default layers the profile's allowDelta", oAuto?.permission.allow.includes(PROFILE_ALLOW));
  check("(4) default injects the AGENT's own prompt (not the profile)", oAuto?.startupPrompt === "AGENT_OWN");
  const sAutoBlank = svc.startNew("tMgrBlank");
  const oAutoBlank = optsFor(sAutoBlank.id);
  check("(4) default on a BLANK manager-profile agent → role=manager + allowDelta, but NO injected prompt (no fallback)",
    oAutoBlank?.role === "manager" && oAutoBlank?.startupPrompt === undefined && oAutoBlank?.permission.allow.includes(PROFILE_ALLOW));

  // --- FORCE-PLAIN → full backstop: role null, the AGENT's own prompt, NO allow delta (vanilla "+New").
  const sPlain = svc.startNew("tMgrOwn", { forcePlain: true });
  const oPlain = optsFor(sPlain.id);
  check("(4) forcePlain → returned session.role undefined (no orchestration surface)", sPlain.role === undefined);
  check("(4) forcePlain → DB persists role null (server-side role-gate sees a plain session)", db.getSession(sPlain.id).role === null);
  check("(4) forcePlain → spawn opts.role undefined (host.ts maps to the plain MCP surface)", oPlain?.role === undefined);
  check("(4) forcePlain → the AGENT's own prompt (same as default — the profile carries no prompt)", oPlain?.startupPrompt === "AGENT_OWN");
  check("(4) forcePlain → NO profile allowDelta; permission.allow equals the base config allow exactly",
    !oPlain?.permission.allow.includes(PROFILE_ALLOW) && JSON.stringify(oPlain?.permission.allow) === JSON.stringify(baseAllow));
  // The force-plain effect is ROLE + ALLOW: even a blank manager-profile agent drops to role null and
  // loses the allow delta (the prompt is the agent's own — empty here — in both default and force-plain).
  const sPlainBlank = svc.startNew("tMgrBlank", { forcePlain: true });
  const oPlainBlank = optsFor(sPlainBlank.id);
  check("(4) forcePlain on the BLANK agent → role null AND no profile allow delta",
    db.getSession(sPlainBlank.id).role === null && oPlainBlank?.startupPrompt === undefined && !oPlainBlank?.permission.allow.includes(PROFILE_ALLOW));
} finally {
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — profile delete is SAFE (dangling→backstop), reset-to-bundled restores by name (false on unknown/non-bundled), updateAgent sets+clears profileId, and forcePlain bypasses the profile ENTIRELY (full backstop: role null, agent's own prompt, no allow delta) — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
