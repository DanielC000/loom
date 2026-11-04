#!/usr/bin/env node
// Card 884c8d56 (Code Review round) — release-CI `global-install-smoke` companion step.
// `loom --version` (bin/loom.mjs) only reads package.json; it never loads dist/ or vendor/, so it
// cannot catch a broken "#loom-shared" imports-map resolution, a missed rewriteSharedSpecifiers()
// rewrite, or a missing `vendor` entry in the packed `files`. This script dynamic-imports a REAL nested
// dist module (one that imports @loom/shared, rewritten to "#loom-shared" at pack time) from a REAL
// global install, to prove that resolution actually works end to end — without booting the daemon. (The
// imported module itself pulls in no third-party dependency, so this does NOT prove anything about a
// missing *runtime* dependency — only the vendored-shared resolution.)
//
// Usage: node scripts/smoke-dist-shared-import.mjs <npm-root-g-output-dir>
// <npm-root-g-output-dir> is exactly what `npm root -g --prefix <P>` prints for the scratch prefix the
// caller installed into (holds the installed `loomctl` package directory itself) — resolved by the
// caller per-platform (POSIX: <P>/lib/node_modules, Windows: <P>/node_modules), never hand-built here.
import path from "node:path";
import { pathToFileURL } from "node:url";

const npmRoot = process.argv[2];
if (!npmRoot) {
  console.error("[smoke-dist-shared-import] usage: node scripts/smoke-dist-shared-import.mjs <npm-root-g-output-dir>");
  process.exit(1);
}

// merge-gate-interval.js is a real daemon module that imports from @loom/shared (resolveMergeGateCadence
// + two types) — a representative nested dist/ consumer, not the package's own entry point.
const modPath = path.join(npmRoot, "loomctl", "dist", "orchestration", "merge-gate-interval.js");
// file:// URL required even on POSIX for consistency, and REQUIRED on Windows — a bare drive-letter
// absolute path throws ERR_UNSUPPORTED_ESM_URL_SCHEME (CLAUDE.md's own Windows ESM footgun).
const modUrl = pathToFileURL(modPath).href;

let mod;
try {
  mod = await import(modUrl);
} catch (e) {
  console.error(
    `[smoke-dist-shared-import] failed to import ${modPath}: ${e instanceof Error ? e.stack : String(e)}`,
  );
  process.exit(1);
}

if (typeof mod.MERGE_GATE_RECENT_MAX !== "number" || typeof mod.emptyMergeGateState !== "function") {
  console.error(
    `[smoke-dist-shared-import] ${modPath} did not expose its expected exports (MERGE_GATE_RECENT_MAX, ` +
      "emptyMergeGateState) — #loom-shared resolution is likely broken.",
  );
  process.exit(1);
}

const state = mod.emptyMergeGateState();
if (typeof state.ungatedSinceLastPass !== "number") {
  console.error("[smoke-dist-shared-import] emptyMergeGateState() returned an unexpected shape.");
  process.exit(1);
}

console.log(
  `[smoke-dist-shared-import] OK — imported ${modPath}, MERGE_GATE_RECENT_MAX=${mod.MERGE_GATE_RECENT_MAX}, ` +
    "emptyMergeGateState() shape verified.",
);
