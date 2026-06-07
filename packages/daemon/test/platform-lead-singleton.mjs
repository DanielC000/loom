import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform Lead SINGLETON = "never two LIVE Leads" (NOT "one row ever"). startPlatformLead reuses an
// already-LIVE Lead (so a manual Spawn can never mint a SECOND live Lead) but otherwise CREATES A FRESH
// session — a manual Spawn always gets a new session. The old RESUME-OR-CREATE behavior (silently
// resuming the latest EXITED Lead on Spawn) was the owner-reported bug; on-demand resume is now an
// explicit human action (the Lead/Auditor History "Resume" button), and restart-resume is handled
// independently by resumeFleetOnBoot (resume-by-id), so this test does not exercise it.
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like platform-mgmt-surface.mjs: a REAL Db +
// SessionService driven against a FAKE pty (createPty/stop seam). A real temp git repo backs the spawn
// cwd; the only thing faked is the claude pty. A real (stub) transcript file is written under the
// sandboxed HOME so an exited Lead would be genuinely resumable (engineTranscriptExists passes) — which
// makes (2) a sharp test: the exited Lead is resumable yet must NOT be resumed by a manual Spawn.
//
// Proves the DoD:
//   (1) existing LIVE Lead       → startPlatformLead returns the SAME id, creates NO new row, no spawn
//                                  (the load-bearing "never two LIVE Leads" guard).
//   (2) existing EXITED-RESUMABLE Lead → startPlatformLead CREATES A NEW row (different id) + spawns a
//                                  FRESH session; the exited Lead is NOT resumed (stays exited).
//   (3) NONE                     → exactly ONE platform session is created; a re-open while LIVE reuses
//                                  it (same id, no new row); a re-open after STOP creates a NEW row.
//   (4) SCOPE GUARDRAIL          → startAuditor stays create-only (each call mints a fresh row) —
//                                  unchanged by this task.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-lead-singleton.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time; transcript.ts reads os.homedir()). ---
const tmpHome = path.join(os.tmpdir(), `loom-lead-singleton-${Date.now()}-${process.pid}`);
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
const repo = path.join(os.tmpdir(), `loom-lead-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# platform lead singleton test repo\n");
execSync(`git init -q && git add . && git -c user.email=ls@loom -c user.name=ls commit -q -m init`, { cwd: repo });

// Write a stub engine transcript so a given engine id is genuinely RESUMABLE (engineTranscriptExists
// resolves <home>/.claude/projects/<encodeProjectDir(cwd)>/<eng>.jsonl).
const writeTranscript = (cwd, eng) => {
  const dir = path.join(sandboxHome, ".claude", "projects", encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${eng}.jsonl`), `{"type":"user","message":{"content":"hi"}}\n`);
};

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
// One agent per scenario so each starts from a clean slate.
db.insertAgent({ id: "agentLive", projectId: "pHome", name: "LeadLive", startupPrompt: "LEAD", position: 0, profileId: null });
db.insertAgent({ id: "agentExited", projectId: "pHome", name: "LeadExited", startupPrompt: "LEAD", position: 1, profileId: null });
db.insertAgent({ id: "agentNone", projectId: "pHome", name: "LeadNone", startupPrompt: "LEAD", position: 2, profileId: null });
db.insertAgent({ id: "agentAud", projectId: "pHome", name: "Auditor", startupPrompt: "AUDIT", position: 3, profileId: null });

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

const platformRows = (agentId) => db.listSessions(agentId).filter((s) => s.role === "platform");

