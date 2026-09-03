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
//   (B) ONE-TOKEN BEHAVIORAL .ts edit -> FULL gate, byte-identical to the configured gateCommand — AND
//       card 2db8a3dd: `emitCompareReduced:false` on the merge-confirm result, the POSITIVE-CONTROL
//       polarity (a real, decidable "ran, proven not reduced" verdict for a Loom-layout diff).
//   (C) WHITESPACE-ONLY .ts edit (blank lines only, no comment/token change) -> REDUCED gate.
//   (D) THE §2 COUNTEREXAMPLE, ENCODED: a comment-only test/*.mjs edit that introduces the literal string
//       `Date.now()` inside a comment -> the reduced command STILL contains every static guard (incl. the
//       one that would flag a REAL `Date.now()` site) AND runs the changed test file itself directly —
//       never silently dropped because the surrounding diff "looked" comment-only.
//   (M) card dd4349ff — RED-PROOF: buildReducedGateCommand must invoke a changed test file THROUGH THE
//       HARNESS (`test:daemon --only=<names>`), never as a bare `node <path>`.
//   (E) SCOPE BOUNDARY — an ADDED .ts file (status A, not M) -> FULL gate (fails closed on non-modify).
//   (F) SCOPE BOUNDARY — a changed path outside both scoped prefixes (packages/daemon/scripts/**) -> FULL
//       gate, even though every OTHER changed path in the same diff is a comment-only .ts edit. Card
//       2db8a3dd: this is also the NOT-APPLICABLE-TO-THIS-REPO polarity — the exact catch-all shape a
//       genuinely non-Loom-layout repo hits on its first changed path, always. Asserts
//       `computeEmitCompareGate`'s own `notApplicable:true` directly, AND that the merge-confirm result's
//       `emitCompareReduced` is OMITTED (never a fabricated `false`) — distinct from (B)'s real `false`.
//   (G) SOUNDNESS — Code Review (manager #128): emitDecoratorMetadata:true in the PACKAGE tsconfig
//       (packages/daemon/tsconfig.json), NOT the base one, must ALSO force FULL gate on an otherwise
//       comment-only .ts edit.
//   (N) card b97f643d — a provably-inert `docs/**` path (already certified by `INERT_MERGE_PATH_PREFIXES`,
//       the SAME allowlist `isInertMergeDiff` trusts to skip the gate ENTIRELY for an all-docs diff) must
//       be SKIPPED during classification, not treated as "outside emit-compare scope" — a comment-only .ts
//       edit plus one docs/ line must still REDUCE. This exercises the ONE path order real git actually
//       produces here: `git diff --name-status` is lexically ordered and "docs/" always sorts before
//       "packages/" for this repo's two scoped prefixes, so no real invocation on this repo can construct
//       the reverse order — order-independence is NOT proven by this test. It instead rests on a structural
//       argument: the skip is an unconditional per-line `continue` that reads no state accumulated from
//       prior iterations (`changedTsFiles`/`changedTestFiles` are never consulted before the skip decision),
//       so its outcome for a given path cannot depend on where that path sits in the diff. Card 8ee4f11e
//       (Code Review follow-up on b97f643d): the skipped docs/ path must also be NAMED in the reduced-gate
//       warning, same discipline as `notHermeticExcluded` — (N) now asserts the path appears by name, not
//       just that some "reduced" warning fired.
//   (O) card 5149c036 — a repo-root `CLAUDE.md` change alongside an otherwise comment-only .ts edit must
//       still force the FULL gate — same shape as (F), pinned explicitly for the real specimen this card
//       investigated. See merge-gate-inert-diff.mjs scenario (M) for the CLAUDE.md-ONLY companion.
// See `emit-compare-gate-scope.mjs` for (H)-(L): the shell-metacharacter defence-in-depth case, the two
// fixtures/-scope cases, and the branch-blind-at-cap-queue-admission case.
// Run: 1) build daemon (pnpm build), 2) node test/emit-compare-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ecg-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

