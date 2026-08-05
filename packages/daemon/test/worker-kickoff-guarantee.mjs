import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Fresh-spawn KICKOFF DELIVERY + BROKEN-SPAWN SIGNAL (task c0a6e611, reworked by card 0050a17e).
//
// THE ORIGINAL BUG (c0a6e611): a `worker_spawn` kickoff used to ride the CLI as a positional arg — the
// vendor `claude` CLI was responsible for auto-typing + auto-submitting it as turn 1 once its TUI booted.
// That internal auto-submit could lose the race against Loom's own boot machinery (mode-cycle keystrokes,
// dialog dismissals) under load and never land as a real turn: the worker sat `live` with
// `engineSessionId:null`, no transcript, no lastError — and the manager got the BENIGN
// `[loom:worker-idle]` nudge ("finished a turn and is idle but did NOT call worker_report"), which masks
// a broken spawn as a normal park.
//
// CARD 0050a17e (Windows command-line ceiling removal) changed the VEHICLE: the startup prompt no longer
// rides argv at ALL, for any role (buildSpawnArgs never emits it — see that function's own doc). So
// there is no more vendor-CLI auto-submit to race — the delivery this file tests used to be a FALLBACK
// racing that auto-submit after a `STARTUP_PROMPT_GRACE_MS` grace window; it is now the PRIMARY delivery
// path, firing on the very next tick after `markReady` (no grace window — nothing left to wait out).
// This file's H1b scenario ("the CLI's own auto-submit wins the race") is now STRUCTURALLY IMPOSSIBLE and
// has been replaced with the still-real residual case: something ELSE starts a turn on the SAME
// synchronous tick as `markReady`, before the deferred delivery check ever runs — proving the check's own
// internal `firstTurnStarted` recheck (not a race against an external auto-submit) is what prevents a
// double-submit.
//
// THE FIX, two parts, both in pty/host.ts + sessions/service.ts:
//   (H1) scheduleKickoffGuarantee — once a startup-prompt spawn reaches `ready` (markReady), deliver the
//        kickoff via the exact reliable path (submit()) every later turn uses — UNLESS a turn already
//        started (firstTurnStarted) by the time the deferred check runs. Fires for EVERY startup-prompt
//        spawn — a fresh worker_spawn, a recycle handoff (recycleWorker/recycleManager/platform-lead
//        recycle all pass a real startupPrompt through this same path), and a run's startup prompt. A
//        no-op ONLY for resume and fork (neither ever passes a startupPrompt — lastPrompt stays null
//        there) and a no-op once a turn already started before the deferred check runs.
//   (H2) healIfStuck's SHORT pre-first-turn stale window (FIRST_TURN_STALE_MS) — a session that never
//        started turn 1 can't legitimately be "mid a long tool call", so it self-heals busy:false on a
//        much shorter window than the general busyStaleMs (5min), surfacing the broken spawn to the
//        manager fast instead of sitting masked as "busy" for the full window.
//   (S1) notifyManagerOfIdleWorker branches on `engineSessionId` — `null` means no turn (not even the
//        kickoff) EVER started, so it fires a DISTINCT `[loom:worker-spawn-broken]` signal instead of
//        the generic `[loom:worker-idle]` "did NOT call worker_report" copy (which is literally false
//        for a worker that never ran at all). This is a THIRD, distinct signal — NOT a duplicate of the
//        existing `[loom:worker-exited]` (notifyManagerOfExitedWorker, fired on pty EXIT) or the benign
//        `[loom:worker-idle]` (fired when a turn genuinely finished and no report followed).
//
// HERMETIC, claude-free — two layers:
//   (H) HOST — PtyHost driven against a FAKE pty (mirrors pty-resume-readiness.mjs): no real claude.
//   (S) SVC  — SessionService.notifyManagerOfIdleWorker driven directly against a temp .db + a
//              recording stub PtyHost (mirrors worker-exited-without-report.mjs / inbox-pull.mjs).
//
// RUN: pnpm build (from packages/daemon) then `node test/worker-kickoff-guarantee.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";
import { observeOnce, assertNeverWithControl } from "./_timing-guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn).
// FIRST_TURN_STALE_MS is read at MODULE IMPORT time — set it BEFORE importing host.js, short enough for
// a fast test. Delivery itself no longer has a grace window to configure (card 0050a17e collapsed it to
// "next tick after markReady") — there's nothing left to set for that.
const tmpHome = path.join(os.tmpdir(), `loom-kickoff-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_FIRST_TURN_STALE_MS = "450";
process.env.LOOM_READY_FALLBACK_MS = "5000"; // long enough it never fires inside these tests' own windows
process.env.LOOM_RESUME_MODE_POLL_MS = "20"; // fast footer polling for the mode-cycle scenario (H1e)
// Pinned (not left at the 900ms default) so NEGATIVE_WINDOW_MS below has an EXPLICIT, measured margin
// under it — sendEnterAndVerify's give-up/reassert-paste retry (host.ts) also writes a bracket-paste
// marker, so a window that ever reached this timeout could misread an unrelated retry as a repeated
// kickoff delivery. See NEGATIVE_WINDOW_MS's own comment below.
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "5000";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const PASTE_START = "\x1b[200~";
const SHIFT_TAB = "\x1b[Z";

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

// windowMs shared by every negative check below — derived from the pinned LOOM_SUBMIT_VERIFY_TIMEOUT_MS
// (5000ms) above: comfortably (25x) under it, so sendEnterAndVerify's give-up/reassert-paste retry can
// never fire inside the window and be mistaken for a repeated/unexpected kickoff delivery.
const NEGATIVE_WINDOW_MS = 200;

// Spawn a throwaway control session (SessionStart delivered, like kick-A) and wait for its own real
// kickoff delivery — used by every positiveControl below to prove countIn(...)'s PASTE_START check can
// actually catch a real delivery, via the identical write path scheduleKickoffGuarantee itself uses (not
// a hand-written fake write).
let controlSeq = 0;
async function spawnControlDelivery(label) {
  const id = `control-${controlSeq++}-${label.replace(/[^a-z0-9]+/gi, "-")}`;
  const kickoff = `control kickoff (${label})`;
  host.spawn({
    sessionId: id, cwd: tmpHome, startupPrompt: kickoff,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake = lastFake();
  host.deliverHook(id, { hook_event_name: "SessionStart" });
  await waitUntil(() => countIn(fake, PASTE_START) === 1, { label: `${label}: control kickoff delivered once` });
  return { id, fake, kickoff };
}

try {
  // ============ (H1a) NOTHING ELSE STARTS A TURN: SessionStart fires, nothing else ever submits =========
  // → the kickoff is delivered exactly once, on the very next tick after ready (no grace window to wait out).
  {
    const A = "kick-A";
    const KICKOFF = "orchestrate task tk-A";
    host.spawn({
      sessionId: A, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fa = lastFake();
    host.deliverHook(A, { hook_event_name: "SessionStart" }); // ready — no mode-cycles, no UserPromptSubmit ever
    // Even at "next tick" (setTimeout(…,0)), JS's event-loop guarantees a macrotask never fires inside the
    // SAME synchronous execution that scheduled it — so checking synchronously, right after the hook call
    // returns, is still a valid "not yet" assertion, not a guess about timing.
    check("(H1a) NOT delivered synchronously within the same tick as ready", countIn(fa, PASTE_START) === 0);
    await waitUntil(() => countIn(fa, PASTE_START) === 1, { label: "(H1a) kickoff delivered on the next tick after ready" });
    check("(H1a) the kickoff was delivered exactly once", countIn(fa, PASTE_START) === 1);
    check("(H1a) the delivered text is the ORIGINAL kickoff", writtenOf(fa).includes(KICKOFF));
    check("(H1a) busy was (re)armed true by the delivery", busyById[A]?.[busyById[A].length - 1] === true);
    // scheduleKickoffGuarantee is a ONE-SHOT setTimeout guarded by markReady's own live.ready latch — there
    // is no further completion event to poll for here, only an absence to bound. Proven via
    // assertNeverWithControl (not a bare sleep+look-once) — see NEGATIVE_WINDOW_MS's own comment for why
    // the window stays well under the pinned SUBMIT_VERIFY_TIMEOUT_MS.
    //
    // Card c4ccae66: the check below counts occurrences of the KICKOFF BODY TEXT, not the bare
    // BRACKET_PASTE_START byte marker (`"\x1b[200~"`, aliased here as PASTE_START). `sendEnterAndVerify`
    // (host.ts) LEGITIMATELY re-writes that exact same marker (as an empty `BRACKET_PASTE_START +
    // BRACKET_PASTE_END` "reassert-paste" pair, carrying NO body text) on every retry attempt once
    // SUBMIT_VERIFY_TIMEOUT_MS elapses with no confirming hook — which is guaranteed to eventually happen
    // in THIS scenario, since H1a deliberately never delivers one. A marker-count check is therefore
    // racing a real, designed-to-fire production retry, not just guarding against a hypothetical: forcing
    // ~700ms of extra delay between kick-A's own (unconfirmed, by design) Enter attempt 1 and this
    // assertion reliably reproduced a live gate failure this way — `sendEnterAndVerify` legitimately wrote
    // a second bare PASTE_START marker with the ORIGINAL kickoff text never repeated, and the old
    // `countIn(fa, PASTE_START) >= 2` check misread that as a duplicate delivery. Counting the BODY TEXT
    // instead is immune to this by construction (a bare reassert-paste has no body to match), independent
    // of NEGATIVE_WINDOW_MS/SUBMIT_VERIFY_TIMEOUT_MS's relative timing — not a bigger window, a correct
    // discriminator. See docs/investigations/c4ccae66-h1a-intermittent-repeat-delivery/findings.md.
    const noRepeatH1a = await assertNeverWithControl({
      label: "(H1a) still exactly ONE delivery of the kickoff body (no repeat firing)",
      check: () => countIn(fa, KICKOFF) >= 2,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        // Arm a REAL second delivery of the IDENTICAL kickoff body on a throwaway control session — its
        // own real delivery, then a legitimate end-of-turn (UserPromptSubmit+Stop, same shape as H1b
        // below) + enqueueStdin repeating that SAME text verbatim, to force a genuine second submit() of
        // the same body — proving the body-text check can actually catch a real repeat via the SAME real
        // write path scheduleKickoffGuarantee uses (not just that PASTE_START can appear twice, which a
        // harmless reassert-paste retry can also do — see this block's own doc above).
        const { id, fake, kickoff } = await spawnControlDelivery("H1a repeat-check positive control");
        host.deliverHook(id, { hook_event_name: "UserPromptSubmit" });
        host.deliverHook(id, { hook_event_name: "Stop" }); // end that turn — clears busy
        host.enqueueStdin(id, kickoff, "system", undefined, undefined, "agent");
        const went = await observeOnce({ check: () => countIn(fake, kickoff) >= 2, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(H1a) still exactly ONE delivery of the kickoff body (no repeat firing)", noRepeatH1a);
  }

  // ============ (H1b) SAME-TICK RACE: something else starts a turn BEFORE the deferred check runs ========
  // Card 0050a17e: there is no more vendor-CLI auto-submit to race (the prompt never rides argv, so the
  // CLI has nothing to auto-type). The still-real residual case is a turn starting on the SAME
  // synchronous tick as `ready` — before scheduleKickoffGuarantee's own deferred (next-tick) check ever
  // runs — which its internal `firstTurnStarted` recheck (not a race window) is what catches.
  {
    const B = "kick-B";
    const KICKOFF = "orchestrate task tk-B";
    host.spawn({
      sessionId: B, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fb = lastFake();
    host.deliverHook(B, { hook_event_name: "SessionStart" }); // ready — schedules the deferred delivery check
    // Synchronously, on the SAME tick — before the scheduled check's setTimeout(0) can possibly fire —
    // something else starts (and finishes) a turn.
    host.deliverHook(B, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(B, { hook_event_name: "Stop" });
    // No positive event to poll for — proving an ABSENCE needs a bounded wall-clock window, not a guess
    // about when something completes. `firstTurnStarted` flipped true synchronously above, so the
    // deferred check's own guard is already deterministic by the time it fires; this only bounds how
    // long we give it to (not) misfire. Proven via assertNeverWithControl, not a bare sleep+look-once.
    const neverDeliveredH1b = await assertNeverWithControl({
      label: "(H1b) NO delivery — nothing was ever written to the pty by Loom's own submit()",
      check: () => countIn(fb, PASTE_START) >= 1,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        // Prove the >=1 check can catch a real delivery — a normal control session really does get one.
        const { id, fake } = await spawnControlDelivery("H1b positive control");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 1, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(H1b) NO delivery — nothing was ever written to the pty by Loom's own submit()", neverDeliveredH1b);
  }

  // ============ (H1c) ORDERING: a turn can start BEFORE ready is ever reached =============================
  // UserPromptSubmit observed pre-SessionStart — proves scheduleKickoffGuarantee's guard
  // (`!live.firstTurnStarted`) is checked at SCHEDULE time, not just inside the deferred callback, so a
  // turn that started early is never redundantly replayed once ready is later reached.
  {
    const C = "kick-C";
    const KICKOFF = "orchestrate task tk-C";
    host.spawn({
      sessionId: C, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fc = lastFake();
    host.deliverHook(C, { hook_event_name: "UserPromptSubmit" }); // "the enqueue" fires BEFORE ready
    host.deliverHook(C, { hook_event_name: "SessionStart" });     // ready reached AFTER the turn already started
    // Pure absence check (nothing to poll for) — see H1b's comment.
    const neverDeliveredH1c = await assertNeverWithControl({
      label: "(H1c) ready-after-enqueue: no delivery — the turn had already started when ready landed",
      check: () => countIn(fc, PASTE_START) >= 1,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        const { id, fake } = await spawnControlDelivery("H1c positive control");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 1, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(H1c) ready-after-enqueue: no delivery — the turn had already started when ready landed", neverDeliveredH1c);
  }

  // ============ (H1d) NO-OP for resume/fork ONLY (no startupPrompt → lastPrompt stays null) ============
  {
    const D = "kick-D";
    host.spawn({
      sessionId: D, cwd: tmpHome, resumeId: "engine-D", // resume: no startupPrompt passed
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fd = lastFake();
    host.deliverHook(D, { hook_event_name: "SessionStart" });
    // Pure absence check (nothing to poll for) — see H1b's comment.
    const neverDeliveredH1d = await assertNeverWithControl({
      label: "(H1d) resume path: NEVER delivers (no kickoff was ever passed)",
      check: () => countIn(fd, PASTE_START) >= 1,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        const { id, fake } = await spawnControlDelivery("H1d positive control");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 1, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(H1d) resume path: NEVER delivers (no kickoff was ever passed)", neverDeliveredH1d);
  }

  // ============ (H1f) RECYCLE-SHAPED spawn: delivery still fires ==========================================
  // A recycled session's handoff rides the SAME startup-prompt path as a fresh worker_spawn —
  // recycleWorker/recycleManager/the platform-lead recycle all call pty.spawn with a real startupPrompt
  // (the handoff text), never `--resume` — so it must be delivered the same way. Same shape as H1a's
  // "nothing else starts a turn" case, just framed as a recycle handoff to prove delivery isn't
  // fresh-spawn-only.
  {
    const G = "kick-G";
    const HANDOFF = "[loom:handoff] You are continuing a task in an existing git worktree on branch loom/tk-G. Continue from here.";
    host.spawn({
      sessionId: G, cwd: tmpHome, startupPrompt: HANDOFF, // recycleWorker's spawn shape: a real prompt, no resumeId
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fg = lastFake();
    host.deliverHook(G, { hook_event_name: "SessionStart" }); // ready — nothing else ever starts a turn
    check("(H1f) recycle handoff: NOT delivered synchronously within the same tick as ready", countIn(fg, PASTE_START) === 0);
    await waitUntil(() => countIn(fg, PASTE_START) === 1, { label: "(H1f) recycle handoff delivered on the next tick after ready" });
    check("(H1f) recycle handoff: delivered exactly once (delivery is NOT fresh-spawn-only)", countIn(fg, PASTE_START) === 1);
    check("(H1f) recycle handoff: the delivered text is the ORIGINAL handoff", writtenOf(fg).includes(HANDOFF));
  }

  // ============ (H1e) mode-cycling still lands BEFORE the delivered kickoff (ordering preserved) =========
  {
    const E = "kick-E";
    const KICKOFF = "orchestrate task tk-E";
    host.spawn({
      sessionId: E, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 2 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fe = lastFake();
    fe.feed("accept edits on (shift+tab to cycle)"); // boot footer painted before SessionStart
    host.deliverHook(E, { hook_event_name: "SessionStart" }); // starts the feedback mode-cycle

    // Each hop below waits for the ACTUAL write it's reacting to, instead of summing nominal constants
    // into one guessed deadline — individually-comfortable per-hop margins are not comfortable once
    // chained (card 65e4e978). Waiting on real observables removes the guess at every hop.
    await waitUntil(() => countIn(fe, SHIFT_TAB) === 1, { label: "(H1e) mode-cycle press #1" });
    check("(H1e) press #1 landed before any delivery", countIn(fe, PASTE_START) === 0);
    fe.feed("plan mode on (shift+tab to cycle)"); // press #1's footer response — not yet the target

    await waitUntil(() => countIn(fe, SHIFT_TAB) === 2, { label: "(H1e) mode-cycle press #2" });
    check("(H1e) press #2 landed before any delivery", countIn(fe, PASTE_START) === 0);
    fe.feed("auto mode on (shift+tab to cycle)"); // press #2 lands the target → markReady fires

    await waitUntil(() => countIn(fe, PASTE_START) === 1, { label: "(H1e) the eventual kickoff delivery" });
    check("(H1e) the kickoff was eventually delivered", countIn(fe, PASTE_START) === 1);
    check("(H1e) no THIRD Shift+Tab was pressed once the target landed (cycle stopped at exactly 2)", countIn(fe, SHIFT_TAB) === 2);
    check("(H1e) ORDERING — the Shift+Tabs were written BEFORE the delivered kickoff paste",
      writtenOf(fe).lastIndexOf(SHIFT_TAB) >= 0 && writtenOf(fe).lastIndexOf(SHIFT_TAB) < writtenOf(fe).indexOf(PASTE_START));
  }

  // ============ (H2) healIfStuck: SHORT pre-first-turn stale window self-heals busy fast =================
  // A worker that never starts turn 1 (its delivery at H1a's shape also never "lands" here, since the
  // fake pty never echoes engine output back) must self-heal busy:false via FIRST_TURN_STALE_MS (450ms) —
  // WAY under the 5-minute default busyStaleMs a real turn would tolerate — proving the SHORT branch
  // fired, not the general one. reconcile() is the real production trigger (index.ts's timer); the test
  // drives it directly.
  {
    const F = "kick-F";
    host.spawn({
      sessionId: F, cwd: tmpHome, startupPrompt: "orchestrate task tk-F",
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.deliverHook(F, { hook_event_name: "SessionStart" }); // ready; delivery fires; never sees UserPromptSubmit
    check("(H2) busy immediately after spawn (optimistic set)", busyById[F]?.[0] === true);
    // Poll the real production trigger (reconcile()) repeatedly instead of summing guessed windows: it
    // only flips busy once ACTUAL elapsed time clears the stale window, so this is correct regardless of
    // host scheduling contention, not a guess about how long the hops take together.
    await waitUntil(() => { host.reconcile(); return busyById[F]?.[busyById[F].length - 1] === false; },
      { intervalMs: 20, label: "(H2) busy self-heals via reconcile() on the short pre-first-turn window" });
    check("(H2) busy self-healed to false on the SHORT pre-first-turn window (well under the 5min default)",
      busyById[F]?.[busyById[F].length - 1] === false);
  }
} finally {
  for (const id of ["kick-A", "kick-B", "kick-C", "kick-D", "kick-E", "kick-F", "kick-G"]) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ============================================================================================
// (S) SVC — SessionService.notifyManagerOfIdleWorker: the broken-spawn branch, distinct from BOTH
// the benign worker-idle nudge AND the existing worker_exited_without_report/[loom:worker-exited]
// mechanism (notifyManagerOfExitedWorker — a completely separate function, fired on pty EXIT, untouched
// here). Mirrors worker-exited-without-report.mjs's harness.
// ============================================================================================
{
  const { Db } = await import("../dist/db.js");
  const { SessionService } = await import("../dist/sessions/service.js");
  const { OrchestrationControl } = await import("../dist/orchestration/control.js");

  const NOW = new Date();

  function makeEnv() {
    const dbFile = path.join(os.tmpdir(), `loom-kickoff-svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    const db = new Db(dbFile);
    const projId = `kp-${Math.random().toString(36).slice(2, 8)}`;
    const agentId = `ka-${Math.random().toString(36).slice(2, 8)}`;
    const now = NOW.toISOString();
    db.insertProject({ id: projId, name: "Kickoff", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
    const enqueued = [];
    const pendingBySession = new Map();
    const pty = {
      enqueueStdin: (id, text) => {
        enqueued.push({ id, text });
        const s = db.getSession(id);
        return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
      },
      getPendingEntries: (id) => pendingBySession.get(id) ?? [],
      // Card 2281009d: classifyIdleWorker now also consults hasFirstTurnStarted before its broken-spawn
      // branch. (S2) below is explicitly "engineSessionId SET (a real turn ran)" — stubbing this true
      // keeps that scenario genuinely representing a real turn; (S1)/(S3)/(S4) use engineSessionId:null,
      // which returns from the PRE-EXISTING check before this stub is ever consulted.
      hasFirstTurnStarted: () => true,
    };
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    return { dbFile, db, projId, agentId, enqueued, sessions, pendingBySession };
  }
  function seedSession(e, id, { role = "worker", processState = "live", parentSessionId = null, taskId = null, branch = null, engineSessionId = "eng-" + id } = {}) {
    e.db.insertSession({
      id, projectId: e.projId, agentId: e.agentId, engineSessionId, title: null, cwd: e.projId,
      processState, resumability: "resumable", busy: false,
      createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role,
      parentSessionId, taskId, ctxInputTokens: null, ctxTurns: null, model: null, worktreePath: null, branch,
    });
  }
  function seedTask(e, id, columnKey = "in_progress") {
    e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, priority: "p2", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  }
  function cleanup(e) {
    try { e.db.close(); } catch { /* ignore */ }
    for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
  }

  // (S1) engineSessionId:null → the DISTINCT [loom:worker-spawn-broken] signal, not the benign idle copy.
  {
    const e = makeEnv();
    seedSession(e, "mgr-s1", { role: "manager" });
    seedTask(e, "tk-s1");
    seedSession(e, "wkr-s1", { taskId: "tk-s1", parentSessionId: "mgr-s1", branch: "loom/tk-s1", engineSessionId: null });

    e.sessions.notifyManagerOfIdleWorker("wkr-s1");
    const broken = e.enqueued.find((x) => x.id === "mgr-s1" && /worker-spawn-broken/.test(x.text));
    check("(S1) engineSessionId:null → a [loom:worker-spawn-broken] nudge is pushed", !!broken);
    check("(S1) the broken-spawn nudge names the worker + task, and rules out worker_message until verified (card 92902cc2's site-A-modeled remedy order)",
      !!broken && broken.text.includes("wkr-s1") && broken.text.includes("tk-s1") && /do NOT worker_message it/.test(broken.text));
    check("(S1) the broken-spawn nudge does NOT use the benign worker-idle framing", !!broken && !/worker-idle/.test(broken.text));
    check("(S1) the broken-spawn nudge is explicit this is NOT benign", !!broken && /NOT a benign/i.test(broken.text));
    check("(S1) exactly ONE nudge fires (no double-signal)", e.enqueued.filter((x) => x.id === "mgr-s1").length === 1);
    cleanup(e);
  }

  // (S2) engineSessionId SET (a real turn ran) → the EXISTING benign idle nudge, unchanged — regression guard.
  {
    const e = makeEnv();
    seedSession(e, "mgr-s2", { role: "manager" });
    seedTask(e, "tk-s2");
    seedSession(e, "wkr-s2", { taskId: "tk-s2", parentSessionId: "mgr-s2", branch: "loom/tk-s2", engineSessionId: "eng-wkr-s2" });

    e.sessions.notifyManagerOfIdleWorker("wkr-s2");
    const idle = e.enqueued.find((x) => x.id === "mgr-s2" && /worker-idle/.test(x.text));
    check("(S2) engineSessionId set → the NORMAL [loom:worker-idle] \"did NOT call worker_report\" nudge fires", !!idle && /did NOT call worker_report/.test(idle.text));
    check("(S2) NOT mis-flagged as a broken spawn", !e.enqueued.some((x) => /worker-spawn-broken/.test(x.text)));
    cleanup(e);
  }

  // (S3) engineSessionId:null AND pending direction already queued → still SKIPS entirely (the existing
  // redirectWorker-race guard runs BEFORE the new branch — no regression to that guard's precedence).
  {
    const e = makeEnv();
    seedSession(e, "mgr-s3", { role: "manager" });
    seedTask(e, "tk-s3");
    seedSession(e, "wkr-s3", { taskId: "tk-s3", parentSessionId: "mgr-s3", branch: "loom/tk-s3", engineSessionId: null });
    e.pendingBySession.set("wkr-s3", [{ id: "m1", text: "[loom:from-manager:redirect]\ndo X instead", source: "system" }]);

    e.sessions.notifyManagerOfIdleWorker("wkr-s3");
    check("(S3) pending direction still suppresses ANY nudge, even for a broken (engineSessionId:null) spawn", e.enqueued.length === 0);
    cleanup(e);
  }

  // (S4) DISTINCT from the existing worker_exited/worker-exited mechanism — that path is a totally
  // separate function (notifyManagerOfExitedWorker, fired on pty exit) and is untouched by this change;
  // confirm the new broken-spawn nudge never collides with its event kind or nudge text.
  {
    const e = makeEnv();
    seedSession(e, "mgr-s4", { role: "manager" });
    seedTask(e, "tk-s4");
    seedSession(e, "wkr-s4", { taskId: "tk-s4", parentSessionId: "mgr-s4", branch: "loom/tk-s4", engineSessionId: null });

    e.sessions.notifyManagerOfIdleWorker("wkr-s4");
    check("(S4) no worker_exited_without_report event is recorded by the idle-watchdog path (separate mechanism)",
      e.db.listEventsForWorker("wkr-s4").filter((ev) => ev.kind === "worker_exited_without_report").length === 0);
    check("(S4) no [loom:worker-exited] text ever appears from this path", !e.enqueued.some((x) => /worker-exited\]/.test(x.text)));
    cleanup(e);
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — kickoff delivery (card 0050a17e: PRIMARY, not a grace-window fallback) delivers exactly once on the next tick after ready when nothing else starts a turn first; a turn starting on the SAME tick as ready (before the deferred check runs) is never redundantly replayed, via the check's own internal recheck (no more vendor-CLI auto-submit race to speak of); a turn starting BEFORE ready is reached is likewise never replayed; resume/fork are byte-identical no-ops; a RECYCLE-shaped handoff (the same startup-prompt path recycleWorker/recycleManager use) IS delivered too, not just a fresh worker_spawn; mode-cycle ordering is preserved. healIfStuck self-heals a never-started turn on a short window, well under the 5min default. notifyManagerOfIdleWorker branches on engineSessionId: null → a distinct [loom:worker-spawn-broken] signal (not the benign idle copy, not a duplicate of the existing worker-exited mechanism, still suppressed by the redirect-race pending guard); set → the existing benign nudge, unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
