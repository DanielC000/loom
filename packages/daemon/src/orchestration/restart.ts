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
 * Bound the deploy-time `pnpm install` so a hung registry fetch can't wedge the restart while the
 * daemon waits on the build (mirrors PROVISION_TIMEOUT_MS in git/worktrees.ts). The build itself is
 * left UNBOUNDED — a real tsc compile can legitimately run long and has no interactive-hang vector.
 */
const DEPLOY_INSTALL_TIMEOUT_MS = 180_000;

/**
 * One ordered step of a deploy build. `shell` selects the spawn form: shell:true runs `command` through
 * the OS shell (PATH-resolves `pnpm`, exactly like the worktree provisioner + the merge-gate runner);
 * shell:false execs `command` with `args` directly — NO shell, NO PATH reliance — the 51522f05-proof
 * turbo invocation. Exported (with {@link deployBuildSteps}) so a hermetic test can assert the exact
 * commands + flags WITHOUT spawning anything.
 */
export interface BuildStep {
  label: "install" | "build";
  command: string;
  args: string[];
  shell: boolean;
  /** Kill the child past this many ms; 0 = unbounded. */
  timeoutMs: number;
}

/**
 * The exact, ordered steps a daemon deploy runs — as DATA, so a regression test can prove the gate's
 * integrity without running a real build. STEP 1 installs (closes face B), STEP 2 force-builds (closes
 * face A). Both faces let a BROKEN/STALE main pass the deploy gate green; see each step's note.
 */
export function deployBuildSteps(root: string): BuildStep[] {
  return [
    // STEP 1 — INSTALL (closes face B: a merged dep-add that was never linked). daemon_restart used to
    // jump straight to the build, so a merge that ADDED a dependency (package.json + pnpm-lock.yaml)
    // compiled against a node_modules that still lacked it → the deploy build couldn't resolve the new
    // import and failed (the "daemon_restart never installs" gap — buildDaemon's repoRoot is the MAIN
    // checkout, whose node_modules is otherwise only ever installed by hand / the supervisor's cold boot).
    // `--frozen-lockfile` makes the deploy REPRODUCIBLE + FAIL-CLOSED: it installs exactly the committed
    // lockfile and ABORTS (rather than silently mutating the tree) if package.json drifted from the
    // lockfile — surfacing a half-committed dep-add instead of masking it. A near no-op when already in
    // sync, so a normal code-only deploy pays only a quick verify. CI=1 keeps pnpm non-interactive.
    { label: "install", command: "pnpm install --frozen-lockfile --prefer-offline", args: [], shell: true, timeoutMs: DEPLOY_INSTALL_TIMEOUT_MS },
    // STEP 2 — BUILD (closes face A: a stale FULL TURBO cache replaying a green build over broken/stale
    // source). Invoke turbo via ABSOLUTE node + ABSOLUTE turbo JS, NO shell — the 51522f05 fix (the old
    // `pnpm exec turbo …` form failed inside the daemon's spawned-process env with EMPTY captured output).
    // `--force` is a DIRECT turbo argument here (`node <turbo> build … --force`), which is what actually
    // bypasses turbo's content-keyed cache so a deploy ALWAYS does a real compile. ⚠️ Do NOT "simplify"
    // this to `pnpm --filter @loom/web build --force`: there `--force` is forwarded to the package's build
    // SCRIPT (vite), NOT to turbo, so the cache is NOT defeated and a stale build replays green (the
    // aad5fff3 footgun). Build BOTH @loom/daemon AND @loom/web — the daemon serves packages/web/dist
    // statically, so a deploy that only rebuilt the daemon left the SERVED UI stale.
    { label: "build", command: process.execPath, args: [turboBin(), "build", "--filter=@loom/daemon", "--filter=@loom/web", "--force"], shell: false, timeoutMs: 0 },
  ];
}

/** Real, bounded, never-throws runner for one {@link BuildStep}. Resolves {code, out}; a spawn error or
 * timeout-kill resolves as a non-zero code (never rejects), so buildDaemon's loop stays simple. */
function runBuildStep(step: BuildStep, cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    const cap = (b: Buffer) => { out += b.toString(); if (out.length > 8000) out = out.slice(-8000); };
    const child = step.shell
      ? spawn(step.command, { cwd, shell: true, env: { ...process.env, CI: "1" } })
      : spawn(step.command, step.args, { cwd });
    let settled = false;
    const done = (r: { code: number; out: string }) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(r); };
    const timer = step.timeoutMs > 0
      ? setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } done({ code: 1, out: `${out}\n(${step.label} exceeded ${step.timeoutMs}ms — killed)` }); }, step.timeoutMs)
      : undefined;
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    child.on("error", (e) => done({ code: 1, out: `${out}\n${step.label} could not start: ${e.message}` }));
    child.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

/** Injectable seam for {@link buildDaemon} — a test swaps in a fake runner to record the steps + force
 * results (prove install→build order, the --force/--frozen-lockfile flags, and install-fail short-circuit)
 * without a real spawn. Defaults to {@link runBuildStep}. */
export interface BuildDeps {
  runStep?: (step: BuildStep, cwd: string) => Promise<{ code: number; out: string }>;
}

/**
 * Rebuild the daemon for a deploy (the `daemon_restart` tool) WHILE the current daemon still runs its
 * in-memory code, so a broken/incomplete deploy aborts the restart and leaves the manager alive to fix
 * it — rather than exiting into a daemon that won't come back up. Runs {@link deployBuildSteps} IN ORDER
 * and SHORT-CIRCUITS on the first non-zero step (a failed install never reaches the build). Resolves the
 * exit code + a tail of output for the failure message; never throws (a spawn error → a non-zero code).
 */
export function buildDaemon(deps: BuildDeps = {}): Promise<{ code: number; tail: string }> {
  const root = repoRoot();
  const run = deps.runStep ?? runBuildStep;
  return (async () => {
    let lastOut = "";
    for (const step of deployBuildSteps(root)) {
      const r = await run(step, root);
      lastOut = r.out;
      if (r.code === 0) continue;
      // NEVER resolve with an empty failure tail — an empty spawn-env output would otherwise leave the
      // manager an UNDEBUGGABLE "build failed: <empty>" (exactly what 51522f05 hit). Always include the
      // command, cwd, exit code, and a marker when no output was captured.
      const captured = r.out.trim() ? r.out.trim().slice(-2500) : `(no ${step.label} output captured)`;
      const cmdStr = step.shell ? step.command : `${step.command} ${step.args.join(" ")}`;
      const hint = step.label === "install"
        ? "\nA merged package.json/lockfile change is likely out of sync — commit the updated pnpm-lock.yaml (or run `pnpm install` on main), then retry."
        : "";
      return { code: r.code, tail: `daemon ${step.label} FAILED (code=${r.code})\ncmd: ${cmdStr}\ncwd: ${root}${hint}\n${captured}`.trim() };
    }
    return { code: 0, tail: lastOut.trim().slice(-1500) };
  })();
}
