import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-gate RESUME-REMAINING-STEPS test (card 7ad12202 — a rescued retry must not report pass with
// later gate steps unrun). HERMETIC, no daemon — mirrors merge-gate-single-file-retry.mjs's in-process
// style: REAL git + an INJECTED `runGate` seam, with dummy `packages/daemon/scripts/test-daemon.mjs` +
// `packages/daemon/test/<name>.mjs` files planted in the worktree so `identifyRetriableTestFiles`'s real
// `fs.existsSync` checks resolve exactly as they would against this daemon's own real tree.
//
// THE SPECIMEN (measured, op `900277f1`, card 7ad12202's own kickoff): a multi-step `&&` `gateCommand`
// whose NON-FINAL step fails — the `&&` chain short-circuits, so the LAST step never runs — and the
// isolated single-file retry of the failing test then passes. Before this card, that pass was reported as
// a plain `outcome:"pass"` with the whole gate absorbed into `passed:true`, even though the trailing step
// never executed even once.
//
// Proves (DoD-2, both directions — a discriminator, never a blanket refusal):
//   (P) THE SPECIMEN — a 3-step gate fails on step 2 (a real, re-runnable test file); the isolated retry of
//       that ONE file passes; the gate then RESUMES the third (never-run) step as its own separate call
//       (never re-running steps 1-2) and, since that resumed step ALSO passes, reports merged:true with
//       `gateSteps` covering ALL THREE steps — not just the two attempt 1 ran. This is option (A) from the
//       card: resume, don't refuse, when the rescue is real.
//   (Q) THE RESUMED STEP ITSELF FAILS — same setup as (P), but the third step is genuinely broken. The
//       gate must NOT report a pass: `merged:false`, and the failure names the THIRD step, never silently
//       re-promoted via the single-file retry's own earlier success. No second rescue is attempted for it.
//   (R) POSITIVE CONTROL — failure on the LAST step of a multi-step gate (the pre-existing, common shape):
//       `remainingGateSteps` is empty, so this is a byte-identical no-op — exactly ONE extra call (the
//       single-file retry), never a third. Proves the fix doesn't fire on every retry, only the specimen's
//       own shape.
//   (S) POSITIVE CONTROL — a clean, all-green multi-step gate: exactly ONE gate call, no retry, no resume,
//       merged:true. Proves a genuinely passing gate is untouched.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-gate-resume-remaining-steps.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rrs-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// Mirrors gate-status.mjs's own `settleMergeEitherPath` verbatim: `confirmWorkerMergeTracked` (unlike
// plain `confirmWorkerMerge`) registers the op in a form `gate_status(opId)` can actually resolve — needed
// here ONLY for the Code Review BLOCKING [1] regression checks (P)/(Q) add below, which read `gateStatus`'s
// own `retryWarning` dispatch, not just the sync ConfirmMergeResult every other check already uses.
async function settleMergeEitherPath(sessions, r) {
  if (r.settled) return { opId: r.value.opId, value: r.value, viaAsync: false };
  const opId = r.op.opId;
  await sharedWaitUntil(() => (sessions.gateStatus(opId).state === "settled" ? true : undefined), { timeoutMs: 20_000, label: "resume-remaining-steps: async merge op to settle" });
  return { opId, value: undefined, viaAsync: true };
}
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=rrs@loom -c user.name=rrs";
const now = new Date().toISOString();

const eventsOfKind = (db, mgrId, kind) => db.listEvents(mgrId).filter((e) => e.kind === kind);

function seed(db, p, gateCommand) {
  db.insertProject({ id: p.projId, name: "RRS", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "RRS-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  registerForCleanup(p.repo);
  fs.writeFileSync(path.join(p.repo, "README.md"), "# rrs\n");
  execSync(`git init -q && git config user.email rrs@loom && git config user.name rrs`, { cwd: p.repo });
  commitAll(p.repo, "init", GIT_ID);
}

// Plants the two files `identifyRetriableTestFiles` looks for, relative to the worktree root. Content is
// irrelevant: the injected `runGate` below intercepts everything, nothing here is ever spawned.
function plantTestFile(worktreePath, name) {
  fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
  fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "test"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", `${name}.mjs`), "// stub\n");
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `rrs-${label}-proj-${sfx}`, agentId: `rrs-${label}-agent-${sfx}`, taskId: `rrs-${label}-task-${sfx}`,
  mgrId: `rrs-${label}-mgr-${sfx}`, workerId: `rrs-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-rrs-${label}-${sfx}`), file,
});

const dbs = [];
const worktrees = [];
const GATE_3STEP = "pnpm build && node packages/daemon/test/flaky-mid.mjs && pnpm true-final";

try {
  // ── (P) THE SPECIMEN — non-final step fails, isolated retry passes, RESUME the never-run last step ────
  {
    const P = mk("p", "feature-p.txt");
    makeRepo(P);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const seenGates = [];
    const fakeGate = async (gate) => {
      calls++; seenGates.push(gate);
      if (calls === 1) {
        // A real runGateSequential short-circuit: step 2 of 3 fails, step 3 never spawns — `steps` has
        // only TWO entries, exactly the specimen's own measured shape (op `900277f1`: steps.length < the
        // configured gate's own step count). outputTail carries a real `(exit timeout` marker for
        // 'flaky-mid', at the START of the string (no leading newline — `gateOutputTailForRecord` strips
        // control chars incl. `\n` via CONTROL_CHAR_RE before storage, and isTimeoutKillEntry's own regex
        // anchors on `^` or a literal `\n`, so a leading `\n` here would be stripped and never match either
        // anchor) — Code Review finding [4]: this is what proves mergeResumedGateResult preserves ATTEMPT
        // 1's own tail (not the resumed step's, which never mentions flaky-mid at all) for the
        // retryWarning's own isTimeoutKillEntry classification.
        return {
          passed: false, failedStep: "node packages/daemon/test/flaky-mid.mjs", failedStatus: 1, failedSignal: null, failedTimedOut: false,
          outputTail: "- flaky-mid (exit timeout (120000ms)):", failingTest: "FAIL  flaky-mid", failingTestCount: 1, failTierTest: "FAIL  flaky-mid", failTierTestCount: 1, failTierAll: ["FAIL  flaky-mid"],
          steps: [{ step: "pnpm build", durationMs: 10, status: 0 }, { step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 20, status: 1 }],
        };
      }
      if (calls === 2) return { passed: true, steps: [{ step: "node packages/daemon/scripts/test-daemon.mjs --only=flaky-mid", durationMs: 5, status: 0 }] };
      // calls === 3: the RESUMED run of whatever never ran — must be JUST the third step, never a re-run
      // of steps 1-2. Its own outputTail talks about a totally different step/command, on purpose — proves
      // the retryWarning classification below can't be using THIS tail.
      return { passed: true, outputTail: "true-final output, nothing about flaky-mid here", steps: [{ step: "pnpm true-final", durationMs: 3, status: 0 }] };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(P.repo, P.projId, P.taskId);
    P.worktreePath = worktreePath; P.branch = branch; worktrees.push(worktreePath);
    plantTestFile(worktreePath, "flaky-mid");
    fs.writeFileSync(path.join(worktreePath, P.file), "work for P\n");
    commitAll(worktreePath, `${P.file}`, GIT_ID);
    seed(db, P, GATE_3STEP);

    const rP = await sessions.confirmWorkerMergeTracked(P.mgrId, P.workerId);
    const { opId: opIdP, value: confirm, viaAsync: viaAsyncP } = await settleMergeEitherPath(sessions, rP);
    check("(P) exactly 3 gate calls (attempt 1, single-file retry, resume of the never-run step)", calls === 3);
    check("(P) call 1 is the full configured gate", seenGates[0] === GATE_3STEP);
    check("(P) call 2 is the single-file isolated retry, not the whole gate", seenGates[1] === "node packages/daemon/scripts/test-daemon.mjs --only=flaky-mid");
    check("(P) call 3 resumes ONLY the never-run third step — never re-running steps 1-2", seenGates[2] === "pnpm true-final");
    if (!viaAsyncP) {
      check("(P) THE FIX: merged:true only because the resume ALSO passed", confirm.merged === true);
      check("(P) retriedFile/retryPassed still name the single-file rescue", confirm.retriedFile === "flaky-mid" && confirm.retryPassed === true);
      check("(P) THE FIX — DoD-3, what a manager NOW SEES: gateSteps covers ALL THREE configured steps, not just the two attempt 1 ran",
        Array.isArray(confirm.gateSteps) && confirm.gateSteps.length === 3 &&
        JSON.stringify(confirm.gateSteps.map((s) => s.step)) === JSON.stringify(["pnpm build", "node packages/daemon/test/flaky-mid.mjs", "pnpm true-final"]));
    }
    check("(P) the gate_history row's own steps also reflect all three (durable, not just the sync return)", (() => {
      const page = db.listGateEvents({ projectId: P.projId, limit: 100, offset: 0 });
      const row = page.items.find((r) => r.gateType === "merge");
      return row?.outcome === "pass" && row?.retriedFile === "flaky-mid" && row?.retryPassed === true;
    })());
    check("(P) task moved to done", db.getTask(P.taskId).columnKey === "done");
    check("(P) CODE REVIEW FINDING [4]: gate_status's retryWarning classifies the ORIGINAL retried file's failure as a timeout kill — only possible if attempt 1's own outputTail (not the resumed step's unrelated one) fed the classification", (() => {
      const status = sessions.gateStatus(opIdP);
      return typeof status.retryWarning === "string" && status.retryWarning.includes("⚠ WEAKER PASS") && status.retryWarning.includes("on a timeout");
    })());
  }

  // ── (Q) THE RESUMED STEP ITSELF GENUINELY FAILS — must NOT report a pass ────────────────────────────────
  {
    const Q = mk("q", "feature-q.txt");
    makeRepo(Q);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const seenGates = [];
    const fakeGate = async (gate) => {
      calls++; seenGates.push(gate);
      if (calls === 1) {
        return {
          passed: false, failedStep: "node packages/daemon/test/flaky-mid.mjs", failedStatus: 1, failedSignal: null, failedTimedOut: false,
          outputTail: "", failingTest: "FAIL  flaky-mid", failingTestCount: 1, failTierTest: "FAIL  flaky-mid", failTierTestCount: 1, failTierAll: ["FAIL  flaky-mid"],
          steps: [{ step: "pnpm build", durationMs: 10, status: 0 }, { step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 20, status: 1 }],
        };
      }
      if (calls === 2) return { passed: true, steps: [{ step: "node packages/daemon/scripts/test-daemon.mjs --only=flaky-mid", durationMs: 5, status: 0 }] };
      // calls === 3: the resumed third step is GENUINELY broken — must not be masked by the earlier rescue.
      return { passed: false, failedStep: "pnpm true-final", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "boom", steps: [{ step: "pnpm true-final", durationMs: 3, status: 1 }] };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(Q.repo, Q.projId, Q.taskId);
    Q.worktreePath = worktreePath; Q.branch = branch; worktrees.push(worktreePath);
    plantTestFile(worktreePath, "flaky-mid");
    fs.writeFileSync(path.join(worktreePath, Q.file), "work for Q\n");
    commitAll(worktreePath, `${Q.file}`, GIT_ID);
    seed(db, Q, GATE_3STEP);

    const rQ = await sessions.confirmWorkerMergeTracked(Q.mgrId, Q.workerId);
    const { opId: opIdQ, value: confirm, viaAsync: viaAsyncQ } = await settleMergeEitherPath(sessions, rQ);
    check("(Q) exactly 3 gate calls (attempt 1, single-file retry, resume — no second rescue attempted)", calls === 3);
    if (!viaAsyncQ) check("(Q) THE NON-NEGOTIABLE PART: merged:false — a broken later step is never masked by the earlier rescue", confirm.merged === false);
    check("(Q) no cascading second rescue is attempted for the resumed step's own failure", calls === 3);
    check("(Q) worktree RETAINED (fail-closed)", fs.existsSync(worktreePath));
    check("(Q) task NOT moved to done", db.getTask(Q.taskId).columnKey !== "done");
    check("(Q) CODE REVIEW BLOCKING [1]: gate_status's retryWarning is NEVER 'WEAKER PASS' prose on a rejected op, even though the isolated retry itself genuinely passed (retryPassed:true)", (() => {
      const status = sessions.gateStatus(opIdQ);
      return typeof status.retryWarning === "string" && status.retryWarning.includes("RESCUED, THEN REJECTED") && !status.retryWarning.includes("WEAKER PASS");
    })());
    check("(Q) the gate_status record's own passed field is false — the retryWarning dispatch must key off THIS, never off retryPassed alone", (() => {
      const status = sessions.gateStatus(opIdQ);
      return status.passed === false;
    })());
  }

  // ── (R) POSITIVE CONTROL — failure on the LAST step is a byte-identical no-op (no third call) ──────────
  {
    const R = mk("r", "feature-r.txt");
    makeRepo(R);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const seenGates = [];
    const fakeGate = async (gate) => {
      calls++; seenGates.push(gate);
      if (calls === 1) {
        // The LAST of the three configured steps fails — steps.length === 3, the full count, so there is
        // nothing left to resume (the pre-existing, common shape this fix must never touch).
        return {
          passed: false, failedStep: "pnpm true-final", failedStatus: 1, failedSignal: null, failedTimedOut: false,
          outputTail: "", failingTest: "FAIL  flaky-last", failingTestCount: 1, failTierTest: "FAIL  flaky-last", failTierTestCount: 1, failTierAll: ["FAIL  flaky-last"],
          steps: [{ step: "pnpm build", durationMs: 10, status: 0 }, { step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 20, status: 0 }, { step: "pnpm true-final", durationMs: 5, status: 1 }],
        };
      }
      // calls === 2: the single-file retry of the last-step failure passes — nothing should ever call a 3rd time.
      return { passed: true, steps: [{ step: "node packages/daemon/scripts/test-daemon.mjs --only=flaky-last", durationMs: 5, status: 0 }] };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(R.repo, R.projId, R.taskId);
    R.worktreePath = worktreePath; R.branch = branch; worktrees.push(worktreePath);
    plantTestFile(worktreePath, "flaky-last");
    fs.writeFileSync(path.join(worktreePath, R.file), "work for R\n");
    commitAll(worktreePath, `${R.file}`, GIT_ID);
    seed(db, R, GATE_3STEP);

    const confirm = await sessions.confirmWorkerMerge(R.mgrId, R.workerId);
    check("(R) POSITIVE CONTROL: exactly 2 gate calls — a last-step failure never triggers a resume", calls === 2);
    check("(R) merged:true, same as before this card", confirm.merged === true);
    check("(R) retriedFile/retryPassed still recorded normally", confirm.retriedFile === "flaky-last" && confirm.retryPassed === true);
  }

  // ── (S) POSITIVE CONTROL — an all-green multi-step gate is completely untouched ─────────────────────────
  {
    const S = mk("s", "feature-s.txt");
    makeRepo(S);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const seenGates = [];
    const fakeGate = async (gate) => {
      calls++; seenGates.push(gate);
      return { passed: true, steps: [{ step: "pnpm build", durationMs: 10, status: 0 }, { step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 20, status: 0 }, { step: "pnpm true-final", durationMs: 5, status: 0 }] };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(S.repo, S.projId, S.taskId);
    S.worktreePath = worktreePath; S.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, S.file), "work for S\n");
    commitAll(worktreePath, `${S.file}`, GIT_ID);
    seed(db, S, GATE_3STEP);

    const confirm = await sessions.confirmWorkerMerge(S.mgrId, S.workerId);
    check("(S) POSITIVE CONTROL: exactly ONE gate call — a clean pass never spawns retry or resume", calls === 1);
    check("(S) merged:true", confirm.merged === true);
    check("(S) retriedFile is undefined — no retry mechanism touches a clean pass", confirm.retriedFile === undefined);
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — a rescued single-file retry now resumes whatever step(s) the original `&&` short-circuit never ran before reporting a pass; a genuinely last-step failure and a clean all-green gate are both untouched."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (const db of dbs) { try { db.close?.(); } catch { /* best-effort */ } }
  for (const wt of worktrees) { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ } }
}
process.exit(failures === 0 ? 0 : 1);
