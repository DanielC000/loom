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
//   10-14. Card e29923e3 round 3 (Code Review 7d53af22 — SCOPE CUT): the MCP-enable-prompt dismiss is a
//      SINGLE Esc write, never a retry loop, and never infers dismissal from screen output — two rounds
//      of "how much/what kind of post-write output counts as evidence" each reproduced the same failure
//      one level up (see docs/decisions/e29923e3-hold-boot-dialog-kickoff-until-sessionstart.md). (10) a
//      dropped Esc + a genuinely static dialog stays held forever, exactly one Esc ever written. (11) ANY
//      post-write output — sync-frame markers, OSC frames, a tick, or even a full substantial clean
//      repaint — never releases the hold; only SessionStart does. (12) a SessionStart arriving after the
//      Esc releases the hold AND delivers a queued entry. (13) the single Esc fires for EVERY role, worker
//      and manager alike (round 3's own Minor fix: the old retry loop was unintentionally NOT role-gated,
//      so a non-driven role could get up to 3 Escs; a single write is role-uniform by construction). (14)
//      migrated from round 1's own (d1): a same-id respawn DURING the deferred write's settle delay must
//      never let the stale generation's write land on, or be attributed to, the new generation (card
//      096231e8 identity discipline) — this is the one race that survives the retry loop's removal, since
//      the single write is still deferred by `MCP_DISMISS_INITIAL_DELAY_MS`.
//   15. Round 4 (delta Code Review 07a334ed, Minor 1): removed the round-3 `isPastBoot` bail from
//      `dismissMcpPrompt` — a SessionStart landing DURING the deferred delay (before the Esc write ever
//      fires) no longer suppresses it; the single Esc still fires exactly once, session kept alive
//      throughout so the identity/liveness guards can't mask the removal.
//   16-19. Card b1da256d: `onClaudeBootDialogResolved` — the RESOLVE half of this detector, fired from
//      `deliverHook` the first time `Live.anyHookObserved` flips false→true for a given Live incarnation
//      (see that call site's own doc). (16) an on-time SessionStart of a fresh spawn fires exactly once; a
//      second hook on the same incarnation never refires it. (17) a LATE SessionStart arriving after the
//      stuck alarm already fired still fires exactly once (round 3's own case). (18) round 2 (item 1): a
//      re-spawn (resume) of the SAME session id AFTER incarnation 1 has already fired its OWN resolved
//      event: the respawn itself (fresh Live, no hook yet) fires no ADDITIONAL event; the first hook on
//      the NEW incarnation fires a SECOND, independent resolved event (count 1 → 2) — per-incarnation,
//      never globally suppressed by the OLD incarnation's prior fire. (19) THE ROUND-4 GAP
//      ITSELF: a non-SessionStart first hook (e.g. PreToolUse) arriving after the alarm, with SessionStart
//      NEVER observed at all, still fires exactly once — a SessionStart-only design (round 3's own, cut at
//      e2a3c613 round 4 because it missed exactly this case) can never fire here.
//
// RED-BEFORE-GREEN for (18)/scenario 18 (round 2, item 1): round 1's own version of scenario 18 never
// delivered any hook on incarnation 1 before respawning, so a once-per-sessionId Set (fire the resolve at
// most once EVER for a session id, instead of once per Live incarnation) would have passed it too — that
// Set would never have been populated before the respawn. Confirmed by hand: with `deliverHook`'s
// `firstHookThisIncarnation` check temporarily replaced by a module-level `Set<string>` keyed on
// sessionId alone (fire only if the id had never fired before, regardless of incarnation), 18c fails
// (count stuck at 1, not 2) while every other scenario in this file — including 16/17/19, which never
// respawn — still passes; reverting to the real per-incarnation `anyHookObserved` flip restores the full
// green. See the card's own done-report for the exact before/after run.
//
// RED-BEFORE-GREEN for (19)/scenario 19 (this project's own standing verification posture): with the fix
// reverted to fire `onClaudeBootDialogResolved` ONLY inside `deliverHook`'s `case "SessionStart":` block
// (round 3's own cut design) instead of on the top-of-function `anyHookObserved` flip, scenario 19a fails
// (zero resolved events, not one) while every other scenario in this file still passes — confirmed by hand
// against that reverted build before restoring the real (flip-keyed) fix; see the card's own done-report
// for the exact before/after run.
//
// RUN: pnpm build (repo root) then `node test/claude-boot-dialog-stuck.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { assertNeverWithControl } from "./_timing-guard.mjs";

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
// Card e29923e3 round 3: the single Esc write fires MCP_DISMISS_INITIAL_DELAY_MS after detection and
// nothing is ever scheduled after it — 20ms, comfortably under the 250ms stuck-timeout above, so none of
// the scenarios below ever race that OTHER one-shot timer.
process.env.LOOM_MCP_DISMISS_INITIAL_DELAY_MS = "20";

