// Hermetic regression test for card 73d5c34a — "hold a give-up requeue until its confirmation resolves,
// not until a timer" (pty/host.ts requeueGiveUpOrigin/isGiveUpHeld/drainPending/purgeConfirmedGiveUpRequeue).
//
// ROOT CAUSE being guarded (already documented in-code, and captured as a LIVE production specimen — see
// pinned project memory `duplicate-manager-reports-are-04de8bbf-live-specimen`): `requeueGiveUpOrigin`
// unshifts a GIVE-UP-recovered entry onto the FRONT of `live.pending`, tagged `giveUpGen`, so a LATE
// confirming hook (`purgeConfirmedGiveUpRequeue`) can drop it if it proves the original turn actually
// ran. Pre-fix, that requeued entry was ordinary drainable content the instant it landed in `pending` — so
// the ~10s reconcile tick (simulated here via a direct `host.reconcile()` call, same convention as the
// sibling suites) could resubmit it BEFORE the late hook ever arrived to purge it, double-delivering the
// same text. The pre-fix in-code comment at `purgeConfirmedGiveUpRequeue` named this exact residual.
//
// THE FIX: `requeueGiveUpOrigin` also stamps `giveUpHeldUntil` (now + `GIVE_UP_HOLD_MS`) on the requeued
// entry. `drainPending` skips any entry that is still `isGiveUpHeld` when choosing what to drain — it
// cannot be resubmitted while a late hook could still purge it — but does NOT stop searching there: the
// first NON-held entry becomes the effective head, so a held entry can never stall unrelated queued
// messages behind it. If no confirming hook ever arrives, the hold expires and the entry falls through to
// drain normally — the pre-existing card 441499ee silent-drop protection, unchanged.
//
// This suite proves, against a fake pty that NEVER emits output (so every give-up is a genuine drop, not
// the false-negative/SUPPRESSED case — that's pty-giveup-false-negative.mjs's job):
//   (1) RED-FIRST: the exact specimen shape — a give-up requeue, then a reconcile tick, THEN a late
//       confirming hook — must never double-deliver. Against pre-fix code this FAILS: the reconcile tick
//       resubmits the entry before the hook can purge it (busy re-arms, the body is written a second
//       time). Against the fix it PASSES: the reconcile tick is a no-op while held, and the late hook
//       purges the untouched entry, so the body is written exactly once.
//   (2) NO STALL: a held entry must never block an unrelated queued message behind it — a reconcile tick
//       drains the unrelated message while the held entry stays in place, untouched.
//   (3) GENUINE GIVE-UP: with no confirming hook ever arriving, the held entry still recovers and
//       delivers exactly once (card 441499ee's protection intact) once its bounded hold expires — proving
//       the hold is a delay, never a silent-drop reintroduction.
//   (4) RED-FIRST (code-review follow-up on this same card): a held entry must survive a FRESH, unrelated
//       generation's own normal confirmation. purgeConfirmedGiveUpRequeue's FIFO-front correlation
//       (card 09e655d5) assumed the next hook, whatever it is, most likely confirms the OLDEST still-
//       ambiguous generation — true when every later generation ALSO gave up, false the instant a
//       genuinely fresh, never-ambiguous generation is issued (e.g. an unrelated inbound message taking
//       enqueueStdin's idle immediate-submit path while an earlier entry sits held) and confirms quickly.
//       Unconditional correlation would misattribute that fresh confirmation to the OLDER generation and
//       DELETE its still-genuinely-unconfirmed entry — a SILENT LOSS, strictly worse than the duplicate
//       this whole card exists to close. The fix only runs the destructive delete when the current
//       generation is either the front's own or itself also ambiguous (the established cross-generation
//       case); otherwise the front's entry survives, un-purged, to resolve via its own bounded hold — a
//       duplicate at worst, never a loss.
//
// RUN (no daemon needed): node test/pty-giveup-hold-until-confirmed.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Bounded poll until `predicate()` is true — observe the real state transition instead of guessing a
 *  wall-clock deadline (this project's own blind-sleep campaign, cards 0fa5beef/595aad10/fea23514/
 *  47a515ff/b64b3726, found repeated flakes from computed-deadline waits racing chained setTimeouts). */
