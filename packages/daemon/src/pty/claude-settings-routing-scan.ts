import fs from "node:fs";
import path from "node:path";
import { claudeUserSettingsDir } from "./claude-config.js";
import { CLAUDE_DOCTRINE_DIR } from "./claude-dirname.js";
import { isAnthropicSpawnEnvKey } from "./anthropic-env-key.js";

/**
 * Card 9223fe84 (c) — READ-ONLY detection of claude settings files that can redirect or re-bill a session.
 *
 * Claude's own settings files (`$CLAUDE_CONFIG_DIR/settings(.local).json`, else `<home>/.claude/settings(.local).json`, and a project's /
 * worktree's `.claude/settings(.local).json`) can carry `env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_API_KEY` /
 * … or an `apiKeyHelper`, applying to EVERY claude session including a Loom-spawned one — the same
 * spend/routing surface decision c8eeda93 scrubs from the process env, but outside that scrub. This module
 * only DETECTS and reports KEY NAMES. It never edits a file, never returns or logs a value.
 *
 * @decision 9223fe84 — detect+warn, NOT neutralize (blanking `env` in Loom's `--settings`): unverified
 * empty-string semantics, needs a hand-listed name set c8eeda93 forbids, would clobber a deliberate gateway
 * setup, and cannot beat managed settings. Do not log a VALUE, ever; do not add blocking work to the spawn hot path.
 */

/** ONE shared predicate for both scans: an `env` key NAME that can redirect or re-bill a claude session.
 *  c8eeda93's `isAnthropicSpawnEnvKey` (the SAME function, not a copy) OR the provider switches that make a
 *  settings-level reroute effective. */
export function isClaudeRoutingEnvKey(key: string): boolean {
  if (isAnthropicSpawnEnvKey(key)) return true;
  const upper = key.toUpperCase();
  return upper === "CLAUDE_CODE_USE_BEDROCK"
    || upper === "CLAUDE_CODE_USE_VERTEX"
    || upper === "CLAUDE_CODE_USE_FOUNDRY";
}

/** The settings file names scanned in each directory, in report order. */
export const CLAUDE_SETTINGS_FILE_NAMES = ["settings.json", "settings.local.json"] as const;

/** Byte cap per file — a settings file is tiny; anything larger is read only up to this. */
export const SETTINGS_SCAN_MAX_BYTES = 256 * 1024;

export interface ClaudeSettingsFinding { file: string; keys: string[] }
export interface ClaudeSettingsRoutingStatus {
  /** false = the scan itself failed / has not run — NEVER read as "clean". */
  available: boolean;
  /** Present only when `available` is false: a short fixed-vocabulary reason (never file content). */
  reason?: string;
  findings: ClaudeSettingsFinding[];
}

/** Pure: the routing key NAMES in a settings JSON text (`env` keys + the literal `apiKeyHelper`). `null` =
 *  unparseable / not an object. Values are never returned. */
export function routingKeysInSettingsText(text: string): string[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const keys: string[] = [];
  const env = obj.env;
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    for (const k of Object.keys(env as Record<string, unknown>)) if (isClaudeRoutingEnvKey(k)) keys.push(k);
  }
  if ("apiKeyHelper" in obj) keys.push("apiKeyHelper");
  return keys;
}

/** Max key names reported per file; the rest are summarised as `+N more`. */
export const MAX_KEY_NAMES_PER_FILE = 20;
const SAFE_KEY_NAME_RE = /^[A-Za-z0-9_]{1,128}$/;

/**
 * The ONE choke point every reported key list passes through (boot log, per-spawn log, `served_status`): key
 * names come from worker-writable files, so only names matching `[A-Za-z0-9_]{1,128}` are reported verbatim
 * (a newline/ESC/over-long name never reaches the shared daemon log); the rest are COUNTED (`+N unprintable`),
 * and at most {@link MAX_KEY_NAMES_PER_FILE} names are listed (`+N more`).
 */
export function sanitizeKeyNames(keys: string[]): string[] {
  const safe = keys.filter((k) => SAFE_KEY_NAME_RE.test(k));
  const unprintable = keys.length - safe.length;
  const out = safe.slice(0, MAX_KEY_NAMES_PER_FILE);
  if (safe.length > MAX_KEY_NAMES_PER_FILE) out.push(`+${safe.length - MAX_KEY_NAMES_PER_FILE} more`);
  if (unprintable > 0) out.push(`+${unprintable} unprintable`);
  return out;
}

export interface ScanFsSeam {
  /** Read up to `maxBytes` RAW bytes of `file` (the caller compares byte counts before decoding). Rejects with
   *  an errno-coded error (ENOENT = absent). */
  readCapped(file: string, maxBytes: number): Promise<Buffer>;
}