const {
  PtyHost, detectBlockingDialogSignature, collapseBoot, LOOM_DRIVEN_ROLES, BOOT_DIALOG_DETECTOR_ROLES,
  isMcpServerEnableSignature, disallowedToolsForRole, HUMAN_PROMPT_TOOLS,
} = await import("../dist/pty/host.js");
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

// --- Card e2a3c613: BOOT_DIALOG_DETECTOR_ROLES is a SEPARATE, wider constant from LOOM_DRIVEN_ROLES ----
// --- (manager/platform coverage), and disallowedToolsForRole is UNCHANGED by that widening — pins the ---
// --- split decision 8dd1dd1c requires (manager/platform must keep AskUserQuestion/ExitPlanMode/ ----------
// --- EnterPlanMode; widening the detector's own role gate must never touch that). ------------------------
{
  check("(e2a3c613) BOOT_DIALOG_DETECTOR_ROLES includes every LOOM_DRIVEN_ROLES member",
    LOOM_DRIVEN_ROLES.every((r) => BOOT_DIALOG_DETECTOR_ROLES.includes(r)));
  check("(e2a3c613) BOOT_DIALOG_DETECTOR_ROLES ALSO includes manager and platform",
    BOOT_DIALOG_DETECTOR_ROLES.includes("manager") && BOOT_DIALOG_DETECTOR_ROLES.includes("platform"));
  check("(e2a3c613) LOOM_DRIVEN_ROLES itself is UNTOUCHED — still excludes manager/platform",
    !LOOM_DRIVEN_ROLES.includes("manager") && !LOOM_DRIVEN_ROLES.includes("platform"));
  // Manager sign-off condition 1: disallowedToolsForRole("manager"/"platform") must still OMIT every
  // HUMAN_PROMPT_TOOLS entry (AskUserQuestion/ExitPlanMode/EnterPlanMode stay USABLE for both roles) even
  // though BOOT_DIALOG_DETECTOR_ROLES now covers them for the stuck-dialog detector/hold.
  const mgrDisallowed = disallowedToolsForRole("manager");
  const leadDisallowed = disallowedToolsForRole("platform");
  check("(e2a3c613) disallowedToolsForRole('manager') carries NONE of HUMAN_PROMPT_TOOLS — unchanged by this card",
    HUMAN_PROMPT_TOOLS.every((t) => !mgrDisallowed.includes(t)));
  check("(e2a3c613) disallowedToolsForRole('platform') carries NONE of HUMAN_PROMPT_TOOLS — unchanged by this card",
    HUMAN_PROMPT_TOOLS.every((t) => !leadDisallowed.includes(t)));
}

// --- Unit-level: isMcpServerEnableSignature (positive + negative controls) ------------------------------
{
  check("isMcpServerEnableSignature: positive control", isMcpServerEnableSignature(collapseBoot("2 new MCP servers found\n❯ Enable\n  Reject all")));
  check("isMcpServerEnableSignature: negative control — a different dialog's own text never matches", !isMcpServerEnableSignature(collapseBoot("Is this a project you trust?\n❯ Yes, I trust this folder\n  No\nEnter to confirm · Esc to cancel")));
}

