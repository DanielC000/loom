import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c469d54e — regression guard for the boot mode-cycle's own bounded timing budget.
//
// THE DEFECT (fixed by this card): READY_FALLBACK_MS was armed unconditionally AT SPAWN TIME and never
// touched again — so it checked only "is `ready` still false at spawn+20s", with no idea whether
// SessionStart had arrived or a boot mode-cycle (cycleToMode) was still running. Under host contention
// (the 2026-08-01 mass-restart this card traces to), SessionStart itself could arrive late enough that
// the RESIDUAL budget left before that spawn-anchored deadline was far less than cycleToMode's own sized
// worst case (~13-14s) — so the fallback fired WHILE the cycle was still pressing Shift+Tab / reading the
// footer, releasing a queued kickoff INTO the pty concurrently with the cycle's own writes/reads (the
// corruption mechanism — confirmed against the incident's raw daemon-output.log, not just theorized).
//
// THE FIX: once SessionStart fires and a cycle is about to run, cancel the spawn-armed timer and re-arm a
// FRESH one scoped from THAT moment (MODE_CYCLE_FALLBACK_MS), so a healthy cycle always gets its own full
// budget regardless of how late SessionStart itself arrived. A separate, generous absolute ceiling
// (READY_FALLBACK_ABSOLUTE_CEILING_MS, from spawn) still guarantees liveness — see
// pty-ready-fallback-ceiling.mjs for that mechanism in isolation (needs conflicting constants, hence its
// own file/process — env-derived constants in host.ts are frozen at import time).
//
// What THIS file locks:
//   1. THE RACE, reproduced then closed: SessionStart arrives promptly, but the OLD spawn-anchored
//      deadline (200ms, deliberately shorter than the FIXED, non-overridable MODE_CYCLE_SETTLE_MS of
//      700ms) would still land while cycleToMode is mid-settle — before its first Shift+Tab. Pre-fix, this
//      is exactly the incident's precondition and drains the kickoff mid-cycle. Post-fix, the kickoff must
//      NOT be delivered until the cycle actually reaches its target, and must still be delivered eventually
//      (no wedge). Proven with a real positive control (kickoff-readiness-fallback.mjs's own missed-hook
//      path, untouched by this fix), not a bare fixed sleep.
//   2. CRASH-BETWEEN-ARM-AND-CLEAR (DoD-3, HALF discharged — see scenario 2's own comment for why): the fix
//      arms the NEW timer BEFORE clearing the OLD one, specifically so a fault in the clear step degrades
//      to AT WORST today's pre-fix behavior (the old timer, left uncleared, eventually fires on its own
//      original schedule) — never to zero live timers (which could wedge the kickoff forever). This
//      simulates that fault (a thrown clearTimeout) and proves the no-wedge half directly: the session
//      still reaches ready and delivers its kickoff, and the re-armed NEW timer (cleared normally by that
//      same delivery's own markReady, once the intercepted clear has already restored itself) doesn't ALSO
//      deliver a second time. It does NOT exercise an actual two-live-timer double-fire absorbed by
//      markReady's idempotency guard — see the in-code comment for why that would need a second, riskier
//      fault injection this file doesn't attempt.
//
// HERMETIC, claude-free — a fake pty (mirrors pty-mode-convergence.mjs / kickoff-readiness-fallback.mjs).
//
// RUN: pnpm build (from packages/daemon) then `node test/pty-ready-fallback-race.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";
import { observeOnce, assertNeverWithControl } from "./_timing-guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-ready-fallback-race-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// READY_FALLBACK_MS deliberately shorter than the FIXED MODE_CYCLE_SETTLE_MS (700ms, not env-overridable)
// — reproduces the incident's precondition (SessionStart arrived with far less residual budget than
// cycleToMode's own worst case) without needing precise footer-feed timing tricks. Kept SMALL (not just
// "under 700ms") deliberately: scenario 1 routes its negative check through assertNeverWithControl (code
// review, 2026-08-05), whose positiveControl runs BEFORE the real observation window — so the real budget
// available under the 700ms settle is [700 - positiveControl's own wall-clock time], not the full 700ms.
// A prior version pinned this at 200ms with a 300ms window and flaked ~1/6 runs (observed while fixing
// this) once the control's own (small but real) spawn+delivery overhead ate into that shared budget. 50ms
// here + a 150ms window leaves ~500ms for the control to run in, comfortable margin against normal jitter.
process.env.LOOM_READY_FALLBACK_MS = "50";
// Generous re-armed budget — must comfortably outlast the 700ms settle + a couple of fed presses.
process.env.LOOM_MODE_CYCLE_FALLBACK_MS = "5000";
// Generous — NOT under test here (see pty-ready-fallback-ceiling.mjs for the ceiling in isolation).
process.env.LOOM_READY_FALLBACK_ABSOLUTE_CEILING_MS = "20000";
process.env.LOOM_RESUME_MODE_POLL_MS = "40";
// logLandedMode's OWN footer-read poll gates kickoff delivery (markReady → logLandedMode → onSettled →
// scheduleKickoffGuarantee) — left at its 500ms×8-attempt default, a session whose footer is never fed
// (scenario 2) would burn ~4s on that poll alone before this fix's own timers even matter. Fast here so
// each scenario's wait budget reflects THIS card's mechanism, not an unrelated poll's default pacing.
process.env.LOOM_MODE_LOG_POLL_MS = "5";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const PASTE_START = "\x1b[200~";
const SHIFT_TAB = "\x1b[Z";
const ACCEPT_EDITS_FOOTER = "accept edits on (shift+tab to cycle)";
const PLAN_FOOTER = "plan mode on (shift+tab to cycle)";
const AUTO_FOOTER = "auto mode on (shift+tab to cycle)";

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    let dataCb = null;
    const fake = {
      ...base, write: (d) => writes.push(d),
      onData: (cb) => { dataCb = cb; return { dispose() {} }; }, // capture so a test can feed footer bytes
      writes,
      feed: (s) => { if (dataCb) dataCb(s); }, // simulate engine output reaching host.onData (repaints the ring)
    };
    fakes.push(fake);
    return fake;
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const writtenOf = (fake) => fake.writes.filter((w) => typeof w === "string").join("");
const countIn = (fake, marker) => writtenOf(fake).split(marker).length - 1;
const countShiftTabs = (fake) => fake.writes.filter((w) => w === SHIFT_TAB).length;

