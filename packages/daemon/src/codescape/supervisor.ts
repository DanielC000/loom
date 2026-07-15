import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { resolveConfig, type ProjectConfigOverride } from "@loom/shared";
import { CODESCAPE_HOME_DIR, isCodescapeSupervisorEnabled, isLoomDev, resolveCodescapeBin } from "../paths.js";

/**
 * Codescape fleet-daemon wiring epic (`369dde3c`), card C1 — FOUNDATION. Under `isCodescapeSupervisorEnabled()`
 * (isLoomDev() + LOOM_CODESCAPE_ENABLED=1, see paths.ts), Loom starts + supervises ONE `codescape serve`
 * process per host on a loopback port, bootstrapped by `codescape ingest <repoPath>` for each target
 * project BEFORE serve starts (v1: projects load from `.codescape/projects/index.json` at serve BOOT —
 * a project ingested after serve started isn't picked up until a restart).
 *
 * ★ CWD CONTRACT (load-bearing): both `ingest` and `serve` resolve their `.codescape` state dir relative
 * to `process.cwd()`. So EVERY spawn — ingest and serve alike — runs from the exact same `homeDir`
 * (default {@link CODESCAPE_HOME_DIR}, `<LOOM_HOME>/codescape`), or serve will never see what ingest
 * wrote. Never rely on the daemon's ambient cwd.
 *
 * Mirrors, cited:
 *   - Async best-effort subprocess discipline (spawn not spawnSync, bounded, ~4KB output tail, never
 *     throws) — `python/venv.ts` `runAsync` (120-153) / `ensurePythonPackageAsync` (240-271).
 *   - Absolute/PATH binary resolution + the node-invocation special case for a JS entrypoint —
 *     `pty/resolve-bin.ts` `resolveExecutable`.
 *   - "Broken stays visibly down, never crash-loop" restart ethos — `scripts/daemon-supervisor.mjs`
 *     (its OUTER daemon-process supervision only restarts on an explicit sentinel; this INNER supervisor
 *     restarts on any death but gives up — and STAYS down — after a bounded number of attempts).
 *   - Boot singleton (gated, logs state) — `index.ts:680-692` Scheduler.
 *
 * Every method here is Loom-internal only — never registered on any agent MCP router (C1 is pure daemon
 * plumbing; C2/C3 wire the per-session MCP entry and the lifecycle hooks that call these methods).
 */

/** Cap (bytes) on the captured stdout+stderr tail kept for diagnostics — a bounded ring, mirrors OUTPUT_TAIL_BYTES in python/venv.ts. */
const OUTPUT_TAIL_BYTES = 4096;

/** Bound (ms) for `codescape ingest <repoPath>` — a big repo's initial graph build can take a while. */
const DEFAULT_INGEST_TIMEOUT_MS = 120_000;
/** Bound (ms) for the fast control-plane calls (register/drop/overlay). */
const DEFAULT_REGISTER_TIMEOUT_MS = 10_000;
/** Bound (ms) for reingest-main — CONTRACT: needs a client timeout >=30s (blocks ~9-11s + serializes). */
const DEFAULT_REINGEST_TIMEOUT_MS = 45_000;
/**
 * Bounded backoff (ms) between restart attempts after `serve` dies — increasing, never a tight loop.
 * Exhausting the array without a "healthy run" resetting it (see `healthyRunMs`) means the supervisor
 * gives up: `getPort()` reports null and stays that way ("broken stays visibly down") until a fresh
 * `start()`.
 */
const DEFAULT_RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
/** A `serve` that ran at least this long before dying is treated as a fresh failure — resets the backoff. */
const DEFAULT_HEALTHY_RUN_MS = 30_000;

export interface CodescapeSupervisorOpts {
  /** The shared ingest+serve cwd (the CWD CONTRACT). Default {@link CODESCAPE_HOME_DIR}. Test seam. */
  homeDir?: string;
  /** Test seam: a fast backoff schedule so a restart-on-death test doesn't wait real minutes. */
  restartBackoffMs?: number[];
  /** Test seam: shrink the "was this a healthy run" threshold. */
  healthyRunMs?: number;
  ingestTimeoutMs?: number;
  registerTimeoutMs?: number;
  reingestTimeoutMs?: number;
  /**
   * Test-only seam: pre-seed a live port (and mark `alive`) WITHOUT spawning anything, so the
   * control-plane client methods can be exercised hermetically against a fake HTTP server.
   */
  port?: number;
}

