// Regression test for card b5ab3aa4 (full review lane 2, b14d3441 m6): "after ... an expired
// human-submit hold, a NEW arrival is submitted immediately, ahead of older queued entries."
//
// enqueueStdin's idle-submit gate (host.ts, `idleEligible`) is every check that makes a SESSION eligible
// for a turn right now — but on its own it says nothing about whether `live.pending` already holds an
// OLDER entry that just became eligible to drain in this SAME call (e.g. because `isHumanSubmitHeld`'s
// own self-clearing branch, "bound expired — no confirming hook ever arrived; stop holding", just flipped
// from true to false). Before the fix, a brand-new arrival that found the gate open was handed straight
// to submit() BY ITSELF, bypassing whatever already sat in `live.pending` — breaking the FIFO delivery
// guarantee the `queued:true` return documents ("WILL be delivered at the next turn boundary") until the
// next reconcile() tick noticed and drained the stranded older entry.
//
// THE FIX (@decision b5ab3aa4, host.ts): the immediate-submit branch now additionally requires
// `live.pending.length === 0`. When pending is already non-empty, the new entry is pushed (same
// same-sender reorder logic as always) and, if the session itself is otherwise idle-eligible,
// `drainPending` is called synchronously right there — reusing its existing oldest-first/coalescing
// logic instead of a special case that bypasses it. No added latency (same tick), and FIFO holds.
//
// This reproduces the EXPIRED-HUMAN-SUBMIT-HOLD variant the card names, deterministically: the
// human-submit hold is a plain bounded timer (`HUMAN_SUBMIT_CONFIRM_HOLD_MS`, overridable via
// LOOM_HUMAN_SUBMIT_CONFIRM_HOLD_MS) that self-expires once no confirming hook ever arrives — no reliance
// on give-up/healIfStuck's multi-second windows, and no raced engine timing.
//
// Both OLDER_MESSAGE and NEWER_MESSAGE default to "warning" kind with no route, so once the fix lands
// they are coalesced into ONE physical write by drainPending's route-keyed coalescing (@decision
// 8f1d7912: same-route + same-kind runs coalesce unconditionally) — this test asserts on that actual
// post-fix shape (both drain together, in order), not on an invented "they must stay separate turns"
// requirement the card never asked for.
//
// RAN RED (pre-fix) by `git stash`-reverting just the host.ts fix and re-running against a rebuilt dist —
// the FIFO INVARIANT check below failed exactly as predicted; every other check (the control, and the
// final nothing-is-lost check) still passed. See the worker_report for the exact red output.
//
// RUN (no daemon needed): node test/pty-new-arrival-order-after-expired-human-hold.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-neworder-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const HOLD_MS = 30; // small override — real default (HUMAN_SUBMIT_CONFIRM_HOLD_MS) is 20_000ms
process.env.LOOM_HUMAN_SUBMIT_CONFIRM_HOLD_MS = String(HOLD_MS);

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

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

function spawnReady(host, sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { fake, written: () => fake.writes.join("") };
}

try {
  const host = new TestPtyHost(events);
  const SID = "sess-new-arrival-order";
  const { written } = spawnReady(host, SID);

  // (A) A genuine first turn so the composer is clean and the session is idle before any hold.
  const r0 = host.enqueueStdin(SID, "SETUP_TURN");
  check("setup: first turn delivered immediately (idle)", r0.delivered === true);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("setup: first turn confirmed+ended, session idle again", busyLog[SID].at(-1) === false);

  // (B) Arm a human-submit hold: a real human types in the raw terminal and hits Enter, OUTSIDE any
  // bracketed paste — `writeStdin`'s own `draft.submitted !== null` branch arms `humanSubmitHeldUntil`.
  host.writeStdin(SID, "human typed this\r");

  // (C) OLDER_MESSAGE arrives WHILE the hold is live — correctly HELD (queued), never delivered
  // immediately. This is the control: proves the hold itself works as documented.
  const rOlder = host.enqueueStdin(SID, "OLDER_MESSAGE");
  check("control: OLDER_MESSAGE is held (queued) while the human-submit hold is live",
    rOlder.delivered === false && rOlder.reason === "held");
  check("control: OLDER_MESSAGE sits in live.pending", host.getPending(SID).includes("OLDER_MESSAGE"));
  check("control: OLDER_MESSAGE was NOT written to the pty yet", !written().includes("OLDER_MESSAGE"));

  // (D) Let the hold EXPIRE with no confirming hook ever arriving (the real-world case the card names:
  // "an expired human-submit hold") — isHumanSubmitHeld's own self-clearing branch fires on next read.
  await sleep(HOLD_MS + 20);

  // (E) A brand-new message arrives AFTER the hold's deadline has passed. enqueueStdin's idle-submit gate
  // re-checks isHumanSubmitHeld(live) fresh — now false (the hold expired) — alongside every other
  // condition, all of which are also satisfied (idle, ready, not stopping/rate-limited/drain-held, no
  // dirty human draft, no give-up hold of its OWN). Pre-fix, nothing in that gate asked "does
  // live.pending already hold an older eligible entry?" before taking the immediate-submit branch.
  const rNewer = host.enqueueStdin(SID, "NEWER_MESSAGE");
  check("NEWER_MESSAGE's own enqueue reports delivered", rNewer.delivered === true);

  // THE INVARIANT UNDER TEST: FIFO — an entry that was queued BEFORE another must never be written to the
  // pty strictly AFTER it. Pre-fix this failed outright: OLDER_MESSAGE was never written at this point at
  // all (still parked in live.pending), so indexOf returned -1 rather than merely a later index.
  const w = written();
  const olderIdx = w.indexOf("OLDER_MESSAGE");
  const newerIdx = w.indexOf("NEWER_MESSAGE");
  check("FIFO INVARIANT: OLDER_MESSAGE must be written no later than NEWER_MESSAGE (older arrived first)",
    olderIdx !== -1 && newerIdx !== -1 && olderIdx < newerIdx);
  // Post-fix: both are "warning"-kind with no route, so drainPending's route-keyed coalescing (@decision
  // 8f1d7912) merges them into ONE physical write — neither is left behind in live.pending. (Pre-fix this
  // also failed: OLDER_MESSAGE was still sitting in pending while NEWER_MESSAGE alone had already gone
  // out — the opposite of "both drained together".)
  check("post-fix: OLDER_MESSAGE and NEWER_MESSAGE drained TOGETHER — neither is left stranded in pending",
    host.getPendingQueueDepth(SID) === 0);

  // (F)/(G) Confirm the turn and run a reconcile() tick — should be a complete no-op now (everything
  // already drained together above), unlike the pre-fix world where this is what finally rescued the
  // stranded OLDER_MESSAGE a full turn late.
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
  host.deliverHook(SID, { hook_event_name: "Stop" });
  host.reconcile();
  check("nothing-is-lost, and nothing left to rescue: OLDER_MESSAGE already went out, pending stays empty",
    written().includes("OLDER_MESSAGE") && host.getPendingQueueDepth(SID) === 0);

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — FIFO held: an expired human-submit hold no longer lets a new arrival jump an older queued entry (card b5ab3aa4)."
  : `\n❌ ${failures} FAILURE(S) — card b5ab3aa4's bug reproduced: an expired human-submit hold let a brand-new arrival jump an older, now-eligible queued entry.`);
process.exit(failures === 0 ? 0 : 1);
