// Hermetic regression test for card 4796f999 — "make an Enter-only retry verify what the composer
// holds" (pty/host.ts submit()).
//
// ROOT CAUSE (docs/investigations/f779b3da-giveup-redrain-race/findings.md — both specimens confirmed
// end-to-end from the real daemon log): the `b9b8f8db` "retry the Enter only, not re-pasting the body"
// path (submit()'s `isGiveUpRedelivery` branch) writes ZERO new paste bytes — it ASSUMES the composer
// still holds THIS message's own physical write. That assumption is invalidated the instant an
// INTERVENING generation's own clear-then-repaste (the `else if` branch immediately below it) fails to
// actually erase the terminal (`3ce3fa39`'s open, deliberately-unresolved territory). Neither branch ever
// checked the other's precondition:
//   - clear FAILED  -> composer holds two messages concatenated -> the Enter-only retry submits the
//     FUSION (specimen 1, `daf64e68`: `9709 + 1640 = 11349`).
//   - clear SUCCEEDED -> composer holds a DIFFERENT message entirely -> the Enter-only retry submits
//     THAT, and the message being retried is SILENTLY LOST (specimen 2, `fb924e0a`: a ~42k-char notice,
//     confirmed lost end-to-end from the receiving side).
//
// THE FIX reuses a signal that already existed but was never consulted here: `Live.composerDirtyLenBelieved`
// (card c148f118, see pty-composer-dirty-believed.mjs) — the OPTIMISTIC companion to `composerDirtyLen`
// (the CONSERVATIVE reading). Its own doc: "composerDirtyLenBelieved === composerDirtyLen means no clear
// attempt is currently unresolved — nothing to doubt. composerDirtyLenBelieved < composerDirtyLen means a
// clear WAS attempted and its outcome is still unverified." The Enter-only gate now ALSO requires the two
// fields to be equal — i.e. no OTHER generation's clear is currently unresolved — before trusting the
// composer. When they diverge, submit() now falls through to the EXISTING full clear+repaste branch
// instead, which re-pastes THIS redelivery's own real body rather than blindly trusting whatever is
// actually sitting in the composer.
//
// Traced against both real specimens' recorded byte counts (see the card body / findings.md):
//   specimen 2: composerDirtyLen=42486, composerDirtyLenBelieved=444 -> gap=42042 = exactly gen1's body.
//   specimen 1: composerDirtyLen=11349, composerDirtyLenBelieved=1640 -> gap=9709  = exactly gen7's body.
// In both cases the gap already flagged exactly the redelivery that must not trust Enter-only.
//
// ⚠️ WHAT THIS TEST DOES AND DOES NOT PROVE (read before trusting a green run):
// A hermetic fake-pty harness (below) is a WRITE-RECORDER, not a real terminal — it cannot model real
// engine/ConPTY behavior (whether a backspace burst actually erases rendered content, whether a paste
// gets misinterpreted). It therefore CANNOT reproduce, and does not claim to reproduce, the real-terminal
// FUSION or SUBSTITUTION outcome either specimen exhibited. What it DOES prove, directly, against the
// REAL production `submit()` control flow: the CODE now makes the fallback DECISION correctly — given the
// exact composerDirtyLen/composerDirtyLenBelieved divergence both real specimens exhibited, a give-up
// redelivery re-pastes its own real body instead of silently trusting the composer via a bare Enter. That
// is the mechanism both specimens traced back to; the real-terminal consequence is exactly what a correct
// decision here PREVENTS, not something this suite can independently witness.
//
// ⚠️ ALSO BOUNDED, not closed, by the known gap card `a6c1d413` already tracks: `composerDirtyLenBelieved`
// and `composerDirtyLen` are reset TOGETHER by a single-scalar confirm gate (`composerDirtyMarkedForGen`)
// that can zero an earlier, still-unresolved contribution when a LATER generation alone confirms. If that
// fires wrongly, the gap this fix checks for reads as "nothing to doubt" when there still is, and
// Enter-only still fires — but that is never WORSE than today's unconditional Enter-only, only less
// protective than this fix otherwise is. This suite does not exercise or claim to close that gap.
//
// Two scenarios reproduce the code-level mechanism each real specimen traced back to (the RECOVERY vs.
// SUPPRESSED flavor of the INTERVENING message's own give-up — the two ways a real specimen's clear ended
// up unresolved), plus a third regression guard proving the fix does not weaken `b9b8f8db` itself:
//   (1) mirrors specimen 1's mechanism: the intervening message's own give-up is a genuine RECOVERY drop.
//   (2) mirrors specimen 2's mechanism: the intervening message's own give-up is SUPPRESSED (a false
//       negative — the engine produced output after the final Enter) and only requeues later via
//       healIfStuck, exactly like the real specimen's own gen2->gen3 transition.
//   (3) REGRESSION GUARD: the plain single-message repeated-retry case (no OTHER message's clear ever
//       intervenes — the scenario b9b8f8db itself exists to fix) still takes Enter-only, unchanged.
//
// Every assertion reads the actual bytes physically written to the fake pty by the REAL submit() control
// flow (never a value re-derived from the same test-side computation it's compared against) — see project
// memory [[a-control-whose-two-sides-share-a-source-is-a-tautology]]: could this check fail if the
// production code were deleted? Yes — verified by reverting this card's fix locally (temporarily, via the
// sanctioned `git diff`/`git checkout HEAD --`/`git apply` patch recipe, never `git stash`) and re-running
// this file: scenarios (1) and (2) both go RED (the fallback-body assertion fails — Enter-only fires
// unconditionally, writing zero body bytes), scenario (3) stays GREEN either way (it is not this fix's own
// assertion).
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon, `pnpm build` then
// `node test/pty-enter-only-verifies-composer-trust.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sleepUntil(t0, targetMs) {
  const remaining = targetMs - (Date.now() - t0);
  if (remaining > 0) await sleep(remaining);
}

