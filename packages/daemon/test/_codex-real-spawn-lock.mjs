// Cross-process mutual exclusion for the real-codex-spawn test files (card 14e6cf5f; membership +
// sizing revised by card 3791b14e).
//
// WHY THIS EXISTS: every file in CODEX_REAL_SPAWN_BASENAMES below drives a REAL, model-backed `codex`
// CLI process against the ONE real, shared `~/.codex` home (codex-doctrine.ts's own header: "every
// concurrent Codex worker on a host shares ONE real `~/.codex/config.toml` + `sessions/` tree" — never
// a per-test CODEX_HOME override, auth breaks under one).
//
// MEASURED (card 14e6cf5f diagnosis, original 2-file shape): running two of these concurrently
// reproduces an intermittent full-boot stall — a real codex process never reaches even the first-use
// trust dialog within its own completion deadline. Reproduced at ~2/36 concurrent trials (pool>=2); 0/5
// sequential (pool=1) trials failed — the trigger needs the FULL concurrent scheduling shape, not just
// "two codex processes exist". See that card for the full trial log.
//
// CARD 3791b14e (2026-09-07): the family grew from 2 to 4 files without this lock's own wait budget
// being re-derived, and a gate op (`7d31427a`) surfaced the staleness — a waiter (`codex-mcp-reachability
// -real-spawn`) timed out at the then-current 90s budget while the actual holder needed longer than that
// to legitimately finish. FIX SHAPE CHANGED with that card: `scripts/test-daemon.mjs` now imports
// CODEX_REAL_SPAWN_BASENAMES below and schedules this WHOLE family sequentially (pool size 1),
// ALWAYS-ON and independent of that script's own `ISOLATED_REAL_SPAWN_PHASE_ENABLED` (a different,
// larger, owner-approved opt-in tradeoff for a different file set — this family is never gated by, and
// never reads, that flag). That scheduling change is what actually prevents concurrent contention now;
// THIS file's lock is a BACKSTOP against a scheduling-invariant violation (a bug in that scheduling, or
// this file run ad hoc outside test-daemon.mjs), not the primary means of exclusion — see WAIT_TIMEOUT_MS
// below for what that changes about how it's sized.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { registerForCleanup, unregister } from "./_tmp-fixture.mjs";

// SINGLE SOURCE OF TRUTH for family membership — `scripts/test-daemon.mjs` imports this array (not the
// reverse) so the scheduler's sequential-phase set and this lock's own contender count can never drift
// apart. Adding a 5th real-codex-spawn file means adding its basename HERE, once; the scheduler picks it
// up automatically, and (per WAIT_TIMEOUT_MS's own comment below) the wait budget does not need to
// change when this list grows, so there is no second number to keep in sync.
export const CODEX_REAL_SPAWN_BASENAMES = [
  "codex-doctrine-real-spawn",
  "codex-mcp-connect-stuck-real-spawn",
  "codex-mcp-reachability-real-spawn",
  "codex-prompt-ascii-fold-real-spawn",
  "codex-stateful-runtime-real-spawn",
  "codex-submit-confirmation-real-spawn",
  "codex-transcript-real-spawn",
];
export const CODEX_REAL_SPAWN_SET = new Set(CODEX_REAL_SPAWN_BASENAMES);

