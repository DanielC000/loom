import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// WorktreeVanishedWatcher test (card 652d312f) — detect-and-surface only, structural twin of
// BusyWorkerWatcher. NO claude — the watcher takes an injected pty-slice, so the tick tests use a
// RECORDING STUB and drive tick() directly. Hermetic like busy-worker-watcher.mjs: each env gets its
// OWN temp .db, imports dist/* + @loom/shared, no daemon. The worktree fixtures are REAL directories
// on disk (fs.mkdirSync/writeFileSync) — the detector is fs-only, so faking fs would test nothing.
//
// Covers detectVanishedWorktree's three claimed states + its two deliberate non-claims (RED-PROOF:
// (1e)/(1f) show the detector does NOT flag a real .git DIRECTORY or unparseable content — a weaker
// "any oddity → flag it" detector would wrongly fire here, so a green run on those two is a genuine
// negative control, not a vacuous one) — plus the watcher's tick DoD trio (gone/broken → fires once
// to worker+manager; intact → no fire) and every silent skip (no worktreePath / pty gone / orphaned
// manager / human-paused worker or manager / already-flagged session).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { WorktreeVanishedWatcher, detectVanishedWorktree } from "../dist/orchestration/worktree-vanished-watcher.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-08-24T12:00:00.000Z");

