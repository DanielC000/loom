// ─────────────────────────────────────────────────────────────────────────────────────────────
// run-static-guards.mjs — runs exactly `STATIC_GUARD_REPO_PATHS` (card 245a3708).
//
// WHY THIS EXISTS: `CLAUDE.md` documents `grep -l readdirSync packages/daemon/test/*guard*.mjs` BY NAME
// as an unmaintained folk recipe that answers a DIFFERENT question than "which guards does the merge
// gate always run" — it found its way into six card bodies anyway, because a worker who needs to run
// "the static guards" had no single command to reach for and reinvented one from memory. This script is
// that command, so there is nothing left to reinvent.
//
// It NEVER restates the guard list — it imports `STATIC_GUARD_REPO_PATHS` from the one authoritative
// definition (`src/git/worktrees.ts`, compiled to `dist/git/worktrees.js`), the same constant
// `buildReducedGateCommand` derives its own `node <path>` steps from. A second hardcoded copy here would
// be strictly worse than the folk recipe it replaces — it would look authoritative.
//
// RUN (from anywhere — this script resolves the repo root itself):
//   pnpm --filter @loom/daemon build   # dist/ must reflect the current guard list first
//   pnpm --filter @loom/daemon guards            # quiet by default — see below
//   pnpm --filter @loom/daemon guards:verbose     # full per-assertion output, no summarizing
// Non-zero exit iff any guard fails; prints which guard ran and which (if any) failed, so the output is
// pasteable as evidence. REFUSES (non-zero exit, no guards run) if `dist/git/worktrees.js` is missing or
// looks older than `src/git/worktrees.ts` — see the freshness check below for why: this script's whole
// job is catching a silent skip, so it must never BE one itself.
//
// QUIET IS THE DEFAULT (card 616e5ec2, half 2 — flipped from an opt-in `--quiet` after review: the
// reduced/merge gate never runs through this script at all — `buildReducedGateCommand` invokes each
// guard directly via its own `node <path>` step — and no test parses this script's own stdout, so there
// was no real consumer an opt-in was protecting; the thing that needed protecting was the FLEET, which
// gets this by default now). Every guard here prints one `PASS  <label>` / `FAIL  <label>` line per
// assertion via the identical `check()` helper each guard file defines independently — across ~13-16
// guards that's several thousand chars of pass-noise even on a fully green run (the card measured a
// single invocation truncated at +9442 chars even piped through `| tail -n 100`). Workers reached for
// that `| tail` to contain it, which broke `$?` (`tail`'s exit code, not the guard's — CLAUDE.md already
// warns about this in prose; session `a3f48a8f` hit it for real and reported "both checkers green" on a
// check that had never actually run). The default now collapses a PASSING guard's own PASS/FAIL lines to
// one summary line (`OK  <path>  (N check(s))`, counted straight from its own stdout, no guard-side
// change needed) and prints a FAILING guard's output IN FULL — never swallowed, so a failure stays fully
// diagnosable — with exit-code semantics unchanged either way. Piping is no longer needed to contain the
// output, so the `| tail` footgun this exists to remove has nothing left to reach for. Pass `--verbose`
// for the pre-616e5ec2 behavior (every guard's full output inline, no summarizing) — a human debugging
// interactively, not a worker's default reflex before committing.
//
// A QUIET-MODE-ONLY BONUS: because this path is the only one that actually PARSES a guard's own output
// (the old/`--verbose` path pipes straight through via `stdio:"inherit"` and never sees it), it can catch
// something `--verbose` structurally cannot — a guard that PRINTS `FAIL` line(s) yet still exits `0`. That
// contradiction is exactly the false-green class this whole card exists to police, so it's asserted below
// and treated as a guard failure even though the process exit code alone said otherwise.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireFreshDist } from "./lib/dist-freshness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(here, "..");
const repoRoot = path.resolve(daemonRoot, "..", "..");
const srcPath = path.join(daemonRoot, "src", "git", "worktrees.ts");
const distPath = path.join(daemonRoot, "dist", "git", "worktrees.js");

// FRESHNESS CHECK: without this, a stale `dist/` silently runs the OLD guard list and still prints a
// clean "all passed" — exactly the silent-skip failure this command exists to replace (a guard someone
// just added to STATIC_GUARD_REPO_PATHS would never run, and nothing would say so). REFUSE rather than
// warn-and-continue: a warning above a green summary is exactly what gets read past. This is a heuristic,
// not a build-correctness proof — a touched file, clock skew, or an unrelated edit to worktrees.ts can
// all trip it — but it fails toward VISIBLE, which is the property that matters here.
requireFreshDist({
  label: "guards",
  srcPath,
  distPath,
  buildCommand: "pnpm --filter @loom/daemon build",
  staleDetail: "dist/ may not reflect the current guard list",
  rerunCommand: "pnpm --filter @loom/daemon guards",
});

// file:// URL required for a dynamic import() on Windows — a bare drive-letter absolute path throws
// ERR_UNSUPPORTED_ESM_URL_SCHEME (same gotcha `backfill-transcripts.mjs` already works around).
const { STATIC_GUARD_REPO_PATHS } = await import(pathToFileURL(distPath).href);

const verbose = process.argv.includes("--verbose");

// Every guard's own `check(label, cond)` helper (independently defined, but byte-identical across all of
// them — verified by grep before relying on it) prints exactly `PASS  <label>` / `FAIL  <label>`, so this
// count is read straight off a guard's REAL output, never estimated or hardcoded per guard.
function countChecks(output) {
  const passCount = (output.match(/^PASS  /gm) ?? []).length;
  const failCount = (output.match(/^FAIL  /gm) ?? []).length;
  return { passCount, failCount, total: passCount + failCount };
}

const failed = [];
for (const repoRelPath of STATIC_GUARD_REPO_PATHS) {
  if (verbose) {
    console.log(`[guards] running ${repoRelPath}`);
    const result = spawnSync(process.execPath, [repoRelPath], { cwd: repoRoot, stdio: "inherit" });
    if (result.status === 0) {
      console.log(`[guards] OK: ${repoRelPath}`);
    } else {
      console.error(`[guards] FAILED: ${repoRelPath} (exit ${result.status})`);
      failed.push(repoRelPath);
    }
  } else {
    const result = spawnSync(process.execPath, [repoRelPath], { cwd: repoRoot, encoding: "utf8" });
    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const { total, failCount } = countChecks(combined);
    if (result.status === 0 && failCount === 0) {
      console.log(`[guards] OK  ${repoRelPath}${total > 0 ? `  (${total} check(s))` : ""}`);
    } else if (result.status === 0 && failCount > 0) {
      // The false-green class this whole card exists to police: the guard's own check() helper recorded
      // FAIL line(s) but the process still exited 0. --verbose would never see this (it never parses the
      // output); quiet mode is the only path that can, so it asserts on it rather than trusting the exit
      // code alone.
      console.error(`[guards] ⛔ FALSE GREEN: ${repoRelPath} exited 0 but printed ${failCount} FAIL line(s) — treating as a guard failure:`);
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      failed.push(repoRelPath);
    } else {
      // Full output on a real (non-zero-exit) failure, never swallowed — quiet only compresses the
      // passing case.
      console.error(`[guards] FAILED: ${repoRelPath} (exit ${result.status})`);
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      failed.push(repoRelPath);
    }
  }
}

if (failed.length > 0) {
  console.error(`[guards] ${failed.length}/${STATIC_GUARD_REPO_PATHS.length} guard(s) failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`[guards] all ${STATIC_GUARD_REPO_PATHS.length} guard(s) passed`);
