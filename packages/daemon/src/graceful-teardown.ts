import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { LOOM_HOME } from "./paths.js";
import { waitForMergeDangerWindowsToClear } from "./git/merge-danger-window.js";
import { VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS, VAULT_GIT_OP_TIMEOUT_MS } from "./vault/versioner.js";

/**
 * This function is the structural fix: it runs `teardown()` best-effort — ANY synchronous throw inside it
 * (not just the one write that has actually been observed to throw; a future write or fault added to that
 * body is covered too) is swallowed — and then UNCONDITIONALLY awaits the merge-danger-window guard before
 * calling `exit`.
 *
 * @decision 7f9444f3 — no teardown write may run unguarded ahead of the merge-danger-aware exit: an
 * unguarded `console.log` in `gracefulShutdown` once threw EPIPE (destroyed stdout, Windows-console-close
 * SIGHUP), skipping it and writing a phantom crash.log misread as `[loom:crash-recovered]`.
 *
 * Because the guard+exit sits outside the try, no failure inside `teardown()` can ever prevent it from
 * running, and because the throw never escapes this function, it can never reach the process-level
 * `uncaughtException` handler that would write a crash record for what is a clean stop.
 *
 * @decision 347b3584 — the try/catch above only ever catches a synchronous THROW inside `teardown()`,
 * never a synchronous BLOCK; never remove the `armHardShutdownWatchdog` arm below on the theory that it
 * does, or a hung teardown step can again strand the whole process for hours with no bound at all.
 */
export function runGracefulTeardown(
  teardown: (step: TeardownStepFn) => void,
  exit: () => void,
  waitFn: () => Promise<void> = waitForMergeDangerWindowsToClear,
  watchdogDeps: { arm?: typeof armHardShutdownWatchdog; hardExitMs?: number; intendedExitCode?: number } = {},
): void {
  const watchdog = (watchdogDeps.arm ?? armHardShutdownWatchdog)({
    hardExitMs: watchdogDeps.hardExitMs,
    intendedExitCode: watchdogDeps.intendedExitCode ?? 0,
    label: "gracefulShutdown",
  });
  try {
    teardown(watchdog.step);
  } catch {
    /* never let a teardown-step failure (incl. a destroyed stdout/stderr) block the merge-danger-aware exit below */
  }
  // always a clean stop — NOT exit 75 (the supervisor's restart sentinel) — UNLESS the watchdog itself
  // already force-exited with a different code (see its own doc: once it fires, this line never runs).
  void waitFn().finally(() => { watchdog.disarm(); exit(); });
}

/** A caller-supplied diagnostic hook: `runGracefulTeardown`'s `teardown` callback (and `requestDaemonRestart`'s
 *  own analogous cleanup+exit sequence, which does NOT go through `runGracefulTeardown` — see the decision
 *  record) calls this before each named top-level step, so a fired watchdog's own log line can name exactly
 *  which step was in progress. Diagnostic only — never consulted for correctness, so a step name is never
 *  validated against a fixed enum; an over-long name is silently truncated (see MAX_STEP_NAME_BYTES).
 *  `budgetMs` (optional) gives THIS step its own deadline, overriding the watchdog's default; omitted, the
 *  watchdog's own default budget (`hardExitMs`) applies.
 *
 * @decision 347b3584 — never drop per-step budgetMs support: one flat deadline for every step can kill a
 * healthy, still-progressing step (e.g. a multi-minute vault flush) mid-write. */
export type TeardownStepFn = (name: string, budgetMs?: number) => void;

export interface HardShutdownWatchdogHandle {
  step: TeardownStepFn;
  /** Signals the watchdog to stand down instead of firing, and releases its worker thread. Idempotent —
   *  safe to call more than once (e.g. from a `finally` that may race an earlier explicit call). */
  disarm(): void;
}

