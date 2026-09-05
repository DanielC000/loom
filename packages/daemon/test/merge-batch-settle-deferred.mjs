import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE_BATCH SETTLE DEFERRAL (card 81d795de) — `mergeBatchTracked`'s own `runGate` closure used to call
// `settlePendingGateOp` itself, right after the shared gate command finished — STRICTLY BEFORE
// `runBatchedMerge`'s own fast-forward onto canonical main, and before this method's own per-branch
// `finishAlreadyMerged` finalize loop, had even started. So `gate_status(opId).state === "settled"` could
// read true while canonical main had not yet moved and no branch had been finalized — confirmed at source
// (card cf803152's own investigation, promoted here) and NOT test-only: `mcp/orchestration.ts`'s
// `merge_batch` tool told every manager, in its own documented pending-response note, to "poll
// gate_status(opId)" to check on a pending batch, which was exactly this unsafe pattern.
//
// Proves:
//   (RACE) forces the window open with a DEFERRED promise (see test/_wait.mjs's own doc on why a deferred,
//          not a blind sleep, is the right tool for an "X happens before/after Y within one flow" claim):
//          `sessions.finishAlreadyMerged` — the LAST step of `mergeBatchTracked`'s own `run()`, called only
//          AFTER `runBatchedMerge` has already fast-forwarded canonical main — is monkey-patched to block on
//          a promise this test controls. With `syncAttachBudgetMs` forced tiny (the documented throwaway
//          test seam — never the production constant), `mergeBatchTracked` degrades to `{settled:false}`
//          almost immediately, handing back a real `opId` this test can poll independently of the batch's
//          own background progress. Once BOTH observable proofs that the gate genuinely ran AND canonical
//          main genuinely advanced are in hand (a real `build_gate` event exists; the repo's HEAD sha no
//          longer equals the captured pre-batch sha) — i.e. the batch is blocked on NOTHING BUT this test's
//          own deferred — `gate_status(opId)` MUST NOT yet report `state:"settled"`. Only after the test
//          resolves the deferred does the batch finish, and `gate_status(opId)` finally settles with the
//          real (passed:true) verdict.
//   (POST) once genuinely settled, gate_status still carries the same rich verdict this project's other
//          batch coverage (batch-merge-gate-history.mjs) already asserts — checked briefly here too, so
//          this file alone proves the fix didn't trade correctness of the eventual verdict for its timing.
//          Also asserts `batchBranchCount`, the ONE field `deriveBatchGateVerdict` computes that neither
//          the two (RACE) checks nor the rest of (POST) happen to touch — the discriminating check for
//          "the payload this card moves in TIME (computed well before it's written) still arrives intact",
//          not just "some verdict arrived".
//
// Code Review, card 81d795de, finding [6] — RECONCILING THE PRE-FIX FAILURE COUNT (n=3, not 2): reverting
// this card's service.ts change and re-running this file fails THREE checks, not just the two (RACE) ones.
// The third, `(POST) finishAlreadyMerged was reached exactly twice`, is NOT a timeout and NOT a flake — it
// is a THIRD, deterministic symptom of the identical root cause, confirmed by instrumenting a throwaway
// copy of this file: pre-fix, `gate_status(opId)` already reads "settled" from the moment the shared gate
// finished (long before `finishGate.resolve()` is ever called), so the `waitUntil(() => ...state ===
// "settled")` right after `resolve()` returns on its VERY FIRST synchronous predicate check — before the
// second `finishAlreadyMerged` call (branch b) has even started, since that call is still queued behind
// branch a's own real (non-instant) `origFinish` work. `finishCalls` reads back 1, not 2, at that point,
// both immediately BEFORE and immediately AFTER the `waitUntil` call (confirmed via direct instrumentation).
// Pre-fix, "settled" is simply uncorrelated with finalize having actually finished — this is the same
// defect showing up a third way, not independent noise.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-batch-settle-deferred.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil, deferred } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mbsd-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mbsd@loom -c user.name=mbsd";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mbsd\n");
  execSync(`git init -q && git config user.email mbsd@loom && git config user.name mbsd`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

const dbs = [];
const worktrees = [];
try {
  const repo = path.join(os.tmpdir(), `loom-mbsd-${sfx}`);
  makeRepo(repo);
  const projId = `mbsd-proj-${sfx}`;
  const agentId = `mbsd-agent-${sfx}`;
  const mgrId = `mbsd-mgr-${sfx}`;

  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: "MBSD", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: 'node -e "process.exit(0)"' } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const baseMainSha = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();

  async function cutBranch(label, file) {
    const taskId = `mbsd-task-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    fs.writeFileSync(path.join(worktreePath, file), `work ${label}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  }
  const a = await cutBranch("a", "feature-a.txt");
  const b = await cutBranch("b", "feature-b.txt");
  worktrees.push(a.worktreePath, b.worktreePath);
  const wA = `mbsd-wkr-a-${sfx}`, wB = `mbsd-wkr-b-${sfx}`;
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  // syncAttachBudgetMs FORCED TINY — the documented throwaway test seam (never the production constant,
  // never SYNC_ATTACH_BUDGET_MS/maxConcurrentGates/LOOM_GATE_TEST_CONCURRENCY/TEST_TIMEOUT_MS/
  // DEFAULT_CONCURRENCY) — guarantees mergeBatchTracked degrades to {settled:false} almost immediately, so
  // this test can hold a real opId independently of the batch's own background progress.
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 1 });

  // DEFERRED GATE on the LAST step of mergeBatchTracked's own run() — finishAlreadyMerged is called only
  // AFTER runBatchedMerge has already fast-forwarded canonical main (see mergeBatchTracked's own landed
  // loop, sessions/service.ts). Blocking here — rather than via a blind sleep — pins the exact moment the
  // batch is blocked on NOTHING BUT this test's own gate, so the race window this test proves closed is
  // real, not a guess about timing.
  const finishGate = deferred();
  let finishCalls = 0;
  const origFinish = sessions.finishAlreadyMerged.bind(sessions);
  sessions.finishAlreadyMerged = async (...args) => {
    finishCalls++;
    await finishGate.promise;
    return origFinish(...args);
  };

  const r = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
  check("(precondition) syncAttachBudgetMs:1 forced the async-degrade path — batch still running in the background", r.settled === false);
  const opId = r.op?.opId;
  check("(precondition) a real opId was minted", typeof opId === "string" && opId.length > 0);

  // Wait for TWO independently-observable proofs that the batch is blocked on nothing but this test's own
  // deferred: (1) the gate's own durable audit event exists (the shared gate command genuinely ran and
  // settled), and (2) canonical main's HEAD has genuinely advanced (the fast-forward this card's own
  // finding is about has ALREADY happened). Both are real state this test only OBSERVES, never controls —
  // exactly the waitUntil discipline test/_wait.mjs documents, not a blind sleep standing in for either.
  await waitUntil(() => !!db.getLatestEventForManagerByKind(mgrId, "build_gate"),
    { timeoutMs: 30_000, label: "the batch's own build_gate audit event to land" });
  await waitUntil(() => execSync("git rev-parse HEAD", { cwd: repo }).toString().trim() !== baseMainSha,
    { timeoutMs: 30_000, label: "canonical main to actually fast-forward past baseMainSha" });
  await waitUntil(() => finishCalls > 0, { timeoutMs: 30_000, label: "finishAlreadyMerged to actually be reached (blocked on this test's own gate)" });

  // ── THE RACE ASSERTION ─────────────────────────────────────────────────────────────────────────────────
  // At this exact point: the gate ran, main already advanced, and the ONLY thing left before mergeBatchTracked's
  // own run() can resolve is this test's still-unresolved deferred inside finishAlreadyMerged. Before card
  // 81d795de, gate_status(opId) would ALREADY read "settled" here — the tombstone settled synchronously
  // inside the gate closure, long before finishAlreadyMerged was ever reached. This is the exact assertion
  // that goes RED against the pre-fix code (verified locally by reverting sessions/service.ts's settle-site
  // change alone, rebuilding, and re-running this file — see this card's worker_report for the before/after).
  const midFinalize = sessions.gateStatus(opId);
  check("(RACE) card 81d795de: gate_status(opId) does NOT read \"settled\" while still blocked in finalize (fast-forward already happened, finishAlreadyMerged not yet resolved) — this is the exact defect this card fixes",
    midFinalize.state !== "settled");
  check("(RACE) gate_status(opId) is still a genuinely live/pending state, not some other terminal misclassification",
    midFinalize.state === "running" || midFinalize.state === "pending" || midFinalize.state === "queued");

  // Release the gate — finalize proceeds, mergeBatchTracked's own run() resolves, and the DEFERRED
  // settlePendingGateOp write (this card's own onSettle hook) finally fires.
  finishGate.resolve();

  await waitUntil(() => sessions.gateStatus(opId).state === "settled",
    { timeoutMs: 30_000, label: "gate_status(opId) to settle for real, now that finalize has actually finished" });
  const finalSt = sessions.gateStatus(opId);
  check("(POST) gate_status(opId) now settles with the real verdict (passed:true)", finalSt.passed === true);
  check("(POST) gate_status(opId) reports gateType \"merge\" for the batch op", finalSt.gateType === "merge");
  // Code Review, card 81d795de finding [6]: the discriminating field for "the payload this card moves in
  // TIME (computed inside runGate, written minutes later by onSettle) survived the deferral intact" — a
  // bare passed:true/gateType:"merge" check would pass even if deriveBatchGateVerdict's own payload fields
  // (batchBranchCount, gateCap, settledAt, totalDurationMs, steps, ...) got dropped somewhere in transit.
  check("(POST) gate_status(opId) carries the real batchBranchCount (2), not dropped in transit by the deferral", finalSt.batchBranchCount === 2);
  check("(POST) both branches actually landed on main", fs.existsSync(path.join(repo, "feature-a.txt")) && fs.existsSync(path.join(repo, "feature-b.txt")));
  check("(POST) finishAlreadyMerged was reached exactly twice (once per landed branch)", finishCalls === 2);
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
