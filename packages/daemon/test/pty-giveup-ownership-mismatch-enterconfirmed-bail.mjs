// Regression test for card 08ac0e79 round 3 (Code Review `3de1021c`) — `submit()`'s ownership-mismatch
// branch (pty/host.ts) now fires `maybeFireGiveUpRecoveryAlarm` and `requeueGiveUpOrigin` SYNCHRONOUSLY,
// at the mismatch site, before its own trailing M1 `setBusy(true)`. ONLY the busy-clear decision is still
// deferred (`giveUpWithoutWritingBusyClear`), gated on `live.enterConfirmed` and a stale-generation check.
//
// ROUND 2 OF THIS CARD HAD A REAL LOSS PATH: both the requeue and the alarm used to live inside the SAME
// deferred `setTimeout(0)` callback, gated on `live.submitGeneration !== gen`. That gate is correct for
// the busy-clear (a stale generation means some OTHER submit now owns `busy`) but wrong for the requeue:
// if a DIFFERENT message drains in the deferred window (e.g. the owning lineage's Stop triggers its own
// M2 drain, and a different-sender message was sitting queued), that drain bumps `submitGeneration` AND
// overwrites `live.giveUpOrigin` with its OWN origin — so by the time the deferred callback finally runs,
// the stale-gen check skips the requeue entirely, AND `live.giveUpOrigin` no longer even holds A's
// reference to requeue if it tried. A was already spliced out of `live.pending` at drain time (`onDeliver`
// already fired) — LOST for good. Reproduced by the Code Reviewer (see scenario (D) below, adapted from
// the reviewer's own repro script). Fixed by moving the requeue+alarm to the SYNCHRONOUS mismatch site in
// `submit()`, where `live.giveUpOrigin`/`live.giveUpOriginWrittenText` are freshly set by THIS call and
// nothing has had a chance to touch them yet — eliminating the race by construction, not by a tighter
// check. Verified safe (no synchronous drain or re-mismatch loop is triggered by requeueing before M1):
// `requeueGiveUpOrigin` only `unshift`s into `live.pending`; nothing between that unshift and `submit()`'s
// own trailing M1 `setBusy(true)` ever calls `drainPending`, so nothing can pick the requeued entry up
// within the same synchronous call stack. THIS "no synchronous drain" claim is SAME-SESSION only — it
// covers the requeue and the alarm, which never touch another session. It says nothing about a budget-
// EXHAUSTED member's `onGiveUpExhausted` callback, which can dispatch CROSS-session (round 4, scenario (F)
// below) — a different hazard (the M2 `finalizingTurn` guard is PtyHost-wide, not session-scoped), closed
// separately by deferring that one callback's invocation off-stack.
//
// See docs/decisions/08ac0e79-ownership-mismatch-giveup.md for the full investigation across all four
// rounds, including the TRUE strength of the fused-composer duplicate-delivery trade (MAJOR-2: the
// existing `ambiguousDispatches` content-match purge does NOT cover a genuinely fused prompt — whole-text
// equality can never match a joined/fused text — so in that case the duplicate is essentially always
// unpurged; see scenario (E) below for the narrower, different case where the purge DOES fire) and the
// residual stated at true strength (MINOR-3: the "no stall" claim holds only while the owning turn's own
// Stop actually arrives; a lost Stop still waits on `healIfStuck`'s staleness bound).
//
// THIS FILE PROVES, for all three ways a confirming hook can arrive relative to the mismatch, PLUS the
// two scenarios this round's review added:
//   (A) UserPromptSubmit lands in the gap, then the owning turn's own Stop lands later.
//   (B) Stop/StopFailure lands directly in the gap (busy is cleared by the Stop itself, not the give-up).
//   (C) No hook at all — the ordinary clear-and-requeue, unchanged by this fix.
//   (D) THE STALE-GEN LOSS THIS ROUND FIXES: a DIFFERENT pending message drains inside the window — A
//       must still survive (requeued, never lost), RED on round 2 (commit `1b90421c`).
//   (E) THE UPS-CONTENT SHAPE: a UserPromptSubmit reports A's own exact text as its `prompt` — observes
//       and asserts whichever real outcome the content-match purge produces (recorded, not assumed).
//   (F) ROUND 4: a Stop-drained mismatch that EXHAUSTS defers its onGiveUpExhausted callback OFF-STACK —
//       the cross-session dispatch it makes lands cleanly instead of throwing inside the M2 window. RED
//       on commit `8bd5ec6c` (round 3): the callback ran synchronously there, inside this same window.
// In (A)/(B)/(C): the origin is requeued SYNCHRONOUSLY, immediately after the mismatch — no wait needed
// at all for that part any more (round 2 needed `waitOrFail` because the requeue was still deferred back
// then; it is not, as of round 3). `live.enterConfirmed` gates ONLY the busy-clear decision, discriminated
// by WHICH specific hook delivery produced it (never a vacuous `.some()` over the whole busy-reason log —
// NIT-4 from this round's review), and `maybeFireGiveUpRecoveryAlarm` fires unconditionally.
//
// RED/GREEN verified by actually reverting `submit()`'s mismatch branch + `giveUpWithoutWritingBusyClear`
// to round 2's shape (commit `1b90421c`), rebuilding, and re-running this file — see the worker report for
// that transcript, not reproduced here (this suite has no self-reverting machinery).
//
// Reuses the EXACT Shape-1 ownership-mismatch setup pty-enter-only-verifies-composer-trust.mjs's own
// scenario (1) proves and pty-giveup-round3-minor2-wrotenothing.mjs already reuses (A gives up, B — a
// genuinely different lineage — clears+pastes its own body and ALSO gives up, so A's later redelivery
// finds B owns the composer and writes NOTHING at all) — see those files' own comments for the full
// derivation of the timing constants below.
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon,
//   pnpm build && node test/pty-giveup-ownership-mismatch-enterconfirmed-bail.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-giveup-ownership-enterconfirmed-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Same values as pty-giveup-round3-minor2-wrotenothing.mjs / pty-enter-only-verifies-composer-trust.mjs's
// own scenario (1) — see those files for the full derivation of why these specific numbers make A's hold
// long-expired and B's hold still-fresh by the time the redelivery reconcile() fires.
const ENTER_DELAY = 50;
const VERIFY_TIMEOUT = 600;
const MAX_ATTEMPTS = 3;
const HOLD_MS = 300;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "2";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// Capture `[busy] <sid> -> <bool> (<reason>)` lines so a scenario can assert WHO cleared/left busy —
// "it stayed/went false" alone can't tell "the give-up cleared it" apart from "the Stop hook cleared it,
// and the give-up left it alone", which is exactly the distinction this fix's own correctness turns on.
const busyReasonLog = {};
const BUSY_LINE_RE = /^\[busy\] (\S+) -> (true|false) \(([^)]+)\)/;
const realConsoleLog = console.log.bind(console);
console.log = (...args) => {
  if (typeof args[0] === "string") {
    const m = BUSY_LINE_RE.exec(args[0]);
    if (m) (busyReasonLog[m[1]] ??= []).push({ busy: m[2] === "true", reason: m[3] });
  }
  realConsoleLog(...args);
};
/** Entries logged for `sid` strictly AFTER `sinceLen` — the DISCRIMINATING form NIT-4 asked for: never a
 *  bare `.some()` over the WHOLE log, which can pass vacuously off an earlier, unrelated entry sharing the
 *  same reason string and proves nothing about what THIS specific hook delivery actually caused. */
