import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Investigation script for card 19af6c5c — see ../findings.md. Default REPO resolves to this repo's
// root (scripts/ -> 19af6c5c-guard-dodge-audit/ -> investigations/ -> docs/ -> repo root); override via
// SCAN_REPO to point at a throwaway repo (used for the positive control in findings.md §1).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.SCAN_REPO || path.resolve(__dirname, "..", "..", "..", "..");
const IDIOM_A = /\bsleep\(\s*[^)]+\)/;
const IDIOM_B = /new Promise\(\s*\(?\s*[a-zA-Z_$][\w$]*\s*\)?\s*=>\s*setTimeout\(\s*[a-zA-Z_$][\w$]*\s*,\s*[^)]+\)/;
const CHECK_OR_ASSERT_RE = /(?:check|assert)\(\s*(["'`])((?:(?!\1).)*)\1/g;

function pairsFromFile(path) {
  const text = fs.readFileSync(path, "utf8");
  const blocks = text.split(/\n\n/).filter((b) => b.startsWith("sim="));
  return blocks.map((b) => {
    const lines = b.split("\n");
    const header = lines[0];
    const commit = /commit ([0-9a-f]+)/.exec(header)[1];
    const file = /file (\S+)/.exec(header)[1];
    const oldLabel = lines[1].replace(/^\s*-\s*"/, "").replace(/"$/, "");
    const newLabel = lines[2].replace(/^\s*\+\s*"/, "").replace(/"$/, "");
    return { commit, file, oldLabel, newLabel, header };
  });
}

function fileAtCommit(commit, file) {
  try {
    return execFileSync("git", ["show", `${commit}:${file}`], { cwd: REPO, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    return null;
  }
}
function fileAtParent(commit, file) {
  try {
    return execFileSync("git", ["show", `${commit}~1:${file}`], { cwd: REPO, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    return null;
  }
}

function waitAdjacentForLabel(content, label) {
  if (!content) return { found: false };
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!IDIOM_A.test(lines[i]) && !IDIOM_B.test(lines[i])) continue;
    const window = lines.slice(i, i + 5).join("\n");
    for (const m of window.matchAll(CHECK_OR_ASSERT_RE)) {
      if (m[2] === label) return { found: true, waitLine: i + 1 };
    }
  }
  return { found: false };
}

const pairs = pairsFromFile(process.argv[2]);
console.log(`Checking ${pairs.length} pairs for fixed-wait adjacency (both BEFORE and AFTER the edit)...\n`);

const relevant = [];
for (const p of pairs) {
  const before = fileAtParent(p.commit, p.file);
  const after = fileAtCommit(p.commit, p.file);
  const beforeAdj = waitAdjacentForLabel(before, p.oldLabel);
  const afterAdj = waitAdjacentForLabel(after, p.newLabel);
  if (beforeAdj.found || afterAdj.found) {
    relevant.push({ ...p, beforeAdj, afterAdj });
  }
}

console.log(`${relevant.length} pairs are fixed-wait-adjacent (guard-relevant)\n`);
for (const r of relevant) {
  console.log(r.header);
  console.log(`  wait-adjacent BEFORE: ${r.beforeAdj.found}  AFTER: ${r.afterAdj.found}`);
  console.log(`  - "${r.oldLabel}"`);
  console.log(`  + "${r.newLabel}"`);
  console.log();
}
