import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0050a17e DoD #5 (Code Review MAJOR finding) — the READINESS-FALLBACK path (READY_FALLBACK_MS →
// markReady, when the real `SessionStart` hook is missed entirely) had ZERO delivery coverage: every
// scenario in worker-kickoff-guarantee.mjs pins `LOOM_READY_FALLBACK_MS = 5000` specifically so it "never
// fires" within that suite's own windows, since that file is about the SessionStart-driven path. That
// left the OTHER path into markReady — a missed SessionStart hook, recovered only by the fallback timer —
// completely unproven for kickoff delivery: markReady itself doesn't care WHICH caller reached it, but
// nothing had ever actually exercised the fallback caller reaching scheduleKickoffGuarantee.
//
// This file proves: a fresh spawn whose SessionStart hook is NEVER delivered (fully missed, not just
// delayed) still gets its kickoff delivered — via READY_FALLBACK_MS firing → markReady → (after
// logLandedMode's gate settles) → scheduleKickoffGuarantee — exactly once, with the same give-up/requeue
// protection (task 15/this same card) as the SessionStart-driven path.
//
// Card 850eb55c, scenario (3): the OTHER way READY_FALLBACK can fire without SessionStart — a session
// genuinely STUCK on a blocking boot dialog (card 01160ae3), not merely slow. Proves neither
// scheduleKickoffGuarantee's direct submit() NOR drainPending's queued-entry path ever writes into that
// dialog, for a BOOT_DIALOG_DETECTOR_ROLES session, for as long as the dialog signature is on screen —
// and that delivery proceeds normally, exactly once, the instant SessionStart actually resolves it. Two
// controls: the SAME role with no dialog (unchanged), and (card e2a3c613 round 2, (3c2)) a role genuinely
// OUTSIDE BOOT_DIALOG_DETECTOR_ROLES with the SAME dialog on screen — the control this file used to run
// against "manager" pre-e2a3c613, restored against "plain" (role:null) now that manager is in scope.
// Card e2a3c613 (3d)-(3g): a manager (and, by the same role set, platform/Lead) is now ALSO held by this
// gate — not the "unchanged, out of scope" control this file asserted pre-e2a3c613 — including via a
// RESUME spawn, never just a fresh one.
//
// Card 850eb55c, scenario (4) (round 2, item 1): a Code Review finding on scenario (3) itself — the hold
// had no STRUCTURAL release. Once `ready` is latched by the fallback, a late SessionStart's own
// `cycleToMode(…, () => this.markReady(sessionId))` used to hit markReady's own once-only guard and
// silently no-op, leaving `reconcile()`'s periodic tick as the ONLY thing that ever drained the held
// kickoff — slow, and racy against the cycle's own still-converging Shift+Tabs. This scenario reaches the
// SAME dialog-held starting point as (3), but with a REAL mode cycle (startupModeCycles > 0) on the far
// side of SessionStart, and proves delivery now happens directly off the cycle's own onDone — promptly,
// strictly after the last Shift+Tab — with `host.reconcile()` never called anywhere in the scenario.
//
// Card e29923e3, scenario (5): the MCP-dialog variant of (3) — the SAME readiness-fallback + reconcile()
// hold, but behind the MCP-enable dialog (dismissMcpPrompt's single deferred Esc) instead of the
// external-imports dialog. Proves the Esc write alone never releases the hold across several reconcile()
// ticks, and delivery proceeds exactly once SessionStart actually resolves the dialog.
//
// HERMETIC, claude-free — a fake pty (mirrors worker-kickoff-guarantee.mjs).
//
// RUN: pnpm build (from packages/daemon) then `node test/kickoff-readiness-fallback.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";
import { observeOnce, assertNeverWithControl } from "./_timing-guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-readiness-fallback-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// The two timers this scenario actually needs FAST and DETERMINISTIC — both small, both real for this file
// (unlike worker-kickoff-guarantee.mjs, which deliberately pins READY_FALLBACK_MS long so it never fires).
process.env.LOOM_READY_FALLBACK_MS = "30";
process.env.LOOM_MODE_LOG_POLL_MS = "5";
// Pinned (not left at the 900ms default) so the two negative-window constants below (200ms) have an
// EXPLICIT, measured margin under it — sendEnterAndVerify's give-up/reassert-paste retry (host.ts) also
// writes a bracket-paste marker, so a window that ever reached this timeout could misread an unrelated
// retry as a repeated kickoff delivery. See NO_REPEAT_WINDOW_MS's own comment below.
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "5000";
// Card 850eb55c, scenario (3) only: a kickoff held behind a stuck dialog never goes through submit() at
// all (by design — see isBlockedOnUnresolvedBootDialog's own doc), so unlike every other scenario in this
// file, nothing ever clears `live.busy` for it except healIfStuck's short pre-first-turn stale window
// (FIRST_TURN_STALE_MS) — the periodic reconcile() backstop drainPending's own doc names. Pinned short
// (comfortably above READY_FALLBACK_MS=30 above) so (3)'s post-SessionStart delivery doesn't need to wait
// out the real 30s production default.
process.env.LOOM_FIRST_TURN_STALE_MS = "100";
// Card e29923e3, scenario (5) only: the MCP-dialog variant needs its deferred single-Esc write to fire
// well inside this file's own short timeouts — mirrors claude-boot-dialog-stuck.mjs's own pin.
process.env.LOOM_MCP_DISMISS_INITIAL_DELAY_MS = "20";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const PASTE_START = "\x1b[200~";
// Card 850eb55c (round 2, item 1): footer-cycling constants, mirrors pty-ready-fallback-race.mjs's own
// (the SAME real cycleToMode primitive, just reached via a different trigger — a LATE SessionStart arriving
// after READY_FALLBACK already latched `ready`, instead of a tight spawn-vs-SessionStart timing race).
const SHIFT_TAB = "\x1b[Z";
const ACCEPT_EDITS_FOOTER = "accept edits on (shift+tab to cycle)";
const PLAN_FOOTER = "plan mode on (shift+tab to cycle)";
const AUTO_FOOTER = "auto mode on (shift+tab to cycle)";
// Card 850eb55c, scenario (3)/(4): a recognized blocking-dialog signature (external-imports) — hoisted to
// module scope since (4) (round 2) needs the SAME text (3) already uses, in a separate block.
const DIALOG_TEXT = "Allow external CLAUDE.md file imports?\n❯ No, disable external imports\n  Yes, allow external imports\nEnter to confirm · Esc to cancel";
// Card e29923e3, scenario (5): the MCP-enable-prompt signature — same text claude-boot-dialog-stuck.mjs
// uses — and the ESC key its single deferred dismiss write (dismissMcpPrompt) sends.
const MCP_PROMPT_TEXT = "2 new MCP servers found\n❯ Enable\n  Reject all";
const ESC_KEY = "\x1b";

