// Card 01160ae3 — bounded detector for an unattended spawn stuck on a blocking CLI dialog BEFORE
// SessionStart. Exercises the REAL PtyHost state machine (spawn/deliverHook/the dialogStuckTimer) against
// a FAKE pty, at the createPty() seam (mirrors pty-mode-convergence.mjs). No real claude, no daemon.
//
// LOOM_CLAUDE_BOOT_DIALOG_STUCK_TIMEOUT_MS is shrunk to a few hundred ms so the "fires" scenarios don't
// take the real 150s default — set BEFORE importing host.js (the constant is read at module-load time).
//
// What it locks:
//   1. A session stuck on a known blocking-dialog signature, with SessionStart never observed, gets
//      exactly one onClaudeBootDialogStuck event once the timeout elapses — named signature included.
//   2. A slow-but-healthy boot (SessionStart arrives before the timeout, no dialog ever shown) never
//      fires the detector — asserted SYNCHRONOUSLY right after deliverHook (which clears the timer in the
//      same call), never via a fixed sleep past the deadline (see _wait.mjs's own doc on why a fixed wait
//      can't prove a negative).
//   3. Once the event HAS fired for a session, a LATE SessionStart for that same session produces no
//      second alarm (checked synchronously right after the late deliverHook call).
//   4. Role-gated: a manager-role spawn (not in LOOM_DRIVEN_ROLES) never even ARMS the timer — checked
//      structurally (dialogStuckTimer stays null) rather than by waiting past the deadline.
//   5. The timer re-arms on a resume spawn (a fresh Live object), not just a fresh spawn.
//   6. (Code Review round 2, item (d)) the signature unit checks above exercise the REAL exported
//      collapseBoot, not a hand-copied local regex that could silently drift from it.
//   7. (Code Review round 2, item 4(a)) overwrite-on-resume: a fresh spawn immediately followed by a
//      resume spawn of the SAME sessionId clears the OUTGOING timer — it never fires a duplicate event
//      once the new timer's own window elapses (proven by an exact event COUNT of one, never two).
//   8. (Code Review round 2, item 4(b)) onExit clear: a pty that is hard-stopped (dies) before
//      SessionStart is ever observed never fires the detector — asserted synchronously right after
//      stop(), which triggers the fake pty's onExit synchronously (see _seam-host-fixture.mjs).
//   9. (Code Review round 2, item 2) fire-time bail: the detector bails when the engine is clearly past
//      boot even though SessionStart itself was somehow never observed — either `firstTurnStarted`
//      (a real UserPromptSubmit hook) or `anyHookObserved` (ANY other hook at all) suppresses the alarm.
//      Proven by letting the real timer actually fire (confirmed via dialogStuckTimer nulling itself)
//      and then asserting no event was recorded — not a blind sleep with no corroborating signal.
//
// RUN: pnpm build (repo root) then `node test/claude-boot-dialog-stuck.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const waitUntil = async (pred, timeoutMs, intervalMs = 20) => {
  try {
    return await sharedWaitUntil(pred, { timeoutMs, intervalMs, label: "claude-boot-dialog-stuck" });
  } catch (err) {
    if (err?.exhaustedOnThrow !== false) throw err;
    return false;
  }
};

