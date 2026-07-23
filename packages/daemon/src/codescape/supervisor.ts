import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { resolveCodescapeConfig, type ProjectConfigOverride } from "@loom/shared";
import { CODESCAPE_HOME_DIR, isCodescapeSupervisorEnabled, isLoomDev, resolveCodescapeBin, codescapeBinCandidate } from "../paths.js";
import { resolveCodescapeProjectId } from "./manifest.js";

/**
 * Codescape fleet-daemon wiring epic (`369dde3c`), card C1 — FOUNDATION, updated by card 503a30a0. Under
 * `isCodescapeSupervisorEnabled()` (isLoomDev() + a codescape CLI actually detected on the host — see
 * paths.ts; codescape is a private internal tool, so this is a non-discoverable, config/host-driven gate,
 * not a hand-set env toggle), Loom starts + supervises ONE `codescape serve` process per host on a
 * loopback port, bootstrapped by `codescape ingest <repoPath>` for each target project BEFORE serve starts
 * (v1: projects load from `.codescape/projects/index.json` at serve BOOT — a project ingested after serve
 * started isn't picked up until a restart).
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
/**
 * CR follow-up (card 088afc94): how long a `resolveProjectId` MISS (no in-memory cache entry, no manifest
 * entry either) is remembered before the next call is allowed to re-read the manifest. Without this, a
 * repo that boot registration never covered (a project created, or `codescape.enabled` toggled on, after
 * boot — a case the code explicitly advertises as needing no restart) re-runs a synchronous
 * `readFileSync`+`JSON.parse` on the SPAWN HOT PATH on EVERY call, forever — `CLAUDE.md` pins that path to
 * no blocking work. Bounded TTL (not a permanent negative cache, unlike a resolved HIT which never
 * changes): the tradeoff is a newly-ingested repo can take up to this long to be picked up here instead of
 * showing up on the very next spawn — acceptable, since ingestion itself already takes far longer than this.
 */
const PROJECT_ID_NEGATIVE_CACHE_TTL_MS = 30_000;

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
  /** Test seam: shrink {@link PROJECT_ID_NEGATIVE_CACHE_TTL_MS} so an expiry test doesn't wait 30 real seconds. */
  negativeCacheTtlMs?: number;
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
  /** Parsed JSON response body, when the response carried one. Most control-plane calls ignore this
   *  (fire-and-forget); {@link CodescapeSupervisor.registerProject} reads it for the resolved `id`/`mode`. */
  json?: unknown;
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

/**
 * Nitpick fix (card 088afc94): normalize a repo path for use as a `projectIds`/`unresolvedProjectIds` map
 * key. Resolved + lowercased — mirrors `codescape/manifest.ts`'s `samePath` (itself mirroring codescape's
 * own `projectIdFor`: "Windows paths are case-insensitive"), so this instance's own cache can't miss a hit
 * the manifest fallback would have found purely over case, even though no live caller is known to differ
 * today.
 */
function repoKey(repoRoot: string): string {
  return path.resolve(repoRoot).toLowerCase();
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
  return projects.filter((p) => resolveCodescapeConfig(p.config).enabled).map((p) => p.repoPath);
}

export class CodescapeSupervisor {
  private readonly homeDir: string;
  private readonly restartBackoffMs: number[];
  private readonly healthyRunMs: number;
  private readonly ingestTimeoutMs: number;
  private readonly registerTimeoutMs: number;
  private readonly reingestTimeoutMs: number;
  private readonly negativeCacheTtlMs: number;