const fakes = [];
// Extends the shared seam (tracked onExit callback, a real kill()) rather than a local fake — see
// _seam-host-fixture.mjs's own doc for why a locally-discarded onExit is a real defect class (card
// c54d1ea0), not just a style nit. Adds write-capture on top, same pattern pty-restart-nudge-atomicity.mjs
// already uses. Card 850eb55c: ALSO captures onData → feed() (mirrors claude-boot-dialog-stuck.mjs /
// worker-kickoff-guarantee.mjs's own combined fixture), so scenario (3) can simulate a dialog screen.
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
const countShiftTabs = (fake) => fake.writes.filter((w) => w === SHIFT_TAB).length;
const countEsc = (fake) => fake.writes.filter((w) => w === ESC_KEY).length;

// windowMs shared by every negative check below — derived from the pinned LOOM_SUBMIT_VERIFY_TIMEOUT_MS
// (5000ms) above: comfortably (25x) under it, so sendEnterAndVerify's give-up/reassert-paste retry can
// never fire inside the window and be mistaken for a repeated/unexpected kickoff delivery. Also comfortably
// over READY_FALLBACK_MS(30) + logLandedMode's gate(≤40ms), the other timers actually in play here.
const NEGATIVE_WINDOW_MS = 200;

// Spawn a throwaway control session on the SAME fallback path (no SessionStart ever delivered — only
// READY_FALLBACK_MS marks it ready) and wait for its own real kickoff delivery — used by every
// positiveControl below to prove countIn(...)'s PASTE_START check can actually catch a real delivery,
// via the identical write path scheduleKickoffGuarantee itself uses (not a hand-written fake write).
let controlSeq = 0;
async function spawnControlDelivery(label) {
  const id = `control-${controlSeq++}-${label.replace(/[^a-z0-9]+/gi, "-")}`;
  host.spawn({
    sessionId: id, cwd: tmpHome, startupPrompt: `control kickoff (${label})`,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake = fakes[fakes.length - 1];
  await waitUntil(() => countIn(fake, PASTE_START) === 1, { label: `${label}: control kickoff delivered once via the fallback`, timeoutMs: 5000 });
  return { id, fake };
}

try {
  // ============ (1) SessionStart is NEVER delivered — READY_FALLBACK_MS is the ONLY path to ready =========
  {
    const A = "fallback-A";
    const KICKOFF = "orchestrate task via the readiness fallback — no SessionStart ever fires";
    host.spawn({
      sessionId: A, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fa = fakes[fakes.length - 1];
    // Deliberately NEVER call host.deliverHook(A, {hook_event_name:"SessionStart"}) — the fallback timer
    // (READY_FALLBACK_MS, 30ms) is the ONLY thing that can ever mark this session ready.
    check("(1) not ready yet, nothing delivered, immediately after spawn", countIn(fa, PASTE_START) === 0);
    await waitUntil(() => countIn(fa, PASTE_START) === 1, { label: "(1) kickoff delivered via the readiness fallback (no SessionStart ever fired)", timeoutMs: 5000 });
    check("(1) the kickoff was delivered exactly once via the fallback path", countIn(fa, PASTE_START) === 1);
    check("(1) the delivered text is the ORIGINAL kickoff", writtenOf(fa).includes(KICKOFF));
    check("(1) busy was (re)armed true by the delivery", busyById[A]?.[busyById[A].length - 1] === true);
    // Card a7732d7d audit of this site: PROVEN SAFE BY CONSTRUCTION, not injection-dependent. `check()`
    // watches countIn(fa, PASTE_START), and the SECOND write it would see is produced by the positiveControl's
    // own `host.enqueueStdin(id, ...)` call below — which, once `Stop` has cleared `busy` (confirmed live:
    // `[busy] ... -> false (stop-hook) afterMs=0` immediately followed by `[submit-write] ... reason=immediate`
    // in the SAME log tick), takes enqueueStdin's IMMEDIATE branch (host.ts:7436) and calls `submit()`
    // (host.ts:8570) SYNCHRONOUSLY — which in turn calls `writeNewTurn()` (host.ts:8703) SYNCHRONOUSLY, whose
    // very first statement is `this.ptyWrite(sessionId, l, BRACKET_PASTE_START, ...)` (host.ts:8714). No
    // setTimeout sits anywhere on this path: the write lands in the SAME synchronous call stack as
    // `host.enqueueStdin(...)` returning, so `observeOnce`'s first poll (before any `await wait(intervalMs)`)
    // already observes it — NEGATIVE_WINDOW_MS has nothing to race here. Injection-verified: uniform
    // global.setTimeout scaling to 50x (69 production timers intercepted) left the outcome unchanged; scaling
    // to 500x only broke the UNRELATED line-105 waitUntil(timeoutMs:5000) for the FIRST delivery — not a
    // windowMs site — confirming this site's margin is untouched even as unrelated timers strain. A targeted
    // adversarial probe against the shared _timing-guard.mjs mechanism itself (delaying a positiveControl's own
    // flip past its windowMs) DID throw once the delay passed ~200-250ms, proving the injection method is
    // non-vacuous — it would have caught this site had it actually depended on a delayable timer.
    const noRepeat1 = await assertNeverWithControl({
      label: "(1) still exactly ONE delivery (no repeat firing)",
      check: () => countIn(fa, PASTE_START) >= 2,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        // Arm a REAL second delivery on a throwaway control session — its own real fallback delivery,
        // then a legitimate end-of-turn (UserPromptSubmit+Stop, same shape worker-kickoff-guarantee.mjs
        // uses to finish a turn) + enqueueStdin to force a genuine second submit() — proving the >=2
        // check can actually catch a repeat via the SAME real write path scheduleKickoffGuarantee uses.
        const { id, fake } = await spawnControlDelivery("(1) repeat-check positive control");
        host.deliverHook(id, { hook_event_name: "UserPromptSubmit" });
        host.deliverHook(id, { hook_event_name: "Stop" }); // end that turn — clears busy
        host.enqueueStdin(id, "control forced second delivery", "system", undefined, undefined, "agent");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 2, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(1) still exactly ONE delivery (no repeat firing)", noRepeat1);
    try { host.stop(A, "hard"); } catch { /* ignore */ }
  }

  // ============ (2) resume/fork are STILL no-ops via the fallback path (no startupPrompt → nothing to =====
  // ============ deliver, exactly like the SessionStart-driven path — the fallback calls the SAME =========
  // ============ markReady, so this guards against a future divergence between the two callers) ===========
  {
    const B = "fallback-B";
    host.spawn({
      sessionId: B, cwd: tmpHome, resumeId: "engine-B", // resume: no startupPrompt passed
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fb = fakes[fakes.length - 1];
    // Card a7732d7d audit of this site: PROVEN SAFE BY CONSTRUCTION, same reasoning as (1) above, and even
    // more directly so. The positiveControl's `spawnControlDelivery` already `await`s a `waitUntil(...)` that
    // only resolves once `countIn(fake, PASTE_START) === 1` (line ~87) — BEFORE the `observeOnce({ ...,
    // windowMs: NEGATIVE_WINDOW_MS })` below even starts. So by the time that observeOnce runs, the condition
    // it polls (`>= 1`) is ALREADY true; its first synchronous check succeeds before any `await wait(...)`.
    // NEGATIVE_WINDOW_MS is not raced by any timer on this path at all. Same injection evidence as (1): uniform
    // setTimeout scaling to 50x unchanged; the shared _timing-guard.mjs mechanism itself was independently
    // shown capable of throwing under a targeted delay past ~200-250ms, proving the technique is non-vacuous.
    const neverDelivered2 = await assertNeverWithControl({
      label: "(2) resume path via the fallback: NEVER delivers (no kickoff was ever passed)",
      check: () => countIn(fb, PASTE_START) >= 1,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        // Prove the >=1 check can catch a real delivery — a control session spawned WITH a startupPrompt
        // (unlike B) really does get one, via the identical fallback path and identical check+window shape.
        const { id, fake } = await spawnControlDelivery("(2) no-delivery positive control");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 1, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(2) resume path via the fallback: NEVER delivers (no kickoff was ever passed)", neverDelivered2);
    try { host.stop(B, "hard"); } catch { /* ignore */ }
  }

  // ============ (3) Card 850eb55c: a LOOM_DRIVEN-role session stuck on a recognized boot dialog pre- =====
  // ============     SessionStart HOLDS delivery (never drops it), on BOTH the scheduleKickoffGuarantee ===
  // ============     direct-submit path (3a/3b, session C) AND drainPending's own queued-entry path =======
  // ============     (3a'/3b', session F, isolated with NO startupPrompt so it can't also exercise C's =====
  // ============     path) — and delivers normally, exactly once, the moment SessionStart actually =========
  // ============     resolves the dialog. Two controls: (3c) same role, no dialog — unchanged; (3d) same ===
  // ============     dialog, a role the detector does not watch — unchanged (the INTENDED scope: this =====
  // ============     gate, like card 01160ae3's detector, is scoped to LOOM_DRIVEN_ROLES only — a human- ===
  // ============     driven manager's own boot is a NOTIFICATION-recipient concern (card 850eb55c item =====
  // ============     2, sessions/service.ts), not a kickoff-delivery subject). =============================
  {
    // ---- (3a)/(3b): scheduleKickoffGuarantee's own direct-submit path, gated -------------------------
    const C = "fallback-C-dialog-stuck";
    const KICKOFF3 = "orchestrate task via the readiness fallback — stuck behind a blocking CLI dialog";
    host.spawn({
      sessionId: C, cwd: tmpHome, startupPrompt: KICKOFF3, role: "worker",
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.markMcpSeen(C); // "worker" mounts loom-orchestration MCP (usesOrchestrationMcp) — scheduleKickoffGuarantee gates its own proceed() on waitForMcpSeen; resolve it instantly rather than waiting out MCP_READY_TIMEOUT_MS
    const fc = fakes[fakes.length - 1];
    fc.feed(DIALOG_TEXT); // the boot scan now shows a recognized blocking-dialog signature, BEFORE ready

    await waitUntil(() => host.hasReachedReady(C), { label: "(3a) READY_FALLBACK_MS still marks the session ready despite the dialog", timeoutMs: 5000 });
    const noWriteC = await assertNeverWithControl({
      label: "(3a) nothing written to the pty while stuck pre-SessionStart on a recognized dialog",
      check: () => countIn(fc, PASTE_START) >= 1,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        const { id, fake } = await spawnControlDelivery("(3a) dialog-stuck positive control");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 1, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(3a) ready, but NOTHING written for the kickoff while stuck on the dialog (scheduleKickoffGuarantee's direct submit is held)", noWriteC);

    host.deliverHook(C, { hook_event_name: "SessionStart", session_id: "eng-C" }); // the dialog resolves
    // Nothing auto-redrains this: scheduleKickoffGuarantee's own gated branch routed the kickoff through
    // enqueueStdin, whose own immediate-submit gate also required `!live.busy` — and `live.busy` has been
    // true since spawn (the optimistic startupPrompt set) with NO submit() ever run to clear it via the
    // usual Stop/give-up paths. The ONLY thing that clears it here is healIfStuck's short pre-first-turn
    // stale window, fired by the periodic reconcile() tick — simulated by polling it directly below
    // (a real production tick, not a fixed sleep: this stops the INSTANT delivery is observed).
    await waitUntil(() => { host.reconcile(); return countIn(fc, PASTE_START) >= 1; },
      { label: "(3b) delivery proceeds once SessionStart resolves the dialog (via the reconcile() backstop)", timeoutMs: 3000 });
    check("(3b) exactly ONE kickoff delivery once SessionStart resolves the dialog", countIn(fc, PASTE_START) === 1);
    check("(3b) the delivered text is the ORIGINAL kickoff", writtenOf(fc).includes(KICKOFF3));
    try { host.stop(C, "hard"); } catch { /* ignore */ }

    // ---- (3a')/(3b'): drainPending's OWN queued-entry path, gated — isolated from scheduleKickoffGuarantee
    // ---- entirely (no startupPrompt ⇒ kickoff stays null ⇒ scheduleKickoffGuarantee never even runs; and
    // ---- live.busy is never optimistically set, so delivery here needs no heal-cycle wait at all) --------
    const F = "fallback-F-dialog-stuck-drain";
    host.spawn({
      sessionId: F, cwd: tmpHome, role: "worker",
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const ff = fakes[fakes.length - 1];
    ff.feed(DIALOG_TEXT);
    const QUEUED_ENTRY = "a queued nudge sitting behind the same stuck dialog";
    host.enqueueStdin(F, QUEUED_ENTRY, "system", undefined, undefined, "agent"); // pre-ready ⇒ lands in live.pending via enqueueStdin's own held branch

    await waitUntil(() => host.hasReachedReady(F), { label: "(3a') READY_FALLBACK_MS still marks the session ready despite the dialog", timeoutMs: 5000 });
    const noWriteF = await assertNeverWithControl({
      label: "(3a') drainPending itself never delivers a queued entry while stuck on the dialog",
      check: () => countIn(ff, PASTE_START) >= 1,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        const { id, fake } = await spawnControlDelivery("(3a') dialog-stuck drain positive control");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 1, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(3a') ready, but the queued entry is NEVER drained while stuck on the dialog (drainPending's own queued path is held)", noWriteF);
    check("(3a') the queued entry's text never landed either", !writtenOf(ff).includes(QUEUED_ENTRY));

    host.deliverHook(F, { hook_event_name: "SessionStart", session_id: "eng-F" }); // the dialog resolves
    host.reconcile(); // the production periodic backstop — live.busy was never set here, so one tick suffices
    await waitUntil(() => countIn(ff, PASTE_START) >= 1, { label: "(3b') the queued entry delivers once SessionStart resolves the dialog", timeoutMs: 3000 });
    check("(3b') exactly ONE delivery of the queued entry once SessionStart resolves the dialog", countIn(ff, PASTE_START) === 1);
    check("(3b') the delivered text is the ORIGINAL queued entry", writtenOf(ff).includes(QUEUED_ENTRY));
    try { host.stop(F, "hard"); } catch { /* ignore */ }

    // ---- (3c) control: SAME role, NO dialog signature — the fallback still delivers exactly like (1) ----
    const D = "fallback-D-no-dialog-control";
    const KICKOFF3C = "orchestrate task via the readiness fallback — same role, no dialog this time";
    host.spawn({
      sessionId: D, cwd: tmpHome, startupPrompt: KICKOFF3C, role: "worker",
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.markMcpSeen(D);
    const fd = fakes[fakes.length - 1];
    // Deliberately no fd.feed() call — nothing resembling a dialog is ever shown.
    await waitUntil(() => countIn(fd, PASTE_START) === 1, { label: "(3c) control: same LOOM_DRIVEN role, no dialog — delivers via the fallback unchanged", timeoutMs: 5000 });
    check("(3c) control: a LOOM_DRIVEN role with NO dialog signature still gets its kickoff delivered via the fallback", countIn(fd, PASTE_START) === 1);
    check("(3c) control: the delivered text is the ORIGINAL kickoff", writtenOf(fd).includes(KICKOFF3C));
    try { host.stop(D, "hard"); } catch { /* ignore */ }

    // ---- (3c2) card e2a3c613 round 2: RESTORED role-scope negative control — the SAME dialog, but a role -
    // ---- genuinely OUTSIDE BOOT_DIALOG_DETECTOR_ROLES (role:null, "plain"). Round 1 widened the gate to --
    // ---- cover manager/platform and repurposed the OLD (3d) control (which used role:"manager") into an -
    // ---- in-scope POSITIVE case, leaving no test proving an out-of-scope role is still NOT held at all. --
    const D2 = "fallback-D2-plain-role-control";
    const KICKOFF3C2 = "plain-role kickoff via the readiness fallback — same dialog, role out of scope";
    host.spawn({
      sessionId: D2, cwd: tmpHome, startupPrompt: KICKOFF3C2, role: null,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fd2 = fakes[fakes.length - 1];
    fd2.feed(DIALOG_TEXT); // the SAME dialog signature — but "plain" (role:null) is not in BOOT_DIALOG_DETECTOR_ROLES
    await waitUntil(() => countIn(fd2, PASTE_START) === 1, { label: "(3c2) control: an out-of-scope role delivers via the fallback unchanged, even with the dialog on screen", timeoutMs: 5000 });
    check("(3c2) control: a role OUTSIDE BOOT_DIALOG_DETECTOR_ROLES is NOT held by isBlockedOnUnresolvedBootDialog — same dialog, unchanged", countIn(fd2, PASTE_START) === 1);
    check("(3c2) control: the delivered text is the ORIGINAL kickoff", writtenOf(fd2).includes(KICKOFF3C2));
    try { host.stop(D2, "hard"); } catch { /* ignore */ }

    // ---- (3d)/(3e) card e2a3c613: manager (and platform/Lead) are NOW held by this gate too — SAME ------
    // ---- shape as (3a)/(3b), not "unchanged" the way this control used to assert pre-e2a3c613. ----------
    // ---- BOOT_DIALOG_DETECTOR_ROLES (pty/host.ts) now covers manager/platform for BOTH the detector's ---
    // ---- own arm check AND isBlockedOnUnresolvedBootDialog — deliberately a SEPARATE constant from ------
    // ---- LOOM_DRIVEN_ROLES (never widened — see that constant's own doc), so disallowedToolsForRole is --
    // ---- untouched (pinned in claude-boot-dialog-stuck.mjs). card 850eb55c item 2's PARENT-NOTIFICATION -
    // ---- mechanism (handleClaudeBootDialogStuck) is unrelated and unaffected either way. ----------------
    const E = "fallback-E-manager-role-now-held";
    const KICKOFF3D = "manager kickoff via the readiness fallback — stuck behind the same blocking dialog";
    host.spawn({
      sessionId: E, cwd: tmpHome, startupPrompt: KICKOFF3D, role: "manager",
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.markMcpSeen(E); // "manager" also mounts loom-orchestration MCP (usesOrchestrationMcp)
    const fe = fakes[fakes.length - 1];
    fe.feed(DIALOG_TEXT); // card e2a3c613: manager is now in BOOT_DIALOG_DETECTOR_ROLES too

    await waitUntil(() => host.hasReachedReady(E), { label: "(3d) READY_FALLBACK_MS still marks the manager ready despite the dialog", timeoutMs: 5000 });
    const noWriteE = await assertNeverWithControl({
      label: "(3d) nothing written to a MANAGER's pty while stuck pre-SessionStart on a recognized dialog (card e2a3c613)",
      check: () => countIn(fe, PASTE_START) >= 1,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        const { id, fake } = await spawnControlDelivery("(3d) manager dialog-stuck positive control");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 1, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(3d) ready, but NOTHING written for a MANAGER's kickoff while stuck on the dialog (card e2a3c613 extends the hold to manager/platform)", noWriteE);

    host.deliverHook(E, { hook_event_name: "SessionStart", session_id: "eng-E" }); // the dialog resolves
    await waitUntil(() => { host.reconcile(); return countIn(fe, PASTE_START) >= 1; },
      { label: "(3e) delivery proceeds once SessionStart resolves the dialog, for a manager too", timeoutMs: 3000 });
    check("(3e) exactly ONE kickoff delivery once SessionStart resolves the dialog (manager)", countIn(fe, PASTE_START) === 1);
    check("(3e) the delivered text is the ORIGINAL kickoff (manager)", writtenOf(fe).includes(KICKOFF3D));
    try { host.stop(E, "hard"); } catch { /* ignore */ }

    // ---- (3f)/(3g) card e2a3c613 condition 2: a RESUMED manager also reaches isPastBoot normally — ------
    // ---- createPty resets sessionStartObserved/dialogStuckScan on EVERY spawn call (fresh/resume/fork/ --
    // ---- recycle alike), so a resumed engine's own fresh SessionStart hook releases the hold + drains ---
    // ---- a queued continuation note exactly like a fresh spawn — no special-casing needed for resume. --
    const F2 = "fallback-F2-manager-resume-dialog-stuck";
    host.spawn({
      sessionId: F2, cwd: tmpHome, resumeId: "engine-F2-prior", role: "manager", // RESUME, not fresh — no startupPrompt
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const ff2 = fakes[fakes.length - 1];
    ff2.feed(DIALOG_TEXT);
    const QUEUED_ENTRY_F2 = "a continuation note sitting behind the same dialog, after a manager resume";
    host.enqueueStdin(F2, QUEUED_ENTRY_F2, "system", undefined, undefined, "agent");

    await waitUntil(() => host.hasReachedReady(F2), { label: "(3f) READY_FALLBACK_MS still marks the RESUMED manager ready despite the dialog", timeoutMs: 5000 });
    const noWriteF2 = await assertNeverWithControl({
      label: "(3f) a RESUMED manager: the queued continuation note is never drained while stuck on the dialog",
      check: () => countIn(ff2, PASTE_START) >= 1,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        const { id, fake } = await spawnControlDelivery("(3f) manager-resume dialog-stuck drain positive control");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 1, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(3f) ready, but the queued continuation note is NEVER drained while a RESUMED manager is stuck on the dialog", noWriteF2);

    host.deliverHook(F2, { hook_event_name: "SessionStart", session_id: "eng-F2-new" }); // the RESUMED engine's own fresh SessionStart
    check("(3g) a fresh SessionStart on RESUME reaches isPastBoot the same way a fresh spawn's does (sessionStartObserved flips true, dialogStuckScan clears)",
      host.live.get(F2).sessionStartObserved === true && host.live.get(F2).dialogStuckScan === "");
    host.reconcile();
    await waitUntil(() => countIn(ff2, PASTE_START) >= 1, { label: "(3g) delivery proceeds once the RESUMED manager's own SessionStart resolves the dialog", timeoutMs: 3000 });
    check("(3g) exactly ONE delivery of the queued continuation note once SessionStart resolves the dialog (manager resume)", countIn(ff2, PASTE_START) === 1);
    check("(3g) the delivered text is the ORIGINAL queued continuation note", writtenOf(ff2).includes(QUEUED_ENTRY_F2));
    try { host.stop(F2, "hard"); } catch { /* ignore */ }
  }

  // ============ (4) Card 850eb55c round 2 (item 1): READY_FALLBACK_MS latches `ready` FIRST (behind a =====
  // ============     dialog hold — deterministic, same mechanism as (3)), THEN a LATE SessionStart arrives ==
  // ============     and drives a REAL boot mode-cycle (startupModeCycles > 0, unlike (3)'s 0). Proves the ==
  // ============     structural release fixed in this round: the kickoff is held through the WHOLE cycle ===
  // ============     (never raced in mid-settle/mid-Shift+Tab) and then delivered directly from the =========
  // ============     cycle's own onDone (`releaseBootModeCycle`) — NEVER via `host.reconcile()`, which this =
  // ============     scenario deliberately never calls even once (the daemon's own periodic reconcile() is ==
  // ============     wired in index.ts, not PtyHost's constructor, so nothing else can drain it either). ====
  // ============     RED on f53be62e (round 3, item 3 — corrected): pre-round-2, the LATE SessionStart's ===
  // ============     own `cycleToMode(…, () => this.markReady(sessionId))` DOES hit markReady's `live.ready`=
  // ============     guard and silently no-op once its cycle finishes — but that is NOT why this scenario ===
  // ============     goes red. The ORIGINAL scheduleKickoffGuarantee call, armed by the EARLIER markReady ===
  // ============     that READY_FALLBACK_MS itself triggered, is a SEPARATE, already-in-flight setTimeout ===
  // ============     chain (its own logLandedMode poll-and-settle). By the time THAT chain's `proceed()` ====
  // ============     finally runs, SessionStart has already set `sessionStartObserved`, so ==================
  // ============     `isBlockedOnUnresolvedBootDialog` already reads false — and, with no =====================
  // ============     `startupCycleInFlight` gate existing pre-round-2, nothing else holds it: it falls =======
  // ============     straight through to a DIRECT submit(), landing the kickoff MID-CYCLE, before the ========
  // ============     cycle's own first Shift+Tab. So 4b/4c/4d/4f (nothing written during the cycle / before =
  // ============     each Shift+Tab / ordering strictly after the last one) are RED on this PREMATURE =========
  // ============     delivery — 4e ("delivered exactly once, promptly") still PASSES on old code, since the ==
  // ============     kickoff genuinely IS delivered, just too early — exactly the hazard `startupCycleInFlight`
  // ============     (this round's own guard) closes. =============================================================
  {
    const G = "fallback-G-dialog-stuck-mode-cycle";
    const KICKOFF4 = "orchestrate task via the readiness fallback — dialog-held, then a real mode cycle";
    host.spawn({
      sessionId: G, cwd: tmpHome, startupPrompt: KICKOFF4, role: "worker",
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 2 }, // → target "auto"
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.markMcpSeen(G); // "worker" mounts loom-orchestration MCP — see (3)'s own comment on C
    const fg = fakes[fakes.length - 1];
    fg.feed(DIALOG_TEXT); // forces isBlockedOnUnresolvedBootDialog deterministically, same as (3)

    await waitUntil(() => host.hasReachedReady(G), { label: "(4a) READY_FALLBACK_MS marks ready despite the dialog, before SessionStart ever fires", timeoutMs: 5000 });
    check("(4a) nothing written yet — ready, but held behind the dialog, no cycle started", countIn(fg, PASTE_START) === 0 && countShiftTabs(fg) === 0);

    // SessionStart arrives LATE (ready already latched). Dialog resolves (sessionStartObserved flips,
    // dialogStuckScan clears) — but startupModeCycles=2 means a REAL cycle now starts, and
    // `startupCycleInFlight` must hold the kickoff through it (isBlockedOnUnresolvedBootDialog alone
    // already reads false the instant this hook runs, so it can no longer explain any further hold).
    host.deliverHook(G, { hook_event_name: "SessionStart", session_id: "eng-G" });

    const noWriteDuringCycle = await assertNeverWithControl({
      label: "(4b) nothing written while the mode cycle itself is mid-flight (startupCycleInFlight holds it)",
      check: () => countIn(fg, PASTE_START) >= 1,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        const { id, fake } = await spawnControlDelivery("(4b) mode-cycle-in-flight positive control");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 1, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(4b) ready, SessionStart fired, but NOTHING written while the cycle is still converging", noWriteDuringCycle);

    // Drive the cycle to its target — same footer-feed recipe as pty-ready-fallback-race.mjs.
    fg.feed(ACCEPT_EDITS_FOOTER);
    check("(4c) cycle's 1st Shift+Tab issued once settle completes",
      await waitUntil(() => countShiftTabs(fg) === 1, { timeoutMs: 2000, label: "(4c) 1st Shift+Tab" }));
    check("(4c) STILL nothing delivered after the 1st Shift+Tab alone", countIn(fg, PASTE_START) === 0);
    fg.feed(PLAN_FOOTER);
    check("(4d) cycle's 2nd (final) Shift+Tab issued",
      await waitUntil(() => countShiftTabs(fg) === 2, { timeoutMs: 2000, label: "(4d) 2nd Shift+Tab" }));
    check("(4d) STILL nothing delivered immediately after the 2nd Shift+Tab is WRITTEN (not yet confirmed via the footer)", countIn(fg, PASTE_START) === 0);
    fg.feed(AUTO_FOOTER); // confirms the 2nd Shift+Tab landed — the cycle reaches its target here

    // THE CORE CLAIM: delivery proceeds PROMPTLY (a short, bounded wait — no reconcile() tick, production
    // or otherwise, is ever invoked anywhere in this scenario) directly off the cycle's own onDone.
    check("(4e) kickoff delivered exactly once, promptly, with NO call to host.reconcile() anywhere in this scenario",
      await waitUntil(() => countIn(fg, PASTE_START) === 1, { timeoutMs: 2000, label: "(4e) kickoff delivered via releaseBootModeCycle's direct drain" }));
    check("(4e) the delivered text is the ORIGINAL kickoff", writtenOf(fg).includes(KICKOFF4));

    // ORDERING: the kickoff's own paste-start marker must appear AFTER the LAST Shift+Tab in the real
    // write sequence — never interleaved mid-cycle (the frame-splice class this whole mechanism guards).
    const lastShiftTabIdx = fg.writes.lastIndexOf(SHIFT_TAB);
    const firstPasteIdx = fg.writes.indexOf(PASTE_START);
    check("(4f) the kickoff's paste-start marker is strictly AFTER the cycle's last Shift+Tab in write order",
      lastShiftTabIdx !== -1 && firstPasteIdx !== -1 && firstPasteIdx > lastShiftTabIdx);
    try { host.stop(G, "hard"); } catch { /* ignore */ }
  }

  // ============ (4') Card 850eb55c (round 3, item 2): drainPending's OWN `startupCycleInFlight` guard =====
  // ============     (host.ts ~9244) — isolated from scheduleKickoffGuarantee's own direct-submit check ====
  // ============     (scenario (4) above never actually exercises THIS one line: nothing there ever clears ==
  // ============     `live.busy` WHILE the cycle is mid-flight, so drainPending's own startupCycleInFlight ==
  // ============     check never gets a chance to matter there — disabling just that line still leaves (4) =
  // ============     green). Clears busy via healIfStuck's FIRST_TURN_STALE_MS window (the SAME mechanism ===
  // ============     scenario (3) relies on) WHILE still pre-SessionStart, so the clear itself is routed, ===
  // ============     correctly, through isBlockedOnUnresolvedBootDialog's OWN hold, not this one — THEN =====
  // ============     delivers SessionStart (starting the real cycle) with the kickoff ALREADY queued in =====
  // ============     `live.pending` and busy ALREADY false, and calls `host.reconcile()` BETWEEN the ========
  // ============     cycle's two Shift+Tabs — the one moment where nothing but `startupCycleInFlight` =======
  // ============     stands between the queued entry and a mid-cycle paste. =================================
  {
    const H = "fallback-H-drainpending-cycle-guard";
    const KICKOFF_H = "orchestrate task via the readiness fallback — drainPending's own cycle-in-flight guard";
    host.spawn({
      sessionId: H, cwd: tmpHome, startupPrompt: KICKOFF_H, role: "worker",
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 2 }, // → target "auto"
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.markMcpSeen(H); // "worker" mounts loom-orchestration MCP — see (3)'s own comment on C
    const fh = fakes[fakes.length - 1];
    fh.feed(DIALOG_TEXT); // forces isBlockedOnUnresolvedBootDialog deterministically, same as (3)/(4)

    await waitUntil(() => host.hasReachedReady(H), { label: "(4'a) READY_FALLBACK_MS marks ready despite the dialog", timeoutMs: 5000 });
    check("(4'a) nothing written yet — ready, held behind the dialog, no cycle started", countIn(fh, PASTE_START) === 0 && countShiftTabs(fh) === 0);

    // Wait for the OBSERVABLE precondition this scenario actually needs: scheduleKickoffGuarantee's own
    // gated branch (held by isBlockedOnUnresolvedBootDialog) has routed the kickoff into `live.pending` —
    // never a blind sleep guessing at logLandedMode's own settle timing.
    await waitUntil(() => (host.live.get(H)?.pending?.length ?? 0) > 0,
      { label: "(4'a') the kickoff has been queued behind the dialog (scheduleKickoffGuarantee's own held branch)", timeoutMs: 3000 });

    // Clear `busy` via healIfStuck's own FIRST_TURN_STALE_MS window, STILL pre-SessionStart — the SAME
    // mechanism scenario (3) relies on. Polls host.reconcile() (the production periodic tick, called
    // directly — never a blind sleep) until busy actually flips, an observable event.
    await waitUntil(() => { host.reconcile(); return host.live.get(H)?.busy === false; },
      { label: "(4'b) busy cleared pre-SessionStart via healIfStuck's FIRST_TURN_STALE_MS window", timeoutMs: 3000 });
    check("(4'b) still nothing written — busy cleared, but still held by isBlockedOnUnresolvedBootDialog (dialog still on screen, SessionStart not yet observed)", countIn(fh, PASTE_START) === 0);

    host.deliverHook(H, { hook_event_name: "SessionStart", session_id: "eng-H" }); // the dialog resolves; the real mode cycle starts
    check("(4'c) nothing written the instant SessionStart fires — the cycle has not pressed its first Shift+Tab yet", countIn(fh, PASTE_START) === 0 && countShiftTabs(fh) === 0);

    fh.feed(ACCEPT_EDITS_FOOTER);
    check("(4'd) cycle's 1st Shift+Tab issued", await waitUntil(() => countShiftTabs(fh) === 1, { timeoutMs: 2000, label: "(4'd) 1st Shift+Tab" }));

    // THE CORE CLAIM: between the two Shift+Tabs — busy already false, dialog already resolved, the
    // kickoff already sitting in `live.pending` — the ONLY thing left holding drainPending's own drain is
    // `Live.startupCycleInFlight`. Calling reconcile() HERE is the one place that guard, specifically, is
    // ever exercised: disabling it alone (nothing else touched) delivers the paste right here, before the
    // 2nd Shift+Tab, which the (4'e) check below catches.
    host.reconcile();
    check("(4'e) STILL nothing written between the two Shift+Tabs (drainPending's own startupCycleInFlight guard holds it)", countIn(fh, PASTE_START) === 0);

    fh.feed(PLAN_FOOTER);
    check("(4'f) cycle's 2nd (final) Shift+Tab issued", await waitUntil(() => countShiftTabs(fh) === 2, { timeoutMs: 2000, label: "(4'f) 2nd Shift+Tab" }));
    check("(4'f) STILL nothing delivered immediately after the 2nd Shift+Tab is WRITTEN (not yet confirmed via the footer)", countIn(fh, PASTE_START) === 0);
    fh.feed(AUTO_FOOTER); // confirms the 2nd Shift+Tab landed — the cycle reaches its target here

    check("(4'g) kickoff delivered exactly once, promptly, off the cycle's own onDone",
      await waitUntil(() => countIn(fh, PASTE_START) === 1, { timeoutMs: 2000, label: "(4'g) kickoff delivered via releaseBootModeCycle's direct drain" }));
    check("(4'g) the delivered text is the ORIGINAL kickoff", writtenOf(fh).includes(KICKOFF_H));

    const lastShiftTabIdxH = fh.writes.lastIndexOf(SHIFT_TAB);
    const firstPasteIdxH = fh.writes.indexOf(PASTE_START);
    check("(4'h) the kickoff's paste-start marker is strictly AFTER the cycle's last Shift+Tab in write order",
      lastShiftTabIdxH !== -1 && firstPasteIdxH !== -1 && firstPasteIdxH > lastShiftTabIdxH);
    try { host.stop(H, "hard"); } catch { /* ignore */ }
  }

  // ============ (5) Card e29923e3: the MCP-dialog variant of (3) — a LOOM_DRIVEN-role session readied ====
  // ============     via the fallback, stuck on the MCP-enable dialog (not external-imports): the single ==
  // ============     deferred Esc still fires exactly once, the hold survives several reconcile() ticks ===
  // ============     while the dialog stays on screen (the Esc write alone never releases it — only =======
  // ============     SessionStart does), and delivery proceeds exactly once the instant SessionStart =======
  // ============     actually resolves it. RED against main (850eb55c's original optimistic clear released=
  // ============     the hold AT DETECTION, before any Esc or SessionStart, letting the kickoff through ====
  // ============     prematurely — see docs/decisions/e29923e3-hold-boot-dialog-kickoff-until-sessionstart.
  // ============     md's own Background). ====================================================================
  {
    const I = "fallback-I-mcp-dialog-stuck";
    const KICKOFF5 = "orchestrate task via the readiness fallback — stuck behind the MCP-enable dialog";
    host.spawn({
      sessionId: I, cwd: tmpHome, startupPrompt: KICKOFF5, role: "worker",
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.markMcpSeen(I); // "worker" mounts loom-orchestration MCP — see (3)'s own comment on C
    const fi = fakes[fakes.length - 1];
    fi.feed(MCP_PROMPT_TEXT); // schedules dismissMcpPrompt at +MCP_DISMISS_INITIAL_DELAY_MS, holds the kickoff

    await waitUntil(() => host.hasReachedReady(I), { label: "(5a) READY_FALLBACK_MS marks ready despite the MCP dialog", timeoutMs: 5000 });
    check("(5a) ready, but nothing written yet for the kickoff", countIn(fi, PASTE_START) === 0);

    await waitUntil(() => countEsc(fi) >= 1, { label: "(5b) the single deferred Esc fires", timeoutMs: 3000 });
    check("(5b) exactly one Esc written — no retry loop", countEsc(fi) === 1);

    // The hold must survive several reconcile() ticks while the dialog stays on screen — the Esc write
    // itself never clears dialogStuckScan (card e29923e3's own round-3 "do not" above); only SessionStart does.
    for (let k = 0; k < 5; k++) host.reconcile();
    check("(5c) STILL nothing written after several reconcile() ticks — the Esc write alone never releases the hold", countIn(fi, PASTE_START) === 0);

    host.deliverHook(I, { hook_event_name: "SessionStart", session_id: "eng-I" }); // the dialog actually resolves
    host.reconcile();
    await waitUntil(() => countIn(fi, PASTE_START) === 1, { label: "(5d) kickoff delivered exactly once once SessionStart resolves the dialog", timeoutMs: 3000 });
    check("(5d) exactly ONE kickoff delivery", countIn(fi, PASTE_START) === 1);
    check("(5d) the delivered text is the ORIGINAL kickoff", writtenOf(fi).includes(KICKOFF5));
    try { host.stop(I, "hard"); } catch { /* ignore */ }
  }
} finally {
  for (const id of ["fallback-A", "fallback-B", "fallback-C-dialog-stuck", "fallback-D-no-dialog-control", "fallback-D2-plain-role-control", "fallback-E-manager-role-now-held", "fallback-F-dialog-stuck-drain", "fallback-F2-manager-resume-dialog-stuck", "fallback-G-dialog-stuck-mode-cycle", "fallback-H-drainpending-cycle-guard", "fallback-I-mcp-dialog-stuck"]) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a fresh spawn whose SessionStart hook is NEVER delivered still gets its kickoff delivered exactly once, via READY_FALLBACK_MS's own markReady call chaining into the same logLandedMode-gated scheduleKickoffGuarantee delivery the SessionStart-driven path uses; resume (no startupPrompt) stays a byte-identical no-op through this path too; (card 850eb55c) a LOOM_DRIVEN-role session stuck on a recognized boot dialog pre-SessionStart has BOTH delivery paths (scheduleKickoffGuarantee's direct submit, drainPending's own queued-entry path) held — never dropped — until SessionStart actually resolves the dialog, while the same role with no dialog and a non-LOOM_DRIVEN role with the same dialog both stay unchanged; (round 2) when SessionStart arrives LATE (ready already latched by the fallback) and drives a REAL boot mode-cycle, the kickoff is held through the whole cycle and delivered PROMPTLY, strictly after the cycle's last Shift+Tab, straight off the cycle's own onDone — never via host.reconcile(), which this file never once calls in that scenario; (round 3) drainPending's OWN startupCycleInFlight guard, isolated from scheduleKickoffGuarantee's own check, also holds a queued entry through a reconcile() call fired BETWEEN the cycle's two Shift+Tabs, with busy already cleared and the dialog already resolved; and (card e29923e3) the MCP-dialog variant of that same hold — dismissMcpPrompt's single deferred Esc fires exactly once, survives several reconcile() ticks with the dialog still on screen, and delivery proceeds exactly once SessionStart actually resolves it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
