#!/usr/bin/env node
// comment-anchor-lint.mjs — WARN-ONLY lint for the decision-anchor convention (card 5329a9af; wired as a
// live hook by card 67621894). Two entry points, one script:
//   1. CLI whole-repo scan: `node comment-anchor-lint.mjs [repoRoot] [--min-lines=N]` — prints the full
//      JSON report (all three checks, see below) to stdout. Manual/reporting use only; NOT what the hook
//      below invokes (a whole-repo scan on every Write/Edit would reintroduce the per-invocation hook cost
//      card 5244adc2 just existed to remove — see COMMENT_ANCHOR_LINT_SCRIPT's own doc in paths.ts).
//   2. PostToolUse hook: `node comment-anchor-lint.mjs --hook <repoRoot>` (matcher Write|Edit), reading the
//      hook payload on stdin and linting ONLY the one file just written (`runHook`/`computeFileReport`
//      below) — never a repo-wide scan. See `writeSessionSettings` (claude-settings.ts) for the wiring.
// Neither mode ever fails the process on a violation — "warn-only" is realized as an exit-code contract,
// not a config flag, so wiring this into anything later can never accidentally turn it blocking by
// omission. See the card's own Sequencing note for why blocking mode waits on a separate step (extracting
// the comment-heaviest files first).
//
// FIELD DETERMINATION (card 9b293b4b, 2026-09-09) — do not reintroduce a `systemMessage` copy on the
// hook's emitted payload (see `emitHook`/`runHook` below): it used to carry the advisory via BOTH
// `systemMessage` and `hookSpecificOutput.additionalContext`, "whichever the running Claude honors" — a
// hedge never actually checked. Card da723d41 checked it empirically for decision-records.mjs (three
// controlled `claude -p` trials, incl. a swapped-values control) and found `additionalContext` is the
// ONLY field the model ever sees; `systemMessage` is UI-only and never reaches it. This hook's own
// message is "the advisory text handed back to the agent" (see `formatHookMessage` below), not the human
// at the terminal, so the same determination applies here. See project memory
// `posttooluse-hook-honors-additionalcontext-not-systemmessage` and decision-records.mjs's own header for
// the full method.
//
// Three checks, matching CLAUDE.md's comment-taxonomy section (card 90b19799):
//   1. unanchoredLongBlocks — a contiguous comment block >= `minLines` (default DEFAULT_MIN_LINES) with
//      no `@decision <id>` anywhere in it. The "narrative is regrowing in source" signal.
//   2. orphanAnchors — an `@decision <id>` whose id resolves to no record in ANY of the three stores this
//      convention actually uses at runtime (docs/adr, docs/decisions, docs/investigations/<id>-*/
//      findings.md — the same three `decision-records.mjs` resolves against; the card's own text says
//      "either register" naming only the first two, but mirroring the shipped resolver's full three-store
//      set is what avoids flagging an anchor that legitimately resolves via investigations).
//   3. orphanRecords — a record with no inbound anchor anywhere in the swept source. ADVISORY, never an
//      error (see `advisory: true` on its report key) — a policy-level record can correctly have no single
//      anchor site, and treating this as a hard violation trains people to ignore the whole lint.
//      ⛔ NOT run by the hook (`runHook`/`computeFileReport` below), by design: it needs the WHOLE anchor
//      corpus (every source file's anchors) to know whether a record has zero inbound sites anywhere — a
//      single changed file can never answer that on its own, and re-scanning the whole repo to answer it
//      per-Write is exactly the cost the hook exists to avoid (see this file's own header). CLI-scan mode
//      only; a project wanting this check run stays on the manual/whole-repo path.
//
// A <= GUARD_MAX_LINES-line block that DOES carry an anchor is the convention's TARGET STATE (Class A: a
// short guard/prohibition, permanently inline) and is counted separately as `guardClassBlocks` — it is
// structurally excluded from `unanchoredLongBlocks` (that check only ever looks at blocks with NO anchor)
// and must never appear there; `packages/daemon/test/comment-anchor-lint.mjs` asserts this directly.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Comment-syntax-agnostic, byte-identical to decision-records.mjs's own ANCHOR_RE — kept as a separate
// literal here (not imported) because assets ship as standalone files invoked by bare `node <path>`,
// mirroring the same duplication already accepted between decision-records.mjs and claude-settings.ts's
// `anyDecisionRecordStoreExists` (see that function's own doc for why, and the same "keep in sync" note
// applies here).
const ANCHOR_RE = /@decision\s+([0-9a-f]{8})\b/gi;
const FLAT_STORES = ["adr", "decisions"];

