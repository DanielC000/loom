import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_merge_confirm COMPLETION NUDGE test — when a gate genuinely takes a while, worker_merge_confirm
// degrades to {opId,status:"pending"} and the manager used to have no way to learn the outcome without
// spin-polling (re-calling the tool / worker_list.pendingMerge). confirmWorkerMergeTracked now wires
// PendingOpRegistry.attach's `onSettledAfterPending` to push a `[loom:merge-done]`/`[loom:merge-failed]`
// nudge into the ASKING MANAGER's session the moment the async gate/merge actually terminates — even if
// the manager never re-polls.
//
// REAL git + a REAL PtyHost (fake createPty seam — no claude, no live daemon), mirroring
// merge-spawn-tracked.mjs's in-process style, with a SPY subclass recording every enqueueStdin() call so
// the exact text + kind pushed to the manager can be asserted directly (kind is not observable through
// any public getPending*/worker_list surface, only at the enqueueStdin call boundary itself).
//
// TUNABLE-FAST (card 63bdd2cc): SessionService's `syncAttachBudgetMs` opt (card 0faaaa55's DI seam,
// already used by pending-op-settle-lineage.mjs/run-gate-cancelled-retention.mjs/etc.) shrinks the
// production 12s SYNC_ATTACH_BUDGET_MS down to TEST_SYNC_BUDGET_MS below — the REAL subprocess gate then
// only needs to outlive THAT budget (SLOW_GATE_MS), not the real 12s one. Unlike those other files, this
// one deliberately does NOT use the separate injectable `runGate` seam — scenario (6) needs a REAL
// SIGKILL timeout-kill of a REAL hung child process, which no injected async function can exercise — so
// the gate command itself stays a real spawned `node -e` subprocess throughout; only the SYNC-WAIT
// THRESHOLD that decides pending-vs-inline is shrunk. Still fully hermetic (in-process daemon code, no
// live claude, no network) and the post-budget wait polls for the completion nudge instead of sleeping a
// fixed duration (see waitUntil below), so this stays robust to CPU contention slowing the subprocess.
//
// Proves:
//   (1) MERGED, async: the completion nudge fires exactly once, kind:"warning", naming the worker + "merged",
//       and carries an `opId` correlation stamp matching the `pending` response's own opId (card 369d8824).
//   (2) GATE-FAILED, async, GENUINE (unresolved) rejection: the rich `[loom:merge-rejected]` (rejectNotify,
//       kind:"agent") fires — and it is the ONLY terminal signal delivered; the generic completion-nudge
//       `[loom:merge-failed]` echo is SUPPRESSED (card 9eea3901 — the double-notify fix: `notified:true` on
//       the ConfirmMergeResult tells `onSettledAfterPending` the manager was already told). Carries opId too.
//   (3) FAST path (gate resolves well within the sync-wait budget): NO completion nudge fires at all — the
//       synchronous caller already has the outcome inline; a push here would double-notify.
//   (4) GATE-FAILED, async, SUPPRESSED rejection (task's card already Done — shouldSuppressMergeReject
//       reconciles the rich notify away): the generic `[loom:merge-failed]` completion nudge is the SOLE
//       terminal signal (`notified:false` ⇒ onSettledAfterPending must NOT skip it, or the manager would
//       hear nothing at all about this async op).
//   (5) ALREADY_MERGED, async (card 187f5b76 — the double-fire this card fixes): the branch's work is
//       already in main BEFORE the confirm starts, but the worktree is still present and the task not yet
//       terminal, so the pending gate still runs and `mergeBranch`'s own noop/ALREADY_MERGED classification
//       reaches `finishAlreadyMerged` from INSIDE the async run. finishAlreadyMerged pushes the rich
//       `[loom:already-merged]` directly and stamps `notified:true` — proving `onSettledAfterPending` does
//       NOT also push a generic `[loom:merge-done]` echo for the SAME op (the exact double-fire this card
//       closes: both used to fire for one logical completion). Exactly ONE terminal signal lands, and it
//       carries the worker id, task id, AND the `opId` correlation stamp.
//   (6) TIMEOUT, async (card edc1ec12 — Platform-Audit finding 7afa6ea9): a gate step killed by OUR OWN
//       `gateCommandTimeoutMs` bound (a REAL SIGKILL via runGateStep's own timeout, not a plain non-zero
//       exit) still settles the pending merge op and fires the rich `[loom:merge-rejected]` with timeout
//       wording — proving the onSettledAfterPending wiring (already verified by (1)/(2)/(4)/(5) above)
//       also holds for the specific failure mode the audit finding describes as silent.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-completion-nudge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

