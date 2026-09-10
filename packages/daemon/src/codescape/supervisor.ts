import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { resolveCodescapeConfig, type ProjectConfigOverride } from "@loom/shared";
import { CODESCAPE_HOME_DIR, isCodescapeSupervisorEnabled, isLoomDev, resolveCodescapeBin, codescapeBinCandidate } from "../paths.js";
import { resolveCodescapeProjectId } from "./manifest.js";
import { probeAdvertisedTools } from "./tools-probe.js";
import { writeToolDriftState, writeBuildDriftState } from "./drift-notice.js";
import { codescapeUnclassifiedTools } from "../pty/host.js";

/**
 * Codescape fleet-daemon wiring epic, foundation. Under `isCodescapeSupervisorEnabled()`, Loom starts +
 * supervises ONE `codescape serve` process per host on a loopback port, bootstrapped by
 * `codescape ingest <repoPath>` for each target project BEFORE serve starts (v1: projects load from
 * `.codescape/projects/index.json` at serve BOOT — a project ingested after serve started isn't picked up
 * until a restart).
 *
 * @decision 369dde3c — no method on this class is ever registered as an agent MCP tool; every method
 * here is Loom-internal only.
 *
 * @decision 194d343d — `ingest` and `serve` must both pin `CODESCAPE_HOME=<homeDir>` in their spawn env;
 * cwd alignment alone cannot prevent an upstream resolver from walking past it.
 */

/** Cap (bytes) on the captured stdout+stderr tail kept for diagnostics — a bounded ring, mirrors OUTPUT_TAIL_BYTES in python/venv.ts. */
const OUTPUT_TAIL_BYTES = 4096;

/** Bound (ms) for `codescape ingest <repoPath>` — a big repo's initial graph build can take a while. */
const DEFAULT_INGEST_TIMEOUT_MS = 120_000;
/** Bound (ms) for the fast control-plane calls (register/drop/overlay). */
const DEFAULT_REGISTER_TIMEOUT_MS = 10_000;
/**
 * Bound (ms) for reingest-main.
 * @decision sha:e8354b5e — measured BIMODAL (~13-19s warm, ~24-29s cold); never retune tighter than
 * {@link DEFAULT_INGEST_TIMEOUT_MS} without re-measuring, and never trust these percentiles once this
 * repo's corpus has grown materially past measurement time.
 */
const DEFAULT_REINGEST_TIMEOUT_MS = 120_000;
/**
 * Bounded backoff (ms) between restart attempts after `serve` dies — increasing, never a tight loop.
 * Exhausting the array without a "healthy run" resetting it (see `healthyRunMs`) means the supervisor
 * gives up: `getPort()` reports null and stays that way ("broken stays visibly down") until a fresh
 * `start()`. Card 4c7a337d: this budget ALONE is not the whole give-up story any more — see
 * {@link DEFAULT_MAX_RESTARTS_PER_WINDOW} for the second, `ranHealthy`-proof ceiling layered on top.
 */
const DEFAULT_RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
/** A `serve` that ran at least this long before dying is treated as a fresh failure — resets the backoff. */
const DEFAULT_HEALTHY_RUN_MS = 30_000;
/**
 * Bound (ms) for the self-reporting `--port 0` capability probe embedded in the FIRST spawn attempt of
 * this instance's life (and any later attempt after {@link CodescapeSupervisor.port} goes back to
 * `null`).
 *
 * @decision 4e0df6ce — if neither the report line nor the child's exit arrives within this bound, the
 * attempt is abandoned without concluding anything about port-report capability; the normal backoff
 * schedule retries.
 *
 * @decision 44d45f81 — raised from the original 5_000ms after a live production regression; do not lower
 * this without re-measuring against the real installed binary under real host contention.
 */
const DEFAULT_PORT_REPORT_TIMEOUT_MS = 30_000;
/**
 * Card 4c7a337d: the sliding window (ms) {@link DEFAULT_MAX_RESTARTS_PER_WINDOW} is measured over — see
 * that constant's own doc for what this pair exists to fix.
 */
const DEFAULT_RESTART_WINDOW_MS = 60 * 60_000;
/**
 * @decision 4c7a337d — a SECOND ceiling (over {@link DEFAULT_RESTART_WINDOW_MS}) that `ranHealthy`
 * CANNOT clear — without it, a crash loop recurring slower than `healthyRunMs` makes backoff-exhaustion
 * structurally unreachable, so never let `ranHealthy` clear this window-based count either.
 */
const DEFAULT_MAX_RESTARTS_PER_WINDOW = 10;
/**
 * How often to probe a believed-alive `serve` with `GET /graph/health` — process-exit detection alone
 * (`spawnServe`'s `child.on("exit")`) never sees a serve that's up, port bound, but wedged and not
 * answering; this periodic probe is what catches THAT case. Card: the 2026-07 four-day freeze survived
 * 12+ boots specifically because nothing but an exit event could ever flip `alive` back to false.
 */
const DEFAULT_HEALTH_PROBE_INTERVAL_MS = 30_000;
/** Bound (ms) for a single `/graph/health` probe call — short, since a healthy serve answers fast. */
const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 5_000;
/**
 * Bound (ms) for a single tool-drift `tools/list` round-trip (card `350bc307`) — a real MCP handshake
 * (`initialize` then `tools/list`) against the live mounted server, layered onto the same health-probe
 * tick as {@link DEFAULT_HEALTH_PROBE_TIMEOUT_MS} and {@link DEFAULT_VERSION_PROBE_TIMEOUT_MS}. Same
 * order of magnitude as those: a healthy server answers a handshake fast, and a slow/wedged one is
 * already caught by the health probe itself.
 */
const DEFAULT_TOOLS_PROBE_TIMEOUT_MS = 5_000;
/**
 * Consecutive probe failures required before treating `serve` as wedged. NOT 1 — a busy serve can miss a
 * single beat under load, and a lone blip must not be mistaken for a real wedge (see `probeHealth`'s own
 * doc). Reset to 0 on ANY successful probe, so only a genuinely SUSTAINED run of failures counts.
 */
const DEFAULT_HEALTH_PROBE_FAILURE_THRESHOLD = 3;
/**
 * Bound (ms) for reading the INSTALLED codescape binary's own build id (a `--version`-style call) —
 * card 90550a97's build-id drift detection. Short, mirroring the health-probe timeout: this is a cheap
 * local process spawn, never a network call, so a healthy install answers fast.
 */
const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 5_000;
/**
 * Card f0718488: max attempts for {@link CodescapeSupervisor.readInstalledBuild}'s version probe when
 * consecutive attempts TIME OUT specifically — a genuinely broken binary (non-zero exit / malformed
 * stdout) never reaches a 2nd attempt, see that method's own retry loop. 3 sits at the top of the
 * originally-suggested "2-3 attempts" range: the observed failure is steady-state host contention (a
 * live fleet of workers + gates), exactly the shape more chances helps with, while the timedOut-only
 * retry gate already filters out genuine breakage after just one try. See the retry loop itself for the
 * full worst-case budget arithmetic against the health-probe tick interval.
 */
const DEFAULT_VERSION_PROBE_MAX_ATTEMPTS = 3;
/**
 * Card f0718488: flat (non-escalating) delay between retried version-probe attempts — deliberately NOT
 * {@link DEFAULT_RESTART_BACKOFF_MS}'s escalating shape (that nurses a possibly-broken PROCESS back up
 * over minutes); this is only bridging a brief host-scheduling blip on a cheap subprocess spawn, so a
 * short fixed pause is the right fit.
 */
const DEFAULT_VERSION_PROBE_RETRY_DELAY_MS = 250;
/**
 * Card 9e6f984d: how long the INSTALLED build id must sit UNCHANGED before a detected drift is allowed
 * to fire a restart. Without this, a burst of N distinct rebuilds on the codescape side (their own
 * legitimate rebuild cadence) becomes N legitimately-distinct drift events, each restarting `serve` and
 * dropping any MCP request that happened to be in flight — a control loop where a peer project's build
 * cadence drives OUR process lifecycle. 15 minutes: long enough that a realistic rebuild burst settles
 * inside one window (collapsing to a single restart once the dust settles), short enough that a
 * genuinely-stable new build still gets picked up promptly. Never urgent — a stale serve is harmless; a
 * restart that drops an in-flight request is not, so when in doubt this waits longer, not less.
 */