const BACKSPACE = "\x7f";

const tmpHome = path.join(os.tmpdir(), `loom-composertrust-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;       // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600;   // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;       // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
// Card 29b3c396 shrank this from 400 to 100: its OWN comment already said it was picked "small so
// healIfStuck's window is fast to test", and it is used in exactly ONE place in this whole file (scenario
// (2)'s own manual heal-trigger wait, below) — shrinking it further serves that SAME stated purpose better,
// and buys headroom for the re-check bound this card adds (see that bound's own comment for why the two
// had to be balanced together, not chosen independently).
const FIRST_TURN_STALE = 100; // mirrors LOOM_FIRST_TURN_STALE_MS
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
const SETTLE_BOUND = SETTLE_POLL * SETTLE_MAX_POLLS; // 50ms — sendEnterAndVerify's own pre-Enter reassert-settle
const CONFIRM_SETTLE_POLL = 50;
// Card 29b3c396: this bound now ALSO gates the output-based SUPPRESSED branch (fireEnterAndVerify no
// longer treats it as terminal — it falls through to this SAME hook-based re-check before committing
// GIVE-UP RECOVERY). Scenario (2) below deliberately keeps B's own SUPPRESSED give-up alive past a
// manually-driven heal point to mirror the real specimen's gen2->gen3 transition via healIfStuck
// specifically — so this bound must stay LARGER than that window, or B would self-recover via THIS card's
// OWN new re-check before the test's own manual `host.reconcile()` heal step ever runs, invalidating
// scenario (2)'s "SUPPRESSED never requeues by itself" setup assertions (harmlessly, not incorrectly: this
// card's own internal re-check would simply win the race and requeue B slightly earlier than this test's
// story intends — a real, desired improvement this file isn't testing).
// ⚠️ THE NOMINAL heal target is `giveUpAt() + FIRST_TURN_STALE*1.5` (150ms past B's give-up at
// FIRST_TURN_STALE=100), but the EFFECTIVE one is later: scenario (2)'s own earlier check already waits
// past `giveUpAt() + VERIFY_TIMEOUT/2` (300ms) on the SAME `sleepUntil(t1, …)` clock, and `sleepUntil` can
// only wait REMAINING time (never rewind) — so by the time this heal wait runs, its own target is already
// in the past and it no-ops, and `host.reconcile()` actually fires at ~300ms, not ~150ms. Harmless (300ms
// is staler still, so healIfStuck's own condition holds even more easily), but the MARGIN below is sized
// against the REAL (300ms) trigger point, not the nominal one, to avoid quietly overstating it.
//
// NOT MADE EVENT-BASED, and here's why: both `healIfStuck`'s staleness gate and this re-check's own give-up
// decision are ABSENCE-over-time claims (nothing fires when a duration elapses; nothing signals "no hook
// arrived yet") — there is no event to wait FOR, unlike the sticky test's own fix (pty-giveup-suppressed-
// composerdirty-sticky.mjs), which could replace its fixed sleep with waiting on a synchronous side effect.
//
// UNLIKE pty-healifstuck-clear.mjs's identical-looking bound (which costs that file NOTHING — every one of
// its scenarios forces the OUTPUT-based branch via emitData), this bound is NOT free here: scenario (1) (A
// AND B, both), scenario (2)'s own SETUP step for A, and scenario (3) (both its cycles) are all the PLAIN
// no-output give-up case, which already routed through this SAME awaitGiveUpConfirmSettle window BEFORE
// this card (that branch is unchanged by this fix) — FIVE cycles total in this file now pay this bound as
// ADDED wall-clock time, file-wide, since Node reads this env var once at module load and it cannot be
// varied per-scenario within one process.
//
// EMPIRICALLY MEASURED, not assumed (three iterations, each timed): (1) 2000ms (~3.3x over the ORIGINAL
// 600ms heal point) is the ratio the manager's review flagged as under-justified — a fair call, since
// nothing at the time explained why 3.3x was enough. (2) Blindly enlarging it to 30000ms (mirroring the
// OTHER file, on the theory that a bigger ceiling is free) made THIS file take 43s instead of its original
// ~4-5s, and independently made scenario (1) TIME OUT outright — `waitForBusyFalseAfter`'s own hardcoded
// 10_000ms ceiling was blown by a single now-30s-long genuine give-up. So "raise it, it's free" does NOT
// generalize across files: whether a bound is free depends on whether the SAME file ALSO pays it on its own
// no-output happy path, not on which card introduced it — this file does, pty-healifstuck-clear.mjs
// doesn't. (3) Shrinking FIRST_TURN_STALE (above) — a test-owned dial with exactly one consumer in this
// file, already documented as chosen "small" for speed — and landing this bound at 1500ms (POLL=50 * 30
// below) gives a 5x margin over the REAL ~300ms trigger point computed above (not the fictional 10x a naive
// reading of FIRST_TURN_STALE*1.5 would suggest), while measuring at ~22s total for this file (vs. ~4-5s
// before this card) — the five no-output cycles above are what that added time actually is. 5x is smaller
// than the 40-50x this card uses where the bound genuinely is free; it is the deliberate, reasoned floor
// for a file that pays this cost on every one of its own no-output cycles, not a value chosen for
// convenience. This residual slowdown is the accepted, explained cost of sharing one process-wide knob
// across both give-up flavors in a file that exercises both.
const CONFIRM_SETTLE_MAX_POLLS = 30; // 1500ms bound (POLL=50ms above) — 5x margin over the REAL ~300ms trigger point, see comment above
// Card 4796f999 flake fix: scenarios (1)/(3) below fire `host.reconcile()` in the SAME turn B's own
// give-up settles (no intervening `sleep`) — deliberately, so B's hold is still fresh and A's is provably
// long expired at that instant (see scenario (1)'s own comment). A too-small HOLD_MS gave that a real race
// against this file's OWN synchronous overhead (several `check()`/console.log calls between the
// `waitUntil`-observed busy-false and the `reconcile()` call, plus `waitUntil`'s own ~10ms poll interval) —
// caught empirically: 10ms flaked ~2/15 runs, B's hold occasionally already expired by the time reconcile()
// fired, so B (not A) drained. 300ms gives that overhead (realistically low single-digit ms) comfortable
// headroom while staying trivially smaller than the ~2s A-to-B gap this suite's own give-up cycles take.
const HOLD_MS = 300;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_FIRST_TURN_STALE_MS = String(FIRST_TURN_STALE);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1"; // production default
process.env.LOOM_MODE_LOG_POLL_MS = "5";

// writeAt(k)/giveUpAt(): the exact wall-clock offsets (from a submit's own t0) sendEnterAndVerify's chain
// reaches attempt k's write, and the moment the SUPPRESSED-vs-RECOVERY decision is made after the final
// attempt's verify-timeout elapses — same formula as pty-healifstuck-clear.mjs, proven there.
const writeAt = (k) => ENTER_DELAY + (k - 1) * VERIFY_TIMEOUT + (k === MAX_ATTEMPTS && k > 1 ? SETTLE_BOUND : 0);
const giveUpAt = () => writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    let onDataCb = null;
    const fake = {
      ...base,
      write: (d) => { writes.push(d); },
      onData: (cb) => { onDataCb = cb; return { dispose() {} }; },
      writes,
      // Test-only: synthetically fire engine output, exactly like a real onData would — this is how
      // scenario (2) below forces the SUPPRESSED (false-negative) give-up flavor deterministically,
      // without relying on real engine timing. Never called by scenario (1)/(3), so their give-ups are
      // genuine drops (no output at all) — the ordinary GIVE-UP RECOVERY path.
      emitData: (d) => { if (onDataCb) onDataCb(d); },
    };
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
    sessionId, cwd: tmpHome,
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

try {
  // ===================== (1) MIRRORS SPECIMEN 1: the intervening message's own give-up is a genuine ======
  // ===================== RECOVERY drop (no engine output at all) ===========================================
  {
    const host = new TestPtyHost(events);
    const SID = "sess-trust-fusion-shape";
    const TEXT_A = "ORIGINAL_NOTICE_BODY_MUST_NOT_BE_LOST_OR_FUSED_AAAAAAAAAAAAAAAAAAAA";
    const TEXT_B = "REPLACEMENT_UNRELATED_MESSAGE_ARRIVES_WHILE_DIRTY_BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const fake = spawnReady(host, SID);

    let lenBefore = busyLog[SID]?.length ?? 0;
    const rA = host.enqueueStdin(SID, TEXT_A, "system", undefined, undefined, "agent");
    check("(1) setup: A delivered immediately, busy armed", rA.delivered === true && busyLog[SID].at(-1) === true);
    await waitForBusyFalseAfter(SID, lenBefore, "(1) A's own give-up (RECOVERY)");
    check("(1) setup: A gave up — dirty from a plain (non-clear) mark, both fields in lockstep",
      host.getComposerDirtyLen(SID) === TEXT_A.length && host.getComposerDirtyLenBelieved(SID) === TEXT_A.length);
    check("(1) setup: A is requeued (held) — pending holds exactly A",
      host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT_A);

    lenBefore = busyLog[SID].length;
    const rB = host.enqueueStdin(SID, TEXT_B, "system", undefined, undefined, "agent");
    check("(1) setup: B (a DIFFERENT message) delivered immediately while A sits held", rB.delivered === true);
    // SYNCHRONOUS: the defensive clear-prefix branch fires for B (composerDirtyLen>0 from A) and zeros
    // composerDirtyLenBelieved at write time, before B's own Enter has even been attempted.
    check("(1) setup: B's clear-prefix zeroed composerDirtyLenBelieved synchronously",
      host.getComposerDirtyLenBelieved(SID) === 0);
    check("(1) setup: composerDirtyLen is unchanged — still A's old conservative total",
      host.getComposerDirtyLen(SID) === TEXT_A.length);

    await waitForBusyFalseAfter(SID, lenBefore, "(1) B's own give-up (RECOVERY)");
    check("(1) THE GAP: composerDirtyLen is additive (A+B), composerDirtyLenBelieved is only B's own fresh write",
      host.getComposerDirtyLen(SID) === TEXT_A.length + TEXT_B.length
      && host.getComposerDirtyLenBelieved(SID) === TEXT_B.length);
    check("(1) THE GAP (the signal this fix consumes): composerDirtyLenBelieved is STRICTLY LESS than composerDirtyLen",
      host.getComposerDirtyLenBelieved(SID) < host.getComposerDirtyLen(SID));
    const pendingNow = host.getPendingEntries(SID);
    check("(1) ordering: pending is now [B (just requeued, HELD), A (hold long expired)]",
      pendingNow.length === 2 && pendingNow[0].text === TEXT_B && pendingNow[1].text === TEXT_A);

    // A's redelivery: A's own hold (set way back at its first give-up) is long expired by now — B's is
    // FRESH (just set by its own give-up above) — so drainPending must skip held B and redeliver A. Fire
    // this the instant B's give-up settles (well inside B's own fresh HOLD_MS window, well past A's).
    const dirtyBeforeRedeliver = host.getComposerDirtyLen(SID);
    const writesBeforeRedeliver = fake.writes.length;
    host.reconcile();
    const newBurst = fake.writes.slice(writesBeforeRedeliver).join("");
    check("(1) ordering confirmed: A's redelivery drained (busy re-armed), not B's",
      busyLog[SID].at(-1) === true);
    check("(1) THE FIX: A's redelivery falls back to a full clear+repaste and re-pastes A's OWN real body "
      + "(not a bare Enter-only zero-length paste) — this is the assertion that goes RED against pre-fix code",
      newBurst.includes(TEXT_A));
    check("(1) THE FIX, the specific assertion the manager asked for: the re-pasted body is A's OWN, "
      + "not a foreign/wrong body (B's content is absent from this burst)",
      !newBurst.includes(TEXT_B));
    check("(1) the fallback backspaces the FULL conservative dirty amount (A+B) before repasting",
      newBurst.includes(BACKSPACE.repeat(dirtyBeforeRedeliver)));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (2) MIRRORS SPECIMEN 2: the intervening message's own give-up is SUPPRESSED =====
  // ===================== (a false negative) and only requeues later via healIfStuck ========================
  {
    const host = new TestPtyHost(events);
    const SID = "sess-trust-suppressed-shape";
    const TEXT_A = "ORIGINAL_LARGE_NOTICE_LOST_IF_BLINDLY_ENTERED_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const TEXT_B = "SECOND_UNRELATED_MESSAGE_ITS_OWN_GIVEUP_IS_SUPPRESSED_BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const fake = spawnReady(host, SID);

    let lenBefore = busyLog[SID]?.length ?? 0;
    const rA = host.enqueueStdin(SID, TEXT_A, "system", undefined, undefined, "agent");
    check("(2) setup: A delivered immediately, busy armed", rA.delivered === true && busyLog[SID].at(-1) === true);
    // A's own give-up is a genuine drop (emitData is never called for A) — ordinary RECOVERY.
    await waitForBusyFalseAfter(SID, lenBefore, "(2) A's own give-up (RECOVERY)");
    check("(2) setup: A gave up, dirty from a plain mark, both fields in lockstep",
      host.getComposerDirtyLen(SID) === TEXT_A.length && host.getComposerDirtyLenBelieved(SID) === TEXT_A.length);

    lenBefore = busyLog[SID].length;
    const t1 = Date.now();
    const rB = host.enqueueStdin(SID, TEXT_B, "system", undefined, undefined, "agent");
    check("(2) setup: B delivered immediately while A sits held", rB.delivered === true);
    check("(2) setup: B's clear-prefix zeroed composerDirtyLenBelieved synchronously",
      host.getComposerDirtyLenBelieved(SID) === 0);
    check("(2) setup: composerDirtyLen is unchanged — still A's old conservative total",
      host.getComposerDirtyLen(SID) === TEXT_A.length);

    // Force B's OWN give-up to be SUPPRESSED (a false negative — mirrors specimen 2's real gen2 exactly):
    // fire synthetic engine output shortly after B's final Enter write.
    await sleepUntil(t1, writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT / 3);
    fake.emitData("\x1b[<u\x1b[>1u\x1b[>4;2m"); // bytes don't matter, only that lastOutputAt advances
    await sleepUntil(t1, giveUpAt() + VERIFY_TIMEOUT / 2);
    check("(2) B's own give-up was SUPPRESSED — busy is STILL true (specimen 2's exact false-negative shape)",
      busyLog[SID].at(-1) === true);
    check("(2) THE GAP: SUPPRESSED still marks the same way RECOVERY does (mirrored additive marks)",
      host.getComposerDirtyLen(SID) === TEXT_A.length + TEXT_B.length
      && host.getComposerDirtyLenBelieved(SID) === TEXT_B.length);
    check("(2) SUPPRESSED never requeues by itself — pending still holds only A, B is not there yet",
      host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT_A);

    // Drive healIfStuck: ONE reconcile() call both (a) requeues B (via the stale-busy backstop, exactly
    // like specimen 2's real gen2->gen3 transition) AND, in the SAME synchronous pass, (b) drains the
    // queue — B is freshly held (ineligible), A's hold from long ago is expired, so A redelivers.
    const dirtyBeforeRedeliver = host.getComposerDirtyLen(SID);
    const writesBeforeHeal = fake.writes.length;
    await sleepUntil(t1, giveUpAt() + FIRST_TURN_STALE + FIRST_TURN_STALE / 2);
    host.reconcile();
    const newBurst = fake.writes.slice(writesBeforeHeal).join("");
    check("(2) heal requeued B (giving it a fresh hold) and, same pass, redelivered A instead — busy re-armed",
      busyLog[SID].at(-1) === true);
    check("(2) THE FIX: A's redelivery falls back to a full clear+repaste and re-pastes A's OWN real body "
      + "— this is the assertion that goes RED against pre-fix code",
      newBurst.includes(TEXT_A));
    check("(2) the re-pasted body is A's OWN, not a foreign/wrong body (B's content is absent from this burst)",
      !newBurst.includes(TEXT_B));
    check("(2) the fallback backspaces the FULL conservative dirty amount (A+B) before repasting",
      newBurst.includes(BACKSPACE.repeat(dirtyBeforeRedeliver)));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (3) REGRESSION GUARD: the plain single-message repeated-retry case (no OTHER =====
  // ===================== message's clear ever intervenes) still takes Enter-only, unchanged (b9b8f8db) ====
  {
    const host = new TestPtyHost(events);
    const SID = "sess-trust-no-intervening-message";
    const TEXT = "LOST_MESSAGE_RETRIED_ALONE_NO_OTHER_MESSAGE_EVER_INTERVENES";
    const fake = spawnReady(host, SID);
    const bodyCount = () => fake.writes.join("").split(TEXT).length - 1;
    const backspaceCount = () => fake.writes.join("").split(BACKSPACE).length - 1;

    let lenBefore = busyLog[SID]?.length ?? 0;
    const r = host.enqueueStdin(SID, TEXT, "system", undefined, undefined, "agent");
    check("(3) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);
    await waitForBusyFalseAfter(SID, lenBefore, "(3) cycle 1 give-up");
    check("(3) REGRESSION GUARD sanity: composerDirtyLenBelieved === composerDirtyLen — nothing to doubt, "
      + "no intervening clear ever happened",
      host.getComposerDirtyLenBelieved(SID) === host.getComposerDirtyLen(SID));

    lenBefore = busyLog[SID].length;
    // TIMING-GUARD-SAFE: fully-awaited-completion — this sleep only waits for the KNOWN-required hold
    // precondition (the requeued entry's own hold) to expire before reconcile() can redrain it; the
    // negative checks below are gated on `waitForBusyFalseAfter` immediately after, which POLLS for the
    // real, observed completion of cycle 2's own give-up — they are settled the instant that poll observes
    // it, not guessed from this fixed duration.
    await sleep(HOLD_MS + 30);
    host.reconcile();
    await waitForBusyFalseAfter(SID, lenBefore, "(3) cycle 2 give-up (redelivery)");
    check("(3) REGRESSION GUARD: card b9b8f8db is NOT weakened — the body was written to the pty exactly "
      + "ONCE across two full cycles (the redelivery retried the Enter only, never re-pasted)",
      bodyCount() === 1);
    check("(3) REGRESSION GUARD: zero backspaces were ever written — Enter-only touches nothing",
      backspaceCount() === 0);

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 4796f999: an Enter-only give-up redelivery now verifies what the composer holds "
    + "before trusting it, reusing composerDirtyLenBelieved (card c148f118) rather than blindly trusting "
    + "composerDirtyLen>0 alone. Mirrors both real specimens' own mechanism (RECOVERY-flavored intervening "
    + "clear, and SUPPRESSED-flavored via healIfStuck) — both fall back to a full clear+repaste that "
    + "re-pastes the redelivered message's OWN real body, never a foreign one. Card b9b8f8db's own win (no "
    + "intervening message, Enter-only, body written exactly once) is unweakened. See this file's header "
    + "for what a hermetic write-recorder harness does and does not prove."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
