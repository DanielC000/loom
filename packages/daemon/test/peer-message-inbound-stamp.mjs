import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card 788781da — `peer_message` frames stamp two server-computed "last inbound FROM the recipient's
// project" timestamps (`last-inbound-this-session` + `last-inbound-project`), so a crossing pair (A sends,
// B sends before receiving A's) stops being indistinguishable from a reply, and a recipient recycle can't
// manufacture a false "they've seen it" belief. DETERMINISTIC + CLAUDE-FREE: a real Db + SessionService
// driven against a contract-faithful PtyStub (the SAME held/delivered shape as
// test/peer-message-recycle-inheritance.mjs's own stub) — no mocking of `messagePeerManager` itself.
//
// PROVES (RED-FIRST — see the manual revert/rebuild/rerun this test was developed against, noted in the
// worker's own done-report; this file's assertions alone are what must go RED without the fix and GREEN
// with it):
//   (1) DoD-3, a GENUINE CROSSING: A sends letter1 to B (held — B is busy, NOT yet delivered) — B then
//       sends letter2 to A BEFORE ever receiving letter1. letter2's OWN frame must read
//       last-inbound-this-session:none and last-inbound-project:none — proving, from the transport itself,
//       that B's letter2 could not possibly be a reply to anything A has sent. Once letter1 actually
//       drains (B's held queue flushes), a THIRD letter (letter3, B→A) must show a REAL timestamp for both
//       fields — the same transport now correctly reflecting B has heard from A.
//   (2) DoD-4, THE RECYCLE CASE: a manager (mgrB_old) receives a live-delivered letter from A, then
//       RECYCLES to a successor (mgrB_new) with NO memory of that exchange. When mgrB_new later sends its
//       OWN letter to A, its frame must show last-inbound-this-session:none (this exact session never
//       received anything) while last-inbound-project carries the PREDECESSOR's real receipt timestamp —
//       proving the two fields are NOT redundant: the project was told, this author wasn't.
//   (3) §INBOUND is respected: a letter still QUEUED (not yet drained) is never counted as inbound — proven
//       by (1)'s own held-letter1 state before it flushes.
//
// Run: 1) build (turbo builds shared first), 2) node test/peer-message-inbound-stamp.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-peer-inbound-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// Same contract-faithful PtyStub as peer-message-recycle-inheritance.mjs: a LIVE+BUSY recipient HOLDS an
// enqueue (delivered:false, onDeliver captured); a LIVE+idle recipient delivers immediately.
// `deliver(id)` (this file's own addition) fires the OLDEST still-held entry's onDeliver directly — the
// stand-in for a real host actually draining a held message into a turn.
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); }
  setLive(id, on = true) { if (on) this.live.add(id); else { this.live.delete(id); this.busy.delete(id); } }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  enqueueStdin(id, text, source = "system", onDeliver) {
    if (!this.live.has(id)) return { delivered: false };
    if (!this.busy.has(id)) { const a = this.q.get(id) ?? []; a.push({ text, source, delivered: true }); this.q.set(id, a); return { delivered: true }; }
    const a = this.q.get(id) ?? []; a.push({ text, source, onDeliver, delivered: false }); this.q.set(id, a);
    return { delivered: false, position: a.length };
  }
  deliver(id) {
    const a = this.q.get(id) ?? [];
    const held = a.find((m) => !m.delivered && typeof m.onDeliver === "function");
    if (!held) throw new Error(`PtyStub.deliver: no held entry for ${id}`);
    held.delivered = true;
    held.onDeliver();
  }
  // recycleManager's own carry-forward needs these three (mirrors peer-message-recycle-inheritance.mjs's
  // own PtyStub): flushPending splices+returns held entries WITH onDeliver (not firing it — recycleManager
  // re-mints them onto the successor itself).
  flushPending(id) { const a = (this.q.get(id) ?? []).filter((m) => !m.delivered); this.q.set(id, []); return a; }
  getPending(id) { return (this.q.get(id) ?? []).filter((m) => !m.delivered).map((m) => m.text); }
  pendingEntries(id) { return (this.q.get(id) ?? []).filter((m) => !m.delivered); }
  spawn(opts) { this.setLive(opts.sessionId); }
  stop(id) { this.setLive(id, false); }
  isAlive(id) { return this.live.has(id); }
}

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const db = new Db();

