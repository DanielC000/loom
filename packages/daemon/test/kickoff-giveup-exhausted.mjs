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
//       `PtyHostEvents.onKickoffGiveUpExhausted(sessionId, msgId, rootMsgId, kickoffText)` hook.
//   (S) sessions/service.ts — `handleKickoffGiveUpExhausted` (wired via index.ts) decides who spawned this
//       session.
//
// Card 7772176d (2026-08-02) — THE ORIGINAL a8f8a8f2 FIX WENT STRAIGHT TO PARK+NOTIFY ON THE FIRST
// EXHAUSTION. Root-caused as the actual defect behind `f91c8634`'s stuck-turn-1 specimens: an ORDINARY
// durable message that exhausts its in-session requeue budget gets a further, cross-turn-boundary RE-MINT
// from `handleGiveUpExhausted` (below `GIVE_UP_REMINT_LIMIT`) before it ever parks; the kickoff had no
// equivalent. `handleKickoffGiveUpExhausted` now takes a `chainDepth` (default 0, mirrors
// `handleGiveUpExhausted`'s own pattern exactly): below `GIVE_UP_REMINT_LIMIT`, it RE-MINTS via a fresh,
// held `enqueueStdin` call (targeting the WORKER itself — a kickoff has no "sender" to notify mid-chain,
// unlike an ordinary message); at/above the limit, it falls through to the UNCHANGED park+notify path below.
// The re-mint carries `logicalId: rootMsgId` — the IDENTICAL key `requeueGiveUpOrigin` (pty/host.ts) already
// seeds into `Live.ambiguousDispatches` for the original write — so a later confirming hook for the ORIGINAL
// purges this still-queued re-mint through the EXISTING content-match machinery (card 4a0af485), the same
// protection every ordinary re-mint already relies on. See `kickoff-giveup-remint-purge.mjs` for that race
// proven against the REAL PtyHost purge, not a stub. HONEST SCOPE: this raises the kickoff to PARITY with
// `handleGiveUpExhausted`'s own re-mint, which is itself not proven reliable — this is "one more bounded
// attempt before park," not a guarantee, and it does not close `f91c8634` (whose other specimens are
// structurally outside `scheduleKickoffGuarantee`).
//
// The park+notify terminal branch (unchanged from a8f8a8f2/00bd3b4a) PARKS + NOTIFIES the manager through
// the SAME durable `enqueueSystemNudge` machinery every settle-nudge uses (never a bare fire-and-forget
// `pty.enqueueStdin`), naming the ONE known-good recovery (worker_stop + fresh worker_spawn) and explicitly
// ruling out worker_message/worker_merge.
//
// Card 00bd3b4a — this notice fired against a healthy, 35-turn-deep worker in production (Loom's own
// give-up budget is calibrated in seconds; the engine can confirm a write minutes late under load — pinned
// memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds`). TWO further fixes, both covered
// below by (S7)/(S8):
//   - `handleKickoffGiveUpExhausted` now takes `msgId`/`rootMsgId` (the synthetic origin's own ids) and
//     consults `pty.hasFirstTurnStarted(sessionId)` — a session that already confirmed a turn gets NO
//     destructive notice at all, regardless of what Loom's own give-up signal reads.
//   - the genuine-exhaustion case now records the SAME durable `session_message_gave_up`(outcome:"parked")
//     event `handleGiveUpExhausted`'s sibling park branch already records, keyed to `rootMsgId` — closing
//     the retraction gap where a later content-matched confirming hook (`handleGiveUpConfirmed`, the
//     ALREADY-CORRECT card-417cea0a machinery) had nothing durable to retract.
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
//   (S7) THE FALSE-POSITIVE CASE card 00bd3b4a IS ABOUT: hasFirstTurnStarted:true ⇒ NO notice at all, even
//        though the give-up budget genuinely exhausted.
//   (S8) THE RETRACTION GAP card 00bd3b4a CLOSES: a genuine exhaustion parks + notifies as before, records
//        a durable "parked" event keyed to rootMsgId, and a subsequent handleGiveUpConfirmed(rootMsgId) —
//        simulating the late confirming hook — now produces a [loom:redelivery-confirmed] follow-up.
//   (S9)-(S10) THE BOARD-SPECIFIED REFERENCE DISCRIMINATOR (manager directive, card f91c8634 — "busy:false
//        + EMPTY transcript" — NOT an invented signal): a real, non-empty on-disk transcript alone
//        suppresses the notice even with hasFirstTurnStarted never set (S9); an EXISTING but EMPTY
//        transcript does NOT suppress it — proves the check reads turn content, not file presence (S10).
//   (S1)-(S2), (S5), (S7)-(S10) above all drive `handleKickoffGiveUpExhausted` with an explicit
//        `chainDepth: TERMINAL_CHAIN_DEPTH` (= the default `GIVE_UP_REMINT_LIMIT`, 1, pinned as a named
//        local so it can't silently drift from the constant it mirrors) — they test the TERMINAL
//        park+notify shape + the guards, which are unaffected by the NEW re-mint step; passing the
//        post-re-mint chainDepth directly exercises that terminal branch without needing every one of
//        these tests to also drive the re-mint step first.
//   (S11) Card 7772176d NEW: chainDepth OMITTED (defaults to 0, the REAL production entry point) — the
//        FIRST exhaustion RE-MINTS, not parks: the manager gets NO notice at all, the worker itself
//        receives a held `enqueueStdin` carrying the possible-duplicate-tagged kickoff text, and a
//        `session_message_gave_up` (outcome:"reminted") event is recorded.
//   (S12) Card 7772176d NEW, continuing (S11): invoking the re-mint's OWN recorded `onGiveUpExhausted`
//        callback (simulating ITS exhaustion, chainDepth 1) now produces the terminal park+notify —
//        proving the two-phase chain (re-mint once, THEN park) end to end at the SessionService layer.
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
// Card 00bd3b4a (S9/S10): the new transcript-based discriminator reads real files off os.homedir()
// (engineTranscriptPath — see sessions/transcript.ts). Sandbox HOME/USERPROFILE BEFORE anything reads
// it, so this suite never touches the real ~/.claude/projects (mirrors companion-transcript-read.mjs's
// own convention).
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
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
    // Card b9b8f8db: cycle 2 is a redelivery of the SAME already-attempted message (giveUpGen set by
    // cycle 1's own requeue) — submit() now retries ONLY the Enter for that case, never re-pasting the
    // body (the composer-runaway fix). So the body lands physically ONCE, not once per cycle; a REAL
    // second Enter attempt still happens (proven by the two separate GIVE-UP RECOVERY logs above).
    check("(H1) the kickoff body was written to the pty exactly ONCE — cycle 2 retried only the Enter, per card b9b8f8db",
      bodyCount(KICKOFF) === 1);
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
  const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
  // (S11) needs to know the EXACT root label `framePossibleDuplicate` embeds in its tag — that label is
  // `rootMsgId.slice(0,8)` ONLY when it looks hex-ish, else a content hash (see the function's own doc) —
  // so this imports the REAL function rather than assuming a test-chosen rootMsgId's shape.
  const { possibleDuplicateRootLabel } = await import("../dist/pty/host.js");

  /** Writes a real transcript JSONL to the (sandboxed) `~/.claude/projects/...` path `readTranscript`
   *  resolves — mirrors companion-transcript-read.mjs's own `writeLiveTranscript` fixture helper. */
  function writeLiveTranscript(cwd, engineSessionId, turnTexts) {
    const file = engineTranscriptPath(cwd, engineSessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, turnTexts.map((t, i) =>
      JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: t }] } })
    ).join("\n") + "\n");
  }

  const NOW = new Date();
  const now = NOW.toISOString();
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  // Card 7772176d: `handleKickoffGiveUpExhausted` no longer parks on the FIRST exhaustion — it re-mints
  // below `GIVE_UP_REMINT_LIMIT` (default 1, unset here) and only parks once `chainDepth` reaches it. Named
  // so it's obvious WHY each (S) call below passes it, rather than a bare magic `1`.
  const TERMINAL_CHAIN_DEPTH = 1;

  /** Minimal contract-faithful PtyStub — just enough for enqueueDurableMessage/enqueueSystemNudge's
   *  full enqueueStdin signature (mirrors give-up-exhausted-durable.mjs's own PtyStub). Card 00bd3b4a:
   *  `hasFirstTurnStarted` (default false, per-session settable) lets (S7)/(S8) below drive
   *  `handleKickoffGiveUpExhausted`'s new discriminator check directly, without needing a real pty. */
  class PtyStub {
    constructor() { this.live = new Set(); this.busy = new Set(); this.sent = []; this.firstTurnStarted = new Set(); }
    setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
    setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
    setFirstTurnStarted(id, on = true) { if (on) this.firstTurnStarted.add(id); else this.firstTurnStarted.delete(id); }
    hasFirstTurnStarted(id) { return this.firstTurnStarted.has(id); }
    // Card 3f09f9ce: position 11 also accepts the real enqueueStdin's options-object tail overload
    // (production's `enqueueDurableMessage` migrated to it) — discriminate by shape, same as the real impl.
    // Card 7772176d: `sent` entries now also carry the tail's `onGiveUpExhausted` (when present) — (S12)
    // needs to retrieve and invoke the RE-MINT's own callback directly, to simulate ITS exhaustion, the
    // same way the real PtyHost would when that held entry's own give-up budget runs out.
    enqueueStdin(id, text, _source = "system", onDeliver, _route, _kind, _questionId, _ownerText, _proactive, _senderId, tail) {
      const isTailObject = typeof tail === "object" && tail !== null;
      const giveUpHeldUntil = isTailObject ? tail.giveUpHeldUntil : tail;
      const onGiveUpExhausted = isTailObject ? tail.onGiveUpExhausted : undefined;
      this.sent.push({ id, text, onGiveUpExhausted });
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

      sessions.handleKickoffGiveUpExhausted(wkr, `msg-s1-${sfx}`, `root-s1-${sfx}`, `kickoff-s1-${sfx}`, TERMINAL_CHAIN_DEPTH);
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
      // Card 00bd3b4a manager DIRECTIVE #2: the notice now shares ONE hedge idiom with the pre-existing
      // [loom:redelivery-parked] notice (give-up-exhausted-durable.mjs's own (417cea0a #2) checks) instead
      // of asserting unhedged certainty — same phrasing, same posture, not a bespoke second convention.
      check("(S1) leads the recovery with the NON-DESTRUCTIVE check (worker_transcript) before naming worker_stop",
        !!note && note.indexOf("worker_transcript") >= 0 && note.indexOf("worker_transcript") < note.indexOf("worker_stop"));
      check("(S1) the confirmed-after-park follow-up is HEDGED ('MAY follow up'), never promised",
        !!note && /MAY follow up/.test(note) && !/Loom will (tell you|follow up)/i.test(note));
      check("(S1) the corollary is stated: no follow-up is NOT evidence the kickoff failed",
        !!note && /not evidence the kickoff failed/i.test(note));
      check("(S1) no longer asserts unverifiable certainty ('nothing began at all')",
        !!note && !/nothing began at all/i.test(note));
    }

    // (S2) DURABLE, not fire-and-forget: a BUSY manager still gets a persisted session_message_queued record.
    {
      const mgr = `kge-mgr2-${sfx}`, wkr = `kge-wkr2-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
      const pty = new PtyStub();
      pty.setLive(mgr); pty.setBusy(mgr); // busy manager → the notice must be HELD, not lost
      const sessions = new SessionService(db, pty, new OrchestrationControl());

      sessions.handleKickoffGiveUpExhausted(wkr, `msg-s2-${sfx}`, `root-s2-${sfx}`, `kickoff-s2-${sfx}`, TERMINAL_CHAIN_DEPTH);
      check("(S2) DURABLE: a session_message_queued event was persisted for the held notice",
        db.listEventsForWorker(mgr).some((e) => e.kind === "session_message_queued" && e.detail?.text?.includes("worker-spawn-broken")));
    }

    // (S3) no parentSessionId at all → no natural recipient → no-op (mirrors notifyManagerOfIdleWorker's own gate).
    {
      const wkr = `kge-wkr3-${sfx}`;
      mkSession({ id: wkr, role: "worker", parentSessionId: null });
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      sessions.handleKickoffGiveUpExhausted(wkr, `msg-s3-${sfx}`, `root-s3-${sfx}`, `kickoff-s3-${sfx}`);
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
      sessions.handleKickoffGiveUpExhausted(child, `msg-s4-${sfx}`, `root-s4-${sfx}`, `kickoff-s4-${sfx}`);
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
      sessions.handleKickoffGiveUpExhausted(child, `msg-s5-${sfx}`, `root-s5-${sfx}`, `kickoff-s5-${sfx}`, TERMINAL_CHAIN_DEPTH);
      check("(S5) role-less child (role:null) with a parent IS covered", pty.sent.filter((s) => s.id === mgr).length === 1);
    }

    // (S6) an unknown sessionId is a silent no-op, never a throw.
    {
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      let threw = false;
      try { sessions.handleKickoffGiveUpExhausted(`does-not-exist-${sfx}`, `msg-s6-${sfx}`, `root-s6-${sfx}`, `kickoff-s6-${sfx}`); } catch { threw = true; }
      check("(S6) unknown sessionId: no-op, no throw", !threw && pty.sent.length === 0);
    }

    // (S7) THE FALSE-POSITIVE CASE THIS CARD IS ABOUT: a healthy, turn-producing session (the pty reports
    // hasFirstTurnStarted:true) whose kickoff give-up budget ALSO happens to exhaust must NOT get the
    // destructive [loom:worker-spawn-broken] notice — the session already proved the kickoff was received.
    // RED against pre-fix code (which never consulted hasFirstTurnStarted at all and always fired).
    {
      const mgr = `kge-mgr7-${sfx}`, wkr = `kge-wkr7-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: `tk-kge7-${sfx}` });
      const pty = new PtyStub();
      pty.setLive(mgr);
      pty.setFirstTurnStarted(wkr, true); // the discriminator: this session already confirmed a turn
      const sessions = new SessionService(db, pty, new OrchestrationControl());

      sessions.handleKickoffGiveUpExhausted(wkr, `msg-s7-${sfx}`, `root-s7-${sfx}`, `kickoff-s7-${sfx}`);
      check("(S7) DISCRIMINATOR: a session that already confirmed its first turn gets NO worker-spawn-broken notice",
        pty.sent.filter((s) => s.id === mgr && s.text.includes("[loom:worker-spawn-broken]")).length === 0);
      check("(S7) nothing dispatched to the manager at all for this (healthy) case", pty.sent.filter((s) => s.id === mgr).length === 0);
    }

    // (S8) THE RETRACTION GAP THIS CARD CLOSES: a genuine exhaustion (hasFirstTurnStarted:false) parks +
    // notifies as before, but NOW records a durable session_message_gave_up("parked") event keyed to the
    // same rootMsgId a later content-matched confirming hook reports — so when that late confirmation
    // arrives (handleGiveUpConfirmed, the ALREADY-CORRECT card-417cea0a retraction machinery), it can
    // actually find something to retract instead of silently no-op'ing. RED against pre-fix code (which
    // never appended that event, so handleGiveUpConfirmed always found nothing here).
    {
      const mgr = `kge-mgr8-${sfx}`, wkr = `kge-wkr8-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: `tk-kge8-${sfx}` });
      const pty = new PtyStub();
      pty.setLive(mgr);
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const rootMsgId = `root-s8-${sfx}`;

      sessions.handleKickoffGiveUpExhausted(wkr, `msg-s8-${sfx}`, rootMsgId, `kickoff-s8-${sfx}`, TERMINAL_CHAIN_DEPTH);
      check("(S8) setup: the genuine-exhaustion case still parks + notifies (unchanged behavior)",
        pty.sent.some((s) => s.id === mgr && s.text.includes("[loom:worker-spawn-broken]")));
      check("(S8) setup: the park was recorded durably, keyed to this exact rootMsgId",
        db.listEventsForWorker(wkr).some((e) => e.kind === "session_message_gave_up" && e.detail?.rootMsgId === rootMsgId && e.detail?.outcome === "parked"));

      // The late confirmation arrives — content-matched against the SAME rootMsgId (this is exactly what
      // requeueGiveUpOrigin's ambiguousDispatches seeding + purgeConfirmedGiveUpRequeue's content match do
      // in production; this test drives the DB-level consumer directly, as (S1)-(S7) already do for the
      // sibling park path).
      sessions.handleGiveUpConfirmed(wkr, rootMsgId, 232_000);
      // Card 00bd3b4a: anchored on startsWith, not a bare substring — the ORIGINAL worker-spawn-broken
      // notice above ITSELF mentions the literal "[loom:redelivery-confirmed]" tag as its own hedge (the
      // "Loom MAY follow up with a […] notice" sentence), so a bare .includes() would wrongly match both
      // messages. The real retraction notice (mirrors handleGiveUpConfirmed's own sibling notice, see
      // give-up-exhausted-durable.mjs's (9)) begins with the tag; the hedge only mentions it mid-sentence.
      const retraction = pty.sent.filter((s) => s.id === mgr && s.text.startsWith("[loom:redelivery-confirmed]"));
      check("(S8) RETRACTION: the manager now gets a [loom:redelivery-confirmed] follow-up for the kickoff path",
        retraction.length === 1);
      check("(S8) the retraction names the worker + root (sliced, mirrors the sibling notice's own format)",
        !!retraction[0] && retraction[0].text.includes(wkr.slice(0, 8)) && retraction[0].text.includes(rootMsgId.slice(0, 8)));
    }

    // (S9) THE BOARD-SPECIFIED REFERENCE DISCRIMINATOR (manager DIRECTIVE #1, card f91c8634): a session
    // with hasFirstTurnStarted:false (the (S7) signal alone would NOT suppress this) but a REAL, non-empty
    // on-disk transcript (the SAME artifact worker_transcript exposes, and the one that refuted this exact
    // notice in production) must STILL get NO destructive notice — proving the transcript read is now
    // independently consulted, not just the pty-level hook flag.
    {
      const mgr = `kge-mgr9-${sfx}`, wkr = `kge-wkr9-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: `tk-kge9-${sfx}` });
      writeLiveTranscript(os.tmpdir(), `eng-${wkr}`, ["orchestrate task tk-kge9", "on it — reading the card now"]);
      const pty = new PtyStub();
      pty.setLive(mgr); // hasFirstTurnStarted NOT set — the transcript alone must carry this
      const sessions = new SessionService(db, pty, new OrchestrationControl());

      sessions.handleKickoffGiveUpExhausted(wkr, `msg-s9-${sfx}`, `root-s9-${sfx}`, `kickoff-s9-${sfx}`);
      check("(S9) TRANSCRIPT DISCRIMINATOR: a non-empty on-disk transcript alone suppresses the notice (hasFirstTurnStarted was never set)",
        pty.sent.filter((s) => s.id === mgr).length === 0);
    }

    // (S10) NEGATIVE CONTROL for (S9): a transcript file that EXISTS but is EMPTY (zero parsed turns) must
    // NOT suppress the notice — proves the check reads actual turn content, not mere file presence.
    {
      const mgr = `kge-mgr10-${sfx}`, wkr = `kge-wkr10-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: `tk-kge10-${sfx}` });
      writeLiveTranscript(os.tmpdir(), `eng-${wkr}`, []); // file exists, zero turns
      const pty = new PtyStub();
      pty.setLive(mgr);
      const sessions = new SessionService(db, pty, new OrchestrationControl());

      sessions.handleKickoffGiveUpExhausted(wkr, `msg-s10-${sfx}`, `root-s10-${sfx}`, `kickoff-s10-${sfx}`, TERMINAL_CHAIN_DEPTH);
      check("(S10) NEGATIVE CONTROL: an EXISTING but EMPTY transcript does NOT suppress — the genuine-exhaustion notice still fires",
        pty.sent.some((s) => s.id === mgr && s.text.includes("[loom:worker-spawn-broken]")));
    }

    // (S11) Card 7772176d NEW: chainDepth OMITTED (defaults to 0 — the REAL production entry point). The
    // FIRST exhaustion must RE-MINT, not park: no manager notice at all, a held enqueueStdin targeting the
    // WORKER ITSELF carrying the possible-duplicate-tagged kickoff text, and a "reminted" event recorded.
    // RED against pre-7772176d code (which parked immediately here — this is the exact behavior change).
    {
      const mgr = `kge-mgr11-${sfx}`, wkr = `kge-wkr11-${sfx}`;
      const KICKOFF_TEXT = `orchestrate task tk-kge11-${sfx}`;
      const rootMsgId = `root-s11-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: `tk-kge11-${sfx}` });
      const pty = new PtyStub();
      pty.setLive(mgr); pty.setLive(wkr); // worker itself must be "live" to receive the re-mint's enqueueStdin
      const sessions = new SessionService(db, pty, new OrchestrationControl());

      sessions.handleKickoffGiveUpExhausted(wkr, `msg-s11-${sfx}`, rootMsgId, KICKOFF_TEXT); // chainDepth omitted → 0
      check("(S11) THE FIX: the FIRST exhaustion does NOT notify the manager at all", pty.sent.filter((s) => s.id === mgr).length === 0);
      const toWkr = pty.sent.filter((s) => s.id === wkr);
      check("(S11) THE FIX: instead, the WORKER ITSELF received exactly one re-mint dispatch", toWkr.length === 1);
      check("(S11) the re-mint carries the possible-duplicate tag naming the SAME rootMsgId (not a fresh chain)",
        toWkr[0]?.text?.includes("[loom:possible-duplicate") && toWkr[0].text.includes(possibleDuplicateRootLabel(rootMsgId)));
      check("(S11) the re-mint still carries the real kickoff content underneath the tag", toWkr[0]?.text?.includes(KICKOFF_TEXT));
      check("(S11) the re-mint recorded its own onGiveUpExhausted callback (needed to reach S12's terminal park)",
        typeof toWkr[0]?.onGiveUpExhausted === "function");
      check("(S11) AUDITABLE: a session_message_gave_up(outcome:reminted) event was recorded, naming the real re-mint msgId",
        db.listEventsForWorker(wkr).some((e) => e.kind === "session_message_gave_up" && e.detail?.rootMsgId === rootMsgId && e.detail?.outcome === "reminted" && typeof e.detail?.remintedAs === "string"));

      // (S12) continuing (S11): invoke the re-mint's OWN recorded onGiveUpExhausted callback — simulating
      // the real PtyHost calling it once THIS held entry's own give-up budget also runs out (chainDepth 1,
      // >= GIVE_UP_REMINT_LIMIT's default of 1) — NOW the terminal park+notify must fire.
      toWkr[0].onGiveUpExhausted();
      const toMgrAfter = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
      check("(S12) THE CHAIN COMPLETES: the re-mint's own exhaustion NOW notifies the manager", toMgrAfter.length === 1);
      check("(S12) uses the established [loom:worker-spawn-broken] signal", !!toMgrAfter[0] && toMgrAfter[0].includes("[loom:worker-spawn-broken]"));
      check("(S12) the terminal park event's chainDepth reached TERMINAL_CHAIN_DEPTH (one re-mint happened, not zero, not two)",
        db.listEventsForWorker(wkr).some((e) => e.kind === "session_message_gave_up" && e.detail?.rootMsgId === rootMsgId && e.detail?.outcome === "parked" && e.detail?.chainDepth === TERMINAL_CHAIN_DEPTH));
      check("(S12) exactly ONE reminted + ONE parked event for this rootMsgId (a bounded chain, not a loop)",
        db.listEventsForWorker(wkr).filter((e) => e.kind === "session_message_gave_up" && e.detail?.rootMsgId === rootMsgId).length === 2);
    }

    db.close();
  }
}
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card a8f8a8f2: the turn-1 kickoff's synthetic give-up origin now wires onGiveUpExhausted; two forced silent give-ups EXHAUST and fire it exactly once (never on the first, requeue-eligible give-up, and never when the second attempt genuinely lands). Card 00bd3b4a: a session that already confirmed its first turn gets NO destructive notice (S7), a genuine exhaustion (chainDepth at the terminal limit) still records a durable parked event a later content-matched confirmation can retract via a [loom:redelivery-confirmed] follow-up (S8), and the board-specified reference discriminator (card f91c8634 — non-empty on-disk transcript) independently suppresses the notice (S9) while an existing-but-empty transcript does not (S10). Card 7772176d: the FIRST exhaustion (chainDepth 0, the real production entry point) now RE-MINTS instead of parking immediately — no manager notice, a held re-mint dispatched to the worker itself carrying the possible-duplicate tag (S11) — and only the re-mint's OWN subsequent exhaustion produces the terminal [loom:worker-spawn-broken] park+notify, unchanged in shape, naming worker_stop+worker_spawn and explicitly ruling out worker_message/worker_merge (S12), scoped exactly like notifyManagerOfIdleWorker (worker/role-less covered, no-parent and other-role no-op), and never throws for an unknown session."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
