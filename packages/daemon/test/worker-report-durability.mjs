import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 829f4f8f: worker_report's manager-bound push (sessions/service.ts workerReport) used to fire a BARE,
// non-durable pty.enqueueStdin — the SEVENTH site of ccb407eb's "convert to the durable queued-message path"
// class, missed because that card's original enumeration stopped at the six sites someone had already
// thought of. A report held behind a busy/wedged manager lived ONLY in the in-memory FIFO: a daemon restart
// before the manager's next turn boundary silently dropped it, with no durable session_message_queued
// record for the boot scan to redrive — exactly the live incident (2026-07-29/30, two dropped worker
// reports) that promoted this card to p1.
//
// PROVES:
//  (1) a worker_report to a BUSY manager persists a durable session_message_queued record (not just the
//      in-memory FIFO) — the write-side half of the fix. THIS is the check that fails red against the
//      pre-fix bare `pty.enqueueStdin` call (it never touches the durable table at all).
//  (2) the durable record carries kind:"agent" (drains alone, never coalesced with an unrelated warning)
//      and sender:<the reporting worker> (not a bare "system" sentinel), so a still-stuck report can be
//      surfaced back to the WORKER if the manager never returns.
//  (3) that record survives a simulated daemon restart (new PtyStub + SessionService, SAME db) and redrives
//      via recoverUndeliveredMessagesOnBoot — the read-side half — WITHOUT losing its kind, and resolves
//      once delivered.
//
// Run: 1) build daemon, 2) node test/worker-report-durability.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Contract-faithful PtyStub mirroring the REAL enqueueStdin's positional shape (kind is the 6th positional
// arg) — same shape as queued-message-durability.mjs's own stub, which this test's structure mirrors.
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.sent = []; }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  enqueueStdin(id, text, _source = "system", onDeliver, _route, kind = "warning") {
    this.sent.push({ id, text, kind });
    if (!this.live.has(id)) return { delivered: false };                    // not alive → dropped (no position)
    if (!this.busy.has(id)) return { delivered: true };                     // idle → immediate (onDeliver NOT fired)
    const a = this.q.get(id) ?? []; a.push({ text, onDeliver, kind }); this.q.set(id, a);
    return { delivered: false, position: a.length };
  }
  drainOne(id) { const a = this.q.get(id) ?? []; const m = a.shift(); if (m?.onDeliver) m.onDeliver(); return m; }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
}

function makeDb() {
  const dbFile = path.join(os.tmpdir(), `loom-wrd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const proj = `wrd-proj-${sfx}`, agent = `wrd-ag-${sfx}`;
  const now = NOW.toISOString();
  db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
  return { dbFile, db, proj, agent, now };
}
function mkSession(env, o) {
  env.db.insertSession({
    id: o.id, projectId: env.proj, agentId: env.agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
    processState: o.processState ?? "live", resumability: "resumable", busy: false, createdAt: env.now, lastActivity: env.now,
    lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
    worktreePath: o.worktreePath ?? null, branch: o.branch ?? null, recycledFrom: o.recycledFrom ?? null,
  });
}
function cleanup(env) {
  try { env.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(env.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

try {
  const env = makeDb();
  const mgr = `wrd-mgr-${sfx}`, wkr = `wrd-wkr-${sfx}`, tk = `wrd-tk-${sfx}`;
  mkSession(env, { id: mgr, role: "manager" });
  mkSession(env, { id: wkr, role: "worker", parentSessionId: mgr, taskId: tk });

  // ---- worker_report to a BUSY manager → HELD, not delivered now ----
  const ptyPre = new PtyStub();
  ptyPre.setLive(mgr); ptyPre.setBusy(mgr); // manager mid-turn → the report is HELD, not delivered now
  ptyPre.setLive(wkr);
  const sessionsPre = new SessionService(env.db, ptyPre, new OrchestrationControl());

  const res = await sessionsPre.workerReport(wkr, { status: "done", summary: "DID THE THING" });
  check("(1) busy manager → report HELD, not delivered now ('queued')", res.deliveryStatus === "queued");
  check("(1) the report reached the manager's in-memory FIFO", ptyPre.getPending(mgr).some((t) => t.includes("DID THE THING")));

  // THE FIX (write side): the held report must be PERSISTED as a durable session_message_queued record —
  // not just sitting in the (about-to-vanish-on-restart) in-memory FIFO. A bare pty.enqueueStdin never
  // wrote this record at all — this is the check that fails red against the pre-fix code.
  const undeliv = env.db.listUndeliveredQueuedMessages();
  const rec = undeliv.find((e) => e.workerSessionId === mgr && typeof e.detail?.text === "string" && e.detail.text.includes("DID THE THING"));
  check("(2) THE FIX (write side): the held report is a durable session_message_queued record — not just an in-memory FIFO entry", !!rec);
  check("(2b) the durable record carries kind:\"agent\" (drains alone, never coalesced)", rec?.detail?.kind === "agent");
  check("(2c) the durable record's sender is the REPORTING WORKER (not a bare \"system\" sentinel)", rec?.detail?.sender === wkr);

  // ---- SIMULATED DAEMON RESTART: the in-memory FIFO is gone (a NEW pty + NEW SessionService), SAME db. ----
  // A bare enqueueStdin's held message would be UNRECOVERABLE here — that's the exact drop this card fixes.
  const ptyPost = new PtyStub();
  ptyPost.setLive(mgr); ptyPost.setBusy(mgr); // manager resumed but still mid-turn — keep it observable in the FIFO
  const sessionsPost = new SessionService(env.db, ptyPost, new OrchestrationControl());
  const scan = sessionsPost.recoverUndeliveredMessagesOnBoot();
  check("(3) THE FIX (read side): the boot scan re-enqueued the report onto the resumed manager", scan.reEnqueued === 1);
  const redriven = ptyPost.sent.find((s) => s.id === mgr && s.text.includes("DID THE THING"));
  check("(3b) the redriven report reached the manager", !!redriven);
  check("(3c) the redriven report keeps kind:\"agent\" (never silently reclassified to \"warning\" on redrive)", redriven?.kind === "agent");

  // Drain to the manager's next turn boundary — resolves the durable record.
  const drained = ptyPost.drainOne(mgr);
  check("(4) the redriven report delivers on the manager's next turn boundary", typeof drained?.text === "string" && drained.text.includes("DID THE THING"));
  check("(4b) delivery RESOLVED the durable record (zero undelivered for this report)", !env.db.listUndeliveredQueuedMessages().some((e) => e.detail?.text?.includes("DID THE THING")));

  cleanup(env);
} catch (e) {
  console.error(e);
  failures++;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_report's manager-bound push is durable: a report held behind a busy manager persists a session_message_queued record (kind:\"agent\", sender:the reporting worker), survives a simulated daemon restart, and redrives via the boot scan without losing its kind, resolving once delivered."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