const DEFAULT_DRIFT_STABILITY_MS = 15 * 60_000;
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
  /** Test seam: shrink {@link DEFAULT_RESTART_WINDOW_MS} so a rate-ceiling test doesn't wait a real hour. */
  restartWindowMs?: number;
  /** Test seam: shrink {@link DEFAULT_MAX_RESTARTS_PER_WINDOW} so a rate-ceiling test doesn't need 10 real restarts. */
  maxRestartsPerWindow?: number;
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
  /** Test seam: shrink {@link DEFAULT_HEALTH_PROBE_INTERVAL_MS} so a wedge test doesn't wait 30 real seconds. */
  healthProbeIntervalMs?: number;
  /** Test seam: shrink/lengthen {@link DEFAULT_HEALTH_PROBE_TIMEOUT_MS}. */
  healthProbeTimeoutMs?: number;
  /** Test seam: override {@link DEFAULT_HEALTH_PROBE_FAILURE_THRESHOLD}. */
  healthProbeFailureThreshold?: number;
  /** Test seam: shrink/lengthen {@link DEFAULT_VERSION_PROBE_TIMEOUT_MS}. */
  versionProbeTimeoutMs?: number;
  /** Test seam: override {@link DEFAULT_VERSION_PROBE_MAX_ATTEMPTS}. */
  versionProbeMaxAttempts?: number;
  /** Test seam: shrink/lengthen {@link DEFAULT_VERSION_PROBE_RETRY_DELAY_MS}. */
  versionProbeRetryDelayMs?: number;
  /** Test seam: shrink/lengthen {@link DEFAULT_DRIFT_STABILITY_MS} so a stability-window test doesn't wait real minutes. */
  driftStabilityMs?: number;
  /** Test seam: shrink/lengthen {@link DEFAULT_TOOLS_PROBE_TIMEOUT_MS}. */
  toolsProbeTimeoutMs?: number;
  /** Test seam: shrink/lengthen {@link DEFAULT_PORT_REPORT_TIMEOUT_MS}. */
  portReportTimeoutMs?: number;
  /**
   * Test seam: pre-seed {@link projectIds} with ONE `(repoKey(repoRoot) -> codescapeProjectId)` entry,
   * mirroring the `port` seam above (exercise the control-plane client / {@link checkToolDrift} against
   * a fake HTTP server with no real spawn AND no real `registerProject` round-trip). Production always
   * populates this map itself, via {@link registerProjectWithRetry}.
   */
  seedProjectId?: { repoRoot: string; projectId: string };
}

export interface CodescapeRequestResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** Parsed JSON response body, when the response carried one. Most control-plane calls ignore this
   *  (fire-and-forget); {@link CodescapeSupervisor.registerProject} reads it for the resolved `id`/`mode`. */
  json?: unknown;
  /** TRUE only when THIS client gave up waiting — the per-call `timeoutMs` bound elapsed and WE aborted
   *  the fetch (see {@link CodescapeSupervisor.request}'s `controller.signal.aborted` check), never set for
   *  a real HTTP error response or a network-level failure. Card daaf7fc9: this is what lets a caller tell
   *  "we stopped listening" apart from "codescape actually failed" — a client-side abort does NOT observe
   *  whether the request codescape kept processing eventually succeeded or failed server-side; it only
   *  means our own bound (named in `error`) elapsed first. Never conflate this with `!ok` on its own. */
  timedOut?: boolean;
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
 * Card 545ef479 (Defect 1): the DISTINGUISHABLE outcome of the most recent {@link CodescapeSupervisor.checkBuildDrift}
 * call — `"match"` and `"mismatch"` are genuine drift-checked answers; the two `"not-checked:*"` variants
 * are an honest UNKNOWN (no comparable build id on one side) and must never look like `"match"` in the log
 * or in {@link CodescapeSupervisor.getDriftCheckState}. `"not-checked:installed-read-failed"` is its own
 * bucket too (not left at a stale prior value) — a genuine couldn't-read is a THIRD kind of unknown,
 * distinct from an honest `build: null` answer, even though both were previously silent, byte-identical
 * early returns.
 */
type DriftCheckState = "match" | "mismatch" | "not-checked:running-absent" | "not-checked:installed-null" | "not-checked:installed-read-failed";

/**
 * Card ce1bed6e: the detail {@link CodescapeSupervisor.getDriftCheckState} deliberately never carried —
 * it is a coarse diagnostic/test seam only. This is the shape `served_status` surfaces instead, so a
 * project's OWN manager (never a reader of THIS daemon's console — see this card) can read whether the
 * shared `codescape serve` process is mid-drift, how much of the stability window remains, and — the
 * whole point, since a bare "deferring" is what invites the fatal same-commit rebuild — that rebuilding
 * the SAME installed commit does NOT reset the window; only a genuinely DIFFERENT installed build does.
 * Every field below `state` is only meaningful when `state === "mismatch"`; all read `null`/`false`
 * otherwise (including a resolved `"match"`, which has nothing left to report).
 */
export interface CodescapeDriftDetail {
  state: DriftCheckState | null;
  /** The mismatched installed/running build ids, or both `null` when `state !== "mismatch"`. */
  installedBuild: string | null;
  runningBuild: string | null;
  /**
   * `true` once this daemon lifetime already spent its ONE restart for `installedBuild` and it still
   * has not resolved — the SECOND non-convergence path (a restart fired and came back still mismatched),
   * which gets no further retry until the installed build changes again or the daemon restarts. When
   * `true`, `remainingMs` is `null` — there is no window counting down; nothing further will happen on
   * its own.
   */
  restartExhausted: boolean;
  /** ms remaining in the stability window before a restart fires, floored at 0, or `null` when no window
   *  is currently running (no mismatch, or `restartExhausted`). */
  remainingMs: number | null;
  /** The full stability window this instance enforces (config/default) — always populated, so a caller
   *  can compute "stable X of Y" itself even when it wants to build its own message. */
  driftStabilityMs: number;
  /** A ready-to-surface, human-readable line stating BOTH the remaining window AND that rebuilding the
   *  SAME commit does not reset it (or the UNRESOLVED/exhausted message). `null` when `state !==
   *  "mismatch"`. */
  message: string | null;
}

/**
 * Run a child process to completion ASYNCHRONOUSLY, resolving a {@link RunResult}. NEVER rejects — a
 * spawn error, non-zero exit, or timeout all resolve `ok:false`. Captures a bounded stdout+stderr tail
 * for diagnostics. Mirrors `python/venv.ts`'s `runAsync` (a fresh copy: different subsystem, same
 * discipline — spawn not spawnSync, bounded, never throws).
 */
function runBounded(command: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<RunResult> {
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
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
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

/** What {@link runBoundedSplit} resolves — like {@link RunResult} but keeps stdout/stderr SEPARATE. */
interface SplitRunResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Same async/bounded/never-rejects discipline as {@link runBounded} above, but captures stdout and
 * stderr SEPARATELY instead of merging them into one buffer. Card 90550a97 (build-id drift detection):
 * the agreed installed-build-id contract puts the JSON payload EXCLUSIVELY on stdout and reserves stderr
 * for a human-readable usage/failure banner. Merging the two streams — as `runBounded` deliberately does
 * for its OTHER callers (`ingest()`), where mixed diagnostic output is perfectly fine to log together —
 * would let stray stderr content corrupt the very JSON parse this exists to do. This is the SAME class of
 * mistake a review pass on this feature already caught once (a manual repro that piped `2>&1` into `head`
 * and then read `$?` through the pipe, merging the exact two signals it needed to keep apart): whenever
 * the STREAM a value arrives on is part of what's being checked, never merge streams. Only used by
 * {@link CodescapeSupervisor.readInstalledBuild}.
 */
function runBoundedSplit(command: string, args: string[], cwd: string, timeoutMs: number): Promise<SplitRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const makeCapture = () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      return {
        onData: (b: Buffer): void => {
          chunks.push(b);
          bytes += b.length;
          while (bytes > OUTPUT_TAIL_BYTES && chunks.length > 1) bytes -= chunks.shift()!.length;
        },
        tail: (): string => {
          const s = Buffer.concat(chunks).toString("utf-8").trim();
          return s.length > OUTPUT_TAIL_BYTES ? s.slice(-OUTPUT_TAIL_BYTES) : s;
        },
      };
    };
    const out = makeCapture();
    const err = makeCapture();
    const finish = (ok: boolean, code: number | null): void => {
      if (!settled) { settled = true; resolve({ ok, code, timedOut, stdout: out.tail(), stderr: err.tail() }); }
    };
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish(false, null);
      return;
    }
    child.stdout?.on("data", out.onData);
    child.stderr?.on("data", err.onData);
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* noop */ } finish(false, null); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); finish(false, null); });
    child.on("exit", (code) => { clearTimeout(timer); finish(code === 0, code); });
  });
}

/** Promise-based delay — used only by {@link CodescapeSupervisor.readInstalledBuild}'s retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Card 23980bbf: render a duration for a human-facing log line, never rounding a sub-1000ms value down to
 * a misleading `0s` — a plain `Math.round(ms / 1000)` does exactly that for any {@link
 * CodescapeSupervisor.healthProbeIntervalMs} below 1000, which is the common case for this file's own test
 * seams (300ms/60ms) and would have printed a nonsensical "checked every 0s" (caught by actually running
 * the test corpus and reading the emitted line, not by inspection alone).
 */
function formatIntervalMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

/**
 * Card ce1bed6e: render a duration as `<minutes>m<seconds>s` (e.g. `4m12s`, `15m0s`) for
 * {@link CodescapeSupervisor.getDriftDetail}'s human-facing message — `driftStabilityMs` defaults to
 * 15 minutes, so {@link formatIntervalMs}'s bare-seconds form ("900s") is correct but illegible for this
 * caller; this is a separate function rather than a change to that one, which existing log lines already
 * depend on staying in its current form.
 */
