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
// Run: 1) build daemon (pnpm build), 2) node test/emit-compare-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ecg-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ecg@loom -c user.name=ecg";
const now = new Date().toISOString();
const FULL_GATE = "pnpm build && pnpm --filter @loom/daemon test:daemon";
const GUARD_BASENAMES = ["clock-path-regression-guard.mjs", "fixed-wait-negative-guard.mjs", "onexit-discard-guard.mjs", "codescape-privacy-guard.mjs"];

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
    check("(D) captured command is the REDUCED gate (test/*.mjs never blocks eligibility on its own)", capturedGate !== FULL_GATE && !capturedGate.includes("test:daemon"));
    for (const g of GUARD_BASENAMES) check(`(D) reduced command STILL runs guard ${g} despite the Date.now() text`, capturedGate.includes(g));
    check("(D) reduced command runs the changed test file itself directly", capturedGate.includes("packages/daemon/test/placeholder.mjs"));
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
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — comment-only and whitespace-only .ts edits reduce the gate (build + guards, no full test:daemon suite); a one-token behavioral edit, an added .ts file, and an out-of-scope path all still force the full gate; a comment-only test/*.mjs edit introducing Date.now() still runs every static guard plus the changed test file itself; emitDecoratorMetadata in EITHER tsconfig (base or the daemon package's own) fails closed; and a shell-metacharacter test file path fails closed before ever reaching buildReducedGateCommand's shell string."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
