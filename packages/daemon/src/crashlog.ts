import fs from "node:fs";
import path from "node:path";
import { LOOM_HOME } from "./paths.js";

// Top-level fatal-exit crash handler. A real daemon crash once left NO log signature at all (grep for
// ENOSPC/EMFILE/chokidar/heap/FATAL/OOM found nothing), so the cause was unconfirmable. These handlers
// capture a single diagnosable record — the failure plus a best-effort resource snapshot (active
// watchers, open FDs, memory) — to a dedicated crashlog BEFORE the process dies.

/**
 * The dedicated fatal-exit crashlog. Lives under LOOM_HOME (the `.loom` dir), resolved via the paths
 * helper — never hardcode `~/.loom`. `.loom` is DELIBERATELY excluded from the docs-vault auto-committer
 * (0b72369: startVaultVersioners skips an operational/`.loom`-rooted home), so writing here accrues no
 * vault git history and never trips the VaultVersioner — keep the crashlog under LOOM_HOME to preserve that.
 */
export const CRASHLOG_PATH = path.join(LOOM_HOME, "crash.log");

// Must match RESTART_EXIT_CODE in orchestration/restart.ts (and scripts/daemon-supervisor.mjs): the
// daemon exits 75 to ASK the supervisor for a restart. That is an intentional, healthy exit — NOT a
// crash — so the exit-hook backstop below must never mistake it for one and write a spurious crashlog.
const RESTART_EXIT_CODE = 75;

let installed = false;
let wrote = false;

/** Best-effort count of OPEN file descriptors (Linux `/proc` only; null on Windows/macOS or on error). */
function openFdCount(): number | null {
  try {
    return fs.readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}

/**
 * Best-effort snapshot of active libuv resources — the watcher/handle-leak diagnostic. `watcherCount`
 * isolates FSWatcher/StatWatcher (the chokidar class implicated in the unconfirmed crash); `counts` is
 * the full type→count breakdown (Timeout, TCPServerWrap, …) for any other handle leak.
 */
function activeResourceSnapshot(): { watcherCount: number | null; counts: Record<string, number> | null } {
  try {
    const info = process.getActiveResourcesInfo();
    const counts: Record<string, number> = {};
    let watcherCount = 0;
    for (const type of info) {
      counts[type] = (counts[type] ?? 0) + 1;
      if (type === "FSWatcher" || type === "StatWatcher") watcherCount++;
    }
    return { watcherCount, counts };
  } catch {
    return { watcherCount: null, counts: null };
  }
}

export interface CrashlogInput {
  kind: "uncaughtException" | "unhandledRejection" | "exit";
  /** The thrown value / rejection reason (undefined for a bare exit-code death). */
  error?: unknown;
  signal?: string | null;
  exitCode?: number | null;
}

/**
 * Synchronously write ONE fatal-exit record to {@link CRASHLOG_PATH}, capturing the failure plus a
 * best-effort resource snapshot. Called from the synchronous `exit` hook, so it MUST be synchronous and
 * MUST NEVER throw — every capture is individually guarded and the whole body is a no-throw envelope.
 * Writes at most once per process (the first fatal wins); later handlers no-op so a record isn't clobbered.
 */
export function writeCrashlog(input: CrashlogInput): void {
  if (wrote) return;
  wrote = true;
  try {
    const err = input.error;
    const error =
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack ?? null }
        : err === undefined
          ? null
          : { name: null, message: String(err), stack: null };
    const { watcherCount, counts } = activeResourceSnapshot();
    let memory: NodeJS.MemoryUsage | null = null;
    try { memory = process.memoryUsage(); } catch { /* keep null */ }
    let uptimeSeconds: number | null = null;
    try { uptimeSeconds = process.uptime(); } catch { /* keep null */ }
    let ts: string;
    try { ts = new Date().toISOString(); } catch { ts = ""; }
    const record = {
      ts,
      kind: input.kind,
      signal: input.signal ?? null,
      exitCode: input.exitCode ?? null,
      error,
      activeWatcherCount: watcherCount,
      activeResourceCounts: counts,
      openFdCount: openFdCount(),
      memory,
      uptimeSeconds,
      pid: process.pid,
      ppid: process.ppid,
      platform: process.platform,
      nodeVersion: process.version,
    };
    fs.mkdirSync(path.dirname(CRASHLOG_PATH), { recursive: true });
    fs.writeFileSync(CRASHLOG_PATH, JSON.stringify(record, null, 2) + "\n");
  } catch {
    /* the crash handler must NEVER throw — a failed crashlog write is swallowed by design */
  }
}

/**
 * Install the top-level fatal-exit handlers. Wired ONCE at the daemon entrypoint:
 * - `uncaughtException` / `unhandledRejection` — write the crashlog, then `process.exit(1)`. With a
 *   handler attached Node no longer self-terminates, so we MUST exit to preserve the default fatal code.
 * - `exit` (synchronous backstop) — catches any OTHER non-zero death (a stray `process.exit(1)`, the
 *   `main()` startup-failure path) that didn't route through the handlers above. A clean stop (exit 0,
 *   the graceful path) and the intentional restart sentinel (75) are NOT crashes, so they are skipped.
 * Idempotent: a second call is a no-op.
 */
export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;

  process.on("uncaughtException", (err) => {
    // Attaching a listener SUPPRESSES Node's default stderr stack-print, so log it ourselves FIRST —
    // the crashlog COMPLEMENTS the console/LOGS_DIR trace, it doesn't replace it. console.error won't
    // throw, but keep it inside the no-throw spirit of the handler regardless.
    console.error("[crashlog] fatal uncaughtException:", err);
    writeCrashlog({ kind: "uncaughtException", error: err });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[crashlog] fatal unhandledRejection:", reason);
    writeCrashlog({ kind: "unhandledRejection", error: reason });
    process.exit(1);
  });
  process.on("exit", (code) => {
    if (code !== 0 && code !== RESTART_EXIT_CODE) writeCrashlog({ kind: "exit", exitCode: code });
  });
}
