import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// EMIT-COMPARE REDUCED-GATE test (card 2154b6ad — owner-requested: two comment-only branches burned a
// full ~15min merge gate). REAL git on temp repos, an INJECTED `runGate` seam (mirrors
// merge-gate-inert-diff.mjs's own style) that CAPTURES the exact command string passed in, so these
// assertions prove WHICH command actually would have run, not just a boolean.
//
// Distinct from merge-gate-inert-diff.mjs (card db9b0130): that suite proves a gate can be skipped
// ENTIRELY (gateRan:false). This one proves a REAL, still-spawned gate (gateRan:true) gets a SMALLER
// command substituted — `pnpm build` + the static guards (+ any changed test/*.mjs file) instead of the
// project's full `gateCommand` — only when every changed compiled file is proven transpile-identical.
//
// Card 4dfc648a: this file used to also carry scenarios (H)-(L) — split into `emit-compare-gate-scope.mjs`
// (see that file's own header) so neither half needs 94%+ of the harness's per-file `TEST_TIMEOUT_MS`
// standalone. Shared fixture helpers live in `_emit-compare-fixtures.mjs` (leading `_` excludes it from
// discovery) so the two files can't drift apart on setup mechanics.
//
// THIS FILE proves (DoD-3/DoD-2 of card 2154b6ad, the three committed controls plus the counterexample
// regression, plus two scope-boundary + one soundness case):
//   (A) COMMENT-ONLY .ts edit -> REDUCED gate (comments/whitespace stripped before compare -> identical).
//   (B) ONE-TOKEN BEHAVIORAL .ts edit -> FULL gate, byte-identical to the configured gateCommand.
//   (C) WHITESPACE-ONLY .ts edit (blank lines only, no comment/token change) -> REDUCED gate.
//   (D) THE §2 COUNTEREXAMPLE, ENCODED: a comment-only test/*.mjs edit that introduces the literal string
//       `Date.now()` inside a comment -> the reduced command STILL contains every static guard (incl. the
//       one that would flag a REAL `Date.now()` site) AND runs the changed test file itself directly —
//       never silently dropped because the surrounding diff "looked" comment-only.
//   (M) card dd4349ff — RED-PROOF: buildReducedGateCommand must invoke a changed test file THROUGH THE
//       HARNESS (`test:daemon --only=<names>`), never as a bare `node <path>`.
//   (E) SCOPE BOUNDARY — an ADDED .ts file (status A, not M) -> FULL gate (fails closed on non-modify).
//   (F) SCOPE BOUNDARY — a changed path outside both scoped prefixes (packages/daemon/scripts/**) -> FULL
//       gate, even though every OTHER changed path in the same diff is a comment-only .ts edit.
//   (G) SOUNDNESS — Code Review (manager #128): emitDecoratorMetadata:true in the PACKAGE tsconfig
//       (packages/daemon/tsconfig.json), NOT the base one, must ALSO force FULL gate on an otherwise
//       comment-only .ts edit.
// See `emit-compare-gate-scope.mjs` for (H)-(L): the shell-metacharacter defence-in-depth case, the two
// fixtures/-scope cases, and the branch-blind-at-cap-queue-admission case.
// Run: 1) build daemon (pnpm build), 2) node test/emit-compare-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  GIT_ID, FULL_GATE, GUARD_BASENAMES, seed, mkdirp, mk, BASE_SRC, makeRepoWithBaseSrcFile,
} from "./_emit-compare-fixtures.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ecg-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, buildReducedGateCommand } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbs = [];
const worktrees = [];
try {
  // ── (A) COMMENT-ONLY .ts edit -> REDUCED gate ───────────────────────────────────────────────────────
  {
    const A = mk("a");
    makeRepoWithBaseSrcFile(A, BASE_SRC);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "example.ts"),
      BASE_SRC.replace("explains what isReady checks", "explains what isReady checks (typo fixed)"));
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: fix comment typo"`, { cwd: worktreePath });
    seed(db, A);

    const confirm = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(A) merged:true", confirm.merged === true);
    check("(A) gateRan:true — a real (smaller) gate still spawns", confirm.gateRan === true);
    check("(A) the gate command WAS called exactly once", calls === 1);
    check("(A) captured command is NOT the full gate", capturedGate !== FULL_GATE);
    check("(A) captured command does NOT run the full test:daemon suite", !capturedGate.includes("test:daemon"));
    check("(A) captured command DOES still run pnpm build", capturedGate.includes("pnpm build"));
    for (const g of GUARD_BASENAMES) check(`(A) captured command runs guard ${g}`, capturedGate.includes(g));
    check("(A) a distinguishing warning is present", typeof confirm.warning === "string" && /reduced/.test(confirm.warning));
  }

  // ── (B) ONE-TOKEN BEHAVIORAL .ts edit -> FULL gate ──────────────────────────────────────────────────
  {
    const B = mk("b");
    makeRepoWithBaseSrcFile(B, BASE_SRC);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "example.ts"), BASE_SRC.replace("x === 0", "x === 1"));
    execSync(`git add . && git ${GIT_ID} commit -q -m "fix: correct isReady threshold"`, { cwd: worktreePath });
    seed(db, B);

    const confirm = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(B) merged:true", confirm.merged === true);
    check("(B) gateRan:true", confirm.gateRan === true);
    check("(B) the gate command WAS called exactly once", calls === 1);
    check("(B) captured command IS byte-identical to the configured full gate", capturedGate === FULL_GATE);
    check("(B) no reduced-gate warning present", !(typeof confirm.warning === "string" && /reduced/.test(confirm.warning)));
  }

  // ── (C) WHITESPACE-ONLY .ts edit -> REDUCED gate ────────────────────────────────────────────────────
  {
    const C = mk("c");
    makeRepoWithBaseSrcFile(C, BASE_SRC);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    C.worktreePath = worktreePath; C.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "example.ts"), `\n\n${BASE_SRC}`);
    execSync(`git add . && git ${GIT_ID} commit -q -m "chore: reformat leading blank lines"`, { cwd: worktreePath });
    seed(db, C);

    const confirm = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(C) gateRan:true", confirm.gateRan === true);
    check("(C) the gate command WAS called exactly once", calls === 1);
    check("(C) captured command is the REDUCED gate, not the full one", calls === 1 && capturedGate !== FULL_GATE && !capturedGate.includes("test:daemon"));
  }

  // ── (D) THE §2 COUNTEREXAMPLE, ENCODED — a comment-only test/*.mjs edit introducing `Date.now()` still
  //        runs every static guard, and runs the changed test file itself directly ────────────────────
  {
    const D = mk("d");
    const BASE_TEST = [
      "// a hermetic test file — no clock usage of its own",
      "console.log(\"PASS  placeholder\");",
      "process.exit(0);",
      "",
    ].join("\n");
    fs.mkdirSync(D.repo, { recursive: true });
    fs.writeFileSync(path.join(D.repo, "README.md"), "# ecg\n");
    mkdirp(path.join(D.repo, "packages", "daemon", "test"));
    fs.writeFileSync(path.join(D.repo, "packages", "daemon", "test", "placeholder.mjs"), BASE_TEST);
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: D.repo });
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    D.worktreePath = worktreePath; D.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "placeholder.mjs"),
      BASE_TEST.replace("no clock usage of its own", "reads state fresh against wall-clock Date.now() elsewhere"));
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: explain placeholder via wall-clock Date.now()"`, { cwd: worktreePath });
    seed(db, D);

    const confirm = await sessions.confirmWorkerMerge(D.mgrId, D.workerId);
    check("(D) gateRan:true", confirm.gateRan === true);
    check("(D) the gate command WAS called exactly once", calls === 1);
    check("(D) captured command is the REDUCED gate (test/*.mjs never blocks eligibility on its own)", capturedGate !== FULL_GATE);
    for (const g of GUARD_BASENAMES) check(`(D) reduced command STILL runs guard ${g} despite the Date.now() text`, capturedGate.includes(g));
    // Card dd4349ff: the changed test file must run THROUGH THE HARNESS (test:daemon --only=<name>),
    // never as a bare `node <path>` — a bare invocation can't supply the fresh temp LOOM_HOME/LOOM_PORT
    // the harness contract requires, so it refuses at 0s instead of actually running (see
    // scripts/test-daemon.mjs's own header + test/_guard.mjs's requireHermeticEnv).
    check("(D) reduced command runs the changed test file THROUGH THE HARNESS (--only=), never bare",
      capturedGate.includes("pnpm --filter @loom/daemon test:daemon --only=placeholder") && !capturedGate.includes("node packages/daemon/test/placeholder.mjs"));
  }

  // ── (M) card dd4349ff — RED-PROOF: buildReducedGateCommand must invoke a changed test file THROUGH THE
  //        HARNESS (`test:daemon --only=<names>`), never as a bare `node <path>` with no LOOM_HOME/LOOM_PORT.
  //        Direct unit-level call (no git/daemon plumbing needed) so this fails for exactly the invocation
  //        defect, not anything downstream: pre-fix, buildReducedGateCommand emitted a bare `node
  //        packages/daemon/test/<file>.mjs` for each changed file — that is what made
  //        test/dev-server.mjs refuse with exit 99 at 0s and block a real release merge. ─────────────────
  {
    const cmd = buildReducedGateCommand(["packages/daemon/test/dev-server.mjs", "packages/daemon/test/other-thing.mjs"]);
    check("(M) still runs pnpm build", cmd.includes("pnpm build"));
    for (const g of GUARD_BASENAMES) check(`(M) still runs guard ${g} bare (guards never touch LOOM_HOME)`, cmd.includes(`node packages/daemon/test/${g}`));
    check("(M) routes BOTH changed files through test:daemon --only=, comma-joined",
      cmd.includes("pnpm --filter @loom/daemon test:daemon --only=dev-server,other-thing"));
    check("(M) NEVER invokes a changed test file as a bare `node <path>` (the defect this card fixes)",
      !cmd.includes("node packages/daemon/test/dev-server.mjs") && !cmd.includes("node packages/daemon/test/other-thing.mjs"));
    check("(M) never runs the ~668-test suite UNFILTERED (any test:daemon step here always carries --only=)",
      !cmd.includes("test:daemon") || cmd.includes("--only="));
    // A diff with NO changed test files must still omit the test:daemon step entirely (build + guards only).
    const noTestFilesCmd = buildReducedGateCommand([]);
    check("(M) zero changed test files -> no test:daemon step at all", !noTestFilesCmd.includes("test:daemon"));
  }

  // ── (E) SCOPE BOUNDARY — an ADDED .ts file (status A) -> FULL gate ─────────────────────────────────
  {
    const E = mk("e");
    makeRepoWithBaseSrcFile(E, BASE_SRC);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(E.repo, E.projId, E.taskId);
    E.worktreePath = worktreePath; E.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "second.ts"), "export const y = 1;\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat: add second.ts"`, { cwd: worktreePath });
    seed(db, E);

    const confirm = await sessions.confirmWorkerMerge(E.mgrId, E.workerId);
    check("(E) gateRan:true", confirm.gateRan === true);
    check("(E) captured command IS the full gate — an ADDED compiled file fails closed", capturedGate === FULL_GATE);
  }

  // ── (F) SCOPE BOUNDARY — a path outside both scoped prefixes forces FULL gate even alongside an
  //        otherwise comment-only .ts edit in the SAME diff ─────────────────────────────────────────
  {
    const F = mk("f");
    makeRepoWithBaseSrcFile(F, BASE_SRC);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(F.repo, F.projId, F.taskId);
    F.worktreePath = worktreePath; F.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "example.ts"),
      BASE_SRC.replace("explains what isReady checks", "explains what isReady checks (typo fixed)"));
    mkdirp(path.join(worktreePath, "packages", "daemon", "scripts"));
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "scripts", "helper.mjs"), "console.log(1);\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: comment fix + new script helper"`, { cwd: worktreePath });
    seed(db, F);

    const confirm = await sessions.confirmWorkerMerge(F.mgrId, F.workerId);
    check("(F) gateRan:true", confirm.gateRan === true);
    check("(F) captured command IS the full gate — one out-of-scope path gates the WHOLE diff", capturedGate === FULL_GATE);
  }

  // ── (G) SOUNDNESS — Code Review (manager #128): emitDecoratorMetadata:true in the PACKAGE tsconfig
  //        (packages/daemon/tsconfig.json), NOT the base one, must ALSO force FULL gate on an otherwise
  //        comment-only .ts edit. This is the case that would have FAILED on cecd6c60 — the original
  //        soundness check read only tsconfig.base.json ───────────────────────────────────────────────
  {
    const G = mk("g");
    makeRepoWithBaseSrcFile(G, BASE_SRC, { outDir: "dist", rootDir: "src", types: ["node"], emitDecoratorMetadata: true });
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(G.repo, G.projId, G.taskId);
    G.worktreePath = worktreePath; G.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "example.ts"),
      BASE_SRC.replace("explains what isReady checks", "explains what isReady checks (typo fixed)"));
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: fix comment typo"`, { cwd: worktreePath });
    seed(db, G);

    const confirm = await sessions.confirmWorkerMerge(G.mgrId, G.workerId);
    check("(G) gateRan:true", confirm.gateRan === true);
    check("(G) captured command IS the full gate — emitDecoratorMetadata in packages/daemon/tsconfig.json fails closed, not just in the base config", capturedGate === FULL_GATE);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — comment-only and whitespace-only .ts edits reduce the gate (build + guards, no full test:daemon suite); a one-token behavioral edit, an added .ts file, and an out-of-scope path all still force the full gate; a comment-only test/*.mjs edit introducing Date.now() still runs every static guard plus the changed test file itself; and emitDecoratorMetadata in EITHER tsconfig (base or the daemon package's own) fails closed. See emit-compare-gate-scope.mjs for the shell-metacharacter, fixtures-scope, and cap-queue-admission cases."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
