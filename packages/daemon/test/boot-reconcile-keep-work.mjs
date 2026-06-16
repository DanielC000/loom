import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// P0 DATA-LOSS guard test (2026-06-05), updated for SQUASH merges. boot-reconcile must NEVER auto-delete a
// worktree that still holds the worker's work. recoverStaleSessions marks EVERY prior-run session `exited`
// at boot, so a LIVE worker (e.g. an unrelated manager's, dropped by a daemon_restart) is misdetected and
// was deleted mid-task. Under squash, Pass A keys on the deterministic Loom-Worker-Branch TRAILER (positive
// proof the squash landed) instead of `git branch --merged`, which eliminates the old 0-commit-branch
// misdetection outright: a genuinely-live worker has NO trailer in main → Pass A SKIPS it → the
// worktreeHasWork() guard in Pass B is what keeps it. The two data-loss vectors are now:
//   - Pass A: a landed squash is detected by the trailer ONLY; no trailer ⇒ never finalized (KEEP).
//   - Pass B: GC's an exited+unprotected worktree ONLY when worktreeHasWork()=false (clean AND 0-ahead).
// REAL git on temp repos, NO claude + NO live daemon — drives reconcileOrchestrationOnBoot() directly
// against an isolated LOOM_HOME. Proves:
//   (a) a 0-ahead worktree with an UNCOMMITTED change, session exited+UNPROTECTED → NO trailer → Pass A
//       skips it → Pass B KEEPS it (contents intact, task untouched, branch retained).
//   (b) a worktree with an UNMERGED COMMIT (branch ahead) → no trailer → Pass A skips → Pass B KEEPS.
//   (c) a genuinely SQUASH-MERGED worktree of an exited session → trailer present → STILL finalized/GC'd.
//   (d) a merged worktree that ALSO has an untracked `.claude/skills/foo` file → STILL GC'd (proves the
//       ignore-untracked-`.claude/` discriminator: injected noise must not block legitimate cleanup).
//   (e) FAIL-SAFE: a bounded git error/timeout in the check → treated as has-work → KEEP (both the
//       throwing and the never-resolving cases), proven directly on worktreeHasWork() + its parser.
// Run: 1) build daemon, 2) node test/boot-reconcile-keep-work.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bkw-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, worktreeHasWork, worktreeStatusHasWork } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// Slack for the bounded-op LOWER-bound timing assertion below. Durations are measured with the
// MONOTONIC performance.now() (not Date.now()), so a wall-clock NTP/virtualization backward step can't
// make elapsed read under the timeout; this slack additionally absorbs libuv's sub-ms early timer fire
// (a setTimeout(250) can fire a hair before a fresh clock sample). It does NOT weaken the proof — the
// floor still decisively distinguishes "waited ~the timeout" from an instant (~0ms) early return. (A
// Date.now()-measured floor here flaked the v0.3.0 release CI: it read 122ms/249ms on the loaded runner.)
const TIMER_SLACK_MS = 50;
const GIT_ID = "-c user.email=bkw@loom -c user.name=bkw";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());
const mergeDoneCount = (mgrId) => db.listEvents(mgrId).filter((e) => e.kind === "merge_done").length;

function seed(p) {
  db.insertProject({ id: p.projId, name: "BKW", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "BKW-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // The worker is `exited` (recoverStaleSessions's effect) and is NOT in protectedSessionIds (we call
  // reconcile with no protected set) — i.e. exactly an unrelated manager's live worker post-restart.
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo, readme) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), readme);
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

