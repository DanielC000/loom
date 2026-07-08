import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// No-commit reviewer lifecycle test (board card 14434d6b). REAL git on temp repos, NO claude and NO
// live daemon — drives SessionService.workerReport() directly against an isolated LOOM_HOME (mirrors
// worker-report-precheck.mjs's in-process style).
//
// THE GAP IT GUARDS: a read-only / no-commit worker (e.g. the Code Reviewer rig, Profile/row
// noCommit=true) has NO merge step, so unlike a normal worker — whose concurrency slot frees via
// worker_merge_confirm — its slot would only free on a MANUAL worker_stop. Managers kept hitting the
// maxConcurrentWorkers cap because of this asymmetry. Also every reviewer report carried a "forgot to
// commit" warning, pure noise for a role whose correct contract is filesChanged:0.
//
// Proves, on a 0-commit (clean, 0-ahead) worktree:
//   (R) DECLARED no-commit (row noCommit=true): workerReport(done) AUTO-RETIRES the worker — processState
//       flips to exited so the live-worker count (EXACTLY what spawnWorker's cap check reads) drops to 0
//       with NO manual worker_stop — AND the "forgot to commit" warning is SUPPRESSED (absent), with
//       autoRetired:true + a stop_worker(reason:no-commit-auto-retire) event recorded.
//   (N) NORMAL worker (noCommit=false), 0-ahead: the warning is STILL emitted and the worker is NOT
//       auto-retired (stays live) — the forgot-to-commit safety net is intact (THE REGRESSION GUARD).
//   (C) NORMAL worker WITH a real commit: clean done — no warning, not auto-retired, stays live (the
//       normal merge path owns retirement) — proving auto-retire keys off noCommit AND 0-ahead, never
//       "0 commits" or name-matching alone.
//   (D) DEFERRED pty.stop (card f46f4b0d): the auto-retire's graceful pty.stop must NOT fire in the same
//       tick as workerReport()'s return — an immediate Ctrl-C races the worker_report tool call's own
//       MCP response still flushing back to the worker's CLI and can surface a false "[Request
//       interrupted]" on a report that already succeeded. Proves pty.stop is un-called immediately after
//       workerReport() resolves, then IS called (graceful, this worker's id) once the defer window
//       elapses — mirroring endMe's / recycleManager's already-established close-after-delay pattern.
// Run: 1) build daemon (pnpm build), 2) node test/no-commit-reviewer.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ncr-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ncr@loom -c user.name=ncr";
const now = new Date().toISOString();

const db = new Db();
// workerReport touches pty.enqueueStdin (manager notification) and, on the auto-retire path, pty.stop.
// A stub keeps it hermetic; the DETERMINISTIC slot-free is db.setProcessState (auto-retire does it
// itself), so the live-worker count is observable from the Db with no real pty. Records each stop()
// call (id/mode/timestamp) so (D) below can prove it's DEFERRED, not fired synchronously.
const ptyStopCalls = [];
const ptyStub = { enqueueStdin() { return { delivered: true }; }, stop(id, mode) { ptyStopCalls.push({ id, mode, at: Date.now() }); } };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

// EXACTLY what spawnWorker's maxConcurrentWorkers cap check counts (live workers under the manager).
const liveWorkerCount = (mgrId) => db.listWorkers(mgrId).filter((w) => w.processState === "live").length;

