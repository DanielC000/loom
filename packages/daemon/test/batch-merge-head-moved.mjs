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
//
// SPLIT (card 3aad1cb3): card 95940402's own fix plus every one of its Code Review follow-ups — the
// landed-COMMIT-identity checks (K)/(K2a)/(K2b)/(K3)/(K4)/(L)/(L2)/(M)/(R2)/(A1)/(S1), as opposed to this
// file's own worktree-REF checks above — moved VERBATIM to the sibling file
// batch-merge-head-moved-commit-identity.mjs. Card 95940402 added ~746 lines of new scenarios to this
// file in one day with no full-gate timing history at the new size, and this file's own direct solo
// measurement (2026-10-25, one host, concurrency 2 with a real merge gate holding the other lane) came
// back at 230,000ms — already ~1.9x the 120,000ms blanket TEST_TIMEOUT_MS even unloaded. Splitting along
// the 043d83d2-vs-95940402 boundary keeps both halves comfortably inside a sane per-file override instead
// of growing one timeout entry without bound: every scenario after (J) is self-contained (verified by
// grep before splitting — none of them reference this file's own shared `P.repo`/`boot()`/`addWorker`
// setup, so there is nothing of this file's own state for the sibling file to carry over).
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
  ? "\n✅ ALL PASS — a batch-worktree HEAD swap (pre-gate, mid-gate, or between two candidates) and a dirty-tree tamper (pre-gate or mid-gate) all refuse as batchHeadMoved with no per-candidate fallback and canonical main untouched; computeEmitCompareGate's own resolved-sha contract is immune to what HEAD points to (card 043d83d2). The landed-COMMIT-identity checks (card 95940402: forged parent/tree/trailer substitutes, noop misclassification, trailer stripping) now live in the sibling file batch-merge-head-moved-commit-identity.mjs (split by card 3aad1cb3)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
