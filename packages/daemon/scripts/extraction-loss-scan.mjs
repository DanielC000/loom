#!/usr/bin/env node
// extraction-loss-scan.mjs — comment-extraction loss scan scoped to ADDED lines + records (card 69f3bd03).
//
// WHY THIS EXISTS: docs/extraction-program.md item 4 told a tranche worker to take every distinctive
// token from a removed comment, "subtract those still present in the branch source", and check the
// remainder against records. Subtracting the WHOLE branch source masks a real loss: a token that recurs
// ANYWHERE else in a 17k-line file reads as "present" even when the specific clause carrying it was
// deleted. Two lanes reported "0 misses" on their own DoD-4 whole-file check while a scoped scan (added
// lines + the records the added @decision ids resolve to — and ONLY those) found real losses: host.ts
// tranche 43 (card 1c218980 — a dropped serial-ordering justification, a dropped example, a dropped
// "fail toward a duplicate" parenthetical, enumerated-case labels) and service.ts tranche 51 (card
// a6d52081). This script is that scoped instrument, so every worker runs the SAME check instead of
// hand-rolling a weaker one.
//
// ⛔ THIS SCRIPT NEVER CONSULTS THE UNCHANGED REMAINDER OF THE SOURCE FILE. That whole-file lookup is
// exactly the masking mode being fixed — a token present anywhere in the file, not just in what actually
// carries it forward (the added lines and the records those added lines' @decision ids resolve to), is
// not evidence the removed content survived.
//
// WHAT IT CHECKS, for one file's diff over --range (default main...HEAD):
//   1. non-comment removed/added line counts — both must be 0 for a comment-only tranche; each such line
//      is printed. (Class A/B/C/D taxonomy lives in this repo's CLAUDE.md; this script only checks that
//      no CODE moved, not which comment class a block belongs to.)
//   2. every added line over 112 bytes.
//   3. every @decision (sha:)?<8hex> id in the ADDED lines, and the record file(s) each resolves to under
//      docs/adr/, docs/decisions/, docs/investigations/<id>-*/ (recursively) IN THE WORKING TREE.
//   4. every REMOVED-line token (four patterns, case-insensitive: \b[a-z]{5,7}\b, \w{4,7}\(\),
//      [a-z][a-z0-9_]{7,}, \b[0-9a-f]{8}\b) not found in the added lines or in those record files —
//      printed as an advisory miss with its removed-line context.
//
// ⚠️ RECORD FILES ARE POOLED ACROSS THE WHOLE DIFF, not scoped to any one removed clause's own site:
// step 3 collects every @decision id from ANY added line in the file, and step 4 checks EVERY removed
// line's tokens against the union of all resolved record files. A clean run does NOT prove a removed
// clause was credited to a record anchored AT the site it was removed from — only that its tokens
// appear somewhere in that pooled corpus. Per docs/extraction-program.md item 4: a token that survives
// in some OTHER record (one not anchored at the removed clause's own site) does not carry it, and this
// script cannot see that distinction — resolve site-crediting by hand, per removed clause.
//
// Exit non-zero iff there is a non-comment removed/added line or an over-length added line — that is a
// structural violation of the "comment-only tranche" contract. A miss (item 4) is NEVER a reason to
// exit non-zero: it is a candidate to read by hand, and ordinary rewording produces them (see
// docs/extraction-program.md's own false-positive/false-negative notes on this class of check).
//
// RUN (from anywhere — this script resolves the repo root itself):
//   node packages/daemon/scripts/extraction-loss-scan.mjs <repo/relative/file> [--range <git-range>]
// ─────────────────────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(here, "..");
// --repo-root (test seam only, same posture as negative-control.mjs's own): every real invocation lets
// this resolve to the actual repo root; a test can point it at a throwaway synthetic git fixture instead
// of exercising this script against its own real, shared source tree.
const DEFAULT_REPO_ROOT = path.resolve(daemonRoot, "..", "..");

const DEFAULT_RANGE = "main...HEAD";
const MAX_ADDED_LINE_BYTES = 112;

