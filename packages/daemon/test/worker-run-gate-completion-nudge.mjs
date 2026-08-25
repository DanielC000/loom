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
// TUNABLE-FAST (card 63bdd2cc): SessionService's `syncAttachBudgetMs` opt (card 0faaaa55's DI seam)
// shrinks the production 12s SYNC_ATTACH_BUDGET_MS down to TEST_SYNC_BUDGET_MS below — the REAL
// subprocess gate then only needs to outlive THAT budget (SLOW_GATE_MS/TIMEOUT_KILL_MS), not the real
// 12s one — mirroring merge-confirm-completion-nudge.mjs's fix for the sibling "merge" op kind. The gate
// command itself stays a real spawned `node -e` subprocess throughout (scenario (4) needs a REAL SIGKILL
// timeout-kill); only the SYNC-WAIT THRESHOLD deciding pending-vs-inline is shrunk. Still fully hermetic
// (in-process, no daemon, no network) and the post-budget wait polls for the completion nudge instead of
// sleeping a fixed duration (see waitUntil below), so this stays robust to CPU contention.
//
// Proves:
//   (1) PASS, async: the completion nudge fires exactly once, kind:"warning", into the WORKER's OWN
//       session (not a manager — the caller and beneficiary are the same session for this op kind),
//       naming `[loom:gate-done]` and carrying the correlation opId the pending response returned.
//   (2) FAIL, async: `[loom:gate-failed]` fires with the same shape, naming "build gate failed" and
//       the same opId.
//   (3) FAST path (an instant gate): NO completion nudge fires at all — the synchronous caller already
//       has the outcome inline; a push here would double-notify.
//   (4) TIMEOUT, async (card edc1ec12 — Platform-Audit finding 7afa6ea9): a gate step killed by OUR OWN
//       `gateCommandTimeoutMs` bound (not a plain non-zero exit — a REAL SIGKILL via runGateStep's own
//       timeout) still settles the pending op and fires `[loom:gate-failed]` with timeout wording. This is
//       the exact failure mode the audit finding describes as silent ("each run_gate re-call minted a new
//       pending opId, no [loom:gate-failed] ever arrived") — proving the generic onSettledAfterPending
//       wiring (verified by (1)/(2) above) also holds for THIS specific cause, not just a clean non-zero exit.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-run-gate-completion-nudge.mjs
//
// PILOT CONVERSION (card 995be21f, Shape 1 — this file's `repo` fixtures were tracked in the `worktrees`
// tuple but only ever passed to removeWorktree(), a git op; the bare repo DIRECTORY was never
// fs.rmSync'd, leaking 4 repos/run). Prefixes unchanged byte-for-byte ("loom-wgn-", "loom-wgn-repo-");
// mkdtempManaged replaces the hand-rolled Date.now()/pid suffixing with a real kernel-unique
// fs.mkdtempSync AND registers each dir for guaranteed cleanup in the same call — so the repo dir is now
// cleaned up regardless of whether the `worktrees` bookkeeping below is complete or correct.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