// Default N (DoD-3): justified against THIS repo's OWN measured block-length distribution (OBSERVED —
// `node comment-anchor-lint.mjs .` against base commit 67e5c672, population = the 5 SOURCE_ROOTS below,
// 326 files, 10663 blocks — never the card's second-hand figures, which are a DIFFERENT measurement).
// Bucketed by share of total comment VOLUME (lines, not block count): 1-3 lines 11.8%, 4-10 lines 33.2%,
// 11-25 lines 28.0%, 26+ lines 27.0%. 15 sits inside the "11-25" bucket — the largest non-trivial share —
// and clear of the 1-3/4-10 range where the guard-class and ordinary short-comment population lives.
export const DEFAULT_MIN_LINES = 15;
// Class A guard/prohibition ceiling (CLAUDE.md comment taxonomy): "compressed to <=3 lines". A block at
// or under this length that carries an anchor is the target state, never a violation.
export const GUARD_MAX_LINES = 3;

const SOURCE_ROOTS = [
  ["packages", "daemon", "src"],
  ["packages", "daemon", "assets"],
  ["packages", "daemon", "scripts"],
  ["packages", "web", "src"],
  ["packages", "shared", "src"],
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs"]);
// `test`/`tests`/`e2e` excluded deliberately: this repo's own test fixtures plant SYNTHETIC anchor ids
// (aaaaaaaa, deadbeef, cafebabe, ...) with no matching record by design — sweeping them would report
// fixture noise as real orphan-anchor violations. Measuring against real production source only.
const EXCLUDE_SEGMENTS = new Set(["node_modules", "dist", ".turbo", "coverage", "test", "tests", "e2e", ".git"]);
// `SOURCE_ROOTS`, posix-joined with a trailing slash, for the hook's cheap per-file "is this path even in
// scope" prefix test (`isInScope` below) — the same roots `walkSourceFiles` walks for the CLI scan, just
// tested against one relative path instead of driving a directory walk.
const SOURCE_ROOT_PREFIXES = SOURCE_ROOTS.map((parts) => `${parts.join("/")}/`);

const BUCKETS = [
  { key: "1-3", min: 1, max: 3 },
  { key: "4-10", min: 4, max: 10 },
  { key: "11-25", min: 11, max: 25 },
  { key: "26+", min: 26, max: Infinity },
];

function relPath(repoRoot, p) {
  return path.relative(repoRoot, p).replace(/\\/g, "/");
}

/**
 * Group `lines` into maximal contiguous comment-only runs — a blank line or a non-comment line always
 * breaks a block, mirroring `decision-records.mjs`'s own `expandStartToBlock` convention ("blank line =
 * block boundary") so both tools agree on what counts as one block. Handles `//` line comments and
 * `/* ... *\/` block comments (single- or multi-line); does not attempt to distinguish trailing code on
 * the line a block comment closes on — this repo's own style never puts code there.
 */
export function extractCommentBlocks(lines) {
  const blocks = [];
  let start = null;
  let anchors = new Set();
  let inBlock = false;

  const flush = (endLineNo) => {
    if (start !== null) {
      blocks.push({ startLine: start, endLine: endLineNo, length: endLineNo - start + 1, anchorIds: [...anchors] });
    }
    start = null;
    anchors = new Set();
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    let isComment = false;

    if (inBlock) {
      isComment = true;
      if (trimmed.includes("*/")) inBlock = false;
    } else if (trimmed.startsWith("//")) {
      isComment = true;
    } else if (trimmed.startsWith("/*")) {
      isComment = true;
      if (!trimmed.includes("*/")) inBlock = true;
    }

    if (isComment) {
      if (start === null) start = lineNo;
      for (const m of lines[i].matchAll(ANCHOR_RE)) anchors.add(m[1].toLowerCase());
    } else {
      flush(lineNo - 1);
    }
  }
  flush(lines.length);
  return blocks;
}

/** Every `@decision <id>` site in `lines`, independent of comment-block grouping (an anchor is still an
 * anchor even on a line this file's own block heuristic fails to classify as a comment). */
export function findFileAnchors(lines) {
  const found = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(ANCHOR_RE)) found.push({ id: m[1].toLowerCase(), line: i + 1 });
  });
  return found;
}

/** True iff `nameLower` is `id` followed by a real boundary — mirrors decision-records.mjs's own
 * `idBoundaryMatch` (same rationale: never let id `deadbeef` bare-prefix-match `deadbeefcafe-other.md`). */
