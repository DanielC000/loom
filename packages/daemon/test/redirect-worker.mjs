import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Service-level guard for SessionService.redirectWorker (worker_redirect, Part 3). NO claude, NO live
// daemon, NO process.exit-on-prod. In-process Db + SessionService + a contract-faithful PtyStub.
//
// PROVES the orchestration wiring of the "land it NOW" steer:
//   (1) PARENT-SCOPE GATE — redirecting a session that isn't your child throws "not your worker"
//       (mirrors messageWorker/stopWorker).
//   (2) FLUSH + SUPERSEDE — a busy worker's queued direction is flushed and each durable record is
//       resolved as session_message_delivered with reason "superseded" (so the worker_report done-guard
//       + the boot-recovery scan never re-drive it), and it does NOT also drain as a turn.
//   (3) EVENT — a `redirect_worker` orchestration event is appended under the manager.
//   (4) LANDS — the authoritative `[loom:from-manager:redirect]` instruction is enqueued and is the next
//       thing the worker receives; the interrupt is triggered for a busy worker (held), skipped when idle.
//
// Run: 1) build daemon, 2) node test/redirect-worker.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Capture [orchestration] log lines emitted by deliverRedirect (card 7acee6d4 tertiary: before this,
// confirming a redirect had actually happened required a direct read-only query against
// orchestration_events; now it must also be answerable from the daemon's own console log).
const orchLogs = [];
const realConsoleLog = console.log;
console.log = (...args) => {
  const s = args.map(String).join(" ");
  if (s.startsWith("[orchestration]")) orchLogs.push(s);
  realConsoleLog(...args);
};

// Hermetic LOOM_HOME BEFORE importing db.js (paths.ts reads it at import time).
const tmpHome = path.join(os.tmpdir(), `loom-redirw-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// A contract-faithful PtyStub: mirrors the host's enqueueStdin/flushPending/interruptForRedirect semantics
// WITHOUT claude. A session must be `live` to receive; a `busy` recipient QUEUES + stores onDeliver; an idle
// one delivers immediately (and, like the host, does NOT fire onDeliver). flushPending splices+returns the
// held entries (with onDeliver, NOT firing it — the caller decides their fate). interruptForRedirect records
// the call (the real Esc/settle timing is covered by pty-interrupt-redirect.mjs) and, to model the host's
// settle-drain, hands the freshly-enqueued redirect to the recipient + fires its onDeliver.
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.interrupts = []; this.delivered = []; }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  enqueueStdin(id, text, _source = "system", onDeliver) {
    if (!this.live.has(id)) return { delivered: false };          // not alive → dropped (no position)
    if (!this.busy.has(id)) { this.delivered.push({ id, text }); return { delivered: true }; } // idle → immediate
    const a = this.q.get(id) ?? []; a.push({ id: `qm-${a.length}`, text, source: _source, onDeliver }); this.q.set(id, a);
    return { delivered: false, position: a.length };
  }
  flushPending(id) { const a = this.q.get(id) ?? []; this.q.set(id, []); return a; } // splice+return (onDeliver NOT fired)
  interruptForRedirect(id) {
    this.interrupts.push(id);
    // Model the host's settle→drain: the just-enqueued redirect is handed over as the next turn.
    const a = this.q.get(id) ?? [];
    for (const m of a) { this.delivered.push({ id, text: m.text }); if (m.onDeliver) m.onDeliver(); }
    this.q.set(id, []);
  }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
}

const db = new Db();
const proj = `redirw-proj-${sfx}`, agent = `redirw-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null, recycledFrom: o.recycledFrom ?? null,
});

