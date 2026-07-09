import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loomRepoRoot } from "../paths.js";

// Same envelope as the task / orchestration / platform / audit MCP servers.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * Least-privilege, READ-ONLY source-tree reads — `repo_read_file` / `repo_grep` / `repo_glob` — confined to
 * ONE root directory and hard-bounded, with NO host-process spawn. Two registration entry points share this
 * module's confinement/bound core:
 *   - `registerRepoReadTools` — the DEV Platform Auditor's fixed-root surface over the Loom SOURCE tree
 *     (`paths.ts > loomRepoRoot`), so the Auditor — otherwise transcript-only and STRUCTURALLY BLIND to
 *     silent code gaps — can run a code-structure gap-hunt (see the 7 lenses in the platform-audit skill).
 *   - `registerScopedRepoReadTools` — the END-USER Workspace Auditor's PER-CALL, `projectId`-scoped surface
 *     over the CALLER'S OWN project repo (root resolved by the caller-supplied `resolveRoot`, e.g. from
 *     `db.getProject(projectId).repoPath`), for the same structural gap-hunt over the user's own source.
 *
 * == STAYS INSIDE THE TRUST BOUNDARY ==================================================================
 * These are PURE READS, hard-confined to their resolved root and hard-bounded, with NO host-process spawn:
 *   - Every path is CONFINED to the resolved root — a relative path that escapes it (via `..`, an absolute
 *     path, or a symlink pointing outside) is REFUSED, so a caller can never read an arbitrary host file
 *     (e.g. `~/.ssh/id_rsa`, the prod DB, another project's source).
 *   - grep/glob are pure in-process `fs` reads + a translated RegExp — NEVER `git grep` / `rg` / any child
 *     process. There is no shell, no exec, nothing outward.
 *   - Hard bounds cap every read (file bytes, returned lines, match count, files walked) so a huge or
 *     hostile tree can't blow the tool-result budget or wedge the daemon.
 * NO WRITE lives here — this module only ADDS reads. `registerRepoReadTools` is registered ONLY on the dev
 * AuditMcpRouter; `registerScopedRepoReadTools` is registered ONLY on the end-user WorkspaceAuditMcpRouter,
 * confined to the CALLING project's own repo root — never another project's root — the dev<->user split.
 * ====================================================================================================
 */

// --- hard bounds (a hostile / huge repo can't overflow the tool-result budget or wedge the daemon) ---
const MAX_FILE_BYTES = 512 * 1024; // a single file read/grep never loads more than 512 KiB
const MAX_READ_LINES = 2000; // repo_read_file returns at most this many lines per call (pages via offset)
const MAX_GLOB_RESULTS = 500; // repo_glob caps its match list
const MAX_GREP_MATCHES = 200; // repo_grep caps its match list
const MAX_WALK_FILES = 20_000; // never traverse an unbounded tree
const MAX_LINE_LEN = 500; // truncate a single very long matched/returned line
// ReDoS defense for repo_grep (`pattern` is caller-controlled — an injection-exposed value, see the
// trust-boundary banner above). A length clamp on the match input alone does NOT defuse a catastrophic
// (exponential) backtracking pattern like /(a+)+$/: empirically, even a ~25-30 char adversarial input
// already takes multiple SECONDS and scales exponentially from there, so even a 500-char (MAX_LINE_LEN)
// clamp never returns unguarded — and normal source lines (~30-120 chars) sit exactly in that danger zone,
// so there is no length threshold that's both safe and useful. The real boundary is a hard wall-clock
// ceiling via V8 isolate termination (`vm.runInContext(..., {timeout})`, confirmed by direct testing to
// interrupt mid-backtrack — unlike a plain synchronous `.test()`, which cannot be preempted once started).
// That vm crossing is paid ONCE PER FILE, not once per line (a per-line crossing measured ~0.3ms/call —
// an always-paid tax that would make a broad grep itself slow): `GREP_FILE_TIMEOUT_MS` bounds ONE
// vm.runInContext call that runs the WHOLE per-file match loop (every clamped line probe against `rx`);
// `GREP_TOTAL_BUDGET_MS` is a plain Date.now() check BETWEEN files (a cheap yield point, no vm involved)
// bounding the WHOLE grep so a repo full of pathological files can't chain per-file timeouts into an
// effectively unbounded call.
const GREP_FILE_TIMEOUT_MS = 250; // generous for a legit native grep over a 512 KiB file (<~50ms observed)
const GREP_TOTAL_BUDGET_MS = 4000;

/** Directories never worth auditing — build output, deps, VCS internals, Loom's own runtime state. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".turbo", ".next", "coverage", ".cache", ".loom", "worktrees",
]);

/** A NUL byte means "not a text file" — detected via char code so the source stays pure ASCII. */
function containsNul(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0) return true;
  return false;
}

