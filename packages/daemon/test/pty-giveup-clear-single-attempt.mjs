// Hermetic regression test for the give-up clear's PASTE-OPEN safety edge (pty/host.ts sendEnterAndVerify,
// card ee082fbb CR item ②, superseded by card 3ce3fa39) — a SEPARATE process from pty-giveup-clear.mjs
// because SUBMIT_MAX_ATTEMPTS is read from env once at import time and this file needs it pinned to 1, the
// degenerate config where give-up fires with NO paste-reassert ever having run for it.
//
// ORIGINAL (card ee082fbb) shape: sendEnterAndVerify's `if (attempt > 1) live.pty.write(START+END)` re-
// asserts (and so, per card 97558183, converges toward CLOSING) the paste bracket before every retried
// Enter. Give-up used to clear the composer immediately, gated on `attempt > 1` proving that re-assert had
// already run — the one signal available that the paste was likely closed. With SUBMIT_MAX_ATTEMPTS=1,
// give-up fires at attempt===1 with NO re-assert ever sent, so paste-open was unverified there — clearing
// would risk folding raw Backspace bytes in AS PASTE CONTENT, worse than the concatenation it was meant to
// fix. The old fix skipped the clear entirely in this one config.
//
// CARD 3ce3fa39 removed that `attempt > 1` gate: give-up no longer clears at give-up time AT ALL (for any
// attempt count — see pty-giveup-clear.mjs) — it only marks the composer possibly-dirty. The actual clear
// now lives in submit()'s own defensive clear-prefix, which ALWAYS force-closes via a fresh START+END pair
// immediately before backspacing, regardless of how the give-up happened. So the paste-open residual risk
// this file originally guarded is now covered STRUCTURALLY rather than by the attempt-count proxy — this
// test now proves that: even a give-up at attempt===1 (no re-assert ever sent for IT) still marks dirty,
// and the deferred clear on the NEXT write force-closes safely before backspacing, same as any other case.
//
// RUN (no daemon needed): node test/pty-giveup-clear-single-attempt.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-giveupclear1-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;
const VERIFY_TIMEOUT = 600;
const MAX_ATTEMPTS = 1; // the degenerate config under test — give-up fires at attempt===1, no re-assert ever ran
// Card 441499ee: after the verify-timeout elapses with no confirmation, GIVE-UP now takes ONE more short,
// bounded, OBSERVED wait for `enterConfirmed` (awaitGiveUpConfirmSettle) before actually committing to
// RECOVERY — nothing in this fake pty ever fires a confirming hook, so that wait always maxes out its
// bound.
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;
// Card 3ce3fa39: the deferred clear rides the requeued entry's own next redrain, HELD from drain for
// GIVE_UP_HOLD_MS pending a confirming hook (card 73d5c34a) — pinned small for this hermetic suite.
const HOLD_MS = 10;
const HOLD_WAIT = HOLD_MS + 20;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const BACKSPACE = "\x7f";
const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

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
  onEngineSessionId() {},
  onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
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
  return {
    fake, written: () => fake.writes.join(""),
    backspaceCount: () => fake.writes.join("").split(BACKSPACE).length - 1,
    entryCount: () => fake.writes.join("").split("\r").length - 1,
  };
}

