// Hermetic regression test for card 29b3c396: a GIVE-UP SUPPRESSED mark ("engine produced output after
// the final Enter write") used to `return` immediately and PERMANENTLY — busy stayed true forever with no
// later re-check, even when the "turn likely already running" premise was FALSE (no turn ever started).
// A live specimen showed this: turnSeq frozen, composerDirtyLen stuck, and TWO worker_flush attempts each
// re-entering the identical suppressed branch with no progress (`worker_flush` re-fires the same 4-attempt
// Enter ladder, which re-triggers the SAME output-based suppression via its own reassert-paste echo).
//
// THE FIX (pty/host.ts's `fireEnterAndVerify`): both give-up discriminators (output-seen and no-output)
// now route through the SAME bounded hook-based re-check (`awaitGiveUpConfirmSettle`, keyed on
// `enterConfirmed` — the free local proxy for "a turnSeq-advancing hook fired for this generation") before
// either is treated as terminal. A session that never once confirms now always falls through to GIVE-UP
// RECOVERY (busy cleared, the original message requeued via `requeueGiveUpOrigin`) instead of holding
// busy=true indefinitely.
//
// Scenario (1) is the FAILURE this card fixes: output-after-final-Enter forces the provisional SUPPRESSED
// log, but NO confirming hook ever arrives — assert GIVE-UP RECOVERY eventually fires (busy false, the
// original text requeued) instead of holding forever. It also asserts the fuller field-evidence signal set
// the manager's live-specimen measurement (post-kickoff) surfaced: `getPendingConfirmMs` (surfaced to
// managers as `unconfirmedDeliveryMs`) reads non-null and strictly increases while unconfirmed, and no
// `onTurnCompleted` event ever fires (the local proxy for "turnSeq never advances") — a session that never
// once confirms has, by definition, never completed a real turn either.
// Scenario (2) is the REQUIRED discriminating positive control (DoD-4): the SAME output-based suppression
// fires, but a REAL confirming hook lands within the bounded re-check window — assert it STAYS suppressed
// (busy stays true, nothing requeued) exactly like before this fix. A test exercising only scenario (1)
// would prove nothing, since both arms used to produce the identical (wrong, in scenario 1's case)
// terminal suppression.
// Scenario (3) is THE COMPOUNDING SHAPE the manager's field measurement added after this card's kickoff: on
// the real specimen, `composerDirtyLen` grew 1761 -> 8227 while `composerDirtyLenBelieved` stayed at 260 —
// the escalation ladder (a manager's `worker_message` landing on a still-stuck session) fed a SECOND,
// independent give-up cycle on TOP of the first, and the two fields diverge instead of staying in lockstep.
// This reproduces that mechanism directly: message A gives up and is held; while A sits held, message B (a
// different, longer message — modelling the manager's own escalation) submits immediately and ALSO gives
// up. Assert `composerDirtyLen` becomes A+B (additive, compounding) while `composerDirtyLenBelieved` reads
// only B's own fresh contribution (diverging) — then assert THIS card's fix still resolves it: busy does
// not stay stuck, both messages end up requeued rather than lost, and no turn ever actually completed
// throughout (turnSeq-frozen proxy) despite the compounding.
//
// RUN (no daemon needed): node test/pty-giveup-suppressed-terminal-recheck.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForCount(getCount, target, timeoutMs = 5000) {
  await sharedWaitUntil(() => getCount() >= target, { timeoutMs, intervalMs: 2, label: `waitForCount: count reaching ${target}` });
}
// Card b64b3726 (see pty-giveup-false-negative.mjs's identical helper): spin until the real clock has
// genuinely ticked PAST an observed Enter-write timestamp before emitting synthetic output, so the
// product's intentionally-strict `>` discriminator (same-ms reads as "no output after") isn't raced into a
// flaky RECOVERY instead of the intended SUPPRESSED outcome.
async function awaitClockPast(t) {
  while (Date.now() <= t) await sleep(1);
}
// Card ba4eebc1: the local `waitUntil(predicate, timeoutMs, label)` poll loop that used to sit here was
// deleted — canonical-compatible (throw-on-timeout, positional predicate + timeout) but its OWN 3rd
// positional arg was `label`, not `intervalMs` (this file's own instance of the exact silent-misread this
// card exists to eliminate) — every call site below was read individually and its label string moved into
// the options object's `label:` field, never `intervalMs:` (this file's fixed poll interval was always 2ms,
// with no caller-settable knob — so `intervalMs: 2` on every converted call site is that same fixed value,
// not a per-call default).

