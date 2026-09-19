import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Service-level guard for card d9c203e4: `worker_message` (sessions/service.ts's `messageWorker`) against
// a codex session wedged before it ever finished booting (card bba13405's own durable `getCodexBootStuck`
// latch). NO real claude/codex, NO live daemon — same in-process Db + SessionService + contract-faithful
// PtyStub technique as worker-message-advisories.mjs (this file's own direct sibling; extends its PtyStub
// with a settable `getCodexBootStuck`).
//
// THE DEFECT THIS CLOSES: `bba13405` made `codexBootStuck` READABLE on worker_status/worker_list, but the
// SEND side (`worker_message`) was unchanged — a held enqueue against a boot-stuck codex session still
// returned a plain, affirmatively-reassuring `{delivered:false, queued:true, deliveryState:"queued"}`
// (verified at source, pty/host.ts's `enqueueStdinCodex`: the codex held branch never sets `reason`/
// `landsAt`/`busyForMs` at all — the card's own illustrative JSON quotes claude's shape, not codex's real
// one; this file tests the REAL shape). Shipped `/orchestrate` doctrine tells a manager a `"held"`-shaped
// result is a SUCCESS and NOT to re-send — exactly the wrong read for a session that will never take
// another turn until it recovers or is stopped/recycled.
//
// Proves:
//   (A) A held enqueue against a BOOT-STUCK codex worker gets an `advisory` naming the wedge, explicitly
//       saying delivery will NOT land at a next-turn-boundary, and pointing at worker_status/worker_stop/
//       worker_recycle. `queued`/`deliveryState` are UNCHANGED (still durably queued — this is option (b),
//       not a refusal).
//   (B) A HEALTHY (getCodexBootStuck returns null) codex-shaped hold gets NO bootStuck advisory — the
//       negative case: the guard doesn't false-positive just because the stub implements the method.
//   (C) A PtyStub that does NOT implement `getCodexBootStuck` at all (mirrors the ~88 real hermetic test
//       doubles the card calls out) degrades to TODAY's plain result — no throw, no advisory, byte-
//       identical to worker-message-advisories.mjs's own case (C). This is DoD-4's "byte-identical"
//       assertion for the ordinary-busy-hold case, re-proven here against a stub lacking the new method.
//   (D) ORDERING: when a stub's held response carries BOTH a boot-stuck signal AND a `busyForMs` over the
//       aa4e24ff advisory threshold, the boot-stuck advisory wins (checked first) — never both, never the
//       wrong one.
//   (E) An IDLE worker (immediate delivery) never consults getCodexBootStuck's result for an advisory —
//       `delivered:true` path is untouched.
//
// RED-BEFORE-GREEN (this project's own standing verification posture): run against the PRE-FIX
// sessions/service.ts (`git show HEAD:packages/daemon/src/sessions/service.ts`, i.e. before card d9c203e4's
// `messageWorker` change) — (A) and (D) fail (`advisory` is undefined where a bootStuck string was
// expected); (B)/(C)/(E) already pass unchanged. See the worker report for the exact revert/rebuild/
// restore commands used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wmcbs-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Mirrors worker-message-advisories.mjs's PtyStub, plus a settable `getCodexBootStuck` — omitted entirely
// for a stub instance that must mimic the ~88 real hermetic doubles that don't implement it yet.
class PtyStub {
  constructor({ implementsGetCodexBootStuck = true } = {}) {
    this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.busyForMs = new Map();
    this.interrupts = []; this.delivered = []; this.bootStuck = new Map();
    if (implementsGetCodexBootStuck) {
      this.getCodexBootStuck = (id) => this.bootStuck.get(id) ?? null;
    }
    // deliberately no `getCodexBootStuck` property at all when implementsGetCodexBootStuck is false —
    // `typeof this.pty.getCodexBootStuck` must read "undefined", not merely a function returning null.
  }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setBusy(id, on = true, busyForMs) {
    if (on) { this.busy.add(id); if (busyForMs !== undefined) this.busyForMs.set(id, busyForMs); }
    else { this.busy.delete(id); this.busyForMs.delete(id); }
  }
  setBootStuck(id, info) { this.bootStuck.set(id, info); }
  enqueueStdin(id, text, _source = "system", onDeliver) {
    if (!this.live.has(id)) return { delivered: false, deliveryState: "dropped" };
    if (!this.busy.has(id)) { this.delivered.push({ id, text }); return { delivered: true, deliveryState: "handed-off" }; }
    const a = this.q.get(id) ?? []; a.push({ id: `qm-${a.length}`, text, source: _source, onDeliver }); this.q.set(id, a);
    // Mirrors the REAL codex held shape (pty/host.ts's enqueueStdinCodex), verified at source: no `reason`,
    // no `landsAt`, no `busyForMs` on the codex path — unlike worker-message-advisories.mjs's PtyStub,
    // which deliberately mirrors CLAUDE's held shape instead. Cases (D) opts back into a busyForMs value
    // to test ORDERING against a stub that carries both signals at once.
    const busyForMs = this.busyForMs.get(id);
    return { delivered: false, queued: true, deliveryState: "queued", ...(busyForMs !== undefined ? { busyForMs } : {}) };
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
const proj = `wmcbs-proj-${sfx}`, agent = `wmcbs-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: null,
  worktreePath: null, branch: null, harness: o.harness ?? undefined,
});

const BOOT_STUCK_INFO = { at: Date.now(), timeoutMs: 45_000, unmet: ["ready marker", "model-loaded"] };

try {
  // ===================== (A) BOOT-STUCK codex worker: honest advisory, still durably queued =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `wmcbs-a-mgr-${sfx}`, wkr = `wmcbs-a-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, harness: "codex" });
    pty.setLive(mgr); pty.setLive(wkr);
    pty.setBusy(wkr, true); // codex's own held branch never carries busyForMs — matches the real shape
    pty.setBootStuck(wkr, BOOT_STUCK_INFO);

    const r = sessions.messageWorker(mgr, wkr, "please check in");
    check("(A) still durably queued — this is option (b), not a refusal", r.delivered === false && r.deliveryState === "queued" && r.queued === true);
    check("(A) advisory is present", typeof r.advisory === "string" && r.advisory.length > 0);
    check("(A) advisory does NOT claim next-turn-boundary delivery", !/will land at a "?next turn boundary"?/i.test(r.advisory) || /will NOT land/i.test(r.advisory));
    check("(A) advisory explicitly says it will NOT land at a next turn boundary", /NOT land/.test(r.advisory));
    check("(A) advisory names the wedge (never reached model-loaded)", /never (reached|finished) boot/i.test(r.advisory) || /model-loaded/i.test(r.advisory));
    check("(A) advisory names the two remedies", /worker_stop/.test(r.advisory) && /worker_recycle/.test(r.advisory));
    check("(A) advisory points at worker_status's codexBootStuck field", /codexBootStuck/.test(r.advisory));
    check("(A) advisory includes the real unmet list, not a generic message", /ready marker/.test(r.advisory) && /model-loaded/.test(r.advisory));
  }

  // ===================== (B) HEALTHY codex hold (getCodexBootStuck returns null): no bootStuck advisory =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `wmcbs-b-mgr-${sfx}`, wkr = `wmcbs-b-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, harness: "codex" });
    pty.setLive(mgr); pty.setLive(wkr);
    pty.setBusy(wkr, true); // busy, but genuinely healthy — never marked boot-stuck

    const r = sessions.messageWorker(mgr, wkr, "please check in");
    check("(B) held (busy), unchanged shape", r.delivered === false && r.deliveryState === "queued" && r.queued === true);
    check("(B) NO advisory — the stub implements getCodexBootStuck but it correctly reads null", r.advisory === undefined);
  }

  // ===================== (C) STUB WITHOUT getCodexBootStuck AT ALL: byte-identical to today, no throw =====================
  {
    const pty = new PtyStub({ implementsGetCodexBootStuck: false });
    check("(setup) this stub genuinely has no getCodexBootStuck", typeof pty.getCodexBootStuck !== "function");
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `wmcbs-c-mgr-${sfx}`, wkr = `wmcbs-c-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr);
    pty.setBusy(wkr, true, 30_000); // an ordinary short hold — mirrors worker-message-advisories.mjs (C)

    const r = sessions.messageWorker(mgr, wkr, "quick note");
    check("(C) held (busy worker) — degrades cleanly, no throw", r.delivered === false && r.deliveryState === "queued");
    check("(C) busyForMs reported unchanged", r.busyForMs === 30_000);
    check("(C) NO advisory — DoD-4's byte-identical healthy-busy contract, re-proven against a stub lacking the new method", r.advisory === undefined);
  }

  // ===================== (D) ORDERING: boot-stuck + busyForMs-over-threshold both present -> boot-stuck wins =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `wmcbs-d-mgr-${sfx}`, wkr = `wmcbs-d-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, harness: "codex" });
    pty.setLive(mgr); pty.setLive(wkr);
    pty.setBusy(wkr, true, 10 * 60_000); // also over the aa4e24ff busyForMs threshold
    pty.setBootStuck(wkr, BOOT_STUCK_INFO);

    const r = sessions.messageWorker(mgr, wkr, "status check");
    check("(D) the boot-stuck advisory wins — never the busyForMs/worker_redirect one", /NOT land/.test(r.advisory) && !/worker_redirect/.test(r.advisory));
  }

  // ===================== (E) IDLE worker (immediate delivery): getCodexBootStuck result never consulted =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `wmcbs-e-mgr-${sfx}`, wkr = `wmcbs-e-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, harness: "codex" });
    pty.setLive(mgr); pty.setLive(wkr); // idle
    pty.setBootStuck(wkr, BOOT_STUCK_INFO); // set, but must be irrelevant on the delivered:true path

    const r = sessions.messageWorker(mgr, wkr, "fyi");
    check("(E) delivered immediately as a turn", r.delivered === true && r.deliveryState === "handed-off");
    check("(E) NO advisory on an immediate delivery, even with a boot-stuck signal set", r.advisory === undefined);
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_message's response is honest for a boot-stuck codex session (advisory names the wedge, says delivery will NOT land at a next-turn-boundary, points at worker_status/worker_stop/worker_recycle) while staying durably queued (option (b), not a refusal); a healthy codex hold, a stub lacking getCodexBootStuck entirely, and an idle immediate delivery are all unaffected; the boot-stuck advisory takes priority over the ordinary busyForMs advisory when both signals are present."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
