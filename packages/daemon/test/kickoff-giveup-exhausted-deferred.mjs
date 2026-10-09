import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 39b0e9b7 — "scheduleKickoffGuarantee's DEFERRED branch (the `enqueueStdin(kickoff, …)` queue
// push taken when a direct write isn't safe yet — submitOutstanding/stopping/drainHeld/rateLimited/a
// boot dialog/an in-flight mode cycle) carries NO `onGiveUpExhausted` and no kickoff ids at all, unlike
// the DIRECT submit() branch (see kickoff-giveup-exhausted.mjs's own (H1)/(H2), fixed by card a8f8a8f2)."
//
// ROOT CAUSE: before this card, only the direct-submit branch minted `kickoffMsgId`/`kickoffLogicalId`
// and wired `onGiveUpExhausted` into its synthetic `QueuedMessage` origin. The deferred branch's bare
// `enqueueStdin(sessionId, kickoff, "system", undefined, undefined, "agent")` call passed none of that
// — so a QUEUED kickoff that then gave up twice (GIVE_UP_REQUEUE_LIMIT=1) took `requeueGiveUpOrigin`'s
// residual bare-drop path (console.error only), silently losing the whole task dispatch exactly like
// the pre-a8f8a8f2 direct-path bug, but for the deferred branch, which a8f8a8f2 never touched.
//
// THE FIX: `buildKickoffGiveUpOptions` (pty/host.ts) mints the msgId/logicalId/hook ONCE, before the
// branch split, and the deferred branch now passes `{ onGiveUpExhausted, logicalId }` as `enqueueStdin`'s
// tail — reusing enqueueStdin's own existing, already-correct held-entry construction (it already splices
// `onGiveUpExhausted`/`logicalId` onto the QueuedMessage it pushes for ANY caller that supplies them, per
// cards ccb407eb/3f09f9ce), rather than adding a second give-up path.
//
// This suite proves, via the SAME silent fake pty as kickoff-giveup-exhausted.mjs (every give-up here is
// a genuine drop, not a timing coincidence), mirroring that file's own (H1)/(H2) structure one-for-one
// but for the DEFERRED delivery path instead of the direct one:
//   SETUP: `live.rateLimited` is forced true BEFORE SessionStart fires, so `scheduleKickoffGuarantee`'s
//          own "unsafe to write directly" branch is the one that runs (never the direct submit() branch)
//          — proven by the kickoff landing in `getPendingEntries`, not written to the pty, immediately
//          after SessionStart.
//   (D1) POSITIVE, forced deterministically: once drained (rateLimited cleared + reconcile), a deferred
//        kickoff that gives up TWICE in a row — cycle 1 requeues (budget not yet exhausted — the hook
//        must NOT have fired at that point), cycle 2 exceeds GIVE_UP_REQUEUE_LIMIT and EXHAUSTS —
//        onKickoffGiveUpExhausted fires exactly once, only after the second give-up.
//   (D2) THE DISCRIMINATING NEGATIVE CONTROL: a deferred kickoff that gives up ONCE, requeues, and then
//        the second attempt actually LANDS (a real confirming hook arrives) must NEVER exhaust.
//
// SessionService.handleKickoffGiveUpExhausted's own "parked + notified" behavior (naming worker_stop +
// worker_spawn, explicitly ruling out worker_message/worker_merge, the durable park event, the retraction
// path, etc.) is UNCHANGED by this card and already fully covered by kickoff-giveup-exhausted.mjs's own
// (S1)-(S14) — that handler is agnostic to which PtyHost branch invoked it, so duplicating those
// assertions here would test the same code twice for no new coverage. This suite instead proves the ONE
// thing that was actually broken: that the DEFERRED branch fires the SAME hook, with the SAME shape, that
// the direct branch always has.
//
// RUN: pnpm build (from packages/daemon) then `node test/kickoff-giveup-exhausted-deferred.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil, sleepPast } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn).
const tmpHome = path.join(os.tmpdir(), `loom-kickoff-exhausted-deferred-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
const SETTLE_POLL = 5;
const SETTLE_MAX_POLLS = 3;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
// The bound this suite is guarding — pinned explicitly (matches production's own default of 1) so the
// test doesn't silently drift if that default is ever retuned. Mirrors kickoff-giveup-exhausted.mjs.
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
const HOLD_MS = 10;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
const HOLD_WAIT = HOLD_MS + 20;
// The kickoff delivery itself gates on logLandedMode's footer-read poll settling first — shrink it so
// this suite's silent fake pty (which never paints a footer) doesn't wait out the production default.
process.env.LOOM_MODE_LOG_POLL_MS = "5";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
const busyLog = {};
const exhaustedLog = {};
const events = {
  onEngineSessionId() {},
  onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
  onKickoffGiveUpExhausted(id) { (exhaustedLog[id] ??= []).push(true); },
};

/** A fake pty that never emits output — every give-up this drives is a genuine drop (mirrors
 *  kickoff-giveup-exhausted.mjs's own SilentTestPtyHost). */
class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}
const host = new SilentTestPtyHost(events);

/** Spawns, then forces `live.rateLimited = true` BEFORE delivering SessionStart, so
 *  `scheduleKickoffGuarantee`'s own "unsafe to write directly" branch is the one that runs once its
 *  setTimeout(0) tick fires — the kickoff lands in `live.pending`, never written to the pty directly. */
function spawnDeferred(sessionId, startupPrompt) {
  host.spawn({
    sessionId, cwd: tmpHome, startupPrompt,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const live = host.live.get(sessionId);
  live.rateLimited = true;
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { live, fake, bodyCount: (text) => fake.writes.join("").split(text).length - 1 };
}

try {
  // ================ SETUP CHECK, shared premise for both scenarios: the kickoff really did take the ====
  // ================ DEFERRED branch (queued, never written directly) while rateLimited stayed true =====
  {
    const SID = "deferred-setup-check";
    const KICKOFF = "orchestrate task tk-setup — rateLimited must force the deferred queue branch";
    const { live, bodyCount } = spawnDeferred(SID, KICKOFF);
    await sharedWaitUntil(() => host.getPendingEntries(SID).length === 1, { timeoutMs: 10_000, intervalMs: 2 });
    check("SETUP: the kickoff was queued (deferred branch), not written to the pty directly",
      host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === KICKOFF);
    check("SETUP: NEGATIVE CONTROL — nothing was written to the pty while deferred", bodyCount(KICKOFF) === 0);
    check("SETUP: rateLimited is still true (nothing cleared it on its own)", live.rateLimited === true);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ================ (D1) POSITIVE: two silent give-ups on a DEFERRED kickoff EXHAUST — the hook fires ===
  // ================ exactly once, only after the SECOND, budget-exceeding give-up, never the first ======
  {
    const SID = "deferred-exhaust-pos";
    const KICKOFF = "orchestrate task tk-deferred-exhaust — two silent give-ups on a QUEUED kickoff must EXHAUST";
    const { live, bodyCount } = spawnDeferred(SID, KICKOFF);
    await sharedWaitUntil(() => host.getPendingEntries(SID).length === 1, { timeoutMs: 10_000, intervalMs: 2 });
    check("(D1) setup: the deferred kickoff is queued, held by rateLimited", host.getPendingEntries(SID).length === 1);

    // Clear the hold and drain it — this is the kickoff's FIRST actual delivery attempt (cycle 1).
    // `busy` is also forced false here: it's still the spawn-time OPTIMISTIC true (set before any real
    // submit ever ran), and `drainPending`'s own busy-gate (`live.busy || ...`) would otherwise bail out
    // silently — in production, `rateLimited` only clears for a session that genuinely finished (or never
    // started) a real turn, so busy is already false by the time that happens; this simulates that.
    live.rateLimited = false;
    host.setBusy(SID, false, "test-force-idle");
    host.reconcile();
    check("(D1) reconcile drained the deferred kickoff: busy armed", busyLog[SID]?.at(-1) === true);

    // Cycle 1: never confirmed → give-up #1 → within budget (GIVE_UP_REQUEUE_LIMIT=1) → REQUEUED.
    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    check("(D1) cycle 1 gave up: the kickoff was requeued (not dropped)",
      host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === KICKOFF);
    check("(D1) NEGATIVE CONTROL: after ONE give-up that successfully requeues, onKickoffGiveUpExhausted has NOT fired",
      !exhaustedLog[SID]);

    // Drain the requeued kickoff (past its hold) — cycle 2's attempt. Card 1584084e: rewritten to
    // sleepPast's mechanical "exceeds a threshold" proof — HOLD_WAIT is asserted (not just claimed) to
    // clear the PINNED LOOM_GIVE_UP_HOLD_MS deadline (HOLD_MS) this exact process set via env var above,
    // not a guessed race — the hold is a real timestamp comparison (`Date.now() < giveUpHeldUntil`) the
    // entry carries, so waiting past the known deadline deterministically clears it; mirrors
    // kickoff-giveup-exhausted.mjs's own (already-committed, hence unscanned) identical HOLD_WAIT pattern.
    await sleepPast(HOLD_WAIT, HOLD_MS, "HOLD_WAIT past LOOM_GIVE_UP_HOLD_MS");
    host.reconcile();
    check("(D1) reconcile drained the requeued kickoff: busy re-armed", busyLog[SID].at(-1) === true);

    // Cycle 2 ALSO never confirms — this SECOND give-up exceeds GIVE_UP_REQUEUE_LIMIT(1) → EXHAUSTED.
    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    check("(D1) THE FIX: onKickoffGiveUpExhausted fired exactly once, after the SECOND give-up — "
      + "RED on pre-fix code (the deferred branch's bare enqueueStdin call had no onGiveUpExhausted to fire)",
      exhaustedLog[SID]?.length === 1);
    check("(D1) BOUNDED: the kickoff is finally gone from pending — handed to onGiveUpExhausted, not looping forever",
      host.getPendingEntries(SID).length === 0);
    check("(D1) the kickoff body was written to the pty exactly ONCE across both cycles (card b9b8f8db's "
      + "Enter-only redelivery applies here too)", bodyCount(KICKOFF) === 1);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ================ (D2) THE DISCRIMINATING NEGATIVE CONTROL: one give-up on a deferred kickoff, then a =
  // ================ REAL confirm — must NEVER exhaust (proves the hook reacts to genuine exhaustion only) =
  {
    const SID = "deferred-exhaust-neg-recovers";
    const KICKOFF = "orchestrate task tk-deferred-recovers — one give-up then a real confirm must NEVER exhaust";
    const { live } = spawnDeferred(SID, KICKOFF);
    await sharedWaitUntil(() => host.getPendingEntries(SID).length === 1, { timeoutMs: 10_000, intervalMs: 2 });

    live.rateLimited = false;
    host.setBusy(SID, false, "test-force-idle");
    host.reconcile();
    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 }); // cycle 1 gives up, requeues
    check("(D2) setup: cycle 1 gave up, requeued", host.getPendingEntries(SID).length === 1);
    check("(D2) setup: not exhausted after the first give-up", !exhaustedLog[SID]);

    await sleep(HOLD_WAIT);
    host.reconcile(); // drains the requeued kickoff — cycle 2 begins

    // This time a REAL confirming hook arrives — the second attempt LANDS normally, no second give-up ever.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(D2) NEGATIVE CONTROL: a deferred kickoff that gives up once then genuinely lands NEVER exhausts",
      !exhaustedLog[SID]);
    check("(D2) nothing left pending after a clean finish", host.getPendingEntries(SID).length === 0);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 39b0e9b7: scheduleKickoffGuarantee's DEFERRED branch (taken when a direct write "
    + "isn't safe yet, e.g. rateLimited) now wires onGiveUpExhausted + kickoff ids through the SAME shared "
    + "buildKickoffGiveUpOptions helper the direct branch uses — two forced silent give-ups on a QUEUED "
    + "kickoff EXHAUST and fire the hook exactly once (never on the first, requeue-eligible give-up, and "
    + "never when the second attempt genuinely lands)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
