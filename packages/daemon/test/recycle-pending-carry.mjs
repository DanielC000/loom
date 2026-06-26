import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Service-level guard for recycle's PENDING CARRY + blank-handoff guard (card c4df52b1). NO claude, NO
// live daemon. In-process Db + SessionService + a contract-faithful PtyStub (the recycle.mjs integration
// test covers the real-claude end-to-end; here we prove the DURABLE-SURVIVAL + source-preservation +
// fail-safe semantics deterministically at the seam).
//
// PROVES:
//   (2) DURABLE-SURVIVAL CARRY — recycleWorker/recycleManager carry the predecessor's HELD inbound queue
//       to the successor via flushPending (not getPending), so:
//         - a held durable session_message is SUPERSEDED on the predecessor AND RE-MINTED onto the
//           successor (a NEW unresolved record naming the SUCCESSOR as recipient, original sender kept) —
//           crash-survival follows the recycle chain instead of dead-ending (boot would retire the old
//           record as superseded). Without the fix the durable record stayed pointed at the retired
//           predecessor and was lost on the next restart.
//         - a held 'human' raw turn carries across with source='human' (was silently reclassified 'system').
//   (3) BLANK-HANDOFF FAIL-SAFE — a blank/whitespace handoff/continuation is REFUSED before any teardown,
//       so the predecessor is never destroyed on an empty handoff (no successor, no recycle_begin event).
//
// Run: 1) build daemon, 2) node test/recycle-pending-carry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME BEFORE importing db.js (paths.ts reads it at import time).
const tmpHome = path.join(os.tmpdir(), `loom-rcarry-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// A contract-faithful PtyStub: a LIVE + BUSY recipient HOLDS an enqueue (storing onDeliver + source) and
// returns delivered:false (so SessionService persists the durable session_message_queued record); flushPending
// splices+returns the held entries WITH onDeliver (NOT firing it); stop drops the session (isAlive→false);
// spawn registers the fresh session live+busy so re-mints/carries HOLD there too. Mirrors host.ts semantics
// for the recycle path WITHOUT a real claude (the M1/M2 idle-submit window is irrelevant here — everything holds).
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.spawned = []; this.stopped = []; }
  setLive(id, on = true) { if (on) this.live.add(id); else { this.live.delete(id); this.busy.delete(id); } }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  enqueueStdin(id, text, source = "system", onDeliver) {
    if (!this.live.has(id)) return { delivered: false };
    if (!this.busy.has(id)) { /* idle → immediate delivery; onDeliver NOT fired (matches host.ts) */ const a = this.q.get(id) ?? []; a.push({ id: `d-${a.length}`, text, source, delivered: true }); this.q.set(id, a); return { delivered: true }; }
    const a = this.q.get(id) ?? []; a.push({ id: `qm-${a.length}`, text, source, onDeliver }); this.q.set(id, a);
    return { delivered: false, position: a.length };
  }
  flushPending(id) { const a = (this.q.get(id) ?? []).filter((m) => !m.delivered); this.q.set(id, []); return a; }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
  pendingEntries(id) { return this.q.get(id) ?? []; }
  spawn(opts) { this.spawned.push(opts); this.setLive(opts.sessionId); this.setBusy(opts.sessionId); }
  stop(id) { this.stopped.push(id); this.setLive(id, false); }
  isAlive(id) { return this.live.has(id); }
}

const db = new Db();
const proj = `rc-proj-${sfx}`, agent = `rc-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "BRIEF", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: o.worktreePath ?? null, branch: o.branch ?? null, recycledFrom: o.recycledFrom ?? null, gen: o.gen ?? 0,
});