const mkProject = (id, name) => db.insertProject({ id, name, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
const mkAgent = (id, projectId) => db.insertAgent({ id, projectId, name: "t", startupPrompt: "BRIEF", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: o.projectId, agentId: o.agentId, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? "manager", parentSessionId: o.parentSessionId ?? null,
});

const stampFields = (text) => {
  const m = text.match(/last-inbound-this-session:(\S+) · last-inbound-project:(\S+)\]/);
  return m ? { thisSession: m[1], project: m[2] } : null;
};

try {
  const pA = `pA-${sfx}`, pB = `pB-${sfx}`;
  mkProject(pA, "Project A"); mkProject(pB, "Project B");
  db.createProjectLink(pA, pB);
  const agA = `agA-${sfx}`, agB = `agB-${sfx}`;
  mkAgent(agA, pA); mkAgent(agB, pB);

  // ============ (1) DoD-3 + DoD-9(§INBOUND): a genuine crossing, then the post-drain contrast ============
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgrA = `mgrA1-${sfx}`, mgrB = `mgrB1-${sfx}`;
    mkSession({ id: mgrA, projectId: pA, agentId: agA });
    mkSession({ id: mgrB, projectId: pB, agentId: agB });
    pty.setLive(mgrA); pty.setLive(mgrB); pty.setBusy(mgrB); // B is busy → A's send to B HOLDS

    const sentLetter1 = sessions.messagePeerManager(mgrA, pB, "letter1 from A");
    check("(1) setup: letter1 (A→B) HELD — B is busy, not yet delivered", sentLetter1.deliveryStatus === "queued");

    // B sends letter2 to A BEFORE ever receiving (draining) letter1 — the genuine crossing.
    const sentLetter2 = sessions.messagePeerManager(mgrB, pA, "letter2 from B, unaware of letter1");
    check("(1) setup: letter2 (B→A) delivered live (A is idle)", sentLetter2.deliveryStatus === "delivered-live");
    const letter2Text = pty.q.get(mgrA).find((m) => m.text.includes("letter2 from B")).text;
    const letter2Stamps = stampFields(letter2Text);
    check("(1) CROSSING PROVEN: letter2's frame carries BOTH staleness fields", !!letter2Stamps);
    check("(1) CROSSING PROVEN: last-inbound-this-session:none — B genuinely had not heard from A when it sent letter2",
      letter2Stamps?.thisSession === "none");
    check("(1) CROSSING PROVEN: last-inbound-project:none — A's project had never told B's project anything either",
      letter2Stamps?.project === "none");
    check("(1) §INBOUND: a still-QUEUED letter1 is NOT counted as inbound (the none above is not a fluke of timing)",
      db.getQueuedMessageDeliveredAt(sentLetter1.msgId) === null);

    // Now letter1 actually drains (B's held queue flushes) — the real hand-off this card calls "delivered".
    pty.deliver(mgrB);
    check("(1) setup: letter1 is now genuinely delivered", db.getQueuedMessageDeliveredAt(sentLetter1.msgId) !== null);

    // A THIRD letter, B→A, now must show B genuinely knows about A.
    const sentLetter3 = sessions.messagePeerManager(mgrB, pA, "letter3 from B, now aware");
    const letter3Text = pty.q.get(mgrA).find((m) => m.text.includes("letter3 from B")).text;
    const letter3Stamps = stampFields(letter3Text);
    check("(1) CONTRAST: after letter1 actually drained, letter3's last-inbound-this-session is a REAL timestamp, not none",
      !!letter3Stamps && letter3Stamps.thisSession !== "none" && !Number.isNaN(Date.parse(letter3Stamps.thisSession)));
    check("(1) CONTRAST: letter3's last-inbound-project is ALSO a real timestamp",
      !!letter3Stamps && letter3Stamps.project !== "none" && !Number.isNaN(Date.parse(letter3Stamps.project)));
  }

  // ===================== (2) DoD-4: the recycle case — session none, project carries the receipt =====
  // Isolated projects/agents (pA2/pB2) — NOT (1)'s pA/pB, whose managers stay "live" in the DB forever
  // (this test never exits them), which would otherwise make `messagePeerManager`'s live-manager lookup
  // ambiguous between (1)'s still-live manager and this block's own.
  {
    const pA2 = `pA2-${sfx}`, pB2 = `pB2-${sfx}`;
    mkProject(pA2, "Project A2"); mkProject(pB2, "Project B2");
    db.createProjectLink(pA2, pB2);
    const agA2 = `agA2-${sfx}`, agB2 = `agB2-${sfx}`;
    mkAgent(agA2, pA2); mkAgent(agB2, pB2);

    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgrA2 = `mgrA2-${sfx}`, mgrBOld = `mgrB2old-${sfx}`;
    mkSession({ id: mgrA2, projectId: pA2, agentId: agA2 });
    mkSession({ id: mgrBOld, projectId: pB2, agentId: agB2 });
    pty.setLive(mgrA2); pty.setLive(mgrBOld); // both idle → immediate delivery

    const sent = sessions.messagePeerManager(mgrA2, pB2, "letter to the predecessor");
    check("(2) setup: the predecessor (mgrBOld) received the letter live", sent.deliveryStatus === "delivered-live");
    const receiptEvent = db.listEventsForWorker(mgrBOld).find((e) => e.kind === "cross_project_message" && e.detail?.originProjectId === pA2);
    check("(2) setup: the predecessor's own receipt event is on record", !!receiptEvent);

    const fresh = await sessions.recycleManager(mgrBOld, "successor: no context on the prior exchange");
    pty.setLive(fresh.id); // the successor needs to be live to send its own letter

    const successorSend = sessions.messagePeerManager(fresh.id, pA2, "hello from the successor, no memory of the prior letter");
    const successorText = pty.q.get(mgrA2).find((m) => m.text.includes("hello from the successor")).text;
    const successorStamps = stampFields(successorText);
    check("(2) setup: the successor's own letter carries both stamp fields", !!successorStamps);
    check("(2) RECYCLE PROVEN: last-inbound-this-session:none — the SUCCESSOR itself never received anything",
      successorStamps?.thisSession === "none");
    check("(2) RECYCLE PROVEN: last-inbound-project carries the PREDECESSOR's real receipt timestamp, NOT none",
      successorStamps?.project === receiptEvent.ts && successorStamps.project !== "none");
    check("(2) DoD-4: the two fields are NOT redundant — they disagree here by construction",
      successorStamps?.thisSession !== successorStamps?.project);
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — peer_message frames stamp last-inbound-this-session + last-inbound-project so a genuine crossing reads none/none (never a false reply-inference), a real drain flips both to real timestamps, and a recipient recycle leaves the session stamp at none while the project stamp still carries the predecessor's receipt."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
