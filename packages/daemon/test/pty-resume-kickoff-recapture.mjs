import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 25813ecc — LIVE REGRESSION shipped in b4fa85a4 (introduced by 0050a17e's restructuring).
//
// THE BUG: `markReady` used to call `this.drainPending(sessionId)` and only THEN capture
// `live.lastPrompt` as "the kickoff" (`live.lastPrompt != null && !live.firstTurnStarted`). `submit()`
// unconditionally overwrites `live.lastPrompt` with whatever IT is currently submitting — and
// `drainPending` calls `submit()` for any queued message. A RESUME's queue is normally non-empty
// (companion recall, project-memory recall — EVERY role — and redriven undelivered messages all enqueue
// synchronously right after resume(), before SessionStart ever lands). So on a resume, `drainPending`
// drains that queued message FIRST, `live.lastPrompt` becomes ITS text, and the OLD code then captured
// THAT as "the kickoff" and scheduled it for a SECOND delivery via `scheduleKickoffGuarantee` — silently
// re-delivering an already-drained message as if it were the session's fresh-spawn kickoff. A fresh
// spawn never hit this because `spawn()` sets `busy:true` optimistically whenever `opts.startupPrompt` is
// set, and `drainPending` bails on `live.busy` — so the drain there is a genuine no-op and the (old) late
// capture happened to still be correct. Re-delivery additionally needs `firstTurnStarted` to still be
// false when `scheduleKickoffGuarantee`'s deferred check runs — i.e. the UserPromptSubmit hook for the
// drained turn is late or lost (see pinned memory `engine-confirmation-can-lag-minutes-timeouts-assume-
// seconds`: a MEASURED 232-second confirmation lag). This file drives that exact shape directly: Stop
// alone (proving a turn ran) WITHOUT ever delivering UserPromptSubmit.
//
// THE FIX (host.ts): `markReady` now captures `kickoff` from a NEW field, `live.startupPrompt` — seeded
// ONCE at spawn() from `opts.startupPrompt ?? null` and never written again by anything else (unlike
// `lastPrompt`) — read BEFORE `drainPending` even runs. A resume never passes `opts.startupPrompt`, so
// `live.startupPrompt` stays null there regardless of what the drain does to `lastPrompt` — correct by
// construction, not by statement order.
//
// THREE-WAY DISCRIMINATING CONTROL (card's own repro table — reproduced here directly, hermetic):
//   (A) resume + 1 msg queued pre-SessionStart  → the queued message must NOT be redelivered as a 2nd turn.
//   (B) resume + empty queue                    → 0 deliveries (mirrors the existing worker-kickoff-
//                                                   guarantee.mjs H1d; kept here too so A/B/C sit together
//                                                   as ONE self-contained discriminating set).
//   (C) fresh spawn + 1 msg queued pre-SessionStart → the REAL kickoff is delivered as turn 1, and the
//                                                       queued message is correctly left pending (drains
//                                                       as turn 2 once turn 1 ends) — proving the fix
//                                                       doesn't regress the ordinary fresh-spawn path.
// A/B/C must all differ for this to be a real discriminating instrument, not a check that merely fires.
//
// 🔴 Confirm this file FAILS on unfixed `main` before trusting it green (per this card's own DoD).
//
// RUN: pnpm build (from packages/daemon) then `node test/pty-resume-kickoff-recapture.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";
import { observeOnce, assertNeverWithControl } from "./_timing-guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn).
// Env vars read at MODULE IMPORT time — set BEFORE importing host.js. Pinned FAST (not left at
// production defaults) purely for test speed/determinism: LOOM_MODE_LOG_POLL_MS governs
// logLandedMode's footer-read poll (which gates kickoff DELIVERY, per markReady's own doc) and is
// otherwise capped at MODE_LOG_MAX_ATTEMPTS=8 fixed attempts — at the 500ms production default that's up
// to ~4s of settling per scenario; pinning it fast keeps this file's worst case in the tens of ms while
// still exercising the real poll-then-settle code path (not bypassing it).
const tmpHome = path.join(os.tmpdir(), `loom-resume-kickoff-recapture-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_MODE_LOG_POLL_MS = "15";
process.env.LOOM_READY_FALLBACK_MS = "5000"; // long enough it never fires inside these tests' own windows
process.env.LOOM_RESUME_MODE_POLL_MS = "15";
// Pinned high (not left at the 900ms default) so NEGATIVE_WINDOW_MS below has an EXPLICIT, measured
// margin under it — sendEnterAndVerify's give-up/reassert-paste retry also writes a bracket-paste marker,
// so a window that ever reached this timeout could misread an unrelated retry as a repeated delivery.
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "5000";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const PASTE_START = "\x1b[200~";

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    let dataCb = null;
    const fake = {
      ...base, write: (d) => writes.push(d),
      onData: (cb) => { dataCb = cb; return { dispose() {} }; },
      writes, feed: (s) => { if (dataCb) dataCb(s); },
    };
    fakes.push(fake);
    return fake;
  }
}
const busyById = {};
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onBusy(id, b) { (busyById[id] ??= []).push(b); },
};
const host = new TestPtyHost(events);

const writtenOf = (fake) => fake.writes.join("");
const countIn = (fake, marker) => writtenOf(fake).split(marker).length - 1;
const lastFake = () => fakes[fakes.length - 1];

// windowMs shared by every negative check below — comfortably (well over 10x) above the pinned poll/settle
// chain (MODE_LOG_MAX_ATTEMPTS=8 * LOOM_MODE_LOG_POLL_MS=15ms ≈ 120ms worst case, plus the deferred
// setTimeout(0) tick) and comfortably under the pinned LOOM_SUBMIT_VERIFY_TIMEOUT_MS (5000ms) so a give-up
// retry can never fire inside the window and be mistaken for a repeated delivery.
const NEGATIVE_WINDOW_MS = 500;

// Spawn a throwaway control session (SessionStart delivered, like a normal fresh kickoff) and wait for its
// own real kickoff delivery — proves countIn(...)'s PASTE_START check can actually catch a real delivery,
// via the identical write path scheduleKickoffGuarantee itself uses (not a hand-written fake write).
let controlSeq = 0;
async function spawnControlDelivery(label) {
  const id = `control-${controlSeq++}-${label.replace(/[^a-z0-9]+/gi, "-")}`;
  host.spawn({
    sessionId: id, cwd: tmpHome, startupPrompt: `control kickoff (${label})`,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake = lastFake();
  host.deliverHook(id, { hook_event_name: "SessionStart" });
  await waitUntil(() => countIn(fake, PASTE_START) === 1, { label: `${label}: control kickoff delivered once` });
  return { id, fake };
}

try {
  // ============ (A) RESUME + 1 QUEUED MESSAGE: must NOT redeliver it as a second turn ===================
  {
    const A = "resume-recapture-A";
    const QUEUED = "[loom:project-memory] queued recall (scenario A)";
    host.spawn({
      sessionId: A, cwd: tmpHome, resumeId: "engine-A", // resume: no startupPrompt passed
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fa = lastFake();
    // Mirrors service.ts's real resume ordering: project-memory/companion recall + redriven messages are
    // enqueued right after resume(), BEFORE SessionStart ever fires. `enqueueStdin` holds this FIFO since
    // `live.ready` is still false at this point (see enqueueStdin's own `ready` gate doc).
    host.enqueueStdin(A, QUEUED, "system", undefined, undefined, "agent");
    host.deliverHook(A, { hook_event_name: "SessionStart" }); // ready — markReady's drainPending delivers the queued message as turn 1
    await waitUntil(() => countIn(fa, PASTE_START) === 1, { label: "(A) the queued message is delivered as turn 1" });
    check("(A) the first delivered turn is the queued message (drainPending's own turn, not a kickoff)", writtenOf(fa).includes(QUEUED));
    // End that turn WITHOUT ever delivering UserPromptSubmit — the reproduced trigger condition (the hook
    // is late/lost; see this file's header). Stop alone still proves a turn ran and clears busy;
    // `firstTurnStarted` stays false throughout, exactly the state scheduleKickoffGuarantee's deferred
    // check reads.
    host.deliverHook(A, { hook_event_name: "Stop" });
    const noRedeliverA = await assertNeverWithControl({
      label: "(A) the queued message is never redelivered as a second turn",
      check: () => countIn(fa, PASTE_START) >= 2,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        // Prove the >=2 check can catch a real repeat delivery — a normal control session, kickoff
        // delivered once, then a legitimate second turn forced via UserPromptSubmit+Stop+enqueueStdin.
        const { id, fake } = await spawnControlDelivery("A repeat-check positive control");
        host.deliverHook(id, { hook_event_name: "UserPromptSubmit" });
        host.deliverHook(id, { hook_event_name: "Stop" }); // end that turn — clears busy
        host.enqueueStdin(id, "control forced second delivery", "system", undefined, undefined, "agent");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 2, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(A) the queued message is never redelivered as a second turn (THE BUG: pre-fix, markReady captured this already-drained text as \"the kickoff\" and scheduleKickoffGuarantee replayed it once the deferred check found firstTurnStarted still false)", noRedeliverA);
  }

  // ============ (B) RESUME + EMPTY QUEUE: 0 deliveries — discriminating control ===========================
  // Proves (A)'s failure isn't just "a resume always redelivers something" — an empty queue produces
  // NOTHING, on both old and new code, so (A) tripping is specifically about the queued-message capture.
  {
    const B = "resume-recapture-B";
    host.spawn({
      sessionId: B, cwd: tmpHome, resumeId: "engine-B",
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fb = lastFake();
    host.deliverHook(B, { hook_event_name: "SessionStart" }); // ready — nothing queued, nothing to drain, no kickoff to guarantee
    const neverDeliveredB = await assertNeverWithControl({
      label: "(B) resume + empty queue: never delivers",
      check: () => countIn(fb, PASTE_START) >= 1,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        const { id, fake } = await spawnControlDelivery("B positive control");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 1, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(B) resume + empty queue: never delivers (discriminating control)", neverDeliveredB);
  }

  // ============ (C) FRESH SPAWN + 1 QUEUED MESSAGE: real kickoff captured, queued msg preserved =========
  // Proves the fix doesn't regress the ordinary fresh-spawn case: spawn()'s optimistic busy:true makes
  // markReady's drainPending call a genuine no-op here (see spawn()'s own doc), so the queued message must
  // stay pending — delivered only once turn 1 (the real kickoff) ends — never lost, never merged into turn 1.
  {
    const C = "resume-recapture-C";
    const KICKOFF = "orchestrate task tk-C (scenario C)";
    const QUEUED = "[loom:project-memory] queued recall (scenario C)";
    host.spawn({
      sessionId: C, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fc = lastFake();
    host.enqueueStdin(C, QUEUED, "system", undefined, undefined, "agent"); // queued before ready, same as (A)
    host.deliverHook(C, { hook_event_name: "SessionStart" });
    await waitUntil(() => countIn(fc, PASTE_START) === 1, { label: "(C) the real kickoff is delivered as turn 1" });
    check("(C) the first delivered turn is the REAL kickoff, not the queued message", writtenOf(fc).includes(KICKOFF) && !writtenOf(fc).includes(QUEUED));
    // End turn 1 (Stop, no UserPromptSubmit — same "hook lost" shape as (A)) and confirm the queued
    // message drains as turn 2, proving it was held pending rather than dropped or merged.
    host.deliverHook(C, { hook_event_name: "Stop" });
    await waitUntil(() => countIn(fc, PASTE_START) === 2, { label: "(C) the queued message drains as turn 2 once turn 1 ends" });
    check("(C) the second delivered turn is the queued message (preserved, not dropped)", writtenOf(fc).includes(QUEUED));
  }
} finally {
  for (const id of ["resume-recapture-A", "resume-recapture-B", "resume-recapture-C"]) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 25813ecc: markReady captures the kickoff from the IMMUTABLE live.startupPrompt field, read before drainPending ever runs, so a resume's pre-ready queued message (A) is never re-captured as \"the kickoff\" and redelivered; a resume with an empty queue (B) still delivers nothing (discriminating control — (A) tripping isn't just \"resumes always redeliver\"); a fresh spawn with a queued message (C) still delivers the REAL kickoff first and preserves the queued message for turn 2, unregressed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
