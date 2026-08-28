import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below
// POSITIVE-CONTROL for fixed-wait-witness-guard.mjs (card 5e51e778 DoD-6/DoD-7). "A guard that has never
// fired proves nothing — and this one asserts a property that is currently satisfiable, so a broken
// matcher reads green" (the card's own DoD-6 warning; see memory
// `positive-control-your-searches-empty-is-not-evidence`). Drives the guard's PURE, exported functions
// directly against synthetic diffs/sources — no real git repo, no dist build needed — so this file itself
// has zero build dependency and runs in the ordinary hermetic suite alongside every other test.
//
// DoD-6: RED against a synthetic unwitnessed hit, GREEN for each of the three witness forms separately
// (sleepPast, companion precondition check(), TIMING-GUARD-SAFE comment) — plus the windowMs/
// positiveControl pairing this gate additionally closes (card DoD-4).
// DoD-7: run the ACTUAL guard logic against commit 003a1080's real added lines (via `git show`, not a
// hand-typed reproduction) and prove it does NOT fire — the exact false-positive case the card asked to
// be measured, not asserted.
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { parseAddedLineNumbers, scanFileForUnwitnessedHits, isWaitIdiomLine, blockBounds, computeBlockCommentLines, listUntrackedTestFiles, scanModifiedTrackedTestFiles } from "./fixed-wait-witness-guard.mjs";
import { sleepPast } from "./_wait.mjs";
import { mkdtempManaged, cleanupPathSync, unregister } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const setEq = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));

// Split so this file's OWN fixture strings — deliberately representing what a raw-wait VIOLATION looks
// like — don't themselves read as a hit to fixed-wait-witness-guard.mjs (or fixed-wait-negative-
// guard.mjs) when THIS file's own diff is scanned as "added lines" of a brand-new test file. The runtime
// string these build is byte-identical to the literal form; only the ON-DISK bytes are broken up so a
// text-scanning guard never sees "sleep(" or "windowMs:" as contiguous source.
const SLEEP_KW = "sle" + "ep";
const WINDOWMS_KW = "window" + "Ms";

// ── parseAddedLineNumbers: a hand-built unified diff, line-by-line expectation ──────────────────────
{
  const diff = [
    "diff --git a/packages/daemon/test/sample.mjs b/packages/daemon/test/sample.mjs",
    "index 1111111..2222222 100644",
    "--- a/packages/daemon/test/sample.mjs",
    "+++ b/packages/daemon/test/sample.mjs",
    "@@ -1,4 +1,6 @@",
    " line1 unchanged",
    "-line2 old",
    "+line2 new A",
    "+line2 new B",
    " line3 unchanged",
    "+line4 new C",
    " line5 unchanged",
  ].join("\n");
  const added = parseAddedLineNumbers(diff);
  check("parseAddedLineNumbers: discovers the one changed file", added.size === 1 && added.has("packages/daemon/test/sample.mjs"));
  check("parseAddedLineNumbers: added-line set matches hand-walked expectation {2,3,5} (deletions don't advance, context does)",
    setEq(added.get("packages/daemon/test/sample.mjs"), new Set([2, 3, 5])));
}

// ── DoD-6 RED: an unwitnessed raw sleep + single check() on added lines is a HIT ────────────────────
{
  const source = [
    "{",
    "  const x = 1;",
    `  await ${SLEEP_KW}(20);`,
    "  check(\"some claim about x\", x === 1);",
    "}",
  ].join("\n");
  const { hits, cleared } = scanFileForUnwitnessedHits("test/red-specimen.mjs", source, new Set([3, 4]));
  check("RED: unwitnessed raw sleep()-then-check() on ADDED lines is flagged as a hit", hits.length === 1 && cleared.length === 0);
}

