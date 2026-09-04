import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no Db used below, pure source-text scan
// STANDING GUARD (card 82662e98) — the real backstop for INERT_MERGE_EXACT_PATHS (git/worktrees.ts:
// README.md, CHANGELOG.md, CODE_OF_CONDUCT.md, CONTRIBUTING.md, SECURITY.md), closing a gap the card's own
// verification surfaced rather than papering over it.
//
// WHY THIS EXISTS, NOT JUST A RE-RUN OF `repoTreeReferencesInertPrefix`: that live per-repo scanner (the
// mechanism `isInertMergeDiff` already re-verifies EVERY inert-path entry against, docs/ included) requires
// a read-call name AND an anchor (__dirname/import.meta.url/…) on the SAME LINE (git grep is per-line).
// Measured directly (card 82662e98): it returns `referenced:false` for ALL SIX tokens below, INCLUDING
// `CLAUDE.md` — which genuinely IS read, for real, by this repo's own `kickoff-real-spawn.mjs` and
// `spawn-command-line-preflight.mjs`. Both anchor a `REPO_ROOT` constant via `import.meta.url` on an
// EARLIER line, then read `CLAUDE.md` through that constant on a LATER line — the exact "INDIRECTION" gap
// that scanner's own doc comment already names and accepts (`repoTreeReferencesInertPrefix`, gap 1). A
// synthetic same-line-vs-indirection control pair confirmed the mechanism itself isn't broken — it fires
// correctly when anchor and token share a line — it is simply BLIND to this specific, real, reproduced
// shape. That blindness is not new (docs/ has carried it since card 1c0d4aa4) but it means the live
// per-repo scanner is a PERMANENTLY UNINFORMATIVE check for these five entries: it will keep clearing them
// whether or not a real reader exists, so trusting it alone would be fail-OPEN the moment someone adds an
// indirect read of one of these files — and CLAUDE.md is the proof that shape occurs in this exact corpus.
//
// So this guard uses a DIFFERENT, INDIRECTION-IMMUNE technique instead: a bare read-call-name + literal-
// filename search with NO same-line anchor requirement at all (`readFileSync\(...CLAUDE\.md`, not
// `anchor...CLAUDE\.md`) — it can't share the scanner's blind spot because it never looks for an anchor.
// It is intentionally READ-CALL-SCOPED, not a bare substring search: a naive `grep "README.md"` returns
// 200+ hits in this corpus, almost all `fs.writeFileSync(path.join(<throwaway-fixture-repo>, "README.md"),
// ...)` calls creating synthetic fixture content for git-merge tests — WRITES, not reads, and irrelevant to
// whether a real project file's content is asserted on. Scoping to the read-call vocabulary is what
// actually discriminates "this test's assertions depend on this file's bytes" from "this test happens to
// mention the string."
//
// WHAT IT PROVES, EXACTLY (card 82662e98's own mandate): a positive control — the SAME scan technique
// applied to `CLAUDE.md` must FLAG it (found, at its two known real sites) — and a pinned EXACT expected
// hit set for each of the five INERT_MERGE_EXACT_PATHS entries, asserted for EQUALITY (not just "still
// zero" or "still clear") so the guard fails LOUDLY the moment the corpus changes in EITHER direction: a
// new hit appearing (a future test reading one of these files for real — the exact regression this guard
// exists to catch) or a pinned hit disappearing (this guard's own expectations going stale). Distinguishing
// a genuinely-real read from a synthetic-fixture read reliably, by grep alone, isn't possible in general —
// so this deliberately does NOT try to auto-classify; every one of README.md's pinned hits below was
// hand-verified (card 82662e98) to read from a THROWAWAY fixture repo the test itself constructs
// (`C.repo`/`worktreePath`/`wtP2`/`repo` — all local variables holding a `git init`-ed temp dir, never this
// project's own root), and any FUTURE hit — pinned set or not — must be hand-verified the same way before
// being added here, never rubber-stamped in because the guard demands SOME expected entry.
//
// Run: node packages/daemon/test/inert-exact-path-corpus-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = __dirname;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Recursive (same reasoning as human-only-surface-leak-guard.mjs's walkTsFiles): a hit tucked into a
// subdirectory (fixtures/, census/, an underscore-prefixed helper) is just as real a concern as one at the
// top level, and nothing here should silently narrow the population it's actually checking.
function walkMjsFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...walkMjsFiles(full, base)); continue; }
    if (entry.name.endsWith(".mjs")) out.push(path.relative(base, full).replace(/\\/g, "/"));
  }
  return out;
}
const testFiles = walkMjsFiles(TEST_DIR);
check(`sanity: the test/ corpus walk found a non-trivial population (found ${testFiles.length} .mjs file(s))`, testFiles.length > 100);