async function waitUntil(predicate, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    await sleep(2);
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-giveuphold-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 150; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 2;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const SETTLE_POLL = 5;
const SETTLE_MAX_POLLS = 3;
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 15;
// The hold this suite is guarding — pinned well above the give-up pipeline's own bounded windows above
// (so a reconcile() called immediately after a give-up commits is unambiguously still inside the hold
// window) but small enough that scenario (3)'s "wait past the hold" is a short, deterministic sleep.
const HOLD_MS = 300;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
// Each message only ever gives up up to twice in this suite (scenario 3) — 1 is enough headroom, and pins
// the bound explicitly so the test doesn't silently drift if the default constant is ever retuned.
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
const busyLog = {};
const events = {
  onEngineSessionId() {},
  onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
};

/** A fake pty that never emits output — every give-up this drives is a genuine drop (GIVE-UP RECOVERY),
 *  never the false-negative/SUPPRESSED case. */
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
    bodyCount: (text) => fake.writes.join("").split(text).length - 1,
  };
}

try {
  // ===================== (1) RED-FIRST: the specimen shape — give-up requeue, THEN a reconcile tick, ======
  // ===================== THEN a late confirming hook — must never double-deliver ==========================
  {
    const SID = "sess-hold-race";
    const TEXT = "HELD_UNTIL_CONFIRMED_OR_EXPIRED";
    const { bodyCount } = spawnReady(SID);
    const r = host.enqueueStdin(SID, TEXT);
    check("(1) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    await waitUntil(() => busyLog[SID].at(-1) === false);
    check("(1) give-up requeued the message", host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT);
    check("(1) exactly one body write so far (the original attempt, never yet re-delivered)", bodyCount(TEXT) === 1);

    // THE RACE: a reconcile tick fires WHILE the late confirming hook is still outstanding. Pre-fix this
    // resubmits the requeued entry immediately (busy re-arms, the body is written a SECOND time) — the
    // exact race the in-code residual comment named. Post-fix it must be a no-op: the entry is still held.
    host.reconcile();
    check("(1) THE FIX: the reconcile tick was a no-op — busy is still false (nothing was resubmitted)",
      busyLog[SID].at(-1) === false);
    check("(1) THE FIX: the body was NOT written a second time by the premature reconcile tick",
      bodyCount(TEXT) === 1);
    check("(1) THE FIX: the requeued entry is still sitting untouched in pending",
      host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT);

    // THE LATE HOOK finally arrives, proving the original turn actually started — it must purge the
    // untouched requeued duplicate (today's `purgeConfirmedGiveUpRequeue` behaviour, now guaranteed to win
    // the race instead of merely being likely to).
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    check("(1) the late hook purged the requeued duplicate — pending is empty", host.getPendingEntries(SID).length === 0);
    check("(1) busy reflects the hook's own rising edge (the turn IS actually running)", busyLog[SID].at(-1) === true);
    check("(1) NO DUPLICATE DELIVERY across the whole episode: body written exactly once", bodyCount(TEXT) === 1);

    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(1) the turn finalizes cleanly, nothing left queued", busyLog[SID].at(-1) === false && host.getPendingEntries(SID).length === 0);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (2) NO STALL: a held entry must never block an unrelated queued message ==========
  {
    const SID = "sess-hold-no-stall";
    const TEXT1 = "HELD_ENTRY_MUST_NOT_BLOCK";
    const TEXT2 = "UNRELATED_MESSAGE_DRAINS_ANYWAY";
    const { bodyCount, written } = spawnReady(SID);
    const r1 = host.enqueueStdin(SID, TEXT1, "system", undefined, undefined, "agent");
    check("(2) setup: TEXT1 delivered immediately, busy armed", r1.delivered === true && busyLog[SID].at(-1) === true);

    // TEXT2 arrives while TEXT1's retries are still in flight — genuinely QUEUED (not the immediate-submit
    // path), landing BEHIND where TEXT1's requeued copy will soon be unshifted.
    const r2 = host.enqueueStdin(SID, TEXT2, "system", undefined, undefined, "agent");
    check("(2) setup: TEXT2 held in the queue (session busy with TEXT1's retries)", r2.delivered === false && r2.reason === "held");

    // TEXT1 never confirms (genuine drop) — give-up requeues it to the FRONT, ahead of TEXT2.
    await waitUntil(() => busyLog[SID].at(-1) === false);
    const afterGiveUp = host.getPendingEntries(SID);
    check("(2) pending is now [TEXT1 (held), TEXT2] — TEXT1 restored to the front",
      afterGiveUp.length === 2 && afterGiveUp[0].text === TEXT1 && afterGiveUp[1].text === TEXT2);

    // A reconcile tick fires while TEXT1 is still held. THE FIX: it must skip TEXT1 and drain TEXT2
    // instead — never stalling TEXT2 behind TEXT1's unresolved hold.
    host.reconcile();
    check("(2) THE FIX: TEXT2 drained despite TEXT1 still being held", written().includes(TEXT2));
    check("(2) THE FIX: TEXT1 was NOT resubmitted — its body was written only its original once", bodyCount(TEXT1) === 1);
    const afterDrain = host.getPendingEntries(SID);
    check("(2) THE FIX: TEXT1 remains in pending, untouched, still the only thing left",
      afterDrain.length === 1 && afterDrain[0].text === TEXT1);

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (3) GENUINE GIVE-UP: no confirming hook ever arrives — the held entry still =======
  // ===================== recovers and delivers exactly once once its bounded hold expires =================
  {
    const SID = "sess-hold-genuine-giveup";
    const TEXT = "GENUINE_GIVE_UP_STILL_RECOVERS_ONCE";
    const { bodyCount } = spawnReady(SID);
    const r = host.enqueueStdin(SID, TEXT);
    check("(3) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    await waitUntil(() => busyLog[SID].at(-1) === false);
    check("(3) cycle 1 gave up and requeued the message", host.getPendingEntries(SID).length === 1);
    check("(3) exactly one body write so far", bodyCount(TEXT) === 1);

    // A reconcile tick right after give-up (well within the hold window) must be a no-op — no confirming
    // hook is coming (this is the genuine case), but the hold hasn't expired yet either.
    host.reconcile();
    check("(3) still held: reconcile right after give-up is a no-op", busyLog[SID].at(-1) === false && bodyCount(TEXT) === 1);

    // Wait past the bounded hold with STILL no confirming hook ever arriving — the silent-drop protection
    // (card 441499ee) must still recover the message: the NEXT reconcile tick now drains it for real.
    await sleep(HOLD_MS + 100);
    host.reconcile();
    check("(3) THE BACKSTOP: the hold expired with no confirmation — busy re-armed (genuinely re-delivered)",
      busyLog[SID].at(-1) === true);
    check("(3) THE BACKSTOP: the body was written a second time (actually re-delivered, not just re-counted)",
      bodyCount(TEXT) === 2);
    check("(3) pending is now empty (the requeued entry was drained, not left behind)",
      host.getPendingEntries(SID).length === 0);

    // Cycle 2 ALSO never confirms — with LOOM_GIVE_UP_REQUEUE_LIMIT=1, this second failure is dropped for
    // real (no infinite requeue loop) rather than held again.
    await waitUntil(() => busyLog[SID].at(-1) === false);
    check("(3) BOUNDED: after the second failure the message is dropped for real, not held/requeued again",
      host.getPendingEntries(SID).length === 0);
    host.reconcile();
    await sleep(VERIFY_TIMEOUT * 2);
    check("(3) sanity: still exactly 2 delivery attempts after another reconcile tick — no runaway loop",
      bodyCount(TEXT) === 2);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (4) RED-FIRST (code-review follow-up): a held entry must survive a FRESH, =========
  // ===================== unrelated generation's own confirmation — never get misattributed and purged ======
  {
    const SID = "sess-hold-fresh-gen-misattribution";
    const TEXT1 = "HELD_ENTRY_SURVIVES_FRESH_GENERATION";
    const TEXT2 = "FRESH_UNRELATED_MESSAGE_CONFIRMS_NORMALLY";
    const { bodyCount } = spawnReady(SID);
    const r1 = host.enqueueStdin(SID, TEXT1);
    check("(4) setup: TEXT1 delivered immediately, busy armed", r1.delivered === true && busyLog[SID].at(-1) === true);

    // TEXT1 never confirms (genuine drop) — give-up requeues it, held, giveUpGen:1 pushed onto
    // giveUpConfirmQueue.
    await waitUntil(() => busyLog[SID].at(-1) === false);
    check("(4) TEXT1 gave up and was requeued, held", host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT1);

    // THE DANGEROUS CHAIN: busy is false (give-up cleared it) — a completely UNRELATED message (a fresh
    // worker report, say) takes enqueueStdin's idle immediate-submit path, exactly as the review named:
    // that gate checks only `ready && !busy`, never `live.pending`, so it bypasses TEXT1 entirely and
    // submits under a NEW generation (2) while TEXT1's ambiguity is still outstanding.
    const r2 = host.enqueueStdin(SID, TEXT2);
    check("(4) setup: TEXT2 (unrelated) takes the immediate path under a NEW generation, busy re-armed",
      r2.delivered === true && busyLog[SID].at(-1) === true);
    check("(4) TEXT1 is untouched in pending while TEXT2's fresh generation is in flight",
      host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT1);

    // TEXT2's Enter lands and confirms NORMALLY and QUICKLY — this hook has nothing to do with TEXT1's
    // generation. Pre-fix, purgeConfirmedGiveUpRequeue attributed ANY hook unconditionally to
    // giveUpConfirmQueue's front (TEXT1's generation) and would DELETE TEXT1's still-genuinely-unconfirmed
    // entry here — a silent loss (the discriminator's log even claims "proves generation 1's turn actually
    // started", which is false). THE FIX: the guard must recognize generation 2 is a fresh, non-ambiguous
    // generation and refuse to purge generation 1's entry on this hook.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    check("(4) THE FIX: TEXT1 is NOT purged by TEXT2's unrelated confirmation — it survives",
      host.getPendingEntries(SID).some((m) => m.text === TEXT1));

    // TEXT2's turn ends normally. The turnEnded shift is unconditional (pure bookkeeping, never deletes a
    // pending entry) — TEXT1 must still be sitting there, untouched, after it.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(4) TEXT1 still survives after TEXT2's Stop (the unconditional shift didn't touch it)",
      host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT1);
    check("(4) TEXT1's body was never written a second time by any of this", bodyCount(TEXT1) === 1);

    // Past its own bounded hold, with no confirmation of ITS OWN ever arriving, TEXT1 must still actually
    // be DELIVERED (not just survive-and-be-forgotten) — the whole point of "fail toward a duplicate,
    // never a loss": the reviewer's ask was "assert the held entry is still eventually DELIVERED, not
    // purged", not merely "assert it isn't deleted".
    await sleep(HOLD_MS + 100);
    host.reconcile();
    check("(4) THE DELIVERY: TEXT1 is genuinely redrained once its own hold expires — busy re-armed",
      busyLog[SID].at(-1) === true);
    check("(4) THE DELIVERY: TEXT1's body was written a second time — actually delivered, not lost",
      bodyCount(TEXT1) === 2);
    check("(4) pending is empty — TEXT1 is no longer sitting unresolved", host.getPendingEntries(SID).length === 0);

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  for (const sid of ["sess-hold-race", "sess-hold-no-stall", "sess-hold-genuine-giveup", "sess-hold-fresh-gen-misattribution"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a give-up requeue is held from drain until a confirming hook purges it or its bounded hold expires, a reconcile tick can no longer win the race and double-deliver, an unrelated queued message is never stalled behind a held entry, a genuine give-up (no confirmation ever) still recovers and delivers exactly once, and a held entry survives a fresh unrelated generation's own confirmation instead of being misattributed and silently lost."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
