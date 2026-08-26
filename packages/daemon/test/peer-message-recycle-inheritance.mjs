import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card f907c8c4 DoD-1 + DoD-3: a peer_message queued (busy target) for a manager session that then
// RECYCLES before draining used to carry onto its successor as a BARE message — the successor has no
// context on the thread (measured incident: a farewell delivered to the wrong manager). DETERMINISTIC +
// CLAUDE-FREE: an in-process Db + SessionService driven against a contract-faithful PtyStub (mirrors
// test/recycle-pending-carry.mjs's own stub), so the recycle's carry-forward runs for REAL — no mocking
// of `carryPendingToSuccessor` itself.
//
// PROVES:
//   (1) POSITIVE CONTROL (the card's own DoD-3): recycle a manager with a peer_message in flight —
//       the successor's re-minted durable record carries the `[loom:inherited-by-recycle · …]` label
//       ahead of the ORIGINAL, byte-identical `[loom:from-manager · … · projectId:… · sessionId:…]`
//       peer frame — never a bare message.
//   (2) NEGATIVE CONTROL, same mechanism: a live manager with NO message in flight recycles cleanly —
//       nothing to carry, no label fabricated out of nothing.
//   (3) NEGATIVE CONTROL, discriminating: a WORKER recycle carrying an ordinary `[loom:from-manager]`
//       (plain, no ` · ` fields) direction — via the SAME `carryPendingToSuccessor` code path — is
//       carried UNLABELED. Proves the peer-frame detector is scoped to the richer cross-project frame
//       and doesn't blanket-label every carried message.
//
// Run: 1) build (turbo builds shared first), 2) node test/peer-message-recycle-inheritance.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-peer-inherit-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// Same contract-faithful PtyStub as recycle-pending-carry.mjs: a LIVE+BUSY recipient HOLDS an enqueue
// (delivered:false), flushPending splices+returns held entries WITH onDeliver (not firing it).
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); }
  setLive(id, on = true) { if (on) this.live.add(id); else { this.live.delete(id); this.busy.delete(id); } }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  enqueueStdin(id, text, source = "system", onDeliver) {
    if (!this.live.has(id)) return { delivered: false };
    if (!this.busy.has(id)) { const a = this.q.get(id) ?? []; a.push({ id: `d-${a.length}`, text, source, delivered: true }); this.q.set(id, a); return { delivered: true }; }
    const a = this.q.get(id) ?? []; a.push({ id: `qm-${a.length}`, text, source, onDeliver }); this.q.set(id, a);
    return { delivered: false, position: a.length };
  }
  flushPending(id) { const a = (this.q.get(id) ?? []).filter((m) => !m.delivered); this.q.set(id, []); return a; }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
  pendingEntries(id) { return this.q.get(id) ?? []; }
  spawn(opts) { this.setLive(opts.sessionId); this.setBusy(opts.sessionId); }
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
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: o.worktreePath ?? null, branch: o.branch ?? null,
});

