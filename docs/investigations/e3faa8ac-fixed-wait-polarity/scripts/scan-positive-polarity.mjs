// Card e3faa8ac — MEASUREMENT-ONLY scanner. NOT wired into fixed-wait-negative-guard.mjs or any gate;
// this file is documentation of a measurement, re-runnable to re-derive it, never imported by the suite.
//
// QUESTION: fixed-wait-negative-guard.mjs (packages/daemon/test/) is scoped to NEGATIVE-polarity
// assertions only ("sleep, then assert something did NOT happen"). The wait that actually reddened a
// live merge gate (op 12040557, card 81a6e4e1, fixed in 003a1080) guarded a POSITIVE assertion instead
// (`surfacedCount === 2`) and was structurally invisible to the guard. How many POSITIVE-polarity fixed
// waits exist in the real corpus, and how many of those are actually LOAD-BEARING (the wait's own
// duration can flip the assertion's outcome) rather than a safe settle/cleanup wait before a stable
// check? See ../findings.md for the answer and its caveats — this script only produces the raw numbers.
//
// TWO-TIER output:
//   TIER 1 (broad): fixed-wait idiom (same IDIOM_A/B shape as the shipped guard) immediately (5-line
//     window, same as the shipped guard) followed by a check()/assert() whose label does NOT match
//     NEG_KEYWORDS — i.e. literally "the shipped guard's own methodology, polarity inverted." This is
//     the naive "flag every sleep()" superset findings.md argues AGAINST shipping as an enforced guard.
//   TIER 2 (load-bearing candidate, subset of TIER 1): the wait's enclosing block (bounded by the
//     nearest blank line above/below — see findings.md for why a fixed line-radius was rejected) also
//     carries evidence the wait is RACING another timing quantity, via either signal:
//       (a) "second-clock": a numerically-LARGER duration inside another sleep(...)/setTimeout(...) call
//           in the same block. Requires primaryDuration < otherDuration — the DIRECTIONAL refinement:
//           only a wait that is the SHORTER of two racing clocks can flip on overrun (see findings.md,
//           "direction, not polarity").
//       (b) "in-flight-promise": a variable assigned from an unawaited call BEFORE the wait line, later
//           referenced (in an await/Promise.all context) AFTER the check — a promise deliberately left
//           in-flight across the wait.
//   Both signals are heuristics with known false-positive modes — see findings.md, do not treat TIER 2
//   as "N load-bearing waits exist"; it is "N sites this heuristic flags", nothing stronger.
//
// USAGE: node scan-positive-polarity.mjs [testDir] [singleFile]
//   no args         -> scans packages/daemon/test relative to repo root (assumes cwd = repo root)
//   testDir          -> scan every *.mjs directly under testDir
//   testDir file     -> scan exactly ONE file at the given path (testDir arg is ignored in this mode,
//                        kept positional only so the specimen run reads naturally: `scan.mjs "" <file>`)
import fs from "node:fs";
import path from "node:path";

const TEST_DIR = process.argv[2] || path.join(process.cwd(), "packages", "daemon", "test");
const SINGLE_FILE = process.argv[3];

const IDIOM_A = /\bsleep\(\s*([^)]+)\)/;
const IDIOM_B = /new Promise\(\s*\(?\s*[a-zA-Z_$][\w$]*\s*\)?\s*=>\s*setTimeout\(\s*[a-zA-Z_$][\w$]*\s*,\s*([^)]+)\)/;
const NEG_KEYWORDS = /\b(never|not\b|no\s|zero|absent|unaffected|unchanged|stops advancing|stayed|stays|frozen|didn.?t|doesn.?t|hasn.?t|won.?t|refuse|omit)/i;
const CHECK_OR_ASSERT_RE = /(?:check|assert)\(\s*(["'`])((?:(?!\1).)*)\1/g;
const ANY_WAIT_DURATION_RE = /\bsleep\(\s*([^)]+)\)|setTimeout\(\s*[a-zA-Z_$][\w$]*\s*,\s*([^)]+)\)/g;
const UNAWAITED_ASSIGN_RE = /^\s*(?:const|let)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?!await\b)[a-zA-Z_$][\w$.]*\(/;

function walkTestFiles(dir) {
  if (SINGLE_FILE) return [SINGLE_FILE];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".mjs"));
}

