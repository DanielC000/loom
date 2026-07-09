import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// General clean no-op done test (card ccf0bbfe). REAL git on temp repos, NO claude and NO live daemon —
// drives SessionService.workerReport() directly against an isolated LOOM_HOME (mirrors
// no-commit-reviewer.mjs's / worker-report-precheck.mjs's in-process style).
//
// THE GAP IT GUARDS: no-commit-reviewer.mjs already proves a declared no-commit ROLE (Profile/row
// noCommit=true, e.g. Code Reviewer) auto-retires cleanly on a 0-commit done. But an ORDINARY worker
// (noCommit=false) with a legitimate one-off no-op — a Web Designer mockup, a Bugfix worker that
// investigated and found no bug — had no way to say "this 0-commit done is INTENTIONAL": it got the
// misleading "forgot to commit" warning and was never auto-retired, wasting its manager's concurrency
// slot until a manual worker_stop. `report.noChanges` is the per-report declared-intent signal that
// closes this gap WITHOUT touching the noCommit role path.
//
// Proves, on a 0-commit (clean, 0-ahead) worktree, for a NORMAL (noCommit=false) worker:
//   (S) done + noChanges:true: AUTO-RETIRES (processState → exited, live-worker count drops, cap slot
//       freed with NO manual worker_stop) — AND the "forgot to commit" warning is SUPPRESSED (absent),
//       with autoRetired:true + a stop_worker(reason:no-commit-auto-retire, trigger:declared-no-op) event.
//   (W) done WITHOUT noChanges (the accidental case): the warning is STILL emitted and the worker is NOT
//       auto-retired (stays live) — the forgot-to-commit safety net is intact (THE REGRESSION GUARD).
//   (C) done WITH a real commit (noChanges NOT set): byte-identical to today — no warning, not
//       auto-retired, stays live (the normal merge path owns retirement).
//   (R) a noCommit ROLE worker (unaffected by this change): still auto-retires on its own trigger
//       (no-commit-role), proving the generalization didn't disturb the existing role-based path.
//   (E) CR follow-up: the auto-recovery re-confirmation dedupe (card 289586c7) must NOT collapse a
//       re-report that CHANGES noChanges. A worker reports done with no signal (warns, stays live),
//       crashes, auto-resumes, and re-reports done with an IDENTICAL summary but noChanges:true THIS
//       time — the dedupe must treat that as a genuinely new report (not a pure echo) so the auto-retire
//       still fires, instead of silently dropping it and stranding the worker live.
// Run: 1) build daemon (pnpm build), 2) node test/worker-noop-done.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wnd-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wnd@loom -c user.name=wnd";
const now = new Date().toISOString();

const db = new Db();
const ptyStopCalls = [];
const ptyStub = { enqueueStdin() { return { delivered: true }; }, stop(id, mode) { ptyStopCalls.push({ id, mode, at: Date.now() }); } };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const liveWorkerCount = (mgrId) => db.listWorkers(mgrId).filter((w) => w.processState === "live").length;

