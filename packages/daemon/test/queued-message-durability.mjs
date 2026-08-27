import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Durable queued-message inbox test (card 2ca18433). NO claude, NO live daemon, NO process.exit.
//
// PROVES the fix for "a queued (delivered:false) session_message lives ONLY in-memory, so a sender death
// (API 529) or a daemon restart before the recipient's next turn boundary silently DROPS it" (it lost a P1
// cross-project dispatch twice). Two parts:
//
//   PART A — REAL PtyHost (claude-free, via the createPty seam): the additive `onDeliver` delivery hook.
//     • a message delivered IMMEDIATELY (idle submit) does NOT fire onDeliver (nothing is persisted) — the
//       load-bearing M1/M2 immediate-submit window is untouched;
//     • a HELD message fires onDeliver exactly when it is handed to the recipient — at the next Stop drain
//       AND via inbox_pull (consumePending);
//     • getPersistablePendingSnapshot EXCLUDES onDeliver-bearing (durable) messages but keeps plain ones
//       (the daemon_restart snapshot dedup).
//
//   PART B — SessionService + Db + a contract-faithful PtyStub: the end-to-end durability.
//     (a) SENDER DEATH before flush → the held message still delivers on the recipient's next turn boundary
//         (sender liveness is irrelevant; the durable record + onDeliver carry it).
//     (b) DAEMON RESTART → the held message is NOT in intent.pending (getPersistablePendingSnapshot excludes it) and
//         the boot scan re-enqueues it EXACTLY ONCE onto the resumed recipient (no double), then it delivers
//         + resolves on the recipient's next turn.
//     (c) UNDELIVERED OUTBOUND → a held message whose recipient isn't live at boot is SURFACED to the resumed
//         (live) sender so it can re-send; a message to a RECYCLED/superseded recipient is RETIRED (bounded).
//     (e)+(f)+(g)+(h) DISPATCH SEMANTICS SURVIVE A REDRIVE (card 129efe74) → the persisted
//         session_message_queued detail carries kind/rootMsgId/chainDepth/giveUpHeldUntil, so a redrive
//         preserves a "warning" classification and an in-flight give-up hold instead of silently resetting
//         them to "agent"/no-hold/fresh-chain — and a LEGACY record (written before this card) still gets
//         exactly the old hardcoded defaults, never something else.
//
// Run: 1) build daemon, 2) node test/queued-message-durability.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME BEFORE importing host.js/db.js (paths.ts reads it at import time).
const tmpHome = path.join(os.tmpdir(), `loom-qmd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { CLEAN_STALENESS } = await import("./_deploy-staleness-fixture.mjs");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

try {
  // ============================== PART A — REAL PtyHost onDeliver hook ==============================
  const fakes = [];
  class TestPtyHost extends createSeamHost(PtyHost) {
    createPty(opts) {
      const base = super.createPty(opts);
      const writes = [];
      const fake = { ...base, write: (d) => { writes.push(d); }, writes };
      fakes.push(fake);
      return fake;
    }
  }
  const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
  const host = new TestPtyHost(events);
  const SID = "qmd-sess";
  host.spawn({ sessionId: SID, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(SID, { hook_event_name: "SessionStart" }); // mark ready (startupModeCycles:0 ⇒ synchronous)
  const fake = fakes[0];
  const written = () => fake.writes.join("");
  const countOf = (m) => written().split(m).length - 1;

  // (A1) IMMEDIATE idle submit must NOT fire onDeliver (nothing persisted on that path).
  let immFired = 0;
  const r0 = host.enqueueStdin(SID, "IMMEDIATE_MSG", "system", () => { immFired++; });
  check("(A1) idle enqueue delivered immediately", r0.delivered === true && r0.position === undefined);
  check("(A1) onDeliver NOT fired on the immediate-submit path (M1/M2 window untouched)", immFired === 0);
  // Card 9da2a435: `delivered:true` is a hand-off, not an engine-confirmed receipt — the live specimen
  // behind this card was exactly a `delivered:true` message that never reached the worker. `deliveryState`
  // makes that explicit in-band instead of only in a doc comment a caller might not read.
  check("(A1) delivered:true carries deliveryState:\"handed-off\" — hand-off is not confirmation", r0.deliveryState === "handed-off");

  // Session is now busy → subsequent enqueues are HELD. Queue a DURABLE message + a PLAIN one.
  let durFired = 0;
  const rDur = host.enqueueStdin(SID, "DURABLE_HELD", "system", () => { durFired++; });
  const rPlain = host.enqueueStdin(SID, "PLAIN_HELD"); // no onDeliver (a normal nudge/report)
  check("(A2) durable message queued behind busy (position 1, not delivered)", rDur.delivered === false && rDur.position === 1);
  check("(A2) plain message queued (position 2)", rPlain.delivered === false && rPlain.position === 2);

  // (A3) getPersistablePendingSnapshot EXCLUDES the durable (onDeliver) message, keeps the plain one — the snapshot dedup.
  check("(A3) getPending holds BOTH [DURABLE_HELD, PLAIN_HELD]", JSON.stringify(host.getPending(SID)) === JSON.stringify(["DURABLE_HELD", "PLAIN_HELD"]));
  check("(A3) getPersistablePendingSnapshot EXCLUDES the durable msg, keeps the plain one", JSON.stringify(host.getPersistablePendingSnapshot(SID).texts) === JSON.stringify(["PLAIN_HELD"]));

  // (A4) ONE Stop COALESCE-drains the WHOLE held FIFO (DURABLE_HELD + PLAIN_HELD) as a single turn:
  // the durable entry's onDeliver fires exactly once, the plain (no-callback) entry fires nothing.
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("(A4) Stop drained DURABLE_HELD (written once)", countOf("DURABLE_HELD") === 1);
  check("(A4) Stop ALSO drained PLAIN_HELD in the same coalesced turn", countOf("PLAIN_HELD") === 1);
  check("(A4) onDeliver fired exactly once for the durable msg; the plain (no-callback) msg fired none", durFired === 1);
  check("(A4) the coalesced drain emptied the held queue", host.getPending(SID).length === 0);

  // (A6) consumePending (inbox_pull) ALSO fires onDeliver for a held durable message. The coalesced
  // drain above re-armed busy, so this fresh enqueue is HELD (not submitted) — perfect to pull.
  let pullFired = 0;
  const rPull = host.enqueueStdin(SID, "PULLED_DURABLE", "system", () => { pullFired++; }); // busy ⇒ queued
  check("(A6) PULLED_DURABLE held behind busy (not immediately submitted)", rPull.delivered === false);
  const pulled = host.consumePending(SID);
  check("(A6) consumePending returned the held durable message text", pulled.length === 1 && pulled[0] === "PULLED_DURABLE");
  check("(A6) consumePending fired onDeliver (inbox_pull counts as delivery)", pullFired === 1);
  try { host.stop(SID, "hard"); } catch { /* ignore */ }

  // ============================== PART B — end-to-end durability (SessionService) ==============================
  // A contract-faithful PtyStub: mirrors the host's onDeliver semantics WITHOUT claude. A session must be
  // `live` to receive; a `busy` (or freshly-resumed not-ready) recipient QUEUES + stores onDeliver; an idle
  // one delivers immediately (and, like the host, does NOT fire onDeliver). drainOne() simulates a turn
  // boundary: it hands the FIFO head to the recipient and fires its onDeliver.
  class PtyStub {
    constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.sent = []; }
    setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
    setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
    // Widened to the REAL enqueueStdin's positional shape (card 129efe74): captures `kind` per call (in
    // `sent`, regardless of outcome) and models the REAL `stillGiveUpHeld` gate (pty/host.ts) so a redrive
    // carrying a still-in-the-future `giveUpHeldUntil` is held even for an otherwise-idle recipient — without
    // this the stub could never exercise the symptom this card fixes (a lost hold silently taking the
    // immediate-delivery branch).
    // Card 3f09f9ce: position 11 also accepts the real enqueueStdin's options-object tail overload
    // (production's `enqueueDurableMessage`/`redriveQueuedMessage` migrated to it) — discriminate by
    // shape, same as the real implementation, so this stub keeps modelling both call shapes correctly.
    enqueueStdin(id, text, _source = "system", onDeliver, _route, kind = "warning", _questionId, _ownerText, _proactive, _senderId, tail, onGiveUpExhaustedPositional) {
      const isTailObject = typeof tail === "object" && tail !== null;
      const giveUpHeldUntil = isTailObject ? tail.giveUpHeldUntil : tail;
      const onGiveUpExhausted = isTailObject ? tail.onGiveUpExhausted : onGiveUpExhaustedPositional;
      this.sent.push({ id, text, kind });
      if (!this.live.has(id)) return { delivered: false };          // not alive → dropped (no position)
      const stillGiveUpHeld = giveUpHeldUntil !== undefined && Date.now() < giveUpHeldUntil;
      if (!this.busy.has(id) && !stillGiveUpHeld) return { delivered: true }; // idle AND not held → immediate (onDeliver NOT fired)
      const a = this.q.get(id) ?? []; a.push({ text, onDeliver, kind, giveUpHeldUntil, onGiveUpExhausted }); this.q.set(id, a);
      return { delivered: false, position: a.length };
    }
    drainOne(id) { const a = this.q.get(id) ?? []; const m = a.shift(); if (m?.onDeliver) m.onDeliver(); return m?.text; }
    // SUPERSEDE the head (as a redirectWorker flush does): pop it and fire its onDeliver WITH a reason,
    // so the durable record resolves annotated (e.g. "superseded") rather than as a plain delivery.
    supersedeHead(id, reason) { const a = this.q.get(id) ?? []; const m = a.shift(); if (m?.onDeliver) m.onDeliver(reason); return m?.text; }
    // Simulates the REAL host's terminal give-up branch (mirrors give-up-exhausted-durable.mjs's own stub):
    // pops the head and fires onDeliver (the pre-existing premature "delivered" marker) THEN onGiveUpExhausted.
    giveUpOn(id) {
      const a = this.q.get(id) ?? []; const m = a.shift();
      if (!m) return undefined;
      if (m.onDeliver) m.onDeliver();
      if (m.onGiveUpExhausted) m.onGiveUpExhausted();
      return m.text;
    }
    getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
    getPersistablePendingSnapshot(id) { return { texts: (this.q.get(id) ?? []).filter((m) => !m.onDeliver).map((m) => m.text), holds: {} }; }
    waitForMcpSeen() { return Promise.resolve(true); } // card df5e37e7 — see mcp-ready-gate.mjs for the primitive's own timing
  }
  const flushB = () => new Promise((r) => setTimeout(r, 0));

  const db = new Db();
  const proj = `qmd-proj-${sfx}`, agent = `qmd-ag-${sfx}`;
  db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
  const mkSession = (o) => db.insertSession({
    id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
    processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
    worktreePath: null, branch: null, recycledFrom: o.recycledFrom ?? null,
  });

  // ---- (B-a) SENDER DEATH before flush → still delivered on the recipient's next turn ----
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `qmd-a-mgr-${sfx}`, wkr = `qmd-a-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: null });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr); // worker is mid-turn → the message is HELD

    const r = sessions.messageWorker(mgr, wkr, "P1 DISPATCH");
    check("(B-a) busy worker → message HELD, not delivered now", r.delivered === false && r.position === 1);
    const undeliv1 = db.listUndeliveredQueuedMessages();
    check("(B-a) the held message is PERSISTED as an undelivered session_message_queued", undeliv1.length === 1 && undeliv1[0].workerSessionId === wkr && undeliv1[0].detail.text.includes("P1 DISPATCH"));

    // SENDER DEATH: the manager's pty dies (API 529 / crash). The message lives in the RECIPIENT's durable
    // record + FIFO, independent of the sender.
    db.setProcessState(mgr, "exited"); pty.setLive(mgr, false);
    // Recipient's next turn boundary delivers it.
    const drained = pty.drainOne(wkr);
    check("(B-a) the held message STILL delivers on the worker's next turn (sender death irrelevant)", typeof drained === "string" && drained.includes("P1 DISPATCH"));
    check("(B-a) delivery RESOLVED the durable record (now zero undelivered)", db.listUndeliveredQueuedMessages().length === 0);
  }

  // ---- (B-b) DAEMON RESTART → re-enqueued EXACTLY ONCE (no double with intent.pending) ----
  {
    const restart = await import("../dist/orchestration/restart.js");
    const ptyPre = new PtyStub();
    const sessionsPre = new SessionService(db, ptyPre, new OrchestrationControl());
    const mgr = `qmd-b-mgr-${sfx}`, wkr = `qmd-b-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    ptyPre.setLive(mgr); ptyPre.setLive(wkr); ptyPre.setBusy(wkr);

    sessionsPre.messageWorker(mgr, wkr, "RESTART DISPATCH");
    // ALSO queue a PLAIN nudge on the worker (a non-durable held item) to prove the snapshot still carries it.
    ptyPre.enqueueStdin(wkr, "plain nudge");
    check("(B-b) pre-restart: 1 undelivered durable message recorded", db.listUndeliveredQueuedMessages().some((e) => e.detail.text.includes("RESTART DISPATCH")));

    // Snapshot as requestDaemonRestart does: getPersistablePendingSnapshot EXCLUDES the durable message.
    const snap = ptyPre.getPersistablePendingSnapshot(wkr).texts;
    check("(B-b) intent.pending snapshot EXCLUDES the durable message (dedup at the source)", !snap.some((t) => t.includes("RESTART DISPATCH")));
    check("(B-b) intent.pending snapshot STILL carries the plain nudge", snap.includes("plain nudge"));

    // ---- the daemon dies and boots fresh: a NEW pty (in-memory FIFO gone), SAME db. The fleet resumes. ----
    const ptyPost = new PtyStub();
    const sessionsPost = new SessionService(db, ptyPost, new OrchestrationControl());
    ptyPost.setLive(mgr); ptyPost.setBusy(mgr); ptyPost.setLive(wkr); ptyPost.setBusy(wkr); // resumed, not-ready ⇒ queue
    const intent = { reason: "deploy", managerSessionId: mgr, requestedAt: now,
      resume: [{ sessionId: mgr, role: "manager", parentSessionId: null }, { sessionId: wkr, role: "worker", parentSessionId: mgr }],
      pending: { [wkr]: snap } }; // ONLY the plain nudge — the durable msg is intentionally absent
    sessionsPost.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
    await flushB(); // let every deferred manager/worker nudge settle
    // Card 06ebbb78 CR follow-up: THE NEW FACET, asserted BEFORE the boot scan even runs, via the DB row
    // itself — a `session_message_queued` row is EXACTLY what "durable" means in this codebase, so its
    // presence (not a FIFO-content `.some()`, which the deleted plain `enqueueNudge` would ALSO have
    // satisfied) is what a durable dispatch — and ONLY a durable dispatch — can produce. EXACT counts, not
    // `.some()`: this positive-controls itself — under the pre-06ebbb78 code (enqueueNudge, no DB write at
    // all) both `wkrOwnNudgeRows`/`mgrOwnNudgeRows` below would be 0, and this check would fail.
    const preScanUndelivered = db.listUndeliveredQueuedMessages();
    const wkrOwnNudgeRows = preScanUndelivered.filter((e) => e.workerSessionId === wkr && e.detail?.text?.includes("[loom:daemon-restarted]")).length;
    const mgrOwnNudgeRows = preScanUndelivered.filter((e) => e.workerSessionId === mgr && e.detail?.text?.includes("[loom:daemon-restarted]")).length;
    check("(B-b) THE NEW FACET: the worker's OWN daemon-restarted continuation nudge is a genuine durable DB record — EXACTLY 1, present before the boot scan even runs", wkrOwnNudgeRows === 1);
    check("(B-b) THE NEW FACET: the manager's OWN daemon-restarted summary nudge is a genuine durable DB record — EXACTLY 1, present before the boot scan even runs", mgrOwnNudgeRows === 1);
    check("(B-b) THE NEW FACET: exactly 3 undelivered durable records total pre-scan (1 pre-existing RESTART DISPATCH + the worker's + the manager's own new nudges)", preScanUndelivered.length === 3);

    const m = sessionsPost.recoverUndeliveredMessagesOnBoot();
    // Card 06ebbb78: resumeFleetOnBoot's OWN continuation nudges now route through the SAME durable
    // enqueueDurableNudge helper (converging the gap this card was filed to close) — so, on TOP of the
    // pre-existing "RESTART DISPATCH" record, mgr/wkr are both still busy (not-ready) when their own
    // fresh "[loom:daemon-restarted]" nudges are dispatched, and EACH of those is now ALSO a genuine,
    // separate held session_message_queued record this boot scan picks up: 1 (RESTART DISPATCH, pre-
    // existing) + 1 (wkr's own daemon-restarted continue-nudge) + 1 (mgr's own daemon-restarted summary
    // nudge) = 3. This is NOT a duplicate of the same message — three DISTINCT msgIds, asserted below —
    // it's the direct, intended consequence of the convergence: before card 06ebbb78 this would have been
    // 1 (the other two nudges dispatched via the old non-durable enqueueNudge, invisible to this scan).
    // DEPENDS ON THE TEST-ONLY `await flushB()` above (line ~221): it's what lets the mgr/worker roles'
    // DEFERRED `enqueueDurableNudge` dispatch (they mount loom-orchestration, so it waits on
    // PtyStub.waitForMcpSeen — resolved instantly here) actually WRITE its DB record before this line
    // reads it. Production has NO such await between resumeFleetOnBoot (index.ts ~:1278) and
    // recoverUndeliveredMessagesOnBoot (~:1311) — see that call site's own comment: for these two DEFERRED
    // roles the real `waitForMcpSeen` genuinely waits on a real async MCP handshake, so in production the
    // scan normally completes and returns LONG before either deferred dispatch even runs — this exact `3`
    // is a test-harness artifact of resolving the wait instantly, not something to expect in a real boot
    // trace. If a future edit moves or removes `flushB`, RE-DERIVE this count from the new timing rather
    // than relaxing the assertion to whatever the harness happens to produce.
    check("(B-b) boot scan re-enqueued the pre-existing dispatch PLUS resumeFleetOnBoot's own two now-durable nudges (card 06ebbb78)", m.reEnqueued === 3);

    const wkrPending = ptyPost.getPending(wkr);
    const dispatchCount = wkrPending.filter((t) => t.includes("RESTART DISPATCH")).length;
    check("(B-b) recipient got the ORIGINAL dispatch EXACTLY ONCE (no double from intent.pending + boot scan)", dispatchCount === 1);
    check("(B-b) the plain nudge was replayed by intent.pending (independent path intact)", wkrPending.filter((t) => t === "plain nudge").length === 1);
    // Sanity only (the durability proof itself is the pre-scan DB row check above): the worker's + manager's
    // own new durable nudges do also land in the FIFO once redriven.
    check("(B-b) sanity: the worker's own daemon-restarted continuation nudge did reach its FIFO",
      wkrPending.some((t) => t.includes("[loom:daemon-restarted]") && /continue your assigned task/i.test(t)));
    const mgrPending = ptyPost.getPending(mgr);
    check("(B-b) sanity: the manager's own daemon-restarted summary nudge did reach its FIFO",
      mgrPending.some((t) => t.includes("[loom:daemon-restarted]")));

    // Drain the worker's FIFO to its turn boundary → the re-enqueued dispatch resolves its ORIGINAL record.
    let guard = 0; let drained;
    do { drained = ptyPost.drainOne(wkr); guard++; } while (drained !== undefined && !drained.includes("RESTART DISPATCH") && guard < 10);
    check("(B-b) the re-enqueued dispatch delivers on the recipient's next turn", typeof drained === "string" && drained.includes("RESTART DISPATCH"));
    check("(B-b) delivery RESOLVED the durable record (zero undelivered for this message)", !db.listUndeliveredQueuedMessages().some((e) => e.detail.text.includes("RESTART DISPATCH")));
  }

  // ---- (B-d) a POST-RESTART re-enqueued durable message records the supersede REASON when flushed ----
  // Proves the boot re-enqueue's onDeliver FORWARDS the supersede reason (matches enqueueDurableMessage).
  // Correctness (the record IS resolved, so the done-guard won't falsely refuse) was always fine — this
  // guards the AUDIT annotation: a redirectWorker flush of a re-enqueued message must record
  // reason "superseded", not a plain delivered marker (the boot-path two-path-asymmetry NIT).
  {
    const ptyPre = new PtyStub();
    const sessionsPre = new SessionService(db, ptyPre, new OrchestrationControl());
    const mgr = `qmd-d-mgr-${sfx}`, wkr = `qmd-d-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    ptyPre.setLive(mgr); ptyPre.setLive(wkr); ptyPre.setBusy(wkr);
    sessionsPre.messageWorker(mgr, wkr, "SUPERSEDE DISPATCH");
    const rec = db.listUndeliveredQueuedMessages().find((e) => e.detail.text.includes("SUPERSEDE DISPATCH"));
    const msgId = rec?.detail?.msgId;
    check("(B-d) the held message recorded a durable msgId", typeof msgId === "string");

    // Daemon restart: NEW pty, SAME db. Recipient resumes not-ready (queues). The boot scan re-enqueues it.
    const ptyPost = new PtyStub();
    const sessionsPost = new SessionService(db, ptyPost, new OrchestrationControl());
    ptyPost.setLive(wkr); ptyPost.setBusy(wkr); // resumed, not-ready ⇒ the re-enqueue is HELD (keeps onDeliver)
    const m = sessionsPost.recoverUndeliveredMessagesOnBoot();
    check("(B-d) boot scan re-enqueued the durable message", m.reEnqueued === 1);

    // A redirectWorker flush SUPERSEDES the re-enqueued held message → fires its onDeliver("superseded").
    ptyPost.supersedeHead(wkr, "superseded");
    check("(B-d) the superseded message is resolved (zero undelivered for it)", !db.listUndeliveredQueuedMessages().some((e) => e.detail.text.includes("SUPERSEDE DISPATCH")));
    const marker = db.listEventsForWorker(wkr).find((e) => e.kind === "session_message_delivered" && e.detail?.msgId === msgId);
    check("(B-d) the resolution records reason \"superseded\" (boot re-enqueue FORWARDS the reason, not a plain marker)", marker?.detail?.reason === "superseded");
  }

  // ---- (B-c) UNDELIVERED OUTBOUND surfaced to a resumed sender; recycled recipient RETIRED ----
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `qmd-c-mgr-${sfx}`, wkr = `qmd-c-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);
    sessions.messageWorker(mgr, wkr, "STUCK DISPATCH");

    // RESTART where the worker does NOT come back live (it exited), but the manager (sender) did.
    const ptyPost = new PtyStub();
    const sessionsPost = new SessionService(db, ptyPost, new OrchestrationControl());
    db.setProcessState(wkr, "exited");      // recipient exists but is not live (not superseded/archived)
    ptyPost.setLive(mgr); ptyPost.setBusy(mgr); // sender resumed (busy ⇒ the surface note queues)
    const m = sessionsPost.recoverUndeliveredMessagesOnBoot();
    check("(B-c) a not-live recipient's message is NOT re-enqueued (left undelivered)", m.reEnqueued === 0);
    check("(B-c) the stuck outbound was surfaced to the live sender", m.senderNudges === 1);
    const mgrPending = ptyPost.getPending(mgr);
    check("(B-c) the sender got a [loom:undelivered] heads-up naming the recipient", mgrPending.some((t) => t.includes("[loom:undelivered]") && t.includes(wkr.slice(0, 8))));
    check("(B-c) the durable record is STILL undelivered (the sender re-sends / a later boot re-drives)", db.listUndeliveredQueuedMessages().some((e) => e.detail.text.includes("STUCK DISPATCH")));

    // RETIRE path: a message to a RECYCLED (superseded) recipient is bounded — marked delivered with a reason.
    const wkr2 = `qmd-c-wkr2-${sfx}`, succ = `qmd-c-succ-${sfx}`;
    mkSession({ id: wkr2, role: "worker", parentSessionId: mgr });
    pty.setLive(wkr2); pty.setBusy(wkr2);
    sessions.messageWorker(mgr, wkr2, "RECYCLED DISPATCH");
    mkSession({ id: succ, role: "worker", parentSessionId: mgr, recycledFrom: wkr2 }); // successor supersedes wkr2
    const m2 = sessionsPost.recoverUndeliveredMessagesOnBoot();
    check("(B-c) a superseded (recycled) recipient's message is RETIRED, not re-enqueued", m2.retired >= 1);
    check("(B-c) the recycled-recipient message is no longer in the undelivered set (bounded)", !db.listUndeliveredQueuedMessages().some((e) => e.detail.text.includes("RECYCLED DISPATCH")));
  }

  // ---- (B-e) SYMPTOM 1 (card 129efe74): a kind:"warning" durable dispatch round-trips as "warning" through
  // BOTH halves of the fix — the WRITE side (enqueueDurableMessage persists ctx.kind in `detail`) and the
  // READ side (redriveQueuedMessage reads it back instead of hardcoding "agent"). Pre-fix, the persisted
  // detail carried no `kind` at all and the redrive unconditionally passed "agent" to enqueueStdin — both
  // checks below fail red against that code.
  {
    const ptyPre = new PtyStub();
    const sessionsPre = new SessionService(db, ptyPre, new OrchestrationControl());
    const wkr = `qmd-e-wkr-${sfx}`;
    mkSession({ id: wkr, role: "worker" });
    ptyPre.setLive(wkr); ptyPre.setBusy(wkr); // busy → HELD (durable record)

    const r = sessionsPre.enqueueDurableMessage(wkr, "[loom:gate-failed] warning-kind settle nudge", { sender: "system", taskId: null, kind: "warning" });
    check("(B-e) setup: the warning-kind dispatch was HELD with a real msgId", r.delivered === false && typeof r.msgId === "string");
    const rec = db.listUndeliveredQueuedMessages().find((e) => e.detail?.msgId === r.msgId);
    check("(B-e) THE FIX (write side): the persisted session_message_queued record carries kind:\"warning\" (pre-fix: the field was absent entirely)", rec?.detail?.kind === "warning");

    // Daemon restart: NEW pty, SAME db. Recipient resumes BUSY, so the redrive is HELD (observable in `sent`).
    const ptyPost = new PtyStub();
    const sessionsPost = new SessionService(db, ptyPost, new OrchestrationControl());
    ptyPost.setLive(wkr); ptyPost.setBusy(wkr);
    const m = sessionsPost.recoverUndeliveredMessagesOnBoot();
    check("(B-e) boot scan re-enqueued the warning-kind message", m.reEnqueued === 1);
    const sentEntry = ptyPost.sent.find((s) => s.id === wkr && s.text.includes("warning-kind settle nudge"));
    check("(B-e) THE FIX (read side): the redrive passed kind:\"warning\" through to enqueueStdin (pre-fix: hardcoded \"agent\" here)", sentEntry?.kind === "warning");
  }

  // ---- (B-f) SYMPTOM 2 (card 129efe74): a re-mint's giveUpHeldUntil survives a restart — the redrive of
  // that re-mint record must NOT take the immediate-delivery branch inside the hold window, even though the
  // resumed recipient is otherwise idle. Pre-fix, `giveUpHeldUntil` was never persisted, so a restart landing
  // mid-hold degraded the hold to nothing and the redrive delivered immediately — a duplicate turn.
  {
    const ptyPre = new PtyStub();
    const sessionsPre = new SessionService(db, ptyPre, new OrchestrationControl());
    const mgr = `qmd-f-mgr-${sfx}`, wkr = `qmd-f-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    ptyPre.setLive(mgr); ptyPre.setLive(wkr); ptyPre.setBusy(wkr); // busy → the dispatch is HELD (durable)

    sessionsPre.messageWorker(mgr, wkr, "GIVES_UP_THEN_RESTARTS_MID_HOLD");
    // Give up on the held message → handleGiveUpExhausted RE-MINTS it with giveUpHeldUntil = now + GIVE_UP_HOLD_MS.
    ptyPre.giveUpOn(wkr);
    const remintRec = db.listUndeliveredQueuedMessages().find((e) => e.workerSessionId === wkr && e.detail?.text?.includes("GIVES_UP_THEN_RESTARTS_MID_HOLD"));
    check("(B-f) setup: the re-mint created its own undelivered durable record", !!remintRec);
    check("(B-f) THE FIX (write side): the re-mint's record persists a still-future giveUpHeldUntil (pre-fix: the field was absent entirely)", typeof remintRec?.detail?.giveUpHeldUntil === "number" && remintRec.detail.giveUpHeldUntil > Date.now());

    // Daemon restart mid-hold-window: NEW pty, SAME db. Recipient resumes and, crucially, goes IDLE (not
    // busy) — the ONLY thing that should keep the redrive from delivering immediately is the persisted hold.
    const ptyPost = new PtyStub();
    const sessionsPost = new SessionService(db, ptyPost, new OrchestrationControl());
    ptyPost.setLive(wkr); // idle, not busy
    const m = sessionsPost.recoverUndeliveredMessagesOnBoot();
    check("(B-f) boot scan re-enqueued the re-mint", m.reEnqueued === 1);
    check("(B-f) THE FIX (read side): the redrive did NOT deliver immediately inside the hold window — it is still sitting HELD",
      ptyPost.getPending(wkr).some((t) => t.includes("GIVES_UP_THEN_RESTARTS_MID_HOLD")));
    const sentEntry = ptyPost.sent.find((s) => s.id === wkr && s.text.includes("GIVES_UP_THEN_RESTARTS_MID_HOLD"));
    check("(B-f) DISCRIMINATING CONTROL: enqueueStdin really was attempted for this recipient (this isn't a no-op/skip masquerading as \"still held\")", !!sentEntry);
  }

  // ---- (B-g)/(B-h) LEGACY ROWS (card 129efe74 non-negotiable #2): a session_message_queued record written
  // BEFORE this fix carries none of kind/giveUpHeldUntil/rootMsgId/chainDepth. The redrive must apply the
  // EXACT defaults that reproduce this method's pre-fix behavior — never let a missing field silently become
  // something OTHER than what pre-fix code always did (that is how this bug class arrived in the first place).
  // Card bcaeab8d: the TEXT itself is no longer one of those byte-identical defaults — every Path D redrive
  // now carries a `[loom:possible-duplicate root:…]` prefix (see redriveQueuedMessage's own comment for why
  // this path tags unconditionally), so these two blocks assert on CONTAINS, not exact-equals, and separately
  // assert the tag is present — proving the fix DIRECTLY rather than merely tolerating it.
  const POSSIBLE_DUP_PREFIX_RE = /^\[loom:possible-duplicate root:[0-9a-f]{8}\] /;
  {
    // (B-g) idle recipient → kind default + no-accidental-hold default.
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const wkr = `qmd-g-wkr-${sfx}`;
    mkSession({ id: wkr, role: "worker" });
    db.appendEvent({
      id: `legacy-g-evt-${sfx}`, ts: now, managerSessionId: "legacy-sender", workerSessionId: wkr, taskId: null,
      kind: "session_message_queued", detail: { msgId: `legacy-g-${sfx}`, text: "LEGACY_ROW_IDLE", sender: "legacy-sender" },
    });
    pty.setLive(wkr); // idle, no busy
    const m = sessions.recoverUndeliveredMessagesOnBoot();
    check("(B-g) the legacy record redrove", m.reEnqueued === 1);
    const sentEntry = pty.sent.find((s) => s.text.includes("LEGACY_ROW_IDLE"));
    check("(B-g) DEFAULT kind → \"agent\" for a legacy record with no persisted kind", sentEntry?.kind === "agent");
    check("(B-g) DEFAULT no hold → an idle recipient gets it delivered immediately (giveUpHeldUntil defaulted to undefined, not an accidental hold)", pty.getPending(wkr).length === 0);
    check("(B-g) THE FIX: a Path D redrive carries the possible-duplicate tag even for a first-ever legacy row (no signal to know otherwise)", POSSIBLE_DUP_PREFIX_RE.test(sentEntry?.text ?? ""));
  }
  {
    // (B-h) busy recipient → rootMsgId/chainDepth defaults, proven via the resulting give-up event.
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const wkr = `qmd-h-wkr-${sfx}`;
    mkSession({ id: wkr, role: "worker" });
    const legacyMsgId = `legacy-h-${sfx}`;
    db.appendEvent({
      id: `legacy-h-evt-${sfx}`, ts: now, managerSessionId: "legacy-sender", workerSessionId: wkr, taskId: null,
      kind: "session_message_queued", detail: { msgId: legacyMsgId, text: "LEGACY_ROW_BUSY", sender: "legacy-sender" },
    });
    pty.setLive(wkr); pty.setBusy(wkr); // held → observable in the FIFO, giveUpOn-able
    const m = sessions.recoverUndeliveredMessagesOnBoot();
    const heldEntry = pty.getPending(wkr).find((t) => t.includes("LEGACY_ROW_BUSY"));
    check("(B-h) the legacy record redrove HELD (busy recipient)", m.reEnqueued === 1 && !!heldEntry);
    check("(B-h) THE FIX: the held redrive also carries the possible-duplicate tag", POSSIBLE_DUP_PREFIX_RE.test(heldEntry ?? ""));
    pty.giveUpOn(wkr); // exhaust the (redriven) legacy message's in-session budget → re-mint
    const gaveUpEvt = db.listEventsForWorker(wkr).find((e) => e.kind === "session_message_gave_up" && e.detail?.msgId === legacyMsgId);
    check("(B-h) DEFAULT rootMsgId → self-rooted at the legacy record's OWN msgId (never recoverable, so it starts a fresh chain here)", gaveUpEvt?.detail?.rootMsgId === legacyMsgId);
    check("(B-h) DEFAULT chainDepth → 0 (a legacy redrive is treated as a fresh dispatch)", gaveUpEvt?.detail?.chainDepth === 0);
  }

  // ============================== PART C — card 06ebbb78 CR follow-up ==============================
  // A REPRODUCED, real defect (not a hypothetical): resumeFleetOnBoot / recoverCrashOrphanedWorkers run
  // BEFORE recoverUndeliveredMessagesOnBoot in the SAME boot (index.ts), with NO `await` between them. For
  // a role that does NOT mount loom-orchestration (platform/auditor/workspace-auditor/setup/plain/run —
  // `usesOrchestrationMcp` false), enqueueDurableNudge dispatches SYNCHRONOUSLY. A freshly (re)spawned real
  // pty is NEVER `ready` this early (pty/host.ts's `live.ready` gate — SessionStart hasn't fired), so that
  // synchronous dispatch is ALWAYS held and ALWAYS persists a fresh session_message_queued record — and
  // WITHOUT the `mintedBefore` cutoff, the very next call (recoverUndeliveredMessagesOnBoot) would find
  // that just-minted record (no in-flight marker — it was never itself a redrive) and re-enqueue it AGAIN,
  // landing the SAME nudge twice in one coalesced turn. PtyStub (used everywhere above) does not model the
  // real `ready` gate at all, so it cannot reproduce this — this section uses the REAL PtyHost, exactly
  // like PART A above.
  //
  // This uses `resumeFleetOnBoot`'s own PLATFORM-role requester nudge (card 39fcaad3, `:5012`-ish in
  // sessions/service.ts) as the concrete instance — the exact site named in Code Review — but the fix
  // itself (recoverUndeliveredMessagesOnBoot's `mintedBefore` cutoff) is a CLASS fix at the shared boot
  // scan, so this also protects every other immediate-dispatch site (the manager/platform no-op-with-note
  // branch, the affected-platform branch, the fleet-resume-failure Lead notice, etc.) the same way.
  {
    const mkLeadFixture = async (label) => {
      const fakes = [];
      class TestPtyHost extends createSeamHost(PtyHost) {
        createPty(opts) {
          const base = super.createPty(opts);
          const writes = [];
          const fake = { ...base, write: (d) => { writes.push(d); }, writes };
          fakes.push(fake);
          return fake;
        }
      }
      const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
      const host = new TestPtyHost(events);
      const sessions = new SessionService(db, host, new OrchestrationControl());
      const lead = `qmd-c-${label}-lead-${sfx}`;
      mkSession({ id: lead, role: "platform" });
      host.spawn({ sessionId: lead, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
      return { host, sessions, lead, writtenText: () => fakes[0].writes.join("") };
    };
    const countOfIn = (text, needle) => text.split(needle).length - 1;

    // ---- (C-fixed) WITH the mintedBefore cutoff wired (exactly as index.ts wires it) → single delivery ----
    {
      const { host, sessions, lead, writtenText } = await mkLeadFixture("fixed");
      const bootStartedAt = new Date();
      const intent = { reason: "deploy merged code", managerSessionId: lead, requestedAt: now, resume: [{ sessionId: lead, role: "platform", parentSessionId: null }] };
      sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
      check("(C-fixed) setup: the requester's own nudge is a genuine held durable record right after resumeFleetOnBoot",
        db.listUndeliveredQueuedMessages().some((e) => e.workerSessionId === lead && e.detail.text.includes("now LIVE")));
      // Mirrors index.ts EXACTLY: no await between resumeFleetOnBoot and this call.
      const m = sessions.recoverUndeliveredMessagesOnBoot(bootStartedAt);
      check("(C-fixed) THE FIX: the boot scan SKIPPED the just-minted record (not reEnqueued, not retired)", m.reEnqueued === 0 && m.retired === 0);
      host.deliverHook(lead, { hook_event_name: "SessionStart" }); // now ready → drains
      const written = writtenText();
      check("(C-fixed) THE FIX: the requester's nudge reaches the real pty EXACTLY ONCE", countOfIn(written, "[loom:daemon-restarted]") === 1);
      check("(C-fixed) THE FIX: NO possible-duplicate frame was ever written (nothing to frame — only one dispatch happened)", countOfIn(written, "[loom:possible-duplicate") === 0);
    }

    // ---- (C-mechanism) THE SAME setup WITHOUT the cutoff → proves the check above is not vacuous: it can, ----
    // ---- and does, fail when the fix is bypassed (the positive control the fix itself needed). ----
    {
      const { host, sessions, lead, writtenText } = await mkLeadFixture("mech");
      const intent = { reason: "deploy merged code", managerSessionId: lead, requestedAt: now, resume: [{ sessionId: lead, role: "platform", parentSessionId: null }] };
      sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
      const m = sessions.recoverUndeliveredMessagesOnBoot(); // mintedBefore OMITTED — the pre-fix call shape
      check("(C-mechanism) NEGATIVE CONTROL: without the cutoff, the boot scan DOES re-enqueue the just-minted record", m.reEnqueued === 1);
      host.deliverHook(lead, { hook_event_name: "SessionStart" });
      const written = writtenText();
      check("(C-mechanism) NEGATIVE CONTROL: without the cutoff, the SAME nudge reaches the pty TWICE (the reproduced defect)", countOfIn(written, "[loom:daemon-restarted]") === 2);
      check("(C-mechanism) NEGATIVE CONTROL: the second copy is framed as a possible duplicate (redriveQueuedMessage's own tagging)", countOfIn(written, "[loom:possible-duplicate") === 1);
    }

    // ---- (C-predates) a record that genuinely PREDATES this boot is NOT skipped — the cutoff is surgical ----
    // Recipient left NOT-ready (no deliverHook yet, same shape as C-fixed) so the redrive HOLDS it — the
    // established pattern every other test in this file uses for "still-undelivered, redrive resolves it".
    {
      const { host, sessions, lead, writtenText } = await mkLeadFixture("predates");
      const staleTs = new Date(Date.now() - 60_000).toISOString(); // 1 minute before "now" — well before bootStartedAt below
      db.appendEvent({
        id: `qmd-c-predates-evt-${sfx}`, ts: staleTs, managerSessionId: "system", workerSessionId: lead, taskId: null,
        kind: "session_message_queued", detail: { msgId: `qmd-c-predates-msg-${sfx}`, text: "PRE-BOOT LEFTOVER", sender: "system", kind: "warning" },
      });
      const bootStartedAt = new Date(); // strictly AFTER staleTs
      const m = sessions.recoverUndeliveredMessagesOnBoot(bootStartedAt);
      check("(C-predates) a record from BEFORE this boot is NOT skipped by the cutoff — still redriven normally", m.reEnqueued === 1);
      host.deliverHook(lead, { hook_event_name: "SessionStart" }); // now ready → drains the held redrive
      check("(C-predates) the pre-boot leftover reaches the pty", writtenText().includes("PRE-BOOT LEFTOVER"));
      check("(C-predates) delivery resolves it (zero undelivered for it)", !db.listUndeliveredQueuedMessages().some((e) => e.detail.text === "PRE-BOOT LEFTOVER"));
    }
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a queued (delivered:false) session_message is persisted to a durable inbox, survives sender death AND a daemon restart, re-enqueues EXACTLY once on boot (no double with intent.pending), delivers + resolves on the recipient's turn boundary, surfaces still-undelivered outbound to a resumed sender (recycled recipients retired), and a redrive reconstructs its ORIGINAL kind/give-up-hold/chain instead of resetting them — with a legacy pre-fix record still redriving under the old hardcoded defaults."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
