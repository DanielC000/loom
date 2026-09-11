import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { strictShape } from "./arg-alias.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/** `decisions_for(query)` — the index over `@decision` anchors + their records, reused via
 *  `TaskMcpRouter`; built by grepping the caller's own repo at call time, never persisted. */

/** @decision dbad4b59 — an escape-hatch index over `@decision` anchors, never the primary
 *  lookup path (the `Read`-hook is): never redesign it into one, and never import from
 *  `assets/decision-records.mjs`, which would couple its `dist/`-independent asset to this. */

// Comment-syntax-agnostic — semantically equal to decision-records.mjs's/comment-anchor-lint.mjs's own
// ANCHOR_RE (card 969b0e1c: a THIRD, independently-typed copy — see those assets' own doc for why the
// grammar is a two-group union, `sha:([0-9a-f]{8})` tried first for the commit-sha id-space, the bare
// `([0-9a-f]{8})` unchanged and still keying a board card). `test/anchor-re-parity.mjs` pins this literal
// text-equal to the two `.mjs` copies AND asserts its extraction pattern actually finds something first
// (a positive control) — update all three together, never just this one.
const ANCHOR_RE = /@decision\s+(?:sha:([0-9a-f]{8})|([0-9a-f]{8}))\b/gi;
type AnchorNs = "card" | "sha";

/** Normalize one `ANCHOR_RE` match into `{ns, id}` — mirrors decision-records.mjs's own `parseAnchorMatch`
 * (same doc there): group 1 set ⇒ `ns:"sha"`; else group 2 (the bare form) ⇒ `ns:"card"`. */
function parseAnchorMatch(m: RegExpMatchArray): { ns: AnchorNs; id: string } {
  return m[1] ? { ns: "sha", id: m[1].toLowerCase() } : { ns: "card", id: (m[2] ?? "").toLowerCase() };
}

/** True iff `sha` resolves to a real, existing commit in `repoRoot`'s git history — mirrors
 * decision-records.mjs's own `verifyCommitSha` (same doc/rationale there). Bounded by a short `timeout`
 * (card 969b0e1c review S2 — this repo's standing posture is every git call is timeout-bounded; this one
 * is a per-request MCP-tool subprocess, so a hang can't wedge the daemon, but there's no reason to leave
 * it unbounded either) — a timeout throws, and this function's own `catch` already reads that as
 * UNVERIFIED, the documented refuse-rather-than-fall-through behavior, not a special case to add. */
function verifyCommitSha(repoRoot: string, sha: string): boolean {
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

const FLAT_STORES = ["adr", "decisions"] as const;

// --- hard bounds (mirrors repo-read.ts's own posture: a huge/hostile repo can't wedge this call) ---
// MAX_FILE_BYTES (card 2b2d9a47): was 512KB, which silently skipped this repo's own largest source files
// (service.ts, pty/host.ts, db.ts — up to ~1.6MB) and then reported `orphan:true` for any id anchored only
// inside one of them, an active false assertion rather than a disclosed gap. MEASURED before raising it:
// reading + regex-scanning all three (3.1MB combined) takes ~38ms total; even this repo's single largest
// walked file today (a 3.3MB investigation data blob) scans in ~14ms — negligible next to the full-repo
// walk's own ~1.5s baseline for ~2,400 files. Raised to comfortably exceed the current largest anchor-
// bearing file with real headroom, while still bounding a genuinely pathological one. `skippedFiles` below
// (buildAnchorIndex/findAnchorsInFile) is the belt-and-suspenders half: a cap always leaves SOME size that
// can be skipped, so any id/enumerate-all result now discloses which files (if any) it could not scan,
// rather than asserting `orphan` from an incomplete scan with no way for a caller to tell.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_WALK_FILES = 20_000;
const MAX_SYMBOL_HITS = 20; // cap on how many files a bare symbol lookup can resolve to
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".turbo", ".next", "coverage", ".cache", ".loom", "worktrees",
]);

type RecordMeta = { id: string; rel: string; title: string };
type AnchorSite = { file: string; line: number };

function containsNul(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0) return true;
  return false;
}

/** True iff `nameLower` is `id` followed by a real boundary — never a bare-prefix match (`deadbeef`
 * must not match `deadbeefcafe-other.md`). Mirrors decision-records.mjs's `idBoundaryMatch`. */
function idBoundaryMatch(nameLower: string, id: string): boolean {
  if (!nameLower.startsWith(id)) return false;
  const rest = nameLower.slice(id.length);
  return rest === "" || rest.startsWith("-") || rest.startsWith(".");
}