const HELP = `extraction-loss-scan — comment-extraction loss scan scoped to added lines + records (card 69f3bd03)

Usage:
  node packages/daemon/scripts/extraction-loss-scan.mjs <repo/relative/file> \\
    [--range <git-range>] [--repo-root <path>]

  <file>       Repo-relative path to the source file your tranche changed. Positional, required.
  --range      Git range passed to \`git diff <range> -- <file>\`. Default: "${DEFAULT_RANGE}".
  --repo-root  Override the repo root <file> and --range are resolved against. Default: this script's
               own real repo. TEST SEAM ONLY — point a test at a throwaway synthetic git fixture instead
               of exercising this script against its own real, shared source tree.
  --help       Print this and exit 0.

Exit 0 unless a non-comment removed/added line or an over-${MAX_ADDED_LINE_BYTES}-byte added line is
found (both are printed either way) — those are structural violations of "comment-only tranche", not
advisory. Every reported miss (a removed-line token absent from both the added lines and the records its
added @decision ids resolve to) is advisory only and never affects the exit code.

Record files are POOLED across the whole diff, not scoped to any one removed clause's own site — a
clean run does not prove a removed clause was credited to a record anchored AT the site it came from.
Per docs/extraction-program.md item 4, resolve site-crediting by hand, per removed clause.
`;

function parseArgs(argv) {
  const args = { file: null, range: DEFAULT_RANGE, repoRoot: DEFAULT_REPO_ROOT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { args.help = true; continue; }
    if (a === "--range") { args.range = argv[++i]; continue; }
    if (a === "--repo-root") { args.repoRoot = argv[++i]; continue; }
    if (a.startsWith("--")) {
      console.error(`[extraction-loss-scan] unrecognized argument: ${a}`);
      process.exit(2);
    }
    if (args.file === null) { args.file = a; continue; }
    console.error(`[extraction-loss-scan] unexpected extra positional argument: ${a}`);
    process.exit(2);
  }
  return args;
}

/** Trimmed-empty, or a `//` `/*` `*` `*` / `#` prefixed line — the same comment-line test the extraction
 *  program's own DoD item 1 requires (recognising `/* * / JSDoc prefixes, not just `//`). */
function isCommentLine(line) {
  const t = line.trim();
  if (t === "") return true;
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*/") || t.startsWith("*") || t.startsWith("#");
}

function collectDiffLines(repoRoot, range, posixRel) {
  let diff;
  try {
    diff = execFileSync("git", ["diff", "--no-color", range, "--", posixRel], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`\`git diff ${range} -- ${posixRel}\` failed (${err.message})`);
  }
  const removed = [];
  const added = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { removed, added };
}

const DECISION_ID_RE = /@decision\s+(?:sha:)?([0-9a-fA-F]{8})\b/g;

function collectDecisionIds(addedLines) {
  const ids = new Set();
  for (const line of addedLines) {
    for (const m of line.matchAll(DECISION_ID_RE)) ids.add(m[1].toLowerCase());
  }
  return ids;
}

/** True iff `nameLower` is one of `ids` followed by a real boundary (`-`, `.`, or nothing) — never a bare
 *  prefix match, which would let id `deadbeef` match an unrelated `deadbeefcafe-other.md` (mirrors
 *  decision-records.mjs's own idBoundaryMatch). */
function matchesAnyId(nameLower, ids) {
  for (const id of ids) {
    if (!nameLower.startsWith(id)) continue;
    const rest = nameLower.slice(id.length);
    if (rest === "" || rest.startsWith("-") || rest.startsWith(".")) return true;
  }
  return false;
}

function collectFilesRecursively(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectFilesRecursively(full, out);
    else out.push(full);
  }
}

/** Every record FILE (plural — this is a loss-scan corpus, not the anchor resolver's single-winner
 *  pick) whose basename starts with one of `ids`, under docs/adr, docs/decisions (flat) and
 *  docs/investigations/<id>-*\/ (recursive), read from the WORKING TREE. */
function collectRecordFiles(repoRoot, ids) {
  if (ids.size === 0) return [];
  const files = [];
  for (const store of ["adr", "decisions"]) {
    const dir = path.join(repoRoot, "docs", store);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const lower = name.toLowerCase();
      if (lower.endsWith(".md") && matchesAnyId(lower, ids)) files.push(path.join(dir, name));
    }
  }
  const invDir = path.join(repoRoot, "docs", "investigations");
  let invEntries;
  try { invEntries = fs.readdirSync(invDir, { withFileTypes: true }); } catch { invEntries = []; }
  for (const entry of invEntries) {
    if (!entry.isDirectory()) continue;
    if (matchesAnyId(entry.name.toLowerCase(), ids)) collectFilesRecursively(path.join(invDir, entry.name), files);
  }
  return files;
}

