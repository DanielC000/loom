import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// REUSE-A-GREEN-SELF-CHECK test, PART 2a (card e50600d2 — perf(orchestration): don't re-run the identical
// gate at merge when the worker's own `run_gate` self-check already validated the EXACT same merge
// input). REAL git on temp repos, an INJECTED `runGate` seam shared by BOTH `runWorkerGate` and
// `confirmWorkerMerge` (mirrors merge-gate-retry.mjs's in-process style) so a call COUNTER proves whether
// the gate command actually ran a second time, rather than trusting the return value alone.
//
// SPLIT FROM a single merge-gate-reuse.mjs (card d627f0fd), which itself split into A-L (see
// merge-gate-reuse.mjs) and a combined M-T file. That combined M-T file measured 49-88s solo across 6
// runs on this same busy self-hosting host — two of six already at ~87-88s, ~1.36x under the 120s
// TEST_TIMEOUT_MS ceiling, matching (to within 0.1s) card b5af744d's own batch-merge.mjs measurement that
// WAS SIGTERM-killed at that exact margin, and worse once the documented +35% full-suite-contention
// multiplier is applied (card d627f0fd follow-up). Re-split M-T at its own natural thematic AND
// cumulative-time boundary: the preLanded-gate-race / admission-time-re-union family (M/N/O/P, ~20.7s
// profiled solo) vs. the concurrency + internal-guard-mechanics + combined-conditions family (Q/R/S/T,
// ~24.6s profiled solo — see merge-gate-reuse-robustness.mjs). This file carries M-P. All 140 checks from
// the original single file are conserved across all three files now; zero deleted at any split.
//
// Proves:
//   (M) ALREADY-LANDED (preLanded) BRANCH GAINS NEW COMMITS DURING THE GATE — card b0ab78d6. The
//       preLanded path (union-merge deliberately skipped once a branch's squash already landed on main)
//       now also captures canonical HEAD at the point the union-merge would have run, so the same in-lock
//       `requireCanonicalHead` re-check fires here too and refuses rather than silently squashing a new
//       commit no gate ever validated together with main.
//   (N) ALREADY-LANDED (preLanded) PURE RE-CONFIRM STAYS IDEMPOTENT WHEN ONLY MAIN MOVES — card b0ab78d6.
//       (M) and this scenario are a DISCRIMINATING PAIR: (M) proves the fix refuses when the branch itself
//       gains new content during the gate; (N) proves it does NOT refuse when the branch is a true pure
//       duplicate and only main moved elsewhere — only together do they prove the new
//       `gateBaseBranchHead` check can actually tell the two cases apart.
//   (O) ADMISSION-TIME RE-UNION CONFLICT — card b798e706 DoD-3. Main advances while genuinely queued (same
//       precondition as (K) in merge-gate-reuse.mjs), this time conflicting with the worktree's own work:
//       the outcome is a defined, observable rejection (`union_conflict_at_admission`), never a silent
//       vanish and never a silent proceed on the stale (pre-conflict) base.
//   (P) THE FAIL-CLOSED GUARD STILL FIRES AFTER A SUCCESSFUL ADMISSION-TIME RE-UNION — card b798e706
//       DoD-4. A second, later main advance DURING the gate's own execution — a window the once-only
//       admission-time re-derivation cannot see coming — is still caught fail-closed at squash time,
//       proving this card's fix narrows the stale-base window rather than deleting the guard.
//
// See merge-gate-reuse.mjs for: (A) the happy-path reuse, (B)-(F) the core moved-main/stale-base/racy/
// dirty/superseded re-gate matrix, (G) a new commit on the branch itself, (H) a simulated daemon restart,
// (I) the TOCTOU guard itself, (J) main advancing during a real gate run, (K) main advancing during the
// semaphore queue wait, and (L) the moved-main-between-the-two-reads case.
// See merge-gate-reuse-robustness.mjs for: (Q) two genuinely concurrent same-repo confirms, (R)/(S) the
// per-repo admission guard's leak-proofing and confinement, and (T) multiple reuse conditions failing
// simultaneously.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-reuse-admission.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mgru-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT_ID = "-c user.email=mgru@loom -c user.name=mgru";
const now = new Date().toISOString();