// Same read-call vocabulary as the production scanner (INERT_PREFIX_READ_CALL_NAMES, git/worktrees.ts) —
// deliberately WITHOUT that scanner's same-line anchor requirement, which is exactly what makes this
// immune to the indirection gap documented above.
const READ_CALL_NAMES = "(readFileSync|readFile|existsSync|readdirSync|createReadStream|opendirSync|globSync)";
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Per-line (mirrors git grep's own per-line matching, same as the production scanner) — every real hit
// found in this corpus (card 82662e98) is single-line, and per-line is the conservative choice: a
// multi-line call would simply be missed here, same fail-toward-"nothing found" direction the production
// scanner already accepts for other shapes (see its own "MULTI-LINE CALLS" gap). Extracted as a pure
// string->count function (not tied to the filesystem walk) so it can be RED/GREEN-proofed directly below,
// same "test the classifier against literal strings" shape every sibling guard in this file's own doc
// links to (deploy-staleness-fixture-guard.mjs, failing-test-tier-pairing-guard.mjs).
function countReadCallHits(content, filename) {
  const pattern = new RegExp(`${READ_CALL_NAMES}\\([^)]*${escapeRegExp(filename)}`);
  return content.split("\n").filter((l) => pattern.test(l)).length;
}

// Returns { "relative/file.mjs": hitCount } for every file with at least one read-call-scoped hit on
// `filename`, across the real corpus.
function readCallHits(filename) {
  const hits = {};
  for (const f of testFiles) {
    const count = countReadCallHits(fs.readFileSync(path.join(TEST_DIR, f), "utf8"), filename);
    if (count > 0) hits[f] = count;
  }
  return hits;
}

// ── RED/GREEN PROOF — the matcher itself, against synthetic strings (not the real corpus) ─────────────────
// Standing doctrine: prove the check can FAIL before trusting its green. Positive-controlled against a
// deliberately bogus filename below too (the check must NOT fire on an unrelated read).
//
// Card 82662e98 (Code Review self-correction): the FIRST version of this block wrote its own fixture
// strings as a literal read-call-name immediately followed by "(" and a target filename — which this
// guard's OWN corpus walk then matched, since it scans every `.mjs` file under `test/` INCLUDING ITSELF,
// exactly the "fixture text
// matches the scanner's own pattern" trap `repoTreeReferencesInertPrefix`'s own doc already warns about
// for `merge-gate-inert-diff.mjs`'s fixtures. Same fix, same precedent: build the read-call name via
// CONCATENATION so the literal source text never contains a real "name(" pair for this guard's own regex
// to find — `mkTrigger` below does this ONCE so every fixture string here stays free of this trap without
// hand-splitting each one.
function mkTrigger(callName, expr) {
  return "fs." + callName + "(" + expr + ");";
}
check("(0) RED PROOF: a real read-call hit on the target filename IS counted",
  countReadCallHits(mkTrigger("readFileSync", 'path.join(REPO_ROOT, "README.md"), "utf8"'), "README.md") === 1);
check("(0) RED PROOF: an INDIRECTION-shaped hit (anchor on an earlier line, read on a later one) is STILL counted — no same-line anchor required, unlike repoTreeReferencesInertPrefix",
  countReadCallHits('const ROOT = path.join(__dirname, "..");\n' + mkTrigger("readFileSync", 'path.join(ROOT, "README.md")'), "README.md") === 1);
check("(0) GREEN: a WRITE (writeFileSync) is NOT counted — this scan is read-call-scoped, not a bare substring search",
  countReadCallHits(mkTrigger("writeFileSync", 'path.join(repo, "README.md"), "# ecg\\n"'), "README.md") === 0);
check("(0) GREEN: a `//` comment merely mentioning the filename near a read-call word is NOT treated as a real call",
  countReadCallHits("// see read" + "FileSync docs for how README.md gets loaded", "README.md") === 0);
check("(0) negative control: the SAME real-hit line does NOT fire for an unrelated filename",
  countReadCallHits(mkTrigger("readFileSync", 'path.join(REPO_ROOT, "README.md"), "utf8"'), "CHANGELOG.md") === 0);
check("(0) count is exact, not just truthy — two hits on two lines count as 2",
  countReadCallHits(mkTrigger("readFileSync", 'a("README.md")') + "\n" + mkTrigger("existsSync", 'b("README.md")'), "README.md") === 2);

function assertExactHits(label, filename, expected) {
  const actual = readCallHits(filename);
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  check(`${label}: read-call hits for "${filename}" match the pinned set exactly — expected ${expectedStr}, found ${actualStr}`,
    actualStr === expectedStr);
}

// ── POSITIVE CONTROL — the SAME technique must FLAG CLAUDE.md ──────────────────────────────────────────
// If this ever reads {} (no hits), the scan technique itself is broken and every "clear" below means
// nothing — this must be checked FIRST and must fail loudly on its own if it regresses.
assertExactHits("(1) positive control", "CLAUDE.md", {
  "kickoff-real-spawn.mjs": 1,
  "spawn-command-line-preflight.mjs": 1,
});

// ── THE FIVE INERT_MERGE_EXACT_PATHS ENTRIES — pinned EXACT expected sets, hand-verified as synthetic ──
// README.md's four hits are ALL against a throwaway fixture repo the test itself git-inits (never this
// project's own root) — hand-verified at card 82662e98: merge-gate.mjs/merge-union-gate.mjs read back a
// conflict-resolution fixture's README to prove which side "won"; worker-prompt.mjs/worktrees.mjs read
// back a worktree's own copy to prove branch-vs-main content diverged correctly. None assert anything
// about THIS repo's real root README.md.
assertExactHits("(2)", "README.md", {
  "merge-gate.mjs": 1,
  "merge-union-gate.mjs": 1,
  "worker-prompt.mjs": 3,
  "worktrees.mjs": 2,
});
assertExactHits("(3)", "CHANGELOG.md", {});
assertExactHits("(4)", "CODE_OF_CONDUCT.md", {});
assertExactHits("(5)", "CONTRIBUTING.md", {});
assertExactHits("(6)", "SECURITY.md", {});

console.log(failures === 0
  ? "\n✅ ALL PASS — the read-call-scoped, indirection-immune scan technique correctly FLAGS CLAUDE.md (proving it isn't just broken) and CLEARS all five INERT_MERGE_EXACT_PATHS entries against their pinned, hand-verified-synthetic hit sets. A new real (or newly-indirect) read of any of the six would change its file's hit count and fail this guard loudly, forcing manual re-verification before it's ever added to the pinned set."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
