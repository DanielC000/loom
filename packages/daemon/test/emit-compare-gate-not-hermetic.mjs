import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// EMIT-COMPARE REDUCED-GATE test, PART 3 — card 17cd1f30. A REAL, REPRODUCED merge blocker: merge op
// `5113c720` (branch `loom/6da4175a276a`) failed at the test step because `buildReducedGateCommand` fed
// `test:daemon --only=` four NOT_HERMETIC names (board-consistency, busy-flag, usage-limit-detect,
// usage-limit-resume) — `resolveSelection` (scripts/test-daemon.mjs) correctly refuses any `--only=` name
// outside the discovered hermetic set, so EVERY re-fire failed identically. See computeEmitCompareGate's
// own `notHermeticExcluded` doc (git/worktrees.ts) for the fix: a NOT_HERMETIC changed test file is now
// filtered OUT of `--only=` (never blocking eligibility — the FULL gate never runs it either) and
// DECLARED BY NAME in the merge result's `warning`, never silently dropped.
//
// Same REAL-git-on-temp-repos style as the sibling files (uses REAL_TEST_DAEMON_SCRIPT so
// loadNotHermeticNames genuinely dynamic-imports the real NOT_HERMETIC set, never a hand-typed stub):
//   (N) MIXED — a diff changing one ordinary test file PLUS one NOT_HERMETIC-named test file still
//       reduces: the NOT_HERMETIC name is filtered out of `--only=`, the ordinary name is not, and the
//       exclusion is declared by name in `confirm.warning`. This is the exact `5113c720` shape.
//   (O) ALL-HERMETIC, POSITIVE CONTROL — a diff touching only ordinary test file(s), no NOT_HERMETIC name
//       anywhere in the diff, must produce the BYTE-IDENTICAL command this mechanism produced before this
//       card — proving the fix does not alter the normal path.
//   (P) ALL-NOT_HERMETIC — every changed test file is NOT_HERMETIC: `changedTestFiles` empties out, no
//       `test:daemon` step is emitted at all (build + static guards only), and this must NOT read as an
//       ordinary green — `confirm.warning` still declares the exclusion. Deliberately NOT a refusal: the
//       full gate never ran these files either, so zero test-step coverage here is parity with the full
//       gate, not a regression the reduction introduced (see computeEmitCompareGate's own DoD-3 doc).
// Run: 1) build daemon (pnpm build), 2) node test/emit-compare-gate-not-hermetic.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { cleanupPathSync, registerForCleanup } from "./_tmp-fixture.mjs";
import {
  GIT_ID, FULL_GATE, GUARD_BASENAMES, seed, mkdirp, mk, writeRealTestDaemonScript,
} from "./_emit-compare-fixtures.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ecgnh-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// One real, currently-live NOT_HERMETIC name (scripts/test-daemon.mjs) — chosen to match the actual
// `5113c720` specimen rather than an invented placeholder name.
const NOT_HERMETIC_NAME = "board-consistency";

function initRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  registerForCleanup(p.repo);
  fs.writeFileSync(path.join(p.repo, "README.md"), "# ecg\n");
  mkdirp(path.join(p.repo, "packages", "daemon", "test"));
  // Card 17cd1f30: a REAL, fully self-resolving test-daemon.mjs (not just REAL_TEST_DAEMON_SCRIPT alone —
  // see writeRealTestDaemonScript's own doc) so loadNotHermeticNames genuinely SUCCEEDS in these tests,
  // not merely fails closed to the full gate for an unrelated reason.
  writeRealTestDaemonScript(p.repo);
}

