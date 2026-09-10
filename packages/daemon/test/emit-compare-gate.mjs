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
//   (F) SCOPE BOUNDARY — a changed path outside both scoped prefixes (packages/web/**, still genuinely
//       out of scope after card 82662e98 widened emit-compare to cover packages/daemon/scripts/** too)
//       -> FULL gate, even though every OTHER changed path in the same diff is a comment-only .ts edit.
//       Card 2db8a3dd: this is also the NOT-APPLICABLE-TO-THIS-REPO polarity — the exact catch-all shape a
//       genuinely non-Loom-layout repo hits on its first changed path, always. Asserts
//       `computeEmitCompareGate`'s own `notApplicable:true` directly, AND that the merge-confirm result's
//       `emitCompareReduced` is OMITTED (never a fabricated `false`) — distinct from (B)'s real `false`.
//   (P) card 82662e98 — COMMENT-ONLY packages/daemon/scripts/**/*.mjs edit -> REDUCED gate, the SAME shape
//       as (A) but for the new scripts/** scope (a plain parse/reprint at `target:ESNext`, not a `.ts`
//       compile at `target:ES2022` — see EMIT_COMPARE_SCRIPTS_PREFIX's own doc for why the target differs).
//   (Q) card 82662e98 — an ADDED packages/daemon/scripts/**/*.mjs file (status A, not M) -> FULL gate, the
//       SAME shape as (E) but for scripts.
//   (R) card 82662e98 — a REAL BEHAVIORAL one-token edit to a packages/daemon/scripts/**/*.mjs file -> FULL
//       gate — the polarity-trap negative control: proves the new comparison correctly REFUSES a genuine
//       code change, not just accepts a comment-only one.
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
//   (T) card abaaf16e — RED-PROOF, direct unit-level: buildReducedGateCommand folds
//       DIST_TEXT_SCANNER_REPO_PATHS in (bare `node`) iff a changed compiled .ts path is passed — a changed
//       test/*.mjs file alone does not trigger it. (A)/(D) above carry the same two legs through a REAL
//       end-to-end diff instead of a direct call.
//   (S) card fe848bfc — THE DISCRIMINATING CASE for dropping computeEmitCompareGate's repoPath arg: `ref`
//       is `"HEAD"`, a PER-WORKTREE ref (unlike the branch NAME every other scenario above passes, which
//       resolves identically from canonical or the worktree) — resolved against a worktree whose own HEAD
//       genuinely diverges from canonical's checked-out HEAD. Direct call proves the real behavioral edit
//       (committed only to the worktree) is seen; a RED-PROOF control shows the pre-fix repoPath/"HEAD"
//       shape (resolving "HEAD" from canonical instead) would have seen an EMPTY diff — the exact silent
//       wrong-answer shape card d422e279 fixed and this refactor makes structurally unreachable.
// See `emit-compare-gate-scope.mjs` for (H)-(L): the shell-metacharacter defence-in-depth case, the two
// fixtures/-scope cases, and the branch-blind-at-cap-queue-admission case.
// Run: 1) build daemon (pnpm build), 2) node test/emit-compare-gate.mjs
import fs from "node:fs";
import os from "node:os";
import { commitAll } from "./_git-commit.mjs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

// Card fab07aba Code Review (member-existence check, scenario (U) below): this file's own location,
// three levels up (test -> daemon -> packages -> repo root), to resolve each reduced-gate list's
// REPO-RELATIVE paths (e.g. "packages/daemon/test/agent-runs-keys.mjs") against a real filesystem path.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ecg-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