/** Truncate a single very long line so one pathological line can't blow the result budget. */
function clampLine(s: string): string {
  return s.length > MAX_LINE_LEN ? s.slice(0, MAX_LINE_LEN) + " ...[truncated]" : s;
}

// The match-loop script that runs INSIDE the vm sandbox — fixed daemon code, never the caller's pattern
// (the pattern is DATA, already compiled to a RegExp with `new RegExp` in the MAIN context below; the
// sandbox only ever runs THIS string). Tests every clamped probe in `__probes` against `__rx`, returning
// the indices that matched, capped at `__cap`. `vm.createContext()` with no sandbox object starts EMPTY —
// no `fs`, no `require`, nothing exposed but the three bindings `timedFileGrep` assigns below.
const GREP_MATCH_LOOP_SRC =
  "(function(){var out=[];for(var i=0;i<__probes.length;i++){" +
  "if(__rx.test(__probes[i])){out.push(i);if(out.length>=__cap)break;}}return out;})()";

/**
 * Run one FILE's worth of clamped match probes through `rx.test` INSIDE a single `vm.runInContext` call
 * bounded by `GREP_FILE_TIMEOUT_MS` — ONE vm crossing per FILE (not per line), so the common case pays
 * ~0.3ms per FILE rather than per line. `context` is created ONCE per `doGrep` call and reused across every
 * file (fresh per call would itself be needless overhead) — reuse is safe: each call only ever reads back
 * an array, never carrying state between calls. A pathological line inside THIS file trips the per-file
 * timeout — V8 terminates the whole `runInContext` call, caught below — and the file is treated as fully
 * unmatched (partial results for that one file, never a hang): the same accepted trade-off `clampLine`/the
 * per-line length clamp already make, just scoped to a file instead of a line.
 */
function timedFileGrep(context: vm.Context, rx: RegExp, probes: string[], cap: number): number[] {
  if (cap <= 0) return [];
  context.__rx = rx;
  context.__probes = probes;
  context.__cap = cap;
  try {
    const result: unknown = vm.runInContext(GREP_MATCH_LOOP_SRC, context, { timeout: GREP_FILE_TIMEOUT_MS });
    return Array.isArray(result) ? (result as number[]) : [];
  } catch {
    return []; // per-file timeout (or any other vm error) — never propagate, never hang
  }
}

/** The realpath'd root (so a symlinked checkout still confines correctly); falls back to a plain resolve. */
function realRoot(root: string): string {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

/**
 * Resolve a caller-supplied RELATIVE path against `root`, REFUSING anything that escapes it (an absolute
 * path, a `..` traversal, or a symlink that resolves outside). THE confinement gate — reused, unmodified,
 * by both registration entry points below (never hand-rolled twice).
 */
function resolveWithin(root: string, rel: string): string {
  if (typeof rel !== "string" || rel.trim().length === 0) throw new Error("path required");
  if (path.isAbsolute(rel)) throw new Error("path must be RELATIVE to the repo root");
  const abs = path.resolve(root, rel);
  const within = (p: string) => p === root || p.startsWith(root + path.sep);
  if (!within(abs)) throw new Error("path escapes the repo root");
  // Defeat a symlink that points outside the tree: realpath the (existing) target and re-check.
  try {
    const real = fs.realpathSync(abs);
    if (!within(real)) throw new Error("path escapes the repo root (symlink)");
  } catch (e) {
    // ENOENT just means the file doesn't exist yet — the lexical check above already confines it.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }
  return abs;
}

/**
 * Translate a glob (supporting `**`, `*`, `?`) to an anchored RegExp matched against a POSIX, repo-relative
 * path. `**` (optionally `/`-bounded) crosses directories and may match zero segments; `*`/`?` stay within
 * a single segment. No `{a,b}` brace expansion — keep the surface small and predictable.
 */
function globToRegExp(glob: string): RegExp {
  const SPECIAL = /[.+^${}()|[\]\\]/g;
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!; // i < glob.length ⇒ defined (noUncheckedIndexedAccess)
    if (c === "*" && glob[i + 1] === "*") {
      const slashBefore = i === 0 || glob[i - 1] === "/";
      const j = i + 2;
      const slashAfter = glob[j] === "/";
      if (slashBefore && slashAfter) { re += "(?:.*/)?"; i = j + 1; continue; } // `**/` -> zero-or-more dirs
      re += ".*"; i = j; continue; // bare `**` -> anything incl. `/`
    }
    if (c === "*") { re += "[^/]*"; i++; continue; }
    if (c === "?") { re += "[^/]"; i++; continue; }
    re += c.replace(SPECIAL, "\\$&"); i++;
  }
  return new RegExp(re + "$");
}

/** Walk every regular FILE under `root`, skipping SKIP_DIRS and symlinks, bounded by MAX_WALK_FILES. */
function* walkFiles(root: string): Generator<string> {
  let count = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow a symlink out of the tree
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

/** Repo-relative POSIX path (the stable, host-path-free form returned to the caller). */
function relPosix(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join("/");
}

/** Core of `repo_read_file` — confined + bounded; throws on an escape (caller wraps in try/catch). */
function doReadFile(root: string, rel: string, offset?: number, limit?: number) {
  const abs = resolveWithin(root, rel);
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); } catch { return { error: "file not found" }; }
  if (!stat.isFile()) return { error: "not a file" };
  if (stat.size > MAX_FILE_BYTES) return { error: `file too large (${stat.size} bytes > ${MAX_FILE_BYTES} cap)` };
  const content = fs.readFileSync(abs, "utf8");
  if (containsNul(content)) return { error: "binary file (not text)" };
  const all = content.split(/\r?\n/);
  const start = Math.min(Math.max(0, offset ?? 0), all.length);
  const count = Math.min(limit ?? MAX_READ_LINES, MAX_READ_LINES);
  const lines = all.slice(start, start + count).map(clampLine);
  const nextOffset = start + lines.length < all.length ? start + lines.length : null;
  return { path: relPosix(root, abs), totalLines: all.length, offset: start, lines, nextOffset };
}

