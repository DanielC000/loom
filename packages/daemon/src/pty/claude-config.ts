import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Resolve Claude's main JSON config file. Honors CLAUDE_CONFIG_DIR (Claude relocates the
 * config — incl. the trust flags below — to <CLAUDE_CONFIG_DIR>/.claude.json when it is set),
 * falling back to ~/.claude.json. Read fresh each call so the env can be set per-process
 * (e.g. an isolated config dir for hermetic tests) without re-importing this module.
 */
function claudeJsonPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

/**
 * Atomically write `value` as pretty JSON to `filePath`: a uniquely-named temp file in the
 * same directory (so two concurrent writers can't collide on it) followed by a rename onto
 * the target. The rename is atomic on a single filesystem, so a crash mid-write can never
 * leave the real (possibly large, concurrently-read) config truncated/corrupt.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.loom.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

type ClaudeCfg = { projects?: Record<string, Record<string, unknown>> };

/** Read+parse the config; a missing/corrupt file is treated as empty (fresh). */
function readCfg(claudeJson: string): ClaudeCfg {
  try { return JSON.parse(fs.readFileSync(claudeJson, "utf8")); } catch { return {}; }
}

/** True iff `key`'s project entry already carries both trust flags. */
function isTrusted(cfg: ClaudeCfg, key: string): boolean {
  const e = cfg.projects?.[key];
  return e?.hasTrustDialogAccepted === true && e?.hasCompletedProjectOnboarding === true;
}

/** Pull the mcpServers names out of one .mcp.json (canonical shape `{mcpServers:{<name>:…}}`). */
function readMcpServerNames(mcpJsonPath: string, into: Set<string>): void {
  try {
    const j = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8")) as { mcpServers?: Record<string, unknown> };
    if (j.mcpServers && typeof j.mcpServers === "object") for (const n of Object.keys(j.mcpServers)) into.add(n);
  } catch { /* no/invalid .mcp.json here — best-effort */ }
}

/**
 * Discover the `.mcp.json` MCP-server names the about-to-spawn `claude` would surface a per-project
 * "N new MCP servers found in this project — enable?" prompt for, so we can pre-reject them (below).
 *
 * THE ACTUAL TRIGGER (empirically confirmed against CLI 2.1.172 on 2026-06-11): the CLI walks UP the
 * directory tree from cwd reading every `.mcp.json` it finds. EVERY Loom worktree lives under the home
 * dir (`~/.loom/worktrees/…`), so the walk reaches `~/.mcp.json` — a user-global MCP config (e.g.
 * docker/sentry servers) — and prompts to enable those servers BEFORE SessionStart. This is the
 * docker/sentry prompt host.ts dismisses with Esc; `--strict-mcp-config` does NOT suppress it (the
 * prompt is computed independently of the spawn's --mcp-config). The OLD "not config-suppressible"
 * note was about CLI flags; per-project `~/.claude.json` `disabledMcpjsonServers` DOES suppress it
 * (the CLI's `leH()` reads it → server = "rejected" → not "pending" → never offered).
 *
 * We walk cwd → … → home (inclusive) and STOP at home: that bounds the walk (it never escapes into
 * the wider filesystem) and is exactly the set the CLI inherits for a worktree under home. Over-listing
 * is harmless (a reject-list entry for a server not present is a no-op). Plugin-provided MCP servers, if
 * any ever surface, are NOT covered here by design — the retained Esc fallback in host.ts catches those.
 */
export function discoverProjectMcpServerNames(dir: string): string[] {
  const names = new Set<string>();
  const home = path.resolve(os.homedir());
  let cur = path.resolve(dir);
  // Up-tree walk, bounded at the home dir (inclusive) or the filesystem root, whichever comes first.
  for (;;) {
    readMcpServerNames(path.join(cur, ".mcp.json"), names);
    if (cur === home) break;
    const parent = path.dirname(cur);
    if (parent === cur) break; // filesystem root
    cur = parent;
  }
  // If cwd was NOT under home (the walk stopped at a different root), still cover ~/.mcp.json explicitly.
  readMcpServerNames(path.join(home, ".mcp.json"), names);
  return [...names];
}

/**
 * True iff `key`'s entry is FULLY pre-decided for an unattended boot: trusted AND every MCP server in
 * `mcpToDisable` is already in its `disabledMcpjsonServers` (so the enable-prompt has nothing pending).
 * When `mcpToDisable` is empty this reduces to `isTrusted` — i.e. byte-identical to the pre-fix behavior.
 */
function isFullyDecided(cfg: ClaudeCfg, key: string, mcpToDisable: string[]): boolean {
  if (!isTrusted(cfg, key)) return false;
  if (mcpToDisable.length === 0) return true;
  const disabled = cfg.projects?.[key]?.disabledMcpjsonServers;
  const set = Array.isArray(disabled) ? new Set(disabled as string[]) : new Set<string>();
  return mcpToDisable.every((n) => set.has(n));
}