function formatMinSec(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds}s`;
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

/**
 * Pick a free loopback port by binding ephemeral (`:0`) then releasing it. Async — never blocks.
 *
 * Card 4e0df6ce: this is the LEGACY path only — it has a real, deliberately-tolerated TOCTOU (the gap
 * between this function's own `close()` and a SEPARATE later-spawned child rebinding the same number),
 * kept ONLY for a codescape build predating `f7a5684` (which hard-exits on `--port 0`, see
 * {@link CodescapeSupervisor.spawnServeSelfReporting}'s doc for the capable path that has no such window).
 * Never called once {@link CodescapeSupervisor} has confirmed the installed binary self-reports its bound
 * port — see `spawnServe()`'s dispatch.
 */
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

/**
 * Parse ONE stdout line as codescape's self-reported-bound-port contract (card 4e0df6ce; peer-delivered
 * `f7a5684`): `{"url":"http://127.0.0.1:<port>","port":<port>}`, printed on every `serve` invocation once
 * the installed binary supports it. Returns the bound port taken STRICTLY from `url` — never reconstructed
 * from the sibling `port` field — because their server binds IPv4 loopback ONLY; building
 * `http://localhost:<port>` instead of parsing the given `url` would let `localhost` resolve `::1` and
 * connect-refuse against a perfectly healthy server. Returns `null` for any line that isn't a well-formed
 * report — an OLDER binary's banner, ordinary log noise, or anything before the real report line on a
 * newer one are all simply not this; a non-match is normal, not an error.
 */