// Disables runGateStep's one-time auto-extend (card 24642c3d) for the WHOLE file — a module-load-time
// constant, so this must be set before gate-runner.js is ever imported (transitively, via service.js
// below). Harmless for scenarios (1)-(3): none of them ever reach the timeout-kill branch, only (4) does.
// Without this, a silent (zero-output) hanging command would still get ONE extension (idleMs at the
// deadline is measured from process start, which reads as "recently active" against the 60s default
// threshold) — doubling scenario (4)'s wall-clock for no test value.
process.env.LOOM_GATE_TIMEOUT_EXTEND_ENABLED = "0";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Slack for the bounded-op LOWER-bound timing assertion below, mirroring merge-confirm-completion-nudge's
// TIMER_SLACK_MS (same fix class as the v0.3.0 release CI Date.now() flake) — measured with the MONOTONIC
// performance.now(), not Date.now().
const TIMER_SLACK_MS = 50;
// Injected SessionService.syncAttachBudgetMs (see the file-header comment). SLOW_GATE_MS/TIMEOUT_KILL_MS
// are the real subprocess gate's own hold duration for (1)/(2)/(4) — 3x the budget, chosen so
// degrade-to-pending shouldn't be a close race even under CPU contention (a bare `setTimeout` in a
// dedicated child process is not itself CPU-contention-sensitive the way real git work is, but no
// scheduling margin is provably immune under arbitrary load — see TEST_FAST_PATH_BUDGET_MS's own doc on
// card e082bf4d). Scenario (3) (the FAST/instant-gate path) uses its OWN larger budget
// (TEST_FAST_PATH_BUDGET_MS, via a separate SessionService instance below, mirroring
// merge-confirm-completion-nudge.mjs's fix) — its real synchronous gate-run work measured consistently
// >500ms here, so it needs headroom (1)/(2)/(4) don't: they only ever need to clear the small budget
// before their own artificial gate delay, never to actually settle inline.
const TEST_SYNC_BUDGET_MS = 500;
// GENEROUS — deliberately WIDER than the 12_000ms production SYNC_ATTACH_BUDGET_MS (card e082bf4d, landed
// on main): (3) is a REAL child-process gate spawn racing that wall-clock to prove the SYNCHRONOUS-settle
// path, and e082bf4d measured confirmWorkerMergeTracked (the sibling "merge" op kind) exceeding even the
// stock 12s production budget under host contention (~1/10 at 24x CPU oversubscription) — not itself
// reproduced for THIS "gate" op kind, but the real settle here (measured consistently >500ms, well under
// either value) sits far below EITHER budget in the common case, so widening this costs zero wall-clock
// while closing off the same class of flake e082bf4d found on the merge side. This is the SAME test-only
// widening e082bf4d applied to merge-spawn-tracked.mjs and this file's sibling
// merge-confirm-completion-nudge.mjs — production's own SYNC_ATTACH_BUDGET_MS constant is untouched.
const TEST_FAST_PATH_BUDGET_MS = 60_000;
const SLOW_GATE_MS = 1500;
const TIMEOUT_KILL_MS = 1500;
// Poll for the async completion nudge instead of a fixed sleep — under CPU contention the gate process
// (spawn + setTimeout) and the terminal callback can land well past any hardcoded wait.
// Retrofitted onto the shared _wait.mjs waitUntil (card 24d2e0ac): same timeoutMs/intervalMs budget
// (still monotonic — the shared helper uses performance.now() internally too), still does a final
// `predicate()` re-check on timeout (unchanged) instead of hardcoding false.
async function waitUntil(predicate, timeoutMs, intervalMs = 200) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: "worker-run-gate-completion-nudge: predicate" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return predicate();
  }
}

