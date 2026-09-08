import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7c2a6dc0 (Code Reviewer `eb34f405`'s codex-surface audit) — nothing in the codex path could
// cancel an in-flight submit/confirm ladder on stop or redirect. Two concrete bugs, both reproduced here
// against the REAL `stopCodex`/`interruptForRedirectCodex`/`submitCodex`/`armCodexBusyStaleTimer` code
// under scripted chunks (never a real codex process — mirrors `codex-submit-confirmation-gap.mjs`'s own
// fake-pty technique):
//
// SCENARIO A — a deliberate graceful stop must neutralize the confirm-or-retry ladder, INCLUDING a fresh
// re-arm from output seen DURING the stopping window (not just an already-armed timer at stop-time): before
// this card, `stopCodex` left `busyStaleTimer`/`busyStaleGen` untouched, so CASE 3 could write a stray
// "\r" into a session being deliberately stopped, and CASE 2/4 could drain a queued message or fire a
// false "manager intervention needed" nudge for a worker the manager just stopped.
//
// SCENARIO B — a redirect landing inside `submitCodex`'s own `CODEX_SUBMIT_ENTER_DELAY_MS` text->\r gap
// used to let the delayed "\r" land AFTER the interrupt, corrupting `enterWrittenAt` and eventually pinning
// `busy` true forever — so the redirect's own newly-queued message could never drain. This drives that
// exact race and asserts the queued message drains immediately instead.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-stop-redirect-cancel-ladder.mjs
process.env.LOOM_CODEX_SUBMIT_ENTER_DELAY_MS = "60";
process.env.LOOM_CODEX_BUSY_STALE_MS = "40";
process.env.LOOM_CODEX_STOP_GAP_MS = "150";
process.env.LOOM_GRACEFUL_KILL_MS = "300"; // GRACEFUL_STOP_KILL_MS's own env — see host.ts's LOOM_GRACEFUL_KILL_MS convention
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil, sleepPast } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const BUSY_STALE_MS = 40;
const ENTER_DELAY_MS = 60;
const GRACEFUL_KILL_MS = 300;

