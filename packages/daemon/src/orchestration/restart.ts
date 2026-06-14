import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { SessionRole } from "@loom/shared";
import { LOOM_HOME } from "../paths.js";
import { writeJsonAtomic } from "../pty/claude-config.js";

const require = createRequire(import.meta.url);

/**
 * Absolute path to turbo's node entry (`turbo/bin/turbo`, a JS shim that execs the platform binary).
 * Resolving it lets buildDaemon run the build via `node <turbo>` with NO shell and NO reliance on
 * `pnpm`/`PATH` — the fragility that made the build fail with EMPTY output only inside the daemon's
 * spawned-process env (ticket 51522f05). Falls back to the conventional node_modules path.
 */
function turboBin(): string {
  try { return require.resolve("turbo/bin/turbo"); }
  catch { return path.join(repoRoot(), "node_modules", "turbo", "bin", "turbo"); }
}

/**
 * Self-host daemon restart support (the `daemon_restart` manager tool). Orchestrating Loom WITH Loom,
 * a manager that merges daemon-`src` worker branches can't see that code run until the daemon is
 * rebuilt + restarted — but restarting kills its own pty. This module is the coordination layer:
 *   - the daemon exits with RESTART_EXIT_CODE; the supervisor (scripts/daemon-supervisor.mjs)
 *     rebuilds and relaunches ONLY on that code;
 *   - a restart-intent file persists who to re-resume across the gap so boot can bring the manager
 *     (and its live workers) back and tell it the merged code is now live.
 * Only valid under the supervisor (LOOM_SUPERVISED=1) — otherwise nothing relaunches the daemon.
 */

/** Exit code that asks the supervisor to rebuild + relaunch. MUST match scripts/daemon-supervisor.mjs. */
export const RESTART_EXIT_CODE = 75;

const INTENT_PATH = path.join(LOOM_HOME, "restart-intent.json");

/**
 * One member of the live fleet to bring back on boot. The daemon is ONE process for ALL projects, so
 * a restart tears down every project's sessions — the resume set therefore spans all projects, each
 * entry carrying the identity needed to re-spawn it with the SAME role + lineage (a worker under its
 * manager). (P1 17df54c5 — was previously only the requesting manager's own flat workerSessionIds.)
 */
export interface RestartResumeEntry {
  sessionId: string;
  /** The session's orchestration role, re-passed on resume so its MCP surface comes back. null = plain. */
  role: SessionRole | null;
  /** For a worker, the manager that spawned it (preserves manager↔worker linkage across the restart). */
  parentSessionId: string | null;
}

export interface RestartIntent {
  reason: string;
  /**
   * The manager that REQUESTED the restart. It alone is re-prompted ("your merged code is now live —
   * continue/verify"); every OTHER captured session resumes as-is. Always present in `resume` too (it
   * is itself a live session) — this field only marks WHICH of them is the requester.
   */
  managerSessionId: string;
  /**
   * The FULL live fleet captured at restart time (every manager, worker, and plain/platform session
   * that was live, across ALL projects). Boot re-resumes each with its role + linkage and protects
   * each one's worktree from boot-reconcile GC. Absent on an OLD (pre-deploy) intent — boot then falls
   * back to {managerSessionId} + workerSessionIds for that one file (see resumeSetFromIntent).
   */
  resume?: RestartResumeEntry[];
  /**
   * @deprecated superseded by `resume` (P1 17df54c5). Retained ONLY so an OLD on-disk intent written by
   * a pre-deploy daemon still resumes the requester + its workers on the first boot after deploy.
   */
  workerSessionIds?: string[];
  /**
   * Per-session snapshot (sessionId → its in-memory pending inbound FIFO) taken at restart time, so the
   * undelivered queue survives the process death and is replayed on boot (index.ts) — the persisted
   * analogue of recycle's in-process carriedPending. Only non-empty FIFOs of resumed sessions are
   * included; absent when nothing was queued.
   */
  pending?: Record<string, string[]>;
  requestedAt: string;
}

/**
 * The fleet to resume, tolerant of BOTH the current shape (`resume`) and the OLD on-disk shape
 * (`workerSessionIds` only) — so the first boot after deploy reading a pre-deploy intent does NOT
 * crash; it degrades to today's behavior (the requester + its workers) for that one file.
 */
export function resumeSetFromIntent(intent: RestartIntent): RestartResumeEntry[] {
  if (intent.resume && intent.resume.length > 0) return intent.resume;
  // OLD-format fallback: synthesize the requester (manager) + its flat workers.
  const out: RestartResumeEntry[] = [
    { sessionId: intent.managerSessionId, role: "manager", parentSessionId: null },
  ];
  for (const w of intent.workerSessionIds ?? []) {
    out.push({ sessionId: w, role: "worker", parentSessionId: intent.managerSessionId });
  }
  return out;
}

