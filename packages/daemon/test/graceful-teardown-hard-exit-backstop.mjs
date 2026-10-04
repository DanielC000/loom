// Card 347b3584: a 2026-10-03/04 incident found that runGracefulTeardown's try/catch only ever caught a
// synchronous THROW inside teardown(), never a synchronous BLOCK — a hung teardown step strands the whole
// process for hours with no bound at all, bypassing the merge-danger-aware exit entirely. This file
// proves the fix two ways:
//
//   (1) IN-PROCESS, with a FAKE injected `arm` (no real worker/kill) — fast unit coverage of
//       runGracefulTeardown's OWN orchestration: the watchdog is armed before teardown() runs, disarm()
//       fires exactly once right before exit() (never before waitFn() itself settles), and a throw inside
//       teardown() still reaches disarm()+exit() exactly as before this card (card 7f9444f3's own
//       guarantee, unregressed).
//   (2) REAL CHILD PROCESSES, against the REAL armHardShutdownWatchdog (dist/graceful-teardown.js) — the
//       actual claim under test: a genuinely synchronously-blocked main thread (Atomics.wait, zero
//       event-loop activity — the exact shape a stalled console/pipe write or a hung sync subprocess call
//       takes) still gets force-exited within the configured window, with the EXACT requested exit code
//       preserved on win32 (both 0 and 75 — "Test both", since daemon_restart's own analogous site needs
//       75 to keep scripts/daemon-supervisor.mjs's relaunch-on-75 check firing) or a bare SIGKILL signal on
//       POSIX (round 2 finding 5 — POSIX has no "kill with a chosen code" syscall; see the decision
//       record). A third real-child scenario proves the watchdog's own Worker is genuinely .unref()'d,
//       honestly (round 2 nitpick 4): never disarmed, the process still exits on its own, well before
//       hardExitMs, because nothing else keeps the event loop alive. A fourth proves the PER-STEP budget
//       (round 2 finding 1): a step with a long override survives past the short default, but a LATER
//       step with no override is still bounded by it.
//
// Round 2 ALSO adds: the fired watchdog's own durable record file (finding 2) is asserted directly off
// disk, and `reportAndConsumeHardShutdownWatchdogRecord()` is proven to report-then-rename it aside; and a
// structural check (finding 3) that the win32 kill path no longer short-circuits the SIGKILL fallback
// behind a "did PowerShell appear to succeed" flag — it must ALWAYS fall through.
//
// Round 3 (delta Code Review 91ef0b45) ALSO adds: the per-step-budget test (D)'s bound is tightened so it
// can actually detect a missing step()-side wake-up (round 2's bound was loose enough that a completely
// missing notify still passed — see the decision record); a formula assertion for
// `computeFlushVaultsStepBudgetMs` against versioner.ts's real exported constants; a threading assertion
// that the GRACEFUL arm's own call shape (index.ts's `step("flushVaultsAndStopCodescape", <real computed
// budget>)`) carries that real value through to the watchdog, not a copied number (the RESTART arm's own
// threading is asserted separately, in daemon-restart-hard-exit-watchdog.mjs); the rename-aside checks
// (round 2) now assert the TIMESTAMPED-per-firing scheme (round 3 finding 4) never unlinks an earlier
// firing's forensic record; and a new case proving a corrupt record file is reported + renamed aside
// rather than silently blocking every future boot's check forever (round 3 finding 6). Test (B) now uses a
// fixture that genuinely calls disarm() (round 3 nitpick 7) — it used to run the SAME fixture/args as (C)
// below, which deliberately never disarms, so (B) never actually exercised the path its own name claimed.
//
// Round 6 (card e34cb710) ALSO adds: the watchdog's deadline arithmetic moved from Date.now() (wall-clock)
// to performance.timeOrigin+performance.now() (monotonic) on both the main-thread write side (arm/step())
// and the worker's own read side — see the decision record's own round 6 section for the full rationale
// and the sleep/hibernate residual. No runtime DI seam is used for either side (delta Code Review: an
// injectable `now` could arm an in-process watchdog with an already-elapsed deadline and SIGKILL the test
// runner's own process); both sides are proven via sibling-dist-file patches instead — regex-reverting the
// worker's own read line, or BOTH main-thread write call sites, back to literal Date.now(), paired with a
// constant offset applied to the WORKER's Date.now() (read-side proof) or the FIXTURE's own parent-thread
// Date.now() before arming (write-side proof). Every check measures the durable watchdog RECORD FILE's
// appearance time, never process-exit timing, to stay immune to win32 kill-path overhead under load.
//
// HERMETIC: no real daemon boot (dist/index.js is never spawned), no *-real-spawn* shape. Every real
// child process here is one of this file's own tiny fixtures under test/fixtures/, spawned directly, and
// each of THOSE fixtures now also calls requireHermeticEnv() itself (round 3 finding 8) — a real incident
// had a reviewer run one standalone, with no LOOM_HOME set, writing a stray record into the real
// `~/.loom/logs/shutdown-watchdog.json`. LOOM_HOME is pinned to an isolated temp dir (never the real
// `~/.loom`) since a firing watchdog now writes a record file under it.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { pollUntil } from "./_timing-guard.mjs";

const loomHome = useOwnLoomHome("loom-graceful-teardown-backstop-");
const {
  runGracefulTeardown,
  HARD_SHUTDOWN_WATCHDOG_RECORD_PATH,
  reportAndConsumeHardShutdownWatchdogRecord,
  computeFlushVaultsStepBudgetMs,
  FLUSH_VAULTS_STEP_BUDGET_MARGIN_MS,
} = await import("../dist/graceful-teardown.js");
const { VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS, VAULT_GIT_OP_TIMEOUT_MS } = await import("../dist/vault/versioner.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const SYNC_HANG = path.join(FIXTURES_DIR, "_graceful-teardown-sync-hang.mjs");
const CLEAN = path.join(FIXTURES_DIR, "_graceful-teardown-clean.mjs");
const DISARM_THEN_EXIT = path.join(FIXTURES_DIR, "_graceful-teardown-disarm-then-exit.mjs");
const PER_STEP_BUDGET = path.join(FIXTURES_DIR, "_graceful-teardown-per-step-budget.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const DIST_DIR = path.join(__dirname, "..", "dist");
const REAL_DIST_PATH = path.join(DIST_DIR, "graceful-teardown.js");

// Shared by every sibling-dist-patch technique in this file (win32 PS-script patch below, and the round 6
// clock-monotonicity patch) — hoisted here (was previously nested inside the win32-only block) so both can
// use the SAME pid-liveness check without duplicating it.
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // `EPERM` means the pid EXISTS but this process lacks permission to signal it (a different user's
    // process, or a privilege gap) — that's still ALIVE, never grounds to delete its file. `ESRCH` (no
    // such process) is the one outcome that actually means dead, which is what the bare `false` below
    // still covers.
    return err?.code === "EPERM";
  }
}

// Sweeps a stale `graceful-teardown.<prefix>-<pid>-<rand>.js` sibling left behind by a prior run that
// crashed/was killed before its own `finally` cleanup ran (a packed npm tarball never has one in the first
// place, so this only ever prunes test-run debris). Never removes a LIVE sibling's file — a concurrently
// running copy of this same test file has its own pid baked into its own filename and stays untouched.
function sweepStaleDistSiblings(prefix) {
  let names = [];
  try { names = fs.readdirSync(DIST_DIR); } catch { return 0; }
  const re = new RegExp(`^graceful-teardown\\.${prefix}-(\\d+)-[a-z0-9]+\\.js$`);
  let removed = 0;
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || isPidAlive(pid)) continue;
    try { fs.unlinkSync(path.join(DIST_DIR, name)); removed++; } catch { /* best-effort */ }
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------------
// (1) IN-PROCESS: runGracefulTeardown's own orchestration, against a FAKE arm (never a real worker/kill)
// ---------------------------------------------------------------------------------------------------

function fakeArm(events) {
  return () => {
    events.push("armed");
    let disarmed = false;
    return {
      // Round 3 finding 5: record budgetMs too (when given), so a threading test can assert the EXACT
      // value a caller passed actually reached the watchdog's step() call, not just that step() was
      // called at all. A call with no override (e.g. step("mid-teardown")) still records the bare
      // "step:<name>" form, unchanged, so every pre-existing check against that exact string still matches.
      step(name, budgetMs) { events.push(budgetMs !== undefined ? `step:${name}:budget=${budgetMs}` : `step:${name}`); },
      disarm() {
        if (disarmed) return;
        disarmed = true;
        events.push("disarmed");
      },
    };
  };
}

