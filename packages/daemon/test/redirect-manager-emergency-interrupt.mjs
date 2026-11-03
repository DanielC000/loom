import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Service-level guard for SessionService.redirectManagerForEmergencyRecycle (card 3dee1d51, fixing
// 9f279c7b's own regression). NO claude, NO live daemon. In-process Db + SessionService + a
// contract-faithful PtyStub — BYTE-IDENTICAL to redirect-worker-context-interrupt.mjs's own (senderId-
// aware, headInsert-aware, single-sender-run `drainNext` mirroring the REAL `drainPending` contract) —
// never the dumb FIFO stub recycle-purges-stale-context-nudge.mjs / context-watcher-sampler-cascade.mjs
// use, which has no senderId/headInsert handling at all and so cannot prove ordering.
//
// PROVES:
//   (A) ORDER — two worker reports from two DIFFERENT workers, queued while the manager is busy, now
//       drain AFTER the emergency text once it fires, never before (the bug this card fixes: without
//       headInsert:true the emergency text enqueued at the FIFO tail). Asserts the FULL post-drain
//       delivery sequence, not just the first slot.
//   (B) SAME-SENDER RUN — a worker report from the SAME worker queued TWICE (adjacent) still coalesces
//       into ONE turn once it's its turn to drain, exactly as it would have without this fix — the
//       emergency text moving to the front never disturbs how the reports behind it coalesce among
//       themselves.
//   (C) NOTHING LOST — a pre-existing head-inserted entry from a DIFFERENT mechanism is not dropped or
//       reordered relative to what's queued behind it; the emergency text only ever changes who's first.
//   (D) ISOLATION PROBE — the emergency text's own drains-ALONE property holds because its sender is
//       null (enqueueSender:"system"), not because of its queue position; see MUTANT 2 below.
//
// MUTANT PROOFS (run by hand against this file, documented again at the bottom, never left wired into
// the hermetic run): (1) temporarily drop `headInsert: true` from redirectManagerForEmergencyRecycle's
// deliverRedirect call → scenario (A)'s ORDER checks go RED (the emergency text reverts to the tail).
// (2) temporarily change that call's `enqueueSender` from the literal "system" (which null-maps via
// coalesceSenderIdentity) to `sessionId` (the manager's own id) → scenario (D)'s "drains alone" checks
// go RED (the emergency text wrongly coalesces into the probe entry, which deliberately shares that id).
//
// Run: 1) build daemon, 2) node test/redirect-manager-emergency-interrupt.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Hermetic LOOM_HOME BEFORE importing db.js (paths.ts reads it at import time).
const tmpHome = path.join(os.tmpdir(), `loom-rmei-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Byte-identical to redirect-worker-context-interrupt.mjs's own PtyStub — see that file's header for why
// it must track senderId/headInsert and drain only ONE sender-run per settle to be faithful.
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.interrupts = []; this.delivered = []; }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  enqueueStdin(id, text, _source = "system", onDeliver, _route, _kind, _questionId, _ownerText, _proactive, senderId, tail) {
    if (!this.live.has(id)) return { delivered: false };
    if (!this.busy.has(id)) { this.delivered.push({ id, text }); return { delivered: true }; }
    const a = this.q.get(id) ?? [];
    const entry = { id: `qm-${a.length}`, text, source: _source, senderId: senderId ?? null, onDeliver };
    if (tail && tail.headInsert === true) a.unshift(entry); else a.push(entry);
    this.q.set(id, a);
    return { delivered: false, position: a.length };
  }
  flushPending(id) { const a = this.q.get(id) ?? []; this.q.set(id, []); return a; }
  interruptForRedirect(id) {
    this.interrupts.push(id);
    this.drainNext(id);
  }
  // Delivers exactly the LEADING same-sender run (one turn's worth), mirroring drainPending — never the
  // whole queue. Call again to model the next Stop-triggered drain for whatever's left behind it.
  drainNext(id) {
    const a = this.q.get(id) ?? [];
    if (a.length === 0) return;
    const key = a[0].senderId;
    let n = 0;
    while (n < a.length && a[n].senderId === key) n++;
    const run = a.splice(0, n);
    this.q.set(id, a);
    for (const m of run) { this.delivered.push({ id, text: m.text }); if (m.onDeliver) m.onDeliver(); }
  }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
}

const db = new Db();
const proj = `rmei-proj-${sfx}`, agent = `rmei-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null, recycledFrom: o.recycledFrom ?? null,
});

const tagOf = (t) => t.startsWith("[loom:context-emergency:redirect]") ? "EMERGENCY" : t.startsWith("[loom:other-head-insert]") ? "OTHER" : t;