function relPosix(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join("/");
}

/** First-line `# <id> — <title>` heading — the one convention all three record stores share (see
 * `docs/adr/template.md`). Falls back to the record's own filename when a record doesn't follow it,
 * rather than failing the whole lookup — a malformed heading shouldn't hide a real record. */
function extractTitle(text: string, fallback: string): string {
  const first = (text.split(/\r?\n/, 1)[0] ?? "").trim();
  const m = /^#\s*[0-9a-f]{8}\s*[—-]\s*(.+)$/i.exec(first);
  return m && m[1] ? m[1].trim() : fallback;
}

/** Resolve one anchored `{ns, id}` to its record's {path, title}, across all three stores — null if none.
 * Card 969b0e1c: for `ns:"sha"`, `id` is FIRST verified against this repo's real git history
 * (`verifyCommitSha`) — an unverifiable sha REFUSES outright, before ever attempting the file lookup
 * below, mirroring decision-records.mjs's own `resolveRecord` gate exactly (same file lookup either way —
 * only the admission gate differs). `ns:"card"` skips verification entirely, unchanged from before. */
function resolveRecordMeta(repoRoot: string, ns: AnchorNs, id: string): RecordMeta | null {
  if (ns === "sha" && !verifyCommitSha(repoRoot, id)) return null;
  for (const store of FLAT_STORES) {
    const dir = path.join(repoRoot, "docs", store);
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    const hit = entries
      .filter((n) => n.toLowerCase().endsWith(".md") && idBoundaryMatch(n.toLowerCase(), id))
      .sort()[0];
    if (hit) {
      const full = path.join(dir, hit);
      try {
        const text = fs.readFileSync(full, "utf8");
        return { id, rel: relPosix(repoRoot, full), title: extractTitle(text, hit) };
      } catch { /* fall through to next store */ }
    }
  }
  const invDir = path.join(repoRoot, "docs", "investigations");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(invDir, { withFileTypes: true }); } catch { entries = []; }
  const hitDir = entries
    .filter((e) => e.isDirectory() && idBoundaryMatch(e.name.toLowerCase(), id))
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  if (hitDir) {
    const full = path.join(invDir, hitDir.name, "findings.md");
    try {
      const text = fs.readFileSync(full, "utf8");
      return { id, rel: relPosix(repoRoot, full), title: extractTitle(text, hitDir.name) };
    } catch { /* no findings.md at that dir — no record */ }
  }
  return null;
}

/** Every `<id>*.md` / `<id>-<slug>/findings.md` record this convention can resolve, across all three stores —
 * mirrors `comment-anchor-lint.mjs`'s own `listRecordIds` (used here for the reverse "which records have
 * no inbound anchor" check, DoD-4's second half). */
function listAllRecords(repoRoot: string): RecordMeta[] {
  const records: RecordMeta[] = [];
  for (const store of FLAT_STORES) {
    const dir = path.join(repoRoot, "docs", store);
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const lower = name.toLowerCase();
      if (!lower.endsWith(".md") || lower === "template.md") continue;
      const m = /^([0-9a-f]{8})[-.]/.exec(lower);
      if (!m || !idBoundaryMatch(lower, m[1]!)) continue;
      const full = path.join(dir, name);
      let title = name;
      try { title = extractTitle(fs.readFileSync(full, "utf8"), name); } catch { /* keep filename fallback */ }
      records.push({ id: m[1]!, rel: relPosix(repoRoot, full), title });
    }
  }
  const invDir = path.join(repoRoot, "docs", "investigations");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(invDir, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const lower = e.name.toLowerCase();
    const m = /^([0-9a-f]{8})-/.exec(lower);
    if (!m) continue;
    const full = path.join(invDir, e.name, "findings.md");
    if (!fs.existsSync(full)) continue;
    let title = e.name;
    try { title = extractTitle(fs.readFileSync(full, "utf8"), e.name); } catch { /* keep fallback */ }
    records.push({ id: m[1]!, rel: relPosix(repoRoot, full), title });
  }
  return records;
}

/** Walk every regular file under `root`, skipping SKIP_DIRS + symlinks, bounded by MAX_WALK_FILES — a
 * generic, repo-layout-agnostic sweep (unlike comment-anchor-lint.mjs's Loom-specific SOURCE_ROOTS). */
function* walkFiles(root: string): Generator<string> {
  let count = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        if (++count > MAX_WALK_FILES) return;
        yield full;
      }
    }
  }
}

