#!/usr/bin/env node
// Watch-free, restart-capable daemon runner for SELF-HOSTING (orchestrating Loom WITH Loom).
//
// Why this exists: the dev daemon runs under `tsx watch`, so any worker merge that touches
// packages/daemon/src/** restarts it and kills the live manager + worker ptys mid-flight (the
// 2026-06-03 overnight cascade). This supervisor runs the BUILT daemon with no file watcher, so
// source merges don't bounce it — AND it relaunches the daemon when a manager deliberately calls
// `daemon_restart` to pick up merged daemon code (the daemon exits with RESTART_EXIT_CODE; on the
// way back up it auto-resumes the manager + its workers).
//
// Restart policy: relaunch ONLY on the explicit restart sentinel. ANY other exit (including a crash)
// STOPS the loop, so a broken daemon stays visibly down instead of crash-looping — that crash-loop
// is exactly what burned us on 2026-06-03 (ELIFECYCLE 255, repeated).
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRotatingLog } from "./lib/rotating-log.mjs";
import { createLineTimestamper } from "./lib/line-timestamp.mjs";
import { loadDotEnvFile, fillEnvDefaults } from "./lib/env-file.mjs";

const RESTART_EXIT_CODE = 75; // must match packages/daemon/src/orchestration/restart.ts
const thisFile = fileURLToPath(import.meta.url);
const here = path.dirname(thisFile);
const repoRoot = path.resolve(here, "..");
const daemonDir = path.join(repoRoot, "packages", "daemon");

// Mirrors packages/daemon/src/crashlog.ts CRASHLOG_PATH (LOOM_HOME/crash.log). The daemon's fatal-exit
// handler writes the crashlog here; a freshly launched daemon would overwrite it on its next crash. So
// before each launch, rotate any existing crash.log to crash.log.prev — keeping the last two — so a
// restart (or a human re-run after a crash) never clobbers the previous crash signature. Best-effort.
const LOOM_HOME = process.env.LOOM_HOME || path.join(os.homedir(), ".loom");

// File-based feature-flag toggles (card b22f9ef2): a `daemon_restart` (in-process, exit 75) reuses
// THIS process's env, so a flag only ever set via a fresh shell is invisible to it — a full Ctrl-C +
// relaunch was the only way to pick one up. Load <LOOM_HOME>/.env once, before the daemon child's env
// is ever constructed, and fill in any var the real shell env doesn't already set (shell always wins).
fillEnvDefaults(process.env, loadDotEnvFile(path.join(LOOM_HOME, ".env")));

// ---- --detach (card 2f146782) ------------------------------------------------------------------------
// Genuinely decouples the self-host daemon from whatever terminal launched it — no console window is a
// single point of failure for the fleet. Bare `pnpm daemon:stable` (no flag) is BYTE-IDENTICAL foreground
// behavior; this whole block is a no-op unless --detach is passed. See CLAUDE.md's Self-hosting section.
// NOT exported: importing this file for its exports would also run its top-level detach/build/run-loop
// side effects. scripts/daemon-supervisor-stop.mjs independently recomputes the same path (mirrors how
// bin/loom.mjs's own PID-file helpers are self-contained rather than shared) — keep the two in sync.
const SUPERVISOR_PID_PATH = path.join(LOOM_HOME, "daemon-supervisor.pid");
const SUPERVISOR_LOG_PATH = path.join(LOOM_HOME, "logs", "daemon-supervisor.log");
// Mirrors paths.ts's own PORT resolution — read AFTER fillEnvDefaults above, so a LOOM_PORT set only via
// <LOOM_HOME>/.env (not the real shell env) is still seen here (Code Review finding #3's sibling: the
// launcher and scripts/daemon-supervisor-stop.mjs must resolve the SAME port the same way).
const PORT = process.env.LOOM_PORT ? Number(process.env.LOOM_PORT) : 4317;

