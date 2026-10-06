import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 656e326f — ownership check before attaching to an in-flight/retained/cached spawn or merge op.
//
// `PendingOpRegistry.attach()` can hand a caller the result of an op it did not mint — an already-RUNNING
// op, a TTL'd `retained` hit, or (for merge only) the never-expiring `untilSupersededVerdicts` cache hit.
// None of those paths re-enters the real operation's own body, so an ownership check written only inside
// that body (`confirmWorkerMerge`'s `NotYourWorkerError`, `reviveWorker`'s own parent check) never ran for
// an attach — a manager holding a `workerSessionId`/`taskId` it did not own could attach to another
// manager's op and receive its full result. Fixed by hoisting an ownership check BEFORE `attach()` is ever
// called, compared by LINEAGE ROOT (never exact session id — see docs/decisions/656e326f-*.md for why an
// exact-id check would wrongly refuse a legitimate recycle predecessor/successor, including
// `mergeBatchTracked`'s own fallback acting on a worker's current resolved owner).
//
// Merge: the check is UNCONDITIONAL (runs on every call, fresh mint or attach alike) — so there is no
// separate "running" vs "TTL-retained" vs "until-superseded" refusal shape to prove; a foreign manager is
// refused identically regardless of registry state, and the registry is never even consulted for it. What
// DOES differ across those states, and so IS worth proving per-state, is that the OWNER's own legitimate
// calls still succeed through the hoisted check (no regression), including a recycled successor's.
//
// Spawn/revive: INFORM, don't leak — an attach to a RUNNING op, or a TTL-retained op `attach()` would
// itself still serve as a cache hit (reusing attach()'s own usable-vs-miss rule via `peekAttachable` —
// see docs/decisions/656e326f-*.md "Round 2"), by a caller whose lineage root doesn't own it gets a typed
// `ForeignSpawnInFlightError`, never the op's eventual Session. The message distinguishes the two states:
// "in-flight" for a running op, "already spawned by another manager's recent op" for a usable retained one.
//
// Real git + a REAL PtyHost (fake createPty seam — no claude), NO live daemon — drives SessionService
// directly, mirroring merge-spawn-tracked.mjs's/worker-revive.mjs's in-process style.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-spawn-ownership-attach.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const noReap = async () => ({ killedPids: [] });
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-msoa-${Date.now()}-${process.pid}`);
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
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

const GIT_ID = "-c user.email=msoa@loom -c user.name=msoa";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

class SeamHost extends createSeamHost(PtyHost) {}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const db = new Db();
const host = new SeamHost(events);
// Same generous budget as merge-spawn-tracked.mjs — every call below is a REAL git/worktree op racing the
// production SYNC_ATTACH_BUDGET_MS (12s); no scenario here depends on exceeding it.
const GENEROUS_SYNC_BUDGET_MS = 60_000;
const svc = new SessionService(db, host, new OrchestrationControl(), { reapWorktreeProcesses: noReap, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });

function makeRepo() {
  const repo = path.join(os.tmpdir(), `loom-msoa-repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# msoa\n");
  execSync(`git init -q && git config user.email msoa@loom && git config user.name msoa`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// `P` gets one project + a Dev worker agent + a Mgr agent, plus THREE manager sessions: `${P}-owner` (the
// legitimate owner for every scenario below), `${P}-foreign` (an entirely unrelated manager — never in the
// owner's lineage), and `${P}-owner` is later recycled per-scenario where a successor is needed.
function seedProject(projId, repo, gateCommand) {
  db.insertProject({ id: projId, name: "MSOA", repoPath: repo, vaultPath: repo, config: gateCommand ? { orchestration: { gateCommand } } : {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${projId}-mgr`, projectId: projId, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: `${projId}-dev`, projectId: projId, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
  const mgrRow = (id) => ({ id, projectId: projId, agentId: `${projId}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession(mgrRow(`${projId}-owner`));
  db.insertSession(mgrRow(`${projId}-foreign`));
}

function stopSeamPty(sessionId) {
  try { host.stop(sessionId, "hard"); } catch { /* best-effort cleanup */ }
}

const worktrees = [];
try {
  // =============================================================================================
  // MERGE (1): a FRESH call by a foreign manager is refused immediately — never reaches confirmWorkerMerge
  // =============================================================================================
  {
    const P = "msoa-merge-fresh", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "tm1");
    fs.writeFileSync(path.join(worktreePath, "feat1.txt"), "work\n");
    commitAll(worktreePath, "feat1", GIT_ID);
    seedProject(P, repo);
    const workerId = `${P}-wkr`;
    db.insertTask({ id: "tm1", projectId: P, title: "tm1", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-owner`, taskId: "tm1", worktreePath, branch });

    const headBefore = git(repo, "rev-parse HEAD");
    const foreign = await svc.confirmWorkerMergeTracked(`${P}-foreign`, workerId);
    check("(merge fresh) a foreign manager is refused — settled, ok:false", foreign.settled === true && foreign.ok === false);
    check("(merge fresh) the refusal is the typed NotYourWorkerError ('not your worker')", /not your worker/.test(foreign.error?.message ?? ""));
    check("(merge fresh) nothing changed — no commit landed, worktree untouched", git(repo, "rev-parse HEAD") === headBefore && fs.existsSync(worktreePath));

    // The owner's OWN call right after still succeeds normally — the hoisted check never blocks the
    // legitimate caller, and the foreign call above minted nothing for it to have collided with.
    const owner = await svc.confirmWorkerMergeTracked(`${P}-owner`, workerId);
    check("(merge fresh) the OWNER's own confirm still merges normally", owner.settled === true && owner.ok === true && owner.value.merged === true);
    check("(merge fresh) exactly ONE new commit landed total", git(repo, `rev-list --count ${headBefore}..HEAD`) === "1");
  }

  // =============================================================================================
  // MERGE (2): the TTL-retained window — a foreign manager re-confirming moments after the owner's
  // settle must NOT receive the owner's cached merge result (the actual leak the card found: pre-fix,
  // this landed a full ConfirmMergeResult — commit sha, gateDetail, branch info — on an unrelated manager).
  // =============================================================================================
  {
    const P = "msoa-merge-retain", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "tm2");
    fs.writeFileSync(path.join(worktreePath, "feat2.txt"), "work\n");
    commitAll(worktreePath, "feat2", GIT_ID);
    seedProject(P, repo);
    const workerId = `${P}-wkr`;
    db.insertTask({ id: "tm2", projectId: P, title: "tm2", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-owner`, taskId: "tm2", worktreePath, branch });

    const owner = await svc.confirmWorkerMergeTracked(`${P}-owner`, workerId);
    check("(merge retain) owner's confirm merges", owner.settled === true && owner.ok === true && owner.value.merged === true);

    // Immediately re-confirm as a FOREIGN manager — well within MERGE_OP_RETAIN_MS (5s). Pre-fix this hit
    // the retained-view cache and returned `owner`'s own result with no ownership check at all.
    const foreign = await svc.confirmWorkerMergeTracked(`${P}-foreign`, workerId);
    check("(merge retain) the foreign manager is refused, not handed the retained-cache hit", foreign.settled === true && foreign.ok === false && /not your worker/.test(foreign.error?.message ?? ""));
    check("(merge retain) the refusal carries NO merge data at all (no .value leaked via .error)", foreign.value === undefined);
  }

  // =============================================================================================
  // MERGE (3): POSITIVE CONTROL — a recycled SUCCESSOR of the owner, re-confirming within the SAME
  // retention window, succeeds and gets the SAME cached opId. Proves the lineage-root check doesn't
  // overcorrect into refusing a legitimate recycle successor.
  // =============================================================================================
  {
    const P = "msoa-merge-successor", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "tm3");
    fs.writeFileSync(path.join(worktreePath, "feat3.txt"), "work\n");
    commitAll(worktreePath, "feat3", GIT_ID);
    seedProject(P, repo);
    const workerId = `${P}-wkr`;
    db.insertTask({ id: "tm3", projectId: P, title: "tm3", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-owner`, taskId: "tm3", worktreePath, branch });

    const owner = await svc.confirmWorkerMergeTracked(`${P}-owner`, workerId);
    check("(merge successor) owner's confirm merges", owner.settled === true && owner.ok === true && owner.value.merged === true);

    const successor = await svc.recycleManager(`${P}-owner`, "handoff");
    check("(merge successor) owner recycled successfully", !!successor?.id);
    stopSeamPty(successor.id);

    const recall = await svc.confirmWorkerMergeTracked(successor.id, workerId);
    check("(merge successor) the SUCCESSOR re-confirming within the window SUCCEEDS (same lineage, not refused)", recall.settled === true && recall.ok === true);
    check("(merge successor) returns the EXACT SAME cached opId (a genuine cache hit, not a fresh re-gate)", recall.ok === true && recall.value.opId === owner.value.opId);

    // Negative control alongside the positive one: a genuinely unrelated manager is STILL refused.
    const foreign = await svc.confirmWorkerMergeTracked(`${P}-foreign`, workerId);
    check("(merge successor) an UNRELATED manager is still refused", foreign.settled === true && foreign.ok === false && /not your worker/.test(foreign.error?.message ?? ""));
  }

  // =============================================================================================
  // MERGE (3b): card 164f7915, ROUND 2 (Code Review 2471d6b8 of commit 71022460) — a recycled SUCCESSOR
  // attaches to a genuinely RUNNING op, not merely a retained/cached hit (MERGE (3) above is the TTL-
  // retained shape; this is the running one). The worker is NON-live at recycle time — the exact residual
  // `reparentLiveWorkers` (process_state='live'-gated) leaves behind, so the worker's parentSessionId
  // stays pointed at the now-dead predecessor FOREVER. Round 1's own fix (an early exact-id refusal
  // hoisted before `pendingOps.attach()`) wrongly refused this exact caller — the successor's id can never
  // equal that stale parentSessionId. Only the lineage check (656e326f) may gate this attach-reachable path.
  // =============================================================================================
  {
    const P = "msoa-merge-successor-running", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "tm3b");
    fs.writeFileSync(path.join(worktreePath, "feat3b.txt"), "work\n");
    commitAll(worktreePath, "feat3b", GIT_ID);
    seedProject(P, repo, "pnpm gate");
    const workerId = `${P}-wkr`;
    db.insertTask({ id: "tm3b", projectId: P, title: "tm3b", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    // NON-live at recycle time — reparentLiveWorkers never touches this row.
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-owner`, taskId: "tm3b", worktreePath, branch });

    let releaseGate;
    const gateHold = new Promise((res) => { releaseGate = res; });
    let gateCalls = 0;
    // SMALL budget on purpose (unlike the GENEROUS one `svc` uses elsewhere in this file): every call in
    // this scenario deliberately races a HELD-OPEN gate, so a generous budget would block each of those
    // calls (and this test) for its full length before degrading, and would let the owner's own mint
    // degrade to a stale pending result LONG before `releaseGate` is ever reached — never re-observed
    // against the real settle afterward. Mirrors the small-budget pattern merge-rest-route-tracked.mjs's
    // held-gate scenarios already use.
    const svcHeld = new SessionService(db, host, new OrchestrationControl(), {
      reapWorktreeProcesses: noReap, syncAttachBudgetMs: 50,
      runGate: async () => { gateCalls++; await gateHold; return { passed: true }; },
    });

    const ownerPromise = svcHeld.confirmWorkerMergeTracked(`${P}-owner`, workerId);
    await ownerPromise; // degrades to {settled:false} almost immediately (small budget, gate still held)
    check("(merge successor-running) [setup] the owner's op is genuinely RUNNING (not yet settled)",
      svcHeld.peekPendingMerge(workerId)?.state === "running");
    const ownerOpId = svcHeld.peekPendingMerge(workerId)?.opId;

    const successor = await svcHeld.recycleManager(`${P}-owner`, "handoff");
    check("(merge successor-running) owner recycled successfully", !!successor?.id);
    stopSeamPty(successor.id);
    check("(merge successor-running) [setup] the worker's parentSessionId is STILL the dead predecessor (the residual)",
      db.getSession(workerId).parentSessionId === `${P}-owner`);

    // Negative control FIRST, while still running: an unrelated manager is still refused.
    const foreignWhileRunning = await svcHeld.confirmWorkerMergeTracked(`${P}-foreign`, workerId);
    check("(merge successor-running) an UNRELATED manager is refused while the op is still running",
      foreignWhileRunning.settled === true && foreignWhileRunning.ok === false && /not your worker/.test(foreignWhileRunning.error?.message ?? ""));

    const viaSuccessor = await svcHeld.confirmWorkerMergeTracked(successor.id, workerId);
    check("(merge successor-running) [ROUND 2] the successor ATTACHES to the still-RUNNING op — not refused as 'not your worker'",
      viaSuccessor.settled === false);
    check("(merge successor-running) the attach names the SAME opId the owner's call minted",
      viaSuccessor.settled === false && viaSuccessor.op?.opId === ownerOpId);

    releaseGate("go");
    await svcHeld.pendingOps.waitBriefly(`merge:${workerId}`, 30_000);
    // Re-call (rather than re-await the owner's own already-degraded promise above) to fetch the REAL
    // settled result via the SAME dedupe-attach path a genuine poll would use.
    const ownerResult = await svcHeld.confirmWorkerMergeTracked(successor.id, workerId);
    check("(merge successor-running) the owner's original op settles + merges once released",
      ownerResult.settled === true && ownerResult.ok === true && ownerResult.value?.merged === true);
    check("(merge successor-running) exactly ONE real gate invocation total — the successor's attach never re-minted", gateCalls === 1);
  }

  // =============================================================================================
  // MERGE (4): FALLBACK-AFTER-RECYCLE — mergeBatchTracked's runFallback calls confirmWorkerMergeTracked
  // with a worker's CURRENT resolved owner (resolveLineageOwnerForWorker), which it derives from the
  // worker's OWN row and only ever hands back a value that already equals the row's current
  // parentSessionId (never a "corrected" id of its own invention). For a LIVE worker, a manager recycle
  // DOES relink it (db.ts `reparentLiveWorkers`, `process_state = 'live'`-gated) — so by the time
  // runFallback dispatches, `owner` and `worker.parentSessionId` are both the successor. This proves that
  // real end-to-end shape still lands cleanly through the hoisted lineage-root check.
  // =============================================================================================
  {
    const P = "msoa-merge-fallback-recycle", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "tm4");
    fs.writeFileSync(path.join(worktreePath, "feat4.txt"), "work\n");
    commitAll(worktreePath, "feat4", GIT_ID);
    seedProject(P, repo);
    const workerId = `${P}-wkr`;
    db.insertTask({ id: "tm4", projectId: P, title: "tm4", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    // LIVE worker, owned by `${P}-owner` — reparentLiveWorkers relinks it to the successor below.
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-owner`, taskId: "tm4", worktreePath, branch });

    const successor = await svc.recycleManager(`${P}-owner`, "handoff");
    check("(merge fallback-recycle) owner recycled successfully", !!successor?.id);
    stopSeamPty(successor.id);
    check("(merge fallback-recycle) PRECONDITION: the LIVE worker WAS relinked to the successor", db.getSession(workerId).parentSessionId === successor.id);

    const headBefore = git(repo, "rev-parse HEAD");
    // Exactly runFallback's own call shape: pass the resolved CURRENT owner (here, the successor, since
    // the worker's row already agrees) to confirmWorkerMergeTracked.
    const viaSuccessor = await svc.confirmWorkerMergeTracked(successor.id, workerId);
    check("(merge fallback-recycle) the successor (current resolved owner) is NOT wrongly refused", viaSuccessor.settled === true && viaSuccessor.ok === true && viaSuccessor.value.merged === true);
    check("(merge fallback-recycle) exactly ONE new commit landed", git(repo, `rev-list --count ${headBefore}..HEAD`) === "1");

    // Negative control, same scenario: an unrelated manager is still refused.
    const foreignOnLive = await svc.confirmWorkerMergeTracked(`${P}-foreign`, workerId);
    check("(merge fallback-recycle) an UNRELATED manager is refused for the same (now-merged) worker", foreignOnLive.settled === true && foreignOnLive.ok === false && /not your worker/.test(foreignOnLive.error?.message ?? ""));
  }

  // NOTE on an EXITED (never-relinked) worker, deliberately NOT asserted here: reparentLiveWorkers is
  // `process_state = 'live'`-gated, so an already-exited worker's parentSessionId is NEVER updated by a
  // manager recycle. A successor calling confirmWorkerMergeTracked DIRECTLY for such a worker still hits
  // the PRE-EXISTING, exact-match `NotYourWorkerError` check inside confirmWorkerMerge's own body
  // (service.ts, unconditional, runs on every fresh mint — unchanged by this card and out of its scope;
  // card 7e5b23e7 is concurrently editing this exact area). This card's hoisted check only ever gates an
  // ATTACH (running/retained/until-superseded) — see MERGE (3) above for that proof — never a fresh mint,
  // so it neither introduces nor fixes this pre-existing exact-match behavior for a direct, non-attach call.

  // =============================================================================================
  // SPAWN (5): RUNNING — two concurrent (unawaited) calls on the SAME taskId, one from the owner, one
  // from a foreign manager. No await between the two calls — call #1's synchronous prefix (through
  // PendingOpRegistry.attach()'s mint, before run()'s first internal await) runs before call #2's own
  // prefix, so #2's ownership guard sees #1's already-minted RUNNING entry (same determinism as
  // merge-spawn-tracked.mjs's own "(spawn race)" scenario).
  // =============================================================================================
  {
    const P = "msoa-spawn-running", repo = makeRepo();
    seedProject(P, repo);
    const taskId = randomUUID();
    db.insertTask({ id: taskId, projectId: P, title: "ts5", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    const p1 = svc.spawnWorkerTracked(`${P}-owner`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    const p2 = svc.spawnWorkerTracked(`${P}-foreign`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    const [r1, r2] = await Promise.all([p1, p2]);

    check("(spawn running) the OWNER's call succeeds and creates the worker", r1.settled === true && r1.ok === true && r1.value.taskId === taskId);
    check("(spawn running) the FOREIGN manager is refused, never attached to the owner's in-flight op", r2.settled === true && r2.ok === false);
    check("(spawn running) the refusal names the typed ForeignSpawnInFlightError", /already being spawned by another manager/.test(r2.error?.message ?? ""));
    check("(spawn running) the refusal carries NO Session data", r2.value === undefined);
    const rowsForTask = db.listAllSessions().filter((s) => s.taskId === taskId);
    check("(spawn running) exactly ONE session row was created", rowsForTask.length === 1);
    if (r1.settled && r1.ok) { worktrees.push([repo, r1.value.worktreePath]); stopSeamPty(r1.value.id); }
  }

  // =============================================================================================
  // SPAWN (6): TTL-retained window — a foreign manager re-calling moments after the owner's settle,
  // well within spawnOpRetainMs, must NOT receive the owner's Session.
  // =============================================================================================
  {
    const P = "msoa-spawn-retain", repo = makeRepo();
    seedProject(P, repo);
    const taskId = randomUUID();
    db.insertTask({ id: taskId, projectId: P, title: "ts6", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    // A dedicated SessionService instance with a small spawnOpRetainMs — same technique
    // merge-spawn-tracked.mjs's "(spawn retain)" scenario uses, proportionally mirroring production's
    // 10-minute window without a real wall-clock wait. Shares the SAME db/host as `svc`.
    const svcRetain = new SessionService(db, host, new OrchestrationControl(), { reapWorktreeProcesses: noReap, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS, spawnOpRetainMs: 500 });

    const owner = await svcRetain.spawnWorkerTracked(`${P}-owner`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(spawn retain) owner's call settles + creates the live worker", owner.settled === true && owner.ok === true);
    worktrees.push([repo, owner.value.worktreePath]);

    // Round 2 (card 656e326f): no sleep needed to land "inside the window" — an immediate call is
    // already inside it, and a sleep here only risked flaking the test if the run happened to cross the
    // 500ms boundary under load. The owner's worker is still live, so this hits a USABLE retained view.
    const foreign = await svcRetain.spawnWorkerTracked(`${P}-foreign`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(spawn retain) the foreign manager is refused, not handed the retained worker", foreign.settled === true && foreign.ok === false && /already spawned by another manager's recent op/.test(foreign.error?.message ?? ""));
    const rowsForTask = db.listAllSessions().filter((s) => s.taskId === taskId);
    check("(spawn retain) still exactly ONE session row for the task", rowsForTask.length === 1);
    stopSeamPty(owner.value.id);
  }

  // =============================================================================================
  // SPAWN (7): POSITIVE CONTROL — a recycled SUCCESSOR of the owner, calling within the SAME retention
  // window, succeeds and gets back the SAME worker (a genuine cache hit) — not refused.
  // =============================================================================================
  {
    const P = "msoa-spawn-successor", repo = makeRepo();
    seedProject(P, repo);
    const taskId = randomUUID();
    db.insertTask({ id: taskId, projectId: P, title: "ts7", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    const svcRetain = new SessionService(db, host, new OrchestrationControl(), { reapWorktreeProcesses: noReap, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS, spawnOpRetainMs: 2_000 });

    const owner = await svcRetain.spawnWorkerTracked(`${P}-owner`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(spawn successor) owner's call settles + creates the live worker", owner.settled === true && owner.ok === true);
    worktrees.push([repo, owner.value.worktreePath]);

    const successor = await svcRetain.recycleManager(`${P}-owner`, "handoff");
    check("(spawn successor) owner recycled successfully", !!successor?.id);
    stopSeamPty(successor.id);

    const recall = await svcRetain.spawnWorkerTracked(successor.id, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(spawn successor) the SUCCESSOR re-calling within the window SUCCEEDS (same worker, cache hit)", recall.settled === true && recall.ok === true && recall.value.id === owner.value.id && recall.cacheHit !== undefined);

    const foreign = await svcRetain.spawnWorkerTracked(`${P}-foreign`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(spawn successor) an UNRELATED manager is still refused", foreign.settled === true && foreign.ok === false && /already spawned by another manager's recent op/.test(foreign.error?.message ?? ""));
    stopSeamPty(owner.value.id);
  }

  // =============================================================================================
  // REVIVE (8): TTL-retained window — mirrors SPAWN (6)'s shape. A merged "src" worker, owned by
  // `${P}-owner`, is revived onto a follow-up task; a foreign manager re-calling worker_revive with the
  // SAME taskId, within the retention window, must be refused — never handed the revived Session.
  // =============================================================================================
  {
    const P = "msoa-revive-retain", repo = makeRepo();
    seedProject(P, repo);
    const origTaskId = randomUUID(), followUpTaskId = randomUUID();
    db.insertTask({ id: origTaskId, projectId: P, title: "feat(x): original landed card", body: "", columnKey: "done", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    db.updateTask(origTaskId, { mergedSha: "abc1234def" });
    db.insertTask({ id: followUpTaskId, projectId: P, title: "fix(x): follow-up", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    const OLD_CWD = path.join(os.tmpdir(), `loom-msoa-revive-gone-${process.pid}`);
    registerForCleanup(OLD_CWD);
    const ENG = randomUUID();
    const tpath = engineTranscriptPath(OLD_CWD, ENG);
    fs.mkdirSync(path.dirname(tpath), { recursive: true });
    fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "x" } }) + "\n");
    const srcId = `${P}-src`;
    db.insertSession({ id: srcId, projectId: P, agentId: `${P}-dev`, engineSessionId: ENG, title: null, cwd: OLD_CWD, processState: "exited", resumability: "dead", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-owner`, taskId: origTaskId, worktreePath: OLD_CWD, branch: "loom/old" });
    db.appendEvent({ id: `ev-${srcId}`, ts: now, managerSessionId: `${P}-owner`, workerSessionId: srcId, taskId: origTaskId, kind: "merge_done", detail: { branch: "loom/old" } });

    const svcRetain = new SessionService(db, host, new OrchestrationControl(), { reapWorktreeProcesses: noReap, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS, spawnOpRetainMs: 500 });

    const owner = await svcRetain.reviveWorkerTracked(`${P}-owner`, { workerSessionId: srcId, taskId: followUpTaskId });
    check("(revive retain) owner's revive settles ok, revivedFrom === src", owner.settled === true && owner.ok === true && owner.value.revivedFrom === srcId);
    worktrees.push([repo, owner.value.worktreePath]);

    // Round 2 (card 656e326f): no sleep needed — an immediate call is already inside the window, and a
    // sleep here only risked flaking the test if the run crossed the 500ms boundary under load. The
    // revived worker is still live, so this hits a USABLE retained view.
    const foreign = await svcRetain.reviveWorkerTracked(`${P}-foreign`, { workerSessionId: srcId, taskId: followUpTaskId });
    check("(revive retain) the foreign manager is refused, not handed the revived worker", foreign.settled === true && foreign.ok === false && /already spawned by another manager's recent op/.test(foreign.error?.message ?? ""));
    check("(revive retain) the refusal is distinct from the ordinary 'different spawn' collision message", !/different spawn/.test(foreign.error?.message ?? ""));
    stopSeamPty(owner.value.id);
  }

  // =============================================================================================
  // SPAWN (9): THE FALSE-REFUSAL INTEGRATION CASE (card 656e326f, Round 2) — a retained spawn op whose
  // cached worker has since EXITED is no longer "attachable": `pendingOps.attach()` itself would treat it
  // as a MISS (its own `isRetainedResultUsable` predicate rejects it), so an unrelated manager calling
  // WITHIN the same retention window must NOT be refused — it gets a genuinely fresh spawn instead. Before
  // this fix, `foreignSpawnGuard` consulted the raw, unfiltered `peek()` (no usability filtering at all)
  // and wrongly refused this exact case for up to spawnOpRetainMs after the owner's worker exited.
  //
  // LOAD-PROOFING (delta Code Review a503af08): a 500ms window only RED's reliably if the foreign call
  // actually lands inside it — under load that's not guaranteed, so this block uses a large
  // spawnOpRetainMs AND a positive witness (a raw `pendingOps.peek()`, bypassing the fix under test) that
  // the retained done view is still sitting there right before the foreign call — so a false PASS from the
  // window having already closed can never be mistaken for a genuine one.
  // =============================================================================================
  {
    const P = "msoa-spawn-exited-retain", repo = makeRepo();
    seedProject(P, repo);
    const taskId = randomUUID();
    db.insertTask({ id: taskId, projectId: P, title: "ts9", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    const svcRetain = new SessionService(db, host, new OrchestrationControl(), { reapWorktreeProcesses: noReap, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS, spawnOpRetainMs: 60_000 });

    const owner = await svcRetain.spawnWorkerTracked(`${P}-owner`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(spawn exited-retain) owner's call settles + creates the live worker", owner.settled === true && owner.ok === true);
    worktrees.push([repo, owner.value.worktreePath]);
    stopSeamPty(owner.value.id);
    // The owner's worker exits (merged/stopped/recycled away) WHILE the spawn op is still inside its
    // TTL-retained window — the exact gap the Round 2 fix closes.
    db.setProcessState(owner.value.id, "exited");
    check("(spawn exited-retain) precondition: liveSessionIdForTask no longer resolves to the owner's worker", db.liveSessionIdForTask(taskId) !== owner.value.id);

    // [witness] raw peek() (not peekAttachable — this is deliberately the UNFILTERED view) proves the
    // retained done entry is genuinely still present right before the foreign call, so a large
    // spawnOpRetainMs can never silently stop discriminating under load the way a tight 500ms window could.
    const retainedPeek = svcRetain.pendingOps.peek(`spawn:${taskId}`);
    check("(spawn exited-retain) [witness] the retained done view for this op is still present right before the foreign call", retainedPeek?.state === "done");

    const foreign = await svcRetain.spawnWorkerTracked(`${P}-foreign`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(spawn exited-retain) the unrelated manager is NOT refused — attach() would itself treat this retained hit as a MISS", foreign.settled === true && foreign.ok === true);
    check("(spawn exited-retain) a genuinely FRESH worker was spawned, not the stale cached one", foreign.settled && foreign.ok && foreign.value.id !== owner.value.id);
    if (foreign.settled && foreign.ok) { worktrees.push([repo, foreign.value.worktreePath]); stopSeamPty(foreign.value.id); }
  }

  // =============================================================================================
  // REVIVE (10): THE FALSE-REFUSAL INTEGRATION CASE, mirrored for `reviveWorkerTracked`'s OWN hoisted
  // `foreignSpawnGuard` call — SPAWN (9) above proves this for `spawnWorkerTracked`'s call; this proves
  // the identical fix for the SEPARATE call site `reviveWorkerTracked` makes. After the revived worker
  // exits WHILE the spawn op is still inside its TTL-retained window, an unrelated manager's own
  // `reviveWorkerTracked` call must NOT be refused — `pendingOps.attach()` would itself treat the cached
  // hit as a MISS. Uses a large spawnOpRetainMs plus the same raw-`peek()` positive witness as SPAWN (9).
  // =============================================================================================
  {
    const P = "msoa-revive-exited-retain", repo = makeRepo();
    seedProject(P, repo);
    const origTaskIdOwner = randomUUID(), origTaskIdForeign = randomUUID(), followUpTaskId = randomUUID();
    db.insertTask({ id: origTaskIdOwner, projectId: P, title: "feat(x): original landed card (owner)", body: "", columnKey: "done", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    db.updateTask(origTaskIdOwner, { mergedSha: "abc1234def" });
    db.insertTask({ id: origTaskIdForeign, projectId: P, title: "feat(y): original landed card (foreign)", body: "", columnKey: "done", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    db.updateTask(origTaskIdForeign, { mergedSha: "def4321abc" });
    db.insertTask({ id: followUpTaskId, projectId: P, title: "fix(x): follow-up", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    // A merged "src" worker per manager, so EACH manager's reviveWorkerTracked call has a source it
    // legitimately owns (reviveWorker refuses a src whose parentSessionId isn't the calling manager).
    const makeMergedSrc = (suffix, ownerMgrId, origTaskId) => {
      const OLD_CWD = path.join(os.tmpdir(), `loom-msoa-revive-exited-${suffix}-${process.pid}`);
      registerForCleanup(OLD_CWD);
      const ENG = randomUUID();
      const tpath = engineTranscriptPath(OLD_CWD, ENG);
      fs.mkdirSync(path.dirname(tpath), { recursive: true });
      fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "x" } }) + "\n");
      const srcId = `${P}-src-${suffix}`;
      db.insertSession({ id: srcId, projectId: P, agentId: `${P}-dev`, engineSessionId: ENG, title: null, cwd: OLD_CWD, processState: "exited", resumability: "dead", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ownerMgrId, taskId: origTaskId, worktreePath: OLD_CWD, branch: `loom/old-${suffix}` });
      db.appendEvent({ id: `ev-${srcId}`, ts: now, managerSessionId: ownerMgrId, workerSessionId: srcId, taskId: origTaskId, kind: "merge_done", detail: { branch: `loom/old-${suffix}` } });
      return srcId;
    };
    const srcId = makeMergedSrc("owner", `${P}-owner`, origTaskIdOwner);
    const srcIdForeign = makeMergedSrc("foreign", `${P}-foreign`, origTaskIdForeign);

    const svcRetain = new SessionService(db, host, new OrchestrationControl(), { reapWorktreeProcesses: noReap, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS, spawnOpRetainMs: 60_000 });

    const owner = await svcRetain.reviveWorkerTracked(`${P}-owner`, { workerSessionId: srcId, taskId: followUpTaskId });
    check("(revive exited-retain) owner's revive settles + creates the live worker", owner.settled === true && owner.ok === true);
    worktrees.push([repo, owner.value.worktreePath]);
    stopSeamPty(owner.value.id);
    // The revived worker exits (merged/stopped/recycled away) WHILE the spawn op is still inside its
    // TTL-retained window — the exact gap SPAWN (9) proves for a plain spawn, mirrored here for revive.
    db.setProcessState(owner.value.id, "exited");
    check("(revive exited-retain) precondition: liveSessionIdForTask no longer resolves to the revived worker", db.liveSessionIdForTask(followUpTaskId) !== owner.value.id);

    // [witness] raw peek() (not peekAttachable) proves the retained done entry is genuinely still present
    // right before the foreign call — same discipline as SPAWN (9)'s witness.
    const retainedPeek = svcRetain.pendingOps.peek(`spawn:${followUpTaskId}`);
    check("(revive exited-retain) [witness] the retained done view for this op is still present right before the foreign call", retainedPeek?.state === "done");

    const foreign = await svcRetain.reviveWorkerTracked(`${P}-foreign`, { workerSessionId: srcIdForeign, taskId: followUpTaskId });
    check("(revive exited-retain) the unrelated manager's OWN reviveWorkerTracked call is NOT refused — its foreignSpawnGuard call would itself treat this retained hit as a MISS", foreign.settled === true && foreign.ok === true);
    check("(revive exited-retain) a genuinely FRESH worker was revived, not the stale cached one", foreign.settled && foreign.ok && foreign.value.id !== owner.value.id && foreign.value.revivedFrom === srcIdForeign);
    if (foreign.settled && foreign.ok) { worktrees.push([repo, foreign.value.worktreePath]); stopSeamPty(foreign.value.id); }
  }
} finally {
  for (const [repo, wt] of worktrees) {
    if (!wt) continue;
    try { const { removeWorktree } = await import("../dist/git/worktrees.js"); await removeWorktree(repo, wt); } catch { /* best-effort */ }
  }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMergeTracked/spawnWorkerTracked/reviveWorkerTracked refuse an attach (running, TTL-retained, or until-superseded-cached) by a manager outside the op's lineage, while a legitimate recycle predecessor/successor — including mergeBatchTracked's own fallback-after-recycle shape — still succeeds."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
