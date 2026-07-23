import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 09f268a5: 275 fully-merged `loom/*` branch refs and 20 finished worktrees were never reclaimed.
// REAL git on temp repos, NO claude and NO live daemon — drives SessionService.reconcileOrchestrationOnBoot()
// directly against an isolated LOOM_HOME. Proves the new Pass C (branch-ref reclaim):
//   (A) a merged `loom/*` branch with NO worktree at all (the existing 275-branch backlog shape,
//       and the ongoing shape once Pass B GCs a worktree without ever revisiting its branch) is swept.
//   (B) an UNMERGED `loom/*` branch offered to the sweeper — real commits ahead of mainline — SURVIVES.
//       (The card's explicit required regression case.)
//   (C) a merged `loom/*` branch that is STILL CHECKED OUT in a worktree SURVIVES — the
//       git-worktree-list ground-truth guard, independent of any DB row. This is the case the manager
//       flagged as most important: it must fail if the checked-out guard is removed.
//   (D) Pass B and Pass C compose in a SINGLE reconcile() call: a real, zero-commit worker worktree is
//       GC'd by Pass B, and its now-orphaned merged branch is reclaimed by Pass C in the same pass — one
//       shared mechanism, not a second sweeper.
//   (E) a repo with NO resolvable mainline (no `origin` remote — the shape of every other hermetic test
//       repo in this suite) is skipped entirely — fail CLOSED, never falls back to `HEAD` or "main".
//   (G) `deleteBranches`' batched-with-fallback contract: in one chunk of branches handed to a SINGLE
//       `git branch -D` call, one is UNDELETABLE (checked out) — git deletes the others and exits
//       non-zero. The rest must still be reclaimed AND counted, not abandoned with the bad one.
// Card f96b9d7c: the sweep deployed and reclaimed ZERO on the first post-deploy boot, logging NOTHING —
// because listMergedLoomBranches's fail-safe-to-[] catch was silent, making "the git read failed" and
// "there is nothing to reclaim" the SAME observable event. Proves the fix:
//   (f96b9d7c-1) a genuine git-read failure now returns {failed:true} AND is logged (was silent `[]`).
//   (f96b9d7c-2) a genuine zero-to-reclaim read returns {failed:false} — distinguishable from the above.
//   (f96b9d7c-3) reconcile's own "swept, found zero" outcome (R4, a resolvable-mainline repo with no
//       loom/* branches) is counted (branchSweepFoundZero) AND logged per-repo, on both the first and the
//       idempotent second reconcile() call — no longer silent just because the count happens to be zero.
// Run: 1) build daemon, 2) node test/worktree-branch-gc.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bgc-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, resolveMainlineBranch, listCheckedOutBranches, deleteBranches, listMergedLoomBranches } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bgc@loom -c user.name=bgc";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const branchExists = (cwd, branch) => git(cwd, `branch --list ${branch}`) !== "";
const now = new Date().toISOString();

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const A = `loom/a-merged-${sfx}`;
const B = `loom/b-unmerged-${sfx}`;
const C = `loom/c-checked-out-${sfx}`;
const E = `loom/e-nomainline-${sfx}`;
const F = `loom/f-merged-into-other-not-mainline-${sfx}`;

const R1 = path.join(os.tmpdir(), `loom-bgc-r1-${sfx}`);
const R2 = path.join(os.tmpdir(), `loom-bgc-r2-${sfx}`);
const R3 = path.join(os.tmpdir(), `loom-bgc-r3-${sfx}`);
const R4 = path.join(os.tmpdir(), `loom-bgc-r4-${sfx}`);
let cWorktree, dWorktree, dBranch, gBadWorktree;

