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
 * Pre-accept Claude's workspace-trust dialog for a directory so an unattended spawned
 * session doesn't block on "Is this a project you trust?". This is exactly what clicking
 * "Yes, I trust this folder" persists. Trust lives in .claude.json under
 * projects[<abs path, forward slashes>].{hasTrustDialogAccepted, hasCompletedProjectOnboarding}.
 *
 * Idempotent: a no-op once the dir is trusted, so the read-modify-write of the (large,
 * possibly concurrently-used) .claude.json happens at most once per project dir.
 *
 * Concurrency: writeJsonAtomic (temp+rename) prevents *corruption*, but two concurrent
 * ensureTrusted calls could each read state S and each write S+theirs, last-writer-wins
 * clobbering the other's entry. So the read-modify-write runs under a cross-process advisory
 * lock (see withTrustLock), with a RE-READ inside the lock. The already-trusted fast-path
 * stays OUTSIDE the lock, so the hot/common case is lock-free.
 *
 * Residual limitation (OUT of scope — by design unsolvable here): this only serializes Loom
 * against Loom. An external `claude` process writing .claude.json honors no Loom lock, so a
 * Loom-vs-external clobber is still possible; we can't lock an uncooperative external writer.
 */
export function ensureTrusted(dir: string): void {
  const claudeJson = claudeJsonPath();
  const key = path.resolve(dir).replace(/\\/g, "/");

  // Fast-path, lock-free: already trusted → no-op, no lock taken (the common case).
  if (isTrusted(readCfg(claudeJson), key)) return;

  // A write is needed — serialize it. RE-READ inside the lock: another writer may have changed
  // (or already trusted) the config since the fast-path read above.
  withTrustLock(`${claudeJson}.loom-lock`, () => {
    const cfg = readCfg(claudeJson);
    if (isTrusted(cfg, key)) return;
    cfg.projects ??= {};
    const entry = cfg.projects[key] ?? {};
    cfg.projects[key] = { ...entry, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
    writeJsonAtomic(claudeJson, cfg);
  });
}