const LOCK_PATH = process.env.LOOM_CODEX_REAL_SPAWN_LOCK_PATH || path.join(os.tmpdir(), "loom-codex-real-spawn.lock"); // env: hermetic-test seam (card fb119c4c)
// Far longer than any file's own worst-case runtime is EVER expected to be, but no longer this lock's
// PRIMARY defense WITHIN one gate-executing process — see the file header. `scripts/test-daemon.mjs`'s
// own sequential scheduling for CODEX_REAL_SPAWN_BASENAMES above (read the array for current membership
// — restating it here would drift the moment it changes again) is what prevents concurrent contention
// AMONG this family's own members WITHIN that one process; it says nothing about a SECOND, independent
// gate-executing process (another merge, another worker `run_gate`, a deploy) also running this family
// at the same time — each schedules its OWN family sequentially and is blind to the other, so this lock
// (a single OS-wide file under `os.tmpdir()`, never per-project or per-repo) is the ONLY thing serializing
// them. CORRECTED by card e4701333 (was: "this number does NOT need to scale with membership count — it
// never has to cover N-1 *other* holders finishing first"; that claim is TRUE only for contention WITHIN
// one process's own sequential scheduling, and was FALSE the moment more than one gate-executing process
// could run this family concurrently — always possible under `maxConcurrentGates > 1` for two DIFFERENT
// repos, and — before card e4701333's own fix in `gate-semaphore.ts` — possible even for the SAME repo
// via a merge gate racing a worker's `run_gate`). This budget must still exceed ONE legitimate holder's
// worst real runtime, but a waiter here CAN genuinely have to wait for another PROCESS's own holder to
// finish first — a false red under that condition is a CONFIRMED occurrence of the hazard card e4701333
// investigated, not evidence this budget is mis-sized; see that card if it happens. Sized from ACTUAL
// production gate-op `7d31427a`'s surviving log
// (~/.loom/gate-output/7d31427a-824f-495c-8606-c868ae77cfac.log, captured while still present under
// gate-output/'s count+byte-bounded retention — see gate-spill.ts, never time-based) under REAL 4-way
// contention (the family's size AT THAT TIME, before this
// file's own 5th member was added) — the exact condition this fix removes:
// codex-transcript-real-spawn 120.0s (killed at the OUTER per-file ceiling, still holding this lock —
// see PID-liveness reaping below for why that no longer costs a full STALE_MS wait), codex-doctrine-
// real-spawn 96.8s (PASS), codex-mcp-reachability-real-spawn 91.7s (FAIL, blocked on this very lock),
// codex-stateful-runtime-real-spawn 69.4s (PASS). 180s clears the highest of those with real margin while
// staying well below STALE_MS (5 min) — this is a genuine field measurement, not a guess; if a fresh
// contended-vs-sequential comparison after this fix lands shows a smaller number suffices, it can shrink,
// but there was never a passing run recorded above 120s to justify going lower than that on this data
// alone.
const STALE_MS = 5 * 60_000;
const POLL_MS = 250;
const WAIT_TIMEOUT_MS = 180_000;

// Card 3791b14e DoD-3: a holder killed via `scripts/test-daemon.mjs`'s own per-file timeout (`child.kill()`
// with no signal — Node reports it to the PARENT as "SIGTERM", but EMPIRICALLY CONFIRMED on this host
// (a throwaway spawn+kill+observe script, not this file's own test-shaped code) that the CHILD's own
// `process.on("SIGTERM")` handler and `_tmp-fixture.mjs`'s `beforeExit`/`exit` hooks never run — the
// child is torn down before any JS-level cleanup executes, same non-coverage that file's own header
// already discloses for SIGKILL/`taskkill /F`, just reached here by this repo's ordinary timeout-kill
// path too. So a killed holder's lock file survives it. Without this check, the NEXT waiter would have to
// sit out the full STALE_MS (5 min) even though the holder is provably gone the instant it dies.
// Returns true (dead — reapable now), false (confirmed alive), or null (can't tell — e.g. the lock file's
// `pid=` field isn't there yet because the writer is between its `openSync`/`writeSync` calls, or a
// permissions error on the liveness probe itself) so the caller can fall back to the age-only check
// rather than guessing either way.
function isRecordedHolderDead(lockContent) {
  const match = /pid=(\d+)/.exec(lockContent);
  if (!match) return null;
  try {
    process.kill(Number(match[1]), 0); // signal 0: existence probe only, sends nothing
    return false;
  } catch (err) {
    return err.code === "ESRCH" ? true : null; // ESRCH = definitively gone; anything else, don't guess
  }
}

function tryAcquireOnce() {
  try {
    // "wx": atomic create-exclusive — throws EEXIST if another process already holds it. This is the
    // actual mutual-exclusion primitive; everything else here is retry/staleness bookkeeping around it.
    const fd = fs.openSync(LOCK_PATH, "wx");
    fs.writeSync(fd, `pid=${process.pid} at=${new Date().toISOString()}`);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    try {
      // PID-liveness first (see isRecordedHolderDead's own doc) — a dead recorded holder is reapable
      // immediately regardless of age. STALE_MS (untouched) remains the fallback for the one case
      // liveness can't resolve: the recorded pid got reused by an unrelated process after the real
      // holder exited.
      const holderDead = isRecordedHolderDead(fs.readFileSync(LOCK_PATH, "utf8"));
      const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
      if (holderDead === true || age > STALE_MS) {
        fs.rmSync(LOCK_PATH, { force: true });
        return tryAcquireOnce();
      }
    } catch {
      // Lost the race to read/remove it (another process reaped or refreshed it first) — fall through to
      // the caller's own poll loop rather than treating this as a hard failure.
    }
    return false;
  }
}

