// Hermetic regression test for card 09e655d5 — "a late give-up confirmation can purge the WRONG
// requeued message across generations" (pty/host.ts purgeConfirmedGiveUpRequeue).
//
// ROOT CAUSE being guarded: `requeueGiveUpOrigin` stamps a requeued entry with `giveUpGen: <the failed
// submit's generation>`. Pre-fix, `purgeConfirmedGiveUpRequeue` dropped whichever pending entry's
// `giveUpGen` matched the CURRENT `live.submitGeneration` at hook-arrival time — using the live
// generation as a stand-in for "which turn just proved it started". That proxy breaks the instant a
// SECOND generation has started and ALSO given up before the FIRST generation's late confirming hook
// arrives:
//   1. Gen 1 submits, gives up, requeues TEXT1 tagged giveUpGen:1, clears busy.
//   2. A new message (TEXT2) takes the immediate-submit path (enqueueStdin's `!live.busy` check has no
//      pending-queue guard) → generation becomes 2.
//   3. Gen 2 ALSO gives up, requeues TEXT2 tagged giveUpGen:2, clears busy.
//   4. The late confirming hook for GENERATION 1's turn now arrives. Pre-fix, the purge read
//      `live.submitGeneration === 2` and dropped TEXT2 — the entry that has NOT been confirmed by
//      anything — while TEXT1 (the actually-redundant duplicate the hook just proved landed) survives to
//      double-deliver later.
//
// THE FIX: track a small FIFO of generations that gave up and are still awaiting a possible late
// confirmation (`Live.giveUpConfirmQueue`, pushed in `requeueGiveUpOrigin`). `purgeConfirmedGiveUpRequeue`
// correlates a hook to the OLDEST such generation (the queue front) instead of the CURRENT
// `submitGeneration`, so a late confirmation for an earlier give-up can never misattribute to a later,
// still-unconfirmed one. `Stop`/`StopFailure` (the definitive one-per-real-turn end signal) advances the
// queue past the front; `UserPromptSubmit` purges without advancing, so a still-outstanding Stop for the
// SAME real turn is a no-op instead of misattributing to whatever is next in the queue.
//
// This suite proves, against a fake pty that NEVER emits output (so every give-up is a genuine drop —
// the false-negative/SUPPRESSED path is proven elsewhere, pty-giveup-false-negative.mjs):
//   (1) RED-FIRST SHAPE: two consecutive give-ups across generations, then a late confirmation for the
//       FIRST — the second's requeued message must NOT be purged, and the first's actually-redundant copy
//       must be the one dropped.
//   (2) the existing single-generation purge (card 441499ee) still works: a late confirmation still finds
//       and drops its own generation's requeued duplicate when there is no cross-generation ambiguity.
//
// RUN (no daemon needed): node test/pty-giveup-purge-cross-generation.mjs
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

// Capture every `[submit] <sessionId> ...` log line host.ts emits so a scenario can assert on WHICH
// branch actually fired, not just the eventual pending/body state.
const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };
const giveUpLinesFor = (sid) => submitLog.filter((l) => l.startsWith(`[submit] ${sid} `) && l.includes("GIVE-UP"));

