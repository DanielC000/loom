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
// Proves (DoD-3/DoD-2 of card 2154b6ad, the three committed controls plus the counterexample regression):
//   (A) COMMENT-ONLY .ts edit -> REDUCED gate (comments/whitespace stripped before compare -> identical).
//   (B) ONE-TOKEN BEHAVIORAL .ts edit -> FULL gate, byte-identical to the configured gateCommand.
//   (C) WHITESPACE-ONLY .ts edit (blank lines only, no comment/token change) -> REDUCED gate.
//   (D) THE §2 COUNTEREXAMPLE, ENCODED: a comment-only test/*.mjs edit that introduces the literal string
//       `Date.now()` inside a comment -> the reduced command STILL contains every static guard (incl. the
//       one that would flag a REAL `Date.now()` site) AND runs the changed test file itself directly —
//       never silently dropped because the surrounding diff "looked" comment-only.
//   (E) SCOPE BOUNDARY — an ADDED .ts file (status A, not M) -> FULL gate (fails closed on non-modify).
//   (F) SCOPE BOUNDARY — a changed path outside both scoped prefixes (packages/daemon/scripts/**) -> FULL
//       gate, even though every OTHER changed path in the same diff is a comment-only .ts edit.
//   (L) card 7183540f — BRANCH-BLIND AT CAP-QUEUE ADMISSION: `effectiveGate`/`emitCompareSkip` are
//       computed BEFORE `gateSemaphore.runExclusive`'s admission wait and were never re-derived once
//       admitted. TWO SEPARATE projects sharing ONE SessionService (default cap 1, no platform override)
//       so the second worker's confirm genuinely QUEUES on the semaphore's CAP — not a per-repo guard,
//       the wait this card names (routinely minutes at a real `maxConcurrentGates`, unlike the sub-second
//       repo-guard-only wait `db413510` closes for the sibling inert-skip path). While queued, its OWN
//       branch gains a further BEHAVIORAL edit layered on the comment-only edit that made it eligible
//       pre-wait — MUST re-derive at admission and fall back to the full gate, never ride through on the
//       stale pre-wait REDUCED verdict.
// Run: 1) build daemon (pnpm build), 2) node test/emit-compare-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertNeverWithControl, observeOnce, pollUntil } from "./_timing-guard.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ecg-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, buildReducedGateCommand } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ecg@loom -c user.name=ecg";
const now = new Date().toISOString();
const FULL_GATE = "pnpm build && pnpm --filter @loom/daemon test:daemon";
const GUARD_BASENAMES = ["clock-path-regression-guard.mjs", "fixed-wait-negative-guard.mjs", "onexit-discard-guard.mjs", "codescape-privacy-guard.mjs", "fixed-wait-witness-guard.mjs"];
// Card 815b4b30: (I)/(J) below need each fixture repo to carry a REAL, importable
// packages/daemon/scripts/test-daemon.mjs so `loadExcludedTestDirNames` (git/worktrees.ts) can actually
// resolve `EXCLUDED_DIR_NAMES` from it — using the REAL file's content (not a hand-typed stub) means these
// tests exercise the genuine reuse path end to end, with zero risk of a second, drifting copy of the
// fixtures/census name list.
const REAL_TEST_DAEMON_SCRIPT = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "test-daemon.mjs"), "utf8",
);

function seed(db, p) {
  db.insertProject({ id: p.projId, name: "ECG", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand: FULL_GATE } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "ECG-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });

// `packageTsconfigOpts` defaults to a clean `{outDir:"dist",rootDir:"src",types:["node"]}`-shaped block (no
// emitDecoratorMetadata) — pass an override to construct the (G) violation fixture below.
function makeRepoWithBaseSrcFile(p, srcContent, packageTsconfigOpts = { outDir: "dist", rootDir: "src", types: ["node"] }) {
  fs.mkdirSync(p.repo, { recursive: true });
  registerForCleanup(p.repo);
  fs.writeFileSync(path.join(p.repo, "README.md"), "# ecg\n");
  // A minimal tsconfig.base.json AND packages/daemon/tsconfig.json, both with no emitDecoratorMetadata:
  // emitCompareSoundnessOk reads BOTH from the WORKTREE (not the real Loom repo, mirroring the real
  // extends chain: packages/daemon/tsconfig.json extends tsconfig.base.json and carries its OWN
  // compilerOptions block) — without both present, every .ts scenario below would fail closed for the
  // WRONG reason (a missing fixture file), masking whether the real comparison logic is what decided
  // eligibility.
  fs.writeFileSync(path.join(p.repo, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { target: "ES2022" } }));
  mkdirp(path.join(p.repo, "packages", "daemon", "src"));
  fs.writeFileSync(path.join(p.repo, "packages", "daemon", "tsconfig.json"), JSON.stringify({ extends: "../../tsconfig.base.json", compilerOptions: packageTsconfigOpts }));
  fs.writeFileSync(path.join(p.repo, "packages", "daemon", "src", "example.ts"), srcContent);
  execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label) => ({
  projId: `ecg-${label}-proj-${sfx}`, agentId: `ecg-${label}-agent-${sfx}`, taskId: `ecg-${label}-task-${sfx}`,
  mgrId: `ecg-${label}-mgr-${sfx}`, workerId: `ecg-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-ecg-${label}-${sfx}`),
});

