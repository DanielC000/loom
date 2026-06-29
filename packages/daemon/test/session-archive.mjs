// Session Archive model test. Originally Task 13abd3ba (manual archive); REWRITTEN for card b37750a4,
// which makes archiving AUTOMATIC: a session auto-archives when its pty exits and auto-restores when it
// resumes (reusing the archived_at field — the live rail = archived_at IS NULL, Archive = NOT NULL).
// HERMETIC like dead-id.mjs / tasks-filter.mjs: no daemon, no real claude — drives the built Db +
// SessionService against a throwaway SQLite Db + isolated LOOM_HOME. Covers:
//   A. migration adds sessions.archived_at without disturbing rows (idempotent).
//   B. AUTO-ARCHIVE ON EXIT (mirrors index.ts onExit): an exited session gets archived_at set + leaves
//      the live lists (listSessions/listAllSessions/listWorkers) + appears in listArchivedSessions.
//      role==='run' is EXCLUDED. Recycled predecessors archive TOO (no hasSuccessor guard): the test
//      drives the REAL recycleWorker ordering (exit FIRST, successor inserted AFTER) → predecessor archived.
//   B2. CRASH-PATH BACKSTOP: recoverStaleSessions() returns the recovered rows; snapshotAndArchiveRecovered
//      (the real boot helper) snapshots + archives each non-'run' session (the only snapshot point on the
//      crash path); a 'run' session is recovered (exited) but not archived/snapshotted.
//   C. CLEAR ON RESUME: resume() clears archived_at + returns the session to the live rail; a FAST-FAILING
//      resume (clear-before-spawn) ends re-archived because the spawn's onExit wins.
//   D. snapshotTranscript copies the engine JSONL (idempotent), readArchivedTranscript renders it,
//      an already-dead session (no JSONL) snapshots nothing, deleteArchivedTranscript removes it.
//   E. restore brings one row back; permanent delete cascades to ARCHIVED workers + drops the snapshot.
//   F. the MANUAL archive surface is GONE: service.archiveSession() removed (no cascade) + the
//      POST /api/sessions/:id/archive route removed from the compiled gateway (restore + delete kept).
//   G. ONE-TIME archived_at BACKFILL (db.backfillArchivedAtOnce): sessions that exited BEFORE auto-archive
//      shipped (archived_at NULL) get stamped to their REAL end-time (COALESCE(last_activity, created_at),
//      NOT now()) so they appear in Archive in chronological order. process_state='exited' only ('none'
//      shell rows + role='run' excluded); already-archived rows preserved; marker-guarded one-shot (second
//      run is a no-op); a backfilled manager + worker assemble the tree (listArchivedSessions/Workers).
// Run: 1) build the daemon, 2) node test/session-archive.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-archive-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const Database = (await import("better-sqlite3")).default;
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { snapshotAndArchiveRecovered } = await import("../dist/sessions/boot-backstop.js");
const {
  encodeProjectDir, snapshotTranscript, readArchivedTranscript,
  archivedTranscriptPath, archivedTranscriptExists, deleteArchivedTranscript,
} = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(process.env.LOOM_HOME, "loom.db");
const now = new Date().toISOString();
const mkSession = (id, over = {}) => ({
  id, projectId: "pA", agentId: "aA", engineSessionId: null, title: null, cwd: "C:/tmp/loom-arch",
  processState: "exited", resumability: "resumable", busy: false,
  createdAt: now, lastActivity: now, lastError: null, ...over,
});

// Mirror of index.ts onExit's auto-archive (card b37750a4): mark exited, read the row ONCE, then
// archive UNLESS it's an ephemeral 'run' session (or a non-DB shell-terminal row). NO hasSuccessor
// guard — recycled predecessors archive too (the guard was ineffective on the recycleWorker ordering
// and inconsistent with "ALL stopped sessions in Archive"). Kept in lockstep with index.ts onExit.
const driveExit = (db, id) => {
  db.setProcessState(id, "exited");
  db.setBusy(id, false);
  const row = db.getSession(id);
  if (row && row.role !== "run") db.archiveSession(id);
};