function idBoundaryMatch(nameLower, id) {
  if (!nameLower.startsWith(id)) return false;
  const rest = nameLower.slice(id.length);
  return rest === "" || rest.startsWith("-") || rest.startsWith(".");
}

/** Every record this convention can actually resolve an anchor against, across all three stores
 * `decision-records.mjs` resolves at runtime (see this file's header for why investigations is included
 * despite the card text naming only two registers). */
export function listRecordIds(repoRoot) {
  const records = [];
  for (const store of FLAT_STORES) {
    const dir = path.join(repoRoot, "docs", store);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const lower = name.toLowerCase();
      if (!lower.endsWith(".md") || lower === "template.md") continue;
      const m = /^([0-9a-f]{8})[-.]/.exec(lower);
      if (m && idBoundaryMatch(lower, m[1])) records.push({ id: m[1], path: path.join(dir, name) });
    }
  }
  const invDir = path.join(repoRoot, "docs", "investigations");
  let entries;
  try { entries = fs.readdirSync(invDir, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const lower = e.name.toLowerCase();
    const m = /^([0-9a-f]{8})-/.exec(lower);
    if (!m) continue;
    const findings = path.join(invDir, e.name, "findings.md");
    if (fs.existsSync(findings)) records.push({ id: m[1], path: findings });
  }
  return records;
}

function walkSourceFiles(repoRoot) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (EXCLUDE_SEGMENTS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;
      if (SOURCE_EXTENSIONS.has(path.extname(e.name))) files.push(full);
    }
  };
  for (const parts of SOURCE_ROOTS) walk(path.join(repoRoot, ...parts));
  return files;
}

/** Bucket every block's LENGTH into the four card-cited ranges, reporting each bucket's share of total
 * comment VOLUME (sum of block lengths in the bucket / sum over all blocks) — a block count would
 * under-weight the few very long blocks that actually dominate how much narrative sits in source. */
export function bucketDistribution(blocks) {
  const totals = BUCKETS.map(() => ({ blocks: 0, lines: 0 }));
  let totalLines = 0;
  for (const b of blocks) {
    totalLines += b.length;
    const idx = BUCKETS.findIndex((bk) => b.length >= bk.min && b.length <= bk.max);
    if (idx >= 0) { totals[idx].blocks += 1; totals[idx].lines += b.length; }
  }
  const out = {};
  BUCKETS.forEach((bk, i) => {
    out[bk.key] = {
      blocks: totals[i].blocks,
      lines: totals[i].lines,
      pctOfCommentVolume: totalLines ? Number(((totals[i].lines / totalLines) * 100).toFixed(1)) : 0,
    };
  });
  return out;
}

/**
 * Scan `repoRoot` and compute all three checks plus the calibration distribution. Never throws on a
 * violation being found — violations are just data in the returned report (DoD-1/2: warn-only, with the
 * count reported). `opts.minLines` overrides `DEFAULT_MIN_LINES` (DoD-3: N is configurable).
 */
export function computeReport(repoRoot, opts = {}) {
  const minLines = Number.isInteger(opts.minLines) && opts.minLines > 0 ? opts.minLines : DEFAULT_MIN_LINES;
  const files = walkSourceFiles(repoRoot);
  const allBlocks = [];
  const allAnchors = [];

  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
    const lines = raw.split(/\r?\n/);
    for (const b of extractCommentBlocks(lines)) allBlocks.push({ file, ...b });
    for (const a of findFileAnchors(lines)) allAnchors.push({ ...a, file });
  }

  const records = listRecordIds(repoRoot);
  const recordIdSet = new Set(records.map((r) => r.id));
  const anchorIdSet = new Set(allAnchors.map((a) => a.id));

  const unanchoredLong = allBlocks.filter((b) => b.length >= minLines && b.anchorIds.length === 0);
  const guardClass = allBlocks.filter((b) => b.length <= GUARD_MAX_LINES && b.anchorIds.length > 0);

  // One representative site per orphaned id (a repeated anchor id isn't a new violation each occurrence).
  const orphanAnchorsById = new Map();
  for (const a of allAnchors) {
    if (!recordIdSet.has(a.id) && !orphanAnchorsById.has(a.id)) orphanAnchorsById.set(a.id, a);
  }
  const orphanRecords = records.filter((r) => !anchorIdSet.has(r.id));

  return {
    repoRoot,
    minLines,
    guardMaxLines: GUARD_MAX_LINES,
    filesScanned: files.length,
    totalCommentBlocks: allBlocks.length,
    totalAnchorSites: allAnchors.length,
    uniqueAnchorIds: anchorIdSet.size,
    recordCount: records.length,
    unanchoredLongBlocks: {
      count: unanchoredLong.length,
      items: unanchoredLong.map((b) => ({ file: relPath(repoRoot, b.file), startLine: b.startLine, endLine: b.endLine, length: b.length })),
    },
    guardClassBlocks: { count: guardClass.length },
    orphanAnchors: {
      count: orphanAnchorsById.size,
      items: [...orphanAnchorsById.values()].map((a) => ({ id: a.id, file: relPath(repoRoot, a.file), line: a.line })),
    },
    orphanRecords: {
      count: orphanRecords.length,
      advisory: true, // DoD-2: never an error — a policy-level record may legitimately have no anchor site.
      items: orphanRecords.map((r) => ({ id: r.id, path: relPath(repoRoot, r.path) })),
    },
    distribution: bucketDistribution(allBlocks),
  };
}

