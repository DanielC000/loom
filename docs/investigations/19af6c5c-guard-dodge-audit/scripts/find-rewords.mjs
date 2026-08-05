import fs from "node:fs";

const NEG_KEYWORDS = /\b(never|not\b|no\s|zero|absent|unaffected|unchanged|stops advancing|stayed|stays|frozen|didn.?t|doesn.?t|hasn.?t|won.?t|refuse|omit)/i;

// Extract a check(/assert( label from a line — matches even if the quote isn't closed on this line
// (label continues to next line), in which case we return {open:true, partial}.
function extractLabelStart(text) {
  const m = /(?:check|assert)\(\s*(["'`])/.exec(text);
  if (!m) return null;
  const quote = m[1];
  const rest = text.slice(m.index + m[0].length);
  const closeIdx = findUnescapedQuote(rest, quote);
  if (closeIdx === -1) return { open: true, quote, partial: rest };
  return { open: false, label: rest.slice(0, closeIdx) };
}

function findUnescapedQuote(s, quote) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === quote) return i;
  }
  return -1;
}

const raw = fs.readFileSync(process.argv[2], "utf8");
const lines = raw.split("\n");

let curCommit = null;
let curFile = null;
let hunkIdx = 0;
let hunk = null; // { removed: [{lineText, label}], added: [...] }
const candidates = [];

function flushHunk() {
  if (!hunk) return;
  const removedNeg = hunk.removed.filter((r) => r.label != null && NEG_KEYWORDS.test(r.label));
  const addedNonNeg = hunk.added.filter((a) => a.label != null && !NEG_KEYWORDS.test(a.label));
  if (removedNeg.length > 0 && addedNonNeg.length > 0) {
    candidates.push({
      commit: curCommit,
      file: curFile,
      removed: hunk.removed.filter((r) => r.label != null),
      added: hunk.added.filter((a) => a.label != null),
    });
  }
  hunk = null;
}

// Handle multi-line labels (open quote continuing across lines) per side.
let pendingRemoved = null; // {quote, partial}
let pendingAdded = null;

for (const line of lines) {
  if (line.startsWith("commit ")) {
    flushHunk();
    pendingRemoved = null; pendingAdded = null;
    curCommit = line.slice(7).trim();
    continue;
  }
  if (line.startsWith("--- a/") || line.startsWith("--- /dev/null")) continue;
  if (line.startsWith("+++ b/")) {
    flushHunk();
    pendingRemoved = null; pendingAdded = null;
    curFile = line.slice(6).trim();
    continue;
  }
  if (line.startsWith("+++ /dev/null")) { curFile = null; continue; }
  if (line.startsWith("@@")) {
    flushHunk();
    pendingRemoved = null; pendingAdded = null;
    hunk = { removed: [], added: [] };
    continue;
  }
  if (!hunk) continue;
  if (line.startsWith("-") && !line.startsWith("---")) {
    const text = line.slice(1);
    if (pendingRemoved) {
      const closeIdx = findUnescapedQuote(text, pendingRemoved.quote);
      if (closeIdx === -1) { pendingRemoved.partial += "\n" + text; }
      else {
        hunk.removed.push({ lineText: text, label: pendingRemoved.partial + "\n" + text.slice(0, closeIdx) });
        pendingRemoved = null;
      }
      continue;
    }
    const ext = extractLabelStart(text);
    if (ext && ext.open) { pendingRemoved = { quote: ext.quote, partial: ext.partial }; }
    else if (ext) { hunk.removed.push({ lineText: text, label: ext.label }); }
    else { hunk.removed.push({ lineText: text, label: null }); }
    continue;
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    const text = line.slice(1);
    if (pendingAdded) {
      const closeIdx = findUnescapedQuote(text, pendingAdded.quote);
      if (closeIdx === -1) { pendingAdded.partial += "\n" + text; }
      else {
        hunk.added.push({ lineText: text, label: pendingAdded.partial + "\n" + text.slice(0, closeIdx) });
        pendingAdded = null;
      }
      continue;
    }
    const ext = extractLabelStart(text);
    if (ext && ext.open) { pendingAdded = { quote: ext.quote, partial: ext.partial }; }
    else if (ext) { hunk.added.push({ lineText: text, label: ext.label }); }
    else { hunk.added.push({ lineText: text, label: null }); }
    continue;
  }
}
flushHunk();

function words(s) {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1));
}
function jaccard(a, b) {
  const wa = words(a), wb = words(b);
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union === 0 ? 0 : inter / union;
}

const pairs = [];
for (const c of candidates) {
  const removedNeg = c.removed.filter((r) => NEG_KEYWORDS.test(r.label));
  const addedNonNeg = c.added.filter((a) => !NEG_KEYWORDS.test(a.label));
  for (const r of removedNeg) {
    for (const a of addedNonNeg) {
      const sim = jaccard(r.label, a.label);
      pairs.push({ commit: c.commit, file: c.file, oldLabel: r.label, newLabel: a.label, sim });
    }
  }
}
pairs.sort((x, y) => y.sim - x.sim);

console.log(`Found ${candidates.length} candidate hunks; ${pairs.length} high-similarity reword pairs (Jaccard >= 0.3)\n`);
for (const p of pairs) {
  console.log(`sim=${p.sim.toFixed(2)}  commit ${p.commit}  file ${p.file}`);
  console.log(`  - "${p.oldLabel}"`);
  console.log(`  + "${p.newLabel}"`);
  console.log();
}