function seed(p, noCommit) {
  db.insertProject({ id: p.projId, name: "WND", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { maxConcurrentWorkers: 1 } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "WND-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", noCommit, parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wnd\n");
  execSync(`git init -q && git config user.email wnd@loom && git config user.name wnd && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (tag) => ({
  projId: `wnd-${tag}-proj-${sfx}`, agentId: `wnd-${tag}-ag-${sfx}`, taskId: `wnd-${tag}-task-${sfx}`,
  mgrId: `wnd-${tag}-mgr-${sfx}`, workerId: `wnd-${tag}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-wnd-${tag}-${sfx}`),
});
const S = mk("s"); // normal worker, 0-ahead, noChanges:true → auto-retire + no warning
const W = mk("w"); // normal worker, 0-ahead, no signal → warning + NOT auto-retired (safety net)
const W2 = mk("w2"); // normal worker, 0-ahead, noChanges:false explicit → same as omitted
const C = mk("c"); // normal worker WITH a commit, noChanges:true → ignored (real work to merge)
const R = mk("r"); // noCommit ROLE worker (unaffected) → still auto-retires on its own trigger
const E = mk("e"); // auto-recovery re-confirmation dedupe must not swallow a noChanges CHANGE
const all = [S, W, W2, C, R, E];

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
  // ── (S) normal worker, 0-ahead, DECLARED no-op (noChanges:true): AUTO-RETIRE + suppressed warning ──
  await build(S, { noCommit: false, commit: false });
  check("(S setup) worker is at cap (1 live worker = maxConcurrentWorkers)", liveWorkerCount(S.mgrId) === 1);
  const rS = await sessions.workerReport(S.workerId, { status: "done", summary: "investigated — no bug found", noChanges: true });
  check("(S) declared no-op done: reported:true, NOT refused", rS.reported === true && !rS.refused);
  check("(S) declared no-op done: 'forgot to commit' warning SUPPRESSED (absent)", rS.warning === undefined);
  check("(S) declared no-op done: flagged autoRetired:true", rS.autoRetired === true);
  check("(S) declared no-op done: session retired (processState exited)", db.getSession(S.workerId).processState === "exited");
  check("(S) declared no-op done: cap slot FREED — live workers 1→0 (a fresh spawn would now be admitted, no worker_stop)", liveWorkerCount(S.mgrId) === 0);
  check("(S) declared no-op done: a stop_worker(reason:no-commit-auto-retire, trigger:declared-no-op) event recorded",
    db.listEvents(S.mgrId).some((e) => e.kind === "stop_worker" && e.detail && e.detail.reason === "no-commit-auto-retire" && e.detail.trigger === "declared-no-op"));
  check("(S) declared no-op done: the worker_report(done) event still landed (report not lost)",
    db.listEvents(S.mgrId).some((e) => e.kind === "worker_report" && e.detail && e.detail.status === "done"));

  // ── (W) NORMAL worker, 0-ahead, NO signal: warning STILL emitted + NOT auto-retired (REGRESSION GUARD) ─
  await build(W, { noCommit: false, commit: false });
  const rW = await sessions.workerReport(W.workerId, { status: "done", summary: "done (forgot to commit)" });
  check("(W) normal 0-commit done (no signal): reported:true, NOT refused", rW.reported === true && !rW.refused);
  check("(W) normal 0-commit done (no signal): 'forgot to commit' warning STILL emitted", typeof rW.warning === "string" && rW.warning.includes("0 commits ahead"));
  check("(W) normal 0-commit done (no signal): NOT auto-retired (autoRetired absent)", rW.autoRetired === undefined);
  check("(W) normal 0-commit done (no signal): session stays LIVE (slot NOT freed — needs merge/stop)", db.getSession(W.workerId).processState === "live");
  check("(W) normal 0-commit done (no signal): live worker count unchanged (still 1)", liveWorkerCount(W.mgrId) === 1);
  check("(W) normal 0-commit done (no signal): NO stop_worker auto-retire event", !db.listEvents(W.mgrId).some((e) => e.kind === "stop_worker"));
  // Explicit false is the same as omitted — the accidental-case safety net is not bypassable by a stray falsy value.
  await build(W2, { noCommit: false, commit: false });
  const rWfalse = await sessions.workerReport(W2.workerId, { status: "done", summary: "done (still forgot)", noChanges: false });
  check("(W) noChanges:false behaves exactly like omitted — warning present, not auto-retired", typeof rWfalse.warning === "string" && rWfalse.autoRetired === undefined);

  // ── (C) NORMAL worker WITH a real commit, noChanges:true set anyway: IGNORED — byte-identical to today ─
  await build(C, { noCommit: false, commit: true });
  const rC = await sessions.workerReport(C.workerId, { status: "done", summary: "implemented + committed", noChanges: true });
  check("(C) committed done (noChanges set but irrelevant): no warning (real work to merge)", rC.warning === undefined);
  check("(C) committed done (noChanges set but irrelevant): NOT auto-retired", rC.autoRetired === undefined);
  check("(C) committed done (noChanges set but irrelevant): session stays LIVE (normal merge path owns retirement)", db.getSession(C.workerId).processState === "live");

  // ── (R) noCommit ROLE worker (unaffected by this change): still auto-retires on its OWN trigger ───────
  await build(R, { noCommit: true, commit: false });
  const rR = await sessions.workerReport(R.workerId, { status: "done", summary: "review complete — no findings" });
  check("(R) noCommit role done (no noChanges passed): still auto-retired (unchanged behavior)", rR.autoRetired === true && rR.warning === undefined);
  check("(R) noCommit role done: stop_worker event carries trigger:no-commit-role",
    db.listEvents(R.mgrId).some((e) => e.kind === "stop_worker" && e.detail && e.detail.trigger === "no-commit-role"));

  // ── (E) auto-recovery re-confirmation dedupe must NOT collapse a noChanges CHANGE ───────────────────
  await build(E, { noCommit: false, commit: false });
  const SAME_SUMMARY = "investigated the flaky test — root cause not reproducible";
  const eFirst = await sessions.workerReport(E.workerId, { status: "done", summary: SAME_SUMMARY });
  check("(E setup) first done (no signal): warns, NOT auto-retired", typeof eFirst.warning === "string" && eFirst.autoRetired === undefined);
  check("(E setup) session stays live after the first report", db.getSession(E.workerId).processState === "live");
  // Simulate the crash + auto-resume that sits between the two reports (mirrors what
  // crash-recovery-watcher.ts's tick actually files — see crash-recovery-coordination.mjs's (C) block).
  db.appendEvent({
    id: randomUUID(), ts: new Date().toISOString(),
    managerSessionId: E.mgrId, workerSessionId: E.workerId, taskId: E.taskId,
    kind: "session_resume_attempt", detail: { attempt: 1, maxAttempts: 3 },
  });
  const eSecond = await sessions.workerReport(E.workerId, { status: "done", summary: SAME_SUMMARY, noChanges: true });
  check("(E) re-report with an IDENTICAL summary but noChanges:true is NOT deduped as an echo (reported:true)", eSecond.reported === true);
  check("(E) re-report auto-retires (the dedupe did not swallow the noChanges change)", eSecond.autoRetired === true);
  check("(E) re-report warning suppressed (took the declared-no-op path, not the dedupe's bare drop)", eSecond.warning === undefined);
  check("(E) session actually retired (processState exited) — proves the auto-retire branch ran, not the dedupe's early return", db.getSession(E.workerId).processState === "exited");
} finally {
  db.close();
  for (const p of all) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a normal worker's declared no-op done (noChanges:true) auto-retires cleanly + suppresses the warning; an undeclared 0-commit done still warns + stays live (safety net intact); a committing done ignores the flag; the noCommit ROLE path is unchanged; and the auto-recovery re-confirmation dedupe does not swallow a re-report that changes noChanges."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
