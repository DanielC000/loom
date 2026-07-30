#!/usr/bin/env node
// Extract every stamped line in a frozen log falling within [startIso, endIso], with original line
// numbers preserved -- for manually inspecting what else was happening on the host during a specific
// give-up / lag episode (gate runs, builds, merges, spawns, serve restarts, ...).
//
// Usage: node slice-window.mjs <frozen-daemon-output.log> <startIso> <endIso> <out.log>
import fs from 'fs';
import readline from 'readline';

const STAMP_MIN = 1.7e12;
function extractStamp(line) {
  const idx = line.lastIndexOf(' ');
  if (idx === -1) return null;
  const tok = line.slice(idx + 1).trim();
  if (!/^\d+$/.test(tok)) return null;
  const n = Number(tok);
  if (!Number.isFinite(n) || n < STAMP_MIN) return null;
  return n;
}

const [logPath, startIso, endIso, outPath] = process.argv.slice(2);
if (!logPath || !startIso || !endIso || !outPath) {
  console.error('usage: node slice-window.mjs <frozen-daemon-output.log> <startIso> <endIso> <out.log>');
  process.exit(1);
}
const startMs = Date.parse(startIso), endMs = Date.parse(endIso);

const rl = readline.createInterface({ input: fs.createReadStream(logPath, { encoding: 'utf8' }), crlfDelay: Infinity });
const out = fs.createWriteStream(outPath);
let count = 0, lineNo = 0;
for await (const line of rl) {
  lineNo++;
  const stamp = extractStamp(line);
  if (stamp !== null && stamp >= startMs && stamp <= endMs) { out.write(`${lineNo}: ${line}\n`); count++; }
}
out.end();
console.log('wrote', count, 'lines in window', startIso, '->', endIso, 'to', outPath);
