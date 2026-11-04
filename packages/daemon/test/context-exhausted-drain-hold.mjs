import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 66ff7321 (part C of 8c7dfc65), Addition A — the DRAIN HAZARD: once a session is marked
// context-exhausted, clearing `busy` must NOT let a queued message drain into the dead turn. Drives a
// REAL PtyHost (fake pty via the createPty() seam, _seam-host-fixture.mjs — no real claude, no daemon).
//
// Proves:
//   (1) a message enqueued WHILE busy queues normally (pre-existing behaviour, unaffected).
//   (2) markContextExhausted clears busy AND sets live.contextExhausted — observable via
//       getPendingQueueDepth staying put and the queued message never being handed to the fake pty's
//       write().
//   (3) a FURTHER message enqueued AFTER exhaustion is marked is ALSO held (queued), never delivered
//       immediately — even though `busy` now reads false (idleEligible's own !live.contextExhausted
//       gate).
//   (4) PtyHost.reconcile() does NOT flush the held queue while contextExhausted is set — queue depth
//       is UNCHANGED across a reconcile() call, and the fake pty's write() is never invoked with the
//       held text.
//   (5) a DB-level clear via the REAL rising-edge chokepoint (SessionService.handleBusyEdge, card
//       7b1b2b3f) resets the mark while leaving an unrelated session's own lastError untouched — both
//       for a row never exhausted and for one re-exhausted-then-overwritten by something unrelated.
//   (6) a fresh UserPromptSubmit rising edge clears the in-memory hold end-to-end.
//   (7) an exhausted session with an EMPTY pending queue still holds a new enqueue (no write, depth 1).
//   (8) a HUMAN_COMPOSER_SENDER_ID entry delivers despite exhaustion (a human acting IS the recovery);
//       an ordinary agent-kind entry on an identical setup stays held.
//   (8c) with a PRE-HELD agent entry already queued, a composer entry still delivers immediately —
//       drains via the exhausted composer scan — and the pre-held entry stays held, draining normally
//       only once the composer's own turn completes.
//   (9b) a pre-held AGENT entry sitting AHEAD of the composer's own recovery entry — the composer entry
//       still drains OUT OF ORDER once the OTHER conjunct clears, leaving the agent entry queued/held.
//   (10) a REAL-PtyHost seam test proving the actual `busySinceMs` stamp (never a fake/stub) is
//       correctly accepted/rejected as `detectContextExhaustionInTail`'s own stale-marker cutoff.
//   (14) an older composer entry (A), held only by a DIFFERENT idleEligible conjunct that clears
//       before a newer composer entry (B) arrives, drains before B — with no reconcile()/drainPending
//       call made anywhere in the test. See
//       docs/decisions/b70eade0-drainpending-is-sole-owner-of-the-composer-drain-policy.md.
//   (15) the GIVE-UP-HOLD variant of (14): same assertion, A injected as an ALREADY-EXPIRED give-up
//       hold rather than driven through the real timeout.
//   (16) the first composer message queued BEHIND ONLY undeliverable non-composer entries is delivered
//       while exhausted, purely from drainPending's own exhausted-branch composer scan, with no
//       reconcile() call anywhere; those non-composer entries stay queued, in their original order.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/context-exhausted-drain-hold.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME — set BEFORE any dist/ import (paths.ts/host.ts read it at module-top-level). ---
const tmpHome = path.join(os.tmpdir(), `loom-ctxexh-drain-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// card 5f825506 (item 2) — pin the humanSubmitHeldUntil bound SHORT so test (9) below doesn't wait the
// real 20s default. Read once, at module-top-level, by host.ts's own HUMAN_SUBMIT_CONFIRM_HOLD_MS —
// must be set BEFORE that module is imported.
const HUMAN_SUBMIT_HOLD_TEST_MS = 80;
process.env.LOOM_HUMAN_SUBMIT_CONFIRM_HOLD_MS = String(HUMAN_SUBMIT_HOLD_TEST_MS);

const { PtyHost, HUMAN_COMPOSER_SENDER_ID } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { detectContextExhaustionInTail } = await import("../dist/pty/claude-transcript.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const writes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    return { ...base, write: (data) => { writes.push({ sessionId: opts.sessionId, data }); } };
  }
}

const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {},
  onRateLimited() {}, onExit() {},
};

const host = new TestPtyHost(events);
function spawnHostReady(targetHost, sessionId) {
  targetHost.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  targetHost.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}
function spawnReady(sessionId) { spawnHostReady(host, sessionId); }

try {
  const SID = "wkr-drain-hold";
  spawnReady(SID);

  // ===== (1) baseline: first enqueue delivers immediately (idle), second queues (busy) =====
  const r1 = host.enqueueStdin(SID, "FIRST_TURN_TEXT");
  check("(1) first enqueue (idle) delivers immediately, busy armed", r1.delivered === true && busyLog[SID]?.at(-1) === true);
  const r2 = host.enqueueStdin(SID, "QUEUED_WHILE_BUSY", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-2");
  check("(1) second enqueue while busy is HELD (pre-existing behaviour, unaffected)", r2.delivered === false);
  check("(1) pendingQueueDepth is 1", host.getPendingQueueDepth(SID) === 1);

  // ===== (2) mark context-exhausted =====
  const marked = host.markContextExhausted(SID);
  check("(2) markContextExhausted returns true for this live claude session", marked === true);
  check("(2) busy is now false (the ordinary falling-edge path)", busyLog[SID]?.at(-1) === false);
  check("(2) the already-queued message was NOT drained as a side effect of clearing busy", host.getPendingQueueDepth(SID) === 1);
  check("(2) the fake pty's write() was never called with the held text (no delivery happened)",
    !writes.some((w) => w.sessionId === SID && typeof w.data === "string" && w.data.includes("QUEUED_WHILE_BUSY")));

  // ===== (3) a FURTHER enqueue after exhaustion is held too, despite busy now reading false =====
  const r3 = host.enqueueStdin(SID, "ENQUEUED_AFTER_EXHAUSTION", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-3");
  check("(3) a message enqueued AFTER exhaustion is marked is HELD (delivered:false), not sent straight through", r3.delivered === false);
  check("(3) pendingQueueDepth is now 2 — the new message queued, it did not bypass the hold", host.getPendingQueueDepth(SID) === 2);
  const heldTextWritten = () => writes.some((w) => w.sessionId === SID && typeof w.data === "string"
    && (w.data.includes("QUEUED_WHILE_BUSY") || w.data.includes("ENQUEUED_AFTER_EXHAUSTION")));
  check("(3) still no write() of either HELD message's own text (the first, pre-exhaustion delivery's own write is expected and excluded)", !heldTextWritten());

  // ===== (4) reconcile() — the periodic drain safety net — must NOT flush the held queue =====
  host.reconcile();
  check("(4) reconcile() does NOT change the pending queue depth (drainPending's own contextExhausted guard holds)", host.getPendingQueueDepth(SID) === 2);
  check("(4) reconcile() did NOT flip busy back to true (no submit happened)", busyLog[SID]?.at(-1) === false);
  check("(4) reconcile() never handed either held message's text to the fake pty's write()", !heldTextWritten());

  // ===== negative control: an ORDINARY (never-exhausted) busy session's held queue DOES drain on its
  // own falling edge — proves the hold in (2)-(4) is specific to contextExhausted, not a general queue
  // freeze that would make this whole test suite vacuously pass. =====
  {
    const SID2 = "wkr-ordinary-drain";
    spawnReady(SID2);
    host.enqueueStdin(SID2, "ORDINARY_FIRST");
    host.enqueueStdin(SID2, "ORDINARY_QUEUED", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-x");
    check("(neg) ordinary session: queue depth 1 before any Stop", host.getPendingQueueDepth(SID2) === 1);
    host.deliverHook(SID2, { hook_event_name: "Stop" });
    check("(neg) ordinary session: an ordinary Stop DOES drain the held queue (depth back to 0)", host.getPendingQueueDepth(SID2) === 0);
    check("(neg) ordinary session: the queued text WAS handed to write() this time", writes.some((w) => w.sessionId === SID2));
  }
  // ===== (6) CLEARS ON RISING EDGE: a fresh UserPromptSubmit hook (the real resume/next-turn chokepoint
  // — PtyHost.setBusy's own `if (busy) live.contextExhausted = false` branch) lifts the hold. Proven
  // via the SAME drains-vs-holds shape as the (neg) control above: a message queued AFTER the rising
  // edge, then a Stop, DRAINS this time — it would stay held forever if the flag hadn't cleared. =====
  {
    const SID3 = "wkr-rising-edge-clear";
    spawnReady(SID3);
    host.enqueueStdin(SID3, "RE_FIRST_TURN");
    const r = host.markContextExhausted(SID3);
    check("(6) setup: a fresh session can be marked exhausted too", r === true);
    check("(6) setup: busy is false right after marking", busyLog[SID3]?.at(-1) === false);

    // The resume/next-turn rising edge — mirrors the real UserPromptSubmit hook's own unconditional
    // setBusy(true) call (host.ts), which this card's fix made ALSO clear live.contextExhausted.
    host.deliverHook(SID3, { hook_event_name: "UserPromptSubmit", prompt: "RE_FIRST_TURN" });
    check("(6) the rising edge set busy back to true", busyLog[SID3]?.at(-1) === true);

    // Queue a message mid-turn, then end the turn — if contextExhausted truly cleared, this drains
    // exactly like the ordinary (neg) control; if it hadn't, drainPending's own guard would hold it
    // forever, indistinguishable from a bug.
    host.enqueueStdin(SID3, "RE_QUEUED_AFTER_CLEAR", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-re");
    check("(6) a message queued after the rising edge sits at depth 1 (ordinary busy-queue behaviour)", host.getPendingQueueDepth(SID3) === 1);
    host.deliverHook(SID3, { hook_event_name: "Stop" });
    check("(6) the Stop DRAINS it (depth back to 0) — proves contextExhausted was actually cleared, not still holding", host.getPendingQueueDepth(SID3) === 0);
    check("(6) the drained text WAS handed to write() — a real delivery, not a silent drop",
      writes.some((w) => w.sessionId === SID3 && typeof w.data === "string" && w.data.includes("RE_QUEUED_AFTER_CLEAR")));
  }

  // ===== (7) MUTANT B2 CATCH (CR finding, round 2): an exhausted session with an EMPTY pending
  // queue. The immediate-submit branch only requires `idleEligible && pending.length === 0` — a
  // mutant that dropped `!live.contextExhausted` from `idleEligible` would pass that check here
  // (pending genuinely IS empty) and write straight into the dead turn. (3) above can't catch this:
  // its queue already holds an entry at the time of enqueue, so it never reaches the immediate branch
  // either way. =====
  {
    const SID4 = "wkr-empty-queue-exhausted";
    spawnReady(SID4);
    host.enqueueStdin(SID4, "T4_FIRST_TURN"); // delivers immediately; busy=true, pending stays empty
    check("(7) setup: pending queue is empty before marking", host.getPendingQueueDepth(SID4) === 0);
    check("(7) setup: markContextExhausted succeeds", host.markContextExhausted(SID4) === true);
    check("(7) setup: queue is STILL empty right after marking (the mutant's exact precondition)", host.getPendingQueueDepth(SID4) === 0);
    const r4 = host.enqueueStdin(SID4, "ENQUEUED_ON_EMPTY_EXHAUSTED_QUEUE", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-4");
    check("(7) a message enqueued on an EMPTY exhausted queue is HELD, not delivered immediately", r4.delivered === false);
    check("(7) pendingQueueDepth is now 1 (held, not dropped)", host.getPendingQueueDepth(SID4) === 1);
    check("(7) no write() of the held text happened (the mutant's own failure signature)",
      !writes.some((w) => w.sessionId === SID4 && typeof w.data === "string" && w.data.includes("ENQUEUED_ON_EMPTY_EXHAUSTED_QUEUE")));
  }

  // ===== (8) HUMAN COMPOSER EXEMPTION (CR finding, round 2): an entry carrying
  // HUMAN_COMPOSER_SENDER_ID delivers immediately even while context-exhausted — a human acting IS
  // the recovery (e.g. /compact), and its own submit's busy rising edge clears the mark for everyone
  // queued behind it. "Test both": (8a) on an otherwise-identical empty-exhausted-queue setup, an
  // ordinary agent-kind entry stays held (the exemption is per-sender, never a session-wide bypass);
  // (8b) the composer entry on its OWN session delivers straight through. =====
  {
    const SID5a = "wkr-composer-negative";
    spawnReady(SID5a);
    host.enqueueStdin(SID5a, "T5A_FIRST_TURN");
    host.markContextExhausted(SID5a);
    const r5agent = host.enqueueStdin(SID5a, "AGENT_ENTRY_STAYS_HELD", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-5a");
    check("(8a) an ordinary agent-kind entry on an exhausted session is still HELD (the exemption is per-sender)", r5agent.delivered === false);
    check("(8a) pendingQueueDepth is 1 (held, not delivered)", host.getPendingQueueDepth(SID5a) === 1);

    const SID5b = "wkr-composer-positive";
    spawnReady(SID5b);
    host.enqueueStdin(SID5b, "T5B_FIRST_TURN");
    host.markContextExhausted(SID5b);
    check("(8b) setup: queue empty, session exhausted", host.getPendingQueueDepth(SID5b) === 0 && busyLog[SID5b]?.at(-1) === false);
    const r5 = host.enqueueStdin(SID5b, "HUMAN_COMPOSER_TEXT", "human", undefined, undefined, "agent", undefined, "HUMAN_COMPOSER_TEXT", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(8b) a HUMAN_COMPOSER_SENDER_ID entry delivers immediately DESPITE exhaustion (the exemption)", r5.delivered === true);
    check("(8b) its own submit's busy rising edge ALSO cleared contextExhausted (the shared setBusy(true) chokepoint)", busyLog[SID5b]?.at(-1) === true);
    check("(8b) the composer text WAS handed to write() — a real delivery, not held",
      writes.some((w) => w.sessionId === SID5b && typeof w.data === "string" && w.data.includes("HUMAN_COMPOSER_TEXT")));
  }
  // ===== (8c) ROUND 3 MAJOR (CR finding): the round-2 exemption above only ever bypassed
  // `contextExhaustedHold`, but `idleEligible && live.pending.length === 0` STILL gated immediate
  // delivery — so with so much as ONE already-held entry in front of it (the realistic case: a held
  // worker report, an idle nudge, queued manager direction), the composer's own recovery message queued
  // FIFO behind it and was NEVER drained (drainPending's own unconditional contextExhausted early
  // return holds the WHOLE queue, composer entry included), so the one write that can actually clear
  // the mark never ran either. Repro: markContextExhausted; enqueue a pre-held agent entry; enqueue a
  // composer entry — pre-fix this returned delivered:false and depth stayed 2 forever. =====
  {
    const SID6 = "wkr-composer-preheld";
    spawnReady(SID6);
    host.enqueueStdin(SID6, "T6_FIRST_TURN");
    host.markContextExhausted(SID6);
    const heldAgent = host.enqueueStdin(SID6, "PRE_HELD_AGENT_ENTRY", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-6");
    check("(8c) setup: the pre-held agent entry is held, not delivered", heldAgent.delivered === false);
    check("(8c) setup: pendingQueueDepth is 1 before the composer arrives", host.getPendingQueueDepth(SID6) === 1);

    const composerAfterHeld = host.enqueueStdin(SID6, "COMPOSER_DESPITE_PREHELD_QUEUE", "human", undefined, undefined, "agent", undefined, "COMPOSER_DESPITE_PREHELD_QUEUE", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(8c) MAJOR FIX: a composer entry delivers immediately even with a non-empty (held) queue ahead of it", composerAfterHeld.delivered === true);
    check("(8c) its own submit's rising edge cleared contextExhausted (busy flips true)", busyLog[SID6]?.at(-1) === true);
    check("(8c) the composer text WAS handed to write()",
      writes.some((w) => w.sessionId === SID6 && typeof w.data === "string" && w.data.includes("COMPOSER_DESPITE_PREHELD_QUEUE")));
    check("(8c) the pre-held agent entry STAYS held (queue depth still 1 — not drained, not dropped) while the composer's own turn is in flight",
      host.getPendingQueueDepth(SID6) === 1);
    check("(8c) the pre-held agent entry's text was NOT written (still held, not drained as a side effect of the composer's delivery)",
      !writes.some((w) => w.sessionId === SID6 && typeof w.data === "string" && w.data.includes("PRE_HELD_AGENT_ENTRY")));

    // Once the composer's own turn ends (Stop), contextExhausted is already cleared and busy falls —
    // the pre-held agent entry should now drain NORMALLY (ordinary busy-queue behaviour), proving it
    // wasn't dropped or orphaned, just held until it was its turn.
    host.deliverHook(SID6, { hook_event_name: "Stop" });
    check("(8c) the pre-held agent entry DRAINS normally once the composer's turn completes (depth back to 0)", host.getPendingQueueDepth(SID6) === 0);
    check("(8c) the pre-held agent entry's text WAS eventually written, proving it drained normally rather than vanishing",
      writes.some((w) => w.sessionId === SID6 && typeof w.data === "string" && w.data.includes("PRE_HELD_AGENT_ENTRY")));
  }

  // ===== (9) card 5f825506 item 2 — STRAND FIX: a composer entry that's exhausted AND ALSO blocked by
  // a DIFFERENT idleEligible conjunct (isHumanSubmitHeld) when it arrives lands HELD (never immediate —
  // every OTHER conjunct still gates it exactly as before). It must then drain once that OTHER conjunct
  // clears, via the ordinary periodic reconcile() safety net, with NO second composer message ever
  // sent — pre-fix, drainPending's own unconditional contextExhausted bail left this held FOREVER,
  // regardless of how many reconcile() ticks ran, because nothing re-checked whether the OTHER hold
  // had cleared. =====
  {
    const SID9 = "wkr-composer-strand-fix";
    spawnReady(SID9);
    host.enqueueStdin(SID9, "T9_FIRST_TURN"); // delivers immediately; busy=true, pending empty
    check("(9) setup: markContextExhausted succeeds", host.markContextExhausted(SID9) === true);
    check("(9) setup: pending queue is empty right after marking", host.getPendingQueueDepth(SID9) === 0);

    // Arm isHumanSubmitHeld via the raw-terminal path — an UNRELATED human Enter-submit, racing the
    // composer's own recovery message below (the same race 2521bf51 names, just a different conjunct).
    host.writeStdin(SID9, "unrelated raw keystrokes\r");

    const r9 = host.enqueueStdin(SID9, "COMPOSER_STRAND_RECOVERY", "human", undefined, undefined, "agent", undefined, "COMPOSER_STRAND_RECOVERY", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(9) the composer entry is HELD (not delivered immediately) while a DIFFERENT conjunct also blocks it — every other conjunct still gates it",
      r9.delivered === false);
    check("(9) pendingQueueDepth is 1 (held, not dropped)", host.getPendingQueueDepth(SID9) === 1);
    check("(9) not written yet", !writes.some((w) => w.sessionId === SID9 && typeof w.data === "string" && w.data.includes("COMPOSER_STRAND_RECOVERY")));

    // Poll the OBSERVABLE precondition (queue depth reaching 0) via repeated reconcile() calls, rather
    // than a single fixed sleep then a snapshot check — the poll's own outcome (drained within the
    // bound, or not) is itself the falsifiable result: a real regression that never clears the hold
    // times out and correctly reports false, instead of a fixed-duration sleep that could pass or fail
    // for the wrong reason depending on host speed. The periodic safety net alone — no second composer
    // message is ever sent during this loop.
    const deadline = Date.now() + HUMAN_SUBMIT_HOLD_TEST_MS * 10;
    let drainedToZero = false;
    while (Date.now() < deadline) {
      host.reconcile();
      if (host.getPendingQueueDepth(SID9) === 0) { drainedToZero = true; break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    check("(9) MAJOR FIX: reconcile() alone drains the composer entry once the OTHER conjunct clears (depth reaches 0), confirmed via polling, with exactly ONE composer enqueue call made in total",
      drainedToZero);
    check("(9) its own submit's rising edge cleared contextExhausted (busy flips true)", busyLog[SID9]?.at(-1) === true);
    check("(9) the composer text WAS handed to write() — a real delivery, not a silent drop",
      writes.some((w) => w.sessionId === SID9 && typeof w.data === "string" && w.data.includes("COMPOSER_STRAND_RECOVERY")));
  }

  // ===== (9b) card 5f825506 ROUND 2, item 1 (CR MAJOR) — a variant of (9) with a PRE-HELD AGENT entry
  // sitting AHEAD of the composer's own recovery entry in `live.pending` when the OTHER conjunct
  // (isHumanSubmitHeld) clears. Pre-fix, drainPending's own head-only bail checked ONLY the head's
  // senderId — with a non-composer entry at the head, it bailed unconditionally and never looked
  // further into the queue, so the composer entry (sitting BEHIND the agent entry) could never drain
  // either, regardless of how many reconcile() ticks ran. Proves: once the OTHER conjunct clears, the
  // composer entry drains OUT OF ORDER (pulled from behind the agent entry), and the agent entry stays
  // queued and held — not drained, not dropped — until the composer's own turn completes. =====
  {
    const SID9b = "wkr-composer-strand-fix-preheld";
    spawnReady(SID9b);
    host.enqueueStdin(SID9b, "T9B_FIRST_TURN"); // delivers immediately; busy=true, pending empty
    check("(9b) setup: markContextExhausted succeeds", host.markContextExhausted(SID9b) === true);
    check("(9b) setup: pending queue is empty right after marking", host.getPendingQueueDepth(SID9b) === 0);

    // A pre-held AGENT entry lands first (ahead of the composer's own recovery entry below) — the
    // realistic shape a head-only check can't see past.
    const heldAgent9b = host.enqueueStdin(SID9b, "PREHELD_AGENT_AHEAD_OF_COMPOSER", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-9b");
    check("(9b) setup: the pre-held agent entry is held, not delivered", heldAgent9b.delivered === false);
    check("(9b) setup: pendingQueueDepth is 1 before the composer arrives", host.getPendingQueueDepth(SID9b) === 1);

    // Arm isHumanSubmitHeld (same mechanism as (9)) so the composer entry ALSO can't take the
    // immediate-submit path — it must land in `live.pending`, BEHIND the agent entry.
    host.writeStdin(SID9b, "unrelated raw keystrokes\r");
    const composer9b = host.enqueueStdin(SID9b, "COMPOSER_BEHIND_PREHELD_AGENT", "human", undefined, undefined, "agent", undefined, "COMPOSER_BEHIND_PREHELD_AGENT", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(9b) the composer entry is ALSO HELD (isHumanSubmitHeld blocks the immediate path) — queued behind the agent entry", composer9b.delivered === false);
    check("(9b) pendingQueueDepth is 2 (both entries queued, composer BEHIND the agent entry)", host.getPendingQueueDepth(SID9b) === 2);
    check("(9b) neither entry's text has been written yet",
      !writes.some((w) => w.sessionId === SID9b && typeof w.data === "string"
        && (w.data.includes("PREHELD_AGENT_AHEAD_OF_COMPOSER") || w.data.includes("COMPOSER_BEHIND_PREHELD_AGENT"))));

    // Poll via reconcile() alone (no second composer message) until isHumanSubmitHeld's own bound
    // expires and the composer entry — pulled OUT OF ORDER, from behind the agent entry — drains.
    const deadline9b = Date.now() + HUMAN_SUBMIT_HOLD_TEST_MS * 10;
    let composerDrained9b = false;
    while (Date.now() < deadline9b) {
      host.reconcile();
      if (writes.some((w) => w.sessionId === SID9b && typeof w.data === "string" && w.data.includes("COMPOSER_BEHIND_PREHELD_AGENT"))) { composerDrained9b = true; break; }
      // TIMING-GUARD-SAFE: poll-observes-prior-step — this loop's own condition is the composer's write
      // being recorded; the "depth still 1" check a few lines below asserts a DIFFERENT fact (the
      // pre-held agent entry's own queue position) that is already true, by synchronous necessity, the
      // instant that write lands — drainPending's splice-out-the-composer-entry-alone step (this round's
      // own fix) runs strictly BEFORE the write it causes, inside the SAME synchronous call, so no
      // additional wall-clock wait could ever change what the agent entry's depth reads at that moment.
      await new Promise((r) => setTimeout(r, 10));
    }
    check("(9b) MAJOR FIX: the composer entry drains OUT OF ORDER once the OTHER conjunct clears, even though a non-composer entry sat ahead of it at the head", composerDrained9b);
    check("(9b) its own submit's rising edge cleared contextExhausted (busy flips true)", busyLog[SID9b]?.at(-1) === true);
    check("(9b) the pre-held agent entry REMAINS QUEUED AND HELD — not drained as a side effect, not dropped (depth still 1)", host.getPendingQueueDepth(SID9b) === 1);
    check("(9b) the pre-held agent entry's text was NOT written (still held, drained OUT OF ORDER means the composer alone left, not a coalesced run)",
      !writes.some((w) => w.sessionId === SID9b && typeof w.data === "string" && w.data.includes("PREHELD_AGENT_AHEAD_OF_COMPOSER")));

    // Once the composer's own turn ends (Stop), contextExhausted is already cleared and busy falls —
    // the pre-held agent entry should now drain NORMALLY (ordinary busy-queue behaviour), proving it
    // wasn't dropped or orphaned, just held until it was its turn — same closing shape as (8c).
    host.deliverHook(SID9b, { hook_event_name: "Stop" });
    check("(9b) the pre-held agent entry DRAINS normally once the composer's turn completes (depth back to 0)", host.getPendingQueueDepth(SID9b) === 0);
    check("(9b) the pre-held agent entry's text WAS eventually written, proving it drained normally rather than vanishing",
      writes.some((w) => w.sessionId === SID9b && typeof w.data === "string" && w.data.includes("PREHELD_AGENT_AHEAD_OF_COMPOSER")));
  }

  // ===== (10) card 5f825506 ROUND 2, item 2 — REAL-PtyHost seam test for `busySinceMs`: reads the
  // ACTUAL `Live.busySince` stamp (never a fake/stub) off a genuine rising edge, then feeds it DIRECTLY
  // to `detectContextExhaustionInTail` and proves it is correctly accepted/rejected as that function's
  // own stale-marker cutoff — NOT a full watcher-tick → checkContextExhaustion integration (that wiring
  // is covered by context-watcher-worker-ratios.mjs's own scenarios (20)/(21) instead). RED via the dist
  // mutant `busySinceMs → return null`: with a `null` cutoff, `detectContextExhaustionInTail`'s own
  // `isStale` is unconditionally false (see that function's own doc), so the OLDER-than-turn marker
  // below would be wrongly read as still-current instead of correctly rejected. =====
  {
    const SID10 = "wkr-busysincems-seam";
    spawnReady(SID10);
    const beforeSubmitMs10 = Date.now();
    host.enqueueStdin(SID10, "T10_FIRST_TURN"); // delivers immediately (idle) — the REAL rising edge that stamps busySince
    const stamped10 = host.busySinceMs(SID10);
    check("(10) the REAL PtyHost.busySinceMs returns a non-null stamp right after a genuine rising edge", stamped10 !== null);
    check("(10) the stamp is >= the time captured just before the submit (a genuine turn-start timestamp)",
      typeof stamped10 === "number" && stamped10 >= beforeSubmitMs10);

    const REAL_EXHAUSTION_RECORD_SEAM = {
      type: "assistant",
      message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Prompt is too long" }] },
      error: "invalid_request", isApiErrorMessage: true,
    };
    const olderMarker10 = { ...REAL_EXHAUSTION_RECORD_SEAM, timestamp: new Date(stamped10 - 60_000).toISOString() };
    const newerMarker10 = { ...REAL_EXHAUSTION_RECORD_SEAM, timestamp: new Date(stamped10 + 1_000).toISOString() };
    check("(10) an OLDER-than-turn marker, fed the REAL stamp as the cutoff, is rejected as stale (null)",
      detectContextExhaustionInTail(`${JSON.stringify(olderMarker10)}\n`, stamped10) === null);
    const newerResult10 = detectContextExhaustionInTail(`${JSON.stringify(newerMarker10)}\n`, stamped10);
    check("(10) a NEWER-than-turn marker, fed the SAME REAL stamp as the cutoff, is still detected",
      newerResult10 !== null && newerResult10.matchedText === "Prompt is too long");
  }

  // ===== (11) card 5f825506 ROUND 3 MAJOR — the HEAD-IS-the-composer-entry case. Round 2's own fix
  // (test 9b) only ever proved drainPending reaches PAST a non-composer head to find a composer entry
  // sitting BEHIND it — but the bail condition it used (`exhaustionHoldAppliesTo(head.senderId)`) is
  // FALSE whenever the composer entry is ITSELF the head, so in that shape the old code fell straight
  // through to the ORDINARY coalescing branches below instead. Under the daemon-global
  // `coalesceAgentMessages:true` (the route-keyed branch, which ignores sender AND kind entirely), that
  // let a held NON-composer entry sitting right behind the composer's own head entry get coalesced into
  // the composer's recovery turn — exactly the reviewer's repro: [composer "/compact", manager
  // direction] + exhausted + toggle ON → the direction gets written AFTER the composer text in ONE
  // turn, and onDeliver fires for it too (marked delivered) even though the CLI reads it as part of the
  // compaction instructions, never as its own turn. (11a) reproduces it with the toggle ON; (11b) is the
  // toggle-OFF control (same-sender coalescing already happened to protect this shape pre-fix, since the
  // manager direction has a DIFFERENT senderId — this control proves the fix doesn't regress that). =====
  {
    const SID11a = "wkr-composer-head-coalesce-on";
    const hostOn = new TestPtyHost(events, { coalesceAgentMessages: true });
    spawnHostReady(hostOn, SID11a);
    hostOn.enqueueStdin(SID11a, "T11A_FIRST_TURN"); // delivers immediately (idle); busy=true, pending empty
    check("(11a) setup: markContextExhausted succeeds", hostOn.markContextExhausted(SID11a) === true);
    check("(11a) setup: pending queue is empty right after marking", hostOn.getPendingQueueDepth(SID11a) === 0);

    // Arm isHumanSubmitHeld so the composer's own immediate bypass can't fire — it must land in
    // `live.pending` AS THE HEAD (nothing else is queued yet).
    hostOn.writeStdin(SID11a, "unrelated raw keystrokes\r");
    const composer11a = hostOn.enqueueStdin(SID11a, "COMPOSER_HEAD_11A", "human", undefined, undefined, "agent", undefined, "COMPOSER_HEAD_11A", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(11a) setup: the composer entry is HELD (isHumanSubmitHeld blocks the immediate path) and is the ONLY entry — i.e. the HEAD", composer11a.delivered === false);
    check("(11a) setup: pendingQueueDepth is 1 (the composer entry alone, at the head)", hostOn.getPendingQueueDepth(SID11a) === 1);

    // A manager direction (non-composer, agent-kind, a DIFFERENT senderId, no route — same route key as
    // the composer entry) arrives behind it while still exhausted.
    let directionDelivered11a = false;
    const direction11a = hostOn.enqueueStdin(SID11a, "MANAGER_DIRECTION_11A", "system", () => { directionDelivered11a = true; }, undefined, "agent", undefined, undefined, undefined, "sender-11a");
    check("(11a) setup: the manager direction is ALSO held, queued behind the composer entry", direction11a.delivered === false);
    check("(11a) setup: pendingQueueDepth is 2 (composer HEAD, direction behind it)", hostOn.getPendingQueueDepth(SID11a) === 2);

    const deadline11a = Date.now() + HUMAN_SUBMIT_HOLD_TEST_MS * 10;
    let composerDrained11a = false;
    while (Date.now() < deadline11a) {
      hostOn.reconcile();
      if (writes.some((w) => w.sessionId === SID11a && typeof w.data === "string" && w.data.includes("COMPOSER_HEAD_11A"))) { composerDrained11a = true; break; }
      // TIMING-GUARD-SAFE: poll-observes-prior-step — this loop's own condition is the composer's write
      // being recorded; the MAJOR-FIX checks below assert a DIFFERENT fact (whether the SAME synchronous
      // drainPending call that produced that write also folded the direction entry into it) that is
      // already fully determined, by synchronous necessity, the instant that write lands — splice/
      // coalesce/submit all run inside the SAME synchronous drainPending call, so no additional
      // wall-clock wait could ever change what those checks observe once this loop's own write fires.
      await new Promise((r) => setTimeout(r, 10));
    }
    check("(11a) the composer entry (the HEAD) drains once isHumanSubmitHeld clears", composerDrained11a);
    check("(11a) MAJOR FIX: the manager direction is NEVER folded into the composer's own turn — the write contains ONLY the composer text, never the direction's",
      writes.some((w) => w.sessionId === SID11a && typeof w.data === "string" && w.data.includes("COMPOSER_HEAD_11A") && !w.data.includes("MANAGER_DIRECTION_11A")));
    check("(11a) MAJOR FIX: the direction entry stays QUEUED, not drained as a side effect of the composer's own turn (depth still 1)",
      hostOn.getPendingQueueDepth(SID11a) === 1);
    check("(11a) MAJOR FIX: the direction's own onDeliver never fired — it was never handed to the recipient",
      directionDelivered11a === false);
    check("(11a) the direction's own text was never written at all (not even as part of a later, separate write) during this drain",
      !writes.some((w) => w.sessionId === SID11a && typeof w.data === "string" && w.data.includes("MANAGER_DIRECTION_11A")));
    try { hostOn.stop?.(SID11a); } catch { /* best-effort */ }

    // (11b) TOGGLE-OFF CONTROL — identical setup, default host (coalesceAgentMessages:false). Same-sender
    // coalescing already protects this shape pre-fix (the direction has a DIFFERENT senderId, so the old
    // agent-kind run never extended past the composer head) — proves the round-3 fix doesn't regress it.
    const SID11b = "wkr-composer-head-coalesce-off";
    spawnReady(SID11b);
    host.enqueueStdin(SID11b, "T11B_FIRST_TURN");
    check("(11b) setup: markContextExhausted succeeds", host.markContextExhausted(SID11b) === true);
    host.writeStdin(SID11b, "unrelated raw keystrokes\r");
    const composer11b = host.enqueueStdin(SID11b, "COMPOSER_HEAD_11B", "human", undefined, undefined, "agent", undefined, "COMPOSER_HEAD_11B", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(11b) setup: the composer entry is held and is the head", composer11b.delivered === false);
    let directionDelivered11b = false;
    const direction11b = host.enqueueStdin(SID11b, "MANAGER_DIRECTION_11B", "system", () => { directionDelivered11b = true; }, undefined, "agent", undefined, undefined, undefined, "sender-11b");
    check("(11b) setup: the manager direction is held, queued behind the composer entry", direction11b.delivered === false);
    check("(11b) setup: pendingQueueDepth is 2", host.getPendingQueueDepth(SID11b) === 2);

    const deadline11b = Date.now() + HUMAN_SUBMIT_HOLD_TEST_MS * 10;
    let composerDrained11b = false;
    while (Date.now() < deadline11b) {
      host.reconcile();
      if (writes.some((w) => w.sessionId === SID11b && typeof w.data === "string" && w.data.includes("COMPOSER_HEAD_11B"))) { composerDrained11b = true; break; }
      // TIMING-GUARD-SAFE: poll-observes-prior-step — same reasoning as (11a)'s own identical loop just
      // above: the CONTROL checks below assert a fact already fully determined, synchronously, the
      // instant this loop's own write fires — nothing an additional wall-clock wait could change.
      await new Promise((r) => setTimeout(r, 10));
    }
    check("(11b) CONTROL: the composer entry drains once isHumanSubmitHeld clears", composerDrained11b);
    check("(11b) CONTROL: the direction is never folded into the composer's own write",
      writes.some((w) => w.sessionId === SID11b && typeof w.data === "string" && w.data.includes("COMPOSER_HEAD_11B") && !w.data.includes("MANAGER_DIRECTION_11B")));
    check("(11b) CONTROL: the direction entry stays queued (depth still 1)", host.getPendingQueueDepth(SID11b) === 1);
    check("(11b) CONTROL: the direction's own onDeliver never fired", directionDelivered11b === false);
  }

  // ===== (12) card 5f825506 ROUND 3 MINOR (a)+(c) — a give-up-HELD composer entry sitting behind a
  // non-composer head must NOT be picked by composerIdx's own scan (the `!this.isGiveUpHeld(m)` exclusion)
  // while its hold is still in force — nothing is eligible to drain. Once the hold expires, it drains
  // ALONE, spliced from behind the still-queued non-composer entry, which stays held, not dropped. (c)
  // extends this with a seeded `live.ambiguousDispatches` entry for the composer's own logicalId, proving
  // the shared drain tail's giveUpGen archive loop (`archiveAmbiguousDispatch` + `ambiguousDispatches.delete`)
  // actually ran for THIS composer-only splice path, not just the ordinary coalescing branches. Entries are
  // injected directly into `live.pending` (the same established pattern as
  // pty-giveup-recovery-alarm.mjs/pty-giveup-resend-bypass-unsuppressed-park.mjs) rather than driving a
  // real give-up through the timeout machinery — this file shares ONE process-wide SUBMIT_VERIFY_TIMEOUT_MS
  // with every other session in it, so forcing the real timers short enough to observe here would risk
  // firing unrelated give-up cycles for every OTHER still-unconfirmed session in this file. =====
  {
    const SID12 = "wkr-giveupheld-composer-skip";
    spawnReady(SID12);
    host.enqueueStdin(SID12, "T12_FIRST_TURN"); // delivers immediately (idle); busy=true, pending empty
    check("(12) setup: markContextExhausted succeeds", host.markContextExhausted(SID12) === true);
    check("(12) setup: pending queue is empty right after marking", host.getPendingQueueDepth(SID12) === 0);

    const live12 = host.live.get(SID12);
    const nonComposerId12 = "nc-12";
    const composerId12 = "gc-12";
    live12.pending.push({ id: nonComposerId12, text: "NON_COMPOSER_ENTRY_12", source: "system", kind: "agent", logicalId: nonComposerId12, senderId: "sender-12" });
    live12.pending.push({
      id: composerId12, text: "GIVEUP_HELD_COMPOSER_12", source: "human", kind: "agent", logicalId: composerId12,
      ownerText: "GIVEUP_HELD_COMPOSER_12", senderId: HUMAN_COMPOSER_SENDER_ID,
      giveUpGen: 1, giveUpHeldUntil: Date.now() + 10_000_000,
    });
    check("(12) setup: pendingQueueDepth is 2 (non-composer head, give-up-held composer entry behind it)", host.getPendingQueueDepth(SID12) === 2);

    // (c) seed ambiguousDispatches for the composer's own logicalId BEFORE the drain — this is what
    // archiveAmbiguousDispatch/the delete must act on once it actually drains.
    const seededSig12 = { len: 42, hash: "seeded-hash-12", writtenAt: Date.now() - 5000, batchId: 1, memberSig: { len: 42, hash: "seeded-hash-12" }, escapedSig: { len: 42, hash: "seeded-hash-12" } };
    live12.ambiguousDispatches.set(composerId12, seededSig12);

    host.reconcile();
    check("(12a) MINOR FIX PIN: nothing drains while the only composer entry is give-up-held — composerIdx finds no eligible entry (depth still 2)",
      host.getPendingQueueDepth(SID12) === 2 && busyLog[SID12]?.at(-1) === false);
    check("(12a) neither entry's text was written while the composer entry is still give-up-held",
      !writes.some((w) => w.sessionId === SID12 && typeof w.data === "string"
        && (w.data.includes("NON_COMPOSER_ENTRY_12") || w.data.includes("GIVEUP_HELD_COMPOSER_12"))));
    check("(12c) setup: the seeded ambiguousDispatches entry is untouched while the drain never ran", live12.ambiguousDispatches.has(composerId12));

    // Expire the hold, then drain — the composer entry (behind the non-composer head) must now be the
    // one that drains, ALONE.
    live12.pending.find((m) => m.id === composerId12).giveUpHeldUntil = Date.now() - 1;
    host.reconcile();
    check("(12a) once the hold expires, the composer entry drains ALONE (depth back to 1 — the non-composer entry stays held, not dropped)",
      host.getPendingQueueDepth(SID12) === 1 && live12.pending[0]?.id === nonComposerId12);
    check("(12a) the composer text WAS written", writes.some((w) => w.sessionId === SID12 && typeof w.data === "string" && w.data.includes("GIVEUP_HELD_COMPOSER_12")));
    check("(12a) the non-composer entry's text was NOT written (still held, not drained as a side effect)",
      !writes.some((w) => w.sessionId === SID12 && typeof w.data === "string" && w.data.includes("NON_COMPOSER_ENTRY_12")));
    check("(12c) THE FIX, THE ASSERTION THAT GOES RED WITHOUT IT: the shared drain tail's archive loop ran for this composer-only splice — the seeded ambiguousDispatches entry was DELETED",
      !live12.ambiguousDispatches.has(composerId12));
    check("(12c) and it was ARCHIVED first (not just dropped) — retiredGiveUpSignatures now holds the seeded signature for this logicalId",
      (live12.retiredGiveUpSignatures.get(composerId12) ?? []).some((e) => e.hash === "seeded-hash-12" && e.writtenAt === seededSig12.writtenAt));
  }

  // ===== (13) card 5f825506 ROUND 3 MINOR (b) — TWO composer entries queued FIFO while exhausted: the
  // FIRST one drains alone (never coalesced with the second, even though both share the SAME senderId,
  // kind, and route — the exact shape same-sender agent coalescing would otherwise fold together). The
  // second stays queued until its own turn, draining normally afterward — proving the "drain alone"
  // semantics hold across SUCCESSIVE composer entries, not just a composer-vs-non-composer pair. =====
  {
    const SID13 = "wkr-two-composer-fifo";
    spawnReady(SID13);
    host.enqueueStdin(SID13, "T13_FIRST_TURN");
    check("(13) setup: markContextExhausted succeeds", host.markContextExhausted(SID13) === true);
    check("(13) setup: pending queue is empty right after marking", host.getPendingQueueDepth(SID13) === 0);

    host.writeStdin(SID13, "unrelated raw keystrokes\r"); // arm isHumanSubmitHeld — both composer entries must queue, not bypass
    const c1_13 = host.enqueueStdin(SID13, "COMPOSER_FIRST_13", "human", undefined, undefined, "agent", undefined, "COMPOSER_FIRST_13", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(13) setup: the FIRST composer entry is held", c1_13.delivered === false);
    const c2_13 = host.enqueueStdin(SID13, "COMPOSER_SECOND_13", "human", undefined, undefined, "agent", undefined, "COMPOSER_SECOND_13", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(13) setup: the SECOND composer entry is also held, FIFO behind the first", c2_13.delivered === false);
    check("(13) setup: pendingQueueDepth is 2", host.getPendingQueueDepth(SID13) === 2);

    const deadline13 = Date.now() + HUMAN_SUBMIT_HOLD_TEST_MS * 10;
    let firstDrained13 = false;
    while (Date.now() < deadline13) {
      host.reconcile();
      if (writes.some((w) => w.sessionId === SID13 && typeof w.data === "string" && w.data.includes("COMPOSER_FIRST_13"))) { firstDrained13 = true; break; }
      // TIMING-GUARD-SAFE: poll-observes-prior-step — this loop's own condition is the first composer
      // entry's write being recorded; the FIFO/no-coalesce checks below assert a fact already fully
      // determined, synchronously, inside the SAME drainPending call that produced that write (whether
      // it also folded the second composer entry in) — no additional wall-clock wait could change it.
      await new Promise((r) => setTimeout(r, 10));
    }
    check("(13) FIFO: the FIRST composer entry drains first", firstDrained13);
    check("(13) FIFO FIX: the write carries ONLY the first composer's text — the second was never coalesced into it",
      writes.some((w) => w.sessionId === SID13 && typeof w.data === "string" && w.data.includes("COMPOSER_FIRST_13") && !w.data.includes("COMPOSER_SECOND_13")));
    check("(13) the SECOND composer entry stays queued, not drained alongside the first (depth 1)", host.getPendingQueueDepth(SID13) === 1);
    check("(13) the second entry's text was not written during the first's drain", !writes.some((w) => w.sessionId === SID13 && typeof w.data === "string" && w.data.includes("COMPOSER_SECOND_13")));

    // End the first composer's own turn — its rising edge already cleared contextExhausted, so the
    // second now drains via the ordinary (ever-present) busy-queue path, proving it isn't stranded.
    host.deliverHook(SID13, { hook_event_name: "Stop" });
    check("(13) the second composer entry now drains too, once its own turn comes (depth back to 0)", host.getPendingQueueDepth(SID13) === 0);
    check("(13) the second composer's text WAS eventually written", writes.some((w) => w.sessionId === SID13 && typeof w.data === "string" && w.data.includes("COMPOSER_SECOND_13")));
  }

  // ===== (14) card da8b2fc6, kept GREEN by card b70eade0 — COMPOSER-TO-COMPOSER FIFO: A is held by
  // isHumanSubmitHeld (a DIFFERENT conjunct than the exhaustion bail), that hold clears, then B arrives
  // — with NO reconcile() call made anywhere in this block. B's own `live.pending.length === 0`
  // disjunct can't fire (A already queued), so B unconditionally takes the held-push path. =====
  {
    const SID14 = "wkr-composer-fifo-olderqueued";
    spawnReady(SID14);
    host.enqueueStdin(SID14, "T14_FIRST_TURN"); // delivers immediately; busy=true
    check("(14) setup: markContextExhausted succeeds", host.markContextExhausted(SID14) === true);

    host.writeStdin(SID14, "unrelated raw keystrokes\r"); // arms isHumanSubmitHeld
    const a14 = host.enqueueStdin(SID14, "COMPOSER_A_OLDER_14", "human", undefined, undefined, "agent", undefined, "COMPOSER_A_OLDER_14", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(14) setup: A is HELD (isHumanSubmitHeld blocks it), not delivered", a14.delivered === false);
    check("(14) setup: pendingQueueDepth is 1", host.getPendingQueueDepth(SID14) === 1);

    // Let A's OTHER hold (isHumanSubmitHeld) expire — NO reconcile()/drainPending call here. A just
    // sits in live.pending, now genuinely eligible, untouched.
    await new Promise((r) => setTimeout(r, HUMAN_SUBMIT_HOLD_TEST_MS + 40));
    check("(14) setup: still depth 1 after waiting out A's hold — nothing has drained it yet", host.getPendingQueueDepth(SID14) === 1);
    check("(14) setup: neither A nor any write has happened yet",
      !writes.some((w) => w.sessionId === SID14 && typeof w.data === "string" && w.data.includes("COMPOSER_A_OLDER_14")));

    // B arrives. `live.pending.length === 0` is false (A is still queued), so B unconditionally falls
    // to the ordinary held push — whose own PRE-EXISTING `if (idleEligible) { this.drainPending(...) }`
    // branch then drains A SYNCHRONOUSLY, inside this SAME enqueueStdin(B) call. No reconcile(), no timer.
    const b14 = host.enqueueStdin(SID14, "COMPOSER_B_NEWER_14", "human", undefined, undefined, "agent", undefined, "COMPOSER_B_NEWER_14", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(14) THE FIX: B is HELD (queued FIFO-behind A), never an immediate bypass", b14.delivered === false);

    const aIdx14 = writes.findIndex((w) => w.sessionId === SID14 && typeof w.data === "string" && w.data.includes("COMPOSER_A_OLDER_14"));
    const bIdx14 = writes.findIndex((w) => w.sessionId === SID14 && typeof w.data === "string" && w.data.includes("COMPOSER_B_NEWER_14"));
    check("(14) THE FIX, THE ASSERTION THAT GOES RED WITHOUT IT: A's write was observed (drained inside B's OWN enqueueStdin call — no external event)", aIdx14 !== -1);
    check("(14) B's text was NOT written yet (still queued behind A)", bIdx14 === -1);
    check("(14) pendingQueueDepth is 1 (B alone, queued — A already drained)", host.getPendingQueueDepth(SID14) === 1);

    // B drains normally once A's own turn ends — not lost, just FIFO-ordered behind A.
    host.deliverHook(SID14, { hook_event_name: "Stop" });
    check("(14) B drains normally once A's turn completes (depth back to 0)", host.getPendingQueueDepth(SID14) === 0);
    const bIdx14b = writes.findIndex((w) => w.sessionId === SID14 && typeof w.data === "string" && w.data.includes("COMPOSER_B_NEWER_14"));
    check("(14) B's text WAS eventually written, and strictly AFTER A's own write", bIdx14b !== -1 && bIdx14b > aIdx14);
  }

  // ===== (15) card da8b2fc6, kept GREEN by card b70eade0 (see (14) above) — the GIVE-UP-HOLD variant of
  // (14): A is injected directly as an ALREADY-EXPIRED give-up hold (the established pattern from test
  // (12)), never driven through the real give-up timeout. Same assertion: A's write precedes B's, with
  // NO reconcile() anywhere. =====
  {
    const SID15 = "wkr-composer-fifo-giveup-olderqueued";
    spawnReady(SID15);
    host.enqueueStdin(SID15, "T15_FIRST_TURN"); // delivers immediately; busy=true
    check("(15) setup: markContextExhausted succeeds", host.markContextExhausted(SID15) === true);
    check("(15) setup: pending queue is empty right after marking", host.getPendingQueueDepth(SID15) === 0);

    const live15 = host.live.get(SID15);
    const composerA15Id = "gc-15";
    live15.pending.push({
      id: composerA15Id, text: "COMPOSER_A_GIVEUP_15", source: "human", kind: "agent", logicalId: composerA15Id,
      ownerText: "COMPOSER_A_GIVEUP_15", senderId: HUMAN_COMPOSER_SENDER_ID,
      giveUpGen: 1, giveUpHeldUntil: Date.now() - 1, // ALREADY expired — eligible right now
    });
    check("(15) setup: pendingQueueDepth is 1 (A injected, give-up hold already expired)", host.getPendingQueueDepth(SID15) === 1);

    // B arrives — NO reconcile() call anywhere in this block.
    const b15 = host.enqueueStdin(SID15, "COMPOSER_B_NEWER_15", "human", undefined, undefined, "agent", undefined, "COMPOSER_B_NEWER_15", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(15) THE FIX: B is HELD (queued FIFO-behind A), never an immediate bypass", b15.delivered === false);

    const aIdx15 = writes.findIndex((w) => w.sessionId === SID15 && typeof w.data === "string" && w.data.includes("COMPOSER_A_GIVEUP_15"));
    const bIdx15 = writes.findIndex((w) => w.sessionId === SID15 && typeof w.data === "string" && w.data.includes("COMPOSER_B_NEWER_15"));
    check("(15) THE FIX, THE ASSERTION THAT GOES RED WITHOUT IT: A's write was observed (drained inside B's OWN enqueueStdin call — no external event)", aIdx15 !== -1);
    check("(15) B's text was NOT written yet (still queued behind A)", bIdx15 === -1);
    check("(15) pendingQueueDepth is 1 (B alone, queued — A already drained)", host.getPendingQueueDepth(SID15) === 1);

    host.deliverHook(SID15, { hook_event_name: "Stop" });
    check("(15) B drains normally once A's turn completes (depth back to 0)", host.getPendingQueueDepth(SID15) === 0);
    const bIdx15b = writes.findIndex((w) => w.sessionId === SID15 && typeof w.data === "string" && w.data.includes("COMPOSER_B_NEWER_15"));
    check("(15) B's text WAS eventually written, and strictly AFTER A's own write", bIdx15b !== -1 && bIdx15b > aIdx15);
  }

  // ===== (16) card b70eade0 — NEW: the first composer message queued BEHIND ONLY undeliverable
  // non-composer entries is delivered while exhausted, purely via drainPending's own exhausted-branch
  // composer scan (5f825506 round 3) — enqueueStdin's own composer fast path is gone (card b70eade0),
  // so this now runs through the SAME held-push + synchronous drainPending fallthrough every other held
  // entry uses. NO reconcile() call anywhere in this block. Two non-composer entries (N1, N2, same
  // sender — undeliverable while exhausted, neither is the composer) queue first; the composer entry
  // (C) then drains ALONE, synchronously, inside its OWN enqueueStdin call, leaving N1/N2 queued,
  // UNTOUCHED, in their original relative order (checked via getPending(), not just depth — depth alone
  // can't tell two entries apart from one reordered pair). A THIRD non-composer entry (N3, same sender
  // as N1/N2) then arrives — a non-composer arrival strictly LATER than C's own write (the only
  // reachable "later" shape: C's own rising edge clears contextExhausted the instant it drains,
  // synchronously within its own enqueueStdin call, so nothing can interleave between C's push and its
  // own drain) — and must not retroactively disturb C's already-completed write or reorder ahead of
  // N1/N2: it queues at the tail, FIFO, behind both. =====
  try {
    const SID16 = "wkr-composer-behind-noncomposer-only";
    spawnReady(SID16);
    host.enqueueStdin(SID16, "T16_FIRST_TURN"); // delivers immediately; busy=true, pending empty
    check("(16) setup: markContextExhausted succeeds", host.markContextExhausted(SID16) === true);
    check("(16) setup: pending queue is empty right after marking", host.getPendingQueueDepth(SID16) === 0);

    const n1_16 = host.enqueueStdin(SID16, "NONCOMPOSER_N1_16", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-16nc");
    check("(16) setup: N1 (non-composer) is held", n1_16.delivered === false);
    const n2_16 = host.enqueueStdin(SID16, "NONCOMPOSER_N2_16", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-16nc");
    check("(16) setup: N2 (non-composer) is also held, FIFO behind N1", n2_16.delivered === false);
    check("(16) setup: pendingQueueDepth is 2 (N1, N2 — both undeliverable while exhausted)", host.getPendingQueueDepth(SID16) === 2);
    check("(16) setup: N1 then N2, in that exact order", JSON.stringify(host.getPending(SID16)) === JSON.stringify(["NONCOMPOSER_N1_16", "NONCOMPOSER_N2_16"]));

    // THE FIX: C is HELD ONLY behind two entries that are themselves undeliverable while exhausted —
    // never special-cased by enqueueStdin's own composer fast path (deleted, card b70eade0) — so it
    // falls to the ordinary held-push path, whose own PRE-EXISTING
    // `if (idleEligible) { this.drainPending(...) }` branch drains it SYNCHRONOUSLY, inside this SAME
    // enqueueStdin(C) call, via drainPending's exhausted-branch composer scan finding it regardless of
    // its push position. No reconcile(), no timer, no second composer message.
    const c16 = host.enqueueStdin(SID16, "COMPOSER_C_16", "human", undefined, undefined, "agent", undefined, "COMPOSER_C_16", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(16) THE FIX: the composer entry delivers, drained alone from behind two undeliverable non-composer entries, with NO reconcile() anywhere", c16.delivered === true);
    check("(16) its own submit's rising edge cleared contextExhausted (busy flips true)", busyLog[SID16]?.at(-1) === true);
    check("(16) the composer text WAS handed to write() — the ONLY thing written while exhausted",
      writes.some((w) => w.sessionId === SID16 && typeof w.data === "string" && w.data.includes("COMPOSER_C_16")));
    check("(16) N1 and N2 are STILL queued, untouched (depth still 2 — not drained, not dropped, not coalesced into C's write)",
      host.getPendingQueueDepth(SID16) === 2);
    check("(16) N1 and N2 are STILL in their original relative order (no reordering — splice removed C, not N1/N2)",
      JSON.stringify(host.getPending(SID16)) === JSON.stringify(["NONCOMPOSER_N1_16", "NONCOMPOSER_N2_16"]));
    check("(16) neither N1's nor N2's text was written",
      !writes.some((w) => w.sessionId === SID16 && typeof w.data === "string"
        && (w.data.includes("NONCOMPOSER_N1_16") || w.data.includes("NONCOMPOSER_N2_16"))));

    // A non-composer entry arriving strictly LATER than C's own (already-completed) write. By the time
    // this call runs, C's rising edge has already cleared contextExhausted and armed busy=true (C's own
    // turn is in flight) — this is the only reachable "later" shape (see the block comment above) — and
    // N3 must queue at the TAIL, FIFO-behind N1/N2, never ahead of them and never disturbing C's write.
    const n3_16 = host.enqueueStdin(SID16, "NONCOMPOSER_N3_16", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-16nc");
    check("(16) a LATER non-composer arrival (N3) is held, same as any ordinary busy-queue entry", n3_16.delivered === false);
    check("(16) N3 does NOT disturb C's already-completed write — still the only write recorded so far",
      writes.filter((w) => w.sessionId === SID16 && typeof w.data === "string"
        && (w.data.includes("COMPOSER_C_16") || w.data.includes("NONCOMPOSER_N1_16") || w.data.includes("NONCOMPOSER_N2_16") || w.data.includes("NONCOMPOSER_N3_16"))).length === 1);
    check("(16) N3 queues at the TAIL — N1, N2, N3 in that exact FIFO order, never reordered ahead of N1/N2",
      JSON.stringify(host.getPending(SID16)) === JSON.stringify(["NONCOMPOSER_N1_16", "NONCOMPOSER_N2_16", "NONCOMPOSER_N3_16"]));

    // Closing: end C's own turn — N1/N2/N3 share one sender/route/proactive, so the ordinary same-sender
    // coalescing run drains all three together on this single Stop, proving none were lost or stranded.
    host.deliverHook(SID16, { hook_event_name: "Stop" });
    check("(16) N1/N2/N3 all drain once C's own turn completes (depth back to 0)", host.getPendingQueueDepth(SID16) === 0);
    check("(16) all three eventually written, coalesced into ONE turn, in FIFO order",
      writes.some((w) => {
        if (w.sessionId !== SID16 || typeof w.data !== "string") return false;
        const i1 = w.data.indexOf("NONCOMPOSER_N1_16");
        const i2 = w.data.indexOf("NONCOMPOSER_N2_16");
        const i3 = w.data.indexOf("NONCOMPOSER_N3_16");
        // All three must actually be present — an absent substring's indexOf(-1) would otherwise
        // satisfy a naive `<` comparison against a present one and pass for the wrong reason.
        return i1 >= 0 && i2 >= 0 && i3 >= 0 && i1 < i2 && i2 < i3;
      }));
  } finally {
    try { host.stop?.("wkr-composer-behind-noncomposer-only"); } catch { /* best-effort */ }
  }
} finally {
  try { host.stop?.("wkr-drain-hold"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-ordinary-drain"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-rising-edge-clear"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-empty-queue-exhausted"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-composer-negative"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-composer-positive"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-composer-preheld"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-composer-strand-fix"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-composer-strand-fix-preheld"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-busysincems-seam"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-composer-head-coalesce-off"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-giveupheld-composer-skip"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-two-composer-fifo"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-composer-fifo-olderqueued"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-composer-fifo-giveup-olderqueued"); } catch { /* best-effort */ }
}

// ===== (5) DB-level clear: stamped, then cleared via the REAL rising-edge chokepoint
// (`SessionService.handleBusyEdge(id, true)`, card 7b1b2b3f) — never a hand-copied direct
// `Db.clearContextExhaustedOnResume` call, so a revert of that production call's own
// `if (busy) this.db.clearContextExhaustedOnResume(...)` line (sessions/service.ts) fails THIS file, not
// just worker-context-warning-advisory.mjs's own (J). Guarded against an unrelated lastError on a row
// that was never exhausted. None of these rows carry a `parentSessionId`, so `handleBusyEdge`'s own
// `purgeStaleIdleNudgeForReengagedWorker` returns before ever touching `pty` — a bare `{}` stand-in for
// the PtyHost argument is sufficient; no seam/fixture needed for this leg. =====
{
  const dbFile = path.join(os.tmpdir(), `loom-ctxexh-drain-db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const sessions = new SessionService(db, {}, new OrchestrationControl());
  const now = "2026-11-02T21:30:00.000Z";
  const projId = "proj-ctxexh-drain";
  const agentId = "agent-ctxexh-drain";
  db.insertProject({ id: projId, name: "CtxExhDrainDb", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  db.insertSession({ id: "s-exh", projectId: projId, agentId, engineSessionId: "eng-s-exh", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker" });
  db.insertSession({ id: "s-clean", projectId: projId, agentId, engineSessionId: "eng-s-clean", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: "an UNRELATED crash-loop banner", role: "worker" });

  try {
    db.setContextExhausted("s-exh", now, "Context exhausted — test stamp.");
    let row = db.getSession("s-exh");
    check("(5) setContextExhausted stamps contextExhaustedAt + lastError", row.contextExhaustedAt === now && /test stamp/.test(row.lastError ?? ""));

    sessions.handleBusyEdge("s-exh", true);
    row = db.getSession("s-exh");
    check("(5) handleBusyEdge(busy=true) clears contextExhaustedAt", row.contextExhaustedAt === null);
    check("(5) handleBusyEdge(busy=true) ALSO clears the exhaustion lastError (it was this call's own stamp)", row.lastError === null);

    // Guard: a row that was NEVER exhausted — its own unrelated lastError must survive untouched.
    sessions.handleBusyEdge("s-clean", true);
    const clean = db.getSession("s-clean");
    check("(5) GUARD: calling handleBusyEdge(busy=true) on a never-exhausted row leaves its unrelated lastError completely untouched",
      clean.lastError === "an UNRELATED crash-loop banner" && clean.contextExhaustedAt === null);

    // Round 2 (CR finding #6): a row RE-marked exhausted, then OVERWRITTEN by something unrelated
    // (a crash-loop banner landing after the exhaustion stamp, before the next turn-start) must keep
    // that unrelated LATER lastError untouched too — the old unconditional clear used to wipe it
    // purely because context_exhausted_at was still set, with no regard for what lastError had become.
    db.insertSession({ id: "s-overwritten", projectId: projId, agentId, engineSessionId: "eng-s-overwritten", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker" });
    db.setContextExhausted("s-overwritten", now, "Context exhausted — the engine rejected the next prompt as too long (Prompt is too long).");
    db.setContextExhausted("s-overwritten", now, "an UNRELATED crash-loop banner landing AFTER the exhaustion stamp");
    let overwritten = db.getSession("s-overwritten");
    check("(5) round-2 setup: contextExhaustedAt is still set after the overwrite (the mark itself wasn't touched)", overwritten.contextExhaustedAt === now);
    check("(5) round-2 setup: lastError now holds the LATER, unrelated banner, not the exhaustion text", overwritten.lastError === "an UNRELATED crash-loop banner landing AFTER the exhaustion stamp");

    sessions.handleBusyEdge("s-overwritten", true);
    overwritten = db.getSession("s-overwritten");
    check("(5) round-2: handleBusyEdge(busy=true) still clears contextExhaustedAt", overwritten.contextExhaustedAt === null);
    check("(5) round-2: but it does NOT clobber the LATER unrelated lastError (prefix no longer matches)",
      overwritten.lastError === "an UNRELATED crash-loop banner landing AFTER the exhaustion stamp");

    // Positive counterpart: a row whose lastError STILL carries the exhaustion prefix clears exactly
    // as before (the fix narrows the clear, it does not disable it).
    db.setContextExhausted("s-overwritten", now, "Context exhausted — the engine rejected the next prompt as too long (Prompt is too long).");
    sessions.handleBusyEdge("s-overwritten", true);
    overwritten = db.getSession("s-overwritten");
    check("(5) round-2: a lastError STILL carrying the exhaustion prefix DOES clear", overwritten.lastError === null && overwritten.contextExhaustedAt === null);
  } finally {
    try { db.close(); } catch { /* ignore */ }
    for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — once a session is marked context-exhausted, its held queue survives both the exhaustion-clearing-busy side effect AND the periodic reconcile() drain safety net (proven against a negative control: an ORDINARY session's queue DOES drain on an ordinary Stop, so the hold is specific to contextExhausted, not a general freeze); a fresh UserPromptSubmit rising edge (the real resume/next-turn chokepoint) clears the in-memory hold end-to-end (a message queued after it DOES drain on the next Stop); round 2's mutant-B2 catch proves the hold also fires on an EMPTY queue (not just a pre-populated one); the HUMAN_COMPOSER_SENDER_ID exemption lets a human's own composer entry deliver despite exhaustion while an ordinary agent entry on the identical setup stays held — round 3 proves that exemption ALSO fires with a PRE-HELD entry already queued ahead of it, with the pre-held entry staying held and draining normally once the composer's own turn completes; card 5f825506 item 2 (test 9) proves the STRAND FIX: a composer entry that's ALSO blocked by a DIFFERENT conjunct (isHumanSubmitHeld) when it arrives lands held exactly as before, then drains via the ordinary reconcile() safety net alone once that OTHER conjunct clears — no second composer message ever sent; round 2 (test 9b) proves the fix also reaches past a PRE-HELD, NON-COMPOSER entry sitting ahead of the composer's own recovery entry — the composer drains OUT OF ORDER once the other conjunct clears, leaving that agent entry queued and held, not drained or dropped; round 2 (test 10) is a REAL-PtyHost seam test proving the genuine `busySinceMs` stamp — not a fake/stub — correctly feeds detectContextExhaustionInTail's own stale-marker cutoff, rejecting an older-than-turn marker and still detecting a newer one; round 3 (test 11) proves drainPending ALWAYS takes the single-composer-entry path while exhausted, head or not — closing the gap where a composer entry that was ITSELF the head fell through to the ordinary coalescing branches, letting a `coalesceAgentMessages:true` route-keyed run fold a queued manager direction into the composer's own recovery turn (test 11a), with a toggle-OFF control (11b) showing that shape was never exposed there; round 3 (test 12) proves a give-up-HELD composer entry is correctly excluded from that same splice scan until its hold expires, and that the shared drain tail's giveUpGen archive loop (archiveAmbiguousDispatch + ambiguousDispatches.delete) runs for this composer-only splice too, not just the ordinary coalescing branches; round 3 (test 13) proves two queued composer entries drain FIFO, one at a time, never coalesced together even though they share sender/kind/route; and the DB-level clear, driven through the REAL `SessionService.handleBusyEdge(id, true)` chokepoint (card 7b1b2b3f), correctly resets the mark while leaving an unrelated session's own lastError completely untouched — both for a row never exhausted AND for one re-exhausted-then-overwritten by something unrelated."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