/**
 * 60s DEFAULT per-step budget: comfortably larger than {@link waitForMergeDangerWindowsToClear}'s own 5s
 * grace (so a backstop firing mid-wait never races a merge still inside its danger window — see
 * merge-danger-window.ts), and far below "hours" — generous enough that a genuinely slow-but-working
 * ordinary step still finishes normally, tight enough that a hang can never again strand the daemon for
 * anywhere near as long as the 2026-10-03/04 incident. This is a PER-STEP default (round 2) — every step
 * gets it UNLESS its own `step(name, budgetMs)` call overrides it; see
 * {@link computeFlushVaultsStepBudgetMs} for the one step that does.
 *
 * @decision 347b3584 — never apply this flat figure to EVERY step unconditionally: a healthy vault flush
 * can legitimately run minutes past it, and TerminateProcess-ing it mid `git commit` is a silently
 * dropped commit, not a safe kill.
 */
export const GRACEFUL_TEARDOWN_HARD_EXIT_MS = 60_000;

/**
 * Margin added on top of the derived per-vault flush bound (card 347b3584 round 2) — covers the cheap
 * supervisor-stop half of this same shared cleanup step, plus general scheduling slop (worker-thread
 * startup, Atomics.wait granularity). Small relative to the multi-minute per-vault bound it pads, so it
 * never meaningfully changes the derived figure's order of magnitude. Exported (round 3) so a test can
 * assert {@link computeFlushVaultsStepBudgetMs}'s exact return value against this SAME constant rather
 * than a second, independently-drifting copy of the literal.
 */
export const FLUSH_VAULTS_STEP_BUDGET_MARGIN_MS = 30_000;

/**
 * Derives the shared vault-flush-and-cleanup teardown step's own watchdog budget from versioner.ts's REAL
 * timeout constants — never a copied number. Closes the Code Review finding that a single flat 60s
 * deadline overrode decision 816f0056's deliberate multi-minute vault-flush bound.
 *
 * Each vault's `VaultVersioner.flushSync()` worst case (round 3 — re-derived directly from the method's
 * real body, `versioner.ts`'s `flushSync()`) is TWO working-tree-scale calls PLUS THREE plumbing-tier
 * calls, run serially:
 *   - `git add -A` and `git commit`, each capped at {@link VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS}.
 *   - `git status --porcelain`, PLUS `hasConfiguredGitIdentitySync`'s own two sequential `git config`
 *     reads (`user.name`, `user.email`) — called unconditionally before the commit to pick its identity
 *     branch — each capped at {@link VAULT_GIT_OP_TIMEOUT_MS}. Round 2 counted only the `status` call and
 *     missed these two, under-stating the real worst case by a full {@link VAULT_GIT_OP_TIMEOUT_MS} per
 *     vault (card 347b3584 round 3 finding 3).
 * (see docs/decisions/816f0056-vault-flush-working-tree-timeout-sizing.md for why the working-tree and
 * plumbing-tier ceilings differ) — once per unique governing vault root this process flushes.
 * `versionerCount` is the number of `VaultVersioner`s actually started this boot (0 for a vault-less /
 * all-externally-managed install, in which case this reduces to just the margin — still ample for the
 * cheap supervisor-stop half of the same step).
 *
 * Never drop the two `hasConfiguredGitIdentitySync` git-config reads from this count as "cheap" — each is
 * independently bounded at the SAME {@link VAULT_GIT_OP_TIMEOUT_MS} ceiling as `status`, and a worst-case
 * bound must count every call that can independently run to its own ceiling, not just the fast ones.
 *
 * @decision 347b3584 — never hardcode this figure (or a "looks big enough" literal) at either call site;
 * always call this, so a future change to either versioner.ts constant is automatically reflected here.
 */
export function computeFlushVaultsStepBudgetMs(versionerCount: number): number {
  return versionerCount * (VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS * 2 + VAULT_GIT_OP_TIMEOUT_MS * 3) + FLUSH_VAULTS_STEP_BUDGET_MARGIN_MS;
}