try {
  // ============================ (1) existing LIVE Lead → reuse, no new row ============================
  const liveSeed = "live-lead-seed";
  db.insertSession({
    id: liveSeed, projectId: "pHome", agentId: "agentLive", engineSessionId: "eng-live", title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "platform", parentSessionId: null,
  });
  const r1 = svc.startPlatformLead("agentLive");
  check("(1) live Lead → returns the SAME session id (no new row)", r1.id === liveSeed);
  check("(1) live Lead → still exactly ONE platform row", platformRows("agentLive").length === 1);
  check("(1) live Lead → NO new pty spawned (already attached)", host.spawned.length === 0);

  // === (1b) LIVE-PRECEDENCE — a live Lead + a MORE-RECENTLY-ACTIVE exited Lead → reuse the LIVE one ===
  // This is the duplicate-live-Lead failure: a recently-STOPPED Lead's frozen last_activity sorts AHEAD
  // of the idle-but-live Lead, so a naive "latest, then check liveness" would resume() the exited one
  // alongside the live one. Live-precedence must return the LIVE id with no new row + no resume spawn.
  const recentExited = "live-prec-recent-exited"; // last_activity AFTER the live seed → sorts first
  db.insertSession({
    id: recentExited, projectId: "pHome", agentId: "agentLive", engineSessionId: "eng-recent-exited", title: null,
    cwd: repo, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: new Date(Date.parse(now) + 60_000).toISOString(), lastError: null,
    role: "platform", parentSessionId: null,
  });
  writeTranscript(repo, "eng-recent-exited"); // make the exited one genuinely resumable — so ONLY live-precedence (not unresumability) keeps it from being resumed
  const spawnedBeforePrec = host.spawned.length;
  const r1b = svc.startPlatformLead("agentLive");
  check("(1b) live-precedence → returns the LIVE id even though an exited Lead is more recently active", r1b.id === liveSeed);
  check("(1b) live-precedence → NO resume/new spawn (the exited one was NOT resumed)", host.spawned.length === spawnedBeforePrec);
  check("(1b) live-precedence → the exited row stays exited (not resumed)", db.getSession(recentExited)?.processState === "exited");

  // ============== (2) existing EXITED-RESUMABLE Lead → manual Spawn CREATES A NEW row (not a resume) ==
  // The owner-reported bug: a manual Spawn used to RESUME the latest exited Lead. New contract: even when
  // the exited Lead is genuinely resumable, a manual Spawn must mint a FRESH session and leave the exited
  // one exited (on-demand resume is the explicit History "Resume" button instead).
  const exitedSeed = "exited-lead-seed";
  writeTranscript(repo, "eng-exited"); // genuinely resumable — so this is a sharp "resumable yet NOT resumed" test
  db.insertSession({
    id: exitedSeed, projectId: "pHome", agentId: "agentExited", engineSessionId: "eng-exited", title: null,
    cwd: repo, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "platform", parentSessionId: null,
  });
  const spawnedBefore = host.spawned.length;
  const r2 = svc.startPlatformLead("agentExited");
  check("(2) exited Lead → manual Spawn returns a NEW id (fresh session, not the exited one)", r2.id !== exitedSeed);
  check("(2) exited Lead → the new session is live", r2.processState === "live" && db.getSession(r2.id)?.processState === "live");
  check("(2) exited Lead → the exited one is NOT resumed (stays exited)", db.getSession(exitedSeed)?.processState === "exited");
  check("(2) exited Lead → now exactly TWO platform rows (the exited one + the fresh one)", platformRows("agentExited").length === 2);
  check("(2) exited Lead → FRESH spawn (no resumeId — a brand-new platform session)",
    host.spawned.length === spawnedBefore + 1 && host.spawned.at(-1).resumeId === undefined && host.spawned.at(-1).role === "platform");

  // ===================== (3) NONE → exactly one created; live re-open reuses, stop+re-open is fresh =====
  check("(3-pre) no platform row for the fresh agent", platformRows("agentNone").length === 0);
  const c1 = svc.startPlatformLead("agentNone");
  check("(3) none → exactly ONE platform row created", platformRows("agentNone").length === 1 && c1.processState === "live");
  // Make the freshly-created Lead resumable, then re-open while LIVE: reuse path — same id, still one row.
  db.setEngineSessionId(c1.id, "eng-fresh");
  writeTranscript(repo, "eng-fresh");
  const c2 = svc.startPlatformLead("agentNone"); // still live → reuse path (never two live)
  check("(3) re-open while live → SAME id, still ONE row (reuse, no new row)", c2.id === c1.id && platformRows("agentNone").length === 1);
  // Now stop it and re-open: new contract → a manual Spawn mints a FRESH row (does NOT resume the exited one).
  db.setProcessState(c1.id, "exited");
  const c3 = svc.startPlatformLead("agentNone");
  check("(3) re-open after stop → NEW id (fresh session, not a resume)", c3.id !== c1.id);
  check("(3) re-open after stop → now TWO platform rows; the exited one stays exited",
    platformRows("agentNone").length === 2 && db.getSession(c1.id)?.processState === "exited" && db.getSession(c3.id)?.processState === "live");

  // ============================ (4) SCOPE GUARDRAIL — Auditor stays create-only =======================
  const a1 = svc.startAuditor("agentAud");
  const a2 = svc.startAuditor("agentAud");
  const auditorRows = db.listSessions("agentAud").filter((s) => s.role === "auditor");
  check("(4) Auditor is NOT a singleton — two calls mint TWO distinct rows (each fire is ephemeral)",
    a1.id !== a2.id && auditorRows.length === 2);
} finally {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — startPlatformLead: live→reuse (never two LIVE Leads), exited→fresh new row (manual Spawn never resumes), none→create-one; the Auditor stays create-only."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
