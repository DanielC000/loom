import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 868e0135 — phase 4 of the option-shaped-ref hardening (after 65b2b002/7eac6366/abbda4f5),
// fixing the 6 sites `--end-of-options` reaches at the merge-base/ls-tree/log call sites those cards left
// unfixed. Real git, no claude/daemon. Run: 1) pnpm build, 2) node packages/daemon/test/bare-ref-positional-argv-fixes.mjs
//
// ⚠️ NOT ALL 6 SITES HAVE A FUNCTION-LEVEL RED/GREEN DEMONSTRATION — read this before assuming one is
// missing by oversight. Investigated and MEASURED (see docs/decisions/868e0135-*.md for the full
// reasoning): site 1 (mergeCommitBlocksLinearization) has a genuine silent-wrong-answer exploit, because
// it compares merge-base's OUTPUT against a variable (`p`) that is DIFFERENT from the exploited one
// (`mainRef`) — the single-commit-collapse trick (`merge-base <p> --independent` silently returns `p`
// itself) passes the `=== p` check undetected. Sites 4 and 5a compare merge-base's output against the
// SAME variable being exploited (`base`/`afterSha`), so the identical collapse trick returns a value that
// can never equal the literal flag string being injected — already fail-closed by that equality check
// alone, pre-fix AND post-fix, regardless of this card. Sites 2/3/6 (all ls-tree, with no trailing
// positional after the treeish in two of the three, and the third gated behind an EARLIER
// already-`--end-of-options`-protected diff call) can never succeed (exit 0) with an option-shaped
// treeish at all — ls-tree's own arity (it always needs a resolvable tree-ish) means every flag either
// needs more positionals than remain (a usage error) or leaves nothing for the tree-ish slot (also a
// usage error) — there is no flag that both consumes the treeish's slot AND still produces output.
// Site 5b (the log range) is gated behind 5a's own already-safe merge-base check: by the time the log
// call runs, `afterSha` has already been proven to literally equal a real resolved sha, so it can never
// be option-shaped there in practice.
//
// So for sites 2/3/4/5b/6, this file proves: (a) the git MECHANISM genuinely changes (SECTION 0, pure
// git, no Loom code — same shape as abbda4f5's own Section 0), (b) each real exported function, driven
// directly with an option-shaped value, is ALREADY fail-closed pre-fix (not a regression to close — a
// confirmation the fix doesn't change the safe outcome), and (c) each function is BYTE-IDENTICAL for a
// real, well-formed input, pre-fix and post-fix (the positive control proving no behavioral regression).
//
// SCOPE, round 2 (CR fc0a4ea9): the comprehensive sweep that followed this file's first version closed
// ~23 MORE call sites in packages/daemon/src/git/** (29 total), surfaced by building
// bare-ref-positional-argv-guard.mjs — see docs/decisions/868e0135-*.md for the per-file breakdown. This
// file does NOT individually drive each of those at the function level (several are private helpers with
// no public test seam, e.g. mainline-watch.ts's `collectLoomTipHits`/`authoredTipHits`); instead SECTION 0
// proves every DISTINCT argv shape those sites use on real git (0f: log + a spread of shas; 0g: log -g +
// a spread of refs; 0h: log<range><flags-after>, reordered; 0i/0j: a bare rev-parse `<sha>^{suffix}` —
// the one shape round 1 got WRONG, see 0i's own comment), and the guard's own corpus scan
// (bare-ref-positional-argv-guard.mjs) proves every one of the 29 real sites syntactically carries the
// proven-correct shape. Neither of those two proofs is a substitute for a true per-site function-level
// RED/GREEN; that would need either a much larger fixture matrix per function or new test-only seams on
// otherwise-private helpers, judged not worth it here given the shape-level + corpus-level coverage.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("baf-home-"); // temp SHORT LOOM_HOME, set BEFORE the dist import below
requireHermeticEnv();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worktreesUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "worktrees.js")).href;
const linUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "merge-linearization.js")).href;
const {
  fullTreeEntries, deriveOwnNonTipCommitSubjects, findLaterBranchSquash,
  computeEmitCompareGate, repoTreeReferencesInertPrefix, computeOwedLanding,
} = await import(worktreesUrl);
const { mergeCommitBlocksLinearization } = await import(linUrl);
const { simpleGit } = await import("simple-git");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=baf@loom -c user.name=baf";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

