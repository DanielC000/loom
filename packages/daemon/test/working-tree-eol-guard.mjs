import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs+git
// STANDING GUARD (card 4f2c493a) — guards against a WHOLE-FILE CRLF-to-LF flip. ⚠️ CORRECTED BY CARD
// a9728787 (2026-08-27): this header used to claim EVERY git-side signal is blind to the flip. That
// overclaimed — see THE STAGING WINDOW below for the accurate version, which makes the guard MORE
// clearly necessary, not less.
//
// THE MECHANISM: this repo runs `core.autocrlf=true` with `.gitattributes` `* text=auto` — git stores
// LF in the blob and the checkout smudge filter writes CRLF into the working tree. A wholesale file
// rewrite that reads through a normalising layer and writes bytes back (measured on this card: the
// `Write` tool; also any `open(p).read()` + `open(p,'wb')` Python/Bash rewrite) flips the ENTIRE file to
// LF — not just the edited region.
//
// THE STAGING WINDOW (card a9728787): `git status --porcelain` DOES see an UNSTAGED flip (` M <path>`)
// — it is NOT blind at that point. It goes blind the moment the flip is staged (`git add`), because the
// clean filter re-normalises the index entry to match HEAD's LF-normalised blob while the working-tree
// bytes stay flipped. `git diff HEAD`, `git diff --numstat`, and `git show HEAD:<file>` are blind in
// BOTH states — none of them ever look at raw working-tree bytes, staged or not. Git DOES warn when the
// flip happens ("LF will be replaced by CRLF the next time Git touches it") but only to STDERR, where it
// is trivially missed inside a normal `git add` + `git commit` flow.
// ⭐ THE WINDOW BEING REAL IS WHY THIS GUARD STILL MATTERS: an ordinary worker workflow stages before
// committing, closing the one window that would have told you — silently, on stderr nobody reads. The
// signal exists, is real, and is routinely destroyed before anyone sees it.
// ⚠️ EVIDENCE SCOPE: the staging-window mechanism above was demonstrated in an ISOLATED SYNTHETIC repo
// (fresh `git init`, three tiny files, no `.gitattributes`) — a MECHANISM demonstration, NOT a
// re-derivation of the original incident that motivated this guard. It carries two real-repo anchors:
// the pre-staging `git status` reading was independently observed on a real tracked file; the
// post-staging reading matches the original recorded incident. The original incident's own root cause
// remains UNESTABLISHED — this correction does not claim to have found it.
//
// A guard built on git status/diff/numstat/show still shares a real blind spot no matter how many of
// them you combine — six checks routed through the same normalising layer (and, for status, the same
// staging step every worker actually performs before committing) are one instrument wearing six hats.
// ⛔ THIS GUARD DOES NOT USE git status/diff/numstat/show FOR THAT REASON — it reads the
// WORKING-TREE FILE'S RAW BYTES directly off disk (`fs.readFileSync`) and compares them against what
// `.gitattributes` + `core.autocrlf` imply for that path, which is derived from `git check-attr`
// (pure path-pattern matching against .gitattributes — it never reads file content, so it carries none
// of the blind spot above) and `git config --get core.autocrlf` (a plain config read).
//
// RESPECTING THE DELIBERATE PINS, WITHOUT HARDCODING THEM: `.gitattributes` pins `*.sh`,
// `packages/daemon/assets/skills/**`, and `install.ps1` on purpose (a CRLF shebang breaks
// `curl … | sh`; `install.ps1` gets the Windows default instead). This guard reads those pins live via
// `git check-attr eol` per path — never a hand-copied list of pinned globs, which would silently drift
// from `.gitattributes` the moment either changed (card f645b481's shadow-list defect, one level up).
//
// NO KNOWN ALWAYS-LF FILE REMAINS, as of card `eda83035`. `packages/web/src/pages/Companion.tsx` used
// to be the last one: it carried a single literal NUL (0x00) byte in its own source (a sentinel
// map-key). A NUL byte anywhere in a blob is exactly the heuristic git's OWN `text=auto` content-
// sniffing uses to decide a path is BINARY — confirmed empirically (card `4f2c493a`) by running `git
// checkout --` against the file directly: its working-tree bytes didn't change, in this worktree or a
// fresh one, regardless of `core.autocrlf`. A binary-by-content file is never subject to LF/CRLF
// conversion by git at all — commit or checkout — so there was no line-ending policy to enforce on it.
// Card `eda83035` rewrote that NUL as the `\u0000` escape (an identical runtime string value, per the
// ECMAScript spec — the map-key's codepoints are unchanged), the same fix card `71231839` had already
// applied to `packages/daemon/test/resume-mode-detect.mjs`'s own garbage-input fixture earlier. Both
// files are now ordinary unpinned text=auto files, checked against the same CRLF-on-this-host policy as
// everything else, like any other file that never carried a NUL.
//
// THE `containsNul` SKIP ITSELF STAYS — it is not dead code just because its last real exemplar is
// fixed. It generalises to any FUTURE file with the same shape (nothing here needs updating if one is
// ever added), and it means a real flip can never hide behind this exemption: a genuinely flipped source
// file (a config, a doc, an ordinary source file) has no reason to carry an embedded NUL, and one that
// legitimately does is — by construction — a file git itself was never going to touch either. With no
// real-repo exemplar left to exercise it, section (A) below now carries a direct unit-level positive/
// negative control for `containsNul` instead (DoD-4's real-fixture-repo proof is a separate, earlier
// concern — the CRLF-flip detection, not this skip).
//
// ⚠️ THE DISCLOSED RESIDUAL (card 5df7bcee): this guard's own `containsNul` skip, combined with
// `fixed-wait-witness-guard.mjs`'s binary-diff handling (card 71231839), means a NUL-bearing file under
// `packages/daemon/test/*.mjs` would be silently unscanned by BOTH guards — neither announcing it. Card
// `223cb2df` already settled that widening THIS guard's NUL-skip population is the wrong fix (false
// rejections on a harmless state, and it still misses the real thing) — that conclusion is untouched
// here. Instead, `fixed-wait-witness-guard.mjs` asserts the precondition never holds at all for that one
// shared directory: no file matching `packages/daemon/test/*.mjs` may carry a raw NUL byte (see that
// guard's own header). This guard's `containsNul` skip stays exactly as designed — for anything outside
// that directory, a NUL-bearing file remains a legitimate, deliberate exemption with no sibling
// assertion backing it, because nothing requires one there. No tracked file currently exercises this
// path (see the unit-level control in section (A) instead).
//
// CROSS-HOST CORRECTNESS: `core.autocrlf` is read LIVE (`git config --get core.autocrlf`), not assumed
// true. On this Windows dev host it is `true`, so an unpinned text=auto file is expected to be CRLF on
// disk. CI (`.github/workflows/ci.yml`) checks this repo out on `ubuntu-latest` via `actions/checkout`,
// where `core.autocrlf` is not `true` by default — there, the SAME unpinned files are legitimately pure
// LF (the blob's own normalised form, since git never converts), and this guard's expected policy
// follows that live config rather than hardcoding "must be CRLF everywhere". An explicit `eol=lf`/
// `eol=crlf` pin always wins over `core.autocrlf` either way, matching git's own precedence.
//
// WHY IT BELONGS IN `STATIC_GUARD_REPO_PATHS` (see that array's own membership criterion in
// `packages/daemon/src/git/worktrees.ts`): a behavioural `.ts` src edit already forces the FULL gate
// (every guard runs via the corpus walk), so a guard whose only invalidator is that kind of edit needs
// no seat on the reduced path. This guard's invalidator is different in kind: a WHOLE-FILE CRLF flip of
// a `packages/daemon/src/**/*.ts` or `packages/daemon/test/**/*.mjs` file changes zero compiled/runtime
// behaviour (line endings are inert to both TS compilation and test pass/fail), so it can slip through
// `computeEmitCompareGate`'s reduced path (which reasons about compiled-output and test-pass equivalence,
// not raw bytes) with the reduced gate never re-running the corpus-wide guards at all — exactly the same
// shape `fixed-wait-witness-guard.mjs` was added for. Files entirely OUTSIDE those two prefixes (config/
// doc files — where 8 of the flips this card's own investigation found actually live) already force the
// FULL gate on any touching diff regardless, so this guard reaches them there too; the reduced-path gap
// is specifically the src/test-scoped case.
//
// POSITIVE CONTROL (DoD-4): section (A) below builds a real fixture git repo, commits a CRLF file and an
// `eol=lf`-pinned file, confirms both evaluate GREEN as committed, then flips the CRLF file's own bytes
// to bare LF in place (an in-process simulation of exactly the Write-tool whole-file rewrite this card
// is about) and confirms the SAME evaluation function now goes RED. Section (B) is the real backstop:
// every tracked text file in THIS repo, scanned live.
//
// UNTRACKED-FILE VISIBILITY (card c3e70c20, 2026-08-31): `listUntrackedFiles` below enumerates via
// `git ls-files` — TRACKED FILES ONLY. A file created but never `git add`ed contributed nothing to that
// population and was invisible to section (B)'s scan, so a genuine EOL-policy violation in a brand-new
// file reported a clean `exit 0` — verified empirically on this card in a throwaway fixture repo (a
// never-added bare-LF file under a CRLF policy: absent from `git ls-files -z`, present in `git status
// --porcelain`). This cost a real 15-minute gate lane here (`opId bb4dc964`) and a rejected gate on a peer
// project, in both cases because the worker's own PRE-COMMIT guard run returned a meaningless clean pass.
// FIX: `listUntrackedFiles` below reuses the SAME primitive `fixed-wait-witness-guard.mjs`'s
// `listUntrackedTestFiles` (card 40643460) already established for exactly this hazard in this repo —
// `git ls-files --others --exclude-standard` — rather than re-typing it (re-typing it is how this
// two-guard asymmetry was created in the first place).
//
// DELIBERATE CHOICE, AND WHY THE SIBLING'S PRECEDENT DOES NOT TRANSFER (card c3e70c20 DoD-2, corrected by
// the manager on review — the card's own original wording recommended "NAME IT AND FAIL" bare presence,
// borrowed from that sibling; that recommendation was considered here and REJECTED): the sibling guard is
// DIFF-scoped — an untracked file genuinely contributes nothing to a `HEAD`-vs-merge-base diff, so bare
// presence-fail is the only option it has. THIS guard is CONTENT-scoped — it already reads raw
// working-tree bytes directly off disk regardless of tracked status, and `git check-attr` resolves
// `.gitattributes` patterns for ANY path whether tracked or not (verified empirically on this card: an
// untracked path's `eol`/`text` attrs resolve exactly like a tracked one's). A real verdict is available,
// so a blanket presence-fail would be strictly worse than useless here: it would fail every CORRECT new
// file too, training workers to distrust (and eventually silence) the guard. So an untracked text file is
// evaluated through the EXACT SAME content-aware pipeline as a tracked one — FAIL only on an actual
// violation, never on bare presence. Same repo, same-looking hazard, opposite correct answer — a
// precedent is evidence about its OWN case, not a license to copy the verdict into a differently-shaped
// one. And because `git ls-files --others --exclude-standard` honours `.gitignore`, a legitimately
// ignored file (build output, `dist/`, `node_modules`) never enters this population at all — verified as
// a third fixture polarity below, since without it this guard would be unusable in any real tree.
//
// NOT A DIRECTORY-RECURSION BUG (card d854889d, 2026-10-12): a worker on card 1718416d reported this
// guard missed a bare-LF `native/win-job-launcher/launcher.cs`, sitting alone inside a brand-new
// untracked DIRECTORY, and hypothesized the cause was `listUntrackedFiles` (below) collapsing a new
// untracked dir the way `git status --porcelain` does (`?? dir/`, one entry, contents invisible) unless
// run with `-uall`/`--untracked-files=all`. ⛔ THAT HYPOTHESIS DOES NOT SURVIVE REPRO — `listUntrackedFiles`
// never calls `git status` at all; it calls `git ls-files --others --exclude-standard`, and THAT
// primitive already recurses fully into a brand-new nested directory and lists every file inside it
// individually, by design (verified directly, both in an isolated fixture repo and against this repo's
// own real tree: a 2-level-deep brand-new directory with a bare-LF `.ts` file alongside the bare-LF `.cs`
// file was enumerated, evaluated, AND correctly flagged as a violation in the SAME run that missed the
// `.cs` file — see section (A)'s nested-directory checks below for the in-fixture proof).
//
// @decision d854889d — the extension allowlist itself was the defect; it is gone, not widened. Full
// narrative, the corpus-scan evidence, and why a dotfile (`.gitignore`/`.gitattributes`/`.npmrc`) could
// never have been matched by any string added to it: docs/decisions/d854889d-eol-guard-no-extension-allowlist.md
//
// HERMETIC: git + fs only — no daemon, no build required.
// Run: node packages/daemon/test/working-tree-eol-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, unregister, finishAndExit } from "./_tmp-fixture.mjs";
import {
  containsNul, expectedPolicy, evaluate, coreAutocrlfTrue, listTrackedFiles, listUntrackedFiles,
  resolveTrackedGitEolStates, checkAttrsBatch, scanEolViolations, fixViolations,
} from "./_eol-policy.mjs";

