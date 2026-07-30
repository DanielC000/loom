import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Service-level guard for the two composed advisories added by board card aa4e24ff, defect 2. NO claude,
// NO live daemon. In-process Db + SessionService + a contract-faithful PtyStub (mirrors redirect-worker.mjs's
// own stub, extended with a settable `busyForMs` so the busy-caused hold's advisory trigger is testable).
//
// §TRIGGER DECISION (see the card): the `worker_message` advisory is gated ONLY on the OBSERVABLE
// `busyForMs` a held enqueue already carries — never on the message's own text. This file's whole job is
// to prove that gate, in both directions, plus worker_redirect's discard-count + re-send-remedy line.
//
// Proves:
//   (A) worker_message: a hold whose busyForMs is OVER the threshold gets an `advisory` naming
//       worker_redirect as the remedy, with the discard+re-send caveat composed in.
//   (B) worker_message: an IMMEDIATE delivery to an IDLE worker gets NO advisory — the negative case
//       §TRIGGER DECISION exists to defend (nothing is landing late, so nothing to advise).
//   (C) worker_message: a hold whose busyForMs is UNDER the threshold also gets NO advisory (ordinary
//       short holds should not be noisy).
//   (D) worker_redirect: when it discards ≥1 queued message, `advisory` names the EXACT count and the
//       re-send remedy.
//   (E) worker_redirect: an idle-worker redirect with NOTHING queued discards 0 and carries no advisory.
//   (F) ADVISORY-ONLY: neither advisory changes delivered/deliveryState/queue-position/interrupting —
//       every existing field is identical to what redirect-worker.mjs / plain messageWorker already
//       proves for the no-advisory case.
//
// Run: 1) build daemon (pnpm build), 2) node test/worker-message-advisories.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wmadv-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Mirrors redirect-worker.mjs's PtyStub exactly, plus a settable per-session `busyForMs` on the held path
// (the real host computes this from `live.busySince`; the stub just lets a test dictate it directly).
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.busyForMs = new Map(); this.interrupts = []; this.delivered = []; }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setBusy(id, on = true, busyForMs) {
    if (on) { this.busy.add(id); if (busyForMs !== undefined) this.busyForMs.set(id, busyForMs); }
    else { this.busy.delete(id); this.busyForMs.delete(id); }
  }
  enqueueStdin(id, text, _source = "system", onDeliver) {
    if (!this.live.has(id)) return { delivered: false, deliveryState: "dropped" };
    if (!this.busy.has(id)) { this.delivered.push({ id, text }); return { delivered: true, deliveryState: "handed-off" }; }
    const a = this.q.get(id) ?? []; a.push({ id: `qm-${a.length}`, text, source: _source, onDeliver }); this.q.set(id, a);
    return { delivered: false, position: a.length, reason: "held", queued: true, landsAt: "next-turn-boundary", busyForMs: this.busyForMs.get(id), deliveryState: "queued" };
  }
  flushPending(id) { const a = this.q.get(id) ?? []; this.q.set(id, []); return a; }
  interruptForRedirect(id) {
    this.interrupts.push(id);
    const a = this.q.get(id) ?? [];
    for (const m of a) { this.delivered.push({ id, text: m.text }); if (m.onDeliver) m.onDeliver(); }
    this.q.set(id, []);
  }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
}

const db = new Db();
const proj = `wmadv-proj-${sfx}`, agent = `wmadv-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: null,
  worktreePath: null, branch: null,
});

try {
  // ===================== (A) OVER threshold: worker_message advisory fires =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `wmadv-a-mgr-${sfx}`, wkr = `wmadv-a-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr);
    pty.setBusy(wkr, true, 10 * 60_000); // mid-turn 10 minutes — comfortably over any reasonable threshold

    const r = sessions.messageWorker(mgr, wkr, "please double-check the schema before you commit");
    check("(A) held (busy worker), unchanged", r.delivered === false && r.deliveryState === "queued" && r.queued === true);
    check("(A) busyForMs is reported unchanged", r.busyForMs === 10 * 60_000);
    check("(A) advisory is present", typeof r.advisory === "string" && r.advisory.length > 0);
    check("(A) advisory names worker_redirect as the remedy", r.advisory.includes("worker_redirect"));
    check("(A) advisory carries the discard+re-send caveat composed in", /discard/i.test(r.advisory) && /re-send/i.test(r.advisory));
    check("(A) advisory does not alter position/landsAt", r.position === 1 && r.landsAt === "next-turn-boundary");
  }

  // ===================== (B) IDLE worker, immediate delivery: NO advisory (the negative case) =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `wmadv-b-mgr-${sfx}`, wkr = `wmadv-b-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); // worker IDLE

    const r = sessions.messageWorker(mgr, wkr, "fyi, no rush");
    check("(B) delivered immediately as a turn", r.delivered === true && r.deliveryState === "handed-off");
    check("(B) busyForMs is absent (nothing landed late)", r.busyForMs === undefined);
    check("(B) NO advisory on an immediate delivery to an idle worker", r.advisory === undefined);
  }

  // ===================== (C) UNDER threshold: held but recent — NO advisory =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `wmadv-c-mgr-${sfx}`, wkr = `wmadv-c-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr);
    pty.setBusy(wkr, true, 30_000); // mid-turn 30 seconds — an ordinary, unremarkable hold

    const r = sessions.messageWorker(mgr, wkr, "quick note");
    check("(C) held (busy worker)", r.delivered === false && r.deliveryState === "queued");
    check("(C) busyForMs reported unchanged", r.busyForMs === 30_000);
    check("(C) NO advisory on an ordinary short hold (below threshold)", r.advisory === undefined);
  }

  // ===================== (D) worker_redirect: discards ≥1 queued message → advisory names the count =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `wmadv-d-mgr-${sfx}`, wkr = `wmadv-d-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr, true, 60_000);

    sessions.messageWorker(mgr, wkr, "first queued note");
    sessions.messageWorker(mgr, wkr, "second queued note");
    check("(D) setup: 2 messages queued behind the busy worker", pty.getPending(wkr).length === 2);

    const r = sessions.redirectWorker(mgr, wkr, "STOP — change of plan");
    check("(D) redirect held (worker was busy) — interrupting", r.delivered === false && r.interrupting === true);
    check("(D) discarded count is exact", r.discarded === 2);
    check("(D) advisory names the EXACT count, not just present", typeof r.advisory === "string" && r.advisory.includes("2 queued message"));
    check("(D) advisory carries the re-send remedy", /re-send/i.test(r.advisory));
  }

  // ===================== (E) worker_redirect: nothing queued → discarded:0, NO advisory =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `wmadv-e-mgr-${sfx}`, wkr = `wmadv-e-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); // idle, nothing queued

    const r = sessions.redirectWorker(mgr, wkr, "change course now");
    check("(E) idle worker: redirect delivered immediately", r.delivered === true);
    check("(E) nothing was queued to discard", r.discarded === 0);
    check("(E) NO advisory when nothing was discarded", r.advisory === undefined);
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_message's advisory fires ONLY on a busy-caused hold whose busyForMs crosses the threshold (never on an immediate idle delivery, never on an ordinary short hold), and worker_redirect's advisory names the exact discard count + re-send remedy only when it actually discarded something — neither advisory alters delivered/deliveryState/position/interrupting."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
