import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Give-up TERMINAL-BRANCH durability test (card ccb407eb — "queued-message give-up terminal branch
// discards permanently (budget 1) and invisibly"). NO claude, NO live daemon, NO process.exit.
//
// ROOT CAUSE being guarded: `pty/host.ts`'s `requeueGiveUpOrigin` used to `continue` past a
// budget-exhausted message with nothing but a log line — a straight silent discard. TWO populations hit
// that branch with very different (both broken) durability postures:
//   (A) a durable "agent" message (worker_message/redirect/recycle-carry, minted via
//       `enqueueDurableMessage`) DID carry a `session_message_queued` DB record + `onDeliver`, but the
//       drop skipped the callback entirely — the record was silently orphaned, never resolved.
//   (B) a `[loom:*]` ONE-SHOT TERMINAL settle nudge (merge-done/-failed, merge-rejected, already-merged,
//       gate-done/-failed, the restart-orphan sweep, cap-queue-autofire-failed) had NO onDeliver and NO DB
//       record AT ALL — a bare `pty.enqueueStdin` call. Zero durability at any layer; a give-up here was
//       total and unrecoverable even across a daemon restart. THIS is the actual `[loom:merge-done]`
//       specimen the card investigated.
//
// THE FIX: `QueuedMessage.onGiveUpExhausted` (pty/host.ts) is a new hook `requeueGiveUpOrigin` invokes
// INSTEAD of a bare drop on budget exhaustion. `enqueueDurableMessage` (sessions/service.ts) wires it, for
// EVERY durable dispatch regardless of which population it came from, to `handleGiveUpExhausted`:
//   - below `GIVE_UP_REMINT_LIMIT`: RE-MINT a fresh `enqueueDurableMessage` dispatch (new msgId, budget
//     reset, chainDepth+1, same rootMsgId) — a NEW turn-boundary dispatch, never the same immediate retry
//     loop the card's ⛔ "don't raise the budget" constraint forbids.
//   - at the limit: PARK — no further dispatch for this message, ever; a live sender gets a
//     `[loom:redelivery-parked]` notice.
//   - EVERY step (re-mint or park) appends an auditable `session_message_gave_up` event carrying
//     `rootMsgId`, so a chain of any length traces back to one origin instead of unrelated ids.
//
// This suite proves, via a contract-faithful PtyStub extended with a `giveUpOn` primitive (mirrors the
// sibling `queued-message-durability.mjs` harness's `drainOne`/`supersedeHead`, but simulates the REAL
// PtyHost's give-up-exhaustion path instead of a normal delivery):
//   (1) POPULATION A (a durable agent message, via the public `messageWorker`) that gives up is RE-MINTED
//       under a NEW msgId — never lost — and the re-mint is itself a genuine new durable dispatch that
//       resolves normally on its own next turn boundary.
//   (2) BOUNDED + PARKED: repeated give-ups past `GIVE_UP_REMINT_LIMIT` stop dispatching the message
//       entirely (no runaway re-mint loop) and PARK it — never a silent drop — with the parked outcome
//       recorded durably.
//   (3) SURFACED TO SENDER: the terminal park pushes a `[loom:redelivery-parked]` notice to a LIVE sender
//       naming the recipient and the message head.
//   (4) AUDITABLE CHAIN: every event in a re-mint→park chain shares the SAME rootMsgId, so the whole
//       lifecycle is queryable from one id.
//   (5) POPULATION B (a settle-nudge-shaped dispatch — kind:"warning", sentinel sender — the exact shape
//       every `[loom:merge-done]`-style push now uses) is ALSO covered by the same mechanism: it survives
//       a give-up instead of the old bare-enqueueStdin total loss, and a sentinel non-session sender never
//       crashes the surface-to-sender step.
//   (6) THE DISCRIMINATING CONTROL: a HEALTHY delivery (drained normally, no give-up) NEVER produces a
//       `session_message_gave_up` event and NEVER re-mints — proving the fix doesn't just make every
//       message duplicate, only ones that actually gave up.
//
// Run: 1) build daemon (pnpm build from packages/daemon), 2) node test/give-up-exhausted-durable.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME BEFORE importing db.js/service.js (paths.ts reads it at import time).
const tmpHome = path.join(os.tmpdir(), `loom-giveup-exhausted-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Pin small so the re-mint→park chain is fast and deterministic — read once at service.ts module load.
process.env.LOOM_GIVE_UP_REMINT_LIMIT = "2";
const REMINT_LIMIT = 2;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Contract-faithful PtyStub (mirrors queued-message-durability.mjs's own), extended with `giveUpOn`: pops
// the FIFO head and fires BOTH callbacks in the SAME order the real host does — `onDeliver` first (the
// pre-existing, out-of-scope "delivered" marker fires optimistically at hand-off, well before give-up
// detection resolves — see resolveQueuedMessage's doc in service.ts), THEN `onGiveUpExhausted` (the give-up
// signal this card adds). This is deliberately realistic, not a shortcut: it's exactly what makes
// `session_message_gave_up` the correction a reader must consult ALONGSIDE `session_message_delivered`,
// not a replacement for it.
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.enqueueCount = new Map(); this.sent = []; }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  // `sent` records EVERY enqueueStdin call regardless of outcome (immediate vs held vs dead) — unlike
  // `getPending` (which only reflects what's currently WAITING in the FIFO), this is the right primitive
  // for "was this text ever actually sent to this recipient", since an immediately-idle recipient's text
  // never sits in the FIFO at all.
  enqueueStdin(id, text, _source = "system", onDeliver, _route, _kind, _questionId, _ownerText, _proactive, _senderId, giveUpHeldUntil, onGiveUpExhausted) {
    this.enqueueCount.set(id, (this.enqueueCount.get(id) ?? 0) + 1);
    this.sent.push({ id, text });
    if (!this.live.has(id)) return { delivered: false, reason: "session-dead", queued: false };
    // CR follow-up (card ccb407eb, finding [10]): models the REAL enqueueStdin's `stillGiveUpHeld` gate
    // (pty/host.ts) — a still-in-the-future `giveUpHeldUntil` forces the HELD branch even when the
    // recipient is otherwise idle. An earlier version of this stub ignored `giveUpHeldUntil` entirely, so
    // it could never actually exercise the mechanism BLOCKING finding [1]'s fix depends on — it would have
    // reported the same false PASS whether or not the fix's `giveUpHeldUntil` stamp was even present.
    const stillGiveUpHeld = giveUpHeldUntil !== undefined && Date.now() < giveUpHeldUntil;
    if (!this.busy.has(id) && !stillGiveUpHeld) return { delivered: true }; // idle AND not held → immediate
    const a = this.q.get(id) ?? []; a.push({ text, onDeliver, onGiveUpExhausted }); this.q.set(id, a);
    return { delivered: false, position: a.length, queued: true, landsAt: "next-turn-boundary" };
  }
  drainOne(id) { const a = this.q.get(id) ?? []; const m = a.shift(); if (m?.onDeliver) m.onDeliver(); return m?.text; }
  // CR follow-up (card ccb407eb, finding [10]): CLEARS busy BEFORE firing the hooks — this is not optional
  // realism, it's the actual production ordering. `fireEnterAndVerify` (pty/host.ts) calls `setBusy(false)`
  // BEFORE `requeueGiveUpOrigin` (which invokes onGiveUpExhausted) in BOTH its branches. An earlier version
  // of this stub left `busy` true here, which hid BLOCKING finding [1] (a re-mint with no `giveUpHeldUntil`
  // silently took `enqueueStdin`'s IMMEDIATE-SUBMIT branch — but only when busy is ACTUALLY false, which the
  // old stub never modeled). Clearing it first is what makes this harness able to catch that class of bug.
  giveUpOn(id) {
    this.busy.delete(id);
    const a = this.q.get(id) ?? []; const m = a.shift();
    if (!m) return undefined;
    if (m.onDeliver) m.onDeliver(); // the pre-existing premature "delivered" marker (out of scope; see doc)
    if (m.onGiveUpExhausted) m.onGiveUpExhausted();
    return m.text;
  }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
  getPersistablePending(id) { return (this.q.get(id) ?? []).filter((m) => !m.onDeliver).map((m) => m.text); }
  waitForMcpSeen() { return Promise.resolve(true); } // card df5e37e7
}

const db = new Db();
const proj = `gue-proj-${sfx}`, agent = `gue-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null, recycledFrom: o.recycledFrom ?? null,
});
const gaveUpEventsFor = (recipientId, msgId) =>
  db.listEventsForWorker(recipientId).filter((e) => e.kind === "session_message_gave_up" && (msgId ? e.detail?.msgId === msgId || e.detail?.rootMsgId === msgId : true));