const tmpHome = mkdtempManaged("loom-wgn-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=wgn@loom -c user.name=wgn";
const now = new Date().toISOString();

class SeamHost extends createSeamHost(PtyHost) {}
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
const svc = new SessionService(db, host, new OrchestrationControl(), { syncAttachBudgetMs: TEST_SYNC_BUDGET_MS });
// Separate instance, SAME db/host, only for scenario (3)'s fast-path budget — see TEST_FAST_PATH_BUDGET_MS's
// doc. The two instances' pendingOps registries are independent, and each scenario uses a distinct worker
// id, so there's no cross-instance key collision.
const svcFast = new SessionService(db, host, new OrchestrationControl(), { syncAttachBudgetMs: TEST_FAST_PATH_BUDGET_MS });

function makeRepo() {
  const repo = mkdtempManaged("loom-wgn-repo-");
  fs.writeFileSync(path.join(repo, "README.md"), "# wgn\n");
  execSync(`git init -q && git config user.email wgn@loom && git config user.name wgn && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  return repo;
}
function seedWorker(projId, repo, gateCommand, worktreePath, branch, orchestrationExtra) {
  const orchestration = gateCommand ? { gateCommand, ...orchestrationExtra } : undefined;
  db.insertProject({ id: projId, name: "WGN", repoPath: repo, vaultPath: repo, config: orchestration ? { orchestration } : {}, createdAt: now, archivedAt: null });
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
    // A gate that outlives the injected syncAttachBudgetMs then exits 0.
    const { workerId } = seedWorker(P, repo, `node -e "setTimeout(()=>process.exit(0), ${SLOW_GATE_MS})"`, worktreePath, branch);

    const t0 = performance.now(); // MONOTONIC (see TIMER_SLACK_MS)
    const first = await svc.runWorkerGate(workerId);
    const elapsed = performance.now() - t0;
    // Lower bound at 75% of the injected budget — the ORIGINAL 12s-budget/9s-threshold check used exactly
    // this ratio (9_000 / 12_000 = 0.75); this is that same shape, scaled to the shrunk budget (325ms
    // floor against the 500ms budget, well under the measured ~500-700ms elapsed).
    check(`(1) degrades to pending past the sync-wait budget (elapsed=${Math.round(elapsed)}ms)`, first.settled === false && elapsed >= Math.floor(TEST_SYNC_BUDGET_MS * 0.75) - TIMER_SLACK_MS);
    check("(1) NO completion nudge yet — the op is still running in the background", !host.enqueueCalls.some((c) => c.sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(c.text)));
    const pendingOpId1 = first.op.opId;
    check("(1) the pending response carries a real opId", typeof pendingOpId1 === "string" && pendingOpId1.length > 0);

    // Let the SLOW_GATE_MS gate actually finish + the terminal callback fire — poll rather than a fixed sleep.
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
    // A gate that outlives the injected syncAttachBudgetMs then exits non-zero.
    const { workerId } = seedWorker(P, repo, `node -e "setTimeout(()=>process.exit(1), ${SLOW_GATE_MS})"`, worktreePath, branch);

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

    const r = await svcFast.runWorkerGate(workerId);
    check("(3) settles within the sync-wait budget (fast path)", r.settled === true && r.ok === true && r.value.passed === true);
    check("(3) the fast path stays byte-identical — NO completion nudge ever fires for it", !host.enqueueCalls.some((c) => c.sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(c.text)));
    worktrees.push([repo, worktreePath]);
  }

  // ================ (4) TIMEOUT, async: [loom:gate-failed] fires with timeout wording (edc1ec12) ================
  {
    const P = "wgn-timeout", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t4");
    // A gate that NEVER exits and produces NO output — killed by our own gateCommandTimeoutMs
    // (TIMEOUT_KILL_MS), deliberately > the injected syncAttachBudgetMs so this call degrades to pending
    // FIRST, then the timeout-kill happens a moment later, exercising the ASYNC settle path (not the
    // fast/sync one gate-timeout-tree-kill.mjs already covers).
    const { workerId } = seedWorker(P, repo, `node -e "setInterval(()=>{},1000)"`, worktreePath, branch, { gateCommandTimeoutMs: TIMEOUT_KILL_MS });

    const first = await svc.runWorkerGate(workerId);
    check("(4) degrades to pending past the sync-wait budget", first.settled === false);
    const pendingOpId4 = first.op.opId;

    // Let the TIMEOUT_KILL_MS timeout actually fire + the terminal callback push — poll rather than a fixed sleep.
    await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(c.text)), 20_000);
    const nudges = host.enqueueCalls.filter((c) => c.sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(c.text));
    check("(4) exactly ONE completion nudge landed", nudges.length === 1);
    check("(4) it's the FAILURE nudge, naming gate-failed + timeout wording (not a plain 'build gate failed')", nudges[0] && /\[loom:gate-failed\]/.test(nudges[0].text) && /gate timed out/.test(nudges[0].text));
    check("(4) pushed with kind:\"warning\"", nudges[0] && nudges[0].kind === "warning");
    check("(4) delivered to the WORKER's OWN session (not any manager)", nudges[0] && nudges[0].sessionId === workerId);
    check("(4) carries the SAME opId the pending response returned", nudges[0] && nudges[0].text.includes(pendingOpId4));
    worktrees.push([repo, worktreePath]);
  }
} finally {
  // removeWorktree is still needed here — it's a git-level operation (branch/worktree bookkeeping), not
  // just a directory removal. The `repo` DIRECTORY itself no longer depends on this loop being complete
  // or correct: mkdtempManaged already registered it for guaranteed cleanup at process exit.
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — runWorkerGate's REAL onSettledAfterPending closure formats + delivers exactly one [loom:gate-done]/[loom:gate-failed] completion nudge into the calling WORKER's own session, kind:\"warning\", stamped with the correlation opId, on a genuinely async (>SYNC_ATTACH_BUDGET_MS) gate — including a REAL SIGKILL timeout, not just a plain non-zero exit — and pushes nothing at all on the already-fast synchronous path."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1); // awaits real cleanup, then exits deterministically — no hang-on-drain risk