const tmpHome = path.join(os.tmpdir(), `loom-giveupsuppressedrecheck-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;      // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600;  // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;      // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const REASSERT_SETTLE_POLL = 10;
const REASSERT_SETTLE_MAX_POLLS = 5;
const REASSERT_SETTLE_BOUND = REASSERT_SETTLE_POLL * REASSERT_SETTLE_MAX_POLLS;
// The bounded hook-based re-check this card adds — deliberately SMALL so the test runs fast, mirroring
// how the pre-existing (no-output) branch's own window is already sized (short, does not try to cover the
// full hook-latency distribution — see GIVE_UP_CONFIRM_SETTLE_POLL_MS's own doc in pty/host.ts).
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;
const CONFIRM_SETTLE_BOUND = CONFIRM_SETTLE_POLL * CONFIRM_SETTLE_MAX_POLLS;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(REASSERT_SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(REASSERT_SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
const writeAt = (k) => ENTER_DELAY + (k - 1) * VERIFY_TIMEOUT + (k === MAX_ATTEMPTS && k > 1 ? REASSERT_SETTLE_BOUND : 0);
const giveUpAt = () => writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const enterWriteTimes = [];
    let onDataCb = null;
    const fake = {
      ...base,
      write: (d) => { writes.push(d); if (d === "\r") enterWriteTimes.push(Date.now()); },
      onData: (cb) => { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
      writes,
      enterWriteTimes,
      emitOutput: (s = ".") => { if (onDataCb) onDataCb(Buffer.from(s, "utf-8")); },
    };
    fakes.push(fake);
    return fake;
  }
}

const busyLog = {};
// Card 29b3c396 (field-evidence follow-up): the local, PtyHost-layer proxy for "turnSeq advanced" — the
// daemon only bumps the DB-persisted turnSeq from THIS SAME chokepoint (host.ts's own onTurnCompleted call,
// fired at the genuine Stop-hook chokepoint — see that call site's doc). A hermetic PtyHost-only harness
// has no DB, so this counter is the equivalent, real signal: it can only ever increment on an ACTUAL
// completed turn, never on a give-up/suppression/heal, so "stays at 0" here is the same claim as
// "turnSeq stays frozen" on the real specimen.
const turnCompletedLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {},
  onRateLimited() {}, onExit() {},
  onTurnCompleted(id) { turnCompletedLog[id] = (turnCompletedLog[id] ?? 0) + 1; },
};

const host = new TestPtyHost(events);

function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { fake, entryCount: () => fake.writes.join("").split("\r").length - 1 };
}

try {
  // ===== (1) THE BUG: output-based suppression, but NO turn ever actually starts =====
  {
    const SID = "sess-suppressed-never-starts";
    const TEXT = "STRANDED_TEXT_NO_TURN_EVER_STARTS";
    const { fake, entryCount } = spawnReady(SID);
    const r = host.enqueueStdin(SID, TEXT);
    check("(1) setup: idle-submit delivered, busy armed", r.delivered === true && busyLog[SID]?.at(-1) === true);

    // Fool the OUTPUT discriminator exactly like the false-negative/sticky tests: output after the FINAL
    // Enter write forces the provisional GIVE-UP SUPPRESSED branch, not the no-output RECOVERY branch.
    await waitForCount(entryCount, MAX_ATTEMPTS);
    await awaitClockPast(fake.enterWriteTimes[MAX_ATTEMPTS - 1]);
    fake.emitOutput("spinner-tick-after-final-enter");
    // Detect the SUPPRESSED branch firing via its own synchronous side effect (composerDirtyLen marked)
    // rather than a fixed sleep — this must land WELL inside the bounded re-check window below.
    await sharedWaitUntil(() => host.getComposerDirtyLen(SID) === TEXT.length, { timeoutMs: giveUpAt() + 2000, intervalMs: 2, label: "(1) suppression mark" });
    check("(1) provisional GIVE-UP SUPPRESSED fired (busy still true immediately after)", busyLog[SID]?.at(-1) === true);
    // Placed BEFORE the timing-sensitive reads below on purpose (not just style): this claim is a
    // STRUCTURAL invariant, not a race — `onTurnCompleted` is wired ONLY to the real Stop-hook chokepoint
    // (see the `events` object's own comment), and nothing in this scenario ever delivers ANY hook to this
    // session, so it cannot fire regardless of how long anything sleeps. Keeping it clear of the
    // `sleep(30)` below (rather than merely asserting it's TIMING-GUARD-SAFE) is the honest fix: there is
    // no wait this check depends on at all.
    check("(1) turnSeq-frozen proxy: no turn has ACTUALLY completed for this session yet", !turnCompletedLog[SID]);

    // Field-evidence signal: `getPendingConfirmMs` (unconfirmedDeliveryMs) is a live clock reading, not a
    // static marker — read it twice with a real sleep between and assert it strictly increased, the same
    // positive-control shape worker-unconfirmed-delivery-signal.mjs already uses for this exact getter.
    const firstReading = host.getPendingConfirmMs(SID);
    check("(1) unconfirmedDeliveryMs reads non-null while this generation sits unconfirmed", typeof firstReading === "number");
    // TIMING-GUARD-FALSE-MATCH: keyword-in-methodology-aside — NEG_KEYWORDS' bare "not" below matches inside
    // the label's methodology parenthetical ("a live clock, not a static marker"), same shape as
    // worker-unconfirmed-delivery-signal.mjs's own identical annotation for this same getter (card 1c5dda5d).
    // The label's actual assertion (`secondReading > firstReading`) is POSITIVE-polarity and fails loudly on
    // a static/frozen value.
    await sleep(30);
    const secondReading = host.getPendingConfirmMs(SID);
    check("(1) unconfirmedDeliveryMs is monotonically increasing (a live clock, not a static marker)",
      typeof secondReading === "number" && secondReading > firstReading);

    // THE FIX: no confirming hook is EVER delivered for this generation. Before this card, busy would
    // stay true forever here. Now, the bounded re-check must eventually give up for real.
    await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: CONFIRM_SETTLE_BOUND + 2000, intervalMs: 2, label: "(1) GIVE-UP RECOVERY (busy=false)" });
    check("(1) THE FIX: GIVE-UP RECOVERY eventually fired — busy is no longer stuck true forever",
      busyLog[SID]?.at(-1) === false);
    check("(1) the original text was requeued (fail toward a duplicate, never a silent loss)",
      host.getPending(SID).includes(TEXT));
    check("(1) turnSeq-frozen proxy STILL holds after recovery: no turn ever actually completed",
      !turnCompletedLog[SID]);
  }

  // ===== (2) REQUIRED DISCRIMINATING CONTROL: a REAL, genuinely-late confirmation must STILL suppress =====
  {
    const SID = "sess-suppressed-genuinely-late";
    const TEXT = "STRANDED_TEXT_TURN_ACTUALLY_STARTED";
    const { fake, entryCount } = spawnReady(SID);
    const r = host.enqueueStdin(SID, TEXT);
    check("(2) setup: idle-submit delivered, busy armed", r.delivered === true && busyLog[SID]?.at(-1) === true);

    await waitForCount(entryCount, MAX_ATTEMPTS);
    await awaitClockPast(fake.enterWriteTimes[MAX_ATTEMPTS - 1]);
    fake.emitOutput("spinner-tick-after-final-enter");
    await sharedWaitUntil(() => host.getComposerDirtyLen(SID) === TEXT.length, { timeoutMs: giveUpAt() + 2000, intervalMs: 2, label: "(2) suppression mark" });
    check("(2) provisional GIVE-UP SUPPRESSED fired (busy still true)", busyLog[SID]?.at(-1) === true);

    // A REAL confirming hook lands immediately after — well inside the bounded re-check window opened by
    // the suppression above (the same-tick reaction here mirrors how fast a genuine same-generation
    // UserPromptSubmit can race in relative to the settle window in production).
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    check("(2) hook confirmed — busy reads true (a real turn, not a stuck one)", busyLog[SID]?.at(-1) === true);

    // Hold past the FULL bound the never-started scenario needed to recover, proving this arm does NOT
    // follow the same path — it must stay suppressed, not flip to GIVE-UP RECOVERY.
    // TIMING-GUARD-SAFE: fully-awaited-completion — `enterConfirmed` was already set true, SYNCHRONOUSLY,
    // by the `deliverHook` call immediately above, and nothing resets it back to false for this generation
    // short of a brand-new submit() (which nothing in this scenario issues) — so the internal
    // `awaitGiveUpConfirmSettle` poll chain's eventual verdict (confirmed:true, no requeue) is already
    // deterministically fixed the instant that hook fired. This sleep only gives that already-decided
    // chain time to catch up and log it; it is not a race against a still-uncertain outcome.
    await sleep(CONFIRM_SETTLE_BOUND + 200);
    check("(2) DISCRIMINATES from scenario (1): busy is STILL true (never wrongly recovered)",
      busyLog[SID]?.at(-1) === true);
    check("(2) DISCRIMINATES from scenario (1): nothing was requeued for this generation",
      !host.getPending(SID).includes(TEXT));

    // The turn now completes normally.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(2) turn completed cleanly afterward (busy false via the ordinary Stop path)",
      busyLog[SID]?.at(-1) === false);
  }

  // ===== (3) THE COMPOUNDING SHAPE (field-evidence follow-up): the escalation ladder feeds a SECOND, ======
  // ===== independent give-up cycle on top of the first — composerDirtyLen and composerDirtyLenBelieved ===
  // ===== diverge instead of staying in lockstep, and the fix must still resolve it ========================
  {
    const SID = "sess-suppressed-compounding";
    const TEXT_A = "MESSAGE_A_FIRST_GIVE_UP_CYCLE_AAAAAAAAAA";
    const TEXT_B = "MESSAGE_B_ESCALATION_LADDER_SECOND_GIVE_UP_CYCLE_BBBBBBBBBBBBBBBBBBBB";
    const { fake, entryCount } = spawnReady(SID);

    const rA = host.enqueueStdin(SID, TEXT_A);
    check("(3) setup: A delivered immediately, busy armed", rA.delivered === true && busyLog[SID]?.at(-1) === true);
    await waitForCount(entryCount, MAX_ATTEMPTS);
    await awaitClockPast(fake.enterWriteTimes.at(-1));
    fake.emitOutput("spinner-tick-after-final-enter-A");
    await sharedWaitUntil(() => host.getComposerDirtyLen(SID) === TEXT_A.length, { timeoutMs: giveUpAt() + 2000, intervalMs: 2, label: "(3) A's suppression mark" });
    check("(3) A's provisional GIVE-UP SUPPRESSED fired, both fields in lockstep (nothing to doubt yet)",
      host.getComposerDirtyLen(SID) === TEXT_A.length && host.getComposerDirtyLenBelieved(SID) === TEXT_A.length);

    // No confirming hook for A either — the fix's own bounded re-check recovers it (as scenario (1) proves
    // in isolation); this scenario cares about what happens NEXT, while A sits held.
    await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: CONFIRM_SETTLE_BOUND + 2000, intervalMs: 2, label: "(3) A's GIVE-UP RECOVERY" });
    check("(3) A is held (requeued, not yet eligible to redrain)", host.getPending(SID).includes(TEXT_A));

    // THE ESCALATION LADDER: B (a DIFFERENT, longer message — modelling a manager's worker_message landing
    // on a still-stuck session) arrives WHILE A sits held. Busy is false and A is ineligible, so B submits
    // IMMEDIATELY — this is the SAME "a fresh arrival bypasses a held entry" mechanism already covered by
    // pty-giveup-hold-until-confirmed.mjs / pty-enter-only-verifies-composer-trust.mjs, not new machinery.
    const entryCountBeforeB = entryCount();
    const rB = host.enqueueStdin(SID, TEXT_B);
    check("(3) B (a DIFFERENT, longer message) delivered immediately while A sits held", rB.delivered === true);
    // submit()'s own defensive clear-prefix fires SYNCHRONOUSLY for B (composerDirtyLen>0 from A): it
    // resets composerDirtyLenBelieved to 0 (card c148f118's "assume the clear works" optimism) at WRITE
    // time, before B's own Enter has even been attempted — composerDirtyLen (conservative) stays untouched.
    check("(3) B's clear-prefix zeroed composerDirtyLenBelieved synchronously (this generation's own fresh write)",
      host.getComposerDirtyLenBelieved(SID) === 0);
    check("(3) composerDirtyLen is unchanged so far — still just A's conservative total",
      host.getComposerDirtyLen(SID) === TEXT_A.length);

    // Force B's OWN give-up to ALSO be output-suppressed — the SAME mechanism as A, a second, independent
    // cycle stacking on top of the first.
    await waitForCount(entryCount, entryCountBeforeB + MAX_ATTEMPTS);
    await awaitClockPast(fake.enterWriteTimes.at(-1));
    fake.emitOutput("spinner-tick-after-final-enter-B");
    await sharedWaitUntil(() => host.getComposerDirtyLenBelieved(SID) === TEXT_B.length, { timeoutMs: giveUpAt() + 2000, intervalMs: 2, label: "(3) B's suppression mark" });
    check("(3) THE COMPOUNDING: composerDirtyLen is ADDITIVE (A+B) — matches the live specimen's 1761->8227 growth",
      host.getComposerDirtyLen(SID) === TEXT_A.length + TEXT_B.length);
    check("(3) THE DIVERGENCE: composerDirtyLenBelieved reads ONLY B's own fresh contribution — matches the " +
      "live specimen's low, non-tracking 260 reading",
      host.getComposerDirtyLenBelieved(SID) === TEXT_B.length);
    check("(3) the two fields have genuinely diverged (the live signal a manager reads to tell something's off)",
      host.getComposerDirtyLenBelieved(SID) < host.getComposerDirtyLen(SID));

    // THE FIX STILL HOLDS under compounding: no confirming hook for B either — busy must not stay stuck.
    const busyLenBeforeBRecovery = busyLog[SID].length;
    await sharedWaitUntil(() => busyLog[SID].length > busyLenBeforeBRecovery && busyLog[SID].at(-1) === false,
      { timeoutMs: CONFIRM_SETTLE_BOUND + 2000, intervalMs: 2, label: "(3) B's GIVE-UP RECOVERY" });
    check("(3) THE FIX HOLDS UNDER COMPOUNDING: busy resolved for B too, not stuck forever",
      busyLog[SID].at(-1) === false);
    const pendingNow = host.getPending(SID);
    check("(3) BOTH messages survive (fail toward a duplicate, never a silent loss) — nothing dropped by the compounding",
      pendingNow.includes(TEXT_A) && pendingNow.includes(TEXT_B));
    check("(3) turnSeq-frozen proxy: no turn ever ACTUALLY completed throughout the whole compounding cascade",
      !turnCompletedLog[SID]);
  }
} finally {
  for (const sid of ["sess-suppressed-never-starts", "sess-suppressed-genuinely-late", "sess-suppressed-compounding"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an output-based GIVE-UP SUPPRESSED that never confirms now falls through to GIVE-UP " +
    "RECOVERY (busy cleared, text requeued) instead of holding busy=true forever, while a genuinely-late " +
    "but REAL confirmation still stays suppressed — the two arms discriminate correctly. Also reproduces " +
    "the field-measured COMPOUNDING shape (an escalation-ladder message stacking a second give-up cycle on " +
    "the first, composerDirtyLen/composerDirtyLenBelieved diverging exactly as the live specimen showed) " +
    "and proves the fix still resolves it — busy never stays stuck, and no message is silently lost."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