/** GET /api/version → true on a 200 within timeoutMs, false on anything else (incl. no listener). */
function httpVersionOk(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/version", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}
/** Poll httpVersionOk until it succeeds or timeoutMs elapses. */
async function waitForReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpVersionOk(port, 1500)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// Two INDEPENDENT gates against ever re-entering this branch in the detached child: (1) the child's own
// argv never carries --detach (we construct it explicitly below, not by "stripping" the parent's argv),
// and (2) even if a future edit somehow reintroduced the flag on the child's argv, LOOM_SUPERVISOR_DETACHED_CHILD
// is set ONLY by this launch path and gates the branch below regardless of argv — so a stripping bug can
// never fork-bomb.
const wantsDetach = process.argv.includes("--detach");
const isDetachedChild = process.env.LOOM_SUPERVISOR_DETACHED_CHILD === "1";
if (wantsDetach && !isDetachedChild) {
  // Double-start guard (Code Review finding #5): a second `--detach` while one is already up would
  // overwrite the pid file with the NEW supervisor's pid, orphaning the first (its own daemon child then
  // dies on EADDRINUSE, leaving supervisor #1 live with no record — unstoppable through
  // daemon:stable:stop). Mirrors bin/loom.mjs's startDetached: probe the PORT itself (not the pid file —
  // a foreground `pnpm daemon:stable` on the same port must also be refused).
  if (await httpVersionOk(PORT, 1500)) {
    console.log(`[supervisor] a daemon is already answering at http://127.0.0.1:${PORT} — not starting a second one.`);
    process.exit(0);
  }
  fs.mkdirSync(path.join(LOOM_HOME, "logs"), { recursive: true }); // also creates LOOM_HOME (an ancestor)
  const fd = fs.openSync(SUPERVISOR_LOG_PATH, "a");
  // Explicit argv (just [thisFile] — no flags at all) is the primary non-recursion guard; the env marker
  // above is the second, independent one. detached:true + windowsHide:true + stdio NOT inheriting the
  // console (piped to a file, never "inherit") is the same shape bin/loom.mjs's proven startDetached()
  // already uses on Windows to survive the launching shell closing.
  const child = spawn(process.execPath, [thisFile], {
    cwd: repoRoot,
    env: { ...process.env, LOOM_SUPERVISOR_DETACHED_CHILD: "1" },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  // Code Review finding #6: a pid-file write failure would leave the just-spawned child alive but
  // completely untracked (no way for daemon:stable:stop to ever find it again) — kill it rather than
  // leave that orphan. Finding #3: the record now carries `port` too, so stop() doesn't have to
  // re-derive it from its OWN env (which can disagree — see that finding).
  //
  // Card 9fb849de: `supervisorStartedAt` (not `startedAt`) — this is when SUPERVISION began, not when the
  // daemon last started. The restart loop below relaunches the daemon inside this SAME supervisor process
  // (daemon exits 75, supervisor re-spawns it) and never rewrites this file, so this timestamp is stable
  // across every `daemon_restart` — by design, and unrelated to whether the currently-running daemon is
  // up to date. To answer "is my merge live", read the daemon's own `served_status` → `deployStaleness`
  // (`processStartedAt` / `runningCodeBuiltAt` / `commitsBehind`, packages/daemon/src/deploy-staleness.ts)
  // instead — that is computed fresh per call and is the authoritative deploy-currency signal, not this file.
  try {
    fs.writeFileSync(SUPERVISOR_PID_PATH, JSON.stringify({ pid: child.pid, port: PORT, supervisorStartedAt: new Date().toISOString() }, null, 2) + "\n");
  } catch (err) {
    console.error(`[supervisor] failed to write the PID file (${err.message}) — killing the just-spawned detached child so it can't become an untracked orphan.`);
    try { process.kill(child.pid, "SIGKILL"); } catch { /* best-effort */ }
    process.exit(1);
  }
  console.log(`[supervisor] started detached — PID ${child.pid}`);
  console.log(`[supervisor] supervisor log (build output, restart-loop messages): ${SUPERVISOR_LOG_PATH}`);
  console.log(`[supervisor] daemon output log (the daemon child's own stdout/stderr): ${path.join(LOOM_HOME, "logs", "daemon-output.log")}`);
  console.log(`[supervisor] PID file: ${SUPERVISOR_PID_PATH}`);
  console.log(`[supervisor] stop with: pnpm daemon:stable:stop`);
  // Finding #5's other half: without this, "started detached" prints and this process exits 0 BEFORE the
  // build even runs — a fatal build failure minutes later leaves a success message, a dead pid file, and
  // (by design) no terminal left to show the failure. Wait for the real readiness signal instead. Bounded
  // generously (unlike bin/loom.mjs's 30s) because THIS launch still has a full turbo build ahead of it,
  // not just an already-built binary to exec.
  console.log("[supervisor] waiting for the daemon to become ready (this includes a full build; can take a few minutes on a cold cache)…");
  const ready = await waitForReady(PORT, 240_000);
  if (ready) console.log(`[supervisor] ready — http://127.0.0.1:${PORT}`);
  else console.error(`[supervisor] not answering on http://127.0.0.1:${PORT} yet after 240s — it may still be building; check ${SUPERVISOR_LOG_PATH} and ${path.join(LOOM_HOME, "logs", "daemon-output.log")}.`);
  process.exit(0);
}

// Code Review finding #1: the pid file otherwise outlives every exit path below (build-failure exit,
// daemon-exit-code exit — neither removes it), leaving a stale record pointing at a dead pid indefinitely
// on a host that churns node/esbuild/gate processes constantly — exactly the reused-pid hazard
// scripts/daemon-supervisor-stop.mjs's identity check exists to catch. Best-effort, and ONLY removes the
// file if it still names THIS process (never a later instance's own record — see finding #5's double-start
// guard for why that race matters).
if (isDetachedChild) {
  process.on("exit", () => {
    try {
      const rec = JSON.parse(fs.readFileSync(SUPERVISOR_PID_PATH, "utf8"));
      if (rec && rec.pid === process.pid) fs.unlinkSync(SUPERVISOR_PID_PATH);
    } catch { /* best-effort — a leftover file just means stop() falls back to its own identity check */ }
  });
}

const CRASHLOG = path.join(LOOM_HOME, "crash.log");
/**
 * Returns whether a crash.log actually existed and was rotated (Code Review finding #2). This return
 * value matters beyond the rotation itself: the daemon child's own boot-time check
 * (packages/daemon/src/crashlog.ts's hadCrashLogAtBoot, card 2f146782) can no longer see a crash.log that
 * THIS rotation already moved away — under daemon:stable, rotation always runs immediately before every
 * launch (below), so by the time the child could check, a real prior crash's record is already gone
 * regardless of whether this boot is a crash-recovery boot at all. The caller threads this into
 * LOOM_PRIOR_CRASHLOG so the child can still tell the difference — see hadCrashLogAtBoot's own doc.
 */
function rotateCrashlog() {
  try {
    if (!fs.existsSync(CRASHLOG)) return false;
    const prev = `${CRASHLOG}.prev`;
    fs.rmSync(prev, { force: true }); // Windows renameSync fails if the destination exists — clear it first
    fs.renameSync(CRASHLOG, prev);
    return true;
  } catch (err) {
    console.error(`[supervisor] crashlog rotate failed (continuing): ${err.message}`);
    return false;
  }
}

/** Run a shell command to completion, inheriting stdio. Returns its exit code (null → 1). */
function sh(command, cwd, extraEnv) {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  return spawnSync(command, { cwd, stdio: "inherit", shell: true, env }).status ?? 1;
}

// ---- Daemon-death diagnostics (card 4c0dc6e6) ----
//
// A real daemon crash once left NO trace: the daemon runs stdio:"inherit" under this supervisor
// (terminal-only, nothing persisted), and packages/daemon/src/crashlog.ts's uncaughtException /
// unhandledRejection / exit handlers only fire for a JS-level death — they never ran, so it wasn't a
// JS crash, but nothing else recorded what happened either. These two additions widen the net
// WITHOUT changing the restart control flow above:
//
//   1. Tee the daemon's stdout/stderr to a size-bounded rotating file, so the last output before a
//      death survives even a death with no signature of its own (crashlog.ts complements this for
//      the JS-crash case; this covers everything, including a silent native/external death). Each
//      teed line carries a trailing epoch-ms timestamp (card be9571a4) so the corpus is
//      time-analyzable, not just interleaving-order-analyzable — see runDaemon() below.
//   2. Run the daemon with Node's built-in diagnostic report (--report-on-fatalerror
//      --report-uncaught-exception), so a NATIVE fatal error (OOM, an abort inside a native addon
//      like node-pty/better-sqlite3) that crashlog.ts's JS-only handlers can't observe still drops a
//      report.*.json with a stack/heap/handle snapshot.
//
// Detaching the daemon from a closable console/RDP session (so a closed terminal can't take it down)
// IS handled — see the --detach block above (card 2f146782). That path gives up stdio:"inherit" entirely
// (a detached child can't share the parent console) in exchange for the log files below staying the only
// way to watch it — a deliberate trade, opt-in via --detach; bare `pnpm daemon:stable` keeps the
// live-in-the-terminal foreground workflow unchanged.
const OUTPUT_LOG = createRotatingLog({
  basePath: path.join(LOOM_HOME, "logs", "daemon-output.log"),
  // Raised 5MB/3 files -> 10MB/6 files (card 74ab5274): the 1bd1f045 [pty-write] instrumentation
  // multiplies line count ~5-19x per message, and the live post-deploy rate — measured directly off
  // this file against a busy 4-worker fleet — was ~1.16MiB/hour (20.3KB/min). The old 15MB bound gave
  // only ~13h of retained forensic window at that rate; this bound gives ~52h, comfortably past a
  // notice-to-investigation delay that can run well beyond 30min.
  maxBytes: 10 * 1024 * 1024, // 10MB per file
  maxFiles: 6, // live file + 5 rotated slots — bounded at ~60MB total, never grows unbounded
});
const REPORTS_DIR = path.join(LOOM_HOME, "reports");

/**
 * Launch the daemon, teeing its stdout/stderr to BOTH the console (as before) and OUTPUT_LOG, with
 * Node's diagnostic-report flags passed as CLI args (NOT via NODE_OPTIONS — NODE_OPTIONS runs its
 * OWN mini-parser that treats `\` as an escape character, so a Windows REPORTS_DIR like
 * `C:\Users\name\.loom\reports` gets silently mangled to `C:UsersnameloomReports`; verified against a
 * real Windows node — CLI args use ordinary argv parsing and have no such escaping). Resolves the
 * daemon's exit code; a signal-kill resolves as 1, matching the previous spawnSync `.status ?? 1`
 * behavior.
 */
function runDaemon(cwd, extraEnv) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  const cmd = `node --report-on-fatalerror --report-uncaught-exception --report-directory="${REPORTS_DIR}" dist/index.js`;
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, env, stdio: ["inherit", "pipe", "pipe"] });
    // The live console mirror stays a raw, unbuffered chunk passthrough (unchanged) so the terminal
    // still streams output with no added latency — but ONLY in foreground mode (Code Review finding #4):
    // in a detached child there is no console to mirror to, and process.stdout there is actually the
    // SAME fd the outer --detach block redirected to SUPERVISOR_LOG_PATH, so mirroring into it would
    // duplicate the entire daemon stream (already ~1.16MiB/hour on a busy fleet — see OUTPUT_LOG's own
    // sizing note below) into a file with no rotation/cap. daemon-output.log (OUTPUT_LOG, bounded +
    // rotating + timestamped) already holds a strictly better copy either way, so this loses nothing.
    // OUTPUT_LOG instead goes through a per-stream line timestamper (card be9571a4): a "data" event's
    // chunk boundaries don't align with line boundaries, so stamping raw chunks would put one timestamp
    // per arbitrary chunk instead of one per line. See lib/line-timestamp.mjs for why the stamp is a
    // trailing epoch-ms suffix rather than a prefix (preserves every existing `^`-anchored measurement
    // recipe unchanged).
    const stdoutStamper = createLineTimestamper((line) => OUTPUT_LOG.append(line));
    const stderrStamper = createLineTimestamper((line) => OUTPUT_LOG.append(line));
    child.stdout.on("data", (chunk) => { if (!isDetachedChild) process.stdout.write(chunk); stdoutStamper.write(chunk); });
    child.stderr.on("data", (chunk) => { if (!isDetachedChild) process.stderr.write(chunk); stderrStamper.write(chunk); });
    child.on("error", (err) => {
      console.error(`[supervisor] failed to start daemon: ${err.message}`);
      resolve(1);
    });
    child.on("close", (code) => {
      // Flush any trailing partial line (no terminating "\n") so a death mid-write isn't lost.
      stdoutStamper.flush();
      stderrStamper.flush();
      resolve(code ?? 1);
    });
  });
}

