// Cross-check: does every KNOWN_UNAUDITED_WAITS / NEWLY_VISIBLE_UNAUDITED_WAITS (file,label) entry still
// literally exist as text in the current source? A baseline entry whose exact label text has vanished from
// the file (while the file itself still exists and still has wait-adjacent checks) is a candidate for a
// "the site was reworded out from under the baseline" event — either a legitimate retrofit (fine) or a
// silent reword (needs eyeballing). This does NOT re-derive the baseline; it's a read-only drift probe.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Investigation script for card 19af6c5c — see ../findings.md §5.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.resolve(__dirname, "..", "..", "..", "..", "packages", "daemon", "test");
const guardSrc = fs.readFileSync(path.join(TEST_DIR, "fixed-wait-negative-guard.mjs"), "utf8");

// Pull out the two Map literals via the actual module (safe: pure data, no side effects beyond guard's own run).
// Instead of re-parsing JS by regex, import the file's exported consts is not possible (no exports) — so we
// extract via a small eval-in-isolation of just the two map literals using a regex boundary + Function.
function extractMap(varName) {
  const marker = `const ${varName} = new Map([`;
  const start = guardSrc.indexOf(marker);
  if (start === -1) throw new Error(`could not find ${varName}`);
  const arrStart = start + marker.length - 1; // index of the opening [
  let depth = 0, i = arrStart, inStr = null;
  for (; i < guardSrc.length; i++) {
    const ch = guardSrc[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "/" && guardSrc[i + 1] === "/") {
      const nl = guardSrc.indexOf("\n", i);
      i = nl === -1 ? guardSrc.length : nl;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) break; }
  }
  const body = guardSrc.slice(arrStart, i + 1);
  // eslint-disable-next-line no-new-func
  return new Map(new Function(`return ${body}`)());
}

const KNOWN = extractMap("KNOWN_UNAUDITED_WAITS");
const NEWLY = extractMap("NEWLY_VISIBLE_UNAUDITED_WAITS");

let total = 0, missing = 0;
const missingEntries = [];
for (const [mapName, map] of [["KNOWN_UNAUDITED_WAITS", KNOWN], ["NEWLY_VISIBLE_UNAUDITED_WAITS", NEWLY]]) {
  for (const [file, labels] of map) {
    const fp = path.join(TEST_DIR, file);
    if (!fs.existsSync(fp)) {
      for (const label of labels) { total++; missing++; missingEntries.push({ mapName, file, label, reason: "file-does-not-exist" }); }
      continue;
    }
    const content = fs.readFileSync(fp, "utf8");
    for (const label of labels) {
      total++;
      if (!content.includes(label)) { missing++; missingEntries.push({ mapName, file, label, reason: "label-text-not-found-in-file" }); }
    }
  }
}

console.log(`Checked ${total} baseline entries; ${missing} have label text NOT literally present in current source.\n`);
for (const e of missingEntries) {
  console.log(`[${e.mapName}] ${e.file}  (${e.reason})`);
  console.log(`  "${e.label}"`);
}
