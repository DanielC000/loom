import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Setup Assistant E1-5 — SessionService.startSetup: a SINGLETON live setup session on the curated
// loom-setup surface (E1-3). The Setup operator is deliberately a singleton (unlike the Platform Lead,
// which is now create-only — multiple Leads may coexist): startSetup reuses an already-LIVE setup session
// (so a manual Spawn can never mint a SECOND live setup session) but otherwise CREATES A FRESH session.
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty/stop seam). A real temp git repo backs the spawn cwd; the only thing faked is the claude
// pty. A real (stub) transcript file is written under the sandboxed HOME so an exited setup session would
// be genuinely resumable (engineTranscriptExists passes) — making (2) a sharp test: resumable yet NOT
// resumed by a manual Spawn.
//
// Proves the DoD (the surface itself is E1-3's setup-surface.mjs; here we assert the SPAWN + SINGLETON):
//   (0) SPAWN SHAPE              → a started setup session has role "setup" and the pty is spawned with
//                                  role "setup" (so it reaches /mcp-setup — E1-3 gates on the session role).
//   (1) existing LIVE setup      → startSetup returns the SAME id, creates NO new row, no spawn
//                                  (the load-bearing "never two LIVE setup sessions" guard).
//   (1b) live-precedence         → a live setup + a MORE-RECENTLY-ACTIVE exited setup → reuse the LIVE one.
//   (2) existing EXITED-RESUMABLE → startSetup CREATES A NEW row (different id) + spawns FRESH; the exited
//                                  one is NOT resumed (stays exited).
//   (3) NONE                     → exactly ONE setup session created; a re-open while LIVE reuses it; a
//                                  re-open after STOP creates a NEW row.
//   (4) OTHER ROLES UNCHANGED    → startAuditor stays create-only (two calls → two rows); startManager
//                                  spawns a manager (no setup leakage) — other role spawns are untouched.
//
// Run: 1) build (turbo builds shared first), 2) node test/setup-singleton.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time; transcript.ts reads os.homedir()). ---
const tmpHome = path.join(os.tmpdir(), `loom-setup-singleton-${Date.now()}-${process.pid}`);
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
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");

// --- a real temp git repo so a spawn has a valid cwd (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-setup-singleton-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# setup singleton test repo\n");
execSync(`git init -q && git add . && git -c user.email=ss@loom -c user.name=ss commit -q -m init`, { cwd: repo });