// ---------------------------------------------------------------------------------------------------
// Fixture helpers — REAL directories, mirroring what `git worktree add` actually produces: a `.git`
// FILE (never a directory) containing `gitdir: <absolute path>` pointing at the main repo's own
// `.git/worktrees/<id>` admin dir.
// ---------------------------------------------------------------------------------------------------
const FIXTURE_ROOT = path.join(os.tmpdir(), `loom-wtv-fixtures-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(FIXTURE_ROOT, { recursive: true });

function makeIntactWorktree(name) {
  const wt = path.join(FIXTURE_ROOT, name);
  const gitdirTarget = path.join(FIXTURE_ROOT, `${name}-admin-gitdir`);
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(gitdirTarget, { recursive: true });
  fs.writeFileSync(path.join(wt, "README.md"), "hello\n");
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitdirTarget}\n`);
  return wt;
}
function makeGoneWorktree(name) {
  // Never actually created — existsSync(worktreePath) is false by construction.
  return path.join(FIXTURE_ROOT, name);
}
function makeGitFileMissingWorktree(name) {
  const wt = path.join(FIXTURE_ROOT, name);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, "leftover.txt"), "stray file, no .git\n"); // partial reap: files but no .git
  return wt;
}
function makeEmptyWorktree(name) {
  const wt = path.join(FIXTURE_ROOT, name);
  fs.mkdirSync(wt, { recursive: true }); // fully wiped: dir exists, zero entries (not even .git)
  return wt;
}
function makeGitdirTargetMissingWorktree(name) {
  const wt = path.join(FIXTURE_ROOT, name);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, "README.md"), "hello\n");
  // .git points at an admin dir that was never created — git-deregistered, files otherwise untouched.
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(FIXTURE_ROOT, `${name}-never-existed`)}\n`);
  return wt;
}
function makeRealGitDirWorktree(name) {
  // A REAL `.git` directory (not a worktree-pointer file) — e.g. a plain repo checkout, not a worktree.
  // Not a claimable state for THIS detector (it only understands worktree-pointer `.git` files).
  const wt = path.join(FIXTURE_ROOT, name);
  fs.mkdirSync(path.join(wt, ".git"), { recursive: true });
  fs.writeFileSync(path.join(wt, "README.md"), "hello\n");
  return wt;
}
function makeUnparseableGitFileWorktree(name) {
  const wt = path.join(FIXTURE_ROOT, name);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), "not a gitdir pointer at all\n");
  return wt;
}

// ============================ (1) detectVanishedWorktree — the three claimed states + RED-PROOF negatives ============================
{
  check("(1a) gone → \"gone\"", detectVanishedWorktree(makeGoneWorktree("gone")) === "gone");
  check("(1b) dir present, .git missing (partial reap, files left) → \"git_file_missing\"", detectVanishedWorktree(makeGitFileMissingWorktree("git-missing")) === "git_file_missing");
  check("(1c) dir present, fully empty (full reap) → \"git_file_missing\" (no .git among zero entries)", detectVanishedWorktree(makeEmptyWorktree("empty")) === "git_file_missing");
  check("(1d) dir + files intact, .git present but its gitdir TARGET is gone → \"gitdir_target_missing\" (the git-deregistered state)", detectVanishedWorktree(makeGitdirTargetMissingWorktree("degistered")) === "gitdir_target_missing");
  check("(1e) NEGATIVE CONTROL — a genuinely intact worktree → null (not flagged)", detectVanishedWorktree(makeIntactWorktree("intact")) === null);
  // RED-PROOF: a real `.git` DIRECTORY (plain repo, not a worktree) must NOT be claimed as any of the
  // three states — a weaker "any anomaly → flag" detector would wrongly fire here.
  check("(1f) RED-PROOF — a real .git DIRECTORY (not a worktree-pointer file) → null, not falsely claimed", detectVanishedWorktree(makeRealGitDirWorktree("real-git-dir")) === null);
  check("(1g) RED-PROOF — unparseable .git content → null, not falsely claimed", detectVanishedWorktree(makeUnparseableGitFileWorktree("unparseable")) === null);
}

// ---------------------------------------------------------------------------------------------------
// Watcher tick harness — mirrors busy-worker-watcher.mjs's env shape.
// ---------------------------------------------------------------------------------------------------
function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-wtv-w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `wp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `wa-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "Wtv", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
  };
  const control = new OrchestrationControl();
  const watcher = new WorktreeVanishedWatcher({ db, pty, control });
  return { dbFile, db, projId, agentId, alive, enqueued, control, watcher };
}
function seedManager(e, id, { live = true } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  if (live) e.alive.add(id);
}
function seedWorker(e, id, parentId, worktreePath, { live = true, pty = true } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: worktreePath ?? e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role: "worker",
    parentSessionId: parentId, taskId: "tk-" + id, worktreePath: worktreePath ?? null, branch: `loom/${id}`,
  });
  if (live && pty) e.alive.add(id);
}
const vanishedEvents = (e, workerId) => e.db.listEventsForWorker(workerId).filter((ev) => ev.kind === "worktree_vanished");
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ (2) FIRES ONCE — vanished worktree, notices to BOTH worker and manager ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-1");
  const wt = makeGoneWorktree("tick-gone-1");
  seedWorker(e, "wkr-gone", "mgr-1", wt);
  e.watcher.tick(NOW);
  check("(2) vanished worktree → ONE worktree_vanished event filed under the owning manager", vanishedEvents(e, "wkr-gone").length === 1);
  const ev = vanishedEvents(e, "wkr-gone")[0];
  check("(2) event carries manager/worker/task + reason + worktreePath", ev?.managerSessionId === "mgr-1" && ev?.workerSessionId === "wkr-gone" && ev?.taskId === "tk-wkr-gone" && ev?.detail?.reason === "gone" && ev?.detail?.worktreePath === wt);
  check("(2) exactly TWO nudges enqueued: the worker itself AND its manager", e.enqueued.length === 2);
  const toWorker = e.enqueued.find((m) => m.id === "wkr-gone");
  const toManager = e.enqueued.find((m) => m.id === "mgr-1");
  check("(2) worker notice tells it to stop and report blocked", !!toWorker && toWorker.text.startsWith("[loom:worktree-vanished]") && /worker_report/.test(toWorker.text) && /blocked/.test(toWorker.text));
  check("(2) manager notice names the worker + steers to worker_status/recycle, states it's informational-only", !!toManager && toManager.text.startsWith("[loom:worktree-vanished]") && toManager.text.includes("worker_status") && /worker_recycle|re-dispatch/.test(toManager.text) && /does not auto-recover/i.test(toManager.text));
  // A second tick (still vanished, same session id) must NOT re-fire.
  e.watcher.tick(NOW);
  check("(2) a second tick on the SAME live session does NOT re-emit worktree_vanished", vanishedEvents(e, "wkr-gone").length === 1);
  check("(2) a second tick enqueues no further nudges", e.enqueued.length === 2);
  cleanup(e);
}

// ============================ (3) NO FIRE — intact worktree (real fixture, negative control) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-3");
  const wt = makeIntactWorktree("tick-intact-3");
  seedWorker(e, "wkr-intact", "mgr-3", wt);
  e.watcher.tick(NOW);
  check("(3) intact worktree is NOT flagged", vanishedEvents(e, "wkr-intact").length === 0 && e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (4) SILENT — no worktreePath on the session (nothing to check) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-4");
  seedWorker(e, "wkr-nopath", "mgr-4", null);
  e.watcher.tick(NOW);
  check("(4) worker with no worktreePath is skipped (nothing to check)", vanishedEvents(e, "wkr-nopath").length === 0 && e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (5) SILENT — db says live but pty is gone ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-5");
  const wt = makeGoneWorktree("tick-gone-5");
  seedWorker(e, "wkr-nopty", "mgr-5", wt, { pty: false }); // live in db, but pty.isAlive() false
  e.watcher.tick(NOW);
  check("(5) db-live-but-pty-gone worker is skipped", vanishedEvents(e, "wkr-nopty").length === 0 && e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (6) SILENT — orphaned worker (manager not live) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-dead", { live: false });
  const wt = makeGoneWorktree("tick-gone-6");
  seedWorker(e, "wkr-orphan", "mgr-dead", wt);
  e.watcher.tick(NOW);
  check("(6) worker whose manager is NOT live is NOT flagged (orphan → boot-reconcile's job)", vanishedEvents(e, "wkr-orphan").length === 0 && e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (7) SILENT — human-paused (worker scope, manager scope, or global) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-7");
  const wtA = makeGoneWorktree("tick-gone-7a");
  const wtB = makeGoneWorktree("tick-gone-7b");
  seedWorker(e, "wkr-paused-self", "mgr-7", wtA);
  seedWorker(e, "wkr-live-7", "mgr-7", wtB); // sibling, not paused → still flagged
  e.control.pause("wkr-paused-self");
  e.watcher.tick(NOW);
  check("(7) worker paused in its OWN scope is NOT flagged", vanishedEvents(e, "wkr-paused-self").length === 0);
  check("(7) sibling (unpaused) worker IS flagged", vanishedEvents(e, "wkr-live-7").length === 1);

  const e2 = makeEnv();
  seedManager(e2, "mgr-7b");
  const wtC = makeGoneWorktree("tick-gone-7c");
  seedWorker(e2, "wkr-mgr-paused", "mgr-7b", wtC);
  e2.control.pause("mgr-7b");
  e2.watcher.tick(NOW);
  check("(7) worker whose MANAGER is paused is NOT flagged", vanishedEvents(e2, "wkr-mgr-paused").length === 0 && e2.enqueued.length === 0);

  const e3 = makeEnv();
  seedManager(e3, "mgr-7c");
  const wtD = makeGoneWorktree("tick-gone-7d");
  seedWorker(e3, "wkr-global", "mgr-7c", wtD);
  e3.control.pause("global");
  e3.watcher.tick(NOW);
  check("(7) global pause silences ALL workers", vanishedEvents(e3, "wkr-global").length === 0);
  cleanup(e); cleanup(e2); cleanup(e3);
}

// ============================ (8) only LIVE workers; manager sessions ignored ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-8");
  e.db.insertSession({
    id: "mgr-busy-8", projectId: e.projId, agentId: e.agentId, engineSessionId: "em8", title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: true, createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(),
    lastError: null, role: "manager", worktreePath: makeGoneWorktree("tick-gone-8-mgr"), ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add("mgr-busy-8");
  const wt = makeGoneWorktree("tick-gone-8-exited");
  seedWorker(e, "wkr-exited-8", "mgr-8", wt, { live: false });
  e.watcher.tick(NOW);
  check("(8) a manager session (even with a vanished worktreePath) is NOT flagged by the WORKER watchdog; an exited worker is ignored", e.enqueued.length === 0 && vanishedEvents(e, "wkr-exited-8").length === 0);
  cleanup(e);
}

// ============================ (9) MULTIPLE LIVE SESSIONS SHARING ONE PATH — keyed per session id, not per path ============================
{
  // Mirrors the manager's own finding: worktree reuse means several session rows can share one
  // worktreePath. Each LIVE session gets its OWN independent detection, keyed on ITS OWN row's
  // worktreePath field — never re-derived from taskId — so a fresh sibling isn't silently shielded by
  // an earlier one's already-fired event.
  const e = makeEnv();
  seedManager(e, "mgr-9");
  const sharedPath = makeGoneWorktree("tick-shared-path-9");
  seedWorker(e, "wkr-9a", "mgr-9", sharedPath);
  seedWorker(e, "wkr-9b", "mgr-9", sharedPath);
  e.watcher.tick(NOW);
  check("(9) two live sessions sharing one vanished path EACH get their own event", vanishedEvents(e, "wkr-9a").length === 1 && vanishedEvents(e, "wkr-9b").length === 1);
  check("(9) EACH gets its own worker-directed nudge (not just one shared)", e.enqueued.some((m) => m.id === "wkr-9a") && e.enqueued.some((m) => m.id === "wkr-9b"));
  cleanup(e);
}

fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — detectVanishedWorktree correctly claims exactly the three fs-only states it documents (gone / git-file-missing, covering both partial and full reap / gitdir-target-missing, the git-deregistered case) against REAL fixture directories, and — RED-PROOF — does NOT falsely claim a real `.git` directory or unparseable `.git` content as any of them; WorktreeVanishedWatcher.tick fires EXACTLY ONCE per live session (notice to both the worker — stop, report blocked — and its owning manager — check worker_status, recycle or re-dispatch, informational only), is SILENT for an intact worktree / no worktreePath / pty-gone / orphaned manager / human-paused (worker, manager, or global) / already-flagged session, ignores manager sessions, and gives each of several live sessions sharing one worktreePath its own independent detection (keyed on that row's own field, never re-derived from taskId)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
