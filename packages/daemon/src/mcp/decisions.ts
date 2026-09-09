import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { strictShape } from "./arg-alias.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * `decisions_for(query)` — the underlying index over `@decision <id>` anchors + their out-of-band records
 * (card dbad4b59), reused across every project session via `TaskMcpRouter` (mcp/server.ts). Backed by a
 * TRIVIAL index built by grepping the CALLER'S OWN project repo at call time — never a persisted snapshot
 * (DoD-2). Design note (CLAUDE.md's comment-taxonomy convention, card 90b19799): the `Read`-hook
 * (`assets/decision-records.mjs`) is the PRIMARY delivery path (costs the agent zero extra lookups); this
 * tool is an explicit ESCAPE HATCH for what the hook can't answer positionally — "what decisions touch
 * this file/flow", "what does this record govern" (reverse lookup), and enumerating records before a
 * refactor. Never redesign this into the primary path (see the card body's own warning about that).
 *
 * ⚠️ NOT Loom-source-specific, unlike `comment-anchor-lint.mjs` (a Loom-internal lint tool with a
 * hardcoded SOURCE_ROOTS over Loom's OWN package layout). This tool runs against ANY project's repo via
 * `TaskMcpRouter`'s server-derived `repoPath` — so the file walk below is repo-root-relative and
 * layout-agnostic (mirrors `repo-read.ts`'s own generic `walkFiles`), never assuming a fixed
 * `packages/<pkg>/src` layout.
 *
 * Mirrors `assets/decision-records.mjs`'s resolution across all THREE stores it resolves at runtime
 * (`docs/adr/`, `docs/decisions/`, `docs/investigations/<id>-<slug>/findings.md`) — kept as separate,
 * independently-maintained logic here (not imported), the SAME asset-vs-compiled duplication already
 * accepted between `decision-records.mjs` and `comment-anchor-lint.mjs` (assets ship standalone, invoked
 * by a bare `node <path>`; this ships compiled into the daemon). Do NOT import from
 * `assets/decision-records.mjs` — that asset's independence from `dist/` is load-bearing (see its own
 * scope-fence note) and importing it here would couple the two.
 */

// Comment-syntax-agnostic — byte-identical intent to decision-records.mjs's own ANCHOR_RE.
const ANCHOR_RE = /@decision\s+([0-9a-f]{8})\b/gi;
const FLAT_STORES = ["adr", "decisions"] as const;

// --- hard bounds (mirrors repo-read.ts's own posture: a huge/hostile repo can't wedge this call) ---
const MAX_FILE_BYTES = 512 * 1024;
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

/** Resolve one anchored `id` to its record's {path, title}, across all three stores — null if none. */
function resolveRecordMeta(repoRoot: string, id: string): RecordMeta | null {
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

/** Every `@decision <id>` site in one file, or `[]` on an unreadable/oversized/binary file. */
function findAnchorsInFile(absPath: string): Array<{ id: string; line: number }> {
  let stat: fs.Stats;
  try { stat = fs.statSync(absPath); } catch { return []; }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
  let content: string;
  try { content = fs.readFileSync(absPath, "utf8"); } catch { return []; }
  if (containsNul(content)) return [];
  const found: Array<{ id: string; line: number }> = [];
  content.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(ANCHOR_RE)) found.push({ id: m[1]!.toLowerCase(), line: i + 1 });
  });
  return found;
}

/** Full-repo `id -> anchor sites` index, built fresh every call (DoD-2 — never persisted). */
function buildAnchorIndex(repoRoot: string): Map<string, AnchorSite[]> {
  const idx = new Map<string, AnchorSite[]>();
  for (const full of walkFiles(repoRoot)) {
    const anchors = findAnchorsInFile(full);
    if (anchors.length === 0) continue;
    const rel = relPosix(repoRoot, full);
    for (const a of anchors) {
      const list = idx.get(a.id) ?? [];
      list.push({ file: rel, line: a.line });
      idx.set(a.id, list);
    }
  }
  return idx;
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

/** True iff `query` is a bare 8-hex-char decision id (the reverse-lookup / "what does this record
 * govern" mode) — never a bare-prefix match against a longer hex-looking string. */
function looksLikeId(query: string): boolean {
  return /^[0-9a-f]{8}$/i.test(query);
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

type DecisionItem = { id: string; line: number; record: { path: string; title: string } | null; orphan: boolean };

/** Core of the `path` mode — every anchor in ONE file, each resolved (or flagged orphan: DoD-4). */
function decisionsForFile(repoRoot: string, abs: string): { path: string; anchorCount: number; orphanAnchorCount: number; decisions: DecisionItem[] } {
  const anchors = findAnchorsInFile(abs);
  const decisions: DecisionItem[] = anchors.map((a) => {
    const rec = resolveRecordMeta(repoRoot, a.id);
    return { id: a.id, line: a.line, record: rec ? { path: rec.rel, title: rec.title } : null, orphan: !rec };
  });
  return {
    path: relPosix(repoRoot, abs),
    anchorCount: decisions.length,
    orphanAnchorCount: decisions.filter((d) => d.orphan).length,
    decisions,
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

/** Reverse lookup: "what does this record govern" — every anchor site citing `id`, plus the record
 * itself if one resolves. `orphan:true` covers BOTH orphan-signal halves at the single-id granularity
 * (DoD-4): no inbound anchor (record exists, nothing cites it) OR no record (anchors cite an id that
 * resolves to nothing) both leave the OTHER side empty, so a caller checking `orphan` catches either. */
function decisionsForId(repoRoot: string, id: string) {
  const lower = id.toLowerCase();
  const record = resolveRecordMeta(repoRoot, lower);
  const anchoredIn = buildAnchorIndex(repoRoot).get(lower) ?? [];
  return {
    mode: "record" as const,
    id: lower,
    record: record ? { path: record.rel, title: record.title } : null,
    anchoredIn,
    orphan: !record || anchoredIn.length === 0,
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
 * refactor". */
function decisionsForAll(repoRoot: string) {
  const idx = buildAnchorIndex(repoRoot);
  const records = listAllRecords(repoRoot);
  const recordIds = new Set(records.map((r) => r.id));
  const orphanAnchors = [...idx.entries()]
    .filter(([id]) => !recordIds.has(id))
    .map(([id, sites]) => ({ id, sites }));
  const orphanRecords = records.filter((r) => !idx.has(r.id)).map((r) => ({ id: r.id, path: r.rel, title: r.title }));
  return {
    mode: "index" as const,
    uniqueAnchorIds: idx.size,
    totalAnchorSites: [...idx.values()].reduce((n, l) => n + l.length, 0),
    recordCount: records.length,
    orphanAnchors: { count: orphanAnchors.length, items: orphanAnchors },
    orphanRecords: { count: orphanRecords.length, advisory: true, items: orphanRecords },
  };
}

/** Dispatch on the shape of `query`: an 8-hex id -> reverse lookup; a path-shaped string -> file lookup;
 * anything else -> best-effort symbol resolution; omitted/blank -> full-repo enumeration. */
export function decisionsFor(repoRoot: string, query?: string) {
  const q = (query ?? "").trim();
  if (!q) return decisionsForAll(repoRoot);
  if (looksLikeId(q)) return decisionsForId(repoRoot, q);
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
        "The index over this project's `@decision <id>` source anchors and their out-of-band decision " +
        "records (docs/adr/, docs/decisions/, docs/investigations/<id>-*/findings.md) — an ESCAPE HATCH " +
        "for questions the on-Read injection hook can't answer positionally, not the primary way to read a " +
        "record (a plain Read of an anchored file already surfaces the full record inline). `query` is " +
        "optional and its shape picks the mode: " +
        "an 8-hex-char id (e.g. \"a32533a1\") -> REVERSE lookup, \"what does this record govern\" — " +
        "returns {record, anchoredIn: [{file,line}...], orphan} (orphan:true if nothing cites this id, OR " +
        "if the id has no resolvable record but IS cited somewhere — check both `record` and `anchoredIn` " +
        "to tell which); " +
        "a path-shaped string (contains \"/\" or \"\\\\\", or ends in a file extension) -> every anchor found " +
        "in that ONE file, resolved (or flagged `orphan:true` when the anchored id has no record); " +
        "anything else -> a best-effort, language-agnostic SYMBOL lookup (a trivial declaration-name " +
        "match, not a real symbol table — resolves 0, 1, or several files, all reported) whose result(s) " +
        "each run through the path mode above; " +
        "omitted/blank -> the FULL repo index, enumerating {orphanAnchors, orphanRecords} in BOTH " +
        "directions (an anchored id with no record, and a record nothing anchors) so neither kind of gap " +
        "is silently skipped. The index is rebuilt fresh on every call by walking this project's own " +
        "repo (`repoPath`) — never a persisted or cached snapshot, so it can never go stale. Record " +
        "bodies are NOT inlined here (only {path,title}) — Read the returned record path directly for " +
        "the full text; the on-Read hook is the place that delivers complete record text automatically.",
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