// --- per-file hook mode (card 67621894) -------------------------------------------------------------

/**
 * Cheap "is this path even worth linting" test — extension + SOURCE_ROOTS prefix + no excluded segment
 * (mirrors `walkSourceFiles`'s own filters, tested against one relative path instead of a directory walk).
 * Returns the repo-relative path on a match, else `null`. For a repo NOT shaped like this one (no
 * `packages/{daemon,web,shared}/...` layout — i.e. every OTHER Loom-managed project) every write fails
 * this prefix test and the hook is a fast no-op: the SOURCE_ROOTS list itself is what scopes this lint to
 * this repo, the same way the CLI scan is already scoped by it — not a new limitation the hook introduces.
 */
export function isInScope(repoRoot, filePath) {
  const rel = relPath(repoRoot, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null; // outside repoRoot entirely
  if (!SOURCE_EXTENSIONS.has(path.extname(filePath))) return null;
  if (!SOURCE_ROOT_PREFIXES.some((p) => rel.startsWith(p))) return null;
  if (rel.split("/").some((seg) => EXCLUDE_SEGMENTS.has(seg))) return null;
  return rel;
}

/**
 * The hook's actual per-file check: checks (1) unanchoredLongBlocks and (2) orphanAnchors — see this
 * file's header for why (3) orphanRecords is deliberately excluded — scoped to ONE file's already-read
 * `content`, never a repo walk. `listRecordIds` is the only filesystem cost beyond the one file read: a
 * `readdirSync` of up to three small `docs/<kind>` directories (a handful of entries each in this repo
 * today), not a source-tree scan — see this function's own doc in `computeReport` above for why it's cheap.
 * Returns `null` for a file outside `isInScope`'s scope; otherwise a report shaped for `formatHookMessage`
 * below (empty arrays when the file is in scope but has nothing to flag — a real, distinguishable "clean"
 * result, not the same `null` as "not even scanned").
 */
export function computeFileReport(repoRoot, filePath, content, opts = {}) {
  const rel = isInScope(repoRoot, filePath);
  if (rel === null) return null;
  const minLines = Number.isInteger(opts.minLines) && opts.minLines > 0 ? opts.minLines : DEFAULT_MIN_LINES;

  const lines = content.split(/\r?\n/);
  const blocks = extractCommentBlocks(lines);
  const anchors = findFileAnchors(lines);
  const unanchoredLong = blocks.filter((b) => b.length >= minLines && b.anchorIds.length === 0);

  const recordIdSet = new Set(listRecordIds(repoRoot).map((r) => r.id));
  const orphanAnchorsById = new Map();
  for (const a of anchors) {
    if (!recordIdSet.has(a.id) && !orphanAnchorsById.has(a.id)) orphanAnchorsById.set(a.id, a);
  }

  return {
    file: rel,
    minLines,
    unanchoredLongBlocks: unanchoredLong.map((b) => ({ startLine: b.startLine, endLine: b.endLine, length: b.length })),
    orphanAnchors: [...orphanAnchorsById.values()].map((a) => ({ id: a.id, line: a.line })),
  };
}

/** Render a non-empty `computeFileReport` result as the advisory text handed back to the agent. */
export function formatHookMessage(report) {
  const lines = [];
  if (report.unanchoredLongBlocks.length) {
    lines.push(`${report.unanchoredLongBlocks.length} unanchored long comment block(s) in ${report.file} (>= ${report.minLines} lines, no @decision anchor):`);
    for (const b of report.unanchoredLongBlocks) lines.push(`  - ${report.file}:${b.startLine}-${b.endLine} (${b.length} lines)`);
  }
  if (report.orphanAnchors.length) {
    lines.push(`${report.orphanAnchors.length} orphan @decision anchor(s) in ${report.file} (no record in docs/adr, docs/decisions, or docs/investigations):`);
    for (const a of report.orphanAnchors) lines.push(`  - ${report.file}:${a.line} — @decision ${a.id}`);
  }
  return `comment-anchor-lint (CLAUDE.md comment taxonomy, card 90b19799) flagged ${report.file}:\n${lines.join("\n")}\n`
    + `Advisory only: a long unanchored block may want "// @decision <id> — <the prohibition/consequence>" `
    + `(<=3 lines) plus an out-of-band record in docs/adr or docs/decisions; an orphan anchor needs a matching record file.`;
}

/**
 * Write `obj` as JSON to stdout and resolve only once the write has actually flushed (never before a
 * following `process.exit()` races the OS-level flush) — same shape as decision-records.mjs's own `emit`,
 * duplicated rather than imported for the same reason `ANCHOR_RE` is duplicated at the top of this file
 * (see that comment): each asset ships as a standalone file invoked by a bare `node <path>` spawn.
 */
function emitHook(obj) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    process.stdout.write(JSON.stringify(obj), finish);
    setTimeout(finish, 2000).unref();
  });
}