// Case-insensitive per the card. Order doesn't matter — every match from every pattern is a candidate
// token, deduped by lowercased value below.
const TOKEN_PATTERNS = [
  /\b[a-z]{5,7}\b/gi,
  /\w{4,7}\(\)/gi,
  /[a-z][a-z0-9_]{7,}/gi,
  /\b[0-9a-f]{8}\b/gi,
];

function tokenize(line) {
  const tokens = new Set();
  for (const re of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) tokens.add(m[0]);
  }
  return tokens;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (!args.file) {
    console.error("[extraction-loss-scan] a repo-relative file path is required.\n");
    console.error(HELP);
    process.exit(2);
  }

  const repoRoot = args.repoRoot;
  const posixRel = args.file.replaceAll("\\", "/");

  let removed, added;
  try {
    ({ removed, added } = collectDiffLines(repoRoot, args.range, posixRel));
  } catch (err) {
    console.error(`[extraction-loss-scan] ${err.message}`);
    process.exit(2);
  }

  const nonCommentRemoved = removed.filter((l) => !isCommentLine(l));
  const nonCommentAdded = added.filter((l) => !isCommentLine(l));
  const overLongAdded = added.filter((l) => Buffer.byteLength(l, "utf8") > MAX_ADDED_LINE_BYTES);

  console.log(`[extraction-loss-scan] ${posixRel} @ ${args.range}`);
  console.log(`  removed lines: ${removed.length} (non-comment: ${nonCommentRemoved.length})`);
  console.log(`  added lines:   ${added.length} (non-comment: ${nonCommentAdded.length}, over ${MAX_ADDED_LINE_BYTES} bytes: ${overLongAdded.length})`);

  let hardFail = false;
  if (nonCommentRemoved.length > 0) {
    hardFail = true;
    console.error(`\n[extraction-loss-scan] ❌ ${nonCommentRemoved.length} non-comment REMOVED line(s) — not a comment-only tranche:`);
    for (const l of nonCommentRemoved) console.error(`  - ${l}`);
  }
  if (nonCommentAdded.length > 0) {
    hardFail = true;
    console.error(`\n[extraction-loss-scan] ❌ ${nonCommentAdded.length} non-comment ADDED line(s) — not a comment-only tranche:`);
    for (const l of nonCommentAdded) console.error(`  - ${l}`);
  }
  if (overLongAdded.length > 0) {
    hardFail = true;
    console.error(`\n[extraction-loss-scan] ❌ ${overLongAdded.length} added line(s) over ${MAX_ADDED_LINE_BYTES} bytes:`);
    for (const l of overLongAdded) console.error(`  - (${Buffer.byteLength(l, "utf8")}B) ${l}`);
  }

  const ids = collectDecisionIds(added);
  const recordFiles = collectRecordFiles(repoRoot, ids);
  let corpus = added.join("\n").toLowerCase();
  for (const f of recordFiles) {
    try { corpus += "\n" + fs.readFileSync(f, "utf8").toLowerCase(); } catch { /* unreadable record — corpus just narrower, never wider */ }
  }

  console.log(`\n[extraction-loss-scan] ${ids.size} @decision id(s) in added lines; ${recordFiles.length} record file(s) resolved:`);
  for (const f of recordFiles) console.log(`  - ${path.relative(repoRoot, f).replaceAll("\\", "/")}`);

  const misses = new Map(); // lowercased token -> first removed-line context
  for (const line of removed) {
    for (const tok of tokenize(line)) {
      const lower = tok.toLowerCase();
      if (corpus.includes(lower)) continue;
      if (!misses.has(lower)) misses.set(lower, line);
    }
  }

  if (misses.size > 0) {
    console.log(`\n[extraction-loss-scan] ⚠️  ${misses.size} advisory miss(es) — removed-line token(s) found in NEITHER the added lines nor the resolved records. Candidates to read by hand; ordinary rewording produces these, so a miss is not itself proof of loss:`);
    for (const [tok, line] of misses) console.log(`  - "${tok}"  (from: ${line.trim()})`);
  } else {
    console.log("\n[extraction-loss-scan] ✅ no misses — every removed-line token appears in the added lines or a resolved record.");
  }

  console.log(hardFail
    ? "\n❌ extraction-loss-scan FAILED — see the non-comment/over-length line(s) above."
    : "\n✅ extraction-loss-scan passed (structural check) — see any advisory misses above.");
  process.exit(hardFail ? 1 : 0);
}

main();
