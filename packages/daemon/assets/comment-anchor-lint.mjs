#!/usr/bin/env node
// comment-anchor-lint.mjs — WARN-ONLY lint for the decision-anchor convention (card 5329a9af; wired as a
// live hook by card 67621894). Two entry points, one script:
//   1. CLI whole-repo scan: `node comment-anchor-lint.mjs [repoRoot] [--min-lines=N]` — prints the full
//      JSON report (all five checks, see below) to stdout. Manual/reporting use only; NOT what the hook
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
// Six checks, matching CLAUDE.md's comment-taxonomy section (card 90b19799):
//   1. unanchoredLongBlocks — a contiguous comment block >= `minLines` (default DEFAULT_MIN_LINES) with
//      no `@decision <id>` anywhere in it. The "narrative is regrowing in source" signal.
//   2. orphanAnchors — an `@decision <id>` whose id resolves to no record in ANY of the three stores this
//      convention actually uses at runtime (docs/adr, docs/decisions, docs/investigations/<id>-*/
//      findings.md — the same three `decision-records.mjs` resolves against; the card's own text says
//      "either register" naming only the first two, but mirroring the shipped resolver's full three-store
//      set is what avoids flagging an anchor that legitimately resolves via investigations). Card
//      969b0e1c: a `@decision sha:<id>` anchor is ALSO orphan if its sha no longer verifies as a real
//      commit in this repo (`anchorResolves`/`verifyCommitSha` below), even when a same-named record file
//      exists — mirroring `decision-records.mjs`'s own refuse-rather-than-fall-through resolver gate.
//   3. orphanRecords — a record with no inbound anchor anywhere in the swept source. ADVISORY, never an
//      error (see `advisory: true` on its report key) — a policy-level record can correctly have no single
//      anchor site, and treating this as a hard violation trains people to ignore the whole lint.
//      ⛔ NOT run by the hook (`runHook`/`computeFileReport` below), by design: it needs the WHOLE anchor
//      corpus (every source file's anchors) to know whether a record has zero inbound sites anywhere — a
//      single changed file can never answer that on its own, and re-scanning the whole repo to answer it
//      per-Write is exactly the cost the hook exists to avoid (see this file's own header). CLI-scan mode
//      only; a project wanting this check run stays on the manual/whole-repo path.
//   4. brokenAnchors (card ad3a9a85) — a `@decision` keyword NOT followed by a valid 8-hex id on the SAME
//      line: the shape a JSDoc line wrap produces when it breaks between the keyword and the id (`@decision`
//      on one continuation line, the id on the next). `ANCHOR_RE`/`findFileAnchors` match per-line, so a
//      wrapped anchor is invisible to every other check here — it looks like ordinary prose, never like an
//      orphan anchor (there is no anchor id to resolve) and never like an unanchored long block if the
//      surrounding block happens to be short. This is the ONLY check that catches it. Runs in BOTH the CLI
//      scan and the per-file hook (unlike orphanRecords above) — it needs only the one file already being
//      scanned, same as unanchoredLongBlocks/orphanAnchors.
//   5. oversizedRecords (card d0d0401b) — a record file (docs/adr, docs/decisions) whose byte size exceeds
//      `PER_RECORD_MAX_BYTES` (imported from decision-records.mjs — the SAME constant that script truncates
//      against at read time, never a second copy of the number). CLI-scan mode only: records live under
//      `docs/`, outside SOURCE_ROOTS, so the per-file hook (which only ever sees a write under
//      packages/{daemon,web,shared}) structurally never observes a record file being authored or edited.
//   6. collidingRecords (card a4b83fb7) — two or more record files (across docs/adr, docs/decisions, and
//      docs/investigations) whose ids resolve to the SAME id. `decision-records.mjs`'s own `resolveRecord()`
//      picks exactly ONE winner per id (store precedence, then alphabetically-first filename within that
//      store — replicated here, not imported, same reasoning as ANCHOR_RE's duplication above) and silently
//      drops every other file sharing that id, forever, with no error anywhere — the failure this check
//      exists to surface: a well-formed anchor that resolves, to the WRONG decision. Reports every colliding
//      id, every candidate file, and which one currently wins, so the author sees the casualty, not just a
//      count. CLI-scan mode only, same ground as oversizedRecords above: records live under `docs/`, outside
//      SOURCE_ROOTS, so the per-file hook structurally never observes a second record file for an id that
//      already has one.
//
// A <= GUARD_MAX_LINES-line block that DOES carry an anchor is the convention's TARGET STATE (Class A: a
// short guard/prohibition, permanently inline) and is counted separately as `guardClassBlocks` — it is
// structurally excluded from `unanchoredLongBlocks` (that check only ever looks at blocks with NO anchor)
// and must never appear there; `packages/daemon/test/comment-anchor-lint.mjs` asserts this directly.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PER_RECORD_MAX_BYTES } from "./decision-records.mjs";

