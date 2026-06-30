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

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a session_message_queued whose recipient is NOT live at boot recovery is re-driven EXACTLY once when that recipient transitions to live (resume/live-flip), idempotent with the boot scan (no double, order-insensitive), retires a gone/superseded recipient (no zombie), and a held copy lost to a mid-process pty death is recovered once on the next boot (never doubled, never lost)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