// Card 572dd777 DoD-4: which pass of this loop a given daemon boot ran under, threaded to the child as
// LOOM_SUPERVISOR_ITERATION so the daemon can tell "this supervisor process was itself just started"
// (iteration 1 — on the self-host path, necessarily a human running this command, since nothing else
// launches it) apart from "this supervisor's own loop relaunched the daemon" (iteration >1, only ever
// reached via the RESTART_EXIT_CODE `continue` below) — a directly recorded fact instead of a deduction
// the daemon would otherwise have to make from restart-intent presence + exit code alone.
let supervisorIteration = 0;

for (;;) {
  supervisorIteration++;
  // Build in two steps so a failure has the right blast radius. FULL TURBO no-ops when nothing
  // changed, so the tool-triggered restart (which already built) relaunches fast.
  //
  // 1) shared + daemon (turbo ^build handles the shared dependency) — FATAL on failure: never start
  //    a broken daemon.
  const buildCode = sh("pnpm exec turbo build --filter=@loom/daemon", repoRoot);
  if (buildCode !== 0) {
    console.error(`[supervisor] daemon build failed (exit ${buildCode}) — NOT starting a broken daemon.`);
    process.exit(buildCode);
  }
  // 2) web — the daemon serves the UI statically from packages/web/dist, so a fresh boot rebuilds it
  //    to avoid serving a stale bundle. But a web build failure is NON-FATAL: the gateway boots fine on
  //    a missing/stale dist (server.ts logs + skips static), so a BAD web build must not block the WHOLE
  //    daemon boot (all-project orchestration). Log loudly and boot on the previous dist. Turbo/vite
  //    does not wipe dist on a failed build, so the prior good bundle survives.
  const webBuildCode = sh("pnpm exec turbo build --filter=@loom/web", repoRoot);
  if (webBuildCode !== 0) {
    console.error("[supervisor] WARNING: web build failed — booting with the previous packages/web/dist (UI may be stale)");
  }
  // Preserve any prior crashlog before the daemon (re)launches and possibly overwrites it.
  const rotated = rotateCrashlog();
  // LOOM_SUPERVISED tells the daemon a supervisor is present, so `daemon_restart` is allowed (without
  // it the manager would kill the daemon with nothing to bring it back).
  // LOOM_DEV defaults ON here: `daemon:stable` is the SELF-HOSTING / dogfooding entry point (regular
  // loomctl users run the packaged bin/loom.mjs, never this), so the dev-only Platform layer should seed.
  // Defaulted (not hardcoded) so an explicit `LOOM_DEV=0 pnpm daemon:stable` can still test the non-dev path.
  // UV_THREADPOOL_SIZE (task dea6728e, defense-in-depth): the default libuv pool is only 4 threads, so a
  // small handful of wedged fs ops could still starve fs/dns/crypto process-wide even with removeWorktree's
  // killable removal (which no longer uses the threadpool at all, but other daemon code still does).
  // Widened here since this spawns a FRESH node process — set BEFORE the daemon starts, which is the only
  // point a bump actually takes effect (libuv reads it once, lazily, on first threadpool use). Never
  // overrides an operator's own explicit setting.
  const extraEnv = {
    LOOM_SUPERVISED: "1", LOOM_DEV: process.env.LOOM_DEV ?? "1", UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? "16",
    LOOM_SUPERVISOR_ITERATION: String(supervisorIteration),
  };
  // Code Review finding #2: rotateCrashlog() just above ALWAYS runs before this launch, so a real prior
  // crash's crash.log is already gone by the time the child could check fs.existsSync itself — tell it
  // explicitly, ONLY when a file genuinely existed to rotate (never claim a crash that didn't happen).
  if (rotated) extraEnv.LOOM_PRIOR_CRASHLOG = "1";
  console.log(
    `[supervisor] launching daemon — supervisor iteration ${supervisorIteration}` +
    (supervisorIteration === 1 ? " (this supervisor process was itself just started)" : " (relaunched in-process after an exit-75 restart request)") +
    "…",
  );
  const runCode = await runDaemon(daemonDir, extraEnv);
  if (runCode === RESTART_EXIT_CODE) {
    console.log(`[supervisor] daemon requested restart — rebuilding and relaunching (next iteration ${supervisorIteration + 1})…`);
    continue;
  }
  process.exit(runCode);
}
