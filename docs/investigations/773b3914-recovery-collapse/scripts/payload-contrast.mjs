// Card 773b3914 — DoD-2 payload-size contrast: for every "auto-recovering" tripwire firing, finds
// the closest preceding [prompt-mismatch] record whose reportedLen is short (<=30, the whole-string
// placeholder shape) — that's the payload that collapsed — and compares intendedLen between the 4
// sessions that went on to an "ALSO collapsed" recovery-failure vs. the sessions that recovered clean.
//
// Usage: node payload-contrast.mjs <dir-containing-tripwire_window.json-and-pm_all.json>
import fs from "node:fs";
import path from "node:path";

const DIR = process.argv[2];
const win = JSON.parse(fs.readFileSync(path.join(DIR, "tripwire_window.json"), "utf8"));
const pm = JSON.parse(fs.readFileSync(path.join(DIR, "pm_all.json"), "utf8"));

const collapsedSessions = new Set(["a7f22ddb-d0bd-446c-97a0-b33a50510744", "19a92eb9-0fc7-4cb0-ae69-9b41ecb94365", "f99aea6c-1ff5-49ac-aec3-ea588788f589", "cb2a6c14-063b-4a81-9ec8-3ceba6cb485c"]);

const rows = [];
for (const ev of win) {
  if (ev.kind !== "auto-recovering") continue;
  const candidates = pm.filter(p => p.sessionId === ev.sessionId && p.ts <= ev.ts && p.ts > ev.ts - 5 * 60 * 1000 && p.reportedLen != null && p.reportedLen <= 35);
  candidates.sort((a, b) => b.ts - a.ts);
  const match = candidates[0] || null;
  rows.push({
    sessionId: ev.sessionId,
    tripwireTs: ev.iso,
    isCollapsedGroup: collapsedSessions.has(ev.sessionId),
    matched: !!match,
    intendedLen: match ? match.intendedLen : null,
    reportedLen: match ? match.reportedLen : null,
    token: match ? match.reportedAround : null,
  });
}

const matched = rows.filter(r => r.matched);
console.log("auto-recovering firings:", win.filter(e => e.kind === "auto-recovering").length);
console.log("matched to an original-collapse payload-size record:", matched.length);

function stats(arr, field) {
  const vals = arr.map(r => r[field]).filter(v => v != null).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { n: vals.length, min: vals[0], max: vals[vals.length - 1], mean: Math.round(mean), median: vals[Math.floor(vals.length / 2)] };
}

const collapsedRows = matched.filter(r => r.isCollapsedGroup);
const cleanRows = matched.filter(r => !r.isCollapsedGroup);

console.log("\n=== intendedLen (payload size that collapsed) ===");
console.log("collapsed-recovery group:", JSON.stringify(stats(collapsedRows, "intendedLen")));
console.log("clean-recovery group:", JSON.stringify(stats(cleanRows, "intendedLen")));
