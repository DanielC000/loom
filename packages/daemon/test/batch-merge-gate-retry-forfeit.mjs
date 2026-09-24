import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH GATE FORFEIT SHAPES (card 677a2737 — split out of batch-merge-gate-retry.mjs, whose six scenarios
// ran ~60s solo on a quiet host against the 120s per-file ceiling and were SIGTERM-killed at it in five
// gates on 2026-09-24). Profiled cost is ~800 real git processes spread evenly over the scenarios (no fixed
// wait, no dominant scenario), so the fix is a split, not a wait change: each half gets its own ceiling.
// Keeps the "forfeit" half here: (vii) gate+retry BOTH pass but canonical main advanced mid-gate so the
// fast-forward forfeits (batchBranchCount survives, batchLanded:false, retryWarning omits the batch clause;
// card 4ad6ccfd/553ea58c), and (viii) the same forfeit with NO retry ever fired. The retry-mechanism half
// ((i)/(ii) pass-after-retry, (iv) fail-after-retry, (v) retry-continues-admission, (vi) decline reason)
// stays in batch-merge-gate-retry.mjs. Hermetic, no daemon; helpers mirror that file's own.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/batch-merge-gate-retry-forfeit.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmgr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { formatWeakerPassWarning } = await import("../dist/orchestration/gate-runner.js");


let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bmgr@loom -c user.name=bmgr";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
// Card 677a2737: mergeBatchTracked's real git assembly costs ~5-13s here, straddling the production
// 12s SYNC_ATTACH_BUDGET_MS — so under load a block silently degraded to the async path and skipped its
// value-dependent assertions. A generous injected budget (the DI seam batch-merge-gate-history.mjs also
// uses) keeps every block on the sync path; resolveBatch still tolerates a genuine degrade.
const SYNC_BUDGET_MS = 90_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmgr\n");
  execSync(`git init -q && git config user.email bmgr@loom && git config user.name bmgr`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function cutBranch(repo, projId, label, file, content) {
  const taskId = `bmgr-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, `${label}`, GIT_ID);
  return { taskId, branch, worktreePath };
}

// Plants the two files `identifyRetriableTestFiles` looks for, relative to the BATCH worktree root (the
// worktree the injected gate actually receives as its own second arg) — mirrors merge-gate-single-file-
// retry.mjs's `plantTestFile`, applied lazily inside the fakeGate itself since the batch worktree doesn't
// exist yet when the test starts (mergeBatchTracked cuts it internally).
function plantTestFile(worktreePath, name) {
  fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
  fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "test"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", `${name}.mjs`), "// stub\n");
}

function setupBatchProject(label, gateCommand) {
  const projId = `bmgr-${label}-proj-${sfx}`, agentId = `bmgr-${label}-agent-${sfx}`, mgrId = `bmgr-${label}-mgr-${sfx}`;
  const repo = path.join(os.tmpdir(), `loom-bmgr-${label}-${sfx}`);
  return { projId, agentId, mgrId, repo, gateCommand };
}

async function seedTwoWorkers(db, P) {
  makeRepo(P.repo);
  db.insertProject({ id: P.projId, name: `BMGR-${P.projId}`, repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: P.gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const a = await cutBranch(P.repo, P.projId, `${P.projId}-a`, "feature-a.txt", "work a\n");
  const b = await cutBranch(P.repo, P.projId, `${P.projId}-b`, "feature-b.txt", "work b\n");
  const wA = `${P.projId}-wkr-a`, wB = `${P.projId}-wkr-b`;
  for (const [wId, w] of [[wA, a], [wB, b]]) {
    db.insertTask({ id: w.taskId, projectId: P.projId, title: `feat(test): ${w.taskId}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  return { wA, wB, worktrees: [a.worktreePath, b.worktreePath] };
}

// Resolve a settled MergeBatchResult, tolerating the documented sync-vs-async-degrade split
// (mergeBatchTracked -> PendingOpRegistry.attach) the same way batch-merge-gate-history.mjs already does.
// Card c85f842d: on the SETTLED branch, `r.op` never exists (only the `{settled:false, op}` pending shape
// carries it — `AttachResult`'s settled variants deliberately don't, see PendingOpRegistry's own doc), so
// `r.op?.opId` is structurally always undefined there. Before card c85f842d that meant `outcome.opId` was
// ALWAYS undefined on a sync-settled batch — the exact gap that card fixes: the real id now lives INSIDE
// `r.value.opId` (`MergeBatchResult.opId`), set whenever `mergeBatchTracked`'s own `run(opId)` closure
// actually ran (i.e. not one of the pre-attach() early bail-outs, which never mint an op at all).
//
// Verification-only escape hatch (card 9167962f's own DoD-3 positive control): when set, forces EVERY
// resolveBatch() call below down the async-degrade branch regardless of what mergeBatchTracked actually
// returned, so degradeCoverage's own check (see near EOF) can be shown to fire without depending on real
// host timing — the genuine async degrade is "a coin flip on real host timing" per the (iii) comment
// above and not something this file can reliably force end to end. Default off: an ordinary run (this
// env var unset) is byte-for-byte the same resolveBatch behavior as before this flag existed. Deliberately
// mints NO opId of its own (`r.op?.opId`, unchanged by card c85f842d) — this branch is a SYNTHETIC stand-in
// for a degrade that (for a genuinely sync-settled `r`) never happened, so it must not leak `r.value.opId`
// as if it had; a real forced-pending `r` still carries its own `r.op.opId` here exactly as before.
const FORCE_DEGRADE_ALL = process.env.BMGR_FORCE_DEGRADE_ALL === "1";
async function resolveBatch(sessions, batchPromise) {
  const r = await batchPromise;
  if (!r.settled) {
    await waitUntil(() => sessions.gateStatus(r.op.opId).state === "settled",
      { timeoutMs: 60_000, label: "batch op to settle asynchronously (missed the sync-wait budget)" });
  }
  if (FORCE_DEGRADE_ALL) return { settled: true, ok: undefined, value: undefined, opId: r.op?.opId };
  if (!r.settled) return { settled: true, ok: undefined, value: undefined, opId: r.op.opId };
  return { settled: true, ok: r.ok, value: r.ok ? r.value : undefined, opId: r.ok ? r.value?.opId : undefined };
}

// Card 9167962f DoD-1: every block below that branches on `outcome.value` (skipping its value-dependent
// assertions with a console.log NOTE when the async-degrade path was taken) records itself here. A
// PARTIAL skip stays tolerated (the degrade path is real and legitimate) — but if EVERY such block
// skipped in one run, every retry/warning assertion in this file ran nowhere this pass, and that total
// blackout must fail loudly rather than exit 0 alongside an "ALL PASS" banner. See the check near EOF.
let degradeTotal = 0;
const degradeSkipped = [];
function recordDegradeOutcome(label, outcome) {
  degradeTotal++;
  if (!outcome.value) degradeSkipped.push(label);
}

const dbs = [];
const worktrees = [];
try {
  // ── (vii) PASS-BUT-FORFEITED (card 4ad6ccfd fold-in) — gate+retry BOTH pass, but canonical main ────────
  //     advanced while the gate ran, so the fast-forward refuses (forfeit) and NOTHING lands. This is one
  //     of `batch-merge.ts`'s other two `ok:false` returns (`gatePassed:true`, distinct from (iv)'s genuine
  //     gate rejection) — the manager's own blocking finding on this card: an earlier version of the fix
  //     called `formatWeakerPassWarning(..., result.landed.length)` here, which renders "ALL N land on the
  //     strength of this ONE retry" — false, since the outer `landed:[]` on this exact return proves
  //     nothing landed. `batchBranchCount` must be `undefined` on THIS branch so no batch clause renders.
  {
    const P = setupBatchProject("forfeit", "pnpm gate");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async (gate, worktreePath) => {
      calls++;
      if (calls === 1) {
        plantTestFile(worktreePath, "flaky-batch-forfeit");
        return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL  flaky-batch-forfeit", failingTestCount: 1, failTierTest: "FAIL  flaky-batch-forfeit", failTierTestCount: 1, failTierAll: ["FAIL  flaky-batch-forfeit"] };
      }
      if (calls === 2) {
        // THE RETRY passes — but simulate canonical main advancing WHILE this gate ran (a real concurrent
        // landing on main, exactly what `fastForwardCanonicalMain`'s own forfeit check, batch-merge.ts,
        // exists to catch): commit directly onto the canonical repo's OWN working tree, bypassing the
        // batch entirely, landed strictly between `baseMainSha`'s capture (before this gate ever ran) and
        // the fast-forward attempt (right after this retry settles).
        fs.writeFileSync(path.join(P.repo, "concurrent-main-advance.txt"), "someone else landed\n");
        commitAll(P.repo, "concurrent main advance while the batch gate ran", GIT_ID);
        return { passed: true };
      }
      // calls 3+: the forfeited batch's own per-candidate fallback (confirmWorkerMergeTracked re-gating
      // each worker solo) — just pass cleanly; the fallback path itself is already covered by (iv)/(vi).
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, syncAttachBudgetMs: SYNC_BUDGET_MS });
    const { wA, wB, worktrees: wts } = await seedTwoWorkers(db, P);
    worktrees.push(...wts);

    const outcome = await resolveBatch(sessions, sessions.mergeBatchTracked(P.mgrId, [wA, wB]));
    recordDegradeOutcome("(vii)", outcome);
    // THE SECOND SURFACE (card 553ea58c): `outcome.value`/the sync return is only ONE of two readers of
    // this exact op — `gate_status(opId)` is the durable, post-hoc reader (a recycle, a restart, a
    // successor reading history later) and reads a SEPARATE stored verdict (`batchGateVerdict`, minted
    // inside `runGate` — BEFORE `runBatchedMerge` could still forfeit the fast-forward — and, pre-fix,
    // never corrected afterward). This runs regardless of the sync-vs-async split above: the tombstone is
    // durable either way.
    // CORRECTED (card c85f842d): a PRIOR version of this comment claimed `outcome.opId` is NOT populated
    // on the sync-settled path, and that `resolveBatch`'s own `opId: r.op?.opId` is therefore always
    // `undefined` here — TRUE of `r.op?.opId` specifically (a settled `AttachResult` genuinely carries no
    // `op` field — see PendingOpRegistry's own doc), but FALSE as a claim about `outcome.opId` overall:
    // `resolveBatch` now also falls back to `r.value?.opId` (`MergeBatchResult.opId`, card c85f842d's own
    // fix), which the sync-settled path DOES carry. Kept here as the exact case this card fixed — a
    // confident parenthetical inside working test code, half right and half wrong, is precisely the shape
    // this card's own provenance section warns about. The db-row lookup below is kept anyway, as an
    // INDEPENDENT cross-check that both readers (the sync return and the durable tombstone) agree on the
    // SAME op — not because it's still the only way to recover the id. Hoisted ahead of the
    // `if (outcome.value)` block below (like the (i)/(ii) and (iv) blocks above) so the opId cross-check
    // can reference `forfeitRow` from inside that guard.
    const forfeitPage = db.listGateEvents({ projectId: P.projId, limit: 50, offset: 0 });
    const forfeitRow = forfeitPage.items.find((r) => r.branch === null);
    if (outcome.value) {
      check("(vii) precondition: the retry itself passed", outcome.value.retriedFile === "flaky-batch-forfeit" && outcome.value.retryPassed === true);
      check("(vii) precondition: ok:false anyway — gate+retry passed but fast-forward refused (main advanced mid-gate)", outcome.value.ok === false);
      check("(vii) precondition: the reason names the forfeit (canonical main advanced)", typeof outcome.value.reason === "string" && outcome.value.reason.includes("canonical main advanced"));
      check("(vii) precondition: nothing landed (outer landed:[] on this return)", Array.isArray(outcome.value.landed) && outcome.value.landed.length === 0);
      // THE FOLD-IN FIX itself:
      check("(vii) THE FIX: retryWarning is still present (the retry fact itself is real and worth surfacing)", typeof outcome.value.retryWarning === "string");
      check("(vii) THE FIX: retryWarning does NOT claim any branches landed — nothing did", typeof outcome.value.retryWarning === "string" && !outcome.value.retryWarning.includes("land on the strength"));
      check("(vii) THE FIX: retryWarning omits the batch clause entirely (no \"BATCH of\" wording) rather than assert a false count", typeof outcome.value.retryWarning === "string" && !outcome.value.retryWarning.includes("BATCH of"));
      check("(vii) retryWarning still states the solo weaker-pass fact (retry fired, passed only after retrying)", typeof outcome.value.retryWarning === "string" && outcome.value.retryWarning.includes("passed only after retrying"));
      check("(vii) retryWarning matches the shared formatter's output exactly, called with batchBranchCount:undefined", outcome.value.retryWarning === formatWeakerPassWarning("flaky-batch-forfeit", "", undefined));
      // THE FIX (card c85f842d): kept VALUE-DEPENDENT (see the (i)/(ii) block's identical comment above for
      // why — the BMGR_FORCE_DEGRADE_ALL interaction).
      check("(vii) THE FIX (card c85f842d): outcome.opId is populated on the sync-settled path (previously always undefined here)", typeof outcome.opId === "string");
      check("(vii) THE FIX: outcome.opId matches the forfeited batch's own durable build_gate row — both readers agree on the SAME op", outcome.opId === forfeitRow?.opId);
    } else {
      console.log("(vii) NOTE: settled via the async degrade path — MergeBatchResult is not recoverable that way; skipping the return-value assertions above.");
    }

    check("(vii) a build_gate row exists for the forfeited batch op", !!forfeitRow);
    const stForfeit = forfeitRow?.opId ? sessions.gateStatus(forfeitRow.opId) : undefined;
    check("(vii) gate_status(opId) resolves the forfeited batch op", !!stForfeit);
    check("(vii) THE FIX (card 553ea58c): gate_status's retryWarning does NOT claim any branches landed either", typeof stForfeit?.retryWarning === "string" && !stForfeit.retryWarning.includes("land on the strength"));
    check("(vii) THE FIX (card 553ea58c): gate_status's retryWarning omits the batch clause entirely (no \"BATCH of\" wording) rather than assert a false count", typeof stForfeit?.retryWarning === "string" && !stForfeit.retryWarning.includes("BATCH of"));
    // THE CORRECTED DESIGN (Code Review fold-in on card 553ea58c): an EARLIER version of this fix zeroed
    // `batchBranchCount` outright on `!result.ok`. Review measured that destroys a true, correct-at-settle
    // datum (the assembled count) on the DOMINANT shape (see the sibling (viii) block below) and makes a
    // forfeited batch op indistinguishable from a solo merge (`batchBranchCount` is `gate_status`'s ONLY
    // batch discriminator). THE FIX: keep the count, add a SEPARATE `batchLanded:false` fact instead —
    // mirroring `GateHistoryRow.batchForfeited`'s own precedent (card b480dda9): "do NOT 'fix' a forfeited
    // row by zeroing branchCount instead ... the forfeit is a separate, later fact."
    check("(vii) THE CORRECTED FIX: gate_status's batchBranchCount SURVIVES the forfeit — it's the real, correct assembled count, never falsified", stForfeit?.batchBranchCount === 2);
    check("(vii) THE CORRECTED FIX: gate_status carries batchLanded:false — the separate, later fact that nothing actually landed", stForfeit?.batchLanded === false);
    check("(vii) gate_status's retryWarning matches the shared formatter's output exactly, called with batchBranchCount:undefined (the RENDER is corrected, not the stored datum)", stForfeit?.retryWarning === formatWeakerPassWarning("flaky-batch-forfeit", "", undefined));
  }

  // ── (viii) NO-RETRY FORFEIT (Code Review fold-in, card 553ea58c) — the DOMINANT shape finding [1] ────────
  //     measured: attempt 1's gate passes CLEANLY (no retry ever fires — `retriedFile` is undefined on "the
  //     overwhelming majority of batches"), but canonical main still advances mid-gate, so the fast-forward
  //     forfeits and NOTHING lands. An earlier version of the fix guarded on `!result.ok` alone (no
  //     `retriedFile` gating at all), so THIS exact shape — the common case, not (vii)'s retry-assisted one
  //     — was the one the review's instrumented probe caught losing a true `batchBranchCount` for nothing:
  //       PRE-fix   gate_status → batchBranchCount: 2,         retryWarning: undefined
  //       POST-fix  gate_status → batchBranchCount: undefined, retryWarning: undefined  (a real datum, gone)
  {
    const P = setupBatchProject("noretryforfeit", "pnpm gate");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async (gate, worktreePath) => {
      calls++;
      if (calls === 1) {
        // Attempt 1 passes cleanly — but canonical main advances WHILE this gate ran, exactly like (vii)'s
        // own concurrent-main-advance simulation, just with no failing first attempt / no retry at all.
        fs.writeFileSync(path.join(P.repo, "concurrent-main-advance.txt"), "someone else landed\n");
        commitAll(P.repo, "concurrent main advance while the batch gate ran", GIT_ID);
        return { passed: true };
      }
      // calls 2+: the forfeited batch's own per-candidate fallback — pass cleanly.
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, syncAttachBudgetMs: SYNC_BUDGET_MS });
    const { wA, wB, worktrees: wts } = await seedTwoWorkers(db, P);
    worktrees.push(...wts);

    const outcome = await resolveBatch(sessions, sessions.mergeBatchTracked(P.mgrId, [wA, wB]));
    recordDegradeOutcome("(viii)", outcome);
    if (outcome.value) {
      check("(viii) precondition: no retry ever fired — attempt 1's gate passed cleanly", outcome.value.retriedFile === undefined);
      check("(viii) precondition: ok:false anyway — the gate passed but the fast-forward forfeited (main advanced mid-gate)", outcome.value.ok === false);
      check("(viii) precondition: the reason names the forfeit (canonical main advanced)", typeof outcome.value.reason === "string" && outcome.value.reason.includes("canonical main advanced"));
      check("(viii) precondition: nothing landed (outer landed:[] on this return)", Array.isArray(outcome.value.landed) && outcome.value.landed.length === 0);
      check("(viii) precondition: no retryWarning at all on the sync return — there was no retry to warn about", outcome.value.retryWarning === undefined);
    } else {
      console.log("(viii) NOTE: settled via the async degrade path — MergeBatchResult is not recoverable that way; skipping the return-value assertions above.");
    }

    const noRetryPage = db.listGateEvents({ projectId: P.projId, limit: 50, offset: 0 });
    const noRetryRow = noRetryPage.items.find((r) => r.branch === null);
    check("(viii) a build_gate row exists for the no-retry-forfeit batch op", !!noRetryRow);
    check("(viii) the row's own branchCount is the real assembled count (2) — gate_history already gets this right", noRetryRow?.branchCount === 2);
    const stNoRetry = noRetryRow?.opId ? sessions.gateStatus(noRetryRow.opId) : undefined;
    check("(viii) gate_status(opId) resolves the no-retry-forfeit batch op", !!stNoRetry);
    // THE DISCRIMINATING ASSERTION for finding [1]: this is the shape the review's probe measured directly.
    check("(viii) THE FIX: gate_status's batchBranchCount SURVIVES a no-retry forfeit — nothing false was ever asserted here, so nothing should ever have been destroyed", stNoRetry?.batchBranchCount === 2);
    check("(viii) THE FIX: gate_status carries batchLanded:false on the no-retry-forfeit op too", stNoRetry?.batchLanded === false);
    check("(viii) gate_status carries no retryWarning at all (no retry ever fired, on either surface)", stNoRetry?.retryWarning === undefined);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Card 9167962f DoD-1: a PARTIAL skip (some blocks degraded, some didn't) stays tolerated — the degrade
// path is real and legitimate. A TOTAL skip means every value-dependent assertion in this file ran
// nowhere this pass, yet without this check the run would still print "ALL PASS" with zero FAILs — the
// exact silent-regression shape this card exists to catch (see [[shipping-a-detector-is-not-someone-
// reading-it]]). Print an extra unmissable banner on top of the ordinary FAIL line so a total blackout
// doesn't just blend into the scrollback as one more failed assertion among many.
const degradeCoverageOk = !(degradeTotal > 0 && degradeSkipped.length === degradeTotal);
if (!degradeCoverageOk) {
  console.log(`\n🔴🔴 DEGRADE-COVERAGE BLACKOUT: all ${degradeTotal} value-dependent block(s) [${degradeSkipped.join(", ")}] settled via the async-degrade path this run — every retry/warning assertion in this file skipped, yet every other check still reads PASS. See card 9167962f.\n`);
}
check(`degrade-coverage: not every value-dependent block skipped via the async-degrade path this run (${degradeSkipped.length}/${degradeTotal} skipped: [${degradeSkipped.join(", ")}])`, degradeCoverageOk);

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeBatchTracked's own bounded multi-file retry (card 67030bb9) fires on a genuine identifiable batch gate failure, lands the WHOLE batch on a retry-assisted pass with the batch-specific weaker-pass wording (both on the sync return and on gate_status, and durationMs stays bounded to attempt 1's own run), records retryPassed:false without erasing attempt 1's own diagnosis when the retry ALSO fails, correctly reports gateRan:true/a real durationMs when the retry's own admission is cancelled while queued, and records WHY when the retry mechanism was never eligible to begin with."
  : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);