function newRepo(name) {
  const repo = mkdtempManaged(`loom-baf-${name}-`);
  execSync(`git init -q -b master && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION 0 — pure git mechanism, no Loom code. Covers every distinct argv SHAPE this card fixes.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = newRepo("mech");
    const older = git(repo, "rev-parse HEAD");
    execSync(`git ${GIT_ID} commit -q -m second --allow-empty`, { cwd: repo });
    const head = git(repo, "rev-parse HEAD");

    // (0a) merge-base <p> <exploit>: a SINGLE-COMMIT mode flag (--independent/--octopus) in the SECOND
    // slot silently returns the FIRST commit's own sha instead of failing — the site-1 exploit shape.
    const collapse = git(repo, `merge-base ${older} --independent`);
    check("(0a) MECHANISM: `merge-base <p> --independent` silently returns <p> itself (exit 0) instead " +
      "of failing — the exact collapse this card closes for site 1", collapse === older);
    let collapseGuardedFails = false;
    try { git(repo, `merge-base --end-of-options ${older} --independent`); } catch { collapseGuardedFails = true; }
    check("(0a) MECHANISM: `merge-base --end-of-options <p> --independent` FAILS LOUDLY instead of " +
      "silently collapsing", collapseGuardedFails);
    check("(0a) POSITIVE CONTROL: `merge-base --end-of-options <p> <q>` is byte-identical to the " +
      "unguarded call for two well-formed commits",
      git(repo, `merge-base --end-of-options ${older} ${head}`) === git(repo, `merge-base ${older} ${head}`));

    // (0b) merge-base <exploit> <realRef>: the SAME collapse flag in the FIRST slot ALSO succeeds, but —
    // unlike (0a) — every site in this card compares the output against the SAME exploited variable
    // (`base`/`afterSha`), so the collapse's own output (the second commit's sha) can never equal the
    // literal flag string being compared against — already fail-closed by construction, independent of
    // this fix. Documented here so the "why wasn't 4/5a exploitable" claim is a measured fact, not an
    // assertion.
    const collapseFirst = git(repo, `merge-base --independent ${head}`);
    check("(0b) MECHANISM: `merge-base --independent <q>` ALSO silently returns <q> itself (the shape " +
      "sites 4/5a's own `=== literalFlagString` comparison already defeats, with or without this fix)",
      collapseFirst === head);

    // (0c) ls-tree -d --name-only <ref> -- <paths...>: a RECOGNIZED ls-tree flag in ref's slot shifts the
    // first pathspec into the tree-ish slot (site 2's shape).
    fs.mkdirSync(path.join(repo, "packages", "daemon", "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "packages", "daemon", "src", "x.ts"), "x\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m add-src`, { cwd: repo });
    const headWithSrc = git(repo, "rev-parse HEAD");
    let shiftedThrew = false, shiftedMsg = "";
    try { git(repo, `ls-tree -d --name-only --abbrev -- packages/daemon/src`); } catch (e) { shiftedThrew = true; shiftedMsg = e.message; }
    check("(0c) MECHANISM: `ls-tree -d --name-only --abbrev -- packages/daemon/src` (unguarded) fails — " +
      "but via a CONFUSING shift (the pathspec itself becomes the mis-attributed tree-ish), not the " +
      "correct \"invalid object name --abbrev\"",
      shiftedThrew && /Not a valid object name packages\/daemon\/src/.test(shiftedMsg));
    let guardedThrew = false, guardedMsg = "";
    try { git(repo, `ls-tree -d --name-only --end-of-options --abbrev -- packages/daemon/src`); } catch (e) { guardedThrew = true; guardedMsg = e.message; }
    check("(0c) MECHANISM: guarded, the SAME call fails with the CORRECT attribution (\"--abbrev\" " +
      "itself is the invalid object, not a pathspec)", guardedThrew && /Not a valid object name --abbrev/.test(guardedMsg));
    check("(0c) POSITIVE CONTROL: guarded ls-tree with a well-formed ref is byte-identical to the " +
      "unguarded call",
      git(repo, `ls-tree -d --name-only --end-of-options ${headWithSrc} -- packages/daemon/src`) ===
      git(repo, `ls-tree -d --name-only ${headWithSrc} -- packages/daemon/src`));

    // (0d) ls-tree -r -z <ref> (nothing after ref) — site 3/6's shape. No recognized flag can BOTH
    // consume ref's slot AND still leave a tree-ish positional, so this is a usage error either way;
    // the fix changes the error's WORDING (and exit code) but not the fail-closed OUTCOME.
    let bareThrew = false;
    try { git(repo, `ls-tree -r -z --abbrev`); } catch { bareThrew = true; }
    check("(0d) MECHANISM: unguarded `ls-tree -r -z --abbrev` fails (usage error — no tree-ish left)", bareThrew);
    let bareGuardedThrew = false, bareGuardedMsg = "";
    try { git(repo, `ls-tree -r -z --end-of-options --abbrev`); } catch (e) { bareGuardedThrew = true; bareGuardedMsg = e.message; }
    check("(0d) MECHANISM: guarded, the SAME call fails with the correct attribution (\"--abbrev\" is the " +
      "invalid object, not a missing-argument usage error)", bareGuardedThrew && /Not a valid object name --abbrev/.test(bareGuardedMsg));
    check("(0d) POSITIVE CONTROL: guarded bare ls-tree is byte-identical to the unguarded call for a " +
      "well-formed ref",
      git(repo, `ls-tree -r -z --end-of-options ${headWithSrc}`) === git(repo, `ls-tree -r -z ${headWithSrc}`));

    // (0e) log <flags...> <range-ending-in-the-exploit> (site 5b's shape) — the range token is already
    // the LAST positional, so the fix is purely inserting --end-of-options immediately before it.
    execSync(`git ${GIT_ID} commit -q -m "Loom-Worker-Branch: baf" --allow-empty`, { cwd: repo });
    const withTrailer = git(repo, "rev-parse HEAD");
    const unguardedRange = git(repo, `log --fixed-strings --grep="Loom-Worker-Branch: baf" --format=%B%x1e ${headWithSrc}..${withTrailer}`);
    const guardedRange = git(repo, `log --fixed-strings --grep="Loom-Worker-Branch: baf" --format=%B%x1e --end-of-options ${headWithSrc}..${withTrailer}`);
    check("(0e) POSITIVE CONTROL: guarded log-range call is byte-identical to the unguarded call for a " +
      "well-formed range, and both find the real trailer commit",
      unguardedRange === guardedRange && /Loom-Worker-Branch: baf/.test(guardedRange));
    let rangeFailedUnguarded = false;
    try { git(repo, `log --fixed-strings --grep="Loom-Worker-Branch: baf" --format=%B%x1e --all..HEAD`); } catch { rangeFailedUnguarded = true; }
    let rangeFailedGuarded = false;
    try { git(repo, `log --fixed-strings --grep="Loom-Worker-Branch: baf" --format=%B%x1e --end-of-options --all..HEAD`); } catch { rangeFailedGuarded = true; }
    check("(0e) MECHANISM: an option-shaped afterSha (\"--all..HEAD\") already fails loud pre-fix (the " +
      "compound \"..\" token rarely matches a real flag) and still fails loud post-fix — not a " +
      "regression, a confirmed-unchanged fail-closed outcome for this one shape",
      rangeFailedUnguarded && rangeFailedGuarded);

    // Round 2 (CR fc0a4ea9) — additional argv SHAPES the comprehensive sweep's other ~23 sites rely on
    // (mainline-watch.ts's spread-of-shas/spread-of-refs calls, and every `${x}^{suffix}`-shaped rev-parse
    // site now that the round-1 compound-suffix MATCHER exemption was retracted as unsound). These sites
    // are not each individually driven at the function level (several are private helpers with no public
    // seam, e.g. mainline-watch.ts's `collectLoomTipHits`/`authoredTipHits`) — this file proves the ARGV
    // SHAPE on real git instead, and `bare-ref-positional-argv-guard.mjs`'s own corpus scan proves every
    // one of the 29 real call sites actually carries the proven-correct shape syntactically.
    // (0f) log <flags> --format=X <spread-of-shas> (mainline-watch.ts's authoredTipHits/collectLoomTipHits
    // shape) — the spread sits LAST, so the marker goes immediately before it, protecting every member.
    check("(0f) POSITIVE CONTROL: log --no-walk=unsorted --end-of-options <spread-of-shas> is byte-identical to the unguarded call",
      git(repo, `log --no-walk=unsorted --format=%H --end-of-options ${headWithSrc} ${older}`) ===
      git(repo, `log --no-walk=unsorted --format=%H ${headWithSrc} ${older}`));
    let spreadFailed = false;
    try { git(repo, `log --no-walk=unsorted --format=%H --end-of-options ${headWithSrc} --all`); } catch { spreadFailed = true; }
    check("(0f) MECHANISM: an option-shaped MEMBER of the spread (\"--all\") fails loud guarded", spreadFailed);

    // (0g) log -g --format=X <spread-of-refs> (authoredTipHits's own `-g` reflog shape) — same spread-last fix.
    check("(0g) POSITIVE CONTROL: log -g --end-of-options <spread-of-refs> is byte-identical to the unguarded call",
      git(repo, `log -g --max-count=5 --format=%H --end-of-options master`) ===
      git(repo, `log -g --max-count=5 --format=%H master`));
    let gSpreadFailed = false;
    try { git(repo, `log -g --max-count=5 --format=%H --end-of-options --all`); } catch { gSpreadFailed = true; }
    check("(0g) MECHANISM: an option-shaped ref (\"--all\") fails loud guarded", gSpreadFailed);

    // (0h) log <range> --format=X (range FIRST, batch-merge.ts's sortCandidatesByEarliestAuthorDate shape)
    // — MEASURED: the marker must go on the REORDERED call (--format moved before the now-last range), not
    // on the range in its natural first position (that would swallow --format exactly like abbda4f5 warns).
    check("(0h) POSITIVE CONTROL: log --format=X --end-of-options <range> (reordered) is byte-identical to the unguarded natural-order call",
      git(repo, `log --format=%aI --end-of-options ${older}..${headWithSrc}`) === git(repo, `log ${older}..${headWithSrc} --format=%aI`));
    let naiveOrderFailed = false;
    try { git(repo, `log --end-of-options ${older}..${headWithSrc} --format=%aI`); } catch { naiveOrderFailed = true; }
    check("(0h) MECHANISM: the NAIVE order (marker before the range, --format left after) fails — proves " +
      "the reorder is load-bearing, not cosmetic", naiveOrderFailed);

    // (0i)/(0j) rev-parse <sha>^{suffix} — THE CRITICAL FINDING this round caught before shipping: unlike
    // ls-tree/log, `--end-of-options` ALONE on a bare (no --verify) rev-parse CORRUPTS a WELL-FORMED
    // compound-suffixed value's own output (echoes "--end-of-options" as a spurious extra line) — the
    // round-1 guard would have accepted several sites with ONLY the marker and no --verify, which is
    // byte-UNIDENTICAL, not merely "also safe". `--verify` closes it, matching abbda4f5's own `<ref>`-alone
    // finding — this proves the COMPOUND-SUFFIX case needs the identical fix, not a simpler one.
    // NOTE: `^^` (not `^`) — the `git()` helper's execSync runs through cmd.exe by default on Windows,
    // which treats a single `^` as its OWN escape character and silently drops it; `^^` is what survives
    // cmd.exe's parsing to reach git as a literal single `^`. MEASURED directly against this exact helper.
    const corrupted = git(repo, `rev-parse --end-of-options ${headWithSrc}^^{tree}`);
    check("(0i) MECHANISM (the bug this round caught): `rev-parse --end-of-options <sha>^{tree}` ALONE " +
      "corrupts a WELL-FORMED value's output with a spurious extra line",
      corrupted.split("\n").length === 2 && corrupted.split("\n")[0] === "--end-of-options");
    check("(0j) FIX: `rev-parse --verify --end-of-options <sha>^{tree}` is byte-identical to the unguarded call",
      git(repo, `rev-parse --verify --end-of-options ${headWithSrc}^^{tree}`) === git(repo, `rev-parse ${headWithSrc}^^{tree}`));
    let compoundFailed = false;
    try { git(repo, `rev-parse --verify --end-of-options --all^^{tree}`); } catch { compoundFailed = true; }
    check("(0j) MECHANISM: an option-shaped compound value (\"--all^{tree}\") fails loud with --verify present", compoundFailed);

    // @decision 4b559feb — (0k) is REV-LIST ONLY; a combined range is immune there. Corrected: that does
    // NOT generalize to `diff` — (0k2) below is genuinely exploitable, marker IS load-bearing.
    let rangeUnguardedFailed = false;
    try { git(repo, `rev-list --count ${headWithSrc}..--all`); } catch { rangeUnguardedFailed = true; }
    let rangeGuardedFailed = false;
    try { git(repo, `rev-list --count --end-of-options ${headWithSrc}..--all`); } catch { rangeGuardedFailed = true; }
    check("(0k) MECHANISM (rev-list only): a combined range `<sha>..--all` ALREADY fails loud with NO " +
      "marker at all (git's ref-DWIM never resolves the embedded \"--all\" as the --all FLAG — only as a " +
      "literal ref name, which doesn't exist in this repo)", rangeUnguardedFailed);
    check("(0k) MECHANISM (rev-list only): the SAME call WITH the marker fails loud identically — the " +
      "marker changes nothing for this shape, for rev-list specifically", rangeGuardedFailed);

    // (0k2) For DIFF, the SAME combined-range shape IS genuinely exploitable on the LEFT side, via a
    // value-taking option matched by PREFIX (`--output=`/`-O`/`--src-prefix=`/`--dst-prefix=`) rather than
    // exact flag equality — it never needs the whole positional to resolve as a revision first. Found by
    // Code Review (session 858caa53) after the (0k) finding above was wrongly generalized from rev-list to
    // diff without separately re-measuring diff's own option surface.
    const scratchDir = mkdtempManaged("loom-baf-diffout-");
    const victimPath = path.join(scratchDir, "victim.txt");
    const victimTarget = `${victimPath}..master`; // the FULL text after "--output=" becomes the filename
    try {
      if (fs.existsSync(victimTarget)) fs.unlinkSync(victimTarget);
      execSync(`git diff --name-only "--output=${victimPath}..master"`, { cwd: repo }); // unguarded
      check("(0k2) MECHANISM: unguarded `diff --name-only --output=<path>..master` SILENTLY WRITES a " +
        "file literally named \"<path>..master\" to disk — a real, unprompted file-write side effect " +
        "from a caller-influenced range value never intended as a filesystem path",
        fs.existsSync(victimTarget));
    } finally {
      if (fs.existsSync(victimTarget)) fs.unlinkSync(victimTarget);
    }
    let diffOutputGuardedFailed = false;
    try {
      git(repo, `diff --name-only --end-of-options "--output=${victimPath}..master"`);
    } catch { diffOutputGuardedFailed = true; }
    check("(0k2) FIX: the SAME call WITH the marker fails loud instead, and writes NOTHING",
      diffOutputGuardedFailed && !fs.existsSync(victimTarget));
    fs.rmSync(scratchDir, { recursive: true, force: true });

    // (0l) A TRUE SEPARATE bare positional (not a combined range) — the real, closed vulnerability class
    // for rev-list: an unguarded option-shaped value IS silently reinterpreted as the real flag.
    const unguardedParents = execSync(`git rev-list --parents -n1 --all`, { cwd: repo }).toString();
    check("(0l) MECHANISM: `rev-list --parents -n1 --all` (unguarded, a bare SEPARATE positional) " +
      "SILENTLY SUCCEEDS, treating \"--all\" as the real --all flag instead of a literal (invalid) ref " +
      "name — exactly the dangerous misinterpretation this card closes",
      unguardedParents.trim().length > 0);
    let guardedParentsFailed = false;
    try { git(repo, `rev-list --parents -n1 --end-of-options --all`); } catch { guardedParentsFailed = true; }
    check("(0l) MECHANISM: guarded, the SAME call fails loud instead", guardedParentsFailed);
    check("(0l) POSITIVE CONTROL: guarded `rev-list --parents -n1 --end-of-options <sha>` is byte-" +
      "identical to the unguarded call for a well-formed sha",
      git(repo, `rev-list --parents -n1 --end-of-options ${headWithSrc}`) === git(repo, `rev-list --parents -n1 ${headWithSrc}`));

    // (0m) `rev-list ... <range> --not <ref>` — THE CARD'S OWN NAMED HARD CASE. `--not` must stay BEFORE
    // the marker (it is a real flag, not a value) — the marker goes right after `--not`, protecting only
    // the ref that follows it. Proves THREE things: the correct placement is byte-identical for a
    // well-formed ref; the correct placement fails loud for an option-shaped ref; and the NAIVE
    // placement (marker before the range, swallowing `--not` itself) silently corrupts a well-formed
    // call's own result — not just "also insecure", genuinely WRONG even with no attacker involved.
    execSync(`git checkout -q -b notmain`, { cwd: repo });
    fs.writeFileSync(path.join(repo, "nm.txt"), "nm\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m notmain-work`, { cwd: repo });
    const notmainTip = git(repo, "rev-parse HEAD");
    execSync(`git checkout -q master`, { cwd: repo });
    const wellFormedUnnotted = git(repo, `rev-list --reverse --no-merges ${headWithSrc}..${notmainTip}`);
    const wellFormedCorrect = git(repo, `rev-list --reverse --no-merges ${headWithSrc}..${notmainTip} --not --end-of-options ${headWithSrc}`);
    check("(0m) POSITIVE CONTROL: the CORRECT placement (marker right after --not) is byte-identical to " +
      "the unguarded call for a well-formed --not ref",
      wellFormedCorrect === wellFormedUnnotted);
    let notRefFailedCorrect = false;
    try { git(repo, `rev-list --reverse --no-merges ${headWithSrc}..${notmainTip} --not --end-of-options --all`); } catch { notRefFailedCorrect = true; }
    check("(0m) MECHANISM: the CORRECT placement fails loud for an option-shaped --not ref (\"--all\")", notRefFailedCorrect);
    // THE ACTUAL PRE-FIX VULNERABILITY: no marker at all. An option-shaped --not ref ("--all") is
    // silently reinterpreted as the real --all flag, which here wrongly excludes EVERY ref's own history
    // (including notmainTip's own commit) instead of failing — a SILENT WRONG (empty) result, not an error.
    const unprotectedNotAll = execSync(`git rev-list --reverse --no-merges ${headWithSrc}..${notmainTip} --not --all`, { cwd: repo }).toString();
    check("(0m) MECHANISM (the real pre-fix bug): with NO marker at all, `--not --all` silently succeeds " +
      "(exit 0) and wrongly returns EMPTY — \"--all\" excluded everything, including notmainTip's own " +
      "commit, instead of being rejected as an invalid literal ref name",
      unprotectedNotAll.trim() === "" && wellFormedUnnotted.trim() !== "");
    // MEASURED (corrects an initial prediction): the naive placement does not silently misbehave — it
    // outright FAILS, even for a perfectly well-formed, non-malicious call (`--not` is itself still
    // recognized by git's revision walker once past the marker, which then refuses it as "an option
    // after non-option arguments"). So the correct placement isn't just the secure one — it's the only
    // one that makes the well-formed, ordinary case work at all.
    let naivePlacementFailed = false;
    try { git(repo, `rev-list --reverse --no-merges --end-of-options ${headWithSrc}..${notmainTip} --not ${headWithSrc}`); } catch { naivePlacementFailed = true; }
    check("(0m) MECHANISM (the shape this card's own DoD warns against): the NAIVE placement (marker " +
      "BEFORE the range, so `--not` is reached only AFTER non-option content) fails outright even for " +
      "a well-formed, non-malicious call — proving the reorder is load-bearing for correctness, not " +
      "merely for security",
      naivePlacementFailed);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION 1 — mergeCommitBlocksLinearization (site 1): the ONE site with a genuine function-level
  // RED (pre-fix)/GREEN (post-fix) distinction. Build a real clean 2-parent merge commit whose second
  // parent is `other` and whose combined diff is empty (a clean union, no conflict-resolution content),
  // then call the exported function with mainRef="--independent" — pre-fix this silently computes
  // `onMain=true` (via the collapse in 0a above) and the merge commit is wrongly reported as NOT
  // blocking linearization; post-fix the merge-base call fails loud, onMain=false, and the function
  // correctly reports the block.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = newRepo("lin");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m base`, { cwd: repo });
    execSync(`git checkout -q -b otherline`, { cwd: repo });
    fs.writeFileSync(path.join(repo, "other.txt"), "other\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m other`, { cwd: repo });
    const other = git(repo, "rev-parse HEAD");
    execSync(`git checkout -q master`, { cwd: repo });
    fs.writeFileSync(path.join(repo, "mainfile.txt"), "mainfile\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m mainfile`, { cwd: repo });
    execSync(`git merge --no-ff -q -m merge-otherline otherline`, { cwd: repo });
    const mergeSha = git(repo, "rev-parse HEAD");

    check("(1) PRECONDITION: the merge commit's own diff-tree --cc is empty (a clean union, no " +
      "resolution content of its own)",
      git(repo, `diff-tree --cc --no-commit-id -p -r ${mergeSha}`) === "");
    check("(1) PRECONDITION: the merge commit's non-first parent is `other`",
      git(repo, `rev-list --parents -n1 ${mergeSha}`).trim().split(/\s+/)[2] === other);

    const handle = simpleGit(repo);
    const exploited = await mergeCommitBlocksLinearization(handle, mergeSha, "--independent", 15000);
    check("(1) FIX: mergeCommitBlocksLinearization(mergeSha, mainRef=\"--independent\") reports the " +
      "merge as BLOCKING linearization (a reason string, not undefined) — FAILS pre-fix: the collapse " +
      "trick silently computes onMain=true and this returns undefined instead, wrongly letting the " +
      "merge commit's parent be treated as reachable from a \"main\" that was never actually checked",
      typeof exploited === "string" && /not reachable from main/.test(exploited));

    const legit = await mergeCommitBlocksLinearization(handle, mergeSha, "master", 15000);
    check("(1) POSITIVE CONTROL: mergeCommitBlocksLinearization(mergeSha, mainRef=\"master\") correctly " +
      "reports undefined (not blocking) — `other` genuinely IS reachable from the real master " +
      "(it's master's own merged-in branch)", legit === undefined);

    const stillBlocked = await mergeCommitBlocksLinearization(handle, mergeSha, git(repo, "rev-parse master~2"), 15000);
    check("(1) POSITIVE CONTROL: mergeCommitBlocksLinearization(mergeSha, mainRef=<an ancestor that does " +
      "NOT include otherline>) correctly reports BLOCKING (genuinely not reachable, no exploit involved)",
      typeof stillBlocked === "string" && /not reachable from main/.test(stillBlocked));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION 2 — computeEmitCompareGate (site 2). `ref` feeds BOTH the already-`--end-of-options`-guarded
  // `diff --name-status` call (65b2b002) AND this card's `ls-tree` call — so an option-shaped `ref` is
  // caught at the EARLIER call and can never reach the ls-tree line at all, in production or in a direct
  // test. Confirmed below, then a real well-formed run is proven byte-identical.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = newRepo("emit");
    fs.writeFileSync(path.join(repo, "NOTES.md"), "n1\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m notes`, { cwd: repo });
    const baseSha = git(repo, "rev-parse HEAD~1");
    const headSha = git(repo, "rev-parse HEAD");

    const exploited = await computeEmitCompareGate(repo, baseSha, "--independent", {});
    check("(2) ALREADY SAFE (not a regression to close): computeEmitCompareGate(ref=\"--independent\") " +
      "fails closed via the EARLIER diff --name-status call (65b2b002's own fix), never reaching this " +
      "card's ls-tree line at all — notApplicable + git-operation-failed, same pre-fix and post-fix",
      exploited.notApplicable === true && exploited.notApplicableKind === "git-operation-failed");

    const legit = await computeEmitCompareGate(repo, baseSha, headSha, {});
    check("(2) POSITIVE CONTROL: computeEmitCompareGate with a real baseSha/ref reaches a real verdict " +
      "(NOTES.md is out of every EMIT_COMPARE scope, so this repo — with no packages/daemon/{src,test," +
      "assets,scripts} tree at all — correctly classifies repo-out-of-domain)",
      legit.notApplicable === true && legit.notApplicableKind === "repo-out-of-domain");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION 3 — fullTreeEntries (site 3)
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = newRepo("fte");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m a`, { cwd: repo });
    const headSha = git(repo, "rev-parse HEAD");

    const exploited = await fullTreeEntries(repo, "--independent", {});
    check("(3) ALREADY SAFE (not a regression to close): fullTreeEntries(ref=\"--independent\") returns " +
      "null (fail-closed) — this shape has no recognized ls-tree flag that both consumes ref's slot " +
      "AND leaves a tree-ish positional, so it was always a usage error either way",
      exploited === null);

    const legit = await fullTreeEntries(repo, headSha, {});
    check("(3) POSITIVE CONTROL: fullTreeEntries(ref=<real sha>) returns the real tree map, unaffected",
      legit instanceof Map && legit.has("a.txt"));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION 4 — deriveOwnNonTipCommitSubjects (site 4)
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = newRepo("dts");
    execSync(`git checkout -q -b feat`, { cwd: repo });
    fs.writeFileSync(path.join(repo, "f1.txt"), "1\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "feat: first"`, { cwd: repo });
    fs.writeFileSync(path.join(repo, "f2.txt"), "2\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "feat: second"`, { cwd: repo });
    fs.writeFileSync(path.join(repo, "f3.txt"), "3\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "feat: tip"`, { cwd: repo });
    execSync(`git checkout -q master`, { cwd: repo }); // the real caller's HEAD is the canonical repo's main, never the worker branch itself

    const exploited = await deriveOwnNonTipCommitSubjects(repo, "feat", "--independent", {});
    check("(4) ALREADY SAFE (not a regression to close): deriveOwnNonTipCommitSubjects(base=" +
      "\"--independent\") returns undefined both pre-fix (the collapse makes mergeBase equal the " +
      "branch's own tip, so the log range is empty) and post-fix (the merge-base call itself throws) " +
      "— the `base`-vs-`refs/heads/<branch>` comparison target differs from site 1's shape, which is " +
      "exactly why it was never exploitable the same way",
      exploited === undefined);

    const legit = await deriveOwnNonTipCommitSubjects(repo, "feat", "HEAD", {});
    check("(4) POSITIVE CONTROL: deriveOwnNonTipCommitSubjects(base=\"HEAD\", the real production value) " +
      "still finds the real non-tip subjects",
      legit && legit.subjects.some((s) => /feat: first/.test(s)) && legit.subjects.some((s) => /feat: second/.test(s)));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION 5 — findLaterBranchSquash (sites 5a + 5b)
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = newRepo("flbs");
    const landedSha = git(repo, "rev-parse HEAD"); // a commit BEFORE any trailer squash — the retain's own recorded landedSha
    execSync(`git ${GIT_ID} commit -q -m "chore: squash" --allow-empty --trailer "Loom-Worker-Branch: baf-branch"`, { cwd: repo });
    const squashSha = git(repo, "rev-parse HEAD"); // the later squash carrying the trailer, strictly after landedSha

    const exploited = await findLaterBranchSquash(repo, "baf-branch", "--independent", {});
    check("(5) ALREADY SAFE (not a regression to close): findLaterBranchSquash(afterSha=\"--independent\") " +
      "returns \"error\" both pre-fix (the collapse makes `mb` equal HEAD's own sha, which can never " +
      "equal the literal string \"--independent\", so the `mb !== afterSha` check already refuses) and " +
      "post-fix (the merge-base call itself throws)",
      exploited === "error");

    const legit = await findLaterBranchSquash(repo, "baf-branch", landedSha, {});
    check("(5) POSITIVE CONTROL: findLaterBranchSquash(afterSha=<a commit BEFORE the real trailer " +
      "squash>) still finds the real later trailer commit (\"found\")", legit === "found");

    const noneYet = await findLaterBranchSquash(repo, "baf-branch", squashSha, {});
    check("(5) POSITIVE CONTROL: findLaterBranchSquash(afterSha=<the trailer squash itself>, nothing " +
      "landed since) correctly reports \"none\"", noneYet === "none");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION 6 — repoTreeReferencesInertPrefix / repoTreeHasJsTsSourceFile (site 6, the ls-tree-via-spawn
  // call not named in the card, same shape/proof standard as site 3).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = newRepo("jsts");
    fs.mkdirSync(path.join(repo, "packages", "daemon", "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "packages", "daemon", "src", "x.ts"), "export const x = 1;\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m add-src`, { cwd: repo });
    const headSha = git(repo, "rev-parse HEAD");

    const exploited = await repoTreeReferencesInertPrefix(repo, "--independent", "docs", 15000);
    check("(6) ALREADY SAFE (not a regression to close): repoTreeReferencesInertPrefix(treeish=" +
      "\"--independent\") returns true (fail-closed: \"applicable:false\" from the inner ls-tree spawn, " +
      "same shape as site 3 — no recognized ls-tree flag leaves a tree-ish positional) — unchanged by " +
      "this fix, which only changes the exit code/message, not the fail-closed outcome",
      exploited === true);

    const legit = await repoTreeReferencesInertPrefix(repo, headSha, "docs", 15000);
    check("(6) POSITIVE CONTROL: repoTreeReferencesInertPrefix(treeish=<real sha>, \"docs\") correctly " +
      "reports false — this repo's own real JS/TS corpus (packages/daemon/src/x.ts) never reads a " +
      "\"docs\" prefix", legit === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION 7 (card 4b559feb) — computeOwedLanding, the ONE real exported function whose own argv
  // carries the `--not <main>` shape. Drives the real function directly (not just the pure-git mechanism
  // in Section 0's 0k/0l/0m) against real git, both for a well-formed `main` and a malicious one.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = newRepo("owed");
    const base = git(repo, "rev-parse HEAD"); // owedBase: before the branch diverges
    execSync(`git checkout -q -b heldbranch`, { cwd: repo });
    fs.writeFileSync(path.join(repo, "h1.txt"), "h1\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "held work"`, { cwd: repo });
    const tip = git(repo, "rev-parse HEAD"); // the HELD branch's own tip — ahead of main
    execSync(`git checkout -q master`, { cwd: repo }); // main stays at `base`

    const handle2 = simpleGit(repo);
    const raw = (args) => handle2.raw(args);

    const legitLanding = await computeOwedLanding(raw, base, tip, base, 15000);
    check("(7) POSITIVE CONTROL: computeOwedLanding(base, tip, main=<the real main, well-formed>) " +
      "correctly reports the one owed commit",
      legitLanding.ok === true && legitLanding.commits.length === 1 && legitLanding.commits[0].sha === tip);

    let maliciousRejected = false, maliciousMsg = "";
    try { await computeOwedLanding(raw, base, tip, "--all", 15000); } catch (e) { maliciousRejected = true; maliciousMsg = e.message; }
    check("(7) FIX: computeOwedLanding(base, tip, main=\"--all\") REJECTS (fails loud) instead of " +
      "silently treating \"--all\" as the real flag and computing a wrong owed-commit set — the exact " +
      "real-function proof of the 0m mechanism above",
      maliciousRejected && /revision|option|argument/i.test(maliciousMsg));
  }
} finally {
  // mkdtempManaged's own exit hooks are the real backstop; this just lets a solo run print success/failure
  // without waiting for process exit to confirm cleanup actually happened.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every merge-base/ls-tree/log/rev-list/diff site 868e0135/4b559feb touches behaves " +
    "correctly for both a well-formed and an option-shaped base/ref/branch."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
