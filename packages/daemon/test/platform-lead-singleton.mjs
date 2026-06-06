import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform Lead SINGLETON (P1 bug fix) — startPlatformLead must be RESUME-OR-CREATE, not the old
// unconditional create-only (which minted a fresh session row on every "open the Lead" / re-open and
// accumulated duplicate — even duplicate LIVE — Lead sessions). DETERMINISTIC + CLAUDE-FREE +
// NETWORK-FREE, hermetic like platform-mgmt-surface.mjs: a REAL Db + SessionService driven against a
// FAKE pty (createPty/stop seam). A real temp git repo backs the spawn cwd; the only thing faked is
// the claude pty. A real (stub) transcript file is written under the sandboxed HOME so the exited Lead
// is genuinely resumable (engineTranscriptExists passes).
//
// Proves the DoD:
//   (1) existing LIVE Lead       → startPlatformLead returns the SAME id, creates NO new row.
//   (2) existing EXITED-RESUMABLE Lead → it is RESUMED (back to live), SAME id, NO new row.
//   (3) NONE                     → exactly ONE platform session is created; repeated calls are
//                                  idempotent (return that same id, still no new row).
//   (4) SCOPE GUARDRAIL          → startAuditor stays create-only (each call mints a fresh row) —
//                                  the singleton is the Lead's alone.
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

  // ============================ (2) existing EXITED-RESUMABLE Lead → resume, no new row ===============
  const exitedSeed = "exited-lead-seed";
  writeTranscript(repo, "eng-exited"); // make it genuinely resumable
  db.insertSession({
    id: exitedSeed, projectId: "pHome", agentId: "agentExited", engineSessionId: "eng-exited", title: null,
    cwd: repo, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "platform", parentSessionId: null,
  });
  const spawnedBefore = host.spawned.length;
  const r2 = svc.startPlatformLead("agentExited");
  check("(2) exited-resumable Lead → returns the SAME id (no new row)", r2.id === exitedSeed);
  check("(2) exited-resumable Lead → brought back to live", r2.processState === "live" && db.getSession(exitedSeed)?.processState === "live");
  check("(2) exited-resumable Lead → still exactly ONE platform row", platformRows("agentExited").length === 1);
  check("(2) exited-resumable Lead → RESUMED via the pty (one resume spawn, with resumeId)",
    host.spawned.length === spawnedBefore + 1 && host.spawned.at(-1).resumeId === "eng-exited" && host.spawned.at(-1).role === "platform");

  // ============================ (3) NONE → exactly one created; idempotent =============================
  check("(3-pre) no platform row for the fresh agent", platformRows("agentNone").length === 0);
  const c1 = svc.startPlatformLead("agentNone");
  check("(3) none → exactly ONE platform row created", platformRows("agentNone").length === 1 && c1.processState === "live");
  // Make the freshly-created Lead resumable, then re-open: idempotent — same id, still one row.
  db.setEngineSessionId(c1.id, "eng-fresh");
  writeTranscript(repo, "eng-fresh");
  const c2 = svc.startPlatformLead("agentNone"); // still live → reuse path
  check("(3) idempotent re-open (live) → SAME id, still ONE row", c2.id === c1.id && platformRows("agentNone").length === 1);
  // Now exit it and re-open: resume path → still the same single row.
  db.setProcessState(c1.id, "exited");
  const c3 = svc.startPlatformLead("agentNone");
  check("(3) idempotent re-open after stop (resume) → SAME id, still ONE row",
    c3.id === c1.id && platformRows("agentNone").length === 1 && db.getSession(c1.id)?.processState === "live");

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
  ? "\n✅ ALL PASS — startPlatformLead is a singleton: live→reuse, exited-resumable→resume, none→create-one, idempotent; the Auditor stays create-only."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
