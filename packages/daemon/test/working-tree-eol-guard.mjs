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
// THE ONE REMAINING GENUINE ALWAYS-LF FILE (`packages/web/src/pages/Companion.tsx`) — NOT a flip, and
// NOT hardcoded as an exception here either. It carries a single literal NUL (0x00) byte in its own
// source (a sentinel map-key — grep `\x00` in the file to see it). A NUL byte anywhere in a blob is
// exactly the heuristic git's OWN `text=auto` content-sniffing uses to decide a path is BINARY —
// confirmed empirically on this card by running `git checkout --` against the file directly: its
// working-tree bytes don't change, in this worktree or a fresh one, regardless of `core.autocrlf`. A
// binary-by-content file is never subject to LF/CRLF conversion by git at all — commit or checkout — so
// there is no line-ending policy to enforce on it, and this guard SKIPS any working-tree file containing
// a raw NUL byte for exactly that reason. This generalises to any FUTURE file with the same shape
// (nothing here needs updating if another such file is ever added), and it means a real flip can never
// hide behind this exemption: a genuinely flipped source file (a config, a doc, an ordinary source file)
// has no reason to carry an embedded NUL, and one that legitimately does is — by construction — a file
// git itself was never going to touch either.
//
// `packages/daemon/test/resume-mode-detect.mjs` used to be a second such file (its own garbage-input
// test fixture carried a literal NUL). Card 71231839 found that same NUL — sitting inside git's ~8000-
// byte diff-binary sniff window, unlike Companion.tsx's (past that window) — also silenced `git log
// --numstat`/diff rendering for the file, and rewrote it as the `\x00` escape (an identical runtime
// string value, per the ECMAScript spec, so the test's own assertions are unaffected). That took the
// file out of this guard's NUL-exemption entirely — it is now an ordinary unpinned text=auto file,
// checked against the same CRLF-on-this-host policy as everything else, like any other file that never
// carried a NUL.
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
// UNTRACKED-FILE VISIBILITY (card c3e70c20, 2026-08-31): `listTrackedTextFiles` below enumerates via
// `git ls-files` — TRACKED FILES ONLY. A file created but never `git add`ed contributed nothing to that
// population and was invisible to section (B)'s scan, so a genuine EOL-policy violation in a brand-new
// file reported a clean `exit 0` — verified empirically on this card in a throwaway fixture repo (a
// never-added bare-LF file under a CRLF policy: absent from `git ls-files -z`, present in `git status
// --porcelain`). This cost a real 15-minute gate lane here (`opId bb4dc964`) and a rejected gate on a peer
// project, in both cases because the worker's own PRE-COMMIT guard run returned a meaningless clean pass.
// FIX: `listUntrackedTextFiles` below reuses the SAME primitive `fixed-wait-witness-guard.mjs`'s
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
// HERMETIC: git + fs only — no daemon, no build required.
// Run: node packages/daemon/test/working-tree-eol-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, unregister, finishAndExit } from "./_tmp-fixture.mjs";
import { listUntrackedTestFiles as listUntrackedRepoFiles } from "./fixed-wait-witness-guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", ".."); // test/ -> daemon -> packages -> repo root

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Deliberately the same population the card's own investigation scanned, plus `.sh`/`.ps1` (real
// examples of both a real eol=lf and eol=crlf pin already live in this repo, so the guard exercises the
// pinned-attribute path against real files, not only the fixture repo below).
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".css", ".html", ".sh", ".ps1",
]);

/** Raw CRLF vs bare-LF line-ending counts of a buffer, read directly off disk — never through a git diff/
 *  status/show comparison (see this file's own header for why those are blind to exactly this fault). */
function countEndings(buf) {
  let crlf = 0;
  let totalLf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      totalLf++;
      if (i > 0 && buf[i - 1] === 0x0d) crlf++;
    }
  }
  return { crlf, bareLf: totalLf - crlf };
}

/** Mirrors git's own `text=auto` content-sniffing heuristic closely enough for this guard's purpose: a
 *  raw NUL byte anywhere in the content means git treats the path as binary and never applies LF/CRLF
 *  conversion to it (empirically confirmed on this card via `git checkout --` against both of this
 *  repo's real examples — see this file's own header). */
