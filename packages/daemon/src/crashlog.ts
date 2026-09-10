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

/** The rotated previous-crash slot. Kept alongside {@link CRASHLOG_PATH}; holds the last-but-one crash. */
export const CRASHLOG_PREV_PATH = `${CRASHLOG_PATH}.prev`;

/**
 * @decision 2f146782 — false with no shutdownMarker means killed from outside, never a JS "crash".
 * Must be called BEFORE {@link installCrashHandlers} rotates {@link CRASHLOG_PATH} away, and only
 * `env.LOOM_PRIOR_CRASHLOG` (never `fs.existsSync`) is trustworthy on the SUPERVISED (`daemon:stable`) path.
 */
export function hadCrashLogAtBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  return fs.existsSync(CRASHLOG_PATH) || env.LOOM_PRIOR_CRASHLOG === "1";
}

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
 * isolates the libuv HANDLE type names `process.getActiveResourcesInfo()` actually reports for a
 * filesystem watcher (the chokidar class implicated in the unconfirmed crash): `FSEventWrap` (what
 * `fs.watch()` — and therefore chokidar — surfaces, verified against this runtime, card `34744200`) and
 * `StatWatcher` (`fs.watchFile()`). `FSWatcher` is kept too for defensiveness (it is the JS-level class
 * name these wrap, in case a future/other Node build ever surfaces it directly) even though no arm of
 * that verification produced it. `counts` is the full type→count breakdown (Timeout, TCPServerWrap, …)
 * for any other handle leak.
 */
function activeResourceSnapshot(): { watcherCount: number | null; counts: Record<string, number> | null } {
  try {
    const info = process.getActiveResourcesInfo();
    const counts: Record<string, number> = {};
    let watcherCount = 0;
    for (const type of info) {
      counts[type] = (counts[type] ?? 0) + 1;
      if (type === "FSEventWrap" || type === "FSWatcher" || type === "StatWatcher") watcherCount++;
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
      // Renamed from `activeWatcherCount` (card 34744200): that field's predicate was blind to
      // `FSEventWrap` (what fs.watch()/chokidar actually surface) and could read 0 against thousands of
      // live watchers — an old record's `activeWatcherCount` is NOT comparable to this field's count, and
      // the rename makes that a visible absence on old records rather than a misleading zero. See this
      // function's own doc for the counted type set.
      activeFsWatcherCount: watcherCount,
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
 * Rotate {@link CRASHLOG_PATH} to {@link CRASHLOG_PREV_PATH} at boot, BEFORE {@link installCrashHandlers}
 * wires its own handlers below (so `writeCrashlog` can never race the rotation). Idempotent (no
 * crash.log ⇒ no-op), best-effort, NEVER throws.
 * @decision sha:e26fa369 — why this exists and why rotating only-if-present is safe under both callers.
 */
export function rotateCrashlog(): void {
  try {
    if (!fs.existsSync(CRASHLOG_PATH)) return;
    // Windows renameSync fails if the destination exists — clear any older .prev first.
    fs.rmSync(CRASHLOG_PREV_PATH, { force: true });
    fs.renameSync(CRASHLOG_PATH, CRASHLOG_PREV_PATH);
  } catch {
    /* best-effort: a failed rotation must never gate boot — fall through, the worst case is a clobber */
  }
}

/**
 * @decision 43b232ff — tolerates node-pty's ConPTY `kill()` race (microsoft/node-pty#952); see the
 * record for why. BOTH conditions below are REQUIRED (either alone is unsafe) and both strings are
 * V8/source-map implementation details, not a stable contract — `test/crashlog.mjs`'s "nodepty-race" polices drift.
 */
function isNodePtyConsoleListRace(reason: unknown): boolean {
  if (!(reason instanceof TypeError)) return false;
  if (!/Cannot read properties of undefined \(reading 'forEach'\)/.test(reason.message)) return false;
  return /\n\s*at .*windowsPtyAgent\./.test(reason.stack ?? "");
}

/**
 * Install the top-level fatal-exit handlers. Wired ONCE at the daemon entrypoint:
 * - `uncaughtException` / `unhandledRejection` — write the crashlog, then `process.exit(1)`. With a
 *   handler attached Node no longer self-terminates, so we MUST exit to preserve the default fatal code.
 * - `exit` (synchronous backstop) — catches any OTHER non-zero death (a stray `process.exit(1)`, the
 *   `main()` startup-failure path) that didn't route through the handlers above. A clean stop (exit 0,
 *   the graceful path) and the intentional restart sentinel (75) are NOT crashes, so they are skipped.
 * Idempotent: a second call is a no-op.
 *
 * @decision d671f1b8 — uncaughtException/unhandledRejection deliberately do NOT run gracefulShutdown's
 * shared shutdown-cleanup (only the exit-75 restart path does); a crash here leaves any unflushed vault
 * edit pending until a human re-runs the daemon (no supervisor auto-relaunch on crash).
 *
 * @decision sha:8ced1ce2 — a bounded flush here was considered and rejected: a timed-out `git add -A`
 * abandons the real git.exe child (which keeps holding `.git/index.lock`) rather than stopping it, and
 * crash paths already accept the deferred-commit cost since nothing auto-relaunches to race against.
 */
export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;

  // Rotate any crash.log from a PRIOR run to .prev BEFORE wiring the handlers below — so on the shipped
  // (supervisor-less) path a crash→auto-restart preserves the previous signature instead of clobbering it.
  rotateCrashlog();

  process.on("uncaughtException", (err) => {
    // Attaching a listener SUPPRESSES Node's default stderr stack-print, so log it ourselves FIRST —
    // the crashlog COMPLEMENTS the console/LOGS_DIR trace, it doesn't replace it. console.error won't
    // throw, but keep it inside the no-throw spirit of the handler regardless.
    console.error("[crashlog] fatal uncaughtException:", err);
    writeCrashlog({ kind: "uncaughtException", error: err });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    if (isNodePtyConsoleListRace(reason)) {
      // Recognized, expected, non-fatal — see isNodePtyConsoleListRace's doc. Log loudly (this is a
      // tolerance, not a silence) and keep running; do NOT write a crashlog or exit.
      console.error(
        "[crashlog] tolerated known node-pty ConPTY kill() race (microsoft/node-pty#952) — " +
          "console-process sweep skipped this teardown, reapOrphanedDescendants backstops it; daemon continues:",
        reason,
      );
      return;
    }
    console.error("[crashlog] fatal unhandledRejection:", reason);
    writeCrashlog({ kind: "unhandledRejection", error: reason });
    process.exit(1);
  });
  process.on("exit", (code) => {
    if (code !== 0 && code !== RESTART_EXIT_CODE) writeCrashlog({ kind: "exit", exitCode: code });
  });
}
