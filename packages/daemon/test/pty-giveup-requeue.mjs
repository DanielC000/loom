// Hermetic regression test for card 441499ee — "a given-up submit silently loses the message; re-queue
// instead of dropping" (pty/host.ts fireEnterAndVerify's GIVE-UP RECOVERY branch + the new
// requeueGiveUpOrigin helper).
//
// ROOT CAUSE being guarded: when a submit's Enter never confirms after SUBMIT_MAX_ATTEMPTS AND the engine
// produced no output at all (a genuine drop, not the false-negative case guarded by
// pty-giveup-false-negative.mjs), the pre-fix code recovered `busy` and — for the composer-clean case —
// backspace-cleared the stranded injection, but never put the text anywhere else. The caller (enqueueStdin)
// had ALREADY been told `delivered:true` (immediate path) or the message had already been spliced out of
// `live.pending` and handed to submit() (held/drain path) — either way the message then ceased to exist.
//
// THE FIX: `submit()` now captures the ORIGINAL QueuedMessage entry/entries this turn's text came from
// (`Live.giveUpOrigin` — a synthesized single entry for the immediate path, the real spliced `drained`
// array for the held/drain path). On a genuine GIVE-UP RECOVERY, `requeueGiveUpOrigin` puts those entries
// back on the FRONT of `live.pending` (identity-preserved — the same objects, never re-derived from text),
// where they wait for the NEXT natural drain trigger (a Stop hook, a box-free transition, or the existing
// ~10s reconcile tick — `host.reconcile()`, simulated directly in this suite instead of waiting real
// seconds) instead of vanishing. Deliberately does NOT force an immediate drain itself — see the method's
// own doc for why (it would otherwise make every single-cycle give-up in the sibling suites
// (pty-giveup-clear.mjs, pty-giveup-clear-single-attempt.mjs, pty-giveup-false-negative.mjs) re-arm busy
// and retry a second cycle in place, which those tests correctly assert does NOT happen for their own
// scenarios). Bounded by `GIVE_UP_REQUEUE_LIMIT` (default 1) via a per-message `giveUpRequeues` counter,
// so a message that keeps giving up is eventually dropped for real rather than requeuing forever.
//
// This suite proves, against a fake pty that NEVER emits output (so every give-up is a genuine drop, never
// the false-negative/SUPPRESSED case):
//   (1) a lost message is requeued (visible in `getPendingEntries`, not silently gone) and, once a drain is
//       actually triggered (`reconcile()`), is genuinely RE-SUBMITTED — not just re-added to a dead queue —
//       and after failing a SECOND time is finally dropped for real: no infinite requeue loop.
//   (2) ORDERING: a message that arrives while an earlier one is stuck retrying drains AFTER the recovered
//       message, never interleaved with or jumped ahead of it.
//   (3) the SUPPRESSED (false-negative) give-up path — proven elsewhere to leave busy alone — never
//       requeues anything, so it can never double-deliver on top of a turn that's actually still running.
//   (4) card 04de8bbf's neighbourhood finding — GIVE-UP RECOVERY itself can be a false negative (the
//       discriminator misses real output and fires RECOVERY even though the turn actually started, per a
//       live production sample). If a confirming hook (UserPromptSubmit/Stop) arrives for that generation
//       AFTER RECOVERY already requeued a duplicate, `purgeConfirmedGiveUpRequeue` must drop the requeued
//       copy before it can ever drain — proving the original landing does NOT also silently double-deliver
//       a second copy of the same text.
//   (5) THE INVERTED DEFAULT (card 04de8bbf follow-up, n=84: ~86% of give-ups reaching this point are false
//       negatives): a confirming hook arriving DURING the short post-give-up settle window (before RECOVERY
//       ever commits) means the message is NEVER requeued at all — zero race, not a race won. This is
//       distinct from (4), which proves the LATER defense-in-depth for a hook that arrives AFTER RECOVERY
//       already requeued; (5) proves the FIRST line of defense that avoids needing that backstop at all in
//       the common (fast-confirming) case.
//
// RUN (no daemon needed): node test/pty-giveup-requeue.mjs
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

