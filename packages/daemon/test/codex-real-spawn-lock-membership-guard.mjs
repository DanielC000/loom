import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text scan below, no Db used
// STANDING GUARD (card 3791b14e, lead-requested follow-up): every test file that imports
// `acquireCodexRealSpawnLock` from `_codex-real-spawn-lock.mjs` MUST have its own basename registered in
// that module's `CODEX_REAL_SPAWN_BASENAMES` — the single source of truth `scripts/test-daemon.mjs` reads
// to schedule the whole real-codex-spawn family sequentially (that card's own fix). A file that calls the
// lock WITHOUT being registered silently runs in the ORDINARY CONCURRENT POOL alongside real `codex`
// processes instead — passing standalone, failing intermittently only once it collides with a sibling
// under real gate contention, the exact class card 3791b14e exists to remove, re-entering through the one
// door its own fix left open. This guard closes it structurally: a new contender that forgets to register
// fails LOUD, at guard time, hermetically — never silently at gate time under real contention.
//
// MOTIVATING INCIDENT: a sibling worker (card `fedef6a0`) committed `codex-submit-confirmation-real-
// spawn.mjs` — a genuine new caller — on their own branch, protected only by a TODO comment and a card
// note. Per project memory (`shipping-a-detector-is-not-someone-reading-it`), a passive notice is measured
// at ~0% acted-on; this guard is the addressed-directive alternative: a CHECK, not a comment.
//
// WHY A CORPUS-WIDE readdirSync SCAN (this array's own dominant shape), NOT a diff-scoped one: a
// brand-new, entirely UNCOMMITTED file already exists on disk the moment it's created, in whatever
// worktree it lives in — a diff-scoped check (this array's one exception, `fixed-wait-witness-guard.mjs`,
// diffs against committed HEAD) would be BLIND to it until a commit lands, which is exactly the window
// this guard needs to close (a worker runs `pnpm --filter @loom/daemon guards` before committing, per this
// project's own doctrine). A readdirSync walk sees the file the instant it exists, committed or not.
//
// WHY HERE (a static guard) AND NOT INSIDE `_codex-real-spawn-lock.mjs` ITSELF: a runtime check inside
// `acquireCodexRealSpawnLock()` (e.g. inspecting a stack trace for the caller's own module) would only
// fire the FIRST TIME the offending file actually EXECUTES a real codex spawn — exactly the late,
// expensive, contention-dependent failure mode this guard exists to avoid, and stack-trace-based caller
// identification is fragile across Node versions/minification in a way a plain source-text scan is not.
//
// ⚠️ KNOWN BLIND SPOTS — stated plainly, not chased with a broader pattern (a wider regex risks false
// positives on a guard that runs on EVERY reduced gate, and the dominant real path — copy an existing
// caller — is exactly what this covers today). This guard does NOT see:
//   - a NAMESPACE import: `import * as lock from "./_codex-real-spawn-lock.mjs"` then
//     `lock.acquireCodexRealSpawnLock()` — the regex requires a named `{ ... }` import list, which a
//     namespace import never has.
//   - a DYNAMIC import: `const { acquireCodexRealSpawnLock } = await import("./_codex-real-spawn-lock.mjs")`
//     — the regex requires the literal static `import { ... } from "..."` syntax; a dynamic `await
//     import(...)` call has no `from` keyword and doesn't match it.
//   - a caller in a SUBDIRECTORY of `test/` — DOUBLY uncovered: the specifier anchor (`\.\/…`) only
//     matches a same-directory relative import (a subdirectory file would need `../_codex-real-spawn-
//     lock.mjs`), AND the corpus scan itself is `readdirSync(TEST_DIR)` with no `{ recursive: true }`, so
//     such a file is never even READ, independent of what its import looks like.
// If a future caller takes one of these shapes, this guard will not catch it silently — a real gap, not a
// theoretical one, and worth knowing before trusting a green here as complete.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_REAL_SPAWN_BASENAMES, CODEX_REAL_SPAWN_SET } from "./_codex-real-spawn-lock.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCK_MODULE_BASENAME = "_codex-real-spawn-lock";
// This guard's OWN basename, derived (not hardcoded) so a future rename can't silently reopen this hole.
// Excluded from the real-corpus scan below for the same reason LOCK_MODULE_BASENAME is: this file's own
// SANITY/RED-PROOF sections below contain the real import string as a synthetic TEXT FIXTURE (to test the
// detector itself) — a real, measured self-match on first run (this file flagged itself as a "violation"
// before this exclusion existed), not a hypothetical. Excluding by basename, not by skipping "any file
// matching the pattern for a non-import reason", keeps the exclusion narrow and auditable — it does not
// weaken the check against any OTHER file.
const OWN_BASENAME = path.basename(fileURLToPath(import.meta.url), ".mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hoisted to a named constant (not inlined as `return /.../.test(text)`) — this project's own
// `failing-test-tier-pairing-guard.mjs` sanitizes regex literals out of its OWN brace-balance scan via a
// standard "does the last significant character end a value" heuristic, and that heuristic — by its own
// documented design, not a bug introduced here — treats a `/` immediately after the KEYWORD `return`
// (which ends in the letter "n", a VALUE_END_RE match) as a division operator, not a regex start, so
// `return /regex/` would have had this literal's own escaped `\{`/`\}` miscounted as real, unmatched
// structural braces. `const X = /regex/;` avoids this: `=` is not a value-ending character under that same
// heuristic, so it's correctly recognized as a regex there instead. Verified directly: `pnpm --filter
// @loom/daemon guards` failed with "unmatched \"}\"" against this file before this change, clean after.
const CODEX_LOCK_IMPORT_RE = /import\s*\{[^}]*\bacquireCodexRealSpawnLock\b[^}]*\}\s*from\s*["']\.\/_codex-real-spawn-lock\.mjs["']/;

/**
 * Does `text` import `acquireCodexRealSpawnLock` FROM `./_codex-real-spawn-lock.mjs` specifically (never
 * a bare mention of the identifier elsewhere, e.g. a comment, a differently-named local, or an import from
 * some other path)? Requires the named-import brace list AND the exact relative specifier every real
 * caller uses today (all four are siblings of the lock file in this same directory) — proven against both
 * shapes below before trusting it against the real corpus.
 */
function importsCodexLock(text) {
  return CODEX_LOCK_IMPORT_RE.test(text);
}

/** The actual classifier: given {basename: fileText} entries, which basenames import the lock but are NOT
 *  registered in `codexSet`? The lock module's own definition (LOCK_MODULE_BASENAME) is excluded — it
 *  defines `acquireCodexRealSpawnLock`, it never imports it, so it can never match `importsCodexLock`
 *  anyway, but excluded explicitly rather than relying on that as an accident. Exported-shaped (a plain
 *  function, not inlined into the real-corpus loop below) so the RED/GREEN proofs below can drive it
 *  directly against synthetic input before it ever touches a real file. */
function findViolations(basenameToText, codexSet) {
  const violations = [];
  for (const [basename, text] of Object.entries(basenameToText)) {
    if (basename === LOCK_MODULE_BASENAME) continue;
    if (importsCodexLock(text) && !codexSet.has(basename)) violations.push(basename);
  }
  return violations;
}

// --- Sanity / positive+negative controls on the DETECTOR ITSELF, before trusting it against real files ---

check(
  "sanity: a synthetic import shaped exactly like the four real call sites IS detected (positive control)",
  importsCodexLock('import { acquireCodexRealSpawnLock } from "./_codex-real-spawn-lock.mjs";'),
);
check(
  "sanity: a synthetic import naming acquireCodexRealSpawnLock ALONGSIDE other named imports is STILL detected",
  importsCodexLock('import { foo, acquireCodexRealSpawnLock, bar } from "./_codex-real-spawn-lock.mjs";'),
);
check(
  "sanity: a bare COMMENT mentioning the identifier and the module path is NOT detected as a real import (negative control)",
  !importsCodexLock('// see acquireCodexRealSpawnLock in _codex-real-spawn-lock.mjs for the mechanism'),
);
check(
  "sanity: a LOCALLY-DEFINED same-named function (no import from the real module at all) is NOT detected (negative control)",
  !importsCodexLock('async function acquireCodexRealSpawnLock() { /* unrelated shadow, not the real one */ }'),
);
check(
  "sanity: an import of a DIFFERENT name from the SAME module path is NOT detected",
  !importsCodexLock('import { CODEX_REAL_SPAWN_SET } from "./_codex-real-spawn-lock.mjs";'),
);

// --- The classifier logic itself: RED proof (must be able to fail) before trusting a real-corpus zero ---

{
  // Reproduces the MOTIVATING INCIDENT's exact shape: a new, unregistered basename whose source imports
  // the lock, alongside an already-registered one that also imports it (must NOT be flagged).
  const syntheticCorpus = {
    "codex-doctrine-real-spawn": 'import { acquireCodexRealSpawnLock } from "./_codex-real-spawn-lock.mjs";',
    "codex-submit-confirmation-real-spawn": 'import { acquireCodexRealSpawnLock } from "./_codex-real-spawn-lock.mjs";',
    "some-unrelated-test": 'import { thing } from "./thing.mjs";',
  };
  const violations = findViolations(syntheticCorpus, CODEX_REAL_SPAWN_SET);
  check(
    "RED PROOF: an unregistered basename that imports the lock IS flagged (reproduces the motivating incident)",
    violations.includes("codex-submit-confirmation-real-spawn"),
  );
  check(
    "GREEN: an ALREADY-registered basename that imports the lock is NOT flagged",
    !violations.includes("codex-doctrine-real-spawn"),
  );
  check(
    "GREEN: a file that doesn't import the lock at all is NOT flagged",
    !violations.includes("some-unrelated-test"),
  );
  check("RED PROOF's violation count is exactly 1, not vacuously 0 or over-broad", violations.length === 1);
}

// --- Population sanity: the real source set itself must be non-trivial ---

check(`sanity: CODEX_REAL_SPAWN_BASENAMES is non-empty (found ${CODEX_REAL_SPAWN_BASENAMES.length})`, CODEX_REAL_SPAWN_BASENAMES.length > 0);

// --- The real assertion, over the real corpus (readdirSync — sees an uncommitted new file too) ---

const realFiles = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs"));
const basenameToText = {};
for (const f of realFiles) {
  const basename = f.slice(0, -".mjs".length);
  if (basename === OWN_BASENAME) continue; // see OWN_BASENAME's own doc — this file's synthetic fixtures self-match
  basenameToText[basename] = fs.readFileSync(path.join(TEST_DIR, f), "utf8");
}
const realCallers = Object.keys(basenameToText).filter((b) => b !== LOCK_MODULE_BASENAME && importsCodexLock(basenameToText[b]));

// ⭐ Positive-control the pattern against the REAL corpus specifically — a zero-violation result below is
// only evidence if the detector is proven to actually SEE the real callers, not just synthetic fixtures.
const missingKnownCallers = CODEX_REAL_SPAWN_BASENAMES.filter((b) => !realCallers.includes(b));
check(
  `sanity: the import-detection pattern matches ALL ${CODEX_REAL_SPAWN_BASENAMES.length} known real callers against the REAL corpus, not just synthetic fixtures (missing: ${JSON.stringify(missingKnownCallers)})`,
  missingKnownCallers.length === 0,
);
check(`sanity: real callers found in the corpus (found ${realCallers.length}: ${JSON.stringify(realCallers.sort())})`, realCallers.length > 0);

const realViolations = findViolations(basenameToText, CODEX_REAL_SPAWN_SET);
check(
  `every real caller of acquireCodexRealSpawnLock() is a registered member of CODEX_REAL_SPAWN_BASENAMES (found ${realViolations.length} violation(s): ${JSON.stringify(realViolations)})`,
  realViolations.length === 0,
);

console.log(failures === 0
  ? "\n✅ ALL PASS — the import-detection pattern is proven both ways on synthetic fixtures (a real-shaped import is caught, a comment/shadow/different-name/different-path is not), the classifier itself is RED-PROVEN against a synthetic reproduction of the motivating incident (an unregistered caller is flagged, a registered one and a non-caller are not, with an exact violation count), the pattern is positive-controlled against all real known callers before trusting the real corpus, and every real test file in this directory that imports acquireCodexRealSpawnLock is currently a registered member of CODEX_REAL_SPAWN_BASENAMES."
  : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