/** Cross-process lock timeout AND staleness threshold (ms). Env-overridable for tests. */
function trustLockMs(): number {
  const n = Number(process.env.LOOM_TRUST_LOCK_MS);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

/** Synchronous sleep that parks the thread (no busy-spin) — ensureTrusted is sync by contract. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` under a best-effort cross-process advisory lock at `lockPath`. The lock is an
 * O_EXCL lockfile (`fs.openSync(..., "wx")`) — atomic across processes (parallel spawns,
 * multiple Loom daemons) on a single host.
 *
 * BOUNDED + NEVER-DEADLOCK + NEVER-NEWLY-FATAL (load-bearing — this is on the spawn path):
 * - Acquire with a short retry loop up to `trustLockMs()`.
 * - If the lock is STALE (mtime older than the timeout → the holder crashed without releasing),
 *   break it and retry.
 * - If we still can't acquire within the timeout, proceed best-effort WITHOUT the lock (warn).
 *   Worst case degrades to exactly the pre-lock behavior (a possible clobber) — never a hang.
 * - `fn` ALWAYS runs, and the lock (if held) is ALWAYS released in `finally`. We never throw a
 *   new error that would abort the spawn.
 */
function withTrustLock(lockPath: string, fn: () => void): void {
  const timeout = trustLockMs();
  const deadline = Date.now() + timeout;
  let held = false;
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* best-effort */ }
  while (true) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      held = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") break; // odd FS error → best-effort
      // Lock is held by someone else. Break it only if it looks stale (crashed holder).
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > timeout) { try { fs.rmSync(lockPath); } catch { /* lost the race */ } continue; }
      } catch { continue; /* lock vanished between open and stat → retry immediately */ }
      if (Date.now() >= deadline) {
        console.warn(`[claude-config] trust lock ${lockPath} busy after ${timeout}ms — proceeding best-effort (possible clobber)`);
        break;
      }
      sleepSync(50);
    }
  }
  try {
    fn();
  } finally {
    if (held) {
      try { fs.rmSync(lockPath); } catch { /* already gone */ }
    }
  }
}

/**
 * Pre-clear the two things that block an unattended spawned `claude` from reaching SessionStart,
 * BOTH persisted into .claude.json under projects[<abs path, forward slashes>]:
 *
 *  1. The workspace-trust dialog ("Is this a project you trust?") — exactly what clicking
 *     "Yes, I trust this folder" persists ({hasTrustDialogAccepted, hasCompletedProjectOnboarding}).
 *  2. The per-project "N new MCP servers found in this project — enable?" prompt. The CLI walks UP
 *     the tree from cwd reading every `.mcp.json`; since worktrees live under home it reaches
 *     `~/.mcp.json` and prompts for those servers (docker/sentry on this host). We discover those
 *     names (discoverProjectMcpServerNames) and pre-write them to `disabledMcpjsonServers` (plus an
 *     empty `enabledMcpjsonServers` and `enableAllProjectMcpServers:false`) so the CLI treats every
 *     one as already "rejected" → nothing pending → the prompt never appears. This REPLACES the
 *     fragile fire-and-forget Esc dismissal as the primary fix (host.ts keeps the Esc handler as a
 *     belt-and-suspenders fallback for anything not pre-decided here). Validated empirically against
 *     CLI 2.1.172 on 2026-06-11: a real spawn with these keys never surfaces the prompt.
 *
 * Idempotent: a no-op once the dir is trusted AND every discovered MCP server is already disabled, so
 * the read-modify-write of the (large, possibly concurrently-used) .claude.json happens at most once
 * per project dir. When no `.mcp.json` servers are discoverable, the written entry is byte-identical
 * to the pre-fix trust-only entry.
 *
 * Concurrency: writeJsonAtomic (temp+rename) prevents *corruption*, but two concurrent calls could
 * each read state S and each write S+theirs, last-writer-wins clobbering the other's entry. So the
 * read-modify-write runs under a cross-process advisory lock (see withTrustLock), with a RE-READ
 * inside the lock. The already-decided fast-path stays OUTSIDE the lock, so the hot/common case is
 * lock-free. We also MERGE (union) into any existing `disabledMcpjsonServers` rather than clobber it.
 *
 * Residual limitation (OUT of scope — by design unsolvable here): this only serializes Loom against
 * Loom. An external `claude` process writing .claude.json honors no Loom lock, so a Loom-vs-external
 * clobber is still possible; we can't lock an uncooperative external writer.
 */
export function ensureTrusted(dir: string): void {
  const claudeJson = claudeJsonPath();
  const key = path.resolve(dir).replace(/\\/g, "/");
  const mcpToDisable = discoverProjectMcpServerNames(dir); // [] when none → trust-only, pre-fix behavior

  // Fast-path, lock-free: already trusted AND every discovered MCP server pre-rejected → no-op (common).
  if (isFullyDecided(readCfg(claudeJson), key, mcpToDisable)) return;

  // A write is needed — serialize it. RE-READ inside the lock: another writer may have changed
  // (or already decided) the config since the fast-path read above.
  withTrustLock(`${claudeJson}.loom-lock`, () => {
    const cfg = readCfg(claudeJson);
    if (isFullyDecided(cfg, key, mcpToDisable)) return;
    cfg.projects ??= {};
    const entry = cfg.projects[key] ?? {};
    const merged: Record<string, unknown> = {
      ...entry,
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    };
    if (mcpToDisable.length > 0) {
      const existing = Array.isArray(entry.disabledMcpjsonServers) ? (entry.disabledMcpjsonServers as string[]) : [];
      merged.disabledMcpjsonServers = [...new Set([...existing, ...mcpToDisable])];
      // Preserve any prior explicit enable list; default to empty so the entry reads as fully decided.
      merged.enabledMcpjsonServers = Array.isArray(entry.enabledMcpjsonServers) ? entry.enabledMcpjsonServers : [];
      merged.enableAllProjectMcpServers = false;
    }
    cfg.projects[key] = merged;
    writeJsonAtomic(claudeJson, cfg);
  });
}