export interface CodescapeRequestResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Result shape of {@link CodescapeSupervisor.ingest}. */
export interface CodescapeIngestResult {
  ok: boolean;
  outcome: "ready" | "failed" | "timeout";
  errorTail?: string;
}

/** What {@link runBounded} resolves — mirrors python/venv.ts's RunResult (never rejects). */
interface RunResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  output: string;
}

/**
 * Run a child process to completion ASYNCHRONOUSLY, resolving a {@link RunResult}. NEVER rejects — a
 * spawn error, non-zero exit, or timeout all resolve `ok:false`. Captures a bounded stdout+stderr tail
 * for diagnostics. Mirrors `python/venv.ts`'s `runAsync` (a fresh copy: different subsystem, same
 * discipline — spawn not spawnSync, bounded, never throws).
 */
function runBounded(command: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const capture = (b: Buffer): void => {
      chunks.push(b);
      bytes += b.length;
      while (bytes > OUTPUT_TAIL_BYTES && chunks.length > 1) bytes -= chunks.shift()!.length;
    };
    const tail = (): string => {
      const s = Buffer.concat(chunks).toString("utf-8").trim();
      return s.length > OUTPUT_TAIL_BYTES ? s.slice(-OUTPUT_TAIL_BYTES) : s;
    };
    const finish = (ok: boolean, code: number | null): void => {
      if (!settled) { settled = true; resolve({ ok, code, timedOut, output: tail() }); }
    };
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish(false, null);
      return;
    }
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* noop */ } finish(false, null); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); finish(false, null); });
    child.on("exit", (code) => { clearTimeout(timer); finish(code === 0, code); });
  });
}

/** Pick a free loopback port by binding ephemeral (`:0`) then releasing it. Async — never blocks. */
function pickLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : null;
      srv.close(() => {
        if (port) resolve(port); else reject(new Error("could not determine a free loopback port"));
      });
    });
  });
}

/** The narrow project shape {@link codescapeBootRepoPaths} needs — kept structural so a test can fake it
 *  with plain objects, no real Db. */
export interface CodescapeBootProject {
  repoPath: string;
  config?: ProjectConfigOverride;
}

/**
 * CR fix (blocker 1): which projects' repoPaths the daemon should feed into `start()`'s ingest loop at
 * boot. Without this, `start()` was always called with `[]` — `codescape serve` boots with an EMPTY
 * project index (v1 has no runtime registration; see the CWD CONTRACT doc above), so every one of the 7
 * read tools silently returns empty even on a project with `codescape.enabled` on. A project qualifies
 * iff its RESOLVED `codescape.enabled` flag is true; the daemon-wide `isCodescapeSupervisorEnabled()` gate
 * is `start()`'s own concern (it no-ops before ever looking at repoPaths when disabled), so this stays a
 * pure, project-only filter — hermetically testable with plain objects, no live git/db/supervisor.
 */
export function codescapeBootRepoPaths(projects: CodescapeBootProject[]): string[] {
  return projects.filter((p) => resolveConfig(p.config).codescape.enabled).map((p) => p.repoPath);
}

export class CodescapeSupervisor {
  private readonly homeDir: string;
  private readonly restartBackoffMs: number[];
  private readonly healthyRunMs: number;
  private readonly ingestTimeoutMs: number;
  private readonly registerTimeoutMs: number;
  private readonly reingestTimeoutMs: number;