// Write a stub engine transcript so a given engine id is genuinely RESUMABLE (engineTranscriptExists
// resolves <home>/.claude/projects/<encodeProjectDir(cwd)>/<eng>.jsonl).
const writeTranscript = (cwd, eng) => {
  const dir = path.join(sandboxHome, ".claude", "projects", encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${eng}.jsonl`), `{"type":"user","message":{"content":"hi"}}\n`);
};

const now = new Date().toISOString();
const db = new Db();
// The reserved "Getting Started" home (E1-4 seeds this; here we just need a project to host the agents).
db.insertProject({ id: "pHome", name: "Getting Started", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
// One agent per scenario so each starts from a clean slate.
db.insertAgent({ id: "agentShape", projectId: "pHome", name: "SetupShape", startupPrompt: "SETUP", position: 0, profileId: null });
db.insertAgent({ id: "agentLive", projectId: "pHome", name: "SetupLive", startupPrompt: "SETUP", position: 1, profileId: null });
db.insertAgent({ id: "agentExited", projectId: "pHome", name: "SetupExited", startupPrompt: "SETUP", position: 2, profileId: null });
db.insertAgent({ id: "agentNone", projectId: "pHome", name: "SetupNone", startupPrompt: "SETUP", position: 3, profileId: null });
db.insertAgent({ id: "agentAud", projectId: "pHome", name: "Auditor", startupPrompt: "AUDIT", position: 4, profileId: null });
db.insertAgent({ id: "agentMgr", projectId: "pHome", name: "Mgr", startupPrompt: "MGR", position: 5, profileId: null });

// Fake pty: capture createPty (spawn) + stop calls; no real claude, no real signals.
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.spawned = []; this.stopped = []; }
  createPty(opts) { this.spawned.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop(id, mode) { this.stopped.push({ id, mode }); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const setupRows = (agentId) => db.listSessions(agentId).filter((s) => s.role === "setup");

try {
  // ============================ (0) SPAWN SHAPE — role "setup", pty spawned as "setup" ===============
  const s0 = svc.startSetup("agentShape");
  check("(0) startSetup → session row role is 'setup'", s0.role === "setup" && db.getSession(s0.id)?.role === "setup");
  check("(0) startSetup → live", s0.processState === "live" && db.getSession(s0.id)?.processState === "live");
  check("(0) startSetup → pty spawned with role 'setup' (reaches /mcp-setup) + no resumeId (fresh)",
    host.spawned.at(-1).sessionId === s0.id && host.spawned.at(-1).role === "setup" && host.spawned.at(-1).resumeId === undefined);

  // ============================ (1) existing LIVE setup → reuse, no new row =========================
  const liveSeed = "live-setup-seed";
  db.insertSession({
    id: liveSeed, projectId: "pHome", agentId: "agentLive", engineSessionId: "eng-live", title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "setup", parentSessionId: null,
  });
  const spawnedBefore1 = host.spawned.length;
  const r1 = svc.startSetup("agentLive");
  check("(1) live setup → returns the SAME session id (no new row)", r1.id === liveSeed);
  check("(1) live setup → still exactly ONE setup row", setupRows("agentLive").length === 1);
  check("(1) live setup → NO new pty spawned (already attached)", host.spawned.length === spawnedBefore1);

  // === (1b) LIVE-PRECEDENCE — a live setup + a MORE-RECENTLY-ACTIVE exited setup → reuse the LIVE one ===
  const recentExited = "live-prec-recent-exited"; // last_activity AFTER the live seed → sorts first
  db.insertSession({
    id: recentExited, projectId: "pHome", agentId: "agentLive", engineSessionId: "eng-recent-exited", title: null,
    cwd: repo, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: new Date(Date.parse(now) + 60_000).toISOString(), lastError: null,
    role: "setup", parentSessionId: null,
  });
  writeTranscript(repo, "eng-recent-exited"); // genuinely resumable — so ONLY live-precedence keeps it from being resumed
  const spawnedBeforePrec = host.spawned.length;
  const r1b = svc.startSetup("agentLive");
  check("(1b) live-precedence → returns the LIVE id even though an exited setup is more recently active", r1b.id === liveSeed);
  check("(1b) live-precedence → NO resume/new spawn (the exited one was NOT resumed)", host.spawned.length === spawnedBeforePrec);
  check("(1b) live-precedence → the exited row stays exited (not resumed)", db.getSession(recentExited)?.processState === "exited");

  // ============== (2) existing EXITED-RESUMABLE setup → manual Spawn CREATES A NEW row (not a resume) ==
  const exitedSeed = "exited-setup-seed";
  writeTranscript(repo, "eng-exited"); // genuinely resumable — sharp "resumable yet NOT resumed" test
  db.insertSession({
    id: exitedSeed, projectId: "pHome", agentId: "agentExited", engineSessionId: "eng-exited", title: null,
    cwd: repo, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "setup", parentSessionId: null,
  });
  const spawnedBefore2 = host.spawned.length;
  const r2 = svc.startSetup("agentExited");
  check("(2) exited setup → manual Spawn returns a NEW id (fresh session, not the exited one)", r2.id !== exitedSeed);
  check("(2) exited setup → the new session is live", r2.processState === "live" && db.getSession(r2.id)?.processState === "live");
  check("(2) exited setup → the exited one is NOT resumed (stays exited)", db.getSession(exitedSeed)?.processState === "exited");
  check("(2) exited setup → now exactly TWO setup rows (the exited one + the fresh one)", setupRows("agentExited").length === 2);
  check("(2) exited setup → FRESH spawn (no resumeId — a brand-new setup session)",
    host.spawned.length === spawnedBefore2 + 1 && host.spawned.at(-1).resumeId === undefined && host.spawned.at(-1).role === "setup");

  // ===================== (3) NONE → exactly one created; live re-open reuses, stop+re-open is fresh =====
  check("(3-pre) no setup row for the fresh agent", setupRows("agentNone").length === 0);
  const c1 = svc.startSetup("agentNone");
  check("(3) none → exactly ONE setup row created", setupRows("agentNone").length === 1 && c1.processState === "live");
  // Make the freshly-created setup session resumable, then re-open while LIVE: reuse path — same id, one row.
  db.setEngineSessionId(c1.id, "eng-fresh");
  writeTranscript(repo, "eng-fresh");
  const c2 = svc.startSetup("agentNone"); // still live → reuse path (never two live)
  check("(3) re-open while live → SAME id, still ONE row (reuse, no new row)", c2.id === c1.id && setupRows("agentNone").length === 1);
  // Now stop it and re-open: new contract → a manual Spawn mints a FRESH row (does NOT resume the exited one).
  db.setProcessState(c1.id, "exited");
  const c3 = svc.startSetup("agentNone");
  check("(3) re-open after stop → NEW id (fresh session, not a resume)", c3.id !== c1.id);
  check("(3) re-open after stop → now TWO setup rows; the exited one stays exited",
    setupRows("agentNone").length === 2 && db.getSession(c1.id)?.processState === "exited" && db.getSession(c3.id)?.processState === "live");

  // ============================ (4) OTHER ROLE SPAWNS UNCHANGED =======================================
  // Auditor stays create-only (each call mints a fresh row) — startSetup did not turn it into a singleton.
  const a1 = svc.startAuditor("agentAud");
  const a2 = svc.startAuditor("agentAud");
  const auditorRows = db.listSessions("agentAud").filter((s) => s.role === "auditor");
  check("(4) Auditor is still create-only — two calls mint TWO distinct rows (each fire is ephemeral)",
    a1.id !== a2.id && auditorRows.length === 2);
  // Manager spawn is untouched — role "manager", never "setup".
  const m1 = svc.startManager("agentMgr");
  check("(4) startManager → still spawns a 'manager' session (no setup leakage)",
    m1.role === "manager" && db.getSession(m1.id)?.role === "manager" && host.spawned.at(-1).role === "manager");
} finally {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — startSetup: spawns role 'setup' (reaches /mcp-setup); SINGLETON live→reuse (never two LIVE setup sessions), exited→fresh new row (manual Spawn never resumes), none→create-one; Auditor stays create-only and Manager spawns unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