const tmpHome = path.join(os.tmpdir(), `loom-cbds-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_CLAUDE_BOOT_DIALOG_STUCK_TIMEOUT_MS = "250"; // real setTimeout, kept short for the test
process.env.LOOM_READY_FALLBACK_MS = "60000"; // comfortably longer than any scenario — never let it interfere

const { PtyHost, detectBlockingDialogSignature, collapseBoot, LOOM_DRIVEN_ROLES } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// --- Unit-level: detectBlockingDialogSignature (positive + negative controls) -------------------------
// Card 01160ae3, Code Review round 2 item (d): exercise the REAL exported collapseBoot (not a hand-copied
// local regex) so this unit block can't silently drift from the module's own normalization.
{
  const collapse = collapseBoot;
  check("(setup) collapseBoot strips ANSI CSI and whitespace, same as this test's own fixtures expect",
    collapse("\x1b[31mHello  World\x1b[0m") === "HelloWorld");
  check("detectBlockingDialogSignature: external-imports dialog recognized",
    detectBlockingDialogSignature(collapse("Allow external CLAUDE.md file imports?\n❯ No, disable external imports\n  Yes, allow external imports\nEnter to confirm · Esc to cancel")) === "external-imports");
  check("detectBlockingDialogSignature: workspace-trust dialog recognized",
    detectBlockingDialogSignature(collapse("Is this a project you trust?\n❯ Yes, I trust this folder\n  No\nEnter to confirm · Esc to cancel")) === "workspace-trust");
  check("detectBlockingDialogSignature: mcp-server-enable dialog recognized",
    detectBlockingDialogSignature(collapse("2 new MCP servers found\n❯ Enable\n  Reject all")) === "mcp-server-enable");
  check("detectBlockingDialogSignature: generic enter/esc footer recognized when nothing more specific matches",
    detectBlockingDialogSignature(collapse("Some future dialog we've never seen\nEnter to confirm · Esc to cancel")) === "enter-esc-footer");
  check("detectBlockingDialogSignature: negative control — ordinary busy/working text never matches",
    detectBlockingDialogSignature(collapse("Working (3s · esc to interrupt)\n> Ask Claude to do anything")) === null);
  check("detectBlockingDialogSignature: negative control — empty buffer never matches", detectBlockingDialogSignature("") === null);
  check("(setup) 'worker' is in LOOM_DRIVEN_ROLES; 'manager' is not",
    LOOM_DRIVEN_ROLES.includes("worker") && !LOOM_DRIVEN_ROLES.includes("manager"));
}

// --- Fake-pty harness ------------------------------------------------------------------------------
const fakes = new Map(); // sessionId -> fake pty
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    let dataCb = null;
    const fake = {
      ...base,
      onData: (cb) => { dataCb = cb; return { dispose() {} }; },
      feed: (s) => { if (dataCb) dataCb(s); },
    };
    fakes.set(opts.sessionId, fake);
    return fake;
  }
}
const stuckEvents = [];
const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onClaudeBootDialogStuck(sessionId, info) { stuckEvents.push({ sessionId, info }); },
};
const host = new TestPtyHost(events);

const spawnOne = (id, role, resumeId) => {
  host.spawn({
    sessionId: id, cwd: tmpHome, resumeId,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role,
  });
  return fakes.get(id);
};

try {
  // ============ 1) Dialog shown, SessionStart never observed ⇒ exactly one event, signature named =======
  const A = "sess-dialog-stuck-A";
  const fa = spawnOne(A, "worker");
  fa.feed("Allow external CLAUDE.md file imports?\n❯ No, disable external imports\n  Yes, allow external imports\nEnter to confirm · Esc to cancel");
  // No deliverHook(SessionStart) at all — this is the hang this detector exists to catch.
  check("1: the timeout has not elapsed yet — no event fired prematurely", stuckEvents.filter((e) => e.sessionId === A).length === 0);
  const fired = await waitUntil(() => stuckEvents.some((e) => e.sessionId === A), 3000);
  check("1: onClaudeBootDialogStuck fired once the timeout elapsed with SessionStart never observed", fired);
  check("1: exactly one event for this session (one-shot, not a retry ladder)", stuckEvents.filter((e) => e.sessionId === A).length === 1);
  check("1: the event names the recognized signature", stuckEvents.find((e) => e.sessionId === A)?.info.signatureName === "external-imports");
  check("1: the event never carries a screen excerpt — signature name only (CLAUDE.md log-content doctrine)",
    (() => { const i = stuckEvents.find((e) => e.sessionId === A)?.info; return Object.keys(i).sort().join(",") === "role,signatureName,timeoutMs"; })());

  // ============ 2) Slow-but-healthy boot: SessionStart arrives before the timeout ⇒ never fires ==========
  const B = "sess-slow-healthy-B";
  spawnOne(B, "worker");
  // No dialog text at all — just a late (but within-ceiling) SessionStart.
  host.deliverHook(B, { hook_event_name: "SessionStart", session_id: "eng-B" });
  // deliverHook's SessionStart case clears dialogStuckTimer SYNCHRONOUSLY in this same call — asserting
  // immediately after is a complete proof (the cleared timer cannot fire later), not a guess about timing.
  check("2: SessionStart observed ⇒ dialogStuckTimer is cleared (null) immediately, synchronously", host.live.get(B).dialogStuckTimer === null);
  check("2: no stuck event for a session that reached SessionStart well inside its own ceiling", stuckEvents.filter((e) => e.sessionId === B).length === 0);

  // ============ 3) A LATE SessionStart after the event already fired ⇒ no second alarm ====================
  const C = "sess-late-sessionstart-C";
  spawnOne(C, "worker");
  await waitUntil(() => stuckEvents.some((e) => e.sessionId === C), 3000);
  check("3: (setup) the stuck event fired once for C before the late SessionStart", stuckEvents.filter((e) => e.sessionId === C).length === 1);
  host.deliverHook(C, { hook_event_name: "SessionStart", session_id: "eng-C" });
  check("3: a SessionStart arriving AFTER the alarm already fired produces NO further event (checked synchronously, same call)", stuckEvents.filter((e) => e.sessionId === C).length === 1);

  // ============ 4) Role gating: manager is not in LOOM_DRIVEN_ROLES ⇒ the timer is never armed at all =====
  const D = "sess-manager-not-gated-D";
  spawnOne(D, "manager");
  check("4: a manager-role spawn never arms dialogStuckTimer (structural — not a timing wait)", host.live.get(D).dialogStuckTimer === null);
  const E = "sess-plain-not-gated-E";
  spawnOne(E, null);
  check("4: a role-less (plain) spawn never arms dialogStuckTimer either", host.live.get(E).dialogStuckTimer === null);

  // ============ 5) A resume spawn (fresh Live) re-arms the timer too ======================================
  const F = "sess-resume-rearms-F";
  spawnOne(F, "worker", "eng-F-prior");
  check("5: a resume spawn for a Loom-driven role ALSO arms dialogStuckTimer (fresh Live, fresh epoch)", host.live.get(F).dialogStuckTimer !== null);

  // ============ 7) Overwrite-on-resume: the OUTGOING timer is structurally cleared, synchronously ==========
  // Code Review round 2, item 4(a). If the outgoing timer were NOT cleared, it would re-look-up the (now
  // resumed) Live at ITS OWN fire time and push a duplicate event. Proven STRUCTURALLY rather than by a
  // fixed wait + recount (a fixed wait here can't actually prove the negative: the outgoing timer's own
  // window can fire LATER than whichever event a short wait happens to observe first, so a bounded sleep
  // can read "only one event so far" before a second, buggy one has had time to arrive — see the standing
  // fixed-wait-negative-assertion guard, fixed-wait-negative-guard.mjs). Instead: capture the outgoing
  // timer's own handle, spy on the global clearTimeout, resume, and assert — synchronously, no waiting —
  // that THIS EXACT handle was passed to clearTimeout and that the resumed Live holds a fresh, different
  // one. Node's own timer semantics then guarantee a cleared timeout can never fire later; nothing here
  // needs to race real time to prove it.
  const G = "sess-overwrite-resume-G";
  spawnOne(G, "worker");
  const outgoingTimerG = host.live.get(G).dialogStuckTimer;
  check("7: (setup) the first spawn armed a real timer handle", outgoingTimerG !== null);
  const clearedTimers = [];
  const realClearTimeout = global.clearTimeout;
  global.clearTimeout = (t) => { clearedTimers.push(t); return realClearTimeout(t); };
  try {
    spawnOne(G, "worker", "eng-G-resume"); // resume: overwrites the Live — must clear the outgoing timer synchronously (see spawn()'s own clear site)
  } finally {
    global.clearTimeout = realClearTimeout;
  }
  check("7: the resume spawn synchronously clears the OUTGOING timer handle, never leaving it to fire later", clearedTimers.includes(outgoingTimerG));
  check("7: the resumed Live gets a FRESH timer handle, distinct from the cleared outgoing one", host.live.get(G).dialogStuckTimer !== null && host.live.get(G).dialogStuckTimer !== outgoingTimerG);
  const firedG = await waitUntil(() => stuckEvents.some((e) => e.sessionId === G), 3000);
  check("7: (end-to-end) the NEW timer still fires once for the resumed Live", firedG);
  check("7: exactly ONE event total for G — the structurally-cleared outgoing timer never contributes a duplicate", stuckEvents.filter((e) => e.sessionId === G).length === 1);

  // ============ 8) onExit clear: a pty that dies before SessionStart never fires =========================
  // Code Review round 2, item 4(b). A hard stop kills the fake pty SYNCHRONOUSLY (_seam-host-fixture.mjs),
  // which fires the real onData/onExit wiring in spawn() — including the dialogStuckTimer clear. Asserted
  // synchronously right after stop(), the same style as scenario 2's SessionStart clear, never a wait.
  const H = "sess-dies-before-sessionstart-H";
  spawnOne(H, "worker");
  check("8: (setup) dialogStuckTimer is armed before the stop", host.live.get(H).dialogStuckTimer !== null);
  host.stop(H, "hard");
  check("8: a hard stop clears dialogStuckTimer immediately, synchronously (onExit)", host.live.get(H).dialogStuckTimer === null);
  check("8: no stuck event for a session that died before ever reaching SessionStart", stuckEvents.filter((e) => e.sessionId === H).length === 0);

  // ============ 9) Fire-time bail: engine clearly past boot even though SessionStart was never observed ===
  // Code Review round 2, item 2. Neither case clears the timer early (unlike the SessionStart case) — the
  // bail happens INSIDE the fire-time callback, so the real timer must actually fire. Proven by waiting
  // for dialogStuckTimer to null itself (direct evidence the callback ran), then asserting no event
  // followed — not a blind sleep with nothing else observed.
  const I = "sess-first-turn-started-no-sessionstart-I";
  spawnOne(I, "worker");
  host.deliverHook(I, { hook_event_name: "UserPromptSubmit", session_id: "eng-I", prompt: "hi" }); // flips firstTurnStarted — no SessionStart ever delivered
  check("9: (setup) firstTurnStarted flipped without SessionStart ever being observed", host.live.get(I).firstTurnStarted === true && host.live.get(I).sessionStartObserved === false);
  const nulledI = await waitUntil(() => host.live.get(I)?.dialogStuckTimer === null, 3000);
  check("9: (setup) the real timer fired (nulled itself) for I", nulledI);
  check("9: firstTurnStarted true ⇒ no stuck event even though SessionStart itself was never observed", stuckEvents.filter((e) => e.sessionId === I).length === 0);

  const J = "sess-any-hook-observed-no-sessionstart-J";
  spawnOne(J, "worker");
  host.deliverHook(J, { hook_event_name: "PreToolUse", session_id: "eng-J", tool_name: "mcp__loom-tasks__tasks_get" }); // ANY hook — not SessionStart, not UserPromptSubmit
  check("9: (setup) anyHookObserved set by a PreToolUse hook, SessionStart/firstTurnStarted still false", host.live.get(J).anyHookObserved === true && host.live.get(J).sessionStartObserved === false && host.live.get(J).firstTurnStarted === false);
  const nulledJ = await waitUntil(() => host.live.get(J)?.dialogStuckTimer === null, 3000);
  check("9: (setup) the real timer fired (nulled itself) for J", nulledJ);
  check("9: anyHookObserved true (a non-SessionStart hook) ⇒ no stuck event either", stuckEvents.filter((e) => e.sessionId === J).length === 0);
} finally {
  for (const id of [
    "sess-dialog-stuck-A", "sess-slow-healthy-B", "sess-late-sessionstart-C", "sess-manager-not-gated-D",
    "sess-plain-not-gated-E", "sess-resume-rearms-F", "sess-overwrite-resume-G", "sess-dies-before-sessionstart-H",
    "sess-first-turn-started-no-sessionstart-I", "sess-any-hook-observed-no-sessionstart-J",
  ]) {
    try { host.stop(id, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — claude boot-dialog-stuck detector fires once (named signature, no screen content) for an unattended spawn that never reaches SessionStart; never fires for a slow-but-healthy boot or a late SessionStart after the alarm; role-gated to LOOM_DRIVEN_ROLES; re-arms on resume; the overwrite-on-resume and onExit timer clears hold under real timing; and the fire-time bail suppresses the alarm whenever firstTurnStarted or any other hook proves the engine is past boot."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