  private port: number | null = null;
  /** True once `serve` has actually been spawned and hasn't since exited/errored. Distinct from `port`
   *  (which is reserved up-front and reused across a restart-on-death) — getPort() gates on this. */
  private alive = false;
  private child: ChildProcess | null = null;
  /** True before the first start() and after an explicit stop() — suppresses restart-on-death. */
  private stopped = true;
  private starting = false;
  private spawnedAt: number | null = null;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts?: CodescapeSupervisorOpts) {
    this.homeDir = opts?.homeDir ?? CODESCAPE_HOME_DIR;
    this.restartBackoffMs = opts?.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this.healthyRunMs = opts?.healthyRunMs ?? DEFAULT_HEALTHY_RUN_MS;
    this.ingestTimeoutMs = opts?.ingestTimeoutMs ?? DEFAULT_INGEST_TIMEOUT_MS;
    this.registerTimeoutMs = opts?.registerTimeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS;
    this.reingestTimeoutMs = opts?.reingestTimeoutMs ?? DEFAULT_REINGEST_TIMEOUT_MS;
    if (opts?.port != null) {
      // Test-only: exercise the control-plane client against a fake HTTP server with no real spawn.
      this.port = opts.port;
      this.alive = true;
    }
  }

  /** The live loopback port, or null when not running (disabled, never started, mid-restart, or gave up). */
  getPort(): number | null {
    return this.alive ? this.port : null;
  }

  /** The live child's PID, or null when not running. Diagnostic / test seam. */
  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * Run `codescape ingest <repoPath>` from the shared `homeDir` (creating it if absent). Async, bounded,
   * NEVER throws — a failure is logged + reflected in the returned outcome, never escapes. Public so a
   * caller (index.ts boot, and later C2/C3 onboarding a newly-enabled project) can ingest independently
   * of `start()`'s own bootstrap loop.
   */
  async ingest(repoPath: string): Promise<CodescapeIngestResult> {
    if (!isCodescapeSupervisorEnabled()) {
      // Silent skip (no warn — the "missing" reason here is the gate itself, not a real failure). CR
      // fix: ingest() is public and callable
      // independently of start() (C2/C3's "onboard a newly-enabled project" path) — it must NEVER create
      // CODESCAPE_HOME_DIR (or spawn anything) on a disabled daemon, matching start()'s own zero-side-effects
      // guarantee.
      return { ok: false, outcome: "failed", errorTail: "codescape supervisor is disabled (needs isLoomDev() + LOOM_CODESCAPE_ENABLED=1)" };
    }
    fs.mkdirSync(this.homeDir, { recursive: true });
    const { command, args } = resolveCodescapeBin();
    const r = await runBounded(command, [...args, "ingest", repoPath], this.homeDir, this.ingestTimeoutMs);
    if (!r.ok) {
      console.warn(`[codescape] ingest ${repoPath} ${r.timedOut ? "timed out" : `failed (exit ${r.code})`}${r.output ? ` — ${r.output}` : ""}`);
    }
    return { ok: r.ok, outcome: r.ok ? "ready" : r.timedOut ? "timeout" : "failed", errorTail: r.output || undefined };
  }

  /**
   * Card C2/C3 rewrite (`369dde3c`, card e068a2ab): ingest `repoPath` straight to an explicit `graphPath`
   * (`codescape ingest <repoPath> --out <graphPath>`) — the file the per-session stdio MCP
   * (`pty/host.ts` `codescapeMcpServer`) reads via `codescape mcp --graph <graphPath>`. DECOUPLED from
   * the shared `serve`'s own `.codescape/projects/index.json` bookkeeping that {@link ingest} (no `--out`)
   * feeds — this is the sole write path for the agent-read graph, independent of whether `serve` is
   * running at all. Same async/bounded/never-throws discipline as {@link ingest}: gated on
   * `isCodescapeSupervisorEnabled()` (the daemon-wide LOOM_CODESCAPE_ENABLED master switch — still the
   * gate for the whole feature, not just the optional shared `serve` process), still runs from the
   * shared `homeDir` (the CWD CONTRACT, even though `--out` itself is an absolute/caller-given path —
   * consistency with every other codescape invocation, and ingest may still touch its own cwd-relative
   * `.codescape/projects/index.json` bookkeeping as a side effect), creates `graphPath`'s parent dir
   * first (a fresh `<LOOM_HOME>/codescape/<projectId>/` may not exist yet).
   */
  async ingestToGraph(repoPath: string, graphPath: string): Promise<CodescapeIngestResult> {
    if (!isCodescapeSupervisorEnabled()) {
      return { ok: false, outcome: "failed", errorTail: "codescape supervisor is disabled (needs isLoomDev() + LOOM_CODESCAPE_ENABLED=1)" };
    }
    fs.mkdirSync(this.homeDir, { recursive: true });
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    const { command, args } = resolveCodescapeBin();
    const r = await runBounded(command, [...args, "ingest", repoPath, "--out", graphPath], this.homeDir, this.ingestTimeoutMs);
    if (!r.ok) {
      console.warn(`[codescape] ingest ${repoPath} --out ${graphPath} ${r.timedOut ? "timed out" : `failed (exit ${r.code})`}${r.output ? ` — ${r.output}` : ""}`);
    }
    return { ok: r.ok, outcome: r.ok ? "ready" : r.timedOut ? "timeout" : "failed", errorTail: r.output || undefined };
  }

  /**
   * Start supervision: no-op (a) when disabled (`isCodescapeSupervisorEnabled()` false — the negative
   * case), or (b) when already running/starting. Ingests each of `repoPaths` in order (v1 bootstrap —
   * see the CWD CONTRACT note above), reserves a loopback port, then spawns + supervises `serve`. Async,
   * best-effort: an ingest failure is logged and does NOT abort the boot — serve still starts (an empty
   * or stale project index there is a Codescape-side concern, not a reason to leave serve down).
   */
  async start(repoPaths: string[] = []): Promise<void> {
    if (this.starting || this.child) return;
    if (!isCodescapeSupervisorEnabled()) {
      // isLoomDev()-gated: a regular (non-dev) end user never sees a reference to this unshipped,
      // LOOM_DEV-only feature at every boot — only a LOOM_DEV=1 dev build without LOOM_CODESCAPE_ENABLED
      // (the "off but could be on" case) gets the reminder.
      if (isLoomDev()) console.log("[boot] codescape off (set LOOM_DEV=1 and LOOM_CODESCAPE_ENABLED=1 to enable fleet-daemon supervision)");
      return;
    }
    this.starting = true;
    this.stopped = false;
    try {
      fs.mkdirSync(this.homeDir, { recursive: true });
      for (const repoPath of repoPaths) {
        await this.ingest(repoPath);
      }
      if (this.port == null) this.port = await pickLoopbackPort();
      this.restartAttempts = 0;
      this.spawnServe();
      console.log(`[boot] codescape serve starting (port ${this.port}, cwd ${this.homeDir}, ${repoPaths.length} project(s) ingested)`);
    } catch (err) {
      console.warn(`[codescape] start failed (continuing boot): ${(err as Error).message}`);
    } finally {
      this.starting = false;
    }
  }

  /** Stop supervision: kills the live child (if any), cancels any pending restart, and disarms restart-on-death. */
  stop(): void {
    this.stopped = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.child) {
      try { this.child.kill(); } catch { /* best-effort */ }
      this.child = null;
    }
    this.alive = false;
    this.port = null;
  }

  /**
   * Spawn `serve` on the reserved port and wire up restart-on-death. Never throws — BOTH a synchronous
   * spawn failure (thrown from `spawn()` itself) and an asynchronous one (Node's `'error'` event, e.g.
   * ENOENT on a bad `LOOM_CODESCAPE_BIN` — the single most likely real dev failure) are treated as a
   * death: `this.child`/`alive` are cleared and a bounded restart is scheduled. This matters because per
   * Node's own child_process docs, `'error'` and `'exit'` are NOT mutually exclusive — `'exit'` may or
   * may not follow an `'error'` (platform-dependent, esp. on Windows) — so restart-on-death cannot be
   * wired off `'exit'` alone: a spawn that only ever errors would otherwise wedge phantom-alive forever
   * (`getPort()` lying about a serve that never started, and `start()`'s `this.child` guard blocking even
   * a manual recovery attempt) with the give-up diagnostic never firing (CR finding, spawn-FAILURE bug).
   */
  private spawnServe(): void {
    if (this.stopped || this.port == null) return;
    const { command, args: baseArgs } = resolveCodescapeBin();
    const args = [...baseArgs, "serve", "--port", String(this.port)];
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: this.homeDir, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      console.warn(`[codescape] serve spawn failed: ${(err as Error).message}`);
      // Never a "healthy" run — a synchronous throw means no child ever came up. Clearing spawnedAt (it
      // may still hold a PRIOR successful spawn's timestamp) stops that stale value from making an
      // immediate, repeated failure look "healthy" to scheduleRestart's caller below (CR bug (b)).
      this.spawnedAt = null;
      this.scheduleRestart(false);
      return;
    }
    this.child = child;
    this.alive = true;
    this.spawnedAt = Date.now();
    const chunks: Buffer[] = [];
    let bytes = 0;
    const capture = (b: Buffer): void => {
      chunks.push(b);
      bytes += b.length;
      while (bytes > OUTPUT_TAIL_BYTES && chunks.length > 1) bytes -= chunks.shift()!.length;
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    // `settled` guards against 'error' and 'exit' BOTH firing for the same death (Node's docs warn this
    // can happen) — without it a double-fire would double-schedule a restart / double-decrement state.
    let settled = false;
    const onDeath = (reason: string): void => {
      if (settled) return;
      settled = true;
      // Evaluate "did THIS run last long enough to count as healthy" against the timestamp THIS spawn
      // set above, BEFORE clearing it — scheduleRestart no longer reads this.spawnedAt itself (that was
      // the staleness trap: a failure path that never reached the assignment above left the PRIOR run's
      // timestamp in place, so every subsequent failure looked "healthy" forever).
      const ranHealthy = this.spawnedAt !== null && Date.now() - this.spawnedAt >= this.healthyRunMs;
      this.child = null;
      this.alive = false;
      this.spawnedAt = null;
      if (this.stopped) return; // an explicit stop() — not a death, no restart
      const tail = Buffer.concat(chunks).toString("utf-8").trim().slice(-OUTPUT_TAIL_BYTES);
      console.warn(`[codescape] serve ${reason} — scheduling restart${tail ? `\n${tail}` : ""}`);
      this.scheduleRestart(ranHealthy);
    };
    child.on("error", (err) => onDeath(`process error: ${err.message}`));
    child.on("exit", (code, signal) => onDeath(`exited (code ${code ?? "null"}, signal ${signal ?? "null"})`));
  }

  /** Schedule a bounded-backoff restart; `ranHealthy` (computed by the caller, which alone knows whether
   *  THIS attempt ever came up) resets the backoff schedule. Gives up (stays down, logs loudly) once the
   *  backoff schedule is exhausted without a healthy run resetting it in between. */
  private scheduleRestart(ranHealthy: boolean): void {
    if (this.stopped) return;
    if (ranHealthy) this.restartAttempts = 0;
    if (this.restartAttempts >= this.restartBackoffMs.length) {
      console.error(`[codescape] gave up after ${this.restartAttempts} restart attempt(s) — codescape serve is DOWN (check LOOM_CODESCAPE_BIN / the codescape install; needs a human)`);
      this.port = null;
      return;
    }
    const delay = this.restartBackoffMs[this.restartAttempts];
    this.restartAttempts++;
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.spawnServe(); }, delay);
  }

  /** Bounded, best-effort loopback POST/DELETE to the running `serve` — NEVER throws; resolves `ok:false`
   *  immediately (no fetch attempted) when there's no live port. Loom-internal only. */
  private async request(method: string, urlPath: string, body: unknown, timeoutMs: number): Promise<CodescapeRequestResult> {
    const port = this.getPort();
    if (port == null) return { ok: false, error: "codescape not running" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** `POST /project/<id>/worktree` — register a newly-spawned worker/manager worktree. */
  async registerWorktree(projectId: string, info: { worktreeId: string; path: string; baseRef: string }): Promise<CodescapeRequestResult> {
    return this.request("POST", `/project/${encodeURIComponent(projectId)}/worktree`, info, this.registerTimeoutMs);
  }

  /** `POST /project/<id>/reingest-main` — bounded at >=30s per CONTRACT (blocks ~9-11s + serializes). */
  async reingestMain(projectId: string): Promise<CodescapeRequestResult> {
    return this.request("POST", `/project/${encodeURIComponent(projectId)}/reingest-main`, undefined, this.reingestTimeoutMs);
  }

  /** `DELETE /project/<id>/worktree/<worktreeId>` — deregister a worktree that's been removed/merged. */
  async dropWorktree(projectId: string, worktreeId: string): Promise<CodescapeRequestResult> {
    return this.request("DELETE", `/project/${encodeURIComponent(projectId)}/worktree/${encodeURIComponent(worktreeId)}`, undefined, this.registerTimeoutMs);
  }

  /** `POST /project/<id>/worktree/<worktreeId>/overlay` — C4 (optional, low priority): on-demand divergence overlay. */
  async overlay(projectId: string, worktreeId: string): Promise<CodescapeRequestResult> {
    return this.request("POST", `/project/${encodeURIComponent(projectId)}/worktree/${encodeURIComponent(worktreeId)}/overlay`, undefined, this.registerTimeoutMs);
  }
}
