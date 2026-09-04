import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { resolveCodescapeConfig, type ProjectConfigOverride } from "@loom/shared";
import { CODESCAPE_HOME_DIR, isCodescapeSupervisorEnabled, isLoomDev, resolveCodescapeBin, codescapeBinCandidate } from "../paths.js";
import { resolveCodescapeProjectId } from "./manifest.js";
import { probeAdvertisedTools } from "./tools-probe.js";
import { writeToolDriftState } from "./drift-notice.js";
import { codescapeUnclassifiedTools } from "../pty/host.js";

/**
 * Codescape fleet-daemon wiring epic (`369dde3c`), card C1 — FOUNDATION, updated by card 503a30a0. Under
 * `isCodescapeSupervisorEnabled()` (isLoomDev() + a codescape CLI actually detected on the host — see
 * paths.ts; codescape is a private internal tool, so this is a non-discoverable, config/host-driven gate,
 * not a hand-set env toggle), Loom starts + supervises ONE `codescape serve` process per host on a
 * loopback port, bootstrapped by `codescape ingest <repoPath>` for each target project BEFORE serve starts
 * (v1: projects load from `.codescape/projects/index.json` at serve BOOT — a project ingested after serve
 * started isn't picked up until a restart).
 *
 * ★ CWD CONTRACT (load-bearing) — UPDATED, card 194d343d: `ingest` and `serve` no longer resolve their
 * `.codescape` state dir purely from `process.cwd()` — as of their `e23c2cb`, a missing `.git` in cwd
 * makes them WALK UP looking for one, which can silently re-anchor the store outside `homeDir` (this bit
 * us: our cwd, `<LOOM_HOME>/codescape`, has no `.git`, so the walk climbed to `<LOOM_HOME>` and anchored
 * there instead). We now pin the store explicitly via `CODESCAPE_HOME=<homeDir>` in the spawn env on
 * BOTH `ingest` and `serve` (their resolver checks the env var FIRST, ahead of any cwd walk) — that is
 * the load-bearing guarantee going forward. Running both spawns from the same `homeDir` as `cwd` is kept
 * as belt-and-braces, but is **not sufficient on its own**: cwd alignment cannot prevent an upstream
 * resolution change from walking past it. Every spawn — ingest and serve alike — must still carry the
 * SAME `homeDir` (default {@link CODESCAPE_HOME_DIR}, `<LOOM_HOME>/codescape`) as both `cwd` and
 * `CODESCAPE_HOME`, or serve will never see what ingest wrote.
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
/**
 * Bound (ms) for reingest-main. AS-OF 2026-08-04 against Codescape sha `439e65f`: endpoint blocking
 * time (client fetch issue -> response, covering `getWarmProject` + queue wait + `ingestRepo`) measured
 * BIMODAL — ~13-19s warm, ~24-29s cold (a cold reingest rebuilds the same ts-morph `Project` as
 * {@link DEFAULT_INGEST_TIMEOUT_MS}'s initial ingest) — which mode fires is not a property of the
 * request; it depends on what another tenant last touched. The prior "blocks ~9-11s" figure this bound
 * was derived from was never re-measured and was off by 2.5-3x.
 *
 * CORPUS: presumed the Loom repo (the project this reingest-main call re-indexes — see
 * `service.ts` `fireCodescapeReingest`), but the exact corpus sha/commit and a size proxy (file count or
 * similar) were NOT recorded alongside the timing figures above and could not be recovered after the
 * fact. Ingest time scales with corpus size, not just tool version, so these figures are NOT safely
 * comparable once this repo has grown materially past whatever size it was at measurement time — an
 * unpinned population, stated honestly, rather than silently omitted.
 *
 * Aligned to {@link DEFAULT_INGEST_TIMEOUT_MS} (120s) rather than re-deriving a tighter number: the call
 * ({@link CodescapeSupervisor.reingestMain}) is fire-and-forget from a caller that never awaits it (see
 * `service.ts` `fireCodescapeReingest`), and codescape's own route has no cancellation wiring — our abort
 * closes only OUR socket, their ingest runs to completion regardless. So a tight bound buys us nothing by
 * being tight: it only decides whether we're still listening when the (server-side unobserved either way)
 * answer arrives. Sizing around SURVIVAL of a single mode invites exactly this staleness; sizing around
 * OBSERVABILITY of the slower mode does not. The tail beyond the measured range is UNMEASURED on this
 * host — this is a floor on the sample maximum, not a proven ceiling.
 *
 * A liveness/progress-based bound (indifferent to which mode fires) would be the more principled SHAPE,
 * but codescape's reingest-main route reports no partial progress to key off, and building one is out of
 * this fix's scope (our client half only) — flagged as a follow-up, not attempted here.
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
 * Card 4e0df6ce: bound (ms) for the self-reporting `--port 0` capability probe embedded in the FIRST spawn
 * attempt of this instance's life (and any later attempt after {@link CodescapeSupervisor.port} goes back
 * to `null` — a `stop()`/restart-give-up). How long we wait for EITHER the reported-bound-port stdout line
 * (see {@link parsePortReportLine}) OR the child's own exit before concluding the attempt is ambiguous and
 * falling back to a scheduled restart (never left permanently unresolved).
 *
 * Card 44d45f81 RAISED this from the original 5_000: `4e0df6ce`'s reasoning ("a capable `serve` reports
 * essentially at bind time") was measured FALSE under real host contention and caused a live production
 * regression — two live, functioning `serve` attempts abandoned on the FIRST boot after deploying that
 * constant. Measured directly against the REAL installed binary (never the fixture, which reports
 * instantly and so cannot exercise this bound at all — same family as this project's standing real-spawn
 * rule): quiet host, n=8, 765-836ms; under synthetic CPU load oversubscribing 16 logical cores 18x, n=6,
 * 2442-3557ms; oversubscribing ~2.5x (40 workers), n=9 across two batches, 975-7942ms — several runs
 * already past the OLD 5_000ms bound. A byte-level trace under that same load showed essentially ALL of
 * the elapsed time lands BEFORE the child writes its first byte (module load + graph-store open); the gap
 * from first byte to the report line itself was consistently under 100ms. That rules out an idle-reset
 * bound as an improvement here — there is no trickle of progress output partway through to reset against,
 * the delay is one unbroken block up front — so a larger absolute wall-clock bound is the correct
 * SHAPE, not just the easy one. 20_000ms is real headroom (>2.5x the worst synthetically-measured value)
 * over host contention well beyond what produced the production incident, while still bounding a
 * genuinely-stuck spawn to a human-noticeable wait rather than removing the bound (`spawnServeSelfReporting`'s
 * own doc commits to "never a permanently-stuck attempt"). Deliberately NOT mirroring the short
 * already-alive-server probe bounds elsewhere in this file ({@link DEFAULT_VERSION_PROBE_TIMEOUT_MS} et
 * al.) — those probe a server that's already up and answering fast; this one waits out a COLD START, a
 * fundamentally different cost that scales with host contention far more steeply.
 */