type AnchorScan = { anchors: Array<{ ns: AnchorNs; id: string; line: number }>; skippedForSize: boolean };

/** Every `@decision <id>` (or `@decision sha:<id>`) site in one file. `skippedForSize:true` (card
 * 2b2d9a47 DoD-1) marks a file that exceeded MAX_FILE_BYTES and was NOT scanned — kept distinct from an
 * unreadable/binary file (`anchors:[]`, `skippedForSize:false`) so every caller can tell "genuinely no
 * anchors here" from "did not look here at all" instead of collapsing both into an empty result. */
function findAnchorsInFile(absPath: string): AnchorScan {
  let stat: fs.Stats;
  try { stat = fs.statSync(absPath); } catch { return { anchors: [], skippedForSize: false }; }
  if (!stat.isFile()) return { anchors: [], skippedForSize: false };
  if (stat.size > MAX_FILE_BYTES) return { anchors: [], skippedForSize: true };
  let content: string;
  try { content = fs.readFileSync(absPath, "utf8"); } catch { return { anchors: [], skippedForSize: false }; }
  if (containsNul(content)) return { anchors: [], skippedForSize: false };
  const found: Array<{ ns: AnchorNs; id: string; line: number }> = [];
  content.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(ANCHOR_RE)) found.push({ ...parseAnchorMatch(m), line: i + 1 });
  });
  return { anchors: found, skippedForSize: false };
}

type AnchorIndexResult = { index: Map<string, AnchorSite[]>; skippedFiles: string[] };

/** Full-repo `"ns:id" -> anchor sites` index, built fresh every call (DoD-2 — never persisted). Card
 * 969b0e1c: keyed by the COMBINED `"ns:id"` string, never bare `id` — a sha-sigil'd anchor and a card
 * anchor sharing the same 8 hex characters (negligible odds, accepted by the deciding card) must never be
 * conflated into one entry, mirroring decision-records.mjs's own `main()` and comment-anchor-lint.mjs's
 * own `orphanAnchors` key scheme exactly. Card 2b2d9a47: also returns `skippedFiles` — every file this
 * walk could NOT scan (MAX_FILE_BYTES) — sorted for a deterministic result, since walkFiles' own DFS
 * order isn't. Every caller of this index (id reverse-lookup, no-query enumerate-all) surfaces this list
 * so an `orphan` verdict it computes is interpretable rather than a silent false assertion. */
function buildAnchorIndex(repoRoot: string): AnchorIndexResult {
  const idx = new Map<string, AnchorSite[]>();
  const skippedFiles: string[] = [];
  for (const full of walkFiles(repoRoot)) {
    const { anchors, skippedForSize } = findAnchorsInFile(full);
    const rel = relPosix(repoRoot, full);
    if (skippedForSize) { skippedFiles.push(rel); continue; }
    if (anchors.length === 0) continue;
    for (const a of anchors) {
      const key = `${a.ns}:${a.id}`;
      const list = idx.get(key) ?? [];
      list.push({ file: rel, line: a.line });
      idx.set(key, list);
    }
  }
  skippedFiles.sort();
  return { index: idx, skippedFiles };
}

/** Confine a caller-supplied relative path to `root` — refuses an absolute path, a `..` escape, or a
 * symlink that resolves outside (mirrors repo-read.ts's `resolveWithin`, kept local since that helper
 * isn't exported and this module has no other dependency on repo-read.ts). Null on any escape. */
