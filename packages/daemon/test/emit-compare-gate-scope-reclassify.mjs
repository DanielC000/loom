import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SPLIT OFF emit-compare-gate-scope.mjs (card 4e8e2d82): carries ONLY (M), (N), (O) from the list below;
// (H)-(L) live in the sibling file. The list below describes both halves.
//
// EMIT-COMPARE REDUCED-GATE test, PART 2 — split off `emit-compare-gate.mjs` by card 4dfc648a (that file
// alone used ~112.5s of the harness's 120s per-FILE `TEST_TIMEOUT_MS` standalone, ~94% — see this file's
// sibling and `_emit-compare-fixtures.mjs` for the split's full rationale and the shared setup mechanics).
// Same REAL-git-on-temp-repos style as the sibling file; this half carries the later scope-boundary,
// defence-in-depth, and cap-queue-admission additions (cards 815b4b30, 44968963, 7183540f, and a manager
// #128 code-review finding):
//   (H) DEFENCE-IN-DEPTH — a changed test/*.mjs path carrying a shell metacharacter must fail closed
//       rather than reach buildReducedGateCommand's `&&`-joined, shell-executed command string.
//   (I) card 815b4b30 — a diff touching ONLY a test/fixtures/*.mjs file must FAIL CLOSED to the full gate,
//       never report a vacuous eligible:true with nothing left to run.
//   (J) card 44968963 — a REAL changed test file PLUS a changed test/fixtures/*.mjs file in the SAME diff
//       no longer reduces at all (supersedes the pre-44968963 behavior, which reduced off the real test
//       file alone and left the fixture's OTHER consumers unrun by either gate).
//   (K) card 44968963 DoD-4 — a changed fixture PLUS ONE of its several consumers, while ANOTHER real
//       consumer of that SAME fixture sits entirely outside the diff, must also fail closed: nothing here
//       can prove the untouched consumer is unaffected.
//   (L) card 7183540f — BRANCH-BLIND AT CAP-QUEUE ADMISSION: `effectiveGate`/`emitCompareSkip` are
//       computed BEFORE `gateSemaphore.runExclusive`'s admission wait and were never re-derived once
//       admitted. A branch that gains a further BEHAVIORAL edit while genuinely queued on the semaphore's
//       CAP (not a per-repo guard) must be caught at admission too, never ride through on a stale pre-wait
//       REDUCED verdict.
//   (M) card 66b3112a — PRELANDED MAIN-MOVE AT CAP-QUEUE ADMISSION: (L)'s own `moved` check has a main-tip
//       leg that only ever fires because it piggybacked on `gateBaseMainHead`'s in-place advance — which
//       only happens on the `!preLanded` (union) producer, making that leg structurally inert on a
//       PRELANDED branch. This is NOT a merge-safety gap (a byte-stable preLanded branch's squash is a
//       provable no-op regardless — see `branchStableSinceGateBase` in git/worktrees.ts), but it IS a real
//       detection gap: a PRELANDED branch whose main gains a genuinely behavioral edit during the cap-queue
//       wait, with the branch itself staying completely stable, must still be caught by its OWN
//       admission-time HEAD read and trigger a real reclassification — never silently keep running the
//       stale pre-wait REDUCED verdict.
//   (N) card abaaf16e — RECLASSIFICATION PATH FOR DIST-TEXT SCANNERS: same cap-queue-admission shape as
//       (L), but the further commit landing on the branch while queued is ALSO comment-only, so the
//       admission-time re-derivation reclassifies to eligible:true again (not a fallback to FULL) — and
//       the resulting command must still fold in every CHANGED_TS_TEXT_SCANNER_REPO_PATHS member, proving the
//       reclassification branch (not just the pre-wait one) reads `changedTsPaths`.
// Run: 1) build daemon (pnpm build), 2) node test/emit-compare-gate-scope-reclassify.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { assertNeverWithControl, observeOnce, pollUntil } from "./_timing-guard.mjs";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ecgs-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

