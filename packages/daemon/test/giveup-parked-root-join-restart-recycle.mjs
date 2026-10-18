import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression test for card 3b420e0d — two pre-existing gaps in `joinedOntoParkedRoot` (card a5987cf3's
// "the duplicate-parked override must require joined-onto-an-ALREADY-parked-root" flag), found in a5987cf3's
// own CR (session 58c331cf), fixed under a5987cf3's "Round 2" section (docs/decisions/
// a5987cf3-joined-onto-parked-root-not-mere-autojoin.md):
//
//   (1) `redriveQueuedMessage` (the daemon-restart/boot redrive path) and `carryPendingToSuccessor` (the
//       worker/manager/platform-lead recycle carry path, BOTH its happy-path re-mint and its mint-failure
//       re-arm) called `handleGiveUpExhausted` without `joinedOntoParkedRoot`, and the persisted `session_message_queued`
//       detail never carried it either — so a restart or recycle inside a resend's give-up window silently
//       dropped the flag back to its default `false`, wrongly suppressing the resend's own eventual park as
//       a moot "duplicate-parked" of the root's earlier park.
//   (2) An explicit `resendOf` (a manager citing the exact rootMsgId of an earlier directive it is
//       RE-SENDING — see `messageWorker`'s own doc) forced `autoJoinedId` to `undefined`
//       (`enqueueDurableMessage`'s own join-priority order), so `bypassOwnershipGateOnce` — and therefore
//       `joinedOntoParkedRoot`, which reused it verbatim — could never be true for a `resendOf`-only
//       dispatch, even one naming an ALREADY-parked root. A `resendOf` is a MORE deliberate assertion of
//       "this is a resend of that parked chain" than an inferred content-match auto-join, so excluding it
//       was a two-path asymmetry against card a5987cf3's own stated intent.
//
// THE FIX: `joinedOntoParkedRoot` is persisted in the `session_message_queued` detail and threaded,
// VERBATIM (never re-derived), through all three affected call sites. Separately, `joinedOntoParkedRoot`'s
// fresh component widens to `bypassOwnershipGateOnce || (ctx.resendOf != null &&
// isRootParked(recipientId, ctx.resendOf))` — a second, independent disjunct. `bypassOwnershipGateOnce`
// itself (the round-4 write bypass, card 844ca34e) stays BYTE-UNCHANGED: its safety depends on
// `hasAmbiguousMatch` having content-matched the CURRENT dispatch against what may physically still be
// sitting in the composer, a guarantee a manager-cited `resendOf` does not carry — extending the WRITE
// bypass to it would risk pressing Enter against a different lineage's real unconfirmed content.
//
// Six scenarios (card 3b420e0d's test plan, scenario (5) dropped as redundant with (6)):
//   (1) RESTART: a resend-of-a-parked-root dispatch is redriven onto a FRESH PtyHost-equivalent (simulating
//       a daemon restart via `recoverUndeliveredMessagesOnBoot`) and its own eventual park is unsuppressed.
//   (2) RECYCLE (happy path): the same dispatch is carried onto a fresh successor via the REAL
//       `recycleWorker` and its own eventual park (on the successor) is unsuppressed.
//   (3) RECYCLE (mint-failure re-arm): forcing the carry's re-mint to throw (a minimal TEST-side `Db`
//       stub — no production seam) re-arms the record back onto the (still-live, for this isolated call)
//       predecessor, which still carries the flag — exercising the branch a manager or platform-lead
//       recycle reaches live in production (see the scenario's own header below for why this calls
//       `carryPendingToSuccessor` directly rather than driving it through a worker recycle).
//   (4) GAP 2: an explicit `resendOf` alone (no content match at all — this harness doesn't even implement
//       `hasAmbiguousMatch`) exempts the resend's own park, PLUS a recipient-scoping check: the SAME
//       resendOf id cited on a DIFFERENT recipient gets NO exemption (`isRootParked` is recipientId-scoped).
//   (6) NEGATIVE CONTROL: `resendOf` naming a root that is only RE-MINTED (not yet parked) gets NO
//       exemption — mirrors `pty-giveup-resend-bypass-unsuppressed-park.mjs`'s own analogous negative for
//       `bypassOwnershipGateOnce`.
//   (7) `bypassOwnershipGateOnce` stays byte-unchanged: a resendOf-only join never sets it.
//
// Scenario (3) calls the compiled `SessionService.prototype.carryPendingToSuccessor` DIRECTLY. TypeScript's
// `private` is erased at compile time — this is an ordinary method on the emitted class. The re-arm's own
// `enqueueStdin` onto the predecessor DOES land live in production for a manager or platform-lead recycle
// (`attemptPendingQueueCarry`/`recyclePlatformLead`, service.ts ~15112/~15743 — both carry the queue BEFORE
// `settleRecycleHandoff` hard-stops the predecessor) — but `recycleWorker` specifically hard-stops its
// predecessor BEFORE calling this method at all, so a worker-recycle harness (as used in scenario (2))
// could never reach this branch with a live re-arm target. Calling the method directly, with the
// predecessor still marked live in this isolated call, is what lets this scenario force and observe the
// mint-failure branch deterministically, per the approved plan ("a minimal Db/enqueue throw stub inside
// the TEST is fine... do not add a production seam").
//
// RUN (daemon must be built first — reads ../dist/*.js): from packages/daemon,
//   pnpm build && node test/giveup-parked-root-join-restart-recycle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME BEFORE importing db.js/service.js (paths.ts reads it at import time).
const tmpHome = path.join(os.tmpdir(), `loom-giveup-parked-root-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Pin small so the re-mint->park chain is fast and deterministic — read once at service.ts module load.
process.env.LOOM_GIVE_UP_REMINT_LIMIT = "2";
const REMINT_LIMIT = 2;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Merges give-up-exhausted-durable.mjs's PtyStub (enqueueStdin/giveUpOn wiring, faithful to the real
// host's onDeliver-then-onGiveUpExhausted ordering) with recycle-giveup-hold.mjs's recycle-support methods
// (spawn/stop/isAlive/getPid/captureLiveRef/flushPending/pendingEntries) — this file needs both a give-up/
// park cycle AND a real `recycleWorker` carry in the same harness. `hasAmbiguousMatch` is deliberately NOT
// implemented (every dispatch here uses an explicit `resendOf`, never content-match auto-join), so
// `enqueueDurableMessage`'s defensive `typeof` guard takes its documented degraded (self-rooting) branch
// for anything that doesn't pass `resendOf` — exactly as intended for this file's scope.
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.sent = []; }
  setLive(id, on = true) { if (on) this.live.add(id); else { this.live.delete(id); this.busy.delete(id); } }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  enqueueStdin(id, text, _source = "system", onDeliver, _route, _kind, _questionId, _ownerText, _proactive, _senderId, tail, onGiveUpExhaustedPositional) {
    const isTailObject = typeof tail === "object" && tail !== null;
    const giveUpHeldUntil = isTailObject ? tail.giveUpHeldUntil : tail;
    const onGiveUpExhausted = isTailObject ? tail.onGiveUpExhausted : onGiveUpExhaustedPositional;
    const bypassOwnershipGateOnce = isTailObject ? tail.bypassOwnershipGateOnce === true : false;
    this.sent.push({ id, text, bypassOwnershipGateOnce });
    if (!this.live.has(id)) return { delivered: false, reason: "session-dead", queued: false };
    const stillGiveUpHeld = giveUpHeldUntil !== undefined && Date.now() < giveUpHeldUntil;
    if (!this.busy.has(id) && !stillGiveUpHeld) return { delivered: true };
    const a = this.q.get(id) ?? []; a.push({ text, onDeliver, onGiveUpExhausted }); this.q.set(id, a);
    return { delivered: false, position: a.length, queued: true, landsAt: "next-turn-boundary" };
  }
  giveUpOn(id) {
    this.busy.delete(id);
    const a = this.q.get(id) ?? []; const m = a.shift();
    if (!m) return undefined;
    if (m.onDeliver) m.onDeliver();
    if (m.onGiveUpExhausted) m.onGiveUpExhausted();
    return m.text;
  }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
  flushPending(id) { const a = this.q.get(id) ?? []; this.q.set(id, []); return a; }
  pendingEntries(id) { return this.q.get(id) ?? []; }
  getPersistablePendingSnapshot(id) { return { texts: (this.q.get(id) ?? []).filter((m) => !m.onDeliver).map((m) => m.text), holds: {} }; }
  waitForMcpSeen() { return Promise.resolve(true); }
  purgeQueuedWorkerIdleNudges() { /* no-op — real recycleWorker wraps this call in try/catch anyway */ }
  spawn(opts) { this.setLive(opts.sessionId); this.setBusy(opts.sessionId); }
  stop(id) { this.setLive(id, false); }
  isAlive(id) { return this.live.has(id); }
  getPid(_id) { return undefined; } // recycleWorker's own "no pid -> proceed" branch (mirrors recycle-giveup-hold.mjs)
  captureLiveRef(_id) { return undefined; }
}

const db = new Db();
const proj = `gprr-proj-${sfx}`, agent = `gprr-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "BRIEF", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: o.worktreePath ?? null, branch: o.branch ?? null, recycledFrom: o.recycledFrom ?? null, gen: o.gen ?? 0,
});
const gaveUpEventsFor = (recipientId) => db.listEventsForWorker(recipientId).filter((e) => e.kind === "session_message_gave_up");
const parkChainOn = (pty, id) => { for (let i = 0; i <= REMINT_LIMIT; i++) pty.giveUpOn(id); };

