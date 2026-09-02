import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card 9f279c7b DoD-4: recycleManager purges STALE recycle/emergency context nudges NARROWLY (by exact
// text tag) before carrying the predecessor's queue onto its successor — a "you're near your context
// limit" nudge addressed to the PREDECESSOR is actively misleading on a fresh successor whose own
// occupancy starts near zero. NO claude, NO live daemon — an in-process Db + SessionService + the SAME
// contract-faithful PtyStub `recycle-pending-carry.mjs` already validates the generic carry against.
//
// PROVES:
//   (a) POSITIVE — a queued ordinary `[loom:context] ...` nudge (non-durable) is DROPPED, not carried.
//   (b) POSITIVE — a queued emergency-redirect durable record (produced by the REAL
//       `redirectManagerForEmergencyRecycle`, not a hand-typed stand-in) is SUPERSEDED and NOT re-minted
//       onto the successor.
//   (c) NEGATIVE PROOF (the sharp edge DoD-4 calls out): a queued worker-report-shaped nudge and a queued
//       durable cross-tree message (the SAME mechanism a peer_message/session_message carry uses) BOTH
//       still reach the successor untouched — the purge must never become a wholesale queue wipe.
//
// Run: 1) build daemon, 2) node test/recycle-purges-stale-context-nudge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rpurge-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Byte-identical PtyStub to recycle-pending-carry.mjs's own (see that file's doc for the contract).
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.spawned = []; this.stopped = []; }
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
  interruptForRedirect() { /* no-op — this test only needs the enqueue side of deliverRedirect */ }
  spawn(opts) { this.spawned.push(opts); this.setLive(opts.sessionId); this.setBusy(opts.sessionId); }
  stop(id) { this.stopped.push(id); this.setLive(id, false); }
  isAlive(id) { return this.live.has(id); }
}

const db = new Db();
const proj = `rp-proj-${sfx}`, agent = `rp-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "BRIEF", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: o.worktreePath ?? null, branch: o.branch ?? null, recycledFrom: o.recycledFrom ?? null, gen: o.gen ?? 0,
});

try {
  const pty = new PtyStub();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const lead = `lead-${sfx}`, oldMgr = `mgr-${sfx}`, wkr = `wkr-${sfx}`;
  mkSession({ id: lead, role: "platform" });
  mkSession({ id: oldMgr, role: "manager" });
  mkSession({ id: wkr, role: "worker", parentSessionId: oldMgr, worktreePath: os.tmpdir(), branch: "loom/x" });
  pty.setLive(oldMgr); pty.setBusy(oldMgr); pty.setLive(lead);

  // (a) an ordinary context-recycle nudge, exactly the text shape ContextWatcher enqueues (non-durable).
  pty.enqueueStdin(oldMgr, "[loom:context] Your context is ~85% of your 1000k window — hand off before it fills. Wind down NOW...", "system", undefined, "warning");

  // (b) the REAL emergency-redirect path — not a hand-typed stand-in. Held (busy target) ⇒ durable.
  const emergency = sessions.redirectManagerForEmergencyRecycle(oldMgr, "Your context is ~92% of your window — the EMERGENCY floor...");
  check("(b) setup: the emergency redirect actually fired and was HELD (busy target)", emergency.fired === true && emergency.result.delivered === false);
  check("(b) setup: the emergency redirect persisted a durable record", db.listUnresolvedQueuedMessagesForWorker(oldMgr).some((r) => typeof r.detail?.text === "string" && r.detail.text.includes("EMERGENCY floor")));

  // (c) NEGATIVE PROOF #1 — a worker-report-shaped nudge (the exact text workerReport() itself enqueues;
  // hand-composed here to isolate the PURGE'S text-matching from workerReport()'s own task/board machinery,
  // which recycle-pending-carry.mjs and the worker_report test suite already cover independently).
  pty.enqueueStdin(oldMgr, `[loom:worker-report] worker ${wkr} (task none) — done: shipped the thing`, "system", undefined, "agent");

  // (c) NEGATIVE PROOF #2 — a genuine durable cross-tree message via the REAL messageSessionAsPlatform
  // path (the SAME enqueueDurableMessage/carry mechanism a peer_message uses — see carryPendingToSuccessor's
  // own doc: it re-mints ANY unresolved durable record, peer_message included, with no special-casing).
  const platformMsg = sessions.messageSessionAsPlatform(oldMgr, "PLATFORM DIRECTIVE — pause merges", lead);
  check("(c) setup: the platform (peer-shaped) directive was held + persisted with the lead as sender", platformMsg.deliveryStatus === "queued" && db.listUnresolvedQueuedMessagesForWorker(oldMgr).some((r) => r.detail?.sender === lead));

  const preFlush = pty.pendingEntries(oldMgr);
  check("setup: all four queued entries are present on the predecessor before recycle", preFlush.length === 4);
  check("setup: the emergency redirect (supersedeQueue:false) did NOT discard the ordinary nudge queued before it",
    preFlush.some((m) => m.text.startsWith("[loom:context]")));

  const fresh = await sessions.recycleManager(oldMgr, "successor: drain the queue, 1 worker in flight");

  // ---------------------------- POSITIVE: the two context-tagged entries are gone ----------------------------
  const succQ = pty.pendingEntries(fresh.id);
  check("(a) the ordinary context nudge is NOT carried to the successor", !succQ.some((m) => m.text.startsWith("[loom:context]")));
  check("(b) the emergency-redirect durable record is NOT re-minted onto the successor", !db.listUnresolvedQueuedMessagesForWorker(fresh.id).some((r) => typeof r.detail?.text === "string" && r.detail.text.includes("EMERGENCY floor")));
  check("(b) the emergency-redirect's OLD durable record is resolved (no longer unresolved for the predecessor)", !db.listUnresolvedQueuedMessagesForWorker(oldMgr).some((r) => typeof r.detail?.text === "string" && r.detail.text.includes("EMERGENCY floor")));

  // ---------------------------- NEGATIVE PROOF: everything else survives ----------------------------
  check("(c) the worker-report-shaped nudge STILL reaches the successor untouched", succQ.some((m) => m.text.includes("[loom:worker-report]") && m.text.includes("shipped the thing")));
  const reminted = db.listUnresolvedQueuedMessagesForWorker(fresh.id);
  check("(c) the platform (peer-shaped) directive is RE-MINTED onto the successor, original sender kept", reminted.some((r) => r.detail?.sender === lead && typeof r.detail?.text === "string" && r.detail.text.includes("PLATFORM DIRECTIVE")));

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recycleManager's DoD-4 purge drops a queued ordinary context nudge and supersedes a queued emergency-redirect durable record (narrowly, by exact text tag) WITHOUT touching a queued worker-report-shaped nudge or a queued durable cross-tree (peer-shaped) message, both of which still reach the successor exactly as the generic carry mechanism already guarantees."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
