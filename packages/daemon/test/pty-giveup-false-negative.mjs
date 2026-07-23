// Hermetic regression test for the give-up FALSE-NEGATIVE fix (pty/host.ts sendEnterAndVerify, card
// 71de1f9c — "submit give-up is a false negative 79% of the time and clears busy mid-turn").
//
// ROOT CAUSE being guarded: give-up (SUBMIT_MAX_ATTEMPTS exhausted, no confirming hook yet) used to
// UNCONDITIONALLY call setBusy(false) (directly, or via the composer backspace-clear's completion
// callback) — even when the Enter actually registered and a turn is genuinely still generating, just
// with a slow-to-confirm hook (measured: 79% of a give-up sample WERE followed by a UserPromptSubmit for
// the same session under real fleet load). Clearing busy in that case reopens enqueueStdin's `!live.busy`
// immediate-submit path, so the NEXT message can land inside — and interleave with — the still-running
// turn: the owner-reported "text sitting in the input field, unsent" symptom.
//
// THE FIX: at give-up, check whether the engine produced ANY pty output AFTER the FINAL attempt's own
// Enter write (`live.lastOutputAt`, already used the same way by healIfStuck). If yes, SUPPRESS give-up
// entirely (no busy-clear, no composer touch) and trust the real Stop/UserPromptSubmit — however late —
// to finalize normally. If no output at all, run the EXISTING genuine-drop recovery unchanged (busy
// clear + composerLen===0-gated backspace clear — see pty-giveup-clear.mjs, untouched by this change).
//
// The anchor MUST be the final attempt's own Enter write, not submit()'s own start — the pasted body's
// own render bumps lastOutputAt within the very first attempt, long before give-up, so anchoring any
// earlier makes the check vacuously true. Scenario (3) below tests exactly this: output that happened
// after an EARLIER attempt (but not after the FINAL one) must NOT suppress give-up.
//
// The existing fake ptys across this suite (pty-giveup-clear.mjs, pty-submit-verify-retry.mjs, etc.) all
// discard the onData registration (`onData: () => ({dispose(){}})`), so `lastOutputAt` never advances
// past spawn time in ANY of them — they keep exercising the unchanged genuine-drop branch identically to
// before, which is why none of them needed editing for this fix (proving it's additive, not a regression
// to the already-validated paths). THIS file's fake instead STORES the onData callback so a scenario can
// fire it on demand, simulating the engine reacting to a landed Enter independently of any hook.
//
// BLIND SPOT (CR-flagged, tracked separately — do not treat this suite as proof it's closed): a synthetic
// `emitOutput()` call can't distinguish engine-ORIGINATED output from output merely PROVOKED by Loom's own
// writes (e.g. the give-up branch's own zero-length START+END re-assert at :3679, or a human's Ctrl-L
// repaint) — a real engine reacting to OUR bytes would bump `lastOutputAt` exactly the same way a genuine
// turn-start would, which could suppress give-up on an actual drop. That gap is the real-engine half of the
// investigation and is out of scope here; this suite only proves the daemon's OWN logic reacts correctly to
// a `lastOutputAt` transition, whatever caused it.
//
// RUN (no daemon needed): node test/pty-giveup-false-negative.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sleepUntil(t0, targetMs) {
  const remaining = targetMs - (Date.now() - t0);
  if (remaining > 0) await sleep(remaining);
}
/** Spin-wait (short poll, not a computed deadline) until `getCount()` reaches `target` — used instead of
 *  `sleepUntil` where a scenario needs to react to an OBSERVED write, not a guessed arrival time. A fixed
 *  absolute deadline (ENTER_DELAY + pasteSettleExtraMs + N*VERIFY_TIMEOUT, chained across N setTimeouts)
 *  has only tens of ms of slack under host load — CR-caught: this suite already had 6 timing-margin
 *  regressions today; this helper removes the coupling entirely instead of widening the margin. */
