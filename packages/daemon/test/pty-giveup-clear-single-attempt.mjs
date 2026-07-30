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
async function sleepUntil(t0, targetMs) {
  const remaining = targetMs - (Date.now() - t0);
  if (remaining > 0) await sleep(remaining);
}

const tmpHome = path.join(os.tmpdir(), `loom-giveupclear1-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;
const VERIFY_TIMEOUT = 600;
const MAX_ATTEMPTS = 1; // the degenerate config under test — give-up fires at attempt===1, no re-assert ever ran
// Card 441499ee: after the verify-timeout elapses with no confirmation, GIVE-UP now takes ONE more short,
// bounded, OBSERVED wait for `enterConfirmed` (awaitGiveUpConfirmSettle) before actually committing to
// RECOVERY — nothing in this fake pty ever fires a confirming hook, so that wait always maxes out its
// bound; giveUpAt() must account for it.
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;
const CONFIRM_SETTLE_BOUND = CONFIRM_SETTLE_POLL * CONFIRM_SETTLE_MAX_POLLS; // 50ms
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
const giveUpAt = () => ENTER_DELAY + VERIFY_TIMEOUT + CONFIRM_SETTLE_BOUND;

const { PtyHost } = await import("../dist/pty/host.js");

const BACKSPACE = "\x7f";
const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

const fakes = [];
function makeFakePty() {
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

class TestPtyHost extends PtyHost {
  createPty() { return makeFakePty(); }
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
  const t0 = Date.now();
  const r = host.enqueueStdin(SID, TEXT);
  check("setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

  // Never confirm — give-up fires right after attempt 1's own verify window, with NO retry (and so no
  // START+END re-assert) ever having run FOR THIS ATTEMPT.
  await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
  check("exactly 1 Enter attempt was written (MAX_ATTEMPTS=1 — no retries)", entryCount() === 1);
  check("GIVE-UP RECOVERY: busy fell back to false", busyLog[SID].at(-1) === false);
  check("card 3ce3fa39: no clear at give-up time itself (deferred, regardless of attempt count)",
    backspaceCount() === 0);

  // Card 3ce3fa39: give-up at attempt===1 now STILL marks the composer possibly-dirty (the `attempt > 1`
  // gate this file used to test is gone — see the header). Drive the requeued entry's own redrain (past
  // the pinned-small hold) and prove the deferred clear-prefix force-closes safely on its own before
  // backspacing, even though NO re-assert ever ran for the original attempt===1 give-up.
  const busyLenBeforeRedrain = busyLog[SID].length;
  await sleep(HOLD_WAIT);
  host.reconcile();
  const t1 = Date.now();
  while (!(busyLog[SID].length > busyLenBeforeRedrain && busyLog[SID].at(-1) === false) && Date.now() - t1 < 15_000) {
    await sleep(20);
  }
  check("the redrain (attempt===1 again, MAX_ATTEMPTS=1) also gave up — busy fell back to false a second time",
    busyLog[SID].at(-1) === false);
  check(`STRUCTURAL FIX: the redrain's own submit() carried the deferred clear-prefix — exactly ${TEXT.length} backspaces written`,
    backspaceCount() === TEXT.length);
  const firstBodyEnd = written().indexOf(TEXT) + TEXT.length;
  const secondBodyStart = written().indexOf(TEXT, firstBodyEnd);
  const firstBackspaceIdx = written().indexOf(BACKSPACE);
  check("sanity: the redrain genuinely re-pasted the body a second time", secondBodyStart > firstBodyEnd);
  check("the backspace burst sits AFTER the first (abandoned, attempt===1) paste and BEFORE the redrain's own paste",
    firstBackspaceIdx > firstBodyEnd && firstBackspaceIdx < secondBodyStart);
  const reassertIdx = written().lastIndexOf(BRACKET_PASTE_START + BRACKET_PASTE_END, firstBackspaceIdx);
  check("PASTE-OPEN SAFETY, now structural: a force-close reassert precedes the backspace burst even though attempt===1 never sent one of its own",
    reassertIdx > firstBodyEnd && reassertIdx < firstBackspaceIdx);
} finally {
  try { host.stop("sess-giveup-single-attempt", "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — with SUBMIT_MAX_ATTEMPTS=1, give-up recovers busy and marks the composer possibly-dirty (no immediate clear, deferred regardless of attempt count); the redrain's own submit() force-closes and backspaces safely even though no paste-reassert ever ran for the original attempt===1 give-up — the ee082fbb CR residual-risk guard now holds structurally, not via an attempt-count proxy."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