function resolveWithinRepo(root: string, rel: string): string | null {
  if (typeof rel !== "string" || rel.trim().length === 0 || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const within = (p: string) => p === root || p.startsWith(root + path.sep);
  if (!within(abs)) return null;
  try {
    const real = fs.realpathSync(abs);
    if (!within(real)) return null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") return null;
  }
  return abs;
}

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** True iff `query` reads as a repo-relative path — a slash, a backslash, or a trailing extension. */
function looksLikePath(query: string): boolean {
  return query.includes("/") || query.includes("\\") || /\.[A-Za-z0-9]{1,10}$/.test(query);
}

/** True iff `query` is a bare 8-hex-char decision id, OR a `sha:<8hex>`-sigil'd commit id (card 969b0e1c
 * — the SAME two-namespace grammar the source anchors themselves use), triggering the reverse-lookup /
 * "what does this record govern" mode — never a bare-prefix match against a longer hex-looking string. */
function looksLikeId(query: string): boolean {
  return /^(?:sha:)?[0-9a-f]{8}$/i.test(query);
}

/** Parse a query already confirmed by `looksLikeId` into `{ns, id}` — mirrors `parseAnchorMatch`'s
 * namespace split, applied to a raw query string instead of an `ANCHOR_RE` match. A bare hex query means
 * `ns:"card"` (the pre-969b0e1c meaning of a bare id query, unchanged); `sha:<hex>` means `ns:"sha"`. */
function parseIdQuery(query: string): { ns: AnchorNs; id: string } {
  const m = /^sha:([0-9a-f]{8})$/i.exec(query);
  return m ? { ns: "sha", id: m[1]!.toLowerCase() } : { ns: "card", id: query.toLowerCase() };
}

/**
 * Best-effort, language-agnostic "which file defines this symbol" heuristic — a `const`/`let`/`var`/
 * `function`/`class`/`interface`/`type`/`enum` declaration naming `symbol`, optionally `export`ed. This
 * is DELIBERATELY trivial (matches the card's "no database" design constraint) — it is NOT a real
 * symbol table: an overloaded/re-exported/method-only name can resolve to zero or several files, both
 * reported rather than guessed at.
 */
function findSymbolDefinitionFiles(repoRoot: string, symbol: string): string[] {
  const esc = escapeRegExp(symbol);
  const defRe = new RegExp(
    `\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum)\\s+${esc}\\b` +
    `|\\b(?:export\\s+)?(?:const|let|var)\\s+${esc}\\b\\s*[:=]`,
  );
  const hits: string[] = [];
  for (const full of walkFiles(repoRoot)) {
    if (hits.length >= MAX_SYMBOL_HITS) break;
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) continue;
    let content: string;
    try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
    if (containsNul(content)) continue;
    if (defRe.test(content)) hits.push(relPosix(repoRoot, full));
  }
  return hits;
}

type DecisionItem = { ns: AnchorNs; id: string; line: number; record: { path: string; title: string } | null; orphan: boolean };

/** Core of the `path` mode — every anchor in ONE file, each resolved (or flagged orphan: DoD-4).
 * `skippedForSize:true` (card 2b2d9a47) means this file exceeded MAX_FILE_BYTES and was NOT scanned —
 * `anchorCount:0`/`decisions:[]` in that case means "did not look", not "genuinely has none", and this
 * flag is what lets a caller tell the two apart instead of trusting a false-empty result. */
function decisionsForFile(repoRoot: string, abs: string): { path: string; anchorCount: number; orphanAnchorCount: number; decisions: DecisionItem[]; skippedForSize: boolean } {
  const { anchors, skippedForSize } = findAnchorsInFile(abs);
  const decisions: DecisionItem[] = anchors.map((a) => {
    const rec = resolveRecordMeta(repoRoot, a.ns, a.id);
    return { ns: a.ns, id: a.id, line: a.line, record: rec ? { path: rec.rel, title: rec.title } : null, orphan: !rec };
  });
  return {
    path: relPosix(repoRoot, abs),
    anchorCount: decisions.length,
    orphanAnchorCount: decisions.filter((d) => d.orphan).length,
    decisions,
    skippedForSize,
  };
}

function decisionsForPath(repoRoot: string, rel: string): { mode: "path"; error: string } | ({ mode: "path" } & ReturnType<typeof decisionsForFile>) {
  const abs = resolveWithinRepo(repoRoot, rel);
  if (!abs) return { mode: "path", error: "path escapes the repo root or is not a relative path" };
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); } catch { return { mode: "path", error: "file not found" }; }
  if (!stat.isFile()) return { mode: "path", error: "not a file" };
  return { mode: "path", ...decisionsForFile(repoRoot, abs) };
}

/** Reverse lookup: "what does this record govern" — every anchor site citing `{ns, id}`, plus the record
 * itself if one resolves. `orphan:true` covers BOTH orphan-signal halves at the single-id granularity
 * (DoD-4): no inbound anchor (record exists, nothing cites it) OR no record (anchors cite an id that
 * resolves to nothing) both leave the OTHER side empty, so a caller checking `orphan` catches either.
 * Card 969b0e1c: `query` is already namespace-parsed by `looksLikeId`/`parseIdQuery` — a bare hex query
 * means `ns:"card"` (the pre-existing meaning, unchanged); `sha:<hex>` means `ns:"sha"`, applying the SAME
 * verification gate as a source anchor would (a query for an unverifiable sha reports `record:null`, not
 * a stale/fake resolution — consistent with `resolveRecordMeta`'s own refuse-rather-than-fall-through).
 * Card 2b2d9a47: `skippedFiles` names every file this call's own index build could NOT scan
 * (MAX_FILE_BYTES) — a non-empty list means `orphan:true` here is NOT a proven absence, only "not found in
 * what was scanned"; a caller relying on `orphan` should treat it as unverified until it independently
 * confirms (e.g. `git grep`) that none of `skippedFiles` cite this id. */