// ── ~/.claude transcript fixtures (unique cwd → unique encoded dir). Shared by the resume test (C)
// (engineTranscriptExists must be true) and the snapshot tests (D). fakeCwd must exist on disk too —
// resume() guards on fs.existsSync(cwd). ──
const fakeCwd = path.join(os.tmpdir(), `loom-arch-cwd-${Date.now()}`);
const engineId = `arch-engine-${Date.now()}`;
const claudeDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(fakeCwd));
const claudeFile = path.join(claudeDir, `${engineId}.jsonl`);

try {
  // ════════ A. migration ════════
  let db = new Db(dbFile);
  db.insertProject({ id: "pA", name: "Arch", repoPath: "C:/tmp/loom-arch", vaultPath: "C:/tmp/loom-arch", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aA", projectId: "pA", name: "agentA", startupPrompt: "", position: 0 });
  db.insertSession(mkSession("sMig"));
  const colsAfterFresh = new Database(dbFile).pragma("table_info(sessions)").map((c) => c.name);
  check("A: fresh schema has sessions.archived_at", colsAfterFresh.includes("archived_at"));
  check("A: a new session archivedAt is null", db.getSession("sMig").archivedAt === null);
  db.close();

  // Simulate a LEGACY DB (column absent), then reopen → migrateSessions must ADD it back, row intact.
  const raw = new Database(dbFile);
  raw.exec("ALTER TABLE sessions DROP COLUMN archived_at");
  check("A: legacy DB lacks archived_at before migration",
    !raw.pragma("table_info(sessions)").map((c) => c.name).includes("archived_at"));
  raw.close();
  db = new Db(dbFile); // triggers migrateSessions
  check("A: migration re-added archived_at",
    new Database(dbFile).pragma("table_info(sessions)").map((c) => c.name).includes("archived_at"));
  check("A: migration preserved the existing row", !!db.getSession("sMig") && db.getSession("sMig").archivedAt === null);
  db.close();
  db = new Db(dbFile); // reopen again — migration is idempotent (no throw)
  check("A: migration is idempotent (second open ok)", !!db.getSession("sMig"));

  // A minimal PTY stub so resume() (section C) can spawn without a real claude. resume() calls pty.isAlive
  // (its already-live short-circuit) then pty.spawn; isAlive:false (these rows are stopped/archived, not
  // live) makes resume fall through to spawn. The other archive/restore/delete paths never touch the pty.
  // `_onSpawn`, when set, simulates a spawn firing onExit synchronously — used by the fast-failing-resume re-archive test.
  const ptyStub = { isAlive() { return false; }, spawn(opts) { if (ptyStub._onSpawn) ptyStub._onSpawn(opts); }, enqueueStdin() { return { delivered: false }; }, stop() {}, kill() {}, getPending() { return []; }, _onSpawn: null };
  const sessions = new SessionService(db, ptyStub, {});

  // Prepare the shared transcript fixture + a real cwd (used by C resume + D snapshot).
  fs.mkdirSync(fakeCwd, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(claudeFile,
    '{"type":"user","message":{"content":"hello"}}\n' +
    '{"type":"system","message":{"content":"ignored"}}\n' +
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hi there"}]}}\n');

  // ════════ B. AUTO-ARCHIVE ON EXIT + exclusion + recycled guard ════════
  db.insertSession(mkSession("exitMgr", { role: "manager", processState: "live" }));
  db.insertSession(mkSession("exitW1", { role: "worker", parentSessionId: "exitMgr", taskId: "t1", branch: "loom/w1", processState: "live" }));
  db.insertSession(mkSession("plain", { processState: "live" })); // unrelated session that stays live

  check("B: pre-exit, the live session is on the rail (archived_at NULL)",
    db.getSession("exitW1").archivedAt === null && db.listAllSessions().some((s) => s.id === "exitW1"));

  // Each session auto-archives independently as its pty exits (per-session, no cascade).
  driveExit(db, "exitW1");
  check("B: exited session gets archived_at set automatically",
    typeof db.getSession("exitW1").archivedAt === "string" && db.getSession("exitW1").processState === "exited");
  check("B: archived session EXCLUDED from listAllSessions (left the live rail)",
    db.listAllSessions().every((s) => s.id !== "exitW1"));
  check("B: archived session EXCLUDED from listSessions(agent)",
    db.listSessions("aA").every((s) => s.id !== "exitW1"));
  check("B: archived worker EXCLUDED from listWorkers(manager)",
    db.listWorkers("exitMgr").every((w) => w.id !== "exitW1"));
  const arch = db.listArchivedSessions("pA");
  check("B: exited session APPEARS in listArchivedSessions (with agent name + archivedAt)",
    arch.some((s) => s.id === "exitW1" && s.agentName === "agentA" && !!s.archivedAt));
  check("B: the still-live 'plain' session stays on the rail", db.listAllSessions().some((s) => s.id === "plain"));

  // RUN-role EXCLUSION: an ephemeral Agent Run session (finalized + GC'd via onRunSessionExit) must
  // NOT be auto-archived on exit — it would clutter the project Archive tab.
  db.insertSession(mkSession("runSess", { role: "run", processState: "live" }));
  driveExit(db, "runSess");
  check("B: a 'run' session is NOT auto-archived on exit (archived_at stays NULL)",
    db.getSession("runSess").archivedAt === null && db.getSession("runSess").processState === "exited");

  // RECYCLED-PREDECESSOR ordering (the guard is GONE): recycleWorker pty.stop()s + AWAITS the old
  // worker's death (→ its onExit, which auto-archives) BEFORE inserting the successor row. So at the
  // predecessor's exit there is NO successor yet → it archives. Drive that REAL ordering (exit FIRST,
  // THEN insert the successor) and assert the predecessor IS archived — and is still addressable via
  // the UNFILTERED getSession (lineage/resume(allowSuperseded) never need it on the rail).
  db.insertSession(mkSession("recOld", { processState: "live" }));
  driveExit(db, "recOld"); // predecessor exits BEFORE the successor exists (recycleWorker order)
  check("B: at the predecessor's exit there is no successor yet", db.hasSuccessor("recOld") === false);
  check("B: recycled predecessor IS auto-archived on exit (guard removed)",
    typeof db.getSession("recOld").archivedAt === "string");
  db.insertSession(mkSession("recNew", { processState: "live", recycledFrom: "recOld" })); // successor lands after
  check("B: the now-superseded predecessor stays addressable via unfiltered getSession",
    !!db.getSession("recOld") && db.hasSuccessor("recOld") === true);
  check("B: archived predecessor is excluded from the live rail", db.listAllSessions().every((s) => s.id !== "recOld"));

  // ════════ B2. CRASH-PATH BACKSTOP (recoverStaleSessions → snapshotAndArchiveRecovered) ════════
  // A daemon crash fires no onExit, so recoverStaleSessions() blanket-marks live/starting → exited and
  // the boot helper snapshots + archives each (the REAL index.ts boot path, invoked here). A live
  // session with a resumable engine transcript must come back archived WITH a snapshot; a 'run' session
  // is recovered (exited) but NOT archived/snapshotted.
  db.insertSession(mkSession("crashSess", { engineSessionId: engineId, cwd: fakeCwd, processState: "live" }));
  db.insertSession(mkSession("crashRun", { role: "run", engineSessionId: engineId, cwd: fakeCwd, processState: "live" }));
  const recovered = db.recoverStaleSessions();
  check("B2: recoverStaleSessions returns the recovered rows (incl. crashSess + crashRun)",
    recovered.some((s) => s.id === "crashSess") && recovered.some((s) => s.id === "crashRun"));
  check("B2: recoverStaleSessions flips them to exited", db.getSession("crashSess").processState === "exited");
  snapshotAndArchiveRecovered(db, recovered);
  check("B2: a crash-recovered session is auto-archived (archived_at set)",
    typeof db.getSession("crashSess").archivedAt === "string" && db.listArchivedSessions("pA").some((s) => s.id === "crashSess"));
  check("B2: its transcript was snapshotted on the crash path", archivedTranscriptExists("pA", "crashSess"));
  check("B2: a 'run' session is recovered (exited) but NOT archived",
    db.getSession("crashRun").processState === "exited" && db.getSession("crashRun").archivedAt === null);
  check("B2: a 'run' session is NOT snapshotted on the crash path", !archivedTranscriptExists("pA", "crashRun"));
  deleteArchivedTranscript("pA", "crashSess"); // clean the snapshot so section D/E ids stay independent

  // ════════ C. CLEAR ON RESUME ════════
  // An archived (stopped) session with a resumable engine transcript returns to the rail on resume,
  // with archived_at cleared. Reuse the shared fixture (engineId @ fakeCwd) so the resumability guards pass.
  db.insertSession(mkSession("resSess", { engineSessionId: engineId, cwd: fakeCwd }));
  db.archiveSession("resSess"); // it's currently stopped/archived
  check("C: resSess starts archived (off the rail)",
    !!db.getSession("resSess").archivedAt && db.listArchivedSessions("pA").some((s) => s.id === "resSess"));
  const resumed = sessions.resume("resSess");
  check("C: resume() returns the session live", resumed.processState === "live");
  check("C: resume CLEARED archived_at", db.getSession("resSess").archivedAt === null);
  check("C: resumed session is BACK on the live rail",
    db.listAllSessions().some((s) => s.id === "resSess") && db.listSessions("aA").some((s) => s.id === "resSess"));
  check("C: resumed session no longer in listArchivedSessions",
    db.listArchivedSessions("pA").every((s) => s.id !== "resSess"));

  // FAST-FAILING RESUME re-archives: resume() clears archived_at BEFORE pty.spawn, so if the spawn
  // immediately fails (its onExit fires), the onExit auto-archive WINS — the session ends archived, not
  // wrongly un-archived. Simulate by having the stub spawn fire the onExit logic (driveExit) synchronously.
  db.insertSession(mkSession("failSess", { engineSessionId: engineId, cwd: fakeCwd }));
  db.archiveSession("failSess");
  ptyStub._onSpawn = (opts) => driveExit(db, opts.sessionId); // spawn fast-fails → onExit
  try { sessions.resume("failSess"); } finally { ptyStub._onSpawn = null; }
  check("C: a fast-failing resume ends EXITED (onExit won)", db.getSession("failSess").processState === "exited");
  check("C: a fast-failing resume ends RE-ARCHIVED (clear-before-spawn ordering holds)",
    typeof db.getSession("failSess").archivedAt === "string" && db.listAllSessions().every((s) => s.id !== "failSess"));

  // ════════ D. snapshot helpers ════════
  const okSnap = snapshotTranscript(fakeCwd, engineId, "pA", "snapSess");
  check("D: snapshotTranscript returns true when the JSONL exists", okSnap === true);
  check("D: snapshot file written under LOOM_HOME/archives", fs.existsSync(archivedTranscriptPath("pA", "snapSess")));
  check("D: archivedTranscriptExists(pA, snapSess) is true", archivedTranscriptExists("pA", "snapSess"));
  const turns = readArchivedTranscript("pA", "snapSess");
  check("D: readArchivedTranscript parses 2 turns (system line skipped)",
    turns.length === 2 && turns[0].role === "user" && turns[0].text === "hello" && turns[1].role === "assistant" && turns[1].text === "hi there");
  check("D: snapshot is idempotent (re-snapshot still true)", snapshotTranscript(fakeCwd, engineId, "pA", "snapSess") === true);
  check("D: already-dead session (no JSONL) snapshots nothing",
    snapshotTranscript(fakeCwd, "no-such-engine-id", "pA", "deadSess") === false && !archivedTranscriptExists("pA", "deadSess"));
  deleteArchivedTranscript("pA", "snapSess");
  check("D: deleteArchivedTranscript removes the snapshot", !archivedTranscriptExists("pA", "snapSess"));

  // ════════ E. restore + permanent delete (cascade to ARCHIVED workers, snapshot dropped) ════════
  // Build a stopped (auto-archived) manager + 2 workers, give mgr + w2 real snapshots so delete proves
  // it removes them, then exercise restore (single row) + cascade delete.
  db.insertSession(mkSession("mgr", { role: "manager" }));
  db.insertSession(mkSession("w1", { role: "worker", parentSessionId: "mgr", taskId: "t1", branch: "loom/w1" }));
  db.insertSession(mkSession("w2", { role: "worker", parentSessionId: "mgr", taskId: "t2", branch: "loom/w2" }));
  for (const id of ["mgr", "w1", "w2"]) db.archiveSession(id); // each auto-archived on its own exit
  snapshotTranscript(fakeCwd, engineId, "pA", "mgr");
  snapshotTranscript(fakeCwd, engineId, "pA", "w2");
  check("E: seeded archived group + snapshots for mgr + w2",
    db.listArchivedSessions("pA").filter((s) => ["mgr", "w1", "w2"].includes(s.id)).length === 3 &&
    archivedTranscriptExists("pA", "mgr") && archivedTranscriptExists("pA", "w2"));

  sessions.restoreSession("w1");
  check("E: restore brings w1 back to the rail", db.getSession("w1").archivedAt === null && db.listWorkers("mgr").some((w) => w.id === "w1"));

  let notArchived = false;
  try { sessions.deleteArchivedSession("w1"); } catch (e) { notArchived = /only an archived session/.test(e.message); }
  check("E: deleting a non-archived session is refused", notArchived);

  const delRes = sessions.deleteArchivedSession("mgr");
  check("E: delete cascades to ARCHIVED workers only (mgr + w2, not the restored w1)",
    delRes.deleted.includes("mgr") && delRes.deleted.includes("w2") && !delRes.deleted.includes("w1") && delRes.deleted.length === 2);
  check("E: deleted rows are gone", !db.getSession("mgr") && !db.getSession("w2"));
  check("E: restored w1 row survives the manager delete", !!db.getSession("w1"));
  check("E: deleted snapshots removed", !archivedTranscriptExists("pA", "mgr") && !archivedTranscriptExists("pA", "w2"));

  // ════════ F. manual archive surface removed ════════
  check("F: service.archiveSession() is gone (no manual archive / cascade)", typeof sessions.archiveSession === "undefined");
  const gatewaySrc = fs.readFileSync(new URL("../dist/gateway/server.js", import.meta.url), "utf8");
  check("F: POST /api/sessions/:id/archive route removed from the compiled gateway",
    !gatewaySrc.includes('app.post("/api/sessions/:id/archive"') && !gatewaySrc.includes("sessions.archiveSession("));
  check("F: restore route kept", gatewaySrc.includes('app.post("/api/sessions/:id/restore"'));
  check("F: delete-archived route kept", gatewaySrc.includes('app.delete("/api/sessions/:id/archive"'));

  // ════════ G. ONE-TIME archived_at BACKFILL (db.backfillArchivedAtOnce) ════════
  // Sessions that EXITED before auto-archive-on-exit shipped never got archived_at stamped → invisible in
  // BOTH the live rail (exited) and the Archive tab (filters NOT NULL). The one-shot boot migration stamps
  // archived_at = COALESCE(last_activity, created_at) (each row's REAL end-time, NOT now() — so Archive's
  // archived_at DESC keeps chronological order). Predicate: process_state='exited' ('none' shell rows and
  // role='run' excluded); already-archived rows untouched. Marker-guarded (fires exactly once).
  const la = (iso) => ({ lastActivity: iso, createdAt: iso }); // a distinct, real end-time
  // (a) pre-feature exited NON-run plain session — archived_at NULL, a distinct real last_activity.
  db.insertSession(mkSession("bfPlain", { ...la("2025-03-03T03:03:03.000Z") }));
  // (b) role='run' exited session — must STAY NULL (ephemeral; never clutters Archive).
  db.insertSession(mkSession("bfRun", { role: "run", ...la("2025-03-04T04:04:04.000Z") }));
  // (c) a LIVE session — must STAY NULL (not a stopped session).
  db.insertSession(mkSession("bfLive", { processState: "live", ...la("2025-03-05T05:05:05.000Z") }));
  // (d) an ALREADY-archived exited session — its original archived_at must be PRESERVED, not overwritten.
  db.insertSession(mkSession("bfAlready", { ...la("2025-03-06T06:06:06.000Z") }));
  db.archiveSession("bfAlready");
  const bfAlreadyOrig = db.getSession("bfAlready").archivedAt;
  // a pre-feature exited MANAGER + its exited WORKER (distinct end-times) — the tree must assemble.
  db.insertSession(mkSession("bfMgr", { role: "manager", ...la("2025-03-07T07:07:07.000Z") }));
  db.insertSession(mkSession("bfWorker", { role: "worker", parentSessionId: "bfMgr", taskId: "tBF", branch: "loom/bf", ...la("2025-03-08T08:08:08.000Z") }));

  check("G: pre-feature rows start with archived_at NULL (invisible in Archive)",
    db.getSession("bfPlain").archivedAt === null && db.getSession("bfMgr").archivedAt === null &&
    db.getSession("bfWorker").archivedAt === null && db.listArchivedSessions("pA").every((s) => s.id === "bfAlready" || !["bfPlain", "bfMgr", "bfWorker"].includes(s.id)));
  check("G: marker is unset before the backfill runs", db.getMeta("archived_at_backfill_done") === undefined);

  const stamped = db.backfillArchivedAtOnce();
  check("G: backfill reports it stamped at least the seeded pre-feature rows (bfPlain+bfMgr+bfWorker)", stamped >= 3);
  // (a) stamped to its REAL end-time (last_activity), NOT now() → chronological ordering preserved.
  check("G(a): pre-feature exited session stamped archived_at === its last_activity",
    db.getSession("bfPlain").archivedAt === "2025-03-03T03:03:03.000Z");
  // (b) run-role stays NULL.
  check("G(b): a 'run' session is NOT backfilled (archived_at stays NULL)", db.getSession("bfRun").archivedAt === null);
  // (c) live stays NULL.
  check("G(c): a live session is NOT backfilled (archived_at stays NULL)", db.getSession("bfLive").archivedAt === null);
  // (d) already-archived is untouched.
  check("G(d): an already-archived session keeps its ORIGINAL archived_at (not overwritten)",
    db.getSession("bfAlready").archivedAt === bfAlreadyOrig && typeof bfAlreadyOrig === "string");
  check("G: marker is set after the backfill", typeof db.getMeta("archived_at_backfill_done") === "string");

  // The backfilled manager + worker both surface, and the tree assembles (listArchivedSessions feeds the
  // top level; listArchivedWorkers(mgr) nests the worker) — no web change needed.
  const bfArch = db.listArchivedSessions("pA");
  check("G: backfilled manager APPEARS in listArchivedSessions",
    bfArch.some((s) => s.id === "bfMgr" && s.archivedAt === "2025-03-07T07:07:07.000Z"));
  check("G: backfilled worker APPEARS in listArchivedSessions",
    bfArch.some((s) => s.id === "bfWorker" && s.archivedAt === "2025-03-08T08:08:08.000Z"));
  check("G: backfilled worker nests under its manager via listArchivedWorkers (tree assembles)",
    db.listArchivedWorkers("bfMgr").some((w) => w.id === "bfWorker"));

  // SECOND invocation is a clean no-op (marker guard). Seed a fresh pre-feature exited row AFTER the first
  // run; the second call must NOT touch it (returns 0) — proving fire-exactly-once.
  db.insertSession(mkSession("bfLate", { ...la("2025-03-09T09:09:09.000Z") }));
  const stamped2 = db.backfillArchivedAtOnce();
  check("G: second backfill is a clean no-op (returns 0)", stamped2 === 0);
  check("G: second backfill left the post-marker row untouched (archived_at still NULL)", db.getSession("bfLate").archivedAt === null);
} finally {
  try { fs.rmSync(claudeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(fakeCwd, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — auto-archive on exit (run-excluded; recycled predecessors archive too); crash-path backstop snapshots + archives recovered sessions; resume clears archived_at + restores to the rail (fast-fail re-archives); snapshots copy/render/delete; restore + cascade delete work; the manual archive endpoint + cascade are gone; the one-time archived_at backfill stamps pre-feature exited sessions to their real end-time (run/live/already-archived untouched), marker-guarded one-shot, tree assembles."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
