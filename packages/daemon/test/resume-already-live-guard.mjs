import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// resume() already-LIVE short-circuit guard (sessions Code-Reviewer audit, latent orphan-pty).
// host.spawn() does this.live.set(sessionId, live) and OVERWRITES any existing live entry WITHOUT
// .kill()-ing the prior pty — so a resume() of an already-live session would orphan the running
// node-pty (leaked process, no onExit). All AUTOMATIC callers pre-check liveness today, so it's
// latent; this proves the structural backstop inside resume() itself: an already-live resume is a
// no-op that re-spawns NOTHING, while a genuinely exited session still resumes (spawns) normally.
//
// NO claude, NO live daemon: drives SessionService.resume() directly against an isolated LOOM_HOME
// with a claude-free fake pty whose isAlive is the controllable source of truth and whose spawn()
// just COUNTS calls. The exited case needs the resume preconditions to pass, so we materialize a real
// cwd dir + a real engine transcript file at the computed path (engineTranscriptExists scans for it).
//
// Run: 1) build daemon, 2) node test/resume-already-live-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ralg-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// A real cwd the resume preconditions can stat, + a real engine transcript file so engineTranscriptExists
// (and the worktree/cwd-missing guard) both pass on the exited path. The already-live path short-circuits
// BEFORE either check, so these only matter for the exited case.
const cwd = path.join(os.tmpdir(), `loom-ralg-cwd-${sfx}`);
fs.mkdirSync(cwd, { recursive: true });

// Claude-free pty: isAlive is the controllable source of truth; spawn just records each call so we can
// assert "re-spawned NOTHING" vs "spawned once". (resume() touches only pty.isAlive + pty.spawn.)
class FakePty {
  constructor() { this.alive = new Set(); this.spawns = []; }
  isAlive(id) { return this.alive.has(id); }
  spawn(opts) { this.spawns.push(opts); this.alive.add(opts.sessionId); }
}

const db = new Db();
const pty = new FakePty();
const sessions = new SessionService(db, pty, new OrchestrationControl());

const projId = `ralg-P-${sfx}`;
const agentId = `ralg-ag-${sfx}`;
db.insertProject({ id: projId, name: projId, repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });

function mkSession(id) {
  const engineSessionId = `eng-${id}`;
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId,
    title: null, cwd, processState: "live", resumability: "resumable",
    busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
  });
  // Materialize the engine transcript at the computed path so resume's preconditions pass.
  const tp = engineTranscriptPath(cwd, engineSessionId);
  fs.mkdirSync(path.dirname(tp), { recursive: true });
  fs.writeFileSync(tp, '{"role":"user"}\n');
  return engineSessionId;
}

try {
  // CASE 1 — resume() of an ALREADY-LIVE session is a no-op: returns the current row, spawns NOTHING.
  {
    const id = `ralg-live-${sfx}`;
    mkSession(id);
    pty.alive.add(id); // pty is alive (a real session running)
    const before = pty.spawns.length;
    const ret = sessions.resume(id);
    check("(1) already-live resume re-spawned NOTHING (no second pty, no live-map overwrite)", pty.spawns.length === before);
    check("(1) already-live resume returned the current session row", ret && ret.id === id);
  }

  // CASE 2 — resume() of a genuinely EXITED (not-live) session still resumes: spawns exactly once.
  {
    const id = `ralg-exited-${sfx}`;
    mkSession(id);
    db.setProcessState(id, "exited"); // it died; pty is NOT in the live set
    const before = pty.spawns.length;
    const ret = sessions.resume(id);
    check("(2) exited resume still spawns exactly one pty (no regression)", pty.spawns.length === before + 1);
    check("(2) the spawn targets the resumed session", pty.spawns[pty.spawns.length - 1].sessionId === id);
    check("(2) the spawn is a resume (carries resumeId), not a fresh start", !!pty.spawns[pty.spawns.length - 1].resumeId);
    check("(2) exited resume returns the live session", ret && ret.id === id && ret.processState === "live");
  }
} finally {
  db.close();
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resume() short-circuits an already-live session (no double-spawn, no orphaned pty) while a genuinely exited session still resumes normally."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