// Comment-syntax-agnostic, byte-identical to decision-records.mjs's own ANCHOR_RE — kept as a separate
// literal here (not imported) because assets ship as standalone files invoked by bare `node <path>`,
// mirroring the same duplication already accepted between decision-records.mjs and claude-settings.ts's
// `anyDecisionRecordStoreExists` (see that function's own doc for why, and the same "keep in sync" note
// applies here). `PER_RECORD_MAX_BYTES` above is the one EXCEPTION to that duplication convention (see its
// own doc in decision-records.mjs): card d0d0401b's DoD requires this lint to read the cap from a single
// source of truth, not a hand-copied number, and that script's `main()` is import-safe (guarded — see its
// own dispatch at the bottom of that file), so importing just the constant carries none of the "standalone
// invocation" risk the regex/function duplication above exists to avoid.
//
// Card 969b0e1c: a TWO-NAMESPACE union, mirroring decision-records.mjs's own ANCHOR_RE exactly (see that
// file's doc for the full rationale) — `sha:([0-9a-f]{8})` (group 1) keys a verified commit; the bare
// `([0-9a-f]{8})` (group 2) is the unchanged original form and keys a board card. `parseAnchorMatch` and
// `verifyCommitSha` below are the SAME duplicated-not-imported shape as this regex.
const ANCHOR_RE = /@decision\s+(?:sha:([0-9a-f]{8})|([0-9a-f]{8}))\b/gi;

/** Normalize one `ANCHOR_RE` match into `{ns, id}` — mirrors decision-records.mjs's own `parseAnchorMatch`
 * exactly (same doc there). */
function parseAnchorMatch(m) {
  return m[1] ? { ns: "sha", id: m[1].toLowerCase() } : { ns: "card", id: m[2].toLowerCase() };
}

/** True iff `sha` resolves to a real commit in `repoRoot`'s git history — mirrors decision-records.mjs's
 * own `verifyCommitSha` exactly (same doc there, including why any failure — including the bounded
 * `timeout` below firing, review S2 card 969b0e1c — reads as UNVERIFIED, never thrown). Used by this
 * lint's `orphanAnchors` check so a `sha:`-sigil'd anchor whose commit no longer verifies is correctly
 * reported as orphaned, not silently counted as resolved just because a same-named record file exists. */
function verifyCommitSha(repoRoot, sha) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** True iff anchor `a` ({ns, id}) resolves against `recordIdSet` (the set of ids `listRecordIds` found a
 * record for) — the `orphanAnchors` check's own resolvability predicate, deliberately mirroring (never
 * importing) `decision-records.mjs`'s `resolveRecord` gate: a `ns === "sha"` anchor is orphan unless its id
 * BOTH has a record file AND verifies as a real commit in `repoRoot`; a `ns === "card"` anchor is orphan
 * iff it merely has no record (unchanged, no verification). The record-existence check runs FIRST here
 * (unlike `resolveRecord`, which verifies first) — cheap and side-effect-free, so it's a pure optimization
 * that avoids a `git` subprocess call for an anchor that's doomed to be orphan either way; the final
 * boolean is identical regardless of order. `shaCache` (a Map) memoizes one `verifyCommitSha` call per
 * distinct sha id across the whole sweep, since the SAME sha may be cited at multiple anchor sites. */
function anchorResolves(repoRoot, a, recordIdSet, shaCache) {
  if (!recordIdSet.has(a.id)) return false;
  if (a.ns !== "sha") return true;
  if (!shaCache.has(a.id)) shaCache.set(a.id, verifyCommitSha(repoRoot, a.id));
  return shaCache.get(a.id);
}

/** Render one anchor's id for a human-facing report line — `sha:<id>` for a commit-namespaced anchor,
 * bare `<id>` for a card one (card 969b0e1c: the sigil must survive into every report/message this lint
 * produces, not just the source grammar, so a reader can never confuse the two id-spaces). */
function renderAnchorId(a) { return a.ns === "sha" ? `sha:${a.id}` : a.id; }

