import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { SETTINGS_DIR } from "../paths.js";

const MCP_CONFIG_TMP_SUFFIX = ".mcp-config.json.tmp";
const MCP_CONFIG_SUFFIX = ".mcp-config.json";
// Card a50b8afd: the `--settings` file (hook token) shares SETTINGS_DIR with the mcp-config file above and
// gets the SAME boot-sweep backstop — see unlinkSessionSettings's own doc (claude-settings.ts) for why
// nothing ever swept it before this card. `.json`/`.json.tmp` are SUBSTRINGS of the mcp-config suffixes
// above (".mcp-config.json" itself ends in ".json"), so `classifySettingsDirFile` below MUST check the
// longer, more specific suffixes first — order is load-bearing, not stylistic.
const SETTINGS_TMP_SUFFIX = ".json.tmp";
const SETTINGS_SUFFIX = ".json";

type SettingsDirFileKind = "mcp-config" | "mcp-config-tmp" | "settings" | "settings-tmp";

/**
 * Classify one `fs.readdirSync(SETTINGS_DIR)` entry by filename alone — never throws, returns `null` for
 * anything that matches neither family (there is nothing else under SETTINGS_DIR today — see
 * claude-settings.ts's own doc on what this directory holds).
 *
 * @decision a50b8afd — check `.mcp-config.json[.tmp]` BEFORE the plain `.json[.tmp]` suffixes; the longer
 * suffix is a strict superset-match of the shorter one, so a short-first order would misclassify every
 * mcp-config file as a settings file.
 */
function classifySettingsDirFile(name: string): { sessionId: string; kind: SettingsDirFileKind } | null {
  if (name.endsWith(MCP_CONFIG_TMP_SUFFIX)) return { sessionId: name.slice(0, -MCP_CONFIG_TMP_SUFFIX.length), kind: "mcp-config-tmp" };
  if (name.endsWith(MCP_CONFIG_SUFFIX)) return { sessionId: name.slice(0, -MCP_CONFIG_SUFFIX.length), kind: "mcp-config" };
  if (name.endsWith(SETTINGS_TMP_SUFFIX)) return { sessionId: name.slice(0, -SETTINGS_TMP_SUFFIX.length), kind: "settings-tmp" };
  if (name.endsWith(SETTINGS_SUFFIX)) return { sessionId: name.slice(0, -SETTINGS_SUFFIX.length), kind: "settings" };
  return null;
}

export interface SettingsDirGcResult {
  /** `*.mcp-config.json[.tmp]` and `*.json[.tmp]` (settings) files found under SETTINGS_DIR. */
  scanned: number;
  /** File names actually removed. */
  reaped: string[];
}

/**
 * Boot-time sweep of orphaned per-session secret files under SETTINGS_DIR — the final backstop for a hard
 * daemon crash that skips host.ts's other cleanup sites (createPty's stale-file unlink, markReady, pty
 * onExit) for the mcp-config file, and (card a50b8afd) markReady/onExit for the settings file.
 *
 * @decision ed0757d6 — never add a resumability check here (unlike scratch-gc.ts's own boot sweep): both
 * file kinds are pure per-spawn secret material, always rewritten fresh at a session's own next spawn,
 * never read across a respawn boundary — resumability is irrelevant to whether deleting it is safe.
 *
 * Reap a file iff its session is genuinely not `live`/`starting` right now — a session with no DB row at
 * all (its row was deleted, or the file predates any row we can find) is reaped too, since there is
 * nothing left that could still need it. Synchronous (a handful of small file unlinks — nothing like
 * scratch-gc's own directory-tree removals), so no fire-and-forget/timeout wrapper is needed.
 */
export function sweepOrphanedSettingsDirSecrets(db: Db): SettingsDirGcResult {
  const result: SettingsDirGcResult = { scanned: 0, reaped: [] };
  let entries: string[];
  try {
    entries = fs.readdirSync(SETTINGS_DIR);
  } catch {
    return result; // settings dir absent — nothing to sweep
  }

  for (const name of entries) {
    const classified = classifySettingsDirFile(name);
    if (classified === null) continue;
    result.scanned++;
    const row = db.getSession(classified.sessionId);
    if (row && (row.processState === "live" || row.processState === "starting")) continue; // may still need it
    try {
      fs.unlinkSync(path.join(SETTINGS_DIR, name));
      result.reaped.push(name);
    } catch { /* best-effort — left for the next boot sweep */ }
  }
  return result;
}