const isCommentLine = (line) => /^\s*\/\//.test(line);

function scanFile(file) {
  const full = SINGLE_FILE ? file : path.join(TEST_DIR, file);
  const displayName = SINGLE_FILE ? path.basename(file) : file;
  const text = fs.readFileSync(full, "utf8");
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue; // don't scan comment text as code (same trap as card 743be0c9)
    if (!IDIOM_A.test(line) && !IDIOM_B.test(line)) continue;
    const durMatch = IDIOM_A.exec(line) || IDIOM_B.exec(line);
    const primaryDuration = durMatch ? (durMatch[1] || durMatch[2]) : null;

    const window = lines.slice(i, i + 5).join("\n");
    for (const m of window.matchAll(CHECK_OR_ASSERT_RE)) {
      const label = m[2];
      if (NEG_KEYWORDS.test(label)) continue; // the shipped guard's own territory
      const hit = { file: displayName, lineNo: i + 1, label, primaryDuration };

      // block boundary = nearest blank line above/below (see header + findings.md)
      let radiusStart = i;
      while (radiusStart > 0 && lines[radiusStart - 1].trim() !== "") radiusStart--;
      let radiusEnd = i;
      while (radiusEnd < lines.length - 1 && lines[radiusEnd + 1].trim() !== "") radiusEnd++;
      radiusEnd++; // slice-exclusive
      const radiusText = lines.slice(radiusStart, radiusEnd).join("\n");

      const primaryNum = primaryDuration && /^\d+$/.test(primaryDuration.trim()) ? Number(primaryDuration.trim()) : null;
      const otherDurations = [];
      for (const dm of radiusText.matchAll(ANY_WAIT_DURATION_RE)) {
        const d = (dm[1] || dm[2] || "").trim();
        if (/^\d+$/.test(d)) otherDurations.push(Number(d));
      }
      const secondClock = primaryNum !== null && otherDurations.some((d) => d > primaryNum);

      let inFlightPromise = false;
      for (let j = radiusStart; j < i; j++) {
        const am = UNAWAITED_ASSIGN_RE.exec(lines[j]);
        if (!am) continue;
        const varName = am[1];
        const afterCheckText = lines.slice(i, radiusEnd).join("\n");
        const refRe = new RegExp(`\\b${varName}\\b`);
        if (refRe.test(afterCheckText) && /await|Promise\.all/.test(afterCheckText)) { inFlightPromise = true; break; }
      }

      hit.loadBearingCandidate = secondClock || inFlightPromise;
      hit.signals = [secondClock ? "second-clock" : null, inFlightPromise ? "in-flight-promise" : null].filter(Boolean);
      hits.push(hit);
    }
  }
  return hits;
}

const files = walkTestFiles(TEST_DIR);
const allHits = [];
for (const file of files) for (const hit of scanFile(file)) allHits.push(hit);

const tier1 = allHits;
const tier2 = allHits.filter((h) => h.loadBearingCandidate);

const byFile = (list) => {
  const m = new Map();
  for (const h of list) m.set(h.file, (m.get(h.file) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log(`TIER 1 (positive-polarity fixed-wait candidates): ${tier1.length} sites across ${new Set(tier1.map((h) => h.file)).size} files`);
console.log(`TIER 2 (load-bearing subset — second-clock or in-flight-promise signal): ${tier2.length} sites across ${new Set(tier2.map((h) => h.file)).size} files`);
console.log("\n--- TIER 2 file distribution ---");
for (const [f, c] of byFile(tier2)) console.log(`  ${f}: ${c}`);
console.log("\n--- TIER 2 site detail ---");
for (const h of tier2) console.log(`  ${h.file}:${h.lineNo}  [${h.signals.join(",")}]  "${h.label}"`);
console.log("\n--- TIER 1 file distribution (for context) ---");
for (const [f, c] of byFile(tier1)) console.log(`  ${f}: ${c}`);
