import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 176bdb0c — `stopCodex`'s intended graceful stop intermittently yields a non-zero exit on a REAL
// codex process (measured 2/13 ≈ 15.4%, method + evidence on that card). The mechanism is UNATTRIBUTED
// without a real-codex trial, and that trial is too underpowered to be worth spending real codex turns on
// (see the card: a perfect result at n=13/arm would still only reach p≈0.24). Per the manager's approved
// plan, this test builds the INSTRUMENT the eventual real sighting (in an ordinary merge gate, at no extra
// cost) will need to actually attribute a cause — a scripted fake-pty test needs no real codex and cannot
// itself resolve the mechanism, but it CAN prove the instrument reports correctly, which no real trial can
// substitute for (a correct instrument reading a wrong number is still useless).
//
// WHAT THIS COVERS: `stopCodex`'s new `secondSigintWrittenAt` diagnostic (host.ts) and the
// `codexStopDiag`/`signal` fields `PtyHostEvents.onExit` now carries — that they are computed correctly
// for the two structurally distinct shapes `stopCodex` can produce:
//   (A) codex exits from the FIRST `\x03` alone, before the second is ever due — `secondSigintWrittenAt`
//       must stay null and `codexStopDiag` must read `{secondSigintSent:false, msSinceSecondSigint:null}`.
//   (B) codex stays alive past `CODEX_STOP_GAP_MS`, the second `\x03` is actually written, and codex exits
//       some time after that — `codexStopDiag` must read `{secondSigintSent:true, msSinceSecondSigint:N}`
//       with N a small non-negative number.
// NOT covered here (cannot be, without a real codex process): WHY a real graceful stop sometimes returns
// non-zero. That is exactly the question this instrument exists to help answer on the NEXT real sighting,
// not something a fake pty can determine.
//
// TECHNIQUE: mirrors codex-queue-state-machine.mjs's established fake `createCodexPty()` override — a
// scripted fake pty drives the REAL `spawnCodexProcess`/`stopCodex`/`onExit` production code, never a real
// codex process. `LOOM_CODEX_STOP_GAP_MS` (this card's new env override, mirroring
// `LOOM_GRACEFUL_KILL_MS`'s convention) shrinks the gap so (B) stays fast without a blind sleep — the
// actual write is awaited via `waitUntil` (poll for the real state: the second `\x03` landing in the fake
// pty's own `writes` array), never guessed at.
//
// (A) is NOT a fixed-wait negative assertion (the shape `fixed-wait-negative-guard.mjs` polices): the fake
// pty's exit is fired SYNCHRONOUSLY, in the same tick as `stop()`, which is strictly before a real
// `setTimeout(..., CODEX_STOP_GAP_MS)` timer can ever fire (a macrotask cannot preempt already-queued
// synchronous/microtask work) — so "the second \x03 was never written" is proven by ORDERING, not by
// racing a clock and hoping nothing showed up in time.
process.env.LOOM_CODEX_STOP_GAP_MS = "30";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TMP = mkdtempManaged("loom-codex-stop-diag-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await import("../dist/pty/host.js");

/** A fake, fully-scripted codex pty — mirrors codex-queue-state-machine.mjs's `makeFakePty`, plus a
 *  `simulateExit` helper this file needs that that one doesn't: THAT file only ever needed `kill()`
 *  (a Loom-initiated hard stop); this file needs to simulate codex exiting ON ITS OWN, which a graceful
 *  stop's own two-Ctrl+C sequence never triggers via `kill()`. */
function makeFakePty() {
  let onExitCb = null;
  const writes = [];
  return {
    pid: 5151,
    write(data) { writes.push(data); },
    onData() { return { dispose() {} }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    // test-only, not part of the real IPty surface:
    simulateExit(exitCode, signal) { const cb = onExitCb; cb?.({ exitCode, signal }); },
    writes,
  };
}

class FakeCodexHost extends PtyHost {
  constructor(events) {
    super(events);
    this.fakeCodexPtys = new Map();
  }
  createCodexPty(opts) {
    const fake = makeFakePty();
    this.fakeCodexPtys.set(opts.sessionId, fake);
    return fake;
  }
}

const exitEvents = [];
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onCodexBootStuck() {},
  onExit(sessionId, code, info) { exitEvents.push({ sessionId, code, info }); },
};
const host = new FakeCodexHost(events);

function spawnReadySession(sessionId) {
  host.spawn({
    sessionId, cwd: "/fake/codex/worktree", permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: "worker", harness: "codex", startupPrompt: undefined,
  });
  const fakePty = host.fakeCodexPtys.get(sessionId);
  // Latch bootReady directly — this file is testing the STOP path, not boot detection (already covered by
  // codex-queue-state-machine.mjs); no kickoff is queued here so bootReady's own gating is irrelevant to
  // what's under test.
  host.liveCodex.get(sessionId).bootReady = true;
  return fakePty;
}

// --- (A): codex exits from the FIRST \x03 alone — the second is never due. -------------------------
const SESSION_A = "codex-stop-diag-fast-exit";
const fakePtyA = spawnReadySession(SESSION_A);
host.stop(SESSION_A, "graceful");
check("(A) the first \\x03 was written", fakePtyA.writes.length === 1 && fakePtyA.writes[0] === "\x03");
// Synchronous — strictly before the 30ms gap timer can fire (see the file header for why this isn't a
// fixed-wait negative assertion).
fakePtyA.simulateExit(0, undefined);
const exitA = exitEvents.find((e) => e.sessionId === SESSION_A);
check("(A) onExit fired exactly once, synchronously", exitEvents.filter((e) => e.sessionId === SESSION_A).length === 1);
check("(A) intended stop, code 0", exitA?.info.intended === true && exitA?.code === 0);
check("(A) codexStopDiag reports the second \\x03 was NEVER sent", exitA?.info.codexStopDiag?.secondSigintSent === false);
check("(A) msSinceSecondSigint is null when the second \\x03 was never sent", exitA?.info.codexStopDiag?.msSinceSecondSigint === null);
check("(A) still exactly one write total — the pending gap-timer callback has nothing left to send against", fakePtyA.writes.length === 1);

// --- (B): codex stays alive past the gap; the second \x03 IS written; codex exits some time after. --
const SESSION_B = "codex-stop-diag-second-sigint";
const fakePtyB = spawnReadySession(SESSION_B);
host.stop(SESSION_B, "graceful");
check("(B) the first \\x03 was written immediately", fakePtyB.writes.length === 1);
await waitUntil(() => fakePtyB.writes.length === 2, { label: "the second \\x03 to be written past CODEX_STOP_GAP_MS" });
check("(B) both writes are \\x03", fakePtyB.writes.every((w) => w === "\x03"));
// `simulateExit` fires the fake pty's onExit callback SYNCHRONOUSLY — this is a controlled action, not
// something we're waiting to observe, so there is no real duration to pace against here and no wait
// belongs in this test. Whatever real wall-clock time elapsed since the second \x03 write (above) is
// exactly what `msSinceSecondSigint` measures — asserted as "a small number", never a guessed exact one.
fakePtyB.simulateExit(1, undefined); // the shape this card cares about: intended stop, still-non-clean exit
const exitB = exitEvents.find((e) => e.sessionId === SESSION_B);
check("(B) intended stop, exit code 1 (the shape this card is instrumenting)", exitB?.info.intended === true && exitB?.code === 1);
check("(B) codexStopDiag reports the second \\x03 WAS sent", exitB?.info.codexStopDiag?.secondSigintSent === true);
check("(B) msSinceSecondSigint is a small elapsed number", typeof exitB?.info.codexStopDiag?.msSinceSecondSigint === "number" && exitB.info.codexStopDiag.msSinceSecondSigint >= 0 && exitB.info.codexStopDiag.msSinceSecondSigint < 5000);

// --- platform check, recorded as data (per the manager's instruction) — NOT asserted as a hard failure,
// since it is a property of node-pty's own windowsTerminal.ts (confirmed by reading that source: it calls
// `this.emit('exit', this._agent.exitCode)` with a SINGLE argument, so the `(exitCode, signal) => ...`
// listener in terminal.ts never receives a second one), not of anything this card's code controls. This
// fake pty mirrors that exact platform behavior (never passes a `signal` to `simulateExit`, matching every
// call site above) rather than fabricating a `signal` value real conpty could never actually produce.
console.log(`[info] signal on this fake-pty harness (mirroring this project's real win32/conpty behavior): A=${exitA?.info.signal} B=${exitB?.info.signal}`);
check("signal is threaded through (undefined here, matching this project's own win32/conpty platform — see PtyHostEvents.onExit's own doc)", exitA?.info.signal === undefined && exitB?.info.signal === undefined);

await finishAndExit(failures === 0 ? 0 : 1);