const MAX_STEP_NAME_BYTES = 64;
// Shared buffer layout — Int32 header [0,16) + BigInt64 deadline [16,24) + step name [24, 24+MAX...):
//   [0,4) DONE flag · [4,8) step-name length · [8,12) GENERATION counter (round 3, see HEADER_GEN_INDEX)
//   [12,16) reserved/padding, so the BigInt64 deadline stays 8-byte aligned · [16,24) CURRENT ABSOLUTE
//   DEADLINE (epoch-scale monotonic (timeOrigin+performance.now()), BigInt64 since Int32 overflows) ·
//   [24,...) UTF-8 step name, written before its length is stored so a worker observing a non-zero
//   length also observes the name bytes before it.
const HEADER_DONE_INDEX = 0;
const HEADER_STEP_NAME_LEN_INDEX = 1;
// @decision 347b3584 — never wait on HEADER_DONE_INDEX for the per-step deadline race: it only ever
// flips once, at disarm, so a step() landing between the worker's deadline-read and its Atomics.wait
// call is a lost wakeup there — it sleeps against the STALE deadline instead, killing the process LATE.
const HEADER_GEN_INDEX = 2;
const HEADER_INT_COUNT = 4; // DONE, step-name-len, GEN, reserved/padding
const SAB_INT_HEADER_BYTES = HEADER_INT_COUNT * 4;
const SAB_DEADLINE_BYTES = 8;
const SAB_HEADER_BYTES = SAB_INT_HEADER_BYTES + SAB_DEADLINE_BYTES;

const textEncoder = new TextEncoder();

/**
 * Where a FIRED watchdog persists what it fired for, BEFORE it kills the process — the operator-visible
 * record this card's round 2 adds, since worker stderr is relayed through the (by definition, at the
 * moment this fires) blocked main loop and a human attached to the terminal may never see the
 * `[shutdown] HARD BACKSTOP ...` stderr line at all. Lives under LOOM_HOME (never hardcode `~/.loom`),
 * alongside crash.log / last-shutdown.json / restart-intent.json — one more file in that same family of
 * "classify what the last stop actually was".
 */
export const HARD_SHUTDOWN_WATCHDOG_RECORD_PATH = path.join(LOOM_HOME, "logs", "shutdown-watchdog.json");

/** The record shape a fired watchdog writes to {@link HARD_SHUTDOWN_WATCHDOG_RECORD_PATH}. */
export interface HardShutdownWatchdogRecord {
  firedAt: string;
  step: string;
  intendedExitCode: number;
  label: string;
}

/**
 * Builds a per-firing aside path for a consumed/corrupt record file, stamped with `firedAt` (sanitized —
 * `:`/`.` are invalid in a Windows filename) or, when that's unavailable (a corrupt record, or a missing
 * field), the current epoch ms — PLUS an in-process monotonic sequence number.
 *
 * A single fixed `.handled` suffix used to force an `unlinkSync` of any PRIOR aside file before a later
 * `renameSync` could reuse the same name — deleting an OLDER firing's forensic record.
 *
 * @decision 347b3584 — never go back to one fixed aside name; a distinct, timestamped name per firing
 * needs no unlink, so no firing's record is ever destroyed to make room for a later one.
 *
 * @decision 347b3584 — round 5: a bare timestamp is not PROVABLY unique — `fs.renameSync` on Windows
 * silently OVERWRITES an existing destination rather than erroring, so a collided `firedAt` would clobber
 * an older firing's record with no sign. See the decision record for the measured mechanism.
 */
