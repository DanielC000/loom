#!/usr/bin/env node
// Fixture stand-in for the real `codescape` CLI, used ONLY by the real-spawn integration coverage in
// test/codescape-supervisor.mjs (card 894b9b02). Mimics the two subcommands the supervisor drives:
//   - `ingest <repoPath>` — records the call, exits 0 (mirrors the real one-shot ingest).
//   - `serve --port <p>`  — records the call, then stays alive (a long-lived foreground process, exactly
//     like the real `serve`) until the supervisor kills it.
// Every invocation appends ONE JSON line to `fake-codescape-calls.jsonl` IN ITS OWN CWD (never an
// absolute/env-supplied path) — so the test can prove the CWD CONTRACT (ingest and serve sharing the
// exact same working directory) purely by reading that one file.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const cwd = process.cwd();
const logFile = path.join(cwd, "fake-codescape-calls.jsonl");

function record(fields) {
  fs.appendFileSync(logFile, `${JSON.stringify({ ...fields, cwd, pid: process.pid })}\n`);
}

if (args[0] === "ingest") {
  record({ cmd: "ingest", repoPath: args[1] });
  process.exit(0);
} else if (args[0] === "serve") {
  const portIdx = args.indexOf("--port");
  record({ cmd: "serve", port: portIdx === -1 ? null : args[portIdx + 1] });
  // Long-lived foreground, like the real `serve` — stays up until killed.
  setInterval(() => {}, 1 << 30);
} else {
  process.exit(1);
}