// Capture cycleToMode's own terminal "cycle→..." log line (host.ts, printed unconditionally the instant
// ANY cycleToMode invocation — the boot convergence OR a role-gated auto-heal — reaches a terminal state)
// per sessionId. THIS is the sharpest observable for scenario 1's negative control: a premature fallback
// firing mid-settle reads the NOT-YET-CYCLED footer, sees a mismatch, and queues a REDUNDANT heal
// cycleToMode behind the legitimate one — visible as a SECOND "cycle→" line for the same session, even
// though modeCycleChain's serialization means the two never literally interleave their keystrokes. A
// timing check on kickoff delivery alone is NOT sufficient here (verified while writing this test): the
// heal's own queued cycleToMode gates kickoff delivery too, so "not delivered yet" can pass for the WRONG
// reason (still queued behind an unnecessary heal) even pre-fix. Cycle-invocation COUNT is what actually
// distinguishes "one clean convergence" (post-fix) from "one convergence plus one redundant, premature-
// read-triggered heal" (pre-fix) — see this file's own stash-verified negative control (DoD-4).
const cycleLogLines = [];
const realLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  if (line.includes("cycle→")) cycleLogLines.push(line);
  realLog(...args);
};
const countCycleInvocations = (sid) => cycleLogLines.filter((l) => l.includes(`[resume-mode] ${sid} cycle→`)).length;

