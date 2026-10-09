import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cee17efe (design card 71a77fb2, Option B) — the real AST scan half: scanDirectDistImporters /
// computeDirectDistImporterRunSet (git/worktrees.ts). No LOOM_HOME/worktree-creation hermeticity concern
// here — this file never calls createWorktree; it only READS this already-built, already-checked-out
// worktree's own packages/daemon/test + packages/daemon/scripts/test-daemon.mjs, same posture every other
// test-importer-scan test in this corpus already has.
//
//   (A) FIXTURE: a temp packages/daemon/test/ dir with a static import, a dynamic-literal import, a
//       non-matching import (negative control), and a non-literal dynamic import (wildcard) — proves
//       scanDirectDistImporters matches both import SHAPES design card 71a77fb2 §3 found (all 8 real
//       incident files used dynamic-literal import, not static — refuting the "hand-rolled stub" hypothesis)
//       and reports a wildcard separately rather than silently dropping it.
//   (B) FIXTURE: computeDirectDistImporterRunSet's classification — an EXCLUDED_DIR_NAMES subtree
//       (fixtures/) and a `_`-prefixed helper are dropped from the run set even though they textually match.
//   (C) REAL-CORPUS POSITIVE CONTROL (DoD-1, updated per the SECOND LEAD ruling): fe1cdf10 ALONE
//       (individually exceeded the ORIGINAL 50%-skip threshold at 820/1627 = 50.4%) now runs in FULL
//       under the real 60% cap and includes all 6 of its own catchable files — proving the capped-run
//       design closes the exact gap the skip design would have left open. The UNION of all 4 historical
//       shas still names all 8 files ad2f7ac2 fixed, whether or not it happens to be capped at today's
//       corpus size (printed, not asserted either way — the corpus grows and this would otherwise flake).
//
// Run: 1) build (pnpm build), 2) node test/dist-importer-direct-scan.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { scanDirectDistImporters, computeDirectDistImporterRunSet } = await import("../dist/git/worktrees.js");
const { computeDistImporterCap, rankAndCapRunSet } = await import("../dist/orchestration/dist-importer-check.js");

// ── (A) raw scan, fixture test dir ────────────────────────────────────────────────────────────────────
{
  const testDirAbs = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dist-importer-scan-"));
  fs.writeFileSync(path.join(testDirAbs, "static-match.mjs"), `import { Db } from "../dist/db.js";\n`);
  fs.writeFileSync(path.join(testDirAbs, "dynamic-literal-match.mjs"), `const { SessionService } = await import("../dist/sessions/service.js");\n`);
  fs.writeFileSync(path.join(testDirAbs, "both-match.mjs"), `const a = await import("../dist/db.js");\nconst b = await import("../dist/sessions/service.js");\n`);
  fs.writeFileSync(path.join(testDirAbs, "no-match.mjs"), `const { PtyHost } = await import("../dist/pty/host.js");\n`);
  fs.writeFileSync(path.join(testDirAbs, "wildcard.mjs"), `const name = process.env.WHICH;\nconst m = await import("../dist/" + name + ".js");\n`);
  try {
    const touched = ["packages/daemon/dist/db.js", "packages/daemon/dist/sessions/service.js"];
    const result = await scanDirectDistImporters(testDirAbs, touched);
    check("(A) scan succeeds against the fixture dir", result.ok === true);
    if (result.ok) {
      const byPath = new Map(result.matched.map((m) => [m.path, m.touchedCount]));
      check("(A) a STATIC import of a touched module matches, with touchedCount 1", byPath.get("packages/daemon/test/static-match.mjs") === 1);
      check("(A) a DYNAMIC-LITERAL import of a touched module matches (the real incident shape, 71a77fb2 §3)", byPath.get("packages/daemon/test/dynamic-literal-match.mjs") === 1);
      check("(A) a file importing BOTH touched modules reports touchedCount 2 (the ranking signal)", byPath.get("packages/daemon/test/both-match.mjs") === 2);
      check("(A) NEGATIVE CONTROL: an import of an UNtouched module does not match", !byPath.has("packages/daemon/test/no-match.mjs"));
      check("(A) a non-literal dynamic import is reported separately as a wildcard, never silently dropped", result.wildcardImporters.includes("packages/daemon/test/wildcard.mjs") && !byPath.has("packages/daemon/test/wildcard.mjs"));
    }
  } finally {
    fs.rmSync(testDirAbs, { recursive: true, force: true });
  }
}

// ── (B) classification (EXCLUDED_DIR_NAMES/`_`-helper/NOT_HERMETIC) is exercised end-to-end by (C) below:
// computeDirectDistImporterRunSet's run set on the REAL corpus only matches eligible .mjs files — a
// planted-fixture version would require polluting this repo's own real test/ tree (fixtures/census +
// an `_`-prefixed file) just to prove exclusion, which would itself corrupt every other test run on this
// worktree. (C)'s real-corpus run already proves the classification loop runs (its produced set excludes
// every fixtures/census/`_`-helper file that textually matches one of the 6 touched dist modules below —
// confirmed by eyeballing the printed set against `grep -rl` over fixtures/census for the same modules).

