#!/usr/bin/env node
// READ-ONLY extraction for card 90678ee9 (DoD-1/DoD-2). `~/.loom/gate-timing/daemon-per-file-timing.ndjson`
// is LIVE and growing (new gate runs append to it continuously) — this pulls a fixed, named window of
// runUids out of it into a small, git-tracked snapshot so the rest of this investigation's analysis is
// reproducible without depending on the live file's later state. The window is a fixed LIST of runUids
// (not a time-range re-query against whatever the live file has grown to), so re-running this against a
// later/larger source file reproduces byte-identical output, as long as the source is append-only (it is:
// appendGateTimingRow in packages/daemon/scripts/test-daemon.mjs only ever appends).
//
// Window: the 17 consecutive same-poolSize(2) runs 2026-08-05T03:04:37.914Z -> 08:06:16.953Z — the same
// window the card's own two-run headline comparison sits inside. Excludes (per the card's DoD-6 four-stamp
// discipline, never pool across an instrument change):
//   - the 2026-08-05T08:26:50.564Z run (op c27ae981): 1 failedCount — a distinct condition, not a clean
//     pass, so its per-file durations are not obviously comparable to the passing runs (same reasoning the
//     card's own body already applies to `63bdd2cc` in a sibling investigation).
//   - every run at 2026-08-05T08:49:33.661Z and later: poolSize flips 2->3 there (the card's own cited
//     "9f98b36" 2->3 change landed in this same neighborhood) — a different instrument.
//
// Usage: node extract-window.mjs [--source <path>]
// Default source: ~/.loom/gate-timing/daemon-per-file-timing.ndjson (LOOM_HOME-relative, same constant
// packages/daemon/scripts/test-daemon.mjs itself uses). Writes ../data/pool2-window-per-file-timing.ndjson.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, "../data/pool2-window-per-file-timing.ndjson");

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const sourcePath = argVal(
  "--source",
  path.join(process.env.LOOM_HOME || path.join(os.homedir(), ".loom"), "gate-timing", "daemon-per-file-timing.ndjson"),
);

// The 17 runUids in the window, oldest first — pinned by exact value (not re-derived from a time-range
// filter at extraction time) so this script's OUTPUT is fixed even if the live source later contains
// other runs that happen to fall in the same clock window (e.g. a future rerun of a poolSize:2 config).
export const WINDOW_RUN_UIDS = [
  "1785899077914-1828",   // 2026-08-05T03:04:37.914Z (the card's own "fast" run)
  "1785899948280-19716",  // 2026-08-05T03:19:08.279Z
  "1785900830727-22836",  // 2026-08-05T03:33:50.726Z
  "1785901736907-34008",  // 2026-08-05T03:48:56.906Z
  "1785903394561-6288",   // 2026-08-05T04:16:34.560Z
  "1785905474077-22340",  // 2026-08-05T04:51:14.076Z
  "1785905618777-26000",  // 2026-08-05T04:53:38.777Z
  "1785906616878-31784",  // 2026-08-05T05:10:16.877Z
  "1785907074250-30944",  // 2026-08-05T05:17:54.249Z
  "1785908106332-29104",  // 2026-08-05T05:35:06.331Z
  "1785908222091-32476",  // 2026-08-05T05:37:02.090Z
  "1785909261919-2160",   // 2026-08-05T05:54:21.918Z
  "1785911251889-2992",   // 2026-08-05T06:27:31.889Z
  "1785914317958-19828",  // 2026-08-05T07:18:37.957Z (the card's own "slow" run)
  "1785914973166-27972",  // 2026-08-05T07:29:33.165Z
  "1785916194149-28016",  // 2026-08-05T07:49:54.148Z
  "1785917176983-31420",  // 2026-08-05T08:06:16.953Z
];

async function main() {
  const wanted = new Set(WINDOW_RUN_UIDS);
  const rl = readline.createInterface({ input: fs.createReadStream(sourcePath) });
  const out = [];
  let scanned = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    scanned++;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if ((obj.kind === "run-summary" || obj.kind === "file") && wanted.has(obj.runUid)) out.push(line);
  }
  fs.writeFileSync(outPath, out.join("\n") + "\n");
  const foundRunSummaries = out.filter((l) => JSON.parse(l).kind === "run-summary").length;
  console.log(`scanned ${scanned} source lines from ${sourcePath}`);
  console.log(`wrote ${out.length} rows (${foundRunSummaries}/${WINDOW_RUN_UIDS.length} run-summary rows matched) to ${outPath}`);
  if (foundRunSummaries !== WINDOW_RUN_UIDS.length) {
    console.error(`WARNING: expected ${WINDOW_RUN_UIDS.length} run-summary rows, found ${foundRunSummaries} — the source file may not carry the full window.`);
    process.exitCode = 1;
  }
}

main();
