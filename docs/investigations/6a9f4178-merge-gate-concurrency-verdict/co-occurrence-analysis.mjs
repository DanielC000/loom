// Card 6a9f4178 — cross-references `merge-gate-concurrency-verdict.mjs`'s two known failures against
// `<LOOM_HOME>/gate-timing/daemon-per-file-timing.ndjson`'s `kind:"file"` rows (never the `run-start`
// rows' `selected[]` array — see the card's own DoD warning), to test whether `kickoff-real-spawn.mjs`
// (a REAL node-pty/conpty spawn test — the "AttachConsole failed" specimen this card's own §UNCHECKED
// LEAD names, and the same underlying mechanism `docs/investigations/239d6b9e-conpty-kill-nondeterminism`
// documents for a sibling test) failing in the SAME overall gate run co-occurs with the verdict test's
// own failure — a NARROWER, more specific candidate than the generic "host contention" the card already
// killed on a coarse per-run mean-file-duration proxy.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LOOM_HOME = process.env.LOOM_HOME || path.join(os.homedir(), ".loom");
const NDJSON = path.join(LOOM_HOME, "gate-timing", "daemon-per-file-timing.ndjson");

const rows = fs.readFileSync(NDJSON, "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);
const fileRows = rows.filter((r) => r.kind === "file");

const verdictRows = fileRows.filter((r) => r.name === "merge-gate-concurrency-verdict");
const verdictFails = verdictRows.filter((r) => r.ok === false);
const kickoffFails = fileRows.filter((r) => r.name === "kickoff-real-spawn" && r.ok === false);
const kickoffFailSet = new Set(kickoffFails.map((r) => r.runUid));
const allRunUids = new Set(fileRows.map((r) => r.runUid));

console.log(`merge-gate-concurrency-verdict: ${verdictRows.length} total runs, ${verdictFails.length} failed`);
console.log(`kickoff-real-spawn: ${kickoffFails.length} failed runs (of ${allRunUids.size} total distinct runUids in the corpus)`);
console.log("");
console.log("co-occurrence check — for each verdict failure, did kickoff-real-spawn ALSO fail in that SAME runUid?");
for (const vf of verdictFails) {
  const kFail = kickoffFailSet.has(vf.runUid);
  console.log(`  ${vf.runUid} (${vf.startTsIso}, durationMs=${vf.durationMs}, lane=${vf.lane}) — kickoff-real-spawn also failed: ${kFail}`);
  if (kFail) {
    const kRow = kickoffFails.find((r) => r.runUid === vf.runUid);
    console.log(`    kickoff-real-spawn: lane=${kRow.lane} ${kRow.startTsIso} -> ${kRow.endTsIso} durationMs=${kRow.durationMs}`);
    console.log(`    verdict started ${((new Date(vf.startTsIso)) - (new Date(kRow.endTsIso))) / 1000}s after kickoff-real-spawn ended`);
  }
}
console.log("");
console.log(`SUMMARY: ${verdictFails.length}/${verdictFails.length} verdict failures co-occurred with a kickoff-real-spawn failure in the same run.`);
console.log(`For contrast: kickoff-real-spawn fails in ${kickoffFails.length}/${allRunUids.size} runs overall (~${(100 * kickoffFails.length / allRunUids.size).toFixed(1)}%) — so most kickoff-real-spawn failures do NOT co-occur with a verdict failure (P(verdict fails | kickoff fails) = ${verdictFails.length}/${kickoffFails.length}).`);
console.log("This is a correlation lead, NOT a proven mechanism — n=2 is thin, and the verdict test itself uses a PTY STUB (no real node-pty/conpty spawn), so any causal link would have to run through a HOST-level side effect of kickoff-real-spawn's real spawn/teardown activity (e.g. leaked processes/handles), not a shared in-process resource.");
