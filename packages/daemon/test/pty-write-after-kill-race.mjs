// Regression test for card bb3d9005 S1 (pty/host.ts): a write reaching the pty in the kill()→'exit'
// window crashes the WHOLE daemon.
//
// EXTENDED for card 5683c2e3: the one write/kill site in this same method family bb3d9005/ac20c8e7 left
// unguarded — stop()'s OWN first graceful Ctrl-C write (the immediate one, not either delayed resend) —
// reachable whenever a SECOND stop() call (either mode) lands after an earlier kill was already issued
// (a prior hard stop(), or this session's own escalateGracefulStop stage-3). Trials 5-6 below reproduce
// both of those "already killed" entry paths and assert the second call's own write never reaches the
// fake pty. Trials 7-8 are the DoD-4 exercise: a genuine FIRST stop (idle and busy/mid-turn) must still
// write its Ctrl-C exactly as before — `killed` is false on a first call, so the new guard is a no-op.
//
// THE BUG: node-pty's useConptyDll kill() path (windowsPtyAgent.js, verified independently at source
// against the installed node-pty@1.1.0) destroys `_inSocket` SYNCHRONOUSLY inside `kill()` — but the
// underlying pty process can take tens of ms to actually exit, and `live.alive` doesn't flip to false
// until that async 'exit' event lands. node-pty attaches an 'error' listener to the OUT socket but NEVER
// to `_inSocket` — so a write reaching the destroyed socket during that window emits an unhandled
// 'error' and crashes the process, killing every live session across every project, not just this one.
// `repaint()` (a viewer-triggered write) and `writeChunked` (the choke point behind `writeStdin`'s raw
// human keystrokes, deliberately ungated on busy/stopping "by design — a real human must always be able
// to type") were both gated on `live.alive` ALONE — exactly the condition that stays true for that whole
// window.
//
// THE FIX: `Live.killed` flips true SYNCHRONOUSLY at the same moment `live.pty.kill()` is called (both
// call sites — stop()'s hard branch and escalateGracefulStop's stage-3 escalation) — i.e. it closes
// exactly at kill(), not at 'exit'. `repaint()` and `writeChunked` (and its downstream `writeNewTurn`
// async re-checks in submit()) now gate on `alive && !killed`.
//
// A fake IPty models the real crash mechanism directly and deterministically, closing over the
// well-known race-window-timing-luck failure mode this exact class of bug invites (see this card's own
// steering: "it is very easy to write a test that 'covers' it and never actually lands inside it"): its
// `kill()` flips an exposed `isKilled` flag SYNCHRONOUSLY (mirroring the real synchronous socket
// destroy) but the fake's `onExit` callback is NEVER invoked until the test explicitly fires it — so the
// "kill()→'exit' window" is not a tens-of-ms timing target to get lucky landing inside, it is fully
// test-controlled and stays open indefinitely until the test chooses to close it. Its `write()` THROWS
// when called while `isKilled` is true, mirroring the real unhandled-'error'-crashes-the-process outcome
// — so a guard regression here reproduces as a genuine synchronous exception, not a silent behavior diff.
//
// (RED / positive control) verified by hand against this card's pre-fix code (temporarily reverting
//   host.ts's Live.killed plumbing and re-running): both HARD and GRACEFUL trials below throw and record
//   a stray write reaching the fake pty during the kill()→exit window — proving this genuinely lands
//   inside the race, not just near it.
// (GREEN / the fix) neither trial's post-kill write attempt reaches the fake pty or throws.
//
// RUN (no daemon needed): node test/pty-write-after-kill-race.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-pty-kill-race-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Fast graceful-escalation timers — the graceful trials need stage 3's real (escalated) kill() to fire,
// not a shortcut around it; shrink the wait, not the mechanism. GAP is deliberately much larger than
// RETRY/KILL (not just "small") — TIMING-GUARD justification: Trial 4 below needs BOTH delayed Ctrl-C
// resend timers (stop()'s own, and escalateGracefulStop stage 2's own — each scheduled GAP ms after their
// respective immediate write) to fire STRICTLY AFTER stage 3's kill(), deterministically, not by jitter
// luck (a same-order-of-magnitude gap between KILL and the resend times bit this exact test during
// development — see Trial 4's own comment). With KILL=20 and the resends at 300/310, the margin (~280ms)
// is large relative to ordinary setTimeout scheduling jitter, so this ordering is not a fixed-wait-vs-
// unbounded-async-completion gamble: every timer here is a plain JS setTimeout at a constant the test
// itself set, not a wait on an external operation of unknown duration.
process.env.LOOM_GRACEFUL_GAP_MS = "300";
process.env.LOOM_GRACEFUL_RETRY_MS = "10";
process.env.LOOM_GRACEFUL_KILL_MS = "20";