const TMP = mkdtempManaged("loom-codex-stop-redirect-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await import("../dist/pty/host.js");

/** Same fake, fully-scripted codex pty as `codex-queue-state-machine.mjs`/`codex-submit-confirmation-gap.mjs`
 *  — no real process, no OS I/O; every "chunk" of output is pushed by this test calling `fakePty.push(...)`
 *  directly, and `kill()` fires `onExit` synchronously (mirrors a real conpty kill's eventual 'exit'). */
function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  const writes = [];
  return {
    pid: 5252,
    write(data) { writes.push(data); },
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    push(text) { onDataCb?.(text); },
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

const busyEvents = [];
const unconfirmedEvents = [];
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {},
  onBusy(sessionId, busy) { busyEvents.push({ sessionId, busy }); },
  onExit() {},
  onCodexSubmitUnconfirmed(sessionId, info) { unconfirmedEvents.push({ sessionId, ...info }); },
};
const host = new FakeCodexHost(events);

// === SCENARIO A: graceful stop neutralizes the ladder — including a FRESH re-arm mid-stop ===============
const SESSION_A = "codex-stop-cancel-a";
host.spawn({
  sessionId: SESSION_A, cwd: "/fake/codex/worktree", permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: "worker", harness: "codex",
});
const fakeA = host.fakeCodexPtys.get(SESSION_A);
const liveA = () => host.liveCodex.get(SESSION_A);

fakeA.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
check("A: boot readiness latched before the scenario begins", liveA().bootReady === true);

const enqA = host.enqueueStdin(SESSION_A, "message one", "system", undefined, undefined, "agent");
check("A: message one delivers immediately (idle at enqueue time)", enqA.delivered === true);
await waitUntil(() => liveA().enterPending === false, { label: "A: message one's own Enter write has actually happened" });
check("A: message one's own busy-stale timer is armed (a real, live timer exists to be neutralized)", liveA().busyStaleTimer !== null);
check("A: message one's text + Enter were both written before the stop", fakeA.writes.some((w) => w.includes("message one")) && fakeA.writes.includes("\r"));

// The stop itself — graceful mode, mirrors a manager's ordinary worker_stop. This itself writes the
// FIRST "\x03" synchronously (stopCodex's own legitimate write, not a stray retry) — capture the write
// count AFTER this call, not before, so the checks below isolate what the mid-stop re-arm does, not what
// the stop sequence itself legitimately writes.
host.stop(SESSION_A, "graceful");
// SYNCHRONOUS proof (not timing-dependent) that stopCodex's own neutralization ran: the timer that was
// armed above is cleared THE INSTANT stop() returns, not merely "eventually superseded".
check("A: SYNCHRONOUS — stopCodex cleared the already-armed busy-stale timer immediately", liveA().busyStaleTimer === null);
check("A: stopping is now true", liveA().stopping === true);
check("A: stopCodex's own first Ctrl+C was written", fakeA.writes.includes("\x03"));
const writesAfterStopA = fakeA.writes.length;

// Simulate stray output arriving DURING the graceful stop's own multi-stage window (codex echoing its own
// interrupt handling before it actually exits) — this is exactly the shape `armCodexBusyStaleTimer`'s own
// CASE-1 generation check CANNOT catch on its own: onData's marker-sighting arm is UNCONDITIONAL, so it
// mints a FRESH, validly-generationed timer regardless of `stopping`. Only an explicit `stopping` check
// inside the fired callback itself can stop this fresh arm from acting.
fakeA.push("Working (1s • esc to interrupt)\n");
check("A: a busy marker seen mid-stop DOES re-arm a fresh timer (proves the next check is real, not vacuous)", liveA().busyStaleTimer !== null);

// Wait past that fresh timer's own busy-stale window (a known, bounded delay — not a guess about an
// unrelated operation), but SHORT of stopCodex's own second-Ctrl+C schedule (CODEX_STOP_GAP_MS=150ms >
// BUSY_STALE_MS*3=120ms), so the only thing that COULD have written in this window is the mid-stop re-arm
// under test — then confirm it did NOTHING: no drain, no idle notify, no stray retry write, no false
// "manager intervention needed".
await sleepPast(BUSY_STALE_MS * 3, BUSY_STALE_MS, "A: past the fresh mid-stop timer's own busy-stale window");
check("A: FIX CONTRACT — no onBusy(false) fired from the mid-stop re-arm (CASE 2 must not fire while stopping)", !busyEvents.some((e) => e.sessionId === SESSION_A && e.busy === false));
check("A: FIX CONTRACT — no stray retry \"\\r\" (or any other write) happened from the mid-stop re-arm (CASE 3 must not fire while stopping)", fakeA.writes.length === writesAfterStopA && fakeA.writes.filter((w) => w === "\r").length === 1);
check("A: FIX CONTRACT — onCodexSubmitUnconfirmed never fired (CASE 4 must not fire while stopping)", !unconfirmedEvents.some((e) => e.sessionId === SESSION_A));
check("A: busy is still true — the mid-stop re-arm's fire genuinely no-opped, it did not drain", host.isBusy(SESSION_A) === true);

// Let the whole graceful-stop sequence actually complete (the SAME backstop kill this file's own constants
// bound) — a real, deterministic completion signal, not a blind guess about how long stop() takes.
await waitUntil(() => liveA().alive === false, { label: "A: the graceful-stop sequence's own backstop kill eventually exits the session", timeoutMs: GRACEFUL_KILL_MS + 2000 });
check("A: FINAL — no additional bare-Enter retry was EVER written across the whole stop sequence", fakeA.writes.filter((w) => w === "\r").length === 1);
check("A: FINAL — onCodexSubmitUnconfirmed never fired across the whole stop sequence", !unconfirmedEvents.some((e) => e.sessionId === SESSION_A));

// === SCENARIO B: a redirect landing in submitCodex's own enterPending gap must not deadlock ==============
const SESSION_B = "codex-stop-cancel-b";
host.spawn({
  sessionId: SESSION_B, cwd: "/fake/codex/worktree", permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: "worker", harness: "codex",
});
const fakeB = host.fakeCodexPtys.get(SESSION_B);
const liveB = () => host.liveCodex.get(SESSION_B);

fakeB.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
check("B: boot readiness latched before the scenario begins", liveB().bootReady === true);

const enqAlpha = host.enqueueStdin(SESSION_B, "alpha (about to be redirected)", "system", undefined, undefined, "agent");
check("B: alpha delivers immediately (idle at enqueue time)", enqAlpha.delivered === true);
// SYNCHRONOUS — still inside submitCodex's own CODEX_SUBMIT_ENTER_DELAY_MS gap (the delayed Enter write
// has not fired yet; ENTER_DELAY_MS is generous enough that nothing async has had a chance to run).
check("B: PRECONDITION — alpha's own Enter write is still pending (inside the gap)", liveB().enterPending === true);
check("B: alpha's text was written, but NOT yet its Enter", fakeB.writes.includes("alpha (about to be redirected)") && !fakeB.writes.includes("\r"));

const enqBeta = host.enqueueStdin(SESSION_B, "beta (queued behind alpha)", "system", undefined, undefined, "agent");
check("B: beta queues behind alpha (still busy)", enqBeta.queued === true && enqBeta.delivered !== true);

// The redirect interrupt — landing INSIDE alpha's own enterPending gap, exactly the race the card names.
host.interruptForRedirect(SESSION_B);
check("B: Ctrl+C was written by the redirect", fakeB.writes.includes("\x03"));
// FIX CONTRACT: no busy marker was ever seen for alpha's turn and no timer exists to ever go stale on its
// own — before this card, nothing would ever flip busy back to false here, so beta would never drain.
// interruptForRedirectCodex's own enterPending branch must declare the turn over and drain SYNCHRONOUSLY.
check("B: FIX CONTRACT — beta drained SYNCHRONOUSLY (no deadlock waiting for a marker that will never come)", fakeB.writes.includes("beta (queued behind alpha)"));
check("B: beta is now the live turn (busy true again, from beta's own submitCodex call)", host.isBusy(SESSION_B) === true);
check("B: the pending queue is now empty — beta was actually shifted out, not left stuck", host.getPending(SESSION_B).length === 0);

// alpha's own delayed closure is still scheduled (it was never cancelled, only invalidated) — let it fire
// and confirm it wrote NOTHING: proving the busyStaleGen mismatch check actually suppressed the stray
// write, not merely that the write "hasn't happened yet".
await waitUntil(() => liveB().enterPending === false, { label: "B: beta's OWN Enter write has happened" });
const enterCountAfterBeta = fakeB.writes.filter((w) => w === "\r").length;
check("B: exactly one real Enter has landed so far (beta's own — alpha's was cancelled, not merely delayed)", enterCountAfterBeta === 1);
// Confirm beta's OWN turn with a real busy marker before the wait below — otherwise beta's own healthy
// confirm-or-retry ladder (a SEPARATE, correct mechanism this file isn't testing) would itself write more
// bare Enters once ITS OWN busy-stale window elapses, which would corrupt the "nothing new landed" count
// below with unrelated, legitimate noise.
fakeB.push("Working (1s • esc to interrupt)\n");
await sleepPast(ENTER_DELAY_MS * 3, ENTER_DELAY_MS, "B: past alpha's original (cancelled) Enter-write delay");
check("B: FIX CONTRACT — alpha's cancelled Enter write never landed, even once its original delay fully elapsed", fakeB.writes.filter((w) => w === "\r").length === enterCountAfterBeta);
check("B: alpha's text was written exactly once (no duplicate/corruption from the race)", fakeB.writes.filter((w) => w === "alpha (about to be redirected)").length === 1);

// === SCENARIO C: redirect on the COMMON path — a genuinely busy turn whose own Enter already went out ===
// Code Review (post-b78db192, BLOCKING regression): clearing the busy-stale timer unconditionally on this
// path used to leave NOTHING that would ever drain the redirect — the timer that was cleared WAS the only
// thing that ever called `drainCodexPending` for this shape, `retryCodexEnter` needs a fired timer to run
// at all, and `submitCodex`'s own delayed closure needs a drain to even be scheduled. `busy` stayed pinned
// true forever: the exact hang this card exists to fix, moved onto the primary path `worker_redirect`
// actually targets (Scenario B above only covers the rarer `enterPending === true` gap-race). This drives
// the common shape directly: a real marker confirms the turn BEFORE the redirect fires, then — critically
// — NO further marker is ever pushed (codex's own busy marker is documented absent once idle, i.e. it
// stops the instant the Ctrl+C takes effect), so the only way this can ever drain is via a FRESH re-armed
// timer, never a leftover one.
const SESSION_C = "codex-stop-cancel-c";
host.spawn({
  sessionId: SESSION_C, cwd: "/fake/codex/worktree", permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: "worker", harness: "codex",
});
const fakeC = host.fakeCodexPtys.get(SESSION_C);
const liveC = () => host.liveCodex.get(SESSION_C);

fakeC.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
check("C: boot readiness latched before the scenario begins", liveC().bootReady === true);

const enqGamma = host.enqueueStdin(SESSION_C, "gamma (mid-turn, about to be redirected)", "system", undefined, undefined, "agent");
check("C: gamma delivers immediately (idle at enqueue time)", enqGamma.delivered === true);
await waitUntil(() => liveC().enterPending === false, { label: "C: gamma's own Enter write has actually happened" });
// A REAL marker confirms this turn is genuinely busy — the exact shape `worker_redirect` targets (NOT the
// enterPending gap-race Scenario B covers).
fakeC.push("Working (1s • esc to interrupt)\n");
const oldTimerC = liveC().busyStaleTimer;
check("C: PRECONDITION — gamma's own busy-stale timer is armed from the real marker", oldTimerC !== null);

const enqDelta = host.enqueueStdin(SESSION_C, "delta (queued behind gamma)", "system", undefined, undefined, "agent");
check("C: delta queues behind gamma (still busy)", enqDelta.queued === true && enqDelta.delivered !== true);

host.interruptForRedirect(SESSION_C);
check("C: Ctrl+C was written by the redirect", fakeC.writes.includes("\x03"));
check("C: SYNCHRONOUS — a FRESH timer was re-armed (not the one that was just cleared)", liveC().busyStaleTimer !== null && liveC().busyStaleTimer !== oldTimerC);
check("C: delta has NOT drained yet — it must wait for the busy->idle staleness edge, not fire synchronously", !fakeC.writes.includes("delta (queued behind gamma)"));

// FIX CONTRACT: no further marker is EVER pushed after this point (mirrors "codex's own busy marker stops
// the instant Ctrl+C takes effect") — the only route to drain is the freshly re-armed timer going stale.
// Wait for delta's OWN text to reach the pty specifically (NOT `isBusy() === false`: once delta drains it
// starts its OWN turn, and this test deliberately never feeds a marker for delta either, so delta's own
// separate, correctly-working confirm-or-retry ladder will eventually re-raise busy — that is unrelated
// healthy behavior this scenario isn't testing, and asserting on it would be a false read of this fix).
await waitUntil(() => fakeC.writes.includes("delta (queued behind gamma)"), {
  label: "C: FIX CONTRACT — delta actually REACHES THE PTY once the redirect's re-armed timer goes stale, with NO further marker ever seen (the regression: it never used to)",
  timeoutMs: 5000,
});
check("C: the pending queue is now empty", host.getPending(SESSION_C).length === 0);
check("C: gamma's own turn resolved via CASE 2 (confirmed) — exactly one real Enter (gamma's) landed before delta's own", fakeC.writes.filter((w) => w === "\r").length === 1);
check("C: no onCodexSubmitUnconfirmed fired for gamma's own turn (the one this scenario is actually testing)", !unconfirmedEvents.some((e) => e.sessionId === SESSION_C));

console.log(failures === 0
  ? "\n✅ ALL PASS — card 7c2a6dc0 (+ follow-up): a graceful stop neutralizes codex's confirm-or-retry ladder including a fresh re-arm mid-stop (Scenario A); a redirect landing inside submitCodex's own enterPending gap declares the turn over and drains immediately instead of deadlocking (Scenario B); and a redirect on the COMMON busy-turn path re-arms a fresh staleness timer so the redirect still actually reaches the pty instead of pinning busy true forever (Scenario C)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
