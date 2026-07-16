import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// run_gate COMPLETION NUDGE test (card 7f96aa09, CR follow-up). worker-run-gate.mjs's own slow-path
// case (E) only proves PendingOpRegistry's generic pending→settle mechanics via a MANUALLY-constructed
// attach() callback — it never exercises the REAL closure runWorkerGate wires into pendingOps.attach,
// the one that actually FORMATS the `[loom:gate-done]`/`[loom:gate-failed]` text and DELIVERS it via
// `pty.enqueueStdin`. A regression in that message text or its delivery `kind` would pass (E) green.
//
// This test drives the REAL runWorkerGate (no `this.runGate` injection seam — a REAL spawned gate
// command) through a REAL PtyHost subclass that spies on every enqueueStdin() call, mirroring
// merge-confirm-completion-nudge.mjs's proven pattern for the sibling merge-gate nudge.
//
// NOT tunable-fast: SYNC_ATTACH_BUDGET_MS (12s) is not injectable, so proving the REAL async/pending
// path needs a gate that outlives it — at least ~13s wall-clock per scenario, longer under CPU
// contention (the post-budget wait polls for the completion nudge instead of sleeping a fixed
// duration — see waitUntil below). Still fully hermetic (in-process, no daemon, no network).
//
// Proves:
//   (1) PASS, async: the completion nudge fires exactly once, kind:"warning", into the WORKER's OWN
//       session (not a manager — the caller and beneficiary are the same session for this op kind),
//       naming `[loom:gate-done]` and carrying the correlation opId the pending response returned.
//   (2) FAIL, async: `[loom:gate-failed]` fires with the same shape, naming "build gate failed" and
//       the same opId.
//   (3) FAST path (an instant gate): NO completion nudge fires at all — the synchronous caller already
//       has the outcome inline; a push here would double-notify.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-run-gate-completion-nudge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Slack for the bounded-op LOWER-bound timing assertion below, mirroring merge-confirm-completion-nudge's
// TIMER_SLACK_MS (same fix class as the v0.3.0 release CI Date.now() flake) — measured with the MONOTONIC
// performance.now(), not Date.now().
const TIMER_SLACK_MS = 50;
// Poll for the async completion nudge instead of a fixed sleep — under CPU contention the 13s gate
// process (spawn + setTimeout) and the terminal callback can land well past any hardcoded wait.
async function waitUntil(predicate, timeoutMs, intervalMs = 200) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