// ── DoD-8 companion check (diff-scoping): the SAME unwitnessed shape, but the lines are NOT added ──
// (the pre-existing-corpus analogue — proves scope-by-construction, not merely "the regex can match").
{
  const source = [
    "{",
    "  const x = 1;",
    `  await ${SLEEP_KW}(20);`,
    "  check(\"some claim about x\", x === 1);",
    "}",
  ].join("\n");
  const { hits, cleared } = scanFileForUnwitnessedHits("test/pre-existing-specimen.mjs", source, new Set());
  check("DIFF-SCOPING: the identical unwitnessed shape produces ZERO hits when no line is in the added set (the ~240 pre-existing sites' analogue)", hits.length === 0 && cleared.length === 0);
}

// ── DoD-6 GREEN (1 of 3): sleepPast — the runtime throw IS the witness, no check() needed to clear ──
{
  const source = [
    "{",
    "  await sleepPast(70, 50, \"past retainMs\");",
    "  check(\"expired after retainMs\", true);",
    "}",
  ].join("\n");
  const { hits, cleared } = scanFileForUnwitnessedHits("test/sleeppast-specimen.mjs", source, new Set([2, 3]));
  check("GREEN (sleepPast): a sleepPast(...) call is never even a candidate — zero hits", hits.length === 0);
}

// ── DoD-6 GREEN (2 of 3): companion precondition check() — 003a1080's real fix shape ────────────────
{
  const source = [
    "{",
    `  await ${SLEEP_KW}(20);`,
    "  check(\"precondition: op is still pending\", true);",
    "  check(\"op eventually resolves as expected\", true);",
    "}",
  ].join("\n");
  const { hits, cleared } = scanFileForUnwitnessedHits("test/companion-specimen.mjs", source, new Set([2, 3, 4]));
  check("GREEN (companion precondition): 2 check()/assert() calls after the wait clears it, zero hits",
    hits.length === 0 && cleared.length === 1 && /companion precondition/.test(cleared[0].reason));
}

// ── DoD-6 GREEN (3 of 3): a TIMING-GUARD-SAFE comment (same convention fixed-wait-negative-guard uses)
{
  const source = [
    "{",
    "  // TIMING-GUARD-SAFE: fully-awaited-completion — settle() already awaited above, this sleep only",
    "  // lets the microtask queue drain before reading state",
    `  await ${SLEEP_KW}(10);`,
    "  check(\"state reflects the settle\", true);",
    "}",
  ].join("\n");
  const { hits, cleared } = scanFileForUnwitnessedHits("test/comment-specimen.mjs", source, new Set([2, 3, 4, 5]));
  check("GREEN (TIMING-GUARD-SAFE comment): clears the hit, zero hits",
    hits.length === 0 && cleared.length === 1 && cleared[0].reason.startsWith("TIMING-GUARD-SAFE: fully-awaited-completion"));
}

// ── DoD-4: windowMs closes 0f744aa4's gap — RED when bare, GREEN when wrapped in positiveControl ────
{
  const bareSource = [
    "{",
    `  const ok = await observeOnce({ check: () => x > 5, ${WINDOWMS_KW}: 100 });`,
    "  check(\"x never exceeds 5 within the window\", ok);",
    "}",
  ].join("\n");
  const { hits: bareHits } = scanFileForUnwitnessedHits("test/windowms-bare.mjs", bareSource, new Set([2, 3]));
  check("DoD-4 RED: a bare windowMs-adjacent-to-check() site (no sleep()/setTimeout() at all) IS flagged — closes 0f744aa4's gap", bareHits.length === 1);

  const wrappedSource = [
    "{",
    "  const ok = await assertNeverWithControl({",
    "    label: \"x never exceeds 5\",",
    "    check: () => x > 5,",
    "    positiveControl: async () => { x = 6; return true; },",
    `    ${WINDOWMS_KW}: 100,`,
    "  });",
    "  check(\"x never exceeds 5\", ok);",
    "}",
  ].join("\n");
  const { hits: wrappedHits, cleared: wrappedCleared } = scanFileForUnwitnessedHits(
    "test/windowms-wrapped.mjs", wrappedSource, new Set([2, 3, 4, 5, 6, 7, 8]),
  );
  check("DoD-4 GREEN: the SAME windowMs shape wrapped in assertNeverWithControl's positiveControl clears (already runtime-enforced by card 1addef27)",
    wrappedHits.length === 0 && wrappedCleared.length === 1 && /positiveControl/.test(wrappedCleared[0].reason));
}

