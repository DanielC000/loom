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
//   (R2) IDLE-WAIT COMMON PATH (board card ce7d99bb): the worker is still BUSY (mid-turn, generating a
//       post-report recap) when workerReport(done) returns — pty.stop must NOT fire immediately. Once
//       the turn ends naturally (busy flips false, simulating the worker's own Stop hook — the SAME
//       edge that normally captures ctx metrics), the deferred graceful stop lands on an ALREADY-IDLE
//       session (wasBusyWhenStopped:false — no interrupt-while-busy, so no false "[Request interrupted
//       by user]" artifact) AND the archived row carries ctx metrics (model/ctxInputTokens/ctxTurns),
//       captured via the SAME readContextStats/setContextCounters snapshot the Stop hook itself uses.
//   (F) BOUNDED-TIMEOUT FALLBACK (ce7d99bb): a worker that NEVER goes idle (a genuinely wedged/still-
//       generating final turn) still gets force-stopped once the bounded wait (shrunk via
//       LOOM_AUTO_RETIRE_IDLE_WAIT_MS below) elapses — wasBusyWhenStopped:true is the accepted residual
//       (the interrupt is unavoidable there) — but ctx metrics are STILL captured (belt-and-suspenders:
//       the explicit snapshot runs before the stop on EITHER path, so this is the one case where it's
//       load-bearing rather than a reconfirmation). The concurrency slot frees on both (R2) and (F).
// Run: 1) build daemon (pnpm build), 2) node test/no-commit-reviewer.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ncr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
// Shrink the bounded wait-for-idle (real default 25s) so the (F) fallback-timeout scenario below
// doesn't have to wait out the real bound — read once at module load, so this MUST be set before
// sessions/service.js is imported. Deliberately generous (not shaved to the bone — CR follow-up on
// ce7d99bb, same class as the worker-run-gate.mjs timing flakes fixed this session): (R2) flips busy
// false on the very next tick and then POLLS for the stop call rather than sleeping a fixed guess, so
// its own margin against this bound is enormous regardless of runner load; (F) must let the full
// bound actually elapse, so a generous value here just means a slower (never flaky) fallback check.
process.env.LOOM_AUTO_RETIRE_IDLE_WAIT_MS = "5000";

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// Poll for `condFn()` to go true rather than sleeping a fixed guessed duration (CR follow-up on
// ce7d99bb — the same class of tight-margin timing flake as worker-run-gate.mjs's (L)/(J), fixed this
// session): resolves as soon as the condition is met, so it's fast on a healthy run and only ever
// slow — never flaky — on a loaded one, up to `timeoutMs`.
async function waitFor(condFn, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condFn()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return condFn();
}
const GIT_ID = "-c user.email=ncr@loom -c user.name=ncr";
const now = new Date().toISOString();

const db = new Db();
// workerReport touches pty.enqueueStdin (manager notification) and, on the auto-retire path,
// pty.isAlive/isBusy (the new bounded wait-for-idle, card ce7d99bb) then pty.stop. `ptyState` is a
// per-session `{alive, busy}` the test drives directly (standing in for the real live pty), so this
// stays hermetic — no real claude, no live daemon. `stop()` records whether the session was still
// BUSY at the moment it was called (`wasBusyWhenStopped`) — the proxy this test uses for "would the
// CLI have seen an interrupt-while-generating" (and so stamped its own false "[Request interrupted by
// user]" line) vs. a clean idle exit.
const ptyStopCalls = [];
const ptyState = new Map();
const ptyStub = {
  enqueueStdin() { return { delivered: true }; },
  isAlive(id) { return ptyState.get(id)?.alive ?? false; },
  isBusy(id) { return ptyState.get(id)?.busy ?? false; },
  stop(id, mode) {
    const st = ptyState.get(id);
    ptyStopCalls.push({ id, mode, at: Date.now(), wasBusyWhenStopped: st?.busy === true });
    if (st) st.alive = false;
  },
};
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

// EXACTLY what spawnWorker's maxConcurrentWorkers cap check counts (live workers under the manager).
const liveWorkerCount = (mgrId) => db.listWorkers(mgrId).filter((w) => w.processState === "live").length;