// Card ad3a9a85: a `@decision` keyword that is the LAST thing on its line (only trailing whitespace may
// follow) — the exact shape a JSDoc continuation wrap leaves behind when it breaks the keyword from its
// id onto the next line. Deliberately NARROWER than "not followed by a valid id anywhere on the line":
// a first pass used `/@decision\b(?!\s+[0-9a-f]{8}\b)/` (any `@decision` not immediately followed by a
// valid id) and, swept against this repo, flagged 26 sites — EVERY ONE a false positive, never a real
// wrapped anchor: this file's own doc comments describing the convention (`` `@decision <id>` `` as
// prose), the `ANCHOR_RE`/ANCHOR_RE-equivalent regex LITERAL definitions in this file, decision-records.mjs
// and mcp/decisions.ts (the regex source text itself contains the bare string "@decision" followed by
// `\s+(` — not real whitespace+hex), and this lint's own `formatHookMessage` output strings ("... no
// @decision anchor)", "— @decision ${a.id}"). The mid-line mention of the literal token "@decision" is
// common and legitimate; only a keyword with NOTHING after it on the line is the actual defect signature
// — a real wrap always leaves the keyword dangling alone at end-of-line. See `findBrokenAnchors` below.
// ⛔ Narrower scope, stated plainly: this does NOT catch a same-line malformed id (e.g. `@decision 12ab`,
// too short) — that's a different, rarer shape outside this card's DoD, which is specifically the wrap.
const BROKEN_ANCHOR_RE = /@decision\b\s*$/i;
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
      // `anchorIds` stays a plain set of bare hex ids, namespace-blind — this block-level check only ever
      // asks "does this block carry ANY anchor" (guardClassBlocks / unanchoredLongBlocks), which doesn't
      // care which namespace resolved it; namespace only matters to `orphanAnchors`, which uses
      // `findFileAnchors` below instead.
      for (const m of lines[i].matchAll(ANCHOR_RE)) anchors.add(parseAnchorMatch(m).id);
    } else {
      flush(lineNo - 1);
    }
  }
  flush(lines.length);
  return blocks;
}

/** Every `@decision <id>` site in `lines`, independent of comment-block grouping (an anchor is still an
 * anchor even on a line this file's own block heuristic fails to classify as a comment). Each entry now
 * also carries `ns` (`"card"` or `"sha"`, card 969b0e1c) alongside the unchanged `id`/`line` fields —
 * purely additive, so existing callers that only read `.id`/`.line` are unaffected. */
export function findFileAnchors(lines) {
  const found = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(ANCHOR_RE)) found.push({ ...parseAnchorMatch(m), line: i + 1 });
  });
  return found;
}

/** Every `@decision` keyword site in `lines` with NOTHING else after it on the same line (card ad3a9a85) —
 * the shape a JSDoc continuation wrap leaves behind when it splits the keyword from its id onto the next
 * line. See `BROKEN_ANCHOR_RE`'s own doc for why this is deliberately narrower than "not followed by a
 * valid id anywhere on the line" (that broader shape false-positives on every mid-line mention of the
 * token). Independent of comment-block grouping, same as `findFileAnchors` above (a broken anchor is
 * still broken even on a line this file's block heuristic fails to classify as a comment). */
