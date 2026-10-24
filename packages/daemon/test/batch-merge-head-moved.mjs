import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 043d83d2 — the batch worktree's own HEAD (<main>/.git/worktrees/<batch>/HEAD) lives in the shared,
// worker-writable .git. `runBatchedMerge` used to read `batchHeadSha` via a plain `git rev-parse HEAD` in
// the batch worktree AFTER `gate.passed`, with nothing comparing it against what the gate actually
// validated — a worker that moved that ref during the gate/queue window got an UNGATED descendant commit
// fast-forwarded onto canonical main. See docs/decisions/043d83d2-*.md for the full investigation,
// repro, and fix.
//
// THE FIX: `assembleBatchBranches` now tracks `assembledTipSha` from its OWN landing results (never a
// late re-read); `runBatchedMerge` cross-checks it once immediately after assembly (before the gate even
// runs) and once more right after the gate passes (before any fast-forward) via
// `computeWorktreeGateStamp`/`gateStampsDiffer` — a mismatch refuses with a distinct `batchHeadMoved`
// outcome, wired exactly like `branchDiverted`/`quarantined` (no per-candidate fallback, never cached).
// `sessions/service.ts`'s batch `runGate` closure also now resolves `computeEmitCompareGate` against this
// SAME pinned sha, never the literal string `"HEAD"` (mirrors decision 56c10535 on the solo path).
//
// (A) REAL `mergeBatchTracked`, a HEAD swap fired FROM INSIDE the injected `runGate` seam (mirrors
//     batch-merge-branch-diverted-no-fallback.mjs's own `divertOnGate` pattern exactly) — simulating a
//     sibling worker overwriting the batch worktree's private HEAD file while the batch's real gate
//     command would have been running:
//   (1) the swap fires, the (fake) gate reports green, `runBatchedMerge`'s POST-gate stamp check catches
//       the mismatch and refuses — `result.batchHeadMoved === true`.
//   (2) NO per-candidate fallback ran: every candidate reports `started:false`, and neither worker's
//       branch carries a squash commit.
//   (3) canonical mainline's OWN ref is untouched — still at the pre-batch sha (the attacker's commit,
//       reachable from base, was NOT fast-forwarded onto main).
//   (4) a durable `batch_merge_head_moved` event was filed.
//
// (B) THE CONTRACT `computeEmitCompareGate` itself relies on (card 56c10535's pattern, mirrored here):
//     resolving the literal string `"HEAD"` at call time picks up whatever a worker-writable ref
//     currently says, so a worker that plants a tiny-diff decoy commit and points HEAD at it gets
//     misclassified as gate-reduction-eligible — even though the REAL assembled tip (passed as a resolved
//     sha, immune to what HEAD points to) carries a real, non-reducible source change. This is a DIRECT,
//     deterministic proof of the mechanism the fix relies on (never re-resolve "HEAD"), independent of the
//     full service.ts plumbing, which (A) above already exercises end-to-end.
//
// CODE REVIEW FOLLOW-UP (same card, second review):
// (A2) N1 — the POST-gate FILES-ONLY leg: a tracked-file edit during the gate, HEAD itself untouched.
// (D)  N1 — the PRE-gate leg: a HEAD swap fired BETWEEN assembly finishing and `runGate` ever being
//      called — `runGate` must never be invoked at all for this one.
// (E)  S1 — a `reset --hard` fired BETWEEN two candidates: `landBranchCommitsIndividually`'s own
//      per-candidate `expectedHeadBefore` chain check catches it, not the pre-/post-gate stamp checks.
// (F)  S2 — a dirty batch worktree (uncommitted edit, HEAD untouched) BEFORE the gate even runs.
//
// THIRD CODE REVIEW (same card):
// (G)  B1/S3 — PRE-ASSEMBLY head move via REAL mergeBatchTracked, asserting the settled gate_status row
//      carries skipReason "batch-head-moved" — never "all-candidates-dropped" (onSettle's own ordering).
// (H)  S3 — FIRST-CANDIDATE head move via REAL mergeBatchTracked (the top-of-assembly check passes
//      cleanly; the per-candidate chain check catches it instead), same gate_status assertion as (G).
// (I)  S2 — the initial `rev-parse HEAD` READ ITSELF fails: "could not read" wording, never "tampered".
//
// FOURTH CODE REVIEW (same card, item 3):
// (J)  S1 — main advances BETWEEN baseMainSha's resolve and the worktree cut (an ORDINARY race, not a
//      tamper): with `forkFrom: baseMainSha`, this must FORFEIT at fast-forward time, never
//      misreport as batchHeadMoved.
//
// CARD 95940402 (named OPEN RESIDUAL in 043d83d2's own third Code Review — see its decision record's
// "OPEN RESIDUAL" paragraph): every check above only ever compares the batch worktree's REF to another
// ref/stamp — none of them verify a landed COMMIT's own identity. A racer who substitutes a commit with
// the SAME TREE as the real landing but a DIFFERENT PARENT (or message/trailers) right after a
// candidate's own `git commit` would pass every (D)-(J) check above (they never inspect the commit
// object itself), and would have become this candidate's own pin — carrying whatever `Loom-Worker-Branch:`
// trailer the forger planted, read by hold-release/ALREADY_MERGED detection as if it were genuine.
// (K)  the FIX: `landBranchCommitsIndividually` now verifies each landing commit's parent+tree (the SAME
//      `verifyCommitParentAndTree` mechanism the solo squash path's `2a6a292a` round-21
//      `verifyLandedAsOwnCommit` already uses, extracted to a shared, exported function rather than
//      duplicated) before trusting it, both right after the plain `git commit` and again at the final
//      post-loop HEAD read — refusing `batchHeadMoved` on a mismatch, same as every check above.
//
// CODE REVIEW of 95940402 (4933cb39): (K)'s parent+tree check alone does NOT catch a SAME-PARENT,
// SAME-TREE substitute whose MESSAGE carries a forged `Loom-Worker-Branch:` trailer — reproduced live
// against commit 2b5a9ebf (ok:true, canonical main landed the forged trailer) via `commit-tree -p <real
// parent>` right after the plain commit, and again right after the pathset `--amend`. THE FIX (round 2):
// `verifyCommitParentAndTree` now also returns the raw commit body; the batch path additionally verifies
// a non-tip commit carries NO `Loom-Worker-*` trailer at all, and the tip's trailer names THIS branch and
// carries the Base/PathSet THIS process actually computed (or neither, matching `pathSetStamped`) — never
// merely "a trailer is present". Residual, honestly named (inherited from 2a6a292a round 22/23, same as
// before): a commit with the CORRECT parent, tree, AND trailers, differing only in an unrelated part of
// the SUBJECT line or author identity, is still unverified — this round closes the Loom trailer forgery
// specifically, not every conceivable message forgery.
// (K2) the plain-commit hook AND the pathset-amend hook, each substituting a same-parent/same-tree,
//      forged-trailer commit — the amend leg on the TIP, the plain-commit leg on a NON-TIP commit of a
//      multi-commit branch (the tip's own plain-commit leg is accidentally neutralized by the subsequent
//      amend overwriting its message, so a non-tip commit is the one that actually exercises this path).
// (L)  S2 — `merge-base`/the noop leg's `findLandedSquashCommit` used to resolve the literal "HEAD" at
//      call time instead of the already-pinned `batchHeadBefore`; a HEAD swap in that narrow window could
//      misclassify a genuinely new candidate as already-landed (noop), silently skipping its real commit.
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-head-moved.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-bmhm-home-");

// Card 043d83d2 Code Review (B1): `_emit-compare-fixtures.mjs` has its OWN top-level `await
// import("../dist/git/worktrees.js")` (to derive GUARD_BASENAMES from the real STATIC_GUARD_REPO_PATHS) —
// a STATIC import of it here would be hoisted and evaluated before the LOOM_HOME line above ever runs,
// letting that transitive import lock paths.js's module-level WORKTREES_DIR/DB_PATH to the real ~/.loom
// before this file's own override takes effect. Importing it dynamically, after LOOM_HOME is set, keeps
// this file's own env setup ahead of anything that reads it (same fix as merge-confirm-reduced-gate-note.mjs).
const { writeRealTestDaemonScript, mkdirp } = await import("./_emit-compare-fixtures.mjs");

requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, computeEmitCompareGate } = await import("../dist/git/worktrees.js");
const { runBatchedMerge, assembleBatchBranches } = await import("../dist/git/batch-merge.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmhm", GIT_AUTHOR_EMAIL: "bmhm@loom", GIT_COMMITTER_NAME: "bmhm", GIT_COMMITTER_EMAIL: "bmhm@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bmhm@loom -c user.name=bmhm";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

const P = { projId: `bmhm-proj-${sfx}`, agentId: `bmhm-agent-${sfx}`, mgrId: `bmhm-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bmhm-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# bmhm\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "bmhm@loom"); git(P.repo, "config", "user.name", "bmhm");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const MAINREF = `refs/heads/${MAIN}`;
const canonHead = () => git(P.repo, "rev-parse", "HEAD");
const baseSha = canonHead();

/** One "daemon": a Db + a SessionService whose `runGate` seam swaps the BATCH WORKTREE's own HEAD
 *  (the `cwd` this seam is invoked with — mirrors `runGateSequential`'s real `(gate, cwd, timeoutMs, ...)`
 *  signature) BEFORE reporting green — simulating a sibling worker overwriting that worker-writable ref
 *  while the batch's real gate command would have been running. `batchFfGitFactory` (optional, second
 *  Code Review) is the SAME constructor seam `merge-batch-all-dropped-gate-status.mjs` uses — for a
 *  tamper that must fire BEFORE/DURING assembly, strictly earlier than `runGate` is ever invoked. */
function boot(swapOnGate, batchFfGitFactory) {
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, gateOpRetainMs: 0, reapWorktreeProcesses: noReap,
    runGate: async (_gate, cwd) => {
      if (swapOnGate) await swapOnGate(cwd);
      return { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };
    },
    ...(batchFfGitFactory ? { batchFfGitFactory } : {}),
  });
  const events = [];
  const nudges = [];
  const orig = sessions.enqueueDurableMessage.bind(sessions);
  sessions.enqueueDurableMessage = (target, text, ...rest) => { nudges.push(String(text)); return orig(target, text, ...rest); };
  return { db, sessions, events, nudges };
}

async function addWorker(db, tag) {
  const taskId = `bmhm-${tag}-task-${sfx}`, workerId = `bmhm-${tag}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `${tag}\n`);
  commitAll(worktreePath, `feat(x): change ${tag}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}

/** The batch worktree's own private HEAD file path, inside the shared .git admin area — exactly the file
 *  card 043d83d2 names (`<main>/.git/worktrees/<batch>/HEAD`). */
function batchHeadFilePath(batchWorktreePath) {
  const rel = execSync("git rev-parse --git-path HEAD", { cwd: batchWorktreePath }).toString().trim();
  return path.isAbsolute(rel) ? rel : path.join(batchWorktreePath, rel);
}

try {
  // ── (A) REAL mergeBatchTracked — a mid-gate HEAD swap refuses as batchHeadMoved, nothing lands ────────
  {
    // The attacker's own branch: cut from the SAME base, never a batch candidate, never gated — content
    // that must NOT reach canonical main under any outcome of this scenario.
    const attackerWt = (await createWorktree(P.repo, P.projId, `bmhm-attacker-${sfx}`)).worktreePath;
    registerForCleanup(attackerWt);
    fs.writeFileSync(path.join(attackerWt, "UNGATED-PAYLOAD.txt"), "never gated\n");
    commitAll(attackerWt, "attacker: ungated payload", GIT_ID);
    const attackerSha = git(attackerWt, "rev-parse", "HEAD");

    let batchWt;
    const d = boot(async (cwd) => {
      batchWt = cwd;
      fs.writeFileSync(batchHeadFilePath(cwd), `${attackerSha}\n`);
    });
    d.db.insertProject({ id: P.projId, name: "BMHM", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    d.db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
    d.db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const w1 = await addWorker(d.db, "a"), w2 = await addWorker(d.db, "b");

    check("(A) precondition: canonical is on mainline before the batch", git(P.repo, "rev-parse", "--abbrev-ref", "HEAD") === MAIN && canonHead() === baseSha);
    const r = await awaitTrackedSettle(() => d.sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked", timeoutMs: 240_000, pendingOps: d.sessions.pendingOps });
    const value = r.ok ? r.value : { __unsettled: r };

    check("(A1) the batch refuses, typed batchHeadMoved (never a bare !ok)", value.ok === false && value.batchHeadMoved === true);
    check("(A1) reason names the tamper", /HEAD|tampered/i.test(value.reason ?? ""));
    check("(A2) NO per-candidate fallback was started — every candidate reports started:false", Array.isArray(value.fallback) && value.fallback.length === 2 && value.fallback.every((f) => f.started === false));
    check("(A2) neither worker's branch carries a squash commit (no solo worker_merge_confirm ran)", git(P.repo, "log", "-1", "--format=%s", w1.branch) === "feat(x): change a" && git(P.repo, "log", "-1", "--format=%s", w2.branch) === "feat(x): change b");
    check("(A2) neither worker's task moved off in_progress", d.db.getTask(w1.taskId)?.columnKey === "in_progress" && d.db.getTask(w2.taskId)?.columnKey === "in_progress");
    check("(A3) THE HOLE WOULD BE: canonical mainline's OWN ref is untouched — never advanced to the attacker's ungated sha", git(P.repo, "rev-parse", MAINREF) === baseSha && git(P.repo, "rev-parse", MAINREF) !== attackerSha);

    const movedEvents = d.db.listEventsSince(0, 100000).filter((e) => e.kind === "batch_merge_head_moved" && e.detail?.projectId === P.projId);
    check("(A4) exactly ONE durable batch_merge_head_moved event", movedEvents.length === 1);

    check("(A) sanity: the swap actually targeted the BATCH worktree, not canonical", typeof batchWt === "string" && batchWt !== P.repo);
    d.db.close();
  }

  // ── (A2) REAL mergeBatchTracked — a TRACKED FILE EDIT during the gate (HEAD unchanged) also refuses ────
  //     N1: the POST-gate files-only leg of `gateStampsDiffer` (card 975c774b's dirty-worktree shape,
  //     ported to the batch path by this card) — distinct from (A) above, which moves HEAD itself.
  {
    // Reuses the SAME on-disk db file (A) already seeded — `new Db()` opens the same LOOM_HOME sqlite
    // file, so the project/agent/manager rows (A) inserted are already there; inserting them again would
    // hit the UNIQUE constraint on `projects.id`/`sessions.id`.
    const d2 = boot(async (cwd) => {
      fs.appendFileSync(path.join(cwd, "c.txt"), "tampered\n");
    });
    const w1b = await addWorker(d2.db, "c"), w2b = await addWorker(d2.db, "d");

    const headBefore = canonHead();
    const r2 = await awaitTrackedSettle(() => d2.sessions.mergeBatchTracked(P.mgrId, [w1b.workerId, w2b.workerId]), { label: "mergeBatchTracked (A2)", timeoutMs: 240_000, pendingOps: d2.sessions.pendingOps });
    const value2 = r2.ok ? r2.value : { __unsettled: r2 };

    check("(A2) the batch refuses, typed batchHeadMoved (files-only leg, HEAD unchanged)", value2.ok === false && value2.batchHeadMoved === true);
    check("(A2) reason names the tamper/uncommitted state", /uncommitted|tampered|HEAD/i.test(value2.reason ?? ""));
    check("(A2) NO per-candidate fallback was started", Array.isArray(value2.fallback) && value2.fallback.length === 2 && value2.fallback.every((f) => f.started === false));
    check("(A2) canonical mainline untouched", canonHead() === headBefore);
    d2.db.close();
  }

  // ── (G) B1/S3 — PRE-ASSEMBLY head move via REAL mergeBatchTracked: the top-of-assembly cut-point
  //     check, asserting the SETTLED gate_status row carries skipReason "batch-head-moved" — never
  //     "all-candidates-dropped" (record 0d372516's Do-not (2), the exact ordering mistake the second
  //     Code Review found: `batchAllDropped` used to be checked BEFORE `batchHeadMoved` in onSettle).
  {
    const attackerWt = (await createWorktree(P.repo, P.projId, `bmhm-g-attacker-${sfx}`)).worktreePath;
    registerForCleanup(attackerWt);
    fs.writeFileSync(path.join(attackerWt, "UNGATED-G.txt"), "never gated\n");
    commitAll(attackerWt, "attacker: pre-assembly payload", GIT_ID);
    const attackerSha = git(attackerWt, "rev-parse", "HEAD");

    let swapped = false;
    function preAssemblyFactory(repoPath, timeoutMs) {
      const real = boundedSimpleGit(repoPath, timeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (!swapped && repoPath !== P.repo) {
            swapped = true;
            fs.writeFileSync(batchHeadFilePath(repoPath), `${attackerSha}\n`);
          }
          return real.raw(args);
        },
      };
    }
    const d3 = boot(undefined, preAssemblyFactory);
    const w1g = await addWorker(d3.db, "g1"), w2g = await addWorker(d3.db, "g2");

    const headBefore = canonHead();
    const r3 = await awaitTrackedSettle(() => d3.sessions.mergeBatchTracked(P.mgrId, [w1g.workerId, w2g.workerId]), { label: "mergeBatchTracked (G)", timeoutMs: 240_000, pendingOps: d3.sessions.pendingOps });
    const value3 = r3.ok ? r3.value : { __unsettled: r3 };

    check("(G) precondition: the pre-assembly swap actually fired", swapped === true);
    check("(G) the batch refuses, typed batchHeadMoved", value3.ok === false && value3.batchHeadMoved === true);
    check("(G) NO per-candidate fallback was started", Array.isArray(value3.fallback) && value3.fallback.length === 2 && value3.fallback.every((f) => f.started === false));
    check("(G) canonical mainline untouched", canonHead() === headBefore);
    check("(G) precondition: opId is a string", typeof value3.opId === "string");
    const gsG = d3.sessions.gateStatus(value3.opId);
    check("(G) gate_status settled with a real no-gate-ran verdict", gsG.state === "settled" && gsG.outcome === "skipped" && gsG.passed === false);
    check("(G) gate_status skipReason is EXACTLY batch-head-moved (B1: never all-candidates-dropped)", gsG.skipReason === "batch-head-moved");
    check("(G) gate_status batchBranchCount:0 / batchLanded:false", gsG.batchBranchCount === 0 && gsG.batchLanded === false);
    d3.db.close();
  }

  // ── (H) S3 — FIRST-CANDIDATE head move via REAL mergeBatchTracked: the top-of-assembly check passes
  //     cleanly (the tamper fires AFTER it), so this exercises landBranchCommitsIndividually's own
  //     per-candidate `expectedHeadBefore` chain check instead — through the full service + gate_status
  //     path, not the direct runBatchedMerge unit call (E) already covers.
  {
    const attackerWt = (await createWorktree(P.repo, P.projId, `bmhm-h-attacker-${sfx}`)).worktreePath;
    registerForCleanup(attackerWt);
    fs.writeFileSync(path.join(attackerWt, "UNGATED-H.txt"), "never gated\n");
    commitAll(attackerWt, "attacker: first-candidate payload", GIT_ID);
    const attackerSha = git(attackerWt, "rev-parse", "HEAD");

    let nonCanonicalCalls = 0;
    let swapped = false;
    function firstCandidateFactory(repoPath, timeoutMs) {
      const real = boundedSimpleGit(repoPath, timeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (repoPath !== P.repo) {
            nonCanonicalCalls++;
            if (!swapped && nonCanonicalCalls >= 2) {
              swapped = true;
              fs.writeFileSync(batchHeadFilePath(repoPath), `${attackerSha}\n`);
            }
          }
          return real.raw(args);
        },
      };
    }
    const d4 = boot(undefined, firstCandidateFactory);
    const w1h = await addWorker(d4.db, "h1"), w2h = await addWorker(d4.db, "h2");

    const headBefore = canonHead();
    const r4 = await awaitTrackedSettle(() => d4.sessions.mergeBatchTracked(P.mgrId, [w1h.workerId, w2h.workerId]), { label: "mergeBatchTracked (H)", timeoutMs: 240_000, pendingOps: d4.sessions.pendingOps });
    const value4 = r4.ok ? r4.value : { __unsettled: r4 };

    check("(H) precondition: the first-candidate swap actually fired", swapped === true);
    check("(H) the batch refuses, typed batchHeadMoved", value4.ok === false && value4.batchHeadMoved === true);
    check("(H) NO per-candidate fallback was started", Array.isArray(value4.fallback) && value4.fallback.length === 2 && value4.fallback.every((f) => f.started === false));
    check("(H) canonical mainline untouched", canonHead() === headBefore);
    check("(H) precondition: opId is a string", typeof value4.opId === "string");
    const gsH = d4.sessions.gateStatus(value4.opId);
    check("(H) gate_status settled skipped, skipReason batch-head-moved", gsH.state === "settled" && gsH.outcome === "skipped" && gsH.skipReason === "batch-head-moved" && gsH.passed === false);
    d4.db.close();
  }

  // ── (B) computeEmitCompareGate's OWN contract: a resolved sha is immune to what HEAD points to ───────
  {
    // A SEPARATE, self-contained fixture repo (not P.repo) — needs its own real, self-resolving copy of
    // scripts/test-daemon.mjs (so foldInTestImporters/loadHarnessSetExports can genuinely resolve, not
    // fail closed on a missing file) plus a minimal tsconfig chain, mirroring
    // _emit-compare-fixtures.mjs's own makeRepoWithBaseSrcFile — see that helper's doc for why both are
    // needed for a `.ts` scenario to fail closed for the RIGHT reason, not a missing fixture.
    const wt = path.join(os.tmpdir(), `loom-bmhm-ecg-${sfx}`);
    fs.mkdirSync(wt, { recursive: true });
    registerForCleanup(wt);
    fs.writeFileSync(path.join(wt, "README.md"), "# bmhm-ecg\n");
    fs.writeFileSync(path.join(wt, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { target: "ES2022" } }));
    mkdirp(path.join(wt, "packages", "daemon", "src"));
    fs.writeFileSync(path.join(wt, "packages", "daemon", "tsconfig.json"), JSON.stringify({ extends: "../../tsconfig.base.json", compilerOptions: { outDir: "dist", rootDir: "src", types: ["node"] } }));
    writeRealTestDaemonScript(wt);
    git(wt, "init", "-q"); git(wt, "config", "core.autocrlf", "false"); git(wt, "config", "user.email", "bmhm@loom"); git(wt, "config", "user.name", "bmhm");
    commitAll(wt, "init", GIT_ID);
    const ecgBaseSha = git(wt, "rev-parse", "HEAD");

    // REAL, non-reducible content: a BRAND NEW compiled daemon source file (status "A", under
    // EMIT_COMPARE_SRC_PREFIX) — the batch's own assembled tip must never be classified as
    // gate-reduction-eligible.
    fs.writeFileSync(path.join(wt, "packages", "daemon", "src", "bmhm-fixture.ts"), "export const bmhmFixture = 1;\n");
    commitAll(wt, "feat(daemon): add bmhm-fixture", GIT_ID);
    const realAssembledTipSha = git(wt, "rev-parse", "HEAD");

    // The decoy: a SEPARATE commit, also built on `ecgBaseSha`, touching ONLY a new top-level test file —
    // the shape `computeEmitCompareGate` classifies as reduction-eligible.
    git(wt, "checkout", "-q", ecgBaseSha);
    fs.writeFileSync(path.join(wt, "packages", "daemon", "test", "bmhm-decoy-test.mjs"), "console.log(\"decoy\");\n");
    commitAll(wt, "test(daemon): add bmhm-decoy-test (decoy)", GIT_ID);
    const decoySha = git(wt, "rev-parse", "HEAD");
    // Point the worktree's HEAD AT the decoy — exactly what a worker-writable ref swap would produce.
    git(wt, "checkout", "-q", decoySha);
    check("(B) precondition: the worktree's live HEAD is the decoy, not the real assembled tip", git(wt, "rev-parse", "HEAD") === decoySha && decoySha !== realAssembledTipSha);

    const viaBareHead = await computeEmitCompareGate(wt, ecgBaseSha, "HEAD");
    const viaPinnedSha = await computeEmitCompareGate(wt, ecgBaseSha, realAssembledTipSha);

    check("(B1) THE HOLE: resolving the literal \"HEAD\" (steerable) misclassifies the decoy as reduction-eligible", viaBareHead.eligible === true);
    check("(B2) THE FIX: resolving the PINNED sha (immune to what HEAD points to) correctly classifies the real, non-reducible tip", viaPinnedSha.eligible === false);
    check("(B) sanity: the two calls really did classify DIFFERENT diffs (not a vacuous pass)", viaBareHead.eligible !== viaPinnedSha.eligible);
  }

  // ── (D) N1: PRE-gate HEAD swap — a tamper fired BETWEEN assembly finishing and `runGate` ever being ────
  //     invoked. Direct `runBatchedMerge` (no SessionService/Db needed): a `gitFactory` hooks the SAME
  //     `git merge-tree` call `landedTreeDivergesFromExpected` makes right after the one candidate's own
  //     landing commit is read (so the tracked `assembledTipSha` is already the LEGIT sha before the swap
  //     fires) — mirrors `batch-merge-robustness.mjs`'s own "delegate to real git, hook one specific call"
  //     shape. The swap lands BEFORE `runBatchedMerge`'s own pre-gate stamp check, which must refuse WITHOUT
  //     ever calling `runGate` — proving this is the pre-gate leg, not the post-gate one (A) above exercises.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-pregate-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-pregate\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-pg-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "d1.txt"), "d1\n");
    commitAll(candWt, "feat(x): change d1", GIT_ID);

    const attackerWt = (await createWorktree(repo, P.projId, `bmhm-pg-attacker-${sfx}`)).worktreePath;
    registerForCleanup(attackerWt);
    fs.writeFileSync(path.join(attackerWt, "UNGATED-PREGATE.txt"), "never gated\n");
    commitAll(attackerWt, "attacker: pregate payload", GIT_ID);
    const attackerSha = git(attackerWt, "rev-parse", "HEAD");

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-pg-batch-${sfx}`);
    registerForCleanup(batchWt);

    let gateInvoked = false;
    let swapped = false;
    function preGateSwapFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const out = await real.raw(args);
          if (!swapped && Array.isArray(args) && args[0] === "merge-tree") {
            swapped = true;
            fs.writeFileSync(batchHeadFilePath(batchWt), `${attackerSha}\n`);
          }
          return out;
        },
      };
    }
    const passGate = async () => { gateInvoked = true; return { passed: true }; };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-pg-w1", taskId: "bmhm-pg-t1", branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: preGateSwapFactory });

    check("(D) precondition: the swap actually fired", swapped === true);
    check("(D) the batch refuses, typed batchHeadMoved", result.ok === false && result.batchHeadMoved === true);
    check("(D) reason names the tamper", /HEAD|tampered/i.test(result.reason ?? ""));
    check("(D) the gate was NEVER invoked — this is the PRE-gate leg, not the post-gate one (A) exercises", gateInvoked === false);
    check("(D) canonical main untouched", git(repo, "rev-parse", "HEAD") === baseMainSha);
  }

  // ── (E) S1: a `reset --hard` fired BETWEEN two candidates lands the second one onto an unreviewed base ─
  //     unless caught. Same `merge-tree` hook as (D), but this time the side effect is a REAL `reset
  //     --hard` to the attacker's sha (simulating a sibling worker moving the batch's own branch between
  //     two candidates) rather than a bare HEAD-file overwrite — exercising `landBranchCommitsIndividually`'s
  //     own per-candidate `expectedHeadBefore` chain check, not the pre-/post-gate stamp checks (D)/(A).
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-resetbetween-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-resetbetween\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: wt1, branch: branch1 } = await createWorktree(repo, P.projId, `bmhm-rb-c1-${sfx}`);
    registerForCleanup(wt1);
    fs.writeFileSync(path.join(wt1, "e1.txt"), "e1\n");
    commitAll(wt1, "feat(x): change e1", GIT_ID);

    const { worktreePath: wt2, branch: branch2 } = await createWorktree(repo, P.projId, `bmhm-rb-c2-${sfx}`);
    registerForCleanup(wt2);
    fs.writeFileSync(path.join(wt2, "e2.txt"), "e2\n");
    commitAll(wt2, "feat(x): change e2", GIT_ID);

    const attackerWt = (await createWorktree(repo, P.projId, `bmhm-rb-attacker-${sfx}`)).worktreePath;
    registerForCleanup(attackerWt);
    fs.writeFileSync(path.join(attackerWt, "UNGATED-RESET.txt"), "never gated\n");
    commitAll(attackerWt, "attacker: reset-between payload", GIT_ID);
    const attackerSha = git(attackerWt, "rev-parse", "HEAD");

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-rb-batch-${sfx}`);
    registerForCleanup(batchWt);

    let gateInvoked = false;
    let resetFired = false;
    function resetBetweenFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const out = await real.raw(args);
          if (!resetFired && Array.isArray(args) && args[0] === "merge-tree") {
            resetFired = true;
            await real.raw(["reset", "--hard", attackerSha]);
          }
          return out;
        },
      };
    }
    const passGate = async () => { gateInvoked = true; return { passed: true }; };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-rb-w1", taskId: "bmhm-rb-t1", branch: branch1, cutBaseSha: null },
      { workerSessionId: "bmhm-rb-w2", taskId: "bmhm-rb-t2", branch: branch2, cutBaseSha: null },
    ], passGate, { gitFactory: resetBetweenFactory });

    check("(E) precondition: the reset actually fired", resetFired === true);
    check("(E) the batch refuses, typed batchHeadMoved", result.ok === false && result.batchHeadMoved === true);
    check("(E) exactly one candidate landed (before the reset) — the second is NEVER reported as a per-candidate drop (NIT fix: a worker-writable-ref fact, not that candidate's own content)", result.landed.length === 1 && result.dropped.length === 0);
    check("(E) the top-level reason names the tamper (not a per-candidate dropped[] entry)", /HEAD|tampered/i.test(result.reason ?? ""));
    check("(E) the gate was NEVER invoked", gateInvoked === false);
    check("(E) canonical main untouched", git(repo, "rev-parse", "HEAD") === baseMainSha);
  }

  // ── (F) S2: a dirty batch worktree (uncommitted tracked-file edit, HEAD untouched) BEFORE the gate ──────
  //     even runs — mirrors the solo path's own `captureGatedTip` pre-gate dirty refusal. Same `merge-tree`
  //     hook as (D)/(E), this time the side effect edits a tracked file without committing.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-dirtygate-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-dirtygate\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: wt1, branch: branch1 } = await createWorktree(repo, P.projId, `bmhm-dg-c1-${sfx}`);
    registerForCleanup(wt1);
    fs.writeFileSync(path.join(wt1, "f1.txt"), "f1\n");
    commitAll(wt1, "feat(x): change f1", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-dg-batch-${sfx}`);
    registerForCleanup(batchWt);

    let gateInvoked = false;
    let dirtied = false;
    function dirtyBeforeGateFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const out = await real.raw(args);
          if (!dirtied && Array.isArray(args) && args[0] === "merge-tree") {
            dirtied = true;
            fs.writeFileSync(path.join(batchWt, "f1.txt"), "tampered\n");
          }
          return out;
        },
      };
    }
    const passGate = async () => { gateInvoked = true; return { passed: true }; };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-dg-w1", taskId: "bmhm-dg-t1", branch: branch1, cutBaseSha: null },
    ], passGate, { gitFactory: dirtyBeforeGateFactory });

    check("(F) precondition: the dirty edit actually fired", dirtied === true);
    check("(F) the batch refuses, typed batchHeadMoved", result.ok === false && result.batchHeadMoved === true);
    check("(F) reason names the uncommitted/tamper state", /uncommitted|tampered/i.test(result.reason ?? ""));
    check("(F) the gate was NEVER invoked — this is the PRE-gate dirty leg, not the post-gate one (A2) exercises", gateInvoked === false);
    check("(F) canonical main untouched", git(repo, "rev-parse", "HEAD") === baseMainSha);
  }

  // ── (I) S2: the initial `rev-parse HEAD` READ ITSELF fails (a transient git error), distinct from a
  //     genuine mismatch (D) — refuses with "could not read" wording, NEVER "tampered" (a weaker, wrong
  //     claim for a read failure); same no-fallback/no-gate-invoked treatment as (D).
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-unreadable-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-unreadable\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-i-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "i1.txt"), "i1\n");
    commitAll(candWt, "feat(x): change i1", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-i-batch-${sfx}`);
    registerForCleanup(batchWt);

    let gateInvoked = false;
    let failedOnce = false;
    function unreadableHeadFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (!failedOnce && Array.isArray(args) && args[0] === "rev-parse" && args[1] === "HEAD") {
            failedOnce = true;
            throw new Error("simulated transient git failure (initial HEAD read)");
          }
          return real.raw(args);
        },
      };
    }
    const passGate = async () => { gateInvoked = true; return { passed: true }; };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-i-w1", taskId: "bmhm-i-t1", branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: unreadableHeadFactory });

    check("(I) precondition: the initial HEAD read actually failed once", failedOnce === true);
    check("(I) the batch refuses, typed batchHeadMoved", result.ok === false && result.batchHeadMoved === true);
    check("(I) reason says 'could not read', never 'tampered'", /could not read/i.test(result.reason ?? "") && !/tampered/i.test(result.reason ?? ""));
    check("(I) the gate was NEVER invoked", gateInvoked === false);
    check("(I) canonical main untouched", git(repo, "rev-parse", "HEAD") === baseMainSha);
  }

  // ── (J) S1: an ORDINARY race (main advances BETWEEN baseMainSha's resolve and the worktree cut) must
  //     FORFEIT, never misreport as batchHeadMoved. Cutting the batch worktree with `forkFrom:
  //     baseMainSha` (mirrors sessions/service.ts's own call) roots it at the OLD sha regardless of
  //     what canonical becomes in the meantime — the top-of-assembly check sees a clean match (no false
  //     tamper alarm) and the gate runs; the advance is caught LATER, at fast-forward time, as the
  //     existing (pre-card) forfeit check, which already falls back to per-candidate gating.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-forfeit-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-forfeit\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-j-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "j1.txt"), "j1\n");
    commitAll(candWt, "feat(x): change j1", GIT_ID);

    // THE RACE: something else lands on canonical main AFTER baseMainSha was resolved but BEFORE the
    // batch worktree is cut below — an ORDINARY advance (a solo landing, a human commit), never a tamper.
    fs.writeFileSync(path.join(repo, "advanced.txt"), "advanced\n");
    commitAll(repo, "chore(test): main advances during the cut race", GIT_ID);
    const advancedSha = git(repo, "rev-parse", "HEAD");
    check("(J) precondition: main genuinely advanced past baseMainSha", advancedSha !== baseMainSha);

    // THE FIX (S1): cut FROM baseMainSha explicitly — never canonical's now-advanced live HEAD.
    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-j-batch-${sfx}`, {}, undefined, baseMainSha);
    registerForCleanup(batchWt);
    check("(J) precondition: the batch worktree's own HEAD is baseMainSha, NOT the advanced main", git(batchWt, "rev-parse", "HEAD") === baseMainSha);

    let gateInvoked = false;
    const passGate = async () => { gateInvoked = true; return { passed: true }; };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-j-w1", taskId: "bmhm-j-t1", branch: candBranch, cutBaseSha: null },
    ], passGate);

    check("(J) the gate WAS invoked — no false pre-gate tamper alarm", gateInvoked === true);
    check("(J) the batch FORFEITS — main moved between the cut and the fast-forward", result.ok === false && result.forfeited === true);
    check("(J) NEVER misreported as batchHeadMoved", result.batchHeadMoved !== true);
    check("(J) canonical main is still at the advanced sha (a forfeit refuses the ff; it never reverts anything)", git(repo, "rev-parse", "HEAD") === advancedSha);
  }

  // ── (K) card 95940402: a same-tree, DIFFERENT-PARENT commit substituted right after a candidate's own
  //     `git commit` — never caught by any check above (D)-(J), since none of them inspect the landed
  //     commit's own identity. Hooks the plain `commit --author ...` call (never the pathset `--amend`)
  //     and, after letting the real commit land, swaps HEAD to a forged sibling sharing the SAME tree but
  //     parented on an unrelated commit — exactly the shape the parent-half of `verifyCommitParentAndTree`
  //     must catch. This scenario alone does NOT cover a SAME-parent, same-tree, forged-MESSAGE
  //     substitute — see (K2) below for that distinct (and, until Code Review 4933cb39, unclosed) shape.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-forge-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-forge\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-k-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "k1.txt"), "k1\n");
    commitAll(candWt, "feat(x): change k1", GIT_ID);

    // A genuinely DIFFERENT commit in the SAME object store, used purely as the forged commit's decoy
    // parent — never fast-forwarded anywhere, never a batch candidate itself.
    const decoyWt = (await createWorktree(repo, P.projId, `bmhm-k-decoy-${sfx}`)).worktreePath;
    registerForCleanup(decoyWt);
    fs.writeFileSync(path.join(decoyWt, "DECOY-PARENT.txt"), "decoy parent\n");
    commitAll(decoyWt, "chore(test): decoy parent for the forged commit", GIT_ID);
    const decoyParentSha = git(decoyWt, "rev-parse", "HEAD");

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-k-batch-${sfx}`);
    registerForCleanup(batchWt);

    let forged = false;
    let forgedSha;
    function commitForgeFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const out = await real.raw(args);
          if (!forged && Array.isArray(args) && args[0] === "commit" && args[1] === "--author") {
            forged = true;
            const tree = (await real.raw(["rev-parse", "HEAD^{tree}"])).trim();
            forgedSha = (await real.raw([
              "commit-tree", tree, "-p", decoyParentSha, "-m",
              "feat(x): forged — same tree, different parent\n\nLoom-Worker-Branch: some-other-branch\n",
            ])).trim();
            await real.raw(["update-ref", "HEAD", forgedSha]);
          }
          return out;
        },
      };
    }
    let gateInvoked = false;
    const passGate = async () => { gateInvoked = true; return { passed: true }; };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-k-w1", taskId: "bmhm-k-t1", branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: commitForgeFactory });

    check("(K) precondition: the forge actually fired", forged === true && typeof forgedSha === "string");
    check("(K) the batch refuses, typed batchHeadMoved", result.ok === false && result.batchHeadMoved === true);
    check("(K) reason names the tamper/verify failure", /HEAD|tampered|verify/i.test(result.reason ?? ""));
    check("(K) the gate was NEVER invoked — caught before assembly ever hands off to it", gateInvoked === false);
    check("(K) canonical main untouched", git(repo, "rev-parse", "HEAD") === baseMainSha);
  }

  // ── (K2a) Code Review 4933cb39 of card 95940402: a SAME-PARENT, SAME-TREE substitute at the pathset
  //     AMEND hook, differing only in its MESSAGE (a forged `Loom-Worker-Branch: some-other-branch`
  //     trailer) — (K) above never catches this, since parent+tree alone matches. RED on commit 2b5a9ebf.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-k2a-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-k2a\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-k2a-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "k2a.txt"), "k2a\n");
    commitAll(candWt, "feat(x): change k2a", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-k2a-batch-${sfx}`);
    registerForCleanup(batchWt);

    let forged = false;
    let forgedSha;
    function amendForgeFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const out = await real.raw(args);
          if (!forged && Array.isArray(args) && args[0] === "commit" && args[1] === "--amend") {
            forged = true;
            const tree = (await real.raw(["rev-parse", "HEAD^{tree}"])).trim();
            const sameParent = (await real.raw(["rev-parse", "HEAD^"])).trim();
            forgedSha = (await real.raw([
              "commit-tree", tree, "-p", sameParent, "-m",
              "FORGED subject — same parent, same tree\n\nLoom-Worker-Branch: some-other-branch\n",
            ])).trim();
            await real.raw(["update-ref", "HEAD", forgedSha]);
          }
          return out;
        },
      };
    }
    let gateInvoked = false;
    const passGate = async () => { gateInvoked = true; return { passed: true }; };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-k2a-w1", taskId: "bmhm-k2a-t1", branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: amendForgeFactory });

    check("(K2a) precondition: the amend-hook forge actually fired", forged === true && typeof forgedSha === "string");
    check("(K2a) the batch refuses, typed batchHeadMoved", result.ok === false && result.batchHeadMoved === true);
    check("(K2a) reason names the tamper/verify failure", /HEAD|tampered|verify/i.test(result.reason ?? ""));
    check("(K2a) canonical main untouched", git(repo, "rev-parse", "HEAD") === baseMainSha);
  }

  // ── (K2b) Code Review 4933cb39 of card 95940402: the SAME shape as (K2a), at the PLAIN-COMMIT hook, on
  //     a NON-TIP commit of a multi-commit branch — a single-commit branch's plain-commit forge is
  //     accidentally overwritten by the tip's own later pathset amend (see the probe behind this card),
  //     so a non-tip commit is the one that actually exercises this leg. RED on commit 2b5a9ebf.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-k2b-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-k2b\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-k2b-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "k2b-1.txt"), "k2b-1\n");
    commitAll(candWt, "feat(x): change k2b part 1", GIT_ID);
    fs.writeFileSync(path.join(candWt, "k2b-2.txt"), "k2b-2\n");
    commitAll(candWt, "feat(x): change k2b part 2", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-k2b-batch-${sfx}`);
    registerForCleanup(batchWt);

    let forged = false;
    let forgedSha;
    function nonTipForgeFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const out = await real.raw(args);
          // The FIRST plain `commit --author ...` call is the branch's NON-TIP commit (part 1) — the tip
          // (part 2) is never reached once this refuses.
          if (!forged && Array.isArray(args) && args[0] === "commit" && args[1] === "--author") {
            forged = true;
            const tree = (await real.raw(["rev-parse", "HEAD^{tree}"])).trim();
            const sameParent = (await real.raw(["rev-parse", "HEAD^"])).trim();
            forgedSha = (await real.raw([
              "commit-tree", tree, "-p", sameParent, "-m",
              "FORGED subject — non-tip, same parent/tree\n\nLoom-Worker-Branch: some-other-branch\n",
            ])).trim();
            await real.raw(["update-ref", "HEAD", forgedSha]);
          }
          return out;
        },
      };
    }
    let gateInvoked = false;
    const passGate = async () => { gateInvoked = true; return { passed: true }; };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-k2b-w1", taskId: "bmhm-k2b-t1", branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: nonTipForgeFactory });

    check("(K2b) precondition: the non-tip plain-commit forge actually fired", forged === true && typeof forgedSha === "string");
    check("(K2b) the batch refuses, typed batchHeadMoved", result.ok === false && result.batchHeadMoved === true);
    check("(K2b) reason names the tamper/verify failure", /HEAD|tampered|verify/i.test(result.reason ?? ""));
    check("(K2b) canonical main untouched", git(repo, "rev-parse", "HEAD") === baseMainSha);
  }

  // ── (L) Code Review 4933cb39 of card 95940402, S2: `merge-base`/the noop leg's `findLandedSquashCommit`
  //     used to resolve the literal "HEAD" at call time rather than the already-pinned `batchHeadBefore`.
  //     Swaps the batch worktree's HEAD to a decoy commit — one that has the REAL candidate's own tip as
  //     its OWN parent — ONLY during the `merge-base` call's own execution window, restoring the real ref
  //     immediately after: a leave-no-trace race that defeats card 043d83d2's own pre-/post-gate stamp
  //     checks (which compare the ref only AFTER assembly, never during one call). Pre-fix, resolving
  //     "HEAD" inside that window misclassifies the genuinely-new candidate as already-landed (a SILENT
  //     noop — `ok:true`, nothing committed, no refusal, no trace) and its real commit never reaches main.
  //     Post-fix, resolving the pinned `batchHeadBefore` (immune to the swap) computes the correct,
  //     non-noop merge-base and the real commit lands normally.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-l-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-l\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-l-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "l1.txt"), "l1\n");
    commitAll(candWt, "feat(x): change l1", GIT_ID);
    const candTipSha = git(candWt, "rev-parse", "HEAD");

    // The decoy: a real commit whose OWN parent is the candidate's real tip — so merge-base(decoy,
    // candTip) === candTip trivially, exactly the shape that would misclassify the candidate as noop.
    const { worktreePath: decoyWt } = await createWorktree(repo, P.projId, `bmhm-l-decoy-${sfx}`, {}, undefined, candTipSha);
    registerForCleanup(decoyWt);
    fs.writeFileSync(path.join(decoyWt, "DECOY-WRAP.txt"), "decoy wraps the real tip\n");
    commitAll(decoyWt, "chore(test): decoy wraps the real candidate tip as its own parent", GIT_ID);
    const decoySha = git(decoyWt, "rev-parse", "HEAD");

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-l-batch-${sfx}`);
    registerForCleanup(batchWt);

    // The swap is visible ONLY during the merge-base call's own execution window — restored to the real,
    // correct ref (`batchHeadBefore`, here `baseMainSha`) before anything else reads it, exactly the
    // leave-no-trace shape a real racer would use, and the shape that defeats the pre/post-gate STAMP
    // checks from card 043d83d2 (which compare the ref AFTER assembly, not during this one call).
    // `assembleBatchBranches`'s own sort step ALSO issues a `merge-base` call (already-resolved shas, to
    // order candidates by author date) BEFORE `landBranchCommitsIndividually` is ever reached for this
    // candidate — count occurrences and target the SECOND one (the real, vulnerable call) rather than the
    // first, so this test fires at the same call regardless of whether its 2nd argument is the literal
    // "HEAD" (pre-fix) or the pinned `batchHeadBefore` (post-fix, where matching on "HEAD" would never
    // fire at all).
    let swapped = false;
    let mergeBaseCalls = 0;
    function mergeBaseSwapFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (Array.isArray(args) && args[0] === "merge-base") {
            mergeBaseCalls++;
            if (!swapped && mergeBaseCalls === 2) {
              swapped = true;
              fs.writeFileSync(batchHeadFilePath(repoPath), `${decoySha}\n`);
              const out = await real.raw(args);
              fs.writeFileSync(batchHeadFilePath(repoPath), `${baseMainSha}\n`);
              return out;
            }
          }
          return real.raw(args);
        },
      };
    }
    let gateInvoked = false;
    const passGate = async () => { gateInvoked = true; return { passed: true }; };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-l-w1", taskId: "bmhm-l-t1", branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: mergeBaseSwapFactory });

    check("(L) precondition: the merge-base-time HEAD swap actually fired", swapped === true);
    check("(L) the candidate's real, brand-new commit actually lands — NEVER silently vanishes as a misclassified noop", result.ok === true && result.landed.length === 1 && result.landed[0]?.noop !== true);
    check("(L) canonical main advanced to the real candidate's content, not left at baseMainSha", git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "l1.txt")));
  }

  // ── (M) card 95940402 round 4, R3 — the empty-stage probe (`git diff --cached --name-only
  //     <expectedParentForThisCommit>`) must compare the staged index against the PINNED expected parent,
  //     never an implicit `HEAD` re-resolved at call time (mutation M6 — reverting the pin to a bare
  //     `["diff", "--cached", "--name-only"]` — currently SURVIVES every other test in this file). Swaps
  //     the batch worktree's HEAD to the CANDIDATE'S OWN TIP (whose tree is exactly what gets staged once
  //     it's cherry-picked) for ONLY this one call's own execution window, restoring the real ref
  //     immediately after — a leave-no-trace race mirroring (L)'s own merge-base swap. Resolving implicit
  //     "HEAD" here would see ZERO diff against that swapped ref and WRONGLY misclassify a genuinely NEW,
  //     non-redundant commit as already-landed (an empty-commit drop) — the worst outcome this probe
  //     exists to prevent (real work silently dropped, not merely refused). Pinning
  //     `expectedParentForThisCommit` is immune to the swap, since it was captured BEFORE the swap could
  //     ever fire.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-m-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-m\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-m-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "m1.txt"), "m1\n");
    commitAll(candWt, "feat(x): change m1", GIT_ID);
    const candTipSha = git(candWt, "rev-parse", "HEAD");

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-m-batch-${sfx}`);
    registerForCleanup(batchWt);

    let swapped = false;
    function probeSwapFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (!swapped && Array.isArray(args) && args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only") {
            swapped = true;
            fs.writeFileSync(batchHeadFilePath(repoPath), `${candTipSha}\n`);
            const out = await real.raw(args);
            fs.writeFileSync(batchHeadFilePath(repoPath), `${baseMainSha}\n`);
            return out;
          }
          return real.raw(args);
        },
      };
    }
    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-m-w1", taskId: "bmhm-m-t1", branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: probeSwapFactory });

    check("(M) precondition: the empty-stage probe's own HEAD swap actually fired", swapped === true);
    check("(M) the candidate's real, non-redundant commit lands — NEVER misclassified as already-present because of the swap",
      result.ok === true && result.landed.length === 1 && result.landed[0]?.noop !== true);
    check("(M) canonical main advanced to the real candidate's content", git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "m1.txt")));
  }

  // ── (K3) Second Code Review 820ce6e3 of card 95940402: a same-parent, same-tree substitute that keeps
  //     (K2)'s own checked fields correct but adds/corrupts something ELSE in the Loom namespace — a
  //     duplicate `Loom-Worker-Branch:`, a lowercase case variant, a `Loom-Landed-Tip:` (which a batch
  //     tip must NEVER carry), a forged line hidden in an EARLIER paragraph, or a Loom-namespace line on
  //     a NON-TIP commit. None of these are visible to a check built from parseLoomTrailerBlock's own
  //     already-resolved fields (duplicate: the LAST match wins, so the real branch still reads back
  //     correctly; hidden: parseLoomTrailerBlock only ever reads the FINAL paragraph). RED on commit
  //     1d5cb0de (confirmed via the same capture-patch/revert/rebuild/restore cycle as (K)/(K2)); GREEN
  //     on this round's `verifyLoomNamespaceExact` fix. `extra-foreign` is the sibling POSITIVE control:
  //     a real (non-Loom) trailer, e.g. from a user's own commit-msg hook, must still land untouched.
  for (const m of [
    { tag: "landedtip", atTip: true, build: (real) => `${real}\nLoom-Landed-Tip: ${"a".repeat(40)}\n` },
    { tag: "dup", atTip: true, build: (real, br) => real.replace(`Loom-Worker-Branch: ${br}`, `Loom-Worker-Branch: some-other-branch\nLoom-Worker-Branch: ${br}`) + "\n" },
    { tag: "lower", atTip: true, build: (real) => `${real}\nloom-worker-branch: some-other-branch\n` },
    { tag: "hidden", atTip: true, build: (real) => { const [subj, ...rest] = real.split("\n"); return `${subj}\n\nLoom-Worker-Branch: some-other-branch\n${rest.join("\n")}\n`; } },
    { tag: "extra-foreign", atTip: true, build: (real) => `${real}\nReviewed-by: forger\n`, expectLands: true },
    { tag: "nontip-loom", atTip: false, build: (real) => `${real}\n\nLoom-Worker-Base: ${"b".repeat(40)}\nLoom-Worker-PathSet: deadbeef\n` },
    // @decision 95940402 (round 4, R1, Code Review a399cb11) — the namespace audit alone could report
    // "exact" while `parseLoomTrailerBlock` (the reader every mainline consumer actually uses) still
    // returned null — each mode below corrupts a line `scanLoomNamespaceLines`'s narrower reserved-key
    // match never sees (so the exact-set check stays "exact"), while breaking the READER's own per-line
    // `key: value` requirement for the WHOLE final paragraph. RED on beb12b93 (pre-round-4), GREEN on
    // `verifyLoomTrailersExactAndReadable`'s reader round-trip.
    { tag: "prose-in-trailer", atTip: true, build: (real) => `${real}\n[skip ci]`, expectUnreadable: true },
    { tag: "continuation", atTip: true, build: (real) => `${real}\n    (continued from the digest above)`, expectUnreadable: true },
    { tag: "zw-landedtip", atTip: true, build: (real) => `${real}\n​Loom-Landed-Tip: ${"a".repeat(40)}`, expectUnreadable: true },
  ]) {
    const repo = path.join(os.tmpdir(), `loom-bmhm-k3-${m.tag}-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), `# bmhm-k3-${m.tag}\n`);
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-k3-${m.tag}-c1-${sfx}`);
    registerForCleanup(candWt);
    if (!m.atTip) {
      // A non-tip commit needs a SECOND commit after it (the real tip) so it is genuinely non-tip.
      fs.writeFileSync(path.join(candWt, "k3nt.txt"), "k3nt\n");
      commitAll(candWt, "feat(x): change k3 non-tip part", GIT_ID);
    }
    fs.writeFileSync(path.join(candWt, `k3-${m.tag}.txt`), `${m.tag}\n`);
    commitAll(candWt, `feat(x): change k3 ${m.tag}`, GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-k3-${m.tag}-batch-${sfx}`);
    registerForCleanup(batchWt);

    let forged = false;
    function forgeFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const out = await real.raw(args);
          const hit = m.atTip
            ? (Array.isArray(args) && args[0] === "commit" && args[1] === "--amend")
            : (Array.isArray(args) && args[0] === "commit" && args[1] === "--author");
          if (!forged && hit) {
            forged = true;
            const tree = (await real.raw(["rev-parse", "HEAD^{tree}"])).trim();
            const par = (await real.raw(["rev-parse", "HEAD^"])).trim();
            const realMsg = (await real.raw(["log", "-1", "--format=%B", "HEAD"])).replace(/\s+$/, "");
            const msg = m.build(realMsg, candBranch);
            const forgedSha = (await real.raw(["commit-tree", tree, "-p", par, "-m", msg])).trim();
            await real.raw(["update-ref", "HEAD", forgedSha]);
          }
          return out;
        },
      };
    }
    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: `bmhm-k3-${m.tag}-w1`, taskId: `bmhm-k3-${m.tag}-t1`, branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: forgeFactory });

    check(`(K3 ${m.tag}) precondition: the forge actually fired`, forged === true);
    if (m.expectLands) {
      check(`(K3 ${m.tag}) a foreign (non-Loom) trailer STILL lands untouched`, result.ok === true);
      check(`(K3 ${m.tag}) canonical main advanced`, git(repo, "rev-parse", "HEAD") !== baseMainSha);
    } else if (m.expectUnreadable) {
      check(`(K3 ${m.tag}) the batch refuses, typed batchHeadMoved`, result.ok === false && result.batchHeadMoved === true);
      check(`(K3 ${m.tag}) the reason is the DISTINCT, honest "unreadable" wording, never generic 'tampered' or the displaced wording`,
        /altered Loom's trailer paragraph/i.test(result.reason ?? "") &&
        !/tampered/i.test(result.reason ?? "") &&
        !/final paragraph is not Loom's trailer block/i.test(result.reason ?? ""));
      check(`(K3 ${m.tag}) canonical main untouched`, git(repo, "rev-parse", "HEAD") === baseMainSha);
    } else {
      check(`(K3 ${m.tag}) the batch refuses, typed batchHeadMoved`, result.ok === false && result.batchHeadMoved === true);
      check(`(K3 ${m.tag}) canonical main untouched`, git(repo, "rev-parse", "HEAD") === baseMainSha);
    }
  }

  // ── (K4) card 95940402 round 4, A2 — a WORKER-AUTHORED commit whose own SUBJECT line is itself a
  //     reserved Loom trailer ("Loom-Worker-Branch: other-branch") is a content defect in that worker's
  //     own commit, not a racer's tamper — it must drop ONLY that candidate, before anything is
  //     committed, and let the REST of the batch land normally. Letting it reach the post-commit
  //     `verifyLoomTrailersExactAndReadable` check instead would refuse `batchHeadMoved`, which
  //     `assembleBatchBranches` propagates as a full-batch abort with NO per-candidate fallback — the
  //     wrong remedy here. A second, well-formed candidate in the SAME batch proves the drop is scoped.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-k4-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-k4\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: goodWt, branch: goodBranch } = await createWorktree(repo, P.projId, `bmhm-k4-good-${sfx}`);
    registerForCleanup(goodWt);
    fs.writeFileSync(path.join(goodWt, "k4-good.txt"), "good\n");
    commitAll(goodWt, "feat(x): change k4 good", GIT_ID);

    const { worktreePath: evilWt, branch: evilBranch } = await createWorktree(repo, P.projId, `bmhm-k4-evil-${sfx}`);
    registerForCleanup(evilWt);
    fs.writeFileSync(path.join(evilWt, "k4-evil.txt"), "evil\n");
    // The commit's own SUBJECT (line 0) is itself a reserved Loom trailer line — `commitAll` here is the
    // worker's OWN commit, not Loom's; nothing downstream strips line 0 (stripReservedLoomTrailerLines
    // deliberately never touches it).
    commitAll(evilWt, `Loom-Worker-Branch: ${evilBranch}`, GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-k4-batch-${sfx}`);
    registerForCleanup(batchWt);

    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-k4-good-w1", taskId: "bmhm-k4-good-t1", branch: goodBranch, cutBaseSha: null },
      { workerSessionId: "bmhm-k4-evil-w1", taskId: "bmhm-k4-evil-t1", branch: evilBranch, cutBaseSha: null },
    ], passGate);

    check("(K4) the batch still SUCCEEDS overall — a worker-authored defect is NOT a racer tamper", result.ok === true);
    check("(K4) the good candidate LANDED", result.landed.some((l) => l.branch === goodBranch));
    check("(K4) the evil candidate was DROPPED, never landed",
      !result.landed.some((l) => l.branch === evilBranch) && result.dropped.some((d) => d.branch === evilBranch));
    check("(K4) the drop reason names the reserved-subject defect, not a generic tamper",
      /reserved Loom trailer line/i.test(result.dropped.find((d) => d.branch === evilBranch)?.reason ?? ""));
    check("(K4) canonical main advanced with the good candidate's own content",
      git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "k4-good.txt")));
    check("(K4) the evil candidate's content did NOT land", !fs.existsSync(path.join(repo, "k4-evil.txt")));
  }

  // ── (R2) card 95940402 round 4/5, R2/F4 — a worker's own commit BODY quoting an EARLIER
  //     `Loom-Worker-Branch:` paragraph (the real 5e323196/6cc1333f shape — reproduced here via a
  //     multi-`-m` commit, which git joins as its own paragraph) must be STRIPPED before landing, never
  //     refused — Loom is about to overwrite that namespace anyway. The branch has TWO commits (round 5,
  //     F4): the quoted line sits in the NON-TIP commit specifically, so a regression that strips only
  //     the LAST commit (plausible, since the trailer-stamping logic itself IS tip-only) goes RED here.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-r2-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-r2\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-r2-c1-${sfx}`);
    registerForCleanup(candWt);
    // NON-TIP commit: its own body quotes the stale paragraph.
    fs.writeFileSync(path.join(candWt, "r2-nontip.txt"), "r2 nontip\n");
    commitAll(candWt, ["feat(x): change r2 nontip", "Loom-Worker-Branch: some-other-branch"], GIT_ID);
    // TIP commit: ordinary, carries no reserved line of its own.
    fs.writeFileSync(path.join(candWt, "r2.txt"), "r2\n");
    commitAll(candWt, "feat(x): change r2 tip", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-r2-batch-${sfx}`);
    registerForCleanup(batchWt);

    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-r2-w1", taskId: "bmhm-r2-t1", branch: candBranch, cutBaseSha: null },
    ], passGate);

    check("(R2) the batch lands — a worker's own reserved line in the body is STRIPPED, never refused", result.ok === true && result.landed.length === 1);
    check("(R2) strippedReservedLineCount is non-zero and visible to the caller", (result.landed[0]?.strippedReservedLineCount ?? 0) > 0);
    const landedBody = result.landed[0]?.sha ? git(repo, "log", "-1", "--format=%B", result.landed[0].sha) : "";
    check("(R2) exactly ONE Loom-Worker-Branch line survives in the TIP's landed message",
      landedBody.split("\n").filter((l) => /^Loom-Worker-Branch:/i.test(l)).length === 1);
    check("(R2) the ONE remaining line names THIS branch, never the stale quoted value", landedBody.includes(`Loom-Worker-Branch: ${candBranch}`));
    const landedRange = result.landed[0]?.sha ? git(repo, "log", "--format=%H", `${baseMainSha}..${result.landed[0].sha}`).split("\n").filter(Boolean) : [];
    check("(R2 F4) both commits landed (non-tip + tip)", landedRange.length === 2);
    const nonTipSha = landedRange[1]; // `log` is newest-first; the older, non-tip commit is second.
    const nonTipBody = nonTipSha ? git(repo, "log", "-1", "--format=%B", nonTipSha) : "";
    check("(R2 F4) the NON-TIP commit's own quoted reserved line is ALSO stripped, not just the tip's", !/Loom-Worker-Branch/i.test(nonTipBody));
    check("(R2) canonical main advanced", git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "r2.txt")) && fs.existsSync(path.join(repo, "r2-nontip.txt")));
  }

  // ── (A1) card 95940402 round 4, A1 — a non-Loom project's own "loom-bridge:"-shaped line, as either a
  //     NON-TIP commit's own SUBJECT or a TIP commit's own BODY line, must land completely untouched —
  //     neither is in Loom's RESERVED namespace, so neither the strip nor the exact-set scanner may see
  //     it (round 3's own broader "any loom-*" match would have refused this).
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-a1-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-a1\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-a1-c1-${sfx}`);
    registerForCleanup(candWt);
    // Non-tip commit: the SUBJECT itself reads "loom-bridge: fix crash" — a legitimate, unreserved use.
    fs.writeFileSync(path.join(candWt, "a1-nontip.txt"), "a1 nontip\n");
    commitAll(candWt, "loom-bridge: fix crash", GIT_ID);
    // Tip commit: a BODY line also reads "loom-cli: do a thing" — equally legitimate and unreserved.
    fs.writeFileSync(path.join(candWt, "a1-tip.txt"), "a1 tip\n");
    commitAll(candWt, ["feat(x): change a1 tip", "loom-cli: do a thing"], GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-a1-batch-${sfx}`);
    registerForCleanup(batchWt);

    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-a1-w1", taskId: "bmhm-a1-t1", branch: candBranch, cutBaseSha: null },
    ], passGate);

    check("(A1) the batch lands — neither a non-tip 'loom-bridge:' subject nor a tip 'loom-cli:' body line trips the scanner", result.ok === true && result.landed.length === 1);
    check("(A1) nothing was stripped — both lines are UNRESERVED, never touched", (result.landed[0]?.strippedReservedLineCount ?? 0) === 0);
    check("(A1) the non-tip commit's subject survives verbatim", git(repo, "log", "--format=%s", `${baseMainSha}..HEAD`).includes("loom-bridge: fix crash"));
    const tipBody = result.landed[0]?.sha ? git(repo, "log", "-1", "--format=%B", result.landed[0].sha) : "";
    check("(A1) the tip commit's body line survives verbatim", tipBody.includes("loom-cli: do a thing"));
    check("(A1) canonical main advanced", git(repo, "rev-parse", "HEAD") !== baseMainSha);
  }

  // ── (K3 hook-paragraph) same Code Review, item 3: a hook appending a NON-trailer paragraph AFTER
  //     Loom's own, otherwise-intact trailer paragraph must refuse with its OWN honest reason, never the
  //     generic "tampered" wording — Loom's trailers are unmolested, just no longer the message's final
  //     paragraph, so its own readers (parseLoomTrailerBlock included) can no longer see them as such.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-k3-hookpara-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-k3-hookpara\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const hooksDir = path.join(repo, ".git", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, "commit-msg"), "#!/bin/sh\nprintf '\\n[ci skip]\\n' >> \"$1\"\n");
    fs.chmodSync(path.join(hooksDir, "commit-msg"), 0o755);

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-k3-hookpara-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "hookpara.txt"), "hookpara\n");
    commitAll(candWt, "feat(x): change hookpara", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-k3-hookpara-batch-${sfx}`);
    registerForCleanup(batchWt);

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-k3-hookpara-w1", taskId: "bmhm-k3-hookpara-t1", branch: candBranch, cutBaseSha: null },
    ], async () => ({ passed: true }));

    check("(K3 hookpara) the batch refuses, typed batchHeadMoved", result.ok === false && result.batchHeadMoved === true);
    check("(K3 hookpara) the reason is the DISTINCT, honest hook-paragraph wording, never generic 'tampered'", /final paragraph is not Loom's trailer block/i.test(result.reason ?? "") && !/tampered/i.test(result.reason ?? ""));
    check("(K3 hookpara) canonical main untouched", git(repo, "rev-parse", "HEAD") === baseMainSha);
  }

  // ── (L2) Code Review 820ce6e3 item 4: the noop leg's OWN `findLandedSquashCommit` lookup (never the
  //     `merge-base` call (L) already covers) must also resolve the pinned `batchHeadBefore`, never a
  //     literal "HEAD" re-resolved at call time. Lands a candidate for REAL first (so re-submitting it
  //     is a GENUINE noop, not a forced one), then re-runs the SAME branch; a HEAD swap scoped to ONLY
  //     that lookup's own `git log --grep=...` call (restored immediately after) points it at a decoy
  //     carrying a FORGED `Loom-Worker-Branch:` trailer for this branch — with the call pinned to
  //     `batchHeadBefore` (the fix), the swap has no effect and the REAL landed sha is still reported.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-l2-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-l2\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const base0 = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-l2-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "l2.txt"), "l2\n");
    commitAll(candWt, "feat(x): change l2", GIT_ID);

    // First, REAL landing — this is what makes the re-submit below a genuine noop.
    const { worktreePath: firstBatchWt } = await createWorktree(repo, P.projId, `bmhm-l2-batch1-${sfx}`);
    registerForCleanup(firstBatchWt);
    const firstResult = await runBatchedMerge(repo, firstBatchWt, base0, [
      { workerSessionId: "bmhm-l2-w0", taskId: "bmhm-l2-t0", branch: candBranch, cutBaseSha: null },
    ], async () => ({ passed: true }));
    check("(L2) precondition: the first (real) landing succeeds", firstResult.ok === true);
    const realLandedSha = firstResult.landed[0]?.sha;
    const batchHeadBefore2 = git(repo, "rev-parse", "HEAD");
    check("(L2) precondition: canonical advanced past base0 after the first landing", batchHeadBefore2 !== base0);

    // Force the candidate's OWN branch ref back onto its pre-land fork point (base0, a PROPER ancestor
    // of the real landing — mirrors batch-merge-robustness.mjs's own (9b) setup exactly) so re-submitting
    // it below is a GENUINE noop, not one forced by a tamper. A branch checked out in a worktree can't be
    // force-moved, so the candidate's own worktree is removed first.
    execFileSync("git", ["worktree", "remove", "--force", candWt], { cwd: repo });
    git(repo, "branch", "-f", candBranch, base0);
    check("(L2) precondition: the candidate's branch ref is now a proper ancestor of the real landing", git(repo, "rev-parse", candBranch) === base0);

    // The decoy: a real commit, cut from base0 (NOT an ancestor of the real landing), carrying a FORGED
    // trailer naming this SAME branch — a misclassifying lookup would report THIS sha instead.
    const { worktreePath: decoyWt } = await createWorktree(repo, P.projId, `bmhm-l2-decoy-${sfx}`, {}, undefined, base0);
    registerForCleanup(decoyWt);
    fs.writeFileSync(path.join(decoyWt, "DECOY-L2.txt"), "decoy l2\n");
    git(decoyWt, "add", "-A"); git(decoyWt, "commit", "-qm", `chore(test): decoy with a forged trailer\n\nLoom-Worker-Branch: ${candBranch}\n`, "--author", "bmhm <bmhm@loom>");
    const decoySha = git(decoyWt, "rev-parse", "HEAD");

    const { worktreePath: secondBatchWt } = await createWorktree(repo, P.projId, `bmhm-l2-batch2-${sfx}`);
    registerForCleanup(secondBatchWt);

    let swapped = false;
    function findLandedSwapFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const isFindLandedLog = Array.isArray(args) && args[0] === "log" &&
            args.some((a) => typeof a === "string" && a.startsWith("--grep=Loom-Worker-Branch"));
          if (!swapped && isFindLandedLog) {
            swapped = true;
            fs.writeFileSync(batchHeadFilePath(repoPath), `${decoySha}\n`);
            const out = await real.raw(args);
            fs.writeFileSync(batchHeadFilePath(repoPath), `${batchHeadBefore2}\n`);
            return out;
          }
          return real.raw(args);
        },
      };
    }
    const secondResult = await runBatchedMerge(repo, secondBatchWt, batchHeadBefore2, [
      { workerSessionId: "bmhm-l2-w1", taskId: "bmhm-l2-t1", branch: candBranch, cutBaseSha: null },
    ], async () => ({ passed: true }), { gitFactory: findLandedSwapFactory });

    check("(L2) precondition: the findLandedSquashCommit-time swap actually fired", swapped === true);
    check("(L2) re-submitting the now-landed branch is classified a noop", secondResult.ok === true && secondResult.landed[0]?.noop === true);
    check("(L2) the noop reports the REAL landed sha — NEVER the decoy's forged-trailer sha", secondResult.landed[0]?.sha === realLandedSha && secondResult.landed[0]?.sha !== decoySha);
  }

  // ── (S1) card 95940402 round 4, R4 — BEHAVIOURAL replacement for the old structural argv check
  //     (Code Review 820ce6e3 item 4): `landedSubject` must be derived from the SAME verified read that
  //     already produced `landedSha`, never a second, independently-steerable read of whatever HEAD
  //     CURRENTLY is. Rather than assert a specific call shape never fires (a structural guard easy to
  //     satisfy by accident while still reading the wrong ref some OTHER way), swap the batch worktree's
  //     HEAD to a DECOY commit (same parent, DIFFERENT subject) immediately AFTER the `rev-parse HEAD`
  //     call that captures `landedSha`, and leave it swapped — never restored. Calls
  //     `assembleBatchBranches` DIRECTLY (not `runBatchedMerge`) so this is isolated from card 043d83d2's
  //     own, unrelated pre-/post-gate stamp check, which would otherwise ALSO trip on the same swap for a
  //     completely different reason and make the result ambiguous.
  //     Call-count note (corrected, 4th Code Review 89193398): `landBranchCommitsIndividually` has FIVE
  //     bare `["rev-parse","HEAD"]` call SITES total (:371 batchHeadBefore, :553 the rollback cleanliness
  //     probe, :752 the per-commit post-commit verify, :844 the post-amend-failure recovery probe, :877
  //     this one/landedSha) — the question "how many fire" is a DIFFERENT, scenario-dependent question
  //     from "how many sites exist": for this exact single-candidate, single-commit, no-`baseMainSha`,
  //     no-rollback, amend-succeeds happy path, only 4 of the 5 actually execute (the rollback probe and
  //     the post-amend-failure read never fire) — `assembleBatchBranches`'s own initial read, then those
  //     4, giving the bare call count THIS factory sees. Re-derive both numbers from the real source
  //     before trusting either if this test ever goes unexpectedly RED.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-s1-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-s1\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-s1-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "s1.txt"), "s1\n");
    commitAll(candWt, "feat(x): change s1", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-s1-batch-${sfx}`);
    registerForCleanup(batchWt);

    let revParseHeadCalls = 0;
    let swapped = false;
    let realLandedSha;
    const DECOY_SUBJECT = "chore(test): decoy subject, never reported";
    function postRevParseSwapFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const out = await real.raw(args);
          if (Array.isArray(args) && args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD") {
            revParseHeadCalls++;
            if (!swapped && revParseHeadCalls === 4) {
              swapped = true;
              realLandedSha = out.trim();
              const tree = (await real.raw(["rev-parse", `${realLandedSha}^{tree}`])).trim();
              const par = (await real.raw(["rev-parse", `${realLandedSha}^`])).trim();
              const decoySha = (await real.raw(["commit-tree", tree, "-p", par, "-m", DECOY_SUBJECT])).trim();
              await real.raw(["update-ref", "HEAD", decoySha]);
            }
          }
          return out;
        },
      };
    }
    const assembled = await assembleBatchBranches(repo, batchWt, [
      { workerSessionId: "bmhm-s1-w1", taskId: "bmhm-s1-t1", branch: candBranch, cutBaseSha: null },
    ], { gitFactory: postRevParseSwapFactory });

    check("(S1) precondition: the post-rev-parse HEAD swap actually fired", swapped === true);
    check("(S1) the branch still landed", assembled.landed.length === 1);
    check("(S1) landed[].sha is the REAL landed commit, never the decoy", assembled.landed[0]?.sha === realLandedSha);
    check("(S1) landed[].subject still describes the REAL landedSha, never the decoy's subject",
      assembled.landed[0]?.subject === git(repo, "log", "-1", "--format=%s", realLandedSha) &&
      assembled.landed[0]?.subject !== DECOY_SUBJECT);
  }

  // (C) — the source-text regression guard for the pre-gate reduced-gate steer leg (service.ts's batch
  // runGate closure must pass the pinned assembledTipSha, never resolve "HEAD") lives in its own small
  // file, batch-merge-head-moved-emitcompare-arg-guard.mjs — registered in
  // CHANGED_TS_TEXT_SCANNER_REPO_PATHS (git/worktrees.ts) so the reduced gate re-runs it on any changed
  // .ts file, without also re-running THIS file's much heavier real-git scenarios (A)/(B) on every such
  // fold-in.
} finally {
  // cleanup: return canonical to mainline for any later local re-run
  try { git(P.repo, "checkout", "-q", MAIN); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a batch-worktree HEAD swap (pre-gate, mid-gate, or between two candidates) and a dirty-tree tamper (pre-gate or mid-gate) all refuse as batchHeadMoved with no per-candidate fallback and canonical main untouched; computeEmitCompareGate's own resolved-sha contract is immune to what HEAD points to (card 043d83d2); a same-tree, different-parent commit substituted right after a candidate's own commit also refuses as batchHeadMoved, and so does a same-parent/same-tree, forged-trailer substitute at either the plain-commit or pathset-amend hook (tip and non-tip), and a merge-base-time HEAD swap that would otherwise misclassify a genuinely new candidate as an already-landed noop (card 95940402)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