function decisionsForId(repoRoot: string, ns: AnchorNs, id: string) {
  const record = resolveRecordMeta(repoRoot, ns, id);
  const { index, skippedFiles } = buildAnchorIndex(repoRoot);
  const anchoredIn = index.get(`${ns}:${id}`) ?? [];
  return {
    mode: "record" as const,
    ns,
    id,
    record: record ? { path: record.rel, title: record.title } : null,
    anchoredIn,
    orphan: !record || anchoredIn.length === 0,
    skippedFiles,
  };
}

/** Symbol mode: resolve to file(s) via the trivial heuristic, then run the `path` mode on each. */
function decisionsForSymbol(repoRoot: string, symbol: string) {
  const resolvedFiles = findSymbolDefinitionFiles(repoRoot, symbol);
  if (resolvedFiles.length === 0) {
    return { mode: "symbol" as const, symbol, resolvedFiles: [], error: "no definition found for this symbol (trivial heuristic — declarations only, not references/methods)" };
  }
  return {
    mode: "symbol" as const,
    symbol,
    resolvedFiles,
    ambiguous: resolvedFiles.length > 1,
    results: resolvedFiles.map((rel) => decisionsForFile(repoRoot, path.join(repoRoot, rel))),
  };
}

/** No-query mode: the full index, plus BOTH orphan directions (DoD-4) — "enumerating records before a
 * refactor". Card 969b0e1c: `idx` is keyed by `"ns:id"`; an entry counts as anchored-and-resolved only
 * when its record exists AND — for `ns:"sha"` — its id still verifies as a real commit (mirrors
 * comment-anchor-lint.mjs's own `anchorResolves`: the record-existence check runs first here too, cheap
 * and side-effect-free, before any `git` call — a pure optimization, the final boolean is the same either
 * order). A sha id that fails verification is reported as an orphan ANCHOR even when a same-named record
 * file exists (refuse-rather-than-fall-through), and — since it therefore never marks that record id as
 * "anchored" — the SAME record also correctly surfaces as an orphan RECORD if nothing else cites it.
 * Card 2b2d9a47: `skippedFiles` names every file the underlying index build could NOT scan
 * (MAX_FILE_BYTES) — any record whose ONLY anchor lives in one of these can be wrongly reported as an
 * orphan RECORD here (the anchor was never indexed), so both `orphanAnchors`/`orphanRecords` are only as
 * complete as `skippedFiles` is empty. */
function decisionsForAll(repoRoot: string) {
  const { index: idx, skippedFiles } = buildAnchorIndex(repoRoot);
  const records = listAllRecords(repoRoot);
  const recordIds = new Set(records.map((r) => r.id));
  const shaVerifyCache = new Map<string, boolean>();
  const anchoredRecordIds = new Set<string>();
  const orphanAnchors: Array<{ ns: AnchorNs; id: string; sites: AnchorSite[] }> = [];
  for (const [key, sites] of idx) {
    const sep = key.indexOf(":");
    const ns = key.slice(0, sep) as AnchorNs;
    const id = key.slice(sep + 1);
    let resolves = recordIds.has(id);
    if (resolves && ns === "sha") {
      if (!shaVerifyCache.has(id)) shaVerifyCache.set(id, verifyCommitSha(repoRoot, id));
      resolves = shaVerifyCache.get(id)!;
    }
    if (resolves) anchoredRecordIds.add(id);
    else orphanAnchors.push({ ns, id, sites });
  }
  const orphanRecords = records.filter((r) => !anchoredRecordIds.has(r.id)).map((r) => ({ id: r.id, path: r.rel, title: r.title }));
  return {
    mode: "index" as const,
    uniqueAnchorIds: idx.size,
    totalAnchorSites: [...idx.values()].reduce((n, l) => n + l.length, 0),
    recordCount: records.length,
    orphanAnchors: { count: orphanAnchors.length, items: orphanAnchors },
    orphanRecords: { count: orphanRecords.length, advisory: true, items: orphanRecords },
    skippedFiles,
  };
}