try {
  // ===================== (1) PARENT-SCOPE GATE =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rw-1-mgr-${sfx}`, other = `rw-1-other-${sfx}`, notMine = `rw-1-nm-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: other, role: "manager" });
    mkSession({ id: notMine, role: "worker", parentSessionId: other }); // child of a DIFFERENT manager
    pty.setLive(mgr); pty.setLive(notMine); pty.setBusy(notMine);

    let threw = null;
    try { sessions.redirectWorker(mgr, notMine, "do the other thing"); } catch (e) { threw = e.message; }
    check("(1) redirecting a non-child throws 'not your worker'", threw === "not your worker");
    check("(1) gate: no redirect_worker event recorded for the refused call", db.listEventsForWorker(notMine).filter((e) => e.kind === "redirect_worker").length === 0);
    check("(1) gate: the foreign worker was NOT interrupted", pty.interrupts.length === 0);

    let threwUnknown = null;
    try { sessions.redirectWorker(mgr, "no-such-worker", "hi"); } catch (e) { threwUnknown = e.message; }
    check("(1) redirecting an unknown session throws 'not your worker'", threwUnknown === "not your worker");
  }

  // ===================== (2)(3)(4) BUSY worker: flush+supersede, event, redirect lands =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rw-2-mgr-${sfx}`, wkr = `rw-2-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: null });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr); // worker is mid-turn

    // Pre-load a queued (durable) manager direction that the redirect will SUPERSEDE.
    const pre = sessions.messageWorker(mgr, wkr, "OLD DIRECTION — build feature X");
    check("(2) setup: the old direction is HELD (busy worker) + persisted", pre.delivered === false);
    check("(2) setup: 1 undelivered durable message before the redirect", db.listUndeliveredQueuedMessages().some((e) => e.detail.text.includes("OLD DIRECTION")));

    orchLogs.length = 0;
    const r = sessions.redirectWorker(mgr, wkr, "STOP — reconcile your tree, then build feature Y instead");
    check("(3) LOGGED: the redirect is visible from the console log alone (delivered + superseded count), no DB query needed", orchLogs.some((l) => l.includes(wkr) && l.includes("delivered=false") && l.includes("superseded=1")));
    check("(2) FLUSH: the superseded OLD direction is no longer in the worker's live queue", !pty.getPending(wkr).some((t) => t.includes("OLD DIRECTION")));
    check("(2) SUPERSEDE: the old durable record is RESOLVED (no longer undelivered)", !db.listUndeliveredQueuedMessages().some((e) => e.detail.text.includes("OLD DIRECTION")));
    const resolved = db.listEventsForWorker(wkr).filter((e) => e.kind === "session_message_delivered" && e.detail?.reason === "superseded");
    check("(2) SUPERSEDE: a session_message_delivered marker recorded with reason 'superseded'", resolved.length === 1);

    const evt = db.listEventsForWorker(wkr).filter((e) => e.kind === "redirect_worker");
    check("(3) EVENT: a redirect_worker event recorded under the manager", evt.length === 1 && evt[0].managerSessionId === mgr);

    check("(4) LANDS: the busy worker was interrupted (held redirect ⇒ interrupt fires)", pty.interrupts.includes(wkr));
    check("(4) LANDS: the authoritative redirect reached the worker, distinctly framed", pty.delivered.some((d) => d.id === wkr && d.text.startsWith("[loom:from-manager:redirect]") && d.text.includes("feature Y")));
    check("(4) LANDS: redirectWorker returned the enqueue status (was held ⇒ delivered:false)", r.delivered === false);
  }

  // ===================== (4b) IDLE worker: redirect submitted immediately, NO interrupt =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rw-3-mgr-${sfx}`, wkr = `rw-3-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); // worker IDLE (not busy)

    const r = sessions.redirectWorker(mgr, wkr, "change course now");
    check("(4b) idle worker: redirect submitted immediately as a turn (delivered:true)", r.delivered === true);
    check("(4b) idle worker: NOT interrupted (no in-flight turn to cancel)", !pty.interrupts.includes(wkr));
    check("(4b) idle worker: the redirect still reached it, framed", pty.delivered.some((d) => d.id === wkr && d.text.startsWith("[loom:from-manager:redirect]")));
    check("(4b) idle worker: a redirect_worker event was still recorded", db.listEventsForWorker(wkr).some((e) => e.kind === "redirect_worker"));
  }

  db.close();
} finally {
  console.log = realConsoleLog;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — redirectWorker is parent-gated, flushes + supersedes queued direction (reason 'superseded'), records a redirect_worker event, and lands the authoritative redirect (interrupting a busy worker, immediate for an idle one)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