try {
  const pA = `pA-${sfx}`, pB = `pB-${sfx}`;
  mkProject(pA, "Project A"); mkProject(pB, "Project B");
  db.createProjectLink(pA, pB);
  const agA = `agA-${sfx}`, agB = `agB-${sfx}`;
  mkAgent(agA, pA); mkAgent(agB, pB);

  // ===================== (1) POSITIVE CONTROL — peer_message in flight, then recycle =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgrA = `mgrA-${sfx}`, mgrBOld = `mgrBold-${sfx}`;
    mkSession({ id: mgrA, projectId: pA, agentId: agA, role: "manager" });
    mkSession({ id: mgrBOld, projectId: pB, agentId: agB, role: "manager" });
    pty.setLive(mgrA); pty.setLive(mgrBOld); pty.setBusy(mgrBOld); // pB's manager is busy → the send holds

    const sent = sessions.messagePeerManager(mgrA, pB, "farewell — closing out this thread, thanks for the help");
    check("(1) setup: the peer_message HELD (busy target) and was persisted durably", sent.deliveryStatus === "queued" && db.listUnresolvedQueuedMessagesForWorker(mgrBOld).length === 1);
    const preRecord = db.listUnresolvedQueuedMessagesForWorker(mgrBOld)[0];
    check("(1) setup: the pre-recycle record carries the ORIGINAL, unlabeled peer frame",
      preRecord.detail?.text?.startsWith(`[loom:from-manager · Project A · projectId:${pA} · sessionId:${mgrA}]\n`) &&
      !preRecord.detail?.text?.includes("loom:inherited-by-recycle"));

    const fresh = await sessions.recycleManager(mgrBOld, "successor: nothing else in flight, drain the queue");

    check("(1) the predecessor's held record is SUPERSEDED", db.listUnresolvedQueuedMessagesForWorker(mgrBOld).length === 0);
    const reminted = db.listUnresolvedQueuedMessagesForWorker(fresh.id);
    check("(1) exactly ONE record re-minted onto the successor", reminted.length === 1);
    const text = reminted[0]?.detail?.text ?? "";

    check("(1) DoD-1: the successor's copy is labeled INHERITED, naming the predecessor session",
      text.startsWith(`[loom:inherited-by-recycle · predecessor:${mgrBOld.slice(0, 8)}]\n`));
    check("(1) DoD-3: the ORIGINAL peer frame survives byte-identical, ahead of the labeled body",
      text.includes(`[loom:from-manager · Project A · projectId:${pA} · sessionId:${mgrA}]\nfarewell — closing out this thread, thanks for the help`));
    check("(1) the re-minted record still preserves the ORIGINAL sender (mgrA), not a sentinel",
      reminted[0]?.detail?.sender === mgrA);
    check("(1) NEGATIVE CONTROL (polarity): the successor sees the label, never a BARE message — the exact defect the card measured",
      !(text.startsWith(`[loom:from-manager · `) && !text.includes("loom:inherited-by-recycle")));
  }

  // ===================== (2) NEGATIVE CONTROL — clean recycle, nothing in flight =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgrB2 = `mgrB2-${sfx}`;
    mkSession({ id: mgrB2, projectId: pB, agentId: agB, role: "manager" });
    pty.setLive(mgrB2); // idle — nothing held

    const fresh = await sessions.recycleManager(mgrB2, "successor: clean handoff, nothing pending");
    check("(2) a clean recycle (nothing queued) carries forward NO records at all — no label fabricated from nothing",
      db.listUnresolvedQueuedMessagesForWorker(fresh.id).length === 0);
  }

  // ============ (3) NEGATIVE CONTROL — discriminating: a WORKER recycle's plain manager-direction ========
  // ============ frame, via the SAME carryPendingToSuccessor path, must NOT be labeled ====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mgr3-${sfx}`, wkr = `wkr3-${sfx}`, task = `task3-${sfx}`;
    mkSession({ id: mgr, projectId: pA, agentId: agA, role: "manager" });
    mkSession({ id: wkr, projectId: pA, agentId: agA, role: "worker", parentSessionId: mgr, taskId: task, worktreePath: os.tmpdir(), branch: "loom/x" });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);

    sessions.messageWorker(mgr, wkr, "build X please");
    const fresh = await sessions.recycleWorker(mgr, wkr, "continue building X");
    const reminted = db.listUnresolvedQueuedMessagesForWorker(fresh.id);
    check("(3) setup: the ordinary manager-direction record re-minted onto the worker's successor", reminted.length === 1);
    const text = reminted[0]?.detail?.text ?? "";
    check("(3) DISCRIMINATING CONTROL: a plain [loom:from-manager] worker direction is carried UNLABELED (proves the detector is scoped to peer frames, not every carried message)",
      text.startsWith("[loom:from-manager]\nbuild X please") && !text.includes("loom:inherited-by-recycle"));
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a peer_message queued for a manager that recycles before draining carries onto its successor LABELED as inherited (never bare), a clean recycle fabricates no label, and an ordinary worker-direction carry through the same code path stays unlabeled."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
