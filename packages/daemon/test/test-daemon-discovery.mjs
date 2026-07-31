// Card b122c7d4 acceptance evidence — a real, permanent regression test (not a one-off manual proof) for
// scripts/test-daemon.mjs's discovery ALLOWLIST: `discoverHermeticTests` is imported directly (never a
// duplicated copy — the census harness already learned that lesson the hard way, see its own lib.mjs
// comment) and exercised against a synthetic temp directory, never the real test/ tree.
//
// Card e7bcb0df extends this with `auditDiscoveryAgainstGit` coverage: the walk-vs-git cross-check, its
// anchoring/validation/raw-layer constraints, and the path-wide underscore-exclusion fix (GAP 2). These
// scenarios build a REAL throwaway git repo per `mkGitRepo` below (via `git init` + `git add`, no commit
// needed — `git ls-files` reads the INDEX, so a bare `add` is enough) so the cross-check is exercised
// against a genuinely independent git process, not a mocked stand-in for one.
//
// Fully hermetic — no daemon, no claude; fs + a scratch `git` repo + the real discovery functions.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { discoverHermeticTests, auditDiscoveryAgainstGit, findExcludedDirTestShapedFiles } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "test-daemon.mjs")).href
);

// Initializes a scratch git repo at `dir` and returns a `run(args)` helper scoped to it (throws on a
// non-zero git exit, surfacing stderr — so a setup mistake in a test below fails loudly, not silently).
function mkGitRepo(dir) {
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} (cwd ${dir}) exited ${result.status}: ${result.stderr}`);
    }
    return result.stdout;
  };
  run(["init", "-q"]);
  return run;
}

const dir = mkdtempManaged("loom-test-daemon-discovery-");
{
  // A genuine test-shaped file — must be discovered and allowlisted.
  fs.writeFileSync(
    path.join(dir, "real-test.mjs"),
    'if (1 !== 1) { throw new Error("unreachable"); }\nconsole.log("ok");\n',
  );
  // A legitimate helper (leading underscore, no assertion marker of its own) — must be silently excluded,
  // never flagged as a violation, never run.
  fs.writeFileSync(path.join(dir, "_helper.mjs"), 'export const thing = 1;\n');
  // The positive control (card b122c7d4's exact acceptance scenario): NOT underscore-prefixed, and does
  // NOT look like a test (no check(/assert/throw new Error/process.exit(1) marker) — must be refused as
  // a violation, not silently run-and-passed and not silently dropped.
  fs.writeFileSync(path.join(dir, "not-a-test.mjs"), 'console.log("just a script that exits 0");\n');
  // A genuine importer living inside an EXCLUDED directory (fixtures/) — even though its content matches
  // the assertion-marker shape, it must never be discovered at all (directory-level exclusion wins).
  fs.mkdirSync(path.join(dir, "fixtures"));
  fs.writeFileSync(path.join(dir, "fixtures", "child.mjs"), 'if (false) throw new Error("x");\n');
  fs.mkdirSync(path.join(dir, "census"));
  fs.writeFileSync(path.join(dir, "census", "probe.mjs"), 'process.exit(1);\n');

  const { hermetic, violations } = discoverHermeticTests(dir, new Set());

  check("real, assertion-shaped file is discovered and allowlisted", hermetic.includes("real-test"));
  check("underscore-prefixed helper is silently excluded (not hermetic, not a violation)", !hermetic.includes("_helper") && !violations.includes("_helper.mjs"));
  check(
    "[positive control] a non-underscore file with no assertion marker is REFUSED (named as a violation), not silently run",
    violations.includes("not-a-test.mjs") && !hermetic.includes("not-a-test"),
  );
  check("a file under fixtures/ is never discovered at all, even though it is assertion-shaped", !hermetic.includes("fixtures/child") && !violations.includes("fixtures/child.mjs"));
  check("a file under census/ is never discovered at all, even though it is assertion-shaped", !hermetic.includes("census/probe") && !violations.includes("census/probe.mjs"));
  check("exactly one violation is reported (only the genuine positive control)", violations.length === 1);
  check("exactly one hermetic test is reported (only the genuine test)", hermetic.length === 1);

  // notHermetic denylist still removes an otherwise-valid candidate by name, same as the real gate's
  // NOT_HERMETIC set removes e.g. "integration-e2e".
  const { hermetic: withDenylist } = discoverHermeticTests(dir, new Set(["real-test"]));
  check("the notHermetic denylist still removes a genuine test by name", !withDenylist.includes("real-test"));
}
// dir's own manual finally-block rmSync removed here: mkdtempManaged already registered it for
// guaranteed cleanup at process exit (card 995be21f).

// --- Card e7bcb0df GAP 2: the underscore-exclusion rule must be PATH-WIDE, not basename-only ---------
{
  const dir2 = mkdtempManaged("loom-test-daemon-discovery-gap2-");
  // RED-first scenario (DoD 3): a marker-LESS .mjs nested under an underscore-prefixed DIRECTORY whose
  // own basename carries no underscore. The OLD (basename-only) rule would have let this through as a
  // candidate — no assertion marker ⇒ a VIOLATION ⇒ the whole gate refuses to run. The FIXED rule must
  // treat the underscore on the containing directory as excluding it, silently, same as any other helper.
  fs.mkdirSync(path.join(dir2, "_scratch"));
  fs.writeFileSync(path.join(dir2, "_scratch", "x.mjs"), 'console.log("no marker, no underscore basename");\n');
  // Also cover a MARKER-shaped file under the same underscore directory — must ALSO be silently
  // excluded (the directory-level exclusion wins regardless of what the file itself looks like), never
  // accidentally picked up as hermetic just because it happens to look test-shaped.
  fs.writeFileSync(path.join(dir2, "_scratch", "y.mjs"), 'if (1 !== 1) throw new Error("unreachable");\n');

  const { hermetic, violations } = discoverHermeticTests(dir2, new Set());
  check(
    "[GAP 2] a marker-less file under an underscore-prefixed DIRECTORY is silently excluded, not a violation",
    !violations.includes("_scratch/x.mjs") && !hermetic.includes("_scratch/x"),
  );
  check(
    "[GAP 2] a marker-shaped file under an underscore-prefixed DIRECTORY is also silently excluded, not hermetic",
    !hermetic.includes("_scratch/y") && !violations.includes("_scratch/y.mjs"),
  );
  check("[GAP 2] nothing under the underscore directory is reported at all", hermetic.length === 0 && violations.length === 0);
}

// --- Card e7bcb0df FIX 1: auditDiscoveryAgainstGit, the independent walk-vs-git cross-check -----------
{
  // Positive control: a clean tree — including the intentionally-excluded fixtures/census subtrees,
  // which the RAW walk (unlike the production walk) does traverse — must show ZERO diff in either
  // direction once everything is tracked. Proves the raw-layer comparison (FIX 1 (iii)) doesn't
  // false-positive on the architecture's own deliberate directory exclusions.
  {
    const clean = mkdtempManaged("loom-test-daemon-discovery-git-clean-");
    const run = mkGitRepo(clean);
    fs.writeFileSync(path.join(clean, "real-test.mjs"), 'if (1 !== 1) throw new Error("x");\n');
    fs.writeFileSync(path.join(clean, "_helper.mjs"), 'export const thing = 1;\n');
    fs.mkdirSync(path.join(clean, "fixtures"));
    fs.writeFileSync(path.join(clean, "fixtures", "child.mjs"), 'if (false) throw new Error("x");\n');
    fs.mkdirSync(path.join(clean, "census"));
    fs.writeFileSync(path.join(clean, "census", "probe.mjs"), 'process.exit(1);\n');
    run(["add", "-A"]);

    const audit = auditDiscoveryAgainstGit(clean);
    check(
      "[positive control] a clean, fully-tracked tree (incl. fixtures/census) reports zero diff in both directions",
      audit.inGitNotWalked.length === 0 && audit.walkedNotInGit.length === 0,
    );
  }

  // RED-first, GAP 1 (DoD 1): a REAL under-discovery. `other-test.mjs` is `git add`-ed (tracked, present
  // in the index) and then deleted from disk — the walk (whatever it is, raw or production) can never see
  // it again, but git still lists it. This is exactly "the walk cannot check itself": `discoverHermeticTests`
  // (which derives HERMETIC from the very same walk) reports a clean, GREEN result with the file simply
  // absent — no violation, no error, nothing to notice. `auditDiscoveryAgainstGit` is the only thing that
  // can catch this, and must name the file.
  {
    const underDiscover = mkdtempManaged("loom-test-daemon-discovery-git-gap1-");
    const run = mkGitRepo(underDiscover);
    fs.writeFileSync(path.join(underDiscover, "real-test.mjs"), 'if (1 !== 1) throw new Error("x");\n');
    fs.writeFileSync(path.join(underDiscover, "other-test.mjs"), 'if (1 !== 1) throw new Error("x");\n');
    run(["add", "-A"]);
    fs.unlinkSync(path.join(underDiscover, "other-test.mjs"));

    const { hermetic } = discoverHermeticTests(underDiscover, new Set());
    check(
      "[GAP 1 red-first] the walk-derived discovery reports GREEN — it simply never sees the missing file",
      hermetic.includes("real-test") && !hermetic.includes("other-test"),
    );
    const audit = auditDiscoveryAgainstGit(underDiscover);
    check(
      "[GAP 1 red-first] the independent git cross-check reports RED, naming exactly the missing file",
      audit.inGitNotWalked.length === 1 && audit.inGitNotWalked[0] === "other-test.mjs",
    );
    check("[GAP 1] the reverse direction is clean (nothing walked-but-untracked here)", audit.walkedNotInGit.length === 0);
  }

  // walked-but-untracked (the other direction): an on-disk file never `git add`-ed. Must be reported as
  // an untracked stray (`walkedNotInGit`), never as `inGitNotWalked` — this is a warning-worthy but
  // non-fatal state (a worker's own new, not-yet-staged test file), not the GAP-1 failure mode.
  {
    const untracked = mkdtempManaged("loom-test-daemon-discovery-git-stray-");
    const run = mkGitRepo(untracked);
    fs.writeFileSync(path.join(untracked, "real-test.mjs"), 'if (1 !== 1) throw new Error("x");\n');
    run(["add", "-A"]);
    fs.writeFileSync(path.join(untracked, "stray.mjs"), 'if (1 !== 1) throw new Error("x");\n'); // never git add-ed

    const audit = auditDiscoveryAgainstGit(untracked);
    check("[untracked stray] reported as walkedNotInGit, exactly one, named", audit.walkedNotInGit.length === 1 && audit.walkedNotInGit[0] === "stray.mjs");
    check("[untracked stray] never reported as inGitNotWalked (it's not a discovery failure)", audit.inGitNotWalked.length === 0);
  }

  // RED-first, the CWD hole (DoD 2, FIX 1 (i)): call the audit while process.cwd() points somewhere
  // totally unrelated to the repo under test. An UNANCHORED implementation (one that ran `git` with the
  // inherited cwd instead of an explicit one) would silently answer from the WRONG repo — this proves the
  // anchored version still returns the correct reference set regardless of ambient cwd. `path.dirname
  // (anchored)` is `mkdtempManaged`'s own OS temp root (it mkdtemps directly under it) — an ancestor of
  // `anchored` but NOT itself a git repo, without this file needing its own `node:os` import.
  {
    const anchored = mkdtempManaged("loom-test-daemon-discovery-git-anchor-");
    const originalCwd = process.cwd();
    try {
      const run = mkGitRepo(anchored);
      fs.writeFileSync(path.join(anchored, "real-test.mjs"), 'if (1 !== 1) throw new Error("x");\n');
      run(["add", "-A"]);

      process.chdir(path.dirname(anchored)); // an ancestor of `anchored`, but NOT itself a git repo — a wrong cwd
      const audit = auditDiscoveryAgainstGit(anchored);
      check(
        "[CWD hole] the anchored audit still returns the correct reference set from an unrelated cwd",
        audit.inGitNotWalked.length === 0 && audit.walkedNotInGit.length === 0,
      );
    } finally {
      process.chdir(originalCwd);
    }
  }

  // RED-first, empty/invalid reference (DoD 2, FIX 1 (ii)): a directory with no git repo at all must
  // ERROR, never silently return an empty (vacuously-passing) comparison.
  {
    const notARepo = mkdtempManaged("loom-test-daemon-discovery-git-norepo-");
    fs.writeFileSync(path.join(notARepo, "real-test.mjs"), 'if (1 !== 1) throw new Error("x");\n');
    let threw = false;
    try { auditDiscoveryAgainstGit(notARepo); } catch { threw = true; }
    check("[empty reference] a directory with no git repo at all throws, rather than passing vacuously", threw);
  }

  // RED-first, empty/invalid reference, second shape: a REAL repo, but the test dir itself has nothing
  // tracked under it at all — `git ls-files` succeeds (exit 0) but returns an empty reference set. Must
  // still ERROR (a zero-size reference is a hard error per FIX 1 (ii)), not be treated as "zero diff".
  {
    const emptyTracked = mkdtempManaged("loom-test-daemon-discovery-git-emptyref-");
    const run = mkGitRepo(emptyTracked);
    fs.writeFileSync(path.join(emptyTracked, "README.md"), "tracked elsewhere in the repo\n");
    fs.mkdirSync(path.join(emptyTracked, "emptysub"));
    run(["add", "README.md"]); // something IS tracked in the repo — just nothing under emptysub/
    let threw = false;
    try { auditDiscoveryAgainstGit(path.join(emptyTracked, "emptysub")); } catch { threw = true; }
    check("[empty reference] a real repo with zero tracked files under testDir throws, rather than passing vacuously", threw);
  }

  // RED-first, empty/invalid reference, THIRD shape (manager's negative control, mgr review of e7bcb0df):
  // a real repo, and testDir has tracked files under it — but NONE of them are .mjs. `tracked.length`
  // above is > 0 (something IS tracked), so that guard alone is not enough; the guard has to be on the
  // set the comparison actually uses (`gitMjs`), or this is a clean pass on an empty-vs-empty comparison —
  // the exact vacuous shape constraint (ii) exists to prevent, one layer in (measured live: pointing the
  // pre-fix audit at this repo's own packages/daemon/src, which is all tracked .ts and zero .mjs, returned
  // a clean {inGitNotWalked:0, walkedNotInGit:0} instead of throwing).
  {
    const nonMjsTracked = mkdtempManaged("loom-test-daemon-discovery-git-nonmjsref-");
    const run = mkGitRepo(nonMjsTracked);
    fs.writeFileSync(path.join(nonMjsTracked, "notes.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(nonMjsTracked, "README.md"), "no .mjs here\n");
    run(["add", "-A"]);
    let threw = false;
    try { auditDiscoveryAgainstGit(nonMjsTracked); } catch { threw = true; }
    check(
      "[empty reference, non-.mjs shape] a real repo with tracked files but ZERO .mjs among them throws, rather than passing vacuously",
      threw,
    );
  }
}

// --- Card fa52f555 Part 2: findExcludedDirTestShapedFiles — the excluded-dir loud-refusal guard --------
// Same synthetic-dir pattern as above — never the real test/ tree. Builds a tree with `fixtures/` and
// `census/` subdirectories directly under the synthetic root (matching the real EXCLUDED_DIR_NAMES
// shape) and exercises every classification outcome.
{
  const dir = mkdtempManaged("loom-test-daemon-excluded-dir-guard-");
  fs.mkdirSync(path.join(dir, "fixtures"));
  fs.mkdirSync(path.join(dir, "census"));

  // [positive control] a marker-less, non-underscore, test-shaped file inside an excluded dir — must be
  // reported as a violation, the exact false-coverage scenario this guard exists to catch.
  fs.writeFileSync(
    path.join(dir, "census", "forgotten.mjs"),
    'if (1 !== 1) { throw new Error("unreachable"); }\n',
  );
  // A marker-shaped file, but the marker's reason is EMPTY — must be treated as undeclared (still a
  // violation), per the explicit "a marker with no reason does not count" rule.
  fs.writeFileSync(
    path.join(dir, "fixtures", "empty-reason.mjs"),
    '// loom:gate-exempt:\nif (1 !== 1) { throw new Error("unreachable"); }\n',
  );
  // [negative control] the SAME file, but WITH a real reason — must be exempted and bucketed as declared.
  fs.writeFileSync(
    path.join(dir, "census", "declared-test.mjs"),
    '// loom:gate-exempt: a real manual test, run out of band\nif (1 !== 1) { throw new Error("unreachable"); }\n',
  );
  // A `not-a-test` marker with a real reason — must be exempted into the OTHER bucket, never conflated
  // with `gate-exempt` (they mean different things in the echoed count).
  fs.writeFileSync(
    path.join(dir, "fixtures", "declared-fixture.mjs"),
    '// loom:not-a-test: a shared lib that only throws for validation, not a real test\nif (1 !== 1) { throw new Error("unreachable"); }\n',
  );
  // A non-test-shaped file inside an excluded dir — nothing to flag either way; must be silently ignored.
  fs.writeFileSync(path.join(dir, "census", "not-test-shaped.mjs"), 'console.log("just a script");\n');
  // An underscore-prefixed helper inside an excluded dir — already self-declared by the naming convention;
  // must be silently ignored even though it's test-shaped, same precedence as the main discovery walk.
  fs.writeFileSync(
    path.join(dir, "fixtures", "_helper.mjs"),
    'if (1 !== 1) { throw new Error("unreachable"); }\n',
  );
  // A marker-less, non-underscore, test-shaped file OUTSIDE any excluded dir — this function must never
  // flag it (that's DISCOVERY_VIOLATIONS's job, a different check); scoping must stay to excluded dirs only.
  fs.writeFileSync(
    path.join(dir, "real-test.mjs"),
    'if (1 !== 1) { throw new Error("unreachable"); }\n',
  );

  const { violations, declared } = findExcludedDirTestShapedFiles(dir);

  check(
    "[positive control] a marker-less test-shaped file in an excluded dir is refused, named exactly",
    violations.includes("census/forgotten.mjs"),
  );
  check(
    "a marker with an EMPTY reason is treated as undeclared — reported as a violation, not exempted",
    violations.includes("fixtures/empty-reason.mjs"),
  );
  check("exactly two violations reported (forgotten + empty-reason, nothing else)", violations.length === 2);
  check(
    "[negative control] the same test, WITH a reasoned gate-exempt marker, is NOT a violation and lands in the gate-exempt bucket",
    !violations.includes("census/declared-test.mjs") && declared.gateExempt.includes("census/declared-test.mjs"),
  );
  check(
    "a reasoned not-a-test marker is NOT a violation and lands in the SEPARATE not-a-test bucket",
    !violations.includes("fixtures/declared-fixture.mjs") && declared.notATest.includes("fixtures/declared-fixture.mjs"),
  );
  check("gate-exempt and not-a-test buckets never cross-contaminate", declared.gateExempt.length === 1 && declared.notATest.length === 1);
  check(
    "a non-test-shaped file in an excluded dir is silently ignored (not a violation, not declared)",
    !violations.includes("census/not-test-shaped.mjs") && !declared.gateExempt.includes("census/not-test-shaped.mjs") && !declared.notATest.includes("census/not-test-shaped.mjs"),
  );
  check(
    "an underscore-prefixed helper in an excluded dir is silently ignored even though test-shaped",
    !violations.includes("fixtures/_helper.mjs"),
  );
  check(
    "a marker-less test-shaped file OUTSIDE any excluded dir is never flagged by this function (out of scope)",
    !violations.includes("real-test.mjs") && !declared.gateExempt.includes("real-test.mjs") && !declared.notATest.includes("real-test.mjs"),
  );
}

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-discovery: ${failures} check(s) failed.`);
await finishAndExit(failures === 0 ? 0 : 1);