export function findBrokenAnchors(lines) {
  const found = [];
  lines.forEach((line, i) => {
    if (BROKEN_ANCHOR_RE.test(line)) found.push({ line: i + 1 });
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

/** Every record in `records` (as returned by `listRecordIds`) whose file exceeds `maxBytes` — measured the
 * SAME way `decision-records.mjs`'s own `truncateRecord` measures it (UTF-8 byte length of the raw file
 * text, never a character/UTF-16 count — this repo's house typography is multi-byte, so the two diverge).
 * Card d0d0401b: this is the visible, authoring-time half of the size constraint; read-time truncation
 * (decision-records.mjs) stays the last-resort safety net, unchanged. An unreadable record is skipped
 * (never crashes the sweep) — a record that can't be read can't be injected either, so it's not this
 * check's problem to report. */
export function findOversizedRecords(records, maxBytes) {
  const oversized = [];
  for (const r of records) {
    let text;
    try { text = fs.readFileSync(r.path, "utf8"); } catch { continue; }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) oversized.push({ id: r.id, path: r.path, bytes });
  }
  return oversized;
}

/**
 * Every id with more than one candidate record file across the three stores, naming EVERY candidate and
 * which one currently wins (card a4b83fb7). Deliberately NOT built from `listRecordIds` above — that
 * function collapses store identity into a flat list, which loses exactly the information needed to
 * replicate `decision-records.mjs`'s own `resolveRecord()` winner pick: store precedence (`docs/adr`
 * before `docs/decisions` before `docs/investigations` — an id split across stores is decided by
 * precedence ALONE, never by filename, even if a `docs/decisions` file would sort first alphabetically),
 * then alphabetically-first WITHIN the winning store. This walks the same three directories itself
 * (duplicated, not imported — same "assets ship standalone" reasoning as `ANCHOR_RE`/`idBoundaryMatch`
 * above) so the winner this check reports is never a second, drifting implementation of that rule.
 * `.md` sort uses plain `<`/`>` (mirrors `resolveRecord`'s bare `.sort()`, i.e. UTF-16 code-unit order —
 * these filenames are ASCII, so this is equivalent to `resolveRecord`'s own default sort in every real
 * case); the investigations directory match uses `localeCompare`, mirroring `resolveRecord`'s own second
 * sort call exactly. Every other candidate for that id is DARK: unreachable by any anchor, ever, however
 * many anchors cite it — see this check's own header doc above for why neither `orphanAnchors` nor
 * `orphanRecords` can ever catch this (the anchor resolves fine; every candidate file has a record).
 */
export function findCollidingRecords(repoRoot) {
  const STORE_ORDER = [...FLAT_STORES, "investigations"];
  const byId = new Map(); // id -> [{ store, name, path }], in no particular order within the array

  for (const store of FLAT_STORES) {
    const dir = path.join(repoRoot, "docs", store);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const lower = name.toLowerCase();
      if (!lower.endsWith(".md") || lower === "template.md") continue;
      const m = /^([0-9a-f]{8})[-.]/.exec(lower);
      if (!m || !idBoundaryMatch(lower, m[1])) continue;
      const id = m[1];
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push({ store, name, path: path.join(dir, name) });
    }
  }
  const invDir = path.join(repoRoot, "docs", "investigations");
  let invEntries;
  try { invEntries = fs.readdirSync(invDir, { withFileTypes: true }); } catch { invEntries = []; }
  for (const e of invEntries) {
    if (!e.isDirectory()) continue;
    const lower = e.name.toLowerCase();
    const m = /^([0-9a-f]{8})-/.exec(lower);
    if (!m || !idBoundaryMatch(lower, m[1])) continue;
    const findings = path.join(invDir, e.name, "findings.md");
    if (!fs.existsSync(findings)) continue;
    const id = m[1];
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ store: "investigations", name: e.name, path: findings });
  }

  const colliding = [];
  for (const [id, candidates] of byId) {
    if (candidates.length <= 1) continue;
    let winner = null;
    for (const store of STORE_ORDER) {
      const inStore = candidates.filter((c) => c.store === store);
      if (inStore.length === 0) continue;
      winner = store === "investigations"
        ? [...inStore].sort((a, b) => a.name.localeCompare(b.name))[0]
        : [...inStore].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
      break;
    }
    colliding.push({
      id,
      winnerPath: relPath(repoRoot, winner.path),
      darkPaths: candidates.filter((c) => c !== winner).map((c) => relPath(repoRoot, c.path)),
    });
  }
  return colliding;
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
 * Scan `repoRoot` and compute all six checks plus the calibration distribution. Never throws on a
 * violation being found — violations are just data in the returned report (DoD-1/2: warn-only, with the
 * count reported). `opts.minLines` overrides `DEFAULT_MIN_LINES` (DoD-3: N is configurable).
 */