try {
  // ===== (1)+(4) POPULATION A: a durable agent message that gives up is RE-MINTED, never lost, and the =====
  // ===== whole re-mint chain is auditable via a shared rootMsgId ============================================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `gue-a-mgr-${sfx}`, wkr = `gue-a-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr); // worker busy → the dispatch is HELD (durable)

    const r = sessions.messageWorker(mgr, wkr, "GIVES_UP_ONCE_THEN_LANDS");
    check("(1) setup: busy worker → message HELD (durable record created)", r.delivered === false && r.position === 1);
    const origRec = db.listUndeliveredQueuedMessages().find((e) => e.workerSessionId === wkr);
    const origMsgId = origRec?.detail?.msgId;
    check("(1) setup: exactly one undelivered durable record", typeof origMsgId === "string");

    // Simulate the REAL host's terminal give-up branch for this held entry — chainDepth 0, below the
    // REMINT_LIMIT of 2, so this must RE-MINT rather than drop.
    pty.giveUpOn(wkr);
    check("(1) THE FIX: a session_message_gave_up event was recorded for the ORIGINAL msgId, outcome reminted",
      gaveUpEventsFor(wkr, origMsgId).some((e) => e.detail?.outcome === "reminted"));
    const gaveUpEvt = gaveUpEventsFor(wkr, origMsgId).find((e) => e.detail?.outcome === "reminted");
    const remintedAs = gaveUpEvt?.detail?.remintedAs;
    check("(1) the gave-up event names the REAL re-minted msgId (not a placeholder)", typeof remintedAs === "string" && remintedAs !== origMsgId);
    check("(4) AUDITABLE: the reminted event's rootMsgId traces back to the ORIGINAL msgId", gaveUpEvt?.detail?.rootMsgId === origMsgId);

    // The re-mint is a GENUINE new durable dispatch — it must actually be sitting in the recipient's FIFO
    // under the NEW id, still carrying the SAME text, ready to land on the next turn boundary.
    const pendingNow = pty.getPending(wkr);
    check("(1) THE FIX: the message text is STILL pending after the give-up — never silently lost", pendingNow.some((t) => t.includes("GIVES_UP_ONCE_THEN_LANDS")));
    const remintRec = db.listUndeliveredQueuedMessages().find((e) => e.detail?.msgId === remintedAs);
    check("(1) the re-mint created its OWN fresh session_message_queued record", !!remintRec && remintRec.detail.text.includes("GIVES_UP_ONCE_THEN_LANDS"));

    // This time it lands normally (drainOne, not giveUpOn) — proves the re-mint isn't just visible, it's
    // actually DELIVERABLE and resolves its own record on delivery. (messageWorker frames the text as
    // "[loom:from-manager]\n<text>", so this checks containment, not exact equality.)
    const delivered = pty.drainOne(wkr);
    check("(1) the re-minted dispatch delivers normally on its next turn boundary", typeof delivered === "string" && delivered.includes("GIVES_UP_ONCE_THEN_LANDS"));
    check("(1) delivery resolved the RE-MINTED record (zero undelivered for it)", !db.listUndeliveredQueuedMessages().some((e) => e.detail?.msgId === remintedAs));
  }

  // ===== (2)+(3) BOUNDED: repeated give-ups past GIVE_UP_REMINT_LIMIT stop dispatching and PARK — never =====
  // ===== a silent drop — and a LIVE sender is notified ======================================================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `gue-b-mgr-${sfx}`, wkr = `gue-b-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);
    pty.setBusy(mgr, false); // sender idle+live → eligible to receive the parked-notice as a live turn

    sessions.messageWorker(mgr, wkr, "NEVER_LANDS_STAYS_WEDGED");
    // Give up REMINT_LIMIT + 1 times in a row (a session that STAYS wedged across every re-mint attempt).
    // Each giveUpOn pops the CURRENT head (re-minted by the previous cycle) and gives up on it again.
    for (let i = 0; i <= REMINT_LIMIT; i++) pty.giveUpOn(wkr);

    const chain = gaveUpEventsFor(wkr); // every session_message_gave_up event recorded for this worker
    const parkedEvt = chain.find((e) => e.detail?.outcome === "parked");
    check("(2) PARKED: after exhausting the re-mint budget, a parked outcome was recorded (never a silent discard)", !!parkedEvt);
    check("(2) PARKED: the parked event's chainDepth reached the configured limit", parkedEvt?.detail?.chainDepth === REMINT_LIMIT);
    check("(2) BOUNDED: after parking, the message is NO LONGER sitting in the recipient's pending FIFO (stopped dispatching, not looping)",
      pty.getPending(wkr).length === 0);

    // A further giveUpOn on this worker must be a genuine no-op (nothing left to give up on) — proves this
    // isn't "hasn't looped again yet", it's actually stopped.
    const enqueueCountBefore = pty.enqueueCount.get(wkr);
    pty.giveUpOn(wkr);
    check("(2) sanity: no further dispatch attempt for this recipient after parking (genuinely stopped, not just slow)",
      pty.enqueueCount.get(wkr) === enqueueCountBefore);

    // (3) SURFACED TO SENDER: the live manager must have received a [loom:redelivery-parked] notice
    // naming the recipient and the message's own head text. Uses `pty.sent` (every enqueueStdin call, not
    // just held ones) because the sender is idle here — its notice delivers IMMEDIATELY and would never
    // show up in `getPending`, which only reflects what's still waiting in the FIFO.
    const mgrSent = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
    check("(3) SURFACED: the live sender got a [loom:redelivery-parked] notice", mgrSent.some((t) => t.includes("[loom:redelivery-parked]")));
    check("(3) SURFACED: the notice names the recipient", mgrSent.some((t) => t.includes("[loom:redelivery-parked]") && t.includes(wkr.slice(0, 8))));
    check("(3) SURFACED: the notice carries the message's own head (content, not just length)", mgrSent.some((t) => t.includes("[loom:redelivery-parked]") && t.includes("NEVER_LANDS_STAYS_WEDGED")));
  }

  // ===== (5) POPULATION B: a settle-nudge-shaped dispatch (kind:"warning", sentinel "system" sender — the =====
  // ===== EXACT shape every [loom:merge-done]-style push now uses) is covered by the SAME mechanism, and a ===
  // ===== sentinel non-session sender never crashes the surface-to-sender step ===============================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const wkr = `gue-c-wkr-${sfx}`;
    mkSession({ id: wkr, role: "worker" });
    pty.setLive(wkr); pty.setBusy(wkr);

    // Directly exercises enqueueDurableMessage the same way every settle-nudge call site does post-fix:
    // kind:"warning", sender is the "system" sentinel (no real originating session for a daemon-generated
    // completion signal — see handleGiveUpExhausted's own doc for why that's safe).
    const r = sessions.enqueueDurableMessage(wkr, "[loom:merge-done] worker abc123 merged.", { sender: "system", taskId: null, kind: "warning" });
    check("(5) setup: the settle-nudge-shaped dispatch was HELD (busy recipient) with a real msgId", r.delivered === false && typeof r.msgId === "string");
    check("(5) setup: it was persisted just like an agent message — closes the OLD zero-durability gap for [loom:*] nudges",
      db.listUndeliveredQueuedMessages().some((e) => e.detail?.msgId === r.msgId));

    // BEFORE this card, this exact call site (bare pty.enqueueStdin, no onDeliver, no DB record) would have
    // been an unrecoverable total loss the instant this fires — nothing to even find here. Give it up and
    // confirm it survives exactly like population A did.
    pty.giveUpOn(wkr);
    check("(5) THE FIX (the actual merge-done specimen's shape): the settle nudge is RE-MINTED, never lost",
      pty.getPending(wkr).includes("[loom:merge-done] worker abc123 merged."));
    check("(5) a session_message_gave_up event was recorded for it (was previously impossible — no record existed at all)",
      gaveUpEventsFor(wkr, r.msgId).some((e) => e.detail?.outcome === "reminted"));
    // Sentinel sender ("system") has no live session — db.getSession("system") is undefined — the
    // surface-to-sender step must skip gracefully, never throw, exactly like recoverUndeliveredMessagesOnBoot
    // already documents for a sentinel sender with nobody to nudge.
    check("(5) a sentinel non-session sender does not crash handleGiveUpExhausted (getSession returns undefined, surfaced-notice step just skips)",
      true); // implicit: reaching this line without throwing IS the proof
  }

  // ===== (6) THE DISCRIMINATING CONTROL: a HEALTHY delivery (no give-up at all) never produces a =====
  // ===== session_message_gave_up event and is never re-minted — the fix only reacts to an ACTUAL give-up ===
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `gue-d-mgr-${sfx}`, wkr = `gue-d-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);

    const r = sessions.messageWorker(mgr, wkr, "HEALTHY_DELIVERY_NO_GIVE_UP");
    check("(6) setup: busy worker → message HELD", r.delivered === false);
    const beforeCount = pty.enqueueCount.get(wkr);

    // Normal delivery — drainOne (onDeliver fires), NEVER giveUpOn (onGiveUpExhausted never fires).
    // (messageWorker frames the text, so this checks containment, not exact equality.)
    const delivered = pty.drainOne(wkr);
    check("(6) CONTROL: the message delivers normally", typeof delivered === "string" && delivered.includes("HEALTHY_DELIVERY_NO_GIVE_UP"));
    check("(6) CONTROL: delivery resolved the durable record normally", !db.listUndeliveredQueuedMessages().some((e) => e.detail?.text?.includes("HEALTHY_DELIVERY_NO_GIVE_UP")));
    check("(6) CONTROL: NO session_message_gave_up event exists for this worker at all — a healthy delivery is not spuriously reminted",
      db.listEventsForWorker(wkr).every((e) => e.kind !== "session_message_gave_up"));
    check("(6) CONTROL: exactly ONE dispatch ever happened for this recipient (no re-mint, no duplicate turn)",
      pty.enqueueCount.get(wkr) === beforeCount);
  }

  // ===== (7) THE PARK-NOTICE ITSELF is durable (CR follow-up), and its own regress terminates because =====
  // ===== the "system" sentinel never resolves to a live session — proven BOTH ways: the real guard holds =====
  // ===== (7a), AND a synthetic guard-broken counter-proof (7b) shows this test would actually catch it if ===
  // ===== that ever stopped being true, so 7a's zero-attempts result is not a vacuous check ==================
  {
    // Shared flow: park message M (targeting wkr, from mgr) → its own park sends a `[loom:redelivery-parked]`
    // notice N back to mgr, itself durable — then exhaust N's OWN give-up chain too (mgr stays busy
    // throughout). Returns whether N was ever durably HELD (not a bare immediate push) and how many dispatch
    // ATTEMPTS ever targeted recipient "system" — the literal, load-bearing observable for "did N's own park
    // try to send a follow-on notice-about-the-notice" (that follow-on always targets `sender`, which for N
    // itself is the "system" sentinel N was minted with — never mgr again; see handleGiveUpExhausted's doc).
    const runNoticeRecursionScenario = (sessions2, pty2, label) => {
      const mgr = `gue-e-mgr-${label}-${sfx}`, wkr = `gue-e-wkr-${label}-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
      pty2.setLive(mgr); pty2.setLive(wkr);
      pty2.setBusy(wkr); pty2.setBusy(mgr); // BOTH busy: M held (durable), and N (once it exists) held too

      sessions2.messageWorker(mgr, wkr, "NOTICE_RECURSION_CHECK");
      for (let i = 0; i <= REMINT_LIMIT; i++) pty2.giveUpOn(wkr); // exhaust M → parks → sends N
      const noticeHeldBefore = pty2.getPending(mgr).some((t) => t.includes("[loom:redelivery-parked]"));
      for (let i = 0; i <= REMINT_LIMIT; i++) pty2.giveUpOn(mgr); // exhaust N's OWN chain too
      return { noticeHeldBefore, systemAttempts: pty2.enqueueCount.get("system") ?? 0 };
    };

    // 7a — REAL behavior against the genuine Db.
    const ptyA = new PtyStub();
    const sessionsA = new SessionService(db, ptyA, new OrchestrationControl());
    const resA = runNoticeRecursionScenario(sessionsA, ptyA, "fixed");
    check("(7) the park-notice IS durable (held, not a bare immediate push) before it starts giving up itself", resA.noticeHeldBefore);
    check("(7) THE GUARD HOLDS: with the real db.getSession, N's own park attempts NO follow-on dispatch to \"system\" — no second notice",
      resA.systemAttempts === 0);

    // 7b — SYNTHETIC GUARD-BROKEN COUNTER-PROOF (manager-requested: prove the test would catch a regression,
    // don't just assert the property). `brokenDb` prototype-delegates every OTHER method to the real `db`
    // (Db has zero true `#private` fields — verified — so a plain method call via the prototype chain, with
    // `this` bound to `brokenDb`, resolves `this.db` — the real Db's own sqlite-handle property — correctly
    // through the chain) and overrides ONLY `getSession("system")` to fake a LIVE session, simulating exactly
    // the failure the manager named: "a future change that makes getSession fall back, or anything that
    // materialises a session under that key." If this ever becomes real, THIS assertion is what goes red.
    const brokenDb = Object.create(db);
    brokenDb.getSession = (id) => (id === "system" ? { id: "system", processState: "live" } : db.getSession(id));
    const ptyB = new PtyStub();
    const sessionsB = new SessionService(brokenDb, ptyB, new OrchestrationControl());
    const resB = runNoticeRecursionScenario(sessionsB, ptyB, "broken");
    check("(7) RED-FIRST PROOF: with the sentinel guard disabled (getSession(\"system\") faked live), the IDENTICAL code path DOES attempt a follow-on dispatch to \"system\" — proving 7a's zero-attempts result is a real, load-bearing guard, not a vacuous one",
      resB.systemAttempts >= 1);
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a give-up-exhausted durable message (both the original agent-message population AND the settle-nudge population that used to have zero durability) is RE-MINTED under an auditable, rootMsgId-linked chain rather than silently dropped, bounded re-minting PARKS (never loops forever) with the outcome durably recorded and surfaced to a live sender, and a healthy delivery with no give-up is never spuriously reminted."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
