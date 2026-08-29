// Regression test for card ac20c8e7 (bb3d9005 residuals ① and ②) — pty/host.ts.
//
// bb3d9005 gated every write site it found reachable in the kill()→'exit' window on `alive && !killed`
// (see pty-write-after-kill-race.mjs for that original fix). Two residuals survived that card:
//
// ① THE WORKER'S OWN FLAG: the boot-time mode-cycle / resume-gate write timers remained gated on `alive`
//    ALONE. This file proves each is genuinely reachable — a kill() (hard stop, or an escalated graceful
//    stop) can land while one of these timers is still armed, since `alive` stays true through the whole
//    kill()→'exit' window (see Live.killed's own doc) — and that the fix (adding `!live.killed`) closes
//    it without changing the normal (never-killed) path:
//      Trial 1: cycleToMode's decide() — the Shift+Tab boot mode-convergence press.
//      Trial 2: resolveResumeGate — the resume-summary-gate Down press.
//      Trial 3: awaitResumeGateConfirm — the resume-summary-gate Enter press (after Down is confirmed).
//      Trial 4: the plugin-MCP-prompt dismissal — the boot Esc press.
//
// ② THE REVIEWER'S FINDING: escalateGracefulStop's stage-3 kill() escalation guarded only `!live.alive`,
//    not `killed` — reachable when a hard stop() lands WHILE an earlier graceful stop's stage-3 timer is
//    still armed (the card's own framing: "does anything call stop(hard) while a graceful escalation is
//    armed?"). Answer: YES — e.g. CompanionService's engine-upgrade teardown (service.ts) issues a
//    graceful stop, waits, and falls back to a hard stop if still alive; nothing cancels the graceful
//    stop's own stage-3 timer, which can still fire later. Trial 5 proves the pre-fix code calls the
//    (fake) pty's kill() TWICE in that sequence, and the fix (`|| live.killed` on stage 3's guard) brings
//    it back to exactly once.
//    THE SAME TRIAL ALSO CAUGHT A SIBLING GAP, NOT NAMED BY THE CARD: stage 2's own immediate re-send
//    write (the "still live after interrupt" Ctrl-C, fired at GRACEFUL_STOP_RETRY_MS — strictly before
//    this call's own stage 3, so `killed` could never be true from THIS call alone) was ALSO gated on
//    `!live.alive` only. In this exact hard-stop-while-graceful-armed sequence stage 2's timer can still
//    be pending when the hard stop lands, and its write reached the (fake) pty and threw — caught while
//    developing this trial, not by design (mirroring how pty-write-after-kill-race.mjs's own Trial 4 was
//    found). Fixed the same way, same file, same guard clause — not a separate residual, just the same
//    class of gap one write site over in the identical function.
//
// Each fake pty here throws on write while "killed" (mirroring the real crash a write-after-kill causes —
// see pty-write-after-kill-race.mjs's own header for why) so a guard regression fails LOUDLY, and tracks
// its own kill() call count so a redundant kill() is a visible, counted event rather than an inference.
//
// (RED / positive control, verified by hand against this card's pre-fix code): every "did NOT reach the
//   pty" / "did NOT throw" / "kill() called exactly once" assertion below was re-run against the code as
//   it stood before this card's fix (each guard's added `killed` check reverted in turn) and FAILED —
//   the stray write/redundant kill genuinely landed, proving each trial lands inside the race rather than
//   merely near it.
// (GREEN / the fix, current code): all pass.
//
// RUN (no daemon needed): node test/pty-boot-timer-kill-race.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sleepPast } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred, timeoutMs, intervalMs = 10) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return pred();
    await sleep(intervalMs);
  }
  return true;
};

