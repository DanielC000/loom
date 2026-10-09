import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 92be634e, LEAD round-2 ruling 3: when the reduced gate's --only-file= overflow write
// (buildReducedGateCommand) fails INSIDE the batch path's own `runGate` closure (sessions/service.ts,
// `mergeBatchTracked`), it must be caught and resolved as an ORDINARY pre-gate failure (an ordinary
// BatchGateResult `{passed:false, reason}`) — never left to propagate past `runGate` and be classified by
// the OUTER batch attach() as a genuinely unknown post-gate state (`"unknown"`, the same bucket a real
// unexpected crash falls into). Nothing has run yet at the point this fails, so `runBatchedMerge`'s own
// `!gate.passed` branch routes it through the normal "nothing landed, fall back to each candidate's own
// solo worker_merge_confirm" path — exactly like any other RED gate.
//
// REAL git on a temp repo (same `_emit-compare-fixtures.mjs` machinery batch-merge-reduced-gate.mjs
// already uses), a REAL oversized changedTestFiles set (one candidate branch adds enough new, hermetic,
// top-level test/*.mjs files to cross REDUCED_GATE_ONLY_INLINE_MAX_CHARS for real — never asserted via a
// stub), and a REAL write failure (a regular file pre-created at the exact path GATE_SPILL_DIR needs to
// become a directory, so `writeReducedGateOnlyFileReal`'s own `mkdirSync` genuinely throws).
//
// Kept in its own file, not added to batch-merge-reduced-gate.mjs, for the same per-file timeout-ceiling
// reason that file's own header already documents having been split for (card 4dfc648a) — writing ~150+
// real fixture files is extra wall time this scenario alone should not add to that file's own margin.
import fs from "node:fs";
import path from "node:path";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", `loom-bmof-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { GIT_ID, FULL_GATE, mk, makeRepoWithBaseSrcFile, writeRealTestDaemonScript, BASE_SRC, now } = await import("./_emit-compare-fixtures.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, REDUCED_GATE_ONLY_INLINE_MAX_CHARS } = await import("../dist/git/worktrees.js");
const { GATE_SPILL_DIR } = await import("../dist/orchestration/gate-spill.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const PINNED_SYNC_BUDGET_MS = 600_000; // same pinning rationale as batch-merge-reduced-gate.mjs's own const

function seedBatchProject(db, p) {
  db.insertProject({ id: p.projId, name: "BMOF", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand: FULL_GATE } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}

function seedWorker(db, p, worker) {
  db.insertTask({ id: worker.taskId, projectId: p.projId, title: `feat(test): ${worker.label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: worker.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: worker.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: worker.taskId, worktreePath: worker.worktreePath, branch: worker.branch });
}

// Computes how many `<nameFn(n)>` names are needed to push the rendered `--only=<names>` step past
// REDUCED_GATE_ONLY_INLINE_MAX_CHARS, plus a safety margin — never a hardcoded file count, so this stays
// correct if the threshold constant (or a candidate's own name prefix length) ever changes. Parameterized
// by `nameFn` so EACH candidate's own real crossing count is computed against ITS OWN name prefix, never
// assumed as a fraction of another candidate's count (different prefix lengths cross at different counts).
const ONLY_PREFIX = "pnpm --filter @loom/daemon test:daemon --only=";
const PAD_NAME = (n) => `bmof-overflow-padding-file-${String(n).padStart(4, "0")}`;
const PAD_NAME_B = (n) => `bmof-b-overflow-padding-file-${String(n).padStart(4, "0")}`;
function neededPadCount(nameFn = PAD_NAME) {
  let n = 0;
  let total = ONLY_PREFIX.length;
  while (total <= REDUCED_GATE_ONLY_INLINE_MAX_CHARS) {
    total += nameFn(n).length + 1;
    n++;
  }
  return n + 20; // safety margin past the exact crossing point
}

const dbs = [];
const worktrees = [];
try {
  const P = mk("bmof");
  makeRepoWithBaseSrcFile(P, BASE_SRC);
  writeRealTestDaemonScript(P.repo);
  commitAll(P.repo, "chore: add real test-daemon script", GIT_ID);

  const db = new Db(); dbs.push(db);
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  let gateCalls = 0;
  const fakeGate = async (gate) => { gateCalls++; return { passed: true }; }; // never reached for the batch's OWN attempt; protects a per-candidate fallback from a real ~150-file run
  const noReap = async () => ({ killedPids: [] });
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { reapWorktreeProcesses: noReap, runGate: fakeGate, syncAttachBudgetMs: PINNED_SYNC_BUDGET_MS });
  seedBatchProject(db, P);

  // batchable.length must be >= 2 for mergeBatchTracked to even attempt a batch at all (`chosen.length < 2`
  // is an early-return well before assembly/gating — see that check's own doc, sessions/service.ts) — a
  // second, trivial test-only candidate (mirrors batch-merge-reduced-gate.mjs's own (POS) scenario) is
  // required for this test to exercise anything real, not just an unreachable-code vacuous pass.
  const wA = await createWorktree(P.repo, P.projId, `${P.taskId}-a`);
  worktrees.push(wA.worktreePath);
  const padCount = neededPadCount();
  const testDir = path.join(wA.worktreePath, "packages", "daemon", "test");
  for (let i = 0; i < padCount; i++) {
    fs.writeFileSync(path.join(testDir, `${PAD_NAME(i)}.mjs`), "console.log(\"PASS  padding\");\nprocess.exit(0);\n");
  }
  commitAll(wA.worktreePath, "test: add overflow padding files", GIT_ID);
  const workerA = { taskId: `${P.taskId}-a`, workerId: `${P.workerId}-a`, branch: wA.branch, worktreePath: wA.worktreePath, label: "a" };
  seedWorker(db, P, workerA);

  // workerB's OWN branch ALSO crosses the threshold (a smaller, independent padding set with its own
  // name prefix) — NOT a trivial one-file add. If it stayed small, its own per-candidate solo FALLBACK
  // (below) would succeed via fakeGate's {passed:true} and land for real on op 1 alone, merging/removing
  // workerB before the re-fire recall scenario (further down) ever gets to reuse the SAME workerSessionIds.
  // Crossing the threshold on BOTH candidates means BOTH fallbacks hit the SAME blocked GATE_SPILL_DIR and
  // land nothing either, leaving both candidates valid for the re-fire.
  const wB = await createWorktree(P.repo, P.projId, `${P.taskId}-b`);
  worktrees.push(wB.worktreePath);
  const padCountB = neededPadCount(PAD_NAME_B);
  const testDirB = path.join(wB.worktreePath, "packages", "daemon", "test");
  for (let i = 0; i < padCountB; i++) {
    fs.writeFileSync(path.join(testDirB, `${PAD_NAME_B(i)}.mjs`), "console.log(\"PASS  padding\");\nprocess.exit(0);\n");
  }
  commitAll(wB.worktreePath, "test: add bmof-b overflow padding files", GIT_ID);
  const expectedLenB = ONLY_PREFIX.length + Array.from({ length: padCountB }, (_, i) => PAD_NAME_B(i)).join(",").length;
  check("[setup] workerB's OWN padding set also genuinely crosses the threshold (its solo fallback must also hit the block)", expectedLenB > REDUCED_GATE_ONLY_INLINE_MAX_CHARS);
  const workerB = { taskId: `${P.taskId}-b`, workerId: `${P.workerId}-b`, branch: wB.branch, worktreePath: wB.worktreePath, label: "b" };
  seedWorker(db, P, workerB);

  const expectedLen = ONLY_PREFIX.length + Array.from({ length: padCount }, (_, i) => PAD_NAME(i)).join(",").length;
  check("[setup] the padding set genuinely crosses REDUCED_GATE_ONLY_INLINE_MAX_CHARS", expectedLen > REDUCED_GATE_ONLY_INLINE_MAX_CHARS);

  // THE FAILURE INJECTION: a regular FILE sits where GATE_SPILL_DIR needs to become a directory, so
  // `writeReducedGateOnlyFileReal`'s own `fs.mkdirSync(dirname, {recursive:true})` genuinely throws
  // (ENOTDIR/EEXIST) the first time any reduced gate on this LOOM_HOME tries to write an overflow file.
  fs.mkdirSync(path.dirname(GATE_SPILL_DIR), { recursive: true });
  fs.writeFileSync(GATE_SPILL_DIR, "a plain file blocking the real gate-output directory\n", "utf8");
  check("[setup] GATE_SPILL_DIR's own path is genuinely blocked by a file, not a directory", fs.statSync(GATE_SPILL_DIR).isFile());

  // LEAD round-3 ruling 2: a batch prep failure (this one) must NEVER touch merge-gate state
  // (recordMergeGateFailure/gateOwed/the failure ring/the ungated-interval counter) — snapshot BEFORE,
  // compare AFTER. `getMergeGateState` is a plain DB read, no SessionService wrapper needed.
  const mergeGateStateBefore = db.getMergeGateState(P.projId);

  const r = await sessions.mergeBatchTracked(P.mgrId, [workerA.workerId, workerB.workerId]);
  let value;
  let opId;
  if (!r.settled) {
    opId = r.op.opId;
    await waitUntil(() => sessions.gateStatus(opId).state === "settled",
      { timeoutMs: 60_000, label: "batch op to settle asynchronously (missed the sync-wait budget)" });
    value = undefined;
  } else {
    value = r.ok ? r.value : undefined;
    opId = value?.opId;
  }
  check("[attach] the batch attach() ITSELF settled without an attach-level error — the ReducedGateOnlyFileError never escaped runGate as an uncaught throw", r.settled ? r.ok === true : true);
  check("[setup] recovered a real opId for this op", typeof opId === "string" && opId.length > 0);

  const status = sessions.gateStatus(opId);
  check("[status] the tombstone genuinely settled (never stuck pending/queued)", status.state === "settled");
  check("[status] the synthesized verdict's skipReason names this exact failure, never a generic/'unknown' bucket",
    status.skipReason === "reduced-gate-only-file-failed");
  check("[status] the synthesized verdict's own reason names the real cause", typeof status.reason === "string" && /could not prepare the reduced gate's --only selection/.test(status.reason));
  check("[status] the synthesized verdict reads passed:false (never a fabricated pass)", status.passed === false);

  // LEAD round-3 ruling 2: merge-gate state must be byte-identical before/after — this batch prep failure
  // (and, since BOTH candidates' own padding sets cross the threshold too, their own solo fallbacks hitting
  // the SAME block) must never record a merge-gate RED for a failure where no gate step ever ran.
  const mergeGateStateAfter = db.getMergeGateState(P.projId);
  check("[merge-gate-state] gateOwed is unchanged", mergeGateStateAfter.gateOwed === mergeGateStateBefore.gateOwed);
  check("[merge-gate-state] the ungated-interval counter (ungatedSinceLastPass) is unchanged", mergeGateStateAfter.ungatedSinceLastPass === mergeGateStateBefore.ungatedSinceLastPass);
  check("[merge-gate-state] lastFailure is unchanged (still null — no real gate ever ran to fail)", mergeGateStateAfter.lastFailure === null && mergeGateStateBefore.lastFailure === null);
  check("[merge-gate-state] the failure ring (recent) is unchanged", JSON.stringify(mergeGateStateAfter.recent) === JSON.stringify(mergeGateStateBefore.recent));
  check("[merge-gate-state] the WHOLE state object is byte-identical before/after (no field this test didn't think to name)", JSON.stringify(mergeGateStateAfter) === JSON.stringify(mergeGateStateBefore));

  if (value) {
    check("[sync value] the batch itself did not land (ok:false)", value.ok === false);
    check("[sync value] reducedGateOnlyFileFailed is threaded through onto the sync return", value.reducedGateOnlyFileFailed === true);
    check("[sync value] the irreversible fast-forward write was never reached (landingStarted absent, no batchHeadSha) — 'nothing landed' means this, not a re-derivation of the ASSEMBLED candidate count",
      value.landingStarted === undefined && value.batchHeadSha === undefined);
    check("[sync value] both candidates were handed the normal per-candidate fallback (started, one way or another)", Array.isArray(value.fallback) && value.fallback.length === 2);
  } else {
    console.log("ℹ sync MergeBatchResult unavailable (async-degrade path) — the gate_status assertions above already cover the outcome shape.");
  }

  // STRUCTURAL PIN: the batch runGate closure actually catches ReducedGateOnlyFileError and returns an
  // ordinary BatchGateResult, rather than letting it propagate — grepped directly against committed source
  // (mirrors merge-confirm-squash-refusal-recall.mjs's own structural-pin scenario (s)).
  const src = fs.readFileSync(new URL("../src/sessions/service.ts", import.meta.url), "utf8");
  check("[structural] the batch runGate closure catches ReducedGateOnlyFileError and returns passed:false (never lets it propagate)",
    /if \(err instanceof ReducedGateOnlyFileError\) \{[\s\S]{0,500}?return \{ passed: false, reason:/.test(src));
  check("[structural] the batch onSettle hook (not the runGate happy-path tail) owns the only-file cleanup, so it fires on every outcome",
    /this\.db\.settlePendingGateOp\(opId, verdict\);\s*\n\s*\/\/ Card 92be634e: best-effort cleanup[\s\S]{0,500}fs\.rmSync\(gateOnlyListPath\(opId\), \{ force: true \}\)/.test(src));
  check("[structural] mergeBatchTracked's own classifyOutcome carries the reducedGateOnlyFileFailed branch too (a separate lambda from the solo path's — the round-2 fix only touched the solo one)",
    /outcome\.value\.unverified \? "ff-unverified" : outcome\.value\.reducedGateOnlyFileFailed \? "reduced-gate-only-file-failed" : outcome\.value\.ok \? "landed"/.test(src));

  // LEAD round-3 ruling 1: RE-FIRE RECALL — the SAME workerSessionIds, after the block clears, must NOT
  // replay op 1's cached "reduced-gate-only-file-failed" refusal (mergeBatchTracked's own classifyOutcome
  // needed its own branch; the solo path's fix does not cover it). gateCallsBeforeRefire lets the
  // assertion below tell "op 2 genuinely re-ran the gate" apart from "op 2 was served from cache".
  fs.rmSync(GATE_SPILL_DIR, { force: true }); // clear the blocking condition — the human-fix analogue
  const gateCallsBeforeRefire = gateCalls;
  const r2 = await sessions.mergeBatchTracked(P.mgrId, [workerA.workerId, workerB.workerId]);
  let value2;
  let opId2;
  if (!r2.settled) {
    opId2 = r2.op.opId;
    await waitUntil(() => sessions.gateStatus(opId2).state === "settled",
      { timeoutMs: 60_000, label: "re-fired batch op to settle asynchronously" });
    value2 = undefined;
  } else {
    value2 = r2.ok ? r2.value : undefined;
    opId2 = value2?.opId;
  }
  check("[refire] the re-fire is NOT a replay of op 1's stale refusal (cacheHit undefined)", r2.cacheHit === undefined);
  check("[refire] a genuinely NEW op was minted (a different opId from op 1)", typeof opId2 === "string" && opId2.length > 0 && opId2 !== opId);
  check("[refire] the batch gate genuinely re-ran this time (gateCalls increased)", gateCalls > gateCallsBeforeRefire);
  const status2 = sessions.gateStatus(opId2);
  check("[refire] op 2 settled with a genuinely different outcome (passed:true this time, not the stale refusal replayed)", status2.passed === true);
  if (value2) {
    check("[refire] op 2 actually landed both candidates this time", value2.ok === true && Array.isArray(value2.landed) && value2.landed.length === 2);
  } else {
    console.log("ℹ op 2's sync MergeBatchResult unavailable (async-degrade path) — the gate_status assertions above already cover the outcome shape.");
  }

  console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILED`);
} finally {
  try { fs.rmSync(GATE_SPILL_DIR, { force: true }); } catch { /* best-effort teardown of the blocking file */ }
  for (const wt of worktrees) { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ } }
  for (const db of dbs) { try { db.close?.(); } catch { /* best-effort */ } }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.exit(failures === 0 ? 0 : 1);