try {
  // ===================== (2) recycleWorker: durable carry + source preservation =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rw-mgr-${sfx}`, wkr = `rw-wkr-${sfx}`, task = `rw-task-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: task, worktreePath: os.tmpdir(), branch: "loom/x" });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr); // worker is mid-turn (holds)

    // A durable manager direction (held) + a raw HUMAN turn (held) before the recycle.
    const pre = sessions.messageWorker(mgr, wkr, "DURABLE DIRECTION — build X");
    check("(2w) setup: durable direction HELD (busy worker) + persisted", pre.delivered === false && db.listUnresolvedQueuedMessagesForWorker(wkr).length === 1);
    pty.enqueueStdin(wkr, "HUMAN TYPED — please also check Y", "human"); // a raw human composer turn held while busy

    const fresh = await sessions.recycleWorker(mgr, wkr, "continue building X; decided A; next do B");

    check("(2w) the predecessor's old durable record is SUPERSEDED (no longer unresolved for it)", db.listUnresolvedQueuedMessagesForWorker(wkr).length === 0);
    const supMarker = db.listEventsForWorker(wkr).filter((e) => e.kind === "session_message_delivered" && e.detail?.reason === "superseded");
    check("(2w) a session_message_delivered marker recorded with reason 'superseded'", supMarker.length === 1);

    const reminted = db.listUnresolvedQueuedMessagesForWorker(fresh.id);
    check("(2w) RE-MINT: a NEW unresolved durable record names the SUCCESSOR as recipient", reminted.length === 1 && reminted[0].detail?.text?.includes("DURABLE DIRECTION"));
    check("(2w) RE-MINT: the original sender (the manager) is preserved on the re-minted record", reminted[0].detail?.sender === mgr);
    check("(2w) CRASH-SURVIVAL: the successor has NO successor of its own, so the boot scan would RE-DRIVE (not retire) the re-mint", db.hasSuccessor(fresh.id) === false);

    const freshQ = pty.pendingEntries(fresh.id);
    const human = freshQ.find((m) => m.text.includes("HUMAN TYPED"));
    check("(2w) SOURCE: the held human turn carried to the successor with source='human' (not reclassified 'system')", !!human && human.source === "human");
    check("(2w) the re-minted durable direction is also queued on the successor", freshQ.some((m) => m.text.includes("DURABLE DIRECTION")));
    check("(2w) the predecessor's queue was FLUSHED (empty)", pty.getPending(wkr).length === 0);
  }

  // ===================== (2) recycleManager: durable cross-tree carry keeps the ORIGINAL sender =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const oldMgr = `rm-mgr-${sfx}`, lead = `rm-lead-${sfx}`;
    mkSession({ id: oldMgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(oldMgr); pty.setBusy(oldMgr); pty.setLive(lead);

    // A durable cross-tree PLATFORM message held on the busy manager (sender = the lead session).
    const r = sessions.messageSessionAsPlatform(oldMgr, "PLATFORM DIRECTIVE — pause merges", lead);
    check("(2m) setup: platform message HELD (busy manager) + persisted with the lead as sender", r.deliveryStatus === "queued" && db.listUnresolvedQueuedMessagesForWorker(oldMgr)[0]?.detail?.sender === lead);
    pty.enqueueStdin(oldMgr, "HUMAN STEER — prioritize the hotfix", "human");

    const fresh = await sessions.recycleManager(oldMgr, "successor: 2 workers in review, drain the queue");

    check("(2m) the predecessor's platform record is SUPERSEDED", db.listUnresolvedQueuedMessagesForWorker(oldMgr).length === 0);
    const reminted = db.listUnresolvedQueuedMessagesForWorker(fresh.id);
    check("(2m) RE-MINT onto the successor manager preserves the ORIGINAL platform sender (not a sentinel)", reminted.length === 1 && reminted[0].detail?.sender === lead && reminted[0].detail?.text?.includes("PLATFORM DIRECTIVE"));
    const human = pty.pendingEntries(fresh.id).find((m) => m.text.includes("HUMAN STEER"));
    check("(2m) SOURCE: the held human turn carried to the successor manager with source='human'", !!human && human.source === "human");
  }

  // ===================== (3) BLANK handoff/continuation is refused BEFORE any teardown =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `bk-mgr-${sfx}`, wkr = `bk-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, worktreePath: os.tmpdir() });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);

    for (const blank of ["", "   ", "\n\t "]) {
      let threw = null;
      try { await sessions.recycleWorker(mgr, wkr, blank); } catch (e) { threw = e.message; }
      check(`(3w) recycleWorker refuses a blank handoff (${JSON.stringify(blank)})`, threw === "handoffSummary must not be blank");
    }
    check("(3w) FAIL-SAFE: the predecessor worker was NOT torn down (still alive, no successor)", pty.isAlive(wkr) && db.hasSuccessor(wkr) === false && pty.stopped.length === 0);
    check("(3w) FAIL-SAFE: no recycle_begin event was recorded for the refused calls", db.listEventsForWorker(wkr).filter((e) => e.kind === "recycle_begin").length === 0);

    const oldMgr = `bk-omgr-${sfx}`;
    mkSession({ id: oldMgr, role: "manager" });
    pty.setLive(oldMgr); pty.setBusy(oldMgr);
    for (const blank of ["", "   "]) {
      let threw = null;
      try { await sessions.recycleManager(oldMgr, blank); } catch (e) { threw = e.message; }
      check(`(3m) recycleManager refuses a blank continuation (${JSON.stringify(blank)})`, threw === "continuationPrompt must not be blank");
    }
    check("(3m) FAIL-SAFE: the predecessor manager was NOT torn down (no successor)", pty.isAlive(oldMgr) && db.hasSuccessor(oldMgr) === false);
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recycle carries the held queue via flushPending: durable messages SUPERSEDE-then-RE-MINT onto the successor (crash-survival follows the chain, original sender kept), human turns keep source='human', and a blank handoff/continuation is refused before any teardown."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