{
  // Clean/fast path — byte-identical ordering to the pre-card behavior, plus the new arm/disarm bracket.
  const events = [];
  let exited = false;
  let sawStep = null;
  runGracefulTeardown(
    (step) => { sawStep = typeof step; step("mid-teardown"); events.push("teardown-ran"); },
    () => { events.push("exit-called"); exited = true; },
    () => Promise.resolve(), // waitFn settles immediately
    { arm: fakeArm(events) },
  );
  // runGracefulTeardown is synchronous up to `void waitFn().finally(...)` — the finally runs on a
  // microtask, so give it one tick to settle before asserting the tail of the sequence.
  await Promise.resolve();
  await Promise.resolve();
  check("[clean path] teardown() receives a callable step function", sawStep === "function");
  check("[clean path] armed before teardown ran", events.indexOf("armed") === 0 && events.indexOf("armed") < events.indexOf("teardown-ran"));
  check("[clean path] step() calls are recorded", events.includes("step:mid-teardown"));
  check("[clean path] disarm() happens before exit()", events.indexOf("disarmed") !== -1 && events.indexOf("disarmed") < events.indexOf("exit-called"));
  check("[clean path] exit() was called", exited);
}

{
  // teardown() throws synchronously — card 7f9444f3's pre-existing guarantee (disarm+exit still run)
  // must survive this card's change unregressed.
  const events = [];
  let exited = false;
  runGracefulTeardown(
    () => { events.push("teardown-threw"); throw new Error("boom"); },
    () => { events.push("exit-called"); exited = true; },
    () => Promise.resolve(),
    { arm: fakeArm(events) },
  );
  await Promise.resolve();
  await Promise.resolve();
  check("[teardown throws] the throw is swallowed and exit() still runs (7f9444f3 unregressed)", exited === true);
  check("[teardown throws] disarm() still runs despite the throw", events.includes("disarmed"));
}

{
  // waitFn() is slow (not instant) — disarm()/exit() must wait for it, not fire the moment teardown()
  // itself returns. Proves the watchdog stays armed through the WHOLE wait, not just through teardown().
  //
  // The "disarm has NOT fired yet" check below is NOT a fixed-wait negative assertion: it is gated on a
  // manually-held Promise (`release` is only called AFTER the assertion runs), so "waitFn hasn't settled"
  // is true by CONSTRUCTION at that point — `.finally()`'s callback cannot possibly have run yet, since
  // the promise it's attached to has not resolved — not an inference from elapsed time in one trial.
  const events = [];
  let release;
  const heldWaitFn = () => new Promise((resolve) => { release = resolve; });
  runGracefulTeardown(
    (step) => { step("fast-teardown"); },
    () => { events.push("exit-called"); },
    heldWaitFn,
    { arm: fakeArm(events) },
  );
  // Let the synchronous teardown()+waitFn() call chain inside runGracefulTeardown actually run (it's all
  // synchronous up to the `void waitFn().finally(...)` statement) — one microtask flush is enough, since
  // nothing async happens before that point.
  await Promise.resolve();
  check("[held waitFn] disarm() has NOT fired while waitFn's promise is still unresolved (true by construction, not by elapsed time)", !events.includes("disarmed"));
  check("[held waitFn] exit() has NOT fired either, for the same reason", !events.includes("exit-called"));
  release();
  const settled = await pollUntil(() => events.includes("disarmed") && events.includes("exit-called"), { timeoutMs: 2000, intervalMs: 5 });
  check("[held waitFn] disarm()/exit() fire once the held waitFn is finally released", settled);
}

{
  // Round 3 finding 5 — FORMULA assertion: re-derive computeFlushVaultsStepBudgetMs's expected value
  // directly from versioner.ts's REAL exported constants (never a copied number), so a future change to
  // either constant, or a regression back to the round-2 formula (2×working-tree + 1×git-op, missing the
  // two hasConfiguredGitIdentitySync git-config reads), is caught here.
  const versionerCount = 4;
  const expected = versionerCount * (VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS * 2 + VAULT_GIT_OP_TIMEOUT_MS * 3) + FLUSH_VAULTS_STEP_BUDGET_MARGIN_MS;
  check(
    "[formula] computeFlushVaultsStepBudgetMs counts 2×working-tree (add, commit) + 3×git-op (status, " +
    "2×git-config identity reads) per vault, plus margin",
    computeFlushVaultsStepBudgetMs(versionerCount) === expected,
  );
  const oldRound2Formula = versionerCount * (VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS * 2 + VAULT_GIT_OP_TIMEOUT_MS) + FLUSH_VAULTS_STEP_BUDGET_MARGIN_MS;
  check(
    "[formula] the corrected result is strictly larger than the old (under-counted) round-2 formula would give",
    computeFlushVaultsStepBudgetMs(versionerCount) > oldRound2Formula,
  );
  check("[formula] versionerCount=0 reduces to just the margin", computeFlushVaultsStepBudgetMs(0) === FLUSH_VAULTS_STEP_BUDGET_MARGIN_MS);
}

{
  // Round 3 finding 5 — GRACEFUL-ARM threading: index.ts's gracefulShutdown calls
  // `step("flushVaultsAndStopCodescape", flushVaultsStepBudgetMs)` with a value computed ONCE via the REAL
  // computeFlushVaultsStepBudgetMs — mirror that exact call shape here and assert the watchdog's step()
  // receives that REAL computed value, never a flat/copied default. (The RESTART arm's own analogous
  // threading, via SessionService.setShutdownCleanup, is asserted separately in
  // daemon-restart-hard-exit-watchdog.mjs — this covers the OTHER call site that shares the same cleanup.)
  const events = [];
  const realBudget = computeFlushVaultsStepBudgetMs(3);
  runGracefulTeardown(
    (step) => {
      step("writeShutdownMarker");
      step("snapshotAllLive");
      step("flushVaultsAndStopCodescape", realBudget);
      step("finalLog");
    },
    () => {},
    () => Promise.resolve(),
    { arm: fakeArm(events) },
  );
  await Promise.resolve();
  await Promise.resolve();
  check(
    "[graceful arm threading] flushVaultsAndStopCodescape's step() call carries the REAL computed budget",
    events.includes(`step:flushVaultsAndStopCodescape:budget=${realBudget}`),
  );
  check("[graceful arm threading] a step with no override still records the bare form (uses the watchdog's own default)", events.includes("step:writeShutdownMarker"));
}

// ---------------------------------------------------------------------------------------------------
// (2) REAL CHILD PROCESSES against the REAL armHardShutdownWatchdog
// ---------------------------------------------------------------------------------------------------

function runChild(scriptPath, args, killAfterMs) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: "pipe" });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const safetyTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* best-effort cleanup of this test's own child */ }
      resolve({ timedOut: true, elapsedMs: performance.now() - t0, out });
    }, killAfterMs);
    child.on("exit", (code, signal) => {
      clearTimeout(safetyTimer);
      resolve({ code, signal, elapsedMs: performance.now() - t0, out, timedOut: false });
    });
  });
}