/** Core of `repo_grep` — confined + bounded; throws only on a bad regex (caller wraps in try/catch). */
function doGrep(root: string, pattern: string, glob?: string, ignoreCase?: boolean, maxResults?: number) {
  let rx: RegExp;
  try { rx = new RegExp(pattern, ignoreCase ? "i" : ""); }
  catch (e) { throw new Error(`invalid regex: ${(e as Error).message}`); }
  const fileFilter = glob ? globToRegExp(glob) : null;
  const cap = Math.min(maxResults ?? MAX_GREP_MATCHES, MAX_GREP_MATCHES);
  const matches: Array<{ file: string; line: number; text: string }> = [];
  const vmContext = vm.createContext(); // one reused, fs/require-free sandbox for every timedFileGrep call
  const grepStart = Date.now();
  let timedOut = false;
  for (const full of walkFiles(root)) {
    if (matches.length >= cap) break;
    // TOTAL budget — a plain Date.now() check BETWEEN files (cheap; not itself a vm crossing), so a repo
    // full of individually-timed-out pathological files can't chain per-file timeouts unboundedly.
    if (Date.now() - grepStart > GREP_TOTAL_BUDGET_MS) { timedOut = true; break; }
    const rel = relPosix(root, full);
    if (fileFilter && !fileFilter.test(rel)) continue;
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) continue;
    let content: string;
    try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
    if (containsNul(content)) continue; // binary
    const lines = content.split(/\r?\n/);
    // The MATCH INPUT is clamped to MAX_LINE_LEN per line — a raw slice, NOT clampLine's suffixed form, so
    // it doesn't alter match semantics near the boundary. The STORED `text` below stays clampLine(line)
    // exactly as before. The clamp alone is NOT a full ReDoS defense (see the constants above) — it just
    // keeps the common case cheap; the whole probe array for this file runs through ONE timedFileGrep call.
    const probes = lines.map((line) => (line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) : line));
    const hitIndices = timedFileGrep(vmContext, rx, probes, cap - matches.length);
    for (const i of hitIndices) {
      matches.push({ file: rel, line: i + 1, text: clampLine(lines[i]!) });
    }
  }
  return { matches, capped: matches.length >= cap, timedOut };
}

/** Core of `repo_glob` — confined + bounded. */
function doGlob(root: string, pattern: string, limit?: number) {
  const rx = globToRegExp(pattern);
  const cap = Math.min(limit ?? MAX_GLOB_RESULTS, MAX_GLOB_RESULTS);
  const matches: string[] = [];
  for (const full of walkFiles(root)) {
    const rel = relPosix(root, full);
    if (rx.test(rel)) {
      matches.push(rel);
      if (matches.length >= cap) break;
    }
  }
  return { matches, capped: matches.length >= cap };
}

