// Claude-free regression guard for the BOOT-READINESS gate (pty/host.ts) — the fix for the
// 2026-06-03 daemon-restart bug where a resumed session's injected nudge stranded un-submitted in the
// composer and the permission mode stuck mid-cycle on plan.
//
// Root cause: boot-recovery called enqueueStdin right after resume(); resume sets busy=false, and the
// OLD enqueueStdin submitted whenever !busy — but `busy` only means "turn in flight", not "engine
// booted". So the bracketed-paste + Enter went into a still-booting TUI: the Enter was swallowed (text
// stranded), and it interleaved with the SessionStart mode-cycle Shift+Tabs (mode stuck on plan).
//
// The fix adds a `ready` flag, flipped on the first SessionStart AFTER the mode-cycles land. Injection
// (enqueueStdin / drainPending) now requires `ready`, so a boot nudge QUEUES until the composer is live
// and the mode has settled, then submits cleanly — AND strictly after the Shift+Tabs.
//
// Scenarios 4-8 also cover the 2026-07-10 fix: the resume-summary gate's Down+Enter used to be a BLIND
// fire-and-forget pair with no read-back that the cursor actually moved off the default option before
// Enter confirmed it — a race that silently compacted three managers' full context simultaneously under
// restart load. `resolveResumeGate` now CONFIRMS the cursor via `resumeGateCursorOption` before ever
// sending Enter — and presses Down EXACTLY ONCE (never a retry-press): a code-review catch on the first
// draft found that retrying the Down once its poll window elapsed unconfirmed could overshoot the cursor
// 1→2→3 if the first press was merely SLOW (not dropped), landing on "Don't ask me again" — worse than
// the original bug. The poll BUDGET is generous instead; an unexpected option-3 read gets a single
// defensive Up-correction, never a Down retry, and no path may confirm/Enter while still reading 3.
//
// This exercises the real PtyHost state machine against a FAKE pty (the createPty seam). No real claude.
// RUN: pnpm build (from packages/daemon) then `node test/pty-resume-readiness.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll `pred` until it's true or `timeoutMs` elapses — for "eventually true" assertions on scenario 4-6's
// verify-retry timers. A FIXED sleep-then-assert (the pattern the rest of this file uses) is fragile for
// those specifically: under a loaded scheduler, Node's setTimeout callbacks can fire meaningfully LATER
// than their nominal delay, so "assert X happened by t=350ms" can spuriously fail even though the retry
// logic is correct — it just hadn't been SCHEDULED yet. Observed once for real (a `pty-resume-readiness`
// flake inside the full daemon suite that 5+ standalone reruns and 14 artificially-loaded reruns couldn't
// reproduce — the loaded-scheduler theory, not a logic bug). Polling with a generous bound is robust to
// that delay while still failing fast (and clearly) if the condition is genuinely never met.
async function waitUntil(pred, timeoutMs = 3000, pollMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(pollMs);
  }
  return pred();
}

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn). Set the
// readiness fallback long enough that it can't fire before the cycles complete in the ordering test,
// but short enough that the fallback test below doesn't take 20s. ALL of these must be set BEFORE
// importing host.js (constants are read at import time).
const tmpHome = path.join(os.tmpdir(), `loom-readytest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_READY_FALLBACK_MS = "2500";
process.env.LOOM_RESUME_MODE_POLL_MS = "40"; // fast footer polling for scenario 2's feedback cycle
process.env.LOOM_RESUME_GATE_POLL_MS = "25"; // fast confirm-polling for scenarios 4-8's verify-retry
process.env.LOOM_RESUME_GATE_MAX_POLLS = "3";

const { PtyHost, isResumeSummaryGate, resumeGateCursorOption } = await import("../dist/pty/host.js");

// --- resume-from-summary gate DETECTION (pure fn). collapseBoot is internal; replicate it
// (strip ANSI CSI + all whitespace) to feed realistic boot output. The exact gate text Loom hit:
const GATE_PREFIX = "This session is 1h 16m old and 435.1k tokens. Resuming the full session will consume a "
  + "substantial portion of your usage limits. We recommend resuming from a summary.\n";
const GATE = GATE_PREFIX
  + "❯ 1. Resume from summary (recommended)\n  2. Resume full session as-is\n  3. Don't ask me again";
// The SAME gate re-rendered after a Down press actually lands (❯ now on option 2).
const GATE_ON_OPTION_2 = GATE_PREFIX
  + "  1. Resume from summary (recommended)\n❯ 2. Resume full session as-is\n  3. Don't ask me again";
// The SAME gate with the cursor unexpectedly on option 3 — should be unreachable with a single Down ever
// written, but exercised directly (scenarios 7-8) to prove the defensive Up-correction / never-Enter-on-3
// invariant holds if it somehow is reached.
const GATE_ON_OPTION_3 = GATE_PREFIX
  + "  1. Resume from summary (recommended)\n  2. Resume full session as-is\n❯ 3. Don't ask me again";
const collapse = (s) => s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\s+/g, "");
{
  let f = 0; const ck = (l, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); if (!c) f++; };
  ck("gate: real summary/as-is gate text is DETECTED", isResumeSummaryGate(collapse(GATE)) === true);
  ck("gate: normal manager prose mentioning 'resume' is NOT a false positive",
    isResumeSummaryGate(collapse("Let me update my living resume doc and continue the loop.")) === false);
  ck("gate: 'resume from summary' alone (no as-is option) is NOT matched",
    isResumeSummaryGate(collapse("we recommend resuming from a summary")) === false);
  // --- cursor-position DETECTION (pure fn) — what lets resolveResumeGate confirm a Down landed.
  ck("cursor: default render reads option 1", resumeGateCursorOption(collapse(GATE)) === "1");
  ck("cursor: post-Down render reads option 2", resumeGateCursorOption(collapse(GATE_ON_OPTION_2)) === "2");
  ck("cursor: option-3 render reads option 3", resumeGateCursorOption(collapse(GATE_ON_OPTION_3)) === "3");
  ck("cursor: unrelated text reads null (unreadable)", resumeGateCursorOption(collapse("hello world")) === null);
  if (f) { console.log(`\n❌ ${f} gate-detection FAILURE(S).`); process.exit(1); }
}

const fakes = [];
function makeFakePty() {
  const writes = [];
  let dataCb = null;
  const fake = {
    pid: 4242, write: (d) => writes.push(d),
    onData: (cb) => { dataCb = cb; return { dispose() {} }; }, // capture so a test can feed boot bytes
    onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes,
    feed: (s) => { if (dataCb) dataCb(s); }, // simulate engine output reaching host.onData
  };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const busyLog = [];
const events = { onEngineSessionId() {}, onBusy(_i, b) { busyLog.push(b); }, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

const PASTE_START = "\x1b[200~";
const SHIFT_TAB = "\x1b[Z";
const writtenOf = (fake) => fake.writes.join("");
const countIn = (fake, marker) => writtenOf(fake).split(marker).length - 1;

try {
  // ============ 1) Ready-gate: enqueue before SessionStart QUEUES; SessionStart drains it ============
  // Resume spawn (resumeId set), no mode-cycles → SessionStart marks ready synchronously.
  const A = "sess-resume-A";
  host.spawn({ sessionId: A, cwd: tmpHome, resumeId: "engine-A",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const fa = fakes[fakes.length - 1];
  const rBefore = host.enqueueStdin(A, "NUDGE_A");
  check("1: enqueue before SessionStart is QUEUED, not delivered", rBefore.delivered === false && rBefore.position === 1);
  check("1: nothing written to the booting TUI yet (no bracketed paste)", countIn(fa, PASTE_START) === 0);
  check("1: pending holds the nudge", JSON.stringify(host.getPending(A)) === JSON.stringify(["NUDGE_A"]));

  host.deliverHook(A, { hook_event_name: "SessionStart" });
  check("1: SessionStart marked ready and DRAINED the nudge (one bracketed paste)", countIn(fa, PASTE_START) === 1);
  check("1: the nudge text was written", writtenOf(fa).includes("NUDGE_A"));
  check("1: queue is now empty", host.getPending(A).length === 0);
  check("1: busy re-armed for the drained turn", busyLog[busyLog.length - 1] === true);

  // ============ 2) Ordering: on resume the mode-cycles land BEFORE the injection submits ============
  // Card b99d3d67: the mode-cycle is now FEEDBACK-driven (reads the footer), not blind timing — so this
  // scenario must feed a realistic footer progression for the cycle to actually converge. (No resumeId
  // here would also route through the same feedback cycler via startupModeCycles; resumeId is kept to
  // preserve this block's original "a resumed session" framing, but the routing is now identical either
  // way — see host.ts's SessionStart handler.)
  const B = "sess-resume-B";
  host.spawn({ sessionId: B, cwd: tmpHome, resumeId: "engine-B",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 2 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const fb = fakes[fakes.length - 1];
  fb.feed("accept edits on (shift+tab to cycle)"); // boot footer already painted before SessionStart fires
  host.enqueueStdin(B, "NUDGE_B");
  host.deliverHook(B, { hook_event_name: "SessionStart" }); // starts the feedback cycle; ready only after it lands
  check("2: NOT ready immediately after SessionStart — cycle in flight, nudge still queued", countIn(fb, PASTE_START) === 0);
  await sleep(750); // > MODE_CYCLE_SETTLE_MS(700) — first footer read (acceptEdits) → press #1
  check("2: NOT ready mid-cycle either — still queued after the first (unconfirmed) press", countIn(fb, PASTE_START) === 0);
  fb.feed("plan mode on (shift+tab to cycle)"); // press #1 registered: footer repaints to plan
  await sleep(150); // > overridden poll (40ms) × a few ticks — the change is observed → press #2
  fb.feed("auto mode on (shift+tab to cycle)"); // press #2 registered: footer repaints to auto (the target)
  await sleep(150);
  check("2: both Shift+Tab mode-cycles were sent", countIn(fb, SHIFT_TAB) === 2);
  check("2: the nudge submitted exactly once after the cycle converged", countIn(fb, PASTE_START) === 1);
  check("2: ORDERING — the Shift+Tabs were written BEFORE the bracketed paste",
    writtenOf(fb).indexOf(SHIFT_TAB) >= 0 && writtenOf(fb).indexOf(SHIFT_TAB) < writtenOf(fb).indexOf(PASTE_START));

  // ============ 3) Fallback: a missed SessionStart still drains the nudge after the grace ============
  const C = "sess-resume-C";
  host.spawn({ sessionId: C, cwd: tmpHome, resumeId: "engine-C",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const fc = fakes[fakes.length - 1];
  host.enqueueStdin(C, "NUDGE_C");
  check("3: queued, and held (no SessionStart delivered)", host.getPending(C).length === 1 && countIn(fc, PASTE_START) === 0);
  await sleep(2900); // > LOOM_READY_FALLBACK_MS(2500)
  check("3: readiness fallback drained the nudge despite no SessionStart", countIn(fc, PASTE_START) === 1 && writtenOf(fc).includes("NUDGE_C"));

  // ============ 4) Gate dismissal is VERIFIED, not blind: Down, THEN confirm before Enter ============
  const D = "sess-resume-gate";
  host.spawn({ sessionId: D, cwd: tmpHome, resumeId: "engine-D",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const fd = fakes[fakes.length - 1];
  fd.feed(GATE);                 // engine prints the resume-from-summary gate (pre-SessionStart)
  const downSeenD = await waitUntil(() => fd.writes.join("").includes("\x1b[B"));
  check("4: gate → Down arrow written (attempts to move ❯ off the 'from summary' default)", downSeenD);
  // Enter genuinely CANNOT be written yet regardless of scheduler delay: it only fires on a confirmed
  // cursor (not fed yet), an unexpected option-3 read (not fed yet), or exhausting ALL bounded presses
  // (needs 300ms settle + 3×~100ms — far past this check). So this is safe to assert right after the
  // Down, with no separate timing-sensitive sleep window of its own.
  check("4: Enter is NOT written yet — the cursor hasn't been confirmed on option 2 (the 2026-07-10 bug: "
    + "the OLD code fired Enter blindly here, 150ms after Down, with no read-back)", !fd.writes.join("").includes("\r"));
  fd.feed(GATE_ON_OPTION_2);     // the engine's re-render confirms the Down actually landed
  await waitUntil(() => fd.writes.join("").includes("\r"));
  {
    const w = fd.writes.join("");
    const di = w.indexOf("\x1b[B"); const ei = w.indexOf("\r");
    check("4: Enter written AFTER confirmation (selects option 2 'as-is')", ei > di && di >= 0);
    check("4: exactly ONE Down + ONE Enter (confirmed on the first press — no retry needed)", w === "\x1b[B\r");
  }
  const wlenD = fd.writes.length;
  fd.feed(GATE);                 // a repeat of the gate output must NOT re-fire (handled-once guard)
  await sleep(200); // a "nothing MORE happens" check — safe at any duration, not timing-sensitive
  check("4: gate handled exactly once per session (no double-select)", fd.writes.length === wlenD);

  // ============ 5) Slow-but-eventual confirm: EXACTLY ONE Down ever — no retry-press overshoot risk ============
  // Code-review regression guard: a version of this fix that RE-PRESSED Down once a poll window elapsed
  // unconfirmed could overshoot 1→2→3 if the first press was merely SLOW (not dropped). This scenario
  // proves the opposite: the confirming re-render arrives LATE (after several poll ticks, well within the
  // generous budget) but Down is written ONLY ONCE, total, the whole time.
  const E = "sess-resume-gate-slow";
  host.spawn({ sessionId: E, cwd: tmpHome, resumeId: "engine-E",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const fe = fakes[fakes.length - 1];
  const downCount = (fake) => fake.writes.join("").split("\x1b[B").length - 1;
  const upCount = (fake) => fake.writes.join("").split("\x1b[A").length - 1;
  fe.feed(GATE);
  const downSeenE = await waitUntil(() => downCount(fe) >= 1);
  check("5: the one Down arrow was written", downSeenE);
  // Checked IMMEDIATELY (no extra sleep) — safe regardless of scheduler delay, since Enter genuinely
  // cannot fire yet (no confirming render fed, and the give-up budget hasn't elapsed).
  check("5: no Enter yet, right after the Down", !fe.writes.join("").includes("\r"));
  // Let a couple of poll ticks elapse with NO confirming re-render fed yet (the press is "slow", not
  // dropped) — purely for narrative realism; no timing-sensitive assertion is tied to this pause itself
  // (downCount/Enter are re-checked below, after the confirmation, when there's no race left to lose).
  await sleep(2 * 25);
  fe.feed(GATE_ON_OPTION_2);     // NOW the slow press's re-render lands, confirming option 2
  const enterSeenE = await waitUntil(() => fe.writes.join("").includes("\r"));
  check("5: Enter now written after the late confirmation", enterSeenE);
  check("5: EXACTLY one Down total, ever (the overshoot-elimination invariant)", downCount(fe) === 1);
  check("5: no Up presses on the happy path", upCount(fe) === 0);

  // ============ 6) Give-up: a genuinely dropped Down never confirms → still sends Enter, exactly once =====
  // Best-effort fallback (the pre-fix behavior) for a real dropped keystroke — rare, and PRIMARY-prevented
  // by the settings env override. Still only ONE Down is ever written (never a retry-press).
  const F = "sess-resume-gate-giveup";
  host.spawn({ sessionId: F, cwd: tmpHome, resumeId: "engine-F",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const ff = fakes[fakes.length - 1];
  ff.feed(GATE);                 // cursor stays stuck on option 1 — never fed a confirming re-render
  await waitUntil(() => ff.writes.join("").includes("\r"), 8000, 20); // give-up eventually sends Enter anyway
  {
    const w = ff.writes.join("");
    check("6: exactly ONE Down, ever (no retry-press even on a full give-up)", downCount(ff) === 1);
    check("6: give-up still sends Enter — never strands the gate on screen forever", w.endsWith("\r"));
  }

  // ============ 7) Defensive Up-correction: an unexpected option-3 read is corrected, never confirmed ======
  // Should be structurally unreachable with a single Down ever written, but exercised directly: if the
  // cursor is somehow read at option 3, the fix corrects with exactly ONE Up (never a Down retry) and only
  // confirms/Enters once a SUBSEQUENT render shows option 2 — it never confirms/Enters while reading 3.
  const G = "sess-resume-gate-up-correct";
  host.spawn({ sessionId: G, cwd: tmpHome, resumeId: "engine-G",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const fg = fakes[fakes.length - 1];
  fg.feed(GATE_ON_OPTION_3);     // simulate the cursor already unexpectedly reading option 3
  const upSeenG = await waitUntil(() => upCount(fg) >= 1);
  check("7: an Up arrow was written to correct off option 3 (never a second Down)", upSeenG);
  check("7: no Enter yet — option 3 must never be confirmed/entered", !fg.writes.join("").includes("\r"));
  check("7: no second Down was ever written", downCount(fg) === 1);
  fg.feed(GATE_ON_OPTION_2);     // the correction's re-render confirms landing on option 2
  const enterSeenG = await waitUntil(() => fg.writes.join("").includes("\r"));
  check("7: Enter now written, only AFTER re-confirming option 2 post-correction", enterSeenG);
  check("7: exactly one Up and one Down total", upCount(fg) === 1 && downCount(fg) === 1);

  // ============ 8) Stuck on option 3 forever: give-up NEVER sends Enter (would persist "don't ask again") ==
  const H = "sess-resume-gate-stuck-3";
  host.spawn({ sessionId: H, cwd: tmpHome, resumeId: "engine-H",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const fh = fakes[fakes.length - 1];
  fh.feed(GATE_ON_OPTION_3);     // cursor reads option 3 and NEVER moves off it — no further feed at all
  const upSeenH = await waitUntil(() => upCount(fh) >= 1);
  check("8: the one defensive Up-correction was attempted", upSeenH);
  // Give the full post-correction budget to elapse (never confirming) — (MAX_POLLS+1)×POLL_MS after the
  // correction, generous slack — then assert the terminal invariant: NO Enter, ever, while stuck on 3.
  await sleep(4 * 25 + 300);
  {
    const w = fh.writes.join("");
    check("8: NO Enter was ever sent (would durably persist \"don't ask me again\")", !w.includes("\r"));
    check("8: exactly one Down and one Up — never a second correction attempt", downCount(fh) === 1 && upCount(fh) === 1);
  }
} finally {
  for (const s of [
    "sess-resume-A", "sess-resume-B", "sess-resume-C",
    "sess-resume-gate", "sess-resume-gate-slow", "sess-resume-gate-giveup",
    "sess-resume-gate-up-correct", "sess-resume-gate-stuck-3",
  ]) { try { host.stop(s, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot-readiness gate holds: injection queues until SessionStart, drains after the mode-cycles, and a missed SessionStart still drains via the fallback."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
