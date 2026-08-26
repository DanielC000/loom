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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(here, "..");
const distPath = path.join(daemonRoot, "dist", "pty", "host.js");

if (!fs.existsSync(distPath)) {
  console.error(`[host-quiet-check] ${distPath} does not exist — run \`pnpm --filter @loom/daemon build\` first, then re-run this script.`);
  process.exit(1);
}

// file:// URL required for a dynamic import() on Windows — a bare drive-letter absolute path
// throws ERR_UNSUPPORTED_ESM_URL_SCHEME (same gotcha run-static-guards.mjs already works around).
const { readWholeBoxLoadPercent } = await import(pathToFileURL(distPath).href);

try {
  const reading = await readWholeBoxLoadPercent();
  console.log(JSON.stringify(reading, null, 2));
} catch (err) {
  console.error(`[host-quiet-check] measurement failed: ${err.message}`);
  process.exit(1);
}
