import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// RE-POLL TERMINAL-RESULT-READ test (Platform Lead dispatch 2026-07-08, distinct from c0aeb5b2's
// post-merge-union gate hole). REAL git on temp repos, NO claude and NO live daemon — drives
// SessionService.confirmWorkerMerge() directly against an isolated LOOM_HOME (mirrors
// merge-confirm-stale-retry-idempotent.mjs's in-process style).
//
// THE BUG: confirmWorkerMerge's early-idempotency short-circuit (finding 864e79fe) only fired when the
// worktree DIRECTORY was gone from disk. But removeWorktree's directory removal is itself best-effort — a
// Windows handle-release race (a just-hard-stopped process's cwd handle lingers a beat past exit) can
// outlast removeWorktree's own bounded retries, so finalizeMerge can complete the ENTIRE merge (branch
// deleted, task moved to its terminal/done lane, main advanced) while the worktree DIRECTORY itself lingers
// on disk, leaked for a later GC pass. A stale confirm retry (e.g. a client-timeout on the ORIGINAL call —
// see confirmWorkerMergeTracked's pending-op degrade — followed by a re-call/poll that lands in exactly
// this window) used to see `fs.existsSync(worktreePath) === true`, skip the ENTIRE idempotency block, and
// re-run the build/DoD gate again against that leaked/de-registered worktree — misreporting "build gate
// failed" for a worker whose merge had ALREADY succeeded (main advanced, task done).
//
// THE FIX: the early-idempotency check now ALSO short-circuits when the task is already in its terminal
// (done) lane — an equally authoritative "this daemon's own finalizeMerge already ran for this worker"
// signal, independent of whether the worktree directory happens to still be on disk — provided
// findLandedSquashCommit independently confirms the branch's work actually landed (so this never
// short-circuits a genuinely-failing gate for a task that's Done for an unrelated reason — see
// merge-reject-notify-suppress.mjs scenario C — nor a legitimate RE-TASK: a branch re-cut onto a prior
// squash commit with genuine NEW work, scenario (II) below).
//
// PORTABILITY (Code Review finding on this test, 2026-07-08): the ORIGINAL version of this test simulated
// the leak by holding a real child process's cwd inside the worktree — that only blocks removal on
// Windows (a process's cwd does NOT block directory removal on Linux/POSIX), so the test would go RED on
// Linux CI (the worktree WOULD be fully removed by the first confirm, failing the leak precondition) while
// passing on a developer's Windows machine — and would give ZERO coverage of the taskAlreadyTerminal path
// on Linux (the second confirm there would just hit the pre-existing !fs.existsSync branch). Fixed by
// driving the leak through SessionService's OWN injectable `removeDir` test seam instead (the same seam
// worktree-wedge-retry.mjs uses) — deterministic on every platform. `git worktree remove --force` itself
// genuinely deletes a healthy, unlocked worktree directory (proven empirically — there is no seam to
// intercept THAT step), so the injected removeDir doesn't just report failure: it RECREATES the directory
// each time it's invoked (removeWorktree's fs-backstop loop runs unconditionally, regardless of whether
// git's own step already succeeded), faithfully reproducing "this GC pass did not actually remove it" byte-
// for-byte, without depending on any OS-specific lock.
//
// Proves:
//   (I) the FIRST confirm merges successfully (task done, branch deleted, main advanced); the worktree
//       DIRECTORY is confirmed to still be on disk afterward (the injected removeDir seam left it there —
//       the deterministic stand-in for a leaked/not-yet-swept GC pass). A SECOND confirm (the re-poll/
//       stale-retry shape) reports merged:true/ALREADY_MERGED — NOT a false "build gate failed" — even
//       though the worktree directory is STILL present, and the gate ran EXACTLY ONCE across both confirms
//       (a marker file) with NO additional commit landing on main from the second confirm.
//   (II) THE HIGHEST-RISK REGRESSION PATH (Code Review flagged): a task already in its terminal (done)
//       lane, but this time the worker's branch was GENUINELY RE-CUT (re-tasked) onto the prior squash
//       commit and carries real NEW work — confirmWorkerMerge must NOT short-circuit to merged:true; it
//       must fall through to the gate and land a SECOND, distinct squash commit (proving
//       findLandedSquashCommit's re-task guard still overrides taskAlreadyTerminal correctly).
// Run: 1) build daemon (pnpm build), 2) node test/merge-confirm-leaked-worktree-idempotent.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcl-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcl@loom -c user.name=mcl";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

