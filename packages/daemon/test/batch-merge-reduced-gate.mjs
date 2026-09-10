import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH GATE REDUCTION (card d422e279) — proves `mergeBatchTracked`'s own gate run can substitute the
// SAME smaller command a solo `confirmWorkerMergeTracked` already substitutes, when the ASSEMBLED batch
// tree's own union of changes proves eligible via `computeEmitCompareGate` — reusing that predicate
// exactly, never a second one. Before this card, the batch path called `computeEmitCompareGate` only to
// RECORD eligibility, never to act on it, so a batch of purely test-only branches burned a full
// ~15-20min gate for zero additional verification over the reduced command (observed in production: a
// K=2 batch of two test-only branches ran past the reduced band at 676s+).
//
// REAL git on temp repos, an INJECTED `runGate` seam (mirrors emit-compare-gate.mjs's own style) that
// CAPTURES the exact command string the batch actually ran, so these assertions prove WHICH command ran,
// not just a boolean summary field.
//
// Proves, POSITIVE-CONTROL BOTH DIRECTIONS (card d422e279 DoD-4 — a test that only shows "batch ran full"
// cannot tell a working predicate from an absent one):
//   (POS) a batch of TWO test-only branches (each adds one new, hermetic, top-level test/*.mjs file, no
//         compiled .ts touched at all) -> the batch's ONE gate run is REDUCED: the captured command is
//         built via `buildReducedGateCommand` from the UNION of both branches' added test files (read
//         back from the batch's own `build_gate` event, never assumed/hardcoded), `emitCompareReduced`
//         reads back `true` on the PROJECTED `gate_history` row (not just the raw event — see Code Review
//         fold-in [4]) PAIRED with a real (non-null) `emitCompareIdenticalCount`/`emitCompareTestFiles`
//         (Code Review blocker [1]'s own positive control: this assertion is RED against pre-blocker-[1]
//         code, which left both `null` on a genuinely-reduced batch row, violating
//         `GateHistoryRow.emitCompareIdenticalCount`'s documented 1:1 pairing invariant), and the sync
//         return's `reducedGateWarning` names the isolation caveat scaled to `landedCount` (2).
//   (NEG) a batch of one test-only branch PLUS one branch with a REAL one-token BEHAVIORAL edit to a
//         compiled `packages/daemon/src/*.ts` file -> the union is NOT provably inert, so the batch's ONE
//         gate run stays FULL (captured command byte-identical to the configured `gateCommand`),
//         `emitCompareReduced` reads back `false`, and no `reducedGateWarning` is present on the return.
//   (ASSET) a batch of one branch touching `packages/daemon/assets/**` PLUS one test-only branch -> REDUCES
//         to build + static guards + the certified `ASSET_READING_TEST_REPO_PATHS` set UNIONED with the
//         added test file's own name in ONE `--only=` list (mirrors `buildReducedGateCommand`'s own
//         asset-widening behavior), and `reducedGateWarning` states the certified tests actually ran (Code
//         Review blocker [2]'s own positive control — the pre-blocker-[2] hand-rolled batch copy dropped
//         this exact statement, silently under-reporting what ran).
//   (TS) card abaaf16e — a batch of one branch with a COMMENT-ONLY compiled `.ts` edit PLUS one test-only
//         branch -> REDUCES, and the captured command folds in every `DIST_TEXT_SCANNER_REPO_PATHS`
//         member too, plus `reducedGateWarning` names the count — the batch path's own version of the
//         Code Review MAJOR fixed on the solo path (a reduced gate that ran these scanners but left the
//         warning silent about it).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/batch-merge-reduced-gate.mjs
import fs from "node:fs";
import path from "node:path";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", `loom-bmrg-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const {
  GIT_ID, FULL_GATE, ASSET_TEST_BASENAMES, DIST_SCANNER_BASENAMES, mk, mkdirp, makeRepoWithBaseSrcFile, writeRealTestDaemonScript, BASE_SRC, now,
} = await import("./_emit-compare-fixtures.mjs");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, buildReducedGateCommand } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Code Review fold-in [5]: a runner that consistently misses the sync-attach budget must NOT be able to
// print "All checks passed" having exercised zero of this file's sync-return (MergeBatchResult) assertions
// — every one of those sits inside `if (value)` below, same shape batch-merge-gate-history.mjs already
// uses, but unlike that file this one has NO durable fallback assertion for what `value` alone proves
// (reducedGateWarning has no other surface). Incremented once per scenario that observed a real sync
// settle; asserted non-zero at the very end, so "ran nothing" and "all passed" can never share an exit code.
let syncReturnsObserved = 0;

