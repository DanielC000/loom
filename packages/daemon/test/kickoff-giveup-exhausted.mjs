import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a8f8a8f2 — "the turn-1 kickoff origin has no onGiveUpExhausted, so an exhausted kickoff is a bare
// silent drop of the whole task dispatch." Post-merge Code Review finding on 0050a17e/b4fa85a4.
//
// ROOT CAUSE: `scheduleKickoffGuarantee`'s synthetic turn-1 origin (pty/host.ts) drives a fresh session's
// startup prompt through a DIRECT submit() with a single synthetic `QueuedMessage`. That message never
// wired `onGiveUpExhausted` (card ccb407eb's hook — see QueuedMessage.onGiveUpExhausted's own doc).
// GIVE_UP_REQUEUE_LIMIT is 1, so the kickoff survives exactly ONE unconfirmed give-up (requeued); a SECOND
// exhausts the budget and, with no hook wired, `requeueGiveUpOrigin` took the residual bare-drop path (a
// console.error only) — the entire task dispatch (the worker's brief, everything) vanished with nothing
// durable or visible surfacing it except the generic idle-watchdog eventually noticing the idle,
// never-started session (slow, indirect, board-state-dependent — not a signal at the exact seam that
// failed).
//
// THE FIX, two layers (mirrors onGiveUpConfirmed's own PtyHost-is-DB-agnostic layering):
//   (H) pty/host.ts — the synthetic origin's `onGiveUpExhausted` now fires the new, OPTIONAL
//       `PtyHostEvents.onKickoffGiveUpExhausted(sessionId)` hook.
//   (S) sessions/service.ts — `handleKickoffGiveUpExhausted` (wired via index.ts) decides who spawned this
//       session and PARKS + NOTIFIES its manager through the SAME durable `enqueueSystemNudge` machinery
//       every settle-nudge uses (never a bare fire-and-forget `pty.enqueueStdin`), naming the ONE known-good
//       recovery (worker_stop + fresh worker_spawn) and explicitly ruling out worker_message/worker_merge.
//
// This suite proves, via a fake pty that NEVER emits output (so every give-up is a genuine drop — mirrors
// pty-giveup-requeue.mjs's own SilentTestPtyHost):
//   (H1) POSITIVE, forced deterministically (not sampled): a kickoff that gives up TWICE in a row —
//        cycle 1 requeues (budget not yet exhausted — the hook must NOT have fired at that point), cycle 2
//        exceeds GIVE_UP_REQUEUE_LIMIT and EXHAUSTS — onKickoffGiveUpExhausted fires exactly once, only
//        after the second give-up, and the kickoff is finally gone from pending (dropped for real, not a
//        runaway requeue loop).
//   (H2) THE DISCRIMINATING NEGATIVE CONTROL: a kickoff that gives up ONCE, requeues, and then the second
//        attempt actually LANDS (a real confirming hook arrives) must NEVER exhaust — proving the hook only
//        fires on genuine exhaustion, not on every give-up.
//   (S1) SessionService.handleKickoffGiveUpExhausted, driven directly against a temp .db + a recording
//        PtyStub (mirrors worker-kickoff-guarantee.mjs's own (S) section): a worker with a live, idle
//        manager gets a durable `[loom:worker-spawn-broken]` notice naming worker_stop + worker_spawn and
//        explicitly ruling out worker_message/worker_merge.
//   (S2) DURABLE, not fire-and-forget: a BUSY manager still gets a persisted `session_message_queued`
//        record for the notice (redriven on its next resume/boot), unlike the idle-watchdog's own bare
//        `pty.enqueueStdin` broken-spawn nudge.
//   (S3)-(S5) SCOPING matches `notifyManagerOfIdleWorker` exactly: no parentSessionId → no-op; a non-worker/
//        non-null role (e.g. a manager parented under another manager) → no-op; a role-less child (role:
//        null) with a parent → IS covered (same as the existing broken-spawn nudge's own role-less fix,
//        card df48366b).
//   (S6) an unknown sessionId is a silent no-op, never a throw.
//
// RUN: pnpm build (from packages/daemon) then `node test/kickoff-giveup-exhausted.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Bounded poll until `predicate()` is true — observes the real state transition instead of guessing a
 *  wall-clock deadline (see pty-giveup-requeue.mjs's own comment for this project's blind-sleep history). */
