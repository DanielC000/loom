// Read-only analysis script for card bbada785 DoD-1 (enumerate fixed-time waits in packages/daemon/test/**
// that gate an assertion on a timer/engine-driven transition). Mirrors fixed-wait-negative-guard.mjs's own
// idiom scan (IDIOM_A/IDIOM_B, 5-line window, CHECK_OR_ASSERT_RE) but WITHOUT the NEG_KEYWORDS filter, so it
// surfaces BOTH polarities — the guard only ever tracked negative-polarity sites (see its own baseline:
// KNOWN_UNAUDITED_WAITS + NEWLY_VISIBLE_UNAUDITED_WAITS). Also separately enumerates two idiom shapes the
// guard's own header says it cannot see at all: sleepUntil(...) absolute-deadline waits and windowMs:-style
// sampling (observeOnce/assertNever family — see card 0f744aa4). Does not modify anything; not part of the
// daemon test suite (scripts/test-daemon.mjs only scans packages/daemon/test/, not docs/).
//
// Run from the repo root: node docs/investigations/bbada785-fixed-wait-enumeration/scripts/enumerate-fixed-waits.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "../../../../packages/daemon/test");

const IDIOM_A = /\bsleep\(\s*[^)]+\)/;
const IDIOM_B = /new Promise\(\s*\(?\s*[a-zA-Z_$][\w$]*\s*\)?\s*=>\s*setTimeout\(\s*[a-zA-Z_$][\w$]*\s*,\s*[^)]+\)/;
const CHECK_OR_ASSERT_RE = /(?:check|assert)\(\s*(["'`])((?:(?!\1).)*)\1/g;
const NEG_KEYWORDS = /\b(never|not\b|no\s|zero|absent|unaffected|unchanged|stops advancing|stayed|stays|frozen|didn.?t|doesn.?t|hasn.?t|won.?t|refuse|omit)/i;
const SLEEP_UNTIL_RE = /\bsleepUntil\(/;
const WINDOW_MS_RE = /windowMs\s*:\s*([^\n,}]+)/;

function walkTestFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs"));
}

const allWaitThenCheck = []; // both polarities
const positiveOnly = []; // wait-then-check sites where label is NOT negative-polarity (guard never tracks these)
const sleepUntilSites = [];
const windowMsSites = [];

for (const file of walkTestFiles()) {
  const text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (IDIOM_A.test(line) || IDIOM_B.test(line)) {
      const window = lines.slice(i, i + 5).join("\n");
      for (const m of window.matchAll(CHECK_OR_ASSERT_RE)) {
        const label = m[2];
        const neg = NEG_KEYWORDS.test(label);
        const rec = { file, lineNo: i + 1, label, neg };
        allWaitThenCheck.push(rec);
        if (!neg) positiveOnly.push(rec);
      }
    }
    if (SLEEP_UNTIL_RE.test(line)) {
      sleepUntilSites.push({ file, lineNo: i + 1, text: line.trim() });
    }
    if (WINDOW_MS_RE.test(line)) {
      const m = WINDOW_MS_RE.exec(line);
      windowMsSites.push({ file, lineNo: i + 1, budget: m[1].trim(), text: line.trim() });
    }
  }
}

console.log(`=== wait(sleep/setTimeout-idiom)-then-check(): TOTAL ${allWaitThenCheck.length} sites, ${positiveOnly.length} POSITIVE-polarity (never tracked by fixed-wait-negative-guard.mjs) ===\n`);

console.log(`--- POSITIVE-polarity wait-then-check sites (file:line "label") ---`);
for (const r of positiveOnly) console.log(`${r.file}:${r.lineNo}  "${r.label}"`);

console.log(`\n=== sleepUntil(...) absolute-deadline sites: ${sleepUntilSites.length} ===`);
for (const r of sleepUntilSites) console.log(`${r.file}:${r.lineNo}  ${r.text}`);

console.log(`\n=== windowMs: sampling-window sites: ${windowMsSites.length} ===`);
for (const r of windowMsSites) console.log(`${r.file}:${r.lineNo}  budget=${r.budget}`);