// Both read LIVE (per-call, via resolveConfig) — not module-load-time constants — so setting them here
// affects every scenario in this file uniformly; harmless for (1)-(5), which never reach a timeout-kill
// or a retry-eligible classification. Disables runGateStep's one-time auto-extend (card 24642c3d) so
// scenario (6)'s silent hanging command is killed at the FIRST deadline instead of getting an extra
// extension (idleMs at the deadline reads as "recently active" against the 60s default threshold for a
// command that has never produced output). Disables the merge-gate's own transient-kill auto-retry so
// scenario (6) doesn't pay a SECOND full gateCommandTimeoutMs wait for a retry that would just time out
// again against the same hanging command.
process.env.LOOM_GATE_TIMEOUT_EXTEND_ENABLED = "0";
process.env.LOOM_GATE_RETRY_ENABLED = "0";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Slack for the bounded-op LOWER-bound timing assertion below. Durations are measured with the MONOTONIC
// performance.now() (not Date.now()), so a wall-clock NTP/virtualization backward step can't make elapsed
// read under the budget; this slack additionally absorbs libuv's sub-ms early timer fire. Mirrors
// worktrees.mjs's TIMER_SLACK_MS (same fix class as the v0.3.0 release CI Date.now() flake).
const TIMER_SLACK_MS = 50;
// Injected SessionService.syncAttachBudgetMs (see the file-header comment) — the sync-wait threshold
// confirmWorkerMergeTracked races against before degrading to {settled:false}. Measured standalone
// (_diag-fastpath-scratch.mjs, 3 runs): a REAL no-gate merge's own git squash/finalize work alone takes
// ~2.0-2.5s wall-clock — that's genuine synchronous git cost, not an artificial wait, and scenario (3)
// (the FAST/no-gate path) needs a budget comfortably above it or it would falsely degrade to pending too.
// Scenarios (1)/(2)/(4)/(5)/(6) don't need that headroom — they only need their OWN budget to clear
// BEFORE the artificial gate delay, so they use `svc` (the small budget) while (3) alone uses `svcFast`
// (a separate SessionService instance sharing the same db/host, see below): shrinking the (1)/(2)/(4)/(5)/
// (6) budget (and so their gate delay, which only has to clear THAT budget) doesn't touch (3)'s margin.
// (3) only — GENEROUS, deliberately WIDER than the 12_000ms production SYNC_ATTACH_BUDGET_MS (card
// e082bf4d, landed on main): (3) is a REAL git worktree merge racing that wall-clock to prove the
// SYNCHRONOUS-settle path, and e082bf4d measured the real settle occasionally exceeding even the stock
// 12s production budget under host contention (~1/10 at 24x CPU oversubscription) — a false failure with
// nothing actually wrong. The real settle itself (~2-2.5s standalone, measured) sits far below EITHER
// value in the common case, so widening this costs zero wall-clock while removing that flake's margin
// entirely; this is the SAME test-only widening e082bf4d applied to merge-spawn-tracked.mjs and this
// file's sibling worker-run-gate-completion-nudge.mjs — production's own SYNC_ATTACH_BUDGET_MS constant
// is untouched (not the banned "raise the budget" move — see e082bf4d for that distinction).
const TEST_FAST_PATH_BUDGET_MS = 60_000;
const TEST_SYNC_BUDGET_MS = 500; // (1)/(2)/(4)/(5)/(6) — small on purpose, see SLOW_GATE_MS below
// SLOW_GATE_MS is the real subprocess gate's own hold duration for (1)/(2)/(4)/(5) — 3x the (small)
// TEST_SYNC_BUDGET_MS, chosen because degrade-to-pending shouldn't be a close race even under CPU
// contention: a bare `setTimeout` in a dedicated child process is not itself CPU-contention-sensitive the
// way real git work is — only its spawn has a small, bounded startup cost — but no scheduling margin is
// provably immune under arbitrary load (see TEST_FAST_PATH_BUDGET_MS's own doc on card e082bf4d), hence a
// margin rather than a bare-minimum gap. TIMEOUT_KILL_MS is scenario (6)'s
// gateCommandTimeoutMs — also past TEST_SYNC_BUDGET_MS, so it degrades to pending first, then the hang is
// SIGKILLed a moment later, mirroring the ordering the original 12s-budget/13s-gate numbers proved.
const SLOW_GATE_MS = 1500;
const TIMEOUT_KILL_MS = 1500;
// Poll for the async completion nudge instead of a fixed sleep — under CPU contention the gate process
// (spawn + setTimeout) and the terminal callback can land well past any hardcoded wait; polling with a
// generous ceiling waits exactly as long as actually needed instead of gambling on a fixed delay.
// Retrofitted onto the shared _wait.mjs waitUntil (card 24d2e0ac): same timeoutMs/intervalMs budget
// (still monotonic — the shared helper uses performance.now() internally too), still does a final
// `predicate()` re-check on timeout (unchanged) instead of hardcoding false.
async function waitUntil(predicate, timeoutMs, intervalMs = 200) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: "merge-confirm-completion-nudge: predicate" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return predicate();
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-mcn-${Date.now()}-${process.pid}`);
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
const { createWorktree, removeWorktree, mergeBranch } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mcn@loom -c user.name=mcn";
const now = new Date().toISOString();

class SeamHost extends createSeamHost(PtyHost) {}
// SPY: records every enqueueStdin() call (incl. `kind`, the 6th arg — not observable via any public
// getPending*/worker_list surface) then delegates to the real implementation so queueing/delivery
// behavior is otherwise completely unaffected.
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
// Separate instance, SAME db/host, only for scenario (3)'s fast-path budget (see TEST_FAST_PATH_BUDGET_MS's
// doc) — the two instances' pendingOps registries are independent, and each scenario uses a distinct
// worker/session id, so there's no cross-instance key collision.
const svcFast = new SessionService(db, host, new OrchestrationControl(), { syncAttachBudgetMs: TEST_FAST_PATH_BUDGET_MS });

function makeRepo() {
  const repo = path.join(os.tmpdir(), `loom-mcn-repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo); // the finally block's removeWorktree(repo, wt) only removes the WORKTREE, never this bare repo dir
  fs.writeFileSync(path.join(repo, "README.md"), "# mcn\n");
  execSync(`git init -q && git config user.email mcn@loom && git config user.name mcn && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  return repo;
}
function seedProject(projId, repo, gateCommand, orchestrationExtra) {
  const orchestration = gateCommand ? { gateCommand, ...orchestrationExtra } : undefined;
  db.insertProject({ id: projId, name: "MCN", repoPath: repo, vaultPath: repo, config: orchestration ? { orchestration } : {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${projId}-mgr`, projectId: projId, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: `${projId}-dev`, projectId: projId, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
  db.insertSession({ id: `${projId}-mgr1`, projectId: projId, agentId: `${projId}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}

const worktrees = [];
try {
  // ============================ (1) MERGED, async: completion nudge fires exactly once ============================
  {
    const P = "mcn-merged", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t1");
    fs.writeFileSync(path.join(worktreePath, "feat1.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat1`, { cwd: worktreePath });
    // A gate that outlives the injected syncAttachBudgetMs (TEST_SYNC_BUDGET_MS) then exits 0.
    seedProject(P, repo, `node -e "setTimeout(()=>process.exit(0), ${SLOW_GATE_MS})"`);
    const mgrId = `${P}-mgr1`, workerId = `${P}-wkr`;
    db.insertTask({ id: "t1", projectId: P, title: "t1", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "t1", worktreePath, branch });

    const t0 = performance.now(); // MONOTONIC (see TIMER_SLACK_MS)
    const first = await svc.confirmWorkerMergeTracked(mgrId, workerId);
    const elapsed = performance.now() - t0;
    // Lower bound at 75% of the injected budget (not the full budget) — the ORIGINAL 12s-budget/9s-threshold
    // check used exactly this ratio (9_000 / 12_000 = 0.75); this is that same shape, scaled to the
    // shrunk budget (325ms floor against the 500ms budget, well under the measured ~500-700ms elapsed).
    check(`(1) degrades to pending past the sync-wait budget (elapsed=${Math.round(elapsed)}ms)`, first.settled === false && elapsed >= Math.floor(TEST_SYNC_BUDGET_MS * 0.75) - TIMER_SLACK_MS);
    check("(1) NO completion nudge yet — the op is still running in the background", !host.enqueueCalls.some((c) => c.sessionId === mgrId && /\[loom:merge-(done|failed)\]/.test(c.text)));
    const pendingOpId1 = first.op.opId;
    check("(1) the pending response carries a real opId", typeof pendingOpId1 === "string" && pendingOpId1.length > 0);

    // Let the SLOW_GATE_MS gate actually finish + the terminal callback fire — poll (generous ceiling)
    // rather than a fixed sleep, so contention that slows the gate/callback doesn't false-RED this check.
    await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === mgrId && /\[loom:merge-(done|failed)\]/.test(c.text)), 20_000);
    const nudges = host.enqueueCalls.filter((c) => c.sessionId === mgrId && /\[loom:merge-(done|failed)\]/.test(c.text));
    check("(1) exactly ONE completion nudge landed for this worker", nudges.length === 1);
    check("(1) it's the MERGED/success nudge, naming the worker", nudges[0] && /\[loom:merge-done\]/.test(nudges[0].text) && nudges[0].text.includes(workerId));
    check("(1) pushed with kind:\"warning\" (a Loom operational nudge — same-route coalescing is correct)", nudges[0] && nudges[0].kind === "warning");
    check("(1) carries the task id AND the SAME opId the pending response returned (card 369d8824 correlation stamp)",
      nudges[0] && nudges[0].text.includes("task t1") && nudges[0].text.includes(pendingOpId1));
    // Card 7a1a76e9 DoD-1: the landed squash subject (card b88704bb's commitSubject, "chore: t1" — task
    // title "t1" is bare prose, coerced) is now carried on THIS async nudge — the ONE surface every QUEUED
    // merge is guaranteed to reach. Before this card the subject was reachable only on the rare fast/
    // synchronous settle, never here.
    check("(1) carries the landed squash subject (card 7a1a76e9 DoD-1 — the queued path was previously silent on this)",
      nudges[0] && nudges[0].text.includes('subject="chore: t1"'));
    check("(1) the merge actually landed on main (the underlying behavior is unchanged)", fs.existsSync(path.join(repo, "feat1.txt")));
    worktrees.push([repo, undefined]); // already merged/removed — no worktree left to clean up, kept for symmetry
  }

  // === (2) GATE-FAILED, async, GENUINE rejection: rich merge-rejected fires, generic echo suppressed ===
  {
    const P = "mcn-gate-failed", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t2");
    fs.writeFileSync(path.join(worktreePath, "feat2.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat2`, { cwd: worktreePath });
    // A gate that outlives the injected syncAttachBudgetMs then exits non-zero.
    seedProject(P, repo, `node -e "setTimeout(()=>process.exit(1), ${SLOW_GATE_MS})"`);
    const mgrId = `${P}-mgr1`, workerId = `${P}-wkr`;
    db.insertTask({ id: "t2", projectId: P, title: "t2", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "t2", worktreePath, branch });

    const first = await svc.confirmWorkerMergeTracked(mgrId, workerId);
    check("(2) degrades to pending past the sync-wait budget", first.settled === false);
    const pendingOpId2 = first.op.opId;

    // Let the SLOW_GATE_MS gate actually finish (non-zero) + rejectNotify (inside confirmWorkerMerge,
    // fires BEFORE the outer terminal callback runs) land its rich rejection — poll rather than a fixed
    // sleep, so contention doesn't false-RED this check.
    await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === mgrId && /\[loom:merge-rejected\]/.test(c.text)), 20_000);
    // Grace window for a (should-NOT-happen post-fix) trailing generic echo — the terminal callback fires
    // as a promise continuation microtask-close to rejectNotify's own await, so a short sleep is enough to
    // catch it if the suppression regressed.
    await sleep(500);
    const rejectedNudges = host.enqueueCalls.filter((c) => c.sessionId === mgrId && /\[loom:merge-rejected\]/.test(c.text));
    const failedNudges = host.enqueueCalls.filter((c) => c.sessionId === mgrId && /\[loom:merge-failed\]/.test(c.text));
    check("(2) exactly ONE rich merge-rejected nudge fired", rejectedNudges.length === 1);
    check("(2) it names the worker + the gate-failure reason", rejectedNudges[0] && rejectedNudges[0].text.includes(workerId) && /build gate failed/.test(rejectedNudges[0].text));
    check("(2) pushed with kind:\"agent\" (a specific rejection requiring manager action)", rejectedNudges[0] && rejectedNudges[0].kind === "agent");
    check("(2) carries the task id AND the SAME opId the pending response returned",
      rejectedNudges[0] && rejectedNudges[0].text.includes("task t2") && rejectedNudges[0].text.includes(pendingOpId2));
    check("(2) NO generic [loom:merge-failed] echo for the SAME event (card 9eea3901 double-notify fix)", failedNudges.length === 0);
    check("(2) fail-closed: worktree retained (gate failed, nothing merged)", fs.existsSync(worktreePath));
    worktrees.push([repo, worktreePath]);
  }

  // ============================ (3) FAST path: no completion nudge — the sync caller already has it inline ============================
  {
    const P = "mcn-fast", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t3");
    fs.writeFileSync(path.join(worktreePath, "feat3.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat3`, { cwd: worktreePath });
    seedProject(P, repo); // no gateCommand — resolves synchronously
    const mgrId = `${P}-mgr1`, workerId = `${P}-wkr`;
    db.insertTask({ id: "t3", projectId: P, title: "t3", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "t3", worktreePath, branch });

    const r = await svcFast.confirmWorkerMergeTracked(mgrId, workerId);
    check("(3) settles within the sync-wait budget (fast path)", r.settled === true && r.ok === true && r.value.merged === true);
    check("(3) the fast path stays byte-identical — NO completion nudge ever fires for it", !host.enqueueCalls.some((c) => c.sessionId === mgrId && /\[loom:merge-(done|failed)\]/.test(c.text)));
  }

  // === (4) GATE-FAILED, async, SUPPRESSED rejection: generic merge-failed is the SOLE terminal signal ===
  // The task's card is already in its terminal ("done") lane BEFORE the confirm even starts — mirrors
  // merge-reject-notify-suppress.mjs's scenario (C). shouldSuppressMergeReject reconciles the rich
  // [loom:merge-rejected] away (notified:false); the manager must still hear SOMETHING about this async
  // op, so onSettledAfterPending must NOT skip the generic [loom:merge-failed] echo here.
  //
  // Card 522cf573 (the "merge-FAILED carries no gateDetail" bug — the SAME shape this scenario already
  // exercises): the gate command below PRINTS a `FAIL <name>` marker before exiting non-zero (mirroring a
  // real test-runner failure, unlike the earlier scenarios' silent `process.exit(1)`), so `failingTest` is
  // actually populated — the DoD's single highest-value field, per both real incidents on the card. The
  // checks below assert the generic [loom:merge-failed] echo carries that failingTest line PLUS the
  // squash-phase-began state and the canonical-repo-state clause — i.e. the SAME richness the rich
  // [loom:merge-rejected] notify would have carried, not the bare "build gate failed" the card's two
  // incidents actually received. POSITIVE-CONTROLLED (per /worker doctrine): verified by hand that these
  // exact assertions go RED against the pre-fix dist (the old code only echoed `outcome.value.reason`,
  // i.e. bare "build gate failed" — see the card) and GREEN against the post-fix dist built from this
  // change.
  {
    const P = "mcn-suppressed", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t4");
    fs.writeFileSync(path.join(worktreePath, "feat4.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat4`, { cwd: worktreePath });
    seedProject(P, repo, `node -e "setTimeout(()=>{console.log('FAIL mcn-scenario4-marker'); process.exit(1)}, ${SLOW_GATE_MS})"`);
    const mgrId = `${P}-mgr1`, workerId = `${P}-wkr`;
    // "done" is the project's default terminal column key (no custom kanbanColumns configured) — same
    // convention merge-reject-notify-suppress.mjs's scenario (C) relies on.
    db.insertTask({ id: "t4", projectId: P, title: "t4", body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "t4", worktreePath, branch });

    const first = await svc.confirmWorkerMergeTracked(mgrId, workerId);
    check("(4) degrades to pending past the sync-wait budget", first.settled === false);
    const pendingOpId4 = first.op.opId;

    await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === mgrId && /\[loom:merge-(rejected|failed)\]/.test(c.text)), 20_000);
    const rejectedNudges = host.enqueueCalls.filter((c) => c.sessionId === mgrId && /\[loom:merge-rejected\]/.test(c.text));
    const failedNudges = host.enqueueCalls.filter((c) => c.sessionId === mgrId && /\[loom:merge-failed\]/.test(c.text));
    check("(4) rich merge-rejected notify is SUPPRESSED (card already Done)", rejectedNudges.length === 0);
    check("(4) generic [loom:merge-failed] IS the sole terminal signal — not silently dropped", failedNudges.length === 1);
    check("(4) it names the worker + the gate-failure reason", failedNudges[0] && failedNudges[0].text.includes(workerId) && /build gate failed/.test(failedNudges[0].text));
    check("(4) carries the task id AND the SAME opId the pending response returned (the generic echo is stamped too, not just the rich path)",
      failedNudges[0] && failedNudges[0].text.includes("task t4") && failedNudges[0].text.includes(pendingOpId4));
    check("(4) pushed with kind:\"warning\"", failedNudges[0] && failedNudges[0].kind === "warning");
    // Card 522cf573 DoD 1: failingTest — the single highest-value field per the card — is actually
    // propagated into the GENERIC echo, not just the (suppressed, never-delivered) rich notify.
    check("(4) carries the actual failingTest marker (card 522cf573 — the field both real incidents needed)",
      failedNudges[0] && failedNudges[0].text.includes("failing: FAIL mcn-scenario4-marker"));
    // Card 522cf573 DoD 4: states whether the squash phase had begun — a gate rejection always precedes
    // the squash, so this must read "never reached", never a silent omission.
    check("(4) states the squash phase never reached (card 522cf573 DoD 4)",
      failedNudges[0] && failedNudges[0].text.includes("squash phase never reached"));
    // Card 522cf573 DoD 1: ALWAYS the canonical-repo-state clause — merge-rejected already carried this;
    // merge-failed used to drop it silently.
    check("(4) carries the canonical-repo-state clause (card 522cf573 DoD 1 — merge-rejected already had this, merge-failed used to drop it)",
      failedNudges[0] && failedNudges[0].text.includes("canonical repo untouched"));
    // Card 522cf573: the bug this whole card is about — the generic echo used to be JUST the bare headline
    // ("build gate failed"), discarding every other field gateDetail actually carried. Assert the message
    // is genuinely richer than that bare string, not merely non-empty.
    check("(4) is NOT the bare 'build gate failed' string this card's two incidents actually received (must carry more)",
      failedNudges[0] && !/— build gate failed$/.test(failedNudges[0].text.trim()) && failedNudges[0].text.length > `[loom:merge-failed] worker ${workerId} (task t4) [op ${pendingOpId4}] — build gate failed`.length + 20);
    worktrees.push([repo, worktreePath]);
  }

  // === (5) ALREADY_MERGED, async: the double-fire this card fixes (card 187f5b76) ===
  // The branch's work is landed into main OUT-OF-BAND (mirrors merge-confirm-idempotent.mjs's (b1)) —
  // BEFORE confirmWorkerMergeTracked is ever called — but the worktree is left present and the task NOT
  // yet terminal, so the early-idempotency short-circuit does NOT fire: this confirm runs the (slow) gate
  // for real, then mergeBranch's own noop/ALREADY_MERGED classification reaches finishAlreadyMerged from
  // INSIDE the async pending run. Under the OLD code finishAlreadyMerged's direct `[loom:already-merged]`
  // push AND onSettledAfterPending's generic `[loom:merge-done]` echo BOTH fired for this one completion —
  // this proves only ONE lands now.
  {
    const P = "mcn-already-merged", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t5");
    fs.writeFileSync(path.join(worktreePath, "feat5.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat5`, { cwd: worktreePath });
    // A gate that outlives the injected syncAttachBudgetMs then exits 0.
    seedProject(P, repo, `node -e "setTimeout(()=>process.exit(0), ${SLOW_GATE_MS})"`);
    const mgrId = `${P}-mgr1`, workerId = `${P}-wkr`;
    db.insertTask({ id: "t5", projectId: P, title: "t5", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "t5", worktreePath, branch });

    // Land the branch into main directly (writes the deterministic Loom-Worker-Branch trailer) WITHOUT
    // deleting the branch ref or touching the worktree — simulating a merge that landed out-of-band while
    // the daemon's own confirm was still in flight (or about to start).
    const landed = await mergeBranch(repo, branch, "MCN t5 already-merged");
    check("(5) precondition: branch landed in main with its trailer, worktree still present, task NOT terminal",
      landed.ok === true && fs.existsSync(worktreePath) && db.getTask("t5").columnKey !== "done");

    const first = await svc.confirmWorkerMergeTracked(mgrId, workerId);
    check("(5) degrades to pending past the sync-wait budget (the gate still runs — no early short-circuit)", first.settled === false);
    const pendingOpId5 = first.op.opId;

    await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === mgrId && /\[loom:(merge-done|already-merged)\]/.test(c.text)), 20_000);
    // Grace window for a (should-NOT-happen post-fix) trailing generic echo, mirroring scenario (2).
    await sleep(500);
    const alreadyMergedNudges = host.enqueueCalls.filter((c) => c.sessionId === mgrId && /\[loom:already-merged\]/.test(c.text));
    const mergeDoneNudges = host.enqueueCalls.filter((c) => c.sessionId === mgrId && /\[loom:merge-done\]/.test(c.text));
    check("(5) exactly ONE [loom:already-merged] nudge fired", alreadyMergedNudges.length === 1);
    check("(5) NO generic [loom:merge-done] echo for the SAME completion — THE double-fire this card fixes (187f5b76)", mergeDoneNudges.length === 0);
    check("(5) it names the worker + task id + the SAME opId the pending response returned (card 369d8824)",
      alreadyMergedNudges[0]
      && alreadyMergedNudges[0].text.includes(workerId)
      && alreadyMergedNudges[0].text.includes("task t5")
      && alreadyMergedNudges[0].text.includes(pendingOpId5));
    check("(5) pushed with kind:\"agent\" (a success announcement, delivered as its own turn)", alreadyMergedNudges[0] && alreadyMergedNudges[0].kind === "agent");
    // finishAlreadyMerged pushes its notify BEFORE the pty-stop-wait + finalizeMerge cleanup run (same
    // ordering the green path uses) — poll rather than trust the notify's own arrival time for the
    // bookkeeping that follows it.
    await waitUntil(() => db.getTask("t5").columnKey === "done", 10_000);
    check("(5) task moved to done (bookkeeping finished)", db.getTask("t5").columnKey === "done");
    await waitUntil(() => !fs.existsSync(worktreePath), 10_000);
    check("(5) worktree removed (idempotent cleanup)", !fs.existsSync(worktreePath));
    worktrees.push([repo, undefined]); // already merged/removed — no worktree left to clean up
  }

  // ============ (6) TIMEOUT, async: rich [loom:merge-rejected] fires with timeout wording (edc1ec12) ============
  {
    const P = "mcn-timeout", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t6");
    fs.writeFileSync(path.join(worktreePath, "feat6.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat6`, { cwd: worktreePath });
    // A gate that NEVER exits and produces NO output — killed by our own gateCommandTimeoutMs
    // (TIMEOUT_KILL_MS), deliberately > the injected syncAttachBudgetMs so this degrades to pending
    // FIRST, then the timeout-kill happens a moment later — the ASYNC settle path (gate-timeout-tree-
    // kill.mjs's confirmWorkerMerge case already covers the fast/sync-budget timeout; this proves the
    // same for a genuinely slow one).
    seedProject(P, repo, `node -e "setInterval(()=>{},1000)"`, { gateCommandTimeoutMs: TIMEOUT_KILL_MS });
    const mgrId = `${P}-mgr1`, workerId = `${P}-wkr`;
    db.insertTask({ id: "t6", projectId: P, title: "t6", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "t6", worktreePath, branch });

    const first = await svc.confirmWorkerMergeTracked(mgrId, workerId);
    check("(6) degrades to pending past the sync-wait budget", first.settled === false);
    const pendingOpId6 = first.op.opId;

    await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === mgrId && /\[loom:merge-rejected\]/.test(c.text)), 20_000);
    await sleep(500); // grace window for a (should-NOT-happen) trailing generic echo, mirroring scenario (2)
    const rejectedNudges = host.enqueueCalls.filter((c) => c.sessionId === mgrId && /\[loom:merge-rejected\]/.test(c.text));
    const failedNudges = host.enqueueCalls.filter((c) => c.sessionId === mgrId && /\[loom:merge-failed\]/.test(c.text));
    check("(6) exactly ONE rich merge-rejected nudge fired", rejectedNudges.length === 1);
    check("(6) it names the worker + TIMEOUT wording (not a plain 'build gate failed')", rejectedNudges[0] && rejectedNudges[0].text.includes(workerId) && /gate timed out/.test(rejectedNudges[0].text));
    check("(6) pushed with kind:\"agent\"", rejectedNudges[0] && rejectedNudges[0].kind === "agent");
    check("(6) carries the task id AND the SAME opId the pending response returned", rejectedNudges[0] && rejectedNudges[0].text.includes("task t6") && rejectedNudges[0].text.includes(pendingOpId6));
    check("(6) NO generic [loom:merge-failed] echo for the SAME event", failedNudges.length === 0);
    check("(6) fail-closed: worktree retained (gate timed out, nothing merged)", fs.existsSync(worktreePath));
    worktrees.push([repo, worktreePath]);
  }
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMergeTracked pushes exactly ONE terminal signal into the asking manager's session per async op, always stamped with a correlation opId: [loom:merge-done] on a plain green merge, the rich [loom:merge-rejected] alone on a genuine rejection (card 9eea3901 — the generic [loom:merge-failed] echo is suppressed) — including a REAL SIGKILL timeout, not just a plain non-zero exit (card edc1ec12) — [loom:merge-failed] as the sole signal when the rich notify was itself reconciled away, [loom:already-merged] alone on an ALREADY_MERGED completion (card 187f5b76 — the generic [loom:merge-done] echo that used to ALSO fire is now suppressed), and NO nudge at all on the already-fast synchronous path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
