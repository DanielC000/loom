// Hermetic regression test for the give-up CLEAR (pty/host.ts sendEnterAndVerify + submit(), cards
// ee082fbb and 3ce3fa39).
//
// When submit()'s Enter never confirms after SUBMIT_MAX_ATTEMPTS, the session gives up and recovers
// busy (card 9549e322) — but if it left the stranded injection sitting in the composer, the NEXT turn
// would concatenate onto it. Card ee082fbb's original fix cleared it immediately, AT give-up time, with an
// exact Backspace(`\x7f`) burst. Card 3ce3fa39 found that immediate clear unreliable in production (three
// first-hand specimens: an abandoned message's clear-burst landed, per the daemon's own bookkeeping, yet
// the ORIGINAL text resurfaced — once doubled — glued onto a much later, unrelated submit) — give-up's own
// trigger condition ("the engine produced no output during the whole retry window") is exactly the
// condition under which a raw backspace burst is LEAST likely to be read and interpreted correctly.
//
// THE FIX (card 3ce3fa39): defer the clear. Give-up now only marks the composer POSSIBLY-DIRTY
// (`live.composerDirtyLen`, additive) and recovers busy immediately (synchronously — no burst to thread
// through). The actual clear is issued by submit() itself, immediately before ANY subsequent write's own
// paste — the one moment real corroboration exists for free (if that write's own Enter goes on to confirm,
// the engine demonstrably read the whole ordered stream, clear-prefix included). Still gated on
// `composerLen === 0` (card e1829591 — never risk a real human draft).
//
// The exact clear MECHANISM (why exact-backspace, not a blind Ctrl-U/Esc) was validated against a REAL
// claude engine — see test/_probe-composer-clear.mjs and _probe-composer-clear-2.mjs (manual, not part
// of this hermetic suite; requires a logged-in `claude`). Findings baked into this fix, summarized in the
// sendEnterAndVerify doc comment: the TUI collapses a long/multi-line paste into a single placeholder
// token; Ctrl-U cleared that placeholder but SILENTLY STRANDED earlier lines of a short un-collapsed
// multi-line paste (confirmed via the engine's own transcript); Esc needed a second press and left the
// composer worse off combined with another key; exact-backspace reliably emptied every case tested — but
// that probe exercised a RESPONSIVE engine, never the "wasn't reading at all" regime give-up fires in,
// which is exactly the gap 3ce3fa39 closes by moving the clear to a moment that regime doesn't apply.
//
// This hermetic test can only assert the BYTES-WRITTEN half (a fake pty can't model Ink's paste/composer
// state machine, and can't prove a clear was EFFECTIVE — see card 3ce3fa39's own note on why a fake-pty
// effectiveness assertion is tautological) — it proves the daemon writes the RIGHT clear byte count at the
// RIGHT moment (deferred to the next write, not at give-up time) IFF composerLen===0, and never touches the
// pty while a human draft is present. The real-engine half is the probe above.
//
// Card b9b8f8db (the composer-runaway fix) NARROWS this: the deferred clear-prefix above (force-close +
// exact-Backspace + full repaste) still fires for a message arriving after a give-up that is NOT itself a
// redelivery of the SAME message (see the NEW "different message" scenario below) — but a redrain that IS
// redelivering the identical give-up'd message (`giveUpGen` already set) now retries ONLY the Enter and
// never re-pastes the body at all. That's what stopped the composer runaway: composerDirtyLen is never
// reset except by confirmation, so a genuinely wedged session used to backspace+repaste the FULL
// accumulated total on EVERY redelivery cycle, compounding without bound. Scenarios (1) and (4) below are
// updated to prove the NEW no-repaste behavior for this exact (same-message) case; the NEW "different
// message" scenario proves the original clear-prefix mechanism is still exercised for the case it's still
// needed for.
//
// RUN (no daemon needed): node test/pty-giveup-clear.mjs
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

