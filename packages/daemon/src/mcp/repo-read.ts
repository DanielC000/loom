import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loomRepoRoot } from "../paths.js";

// Same envelope as the task / orchestration / platform / audit MCP servers.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * The DEV Platform Auditor's LEAST-PRIVILEGE, READ-ONLY repo surface — `repo_read_file` / `repo_grep` /
 * `repo_glob` over the Loom SOURCE tree (`paths.ts > loomRepoRoot`). It exists so the Auditor — otherwise
 * transcript-only and STRUCTURALLY BLIND to silent code gaps (a doctrine-less worker, a dropped attr, a
 * dead-code watcher emit no transcript error) — can run a code-structure gap-hunt (see the 7 lenses in the
 * platform-audit skill).
 *
 * == STAYS INSIDE THE TRUST BOUNDARY ==================================================================
 * These are PURE READS, hard-confined to the repo tree and hard-bounded, with NO host-process spawn:
 *   - Every path is CONFINED to `loomRepoRoot()` — a relative path that escapes the root (via `..`, an
 *     absolute path, or a symlink pointing outside) is REFUSED, so the Auditor can never read an
 *     arbitrary host file (e.g. `~/.ssh/id_rsa`, the prod DB, another project's secrets).
 *   - grep/glob are pure in-process `fs` reads + a translated RegExp — NEVER `git grep` / `rg` / any
 *     child process. There is no shell, no exec, nothing outward. (The "no host/spawn" half of the
 *     auditor posture: it ingests UNTRUSTED transcripts, so granting it process-exec would be the one
 *     dangerous combination.)
 *   - Hard bounds cap every read (file bytes, returned lines, match count, files walked) so a huge or
 *     hostile tree can't blow the tool-result budget or wedge the daemon.
 * NO WRITE lives here — this module only ADDS reads to the audit surface; the two narrow daemon-local
 * writes (audit_file_finding / preset_suggestion_suggest) stay in audit.ts. This is registered ONLY on
 * the dev AuditMcpRouter — NOT in the shared transcript-read helper and NOT on the end-user Auditor
 * (loom-user-audit), which audits the user's WORKSPACE, never Loom's own source (the dev<->user split).
 * ====================================================================================================
 */

// --- hard bounds (a hostile / huge repo can't overflow the tool-result budget or wedge the daemon) ---
const MAX_FILE_BYTES = 512 * 1024; // a single file read/grep never loads more than 512 KiB
const MAX_READ_LINES = 2000; // repo_read_file returns at most this many lines per call (pages via offset)
const MAX_GLOB_RESULTS = 500; // repo_glob caps its match list
const MAX_GREP_MATCHES = 200; // repo_grep caps its match list
const MAX_WALK_FILES = 20_000; // never traverse an unbounded tree
const MAX_LINE_LEN = 500; // truncate a single very long matched/returned line

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

/** The realpath'd repo root (so a symlinked checkout still confines correctly); falls back to a resolve. */
function repoRootReal(): string {
  const root = loomRepoRoot();
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

/**
 * Resolve a caller-supplied RELATIVE path against the repo root, REFUSING anything that escapes it (an
 * absolute path, a `..` traversal, or a symlink that resolves outside). This is the confinement gate.
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

/** Repo-relative POSIX path (the stable, host-path-free form returned to the auditor). */
function relPosix(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join("/");
}

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
      try {
        const root = repoRootReal();
        const abs = resolveWithin(root, rel);
        let stat: fs.Stats;
        try { stat = fs.statSync(abs); } catch { return ok({ error: "file not found" }); }
        if (!stat.isFile()) return ok({ error: "not a file" });
        if (stat.size > MAX_FILE_BYTES) return ok({ error: `file too large (${stat.size} bytes > ${MAX_FILE_BYTES} cap)` });
        const content = fs.readFileSync(abs, "utf8");
        if (containsNul(content)) return ok({ error: "binary file (not text)" });
        const all = content.split(/\r?\n/);
        const start = Math.min(Math.max(0, offset ?? 0), all.length);
        const count = Math.min(limit ?? MAX_READ_LINES, MAX_READ_LINES);
        const lines = all.slice(start, start + count).map(clampLine);
        const nextOffset = start + lines.length < all.length ? start + lines.length : null;
        return ok({ path: relPosix(root, abs), totalLines: all.length, offset: start, lines, nextOffset });
      } catch (e) {
        return ok({ error: (e as Error).message });
      }
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
        "pattern/glob). Returns {matches, capped} or {error} on a bad regex.",
      inputSchema: {
        pattern: z.string(),
        glob: z.string().optional(),
        ignoreCase: z.boolean().optional(),
        maxResults: z.number().int().positive().optional(),
      },
    },
    async ({ pattern, glob, ignoreCase, maxResults }) => {
      let rx: RegExp;
      try { rx = new RegExp(pattern, ignoreCase ? "i" : ""); } catch (e) { return ok({ error: `invalid regex: ${(e as Error).message}` }); }
      try {
        const root = repoRootReal();
        const fileFilter = glob ? globToRegExp(glob) : null;
        const cap = Math.min(maxResults ?? MAX_GREP_MATCHES, MAX_GREP_MATCHES);
        const matches: Array<{ file: string; line: number; text: string }> = [];
        outer: for (const full of walkFiles(root)) {
          const rel = relPosix(root, full);
          if (fileFilter && !fileFilter.test(rel)) continue;
          let stat: fs.Stats;
          try { stat = fs.statSync(full); } catch { continue; }
          if (stat.size > MAX_FILE_BYTES) continue;
          let content: string;
          try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
          if (containsNul(content)) continue; // binary
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!; // split always yields strings (noUncheckedIndexedAccess)
            if (rx.test(line)) {
              matches.push({ file: rel, line: i + 1, text: clampLine(line) });
              if (matches.length >= cap) break outer;
            }
          }
        }
        return ok({ matches, capped: matches.length >= cap });
      } catch (e) {
        return ok({ error: (e as Error).message });
      }
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
      try {
        const root = repoRootReal();
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
        return ok({ matches, capped: matches.length >= cap });
      } catch (e) {
        return ok({ error: (e as Error).message });
      }
    },
  );
}
