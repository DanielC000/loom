import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 40b63f1c: boot-reconcile Pass B keyed its liveness protection on the ITERATED SESSION ROW
// (`protectedSessionIds.has(s.id)`), not the worktree it names. A `worker_recycle` chain aliases ONE
// worktreePath across TWO session rows — `recycleWorker` (sessions/service.ts:9767-9768) never clears
// the predecessor's own worktreePath/branch/taskId; the fresh successor just carries the SAME values
// forward. The dangling predecessor (exited, NOT in protectedSessionIds) then passes every Pass B filter
// and reaps the SAME worktree the successor needs — the successor's own protection is never consulted,
// because the loop only ever asked "is THIS row protected?", never "does anyone still hold this
// worktree?". Pass C then deletes the branch too: its `listCheckedOutBranches` gate reads git state Pass
// B just destroyed 19s earlier in the real incident.
// REAL git on temp repos, NO claude + NO live daemon — drives reconcileOrchestrationOnBoot() directly
// against an isolated LOOM_HOME. Proves BOTH legs independently (DoD item 7's explicit requirement —
// fixing Pass B alone would leave branch deletion as the surviving half of the bug):
//   (A) a recycled successor PROTECTED via protectedSessionIds (about to be resumed — it is ALSO still
//       `exited` in the DB at the instant reconcile runs, since resumeFleetOnBoot hasn't spawned its pty
//       yet; this is the exact incident shape, not a simplification). The DANGLING predecessor row
//       sharing its worktreePath/branch must NOT cause Pass B to remove the worktree (leg 1) NOR Pass C
//       to delete the branch (leg 2).
//   (B) CONTROL: a recycle chain with NEITHER row protected (a genuinely abandoned chain — the daemon
//       crashed and nobody ever asked to resume it). The SAME 0-commit, clean-tree worktree shape IS
//       still GC'd and its branch IS still reclaimed — proves the fix protects only the genuinely-
//       live/protected case, not every aliased worktree unconditionally.
// RED-PROOFED against pre-fix code (git show <predecessor commit>:packages/daemon/src/sessions/service.ts,
// rebuilt, this test re-run): both (A leg 1) and (A leg 2) failed — the worktree was destroyed and the
// branch was deleted — while (B) already passed, confirming the discriminator is the fix, not the fixture.
// Run: 1) build daemon, 2) node test/worktree-recycle-alias-protection.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wrap-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wrap@loom -c user.name=wrap";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const branchExists = (cwd, branch) => git(cwd, `branch --list ${branch}`) !== "";
// `git worktree list` prints forward slashes; createWorktree returns a native (backslash on Windows)
// path — normalize before substring-matching so this is a path check, not an accidental slash mismatch.
const isRegisteredWorktree = (repo, worktreePath) => git(repo, "worktree list").replace(/\\/g, "/").includes(worktreePath.replace(/\\/g, "/"));
const now = new Date().toISOString();

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wrap\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  git(repo, "branch -M main");
  // A resolvable LOCAL origin/HEAD symbolic ref — no real remote needed (same recipe as
  // worktree-branch-gc.mjs's R1) — required for Pass C's branch-ref sweep to even consider this repo;
  // without it the repo is fail-closed skipped and leg 2 would prove nothing either way.
  git(repo, "symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main");
}

