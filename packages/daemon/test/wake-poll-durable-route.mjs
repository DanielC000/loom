import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 61a012ce — end-to-end proof of the NEW plumbing wake.ts/poll.ts now depend on: a REAL
// SessionService (not a mock), proving:
//   (1) enqueueSystemNudge (the new PUBLIC wrapper WakeService/PollService call via `enqueueDurable`)
//       persists a durable session_message_queued record on a HELD (busy target) dispatch — the actual
//       fix, since a bare pty.enqueueStdin held-not-delivered outcome never persisted anything.
//   (2) a companion ROUTE survives a boot-scan redrive (recoverUndeliveredMessagesOnBoot) — the gap
//       found during design review: enqueueDurableMessage used to hardcode route:undefined into its own
//       enqueueStdin call, and redriveQueuedMessage never read one back either, so NOTHING in the durable
//       path carried a route before this card, even though wake.ts's companion-reminder branch needs it.
//   (3) a LEGACY row (no `route` key at all — the pre-this-card shape) redrives as a plain nudge without
//       throwing — the regression risk of adding a new persisted field to a redrive path shared by every
//       other durable message kind.
// Uses the SAME contract-faithful PtyStub shape as queued-message-durability.mjs (NO claude), extended
// to CAPTURE route (that harness's own stub ignores it — `_route` — since none of ITS scenarios needed
// it). Hermetic: one shared temp .db across the file's scenarios (mirrors that harness), cleaned up at
// the end.
//
// Run: 1) build daemon, 2) node test/wake-poll-durable-route.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wprd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Route-capturing PtyStub — same delivery semantics as queued-message-durability.mjs's own stub
// (live+busy ⇒ queue; live+idle ⇒ immediate; not live ⇒ dropped), but `sent` also records `route` so
// this file can assert on it (the shared harness's copy deliberately doesn't, since none of its own
// scenarios exercise a route).
class RoutePtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.sent = []; }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  enqueueStdin(id, text, _source = "system", onDeliver, route, kind = "warning", _questionId, _ownerText, _proactive, _senderId, giveUpHeldUntil, onGiveUpExhausted) {
    this.sent.push({ id, text, kind, route });
    if (!this.live.has(id)) return { delivered: false };
    const stillGiveUpHeld = giveUpHeldUntil !== undefined && Date.now() < giveUpHeldUntil;
    if (!this.busy.has(id) && !stillGiveUpHeld) return { delivered: true };
    const a = this.q.get(id) ?? []; a.push({ text, onDeliver, kind, route, giveUpHeldUntil, onGiveUpExhausted }); this.q.set(id, a);
    return { delivered: false, position: a.length };
  }
  drainOne(id) { const a = this.q.get(id) ?? []; const m = a.shift(); if (m?.onDeliver) m.onDeliver(); return m?.text; }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
}