// Round 3 finding 4: aside files are now TIMESTAMPED per firing (never a single fixed `.handled` name),
// so this lists them directly off disk rather than checking one fixed path — and asserts the set only
// ever GROWS (a previously-created aside file must still be there after a later firing is consumed),
// proving nothing is ever unlinked to make room for a new one.
function listAsideFiles(recordPath) {
  const dir = path.dirname(recordPath);
  const base = path.basename(recordPath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.handled-`));
}
// Card 0dc09fab round 2 item 7: seed from a REAL directory read rather than assuming `useOwnLoomHome`
// always hands this file a fresh, empty LOOM_HOME. A reused home (see the follow-up card discovered from
// this one, 8378984b) can already carry aside files from an earlier run against the SAME home — starting
// from `[]` would then misreport every "a NEW aside file was created" check as having created one MORE
// file than it actually did, and "every PRIOR aside file is still present" would spuriously pass on a
// prior-run file it never actually observed. Seeding from disk makes this file correct under either case.
let asideFilesSeenSoFar = listAsideFiles(HARD_SHUTDOWN_WATCHDOG_RECORD_PATH);

// Card 0dc09fab round 5: under a loaded host, a bare synchronous `listAsideFiles()` call right after
// `reportAndConsumeHardShutdownWatchdogRecord()`'s own `fs.renameSync` sometimes didn't yet see the just-
// created aside file (gen 397's run C: the "a NEW timestamped aside file was created" check failed with no
// other check in that iteration failing, so the rename itself had genuinely landed — the readdir just
// hadn't caught up to it yet on a heavily-loaded filesystem). This is an EVENTUAL-consistency tolerance,
// never a weakening of what's proven: the production rename is synchronous and best-effort, so a real miss
// (the file never appears at all) still fails this exactly as before — it just no longer penalizes a
// transient delay that settles within a couple of seconds. Bounded well under the per-iteration budget.
async function pollForAsideFileCount(recordPath, expectedCount) {
  let files = listAsideFiles(recordPath);
  await pollUntil(() => {
    files = listAsideFiles(recordPath);
    return files.length >= expectedCount;
  }, { timeoutMs: 3000, intervalMs: 25 });
  return files;
}

// (A) A genuinely synchronously-blocked main thread (Atomics.wait, no timeout) still gets force-exited
// within the window, platform-correctly (round 2 finding 5): on win32 the EXACT requested code must
// survive (run for BOTH 0, gracefulShutdown's own path, and 75, daemon_restart's RESTART_EXIT_CODE —
// daemon-supervisor.mjs's relaunch check keys on the literal numeric value); on POSIX there is no
// "kill with a chosen exit code" syscall, so the process instead dies BY SIGNAL (SIGKILL) and `code` is
// `null` — asserting the win32-only exact-code equality on POSIX would simply always fail there.
for (const intendedExitCode of [0, 75]) {
  const hardExitMs = 1500;
  // Generous slack: the win32 kill path shells out to powershell.exe (measured ~0.9-1s startup on this
  // host — see docs/decisions/347b3584-graceful-teardown-hard-exit-backstop.md), and CI/host load can add
  // more on top (CLAUDE.md's own monotonic-clock timing-flake note) — this is a lower-bound-on-death
  // check, not a tight upper bound, so slack is intentionally wide.
  const r = await runChild(SYNC_HANG, [String(hardExitMs), String(intendedExitCode)], hardExitMs + 15_000);
  check(`[real sync-blocked, intendedExitCode=${intendedExitCode}] child actually died (watchdog fired, this test's own safety-kill never had to)`, r.timedOut === false);
  if (process.platform === "win32") {
    check(`[real sync-blocked, intendedExitCode=${intendedExitCode}] the exact requested exit code survived (win32)`, r.code === intendedExitCode);
  } else {
    check(`[real sync-blocked, intendedExitCode=${intendedExitCode}] died by SIGKILL signal, code null (POSIX has no kill-with-chosen-code syscall)`, r.signal === "SIGKILL" && r.code === null);
  }
  console.log(`  (elapsedMs=${Math.round(r.elapsedMs)} for a configured hardExitMs=${hardExitMs})`);

  // Round 2 finding 2: the firing must be persisted to a durable record file BEFORE the kill, since the
  // stderr line above may never be observed (a detached supervisor, a closed terminal). Guarded (never a
  // bare throw) so an OLD build lacking this export/file entirely reports a clean FAIL here instead of
  // crashing the whole script before the later (D)/(3) sections below ever get a chance to run.
  const recordPath = typeof HARD_SHUTDOWN_WATCHDOG_RECORD_PATH === "string" ? HARD_SHUTDOWN_WATCHDOG_RECORD_PATH : null;
  let record = null;
  if (recordPath && fs.existsSync(recordPath)) {
    try { record = JSON.parse(fs.readFileSync(recordPath, "utf8")); } catch { record = null; }
  }
  check(`[watchdog record, intendedExitCode=${intendedExitCode}] a durable record file exists before the kill`, record !== null);
  check(`[watchdog record, intendedExitCode=${intendedExitCode}] step name recorded correctly`, record?.step === "about-to-hang");
  check(`[watchdog record, intendedExitCode=${intendedExitCode}] label recorded correctly`, record?.label === "test-sync-hang");
  check(`[watchdog record, intendedExitCode=${intendedExitCode}] intendedExitCode recorded correctly`, record?.intendedExitCode === intendedExitCode);
  check(`[watchdog record, intendedExitCode=${intendedExitCode}] firedAt is a parseable recent timestamp`, record != null && !Number.isNaN(Date.parse(record.firedAt)) && Date.now() - Date.parse(record.firedAt) < 60_000);

  // The boot-time consumer reports it exactly once, then renames it aside — a second call on the SAME
  // boot (this process) must find nothing left to report.
  const reportFn = typeof reportAndConsumeHardShutdownWatchdogRecord === "function" ? reportAndConsumeHardShutdownWatchdogRecord : null;
  const reported = reportFn ? reportFn() : null;
  check(`[watchdog record, intendedExitCode=${intendedExitCode}] reportAndConsumeHardShutdownWatchdogRecord() returns the SAME record`, reported?.step === "about-to-hang" && reported?.intendedExitCode === intendedExitCode);
  check(`[watchdog record, intendedExitCode=${intendedExitCode}] the original record file is gone after consuming`, recordPath != null && !fs.existsSync(recordPath));

  // Round 3 finding 4: a NEW, timestamped aside file must appear (never a fixed `.handled` name), and
  // every PREVIOUSLY-created aside file (from an earlier iteration of this same loop) must STILL exist —
  // proving the rename-aside never unlinks an older firing's forensic record to make room for a new one.
  // Round 5 (card 0dc09fab): poll briefly for eventual consistency on a loaded filesystem — see
  // pollForAsideFileCount's own doc comment.
  const asideFilesNow = recordPath != null ? await pollForAsideFileCount(recordPath, asideFilesSeenSoFar.length + 1) : [];
  check(`[watchdog record, intendedExitCode=${intendedExitCode}] a NEW timestamped aside file was created (kept for forensics, not deleted)`, asideFilesNow.length === asideFilesSeenSoFar.length + 1);
  check(`[watchdog record, intendedExitCode=${intendedExitCode}] every PRIOR aside file is still present (nothing was unlinked)`, asideFilesSeenSoFar.every((f) => asideFilesNow.includes(f)));
  asideFilesSeenSoFar = asideFilesNow;

  check(`[watchdog record, intendedExitCode=${intendedExitCode}] consuming again (as a later boot would) finds nothing to report`, reportFn ? reportFn() === null : false);
}

{
  // Round 3 finding 6: an UNPARSEABLE record file must be reported loudly and renamed aside, never left
  // to silently block every future boot's check forever.
  const recordPath = HARD_SHUTDOWN_WATCHDOG_RECORD_PATH;
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, "{ not actually valid json ]]]");
  const asideFilesBefore = listAsideFiles(recordPath);
  const result = reportAndConsumeHardShutdownWatchdogRecord();
  check("[corrupt record] reportAndConsumeHardShutdownWatchdogRecord() returns null for an unparseable record", result === null);
  check("[corrupt record] the corrupt file is gone from its original path", !fs.existsSync(recordPath));
  // Round 5 (card 0dc09fab): same eventual-consistency poll as the main loop above.
  const asideFilesAfter = await pollForAsideFileCount(recordPath, asideFilesBefore.length + 1);
  check("[corrupt record] it was renamed ASIDE (a new timestamped aside file appeared), not deleted outright", asideFilesAfter.length === asideFilesBefore.length + 1);
  check("[corrupt record] every PRIOR aside file is still present (nothing was unlinked)", asideFilesBefore.every((f) => asideFilesAfter.includes(f)));
  check("[corrupt record] a second consume on the same (now-renamed) path finds nothing left to report", reportAndConsumeHardShutdownWatchdogRecord() === null);
  asideFilesSeenSoFar = asideFilesAfter;
}

// (B) Clean path, real process: an EXPLICITLY disarmed watchdog must not keep a trivial process alive —
// and, round 4 finding 1, this must actually be able to CATCH a broken (no-op) disarm(), not just a
// broken .unref().
//
// @decision 347b3584 — round 3 nitpick 7: this used to run the SAME fixture/args as (C) below (CLEAN,
// which deliberately NEVER calls disarm()), so (B) never actually exercised the disarm() path its own name
// claimed — it was a verbatim duplicate of (C). Fixed by giving (B) its own fixture that genuinely arms,
// does a step, and calls disarm() before exiting — the shape a real teardown actually takes.
//
// @decision 347b3584 — round 4 finding 1: the ORIGINAL version of this check exited the fixture
// immediately after disarm(), so a BROKEN (no-op) disarm() was indistinguishable from a genuinely working
// one — in both cases the watchdog's Worker is `.unref()`'d and nothing else keeps a trivial process's
// event loop open, so it exits near-instantly either way (exactly test (C)'s own "unref honest" shape).
// The fixture now stays alive PAST hardExitMs via its own setTimeout (which DOES hold the event loop open)
// before exiting — so this check only passes if disarm() genuinely suppressed the watchdog: a no-op
// disarm() leaves it live, and it fires at hardExitMs, writing the record file and killing the process
// before the fixture's own timer ever completes. Verified directly: temporarily making `disarm()` a no-op
// in `dist/graceful-teardown.js` (commenting out its body) and re-running this file made exactly the
// "survived past hardExitMs" and "no watchdog record file" checks below go RED (the process died near
// hardExitMs with a record file present); restoring the real build (`pnpm --filter @loom/daemon build`)
// made them GREEN again, with every other check in this file unaffected.
{
  const hardExitMs = 1500;
  const surviveMs = hardExitMs + 1000; // matches the fixture's own setTimeout delay
  const r = await runChild(DISARM_THEN_EXIT, [String(hardExitMs)], surviveMs + 15_000);
  check(
    "[real clean path] child survived PAST hardExitMs and exited on its own (a no-op disarm() would instead " +
    "have been killed by the still-live watchdog before this point — see the decision note above)",
    r.timedOut === false && r.elapsedMs >= surviveMs - 200,
  );
  check("[real clean path] exit code 0 (no forced kill occurred)", r.code === 0);
  const recordPath = typeof HARD_SHUTDOWN_WATCHDOG_RECORD_PATH === "string" ? HARD_SHUTDOWN_WATCHDOG_RECORD_PATH : null;
  check(
    "[real clean path] no watchdog record file was written (disarm() genuinely prevented the watchdog from ever firing)",
    recordPath == null || !fs.existsSync(recordPath),
  );
  console.log(`  (elapsedMs=${Math.round(r.elapsedMs)}, hardExitMs=${hardExitMs}, surviveMs=${surviveMs})`);
}

// (C) round 2 nitpick 4 — the HONEST .unref() proof: this fixture never calls disarm() at all. If the
// watchdog's Worker handle is genuinely unref'd, nothing else keeps this trivial process's event loop
// alive, so it exits naturally (code 0, near-instantly) long before hardExitMs — a broken .unref() would
// instead strand the process until the worker's own timeout elapses and force-kills it.
{
  const hardExitMs = 10_000; // generous — a broken .unref() would make this test wait (near) this long
  const r = await runChild(CLEAN, [String(hardExitMs)], 5_000);
  check("[unref honest] never disarmed, yet the process still exited on its own, nowhere near hardExitMs", r.timedOut === false && r.elapsedMs < hardExitMs / 2);
  check("[unref honest] exit code 0 — a natural Node exit, never the force-kill path", r.code === 0);
  check("[unref honest] stdout never shows a HARD BACKSTOP firing (the natural exit beat the watchdog, it wasn't raced)", !r.out.includes("HARD BACKSTOP"));
  console.log(`  (elapsedMs=${Math.round(r.elapsedMs)}, hardExitMs=${hardExitMs})`);
}

// (D) round 2 finding 1 — PER-STEP budgets: a step with an explicit LONG override survives past the
// watchdog's own SHORT default, but a LATER step with no override is still bounded by that same default.
//
// @decision 347b3584 — round 3 finding 1: the ORIGINAL upper-bound check here (`elapsedMs < surviveBlockMs
// + longBudgetMs`) could NOT detect a completely missing step()-side wake-up: with no notify at all, the
// worker sleeps through to the STALE long deadline and dies near `longBudgetMs` — which that loose bound
// still accepted as a pass. Tightened to `surviveBlockMs + defaultHardExitMs + a generous-but-tight slack`
// (≪ longBudgetMs, which is also raised here for a wide separation margin), so a missing wake-up now dies
// well past the tightened bound and fails it. Verified directly: temporarily deleting the compiled
// generation-bump/notify call from `dist/graceful-teardown.js`'s step() and re-running this file made
// EXACTLY this check go RED (elapsedMs landed near longBudgetMs), with every other check in this file
// unaffected; restoring the real build (`pnpm --filter @loom/daemon build`) made it GREEN again.
//
// @decision 347b3584 — round 4 finding 2: the round-3 margin (longBudgetMs=9000, slack=3000 ⇒ a GREEN-path
// upper bound of 6700ms) left only ~2.1s of real headroom on Windows, since the win32 kill path's
// PowerShell `Add-Type` cost grows under a loaded 3-lane gate — close enough to flake the GREEN check
// without the bug ever recurring. Widened: `longBudgetMs` raised to 15000 and the slack to 6000, giving a
// GREEN-path upper bound of 9700ms with ~5.3s of separation below the RED (missing-notify) death point
// near `longBudgetMs` — re-proved RED the same way (deleting the compiled generation-bump/notify call and
// re-running this file; EXACTLY this check failed, restoring the build made it pass again).
//
// @decision 347b3584 — round 5: never go back to a hand-picked absolute slack for this bound — a razor-
// thin margin (57ms) is always going to flake again the moment host load shifts a little further. Express
// the upper bound as a FRACTION of the gap between the GREEN floor and the RED (longBudgetMs) ceiling
// instead, so raising `longBudgetMs` alone widens both margins together. See the decision record for the
// full numbers.
{
  const defaultHardExitMs = 1200;
  const longBudgetMs = 30_000; // wide absolute headroom — the upper bound below is a FRACTION of this, so raising it alone widens both margins at once
  const surviveBlockMs = 2500; // > defaultHardExitMs, < longBudgetMs
  const promptDeathFloorMs = surviveBlockMs + defaultHardExitMs; // expected GREEN-path death time
  const PROMPT_UPPER_BOUND_GAP_FRACTION = 0.5; // upper bound sits halfway between the GREEN floor and the RED (longBudgetMs) ceiling
  const promptUpperBoundMs = promptDeathFloorMs + (longBudgetMs - promptDeathFloorMs) * PROMPT_UPPER_BOUND_GAP_FRACTION;
  const r = await runChild(PER_STEP_BUDGET, [String(defaultHardExitMs), String(longBudgetMs), String(surviveBlockMs)], surviveBlockMs + longBudgetMs + 15_000);
  check("[per-step budget] the long-budget step was NOT killed during its own override window, past the short default", r.out.includes("long-step survived past the short default"));
  check("[per-step budget] the process still eventually died (the short-budget step's hang was caught)", r.timedOut === false);
  check(
    "[per-step budget] death happened AFTER surviveBlockMs + the short default (not killed early, during the long-budget step)",
    r.elapsedMs >= promptDeathFloorMs - 500,
  );
  check(
    "[per-step budget] death happened PROMPTLY on the short-budget step's own default, not after sleeping through " +
    "to the stale long deadline (this is the check that catches a missing step()-side wake-up — see the decision note above; " +
    "the bound is the midpoint between the GREEN floor and the RED ceiling, not a hand-picked absolute slack)",
    r.elapsedMs < promptUpperBoundMs,
  );
  console.log(`  (elapsedMs=${Math.round(r.elapsedMs)}, defaultHardExitMs=${defaultHardExitMs}, longBudgetMs=${longBudgetMs}, surviveBlockMs=${surviveBlockMs}, promptUpperBoundMs=${Math.round(promptUpperBoundMs)})`);
}

// ---------------------------------------------------------------------------------------------------
// (E) round 5 (card 0dc09fab) — WIN32 EXIT-CODE RACE: the raw SIGKILL fallback must fire ONLY when the
// custom-exit-code TerminateProcess attempt was NOT confirmed to have succeeded. `TerminateProcess` is
// asynchronous (MSDN: it initiates termination and returns immediately, without waiting for the target to
// finish tearing down) — calling it a SECOND time (the raw fallback, which on win32 always re-invokes
// TerminateProcess via libuv's `uv_kill`, regardless of the signal name passed) while the FIRST call's
// termination is still in flight can overwrite the already-set exit code before it is "locked in". This
// is what let exit 75 sometimes become something else under a loaded host (gen 397, 2026-10-04) — a real
// bug, since `daemon_restart`'s supervisor relaunch keys on the literal numeric 75.
//
// Patches the COMPILED dist/graceful-teardown.js's `const ps = ...; execFileSync("powershell.exe", ...)`
// sequence with an inline stand-in that reports a KNOWN, controlled outcome (confirmed or unconfirmed)
// without ever invoking powershell.exe or the real Win32 API — this makes both paths deterministic to
// test, independent of real TerminateProcess timing. win32-only: the gating logic this proves exists only
// in the win32 branch of the worker source.
//
// @decision 347b3584 — never race the "confirmed success" check below against a single external timeout,
// and never let its patch shell out to a real process (even a trivial stand-in script) — both reintroduce
// load-sensitive timing this test exists to remove, and the "hung" result either one produces is
// indistinguishable from "the watchdog never fired at all." See the decision record for the full
// RED/GREEN numbers and why.
// ---------------------------------------------------------------------------------------------------
if (process.platform === "win32") {
  const distDir = DIST_DIR;

  // Card 0dc09fab round 2 item 4: a stale `graceful-teardown.winrace-<pid>-*.js` sibling can survive a
  // prior run that crashed/was killed before its own `finally` cleanup ran (and a packed npm tarball would
  // never have one in the first place, so this only ever prunes test-run debris) — sweep anything whose
  // pid is no longer alive before this run creates its own. Never removes a LIVE sibling's file: another
  // concurrently-running copy of this same test file (the load-robustness proof) has its own pid baked
  // into its own filename and stays untouched. (`isPidAlive`/the sweep mechanics are shared — see their
  // hoisted definitions above, used by both this block and the round 6 clock-monotonicity patch below.)
  const sweptCount = sweepStaleDistSiblings("winrace");
  if (sweptCount > 0) console.log(`  (swept ${sweptCount} stale graceful-teardown.winrace-*.js sibling(s) with no live owner)`);

  // Card 0dc09fab round 2 item 1: the decision-point signal is a DURABLE FILE WRITE (the same
  // fs.writeSync-on-an-explicitly-opened-fd technique the REAL production record uses, never a
  // console.log/process.stdout.write) — confirmed directly that it has to be: a FIRST version of this
  // patch wrote the marker via process.stdout.write() from inside the watchdog WORKER thread, and it was
  // NEVER observed by this test, even on the "confirmed" path where the child survives for the whole grace
  // window — because `process.stdout` in a worker thread is proxied back to the MAIN thread over an
  // internal message channel, and the main thread here is synchronously blocked on `Atomics.wait` with NO
  // event-loop ticks at all, so that proxied write can never actually flush. A real synchronous fs write
  // from the worker's own OS thread has no such dependency — it's exactly why the REAL watchdog record
  // itself (HARD_SHUTDOWN_WATCHDOG_RECORD_PATH) is written the same way, and exactly why this patch reuses
  // that already-in-scope `recordPath`/`fsMod` pair rather than inventing a second mechanism.
  const WIN32_DECISION_MARKER_PATH = `${HARD_SHUTDOWN_WATCHDOG_RECORD_PATH}.win32-decision-marker`;

  // Round 5 (card 0dc09fab): write the patched worker source to a UNIQUE SIBLING FILE under dist/, never
  // mutate the shared installed graceful-teardown.js in place — that file is imported by OTHER
  // concurrently-running test files/fixtures (e.g. daemon-restart-hard-exit-watchdog.mjs, and THIS SAME
  // test file running concurrently with itself under the load-robustness proof below), so an in-place
  // mutation would race them. The sibling file lives in the SAME directory so its own relative imports
  // (./paths.js, ./vault/versioner.js, ./git/merge-danger-window.js) still resolve to the real, unmutated
  // siblings. The fixture takes an OPTIONAL 4th argv — a module path/URL to import armHardShutdownWatchdog
  // from instead of the real dist path — so every EXISTING caller (which never passes a 4th arg) is
  // byte-identical.
  //
  // Round 2 item 1: `mode` is `"confirmed"` or `"unconfirmed"` — the WHOLE `const ps = ...; execFileSync(
  // "powershell.exe", ...)` sequence is replaced (never just the `ps` script text, as the round-5 version
  // did), so NEITHER mode ever spawns a real powershell.exe process at all. `"confirmed"` writes the
  // decision marker and falls through to the unchanged `winCustomExitConfirmed = true;` line right after
  // the matched region; `"unconfirmed"` writes the marker then throws synchronously, landing in the
  // existing enclosing `catch {}` exactly as a real null-handle/false-TerminateProcess/execFileSync-throw
  // outcome would.
  const realDistPath = path.join(distDir, "graceful-teardown.js");
  const WIN32_PS_ANCHOR = /const ps =[\s\S]*?execFileSync\("powershell\.exe", \["-NoProfile", "-NonInteractive", "-Command", ps\], \{ timeout: 10000, stdio: "ignore" \}\);/;
  async function withPatchedWin32PsScript(mode, fn) {
    const original = fs.readFileSync(realDistPath, "utf8");
    if (!WIN32_PS_ANCHOR.test(original)) {
      throw new Error(
        "withPatchedWin32PsScript: the expected win32 'const ps = ...; execFileSync(\"powershell.exe\", ...)' " +
        "anchor was not found in dist/graceful-teardown.js — the patch is a no-op, refusing to silently test nothing",
      );
    }
    // `recordPath` and `fsMod` are both ALREADY in scope at this point in the real worker source (see the
    // decision note above for why this must be a durable fs write, never console/stdout output).
    const markerWrite =
      `try { const __mfd = fsMod.openSync(recordPath + ".win32-decision-marker", "w"); ` +
      `try { fsMod.writeSync(__mfd, "x"); } finally { fsMod.closeSync(__mfd); } } catch {}`;
    const replacement = mode === "confirmed"
      ? `${markerWrite} /* test-patch (card 0dc09fab): simulated CONFIRMED success — no real powershell.exe spawn */`
      : `${markerWrite} throw new Error("test-patch (card 0dc09fab): simulated unconfirmed");`;
    const patched = original.replace(WIN32_PS_ANCHOR, replacement);
    const patchedPath = path.join(distDir, `graceful-teardown.winrace-${process.pid}-${Math.random().toString(36).slice(2, 8)}.js`);
    fs.writeFileSync(patchedPath, patched);
    try {
      return await fn(pathToFileURL(patchedPath).href);
    } finally {
      try { fs.unlinkSync(patchedPath); } catch { /* best-effort cleanup of this test's own scratch file */ }
    }
  }

  // Spawns the sync-hang fixture against the patched module, waits (bounded) for the decision-point
  // marker FILE to appear, then watches for a BOUNDED grace window whether the child exits — never racing
  // a single external timeout against the whole sequence. Always cleans up: a "confirmed" child hangs
  // forever by design (that's the fix), so it's reaped here rather than left running.
  async function runPatchedAndObserveExit(mode, hardExitMs, graceMs) {
    try { fs.unlinkSync(WIN32_DECISION_MARKER_PATH); } catch { /* fine if it doesn't exist yet */ }
    return withPatchedWin32PsScript(mode, async (modulePath) => {
      const t0 = performance.now();
      const child = spawn(process.execPath, [SYNC_HANG, String(hardExitMs), "0", modulePath], { stdio: "pipe" });
      let out = "";
      let exited = false;
      let exitInfo = null;
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("exit", (code, signal) => { exited = true; exitInfo = { code, signal }; });

      const sawMarker = await pollUntil(() => fs.existsSync(WIN32_DECISION_MARKER_PATH), { timeoutMs: hardExitMs + 10_000, intervalMs: 20 });
      const exitedWithinGrace = sawMarker ? await pollUntil(() => exited, { timeoutMs: graceMs, intervalMs: 20 }) : exited;

      if (!exited) {
        try { child.kill("SIGKILL"); } catch { /* best-effort cleanup of this test's own child */ }
        await pollUntil(() => exited, { timeoutMs: 5000, intervalMs: 20 });
      }
      return { sawMarker, exitedWithinGrace, exitInfo, out, elapsedMs: performance.now() - t0 };
    });
  }

  {
    // CONFIRMED SUCCESS: the decision point is simulated as confirmed WITHOUT ever calling TerminateProcess
    // for real — if the fallback is correctly SKIPPED once confirmed, the process must stay alive through
    // the whole grace window after the marker appears.
    const hardExitMs = 500;
    const graceMs = 1000;
    const r = await runPatchedAndObserveExit("confirmed", hardExitMs, graceMs);
    check(
      "[win32 exit-code race, confirmed success] the watchdog genuinely reached the win32 decision point " +
      "(never a vacuous pass from the watchdog not firing at all)",
      r.sawMarker,
    );
    check(
      "[win32 exit-code race, confirmed success] the raw SIGKILL fallback is SKIPPED once the custom-code " +
      "terminate is confirmed — the process stays alive through the grace window after the decision point, " +
      "proving no second TerminateProcess call was ever issued to race the first",
      r.sawMarker && !r.exitedWithinGrace,
    );
    console.log(`  (elapsedMs=${Math.round(r.elapsedMs)}, sawMarker=${r.sawMarker}, exitedWithinGrace=${r.exitedWithinGrace} — expected false)`);
  }

  {
    // CONFIRMED FAILURE: the decision point is simulated as unconfirmed — the raw fallback must still fire,
    // within the grace window. This path is UNCHANGED by the fix: it's the safety net round 2 added, still
    // needed when the custom-code attempt genuinely didn't work.
    const hardExitMs = 500;
    const graceMs = 3000;
    const r = await runPatchedAndObserveExit("unconfirmed", hardExitMs, graceMs);
    check(
      "[win32 exit-code race, confirmed failure] the watchdog genuinely reached the win32 decision point",
      r.sawMarker,
    );
    check(
      "[win32 exit-code race, confirmed failure] the raw SIGKILL fallback STILL fires within the grace window " +
      "when the custom-code terminate was not confirmed — the process is force-killed as before",
      r.sawMarker && r.exitedWithinGrace,
    );
    console.log(`  (elapsedMs=${Math.round(r.elapsedMs)}, sawMarker=${r.sawMarker}, exitedWithinGrace=${r.exitedWithinGrace} — expected true)`);
  }
} else {
  console.log("  (skipping [win32 exit-code race] checks — win32-only)");
}

// ---------------------------------------------------------------------------------------------------
// round 5 (card 0dc09fab), 2b — ASIDE-PATH COLLISION-PROOFING: timestampedAsidePath derives its destination
// from `firedAt`'s ISO-millisecond timestamp alone. `fs.renameSync` on Windows SILENTLY OVERWRITES an
// existing destination (MoveFileEx with MOVEFILE_REPLACE_EXISTING) rather than erroring — so two firings
// whose `firedAt` happens to collide to the millisecond would otherwise clobber each other's forensic
// record with no error and no visible sign, contradicting this whole mechanism's "never deletes/loses a
// firing" guarantee. Forces the exact collision (two records sharing the IDENTICAL firedAt) directly,
// rather than hoping to catch a real clock collision, and asserts both survive as distinct files.
// ---------------------------------------------------------------------------------------------------
{
  const recordPath = HARD_SHUTDOWN_WATCHDOG_RECORD_PATH;
  const sameFiredAt = new Date().toISOString();
  const asideFilesBefore = listAsideFiles(recordPath);

  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify({ firedAt: sameFiredAt, step: "collision-test-1", intendedExitCode: 0, label: "test-collision" }));
  reportAndConsumeHardShutdownWatchdogRecord();
  const asideFilesAfterFirst = await pollForAsideFileCount(recordPath, asideFilesBefore.length + 1);
  // Card 0dc09fab round 2 item 3: the FIRST firing's own aside FILENAME, captured now — before the second
  // rename happens — so the content check below re-reads this exact file after the collision, never a
  // freshly-listed one that might happen to match by coincidence.
  const firstAsideFileName = asideFilesAfterFirst.find((f) => !asideFilesBefore.includes(f)) ?? null;

  fs.writeFileSync(recordPath, JSON.stringify({ firedAt: sameFiredAt, step: "collision-test-2", intendedExitCode: 0, label: "test-collision" }));
  reportAndConsumeHardShutdownWatchdogRecord();
  const asideFilesAfterSecond = await pollForAsideFileCount(recordPath, asideFilesAfterFirst.length + 1);

  check(
    "[aside-path collision] two firings sharing the IDENTICAL firedAt still produce TWO DISTINCT aside files " +
    "(never one silently overwriting the other)",
    asideFilesAfterSecond.length === asideFilesAfterFirst.length + 1,
  );
  // Card 0dc09fab round 2 item 3: the PRE-EXISTING check just below (filename still present in the
  // directory listing) can NEVER fail by construction — `fs.renameSync`'s silent-overwrite bug this
  // section exists to catch clobbers a destination's CONTENT while leaving its NAME (and thus its presence
  // in a `readdirSync` listing) completely unchanged; a regression that dropped `timestampedAsidePath`'s
  // sequence suffix (reintroducing the exact collision) would make BOTH firings' aside names IDENTICAL,
  // so a name-presence check would still see "the name is still there" — it was never looking at the
  // thing that actually gets clobbered. Read the FIRST file's own CONTENT back off disk, after the SECOND
  // rename has happened, and assert it still reads its own step ("collision-test-1") — a regressed,
  // non-unique destination would instead have overwritten it with the second firing's "collision-test-2".
  const firstAsideContent = firstAsideFileName
    ? (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(recordPath), firstAsideFileName), "utf8")); } catch { return null; } })()
    : null;
  check(
    "[aside-path collision] the first firing's aside file CONTENT still reads its own step after the second " +
    "firing (name-presence alone can't catch this — see the note above: a regressed, non-unique destination " +
    "keeps the SAME filename while clobbering its content)",
    firstAsideContent?.step === "collision-test-1",
  );
  check(
    "[aside-path collision] the first firing's aside file was NOT clobbered by the second",
    asideFilesAfterFirst.every((f) => asideFilesAfterSecond.includes(f)),
  );
  asideFilesSeenSoFar = asideFilesAfterSecond;
}

