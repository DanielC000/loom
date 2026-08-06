// Card 773b3914 — DoD-2's one surviving discriminator: does the recovery-turn's OWN prompt-mismatch
// record (if any) contain a placeholder-shaped [Pasted text #N...] token, or an unrelated real message?
// Compares the 4 "ALSO collapsed" sessions against every "auto-recovering" (clean) session that also
// happened to show a second, concurrent prompt-mismatch record near its own recovery submission.
//
// Usage: node second-write-contrast.mjs <dir-containing-tripwire_window.json-and-pm_all.json>
import fs from "node:fs";
import path from "node:path";

const DIR = process.argv[2];
const win = JSON.parse(fs.readFileSync(path.join(DIR, "tripwire_window.json"), "utf8"));
const pm = JSON.parse(fs.readFileSync(path.join(DIR, "pm_all.json"), "utf8"));

const collapsedSessions = new Set(["a7f22ddb-d0bd-446c-97a0-b33a50510744", "19a92eb9-0fc7-4cb0-ae69-9b41ecb94365", "f99aea6c-1ff5-49ac-aec3-ea588788f589", "cb2a6c14-063b-4a81-9ec8-3ceba6cb485c"]);
const PLACEHOLDER_RE = /\[Pasted text #\d+[^\]]*\]/;

const recovered = win.filter(e => e.kind === "auto-recovering" && !collapsedSessions.has(e.sessionId));

let withSecondMismatch = 0, withoutSecondMismatch = 0, noPmDataAtAll = 0;
let secondMismatchHasPlaceholder = 0, secondMismatchNoPlaceholder = 0;
const detail = [];

for (const ev of recovered) {
  const recs = pm.filter(p => p.sessionId === ev.sessionId && Math.abs(p.ts - ev.ts) < 30 * 60 * 1000).sort((a, b) => a.ts - b.ts);
  const recoveryRec = recs.find(r => r.intendedAround && r.intendedAround.startsWith("[loom:paste-recovery]"));
  if (recs.length === 0) { noPmDataAtAll++; continue; }
  if (!recoveryRec) { withoutSecondMismatch++; continue; }
  withSecondMismatch++;
  const hasPlaceholder = PLACEHOLDER_RE.test(recoveryRec.reportedAround || "");
  if (hasPlaceholder) secondMismatchHasPlaceholder++; else secondMismatchNoPlaceholder++;
  detail.push({ sessionId: ev.sessionId, ts: ev.iso, reportedAround: recoveryRec.reportedAround, hasPlaceholderToken: hasPlaceholder });
}

console.log("clean-recovery sessions sampled (excl. the 4 collapsed):", recovered.length);
console.log("  with a second (recovery-turn) prompt-mismatch record:", withSecondMismatch);
console.log("    of those, reportedAround CONTAINS a placeholder-shaped token:", secondMismatchHasPlaceholder);
console.log("    of those, reportedAround is unrelated real text, NO placeholder token:", secondMismatchNoPlaceholder);
console.log("  without a second prompt-mismatch (clean, no interleaving detected):", withoutSecondMismatch);
console.log("  no prompt-mismatch coverage nearby (too early / gap in logging):", noPmDataAtAll);
console.log("\nDetail of the", withSecondMismatch, "clean-recovery sessions with a second mismatch:");
console.log(JSON.stringify(detail, null, 2));

console.log("\n=== CONTRAST ===");
console.log("collapsed group (n=4): 4 of 4 show a placeholder-shaped token in the recovery-turn's own mismatch record.");
console.log(`clean-recovery group with a second mismatch (n=${withSecondMismatch}): ${secondMismatchHasPlaceholder} of ${withSecondMismatch} show a placeholder-shaped token.`);