export function computeReport(repoRoot, opts = {}) {
  const minLines = Number.isInteger(opts.minLines) && opts.minLines > 0 ? opts.minLines : DEFAULT_MIN_LINES;
  const files = walkSourceFiles(repoRoot);
  const allBlocks = [];
  const allAnchors = [];
  const allBroken = [];

  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
    const lines = raw.split(/\r?\n/);
    for (const b of extractCommentBlocks(lines)) allBlocks.push({ file, ...b });
    for (const a of findFileAnchors(lines)) allAnchors.push({ ...a, file });
    for (const b of findBrokenAnchors(lines)) allBroken.push({ ...b, file });
  }

  const records = listRecordIds(repoRoot);
  const recordIdSet = new Set(records.map((r) => r.id));
  const anchorIdSet = new Set(allAnchors.map((a) => a.id));
  const oversizedRecords = findOversizedRecords(records, PER_RECORD_MAX_BYTES);
  const collidingRecords = findCollidingRecords(repoRoot);

  const unanchoredLong = allBlocks.filter((b) => b.length >= minLines && b.anchorIds.length === 0);
  const guardClass = allBlocks.filter((b) => b.length <= GUARD_MAX_LINES && b.anchorIds.length > 0);

  // One representative site per orphaned (ns, id) pair (a repeated anchor isn't a new violation each
  // occurrence) — keyed by "ns:id" (card 969b0e1c) so a sha-sigil'd anchor and a card anchor sharing the
  // same 8 hex characters are never conflated into one orphan entry.
  const shaCache = new Map();
  const orphanAnchorsById = new Map();
  for (const a of allAnchors) {
    const key = `${a.ns}:${a.id}`;
    if (!anchorResolves(repoRoot, a, recordIdSet, shaCache) && !orphanAnchorsById.has(key)) orphanAnchorsById.set(key, a);
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
      // `id` stays the bare hex (namespace-blind — unchanged shape, so an existing card-id comparison like
      // `items[0].id === "dddddddd"` keeps working); `ns` is additive (card 969b0e1c).
      items: [...orphanAnchorsById.values()].map((a) => ({ id: a.id, ns: a.ns, file: relPath(repoRoot, a.file), line: a.line })),
    },
    orphanRecords: {
      count: orphanRecords.length,
      advisory: true, // DoD-2: never an error — a policy-level record may legitimately have no anchor site.
      items: orphanRecords.map((r) => ({ id: r.id, path: relPath(repoRoot, r.path) })),
    },
    brokenAnchors: {
      count: allBroken.length,
      items: allBroken.map((b) => ({ file: relPath(repoRoot, b.file), line: b.line })),
    },
    oversizedRecords: {
      count: oversizedRecords.length,
      maxBytes: PER_RECORD_MAX_BYTES,
      items: oversizedRecords.map((r) => ({ id: r.id, path: relPath(repoRoot, r.path), bytes: r.bytes })),
    },
    collidingRecords: {
      count: collidingRecords.length,
      items: collidingRecords,
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
 * The hook's actual per-file check: checks (1) unanchoredLongBlocks, (2) orphanAnchors, and (4) brokenAnchors
 * — see this file's header for why (3) orphanRecords and (5) oversizedRecords are deliberately excluded —
 * scoped to ONE file's already-read `content`, never a repo walk. `listRecordIds` is the only filesystem cost beyond the one file read: a
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
  const broken = findBrokenAnchors(lines);
  const unanchoredLong = blocks.filter((b) => b.length >= minLines && b.anchorIds.length === 0);

  const recordIdSet = new Set(listRecordIds(repoRoot).map((r) => r.id));
  const shaCache = new Map();
  const orphanAnchorsById = new Map();
  for (const a of anchors) {
    const key = `${a.ns}:${a.id}`;
    if (!anchorResolves(repoRoot, a, recordIdSet, shaCache) && !orphanAnchorsById.has(key)) orphanAnchorsById.set(key, a);
  }

  return {
    file: rel,
    minLines,
    unanchoredLongBlocks: unanchoredLong.map((b) => ({ startLine: b.startLine, endLine: b.endLine, length: b.length })),
    orphanAnchors: [...orphanAnchorsById.values()].map((a) => ({ id: a.id, ns: a.ns, line: a.line })),
    brokenAnchors: broken.map((b) => ({ line: b.line })),
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
    for (const a of report.orphanAnchors) lines.push(`  - ${report.file}:${a.line} — @decision ${renderAnchorId(a)}`);
  }
  if (report.brokenAnchors.length) {
    lines.push(`${report.brokenAnchors.length} broken @decision anchor(s) in ${report.file} (the keyword is not followed by a valid 8-hex id on the SAME line — likely a line wrap; the anchor is NOT detected and its record silently becomes an orphan):`);
    for (const b of report.brokenAnchors) lines.push(`  - ${report.file}:${b.line} — @decision with no valid id on this line`);
  }
  return `comment-anchor-lint (CLAUDE.md comment taxonomy, card 90b19799) flagged ${report.file}:\n${lines.join("\n")}\n`
    + `Advisory only: a long unanchored block may want "// @decision <id> — <the prohibition/consequence>" `
    + `(<=3 lines) plus an out-of-band record in docs/adr or docs/decisions; an orphan anchor needs a matching `
    + `record file; a broken anchor needs "@decision <id>" kept together on one line, never wrapped.`;
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
  if (!report || (report.unanchoredLongBlocks.length === 0 && report.orphanAnchors.length === 0 && report.brokenAnchors.length === 0)) return;

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
