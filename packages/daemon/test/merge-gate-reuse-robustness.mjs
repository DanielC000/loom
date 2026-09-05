import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// REUSE-A-GREEN-SELF-CHECK test, PART 2b (card e50600d2 — perf(orchestration): don't re-run the identical
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
// profiled solo — see merge-gate-reuse-admission.mjs) vs. the concurrency + internal-guard-mechanics +
// combined-conditions family this file carries (Q/R/S/T, ~24.6s profiled solo). All 140 checks from the
// original single file are conserved across all three files now; zero deleted at any split.
//
// Proves:
//   (Q) TWO GENUINELY CONCURRENT confirmWorkerMerge CALLS ON THE SAME REPO — card c24dd48a's own
//       DoD-2(i), written LITERALLY (not simulated via a synthetic runExclusive holder — see (K)/(P)'s own
//       honest caveats about what they do and don't prove, in the other two files). Two REAL branches of
//       the SAME canonical repo, two REAL confirmWorkerMerge calls fired genuinely concurrently: the one
//       admitted second lands on its FIRST PASS, proving the per-repo admission guard is now held across
//       the FIRST merge's own squash, not just its gate.
//   (R) card c24dd48a, Code Review follow-up — LEAK-PROOF: a THROW landing strictly between the gate
//       settling (guard already held via `holdRepoGuardOnExit`) and `beginSquash`/`mergeBranch` must NOT
//       leak the per-repo admission guard for the process's lifetime.
//   (S) card c24dd48a, Code Review follow-up — CONFINEMENT: a GATELESS merge must never touch
//       `activeMergeRepos` via `beginSquash`/`endSquash` — spies on both methods (not a snapshot-shape
//       inference) to prove neither is ever called for a project with no `gateCommand` configured at all.
//   (T) MULTIPLE REUSE CONDITIONS FAIL SIMULTANEOUSLY — card 2e52bf99, the whole point of the card. A
//       preLanded branch with worktree-dirty, stamp-changed-worktree, and behind-main ALL independently
//       true at once must record all three reasons together (not just the first hit), and correctly
//       attribute the stamp change to the worktree — never mislabeled stamp-changed-by-union-merge — even
//       though main also genuinely advanced in this same scenario.
//
// See merge-gate-reuse.mjs for: (A) the happy-path reuse, (B)-(F) the core moved-main/stale-base/racy/
// dirty/superseded re-gate matrix, (G) a new commit on the branch itself, (H) a simulated daemon restart,
// (I) the TOCTOU guard itself, (J) main advancing during a real gate run, (K) main advancing during the
// semaphore queue wait, and (L) the moved-main-between-the-two-reads case.
// See merge-gate-reuse-admission.mjs for: (M)/(N) the preLanded discriminating pair, (O) admission-time
// re-union conflict, and (P) the fail-closed guard firing after a successful admission-time re-union.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-reuse-robustness.mjs
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
  // ── (Q) TWO GENUINELY CONCURRENT confirmWorkerMerge CALLS ON THE SAME REPO — card c24dd48a's own
  //        DoD-2(i), written LITERALLY. Unlike (K)/(P) above (an unrelated synthetic `runExclusive` holder
  //        standing in for "some other gate occupies the lane" — see those blocks' own honest caveats),
  //        this is a REAL second merge: two different branches of the SAME canonical repo, two REAL
  //        `confirmWorkerMerge` calls started with zero `await` between them, each running its OWN real
  //        gate through the SAME `GateSemaphore`. Whichever is admitted second used to be admitted the
  //        INSTANT the first gate settled — strictly BEFORE the first's own squash landed (the exact defect
  //        this card fixes) — re-derive to a no-op against the still-unmoved main, run its own full gate
  //        against that now-stale base, then self-abort at squash time once the first's squash actually
  //        lands mid-run, forcing a manager re-confirm. With the fix (`holdRepoGuardOnExit` +
  //        `beginSquash`/`endSquash`), the second is held OUT of admission until the first's squash has
  //        actually landed, so its own admission-time re-union sees the true current main and it lands on
  //        the FIRST PASS. RED-verified against pre-fix code (git stash of this card's src/ diff, rebuild,
  //        re-run): with the guard release moved back to the gate's own settle, one of the two confirms
  //        below comes back `merged:false` with a `gateBaseInvalidated` refusal — this suite's center of
  //        gravity is that refusal never happening here, not the happy-path shape alone.
  {
    const qRepo = path.join(os.tmpdir(), `loom-mgru-q-${sfx}`);
    fs.mkdirSync(qRepo, { recursive: true });
    registerForCleanup(qRepo); // bare origin repo — never cleaned by the worktrees[]/LOOM_HOME sweep below
    fs.writeFileSync(path.join(qRepo, "README.md"), "# mgru-q\n");
    execSync(`git init -q && git config user.email mgru@loom && git config user.name mgru`, { cwd: qRepo });
    commitAll(qRepo, "init", GIT_ID);

    const qProjId = `mgru-q-proj-${sfx}`, qAgentId = `mgru-q-agent-${sfx}`;
    const db = new Db(); dbs.push(db);
    db.insertProject({ id: qProjId, name: "MGRU-Q", repoPath: qRepo, vaultPath: qRepo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: qAgentId, projectId: qProjId, name: "t", startupPrompt: "", position: 0 });

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let qGateCalls = 0;
    // A real (short) delay on EVERY gate call so the two confirms have a genuine window to overlap —
    // long enough that the second confirm's own union-merge/admission attempt is provably still in
    // flight while the first is mid-gate, never a coincidence of both settling in the same tick.
    const fakeGate = async () => { qGateCalls++; await sleep(150); return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    async function makeQWorker(label, file) {
      const taskId = `mgru-q-task-${label}-${sfx}`, mgrId = `mgru-q-mgr-${label}-${sfx}`, workerId = `mgru-q-wkr-${label}-${sfx}`;
      const { worktreePath, branch } = await createWorktree(qRepo, qProjId, taskId);
      worktrees.push(worktreePath);
      fs.writeFileSync(path.join(worktreePath, file), `work for ${label}\n`);
      commitAll(worktreePath, `${file}`, GIT_ID);
      db.insertTask({ id: taskId, projectId: qProjId, title: `MGRU-Q-${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: mgrId, projectId: qProjId, agentId: qAgentId, engineSessionId: null, title: null, cwd: qRepo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      db.insertSession({ id: workerId, projectId: qProjId, agentId: qAgentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
      return { taskId, mgrId, workerId };
    }

    const qOne = await makeQWorker("one", "feature-q1.txt");
    const qTwo = await makeQWorker("two", "feature-q2.txt");

    const qMainHeadBefore = execSync("git rev-parse HEAD", { cwd: qRepo }).toString().trim();

    // Fire BOTH confirms genuinely concurrently — no await between them, so both race to admission on the
    // SAME GateSemaphore instance sharing this repo's `activeMergeRepos` guard.
    const [qResultOne, qResultTwo] = await Promise.all([
      sessions.confirmWorkerMerge(qOne.mgrId, qOne.workerId),
      sessions.confirmWorkerMerge(qTwo.mgrId, qTwo.workerId),
    ]);

    check("(Q) confirmWorkerMerge[one] landed on the FIRST pass", qResultOne.merged === true);
    check("(Q) confirmWorkerMerge[two] landed on the FIRST pass", qResultTwo.merged === true);
    check("(Q) confirmWorkerMerge[one] never reports a stale-base refusal reason", qResultOne.reason === undefined);
    check("(Q) confirmWorkerMerge[two] never reports a stale-base refusal reason", qResultTwo.reason === undefined);
    check("(Q) both gates ran for real (no reuse short-circuit on either side)", qGateCalls === 2);
    const qCommitsAhead = execSync(`git rev-list --count ${qMainHeadBefore}..HEAD`, { cwd: qRepo }).toString().trim();
    check("(Q) canonical repo gained exactly 2 squash commits — no wasted/aborted attempt on either side", qCommitsAhead === "2");
    check("(Q) both tasks moved to done — neither needed a manager re-confirm",
      db.getTask(qOne.taskId).columnKey === "done" && db.getTask(qTwo.taskId).columnKey === "done");
  }

  // ── (R) card c24dd48a, Code Review follow-up — LEAK-PROOF: a THROW landing strictly between the gate
  //        settling (guard already held via `holdRepoGuardOnExit`) and `beginSquash`/`mergeBranch` must
  //        NOT leak the per-repo admission guard for the process's lifetime. An earlier draft of this fix
  //        wrapped only `mergeBranch` itself in try/finally — leaving `evt("build_gate", ...)` (a
  //        synchronous `db.appendEvent` call, which CAN throw), `recordGateTimeoutOutcome` (an `await`),
  //        and the `taskTitle` lookup (a synchronous `db.getTask` read) all exposed in that gap. This
  //        injects a throw at the FIRST of those (`db.appendEvent` for kind "build_gate") and proves TWO
  //        things: (i) the throw genuinely propagates out of `confirmWorkerMerge` (the control fires — this
  //        isn't vacuously green because nothing actually threw), and (ii) a SECOND, ORDINARY
  //        `confirmWorkerMerge` for a DIFFERENT branch of the SAME repo still completes promptly
  //        afterward — a leaked guard would instead queue it forever (bounded here so a real regression
  //        fails the check rather than hanging the whole file).
  {
    const R = mk("r", "feature-r.txt");
    makeRepo(R);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const fakeGate = async () => ({ passed: true });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(R.repo, R.projId, R.taskId);
    R.worktreePath = worktreePath; R.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, R.file), "work for R\n");
    commitAll(worktreePath, `${R.file}`, GIT_ID);
    seed(db, R, "pnpm gate");

    // Inject the throw at the exact vulnerable call site named in Code Review: the FIRST "build_gate"
    // event append, which fires strictly after `holdRepoGuardOnExit` (inside the passing gate's own `fn`)
    // but strictly before `beginSquash`/`mergeBranch`.
    const originalAppendEvent = db.appendEvent.bind(db);
    let armed = true;
    db.appendEvent = (event) => {
      if (armed && event.kind === "build_gate") {
        armed = false;
        throw new Error("[R] injected throw between gate-settle and beginSquash");
      }
      return originalAppendEvent(event);
    };

    let threw = false;
    try {
      await sessions.confirmWorkerMerge(R.mgrId, R.workerId);
    } catch (e) {
      threw = typeof e?.message === "string" && e.message.includes("[R] injected throw");
    }
    check("(R) the injected throw genuinely propagated out of confirmWorkerMerge (control is not vacuous)", threw);
    db.appendEvent = originalAppendEvent;

    // Second, ORDINARY worker/task on the SAME repo — must not queue forever behind a leaked guard.
    const r2TaskId = `mgru-r2-task-${sfx}`, r2MgrId = `mgru-r2-mgr-${sfx}`, r2WorkerId = `mgru-r2-wkr-${sfx}`;
    const { worktreePath: r2Worktree, branch: r2Branch } = await createWorktree(R.repo, R.projId, r2TaskId);
    worktrees.push(r2Worktree);
    fs.writeFileSync(path.join(r2Worktree, "feature-r2.txt"), "work for r2\n");
    commitAll(r2Worktree, "feature-r2.txt", GIT_ID);
    db.insertTask({ id: r2TaskId, projectId: R.projId, title: "MGRU-R2-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: r2MgrId, projectId: R.projId, agentId: R.agentId, engineSessionId: null, title: null, cwd: R.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: r2WorkerId, projectId: R.projId, agentId: R.agentId, engineSessionId: null, title: null, cwd: r2Worktree, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: r2MgrId, taskId: r2TaskId, worktreePath: r2Worktree, branch: r2Branch });

    // CARD 944f7c17: this used to race the real confirmWorkerMerge below (real git subprocesses + SQLite)
    // against a FIXED `LEAK_PROBE_TIMEOUT_MS = 5_000` — a hand-picked wall-clock number that flaked a green
    // gate (op 7180a6ca, 862s total runtime) despite a measured ~7x quiet-host margin: the repo-guard's own
    // admit→release window (`[gate:repo-guard]`, `gate_queue activeCount:0`) measured 683ms against that
    // 5,000ms budget on a direct re-run of THIS SAME assertion. A 7x margin sounding ample and still getting
    // consumed once is the whole argument against sizing ANY fixed constant here (see the card body's
    // §DISCRIMINATOR — concurrency and gross host load were both positively EXCLUDED as the driver; the
    // remaining candidate is a momentary, local stall, which a fixed number can never absorb).
    //
    // Fix: calibrate LIVE instead of guessing. Run an ORDINARY confirmWorkerMerge on an UNCONTENDED repo
    // (same shape as the probe below — same fakeGate, same helpers — but shares no repoPath with R, so it
    // can never itself be blocked by a leaked guard) immediately beforehand, time it with a monotonic clock,
    // and scale the probe's own ceiling off THAT live measurement. A slow moment on this host inflates the
    // ceiling right along with it, instead of racing a number picked on a different day under different
    // conditions. The BOUND itself is unchanged in kind — still a race, still a `check()` failure (not a
    // hang) on timeout — only the fixed CONSTANT is gone.
    const CAL = mk("rcal", "feature-rcal.txt");
    makeRepo(CAL);
    const { worktreePath: calWorktree, branch: calBranch } = await createWorktree(CAL.repo, CAL.projId, CAL.taskId);
    CAL.worktreePath = calWorktree; CAL.branch = calBranch; worktrees.push(calWorktree);
    fs.writeFileSync(path.join(calWorktree, CAL.file), "work for rcal\n");
    commitAll(calWorktree, `${CAL.file}`, GIT_ID);
    seed(db, CAL, "pnpm gate");
    const calStartedAt = performance.now();
    const calResult = await sessions.confirmWorkerMerge(CAL.mgrId, CAL.workerId);
    const calDurationMs = performance.now() - calStartedAt;
    check("(R) calibration: an ordinary, uncontended confirmWorkerMerge landed (sizes the probe ceiling below — not itself a leak assertion)", calResult?.merged === true);

    // Floor guards against a freak sub-millisecond calibration reading producing an unrealistically tight
    // ceiling; the multiplier is the actual safety margin — 20x a REAL, same-host, same-moment, same-shape
    // measurement is a larger and better-justified margin than the old constant's 7x-against-a-different-
    // day's-683ms ever was.
    const LEAK_PROBE_CEILING_FLOOR_MS = 2_000;
    const LEAK_PROBE_CEILING_MULTIPLIER = 20;
    const leakProbeCeilingMs = Math.max(LEAK_PROBE_CEILING_FLOOR_MS, calDurationMs * LEAK_PROBE_CEILING_MULTIPLIER);
    const r2StartedAt = performance.now();
    const r2Result = await Promise.race([
      sessions.confirmWorkerMerge(r2MgrId, r2WorkerId),
      new Promise((resolve) => setTimeout(() => resolve("TIMED_OUT"), leakProbeCeilingMs)),
    ]);
    const r2DurationMs = performance.now() - r2StartedAt;
    check(`(R) a second, ordinary same-repo merge completes promptly after the injected throw — the guard did not leak (calibration=${calDurationMs.toFixed(0)}ms, ceiling=${leakProbeCeilingMs.toFixed(0)}ms, actual=${r2DurationMs.toFixed(0)}ms)`,
      r2Result !== "TIMED_OUT" && r2Result?.merged === true);
  }

  // ── (S) card c24dd48a Code Review follow-up — CONFINEMENT: a GATELESS merge must NEVER touch
  //        `activeMergeRepos` via `beginSquash`/`endSquash`. An earlier draft called them unconditionally
  //        at the shared `mergeBranch` call site, which let a gateless op (never checked by
  //        `mergeRepoFree` — it never calls `runExclusive` at all) silently free a DIFFERENT, genuinely
  //        `runExclusive`-admitted op's still-active hold via `endSquash`'s own `activeMergeRepos.delete`.
  //        Spies on both methods (not a snapshot-shape inference) to prove NEITHER is ever called for a
  //        project with no `gateCommand` configured at all.
  {
    const S = mk("s", "feature-s.txt");
    fs.mkdirSync(S.repo, { recursive: true });
    registerForCleanup(S.repo); // bare origin repo — never cleaned by the worktrees[]/LOOM_HOME sweep below
    fs.writeFileSync(path.join(S.repo, "README.md"), "# mgru-s\n");
    execSync(`git init -q && git config user.email mgru@loom && git config user.name mgru`, { cwd: S.repo });
    commitAll(S.repo, "init", GIT_ID);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});
    const { worktreePath, branch } = await createWorktree(S.repo, S.projId, S.taskId);
    S.worktreePath = worktreePath; S.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, S.file), "work for S\n");
    commitAll(worktreePath, `${S.file}`, GIT_ID);
    // config: {} (no `orchestration.gateCommand` key at all) — mirrors the already-verified gateless setup
    // in merge-confirm-stale-retry-idempotent.mjs's own `seed(B, undefined)`, rather than this file's own
    // `seed()` (which always sets the key, just to `undefined`) — belt-and-braces against any resolver
    // difference between an absent key and a key explicitly set to `undefined`.
    db.insertProject({ id: S.projId, name: "MGRU-S", repoPath: S.repo, vaultPath: S.repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: S.agentId, projectId: S.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: S.taskId, projectId: S.projId, title: "MGRU-S-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: S.mgrId, projectId: S.projId, agentId: S.agentId, engineSessionId: null, title: null, cwd: S.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: S.workerId, projectId: S.projId, agentId: S.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: S.mgrId, taskId: S.taskId, worktreePath, branch });

    let beginSquashCalls = 0, endSquashCalls = 0;
    const originalBegin = sessions.gateSemaphore.beginSquash.bind(sessions.gateSemaphore);
    const originalEnd = sessions.gateSemaphore.endSquash.bind(sessions.gateSemaphore);
    sessions.gateSemaphore.beginSquash = (rp) => { beginSquashCalls++; return originalBegin(rp); };
    sessions.gateSemaphore.endSquash = (rp) => { endSquashCalls++; return originalEnd(rp); };

    const confirm = await sessions.confirmWorkerMerge(S.mgrId, S.workerId);
    check("(S) precondition: this really was a gateless merge (gateRan is falsy, an explicit no-gate warning is present)",
      !confirm.gateRan && typeof confirm.warning === "string" && /no gateCommand/i.test(confirm.warning));
    check("(S) confirmWorkerMerge still succeeded", confirm.merged === true);
    check("(S) beginSquash was NEVER called for the gateless path", beginSquashCalls === 0);
    check("(S) endSquash was NEVER called for the gateless path", endSquashCalls === 0);

    sessions.gateSemaphore.beginSquash = originalBegin;
    sessions.gateSemaphore.endSquash = originalEnd;
  }
  // ── (T) MULTIPLE REUSE CONDITIONS FAIL SIMULTANEOUSLY — card 2e52bf99, the whole point of the card. A
  //        green, current self-check that would otherwise qualify (conditions 1-4 all pass) is followed by
  //        BOTH an uncommitted edit to the worktree (dirty — condition 5, which necessarily also flips the
  //        stamp comparison — condition 6, since the recorded stamp was clean) AND main independently
  //        advancing past what `branch` itself contains (condition 7). FIRST-FAIL-ONLY instrumentation
  //        would report just whichever of these happens to be checked first and never reveal the others —
  //        exactly the whack-a-mole trap the card's own checkpoint warns about (fix the reported cause,
  //        re-measure, and a DIFFERENT blocker the data never mentioned turns up next). This proves ALL of
  //        them land in one refusal's reasons.
  //
  //        DELIBERATELY on the preLanded path, not the ordinary one (B) uses: as (B)'s own comment above
  //        now documents (found while writing THIS test), the ordinary path's union-merge folds any main
  //        advance into the worktree BEFORE the reuse block ever runs, so `freshBehindMain` always reads 0
  //        there and condition 7 can never independently fire — only condition 6 (as
  //        "stamp-changed-by-union-merge") shows a main advance on that path. The preLanded path (mirrors
  //        (M)/(N)) skips the union-merge entirely, so main can genuinely sit ahead of what `branch`'s own
  //        ref contains at reuse-check time — the one shape where "behind-main" is independently,
  //        simultaneously true alongside a dirty worktree. It's ALSO the shape that proves the
  //        union-merge/worktree discriminator attributes correctly even when BOTH could plausibly apply:
  //        main genuinely advances here too, but since no union-merge ever ran, the stamp change must be
  //        (and is asserted to be) attributed to the worktree, not mislabeled "by-union-merge".
  {
    const T = mk("t", "feature-t.txt");
    makeRepo(T);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const { mergeBranch } = await import("../dist/git/worktrees.js");
    const { worktreePath, branch } = await createWorktree(T.repo, T.projId, T.taskId);
    T.worktreePath = worktreePath; T.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, T.file), "work for T\n");
    commitAll(worktreePath, `${T.file}`, GIT_ID);

    // Precondition: this branch's work already landed on main — worktree deliberately retained (mirrors
    // (M)/(N)'s own setup), so a LATER confirm takes the preLanded path (union-merge skipped).
    const landed = await mergeBranch(T.repo, branch, "MGRU-T initial land");
    check("(T) precondition: branch's initial work already landed in main", landed.ok === true);

    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    seed(db, T, "pnpm gate");

    // The self-check runs AFTER the land, against the worktree exactly as it sits (still on its original,
    // now-landed commit — the land touched `repoPath`, never `worktreePath`).
    const selfCheck = await sessions.runWorkerGate(T.workerId);
    check("(T) precondition: self-check settled green and current", selfCheck.settled === true && selfCheck.ok === true && selfCheck.value.passed === true && selfCheck.value.headCurrent === true);

    // Main advances AGAIN, independently of the worktree/branch — condition 7. On the preLanded path
    // nothing folds this into `branch`'s own ref, so it stays genuinely, independently true.
    fs.writeFileSync(path.join(T.repo, "main-advance-t.txt"), "a second main advance, after the land\n");
    commitAll(T.repo, "main advance t", GIT_ID);
    // AND a real uncommitted edit lands in the worktree — conditions 5 + 6.
    fs.writeFileSync(path.join(worktreePath, "uncommitted-t.txt"), "post-gate edit\n");

    const confirm = await sessions.confirmWorkerMerge(T.mgrId, T.workerId);
    check("(T) confirmWorkerMerge re-ran the gate for real (a real gate on the preLanded path, not the reuse path)", calls === 2);
    // NOT asserting confirm.gateRan here (unlike (M)/(J)/(P)) — this lands as an idempotent ALREADY_MERGED
    // no-op (no new commit on the branch beyond the earlier land), and per (N)'s own comment above, that
    // success path returns via `finishAlreadyMerged`, whose result never carries `gateRan` at all.
    // `calls === 2` is this scenario's own proof a real gate ran, exactly as (N) already establishes.
    check("(T) reusedOpId is absent", confirm.reusedOpId === undefined);

    const buildGateT = eventsOfKind(db, T.mgrId, "build_gate")[0];
    const reasonsT = buildGateT?.detail?.reuseRefusalReasons;
    check("(T) reuseRefusalReasons is an array", Array.isArray(reasonsT));
    check("(T) reuseRefusalReasons includes worktree-dirty", Array.isArray(reasonsT) && reasonsT.includes("worktree-dirty"));
    // "stamp-changed-worktree", NOT "stamp-changed-by-union-merge" — the discriminator's own correctness
    // check: no union-merge ran on this (preLanded) path, so even though main ALSO genuinely advanced in
    // this same scenario, the stamp change must be attributed to the worktree, never mislabeled.
    check("(T) reuseRefusalReasons includes stamp-changed-worktree (correctly attributed — no union-merge ran on this path)", Array.isArray(reasonsT) && reasonsT.includes("stamp-changed-worktree"));
    check("(T) reuseRefusalReasons does NOT include stamp-changed-by-union-merge", Array.isArray(reasonsT) && !reasonsT.includes("stamp-changed-by-union-merge"));
    check("(T) reuseRefusalReasons includes behind-main", Array.isArray(reasonsT) && reasonsT.includes("behind-main"));
    // THE DISCRIMINATING ASSERTION: a first-fail-only implementation would report exactly ONE of the three
    // above (whichever the check order visits first) and never the other two — this proves ALL THREE
    // survived into one refusal's reasons, not just the first hit.
    check("(T) all THREE independently-true conditions are recorded together, not just the first (first-fail-only would fail this)", Array.isArray(reasonsT) && reasonsT.length === 3);
    // And nothing from the UNAFFECTED conditions (1-4, and the resolve-failure variants of 7) leaks in —
    // lastCheck genuinely existed/matched/passed/was current, and main's HEAD resolved cleanly.
    check("(T) no conditions 1-4 or unrelated tokens present (only the 3 genuinely-failing ones)",
      Array.isArray(reasonsT) && !reasonsT.some((r) => ["no-last-check", "branch-mismatch", "last-check-failed", "head-not-current", "main-head-unresolved", "behind-main-unknown", "worktree-dirty-unknown", "stamp-unknown", "stamp-changed-by-union-merge"].includes(r)));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — two genuinely concurrent same-repo merges both land, the second on its first pass, with the per-repo admission guard held across the first merge's own squash (Q); a throw between gate-settle and beginSquash never leaks that guard (R); beginSquash/endSquash are confined to gateRan, never touched by a gateless merge (S); and multiple independent reuse-refusal conditions failing at once are all recorded together, correctly attributed (T). See merge-gate-reuse.mjs for the core reuse-decision and race-window scenarios, and merge-gate-reuse-admission.mjs for the preLanded discriminating pair and the admission-time re-union scenarios."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