const tmpHome = path.join(os.tmpdir(), `loom-giveup-purge-crossgen-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 150; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 2;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const SETTLE_POLL = 5;
const SETTLE_MAX_POLLS = 3;
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 15;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
// Each of TEXT1/TEXT2 only ever gives up ONCE in this suite — 1 is enough headroom, and pins the bound
// explicitly so the test doesn't silently drift if the default constant is ever retuned.
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";

const { PtyHost } = await import("../dist/pty/host.js");

const fakes = [];
/** A fake pty that never emits output — every give-up this drives is a genuine drop (GIVE-UP RECOVERY),
 *  never the false-negative/SUPPRESSED case. */
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
  // ===================== (1) THE BUG: two consecutive give-ups across generations, late confirmation ====
  // ===================== for the FIRST must purge the FIRST's duplicate, never the SECOND's =============
  {
    const SID = "sess-purge-crossgen";
    const TEXT1 = "GEN1_TURN_ACTUALLY_STARTED_LATE_CONFIRM";
    const TEXT2 = "GEN2_NEVER_CONFIRMED_MUST_SURVIVE";
    const { bodyCount } = spawnReady(SID);

    // Gen 1: immediate submit, then a genuine give-up (RECOVERY) — requeues TEXT1 tagged giveUpGen:1.
    const r1 = host.enqueueStdin(SID, TEXT1);
    check("(1) setup: TEXT1 delivered immediately (gen 1), busy armed", r1.delivered === true && busyLog[SID].at(-1) === true);
    await waitUntil(() => busyLog[SID].at(-1) === false);
    check("(1) gen 1 gave up and requeued TEXT1", host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT1);
    check("(1) gen 1's give-up was a genuine RECOVERY (not suppressed)", giveUpLinesFor(SID).some((l) => l.includes("GIVE-UP RECOVERY")));

    // Gen 2: busy is false again, so this ALSO takes the immediate-submit path (enqueueStdin's idle-submit
    // check has no pending-queue guard) — bumping submitGeneration to 2 WITHOUT ever draining TEXT1.
    const r2 = host.enqueueStdin(SID, TEXT2);
    check("(1) setup: TEXT2 ALSO takes the immediate path (gen 2), busy armed", r2.delivered === true && busyLog[SID].at(-1) === true);
    check("(1) TEXT1 is untouched in pending while gen 2 is in flight", host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT1);

    // Gen 2 ALSO gives up (genuine RECOVERY) — requeues TEXT2 tagged giveUpGen:2 onto the FRONT of pending.
    await waitUntil(() => busyLog[SID].at(-1) === false);
    const afterBothGiveUps = host.getPendingEntries(SID);
    check("(1) both TEXT1 (giveUpGen:1) and TEXT2 (giveUpGen:2) are now pending, TEXT2 in front",
      afterBothGiveUps.length === 2 && afterBothGiveUps[0].text === TEXT2 && afterBothGiveUps[1].text === TEXT1);

    // THE LATE HOOK: proves generation 1's turn actually started — not generation 2's. Nothing has
    // resubmitted since either give-up, so this is exactly the card's step-4 interleaving.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });

    const afterPurge = host.getPendingEntries(SID);
    check("(1) THE FIX: TEXT2 (the SECOND's requeued message, gen 2, unconfirmed) is NOT purged — it survives",
      afterPurge.some((m) => m.text === TEXT2));
    check("(1) THE FIX: TEXT1 (the FIRST's requeued message, gen 1, just proven to have started) IS purged",
      !afterPurge.some((m) => m.text === TEXT1));
    check("(1) exactly one entry remains (TEXT2)", afterPurge.length === 1);

    // Let gen 2's turn finish normally (it's the one now actually running per busy=true from the hook) and
    // confirm no duplicate delivery of either text happened as a side effect of the purge itself.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(1) TEXT1's body was written exactly once (never double-delivered)", bodyCount(TEXT1) === 1);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (2) EXISTING COVERAGE: a single-generation late confirmation still purges its ===
  // ===================== own generation's requeued duplicate (card 441499ee, no cross-generation ==========
  // ===================== ambiguity involved) =================================================================
  {
    const SID = "sess-purge-crossgen-single-gen";
    const TEXT = "SINGLE_GEN_STILL_PURGES_CORRECTLY";
    const { bodyCount } = spawnReady(SID);
    const r = host.enqueueStdin(SID, TEXT);
    check("(2) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);
    await waitUntil(() => busyLog[SID].at(-1) === false);
    check("(2) RECOVERY requeued the message", host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT);

    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    check("(2) the late confirmation purged the requeued duplicate — pending is empty", host.getPendingEntries(SID).length === 0);

    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(2) no duplicate delivery", bodyCount(TEXT) === 1);
    check("(2) the turn finalizes cleanly", busyLog[SID].at(-1) === false && host.getPendingEntries(SID).length === 0);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  for (const sid of ["sess-purge-crossgen", "sess-purge-crossgen-single-gen"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a late give-up confirmation correlates to the generation it actually belongs to, never misattributing across generations."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
