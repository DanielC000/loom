import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure fs below, no daemon/Db used
// EMIT-COMPARE SOUNDNESS SINGLE-DEFINITION GUARD (card bafc68e7). Before this card, the emit-compare
// soundness predicate + its `.ts` walker existed as two INDEPENDENT copies —
// `git/worktrees.ts`'s `emitCompareSoundnessOk`/`walkTsFiles` and `deploy-staleness.ts`'s
// `ancestorTranspileCompareSound`/`walkTsFilesForSoundnessCheck` — which had already diverged in scope and
// (transiently) in catch semantics (a real fail-open, fixed before this card). Card bafc68e7 consolidated
// both into ONE shared module, `packages/daemon/src/emit-compare-soundness.ts`, parameterized by scope.
//
// This guard is the structural backstop against that duplication ever reappearing: it scans EVERY real
// `.ts` file under `packages/daemon/src/**` for a `function`-declaration-shaped occurrence of each of the
// three consolidated primitives (`emitCompareSoundnessOk`, `walkTsFiles`,
// `transpileIgnoringCommentsAndWhitespace`) and asserts each exists EXACTLY ONCE, in
// `emit-compare-soundness.ts` — never zero (deleted with no replacement) and never more than one
// (redefined locally by a future edit to `git/worktrees.ts` or `deploy-staleness.ts`, recreating the exact
// divergence risk this card closed). It also asserts the two RETIRED copy-specific names
// (`ancestorTranspileCompareSound`, `walkTsFilesForSoundnessCheck`) never reappear as a declaration
// anywhere under `packages/daemon/src` (the same scope the primary scan below walks) — a second,
// independent tripwire against the same regression under a different name.
//
// ⚠️⚠️ CORRECTED TWICE (Code Review, same day): this guard's own regex is a genuine member of
// `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` (git/worktrees.ts) — an earlier version of this file argued it
// needed no seat there on the "reintroducing a duplicate is itself a behavioural edit, already caught by
// computeEmitCompareGate" ground (the ground `emit-compare-soundness-guard.mjs` correctly uses for its OWN
// const-enum/tsconfig checks, because THAT check is re-run LIVE inside computeEmitCompareGate). That ground
// does NOT transfer here: nothing in production re-derives "does exactly one `function <name>(` exist", so
// there is no live twin to inherit immunity from. TWO independent comment shapes break it, MEASURED against
// the real `typescript` package (not merely asserted — see this card's own decision record):
//   1. a comment INSERTED INSIDE a real declaration (`function walkTsFiles/* c */(x)`) transpiles IDENTICAL
//      to the uncommented form under `removeComments:true` (reduced-gate eligible), but flips this file's
//      declaration regex from MATCH to NON-MATCH — a false NEGATIVE. Hardened below (GAP/OPT_GAP) to
//      tolerate an inline block comment in the gap.
//   2. a BARE `/* ... */` block comment (no per-line `* ` prefix, unlike JSDoc) can carry an interior line
//      that itself reads `function <name>(...) {...}` at column 0 as ordinary prose/example text — this
//      guard's regex has no comment-awareness and cannot tell that text apart from a real declaration,
//      producing a false POSITIVE (a spurious extra "definition"). NOT fixed by the GAP/OPT_GAP hardening
//      (that only closes gaps INSIDE a real declaration, not prose that merely resembles one) and NOT
//      attempted here — the real fix (a comment-stripping pass before matching, the shape
//      `codescape-supervisor-shutdown-wiring.mjs` already uses) was offered and deliberately deferred: it
//      earns its own card rather than this one, since list membership alone already closes the actual
//      correctness gap (a real regression is still caught, at the FULL gate) and this failure mode's own
//      direction is safe — it can only make an innocent comment-only diff fail LOUDLY, never mask a real
//      duplicate silently.
// EITHER shape means: per `CHANGED_TS_TEXT_SCANNER_REPO_PATHS`'s own doctrine, hardening is complementary,
// never a substitute for list membership — this file IS a member, unconditionally, regardless of how much
// further the regex is hardened.
//
// Run: node packages/daemon/test/emit-compare-soundness-single-definition-guard.mjs (no build needed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const daemonSrc = path.join(repoRoot, "packages", "daemon", "src");
const canonicalFile = path.join(daemonSrc, "emit-compare-soundness.ts");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function walkTsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// A REQUIRED gap (>=1 whitespace char or a `/* ... */` block comment) between keywords/tokens — real
// tsc emit keeps a comment inserted mid-declaration (e.g. `function walkTsFiles/* c */(`), so a plain
// `\s*`/`\s+` gap alone would silently stop matching a still-real declaration. An OPTIONAL gap (`*`) is
// used only right before the final `(`, where no separator at all is also valid syntax.
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/)+`;
const OPT_GAP = String.raw`(?:\s|/\*[\s\S]*?\*/)*`;

// Line-anchored to a real `function` declaration (optionally `export`/`async`-prefixed) — a doc comment
// describing or cross-referencing the name in prose never starts a line with this exact shape.
function declarationRegex(name) {
  return new RegExp(`^\\s*(export${GAP})?(async${GAP})?function${GAP}${name}${OPT_GAP}\\(`, "m");
}

/** Counts real `function <name>(` declarations across `files`, returning the matching file list. */
function findDeclarations(files, name) {
  const re = declarationRegex(name);
  return files.filter((f) => re.test(fs.readFileSync(f, "utf8")));
}

// ── (A) REAL REPO — each consolidated primitive must exist EXACTLY ONCE, and only in the canonical module
{
  const files = walkTsFiles(daemonSrc);
  check("(A) walked a non-trivial number of real source files (sanity: the walk itself works)", files.length > 50);

  for (const name of ["emitCompareSoundnessOk", "walkTsFiles", "transpileIgnoringCommentsAndWhitespace"]) {
    const hits = findDeclarations(files, name);
    check(`(A) exactly ONE \`function ${name}(\` declaration exists under packages/daemon/src`, hits.length === 1);
    check(`(A) that ONE \`${name}\` declaration lives in emit-compare-soundness.ts, not a re-duplicated copy`,
      hits.length === 1 && hits[0] === canonicalFile);
  }

  // The two RETIRED, copy-specific names must never reappear as a declaration anywhere under
  // `packages/daemon/src` (the same `files` population scanned above, not "the tree" at large) — an
  // independent tripwire against the same regression resurfacing under a different name.
  for (const retiredName of ["ancestorTranspileCompareSound", "walkTsFilesForSoundnessCheck"]) {
    const hits = findDeclarations(files, retiredName);
    check(`(A) the retired name \`${retiredName}\` has NOT reappeared as a declaration under packages/daemon/src`, hits.length === 0);
  }
}

