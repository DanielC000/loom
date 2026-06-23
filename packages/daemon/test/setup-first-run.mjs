import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Setup Assistant E1-6 — first-run auto-launch (maybeAutoLaunchSetup) + the app_meta kv marker. On a
// brand-new/empty install the daemon auto-spawns the Setup Assistant session EXACTLY ONCE on boot, stamping
// a one-time daemon-global marker so it never re-fires (not after a daemon_restart, not after the user later
// deletes all their projects). RUN-SHAPED (boot behavior) but driven HERMETICALLY: a REAL Db +
// SessionService against a FAKE pty (createPty seam — no real claude, no network), exactly like
// setup-singleton.mjs. The reserved "Getting Started" home + its Setup Assistant agent are seeded by the
// REAL seedSetupHome (E1-4), so the by-name resolution is exercised end-to-end.
//
// Proves the DoD (all 4 cases + the two guard reasons):
//   (1) FRESH/EMPTY install        → maybeAutoLaunchSetup launches ONCE: a 'setup' session is spawned and
//                                     the marker is stamped (the empty install — only reserved homes — reads
//                                     as zero ordinary projects via listProjects).
//   (2) RESTART (marker set)       → a 2nd call does NOT re-spawn (reason 'marker-set'); no new pty.
//   (3) DELETE-ALL after marker    → user creates then deletes all ordinary projects; with the marker set it
//                                     STILL does not re-spawn even though listProjects() is empty again.
//   (4) MARKER SURVIVES RESTART    → reopening the SAME db file (a daemon restart) still reads the marker.
//   (5) has-projects guard         → marker UNSET but an ordinary project exists → not launched, no marker
//                                     stamped (proves the empty-detection gates the launch, not just the marker).
//   (6) agent-missing guard        → empty + marker unset but NO setup home seeded → not launched, no marker.
//
// Run: 1) build (turbo builds shared first), 2) node test/setup-first-run.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import
// time). seedSetupHome binds the home's repoPath/vaultPath to LOOM_HOME, which is the fake-pty spawn cwd. ---
const tmpHome = path.join(os.tmpdir(), `loom-setup-first-run-${Date.now()}-${process.pid}`);
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
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { seedSetupHome, seedSetupAuditorAgent, SETUP_AGENT_NAME, SETUP_AUDITOR_AGENT_NAME } = await import("../dist/setup/seed.js");
const { maybeAutoLaunchSetup, SETUP_FIRST_RUN_KEY } = await import("../dist/setup/first-run.js");

const now = new Date().toISOString();

// Fake pty: capture createPty (spawn) calls; no real claude, no real signals. Mirrors setup-singleton.mjs.
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.spawned = []; this.stopped = []; }
  createPty(opts) { this.spawned.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop(id, mode) { this.stopped.push({ id, mode }); }
}
const events = {
  onEngineSessionId(id, eng) {}, onBusy() {}, onContextStats() {}, onRateLimited() {},
  onExit() {},
};

const mainDbFile = path.join(tmpHome, "loom.db");
const setupRows = (db) => {
  const home = db.getReservedProjectByName("Getting Started");
  return home ? db.listSessions(db.listAgents(home.id)[0].id).filter((s) => s.role === "setup") : [];
};