/**
 * `node comment-anchor-lint.mjs --hook <repoRoot>` — the PostToolUse hook entry point (matcher Write|Edit;
 * see `writeSessionSettings` in claude-settings.ts for the wiring + its docLint gate). Reads the hook
 * payload on stdin: `{tool_name, tool_input:{file_path}, cwd}`. `repoRoot` is handed in as an argv (the
 * session's own `opts.cwd` from PtyHost — see paths.ts's `COMMENT_ANCHOR_LINT_SCRIPT` doc) rather than
 * derived by walking up from `cwd` looking for `.git` (decision-records.mjs's approach) — cheaper, and
 * this hook has no need to double-check the written file is inside the SAME repo the session booted in:
 * `isInScope` already requires the file to resolve to a relative, non-`..` path under `repoRoot`, which a
 * file outside it can never do. A non-Write/Edit/MultiEdit tool, a missing/unreadable file, or a file
 * `isInScope` rejects are all fast, silent no-ops — byte-identical to a session with no hook wired at all.
 * Always exits 0 (see the dispatcher at the bottom of this file): a bug here must never block a real Write.
 */
async function runHook(repoRootArg) {
  if (!repoRootArg) return;
  const repoRoot = path.resolve(repoRootArg);

  let raw = "";
  for await (const c of process.stdin) raw += c;
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  const tool = payload.tool_name;
  if (tool !== "Write" && tool !== "Edit" && tool !== "MultiEdit") return;

  let filePath = payload.tool_input?.file_path;
  if (typeof filePath !== "string") return;
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  if (!path.isAbsolute(filePath)) filePath = path.resolve(cwd, filePath);

  if (isInScope(repoRoot, filePath) === null) return; // cheap reject before ever reading the file

  let content;
  try { content = fs.readFileSync(filePath, "utf8"); } catch { return; } // tool already ran → file is on disk

  const report = computeFileReport(repoRoot, filePath, content);
  if (!report || (report.unanchoredLongBlocks.length === 0 && report.orphanAnchors.length === 0)) return;

  const msg = formatHookMessage(report);
  await emitHook({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: msg } });
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.find((a) => !a.startsWith("--"));
  const repoRoot = path.resolve(positional || process.cwd());
  const minLinesArg = args.find((a) => a.startsWith("--min-lines="));
  const minLines = minLinesArg ? Number(minLinesArg.slice("--min-lines=".length)) : undefined;
  const report = computeReport(repoRoot, { minLines });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

// Only run as a CLI/hook when invoked directly (`node comment-anchor-lint.mjs ...`) — an import (the test
// file) must be able to pull in the exported functions above without triggering a scan as a side effect.
// `--hook <repoRoot>` (first argv) dispatches to the per-file PostToolUse hook (`runHook`, always exits 0,
// see its own doc); anything else stays the existing whole-repo CLI scan (`main`, unchanged).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv[2] === "--hook") {
    runHook(process.argv[3]).catch(() => {}).finally(() => process.exit(0));
  } else {
    main();
  }
}
