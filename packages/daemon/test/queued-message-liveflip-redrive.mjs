import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Live-flip re-drive test (card 225559e5). NO claude, NO live daemon, NO process.exit.
//
// PROVES the fix for the gap traced in the card: a durable `session_message_queued` whose recipient is NOT
// live when the ONE-SHOT boot scan (recoverUndeliveredMessagesOnBoot) runs is left "STUCK", and recovery
// never re-runs for it — so a recipient that comes online LATER (a Lead resumed after the boot scan, a
// wake/crash-recovery resume, or a crash boot with no restart intent that never flipped it live first) used
// to orphan the message (the owner-witnessed 06-29 Lead message-loss). The fix re-drives a recipient's
// undelivered queued messages at the resume/live-flip chokepoint (resume() → redriveUndeliveredMessagesFor-
// Recipient), idempotently with the boot scan via an in-flight guard + the durable delivered marker.
//
// resume() itself is NOT driven here (it needs a real ~/.claude transcript + a real pty spawn — the sibling
// durability test stubs it out for the same reason). resume()'s ONLY new behavior is the single call
// `this.redriveUndeliveredMessagesForRecipient(session.id)` it makes AFTER flipping the row live + clearing
// busy; this test drives exactly that method against a live recipient (the contract-faithful PtyStub), so
// it faithfully exercises the live-flip re-drive at the level the fix introduces it.
//
// Run: 1) build daemon, 2) node test/queued-message-liveflip-redrive.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME BEFORE importing host.js/db.js (paths.ts reads it at import time).
const tmpHome = path.join(os.tmpdir(), `loom-qml-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Contract-faithful PtyStub (mirrors host onDeliver semantics; identical to the durability test's): a
// session must be `live` to receive; a `busy`/not-ready recipient QUEUES + stores onDeliver; an idle one
// delivers immediately (and, like the host, does NOT fire onDeliver). drainOne() = a turn boundary.
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
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
  // Simulate a pty DEATH without draining (session exited, FIFO lost): held copies vanish, onDeliver never fires.
  killWithoutDrain(id) { this.q.set(id, []); }
  // deliverRedirect's mechanics (card 02621025 scenario 8): flush the FIFO (empty when not-live/not-held —
  // no-op) and a no-op interrupt (real Esc-write timing isn't under test here).
  flushPending(id) { const a = this.q.get(id) ?? []; this.q.set(id, []); return a; }
  interruptForRedirect() { /* no-op stub — not under test here */ }
}

try {
  const db = new Db();
  const proj = `qml-proj-${sfx}`, agent = `qml-ag-${sfx}`;
  db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
  const mkSession = (o) => db.insertSession({
    id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
    processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
    worktreePath: null, branch: null, recycledFrom: o.recycledFrom ?? null,
  });
  const dispatchCount = (pty, id, marker) => pty.getPending(id).filter((t) => t.includes(marker)).length;
  const undelivered = (marker) => db.listUndeliveredQueuedMessages().filter((e) => e.detail.text.includes(marker)).length;

  // ===================== (1) LATER-ONLINE — the core gap: not live at boot scan, re-driven on live-flip =====================
  // (The 06-29 symptom was a cross-tree send to a Lead; messageWorker is parent-gated so we model the SAME
  // durable session_message_queued record the realistic, un-gated way — a busy worker holding a manager send.)
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `qml-A-mgr-${sfx}`, wkr = `qml-A-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr); // recipient busy → HELD + persisted as session_message_queued

    const r = sessions.messageWorker(mgr, wkr, "LATER DISPATCH");
    check("(1) busy recipient → message HELD + persisted", r.delivered === false && undelivered("LATER DISPATCH") === 1);

    // --- daemon dies; on boot the recipient is NOT live yet (resumeFleetOnBoot hasn't flipped it / a crash
    //     boot has no intent). The one-shot boot scan runs and CANNOT deliver → leaves it stuck. ---
    const ptyBoot = new PtyStub();
    const sessionsBoot = new SessionService(db, ptyBoot, new OrchestrationControl());
    db.setProcessState(wkr, "exited"); // recipient exists but is not live when recovery runs
    const m = sessionsBoot.recoverUndeliveredMessagesOnBoot();
    check("(1) boot scan does NOT deliver to a not-live recipient (left undelivered)", m.reEnqueued === 0 && undelivered("LATER DISPATCH") === 1);

    // --- the recipient comes online LATER (the resume/live-flip path): flip it live + clear busy, exactly as
    //     resume() does, then invoke the re-drive resume() now calls. ---
    db.setProcessState(wkr, "live"); ptyBoot.setLive(wkr); ptyBoot.setBusy(wkr); // resumed, not-ready ⇒ queues
    sessionsBoot.redriveUndeliveredMessagesForRecipient(wkr);
    check("(1) live-flip RE-DRIVES the orphaned message EXACTLY ONCE", dispatchCount(ptyBoot, wkr, "LATER DISPATCH") === 1);
    check("(1) the durable record is still unresolved until it drains (held, not lost)", undelivered("LATER DISPATCH") === 1);

    // drain → resolves the ORIGINAL record (no duplicate record minted).
    const drained = ptyBoot.drainOne(wkr);
    check("(1) the re-driven message delivers on the recipient's next turn", typeof drained === "string" && drained.includes("LATER DISPATCH"));
    check("(1) delivery RESOLVED the durable record (zero undelivered)", undelivered("LATER DISPATCH") === 0);
  }

  // ===================== (2) IDEMPOTENCY — boot scan AND live-flip BOTH run → no double-deliver =====================
  // The real boot order: resumeFleetOnBoot → resume() (→ the live-flip re-drive) FIRST, then
  // recoverUndeliveredMessagesOnBoot. Both see the recipient live; the in-flight guard makes the second a no-op.
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `qml-B-mgr-${sfx}`, wkr = `qml-B-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);
    sessions.messageWorker(mgr, wkr, "BOTH DISPATCH");
    check("(2) pre-boot: 1 undelivered durable message", undelivered("BOTH DISPATCH") === 1);

    // Boot: NEW pty, SAME db. The recipient is resumed live (not-ready ⇒ queues).
    const ptyBoot = new PtyStub();
    const sessionsBoot = new SessionService(db, ptyBoot, new OrchestrationControl());
    db.setProcessState(wkr, "live"); ptyBoot.setLive(wkr); ptyBoot.setBusy(wkr);

    // (a) resume()'s live-flip re-drive runs FIRST (as in resumeFleetOnBoot) → enqueues once + marks in-flight.
    sessionsBoot.redriveUndeliveredMessagesForRecipient(wkr);
    // (b) the one-shot boot scan runs AFTER → sees the msgId in-flight → counts it but enqueues NOTHING.
    const m = sessionsBoot.recoverUndeliveredMessagesOnBoot();
    check("(2) boot scan reports the message handled (reEnqueued)", m.reEnqueued === 1);
    check("(2) recipient got the dispatch EXACTLY ONCE (in-flight guard blocked the double)", dispatchCount(ptyBoot, wkr, "BOTH DISPATCH") === 1);

    // Reverse interleave is structurally impossible (resume() short-circuits on an alive pty before re-driving),
    // but prove the guard is order-insensitive: a fresh recipient where the boot scan runs FIRST.
    const wkr2 = `qml-B2-wkr-${sfx}`;
    mkSession({ id: wkr2, role: "worker", parentSessionId: mgr });
    pty.setLive(wkr2); pty.setBusy(wkr2); sessions.messageWorker(mgr, wkr2, "ORDER DISPATCH");
    const ptyBoot2 = new PtyStub();
    const sessionsBoot2 = new SessionService(db, ptyBoot2, new OrchestrationControl());
    db.setProcessState(wkr2, "live"); ptyBoot2.setLive(wkr2); ptyBoot2.setBusy(wkr2);
    sessionsBoot2.recoverUndeliveredMessagesOnBoot();        // boot scan first → enqueues + marks in-flight
    sessionsBoot2.redriveUndeliveredMessagesForRecipient(wkr2); // live-flip after → sees in-flight → no double
    check("(2) order-insensitive: boot-scan-then-live-flip still delivers EXACTLY ONCE", dispatchCount(ptyBoot2, wkr2, "ORDER DISPATCH") === 1);
  }

  // ===================== (3) NO REGRESSION — a gone/superseded recipient is RETIRED on the live-flip path too =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `qml-C-mgr-${sfx}`, wkr = `qml-C-wkr-${sfx}`, succ = `qml-C-succ-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);
    sessions.messageWorker(mgr, wkr, "ZOMBIE DISPATCH");      // held + persisted in the PRE pty
    mkSession({ id: succ, role: "worker", parentSessionId: mgr, recycledFrom: wkr }); // wkr is now superseded

    // The session is resumed on a FRESH pty (the PRE pty + its FIFO are gone). Even if a superseded recipient
    // somehow flips live, the re-drive RETIRES (never zombie-redelivers) it.
    const ptyBoot = new PtyStub();
    const sessionsBoot = new SessionService(db, ptyBoot, new OrchestrationControl());
    db.setProcessState(wkr, "live"); ptyBoot.setLive(wkr); ptyBoot.setBusy(wkr);
    sessionsBoot.redriveUndeliveredMessagesForRecipient(wkr);
    check("(3) a superseded recipient's message is RETIRED, not re-driven (no zombie delivery)", dispatchCount(ptyBoot, wkr, "ZOMBIE DISPATCH") === 0 && undelivered("ZOMBIE DISPATCH") === 0);
  }

  // ===================== (4) PTY DEATH MID-HOLD — a held re-drive lost to a pty death is recovered on the NEXT boot (no double, no loss) =====================
  // A message re-driven onto a live recipient is HELD (in-flight marked, record unresolved). If that pty DIES
  // before it drains (session exit mid-process), the in-flight mark stays set in THIS process (onDeliver never
  // fired) — so a same-process re-resume does NOT re-drive it (correctly: re-driving onto a still-marked msg is
  // exactly what the guard blocks). It is NOT lost: the record stays undelivered and the NEXT daemon boot (a
  // fresh process → empty in-flight set) re-drives it once. This is the pre-fix baseline (deferred to next
  // boot), never a double-deliver — the property the guard protects.
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `qml-D-mgr-${sfx}`, wkr = `qml-D-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);
    sessions.messageWorker(mgr, wkr, "STALE DISPATCH");

    // Boot: fresh pty. Live-flip re-drive enqueues + holds + marks in-flight.
    const ptyBoot = new PtyStub();
    const sessionsBoot = new SessionService(db, ptyBoot, new OrchestrationControl());
    db.setProcessState(wkr, "live"); ptyBoot.setLive(wkr); ptyBoot.setBusy(wkr);
    sessionsBoot.redriveUndeliveredMessagesForRecipient(wkr);
    check("(4) live-flip held the re-drive (in-flight, still unresolved)", dispatchCount(ptyBoot, wkr, "STALE DISPATCH") === 1 && undelivered("STALE DISPATCH") === 1);

    // The pty DIES without draining (held copy lost; onDeliver never fired). A same-process re-resume must NOT
    // double-enqueue (the in-flight guard holds), and the record stays undelivered for the next boot.
    ptyBoot.killWithoutDrain(wkr);
    sessionsBoot.redriveUndeliveredMessagesForRecipient(wkr);
    check("(4) a same-process re-resume does NOT re-enqueue (in-flight guard blocks a double)", dispatchCount(ptyBoot, wkr, "STALE DISPATCH") === 0 && undelivered("STALE DISPATCH") === 1);

    // NEXT daemon boot = a fresh process (empty in-flight set): the boot scan re-drives it exactly once.
    const ptyNext = new PtyStub();
    const sessionsNext = new SessionService(db, ptyNext, new OrchestrationControl());
    db.setProcessState(wkr, "live"); ptyNext.setLive(wkr); ptyNext.setBusy(wkr);
    const m = sessionsNext.recoverUndeliveredMessagesOnBoot();
    check("(4) the next boot's scan recovers the message exactly once (not lost)", m.reEnqueued === 1 && dispatchCount(ptyNext, wkr, "STALE DISPATCH") === 1);
    const drained = ptyNext.drainOne(wkr);
    check("(4) and it finally delivers + resolves", typeof drained === "string" && drained.includes("STALE DISPATCH") && undelivered("STALE DISPATCH") === 0);
  }

  // Append a synthetic orchestration event directly (bypassing SessionService), so a test can place a
  // `redirect_worker` / `worker_report` at a precise, guaranteed-later point in a recipient's timeline
  // without the full mechanics (the Playwright-free PtyStub doesn't implement flushPending /
  // interruptForRedirect, so driving redirectWorker()/workerReport() directly isn't viable here).
  const laterTs = () => new Date(Date.now() + 60_000).toISOString(); // +1min: safely after any "now" write above

  // ===================== (5) REDIRECT SUPERSEDES — card 02621025, DoD-1 =====================
  // A durable record's OWN redirect (worker_redirect's contract: "replace ALL pending direction") already
  // fires while the recipient is live, via deliverRedirect's flushPending+supersede step — but that only
  // reaches `live.pending`. If the recipient is NOT live when the redirect goes out, flushPending finds
  // nothing, and the durable record is the ONLY surviving trace of the direction the redirect declared
  // dead. staleQueuedMessageReason must retire it (not redrive it) once the recipient comes back live.
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `qml-E-mgr-${sfx}`, wkr = `qml-E-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);
    sessions.messageWorker(mgr, wkr, "STALE PRE-REDIRECT");
    const rec = db.listUndeliveredQueuedMessages().find((e) => e.detail.text.includes("STALE PRE-REDIRECT"));
    const msgId = rec?.detail?.msgId;
    check("(5) the pre-redirect message is held + persisted", typeof msgId === "string");

    // Recipient crashes before it can drain (undelivered). A redirect is sent while it's down — recorded
    // as a `redirect_worker` event with a LATER ts (its own durable session_message_queued detail is
    // irrelevant here; only the sibling event kind/ts matters to staleQueuedMessageReason).
    db.setProcessState(wkr, "exited");
    db.appendEvent({ id: randomUUID(), ts: laterTs(), managerSessionId: mgr, workerSessionId: wkr, taskId: null, kind: "redirect_worker", detail: { delivered: false, superseded: 0 } });

    // Recipient comes back live (live-flip path).
    const ptyBoot = new PtyStub();
    const sessionsBoot = new SessionService(db, ptyBoot, new OrchestrationControl());
    db.setProcessState(wkr, "live"); ptyBoot.setLive(wkr); ptyBoot.setBusy(wkr);
    sessionsBoot.redriveUndeliveredMessagesForRecipient(wkr);

    check("(5) the redirect-superseded record is NEVER redriven", dispatchCount(ptyBoot, wkr, "STALE PRE-REDIRECT") === 0);
    check("(5) the redirect-superseded record is retired (zero undelivered)", undelivered("STALE PRE-REDIRECT") === 0);
    const marker = db.listEventsForWorker(wkr).find((e) => e.kind === "session_message_delivered" && e.detail?.msgId === msgId);
    check("(5) the resolution records reason \"superseded-by-redirect\"", marker?.detail?.reason === "superseded-by-redirect");
  }

  // ===================== (6) ADDITIVE PRESERVED — the regression guard proving the fix did NOT overcorrect =====================
  // worker_message is ADDITIVE by contract: a manager routinely sends "fix finding 1" then, separately,
  // "also fix finding 2". A newer PLAIN message_worker existing must NEVER retire an older queued one —
  // that would SILENTLY DESTROY manager-authored direction, the same failure class this card fixes (a
  // directive never executed) with WORSE blast radius (invisible — no stale-and-wrong redrive for anyone
  // to notice; the instruction just vanishes). This is the test that stops a future well-meaning change
  // from re-introducing silent direction loss by widening the staleness check to plain messages.
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `qml-F-mgr-${sfx}`, wkr = `qml-F-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);
    sessions.messageWorker(mgr, wkr, "OLDER FIX 1");

    // Recipient crashes before either message can drain. A SECOND, additive worker_message is sent while
    // it's down — also held + persisted (not a synthetic event this time: the real messageWorker call, so
    // its own `message_worker` sibling event is genuine, exactly like the real incident's M2).
    db.setProcessState(wkr, "exited");
    sessions.messageWorker(mgr, wkr, "ALSO FIX 2");
    check("(6) both additive messages are held + persisted while the recipient is down",
      undelivered("OLDER FIX 1") === 1 && undelivered("ALSO FIX 2") === 1);

    // Recipient comes back live (live-flip path) — both should redrive, in chronological order.
    const ptyBoot = new PtyStub();
    const sessionsBoot = new SessionService(db, ptyBoot, new OrchestrationControl());
    db.setProcessState(wkr, "live"); ptyBoot.setLive(wkr); ptyBoot.setBusy(wkr);
    sessionsBoot.redriveUndeliveredMessagesForRecipient(wkr);

    check("(6) the OLDER additive message is still redriven (never silently retired)", dispatchCount(ptyBoot, wkr, "OLDER FIX 1") === 1);
    check("(6) the NEWER additive message is also redriven", dispatchCount(ptyBoot, wkr, "ALSO FIX 2") === 1);
    const order = ptyBoot.getPending(wkr);
    const idxOlder = order.findIndex((t) => t.includes("OLDER FIX 1"));
    const idxNewer = order.findIndex((t) => t.includes("ALSO FIX 2"));
    check("(6) they redrive in chronological (FIFO) order — OLDER before NEWER", idxOlder >= 0 && idxNewer >= 0 && idxOlder < idxNewer);
  }

  // ===================== (7) ALREADY-REPORTED — card 02621025, DoD-2 =====================
  // Mirrors the origin incident (39cbe5b5) directly: a "check background task… commit… report done"
  // instruction is queued, the worker (via its own natural progress) already worker_report's for that
  // SAME task before the stale instruction is ever redriven — so redriving it now would just re-ask an
  // already-answered question. Must retire, not redrive.
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `qml-G-mgr-${sfx}`, wkr = `qml-G-wkr-${sfx}`, taskId = `qml-G-task-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);
    sessions.messageWorker(mgr, wkr, "CHECK BG THEN COMMIT THEN REPORT DONE");
    const rec = db.listUndeliveredQueuedMessages().find((e) => e.detail.text.includes("CHECK BG THEN COMMIT THEN REPORT DONE"));
    const msgId = rec?.detail?.msgId;
    check("(7) the background-check instruction is held + persisted", typeof msgId === "string");

    // Recipient crashes before it can drain. It resumes on its own (crash-recovery), independently
    // completes the exact sequence, and reports done for the SAME task — recorded with a LATER ts.
    db.setProcessState(wkr, "exited");
    db.appendEvent({ id: randomUUID(), ts: laterTs(), managerSessionId: mgr, workerSessionId: wkr, taskId, kind: "worker_report", detail: { status: "done", summary: "checked background task, committed" } });

    // NOW the recipient is redriven (live-flip) — the stale instruction must be retired, not redelivered.
    const ptyBoot = new PtyStub();
    const sessionsBoot = new SessionService(db, ptyBoot, new OrchestrationControl());
    db.setProcessState(wkr, "live"); ptyBoot.setLive(wkr); ptyBoot.setBusy(wkr);
    sessionsBoot.redriveUndeliveredMessagesForRecipient(wkr);

    check("(7) the already-reported instruction is NEVER redriven", dispatchCount(ptyBoot, wkr, "CHECK BG THEN COMMIT THEN REPORT DONE") === 0);
    check("(7) the already-reported instruction is retired (zero undelivered)", undelivered("CHECK BG THEN COMMIT THEN REPORT DONE") === 0);
    const marker = db.listEventsForWorker(wkr).find((e) => e.kind === "session_message_delivered" && e.detail?.msgId === msgId);
    check("(7) the resolution records reason \"already-reported\"", marker?.detail?.reason === "already-reported");
  }

  // ===================== (8) SELF-MATCH HAZARD — a HELD redirect to a NOT-LIVE recipient must still redrive =====================
  // Caught in review: `deliverRedirect` appends its `redirect_worker` event via a SEPARATE `new Date()`
  // call, strictly AFTER `enqueueDurableMessage` (inside it) computes the ts for the redirect's OWN
  // session_message_queued record — so the sibling event's ts typically lands AT OR AFTER the record's own
  // ts (real work, incl. interruptForRedirect, runs between the two calls). Drives the REAL redirectWorker
  // → deliverRedirect path (not a synthetic event, unlike scenario 5) specifically so this reproduces that
  // ordinary ordering, not a contrived one. Before the fix this would have retired the redirect's own
  // record as "superseded by itself" — silently dropping a redirect sent to a not-live recipient. Must NOT
  // regress: the record must still redrive and deliver.
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `qml-H-mgr-${sfx}`, wkr = `qml-H-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); // recipient NOT live — deliverRedirect's own flushPending finds nothing to supersede,
    // so its durable record is the only surviving trace of the redirect.
    const r = sessions.redirectWorker(mgr, wkr, "URGENT REDIRECT WHILE DOWN");
    check("(8) the redirect is held (recipient not live) and persisted durably", r.delivered === false);
    const rec = db.listUndeliveredQueuedMessages().find((e) => e.detail.text.includes("URGENT REDIRECT WHILE DOWN"));
    const msgId = rec?.detail?.msgId;
    check("(8) the redirect's own record carries a msgId", typeof msgId === "string");
    const sibling = db.listEventsForWorker(wkr).find((e) => e.kind === "redirect_worker");
    check("(8) the sibling redirect_worker event stamps the SAME queuedMsgId (the linkage this fix relies on)", sibling?.detail?.queuedMsgId === msgId);
    check("(8) the sibling event's ts is AT/AFTER the record's own ts — the ordinary case, not an edge case", sibling && rec && sibling.ts >= rec.ts);

    // Recipient comes back live later (live-flip path).
    const ptyBoot = new PtyStub();
    const sessionsBoot = new SessionService(db, ptyBoot, new OrchestrationControl());
    db.setProcessState(wkr, "live"); ptyBoot.setLive(wkr); ptyBoot.setBusy(wkr);
    sessionsBoot.redriveUndeliveredMessagesForRecipient(wkr);

    check("(8) the redirect's OWN record is still redriven — NOT self-retired", dispatchCount(ptyBoot, wkr, "URGENT REDIRECT WHILE DOWN") === 1);
    const drained = ptyBoot.drainOne(wkr);
    check("(8) it delivers on the recipient's next turn", typeof drained === "string" && drained.includes("URGENT REDIRECT WHILE DOWN"));
    const marker = db.listEventsForWorker(wkr).find((e) => e.kind === "session_message_delivered" && e.detail?.msgId === msgId);
    check("(8) it resolves as a PLAIN delivery, not a \"superseded-by-redirect\" retirement", marker !== undefined && marker.detail?.reason === undefined);
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a session_message_queued whose recipient is NOT live at boot recovery is re-driven EXACTLY once when that recipient transitions to live (resume/live-flip), idempotent with the boot scan (no double, order-insensitive), retires a gone/superseded recipient (no zombie), a held copy lost to a mid-process pty death is recovered once on the next boot (never doubled, never lost), a record superseded by a LATER redirect is retired (not redriven), a record superseded by a LATER additive message_worker is STILL redriven (never silently destroyed), and a record whose instructed outcome the worker already worker_report'd is retired as already-reported."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
