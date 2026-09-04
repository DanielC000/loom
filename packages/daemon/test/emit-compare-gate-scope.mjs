import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
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
// Run: 1) build daemon (pnpm build), 2) node test/emit-compare-gate-scope.mjs
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
} = await import("./_emit-compare-fixtures.mjs");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbs = [];
const worktrees = [];
try {
  // ── (H) DEFENCE-IN-DEPTH — Code Review (manager #128): a changed test/*.mjs path carrying a shell
  //        metacharacter must fail closed rather than reach buildReducedGateCommand's `&&`-joined,
  //        shell-executed string ─────────────────────────────────────────────────────────────────────
  {
    const H = mk("h");
    const BASE_TEST = ["// placeholder", "console.log(\"PASS  placeholder\");", "process.exit(0);", ""].join("\n");
    fs.mkdirSync(H.repo, { recursive: true });
    registerForCleanup(H.repo);
    fs.writeFileSync(path.join(H.repo, "README.md"), "# ecg\n");
    mkdirp(path.join(H.repo, "packages", "daemon", "test"));
    // A semicolon is a valid NTFS/POSIX filename character but a shell metacharacter — exactly the case
    // the allowlist exists to reject before it ever reaches a shell-executed command string.
    fs.writeFileSync(path.join(H.repo, "packages", "daemon", "test", "placeholder;evil.mjs"), BASE_TEST);
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: H.repo });
    commitAll(H.repo, "init", GIT_ID);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(H.repo, H.projId, H.taskId);
    H.worktreePath = worktreePath; H.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "placeholder;evil.mjs"), BASE_TEST.replace("placeholder", "placeholder (renamed)"));
    commitAll(worktreePath, "docs: comment tweak", GIT_ID);
    seed(db, H);

    const confirm = await sessions.confirmWorkerMerge(H.mgrId, H.workerId);
    check("(H) gateRan:true", confirm.gateRan === true);
    check("(H) captured command IS the full gate — a semicolon in the test file path fails closed rather than reaching the shell string", capturedGate === FULL_GATE);
  }

  // ── (I) card 815b4b30 — a diff touching ONLY a test/fixtures/*.mjs file must FAIL CLOSED to the full
  //        gate, never report a vacuous eligible:true with nothing left to run ─────────────────────────
  {
    const I = mk("i");
    fs.mkdirSync(I.repo, { recursive: true });
    registerForCleanup(I.repo);
    fs.writeFileSync(path.join(I.repo, "README.md"), "# ecg\n");
    mkdirp(path.join(I.repo, "packages", "daemon", "test", "fixtures"));
    mkdirp(path.join(I.repo, "packages", "daemon", "scripts"));
    fs.writeFileSync(path.join(I.repo, "packages", "daemon", "scripts", "test-daemon.mjs"), REAL_TEST_DAEMON_SCRIPT);
    fs.writeFileSync(path.join(I.repo, "packages", "daemon", "test", "fixtures", "fake-cli.mjs"), "console.log(\"fixture v1\");\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: I.repo });
    commitAll(I.repo, "init", GIT_ID);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(I.repo, I.projId, I.taskId);
    I.worktreePath = worktreePath; I.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "fixtures", "fake-cli.mjs"), "console.log(\"fixture v2\");\n");
    commitAll(worktreePath, "chore: tweak fixture output", GIT_ID);
    seed(db, I);

    const confirm = await sessions.confirmWorkerMerge(I.mgrId, I.workerId);
    check("(I) gateRan:true", confirm.gateRan === true);
    check("(I) captured command IS the full gate — a fixtures/-only diff fails closed rather than reporting a vacuous green", capturedGate === FULL_GATE);
    check("(I) no reduced-gate warning present", !(typeof confirm.warning === "string" && /reduced/.test(confirm.warning)));
  }

  // ── (J) card 44968963 — SUPERSEDES the pre-44968963 behavior: the ae476ab1-shaped diff (a REAL changed
  //        test file PLUS a changed test/fixtures/*.mjs file in the SAME diff) used to reduce (the real
  //        test file alone proved eligibility, and the fixture was merely excluded from selection). That
  //        left the fixture's OTHER consumers — outside this diff — unrun by either gate. Card 44968963
  //        chose to fail the WHOLE diff closed to the full gate the moment ANY fixtures/census path
  //        changes, rather than build a consumer-resolver that could silently miss one; this is the
  //        regression that decision accepts, named explicitly (not a silent behavior change) ─────────────
  {
    const J = mk("j");
    const BASE_TEST = ["// a hermetic test file backed by a fixture", "console.log(\"PASS  placeholder\");", "process.exit(0);", ""].join("\n");
    fs.mkdirSync(J.repo, { recursive: true });
    registerForCleanup(J.repo);
    fs.writeFileSync(path.join(J.repo, "README.md"), "# ecg\n");
    mkdirp(path.join(J.repo, "packages", "daemon", "test", "fixtures"));
    mkdirp(path.join(J.repo, "packages", "daemon", "scripts"));
    fs.writeFileSync(path.join(J.repo, "packages", "daemon", "scripts", "test-daemon.mjs"), REAL_TEST_DAEMON_SCRIPT);
    fs.writeFileSync(path.join(J.repo, "packages", "daemon", "test", "kickoff-real.mjs"), BASE_TEST);
    fs.writeFileSync(path.join(J.repo, "packages", "daemon", "test", "fixtures", "fake-cli.mjs"), "console.log(\"fixture v1\");\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: J.repo });
    commitAll(J.repo, "init", GIT_ID);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(J.repo, J.projId, J.taskId);
    J.worktreePath = worktreePath; J.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "kickoff-real.mjs"), BASE_TEST.replace("backed by a fixture", "backed by a fixture (updated)"));
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "fixtures", "fake-cli.mjs"), "console.log(\"fixture v2\");\n");
    commitAll(worktreePath, "test: update kickoff test + its backing fixture", GIT_ID);
    seed(db, J);

    const confirm = await sessions.confirmWorkerMerge(J.mgrId, J.workerId);
    check("(J) gateRan:true", confirm.gateRan === true);
    check("(J) captured command IS the full gate — a fixtures/ file changing alongside a real test file no longer reduces (card 44968963)", capturedGate === FULL_GATE);
  }

  // ── (K) card 44968963 DoD-4 — the motivating real-world shape: a changed fixture PLUS ONE of its several
  //        consumers, while ANOTHER real consumer of that SAME fixture sits entirely outside the diff (the
  //        `fake-codescape-cli.mjs` specimen — 6 consumers on this repo, only ever proven eligible via ONE
  //        of them before this card). Must fail closed to the full gate: nothing here can prove the
  //        untouched consumer is unaffected ──────────────────────────────────────────────────────────────
  {
    const K = mk("k");
    const CONSUMER = (name) => [
      `// consumer of fixtures/fake-cli.mjs, standing in for e.g. codescape-health-probe.mjs`,
      `console.log("PASS  ${name}");`, "process.exit(0);", "",
    ].join("\n");
    fs.mkdirSync(K.repo, { recursive: true });
    registerForCleanup(K.repo);
    fs.writeFileSync(path.join(K.repo, "README.md"), "# ecg\n");
    mkdirp(path.join(K.repo, "packages", "daemon", "test", "fixtures"));
    mkdirp(path.join(K.repo, "packages", "daemon", "scripts"));
    fs.writeFileSync(path.join(K.repo, "packages", "daemon", "scripts", "test-daemon.mjs"), REAL_TEST_DAEMON_SCRIPT);
    fs.writeFileSync(path.join(K.repo, "packages", "daemon", "test", "consumer-a.mjs"), CONSUMER("consumer-a"));
    fs.writeFileSync(path.join(K.repo, "packages", "daemon", "test", "consumer-b.mjs"), CONSUMER("consumer-b"));
    fs.writeFileSync(path.join(K.repo, "packages", "daemon", "test", "fixtures", "fake-cli.mjs"), "console.log(\"fixture v1\");\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: K.repo });
    commitAll(K.repo, "init", GIT_ID);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(K.repo, K.projId, K.taskId);
    K.worktreePath = worktreePath; K.branch = branch; worktrees.push(worktreePath);
    // Only consumer-a + the fixture change; consumer-b (an equally real consumer of the SAME fixture) is
    // untouched — exactly the shape that used to slip through with partial coverage.
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "consumer-a.mjs"), CONSUMER("consumer-a (updated)"));
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "fixtures", "fake-cli.mjs"), "console.log(\"fixture v2\");\n");
    commitAll(worktreePath, "test: update one consumer + the shared fixture", GIT_ID);
    seed(db, K);

    const confirm = await sessions.confirmWorkerMerge(K.mgrId, K.workerId);
    check("(K) gateRan:true", confirm.gateRan === true);
    check("(K) captured command IS the full gate — consumer-b (unchanged, same fixture) can't be proven unaffected", capturedGate === FULL_GATE);
  }

  // ── (L) card 7183540f — BRANCH-BLIND AT CAP-QUEUE ADMISSION — see this file's own header for the
  //        summary. L1 occupies the daemon's ONLY cap slot (default `maxConcurrentGates` 1, no platform
  //        override) with a real, held-open gate on its OWN repo. L2 (a SEPARATE repo/project — isolates
  //        the CAP wait from any per-repo/main-movement concern the sibling card already covers) starts
  //        with a comment-only .ts edit — proven emit-compare-eligible BEFORE L2 's confirm ever reaches
  //        the semaphore. Once L2 is GENUINELY queued behind L1's held-open slot, a further BEHAVIORAL
  //        edit lands on L2's own branch — the reachable sequence the card names verbatim: "the confirming
  //        worker's pty is not stopped until after the merge method returns... a worker committing once
  //        more while its own merge waits [is] an ordinary sequence, not a contrived one." ──────────────
  {
    const L1 = mk("l1"), L2 = mk("l2");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

    // L1: a plain cap-slot occupant, deliberately unrelated to emit-compare mechanics — any path outside
    // both scoped prefixes forces a real (never-reduced) gate, which is all this arm needs from it.
    fs.mkdirSync(L1.repo, { recursive: true });
    registerForCleanup(L1.repo);
    fs.writeFileSync(path.join(L1.repo, "README.md"), "# ecg\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: L1.repo });
    commitAll(L1.repo, "init", GIT_ID);

    // L2: needs the tsconfig fixtures `emitCompareSoundnessOk` reads.
    makeRepoWithBaseSrcFile(L2, BASE_SRC);

    let gate1Calls = 0, gate2Calls = 0;
    let capturedGate2;
    let gate1AdmittedResolve;
    const gate1Admitted = new Promise((res) => { gate1AdmittedResolve = res; });
    let releaseGate1;
    const fakeGate = async (gateCmd, cwd) => {
      if (cwd === L1.worktreePath) {
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

    const wt1 = await createWorktree(L1.repo, L1.projId, L1.taskId);
    L1.worktreePath = wt1.worktreePath; L1.branch = wt1.branch; worktrees.push(wt1.worktreePath);
    mkdirp(path.join(L1.worktreePath, "packages", "other"));
    fs.writeFileSync(path.join(L1.worktreePath, "packages", "other", "note.txt"), "unrelated\n");
    commitAll(L1.worktreePath, "chore: unrelated cap-slot occupant", GIT_ID);
    seed(db, L1);

    const wt2 = await createWorktree(L2.repo, L2.projId, L2.taskId);
    L2.worktreePath = wt2.worktreePath; L2.branch = wt2.branch; worktrees.push(wt2.worktreePath);
    // Pre-wait: a COMMENT-ONLY edit — eligible for the reduced gate, classified BEFORE admission (case A).
    fs.writeFileSync(path.join(L2.worktreePath, "packages", "daemon", "src", "example.ts"),
      BASE_SRC.replace("explains what isReady checks", "explains what isReady checks (typo fixed)"));
    commitAll(L2.worktreePath, "docs: fix comment typo", GIT_ID);
    seed(db, L2);

    // Fire L1's confirm first — a REAL gate, held open until manually released, occupying the daemon's
    // ONLY cap slot.
    const p1 = sessions.confirmWorkerMerge(L1.mgrId, L1.workerId);
    await gate1Admitted;
    check("(L) L1 genuinely admitted and holds the cap's only slot", sessions.gateSemaphore.snapshot().active === 1);

    // Fire L2's confirm — its pre-wait classification (comment-only -> eligible) runs BEFORE admission,
    // then it must genuinely QUEUE behind L1 on the semaphore's CAP (L1/L2 are different repos, so this is
    // never a per-repo guard wait).
    let confirm2Settled = false;
    const p2 = sessions.confirmWorkerMerge(L2.mgrId, L2.workerId).then((r) => { confirm2Settled = true; return r; });

    const queued = await pollUntil(
      () => sessions.gateSemaphore.snapshot().entries.some((e) => e.phase === "queued" && e.projectId === L2.projId),
      { timeoutMs: 10000 },
    );
    check("(L) L2 genuinely reached the semaphore's CAP-queue wait before L1 released", queued);

    const WINDOW_MS = 150;
    const neverSettled = await assertNeverWithControl({
      label: "(L) L2's confirm does NOT settle while L1's held-open gate still occupies the cap's only slot",
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
    check("(L) L2's confirm PROVABLY waited on the cap, not a fluke of scheduling", neverSettled);

    // NOW, while L2 is genuinely queued behind the cap, a further BEHAVIORAL edit lands on L2's OWN
    // branch — layered on top of the comment-only edit that made it eligible pre-wait. The COMBINED diff
    // (comment fix + token flip) is no longer transpile-identical.
    fs.writeFileSync(path.join(L2.worktreePath, "packages", "daemon", "src", "example.ts"),
      BASE_SRC.replace("explains what isReady checks", "explains what isReady checks (typo fixed)").replace("x === 0", "x === 1"));
    commitAll(L2.worktreePath, "fix: correct isReady threshold during the cap-queue wait", GIT_ID);

    releaseGate1("go");
    const confirm1 = await p1;
    const confirm2 = await p2;

    check("(L) L1 merged successfully, ran its own gate exactly once", confirm1.merged === true && gate1Calls === 1);
    check("(L) L2 merged successfully", confirm2.merged === true);
    check("(L) L2's gate command was called exactly once", gate2Calls === 1);
    check("(L) ⭐ L2's captured command IS the FULL gate — the late behavioral commit forced a re-derivation at admission, the stale pre-wait REDUCED verdict was NOT trusted",
      capturedGate2 === FULL_GATE);
    check("(L) no reduced-gate warning present on L2's result", !(typeof confirm2.warning === "string" && /reduced/.test(confirm2.warning)));
    check("(L) L2's late behavioral edit actually landed on main",
      fs.readFileSync(path.join(L2.repo, "packages", "daemon", "src", "example.ts"), "utf8").includes("x === 1"));
  }

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
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a shell-metacharacter test file path fails closed before ever reaching buildReducedGateCommand's shell string; a diff touching ONLY a test/fixtures/*.mjs file fails closed to the full gate (card 815b4b30); and — card 44968963 — a diff touching a real test file plus its backing fixtures/ file no longer reduces at all, and neither does one touching a fixture plus only ONE of its several real consumers, since an untouched sibling consumer of that same fixture can't be proven unaffected; and — card 7183540f — a branch that gains a further BEHAVIORAL commit while genuinely queued on the semaphore's CAP (not a per-repo guard) is caught at admission too, never riding through on a stale pre-wait REDUCED verdict; and — card 66b3112a — a PRELANDED branch whose main gains a genuinely behavioral edit during that same cap-queue wait, with the branch itself staying byte-stable, is ALSO caught by the main leg's own admission-time HEAD read, never riding through on a stale pre-wait REDUCED verdict either (a detection fix, not a merge-safety one — the squash there is a provable no-op regardless). See emit-compare-gate.mjs for the base classification, scope-boundary, and soundness cases."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