// One recycle-chain fixture: a real, zero-commit, clean worktree shared by a predecessor + successor row
// — exactly `worker_recycle`'s own on-disk shape (createWorktree is the same primitive it reuses).
async function setupRecycleChain(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, predId = `wrap-${tag}-pred-${sfx}`, succId = `wrap-${tag}-succ-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  // The predecessor: `worker_recycle` hard-stops it but never clears its worktreePath/branch/taskId (see
  // recycleWorker) — the fresh successor row just carries the SAME values forward. It shows up here
  // exactly as it would at a real boot: exited, unprotected, worktree clean and 0 commits ahead.
  db.insertSession({ id: predId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  // The successor: SAME worktreePath/branch/taskId (the recycle contract). At the exact instant
  // boot-reconcile runs, it is ALSO still `exited` in the DB — resumeFleetOnBoot hasn't spawned its pty
  // yet — so ONLY protectedSessionIds (built from restart-intent / crash-orphaned-workers, BEFORE
  // reconcile runs) distinguishes it from an ordinary dead row. This is the exact incident shape, not a
  // simplification of it.
  db.insertSession({ id: succId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, recycledFrom: predId });
  return { projId, taskId, mgrId, predId, succId, worktreePath, branch, repo };
}

const R_PROTECTED = path.join(os.tmpdir(), `loom-wrap-a-${sfx}`);
const R_CONTROL = path.join(os.tmpdir(), `loom-wrap-b-${sfx}`);
let A, B;

try {
  A = await setupRecycleChain("a", R_PROTECTED);
  B = await setupRecycleChain("b", R_CONTROL);

  // --- sanity: both fixtures start identical (real worktree registered, branch exists, 0 commits, clean) ---
  check("(pre-A) worktree registered before reconcile", fs.existsSync(A.worktreePath) && isRegisteredWorktree(A.repo, A.worktreePath));
  check("(pre-A) branch exists before reconcile", branchExists(A.repo, A.branch));
  check("(pre-B) worktree registered before reconcile", fs.existsSync(B.worktreePath) && isRegisteredWorktree(B.repo, B.worktreePath));
  check("(pre-B) branch exists before reconcile", branchExists(B.repo, B.branch));

  // --- THE RECONCILE --- A's successor is protected (about to be resumed); B's chain is not protected at
  // all (abandoned). Session insertion order above is predecessor-then-successor for both — the fix must
  // hold regardless of which aliased row Pass B happens to visit first, which is exactly why the
  // protection set is built ONCE, up front, from ALL rows, rather than decided per-row during iteration.
  const r = await sessions.reconcileOrchestrationOnBoot(new Set([A.succId]));

  // (A leg 1) Pass B must NOT destroy the worktree the live/protected successor needs.
  check("(A leg 1) worktree directory SURVIVES intact", fs.existsSync(A.worktreePath));
  check("(A leg 1) worktree stays REGISTERED in git (not deregistered)", isRegisteredWorktree(A.repo, A.worktreePath));
  // (A leg 2) Pass C's own listCheckedOutBranches gate reads whatever Pass B left behind — this only
  // survives if Pass B genuinely left the worktree checked out, not merely if Pass C were independently
  // patched. This is the leg that proves fixing Pass B alone is NOT enough on its own to leave branch
  // deletion unfixed — it must actually compose correctly with Pass C's existing gate.
  check("(A leg 2) branch SURVIVES (Pass C's checked-out-elsewhere gate reads Pass B's now-intact worktree)", branchExists(A.repo, A.branch));

  // (B, control) the genuinely-abandoned chain — same shape, no protection anywhere — is STILL cleaned
  // up: proves the fix protects only the genuinely-live/protected case, not every aliased worktree.
  check("(B control) worktree IS GC'd (no protection applies)", !fs.existsSync(B.worktreePath));
  check("(B control) branch IS reclaimed (no protection applies)", !branchExists(B.repo, B.branch));

  check("(counts) exactly 1 worktree pruned (B only — A's aliased pair decided ONCE, not twice)", r.worktreesPruned === 1);
  check("(counts) exactly 1 branch reclaimed (B only)", r.branchesReclaimed === 1);
  check("(counts) A's protected worktree was NOT counted as a suspected-still-live left-on-disk failure either", r.worktreesLeftOnDiskSuspectedLive === 0);

  // --- idempotent second run: A's protected worktree still needs to survive a SECOND pass with the SAME
  // protectedSessionIds (mirrors a boot that runs reconcile more than once, or a retry) ---
  const r2 = await sessions.reconcileOrchestrationOnBoot(new Set([A.succId]));
  check("(idem) A's worktree still survives a second reconcile pass", fs.existsSync(A.worktreePath));
  check("(idem) A's branch still survives a second reconcile pass", branchExists(A.repo, A.branch));
  check("(idem) second pass prunes/reclaims nothing new (B already gone)", r2.worktreesPruned === 0 && r2.branchesReclaimed === 0);
} finally {
  db.close();
  for (const p of [A, B]) {
    if (!p) continue;
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot-reconcile Pass B now keys liveness protection on the WORKTREE (not the iterated session row): a worker_recycle chain's dangling predecessor can no longer reap the live/protected successor's worktree, and Pass C's existing checked-out-elsewhere gate then correctly reads that intact state and keeps the branch too — while a genuinely-abandoned chain with no protection anywhere is still cleaned up normally."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