// `--fix` (card 97ddb56b): rewrite ONLY the files section (B) flags to their expected line endings, then
// re-scan. Only ever acts on THIS repo's own root; `scripts/run-static-guards.mjs` spawns this file with
// no extra argv, so the runner can never trigger it.
const FIX_MODE = process.argv.includes("--fix");
const FIX_COMMAND = "node packages/daemon/test/working-tree-eol-guard.mjs --fix";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", ".."); // test/ -> daemon -> packages -> repo root

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// =====================================================================================================
// (A) POSITIVE CONTROL — a real fixture git repo, proving the guard actually fires (DoD-4).
// =====================================================================================================
{
  const fixtureRoot = mkdtempManaged("loom-eol-guard-fixture-");
  try {
    const git = (...args) => execFileSync("git", ["-C", fixtureRoot, ...args]);
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("config", "core.autocrlf", "true"); // emulate the Windows host regardless of the runner's own global config
    fs.writeFileSync(path.join(fixtureRoot, ".gitattributes"), "* text=auto\r\npinned.md text eol=lf\r\n");
    fs.writeFileSync(path.join(fixtureRoot, "clean.json"), '{\r\n  "a": 1\r\n}\r\n');
    fs.writeFileSync(path.join(fixtureRoot, "pinned.md"), "# pinned\nstays lf\n");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");

    const fixtureAttrs = checkAttrsBatch(fixtureRoot, ["clean.json", "pinned.md"]);
    const cleanAttr = fixtureAttrs.get("clean.json") || {};
    const pinnedAttr = fixtureAttrs.get("pinned.md") || {};
    const cleanPolicy = expectedPolicy(cleanAttr.eol, cleanAttr.text, true);
    const pinnedPolicy = expectedPolicy(pinnedAttr.eol, pinnedAttr.text, true);

    check("(fixture) an unpinned text=auto file under core.autocrlf=true resolves to policy \"crlf\"", cleanPolicy === "crlf");
    check("(fixture) the eol=lf-pinned file resolves to policy \"lf\" regardless of core.autocrlf", pinnedPolicy === "lf");

    const cleanBufBefore = fs.readFileSync(path.join(fixtureRoot, "clean.json"));
    const pinnedBuf = fs.readFileSync(path.join(fixtureRoot, "pinned.md"));
    check("(fixture) GREEN: clean.json's own CRLF content evaluates ok before any flip", evaluate(cleanBufBefore, cleanPolicy).ok === true);
    check("(fixture) GREEN: pinned.md's own LF content evaluates ok (the pinned-file case)", evaluate(pinnedBuf, pinnedPolicy).ok === true);

    // Simulate the exact fault this card is about: a whole-file rewrite that flips CRLF -> bare LF.
    const flipped = Buffer.from(cleanBufBefore.toString("latin1").split("\r\n").join("\n"), "latin1");
    check("(fixture) sanity: the simulated flip actually changed the bytes", !cleanBufBefore.equals(flipped));
    check("(fixture) RED PROOF: the flipped bytes are caught against the SAME policy the clean bytes passed", evaluate(flipped, cleanPolicy).ok === false);
    check("(fixture) RED PROOF: a flipped file still passes an \"lf\" policy (proves this is a targeted check, not a blanket fail)", evaluate(flipped, "lf").ok === true);

    // Card c3e70c20 — POSITIVE CONTROL, BOTH DIRECTIONS, ON THIS SAME FIXTURE (DoD-3): a never-`git
    // add`ed new file with bare LF under this fixture's CRLF policy must now be VISIBLE and FAIL; a
    // never-added new file that's already correct must NOT spuriously fail; and the tracked-file walk
    // above must stay unaware of either (byte-identical tracked behaviour — DoD-3(c)).
    fs.writeFileSync(path.join(fixtureRoot, "untracked-bad.json"), '{\n  "bad": true\n}\n'); // bare LF — violates crlf policy
    fs.writeFileSync(path.join(fixtureRoot, "untracked-good.json"), '{\r\n  "good": true\r\n}\r\n'); // correct CRLF
    // deliberately never `git add`ed — this is the exact never-added-new-file shape the card is about

    const untrackedFound = listUntrackedFiles(fixtureRoot);
    check(
      "(fixture) RED CASE: a never-`git add`ed new file is now VISIBLE to the untracked-file enumerator (this is the exact blindness the card fixes)",
      untrackedFound !== null && untrackedFound.includes("untracked-bad.json") && untrackedFound.includes("untracked-good.json"),
    );
    check(
      "(fixture) the untracked enumerator does NOT pick up already-tracked files (clean.json/pinned.md stay out of it — no double-scanning)",
      untrackedFound !== null && !untrackedFound.includes("clean.json") && !untrackedFound.includes("pinned.md"),
    );

    const untrackedAttrs = checkAttrsBatch(fixtureRoot, ["untracked-bad.json", "untracked-good.json"]);
    const badAttr = untrackedAttrs.get("untracked-bad.json") || {};
    const goodAttr = untrackedAttrs.get("untracked-good.json") || {};
    const badPolicy = expectedPolicy(badAttr.eol, badAttr.text, true);
    const goodPolicy = expectedPolicy(goodAttr.eol, goodAttr.text, true);
    check(
      "(fixture) `git check-attr` resolves .gitattributes for an untracked path too (no tracked-status requirement)",
      badPolicy === "crlf" && goodPolicy === "crlf",
    );

    const badBuf = fs.readFileSync(path.join(fixtureRoot, "untracked-bad.json"));
    const goodBuf = fs.readFileSync(path.join(fixtureRoot, "untracked-good.json"));
    check(
      "(fixture) RED PROOF: the never-added bare-LF file evaluates as a real violation once scanned (this is the fix, not just visibility)",
      evaluate(badBuf, badPolicy).ok === false,
    );
    check(
      "(fixture) DoD-3(b) NEGATIVE CONTROL: the never-added but CORRECT file does NOT spuriously fail",
      evaluate(goodBuf, goodPolicy).ok === true,
    );

    check(
      "(fixture) DoD-3(c): the tracked-file walk stays byte-identical — still finds exactly .gitattributes + clean.json + pinned.md, unaffected by the two new untracked files",
      listTrackedFiles(fixtureRoot).sort().join(",") === [".gitattributes", "clean.json", "pinned.md"].sort().join(","),
    );

    // Card c3e70c20 (manager review, 2026-09-01) — THIRD POLARITY: `--exclude-standard` honours
    // `.gitignore`, which is exactly what makes it the right primitive here — a legitimately ignored file
    // (build output, `dist/`, `node_modules`) must NEVER be swept into the population just because it's
    // untracked, even if its raw bytes would otherwise violate the policy. Without this polarity the guard
    // would be unusable in a real tree (every stray ignored artifact could fail it). This is NOT redundant
    // with the RED/negative-control pair above: those prove the guard SEES and correctly EVALUATES a real
    // untracked file; this proves it correctly EXCLUDES one that was never meant to be seen at all.
    fs.writeFileSync(path.join(fixtureRoot, ".gitignore"), "ignored-*.json\n");
    fs.writeFileSync(path.join(fixtureRoot, "ignored-bad.json"), '{\n  "ignored": true\n}\n'); // bare LF — would violate crlf IF it entered the scan
    const untrackedAfterIgnore = listUntrackedFiles(fixtureRoot);
    check(
      "(fixture) IGNORED-FILE POLARITY: a .gitignore-matched file is NOT swept into the untracked population, even though its own content would otherwise violate the policy",
      untrackedAfterIgnore !== null && !untrackedAfterIgnore.includes("ignored-bad.json"),
    );
    check(
      "(fixture) sanity: excluding the ignored file didn't also hide the two genuinely-untracked files from the same scan",
      untrackedAfterIgnore !== null && untrackedAfterIgnore.includes("untracked-bad.json") && untrackedAfterIgnore.includes("untracked-good.json"),
    );

    // Card d854889d — REGRESSION FOR THE NESTED-UNTRACKED-DIRECTORY CASE this card investigated. The
    // real incident (`native/win-job-launcher/launcher.cs`, alone inside a brand-new untracked directory)
    // and this file's own header both explain why the hypothesized cause (a `git status`-style collapse
    // of a new directory to one `?? dir/` entry) does not apply here: `listUntrackedFiles` never reads
    // `git status`. This block proves a brand-new, TWO-level-deep untracked directory is fully recursed
    // by the real enumerator — both an ordinary-extension (`.ts`) file AND the real incident's `.cs` file
    // in the SAME directory are enumerated individually, never collapsed to one directory-level entry —
    // so directory depth/newness was never the blind spot, and (with the extension allowlist now removed
    // entirely, `@decision d854889d`) neither file depends on its own extension being recognized.
    const nestedDir = path.join(fixtureRoot, "native", "win-job-launcher");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "bad.ts"), "const a=1;\nconst b=2;\n"); // bare LF, ordinary extension
    fs.writeFileSync(path.join(nestedDir, "launcher.cs"), "public class X {\n  // bare lf\n}\n"); // bare LF, the real incident's file
    const nestedUntracked = listUntrackedFiles(fixtureRoot);
    check(
      "(fixture) NESTED-DIR RECURSION: a brand-new, 2-level-deep untracked directory is fully recursed — the .ts sibling is enumerated individually, never collapsed to one directory-level entry",
      nestedUntracked !== null && nestedUntracked.includes("native/win-job-launcher/bad.ts"),
    );
    check(
      "(fixture) card d854889d FIX PROOF: the nested .cs file (the real incident's exact file+shape) is enumerated too — with no extension allowlist left to exclude it",
      nestedUntracked !== null && nestedUntracked.includes("native/win-job-launcher/launcher.cs"),
    );
    const nestedTsBuf = fs.readFileSync(path.join(nestedDir, "bad.ts"));
    const nestedCsBuf = fs.readFileSync(path.join(nestedDir, "launcher.cs"));
    const nestedAttrs = checkAttrsBatch(fixtureRoot, ["native/win-job-launcher/bad.ts", "native/win-job-launcher/launcher.cs"]);
    const nestedTsPolicy = expectedPolicy((nestedAttrs.get("native/win-job-launcher/bad.ts") || {}).eol, (nestedAttrs.get("native/win-job-launcher/bad.ts") || {}).text, true);
    const nestedCsPolicy = expectedPolicy((nestedAttrs.get("native/win-job-launcher/launcher.cs") || {}).eol, (nestedAttrs.get("native/win-job-launcher/launcher.cs") || {}).text, true);
    check(
      "(fixture) the nested .ts file's own bare-LF bytes evaluate as a real violation against its resolved crlf policy",
      evaluate(nestedTsBuf, nestedTsPolicy).ok === false,
    );
    check(
      "(fixture) the nested .cs file's own bare-LF bytes evaluate as a real violation too, once it reaches evaluate() at all",
      evaluate(nestedCsBuf, nestedCsPolicy).ok === false,
    );

    // Card d854889d — THE DEEPER DEFECT, DIRECTLY: a DOTFILE (no extension at all — `path.extname`
    // returns `""` for it) could never have been matched by ANY extension allowlist, no matter how many
    // entries it carried (`.gitignore`/`.gitattributes`/`.npmrc` are exactly this shape in the real repo —
    // see `@decision d854889d`). Proves the fix closes that whole class, not just `.cs`.
    fs.writeFileSync(path.join(fixtureRoot, ".customrc"), "setting=1\nother=2\n"); // bare LF, a dotfile with NO extension
    const dotfileUntracked = listUntrackedFiles(fixtureRoot);
    check(
      "(fixture) DOTFILE PROOF: an extensionless dotfile is enumerated with no extension filter in the way (path.extname(\".customrc\") === \"\" — no allowlist entry could ever have matched it)",
      dotfileUntracked !== null && dotfileUntracked.includes(".customrc") && path.extname(".customrc") === "",
    );
    const dotfileAttr = checkAttrsBatch(fixtureRoot, [".customrc"]).get(".customrc") || {};
    const dotfilePolicy = expectedPolicy(dotfileAttr.eol, dotfileAttr.text, true);
    const dotfileBuf = fs.readFileSync(path.join(fixtureRoot, ".customrc"));
    check(
      "(fixture) the dotfile's own bare-LF bytes evaluate as a real violation once it reaches evaluate() at all",
      evaluate(dotfileBuf, dotfilePolicy).ok === false,
    );
  } finally {
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (err) { console.error(`[tmp] retained for backstop: ${fixtureRoot} — ${err}`); }
    if (!fs.existsSync(fixtureRoot)) unregister(fixtureRoot);
  }
}