/**
 * Every session id boot must PROTECT from reconcile worktree-GC — the whole resume set plus the
 * requester and any legacy workerSessionIds (belt-and-suspenders across both intent shapes). Boot
 * seeds `protectedSessionIds` from this so Pass B skips ALL their worktrees.
 */
export function protectedIdsFromIntent(intent: RestartIntent): Set<string> {
  const ids = new Set<string>(resumeSetFromIntent(intent).map((e) => e.sessionId));
  ids.add(intent.managerSessionId);
  for (const w of intent.workerSessionIds ?? []) ids.add(w);
  return ids;
}

/** True only when running under the restart supervisor — i.e. `daemon_restart` can safely relaunch. */
export function isSupervised(): boolean {
  return process.env.LOOM_SUPERVISED === "1";
}

export function writeRestartIntent(intent: RestartIntent): void {
  writeJsonAtomic(INTENT_PATH, intent);
}

/** Read the pending restart intent (consume with clearRestartIntent after acting on it). */
export function readRestartIntent(): RestartIntent | null {
  try {
    return JSON.parse(fs.readFileSync(INTENT_PATH, "utf8")) as RestartIntent;
  } catch {
    return null; // absent or unreadable → no pending restart
  }
}

export function clearRestartIntent(): void {
  try {
    fs.rmSync(INTENT_PATH, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Repo root, derived from this module's built location (dist/orchestration/restart.js → ../../../..). */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/**
 * Rebuild the daemon (shared + daemon via turbo) WHILE the current daemon is still running its
 * in-memory code, so a broken build aborts the restart and leaves the manager alive to fix it —
 * rather than exiting into a daemon that won't come back up. Resolves the exit code + a tail of
 * output for the failure message. Never throws (a spawn error resolves as a non-zero code).
 */
export function buildDaemon(): Promise<{ code: number; tail: string }> {
  return new Promise((resolve) => {
    const root = repoRoot();
    // Invoke turbo via ABSOLUTE node + ABSOLUTE turbo JS, NO shell. The old form
    // `spawn("pnpm exec turbo …", { shell:true })` relied on `pnpm`/`cmd`/`PATH` resolving inside the
    // daemon's spawned-process env — which failed reproducibly there with EMPTY captured output while
    // the same command was green in a shell (ticket 51522f05). process.execPath + turboBin() always
    // resolve, regardless of the daemon's PATH.
    //
    // `--force` bypasses turbo's cache so a deploy ALWAYS does a real compile. Without it, a content-
    // keyed cache HIT replays a prior build's logs (we saw it replay a *worker worktree's* build) and
    // restores a possibly-stale `dist` — the "ships old code / incomplete dist" half of 51522f05.
    // Build BOTH @loom/daemon AND @loom/web: the daemon serves the web bundle statically from
    // packages/web/dist, so a deploy that only rebuilt the daemon left the SERVED UI stale (a merged
    // web change never went live). The second filter rebuilds web in the same pass.
    const args = [turboBin(), "build", "--filter=@loom/daemon", "--filter=@loom/web", "--force"];
    const cmdStr = `${process.execPath} ${args.join(" ")}`;
    let out = "";
    const cap = (b: Buffer) => { out += b.toString(); if (out.length > 8000) out = out.slice(-8000); };
    const child = spawn(process.execPath, args, { cwd: root });
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    // NEVER resolve with an empty failure tail — the old `out.trim().slice(-1500)` could be "" when the
    // spawn env produced no output, leaving the manager an UNDEBUGGABLE "build failed: <empty>"
    // (exactly what 51522f05 hit). Always include the command, cwd, exit code/signal, and a marker when
    // no output was captured, so the real cause (e.g. a tsc error, or a concurrent edit) is visible.
    child.on("error", (e) =>
      resolve({ code: 1, tail: `daemon build could not start: ${e.message}\ncmd: ${cmdStr}\ncwd: ${root}\n${out}`.trim() }));
    child.on("close", (code, signal) => {
      if ((code ?? 1) === 0) { resolve({ code: 0, tail: out.trim().slice(-1500) }); return; }
      const captured = out.trim() ? out.trim().slice(-2500) : `(no build output captured)`;
      resolve({
        code: code ?? 1,
        tail: `daemon build FAILED (code=${code ?? "null"} signal=${signal ?? "none"})\ncmd: ${cmdStr}\ncwd: ${root}\n${captured}`,
      });
    });
  });
}