// ── (I) LEAKED WORKTREE: a re-poll after a successful merge reads the TRUE terminal result ─────────────
{
  const sfx = `I-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projId = `mcl-proj-${sfx}`, agentId = `mcl-agent-${sfx}`, taskId = `mcl-task-${sfx}`;
  const mgrId = `mcl-mgr-${sfx}`, workerId = `mcl-wkr-${sfx}`;
  const repo = path.join(os.tmpdir(), `loom-mcl-repo-${sfx}`);
  const file = "feat.txt";
  const marker = path.join(os.tmpdir(), `loom-mcl-marker-${sfx}.log`);
  const markerForJs = marker.replace(/\\/g, "/");
  const GATE = `node -e "require('fs').appendFileSync('${markerForJs}', 'x')"`;

  const db = new Db();
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, getPid() { return undefined; } };
  // The injected removeDir seam (see the file-level doc): git's OWN `worktree remove --force` step
  // already deletes a healthy, unlocked directory for real — this mock re-creates it and reports failure
  // EVERY time it's called, deterministically reproducing "left on disk, not yet swept" on any platform.
  let removeDirCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
    gitOpMs: 5_000,
    removeDir: async (target) => {
      removeDirCalls++;
      if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
      return { removed: false, killed: false };
    },
  });

  try {
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# mcl\n");
    execSync(`git init -q && git config user.email mcl@loom && git config user.name mcl && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    fs.writeFileSync(path.join(worktreePath, file), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${file}"`, { cwd: worktreePath });

    db.insertProject({ id: projId, name: "MCL", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: GATE } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "MCL-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    const headBefore = git(repo, "rev-parse HEAD");

    const confirm1 = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(I) first confirm merges successfully", confirm1.merged === true);
    check("(I) task moved to done", db.getTask(taskId).columnKey === "done");
    check("(I) branch deleted after the first confirm", git(repo, `branch --list ${branch}`) === "");
    check("(I) exactly ONE new commit landed on main", git(repo, `rev-list --count ${headBefore}..HEAD`) === "1");
    check("(I) PRECONDITION: the worktree directory is STILL ON DISK (the injected removeDir seam left it there — deterministic stand-in for a leaked, not-yet-swept GC pass)", fs.existsSync(worktreePath));
    check("(I) PRECONDITION: the removeDir seam was actually invoked (proves the leak path was exercised, not skipped)", removeDirCalls > 0);

    const headAfterFirst = git(repo, "rev-parse HEAD");
    const callsBeforeSecond = removeDirCalls;

    const confirm2 = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(I) SECOND confirm reports merged:true (NOT a false 'build gate failed')", confirm2.merged === true);
    check("(I) SECOND confirm is distinguishable as ALREADY_MERGED", confirm2.emptyKind === "ALREADY_MERGED");
    check("(I) SECOND confirm's reason is undefined (not a gate-failure reason)", confirm2.reason === undefined);
    check("(I) the gate ran EXACTLY ONCE across both confirms (marker file has exactly one 'x')", fs.readFileSync(marker, "utf8") === "x");
    check("(I) NO additional commit landed on main from the second confirm", git(repo, "rev-parse HEAD") === headAfterFirst);
    // The second confirm SHORT-CIRCUITS via finishAlreadyMerged BEFORE the `if (gate)` block — it never
    // reaches the gate again — but finishAlreadyMerged's own finalizeMerge still retries the GC, so the
    // removeDir seam legitimately fires again here; the load-bearing proof is the marker (gate not re-run).
    check("(I) removeDir was called again by the second confirm's own (retried) cleanup, not skipped", removeDirCalls > callsBeforeSecond);
  } finally {
    db.close();
    try { fs.rmSync(marker, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── (II) NEW-WORK RE-TASK GUARD: task already Done, but the branch was genuinely RE-CUT with new work ──
{
  const sfx = `II-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projId = `mclii-proj-${sfx}`, agentId = `mclii-agent-${sfx}`, taskId = `mclii-task-${sfx}`;
  const mgrId = `mclii-mgr-${sfx}`, worker1Id = `mclii-wkr1-${sfx}`, worker2Id = `mclii-wkr2-${sfx}`;
  const repo = path.join(os.tmpdir(), `loom-mclii-repo-${sfx}`);
  const PASS_GATE = 'node -e "process.exit(0)"';

  const db = new Db();
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
  });

  try {
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# mclii\n");
    execSync(`git init -q && git config user.email mclii@loom && git config user.name mclii && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

    db.insertProject({ id: projId, name: "MCLII", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "MCLII-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    // FIRST worker: a normal, complete merge (real removal, no seam needed — nothing holds this dir).
    const first = await createWorktree(repo, projId, taskId);
    fs.writeFileSync(path.join(first.worktreePath, "feat-1.txt"), "first\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat-1`, { cwd: first.worktreePath });
    db.insertSession({ id: worker1Id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });

    const headAfterFirstMerge0 = git(repo, "rev-parse HEAD");
    const confirm1 = await sessions.confirmWorkerMerge(mgrId, worker1Id);
    check("(II) precondition: the FIRST worker's merge succeeds", confirm1.merged === true);
    check("(II) precondition: task moved to done by the first merge", db.getTask(taskId).columnKey === "done");
    check("(II) precondition: exactly one commit landed from the first merge", git(repo, `rev-list --count ${headAfterFirstMerge0}..HEAD`) === "1");

    // RE-TASK: the SAME taskId re-cuts the SAME branch name (deterministic, taskId-derived) — but since the
    // old branch was deleted, createWorktree cuts a BRAND NEW branch off CURRENT main (which now has the
    // first squash commit as an ancestor) — carrying genuinely NEW work on top. The task's card is left in
    // its Done column throughout (the exact edge case under test: taskAlreadyTerminal is TRUE, but this
    // branch was never actually squashed — the re-task guard inside findLandedSquashCommit must say so).
    const second = await createWorktree(repo, projId, taskId);
    check("(II) precondition: the re-cut branch reuses the SAME deterministic branch name", second.branch === first.branch);
    fs.writeFileSync(path.join(second.worktreePath, "feat-2.txt"), "second (new work)\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat-2`, { cwd: second.worktreePath });
    db.insertSession({ id: worker2Id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });

    const headBeforeSecondMerge = git(repo, "rev-parse HEAD");
    const confirm2 = await sessions.confirmWorkerMerge(mgrId, worker2Id);
    check("(II) the RE-TASKED confirm does NOT short-circuit to a stale ALREADY_MERGED (emptyKind absent)", confirm2.emptyKind === undefined);
    check("(II) the RE-TASKED confirm reports a genuine merge (merged:true)", confirm2.merged === true);
    check("(II) a SECOND, DISTINCT commit landed on main (the new work was actually merged, not skipped)", git(repo, `rev-list --count ${headBeforeSecondMerge}..HEAD`) === "1");
    check("(II) the new file actually landed on the canonical repo", fs.existsSync(path.join(repo, "feat-2.txt")));
    check("(II) the first worker's file is still present too (no regression)", fs.existsSync(path.join(repo, "feat-1.txt")));
  } finally {
    db.close();
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a re-poll/stale-retry confirm reads the TRUE terminal result (merged:true/ALREADY_MERGED) even when the worktree directory is still on disk (leaked by a best-effort removal, reproduced deterministically via the removeDir test seam on any platform), instead of re-running the gate and misreporting a false 'build gate failed' for a merge that already succeeded — and a genuine re-task (task Done, branch re-cut with real new work) is never short-circuited by that same fix."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