/** Dispatch on the shape of `query`: an 8-hex id (bare -> card, `sha:`-sigil'd -> commit, card 969b0e1c)
 * -> reverse lookup; a path-shaped string -> file lookup; anything else -> best-effort symbol resolution;
 * omitted/blank -> full-repo enumeration. */
export function decisionsFor(repoRoot: string, query?: string) {
  const q = (query ?? "").trim();
  if (!q) return decisionsForAll(repoRoot);
  if (looksLikeId(q)) { const { ns, id } = parseIdQuery(q); return decisionsForId(repoRoot, ns, id); }
  if (looksLikePath(q)) return decisionsForPath(repoRoot, q);
  return decisionsForSymbol(repoRoot, q);
}

/** The realpath'd root (so a symlinked checkout still confines correctly); falls back to a plain resolve. */
function realRoot(root: string): string {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

/**
 * Register `decisions_for` on `server`. `resolveRepoRoot` is called PER REQUEST (never cached at
 * registration) so a project's `repoPath` edit is picked up immediately — mirrors `loomRepoRoot()`'s own
 * per-call re-read in repo-read.ts.
 */
export function registerDecisionTools(server: McpServer, resolveRepoRoot: () => string | null | undefined): void {
  server.registerTool(
    "decisions_for",
    {
      description:
        "The index over this project's `@decision <id>` (card) and `@decision sha:<id>` (verified commit, " +
        "card 969b0e1c) source anchors and their out-of-band decision records (docs/adr/, docs/decisions/, " +
        "docs/investigations/<id>-*/findings.md) — an ESCAPE HATCH for questions the on-Read injection hook " +
        "can't answer positionally, not the primary way to read a record (a plain Read of an anchored file " +
        "already surfaces the full record inline). `query` is optional and its shape picks the mode: " +
        "an 8-hex-char id (e.g. \"a32533a1\") -> REVERSE lookup on a board-card anchor; \"sha:<8hex>\" " +
        "(e.g. \"sha:c70a5e0e\") -> the SAME reverse lookup on a verified-commit anchor instead (an " +
        "unverifiable sha reports record:null, exactly like a bare id with no card record — it is never " +
        "silently treated as resolved) — either form returns {ns, id, record, anchoredIn: [{file,line}...], " +
        "orphan, skippedFiles} (orphan:true if nothing cites this id, OR if the id has no resolvable record " +
        "but IS cited somewhere — check both `record` and `anchoredIn` to tell which; skippedFiles names " +
        "every file this call could NOT scan for size — card 2b2d9a47 — a non-empty list means `orphan` is " +
        "NOT a proven absence, only \"not found in what was scanned\": double-check with `git grep` before " +
        "trusting orphan:true when skippedFiles is non-empty); " +
        "a path-shaped string (contains \"/\" or \"\\\\\", or ends in a file extension) -> every anchor found " +
        "in that ONE file, each item carrying {ns, id, line, record, orphan}, plus a file-level " +
        "`skippedForSize` (true means the file exceeded the byte cap and was NOT scanned at all — " +
        "anchorCount:0/decisions:[] in that case means \"did not look\", not \"has none\") — otherwise " +
        "resolved, or flagged `orphan:true` when the anchored id has no record (for a sha anchor this " +
        "includes an id whose commit no longer verifies, even if a same-named record file exists); " +
        "anything else -> a best-effort, language-agnostic SYMBOL lookup (a trivial declaration-name " +
        "match, not a real symbol table — resolves 0, 1, or several files, all reported) whose result(s) " +
        "each run through the path mode above; " +
        "omitted/blank -> the FULL repo index, enumerating {orphanAnchors, orphanRecords, skippedFiles} " +
        "(an anchored id with no record, and a record nothing anchors) so neither kind of gap is silently " +
        "skipped — orphanAnchors items carry `ns` too, and a non-empty skippedFiles means both orphan " +
        "directions are only as complete as that list is empty. The index is rebuilt fresh on every " +
        "call by walking this project's own repo (`repoPath`) — never a persisted or cached snapshot, so " +
        "it can never go stale. Record bodies are NOT inlined here (only {path,title}) — Read the returned " +
        "record path directly for the full text; the on-Read hook is the place that delivers complete " +
        "record text automatically.",
      inputSchema: strictShape({ query: z.string().optional() }),
    },
    async ({ query }) => {
      const repoRoot = resolveRepoRoot();
      if (!repoRoot) return ok({ error: "this project has no repoPath to read source/docs from" });
      try { return ok(decisionsFor(realRoot(repoRoot), query)); }
      catch (e) { return ok({ error: (e as Error).message }); }
    },
  );
}
