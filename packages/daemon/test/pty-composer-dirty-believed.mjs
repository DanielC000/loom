// Hermetic regression test for card c148f118: `composerDirtyLen` alone cannot tell "a defensive clear
// worked, only the repaste after it failed to confirm" apart from "the clear did nothing at all" — both
// land on the exact same number (see submit()'s own comment, card 2960c3bf: `44283 + 44323 = 88606`,
// identical regardless of whether the backspace burst actually cleared anything). This test proves the
// fix: `Live.composerDirtyLenBelieved` (the OPTIMISTIC counterpart — assumes every attempted clear
// worked, zeroed at write time rather than left to compound) diverges from `composerDirtyLen` (the
// UNCHANGED, conservative reading) exactly when — and only when — a clear attempt's outcome is still
// unresolved, giving a reader an honest range instead of one ambiguity-collapsing number.
//
// Three scenarios, matching the card's own DoD:
//   (1) NO defensive clear ever attempted — composerDirtyLenBelieved must track composerDirtyLen in
//       lockstep (byte-identical trajectory to today's composerDirtyLen-only behavior; nothing new
//       diverges when there's nothing to be ambiguous about).
//   (2) clear-then-CONFIRMED — decisive proof the whole ordered write (clear-prefix + fresh paste)
//       landed; both fields must read 0.
//   (3) clear-then-GIVE-UP (unconfirmed) — THE CARD'S OWN ACCEPTANCE TEST: composerDirtyLen keeps its
//       existing, UNCHANGED conservative arithmetic (old dirty + new write, additive, assuming the clear
//       failed); composerDirtyLenBelieved reads ONLY the new write (assuming the clear succeeded).
//       Asserted explicitly, and `composerDirtyLenBelieved < composerDirtyLen` strictly — the numeric
//       signal that a clear is unresolved, which no single field could express before this card.
//
// RUN (no daemon needed): node test/pty-composer-dirty-believed.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-composerdirtybelieved-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;
const HOLD_MS = 10;
const HOLD_WAIT = HOLD_MS + 20;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);

// Card 259c15fa (see pty-giveup-clear.mjs's own doc): give-up's real completion is a chain of chained
// setTimeout hops that routinely overshoots a hand-computed sum — poll for the OBSERVED busy=false
// transition instead of a fixed sleep.
const GIVE_UP_POLL_MS = 20;
const GIVE_UP_POLL_TIMEOUT_MS = 15_000;
async function waitForBusyFalse(busyLog, sessionId, t0) {
  while (busyLog[sessionId]?.at(-1) !== false && Date.now() - t0 < GIVE_UP_POLL_TIMEOUT_MS) await sleep(GIVE_UP_POLL_MS);
}

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const fake = { ...base, write: () => {} }; // never emits output — every give-up here is a GENUINE drop
    fakes.push(fake);
    return fake;
  }
}

const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {},
  onRateLimited() {}, onExit() {},
};

const host = new TestPtyHost(events);
function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