try {
  // ===== (1) RESTART: a resend-of-a-parked-root's joinedOntoParkedRoot flag survives redrive via =====
  // ===== recoverUndeliveredMessagesOnBoot on a FRESH PtyStub (simulating a daemon restart) ============
  {
    const ptyA = new PtyStub();
    const sessionsA = new SessionService(db, ptyA, new OrchestrationControl());
    const mgr = `g1-mgr-${sfx}`, wkr = `g1-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    ptyA.setLive(mgr); ptyA.setBusy(mgr, false);
    ptyA.setLive(wkr); ptyA.setBusy(wkr);

    sessionsA.messageWorker(mgr, wkr, "G1_A_PARKS_FIRST");
    parkChainOn(ptyA, wkr);
    // A and B's own eventual park BOTH carry rootMsgId===rootA (B joins via resendOf) and both land under
    // the SAME recipient (restart never changes workerSessionId) — so a park's own `msgId` never
    // disambiguates which chain it belongs to (A's final msgId isn't rootA either, since A itself re-mints
    // before parking). Snapshot A's own event ids NOW so B's later park can be found by EXCLUSION.
    const aEventIds = new Set(gaveUpEventsFor(wkr).map((e) => e.id));
    const rootA = [...gaveUpEventsFor(wkr)].find((e) => e.detail?.outcome === "parked")?.detail?.rootMsgId;
    check("(1) setup: A parked on the predecessor before any restart", !!rootA);

    ptyA.setBusy(wkr, true); // giveUpOn cleared busy; re-mark so B's own dispatch is HELD (durable)
    const rB = sessionsA.messageWorker(mgr, wkr, "G1_B_RESEND_OF_PARKED_A", rootA);
    check("(1) setup: B held on the predecessor, resendOf citing the parked root", rB.delivered === false);
    const recBPre = db.listUnresolvedQueuedMessagesForWorker(wkr).find((e) => e.detail?.msgId === rB.msgId);
    check("(1) setup: B's persisted record carries joinedOntoParkedRoot:true BEFORE any restart", recBPre?.detail?.joinedOntoParkedRoot === true);

    // Simulate a daemon restart: a FRESH PtyHost-equivalent + a FRESH SessionService over the SAME Db.
    const ptyB = new PtyStub();
    const sessionsB = new SessionService(db, ptyB, new OrchestrationControl());
    ptyB.setLive(mgr); ptyB.setBusy(mgr, false);
    ptyB.setLive(wkr); ptyB.setBusy(wkr);

    const { reEnqueued } = sessionsB.recoverUndeliveredMessagesOnBoot();
    check("(1) THE RESTART: B's still-undelivered record was redriven onto the fresh pty", reEnqueued >= 1);

    parkChainOn(ptyB, wkr);
    const bParked = [...gaveUpEventsFor(wkr)].find((e) => e.detail?.outcome === "parked" && e.detail?.rootMsgId === rootA && !aEventIds.has(e.id));
    check("(1) B parked (post-restart), chained to A's original root", !!bParked);
    check("(1) THE FIX: B's own park notice is NOT suppressed as duplicate-parked — joinedOntoParkedRoot survived the restart", bParked?.detail?.noticeSuppressed !== true);
  }

  // ===== (2) RECYCLE (happy path): the flag survives carryPendingToSuccessor's re-mint via the REAL =====
  // ===== recycleWorker, onto a fresh successor ==========================================================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `g2-mgr-${sfx}`, wkrOld = `g2-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkrOld, role: "worker", parentSessionId: mgr, worktreePath: os.tmpdir(), branch: "loom/g2" });
    pty.setLive(mgr); pty.setBusy(mgr, false);
    pty.setLive(wkrOld); pty.setBusy(wkrOld);

    sessions.messageWorker(mgr, wkrOld, "G2_A_PARKS_FIRST");
    parkChainOn(pty, wkrOld);
    const rootA = gaveUpEventsFor(wkrOld).find((e) => e.detail?.outcome === "parked")?.detail?.rootMsgId;
    check("(2) setup: A parked on the predecessor", !!rootA);

    pty.setBusy(wkrOld, true);
    const rB = sessions.messageWorker(mgr, wkrOld, "G2_B_RESEND_OF_PARKED_A", rootA);
    check("(2) setup: B held on the predecessor, resendOf citing the parked root", rB.delivered === false);
    const recBPre = db.listUnresolvedQueuedMessagesForWorker(wkrOld).find((e) => e.detail?.msgId === rB.msgId);
    check("(2) setup: B's persisted record carries joinedOntoParkedRoot:true BEFORE the recycle", recBPre?.detail?.joinedOntoParkedRoot === true);

    const fresh = await sessions.recycleWorker(mgr, wkrOld, "handoff: B is a deliberate resend of a parked root, keep driving it");
    const recBOnSuccessor = db.listUnresolvedQueuedMessagesForWorker(fresh.id).find((e) => e.detail?.text?.includes("G2_B_RESEND_OF_PARKED_A"));
    check("(2) B's durable record was carried onto the successor", !!recBOnSuccessor);
    check("(2) THE FIX: the carried record still carries joinedOntoParkedRoot:true on the successor", recBOnSuccessor?.detail?.joinedOntoParkedRoot === true);

    // `suppressMootParkNotice`/`isRootParked` are BOTH scoped to `db.listEventsForWorker(recipientId)` —
    // a recycle changes the recipient (wkrOld -> fresh.id), so A's own earlier park (filed under wkrOld)
    // is structurally invisible to the successor's own event history, and once A is terminally parked it
    // has no durable record left to carry either. So a "duplicate-parked" baseline can only ever exist
    // under fresh.id's OWN history, never inherited automatically from the predecessor — a REAL duplicate
    // on the successor would arise from a second, independent chain (another resend, or a second recycle
    // of the same lineage) also parking there. Seed that exact precondition directly (test-side DB event,
    // not a production seam) so the carried `joinedOntoParkedRoot` override has something real to prove
    // against — without this, B's park would go unsuppressed EITHER WAY, proving nothing about the carry.
    db.appendEvent({
      id: `g2-synthetic-prior-park-${sfx}`, ts: new Date().toISOString(),
      managerSessionId: mgr, workerSessionId: fresh.id, taskId: null,
      kind: "session_message_gave_up",
      detail: { msgId: `g2-synthetic-msg-${sfx}`, rootMsgId: rootA, chainDepth: REMINT_LIMIT, outcome: "parked" },
    });
    check("(2) setup: the successor's OWN event history now independently carries an earlier park for rootA",
      gaveUpEventsFor(fresh.id).some((e) => e.detail?.outcome === "parked" && e.detail?.rootMsgId === rootA));

    parkChainOn(pty, fresh.id);
    const bParked = gaveUpEventsFor(fresh.id).find((e) => e.detail?.outcome === "parked" && e.detail?.rootMsgId === rootA && e.id !== `g2-synthetic-prior-park-${sfx}`);
    check("(2) B parked on the successor, chained to A's original root", !!bParked);
    check("(2) THE FIX: B's own park notice is NOT suppressed as duplicate-parked DESPITE a real competing prior park on the SAME successor — joinedOntoParkedRoot survived the recycle carry", bParked?.detail?.noticeSuppressed !== true);
  }

  // ===== (3) RECYCLE (mint-failure re-arm): forcing the re-mint to throw re-arms the record onto the =====
  // ===== (still-live, for this isolated call) predecessor, which still carries the flag ================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `g3-mgr-${sfx}`, oldId = `g3-old-${sfx}`, successorId = `g3-succ-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: oldId, role: "worker", parentSessionId: mgr });
    mkSession({ id: successorId, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setBusy(mgr, false);
    pty.setLive(oldId); pty.setBusy(oldId);
    pty.setLive(successorId); pty.setBusy(successorId); // busy -> the re-mint attempt takes the HELD path

    sessions.messageWorker(mgr, oldId, "G3_A_PARKS_FIRST");
    parkChainOn(pty, oldId);
    const aEventIds = new Set(gaveUpEventsFor(oldId).map((e) => e.id));
    const rootA = [...gaveUpEventsFor(oldId)].find((e) => e.detail?.outcome === "parked")?.detail?.rootMsgId;
    check("(3) setup: A parked on the predecessor", !!rootA);

    pty.setBusy(oldId, true);
    const rB = sessions.messageWorker(mgr, oldId, "G3_B_RESEND_OF_PARKED_A_FOR_REARM", rootA);
    check("(3) setup: B held on the predecessor, resendOf citing the parked root", rB.delivered === false);
    const durableRecords = db.listUnresolvedQueuedMessagesForWorker(oldId);
    check("(3) setup: exactly B's durable record is present, carrying joinedOntoParkedRoot:true",
      durableRecords.length === 1 && durableRecords[0].detail?.joinedOntoParkedRoot === true);

    // Minimal TEST-side Db stub — throws exactly once, only for the SUCCESSOR's own session_message_queued
    // persist — simulating e.g. a SQLITE_BUSY failure on the re-mint. No production seam added.
    const realAppendEvent = db.appendEvent.bind(db);
    let forceThrowOnce = true;
    db.appendEvent = (ev) => {
      if (forceThrowOnce && ev.kind === "session_message_queued" && ev.workerSessionId === successorId) {
        forceThrowOnce = false;
        throw new Error("SIMULATED_DB_FAILURE_FOR_REARM_TEST");
      }
      return realAppendEvent(ev);
    };
    // Mirrors production's own call shape (recycleWorker flushes the live queue BEFORE calling this
    // method) — without this, B's ORIGINAL entry stays sitting in `pty.q` and the re-arm's own
    // `enqueueStdin` below adds a SECOND, duplicate entry under the same msgId.
    const flushed = pty.flushPending(oldId);
    let failedRefs;
    try {
      // Direct call: TypeScript `private` is erased at runtime. `recycleWorker` specifically hard-stops
      // `oldId` before reaching this method (so a worker-recycle harness, as in scenario (2), could never
      // land this branch live) — a manager/platform-lead recycle DOES reach it with `oldId` still live;
      // see this file's header for the full reasoning.
      ({ failedRefs } = sessions.carryPendingToSuccessor(oldId, successorId, flushed, durableRecords));
    } finally {
      db.appendEvent = realAppendEvent;
    }
    check("(3) the forced mint failure is reported in failedRefs", failedRefs.includes(rB.msgId));
    check("(3) B was re-armed back onto the (still-live) predecessor", pty.getPending(oldId).some((t) => t.includes("G3_B_RESEND_OF_PARKED_A_FOR_REARM")));

    parkChainOn(pty, oldId);
    const bParked = [...gaveUpEventsFor(oldId)].find((e) => e.detail?.outcome === "parked" && e.detail?.rootMsgId === rootA && !aEventIds.has(e.id));
    check("(3) B parked (post-re-arm), chained to A's original root", !!bParked);
    check("(3) THE FIX: B's own park notice is NOT suppressed as duplicate-parked — joinedOntoParkedRoot survived the re-arm", bParked?.detail?.noticeSuppressed !== true);
  }

  // ===== (4) GAP 2: an explicit resendOf ALONE (no content match) exempts the resend's own park; plus =====
  // ===== a recipient-scoping check (same resendOf id, a DIFFERENT recipient, gets no exemption) =========
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `g4-mgr-${sfx}`, wkrA = `g4-wkrA-${sfx}`, wkrOther = `g4-wkrOther-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkrA, role: "worker", parentSessionId: mgr });
    mkSession({ id: wkrOther, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setBusy(mgr, false);
    pty.setLive(wkrA); pty.setBusy(wkrA);
    pty.setLive(wkrOther); pty.setBusy(wkrOther);

    sessions.messageWorker(mgr, wkrA, "G4_A_PARKS_FIRST");
    parkChainOn(pty, wkrA);
    const aEventIds = new Set(gaveUpEventsFor(wkrA).map((e) => e.id));
    const rootA = [...gaveUpEventsFor(wkrA)].find((e) => e.detail?.outcome === "parked")?.detail?.rootMsgId;
    check("(4) setup: A parked on wkrA", !!rootA);

    // Deliberately DIFFERENT text — proves this is resendOf doing the work, not a content-match auto-join
    // (this harness doesn't even implement hasAmbiguousMatch).
    pty.setBusy(wkrA, true);
    const rB = sessions.messageWorker(mgr, wkrA, "G4_COMPLETELY_DIFFERENT_TEXT", rootA);
    check("(4) setup: B held on wkrA, resendOf citing the parked root, unrelated text", rB.delivered === false);
    const recB = db.listUnresolvedQueuedMessagesForWorker(wkrA).find((e) => e.detail?.msgId === rB.msgId);
    check("(4) GAP 2 FIX: B's persisted record carries joinedOntoParkedRoot:true from an explicit resendOf alone", recB?.detail?.joinedOntoParkedRoot === true);

    parkChainOn(pty, wkrA);
    const bParked = [...gaveUpEventsFor(wkrA)].find((e) => e.detail?.outcome === "parked" && e.detail?.rootMsgId === rootA && !aEventIds.has(e.id));
    check("(4) B parked, chained to A's original root", !!bParked);
    check("(4) GAP 2 FIX: B's own park notice is NOT suppressed as duplicate-parked — an explicit resendOf onto an already-parked root is exempt", bParked?.detail?.noticeSuppressed !== true);

    // Recipient scoping: citing the SAME rootA on a DIFFERENT recipient (wkrOther, which has no parked
    // history of its own) must get NO exemption — isRootParked is recipientId-scoped.
    const rC = sessions.messageWorker(mgr, wkrOther, "G4_C_RESENDOF_FOREIGN_RECIPIENT_ROOT", rootA);
    check("(4) setup: C held on wkrOther, citing wkrA's (a DIFFERENT recipient's) parked root", rC.delivered === false);
    const recC = db.listUnresolvedQueuedMessagesForWorker(wkrOther).find((e) => e.detail?.msgId === rC.msgId);
    check("(4) RECIPIENT SCOPING: a resendOf naming a root parked on a DIFFERENT worker gets NO exemption", recC?.detail?.joinedOntoParkedRoot === false);
  }

  // ===== (6) NEGATIVE CONTROL: resendOf naming a root that is only RE-MINTED (not yet parked) gets NO =====
  // ===== exemption — mirrors bypassOwnershipGateOnce's own analogous negative ===========================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `g6-mgr-${sfx}`, wkrA = `g6-wkrA-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkrA, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setBusy(mgr, false);
    pty.setLive(wkrA); pty.setBusy(wkrA);

    const rA = sessions.messageWorker(mgr, wkrA, "G6_A_ONLY_REMINTED_NOT_PARKED");
    pty.giveUpOn(wkrA); // ONE give-up only — re-minted, chainDepth 1, strictly below REMINT_LIMIT=2
    const rootANotParked = rA.msgId; // self-rooted — A's own msgId IS its own rootMsgId
    check("(6) setup: A was RE-MINTED (not parked) — still below the remint limit",
      gaveUpEventsFor(wkrA).some((e) => e.detail?.outcome === "reminted") && !gaveUpEventsFor(wkrA).some((e) => e.detail?.outcome === "parked"));

    pty.setBusy(wkrA, true); // giveUpOn cleared busy; A's own re-mint is held via giveUpHeldUntil regardless
    const rB = sessions.messageWorker(mgr, wkrA, "G6_B_RESEND_OF_MERELY_REQUEUED_ROOT", rootANotParked);
    check("(6) setup: B held, citing resendOf of a root that is only requeued, not parked", rB.delivered === false);
    const recB = db.listUnresolvedQueuedMessagesForWorker(wkrA).find((e) => e.detail?.msgId === rB.msgId);
    check("(6) NEGATIVE CONTROL: no exemption for a resendOf naming a merely-requeued (not parked) root", recB?.detail?.joinedOntoParkedRoot === false);
  }

  // ===== (7) bypassOwnershipGateOnce (the round-4 WRITE bypass) stays byte-unchanged: a resendOf-only =====
  // ===== join never sets it — only a FRESH content-matched autoJoinedId may ============================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `g7-mgr-${sfx}`, wkrA = `g7-wkrA-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkrA, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setBusy(mgr, false);
    pty.setLive(wkrA); pty.setBusy(wkrA);

    sessions.messageWorker(mgr, wkrA, "G7_A_PARKS_FIRST");
    parkChainOn(pty, wkrA);
    const rootA = gaveUpEventsFor(wkrA).find((e) => e.detail?.outcome === "parked")?.detail?.rootMsgId;
    check("(7) setup: A parked on wkrA", !!rootA);

    pty.sent.length = 0; // reset capture — only care about B's own dispatch below
    pty.setBusy(wkrA, true);
    const rB = sessions.messageWorker(mgr, wkrA, "G7_B_RESEND_OF_PARKED_FOR_BYPASS_CHECK", rootA);
    check("(7) setup: B held, resendOf citing the parked root", rB.delivered === false);
    const sentForB = pty.sent.find((s) => s.text.includes("G7_B_RESEND_OF_PARKED_FOR_BYPASS_CHECK"));
    check("(7) ROUND-4 WRITE BYPASS STAYS UNCHANGED: a resendOf-only join never sets bypassOwnershipGateOnce — it remains scoped to a FRESH autoJoinedId match only",
      !!sentForB && sentForB.bypassOwnershipGateOnce !== true);
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — joinedOntoParkedRoot (card a5987cf3) now survives a daemon restart and a worker recycle "
    + "(both the happy-path re-mint and the mint-failure re-arm), and an explicit resendOf onto an "
    + "already-parked root is exempt on its own, recipient-scoped, and never widens the separate "
    + "bypassOwnershipGateOnce write bypass (card 3b420e0d)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
