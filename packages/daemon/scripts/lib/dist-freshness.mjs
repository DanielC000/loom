// ─────────────────────────────────────────────────────────────────────────────────────────────
// dist-freshness.mjs — shared stale-`dist` guard for one-off `.mjs` scripts that dynamic-import a
// compiled artifact under `packages/daemon/dist/**` (card 11995e5f). These scripts have no build step
// of their own — they import build OUTPUT — so a caller who hasn't just run `pnpm build` gets whatever
// the stale file happens to export, typically surfacing as a bare "X is not a function" TypeError that
// names a symbol, not the cause. `run-static-guards.mjs` (via `pnpm --filter @loom/daemon guards`) is
// migrated onto this lib for its own src/dist pair, so there is exactly ONE implementation of this check
// (not a second inline copy) — the shared-unit-divergence anti-pattern this project names explicitly.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";

/**
 * Refuse (print an actionable message naming `buildCommand` and exit 1) if `distPath` is missing or
 * looks older than `srcPath` by mtime. Call BEFORE importing `distPath` — this is a pre-flight check,
 * not a wrapper around the import. Never returns on failure; returns undefined on success.
 *
 * mtime staleness is a heuristic, not a build-correctness proof (a touched-but-unbuilt file, or clock
 * skew, can both trip or miss it) — see `requireExport` below for the belt-and-suspenders check that
 * catches a stale dist THIS check's mtime comparison didn't.
 *
 * `staleDetail` (default "dist/ looks stale") and `rerunCommand` (default unset, prints "re-run this
 * script") let a caller keep its own more specific wording — e.g. `run-static-guards.mjs` names what
 * dist/ may be missing ("the current guard list") and the actual `pnpm` script to re-run, not just "this
 * script" — instead of every caller being flattened to one generic phrasing.
 */
export function requireFreshDist({ label, srcPath, distPath, buildCommand, staleDetail = "dist/ looks stale", rerunCommand }) {
  const rerunHint = rerunCommand ? `re-run \`${rerunCommand}\`` : "re-run this script";
  let distMtimeMs;
  try {
    distMtimeMs = fs.statSync(distPath).mtimeMs;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    console.error(`[${label}] ${distPath} does not exist — run \`${buildCommand}\` first, then ${rerunHint}.`);
    process.exit(1);
  }
  const srcMtimeMs = fs.statSync(srcPath).mtimeMs;
  if (srcMtimeMs > distMtimeMs) {
    console.error(`[${label}] ${srcPath} is newer than ${distPath} — ${staleDetail}. Run \`${buildCommand}\` first, then ${rerunHint}.`);
    process.exit(1);
  }
}

/**
 * Belt-and-suspenders for `requireFreshDist`'s mtime heuristic: confirm the just-imported module
 * actually exports `exportName` as a function before a caller calls it. Catches a stale dist that
 * mtime comparison missed (e.g. dist untouched by an unrelated `touch`) with the same actionable
 * "run the build" message, instead of letting a bare "X is not a function" TypeError surface at the
 * call site.
 */
export function requireExport(mod, exportName, { label, distPath, buildCommand }) {
  if (typeof mod[exportName] !== "function") {
    console.error(`[${label}] ${distPath} does not export ${exportName} — dist/ does not reflect the current source yet. Run \`${buildCommand}\` first, then re-run this script.`);
    process.exit(1);
  }
}