const busyReasonsSince = (sid, sinceLen) => (busyReasonLog[sid] ?? []).slice(sinceLen);

// Card 08ac0e79 round 5 (CR a1be67e1): capture every console.error so scenario (F) can assert a DIRECT,
// UNTIMED negative — neither "M2 invariant violated" (the throw inside enqueueStdin's idle-submit path)
// nor "onGiveUpExhausted threw" (requeueGiveUpOrigin's own catch, which would log this if the throw above
// fired) was ever logged. This makes (F)'s RED an ASSERTION, not merely a `waitUntil` timeout shape.
const errorLog = [];
const realConsoleError = console.error.bind(console);
console.error = (...args) => {
  if (typeof args[0] === "string") errorLog.push(args[0]);
  realConsoleError(...args);
};

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}

const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {}, onRateLimited() {}, onExit() {},
};

function spawnReady(host, sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome, role: "manager", // role:"manager" so maybeFireGiveUpRecoveryAlarm's counter is exercised (card c00231e2 gates it to manager/platform)
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  return fakes[fakes.length - 1];
}

async function waitForBusyFalseAfter(sid, sinceLen, label) {
  await waitUntil(() => busyLog[sid]?.length > sinceLen && busyLog[sid]?.at(-1) === false,
    { timeoutMs: 10_000, label });
}