const dbs = [];
const worktrees = [];
try {
  // ── (N) MIXED — one ordinary test file + one NOT_HERMETIC test file changed together (the 5113c720
  //        shape) ─────────────────────────────────────────────────────────────────────────────────────
  {
    const N = mk("n");
    initRepo(N);
    fs.writeFileSync(path.join(N.repo, "packages", "daemon", "test", "kickoff-real.mjs"), "// an ordinary hermetic test\nconsole.log(\"v1\");\n");
    fs.writeFileSync(path.join(N.repo, "packages", "daemon", "test", `${NOT_HERMETIC_NAME}.mjs`), "// needs a live daemon\nconsole.log(\"v1\");\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: N.repo });
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(N.repo, N.projId, N.taskId);
    N.worktreePath = worktreePath; N.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "kickoff-real.mjs"), "// an ordinary hermetic test\nconsole.log(\"v2\");\n");
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", `${NOT_HERMETIC_NAME}.mjs`), "// needs a live daemon\nconsole.log(\"v2\");\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "test: update kickoff-real + ${NOT_HERMETIC_NAME}"`, { cwd: worktreePath });
    seed(db, N);

    const confirm = await sessions.confirmWorkerMerge(N.mgrId, N.workerId);
    check("(N) gateRan:true", confirm.gateRan === true);
    check("(N) gate called exactly once", calls === 1);
    check("(N) captured command is the REDUCED gate, not the full gate", capturedGate !== FULL_GATE);
    check("(N) ⭐ THE 5113c720 FIX: --only= carries the hermetic name", capturedGate.includes("test:daemon --only=kickoff-real"));
    check(`(N) ⭐ THE 5113c720 FIX: --only= does NOT carry the NOT_HERMETIC name "${NOT_HERMETIC_NAME}" anywhere`,
      !capturedGate.includes(NOT_HERMETIC_NAME));
    check("(N) the exclusion is DECLARED BY NAME in the merge result, not silently dropped",
      typeof confirm.warning === "string" && confirm.warning.includes(NOT_HERMETIC_NAME) && /NOT_HERMETIC/.test(confirm.warning));
  }

  // ── (O) ALL-HERMETIC, POSITIVE CONTROL — no NOT_HERMETIC name in the diff at all; the command must be
  //        BYTE-IDENTICAL to what this mechanism produced before this card ──────────────────────────────
  {
    const O = mk("o");
    initRepo(O);
    fs.writeFileSync(path.join(O.repo, "packages", "daemon", "test", "kickoff-real.mjs"), "// an ordinary hermetic test\nconsole.log(\"v1\");\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: O.repo });
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(O.repo, O.projId, O.taskId);
    O.worktreePath = worktreePath; O.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "kickoff-real.mjs"), "// an ordinary hermetic test\nconsole.log(\"v2\");\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "test: update kickoff-real"`, { cwd: worktreePath });
    seed(db, O);

    const confirm = await sessions.confirmWorkerMerge(O.mgrId, O.workerId);
    const expected = ["pnpm build", ...GUARD_BASENAMES.map((g) => `node packages/daemon/test/${g}`), "pnpm --filter @loom/daemon test:daemon --only=kickoff-real"].join(" && ");
    check("(O) gateRan:true", confirm.gateRan === true);
    check("(O) ⭐ POSITIVE CONTROL: an all-hermetic diff's command is BYTE-IDENTICAL to the pre-card shape (the fix never touches the normal path)", capturedGate === expected);
    check("(O) no NOT_HERMETIC exclusion declared (nothing was excluded)", !(typeof confirm.warning === "string" && /NOT_HERMETIC/.test(confirm.warning)));
  }

  // ── (P) ALL-NOT_HERMETIC — every changed test file is NOT_HERMETIC: no test:daemon step at all, and it
  //        must NOT read as an ordinary green ───────────────────────────────────────────────────────────
  {
    const P = mk("p");
    initRepo(P);
    fs.writeFileSync(path.join(P.repo, "packages", "daemon", "test", `${NOT_HERMETIC_NAME}.mjs`), "// needs a live daemon\nconsole.log(\"v1\");\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: P.repo });
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(P.repo, P.projId, P.taskId);
    P.worktreePath = worktreePath; P.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", `${NOT_HERMETIC_NAME}.mjs`), "// needs a live daemon\nconsole.log(\"v2\");\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "test: update ${NOT_HERMETIC_NAME}"`, { cwd: worktreePath });
    seed(db, P);

    const confirm = await sessions.confirmWorkerMerge(P.mgrId, P.workerId);
    const expected = ["pnpm build", ...GUARD_BASENAMES.map((g) => `node packages/daemon/test/${g}`)].join(" && ");
    check("(P) gateRan:true", confirm.gateRan === true);
    check("(P) still REDUCED, not the full gate (a NOT_HERMETIC-only diff is still eligible — DoD-3)", capturedGate !== FULL_GATE);
    check("(P) command is build + static guards only, NO test:daemon step at all", capturedGate === expected);
    check("(P) the all-excluded case is DECLARED, never a silent green",
      typeof confirm.warning === "string" && confirm.warning.includes(NOT_HERMETIC_NAME) && /NOT_HERMETIC/.test(confirm.warning));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 17cd1f30: a NOT_HERMETIC changed test file is filtered out of the reduced gate's --only= list (never blocking eligibility, since the full gate never runs it either) and declared by name in the merge result; an all-hermetic diff's command is byte-identical to before this card; an all-NOT_HERMETIC diff still reduces (build + guards only, no test step) and still declares the exclusion rather than reading as a silent green."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