function containsNul(buf) {
  return buf.includes(0);
}

/** The line-ending policy `.gitattributes` + `core.autocrlf` imply for a path, given its `eol`/`text`
 *  check-attr values. Returns "lf" | "crlf" | null (null = no policy — an explicit `-text`/binary path). */
function expectedPolicy(eolAttr, textAttr, autocrlfTrue) {
  if (textAttr === "unset") return null; // explicit -text / binary attribute — git never converts it
  if (eolAttr === "lf") return "lf";
  if (eolAttr === "crlf") return "crlf";
  return autocrlfTrue ? "crlf" : "lf"; // no eol pin — falls through to the live core.autocrlf setting
}

/** Evaluates one file's actual bytes against its expected policy. `skip:true` covers both "no line-
 *  ending policy applies" (policy === null) and "the file has no newlines to have an opinion about". */
function evaluate(buf, policy) {
  if (policy === null) return { skip: true };
  const { crlf, bareLf } = countEndings(buf);
  if (crlf === 0 && bareLf === 0) return { skip: true };
  if (policy === "crlf") return { skip: false, ok: bareLf === 0, crlf, bareLf };
  return { skip: false, ok: crlf === 0, crlf, bareLf }; // policy === "lf"
}

function execGit(root, args, opts = {}) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "buffer", ...opts });
}

function coreAutocrlfTrue(root) {
  let out;
  try { out = execGit(root, ["config", "--get", "core.autocrlf"]).toString("utf8").trim(); }
  catch { out = ""; } // `git config --get` exits non-zero with empty output when the key is unset
  return out === "true";
}

function listTrackedTextFiles(root) {
  const raw = execGit(root, ["ls-files", "-z"]).toString("utf8");
  return raw.split("\0").filter(Boolean).filter((p) => TEXT_EXTENSIONS.has(path.extname(p)));
}

/** Card c3e70c20 — the population-visibility fix (see this file's own header for the full rationale).
 *  Reuses `fixed-wait-witness-guard.mjs`'s `listUntrackedTestFiles` (a thin wrapper around `git ls-files
 *  --others --exclude-standard`) with pathspec `"."` (repo-root-relative, matches at any depth — verified
 *  empirically on this card) rather than re-typing the same git invocation a second time, then applies
 *  the SAME extension filter `listTrackedTextFiles` uses above. Mirrors that helper's null-vs-empty
 *  contract: `null` means "git itself failed" (could not check), `[]` means "checked, found none" — a
 *  caller must not conflate the two. */
function listUntrackedTextFiles(root) {
  const untracked = listUntrackedRepoFiles(root, ".");
  if (untracked === null) return null;
  return untracked.filter((p) => TEXT_EXTENSIONS.has(path.extname(p)));
}

/** Batched `git check-attr eol text` over every path at once via stdin (never argv — sidesteps any
 *  OS command-line length limit for a corpus this size). Returns Map<path, {eol, text}>. */
function checkAttrsBatch(root, files) {
  const map = new Map();
  if (files.length === 0) return map;
  const input = Buffer.from(files.map((f) => `${f}\0`).join(""), "utf8");
  const out = execFileSync("git", ["-C", root, "check-attr", "-z", "--stdin", "eol", "text"], {
    input, encoding: "buffer",
  }).toString("utf8");
  const tokens = out.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const [file, attr, value] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    let entry = map.get(file);
    if (!entry) { entry = {}; map.set(file, entry); }
    entry[attr] = value;
  }
  return map;
}

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

    const untrackedFound = listUntrackedTextFiles(fixtureRoot);
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
      "(fixture) DoD-3(c): the tracked-file walk stays byte-identical — still finds exactly clean.json + pinned.md, unaffected by the two new untracked files",
      listTrackedTextFiles(fixtureRoot).sort().join(",") === ["clean.json", "pinned.md"].sort().join(","),
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
    const untrackedAfterIgnore = listUntrackedTextFiles(fixtureRoot);
    check(
      "(fixture) IGNORED-FILE POLARITY: a .gitignore-matched file is NOT swept into the untracked population, even though its own content would otherwise violate the policy",
      untrackedAfterIgnore !== null && !untrackedAfterIgnore.includes("ignored-bad.json"),
    );
    check(
      "(fixture) sanity: excluding the ignored file didn't also hide the two genuinely-untracked files from the same scan",
      untrackedAfterIgnore !== null && untrackedAfterIgnore.includes("untracked-bad.json") && untrackedAfterIgnore.includes("untracked-good.json"),
    );
  } finally {
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (err) { console.error(`[tmp] retained for backstop: ${fixtureRoot} — ${err}`); }
    if (!fs.existsSync(fixtureRoot)) unregister(fixtureRoot);
  }
}