// ── (B) NEGATIVE CONTROL — prove the multi-declaration detector can actually FAIL: two synthetic files
//        both declaring the SAME name MUST be counted as 2, not silently deduped or missed ─────────────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ecsdg-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "export function walkTsFiles(dir) { return []; }\n");
    fs.writeFileSync(path.join(tmpDir, "b.ts"), "function walkTsFiles(dir, out) { return out; }\n");
    const hits = findDeclarations(walkTsFiles(tmpDir), "walkTsFiles");
    check("(B) a genuine SECOND declaration in a fixture pair DOES trip the check (count is 2, not 1)", hits.length === 2);

    // Also prove the "single declaration, correct file" arm distinguishes a single hit that is NOT in the
    // canonical file — a regression that moves the ONLY definition to the wrong place must still be caught.
    const soloDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ecsdg-solo-"));
    try {
      const wrongFile = path.join(soloDir, "not-the-canonical-module.ts");
      fs.writeFileSync(wrongFile, "export function emitCompareSoundnessOk() { return true; }\n");
      const soloHits = findDeclarations(walkTsFiles(soloDir), "emitCompareSoundnessOk");
      check("(B) a single declaration OUTSIDE the canonical file is correctly flagged (path mismatch)",
        soloHits.length === 1 && soloHits[0] !== canonicalFile);
    } finally {
      fs.rmSync(soloDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── (C) NEGATIVE CONTROL for the word-boundary of the declaration regex — a bare mention in prose (e.g. a
//        doc comment cross-referencing the name) must NOT count as a declaration ──────────────────────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ecsdg-prose-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "prose-only.ts"),
      "/** mirrors emit-compare-soundness.ts's own walkTsFiles exactly — see that module. */\nexport const x = 1;\n",
    );
    const hits = findDeclarations(walkTsFiles(tmpDir), "walkTsFiles");
    check("(C) a doc-comment MENTION of the name (not a real declaration) does NOT count", hits.length === 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── (D) REGRESSION CONTROL (Code Review) — a `.ts`-diff computeEmitCompareGate treats as
//        TRANSPILE-IDENTICAL (reduced-gate eligible: a comment inserted between a declaration's name and
//        its `(`) must NOT flip this guard's own verdict from match to non-match — that was the actual
//        defect: `\s*\(` alone matches `function walkTsFiles(` but not `function walkTsFiles/* c */(`,
//        even though the two are transpile-identical under `removeComments:true` (verified separately,
//        against the real `typescript` package, in this card's own decision record) ─────────────────────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ecsdg-comment-"));
  try {
    const plain = path.join(tmpDir, "plain.ts");
    const commented = path.join(tmpDir, "commented.ts");
    fs.writeFileSync(plain, "export function walkTsFiles(dir, out = []) { return out; }\n");
    fs.writeFileSync(commented, "export function walkTsFiles/* inserted comment */(dir, out = []) { return out; }\n");
    const re = declarationRegex("walkTsFiles");
    check("(D) sanity: the PLAIN declaration matches (control isn't vacuous)", re.test(fs.readFileSync(plain, "utf8")));
    check(
      "(D) THE FIX: a declaration with an inline comment between the name and `(` STILL matches — a transpile-identical .ts diff no longer flips this guard's verdict",
      re.test(fs.readFileSync(commented, "utf8")),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — emitCompareSoundnessOk/walkTsFiles/transpileIgnoringCommentsAndWhitespace each exist exactly once, in emit-compare-soundness.ts; the two retired copy-specific names have not reappeared; the detector is proven capable of catching a real re-duplication, a moved-out-of-place lone definition, and a doc-comment false positive; and a comment inserted mid-declaration (a transpile-identical, reduced-gate-eligible diff) no longer flips this guard's own verdict."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