// Drives the SAME A/B give-up setup round3-minor2.mjs uses, up to (but not including) the mismatch
// redelivery itself — so each scenario below decides independently what happens in that exact gap.
async function setupOwnershipMismatchPrecondition(host, sid) {
  const TEXT_A = `${sid}_A_GIVES_UP_FIRST_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  const TEXT_B = `${sid}_B_TAKES_OWNERSHIP_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`;
  spawnReady(host, sid);
  const live = host.live.get(sid);

  let lenBefore = busyLog[sid]?.length ?? 0;
  host.enqueueStdin(sid, TEXT_A, "system", undefined, undefined, "agent");
  check(`${sid} setup: A delivered immediately, busy armed`, busyLog[sid]?.at(-1) === true);
  await waitForBusyFalseAfter(sid, lenBefore, `${sid} A's own give-up (RECOVERY)`);
  check(`${sid} setup: A is requeued (held) — pending holds exactly A`,
    live.pending.length === 1 && live.pending[0].text === TEXT_A);

  lenBefore = busyLog[sid].length;
  host.enqueueStdin(sid, TEXT_B, "system", undefined, undefined, "agent");
  check(`${sid} setup: B (a DIFFERENT message) delivered immediately while A sits held`, busyLog[sid]?.at(-1) === true);
  await waitForBusyFalseAfter(sid, lenBefore, `${sid} B's own give-up (RECOVERY)`);
  const pendingNow = live.pending;
  check(`${sid} setup: ordering is [B (just requeued, HELD), A (hold long expired)]`,
    pendingNow.length === 2 && pendingNow[0].text === TEXT_B && pendingNow[1].text === TEXT_A);

  return { live, TEXT_A, TEXT_B };
}

/** Fires the mismatch redelivery (A's hold long-expired, B still owns the composer) and asserts the
 *  SYNCHRONOUS half of the round-3 fix immediately — no wait needed: by the time `host.reconcile()`
 *  returns, `requeueGiveUpOrigin` has already run at the mismatch site in `submit()` itself. */
function fireMismatch(host, sid, TEXT_A) {
  const live = host.live.get(sid);
  const fake = fakes.at(-1);
  const writesBefore = fake.writes.length;
  const alarmCountBefore = live.giveUpRecoveryFiredAt.length;
  const busyReasonLenBefore = busyReasonLog[sid]?.length ?? 0;
  host.reconcile(); // A's redelivery hits the ownership mismatch synchronously; requeue+alarm fire in the SAME call, before this call's own trailing M1 setBusy(true)
  check(`${sid} setup: the mismatch redelivery wrote zero bytes (busy re-armed via the M1 invariant)`,
    busyLog[sid].at(-1) === true && fake.writes.slice(writesBefore).join("") === "");
  check(`${sid} THE FIX: A was requeued SYNCHRONOUSLY — already back in pending by the time reconcile() returns, no wait needed`,
    live.pending.some((m) => m.text === TEXT_A));
  check(`${sid} THE FIX: the alarm fired synchronously too — the counter already grew by exactly 1`,
    live.giveUpRecoveryFiredAt.length === alarmCountBefore + 1);
  return { live, fake, writesBefore, busyReasonLenBefore };
}