  /**
   * Card b8de5876: the DB-persisted `integrations.codescape.path` override, threaded in by {@link start}
   * and remembered for the lifetime of this instance — {@link ingest}, {@link spawnServe} (including a
   * later restart-on-death, which runs long after `start()`'s own call stack has returned), and every
   * `isCodescapeSupervisorEnabled`/`resolveCodescapeBin`/`codescapeBinCandidate` check this class makes
   * all read it from here, so the boot gate and the actual spawn agree on the SAME candidate instead of
   * the gate checking one path and the spawn silently trying another. `undefined` when `start()` was
   * called with no dbPath (or never called at all) — every resolver already treats that as "fall back to
   * `LOOM_CODESCAPE_BIN` / the bare PATH name", unchanged from before this field existed.
   */
  private codescapePath: string | undefined;

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
  /**
   * Card 088afc94 P4 follow-up: codescape's OWN authoritative project id, cached per NORMALIZED (resolved
   * + lowercased — see {@link repoKey}) repoRoot once {@link registerProject} succeeds OR a manifest read
   * inside {@link resolveProjectId} hits — the fast path resolveProjectId checks before ever falling back
   * to a cold manifest-by-path read. In-memory only (never persisted here — codescape's OWN manifest file
   * is the durable record; this is purely a per-process cache to avoid re-reading that file on every lookup
   * once a repo's id is already known this boot).
   */
  private readonly projectIds = new Map<string, string>();
  /**
   * CR follow-up: a bounded-TTL negative cache — see {@link PROJECT_ID_NEGATIVE_CACHE_TTL_MS} for why a
   * MISS needs remembering too, not just a HIT. Keyed the same as {@link projectIds}; value is the epoch ms
   * after which the entry expires and the next lookup is allowed to re-read the manifest.
   */
  private readonly unresolvedProjectIds = new Map<string, number>();