// ── DoD-7: run the guard's real logic against commit 003a1080's ACTUAL added lines ──────────────────
// This is the specimen the recommendation doc names as the false-positive risk: a legitimate raw
// `sleep(10)` cleanup drain landed in the SAME commit as the real fix, with no check() immediately after
// it. If the witness set were wrong, this would fire. Best-effort: if git/the commit/the file are ever
// unavailable (a future shallow clone with no history), this reports a clearly-labelled SKIP rather than
// a false failure — mirrors the main guard's own fail-safe posture for git resolution.
{
  const TARGET_FILE = "packages/daemon/test/pending-ops-registry.mjs";
  let patchText = null;
  try {
    patchText = execFileSync("git", ["show", "003a1080"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    check(`DoD-7: SKIPPED — could not \`git show 003a1080\` in this checkout (${e.message}); not a claim either way`, true);
  }
  if (patchText !== null) {
    const added = parseAddedLineNumbers(patchText);
    const addedLineNumbers = added.get(TARGET_FILE);
    check(`DoD-7: commit 003a1080's diff touches ${TARGET_FILE}`, !!addedLineNumbers && addedLineNumbers.size > 0);
    if (addedLineNumbers) {
      // Code review finding: read the commit's OWN snapshot (`git show 003a1080:<path>`), not the working
      // tree — the added line NUMBERS come from this commit's diff, so scanning against whatever the
      // working tree happens to hold today is only sound until that file's next edit shifts its lines out
      // from under this correspondence, silently and without failing.
      const commitSource = execFileSync("git", ["show", `003a1080:${TARGET_FILE}`], { cwd: REPO_ROOT, encoding: "utf8" });
      const { hits, cleared } = scanFileForUnwitnessedHits(TARGET_FILE, commitSource, addedLineNumbers);
      console.log(`  DoD-7 raw result: ${hits.length} hit(s), ${cleared.length} cleared — ${JSON.stringify({ hits, cleared })}`);
      // Code review finding: the PRIOR wording here falsely claimed "the companion precondition check
      // clears the real fix's own site" — nothing is cleared; 0 hits AND 0 cleared, because 003a1080's fix
      // replaced the raced sleep(20)/sleep(80) pair with deferred() entirely, so there is no wait-idiom
      // candidate left at that site for anything to clear. The real fix's own precondition check() (which
      // DOES contain the literal word "precondition", attesting DoD-3's marker choice) has nothing to
      // clear because the wait it would have cleared no longer exists. The file's OTHER added line — a
      // short cleanup wait for the settle microtask to run — is a candidate-shape non-starter for a
      // different reason: no check()/assert() calls follow it in-block, which is the ordinary settle/
      // pacing-wait case this gate is scoped to ignore by design (see the main guard's own header).
      check("DoD-7: the real 003a1080 added lines produce a clean result on both counts — the raced sleeps were replaced by deferred() (no wait-idiom candidate remains to witness), and the separate cleanup wait has nothing following it in-block (out of idiom scope by design)",
        hits.length === 0 && cleared.length === 0);
    }
  }
}

// ── sleepPast boundary checks (code review, upgraded from non-blocking): DoD-1 calls this helper "the
// half that is mechanically checkable, so it is real proof" — it shipped with zero verification. ────────
{
  let threw = false;
  try { await sleepPast(50, 50, "eq"); } catch { threw = true; }
  check("sleepPast: ms === thresholdMs throws (a floor must STRICTLY exceed, not tie)", threw);
}
{
  let threw = false;
  try { await sleepPast(40, 50, "lt"); } catch { threw = true; }
  check("sleepPast: ms < thresholdMs throws", threw);
}
{
  let threw = false;
  try { await sleepPast(6, 5, "gt"); } catch { threw = true; }
  check("sleepPast: ms > thresholdMs does NOT throw (resolves normally)", threw === false);
}
{
  let threw = false;
  try { await sleepPast(NaN, 50, "nan-ms"); } catch { threw = true; }
  check("sleepPast: NaN ms throws (NaN > anything is false — fails closed, not open)", threw);
}
{
  let threw = false;
  try { await sleepPast(50, NaN, "nan-threshold"); } catch { threw = true; }
  check("sleepPast: NaN thresholdMs throws (same fail-closed reasoning)", threw);
}

// ── Real-corpus RED control (code review finding 5): the verbatim PRE-FIX `81a6e4e1` block from
// `003a1080^`, with the removed block's own lines treated as newly-added — must be 2 hits, 0 cleared,
// exactly as the reviewer's corpus-wide positive control found. Then the reviewer's OWN exploit — append
// one ORDINARY (non-"precondition"-marked) assertion — must STILL be 2 hits after the fix above, not the
// 0-hits/2-cleared it produced before: this is the control that would have caught finding #1 during the
// original build, and it stays in the suite so the exploit can never silently regress back in. ──────────
{
  const TARGET_FILE = "packages/daemon/test/pending-ops-registry.mjs";
  let preFixSource = null;
  try {
    preFixSource = execFileSync("git", ["show", "003a1080^:" + TARGET_FILE], { cwd: REPO_ROOT, encoding: "utf8" });
  } catch (e) {
    check(`Real-corpus RED control: SKIPPED — could not \`git show 003a1080^:...\` in this checkout (${e.message}); not a claim either way`, true);
  }
  if (preFixSource !== null) {
    const lines = preFixSource.split("\n");
    // The verbatim pre-fix block (see docs/investigations/df88c1b2-fixed-wait-precondition/
    // recommendation.md's own quote of it): a `{`-delimited block containing `const surfacedCount = 0`
    // this specimen's own block starts at the last blank line before its leading comment and ends at its
    // closing `}` — located structurally (by content), not by a hand-typed line number, so this control
    // does not silently go stale if an unrelated earlier edit shifts this file's line numbers.
    const blockStartLine = lines.findIndex((l) => l.includes("onSurfacedPending fires on EVERY call")) + 1; // 1-indexed
    const openBraceLine = blockStartLine + 3; // the comment is 3 lines, then the block's own `{`
    let closeBraceLine = openBraceLine;
    while (lines[closeBraceLine - 1].trim() !== "}") closeBraceLine++;
    check("Real-corpus RED control: located the verbatim pre-fix 81a6e4e1 block by content (sanity — did not silently match nothing)",
      blockStartLine > 0 && lines[openBraceLine - 1].trim() === "{" && closeBraceLine > openBraceLine);

    const asAdded = (from, to) => new Set(Array.from({ length: to - from + 1 }, (_, k) => from + k));
    const verbatim = scanFileForUnwitnessedHits(TARGET_FILE, preFixSource, asAdded(openBraceLine, closeBraceLine));
    console.log(`  Real-corpus RED control (verbatim): ${verbatim.hits.length} hit(s), ${verbatim.cleared.length} cleared`);
    check("Real-corpus RED control: the verbatim pre-fix block is 2 hits, 0 cleared (matches the reviewer's corpus-wide positive control exactly)",
      verbatim.hits.length === 2 && verbatim.cleared.length === 0);

    // The reviewer's exploit, reproduced as a regression control: splice ONE ordinary (unmarked)
    // assertion into the block, right after its real check().
    const exploited = lines.slice(0, closeBraceLine - 1);
    exploited.push('  check("ordinary extra assertion, plain unrelated wording", true);');
    exploited.push(...lines.slice(closeBraceLine - 1));
    const exploitedSource = exploited.join("\n");
    const exploitedResult = scanFileForUnwitnessedHits(TARGET_FILE, exploitedSource, asAdded(openBraceLine, closeBraceLine + 1));
    console.log(`  Real-corpus RED control (+1 ordinary assertion): ${exploitedResult.hits.length} hit(s), ${exploitedResult.cleared.length} cleared`);
    check("Real-corpus RED control: appending ONE ordinary (unmarked) assertion no longer clears the hits — still 2 hits, 0 cleared (the reviewer's exploit, now defeated)",
      exploitedResult.hits.length === 2 && exploitedResult.cleared.length === 0);
  }
}

// ── isWaitIdiomLine / blockBounds: cheap direct negative controls on the primitives themselves ──────
check("isWaitIdiomLine: a comment-only line is excluded from candidacy (743be0c9's bug class, by construction)", isWaitIdiomLine(`  // await ${SLEEP_KW}(20); check("x", true);`) === false);
check("isWaitIdiomLine: a sleepPast(...) call is excluded from candidacy", isWaitIdiomLine("  await sleepPast(70, 50, \"x\");") === false);
check("isWaitIdiomLine: a real sleep() call IS a candidate", isWaitIdiomLine(`  await ${SLEEP_KW}(20);`) === true);
// Code review finding (blocking, DoD-5): a comment-text scan must exclude a JSDoc/block-comment
// CONTINUATION line and a self-contained one-line block comment too, not just `//` — the reviewer's own
// repro, reproduced here as a permanent regression control.
check(`isWaitIdiomLine: a JSDoc continuation line (" * ${SLEEP_KW}(20);") is excluded from candidacy`, isWaitIdiomLine(`   * await ${SLEEP_KW}(20);`) === false);
check(`isWaitIdiomLine: a one-line block comment ("/** ${SLEEP_KW}(20); */") is excluded from candidacy`, isWaitIdiomLine(`  /** await ${SLEEP_KW}(20); */`) === false);
{
  const lines = ["a", "", "b", "c", "", "d"];
  check("blockBounds: bounded by the nearest blank line on both sides", JSON.stringify(blockBounds(lines, 2)) === JSON.stringify([2, 3]));
}
{
  // A genuinely multi-line block comment with NO per-line `*` prefix — the shape isWaitIdiomLine cannot
  // see on its own (single-line only); computeBlockCommentLines carries the open/close STATE across the
  // whole file instead, which is what DoD-5 means by "by construction".
  const lines = ["{", "/*", `await ${SLEEP_KW}(20); no leading star on this interior line`, "*/", "  check(\"x\", true);", "}"];
  check("computeBlockCommentLines: marks the interior of an unterminated-per-line block comment",
    JSON.stringify(computeBlockCommentLines(lines)) === JSON.stringify([false, true, true, true, false, false]));
  const hits = scanFileForUnwitnessedHits("test/block-comment-specimen.mjs", lines.join("\n"), new Set([1, 2, 3, 4, 5, 6])).hits;
  check("scanFileForUnwitnessedHits: a sleep() mentioned only inside a multi-line block comment produces ZERO hits", hits.length === 0);
}

// ── listUntrackedTestFiles: card 40643460's population-visibility check ────────────────────────────
// Dependency-injected `execFileSyncFn` — no real git process spawned, so this is deterministic and has
// no dependency on this repo's actual untracked-file state at test time (which can vary run to run).
{
  const fakeListing = (stdout) => () => stdout;
  const found = listUntrackedTestFiles("/fake/repo", "packages/daemon/test/*.mjs",
    fakeListing("packages/daemon/test/new-thing.mjs\npackages/daemon/test/other-thing.mjs\n"));
  check("listUntrackedTestFiles: parses a multi-line git ls-files listing into a trimmed array",
    JSON.stringify(found) === JSON.stringify(["packages/daemon/test/new-thing.mjs", "packages/daemon/test/other-thing.mjs"]));
}
{
  const empty = listUntrackedTestFiles("/fake/repo", "packages/daemon/test/*.mjs", () => "\n");
  check("listUntrackedTestFiles: an empty git ls-files listing returns []", JSON.stringify(empty) === "[]");
}
{
  const onGitFailure = listUntrackedTestFiles("/fake/repo", "packages/daemon/test/*.mjs", () => { throw new Error("git not found"); });
  check("listUntrackedTestFiles: a git failure returns null (visibility-check hiccup, not a false 'found none')", onGitFailure === null);
}
{
  // THE REGRESSION THIS CARD FIXES, driven at the REAL git binary (not the fake above) — in a THROWAWAY
  // fixture repo, never the real shared repo: writing an untracked scratch file directly into this
  // process's OWN packages/daemon/test/ dir would race any concurrently-running real
  // fixed-wait-witness-guard.mjs process reading THIS repo's untracked state (this suite runs test files
  // concurrently — see CLAUDE.md's gate-concurrency notes) and could produce a spurious guard FAIL
  // unrelated to anyone's actual diff. Same isolation discipline working-tree-eol-guard.mjs's own
  // fixture-repo block already uses for exactly this reason.
  const fixtureRoot = mkdtempManaged("loom-fwwg-untracked-fixture-");
  const git = (...args) => execFileSync("git", ["-C", fixtureRoot, ...args]);
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  const fixtureTestDir = path.join(fixtureRoot, "packages", "daemon", "test");
  fs.mkdirSync(fixtureTestDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureTestDir, "tracked.mjs"), "// tracked\n");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  fs.writeFileSync(path.join(fixtureTestDir, "new-untracked.mjs"), "// untracked\n");
  const found = listUntrackedTestFiles(fixtureRoot, "packages/daemon/test/*.mjs");
  check("listUntrackedTestFiles: a REAL untracked file, in a real (throwaway) fixture repo, IS reported by the real git binary",
    Array.isArray(found) && found.some((f) => f.replace(/\\/g, "/").endsWith("packages/daemon/test/new-untracked.mjs")));
  cleanupPathSync(fixtureRoot);
  // unregister ONLY once removal is actually confirmed (_tmp-fixture.mjs's own contract:
  // cleanupPathSync can fail silently on a transient EBUSY/EPERM handle — see its own header — so
  // unregistering unconditionally would discard the exit-hook backstop for a dir that's still there).
  // Same guard working-tree-eol-guard.mjs's own fixture-repo block already uses.
  if (!fs.existsSync(fixtureRoot)) unregister(fixtureRoot);
}

// ── scanModifiedTrackedTestFiles: card 21e12d47's content-aware staged/unstaged-tracked-file scan ──────
// Dependency-injected execFileSyncFn variants first (deterministic, no real git process spawned).
{
  const onGitFailure = scanModifiedTrackedTestFiles("/fake/repo", "packages/daemon/test/*.mjs", () => { throw new Error("git not found"); });
  check("scanModifiedTrackedTestFiles: a git failure returns null (visibility-check hiccup, not a false 'found none')", onGitFailure === null);
}
{
  const empty = scanModifiedTrackedTestFiles("/fake/repo", "packages/daemon/test/*.mjs", () => "");
  check("scanModifiedTrackedTestFiles: an empty git diff returns zero files/hits/cleared",
    empty.files.length === 0 && empty.hits.length === 0 && empty.cleared.length === 0);
}

// scanModifiedTrackedTestFiles, driven at the REAL git binary in a THROWAWAY fixture repo — DoD-4's
// two-polarity positive control, BOTH asserted in this SAME run: (i) a staged-but-uncommitted test edit
// containing a real fixed-wait violation is CAUGHT; (ii) a clean staged-but-uncommitted edit still
// passes (a bare-presence check — "this tracked file has an uncommitted change, therefore FAIL" — would
// wrongly fail this one; see the function's own header for why that shape was rejected). Same isolation
// discipline as the listUntrackedTestFiles fixture test above: a throwaway repo, never the real shared
// one, since this suite runs test files concurrently.
{
  const fixtureRoot = mkdtempManaged("loom-fwwg-modified-fixture-");
  const git = (...args) => execFileSync("git", ["-C", fixtureRoot, ...args]);
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  const fixtureTestDir = path.join(fixtureRoot, "packages", "daemon", "test");
  fs.mkdirSync(fixtureTestDir, { recursive: true });
  const trackedFile = path.join(fixtureTestDir, "tracked-mod.mjs");
  fs.writeFileSync(trackedFile, "// tracked, about to be modified\n");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture: initial commit");

  // (i) RED — DoD-4(i): stage (git add, deliberately NOT committed) an edit that adds a real unwitnessed
  // fixed-wait violation to the already-tracked file — the exact specimen card 21e12d47 exists to fix
  // (the worker's real 33-line diff that scanned as 0 until committed).
  const violatingContent = [
    "// tracked, about to be modified",
    "{",
    `  await ${SLEEP_KW}(20);`,
    "  check(\"some claim\", true);",
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(trackedFile, violatingContent);
  git("add", "-A"); // staged, NOT committed
  const redResult = scanModifiedTrackedTestFiles(fixtureRoot, "packages/daemon/test/*.mjs");
  check("scanModifiedTrackedTestFiles DoD-4(i) RED: a staged-but-uncommitted edit WITH a real fixed-wait violation IS CAUGHT",
    redResult !== null && redResult.hits.length === 1 &&
    redResult.hits[0].file.replace(/\\/g, "/").endsWith("packages/daemon/test/tracked-mod.mjs"));

  // (ii) GREEN — DoD-4(ii): same staged-but-uncommitted shape, but the edit is CLEAN (no fixed-wait idiom
  // at all). Must still pass — a tracked file merely HAVING an uncommitted change is not itself a defect.
  const cleanContent = [
    "// tracked, about to be modified",
    "{",
    "  const x = 1;",
    "  check(\"some unrelated claim\", x === 1);",
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(trackedFile, cleanContent);
  git("add", "-A"); // staged, NOT committed
  const greenResult = scanModifiedTrackedTestFiles(fixtureRoot, "packages/daemon/test/*.mjs");
  check("scanModifiedTrackedTestFiles DoD-4(ii) GREEN: a staged-but-uncommitted edit with NO violation still passes cleanly",
    greenResult !== null && greenResult.hits.length === 0);

  cleanupPathSync(fixtureRoot);
  if (!fs.existsSync(fixtureRoot)) unregister(fixtureRoot);
}

// ── DoD-5 regression pin: BOTH population-visibility checks co-exist correctly on the SAME fixture repo
// — the untracked check (card 40643460) still names a genuinely untracked file when the new modified-
// tracked scan (card 21e12d47) also runs alongside it, and the new scan does NOT also swallow that
// untracked file into its own result (an untracked file is invisible to `git diff HEAD` by definition —
// the two checks stay disjoint, neither regresses nor duplicates the other's job).
{
  const fixtureRoot = mkdtempManaged("loom-fwwg-combined-fixture-");
  const git = (...args) => execFileSync("git", ["-C", fixtureRoot, ...args]);
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  const fixtureTestDir = path.join(fixtureRoot, "packages", "daemon", "test");
  fs.mkdirSync(fixtureTestDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureTestDir, "tracked.mjs"), "// tracked\n");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  fs.writeFileSync(path.join(fixtureTestDir, "brand-new-untracked.mjs"), "// untracked\n"); // never git add'ed

  const untracked = listUntrackedTestFiles(fixtureRoot, "packages/daemon/test/*.mjs");
  check("DoD-5 regression pin: the untracked check (card 40643460) still names a real untracked file when the modified-tracked scan also runs alongside it",
    Array.isArray(untracked) && untracked.some((f) => f.replace(/\\/g, "/").endsWith("packages/daemon/test/brand-new-untracked.mjs")));

  const modified = scanModifiedTrackedTestFiles(fixtureRoot, "packages/daemon/test/*.mjs");
  check("DoD-5 regression pin: the untracked file is invisible to scanModifiedTrackedTestFiles (git diff HEAD never sees an untracked path) — the two checks stay disjoint",
    modified !== null && modified.files.length === 0 && modified.hits.length === 0);

  cleanupPathSync(fixtureRoot);
  if (!fs.existsSync(fixtureRoot)) unregister(fixtureRoot);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — fixed-wait-witness-guard's detection logic goes RED on an unwitnessed hit, GREEN for each of the three witness forms plus the windowMs/positiveControl pairing, is diff-scoped by construction, does not false-positive on the real 003a1080 specimen, correctly names a REAL untracked file the diff-scan itself cannot see (card 40643460), and correctly catches (or clears) a REAL staged-but-uncommitted tracked-file edit the diff-scan also cannot see (card 21e12d47)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
