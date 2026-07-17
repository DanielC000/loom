import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn / worker_merge_confirm CLIENT-TIMEOUT RESILIENCE test (card fb8df559 Part 1, Auditor
// b9515beb). REAL git + a REAL PtyHost (fake createPty seam — no claude), NO live daemon — drives
// SessionService.spawnWorkerTracked / confirmWorkerMergeTracked directly, mirroring
// worker-spawn-toctou-race.mjs's (spawn) and merge-confirm-idempotent.mjs's (merge) in-process style.
//
// The PendingOpRegistry mechanics themselves (fast/slow/retry-attach/consume-once/error-identity) are
// unit-tested in pending-ops-registry.mjs with tunable ms-scale wait budgets. THIS test proves the two
// Tracked wrappers compose correctly with REAL spawnWorker/confirmWorkerMerge:
//   (1) fast path: Tracked returns the SAME shape as the untracked method, just wrapped {settled,ok,value}.
//   (2) TWO concurrent (unawaited) Tracked calls on the SAME key attach to ONE real invocation — exactly
//       one live worker / one squash commit results, not two, and the gate runs exactly once (marker file).
//   (3) a call with NO tracked entry present (the shape a post-eviction stale retry sees — the same
//       "nothing tracked" state, whether because it settled+was consumed, or evicted by TTL) safely
//       re-invokes the real method — which falls through to ITS OWN pre-existing idempotency: spawn hits
//       `liveSessionIdForTask` (no double-spawn) when a live worker already holds the task; merge hits
//       ALREADY_MERGED (no double-squash) when the branch's work already landed in main by any path.
//   (4) card 33172f01: a merge re-confirm landing WITHIN the retention window (MERGE_OP_RETAIN_MS, 5s) —
//       genuinely AFTER the first Tracked call settled, not concurrent with it — dedupe-attaches to the
//       cached settled result (SAME opId) instead of re-invoking confirmWorkerMerge a second time at all;
//       distinguished from (3)'s post-eviction/ALREADY_MERGED path, which mints a fresh opId.
//   (5) card 33172f01 CR BLOCKER 1: forceRemoveWorktree:true on a re-confirm landing WITHIN the retention
//       window bypasses the cache and re-runs for real (a NEW opId) instead of silently returning the
//       cached (unforced) result — proven against a REAL nested-git-repo worktree end-to-end through
//       confirmWorkerMergeTracked, not just the untracked confirmWorkerMerge worktree-nested-repo-guard.mjs
//       already covers.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-spawn-tracked.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mst-${Date.now()}-${process.pid}`);
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
const { createWorktree, mergeBranch, removeWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mst@loom -c user.name=mst";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const db = new Db();
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

// One project shared across scenarios; a fresh repo/agents/manager per scenario keeps them isolated.
function makeRepo() {
  const repo = path.join(os.tmpdir(), `loom-mst-repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mst\n");
  // Configure a REPO-LOCAL git identity (not just inline `-c` on our own commits): the daemon's own
  // squash-merge commit runs a PLAIN `git commit` with no `-c` overrides (see the repo's git-commit-identity
  // convention), and our sandboxed HOME above hides any real global config, so without this the daemon's
  // internal commit fails with "unable to auto-detect email address".
  execSync(`git init -q && git config user.email mst@loom && git config user.name mst && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  return repo;
}
function seedProject(projId, repo, gateCommand) {
  db.insertProject({ id: projId, name: "MST", repoPath: repo, vaultPath: repo, config: gateCommand ? { orchestration: { gateCommand } } : {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${projId}-mgr`, projectId: projId, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: `${projId}-dev`, projectId: projId, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
  db.insertSession({ id: `${projId}-mgr1`, projectId: projId, agentId: `${projId}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}

const worktrees = [];
try {
  // ============================ SPAWN (1): fast path — SAME shape as untracked spawnWorker ============================
  {
    const P = "mst-spawn-fast", repo = makeRepo();
    seedProject(P, repo);
    const taskId = randomUUID();
    db.insertTask({ id: taskId, projectId: P, title: "t1", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    const r = await svc.spawnWorkerTracked(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(spawn fast) settles within the sync-wait budget", r.settled === true && r.ok === true);
    check("(spawn fast) value shape matches spawnWorker's Session (role/taskId/live)", r.value.role === "worker" && r.value.taskId === taskId && db.getSession(r.value.id).processState === "live");
    check("(spawn fast) NO lingering pendingSpawn placeholder once settled (evict-on-settle)", !svc.listPendingSpawns(`${P}-mgr1`).some((op) => op.taskId === taskId));
    worktrees.push([repo, r.value.worktreePath]);
  }

  // ============================ SPAWN (2): TWO concurrent Tracked calls → ONE real spawn ============================
  {
    const P = "mst-spawn-race", repo = makeRepo();
    seedProject(P, repo);
    const taskId = randomUUID();
    db.insertTask({ id: taskId, projectId: P, title: "t2", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    // No await between the two calls — call #1's synchronous prefix registers the PendingOpRegistry entry
    // (and spawnWorker's OWN inner per-taskId claim) before call #2's prefix runs, so #2 attaches rather
    // than re-invoking spawnWorker (see the file header + pending-ops.ts's attach() doc for why this is
    // deterministic, not timing-lucky).
    const p1 = svc.spawnWorkerTracked(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    const p2 = svc.spawnWorkerTracked(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    const [r1, r2] = await Promise.all([p1, p2]);

    check("(spawn race) BOTH concurrent calls settle successfully (attach, not a rejection)", r1.settled && r1.ok && r2.settled && r2.ok);
    check("(spawn race) BOTH resolve to the SAME worker (one real spawn, shared result)", r1.value.id === r2.value.id);
    const rowsForTask = db.listAllSessions().filter((s) => s.taskId === taskId);
    check("(spawn race) exactly ONE session row was created (no double-spawn)", rowsForTask.length === 1);
    const liveForTask = db.listLiveWorkers().filter((w) => w.taskId === taskId);
    check("(spawn race) exactly ONE live worker holds the task", liveForTask.length === 1);
    check("(spawn race) NO pendingSpawn placeholder lingers alongside the now-real worker row (no dup/over-count)", !svc.listPendingSpawns(`${P}-mgr1`).some((op) => op.taskId === taskId));
    worktrees.push([repo, r1.value.worktreePath]);
  }

  // ============================ SPAWN (3): post-eviction stale retry → falls through to live-guard ============================
  {
    const P = "mst-spawn-stale", repo = makeRepo();
    seedProject(P, repo);
    const taskId = randomUUID();
    db.insertTask({ id: taskId, projectId: P, title: "t3", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    const first = await svc.spawnWorkerTracked(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(spawn stale) first call settles + creates the live worker", first.settled && first.ok);
    worktrees.push([repo, first.value.worktreePath]);

    // The registry entry was CONSUMED by the first call (delete-on-settle) — this second call is
    // therefore a fresh op that genuinely re-invokes spawnWorker, exactly like a client that missed the
    // first response and retried after the fact would. It must NOT double-spawn.
    const stale = await svc.spawnWorkerTracked(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(spawn stale) a post-eviction retry settles (not left hanging)", stale.settled === true);
    check("(spawn stale) falls through to the live-worker guard, NOT a silent double-spawn", stale.ok === false && /already has a live worker/.test(stale.error?.message ?? ""));
    const rowsForTask = db.listAllSessions().filter((s) => s.taskId === taskId);
    check("(spawn stale) still exactly ONE session row for the task", rowsForTask.length === 1);
  }

  // ============================ MERGE (4): fast path — SAME shape as untracked confirmWorkerMerge ============================
  {
    const P = "mst-merge-fast", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t4");
    fs.writeFileSync(path.join(worktreePath, "feat4.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat4`, { cwd: worktreePath });
    seedProject(P, repo);
    const workerId = `${P}-wkr`;
    db.insertTask({ id: "t4", projectId: P, title: "t4", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId: "t4", worktreePath, branch });

    const r = await svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerId);
    check("(merge fast) settles within the sync-wait budget", r.settled === true && r.ok === true);
    check("(merge fast) value shape matches confirmWorkerMerge's result", r.value.merged === true && r.value.emptyKind === undefined);
    check("(merge fast) file actually landed on main", fs.existsSync(path.join(repo, "feat4.txt")));
    // confirmWorkerMergeTracked RETAINS a settled merge op briefly (card d1aee5f1 follow-up — the Board's
    // merge-gate fill needs a real window to render), so this is no longer `undefined` INSTANTLY — it's a
    // terminal RETAINED view. What still matters (not stuck "running") holds; assert the terminal shape.
    const afterFast = svc.peekPendingMerge(workerId);
    check("(merge fast) pendingMerge is a RETAINED terminal 'merged' view once settled — not stuck 'still running'", afterFast?.state === "done" && afterFast?.outcome === "merged");
  }

  // ============================ MERGE (5): TWO concurrent Tracked calls → gate runs EXACTLY ONCE ============================
  {
    const P = "mst-merge-race", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t5");
    fs.writeFileSync(path.join(worktreePath, "feat5.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat5`, { cwd: worktreePath });
    const marker = path.join(os.tmpdir(), `loom-mst-marker-${Date.now()}.log`);
    process.env.LOOM_MST_MARKER = marker;
    seedProject(P, repo, `node -e "require('fs').appendFileSync(process.env.LOOM_MST_MARKER, 'x')"`);
    const workerId = `${P}-wkr`;
    db.insertTask({ id: "t5", projectId: P, title: "t5", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId: "t5", worktreePath, branch });

    const headBefore = git(repo, "rev-parse HEAD");
    // No await between the two calls — see the (spawn race) comment above for why this deterministically
    // exercises the attach path rather than two independent real merges.
    const p1 = svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerId);
    const p2 = svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerId);
    const [r1, r2] = await Promise.all([p1, p2]);

    check("(merge race) BOTH concurrent calls settle successfully", r1.settled && r1.ok && r2.settled && r2.ok);
    check("(merge race) BOTH resolve to the SAME merge result (one real gate+merge, shared result)", r1.value.merged === true && r2.value.merged === true && r1.value.emptyKind === r2.value.emptyKind);
    check("(merge race) exactly ONE new commit landed (no double-squash)", git(repo, `rev-list --count ${headBefore}..HEAD`) === "1");
    const markerContents = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
    check("(merge race) the gate ran EXACTLY ONCE across both concurrent calls (marker has one 'x')", markerContents === "x");
    delete process.env.LOOM_MST_MARKER;
    try { fs.rmSync(marker, { force: true }); } catch { /* best-effort */ }
  }

  // ==================== MERGE (6): a fresh (post-eviction-shaped) call composes with ALREADY_MERGED ====================
  // Mirrors merge-confirm-idempotent.mjs's (b1): the branch's work already landed in main via mergeBranch()
  // called OUT-OF-BAND (branch ref retained, exactly as an out-of-band confirm — or a stale retry landing
  // after some OTHER path already finished the merge — would leave it). confirmWorkerMergeTracked has no
  // registry entry for this key (never called before ⇒ same "nothing tracked" state a post-eviction retry
  // would see) and must invoke confirmWorkerMerge for real — which composes with ITS OWN pre-existing
  // ALREADY_MERGED idempotency (card 2eddf573) rather than the registry inventing a second one.
  {
    const P = "mst-merge-stale", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t6");
    fs.writeFileSync(path.join(worktreePath, "feat6.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat6`, { cwd: worktreePath });
    // Land the branch into main directly, WITHOUT deleting it or touching the worker/worktree — simulating
    // work that's already merged by the time confirmWorkerMergeTracked is (first) called.
    const landed = await mergeBranch(repo, branch, "MST already-merged");
    check("(merge stale) precondition: branch landed in main with its trailer, ref still present", landed.ok === true && typeof landed.sha === "string");
    seedProject(P, repo);
    const workerId = `${P}-wkr`;
    db.insertTask({ id: "t6", projectId: P, title: "t6", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId: "t6", worktreePath, branch });

    const headBefore = git(repo, "rev-parse HEAD");
    const stale = await svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerId);
    check("(merge stale) settles (not left hanging)", stale.settled === true);
    check("(merge stale) falls through to ALREADY_MERGED, NOT a double squash", stale.ok === true && stale.value.merged === true && stale.value.emptyKind === "ALREADY_MERGED");
    check("(merge stale) NO new commit (nothing re-committed)", git(repo, `rev-list --count ${headBefore}..HEAD`) === "0");
    check("(merge stale) worktree retired idempotently (bookkeeping finished)", !fs.existsSync(worktreePath));
  }

  // ============ MERGE (7): a re-confirm WITHIN the retention window dedupe-attaches — card 33172f01 ============
  // Distinct from (6) above: here the FIRST call genuinely went through confirmWorkerMergeTracked (a real
  // registry entry existed and settled), so a SECOND call landing moments later — well within
  // MERGE_OP_RETAIN_MS (5s) — must hit the NEW retained-result short-circuit in PendingOpRegistry.attach(),
  // not re-invoke confirmWorkerMerge for real. The opId equality check is the discriminator: a genuinely
  // fresh re-invocation (the OLD behavior, or what (6)'s ALREADY_MERGED fallthrough does) always mints a
  // NEW opId; a true dedupe-attach hands back the exact SAME settled result, opId included.
  {
    const P = "mst-merge-retain", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t7");
    fs.writeFileSync(path.join(worktreePath, "feat7.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat7`, { cwd: worktreePath });
    const marker = path.join(os.tmpdir(), `loom-mst-marker7-${Date.now()}.log`);
    process.env.LOOM_MST_MARKER = marker;
    seedProject(P, repo, `node -e "require('fs').appendFileSync(process.env.LOOM_MST_MARKER, 'x')"`);
    const workerId = `${P}-wkr`;
    db.insertTask({ id: "t7", projectId: P, title: "t7", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId: "t7", worktreePath, branch });

    const headBefore = git(repo, "rev-parse HEAD");
    const r1 = await svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerId);
    check("(merge retain) first confirm merges successfully", r1.settled === true && r1.ok === true && r1.value.merged === true);

    // Immediately re-confirm — well within the 5s retention window.
    const r2 = await svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerId);
    check("(merge retain) re-confirm within the window settles ok:true, matching the original outcome", r2.settled === true && r2.ok === true && r2.value.merged === true);
    check("(merge retain) re-confirm returns the EXACT SAME opId as the original settled op (a real dedupe-attach, not a fresh ALREADY_MERGED re-derive)", r2.value.opId === r1.value.opId);
    check("(merge retain) exactly ONE new commit landed total (no second squash attempt)", git(repo, `rev-list --count ${headBefore}..HEAD`) === "1");
    const markerContents = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
    check("(merge retain) the gate ran EXACTLY ONCE — the re-confirm did not re-invoke it (nor fall through to any other idempotency path)", markerContents === "x");
    delete process.env.LOOM_MST_MARKER;
    try { fs.rmSync(marker, { force: true }); } catch { /* best-effort */ }
  }

  // === MERGE (8): forceRemoveWorktree:true within the window BYPASSES the cache — CR BLOCKER 1 ===
  // Reproduces the CR's concrete failure end-to-end through confirmWorkerMergeTracked (worktree-nested-
  // repo-guard.mjs proves the underlying confirmWorkerMerge/finishAlreadyMerged force behavior directly,
  // but calls the UNTRACKED method — it never exercises the registry short-circuit this proves): a green
  // merge whose worktree holds a nested git repo returns {merged:true, warning:"...forceRemoveWorktree..."}
  // and gets retained. A plain re-confirm moments later just dedupe-hits that SAME cached warning (worktree
  // still retained) — but a re-confirm WITH forceRemoveWorktree:true, still within the SAME window, must
  // bypass the cache and actually re-run for real, this time removing the worktree — not silently return
  // the identical stale warning while the flag is swallowed.
  {
    const P = "mst-merge-force-retain", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t8");
    fs.writeFileSync(path.join(worktreePath, "feat8.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat8`, { cwd: worktreePath });
    // A real nested clone inside the worktree — mirrors worktree-nested-repo-guard.mjs's addNestedRepo.
    const nestedDir = path.join(worktreePath, "_external", "cloned-repo");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "unpushed.txt"), "unpushed work\n");
    execSync(`git init -q && git config user.email ext@loom && git config user.name ext && git add . && git ${GIT_ID} commit -q -m "unpushed external work"`, { cwd: nestedDir });
    seedProject(P, repo);
    const workerId = `${P}-wkr`;
    db.insertTask({ id: "t8", projectId: P, title: "t8", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId: "t8", worktreePath, branch });

    const r1 = await svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerId);
    check("(merge force-retain) first confirm merges but RETAINS the worktree (nested-repo guard)", r1.settled === true && r1.ok === true && r1.value.merged === true);
    check("(merge force-retain) precondition: worktree still present, warning names forceRemoveWorktree", fs.existsSync(worktreePath) && /forceRemoveWorktree/.test(r1.value.warning ?? ""));

    // WITHOUT the flag, still well within the window, a plain re-confirm just dedupe-hits the SAME cache.
    const rPlain = await svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerId);
    check("(merge force-retain) an UNFLAGGED re-confirm dedupe-hits (same opId, worktree still retained)", rPlain.value.opId === r1.value.opId && fs.existsSync(worktreePath));

    // WITH the flag, still within the SAME window — the fix must bypass the cache and re-run for real.
    const rForced = await svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerId, true);
    check("(merge force-retain) a FORCED re-confirm within the window re-runs for real (a NEW opId, not the cached one)", rForced.settled === true && rForced.ok === true && rForced.value.opId !== r1.value.opId);
    check("(merge force-retain) the worktree is NOW actually removed — the force flag was honored, not silently swallowed by the cache", !fs.existsSync(worktreePath));
    check("(merge force-retain) NO nested-repo warning on the forced result (override skipped the guard)", !/nested/i.test(rForced.value.warning ?? ""));
  }
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — spawnWorkerTracked/confirmWorkerMergeTracked: fast path matches today's exact shape, two concurrent calls on the same key attach to ONE real invocation (no double-spawn, gate runs exactly once), a post-eviction stale retry safely falls through to the underlying method's OWN idempotency (live-worker guard / ALREADY_MERGED) instead of double-creating, card 33172f01: a merge re-confirm landing genuinely AFTER the first settled but still within the retention window dedupe-attaches to the cached result (same opId, gate runs exactly once) instead of starting a second real merge attempt, and CR BLOCKER 1: forceRemoveWorktree:true on such a re-confirm bypasses the cache and re-runs for real against a nested-repo worktree instead of silently swallowing the escalation."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
