import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fedef6a0 (split from 887e10b8 DoD-1) — the state-machine gap this card fixed: `submitCodex`
// (pty/host.ts) used to write `text` then `"\r"` with NO confirming signal that codex ever registered
// either write. `armCodexBusyStaleTimer` used to decide "idle" from the mere ABSENCE of a fresh busy-marker
// sighting — never from any positive confirmation that the Enter landed — and `drainCodexPending` would
// then write the NEXT queued message on that same (unconfirmed) basis.
//
// REAL-WORLD PRECONDITION THIS MIRRORS (not hypothetical — see the card body + project memory
// `codex-transcript-harness-dispatch-and-engine-id-capture`): this host's real `~/.codex/config.toml`
// carries extra plugin/marketplace MCP servers, so an MCP-startup episode can swallow a submit's keystrokes
// entirely — zero busy-marker sighting ever renders for that turn, and the composer is left holding the
// UNSENT text. Scenario A below drives that exact shape.
//
// TECHNIQUE (mirrors `codex-queue-state-machine.mjs`): a fake `createCodexPty()` override drives the REAL
// `spawnCodexProcess`/`submitCodex`/`retryCodexEnter`/`enqueueStdinCodex`/`drainCodexPending`/
// `armCodexBusyStaleTimer` code under scripted chunks, never a real codex process. `LOOM_CODEX_BUSY_STALE_MS`/
// `LOOM_CODEX_SUBMIT_ENTER_DELAY_MS`/`LOOM_CODEX_SUBMIT_MAX_RETRIES` shrink/pin the relevant constants so
// this stays fast and hermetic; the real async waits (the staleness timer, the delayed Enter write) are
// observed via `waitUntil` (poll for real state), never a blind sleep.
//
// CAUSALITY (see `codex-queue-state-machine.mjs`'s own note, same discipline here): `submitCodex`'s real
// Enter write is a REAL setTimeout — a marker pushed before it fires predates `enterWrittenAt` and is
// correctly ignored by `armCodexBusyStaleTimer`'s CASE 0, exactly as a real codex TUI could never render a
// marker before the Enter that caused it was actually sent. Every scenario below waits for
// `host.liveCodex.get(SESSION_ID).enterPending === false` before pushing a marker meant to confirm a turn.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-submit-confirmation-gap.mjs
process.env.LOOM_CODEX_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_CODEX_BUSY_STALE_MS = "300";
process.env.LOOM_CODEX_SUBMIT_MAX_RETRIES = "2"; // pinned explicitly — this file's assertions count exact retries
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const MAX_RETRIES = 2;