const tmpHome = path.join(os.tmpdir(), `loom-pty-boot-kill-race-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Fast footer/gate polling so trials 1-3's timers settle in milliseconds, not seconds.
process.env.LOOM_RESUME_MODE_POLL_MS = "30";
process.env.LOOM_RESUME_MODE_MAX_POLLS = "30";
process.env.LOOM_RESUME_GATE_POLL_MS = "30";
process.env.LOOM_RESUME_GATE_MAX_POLLS = "30";
// Fast graceful-escalation timers for Trial 5 — same env-override convention and the same large
// KILL/RETRY-vs-GAP margin reasoning as pty-write-after-kill-race.mjs (see that file's own comment):
// GAP is deliberately far larger than RETRY/KILL so its own delayed resends can never interfere with
// this trial's short window.
process.env.LOOM_GRACEFUL_GAP_MS = "300";
process.env.LOOM_GRACEFUL_RETRY_MS = "10";
process.env.LOOM_GRACEFUL_KILL_MS = "20";

const { PtyHost } = await import("../dist/pty/host.js");

const fakes = [];
function makeFakePty() {
  const writes = []; // { data, afterKill }
  let killCount = 0;
  let exitCb = null;
  let dataCb = null;
  const fake = {
    pid: 4242,
    isKilled: false,
    write: (d) => {
      const afterKill = fake.isKilled;
      writes.push({ data: d, afterKill });
      if (afterKill) {
        // Mirrors the real crash (see pty-write-after-kill-race.mjs): a write reaching the destroyed
        // socket in the kill()→'exit' window throws an unhandled 'error' in production.
        throw new Error("SIMULATED write-after-kill (would be an unhandled destroyed-socket 'error' in production)");
      }
    },
    onData: (cb) => { dataCb = cb; return { dispose() {} }; },
    onExit: (cb) => { exitCb = cb; return { dispose() {} }; },
    // Never auto-fires exit — the kill()→'exit' window stays open until the test explicitly closes it,
    // exactly like pty-write-after-kill-race.mjs's fake (real node-pty's exit is async; this makes the
    // window fully test-controlled rather than a tens-of-ms timing target to get lucky landing inside).
    kill: () => { fake.isKilled = true; killCount++; },
    resize: () => {},
    writes,
    get killCount() { return killCount; },
    feed: (s) => { if (dataCb) dataCb(Buffer.from(s, "utf-8")); },
    fireExit: (code) => { if (exitCb) exitCb({ exitCode: code ?? 0 }); },
  };
  fakes.push(fake);
  return fake;
}

class TestPtyHost extends PtyHost {
  createPty() { return makeFakePty(); }
}

const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

function spawn(sessionId, opts = {}) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: opts.startupModeCycles ?? 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  return fakes[fakes.length - 1];
}

const SHIFT_TAB = "\x1b[Z";
const DOWN_ARROW = "\x1b[B";
const ACCEPT_EDITS_FOOTER = "accept edits on (shift+tab to cycle)";
const PLAN_FOOTER = "plan mode on (shift+tab to cycle)";
const GATE_PREFIX = "This session is 1h old. We recommend resuming from a summary.\n";
const GATE = GATE_PREFIX
  + "❯ 1. Resume from summary (recommended)\n  2. Resume full session as-is\n  3. Don't ask me again";
const GATE_ON_OPTION_2 = GATE_PREFIX
  + "  1. Resume from summary (recommended)\n❯ 2. Resume full session as-is\n  3. Don't ask me again";
const MCP_PROMPT = "Found a new MCP server in this project. Reject all?";

// Anchors a "did the bug's symptom occur" wait to the OBSERVABLE symptom itself (an uncaught write-after-
// kill exception, or a new write reaching the fake pty), not a bare fixed sleep: `trigger()` fires
// whatever the scenario needs (a footer feed, or nothing — time alone), then polls (via `waitUntil`,
// never a raw `sleep` immediately before a negative check) for either symptom up to `timeoutMs`. Pre-fix,
// the symptom appears almost immediately (well inside one poll interval) and this returns EARLY — a RED
// run is fast, not just eventually-consistent. Post-fix (the expected/asserted case) neither symptom ever
// appears, so this legitimately waits the full bound — same cost as a fixed sleep in that one direction,
// but never masks a slow-arriving symptom the way a bare sleep would if the bound were too tight, since
// the predicate is re-checked on every poll rather than assumed satisfied once time elapses.
const observeSymptom = async (fake, beforeCount, trigger, timeoutMs, killCountBefore = fake.killCount) => {
  let caught = null;
  const onUncaught = (e) => { caught = e; };
  process.on("uncaughtException", onUncaught);
  try {
    trigger();
    await waitUntil(
      () => caught !== null || fake.writes.length > beforeCount || fake.killCount > killCountBefore,
      timeoutMs,
    );
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  return caught;
};

try {
  // ===== Trial 1: cycleToMode's decide() — the boot mode-convergence Shift+Tab — landing in the
  // hard-stop kill()→exit window. =====
  {
    const SID = "sess-boot-cycle-hard";
    const fake = spawn(SID, { startupModeCycles: 2 }); // target "auto": acceptEdits -> plan -> auto
    fake.feed(ACCEPT_EDITS_FOOTER); // boot footer already painted before SessionStart fires
    host.deliverHook(SID, { hook_event_name: "SessionStart" });

    check("[cycle/hard] positive control: the 1st Shift+Tab reached the pty before any kill",
      await waitUntil(() => fake.writes.some((w) => w.data === SHIFT_TAB && !w.afterKill), 3000));

    host.stop(SID, "hard"); // sets Live.killed=true, calls the fake's kill() — no 'exit' fired yet
    check("[cycle/hard] sanity: fake pty is killed but NOT exited (the window under test is open)",
      fake.isKilled === true && host.isAlive(SID) === true);

    const beforeCount = fake.writes.length;
    // Feed the footer change the still-armed awaitChange poll is waiting for — pre-fix this lets
    // decide() issue a 2nd Shift+Tab straight into the killed pty.
    const caught = await observeSymptom(fake, beforeCount, () => fake.feed(PLAN_FOOTER), 300);
    check("[cycle/hard] THE FIX: no further Shift+Tab reached the pty after the kill",
      fake.writes.length === beforeCount);
    check("[cycle/hard] THE FIX: no uncaught write-after-kill exception", caught === null);

    fake.fireExit(0);
  }

  // ===== Trial 2: resolveResumeGate's Down press landing in the hard-stop kill()->exit window. =====
  {
    const SID = "sess-boot-resumegate-down-hard";
    const fake = spawn(SID);

    fake.feed(GATE); // detects the resume-summary gate, schedules resolveResumeGate at a fixed 300ms
    host.stop(SID, "hard"); // kill lands WHILE that 300ms timer is still pending
    check("[resumegate-down/hard] sanity: fake pty is killed but NOT exited",
      fake.isKilled === true && host.isAlive(SID) === true);

    const beforeCount = fake.writes.length;
    const caught = await observeSymptom(fake, beforeCount, () => {}, 600); // > the fixed 300ms resolveResumeGate delay
    check("[resumegate-down/hard] THE FIX: the resume-gate Down press did not reach the pty after the kill",
      fake.writes.length === beforeCount);
    check("[resumegate-down/hard] THE FIX: no uncaught write-after-kill exception", caught === null);

    fake.fireExit(0);
  }

  // ===== Trial 3: awaitResumeGateConfirm's Enter press (after the Down is confirmed) landing in the
  // hard-stop kill()->exit window. =====
  {
    const SID = "sess-boot-resumegate-enter-hard";
    const fake = spawn(SID);

    fake.feed(GATE);
    // Let resolveResumeGate fire for real (not killed yet) — proves this session was genuinely alive
    // when the Down press went out, and only the LATER Enter-confirm poll lands in the kill window.
    check("[resumegate-enter/hard] positive control: the Down press reached the pty before any kill",
      await waitUntil(() => fake.writes.some((w) => w.data === DOWN_ARROW && !w.afterKill), 1000));
    check("[resumegate-enter/hard] sanity: not killed yet", fake.isKilled === false);

    host.stop(SID, "hard"); // kill lands while awaitResumeGateConfirm's poll loop is still running
    const beforeCount = fake.writes.length;
    // the cursor confirmation the poll is waiting for
    const caught = await observeSymptom(fake, beforeCount, () => fake.feed(GATE_ON_OPTION_2), 300);
    check("[resumegate-enter/hard] THE FIX: the confirmed Enter did not reach the pty after the kill",
      fake.writes.length === beforeCount);
    check("[resumegate-enter/hard] THE FIX: no uncaught write-after-kill exception", caught === null);

    fake.fireExit(0);
  }

  // ===== Trial 4: the plugin-MCP-prompt Esc dismissal landing in the hard-stop kill()->exit window. =====
  {
    const SID = "sess-boot-mcp-esc-hard";
    const fake = spawn(SID);

    fake.feed(MCP_PROMPT); // detects the prompt, schedules the Esc dismissal at a fixed 300ms
    host.stop(SID, "hard"); // kill lands WHILE that 300ms timer is still pending
    check("[mcp-esc/hard] sanity: fake pty is killed but NOT exited",
      fake.isKilled === true && host.isAlive(SID) === true);

    const beforeCount = fake.writes.length;
    const caught = await observeSymptom(fake, beforeCount, () => {}, 600); // > the fixed 300ms dismissal delay
    check("[mcp-esc/hard] THE FIX: the Esc dismissal did not reach the pty after the kill",
      fake.writes.length === beforeCount);
    check("[mcp-esc/hard] THE FIX: no uncaught write-after-kill exception", caught === null);

    fake.fireExit(0);
  }

  // ===== Trial 5: escalateGracefulStop's stage-3 kill() firing a SECOND time — reachable when a hard
  // stop() lands while an earlier graceful stop's stage-3 timer is still armed (card's own framing:
  // "does anything call stop(hard) while a graceful escalation is armed?" — yes, e.g. the companion
  // engine-upgrade teardown: graceful stop, wait, then a hard-stop fallback if still alive — nothing
  // cancels the graceful stop's own stage-3 timer in between). =====
  {
    const SID = "sess-boot-graceful-then-hard";
    const fake = spawn(SID);

    host.stop(SID, "graceful"); // arms stage-2 (RETRY_MS=10ms) and stage-3 (KILL_MS=20ms) from now
    check("[graceful-then-hard] sanity: graceful stop did not kill yet", fake.isKilled === false);

    // TIMING-GUARD-SAFE: sequencing-only — this wait's job is to land the hard stop before stage 2
    // (RETRY_MS=10ms) and stage 3 (KILL_MS=20ms) fire, not to prove either does or doesn't happen; the
    // checks immediately below are synchronous sanity checks on state this call itself just set
    // (killCount/isAlive), not a race-sensitive assertion — the actual THE FIX assertions for this trial
    // are anchored to their own observable symptoms further down, via observeSymptom, not this sleep.
    await sleep(5); // land the hard stop WHILE both stage 2 and stage 3 are still pending
    host.stop(SID, "hard"); // kill #1 — sets killed=true, calls kill() once
    check("[graceful-then-hard] sanity: the hard stop performed kill #1", fake.killCount === 1);
    check("[graceful-then-hard] sanity: pty remains alive (window under test still open — fireExit is "
      + "only called at the end of this trial)", host.isAlive(SID) === true);

    const beforeCount = fake.writes.length;
    const killCountBefore = fake.killCount;
    // TWO INDEPENDENT symptoms share this one window — stage 2's stray write (fires ~10ms out) and
    // stage 3's redundant kill() (fires ~20ms out) — so this deliberately does NOT early-exit on the
    // FIRST symptom the way observeSymptom (used above) does: an early exit on stage 2's write would stop
    // watching before stage 3's own, LATER timer ever gets its turn — a real failure mode this trial's
    // own development caught (an early build of this trial reported stage 3 "fixed" purely because it
    // stopped observing at ~10ms, before stage 3's 20ms mark). sleepPast asserts the margin at runtime
    // (card 5e51e778) rather than trusting a comment; every symptom below is checked only AFTER the full,
    // unconditional wait, so neither can be missed by the other resolving first.
    let caught = null;
    const onUncaught = (e) => { caught = e; };
    process.on("uncaughtException", onUncaught);
    try {
      await sleepPast(300, 20, "past GRACEFUL_STOP_KILL_MS(20)/RETRY_MS(10), 15x margin over the larger");
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    check("[graceful-then-hard] THE FIX: stage 2's OWN re-send did not reach the already-killed pty "
      + "(no further write reached it)", fake.writes.length === beforeCount);
    check("[graceful-then-hard] THE FIX: no uncaught write-after-kill exception from stage 2's re-send",
      caught === null);
    check("[graceful-then-hard] THE FIX: stage 3's OWN kill() call was suppressed by the earlier hard "
      + "kill (killCount stayed at 1, not 2 — no redundant real kill())", fake.killCount === killCountBefore);

    fake.fireExit(0);
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the boot-time mode-cycle/resume-gate write timers (mode convergence, resume-"
    + "summary-gate Down/Enter, plugin-MCP-prompt dismissal) now gate on `alive && !killed` like every "
    + "other write site bb3d9005 fixed, and escalateGracefulStop's stage-3 kill() no longer fires a "
    + "redundant real kill() when an earlier hard stop already killed the pty while its timer was still "
    + "armed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