// ---------------------------------------------------------------------------------------------------
// Round 6 (card e34cb710): the watchdog's deadline arithmetic used to be Date.now()-based (wall-clock) —
// a forward wall-clock step (NTP correction, sleep/resume waking into a later time) could fire the
// watchdog EARLY, mid a legitimate step (e.g. mid `git commit` inside flushVaultsAndStopCodescape); a
// backward step could fire it LATE, reintroducing the original unbounded-hang incident. The fix reads the
// deadline against a MONOTONIC clock (performance.timeOrigin + performance.now()) on BOTH sides:
//   - the main-thread WRITE side (armHardShutdownWatchdog's initial arm, and step()) — delta CR: there is
//     NO runtime DI seam here. An injectable `now` only ever skewed this side while the real worker always
//     reads the real clock, and arming IN-PROCESS with a skewed `now` that reads as already-elapsed would
//     genuinely TerminateProcess/SIGKILL the TEST RUNNER's own process (see armHardShutdownWatchdog's own
//     doc comment). Proven instead via a sibling-dist-file patch that regex-reverts BOTH write call sites
//     back to literal Date.now(), with the FIXTURE's own (parent) Date.now skewed before arming — the
//     worker's read side is left REAL/untouched throughout, isolating this one variable.
//   - the worker's own READ side (buildWatchdogWorkerSource) — also can't receive an injected function
//     across the thread boundary, so proven via a sibling-dist-file patch that regex-reverts the worker's
//     one changed line back to Date.now(), with ONLY the WORKER's own Date.now skewed (never the main
//     thread's) — the mirror image of the write-side proof.
//
// MEASUREMENT (delta CR: avoid flakiness from win32 kill overhead): every check below measures how long
// it takes the durable watchdog RECORD FILE (HARD_SHUTDOWN_WATCHDOG_RECORD_PATH) to appear, never
// process-exit timing. The record is written synchronously inside the worker BEFORE any kill attempt, so
// this signal carries none of the PowerShell/TerminateProcess variance that can grow significantly under
// a loaded gate (see round 4 of the decision record) — a hazard process-exit timing is exposed to. The
// child is still reaped afterward for hygiene (a "does not fire" case is left genuinely alive until this
// test kills it), but that cleanup never feeds into an assertion.
//
// Proves BOTH directions, on BOTH sides, on BOTH the pre-fix ("legacy") and the real fixed code:
//   WORKER-READ side — a jump applied to the WORKER's own Date.now() only, from its very first call:
//     FORWARD (+5min): legacy's record fires almost immediately (RED); fixed fires at the correct
//       ~hardExitMs mark (GREEN)
//     BACKWARD (-5min): legacy's record does NOT appear within a generous bounded window (RED — the
//       unbounded-hang shape); fixed still fires on time (GREEN) — "a backward jump does not prevent
//       firing on the fixed code"
//   MAIN-THREAD-WRITE side — a skew applied to the FIXTURE's (parent) own Date.now() before arming:
//     BACKWARD (-5min, parent thinks it's EARLIER): legacy-main's computed deadline reads as already
//       elapsed relative to the real (unskewed) worker clock — fires almost immediately (RED); fixed is
//       unaffected (GREEN)
//     FORWARD (+5min, parent thinks it's LATER): legacy-main's computed deadline reads as minutes away —
//       does NOT appear within a generous bounded window (RED); fixed is unaffected (GREEN)
//   (The write-side polarity MIRRORS the read-side polarity — a forward skew on the SUBTRAHEND (the
//   worker's read) shrinks `remaining`, while a forward skew on the MINUEND (the deadline the write
//   computes) grows it. Both directions are tested on both sides so neither polarity is missed.)
//
// Every wait below is bounded via pollUntil (no fixed sleep-then-assume anywhere in this section).
// ---------------------------------------------------------------------------------------------------
{
  const sweptCount = sweepStaleDistSiblings("clockshim");
  if (sweptCount > 0) console.log(`  (swept ${sweptCount} stale graceful-teardown.clockshim-*.js sibling(s) with no live owner)`);

  const originalDistTextBeforeClockTest = fs.readFileSync(REAL_DIST_PATH, "utf8");
  const LEGACY_REMAINING_ANCHOR = "const remaining = Number(Atomics.load(deadline, 0)) - monotonicNowMs();";
  const LEGACY_REMAINING_REPLACEMENT = "const remaining = Number(Atomics.load(deadline, 0)) - Date.now();";
  const WORKERDATA_ANCHOR = "const { sab, intendedExitCode, label, recordPath } = workerData;";
  const MAIN_ARM_ANCHOR = "Atomics.store(deadline, 0, BigInt(Math.round(monotonicNowMs() + defaultStepBudgetMs)));";
  const MAIN_ARM_REPLACEMENT = "Atomics.store(deadline, 0, BigInt(Math.round(Date.now() + defaultStepBudgetMs)));";
  const MAIN_STEP_ANCHOR = "Atomics.store(deadline, 0, BigInt(Math.round(monotonicNowMs() + budget)));";
  const MAIN_STEP_REPLACEMENT = "Atomics.store(deadline, 0, BigInt(Math.round(Date.now() + budget)));";
  for (const [anchorLabel, anchor] of [
    ["worker read", LEGACY_REMAINING_ANCHOR],
    ["workerData destructure", WORKERDATA_ANCHOR],
    ["main-thread arm write", MAIN_ARM_ANCHOR],
    ["main-thread step write", MAIN_STEP_ANCHOR],
  ]) {
    if (!originalDistTextBeforeClockTest.includes(anchor)) {
      throw new Error(
        `round 6 clock test: the expected '${anchorLabel}' anchor was not found in dist/graceful-teardown.js ` +
        "— the patch is a no-op, refusing to silently test nothing",
      );
    }
  }

  // Builds a sibling dist file for the WORKER-READ dimension: `variant` controls whether the worker's
  // deadline READ uses the real fixed monotonic clock ("fixed") or is regex-reverted to the pre-fix
  // Date.now() read ("legacy"); `jumpByMs` injects a constant offset applied to the WORKER's OWN Date.now()
  // from its very first call onward (never the main thread's). Writes to a unique sibling path under
  // dist/ (never mutates the real file in place — see the byte-identical check at the end of this section).
  async function withWorkerReadClockJump(variant, jumpByMs, fn) {
    let text = originalDistTextBeforeClockTest;
    if (variant === "legacy") {
      text = text.replace(LEGACY_REMAINING_ANCHOR, LEGACY_REMAINING_REPLACEMENT);
    }
    const shimSnippet =
      `${WORKERDATA_ANCHOR}\n` +
      `// TEST-PATCH (card e34cb710): simulate a wall-clock jump — affects ONLY this worker's own ` +
      `Date.now(), never the main thread's.\n` +
      `const __clockShimRealDateNow = Date.now.bind(Date);\n` +
      `Date.now = function() { return __clockShimRealDateNow() + (${jumpByMs}); };`;
    text = text.replace(WORKERDATA_ANCHOR, shimSnippet);
    const patchedPath = path.join(DIST_DIR, `graceful-teardown.clockshim-${process.pid}-${Math.random().toString(36).slice(2, 8)}.js`);
    fs.writeFileSync(patchedPath, text);
    try {
      return await fn(pathToFileURL(patchedPath).href);
    } finally {
      try { fs.unlinkSync(patchedPath); } catch { /* best-effort cleanup of this test's own scratch file */ }
    }
  }

  // Builds a sibling dist file for the MAIN-THREAD-WRITE dimension: "legacy-main" regex-reverts BOTH the
  // arm and step() deadline writes back to literal Date.now(); "fixed" passes an empty module override
  // (every OTHER non-win32 test in this file does the same — imports the REAL dist directly, no sibling
  // needed). The clock skew itself is applied in the FIXTURE's own process (spawnAndObserveRecord's
  // `parentSkewMs`), never inside this patch — this patch only controls which clock the write sites
  // literally reference.
  async function withMainThreadWriteVariant(variant, fn) {
    if (variant === "fixed") {
      return fn("");
    }
    const text = originalDistTextBeforeClockTest
      .replace(MAIN_ARM_ANCHOR, MAIN_ARM_REPLACEMENT)
      .replace(MAIN_STEP_ANCHOR, MAIN_STEP_REPLACEMENT);
    const patchedPath = path.join(DIST_DIR, `graceful-teardown.clockshim-${process.pid}-${Math.random().toString(36).slice(2, 8)}.js`);
    fs.writeFileSync(patchedPath, text);
    try {
      return await fn(pathToFileURL(patchedPath).href);
    } finally {
      try { fs.unlinkSync(patchedPath); } catch { /* best-effort cleanup of this test's own scratch file */ }
    }
  }

  // Spawns the sync-hang fixture and measures how long it takes the durable watchdog RECORD FILE to
  // appear — never process-exit timing (see this section's own header for why). Clears any pre-existing
  // record before spawning (the path is shared across this whole test file's run). Bounded by `windowMs`
  // via pollUntil. Reaps the child afterward for hygiene only — a "does not fire" case is left genuinely
  // alive until killed here; that cleanup is never itself asserted on.
  async function spawnAndObserveRecord(modulePath, hardExitMsArg, parentSkewMs, windowMs) {
    try { fs.unlinkSync(HARD_SHUTDOWN_WATCHDOG_RECORD_PATH); } catch { /* fine if it doesn't exist yet */ }
    const t0 = performance.now();
    const args = [SYNC_HANG, String(hardExitMsArg), "0", modulePath ?? ""];
    if (parentSkewMs !== null) args.push(String(parentSkewMs));
    const child = spawn(process.execPath, args, { stdio: "pipe" });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    let exited = false;
    child.on("exit", () => { exited = true; });

    const recordAppeared = await pollUntil(() => fs.existsSync(HARD_SHUTDOWN_WATCHDOG_RECORD_PATH), { timeoutMs: windowMs, intervalMs: 20 });
    const elapsedAtRecordMs = recordAppeared ? performance.now() - t0 : null;

    if (!exited) {
      await pollUntil(() => exited, { timeoutMs: 3000, intervalMs: 20 });
    }
    if (!exited) {
      try { child.kill("SIGKILL"); } catch { /* best-effort cleanup of this test's own child */ }
      await pollUntil(() => exited, { timeoutMs: 3000, intervalMs: 20 });
    }
    try { fs.unlinkSync(HARD_SHUTDOWN_WATCHDOG_RECORD_PATH); } catch { /* best-effort — the next sub-test pre-clears anyway */ }
    return { recordAppeared, elapsedAtRecordMs, out };
  }

  const clockHardExitMs = 3000;
  const forwardJumpMs = 300_000; // +5min
  const backwardJumpMs = -300_000; // -5min
  // The record-file signal carries none of the win32-kill-overhead variance process-exit timing would —
  // this window only needs to cover real deadline-check evaluation plus OS thread-scheduling jitter.
  const clockWindowMs = clockHardExitMs + 1500;
  const greenFloorMs = clockHardExitMs - 400;
  const redCeilingMs = clockHardExitMs * 0.5;

  // --- WORKER-READ side ----------------------------------------------------------------------------

  {
    const r = await withWorkerReadClockJump("legacy", forwardJumpMs, (mod) => spawnAndObserveRecord(mod, clockHardExitMs, null, clockWindowMs));
    check(
      "[round 6, worker-read, forward jump, legacy] the pre-fix (Date.now()-based) worker's deadline " +
      "record fires EARLY — the deadline reads as already elapsed against the jumped wall clock (RED: " +
      "proves the historical bug AND that this shim can actually trigger it)",
      r.recordAppeared,
    );
    check(
      "[round 6, worker-read, forward jump, legacy] it fired WELL before the correct hardExitMs mark",
      r.recordAppeared && r.elapsedAtRecordMs < redCeilingMs,
    );
    console.log(`  (elapsedAtRecordMs=${r.recordAppeared ? Math.round(r.elapsedAtRecordMs) : "never"}, hardExitMs=${clockHardExitMs} — expected early)`);
  }

  {
    const r = await withWorkerReadClockJump("fixed", forwardJumpMs, (mod) => spawnAndObserveRecord(mod, clockHardExitMs, null, clockWindowMs));
    check(
      "[round 6, worker-read, forward jump, fixed] the real monotonic-clock worker's record is UNAFFECTED " +
      "by the forward jump — still fires (GREEN)",
      r.recordAppeared,
    );
    check(
      "[round 6, worker-read, forward jump, fixed] it fired at the correct ~hardExitMs mark, not early",
      r.recordAppeared && r.elapsedAtRecordMs >= greenFloorMs,
    );
    console.log(`  (elapsedAtRecordMs=${r.recordAppeared ? Math.round(r.elapsedAtRecordMs) : "never"}, hardExitMs=${clockHardExitMs} — expected ~on time)`);
  }

  {
    const r = await withWorkerReadClockJump("legacy", backwardJumpMs, (mod) => spawnAndObserveRecord(mod, clockHardExitMs, null, clockWindowMs));
    check(
      "[round 6, worker-read, backward jump, legacy] the pre-fix worker's record does NOT appear within a " +
      "generous bounded window — the deadline reads as minutes away (RED: reintroduces the original " +
      "unbounded-hang incident this whole backstop exists to prevent)",
      !r.recordAppeared,
    );
    console.log(`  (recordAppeared=${r.recordAppeared} within windowMs=${clockWindowMs} — expected false)`);
  }

  {
    const r = await withWorkerReadClockJump("fixed", backwardJumpMs, (mod) => spawnAndObserveRecord(mod, clockHardExitMs, null, clockWindowMs));
    check(
      "[round 6, worker-read, backward jump, fixed] a backward jump does NOT prevent firing on the fixed " +
      "code — the record still appears (GREEN)",
      r.recordAppeared,
    );
    check(
      "[round 6, worker-read, backward jump, fixed] it fired at the correct ~hardExitMs mark, not stuck",
      r.recordAppeared && r.elapsedAtRecordMs >= greenFloorMs,
    );
    console.log(`  (elapsedAtRecordMs=${r.recordAppeared ? Math.round(r.elapsedAtRecordMs) : "never"}, hardExitMs=${clockHardExitMs} — expected ~on time)`);
  }

  // --- MAIN-THREAD-WRITE side ----------------------------------------------------------------------

  {
    const r = await withMainThreadWriteVariant("legacy-main", (mod) => spawnAndObserveRecord(mod, clockHardExitMs, backwardJumpMs, clockWindowMs));
    check(
      "[round 6, main-thread write, backward skew, legacy-main] the pre-fix (Date.now()-based) ARM/step() " +
      "writes compute a deadline that already reads as elapsed against the real (unskewed) worker clock — " +
      "fires EARLY (RED: proves the write-side half of the historical bug, with exactly the revert the " +
      "manager asked for)",
      r.recordAppeared,
    );
    check(
      "[round 6, main-thread write, backward skew, legacy-main] it fired WELL before the correct hardExitMs mark",
      r.recordAppeared && r.elapsedAtRecordMs < redCeilingMs,
    );
    console.log(`  (elapsedAtRecordMs=${r.recordAppeared ? Math.round(r.elapsedAtRecordMs) : "never"}, hardExitMs=${clockHardExitMs} — expected early)`);
  }

  {
    const r = await withMainThreadWriteVariant("fixed", (mod) => spawnAndObserveRecord(mod, clockHardExitMs, backwardJumpMs, clockWindowMs));
    check(
      "[round 6, main-thread write, backward skew, fixed] the real monotonic-clock ARM/step() writes are " +
      "UNAFFECTED by the parent's skewed Date.now() — still fires (GREEN)",
      r.recordAppeared,
    );
    check(
      "[round 6, main-thread write, backward skew, fixed] it fired at the correct ~hardExitMs mark, not early",
      r.recordAppeared && r.elapsedAtRecordMs >= greenFloorMs,
    );
    console.log(`  (elapsedAtRecordMs=${r.recordAppeared ? Math.round(r.elapsedAtRecordMs) : "never"}, hardExitMs=${clockHardExitMs} — expected ~on time)`);
  }

  {
    const r = await withMainThreadWriteVariant("legacy-main", (mod) => spawnAndObserveRecord(mod, clockHardExitMs, forwardJumpMs, clockWindowMs));
    check(
      "[round 6, main-thread write, forward skew, legacy-main] the pre-fix ARM/step() writes compute a " +
      "deadline minutes away relative to the real worker clock — does NOT appear within a generous " +
      "bounded window (RED: the write-side mirror of the unbounded-hang shape)",
      !r.recordAppeared,
    );
    console.log(`  (recordAppeared=${r.recordAppeared} within windowMs=${clockWindowMs} — expected false)`);
  }

  {
    const r = await withMainThreadWriteVariant("fixed", (mod) => spawnAndObserveRecord(mod, clockHardExitMs, forwardJumpMs, clockWindowMs));
    check(
      "[round 6, main-thread write, forward skew, fixed] a forward skew on the parent's Date.now() does " +
      "NOT prevent firing on the fixed code — the record still appears (GREEN)",
      r.recordAppeared,
    );
    check(
      "[round 6, main-thread write, forward skew, fixed] it fired at the correct ~hardExitMs mark, not stuck",
      r.recordAppeared && r.elapsedAtRecordMs >= greenFloorMs,
    );
    console.log(`  (elapsedAtRecordMs=${r.recordAppeared ? Math.round(r.elapsedAtRecordMs) : "never"}, hardExitMs=${clockHardExitMs} — expected ~on time)`);
  }

  // Requirement: the sibling-dist patch technique must restore byte-identically — the REAL installed file
  // is never mutated in place (every patch above wrote to its own unique sibling and unlinked it), proven
  // directly here rather than assumed from the mechanism's own construction.
  const originalDistTextAfterClockTest = fs.readFileSync(REAL_DIST_PATH, "utf8");
  check(
    "[round 6] dist/graceful-teardown.js is byte-identical before and after every sibling-dist-patch run " +
    "in this section (the real file was never mutated in place)",
    originalDistTextAfterClockTest === originalDistTextBeforeClockTest,
  );
}

