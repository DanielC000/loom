// ─────────────────────────────────────────────────────────────────────────────────────────────
// host-quiet-check.mjs — CAPABILITY (a) from card 3ab5c540: a whole-box CPU load reading,
// deliberately independent of `gate_queue`'s semaphore-admission count. See
// src/pty/host.ts's `readWholeBoxLoadPercent` doc for the full mechanism, the win32-vs-posix
// time-base caveat, and why this is a DIFFERENT question from `gate_queue`/host-attribution-
// check.mjs's own (narrower) attribution question.
//
// RUN:
//   pnpm --filter @loom/daemon build
//   node packages/daemon/scripts/host-quiet-check.mjs
// Prints one JSON reading. Non-zero exit only on a genuine measurement failure (a wedged CIM
// query, a non-numeric result) — this script never encodes a pass/fail judgement of its own,
// since "quiet enough" is a threshold call for the reader, not this instrument.
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
// build silently surfaces as "readWholeBoxLoadPercent is not a function", a symbol name with no cause,
// exactly the failure card 11995e5f exists to fix.
requireFreshDist({ label: "host-quiet-check", srcPath, distPath, buildCommand });

// file:// URL required for a dynamic import() on Windows — a bare drive-letter absolute path
// throws ERR_UNSUPPORTED_ESM_URL_SCHEME (same gotcha run-static-guards.mjs already works around).
const mod = await import(pathToFileURL(distPath).href);
requireExport(mod, "readWholeBoxLoadPercent", { label: "host-quiet-check", distPath, buildCommand });
const { readWholeBoxLoadPercent } = mod;

try {
  const reading = await readWholeBoxLoadPercent();
  console.log(JSON.stringify(reading, null, 2));
} catch (err) {
  console.error(`[host-quiet-check] measurement failed: ${err.message}`);
  process.exit(1);
}
