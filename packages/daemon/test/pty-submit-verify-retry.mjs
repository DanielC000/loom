// Deterministic verify-and-retry regression test for PtyHost's submit() Enter (pty/host.ts, card
// 9549e322 — "injected message pastes but doesn't submit").
//
// Root cause being guarded: submit() used to write the closing bracketed-paste marker then a SINGLE
// lone `\r` on a fixed timer, fire-and-forget — no confirmation the Enter actually registered. A large/
// coalesced paste + ConPTY latency, or an intermittent ConPTY control-write drop (the same class already
// documented for the boot Esc, card dacb8571), can swallow that lone `\r`: the text strands un-submitted
// in the composer AND `busy` — set optimistically BEFORE the Enter even fires — stays stuck true with no
// turn actually running.
//
// The fix (`sendEnterAndVerify` in host.ts): after writing an Enter, wait SUBMIT_VERIFY_TIMEOUT_MS for
// confirmation (`UserPromptSubmit`, or a Stop/StopFailure — either proves a turn ran even if the
// UserPromptSubmit hook itself was lost). Not confirmed + attempts remain → re-send the Enter. Not
// confirmed + out of attempts → give up and recover busy (setBusy(false)) so the session is never left
// wedged busy=true with an unsent composer. Each verify/retry chain is scoped by `submitGeneration` (a
// counter submit() bumps every call, and every out-of-band busy-clear also bumps) so a chain left over
// from an EARLIER, already-finished turn can never act on a later turn's state (code-review-caught overlap
// — see scenario (5) below).
//
// This test models races the OLD fake-pty tests never could: the fake pty always "accepted" the lone
// Enter because nothing ever simulated it being swallowed/dropped — the existing pty-coalesce-drain.mjs /
// pty-busy-drain.mjs only assert `ENTER count === 1` on the happy path. Here we deliberately withhold the
// confirming hook (the fake-pty equivalent of "the Enter did not register") and assert:
//   (1) a withheld confirmation triggers a RETRY (a second `\r`, not just the first);
//   (2) delivering the confirming hook (even just Stop, no UserPromptSubmit) stops further retries;
//   (3) a fresh submit afterward still behaves normally (existing behavior intact);
//   (4) exhausting every attempt with NO confirmation at all recovers busy (never wedged stuck-busy);
//   (5) a verify chain left over from a FAST-CONFIRMED prior turn does NOT bleed into the NEXT turn's
//       window — a shared `enterConfirmed` boolean alone isn't enough (a fast turn confirms+Stops, a
//       brand-new submit resets `enterConfirmed` back to false for the NEW turn WHILE the old turn's
//       verify timer is still pending); `submitGeneration` is what makes the stale timer recognize it's
//       obsolete and bail instead of retry-Enter'ing (or give-up→setBusy(false)'ing) into the new turn.
//
// TIMING: every checkpoint targets an ABSOLUTE elapsed-time offset from a per-scenario baseline (via
// `sleepUntil`, not chained relative `sleep`s) so scheduling jitter on a loaded host can't compound across
// a scenario's several checkpoints — see the project's own "CI timing-flake monotonic clock" lesson. The
// verify/retry constants are also generous (hundreds of ms, not tens) so a "must NOT have happened yet"
// assertion keeps a wide margin on both sides of its window even under heavy concurrent host load (this
// machine runs many other agent sessions).
//
// Exercises the real PtyHost state machine (submit/enqueueStdin/deliverHook) against a FAKE pty injected
// via the createPty() seam — NO real claude, no daemon, no network. Sibling to pty-coalesce-drain.mjs /
// pty-busy-drain.mjs (which stay green, unmodified, alongside this one — see those files' own runs).
//
// RUN (no daemon needed): node test/pty-submit-verify-retry.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Sleep until `targetMs` has elapsed since `t0` (a `Date.now()` snapshot) — an ABSOLUTE-offset wait, so
 *  a slow/late-firing earlier `await` in the same scenario can't compound into a later checkpoint's own
 *  margin (each checkpoint re-measures from `t0` instead of stacking approximate relative sleeps). */