try {
  // ===================== (1) NO defensive clear ever attempted: composerDirtyLenBelieved tracks =========
  // ===================== composerDirtyLen IN LOCKSTEP — the regression guard: nothing new diverges when ==
  // ===================== there is nothing to be ambiguous about (byte-identical to today's single field) =
  {
    const SID = "sess-cdb-no-clear";
    const TEXT = "STRANDED_NO_CLEAR_EVER_ATTEMPTED";
    spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(1) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID]?.at(-1) === true);

    // Composer starts genuinely clean (composerDirtyLen was 0), so this give-up takes the PLAIN paste
    // branch, never the defensive-clear branch — there is nothing for composerDirtyLenBelieved to
    // optimistically zero.
    await waitForBusyFalse(busyLog, SID, t0);
    check("(1) GIVE-UP RECOVERY landed", busyLog[SID]?.at(-1) === false);
    check("(1) composerDirtyLen marked dirty at give-up, exactly the stranded length",
      host.getComposerDirtyLen(SID) === TEXT.length);
    check("(1) REGRESSION GUARD: composerDirtyLenBelieved equals composerDirtyLen exactly — no clear was ever attempted, so nothing diverges",
      host.getComposerDirtyLenBelieved(SID) === host.getComposerDirtyLen(SID));
    check("(1) sanity: composerDirtyLenBelieved is the stranded length too",
      host.getComposerDirtyLenBelieved(SID) === TEXT.length);
  }

  // ===================== (2) clear-then-CONFIRMED: decisive proof the whole ordered write landed — BOTH ===
  // ===================== fields collapse to true zero together ============================================
  {
    const SID = "sess-cdb-clear-confirmed";
    const TEXT1 = "FIRST_STRANDED_BODY_FOR_CONFIRM_CASE";
    const TEXT2 = "SECOND_MESSAGE_THAT_CLEARS_AND_CONFIRMS";
    spawnReady(SID);
    const t0 = Date.now();
    host.enqueueStdin(SID, TEXT1);
    await waitForBusyFalse(busyLog, SID, t0);
    check("(2) setup: first message gave up, dirty from a plain (non-clear) mark",
      host.getComposerDirtyLen(SID) === TEXT1.length && host.getComposerDirtyLenBelieved(SID) === TEXT1.length);

    // A DIFFERENT message now arrives while composerDirtyLen > 0 and composerLen === 0 — this is the
    // defensive-clear branch (submit()'s `else if` on `composerDirtyLen > 0 && composerLen === 0`).
    const r2 = host.enqueueStdin(SID, TEXT2);
    check("(2) setup: the different message was delivered immediately (busy was false)", r2.delivered === true);
    // SYNCHRONOUS assertion — composerDirtyLenBelieved is zeroed at WRITE time, inside submit() itself,
    // before any hook has fired. composerDirtyLen must NOT have moved yet (still the OLD conservative
    // value) — it only ever resets via a decisive confirm.
    check("(2) THE FIX, synchronous: composerDirtyLenBelieved zeroed the instant the clear-prefix was issued",
      host.getComposerDirtyLenBelieved(SID) === 0);
    check("(2) composerDirtyLen is UNCHANGED at this instant — still the old conservative total",
      host.getComposerDirtyLen(SID) === TEXT1.length);

    // Confirm THIS generation's own Enter — decisive proof the whole ordered stream (clear-prefix +
    // fresh paste) landed. Both fields must collapse to true zero.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    check("(2) THE FIX: composerDirtyLen resets to 0 on decisive confirm", host.getComposerDirtyLen(SID) === 0);
    check("(2) THE FIX: composerDirtyLenBelieved stays 0 on decisive confirm", host.getComposerDirtyLenBelieved(SID) === 0);
    // Deliberately no Stop hook here: TEXT1's own give-up left a requeued (un-purged, since gen 2's
    // confirm carried no content match against TEXT1) duplicate still pending — a Stop would drain it
    // and start a THIRD generation, which is a different scenario, not this one. What this scenario
    // exists to prove is already fully asserted above.
  }

  // ===================== (3) clear-then-GIVE-UP (unconfirmed): THE CARD'S OWN ACCEPTANCE TEST — the ========
  // ===================== exact ambiguity this card closes, asserted explicitly =============================
  {
    const SID = "sess-cdb-clear-giveup";
    const TEXT1 = "FIRST_STRANDED_BODY_FOR_GIVEUP_CASE";
    const TEXT2 = "SECOND_MESSAGE_THAT_CLEARS_THEN_ALSO_GIVES_UP";
    spawnReady(SID);
    const t0 = Date.now();
    host.enqueueStdin(SID, TEXT1);
    await waitForBusyFalse(busyLog, SID, t0);
    check("(3) setup: first message gave up, dirty from a plain (non-clear) mark",
      host.getComposerDirtyLen(SID) === TEXT1.length && host.getComposerDirtyLenBelieved(SID) === TEXT1.length);

    // A DIFFERENT message arrives while composerDirtyLen > 0 — takes the defensive-clear branch. Nothing
    // in this harness ever confirms, so this second write will ALSO give up.
    const t1 = Date.now();
    const r2 = host.enqueueStdin(SID, TEXT2);
    check("(3) setup: the different message was delivered immediately (busy was false)", r2.delivered === true);
    check("(3) synchronous: composerDirtyLenBelieved zeroed at the clear-prefix write",
      host.getComposerDirtyLenBelieved(SID) === 0);

    await waitForBusyFalse(busyLog, SID, t1);
    check("(3) the second message's own attempt also gave up (harness never confirms)", busyLog[SID]?.at(-1) === false);

    // THE ACCEPTANCE TEST: composerDirtyLen keeps its EXISTING, UNCHANGED arithmetic (additive,
    // unconditional — assumes the clear may have failed): old dirty (TEXT1) + this generation's own new
    // write (TEXT2). composerDirtyLenBelieved reads ONLY the new write — it assumed the clear worked, so
    // the old TEXT1 contribution was already zeroed out before TEXT2 was even written.
    check(`(3) composerDirtyLen (CONSERVATIVE, unchanged from before this card): TEXT1.length + TEXT2.length = ${TEXT1.length + TEXT2.length}`,
      host.getComposerDirtyLen(SID) === TEXT1.length + TEXT2.length);
    check(`(3) composerDirtyLenBelieved (OPTIMISTIC, the new field): TEXT2.length only = ${TEXT2.length}`,
      host.getComposerDirtyLenBelieved(SID) === TEXT2.length);

    // THE WHOLE POINT: before this card, there was exactly ONE field (composerDirtyLen) and it read
    // TEXT1.length + TEXT2.length here — the EXACT SAME NUMBER a fully-failed clear would have produced
    // too, so nothing distinguished "the clear worked, only the repaste failed to confirm" from "the
    // clear did nothing at all". Now the two fields DIVERGE — that divergence is the signal.
    check("(3) THE ACCEPTANCE TEST: composerDirtyLenBelieved is STRICTLY LESS than composerDirtyLen — the reader can now tell a clear was attempted and is unresolved, which a single field could never say",
      host.getComposerDirtyLenBelieved(SID) < host.getComposerDirtyLen(SID));
  }
} finally {
  for (const sid of ["sess-cdb-no-clear", "sess-cdb-clear-confirmed", "sess-cdb-clear-giveup"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — composerDirtyLenBelieved (card c148f118) tracks composerDirtyLen in lockstep when no clear is ever attempted (1); both fields collapse to a decisive 0 on a confirmed clear-then-repaste (2); and on a clear-then-give-up, composerDirtyLen keeps its unchanged conservative arithmetic while composerDirtyLenBelieved reads only the fresh write — the two fields diverging is exactly the signal that used to be indistinguishable from a fully-failed clear (3)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