// `_emit-compare-fixtures.mjs` has its OWN top-level `await import("../dist/git/worktrees.js")` (to
// derive GUARD_BASENAMES from the real STATIC_GUARD_REPO_PATHS) — a STATIC import of it here would be
// hoisted and evaluated before the LOOM_HOME lines above ever run, letting that transitive import lock
// paths.js's module-level DB_PATH to the real ~/.loom before this file's own override takes effect (the
// prod-DB guard then correctly refuses `new Db()` below). Importing it dynamically, after LOOM_HOME is
// set, keeps this file's own env setup ahead of anything that reads it.
const {
  sleep, GIT_ID, FULL_GATE, seed, mkdirp, mk, BASE_SRC, makeRepoWithBaseSrcFile, REAL_TEST_DAEMON_SCRIPT,
  writeRealTestDaemonScript, CHANGED_TS_SCANNER_BASENAMES, CHANGED_SCRIPT_SCANNER_BASENAMES,
} = await import("./_emit-compare-fixtures.mjs");

// Card f862f9c5 — (O) below's own small synthetic `.mjs` fixture, same shape/spirit as BASE_SRC above (a
// comment line to flip), scoped local to this file since no other scenario here needs it.
const BASE_SCRIPT = [
  "// prints a friendly status line",
  "console.log(\"ready\");",
  "",
].join("\n");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbs = [];
const worktrees = [];
try {
  // ── (M) card 66b3112a — PRELANDED MAIN-MOVE AT CAP-QUEUE ADMISSION — see this file's own header for the
  //        summary. M1 occupies the daemon's only cap slot exactly like L1 above. M2 is a PRELANDED branch
  //        (its own prior work already squashed onto main via a direct `mergeBranch` call, mirroring
  //        merge-gate-reuse.mjs scenarios (M)/(N)'s own preLanded construction) whose pre-wait classification
  //        is ALSO genuinely emit-compare-eligible: an UNRELATED comment-only edit lands on M2's own MAIN —
  //        never touching the branch — so `computeEmitCompareGate` has a real comment-only `.ts` diff to
  //        classify against BEFORE M2 ever reaches the semaphore. Once M2 is genuinely queued behind M1, a
  //        FURTHER commit lands on M2's main — a REAL behavioral edit this time, not comment-only — while
  //        M2's own branch stays completely untouched throughout (the discriminating shape
  //        merge-gate-reuse.mjs's (N) uses: branch stable, main moves).
  //
  //        ⚠️ WHAT THIS DOES NOT PROVE (repeated in the commit body — a comment is a claim nobody
  //        re-checks): this is NOT a merge-safety regression test. `branchStableSinceGateBase`
  //        (git/worktrees.ts) independently guarantees a byte-stable preLanded branch's squash is a provable
  //        no-op regardless of which gate command ran — so M2's merge lands as a safe ALREADY_MERGED no-op
  //        either way, RED or GREEN. What differs is whether the admission-time re-derivation actually RUNS
  //        (a real detection gap, not an outcome gap), observed indirectly through WHICH gate command gets
  //        spawned: pre-fix, the stale pre-wait REDUCED command survives untouched despite main's later,
  //        unaccounted-for behavioral edit (RED — the bug this scenario exists to catch); post-fix, the main
  //        leg's own admission HEAD read notices the movement, forces a real reclassification, and the
  //        now-behavioral diff correctly falls back to the FULL gate (GREEN). ───────────────────────────────
  {
    const M1 = mk("m1"), M2 = mk("m2");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const { mergeBranch } = await import("../dist/git/worktrees.js");

    fs.mkdirSync(M1.repo, { recursive: true });
    registerForCleanup(M1.repo);
    fs.writeFileSync(path.join(M1.repo, "README.md"), "# ecg\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: M1.repo });
    commitAll(M1.repo, "init", GIT_ID);

    makeRepoWithBaseSrcFile(M2, BASE_SRC);

    let gate1Calls = 0, gate2Calls = 0;
    let capturedGate2;
    let gate1AdmittedResolve;
    const gate1Admitted = new Promise((res) => { gate1AdmittedResolve = res; });
    let releaseGate1;
    const fakeGate = async (gateCmd, cwd) => {
      if (cwd === M1.worktreePath) {
        gate1Calls++;
        gate1AdmittedResolve();
        await new Promise((res) => { releaseGate1 = res; });
        return { passed: true };
      }
      gate2Calls++;
      capturedGate2 = gateCmd;
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    const wt1 = await createWorktree(M1.repo, M1.projId, M1.taskId);
    M1.worktreePath = wt1.worktreePath; M1.branch = wt1.branch; worktrees.push(wt1.worktreePath);
    mkdirp(path.join(M1.worktreePath, "packages", "other"));
    fs.writeFileSync(path.join(M1.worktreePath, "packages", "other", "note.txt"), "unrelated\n");
    commitAll(M1.worktreePath, "chore: unrelated cap-slot occupant", GIT_ID);
    seed(db, M1);

    const wt2 = await createWorktree(M2.repo, M2.projId, M2.taskId);
    M2.worktreePath = wt2.worktreePath; M2.branch = wt2.branch; worktrees.push(wt2.worktreePath);
    // M2's OWN work — an unrelated file, deliberately outside emit-compare's scope so it can never itself
    // affect eligibility once squashed onto main (its content becomes byte-identical on both sides).
    fs.writeFileSync(path.join(M2.worktreePath, "feature-m2.txt"), "work for M2\n");
    commitAll(M2.worktreePath, "feat: M2's own work", GIT_ID);

    // Land it NOW, directly (mirrors merge-gate-reuse.mjs (M)/(N)) — M2 is a PURE preLanded re-confirm from
    // here on; its own branch never changes again in this scenario.
    const landed = await mergeBranch(M2.repo, M2.branch, "ECG-M2 initial land");
    check("(M) precondition: M2's branch already landed on main (preLanded)", landed.ok === true);

    // An UNRELATED comment-only edit lands on M2's MAIN — never touching the branch — giving the pre-wait
    // classification a real, genuinely eligible diff to find (M2's branch still has the untouched BASE_SRC).
    fs.writeFileSync(path.join(M2.repo, "packages", "daemon", "src", "example.ts"),
      BASE_SRC.replace("explains what isReady checks", "explains what isReady checks (typo fixed on main)"));
    commitAll(M2.repo, "docs: fix comment typo on main", GIT_ID);
    seed(db, M2);

    const p1 = sessions.confirmWorkerMerge(M1.mgrId, M1.workerId);
    await gate1Admitted;
    check("(M) M1 genuinely admitted and holds the cap's only slot", sessions.gateSemaphore.snapshot().active === 1);

    let confirm2Settled = false;
    const p2 = sessions.confirmWorkerMerge(M2.mgrId, M2.workerId).then((r) => { confirm2Settled = true; return r; });

    const queued = await pollUntil(
      () => sessions.gateSemaphore.snapshot().entries.some((e) => e.phase === "queued" && e.projectId === M2.projId),
      { timeoutMs: 10000 },
    );
    check("(M) M2 genuinely reached the semaphore's CAP-queue wait before M1 released", queued);

    // Card 8142d47c audit of this site: same mechanism and same verdict as (L) above — PROVEN SAFE BY
    // CONSTRUCTION. `confirm2Settled` can only flip once M2's `acquire()` waiter (gate-semaphore.ts:596-610,
    // a plain Promise resolved by an explicit `grant()`/`resolve()` call, never a setTimeout) is granted a
    // cap slot, gated behind M1's own `fakeGate` Promise, resolved ONLY by this test's own explicit
    // `releaseGate1("go")` call below, issued SEQUENTIALLY AFTER this assertNeverWithControl already
    // completes. See (L)'s own comment above for the injection evidence (uniform scaling up to 500x
    // unchanged; adversarial non-uniform probe against the shared harness DID throw, proving non-vacuity).
    const WINDOW_MS = 150;
    const neverSettled = await assertNeverWithControl({
      label: "(M) M2's confirm does NOT settle while M1's held-open gate still occupies the cap's only slot",
      check: () => confirm2Settled,
      windowMs: WINDOW_MS,
      positiveControl: async () => {
        let controlSettled = false;
        const pControl = sleep(1).then(() => { controlSettled = true; });
        const observed = await observeOnce({ check: () => controlSettled, windowMs: WINDOW_MS });
        await pControl;
        return observed;
      },
    });
    check("(M) M2's confirm PROVABLY waited on the cap, not a fluke of scheduling", neverSettled);

    // NOW, while M2 is genuinely queued behind the cap, a FURTHER commit lands on M2's MAIN — a REAL
    // behavioral edit this time (not comment-only), still never touching M2's own branch, which stays
    // byte-stable throughout.
    fs.writeFileSync(path.join(M2.repo, "packages", "daemon", "src", "example.ts"),
      BASE_SRC.replace("explains what isReady checks", "explains what isReady checks (typo fixed on main)").replace("x === 0", "x === 1"));
    commitAll(M2.repo, "fix: correct isReady threshold on main during the cap-queue wait", GIT_ID);

    releaseGate1("go");
    const confirm1 = await p1;
    const confirm2 = await p2;

    check("(M) M1 merged successfully, ran its own gate exactly once", confirm1.merged === true && gate1Calls === 1);
    check("(M) M2's gate command was called exactly once", gate2Calls === 1);
    check("(M) ⭐ the main leg's own admission HEAD read fired a real re-derivation — M2's captured command IS the FULL gate, not the stale pre-wait REDUCED one, once main gained a genuinely behavioral edit during the cap-queue wait",
      capturedGate2 === FULL_GATE);
    // NOT a merge-safety assertion (see this scenario's own header doc): a byte-stable preLanded branch's
    // squash is a provable no-op regardless of which gate command ran — this only confirms that expected,
    // already-safe outcome held, which is unaffected by whether detection fired.
    check("(M) M2's merge still lands as a safe no-op — ALREADY_MERGED, not a real squash of unverified content",
      confirm2.merged === true && confirm2.emptyKind === "ALREADY_MERGED");
  }

  // ── (N) card abaaf16e — Code Review MINOR: THE RECLASSIFICATION PATH itself must fold
  //        CHANGED_TS_TEXT_SCANNER_REPO_PATHS in, not just the pre-wait classification (L)/(M) above already
  //        cover. Same cap-queue-admission shape as (L), but DELIBERATELY does NOT mirror (L)'s choice of
  //        touching the SAME scope in both the pre-wait and queue-time commits: this scenario's own earlier
  //        draft edited `src/example.ts` in BOTH its pre-wait commit and its during-queue commit, so
  //        `emitCompareTsPaths` was ALREADY non-empty before reclassification ever ran — deleting
  //        `reclassified.changedTsPaths`'s assignment left the (byte-identical) STALE pre-wait value in
  //        place and this scenario's own ⭐ assertion stayed green regardless (Code Review `a2bfa262`, review
  //        of card `f862f9c5`, 2026-09-11 — card `f862f9c5`'s own scenario (O) had the identical defect for
  //        `changedScriptFiles` and was already fixed the same way, below). THIS scenario instead keeps the
  //        two commits' SCOPES DISJOINT:
  //        N2's PRE-WAIT commit is a comment-only edit to a real `test/*.mjs` file (TS-free —
  //        `emitCompareTsPaths` pre-wait is `[]`), and the commit that lands DURING the cap-queue wait is
  //        what ADDS the `src/example.ts` comment edit for the FIRST TIME. So
  //        `reclassified.changedTsPaths` is `["packages/daemon/src/example.ts"]` while the stale pre-wait
  //        `emitCompareTsPaths` is `[]` — genuinely different values, so deleting the assignment at
  //        service.ts's reclassification branch demonstrably flips this scenario's own assertion from
  //        green to red (mutation proof recorded in this card's own decision record; not re-run
  //        automatically here, since a manual source mutation isn't expressible as a test case in this
  //        same file). ─────────────────────────────────────────────────────────────────────────────────
  {
    const N1 = mk("n1"), N2 = mk("n2");
    const BASE_TEST = ["// a hermetic test file, TS-free", "console.log(\"PASS  placeholder\");", "process.exit(0);", ""].join("\n");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

    fs.mkdirSync(N1.repo, { recursive: true });
    registerForCleanup(N1.repo);
    fs.writeFileSync(path.join(N1.repo, "README.md"), "# ecg\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: N1.repo });
    commitAll(N1.repo, "init", GIT_ID);

    // N2's base repo carries BOTH a real .ts file (for the queue-time edit) AND a real, self-resolving
    // test-daemon.mjs (`writeRealTestDaemonScript` — so `loadNotHermeticNames` genuinely SUCCEEDS classifying
    // the pre-wait test-file edit, rather than falling back to fail-closed; see that helper's own doc) AND a
    // real test/*.mjs file, untouched at this commit — the pre-wait commit below is what first edits it.
    makeRepoWithBaseSrcFile(N2, BASE_SRC);
    writeRealTestDaemonScript(N2.repo);
    fs.writeFileSync(path.join(N2.repo, "packages", "daemon", "test", "reclass-example.mjs"), BASE_TEST);
    commitAll(N2.repo, "chore: add example test", GIT_ID);

    let gate1Calls = 0, gate2Calls = 0;
    let capturedGate2;
    let gate1AdmittedResolve;
    const gate1Admitted = new Promise((res) => { gate1AdmittedResolve = res; });
    let releaseGate1;
    const fakeGate = async (gateCmd, cwd) => {
      if (cwd === N1.worktreePath) {
        gate1Calls++;
        gate1AdmittedResolve();
        await new Promise((res) => { releaseGate1 = res; });
        return { passed: true };
      }
      gate2Calls++;
      capturedGate2 = gateCmd;
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    const wt1 = await createWorktree(N1.repo, N1.projId, N1.taskId);
    N1.worktreePath = wt1.worktreePath; N1.branch = wt1.branch; worktrees.push(wt1.worktreePath);
    mkdirp(path.join(N1.worktreePath, "packages", "other"));
    fs.writeFileSync(path.join(N1.worktreePath, "packages", "other", "note.txt"), "unrelated\n");
    commitAll(N1.worktreePath, "chore: unrelated cap-slot occupant", GIT_ID);
    seed(db, N1);

    const wt2 = await createWorktree(N2.repo, N2.projId, N2.taskId);
    N2.worktreePath = wt2.worktreePath; N2.branch = wt2.branch; worktrees.push(wt2.worktreePath);
    // Pre-wait: a COMMENT-ONLY edit to the real test file, TS-FREE — eligible for the reduced gate via
    // changedTestFiles, classified BEFORE admission, with emitCompareTsPaths left at its empty default
    // (this commit never touches src/example.ts).
    fs.writeFileSync(path.join(N2.worktreePath, "packages", "daemon", "test", "reclass-example.mjs"),
      BASE_TEST.replace("a hermetic test file, TS-free", "a hermetic test file, TS-free (comment tweak)"));
    commitAll(N2.worktreePath, "docs: fix test comment", GIT_ID);
    seed(db, N2);

    const p1 = sessions.confirmWorkerMerge(N1.mgrId, N1.workerId);
    await gate1Admitted;
    check("(N) N1 genuinely admitted and holds the cap's only slot", sessions.gateSemaphore.snapshot().active === 1);

    let confirm2Settled = false;
    const p2 = sessions.confirmWorkerMerge(N2.mgrId, N2.workerId).then((r) => { confirm2Settled = true; return r; });

    const queued = await pollUntil(
      () => sessions.gateSemaphore.snapshot().entries.some((e) => e.phase === "queued" && e.projectId === N2.projId),
      { timeoutMs: 10000 },
    );
    check("(N) N2 genuinely reached the semaphore's CAP-queue wait before N1 released", queued);

    // Same PROVEN-SAFE-BY-CONSTRUCTION reasoning as (L)/(M) above — see their own comments for the full
    // injection evidence; identical mechanism, only the project/session ids differ.
    const WINDOW_MS = 150;
    const neverSettled = await assertNeverWithControl({
      label: "(N) N2's confirm does NOT settle while N1's held-open gate still occupies the cap's only slot",
      check: () => confirm2Settled,
      windowMs: WINDOW_MS,
      positiveControl: async () => {
        let controlSettled = false;
        const pControl = sleep(1).then(() => { controlSettled = true; });
        const observed = await observeOnce({ check: () => controlSettled, windowMs: WINDOW_MS });
        await pControl;
        return observed;
      },
    });
    check("(N) N2's confirm PROVABLY waited on the cap, not a fluke of scheduling", neverSettled);

    // NOW, while N2 is genuinely queued behind the cap, a FURTHER commit lands on N2's OWN branch that ADDS
    // a comment-only src/example.ts edit — this is the FIRST time this branch's diff touches a compiled .ts
    // file at all, so the recombined diff's changedTsPaths is populated ONLY at reclassification time, never
    // at pre-wait. The recombined diff (both commits) stays transpile-identical, so the re-derivation should
    // land on eligible:true again, through the SAME `if (moved) {...}` reclassification branch (L) exercises
    // for the FULL-gate fallback case.
    fs.writeFileSync(path.join(N2.worktreePath, "packages", "daemon", "src", "example.ts"),
      BASE_SRC.replace("explains what isReady checks", "explains what isReady checks (typo fixed during the cap-queue wait)"));
    commitAll(N2.worktreePath, "docs: fix comment typo during the cap-queue wait", GIT_ID);

    releaseGate1("go");
    const confirm1 = await p1;
    const confirm2 = await p2;

    check("(N) N1 merged successfully, ran its own gate exactly once", confirm1.merged === true && gate1Calls === 1);
    check("(N) N2 merged successfully", confirm2.merged === true);
    check("(N) N2's gate command was called exactly once", gate2Calls === 1);
    check("(N) N2's captured command is the REDUCED gate — the re-derivation found the recombined diff STILL transpile-identical, not a stale carry-over of the pre-wait verdict",
      typeof capturedGate2 === "string" && capturedGate2 !== FULL_GATE);
    check("(N) ⭐ card abaaf16e: the RECLASSIFIED command folds in every dist-text scanner — proves reclassified.changedTsPaths is read and used, not just the pre-wait emitCompareTsPaths (which stayed empty pre-wait, since the pre-wait commit never touched a compiled .ts file)",
      typeof capturedGate2 === "string" && CHANGED_TS_SCANNER_BASENAMES.every((s) => capturedGate2.includes(`node packages/daemon/test/${s}`)));
    check("(N) N2's warning also names the reclassified dist-text-scanner count",
      typeof confirm2.warning === "string" && new RegExp(`also ran the ${CHANGED_TS_SCANNER_BASENAMES.length} compiled-source/dist text-scanner test\\(s\\)`).test(confirm2.warning));
  }

  // ── (O) card f862f9c5 — the RECLASSIFICATION PATH must fold CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS in
  //        too, on ITS OWN trigger — mirrors scenario (N)'s two-worker cap-queue-admission shape, but
  //        DELIBERATELY does NOT mirror (N)'s choice of touching the SAME scope in both the pre-wait and
  //        queue-time commits: (N) edits `src/example.ts` in BOTH its pre-wait commit and its during-queue
  //        commit, so `emitCompareTsPaths` is ALREADY non-empty before reclassification ever runs — deleting
  //        `reclassified.changedTsPaths`'s assignment would leave the (byte-identical) STALE pre-wait value,
  //        and (N)'s own assertion would stay green regardless (Code Review, card f862f9c5: this scenario's
  //        FIRST draft copied that exact shape for scripts and was caught non-discriminating for the
  //        identical reason). THIS scenario instead keeps the two commits' SCOPES DISJOINT: O2's PRE-WAIT
  //        commit is a comment-only `.ts` edit (scripts-free — `emitCompareScriptFiles` pre-wait is `[]`),
  //        and the commit that lands DURING the cap-queue wait is what ADDS the scripts/**/*.mjs comment
  //        edit for the FIRST TIME. So `reclassified.changedScriptFiles` is `["...example.mjs"]` while the
  //        stale pre-wait `emitCompareScriptFiles` is `[]` — genuinely different values, so deleting the
  //        assignment at service.ts's reclassification branch demonstrably flips this scenario's own
  //        assertion from green to red (see the mutation proof recorded in this card's own decision record;
  //        not re-run automatically here, since a manual source mutation isn't expressible as a test case in
  //        this same file). ──────────────────────────────────────────────────────────────────────────────
  {
    const O1 = mk("o1"), O2 = mk("o2");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

    fs.mkdirSync(O1.repo, { recursive: true });
    registerForCleanup(O1.repo);
    fs.writeFileSync(path.join(O1.repo, "README.md"), "# ecg\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: O1.repo });
    commitAll(O1.repo, "init", GIT_ID);

    // O2's base repo carries BOTH a real .ts file (for the scripts-free pre-wait edit) AND a real scripts/**
    // file (untouched at this commit — the queue-time commit below is what first edits it).
    makeRepoWithBaseSrcFile(O2, BASE_SRC);
    mkdirp(path.join(O2.repo, "packages", "daemon", "scripts"));
    fs.writeFileSync(path.join(O2.repo, "packages", "daemon", "scripts", "example.mjs"), BASE_SCRIPT);
    commitAll(O2.repo, "chore: add example script", GIT_ID);

    let gate1Calls = 0, gate2Calls = 0;
    let capturedGate2;
    let gate1AdmittedResolve;
    const gate1Admitted = new Promise((res) => { gate1AdmittedResolve = res; });
    let releaseGate1;
    const fakeGate = async (gateCmd, cwd) => {
      if (cwd === O1.worktreePath) {
        gate1Calls++;
        gate1AdmittedResolve();
        await new Promise((res) => { releaseGate1 = res; });
        return { passed: true };
      }
      gate2Calls++;
      capturedGate2 = gateCmd;
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    const wt1 = await createWorktree(O1.repo, O1.projId, O1.taskId);
    O1.worktreePath = wt1.worktreePath; O1.branch = wt1.branch; worktrees.push(wt1.worktreePath);
    mkdirp(path.join(O1.worktreePath, "packages", "other"));
    fs.writeFileSync(path.join(O1.worktreePath, "packages", "other", "note.txt"), "unrelated\n");
    commitAll(O1.worktreePath, "chore: unrelated cap-slot occupant", GIT_ID);
    seed(db, O1);

    const wt2 = await createWorktree(O2.repo, O2.projId, O2.taskId);
    O2.worktreePath = wt2.worktreePath; O2.branch = wt2.branch; worktrees.push(wt2.worktreePath);
    // Pre-wait: a COMMENT-ONLY .ts edit, SCRIPTS-FREE — eligible for the reduced gate, classified BEFORE
    // admission, with emitCompareScriptFiles left at its empty default (this commit never touches scripts/**).
    fs.writeFileSync(path.join(O2.worktreePath, "packages", "daemon", "src", "example.ts"),
      BASE_SRC.replace("explains what isReady checks", "explains what isReady checks (typo fixed)"));
    commitAll(O2.worktreePath, "docs: fix comment typo", GIT_ID);
    seed(db, O2);

    const p1 = sessions.confirmWorkerMerge(O1.mgrId, O1.workerId);
    await gate1Admitted;
    check("(O) O1 genuinely admitted and holds the cap's only slot", sessions.gateSemaphore.snapshot().active === 1);

    let confirm2Settled = false;
    const p2 = sessions.confirmWorkerMerge(O2.mgrId, O2.workerId).then((r) => { confirm2Settled = true; return r; });

    const queued = await pollUntil(
      () => sessions.gateSemaphore.snapshot().entries.some((e) => e.phase === "queued" && e.projectId === O2.projId),
      { timeoutMs: 10000 },
    );
    check("(O) O2 genuinely reached the semaphore's CAP-queue wait before O1 released", queued);

    const WINDOW_MS = 150;
    const neverSettled = await assertNeverWithControl({
      label: "(O) O2's confirm does NOT settle while O1's held-open gate still occupies the cap's only slot",
      check: () => confirm2Settled,
      windowMs: WINDOW_MS,
      positiveControl: async () => {
        let controlSettled = false;
        const pControl = sleep(1).then(() => { controlSettled = true; });
        const observed = await observeOnce({ check: () => controlSettled, windowMs: WINDOW_MS });
        await pControl;
        return observed;
      },
    });
    check("(O) O2's confirm PROVABLY waited on the cap, not a fluke of scheduling", neverSettled);

    // NOW, while O2 is genuinely queued behind the cap, a FURTHER commit lands on O2's OWN branch that
    // ADDS a comment-only packages/daemon/scripts/**/*.mjs edit — this is the FIRST time this branch's
    // diff touches scripts/** at all, so the recombined diff's changedScriptFiles is populated ONLY at
    // reclassification time, never at pre-wait. The recombined diff (both commits) stays transpile-
    // identical, so the re-derivation should land on eligible:true again, through the SAME
    // `if (moved) {...}` reclassification branch (N) exercises for the .ts-triggered case.
    fs.writeFileSync(path.join(O2.worktreePath, "packages", "daemon", "scripts", "example.mjs"),
      BASE_SCRIPT.replace("prints a friendly status line", "prints a friendly status line (typo fixed)"));
    commitAll(O2.worktreePath, "docs: fix script comment during the cap-queue wait", GIT_ID);

    releaseGate1("go");
    const confirm1 = await p1;
    const confirm2 = await p2;

    check("(O) O1 merged successfully, ran its own gate exactly once", confirm1.merged === true && gate1Calls === 1);
    check("(O) O2 merged successfully", confirm2.merged === true);
    check("(O) O2's gate command was called exactly once", gate2Calls === 1);
    check("(O) O2's captured command is the REDUCED gate — the re-derivation found the recombined diff STILL transpile-identical, not a stale carry-over of the pre-wait verdict",
      typeof capturedGate2 === "string" && capturedGate2 !== FULL_GATE);
    check("(O) ⭐ card f862f9c5: the RECLASSIFIED command folds in every scripts-text scanner — proves reclassified.changedScriptFiles is read and used, not just the pre-wait emitCompareScriptFiles",
      typeof capturedGate2 === "string" && CHANGED_SCRIPT_SCANNER_BASENAMES.every((s) => capturedGate2.includes(`node packages/daemon/test/${s}`)));
    check("(O) O2's warning also names the reclassified scripts-text-scanner count",
      typeof confirm2.warning === "string" && new RegExp(`also ran the ${CHANGED_SCRIPT_SCANNER_BASENAMES.length} scripts-text-scanner test\\(s\\)`).test(confirm2.warning));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a shell-metacharacter test file path fails closed before ever reaching buildReducedGateCommand's shell string; a diff touching ONLY a test/fixtures/*.mjs file fails closed to the full gate (card 815b4b30); and — card 44968963 — a diff touching a real test file plus its backing fixtures/ file no longer reduces at all, and neither does one touching a fixture plus only ONE of its several real consumers, since an untouched sibling consumer of that same fixture can't be proven unaffected; and — card 7183540f — a branch that gains a further BEHAVIORAL commit while genuinely queued on the semaphore's CAP (not a per-repo guard) is caught at admission too, never riding through on a stale pre-wait REDUCED verdict; and — card 66b3112a — a PRELANDED branch whose main gains a genuinely behavioral edit during that same cap-queue wait, with the branch itself staying byte-stable, is ALSO caught by the main leg's own admission-time HEAD read, never riding through on a stale pre-wait REDUCED verdict either (a detection fix, not a merge-safety one — the squash there is a provable no-op regardless); and — card abaaf16e — a branch that gains a FURTHER comment-only commit while queued reclassifies to eligible:true again through the SAME admission-time re-derivation, and that reclassified command folds in every CHANGED_TS_TEXT_SCANNER_REPO_PATHS member too, proving the reclassification branch reads changedTsPaths, not just the pre-wait classification; and — card f862f9c5 — the identical reclassification branch also folds in every CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS member on ITS OWN, independent changedScriptFiles trigger for a scripts/**-only comment-only edit. See emit-compare-gate.mjs for the base classification, scope-boundary, and soundness cases."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