let controlSeq = 0;
// Spawn a throwaway control session on the GENUINELY-missed-hook fallback path (no SessionStart ever
// delivered — only READY_FALLBACK_MS marks it ready, exactly kickoff-readiness-fallback.mjs's scenario)
// — this path is UNTOUCHED by this card's fix, so it's a real proof that the PASTE_START check below can
// actually catch a premature delivery via the identical write path scheduleKickoffGuarantee itself uses.
async function spawnMissedHookControl(label) {
  const id = `control-${controlSeq++}-${label.replace(/[^a-z0-9]+/gi, "-")}`;
  host.spawn({
    sessionId: id, cwd: tmpHome, startupPrompt: `control kickoff (${label})`,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake = fakes[fakes.length - 1];
  await waitUntil(() => countIn(fake, PASTE_START) === 1, { label: `${label}: control kickoff delivered via the missed-hook fallback`, timeoutMs: 5000 });
  return { id, fake };
}

try {
  // ============ 1) THE RACE, reproduced then closed ============================================
  {
    const A = "race-A";
    const KICKOFF = "orchestrate task — must not land mid-cycle";
    host.spawn({
      sessionId: A, cwd: tmpHome, startupPrompt: KICKOFF, role: "worker",
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 2 }, // → target "auto"
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fa = fakes[fakes.length - 1];
    fa.feed(ACCEPT_EDITS_FOOTER); // boot footer already painted before SessionStart, realistic ordering
    host.deliverHook(A, { hook_event_name: "SessionStart", session_id: "eng-A" }); // starts cycleToMode's 700ms settle

    // Routed through assertNeverWithControl (code review, 2026-08-05) so its RUNTIME positive-control
    // requirement actually fires, rather than a manually-run control after the fact. assertNeverWithControl
    // runs positiveControl BEFORE the real observation window, so the real budget available under the fixed
    // 700ms settle is [700ms − however long the control itself takes] — see LOOM_READY_FALLBACK_MS's own
    // comment above for the flake this margin caused before both were shrunk. windowMs is still comfortably
    // > READY_FALLBACK_MS(50, the OLD bug's exact firing point) and leaves ~500ms for the control to run in.
    const noPrematureDelivery = await assertNeverWithControl({
      label: "1: kickoff NOT delivered while the cycle is still mid-settle",
      check: () => countIn(fa, PASTE_START) >= 1,
      windowMs: 150, intervalMs: 10,
      positiveControl: async () => {
        // Untouched missed-hook path (kickoff-readiness-fallback.mjs's own scenario) — proves the IDENTICAL
        // check can observe a real premature delivery, via the same write path scheduleKickoffGuarantee uses.
        const { id: ctrlId, fake: ctrlFake } = await spawnMissedHookControl("1: positive control");
        const went = countIn(ctrlFake, PASTE_START) >= 1; // already true by construction — spawnMissedHookControl awaited it
        try { host.stop(ctrlId, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("1: kickoff NOT delivered while the cycle is still mid-settle (THE FIX — pre-fix this fires at ~200ms)",
      noPrematureDelivery);
    check("1: no Shift+Tab issued yet either (cycle genuinely still settling, not racing ahead)",
      countShiftTabs(fa) === 0);

    // Let the cycle actually run to completion — proves the fix doesn't trade corruption for a wedge.
    // Deliberately UNINTERLEAVED with any other session's own async work here: cycleToMode's per-press
    // change-wait window (RESUME_MODE_CHANGE_MAX_POLLS × RESUME_MODE_READ_POLL_MS = 600ms, default poll
    // count) keeps ticking on race-A's own real clock regardless of what this script awaits elsewhere, so
    // feeding each footer promptly (not after some OTHER session's multi-hundred-ms async chain) matters.
    check("1: cycle's 1st Shift+Tab issued once settle completes",
      await waitUntil(() => countShiftTabs(fa) === 1, { timeoutMs: 2000, label: "1: 1st Shift+Tab" }));
    fa.feed(PLAN_FOOTER);
    check("1: cycle's 2nd Shift+Tab issued",
      await waitUntil(() => countShiftTabs(fa) === 2, { timeoutMs: 2000, label: "1: 2nd Shift+Tab" }));
    fa.feed(AUTO_FOOTER);
    check("1: kickoff delivered exactly once, only AFTER the cycle reached its target",
      await waitUntil(() => countIn(fa, PASTE_START) === 1, { timeoutMs: 2000, label: "1: kickoff delivered" }));
    check("1: the delivered text is the original kickoff", writtenOf(fa).includes(KICKOFF));
    // THE SHARP negative control (DoD-4 — see this file's own stash-verified proof): pre-fix, the
    // premature fallback reads the not-yet-cycled footer and queues a REDUNDANT heal cycleToMode behind
    // the legitimate one — a SECOND "cycle→" completion for this session, even though it presses zero
    // times once it finally runs (the legitimate cycle already reached the target by then). Post-fix,
    // exactly ONE cycleToMode invocation ever runs for a session whose cycle never needed healing.
    check("1: EXACTLY ONE cycleToMode invocation for this session (no redundant heal queued behind it — the actual defect)",
      countCycleInvocations(A) === 1);
    try { host.stop(A, "hard"); } catch { /* ignore */ }
  }

  // ============ 2) CRASH-BETWEEN-ARM-AND-CLEAR (DoD-3) ============================================
  // Simulate a fault DURING the old-timer clear (the closest testable proxy for "a crash between arming
  // the new timer and clearing the old one" — a literal process crash can't be exercised in a unit test;
  // see the report's DoD-6 note on event-loop contention being out of reach here too). The ordering under
  // test (arm-before-clear) means this must degrade to AT WORST the pre-fix behavior — the old timer,
  // left live, fires on its own original 200ms schedule — never to a stranded kickoff.
  {
    const C = "race-C-crash-between-arm-and-clear";
    const KICKOFF = "orchestrate task — must survive a fault in the old-timer clear";
    host.spawn({
      sessionId: C, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 2 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fc = fakes[fakes.length - 1];
    // Deliberately feed NOTHING — cycleToMode's own give-up (RESUME_MODE_CHANGE_MAX_POLLS(15, default) ×
    // RESUME_MODE_READ_POLL_MS(40) = 600ms per phase, settle(700ms) first) lands well AFTER this
    // scenario's short observation window below, so any delivery observed there can't be cycleToMode's
    // own completion — only one of the two fallback timers.
    const realClearTimeout = globalThis.clearTimeout;
    let clearThrew = false;
    globalThis.clearTimeout = (handle) => {
      globalThis.clearTimeout = realClearTimeout; // one-shot — only this FIRST clear call (the old-timer clear) is intercepted
      clearThrew = true;
      throw new Error("simulated fault clearing the OLD readiness-fallback timer");
    };
    let caught = null;
    try {
      host.deliverHook(C, { hook_event_name: "SessionStart", session_id: "eng-C" });
    } catch (e) {
      caught = e;
    } finally {
      if (globalThis.clearTimeout !== realClearTimeout) globalThis.clearTimeout = realClearTimeout;
    }
    check("2: the simulated clear-timeout fault actually fired (the control is real)", clearThrew);
    check("2: deliverHook propagated the simulated throw (we are really testing the failure path, not a swallowed no-op)",
      caught !== null);
    // Despite the throw, the OLD timer (never actually cleared) is still live on its original 200ms
    // schedule — the session must still reach ready and deliver its kickoff, exactly the "degrades to
    // today's pre-fix behavior, never to zero timers" guarantee the arm-before-clear ordering exists for.
    check("2: the session STILL reaches ready and delivers its kickoff despite the clear throwing (no permanent wedge)",
      await waitUntil(() => countIn(fc, PASTE_START) === 1, { timeoutMs: 2000, label: "2: kickoff delivered despite the clear throwing" }));
    // CODE REVIEW CORRECTION (2026-08-05): this used to claim "the NEW timer is also still live … give it
    // a moment to prove markReady's idempotency absorbs the second, now-stale timer" — that was WRONG about
    // the code it tests. `live.readyFallbackTimer` is reassigned to the NEW timer BEFORE the intercepted
    // clear call runs (see the source's own arm-before-clear ordering), so by the time the OLD (uncleared)
    // timer fires and calls markReady, THAT markReady's own clear — using the real clearTimeout, already
    // restored above — successfully cancels the NEW timer. There is no surviving second timer here to
    // double-fire; markReady's `live.ready` idempotency guard (pre-existing, unrelated to this card, and
    // already covered elsewhere — pty-mode-convergence.mjs's "fires at most once" checks,
    // kickoff-readiness-fallback.mjs's "still exactly ONE delivery" checks) is what would absorb a genuine
    // double-fire, but this fault injection never produces one to absorb. What this DOES still prove: the
    // re-armed timer doesn't leak into a second delivery once the old one's markReady has run — a real,
    // if more modest, claim than the original one. Exercising an ACTUAL two-live-timer double-fire would
    // require making markReady's OWN (unguarded) clear throw too, which propagates an uncaught exception
    // out of a setTimeout callback in the current production code — judged out of scope here (DoD-3 is
    // correspondingly HALF discharged: the no-wedge liveness half above is real and fully exercised; this
    // half only shows the mundane single-timer-remaining case, not a genuine absorbed-double-fire case).
    const noSecondDelivery = await assertNeverWithControl({
      label: "2: the re-armed timer does not ALSO deliver a second time once the old timer's markReady has run",
      check: () => countIn(fc, PASTE_START) >= 2,
      windowMs: 300, intervalMs: 10,
      positiveControl: async () => {
        // A FRESH, unrelated control session — proves the >=2 check can catch a real repeat delivery via a
        // genuine second turn (UserPromptSubmit+Stop end the first, then enqueueStdin forces a real second
        // submit()) — mirrors kickoff-readiness-fallback.mjs's own "repeat-check positive control" recipe.
        const id = "control-2-repeat-delivery";
        host.spawn({
          sessionId: id, cwd: tmpHome, startupPrompt: "control repeat-delivery kickoff",
          permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
          geometry: { cols: 120, rows: 40 }, sessionEnv: {},
        });
        const fake = fakes[fakes.length - 1];
        await waitUntil(() => countIn(fake, PASTE_START) === 1, { label: "2: control's first kickoff delivered", timeoutMs: 5000 });
        host.deliverHook(id, { hook_event_name: "UserPromptSubmit" });
        host.deliverHook(id, { hook_event_name: "Stop" }); // end that turn — clears busy
        host.enqueueStdin(id, "control forced second delivery", "system", undefined, undefined, "agent");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 2, windowMs: 300, intervalMs: 10 });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("2: the re-armed timer does not ALSO deliver a second time once the old timer's markReady has run (not a test of double-fire absorption — see comment above)",
      noSecondDelivery);
    try { host.stop(C, "hard"); } catch { /* ignore */ }
  }
} finally {
  console.log = realLog;
  for (const id of ["race-A", "race-C-crash-between-arm-and-clear"]) {
    try { host.stop(id, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a boot mode-cycle now gets its own bounded budget scoped from SessionStart instead of "
    + "racing the raw spawn-anchored READY_FALLBACK_MS clock: a healthy cycle is never interrupted by a "
    + "premature kickoff drain (proven against a real positive control, not a bare sleep), and a fault in "
    + "the old-timer clear step still degrades to AT WORST the pre-fix behavior — never a stranded kickoff — "
    + "and never a duplicate delivery either."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