async function waitUntil(predicate, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    await sleep(2);
  }
}

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn).
const tmpHome = path.join(os.tmpdir(), `loom-kickoff-exhausted-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
const SETTLE_POLL = 5;
const SETTLE_MAX_POLLS = 3;
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 15;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
// The bound this suite is guarding — pinned explicitly (matches production's own default of 1) so the test
// doesn't silently drift if that default is ever retuned.
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
const HOLD_MS = 10;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
const HOLD_WAIT = HOLD_MS + 20;
// The kickoff delivery itself gates on logLandedMode's footer-read poll settling first — shrink it so this
// suite's silent fake pty (which never paints a footer) doesn't wait out the ~4s production default.
process.env.LOOM_MODE_LOG_POLL_MS = "5";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
const busyLog = {};
const exhaustedLog = {};
const events = {
  onEngineSessionId() {},
  onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
  onKickoffGiveUpExhausted(id) { (exhaustedLog[id] ??= []).push(true); },
};

/** A fake pty that never emits output — every give-up this drives is a genuine drop (mirrors
 *  pty-giveup-requeue.mjs's SilentTestPtyHost). */
class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}
const host = new SilentTestPtyHost(events);

function spawnReady(sessionId, startupPrompt) {
  host.spawn({
    sessionId, cwd: tmpHome, startupPrompt,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { fake, bodyCount: (text) => fake.writes.join("").split(text).length - 1 };
}

try {
  // ================ (H1) POSITIVE: two silent give-ups EXHAUST — the hook fires exactly once, only ========
  // ================ after the SECOND, budget-exceeding give-up, never the first (requeue-eligible) one =====
  {
    const SID = "kickoff-exhaust-pos";
    const KICKOFF = "orchestrate task tk-exhaust — two silent give-ups must EXHAUST, not loop forever";
    const { bodyCount } = spawnReady(SID, KICKOFF);
    await waitUntil(() => bodyCount(KICKOFF) >= 1);
    check("(H1) setup: kickoff delivered via direct submit()", bodyCount(KICKOFF) === 1);

    // Cycle 1: never confirmed → give-up #1 → within budget (GIVE_UP_REQUEUE_LIMIT=1) → REQUEUED, not exhausted.
    await waitUntil(() => busyLog[SID].at(-1) === false);
    check("(H1) cycle 1 gave up: the kickoff was requeued (not dropped)",
      host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === KICKOFF);
    check("(H1) NEGATIVE CONTROL: after ONE give-up that successfully requeues, onKickoffGiveUpExhausted has NOT fired",
      !exhaustedLog[SID]);

    // Drain the requeued kickoff (past its hold) — this is cycle 2's attempt.
    await sleep(HOLD_WAIT);
    host.reconcile();
    check("(H1) reconcile drained the requeued kickoff: busy re-armed", busyLog[SID].at(-1) === true);

    // Cycle 2 ALSO never confirms — this SECOND give-up exceeds GIVE_UP_REQUEUE_LIMIT(1) → EXHAUSTED.
    await waitUntil(() => busyLog[SID].at(-1) === false);
    check("(H1) POSITIVE: onKickoffGiveUpExhausted fired exactly once, after the SECOND give-up",
      exhaustedLog[SID]?.length === 1);
    check("(H1) BOUNDED: the kickoff is finally gone from pending — handed to onGiveUpExhausted, not looping forever",
      host.getPendingEntries(SID).length === 0);
    check("(H1) the kickoff body was written to the pty exactly twice (one per cycle — a real second attempt, not a no-op)",
      bodyCount(KICKOFF) === 2);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ================ (H2) THE DISCRIMINATING NEGATIVE CONTROL: one give-up, then a REAL confirm — must =======
  // ================ NEVER exhaust (proves the hook reacts to genuine exhaustion, not to give-up in general) ==
  {
    const SID = "kickoff-exhaust-neg-recovers";
    const KICKOFF = "orchestrate task tk-recovers — one give-up then a real confirm must NEVER exhaust";
    const { bodyCount } = spawnReady(SID, KICKOFF);
    await waitUntil(() => bodyCount(KICKOFF) >= 1);

    await waitUntil(() => busyLog[SID].at(-1) === false); // cycle 1 gives up, requeues
    check("(H2) setup: cycle 1 gave up, requeued", host.getPendingEntries(SID).length === 1);
    check("(H2) setup: not exhausted after the first give-up", !exhaustedLog[SID]);

    await sleep(HOLD_WAIT);
    host.reconcile(); // drains the requeued kickoff — cycle 2 begins
    check("(H2) reconcile drained the requeued kickoff: busy re-armed", busyLog[SID].at(-1) === true);

    // This time a REAL confirming hook arrives — the second attempt LANDS normally, no second give-up ever.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(H2) NEGATIVE CONTROL: a give-up that requeues once then genuinely lands NEVER exhausts",
      !exhaustedLog[SID]);
    check("(H2) nothing left pending after a clean finish", host.getPendingEntries(SID).length === 0);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

// ============================================================================================
// (S) SVC — SessionService.handleKickoffGiveUpExhausted, driven directly against the SAME temp
// LOOM_HOME's .db + a recording PtyStub (mirrors worker-kickoff-guarantee.mjs's own (S) section and
// give-up-exhausted-durable.mjs's PtyStub contract). Deliberately inside the SAME try/finally as (H)
// above — `Db()` with no explicit path resolves against `tmpHome` (LOOM_HOME), so it must still exist.
// ============================================================================================
{
  const { Db } = await import("../dist/db.js");
  const { SessionService } = await import("../dist/sessions/service.js");
  const { OrchestrationControl } = await import("../dist/orchestration/control.js");

  const NOW = new Date();
  const now = NOW.toISOString();
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  /** Minimal contract-faithful PtyStub — just enough for enqueueDurableMessage/enqueueSystemNudge's
   *  full enqueueStdin signature (mirrors give-up-exhausted-durable.mjs's own PtyStub). */
  class PtyStub {
    constructor() { this.live = new Set(); this.busy = new Set(); this.sent = []; }
    setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
    setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
    enqueueStdin(id, text, _source = "system", onDeliver, _route, _kind, _questionId, _ownerText, _proactive, _senderId, giveUpHeldUntil) {
      this.sent.push({ id, text });
      if (!this.live.has(id)) return { delivered: false, reason: "session-dead", queued: false };
      const stillHeld = giveUpHeldUntil !== undefined && Date.now() < giveUpHeldUntil;
      if (!this.busy.has(id) && !stillHeld) return { delivered: true };
      return { delivered: false, position: 1, queued: true };
    }
    getPendingEntries() { return []; }
  }

  const db = new Db();
  const proj = `kge-proj-${sfx}`, agent = `kge-ag-${sfx}`;
  db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
  const mkSession = (o) => db.insertSession({
    id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
    worktreePath: null, branch: null,
  });

  {
    // (S1) worker + a live, idle manager → a durable, actionable [loom:worker-spawn-broken] notice.
    {
      const mgr = `kge-mgr-${sfx}`, wkr = `kge-wkr-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: `tk-kge-${sfx}` });
      const pty = new PtyStub();
      pty.setLive(mgr); // idle
      const sessions = new SessionService(db, pty, new OrchestrationControl());

      sessions.handleKickoffGiveUpExhausted(wkr);
      const toMgr = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
      check("(S1) the manager was notified exactly once", toMgr.length === 1);
      const note = toMgr[0];
      check("(S1) uses the established [loom:worker-spawn-broken] signal", !!note && note.includes("[loom:worker-spawn-broken]"));
      check("(S1) names the worker", !!note && note.includes(wkr));
      check("(S1) names the task", !!note && note.includes(`tk-kge-${sfx}`));
      check("(S1) recommends the ONE known-good recovery: worker_stop + worker_spawn",
        !!note && /worker_stop/.test(note) && /worker_spawn/.test(note));
      check("(S1) explicitly rules out worker_message (would report false delivered:true)", !!note && /do NOT worker_message/i.test(note));
      check("(S1) explicitly rules out worker_merge (would review an empty branch)", !!note && /do NOT worker_merge/i.test(note));
    }

    // (S2) DURABLE, not fire-and-forget: a BUSY manager still gets a persisted session_message_queued record.
    {
      const mgr = `kge-mgr2-${sfx}`, wkr = `kge-wkr2-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
      const pty = new PtyStub();
      pty.setLive(mgr); pty.setBusy(mgr); // busy manager → the notice must be HELD, not lost
      const sessions = new SessionService(db, pty, new OrchestrationControl());

      sessions.handleKickoffGiveUpExhausted(wkr);
      check("(S2) DURABLE: a session_message_queued event was persisted for the held notice",
        db.listEventsForWorker(mgr).some((e) => e.kind === "session_message_queued" && e.detail?.text?.includes("worker-spawn-broken")));
    }

    // (S3) no parentSessionId at all → no natural recipient → no-op (mirrors notifyManagerOfIdleWorker's own gate).
    {
      const wkr = `kge-wkr3-${sfx}`;
      mkSession({ id: wkr, role: "worker", parentSessionId: null });
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      sessions.handleKickoffGiveUpExhausted(wkr);
      check("(S3) no parentSessionId → no-op, nothing dispatched", pty.sent.length === 0);
    }

    // (S4) a non-worker/non-null role (e.g. a manager parented under another manager) → no-op, same scope gate.
    {
      const top = `kge-top-${sfx}`, child = `kge-childmgr-${sfx}`;
      mkSession({ id: top, role: "manager" });
      mkSession({ id: child, role: "manager", parentSessionId: top });
      const pty = new PtyStub();
      pty.setLive(top);
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      sessions.handleKickoffGiveUpExhausted(child);
      check("(S4) role scoped exactly like notifyManagerOfIdleWorker: a non-worker/non-null role → no-op", pty.sent.length === 0);
    }

    // (S5) a role-less child (role: null) with a parent IS covered — same as the existing broken-spawn
    // nudge's own role-less fix (card df48366b) — proves the scope gate isn't accidentally worker-only.
    {
      const mgr = `kge-mgr5-${sfx}`, child = `kge-child5-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: child, role: null, parentSessionId: mgr });
      const pty = new PtyStub();
      pty.setLive(mgr);
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      sessions.handleKickoffGiveUpExhausted(child);
      check("(S5) role-less child (role:null) with a parent IS covered", pty.sent.filter((s) => s.id === mgr).length === 1);
    }

    // (S6) an unknown sessionId is a silent no-op, never a throw.
    {
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      let threw = false;
      try { sessions.handleKickoffGiveUpExhausted(`does-not-exist-${sfx}`); } catch { threw = true; }
      check("(S6) unknown sessionId: no-op, no throw", !threw && pty.sent.length === 0);
    }

    db.close();
  }
}
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card a8f8a8f2: the turn-1 kickoff's synthetic give-up origin now wires onGiveUpExhausted; two forced silent give-ups EXHAUST and fire it exactly once (never on the first, requeue-eligible give-up, and never when the second attempt genuinely lands); SessionService.handleKickoffGiveUpExhausted parks + notifies the manager through the SAME durable enqueueSystemNudge machinery every settle-nudge uses (persisted even when the manager is busy), naming worker_stop+worker_spawn and explicitly ruling out worker_message/worker_merge, scoped exactly like notifyManagerOfIdleWorker (worker/role-less covered, no-parent and other-role no-op), and never throws for an unknown session."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
