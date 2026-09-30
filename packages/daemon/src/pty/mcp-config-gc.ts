import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { SETTINGS_DIR } from "../paths.js";

const MCP_CONFIG_SUFFIX = ".mcp-config.json";
// Card ed0757d6 Code Review fix: writeSessionMcpConfig (claude-settings.ts) writes to `<file>.tmp` THEN
// fs.renameSync's it to `<file>` — a crash, or a Windows renameSync EPERM (a real, documented Windows
// footgun: a concurrent reader/AV scan can hold the target briefly), can strand the `.tmp` file with the
// SAME secret in it, never reaching the final name this sweep already scans for. Same suffix-then-strip
// shape as MCP_CONFIG_SUFFIX, checked FIRST so a `.tmp` file matches its own branch, not the plain one.
const MCP_CONFIG_TMP_SUFFIX = ".mcp-config.json.tmp";

export interface McpConfigGcResult {
  /** `*.mcp-config.json` and `*.mcp-config.json.tmp` files found under SETTINGS_DIR. */
  scanned: number;
  /** File names actually removed. */
  reaped: string[];
}

/**
 * Boot-time sweep of orphaned per-session `--mcp-config` secret files under SETTINGS_DIR — the final
 * backstop for a hard daemon crash that skips host.ts's other three cleanup sites (createPty's stale-file
 * unlink, markReady, pty onExit).
 *
 * @decision ed0757d6 — never add a resumability check here (unlike scratch-gc.ts's own boot sweep): this
 * file is pure per-spawn secret material, always rewritten fresh at a session's own next spawn, never
 * read across a respawn boundary — resumability is irrelevant to whether deleting it is safe.
 *
 * Reap a file iff its session is genuinely not `live`/`starting` right now — a session with no DB row at
 * all (its row was deleted, or the file predates any row we can find) is reaped too, since there is
 * nothing left that could still need it. Synchronous (a handful of small file unlinks — nothing like
 * scratch-gc's own directory-tree removals), so no fire-and-forget/timeout wrapper is needed.
 */
export function sweepOrphanedMcpConfigs(db: Db): McpConfigGcResult {
  const result: McpConfigGcResult = { scanned: 0, reaped: [] };
  let entries: string[];
  try {
    entries = fs.readdirSync(SETTINGS_DIR);
  } catch {
    return result; // settings dir absent — nothing to sweep
  }

  for (const name of entries) {
    const sessionId = name.endsWith(MCP_CONFIG_TMP_SUFFIX)
      ? name.slice(0, -MCP_CONFIG_TMP_SUFFIX.length)
      : name.endsWith(MCP_CONFIG_SUFFIX)
        ? name.slice(0, -MCP_CONFIG_SUFFIX.length)
        : null;
    if (sessionId === null) continue;
    result.scanned++;
    const row = db.getSession(sessionId);
    if (row && (row.processState === "live" || row.processState === "starting")) continue; // may still need it — SAME rule for the .tmp case
    try {
      fs.unlinkSync(path.join(SETTINGS_DIR, name));
      result.reaped.push(name);
    } catch { /* best-effort — left for the next boot sweep */ }
  }
  return result;
}