const tmpHome = path.join(os.tmpdir(), `loom-giveupclear-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
// Card b64b3726 Half 1: the FINAL attempt now waits (bounded, observed) for its own paste-reassert to
// settle BEFORE writing Enter. In this fake-pty harness NOTHING ever bumps lastOutputAt on its own (no
// emitData calls below), so that wait always maxes out its bound (~50ms) — shrunk via env so the retry
// chain still finishes quickly; see GIVE_UP_POLL_TIMEOUT_MS below for how completion is actually detected.
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
// Card 441499ee: after the verify-timeout elapses with no confirmation, GIVE-UP now takes ONE more short,
// bounded, OBSERVED wait for `enterConfirmed` (awaitGiveUpConfirmSettle) before actually committing to
// RECOVERY — nothing in this fake pty ever fires a confirming hook, so that wait too always maxes out its
// bound (~50ms), shrunk via env for the same reason as SETTLE_POLL above.
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;
// Card 3ce3fa39: the deferred clear rides the requeued entry's own next redrain, which — like every
// give-up requeue — is HELD from drain for GIVE_UP_HOLD_MS pending a confirming hook (card 73d5c34a).
// Pinned small so this hermetic suite doesn't wait the production default (20s) to observe it.
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

// Card 259c15fa: give-up's real completion is the sum of ~14 chained setTimeout hops (the first-attempt
// delay, two retry verify-timeouts, a settle-poll burst, a third verify-timeout, a confirm-settle-poll
// burst) — Node's setTimeout guarantees only a MINIMUM delay per hop, so real completion routinely lands
// tens to a few hundred ms past a hand-computed sum of the nominal delays (measured directly on a quiet
// host: 90-304ms of overshoot across 15 samples, one of which already exceeded this test's prior fixed
// 300ms margin). A fixed sleep-then-assert keyed to that computed deadline is a TIMING GUESS and flaked
// ~6-13% standalone for exactly this reason. Poll for the OBSERVED busy=false transition instead (mirrors
// scenario (4) below, which never had this problem) — this bound only guards against a genuine hang.
const GIVE_UP_POLL_MS = 20;
const GIVE_UP_POLL_TIMEOUT_MS = 15_000;
async function waitForBusyFalse(sessionId, t0) {
  while (busyLog[sessionId].at(-1) !== false && Date.now() - t0 < GIVE_UP_POLL_TIMEOUT_MS) await sleep(GIVE_UP_POLL_MS);
}

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
  return { fake, written: () => fake.writes.join(""), backspaceCount: () => fake.writes.join("").split(BACKSPACE).length - 1 };
}

try {
  // ===================== (1) composer-clean give-up → DEFERRED: marked possibly-dirty, NOT cleared here; ===
  // ===================== card b9b8f8db: the requeued entry's own next redrain is a redelivery of the ======
  // ===================== SAME message (giveUpGen already set) — it retries ONLY the Enter, no clear, no ====
  // ===================== repaste, so the body physically lands exactly ONCE, never twice ====================
  {
    const SID = "sess-giveup-clean";
    const TEXT = "STRANDED_REPORT_BODY";
    const { written, backspaceCount } = spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(1) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // Never deliver ANY confirming hook, and never touch the raw composer (composerLen stays 0 the whole
    // time — the daemon's own pty.write from submit() never counts toward it). Wait for give-up to
    // ACTUALLY land (observed, bounded — see GIVE_UP_POLL_TIMEOUT_MS's doc).
    await waitForBusyFalse(SID, t0);
    check("(1) GIVE-UP RECOVERY: busy fell back to false (bounded poll didn't time out)", busyLog[SID].at(-1) === false);
    check("(1) card 3ce3fa39: the clear is DEFERRED — no backspace written yet at give-up time itself",
      backspaceCount() === 0);

    // Card 441499ee/73d5c34a: give-up requeued TEXT at the front of pending, HELD from drain for
    // GIVE_UP_HOLD_MS. Wait past the (pinned-small) hold, then drive the redrain directly — this redrain is
    // a REDELIVERY of the identical give-up'd message (card b9b8f8db), so it must retry only the Enter.
    const busyLenBeforeRedrain = busyLog[SID].length;
    const writesBeforeRedrain = written().length;
    await sleep(HOLD_WAIT);
    host.reconcile();
    const t1 = Date.now();
    // Polls (bounded, observed) for busy to fall back to false a SECOND time, i.e. for the redrain's own
    // give-up cycle to fully finish. submit()'s clear-prefix branch decision (repaste-vs-Enter-only) and
    // any resulting backspace bytes are decided/written SYNCHRONOUSLY inside the single submit() call
    // reconcile() triggers — nothing async can add a LATER backspace for this same generation, so the
    // negative checks below are settled the instant this poll observes the give-up cycle complete.
    while (!(busyLog[SID].length > busyLenBeforeRedrain && busyLog[SID].at(-1) === false) && Date.now() - t1 < GIVE_UP_POLL_TIMEOUT_MS) {
      // TIMING-GUARD-SAFE: fully-awaited-completion — see the comment block immediately above this loop.
      await sleep(GIVE_UP_POLL_MS);
    }
    check("(1) the redrain itself also gave up (nothing in this harness ever confirms) — the redelivery still recovers busy",
      busyLog[SID].at(-1) === false);
    check("(1) card b9b8f8db: the SAME-message redrain never writes a backspace at all — no clear-prefix, ever",
      backspaceCount() === 0);
    check("(1) card b9b8f8db: the body was pasted exactly ONCE — the redrain never re-pastes it",
      written().split(TEXT).length - 1 === 1);
    // The redrain still DID write something (a force-close reassert + a fresh Enter attempt) — confirming
    // this is a genuine second physical attempt, not a no-op that silently skipped retrying altogether.
    check("(1) sanity: the redrain still wrote NEW bytes (a real second Enter attempt, not a no-op)",
      written().length > writesBeforeRedrain);
  }

  // ===================== (1b) card b9b8f8db, NEW: a DIFFERENT message arriving with composerDirtyLen>0 ======
  // ===================== (not a redelivery of the SAME give-up'd message) still gets the FULL, ORIGINAL ====
  // ===================== clear-prefix (force-close + exact-Backspace + full repaste) — the narrowing above ==
  // ===================== applies ONLY to a same-message redelivery, never to a genuinely new/different one ==
  {
    const SID = "sess-giveup-then-different";
    const TEXT = "FIRST_STRANDED_BODY";
    const OTHER = "A_GENUINELY_DIFFERENT_LATER_MESSAGE";
    const { written, backspaceCount } = spawnReady(SID);
    const t0 = Date.now();
    host.enqueueStdin(SID, TEXT);
    await waitForBusyFalse(SID, t0);
    check("(1b) setup: the first message gave up and left composerDirtyLen dirty", backspaceCount() === 0);

    // Enqueue a DIFFERENT message right away (before TEXT's own redelivery hold expires). `live.busy` is
    // already false (the give-up recovered it) and OTHER carries no give-up hold of its own, so it takes
    // enqueueStdin's IMMEDIATE path — a brand-new synthetic origin entry with no `giveUpGen`, submitted
    // straight away without ever touching TEXT's still-held, still-queued entry. This is exactly the
    // "something genuinely new needs to go out while stale dirt sits in the composer" case.
    const r2 = host.enqueueStdin(SID, OTHER);
    check("(1b) setup: the different message was accepted (queued or delivered)", r2.delivered === true || r2.queued === true);
    const t1 = Date.now();
    await waitForBusyFalse(SID, t1);
    check("(1b) THE ORIGINAL MECHANISM STILL APPLIES: the different message's own submit still wrote the full "
      + "exact-count Backspace clear-prefix before its paste", backspaceCount() === TEXT.length);
    check("(1b) THE ORIGINAL MECHANISM STILL APPLIES: the different message's body was pasted in full",
      written().includes(OTHER));
  }

  // ===================== (2) HUMAN-DRAFT SAFETY: composer-dirty give-up → NEVER cleared =====================
  {
    const SID = "sess-giveup-dirty";
    const TEXT = "ANOTHER_STRANDED_REPORT";
    const { written, backspaceCount } = spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(2) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // A human starts typing a draft partway through the failed retries — composerLen goes >0. This must
    // be treated EXACTLY like a genuine human draft (card e1829591: never destroy a user's uncommitted
    // draft) even though what's actually in the real TUI composer right now is the daemon's OWN stranded
    // paste (writeStdin can't distinguish the two — that's the whole point of the composerLen===0 gate:
    // it conservatively assumes a human might be mid-edit and refuses to touch the box at all).
    await sleepUntil(t0, ENTER_DELAY + VERIFY_TIMEOUT / 2);
    host.writeStdin(SID, "h"); // one printable char → composerLen becomes 1 ("composer-dirty")

    await waitForBusyFalse(SID, t0);
    check("(2) GIVE-UP RECOVERY: busy still falls back to false even when dirty (bounded poll didn't time out)", busyLog[SID].at(-1) === false);
    check("(2) HUMAN-DRAFT SAFETY: NO backspace clear was written while composerLen > 0",
      backspaceCount() === 0);
    check("(2) sanity: the human's own keystroke DID reach the pty (writeStdin never withholds real human bytes)",
      written().includes("h"));
  }

  // ===================== (3) confirmed turn (no give-up) → NEVER clears (existing happy path intact) =====
  {
    const SID = "sess-confirmed-no-giveup";
    const TEXT = "CONFIRMED_NORMALLY";
    const { backspaceCount } = spawnReady(SID);
    const r = host.enqueueStdin(SID, TEXT);
    check("(3) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(3) turn confirmed+ended normally", busyLog[SID].at(-1) === false);
    await sleep(VERIFY_TIMEOUT + VERIFY_TIMEOUT / 2); // well past where a give-up would have fired if the fix mis-armed
    check("(3) NO clear byte was ever written on a normally-confirmed turn (give-up path never triggers)",
      backspaceCount() === 0);
  }

  // ===================== (4) LARGE possibly-dirty amount, card b9b8f8db retargeting: a same-message redrain ==
  // ===================== no longer writes ANY burst (proven directly below) — the multi-chunk burst-lands- ===
  // ===================== completely-and-in-order + busy-blocks-a-concurrent-enqueue race this scenario was ===
  // ===================== built to guard STILL applies, but only for a DIFFERENT message arriving while a ====
  // ===================== large amount sits possibly-dirty (mirrors (1b), at a size that spans many chunks) ==
  // writeChunked (host.ts) is only SYNCHRONOUS up to PTY_WRITE_CHUNK_BYTES (1024, not env-overridable) — a
  // larger burst spans multiple 8ms-apart ticks. Give-up itself never writes any burst at all (card 3ce3fa39
  // — busy clears synchronously, no writeChunked to race); the burst only ever lives inside a submit() that
  // sets busy=true synchronously BEFORE kicking off the (non-blocking) clear-prefix + paste chain, so a
  // concurrent enqueue can never land mid-burst.
  {
    const SID = "sess-giveup-large";
    const TEXT = "X".repeat(50 * 1024); // 50 chunks of 1024 — several event-loop ticks worth of burst
    const OTHER = "A_GENUINELY_DIFFERENT_LATER_MESSAGE";
    const { written, backspaceCount } = spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(4) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    await waitForBusyFalse(SID, t0);
    check("(4) give-up eventually recovered busy (bounded poll didn't time out)", busyLog[SID].at(-1) === false);
    check("(4) DEFERRED: give-up itself never writes the (large) burst", backspaceCount() === 0);

    // Card b9b8f8db, PROVEN DIRECTLY: redriving TEXT itself (a same-message redelivery, giveUpGen already
    // set) writes NO burst at all — past its hold, a reconcile() only retries the Enter.
    const busyLenBeforeSameMsgRedrain = busyLog[SID].length;
    await sleep(HOLD_WAIT);
    host.reconcile();
    const tSame = Date.now();
    // Polls (bounded, observed) for busy to fall back to false a SECOND time, i.e. for this redrain's own
    // give-up cycle to fully finish. submit()'s clear-prefix branch decision and any resulting
    // backspace/repaste bytes are decided/written SYNCHRONOUSLY inside the single submit() call
    // reconcile() triggers — nothing async can add a LATER backspace/repaste for this same generation, so
    // the negative checks below are settled the instant this poll observes the give-up cycle complete.
    while (!(busyLog[SID].length > busyLenBeforeSameMsgRedrain && busyLog[SID].at(-1) === false) && Date.now() - tSame < GIVE_UP_POLL_TIMEOUT_MS) {
      // TIMING-GUARD-SAFE: fully-awaited-completion — see the comment block immediately above this loop.
      await sleep(GIVE_UP_POLL_MS);
    }
    check("(4) card b9b8f8db: the SAME-message (large) redrain writes ZERO backspaces — this is the fix",
      backspaceCount() === 0);
    check("(4) card b9b8f8db: the SAME-message redrain never re-pastes the large body either",
      written().split(TEXT).length - 1 === 1);

    // NOW the race this scenario still needs to guard: a DIFFERENT message arrives while `composerDirtyLen`
    // is still the full 50KB — its submit() carries the full, multi-chunk clear-prefix (busy=false, so this
    // takes enqueueStdin's IMMEDIATE path, exactly like (1b)).
    const t1 = Date.now();
    const rOther = host.enqueueStdin(SID, OTHER);
    check("(4) the different message was delivered immediately (busy was false)", rOther.delivered === true);
    // Immediately (same synchronous continuation — no await between) try to enqueue a THIRD, unrelated
    // message: busy is already true (set synchronously at submit()'s own start, card M1) the instant the
    // call above returns, so this must queue rather than interleave into the still-draining clear-prefix/
    // paste chunks on the pty's FIFO.
    const r3 = host.enqueueStdin(SID, "UNRELATED_THIRD_MESSAGE");
    check("(4) a message enqueued WHILE the large clear-prefix is still draining is queued, not delivered immediately",
      r3.delivered === false);

    await waitForBusyFalse(SID, t1);
    check("(4) the different message's own attempt also gave up (harness never confirms) — busy fell back to false again",
      busyLog[SID].at(-1) === false);
    check(`(4) the FULL burst landed: exactly ${TEXT.length} backspaces written despite spanning many chunks`,
      backspaceCount() === TEXT.length);
    const firstBodyEnd = written().indexOf(TEXT) + TEXT.length;
    const otherStart = written().indexOf(OTHER);
    check("(4) sanity: the different message's own body was pasted", otherStart > firstBodyEnd);
    check("(4) the full burst lands strictly BEFORE the different message's own paste begins",
      written().indexOf(BACKSPACE) > firstBodyEnd && written().lastIndexOf(BACKSPACE) < otherStart);
    // Sanity: this is a MULTI-chunk burst (proves the ordering assertion above is actually exercising the
    // race window this test guards, not trivially passing because the whole burst fit in one sync chunk).
    check("(4) sanity: the burst genuinely spanned multiple chunks (TEXT exceeds one PTY_WRITE_CHUNK_BYTES)",
      TEXT.length > 1024);
  }
} finally {
  for (const sid of ["sess-giveup-clean", "sess-giveup-then-different", "sess-giveup-dirty", "sess-confirmed-no-giveup", "sess-giveup-large"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — give-up marks the composer possibly-dirty instead of clearing immediately. Card b9b8f8db: a redrain that REDELIVERS the identical give-up'd message now retries ONLY the Enter — zero backspaces, zero re-paste, regardless of size (1, 4) — closing the composer-runaway bug. The ORIGINAL clear-prefix mechanism (force-close + exact-count Backspace + full repaste, IFF composerLen===0) still fires, unchanged, for a genuinely DIFFERENT message arriving while composerDirtyLen>0 (1b, 4) — a human draft mid-retry is still NEVER touched (2); a normally-confirmed turn never triggers a clear (3); and a large deferred burst for a different message still lands fully and in order, with busy blocking any concurrent enqueue from interleaving mid-burst (4)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
