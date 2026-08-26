// ─────────────────────────────────────────────────────────────────────────────────────────────
// host-attribution-check.mjs — CAPABILITY (b) from card 3ab5c540: READ-ONLY process enumeration
// scoped to ONE worktree's full path, for ATTRIBUTION only ("which processes name this
// worktree") — never for quietness ("is the box idle"), which is host-quiet-check.mjs's separate
// job. NOTHING HERE KILLS ANYTHING — see src/pty/host.ts's `attributeProcessesToWorktree` doc for
// the full mechanism (it reuses the exact enumeration + match `reapProcessesRootedInWorktree`
// uses, minus the kill).
//
// RUN:
//   pnpm --filter @loom/daemon build
//   node packages/daemon/scripts/host-attribution-check.mjs [<worktree-path>]
// <worktree-path> defaults to CWD when omitted — pass an ABSOLUTE path to check a worktree other
// than the one you're running from. Prints {worktreePath, matched, totalProcessesScanned, ...}
// as JSON.
//
// ⚠️ KNOWN COVERAGE GAP (measured, card 3ab5c540 §THE FIX WAS WRONG): only a process whose OWN
// path/cwd/commandLine names this worktree is matched. In the one measured sample this covered 8
// of 17 live node.exe processes (47%) — the daemon itself, its `codescape serve` child,
// `daemon-supervisor.mjs`, and other repo-root-rooted processes are NEVER matched by design, and
// are not descendants of anything this WOULD match either (ParentProcessId chaining was tested
// and found zero of them). A `matched: []` result is NOT evidence the host — or even this
// project — is idle; pair with host-quiet-check.mjs for that question.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireFreshDist, requireExport } from "./lib/dist-freshness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(here, "..");
const srcPath = path.join(daemonRoot, "src", "pty", "host.ts");
const distPath = path.join(daemonRoot, "dist", "pty", "host.js");
const buildCommand = "pnpm --filter @loom/daemon build";

// REFUSE before importing a stale dist — see lib/dist-freshness.mjs for why: without this, a stale
// build silently surfaces as "attributeProcessesToWorktree is not a function", a symbol name with no
// cause, the same failure shape card 11995e5f found in host-quiet-check.mjs.
requireFreshDist({ label: "host-attribution-check", srcPath, distPath, buildCommand });

const mod = await import(pathToFileURL(distPath).href);
requireExport(mod, "attributeProcessesToWorktree", { label: "host-attribution-check", distPath, buildCommand });
const { attributeProcessesToWorktree } = mod;

const worktreePath = path.resolve(process.argv[2] || process.cwd());

try {
  const result = await attributeProcessesToWorktree(worktreePath);
  console.log(JSON.stringify({ worktreePath, ...result }, null, 2));
} catch (err) {
  console.error(`[host-attribution-check] enumeration failed: ${err.message}`);
  process.exit(1);
}