const realFs: ScanFsSeam = {
  async readCapped(file, maxBytes) {
    const fh = await fs.promises.open(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close().catch(() => {});
    }
  },
};

/** Scan `<dir>/<name>` for each settings file name. An absent file is clean; any other read failure or
 *  an unparseable file makes the result `available:false` (never silently clean). Never throws. Labels each
 *  finding with the path RELATIVE to `labelBase` (forward slashes). */
export async function scanSettingsDir(
  dir: string,
  labelBase: string,
  fsSeam: ScanFsSeam = realFs,
  maxBytes: number = SETTINGS_SCAN_MAX_BYTES,
): Promise<ClaudeSettingsRoutingStatus> {
  const findings: ClaudeSettingsFinding[] = [];
  let failure: string | null = null;
  for (const name of CLAUDE_SETTINGS_FILE_NAMES) {
    const file = path.join(dir, name);
    const label = path.relative(labelBase, file).split(path.sep).join("/");
    try {
      // Read ONE byte past the cap so an oversize file is distinguishable from a truncated-but-valid one.
      const raw = await fsSeam.readCapped(file, maxBytes + 1);
      // Compare RAW byte counts: decoding first would inflate invalid UTF-8 (0xFF -> U+FFFD, +2 bytes).
      if (raw.length > maxBytes) { failure ??= `oversize:${label}`; continue; }
      const keys = routingKeysInSettingsText(raw.toString("utf8"));
      if (keys === null) { failure ??= `unparseable:${label}`; continue; }
      if (keys.length) findings.push({ file: label, keys: sanitizeKeyNames(keys) });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue; // absent = clean
      failure ??= `read-failed:${label}:${typeof code === "string" ? code : "error"}`;
    }
  }
  return failure ? { available: false, reason: failure, findings } : { available: true, findings };
}

let bootStatus: ClaudeSettingsRoutingStatus = { available: false, reason: "not-scanned-yet", findings: [] };

/** What `served_status` reports. Before the boot scan lands this is `available:false` — honest "unknown". */
export function getClaudeSettingsRoutingStatus(): ClaudeSettingsRoutingStatus {
  return bootStatus;
}

/** TEST SEAM — production never calls this. */
export function __setClaudeSettingsRoutingStatusForTest(s: ClaudeSettingsRoutingStatus): void {
  bootStatus = s;
}

/** Log-line text: key NAMES only. Exported so tests assert exactly what is logged. */
export function formatFindings(findings: ClaudeSettingsFinding[]): string {
  return findings.map((f) => `${f.file}[${f.keys.join(",")}]`).join(" ");
}

/** Boot scan of the USER-level files. Async, never throws; logs one line (found / failed / clean-silent). */
export async function runBootClaudeSettingsRoutingScan(fsSeam: ScanFsSeam = realFs): Promise<ClaudeSettingsRoutingStatus> {
  let status: ClaudeSettingsRoutingStatus;
  try {
    const dir = claudeUserSettingsDir();
    status = await scanSettingsDir(dir, dir, fsSeam);
  } catch {
    status = { available: false, reason: "scan-error", findings: [] };
  }
  bootStatus = status;
  if (status.findings.length) {
    console.warn(`[boot] claude user settings can redirect/re-bill every session (outside the env scrub): ${formatFindings(status.findings)} — key names only; review them or remove if unintended`);
  } else if (!status.available) {
    console.warn(`[boot] claude user settings routing scan could not complete (${status.reason}) — NOT a clean result`);
  }
  return status;
}

/**
 * Per-spawn scan of the session cwd's (worktree's) `.claude/settings(.local).json`. FIRE-AND-FORGET: returns
 * synchronously (void) and does its work on fs.promises after the caller has moved on — it must never add
 * blocking work to `spawn()`/`createPty` (CLAUDE.md: the spawn hot path does only existsSync). Logs one line
 * per spawn ONLY when something is found; never throws. Loom itself writes no `.claude/settings*.json` into
 * worktrees (skills inject into `.claude/skills`; the CLI's own `settings.local.json` carries permissions, no
 * routing keys), so a hit is the project's or the agent's own file.
 */
export function kickWorktreeSettingsRoutingScan(sessionId: string, cwd: string | undefined, fsSeam: ScanFsSeam = realFs): void {
  if (!cwd) return;
  void (async () => {
    try {
      const status = await scanSettingsDir(path.join(cwd, CLAUDE_DOCTRINE_DIR), cwd, fsSeam);
      if (status.findings.length) {
        console.warn(`[pty] session=${sessionId} worktree settings can redirect/re-bill this session (outside the env scrub): ${formatFindings(status.findings)} — key names only`);
      }
    } catch { /* best-effort */ }
  })();
}