try {
  // ===== MAIN SEQUENCE on one db file (the marker is daemon-GLOBAL, so it persists across these calls) =====
  let db = new Db(mainDbFile);
  seedDefaultProfiles(db);                 // so the bundled "Setup Assistant" profile exists to assign
  const seeded = seedSetupHome(db);        // the reserved "Getting Started" home + its Setup Assistant agent
  check("(pre) seedSetupHome created the reserved home + agent", seeded.length === 2);
  check("(pre) a fresh install reads as ZERO ordinary projects (reserved homes excluded)", db.listProjects().length === 0);
  check("(pre) the first-run marker is unset on a fresh install", db.getMeta(SETUP_FIRST_RUN_KEY) === undefined);

  const host = new SeamHost(events);
  const svc = new SessionService(db, host, new OrchestrationControl());

  // ---- (1) FRESH/EMPTY → auto-launch ONCE, marker stamped ----
  const r1 = maybeAutoLaunchSetup(db, svc);
  check("(1) fresh install → launched", r1.launched === true && typeof r1.sessionId === "string");
  check("(1) fresh install → exactly ONE 'setup' pty spawned, role 'setup', fresh (no resumeId)",
    host.spawned.length === 1 && host.spawned.at(-1).role === "setup" && host.spawned.at(-1).resumeId === undefined);
  check("(1) fresh install → exactly ONE setup session row, live", setupRows(db).length === 1 && db.getSession(r1.sessionId)?.processState === "live");
  check("(1) fresh install → marker now stamped (at launch, not completion)", typeof db.getMeta(SETUP_FIRST_RUN_KEY) === "string");

  // ---- (2) RESTART (marker set) → no re-spawn ----
  const spawnedAfter1 = host.spawned.length;
  const r2 = maybeAutoLaunchSetup(db, svc);
  check("(2) restart with marker set → NOT launched (reason 'marker-set')", r2.launched === false && r2.reason === "marker-set");
  check("(2) restart → NO new pty spawned, still ONE setup row", host.spawned.length === spawnedAfter1 && setupRows(db).length === 1);

  // ---- (3) DELETE-ALL after marker → still no re-spawn (the marker outlives the empty-project state) ----
  const ordinary = { id: "ord-1", name: "MyProject", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false };
  db.insertProject(ordinary);
  check("(3-pre) the user now has one ordinary project", db.listProjects().length === 1);
  db.deleteProject("ord-1");
  check("(3-pre) user deleted all ordinary projects → listProjects empty again", db.listProjects().length === 0);
  const spawnedAfter2 = host.spawned.length;
  const r3 = maybeAutoLaunchSetup(db, svc);
  check("(3) delete-all after marker → STILL not launched (marker-set, never re-triggers)", r3.launched === false && r3.reason === "marker-set");
  check("(3) delete-all → NO new pty spawned", host.spawned.length === spawnedAfter2);

  // ---- (4) MARKER SURVIVES RESTART → reopen the SAME db file ----
  const markerBefore = db.getMeta(SETUP_FIRST_RUN_KEY);
  db.close();
  db = new Db(mainDbFile); // a daemon restart: brand-new connection on the same on-disk db
  check("(4) marker survives a daemon restart (reopened db still has it)", db.getMeta(SETUP_FIRST_RUN_KEY) === markerBefore);
  const r4 = maybeAutoLaunchSetup(db, new SessionService(db, host, new OrchestrationControl()));
  check("(4) post-restart → still not launched (marker-set)", r4.launched === false && r4.reason === "marker-set");
  db.close();

  // ===== (5) has-projects guard — marker UNSET but an ordinary project exists → not launched =====
  const dbProj = new Db(path.join(tmpHome, "with-projects.db"));
  seedDefaultProfiles(dbProj);
  seedSetupHome(dbProj);
  dbProj.insertProject({ id: "p1", name: "Existing", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const spawnedBefore5 = host.spawned.length;
  const r5 = maybeAutoLaunchSetup(dbProj, svc);
  check("(5) has-projects → NOT launched (reason 'has-projects')", r5.launched === false && r5.reason === "has-projects");
  check("(5) has-projects → marker NOT stamped (launch gated by emptiness, not just the marker)", dbProj.getMeta(SETUP_FIRST_RUN_KEY) === undefined);
  check("(5) has-projects → no pty spawned", host.spawned.length === spawnedBefore5);
  dbProj.close();

  // ===== (6) agent-missing guard — empty + marker unset but NO setup home seeded → not launched =====
  const dbBare = new Db(path.join(tmpHome, "bare.db"));
  const spawnedBefore6 = host.spawned.length;
  const r6 = maybeAutoLaunchSetup(dbBare, svc);
  check("(6) no setup home seeded → NOT launched (reason 'agent-missing')", r6.launched === false && r6.reason === "agent-missing");
  check("(6) agent-missing → marker NOT stamped (a later boot can still auto-launch once seeded)", dbBare.getMeta(SETUP_FIRST_RUN_KEY) === undefined);
  check("(6) agent-missing → no pty spawned", host.spawned.length === spawnedBefore6);
  dbBare.close();

  // ===== (7) B4 — first-run resolves the OPERATOR with TWO agents in the home (auditor must not be mistaken
  //        for the operator). The home now holds 'Platform' (operator) + 'Workspace Auditor'; maybeAutoLaunchSetup
  //        resolves the operator by exact SETUP_AGENT_NAME, so it still launches the operator, not the auditor. =====
  const dbTwo = new Db(path.join(tmpHome, "two-agents.db"));
  seedDefaultProfiles(dbTwo);
  seedSetupHome(dbTwo);
  const seededAud = seedSetupAuditorAgent(dbTwo); // the 2nd agent in the same reserved home
  const homeTwo = dbTwo.getReservedProjectByName("Getting Started");
  check("(7-pre) the home holds BOTH the operator and the auditor agent",
    seededAud === SETUP_AUDITOR_AGENT_NAME && dbTwo.listAgents(homeTwo.id).length === 2);
  const hostTwo = new SeamHost(events);
  const r7 = maybeAutoLaunchSetup(dbTwo, new SessionService(dbTwo, hostTwo, new OrchestrationControl()));
  const launchedAgentId = r7.launched ? dbTwo.getSession(r7.sessionId)?.agentId : undefined;
  const operatorTwo = dbTwo.listAgents(homeTwo.id).find((a) => a.name === SETUP_AGENT_NAME);
  const auditorTwo = dbTwo.listAgents(homeTwo.id).find((a) => a.name === SETUP_AUDITOR_AGENT_NAME);
  check("(7) two agents present → first-run STILL launches the OPERATOR ('Platform'), not the auditor",
    r7.launched === true && launchedAgentId === operatorTwo.id && launchedAgentId !== auditorTwo.id);
  check("(7) the auto-launched session is a 'setup' session (operator role, not the auditor)",
    hostTwo.spawned.length === 1 && hostTwo.spawned.at(-1).role === "setup");
  dbTwo.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — first-run auto-launch fires EXACTLY once on an empty install, stamps a daemon-global app_meta marker at launch, and never re-triggers (restart or later project-deletion); guarded by emptiness + the marker."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
