import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c30293ae (discovered from 641cc62c round 2) — the REVERSE direction 641cc62c's own "Known
// residual" section left open: a confirmWorkerMergeTracked/mergeBatchTracked mint targeting a worker
// whose OWN recycleWorker call is itself still in flight.
//
// recycleWorker's own pre-check (claimTaskWorktreeRefusal, service.ts ~L13376) runs exactly ONCE,
// synchronously, before any teardown. Before this card's fix, from that instant until the fresh successor
// row went live, recycleWorker registered NOTHING in inFlightSpawnTaskIds/claimedWorktreePaths/
// inFlightMergeTaskIds — so spawnMintConflict (the predicate confirmWorkerMergeTracked's own onOpMinted
// calls) read completely clean for this task the whole time, even though the predecessor was already
// hard-stopped/exited and the fresh successor row didn't exist yet. A confirmWorkerMergeTracked call
// landing in that window minted successfully and ran its gate against the SAME worktreePath recycleWorker
// was still mid-swap on — the exact two-writer collision 641cc62c closed for the ordinary spawn case,
// reopened here for recycle. See docs/decisions/c30293ae-recycleworker-holds-the-in-flight-claim-too.md
// for the fix and docs/decisions/641cc62c-*.md for the original (now-closed) residual.
//
// Real git + a real SessionService, fake createPty seam (no claude), NO live daemon — mirrors
// merge-spawn-task-in-flight.mjs's in-process style and its "pause at a known, deterministic point via a
// white-box monkeypatch" convention (see that file's own scenario (10): `svc.spawnMintConflict` is
// overridden there the same way `svc.retireSiblingSessionsForTask` is overridden below). No blind sleeps
// anywhere — every "mid-flight" assertion below is gated on either a file marker (the gate command
// provably started, or provably never did) or a monkeypatched pause point (recycleWorker provably reached
// the window), never a fixed wait standing in for an unobserved condition.
//
// Run: 1) build (pnpm --filter @loom/daemon build), 2) node packages/daemon/test/recycle-merge-reverse-race.mjs
//
// Scenarios:
//   (A) THE FIX, end to end: a confirmWorkerMergeTracked call landing WHILE recycleWorker is mid-swap on
//       the same task/worktree is refused ("already in flight"), its gate NEVER starts (the gate-start
//       marker file is proven never created, checked right after the synchronous rejection — not a timed
//       wait), and recycleWorker itself completes normally once released, with no collision.
//   (B) ISOLATED SANITY CHECK — decomposed from (A): holding JUST the claim (no recycleWorker machinery at
//       all) is sufficient, on its own, to make confirmWorkerMergeTracked's mint reject via the existing
//       spawnMintConflict predicate. This is the same mechanism (A) exercises end to end; (B) isolates it.
//   (C) RELEASE-ON-THROW: a recycleWorker call that throws before ever reaching the fresh successor (the
//       pre-existing "predecessor might still be alive" refusal) still releases the claim — a subsequent
//       confirmWorkerMergeTracked for the same task succeeds right after.
//   (D) Code Review 4cae0fd4 MAJOR fix verification: a thrower that sits BEFORE the claim is minted
//       (listUnresolvedQueuedMessagesForWorker, one of the two named leak sites) never acquires it at all —
//       the claim reads clean right after, same as (C) but for the OTHER end of the pre-successor window.
//   (E) Code Review 4cae0fd4 MINOR fix verification (the mutex): a SECOND recycleWorker call for the SAME
//       predecessor, landing while the first is still mid-swap (hasSuccessor is still false — the
//       pre-existing idempotency guard does not yet catch this), is refused by the new has()-check; the
//       first call is unaffected and still completes; the claim is released exactly once.
//   (F) Code Review 4cae0fd4 test-gap fix: the claim is released after a plain, UNINTERRUPTED SUCCESSFUL
//       recycle too (not just after a throw) — proven RED with the success-path release line manually,
//       temporarily removed (see the inline note at this scenario).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Deterministic "the gate is genuinely running" wait — never a blind fixed sleep. Bounded so a genuine
// regression (the gate never starts at all) fails fast instead of hanging the suite.
const waitForMarker = async (marker) => {
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await sleep(20);
  return fs.existsSync(marker);
};

const tmpHome = path.join(os.tmpdir(), `loom-rmrr-${Date.now()}-${process.pid}`);
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
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=rmrr@loom -c user.name=rmrr";
const now = new Date().toISOString();

