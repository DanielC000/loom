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
//     • getPersistablePending EXCLUDES onDeliver-bearing (durable) messages but keeps plain ones (the
//       daemon_restart snapshot dedup).
//
//   PART B — SessionService + Db + a contract-faithful PtyStub: the end-to-end durability.
//     (a) SENDER DEATH before flush → the held message still delivers on the recipient's next turn boundary
//         (sender liveness is irrelevant; the durable record + onDeliver carry it).
//     (b) DAEMON RESTART → the held message is NOT in intent.pending (getPersistablePending excludes it) and
//         the boot scan re-enqueues it EXACTLY ONCE onto the resumed recipient (no double), then it delivers
//         + resolves on the recipient's next turn.
//     (c) UNDELIVERED OUTBOUND → a held message whose recipient isn't live at boot is SURFACED to the resumed
//         (live) sender so it can re-send; a message to a RECYCLED/superseded recipient is RETIRED (bounded).
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
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

try {
  // ============================== PART A — REAL PtyHost onDeliver hook ==============================
  const fakes = [];
  function makeFakePty() {
    const writes = [];
    const fake = { pid: 4242, write: (d) => { writes.push(d); }, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes };
    fakes.push(fake); return fake;
  }
  class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
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

  // Session is now busy → subsequent enqueues are HELD. Queue a DURABLE message + a PLAIN one.
  let durFired = 0;
  const rDur = host.enqueueStdin(SID, "DURABLE_HELD", "system", () => { durFired++; });
  const rPlain = host.enqueueStdin(SID, "PLAIN_HELD"); // no onDeliver (a normal nudge/report)
  check("(A2) durable message queued behind busy (position 1, not delivered)", rDur.delivered === false && rDur.position === 1);
  check("(A2) plain message queued (position 2)", rPlain.delivered === false && rPlain.position === 2);

  // (A3) getPersistablePending EXCLUDES the durable (onDeliver) message, keeps the plain one — the snapshot dedup.
  check("(A3) getPending holds BOTH [DURABLE_HELD, PLAIN_HELD]", JSON.stringify(host.getPending(SID)) === JSON.stringify(["DURABLE_HELD", "PLAIN_HELD"]));
  check("(A3) getPersistablePending EXCLUDES the durable msg, keeps the plain one", JSON.stringify(host.getPersistablePending(SID)) === JSON.stringify(["PLAIN_HELD"]));

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
    constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); }
    setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
    setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
    enqueueStdin(id, text, _source = "system", onDeliver) {
      if (!this.live.has(id)) return { delivered: false };          // not alive → dropped (no position)
      if (!this.busy.has(id)) return { delivered: true };           // idle → immediate (onDeliver NOT fired)
      const a = this.q.get(id) ?? []; a.push({ text, onDeliver }); this.q.set(id, a);
      return { delivered: false, position: a.length };
    }
    drainOne(id) { const a = this.q.get(id) ?? []; const m = a.shift(); if (m?.onDeliver) m.onDeliver(); return m?.text; }
    // SUPERSEDE the head (as a redirectWorker flush does): pop it and fire its onDeliver WITH a reason,
    // so the durable record resolves annotated (e.g. "superseded") rather than as a plain delivery.
    supersedeHead(id, reason) { const a = this.q.get(id) ?? []; const m = a.shift(); if (m?.onDeliver) m.onDeliver(reason); return m?.text; }
    getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
    getPersistablePending(id) { return (this.q.get(id) ?? []).filter((m) => !m.onDeliver).map((m) => m.text); }
  }

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

    // Snapshot as requestDaemonRestart does: getPersistablePending EXCLUDES the durable message.
    const snap = ptyPre.getPersistablePending(wkr);
    check("(B-b) intent.pending snapshot EXCLUDES the durable message (dedup at the source)", !snap.some((t) => t.includes("RESTART DISPATCH")));
    check("(B-b) intent.pending snapshot STILL carries the plain nudge", snap.includes("plain nudge"));

    // ---- the daemon dies and boots fresh: a NEW pty (in-memory FIFO gone), SAME db. The fleet resumes. ----
    const ptyPost = new PtyStub();
    const sessionsPost = new SessionService(db, ptyPost, new OrchestrationControl());
    ptyPost.setLive(mgr); ptyPost.setBusy(mgr); ptyPost.setLive(wkr); ptyPost.setBusy(wkr); // resumed, not-ready ⇒ queue
    const intent = { reason: "deploy", managerSessionId: mgr, requestedAt: now,
      resume: [{ sessionId: mgr, role: "manager", parentSessionId: null }, { sessionId: wkr, role: "worker", parentSessionId: mgr }],
      pending: { [wkr]: snap } }; // ONLY the plain nudge — the durable msg is intentionally absent
    sessionsPost.resumeFleetOnBoot(intent, { resumeOne: () => true });
    const m = sessionsPost.recoverUndeliveredMessagesOnBoot();
    check("(B-b) boot scan re-enqueued the undelivered durable message", m.reEnqueued === 1);

    const wkrPending = ptyPost.getPending(wkr);
    const dispatchCount = wkrPending.filter((t) => t.includes("RESTART DISPATCH")).length;
    check("(B-b) recipient got the dispatch EXACTLY ONCE (no double from intent.pending + boot scan)", dispatchCount === 1);
    check("(B-b) the plain nudge was replayed by intent.pending (independent path intact)", wkrPending.filter((t) => t === "plain nudge").length === 1);

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

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a queued (delivered:false) session_message is persisted to a durable inbox, survives sender death AND a daemon restart, re-enqueues EXACTLY once on boot (no double with intent.pending), delivers + resolves on the recipient's turn boundary, and surfaces still-undelivered outbound to a resumed sender (recycled recipients retired)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
