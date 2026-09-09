import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH GATE RESUME-REMAINING-STEPS test (card 7ad12202, Code Review BLOCKING [2]): the solo
// `confirmWorkerMerge` resume path (merge-gate-resume-remaining-steps.mjs) was covered end to end, but the
// IDENTICAL, near-duplicated resume logic on the `mergeBatchTracked` path had ZERO test coverage — the
// only existing batch retry test (batch-merge-gate-retry.mjs) uses a single-step fixture gateCommand
// ("pnpm gate"), so `remaining` is structurally always `[]` there and the resume branch never executes.
// Per card 7ad12202's own doc: a batch retry is a STRONGER claim than a solo one when it lands (a green
// retry asserts EVERY assembled branch will land together) — so an untested batch resume path is the
// MORE dangerous half, not a lesser copy of the solo coverage.
//
// HERMETIC, no daemon — combines batch-merge-gate-retry.mjs's own two-real-worker-branch assembly with an
// INJECTED `runGate` seam and a multi-step gateCommand (mirrors merge-gate-resume-remaining-steps.mjs's
// own GATE_3STEP shape).
//
// Proves (mirrors the solo file's own (P)/(Q), applied to the batch path):
//   (P) THE SPECIMEN, BATCHED — a 3-step gate fails on step 2; the isolated retry of that ONE file passes;
//       the batch then RESUMES the third (never-run) step as its own separate call and, since it ALSO
//       passes, lands BOTH branches with retryWarning carrying the batch clause AND gate_status's own
//       steps covering all three configured steps.
//   (Q) THE RESUMED STEP ITSELF FAILS, BATCHED — the batch must NOT land: ok:false, nothing lands, and
//       gate_status renders "RESCUED, THEN REJECTED" (Code Review BLOCKING [1]'s batch dispatch fix),
//       never the "WEAKER PASS" wording a `retryPassed:true`-keyed dispatch would have produced.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/batch-merge-gate-resume-remaining-steps.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-brrs-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=brrs@loom -c user.name=brrs";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const GATE_3STEP = "pnpm build && node packages/daemon/test/flaky-mid.mjs && pnpm true-final";

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# brrs\n");
  execSync(`git init -q && git config user.email brrs@loom && git config user.name brrs`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function cutBranch(repo, projId, label, file, content) {
  const taskId = `brrs-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, `${label}`, GIT_ID);
  return { taskId, branch, worktreePath };
}

// Mirrors merge-gate-resume-remaining-steps.mjs's own `plantTestFile`, applied lazily inside the fakeGate
// (mirrors batch-merge-gate-retry.mjs's own convention) since the BATCH worktree doesn't exist yet when
// the test starts — mergeBatchTracked cuts it internally.
function plantTestFile(worktreePath, name) {
  fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
  fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "test"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", `${name}.mjs`), "// stub\n");
}

function setupBatchProject(label) {
  const projId = `brrs-${label}-proj-${sfx}`, agentId = `brrs-${label}-agent-${sfx}`, mgrId = `brrs-${label}-mgr-${sfx}`;
  const repo = path.join(os.tmpdir(), `loom-brrs-${label}-${sfx}`);
  return { projId, agentId, mgrId, repo };
}

async function seedTwoWorkers(db, P) {
  makeRepo(P.repo);
  db.insertProject({ id: P.projId, name: `BRRS-${P.projId}`, repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: GATE_3STEP } }, createdAt: now, archivedAt: null });
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

// Mirrors batch-merge-gate-retry.mjs's own `resolveBatch` — tolerates the documented sync-vs-async-degrade
// split, unconditionally recovering `opId` either way so the gate_status checks below always have one.
async function resolveBatch(sessions, batchPromise) {
  const r = await batchPromise;
  if (!r.settled) {
    await waitUntil(() => sessions.gateStatus(r.op.opId).state === "settled",
      { timeoutMs: 60_000, label: "batch op to settle asynchronously (missed the sync-wait budget)" });
  }
  if (!r.settled) return { settled: true, ok: undefined, value: undefined, opId: r.op.opId };
  return { settled: true, ok: r.ok, value: r.ok ? r.value : undefined, opId: r.ok ? r.value?.opId : r.value?.opId };
}

const dbs = [];
const worktrees = [];
try {
  // ── (P) THE SPECIMEN, BATCHED — non-final step fails, isolated retry passes, RESUME lands BOTH branches ──
  {
    const P = setupBatchProject("p");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const seenGates = [];
    const fakeGate = async (gate, worktreePath) => {
      calls++; seenGates.push(gate);
      if (calls === 1) {
        plantTestFile(worktreePath, "flaky-batch-mid");
        // Same specimen shape as the solo file's own (P): step 2 of 3 fails, step 3 never spawns.
        // outputTail starts with the `- <name> (exit timeout` marker at position 0 (no leading `\n` —
        // control chars incl. `\n` are stripped before storage; see the solo test's own note).
        return {
          passed: false, failedStep: "node packages/daemon/test/flaky-batch-mid.mjs", failedStatus: 1, failedSignal: null, failedTimedOut: false,
          outputTail: "- flaky-batch-mid (exit timeout (120000ms)):", failingTest: "FAIL  flaky-batch-mid", failingTestCount: 1, failTierTest: "FAIL  flaky-batch-mid", failTierTestCount: 1, failTierAll: ["FAIL  flaky-batch-mid"],
          steps: [{ step: "pnpm build", durationMs: 10, status: 0 }, { step: "node packages/daemon/test/flaky-batch-mid.mjs", durationMs: 20, status: 1 }],
        };
      }
      if (calls === 2) return { passed: true, steps: [{ step: "node packages/daemon/scripts/test-daemon.mjs --only=flaky-batch-mid", durationMs: 5, status: 0 }] };
      // calls === 3: the RESUMED run of whatever never ran — must be JUST the third step.
      return { passed: true, outputTail: "true-final output, nothing about flaky-batch-mid here", steps: [{ step: "pnpm true-final", durationMs: 3, status: 0 }] };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { wA, wB, worktrees: wts } = await seedTwoWorkers(db, P);
    worktrees.push(...wts);

    const outcome = await resolveBatch(sessions, sessions.mergeBatchTracked(P.mgrId, [wA, wB]));
    check("(P-batch) exactly 3 gate calls (attempt 1, single-file retry, resume of the never-run step)", calls === 3);
    check("(P-batch) call 1 is the full configured 3-step gate", seenGates[0] === GATE_3STEP);
    check("(P-batch) call 2 is the single-file isolated retry, not the whole gate", seenGates[1] === "node packages/daemon/scripts/test-daemon.mjs --only=flaky-batch-mid");
    check("(P-batch) call 3 resumes ONLY the never-run third step — never re-running steps 1-2", seenGates[2] === "pnpm true-final");
    const page = db.listGateEvents({ projectId: P.projId, limit: 50, offset: 0 });
    const row = page.items.find((r) => r.branch === null);
    if (outcome.value) {
      check("(P-batch) THE FIX: ok:true, BOTH branches landed only because the resume ALSO passed", outcome.value.ok === true && outcome.value.landed.length === 2);
      check("(P-batch) retriedFile/retryPassed still name the single-file rescue", outcome.value.retriedFile === "flaky-batch-mid" && outcome.value.retryPassed === true);
      check("(P-batch) retryWarning carries the BATCH clause naming landed.length (2)", typeof outcome.value.retryWarning === "string" && outcome.value.retryWarning.includes("BATCH of 2 branch(es)"));
    } else {
      console.log("(P-batch) NOTE: settled via the async degrade path — MergeBatchResult is not recoverable that way; skipping the 3 return-value assertions above. DB/gate_status checks below are unconditional.");
    }
    check("(P-batch) a build_gate row exists for the batch op", !!row);
    check("(P-batch) the row passed, batched:true, branchCount:2", row?.passed === true && row?.batched === true && row?.branchCount === 2);
    // Card 7ad12202: GateHistoryRow (db.ts's toGateHistoryRow) does NOT project a `steps` field at all —
    // unlike the solo file's own check, DoD-3's "what a manager sees" for `steps[]` completeness is only
    // ever readable via gate_status(opId), never off the durable row directly.
    const st = row?.opId ? sessions.gateStatus(row.opId) : undefined;
    check("(P-batch) DoD-3, what a manager NOW SEES: gate_status's own steps cover ALL THREE configured steps, not just the two attempt 1 ran",
      Array.isArray(st?.steps) && st.steps.length === 3 &&
      JSON.stringify(st.steps.map((s) => s.step)) === JSON.stringify(["pnpm build", "node packages/daemon/test/flaky-batch-mid.mjs", "pnpm true-final"]));
    check("(P-batch) CODE REVIEW FINDING [4], BATCHED: gate_status's retryWarning classifies the ORIGINAL retried file's failure as a timeout kill — only possible if attempt 1's own outputTail (not the resumed step's unrelated one) fed the classification",
      typeof st?.retryWarning === "string" && st.retryWarning.includes("⚠ WEAKER PASS") && st.retryWarning.includes("on a timeout") && st.retryWarning.includes("BATCH of 2 branch(es)"));
  }

  // ── (Q) THE RESUMED STEP ITSELF GENUINELY FAILS, BATCHED — must NOT land ────────────────────────────────
  {
    const Q = setupBatchProject("q");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const seenGates = [];
    const fakeGate = async (gate, worktreePath) => {
      calls++; seenGates.push(gate);
      if (calls === 1) {
        plantTestFile(worktreePath, "flaky-batch-mid2");
        return {
          passed: false, failedStep: "node packages/daemon/test/flaky-batch-mid2.mjs", failedStatus: 1, failedSignal: null, failedTimedOut: false,
          outputTail: "", failingTest: "FAIL  flaky-batch-mid2", failingTestCount: 1, failTierTest: "FAIL  flaky-batch-mid2", failTierTestCount: 1, failTierAll: ["FAIL  flaky-batch-mid2"],
          steps: [{ step: "pnpm build", durationMs: 10, status: 0 }, { step: "node packages/daemon/test/flaky-batch-mid2.mjs", durationMs: 20, status: 1 }],
        };
      }
      if (calls === 2) return { passed: true, steps: [{ step: "node packages/daemon/scripts/test-daemon.mjs --only=flaky-batch-mid2", durationMs: 5, status: 0 }] };
      if (calls === 3) {
        // The resumed third step is GENUINELY broken — must not be masked by the earlier rescue, and
        // NOTHING must land despite the retry having passed.
        return { passed: false, failedStep: "pnpm true-final", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "boom", steps: [{ step: "pnpm true-final", durationMs: 3, status: 1 }] };
      }
      // Calls 4+ are the rejected batch's own per-candidate FALLBACK (mirrors batch-merge-gate-retry.mjs's
      // own (iv) test convention): a rejected batch re-gates each worker SOLO via confirmWorkerMergeTracked.
      // No failTierAll here, so identifyRetriableTestFiles declines (no-fail-tier-match) and each solo
      // confirm just rejects cleanly, with no further retry/resume cascading through this SAME fakeGate.
      return { passed: false, failedStep: "pnpm true-final", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "fallback also failed", failingTest: "boom" };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { wA, wB, worktrees: wts } = await seedTwoWorkers(db, Q);
    worktrees.push(...wts);

    const outcome = await resolveBatch(sessions, sessions.mergeBatchTracked(Q.mgrId, [wA, wB]));
    check("(Q-batch) exactly 3 gate calls to the BATCH gate itself (attempt 1, single-file retry, resume) before any fallback call", seenGates[0] === GATE_3STEP && seenGates[1] === "node packages/daemon/scripts/test-daemon.mjs --only=flaky-batch-mid2" && seenGates[2] === "pnpm true-final");
    if (outcome.value) {
      check("(Q-batch) THE NON-NEGOTIABLE PART: ok:false — a broken later step is never masked by the earlier rescue, even in a batch", outcome.value.ok === false);
    } else {
      console.log("(Q-batch) NOTE: settled via the async degrade path — MergeBatchResult is not recoverable that way; skipping the ok:false return-value assertion. DB/gate_status checks below are unconditional.");
    }
    const page = db.listGateEvents({ projectId: Q.projId, limit: 50, offset: 0 });
    const row = page.items.find((r) => r.branch === null);
    check("(Q-batch) the durable row records the rejection, batched:true, branchCount:2, passed:false", row?.passed === false && row?.batched === true && row?.branchCount === 2);
    check("(Q-batch) retriedFile/retryPassed:true still recorded — the single-file rescue itself genuinely passed", row?.retriedFile === "flaky-batch-mid2" && row?.retryPassed === true);
    const st = row?.opId ? sessions.gateStatus(row.opId) : undefined;
    check("(Q-batch) CODE REVIEW BLOCKING [1], BATCHED: gate_status's retryWarning is NEVER 'WEAKER PASS' prose on a rejected batch op, even though the isolated retry itself genuinely passed (retryPassed:true)",
      typeof st?.retryWarning === "string" && st.retryWarning.includes("RESCUED, THEN REJECTED") && !st.retryWarning.includes("WEAKER PASS"));
    check("(Q-batch) the gate_status record's own passed field is false — the retryWarning dispatch must key off THIS (via result.gatePassed), never off retryPassed alone", st?.passed === false);
    for (const wId of [wA, wB]) {
      check(`(Q-batch) worker ${wId}'s task NOT moved to done`, db.getTask(db.getSession(wId).taskId).columnKey !== "done");
    }
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — the batch path's identical resume-remaining-steps logic is now exercised end to end: a rescued single-file retry resumes whatever step(s) the original `&&` short-circuit never ran before landing EVERY assembled branch, and a genuinely broken resumed step lands NOTHING, with gate_status rendering the correct (never 'WEAKER PASS') wording either way."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (const db of dbs) { try { db.close?.(); } catch { /* best-effort */ } }
  for (const wt of worktrees) { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ } }
}
process.exit(failures === 0 ? 0 : 1);