// `_emit-compare-fixtures.mjs` has its OWN top-level `await import("../dist/git/worktrees.js")` (to
// derive GUARD_BASENAMES from the real STATIC_GUARD_REPO_PATHS) — a STATIC import of it here would be
// hoisted and evaluated before the LOOM_HOME lines above ever run, letting that transitive import lock
// paths.js's module-level DB_PATH to the real ~/.loom before this file's own override takes effect (the
// prod-DB guard then correctly refuses `new Db()` below). Importing it dynamically, after LOOM_HOME is
// set, keeps this file's own env setup ahead of anything that reads it.
const {
  GIT_ID, FULL_GATE, GUARD_BASENAMES, seed, mkdirp, mk, BASE_SRC, makeRepoWithBaseSrcFile,
  writeRealTestDaemonScript,
} = await import("./_emit-compare-fixtures.mjs");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, buildReducedGateCommand, computeEmitCompareGate } = await import("../dist/git/worktrees.js");

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
    // Card cf4aa7d1 DoD-3 (positive control, compiled-file arm): the check DID run here (a real compiled
    // .ts file changed and was proven transpile-identical) — the count must stay fully informative, never
    // swap to the "not applicable" wording that's reserved for the test-only arm.
    check("(A) card cf4aa7d1: the informative compiled-count wording is used (the check genuinely ran)",
      typeof confirm.warning === "string" && /1 compiled file\(s\) proven transpile-identical/.test(confirm.warning));
    // Card cf4aa7d1 (negative control): no test file was run in isolation here (a comment-only .ts edit
    // touches no test/*.mjs path) — the isolation caveat must NOT appear on a reduction that never ran a
    // test file directly.
    check("(A) card cf4aa7d1: no isolation caveat — this reduction never ran a test file in isolation",
      typeof confirm.warning === "string" && !/ISOLATION/.test(confirm.warning));
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
    // Card cf4aa7d1 DoD-3 (negative control, FULL gate): a real full-suite run must carry neither the
    // isolation caveat nor the "not applicable" compiled-clause wording — both are ONLY ever assembled
    // inside the `emitCompareSkip` branch, which a genuinely full (non-reduced) gate never enters.
    check("(B) card cf4aa7d1: no isolation caveat on a full (non-reduced) gate",
      !(typeof confirm.warning === "string" && /ISOLATION/.test(confirm.warning)));
    // Card 2db8a3dd: a genuinely Loom-layout diff that the predicate evaluated and proved NOT reducible —
    // the POSITIVE-CONTROL polarity of `emitCompareReduced`. Must stay a real, decidable `false`, never
    // swallowed by the `notApplicable` widening below (that widening is scoped to (F)'s shape, not this
    // one).
    check("(B) emitCompareReduced:false — genuinely proven not reduced, never omitted", confirm.emitCompareReduced === false);
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
    // Card 17cd1f30: a top-level changed test/*.mjs file now ALSO needs loadNotHermeticNames to resolve
    // (classification against NOT_HERMETIC happens for every changed test file, not just ones inside a
    // subdirectory) — a REAL, self-resolving test-daemon.mjs so that load genuinely succeeds here, the
    // same reasoning writeRealTestDaemonScript's own doc gives.
    writeRealTestDaemonScript(D.repo);
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
    for (const g of GUARD_BASENAMES) check(`(M) still runs guard ${g} bare (card 49c50b80: safe under any LOOM_HOME via _guard.mjs's isTestCreatedHome, not because guards avoid touching it)`, cmd.includes(`node packages/daemon/test/${g}`));
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
    const baseSha = execSync("git rev-parse HEAD", { cwd: F.repo }).toString().trim();
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

    // Card 2db8a3dd: THIS is the shape a genuinely non-Loom-layout repo hits on its FIRST changed path,
    // always — the predicate could never have been eligible here, independent of the OTHER (reducible)
    // path in the same diff. Direct call (mirrors (N2)'s pattern) so the assertion is against the
    // predicate's own verdict, not re-derived from the merge-confirm result. MUST run BEFORE
    // confirmWorkerMerge — see (N2)'s own comment for why (the merge advances/deletes the branch this reads).
    const direct = await computeEmitCompareGate(F.repo, worktreePath, baseSha, branch);
    check("(F) direct call: not eligible", direct.eligible === false);
    check("(F) direct call: reason IS the out-of-scope catch-all", /path outside emit-compare scope/.test(direct.reason ?? ""));
    check("(F) direct call: notApplicable:true — this is a repo-layout limit, not a proven-not-reducible verdict", direct.notApplicable === true);

    seed(db, F);
    const confirm = await sessions.confirmWorkerMerge(F.mgrId, F.workerId);
    check("(F) gateRan:true", confirm.gateRan === true);
    check("(F) captured command IS the full gate — one out-of-scope path gates the WHOLE diff", capturedGate === FULL_GATE);
    // The defect this card fixes: before the fix, `emitCompareReduced` would read `false` here too —
    // indistinguishable from (B)'s genuine "ran, proven not reduced" case, even though this diff's failure
    // has nothing to do with (B)'s reason. A cross-project reader (or a same-repo web-only diff) must see
    // this OMITTED, never a fabricated `false`.
    check("(F) emitCompareReduced OMITTED, not fabricated false — the predicate never had a chance to apply here", confirm.emitCompareReduced === undefined);
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

  // ── (N) card b97f643d — a provably-inert docs/** path alongside an otherwise-reducible comment-only .ts
  //        edit must REDUCE, not fail closed as "outside emit-compare scope". RED-first: this is expected
  //        to FAIL on pre-fix code (the specimen the card was filed from) ────────────────────────────────
  {
    const N = mk("n");
    makeRepoWithBaseSrcFile(N, BASE_SRC);
    mkdirp(path.join(N.repo, "docs", "investigations"));
    fs.writeFileSync(path.join(N.repo, "docs", "investigations", "findings.md"), "# findings\n\nline one\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: seed findings"`, { cwd: N.repo });
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(N.repo, N.projId, N.taskId);
    N.worktreePath = worktreePath; N.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "example.ts"),
      BASE_SRC.replace("explains what isReady checks", "explains what isReady checks (typo fixed)"));
    fs.appendFileSync(path.join(worktreePath, "docs", "investigations", "findings.md"), "line two\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: comment fix + one findings.md line"`, { cwd: worktreePath });
    seed(db, N);

    const confirm = await sessions.confirmWorkerMerge(N.mgrId, N.workerId);
    check("(N) merged:true", confirm.merged === true);
    check("(N) gateRan:true — a real (smaller) gate still spawns", confirm.gateRan === true);
    check("(N) the gate command WAS called exactly once", calls === 1);
    check("(N) captured command is NOT the full gate — the docs/ line does not defeat the reduction", capturedGate !== FULL_GATE);
    check("(N) captured command does NOT run the full test:daemon suite", !capturedGate.includes("test:daemon"));
    check("(N) captured command DOES still run pnpm build", capturedGate.includes("pnpm build"));
    // Card 8ee4f11e: RED-PROOF for the reported gap — pre-fix, this warning names the transpile-identical
    // count but says NOTHING about the skipped docs/ path, making "silently dropped" and "provably inert,
    // correctly skipped" indistinguishable to a reader. Assert the path is NAMED, not merely that some
    // "reduced" warning fired — a warning that fires but omits the path would pass the old, weaker
    // assertion identically, which is exactly the defect this card fixes.
    check("(N) the reduced-gate warning names the transpile-identical count",
      typeof confirm.warning === "string" && /1 compiled file\(s\) proven transpile-identical/.test(confirm.warning));
    check("(N) ⭐ THE 8ee4f11e FIX: the skipped inert docs/ path is NAMED in the warning, not silently dropped",
      typeof confirm.warning === "string" && confirm.warning.includes("docs/investigations/findings.md"));
  }

  // ── (N2) card b97f643d — NARROWING GUARD: a docs/ line riding alongside a REAL behavioral .ts edit must
  //        NOT turn what would have been a full gate into a reduced one — the skip only ever removes an
  //        already-inert path from consideration, it never widens what counts as eligible ──────────────
  {
    const N2 = mk("n2");
    makeRepoWithBaseSrcFile(N2, BASE_SRC);
    mkdirp(path.join(N2.repo, "docs"));
    fs.writeFileSync(path.join(N2.repo, "docs", "notes.md"), "# notes\n\nline one\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: seed notes"`, { cwd: N2.repo });
    const baseSha = execSync("git rev-parse HEAD", { cwd: N2.repo }).toString().trim();
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(N2.repo, N2.projId, N2.taskId);
    N2.worktreePath = worktreePath; N2.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "example.ts"), BASE_SRC.replace("x === 0", "x === 1"));
    fs.appendFileSync(path.join(worktreePath, "docs", "notes.md"), "line two\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "fix: correct isReady threshold + a docs note"`, { cwd: worktreePath });

    // Code Review, card b97f643d: `capturedGate === FULL_GATE` alone is BLIND to whether the skip is even
    // present — a `.ts` edit that isn't transpile-identical fails closed to the full gate for that reason
    // alone, with or without the docs/ line, so that assertion by itself passes identically pre-fix and
    // post-fix and never actually witnesses the skip. Call `computeEmitCompareGate` directly and assert
    // WHICH reason fired: it must be the real behavioral-edit reason, never the pre-fix "docs/ path is
    // outside emit-compare scope" reason the skip exists to eliminate. MUST run BEFORE confirmWorkerMerge:
    // the merge below deletes/advances the branch this reads, so calling it after would read post-merge
    // repo state instead of the diff being classified (measured: doing this after the merge silently
    // changes the failure to "git error reading the diff" — a different, unrelated reason that happens to
    // also not match either regex, which would have made this assertion pass for the wrong cause).
    const direct = await computeEmitCompareGate(N2.repo, worktreePath, baseSha, branch);
    check("(N2) direct call: still not eligible", direct.eligible === false);
    check("(N2) direct call: reason IS the real behavioral-edit reason", /not transpile-identical/.test(direct.reason ?? ""));
    check("(N2) direct call: reason is NOT the pre-fix docs/-out-of-scope reason", !/path outside emit-compare scope/.test(direct.reason ?? ""));

    seed(db, N2);
    const confirm = await sessions.confirmWorkerMerge(N2.mgrId, N2.workerId);
    check("(N2) gateRan:true", confirm.gateRan === true);
    check("(N2) captured command IS the full gate — a real behavioral edit alongside a docs/ line still fails closed", capturedGate === FULL_GATE);
  }

  // ── (O) card 5149c036 — THE LITERAL MOTIVATING CASE, PAIRED WITH A REDUCIBLE EDIT: a repo-root
  //        `CLAUDE.md` change riding alongside an OTHERWISE comment-only .ts edit must still force the FULL
  //        gate, never reduce — same shape as (F) (an out-of-scope path defeats an otherwise-reducible
  //        diff), pinned explicitly for the real specimen this card investigated. See
  //        merge-gate-inert-diff.mjs scenario (M) for the CLAUDE.md-ONLY companion (the full-SKIP question,
  //        `isInertMergeDiff`) — this one is the REDUCED-gate question (`computeEmitCompareGate`) ─────────
  {
    const O = mk("o");
    makeRepoWithBaseSrcFile(O, BASE_SRC);
    const baseSha = execSync("git rev-parse HEAD", { cwd: O.repo }).toString().trim();
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(O.repo, O.projId, O.taskId);
    O.worktreePath = worktreePath; O.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "example.ts"),
      BASE_SRC.replace("explains what isReady checks", "explains what isReady checks (typo fixed)"));
    fs.writeFileSync(path.join(worktreePath, "CLAUDE.md"), "# Loom\n\nsome repo-root doc content\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: comment fix + repo-root CLAUDE.md"`, { cwd: worktreePath });

    const direct = await computeEmitCompareGate(O.repo, worktreePath, baseSha, branch);
    check("(O) direct call: not eligible — CLAUDE.md is outside emit-compare scope", direct.eligible === false);
    check("(O) direct call: reason IS the out-of-scope catch-all, naming CLAUDE.md", /path outside emit-compare scope: CLAUDE\.md/.test(direct.reason ?? ""));
    check("(O) direct call: notApplicable:true — a repo-layout limit, not a proven-not-reducible verdict", direct.notApplicable === true);

    seed(db, O);
    const confirm = await sessions.confirmWorkerMerge(O.mgrId, O.workerId);
    check("(O) gateRan:true", confirm.gateRan === true);
    check("(O) captured command IS the full gate — CLAUDE.md alongside an otherwise-reducible .ts edit still fails closed", capturedGate === FULL_GATE);
    check("(O) emitCompareReduced OMITTED, not fabricated false", confirm.emitCompareReduced === undefined);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — comment-only and whitespace-only .ts edits reduce the gate (build + guards, no full test:daemon suite); a one-token behavioral edit, an added .ts file, and an out-of-scope path all still force the full gate; a comment-only test/*.mjs edit introducing Date.now() still runs every static guard plus the changed test file itself; emitDecoratorMetadata in EITHER tsconfig (base or the daemon package's own) fails closed; a provably-inert docs/** path no longer defeats the reduction when riding alongside a comment-only .ts edit, while still failing closed alongside a real behavioral edit (card b97f643d); and the literal motivating case (card 5149c036) — a repo-root CLAUDE.md change alongside an otherwise comment-only .ts edit — also still fails closed to the full gate (O). See emit-compare-gate-scope.mjs for the shell-metacharacter, fixtures-scope, and cap-queue-admission cases."
  + " Card 2db8a3dd: (B)'s emitCompareReduced:false (proven-not-reducible) and (F)'s emitCompareReduced:undefined + direct notApplicable:true (repo-layout limit) are the two required polarities."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