// (a) live worker, work UNCOMMITTED, branch still at main (0 ahead) → Pass A misdetects as merged.
async function setupUncommitted(p) {
  initRepo(p.repo, "# bkw uncommitted\n");
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.mkdirSync(path.join(worktreePath, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "src", p.file), "completed work, NOT yet committed\n"); // untracked product
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

// (b) worker COMMITTED work to its branch but never merged (branch ahead) → Pass A skips → Pass B.
async function setupUnmergedCommit(p) {
  initRepo(p.repo, "# bkw unmerged-commit\n");
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "committed to branch, not merged\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

// (c)/(d) a genuinely-merged worktree (branch landed into main, worktree clean). (d) additionally drops
//   an UNTRACKED `.claude/skills/foo` file to prove the injected-noise discriminator still GC's it.
async function setupMerged(p, withClaudeNoise) {
  initRepo(p.repo, "# bkw merged\n");
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "real merged work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });
  // SQUASH-land it (what confirmWorkerMerge does): one commit on main carrying the Loom-Worker-Branch
  // trailer; the branch is NOT reachable from HEAD (no merge commit), so Pass A must detect via the trailer.
  execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "BKW-TASK" -m "Loom-Worker-Branch: ${branch}"`, { cwd: p.repo });
  if (withClaudeNoise) {
    const skillDir = path.join(worktreePath, ".claude", "skills", "foo");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# injected skill (untracked, daemon-managed)\n");
  }
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (tag, file) => ({ projId: `bkw-${tag}-proj-${sfx}`, agentId: `bkw-${tag}-top-${sfx}`, taskId: `bkw-${tag}-task-${sfx}`, mgrId: `bkw-${tag}-mgr-${sfx}`, workerId: `bkw-${tag}-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bkw-${tag}-${sfx}`), file });
const A = mk("a", "work.txt");   // uncommitted
const B = mk("b", "feat.txt");   // unmerged commit
const C = mk("c", "done.txt");   // clean merged
const D = mk("d", "done.txt");   // merged + .claude noise

try {
  await setupUncommitted(A);
  await setupUnmergedCommit(B);
  await setupMerged(C, false);
  await setupMerged(D, true);

  // --- (e) FAIL-SAFE on the helper itself (before the reconcile so a thrown helper can't skew counts) ---
  // A git whose `raw` THROWS → has-work (keep). A git whose `raw` never settles → bounded + has-work.
  const throwGit = { raw: () => { throw new Error("simulated git failure"); } };
  check("(e) worktreeHasWork fails SAFE on a throwing git → has-work (keep)",
    (await worktreeHasWork(A.repo, A.worktreePath, A.branch, "HEAD", { gitFactory: () => throwGit })) === true);
  const neverGit = { raw: () => new Promise(() => {}) }; // hung child: never settles
  const t0 = performance.now(); // MONOTONIC: immune to wall-clock (Date.now) backward steps under load/virtualization
  const hung = await worktreeHasWork(A.repo, A.worktreePath, A.branch, "HEAD", { gitFactory: () => neverGit, timeoutMs: 250 });
  const elapsed = performance.now() - t0;
  check("(e) worktreeHasWork fails SAFE on a never-resolving git → has-work (keep)", hung === true);
  // Lower bound (with TIMER_SLACK_MS slack) only: proves the call WAITED for the 250ms timeout rather
  // than returning early or hanging forever. No upper bound — a loaded CI runner can take arbitrarily
  // long to schedule the resolution after the timer fires, and an upper bound there is a pure timing flake.
  check(`(e) the check is BOUNDED — waited for the timeout, returned in ${Math.round(elapsed)}ms (floor ${250 - TIMER_SLACK_MS}ms)`, elapsed >= 250 - TIMER_SLACK_MS);

  // --- the .claude discriminator, unit level (independent of any worktree) ---
  check("(e) parser: untracked .claude path alone → NOT work", worktreeStatusHasWork("?? .claude/skills/foo/SKILL.md\n") === false);
  check("(e) parser: untracked product (src) → work", worktreeStatusHasWork("?? src/new.txt\n") === true);
  check("(e) parser: tracked modification → work", worktreeStatusHasWork(" M packages/daemon/src/x.ts\n") === true);
  check("(e) parser: mixed .claude noise + real product → work", worktreeStatusHasWork("?? .claude/skills/foo\n?? src/new.txt\n") === true);
  check("(e) parser: empty status → NOT work", worktreeStatusHasWork("") === false);

  // Sanity on the routing pre-conditions (under SQUASH, Pass A keys on the Loom-Worker-Branch trailer,
  // NOT `git branch --merged`). (a)/(b) never landed → NO trailer in main → Pass A skips → Pass B decides
  // (and KEEPS, since both hold work). (c)/(d) squash-landed → trailer present → Pass A finalizes.
  check("(a-pre) uncommitted (live) worker has NO landed-squash trailer in main → Pass A skips it (kept by Pass B)",
    !git(A.repo, "log -1 --format=%b").includes("Loom-Worker-Branch"));
  check("(b-pre) unmerged-commit worker has NO trailer in main → Pass A skips → Pass B keeps it",
    !git(B.repo, "log -1 --format=%b").includes("Loom-Worker-Branch"));
  check("(c-pre) merged HEAD carries the Loom-Worker-Branch trailer (squash landed)", git(C.repo, "log -1 --format=%b").includes(`Loom-Worker-Branch: ${C.branch}`));
  check("(d-pre) merged-with-noise HEAD carries the trailer (squash landed)", git(D.repo, "log -1 --format=%b").includes(`Loom-Worker-Branch: ${D.branch}`));

  // --- THE RECONCILE (no protected set → every worker is exited+unprotected) ---
  const r = await sessions.reconcileOrchestrationOnBoot();

  // (a) live worker — no trailer in main → Pass A skips → Pass B keeps it; uncommitted work + task + branch untouched.
  check("(a) uncommitted worktree KEPT (no trailer → Pass A skips; Pass B keeps a live worker)", fs.existsSync(A.worktreePath));
  check("(a) uncommitted work CONTENTS intact (src/work.txt survives)", fs.existsSync(path.join(A.worktreePath, "src", A.file)));
  check("(a) uncommitted task NOT wrongly marked done", db.getTask(A.taskId).columnKey === "in_progress");
  check("(a) uncommitted branch NOT deleted", git(A.repo, `branch --list ${A.branch}`).includes(A.branch));
  check("(a) uncommitted recorded NO merge_done", mergeDoneCount(A.mgrId) === 0);

  // (b) Pass B vector — the unmerged committed work SURVIVES.
  check("(b) unmerged-commit worktree KEPT", fs.existsSync(B.worktreePath));
  check("(b) unmerged-commit CONTENTS intact", fs.existsSync(path.join(B.worktreePath, B.file)));
  check("(b) unmerged-commit task untouched (in_progress)", db.getTask(B.taskId).columnKey === "in_progress");
  check("(b) unmerged-commit branch retained", git(B.repo, `branch --list ${B.branch}`).includes(B.branch));

  // (c) no-regression — a clean, genuinely-merged worktree is STILL finalized/GC'd.
  check("(c) clean merged worktree STILL removed (legitimate cleanup intact)", !fs.existsSync(C.worktreePath));
  check("(c) clean merged task moved to done", db.getTask(C.taskId).columnKey === "done");
  check("(c) clean merged branch deleted", git(C.repo, `branch --list ${C.branch}`) === "");
  check("(c) clean merged merge_done appended", mergeDoneCount(C.mgrId) === 1);

  // (d) discriminator — a merged worktree carrying ONLY untracked `.claude` noise is STILL GC'd.
  check("(d) merged worktree with untracked .claude/skills/foo STILL removed (noise ignored)", !fs.existsSync(D.worktreePath));
  check("(d) merged-with-noise task moved to done", db.getTask(D.taskId).columnKey === "done");
  check("(d) merged-with-noise branch deleted", git(D.repo, `branch --list ${D.branch}`) === "");

  // Aggregate counts: 2 kept (a + b), 2 finished merges (c + d), 0 pruned (Pass B kept its only candidate).
  check("(agg) reconcile KEPT exactly 2 worktrees holding work", r.worktreesKept === 2);
  check("(agg) reconcile FINISHED exactly 2 merges (c + d)", r.mergesFinished === 2);
  check("(agg) reconcile pruned 0 via Pass B (its only candidate held work → kept)", r.worktreesPruned === 0);

  // --- idempotent second run: keeps the same two, no new merges, no duplicate events ---
  const r2 = await sessions.reconcileOrchestrationOnBoot();
  check("(idem) second run keeps the same 2, finishes 0 merges", r2.worktreesKept === 2 && r2.mergesFinished === 0);
  check("(idem) (a) worktree still present", fs.existsSync(A.worktreePath));
  check("(idem) (b) worktree still present", fs.existsSync(B.worktreePath));
  check("(idem) (c) merge_done NOT duplicated", mergeDoneCount(C.mgrId) === 1);
} finally {
  db.close();
  for (const p of [A, B, C, D]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — under squash, boot-reconcile never auto-deletes a worktree holding work: a live worker has NO Loom-Worker-Branch trailer so Pass A skips it and Pass B keeps it (both the uncommitted-0-ahead and unmerged-commit shapes), the check fails safe (error/timeout → keep), and a genuinely SQUASH-merged worktree (trailer present) is STILL finalized/GC'd even when it carries untracked daemon-injected .claude noise."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
