import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure fs text scan below, no Db used
// STANDING GUARD (card a6b1c4c7) — catches a brand-new `path.join(os.tmpdir(), <fully fixed literal>)`
// fixture before it ships, the same shape that made merge-commit-kill-confirm.mjs's `makeRepo`/
// `makeWorktree` collide: two CONCURRENT invocations of the SAME test file (two worker `run_gate`s
// admitted at once, which now happens routinely) computed the IDENTICAL `os.tmpdir()`-relative path —
// `path.join(os.tmpdir(), \`loom-killconfirm-${tag}\`)` called as `makeRepo("positive-control")` — so one
// run's `git init -q` collided with the other's mid-init, and either run's cleanup could delete the
// other's still-live repo. Fixed by switching to `mkdtempManaged` (`_tmp-fixture.mjs`), which mints an
// atomically-unique dir regardless of what the caller passes.
//
// ⚠️ STATED SCOPE, READ BEFORE TRUSTING A GREEN RUN: this guard only sees a literal with ZERO `${...}`
// interpolation sitting DIRECTLY as `path.join(os.tmpdir(), <here>)`'s second argument — a plain string or
// a template literal with no substitution at all. It does NOT, and structurally cannot, catch the exact
// shape that caused THIS card's own incident: a parameterized helper (`path.join(os.tmpdir(), \`prefix-
// ${tag}\`)`) called with a hardcoded STRING LITERAL argument for `tag` at one specific call site while
// its sibling call sites pass a genuinely per-run-unique value. That needs call-site/parameter tracing —
// a much bigger, different kind of check (same honesty posture as clock-path-regression-guard.mjs's own
// "WHAT THIS STILL CANNOT SEE" section, which this guard's structure otherwise mirrors) — so a human
// reviewing a new test-fixture-constructing function must still judge whether EVERY caller supplies a
// value that varies per run, not just per call within one run. This guard narrows the cheaper, fully
// mechanical sub-case: a literal with no interpolation at all, which is unambiguously fixed regardless of
// caller.
//
// SAFE BY CONSTRUCTION, NEVER FLAGGED: a match whose line also contains `mkdtempSync(` — `fs.mkdtempSync`
// appends 6 kernel-random characters to whatever prefix it's given, so the literal being fixed is
// irrelevant; this is the SAME safe idiom `mkdtempManaged` (`_tmp-fixture.mjs`) wraps.
//
// BASELINE KEY = (file, trimmed line text) — not (file, line number); mirrors clock-path-regression-
// guard.mjs's own reasoning: a line-numbered key would turn an unrelated nearby edit into a spurious NEW
// violation, while editing the flagged line itself (the moment a human should re-audit it) correctly
// invalidates its baseline entry.
//
// Each entry below was individually read at card a6b1c4c7 and confirmed to never create a real
// file/directory at the literal path — grouped by the shape that makes each one safe. Re-verify a site's
// classification if its surrounding code changes; do not add a new entry here without reading what it
// actually does, per this file's own rule.
//
// ✅ POSITIVE CONTROL (run manually, not part of this file's own execution):
//   1. `git show HEAD~1:packages/daemon/test/merge-commit-kill-confirm.mjs` (the pre-fix revision carried
//      `path.join(os.tmpdir(), \`loom-killconfirm-${tag}\`)`, which has interpolation, so even the OLD file
//      would not trip this guard directly — see the scope note above). To exercise this guard's own
//      detector positively, temporarily add a line like `const x = path.join(os.tmpdir(), "a-fixed-name");`
//      to any test file and confirm this guard FAILS, naming it; then remove it and confirm PASS again.
//
// Run: node packages/daemon/test/fixed-tmpdir-literal-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = __dirname;
const SELF = path.basename(__filename);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Matches path.join(os.tmpdir(), <quoted literal>) on one line, either quote style. Captures the literal
// body in group 2 so the caller can test it for `${` interpolation.
const TMPDIR_JOIN_RE = /path\.join\(\s*os\.tmpdir\(\)\s*,\s*(["'`])((?:\\.|(?!\1).)*?)\1\s*\)/g;

const KNOWN_FIXED_LITERAL_DEBT = new Map([
  // Process-wide LOCK / CACHE singleton paths — deliberately fixed (one lock, one cache, shared by design
  // across every process on the host), not a per-test fixture at all.
  ["_codex-real-spawn-lock.mjs", [
    'const LOCK_PATH = process.env.LOOM_CODEX_REAL_SPAWN_LOCK_PATH || path.join(os.tmpdir(), "loom-codex-real-spawn.lock"); // env: hermetic-test seam (card fb119c4c)',
    'const PROBE_CACHE_PATH = process.env.LOOM_CODEX_USAGE_PROBE_CACHE || path.join(os.tmpdir(), "loom-codex-usage-probe.json"); // env: hermetic-test seam',
  ]],
  // "Deliberately nonexistent codex binary" probes — LOOM_CODEX_BIN is pointed at a path that must NEVER
  // exist (simulates "codex binary missing"); nothing is ever created at it, so a fixed name is the point.
  ["batch-merge-branch-diverted-no-fallback.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["batch-merge-divert-unverified-nudge-text.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["batch-merge-diverted-not-cached.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["batch-merge-ff-unverified-no-fallback.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["batch-merge-mainline-advanced-post-ff.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["batch-merge-watermark-branch-pin.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["canonical-git-isolation.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-cgi-no-such-codex-bin");']],
  ["mainline-watch-batch-edges.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-batch.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-boot-dedupe.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-boot-reader.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-boot.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-bounds.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-ff-unverified.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-reads.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-rebind-reset.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-spawns.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["merge-confirm-dirty-gate-verdict-cache-retry-and-guard.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcdg-nonexistent-codex");']],
  ["merge-confirm-dirty-gate-verdict-cache.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcdg-nonexistent-codex");']],
  ["merge-confirm-fail-identity-void-links.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcfil-nonexistent-codex");']],
  ["merge-confirm-fail-identity-void.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcfiv-nonexistent-codex");']],
  ["merge-confirm-gate-tip-round-trip.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcgtrt-nonexistent-codex");']],
  ["merge-confirm-gated-tip-squash.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcgt-nonexistent-codex");']],
  ["merge-confirm-inert-skip-pin.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcisp-nonexistent-codex");']],
  ["merge-confirm-reuse-head-rule.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcrhr-nonexistent-codex");']],
  ["merge-confirm-solo-finalize-tip-cas.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcsf-nonexistent-codex");']],
  ["merge-reviewed-tip-refusal.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mrt-no-such-codex-bin");']],
  // Pure-function / passthrough probes — the literal path is an argument value asserted to flow through
  // unchanged; nothing ever reads or writes the path on disk.
  ["comment-anchor-lint-hook.mjs", ['isInScope(REPO, path.join(os.tmpdir(), "elsewhere.ts")) === null);']],
  ["harness-adapter-delegates.mjs", ['const absolute = path.join(os.tmpdir(), "not-a-real-binary-xyz");']],
  // DB-only / config-string fixtures — the literal is stored as a STRING VALUE (a vaultPath override) and
  // compared back from the Db; never fs-read or fs-written at that path.
  ["mgmt-project-agent.mjs", ['const newVaultPath = path.join(os.tmpdir(), "new-vault");']],
  ["mgmt-surface.mjs", ['const newVaultPath = path.join(os.tmpdir(), "m2");']],
  ["platform-mgmt-surface.mjs", ['const newVaultPath = path.join(os.tmpdir(), "ord2");']],
  // DB-key-only identifiers — p1/p2 are only ever used as string keys into this file's OWN isolated,
  // per-process LOOM_HOME's sqlite db (wedged-worktree tracking); never touched on the real filesystem.
  ["worktree-wedge-retry.mjs", [
    'const p1 = path.join(os.tmpdir(), "loom-wwr-unit-1");',
    'const p2 = path.join(os.tmpdir(), "loom-wwr-unit-2");',
  ]],
]);

function baselineHas(map, file, text) {
  return map.get(file)?.includes(text) ?? false;
}

function walkTestFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs") && f !== SELF);
}

function classifyFile(file) {
  const text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.includes("mkdtempSync(")) continue; // SAFE BY CONSTRUCTION — see header
    TMPDIR_JOIN_RE.lastIndex = 0;
    let m;
    while ((m = TMPDIR_JOIN_RE.exec(raw)) !== null) {
      const literal = m[2];
      if (literal.includes("${")) continue; // has interpolation — out of this guard's stated scope
      hits.push({ file, lineNo: i + 1, text: raw.trim() });
    }
  }
  return hits;
}

// ── Population/scope sanity — the matcher is shown capable of finding a REAL hit before trusting any
// zero it reports elsewhere (same discipline clock-path-regression-guard.mjs's own sanity check uses). ──
const sampleFile = "worktree-wedge-retry.mjs";
const sampleHits = classifyFile(sampleFile);
check(`sanity: the matcher DOES find the known-present worktree-wedge-retry.mjs baseline sites (found ${sampleHits.length}, expect 2 — confirms the pattern isn't vacuously matching nothing)`,
  sampleHits.length === 2);

const files = walkTestFiles();
const newViolations = [];
let knownDebtSeen = 0;

for (const file of files) {
  for (const hit of classifyFile(file)) {
    if (baselineHas(KNOWN_FIXED_LITERAL_DEBT, hit.file, hit.text)) knownDebtSeen++;
    else newViolations.push(hit);
  }
}

// Negative control: a pattern that must NOT match anything in this corpus — proves the regex itself isn't
// so loose it would match arbitrary unrelated text (e.g. a bogus function name).
const bogusHits = files.flatMap((file) =>
  fs.readFileSync(path.join(TEST_DIR, file), "utf8").split("\n")
    .filter((l) => /definitelyNotARealFunctionCallXyz123\(\s*os\.tmpdir\(\)/.test(l)));
check(`negative control: a bogus pattern finds zero hits (found ${bogusHits.length})`, bogusHits.length === 0);

check(`no NEW fixed-literal (zero-interpolation) path.join(os.tmpdir(), ...) sites outside the baseline (found ${newViolations.length}; ${knownDebtSeen} known-debt sites carried forward, each individually audited at card a6b1c4c7 — see the KNOWN_FIXED_LITERAL_DEBT header)`,
  newViolations.length === 0);
for (const v of newViolations) console.log(`  NEW-FIXED-LITERAL  ${v.file}:${v.lineNo}  ${v.text}`);

console.log(failures === 0
  ? `\n✅ ALL PASS — no new/regressed fixed-literal os.tmpdir() fixture sites. ${knownDebtSeen} known-debt sites carried forward (all individually audited, see header). Stated scope limit: this guard cannot see a parameterized helper called with a hardcoded literal argument (the exact shape of this card's own incident) — only a literal with zero interpolation at the use site. A new test-fixture-constructing function still needs a human to judge whether every caller supplies a per-run-unique value.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
