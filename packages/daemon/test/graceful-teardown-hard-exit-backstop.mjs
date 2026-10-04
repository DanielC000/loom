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
// HERMETIC: no real daemon boot (dist/index.js is never spawned), no *-real-spawn* shape. Every real
// child process here is one of this file's own tiny fixtures under test/fixtures/, spawned directly, and
// each of THOSE fixtures now also calls requireHermeticEnv() itself (round 3 finding 8) — a real incident
// had a reviewer run one standalone, with no LOOM_HOME set, writing a stray record into the real
// `~/.loom/logs/shutdown-watchdog.json`. LOOM_HOME is pinned to an isolated temp dir (never the real
// `~/.loom`) since a firing watchdog now writes a record file under it.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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
let asideFilesSeenSoFar = [];

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
  const asideFilesNow = recordPath != null ? listAsideFiles(recordPath) : [];
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
  const asideFilesAfter = listAsideFiles(recordPath);
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
{
  const defaultHardExitMs = 1200;
  const longBudgetMs = 15_000; // wide separation from the tightened upper bound below (see the decision note)
  const surviveBlockMs = 2500; // > defaultHardExitMs, < longBudgetMs
  const tightUpperSlackMs = 6000; // generous for win32 PowerShell kill overhead under a loaded gate + CI/host scheduling slop
  const r = await runChild(PER_STEP_BUDGET, [String(defaultHardExitMs), String(longBudgetMs), String(surviveBlockMs)], surviveBlockMs + longBudgetMs + 15_000);
  check("[per-step budget] the long-budget step was NOT killed during its own override window, past the short default", r.out.includes("long-step survived past the short default"));
  check("[per-step budget] the process still eventually died (the short-budget step's hang was caught)", r.timedOut === false);
  check(
    "[per-step budget] death happened AFTER surviveBlockMs + the short default (not killed early, during the long-budget step)",
    r.elapsedMs >= surviveBlockMs + defaultHardExitMs - 500,
  );
  check(
    "[per-step budget] death happened PROMPTLY on the short-budget step's own default, not after sleeping through " +
    "to the stale long deadline (this is the check that catches a missing step()-side wake-up — see the decision note above)",
    r.elapsedMs < surviveBlockMs + defaultHardExitMs + tightUpperSlackMs,
  );
  console.log(`  (elapsedMs=${Math.round(r.elapsedMs)}, defaultHardExitMs=${defaultHardExitMs}, longBudgetMs=${longBudgetMs}, surviveBlockMs=${surviveBlockMs})`);
}

// ---------------------------------------------------------------------------------------------------
// (3) STRUCTURAL: round 2 finding 3 — the win32 kill path must ALWAYS fall through to a direct SIGKILL,
// never short-circuit it behind a "PowerShell appeared to succeed" flag (PowerShell exiting 0 does NOT
// prove TerminateProcess actually ran — OpenProcess can silently return a null handle).
//
// Positive control: the OLD (pre-round-2) source genuinely contained this identifier — confirmed via
// `git show HEAD:packages/daemon/src/graceful-teardown.ts` at the time this test was written — so its
// absence here is a real, discriminating signal, not a pattern that could never have matched anything.
// ---------------------------------------------------------------------------------------------------
{
  const distSource = fs.readFileSync(path.join(__dirname, "..", "dist", "graceful-teardown.js"), "utf8");
  check(
    "[structural] the compiled watchdog no longer gates the SIGKILL fallback behind a 'killedWithCustomCode' short-circuit",
    !distSource.includes("killedWithCustomCode"),
  );
}

console.log(`\n${failures === 0 ? "✅" : "❌"} graceful-teardown-hard-exit-backstop: ${failures} check(s) failed.`);
console.log(`(LOOM_HOME for this run: ${loomHome})`);
await finishAndExit(failures === 0 ? 0 : 1);