function parsePortReportLine(line: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const url = (parsed as { url?: unknown } | null)?.url;
  if (typeof url !== "string") return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1") return null;
  const port = Number(u.port);
  if (!Number.isInteger(port) || port <= 0) return null;
  return port;
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
  private readonly restartWindowMs: number;
  private readonly maxRestartsPerWindow: number;
  private readonly ingestTimeoutMs: number;
  private readonly registerTimeoutMs: number;
  private readonly reingestTimeoutMs: number;
  private readonly negativeCacheTtlMs: number;
  private readonly healthProbeIntervalMs: number;
  private readonly healthProbeTimeoutMs: number;
  private readonly healthProbeFailureThreshold: number;
  private readonly versionProbeTimeoutMs: number;
  private readonly versionProbeMaxAttempts: number;
  private readonly versionProbeRetryDelayMs: number;
  private readonly driftStabilityMs: number;
  private readonly toolsProbeTimeoutMs: number;
  private readonly portReportTimeoutMs: number;

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
  /**
   * Card 4e0df6ce: whether the installed `serve` binary understands `--port 0` and self-reports the bound
   * port on stdout (see {@link parsePortReportLine}) — `null` until the first spawn attempt that needed an
   * answer has resolved it either way, `true`/`false` once confirmed. Sticky for the rest of this
   * instance's life (a binary doesn't regress mid-process) — never reset by {@link stop}/{@link start},
   * unlike the drift-tracking fields above. Only consulted when {@link port} is `null` (the FIRST spawn of
   * this instance's life, or a fresh attempt after a `stop()`/give-up nulled it — see {@link spawnServe});
   * an ordinary restart-on-death reuses the already-known `port` explicitly and never touches this.
   */
  private portReportCapable: boolean | null = null;
  /** True once `serve` has actually been spawned and hasn't since exited/errored. Distinct from `port`
   *  (which is reserved up-front and reused across a restart-on-death) — getPort() gates on this. */
  private alive = false;
  private child: ChildProcess | null = null;
  /** True before the first start() and after an explicit stop() — suppresses restart-on-death. */
  private stopped = true;
  private starting = false;
  private spawnedAt: number | null = null;
  private restartAttempts = 0;
  /**
   * Card 4c7a337d: epoch-ms timestamps of every restart {@link scheduleRestart} has actually SCHEDULED
   * (never the give-up call itself) — pruned to the trailing {@link restartWindowMs} on every call. Unlike
   * {@link restartAttempts}, `ranHealthy` can NEVER clear this: it is the independent ceiling that catches
   * a genuine crash loop on a cadence longer than `healthyRunMs`, where the `ranHealthy` reset would
   * otherwise forgive every single death and make the backoff-exhaustion ceiling unreachable. Reset (like
   * `restartAttempts`) in {@link start} — a fresh supervisor lifetime starts with no restart-rate memory.
   */
  private restartTimestamps: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private healthProbeTimer: ReturnType<typeof setInterval> | null = null;
  /** Resets to 0 on any successful `/graph/health` probe — see {@link DEFAULT_HEALTH_PROBE_FAILURE_THRESHOLD}. */
  private consecutiveHealthFailures = 0;
  /**
   * Card 90550a97 review follow-up: true while a `probeHealth()` call is still in flight (its own HTTP
   * fetch, plus — on a successful response — the {@link readInstalledBuild} subprocess spawn it now
   * awaits). `probeHealth` no-ops a tick that lands while this is still true, so two overlapping ticks
   * (the version-probe subprocess spawn can occasionally outrun a fast `healthProbeIntervalMs`, esp.
   * under host load) can never both observe the SAME unresolved-installed-build failure and both log the
   * one-shot diagnostic — the check-then-set on {@link lastInstalledBuildFailureReason} is otherwise not
   * atomic across two concurrently-running probes.
   */
  private probeInFlight = false;
  /**
   * Card 90550a97: the INSTALLED build id we already gave ONE deliberate drift-restart to, or `null` if
   * none yet. {@link checkBuildDrift} only fires a kill when the currently-mismatched installed build
   * differs from THIS — so a serve that keeps reporting a stale/failing `build` after the restart (the
   * installed side hasn't changed) is never kicked a second time; a restart only fires again once the
   * installed build itself moves on to something new. Reset on {@link stop}/{@link start} (a fresh
   * supervisor lifetime starts with no drift-restart memory), but DELIBERATELY NOT on an ordinary
   * death/restart in between — the "one restart per drift event" guarantee must survive a restart chain.
   */
  private lastDriftRestartInstalledBuild: string | null = null;
  /**
   * Card 9e6f984d: the installed build id currently being WATCHED for stability, or `null` when no
   * drift is pending. Set the moment {@link checkBuildDrift} first sees a mismatch against a NEW
   * installed build (distinct from whatever was previously being watched); cleared once that build
   * either stabilizes long enough to fire a restart, or the running side catches up to it (drift
   * resolves on its own — nothing left to watch). A DIFFERENT installed build showing up while one is
   * already being watched replaces it and restarts the window from scratch — this is what collapses a
   * burst of N distinct rebuilds into a single eventual restart: the window only ever completes against
   * whichever build turns out to be the LAST one in the burst. Reset on {@link stop}/{@link start}, same
   * as {@link lastDriftRestartInstalledBuild}.
   */
  private driftCandidateBuild: string | null = null;
  /** Epoch ms {@link driftCandidateBuild} was first observed — paired with it, see that field's doc. */
  private driftCandidateFirstSeenAt: number | null = null;
  /**
   * Card ce1bed6e: the `(installedBuild, runningBuild)` pair from the MOST RECENT probe tick that
   * announced `"mismatch"` — set unconditionally the moment {@link checkBuildDrift} enters the mismatch
   * branch, so it stays populated through BOTH the deferring-restart state and the POST-EXHAUSTION
   * UNRESOLVED state. This is deliberately a DIFFERENT lifetime than {@link driftCandidateBuild}, which
   * is cleared the instant a build's one restart fires (see the `installedBuild ===
   * lastDriftRestartInstalledBuild` branch below) — without a separate pair, {@link getDriftDetail} would
   * have nothing to report for exactly the UNRESOLVED case the served_status surface exists to name.
   * Reset to `null` on the "match" branch (a resolved drift has nothing left to report) and on
   * {@link stop}/{@link start}, same as every other drift-tracking field.
   */
  private lastMismatchInstalledBuild: string | null = null;
  private lastMismatchRunningBuild: string | null = null;
  /**
   * @decision ebd755ab — latches the exhausted-restart diagnostic per distinct (installedBuild,
   * runningBuild) pair; never let it fire on every probe tick, or an unresolvable drift becomes
   * indistinguishable from a healthy steady state in the log.
   */
  private lastExhaustedDriftAnnounced: string | null = null;
  /**
   * Card 90550a97 review follow-up: latches the CLASSIFIED reason {@link readInstalledBuild} last failed
   * with, so an unreadable installed build is reported LOUDLY exactly ONCE per distinct reason — not
   * once per 30s probe tick forever (this project's own scar, `16b7c38c`: a silent "can't tell" that
   * reads identically to "nothing to report" quietly disabled a whole subsystem for months). `null` means
   * either "no failure has ever been latched" or "the last read succeeded" — {@link checkBuildDrift}
   * resets it to `null` on any successful installed-build read, so a later regression warns again.
   */
  private lastInstalledBuildFailureReason: string | null = null;
  /**
   * Card 545ef479 (Defect 1): the last DISTINGUISHABLE {@link DriftCheckState}, latched so a
   * TRANSITION is logged/exposed once rather than every ~30s tick — mirrors
   * {@link lastInstalledBuildFailureReason}'s discipline. `null` until the first probe tick that reaches
   * {@link checkBuildDrift} completes. Exposed via {@link getDriftCheckState} so "drift detection is
   * running and finding nothing" (`"match"`) is never silently identical to "drift detection is inert"
   * (a `"not-checked:*"` state) — before this field existed, both were pure early-returns with zero
   * signal at all, downstream-indistinguishable. Reset on {@link stop}/{@link start}, same as every other
   * drift-tracking field — a fresh supervisor lifetime starts with no drift-check memory.
   */
  private driftCheckState: DriftCheckState | null = null;
  /**
   * Card 545ef479 (Defect 2): the HTTP status of the last `/graph/health` response that ARRIVED but was
   * not `res.ok` (e.g. a 500), or `null` if none is currently latched. A response that arrives — even an
   * error one — is proof the process is alive and serving; it is NOT wedge evidence (only a genuine
   * no-answer is), so {@link probeHealth} never counts it toward {@link consecutiveHealthFailures}. This
   * latch exists purely so that fact is reported ONCE per distinct status (not once per ~30s tick
   * forever) and its recovery (back to 200) is announced once too — same discriminator discipline as
   * {@link lastInstalledBuildFailureReason}. Reset on {@link stop}/{@link start}.
   */
  private lastHealthAnsweredErrorStatus: number | null = null;
  /**
   * Card `350bc307`: the unclassified-tool-name set (per {@link codescapeUnclassifiedTools}) from the
   * MOST RECENT successful {@link checkToolDrift} probe — `null` before the first probe ever completes,
   * `[]` once a probe finds the partition complete. Latched (like {@link driftCheckState}) purely so a
   * TRANSITION gets logged once, not every ~30s tick forever; the actual addressed signal is the
   * persisted state file {@link checkToolDrift} writes via `writeToolDriftState`, read by
   * `readCodescapeToolDriftNote` — this field is a diagnostic/test seam, not itself the mechanism a
   * human ever sees. Reset on {@link stop}/{@link start}, matching every other drift-tracking field.
   */
  private lastToolDriftUnclassified: string[] | null = null;
  /**
   * Test seam: count of {@link probeHealth} invocations that ran to full completion (a tick skipped by the
   * `probeInFlight` guard does NOT count). A REAL subprocess spawn now sits inside every successful probe
   * (`checkBuildDrift` -> `readInstalledBuild`), so the number of probes that complete in any given
   * wall-clock window is not deterministic (varies with host load) — a test asserting "fires loudly
   * exactly once across N ticks" needs to wait for N COMPLETED ticks, not sleep through a window and hope
   * enough landed. See `test/codescape-health-probe.mjs` scenario (8).
   */
  private completedProbeTicks = 0;
  /**
   * Card b27f54b0: count of {@link spawnServe} calls that successfully launched a REAL child process —
   * incremented on the PARENT side immediately after `spawn()` returns, so it can never be pre-empted by
   * the child being killed before it finishes initializing (the same shape as {@link completedProbeTicks}:
   * observe an action from the side that performs it, not a side effect the child might not live long
   * enough to produce). Before this seam existed, `test/codescape-health-probe.mjs` counted spawns by
   * reading a file the CHILD writes about itself on startup — a child SIGTERM'd before Node finished
   * initializing (~70-85ms observed, more under host load) never got there, so a spawn that genuinely
   * happened silently vanished from that count. A synchronous `spawn()` throw (no child ever came up, see
   * the `catch` branch below) does NOT increment this — there was no real process to count. Never reset
   * (not on {@link stop}/{@link start}, matching {@link completedProbeTicks}'s own lifetime scope) — this
   * instance's own tests always construct a fresh supervisor per scenario.
   */
  private spawnCount = 0;
  /**
   * Card f0718488: count of {@link readInstalledBuild} attempts (real subprocess spawns of `--version`)
   * that were actually made, incremented once per loop iteration regardless of outcome. Cumulative across
   * this instance's lifetime — never reset on {@link stop}/{@link start}, matching {@link spawnCount}/
   * {@link completedProbeTicks}'s own scope — so a test asserting "retried exactly N times" (or "gave up
   * after exactly the max") reads this rather than timing the wall-clock, per this card's own DoD.
   */
  private versionProbeAttempts = 0;
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
    this.restartWindowMs = opts?.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
    this.maxRestartsPerWindow = opts?.maxRestartsPerWindow ?? DEFAULT_MAX_RESTARTS_PER_WINDOW;
    this.ingestTimeoutMs = opts?.ingestTimeoutMs ?? DEFAULT_INGEST_TIMEOUT_MS;
    this.registerTimeoutMs = opts?.registerTimeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS;
    this.reingestTimeoutMs = opts?.reingestTimeoutMs ?? DEFAULT_REINGEST_TIMEOUT_MS;
    this.negativeCacheTtlMs = opts?.negativeCacheTtlMs ?? PROJECT_ID_NEGATIVE_CACHE_TTL_MS;
    this.healthProbeIntervalMs = opts?.healthProbeIntervalMs ?? DEFAULT_HEALTH_PROBE_INTERVAL_MS;
    this.healthProbeTimeoutMs = opts?.healthProbeTimeoutMs ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
    this.healthProbeFailureThreshold = opts?.healthProbeFailureThreshold ?? DEFAULT_HEALTH_PROBE_FAILURE_THRESHOLD;
    this.versionProbeTimeoutMs = opts?.versionProbeTimeoutMs ?? DEFAULT_VERSION_PROBE_TIMEOUT_MS;
    this.versionProbeMaxAttempts = opts?.versionProbeMaxAttempts ?? DEFAULT_VERSION_PROBE_MAX_ATTEMPTS;
    this.versionProbeRetryDelayMs = opts?.versionProbeRetryDelayMs ?? DEFAULT_VERSION_PROBE_RETRY_DELAY_MS;
    this.driftStabilityMs = opts?.driftStabilityMs ?? DEFAULT_DRIFT_STABILITY_MS;
    this.toolsProbeTimeoutMs = opts?.toolsProbeTimeoutMs ?? DEFAULT_TOOLS_PROBE_TIMEOUT_MS;
    this.portReportTimeoutMs = opts?.portReportTimeoutMs ?? DEFAULT_PORT_REPORT_TIMEOUT_MS;
    if (opts?.port != null) {
      // Test-only: exercise the control-plane client against a fake HTTP server with no real spawn.
      this.port = opts.port;
      this.alive = true;
    }
    if (opts?.seedProjectId) {
      // Test-only — see the opt's own doc.
      this.projectIds.set(repoKey(opts.seedProjectId.repoRoot), opts.seedProjectId.projectId);
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

  /** Test seam — see {@link completedProbeTicks}. */
  getCompletedProbeTickCount(): number {
    return this.completedProbeTicks;
  }

  /** Test seam — see {@link spawnCount}. */
  getSpawnCount(): number {
    return this.spawnCount;
  }

  /** Diagnostic/test seam — see {@link portReportCapable}. `null` until the first spawn attempt that
   *  needed an answer has resolved it either way. */
  getPortReportCapable(): boolean | null {
    return this.portReportCapable;
  }

  /** Test seam — see {@link versionProbeAttempts}. */
  getVersionProbeAttemptCount(): number {
    return this.versionProbeAttempts;
  }

  /**
   * Test seam — the RESOLVED ceiling (default or test-overridden) {@link readInstalledBuild}'s retry loop
   * is actually bounded by, so a test can assert against the real value the code enforces instead of a
   * hardcoded literal that silently decouples the day the default is retuned.
   */
  getVersionProbeMaxAttempts(): number {
    return this.versionProbeMaxAttempts;
  }

  /** Diagnostic/test seam — see {@link driftCheckState}. `null` before the first probe tick completes. */
  getDriftCheckState(): DriftCheckState | null {
    return this.driftCheckState;
  }

  /**
   * Card ce1bed6e: the served_status-facing detail {@link getDriftCheckState} deliberately never carried
   * (see that method's own doc — it is a coarse diagnostic/test seam). Computed fresh from the SAME
   * instance fields {@link checkBuildDrift} maintains on every probe tick — never cached separately, so
   * it cannot go stale relative to the next tick.
   */
  getDriftDetail(): CodescapeDriftDetail {
    const state = this.driftCheckState;
    if (state !== "mismatch") {
      return { state, installedBuild: null, runningBuild: null, restartExhausted: false, remainingMs: null, driftStabilityMs: this.driftStabilityMs, message: null };
    }
    const installedBuild = this.lastMismatchInstalledBuild;
    const runningBuild = this.lastMismatchRunningBuild;
    const restartExhausted = installedBuild != null && installedBuild === this.lastDriftRestartInstalledBuild;
    if (restartExhausted) {
      return {
        state, installedBuild, runningBuild, restartExhausted, remainingMs: null, driftStabilityMs: this.driftStabilityMs,
        message: `codescape serve build drift UNRESOLVED (running "${runningBuild}" != installed "${installedBuild}") — its one restart for this installed build is already spent; rebuilding the SAME commit again will NOT open a new allowance, only a genuinely DIFFERENT installed build (or a daemon restart) will.`,
      };
    }
    let remainingMs: number | null = null;
    if (this.driftCandidateBuild === installedBuild && this.driftCandidateFirstSeenAt != null) {
      remainingMs = Math.max(0, this.driftStabilityMs - (Date.now() - this.driftCandidateFirstSeenAt));
    }
    const message = remainingMs == null ? null :
      `codescape serve build drift pending restart (running "${runningBuild}" != installed "${installedBuild}") — stable ${formatMinSec(this.driftStabilityMs - remainingMs)} of ${formatMinSec(this.driftStabilityMs)}; rebuilding the SAME commit again does NOT reset this window, only a DIFFERENT installed build does.`;
    return { state, installedBuild, runningBuild, restartExhausted, remainingMs, driftStabilityMs: this.driftStabilityMs, message };
  }

  /** Diagnostic/test seam — see {@link lastToolDriftUnclassified}. `null` before the first tool-drift
   *  probe ever completes. */
  getUnclassifiedTools(): string[] | null {
    return this.lastToolDriftUnclassified;
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
    // Card 194d343d: pin CODESCAPE_HOME explicitly so their resolver's env-first check wins over any
    // upstream cwd-relative walk — see the "★ CWD CONTRACT" doc above this class for why cwd alone is no
    // longer sufficient. Must match `serve`'s own CODESCAPE_HOME (spawnServe) or the two can disagree
    // about where the store lives.
    const r = await runBounded(command, [...args, "ingest", repoPath], this.homeDir, this.ingestTimeoutMs, { ...process.env, CODESCAPE_HOME: this.homeDir });
    if (!r.ok) {
      console.warn(`[codescape] ingest ${repoPath} ${r.timedOut ? "timed out" : `failed (exit ${r.code})`}${r.output ? ` — ${r.output}` : ""}`);
    }
    return { ok: r.ok, outcome: r.ok ? "ready" : r.timedOut ? "timeout" : "failed", errorTail: r.output || undefined };
  }


  /**
   * Start supervision (no-op if disabled or already running/starting): ingests each of `repoPaths` in
   * order (v1 bootstrap — see the CWD CONTRACT), reserves a loopback port, then spawns + supervises
   * `serve`. Async, best-effort: an ingest failure is logged and does NOT abort the boot — serve still
   * starts.
   *
   * @decision b8de5876 — `dbPath` is remembered on {@link codescapePath} for this instance's WHOLE
   * lifetime, not just this call; never re-derive the binary candidate from env/bare-PATH alone on a
   * restart-on-death spawn, or a DB-only-configured host disagrees with itself about enablement.
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
      // Card 4e0df6ce: no pre-pick here any more — `this.port` starts (or, after a stop()/give-up, goes
      // back to) `null`, and `spawnServe()` below decides how to resolve it: self-reporting (the child
      // binds `--port 0` itself and reports the real bound port back on stdout — no window where THIS
      // process holds a port it isn't using) when the installed binary supports it, falling back to the
      // legacy pick-then-close-then-respawn path (the original, narrower TOCTOU) only for a binary
      // confirmed not to.
      this.restartAttempts = 0;
      this.restartTimestamps = [];
      this.lastDriftRestartInstalledBuild = null;
      this.lastInstalledBuildFailureReason = null;
      this.driftCandidateBuild = null;
      this.driftCandidateFirstSeenAt = null;
      this.lastExhaustedDriftAnnounced = null;
      this.driftCheckState = null;
      this.lastMismatchInstalledBuild = null;
      this.lastMismatchRunningBuild = null;
      this.lastHealthAnsweredErrorStatus = null;
      this.lastToolDriftUnclassified = null;
      this.spawnServe();
      this.startHealthMonitor();
      // Card 4e0df6ce: `this.port` is no longer necessarily known synchronously at this point (a capable
      // binary reports it asynchronously off its own stdout) — never log a stale/null value here.
      console.log(`[boot] codescape on (CLI detected at "${codescapeBinCandidate(dbPath)}"; cwd ${this.homeDir}, ${repoPaths.length} project(s) ingested)`);
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

  /** Stop supervision: kills the live child (if any), cancels any pending restart, disarms restart-on-death,
   *  and stops the health-probe timer. */
  stop(): void {
    this.stopped = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.healthProbeTimer) { clearInterval(this.healthProbeTimer); this.healthProbeTimer = null; }
    this.consecutiveHealthFailures = 0;
    this.lastDriftRestartInstalledBuild = null;
    this.lastInstalledBuildFailureReason = null;
    this.driftCandidateBuild = null;
    this.driftCandidateFirstSeenAt = null;
    this.lastExhaustedDriftAnnounced = null;
    this.driftCheckState = null;
    this.lastMismatchInstalledBuild = null;
    this.lastMismatchRunningBuild = null;
    this.lastHealthAnsweredErrorStatus = null;
    this.lastToolDriftUnclassified = null;
    if (this.child) {
      try { this.child.kill(); } catch { /* best-effort */ }
      this.child = null;
    }
    this.alive = false;
    this.port = null;
  }

  /**
   * Spawn `serve` and wire up restart-on-death. Never throws.
   *
   * @decision 4e0df6ce — dispatch: an already-known port reuses it via explicit-port respawn (an
   * accepted, always-DETECTED unbound-window exposure, never silent corruption); `null` uses the
   * self-reporting `--port 0` path unless a confirmed rejection already forced the legacy fallback.
   */
  private spawnServe(): void {
    if (this.stopped) return;
    // Card b8de5876: `this.codescapePath` (set once by `start()`, not re-derived here) so a restart-on-
    // death spawn — which runs from a `setTimeout`, long after `start()`'s own call stack returned — still
    // resolves the SAME dbPath-first candidate the boot gate just checked, instead of silently falling
    // back to env/bare-PATH on every restart.
    const { command, args: baseArgs } = resolveCodescapeBin(this.codescapePath);
    if (this.port != null) {
      this.spawnServeExplicit(command, baseArgs, this.port);
    } else if (this.portReportCapable === false) {
      void this.spawnServeLegacy(command, baseArgs);
    } else {
      this.spawnServeSelfReporting(command, baseArgs);
    }
  }

  /**
   * Spawn the child on the given, ALREADY-DECIDED explicit port. Never throws — BOTH a synchronous spawn
   * failure (thrown from `spawn()` itself) and an asynchronous one (Node's `'error'` event, e.g. ENOENT on
   * a bad `LOOM_CODESCAPE_BIN` — the single most likely real dev failure) are treated as a death:
   * `this.child`/`alive` are cleared and a bounded restart is scheduled. This matters because per Node's
   * own child_process docs, `'error'` and `'exit'` are NOT mutually exclusive — `'exit'` may or may not
   * follow an `'error'` (platform-dependent, esp. on Windows) — so restart-on-death cannot be wired off
   * `'exit'` alone: a spawn that only ever errors would otherwise wedge phantom-alive forever (`getPort()`
   * lying about a serve that never started, and `start()`'s `this.child` guard blocking even a manual
   * recovery attempt) with the give-up diagnostic never firing (CR finding, spawn-FAILURE bug).
   */
  private spawnServeExplicit(command: string, baseArgs: string[], port: number): void {
    const args = [...baseArgs, "serve", "--port", String(port)];
    const child = this.trySpawnChild(command, args);
    if (!child) return;
    this.spawnCount++;
    this.child = child;
    this.alive = true;
    this.spawnedAt = Date.now();
    // A fresh child is presumed responsive — don't let a wedge-count from the PREVIOUS (now-dead) process
    // carry over and trip the threshold after only one or two real probes against the new one.
    this.consecutiveHealthFailures = 0;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const capture = (b: Buffer): void => {
      chunks.push(b);
      bytes += b.length;
      while (bytes > OUTPUT_TAIL_BYTES && chunks.length > 1) bytes -= chunks.shift()!.length;
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    this.wireDeathHandling(child, chunks);
  }

  /**
   * Card 4e0df6ce (legacy fallback, blocker 1): the ORIGINAL pick-then-spawn path, kept ONLY for an
   * installed `serve` confirmed NOT to understand `--port 0` — reserves a port via {@link pickLoopbackPort}
   * (real, narrow TOCTOU — see that function's own doc) once (not on every restart: `this.port` is reused
   * exactly as it always was), then spawns explicitly on it.
   */
  private async spawnServeLegacy(command: string, baseArgs: string[]): Promise<void> {
    if (this.stopped) return;
    let port = this.port;
    if (port == null) {
      try {
        port = await pickLoopbackPort();
      } catch (err) {
        console.warn(`[codescape] could not reserve a loopback port for serve: ${(err as Error).message}`);
        this.spawnedAt = null;
        this.scheduleRestart(false);
        return;
      }
      if (this.stopped) return; // stop() raced the async port pick
      this.port = port;
    }
    this.spawnServeExplicit(command, baseArgs, port);
  }

  /**
   * @decision 4e0df6ce — self-reporting path: spawn with `--port 0`; `this.port` stays `null` (refusing
   * `getPort()`/`request()`) until the report line arrives. Every outcome — parsed, child-death-first, or
   * timeout — ends in {@link scheduleRestart}, never a permanently-stuck attempt.
   */
  private spawnServeSelfReporting(command: string, baseArgs: string[]): void {
    const args = [...baseArgs, "serve", "--port", "0"];
    const child = this.trySpawnChild(command, args);
    if (!child) return;
    this.spawnCount++;
    this.child = child;
    this.spawnedAt = Date.now();
    this.consecutiveHealthFailures = 0;

    const chunks: Buffer[] = [];
    let bytes = 0;
    const capture = (b: Buffer): void => {
      chunks.push(b);
      bytes += b.length;
      while (bytes > OUTPUT_TAIL_BYTES && chunks.length > 1) bytes -= chunks.shift()!.length;
    };
    child.stderr?.on("data", capture);

    let stdoutBuf = "";
    let resolved = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdoutData);
      child.off("exit", onEarlyExit);
      child.off("error", onEarlyError);
    };

    const onStdoutData = (b: Buffer): void => {
      capture(b);
      if (resolved) return;
      stdoutBuf += b.toString("utf-8");
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (resolved || !line) continue;
        const reportedPort = parsePortReportLine(line);
        if (reportedPort != null) {
          resolved = true;
          finish();
          child.stdout?.on("data", capture); // resume plain diagnostic capture past the report line
          this.portReportCapable = true;
          this.port = reportedPort;
          this.alive = true;
          this.wireDeathHandling(child, chunks);
          return;
        }
      }
    };
    child.stdout?.on("data", onStdoutData);

    const onDeathBeforeReport = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (resolved) return;
      resolved = true;
      finish();
      this.child = null;
      this.alive = false;
      this.spawnedAt = null;
      if (this.stopped) return; // an explicit stop() — not a death, no restart
      const tail = Buffer.concat(chunks).toString("utf-8").trim().slice(-OUTPUT_TAIL_BYTES);
      // Card 4e0df6ce: classify by CONTENT, never by (code, signal) alone — on Windows a genuinely
      // external kill (a test, or a manager) goes through TerminateProcess, which surfaces as `code:1,
      // signal:null` on the child's exit event: BYTE-IDENTICAL to what this fixture/binary's own clean
      // `process.exit(1)` rejection produces. `signal` only discriminates on POSIX; requiring the captured
      // output to actually NAME the flag is what makes this safe on both — nothing but a real "--port 0"
      // validation failure would ever write "--port" to this child's own stdout/stderr before dying.
      const looksLikeOldBinaryRejection = this.portReportCapable == null && typeof code === "number" && code !== 0 && /--port/i.test(tail);
      if (looksLikeOldBinaryRejection) {
        this.portReportCapable = false;
        console.warn(`[codescape] serve exited (code ${code}) before reporting a bound port — treating as an installed codescape that doesn't support "--port 0" and falling back to the legacy explicit-port path${tail ? `\n${tail}` : ""}`);
      } else {
        console.warn(`[codescape] serve exited (code ${code ?? "null"}, signal ${signal ?? "null"}) before reporting a bound port — scheduling restart${tail ? `\n${tail}` : ""}`);
      }
      this.scheduleRestart(false); // never "healthy" — it died before ever confirming a live port
    };
    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null): void => onDeathBeforeReport(code, signal);
    const onEarlyError = (): void => onDeathBeforeReport(null, null);
    child.on("exit", onEarlyExit);
    child.on("error", onEarlyError);

    timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      finish();
      console.warn(`[codescape] serve did not report a bound port within ${this.portReportTimeoutMs}ms — abandoning this attempt (capability unresolved)`);
      this.child = null;
      this.alive = false;
      this.spawnedAt = null;
      try { child.kill(); } catch { /* best-effort */ }
      if (!this.stopped) this.scheduleRestart(false);
    }, this.portReportTimeoutMs);
  }

  /**
   * Attempt `spawn()`, logging + scheduling a bounded restart on a SYNCHRONOUS failure and returning
   * `null`.
   *
   * @decision d671f1b8 — deliberately NON-detached (Windows job-object kill-on-close ties this
   * child to the parent daemon's lifetime; POSIX instead reparents on death, which is why `index.ts`'s
   * shutdown path calls `stop()` explicitly).
   *
   * @decision 194d343d — pins `CODESCAPE_HOME` explicitly, must match `ingest()`'s own value.
   */
  private trySpawnChild(command: string, args: string[]): ChildProcess | null {
    try {
      return spawn(command, args, { cwd: this.homeDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CODESCAPE_HOME: this.homeDir } });
    } catch (err) {
      console.warn(`[codescape] serve spawn failed: ${(err as Error).message}`);
      // Never a "healthy" run — a synchronous throw means no child ever came up. Clearing spawnedAt (it
      // may still hold a PRIOR successful spawn's timestamp) stops that stale value from making an
      // immediate, repeated failure look "healthy" to scheduleRestart's caller below (CR bug (b)).
      this.spawnedAt = null;
      this.scheduleRestart(false);
      return null;
    }
  }

  /**
   * Wire the standard "this child is now the live, port-known serve" death handling — shared by both
   * {@link spawnServeExplicit} and {@link spawnServeSelfReporting} (once a report has confirmed the port).
   * `settled` guards against 'error' and 'exit' BOTH firing for the same death (Node's docs warn this can
   * happen) — without it a double-fire would double-schedule a restart / double-decrement state.
   */
  private wireDeathHandling(child: ChildProcess, chunks: Buffer[]): void {
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

  /**
   * Schedule a bounded-backoff restart; `ranHealthy` resets the backoff schedule so a long-lived healthy
   * process that dies once isn't permanently penalised by ancient restart history. Gives up once EITHER
   * of two independent ceilings is reached: (1) the backoff schedule ({@link restartBackoffMs}) is
   * exhausted without a healthy run resetting it, or (2) the restart-RATE ceiling
   * ({@link maxRestartsPerWindow} within {@link restartWindowMs}) is hit — a ceiling `ranHealthy` cannot
   * clear.
   *
   * @decision 4c7a337d — this rate ceiling exists because `ranHealthy` resets `restartAttempts` on
   * essentially every death for a crash loop slower than {@link DEFAULT_HEALTHY_RUN_MS}, making
   * backoff-exhaustion alone unreachable; the rate-window ceiling must stay in place alongside it.
   *
   * @decision 44d45f81 — repeated `spawnServeSelfReporting` timeouts (each a non-healthy death) DO feed
   * this same give-up arithmetic; the raised port-report timeout only makes reaching it much harder,
   * never impossible.
   */
  private scheduleRestart(ranHealthy: boolean): void {
    if (this.stopped) return;
    if (ranHealthy) this.restartAttempts = 0;

    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < this.restartWindowMs);
    const backoffExhausted = this.restartAttempts >= this.restartBackoffMs.length;
    const rateExceeded = this.restartTimestamps.length >= this.maxRestartsPerWindow;
    if (backoffExhausted || rateExceeded) {
      const reason = rateExceeded
        ? `${this.restartTimestamps.length} restarts within ${Math.round(this.restartWindowMs / 1000)}s (rate ceiling — independent of any "healthy run" reset)`
        : `${this.restartAttempts} restart attempt(s)`;
      console.error(`[codescape] gave up after ${reason} — codescape serve is DOWN (check LOOM_CODESCAPE_BIN / the codescape install; needs a human)`);
      this.port = null;
      return;
    }

    this.restartTimestamps.push(now);
    const delay = this.restartBackoffMs[this.restartAttempts];
    this.restartAttempts++;
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.spawnServe(); }, delay);
  }

  /**
   * Start the periodic `GET /graph/health` liveness probe — idempotent, and ARMED UNCONDITIONALLY
   * whenever {@link start} spawns `serve`, including with ZERO codescape-enabled projects.
   * @decision sha:e2d23231 — a prior project-count gate left a zero-project boot with this probe
   * never armed at all for its entire lifetime.
   */
  private startHealthMonitor(): void {
    if (this.healthProbeTimer) return;
    this.healthProbeTimer = setInterval(() => { void this.probeHealth(); }, this.healthProbeIntervalMs);
  }

  /**
   * One `/graph/health` check — closes the "alive but wedged" blind spot `child.on("exit")` alone can't
   * see.
   *
   * @decision 545ef479 — an answered-but-not-ok response (e.g. a 5xx) is proof of life, NEVER wedge
   * evidence; only a SUSTAINED run of genuine no-answer failures counts, and a sustained wedge kill must
   * route through the existing exit → `scheduleRestart` path, never open a second restart channel.
   */
  private async probeHealth(): Promise<void> {
    if (this.stopped || !this.alive || this.probeInFlight) return;
    this.probeInFlight = true;
    try {
      const res = await this.request("GET", "/graph/health", undefined, this.healthProbeTimeoutMs);
      // stop() may have raced this in-flight probe (its fetch was already underway when stop() ran) —
      // abandon silently rather than act on a dead instance (no stray warn/kill after stop()).
      if (this.stopped) return;
      if (res.ok) {
        this.consecutiveHealthFailures = 0;
        if (this.lastHealthAnsweredErrorStatus != null) {
          console.warn(`[codescape] /graph/health recovered — was answering HTTP ${this.lastHealthAnsweredErrorStatus}, now 200`);
          this.lastHealthAnsweredErrorStatus = null;
        }
        await this.checkBuildDrift(res.json);
        // Card ce1bed6e: same freshness discipline as checkToolDrift's own writeToolDriftState call below —
        // persist on EVERY successful round-trip, even a "nothing to report" result (getDriftDetail()'s
        // message:null case), so a since-resolved drift doesn't linger stale in what
        // readCodescapeBuildDriftNote reads back. Reads whatever checkBuildDrift just set, regardless of
        // which of its internal branches fired this tick.
        writeBuildDriftState(this.homeDir, { checkedAt: new Date().toISOString(), message: this.getDriftDetail().message });
        await this.checkToolDrift();
        return;
      }
      if (res.status != null) {
        // Card 545ef479 (Defect 2): a response ARRIVED — even an error one (e.g. a 500 from a route that
        // can't determine something) — which is proof the process is ALIVE and serving. That is the
        // opposite of wedge evidence (only a genuine no-answer — timeout/connection failure — is), so this
        // does NOT count toward consecutiveHealthFailures and must never reach the kill below. It also does
        // NOT call checkBuildDrift: `res.json` was never a trustworthy health payload, and widening `res.ok`
        // to accept 5xx would silently re-enable drift-checking on a body we could not parse — this is its
        // own third outcome, not a relaxed version of either existing one. Latched so the fact is reported
        // ONCE per distinct status, not on every ~30s tick forever.
        //
        // Card 23980bbf: same latched-transition ambiguity as announceDriftCheckState — this line only
        // fires once per distinct status, so a sustained error can sit silent for a long time afterward.
        // Say so explicitly (plus the resolved probe cadence) rather than let the gap read as either "the
        // probe stopped" or "the probe cadence is this sparse".
        this.consecutiveHealthFailures = 0;
        if (res.status !== this.lastHealthAnsweredErrorStatus) {
          this.lastHealthAnsweredErrorStatus = res.status;
          console.warn(`[codescape] /graph/health answered HTTP ${res.status} (process alive and serving, just couldn't determine something) — NOT counted as a wedge; only a no-answer is wedge evidence. Probed every ${formatIntervalMs(this.healthProbeIntervalMs)}; won't repeat this line while the status stays ${res.status} — only a change (a different status, or recovery to 200) logs again.`);
        }
        return;
      }
      this.consecutiveHealthFailures++;
      if (this.consecutiveHealthFailures < this.healthProbeFailureThreshold) return;
      console.warn(`[codescape] serve health probe failed ${this.consecutiveHealthFailures}x consecutively (alive but unresponsive) — killing for restart`);
      this.consecutiveHealthFailures = 0;
      const child = this.child;
      if (child) { try { child.kill(); } catch { /* the exit/error handler still drives the restart path if the signal lands */ } }
    } finally {
      this.probeInFlight = false;
      this.completedProbeTicks++;
    }
  }

  /**
   * @decision 350bc307 — a real `tools/list` round-trip against the RUNNING mounted server, layered onto
   * a successful health probe: async, bounded, best-effort, never blocks a spawn/boot/gate. Always
   * persists on a successful round-trip even when empty, and logs the finding line only on a transition.
   */
  private async checkToolDrift(): Promise<void> {
    const port = this.getPort();
    if (port == null) return;
    const projectId = this.projectIds.values().next().value;
    if (!projectId) return; // nothing registered yet to probe against — clean skip, not a failure
    const res = await probeAdvertisedTools(`http://127.0.0.1:${port}/mcp/${projectId}`, this.toolsProbeTimeoutMs);
    if (this.stopped) return; // stop() may have raced this in-flight probe — abandon silently
    if (!res.ok || !res.tools) return; // couldn't check this tick — leave prior persisted state as-is
    // Card 76a57ff3: res.tools is already normalized to the mcp__codescape__-prefixed namespace by
    // probeAdvertisedTools (see its own doc / CODESCAPE_TOOL_PREFIX) — the SAME namespace
    // CODESCAPE_TOOL_ALLOW/CODESCAPE_WRITE_TOOLS store, so no re-normalization belongs here.
    const unclassified = codescapeUnclassifiedTools(res.tools);
    writeToolDriftState(this.homeDir, { checkedAt: new Date().toISOString(), unclassified, advertisedCount: res.tools.length });
    const changed = JSON.stringify(unclassified) !== JSON.stringify(this.lastToolDriftUnclassified);
    if (changed) {
      if (unclassified.length > 0) {
        console.warn(`[codescape] tool-drift check: the running server advertises ${unclassified.length} tool(s) not classified as read or write in pty/host.ts: ${unclassified.join(", ")} — flagged to the Platform Lead's next kickoff.`);
      } else if (this.lastToolDriftUnclassified !== null && this.lastToolDriftUnclassified.length > 0) {
        console.warn(`[codescape] tool-drift check: recovered — the previously-flagged tool(s) are now classified.`);
      }
      this.lastToolDriftUnclassified = unclassified;
    }
  }

  /**
   * Test seam: run ONE {@link checkToolDrift} pass directly, without waiting on the real
   * {@link healthProbeIntervalMs} timer (itself only armed inside a real {@link start} spawn) —
   * exercises the SAME production code path (`port`/`seedProjectId` test seams feed it a fake server +
   * project id) a live health-probe tick would run, hermetically. A genuine health-probe tick only ever
   * runs while {@link stopped} is false (set by a real `start()`); simulating "one tick happened" without
   * a real spawn means this seam must establish that same precondition itself, so it flips `stopped`
   * false for the duration of this ONE call — never touches it otherwise, and never affects a real
   * `start()`/`stop()` sequence a test may run around it.
   */
  async runToolDriftProbeForTest(): Promise<void> {
    const wasStopped = this.stopped;
    this.stopped = false;
    try {
      await this.checkToolDrift();
    } finally {
      this.stopped = wasStopped;
    }
  }

  /**
   * @decision 545ef479 — every exit path (including the two silent no-ops: running build absent, honest
   * installed `null`) must latch a {@link DriftCheckState} via `announceDriftCheckState`, or "finding
   * nothing" becomes indistinguishable from "inert".
   *
   * @decision 90550a97 — compares `build` (a SHA), NEVER `healthJson.version` (a static semver that never
   * changes); a genuine mismatch kills the child once via the existing exit → `scheduleRestart` path, and
   * `lastDriftRestartInstalledBuild` must gate a second restart for the same installed build.
   *
   * @decision 9e6f984d — a genuine mismatch waits for the installed build to sit stable for
   * {@link driftStabilityMs} before restarting, so a burst of rebuilds collapses into one restart, not N.
   */
  /**
   * @decision 23980bbf — latch-and-announce a {@link DriftCheckState} TRANSITION only, never every probe
   * tick, and always fold in the RESOLVED {@link healthProbeIntervalMs} (never the hardcoded default) so
   * the true poll cadence is derivable from the log alone.
   */
  private announceDriftCheckState(state: DriftCheckState): void {
    if (state === this.driftCheckState) return;
    this.driftCheckState = state;
    console.log(`[codescape] drift-check state: ${state} (checked every ${formatIntervalMs(this.healthProbeIntervalMs)}; this line only logs on a state CHANGE, not every check)`);
  }

  private async checkBuildDrift(healthJson: unknown): Promise<void> {
    const runningBuild = (healthJson as { build?: unknown } | null)?.build;
    if (typeof runningBuild !== "string" || runningBuild.length === 0) {
      // Card 545ef479 (Defect 1): this used to be a bare, silent early return — byte-identical downstream
      // to a steady-state MATCH (also silent) and to an honest installed-side null (also silent below).
      // "Drift detection is running and finding nothing" must never be indistinguishable from "drift
      // detection is inert" — announce the transition (latched, not every tick).
      this.announceDriftCheckState("not-checked:running-absent");
      return; // absent or null -> no-op
    }
    const installed = await this.readInstalledBuild();
    // stop() may have raced this in-flight read (the version-probe subprocess was already spawned when
    // stop() ran) — abandon silently. Otherwise a stray warn/kill could land on an already-dead instance,
    // arbitrarily late (bounded only by versionProbeTimeoutMs), long after the caller believes it's inert.
    if (this.stopped) return;
    if (installed.failed) {
      // A genuine read FAILURE (non-zero exit, or malformed/unparseable stdout at exit 0) — fail-safe
      // behavior is UNCHANGED (still never restart), only the reporting changes. The dominant observed
      // cause is a version-probe TIMEOUT under boot/host contention, not a broken install — see card
      // f0718488. Latched so a sustained failure logs ONCE, not on every ~30s probe tick forever; a NEW
      // reason (or the read recovering, which resets the latch below) is always reported again. The latch
      // is a per-instance field reset in start()/stop() — verified called at most once each per daemon
      // process (constructed + started once at boot in index.ts, never stopped in normal operation) — so
      // in practice this also means "not again this daemon's lifetime".
      this.announceDriftCheckState("not-checked:installed-read-failed");
      if (installed.reason !== this.lastInstalledBuildFailureReason) {
        console.warn(`[codescape] cannot read the INSTALLED build id — drift detection is inert until this resolves (${installed.reason}). Won't repeat this warning again this daemon lifetime unless the reason changes.`);
        this.lastInstalledBuildFailureReason = installed.reason ?? null;
      }
      return;
    }
    if (this.lastInstalledBuildFailureReason != null) {
      // Card ebd755ab (Gap 2): announce the recovery transition — without this, "was inert, now
      // resolved" logs nothing and reads identically to "still inert" (this already caused a wrong
      // cross-project diagnosis in production, see the card). Fires only on the was-latched -> clear
      // transition, never on an ordinary successful read.
      console.warn(`[codescape] drift detection recovered — installed build id is readable again (was inert: ${this.lastInstalledBuildFailureReason})`);
    }
    this.lastInstalledBuildFailureReason = null; // any non-failed read (a real build OR an honest null) resets the latch
    if (installed.build == null) {
      // Card 545ef479 (Defect 1): same silent-collapse hazard as the running-absent branch above — an
      // HONEST "no build id available" answer stays a fail-safe no-op (never a failure to report), but the
      // STATE is now announced (latched) so it reads distinguishably from MATCH rather than as more silence.
      this.announceDriftCheckState("not-checked:installed-null");
      return;
    }
    const installedBuild = installed.build;
    if (installedBuild === runningBuild) {
      this.announceDriftCheckState("match");
      // The running side has caught up (or the installed side moved back to it) — nothing left to watch.
      // Clears any in-progress stability window so a LATER new drift starts a fresh one, not a stale one.
      this.driftCandidateBuild = null;
      this.driftCandidateFirstSeenAt = null;
      // Card ce1bed6e: a resolved drift has nothing left for getDriftDetail() to report.
      this.lastMismatchInstalledBuild = null;
      this.lastMismatchRunningBuild = null;
      if (this.lastExhaustedDriftAnnounced != null) {
        // Card ebd755ab (Gap 1 reset): the pair we'd previously announced as permanently unresolved has
        // now resolved — announce the recovery so it isn't indistinguishable from "still unresolved".
        console.warn(`[codescape] serve build drift RESOLVED (installed build "${runningBuild}" now matches running) — was unresolved after its one restart was already spent`);
        this.lastExhaustedDriftAnnounced = null;
      }
      return;
    }
    this.announceDriftCheckState("mismatch");
    // Card ce1bed6e: set unconditionally, BEFORE the exhausted-guard/stability-window branches below —
    // getDriftDetail() needs this pair populated in EVERY mismatch sub-state, including the
    // already-exhausted UNRESOLVED one, where driftCandidateBuild itself is never (re)set for this build.
    this.lastMismatchInstalledBuild = installedBuild;
    this.lastMismatchRunningBuild = runningBuild;
    if (installedBuild === this.lastDriftRestartInstalledBuild) {
      // Card ebd755ab (Gap 1): the one-restart-per-build guard is correct policy (unchanged below) — the
      // defect was that this path returned silently forever, making a permanently-broken deploy
      // byte-identical in the log to a healthy no-drift steady state. Latched per distinct
      // (installedBuild, runningBuild) pair so this fires ONCE, not on every ~30s probe tick.
      const pairKey = `${installedBuild}|${runningBuild}`;
      if (this.lastExhaustedDriftAnnounced !== pairKey) {
        this.lastExhaustedDriftAnnounced = pairKey;
        console.warn(`[codescape] serve build drift UNRESOLVED (running "${runningBuild}" != installed "${installedBuild}") — its one restart is already spent for this daemon's lifetime; a fresh allowance opens only if the installed build changes or the daemon restarts. Won't repeat this diagnostic until one of those happens.`);
      }
      return; // already gave THIS installed build its one restart
    }
    const now = Date.now();
    if (installedBuild !== this.driftCandidateBuild) {
      // A NEW mismatched build (first sighting, or the watched candidate just changed) — start (or
      // restart) the stability window; do not restart yet. Logged ONCE here, not on every tick spent
      // waiting for the window to elapse below.
      this.driftCandidateBuild = installedBuild;
      this.driftCandidateFirstSeenAt = now;
      console.warn(`[codescape] serve build drift detected (running "${runningBuild}" != installed "${installedBuild}") — deferring restart until the installed build has been stable for ${this.driftStabilityMs}ms`);
      return;
    }
    if (now - (this.driftCandidateFirstSeenAt ?? now) < this.driftStabilityMs) return; // still within the stability window
    console.warn(`[codescape] serve build drift STABLE (running "${runningBuild}" != installed "${installedBuild}", unchanged for >= ${this.driftStabilityMs}ms) — killing for restart`);
    this.lastDriftRestartInstalledBuild = installedBuild;
    this.driftCandidateBuild = null;
    this.driftCandidateFirstSeenAt = null;
    const child = this.child;
    if (child) { try { child.kill(); } catch { /* the exit/error handler still drives the restart path if the signal lands */ } }
  }

  /**
   * Read the INSTALLED codescape binary's own build id — bounded + async via {@link runBoundedSplit}
   * (stdout/stderr must stay separate here, unlike `ingest()`'s shared `runBounded`).
   *
   * @decision 90550a97 — AGREED CONTRACT with the Codescape manager: parse strictly (never lenient/
   * substring), and never read their internal `dist/buildInfo.generated.js` directly — an unversioned
   * coupling that breaks silently the moment they reshape their build output.
   */
  private async readInstalledBuild(): Promise<{ build: string | null; failed: boolean; reason?: string }> {
    const { command, args } = resolveCodescapeBin(this.codescapePath);
    let r: SplitRunResult = { ok: false, code: null, timedOut: false, stdout: "", stderr: "" };
    let attempt = 0;
    // @decision f0718488 — retry ONLY a TIMED-OUT attempt (a real binary failure is never retried); do
    // not retune versionProbeMaxAttempts/versionProbeTimeoutMs/versionProbeRetryDelayMs without redoing
    // the worst-case-budget arithmetic against healthProbeIntervalMs (only ~9.5s of margin today).
    while (true) {
      attempt++;
      this.versionProbeAttempts++;
      r = await runBoundedSplit(command, [...args, "--version"], this.homeDir, this.versionProbeTimeoutMs);
      if (!r.timedOut || attempt >= this.versionProbeMaxAttempts) break; // success, a genuine non-timeout failure, or attempts exhausted
      await sleep(this.versionProbeRetryDelayMs);
    }
    if (!r.ok) {
      return { build: null, failed: true, reason: `"${command} --version" ${r.timedOut ? `timed out (${attempt} attempt${attempt === 1 ? "" : "s"})` : `failed (exit ${r.code ?? "null"})`}${r.stderr ? ` — ${r.stderr}` : ""}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      // Guarantee violated: stdout was supposed to be clean JSON at exit 0. A REAL defect on their side —
      // never silently rescued by a lenient/substring parser (see this function's own doc above).
      return { build: null, failed: true, reason: `"${command} --version" exited 0 but stdout was not valid JSON: ${r.stdout || "(empty)"}` };
    }
    const build = (parsed as { build?: unknown } | null)?.build;
    if (typeof build === "string" && build.length > 0) return { build, failed: false };
    if (build === null) return { build: null, failed: false }; // the HONEST "no build id" answer — not a failure
    return { build: null, failed: true, reason: `"${command} --version" returned a malformed "build" field: ${r.stdout || "(empty)"}` };
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
      // `controller.abort()` is called from EXACTLY ONE place — the timer above — so `signal.aborted`
      // being true here is proof this catch was reached because OUR OWN `timeoutMs` bound elapsed, not a
      // network-level failure (DNS, ECONNREFUSED, a reset). Card daaf7fc9: distinguishing this from every
      // other request failure is the whole point — a client-side abort tells you nothing about whether
      // codescape's own processing (which does NOT get cancelled by us hanging up, confirmed server-side)
      // went on to succeed or fail; it is a fact about OUR patience, not about codescape.
      if (controller.signal.aborted) {
        return { ok: false, error: `client-side abort — no response within our own ${timeoutMs}ms bound`, timedOut: true };
      }
      return { ok: false, error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `POST /project` `{repoRoot, graphPath?}` — codescape's fleet-daemon dynamic registration (commit
   * `669548e`, confirmed merged/live), idempotent (already-registered/attached/ingested).
   *
   * @decision 088afc94 — never throws; a failure must leave the caller on the cold manifest fallback,
   * never block boot. Caches the AUTHORITATIVE `id` on success so `resolveProjectId` skips a re-read.
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
   * A few quick retries around {@link registerProject}, for the BOOT-TIME call in {@link start} only —
   * closes a listener-not-up-yet race.
   *
   * @decision 088afc94 — bound PER ATTEMPT at the FAST `registerTimeoutMs`, never the long
   * `ingestTimeoutMs` — this race fails fast (ECONNREFUSED), so a long bound only risks repeating the
   * retry-over-a-hung-operation shape of card `bd9fc808`. Boot itself is never blocked by this.
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
   * Resolve codescape's project id for `repoRoot` — the ONE seam every caller should use. Checks this
   * instance's in-memory cache first, falling back to the COLD manifest-by-path read on a miss (kept
   * deliberately, since `POST /project` can fail transiently while the manifest still resolves).
   *
   * @decision 088afc94 — a manifest HIT is cached forever (this is the spawn hot path — no blocking
   * reads); a MISS must expire after {@link PROJECT_ID_NEGATIVE_CACHE_TTL_MS}, or a repo enabled after
   * boot never gets picked up without a restart.
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

  /**
   * `POST /project/<id>/reingest-main` — bounded at {@link DEFAULT_REINGEST_TIMEOUT_MS} (see that
   * constant's doc for the measured warm/cold blocking times, as-of stamp, and why the bound is sized
   * around observability rather than survival).
   */
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