// ---------------------------------------------------------------------------------------------------
// (3) STRUCTURAL: card 0dc09fab round 2 item 2 — this check used to assert round 2's OWN contract
// ("the win32 kill path must ALWAYS fall through to a direct SIGKILL, never short-circuit it behind a
// 'PowerShell appeared to succeed' flag") — which round 5 deliberately REVERSED: round 5's whole point is
// that the fallback now DOES skip, correctly, once the custom-code kill is genuinely CONFIRMED (never on
// a bare "didn't throw"). The old check stayed green only by grepping for the superseded
// `killedWithCustomCode` identifier's absence — a name nobody would reintroduce regardless of whether
// round 5's real gate (`winCustomExitConfirmed`, and the PS script's own two `exit 1` branches that make
// "didn't throw" a meaningful signal in the first place) is still present. Rewritten to assert round 5's
// ACTUAL contract directly.
//
// Positive control (unchanged check only): the OLD (pre-round-2) source genuinely contained
// `killedWithCustomCode` — confirmed via `git show HEAD:packages/daemon/src/graceful-teardown.ts` at the
// time this test was written — so its absence here is a real, discriminating signal, not a pattern that
// could never have matched anything.
// ---------------------------------------------------------------------------------------------------
{
  const distSource = fs.readFileSync(path.join(__dirname, "..", "dist", "graceful-teardown.js"), "utf8");
  check(
    "[structural] the PS script exits 1 on a null OpenProcess handle (round 5 contract — what makes " +
    "execFileSync 'didn't throw' a meaningful confirmation signal in the first place)",
    distSource.includes("if ($h -eq [IntPtr]::Zero) { exit 1 }"),
  );
  check(
    "[structural] the PS script exits 1 on a false TerminateProcess return (round 5 contract, same reason)",
    distSource.includes("if (-not $ok) { exit 1 }"),
  );
  check(
    "[structural] the compiled watchdog gates the raw SIGKILL fallback on winCustomExitConfirmed (round 5's " +
    "real contract), never unconditionally",
    /if \(!winCustomExitConfirmed\)/.test(distSource),
  );
  check(
    "[structural] the old round-2 'killedWithCustomCode' short-circuit identifier is gone (superseded by " +
    "winCustomExitConfirmed)",
    !distSource.includes("killedWithCustomCode"),
  );
}

console.log(`\n${failures === 0 ? "✅" : "❌"} graceful-teardown-hard-exit-backstop: ${failures} check(s) failed.`);
console.log(`(LOOM_HOME for this run: ${loomHome})`);
await finishAndExit(failures === 0 ? 0 : 1);