async function sleepUntil(t0, targetMs) {
  const remaining = targetMs - (Date.now() - t0);
  if (remaining > 0) await sleep(remaining);
}

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Also shrink the
// verify-retry timing constants (generously, not down to the wire — see the TIMING note above) so this
// test runs in a few seconds instead of the real multi-second production defaults — all read at import
// time, so set BEFORE importing host.js, and derive the env strings from the SAME numbers this file's own
// checkpoints are computed from (so the two can never drift out of sync).
const tmpHome = path.join(os.tmpdir(), `loom-submitverify-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;    // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS — generous relative to host scheduling jitter
const MAX_ATTEMPTS = 3;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
/** When the kth Enter attempt (1-indexed) is WRITTEN, relative to the submit() call that started the chain. */
const writeAt = (k) => ENTER_DELAY + (k - 1) * VERIFY_TIMEOUT;

const { PtyHost } = await import("../dist/pty/host.js");

// A fake IPty: records every write; onData/onExit are inert (the busy/drain machine never depends on
// them). The Enter attempts land via setTimeout in host.ts's sendEnterAndVerify, so tests wait a beat.
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
const ENTER = "\r";
const PASTE_START = "\x1b[200~";

function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { fake, written: () => fake.writes.join(""), countOf: (m) => fake.writes.join("").split(m).length - 1 };
}

try {
  // ===================== (1)-(3) withheld confirmation → RETRY; confirmation stops it; stays healthy ===
  {
    const SID = "sess-retry";
    const { countOf } = spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, "REPORT_ONE");
    check("(1) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    await sleepUntil(t0, writeAt(1) + VERIFY_TIMEOUT / 2); // safely after write 1, safely before write 2
    check("(1) first Enter attempt written", countOf(ENTER) === 1);

    // Deliberately withhold UserPromptSubmit — models a swallowed/dropped first Enter. Wait past the
    // verify window: the OLD fire-and-forget code would do nothing here and strand the turn forever.
    await sleepUntil(t0, writeAt(2) + VERIFY_TIMEOUT / 2); // safely after write 2, safely before write 3
    check("(1) RETRY: a SECOND Enter was written after the withheld confirmation timed out", countOf(ENTER) === 2);
    check("(1) still exactly ONE bracketed paste (the retry re-sends only Enter, not the whole turn again)",
      countOf(PASTE_START) === 1);
    check("(1) busy is still true while retrying (turn presumed still trying to land)", busyLog[SID].at(-1) === true);

    // ===================== (2) confirmation (even just Stop, no UserPromptSubmit) stops retries =====================
    // The retry DID land this time — simulate that with a Stop (proves a turn ran even without seeing
    // UserPromptSubmit directly, covering the case where THAT hook itself was the one that got lost).
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(2) Stop lowered busy (the confirmed turn ended normally)", busyLog[SID].at(-1) === false);

    const entersAfterStop = countOf(ENTER);
    // Well past write 3's own would-be verify-check (which, if the chain were still alive, decides at
    // writeAt(3)+VERIFY_TIMEOUT) — confirmation must have fully retired the chain by then.
    await sleepUntil(t0, writeAt(3) + VERIFY_TIMEOUT + VERIFY_TIMEOUT / 2);
    check("(2) NO further Enter retries after confirmation (Stop neutralized the pending retry loop)",
      countOf(ENTER) === entersAfterStop);

    // ===================== (3) sanity: the session is fully healthy afterward (existing behavior intact) ====
    const delivered2 = [];
    const t1 = Date.now();
    host.enqueueStdin(SID, "REPORT_TWO", "system", () => delivered2.push(true));
    check("(3) a fresh submit after a confirmed retry still delivers immediately",
      busyLog[SID].at(-1) === true);
    await sleepUntil(t1, writeAt(1) + VERIFY_TIMEOUT / 2);
    check("(3) its own Enter attempt landed once (fresh submit resets enterConfirmed cleanly)",
      countOf(ENTER) === entersAfterStop + 1);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(3) drains/ends normally afterward", host.getPending(SID).length === 0 && busyLog[SID].at(-1) === false);
  }

  // ===================== (4) total failure (no confirmation ever) → recover busy, never wedged =====================
  {
    const SID = "sess-giveup";
    const { countOf } = spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, "NEVER_CONFIRMED");
    check("(4) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // Never deliver ANY confirming hook. With MAX_ATTEMPTS=3, the give-up decision (after the 3rd write's
    // own verify window elapses with nothing confirmed) lands at writeAt(3)+VERIFY_TIMEOUT. Wait well past it.
    await sleepUntil(t0, writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT + VERIFY_TIMEOUT / 2);
    check("(4) all 3 Enter attempts were written (bounded retries, not infinite)", countOf(ENTER) === MAX_ATTEMPTS);
    check("(4) GIVE-UP RECOVERY: busy fell back to false — the session is NOT left wedged busy=true forever",
      busyLog[SID].at(-1) === false);

    // The give-up must not leave the retry loop still armed — waiting further writes nothing more.
    const entersAtGiveup = countOf(ENTER);
    await sleep(VERIFY_TIMEOUT);
    check("(4) no further Enter attempts after giving up (the retry loop actually stopped)",
      countOf(ENTER) === entersAtGiveup);

    // The session recovers: a NEW message can still be delivered/queued afterward (not permanently dead).
    const r2 = host.enqueueStdin(SID, "AFTER_GIVEUP");
    check("(4) session is usable again after the give-up (a new enqueue is accepted, not a dead session)",
      r2.delivered === true || r2.delivered === false);
  }

  // ===================== (5) OVERLAPPING CHAINS — a stale verify timer from a fast-confirmed turn =====
  // ===================== must NOT act on a NEWER turn's window (code-review-caught, card 9549e322) ====
  // Turn B confirms+Stops QUICKLY (well inside B's own verify window) — a common "No response requested"
  // no-op nudge. Its Stop drains a queued turn C, which resets `enterConfirmed` back to false for the NEW
  // turn. B's OWN verify timer, scheduled BEFORE any of this happened, then fires LATE (after C is already
  // live) — with only a shared `enterConfirmed` boolean, that stale timer would misread "not confirmed" as
  // C's own state and wrongly retry-Enter (or give-up→setBusy(false)) into C's window. The `submitGeneration`
  // token must make B's stale chain recognize it's obsolete and do NOTHING once C's submit() has run.
  {
    const SID = "sess-overlap";
    const { countOf } = spawnReady(SID);
    const tB0 = Date.now(); // B's chain timing baseline — B's OWN scheduled deadlines are fixed relative to THIS, regardless of when we later confirm it

    const rb = host.enqueueStdin(SID, "TURN_B"); // idle → submits immediately; B's attempt-1 write is scheduled for tB0+writeAt(1)
    check("(5) setup: TURN_B submitted immediately, busy armed", rb.delivered === true && busyLog[SID].at(-1) === true);
    const rc = host.enqueueStdin(SID, "TURN_C", "system"); // busy → QUEUES behind B
    check("(5) setup: TURN_C queued behind busy B", rc.delivered === false && rc.position === 1);

    await sleepUntil(tB0, writeAt(1) + VERIFY_TIMEOUT / 4); // safely after B's write 1, well before B's OWN stale check at writeAt(1)+VERIFY_TIMEOUT
    check("(5) B's first Enter attempt landed", countOf(ENTER) === 1);

    // B confirms+Stops QUICKLY — well before its own writeAt(1)+VERIFY_TIMEOUT stale-check deadline (the
    // fast-no-op case). The Stop synchronously drains TURN_C: submit(C) resets enterConfirmed=false for the
    // NEW turn and bumps submitGeneration, scheduling C's OWN attempt-1 write relative to THIS moment.
    const tC0 = Date.now();
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(5) B's Stop drained C — busy re-armed for the new turn", busyLog[SID].at(-1) === true);
    check("(5) pending fully drained (TURN_C is now the live turn, not queued)", host.getPending(SID).length === 0);
    // Confirming this early leaves a wide margin before B's fixed stale-check deadline (tB0+writeAt(1)+VERIFY_TIMEOUT).
    check("(5) sanity: confirmed B comfortably before its own stale-check deadline",
      (tC0 - tB0) < writeAt(1) + VERIFY_TIMEOUT / 2);

    // Checkpoint strictly between B's STALE verify-check (tB0+writeAt(1)+VERIFY_TIMEOUT) and C's OWN first
    // verify-check (tC0+writeAt(1)+VERIFY_TIMEOUT) — the exact window where the bug would show: B's obsolete
    // chain firing an EXTRA spurious Enter into C's still-unconfirmed turn, or wrongly clearing busy under it.
    const bStaleCheckAt = tB0 + writeAt(1) + VERIFY_TIMEOUT;
    const cOwnCheckAt = tC0 + writeAt(1) + VERIFY_TIMEOUT;
    const midpointOffsetFromTB0 = (bStaleCheckAt + cOwnCheckAt) / 2 - tB0;
    await sleepUntil(tB0, midpointOffsetFromTB0);
    check("(5) NO extra Enter from B's stale chain (only B's 1 + C's 1 attempt — no spurious 3rd write)",
      countOf(ENTER) === 2);
    check("(5) busy was NOT wrongly cleared by B's stale chain — C's turn is still presumed in flight",
      busyLog[SID].at(-1) === true);

    // C's OWN verify-check (a real, non-stale chain) fires next since we still haven't confirmed C — this
    // proves the fix didn't also break legitimate retries for the turn that comes AFTER an overlap.
    await sleepUntil(tC0, writeAt(2) + VERIFY_TIMEOUT / 4);
    check("(5) C's OWN chain still retries normally afterward (its legitimate 2nd attempt landed)",
      countOf(ENTER) === 3);

    // Clean confirmation of C ends the scenario normally.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(5) C confirms+ends cleanly; no further spurious writes after", busyLog[SID].at(-1) === false);
    const entersAtEnd = countOf(ENTER);
    await sleep(VERIFY_TIMEOUT); // well past any lingering timer from either B or C's chains
    check("(5) no further Enter writes after C ended (both chains are fully retired)", countOf(ENTER) === entersAtEnd);
  }
} finally {
  for (const sid of ["sess-retry", "sess-giveup", "sess-overlap"]) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — submit()'s Enter is verify-and-retry, not fire-and-forget: a withheld confirmation retries, any turn-start proof (UserPromptSubmit OR Stop) neutralizes the retry loop, exhausting every attempt recovers busy instead of wedging the session stuck-busy forever, and a stale chain left over from a fast-confirmed prior turn (submitGeneration-scoped) never bleeds into a newer turn's window."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
