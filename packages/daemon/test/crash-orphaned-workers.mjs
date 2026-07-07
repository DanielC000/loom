import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Crash-orphaned worker recovery test (card 9fc41af5). NO claude, NO live daemon, NO process.exit —
// drives deriveCrashOrphanedWorkers + SessionService.recoverCrashOrphanedWorkers directly, plus the
// FULL boot ORDER index.ts now runs (recoverStaleSessions -> derive -> archive-backstop -> protect ->
// reconcile-GC -> resume), against an isolated LOOM_HOME + real git repos + real engine transcripts.
//
// A genuine daemon CRASH (no restart-intent) used to strand a manager's in-flight workers: they came
// back `exited` + auto-archived with no recovery path, so worker_list went empty and the manager had to
// re-dispatch fresh, losing in-context reasoning. This proves the fix:
//   (1) DERIVE — deriveCrashOrphanedWorkers, over a `recovered` snapshot shaped like recoverStaleSessions'
//       return value, recovers exactly the crash-shaped candidate (exited+resumable+parented+task
//       in_progress) and excludes: archived pre-crash, recycled (has a successor), and a task already on
//       the terminal lane (done/merged).
//   (2) DONE-BUT-UNMERGED — a worker that reported `done` but whose task hasn't landed IS still
//       recovered (reportedDone:true) — recovery ADDS worktree protection + worker_list visibility even
//       though worker_merge/worker_merge_confirm can already merge a dead/archived worker's branch
//       directly (they never check session liveness/archivedAt — only Pass B's worktreeHasWork
//       branch-ahead guard, independent of session state, is what actually keeps the worktree on disk
//       either way).
//   (3) ORDERING — a recovered worker survives BOTH the boot-backstop auto-archive (snapshotAndArchive
//       Recovered runs on every recovered row) AND Pass B worktree-GC (via protectedSessionIds, derived
//       from the SAME pre-archive snapshot), then reappears in its manager's worker_list (archived_at
//       IS NULL) after recoverCrashOrphanedWorkers resumes it for real (a real engine transcript +
//       spawn-stub pty, mirroring session-archive.mjs's resume test) — and an UNPROTECTED control
//       worker's clean worktree IS reclaimed by the same Pass B pass, proving protection (not luck)
//       saved the real one.
//   (4) MANAGER-UNRESUMABLE — when the manager itself can't be resumed, its candidate workers are left
//       untouched (still exited + archived, not half-resumed into an orphan) and counted in `failed`.
//   (5) RATE-LIMIT PARK — a parked (usage-limit) worker or manager is resumed live (so the rate-limit
//       watcher can recover it on its own schedule) but gets NO nudge — mirrors resumeFleetOnBoot's
//       isParked/skippedParked handling; a crash must never force a held turn back into a usage cap.
//   (6) MANAGER-ALL-FAILED — a manager whose EVERY candidate worker individually fails to resume still
//       gets a summary nudge (it was already silently resumed with no other signal a crash happened).
//   (7) STALE reportedDone — a worker_report(done) event superseded by a LATER merge_rejected (the
//       manager sent it back to fix a failed gate/conflict) is NOT treated as reportedDone, so it still
//       gets the continue-your-task nudge instead of being silently parked as "awaiting review".
//   (8) STALE-DEAD-FLAG RACE (the inconsistently-partial-recovery bug): a worker whose `resumability`
//       column was already stamped 'dead' BEFORE this crash — e.g. by liveness.ts's debounced
//       chokidar watcher misreading a transient TOCTOU gap on an UNRELATED session's transcript rewrite
//       during normal operation — but whose OWN transcript is genuinely still on disk right now, IS
//       recovered (the stale flag is re-verified live, not trusted) and its stamp is healed back to
//       'resumable'. A worker whose transcript is ACTUALLY gone right now is still correctly excluded,
//       with the exclusion logged (never silent).
//   (9) SOLO MANAGER — a manager whose entire worker set is legitimately excluded (e.g. every worker's
//       task already landed) has no entry in the derived worker candidates at all, yet it was just as
//       much a live/starting victim of the crash as any manager that kept a worker — it still gets ONE
//       independent resume attempt (deriveCrashOrphanedManagers + recoverCrashOrphanedWorkers's
//       `soloManagerIds`), with a plain nudge (not the "0 of your 0 in-flight worker(s)" phrasing a
//       naive reuse of the per-worker summary would produce). And when a resume attempt genuinely
//       fails (engine id set, transcript genuinely missing — 9b), the real thrown reason is logged
//       (not silently swallowed into a bare boolean). deriveCrashOrphanedManagers mirrors the WORKER
//       path's own guards exactly: a manager already archived pre-crash (9c), superseded by a recycle
//       successor (9d), or never having captured an engine id at all (9e, structurally unresumable —
//       excluded up front rather than attempted-and-failed) is never resurrected. A `platform`-role
//       solo session is derived + attempted identically to `manager` (9f), and a PARKED solo manager is
//       resumed live but withheld its summary nudge, honoring the usage hold (9g).
// Run: 1) build daemon, 2) node test/crash-orphaned-workers.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-cow-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { deriveCrashOrphanedWorkers, deriveCrashOrphanedManagers } = await import("../dist/orchestration/crash-orphaned-workers.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { snapshotAndArchiveRecovered } = await import("../dist/sessions/boot-backstop.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