let asidePathSequence = 0;
function timestampedAsidePath(firedAtIso: string | null): string {
  const parsed = firedAtIso && !Number.isNaN(Date.parse(firedAtIso)) ? firedAtIso : null;
  const stamp = (parsed ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const seq = asidePathSequence++;
  return `${HARD_SHUTDOWN_WATCHDOG_RECORD_PATH}.handled-${stamp}-${seq}`;
}

/**
 * Boot-time consumer (card 347b3584 round 2): if the PRIOR run's hard-exit watchdog fired, this is the
 * only way an operator ever finds out — the firing itself only reaches stderr, which may be unobserved
 * (a detached supervisor, a closed terminal) and is gone the moment the process is force-killed. Reports
 * the record loudly via `console.error` exactly once, then renames the file aside (never deletes it —
 * this is the one genuinely BAD outcome in this whole mechanism's own family of markers, worth keeping
 * around for forensics) so a LATER boot never re-reports the same stale firing. Never throws; returns
 * `null` when no record exists (the overwhelmingly common case) or on any read/parse failure.
 */
export function reportAndConsumeHardShutdownWatchdogRecord(): HardShutdownWatchdogRecord | null {
  try {
    if (!fs.existsSync(HARD_SHUTDOWN_WATCHDOG_RECORD_PATH)) return null;
    const raw = fs.readFileSync(HARD_SHUTDOWN_WATCHDOG_RECORD_PATH, "utf8");
    let parsed: Partial<HardShutdownWatchdogRecord>;
    try {
      parsed = JSON.parse(raw) as Partial<HardShutdownWatchdogRecord>;
    } catch {
      // Round 3 finding 6: an unparseable record used to fall into the single catch-all below and sit on
      // disk forever — every future boot re-attempted and re-failed the SAME parse, silently, with no
      // operator-visible trace at all. Name it loudly and rename it aside so it stops blocking the check.
      console.error(
        `[shutdown] ⚠ found an unparseable hard-exit watchdog record at ${HARD_SHUTDOWN_WATCHDOG_RECORD_PATH} ` +
        `— renaming it aside rather than leaving it to silently block every future boot's check.`,
      );
      try { fs.renameSync(HARD_SHUTDOWN_WATCHDOG_RECORD_PATH, timestampedAsidePath(null)); } catch { /* best-effort */ }
      return null;
    }
    const record: HardShutdownWatchdogRecord = {
      firedAt: typeof parsed.firedAt === "string" ? parsed.firedAt : "",
      step: typeof parsed.step === "string" ? parsed.step : "(unknown)",
      intendedExitCode: typeof parsed.intendedExitCode === "number" ? parsed.intendedExitCode : -1,
      label: typeof parsed.label === "string" ? parsed.label : "(unknown)",
    };
    console.error(
      `[shutdown] ⚠ the hard-exit watchdog FIRED during the previous run — a teardown step hung past its budget ` +
      `and the process was force-killed. label=${record.label} step="${record.step}" firedAt=${record.firedAt} ` +
      `intendedExitCode=${record.intendedExitCode}. See docs/decisions/347b3584-graceful-teardown-hard-exit-backstop.md.`,
    );
    try {
      fs.renameSync(HARD_SHUTDOWN_WATCHDOG_RECORD_PATH, timestampedAsidePath(record.firedAt || null));
    } catch { /* best-effort — a failed rename just means a later boot may re-report the same record once more */ }
    return record;
  } catch {
    return null;
  }
}

/**
 * A monotonic, wall-clock-independent "epoch-like" ms reading: `performance.timeOrigin` is fixed once per
 * PROCESS (not per-thread — verified directly: a Worker created seconds after process start reports the
 * identical `timeOrigin` the main thread does) and `performance.now()` advances via the OS monotonic clock
 * (`uv_hrtime`), never the adjustable wall clock. Summing them gives a value on the same numeric scale as
 * `Date.now()` (useful for sanity/forensics) that tracks real elapsed time even across an NTP correction or
 * a wall-clock step, which `Date.now()` itself cannot — see round 6 of the decision record for the one
 * residual this does NOT paper over (CLOCK_MONOTONIC's suspend semantics differ by platform).
 *
 * @decision 347b3584 — round 6: never go back to `Date.now()` for deadline arithmetic (arm, step(), or the
 * worker's own wait-loop read) — a forward wall-clock step can fire this watchdog EARLY, mid `git commit`;
 * a backward step can fire it LATE, reintroducing the original incident's unbounded hang.
 */
function monotonicNowMs(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * Arms an off-main-thread watchdog that force-exits the WHOLE process, preserving `intendedExitCode`, if
 * nobody calls `step()`/`disarm()` often enough to keep pushing the deadline forward. Runs via a real OS
 * thread (`worker_threads`, `Atomics.wait` on a `SharedArrayBuffer`), never a main-thread timer, and on
 * `win32` kills through a PowerShell `TerminateProcess` P/Invoke (ALWAYS falling through to a plain
 * `process.kill` afterward too — see the round 2 note below); POSIX gets `SIGKILL` only. `hardExitMs` is
 * the DEFAULT per-step budget (the initial arm, and any `step()` call that omits its own `budgetMs`); the
 * watchdog worker re-reads the CURRENT deadline every time it wakes, picking up a `step()`-moved deadline
 * immediately rather than only once its stale wait would have expired — see {@link buildWatchdogWorkerSource}.
 *
 * @decision 347b3584 — never swap this for a main-thread `setTimeout`, and never swap the win32 kill for
 * a bare `process.kill`: neither can survive/preserve a custom exit code against a synchronously-blocked
 * main thread, which is exactly the case this exists to cover.
 *
 * Round 6 Code Review: this used to take an injectable `now?: () => number` as a "test seam" — removed.
 * It only ever skewed the MAIN-thread write side while the real worker always reads the real clock, so a
 * skewed `now` here just makes the two sides disagree about the deadline for no reason a real caller would
 * ever want — and if a test armed this IN-PROCESS (not a real child) with a `now` skewed enough to read as
 * already-elapsed, the watchdog would genuinely `TerminateProcess`/`SIGKILL` the TEST RUNNER'S OWN process
 * (the worker shares `process.pid` with whatever process armed it — see the decision record's own
 * "never forget .unref()" note for the identical hazard). The test suite instead proves BOTH the
 * main-thread write side and the worker's read side via sibling-dist-file source patches, never a runtime
 * DI parameter — see round 6 of the decision record.
 */
export function armHardShutdownWatchdog(opts: {
  hardExitMs?: number;
  intendedExitCode: number;
  label: string;
}): HardShutdownWatchdogHandle {
  const defaultStepBudgetMs = opts.hardExitMs ?? GRACEFUL_TEARDOWN_HARD_EXIT_MS;
  const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + MAX_STEP_NAME_BYTES);
  const header = new Int32Array(sab, 0, HEADER_INT_COUNT);
  const deadline = new BigInt64Array(sab, SAB_INT_HEADER_BYTES, 1);
  const nameBytes = new Uint8Array(sab, SAB_HEADER_BYTES, MAX_STEP_NAME_BYTES);
  // Initial deadline — covers the window between arming and the first step() call (e.g. a hang during
  // the arm itself, or a caller that never calls step() at all).
  Atomics.store(deadline, 0, BigInt(Math.round(monotonicNowMs() + defaultStepBudgetMs)));

  // Best-effort: create the record file's directory up front (cheap, synchronous, main thread) so a
  // FIRED watchdog's own write (from inside the worker, under time pressure) never has to mkdir first.
  try { fs.mkdirSync(path.dirname(HARD_SHUTDOWN_WATCHDOG_RECORD_PATH), { recursive: true }); } catch { /* best-effort */ }

  let disarmed = false;
  let worker: Worker | null = null;
  try {
    worker = new Worker(buildWatchdogWorkerSource(), {
      eval: true,
      workerData: {
        sab, intendedExitCode: opts.intendedExitCode, label: opts.label,
        recordPath: HARD_SHUTDOWN_WATCHDOG_RECORD_PATH,
      },
    });
    // Never itself keeps the process alive: on the clean path this is the handle that would otherwise
    // hold the event loop open even though nothing else does (card 347b3584 REQUIRED 3c) — the worker
    // thread's own Atomics.wait is irrelevant to that, since .unref() tells the MAIN thread's loop to
    // stop counting this Worker handle at all; Node force-terminates any still-live worker when the real
    // process exit happens regardless.
    worker.unref();
    worker.on("error", () => { /* best-effort — a watchdog that itself fails must never crash teardown */ });
  } catch {
    /* best-effort: if the Worker can't even be constructed, teardown proceeds unguarded rather than throwing */
  }

  return {
    step(name: string, budgetMs?: number) {
      try {
        const encoded = textEncoder.encode(name).subarray(0, MAX_STEP_NAME_BYTES);
        nameBytes.set(encoded);
        Atomics.store(header, HEADER_STEP_NAME_LEN_INDEX, encoded.length);
        const budget = budgetMs ?? defaultStepBudgetMs;
        Atomics.store(deadline, 0, BigInt(Math.round(monotonicNowMs() + budget)));
        // Round 3 finding 2: increment the generation BEFORE notifying, and wake waiters on the
        // GENERATION index, never the DONE-flag index — see HEADER_GEN_INDEX's own doc for the lost-
        // wakeup this closes. The worker's Atomics.wait(header, HEADER_GEN_INDEX, observedGen, ...) is an
        // atomic compare-and-block, so a generation bump landing before the worker even calls it still
        // makes that call return immediately instead of blocking on a now-stale deadline.
        Atomics.add(header, HEADER_GEN_INDEX, 1);
        Atomics.notify(header, HEADER_GEN_INDEX);
      } catch { /* diagnostic only — never let a step marker failure affect real teardown */ }
    },
    disarm() {
      if (disarmed) return;
      disarmed = true;
      try {
        Atomics.store(header, HEADER_DONE_INDEX, 1);
        // Also bump+notify the GENERATION index (never just the DONE flag alone) — the worker waits on
        // HEADER_GEN_INDEX now, so disarm() must wake it through the SAME index step() does, or a worker
        // already mid-wait would sleep until its current deadline regardless of the DONE flag having flipped.
        Atomics.add(header, HEADER_GEN_INDEX, 1);
        Atomics.notify(header, HEADER_GEN_INDEX);
      } catch { /* best-effort */ }
      try { void worker?.terminate(); } catch { /* best-effort */ }
    },
  };
}

/**
 * The watchdog worker's own source, as an `eval`-mode string (no separate compiled file to resolve a
 * runtime path for — verified this project's `"type":"module"` ESM setup still lets an eval-mode Worker
 * use plain CommonJS `require()` inside its own isolated context, independent of the parent's module
 * system). Pure CommonJS deliberately — `eval:true` workers are the one place in this codebase that gets
 * to use `require()`, since there is no file path for `import` to resolve against. The wait loop re-reads
 * the current absolute deadline on every wake, so a `step()`-moved deadline (shorter OR longer) is picked
 * up on the next iteration rather than only once a stale wait would have expired.
 *
 * @decision 347b3584 — never wait once against a single fixed duration here; always re-derive "remaining"
 * from the shared deadline slot on every loop iteration, or a later step()'s own budget is ignored.
 */
function buildWatchdogWorkerSource(): string {
  return `
const { workerData } = require("node:worker_threads");
const { execFileSync } = require("node:child_process");
const fsMod = require("node:fs");
const { performance } = require("node:perf_hooks");

// @decision 347b3584 — round 6: read the deadline against performance.timeOrigin+performance.now()
// (monotonic, process-wide — verified identical to the main thread's own reading), never Date.now() —
// see monotonicNowMs's own doc for why.
function monotonicNowMs() { return performance.timeOrigin + performance.now(); }

const { sab, intendedExitCode, label, recordPath } = workerData;
const HEADER_DONE_INDEX = ${HEADER_DONE_INDEX};
const HEADER_STEP_NAME_LEN_INDEX = ${HEADER_STEP_NAME_LEN_INDEX};
const HEADER_GEN_INDEX = ${HEADER_GEN_INDEX};
const header = new Int32Array(sab, 0, ${HEADER_INT_COUNT});
const deadline = new BigInt64Array(sab, ${SAB_INT_HEADER_BYTES}, 1);
const nameBytes = new Uint8Array(sab, ${SAB_HEADER_BYTES}, ${MAX_STEP_NAME_BYTES});

function currentStepName() {
  try {
    const len = Atomics.load(header, HEADER_STEP_NAME_LEN_INDEX);
    if (len > 0) return Buffer.from(nameBytes.slice(0, len)).toString("utf8");
  } catch {}
  return "(no step reached)";
}

// Loops until EITHER the current deadline has genuinely elapsed with nobody disarming (⇒ "fired"), or
// disarm() has set the DONE flag (⇒ "disarmed"). Waits on the GENERATION index (round 3 finding 2), never
// the DONE-flag index: Atomics.wait's compare-and-block is atomic, so if step()/disarm() already bumped
// the generation before this call (a step() landing between our deadline read and this wait — the lost-
// wakeup window), the compare fails and this returns immediately instead of blocking on a stale value,
// and the loop re-reads the FRESH deadline on its very next turn rather than sleeping through to the old one.
function waitForDeadlineOrDisarm() {
  let observedGen = Atomics.load(header, HEADER_GEN_INDEX);
  for (;;) {
    const remaining = Number(Atomics.load(deadline, 0)) - monotonicNowMs();
    if (remaining <= 0) return "fired";
    Atomics.wait(header, HEADER_GEN_INDEX, observedGen, remaining);
    if (Atomics.load(header, HEADER_DONE_INDEX) === 1) return "disarmed";
    // else: either a genuine timeout against the deadline just read (loop top will see remaining <= 0
    // and fire), or a generation bump from a fresh step() call (loop top re-reads the new deadline) —
    // either way, re-sync observedGen and loop back to the top.
    observedGen = Atomics.load(header, HEADER_GEN_INDEX);
  }
}

if (waitForDeadlineOrDisarm() === "fired") {
  const stepName = currentStepName();
  const line = "[shutdown] HARD BACKSTOP (" + label + ") fired — last step reached: \\"" + stepName + "\\" — force-exiting with intended code " + intendedExitCode + "\\n";
  try { process.stderr.write(line); } catch {}
  // Persist the firing BEFORE the kill — this is the operator's only durable visibility into a firing
  // the stderr line above may never be observed for (a detached supervisor, a closed terminal). Never fd
  // 2 (stderr) — a real file, via fs.writeSync on an explicitly opened fd.
  try {
    const record = JSON.stringify({ firedAt: new Date().toISOString(), step: stepName, intendedExitCode, label }) + "\\n";
    const fd = fsMod.openSync(recordPath, "w");
    try { fsMod.writeSync(fd, record); } finally { fsMod.closeSync(fd); }
  } catch {}

  const pid = process.pid; // the worker shares the real OS process id with the main thread
  let winCustomExitConfirmed = false;
  if (process.platform === "win32") {
    try {
      const ps =
        "Add-Type -Name NativeMethods -Namespace LoomShutdownWatchdog -MemberDefinition @'\\n" +
        "[DllImport(\\"kernel32.dll\\", SetLastError=true)] public static extern IntPtr OpenProcess(uint processAccess, bool inheritHandle, int processId);\\n" +
        "[DllImport(\\"kernel32.dll\\", SetLastError=true)] public static extern bool TerminateProcess(IntPtr hProcess, uint exitCode);\\n" +
        "'@\\n" +
        "$h = [LoomShutdownWatchdog.NativeMethods]::OpenProcess(0x0001, $false, " + pid + ")\\n" +
        "if ($h -eq [IntPtr]::Zero) { exit 1 }\\n" +
        "$ok = [LoomShutdownWatchdog.NativeMethods]::TerminateProcess($h, " + intendedExitCode + ")\\n" +
        "if (-not $ok) { exit 1 }\\n";
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 10000, stdio: "ignore" });
      // execFileSync did not throw ⇒ the PS script exited 0 ⇒ OpenProcess returned a non-null handle AND
      // TerminateProcess itself returned true ⇒ the custom-exit-code kill is CONFIRMED already in flight.
      winCustomExitConfirmed = true;
    } catch { /* null OpenProcess handle, TerminateProcess returning false, or execFileSync itself failing/
                 timing out — none of these confirm the custom-code kill, so the raw fallback below still runs */ }
  }
  // Round 5 (card 0dc09fab): ONLY fall through to the raw SIGKILL fallback when the custom-code kill was
  // NOT confirmed — see the decision record for why an unconditional second TerminateProcess call can lose
  // the intended exit code under load. Unaffected on POSIX (winCustomExitConfirmed stays false there), so
  // the fallback still always runs there exactly as before.
  if (!winCustomExitConfirmed) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}
`;
}