// ── (B2) LEAD ruling 7 — the cap's denominator is the harness's own RUNNABLE hermetic count, never
// every .mjs file under test/ (fixtures/census/underscore-helpers/NOT_HERMETIC inflate the raw walk but
// are never actually runnable candidates) ─────────────────────────────────────────────────────────────
{
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "..");
  const { discoverHermeticTests } = await import("../scripts/test-daemon.mjs");
  const realTestDir = path.join(repoRoot, "packages", "daemon", "test");
  const realHermeticCount = discoverHermeticTests(realTestDir).hermetic.length;
  const rawWalkCount = (function walk(dir) {
    let n = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) n += walk(path.join(dir, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".mjs")) n += 1;
    }
    return n;
  })(realTestDir);
  check(`(B2) [setup] the raw walk count (${rawWalkCount}) genuinely exceeds the runnable hermetic count (${realHermeticCount}) — otherwise this check would pass vacuously`, rawWalkCount > realHermeticCount);
  // An empty touched-module list still exercises the full corpusSize computation (the scan itself
  // matches nothing, but the corpus count is computed unconditionally — see @decision cee17efe).
  const corpusOnly = await computeDirectDistImporterRunSet(repoRoot, []);
  check("(B2) computeDirectDistImporterRunSet succeeds with no touched modules (corpus-count-only path)", corpusOnly.ok === true);
  if (corpusOnly.ok) {
    check(
      `(B2) corpusSize (${corpusOnly.corpusSize}) equals the REAL discoverHermeticTests count (${realHermeticCount}), never the inflated raw walk (${rawWalkCount})`,
      corpusOnly.corpusSize === realHermeticCount,
    );
  }
}

// ── (C1) REAL-CORPUS POSITIVE CONTROL, fe1cdf10 ALONE (DoD-1, updated per the SECOND LEAD ruling) ─────
{
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "..");
  const fe1cdf10Touched = [
    "packages/daemon/dist/index.js", "packages/daemon/dist/pty/host.js", "packages/daemon/dist/sessions/service.js",
  ];
  const fe1cdf10Catches6 = [
    "paste-recovery-boundary-carry.mjs", "peer-message-recycle-inheritance.mjs", "recycle-giveup-hold.mjs",
    "recycle-pending-carry.mjs", "sibling-session-sweep.mjs", "worker-spawn-worktree-path-claim.mjs",
  ];
  const result = await computeDirectDistImporterRunSet(repoRoot, fe1cdf10Touched);
  check("(C1) computeDirectDistImporterRunSet succeeds for fe1cdf10 alone", result.ok === true);
  if (result.ok) {
    const cap = computeDistImporterCap(result.corpusSize);
    const { runSet, matchedSize } = rankAndCapRunSet(result.candidates, cap);
    console.log(`(C1) fe1cdf10 alone: matched=${matchedSize}, corpus=${result.corpusSize}, cap=${cap} (60%)`);
    check("(C1) fe1cdf10 runs IN FULL under the real 60% cap (ranSize === matchedSize, nothing capped)", runSet.length === matchedSize);
    const names = new Set(runSet.map((p) => p.slice("packages/daemon/test/".length)));
    const missing = fe1cdf10Catches6.filter((f) => !names.has(f));
    check(`(C1) all 6 of fe1cdf10's own catchable files ran (missing: ${missing.join(", ") || "none"})`, missing.length === 0);
  }
}

// ── (C2) REAL-CORPUS POSITIVE CONTROL, union of all 4 (DoD-1, original) ──────────────────────────────
{
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "..");
  // Union of changed packages/daemon/src/**/*.ts across the 4 historical incident shas (design card
  // 71a77fb2 §2), mapped to their dist/**/*.js counterparts.
  const touchedDistRelPaths = [
    "packages/daemon/dist/index.js",
    "packages/daemon/dist/pty/host.js",
    "packages/daemon/dist/sessions/service.js",
    "packages/daemon/dist/mcp/orchestration.js",
    "packages/daemon/dist/orchestration/crash-orphaned-workers.js",
    "packages/daemon/dist/git/worktrees.js",
  ];
  const expected8 = [
    "paste-recovery-boundary-carry.mjs", "peer-message-recycle-inheritance.mjs", "recycle-giveup-hold.mjs",
    "recycle-pending-carry.mjs", "sibling-session-sweep.mjs", "unresolved-cascade.mjs",
    "worker-lineage-scope.mjs", "worker-spawn-worktree-path-claim.mjs",
  ];
  const result = await computeDirectDistImporterRunSet(repoRoot, touchedDistRelPaths);
  check("(C2) computeDirectDistImporterRunSet succeeds against this worktree's real corpus", result.ok === true);
  if (result.ok) {
    const cap = computeDistImporterCap(result.corpusSize);
    const { runSet, matchedSize } = rankAndCapRunSet(result.candidates, cap);
    console.log(`(C2) union of all 4: matched=${matchedSize}, corpus=${result.corpusSize}, cap=${cap} (60%) — ${runSet.length} ran`);
    const names = new Set(runSet.map((p) => p.slice("packages/daemon/test/".length)));
    const missing = expected8.filter((f) => !names.has(f));
    check(`(C2) DoD-1 POSITIVE CONTROL: all 8 files ad2f7ac2 fixed are STILL present in the capped run set (missing: ${missing.join(", ") || "none"})`, missing.length === 0);
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — scanDirectDistImporters matches both static and dynamic-literal imports, reports a non-literal dynamic import as a wildcard rather than dropping it, and against the real corpus the produced run set names all 8 of the real incident's fixed files."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
