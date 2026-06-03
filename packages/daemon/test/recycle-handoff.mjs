// Recycle-handoff test: queued messages + scheduled wakes must move to the SUCCESSOR, and a recycled
// session must never be resumable again (else a due wake / rate-limit / boot-resume zombie-resurrects
// it alongside its successor — the 2026-06-03 incident). NO claude: exercises the new db primitives
// (reparentWakes, hasSuccessor) directly, and SessionService.resume()'s superseded guard with a stub
// pty + a hermetic fake engine transcript (unique id, cleaned up). The full recycle queue/wake
// transfer wiring (getPending→enqueueStdin) is integration-covered by recycle.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const dbFile = path.join(os.tmpdir(), `loom-rh-${sfx}.db`);
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = `rh-proj-${sfx}`, topicId = `rh-top-${sfx}`;
const OLD = `rh-old-${sfx}`, NEW = `rh-new-${sfx}`, OTHER = `rh-other-${sfx}`;
const engOld = `eng-old-${sfx}`, engOther = `eng-other-${sfx}`;

// Fake engine transcripts so resume() passes its dead-id check and reaches the successor guard.
const fakeProjDir = path.join(os.homedir(), ".claude", "projects", `loom-rh-${sfx}`);
fs.mkdirSync(fakeProjDir, { recursive: true });
for (const eng of [engOld, engOther]) fs.writeFileSync(path.join(fakeProjDir, `${eng}.jsonl`), '{"type":"x"}\n');

const mkSession = (id, eng, extra = {}) => ({
  id, projectId: projId, topicId, engineSessionId: eng, title: null, cwd: projId,
  processState: "exited", resumability: "resumable", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager", ...extra,
});

try {
  db.insertProject({ id: projId, name: "RH", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertTopic({ id: topicId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession(mkSession(OLD, engOld));
  db.insertSession(mkSession(NEW, "eng-new", { recycledFrom: OLD, gen: 1 })); // the successor
  db.insertSession(mkSession(OTHER, engOther)); // an unrelated, never-recycled session

  // --- (1) reparentWakes moves the queue of scheduled nudges to the successor ---
  for (let i = 0; i < 3; i++) db.insertWake({ id: `wk-${i}-${sfx}`, sessionId: OLD, wakeAt: new Date(Date.now() + 60000 + i).toISOString(), note: `n${i}`, createdAt: now });
  check("(1-pre) old session has 3 pending wakes", db.countPendingWakes(OLD) === 3);
  const moved = db.reparentWakes(OLD, NEW);
  check("(1) reparentWakes reports 3 moved", moved === 3);
  check("(1) old session now has 0 wakes (nothing left to fire at the zombie)", db.countPendingWakes(OLD) === 0);
  check("(1) successor inherited all 3 wakes", db.countPendingWakes(NEW) === 3);
  check("(1) the moved wake notes survive (still scheduled)", db.listWakesForSession(NEW).map((w) => w.note).sort().join() === "n0,n1,n2");

  // --- (2) hasSuccessor: true once recycled, false otherwise ---
  check("(2) hasSuccessor(old) is TRUE (a successor points back at it)", db.hasSuccessor(OLD) === true);
  check("(2) hasSuccessor(successor) is FALSE", db.hasSuccessor(NEW) === false);
  check("(2) hasSuccessor(unrelated) is FALSE", db.hasSuccessor(OTHER) === false);

  // --- (3) resume() refuses a recycled (superseded) session, from any path; a normal one passes the guard ---
  const spawned = [];
  const pty = { spawn: (o) => spawned.push(o.sessionId) }; // stub: resume only reaches it past the guard
  const sessions = new SessionService(db, pty, {});

  let threw = false, msg = "";
  try { sessions.resume(OLD); } catch (e) { threw = true; msg = e.message; }
  check("(3) resume(recycled) THROWS", threw);
  check("(3) the refusal cites the successor (not a generic error)", /successor/i.test(msg));
  check("(3) resume(recycled) did NOT spawn a pty (no zombie)", !spawned.includes(OLD));

  // a non-recycled session with a live transcript sails past the guard (reaches the stub spawn).
  const okSession = sessions.resume(OTHER);
  check("(3) resume(non-recycled) succeeds past the guard", okSession.processState === "live" && spawned.includes(OTHER));
} finally {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(fakeProjDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recycle moves scheduled wakes to the successor (none left to fire at the retired session), and a recycled session is refused by resume() from every path (no zombie resurrection)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