function seed(p, noCommit) {
  // cap=1 so "one reviewer is at cap" is concrete (the live-count assertions read the same quantity).
  db.insertProject({ id: p.projId, name: "NCR", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { maxConcurrentWorkers: 1 } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "NCR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // The worker carries noCommit PINNED on the row (exactly as spawnWorker pins it from the resolved Profile).
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", noCommit, parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# ncr\n");
  execSync(`git init -q && git config user.email ncr@loom && git config user.name ncr && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (tag) => ({
  projId: `ncr-${tag}-proj-${sfx}`, agentId: `ncr-${tag}-ag-${sfx}`, taskId: `ncr-${tag}-task-${sfx}`,
  mgrId: `ncr-${tag}-mgr-${sfx}`, workerId: `ncr-${tag}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-ncr-${tag}-${sfx}`),
});
const R = mk("r"); // declared no-commit, 0-ahead → auto-retire + no warning
const N = mk("n"); // normal worker, 0-ahead → warning + NOT auto-retired (safety net)
const C = mk("c"); // normal worker WITH a commit → no warning, not auto-retired
const all = [R, N, C];

// Build a worker on a fresh worktree. commit=false → 0-ahead (clean, no commit — the reviewer contract).
async function build(p, { noCommit, commit }) {
  initRepo(p.repo);
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  p.worktreePath = worktreePath; p.branch = branch;
  if (commit) {
    fs.writeFileSync(path.join(worktreePath, "change.txt"), `work for ${p.projId}\n`);
    execSync(`git add . && git ${GIT_ID} commit -q -m "change"`, { cwd: worktreePath });
  }
  seed(p, noCommit);
}

try {
  // ── (R) DECLARED no-commit reviewer, 0-ahead: AUTO-RETIRE + suppressed warning ───────────────────
  await build(R, { noCommit: true, commit: false });
  check("(R setup) reviewer is at cap (1 live worker = maxConcurrentWorkers)", liveWorkerCount(R.mgrId) === 1);
  const rR = await sessions.workerReport(R.workerId, { status: "done", summary: "review complete — no findings" });
  // (D) pty.stop must not have fired yet — it's deferred so this call's own MCP response (rR) flushes
  // back to the worker's CLI first, instead of racing an immediate Ctrl-C against the in-flight reply.
  check("(D) no-commit reviewer done: pty.stop NOT called synchronously (deferred, not immediate)", ptyStopCalls.length === 0);
  check("(R) no-commit reviewer done: reported:true, NOT refused", rR.reported === true && !rR.refused);
  check("(R) no-commit reviewer done: 'forgot to commit' warning SUPPRESSED (absent)", rR.warning === undefined);
  check("(R) no-commit reviewer done: flagged autoRetired:true", rR.autoRetired === true);
  check("(R) no-commit reviewer done: session retired (processState exited)", db.getSession(R.workerId).processState === "exited");
  check("(R) no-commit reviewer done: cap slot FREED — live workers 1→0 (a fresh spawn would now be admitted, no worker_stop)", liveWorkerCount(R.mgrId) === 0);
  check("(R) no-commit reviewer done: a stop_worker(reason:no-commit-auto-retire) event recorded",
    db.listEvents(R.mgrId).some((e) => e.kind === "stop_worker" && e.detail && e.detail.reason === "no-commit-auto-retire"));
  check("(R) no-commit reviewer done: the worker_report(done) event still landed (report not lost)",
    db.listEvents(R.mgrId).some((e) => e.kind === "worker_report" && e.detail && e.detail.status === "done"));
  check("(R) no-commit reviewer done: worker_report event carries NO warning", (() => {
    const ev = db.listEvents(R.mgrId).find((e) => e.kind === "worker_report");
    return ev && ev.detail && ev.detail.warning === undefined;
  })());
  // (D) now wait past the defer window and confirm the graceful stop DOES land — deferred, not skipped.
  await new Promise((resolve) => setTimeout(resolve, 3300));
  check("(D) no-commit reviewer done: pty.stop DOES fire once the defer window elapses (graceful, this worker)",
    ptyStopCalls.length === 1 && ptyStopCalls[0].id === R.workerId && ptyStopCalls[0].mode === "graceful");

  // ── (N) NORMAL worker, 0-ahead: warning STILL emitted + NOT auto-retired (THE REGRESSION GUARD) ───
  await build(N, { noCommit: false, commit: false });
  const rN = await sessions.workerReport(N.workerId, { status: "done", summary: "done (forgot to commit)" });
  check("(N) normal 0-commit done: reported:true, NOT refused", rN.reported === true && !rN.refused);
  check("(N) normal 0-commit done: 'forgot to commit' warning STILL emitted (present, mentions 0 commits ahead)", typeof rN.warning === "string" && rN.warning.includes("0 commits ahead"));
  check("(N) normal 0-commit done: NOT auto-retired (autoRetired absent)", rN.autoRetired === undefined);
  check("(N) normal 0-commit done: session stays LIVE (slot NOT freed — needs merge/stop)", db.getSession(N.workerId).processState === "live");
  check("(N) normal 0-commit done: live worker count unchanged (still 1)", liveWorkerCount(N.mgrId) === 1);
  check("(N) normal 0-commit done: NO stop_worker auto-retire event", !db.listEvents(N.mgrId).some((e) => e.kind === "stop_worker"));

  // ── (C) NORMAL worker WITH a commit: clean done — no warning, not auto-retired (conjunction proof) ─
  await build(C, { noCommit: false, commit: true });
  const rC = await sessions.workerReport(C.workerId, { status: "done", summary: "implemented + committed" });
  check("(C) normal committed done: no warning (real work to merge)", rC.warning === undefined);
  check("(C) normal committed done: NOT auto-retired", rC.autoRetired === undefined);
  check("(C) normal committed done: session stays LIVE (the normal merge path owns retirement)", db.getSession(C.workerId).processState === "live");
} finally {
  db.close();
  for (const p of all) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a declared no-commit worker auto-retires (cap slot freed, no worker_stop) + the warning is suppressed; a NORMAL 0-commit worker still warns + stays live (safety net intact); the graceful pty.stop is deferred so the worker's own report reply flushes before its Ctrl-C lands."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
