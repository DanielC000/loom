// Agent Profiles CRUD seam test (Topics→Profiles P3). HERMETIC + CLAUDE-FREE like profiles.mjs /
// profile-spawn.mjs: isolated LOOM_HOME, a REAL Db + SessionService driven against a FAKE pty (the
// PtyHost createPty() seam) — no daemon, no real claude, no network. Covers the P3 BACKEND seam bits
// the REST endpoints sit on top of:
//   (1) deleteProfile — round-trips, and a topic whose profile_id now dangles resolves to the plain
//       backstop (getProfile → undefined ⇒ resolveProfile's role-null path), proving delete is SAFE;
//   (2) resetProfileToBundled — restores a UI-edited bundled profile to its shipped fields by NAME
//       (id + topic assignment preserved); returns false for an unknown id AND a non-bundled name;
//   (3) updateTopic — SETS and CLEARS profile_id (the UI's assign / unassign);
//   (4) spawn force-plain — a manager-profile topic spawns role=manager + profile prompt/allow by
//       DEFAULT, but { forcePlain: true } BYPASSES the profile ENTIRELY (full backstop: role null, the
//       TOPIC's own prompt, NO allow delta) — asserted at the resolveTopicSpawn/DB seam (opts + DB row).
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
  db.insertProfile({ id: "delMe", name: "Disposable", role: "worker", startupPrompt: "tmp", allowDelta: [], skills: null, model: null, icon: null });
  db.insertTopic({ id: "tDangle", projectId: "pP", name: "Dangle", startupPrompt: "topic own prompt", position: 0, profileId: "delMe" });
  check("(1) profile present before delete", db.getProfile("delMe")?.name === "Disposable");
  db.deleteProfile("delMe");
  check("(1) deleteProfile removes the row (getProfile → undefined)", db.getProfile("delMe") === undefined);
  // The topic still references the deleted id; the spawn path resolves it → backstop (plain, role null).
  const dangleTopic = db.getTopic("tDangle");
  check("(1) topic row still carries the now-dangling profileId", dangleTopic?.profileId === "delMe");
  const dangleResolved = resolveProfile(dangleTopic, db.getProfile(dangleTopic.profileId)); // getProfile → undefined
  check("(1) dangling profileId resolves to the plain backstop (role null, topic's own prompt)",
    dangleResolved.role === null && dangleResolved.startupPrompt === "topic own prompt" && dangleResolved.allow.length === 0);
  db.deleteProfile("nope-not-here"); // idempotent — deleting an unknown id is a no-op, not an error
  check("(1) deleteProfile on an unknown id is a harmless no-op", true);

  // ===================== (2) resetProfileToBundled — restore by NAME; false on unknown/non-bundled =====================
  seedDefaultProfiles(db);
  const dev = db.listProfiles().find((p) => p.name === "Dev");
  check("(2) precondition: bundled 'Dev' profile seeded", !!dev && dev.role === "worker");
  // Edit every writable field away from the shipped values, then reset.
  db.updateProfile(dev.id, { role: "manager", startupPrompt: "HACKED", allowDelta: ["Bash(rm:*)"], skills: ["x"], model: "m", icon: "💀" });
  const edited = db.getProfile(dev.id);
  check("(2) profile edited away from bundled", edited.role === "manager" && edited.startupPrompt === "HACKED" && edited.icon === "💀");
  const ok = resetProfileToBundled(db, dev.id);
  const bundledDev = BUNDLED_PROFILES.find((b) => b.name === "Dev");
  const reset = db.getProfile(dev.id);
  check("(2) resetProfileToBundled returns true for a bundled profile", ok === true);
  check("(2) reset restores EVERY field to the shipped bundled values",
    reset.role === bundledDev.role && reset.startupPrompt === bundledDev.startupPrompt &&
    JSON.stringify(reset.allowDelta) === JSON.stringify(bundledDev.allowDelta) &&
    reset.skills === bundledDev.skills && reset.model === bundledDev.model && reset.icon === bundledDev.icon);
  check("(2) reset preserves the row id (same profile, restored in place)", reset.id === dev.id);
  check("(2) resetProfileToBundled → false for an unknown id", resetProfileToBundled(db, "no-such-id") === false);
  // A user-created (non-bundled-name) profile can't be reset.
  db.insertProfile({ id: "custom1", name: "My Custom Profile", role: null, startupPrompt: "mine", allowDelta: [], skills: null, model: null, icon: null });
  check("(2) resetProfileToBundled → false for a non-bundled name", resetProfileToBundled(db, "custom1") === false);

  // ===================== (3) updateTopic — SET and CLEAR profile_id =====================
  db.insertTopic({ id: "tAssign", projectId: "pP", name: "Assign", startupPrompt: "", position: 1, profileId: null });
  check("(3) topic starts profile-less", db.getTopic("tAssign").profileId === null);
  db.updateTopic("tAssign", { profileId: dev.id }); // SET
  check("(3) updateTopic SETS profile_id", db.getTopic("tAssign").profileId === dev.id);
  db.updateTopic("tAssign", { name: "Renamed" }); // patch WITHOUT profileId leaves the assignment intact
  check("(3) a patch omitting profileId leaves the assignment as-is", db.getTopic("tAssign").profileId === dev.id && db.getTopic("tAssign").name === "Renamed");
  db.updateTopic("tAssign", { profileId: null }); // CLEAR
  check("(3) updateTopic CLEARS profile_id (profileId: null)", db.getTopic("tAssign").profileId === null);

  // ===================== (4) spawn force-plain — FULL backstop (bypass the profile ENTIRELY) =====================
  // Ruling: force-plain = "spawn as if this topic had no profile" — role null, the TOPIC's own prompt,
  // NO allow delta. NOT role-only (a plain session must not carry the profile's manager prompt/allowlist).
  // Two manager-profile topics off the SAME profile prove every dimension is bypassed:
  //   • tMgrOwn  (own prompt "TOPIC_OWN")  → force-plain delivers the TOPIC's own concrete prompt;
  //   • tMgrBlank (blank own prompt)       → default falls back to the PROFILE prompt, force-plain does
  //     NOT (it drops to the empty topic prompt) — the contrast that proves the profile prompt is gone.
  const PROFILE_ALLOW = "Bash(echo PROFILE_OK:*)";
  db.insertProfile({ id: "profMgr", name: "Orchestrator-ForcePlain", role: "manager", startupPrompt: "PROFILE_PROMPT", allowDelta: [PROFILE_ALLOW], skills: null, model: null, icon: null });
  db.insertTopic({ id: "tMgrOwn", projectId: "pP", name: "ManagedOwn", startupPrompt: "TOPIC_OWN", position: 2, profileId: "profMgr" });
  db.insertTopic({ id: "tMgrBlank", projectId: "pP", name: "ManagedBlank", startupPrompt: "", position: 3, profileId: "profMgr" });

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

  // --- DEFAULT (no override) → the profile applies (unchanged P2 behavior): role=manager + allowDelta;
  //     the prompt follows resolveProfile precedence (own non-empty wins; blank falls back to profile).
  const sAuto = svc.startNew("tMgrOwn");
  const oAuto = optsFor(sAuto.id);
  check("(4) default on a manager-profile topic → role=manager (returned + DB + spawn opts)",
    sAuto.role === "manager" && db.getSession(sAuto.id).role === "manager" && oAuto?.role === "manager");
  check("(4) default layers the profile's allowDelta", oAuto?.permission.allow.includes(PROFILE_ALLOW));
  const sAutoBlank = svc.startNew("tMgrBlank");
  const oAutoBlank = optsFor(sAutoBlank.id);
  check("(4) default on a BLANK manager-profile topic → role=manager + falls back to the PROFILE prompt",
    oAutoBlank?.role === "manager" && oAutoBlank?.startupPrompt === "PROFILE_PROMPT" && oAutoBlank?.permission.allow.includes(PROFILE_ALLOW));

  // --- FORCE-PLAIN → full backstop: role null, the TOPIC's own prompt, NO allow delta (vanilla "+New").
  const sPlain = svc.startNew("tMgrOwn", { forcePlain: true });
  const oPlain = optsFor(sPlain.id);
  check("(4) forcePlain → returned session.role undefined (no orchestration surface)", sPlain.role === undefined);
  check("(4) forcePlain → DB persists role null (server-side role-gate sees a plain session)", db.getSession(sPlain.id).role === null);
  check("(4) forcePlain → spawn opts.role undefined (host.ts maps to the plain MCP surface)", oPlain?.role === undefined);
  check("(4) forcePlain → the TOPIC's OWN prompt, NOT the profile's", oPlain?.startupPrompt === "TOPIC_OWN");
  check("(4) forcePlain → NO profile allowDelta; permission.allow equals the base config allow exactly",
    !oPlain?.permission.allow.includes(PROFILE_ALLOW) && JSON.stringify(oPlain?.permission.allow) === JSON.stringify(baseAllow));
  // The contrast that proves the PROFILE PROMPT is bypassed: on the blank topic, default → "PROFILE_PROMPT"
  // (above) but force-plain drops to the topic's own (empty) prompt → undefined.
  const sPlainBlank = svc.startNew("tMgrBlank", { forcePlain: true });
  const oPlainBlank = optsFor(sPlainBlank.id);
  check("(4) forcePlain on the BLANK topic → role null AND no profile prompt (drops to the empty topic prompt → undefined)",
    db.getSession(sPlainBlank.id).role === null && oPlainBlank?.startupPrompt === undefined && !oPlainBlank?.permission.allow.includes(PROFILE_ALLOW));
} finally {
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — profile delete is SAFE (dangling→backstop), reset-to-bundled restores by name (false on unknown/non-bundled), updateTopic sets+clears profileId, and forcePlain bypasses the profile ENTIRELY (full backstop: role null, topic's own prompt, no allow delta) — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