const tmpHome = path.join(os.tmpdir(), `loom-wgn-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=wgn@loom -c user.name=wgn";
const now = new Date().toISOString();

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
// SPY: records every enqueueStdin() call (incl. `kind`, the 6th arg) then delegates to the real
// implementation — mirrors merge-confirm-completion-nudge.mjs's SpyHost exactly.
class SpyHost extends SeamHost {
  enqueueCalls = [];
  enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId) {
    this.enqueueCalls.push({ sessionId, text, kind });
    return super.enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId);
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const db = new Db();
const host = new SpyHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

function makeRepo() {
  const repo = path.join(os.tmpdir(), `loom-wgn-repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wgn\n");
  execSync(`git init -q && git config user.email wgn@loom && git config user.name wgn && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  return repo;
}
function seedWorker(projId, repo, gateCommand, worktreePath, branch) {
  db.insertProject({ id: projId, name: "WGN", repoPath: repo, vaultPath: repo, config: gateCommand ? { orchestration: { gateCommand } } : {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${projId}-mgr`, projectId: projId, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: `${projId}-dev`, projectId: projId, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
  const mgrId = `${projId}-mgr1`, workerId = `${projId}-wkr`;
  db.insertSession({ id: mgrId, projectId: projId, agentId: `${projId}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerId, projectId: projId, agentId: `${projId}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath, branch });
  return { mgrId, workerId };
}

const worktrees = [];
try {
  // ============================ (1) PASS, async: completion nudge fires exactly once ============================
  {
    const P = "wgn-pass", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t1");
    // A gate that outlives SYNC_ATTACH_BUDGET_MS (12s) then exits 0.
    const { workerId } = seedWorker(P, repo, `node -e "setTimeout(()=>process.exit(0), 13000)"`, worktreePath, branch);

    const t0 = performance.now(); // MONOTONIC (see TIMER_SLACK_MS)
    const first = await svc.runWorkerGate(workerId);
    const elapsed = performance.now() - t0;
    check(`(1) degrades to pending past the sync-wait budget (elapsed=${Math.round(elapsed)}ms)`, first.settled === false && elapsed >= 9_000 - TIMER_SLACK_MS);
    check("(1) NO completion nudge yet — the op is still running in the background", !host.enqueueCalls.some((c) => c.sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(c.text)));
    const pendingOpId1 = first.op.opId;
    check("(1) the pending response carries a real opId", typeof pendingOpId1 === "string" && pendingOpId1.length > 0);

    // Let the 13s gate actually finish + the terminal callback fire — poll rather than a fixed sleep.
    await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(c.text)), 20_000);
    const nudges = host.enqueueCalls.filter((c) => c.sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(c.text));
    check("(1) exactly ONE completion nudge landed for this worker", nudges.length === 1);
    check("(1) it's the PASS nudge, naming gate-done", nudges[0] && /\[loom:gate-done\]/.test(nudges[0].text));
    check("(1) pushed with kind:\"warning\" (a Loom operational nudge — same-route coalescing is correct)", nudges[0] && nudges[0].kind === "warning");
    check("(1) delivered to the WORKER's OWN session (not any manager)", nudges[0] && nudges[0].sessionId === workerId);
    check("(1) carries the SAME opId the pending response returned (correlation stamp)", nudges[0] && nudges[0].text.includes(pendingOpId1));
    worktrees.push([repo, worktreePath]);
  }

  // ============================ (2) FAIL, async: [loom:gate-failed] fires ============================
  {
    const P = "wgn-fail", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t2");
    // A gate that outlives SYNC_ATTACH_BUDGET_MS (12s) then exits non-zero.
    const { workerId } = seedWorker(P, repo, `node -e "setTimeout(()=>process.exit(1), 13000)"`, worktreePath, branch);

    const first = await svc.runWorkerGate(workerId);
    check("(2) degrades to pending past the sync-wait budget", first.settled === false);
    const pendingOpId2 = first.op.opId;

    await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(c.text)), 20_000);
    const nudges = host.enqueueCalls.filter((c) => c.sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(c.text));
    check("(2) exactly ONE completion nudge landed", nudges.length === 1);
    check("(2) it's the FAILURE nudge, naming gate-failed + the reason", nudges[0] && /\[loom:gate-failed\]/.test(nudges[0].text) && /build gate failed/.test(nudges[0].text));
    check("(2) pushed with kind:\"warning\"", nudges[0] && nudges[0].kind === "warning");
    check("(2) delivered to the WORKER's OWN session (not any manager)", nudges[0] && nudges[0].sessionId === workerId);
    check("(2) carries the SAME opId the pending response returned", nudges[0] && nudges[0].text.includes(pendingOpId2));
    worktrees.push([repo, worktreePath]);
  }

  // ============================ (3) FAST path: no completion nudge ============================
  {
    const P = "wgn-fast", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t3");
    const { workerId } = seedWorker(P, repo, `node -e "process.exit(0)"`, worktreePath, branch);

    const r = await svc.runWorkerGate(workerId);
    check("(3) settles within the sync-wait budget (fast path)", r.settled === true && r.ok === true && r.value.passed === true);
    check("(3) the fast path stays byte-identical — NO completion nudge ever fires for it", !host.enqueueCalls.some((c) => c.sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(c.text)));
    worktrees.push([repo, worktreePath]);
  }
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — runWorkerGate's REAL onSettledAfterPending closure formats + delivers exactly one [loom:gate-done]/[loom:gate-failed] completion nudge into the calling WORKER's own session, kind:\"warning\", stamped with the correlation opId, on a genuinely async (>SYNC_ATTACH_BUDGET_MS) gate — and pushes nothing at all on the already-fast synchronous path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