// Capture console.log/warn (the exclusion + resume-failure reasons are logged, never silent) — restore
// the real functions in `finally` so genuine test output still shows.
const logs = [];
const warns = [];
const realLog = console.log;
const realWarn = console.warn;
console.log = (...a) => { logs.push(a.join(" ")); realLog(...a); };
console.warn = (...a) => { warns.push(a.join(" ")); realWarn(...a); };

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=cow@loom -c user.name=cow";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Claude-free pty stub with a real (no-op) spawn — so a REAL sessions.resume() (not a stubbed resumeOne)
// can run to completion, exactly like session-archive.mjs's C section. isAlive tracks a set we flip
// after `spawn` so a resumed session's subsequent isAlive() reads true (mirrors the real PtyHost).
class PtyStub {
  constructor() { this.q = new Map(); this.spawns = []; this.aliveIds = new Set(); }
  isAlive(id) { return this.aliveIds.has(id); }
  spawn(opts) { this.spawns.push(opts); this.aliveIds.add(opts.sessionId); }
  enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
  getPending(id) { return [...(this.q.get(id) ?? [])]; }
}

const db = new Db();
const pty = new PtyStub();
const sessions = new SessionService(db, pty, new OrchestrationControl());

const mkProject = (id, repo) => db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
const mkAgent = (id, projId) => db.insertAgent({ id, projectId: projId, name: "t", startupPrompt: "", position: 0 });
const mkTask = (id, projId, columnKey) => { db.insertTask({ id, projectId: projId, title: id, body: "", columnKey: columnKey ?? "in_progress", position: 1, createdAt: now, updatedAt: now }); return id; };
function mkSession(o) {
  db.insertSession({
    id: o.id, projectId: o.projId, agentId: o.agentId, engineSessionId: o.engineSessionId ?? `eng-${o.id}`,
    title: null, cwd: o.cwd ?? os.tmpdir(), processState: o.processState ?? "live", resumability: o.resumability ?? "resumable",
    busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: o.role ?? null, parentSessionId: o.parentSessionId ?? null,
    taskId: o.taskId ?? null, worktreePath: o.worktreePath ?? null, branch: o.branch ?? null,
  });
  if (o.recycledFrom) db.setOrchestration(o.id, { recycledFrom: o.recycledFrom });
  if (o.archived) db.archiveSession(o.id);
  return db.getSession(o.id);
}
const writeTranscript = (cwd, engineId) => {
  const tFile = engineTranscriptPath(cwd, engineId);
  fs.mkdirSync(path.dirname(tFile), { recursive: true });
  fs.writeFileSync(tFile, JSON.stringify({ type: "user", message: { content: "seed" } }) + "\n");
  return path.dirname(tFile);
};

