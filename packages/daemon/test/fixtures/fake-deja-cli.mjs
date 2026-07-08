#!/usr/bin/env node
// Fixture stand-in for the real `deja` CLI's `capture` subcommand, used ONLY by the real-spawn
// integration coverage in test/deja-capture.mjs (card b37efb19). Needs no built `deja` binary: it
// mimics `deja capture <file> --prompt <p> --project <n> --db <path>` closely enough to prove the
// relay's runDejaCapture (a) actually spawns a node-CLI target cross-platform without throwing
// EFTYPE/ENOENT, and (b) passes `--db` through to where the capture lands. On every invocation it
// appends one JSON line describing the call to the file named by --db (creating its directory if
// needed), then always exits 0 — mirroring the real `deja capture`'s own always-exit-0 contract.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}

if (args[0] === "capture") {
  const file = args[1];
  const record = { file, prompt: flag("--prompt"), project: flag("--project"), db: flag("--db") };
  const db = record.db;
  if (db) {
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.appendFileSync(db, `${JSON.stringify(record)}\n`);
  }
}

process.exit(0);