const DEFAULT_PORT_REPORT_TIMEOUT_MS = 20_000;
/**
 * Card 4c7a337d: the sliding window (ms) {@link DEFAULT_MAX_RESTARTS_PER_WINDOW} is measured over — see
 * that constant's own doc for what this pair exists to fix.
 */
const DEFAULT_RESTART_WINDOW_MS = 60 * 60_000;
/**
 * Card 4c7a337d: a SECOND, independent ceiling on restarts, measured over a sliding
 * {@link DEFAULT_RESTART_WINDOW_MS} — this one CANNOT be cleared by `ranHealthy`, unlike
 * `restartAttempts` above.
 *
 * THE BUG THIS CLOSES: `scheduleRestart`'s `if (ranHealthy) this.restartAttempts = 0` is legitimate
 * policy for a long-lived healthy process that dies once — it shouldn't be permanently penalised by
 * ancient restart history. But it has no notion of CADENCE: any kill that recurs on a period LONGER than
 * `healthyRunMs` (30s by default) sees `ranHealthy` true on essentially every single death, so
 * `restartAttempts` resets to 0 before it can ever reach `restartBackoffMs.length` — the give-up ceiling
 * becomes structurally unreachable, and the loud "codescape serve is DOWN … needs a human" diagnostic
 * never fires. Measured directly against this exact defect (card 4c7a337d): 12 -> 30 spawns over 3s with
 * zero give-ups, and separately 92 kill cycles over 30s with zero give-ups.
 *
 * This window-based count is orthogonal to `ranHealthy`/`restartAttempts` entirely — it just asks "how
 * many times has `serve` actually been restarted recently", independent of whether any individual run
 * happened to clear the `healthyRunMs` bar. A single isolated restart (the legitimate case the
 * `ranHealthy` reset exists to protect) never comes close to this ceiling; only a GENUINE, sustained
 * crash loop — on ANY cadence, not just one faster than `healthyRunMs` — does.
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
   * Card ebd755ab (Gap 1): the `(installedBuild, runningBuild)` pair — joined as a single string key —
   * for which the exhausted-restart diagnostic (see the `installedBuild === lastDriftRestartInstalledBuild`
   * branch in {@link checkBuildDrift}) was already announced, or `null` if none. Distinct from
   * {@link lastDriftRestartInstalledBuild} (which gates the RESTART decision, one per installed build):
   * this gates the DIAGNOSTIC decision, latched per distinct pair so a permanently-broken deploy (drift
   * persists forever because its one restart is already spent) logs the "still unresolved" line ONCE, not
   * on every ~30s probe tick forever — before this field existed, that path returned completely silently,
   * making an unresolvable drift byte-identical in the log to a healthy no-drift steady state. Same
   * discriminator-discipline reasoning as {@link lastInstalledBuildFailureReason}. Reset to `null` (and the
   * reset is ANNOUNCED as a recovery — see the `installedBuild === runningBuild` branch) the moment the
   * running side catches up to the installed build again; also reset (silently, matching every other
   * drift-tracking field) on {@link stop}/{@link start} — a fresh supervisor lifetime starts with no
   * diagnostic memory.
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
   * Spawn `serve` and wire up restart-on-death. Never throws. Card 4e0df6ce dispatch:
   *  - {@link port} already known (an ordinary restart-on-death: the previously-live child released it on
   *    exit, and NOTHING in between — us or anyone else — separately bound and closed it) — respawn with
   *    that SAME explicit port, exactly as before this card. This path does not reproduce the bind-close-
   *    rebind pattern above, and is unchanged by this card. It is NOT window-free, though: the port sits
   *    unbound between the dying child's exit and the new child's bind (at least {@link restartBackoffMs}'s
   *    own delay, so longer than {@link pickLoopbackPort}'s own window) — a pre-existing gap, out of scope
   *    here (card 4e0df6ce is scoped to the FIRST-spawn/give-up site below; a follow-up card covers letting
   *    a restart re-derive its port via `--port 0` too).
   *  - {@link port} is `null` (the FIRST spawn of this instance's life, or a fresh attempt after a
   *    `stop()`/give-up nulled it — the ONE site the original TOCTOU actually lived at, see
   *    {@link pickLoopbackPort}'s own doc): use the self-reporting path when the installed binary is
   *    known- or maybe-capable ({@link portReportCapable} `true`/`null`), falling back to the legacy
   *    pick-then-spawn path only once a `--port 0` rejection has confirmed it isn't (card 4e0df6ce
   *    blocker 1 — an older codescape hard-exits on `--port 0` rather than falling back itself).
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
   * Card 4e0df6ce: the self-reporting path — spawn with `--port 0` and let the child pick its own ephemeral
   * port and report it back on stdout (see {@link parsePortReportLine}). Nobody but the child itself ever
   * binds this port, so the original TOCTOU (bind, read, CLOSE, then a SEPARATE process rebinds the same
   * number) cannot occur here. `this.port` stays `null` — so `getPort()`/`request()` correctly refuse
   * ("codescape not running") rather than ever targeting port 0 — until the report line arrives and
   * REASSIGNS it; this satisfies the card's mandatory latent-instance fix (`this.port` reassigned from the
   * reported line before any `request()` can fire).
   *
   * `this.child`/`spawnCount`/`spawnedAt`/`consecutiveHealthFailures` ARE set immediately on a successful
   * spawn, exactly like {@link spawnServeExplicit} — `getPid()`/`getSpawnCount()` stay synchronously
   * accurate; only `port`/`alive` (and therefore `getPort()`) wait on the report.
   *
   * Three outcomes before a report ever arrives:
   *  - the report line parses: confirm {@link portReportCapable}, set `this.port`, hand off to the SAME
   *    {@link wireDeathHandling} an explicit-port spawn uses.
   *  - the child exits/errors first: a CLEAN (no signal) non-zero exit, on a still-UNKNOWN capability, is
   *    the old-binary `--port 0` rejection shape (card 4e0df6ce blocker 1) — confirms `portReportCapable
   *    = false` so the NEXT attempt uses the legacy path. Anything else (a signal — e.g. this process or a
   *    test killing the attempt directly — or a capability we've already confirmed) is an ordinary death,
   *    never a capability verdict.
   *  - neither arrives within {@link portReportTimeoutMs}: abandon this attempt (kill the child) without
   *    concluding anything about capability, and let the normal backoff schedule retry.
   * All three end in {@link scheduleRestart} — never a permanently-stuck attempt.
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
   * Attempt `spawn()`, logging + scheduling a bounded restart on a SYNCHRONOUS failure (never a "healthy"
   * run — no child ever came up) and returning `null`. Card 8c13a023 / d671f1b8: no `detached` option
   * below — this child is spawned NON-detached, deliberately left that way rather than a gap. On Windows
   * that means it's implicitly bound by Node/libuv to a Windows job object with kill-on-close tied to the
   * PARENT (this daemon process)'s own lifetime, so any death of the parent — a clean exit, a restart, or
   * an external hard-kill — already tears this child down with it, with no explicit stop() needed on that
   * platform. Verified by isolating the ONE variable that flips the outcome: an identical spawn with
   * `detached:true` survives the parent's death; without it (as here), the child dies every time, including
   * when killed via `TerminateProcess` (an API with no console-signalling path at all — ruling out a
   * console/`CTRL_CLOSE` explanation, which would also have taken the still-alive grandparent process with
   * it). On POSIX a non-detached child is instead reparented on the parent's death and KEEPS RUNNING —
   * unverified/predicted, not measured here (this repro is Windows-only) — which is why `index.ts`'s
   * shutdown-cleanup path calls `stop()` explicitly rather than relying on this platform default:
   * harmless-but-redundant on Windows, load-bearing on a POSIX host running this supervisor (`LOOM_DEV=1`-
   * gated; never starts for a regular loomctl end user).
   *
   * Card 194d343d: pin CODESCAPE_HOME explicitly (same value as `cwd`) so serve's env-first resolver check
   * wins over any upstream cwd-relative walk — must match ingest()'s own CODESCAPE_HOME, or ingest and
   * serve can disagree about where the store lives.
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
   * Card 44d45f81 DoD-3: repeated `spawnServeSelfReporting` timeouts DO feed this same give-up arithmetic
   * (each abandoned attempt calls `scheduleRestart(false)`, never "healthy") — a slow-but-genuinely-broken
   * host CAN still reach the give-up arm below, this raised timeout does not make that structurally
   * impossible, only much harder to reach. With {@link DEFAULT_PORT_REPORT_TIMEOUT_MS} at 20_000ms and the
   * default {@link DEFAULT_RESTART_BACKOFF_MS} (6 entries), give-up via backoff exhaustion now needs 7
   * consecutive attempts that EACH individually exceed 20s — worst case ~7*20s + the backoff sum
   * (1+2+5+10+30+60=108s) ≈ 248s (~4.1 min) of sustained badness, versus ~143s (~2.4 min) at the old 5s
   * bound. That is the DELIBERATE tradeoff: a transient slow start (measured up to ~7.9s under synthetic
   * heavy load, see that constant's doc) now succeeds on the FIRST attempt instead of ever entering this
   * path at all, which is what closes the production regression; a process that is genuinely, permanently
   * unable to report still reaches the same loud "needs a human" diagnostic, just after a longer, bounded
   * wait — never silently stuck (this only ever changes HOW LONG until give-up, never WHETHER it fires).
   * Unmeasured against a real production host under real sustained badness (only synthetic CPU-contention
   * data exists here, see `DEFAULT_PORT_REPORT_TIMEOUT_MS`'s own doc) — do not assume this arithmetic
   * transfers 1:1 to a real crash loop; it is the reachable-in-principle analysis the card asked for, not a
   * guarantee about wall-clock time on any specific host.
   *
   * Schedule a bounded-backoff restart; `ranHealthy` (computed by the caller, which alone knows whether
   * THIS attempt ever came up) resets the backoff schedule — legitimate policy so a long-lived healthy
   * process that dies once isn't permanently penalised by ancient restart history. Gives up (stays down,
   * logs loudly) once EITHER of two independent ceilings is reached:
   *   1. the backoff schedule ({@link restartBackoffMs}) is exhausted without a healthy run resetting it
   *      in between — the ORIGINAL mechanism, unchanged; or
   *   2. {@link restartTimestamps} shows {@link maxRestartsPerWindow} restarts already scheduled inside
   *      the trailing {@link restartWindowMs} — a ceiling `ranHealthy` CANNOT clear.
   * Card 4c7a337d: (1) alone left a hole — any kill that recurs on a cadence LONGER than `healthyRunMs`
   * sees `ranHealthy` true on essentially every death, so `restartAttempts` resets to 0 before it can ever
   * reach `restartBackoffMs.length`; the give-up ceiling became structurally unreachable and the loud
   * "needs a human" diagnostic never fired, for ANY sustained crash loop on that cadence — not just the
   * one specific 500-misclassification trigger `545ef479` fixed. (2) is what makes the diagnostic
   * reachable again regardless of cadence, while leaving the legitimate `ranHealthy` reset itself intact
   * for the isolated-single-restart case it exists to protect (one restart never comes close to the rate
   * ceiling).
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
   * Start the periodic `GET /graph/health` liveness probe — idempotent (a re-entrant `start()` call is
   * already blocked by the `this.child` guard at its own top, but this guard makes the intent explicit:
   * never stack a second interval). Armed UNCONDITIONALLY whenever {@link start} spawns `serve` —
   * including with ZERO codescape-enabled projects, since `spawnServe()` itself always runs regardless of
   * `repoPaths.length` (see {@link start}'s own doc). This used to be gated on a `hasEnabledProjects` flag
   * latched from `repoPaths.length` at boot, which meant a daemon that booted with no codescape-enabled
   * projects never armed the probe AT ALL for that boot's entire lifetime — and since v1 has no runtime
   * project registration (a project whose `codescape.enabled` flips on after boot still needs a daemon
   * restart to ever be ingested — see the CWD CONTRACT doc above and the config-PATCH log line in
   * `gateway/server.ts`), there was no in-process event that could ever re-arm it. The result: `serve` ran
   * fully unwatched — exactly the wedge blind spot this probe exists to close. `probeHealth` itself gates
   * on `alive`, so the timer is a harmless no-op tick whenever serve isn't currently believed up (never
   * started, mid-restart-backoff, or given up for good) — THAT check, not a project count, is what keeps
   * an idle timer cheap.
   */
  private startHealthMonitor(): void {
    if (this.healthProbeTimer) return;
    this.healthProbeTimer = setInterval(() => { void this.probeHealth(); }, this.healthProbeIntervalMs);
  }

  /**
   * One `/graph/health` check. `spawnServe`'s `child.on("exit")` only ever catches a `serve` that DIES —
   * a serve that's alive, port bound, and simply not answering (wedged) stays `alive:true` forever under
   * that detector alone, and `getPort()` keeps handing sessions a port that will hang. This is what closes
   * that gap.
   *
   * A single failed probe is NOT enough — a busy serve can miss one beat under load, and treating that as
   * death would restart a perfectly healthy process. Only a SUSTAINED run of
   * {@link healthProbeFailureThreshold} consecutive failures (reset to 0 by any success — see
   * `spawnServe`'s own reset on a fresh spawn) counts as a wedge.
   *
   * Card 545ef479 (Defect 2): "failure" here means the request never got an answer at all (timeout /
   * connection refused / network error — `res.status` absent). A response that DID arrive, even a 5xx, is
   * proof the process is alive and serving — it is reported (once, latched) but never counted toward
   * {@link consecutiveHealthFailures} and never kills the child. Before this, any non-2xx (including a 500
   * meaning "I can't determine something") was scored as a wedge failure — three consecutive 500s killed a
   * perfectly healthy process.
   *
   * On a sustained failure, this does NOT call `scheduleRestart`/`spawnServe` itself — it kills the live
   * child. That kill is a REAL process death, so it fires the exact same `child.on("exit")` → `onDeath` →
   * `scheduleRestart` path a crash would (same `restartAttempts` budget, same backoff, same give-up
   * ceiling) — a health-driven restart can never resurrect a serve past an exhausted budget, because it
   * never opens a second restart channel; it just triggers the existing one.
   *
   * Never runs when `!alive` (nothing to check) or after `stop()` (`this.stopped`) — no probe traffic on a
   * dead, never-started, or intentionally-stopped serve. Also never runs while a PRIOR tick is still in
   * flight ({@link probeInFlight}) — see that field's own doc for why the drift-detection addition below
   * needs this (a slow subprocess spawn occasionally outruns a fast probe interval).
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
   * Card `350bc307`: the ONE live-introspection caller of {@link codescapeUnclassifiedTools}
   * (`pty/host.ts`) — a real `tools/list` round-trip against the RUNNING mounted server, not just the
   * two in-memory arrays it partitions. Layered onto a SUCCESSFUL health probe, mirroring
   * {@link checkBuildDrift}'s own placement and discipline: async, bounded ({@link toolsProbeTimeoutMs}),
   * best-effort, NEVER throws, and NEVER blocks a spawn/boot/gate (DoD-3 — fail soft) — a probe failure
   * just means "couldn't check this tick," identical in effect to a probe that never ran.
   *
   * Needs a resolvable Codescape PROJECT id to build the `/mcp/<id>` URL {@link probeAdvertisedTools}
   * hits — `tools/list` is a property of the served MCP APPLICATION (which tools it registers), not of
   * per-project graph DATA, so ANY currently-registered project id observes the same tool registration a
   * genuinely drifted server would expose on every scope; this instance's own {@link projectIds} cache
   * (populated by {@link registerProjectWithRetry} at boot) is reused rather than re-resolving anything.
   * A no-args case (nothing registered yet — codescape just started, or every registration attempt so
   * far has failed) is a clean skip: nothing to probe against yet, not a failure.
   *
   * On a successful round-trip, ALWAYS persists the result via `writeToolDriftState` (even an EMPTY
   * unclassified set) — so the state file's `checkedAt` stays fresh and a since-cleared drift doesn't
   * linger stale in what `readCodescapeToolDriftNote` reads back. The in-memory
   * {@link lastToolDriftUnclassified} latch exists purely so a TRANSITION logs once (a new/changed
   * finding, or a recovery back to clean) rather than spamming this line every ~30s tick forever — the
   * persisted file (read by the Platform Lead's kickoff note, DoD-2) is the real addressed signal; this
   * console line is a supplementary breadcrumb, not the mechanism itself.
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
   * Card 545ef479 (Defect 1): every exit path of this method — including its two silent no-op returns
   * below (running build absent, installed build honestly `null`) — now latches a {@link DriftCheckState}
   * via {@link announceDriftCheckState} before returning. Before this, those two no-ops and the ordinary
   * steady-state MATCH were THREE code paths that all produced zero observable signal — "drift detection
   * is running and finding nothing" was byte-identical, downstream, to "drift detection is inert". See
   * {@link getDriftCheckState} for the diagnostic/test seam this exposes.
   *
   * Card 90550a97: build-id drift detection, layered onto a SUCCESSFUL health probe above. Compares the
   * RUNNING serve's `build` (from THIS `/graph/health` response) against the INSTALLED binary's build
   * (a fresh, bounded read below) — NEVER `healthJson`'s `version` field, which is the static
   * `CODESCAPE_VERSION` semver and reads identically across commits; wiring drift to it would produce a
   * detector that reports "no drift" forever. `version` is deliberately never even read here.
   *
   * THREE distinguishable outcomes on the installed side (agreed contract with the Codescape manager,
   * not two): a real SHA (comparable), an HONEST `build: null` at exit 0 (a dist built outside a git
   * checkout — a legitimate answer, never a failure), or a genuine couldn't-read (non-zero exit, or
   * malformed/unparseable stdout at exit 0 — see {@link readInstalledBuild}'s own doc). The running side
   * keeps its existing two-case fail-safe (absent from the response, or `build: null`). ALL FOUR of these
   * non-comparable states mean "do nothing" — a restart only fires when BOTH sides resolve to non-empty,
   * DIFFERING strings.
   *
   * On a genuine mismatch this does NOT call `scheduleRestart`/`spawnServe` directly — exactly like the
   * wedge-kill above, it kills the live child ONCE and lets the EXISTING `child.on("exit")` -> `onDeath`
   * -> `scheduleRestart` path own the actual restart, inheriting the same `restartAttempts` budget,
   * backoff, and give-up ceiling (never a second restart channel that could resurrect a serve past an
   * exhausted budget).
   *
   * One deliberate restart per detected drift: {@link lastDriftRestartInstalledBuild} remembers the
   * installed build we already kicked a restart for, so a serve that keeps reporting a stale/failing
   * `build` after that restart (the installed side hasn't moved) is never kicked again on every
   * subsequent probe tick — that guard is what stops an endless restart cycle when the new build can't
   * come up. A restart fires again once the installed build itself changes to something new — or once
   * the daemon restarts: the guard is a private instance field reset in {@link start}/{@link stop} (see
   * {@link lastDriftRestartInstalledBuild}'s own doc), so a fresh daemon process reopens the same
   * one-restart allowance for the SAME installed build too.
   *
   * Card 9e6f984d — STABILITY WINDOW, a precondition layered ON TOP of the guard above (does not
   * replace it): a genuine mismatch does not restart immediately. The installed build must first sit
   * UNCHANGED for {@link driftStabilityMs} before a restart fires, tracked as `(build, firstSeenAt)` on
   * {@link driftCandidateBuild}/{@link driftCandidateFirstSeenAt}. A NEW mismatched build (different from
   * whatever was already being watched) replaces the candidate and restarts the window — so a burst of N
   * distinct rebuilds inside the window collapses into exactly ONE eventual restart, fired only once the
   * LAST build in the burst has been stable for the full window. This is what stops the codescape
   * project's own rebuild cadence from becoming our serve-restart cadence: their build action drives our
   * process lifecycle across a boundary where neither side can see the other's activity, so a quiet
   * period is the cheap, coupling-free way to tell "mid-churn" apart from "settled". Deferral is LOGGED
   * ONCE per new candidate (not once per tick while waiting) — a `console.warn` distinct from both the
   * eventual restart line and total silence, so "serve didn't restart" is never indistinguishable from
   * "no drift detected" (same discriminator discipline as the rest of this feature).
   *
   * Review follow-up (card 90550a97): a genuine couldn't-read on the installed side is loud, not silent —
   * "no drift" and "can't tell if there's drift" must never look identical (the `16b7c38c` lesson: a
   * `finish([])` that couldn't tell "enumeration failed" from "nothing found" silently disabled worktree
   * reaping for months). An HONEST `build: null` answer is the OPPOSITE case — codescape successfully
   * told us it has no build id — and stays silent, exactly like the running side's own absent/null
   * fail-safe; only a genuine read FAILURE gets the loud diagnostic. See {@link readInstalledBuild}'s
   * classified result and the {@link lastInstalledBuildFailureReason} latch below for how "loud" stays
   * bounded to once per distinct reason, not once per 30s tick forever.
   */
  /**
   * Card 545ef479 (Defect 1): latch-and-announce a {@link DriftCheckState} TRANSITION only — never on
   * every ~30s probe tick, mirroring {@link lastInstalledBuildFailureReason}'s discipline. A steady-state
   * `"match"` (or a steady `"not-checked:*"`) logs nothing further after its first announcement; only a
   * genuine change of state (including into/out of an UNKNOWN bucket) is worth a human's attention.
   * `console.log`, not `console.warn` — a mismatch is already loudly warned in detail by the caller's own
   * existing branches (deferring/STABLE/UNRESOLVED); this line exists so the coarse three-way signal
   * (match / mismatch / not-checked) is ALSO visible without reading those detailed lines.
   *
   * Card 23980bbf: a TRANSITION-only log is, on its own, indistinguishable from a low-frequency POLL log —
   * both are sparse lines, and a reader who doesn't already know this line only fires on change can (and
   * did — see the card) mis-derive a wait budget from the gaps between occurrences. Folding the RESOLVED
   * {@link healthProbeIntervalMs} into the line itself (never the hardcoded default constant — this
   * instance may have been constructed with a test/override seam) is what makes the true poll cadence
   * derivable from the log output alone, without reading this source file.
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
      if (this.lastExhaustedDriftAnnounced != null) {
        // Card ebd755ab (Gap 1 reset): the pair we'd previously announced as permanently unresolved has
        // now resolved — announce the recovery so it isn't indistinguishable from "still unresolved".
        console.warn(`[codescape] serve build drift RESOLVED (installed build "${runningBuild}" now matches running) — was unresolved after its one restart was already spent`);
        this.lastExhaustedDriftAnnounced = null;
      }
      return;
    }
    this.announceDriftCheckState("mismatch");
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
   * Read the INSTALLED codescape binary's own build id — bounded + async, via {@link runBoundedSplit}
   * (NOT the shared `runBounded` `ingest()` uses — see that function's own doc for why stdout/stderr must
   * stay separate here), never on any hot path (this only ever runs off the periodic {@link probeHealth}
   * tick, itself off any request path). The ONLY place that knows how to ask the installed binary for its
   * build — deliberately isolated here so a future change to the CLI's version-command surface is a
   * one-function change with no ripple elsewhere.
   *
   * AGREED CONTRACT (with the Codescape manager, superseding an earlier wrong read of the CLI's failure
   * shape): both `codescape version` and `codescape --version` will work, resolving THREE distinguishable
   * outcomes, not two:
   *   - exit 0, stdout `{"version":"<semver>","build":"<sha>"}` — normal; comparable for drift.
   *   - exit 0, stdout `{"version":"<semver>","build":null}` — an HONEST answer (e.g. a dist built outside a
   *     git checkout), never a failure.
   *   - non-zero exit — reserved for a genuine failure to answer.
   * Two guarantees this relies on: stdout is clean JSON ONLY (no banners/prefixes mixed in) when exit is
   * 0, and the CLI reads the SAME `buildInfo.generated.ts` source `/graph/health` already serves, so there
   * is no second resolution path that could disagree with the running side. Given that guarantee, parsing
   * is STRICT (`JSON.parse` on the whole trimmed stdout) — never a lenient/substring/regex extraction. A
   * banner leaking onto stdout at exit 0 would be a REAL defect on their side and must fail loudly here,
   * not get silently rescued by a forgiving parser (that would hide exactly the class of bug this feature
   * already cost a round of review to find).
   *
   * The real CLI implements this surface as of 2026-07-28: `codescape version`/`--version` returns
   * `{"version":"<semver>","build":"<sha>"}` on stdout at exit 0 — confirmed live by `90550a97`, which
   * validated the detector end-to-end against a genuine drift condition (installed != running,
   * correctly classified). Do NOT read Codescape's internal `dist/buildInfo.generated.js` (or any other
   * undocumented internal file) to make this "work" instead — that is an unversioned cross-project
   * coupling that breaks silently the moment Codescape reshapes its build output, exactly the class of
   * stale cross-project belief this project has already been burned by.
   *
   * Never throws; never fabricates a value. `failed` is true ONLY for a genuine read failure (spawn/exec
   * failure or timeout — `runBoundedSplit`'s own `!ok` — or malformed/unparseable stdout at exit 0); it is
   * FALSE for both a real build string AND an honest `build: null` — the two are deliberately kept
   * distinguishable from a read failure. `reason` is set only alongside `failed:true`, for
   * {@link checkBuildDrift}'s one-shot diagnostic.
   */
  private async readInstalledBuild(): Promise<{ build: string | null; failed: boolean; reason?: string }> {
    const { command, args } = resolveCodescapeBin(this.codescapePath);
    let r: SplitRunResult = { ok: false, code: null, timedOut: false, stdout: "", stderr: "" };
    let attempt = 0;
    // Card f0718488: retry ONLY a TIMED-OUT attempt (r.timedOut) — a non-zero exit or malformed stdout at
    // exit 0 is a genuine failure of the installed binary, not host contention, so it breaks below on
    // attempt 1 and is never retried (stays fast + latched, exactly as before this card). The dominant
    // observed cause of a timeout is steady-state contention from a live fleet of workers + gates, not a
    // boot-window blip — see the card for the measurement that overturned the original "boot only" theory.
    //
    // WORST-CASE BUDGET (every attempt hits the full timeout — do not "helpfully" retune any of these
    // constants without redoing this arithmetic):
    //   versionProbeMaxAttempts(3) * versionProbeTimeoutMs(5,000ms)
    //   + (versionProbeMaxAttempts - 1)(2) * versionProbeRetryDelayMs(250ms)
    //   = 15,500ms for this method alone.
    // This only ever runs after a successful `/graph/health` fetch inside the SAME probeHealth() tick
    // (sequential awaits — see checkBuildDrift's caller), so the full worst-case single-tick wall time also
    // carries that fetch's own bound: +healthProbeTimeoutMs(5,000ms) = 20,500ms, ~68% of the default
    // 30,000ms healthProbeIntervalMs tick interval — a real ~9.5s margin, on top of the `probeInFlight`
    // guard (see that field's doc) which already makes a literal tick-overlap structurally impossible
    // regardless. Under sustained contention this does mean ~20.5s of every 30s tick is spent spawning
    // `--version` subprocesses — judged negligible next to the load actually causing the contention (live
    // workers + gates), and the timedOut-only gate above means a genuinely broken binary never enters this
    // path at all. Deliberately no adaptive/stateful backoff here — not warranted at this priority.
    // A `for` loop's own post-body increment would still fire after a final, exhausted iteration breaks
    // out below — leaving `attempt` one higher than the real count. Track it explicitly instead so the
    // "(N attempts)" reason string below, and every test asserting on {@link getVersionProbeAttemptCount},
    // see the true number actually made.
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