  constructor(opts?: CodescapeSupervisorOpts) {
    this.homeDir = opts?.homeDir ?? CODESCAPE_HOME_DIR;
    this.restartBackoffMs = opts?.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this.healthyRunMs = opts?.healthyRunMs ?? DEFAULT_HEALTHY_RUN_MS;
    this.ingestTimeoutMs = opts?.ingestTimeoutMs ?? DEFAULT_INGEST_TIMEOUT_MS;
    this.registerTimeoutMs = opts?.registerTimeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS;
    this.reingestTimeoutMs = opts?.reingestTimeoutMs ?? DEFAULT_REINGEST_TIMEOUT_MS;
    this.negativeCacheTtlMs = opts?.negativeCacheTtlMs ?? PROJECT_ID_NEGATIVE_CACHE_TTL_MS;
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

  /** The shared ingest+serve cwd this instance uses (the CWD CONTRACT) — exposed so a caller resolving
   *  codescape's OWN project id (`codescape/manifest.ts` `resolveCodescapeProjectId`) reads the manifest
   *  from the SAME `homeDir` this instance actually ingests into, rather than assuming the default. */
  getHomeDir(): string {
    return this.homeDir;
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
    if (!isCodescapeSupervisorEnabled(this.codescapePath)) {
      // Silent skip (no warn — the "missing" reason here is the gate itself, not a real failure). CR
      // fix: ingest() is public and callable
      // independently of start() (C2/C3's "onboard a newly-enabled project" path) — it must NEVER create
      // CODESCAPE_HOME_DIR (or spawn anything) on a disabled daemon, matching start()'s own zero-side-effects
      // guarantee.
      return { ok: false, outcome: "failed", errorTail: "codescape supervisor is disabled (needs isLoomDev() + a codescape CLI detected on the host)" };
    }
    fs.mkdirSync(this.homeDir, { recursive: true });
    const { command, args } = resolveCodescapeBin(this.codescapePath);
    const r = await runBounded(command, [...args, "ingest", repoPath], this.homeDir, this.ingestTimeoutMs);
    if (!r.ok) {
      console.warn(`[codescape] ingest ${repoPath} ${r.timedOut ? "timed out" : `failed (exit ${r.code})`}${r.output ? ` — ${r.output}` : ""}`);
    }
    return { ok: r.ok, outcome: r.ok ? "ready" : r.timedOut ? "timeout" : "failed", errorTail: r.output || undefined };
  }


  /**
   * Start supervision: no-op (a) when disabled (`isCodescapeSupervisorEnabled()` false — the negative
   * case), or (b) when already running/starting. Ingests each of `repoPaths` in order (v1 bootstrap —
   * see the CWD CONTRACT note above), reserves a loopback port, then spawns + supervises `serve`. Async,
   * best-effort: an ingest failure is logged and does NOT abort the boot — serve still starts (an empty
   * or stale project index there is a Codescape-side concern, not a reason to leave serve down).
   *
   * `dbPath` (card b8de5876): the DB-persisted `integrations.codescape.path` override, when the caller
   * has DB access (index.ts boot does; this class itself has none). Remembered on {@link codescapePath}
   * for the REST of this instance's life — not just this call — so the enablement check here, the actual
   * `ingest`/`serve` spawn (this call AND every later restart-on-death spawn, which runs long after this
   * call has returned), and the boot log line all resolve the SAME candidate. Before this, `start()` only
   * ever checked env/bare-PATH, so a host configured via the DB path alone (no global install) logged
   * "codescape off" here while the per-spawn seam (`pty/host.ts`) — which DID thread the DB path — went on
   * to conclude "enabled", disagreeing within the same boot and leaving the feature unactivatable.
   */
  async start(repoPaths: string[] = [], dbPath?: string): Promise<void> {
    if (this.starting || this.child) return;
    this.codescapePath = dbPath;
    if (!isCodescapeSupervisorEnabled(dbPath)) {
      // isLoomDev()-gated: a regular (non-dev) end user never sees a reference to this unshipped,
      // LOOM_DEV-only feature at every boot — only a LOOM_DEV=1 dev build gets the resolved-decision line,
      // and host-local console output is never a user-facing leak (card 503a30a0: the RESOLVED decision +
      // its REASON, not a bare on/off — this is what would have made the 2026-07 four-day freeze visible
      // on day one instead of silently persisting across 12+ boots). `codescapeBinCandidate(dbPath)` here
      // (card b8de5876) so the logged candidate is the ACTUAL one just checked, not a stale env/bare-PATH
      // guess that silently ignores a configured DB path.
      if (isLoomDev()) console.log(`[boot] codescape off (no codescape CLI detected — checked "${codescapeBinCandidate(dbPath)}"; not installed on this host)`);
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
      console.log(`[boot] codescape on (CLI detected at "${codescapeBinCandidate(dbPath)}"; port ${this.port}, cwd ${this.homeDir}, ${repoPaths.length} project(s) ingested)`);
      // Card 088afc94 P4 follow-up: codescape's `POST /project` dynamic registration (confirmed merged/
      // live, commit 669548e) is now the SANCTIONED id-resolution path. Register every project
      // UNCONDITIONALLY, every boot — idempotent by contract (the subprocess ingest loop just above
      // already populated the manifest `serve` reads at its own boot, so this call resolves
      // `mode:"already-registered"` in the common case: fast, no re-ingest). What this buys is the
      // AUTHORITATIVE `id` cached on THIS instance (see registerProject), so resolveProjectId never has
      // to fall back to a manifest re-read for a project this boot already confirmed. Best-effort +
      // bounded (registerProjectWithRetry): `serve` was just spawned above and its HTTP listener may not
      // be up yet for the first attempt or two — a transient failure here is NOT fatal, it just leaves
      // resolveProjectId falling back to the cold manifest read for that repo, exactly as it already did
      // before this follow-up existed.
      for (const repoPath of repoPaths) {
        // CR fix: this loop can take up to ~51s PER repo worst-case (registerProjectWithRetry's own
        // bound) — without this check, a stop() mid-loop (a fast daemon shutdown right after boot) keeps
        // POSTing at a now-dead-intent port for every remaining repo instead of stopping, mirroring the
        // SAME guard spawnServe already applies against a stop() racing its own restart.
        if (this.stopped) break;
        const res = await this.registerProjectWithRetry(repoPath);
        if (res.ok) {
          const mode = (res.json as { mode?: string } | undefined)?.mode ?? "unknown";
          console.log(`[codescape] registered project ${repoPath} (mode: ${mode})`);
        } else {
          console.warn(`[codescape] register-project failed for ${repoPath} (falling back to manifest-by-path for id resolution): ${res.error ?? res.status}`);
        }
      }
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
    // Card b8de5876: `this.codescapePath` (set once by `start()`, not re-derived here) so a restart-on-
    // death spawn — which runs from a `setTimeout`, long after `start()`'s own call stack returned — still
    // resolves the SAME dbPath-first candidate the boot gate just checked, instead of silently falling
    // back to env/bare-PATH on every restart.
    const { command, args: baseArgs } = resolveCodescapeBin(this.codescapePath);
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
      let json: unknown;
      try { json = await res.json(); } catch { /* no/non-JSON body — fine, most callers never read .json */ }
      return { ok: res.ok, status: res.status, json };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `POST /project` `{repoRoot, graphPath?}` — codescape's fleet-daemon P4 dynamic registration (commit
   * `669548e`, confirmed merged/live). Registers `repoRoot` into codescape's LIVE registry with NO
   * `serve` restart — idempotent (`mode:"already-registered"` for a repo already live, `"attached"` if a
   * graph.json already existed on disk, `"ingested"` for a brand-new repo — run through codescape's OWN
   * single-flight queue, so this can genuinely take as long as a real ingest). Defaults to
   * `ingestTimeoutMs` (the long bound, appropriate for a standalone/on-demand call that may be doing a
   * real first-time ingest); `timeoutMs` lets a caller override it — {@link registerProjectWithRetry}
   * passes the SHORT `registerTimeoutMs` instead, since ITS retries exist to close a spawn-timing race,
   * not to babysit a slow ingest (see that method's own doc for why the distinction matters). On success,
   * caches the response's AUTHORITATIVE `id` (Codescape's own `slugify+sha256` result — NEVER
   * reimplemented here) keyed by the resolved repoRoot, so {@link resolveProjectId} serves it without a
   * manifest re-read. Never throws: a 400 (bad repoRoot)/409 (id conflict)/500 (ingest/persist
   * failure)/network error/timeout all resolve `ok:false` with NOTHING cached — the caller falls back to
   * the cold manifest-by-path resolver, exactly as it already does when this call is never made at all.
   */
  async registerProject(repoRoot: string, graphPath?: string, timeoutMs?: number): Promise<CodescapeRequestResult> {
    const res = await this.request("POST", "/project", graphPath ? { repoRoot, graphPath } : { repoRoot }, timeoutMs ?? this.ingestTimeoutMs);
    if (res.ok) {
      const id = (res.json as { id?: string } | undefined)?.id;
      if (id) {
        const key = repoKey(repoRoot);
        this.projectIds.set(key, id);
        this.unresolvedProjectIds.delete(key); // a fresh HIT supersedes any still-live negative marker
      }
    }
    return res;
  }

  /**
   * A few quick retries around {@link registerProject}, for the BOOT-TIME call in {@link start} only:
   * `serve` was just spawned synchronously a moment earlier and its HTTP listener may not be up yet on
   * the first attempt — a bare single try would spuriously fall back to the manifest on every single
   * boot for no real reason.
   *
   * BOUNDED PER ATTEMPT AT `registerTimeoutMs` (the FAST 10s control-plane bound), DELIBERATELY NOT the
   * full `ingestTimeoutMs` (120s) `registerProject`'s own default uses: the race this retry exists to
   * close (a listener that isn't bound YET) fails via an immediate ECONNREFUSED, not a hang — so a short
   * per-attempt bound is the correct fit, and using the long one would let a single HUNG (accepted-but-
   * never-responds) attempt burn up to 2 minutes before even trying again, times up to 5 attempts —
   * exactly the "retry over a hung operation" shape this project has a documented scar from (the
   * worktree-GC threadpool leak, card bd9fc808). With this bound, 5 attempts worst-case total ~50s, not
   * ~10 minutes. A repo whose subprocess `ingest()` step (in {@link start}, just above) silently failed
   * and genuinely needs a slow first ingest via THIS call may still read as "failed" here within that
   * ~50s window — it self-heals via the cold manifest fallback once codescape's own single-flight queue
   * finishes the ingest server-side (this client giving up does not stop codescape's own in-progress
   * work), or on the next boot's subprocess-ingest retry. Boot itself is NEVER blocked by any of this —
   * {@link start} is always fire-and-forget from index.ts (`void ... .catch(...)`, called well AFTER the
   * daemon's own HTTP listener is already up), so a fully-exhausted worst case here delays only this
   * repo's id-cache warm-up, never the daemon's availability.
   */
  private async registerProjectWithRetry(repoRoot: string, attempts = 5, delayMs = 300): Promise<CodescapeRequestResult> {
    let last: CodescapeRequestResult = { ok: false, error: "registerProjectWithRetry: never attempted" };
    for (let i = 0; i < attempts; i++) {
      last = await this.registerProject(repoRoot, undefined, this.registerTimeoutMs);
      if (last.ok) return last;
      // Nitpick fix: don't sleep after the FINAL failed attempt — there's no next try waiting on it, so
      // that delay only adds dead latency to every caller of this already best-effort, bounded call.
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    return last;
  }

  /**
   * Resolve codescape's project id for `repoRoot` — the ONE seam every caller (sessions/service.ts's
   * lifecycle hooks, pty/host.ts's per-session MCP mount) should use, so swapping the resolution
   * strategy later is a change in this one place. Checks THIS instance's own in-memory cache first
   * (populated by a successful {@link registerProject} — the authoritative source for anything this
   * boot has confirmed), falling back to the COLD manifest-by-path read
   * (`codescape/manifest.ts` `resolveCodescapeProjectId`) on a cache miss (registration never ran,
   * failed, or hasn't happened yet for this repo). The manifest fallback is DELIBERATELY kept, not
   * retired: `POST /project` can fail transiently (serve mid-restart, a bad repoRoot, a genuine
   * conflict), while the manifest still resolves an id for any repo codescape has EVER ingested — cache
   * miss or not, restart or not. Never throws; `null` is an honest "cannot resolve right now", which
   * every caller already treats as a clean skip.
   *
   * CR follow-up (card 088afc94): a manifest-read HIT is now cached into {@link projectIds} too (not just
   * a {@link registerProject} success) — this is the SPAWN HOT PATH (per-session MCP mount resolution),
   * and `CLAUDE.md` pins it to no blocking work, so the cold `readFileSync`+`JSON.parse` inside
   * `resolveCodescapeProjectId` must run at most once per repo, not once per lookup. A MISS is also
   * remembered, but only for {@link PROJECT_ID_NEGATIVE_CACHE_TTL_MS} — see that constant's doc for why a
   * miss can't be cached forever the way a hit can.
   */
  resolveProjectId(repoRoot: string): string | null {
    const key = repoKey(repoRoot);
    const cached = this.projectIds.get(key);
    if (cached) return cached;
    const negativeUntil = this.unresolvedProjectIds.get(key);
    if (negativeUntil != null) {
      if (Date.now() < negativeUntil) return null;
      this.unresolvedProjectIds.delete(key); // expired — allow a fresh manifest read below
    }
    const id = resolveCodescapeProjectId(repoRoot, this.homeDir);
    if (id) this.projectIds.set(key, id);
    else this.unresolvedProjectIds.set(key, Date.now() + this.negativeCacheTtlMs);
    return id;
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
