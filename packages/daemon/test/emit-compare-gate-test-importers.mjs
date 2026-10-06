import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// EMIT-COMPARE REDUCED-GATE test — card 72769424: widen the reduced gate to a changed test file's
// TRANSITIVE IMPORTERS. REAL git on temp repos + a REAL `createWorktree`, same style as the sibling
// emit-compare-gate*.mjs files — direct `computeEmitCompareGate` calls (no Db/SessionService plumbing
// needed; see emit-compare-gate.mjs's own (F)/(S) scenarios for the same direct-call pattern).
//
// THIS FILE proves (docs/decisions/72769424-test-importer-fold-in.md has the full mechanism writeup):
//   (A) THE MOTIVATING CASE — a diff touching ONLY an imported-from test file folds its importer into
//       `changedTestFiles` too. RED against the pre-card code (the importer would be ABSENT); GREEN after.
//   (B) TRANSITIVE — the changed file is imported by an underscore-prefixed HELPER, which is in turn
//       imported by a real top-level test file: the real test file is still found (transitively through
//       the helper), while the helper itself is never added as a run target.
//   (C) WILDCARD IMPORTER (fix round) — a corpus file containing a dynamic `import()` call with a
//       NON-LITERAL, unresolvable argument (a template literal) is folded in as an extra run target
//       rather than forcing the whole diff closed — the diff STAYS eligible, with a NEGATIVE CONTROL
//       proving a LITERAL dynamic import() to an UNRELATED, unchanged file is not folded in (a literal
//       argument is never a wildcard, and this one doesn't textually name the changed file either).
//   (D) NO-REGRESSION — a changed test file nobody imports folds in nothing extra (byte-identical to the
//       pre-card behavior for the ordinary case).
//   (E) NOT_HERMETIC IMPORTER — a discovered importer whose own name is NOT_HERMETIC folds into
//       `notHermeticExcluded`, never `changedTestFiles` (mirrors card 17cd1f30's treatment of a directly-
//       changed NOT_HERMETIC file).
//   (F) ALWAYS A WILDCARD (round 3) — the round-2 AST classifier that tried to PROVE a non-literal dynamic
//       import() resolves outside test/ is GONE (@decision 72769424 — round-3 review reproduced two more
//       false-SAFE bugs in it: a shadowed local identifier, and a case-sensitive `"test"` segment check).
//       Every repro shape that used to fool it, plus the common corpus shape it was built to prove safe in
//       the first place, now simply folds in like any other wildcard, uniformly, with no classification at
//       all — see docs/decisions/72769424-test-importer-fold-in.md.
//   (G) DELETED-FILE FOLD-IN (fix round) — a diff that DELETES a test file still imported by an unrelated,
//       unchanged test file folds that importer in too (RED before this fix round: a deleted path was never
//       a graph seed).
//   (H) REAL CORPUS — a positive control against THIS repo's own real packages/daemon/test/** (not a
//       synthetic fixture): touching ONLY fixed-wait-witness-guard.mjs does NOT fail closed, and folds in
//       its real selftest importer, with buildReducedGateCommand naming both.
//   (I) EVENT-LOOP NON-BLOCKING (round 4) — the real-corpus scan must run OFF the host event loop, not
//       freeze it synchronously for its whole ~9s wall-clock duration: a setInterval probe ticking every
//       20ms observes the max gap between ticks while computeEmitCompareGate runs against the real
//       corpus; RED against the pre-round-4 code (the scan ran in-process; the gap tracks the whole scan
//       duration), GREEN after (the scan runs in a child process; the host loop stays responsive).
//   (J) SPAWN EDGE — FULL BASENAME LITERAL (round 4) — a corpus file that SPAWNS another test file as a
//       child process (never `import`s it) still folds that spawned file in, via a conservative textual
//       scan for a string literal naming the changed file's full basename (`name.mjs`) anywhere in the
//       spawner's own source — the shape 4 of the 5 real spawner tests this round's review found use.
//   (K) SPAWN EDGE — `--only=<stem>` LITERAL (round 4) — the harness-selector shape 2 of the 5 real
//       spawner tests use instead (`spawn(execPath, [SCRIPT, "--only=<stem>"])`), WITH a negative control
//       proving an unrelated `--only=` value does not fold in.
//   (L) UTF-8 CHUNK-SPLIT DECODE (card db669d74) — a multi-byte character split across two separate
//       stdout "data" events decodes correctly via collectUtf8Stdout, with a negative control proving the
//       pre-fix naive per-chunk decode genuinely corrupts it.
//   (M) WINDOWS ARGV-LENGTH OVERFLOW → STDIN (card db669d74) — a diff touching enough test files that the
//       roots payload alone exceeds the Windows ~32767-char command-line limit still finds them all,
//       because roots now rides the child's stdin, never a JSON argv element. WINDOWS-HOST CONTROL: the
//       ~32767 figure this fixture targets is the Windows COMBINED command-line limit, not a universal
//       argv ceiling — Linux's per-argument MAX_ARG_STRLEN is 128 KiB, well past this fixture's ~42 KB
//       payload (logged below), so on a Linux host this control exercises the stdin path without the
//       pre-fix argv shape ever actually overflowing there.
// Run: 1) build daemon (pnpm build), 2) node test/emit-compare-gate-test-importers.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ecgti-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { GIT_ID, mkdirp, mk, writeRealTestDaemonScript } = await import("./_emit-compare-fixtures.mjs");
const { registerForCleanup, cleanupPathSync } = await import("./_tmp-fixture.mjs");
const { createWorktree, computeEmitCompareGate, buildReducedGateCommand } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// One real, currently-live NOT_HERMETIC name (scripts/test-daemon.mjs) — same specimen
// emit-compare-gate-not-hermetic.mjs uses, for the identical reason: a genuine name, not an invented one.
const NOT_HERMETIC_NAME = "board-consistency";

function initRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  registerForCleanup(p.repo);
  fs.writeFileSync(path.join(p.repo, "README.md"), "# ecgti\n");
  mkdirp(path.join(p.repo, "packages", "daemon", "test"));
  writeRealTestDaemonScript(p.repo);
}

const worktrees = [];
try {
  // ── (A) THE MOTIVATING CASE — guard.mjs changes, guard-selftest.mjs imports 8-functions-style from it ──
  {
    const A = mk("a");
    initRepo(A);
    fs.writeFileSync(path.join(A.repo, "packages", "daemon", "test", "guard.mjs"), "export function thing() { return 1; }\n");
    fs.writeFileSync(path.join(A.repo, "packages", "daemon", "test", "guard-selftest.mjs"), "import { thing } from \"./guard.mjs\";\nconsole.log(thing());\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: A.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: A.repo });
    const baseSha = execSync("git rev-parse HEAD", { cwd: A.repo }).toString().trim();
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "guard.mjs"), "export function thing() { return 2; }\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "fix: change guard.mjs only"`, { cwd: worktreePath });

    const direct = await computeEmitCompareGate(worktreePath, baseSha, branch);
    check("(A) eligible:true", direct.eligible === true);
    check("(A) changedTestFiles includes the directly-changed guard.mjs", direct.changedTestFiles.includes("packages/daemon/test/guard.mjs"));
    check("(A) ⭐ THE FIX: changedTestFiles ALSO includes guard-selftest.mjs (its importer) — RED before card 72769424, GREEN after", direct.changedTestFiles.includes("packages/daemon/test/guard-selftest.mjs"));
    check("(A) exactly two files folded in (no unrelated over-widening)", direct.changedTestFiles.length === 2);
  }

  // ── (B) TRANSITIVE — real-test2.mjs imports _helper2.mjs imports guard2.mjs; only guard2.mjs changes ──
  {
    const B = mk("b");
    initRepo(B);
    fs.writeFileSync(path.join(B.repo, "packages", "daemon", "test", "guard2.mjs"), "export function thing2() { return 1; }\n");
    fs.writeFileSync(path.join(B.repo, "packages", "daemon", "test", "_helper2.mjs"), "import { thing2 } from \"./guard2.mjs\";\nexport function wrap() { return thing2(); }\n");
    fs.writeFileSync(path.join(B.repo, "packages", "daemon", "test", "real-test2.mjs"), "import { wrap } from \"./_helper2.mjs\";\nconsole.log(wrap());\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: B.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: B.repo });
    const baseSha = execSync("git rev-parse HEAD", { cwd: B.repo }).toString().trim();
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "guard2.mjs"), "export function thing2() { return 2; }\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "fix: change guard2.mjs only"`, { cwd: worktreePath });

    const direct = await computeEmitCompareGate(worktreePath, baseSha, branch);
    check("(B) eligible:true", direct.eligible === true);
    check("(B) changedTestFiles includes guard2.mjs", direct.changedTestFiles.includes("packages/daemon/test/guard2.mjs"));
    check("(B) ⭐ TRANSITIVE: changedTestFiles includes real-test2.mjs (found THROUGH the _helper2.mjs pass-through node)", direct.changedTestFiles.includes("packages/daemon/test/real-test2.mjs"));
    check("(B) the helper itself is NEVER a run target (it's not a discoverable test)", !direct.changedTestFiles.includes("packages/daemon/test/_helper2.mjs"));
    check("(B) exactly two files folded in", direct.changedTestFiles.length === 2);
  }

  // ── (C) WILDCARD IMPORTER (fix round) — a non-literal, UNCLASSIFIABLE dynamic import() anywhere in the
  //        corpus folds the OFFENDING FILE in as an extra run target instead of forcing the full gate, with
  //        a NEGATIVE CONTROL (same shape, literal argument) proving it's the non-literal argument
  //        specifically that triggers the fold-in, not the mere presence of a dynamic import() ───────────
  {
    const C = mk("c");
    initRepo(C);
    fs.writeFileSync(path.join(C.repo, "packages", "daemon", "test", "guard3.mjs"), "export function thing3() { return 1; }\n");
    fs.writeFileSync(path.join(C.repo, "packages", "daemon", "test", "weird.mjs"), "const name = \"guard3\";\nawait import(`./${name}.mjs`);\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: C.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: C.repo });
    const baseSha = execSync("git rev-parse HEAD", { cwd: C.repo }).toString().trim();
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "guard3.mjs"), "export function thing3() { return 2; }\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "fix: change guard3.mjs only"`, { cwd: worktreePath });

    const direct = await computeEmitCompareGate(worktreePath, baseSha, branch);
    check("(C) ⭐ WILDCARD: eligible:true — a template-literal dynamic import() no longer forces the full gate", direct.eligible === true);
    check("(C) changedTestFiles includes the directly-changed guard3.mjs", direct.changedTestFiles.includes("packages/daemon/test/guard3.mjs"));
    check("(C) ⭐ weird.mjs (the unclassifiable importer) is folded in as a wildcard hazard, even though it never textually names guard3.mjs", direct.changedTestFiles.includes("packages/daemon/test/weird.mjs"));
    check("(C) exactly two files folded in (no unrelated over-widening)", direct.changedTestFiles.length === 2);

    // NEGATIVE CONTROL — weird-literal.mjs's import() argument is a plain string literal naming a
    // DIFFERENT, UNCHANGED file (other3b.mjs) — neither guard3b.mjs (the file that actually changes) nor
    // anything that imports it. Must NOT be folded in: a plain literal dynamic import to an unrelated file
    // is not a wildcard hazard and doesn't textually reach guard3b.mjs, so there's no edge to find it
    // through either. (Fixed from a prior version of this control that had weird-literal.mjs import the
    // CHANGED file directly, which gets folded in via the ordinary literal-specifier graph edge regardless
    // of any wildcard logic — proving nothing about wildcard-vs-literal discrimination specifically.)
    const C2 = mk("c2");
    initRepo(C2);
    fs.writeFileSync(path.join(C2.repo, "packages", "daemon", "test", "guard3b.mjs"), "export function thing3b() { return 1; }\n");
    fs.writeFileSync(path.join(C2.repo, "packages", "daemon", "test", "other3b.mjs"), "export function other3b() { return 1; }\n");
    fs.writeFileSync(path.join(C2.repo, "packages", "daemon", "test", "weird-literal.mjs"), "await import(\"./other3b.mjs\");\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: C2.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: C2.repo });
    const baseSha2 = execSync("git rev-parse HEAD", { cwd: C2.repo }).toString().trim();
    const { worktreePath: wt2, branch: branch2 } = await createWorktree(C2.repo, C2.projId, C2.taskId);
    worktrees.push(wt2);
    fs.writeFileSync(path.join(wt2, "packages", "daemon", "test", "guard3b.mjs"), "export function thing3b() { return 2; }\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "fix: change guard3b.mjs only"`, { cwd: wt2 });

    const direct2 = await computeEmitCompareGate(wt2, baseSha2, branch2);
    check("(C) NEGATIVE CONTROL: a LITERAL dynamic import() argument does NOT trip the wildcard path — still eligible", direct2.eligible === true);
    check("(C) NEGATIVE CONTROL: ⭐ weird-literal.mjs (a literal dynamic importer of an UNRELATED, unchanged file) is NOT folded in", !direct2.changedTestFiles.includes("packages/daemon/test/weird-literal.mjs"));
    check("(C) NEGATIVE CONTROL: changedTestFiles is EXACTLY [guard3b.mjs] — nothing extra folded in", direct2.changedTestFiles.length === 1 && direct2.changedTestFiles[0] === "packages/daemon/test/guard3b.mjs");
  }

  // ── (D) NO-REGRESSION — a changed test file nobody imports folds in nothing extra ───────────────────
  {
    const D = mk("d");
    initRepo(D);
    fs.writeFileSync(path.join(D.repo, "packages", "daemon", "test", "lonely.mjs"), "console.log(\"v1\");\n");
    fs.writeFileSync(path.join(D.repo, "packages", "daemon", "test", "unrelated.mjs"), "console.log(\"unrelated\");\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: D.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: D.repo });
    const baseSha = execSync("git rev-parse HEAD", { cwd: D.repo }).toString().trim();
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "lonely.mjs"), "console.log(\"v2\");\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "fix: change lonely.mjs only"`, { cwd: worktreePath });

    const direct = await computeEmitCompareGate(worktreePath, baseSha, branch);
    check("(D) eligible:true", direct.eligible === true);
    check("(D) NO-REGRESSION: changedTestFiles is EXACTLY [lonely.mjs] — unrelated.mjs is never pulled in", direct.changedTestFiles.length === 1 && direct.changedTestFiles[0] === "packages/daemon/test/lonely.mjs");
  }

  // ── (E) NOT_HERMETIC IMPORTER — board-consistency.mjs (a real NOT_HERMETIC name) imports the changed
  //        file: it must fold into notHermeticExcluded, never changedTestFiles ──────────────────────────
  {
    const E = mk("e");
    initRepo(E);
    fs.writeFileSync(path.join(E.repo, "packages", "daemon", "test", "guard4.mjs"), "export function thing4() { return 1; }\n");
    fs.writeFileSync(path.join(E.repo, "packages", "daemon", "test", `${NOT_HERMETIC_NAME}.mjs`), "import { thing4 } from \"./guard4.mjs\";\nconsole.log(thing4());\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: E.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: E.repo });
    const baseSha = execSync("git rev-parse HEAD", { cwd: E.repo }).toString().trim();
    const { worktreePath, branch } = await createWorktree(E.repo, E.projId, E.taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "guard4.mjs"), "export function thing4() { return 2; }\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "fix: change guard4.mjs only"`, { cwd: worktreePath });

    const direct = await computeEmitCompareGate(worktreePath, baseSha, branch);
    check("(E) eligible:true", direct.eligible === true);
    check("(E) changedTestFiles includes guard4.mjs", direct.changedTestFiles.includes("packages/daemon/test/guard4.mjs"));
    check(`(E) ⭐ the NOT_HERMETIC importer "${NOT_HERMETIC_NAME}.mjs" folds into notHermeticExcluded`, direct.notHermeticExcluded.includes(`packages/daemon/test/${NOT_HERMETIC_NAME}.mjs`));
    check("(E) the NOT_HERMETIC importer is NEVER in changedTestFiles (test:daemon --only= would refuse it)", !direct.changedTestFiles.includes(`packages/daemon/test/${NOT_HERMETIC_NAME}.mjs`));
  }

  // ── (F) ALWAYS A WILDCARD (round 3) — the round-2 AST classifier that tried to PROVE a non-literal
  //        dynamic import() resolves outside test/ is GONE (@decision 72769424): round-3 review reproduced
  //        two more false-SAFE bugs in it (shadowing, a case-sensitive check) on top of the ones it was
  //        built to fix. Every repro shape that used to fool it now simply folds in like any other
  //        wildcard, with no special-casing needed — including the common shape the classifier was BUILT
  //        to prove safe (F1) ───────────────────────────────────────────────────────────────────────────
  {
    const F = mk("f");
    initRepo(F);
    fs.writeFileSync(path.join(F.repo, "packages", "daemon", "test", "guard5.mjs"), "export function thing5() { return 1; }\n");
    // F1 — the common corpus shape a round-2 classifier used to prove resolves outside test/.
    fs.writeFileSync(path.join(F.repo, "packages", "daemon", "test", "dyn-basic.mjs"), [
      "import { fileURLToPath, pathToFileURL } from \"node:url\";",
      "import path from \"node:path\";",
      "const __dirname = path.dirname(fileURLToPath(import.meta.url));",
      "const target = path.join(__dirname, \"..\", \"dist\", \"fake.js\");",
      "await import(pathToFileURL(target).href);",
      "",
    ].join("\n"));
    // F2 — SHADOW via a function parameter: a module-level `const target` (which alone resolves outside
    // test/) is shadowed by a same-named parameter the dynamic import actually reads — the round-2
    // const-only identifier chase couldn't see this and classified it safe anyway.
    fs.writeFileSync(path.join(F.repo, "packages", "daemon", "test", "dyn-shadow-param.mjs"), [
      "import { fileURLToPath, pathToFileURL } from \"node:url\";",
      "import path from \"node:path\";",
      "const __dirname = path.dirname(fileURLToPath(import.meta.url));",
      "const target = path.join(__dirname, \"..\", \"dist\", \"fake.js\");",
      "async function load(target) { return import(pathToFileURL(target).href); }",
      "await load(target);",
      "",
    ].join("\n"));
    // F3 — SHADOW via a block-scoped `let`: the same identifier name is redeclared in an inner block.
    fs.writeFileSync(path.join(F.repo, "packages", "daemon", "test", "dyn-shadow-let.mjs"), [
      "import { fileURLToPath, pathToFileURL } from \"node:url\";",
      "import path from \"node:path\";",
      "const __dirname = path.dirname(fileURLToPath(import.meta.url));",
      "const target = path.join(__dirname, \"..\", \"dist\", \"fake.js\");",
      "{",
      "  let target = String(Math.random());",
      "  await import(pathToFileURL(target).href);",
      "}",
      "",
    ].join("\n"));
    // F4 — CASE: an uppercase "TEST" path segment — a case-sensitive `!segments.includes("test")` check
    // used to miss this entirely and classify it safe.
    fs.writeFileSync(path.join(F.repo, "packages", "daemon", "test", "dyn-case.mjs"), [
      "import { fileURLToPath, pathToFileURL } from \"node:url\";",
      "import path from \"node:path\";",
      "const __dirname = path.dirname(fileURLToPath(import.meta.url));",
      "const target = path.join(__dirname, \"..\", \"TEST\", \"guard7.mjs\");",
      "await import(pathToFileURL(target).href);",
      "",
    ].join("\n"));
    // F5 — CWD-RELATIVE: no `__dirname` anchor at all — `path.join`'s own segments are relative to
    // whatever the process's cwd happens to be at RUNTIME, not to this file's own location, so even a
    // "resolves outside test/" read off the literal segments alone says nothing about where this actually
    // lands.
    fs.writeFileSync(path.join(F.repo, "packages", "daemon", "test", "dyn-cwd-relative.mjs"), [
      "import { pathToFileURL } from \"node:url\";",
      "import path from \"node:path\";",
      "const target = path.join(\"..\", \"dist\", \"fake.js\");",
      "await import(pathToFileURL(target).href);",
      "",
    ].join("\n"));
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: F.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: F.repo });
    const baseSha = execSync("git rev-parse HEAD", { cwd: F.repo }).toString().trim();
    const { worktreePath, branch } = await createWorktree(F.repo, F.projId, F.taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "guard5.mjs"), "export function thing5() { return 2; }\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "fix: change guard5.mjs only"`, { cwd: worktreePath });

    const direct = await computeEmitCompareGate(worktreePath, baseSha, branch);
    check("(F) eligible:true — none of these shapes forces the full gate", direct.eligible === true);
    check("(F) changedTestFiles includes the directly-changed guard5.mjs", direct.changedTestFiles.includes("packages/daemon/test/guard5.mjs"));
    check("(F) ⭐ dyn-basic.mjs (the shape a round-2 classifier used to prove safe) now folds in", direct.changedTestFiles.includes("packages/daemon/test/dyn-basic.mjs"));
    check("(F) ⭐ dyn-shadow-param.mjs (parameter shadowing a module-level const) folds in", direct.changedTestFiles.includes("packages/daemon/test/dyn-shadow-param.mjs"));
    check("(F) ⭐ dyn-shadow-let.mjs (block-scoped let shadowing) folds in", direct.changedTestFiles.includes("packages/daemon/test/dyn-shadow-let.mjs"));
    check("(F) ⭐ dyn-case.mjs (uppercase TEST segment) folds in", direct.changedTestFiles.includes("packages/daemon/test/dyn-case.mjs"));
    check("(F) ⭐ dyn-cwd-relative.mjs (no __dirname anchor) folds in", direct.changedTestFiles.includes("packages/daemon/test/dyn-cwd-relative.mjs"));
    check("(F) exactly six files folded in (no unrelated over-widening)", direct.changedTestFiles.length === 6);
  }

  // ── (G) DELETED-FILE FOLD-IN (fix round) — deleting guard6.mjs (still imported by real-test6.mjs) folds
  //        real-test6.mjs in too, even though guard6.mjs itself can never be a run target ──────────────────
  {
    const G = mk("g");
    initRepo(G);
    fs.writeFileSync(path.join(G.repo, "packages", "daemon", "test", "guard6.mjs"), "export function thing6() { return 1; }\n");
    fs.writeFileSync(path.join(G.repo, "packages", "daemon", "test", "real-test6.mjs"), "import { thing6 } from \"./guard6.mjs\";\nconsole.log(thing6());\n");
    fs.writeFileSync(path.join(G.repo, "packages", "daemon", "test", "bar6.mjs"), "console.log(\"bar6 v1\");\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: G.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: G.repo });
    const baseSha = execSync("git rev-parse HEAD", { cwd: G.repo }).toString().trim();
    const { worktreePath, branch } = await createWorktree(G.repo, G.projId, G.taskId);
    worktrees.push(worktreePath);
    fs.rmSync(path.join(worktreePath, "packages", "daemon", "test", "guard6.mjs"));
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "bar6.mjs"), "console.log(\"bar6 v2\");\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "fix: delete guard6.mjs, touch unrelated bar6.mjs"`, { cwd: worktreePath });

    const direct = await computeEmitCompareGate(worktreePath, baseSha, branch);
    check("(G) eligible:true — a deletion plus an unrelated modify stays eligible", direct.eligible === true);
    check("(G) changedTestFiles includes bar6.mjs", direct.changedTestFiles.includes("packages/daemon/test/bar6.mjs"));
    check("(G) ⭐ THE FIX: changedTestFiles ALSO includes real-test6.mjs — found by treating the DELETED guard6.mjs as a fold-in graph seed (RED before this fix round)", direct.changedTestFiles.includes("packages/daemon/test/real-test6.mjs"));
    check("(G) the deleted guard6.mjs itself is never a run target (nothing left to run)", !direct.changedTestFiles.includes("packages/daemon/test/guard6.mjs"));
    check("(G) exactly two files folded in", direct.changedTestFiles.length === 2);
  }

  // ── (H) REAL CORPUS — a positive control against THIS repo's OWN real packages/daemon/test/** (not a
  //        synthetic fixture): proves the scan does NOT fail closed on the real corpus (card 72769424's own
  //        "zero such patterns exist" claim was false — 24 real files hit the old unconditional-abort path),
  //        and that the real fixed-wait-witness-guard.mjs/-selftest.mjs importer relationship is found
  //        end-to-end, with buildReducedGateCommand naming both ───────────────────────────────────────────
  {
    const H = mk("h");
    fs.mkdirSync(H.repo, { recursive: true });
    registerForCleanup(H.repo);
    fs.writeFileSync(path.join(H.repo, "README.md"), "# ecgti-real-corpus\n");
    writeRealTestDaemonScript(H.repo);
    // Overlay the REAL, full packages/daemon/test/** tree on top (writeRealTestDaemonScript already wrote
    // scripts/test-daemon.mjs + its transitive deps and test/_tmp-fixture.mjs; this copies everything else,
    // harmlessly re-writing the handful of files writeRealTestDaemonScript already placed with identical
    // content) — the REAL corpus this card's own Code Review measured at 1324 files, not a hand-picked
    // subset, so this scenario can't accidentally miss one of the 24 non-literal-dynamic-import specimens.
    const REAL_TEST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)));
    fs.cpSync(REAL_TEST_DIR, path.join(H.repo, "packages", "daemon", "test"), { recursive: true });
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: H.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: H.repo });
    const baseSha = execSync("git rev-parse HEAD", { cwd: H.repo }).toString().trim();
    const { worktreePath, branch } = await createWorktree(H.repo, H.projId, H.taskId);
    worktrees.push(worktreePath);
    const guardPath = path.join(worktreePath, "packages", "daemon", "test", "fixed-wait-witness-guard.mjs");
    fs.appendFileSync(guardPath, "\n// (H) real-corpus probe touch — behaviorally inert.\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "fix: touch fixed-wait-witness-guard.mjs only"`, { cwd: worktreePath });

    const t0 = Date.now();
    const direct = await computeEmitCompareGate(worktreePath, baseSha, branch);
    const elapsedMs = Date.now() - t0;
    console.log(`(H) real-corpus computeEmitCompareGate elapsed: ${elapsedMs}ms (instrument: Date.now() wall clock around the call, real packages/daemon/test/** corpus, this file's own count at write time: 1324 .mjs files)`);
    check("(H) ⭐ REAL CORPUS: eligible:true — the scan does NOT fail closed on this repo's actual corpus", direct.eligible === true);
    check("(H) changedTestFiles includes the directly-changed fixed-wait-witness-guard.mjs", direct.changedTestFiles.includes("packages/daemon/test/fixed-wait-witness-guard.mjs"));
    check("(H) ⭐ changedTestFiles ALSO includes the REAL fixed-wait-witness-guard-selftest.mjs (its real importer)", direct.changedTestFiles.includes("packages/daemon/test/fixed-wait-witness-guard-selftest.mjs"));
    const cmd = buildReducedGateCommand(direct);
    const onlyMatch = /--only=(\S+)/.exec(cmd);
    const onlyNames = onlyMatch ? onlyMatch[1].split(",") : [];
    check("(H) buildReducedGateCommand's --only= list names BOTH real files", onlyNames.includes("fixed-wait-witness-guard") && onlyNames.includes("fixed-wait-witness-guard-selftest"));
    // MEASUREMENT (round 3, card 72769424): since EVERY non-literal dynamic import() is now an
    // unconditional wildcard (no classifier left to narrow it to the 2 of 24 real specimens round 2
    // measured), log the FULL --only= population so a human can judge whether the reduction is still
    // worth it on this repo's real corpus, not just that the two named files are present.
    console.log(`(H) real-corpus reduced --only= population: ${onlyNames.length} file(s) of 1324 .mjs files in the corpus at write time`);
    console.log(`(H) real-corpus reduced --only= names: ${onlyNames.join(", ")}`);
  }

  // ── (I) EVENT-LOOP NON-BLOCKING (round 4) — the real-corpus scan must run OFF the host event loop: a
  //        setInterval probe ticking every 20ms observes the max gap between ticks while
  //        computeEmitCompareGate runs against the real corpus. RED before round 4 (the whole list+read+
  //        parse scan ran synchronously in-process, freezing every project's HTTP/WS/MCP/PTY traffic for
  //        its ~9s duration — the probe's own ticks stall right along with it); GREEN after (the scan runs
  //        in a child process, so the host loop keeps ticking the probe on schedule) ───────────────────────
  {
    const I = mk("i");
    fs.mkdirSync(I.repo, { recursive: true });
    registerForCleanup(I.repo);
    fs.writeFileSync(path.join(I.repo, "README.md"), "# ecgti-event-loop\n");
    writeRealTestDaemonScript(I.repo);
    const REAL_TEST_DIR_I = path.join(path.dirname(fileURLToPath(import.meta.url)));
    fs.cpSync(REAL_TEST_DIR_I, path.join(I.repo, "packages", "daemon", "test"), { recursive: true });
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: I.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: I.repo });
    const baseShaI = execSync("git rev-parse HEAD", { cwd: I.repo }).toString().trim();
    const { worktreePath: wtI, branch: branchI } = await createWorktree(I.repo, I.projId, I.taskId);
    worktrees.push(wtI);
    const guardPathI = path.join(wtI, "packages", "daemon", "test", "fixed-wait-witness-guard.mjs");
    fs.appendFileSync(guardPathI, "\n// (I) event-loop probe touch — behaviorally inert.\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "fix: touch fixed-wait-witness-guard.mjs only"`, { cwd: wtI });

    const PROBE_PERIOD_MS = 20;
    let maxGapMs = 0;
    let lastTick = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      const gap = now - lastTick;
      if (gap > maxGapMs) maxGapMs = gap;
      lastTick = now;
    }, PROBE_PERIOD_MS);

    const t0I = performance.now();
    const directI = await computeEmitCompareGate(wtI, baseShaI, branchI);
    const elapsedMsI = performance.now() - t0I;
    clearInterval(probe);

    console.log(`(I) real-corpus computeEmitCompareGate elapsed: ${elapsedMsI.toFixed(0)}ms, max event-loop gap observed during the call: ${maxGapMs.toFixed(0)}ms (setInterval probe, period ${PROBE_PERIOD_MS}ms)`);
    check("(I) eligible:true", directI.eligible === true);
    check("(I) ⭐ EVENT-LOOP: max observed gap stays bounded (< 500ms) — the real-corpus scan must run OFF the host event loop, never block it synchronously for its whole multi-second duration", maxGapMs < 500);
  }

  // ── (J) SPAWN EDGE — FULL BASENAME LITERAL (round 4, card 72769424) — spawnerJ.mjs never `import`s
  //        guardJ.mjs; it only names it inside an object literal's string VALUE (the exact shape
  //        `real-homedir-transcript-leak-isolation.mjs` uses for its own real spawn targets). A diff
  //        touching only guardJ.mjs must still fold spawnerJ.mjs in — RED before round 4 (the import-graph
  //        scan has no edge for a bare string literal outside an import/export/dynamic-import node), GREEN
  //        after (findSpawnTargetEdges scans every string literal in the file) ───────────────────────────
  {
    const J = mk("j");
    initRepo(J);
    fs.writeFileSync(path.join(J.repo, "packages", "daemon", "test", "guardJ.mjs"), "export function thingJ() { return 1; }\n");
    fs.writeFileSync(path.join(J.repo, "packages", "daemon", "test", "spawnerJ.mjs"), [
      "import { spawn } from \"node:child_process\";",
      "const TARGETS = [{ file: \"guardJ.mjs\" }];",
      "export function run() { return spawn(process.execPath, [TARGETS[0].file]); }",
      "",
    ].join("\n"));
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: J.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: J.repo });
    const baseShaJ = execSync("git rev-parse HEAD", { cwd: J.repo }).toString().trim();
    const { worktreePath: wtJ, branch: branchJ } = await createWorktree(J.repo, J.projId, J.taskId);
    worktrees.push(wtJ);
    fs.writeFileSync(path.join(wtJ, "packages", "daemon", "test", "guardJ.mjs"), "export function thingJ() { return 2; }\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "fix: change guardJ.mjs only"`, { cwd: wtJ });

    const directJ = await computeEmitCompareGate(wtJ, baseShaJ, branchJ);
    check("(J) eligible:true", directJ.eligible === true);
    check("(J) changedTestFiles includes the directly-changed guardJ.mjs", directJ.changedTestFiles.includes("packages/daemon/test/guardJ.mjs"));
    check("(J) ⭐ SPAWN EDGE: changedTestFiles ALSO includes spawnerJ.mjs, which never `import`s guardJ.mjs — only names it in a string literal", directJ.changedTestFiles.includes("packages/daemon/test/spawnerJ.mjs"));
    check("(J) exactly two files folded in (no unrelated over-widening)", directJ.changedTestFiles.length === 2);
  }

  // ── (K) SPAWN EDGE — `--only=<stem>` LITERAL (round 4, card 72769424) — spawnerK.mjs never `import`s
  //        guardK.mjs; it only passes `--only=guardK` (the bare stem, no `.mjs`) as a harness-selector CLI
  //        arg (the exact shape `test-daemon-failures-epilogue-flush.mjs` uses for its own real spawn
  //        target), WITH a negative control: spawnerK2.mjs's `--only=` value names a DIFFERENT, unrelated
  //        stem and must NOT fold in ─────────────────────────────────────────────────────────────────────
  {
    const K = mk("k");
    initRepo(K);
    fs.writeFileSync(path.join(K.repo, "packages", "daemon", "test", "guardK.mjs"), "export function thingK() { return 1; }\n");
    fs.writeFileSync(path.join(K.repo, "packages", "daemon", "test", "spawnerK.mjs"), [
      "import { spawn } from \"node:child_process\";",
      "const ARGS = [\"--only=guardK\"];",
      "export function run() { return spawn(process.execPath, ARGS); }",
      "",
    ].join("\n"));
    // Negative control: a DIFFERENT, unrelated stem in the same --only= shape must never fold in.
    fs.writeFileSync(path.join(K.repo, "packages", "daemon", "test", "otherK.mjs"), "export function otherK() { return 1; }\n");
    fs.writeFileSync(path.join(K.repo, "packages", "daemon", "test", "spawnerK2.mjs"), [
      "import { spawn } from \"node:child_process\";",
      "const ARGS = [\"--only=otherK\"];",
      "export function run() { return spawn(process.execPath, ARGS); }",
      "",
    ].join("\n"));
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: K.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: K.repo });
    const baseShaK = execSync("git rev-parse HEAD", { cwd: K.repo }).toString().trim();
    const { worktreePath: wtK, branch: branchK } = await createWorktree(K.repo, K.projId, K.taskId);
    worktrees.push(wtK);
    fs.writeFileSync(path.join(wtK, "packages", "daemon", "test", "guardK.mjs"), "export function thingK() { return 2; }\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "fix: change guardK.mjs only"`, { cwd: wtK });

    const directK = await computeEmitCompareGate(wtK, baseShaK, branchK);
    check("(K) eligible:true", directK.eligible === true);
    check("(K) changedTestFiles includes the directly-changed guardK.mjs", directK.changedTestFiles.includes("packages/daemon/test/guardK.mjs"));
    check("(K) ⭐ SPAWN EDGE: changedTestFiles ALSO includes spawnerK.mjs, found via its `--only=guardK` CLI-arg literal (never a real `import`)", directK.changedTestFiles.includes("packages/daemon/test/spawnerK.mjs"));
    check("(K) NEGATIVE CONTROL: spawnerK2.mjs's unrelated `--only=otherK` does NOT fold in", !directK.changedTestFiles.includes("packages/daemon/test/spawnerK2.mjs"));
    check("(K) exactly two files folded in (no unrelated over-widening)", directK.changedTestFiles.length === 2);
  }

  // ── (L) UTF-8 CHUNK-SPLIT DECODE (card db669d74, a 72769424 delta-review finding) — collectUtf8Stdout
  //        must not corrupt a multi-byte character whose bytes straddle two separate stdout "data" events.
  //        A deterministic fixture (Readable.from an async generator, with an await between chunks forcing
  //        two separate pushes rather than one coalesced read) splits a 4-byte UTF-8 character (🎉,
  //        U+1F389) exactly between byte 2 and byte 3. NEGATIVE CONTROL runs FIRST, proving the fixture
  //        genuinely reproduces the hazard: the naive per-chunk `Buffer#toString()` decode this file's two
  //        child-stdout collectors used BEFORE card db669d74 corrupts the character into replacement
  //        characters when fed the identical split ─────────────────────────────────────────────────────
  {
    const { collectUtf8Stdout } = await import("../dist/git/worktrees.js");
    const { Readable } = await import("node:stream");
    const fullChar = Buffer.from("🎉", "utf8"); // 4 bytes: F0 9F 8E 89 — split 2/2 below.
    const makeSplitStream = () => Readable.from((async function* () {
      yield fullChar.subarray(0, 2);
      await new Promise((r) => setImmediate(r)); // forces a SEPARATE "data" event for the second half
      yield fullChar.subarray(2);
    })(), { objectMode: false });

    // NEGATIVE CONTROL: the pre-card-db669d74 shape (`out += d`, decoding each Buffer chunk independently,
    // with no `setEncoding` applied).
    let naive = "";
    await new Promise((resolve) => {
      const s = makeSplitStream();
      s.on("data", (d) => { naive += d; });
      s.on("end", resolve);
    });
    check("(L) NEGATIVE CONTROL: the naive per-chunk decode DOES corrupt the split character (proves this fixture reproduces the real hazard)", naive !== "🎉" && naive.includes("�"));

    // THE FIX: collectUtf8Stdout, exported from worktrees.ts, shared by both child-stdout collectors.
    const s2 = makeSplitStream();
    const acc = collectUtf8Stdout(s2, 1_000_000);
    await new Promise((resolve) => s2.on("end", resolve));
    check("(L) ⭐ THE FIX: collectUtf8Stdout decodes the split character correctly — no replacement character", acc.value === "🎉");
  }

  // ── (M) WINDOWS ARGV-LENGTH OVERFLOW → STDIN (card db669d74, a 72769424 delta-review finding) — a diff
  //        touching enough test files that `JSON.stringify(roots)` alone would exceed the Windows
  //        ~32767-char combined command-line limit must still find them via the real scan, never silently
  //        fail closed. REAL repro: N trivial test files, ALL changed in one commit, so
  //        `roots.length === N` and the pre-fix argv-JSON payload comfortably overflows the limit on its
  //        own (measured below, not assumed). WINDOWS-HOST CONTROL, NOT A UNIVERSAL ARGV CEILING: this
  //        fixture's ~42 KB payload sits well under Linux's per-argument MAX_ARG_STRLEN (128 KiB) — on a
  //        Linux host (e.g. CI's `ubuntu-latest`) the pre-fix argv shape would NOT actually have overflowed
  //        here, so this scenario proves the stdin path works, not that it was load-bearing there too
  //        ──────────────────────────────────────────────────────────────
  {
    const M = mk("m");
    initRepo(M);
    const N = 1200;
    for (let i = 0; i < N; i++) {
      fs.writeFileSync(path.join(M.repo, "packages", "daemon", "test", `bigm${i}.mjs`), `console.log(${i});\n`);
    }
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: M.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: M.repo });
    const baseShaM = execSync("git rev-parse HEAD", { cwd: M.repo }).toString().trim();
    const { worktreePath: wtM, branch: branchM } = await createWorktree(M.repo, M.projId, M.taskId);
    worktrees.push(wtM);
    for (let i = 0; i < N; i++) {
      fs.appendFileSync(path.join(wtM, "packages", "daemon", "test", `bigm${i}.mjs`), "// touched\n");
    }
    execSync(`git add -A && git ${GIT_ID} commit -q -m "fix: touch ${N} test files"`, { cwd: wtM });

    const wouldBeArgvLen = JSON.stringify(Array.from({ length: N }, (_, i) => `packages/daemon/test/bigm${i}.mjs`)).length;
    console.log(`(M) roots JSON length if passed via argv: ${wouldBeArgvLen} chars (Windows combined command-line limit is ~32767)`);
    check("(M) the fixture's own roots payload genuinely exceeds the Windows argv limit (a real repro, not a vacuous one)", wouldBeArgvLen > 32767);

    const t0M = Date.now();
    const directM = await computeEmitCompareGate(wtM, baseShaM, branchM);
    console.log(`(M) computeEmitCompareGate elapsed: ${Date.now() - t0M}ms over ${N} trivial fixture files`);
    check("(M) ⭐ THE FIX: eligible:true even though roots.length is far past the pre-fix argv ceiling — the scan ran via stdin, not argv", directM.eligible === true);
    check(`(M) changedTestFiles includes all ${N} touched files`, directM.changedTestFiles.length === N);
  }
} finally {
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 72769424 (+ rounds 3-4): a changed test file's TRANSITIVE importers (found via a real static-import-graph scan of the whole packages/daemon/test/** corpus) fold into the reduced gate's run set — directly (A), through an underscore-helper pass-through node (B) — and a NON-LITERAL dynamic import() folds its own file in as a wildcard hazard instead of forcing the full gate (C, with a negative control proving a literal import to an unrelated file does NOT fold in), while an unrelated changed file still folds in nothing extra (D), a NOT_HERMETIC importer still folds into notHermeticExcluded (E), every non-literal dynamic import is now an UNCONDITIONAL wildcard with no classifier left to fool — including the shapes (shadowing, case, cwd-relative) that fooled the round-2 classifier (F) — a DELETED test file's importer is still found (G), the scan does not fail closed on this repo's own REAL 1324-file corpus (H), the real-corpus scan runs OFF the host event loop instead of freezing it (I, round 4), and a file that SPAWNS another test file as a child process (never `import`s it) is still found — via a full basename literal (J, round 4) or a `--only=<stem>` CLI-arg literal with a negative control (K, round 4)."
  + " A multi-byte character split across two stdout chunks decodes correctly (L, card db669d74), and a diff whose roots payload alone would overflow the Windows argv limit still finds every importer because roots now rides stdin, never argv (M, card db669d74)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