const repoRoots = [];
const transcriptDirs = [];
try {
  const P = { proj: `cow-proj-${sfx}` }; P.agent = `cow-ag-${sfx}`;
  mkProject(P.proj, "/tmp/cow"); mkAgent(P.agent, P.proj);

  // ============================ (1) DERIVE — the recovery predicate ============================
  const t1 = mkTask(`cow-t1-${sfx}`, P.proj);            // in_progress — the recoverable case
  const tDone = mkTask(`cow-tdone-${sfx}`, P.proj, "done"); // terminal lane — genuinely finished
  const t3 = mkTask(`cow-t3-${sfx}`, P.proj);            // in_progress, for the recycled-superseded case
  const t4 = mkTask(`cow-t4-${sfx}`, P.proj);            // in_progress, for the archived-pre-crash case
  const t5 = mkTask(`cow-t5-${sfx}`, P.proj);            // in_progress, for the done-but-unmerged case

  const id = {
    mgr: `cow-mgr-${sfx}`, deadMgr: `cow-deadmgr-${sfx}`,
    ok: `cow-wkr-ok-${sfx}`, landed: `cow-wkr-landed-${sfx}`, recycled: `cow-wkr-recycled-${sfx}`,
    successor: `cow-wkr-successor-${sfx}`, archivedPre: `cow-wkr-archpre-${sfx}`,
    doneUnmerged: `cow-wkr-doneunmerged-${sfx}`, orphanMgr: `cow-wkr-orphanmgr-${sfx}`,
  };
  mkSession({ id: id.mgr, projId: P.proj, agentId: P.agent, role: "manager", processState: "live" });
  mkSession({ id: id.deadMgr, projId: P.proj, agentId: P.agent, role: "manager", processState: "live", resumability: "dead" });

  // The crash-shaped recoverable candidate: exited + resumable + parented + task in_progress.
  mkSession({ id: id.ok, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id.mgr, taskId: t1, processState: "live" });
  // A landed task (terminal lane) — genuinely finished, must NOT be resurrected.
  mkSession({ id: id.landed, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id.mgr, taskId: tDone, processState: "live" });
  // Recycled: a successor row points back at it via recycled_from — its successor owns the work.
  mkSession({ id: id.recycled, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id.mgr, taskId: t3, processState: "live" });
  mkSession({ id: id.successor, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id.mgr, taskId: t3, processState: "live", recycledFrom: id.recycled });
  // Already archived BEFORE the crash — not this crash's doing.
  mkSession({ id: id.archivedPre, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id.mgr, taskId: t4, processState: "live", archived: true });
  // Reported `done` but the task hasn't landed (crashed between report and merge) — MUST be recovered.
  mkSession({ id: id.doneUnmerged, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id.mgr, taskId: t5, processState: "live" });
  db.appendEvent({ id: `evt-${sfx}-1`, ts: now, managerSessionId: id.mgr, workerSessionId: id.doneUnmerged, taskId: t5, kind: "worker_report", detail: { status: "done" } });

  // Simulate recoverStaleSessions()'s return shape: exactly the rows that were live/starting at crash time.
  const recovered = [id.ok, id.landed, id.recycled, id.successor, id.archivedPre, id.doneUnmerged, id.mgr, id.deadMgr]
    .map((sid) => db.getSession(sid));

  const derived = deriveCrashOrphanedWorkers(db, recovered);
  const byId = new Map(derived.map((c) => [c.workerSessionId, c]));

  check("(1) recovers the crash-shaped candidate (exited+resumable+parented+task in_progress)", byId.has(id.ok));
  check("(1) EXCLUDES a worker whose task already landed on the terminal lane", !byId.has(id.landed));
  check("(1) EXCLUDES a recycled/superseded worker (has a successor)", !byId.has(id.recycled));
  check("(1) does NOT exclude the successor itself merely for existing", byId.has(id.successor));
  check("(1) EXCLUDES a worker already archived BEFORE the crash", !byId.has(id.archivedPre));
  check("(1) candidate count is exactly 3 (ok, successor, doneUnmerged)", derived.length === 3);

  // ============================ (2) DONE-BUT-UNMERGED — recovered, not nudged-to-continue ==========
  check("(2) a done-but-unmerged worker IS recovered (reportedDone:true)", byId.get(id.doneUnmerged)?.reportedDone === true);
  check("(2) the crash-shaped OK worker is NOT marked reportedDone", byId.get(id.ok)?.reportedDone === false);

  // ============================ (3) ORDERING — survives archive + Pass B GC, reappears in worker_list ===
  // A REAL repo + REAL engine transcripts for the manager and worker, so recoverCrashOrphanedWorkers can
  // run a REAL sessions.resume() (not a stubbed resumeOne) to completion — proving the actual production
  // mechanism un-archives + re-lives the worker, not just a test double standing in for it.
  const repo = path.join(os.tmpdir(), `loom-cow-repo-${sfx}`);
  repoRoots.push(repo);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# cow\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  const realProjId = `cow-realproj-${sfx}`;
  const realAgentId = `cow-realag-${sfx}`;
  mkProject(realProjId, repo); mkAgent(realAgentId, realProjId);
  const realMgrId = `cow-realmgr-${sfx}`;
  const realMgrEng = `eng-${realMgrId}`;
  mkSession({ id: realMgrId, projId: realProjId, agentId: realAgentId, role: "manager", processState: "live", cwd: repo, engineSessionId: realMgrEng });
  transcriptDirs.push(writeTranscript(repo, realMgrEng));

  const realTaskId = mkTask(`cow-realtask-${sfx}`, realProjId);
  const wt = await createWorktree(repo, realProjId, realTaskId);
  const realWorkerId = `cow-realworker-${sfx}`;
  const realWorkerEng = `eng-${realWorkerId}`;
  mkSession({ id: realWorkerId, projId: realProjId, agentId: realAgentId, role: "worker", parentSessionId: realMgrId, taskId: realTaskId, worktreePath: wt.worktreePath, branch: wt.branch, cwd: wt.worktreePath, processState: "live", engineSessionId: realWorkerEng });
  transcriptDirs.push(writeTranscript(wt.worktreePath, realWorkerEng));

  const recovered3 = [db.getSession(realMgrId), db.getSession(realWorkerId)];
  const derived3 = deriveCrashOrphanedWorkers(db, recovered3);
  check("(3-pre) the real worker's worktree exists before boot-reconcile", fs.existsSync(wt.worktreePath));
  check("(3) derive recovers the real worker too", derived3.some((c) => c.workerSessionId === realWorkerId));

  // Mirror index.ts's ACTUAL boot order: recover-stale (already simulated above) -> derive (done) ->
  // archive backstop -> protect -> reconcile GC -> resume action.
  snapshotAndArchiveRecovered(db, recovered3); // stamps archived_at on both rows, exactly like boot does
  check("(3) archive backstop DID archive the real worker (proves the guard reads the PRE-archive snapshot, not a re-query)",
    db.getSession(realWorkerId)?.archivedAt != null);

  const protectedIds = new Set();
  for (const c of derived3) { protectedIds.add(c.workerSessionId); protectedIds.add(c.managerSessionId); }
  const rProt = await sessions.reconcileOrchestrationOnBoot(protectedIds);
  check("(3) protected reconcile touched no worktree (0 pruned)", rProt.worktreesPruned === 0);
  check("(3) the worktree SURVIVES Pass B GC under protection", fs.existsSync(wt.worktreePath));

  const result3 = sessions.recoverCrashOrphanedWorkers(derived3);
  check("(3) recoverCrashOrphanedWorkers resumed both the manager and the worker (REAL resume(), no stub)",
    result3.resumed.includes(realWorkerId) && result3.failed.length === 0);
  check("(3) the worker REAPPEARS in its manager's worker_list (archived_at cleared)",
    db.listWorkers(realMgrId).some((w) => w.id === realWorkerId));
  check("(3) the worker got the 'continue your task' nudge", pty.getPending(realWorkerId).some((m) => m.includes("[loom:crash-recovered]") && /continue your assigned task/i.test(m)));
  check("(3) the manager got the summary nudge naming the recovered count", pty.getPending(realMgrId).some((m) => m.includes("[loom:crash-recovered]") && m.includes("1 of your")));

  // Control: a SEPARATE, unprotected, exited worker with a clean (0-ahead) worktree IS reclaimed by the
  // SAME Pass B pass — proving PROTECTION (not luck) is what saved the real worker above.
  const repo2 = path.join(os.tmpdir(), `loom-cow-repo2-${sfx}`);
  repoRoots.push(repo2);
  fs.mkdirSync(repo2, { recursive: true });
  fs.writeFileSync(path.join(repo2, "README.md"), "# cow2\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo2 });
  const realProjId2 = `cow-realproj2-${sfx}`;
  mkProject(realProjId2, repo2); mkAgent(`cow-realag2-${sfx}`, realProjId2);
  const realTaskId2 = mkTask(`cow-realtask2-${sfx}`, realProjId2);
  const wt2 = await createWorktree(repo2, realProjId2, realTaskId2);
  const ctrlWorkerId = `cow-ctrlworker-${sfx}`;
  mkSession({ id: ctrlWorkerId, projId: realProjId2, agentId: `cow-realag2-${sfx}`, role: "worker", parentSessionId: realMgrId, taskId: realTaskId2, worktreePath: wt2.worktreePath, branch: wt2.branch, cwd: wt2.worktreePath, processState: "exited" });
  await sessions.reconcileOrchestrationOnBoot(); // NO protection for this one
  check("(3-control) an unprotected clean-tree exited worker's worktree IS reclaimed (proves protection, not luck)", !fs.existsSync(wt2.worktreePath));

  // ============================ (4) MANAGER-UNRESUMABLE — leave the worker untouched ==============
  const t6 = mkTask(`cow-t6-${sfx}`, P.proj);
  const orphanEng = `eng-${id.orphanMgr}`;
  mkSession({ id: id.orphanMgr, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id.deadMgr, taskId: t6, processState: "live", engineSessionId: orphanEng });
  // Capture the PRE-archive snapshot first (the real boot order: recoverStaleSessions' return value is
  // read before the archive backstop stamps archived_at), derive from THAT, then run the archive
  // backstop — so the row's resting state going into recoverCrashOrphanedWorkers is exited + archived,
  // exactly like a real post-crash row.
  const orphanPreArchive = db.getSession(id.orphanMgr);
  db.setProcessState(id.orphanMgr, "exited"); // recoverStaleSessions equivalent
  const derived4 = deriveCrashOrphanedWorkers(db, [orphanPreArchive, db.getSession(id.deadMgr)]);
  check("(4-pre) the orphaned worker (dead manager) IS a derived candidate", derived4.some((c) => c.workerSessionId === id.orphanMgr));
  snapshotAndArchiveRecovered(db, [orphanPreArchive]); // archive backstop
  check("(4-pre) the orphaned worker is exited + archived, exactly like a real post-crash row",
    db.getSession(id.orphanMgr).processState === "exited" && db.getSession(id.orphanMgr).archivedAt != null);

  const resumeOne4 = (sid) => sid !== id.deadMgr; // the manager's own resume() would throw (resumability:dead)
  const result4 = sessions.recoverCrashOrphanedWorkers(derived4, { resumeOne: resumeOne4 });
  check("(4) a worker whose manager can't be resumed is NOT in `resumed`", !result4.resumed.includes(id.orphanMgr));
  check("(4) it IS counted in `failed`", result4.failed.includes(id.orphanMgr));
  check("(4) it received NO nudge (left untouched, not half-resumed)", pty.getPending(id.orphanMgr).length === 0);
  check("(4) the worker row is left in its clean exited+archived state (never touched)",
    db.getSession(id.orphanMgr).processState === "exited" && db.getSession(id.orphanMgr).archivedAt != null);

  // ============================ (5) RATE-LIMIT PARK — resumed live, but no nudge (honor the hold) =====
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const id5 = { mgr: `cow-mgr5-${sfx}`, wkrParked: `cow-wkr5-parked-${sfx}`, wkrOk: `cow-wkr5-ok-${sfx}` };
  const t5b = mkTask(`cow-t5b-${sfx}`, P.proj);
  const t5c = mkTask(`cow-t5c-${sfx}`, P.proj);
  mkSession({ id: id5.mgr, projId: P.proj, agentId: P.agent, role: "manager", processState: "exited" });
  mkSession({ id: id5.wkrParked, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id5.mgr, taskId: t5b, processState: "exited" });
  db.setRateLimitedUntil(id5.wkrParked, future, "usage limit — parked");
  mkSession({ id: id5.wkrOk, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id5.mgr, taskId: t5c, processState: "exited" });
  const derived5 = deriveCrashOrphanedWorkers(db, [db.getSession(id5.mgr), db.getSession(id5.wkrParked), db.getSession(id5.wkrOk)]);
  const result5 = sessions.recoverCrashOrphanedWorkers(derived5, { resumeOne: () => true });
  check("(5) the parked worker IS resumed (in `resumed`)", result5.resumed.includes(id5.wkrParked));
  check("(5) the parked worker is reported in `skippedParked`", result5.skippedParked.includes(id5.wkrParked));
  check("(5) the parked worker received NO continue-nudge (park honored)", pty.getPending(id5.wkrParked).length === 0);
  check("(5) the NON-parked sibling worker DID get its continue-nudge", pty.getPending(id5.wkrOk).some((m) => m.includes("[loom:crash-recovered]")));
  check("(5) the manager (not itself parked) still got a summary nudge", pty.getPending(id5.mgr).some((m) => m.includes("[loom:crash-recovered]")));

  // A PARKED manager gets no summary nudge either, even though its non-parked worker still gets resumed
  // + nudged individually.
  const id5b = { mgr: `cow-mgr5b-${sfx}`, wkr: `cow-wkr5b-${sfx}` };
  const t5d = mkTask(`cow-t5d-${sfx}`, P.proj);
  mkSession({ id: id5b.mgr, projId: P.proj, agentId: P.agent, role: "manager", processState: "exited" });
  db.setRateLimitedUntil(id5b.mgr, future, "usage limit — parked");
  mkSession({ id: id5b.wkr, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id5b.mgr, taskId: t5d, processState: "exited" });
  const derived5b = deriveCrashOrphanedWorkers(db, [db.getSession(id5b.mgr), db.getSession(id5b.wkr)]);
  sessions.recoverCrashOrphanedWorkers(derived5b, { resumeOne: () => true });
  check("(5) a PARKED manager gets NO summary nudge", pty.getPending(id5b.mgr).length === 0);
  check("(5) its non-parked worker still gets resumed + nudged", pty.getPending(id5b.wkr).some((m) => m.includes("[loom:crash-recovered]")));

  // ============================ (6) MANAGER-ALL-FAILED — still gets a summary nudge =================
  const id6 = { mgr: `cow-mgr6-${sfx}`, wkrA: `cow-wkr6a-${sfx}`, wkrB: `cow-wkr6b-${sfx}` };
  const t6a = mkTask(`cow-t6a-${sfx}`, P.proj);
  const t6b = mkTask(`cow-t6b-${sfx}`, P.proj);
  mkSession({ id: id6.mgr, projId: P.proj, agentId: P.agent, role: "manager", processState: "exited" });
  mkSession({ id: id6.wkrA, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id6.mgr, taskId: t6a, processState: "exited" });
  mkSession({ id: id6.wkrB, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id6.mgr, taskId: t6b, processState: "exited" });
  const derived6 = deriveCrashOrphanedWorkers(db, [db.getSession(id6.mgr), db.getSession(id6.wkrA), db.getSession(id6.wkrB)]);
  const resumeOne6 = (sid) => sid === id6.mgr; // the manager resumes; EVERY worker individually fails
  const result6 = sessions.recoverCrashOrphanedWorkers(derived6, { resumeOne: resumeOne6 });
  check("(6) both workers land in `failed` (all individually unresumable)", result6.failed.includes(id6.wkrA) && result6.failed.includes(id6.wkrB));
  check("(6) the manager STILL gets a summary nudge even though recoveredCount is 0",
    pty.getPending(id6.mgr).some((m) => m.includes("[loom:crash-recovered]") && /none of your 2/i.test(m)));

  // ============================ (7) STALE reportedDone — a later merge_rejected supersedes it =========
  const id7 = { mgr: `cow-mgr7-${sfx}`, wkr: `cow-wkr7-${sfx}` };
  const t7 = mkTask(`cow-t7-${sfx}`, P.proj);
  mkSession({ id: id7.mgr, projId: P.proj, agentId: P.agent, role: "manager", processState: "live" });
  mkSession({ id: id7.wkr, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id7.mgr, taskId: t7, processState: "live" });
  db.appendEvent({ id: `evt-${sfx}-7a`, ts: now, managerSessionId: id7.mgr, workerSessionId: id7.wkr, taskId: t7, kind: "worker_report", detail: { status: "done" } });
  db.appendEvent({ id: `evt-${sfx}-7b`, ts: now, managerSessionId: id7.mgr, workerSessionId: id7.wkr, taskId: t7, kind: "merge_rejected", detail: { reason: "gate" } });
  const derived7 = deriveCrashOrphanedWorkers(db, [db.getSession(id7.mgr), db.getSession(id7.wkr)]);
  const c7 = derived7.find((c) => c.workerSessionId === id7.wkr);
  check("(7) a worker_report(done) SUPERSEDED by a later merge_rejected is NOT treated as reportedDone", c7?.reportedDone === false);
  sessions.recoverCrashOrphanedWorkers(derived7, { resumeOne: () => true });
  check("(7) it therefore STILL gets the continue-your-task nudge (it's actually mid-fix, not awaiting review)",
    pty.getPending(id7.wkr).some((m) => m.includes("[loom:crash-recovered]") && /continue your assigned task/i.test(m)));

  // ============================ (8) STALE-DEAD-FLAG RACE — re-verified live, not trusted ==============
  const id8 = { mgr: `cow-mgr8-${sfx}`, staleDead: `cow-wkr8-staledead-${sfx}`, genuinelyDead: `cow-wkr8-gendead-${sfx}` };
  const t8a = mkTask(`cow-t8a-${sfx}`, P.proj);
  const t8b = mkTask(`cow-t8b-${sfx}`, P.proj);
  mkSession({ id: id8.mgr, projId: P.proj, agentId: P.agent, role: "manager", processState: "live" });

  // A worker's `resumability` column is already 'dead' — simulating liveness.ts's watcher having
  // falsely stamped it during a transient TOCTOU race on an UNRELATED session's transcript rewrite — but
  // its OWN transcript file genuinely EXISTS on disk right now.
  const cwd8a = path.join(os.tmpdir(), `loom-cow-cwd8a-${sfx}`);
  const eng8a = `eng-${id8.staleDead}`;
  mkSession({ id: id8.staleDead, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id8.mgr, taskId: t8a, processState: "live", cwd: cwd8a, engineSessionId: eng8a, resumability: "dead" });
  transcriptDirs.push(writeTranscript(cwd8a, eng8a));

  // A SIBLING worker ALSO flagged 'dead' whose transcript is GENUINELY gone right now — re-verification
  // must confirm the flag rather than blanket-heal every dead-flagged row.
  const cwd8b = path.join(os.tmpdir(), `loom-cow-cwd8b-${sfx}`);
  const eng8b = `eng-${id8.genuinelyDead}`;
  mkSession({ id: id8.genuinelyDead, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id8.mgr, taskId: t8b, processState: "live", cwd: cwd8b, engineSessionId: eng8b, resumability: "dead" });

  const derived8 = deriveCrashOrphanedWorkers(db, [db.getSession(id8.mgr), db.getSession(id8.staleDead), db.getSession(id8.genuinelyDead)]);
  check("(8) a worker with a STALE 'dead' flag but a REAL transcript IS recovered (re-verified, not trusted)",
    derived8.some((c) => c.workerSessionId === id8.staleDead));
  check("(8) its stale 'dead' stamp is HEALED back to 'resumable' (self-heals the sticky flag)",
    db.getSession(id8.staleDead).resumability === "resumable");
  check("(8) a worker whose transcript is GENUINELY missing right now is still excluded",
    !derived8.some((c) => c.workerSessionId === id8.genuinelyDead));
  check("(8) the genuinely-dead worker's resumability is stamped 'dead'",
    db.getSession(id8.genuinelyDead).resumability === "dead");
  check("(8) the exclusion is LOGGED with a clear reason (never silent)",
    logs.some((l) => l.includes("[crash-recovery]") && l.includes(id8.genuinelyDead.slice(0, 8)) && l.includes("engine transcript missing")));
  // The reported bug: a manager whose ONLY worker was wrongly excluded never even got a resume attempt.
  // With the stale flag no longer trusted, the manager DOES still have a surviving candidate (staleDead)
  // and is attempted, proving the fix closes exactly that gap.
  const result8 = sessions.recoverCrashOrphanedWorkers(derived8, { resumeOne: () => true });
  check("(8) the manager (whose only surviving worker was previously wrongly excluded) IS resumed",
    result8.resumed.includes(id8.staleDead) && !result8.managersFailed.includes(id8.mgr));

  // ============================ (9) SOLO MANAGER — independent attempt, no worker candidates =========
  const id9 = { mgr: `cow-mgr9-${sfx}`, wkrLanded: `cow-wkr9-landed-${sfx}` };
  const t9 = mkTask(`cow-t9-${sfx}`, P.proj, "done"); // terminal — landed, genuinely finished
  mkSession({ id: id9.mgr, projId: P.proj, agentId: P.agent, role: "manager", processState: "live" });
  mkSession({ id: id9.wkrLanded, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id9.mgr, taskId: t9, processState: "live" });
  const recovered9 = [db.getSession(id9.mgr), db.getSession(id9.wkrLanded)];
  const derived9 = deriveCrashOrphanedWorkers(db, recovered9);
  check("(9-pre) the landed worker is correctly excluded — nothing to recover", !derived9.some((c) => c.managerSessionId === id9.mgr));
  const soloManagers9 = deriveCrashOrphanedManagers(db, recovered9, derived9);
  check("(9-pre) the manager (zero surviving worker candidates) IS derived as a solo manager", soloManagers9.includes(id9.mgr));
  const result9 = sessions.recoverCrashOrphanedWorkers(derived9, { resumeOne: () => true, soloManagerIds: soloManagers9 });
  check("(9) the solo manager still gets an independent resume attempt (no worker candidates required)",
    !result9.managersFailed.includes(id9.mgr));
  check("(9) it gets a PLAIN nudge, not the '0 of your 0 in-flight worker(s)' phrasing",
    pty.getPending(id9.mgr).some((m) => m.includes("[loom:crash-recovered]") && /re-check your state and continue orchestrating/i.test(m) && !/in-flight worker/i.test(m)));

  // A solo manager whose OWN resume attempt genuinely fails (real resume(), no stub) lands in
  // `managersFailed`, with the actual thrown reason logged — never a silent no-op. RESUMABLE-BUT-BROKEN:
  // an engine id IS captured (so the new engineSessionId guard does NOT exclude it as a candidate — it's
  // a real derive() candidate), but its transcript file genuinely doesn't exist on disk, so `resume()`'s
  // OWN fresh check throws at resume-time. This is a materially different failure mode than "never had an
  // engine id to begin with" (excluded up front, never even attempted — see the engineSessionId guard).
  const id9b = { mgr: `cow-mgr9b-${sfx}` };
  const eng9b = `eng-${id9b.mgr}`;
  mkSession({ id: id9b.mgr, projId: P.proj, agentId: P.agent, role: "manager", processState: "live", engineSessionId: eng9b });
  const soloManagers9b = deriveCrashOrphanedManagers(db, [db.getSession(id9b.mgr)], []);
  check("(9b-pre) a resumable-but-broken manager (engine id set, no transcript) IS derived as a candidate", soloManagers9b.includes(id9b.mgr));
  const result9b = sessions.recoverCrashOrphanedWorkers([], { soloManagerIds: soloManagers9b });
  check("(9b) a solo manager whose OWN resume genuinely fails lands in `managersFailed`",
    result9b.managersFailed.includes(id9b.mgr));
  check("(9b) the real failure reason is LOGGED (not silently swallowed into a bare boolean)",
    warns.some((w) => w.includes("[crash-recovery]") && w.includes(id9b.mgr.slice(0, 8)) && w.includes("engine transcript missing")));

  // (9e) NO ENGINE ID — a manager caught mid-`starting` at crash time (no captured engine id yet) is
  // structurally NEVER resumable (there's no transcript to resume into) and must be excluded UP FRONT,
  // not attempted-and-failed — proving the new engineSessionId guard (mirrors the worker path's own).
  // mkSession's `?? eng-<id>` default can't express a genuinely-null engine id (`??` treats an explicit
  // `null` as nullish too), so insert the row directly.
  const id9e = { mgr: `cow-mgr9e-${sfx}` };
  db.insertSession({
    id: id9e.mgr, projectId: P.proj, agentId: P.agent, engineSessionId: null,
    title: null, cwd: os.tmpdir(), processState: "starting", resumability: "unknown",
    busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "manager", parentSessionId: null, taskId: null, worktreePath: null, branch: null,
  });
  const soloManagers9e = deriveCrashOrphanedManagers(db, [db.getSession(id9e.mgr)], []);
  check("(9e) a manager with NO captured engine id is NOT derived as a solo manager candidate", !soloManagers9e.includes(id9e.mgr));

  // (9c) ARCHIVED PRE-CRASH — a manager row that is `live`/`starting` in the DB (recoverStaleSessions
  // does NOT filter on archivedAt) but was already archived BEFORE this crash must NOT be resurrected as
  // a solo manager, exactly like the worker path's own archivedAt guard.
  const id9c = { mgr: `cow-mgr9c-${sfx}` };
  mkSession({ id: id9c.mgr, projId: P.proj, agentId: P.agent, role: "manager", processState: "live", archived: true });
  const soloManagers9c = deriveCrashOrphanedManagers(db, [db.getSession(id9c.mgr)], []);
  check("(9c) a manager already ARCHIVED pre-crash is NOT derived as a solo manager", !soloManagers9c.includes(id9c.mgr));

  // (9d) RECYCLED/SUPERSEDED — a `recycle_me` predecessor can still show live/starting at crash time
  // even though a successor already took over; it must NOT be resurrected as a solo manager, exactly
  // like the worker path's own hasSuccessor guard (never resurrect a superseded row).
  const id9d = { mgrPredecessor: `cow-mgr9d-pred-${sfx}`, mgrSuccessor: `cow-mgr9d-succ-${sfx}` };
  mkSession({ id: id9d.mgrPredecessor, projId: P.proj, agentId: P.agent, role: "manager", processState: "live" });
  mkSession({ id: id9d.mgrSuccessor, projId: P.proj, agentId: P.agent, role: "manager", processState: "live", recycledFrom: id9d.mgrPredecessor });
  const soloManagers9d = deriveCrashOrphanedManagers(db, [db.getSession(id9d.mgrPredecessor), db.getSession(id9d.mgrSuccessor)], []);
  check("(9d) a RECYCLED/superseded manager predecessor is NOT derived as a solo manager", !soloManagers9d.includes(id9d.mgrPredecessor));
  check("(9d) its successor (not itself superseded) IS derived as a solo manager", soloManagers9d.includes(id9d.mgrSuccessor));

  // (9f) PLATFORM ROLE — a `platform`-role session is derived + independently attempted exactly like a
  // `manager`-role one (the role check in deriveCrashOrphanedManagers handles both; this was untested).
  const id9f = { plat: `cow-plat9f-${sfx}` };
  mkSession({ id: id9f.plat, projId: P.proj, agentId: P.agent, role: "platform", processState: "live" });
  const soloManagers9f = deriveCrashOrphanedManagers(db, [db.getSession(id9f.plat)], []);
  check("(9f-pre) a PLATFORM-role solo session IS derived as a candidate", soloManagers9f.includes(id9f.plat));
  const result9f = sessions.recoverCrashOrphanedWorkers([], { resumeOne: () => true, soloManagerIds: soloManagers9f });
  check("(9f) it gets the SAME independent resume attempt + plain nudge as a manager-role session",
    !result9f.managersFailed.includes(id9f.plat) &&
    pty.getPending(id9f.plat).some((m) => m.includes("[loom:crash-recovered]") && /re-check your state and continue orchestrating/i.test(m)));

  // (9g) PARKED SOLO MANAGER — a solo manager (zero worker candidates) that is usage-limit PARKED is
  // resumed live (so the rate-limit watcher can recover it on its own schedule) but withheld its summary
  // nudge, mirroring the with-workers park handling (section 5) — untested for the zero-worker path.
  const id9g = { mgr: `cow-mgr9g-${sfx}` };
  mkSession({ id: id9g.mgr, projId: P.proj, agentId: P.agent, role: "manager", processState: "live" });
  db.setRateLimitedUntil(id9g.mgr, future, "usage limit — parked");
  const soloManagers9g = deriveCrashOrphanedManagers(db, [db.getSession(id9g.mgr)], []);
  const result9g = sessions.recoverCrashOrphanedWorkers([], { resumeOne: () => true, soloManagerIds: soloManagers9g });
  check("(9g) a PARKED solo manager is still resumed (in the successful path, not `managersFailed`)",
    !result9g.managersFailed.includes(id9g.mgr));
  check("(9g) it receives NO summary nudge (usage hold honored)", pty.getPending(id9g.mgr).length === 0);
} finally {
  console.log = realLog;
  console.warn = realWarn;
  db.close();
  for (const repo of repoRoots) {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  for (const dir of transcriptDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a crash-orphaned worker (exited+resumable+parented+task in_progress) is derived from the pre-archive recoverStaleSessions snapshot, survives the boot-backstop auto-archive AND Pass B worktree-GC (via protectedSessionIds), and reappears in its manager's worker_list once resumed for real; a done-but-unmerged worker is recovered for visibility without a stray 'continue' nudge (unless a later merge_rejected supersedes that report, in which case it DOES get the nudge); a landed/recycled/pre-archived worker is never resurrected; a parked worker/manager is resumed but never nudged (usage hold honored); a manager whose workers ALL fail to resume still gets a summary nudge; an unprotected control worker's worktree IS reclaimed (proving protection mattered); a worker whose manager can't be resumed is left untouched in its clean exited+archived state, not half-resumed; a worker wrongly stale-flagged 'dead' by an earlier watcher race is re-verified live and recovered (healing the flag) instead of silently stranding its manager, while a genuinely-dead sibling is still excluded WITH a logged reason; and a manager with zero surviving worker candidates still gets an independent resume attempt, with any genuine failure logged instead of swallowed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
