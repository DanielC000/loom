import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure git+fs
// DIFF-SCOPED PRESENCE GUARD (card 5e51e778, building on the approved argument at
// docs/investigations/df88c1b2-fixed-wait-precondition/recommendation.md) — requires a WITNESS on any
// NEWLY-ADDED raw-fixed-wait-adjacent-to-check() site, on BOTH polarities, without ever classifying
// whether the site is actually safe.
//
// WHY THIS IS A DIFFERENT SHAPE FROM fixed-wait-negative-guard.mjs (that file is UNTOUCHED, still doing
// its own narrow negative-polarity corpus job — see its own header): that guard scans the WHOLE corpus
// against a hand-maintained baseline. This one scans ONLY lines a diff ADDS, against the merge-base with
// the project's mainline branch — so it never needs a baseline and never reaches the ~240 pre-existing
// sites this project decided (df88c1b2, DoD-3) to leave alone: the check structurally cannot see them.
// docs/investigations/e3faa8ac-fixed-wait-polarity/findings.md measured why a corpus-wide classifier (on
// either polarity) is the wrong instrument — a 62%-of-TIER-2 prose-match false-positive rate that two
// rounds of tightening did not close — so this gate demands the ARTIFACT of a judgement (a `sleepPast`
// call, a companion precondition `check()`, or an explicit exemption comment) instead of a verdict on
// whether the site is safe. See project memory `shipping-a-detector-is-not-someone-reading-it`: a
// BLOCKING precondition on the action, not an advisory, is the only shape of this kind that's held.
//
// WHAT COUNTS AS "ADDED": lines under `packages/daemon/test/*.mjs` (top-level only, same glob the card
// specifies — not a recursive walk) that are new on this branch relative to its merge-base with the
// project's mainline. Computed via `diffBranch` (git/worktrees.ts) — the SAME line-diffing mechanism the
// merge-review diffstat already uses — not a second, hand-rolled git-diff implementation. This core scan
// is diff-scoped against COMMITTED `HEAD`, deliberately — it mirrors the merge-review diffstat's own
// scope, which is a feature (see `main` below). That scope has a real blind spot, though: anything not
// yet committed is invisible to it. Two supplementary, population-visibility checks close that gap
// without touching the core scan's scope — `listUntrackedTestFiles` (card `40643460`) names a never-
// `git add`ed file it can't see, and `scanModifiedTrackedTestFiles` (card `21e12d47`) directly scans a
// tracked file's staged-and/or-unstaged uncommitted changes for a real violation. Both run every time
// this guard does; see their own doc comments below for why they're shaped differently from each other.
//
// WHAT COUNTS AS A CANDIDATE: an added line matching a fixed-wait idiom (raw `sleep(...)`, a raw
// `new Promise(r => setTimeout(r, ...))`, OR a `windowMs:` config key — the last one closes `0f744aa4`'s
// gap: `observeOnce`/`assertNeverWithControl`'s windowMs-sampling fallback is a fixed-duration wait too,
// even though it never spells `sleep(` at the call site, and a gate that only regexed for `sleep(`/
// `setTimeout(` verbatim would reproduce that exact blindness on day one) — immediately followed, within
// the SAME blank-line-delimited block (the refined boundary `e3faa8ac` validated — not a fixed line
// radius, which was measured to bleed into an adjacent unrelated test case), by at least one
// check()/assert() call. Comment-only lines are skipped BEFORE idiom-matching (by construction, not by a
// second pass) — `743be0c9`'s bug class (scanning comment text as code) cannot occur here because a line
// that doesn't survive `isWaitIdiomLine`'s comment check never becomes a candidate in the first place.
//
// WHAT CLEARS A CANDIDATE (presence, never a verdict — see the recommendation doc's "Honest limitation"):
//   (a) it's a `sleepPast(...)` call — the runtime throw in `_wait.mjs` IS the proof. It never even
//       becomes a candidate: `SLEEP_PAST_RE` excludes it in `isWaitIdiomLine` explicitly and by name
//       (not merely because "sleepPast(" happens not to match `\bsleep\(` — that's true too, but the
//       named exclusion is what makes the mechanism legible to a reader rather than incidental).
//   (b) the block contains `positiveControl` (object key or call) ANYWHERE — this is already `1addef27`'s
//       proven mechanism (`assertNeverWithControl` REFUSES to run without a positiveControl that itself
//       must observe a real violation), so a `windowMs`-based site already wrapped in it is already
//       runtime-proven and would otherwise be a pure false positive of this gate's own `windowMs` idiom.
//   (c) at least one check()/assert() after the wait line has a label containing the word
//       "precondition" — the companion-precondition shape `003a1080`'s real fix used, MARKED, not merely
//       counted. (Code review finding, manager-decided: a bare "≥2 check()/assert() calls follow" is not
//       an artifact of judgement — it's ordinary test shape. The reviewer defeated it by appending one
//       unrelated assertion to the verbatim pre-fix `81a6e4e1` block: 2 hits, 0 cleared → 0 hits, 2
//       cleared, on the exact incident this card was built to catch. Requiring the literal word restores
//       the property: an author must deliberately WRITE it, which is attested by `003a1080`'s own fix —
//       `check("(onSurfacedPending repeat) precondition: both calls degraded to pending…", …)` — not
//       invented for this gate.)
//   (d) a `TIMING-GUARD-SAFE:`/`TIMING-GUARD-FALSE-MATCH:` comment (same convention `fixed-wait-negative-
//       guard.mjs` already uses in production — reused here, not reinvented) anywhere in the contiguous
//       comment block immediately above the wait line, or on the wait line itself. Unlike that guard,
//       this one does not restrict the reason to a closed enum — the claim being forced here is just "a
//       human looked at this", not "this fits one of N known-audited shapes", so any non-empty reason is
//       accepted. This is the gameable half, named honestly in the recommendation doc: it is a forced,
//       reviewable artifact at the point a reviewer is already looking, not proof of safety.
// A candidate with ZERO check()/assert() calls after it in the block is not reported at all — that is
// the ordinary settle/pacing-sleep shape this file's own header (`_wait.mjs`) already says most sleeps
// in this suite are, and is out of scope by design (same as the existing guard's own idiom).
//
// FAIL-SAFE ON GIT RESOLUTION FAILURE (deliberately, not a gap): if the mainline branch or the diff
// itself can't be resolved (a shallow/no-origin checkout — GitHub CI's default `actions/checkout` has
// none of Loom's own worktree history), this prints a loud, visible note and passes with zero hits
// rather than failing an unrelated build over an infra hiccup. Loom's own internal worktrees (this gate's
// actual target — see the card) always share the canonical repo's `.git`, so `origin/HEAD` and the local
// mainline branch are always resolvable there; this fallback only ever fires off that path.
//
// Card 5df7bcee — THE NUL-BEARING-FILE ASSERTION (`listNulBearingTestFiles`, called from `main` below):
// a file whose CURRENT content carries a raw NUL byte is content-sniffed as binary by git, which means
// its diff registers with an EMPTY added-line set (see `parseAddedLineNumbers`'s own header on the
// `71231839` binary-header fix) — this guard then has no line info to scan it with. The SAME file is
// ALSO skipped by `working-tree-eol-guard.mjs`, by explicit, good-reason design (see that guard's own
// header) — so a NUL-bearing file inside this guard's scan population was silently unscanned by BOTH
// guards, with neither announcing it (disclosed at merge, not discovered later — see card `5df7bcee`).
// Rather than try to scan such a file's content (structurally impossible from a diff that conveys zero
// line-level information), `listNulBearingTestFiles` asserts the PRECONDITION never holds at all: no
// file currently matching `TEST_GLOB` may carry a raw NUL byte, full stop. This is checked against
// on-disk state, not a diff, so a transition commit that REMOVES a NUL (like `71231839`'s own fix) is
// unaffected — by the time this runs, that file's current content has no NUL and this check stays
// silent; only a file that STILL or NEWLY carries one fails, pointing its author at the same escaped
// `\x00` pattern `71231839` already established as this project's way of representing that byte in a
// test fixture without tripping git's content-sniffing. `working-tree-eol-guard.mjs`'s own NUL-skip is
// deliberately left untouched (card `223cb2df` — widening it adds false rejections on a harmless state
// AND still misses the real thing); this assertion closes the gap at its source instead, for the one
// directory both guards actually share.
//
// Run: node packages/daemon/test/fixed-wait-witness-guard.mjs (needs a build — imports dist/git/worktrees.js)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEST_GLOB = "packages/daemon/test/*.mjs";
const TEST_DIR = path.join(REPO_ROOT, "packages", "daemon", "test");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ── Idiom detection ─────────────────────────────────────────────────────────────────────────────────
// Deliberately NEW regex constants, not a copy of fixed-wait-negative-guard.mjs's IDIOM_A/IDIOM_B (card
// 5e51e778 DoD-4 forbids copying them verbatim — doing so would inherit `0f744aa4`'s blindness here too).
const IDIOM_SLEEP = /\bsleep\(\s*[^)]+\)/;
const IDIOM_SETTIMEOUT = /new Promise\(\s*\(?\s*[a-zA-Z_$][\w$]*\s*\)?\s*=>\s*setTimeout\(\s*[a-zA-Z_$][\w$]*\s*,\s*[^)]+\)/;
// Closes 0f744aa4's gap: observeOnce's `windowMs` sampling fallback (_timing-guard.mjs) is a fixed wait
// even though it never spells sleep(/setTimeout( at the call site. `waitUntil`/`pollUntil`/`deferred`/
// `settle` are deliberately NOT matched here — they're the condition-driven/hand-resolved SAFE
// replacements this project's own _wait.mjs header exists to push people toward, not a fixed-duration
// idiom at all; flagging them would be exactly backwards.
const IDIOM_WINDOWMS = /\bwindowMs\s*:/;
// Card 4bd5c5a4 — measured, REAL false-positive collision (found while widening the SIBLING guard,
// fixed-wait-negative-guard.mjs, card 0f744aa4): `windowMs` is NOT unique to the timing-guard idiom.
// Loom's own PlatformConfig carries an unrelated `remoteAccess.rateLimit.authFailLockout.windowMs` (a
// rate-limiter lockout window), and two real test files (platform-forensics-reads.mjs, remote-bind.mjs)
// pass that literal config shape as test DATA, with genuinely negative-polarity check()/assert() calls
// elsewhere in the same block — 6 false hits across those 2 files on the sibling guard. `0f744aa4` fixed
// it there by requiring a `windowMs`-idiom candidate's block to also name the ONE primitive that actually
// consumes a `windowMs` sampling config (`_timing-guard.mjs`'s `observeOnce`/`assertNeverWithControl`)
// before it counts as a candidate at all — an unrelated data literal never does. Deliberately the SAME
// regex as that guard's own `TIMING_GUARD_CALL_RE`, ported rather than reinvented (shared-unit divergence
// between the two sibling guards is a recurring anti-pattern in this repo).
const TIMING_GUARD_CALL_RE = /\b(?:observeOnce|assertNeverWithControl)\s*\(/;
// A `sleepPast(` call never matches IDIOM_SLEEP (no "(" immediately after "sleep") — this is belt-and-
// suspenders documentation of that fact, not a second mechanism: see witness (a) in the header above.
const SLEEP_PAST_RE = /\bsleepPast\(/;
const POSITIVE_CONTROL_RE = /\bpositiveControl\s*[:(]/;
const EXEMPT_RE = /TIMING-GUARD-SAFE:\s*(.+)/;
const FALSE_MATCH_RE = /TIMING-GUARD-FALSE-MATCH:\s*(.+)/;
// Same shape as fixed-wait-negative-guard.mjs's own CHECK_OR_ASSERT_RE (matchAll, not a first-match-only
// `.match()` — card a14717af's fix for that exact under-report class applies here too).
const CHECK_OR_ASSERT_RE = /(?:check|assert)\(\s*(["'`])((?:(?!\1).)*)\1/g;
// Code review finding (blocking): a companion precondition must be MARKED, not merely counted — see the
// witness (c) note in the header above.
const PRECONDITION_TOKEN_RE = /\bprecondition\b/i;

/** True iff `line` is a `//` line comment, a JSDoc/block-comment CONTINUATION line (` * ...`, not a bare
 *  `*/` close), or a self-contained one-line block comment (`/** ... *\/` entirely on one line). This is
 *  the single-line-detectable half of comment exclusion; `computeBlockCommentLines` below is the
 *  file-level half (a block comment whose open/close span multiple lines with no per-line `*` prefix). */
function isCommentOnlyLine(line) {
  if (/^\s*\/\//.test(line)) return true;
  if (/^\s*\*(?!\/)/.test(line)) return true;
  if (/^\s*\/\*.*\*\/\s*$/.test(line)) return true;
  return false;
}

/** True iff `line` is a candidate fixed-wait line: not a comment-only line (skips 743be0c9's bug class
 *  BY CONSTRUCTION — a comment line never reaches the idiom test at all), not a `sleepPast(...)` call
 *  (witness (a) — see header), and matches one of the fixed-wait idiom shapes. Only handles what's
 *  decidable from THIS line alone (see `isCommentOnlyLine`) — a genuinely multi-line, non-JSDoc-style
 *  `/* ... *\/` block (no `*` prefix on its interior lines) needs file-level state, carried separately by
 *  `computeBlockCommentLines` in `scanFileForUnwitnessedHits` below; this function cannot see that on its
 *  own and is not claimed to. */
export function isWaitIdiomLine(line) {
  if (isCommentOnlyLine(line)) return false;
  if (SLEEP_PAST_RE.test(line)) return false;
  return IDIOM_SLEEP.test(line) || IDIOM_SETTIMEOUT.test(line) || IDIOM_WINDOWMS.test(line);
}

/**
 * File-level companion to `isCommentOnlyLine`: tracks `/* ... *\/` open/close STATE across every line of
 * the file, so a genuinely multi-line block comment (no per-line `*` prefix on its interior — the shape
 * `isCommentOnlyLine` alone cannot see, since it only ever looks at one line) is excluded by construction
 * rather than heuristically. Returns a boolean array, one entry per line, true iff that line is entirely
 * inside/part of a block comment. A line whose block comment CLOSES partway through, with real code
 * after the close, is NOT marked (that code is live and must still be scanned) — this only ever answers
 * "is this whole line comment text", not "does this line contain any comment at all".
 */
export function computeBlockCommentLines(lines) {
  const result = new Array(lines.length).fill(false);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock) {
      const closeIdx = line.indexOf("*/");
      if (closeIdx === -1) { result[i] = true; continue; }
      result[i] = line.slice(closeIdx + 2).trim() === "";
      inBlock = false;
      continue;
    }
    const openIdx = line.indexOf("/*");
    if (openIdx === -1) continue;
    const before = line.slice(0, openIdx);
    const closeIdx = line.indexOf("*/", openIdx + 2);
    if (closeIdx !== -1) {
      result[i] = before.trim() === "" && line.slice(closeIdx + 2).trim() === "";
      continue; // opens and closes on the same line — never leaves `inBlock` set
    }
    result[i] = before.trim() === "";
    inBlock = true;
  }
  return result;
}

/** The blank-line-delimited block containing `lines[idx]` — the refined boundary `e3faa8ac` validated
 *  (a fixed ±25-line radius flagged 23/26 sites in one file; this cut that to 15/26). Returns [start,
 *  end] inclusive line indices (0-based). */
export function blockBounds(lines, idx) {
  let start = idx;
  while (start > 0 && lines[start - 1].trim() !== "") start--;
  let end = idx;
  while (end < lines.length - 1 && lines[end + 1].trim() !== "") end++;
  return [start, end];
}

/** Scan backward from `waitLineIdx` through the contiguous `//`-comment block directly above it (plus
 *  the wait line itself, which may carry a trailing comment) for `markerRe`. Mirrors fixed-wait-negative-
 *  guard.mjs's own `markerReasonFor` (same placement rule) — a fresh, small copy rather than an import,
 *  since that file has no exports and this gate is meant to stand alone, no-build-needed for its own
 *  pure logic (only the real git diff needs dist/). */
function markerReasonFor(lines, waitLineIdx, markerRe) {
  const onWaitLine = markerRe.exec(lines[waitLineIdx]);
  if (onWaitLine) return onWaitLine[1].trim();
  for (let i = waitLineIdx - 1; i >= 0 && /^\s*\/\//.test(lines[i]); i--) {
    const m = markerRe.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Parse a unified diff (as returned by `diffBranch`'s `patch`) into `Map<newFilePath, Set<newLineNo>>` —
 * the 1-indexed line numbers, IN THE NEW FILE, that this diff ADDS. A deleted file contributes no entry
 * (nothing to scan; the file itself may be gone). Pure and exported so the self-test can drive it against
 * a hand-written diff string, with no real git/repo involved.
 *
 * Card 71231839: a file whose CONTENT git content-sniffs as binary (a raw NUL byte anywhere in it — see
 * `working-tree-eol-guard.mjs`'s own header on this) produces NO `+++`/`@@` lines at all — git emits a
 * single `Binary files a/<path> and b/<path> differ` line instead. Recognizing that shape explicitly (and
 * registering the file with an EMPTY added-line set — a binary diff genuinely conveys zero line-level
 * information, which is the honest, correct answer, not a guess) is what lets `main()`'s own
 * diffResult.files-vs-addedByFile cross-check (below) tell "this file's diff is legitimately uninformative"
 * apart from "the parser hit a header shape it has never seen before" — the ONLY thing that check exists to
 * catch. Before this, EITHER shape degraded identically to a 0-entry map, which the cross-check (correctly,
 * by design) treats as a parser bug and fails loudly on — this is what happened the day this card's own
 * fix removed the NUL from `resume-mode-detect.mjs`'s test fixture: the FIX COMMIT's own diff (old side
 * still NUL-bearing, new side not) is itself a binary transition, so it hit exactly this shape.
 */
export function parseAddedLineNumbers(patchText) {
  const result = new Map();
  const lines = patchText.split("\n");
  let currentFile = null;
  let newLineNo = null;
  for (const line of lines) {
    const binaryMatch = /^Binary files (?:a\/)?(.+) and (?:b\/)?(.+) differ$/.exec(line);
    if (binaryMatch) {
      const newPath = binaryMatch[2];
      if (!result.has(newPath)) result.set(newPath, new Set());
      currentFile = null;
      newLineNo = null;
      continue;
    }
    // Code review finding (blocking): a host with `diff.noprefix` set produces `+++ path` with NO `b/`
    // prefix at all — the old `b/`-only regex then extracted ZERO files from a real, non-empty patch,
    // silently indistinguishable from a genuinely clean branch. `+++ /dev/null` (a deleted file) is
    // checked FIRST and explicitly, since the loosened optional-prefix form below would otherwise also
    // capture "/dev/null" as if it were a real path.
    if (line.startsWith("+++ /dev/null")) { currentFile = null; newLineNo = null; continue; }
    const fileMatch = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!result.has(currentFile)) result.set(currentFile, new Set());
      newLineNo = null;
      continue;
    }
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) { newLineNo = Number(hunkMatch[1]); continue; }
    if (currentFile === null || newLineNo === null) continue;
    if (line.startsWith("+")) { result.get(currentFile).add(newLineNo); newLineNo++; continue; }
    if (line.startsWith("-")) continue; // removed line — doesn't exist in the new file, no advance
    if (line.startsWith(" ")) { newLineNo++; continue; } // unchanged context line — advances new counter
    // anything else ("\ No newline at end of file", a stray blank split artifact) — ignore, no advance
  }
  return result;
}

/**
 * Scan `sourceText` (the file's CURRENT, i.e. new-side, content) for fixed-wait idiom lines that are
 * BOTH in `addedLineNumbers` (this diff added them) AND immediately followed, in their blank-line block,
 * by at least one check()/assert() call — clearing each such candidate via one of the witnesses in this
 * file's header, or reporting it as an unwitnessed `hit`. Pure and exported for the self-test.
 * @returns {{ hits: Array<{file,lineNo,label}>, cleared: Array<{file,lineNo,reason}> }}
 */
export function scanFileForUnwitnessedHits(file, sourceText, addedLineNumbers) {
  const lines = sourceText.split("\n");
  const commentLines = computeBlockCommentLines(lines);
  const hits = [];
  const cleared = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    if (!addedLineNumbers.has(lineNo)) continue;
    if (commentLines[i]) continue; // multi-line block comment (743be0c9's bug class, file-level half)
    if (!isWaitIdiomLine(lines[i])) continue;
    const [start, end] = blockBounds(lines, i);
    // Comment-only lines (either half — `//`/single-line-block via isCommentOnlyLine, or a genuinely
    // multi-line block via commentLines) are excluded from BOTH the positiveControl scan and the
    // check()/assert() count — a doc comment mentioning `check("...")` in prose must never count as a
    // real witness, the same principle DoD-5 states for the wait line itself.
    const liveBlockLines = (from, to) => lines.slice(from, to).filter((l, k) => !commentLines[from + k] && !isCommentOnlyLine(l));
    const blockText = liveBlockLines(start, end + 1).join("\n");
    // Card 4bd5c5a4: a windowMs-only match (not also a raw sleep()/setTimeout() on the same line) is not
    // even a candidate unless its block also names observeOnce/assertNeverWithControl — see
    // TIMING_GUARD_CALL_RE above. Checked FIRST, before the check()/assert()/positiveControl scan below,
    // matching the sibling guard's own `windowMsCandidateHits` ordering.
    const isWindowMsOnlyMatch = IDIOM_WINDOWMS.test(lines[i]) && !IDIOM_SLEEP.test(lines[i]) && !IDIOM_SETTIMEOUT.test(lines[i]);
    if (isWindowMsOnlyMatch && !TIMING_GUARD_CALL_RE.test(blockText)) continue;
    const afterText = liveBlockLines(i + 1, end + 1).join("\n");
    const matches = [...afterText.matchAll(CHECK_OR_ASSERT_RE)];
    if (matches.length === 0) continue; // no assertion nearby — a settle/pacing wait, out of scope by design
    if (POSITIVE_CONTROL_RE.test(blockText)) {
      cleared.push({ file, lineNo, reason: "assertNeverWithControl positiveControl present in block (already runtime-enforced — card 1addef27)" });
      continue;
    }
    const exempt = markerReasonFor(lines, i, EXEMPT_RE);
    if (exempt) { cleared.push({ file, lineNo, reason: `TIMING-GUARD-SAFE: ${exempt}` }); continue; }
    const falseMatch = markerReasonFor(lines, i, FALSE_MATCH_RE);
    if (falseMatch) { cleared.push({ file, lineNo, reason: `TIMING-GUARD-FALSE-MATCH: ${falseMatch}` }); continue; }
    const preconditionMatch = matches.find((m) => PRECONDITION_TOKEN_RE.test(m[2]));
    if (preconditionMatch) {
      cleared.push({ file, lineNo, reason: `companion precondition check() present (marked "precondition" — "${preconditionMatch[2]}")` });
      continue;
    }
    hits.push({ file, lineNo, label: matches[0][2] });
  }
  return { hits, cleared };
}

/** Resolve the base ref to diff against: an explicit override (mirrors LOOM_GATE_OP_ID's threading
 *  convention), else the project's mainline branch name via the SAME resolver `resolveMainlineBranch`
 *  (git/worktrees.ts) already uses elsewhere — never a guessed "main". `null` means "cannot determine",
 *  and the caller fails safe (see header). */
async function resolveBaseRef(repoPath, resolveMainlineBranchFn) {
  if (process.env.LOOM_GATE_BASE_REF) return process.env.LOOM_GATE_BASE_REF;
  try {
    return await resolveMainlineBranchFn(repoPath);
  } catch {
    return null;
  }
}

/**
 * Card 40643460 — THE POPULATION-VISIBILITY CHECK. This guard diffs COMMITTED `HEAD` against the
 * merge-base (see `main` below); an UNTRACKED file (created but never `git add`ed) contributes nothing
 * to that diff and is therefore invisible to the scan — a brand-new test file with a genuinely
 * unwitnessed fixed wait would otherwise report `found 0`, byte-identical to a real clean scan. This is
 * NOT a second scanning mechanism (the diff scope stays correct and unchanged for what it's for — only
 * newly-ADDED, committed lines); it only NAMES what the diff-based scan above could not have seen, via
 * `git ls-files --others --exclude-standard`, the standard way to list untracked-but-not-ignored paths
 * matching a pathspec. Never throws: returns `null` (NOT `[]`) if git itself fails — `null` means "could
 * not check", `[]` means "checked, found none", and a caller must not conflate the two (e.g. a bare
 * `.length === 0` reads `null` as "found none" instead of "no answer"). This is a visibility check, not
 * the core guard; a git hiccup here must not itself fail an unrelated build (same fail-safe posture as
 * `resolveBaseRef`/the diff try/catch above) — the caller is expected to skip the check on `null`, not
 * treat it as a clean result.
 */
export function listUntrackedTestFiles(repoRoot, testGlob, execFileSyncFn = execFileSync) {
  try {
    const raw = execFileSyncFn("git", ["-C", repoRoot, "ls-files", "--others", "--exclude-standard", "--", testGlob], { encoding: "utf8" });
    return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null; // git itself failed (not "found none") — caller distinguishes via null, doesn't fail on it
  }
}

/**
 * Card 5df7bcee — THE NUL-BEARING-FILE ASSERTION. See this file's own header for the full rationale
 * (why a NUL-bearing file is unscannable by both this guard and `working-tree-eol-guard.mjs`, and why
 * asserting the precondition never holds is the right shape rather than trying to scan such a file).
 * Enumerates the CURRENT top-level `.mjs` files directly under `testDir` (never a recursive walk — the
 * same scope `TEST_GLOB` names) and flags any whose raw on-disk bytes contain a NUL. Deliberately reads
 * the WORKING-TREE bytes, not a diff — a transition commit that removes a NUL is judged by what the file
 * looks like now, not by what its diff happened to render. `readdirSyncFn`/`readFileSyncFn` are
 * injectable (same DI shape as `listUntrackedTestFiles` above) so the self-test can drive this against a
 * throwaway directory with no real git/repo involved. Returns `null` (not `[]`) if the directory can't be
 * listed at all — a listing failure is "could not check", never a false "found none" (same null-vs-empty
 * contract as `listUntrackedTestFiles`/`scanModifiedTrackedTestFiles`).
 */
export function listNulBearingTestFiles(testDir, readdirSyncFn = fs.readdirSync, readFileSyncFn = fs.readFileSync) {
  let names;
  try {
    names = readdirSyncFn(testDir).filter((n) => n.endsWith(".mjs"));
  } catch {
    return null;
  }
  const found = [];
  for (const name of names) {
    let buf;
    try { buf = readFileSyncFn(path.join(testDir, name)); }
    catch { continue; } // gone from the working tree since the listing (a race, not a violation)
    if (buf.includes(0)) found.push(name);
  }
  return found;
}

/**
 * Card 21e12d47 — THE MODIFIED-TRACKED-FILE SCAN, the OTHER half of the blind spot `40643460` (above)
 * doesn't cover. `listUntrackedTestFiles` only ever sees a file that was NEVER `git add`ed. A file that
 * IS tracked but has been changed since `HEAD` — staged, unstaged, or both — is neither untracked (so
 * `git ls-files --others` never lists it) nor part of the committed `HEAD`-vs-merge-base diff the core
 * scan reads (`main`, below) — so a fixed-wait violation added to it contributes zero lines to that scan
 * and the guard prints `scanned 0 added line(s)` while genuinely scanning nothing. This is deliberately
 * CONTENT-AWARE, unlike the bare-presence `listUntrackedTestFiles` check: a naming-only check ("this file
 * has an uncommitted change, therefore FAIL") would make ANY uncommitted edit to a test file fail this
 * guard — including a one-line comment fix with no fixed-wait content at all — which is not this guard's
 * job to police and would train workers to distrust a legitimate FAIL. Instead this diffs the file's
 * CURRENT on-disk content against its own committed `HEAD` blob (`git diff HEAD -- <glob>`, which reads
 * the final working-tree bytes against `HEAD` regardless of index state, so it sees staged AND unstaged
 * changes alike — there is no narrower git primitive that would see one but not the other without a
 * second, redundant `--cached` pass), reparses that patch with the SAME `parseAddedLineNumbers` the core
 * scan uses, and runs the SAME `scanFileForUnwitnessedHits` detection against the result — so an actual
 * violation in an uncommitted edit is CAUGHT (named file + line + label, exactly like a committed hit),
 * while a clean uncommitted edit passes cleanly, same as it should. Same null-vs-`{hits:[],cleared:[],
 * files:[]}` contract as `listUntrackedTestFiles`: `null` means "could not check" (a git hiccup), never a
 * false "found none".
 */
export function scanModifiedTrackedTestFiles(repoRoot, testGlob, execFileSyncFn = execFileSync) {
  let patch;
  try {
    patch = execFileSyncFn("git", ["-C", repoRoot, "diff", "HEAD", "--", testGlob], { encoding: "utf8" });
  } catch {
    return null; // git itself failed (not "found none") — caller distinguishes via null, doesn't fail on it
  }
  const addedByFile = parseAddedLineNumbers(patch);
  const hits = [];
  const cleared = [];
  const files = [];
  for (const [file, addedLineNumbers] of addedByFile) {
    if (addedLineNumbers.size === 0) continue;
    files.push(file);
    const abs = path.join(repoRoot, file);
    if (!fs.existsSync(abs)) continue; // deleted in the working tree — nothing to scan
    const sourceText = fs.readFileSync(abs, "utf8");
    const scanned = scanFileForUnwitnessedHits(file, sourceText, addedLineNumbers);
    hits.push(...scanned.hits);
    cleared.push(...scanned.cleared);
  }
  return { hits, cleared, files };
}

async function main() {
  let diffBranchFn, resolveMainlineBranchFn;
  try {
    ({ diffBranch: diffBranchFn, resolveMainlineBranch: resolveMainlineBranchFn } =
      await import(pathToFileURL(path.join(REPO_ROOT, "packages", "daemon", "dist", "git", "worktrees.js")).href));
  } catch (e) {
    check(`fixed-wait-witness-guard: could not load dist/git/worktrees.js (${e.message}) — build the daemon first`, false);
    console.log(`\n❌ ${failures} FAILURE(S).`);
    process.exit(1);
  }

  const base = await resolveBaseRef(REPO_ROOT, resolveMainlineBranchFn);
  if (!base) {
    check("fixed-wait-witness-guard: SKIPPED — no resolvable mainline base ref (expected on a shallow/no-origin checkout; Loom's own worktrees always resolve one). Not a pass on the merits, just nothing to diff.", true);
    console.log("\n✅ ALL PASS (skipped — see note above).");
    process.exit(0);
  }

  let diffResult;
  try {
    diffResult = await diffBranchFn(REPO_ROOT, "HEAD", base, { includePatch: true, pathGlob: TEST_GLOB });
  } catch (e) {
    check(`fixed-wait-witness-guard: SKIPPED — diff against "${base}" failed (${e.message}). Not a pass on the merits, just nothing to diff.`, true);
    console.log("\n✅ ALL PASS (skipped — see note above).");
    process.exit(0);
  }

  const addedByFile = parseAddedLineNumbers(diffResult.patch);
  // Code review finding (blocking): parseAddedLineNumbers extracting a diff-header shape it doesn't
  // recognize (e.g. a `diff.noprefix` host config, or a future diffBranch patch-format change) used to
  // degrade SILENTLY to zero files found — byte-identical output to a genuinely clean branch. diffBranch
  // already computed `files` from `git diff --stat`, independent of this file's own header regex; cross-
  // checking against it converts that whole class of parser gap from silent-green to a loud, visible
  // failure, without needing to anticipate every diff-header shape in advance.
  if (diffResult.files.length > 0 && addedByFile.size === 0) {
    check(`fixed-wait-witness-guard: parseAddedLineNumbers extracted 0 file(s) from a patch diffBranch says touched ${diffResult.files.length} file(s) (${diffResult.files.map((f) => f.file).join(", ")}) — the parser disagrees with diffBranch's own diffstat. This is a parser bug (an unrecognized diff header shape), not evidence of a clean branch — failing loudly instead of silently reporting a false green.`, false);
  }
  const allHits = [];
  const allCleared = [];
  for (const [file, addedLineNumbers] of addedByFile) {
    if (addedLineNumbers.size === 0) continue;
    const abs = path.join(REPO_ROOT, file);
    if (!fs.existsSync(abs)) continue; // deleted on this branch — nothing to scan
    const sourceText = fs.readFileSync(abs, "utf8");
    const { hits, cleared } = scanFileForUnwitnessedHits(file, sourceText, addedLineNumbers);
    allHits.push(...hits);
    allCleared.push(...cleared);
  }

  check(`no newly-added fixed-wait-adjacent-to-check() site without a witness (sleepPast / positiveControl / companion check() / TIMING-GUARD comment) — found ${allHits.length}`, allHits.length === 0);
  for (const h of allHits) console.log(`  HIT  ${h.file}:${h.lineNo}  "${h.label}"`);
  for (const c of allCleared) console.log(`  CLEARED  ${c.file}:${c.lineNo}  ${c.reason}`);

  // Card 40643460 — SELF-DESCRIBE THE SCANNED POPULATION. A bare "found 0" reads identically whether
  // this diff genuinely added no candidate, or whether the diff-scoped mechanism above simply never had
  // anything to look at. State the actual population size at the point a human reads the result, so the
  // count can never be misread by someone who never opens the regex.
  const totalAddedLines = [...addedByFile.values()].reduce((sum, s) => sum + s.size, 0);
  console.log(`[fixed-wait-witness-guard] population: scanned ${totalAddedLines} added line(s) across ${addedByFile.size} file(s) vs "${base}"`);

  // THE UNTRACKED-FILE BLIND SPOT ITSELF (the defect this card exists to fix): this guard is
  // diff-scoped against COMMITTED HEAD — a file created but never `git add`ed contributes NOTHING to
  // that diff and is invisible to everything above. Name any such file explicitly rather than let it
  // silently pass as part of "found 0". `null` (git itself failed) is a visibility-check hiccup, not
  // evidence either way — skip rather than fail an unrelated build over it (same fail-safe posture as
  // the base/diff resolution above).
  const untrackedTestFiles = listUntrackedTestFiles(REPO_ROOT, TEST_GLOB);
  if (untrackedTestFiles === null) {
    console.log(`[fixed-wait-witness-guard] could not check for untracked ${TEST_GLOB} files (git ls-files failed) — skipping the untracked-visibility check`);
  } else {
    check(
      `no untracked file(s) matching ${TEST_GLOB} are invisible to this diff-scoped scan (found ${untrackedTestFiles.length}` +
        (untrackedTestFiles.length > 0 ? `: ${untrackedTestFiles.join(", ")} — this scan is diff-scoped against committed HEAD and cannot see them; git add them and re-run` : "") +
        ")",
      untrackedTestFiles.length === 0
    );
  }

  // Card 21e12d47 — THE OTHER HALF OF THE BLIND SPOT: a tracked test file with a staged-and/or-unstaged,
  // NOT-YET-COMMITTED change. `40643460`'s untracked check above can't see it (it's tracked, so `git
  // ls-files --others` never lists it) and the core `HEAD`-vs-merge-base scan can't see it either (it's
  // not committed, so it contributes zero lines to that diff). Unlike the untracked check, this ACTUALLY
  // SCANS the uncommitted content for a real violation — see `scanModifiedTrackedTestFiles`'s own header
  // for why bare presence would be the wrong shape here.
  const modifiedScan = scanModifiedTrackedTestFiles(REPO_ROOT, TEST_GLOB);
  if (modifiedScan === null) {
    console.log(`[fixed-wait-witness-guard] could not check for uncommitted changes to tracked ${TEST_GLOB} files (git diff failed) — skipping the modified-tracked-file scan`);
  } else {
    for (const h of modifiedScan.hits) console.log(`  UNCOMMITTED HIT  ${h.file}:${h.lineNo}  "${h.label}" (staged/unstaged, not yet committed — commit it to make this the ordinary diff-scoped hit above)`);
    for (const c of modifiedScan.cleared) console.log(`  UNCOMMITTED CLEARED  ${c.file}:${c.lineNo}  ${c.reason}`);
    check(
      `no uncommitted (staged and/or unstaged) change to a tracked ${TEST_GLOB} file adds a fixed-wait-adjacent-to-check() site without a witness — scanned ${modifiedScan.files.length} modified file(s)` +
        (modifiedScan.files.length > 0 ? ` (${modifiedScan.files.join(", ")})` : "") +
        `, found ${modifiedScan.hits.length}`,
      modifiedScan.hits.length === 0
    );
  }

  // Card 5df7bcee — THE NUL-BEARING-FILE ASSERTION (see this file's own header for the full rationale).
  // Checked against the CURRENT on-disk population, not a diff — a listing failure is a visibility-check
  // hiccup (same fail-safe posture as the untracked/modified checks above), not evidence either way.
  const nulBearingTestFiles = listNulBearingTestFiles(TEST_DIR);
  if (nulBearingTestFiles === null) {
    console.log(`[fixed-wait-witness-guard] could not enumerate ${TEST_GLOB} to check for NUL-bearing files (readdir failed) — skipping the NUL-bearing-file assertion this run`);
  } else {
    check(
      `no file matching ${TEST_GLOB} carries a raw NUL byte (found ${nulBearingTestFiles.length}` +
        (nulBearingTestFiles.length > 0
          ? `: ${nulBearingTestFiles.join(", ")} — a NUL-bearing file is content-sniffed as binary by git and is invisible to BOTH this guard's diff-scoped scan and working-tree-eol-guard.mjs's EOL check (card 5df7bcee); escape the byte as \\x00 instead (see card 71231839)`
          : "") +
        ")",
      nulBearingTestFiles.length === 0
    );
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — no newly-added raw-sleep synchronisation probe on this branch is missing a witness. This never reaches the ~240 pre-existing sites (df88c1b2 DoD-3) — it is diff-scoped by construction, not a baseline."
    : `\n❌ ${failures} FAILURE(S).`);
  process.exit(failures === 0 ? 0 : 1);
}

// Only run the real check when this file is the actual entry point (matches
// assets/scripts/ensure-obsidian.mjs's own convention) — importing it for its pure exports (the
// self-test) must never also trigger a real git diff + dist import as a side effect.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
