import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// PENDING-OP SETTLE LINEAGE ROUTING (card 05c36bf4, origin finding 2e42ae6b) — a PendingOpRegistry settle
// callback (confirmWorkerMergeTracked's "merge" kind, runWorkerGate's "gate" kind, PLUS the rich direct
// pushes inside confirmWorkerMerge itself — rejectNotify's [loom:merge-rejected], finishAlreadyMerged's
// [loom:already-merged] — and the durable boot sweep reconcileOrphanedGateOps) used to close over/persist
// the ORIGINATING session id and push its completion nudge straight at that literal id. If the originating
// session RECYCLED before the async op settled, the nudge fired at the now-dead predecessor and was
// silently swallowed (enqueueStdin's best-effort try/catch) — the successor never heard it. Real incident:
// a manager recycled mid-merge-confirm; its successor never got [loom:merge-done], spent 30 minutes
// re-deriving the outcome from git, and nearly re-drove an already-merged branch as "STRANDED".
//
// Code Review (first pass) caught that the generic confirmWorkerMergeTracked/runWorkerGate echoes are NOT
// the only settle pushes: rejectNotify/finishAlreadyMerged set `notified:true`, which SUPPRESSES the
// generic echo — so on the REJECTION path (the card's own scenario, but with the gate failing instead of
// passing) the successor used to get NOTHING AT ALL. reconcileOrphanedGateOps has the identical shape
// against its durably-persisted `ownerSessionId`. All four now route through the same
// SessionService.resolveSettleNudgeTarget helper, plus a predecessor-attribution suffix
// (settleNudgeAttribution) when the resolved target differs from the id the op was captured/keyed under —
// a recycled successor can hold its OWN in-flight op under its OWN key while ALSO receiving a
// predecessor's nudge for a DIFFERENT op on the same turn, and needs to tell the two apart.
//
// Proves:
//   (0)  BYTE-IDENTICAL FALLBACK, live case: liveLineageSuccessor on a LIVE, never-recycled session returns
//        that EXACT session — resolveSettleNudgeTarget's `?? sessionId` fallback never changes today's
//        target for the common case.
//   (0b) BYTE-IDENTICAL FALLBACK, fully-dead-lineage case: liveLineageSuccessor on a lineage with NO live
//        session anywhere (a lone EXITED session, no successor) returns null — proving
//        resolveSettleNudgeTarget's `?? sessionId` fallback path is actually reachable and preserves
//        today's silent best-effort no-op rather than throwing or picking something arbitrary.
//   (A)  MERGE / MANAGER RECYCLE, SUCCESS: manager A calls confirmWorkerMergeTracked, degrades to pending,
//        A recycles to B mid-flight, the gate PASSES — [loom:merge-done] lands on B, never on dead A.
//   (B)  MERGE / MANAGER RECYCLE, REJECTION (the case Code Review flagged as uncovered — this is the
//        SUPPRESSING push, not the generic echo): identical shape, but the gate FAILS — proves
//        rejectNotify's [loom:merge-rejected] itself reaches B, not just the generic-echo fallback that
//        (A) exercises. Without the fix, B would receive NOTHING for this op (the rich push swallowed at
//        dead A, the generic echo suppressed by notified:true) — exactly the gap the card exists to close.
//   (C)  GATE / WORKER RECYCLE: the identical shape on the "gate" kind — worker A calls run_gate, degrades
//        to pending, A worker_recycles to B mid-flight, [loom:gate-done] lands on B, never on A. (A worker
//        recycling while its own background run_gate is still in flight is a live fleet pattern, not just
//        a theoretical mirror of the merge case.)
//
// (A)/(B)/(C) run SEQUENTIALLY — each needs a real gate that outlives the non-injectable
// SYNC_ATTACH_BUDGET_MS (12s). A concurrent variant (all three sharing one ~15-17s window via a raised
// maxConcurrentGates) was tried first to cut wall-clock, but proved flaky under this harness's own
// concurrent-spawn overhead (recycleManager/recycleWorker's real PtyHost spawn/readiness bookkeeping,
// times three, contending on one event loop) — not worth chasing on a component with prior clobber-guard
// review history; reliability wins over shaving ~30s here.
//
// Uses the injectable `runGate` seam (SessionService opts.runGate) instead of a real spawned gate command
// (unlike merge-confirm-completion-nudge.mjs, which deliberately needs a REAL process for its timeout/kill
// scenario) — this test is about NOTIFICATION ROUTING, not gate execution semantics, so a controllable
// async function is the right-sized fake, keyed by worktree path so (A) can pass while (B) fails. The real
// async GAP between "pending" and "settled" stays real wall-clock (bounded by SYNC_ATTACH_BUDGET_MS) — that
// timing IS the bug, so it is not mocked away, only the gate's own child-process plumbing is.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/pending-op-settle-lineage.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, timeoutMs, intervalMs = 200) {
  const start = performance.now(); // MONOTONIC — avoids the Date.now() CI timing-flake class
  while (performance.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

const tmpHome = path.join(os.tmpdir(), `loom-posl-${Date.now()}-${process.pid}`);
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
const { liveLineageSuccessor } = await import("../dist/sessions/platform-lead-prompt.js");

const GIT_ID = "-c user.email=posl@loom -c user.name=posl";
const now = new Date().toISOString();

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
// SPY: records every enqueueStdin() call (sessionId + text) so the exact TARGET a completion nudge landed
// on can be asserted directly. Also tracks stop()-ed ids so isAlive() reflects them immediately — SeamHost's
// fake pty never fires a real exit event, so without this recycleWorker's synchronous "wait until the old
// pty is actually gone" poll (packages/daemon/src/sessions/service.ts) would spin its full ~5s timeout on
// every call instead of returning as soon as this test's own stop() is observed.
class SpyHost extends SeamHost {
  enqueueCalls = [];
  stoppedIds = new Set();
  enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId) {
    this.enqueueCalls.push({ sessionId, text, kind });
    return super.enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId);
  }
  stop(sessionId, mode) {
    this.stoppedIds.add(sessionId);
    return super.stop(sessionId, mode);
  }
  isAlive(sessionId) {
    if (this.stoppedIds.has(sessionId)) return false;
    return super.isAlive(sessionId);
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
// Worktree paths added here make the injected gate FAIL instead of pass — lets (A)/(B) share one gate
// function while running concurrently against different worktrees.
const FAIL_WORKTREES = new Set();
// A gate that outlives SYNC_ATTACH_BUDGET_MS (12s, non-injectable) then resolves — comfortable margin
// (15s) so each scenario's recycle + manual teardown bookkeeping (well under 1s) never races the settle.
const slowGate = async (_gate, cwd) => {
  await sleep(15_000);
  return FAIL_WORKTREES.has(cwd)
    ? { passed: false, failedStep: "gate", failedStatus: 1 } // plain non-zero exit ⇒ classifyGateFailure "genuine" (no retry, no kill/timeout wording)
    : { passed: true };
};
const svc = new SessionService(db, host, new OrchestrationControl(), { runGate: slowGate });

function makeRepo() {
  const repo = path.join(os.tmpdir(), `loom-posl-repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# posl\n");
  execSync(`git init -q && git config user.email posl@loom && git config user.name posl && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  return repo;
}
function seedProject(projId, repo) {
  db.insertProject({ id: projId, name: "POSL", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${projId}-mgr`, projectId: projId, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: `${projId}-dev`, projectId: projId, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
}

const worktrees = [];
try {
  // ==================== (0) BYTE-IDENTICAL FALLBACK — LIVE case ====================
  {
    const P = "posl-control";
    db.insertProject({ id: P, name: "POSL-Control", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    const soloId = `${P}-mgr1`;
    db.insertSession({ id: soloId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const resolved = liveLineageSuccessor(db, soloId);
    check("(0) a live, never-recycled session resolves to ITSELF (not null, not skipped-forward)", resolved !== null && resolved.id === soloId);
    check("(0) so resolveSettleNudgeTarget's `?? sessionId` fallback never fires for the common case — the target is unchanged", resolved.id === soloId);
  }

  // ==================== (0b) BYTE-IDENTICAL FALLBACK — FULLY-DEAD-LINEAGE case ====================
  {
    const P = "posl-dead";
    db.insertProject({ id: P, name: "POSL-Dead", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    const deadId = `${P}-mgr1`;
    // A lone session, no recycledFrom, no successor, and NOT live — the whole "lineage" (of one) is dead.
    db.insertSession({ id: deadId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const resolved = liveLineageSuccessor(db, deadId);
    check("(0b) a fully-dead lineage (no live session anywhere) resolves to null", resolved === null);
    check("(0b) so resolveSettleNudgeTarget's `?? sessionId` fallback DOES fire here, returning the original (dead) id unchanged — preserving today's silent best-effort no-op rather than throwing or picking an arbitrary target", (resolved?.id ?? deadId) === deadId);
  }

  // ==================== (A)/(B)/(C): concurrent recycle-then-settle scenarios ====================
  const scenarioA_mergeSuccess = async () => {
    const P = "posl-merge-ok", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "ta");
    fs.writeFileSync(path.join(worktreePath, "feata.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feata`, { cwd: worktreePath });
    seedProject(P, repo);
    const mgrAId = `${P}-mgr1`, workerId = `${P}-wkr`;
    db.insertTask({ id: "ta", projectId: P, title: "ta", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrAId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrAId, taskId: "ta", worktreePath, branch });

    const first = await svc.confirmWorkerMergeTracked(mgrAId, workerId);
    check("(A) degrades to pending past the sync-wait budget", first.settled === false);

    // Manager A recycles to B WHILE the merge op is still running in the background.
    const mgrB = await svc.recycleManager(mgrAId, "successor: a merge confirm is still pending in the background — you'll get its [loom:merge-*] nudge when it settles.");
    check("(A) recycleManager produced a fresh successor session", !!mgrB && mgrB.id !== mgrAId);
    // SeamHost's fake pty never fires a real exit event — stamp the predecessor definitively dead (as it
    // will genuinely be, long before this op settles in the real incident this reproduces) rather than
    // relying on the deferred pty.stop() this test's fake host can't complete on its own.
    db.setProcessState(mgrAId, "exited");

    await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === mgrB.id && /\[loom:merge-done\]/.test(c.text)), 30_000);
    const onSuccessor = host.enqueueCalls.filter((c) => c.sessionId === mgrB.id && /\[loom:merge-done\]/.test(c.text));
    const onDeadPredecessor = host.enqueueCalls.filter((c) => c.sessionId === mgrAId && /\[loom:merge-(done|failed)\]/.test(c.text));
    check("(A) the completion nudge landed on the LIVE SUCCESSOR B, exactly once", onSuccessor.length === 1);
    check("(A) the nudge names the worker + carries the SAME opId the pending response returned", onSuccessor[0] && onSuccessor[0].text.includes(workerId) && onSuccessor[0].text.includes(first.op.opId));
    check("(A) pushed with kind:\"warning\" (unchanged — this fix is about the TARGET only)", onSuccessor[0] && onSuccessor[0].kind === "warning");
    check("(A) NO completion nudge ever landed on the dead predecessor A", onDeadPredecessor.length === 0);
    check("(A) the merge actually landed on main (unaffected by this fix)", fs.existsSync(path.join(repo, "feata.txt")));
    worktrees.push([repo, undefined]); // already merged/removed
  };

  const scenarioB_mergeRejection = async () => {
    const P = "posl-merge-reject", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "tb");
    fs.writeFileSync(path.join(worktreePath, "featb.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m featb`, { cwd: worktreePath });
    seedProject(P, repo);
    FAIL_WORKTREES.add(worktreePath); // this scenario's gate fails
    const mgrAId = `${P}-mgr1`, workerId = `${P}-wkr`;
    db.insertTask({ id: "tb", projectId: P, title: "tb", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrAId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrAId, taskId: "tb", worktreePath, branch });

    const first = await svc.confirmWorkerMergeTracked(mgrAId, workerId);
    check("(B) degrades to pending past the sync-wait budget", first.settled === false);

    // Manager A recycles to B WHILE the (about-to-FAIL) merge op is still running in the background — the
    // exact scenario Code Review flagged: rejectNotify's rich push sets notified:true, suppressing the
    // generic echo, so THIS push is the successor's ONLY chance to hear about this op at all.
    const mgrB = await svc.recycleManager(mgrAId, "successor: a merge confirm (its gate is expected to FAIL) is still pending — you'll get [loom:merge-rejected] when it settles.");
    check("(B) recycleManager produced a fresh successor session", !!mgrB && mgrB.id !== mgrAId);
    db.setProcessState(mgrAId, "exited");

    await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === mgrB.id && c.text.includes(workerId) && /\[loom:merge-rejected\]/.test(c.text)), 30_000);
    const rejectedOnSuccessor = host.enqueueCalls.filter((c) => c.sessionId === mgrB.id && c.text.includes(workerId) && /\[loom:merge-rejected\]/.test(c.text));
    const anyOnDeadPredecessor = host.enqueueCalls.filter((c) => c.sessionId === mgrAId && c.text.includes(workerId) && /\[loom:merge-(rejected|failed)\]/.test(c.text));
    const genericEchoOnSuccessor = host.enqueueCalls.filter((c) => c.sessionId === mgrB.id && c.text.includes(workerId) && /\[loom:merge-failed\]/.test(c.text));
    check("(B) THE REGRESSION-CAUGHT CASE: the rich [loom:merge-rejected] push (rejectNotify, the SUPPRESSING push) itself reached the LIVE SUCCESSOR B, exactly once", rejectedOnSuccessor.length === 1);
    check("(B) it names the worker + build-gate-failed wording + the SAME opId the pending response returned", rejectedOnSuccessor[0] && /build gate failed/.test(rejectedOnSuccessor[0].text) && rejectedOnSuccessor[0].text.includes(first.op.opId));
    check("(B) pushed with kind:\"agent\" (unchanged — a specific rejection requiring manager action)", rejectedOnSuccessor[0] && rejectedOnSuccessor[0].kind === "agent");
    check("(B) NO push for this op EVER landed on the dead predecessor A", anyOnDeadPredecessor.length === 0);
    check("(B) NO generic [loom:merge-failed] echo for the SAME event on the successor either (double-notify fix, card 9eea3901, still holds through the lineage fix)", genericEchoOnSuccessor.length === 0);
    check("(B) fail-closed: worktree retained (gate failed, nothing merged)", fs.existsSync(worktreePath));
    worktrees.push([repo, worktreePath]);
  };

  const scenarioC_gateRecycle = async () => {
    const P = "posl-gate", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "tc");
    seedProject(P, repo);
    const mgrId = `${P}-mgr1`, workerAId = `${P}-wkrA`;
    db.insertTask({ id: "tc", projectId: P, title: "tc", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "tc", worktreePath, branch });

    const first = await svc.runWorkerGate(workerAId);
    check("(C) degrades to pending past the sync-wait budget", first.settled === false);

    // Worker A recycles to B WHILE its own run_gate is still running in the background.
    const workerB = await svc.recycleWorker(mgrId, workerAId, "handoff: continuing tc; the pending run_gate self-check is still in flight and will land on its own.");
    check("(C) recycleWorker produced a fresh successor session", !!workerB && workerB.id !== workerAId);
    db.setProcessState(workerAId, "exited"); // SeamHost's fake pty never fires a real exit — stamp it dead

    await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === workerB.id && /\[loom:gate-done\]/.test(c.text)), 30_000);
    const onSuccessor = host.enqueueCalls.filter((c) => c.sessionId === workerB.id && /\[loom:gate-done\]/.test(c.text));
    const onDeadPredecessor = host.enqueueCalls.filter((c) => c.sessionId === workerAId && /\[loom:gate-(done|failed)\]/.test(c.text));
    check("(C) the completion nudge landed on the LIVE SUCCESSOR B, exactly once", onSuccessor.length === 1);
    check("(C) the nudge carries the SAME opId the pending response returned", onSuccessor[0] && onSuccessor[0].text.includes(first.op.opId));
    check("(C) pushed with kind:\"warning\" (unchanged — this fix is about the TARGET only)", onSuccessor[0] && onSuccessor[0].kind === "warning");
    check("(C) NO completion nudge ever landed on the dead predecessor A", onDeadPredecessor.length === 0);
    worktrees.push([repo, worktreePath]);
  };

  await scenarioA_mergeSuccess();
  await scenarioB_mergeRejection();
  await scenarioC_gateRecycle();
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every PendingOpRegistry settle push (confirmWorkerMergeTracked's generic echo, rejectNotify's rich rejection, finishAlreadyMerged's success announcement, runWorkerGate's echo, and the durable boot sweep) resolves its target through the CURRENT session lineage at settle time: unchanged for a never-recycled session, unchanged (best-effort no-op) for a fully-dead lineage, and routed to the live successor — including the SUPPRESSING rejection push, not just the generic echo — when the originating manager/worker recycled mid-op. Never delivered to the dead predecessor."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
