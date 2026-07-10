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
// NOT tunable-fast: SYNC_ATTACH_BUDGET_MS (12s) is not injectable, so proving the REAL async/pending path
// through the REAL confirmWorkerMergeTracked needs a gate that outlives it — at least ~13s wall-clock per
// scenario, longer under CPU contention (the post-budget wait polls for the completion nudge instead of
// sleeping a fixed duration — see waitUntil below). Still fully hermetic (in-process, no daemon, no network).
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
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-completion-nudge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Slack for the bounded-op LOWER-bound timing assertion below. Durations are measured with the MONOTONIC
// performance.now() (not Date.now()), so a wall-clock NTP/virtualization backward step can't make elapsed
// read under the budget; this slack additionally absorbs libuv's sub-ms early timer fire. Mirrors
// worktrees.mjs's TIMER_SLACK_MS (same fix class as the v0.3.0 release CI Date.now() flake).
const TIMER_SLACK_MS = 50;
// Poll for the async completion nudge instead of a fixed sleep — under CPU contention the 13s gate
// process (spawn + setTimeout) and the terminal callback can land well past any hardcoded wait; polling
// with a generous ceiling waits exactly as long as actually needed instead of gambling on a fixed delay.
async function waitUntil(predicate, timeoutMs, intervalMs = 200) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
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
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree, mergeBranch } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mcn@loom -c user.name=mcn";
const now = new Date().toISOString();

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
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
const svc = new SessionService(db, host, new OrchestrationControl());

function makeRepo() {
  const repo = path.join(os.tmpdir(), `loom-mcn-repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcn\n");
  execSync(`git init -q && git config user.email mcn@loom && git config user.name mcn && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  return repo;
}
function seedProject(projId, repo, gateCommand) {
  db.insertProject({ id: projId, name: "MCN", repoPath: repo, vaultPath: repo, config: gateCommand ? { orchestration: { gateCommand } } : {}, createdAt: now, archivedAt: null });
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
    // A gate that outlives SYNC_ATTACH_BUDGET_MS (12s) then exits 0.
    seedProject(P, repo, `node -e "setTimeout(()=>process.exit(0), 13000)"`);
    const mgrId = `${P}-mgr1`, workerId = `${P}-wkr`;
    db.insertTask({ id: "t1", projectId: P, title: "t1", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "t1", worktreePath, branch });

    const t0 = performance.now(); // MONOTONIC (see TIMER_SLACK_MS)
    const first = await svc.confirmWorkerMergeTracked(mgrId, workerId);
    const elapsed = performance.now() - t0;
    check(`(1) degrades to pending past the sync-wait budget (elapsed=${Math.round(elapsed)}ms)`, first.settled === false && elapsed >= 9_000 - TIMER_SLACK_MS);
    check("(1) NO completion nudge yet — the op is still running in the background", !host.enqueueCalls.some((c) => c.sessionId === mgrId && /\[loom:merge-(done|failed)\]/.test(c.text)));
    const pendingOpId1 = first.op.opId;
    check("(1) the pending response carries a real opId", typeof pendingOpId1 === "string" && pendingOpId1.length > 0);

    // Let the 13s gate actually finish + the terminal callback fire — poll (generous ceiling) rather
    // than a fixed sleep, so contention that slows the gate/callback doesn't false-RED this check.
    await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === mgrId && /\[loom:merge-(done|failed)\]/.test(c.text)), 20_000);
    const nudges = host.enqueueCalls.filter((c) => c.sessionId === mgrId && /\[loom:merge-(done|failed)\]/.test(c.text));
    check("(1) exactly ONE completion nudge landed for this worker", nudges.length === 1);
    check("(1) it's the MERGED/success nudge, naming the worker", nudges[0] && /\[loom:merge-done\]/.test(nudges[0].text) && nudges[0].text.includes(workerId));
    check("(1) pushed with kind:\"warning\" (a Loom operational nudge — same-route coalescing is correct)", nudges[0] && nudges[0].kind === "warning");
    check("(1) carries the task id AND the SAME opId the pending response returned (card 369d8824 correlation stamp)",
      nudges[0] && nudges[0].text.includes("task t1") && nudges[0].text.includes(pendingOpId1));
    check("(1) the merge actually landed on main (the underlying behavior is unchanged)", fs.existsSync(path.join(repo, "feat1.txt")));
    worktrees.push([repo, undefined]); // already merged/removed — no worktree left to clean up, kept for symmetry
  }

  // === (2) GATE-FAILED, async, GENUINE rejection: rich merge-rejected fires, generic echo suppressed ===
  {
    const P = "mcn-gate-failed", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t2");
    fs.writeFileSync(path.join(worktreePath, "feat2.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat2`, { cwd: worktreePath });
    // A gate that outlives SYNC_ATTACH_BUDGET_MS (12s) then exits non-zero.
    seedProject(P, repo, `node -e "setTimeout(()=>process.exit(1), 13000)"`);
    const mgrId = `${P}-mgr1`, workerId = `${P}-wkr`;
    db.insertTask({ id: "t2", projectId: P, title: "t2", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "t2", worktreePath, branch });

    const first = await svc.confirmWorkerMergeTracked(mgrId, workerId);
    check("(2) degrades to pending past the sync-wait budget", first.settled === false);
    const pendingOpId2 = first.op.opId;

    // Let the 13s gate actually finish (non-zero) + rejectNotify (inside confirmWorkerMerge, fires BEFORE
    // the outer terminal callback runs) land its rich rejection — poll rather than a fixed sleep, so
    // contention doesn't false-RED this check.
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

    const r = await svc.confirmWorkerMergeTracked(mgrId, workerId);
    check("(3) settles within the sync-wait budget (fast path)", r.settled === true && r.ok === true && r.value.merged === true);
    check("(3) the fast path stays byte-identical — NO completion nudge ever fires for it", !host.enqueueCalls.some((c) => c.sessionId === mgrId && /\[loom:merge-(done|failed)\]/.test(c.text)));
  }

  // === (4) GATE-FAILED, async, SUPPRESSED rejection: generic merge-failed is the SOLE terminal signal ===
  // The task's card is already in its terminal ("done") lane BEFORE the confirm even starts — mirrors
  // merge-reject-notify-suppress.mjs's scenario (C). shouldSuppressMergeReject reconciles the rich
  // [loom:merge-rejected] away (notified:false); the manager must still hear SOMETHING about this async
  // op, so onSettledAfterPending must NOT skip the generic [loom:merge-failed] echo here.
  {
    const P = "mcn-suppressed", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t4");
    fs.writeFileSync(path.join(worktreePath, "feat4.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat4`, { cwd: worktreePath });
    seedProject(P, repo, `node -e "setTimeout(()=>process.exit(1), 13000)"`);
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
    // A gate that outlives SYNC_ATTACH_BUDGET_MS (12s) then exits 0.
    seedProject(P, repo, `node -e "setTimeout(()=>process.exit(0), 13000)"`);
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
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMergeTracked pushes exactly ONE terminal signal into the asking manager's session per async op, always stamped with a correlation opId: [loom:merge-done] on a plain green merge, the rich [loom:merge-rejected] alone on a genuine rejection (card 9eea3901 — the generic [loom:merge-failed] echo is suppressed), [loom:merge-failed] as the sole signal when the rich notify was itself reconciled away, [loom:already-merged] alone on an ALREADY_MERGED completion (card 187f5b76 — the generic [loom:merge-done] echo that used to ALSO fire is now suppressed), and NO nudge at all on the already-fast synchronous path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
