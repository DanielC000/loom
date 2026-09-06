// Regression test for card dbc7ffea's Code Review Major 1 — a `retiredGiveUpSignatures` entry must retire
// once its logicalId's chain is no longer in flight, not linger for the rest of the session.
//
// THE GAP: a message gives up ONCE (archived at redrain), then its OWN cycle 2 is CONFIRMED NORMALLY — a
// physical write whose reported text does NOT content-match anything in either store (the archive only
// holds cycle 1's BARE signature; cycle 2's own confirmation was never itself ambiguous, so nothing seeds a
// fresh "current" entry for it either). NONE of `purgeConfirmedGiveUpRequeue`'s own delete sites has
// anything to fire on — the archived entry survives, dead, for the rest of the session. Then a completely
// UNRELATED later message, whose own text happens to be byte-identical to the FIRST message's original bare
// text, gives up — its own late confirmation now matches BOTH its own current entry AND the dead archived
// one, under two different batchIds, and `purgeConfirmedGiveUpRequeue`'s (correct, unrelated) batch-
// provenance discrimination declines to resolve EITHER — a real duplicate now lands for the unrelated
// message, silently defeating this card's own purpose even though nothing is lost.
//
// THE FIX: `retireResolvedArchiveEntries`, run at every genuine turn-end, retires a logicalId's archive the
// moment nothing in `live.pending` still carries it and no CURRENT `ambiguousDispatches` entry exists for
// it either — the chain is provably done, so the archive can no longer usefully purge anything of its own,
// and keeping it is pure false-ambiguity liability.
//
// TWO SCENARIOS: (1) the simple, canonical-ordering case (nothing else interleaves A's own turn-end) — this
// alone does NOT catch a real gap the Code Review re-review found: an earlier version of the fix called the
// sweep from a single line INSIDE `purgeConfirmedGiveUpRequeueCore`, placed AFTER that function's own
// early-return-on-empty-queue exit, so the sweep only ran for a turn-end that ALSO happened to still have a
// non-empty `giveUpConfirmQueue` at that moment. (2) THE ACTUAL BLOCKING REPRODUCTION: an unrelated message
// B drains past the held A and confirms — B's own Stop hook unconditionally shifts the queue empty
// (pre-existing, content-blind bookkeeping, unrelated to A) — so by the time A's OWN cycle 2 confirms
// normally, its Stop hits Core's early-empty-queue exit and the OLD single-site sweep never ran at all. THE
// FIX (current code): a thin wrapper around Core runs the sweep exactly once, unconditionally on
// `turnEnded`, AFTER Core returns — regardless of which of Core's four internal exits fired. Scenario (2)
// is the one that actually falsifies the incomplete fix; scenario (1) cannot, because nothing ever empties
// its queue.
//
// RUN: `pnpm build` (from packages/daemon) then `node test/pty-giveup-retired-signature-chain-retires.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil, sleepPast } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };
console.warn = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleWarn(...args); };