const SeamHost = createSeamHost(PtyHost);
// Scenario (C) only: forces recycleWorker's pre-existing "predecessor might still be alive" refusal with
// NO live-pty registration needed at all. getPid() is overridden to return a fixed, real-looking pid (the
// base PtyHost.getPid() returns undefined with no live entry, which short-circuits recycleWorker straight
// to the "trivially mismatch/dead" branch — never reaching the refusal this scenario needs). With a real
// pid but no live entry, verifyRootDeadOrForceKill's own `owner` resolves to undefined, and a probe
// reporting foundAlive+identityConfirmed+true then falls through to its own "identity matched but no
// owner could be resolved" branch — `identity:"unreadable"`, which recycleWorker's own gate treats as
// "might still be alive" exactly like a confirmed survivor. No 5-second isAlive-poll wait needed either:
// with no live entry, isAlive() is false from the first check, so that loop exits immediately.
class UnkillablePredecessorHost extends SeamHost {
  getPid(_sessionId) { return 99999; }
  async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: true, identityConfirmed: true, enumerationFailed: false }; }
}

const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const db = new Db();
const host = new SeamHost(events);
const GENEROUS_SYNC_BUDGET_MS = 60_000;
const svc = new SessionService(db, host, new OrchestrationControl(), { reapWorktreeProcesses: async () => ({ killedPids: [] }), syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });

function makeRepo(prefix) {
  const repo = path.join(os.tmpdir(), `loom-rmrr-repo-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# rmrr-${prefix}\n`);
  execSync(`git init -q && git config user.email rmrr@loom && git config user.name rmrr`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
function seedProject(projId, repo, gateCommand) {
  db.insertProject({ id: projId, name: "RMRR", repoPath: repo, vaultPath: repo, config: gateCommand ? { orchestration: { gateCommand } } : {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${projId}-mgr`, projectId: projId, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: `${projId}-dev`, projectId: projId, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
  db.insertSession({ id: `${projId}-mgr1`, projectId: projId, agentId: `${projId}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}
function stopSeamPty(sessionId) { try { host.stop(sessionId, "hard"); } catch { /* best-effort cleanup */ } }
function slowGateCommand(marker) {
  return `node -e "require('fs').appendFileSync('${marker.replace(/\\/g, "/")}', 'x'); setTimeout(()=>process.exit(0), 2500)"`;
}

// Pauses recycleWorker right after it has confirmed the predecessor dead and swept siblings — i.e. exactly
// the window the card names: "through the verify await, retireSiblingSessionsForTask ... until the new pty
// is live" — but BEFORE it inserts the fresh successor row. Returns {paused, release} — `paused` resolves
// once recycleWorker has genuinely reached that point (deterministic, no sleep); calling `release()` lets
// it proceed to insertSession/spawn.
function pauseRecycleBeforeSuccessorInsert() {
  let pausedResolve;
  const paused = new Promise((resolve) => { pausedResolve = resolve; });
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const original = svc.retireSiblingSessionsForTask.bind(svc);
  svc.retireSiblingSessionsForTask = async (taskId, keepId) => {
    const result = await original(taskId, keepId);
    pausedResolve();
    await gate;
    return result;
  };
  return { paused, release: releaseGate, restore: () => { svc.retireSiblingSessionsForTask = original; } };
}

try {
  // =============================================================================================
  // (A) THE FIX, end to end.
  // =============================================================================================
  {
    const P = "rmrr-fix", repo = makeRepo("fix");
    const taskId = "rmrr-fix-task";
    const marker = path.join(os.tmpdir(), `loom-rmrr-marker-fix-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}.log`);
    seedProject(P, repo, slowGateCommand(marker));
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "worker-a-work\n");
    commitAll(worktreePath, "feat: worker A's real work", GIT_ID);
    db.insertTask({ id: taskId, projectId: P, title: "fix task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerAId = `${P}-wkrA`;
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId, worktreePath, branch });
    // Register a REAL (fake) live pty for the predecessor — without this, PtyHost.stop() finds no `live`
    // entry and no-ops (never invokes kill(), never fires onExit), so processState would never actually
    // transition and the test would not faithfully model a genuinely-live worker being recycled.
    host.spawn({ sessionId: workerAId, cwd: worktreePath, permission: "default", geometry: { cols: 80, rows: 24 }, role: "worker" });

    const { paused, release, restore } = pauseRecycleBeforeSuccessorInsert();
    const recyclePromise = svc.recycleWorker(`${P}-mgr1`, workerAId, "handoff: continuing");
    await paused;
    restore(); // the pause already fired; don't leave the monkeypatch in place for anything downstream

    check("(A setup) the predecessor is already confirmed dead (processState exited) while recycleWorker is still mid-swap", db.getSession(workerAId).processState === "exited");
    check("(A setup) the fresh successor row does not exist yet (no live session for this task)", db.liveSessionIdForTask(taskId) === undefined);
    check("(A FIX) spawnMintConflict now reports a conflict for this task mid-swap — recycleWorker's own claim is held",
      svc.spawnMintConflict(taskId, worktreePath, workerAId) !== undefined);
    check("(A setup) claimTaskWorktreeRefusal is UNAFFECTED by this fix (it reads mergeInFlightOpIdForTask/liveSessionIdForTask, not inFlightSpawnTaskIds) — still reads clean",
      svc.claimTaskWorktreeRefusal(taskId, workerAId) === undefined);

    let confirmErr = null;
    try { await svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerAId); } catch (e) { confirmErr = e; }
    check("(A FIX) confirmWorkerMergeTracked's mint is REFUSED while recycleWorker is still mid-swap, naming 'already in flight'",
      /already in flight/.test(confirmErr?.message ?? ""));
    // Checked immediately after the awaited (synchronous) rejection above, never via a timed wait: a
    // conflicting onOpMinted throws BEFORE pendingOps.attach() ever invokes its run() callback (see
    // docs/decisions/396d6602-*.md), so the gate command can only have started if the refusal above did
    // NOT happen — there is no race window between "confirm rejected" and "gate marker would exist".
    check("(A FIX) the gate NEVER started (no marker file) — the refused mint never reached run()", !fs.existsSync(marker));

    release();
    const fresh = await recyclePromise;

    check("(A CONSEQUENCE) recycleWorker completes normally once released, with no collision", fresh?.processState === "live" && fresh.taskId === taskId && fresh.worktreePath === worktreePath);
    check("(A CONSEQUENCE) the task was NEVER merged (the confirm was refused, not merely delayed) — stays non-terminal", db.getTask(taskId).columnKey !== "done");

    stopSeamPty(fresh.id);
  }

  // =============================================================================================
  // (B) ISOLATED SANITY CHECK — decomposes (A)'s mechanism from recycleWorker's own machinery: holding
  // JUST the claim (white-box poke, mirroring merge-spawn-task-in-flight.mjs scenario (10)'s identical
  // `svc.inFlightSpawnTaskIds.add(...)` convention) is sufficient on its own.
  // =============================================================================================
  {
    const P = "rmrr-control", repo = makeRepo("control");
    const taskId = "rmrr-control-task";
    seedProject(P, repo);
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "worker-a-work\n");
    commitAll(worktreePath, "feat: worker A's real work", GIT_ID);
    db.insertTask({ id: taskId, projectId: P, title: "control task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerAId = `${P}-wkrA`;
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId, worktreePath, branch });
    host.spawn({ sessionId: workerAId, cwd: worktreePath, permission: "default", geometry: { cols: 80, rows: 24 }, role: "worker" });

    const { paused, release, restore } = pauseRecycleBeforeSuccessorInsert();
    const recyclePromise = svc.recycleWorker(`${P}-mgr1`, workerAId, "handoff: continuing");
    await paused;
    restore();

    svc.inFlightSpawnTaskIds.add(taskId);
    let confirmErr = null;
    try { await svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerAId); } catch (e) { confirmErr = e; }
    check("(B) WITH the claim held in isolation, confirmWorkerMergeTracked's mint IS refused, naming 'already in flight'",
      /already in flight/.test(confirmErr?.message ?? ""));
    svc.inFlightSpawnTaskIds.delete(taskId); // simulated poke cleanup — never a real spawn to release it

    release();
    const fresh = await recyclePromise;
    stopSeamPty(fresh.id);
  }

  // =============================================================================================
  // (C) RELEASE-ON-THROW.
  // =============================================================================================
  {
    const P = "rmrr-throw-release", repo = makeRepo("throw-release");
    const taskId = "rmrr-throw-release-task";
    const throwSvc = new SessionService(db, new UnkillablePredecessorHost(events), new OrchestrationControl(), { reapWorktreeProcesses: async () => ({ killedPids: [] }), syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });
    seedProject(P, repo);
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "worker-a-work\n");
    commitAll(worktreePath, "feat: worker A's real work", GIT_ID);
    db.insertTask({ id: taskId, projectId: P, title: "throw-release task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerAId = `${P}-wkrA`;
    // Deliberately NOT registering a live pty — UnkillablePredecessorHost's overrides force the
    // "predecessor might still be alive" throw with no live entry at all (see its own class doc above).
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId, worktreePath, branch });

    let recycleErr = null;
    try { await throwSvc.recycleWorker(`${P}-mgr1`, workerAId, "handoff: will throw"); } catch (e) { recycleErr = e; }
    check("(C setup) recycleWorker genuinely THROWS the pre-existing 'predecessor might still be alive' refusal",
      /could not be confirmed dead/.test(recycleErr?.message ?? ""));
    check("(C) RELEASE-ON-THROW, white-box: spawnMintConflict reads clean for this task right after the throw — the claim did not leak",
      throwSvc.spawnMintConflict(taskId, worktreePath, workerAId) === undefined);

    // Black-box, concrete proof: a REAL confirmWorkerMergeTracked for this same task, right after the
    // throw, must succeed — not refused for "in flight".
    const confirmResult = await throwSvc.confirmWorkerMergeTracked(`${P}-mgr1`, workerAId);
    check("(C) a real confirmWorkerMergeTracked for the same task succeeds right after the throw — no lingering claim",
      confirmResult.settled === true && confirmResult.ok === true && confirmResult.value?.merged === true);
  }

  // =============================================================================================
  // (D) Code Review 4cae0fd4 MAJOR fix verification — a thrower BEFORE the claim is ever minted.
  // =============================================================================================
  {
    const P = "rmrr-pretry-throw", repo = makeRepo("pretry-throw");
    const taskId = "rmrr-pretry-throw-task";
    seedProject(P, repo);
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "worker-a-work\n");
    commitAll(worktreePath, "feat: worker A's real work", GIT_ID);
    db.insertTask({ id: taskId, projectId: P, title: "pretry-throw task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerAId = `${P}-wkrA`;
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId, worktreePath, branch });
    host.spawn({ sessionId: workerAId, cwd: worktreePath, permission: "default", geometry: { cols: 80, rows: 24 }, role: "worker" });

    // listUnresolvedQueuedMessagesForWorker is one of the two call sites Code Review 4cae0fd4 named as
    // sitting inside the OLD leak span (between the claim add and the try/finally that released it). With
    // the add now moved to directly above `try {`, this call runs BEFORE the claim ever exists — so a
    // throw here must prove the claim was never acquired at all, closing that exact leak site structurally.
    const original = db.listUnresolvedQueuedMessagesForWorker.bind(db);
    db.listUnresolvedQueuedMessagesForWorker = () => { throw new Error("(D test) injected pre-try failure"); };
    let recycleErr = null;
    try { await svc.recycleWorker(`${P}-mgr1`, workerAId, "handoff: will throw before the claim is minted"); } catch (e) { recycleErr = e; }
    db.listUnresolvedQueuedMessagesForWorker = original;

    check("(D setup) recycleWorker genuinely throws from the injected pre-try failure", /\(D test\) injected pre-try failure/.test(recycleErr?.message ?? ""));
    check("(D) MAJOR FIX: the claim was never acquired at all for a throw at this (formerly leaky) site — spawnMintConflict reads clean",
      svc.spawnMintConflict(taskId, worktreePath, workerAId) === undefined);

    stopSeamPty(workerAId);
  }

  // =============================================================================================
  // (E) Code Review 4cae0fd4 MINOR fix verification — the mutex closes a duplicate-recycle race.
  // =============================================================================================
  {
    const P = "rmrr-dup-recycle", repo = makeRepo("dup-recycle");
    const taskId = "rmrr-dup-recycle-task";
    seedProject(P, repo);
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "worker-a-work\n");
    commitAll(worktreePath, "feat: worker A's real work", GIT_ID);
    db.insertTask({ id: taskId, projectId: P, title: "dup-recycle task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerAId = `${P}-wkrA`;
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId, worktreePath, branch });
    host.spawn({ sessionId: workerAId, cwd: worktreePath, permission: "default", geometry: { cols: 80, rows: 24 }, role: "worker" });

    const { paused, release, restore } = pauseRecycleBeforeSuccessorInsert();
    const firstPromise = svc.recycleWorker(`${P}-mgr1`, workerAId, "handoff: first recycle");
    await paused;
    restore();

    // The pre-existing idempotency guard (hasSuccessor(workerSessionId)) is what normally refuses a
    // duplicate worker_recycle call — but it cannot see this window at all: the fresh successor row isn't
    // inserted yet, so hasSuccessor still reads false. Only the new has()-check (the mutex) catches this.
    check("(E setup) hasSuccessor is still false while the first recycle is mid-swap (the pre-existing idempotency guard can't catch this)",
      db.hasSuccessor(workerAId) === false);

    let secondErr = null;
    try { await svc.recycleWorker(`${P}-mgr1`, workerAId, "handoff: duplicate recycle attempt"); } catch (e) { secondErr = e; }
    check("(E) MINOR FIX: a SECOND concurrent recycle of the SAME predecessor is refused by the mutex, naming 'already has a spawn or recycle in flight'",
      /already has a spawn or recycle in flight/.test(secondErr?.message ?? ""));

    release();
    const fresh = await firstPromise;
    check("(E) the FIRST recycle completes normally despite the refused duplicate", fresh?.processState === "live" && fresh.taskId === taskId && fresh.worktreePath === worktreePath);
    // Exclude fresh.id (the NOW-live holder), not the stale predecessor id: once fresh is live,
    // spawnMintConflict's own liveHolder check would otherwise report a conflict regardless of the
    // in-flight claim, which would test the wrong thing. Excluding fresh.id isolates the inFlightSpawnTaskIds
    // dimension specifically — the only way this can still read non-clean is a genuine leak.
    check("(E) the claim is released exactly once by the first call's own settle — not leaked by the refused duplicate's non-participation",
      svc.spawnMintConflict(taskId, worktreePath, fresh.id) === undefined);

    stopSeamPty(fresh.id);
  }

  // =============================================================================================
  // (F) Code Review 4cae0fd4 test-gap fix — the claim is released after a plain SUCCESSFUL recycle too,
  // not only after a throw. RED/GREEN proven by hand: there is only ONE release line in recycleWorker's
  // outer `finally` (`if (taskId) this.inFlightSpawnTaskIds.delete(taskId);`), shared by every exit path
  // through its try block — temporarily commenting it out and rebuilding did not merely fail (F)'s own
  // checks, it crashed the WHOLE script on an uncaught rejection from scenario (C)'s own subsequent
  // confirmWorkerMergeTracked call (that scenario's claim leaked too, for the same reason). Restoring the
  // line and rebuilding made every scenario pass again. Not re-run automatically by this file — that would
  // require shipping a second, deliberately-broken build inside the suite itself; see this session's own
  // transcript for the captured before/after run.
  // =============================================================================================
  {
    const P = "rmrr-success-release", repo = makeRepo("success-release");
    const taskId = "rmrr-success-release-task";
    seedProject(P, repo);
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "worker-a-work\n");
    commitAll(worktreePath, "feat: worker A's real work", GIT_ID);
    db.insertTask({ id: taskId, projectId: P, title: "success-release task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerAId = `${P}-wkrA`;
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId, worktreePath, branch });
    host.spawn({ sessionId: workerAId, cwd: worktreePath, permission: "default", geometry: { cols: 80, rows: 24 }, role: "worker" });

    const fresh = await svc.recycleWorker(`${P}-mgr1`, workerAId, "handoff: plain uninterrupted recycle");

    check("(F) a plain, uninterrupted recycle completes normally", fresh?.processState === "live" && fresh.taskId === taskId);
    // Exclude fresh.id (the live holder), not the stale predecessor id — see (E)'s identical note above for
    // why that's the shape that actually isolates the inFlightSpawnTaskIds claim, not liveHolder's own
    // (expected, unrelated) protection once a successor is live.
    check("(F) the claim is released after a SUCCESSFUL recycle too, not only after a throw — spawnMintConflict reads clean",
      svc.spawnMintConflict(taskId, worktreePath, fresh.id) === undefined);

    stopSeamPty(fresh.id);
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
} finally {
  // best-effort: nothing else durable to clean beyond the registered temp dirs (_tmp-fixture.mjs's own
  // process-exit hook removes them).
}