// =====================================================================================================
// (A-2) UNIT-LEVEL CONTROL FOR `containsNul` (card `eda83035`). Card `d854889d` removed the extension
// allowlist that used to keep every real tracked binary (image assets) OUT of section (B)'s population
// entirely — so unlike when this control was first written, section (B) below NOW exercises `containsNul`
// returning true against real files too (the repo's tracked PNGs). This unit-level control stays anyway:
// it is the only place that proves the NEGATIVE polarity (an ordinary buffer with no NUL) directly,
// which section (B) never asserts on its own (an absence of a skip isn't logged as a dedicated check).
// =====================================================================================================
{
  const withNul = Buffer.from("line one\n\x00line two\n", "latin1");
  const withoutNul = Buffer.from("line one\nline two\n", "latin1");
  check("(unit) containsNul detects a real embedded NUL byte", containsNul(withNul) === true);
  check("(unit) containsNul negative control: an ordinary buffer with no NUL returns false", containsNul(withoutNul) === false);
}

// =====================================================================================================
// (B) THE REAL BACKSTOP — every tracked AND untracked-but-present path in this repo, scanned live off
// disk. Card `d854889d`: no extension filter — see `@decision d854889d` in this file's header.
// =====================================================================================================
{
  let scan = scanEolViolations(repoRoot);
  if (FIX_MODE && scan.violations.length) {
    const { changed, skipped } = fixViolations(repoRoot, scan.violations);
    for (const c of changed) console.log(`  FIXED  ${c.file}  -> all-${c.policy} (was CRLF=${c.crlf} bareLF=${c.bareLf})${c.tracked ? "" : "  [untracked]"}`);
    for (const s of skipped) console.log(`  SKIPPED  ${s.file}  (${s.reason})`);
    console.log(`[working-tree-eol-guard --fix] rewrote ${changed.length} file(s); the git index was not touched (a staged copy needs no re-add: git stores the LF-normalised blob either way). Re-scanning...`);
    scan = scanEolViolations(repoRoot);
  }
  const { autocrlfTrue, files, untrackedFiles, scanTargets, violations, skippedBinary, lfPinnedCount, crlfPinnedCount } = scan;
  check(`sanity: the tracked-file walk found a non-trivial population (found ${files.length} file(s), no extension filter)`, files.length > 100);

  // Card c3e70c20 — the population-visibility fix itself: a never-`git add`ed file was previously
  // invisible to everything below. `null` means git failed (skip, don't fail an unrelated build over it
  // — same fail-safe posture as the sibling this reuses); `[]` means checked, genuinely none found.
  if (untrackedFiles === null) {
    console.log("[working-tree-eol-guard] could not enumerate untracked files (git ls-files --others failed) — skipping the untracked-visibility scan this run");
  } else {
    console.log(`[working-tree-eol-guard] population: ${untrackedFiles.length} untracked file(s) found alongside ${files.length} tracked (state the actual population, not just a bare "found 0")`);
  }
  check(`sanity: .gitattributes' real eol=lf pin(s) actually resolve to ≥1 tracked file (found ${lfPinnedCount}) — proves check-attr reads .gitattributes rather than defaulting`, lfPinnedCount > 0);
  check(`sanity: .gitattributes' real eol=crlf pin (install.ps1) resolves to ≥1 tracked file (found ${crlfPinnedCount})`, crlfPinnedCount > 0);

  // Card d854889d — GROUND-TRUTH CROSS-VALIDATION, replacing the old "no tracked file is ever binary"
  // assertion from card eda83035. That assertion was only ever true BECAUSE the extension allowlist kept
  // every real tracked binary (image assets) out of this population entirely — it was never a proof that
  // `containsNul` works against a real binary, only that the population never contained one. Now that the
  // allowlist is gone, this population DOES contain real binaries (this repo's tracked PNGs), so the
  // right assertion is no longer "zero binary skips" — it's "every binary skip this guard's own
  // `containsNul` replica makes is CONFIRMED by git's own `-text` resolution (`git ls-files --eol`), and
  // nothing git itself calls `-text` was missed" (see `resolveTrackedGitEolStates`'s own header for why `w/`
  // reads real on-disk bytes rather than the index, same staging-window-proof primitive this file's own
  // header already relies on). A mismatch either way means this guard's content-sniff replica has
  // diverged from git's real behavior — worth knowing about, not silently assumed away.
  const gitEolStates = resolveTrackedGitEolStates(repoRoot);
  const unconfirmedSkips = skippedBinary.filter((rel) => (gitEolStates.get(rel) || {}).w !== "-text");
  const trackedGitBinaryPaths = [...gitEolStates.entries()].filter(([, v]) => v.w === "-text").map(([k]) => k);
  const missedByOurSkip = trackedGitBinaryPaths.filter((rel) => !skippedBinary.includes(rel));
  console.log(`[working-tree-eol-guard] binary-by-content tracked file(s) this guard skipped: ${skippedBinary.length}${skippedBinary.length ? ` (${skippedBinary.join(", ")})` : ""}`);
  check(
    `card d854889d: every binary-by-content skip this guard made is confirmed binary by git's own ls-files --eol resolution (found ${unconfirmedSkips.length} unconfirmed: ${unconfirmedSkips.join(", ") || "none"})`,
    unconfirmedSkips.length === 0,
  );
  check(
    `card d854889d: nothing git itself resolves as binary (-text) among tracked files was missed by this guard's own skip (found ${missedByOurSkip.length} missed: ${missedByOurSkip.join(", ") || "none"})`,
    missedByOurSkip.length === 0,
  );

  if (violations.length) {
    for (const v of violations) console.log(`  EOL-MISMATCH${v.tracked ? "" : " (UNTRACKED — never added to git)"}  ${v.file}  expected all-${v.policy}, found CRLF=${v.crlf} bareLF=${v.bareLf}`);
    console.log(`  FIX: run this ONE command from the worktree root to rewrite exactly the files listed above to their expected line endings, then re-run the guard:\n       ${FIX_COMMAND}`);
  }
  check(
    `every tracked text file's WORKING-TREE bytes on disk, AND every untracked-but-present text file's (never added to git — see this file's header for why those are scanned too), match the line-ending policy .gitattributes + core.autocrlf(=${autocrlfTrue}) imply for it (found ${violations.length} violation(s) across ${scanTargets.length} file(s) scanned: ${files.length} tracked + ${(untrackedFiles || []).length} untracked)`,
    violations.length === 0,
  );
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the guard fires on a simulated flip in a real fixture repo, and every tracked AND untracked text file in this repo currently matches its implied line-ending policy."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