function seed(p, noCommit) {
  // cap=1 so "one reviewer is at cap" is concrete (the live-count assertions read the same quantity).
  db.insertProject({ id: p.projId, name: "NCR", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { maxConcurrentWorkers: 1 } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "NCR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // The worker carries noCommit PINNED on the row (exactly as spawnWorker pins it from the resolved
  // Profile) and an engineSessionId (card ce7d99bb: the ctx-metrics snapshot reads the transcript at
  // engineTranscriptPath(cwd, engineSessionId), keyed off these SAME durable row fields).
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: p.engineSessionId ?? null, title: null, cwd: p.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", noCommit, parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# ncr\n");
  execSync(`git init -q && git config user.email ncr@loom && git config user.name ncr && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

// Fixture transcript writer (mirrors context-stats.mjs's pattern): one assistant line carrying
// `usage` — standing in for the worker_report tool-call turn's own streamed usage, which is already
// on disk by the time workerReport's MCP handler runs, independent of whether the full turn (and its
// Stop hook) has ended yet.
const transcriptDirs = [];
function writeUsageFixture(cwd, engineSessionId, usage, model) {
  const file = engineTranscriptPath(cwd, engineSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  transcriptDirs.push(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "review complete" }], model, usage } }) + "\n");
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (tag) => ({
  projId: `ncr-${tag}-proj-${sfx}`, agentId: `ncr-${tag}-ag-${sfx}`, taskId: `ncr-${tag}-task-${sfx}`,
  mgrId: `ncr-${tag}-mgr-${sfx}`, workerId: `ncr-${tag}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-ncr-${tag}-${sfx}`),
  engineSessionId: `ncr-${tag}-engine-${sfx}`,
});
const R = mk("r"); // declared no-commit, 0-ahead → auto-retire + no warning
const N = mk("n"); // normal worker, 0-ahead → warning + NOT auto-retired (safety net)
const C = mk("c"); // normal worker WITH a commit → no warning, not auto-retired
const F = mk("f"); // declared no-commit, NEVER goes idle → bounded-timeout fallback
const all = [R, N, C, F];

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
  // Still BUSY when workerReport(done) is called — the worker_report tool call is itself mid-turn.
  ptyState.set(R.workerId, { alive: true, busy: true });
  writeUsageFixture(R.worktreePath, R.engineSessionId, { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 50, output_tokens: 20 }, "claude-opus-4-8");
  const rR = await sessions.workerReport(R.workerId, { status: "done", summary: "review complete — no findings" });
  check("(R) no-commit reviewer done: pty.stop NOT called synchronously (worker still busy)", ptyStopCalls.length === 0);
  check("(R) no-commit reviewer done: reported:true, NOT refused", rR.reported === true && !rR.refused);
  check("(R) no-commit reviewer done: 'forgot to commit' warning SUPPRESSED (absent)", rR.warning === undefined);
  check("(R) no-commit reviewer done: flagged autoRetired:true", rR.autoRetired === true);
  check("(R) no-commit reviewer done: session retired (processState exited) — SLOT FREES BEFORE the stop lands", db.getSession(R.workerId).processState === "exited");
  check("(R) no-commit reviewer done: cap slot FREED — live workers 1→0 (a fresh spawn would now be admitted, no worker_stop)", liveWorkerCount(R.mgrId) === 0);
  check("(R) no-commit reviewer done: a stop_worker(reason:no-commit-auto-retire) event recorded",
    db.listEvents(R.mgrId).some((e) => e.kind === "stop_worker" && e.detail && e.detail.reason === "no-commit-auto-retire"));
  check("(R) no-commit reviewer done: the worker_report(done) event still landed (report not lost)",
    db.listEvents(R.mgrId).some((e) => e.kind === "worker_report" && e.detail && e.detail.status === "done"));
  check("(R) no-commit reviewer done: worker_report event carries NO warning", (() => {
    const ev = db.listEvents(R.mgrId).find((e) => e.kind === "worker_report");
    return ev && ev.detail && ev.detail.warning === undefined;
  })());

  // (R2) IDLE-WAIT COMMON PATH: the worker's own turn ends naturally — simulating its Stop hook firing
  // on the very next tick, well before the shrunk (but generous) bound — and the deferred stop must
  // wait for that, then land on an ALREADY-IDLE session (no interrupt-while-busy), with ctx metrics
  // present. Flips busy false on the next tick (not a guessed real-time delay) and POLLS for the stop
  // call rather than sleeping a fixed duration, so this has enormous margin against the bound
  // regardless of runner load — see `waitFor`'s doc.
  setTimeout(() => { const st = ptyState.get(R.workerId); if (st) st.busy = false; }, 0);
  await waitFor(() => ptyStopCalls.some((c) => c.id === R.workerId), { timeoutMs: 4000 });
  check("(R2) idle-wait common path: pty.stop fires exactly once, once busy naturally clears",
    ptyStopCalls.length === 1 && ptyStopCalls[0].id === R.workerId && ptyStopCalls[0].mode === "graceful");
  check("(R2) idle-wait common path: stop landed on an ALREADY-IDLE session — wasBusyWhenStopped:false (no interrupt-while-busy, so no false '[Request interrupted by user]')",
    ptyStopCalls[0].wasBusyWhenStopped === false);
  check("(R2) idle-wait common path: ctx metrics captured on the archived row (model/ctxInputTokens/ctxTurns)", (() => {
    const s = db.getSession(R.workerId);
    return s.model === "claude-opus-4-8" && s.ctxInputTokens === 1250 && s.ctxTurns === 1;
  })());

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

  // ── (F) BOUNDED-TIMEOUT FALLBACK: a worker that NEVER goes idle still gets force-stopped ──────────
  await build(F, { noCommit: true, commit: false });
  ptyState.set(F.workerId, { alive: true, busy: true }); // never flips false — a genuinely wedged/still-generating final turn
  writeUsageFixture(F.worktreePath, F.engineSessionId, { input_tokens: 3000, cache_read_input_tokens: 400, cache_creation_input_tokens: 60, output_tokens: 30 }, "claude-sonnet-5");
  const rF = await sessions.workerReport(F.workerId, { status: "done", summary: "review complete — no findings", noChanges: true });
  check("(F) fallback: reported:true, autoRetired:true, slot freed immediately (unchanged from (R))",
    rF.reported === true && rF.autoRetired === true && db.getSession(F.workerId).processState === "exited");
  check("(F) fallback: pty.stop NOT called synchronously (still within the bounded wait)", !ptyStopCalls.some((c) => c.id === F.workerId));
  // Never goes idle, so this MUST let the full (generous, but shrunk) bound actually elapse — poll
  // rather than a fixed sleep so a loaded runner gets more real time to reach the deadline instead of
  // racing a guessed duration (see `waitFor`'s doc); timeoutMs is comfortably past the bound itself.
  await waitFor(() => ptyStopCalls.some((c) => c.id === F.workerId), { timeoutMs: 9000 });
  check("(F) fallback: pty.stop DOES fire once the bounded wait times out, even though STILL busy — the accepted residual", (() => {
    const c = ptyStopCalls.find((c) => c.id === F.workerId);
    return c && c.mode === "graceful" && c.wasBusyWhenStopped === true;
  })());
  check("(F) fallback: ctx metrics STILL captured despite the forced interrupt (belt-and-suspenders capture runs BEFORE the stop)", (() => {
    const s = db.getSession(F.workerId);
    return s.model === "claude-sonnet-5" && s.ctxInputTokens === 3460 && s.ctxTurns === 1;
  })());
} finally {
  db.close();
  for (const p of all) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  for (const dir of transcriptDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a declared no-commit worker auto-retires (cap slot freed, no worker_stop) + the warning is suppressed; a NORMAL 0-commit worker still warns + stays live (safety net intact); the deferred graceful pty.stop waits (bounded) for the worker's own turn to end naturally, capturing ctx metrics via the same snapshot the Stop hook uses on both the common idle path and the bounded-timeout fallback."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