const TMP = mkdtempManaged("loom-codex-submit-confirm-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await import("../dist/pty/host.js");

/** Same fake, fully-scripted codex pty as `codex-queue-state-machine.mjs` — no real process, no OS I/O;
 *  every "chunk" of output is pushed by this test calling `fakePty.push(text)` directly. */
function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  const writes = [];
  return {
    pid: 5151,
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

const SESSION_ID = "codex-submit-confirm-test";
host.spawn({
  sessionId: SESSION_ID, cwd: "/fake/codex/worktree", permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: "worker", harness: "codex",
  // No startupPrompt — this scenario is about an ORDINARY mid-session message (drainCodexPending's own
  // call site, exactly as much in scope as the kickoff per the card body's "not kickoff-specific" point),
  // so nothing here needs the ready-marker gate.
});
const fakePty = host.fakeCodexPtys.get(SESSION_ID);
const live = () => host.liveCodex.get(SESSION_ID);

// Card 448f1b4a: enqueueStdinCodex now structurally gates every submit on live.bootReady (ready marker +
// model-loaded + trust-dialog-resolved) — this file's own scenarios are about the CONFIRM-OR-RETRY ladder,
// a DIFFERENT defect (see this file's own header), so get the session past boot readiness first with an
// ordinary ready+model frame before any of them begin. No startupPrompt was supplied (this test's own
// "ordinary mid-session message" framing), so the boot-ready transition drains an (empty) queue rather than
// delivering a kickoff — a genuine no-op here, not a hidden dependency on kickoff wiring.
fakePty.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
check("(preamble) boot readiness latched before any confirm-or-retry scenario begins", live().bootReady === true);
check("(preamble) nothing was written by the boot-ready transition itself (no startupPrompt, empty queue)", fakePty.writes.length === 0);

// === SCENARIO A: the swallowed-keystroke race — exhausts retries, NEVER drains, reports up ==============
// message one delivers immediately (idle at enqueue time).
const enq1 = host.enqueueStdin(SESSION_ID, "message one", "system", undefined, undefined, "agent");
check("A: message one delivers immediately (idle at enqueue time)", enq1.delivered === true);
check("A: submitCodex armed busy synchronously for message one", host.isBusy(SESSION_ID) === true);
await waitUntil(() => live().enterPending === false, { label: "A: message one's own Enter write has actually happened" });
check("A: message one's text + Enter were both written", fakePty.writes.some((w) => w.includes("message one")) && fakePty.writes.includes("\r"));

// The precondition this reproduces: codex's MCP-startup episode (or any other reason) swallows the
// keystrokes entirely — NOT ONE busy-marker chunk ever renders for this turn. No `fakePty.push(...)` call
// happens here at all; this is deliberate, not an omission.
const enq2 = host.enqueueStdin(SESSION_ID, "message two", "system", undefined, undefined, "agent");
check("A: message two queues behind message one (still busy)", enq2.queued === true && enq2.delivered !== true);
check("A: message two's text has NOT been written yet", !fakePty.writes.some((w) => w.includes("message two")));

// Let the retry ladder exhaust — CODEX_SUBMIT_MAX_RETRIES retries, each waiting a full CODEX_BUSY_STALE_MS
// window with zero fresher busy-marker sighting. Observed via the retry counter itself (real state), not a
// blind sleep guessed to outlast `(MAX_RETRIES + 1) * CODEX_BUSY_STALE_MS`.
await waitUntil(() => live().submitConfirmAttempts >= MAX_RETRIES, {
  label: `A: the retry ladder reaches its ${MAX_RETRIES}-attempt cap`,
  timeoutMs: 10_000,
});
check("A: exactly MAX_RETRIES bare Enter retries were written (never re-typing the text)", fakePty.writes.filter((w) => w === "\r").length === MAX_RETRIES + 1); // +1 for the original Enter

// Give the LAST retry's own staleness window a chance to fire and reach exhaustion (CASE 4).
await waitUntil(() => unconfirmedEvents.some((e) => e.sessionId === SESSION_ID), {
  label: "A: onCodexSubmitUnconfirmed fires once the ladder is genuinely exhausted",
  timeoutMs: 5_000,
});
check("A: the fired event names the exact attempt/cap the card requires managers to see", unconfirmedEvents.at(-1).attempts === MAX_RETRIES && unconfirmedEvents.at(-1).maxAttempts === MAX_RETRIES);

// 🔴 THE CORE DoD-3 ASSERTION: message two must NEVER be drained on top of message one's unconfirmed turn.
check(
  "A: FIX CONTRACT (DoD-3): message two was never drained while message one's delivery was never confirmed",
  !fakePty.writes.some((w) => w.includes("message two")),
);
check("A: busy stays true (frozen) so the pending queue can never be force-drained on top of this", host.isBusy(SESSION_ID) === true);
check("A: message two is still sitting in pending, untouched", host.getPending(SESSION_ID).length === 1);

// Prove "stuck", not merely "hasn't happened yet" — WITHOUT a fixed sleep guarding a negative assertion
// (this project's own fixed-wait-negative-guard correctly flags that shape: a timer that expires before a
// bad thing happens is indistinguishable from it never happening at all). The OBSERVABLE, deterministic
// proof of "genuinely stopped, nothing scheduled" is CASE 4's own state: it returns without ever re-arming
// `busyStaleTimer` (see `armCodexBusyStaleTimer`'s own doc) — so `busyStaleTimer === null` right after
// exhaustion IS the terminal state itself, not an inference from elapsed time.
check("A: no staleness timer is armed after exhaustion — nothing is even SCHEDULED to drain later, a stronger proof than a timed wait", live().busyStaleTimer === null);

// === SCENARIO B: healthy-but-slow — a late marker still confirms normally, no drain corruption ==========
// Manager's Correction 2: removing the old optimistic `lastBusyMarkerAt` stamp must not turn an ordinary,
// merely-SLOW-to-render turn into a false "stuck". Codex can genuinely take longer than one
// CODEX_BUSY_STALE_MS window to show its first marker (this host's own real `~/.codex/config.toml` MCP-
// startup episode) — the retry ladder WILL fire at least one spurious extra Enter in that case (a disclosed,
// unverified risk — see `armCodexBusyStaleTimer`'s own doc), but once a real marker DOES arrive, before
// exhaustion, the turn must still resolve normally and the queue must not be corrupted (a subsequent message
// must drain exactly once, never twice, from the earlier spurious retry).
//
// Recover session A first: feed message two's own real marker so its turn (still pending from Scenario A)
// resolves and drains — establishing a clean idle baseline before Scenario B starts.
fakePty.push("Working (1s • esc to interrupt)\n");
await waitUntil(() => fakePty.writes.some((w) => w.includes("message two")), { label: "A cleanup: message two finally drains once its predecessor is confirmed by a late marker" });
await waitUntil(() => live().enterPending === false, { label: "A cleanup: message two's own Enter write has happened" });
fakePty.push("Working (1s • esc to interrupt)\n");
await waitUntil(() => host.isBusy(SESSION_ID) === false, { label: "A cleanup: message two's own turn goes idle" });

const writesBeforeAlpha = fakePty.writes.length; // Scenario B counts are scoped from HERE, not from file start (Scenario A already wrote several "\r"s)
const enqA = host.enqueueStdin(SESSION_ID, "message alpha (slow render)", "system", undefined, undefined, "agent");
check("B: message alpha delivers immediately (idle at enqueue time)", enqA.delivered === true);
await waitUntil(() => live().enterPending === false, { label: "B: message alpha's own Enter write has actually happened" });

// NO marker fed yet — let ONE retry fire (simulating a slow-to-render, but genuinely healthy, turn).
await waitUntil(() => live().submitConfirmAttempts >= 1, { label: "B: one spurious retry fires while codex is merely slow" });
const writesAtOneRetry = fakePty.writes.length;
check("B: exactly one extra bare Enter was written by the retry (never re-typing the text)", fakePty.writes.slice(writesBeforeAlpha).filter((w) => w === "\r").length === 2); // original + 1 retry

// NOW the real marker arrives (codex was just slow, not lost) — must confirm normally, not exhaust further.
await waitUntil(() => live().enterPending === false, { label: "B: the retry's own Enter write has happened before pushing the confirming marker" });
fakePty.push("Working (1s • esc to interrupt)\n");
await waitUntil(() => host.isBusy(SESSION_ID) === false, { label: "B: message alpha's turn resolves normally once the late marker confirms it" });
check("B: no further retries fired after the late marker confirmed the turn (still exactly one)", fakePty.writes.slice(writesBeforeAlpha).filter((w) => w === "\r").length === 2);
check("B: no onCodexSubmitUnconfirmed fired for message alpha — the late marker rescued it before exhaustion", unconfirmedEvents.length === 1); // still just Scenario A's one event
check("B: no stray write happened between the retry and the confirming marker", fakePty.writes.length === writesAtOneRetry);

// Queue integrity after a spurious retry: message beta must drain exactly ONCE, never twice/duplicated.
const writesBeforeBeta = fakePty.writes.length;
const enqB = host.enqueueStdin(SESSION_ID, "message beta (after a spurious retry)", "system", undefined, undefined, "agent");
check("B: message beta delivers immediately (queue not corrupted by the earlier spurious retry)", enqB.delivered === true);
check("B: message beta's text was written exactly once", fakePty.writes.slice(writesBeforeBeta).filter((w) => w.includes("message beta")).length === 1);

console.log(failures === 0
  ? "\n✅ ALL PASS — submitCodex's confirm-or-retry-or-fail-loud ladder (card fedef6a0): the swallowed-keystroke case exhausts, freezes the queue, and reports up (Scenario A); an ordinary slow-to-render turn still confirms normally with no queue corruption (Scenario B)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