const eventsOfKind = (db, mgrId, kind) => db.listEvents(mgrId).filter((e) => e.kind === kind);
// Card b798e706, Code Review fix (test (P) discrimination): true iff `ancestorSha` is reachable from
// `descendantRef` in `repo` — used to prove a specific commit actually landed IN a tree (e.g. the
// worktree, via the admission-time re-union merge), not just that SOME refusal/success shape occurred.
// `git merge-base --is-ancestor` exits 0/1 by design (never stderr text on a clean "false"), so a
// non-zero exit is read as `false` rather than an error.
const isAncestor = (repo, ancestorSha, descendantRef) => {
  try {
    execSync(`git merge-base --is-ancestor ${ancestorSha} ${descendantRef}`, { cwd: repo });
    return true;
  } catch {
    return false;
  }
};

function seed(db, p, gateCommand) {
  db.insertProject({ id: p.projId, name: "MGRU", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MGRU-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  registerForCleanup(p.repo); // bare origin repo — never cleaned by the worktrees[]/LOOM_HOME sweep below
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mgru\n");
  execSync(`git init -q && git config user.email mgru@loom && git config user.name mgru`, { cwd: p.repo });
  commitAll(p.repo, "init", GIT_ID);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `mgru-${label}-proj-${sfx}`, agentId: `mgru-${label}-agent-${sfx}`, taskId: `mgru-${label}-task-${sfx}`,
  mgrId: `mgru-${label}-mgr-${sfx}`, workerId: `mgru-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mgru-${label}-${sfx}`), file,
});

