import fs from "node:fs";
import path from "node:path";
import { LOOM_HOME } from "./paths.js";

// A signal-driven daemon stop (SIGINT/SIGTERM/SIGHUP — the machine sleeping, a terminal tearing down, a
// service manager stopping the process) already runs the graceful-shutdown path in index.ts, but that
// path leaves NO durable trace of WHY it ran: crashlog.ts only fires on uncaughtException/
// unhandledRejection/a stray non-zero exit, and a signal stop exits 0 (clean, by design). The result:
// a signal stop while the owner was away is INDISTINGUISHABLE from a hard crash after the fact — this
// cost a whole session chasing a phantom crash that was really the machine sleeping. This module writes
// a durable marker recording the actual reason, so a future stop is instantly classifiable.

/**
 * The last-shutdown marker. Lives under LOOM_HOME (resolved via the paths helper — never hardcode
 * `~/.loom`), alongside crash.log and restart-intent.json — together the three files that classify ANY
 * daemon stop: this marker (signal / intentional graceful stop), crash.log (an actual fatal), and
 * restart-intent.json (a `daemon_restart` deploy, exit 75). `.loom` is excluded from the vault
 * auto-committer, so writing here accrues no vault git history (mirrors crashlog.ts).
 */
export const LAST_SHUTDOWN_PATH = path.join(LOOM_HOME, "last-shutdown.json");

/**
 * Why the graceful-shutdown path ran. `"signal"` = an OS signal (SIGINT/SIGTERM/SIGHUP) hit the process
 * unexpectedly — the owner was likely away, or something else killed the process group. `"intentional"`
 * = a deliberate, owner-initiated stop (the loopback POST /internal/shutdown, i.e. `loom stop`) — this
 * must NOT be recorded as if it were an unexpected signal, so a future read can tell "the owner stopped
 * it" from "something killed it while nobody was watching".
 */
export type ShutdownKind = "signal" | "intentional";

export interface ShutdownMarkerInput {
  kind: ShutdownKind;
  /** The raw reason string passed to gracefulShutdown (e.g. "SIGINT" or "POST /internal/shutdown"). */
  reason: string;
  /** The actual OS signal name when kind is "signal"; null for an intentional stop. */
  signal?: string | null;
}

/**
 * Synchronously write ONE shutdown-reason record to {@link LAST_SHUTDOWN_PATH}. Called from a signal
 * handler / the graceful-shutdown path, both of which have limited time before the process dies — so
 * this MUST be synchronous, MUST be fast, and MUST NEVER throw (mirrors crashlog.ts's writeCrashlog).
 * Overwrites any prior marker (unlike the crashlog's write-once guard) — only the MOST RECENT shutdown
 * reason matters; there is no rotation/history need here.
 */
export function writeShutdownMarker(input: ShutdownMarkerInput): void {
  try {
    let ts: string;
    try { ts = new Date().toISOString(); } catch { ts = ""; }
    const record = {
      reason: input.kind,
      detail: input.reason,
      signal: input.signal ?? null,
      at: ts,
      pid: process.pid,
    };
    fs.mkdirSync(path.dirname(LAST_SHUTDOWN_PATH), { recursive: true });
    fs.writeFileSync(LAST_SHUTDOWN_PATH, JSON.stringify(record, null, 2) + "\n");
  } catch {
    /* the marker write must NEVER throw — a failed write is swallowed by design, same as crashlog.ts */
  }
}

/** The record shape {@link writeShutdownMarker} persists, as read back by {@link readAndClearShutdownMarker}. */
export interface ShutdownMarkerRecord {
  reason: ShutdownKind;
  detail: string;
  signal: string | null;
  at: string;
  pid: number;
}

/**
 * Read {@link LAST_SHUTDOWN_PATH} (if present) and DELETE it — consume-on-read. Boot-time crash recovery
 * (SessionService.recoverCrashOrphanedWorkers) calls this ONCE per boot, unconditionally, so a clean-stop
 * marker can never outlive the boot it was meant for and get misread as "clean" by a LATER, genuine crash
 * that happens to leave no new marker of its own (a stale marker must never survive to mislabel a real
 * crash). Never throws — mirrors the writer's swallow-all discipline; a read/delete fault just means the
 * caller treats this boot as an unclassified (crash-shaped) stop, the safe default.
 */
export function readAndClearShutdownMarker(): ShutdownMarkerRecord | null {
  try {
    const raw = fs.readFileSync(LAST_SHUTDOWN_PATH, "utf8");
    try { fs.unlinkSync(LAST_SHUTDOWN_PATH); } catch { /* best-effort delete — a leftover file just gets overwritten next stop */ }
    const parsed = JSON.parse(raw) as Partial<ShutdownMarkerRecord>;
    if (parsed.reason !== "signal" && parsed.reason !== "intentional") return null;
    return {
      reason: parsed.reason,
      detail: typeof parsed.detail === "string" ? parsed.detail : "",
      signal: typeof parsed.signal === "string" ? parsed.signal : null,
      at: typeof parsed.at === "string" ? parsed.at : "",
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
    };
  } catch {
    return null;
  }
}