// --- Fake-pty harness ------------------------------------------------------------------------------
const fakes = new Map(); // sessionId -> fake pty
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    let dataCb = null;
    const fake = {
      ...base,
      write: (d) => writes.push(d),
      onData: (cb) => { dataCb = cb; return { dispose() {} }; },
      feed: (s) => { if (dataCb) dataCb(s); },
      writes,
    };
    fakes.set(opts.sessionId, fake);
    return fake;
  }
}
const ESC_KEY = "\x1b";
const countEsc = (fake) => fake.writes.filter((w) => w === ESC_KEY).length;
// A realistic, substantial post-dialog repaint — used in scenario 11 below to prove that even output this
// size (round 2's now-deleted 96-char "substantial" threshold would have treated it as dismissal evidence)
// never releases the hold post round 3; only a real SessionStart does.
const CLEAN_DISMISS_TEXT = "Welcome back! How can I help you today?\nAsk Claude to write, fix, or explain code, run commands, or manage files in this project, and it will dive right in.\n> ";
const stuckEvents = [];
const resolvedEvents = [];
const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onClaudeBootDialogStuck(sessionId, info) { stuckEvents.push({ sessionId, info }); },
  // Card b1da256d: fires on the FIRST hook of every Live incarnation, unconditionally — the host layer
  // has no notion of "was this session ever stuck"; that's SessionService.handleClaudeBootDialogResolved's
  // own job (covered separately in claude-boot-dialog-stuck-no-self-nudge.mjs). These scenarios only pin
  // the HOST wiring: which hook, in which order, fires this callback exactly once per incarnation.
  onClaudeBootDialogResolved(sessionId) { resolvedEvents.push({ sessionId }); },
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

  // ============ 4) Role gating (card e2a3c613): manager/platform are NOW in BOOT_DIALOG_DETECTOR_ROLES ===
  // ============    ⇒ ARMED (was: manager never armed, pre-e2a3c613) — plain stays ungated throughout =====
  const D = "sess-manager-gated-D";
  spawnOne(D, "manager");
  check("4: a manager-role spawn NOW arms dialogStuckTimer (card e2a3c613 — manager coverage)", host.live.get(D).dialogStuckTimer !== null);
  const D2 = "sess-platform-gated-D2";
  spawnOne(D2, "platform");
  check("4: a platform(Lead)-role spawn ALSO arms dialogStuckTimer (card e2a3c613 — Lead coverage)", host.live.get(D2).dialogStuckTimer !== null);
  const E = "sess-plain-not-gated-E";
  spawnOne(E, null);
  check("4: a role-less (plain) spawn still never arms dialogStuckTimer", host.live.get(E).dialogStuckTimer === null);

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

  // ============ 10) Card e29923e3 round 3 (SCOPE CUT): a dropped Esc + a genuinely static dialog stays ===
  // ============      held FOREVER — exactly one Esc ever written, no retry loop left to exhaust ==========
  const K = "sess-mcp-prompt-single-chunk-K";
  const fk = spawnOne(K, "worker");
  const MCP_PROMPT_TEXT = "2 new MCP servers found\n❯ Enable\n  Reject all";
  check("10: (setup) the signature is recognized when fed in isolation (positive control for the assertions below)",
    detectBlockingDialogSignature(collapseBoot(MCP_PROMPT_TEXT)) === "mcp-server-enable");

  // Shared helpers for scenarios 10/14 below: the ONLY two ways left to observe something flip in this
  // state machine are (a) a real SessionStart hook clearing dialogStuckScan, and (b) a fresh, never-
  // respawned session actually receiving its single scheduled Esc write.
  const sessionStartReleaseControl = async (label) => {
    const id = `sess-${label}-sessionstart-control`;
    const f = spawnOne(id, "worker");
    f.feed(MCP_PROMPT_TEXT);
    host.deliverHook(id, { hook_event_name: "SessionStart", session_id: `eng-${id}` });
    const went = detectBlockingDialogSignature(collapseBoot(host.live.get(id)?.dialogStuckScan ?? "")) === null;
    try { host.stop(id, "hard"); } catch { /* ignore */ }
    return went;
  };
  const escWriteControl = async (label) => {
    const id = `sess-${label}-esc-write-control`;
    const f = spawnOne(id, "worker");
    f.feed(MCP_PROMPT_TEXT);
    const went = await waitUntil(() => countEsc(f) >= 1, 3000).then(() => true).catch(() => false);
    try { host.stop(id, "hard"); } catch { /* ignore */ }
    return went;
  };

  fk.feed(MCP_PROMPT_TEXT); // detected ⇒ mcpPromptHandled=true, dismissMcpPrompt scheduled exactly once
  check("10a: mcpPromptHandled flips true and the single Esc dismiss is scheduled", host.live.get(K).mcpPromptHandled === true);
  check("10b: the hold does NOT release synchronously at detection — dialogStuckScan still matches right after",
    detectBlockingDialogSignature(collapseBoot(host.live.get(K).dialogStuckScan)) === "mcp-server-enable");
  check("10c: the single scheduled Esc write fires", await waitUntil(() => countEsc(fk) >= 1, 3000));

  // Never feed anything else on K — a genuinely static dialog, exactly the "dropped Esc" shape the card's
  // own body describes. With no retry loop left to exhaust, the hold must survive indefinitely past the
  // one write — nothing but a real SessionStart (sessionStartReleaseControl, above) can ever clear it.
  const stillHeldAfterTheOneWrite = await assertNeverWithControl({
    label: "10d: the hold never releases after the single write — no retry loop left to eventually exhaust",
    check: () => detectBlockingDialogSignature(collapseBoot(host.live.get(K)?.dialogStuckScan ?? "")) === null,
    windowMs: Number(process.env.LOOM_MCP_DISMISS_INITIAL_DELAY_MS) + 200,
    positiveControl: () => sessionStartReleaseControl("10d"),
  });
  check("10d: the hold stays engaged forever once the single write lands on a genuinely static dialog", stillHeldAfterTheOneWrite);
  check("10e: exactly ONE Esc was ever written on K — no retry loop to fire a second", countEsc(fk) === 1);
  try { host.stop(K, "hard"); } catch { /* ignore */ }

  // ============ 11) ANY post-write screen output — sync-frame markers, OSC frames, a tick, or even a ====
  // ============      FULL substantial clean repaint — never releases the hold; only SessionStart does ====
  // Two rounds of "how much/what kind of post-write output counts as evidence" each independently
  // reproduced the same bug one level up (see the record). Round 3 deletes the whole mechanism: feed
  // every kind of post-write noise this card's own history names — including a genuinely clean repaint
  // well over the now-DELETED 96-char "substantial" threshold — and confirm NONE of it clears the scan.
  {
    const L = "sess-post-write-noise-still-held-L";
    const fl = spawnOne(L, "worker");
    fl.feed(MCP_PROMPT_TEXT);
    await waitUntil(() => countEsc(fl) >= 1, 3000);
    fl.feed("\x1b[?2026h\x1b[?2026l"); // pure sync-frame markers
    fl.feed("\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\"); // OSC hyperlink frame
    fl.feed("3s"); // a tiny status/clock tick
    fl.feed(CLEAN_DISMISS_TEXT); // a FULL, substantial, signature-free repaint — would have released round 2's fix
    // Sampled over a real window (not a bare synchronous snapshot) — round 2's own evidence check ran
    // inside a DEFERRED verify callback, so a release that round 3 no longer performs would only show up
    // after that callback's delay, not instantly after feed().
    const neverReleasedByOutput = await assertNeverWithControl({
      label: "11a: no post-write screen output of any kind — including a full clean repaint — ever releases the hold",
      check: () => detectBlockingDialogSignature(collapseBoot(host.live.get(L)?.dialogStuckScan ?? "")) === null,
      windowMs: 300,
      positiveControl: () => sessionStartReleaseControl("11a"),
    });
    check("11a: every kind of post-write output — including a full clean repaint — never releases the hold", neverReleasedByOutput);
    check("11b: no second Esc was ever written either — there is nothing left to retry on", countEsc(fl) === 1);
    try { host.stop(L, "hard"); } catch { /* ignore */ }
  }

  // ============ 12) A SessionStart arriving after the Esc write RELEASES the hold AND DELIVERS a queued ==
  // ============      entry — the only release path that exists post round 3 ===============================
  {
    const M = "sess-sessionstart-after-esc-releases-M";
    const fm = spawnOne(M, "worker");
    const ENTRY = "queued entry behind the MCP dialog, released only by SessionStart";
    host.enqueueStdin(M, ENTRY, "system", undefined, undefined, "agent");
    fm.feed(MCP_PROMPT_TEXT);
    await waitUntil(() => countEsc(fm) >= 1, 3000); // the single Esc fires
    check("12a: still held right after the Esc write — SessionStart hasn't fired yet", !fm.writes.join("").includes(ENTRY));
    host.deliverHook(M, { hook_event_name: "SessionStart", session_id: "eng-M" });
    check("12b: SessionStart clears dialogStuckScan immediately, synchronously", host.live.get(M).dialogStuckScan === "");
    check("12c: the queued entry is delivered synchronously once SessionStart releases the hold (markReady's own drainPending)",
      fm.writes.join("").includes(ENTRY));
    try { host.stop(M, "hard"); } catch { /* ignore */ }
  }

  // ============ 13) round 3's own Minor fix: the single Esc fires for EVERY role, worker AND a role the ===
  // ============      alarm doesn't even arm for alike — the OLD retry loop was unintentionally NOT ========
  // ============      role-gated (only dialogStuckTimer/the hold itself are), so a non-driven role could ===
  // ============      get up to 3 Escs pre-fix; a single write is role-uniform by construction post-fix ====
  // ============      (card e2a3c613: "manager" now ALSO arms the alarm, so the still-ungated contrast =====
  // ============      role used here is "plain" (role:null) instead, to keep proving the Esc write is =====
  // ============      independent of whether the alarm armed at all) =========================================
  {
    const WR = "sess-exactly-one-esc-worker-WR";
    const MG = "sess-exactly-one-esc-plain-MG";
    const fwr = spawnOne(WR, "worker");
    const fmg = spawnOne(MG, null);
    check("13: (setup) a role-less (plain) spawn never arms dialogStuckTimer — the ALARM stays role-gated, unaffected by this fix",
      host.live.get(MG).dialogStuckTimer === null);
    fwr.feed(MCP_PROMPT_TEXT);
    fmg.feed(MCP_PROMPT_TEXT);
    const bothWrote = await waitUntil(() => countEsc(fwr) >= 1 && countEsc(fmg) >= 1, 3000);
    check("13a: both the worker AND the plain session receive the single Esc write (not role-gated)", bothWrote);
    check("13b: exactly one Esc for the worker role", countEsc(fwr) === 1);
    check("13c: exactly one Esc for the plain (ungated) role too — the round-3 fix (round 2's retry loop could reach 3 on a non-driven role, not main)", countEsc(fmg) === 1);
    try { host.stop(WR, "hard"); } catch { /* ignore */ }
    try { host.stop(MG, "hard"); } catch { /* ignore */ }
  }

  // ============ 14) migrated from round 1's own (d1): a same-id respawn DURING the deferred write's =====
  // ============      settle delay must never let the STALE generation receive the write, or the NEW ======
  // ============      generation be attributed one it was never fed (card 096231e8 identity) — the one ===
  // ============      race that survives the retry loop's removal, since the single write is still =======
  // ============      deferred by MCP_DISMISS_INITIAL_DELAY_MS ==============================================
  {
    const D1 = "sess-respawn-during-delay-D1";
    const fd1a = spawnOne(D1, "worker");
    fd1a.feed(MCP_PROMPT_TEXT); // schedules dismissMcpPrompt at MCP_DISMISS_INITIAL_DELAY_MS — not yet fired
    spawnOne(D1, "worker", "engine-D1-resume"); // respawn the SAME sessionId immediately — a fresh Live replaces it
    const fd1b = fakes.get(D1); // the NEW generation's own fake pty (spawnOne re-set the map entry for D1)
    const staleWindowMs = Number(process.env.LOOM_MCP_DISMISS_INITIAL_DELAY_MS) + 200;
    const noWriteOnStale = await assertNeverWithControl({
      label: "14a: the STALE generation's own pty never receives the deferred Esc write after being respawned away from",
      check: () => countEsc(fd1a) >= 1,
      windowMs: staleWindowMs,
      positiveControl: () => escWriteControl("14a"),
    });
    check("14a: the STALE generation never received the deferred Esc write", noWriteOnStale);
    const noWriteOnNew = await assertNeverWithControl({
      label: "14b: the NEW generation's pty receives no Esc write either (nothing fed it a dialog)",
      check: () => countEsc(fd1b) >= 1,
      windowMs: 300,
      positiveControl: () => escWriteControl("14b"),
    });
    check("14b: the NEW generation received no Esc write either", noWriteOnNew);
    try { host.stop(D1, "hard"); } catch { /* ignore */ }
  }

  // ============ 15) round 4 (delta Code Review 07a334ed, Minor 1): a SessionStart landing DURING the ======
  // ============      MCP_DISMISS_INITIAL_DELAY_MS wait — i.e. BEFORE the deferred Esc write ever fires — ===
  // ============      no longer suppresses that write. The OLD `isPastBoot` bail (round 3) would have left ==
  // ============      this session's own dialog completely unanswered: a single stray Esc landing at the ====
  // ============      now-past-boot main prompt is accepted as harmless so that a dialog that is ACTUALLY ===
  // ============      still open (the ordering the hold itself already trusts, per isBlockedOnUnresolvedBoot
  // ============      Dialog's own doc) never gets skipped. Session stays ALIVE throughout (never stopped) ==
  // ============      so the deferred callback's identity/liveness guards can't mask the isPastBoot removal =
  {
    const N = "sess-sessionstart-during-delay-still-escapes-N";
    const fn = spawnOne(N, "worker");
    fn.feed(MCP_PROMPT_TEXT); // schedules dismissMcpPrompt at +MCP_DISMISS_INITIAL_DELAY_MS — not yet fired
    check("15a: (setup) the deferred write has not fired yet", countEsc(fn) === 0);
    host.deliverHook(N, { hook_event_name: "SessionStart", session_id: "eng-N" }); // lands DURING the delay
    check("15b: (setup) SessionStart observed and the hold's own scan cleared — isPastBoot is true before the deferred write ever fires",
      host.live.get(N).sessionStartObserved === true && host.live.get(N).dialogStuckScan === "");
    const stillWrote = await waitUntil(() => countEsc(fn) >= 1, 3000);
    check("15c: the single Esc STILL fires even though SessionStart already landed — the isPastBoot bail is gone", stillWrote);
    check("15d: exactly one Esc — still no retry loop", countEsc(fn) === 1);
    try { host.stop(N, "hard"); } catch { /* ignore */ }
  }

  // ============ 16) Card b1da256d: onClaudeBootDialogResolved — on-time SessionStart of a fresh spawn ====
  // ============      fires exactly once; a SECOND hook on the SAME incarnation never refires it ===========
  {
    const O = "sess-resolved-ontime-O";
    spawnOne(O, "worker");
    check("16: (setup) no resolved event yet for a fresh spawn with no hook delivered", resolvedEvents.filter((e) => e.sessionId === O).length === 0);
    host.deliverHook(O, { hook_event_name: "SessionStart", session_id: "eng-O" });
    check("16a: an on-time SessionStart on a fresh spawn fires exactly one resolved event", resolvedEvents.filter((e) => e.sessionId === O).length === 1);
    host.deliverHook(O, { hook_event_name: "PreToolUse", session_id: "eng-O", tool_name: "mcp__loom-tasks__tasks_get" });
    check("16b: a SECOND hook on the same incarnation does not refire the resolved event", resolvedEvents.filter((e) => e.sessionId === O).length === 1);
    try { host.stop(O, "hard"); } catch { /* ignore */ }
  }

  // ============ 17) Card b1da256d: a LATE SessionStart arriving AFTER the stuck alarm already fired =======
  // ============      fires exactly one resolved event (this is round 3's own case, still covered) =========
  {
    const P = "sess-resolved-late-sessionstart-P";
    spawnOne(P, "worker");
    const stuckFiredP = await waitUntil(() => stuckEvents.some((e) => e.sessionId === P), 3000);
    check("17: (setup) the stuck alarm fired for P before any hook arrived", stuckFiredP);
    check("17: (setup) no resolved event yet", resolvedEvents.filter((e) => e.sessionId === P).length === 0);
    host.deliverHook(P, { hook_event_name: "SessionStart", session_id: "eng-P" });
    check("17a: a LATE SessionStart after the alarm fires exactly one resolved event", resolvedEvents.filter((e) => e.sessionId === P).length === 1);
    try { host.stop(P, "hard"); } catch { /* ignore */ }
  }

  // ============ 18) Card b1da256d round 2 (item 1): a re-spawn (resume) of the SAME session id, AFTER ====
  // ============      incarnation 1 has ALREADY fired its OWN resolved event — the respawn itself fires ===
  // ============      nothing (fresh Live, no hook yet), but the FIRST hook on the NEW incarnation fires ===
  // ============      a SECOND, independent resolved event (count 1 → 2): per-incarnation, never globally
  // ============      suppressed-forever by the OLD incarnation's prior fire. Round 1's own version of =====
  // ============      this scenario never delivered ANY hook on incarnation 1 — so a once-per-sessionId ===
  // ============      Set (fire at most once EVER for a given session id, instead of once per Live ========
  // ============      incarnation) would have passed it too, since that Set would never have been =========
  // ============      populated in the first place. This version is the one that can actually tell the ====
  // ============      two designs apart — see this file's own RED-BEFORE-GREEN note above the import ======
  // ============      block for the proof against a temporary once-per-sessionId Set. ========================
  {
    const Q = "sess-resolved-respawn-Q";
    spawnOne(Q, "worker");
    const stuckFiredQ = await waitUntil(() => stuckEvents.some((e) => e.sessionId === Q), 3000);
    check("18: (setup) the stuck alarm fired for Q", stuckFiredQ);
    host.deliverHook(Q, { hook_event_name: "SessionStart", session_id: "eng-Q-1" });
    check("18a: incarnation 1's own first hook fires exactly one resolved event", resolvedEvents.filter((e) => e.sessionId === Q).length === 1);
    spawnOne(Q, "worker", "eng-Q-resume"); // resume: fresh Live, anyHookObserved reset to false
    check("18b: the respawn itself (fresh Live, no hook yet) fires no ADDITIONAL resolved event (still exactly one)", resolvedEvents.filter((e) => e.sessionId === Q).length === 1);
    host.deliverHook(Q, { hook_event_name: "SessionStart", session_id: "eng-Q-2" });
    check("18c: the first hook on the NEW incarnation fires a SECOND, independent resolved event (count 1 → 2) — a once-per-sessionId Set would have failed this", resolvedEvents.filter((e) => e.sessionId === Q).length === 2);
    try { host.stop(Q, "hard"); } catch { /* ignore */ }
  }

  // ============ 19) Card b1da256d — THE ROUND-4 GAP ITSELF: a non-SessionStart first hook (e.g. ===========
  // ============      PreToolUse) arriving after the alarm, with SessionStart NEVER arriving at all, ========
  // ============      still fires exactly one resolved event. A SessionStart-only design (round 3's own, =====
  // ============      cut at e2a3c613 round 4) can NEVER fire here — see this file's own RED-BEFORE-GREEN ===
  // ============      note above the import block for how that was proven directly against this scenario. ==
  {
    const R = "sess-resolved-non-sessionstart-first-R";
    spawnOne(R, "worker");
    const stuckFiredR = await waitUntil(() => stuckEvents.some((e) => e.sessionId === R), 3000);
    check("19: (setup) the stuck alarm fired for R, SessionStart never observed", stuckFiredR && host.live.get(R).sessionStartObserved === false);
    host.deliverHook(R, { hook_event_name: "PreToolUse", session_id: "eng-R", tool_name: "mcp__loom-tasks__tasks_get" }); // NOT SessionStart
    check("19a: a non-SessionStart first hook after the alarm fires exactly one resolved event — the round-4 gap a SessionStart-only design could never close",
      resolvedEvents.filter((e) => e.sessionId === R).length === 1);
    host.deliverHook(R, { hook_event_name: "SessionStart", session_id: "eng-R" }); // a later SessionStart must not refire
    check("19b: a later SessionStart on the same incarnation does not refire", resolvedEvents.filter((e) => e.sessionId === R).length === 1);
    try { host.stop(R, "hard"); } catch { /* ignore */ }
  }
} finally {
  for (const id of [
    "sess-dialog-stuck-A", "sess-slow-healthy-B", "sess-late-sessionstart-C", "sess-manager-gated-D",
    "sess-platform-gated-D2", "sess-plain-not-gated-E", "sess-resume-rearms-F", "sess-overwrite-resume-G",
    "sess-dies-before-sessionstart-H", "sess-first-turn-started-no-sessionstart-I",
    "sess-any-hook-observed-no-sessionstart-J", "sess-mcp-prompt-single-chunk-K",
    "sess-post-write-noise-still-held-L", "sess-sessionstart-after-esc-releases-M",
    "sess-exactly-one-esc-worker-WR", "sess-exactly-one-esc-plain-MG", "sess-respawn-during-delay-D1",
    "sess-sessionstart-during-delay-still-escapes-N",
    "sess-resolved-ontime-O", "sess-resolved-late-sessionstart-P", "sess-resolved-respawn-Q",
    "sess-resolved-non-sessionstart-first-R",
  ]) {
    try { host.stop(id, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — claude boot-dialog-stuck detector fires once (named signature, no screen content) for an unattended spawn that never reaches SessionStart; never fires for a slow-but-healthy boot or a late SessionStart after the alarm; role-gated to LOOM_DRIVEN_ROLES; re-arms on resume; the overwrite-on-resume and onExit timer clears hold under real timing; the fire-time bail suppresses the alarm whenever firstTurnStarted or any other hook proves the engine is past boot; and (card e29923e3 round 3 scope cut) the MCP-prompt Esc-dismiss is a single write, never a retry loop — the hold stays engaged forever past a dropped/lone Esc on a static dialog, no post-write screen output of any kind (sync frames, OSC, ticks, or even a full clean repaint) ever releases it, only a real SessionStart releases AND delivers a queued entry, the single write fires uniformly for every role (not just LOOM_DRIVEN_ROLES), a same-id respawn during the write's own settle delay never misattributes it across generations, and (round 4) a SessionStart landing DURING the deferred delay no longer suppresses the single Esc write; (card b1da256d) and onClaudeBootDialogResolved fires exactly once per Live incarnation on the first hook of any kind — an on-time or late SessionStart, a re-spawn's own fresh first hook, and (the round-4 gap itself) a non-SessionStart first hook with SessionStart never observed at all — never twice for the same incarnation."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