// =====================================================================================================
// (B) THE REAL BACKSTOP — every tracked text file in this repo, scanned live off disk.
// =====================================================================================================
{
  const autocrlfTrue = coreAutocrlfTrue(repoRoot);
  const files = listTrackedTextFiles(repoRoot);
  check(`sanity: the tracked-file walk found a non-trivial population (found ${files.length} file(s) across ${TEXT_EXTENSIONS.size} extensions)`, files.length > 100);

  // Card c3e70c20 — the population-visibility fix itself: a never-`git add`ed text file was previously
  // invisible to everything below. `null` means git failed (skip, don't fail an unrelated build over it
  // — same fail-safe posture as the sibling this reuses); `[]` means checked, genuinely none found.
  const untrackedFiles = listUntrackedTextFiles(repoRoot);
  if (untrackedFiles === null) {
    console.log("[working-tree-eol-guard] could not enumerate untracked files (git ls-files --others failed) — skipping the untracked-visibility scan this run");
  } else {
    console.log(`[working-tree-eol-guard] population: ${untrackedFiles.length} untracked text file(s) found alongside ${files.length} tracked (state the actual population, not just a bare "found 0")`);
  }
  const scanTargets = [
    ...files.map((rel) => ({ rel, tracked: true })),
    ...(untrackedFiles || []).map((rel) => ({ rel, tracked: false })),
  ];

  const attrs = checkAttrsBatch(repoRoot, scanTargets.map((t) => t.rel));

  const violations = [];
  const skippedBinary = [];
  let lfPinnedCount = 0;
  let crlfPinnedCount = 0;

  for (const { rel, tracked } of scanTargets) {
    const attr = attrs.get(rel) || {};
    if (tracked && attr.eol === "lf") lfPinnedCount++;
    if (tracked && attr.eol === "crlf") crlfPinnedCount++;
    const abs = path.join(repoRoot, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; } // gone from the working tree since enumeration
    if (containsNul(buf)) { if (tracked) skippedBinary.push(rel); continue; }
    const policy = expectedPolicy(attr.eol, attr.text, autocrlfTrue);
    const result = evaluate(buf, policy);
    if (result.skip) continue;
    if (!result.ok) violations.push({ file: rel, tracked, policy, crlf: result.crlf, bareLf: result.bareLf });
  }

  check(`sanity: .gitattributes' real eol=lf pin(s) actually resolve to ≥1 tracked file (found ${lfPinnedCount}) — proves check-attr reads .gitattributes rather than defaulting`, lfPinnedCount > 0);
  check(`sanity: .gitattributes' real eol=crlf pin (install.ps1) resolves to ≥1 tracked file (found ${crlfPinnedCount})`, crlfPinnedCount > 0);

  check(
    `positive control: the one known genuinely-binary-by-content file is exempted via its own embedded NUL byte, not a hardcoded filename (found ${skippedBinary.length} exempt file(s): ${skippedBinary.join(", ") || "none"})`,
    skippedBinary.includes("packages/web/src/pages/Companion.tsx"),
  );

  if (violations.length) {
    for (const v of violations) console.log(`  EOL-MISMATCH${v.tracked ? "" : " (UNTRACKED — never added to git; stage it and re-run)"}  ${v.file}  expected all-${v.policy}, found CRLF=${v.crlf} bareLF=${v.bareLf}`);
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