// `_emit-compare-fixtures.mjs` has its OWN top-level `await import("../dist/git/worktrees.js")` (to
// derive GUARD_BASENAMES from the real STATIC_GUARD_REPO_PATHS) — a STATIC import of it here would be
// hoisted and evaluated before the LOOM_HOME lines above ever run, letting that transitive import lock
// paths.js's module-level DB_PATH to the real ~/.loom before this file's own override takes effect (the
// prod-DB guard then correctly refuses `new Db()` below). Importing it dynamically, after LOOM_HOME is
// set, keeps this file's own env setup ahead of anything that reads it.
const {
  GIT_ID, FULL_GATE, GUARD_BASENAMES, DIST_SCANNER_BASENAMES, seed, mkdirp, mk, BASE_SRC, makeRepoWithBaseSrcFile,
  writeRealTestDaemonScript, STATIC_GUARD_REPO_PATHS, ASSET_READING_TEST_REPO_PATHS, DIST_TEXT_SCANNER_REPO_PATHS,
} = await import("./_emit-compare-fixtures.mjs");

// Card 82662e98 — (P)/(Q)/(R)'s own small synthetic `.mjs` fixture, same shape/spirit as BASE_SRC above
// (a comment line + one behavioral token to flip), scoped local to this file since no other test in the
// suite needs it.
const BASE_SCRIPT = [
  "// prints a friendly status line",
  "console.log(\"ready\");",
  "",
].join("\n");

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
    commitAll(worktreePath, "docs: fix comment typo", GIT_ID);
    seed(db, A);

    const confirm = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(A) merged:true", confirm.merged === true);
    check("(A) gateRan:true — a real (smaller) gate still spawns", confirm.gateRan === true);
    check("(A) the gate command WAS called exactly once", calls === 1);
    check("(A) captured command is NOT the full gate", capturedGate !== FULL_GATE);
    check("(A) captured command does NOT run the full test:daemon suite", !capturedGate.includes("test:daemon"));
    check("(A) captured command DOES still run pnpm build", capturedGate.includes("pnpm build"));
    for (const g of GUARD_BASENAMES) check(`(A) captured command runs guard ${g}`, capturedGate.includes(g));
    // Card abaaf16e — RED-PROOF (real integration leg): a REAL changed compiled .ts file (proven
    // transpile-identical, exactly this scenario's own shape) must fold every DIST_TEXT_SCANNER_REPO_PATHS
    // member into the reduced command — this is the positive leg of the fix; see scenario (D) below for
    // the negative leg (no changed .ts file -> none of these run).
    for (const s of DIST_SCANNER_BASENAMES) check(`(A) card abaaf16e: captured command runs dist-text scanner ${s} (a compiled .ts file changed)`, capturedGate.includes(`node packages/daemon/test/${s}`));
    check("(A) a distinguishing warning is present", typeof confirm.warning === "string" && /reduced/.test(confirm.warning));
    // Card cf4aa7d1 DoD-3 (positive control, compiled-file arm): the check DID run here (a real compiled
    // .ts file changed and was proven transpile-identical) — the count must stay fully informative, never
    // swap to the "not applicable" wording that's reserved for the test-only arm.
    check("(A) card cf4aa7d1: the informative compiled-count wording is used (the check genuinely ran)",
      typeof confirm.warning === "string" && /1 file\(s\) proven transpile\/parse-identical/.test(confirm.warning));
    // Card cf4aa7d1 (negative control): no test file was run in isolation here (a comment-only .ts edit
    // touches no test/*.mjs path) — the isolation caveat must NOT appear on a reduction that never ran a
    // test file directly.
    check("(A) card cf4aa7d1: no isolation caveat — this reduction never ran a test file in isolation",
      typeof confirm.warning === "string" && !/ISOLATION/.test(confirm.warning));
    // Card abaaf16e Code Review MAJOR: the warning TEXT must name that the dist-text scanners ran too — a
    // reduced gate that folded them into the actual command but left the warning saying "static guards
    // only" is the exact false-claim defect record d422e279 exists to prevent.
    check("(A) card abaaf16e: the warning names the dist-text scanners actually ran",
      typeof confirm.warning === "string" && new RegExp(`also ran the ${DIST_SCANNER_BASENAMES.length} compiled-source/dist text-scanner test\\(s\\)`).test(confirm.warning));
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
    commitAll(worktreePath, "fix: correct isReady threshold", GIT_ID);
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
    // Card fd0d34da — DoD-3 REGRESSION CONTROL: an ordinary proven-full (false) row must carry NO coarse
    // WHY at all — that field is set IFF notApplicable:true, never alongside a genuine decided false.
    check("(B, card fd0d34da — NEGATIVE CONTROL) emitCompareNotApplicableKind is undefined on a proven-full (false) merge — never fabricated alongside a real decided verdict", confirm.emitCompareNotApplicableKind === undefined);
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
    commitAll(worktreePath, "chore: reformat leading blank lines", GIT_ID);
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
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: D.repo });
    commitAll(D.repo, "init", GIT_ID);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    D.worktreePath = worktreePath; D.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "placeholder.mjs"),
      BASE_TEST.replace("no clock usage of its own", "reads state fresh against wall-clock Date.now() elsewhere"));
    commitAll(worktreePath, "docs: explain placeholder via wall-clock Date.now()", GIT_ID);
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
    // Card abaaf16e — negative leg (real integration): no compiled .ts file changed here (only
    // test/placeholder.mjs did), so none of the dist-text scanners can possibly observe anything different
    // — none should run. Mirrors (A)'s positive leg above.
    for (const s of DIST_SCANNER_BASENAMES) check(`(D) card abaaf16e: no changed .ts file -> dist-text scanner ${s} does NOT run`, !capturedGate.includes(`node packages/daemon/test/${s}`));
    check("(D) card abaaf16e: the warning does NOT claim any dist-text scanner ran (none did)",
      typeof confirm.warning === "string" && !/dist-text-scanner/.test(confirm.warning));
  }

  // ── (M) card dd4349ff — RED-PROOF: buildReducedGateCommand must invoke a changed test file THROUGH THE
  //        HARNESS (`test:daemon --only=<names>`), never as a bare `node <path>` with no LOOM_HOME/LOOM_PORT.
  //        Direct unit-level call (no git/daemon plumbing needed) so this fails for exactly the invocation
  //        defect, not anything downstream: pre-fix, buildReducedGateCommand emitted a bare `node
  //        packages/daemon/test/<file>.mjs` for each changed file — that is what made
  //        test/dev-server.mjs refuse with exit 99 at 0s and block a real release merge. ─────────────────
  {
    const cmd = buildReducedGateCommand({ changedTestFiles: ["packages/daemon/test/dev-server.mjs", "packages/daemon/test/other-thing.mjs"], changedAssetPaths: [], changedTsPaths: [] });
    check("(M) still runs pnpm build", cmd.includes("pnpm build"));
    for (const g of GUARD_BASENAMES) check(`(M) still runs guard ${g} bare (card 49c50b80: safe under any LOOM_HOME via _guard.mjs's isTestCreatedHome, not because guards avoid touching it)`, cmd.includes(`node packages/daemon/test/${g}`));
    check("(M) routes BOTH changed files through test:daemon --only=, comma-joined",
      cmd.includes("pnpm --filter @loom/daemon test:daemon --only=dev-server,other-thing"));
    check("(M) NEVER invokes a changed test file as a bare `node <path>` (the defect this card fixes)",
      !cmd.includes("node packages/daemon/test/dev-server.mjs") && !cmd.includes("node packages/daemon/test/other-thing.mjs"));
    check("(M) never runs the ~668-test suite UNFILTERED (any test:daemon step here always carries --only=)",
      !cmd.includes("test:daemon") || cmd.includes("--only="));
    // A diff with NO changed test files must still omit the test:daemon step entirely (build + guards only).
    const noTestFilesCmd = buildReducedGateCommand({ changedTestFiles: [], changedAssetPaths: [], changedTsPaths: [] });
    check("(M) zero changed test files -> no test:daemon step at all", !noTestFilesCmd.includes("test:daemon"));
  }

  // ── (T) card abaaf16e — RED-PROOF: buildReducedGateCommand must fold DIST_TEXT_SCANNER_REPO_PATHS in
  //        (bare `node <path>`, the STATIC_GUARD_REPO_PATHS shape — every member sets up its own hermetic
  //        env, so none needs the harness wrapper) whenever a changed compiled .ts file is passed, and must
  //        NOT fold it in otherwise. Direct unit-level call (no git/daemon plumbing) — pre-fix,
  //        buildReducedGateCommand took only 2 params, so a 3rd argument was silently ignored and none of
  //        these scanners ever ran on a reduced gate; a comment-only diff introducing matching text into a
  //        scanned dist/mcp/*.js file (the shape agent-runs-keys.mjs's own G3 check guards) sailed through
  //        undetected. Card abaaf16e Code Review MINOR: the input is now a REQUIRED object (never
  //        positional args with defaults) precisely so a call site can't silently drop a field the way the
  //        old 3rd positional argument could — every call below spells out all three fields explicitly. ──
  {
    const withTs = buildReducedGateCommand({ changedTestFiles: [], changedAssetPaths: [], changedTsPaths: ["packages/daemon/src/example.ts"] });
    check("(T) still runs pnpm build", withTs.includes("pnpm build"));
    for (const g of GUARD_BASENAMES) check(`(T) still runs static guard ${g}`, withTs.includes(`node packages/daemon/test/${g}`));
    for (const s of DIST_SCANNER_BASENAMES) check(`(T) a changed .ts file folds in dist-text scanner ${s}, bare (not through --only=)`, withTs.includes(`node packages/daemon/test/${s}`));
    check("(T) no test:daemon step (no changed test/*.mjs or assets path passed)", !withTs.includes("test:daemon"));

    const withoutTs = buildReducedGateCommand({ changedTestFiles: [], changedAssetPaths: [], changedTsPaths: [] });
    for (const s of DIST_SCANNER_BASENAMES) check(`(T) NO changed .ts file -> dist-text scanner ${s} does NOT run (the pre-fix shape — must stay RED before this card, GREEN after)`, !withoutTs.includes(`node packages/daemon/test/${s}`));

    // A changed test/*.mjs file alone (no .ts) must not fold the dist-text scanners in either — mirrors
    // scenario (D)'s real-integration negative leg at the unit level.
    const withTestFileOnly = buildReducedGateCommand({ changedTestFiles: ["packages/daemon/test/dev-server.mjs"], changedAssetPaths: [], changedTsPaths: [] });
    for (const s of DIST_SCANNER_BASENAMES) check(`(T) a changed TEST file (not .ts) -> dist-text scanner ${s} still does NOT run`, !withTestFileOnly.includes(`node packages/daemon/test/${s}`));
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
    commitAll(worktreePath, "feat: add second.ts", GIT_ID);
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
    mkdirp(path.join(worktreePath, "packages", "web", "src"));
    fs.writeFileSync(path.join(worktreePath, "packages", "web", "src", "helper.ts"), "export const z = 1;\n");
    commitAll(worktreePath, "docs: comment fix + new web helper", GIT_ID);

    // Card 2db8a3dd: THIS is the shape a genuinely non-Loom-layout repo hits on its FIRST changed path,
    // always — the predicate could never have been eligible here, independent of the OTHER (reducible)
    // path in the same diff. Direct call (mirrors (N2)'s pattern) so the assertion is against the
    // predicate's own verdict, not re-derived from the merge-confirm result. MUST run BEFORE
    // confirmWorkerMerge — see (N2)'s own comment for why (the merge advances/deletes the branch this reads).
    const direct = await computeEmitCompareGate(worktreePath, baseSha, branch);
    check("(F) direct call: not eligible", direct.eligible === false);
    check("(F) direct call: reason IS the out-of-scope catch-all", /path outside emit-compare scope/.test(direct.reason ?? ""));
    check("(F) direct call: notApplicable:true — this is a repo-layout limit, not a proven-not-reducible verdict", direct.notApplicable === true);
    check("(F, card fd0d34da) direct call: notApplicableKind is \"path-out-of-scope\" — the SAME diff also touches the in-scope packages/daemon/src/example.ts", direct.notApplicableKind === "path-out-of-scope");

    seed(db, F);
    const confirm = await sessions.confirmWorkerMerge(F.mgrId, F.workerId);
    check("(F) gateRan:true", confirm.gateRan === true);
    check("(F) captured command IS the full gate — one out-of-scope path gates the WHOLE diff", capturedGate === FULL_GATE);
    // The defect this card fixes: before the fix, `emitCompareReduced` would read `false` here too —
    // indistinguishable from (B)'s genuine "ran, proven not reduced" case, even though this diff's failure
    // has nothing to do with (B)'s reason. A cross-project reader (or a same-repo web-only diff) must see
    // this OMITTED, never a fabricated `false`.
    check("(F) emitCompareReduced OMITTED, not fabricated false — the predicate never had a chance to apply here", confirm.emitCompareReduced === undefined);
    check("(F, card fd0d34da) the merge-confirm result carries the SAME coarse WHY the direct call reported — the diagnosable half of what OMITTED emitCompareReduced used to leave a null-shaped mystery", confirm.emitCompareNotApplicableKind === "path-out-of-scope");
  }

  // ── (P) card 82662e98 — COMMENT-ONLY packages/daemon/scripts/**/*.mjs edit -> REDUCED gate ────────────
  {
    const P = mk("p");
    makeRepoWithBaseSrcFile(P, BASE_SRC);
    mkdirp(path.join(P.repo, "packages", "daemon", "scripts"));
    fs.writeFileSync(path.join(P.repo, "packages", "daemon", "scripts", "example.mjs"), BASE_SCRIPT);
    commitAll(P.repo, "chore: add example script", GIT_ID);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(P.repo, P.projId, P.taskId);
    P.worktreePath = worktreePath; P.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "scripts", "example.mjs"),
      BASE_SCRIPT.replace("prints a friendly status line", "prints a friendly status line (comment fix)"));
    commitAll(worktreePath, "docs: fix script comment", GIT_ID);
    seed(db, P);

    const confirm = await sessions.confirmWorkerMerge(P.mgrId, P.workerId);
    check("(P) merged:true", confirm.merged === true);
    check("(P) gateRan:true — a real (smaller) gate still spawns", confirm.gateRan === true);
    check("(P) captured command is NOT the full gate", capturedGate !== FULL_GATE);
    check("(P) captured command does NOT run the full test:daemon suite", !capturedGate.includes("test:daemon"));
    check("(P) captured command DOES still run pnpm build", capturedGate.includes("pnpm build"));
    check("(P) a distinguishing warning is present", typeof confirm.warning === "string" && /reduced/.test(confirm.warning));
    check("(P) the reduced-gate warning names the file(s) count", typeof confirm.warning === "string" && /1 file\(s\) proven transpile\/parse-identical/.test(confirm.warning));
  }

  // ── (Q) card 82662e98 — an ADDED packages/daemon/scripts/**/*.mjs file (status A, not M) -> FULL gate ──
  {
    const Q = mk("q");
    makeRepoWithBaseSrcFile(Q, BASE_SRC);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(Q.repo, Q.projId, Q.taskId);
    Q.worktreePath = worktreePath; Q.branch = branch; worktrees.push(worktreePath);
    mkdirp(path.join(worktreePath, "packages", "daemon", "scripts"));
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "scripts", "new-helper.mjs"), BASE_SCRIPT);
    commitAll(worktreePath, "feat: add new-helper.mjs", GIT_ID);
    seed(db, Q);

    const confirm = await sessions.confirmWorkerMerge(Q.mgrId, Q.workerId);
    check("(Q) gateRan:true", confirm.gateRan === true);
    check("(Q) captured command IS the full gate — an ADDED script file fails closed", capturedGate === FULL_GATE);
  }

  // ── (R) card 82662e98 — a REAL BEHAVIORAL one-token edit to a scripts/**/*.mjs file -> FULL gate
  //        (the polarity-trap negative control: correctly REFUSES a genuine code change) ─────────────────
  {
    const R = mk("r");
    makeRepoWithBaseSrcFile(R, BASE_SRC);
    mkdirp(path.join(R.repo, "packages", "daemon", "scripts"));
    fs.writeFileSync(path.join(R.repo, "packages", "daemon", "scripts", "example.mjs"), BASE_SCRIPT);
    commitAll(R.repo, "chore: add example script", GIT_ID);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(R.repo, R.projId, R.taskId);
    R.worktreePath = worktreePath; R.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "scripts", "example.mjs"),
      BASE_SCRIPT.replace("ready", "steady"));
    commitAll(worktreePath, "fix: change script status text", GIT_ID);
    seed(db, R);

    const confirm = await sessions.confirmWorkerMerge(R.mgrId, R.workerId);
    check("(R) gateRan:true", confirm.gateRan === true);
    check("(R) captured command IS the full gate — a real behavioral script edit fails closed", capturedGate === FULL_GATE);
    check("(R) emitCompareReduced:false — a real, decidable not-reduced verdict, not omitted", confirm.emitCompareReduced === false);
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
    commitAll(worktreePath, "docs: fix comment typo", GIT_ID);
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
    commitAll(N.repo, "docs: seed findings", GIT_ID);
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
    commitAll(worktreePath, "docs: comment fix + one findings.md line", GIT_ID);
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
      typeof confirm.warning === "string" && /1 file\(s\) proven transpile\/parse-identical/.test(confirm.warning));
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
    commitAll(N2.repo, "docs: seed notes", GIT_ID);
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
    commitAll(worktreePath, "fix: correct isReady threshold + a docs note", GIT_ID);

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
    const direct = await computeEmitCompareGate(worktreePath, baseSha, branch);
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
    commitAll(worktreePath, "docs: comment fix + repo-root CLAUDE.md", GIT_ID);

    const direct = await computeEmitCompareGate(worktreePath, baseSha, branch);
    check("(O) direct call: not eligible — CLAUDE.md is outside emit-compare scope", direct.eligible === false);
    check("(O) direct call: reason IS the out-of-scope catch-all, naming CLAUDE.md", /path outside emit-compare scope: CLAUDE\.md/.test(direct.reason ?? ""));
    check("(O) direct call: notApplicable:true — a repo-layout limit, not a proven-not-reducible verdict", direct.notApplicable === true);
    // Card fd0d34da: CLAUDE.md sorts BEFORE "packages/" in git's own lexical --name-status order, so this
    // is the ordering caveat's OWN shape — the catch-all fires on the FIRST changed path, yet the in-scope
    // packages/daemon/src/example.ts sits LATER in the same diff. Proves the whole-`entries` rescan (not
    // just what the classification loop consumed before returning) actually finds it: "path-out-of-scope",
    // never "repo-out-of-domain".
    check("(O, card fd0d34da) direct call: notApplicableKind is \"path-out-of-scope\" even though CLAUDE.md tripped the catch-all FIRST — the in-scope path sits later in the same diff", direct.notApplicableKind === "path-out-of-scope");

    seed(db, O);
    const confirm = await sessions.confirmWorkerMerge(O.mgrId, O.workerId);
    check("(O) gateRan:true", confirm.gateRan === true);
    check("(O) captured command IS the full gate — CLAUDE.md alongside an otherwise-reducible .ts edit still fails closed", capturedGate === FULL_GATE);
    check("(O) emitCompareReduced OMITTED, not fabricated false", confirm.emitCompareReduced === undefined);
    check("(O, card fd0d34da) merge-confirm result carries the SAME coarse WHY", confirm.emitCompareNotApplicableKind === "path-out-of-scope");
  }

  // ── (S) card fe848bfc — THE DISCRIMINATING CASE FOR THE ARG REMOVAL: `ref="HEAD"` resolved from a
  //        worktree whose own HEAD genuinely diverges from canonical's checked-out HEAD (a per-worktree ref
  //        — not a branch NAME, which every other direct-call scenario above passes and which resolves
  //        identically from either path). Nothing at unit level pinned "a per-worktree HEAD resolves from
  //        the path actually given" before this — only batch-merge-reduced-gate.mjs's end-to-end (POS)
  //        scenario did. Committing ONLY to the worktree (never to canonical) after the cut is what
  //        produces the divergence: `createWorktree` forks a NEW branch off canonical's HEAD at cut time,
  //        but canonical's OWN checked-out ref never moves on its own — so canonical's `HEAD` stays pinned
  //        at `baseSha` while the worktree's own `HEAD` advances to the new commit. RED-PROOF included:
  //        resolving "HEAD" from CANONICAL instead (the pre-fix `repoPath`/`"HEAD"` shape card d422e279
  //        fixed) sees an EMPTY diff — this is the exact silent-wrong-answer shape this card's refactor
  //        makes structurally unreachable, reproduced here via a direct `git diff` from canonical since the
  //        current (single-arg) signature no longer offers a way to pass canonical in by mistake. ─────────
  {
    const S = mk("s");
    makeRepoWithBaseSrcFile(S, BASE_SRC);
    const baseSha = execSync("git rev-parse HEAD", { cwd: S.repo }).toString().trim();
    const { worktreePath, branch } = await createWorktree(S.repo, S.projId, S.taskId);
    S.worktreePath = worktreePath; S.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "example.ts"), BASE_SRC.replace("x === 0", "x === 1"));
    commitAll(worktreePath, "fix: correct isReady threshold (worktree-only commit)", GIT_ID);

    const canonicalHead = execSync("git rev-parse HEAD", { cwd: S.repo }).toString().trim();
    const worktreeHead = execSync("git rev-parse HEAD", { cwd: worktreePath }).toString().trim();
    check("(S) sanity: canonical repo's own checked-out HEAD did NOT advance (stayed at baseSha) — the discriminating precondition for this scenario", canonicalHead === baseSha);
    check("(S) sanity: the worktree's own HEAD genuinely diverges from canonical's — a per-worktree ref, exactly the property card d422e279's bug depended on", worktreeHead !== canonicalHead);

    // RED PROOF: what the pre-fix repoPath/"HEAD" shape would have computed — "HEAD" resolved from
    // CANONICAL never sees the worktree-only commit, so the diff against canonical is EMPTY.
    const canonicalDiff = execSync(`git diff --name-status ${baseSha}..HEAD`, { cwd: S.repo }).toString().trim();
    check("(S) RED PROOF: resolving \"HEAD\" from canonical (the pre-fix repoPath shape) sees an EMPTY diff — the real behavioral change committed only to the worktree is invisible from there", canonicalDiff === "");

    const direct = await computeEmitCompareGate(worktreePath, baseSha, "HEAD");
    check("(S) direct call: not eligible — a real behavioral edit, correctly seen (not the empty-diff mechanism failure)", direct.eligible === false);
    check("(S) direct call: reason IS the real behavioral-edit reason — proves \"HEAD\" was resolved from the WORKTREE's own tip, not canonical's", /not transpile-identical/.test(direct.reason ?? ""));
    check("(S) direct call: reason is NOT the empty-diff reason the pre-fix repoPath/\"HEAD\" bug would have produced", !/empty diff/.test(direct.reason ?? ""));
    check("(S) direct call: notApplicable:false — a real, decided verdict about the worktree's own content, never a git-mechanism failure", direct.notApplicable === false);
  }

  // ════════ (U) card fab07aba Code Review — MEMBER-EXISTENCE CHECK for all three reduced-gate lists ════════
  // Nothing previously asserted these files actually EXIST. A later rename/delete of any member passes its
  // OWN full gate (the full suite never runs any of these three lists as a group — STATIC_GUARD_REPO_PATHS
  // members run individually as part of the corpus-wide guard sweep, but nothing runs `node <path>` against
  // every list member the way `buildReducedGateCommand` does), then every LATER reduced merge gate
  // fleet-wide fails on `node <missing-path>` — misattributed to whoever's branch happened to trigger the
  // reduced path next, not to the rename/delete that actually broke it.
  {
    const allListedPaths = [...STATIC_GUARD_REPO_PATHS, ...ASSET_READING_TEST_REPO_PATHS, ...DIST_TEXT_SCANNER_REPO_PATHS];
    check("(U) sanity: the three lists together name a non-trivial number of files (control isn't vacuous over an empty union)", allListedPaths.length > 30);
    const missingReal = allListedPaths.filter((p) => !fs.existsSync(path.join(REPO_ROOT, p)));
    check(`(U) every STATIC_GUARD_REPO_PATHS/ASSET_READING_TEST_REPO_PATHS/DIST_TEXT_SCANNER_REPO_PATHS member exists on disk (missing: ${JSON.stringify(missingReal)})`, missingReal.length === 0);

    // NEGATIVE CONTROL: prove this check can actually FAIL — a synthetic path that does NOT exist must be
    // reported missing. Without this, "missingReal.length === 0" above is indistinguishable from a broken/
    // vacuous check that always reports zero missing regardless of what's on disk.
    const fakeMissing = "packages/daemon/test/__fab07aba-does-not-exist__.mjs";
    check("(U) sanity: the negative-control path genuinely does not exist (control isn't vacuous)", !fs.existsSync(path.join(REPO_ROOT, fakeMissing)));
    const withFakeMissing = [...allListedPaths, fakeMissing].filter((p) => !fs.existsSync(path.join(REPO_ROOT, p)));
    check("(U) NEGATIVE CONTROL: a synthetic missing path IS correctly flagged (exactly one, and it's the synthetic one)", withFakeMissing.length === 1 && withFakeMissing[0] === fakeMissing);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — comment-only and whitespace-only .ts edits reduce the gate (build + guards, no full test:daemon suite); a one-token behavioral edit, an added .ts file, and an out-of-scope path all still force the full gate; a comment-only test/*.mjs edit introducing Date.now() still runs every static guard plus the changed test file itself; emitDecoratorMetadata in EITHER tsconfig (base or the daemon package's own) fails closed; a provably-inert docs/** path no longer defeats the reduction when riding alongside a comment-only .ts edit, while still failing closed alongside a real behavioral edit (card b97f643d); the literal motivating case (card 5149c036) — a repo-root CLAUDE.md change alongside an otherwise comment-only .ts edit — also still fails closed to the full gate (O); and card 82662e98 — a comment-only packages/daemon/scripts/**/*.mjs edit now reduces too (P), while an added script file (Q) and a real one-token behavioral script edit (R) both still fail closed. See emit-compare-gate-scope.mjs for the shell-metacharacter, fixtures-scope, and cap-queue-admission cases."
  + " Card 2db8a3dd: (B)'s emitCompareReduced:false (proven-not-reducible) and (F)'s emitCompareReduced:undefined + direct notApplicable:true (repo-layout limit) are the two required polarities."
  + " Card fe848bfc (S): a per-worktree ref (\"HEAD\") resolved from a worktree whose HEAD genuinely diverges from canonical's sees the real worktree-only commit, never the empty diff the pre-fix repoPath/\"HEAD\" shape would have silently produced."
  + " Card fab07aba (U): every STATIC_GUARD_REPO_PATHS/ASSET_READING_TEST_REPO_PATHS/DIST_TEXT_SCANNER_REPO_PATHS member exists on disk, proven against a negative control that a synthetic missing path is correctly flagged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