try {
  // ===================== (A) ORDER — two different workers' reports drain AFTER the emergency text =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rmei-a-mgr-${sfx}`, wkrA = `rmei-a-wkrA-${sfx}`, wkrB = `rmei-a-wkrB-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkrA, role: "worker", parentSessionId: mgr });
    mkSession({ id: wkrB, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setBusy(mgr); // manager is mid-turn

    // Worker-report-shaped entries — the exact enqueue shape workerReport() itself produces (kind:"agent",
    // sender = the reporting worker's own session id); hand-composed to isolate THIS test from
    // workerReport()'s own task/board machinery, same precedent as recycle-purges-stale-context-nudge.mjs's
    // own "worker-report-shaped nudge".
    pty.enqueueStdin(mgr, `[loom:worker-report] worker ${wkrA} — done: shipped A`, "system", undefined, undefined, "agent", undefined, undefined, undefined, wkrA);
    pty.enqueueStdin(mgr, `[loom:worker-report] worker ${wkrB} — done: shipped B`, "system", undefined, undefined, "agent", undefined, undefined, undefined, wkrB);
    check("(A) setup: both worker reports are queued, A before B", pty.getPending(mgr).length === 2 && pty.getPending(mgr)[0].includes("shipped A") && pty.getPending(mgr)[1].includes("shipped B"));

    const r = sessions.redirectManagerForEmergencyRecycle(mgr, "Your context is ~92% of your window — the EMERGENCY floor...");
    check("(A) the emergency redirect fires (held, busy manager)", r.fired === true && r.result.interrupting === true);

    // NOTE: by the time this call returns, the stub's interruptForRedirect has already synchronously
    // drained the emergency text as its own turn (mirroring the real Esc→settle→drain) — so it is no
    // longer sitting in `pending` to inspect positionally; `delivered` is the correct place to look.
    check("(A) ORDER: the interrupt's own Esc→settle→drain delivered ONLY the emergency text so far",
      pty.delivered.length === 1 && pty.delivered[0].text.startsWith("[loom:context-emergency:redirect]"));
    check("(A) ORDER: neither worker report has delivered yet — they're different sender-runs",
      !pty.delivered.some((d) => d.text.includes("shipped A") || d.text.includes("shipped B")));

    pty.drainNext(mgr);
    check("(A) ORDER: report A drains SECOND, as its own turn", pty.delivered.length === 2 && pty.delivered[1].text.includes("shipped A"));
    pty.drainNext(mgr);
    check("(A) ORDER: report B drains THIRD, as its own turn", pty.delivered.length === 3 && pty.delivered[2].text.includes("shipped B"));

    check("(A) FULL SEQUENCE: emergency, then A, then B — nothing lost, nothing reordered among the reports",
      eq(pty.delivered.map((d) => d.text.includes("shipped A") ? "A" : d.text.includes("shipped B") ? "B" : tagOf(d.text)), ["EMERGENCY", "A", "B"]));
    check("(A) the manager's queue is now fully drained", pty.getPending(mgr).length === 0);
  }

  // ===================== (B) SAME-SENDER RUN — adjacent reports from ONE worker still coalesce =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rmei-b-mgr-${sfx}`, wkrC = `rmei-b-wkrC-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkrC, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setBusy(mgr);

    pty.enqueueStdin(mgr, `[loom:worker-report] worker ${wkrC} — progress: step 1`, "system", undefined, undefined, "agent", undefined, undefined, undefined, wkrC);
    pty.enqueueStdin(mgr, `[loom:worker-report] worker ${wkrC} — progress: step 2`, "system", undefined, undefined, "agent", undefined, undefined, undefined, wkrC);
    check("(B) setup: two adjacent same-sender reports queued", pty.getPending(mgr).length === 2);

    sessions.redirectManagerForEmergencyRecycle(mgr, "Your context is ~92% of your window — the EMERGENCY floor...");
    check("(B) the emergency text drains alone first", pty.delivered.length === 1 && pty.delivered[0].text.startsWith("[loom:context-emergency:redirect]"));

    pty.drainNext(mgr);
    check("(B) the worker's TWO-message run still coalesces into ONE drain, exactly as it would have without this fix",
      pty.delivered.length === 3 && pty.delivered[1].text.includes("step 1") && pty.delivered[2].text.includes("step 2"));
    check("(B) the manager's queue is now fully drained", pty.getPending(mgr).length === 0);
  }

  // ===================== (C) NOTHING LOST — a pre-existing head-inserted entry survives, unreordered relative to what follows it =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rmei-c-mgr-${sfx}`, wkrD = `rmei-c-wkrD-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkrD, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setBusy(mgr);

    // A different head-inserted entry already at the front (kind "warning", distinct sender — stands in
    // for some other front-of-queue notice reaching this same manager via a different mechanism).
    pty.enqueueStdin(mgr, "[loom:other-head-insert] some other front-of-queue notice", "system", undefined, undefined, "warning", undefined, undefined, undefined, "other-head-sender", { headInsert: true });
    pty.enqueueStdin(mgr, `[loom:worker-report] worker ${wkrD} — done: shipped D`, "system", undefined, undefined, "agent", undefined, undefined, undefined, wkrD);
    check("(C) setup: the other head-inserted entry sits at the front, the worker report behind it",
      eq(pty.getPending(mgr), ["[loom:other-head-insert] some other front-of-queue notice", `[loom:worker-report] worker ${wkrD} — done: shipped D`]));

    sessions.redirectManagerForEmergencyRecycle(mgr, "Your context is ~92% of your window — the EMERGENCY floor...");
    // The emergency text already drained synchronously (interruptForRedirect → drainNext) by the time
    // this call returns — so what's LEFT in `pending` is exactly the two pre-existing entries, shifted
    // back by one but otherwise untouched: proof nothing was dropped or swapped while inserting ahead of
    // them.
    check("(C) the other two entries survive, unreordered relative to each other, after the emergency text is removed from the front",
      eq(pty.getPending(mgr), ["[loom:other-head-insert] some other front-of-queue notice", `[loom:worker-report] worker ${wkrD} — done: shipped D`]));
    check("(C) the emergency text delivered first, alone", pty.delivered.length === 1 && pty.delivered[0].text.startsWith("[loom:context-emergency:redirect]"));

    pty.drainNext(mgr); // the other head-insert notice, alone (kind "warning" never coalesces with the agent-kind report behind it)
    pty.drainNext(mgr); // the worker report
    check("(C) FULL SEQUENCE: emergency, then the other head-insert notice, then the worker report — nothing lost",
      eq(pty.delivered.map((d) => d.text.includes("shipped D") ? "D" : tagOf(d.text)), ["EMERGENCY", "OTHER", "D"]));
    check("(C) the manager's queue is now fully drained", pty.getPending(mgr).length === 0);
  }

  // ===================== (D) ISOLATION PROBE — "drains alone" pins the NULL sender, not the queue position =====================
  // Card 3dee1d51's own mutant 2 (run by hand, documented at the bottom): mutate
  // redirectManagerForEmergencyRecycle's `enqueueSender` from the literal "system" (which null-maps via
  // coalesceSenderIdentity) to `sessionId` (the manager's OWN session id) and rerun THIS scenario alone —
  // the adjacent entry below deliberately shares that same senderId, so under the mutant the emergency
  // text would wrongly coalesce INTO it instead of draining alone. Under the real fix this probe entry's
  // senderId is irrelevant to the emergency text (null never matches anything), so it stays isolated.
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rmei-d-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    pty.setLive(mgr); pty.setBusy(mgr);

    // Deliberately queued with senderId === mgr's OWN session id — the exact value mutant 2 would make
    // the emergency text's own senderId, so a real regression to that mutant is visible HERE.
    pty.enqueueStdin(mgr, "[loom:isolation-probe] a same-route agent-kind entry sharing the manager's own id as sender", "system", undefined, undefined, "agent", undefined, undefined, undefined, mgr);
    check("(D) setup: the probe entry is queued, carrying the manager's own session id as its sender", pty.getPending(mgr).length === 1);

    sessions.redirectManagerForEmergencyRecycle(mgr, "Your context is ~92% of your window — the EMERGENCY floor...");
    check("(D) drains ALONE: exactly one delivery so far, the emergency text only — it did NOT pull the probe entry in with it",
      pty.delivered.length === 1 && pty.delivered[0].text.startsWith("[loom:context-emergency:redirect]"));
    check("(D) the probe entry is untouched, still queued for its own later turn", pty.getPending(mgr).length === 1 && pty.getPending(mgr)[0].startsWith("[loom:isolation-probe]"));

    pty.drainNext(mgr);
    check("(D) the probe entry then drains on its own, separate turn", pty.delivered.length === 2 && pty.delivered[1].text.startsWith("[loom:isolation-probe]"));
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — redirectManagerForEmergencyRecycle's headInsert:true delivers the emergency text AHEAD of a manager's already-queued worker reports (not behind them), those reports still arrive afterward intact and in order — both cross-sender and as an adjacent same-sender run — and a pre-existing head-inserted entry from elsewhere is shifted back rather than dropped or reordered."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