try {
  // --- R1: a repo with a RESOLVABLE mainline. No real `origin` remote is needed for the daemon to
  // function — only the local `refs/remotes/origin/HEAD` symbolic ref that `git remote set-head` (or a
  // real clone) would normally create, so we write it directly. This exercises the exact primitive
  // (`git symbolic-ref --short refs/remotes/origin/HEAD`) without bare-repo scaffolding. ---
  fs.mkdirSync(R1, { recursive: true });
  fs.writeFileSync(path.join(R1, "README.md"), "# r1\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: R1 });
  git(R1, "branch -M main");
  git(R1, "symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main");

  const projId1 = `bgc-p1-${sfx}`;
  db.insertProject({ id: projId1, name: "BGC-R1", repoPath: R1, vaultPath: R1, config: {}, createdAt: now, archivedAt: null });

  // (A) merged, zero commits ahead, NEVER had a worktree at all — the 275-branch backlog shape.
  git(R1, `checkout -q -b ${A}`);
  git(R1, "checkout -q main");

  // (B) real commit ahead of mainline, never merged, no worktree — MUST survive the sweep.
  git(R1, `checkout -q -b ${B}`);
  fs.writeFileSync(path.join(R1, "b.txt"), "unmerged work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "b work"`, { cwd: R1 });
  git(R1, "checkout -q main");

  // (C) zero commits ahead (trivially merged) but STILL CHECKED OUT in a worktree — MUST survive.
  git(R1, `checkout -q -b ${C}`);
  git(R1, "checkout -q main");
  cWorktree = path.join(os.tmpdir(), `loom-bgc-c-wt-${sfx}`);
  git(R1, `worktree add -q ${cWorktree} ${C}`);

  // (D) a REAL zero-commit worker worktree (via the actual createWorktree primitive), backed by an
  // exited session row — Pass B GCs the worktree (worktreeHasWork()===false), then Pass C must reclaim
  // its now-orphaned, now-uncontested branch IN THE SAME reconcile() call.
  const agentId1 = `bgc-agent1-${sfx}`, taskIdD = `bgc-taskD-${sfx}`, mgrIdD = `bgc-mgrD-${sfx}`, workerIdD = `bgc-wkrD-${sfx}`;
  db.insertAgent({ id: agentId1, projectId: projId1, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskIdD, projectId: projId1, title: "BGC-D", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const created = await createWorktree(R1, projId1, taskIdD);
  dWorktree = created.worktreePath;
  dBranch = created.branch;
  db.insertSession({ id: mgrIdD, projectId: projId1, agentId: agentId1, engineSessionId: null, title: null, cwd: R1, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerIdD, projectId: projId1, agentId: agentId1, engineSessionId: null, title: null, cwd: dWorktree, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrIdD, taskId: taskIdD, worktreePath: dWorktree, branch: dBranch });

  // (F) THE REQUIRED anchor fix: simulate the owner using the human-only `git_checkout` writer to park
  // the PRIMARY repo on a non-mainline branch. `other` carries one commit that real mainline (`main`)
  // does NOT have; `F` branches off `other`, so it's an ancestor of `other` but NOT of `main`. If the
  // sweep anchored on `HEAD` (which is about to be `other`, not `main`) instead of the resolved
  // mainline, it would misjudge `F` as merged and destroy it — the exact silent, unrecoverable data-loss
  // hazard this fix exists to close. Leaving the primary repo parked on `other` (not returned to `main`)
  // for the reconcile() call below is the realistic shape of the hazard.
  git(R1, "checkout -q -b other");
  fs.writeFileSync(path.join(R1, "other-only.txt"), "other-only work, not on mainline\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "other-only commit"`, { cwd: R1 });
  git(R1, `checkout -q -b ${F}`);
  git(R1, "checkout -q other"); // leave the PRIMARY repo parked here — not main — for the reconcile below

  // --- R2: NO `origin` remote at all — the shape every OTHER hermetic test repo in this suite already
  // uses. Mainline cannot be resolved, so its sweep must be skipped entirely: fail CLOSED, never guess
  // "main". This also doubles as the no-regression check that plain `git init`-only repos (e.g. a
  // project bound via `project_init`, per CLAUDE.md) don't crash or misbehave under the new pass. ---
  fs.mkdirSync(R2, { recursive: true });
  fs.writeFileSync(path.join(R2, "README.md"), "# r2\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: R2 });
  git(R2, "branch -M main");
  db.insertProject({ id: `bgc-p2-${sfx}`, name: "BGC-R2", repoPath: R2, vaultPath: R2, config: {}, createdAt: now, archivedAt: null });
  git(R2, `checkout -q -b ${E}`);
  git(R2, "checkout -q main");

  // --- R3: `deleteBranches`' batched-with-fallback contract, tested directly (not via reconcile — this
  // is a unit-level proof of the helper itself). One chunk of 4 branches handed to a SINGLE `git branch
  // -D` call: 3 are plain and deletable, 1 (`g-bad`) is checked out in a worktree and git will refuse it.
  // Verified above (a manual `git branch -D goodA badB goodC` run) that git's real behavior here is
  // "delete what you can, exit non-zero" — NOT "all or nothing". The 3 good ones must be reclaimed AND
  // counted; the bad one must survive untouched. ---
  fs.mkdirSync(R3, { recursive: true });
  fs.writeFileSync(path.join(R3, "README.md"), "# r3\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: R3 });
  const gGood = [`loom/g-good-1-${sfx}`, `loom/g-good-2-${sfx}`, `loom/g-good-3-${sfx}`];
  const gBad = `loom/g-bad-${sfx}`;
  for (const n of gGood) git(R3, `branch ${n}`);
  git(R3, `branch ${gBad}`);
  gBadWorktree = path.join(os.tmpdir(), `loom-bgc-g-wt-${sfx}`);
  git(R3, `worktree add -q ${gBadWorktree} ${gBad}`);

  const gResult = await deleteBranches(R3, [...gGood, gBad]);
  check("(G) batched delete reclaims all 3 good branches despite 1 bad one in the SAME chunk", gGood.every((n) => gResult.deleted.includes(n)) && gResult.deleted.length === 3);
  check("(G) the checked-out bad branch is NOT in the deleted list (accurate count)", !gResult.deleted.includes(gBad));
  check("(G) the 3 good branches are ACTUALLY gone", gGood.every((n) => !branchExists(R3, n)));
  check("(G) the bad branch SURVIVES (still checked out)", branchExists(R3, gBad));

  // --- R4: a resolvable-mainline repo with NO loom/* branches at all — used to prove the reconcile pass's
  // "genuinely swept, found zero" outcome is now VISIBLE (card f96b9d7c), distinct from a read failure. ---
  fs.mkdirSync(R4, { recursive: true });
  fs.writeFileSync(path.join(R4, "README.md"), "# r4\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: R4 });
  git(R4, "branch -M main");
  git(R4, "symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main");
  db.insertProject({ id: `bgc-p4-${sfx}`, name: "BGC-R4", repoPath: R4, vaultPath: R4, config: {}, createdAt: now, archivedAt: null });

  // --- direct primitive checks ---
  check("resolveMainlineBranch resolves 'main' for a repo with a symbolic origin/HEAD", await resolveMainlineBranch(R1) === "main");
  check("resolveMainlineBranch fails CLOSED (null) for a repo with no origin remote", await resolveMainlineBranch(R2) === null);
  let threwOnBadRepo = false;
  try { await listCheckedOutBranches(path.join(os.tmpdir(), `loom-bgc-does-not-exist-${sfx}`)); } catch { threwOnBadRepo = true; }
  check("listCheckedOutBranches THROWS (not fail-safe-empty) when it can't read worktree state", threwOnBadRepo);

  // --- Card f96b9d7c: listMergedLoomBranches must distinguish "read genuinely failed" from "read
  // succeeded, found zero" — before this fix both were the SAME silent `[]`, indistinguishable from each
  // other and from a healthy empty result. This is the exact defect the card describes: a repo that
  // visibly has hundreds of merged refs swept to a silent zero, with no way to tell why. ---
  const capturedWarnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => { capturedWarnings.push(msg); };
  let failResult;
  try {
    failResult = await listMergedLoomBranches(R1, "main", { gitFactory: () => ({ raw: async () => { throw new Error("simulated git read failure"); } }) });
  } finally {
    console.warn = origWarn;
  }
  check("(f96b9d7c) a genuine git-read failure returns failed:true (still fails safe to an empty array)", failResult.failed === true && Array.isArray(failResult.branches) && failResult.branches.length === 0);
  check("(f96b9d7c) the failure is LOGGED (previously totally silent — the exact bug the card reports)", capturedWarnings.some((m) => m.includes("listMergedLoomBranches failed") && m.includes("simulated git read failure")));

  const zeroResult = await listMergedLoomBranches(R4, "main");
  check("(f96b9d7c) a genuine zero-to-reclaim read returns failed:false (distinguishable from the failure case above)", zeroResult.failed === false && zeroResult.branches.length === 0);

  // --- sanity: every fixture branch exists before reconcile ---
  check("(pre) A exists", branchExists(R1, A));
  check("(pre) B exists", branchExists(R1, B));
  check("(pre) C exists", branchExists(R1, C));
  check("(pre) D's worktree exists on disk", fs.existsSync(dWorktree));
  check("(pre) E exists", branchExists(R2, E));
  check("(pre) F exists", branchExists(R1, F));
  check("(pre) F is merged into 'other' (ancestor)", git(R1, "branch --merged other --list " + F) !== "");
  check("(pre) F is NOT merged into real mainline 'main'", git(R1, "branch --merged main --list " + F) === "");
  check("(pre) R1's primary checkout is parked on 'other', not main", git(R1, "rev-parse --abbrev-ref HEAD") === "other");

  // --- FIRST reconcile --- capture console.log to prove R4's "swept, found zero" outcome is now LOGGED
  // (card f96b9d7c's core complaint: this used to be the SAME silent event as a read failure).
  const capturedLogs = [];
  const origLog = console.log;
  console.log = (msg) => { capturedLogs.push(msg); origLog(msg); };
  let r1;
  try {
    r1 = await sessions.reconcileOrchestrationOnBoot();
  } finally {
    console.log = origLog;
  }

  check("(A) merged branch with no worktree is SWEPT", !branchExists(R1, A));
  check("(B) unmerged branch SURVIVES (has real commits ahead of mainline)", branchExists(R1, B));
  check("(C) merged-but-checked-out branch SURVIVES (git-worktree-list guard)", branchExists(R1, C));
  check("(D) Pass B removed the zero-work worktree", !fs.existsSync(dWorktree));
  check("(D) Pass C reclaimed its now-orphaned branch in the SAME reconcile() call", !branchExists(R1, dBranch));
  check("(E) branch in a no-resolvable-mainline repo SURVIVES (fail closed)", branchExists(R2, E));
  check("(F) branch merged into a non-mainline HEAD but NOT into real mainline SURVIVES (anchor fix)", branchExists(R1, F));
  check("(counts) branchesReclaimed counts exactly the 2 safe deletions (A + D)", r1.branchesReclaimed === 2);
  check("(counts) no repo genuinely errored", r1.branchSweepSkippedRepos === 0);
  check("(counts) R2 (no origin) is counted as permanently-inert, not a genuine error", r1.branchSweepNoOrigin === 1);
  check("(f96b9d7c) R4 (zero loom/* branches) is counted as a genuine swept-zero, not silently indistinguishable from a failure", r1.branchSweepFoundZero === 1);
  check("(f96b9d7c) R4's swept-zero outcome is actually LOGGED, not silent", capturedLogs.some((m) => m.includes(R4) && m.includes("0 merged loom/* branch(es) found")));
  check("(f96b9d7c round 2) a start-of-pass log line fires BEFORE any per-repo outcome — makes \"hasn't run yet\" distinguishable from \"ran and found nothing\"", capturedLogs.some((m) => /branch-ref sweep starting for \d+ repo\(s\)/.test(m)));

  // --- SECOND reconcile: idempotent — nothing left to reclaim, survivors still survive, no throw ---
  const r2 = await sessions.reconcileOrchestrationOnBoot();
  check("(no-op) second run reclaims 0 more branches (idempotent)", r2.branchesReclaimed === 0);
  check("(no-op) B still survives", branchExists(R1, B));
  check("(no-op) C still survives", branchExists(R1, C));
  check("(no-op) E still survives", branchExists(R2, E));
  check("(no-op) F still survives", branchExists(R1, F));
  check("(f96b9d7c, no-op) R4 still counts as a genuine swept-zero on the idempotent second run", r2.branchSweepFoundZero === 1);
} finally {
  db.close();
  for (const p of [cWorktree, dWorktree, gBadWorktree]) {
    if (!p) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  for (const r of [R1, R2, R3, R4]) fs.rmSync(r, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the branch-ref reclaim pass sweeps a merged, worktree-less loom/* branch; leaves an unmerged branch and a merged-but-checked-out branch untouched; composes with Pass B's worktree GC in one reconcile() call; and fails closed (skips the repo) when mainline can't be resolved instead of guessing HEAD/main."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
