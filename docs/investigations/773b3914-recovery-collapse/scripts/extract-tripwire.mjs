// Card 773b3914 — parses every retained daemon-output.log rotation for [paste-tripwire] and
// [prompt-mismatch] lines, reproduces the positive control (log window still present) and the
// 88/4/84 split against a3ac7ba8's own reported 89/4/85.
//
// Run from anywhere: `node extract-tripwire.mjs [outDir]`. Reads only from ~/.loom/logs (read-only).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOGDIR = path.join(os.homedir(), ".loom", "logs");
const OUTDIR = process.argv[2] || process.cwd();
const files = ["daemon-output.log", "daemon-output.log.1", "daemon-output.log.2", "daemon-output.log.3", "daemon-output.log.4", "daemon-output.log.5"];

// Card 773b3914's own createdAt — the exact moment a3ac7ba8's corpus was frozen.
const cutoff = Date.parse("2026-08-05T16:36:05.990Z");

let tripwireAll = [];
let pmAll = [];
let noparse = [];

for (const f of files) {
  const full = path.join(LOGDIR, f);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, "utf8");
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("[paste-tripwire]")) {
      const m = line.match(/^\[paste-tripwire\] (\S+) submitted turn.*?claudeVersion=([^)]+)\).*?(auto-recovering|ALSO collapsed).*?(\d{13})\s*$/);
      if (!m) { noparse.push({ file: f, line: line.slice(0, 150) }); continue; }
      const [, sessionId, claudeVersion, kind, tsStr] = m;
      const ts = Number(tsStr);
      tripwireAll.push({ file: f, sessionId, claudeVersion, kind, ts, iso: new Date(ts).toISOString() });
    }
    if (line.startsWith("[prompt-mismatch]")) {
      const sid = line.match(/^\[prompt-mismatch\] (\S+)/);
      const rl = line.match(/reportedLen=(\d+)/);
      const il = line.match(/intendedLen=(\d+)/);
      const ra = line.match(/reportedAround="([^"]*)"/);
      const ia = line.match(/intendedAround="([^"]*)"/);
      const tsM = line.match(/(\d{13})\s*$/);
      if (!sid || !tsM) continue;
      pmAll.push({ file: f, sessionId: sid[1], ts: Number(tsM[1]), iso: new Date(Number(tsM[1])).toISOString(), reportedLen: rl ? Number(rl[1]) : null, intendedLen: il ? Number(il[1]) : null, reportedAround: ra ? ra[1] : null, intendedAround: ia ? ia[1] : null });
    }
  }
}

tripwireAll.sort((a, b) => a.ts - b.ts);
pmAll.sort((a, b) => a.ts - b.ts);

const inWindow = tripwireAll.filter(e => e.ts <= cutoff);
const collapsed = inWindow.filter(e => e.kind === "ALSO collapsed");
const recovered = inWindow.filter(e => e.kind === "auto-recovering");

console.log("=== POSITIVE CONTROL ===");
console.log("total [paste-tripwire] lines parsed (all retained rotations, all time):", tripwireAll.length);
console.log("noparse lines (legacy pre-timestamp format, expected to predate the window):", noparse.length);
for (const n of noparse) console.log("  NOPARSE", n.file, n.line);
console.log("");
console.log("=== WINDOW (ts <= " + new Date(cutoff).toISOString() + ", card 773b3914's stated corpus cutoff) ===");
console.log("in-window tripwire firings:", inWindow.length, "(a3ac7ba8 reported 89)");
console.log("  collapsed (ALSO collapsed):", collapsed.length, "(a3ac7ba8 reported 4)");
console.log("  recovered (auto-recovering):", recovered.length, "(a3ac7ba8 reported 85)");

fs.mkdirSync(OUTDIR, { recursive: true });
fs.writeFileSync(path.join(OUTDIR, "tripwire_all.json"), JSON.stringify(tripwireAll, null, 2));
fs.writeFileSync(path.join(OUTDIR, "tripwire_window.json"), JSON.stringify(inWindow, null, 2));
fs.writeFileSync(path.join(OUTDIR, "pm_all.json"), JSON.stringify(pmAll, null, 2));

console.log("\n=== THE 4 COLLAPSED ===");
console.log(JSON.stringify(collapsed, null, 2));
