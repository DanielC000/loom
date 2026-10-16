// Regression test for card 844ca34e round 3 CR MINOR 2 — a no-write generation (the ownership-mismatch
// `giveUpWithoutWriting` branch) must NOT enroll in `Live.giveUpConfirmQueue`'s content-blind positional-
// purge fallback (pty/host.ts's `requeueGiveUpOrigin`'s new `wroteNothing` param).
//
// Reuses the EXACT Shape-1 ownership-mismatch setup pty-enter-only-verifies-composer-trust.mjs's own
// scenario (1) proves (A gives up, B — a genuinely different lineage — clears+pastes its own body and
// ALSO gives up, so A's later redelivery finds B owns the composer and writes NOTHING at all), including
// its exact timing discipline (HOLD_MS=300, reconcile() fired in the SAME synchronous tick B's own give-up
// settles — see that file's own scenario (1) comment for why: A's hold, set long before B's whole write+
// verify+give-up cycle, is long expired by then, while B's is still fresh). This file adds the
// `giveUpConfirmQueue` assertion that scenario never checks.
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon,
//   pnpm build && node test/pty-giveup-round3-minor2-wrotenothing.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-r3-minor2-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Same values as pty-enter-only-verifies-composer-trust.mjs's own scenario (1) — see that file's header
// for the full derivation; HOLD_MS=300 is what keeps B's hold fresh while A's (set much earlier) has
// long expired by the time reconcile() fires in the same synchronous tick, with no sleep in between.
const ENTER_DELAY = 50;
const VERIFY_TIMEOUT = 600;
const MAX_ATTEMPTS = 3;
const HOLD_MS = 300;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
// LIMIT=2, deliberately NOT the production default (1): A's SECOND give-up (the ownership-mismatch one,
// below) must still be KEPT (requeues=2<=2), not EXHAUSTED, for `wroteNothing`'s exclusion to have
// anything to discriminate — at LIMIT=1, A's second give-up would exhaust regardless of wroteNothing
// (kept.length===0 either way), making the push-vs-no-push distinction vacuously untested either way.
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "2";

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
  const host = new TestPtyHost(events);
  const SID = "sess-minor2-wrotenothing";
  const TEXT_A = "MINOR2_A_GIVES_UP_FIRST_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const TEXT_B = "MINOR2_B_TAKES_OWNERSHIP_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  spawnReady(host, SID);
  const live = host.live.get(SID);

  let lenBefore = busyLog[SID]?.length ?? 0;
  host.enqueueStdin(SID, TEXT_A, "system", undefined, undefined, "agent");
  check("setup: A delivered immediately, busy armed", busyLog[SID]?.at(-1) === true);
  await waitForBusyFalseAfter(SID, lenBefore, "A's own give-up (RECOVERY)");
  check("setup: A's real write give-up DID enroll in giveUpConfirmQueue (positive control — proves an "
    + "ordinary write-then-give-up DOES push, so the absence checked below is not vacuous)",
    live.giveUpConfirmQueue.length === 1);
  check("setup: A is requeued (held) — pending holds exactly A",
    live.pending.length === 1 && live.pending[0].text === TEXT_A);

  lenBefore = busyLog[SID].length;
  host.enqueueStdin(SID, TEXT_B, "system", undefined, undefined, "agent");
  check("setup: B (a DIFFERENT message) delivered immediately while A sits held", busyLog[SID]?.at(-1) === true);
  await waitForBusyFalseAfter(SID, lenBefore, "B's own give-up (RECOVERY)");
  check("setup: B's real write give-up ALSO enrolled (queue now holds 2 real-write generations)",
    live.giveUpConfirmQueue.length === 2);
  const queueLenBeforeMismatch = live.giveUpConfirmQueue.length;
  const pendingNow = live.pending;
  check("setup: ordering is [B (just requeued, HELD), A (hold long expired)] — same as the composer-trust "
    + "file's own scenario (1)",
    pendingNow.length === 2 && pendingNow[0].text === TEXT_B && pendingNow[1].text === TEXT_A);

  // A's redelivery: owner is B, not A -> ownership mismatch -> giveUpWithoutWriting -> writes NOTHING.
  // Fired in the SAME synchronous tick B's own give-up settles (no intervening sleep) — A's hold (set
  // way back, before B's own full cycle even started) is long expired, B's is still fresh.
  lenBefore = busyLog[SID].length;
  const writesBefore = fakes.at(-1).writes.length;
  host.reconcile();
  check("THE MISMATCH FIRED SYNCHRONOUSLY: A's redelivery wrote zero bytes (busy re-armed via the M1 "
    + "invariant even though nothing was written)",
    busyLog[SID].at(-1) === true && fakes.at(-1).writes.slice(writesBefore).join("") === "");
  await waitForBusyFalseAfter(SID, lenBefore, "A's give-up-without-writing settles");

  check("THE FIX, THE ASSERTION THAT GOES RED WITHOUT IT: A's no-write resolution did NOT grow "
    + "giveUpConfirmQueue — it stays at its PRE-mismatch length, never a phantom 3rd entry for a "
    + "generation that was never actually written to the real terminal",
    live.giveUpConfirmQueue.length === queueLenBeforeMismatch);

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 844ca34e round 3 MINOR 2: a no-write generation (the ownership-mismatch branch) "
    + "never enrolls in giveUpConfirmQueue's content-blind positional-purge fallback."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
