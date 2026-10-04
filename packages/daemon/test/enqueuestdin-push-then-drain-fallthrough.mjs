// Regression test for card 0075e20b DoD-4: the review of b5ab3aa4 named TWO branches of enqueueStdin's
// "push-then-drain" path (host.ts: idleEligible && live.pending.length > 0 -> push the new entry, then
// synchronously call drainPending) that no existing test drives:
//
//   (A) an OLDER, already-queued, ELIGIBLE entry of a DIFFERENT kind drains alone (drainPending's
//       coalescing stops after it, since the new entry's kind doesn't match) — the NEW entry itself was
//       NOT part of that drained run, so it falls through to the ordinary `delivered:false`/"held" return,
//       reporting its REAL re-derived queue position (card b5ab3aa4's own point: not the insert-time index).
//   (B) a pending queue holding ONLY give-up-held entries — drainPending's own `startIdx` scan skips every
//       one of them, so the NEW entry (the only eligible one) drains ALONE, and enqueueStdin reports
//       `delivered:true`/"handed-off" for it even though `live.pending.length` was non-zero when it arrived.
//
// Both exercise the REAL PtyHost/drainPending (not a stub) via the createPty() seam, since the coalescing
// rules under test (kind/route matching, isGiveUpHeld skipping) live entirely inside PtyHost.
//
// (A) reuses the human-submit-hold-expiry technique from pty-new-arrival-order-after-expired-human-hold.mjs
// (that file's own sibling scenario coalesces two SAME-kind messages; this one uses DIFFERENT kinds so they
// do NOT coalesce, reaching the untested fall-through branch instead).
// (B) constructs a give-up-held entry directly via enqueueStdin's own public `giveUpHeldUntil` tail param —
// the same faithful, fast proxy pty-agent-sender-coalesce.mjs's own scenario (G) already established
// (isGiveUpHeld is fed by this field regardless of how it was set; a real give-up cycle is not required).
//
// RUN (no daemon needed): node test/enqueuestdin-push-then-drain-fallthrough.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-pushdrain-${Date.now()}-${process.pid}`);
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

const events = {
  onEngineSessionId() {},
  onBusy() {},
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
  return { written: () => fake.writes.join("") };
}

try {
  // ===================== (A) older, different-KIND entry drains alone; new entry falls through to "held" =====================
  {
    const SID = "sess-fallthrough-a";
    const { written } = spawnReady(SID);

    // A genuine first turn so the composer is clean and the session is idle before any hold.
    const r0 = host.enqueueStdin(SID, "SETUP_TURN");
    check("(A) setup: first turn delivered immediately (idle)", r0.delivered === true);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });

    // Arm a human-submit hold (a real human types in the raw terminal and hits Enter, outside any
    // bracketed paste) — writeStdin's own `draft.submitted !== null` branch arms `humanSubmitHeldUntil`.
    host.writeStdin(SID, "human typed this\r");

    // OLDER_WARNING_MSG arrives WHILE the hold is live — correctly HELD (queued), default "warning" kind.
    const rOlder = host.enqueueStdin(SID, "OLDER_WARNING_MSG");
    check("(A) setup: OLDER_WARNING_MSG is held (queued) while the human-submit hold is live",
      rOlder.delivered === false && rOlder.reason === "held");

    // Let the hold EXPIRE with no confirming hook ever arriving — isHumanSubmitHeld's own self-clearing
    // branch fires on next read, flipping `idleEligible` true while OLDER_WARNING_MSG is still queued
    // (nothing auto-drained it: no Stop hook ran, and expiry alone doesn't trigger an active drain).
    await sleep(HOLD_MS + 20);

    // NEWER_AGENT_MSG arrives: idleEligible is now true, but live.pending.length is 1 (not 0) — so this
    // takes the PUSH-then-drain branch, not the pure-immediate one. Its "agent" kind differs from
    // OLDER_WARNING_MSG's "warning" kind, so drainPending's route-keyed coalescing (same-route-no-route,
    // but kind-mismatched) stops after draining OLDER_WARNING_MSG alone — NEWER_AGENT_MSG is never part of
    // that drained run.
    const rNewer = host.enqueueStdin(SID, "NEWER_AGENT_MSG", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-fallthrough-a");
    check("(A) THE UNTESTED BRANCH: the new, different-kind arrival reports delivered:false (held, not handed off)",
      rNewer.delivered === false);
    check("(A) ... reason is \"held\" (a successful, durable enqueue, not a drop)", rNewer.reason === "held");
    check("(A) ... its RE-DERIVED position is 1 — it is now the ONLY entry in pending, after the older one drained ahead of it",
      rNewer.position === 1);
    check("(A) OLDER_WARNING_MSG actually drained (written to the pty) via the push-then-drain call",
      written().includes("OLDER_WARNING_MSG"));
    check("(A) NEWER_AGENT_MSG did NOT drain with it — still sitting in pending, not yet written",
      !written().includes("NEWER_AGENT_MSG") && host.getPending(SID).includes("NEWER_AGENT_MSG"));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (B) a give-up-held-only queue: the new entry drains ALONE and is handed off =====================
  {
    const SID = "sess-fallthrough-b";
    const { written } = spawnReady(SID);

    // Prime busy (an immediate first turn arms busy=true synchronously).
    const rPrimer = host.enqueueStdin(SID, "PRIMER_TURN");
    check("(B) setup: primer delivered immediately, arming busy", rPrimer.delivered === true);

    // A give-up-held entry queues while busy — constructed via enqueueStdin's own public `giveUpHeldUntil`
    // tail param (a faithful, fast proxy for a real give-up cycle's own requeue; see pty-agent-sender-
    // coalesce.mjs scenario (G) for the same technique).
    const FAR_FUTURE = Date.now() + 60_000;
    const rHeld = host.enqueueStdin(SID, "GIVEUP_HELD_MSG", "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, FAR_FUTURE);
    check("(B) setup: the give-up-held entry is queued (held) while busy", rHeld.delivered === false);

    // Confirm + end PRIMER_TURN's turn: the Stop hook clears busy and calls drainPending, which finds
    // NOTHING eligible (the only entry is give-up-held) — busy flips false, GIVEUP_HELD_MSG stays queued.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(B) setup: busy cleared, but the held entry was correctly skipped, not drained",
      host.getPending(SID).includes("GIVEUP_HELD_MSG"));

    // A brand-new arrival: idleEligible is true, live.pending.length is 1 (not 0) — push-then-drain fires.
    // drainPending's own startIdx scan skips the give-up-held entry entirely and finds THIS entry as the
    // first (and only) eligible one — it drains ALONE.
    const rNew = host.enqueueStdin(SID, "NEW_AFTER_WALL");
    check("(B) THE UNTESTED BRANCH: the new arrival reports delivered:true (handed-off) — it drained alone, past the still-held wall",
      rNew.delivered === true && rNew.deliveryState === "handed-off");
    check("(B) ... and the give-up-held entry is UNTOUCHED, still sitting there", host.getPending(SID).includes("GIVEUP_HELD_MSG"));
    check("(B) NEW_AFTER_WALL was actually written to the pty", written().includes("NEW_AFTER_WALL"));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card b5ab3aa4's two previously-untested push-then-drain fall-through branches both behave as designed: a different-kind older entry drains alone and the new arrival correctly falls through to a re-derived \"held\" position; a give-up-held-only queue lets the new arrival drain alone and report handed-off."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