try {
  // ===================== (A) UserPromptSubmit lands in the gap, then the owning turn's own Stop lands ====
  // ===================== later — busy is left exactly as the hook made it ================================
  {
    const host = new TestPtyHost(events);
    const SID = "sess-giveup-hook-then-stop";
    const { TEXT_A } = await setupOwnershipMismatchPrecondition(host, SID);
    const { live } = fireMismatch(host, SID, TEXT_A);

    const upsReasonLenBefore = busyReasonLog[SID]?.length ?? 0;
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    check("(A) setup: the hook set enterConfirmed (per-Live, not per-generation)", live.enterConfirmed === true);
    check("(A) busy was left exactly as the hook made it — no \"give-up-ownership-mismatch\" clear among "
      + "the entries THIS UserPromptSubmit delivery itself produced",
      !busyReasonsSince(SID, upsReasonLenBefore).some((e) => e.reason === "give-up-ownership-mismatch"));

    // The owning turn now genuinely ends — its own Stop clears busy normally. B's lineage still owns the
    // composer afterward, and Stop's own M2 drain window immediately retries A, hitting the SAME mismatch
    // again — this file does not assert A's fate a second time here (that would race an uncontrolled
    // second async cycle); the fate this scenario exists to prove is already established by fireMismatch.
    // TIMING-GUARD-SAFE: non-gating-settle-pause — this sleep only lets A's giveUpHeldUntil (a known,
    // bounded production constant) expire; the check below is anchored to the Stop hook delivery itself
    // (a direct, synchronous call) via a length-snapshot taken right before it, never to this sleep's own
    // duration — the real gate lives there.
    await new Promise((r) => setTimeout(r, HOLD_MS + 100));
    const stopReasonLenBefore = busyReasonLog[SID]?.length ?? 0;
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(A) THE DISCRIMINATING CHECK (NIT-4): among the busy-reason entries THIS Stop delivery itself "
      + "produced, \"stop-hook\"/false is present — not a bare .some() over the whole log",
      busyReasonsSince(SID, stopReasonLenBefore).some((e) => e.reason === "stop-hook" && e.busy === false));
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (B) Stop/StopFailure lands directly in the gap — busy is cleared by the Stop ====
  // ===================== itself (the give-up never touches it) ============================================
  {
    const host = new TestPtyHost(events);
    const SID = "sess-giveup-stop-direct";
    const { TEXT_A } = await setupOwnershipMismatchPrecondition(host, SID);
    const { live } = fireMismatch(host, SID, TEXT_A);

    const stopReasonLenBefore = busyReasonLog[SID]?.length ?? 0;
    // SYNCHRONOUS, same tick: the owning turn's Stop/StopFailure lands directly, with no prior
    // UserPromptSubmit — Stop ALSO sets enterConfirmed (deliverHook's Stop case) AND clears busy itself
    // via its own "stop-hook" reason, before the deferred busy-clear callback ever runs.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(B) setup: the Stop hook set enterConfirmed", live.enterConfirmed === true);
    check("(B) THE DISCRIMINATING CHECK: among the entries THIS Stop delivery itself produced, "
      + "\"stop-hook\"/false is present (busy already false by the time the give-up's own deferred "
      + "callback could ever run)",
      busyReasonsSince(SID, stopReasonLenBefore).some((e) => e.reason === "stop-hook" && e.busy === false));

    // Let the deferred busy-clear decision settle too (it bails on enterConfirmed, touching nothing).
    await new Promise((r) => setTimeout(r, 50)); // TIMING-GUARD-SAFE: non-gating-settle-pause — flushes the already-scheduled setTimeout(0); the check below reads state directly, not this sleep's duration
    check("(B) the give-up itself never fired setBusy at all — \"give-up-ownership-mismatch\" never "
      + "appears anywhere in this session's busy log",
      !(busyReasonLog[SID] ?? []).some((e) => e.reason === "give-up-ownership-mismatch"));
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (C) No hook at all — the ordinary clear-and-requeue, unchanged by this fix ======
  {
    const host = new TestPtyHost(events);
    const SID = "sess-giveup-no-hook";
    const { TEXT_A } = await setupOwnershipMismatchPrecondition(host, SID);
    const { live } = fireMismatch(host, SID, TEXT_A);
    check("(C) setup: enterConfirmed is still false — no hook delivered in this scenario's gap",
      live.enterConfirmed === false);

    const clearReasonLenBefore = busyReasonLog[SID]?.length ?? 0;
    await waitForBusyFalseAfter(SID, busyLog[SID].length, "(C) the deferred busy-clear settles (no hook ever confirmed)");
    check("(C) THE DISCRIMINATING CHECK: among the entries THIS settle produced, \"give-up-ownership-"
      + "mismatch\"/false is present — the give-up itself cleared busy this time",
      busyReasonsSince(SID, clearReasonLenBefore).some((e) => e.reason === "give-up-ownership-mismatch" && e.busy === false));
    check("(C) A is still in pending — unchanged by this fix for the no-hook case",
      live.pending.some((m) => m.text === TEXT_A));
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (D) THE STALE-GEN LOSS THIS ROUND FIXES: a DIFFERENT pending message drains ====
  // ===================== inside the window — A must still survive. RED on round 2 (commit 1b90421c) =====
  // Adapted from the Code Reviewer's own repro (3de1021c's scratch: repro/stop-drains-c.mjs).
  {
    const host = new TestPtyHost(events);
    const SID = "sess-giveup-stale-gen-stop-drains-c";
    const TEXT_C = `${SID}_C_DIFFERENT_SENDER_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC`;
    const { TEXT_A } = await setupOwnershipMismatchPrecondition(host, SID);
    const { live } = fireMismatch(host, SID, TEXT_A);

    // A DIFFERENT message, from a DIFFERENT sender, arrives while busy is still true from the mismatch's
    // own M1 — it queues (not held; it never gave up) behind A/B.
    host.enqueueStdin(SID, TEXT_C, "system", undefined, undefined, "agent", undefined, undefined, undefined, "other-sender");
    check("(D) setup: C is queued behind A/B, not yet delivered", live.pending.some((m) => m.text === TEXT_C));

    // The owning lineage's Stop lands — its own M2 drain window delivers whichever entry is ELIGIBLE
    // (not give-up-held) first. Round 2's bug: if THIS drain bumps submitGeneration and overwrites
    // live.giveUpOrigin before the OLD deferred callback ever got to requeue A, A was lost for good. With
    // the fix, A was ALREADY requeued synchronously at the mismatch site, long before this Stop ever runs
    // — there is nothing left for this drain to clobber.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    // TIMING-GUARD-SAFE: non-gating-settle-pause — round 4: on round 2's shape (commit 1b90421c) the
    // requeue+alarm ran inside a DEFERRED setTimeout(0), so an IMMEDIATE (same-tick) read right after this
    // Stop can't tell "lost for good" apart from "not yet re-added" — both read identically as absent at
    // that instant. This settle lets any such deferred callback actually fire before the check below reads
    // state; the check itself is anchored to live.pending directly, never to this sleep's own duration.
    await new Promise((r) => setTimeout(r, 100));
    check("(D) THE FIX: A survived — still present in pending after a different message drained inside "
      + "the window (this is RED on commit 1b90421c, confirmed by reverting)",
      live.pending.some((m) => m.text === TEXT_A));
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (E) THE UPS-CONTENT SHAPE: a UserPromptSubmit reports A's own exact text as its =
  // ===================== `prompt` — observes and records whichever real outcome the code produces ========
  {
    const host = new TestPtyHost(events);
    const SID = "sess-giveup-ups-content-match";
    const { TEXT_A } = await setupOwnershipMismatchPrecondition(host, SID);
    const { live } = fireMismatch(host, SID, TEXT_A);

    // With the synchronous requeue, A's `ambiguousDispatches` signature is ALREADY seeded (by
    // `requeueGiveUpOrigin`, called at the mismatch site) before this hook's own content-match purge logic
    // (`purgeConfirmedGiveUpRequeueCore`) ever runs — unlike the genuinely FUSED case (MAJOR-2: a fused
    // prompt can never whole-text-match), this hook reports EXACTLY A's own text, nothing joined.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT_A });

    const stillInPending = live.pending.some((m) => m.text === TEXT_A);
    // eslint-disable-next-line no-console
    console.log(`[test] (E) OBSERVED OUTCOME: A still in pending = ${stillInPending} (see docs/decisions/08ac0e79-ownership-mismatch-giveup.md, Round 3, for which outcome this is and why)`);
    // RECORDED OUTCOME (verified live against this build, not assumed): the content-match purge DOES find
    // and remove A — an exact (non-fused) content echo of A's own stored signature is exactly the shape
    // `purgeConfirmedGiveUpRequeueCore`'s whole-text equality is built to catch. Assert that outcome
    // explicitly, so a future change to this shape fails loudly here instead of silently.
    check("(E) THE RECORDED OUTCOME: the content-match purge removed A from pending (a genuine, "
      + "non-fused content echo of its own stored signature) — see the decision record for why this "
      + "differs from the fused case",
      stillInPending === false);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (F) ROUND 4: a Stop-drained mismatch that EXHAUSTS defers onGiveUpExhausted ======
  // ===================== OFF-STACK — the sender's cross-session dispatch lands cleanly, no M2 throw =======
  // Adapted from Code Review cba0d2f2's own repro (m2-park-notice.mjs). The exhausted branch used to call
  // `m.onGiveUpExhausted?.()` SYNCHRONOUSLY, inside `requeueGiveUpOrigin`'s own loop — and that call can
  // itself happen inside a Stop's own `deliverHook` `finalizingTurn` window (this exact scenario: a Stop
  // drains the mismatched, now-exhausted message). `sessions/service.ts`'s real PARK-branch callback can
  // enqueue a notice into a totally DIFFERENT, idle session, which trips `enqueueStdin`'s M2 invariant
  // guard and throws — silently swallowed by a bare catch there, losing the notice. This file has no
  // SessionService loaded, so it proves the SAME mechanism directly at the pty/host.ts layer instead: an
  // `onGiveUpExhausted` closure that calls `host.enqueueStdin` on a SECOND, idle session, fired from a
  // Stop-driven exhaustion on the FIRST session. RED on commit `8bd5ec6c` (confirmed by reverting, see the
  // worker report for that transcript — this suite has no self-reverting machinery).
  {
    const host = new TestPtyHost(events);
    const SID = "sess-giveup-exhaust-m2";
    const SID2 = "sess-giveup-exhaust-m2-recipient";
    const TEXT_A = `${SID}_A_EXHAUSTS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const TEXT_B = `${SID}_B_TAKES_OWNERSHIP_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`;
    const EXHAUST_NOTICE = `${SID}_EXHAUSTED_NOTICE_TO_RECIPIENT`;

    spawnReady(host, SID);
    const live = host.live.get(SID);
    spawnReady(host, SID2);
    const fakeSID2 = fakes.at(-1); // captured IMMEDIATELY after SID2's own spawn — `fakes` is append-only and shared across every session this file creates

    let lenBefore = busyLog[SID]?.length ?? 0;
    // A's ORIGINAL enqueue carries the onGiveUpExhausted callback under test — wired directly here (not
    // via the shared setupOwnershipMismatchPrecondition helper, which has no slot for it). `requeueGiveUpOrigin`'s
    // own `{...m, ...}` spread (see that method's doc) re-copies this same function reference forward on
    // every requeue cycle below, so it survives all the way to the exhausted (3rd) cycle.
    host.enqueueStdin(SID, TEXT_A, "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined,
      { onGiveUpExhausted: () => { host.enqueueStdin(SID2, EXHAUST_NOTICE, "system", undefined, undefined, "warning"); } });
    check(`${SID} setup: A delivered immediately, busy armed`, busyLog[SID]?.at(-1) === true);
    await waitForBusyFalseAfter(SID, lenBefore, `${SID} A's cycle-1 give-up (ordinary, not yet a mismatch)`);
    check(`${SID} setup: A is requeued (held) after cycle 1 — giveUpRequeues===1`,
      live.pending.length === 1 && live.pending[0].text === TEXT_A && live.pending[0].giveUpRequeues === 1);

    lenBefore = busyLog[SID].length;
    host.enqueueStdin(SID, TEXT_B, "system", undefined, undefined, "agent");
    check(`${SID} setup: B (a DIFFERENT message) delivered immediately while A sits held`, busyLog[SID]?.at(-1) === true);
    await waitForBusyFalseAfter(SID, lenBefore, `${SID} B's own give-up (RECOVERY)`);
    check(`${SID} setup: ordering is [B (just requeued, HELD), A (hold long expired)]`,
      live.pending.length === 2 && live.pending[0].text === TEXT_B && live.pending[1].text === TEXT_A);

    // Cycle 2: A's redelivery hits the ownership mismatch (B now owns the composer) — giveUpRequeues
    // 1->2, NOT yet exhausted (this file's own LOOM_GIVE_UP_REQUEUE_LIMIT="2" pin, near the top).
    host.reconcile();
    check(`${SID} cycle 2: A requeued again via the mismatch branch — giveUpRequeues===2, not yet exhausted`,
      live.pending.some((m) => m.text === TEXT_A && m.giveUpRequeues === 2));

    // B's own hold would otherwise expire at roughly the SAME wall-clock moment as A's fresh cycle-2 hold
    // (both stamped moments apart, around the same `Date.now()`), racing which one `drainPending` picks
    // first at cycle 3 below — NOT what this scenario is testing. Push B's hold far out so only A is
    // eligible when cycle 3 fires, deterministically.
    const bEntry = live.pending.find((m) => m.text === TEXT_B);
    if (bEntry) bEntry.giveUpHeldUntil = Date.now() + 10 * (HOLD_MS + 100);

    // TIMING-GUARD-SAFE: non-gating-settle-pause — only lets A's cycle-2 hold (a known, bounded production
    // constant) expire; the checks below are anchored to the Stop hook delivery itself and to SID2's own
    // busy transition, never to this sleep's own duration.
    await new Promise((r) => setTimeout(r, HOLD_MS + 100));

    const sid2BusyLenBefore = busyLog[SID2]?.length ?? 0;
    const errorLenBeforeCycle3 = errorLog.length;
    // Cycle 3, THE ONE UNDER TEST: a Stop for SID drains A inside deliverHook's own M2 finalizingTurn
    // window — A's redelivery hits the SAME mismatch (B still owns), giveUpRequeues 2->3, EXCEEDING the
    // limit: requeueGiveUpOrigin's exhausted branch fires, synchronously, still inside that window.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check(`${SID} cycle 3: A is gone from pending — exhausted, not requeued a third time`,
      !live.pending.some((m) => m.text === TEXT_A));

    // Card 08ac0e79 round 5 (CR a1be67e1): a DIRECT, UNTIMED assertion, checked IMMEDIATELY (before the
    // bounded wait below) — the M2 throw and requeueGiveUpOrigin's own catch logging it both fire
    // SYNCHRONOUSLY, inside this Stop's own deliverHook call, well before any later wait could time out.
    // On 8bd5ec6c this scans positive for BOTH strings; checking it here (not only after a bounded wait)
    // makes (F)'s RED an assertion, not merely a `waitUntil` timeout shape that crashes before reaching it.
    const errorsSinceCycle3 = errorLog.slice(errorLenBeforeCycle3);
    check(`${SID} cycle 3: no M2 invariant violation / onGiveUpExhausted throw was ever logged`,
      !errorsSinceCycle3.some((l) => l.includes("M2 invariant violated") || l.includes("onGiveUpExhausted threw")));

    // On 8bd5ec6c (round 3), onGiveUpExhausted ran SYNCHRONOUSLY right here, inside the Stop's own
    // finalizingTurn window — host.enqueueStdin(SID2, ...) would hit the M2 invariant guard (SID2 is idle,
    // pending empty) and THROW, caught by requeueGiveUpOrigin's own try/catch and logged (asserted against
    // directly above) — but SID2 itself never actually receives anything, since the throw fires BEFORE any
    // state mutation in enqueueStdin's idle-submit branch. On round 5 (this fix), the callback is deferred
    // via setTimeout(0) ONLY while `this.finalizingTurn` is true — it cannot fire until this whole
    // deliverHook call (through its own `finally`) has returned control to the event loop, by which point
    // `finalizingTurn` is false, so the SAME call succeeds cleanly.
    await waitUntil(() => (busyLog[SID2]?.length ?? 0) > sid2BusyLenBefore,
      { timeoutMs: 5_000, label: `${SID2} receives the deferred onGiveUpExhausted dispatch` });
    check(`${SID2} THE FIX: received the exhausted dispatch cleanly — busy armed, no M2 throw`,
      busyLog[SID2].at(-1) === true && fakeSID2.writes.join("").includes(EXHAUST_NOTICE));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
    try { host.stop(SID2, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 08ac0e79 round 3: submit()'s ownership-mismatch branch requeues and alarms "
    + "SYNCHRONOUSLY, before its own M1 setBusy(true), closing the stale-generation loss window a deferred "
    + "requeue could not; only the busy-clear decision stays deferred, correctly discriminated per hook "
    + "variant; and the UPS-content-echo shape's real outcome (purged, not lost) is recorded, not assumed. "
    + "Round 4: a budget-exhausted give-up's onGiveUpExhausted callback now runs OFF-STACK, so a Stop-"
    + "drained exhaustion's own cross-session dispatch no longer trips the M2 invariant guard."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