const db = new Db();
const proj = `wprd-proj-${sfx}`, agent = `wprd-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null,
});

try {
  // ---- (1) enqueueSystemNudge on a BUSY (held) recipient persists a durable record ----
  {
    const pty = new RoutePtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const target = `wprd-1-${sfx}`;
    mkSession({ id: target });
    pty.setLive(target); pty.setBusy(target); // busy → held, not delivered now

    const r = sessions.enqueueSystemNudge(target, "[loom:wake] check the deploy", { kind: "agent" });
    check("(1) busy target → held, not delivered now", r.delivered === false && r.position === 1);
    const undeliv = db.listUndeliveredQueuedMessages();
    check("(1) HELD dispatch is PERSISTED as an undelivered session_message_queued — the actual fix (nothing existed here before this card)",
      undeliv.some((e) => e.workerSessionId === target && e.detail.text.includes("check the deploy")));

    // It still delivers normally once the recipient reaches its next turn boundary (nothing regressed).
    const drained = pty.drainOne(target);
    check("(1) still delivers on the recipient's next turn boundary", drained === "[loom:wake] check the deploy");
    check("(1) delivery resolved the durable record", !db.listUndeliveredQueuedMessages().some((e) => e.detail.text.includes("check the deploy")));
  }

  // ---- (2) a companion ROUTE survives a boot-scan redrive (positive-controlled: FAILS if route is
  //      dropped anywhere on the enqueue→persist→redrive round trip) ----
  {
    const route = { channel: "telegram", chatId: "12345" };
    const target = `wprd-2-${sfx}`;
    mkSession({ id: target });

    // Pre-restart: busy target, dispatch WITH a route → held, persisted with the route.
    const ptyPre = new RoutePtyStub();
    const sessionsPre = new SessionService(db, ptyPre, new OrchestrationControl());
    ptyPre.setLive(target); ptyPre.setBusy(target);
    sessionsPre.enqueueSystemNudge(target, "[loom:reminder] circle back", { kind: "agent", route });
    const preRecord = db.listUndeliveredQueuedMessages().find((e) => e.workerSessionId === target);
    check("(2) pre-restart: the durable record's OWN detail carries the route", JSON.stringify(preRecord?.detail?.route) === JSON.stringify(route));

    // Restart: fresh pty (in-memory FIFO gone), SAME db, recipient now idle (so the redrive delivers
    // immediately and lands in `sent`, where this test can inspect it).
    const ptyPost = new RoutePtyStub();
    const sessionsPost = new SessionService(db, ptyPost, new OrchestrationControl());
    ptyPost.setLive(target); // idle, not busy
    const outcome = sessionsPost.recoverUndeliveredMessagesOnBoot();
    check("(2) boot scan re-enqueued the durable message", outcome.reEnqueued === 1);
    const redriven = ptyPost.sent.find((s) => s.id === target && s.text.includes("circle back"));
    check("(2) the redrive's OWN enqueueStdin call carries the SAME route (this assertion is the positive control: it reads route:undefined — and FAILS — against pre-card code, since neither enqueueDurableMessage nor redriveQueuedMessage threaded it through before this fix)",
      !!redriven && JSON.stringify(redriven.route) === JSON.stringify(route));
  }

  // ---- (3) a LEGACY row (written before this card — no `route` key at all) redrives as a plain nudge,
  //      without throwing ----
  {
    const target = `wprd-3-${sfx}`;
    mkSession({ id: target });
    const msgId = `legacy-msg-${sfx}`;
    // Hand-craft the record the way enqueueDurableMessage wrote it BEFORE this card: no `route` key.
    db.appendEvent({
      id: `legacy-evt-${sfx}`, ts: now,
      managerSessionId: "system", workerSessionId: target, taskId: null,
      kind: "session_message_queued",
      detail: { msgId, text: "[loom:wake] legacy note", sender: "system", kind: "agent", rootMsgId: msgId, chainDepth: 0 },
    });
    check("(3) sanity: the legacy record is picked up as undelivered", db.listUndeliveredQueuedMessages().some((e) => e.detail.msgId === msgId));

    const pty = new RoutePtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    pty.setLive(target); // idle → redrive delivers immediately, lands in `sent`

    let threw = null;
    let outcome;
    try { outcome = sessions.recoverUndeliveredMessagesOnBoot(); } catch (e) { threw = e; }
    check("(3) redriving a route-less legacy record does NOT throw", threw === null);
    check("(3) it still redrives (reEnqueued, not skipped/stuck)", outcome && outcome.reEnqueued >= 1);
    const redriven = pty.sent.find((s) => s.id === target && s.text.includes("legacy note"));
    check("(3) it redrives as a PLAIN nudge — route is undefined, not a crash or a fabricated value", !!redriven && redriven.route === undefined);
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — enqueueSystemNudge (the new WakeService/PollService entrypoint) persists a durable record on a HELD dispatch, a companion route survives enqueue→persist→boot-redrive round trip intact, and a pre-card legacy row (no route field) redrives as a plain nudge without throwing (card 61a012ce)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
