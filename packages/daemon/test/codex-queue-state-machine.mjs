import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 353f6dc4 (multi-harness epic df1f94b0 Phase 1) — Code Review T1: "ZERO tests exist for
// enqueueStdinCodex/submitCodex/drainCodexPending/setCodexBusy — the entire queue/turn state machine,
// i.e. exactly what C2/M3/M9 break. A scripted fake-pty onData sequence needs no real codex and would
// have caught C2 and M3." This is that test.
//
// TECHNIQUE: a fake `createCodexPty()` override (mirrors `_seam-host-fixture.mjs`'s established pattern
// for claude's `createPty`) drives the REAL `spawnCodexProcess` onData handler — including the busy/idle
// detection, trust-dialog gating, and kickoff-delivery logic under review — with SCRIPTED chunks, never a
// real codex process. `LOOM_CODEX_BUSY_STALE_MS` shrinks the freshness-timeout constant (mirrors
// `LOOM_GRACEFUL_KILL_MS`'s own test-shrink convention) so this stays fast and hermetic — genuine async
// timer waits are observed via `waitUntil` (poll for real state), never a blind sleep.
//
// RED-BEFORE-GREEN (this project's own standing verification posture): every scenario below was run
// against the PRE-FIX onData handler first (busy recomputed per-chunk, no freshness timer, reconcile()
// never touching `liveCodex`, writeStdin reading only `this.live`) via a temporary `git checkout HEAD --
// <file>` + re-build, confirmed FAILING for exactly the reasons named in each check's own label, then
// restored via `git apply` of the captured diff — see the worker report for the exact commands used.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-queue-state-machine.mjs
//
// Card fedef6a0: `armCodexBusyStaleTimer`'s confirm-or-retry ladder (see its own doc) needs a real,
// nonzero gap between "text written" and "Enter written" to exist BEFORE a confirming marker can be pushed
// (a marker pushed before the real Enter write predates `enterWrittenAt` and is correctly ignored — see
// each scenario's own "CAUSALITY" comment below) — `LOOM_CODEX_SUBMIT_ENTER_DELAY_MS` shrinks that gap
// from production's 300ms so this stays fast. `LOOM_CODEX_BUSY_STALE_MS` is kept comfortably larger than
// both that gap AND `waitUntil`'s own poll interval (10ms) — a value as tight as the two constants used to
// share (40ms) left too little margin for a confirming push's own re-arm to land before the PRIOR timer
// (armed at the real Enter write) already fired a spurious retry, flaking this file under ordinary
// scheduling jitter. Both are read once at module load below — must be set BEFORE the dynamic import.
process.env.LOOM_CODEX_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_CODEX_BUSY_STALE_MS = "300";
// Card 448f1b4a: shrinks live.bootReady's fail-loud ceiling so the R4 "boot never completes" scenario
// below doesn't need a real ~45s wait. Every OTHER scenario in this file pushes its ready+model-loaded
// frame synchronously (in the same tick as the spawn, well under 200ms of real wall-clock time), so this
// shrink cannot spuriously fire against them.
process.env.LOOM_CODEX_BOOT_READY_TIMEOUT_MS = "200";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TMP = mkdtempManaged("loom-codex-queue-sm-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await import("../dist/pty/host.js");

/** A fake, fully-scripted codex pty: no real process, no OS-driven I/O — every "chunk" of output is
 *  pushed by this test calling `fakePty.push(text)` directly. The only REAL async in this file is the
 *  freshness timer itself (shrunk to 40ms above), awaited via `waitUntil`, never a blind sleep. */
function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  const writes = [];
  return {
    pid: 5150,
    write(data) { writes.push(data); },
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    // test-only helpers, not part of the real IPty surface:
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
const bootStuckEvents = [];
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {},
  onBusy(sessionId, busy) { busyEvents.push({ sessionId, busy }); },
  onCodexBootStuck(sessionId, info) { bootStuckEvents.push({ sessionId, info }); },
  onExit() {},
};
const host = new FakeCodexHost(events);

const SESSION_ID = "codex-queue-sm-test";
const KICKOFF = "do the assigned task";
host.spawn({
  sessionId: SESSION_ID, cwd: "/fake/codex/worktree", permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: "worker", harness: "codex", startupPrompt: KICKOFF,
});
const fakePty = host.fakeCodexPtys.get(SESSION_ID);

// --- R1/R2: card 448f1b4a — the ready placeholder ALONE (model still "loading") must NOT be read as
// boot-readiness, and a message enqueued during that window must QUEUE rather than write straight into
// the not-yet-ready TUI — even though live.busy is false and there's nothing else gating it the old way.
// BYTE-EXACT (not a synthetic approximation): extracted from gate `43cd9ec1`'s own raw captured output
// (`~/.loom/gate-output/43cd9ec1-*.log`, `od -c`-verified real `\x1b` bytes) — codex styles the "model:"
// line's VALUE with its own CSI span (`\x1b[3m`italic-on/`\x1b[23m`italic-off around "loading"), which a
// manager review caught: an ANSI-stripped/hand-typed fixture cannot exercise `isCodexModelLoaded`'s real
// ANSI-strip path at all. This is the exact shape the card's own captured specimen showed (op 43cd9ec1):
// the ready placeholder rendered while the header still read "model: loading".
check("(pre-boot) nothing written to the codex pty yet", fakePty.writes.length === 0);
fakePty.push("OpenAI Codex (v1.2.3)\n      │ model:     \x1b[3mloading\x1b[23m   \x1b[38;5;6m\x1b[22m/model\x1b[m\x1b[2m to change                   │\x1b[22m\x1b[K\x1b[2m\r      ›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[22m\x1b[K\r");
check("R1: the ready placeholder ALONE (model still loading, REAL ANSI-laden bytes) does NOT latch boot readiness", host.liveCodex.get(SESSION_ID).bootReady === false);
check("R1: the kickoff is NOT delivered while the model is still loading (the card's own byte-exact false-ready specimen)", fakePty.writes.length === 0);
const enqDuringLoad = host.enqueueStdin(SESSION_ID, "sent while model still loading", "system", undefined, undefined, "agent");
check("R2: a message enqueued while bootReady is false QUEUES rather than writing straight into the not-yet-ready TUI (live.busy is false here — this is the structural gate, not a busy-flag side effect)", enqDuringLoad.queued === true && enqDuringLoad.delivered !== true);
check("R2: reconcile() must NOT drain a queue stranded behind !bootReady (the gap this card closed: reconcile()'s own drainCodexPending call bypassed the old busy-only gate)", (() => {
  const before = fakePty.writes.length;
  host.reconcile();
  return fakePty.writes.length === before;
})());

// R2's probe message is still sitting in live.pending (proven above it was never written) — the kickoff
// delivery below takes priority over it (matches the real onData branch: deliver the kickoff OR drain,
// never both on the same transition), so it would otherwise ride into the kickoff turn's own busy cycle
// and complicate the C1/C2 assertions below with a second real drain. It already did its job (proving R1/
// R2); clear it explicitly rather than let it leak into unrelated scenarios.
host.liveCodex.get(SESSION_ID).pending.length = 0;

// Now the model finishes resolving — boot readiness latches and the kickoff delivers.
fakePty.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
check("R3: boot readiness latches once the model has actually resolved", host.liveCodex.get(SESSION_ID).bootReady === true);
check("C1: the kickoff text was written to the codex pty once boot readiness latched", fakePty.writes.some((w) => w.includes(KICKOFF)));
check("C1: delivering the kickoff armed busy (submitCodex's own M1-mirroring invariant)", host.isBusy(SESSION_ID) === true);
check("R3: no boot-stuck report fired for a session that resolved well inside its own ceiling", bootStuckEvents.length === 0);

// A second ready-placeholder chunk must NOT re-deliver the kickoff (kickoffDelivered latches).
fakePty.push("> Ask Codex to do anything\n");
check("C1: the kickoff is never delivered twice (kickoffDelivered latches)", fakePty.writes.filter((w) => w.includes(KICKOFF)).length === 1);

// Card fedef6a0: a real busy-marker sighting CONFIRMS this turn (mirrors every real spawn per the probe —
// even a trivial one-word reply showed a "Working" frame, findings.md State 4) before it's allowed to go
// idle. Without this, "no marker ever fed" is now (correctly, post-fix) indistinguishable from the
// swallowed-keystroke case this card exists to catch, and would exhaust the retry ladder instead of ever
// reaching idle — see armCodexBusyStaleTimer's own doc for why that's the fix, not a bug in this test.
//
// CAUSALITY, not a formality: `submitCodex`'s real Enter write is a REAL setTimeout
// (`CODEX_SUBMIT_ENTER_DELAY_MS`), so a marker pushed synchronously (before it fires) predates
// `enterWrittenAt` and is correctly ignored by CASE 0 (`armCodexBusyStaleTimer`'s own doc) — in a real
// codex TUI, a marker literally cannot render before the Enter that caused it was actually sent. Wait for
// `enterPending` to clear (the real write happened) before pushing a marker meant to confirm this turn.
await waitUntil(() => host.liveCodex.get(SESSION_ID).enterPending === false, { label: "kickoff turn's own Enter write has actually happened" });
fakePty.push("Working (1s • esc to interrupt)\n");
check("kickoff turn's busy marker CONFIRMS it (armed from the marker sighting)", host.isBusy(SESSION_ID) === true);

// Let the kickoff's own (now-confirmed) turn go idle before the next scenario.
await waitUntil(() => host.isBusy(SESSION_ID) === false, { label: "kickoff turn goes idle once its confirmed marker goes stale" });

// --- C2: the in-flight race — a chunk in submitCodex's own text->\r write gap must NEVER flip busy false
const enq1 = host.enqueueStdin(SESSION_ID, "message one", "system", undefined, undefined, "agent");
check("enqueueStdin (idle) delivers message one immediately", enq1.delivered === true);
check("submitCodex armed busy synchronously for message one", host.isBusy(SESSION_ID) === true);
// A chunk with NO busy marker at all — exactly the ~300ms pre-marker window the pre-fix code got wrong
// (busy recomputed from every chunk, unconditionally overwriting the optimistic true submitCodex set).
fakePty.push("(echo of the just-typed text, not yet rendering the status line)\n");
check(
  "C2 FIX: busy stays true across the pre-marker window (the pre-fix per-chunk recompute would have flipped this false here)",
  host.isBusy(SESSION_ID) === true,
);
// Enqueue a SECOND message while (correctly) still busy — must QUEUE, never race message one.
const preRaceWriteCount = fakePty.writes.length;
const enq2 = host.enqueueStdin(SESSION_ID, "message two", "system", undefined, undefined, "agent");
check("message two QUEUES (busy correctly still true) rather than racing message one into the composer", enq2.queued === true && enq2.delivered !== true);
check("no extra write landed yet (message two did not get written prematurely)", fakePty.writes.length === preRaceWriteCount);
// Now the marker actually appears (arming the freshness timer), then genuinely goes stale — draining
// message two. Draining calls submitCodex again (message two's OWN turn), which re-arms busy=true
// synchronously in the SAME tick — so the observable sequence is true -> [stale: false, then immediately
// true again for message two] -> [message two's own turn eventually goes stale too].
//
// CAUSALITY (see the C1 section's own note): message one's real Enter write must have actually happened
// before a marker confirming IT is pushed, or CASE 0 correctly ignores it as predating `enterWrittenAt`.
await waitUntil(() => host.liveCodex.get(SESSION_ID).enterPending === false, { label: "message one's own Enter write has actually happened" });
fakePty.push("Working (1s • esc to interrupt)\n");
check("busy marker observed -> still busy", host.isBusy(SESSION_ID) === true);
await waitUntil(() => fakePty.writes.some((w) => w.includes("message two")), { label: "message two drained once the busy marker goes stale (no further sighting fed)" });
check("host.isBusy stays true — draining message two started its OWN turn synchronously", host.isBusy(SESSION_ID) === true);
check("pending queue is empty after the drain", host.getPending(SESSION_ID).length === 0);
check(
  "busy events show the stale-falling-edge immediately followed by message two's own rising edge",
  busyEvents.filter((e) => e.sessionId === SESSION_ID).slice(-2).map((e) => e.busy).join(",") === "false,true",
);
// Confirm message two's OWN turn too (same causality requirement) before letting it go idle — a
// still-unconfirmed message two would instead retry-then-stick, wrongly leaving `busy` true forever and
// breaking M3's own "delivers immediately (idle at enqueue time)" premise below.
await waitUntil(() => host.liveCodex.get(SESSION_ID).enterPending === false, { label: "message two's own Enter write has actually happened" });
fakePty.push("Working (1s • esc to interrupt)\n");
await waitUntil(() => host.isBusy(SESSION_ID) === false, { label: "message two's own (now-confirmed) turn goes idle" });

// --- M3: a session that keeps refreshing the marker must NEVER go idle while genuinely still busy -------
const enq3 = host.enqueueStdin(SESSION_ID, "message three (long turn)", "system", undefined, undefined, "agent");
check("message three delivers immediately (idle at enqueue time)", enq3.delivered === true);
// CAUSALITY (see the C1 section's own note): wait for message three's own real Enter write before any
// marker meant to confirm it — otherwise every refresh below predates `enterWrittenAt` and CASE 0 ignores
// them all, then CASE 3's retry ladder fires instead of this scenario's intended "stays busy" behavior.
await waitUntil(() => host.liveCodex.get(SESSION_ID).enterPending === false, { label: "message three's own Enter write has actually happened" });
// Refresh the marker several times with ZERO real delay between pushes — deliberately, not a timing
// shortcut: because this is fully synchronous, the PRIOR staleness timer can never get a chance to fire
// before armCodexBusyStaleTimer's own clearTimeout cancels it (Node's single-threaded event loop can't
// run a setTimeout callback mid-synchronous-execution), so this proves "repeated fresh sightings keep
// re-arming and never let a stale one land" as a deterministic LOGICAL fact — no real-time race, no host-
// load flakiness, unlike asserting "still true" after a real sleep shorter than the staleness window
// would be (this project's own fixed-wait-witness-guard correctly flags that shape).
for (let i = 0; i < 5; i++) {
  fakePty.push(`Working (${i + 1}s • esc to interrupt)\n`);
  check(`M3: still busy after refresh #${i + 1} (re-armed synchronously before any timer could fire)`, host.isBusy(SESSION_ID) === true);
}
// NOW let it genuinely go idle by observing the real staleness transition — an OBSERVABLE-event wait
// (waitUntil polls real state), never a blind sleep guessed to outlast CODEX_BUSY_STALE_MS.
await waitUntil(() => host.isBusy(SESSION_ID) === false, { label: "message three's turn finally goes idle once refreshes stop" });

// --- M9: reconcile() is the safety net for a queue stranded by a busy flag flipped some OTHER way --------
// (e.g. a lost/never-armed timer) than the normal onData-driven staleness path. Before the M9 fix,
// reconcile() never iterated `liveCodex` at all, so a queue stranded this way had NO recovery path.
const enq4 = host.enqueueStdin(SESSION_ID, "message four (busy)", "system", undefined, undefined, "agent");
check("message four delivers immediately (idle at enqueue time)", enq4.delivered === true);
const enq5 = host.enqueueStdin(SESSION_ID, "message five (stranded)", "system", undefined, undefined, "agent");
check("message five queues behind message four", enq5.queued === true);
host.liveCodex.get(SESSION_ID).busy = false; // simulate a busy flag cleared by some path OTHER than the staleness timer
check("(pre-reconcile) message five is still stuck in pending", host.getPending(SESSION_ID).length === 1);
host.reconcile();
check("M9 FIX: reconcile() drained the stranded queue", fakePty.writes.some((w) => w.includes("message five")));
check("(post-reconcile) pending is empty", host.getPending(SESSION_ID).length === 0);

// reconcile() must be a no-op for a genuinely busy codex session (never force-drain mid-turn).
host.liveCodex.get(SESSION_ID).busy = true;
const enq6 = host.enqueueStdin(SESSION_ID, "message six (genuinely busy)", "system", undefined, undefined, "agent");
check("message six queues (genuinely busy)", enq6.queued === true);
const writesBeforeReconcileNoop = fakePty.writes.length;
host.reconcile();
check("reconcile() does NOT drain a session that is genuinely still busy", fakePty.writes.length === writesBeforeReconcileNoop);
host.liveCodex.get(SESSION_ID).busy = false;
host.reconcile();
check("message six drains once genuinely idle again", fakePty.writes.some((w) => w.includes("message six")));

// --- M4: writeStdin (raw human terminal keystrokes) must reach a codex pty, not silently discard -------
const writesBeforeStdin = fakePty.writes.length;
const humanText = "a human typed this directly into the codex terminal tile, over twenty chars";
host.writeStdin(SESSION_ID, humanText);
check("M4 FIX: writeStdin's raw bytes reached the fake codex pty", fakePty.writes.slice(writesBeforeStdin).includes(humanText));

// --- R4: card 448f1b4a — a session that NEVER reaches boot readiness must FAIL LOUD, not queue silently
// forever. A SEPARATE session (this file's shared SESSION_ID is already past boot) that is spawned and
// then never fed a ready+model-loaded frame at all — LOOM_CODEX_BOOT_READY_TIMEOUT_MS was shrunk to 200ms
// above, so this stays real-time but fast; the fail-loud ceiling itself is a genuine setTimeout, so this
// is observed via waitUntil, never a blind sleep.
{
  const STUCK_SESSION_ID = "codex-boot-stuck-test";
  // No startupPrompt (mirrors a resume, where there's nothing for the boot-ready transition to deliver as
  // a kickoff) — so a LATE recovery below drains the queued probe message directly, rather than the
  // kickoff jumping the queue in front of it (see the boot-ready onData branch's own doc for that order).
  host.spawn({
    sessionId: STUCK_SESSION_ID, cwd: "/fake/codex/worktree-stuck", permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: "worker", harness: "codex",
  });
  const stuckPty = host.fakeCodexPtys.get(STUCK_SESSION_ID);
  // A message enqueued against a session that will never boot must queue, not write — the same R2 shape,
  // held here to be visible in the boot-stuck report's own pendingCount.
  const enqStuck = host.enqueueStdin(STUCK_SESSION_ID, "queued against a session that never boots", "system", undefined, undefined, "agent");
  check("R4: a message enqueued against a never-booting session queues", enqStuck.queued === true);
  await waitUntil(() => bootStuckEvents.some((e) => e.sessionId === STUCK_SESSION_ID), { label: "onCodexBootStuck fires for the never-booting session" });
  const stuckEvent = bootStuckEvents.find((e) => e.sessionId === STUCK_SESSION_ID);
  check("R4 FIX: the boot-stuck report names the ceiling that was exceeded", stuckEvent.info.timeoutMs === 200);
  check("R4 FIX: the boot-stuck report's pendingCount reflects the queued (never-written) message", stuckEvent.info.pendingCount === 1);
  // Card 4babeb43: this session never received ANY pty output, so BOTH the ready marker and the
  // model-loaded check must be reported unmet — but trust-dialog-resolved must NOT be, since a dialog that
  // never even appeared was never "pending" in the first place (a wrong polarity here would falsely blame
  // the trust dialog for a boot that never got far enough to show one).
  check("R4 FIX: the boot-stuck report names 'ready marker' unmet (no output ever received)", stuckEvent.info.readyMarker === false);
  check("R4 FIX: the boot-stuck report names 'model-loaded' unmet (no output ever received)", stuckEvent.info.modelLoaded === false);
  check("R4 FIX: the boot-stuck report does NOT blame trust-dialog-resolved when no dialog ever appeared", stuckEvent.info.trustDialogResolved === true);
  check("R4: nothing was EVER written to the never-booting session's pty (no premature submit)", stuckPty.writes.length === 0);
  check("R4: bootReady never latched for the never-booting session", host.liveCodex.get(STUCK_SESSION_ID).bootReady === false);
  // A LATE recovery (codex was merely slow, not genuinely stuck) must still resolve normally — the fail-
  // loud report is one-shot, not a permanent lockout (see CodexLive.bootReadyTimer's own doc).
  stuckPty.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
  check("R4: a LATE boot-readiness still latches normally after a boot-stuck report already fired", host.liveCodex.get(STUCK_SESSION_ID).bootReady === true);
  check("R4: the previously-queued message drains once the late boot-readiness latches", stuckPty.writes.some((w) => w.includes("queued against a session that never boots")));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the codex queue/turn state machine (enqueueStdinCodex/submitCodex/drainCodexPending/setCodexBusy), the C1 kickoff-delivery fix, the C2 in-flight busy guard, the M3 freshness-based busy read, the M9 reconcile() safety net, the M4 writeStdin passthrough, the R1-R3 boot-readiness gate (card 448f1b4a — a ready placeholder alone, with the model still loading, no longer latches readiness or lets a queued message through, including via reconcile()), and the R4 boot-stuck fail-loud ceiling all behave correctly under a fully scripted fake pty."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