async function waitForCount(getCount, target, timeoutMs = 5000) {
  const t0 = Date.now();
  while (getCount() < target) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitForCount: timed out waiting for count to reach ${target} (stuck at ${getCount()})`);
    await sleep(2);
  }
}
/**
 * Card b64b3726: spin until the real clock has genuinely TICKED PAST `t` (a `Date.now()` value already
 * observed, e.g. the exact millisecond a write landed) — not a sleep, an actual observation of monotonic
 * advancement. `Date.now()` has only 1ms resolution, and product code (`fireEnterAndVerify`) captures
 * `enterWrittenAt` in the SAME synchronous tick as the Enter write itself. `waitForCount` above observes
 * that write and a caller emitting immediately afterward can complete BOTH the observation and the emit
 * inside that SAME millisecond — landing `lastOutputAt === enterWrittenAt`, which the product's
 * intentionally-strict `>` check (Code-Reviewer-endorsed: same-ms is ambiguous, erring toward recovery is
 * the safe side — do NOT relax it to `>=`) reads as "no output after," flipping scenario (1)'s expected
 * SUPPRESSED into a flaky RECOVERY. This is a genuinely new lesson for the blind-sleep campaign (cards
 * 0fa5beef, 595aad10, fea23514, 47a515ff): the earlier computed-deadline version of this file carried tens
 * of ms of incidental slack that HAPPENED to guarantee a clock tick between write and emit — de-racing it
 * into `waitForCount` (removing the guessed deadline) removed that accident too, exposing the granularity
 * assumption the sleep had been silently covering. Removing a blind sleep can un-satisfy an assumption the
 * sleep was accidentally satisfying — check for that, don't just assume less waiting is strictly safer.
 */
async function awaitClockPast(t) {
  while (Date.now() <= t) await sleep(1);
}
/**
 * Card b64b3726: bounded poll until `predicate()` is true — the SAME observe-don't-guess principle as
 * `waitForCount`, applied to a busy-state transition instead of a write count. A 50-run loop proving
 * scenario (1)'s fix (above) surfaced a SEPARATE flake in scenario (2): its `sleepUntil(t0, giveUpAt() +
 * margin)` blind computed-deadline wait occasionally checked `busy===false` before give-up's chain of
 * timers (now one longer, with Half 1's bounded settle-poll) had actually finished firing under momentary
 * host/scheduler jitter — a margin that was comfortable pre-Half-1 stopped being comfortable once one more
 * chained setTimeout was added to the path it's racing. Padding the margin further repeats the exact
 * anti-pattern this file's own header already flags (6 prior margin regressions); polling for the ACTUAL
 * transition removes the race instead of out-guessing it.
 */
async function waitUntil(predicate, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    await sleep(2);
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-giveupfalseneg-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
// Card b64b3726 Half 1: the FINAL attempt now waits (bounded, observed) for its own paste-reassert to
// settle BEFORE writing Enter — see host.ts's REASSERT_SETTLE_POLL_MS/REASSERT_SETTLE_MAX_POLLS. Nothing
// in scenarios (2)/(3) below emits output during that window, so it always maxes out its bound; giveUpAt()
// must account for it or `sleepUntil(t0, giveUpAt() + …)` under-shoots the ACTUAL (now-later) give-up point.
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
const SETTLE_BOUND = SETTLE_POLL * SETTLE_MAX_POLLS; // 50ms
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
const writeAt = (k) => ENTER_DELAY + (k - 1) * VERIFY_TIMEOUT + (k === MAX_ATTEMPTS && k > 1 ? SETTLE_BOUND : 0);
const giveUpAt = () => writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT;

const { PtyHost } = await import("../dist/pty/host.js");

const BACKSPACE = "\x7f";

const fakes = [];
function makeFakePty() {
  const writes = [];
  // Card b64b3726: the exact Date.now() of each bare-Enter ("\r") write, in order — lets a scenario spin
  // past the REAL millisecond a specific attempt's Enter landed (see awaitClockPast) instead of racing it.
  const enterWriteTimes = [];
  let onDataCb = null;
  const fake = {
    pid: 4242,
    write: (d) => { writes.push(d); if (d === "\r") enterWriteTimes.push(Date.now()); },
    // UNLIKE this suite's other fakes: actually stores the callback, so a scenario can fire it on demand
    // to simulate real engine output (bumps live.lastOutputAt inside host.ts's own pty.onData handler).
    onData: (cb) => { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit: () => ({ dispose() {} }),
    kill: () => {},
    resize: () => {},
    writes,
    enterWriteTimes,
    emitOutput: (s = ".") => { if (onDataCb) onDataCb(Buffer.from(s, "utf-8")); },
  };
  fakes.push(fake);
  return fake;
}

class TestPtyHost extends PtyHost {
  createPty() { return makeFakePty(); }
}

const busyLog = {};
const events = {
  onEngineSessionId() {},
  onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
};

const host = new TestPtyHost(events);

function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return {
    fake,
    written: () => fake.writes.join(""),
    backspaceCount: () => fake.writes.join("").split(BACKSPACE).length - 1,
    entryCount: () => fake.writes.join("").split("\r").length - 1,
  };
}

try {
  // ===================== (1) THE FALSE NEGATIVE: output after the FINAL Enter write → SUPPRESS =====
  {
    const SID = "sess-suppress";
    const TEXT = "REAL_TURN_JUST_SLOW_TO_CONFIRM";
    const { fake, backspaceCount, entryCount } = spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(1) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // Wait for the OBSERVED third `\r` (not a computed deadline — see waitForCount's own doc), THEN spin
    // until the real clock has genuinely ticked past the EXACT millisecond that write landed in (see
    // awaitClockPast's doc — Date.now() is only 1ms-resolution and product code captures `enterWrittenAt`
    // in the same synchronous tick as the write, so emitting "immediately after observing the write" can
    // land in the SAME millisecond and be read as "no output after", flakily degenerating into scenario
    // (3)'s outcome under fast/loaded hosts). This makes the ordering a real observation, not a guess.
    await waitForCount(entryCount, MAX_ATTEMPTS);
    check("(1) all attempts written by now", entryCount() === MAX_ATTEMPTS);
    await awaitClockPast(fake.enterWriteTimes[MAX_ATTEMPTS - 1]);
    fake.emitOutput("spinner-tick-after-final-enter");

    // Cross the give-up deadline. Assert give-up was SUPPRESSED: busy stays true, composer untouched.
    await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
    check("(1) GIVE-UP SUPPRESSED: busy is STILL true (never falsely cleared into the live turn)",
      busyLog[SID].at(-1) === true);
    check("(1) NO backspace clear was written (the composer/injection was never touched)",
      backspaceCount() === 0);
    check("(1) no extra Enter was written past the normal MAX_ATTEMPTS (suppression doesn't retry further)",
      entryCount() === MAX_ATTEMPTS);

    // The real hook eventually arrives, LATE — well past where give-up already fired above. This is how a
    // slow hook round-trip is simulated: the test calls deliverHook whenever IT chooses, decoupled from
    // any real wall-clock/host-load timing.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    check("(1) the late hook re-confirms normally (busy stays/goes true — never left stuck by the suppression)",
      busyLog[SID].at(-1) === true);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(1) the turn finalizes cleanly afterward — no corruption from the suppressed give-up",
      busyLog[SID].at(-1) === false && host.getPending(SID).length === 0);
  }

  // ===================== (2) GENUINE DROP (regression): NO output at all → recovery fires exactly as before ===
  {
    const SID = "sess-genuine-drop";
    const TEXT = "TRULY_NEVER_REGISTERED";
    const { backspaceCount, entryCount } = spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(2) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // Never fire onData at all (this fake CAN emit output — scenario (1) proves that — so a passing result
    // here is a real assertion about the discriminator, not an artifact of an inert fake). Poll for the
    // ACTUAL busy=false transition (see waitUntil's doc) rather than guessing a deadline — give-up
    // eventually recovering within a generous bound IS the assertion; a `sleepUntil` here would just be
    // racing the give-up chain's own timers again.
    await waitUntil(() => busyLog[SID].at(-1) === false);
    check("(2) all attempts written (bounded retries)", entryCount() === MAX_ATTEMPTS);
    check("(2) GIVE-UP RECOVERY: busy fell back to false — genuine drops are still recovered, unchanged",
      busyLog[SID].at(-1) === false);
    check(`(2) CLEAR: exactly ${TEXT.length} backspaces were written to un-type the stranded injection`,
      backspaceCount() === TEXT.length);
  }

  // ===================== (3) ANCHOR CORRECTNESS: output after an EARLIER attempt only → still recovers ===
  // Proves the discriminator is anchored on the FINAL Enter write specifically, not "any output since
  // submit() started" (which would be vacuously true from the pasted body's own render) nor "any output
  // since ANY earlier attempt" (which would wrongly suppress on stale evidence).
  {
    const SID = "sess-stale-output";
    const TEXT = "OUTPUT_WAS_STALE_BY_FINAL_ATTEMPT";
    const { fake, backspaceCount, entryCount } = spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(3) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // Output happens shortly after attempt 1's write — but well BEFORE the final attempt's own write, so
    // by the time give-up checks lastOutputAt against the FINAL attempt's write time, this output is
    // already in the past relative to that anchor.
    await sleepUntil(t0, writeAt(1) + 20);
    fake.emitOutput("stale-output-from-an-earlier-attempt-only");

    await waitUntil(() => busyLog[SID].at(-1) === false); // observe the transition — see waitUntil's doc
    check("(3) all attempts written", entryCount() === MAX_ATTEMPTS);
    check("(3) GIVE-UP RECOVERY still fires: stale pre-final-attempt output does NOT suppress give-up",
      busyLog[SID].at(-1) === false);
    check(`(3) CLEAR still runs: exactly ${TEXT.length} backspaces written (the anchor is the FINAL attempt, not an earlier one)`,
      backspaceCount() === TEXT.length);
  }
} finally {
  for (const sid of ["sess-suppress", "sess-genuine-drop", "sess-stale-output"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — give-up is SUPPRESSED (busy left alone, composer untouched) when the engine produced output after the FINAL Enter write (turn likely already running), and still RECOVERS exactly as before (busy cleared, composer un-typed) on a genuine drop with no output at all — anchored precisely on the final attempt, not an earlier one or submit()'s own start."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
