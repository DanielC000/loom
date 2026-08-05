#!/usr/bin/env node
// READ-ONLY full-corpus scan for card 90678ee9 DoD-1: does our per-file `name` field ever carry a path
// separator (the property that broke the peer project's cross-run join — their field was an ABSOLUTE
// WORKTREE PATH with a per-worktree hash segment, so no two runs' names ever matched at all)?
//
// This scans the LIVE, growing ~/.loom/gate-timing/daemon-per-file-timing.ndjson (not the committed
// window snapshot — the window snapshot is a small, fixed subset; this check is deliberately run against
// the WHOLE corpus so a re-run later re-verifies the property against however much the file has grown by
// then). It is NOT reproducible byte-for-byte across time the way the window snapshot is; findings.md
// records the exact result + frozen file stats (size/lines/md5) at the time this was run.
//
// Usage: node check-key-separator.mjs [--source <path>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const sourcePath = argVal(
  "--source",
  path.join(process.env.LOOM_HOME || path.join(os.homedir(), ".loom"), "gate-timing", "daemon-per-file-timing.ndjson"),
);

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(sourcePath) });
  let total = 0;
  let withSlash = 0;
  let withBackslash = 0;
  const examples = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.kind !== "file") continue;
    total++;
    const n = obj.name || "";
    if (n.includes("/")) { withSlash++; if (examples.length < 5) examples.push(n); }
    if (n.includes("\\")) { withBackslash++; if (examples.length < 5) examples.push(n); }
  }
  console.log(`source: ${sourcePath}`);
  console.log(`total "kind":"file" rows scanned: ${total}`);
  console.log(`names containing "/": ${withSlash}`);
  console.log(`names containing "\\\\": ${withBackslash}`);
  if (examples.length) console.log(`examples: ${examples.join(", ")}`);
  else console.log("no name in the entire corpus carries a path separator.");
}

main();