const dbs = [];
const worktrees = [];
try {
  // ── (M) ALREADY-LANDED (preLanded) BRANCH GAINS NEW COMMITS DURING THE GATE — card b0ab78d6. The
  //        union-merge is deliberately SKIPPED once a branch's squash already landed on main (`preLanded`,
  //        to protect ALREADY_MERGED re-confirm classification — see confirmWorkerMerge's own doc), so
  //        BEFORE this fix `gateBaseMainHead` was never captured on this path even though a REAL gate still
  //        runs. If the worktree's branch gains a genuinely new commit WHILE that gate is in flight (a
  //        redirected/still-active worker keeps committing before being told to stand down — the worker's
  //        pty is not stopped until AFTER this method returns), the squash re-derives fresh at squash time
  //        and stages that new commit's diff — content no gate ever validated together with main. Pre-fix,
  //        with `gateBaseMainHead` left `undefined`, mergeBranch's in-lock re-check was skipped entirely and
  //        this landed SILENTLY even with main having ALSO advanced in the same window — exactly eda70da6's
  //        DoD prohibition, on the one path its fix didn't reach. Post-fix, the preLanded branch captures
  //        canonical HEAD at the same point the union-merge would have run, so the SAME in-lock
  //        `requireCanonicalHead` re-check now fires here too and refuses instead of silently squashing.
  {
    const M = mk("m", "feature-m.txt");
    makeRepo(M);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const { mergeBranch } = await import("../dist/git/worktrees.js");
    const { worktreePath, branch } = await createWorktree(M.repo, M.projId, M.taskId);
    M.worktreePath = worktreePath; M.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, M.file), "work for M\n");
    commitAll(worktreePath, `${M.file}`, GIT_ID);

    // Precondition: this branch's squash already landed on main — worktree deliberately retained (a
    // stale/racing confirm, or a manager holding it open for follow-up work), mirroring merge-union-gate.mjs
    // scenario (D)'s own setup.
    const landed = await mergeBranch(M.repo, branch, "MGRU-M initial land");
    check("(M) precondition: branch's initial work already landed in main", landed.ok === true);

    let calls = 0;
    const fakeGate = async () => {
      calls++;
      if (calls === 1) {
        // Simulates the worktree SURVIVING the earlier land and gaining a genuinely new commit WHILE the
        // gate is in flight — the "not merely theoretical" case the card names.
        fs.writeFileSync(path.join(worktreePath, "m-followup.txt"), "new work after the earlier land\n");
        commitAll(worktreePath, "m followup during gate", GIT_ID);
        // Main ALSO advances in the same window (a sibling merge, or a human REST commit) — the concrete
        // race `gateBaseMainHead` exists to catch.
        fs.writeFileSync(path.join(M.repo, "main-advance-during-gate-m.txt"), "main moved during the gate\n");
        commitAll(M.repo, "main advance during gate m", GIT_ID);
      }
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    seed(db, M, "pnpm gate");

    const mainHeadBeforeConfirm = execSync("git rev-parse HEAD", { cwd: M.repo }).toString().trim();
    const confirm = await sessions.confirmWorkerMerge(M.mgrId, M.workerId);
    check("(M) the gate ran for real (a real gate on the preLanded path, not the reuse path)", calls === 1);
    check("(M) gateRan:true", confirm.gateRan === true);
    check("(M) confirmWorkerMerge REFUSES rather than silently squashing the new commit onto an advanced main", confirm.merged === false);
    check("(M) the refusal reads as a benign, retryable race, not a real merge/gate failure", /benign race|advanced/i.test(confirm.reason ?? ""));
    const commitsAheadOfBaseline = execSync(`git rev-list --count ${mainHeadBeforeConfirm}..HEAD`, { cwd: M.repo }).toString().trim();
    check("(M) canonical repo gained ONLY the mid-gate advance commit — no squash landed on top of it (zero side effects)", commitsAheadOfBaseline === "1");
    const stagedAfterRefusal = execSync("git diff --cached --name-only", { cwd: M.repo }).toString().trim();
    check("(M) canonical repo index carries no residue from the refused attempt", stagedAfterRefusal === "");
    check("(M) worktree retained for a retry (not torn down on this refusal)", fs.existsSync(worktreePath) === true);

    // RETRY: main holds still through this second real gate run — re-confirming re-derives everything
    // fresh (the branch is no longer a pure preLanded duplicate, so this retry takes the ordinary
    // union-merge path) and actually lands the follow-up commit. Guarded on the refusal actually having
    // happened (worktree still present): on a regression (the first confirm silently merged instead of
    // refusing) the worktree is ALREADY torn down by finalizeMerge, and a retry against a gone worktree
    // would throw a raw GitConstructError, masking the real failure with an unrelated crash — the checks
    // above already recorded that regression, so just skip the retry rather than compounding it.
    if (confirm.merged === false && fs.existsSync(worktreePath)) {
      const retry = await sessions.confirmWorkerMerge(M.mgrId, M.workerId);
      check("(M) a retry re-confirm succeeds once main stops moving mid-gate", retry.merged === true);
      check("(M) task moved to done on the retry", db.getTask(M.taskId).columnKey === "done");
    } else {
      check("(M) retry skipped — the first confirm did not refuse as expected, so there is no clean retry to prove", false);
    }
  }
  // ── (N) ALREADY-LANDED (preLanded) PURE RE-CONFIRM STAYS IDEMPOTENT WHEN ONLY MAIN MOVES — card
  //        b0ab78d6, regression found and closed before merge. (M) above and this scenario are a
  //        DISCRIMINATING PAIR, not two independent tests: (M) proves the fix still refuses when the
  //        branch itself gains new content during the gate; (N) proves it does NOT refuse when the branch
  //        is a TRUE pure duplicate and only main moves elsewhere. Only together do they prove the new
  //        `gateBaseBranchHead` branch-stability check can actually tell the two cases apart — (N) alone
  //        would not catch a fix that simply stopped enforcing `requireCanonicalHead` altogether on this
  //        path (which would also make (N) pass, while quietly breaking (M)). Identical setup to (M) EXCEPT
  //        the worktree/branch gains NOTHING new during the gate — this is the COMMON case on the preLanded
  //        path (a stale/racing re-confirm, see the early-idempotency doc in worktrees.ts), and was
  //        idempotent (`ALREADY_MERGED`, `merged:true`) before `gateBaseMainHead` existed on this path at
  //        all. A bare `gateBaseMainHead` capture (no branch-stability discriminator) regresses this into a
  //        refusal purely because main moved elsewhere — routine on an active fleet, and harmless here since
  //        nothing from this branch is landing either way.
  {
    const N = mk("n", "feature-n.txt");
    makeRepo(N);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const { mergeBranch } = await import("../dist/git/worktrees.js");
    const { worktreePath, branch } = await createWorktree(N.repo, N.projId, N.taskId);
    N.worktreePath = worktreePath; N.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, N.file), "work for N\n");
    commitAll(worktreePath, `${N.file}`, GIT_ID);

    const landed = await mergeBranch(N.repo, branch, "MGRU-N initial land");
    check("(N) precondition: branch's initial work already landed in main", landed.ok === true);

    let calls = 0;
    const fakeGate = async () => {
      calls++;
      if (calls === 1) {
        // Main advances mid-gate — UNRELATED to this branch (a sibling merge, a human REST commit).
        // Nothing whatsoever is added to the worktree/branch — the discriminator this scenario exists to
        // prove: a TRUE pure duplicate must stay idempotent regardless of what main does elsewhere.
        fs.writeFileSync(path.join(N.repo, "unrelated-main-advance-n.txt"), "some other merge landed\n");
        commitAll(N.repo, "unrelated main advance n", GIT_ID);
      }
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    seed(db, N, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(N.mgrId, N.workerId);
    // `calls === 1` is this scenario's own proof that a real gate ran (not the reuse path) — unlike (M)'s
    // refusal, the ALREADY_MERGED success path returns via `finishAlreadyMerged`, whose result never
    // carries `gateRan` at all (confirmed: merge-union-gate.mjs scenario D doesn't assert it either), so
    // there is no `confirm.gateRan` field to check here.
    check("(N) the gate ran for real (a real gate on the preLanded path, not the reuse path)", calls === 1);
    check("(N) confirmWorkerMerge STAYS IDEMPOTENT — merged:true despite main moving mid-gate", confirm.merged === true);
    check("(N) emptyKind === 'ALREADY_MERGED' (a benign no-op, not a gateBaseInvalidated refusal)", confirm.emptyKind === "ALREADY_MERGED");
    check("(N) task moved to done", db.getTask(N.taskId).columnKey === "done");
    check("(N) worktree removed (idempotent cleanup completed, not left retained by a false refusal)", !fs.existsSync(worktreePath));
  }

  // ── (O) ADMISSION-TIME RE-UNION CONFLICT — card b798e706 DoD-3. Main advances WHILE genuinely queued
  //        (same precondition as (K)), but this time with a change that CONFLICTS with the worktree's own
  //        work (both sides modify README.md's one line differently from their common base). The
  //        admission-time re-union (K's happy path) must instead hit a REAL git conflict here — proving
  //        the outcome is a defined, observable rejection (`union_conflict_at_admission`), never a silent
  //        vanish and never a silent proceed on the stale (pre-conflict) base.
  {
    const O = mk("o", "feature-o.txt");
    makeRepo(O);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: fakeGate,
      reapWorktreeProcesses: async () => ({ killedPids: [] }),
    });
    const { worktreePath, branch } = await createWorktree(O.repo, O.projId, O.taskId);
    O.worktreePath = worktreePath; O.branch = branch; worktrees.push(worktreePath);
    // Worker's own change modifies README.md's ONE line (not just adds a new file) — the same line the
    // conflicting main advance below will ALSO modify, differently, from the same base ("# mgru\n").
    fs.writeFileSync(path.join(worktreePath, "README.md"), "# mgru WORKER\n");
    fs.writeFileSync(path.join(worktreePath, O.file), "work for O\n");
    commitAll(worktreePath, `${O.file} + conflicting readme edit`, GIT_ID);
    seed(db, O, "pnpm gate");

    let releaseHolder;
    const holderPromise = new Promise((resolve) => { releaseHolder = resolve; });
    const holderRun = sessions.gateSemaphore.runExclusive(
      1, { gateType: "merge", projectId: "mgru-o-holder-proj", sessionId: "mgru-o-holder-sess" }, () => holderPromise,
    );

    const mainHeadBeforeConfirm = execSync("git rev-parse HEAD", { cwd: O.repo }).toString().trim();
    const confirmPromise = sessions.confirmWorkerMerge(O.mgrId, O.workerId);

    const queueDeadline = Date.now() + 20_000;
    let queued = false;
    while (Date.now() <= queueDeadline) {
      if (sessions.gateSemaphore.snapshot().queued >= 1) { queued = true; break; }
      await sleep(5);
    }
    check("(O) precondition: confirmWorkerMerge's gate request is genuinely queued (union-merge already ran)", queued);
    if (!queued) {
      releaseHolder();
      await Promise.allSettled([holderRun, confirmPromise]);
    } else {
      // Main advances WHILE queued, with a CONFLICTING edit to the same line the worker's own branch
      // already changed — the base line was "# mgru\n"; both sides now diverge from it differently.
      fs.writeFileSync(path.join(O.repo, "README.md"), "# mgru MAIN\n");
      commitAll(O.repo, "main advance during queue (conflicting)", GIT_ID);

      releaseHolder();
      await holderRun;
      const confirm = await confirmPromise;

      check("(O) the gate NEVER ran — the admission-time re-union conflict throws before the gate spawns", calls === 0);
      check("(O) confirmWorkerMerge REJECTS — a defined, observable outcome, never silent", confirm.merged === false);
      check("(O) the rejection names the conflict, not a generic error", /conflict/i.test(confirm.reason ?? ""));
      const rejected = eventsOfKind(db, O.mgrId, "merge_rejected").at(-1);
      check("(O) merge_rejected event recorded with reason union_conflict_at_admission", rejected?.detail?.reason === "union_conflict_at_admission");
      const commitsAheadOfBaseline = execSync(`git rev-list --count ${mainHeadBeforeConfirm}..HEAD`, { cwd: O.repo }).toString().trim();
      check("(O) canonical repo gained ONLY the queue-wait commit — no squash ever attempted (zero side effects)", commitsAheadOfBaseline === "1");
      const stagedAfterRejection = execSync("git diff --cached --name-only", { cwd: O.repo }).toString().trim();
      check("(O) canonical repo index carries no residue from the rejected attempt", stagedAfterRejection === "");
      check("(O) worktree retained so the manager can resolve the conflict (not silently vanished)", fs.existsSync(worktreePath) === true);
    }
  }

  // ── (P) THE FAIL-CLOSED GUARD STILL FIRES AFTER A SUCCESSFUL ADMISSION-TIME RE-UNION — card b798e706
  //        DoD-4. A main advance that admission's re-union CAN absorb (the queue-wait movement, exactly
  //        like (K)) is followed by a SECOND, later main advance DURING the gate's own execution — a
  //        movement the re-derivation (which only runs ONCE, right before the gate spawns) cannot see
  //        coming and does not re-absorb. `requireCanonicalHead`'s in-lock re-check at squash time must
  //        still catch THIS window fail-closed, exactly as it always has (mirrors (J)/(M)) — proving this
  //        card's fix narrows the stale-base window rather than deleting the guard that protects it.
  {
    const P = mk("p", "feature-p.txt");
    makeRepo(P);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => {
      calls++;
      if (calls === 1) {
        // SECOND main advance — DURING the gate's own execution, well after admission's re-union already
        // ran and re-derived `gateBaseMainHead` against the FIRST (queue-wait) advance. Gated to the FIRST
        // call only: the RETRY confirm below calls this fake gate again, and it must behave like a normal
        // green gate on that second call, not repeat a now-no-op write+commit (which would throw on
        // "nothing to commit").
        fs.writeFileSync(path.join(P.repo, "main-advance-during-gate-p.txt"), "a second, later main advance\n");
        commitAll(P.repo, "main advance during gate (p)", GIT_ID);
      }
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: fakeGate,
      reapWorktreeProcesses: async () => ({ killedPids: [] }),
    });
    const { worktreePath, branch } = await createWorktree(P.repo, P.projId, P.taskId);
    P.worktreePath = worktreePath; P.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, P.file), "work for P\n");
    commitAll(worktreePath, `${P.file}`, GIT_ID);
    seed(db, P, "pnpm gate");

    let releaseHolder;
    const holderPromise = new Promise((resolve) => { releaseHolder = resolve; });
    const holderRun = sessions.gateSemaphore.runExclusive(
      1, { gateType: "merge", projectId: "mgru-p-holder-proj", sessionId: "mgru-p-holder-sess" }, () => holderPromise,
    );

    const mainHeadBeforeConfirm = execSync("git rev-parse HEAD", { cwd: P.repo }).toString().trim();
    const confirmPromise = sessions.confirmWorkerMerge(P.mgrId, P.workerId);

    const queueDeadline = Date.now() + 20_000;
    let queued = false;
    while (Date.now() <= queueDeadline) {
      if (sessions.gateSemaphore.snapshot().queued >= 1) { queued = true; break; }
      await sleep(5);
    }
    check("(P) precondition: confirmWorkerMerge's gate request is genuinely queued (union-merge already ran)", queued);
    if (!queued) {
      releaseHolder();
      await Promise.allSettled([holderRun, confirmPromise]);
    } else {
      // FIRST main advance — WHILE queued, absorbed cleanly by admission's re-union (exactly (K)'s case).
      fs.writeFileSync(path.join(P.repo, "main-advance-during-queue-p.txt"), "the absorbable queue-wait advance\n");
      commitAll(P.repo, "main advance during queue (p)", GIT_ID);
      const queueWaitSha = execSync("git rev-parse HEAD", { cwd: P.repo }).toString().trim();

      releaseHolder();
      await holderRun;
      const confirm = await confirmPromise;

      check("(P) the gate ran for real once admitted (the first advance was absorbed, not refused here)", calls === 1);
      check("(P) gateRan:true", confirm.gateRan === true);
      check("(P) confirmWorkerMerge STILL REFUSES — the SECOND advance (during the gate) is not re-absorbed", confirm.merged === false);
      check("(P) the refusal reads as a benign, retryable race, not a real merge/gate failure", /benign race|advanced/i.test(confirm.reason ?? ""));
      const commitsAheadOfBaseline = execSync(`git rev-list --count ${mainHeadBeforeConfirm}..HEAD`, { cwd: P.repo }).toString().trim();
      // 2 = the absorbed queue-wait commit + the during-gate commit — no squash landed on top of either.
      check("(P) canonical repo gained BOTH main advances — no squash landed (zero side effects)", commitsAheadOfBaseline === "2");
      const stagedAfterRefusal = execSync("git diff --cached --name-only", { cwd: P.repo }).toString().trim();
      check("(P) canonical repo index carries no residue from the refused attempt", stagedAfterRefusal === "");
      check("(P) worktree retained for a retry (not torn down on this refusal)", fs.existsSync(worktreePath) === true);

      // DISCRIMINATION (Code Review finding, card b798e706): every check above is ALSO satisfied by
      // PRE-FIX code — pre-fix, this op would have refused on the FIRST advance already (no admission-time
      // re-union at all), landing on the identical `merged:false`/2-commits-ahead/no-residue/retained
      // shape by a totally different mechanism. None of that proves the re-union actually ran. This one
      // does: the queue-wait commit only reaches the WORKTREE (a real `git merge` write, not the canonical
      // repo mergeMainIntoWorktree never touches) if `reunionAtAdmission` genuinely re-unioned against it —
      // pre-fix code never runs that merge at all, so this specific commit could never become an ancestor
      // of the worktree's own HEAD. RED-verified against pre-fix code (git stash of this card's src/ diff,
      // rebuild, re-run — same method as card 171297dc's sibling fix): fails exactly this check, all
      // others upstream of it still pass.
      check("(P) the admission-time re-union GENUINELY RAN — the queue-wait commit landed in the worktree (not just refused for some other reason)",
        isAncestor(worktreePath, queueWaitSha, "HEAD"));

      // RETRY: main holds still through this second attempt — re-confirming re-derives everything fresh
      // (a new union-merge, a new gateBaseMainHead) and actually lands, proving the fail-closed refusal
      // above was retryable, not a dead end.
      const retry = await sessions.confirmWorkerMerge(P.mgrId, P.workerId);
      check("(P) a retry re-confirm succeeds once main stops moving mid-gate", retry.merged === true);
      check("(P) task moved to done on the retry", db.getTask(P.taskId).columnKey === "done");
    }
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the preLanded path now refuses when a branch gains new content during the gate (M) while staying idempotent when only main moves (N); an admission-time re-union conflict is a defined rejection, never a silent vanish or a silent proceed (O); and the fail-closed guard still fires for a main advance the once-only admission-time re-derivation can't see (P). See merge-gate-reuse.mjs for the core reuse-decision and race-window scenarios, and merge-gate-reuse-robustness.mjs for concurrent same-repo confirms, the admission guard's leak-proofing/confinement, and the combined-conditions capstone."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