// Card bb9a30ba: identifies the WAITING file for the two WARN lines below. Each CODEX_REAL_SPAWN_BASENAMES
// file runs as its own child process (scripts/test-daemon.mjs's `spawn(process.execPath, [file], ...)`),
// so `process.argv[1]` is that file's own path — no stack-trace inspection needed (the membership guard's
// own doc, above, already rejects stack-trace-based identification as fragile; this sidesteps it entirely
// by reading the one thing node itself guarantees: the entry script path of the running process).
function waiterName() {
  return process.argv[1] ? path.basename(process.argv[1]) : "unknown-caller";
}

/**
 * Opts THIS process into raw (unredacted) message-content diagnostics (`LOOM_LOG_MESSAGE_CONTENT=1`, read
 * per call by `paths.ts` › `isLogMessageContentEnabled`) so an in-gate failure logs codex's actual screen
 * tail instead of `<redacted len=… hash=…>`. Safe ONLY because every prompt these files drive through their
 * in-process `PtyHost` is a synthetic fixture (temp-dir paths, "reply pong", a doctrine-id probe) — never
 * real user content. Called from `acquireCodexRealSpawnLock()` (each family member's own child process
 * calls it before spawning) and deliberately NOT at module import: `scripts/test-daemon.mjs` imports this
 * file in the PARENT process, and an import-time set there would leak into every child test's env.
 * The daemon's own redaction default is untouched.
 */
export function enableRawFixtureLogging() {
  process.env.LOOM_LOG_MESSAGE_CONTENT = "1";
}

// ---- Usage-limit preflight (card fb119c4c) ---------------------------------------------------------------
// WHY: when the codex ACCOUNT is over its usage limit, `codex exec` prints "You've hit your usage limit …
// try again at <date>" and the interactive TUI just sits at "Working (0s)" forever — so every real-codex
// file hangs to its ceiling and the whole gate reds for a reason no code change can fix.
// WHY A PREFLIGHT, NOT FAILURE-TIME DETECTION: the TUI never prints the limit text into the captured pty
// (it only hangs), so a failure-time scan would have nothing to match and each file would burn its full
// timeout first; the one place codex states the limit positively is `codex exec`.
// COST: one tiny real model turn ("Reply with exactly: PONG") when the account is healthy — bounded by
// PROBE_TIMEOUT_MS and CACHED for PROBE_CACHE_MS in a host-wide temp file, so a healthy host pays ONE turn
// per ~10 min across the whole family, not one per file. An exhausted account refuses immediately and
// spends nothing.
// WHAT COUNTS AS LIMITED: ONLY output matching USAGE_LIMIT_RE. A hang/timeout, spawn error, auth failure
// or any other error is NOT "limited" — the real test then runs and fails on its own, as before. There is
// no skip-on-any-failure path.
const PROBE_TIMEOUT_MS = Number(process.env.LOOM_CODEX_USAGE_PROBE_TIMEOUT_MS) || 45_000; // env: hermetic-test seam
const PROBE_CACHE_MS = 10 * 60_000;
const USAGE_LIMIT_RE = /you['’]?ve hit your usage limit/i;
const PROBE_CACHE_PATH = process.env.LOOM_CODEX_USAGE_PROBE_CACHE || path.join(os.tmpdir(), "loom-codex-usage-probe.json"); // env: hermetic-test seam

/** Pure: does codex output POSITIVELY report the usage limit? detail = the "try again at …" clause if
 *  present, else the matched line. */
export function detectCodexUsageLimit(text) {
  const s = String(text ?? "");
  if (!USAGE_LIMIT_RE.test(s)) return { limited: false, detail: null };
  const reset = /try again at\s+([^\r\n]*?)\.?\s*(?:\r?\n|$)/i.exec(s);
  const line = s.split(/\r?\n/).find((l) => USAGE_LIMIT_RE.test(l)) ?? "";
  return { limited: true, detail: reset ? `resets ${reset[1].trim()}` : line.trim() };
}

// pid-scoped tree kill of the probe we spawned (a win32 shell wrapper leaves the real child alive on a bare kill()).
function killTree(child) {
  try {
    if (process.platform === "win32" && child.pid) spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
    else child.kill();
  } catch {}
}

/** Runs the probe once; never throws. opts (test seams): bin, prefixArgs, shell, timeoutMs. */
export function probeCodexUsageLimit(opts = {}) {
  const bin = opts.bin ?? process.env.LOOM_CODEX_BIN ?? "codex";
  const shell = opts.shell ?? process.platform === "win32";
  const args = [...(opts.prefixArgs ?? []), "exec", "--skip-git-repo-check", shell ? "\"Reply with exactly: PONG\"" : "Reply with exactly: PONG"]; // shell:true joins argv unquoted — quote the prompt so it stays ONE argument
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(detectCodexUsageLimit(out));
    };
    try {
      child = spawn(bin, args, { shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return finish();
    }
    timer = setTimeout(() => { killTree(child); finish(); }, opts.timeoutMs ?? PROBE_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", finish);
    child.on("close", finish);
  });
}

/** Cached probe (host-wide temp file). opts.cachePath is a test seam. */
export async function codexUsageLimitStatus(opts = {}) {
  const cachePath = opts.cachePath ?? PROBE_CACHE_PATH;
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (typeof c.at === "number" && Date.now() - c.at < PROBE_CACHE_MS) return { limited: !!c.limited, detail: c.detail ?? null };
  } catch {}
  const r = await probeCodexUsageLimit(opts);
  try { fs.writeFileSync(cachePath, JSON.stringify({ at: Date.now(), ...r })); } catch {}
  return r;
}