const { PtyHost } = await import("../dist/pty/host.js");

const fakes = [];
function makeFakePty() {
  const writes = []; // { data, afterKill } — afterKill===true is the exact defect this test guards against
  let exitCb = null;
  const fake = {
    pid: 4242,
    isKilled: false, // exposed (not closure-private) so the test can poll it deterministically
    write: (d) => {
      const afterKill = fake.isKilled;
      writes.push({ data: d, afterKill });
      if (afterKill) {
        // Mirrors the real crash: node-pty's DLL kill() destroys `_inSocket` synchronously, and node-pty
        // never attaches an 'error' listener to it — a write reaching it throws an unhandled 'error'
        // that crashes the whole process. Throwing here is what makes a guard regression fail LOUDLY
        // (a synchronous exception) rather than as a silent, easy-to-miss behavior diff.
        throw new Error("SIMULATED write-after-kill (would be an unhandled destroyed-socket 'error' in production)");
      }
    },
    onData: () => ({ dispose() {} }),
    onExit: (cb) => { exitCb = cb; return { dispose() {} }; },
    // Real node-pty's DLL-mode kill() destroys the socket SYNCHRONOUSLY but the process itself can take
    // tens of ms to actually exit ('exit' fires asynchronously, later). Mirror exactly that: flip
    // `isKilled` now, but never call `exitCb` here — the test decides when (or whether) to.
    kill: () => { fake.isKilled = true; },
    resize: () => {},
    writes,
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

function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  return fakes[fakes.length - 1];
}

try {
  // ===== Trial 1: repaint() landing in the HARD-stop kill()→exit window =====
  {
    const SID = "sess-kill-race-repaint-hard";
    const fake = spawnReady(SID);

    // Positive control: repaint() writes normally before any kill — proves the detector isn't vacuous
    // (a write really does reach the fake pty in the ordinary case).
    host.repaint(SID);
    check("[hard/repaint] positive control: repaint() wrote before kill", fake.writes.some((w) => !w.afterKill));

    host.stop(SID, "hard"); // sets Live.killed=true, then calls the fake's kill() — no 'exit' fired yet
    check("[hard/repaint] sanity: fake pty is killed but NOT exited (the window under test is open)", fake.isKilled === true);

    const beforeCount = fake.writes.length;
    let threw = null;
    try { host.repaint(SID); } catch (e) { threw = e; }
    check("[hard/repaint] THE FIX: repaint() during the kill→exit window did not reach the pty", fake.writes.length === beforeCount);
    check("[hard/repaint] THE FIX: repaint() during the kill→exit window did not throw", threw === null);

    fake.fireExit(0); // close the window for real, matching the eventual production 'exit'
    check("[hard/repaint] session reads dead once exit finally lands", host.isAlive(SID) === false);
  }

  // ===== Trial 2: writeStdin() (raw human keystroke, the writeChunked choke point) landing in the same
  // HARD-stop window — writeStdin is deliberately ungated on busy/stopping ("a real human must always be
  // able to type"), so it is reachable in exactly this window unless writeChunked itself checks `killed`.
  {
    const SID = "sess-kill-race-stdin-hard";
    const fake = spawnReady(SID);

    host.writeStdin(SID, "hello");
    check("[hard/stdin] positive control: writeStdin() wrote before kill", fake.writes.some((w) => !w.afterKill));

    host.stop(SID, "hard");
    check("[hard/stdin] sanity: fake pty is killed but NOT exited", fake.isKilled === true);

    const beforeCount = fake.writes.length;
    let threw = null;
    try { host.writeStdin(SID, "still typing"); } catch (e) { threw = e; }
    check("[hard/stdin] THE FIX: writeStdin() during the kill→exit window did not reach the pty", fake.writes.length === beforeCount);
    check("[hard/stdin] THE FIX: writeStdin() during the kill→exit window did not throw", threw === null);

    fake.fireExit(0);
  }

  // ===== Trial 3: repaint() landing in the GRACEFUL-stop escalation's stage-3 kill()→exit window — the
  // OTHER live.pty.kill() call site (escalateGracefulStop), reached only once the fake never self-exits
  // on the Ctrl-C writes stop() sends first (a real wedged/ignoring-Ctrl-C turn) and the escalation timer
  // fires for real (LOOM_GRACEFUL_KILL_MS, shrunk above — the mechanism runs unmodified, only its timing).
  {
    const SID = "sess-kill-race-repaint-graceful";
    const fake = spawnReady(SID);

    host.repaint(SID);
    check("[graceful/repaint] positive control: repaint() wrote before kill", fake.writes.some((w) => !w.afterKill));

    host.stop(SID, "graceful"); // writes Ctrl-C×2 immediately; fake never exits on it — forces real stage-3 escalation

    const deadline = Date.now() + 5_000;
    // TIMING-GUARD-SAFE: fully-awaited-completion — this loop polls for the POSITIVE, observable
    // `fake.isKilled` flip (stage 3's real kill() call); the check right below runs the INSTANT that poll
    // observes it, with no further await in between. `host.isAlive(SID)` in that same check isn't a race
    // either: nothing in this test calls `fake.fireExit()` until after these checks, so it stays true by
    // construction, not by a timing guess.
    while (!fake.isKilled && Date.now() < deadline) await sleep(5);
    check("[graceful/repaint] sanity: stage-3 escalation genuinely called kill() (fake pty is killed, not exited)", fake.isKilled === true && host.isAlive(SID) === true);

    const beforeCount = fake.writes.length;
    let threw = null;
    try { host.repaint(SID); } catch (e) { threw = e; }
    check("[graceful/repaint] THE FIX: repaint() during the escalated kill→exit window did not reach the pty", fake.writes.length === beforeCount);
    check("[graceful/repaint] THE FIX: repaint() during the escalated kill→exit window did not throw", threw === null);

    fake.fireExit(0);
  }

  // ===== Trial 4: the delayed Ctrl-C RESEND timers landing AFTER stage-3's kill() — the two remaining
  // write call sites this test caught DURING its own development, not by design: stop()'s own delayed
  // resend and escalateGracefulStop stage 2's own delayed resend (each `setTimeout(() => { if
  // (live.alive) ... }, GRACEFUL_STOP_GAP_MS)`) both used to check `live.alive` alone. They run on timers
  // independent of stage 3's kill() timer, so ordinary setTimeout scheduling jitter can (and, on a real
  // run against an early draft of this card's fix, DID) let either resend fire after kill() while `alive`
  // was still true. The env override above makes this ordering DETERMINISTIC rather than jitter luck:
  // kill() fires at KILL_MS=20ms while both resends are scheduled ~300/310ms out — by construction, not
  // chance, they can only ever fire after kill() with a ~280ms margin, robust to ordinary host jitter.
  {
    const SID = "sess-kill-race-resend-graceful";
    const fake = spawnReady(SID);

    let caught = null;
    const onUncaught = (e) => { caught = e; };
    process.on("uncaughtException", onUncaught);
    try {
      host.stop(SID, "graceful");

      const killDeadline = Date.now() + 5_000;
      // TIMING-GUARD-SAFE: fully-awaited-completion — same reasoning as Trial 3's identical site above:
      // this loop polls for the POSITIVE, observable `fake.isKilled` flip; the check runs the instant
      // that poll observes it, and `host.isAlive(SID)` holds by construction (fireExit isn't called yet).
      while (!fake.isKilled && Date.now() < killDeadline) await sleep(5);
      check("[graceful/resend] sanity: stage-3 escalation called kill() (still not exited)", fake.isKilled === true && host.isAlive(SID) === true);

      const writesAtKill = fake.writes.length;
      // Wait past BOTH delayed resend timers with margin, while `live.alive` is deliberately still true
      // (exit not fired yet) — exactly the window the pre-fix code could still write into.
      await sleep(500);

      check("[graceful/resend] THE FIX: neither delayed Ctrl-C resend reached the pty after kill", fake.writes.length === writesAtKill);
      check("[graceful/resend] THE FIX: neither delayed Ctrl-C resend threw", caught === null);
    } finally {
      process.off("uncaughtException", onUncaught);
    }

    fake.fireExit(0);
  }

  // ===== Trial 5 (card 5683c2e3): a SECOND stop() call — graceful, after an EARLIER HARD stop already
  // killed — must not let its own immediate Ctrl-C write reach the already-killed pty. This is the exact
  // reachable shape: `alive` stays true through the kill()→exit window, so stop()'s only top-of-method
  // guard (`!live?.alive`) does not stop a second call from reaching the graceful branch's write.
  {
    const SID = "sess-second-stop-after-hard";
    const fake = spawnReady(SID);

    host.stop(SID, "hard"); // sets killed=true, calls kill() — no exit fired yet
    check("[second-stop/after-hard] sanity: killed but not yet exited (window is open)", fake.isKilled === true && host.isAlive(SID) === true);

    const writesAtKill = fake.writes.length;
    let threw = null;
    try { host.stop(SID, "graceful"); } catch (e) { threw = e; }
    check("[second-stop/after-hard] THE FIX: the second stop()'s own Ctrl-C write did not reach the pty", fake.writes.length === writesAtKill);
    check("[second-stop/after-hard] THE FIX: the second stop() did not throw", threw === null);

    fake.fireExit(0);
  }

  // ===== Trial 6 (card 5683c2e3): a SECOND stop() call — graceful, after THIS SESSION'S OWN
  // escalateGracefulStop stage-3 already killed it (no external hard stop involved at all) — same
  // unguarded write, reached via the OTHER kill() call site.
  {
    const SID = "sess-second-stop-after-escalation";
    const fake = spawnReady(SID);

    host.stop(SID, "graceful"); // first call: writes Ctrl-C, starts the escalation chain
    const firstWriteCount = fake.writes.length;
    check("[second-stop/after-escalation] positive control: the FIRST call's own write reached the pty", firstWriteCount > 0);

    const killDeadline = Date.now() + 5_000;
    // TIMING-GUARD-SAFE: fully-awaited-completion — polls for the POSITIVE, observable `fake.isKilled`
    // flip (stage 3's real kill()); the check right after runs the instant that poll observes it, with
    // no further await before it. `host.isAlive(SID)` holds by construction — `fake.fireExit` is not
    // called until after this trial's own checks.
    while (!fake.isKilled && Date.now() < killDeadline) await sleep(5);
    check("[second-stop/after-escalation] sanity: stage-3 escalation killed it (still not exited)", fake.isKilled === true && host.isAlive(SID) === true);

    const writesAtKill = fake.writes.length;
    let threw = null;
    try { host.stop(SID, "graceful"); } catch (e) { threw = e; } // SECOND call, same session, same mode
    check("[second-stop/after-escalation] THE FIX: the second stop()'s own Ctrl-C write did not reach the pty", fake.writes.length === writesAtKill);
    check("[second-stop/after-escalation] THE FIX: the second stop() did not throw", threw === null);

    fake.fireExit(0);
  }

  // ===== Trial 7 (card 5683c2e3, DoD-4): a genuine FIRST graceful stop of an IDLE session must still
  // write its Ctrl-C exactly as before the fix — `killed` is false on a first call, so the new guard at
  // host.ts:10149 is a no-op here. =====
  {
    const SID = "sess-first-stop-idle";
    const fake = spawnReady(SID); // idle: nothing enqueued, busy is false

    const before = fake.writes.length;
    host.stop(SID, "graceful");
    check("[first-stop/idle] a real first stop still writes its Ctrl-C (not suppressed)", fake.writes.length > before && fake.writes.some((w) => w.data === "\x03"));

    fake.fireExit(0);
    check("[first-stop/idle] session reads dead once exit lands", host.isAlive(SID) === false);
  }

  // ===== Trial 8 (card 5683c2e3, DoD-4): a genuine FIRST graceful stop of a BUSY/mid-turn session must
  // also still write its Ctrl-C interrupt — mirrors pty-stop-queue.mjs's busy-stop scenario, but here
  // specifically to prove the new `!live.killed` guard doesn't regress the busy path (killed is false on
  // a first call regardless of busy state). =====
  {
    const SID = "sess-first-stop-busy";
    const fake = spawnReady(SID);
    host.enqueueStdin(SID, "IN_FLIGHT_TURN"); // arms busy — a real turn in flight
    check("[first-stop/busy] setup: turn armed busy", host.isBusy(SID) === true);

    const before = fake.writes.length;
    host.stop(SID, "graceful");
    check("[first-stop/busy] a real first stop on a BUSY session still writes its Ctrl-C interrupt (not suppressed)", fake.writes.length > before && fake.writes.some((w) => w.data === "\x03"));
    check("[first-stop/busy] the interrupted turn stays alive (only the Stop hook / escalation ends it — unchanged)", host.isAlive(SID) === true);

    fake.fireExit(0);
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a write landing in the kill()→'exit' window (both the hard-stop and the graceful-escalation kill() call sites; both a viewer repaint and a raw human keystroke via writeStdin/writeChunked; and now a SECOND stop() call's own immediate Ctrl-C write, after either an earlier hard stop or this session's own escalation already killed it) no longer reaches the pty and no longer throws — Live.killed closes the race that used to crash the whole daemon on a destroyed-socket write, and a genuine FIRST stop (idle or busy) is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
