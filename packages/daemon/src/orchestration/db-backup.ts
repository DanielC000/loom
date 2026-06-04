import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { resolveConfig, type BackupConfig } from "@loom/shared";
import { DB_PATH, AUTO_BACKUP_DIR } from "../paths.js";

/**
 * Automatic SQLite DB backup service. The 2026-06-04 prod-wipe survived only by LUCK (the destructive
 * DELETEs were still in the WAL and the main file held a 23-min-old checkpoint) — this gives durable,
 * automatic recovery for ANY cause. Snapshots `loom.db` into `~/.loom/backups/auto/loom-<ISO>.db` via
 * better-sqlite3's ONLINE backup API (`db.backup(dest)` — safe on a live WAL DB; a flat file-copy of
 * an open WAL DB can capture a torn/stale main file, exactly the failure mode that nearly lost the DB).
 *
 * Triggers (wired in index.ts / sessions/service.ts): on boot (before migrations/reconcile, so a bad
 * migration is recoverable to the pre-boot state), periodically (DbBackupWatcher), and before a
 * self-host `daemon_restart`. Every path is BEST-EFFORT + bounded: a failure LOGS and continues — it
 * NEVER throws into boot/restart or crashes the daemon (mirrors the watchers / usage-awareness style).
 *
 * Decoupled by design: each snapshot opens its OWN short-lived connection to the DB FILE (not the
 * daemon's live `Db` handle), so this module needs no change to `db.ts` and can run before the main Db
 * is even open (the boot trigger). A second connection alongside the live writer is exactly the WAL
 * online-backup use case.
 */

/** Resolve the effective daemon-global backup config (platform default + LOOM_BACKUP_INTERVAL_MINUTES). */
export function resolveBackupConfig(): BackupConfig {
  return resolveConfig(undefined).backup;
}

/** Windows-safe snapshot filename from an ISO timestamp (":" is illegal in Windows filenames). */
export function snapshotFilename(now: Date): string {
  return `loom-${now.toISOString().replace(/:/g, "-")}.db`;
}

/**
 * Take ONE online snapshot of the live SQLite DB into the auto-backup dir, then rotate. Best-effort +
 * bounded: ANY failure (disk full, locked, bad path) is logged and resolves `null` — it NEVER throws,
 * so it can't crash the daemon or block boot/restart. Returns the snapshot path on success.
 *
 * Skips silently on a fresh install (the DB file doesn't exist yet — nothing to back up).
 */
export async function takeBackup(opts: {
  /** Short label for the log line + which trigger fired ("boot" | "periodic" | "pre-restart"). */
  reason: string;
  /** Retain the newest `keep` snapshots after this one (older pruned by mtime). */
  keep: number;
  /** Source DB file (default: the daemon's DB_PATH). Tests pass an isolated temp DB. */
  srcDbPath?: string;
  /** Destination dir (default: ~/.loom/backups/auto). Tests pass an isolated temp dir. */
  destDir?: string;
  /** Clock injection for deterministic filenames in tests. */
  now?: Date;
}): Promise<string | null> {
  const src = opts.srcDbPath ?? DB_PATH;
  const dir = opts.destDir ?? AUTO_BACKUP_DIR;
  const now = opts.now ?? new Date();
  // Nothing to back up on a fresh install (DB not created yet) — silent skip, not a failure.
  if (!fs.existsSync(src)) return null;
  let conn: Database.Database | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, snapshotFilename(now));
    // Read-write (default) connection: at boot no other handle holds the file, so SQLite can run WAL
    // recovery normally; a read-only connection can fail on a WAL DB needing recovery. The backup
    // itself only READS the source — it never mutates it.
    conn = new Database(src);
    await conn.backup(dest);
    conn.close();
    conn = null;
    // eslint-disable-next-line no-console
    console.log(`[db-backup] snapshot (${opts.reason}) -> ${dest}`);
    rotateBackups(dir, opts.keep);
    return dest;
  } catch (err) {
    console.warn(`[db-backup] backup (${opts.reason}) failed (continuing): ${(err as Error).message}`);
    return null;
  } finally {
    try { conn?.close(); } catch { /* best-effort */ }
  }
}

/**
 * Keep the newest `keep` auto snapshots; prune older by mtime. ONLY ever touches `loom-*.db` files in
 * the auto dir — never the manual `pre-*` backups (those are dirs directly under backups/, not here)
 * and never any other file. Best-effort: a prune failure is logged and ignored. `keep <= 0` retains
 * everything (defensive — the config default is 48; a caller never disables retention this way).
 */
export function rotateBackups(dir: string, keep: number): void {
  try {
    if (keep <= 0) return;
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /^loom-.*\.db$/.test(e.name))
      .map((e) => {
        const full = path.join(dir, e.name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* unreadable → sorts oldest */ }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first
    for (const stale of entries.slice(keep)) {
      try { fs.rmSync(stale.full, { force: true }); } catch { /* best-effort */ }
    }
  } catch (err) {
    console.warn(`[db-backup] rotation failed (continuing): ${(err as Error).message}`);
  }
}

/** The slice of config the periodic watcher needs (injectable so a test drives tick() directly). */
export interface DbBackupWatcherDeps {
  enabled: boolean;
  /** Periodic cadence in minutes. <= 0 disables the ticker (boot/pre-restart snapshots are separate). */
  intervalMinutes: number;
  keep: number;
  /** Tick cadence override in ms (tests use a short interval to avoid a real-minutes wait). */
  intervalMs?: number;
  /** Source DB / dest dir overrides (tests isolate to a temp dir; daemon uses the defaults). */
  srcDbPath?: string;
  destDir?: string;
}

/**
 * Periodic auto-backup ticker — twin of ContextWatcher / IdleWatcher (no scheduling lib). Each tick
 * takes one best-effort snapshot + rotates. Disabled (start() no-ops) when backups are off or the
 * interval is 0.
 */
export class DbBackupWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  constructor(private deps: DbBackupWatcherDeps) {}

  /** Run one periodic snapshot (best-effort; never throws). Exposed so a test can drive it directly. */
  async tick(now: Date = new Date()): Promise<string | null> {
    if (!this.deps.enabled || this.deps.intervalMinutes <= 0) return null;
    // Skip if a prior tick's backup is still in flight (a snapshot shouldn't overlap itself).
    if (this.running) return null;
    this.running = true;
    try {
      return await takeBackup({
        reason: "periodic",
        keep: this.deps.keep,
        srcDbPath: this.deps.srcDbPath,
        destDir: this.deps.destDir,
        now,
      });
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (!this.deps.enabled || this.deps.intervalMinutes <= 0) return; // disabled
    const ms = this.deps.intervalMs ?? this.deps.intervalMinutes * 60_000;
    this.timer = setInterval(() => { void this.tick().catch(() => { /* never let a bad tick kill the loop */ }); }, ms);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