/**
 * Acquire the shared real-codex-spawn lock, polling up to WAIT_TIMEOUT_MS. Registers the lock file for
 * this process's own guaranteed cleanup (`_tmp-fixture.mjs`'s `beforeExit`/`exit` hooks) so a crash
 * mid-run still releases it (SIGKILL excepted — disclosed, unmitigated non-coverage, same as every other
 * caller of that helper).
 *
 * Card bb9a30ba: a successful acquire used to be COMPLETELY SILENT, whether instant or delayed 179s by a
 * contended sibling — making lock contention structurally unattributable in every log, forever. Now: stay
 * silent on the overwhelmingly common uncontended case (no noise), but on first blocked poll emit a
 * `WARN  ` line (the declared-warning convention `scripts/test-daemon.mjs`'s `WARN_LINE_RE` scans for, so
 * it surfaces even on a passing gate — see codex-transcript-real-spawn.mjs's `reportGracefulStopExitCode`
 * for the same convention), and another on eventual acquire carrying the observed wait duration. This is
 * observability only — the acquire/retry/stale-healing mechanism above is unchanged.
 * @returns {Promise<() => void>} a release function — call it exactly once when finished with codex.
 */
export async function acquireCodexRealSpawnLock() {
  enableRawFixtureLogging();
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let waitStartedAt = null;
  while (!tryAcquireOnce()) {
    if (waitStartedAt === null) {
      waitStartedAt = Date.now();
      console.log(`WARN  ${waiterName()} is waiting on the real-codex-spawn lock (${LOCK_PATH}) — held by a sibling real-codex-spawn test file`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `could not acquire ${LOCK_PATH} within ${WAIT_TIMEOUT_MS}ms — held by a stuck/still-running sibling real-codex-spawn test file`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  if (waitStartedAt !== null) {
    console.log(`WARN  ${waiterName()} acquired the real-codex-spawn lock after waiting ${Date.now() - waitStartedAt}ms`);
  }
  registerForCleanup(LOCK_PATH);
  let released = false;
  function release() {
    if (released) return;
    released = true;
    try {
      fs.rmSync(LOCK_PATH, { force: true });
    } catch {
      return; // best-effort — leave it registered so the exit backstop still retries
    }
    if (!fs.existsSync(LOCK_PATH)) unregister(LOCK_PATH);
  }
  // Card fb119c4c: under the lock (one probe at a time), skip LOUDLY if codex positively reports its usage
  // limit. Any other outcome falls through: the real test runs and fails on its own if broken.
  const usage = await codexUsageLimitStatus();
  if (usage.limited) {
    release();
    console.log(`WARN  SKIP  ${waiterName()} — codex account is over its USAGE LIMIT (quota exhausted; ${usage.detail ?? "no reset time reported"}). Real-codex coverage did NOT run on this host; this is not a pass of the codex behaviour.`);
    process.exit(0);
  }
  return release;
}
