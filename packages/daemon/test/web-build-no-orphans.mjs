import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure build/fs
// REGRESSION GUARD (card 61fa0950) — a `turbo build` CACHE HIT restores a task's cached `dist/**`
// files WITHOUT ever re-running the underlying script, so it never triggers Vite's own `emptyOutDir`
// clean (which only fires when `vite build` actually executes). If `packages/web/dist` already holds a
// DIFFERENT prior build's content-hashed bundle, a later cache-hit restore layers the restored files on
// top instead of replacing them, leaving the stale bundle behind. That stale file is then flagged by
// `codescape-privacy-guard.mjs` if it happens to predate the fix for a real leak — but the underlying
// bug is real regardless of what string a stale bundle carries: a `loomctl` publish or a served daemon
// instance can end up with an orphaned, unreferenced-but-fetchable bundle in `dist/assets`.
//
// The fix is `turbo.json`'s `clean` task (`cache:false`, a dependency of `build`) — it unconditionally
// wipes `packages/web/dist` before EITHER a real build or a cache-hit restore writes into it, since a
// restore is exactly the path that skips Vite's own clean. This test proves the fix by reproducing the
// exact live sequence that surfaced the bug: build A, build B (different content), then revert back to
// A's exact content — which forces turbo to serve build A from cache — and asserts only A's hash survives.
//
// NOT_HERMETIC (see scripts/test-daemon.mjs's denylist + its own header): unlike every other daemon
// test, this one mutates a REAL tracked repo file (`packages/web/src/main.tsx`) and rebuilds the REAL
// shared `packages/web/dist` two to three times (~5-20s each) to exercise turbo's actual cache, which
// only exists for real registered workspace packages — an isolated temp fixture can't reproduce a turbo
// cache hit. Running this concurrently with another test that reads/builds the same paths (notably
// `codescape-privacy-guard.mjs`, which scans `packages/web/dist`) would race. Run it manually, alone:
//   node packages/daemon/test/web-build-no-orphans.mjs
// It refuses to run at all unless `packages/web/src/main.tsx` starts with a clean git status, and it
// restores the file's exact original bytes (and rebuilds once more from that original content) in a
// `finally`, so a normal `pnpm build` afterward reflects real repo state again either way.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..", "..");
const WEB_DIR = path.join(repoRoot, "packages", "web");
const MAIN_TSX = path.join(WEB_DIR, "src", "main.tsx");
const DIST_ASSETS = path.join(WEB_DIR, "dist", "assets");
const require = createRequire(import.meta.url);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function turboBin() {
  try { return require.resolve("turbo/bin/turbo"); }
  catch { return path.join(repoRoot, "node_modules", "turbo", "bin", "turbo"); }
}

function buildWeb() {
  execFileSync(process.execPath, [turboBin(), "build", "--filter=@loom/web"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function jsBundleNames() {
  if (!fs.existsSync(DIST_ASSETS)) return [];
  return fs.readdirSync(DIST_ASSETS).filter((f) => f.endsWith(".js")).sort();
}

// --- Refuse to run against a dirty file — never clobber real uncommitted work. ---
const gitStatus = execFileSync("git", ["status", "--porcelain", "--", MAIN_TSX], { cwd: repoRoot, encoding: "utf8" }).trim();
if (gitStatus) {
  console.error(`🛑 refusing to run — ${MAIN_TSX} already has uncommitted changes:\n${gitStatus}`);
  process.exit(99);
}

const original = fs.readFileSync(MAIN_TSX, "utf8");
const ALERT_LINE = /window\.alert\(`Action failed: \$\{err instanceof Error \? err\.message : String\(err\)\}`\)/;
if (!ALERT_LINE.test(original)) {
  console.error(`🛑 refusing to run — the expected marker anchor line was not found in ${MAIN_TSX} (file may have changed shape; update this test's anchor).`);
  process.exit(99);
}
const withMarker = (tag) => original.replace(ALERT_LINE, `window.alert(\`Action failed ${tag}: \${err instanceof Error ? err.message : String(err)}\`)`);

try {
  fs.rmSync(path.join(WEB_DIR, "dist"), { recursive: true, force: true });

  // Build A — real content, real (cache-miss) execution.
  fs.writeFileSync(MAIN_TSX, withMarker("TEST_MARKER_A"), "utf8");
  buildWeb();
  const bundleA = jsBundleNames();
  check("(1) build A produced exactly one JS bundle", bundleA.length === 1);

  // Build B — different content, real (cache-miss) execution.
  fs.writeFileSync(MAIN_TSX, withMarker("TEST_MARKER_B"), "utf8");
  buildWeb();
  const bundleB = jsBundleNames();
  check("(2) build B produced exactly one JS bundle", bundleB.length === 1);
  check("(2) build B's hash differs from build A's", bundleB[0] !== bundleA[0]);

  // Revert to build A's exact content — this is the sequence that reproduced the live bug: turbo
  // serves A from cache (a restore, not a real execution), and pre-fix, the restore left B's bundle
  // sitting alongside it instead of replacing dist's contents.
  fs.writeFileSync(MAIN_TSX, withMarker("TEST_MARKER_A"), "utf8");
  buildWeb();
  const bundleC = jsBundleNames();
  check("(3) rebuilding A's content leaves exactly one JS bundle (no orphan)", bundleC.length === 1);
  check("(3) that bundle matches build A's original hash", bundleC[0] === bundleA[0]);
  check("(3) build B's orphaned hash is NOT present", !bundleC.includes(bundleB[0]));
} finally {
  fs.writeFileSync(MAIN_TSX, original, "utf8");
  try { buildWeb(); } catch { /* best-effort — leave repo state clean even if this final rebuild fails */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a turbo cache-hit rebuild of @loom/web never leaves a prior build's orphaned bundle in dist/assets."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