// Capture every `[submit] <sessionId> ...` log line host.ts emits (GIVE-UP SUPPRESSED/RECOVERY, requeue,
// purge) so scenarios can assert on WHICH branch actually fired, not just the eventual pending/body state
// — the two can otherwise look identical from the outside (a message requeued-then-purged by
// purgeConfirmedGiveUpRequeue ends up in the exact same final state — pending empty, body written once —
// as a message that was NEVER requeued at all via the settle window, so the end state alone can't tell
// scenario (4)'s defense-in-depth apart from scenario (5)'s first line of defense). Still forwards to the
// real console so failures remain debuggable from stdout.
const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };
const giveUpLinesFor = (sid) => submitLog.filter((l) => l.startsWith(`[submit] ${sid} `) && l.includes("GIVE-UP"));

const tmpHome = path.join(os.tmpdir(), `loom-giveuprequeue-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 150; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 2;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const SETTLE_POLL = 5;
const SETTLE_MAX_POLLS = 3;
// Card 441499ee (inverted default): after the verify-timeout elapses, GIVE-UP now takes ONE more short,
// bounded, OBSERVED wait for `enterConfirmed` (awaitGiveUpConfirmSettle) before actually committing to
// RECOVERY. Pinned explicitly (rather than relying on the production default) so scenario (5) below has a
// known, comfortably-sized window to land a hook inside.
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 15;
const CONFIRM_SETTLE_BOUND = CONFIRM_SETTLE_POLL * CONFIRM_SETTLE_MAX_POLLS; // 150ms
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
// The bound this suite is guarding — pinned explicitly so the test doesn't silently drift if the default
// constant is ever retuned.
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";

const { PtyHost } = await import("../dist/pty/host.js");

const fakes = [];
/** A fake pty that never emits output (onData registered but never fired) — every give-up this drives is
 *  a genuine drop, never the false-negative/SUPPRESSED case (that's pty-giveup-false-negative.mjs's job).
 *  Scenario (3) below needs a fake that CAN emit on demand, so it builds its own variant inline. */
function makeSilentFakePty() {
  const writes = [];
  const fake = {
    pid: 4242,
    write: (d) => { writes.push(d); },
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill: () => {},
    resize: () => {},
    writes,
  };
  fakes.push(fake);
  return fake;
}

const busyLog = {};
const events = {
  onEngineSessionId() {},
  onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
};

class SilentTestPtyHost extends PtyHost {
  createPty() { return makeSilentFakePty(); }
}
const host = new SilentTestPtyHost(events);

function spawnReady(sessionId, targetHost = host) {
  targetHost.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  targetHost.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return {
    fake,
    written: () => fake.writes.join(""),
    entryCount: () => fake.writes.join("").split("\r").length - 1,
    bodyCount: (text) => fake.writes.join("").split(text).length - 1,
  };
}

try {
  // ===================== (1) requeue converts a silent loss into a real re-submit (once drained), then ===
  // ===================== the bounded requeue budget stops it from looping forever on a second failure ===
  {
    const SID = "sess-requeue-basic";
    const TEXT = "LOST_MESSAGE_BUT_RECOVERED_ONCE";
    const { bodyCount, entryCount } = spawnReady(SID);
    const r = host.enqueueStdin(SID, TEXT);
    check("(1) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);
    check("(1) setup: nothing queued yet (this went out immediately)", host.getPendingEntries(SID).length === 0);

    // Cycle 1 gives up (never confirmed, no output at all). No auto-redrain happens (by design — see the
    // fix's own doc) — busy settles false and STAYS false until something else drains it.
    await waitUntil(() => busyLog[SID].at(-1) === false);
    check("(1) cycle 1: all attempts written", entryCount() === MAX_ATTEMPTS);
    check("(1) THE FIX: the message was NOT silently dropped — it reappears in the pending queue",
      host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT);
    check("(1) busy stays false — give-up does not itself force an immediate re-drain",
      busyLog[SID].at(-1) === false);

    // Simulate the daemon's own periodic reconcile tick (wired externally in production — see
    // PtyHost.reconcile's doc) — this is the real mechanism that would eventually pick this back up.
    host.reconcile();
    check("(1) reconcile drained the requeued message: busy re-armed", busyLog[SID].at(-1) === true);

    // Cycle 2: the re-submitted turn ALSO never confirms — this is its SECOND failure, so with
    // LOOM_GIVE_UP_REQUEUE_LIMIT=1 it must be dropped for real this time (no infinite requeue loop).
    await waitUntil(() => busyLog[SID].at(-1) === false);
    check("(1) cycle 2: a full second round of attempts was actually written (genuine re-submit, not a no-op)",
      entryCount() === MAX_ATTEMPTS * 2);
    check("(1) cycle 2: the message body was written to the pty TWICE (actually re-delivered, not just re-counted)",
      bodyCount(TEXT) === 2);
    check("(1) BOUNDED: the message is finally gone from pending — requeue budget exhausted, dropped for real",
      host.getPendingEntries(SID).length === 0);
    // Sanity: a further reconcile tick (the ONLY thing that would pick up a requeued message) is a genuine
    // no-op now — proves this isn't "hasn't looped again YET", it's actually bounded.
    host.reconcile();
    await sleep(VERIFY_TIMEOUT * 2);
    check("(1) sanity: still exactly 2 rounds' worth of attempts after another reconcile tick — no runaway loop",
      entryCount() === MAX_ATTEMPTS * 2);
    check("(1) sanity: busy still false, nothing left queued", busyLog[SID].at(-1) === false && host.getPendingEntries(SID).length === 0);
  }

  // ===================== (2) ORDERING: a message that arrives while the first is stuck retrying must ====
  // ===================== drain AFTER the recovered message, never ahead of or interleaved with it ========
  {
    const SID = "sess-requeue-order";
    const TEXT1 = "FIRST_MESSAGE_GETS_LOST";
    const TEXT2 = "SECOND_MESSAGE_ARRIVES_WHILE_STUCK";
    const { written } = spawnReady(SID);
    // kind:"agent" (one-per-turn, no coalescing) so each message drains as its OWN distinct submit — makes
    // the ordering directly observable in the write stream instead of being merged into one joined text.
    const r1 = host.enqueueStdin(SID, TEXT1, "system", undefined, undefined, "agent");
    check("(2) setup: TEXT1 delivered immediately, busy armed", r1.delivered === true && busyLog[SID].at(-1) === true);

    // While TEXT1's submit is still retrying (busy), TEXT2 arrives and is HELD (queued), never delivered
    // straight away.
    const r2 = host.enqueueStdin(SID, TEXT2, "system", undefined, undefined, "agent");
    check("(2) setup: TEXT2 held in the queue (session busy with TEXT1's retries)", r2.delivered === false && r2.reason === "held");
    check("(2) setup: TEXT2 is the only thing queued so far",
      host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT2);

    // TEXT1 never confirms (genuine drop) — wait for its give-up. Per the fix, TEXT1 must be restored to
    // the FRONT of pending (ahead of TEXT2, which merely queued later in real time but is logically
    // SECOND) — checkable directly from the queue order, no drain needed yet.
    await waitUntil(() => busyLog[SID].at(-1) === false);
    const afterGiveUp = host.getPendingEntries(SID);
    check("(2) ORDERING: pending is now [TEXT1 (recovered), TEXT2] — TEXT1 restored to the FRONT",
      afterGiveUp.length === 2 && afterGiveUp[0].text === TEXT1 && afterGiveUp[1].text === TEXT2);

    // Drain (reconcile) — one-per-turn agent draining means only the HEAD (TEXT1) goes out, never TEXT2.
    host.reconcile();
    check("(2) ORDERING: draining resubmits TEXT1 (not TEXT2) — its body appears a SECOND time",
      written().split(TEXT1).length - 1 === 2 && !written().includes(TEXT2));

    // TEXT1's re-drained submit ALSO fails a second time (LOOM_GIVE_UP_REQUEUE_LIMIT=1) — it's finally
    // dropped for real, and TEXT2 (which was never touched) should now be the only thing left to drain.
    await waitUntil(() => busyLog[SID].at(-1) === false);
    check("(2) after TEXT1's second failure, only TEXT2 remains queued",
      host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT2);
    host.reconcile();
    await waitUntil(() => written().includes(TEXT2));
    check("(2) TEXT2 finally drains normally (untouched by the whole TEXT1 episode)", written().includes(TEXT2));
    check("(2) TEXT1 was never re-submitted a THIRD time (its own requeue budget was exhausted, not TEXT2's)",
      written().split(TEXT1).length - 1 === 2);
  }

  // ===================== (3) a SUPPRESSED (false-negative) give-up never requeues anything — can't ========
  // ===================== double-deliver on top of a turn that's actually still running ===================
  {
    const SID2 = "sess-requeue-suppressed";
    let onDataCb = null;
    const writes2 = [];
    const fake2 = {
      pid: 4343,
      write: (d) => { writes2.push(d); },
      onData: (cb) => { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
      onExit: () => ({ dispose() {} }),
      kill: () => {}, resize: () => {},
      writes: writes2,
      emitOutput: (s = ".") => { if (onDataCb) onDataCb(Buffer.from(s, "utf-8")); },
    };
    class SuppressTestPtyHost extends PtyHost {
      createPty() { fakes.push(fake2); return fake2; }
    }
    const host2 = new SuppressTestPtyHost(events);
    const TEXT = "REAL_TURN_JUST_SLOW_TO_CONFIRM";
    spawnReady(SID2, host2);
    const entryCount2 = () => fake2.writes.join("").split("\r").length - 1;

    const r = host2.enqueueStdin(SID2, TEXT);
    check("(3) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID2].at(-1) === true);

    // Wait for all attempts to be written, then emit engine output AFTER the final Enter write — the
    // documented SUPPRESSED case (card 71de1f9c): the Enter almost certainly registered, just slow to
    // confirm, so give-up must be suppressed (busy left alone, nothing requeued).
    await waitUntil(() => entryCount2() === MAX_ATTEMPTS);
    fake2.emitOutput("late-output-after-final-enter");
    await sleep(VERIFY_TIMEOUT + VERIFY_TIMEOUT / 2); // cross the give-up deadline
    check("(3) SUPPRESSED: busy is still true (the real Stop/UserPromptSubmit will finalize it)",
      busyLog[SID2].at(-1) === true);
    check("(3) SUPPRESSED: nothing was ever requeued — pending stays empty",
      host2.getPendingEntries(SID2).length === 0);
    check("(3) SUPPRESSED: no extra Enter attempt was written past the normal MAX_ATTEMPTS",
      entryCount2() === MAX_ATTEMPTS);
    // A reconcile tick right now must be a genuine no-op — nothing to drain, and busy is (still) true so
    // drainPending's own busy guard would refuse anyway; this proves the two mechanisms don't conflict.
    host2.reconcile();
    check("(3) SUPPRESSED: a reconcile tick during the suppressed window changes nothing",
      entryCount2() === MAX_ATTEMPTS && host2.getPendingEntries(SID2).length === 0 && busyLog[SID2].at(-1) === true);

    // The real hook arrives late and finalizes normally — confirms suppression never left anything stuck,
    // and (critically) never double-delivered a requeued copy on top of this now-finalizing turn.
    host2.deliverHook(SID2, { hook_event_name: "UserPromptSubmit" });
    host2.deliverHook(SID2, { hook_event_name: "Stop" });
    check("(3) the turn finalizes cleanly, still with nothing queued (no duplicate ever appeared)",
      busyLog[SID2].at(-1) === false && host2.getPending(SID2).length === 0);
    try { host2.stop(SID2, "hard"); } catch { /* ignore */ }
  }

  // ===================== (4) GIVE-UP RECOVERY ITSELF can be a false negative (card 04de8bbf's =============
  // ===================== neighbourhood) — a late confirming hook must PURGE the requeued duplicate, =======
  // ===================== never let it drain and double-deliver a message that already landed ============
  {
    const SID = "sess-requeue-purge-on-late-confirm";
    const TEXT = "TURN_ACTUALLY_STARTED_DISCRIMINATOR_MISSED_IT";
    const { bodyCount, entryCount } = spawnReady(SID);
    const r = host.enqueueStdin(SID, TEXT);
    check("(4) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // This fake never emits output, so — exactly like the production sample that motivated this scenario —
    // GIVE-UP RECOVERY fires (not SUPPRESSED), even though we're about to prove (via the late hook) that
    // the turn actually started. The requeue happens first, same as scenario (1).
    await waitUntil(() => busyLog[SID].at(-1) === false);
    check("(4) RECOVERY requeued the message (this is the false-negative give-up itself, not the fix)",
      host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT);
    check("(4) confirms GIVE-UP RECOVERY actually fired (not the settle-suppress) — the log says so explicitly",
      giveUpLinesFor(SID).some((l) => l.includes("GIVE-UP RECOVERY")));

    // The ORIGINAL turn's confirmation arrives late — proof (per this file's own hook-handling convention)
    // that it actually started. Nothing has resubmitted in between, so this hook's generation is still the
    // one the requeued entry was tagged with — the purge must find and drop it.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    check("(4) THE HARDENING: the late confirmation PURGED the requeued duplicate — pending is empty",
      host.getPendingEntries(SID).length === 0);
    check("(4) busy correctly reflects the turn that's actually running now (the hook's own rising edge)",
      busyLog[SID].at(-1) === true);

    // Even a reconcile tick right now (or the real Stop that will eventually end this turn) must NEVER
    // re-deliver TEXT a second time — the whole point of the purge.
    host.reconcile();
    check("(4) NO DUPLICATE: the message body was written exactly ONCE, never re-delivered after the purge",
      bodyCount(TEXT) === 1);
    check("(4) NO DUPLICATE: no extra Enter attempts were written past the original cycle",
      entryCount() === MAX_ATTEMPTS);

    // The turn ends normally — confirms the purge didn't leave anything else stuck or stranded.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(4) the turn finalizes cleanly, still with nothing queued", busyLog[SID].at(-1) === false && host.getPendingEntries(SID).length === 0);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (5) THE INVERTED DEFAULT: a confirming hook arriving DURING the short post- =====
  // ===================== give-up settle window means NO requeue EVER happens — zero race, not a race won ==
  {
    const SID = "sess-requeue-confirm-during-settle";
    const TEXT = "CONFIRMED_JUST_IN_TIME";
    const { bodyCount, entryCount } = spawnReady(SID);
    const r = host.enqueueStdin(SID, TEXT);
    check("(5) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // Let the final attempt's verify-timeout elapse (all attempts written), then fire the confirming hook
    // WHILE still inside the confirm-settle window (bounded at CONFIRM_SETTLE_BOUND after the verify-timeout
    // elapses) — landing roughly at its midpoint for comfortable margin — BEFORE GIVE-UP RECOVERY would
    // otherwise have committed to a requeue.
    await waitUntil(() => entryCount() === MAX_ATTEMPTS);
    await sleep(VERIFY_TIMEOUT + Math.floor(CONFIRM_SETTLE_BOUND / 2));
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });

    check("(5) THE INVERSION: busy reflects the hook's own rising edge (the turn IS actually running)",
      busyLog[SID].at(-1) === true);
    check("(5) THE INVERSION: the message was NEVER requeued — pending stayed empty the whole time",
      host.getPendingEntries(SID).length === 0);
    // The strong version of the above two checks: prove this via the ACTUAL branch that fired, not just
    // the end state — a requeued-then-purged message (scenario (4)'s path) would ALSO end up with empty
    // pending and one written body, so those checks alone can't tell the two mechanisms apart. The settle
    // poll notices `enterConfirmed` ASYNCHRONOUSLY (on its own next poll tick, up to CONFIRM_SETTLE_POLL ms
    // later — deliverHook above only set the flag, it doesn't synchronously wake the poll), so wait for its
    // own log line to actually land before asserting on it.
    await waitUntil(() => giveUpLinesFor(SID).length > 0);
    check("(5) THE INVERSION (log-verified): the settle-suppress branch fired, GIVE-UP RECOVERY never did",
      giveUpLinesFor(SID).some((l) => l.includes("during the post-give-up settle wait"))
      && !giveUpLinesFor(SID).some((l) => l.includes("GIVE-UP RECOVERY")));

    // Wait past the FULL settle bound (and then some) to prove RECOVERY never fires belatedly on top of
    // the now-confirmed turn — no delayed second decision sneaking in after the hook already resolved it.
    await sleep(CONFIRM_SETTLE_BOUND * 2);
    check("(5) NO DUPLICATE, NO CLEAR: the message body was written exactly once, no backspace clear either",
      bodyCount(TEXT) === 1);
    check("(5) still nothing queued and busy still reflects the running turn",
      host.getPendingEntries(SID).length === 0 && busyLog[SID].at(-1) === true);

    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(5) the turn finalizes cleanly", busyLog[SID].at(-1) === false && host.getPendingEntries(SID).length === 0);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  for (const sid of ["sess-requeue-basic", "sess-requeue-order"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a genuinely-lost give-up is requeued (visible, identity-preserved) and actually re-delivered on the next drain, ordering is preserved against messages that arrive while stuck, the requeue budget bounds it from looping forever, a SUPPRESSED (false-negative) give-up never requeues or double-delivers anything, a confirming hook arriving DURING the settle window means no requeue ever happens, and a hook arriving AFTER RECOVERY already requeued still gets purged before it can double-deliver."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