try {
  const SID = "sess-giveup-single-attempt";
  const TEXT = "STRANDED_AT_ATTEMPT_ONE";
  const { written, backspaceCount, entryCount } = spawnReady(SID);
  const r = host.enqueueStdin(SID, TEXT);
  check("setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

  // Never confirm — give-up fires right after attempt 1's own verify window, with NO retry (and so no
  // START+END re-assert) ever having run FOR THIS ATTEMPT. Card bbada785: poll (bounded, observed) for
  // the give-up transition itself rather than sleeping a fixed budget past a computed worst-case deadline
  // — a fixed absolute deadline racing a timer-driven transition is exactly the exposure this card is
  // about. Nothing async can push busy back to true once give-up has fired, so the checks below are
  // settled the instant the poll observes it, not a guess about whether "not yet" == "never".
  const giveUpPollStart = Date.now();
  while (busyLog[SID].at(-1) !== false && Date.now() - giveUpPollStart < 15_000) {
    // TIMING-GUARD-SAFE: fully-awaited-completion — see the comment block immediately above this loop.
    await sleep(20);
  }
  check("exactly 1 Enter attempt was written (MAX_ATTEMPTS=1 — no retries)", entryCount() === 1);
  check("GIVE-UP RECOVERY: busy fell back to false", busyLog[SID].at(-1) === false);
  check("card 3ce3fa39: no clear at give-up time itself (deferred, regardless of attempt count)",
    backspaceCount() === 0);

  // Card 3ce3fa39: give-up at attempt===1 now STILL marks the composer possibly-dirty (the `attempt > 1`
  // gate this file used to test is gone — see the header). Drive the requeued entry's own redrain (past
  // the pinned-small hold) — card b9b8f8db: this redrain REDELIVERS the identical give-up'd message
  // (giveUpGen already set), so it retries ONLY the Enter — but the PASTE-OPEN safety this file exists to
  // guard is STILL exercised: the Enter-only path still writes its own force-close reassert (unconditionally,
  // not proxied by attempt count) before firing Enter, even though no re-assert ever ran for the original
  // attempt===1 give-up.
  const busyLenBeforeRedrain = busyLog[SID].length;
  const writesBeforeRedrain = written().length;
  await sleep(HOLD_WAIT);
  host.reconcile();
  const t1 = Date.now();
  // This polls (bounded, observed) for busy to fall back to false a SECOND time, i.e. for the redrain's own
  // give-up cycle to fully finish. submit()'s clear-prefix branch decision (repaste-vs-Enter-only) is made,
  // and any resulting backspace bytes are written, SYNCHRONOUSLY inside the single submit() call
  // reconcile() triggers at the top of this redrain — nothing async can add a LATER backspace for this same
  // generation, so the negative check below is settled the instant this poll observes the give-up cycle
  // complete, not a guess about whether "not yet" == "never".
  while (!(busyLog[SID].length > busyLenBeforeRedrain && busyLog[SID].at(-1) === false) && Date.now() - t1 < 15_000) {
    // TIMING-GUARD-SAFE: fully-awaited-completion — see the comment block immediately above this loop.
    await sleep(20);
  }
  check("the redrain (attempt===1 again, MAX_ATTEMPTS=1) also gave up — busy fell back to false a second time",
    busyLog[SID].at(-1) === false);
  check("card b9b8f8db: the SAME-message redrain writes ZERO backspaces — no clear-prefix at all",
    backspaceCount() === 0);
  check("card b9b8f8db: the body was pasted exactly ONCE — the redrain never re-pastes it",
    written().split(TEXT).length - 1 === 1);
  const firstBodyEnd = written().indexOf(TEXT) + TEXT.length;
  check("sanity: the redrain still wrote NEW bytes (a real second Enter attempt, not a no-op)",
    written().length > writesBeforeRedrain);
  const reassertIdx = written().indexOf(BRACKET_PASTE_START + BRACKET_PASTE_END, firstBodyEnd);
  check("PASTE-OPEN SAFETY, still structural on the Enter-only path: a force-close reassert precedes the redrain's "
    + "Enter even though attempt===1 never sent one of its own", reassertIdx > firstBodyEnd);
} finally {
  try { host.stop("sess-giveup-single-attempt", "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — with SUBMIT_MAX_ATTEMPTS=1, give-up recovers busy and marks the composer possibly-dirty (no immediate clear, deferred regardless of attempt count). Card b9b8f8db: the redrain REDELIVERS the identical give-up'd message, so it retries ONLY the Enter — zero backspaces, zero re-paste — but still force-closes any dangling paste bracket first (unconditionally, not proxied by attempt count), even though no paste-reassert ever ran for the original attempt===1 give-up — the ee082fbb CR residual-risk guard still holds structurally."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