const tmpHome = path.join(os.tmpdir(), `loom-giveup-chain-retires-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";
const HOLD_MS = 200;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";

const { PtyHost, framePossibleDuplicate } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const busyLog = {};
const events = { onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {} };
class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    return Object.assign(base, { write: (d) => { writes.push(d); }, writes });
  }
}
const host = new SilentTestPtyHost(events);

function spawnReady(sessionId) {
  host.spawn({ sessionId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

try {
  // ===== (1) THE SIMPLE (canonical-ordering) CASE: no other message interleaves A's own turn-end ===========
  {
  const SID = "sess-chain-retires";
  const TEXT_A = "CHAIN_RETIRES_ORIGINAL_MESSAGE";
  spawnReady(SID);

  // ===== A: cycle 1 gives up, held (archived at redrain below) =====
  const rA = host.enqueueStdin(SID, TEXT_A);
  check("(setup) A delivered immediately, busy armed", rA.delivered === true && busyLog[SID]?.at(-1) === true);
  await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  const entriesA = host.getPendingEntries(SID);
  check("(setup) A's cycle 1 gave up, requeued, held", entriesA.length === 1);
  const A_LOGICAL_ID = entriesA[0].id;
  const A_TAGGED_TEXT = framePossibleDuplicate(TEXT_A, A_LOGICAL_ID);

  // ===== A redrains for cycle 2 (drainPending archives cycle 1's bare signature) =====
  await sleepPast(HOLD_MS + 150, HOLD_MS, "past GIVE_UP_HOLD_MS (A's cycle 1 hold)");
  host.reconcile();
  await sharedWaitUntil(() => busyLog[SID]?.at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
  check("(setup) A's cycle 2 is now in flight (nothing left in pending for it)", host.getPendingEntries(SID).length === 0);

  // ===== cycle 2 is CONFIRMED NORMALLY — a physical write whose reported text is the TAGGED text, which =====
  // ===== does NOT match anything stored (the archive only holds cycle 1's BARE signature; cycle 2 never ====
  // ===== itself gave up, so nothing seeded a fresh "current" entry either). This is the ordinary, healthy ==
  // ===== outcome give-up machinery was never meant to notice. ================================================
  submitLog.length = 0;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: A_TAGGED_TEXT });
  check("(setup) cycle 2's normal confirmation did NOT content-match anything (the archive predates this text)",
    !submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("(setup) A's turn ended cleanly, busy clears", busyLog[SID]?.at(-1) === false);

  // ===== THE FIX: at that Stop (turnEnded), A's chain is no longer in flight (nothing in pending shares =====
  // ===== its logicalId, no current ambiguousDispatches entry exists for it) — its archive must retire. ======
  // ===== Verified BEHAVIORALLY below via an unrelated message N that coincidentally shares A's ORIGINAL ====
  // ===== bare text, rather than reaching into Live's own internals. ==========================================
  const TEXT_N = TEXT_A; // deliberately byte-identical to A's own original bare text — a genuine coincidence
  submitLog.length = 0;
  const rN = host.enqueueStdin(SID, TEXT_N);
  check("(setup) N (unrelated, coincidentally same text as A's original) delivered immediately, busy armed",
    rN.delivered === true && busyLog[SID]?.at(-1) === true);
  await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check("(setup) N gave up, requeued, held", host.getPendingEntries(SID).length === 1);

  submitLog.length = 0;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT_N });
  check("(1) THE FIX: N's own late confirmation resolves CLEANLY (CONFIRMED, content-matched) — A's dead archive no longer collides with it",
    submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  check("(1) THE FIX: NO 'AMBIGUOUS content match ... distinct give-up batches' false collision against A's retired (now-retired) entry",
    !submitLog.some((l) => l.includes("AMBIGUOUS content match")));
  check("(1) N's held duplicate was purged — nothing left to drain a further physical write",
    host.getPendingEntries(SID).length === 0);

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (2) THE ACTUAL BLOCKING FINDING (Code Review re-review): an UNRELATED message B interleaves — ====
  // ===== it drains past A while A is held, and B's OWN confirmation's Stop hook unconditionally shifts =====
  // ===== `giveUpConfirmQueue` (pre-existing, content-blind bookkeeping — see that call site's own doc) — ===
  // ===== so by the time A's cycle 2 confirms normally, the queue is ALREADY empty and A's own Stop hits ====
  // ===== `purgeConfirmedGiveUpRequeueCore`'s early-queue-empty return. A sweep placed only AFTER that ======
  // ===== early return (the original Major-1 fix) never runs for THIS turn-end — this scenario is what ======
  // ===== actually catches that gap; scenario (1) above cannot, because nothing ever empties its queue. =====
  {
  const SID = "sess-chain-retires-interleaved";
  const TEXT_A = "CHAIN_RETIRES_INTERLEAVED_ORIGINAL";
  const TEXT_B = "CHAIN_RETIRES_INTERLEAVED_UNRELATED_B";
  spawnReady(SID);

  // ----- A: cycle 1 gives up, held -----
  const rA = host.enqueueStdin(SID, TEXT_A);
  check("(2 setup) A delivered immediately, busy armed", rA.delivered === true && busyLog[SID]?.at(-1) === true);
  await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  const entriesA2 = host.getPendingEntries(SID);
  check("(2 setup) A's cycle 1 gave up, requeued, held", entriesA2.length === 1);
  const A2_LOGICAL_ID = entriesA2[0].id;
  const A2_TAGGED_TEXT = framePossibleDuplicate(TEXT_A, A2_LOGICAL_ID);

  // ----- B: a completely UNRELATED message, drains past the held A (busy is false after A's give-up), and -
  // ----- CONFIRMS NORMALLY — its own Stop hook unconditionally shifts giveUpConfirmQueue, emptying it, -----
  // ----- entirely independent of A. -----
  const rB = host.enqueueStdin(SID, TEXT_B);
  check("(2 setup) B delivered immediately (drains past the held A), busy armed", rB.delivered === true && busyLog[SID]?.at(-1) === true);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT_B });
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("(2 setup) B's turn ended cleanly, busy clears — this Stop already shifted the queue empty", busyLog[SID]?.at(-1) === false);
  check("(2 setup) A is still sitting held, completely untouched by B's unrelated turn", host.getPendingEntries(SID).length === 1);

  // ----- A redrains for cycle 2 (archives cycle 1's bare signature) -----
  await sleepPast(HOLD_MS + 150, HOLD_MS, "past GIVE_UP_HOLD_MS (A's cycle 1 hold)");
  host.reconcile();
  await sharedWaitUntil(() => busyLog[SID]?.at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
  check("(2 setup) A's cycle 2 is now in flight", host.getPendingEntries(SID).length === 0);

  // ----- cycle 2 CONFIRMS NORMALLY — with the queue ALREADY empty (from B's Stop above), this Stop hits ---
  // ----- Core's OWN early-queue-empty return, not the fallback's final line. -----
  submitLog.length = 0;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: A2_TAGGED_TEXT });
  check("(2 setup) A's cycle 2 normal confirmation did NOT content-match anything",
    !submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("(2 setup) A's turn ended cleanly, busy clears", busyLog[SID]?.at(-1) === false);

  // ----- THE FIX: even though THIS Stop hit the early-queue-empty exit inside Core, the WRAPPER must still --
  // ----- have swept A's now-dead archive — verified via an unrelated N sharing A's original bare text. -----
  const TEXT_N = TEXT_A;
  submitLog.length = 0;
  const rN = host.enqueueStdin(SID, TEXT_N);
  check("(2 setup) N (unrelated, coincidentally same text as A's original) delivered immediately, busy armed",
    rN.delivered === true && busyLog[SID]?.at(-1) === true);
  await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check("(2 setup) N gave up, requeued, held", host.getPendingEntries(SID).length === 1);

  submitLog.length = 0;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT_N });
  check("(2) THE BLOCKING FIX: N's own late confirmation resolves CLEANLY even through the early-return exit path",
    submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  check("(2) THE BLOCKING FIX: NO false 'AMBIGUOUS content match' against A's (still-dead, now-retired) archive",
    !submitLog.some((l) => l.includes("AMBIGUOUS content match")));
  check("(2) N's held duplicate was purged — nothing left to drain a further physical write",
    host.getPendingEntries(SID).length === 0);

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card dbc7ffea's retiredGiveUpSignatures archive now retires a logicalId's entry once " +
    "its chain is provably no longer in flight, so a later, completely unrelated message that happens to " +
    "share byte-identical text with an already-resolved chain resolves cleanly instead of being falsely " +
    "declined as an ambiguous cross-batch collision — in both the canonical ordering (1) AND the " +
    "interleaved-message ordering (2) that the incomplete single-call-site fix could not see."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
