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
//   pnpm --filter @loom/daemon guards
// Non-zero exit iff any guard fails; prints which guard ran and which (if any) failed, so the output is
// pasteable as evidence. REFUSES (non-zero exit, no guards run) if `dist/git/worktrees.js` is missing or
// looks older than `src/git/worktrees.ts` — see the freshness check below for why: this script's whole
// job is catching a silent skip, so it must never BE one itself.
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

const failed = [];
for (const repoRelPath of STATIC_GUARD_REPO_PATHS) {
  console.log(`[guards] running ${repoRelPath}`);
  const result = spawnSync(process.execPath, [repoRelPath], { cwd: repoRoot, stdio: "inherit" });
  if (result.status === 0) {
    console.log(`[guards] OK: ${repoRelPath}`);
  } else {
    console.error(`[guards] FAILED: ${repoRelPath} (exit ${result.status})`);
    failed.push(repoRelPath);
  }
}

if (failed.length > 0) {
  console.error(`[guards] ${failed.length}/${STATIC_GUARD_REPO_PATHS.length} guard(s) failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`[guards] all ${STATIC_GUARD_REPO_PATHS.length} guard(s) passed`);