/**
 * The DEV Platform Auditor's fixed-root surface over the Loom SOURCE tree (unchanged from before this
 * module gained a second, `projectId`-scoped entry point — same tool names, schemas, descriptions, and
 * byte-identical behavior). `loomRepoRoot()` is re-read on EVERY call (not cached at registration), which
 * is also this module's test seam (`LOOM_REPO_ROOT`).
 */
export function registerRepoReadTools(server: McpServer): void {
  server.registerTool(
    "repo_read_file",
    {
      description:
        "Read ONE text file from the Loom SOURCE repo (read-only, code-awareness for the gap-hunt). `path` " +
        "is RELATIVE to the repo root (e.g. \"packages/daemon/src/mcp/audit.ts\") — an absolute path or a " +
        "`..` escape is refused (you can only read inside the Loom checkout, never an arbitrary host file). " +
        "Returns {path, totalLines, offset, lines, nextOffset}: `lines` is a 0-based window (`offset`, up to " +
        `${MAX_READ_LINES} lines), and \`nextOffset\` is the next index to page from (null when the file is ` +
        "exhausted). Binary or oversized (>512 KiB) files are refused with {error}. Use repo_glob to find a " +
        "path and repo_grep to find a line first.",
      inputSchema: {
        path: z.string(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ path: rel, offset, limit }) => {
      try { return ok(doReadFile(realRoot(loomRepoRoot()), rel, offset, limit)); }
      catch (e) { return ok({ error: (e as Error).message }); }
    },
  );

  server.registerTool(
    "repo_grep",
    {
      description:
        "Search the Loom SOURCE repo's text files for a JS RegExp `pattern`, returning matching lines as " +
        "{file, line, text} (read-only; in-process — NEVER shells out to git grep / rg). Narrow with an " +
        "optional `glob` (e.g. \"packages/daemon/src/**/*.ts\") matched against the repo-relative path; " +
        "`ignoreCase` for a case-insensitive search. Skips node_modules/.git/dist and binary/oversized " +
        `files. Capped at ${MAX_GREP_MATCHES} matches (\`capped:true\` when it hit the cap — tighten the ` +
        "pattern/glob). A pathological line (or a hostile pattern) can never hang the search — a single " +
        "such file is silently skipped (absorbed, like an oversized/binary file) and the search continues; " +
        "if enough of them chain to blow the OVERALL time budget, the search stops early and returns " +
        "`timedOut:true` with whatever partial matches it found so far — narrow the glob if you see it. " +
        "Returns {matches, capped, timedOut} or {error} on a bad regex.",
      inputSchema: {
        pattern: z.string(),
        glob: z.string().optional(),
        ignoreCase: z.boolean().optional(),
        maxResults: z.number().int().positive().optional(),
      },
    },
    async ({ pattern, glob, ignoreCase, maxResults }) => {
      try { return ok(doGrep(realRoot(loomRepoRoot()), pattern, glob, ignoreCase, maxResults)); }
      catch (e) { return ok({ error: (e as Error).message }); }
    },
  );

  server.registerTool(
    "repo_glob",
    {
      description:
        "List Loom SOURCE repo files whose repo-relative POSIX path matches a `pattern` (read-only). " +
        "Supports `**` (cross-directory), `*`, `?` — e.g. \"packages/daemon/src/mcp/*.ts\" or " +
        "\"**/*.test.mjs\". Skips node_modules/.git/dist. Discovery order is not guaranteed; " +
        `capped at ${MAX_GLOB_RESULTS} paths (\`capped:true\` when it hit the cap). Returns ` +
        "{matches, capped} of repo-relative paths to feed into repo_read_file / repo_grep.",
      inputSchema: {
        pattern: z.string(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ pattern, limit }) => {
      try { return ok(doGlob(realRoot(loomRepoRoot()), pattern, limit)); }
      catch (e) { return ok({ error: (e as Error).message }); }
    },
  );
}

/** A resolved read root, or a clean {error} (unknown project / no repoPath) — never a throw. */
export type ScopedRootResolution = { root: string } | { error: string };

/**
 * Resolve the tools' root PER CALL from the caller-supplied `projectId` (own-project confinement — the
 * caller can never name another project's root). `resolveRoot` typically wraps `db.getProject(projectId)`.
 */
export type ScopedRootResolver = (projectId: string) => ScopedRootResolution;

/**
 * The END-USER Workspace Auditor's `projectId`-scoped surface — the SAME confined + bounded
 * repo_read_file/repo_grep/repo_glob reads as `registerRepoReadTools`, reusing the identical
 * `resolveWithin` confinement gate and bound constants, but resolving the root PER CALL from a caller
 * -supplied `projectId` instead of a fixed Loom-source root. `resolveRoot` errors (unknown project, no
 * repoPath) surface as a clean {error} — never a throw, never a silent empty result.
 */
export function registerScopedRepoReadTools(server: McpServer, resolveRoot: ScopedRootResolver): void {
  server.registerTool(
    "repo_read_file",
    {
      description:
        "Read ONE text file from YOUR OWN project's source tree (read-only, code-awareness for the " +
        "structural gap-hunt). `projectId` names the project (from list_sessions); `path` is RELATIVE to " +
        "that project's repo root — an absolute path or a `..` escape is refused (you can only read inside " +
        "the named project's own repo root, never another project's root or an arbitrary host file). " +
        "Returns {path, totalLines, offset, lines, nextOffset}: `lines` is a 0-based window (`offset`, up to " +
        `${MAX_READ_LINES} lines), and \`nextOffset\` is the next index to page from (null when the file is ` +
        "exhausted). Binary or oversized (>512 KiB) files are refused with {error}, as is an unknown " +
        "projectId or a project with no readable repo root. Use repo_glob to find a path and repo_grep to " +
        "find a line first.",
      inputSchema: {
        projectId: z.string(),
        path: z.string(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ projectId, path: rel, offset, limit }) => {
      const resolved = resolveRoot(projectId);
      if ("error" in resolved) return ok({ error: resolved.error });
      try { return ok(doReadFile(realRoot(resolved.root), rel, offset, limit)); }
      catch (e) { return ok({ error: (e as Error).message }); }
    },
  );

  server.registerTool(
    "repo_grep",
    {
      description:
        "Search YOUR OWN project's source tree for a JS RegExp `pattern`, returning matching lines as " +
        "{file, line, text} (read-only; in-process — NEVER shells out to git grep / rg). `projectId` names " +
        "the project (from list_sessions). Narrow with an optional `glob` (e.g. \"src/**/*.ts\") matched " +
        "against the project-relative path; `ignoreCase` for a case-insensitive search. Skips " +
        "node_modules/.git/dist and binary/oversized files. Capped at " +
        `${MAX_GREP_MATCHES} matches (\`capped:true\` when it hit the cap — tighten the pattern/glob). ` +
        "A pathological line (or a hostile pattern, e.g. from an untrusted transcript) can never hang the " +
        "search — a single such file is silently skipped (absorbed, like an oversized/binary file) and the " +
        "search continues; if enough of them chain to blow the OVERALL time budget, the search stops early " +
        "and returns `timedOut:true` with whatever partial matches it found so far — narrow the glob if you " +
        "see it. Returns {matches, capped, timedOut} or {error} on a bad regex, an unknown projectId, or a " +
        "project with no readable repo root.",
      inputSchema: {
        projectId: z.string(),
        pattern: z.string(),
        glob: z.string().optional(),
        ignoreCase: z.boolean().optional(),
        maxResults: z.number().int().positive().optional(),
      },
    },
    async ({ projectId, pattern, glob, ignoreCase, maxResults }) => {
      const resolved = resolveRoot(projectId);
      if ("error" in resolved) return ok({ error: resolved.error });
      try { return ok(doGrep(realRoot(resolved.root), pattern, glob, ignoreCase, maxResults)); }
      catch (e) { return ok({ error: (e as Error).message }); }
    },
  );

  server.registerTool(
    "repo_glob",
    {
      description:
        "List files in YOUR OWN project's source tree whose project-relative POSIX path matches a " +
        "`pattern` (read-only). `projectId` names the project (from list_sessions). Supports `**` " +
        "(cross-directory), `*`, `?` — e.g. \"src/mcp/*.ts\" or \"**/*.test.mjs\". Skips " +
        "node_modules/.git/dist. Discovery order is not guaranteed; capped at " +
        `${MAX_GLOB_RESULTS} paths (\`capped:true\` when it hit the cap). Returns {matches, capped} of ` +
        "project-relative paths to feed into repo_read_file / repo_grep, or {error} for an unknown " +
        "projectId or a project with no readable repo root.",
      inputSchema: {
        projectId: z.string(),
        pattern: z.string(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ projectId, pattern, limit }) => {
      const resolved = resolveRoot(projectId);
      if ("error" in resolved) return ok({ error: resolved.error });
      try { return ok(doGlob(realRoot(resolved.root), pattern, limit)); }
      catch (e) { return ok({ error: (e as Error).message }); }
    },
  );
}