function seedBatchProject(db, p) {
  db.insertProject({ id: p.projId, name: "BMRG", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand: FULL_GATE } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}

function seedWorker(db, p, worker) {
  db.insertTask({ id: worker.taskId, projectId: p.projId, title: `feat(test): ${worker.label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: worker.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: worker.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: worker.taskId, worktreePath: worker.worktreePath, branch: worker.branch });
}

async function runBatch(sessions, db, projId, mgrId, workerIds) {
  const r = await sessions.mergeBatchTracked(mgrId, workerIds);
  let value;
  if (!r.settled) {
    await waitUntil(() => sessions.gateStatus(r.op.opId).state === "settled",
      { timeoutMs: 60_000, label: "batch op to settle asynchronously (missed the sync-wait budget)" });
    // The async-degrade path (see batch-merge-gate-history.mjs's own comment on this exact shape) has no
    // recoverable MergeBatchResult — but every assertion below only needs the DB-recorded build_gate
    // event, which is durable regardless of which path settled it.
    value = undefined;
  } else {
    value = r.ok ? r.value : undefined;
    syncReturnsObserved++;
  }
  // Neither AttachResult branch carries the opId on a SYNC settle (pending-ops.ts's own `{settled:true,
  // ok, value}` shape has no opId field at all — only the `{settled:false, op}` branch does) — recover it
  // the same way batch-merge-gate-history.mjs already does: this project's own (single) batched
  // `build_gate` row.
  const page = db.listGateEvents({ projectId: projId, limit: 50, offset: 0 });
  const row = page.items.find((e) => e.opId != null && page.items.filter((x) => x.opId === e.opId).length === 1) ?? page.items[0];
  return { opId: row?.opId, value, row };
}

const dbs = [];
const worktrees = [];
try {
  // ── (POS) a batch of TWO test-only branches -> the batch's ONE gate run itself REDUCES ────────────────
  {
    const P = mk("bmrg-pos");
    makeRepoWithBaseSrcFile(P, BASE_SRC);
    writeRealTestDaemonScript(P.repo);
    commitAll(P.repo, "chore: add real test-daemon script", GIT_ID);

    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    seedBatchProject(db, P);

    const wA = await createWorktree(P.repo, P.projId, `${P.taskId}-a`);
    worktrees.push(wA.worktreePath);
    fs.writeFileSync(path.join(wA.worktreePath, "packages", "daemon", "test", "bmrg-a-added.mjs"), "console.log(\"PASS  bmrg-a-added\");\nprocess.exit(0);\n");
    commitAll(wA.worktreePath, "test: add bmrg-a-added", GIT_ID);
    const workerA = { taskId: `${P.taskId}-a`, workerId: `${P.workerId}-a`, branch: wA.branch, worktreePath: wA.worktreePath, label: "a" };
    seedWorker(db, P, workerA);

    const wB = await createWorktree(P.repo, P.projId, `${P.taskId}-b`);
    worktrees.push(wB.worktreePath);
    fs.writeFileSync(path.join(wB.worktreePath, "packages", "daemon", "test", "bmrg-b-added.mjs"), "console.log(\"PASS  bmrg-b-added\");\nprocess.exit(0);\n");
    commitAll(wB.worktreePath, "test: add bmrg-b-added", GIT_ID);
    const workerB = { taskId: `${P.taskId}-b`, workerId: `${P.workerId}-b`, branch: wB.branch, worktreePath: wB.worktreePath, label: "b" };
    seedWorker(db, P, workerB);

    const { opId, value, row } = await runBatch(sessions, db, P.projId, P.mgrId, [workerA.workerId, workerB.workerId]);
    check("(POS) the gate command was called exactly once for the whole batch", calls === 1);
    check("(POS) captured command is NOT the full gate — the union of two test-only branches reduced", capturedGate !== FULL_GATE);

    const rawEvents = db.findGateOpEventsByOpId(opId);
    const rawBuildGate = rawEvents.find((e) => e.kind === "build_gate");
    check("(POS) build_gate event records emitCompareReduced:true", rawBuildGate?.detail?.emitCompareReduced === true);
    const recordedTestFiles = rawBuildGate?.detail?.emitCompareTestFiles;
    check("(POS) build_gate event records both added test files in emitCompareTestFiles", Array.isArray(recordedTestFiles) && recordedTestFiles.length === 2 &&
      recordedTestFiles.some((f) => f.endsWith("bmrg-a-added.mjs")) && recordedTestFiles.some((f) => f.endsWith("bmrg-b-added.mjs")));
    // Self-consistent, not order-assumed: builds the EXPECTED reduced command from the SAME recorded file
    // list the event actually carries, rather than guessing git's own diff-entry order.
    check("(POS) captured command is BYTE-IDENTICAL to buildReducedGateCommand's output for the recorded file set",
      Array.isArray(recordedTestFiles) && capturedGate === buildReducedGateCommand({ changedTestFiles: recordedTestFiles, changedAssetPaths: [], changedTsPaths: [] }));

    // Code Review fold-in [4] + blocker [1]'s own positive control: the PROJECTED gate_history row (what a
    // manager actually reads via `listGateEvents`/`toGateHistoryRow`), not the raw event above. RED against
    // pre-blocker-[1] code: `db.ts`'s old `detail.batched===true` fallback recovered ONLY
    // `emitCompareReduced`, leaving `emitCompareIdenticalCount`/`emitCompareTestFiles` `null` on a
    // genuinely-reduced batch row — violating `GateHistoryRow.emitCompareIdenticalCount`'s own documented
    // "present together or both null, never one without the other" pairing invariant (shared/types.ts).
    check("(POS) PROJECTED gate_history row: emitCompareReduced reads true", row?.emitCompareReduced === true);
    check("(POS) PROJECTED gate_history row: emitCompareIdenticalCount is PAIRED (non-null) with emitCompareReduced:true — RED on pre-blocker-[1] code", row?.emitCompareIdenticalCount !== null && row?.emitCompareIdenticalCount !== undefined);
    check("(POS) PROJECTED gate_history row: emitCompareTestFiles is PAIRED (non-null) with emitCompareReduced:true — RED on pre-blocker-[1] code", row?.emitCompareTestFiles !== null && row?.emitCompareTestFiles !== undefined);
    check("(POS) PROJECTED gate_history row: emitCompareTestFiles names both added test files", Array.isArray(row?.emitCompareTestFiles) && row.emitCompareTestFiles.length === 2 &&
      row.emitCompareTestFiles.some((f) => f.endsWith("bmrg-a-added.mjs")) && row.emitCompareTestFiles.some((f) => f.endsWith("bmrg-b-added.mjs")));

    if (value) {
      check("(POS) both branches landed via the batch, none fell back", value.ok === true && value.landed.length === 2 && value.fallback.length === 0);
      check("(POS) reducedGateWarning is present on the sync return", typeof value.reducedGateWarning === "string" && value.reducedGateWarning.length > 0);
      check("(POS) reducedGateWarning names the batch's own landed count (2), not a single-branch count", /\b2\b/.test(value.reducedGateWarning));
      check("(POS) reducedGateWarning carries the isolation caveat (card cf4aa7d1)", /ISOLATION/.test(value.reducedGateWarning));
    } else {
      console.log("(POS) NOTE: settled via the async degrade path — the sync MergeBatchResult (reducedGateWarning/landed) is not recoverable that way; skipping those assertions. Every DB-recorded check above is unconditional and still ran.");
    }
  }

  // ── (NEG) a batch of one test-only branch PLUS one REAL behavioral src edit -> stays FULL ─────────────
  {
    const N = mk("bmrg-neg");
    makeRepoWithBaseSrcFile(N, BASE_SRC);
    writeRealTestDaemonScript(N.repo);
    commitAll(N.repo, "chore: add real test-daemon script", GIT_ID);

    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    seedBatchProject(db, N);

    const wTest = await createWorktree(N.repo, N.projId, `${N.taskId}-test`);
    worktrees.push(wTest.worktreePath);
    fs.writeFileSync(path.join(wTest.worktreePath, "packages", "daemon", "test", "bmrg-neg-added.mjs"), "console.log(\"PASS  bmrg-neg-added\");\nprocess.exit(0);\n");
    commitAll(wTest.worktreePath, "test: add bmrg-neg-added", GIT_ID);
    const workerTest = { taskId: `${N.taskId}-test`, workerId: `${N.workerId}-test`, branch: wTest.branch, worktreePath: wTest.worktreePath, label: "test-only" };
    seedWorker(db, N, workerTest);

    const wSrc = await createWorktree(N.repo, N.projId, `${N.taskId}-src`);
    worktrees.push(wSrc.worktreePath);
    fs.writeFileSync(path.join(wSrc.worktreePath, "packages", "daemon", "src", "example.ts"), BASE_SRC.replace("x === 0", "x === 1"));
    commitAll(wSrc.worktreePath, "fix: correct isReady threshold", GIT_ID);
    const workerSrc = { taskId: `${N.taskId}-src`, workerId: `${N.workerId}-src`, branch: wSrc.branch, worktreePath: wSrc.worktreePath, label: "behavioral-src" };
    seedWorker(db, N, workerSrc);

    const { opId, value } = await runBatch(sessions, db, N.projId, N.mgrId, [workerTest.workerId, workerSrc.workerId]);
    check("(NEG) the gate command was called exactly once for the whole batch", calls === 1);
    check("(NEG) captured command IS byte-identical to the configured full gate — one behavioral src edit forces the whole batch full", capturedGate === FULL_GATE);

    const rawEvents = db.findGateOpEventsByOpId(opId);
    const rawBuildGate = rawEvents.find((e) => e.kind === "build_gate");
    check("(NEG) build_gate event records emitCompareReduced:false — a real gate spawned and was PROVEN not reduced", rawBuildGate?.detail?.emitCompareReduced === false);

    if (value) {
      check("(NEG) both branches still landed (the batch itself passed, just via the full command)", value.ok === true && value.landed.length === 2 && value.fallback.length === 0);
      check("(NEG) no reducedGateWarning on a non-reduced batch", value.reducedGateWarning === undefined);
    } else {
      console.log("(NEG) NOTE: settled via the async degrade path — skipping the sync-return assertions. The DB-recorded checks above are unconditional and still ran.");
    }
  }

  // ── (ASSET) a batch of one assets-touching branch PLUS one test-only branch -> REDUCES, widening to the
  //        certified ASSET_READING_TEST_REPO_PATHS set (Code Review blocker [2]'s own positive control:
  //        the pre-fix hand-rolled batch warning dropped the changed-path list and the "ran the certified
  //        tests too" statement the solo copy always carried) ──────────────────────────────────────────
  {
    const A = mk("bmrg-asset");
    makeRepoWithBaseSrcFile(A, BASE_SRC);
    writeRealTestDaemonScript(A.repo);
    commitAll(A.repo, "chore: add real test-daemon script", GIT_ID);

    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    seedBatchProject(db, A);

    const wAsset = await createWorktree(A.repo, A.projId, `${A.taskId}-asset`);
    worktrees.push(wAsset.worktreePath);
    mkdirp(path.join(wAsset.worktreePath, "packages", "daemon", "assets", "skills", "some-skill"));
    fs.writeFileSync(path.join(wAsset.worktreePath, "packages", "daemon", "assets", "skills", "some-skill", "SKILL.md"), "# skill\n");
    commitAll(wAsset.worktreePath, "docs: edit SKILL.md", GIT_ID);
    const workerAsset = { taskId: `${A.taskId}-asset`, workerId: `${A.workerId}-asset`, branch: wAsset.branch, worktreePath: wAsset.worktreePath, label: "asset" };
    seedWorker(db, A, workerAsset);

    const wTest = await createWorktree(A.repo, A.projId, `${A.taskId}-test`);
    worktrees.push(wTest.worktreePath);
    fs.writeFileSync(path.join(wTest.worktreePath, "packages", "daemon", "test", "bmrg-asset-added.mjs"), "console.log(\"PASS  bmrg-asset-added\");\nprocess.exit(0);\n");
    commitAll(wTest.worktreePath, "test: add bmrg-asset-added", GIT_ID);
    const workerTest = { taskId: `${A.taskId}-test`, workerId: `${A.workerId}-test`, branch: wTest.branch, worktreePath: wTest.worktreePath, label: "test-only" };
    seedWorker(db, A, workerTest);

    const { value } = await runBatch(sessions, db, A.projId, A.mgrId, [workerAsset.workerId, workerTest.workerId]);
    check("(ASSET) the gate command was called exactly once for the whole batch", calls === 1);
    check("(ASSET) captured command is NOT the full gate — an asset path never blocks eligibility", capturedGate !== FULL_GATE);
    check("(ASSET) captured command runs test:daemon THROUGH --only= (never the unfiltered suite)", /test:daemon --only=/.test(capturedGate));
    check("(ASSET) captured command's --only= names the added test file", capturedGate.includes("bmrg-asset-added"));
    for (const name of ASSET_TEST_BASENAMES) check(`(ASSET) captured command's --only= names certified asset-reading test ${name}`, capturedGate.includes(name));

    if (value) {
      check("(ASSET) both branches landed via the batch, none fell back", value.ok === true && value.landed.length === 2 && value.fallback.length === 0);
      check("(ASSET) reducedGateWarning is present", typeof value.reducedGateWarning === "string");
      check("(ASSET) reducedGateWarning names the changed asset path — dropped by the pre-blocker-[2] hand-rolled batch copy", value.reducedGateWarning.includes("packages/daemon/assets/skills/some-skill/SKILL.md"));
      check("(ASSET) reducedGateWarning states the certified asset-reading tests actually ran — dropped by the pre-blocker-[2] hand-rolled batch copy", value.reducedGateWarning.includes(`${ASSET_TEST_BASENAMES.length} certified asset-reading test`));
    } else {
      console.log("(ASSET) NOTE: settled via the async degrade path — skipping the sync-return assertions. The DB/command checks above are unconditional and still ran.");
    }
  }

  // ── (TS) card abaaf16e — a batch of one branch with a COMMENT-ONLY compiled .ts edit PLUS one test-only
  //        branch -> the batch's ONE gate run REDUCES, and the captured command folds in every
  //        DIST_TEXT_SCANNER_REPO_PATHS member too (mirrors the (ASSET) scenario's own shape, for the
  //        NEW compiled-.ts-in-the-union trigger instead of the assets one) ───────────────────────────
  {
    const T = mk("bmrg-ts");
    makeRepoWithBaseSrcFile(T, BASE_SRC);
    writeRealTestDaemonScript(T.repo);
    commitAll(T.repo, "chore: add real test-daemon script", GIT_ID);

    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    seedBatchProject(db, T);

    const wTs = await createWorktree(T.repo, T.projId, `${T.taskId}-ts`);
    worktrees.push(wTs.worktreePath);
    fs.writeFileSync(path.join(wTs.worktreePath, "packages", "daemon", "src", "example.ts"),
      BASE_SRC.replace("explains what isReady checks", "explains what isReady checks (typo fixed)"));
    commitAll(wTs.worktreePath, "docs: fix comment typo", GIT_ID);
    const workerTs = { taskId: `${T.taskId}-ts`, workerId: `${T.workerId}-ts`, branch: wTs.branch, worktreePath: wTs.worktreePath, label: "comment-only-ts" };
    seedWorker(db, T, workerTs);

    const wTest = await createWorktree(T.repo, T.projId, `${T.taskId}-test`);
    worktrees.push(wTest.worktreePath);
    fs.writeFileSync(path.join(wTest.worktreePath, "packages", "daemon", "test", "bmrg-ts-added.mjs"), "console.log(\"PASS  bmrg-ts-added\");\nprocess.exit(0);\n");
    commitAll(wTest.worktreePath, "test: add bmrg-ts-added", GIT_ID);
    const workerTest = { taskId: `${T.taskId}-test`, workerId: `${T.workerId}-test`, branch: wTest.branch, worktreePath: wTest.worktreePath, label: "test-only" };
    seedWorker(db, T, workerTest);

    const { value } = await runBatch(sessions, db, T.projId, T.mgrId, [workerTs.workerId, workerTest.workerId]);
    check("(TS) the gate command was called exactly once for the whole batch", calls === 1);
    check("(TS) captured command is NOT the full gate — a comment-only .ts edit never blocks eligibility", capturedGate !== FULL_GATE);
    check("(TS) captured command's --only= names the added test file", capturedGate.includes("bmrg-ts-added"));
    for (const s of DIST_SCANNER_BASENAMES) check(`(TS) captured command runs dist-text scanner ${s} bare (a compiled .ts file changed in the union)`, capturedGate.includes(`node packages/daemon/test/${s}`));

    if (value) {
      check("(TS) both branches landed via the batch, none fell back", value.ok === true && value.landed.length === 2 && value.fallback.length === 0);
      check("(TS) reducedGateWarning names the compiled-source/dist text-scanner count", typeof value.reducedGateWarning === "string" && value.reducedGateWarning.includes(`also ran the ${DIST_SCANNER_BASENAMES.length} compiled-source/dist text-scanner test`));
    } else {
      console.log("(TS) NOTE: settled via the async degrade path — skipping the sync-return assertions. The DB/command checks above are unconditional and still ran.");
    }
  }

  // ── (NA) a batch whose union includes a path OUTSIDE every emit-compare prefix -> the predicate can't
  //        decide reducibility AT ALL, so the batch stays FULL and the PROJECTED gate_history row reads
  //        `emitCompareReduced: null` (card 32a8bcca).
  //
  //   THE MECHANISM, so `null` here is never re-filed as a bug: `computeEmitCompareGate`'s classification
  //   loop (git/worktrees.ts) recognizes only `packages/daemon/{src,test,assets,scripts}/` (plus a small
  //   INERT_MERGE_PATH_PREFIXES/INERT_MERGE_EXACT_PATHS allowlist it skips outright, e.g. docs/, README.md).
  //   The FIRST changed path that falls outside ALL of those hits that loop's catch-all — `return
  //   notApplicableHere("path outside emit-compare scope: ...")` — which reports `notApplicable:true`, not
  //   an informative `false`: the predicate never had this diff's shape in its domain, so "proven not
  //   reduced" would overclaim. `db.ts`'s `toGateHistoryRow` then has no boolean to recover from either the
  //   settled verdict payload or the raw event's `detail` (the batch's own `build_gate` event OMITS
  //   `emitCompareReduced` entirely when `notApplicable` — see service.ts's `emitCompareDecidable` gate),
  //   so it falls through to `null` — the CORRECT third state, not a missing recording.
  //
  //   `null` was previously reachable in PRODUCTION (any project whose diff isn't shaped like this daemon
  //   package) but UNREACHABLE in this FIXTURE: every prior scenario's changed paths sat entirely under
  //   `packages/daemon/**`. This scenario extends the fixture minimally — a new `packages/web/src/*.ts` path,
  //   the exact example that catch-all's own in-code comment names as out of scope — rather than forking a
  //   second fixture module.
  {
    const NA = mk("bmrg-na");
    makeRepoWithBaseSrcFile(NA, BASE_SRC);
    writeRealTestDaemonScript(NA.repo);
    commitAll(NA.repo, "chore: add real test-daemon script", GIT_ID);

    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    seedBatchProject(db, NA);

    const wTest = await createWorktree(NA.repo, NA.projId, `${NA.taskId}-test`);
    worktrees.push(wTest.worktreePath);
    fs.writeFileSync(path.join(wTest.worktreePath, "packages", "daemon", "test", "bmrg-na-added.mjs"), "console.log(\"PASS  bmrg-na-added\");\nprocess.exit(0);\n");
    commitAll(wTest.worktreePath, "test: add bmrg-na-added", GIT_ID);
    const workerTest = { taskId: `${NA.taskId}-test`, workerId: `${NA.workerId}-test`, branch: wTest.branch, worktreePath: wTest.worktreePath, label: "test-only" };
    seedWorker(db, NA, workerTest);

    const wOut = await createWorktree(NA.repo, NA.projId, `${NA.taskId}-outofscope`);
    worktrees.push(wOut.worktreePath);
    // packages/web/** is never in EMIT_COMPARE_SRC_PREFIX/EMIT_COMPARE_TEST_PREFIX/EMIT_COMPARE_ASSETS_PREFIX/
    // EMIT_COMPARE_SCRIPTS_PREFIX (all scoped to packages/daemon/**), and it's neither docs/ nor a root
    // INERT_MERGE_EXACT_PATHS name — so it can only ever hit computeEmitCompareGate's final catch-all.
    mkdirp(path.join(wOut.worktreePath, "packages", "web", "src"));
    fs.writeFileSync(path.join(wOut.worktreePath, "packages", "web", "src", "App.ts"), "export const x = 1;\n");
    commitAll(wOut.worktreePath, "feat(web): add App.ts", GIT_ID);
    const workerOut = { taskId: `${NA.taskId}-outofscope`, workerId: `${NA.workerId}-outofscope`, branch: wOut.branch, worktreePath: wOut.worktreePath, label: "out-of-scope" };
    seedWorker(db, NA, workerOut);

    const { opId, value, row } = await runBatch(sessions, db, NA.projId, NA.mgrId, [workerTest.workerId, workerOut.workerId]);
    check("(NA) the gate command was called exactly once for the whole batch", calls === 1);
    check("(NA) captured command IS byte-identical to the configured full gate — an out-of-scope path can't be classified, so the batch stays FULL", capturedGate === FULL_GATE);

    const rawEvents = db.findGateOpEventsByOpId(opId);
    const rawBuildGate = rawEvents.find((e) => e.kind === "build_gate");
    check("(NA) build_gate event OMITS emitCompareReduced entirely — the predicate never decided, so nothing informative was ever stamped (not even false)", rawBuildGate?.detail?.emitCompareReduced === undefined);

    // Card 32a8bcca DoD-1: assert on the PROJECTED gate_history row (db.ts's toGateHistoryRow via
    // db.listGateEvents), never an in-memory return — the same surface (POS)/(NEG) already assert on above.
    check("(NA) PROJECTED gate_history row: emitCompareReduced reads null — the CORRECT third state (notApplicable), never a bug", row?.emitCompareReduced === null);
    check("(NA) PROJECTED gate_history row: emitCompareIdenticalCount stays null alongside emitCompareReduced:null (pairing invariant)", row?.emitCompareIdenticalCount === null);
    check("(NA) PROJECTED gate_history row: emitCompareTestFiles stays null alongside emitCompareReduced:null (pairing invariant)", row?.emitCompareTestFiles === null);

    if (value) {
      check("(NA) both branches still landed (the batch itself passed, just via the full command)", value.ok === true && value.landed.length === 2 && value.fallback.length === 0);
      check("(NA) no reducedGateWarning on a non-reduced (notApplicable) batch", value.reducedGateWarning === undefined);
    } else {
      console.log("(NA) NOTE: settled via the async degrade path — skipping the sync-return assertions. The DB-recorded checks above are unconditional and still ran.");
    }
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Code Review fold-in [5]: without this, a runner that missed the sync-attach budget on every scenario
// would print "All checks passed" (exit 0) having exercised none of this file's MergeBatchResult/
// reducedGateWarning assertions — indistinguishable from a genuine pass. This is a test-INTEGRITY check,
// not a feature assertion, so it's counted separately from `failures` in the final summary line.
check("at least one scenario observed a real SYNC settle (not just the async-degrade path) — otherwise every reducedGateWarning/MergeBatchResult assertion above silently never ran", syncReturnsObserved > 0);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