const BASE_SRC = [
  "// explains what isReady checks",
  "export function isReady(x: number): boolean {",
  "  return x === 0;",
  "}",
  "",
].join("\n");

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
    registerForCleanup(D.repo);
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
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: H.repo });
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(H.repo, H.projId, H.taskId);
    H.worktreePath = worktreePath; H.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "placeholder;evil.mjs"), BASE_TEST.replace("placeholder", "placeholder (renamed)"));
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: comment tweak"`, { cwd: worktreePath });
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
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: I.repo });
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(I.repo, I.projId, I.taskId);
    I.worktreePath = worktreePath; I.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "fixtures", "fake-cli.mjs"), "console.log(\"fixture v2\");\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "chore: tweak fixture output"`, { cwd: worktreePath });
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
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: J.repo });
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(J.repo, J.projId, J.taskId);
    J.worktreePath = worktreePath; J.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "kickoff-real.mjs"), BASE_TEST.replace("backed by a fixture", "backed by a fixture (updated)"));
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "fixtures", "fake-cli.mjs"), "console.log(\"fixture v2\");\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "test: update kickoff test + its backing fixture"`, { cwd: worktreePath });
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
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: K.repo });
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
    execSync(`git add . && git ${GIT_ID} commit -q -m "test: update one consumer + the shared fixture"`, { cwd: worktreePath });
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
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: L1.repo });

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
    execSync(`git add . && git ${GIT_ID} commit -q -m "chore: unrelated cap-slot occupant"`, { cwd: L1.worktreePath });
    seed(db, L1);

    const wt2 = await createWorktree(L2.repo, L2.projId, L2.taskId);
    L2.worktreePath = wt2.worktreePath; L2.branch = wt2.branch; worktrees.push(wt2.worktreePath);
    // Pre-wait: a COMMENT-ONLY edit — eligible for the reduced gate, classified BEFORE admission (case A).
    fs.writeFileSync(path.join(L2.worktreePath, "packages", "daemon", "src", "example.ts"),
      BASE_SRC.replace("explains what isReady checks", "explains what isReady checks (typo fixed)"));
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: fix comment typo"`, { cwd: L2.worktreePath });
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
    execSync(`git add . && git ${GIT_ID} commit -q -m "fix: correct isReady threshold during the cap-queue wait"`, { cwd: L2.worktreePath });

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
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — comment-only and whitespace-only .ts edits reduce the gate (build + guards, no full test:daemon suite); a one-token behavioral edit, an added .ts file, and an out-of-scope path all still force the full gate; a comment-only test/*.mjs edit introducing Date.now() still runs every static guard plus the changed test file itself; emitDecoratorMetadata in EITHER tsconfig (base or the daemon package's own) fails closed; and a shell-metacharacter test file path fails closed before ever reaching buildReducedGateCommand's shell string; a diff touching ONLY a test/fixtures/*.mjs file fails closed to the full gate (card 815b4b30); and — card 44968963 — a diff touching a real test file plus its backing fixtures/ file no longer reduces at all, and neither does one touching a fixture plus only ONE of its several real consumers, since an untouched sibling consumer of that same fixture can't be proven unaffected; and — card 7183540f — a branch that gains a further BEHAVIORAL commit while genuinely queued on the semaphore's CAP (not a per-repo guard) is caught at admission too, never riding through on a stale pre-wait REDUCED verdict."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
