import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Service-level guard for the dispatch-time `contextWarning` advisory (card 17576ca3). NO claude, NO
// live daemon. In-process Db + SessionService + a contract-faithful PtyStub (mirrors redirect-worker.mjs
// / worker-message-advisories.mjs's own stub).
//
// `workerContextWarnRatio` (card dacc6d9e) is the ONE shared key this reads via resolveConfig —
// never hard-coded. Model is left null on every session here so the context window resolves to the
// DEFAULT_CONTEXT_WINDOW (200,000) — see types.ts's contextWindowForModel — making the ratio math exact
// and the test independent of the model-window table.
//
// Proves:
//   (A) BELOW the warn ratio → no `contextWarning` on either tool (idle delivery).
//   (B) AT the warn ratio exactly → `contextWarning` fires — "at or above", not strictly above.
//   (C) ABOVE the warn ratio → `contextWarning` fires, names the live percentage.
//   (D) ratio DISABLED (0) → no `contextWarning` even at a very high occupancy.
//   (E) ctxInputTokens NULL (unmeasured — never treated as 0) → no `contextWarning` regardless of ratio.
//   (F) COEXISTENCE on worker_message: a busy-but-under-the-busyForMs-threshold hold carries
//       `contextWarning` with no `advisory` (the two advisories are independent, gated separately).
//   (G) COEXISTENCE on worker_redirect: a redirect that discards queued messages carries BOTH
//       `contextWarning` and the discard `advisory` together.
//   (H) EXHAUSTED (card 66ff7321): `contextExhaustedAt` set → `contextWarning` says so INSTEAD of a
//       percentage, on both tools, even with ctxInputTokens null/low or the ratio disabled; AND
//       `redirectWorker` reports the ordinary next-turn-boundary hold for it — never after-interrupt,
//       never a real `pty.interruptForRedirect` call (there is nothing in flight to interrupt).
//   (I) DROPPED delivery (worker gone — session-dead): no `contextWarning` on either tool, even when the
//       worker's own live occupancy (had it still existed) would otherwise have fired.
//   (J) `SessionService.handleBusyEdge(id, true)` — the real rising-edge chokepoint, not a hand-copied
//       mirror of it — clears a prior `contextExhaustedAt` mark on that row.
//   (K) CODEX HARNESS (card c10f9ea1): a codex-harness worker with a non-null `ctxInputTokens` above the
//       ratio gets NO `contextWarning` — gated structurally on `contextTelemetryFor(worker.harness)`, not
//       merely on codex convention never writing the field. Positive control: the EXHAUSTED signal is
//       harness-independent and still fires for that same codex worker.
//
// Run: 1) build daemon (pnpm build), 2) node test/worker-context-warning-advisory.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wcwa-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Mirrors redirect-worker.mjs / worker-message-advisories.mjs's PtyStub, plus an `exhausted` set so
// case (H) below can exercise the REAL contract: the production `enqueueStdin` never idle-delivers to a
// contextExhausted session even when `busy` is false (decision 66ff7321) — without that, a hermetic stub
// that only gates on `busy` can't reach the `deliverRedirect` branch card 66ff7321's exhausted/interrupt
// guard actually protects.
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.busyForMs = new Map(); this.exhausted = new Set(); this.interrupts = []; this.delivered = []; }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setBusy(id, on = true, busyForMs) {
    if (on) { this.busy.add(id); if (busyForMs !== undefined) this.busyForMs.set(id, busyForMs); }
    else { this.busy.delete(id); this.busyForMs.delete(id); }
  }
  setExhausted(id, on = true) { if (on) this.exhausted.add(id); else this.exhausted.delete(id); }
  enqueueStdin(id, text, _source = "system", onDeliver) {
    if (!this.live.has(id)) return { delivered: false, deliveryState: "dropped" };
    if (!this.busy.has(id) && !this.exhausted.has(id)) { this.delivered.push({ id, text }); return { delivered: true, deliveryState: "handed-off" }; }
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

// One project per case so each can set its own `workerContextWarnRatio` override without interference.
let caseIdx = 0;
function makeCase({ ratio, ctxInputTokens, harness }) {
  caseIdx += 1;
  const proj = `wcwa-proj-${sfx}-${caseIdx}`, agent = `wcwa-ag-${sfx}-${caseIdx}`;
  db.insertProject({
    id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(),
    config: ratio === undefined ? {} : { orchestration: { workerContextWarnRatio: ratio } },
    createdAt: now, archivedAt: null,
  });
  db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
  const mgr = `wcwa-mgr-${sfx}-${caseIdx}`, wkr = `wcwa-wkr-${sfx}-${caseIdx}`;
  const mk = (id, o) => db.insertSession({
    id, projectId: proj, agentId: agent, engineSessionId: `eng-${id}`, title: null, cwd: os.tmpdir(),
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: null,
    worktreePath: null, branch: null, ctxInputTokens: o.ctxInputTokens ?? null, model: null,
    harness: o.harness ?? undefined,
  });
  mk(mgr, { role: "manager" });
  mk(wkr, { role: "worker", parentSessionId: mgr, ctxInputTokens, harness });
  const pty = new PtyStub();
  pty.setLive(mgr); pty.setLive(wkr);
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  return { mgr, wkr, pty, sessions };
}

try {
  // ===================== (A) BELOW ratio: idle delivery, NO contextWarning =====================
  {
    const { mgr, wkr, sessions } = makeCase({ ratio: 0.6, ctxInputTokens: 100_000 }); // r=0.50 < 0.60
    const r1 = sessions.messageWorker(mgr, wkr, "ordinary note");
    check("(A) messageWorker delivered, below ratio: NO contextWarning", r1.delivered === true && r1.contextWarning === undefined);
    const r2 = sessions.redirectWorker(mgr, wkr, "ordinary redirect");
    check("(A) redirectWorker delivered, below ratio: NO contextWarning", r2.delivered === true && r2.contextWarning === undefined);
  }

  // ===================== (B) AT ratio exactly: fires ("at or above", not strictly above) =====================
  {
    const { mgr, wkr, sessions } = makeCase({ ratio: 0.6, ctxInputTokens: 120_000 }); // r=0.60 == 0.60
    const r1 = sessions.messageWorker(mgr, wkr, "ordinary note");
    check("(B) AT the ratio exactly: contextWarning fires", typeof r1.contextWarning === "string");
    check("(B) names the live percentage (60%)", r1.contextWarning.includes("60%"));
  }

  // ===================== (C) ABOVE ratio: fires, names the live percentage =====================
  {
    const { mgr, wkr, sessions } = makeCase({ ratio: 0.6, ctxInputTokens: 150_000 }); // r=0.75 > 0.60
    const r1 = sessions.messageWorker(mgr, wkr, "ordinary note");
    check("(C) ABOVE the ratio: contextWarning fires", typeof r1.contextWarning === "string");
    check("(C) names the live percentage (75%)", r1.contextWarning.includes("75%"));
    check("(C) advises recycling", /recycle/i.test(r1.contextWarning));
    const r2 = sessions.redirectWorker(mgr, wkr, "ordinary redirect");
    check("(C) redirectWorker: same advisory fires", typeof r2.contextWarning === "string" && r2.contextWarning.includes("75%"));
  }

  // ===================== (D) ratio DISABLED (0): no contextWarning even at very high occupancy =====================
  {
    const { mgr, wkr, sessions } = makeCase({ ratio: 0, ctxInputTokens: 190_000 }); // r=0.95, but ratio disabled
    const r1 = sessions.messageWorker(mgr, wkr, "ordinary note");
    check("(D) ratio 0 disables the advisory even at 95% occupancy", r1.contextWarning === undefined);
    const r2 = sessions.redirectWorker(mgr, wkr, "ordinary redirect");
    check("(D) same for redirectWorker", r2.contextWarning === undefined);
  }

  // ===================== (E) ctxInputTokens NULL (unmeasured): never treated as 0 =====================
  {
    const { mgr, wkr, sessions } = makeCase({ ratio: 0.6, ctxInputTokens: null });
    const r1 = sessions.messageWorker(mgr, wkr, "ordinary note");
    check("(E) null ctxInputTokens: NO contextWarning (not treated as 0)", r1.contextWarning === undefined);
    const r2 = sessions.redirectWorker(mgr, wkr, "ordinary redirect");
    check("(E) same for redirectWorker", r2.contextWarning === undefined);
  }

  // ===================== (F) COEXISTENCE: worker_message, busy-but-under-busyForMs-threshold =====================
  {
    const { mgr, wkr, pty, sessions } = makeCase({ ratio: 0.6, ctxInputTokens: 150_000 }); // r=0.75
    pty.setBusy(wkr, true, 30_000); // ordinary short hold — well under WORKER_MESSAGE_HELD_ADVISORY_MS
    const r = sessions.messageWorker(mgr, wkr, "quick note");
    check("(F) held (busy, short hold)", r.delivered === false && r.deliveryState === "queued");
    check("(F) contextWarning still fires on a held message", typeof r.contextWarning === "string" && r.contextWarning.includes("75%"));
    check("(F) the OTHER (busyForMs) advisory stays absent — independent gates", r.advisory === undefined);
  }

  // ===================== (G) COEXISTENCE: worker_redirect discards queued messages AND warns =====================
  {
    const { mgr, wkr, pty, sessions } = makeCase({ ratio: 0.6, ctxInputTokens: 150_000 }); // r=0.75
    pty.setBusy(wkr, true, 60_000);
    sessions.messageWorker(mgr, wkr, "first queued note");
    check("(G) setup: 1 message queued behind the busy worker", pty.getPending(wkr).length === 1);
    const r = sessions.redirectWorker(mgr, wkr, "STOP — change of plan");
    check("(G) redirect discarded the queued message", r.discarded === 1);
    check("(G) discard advisory present", typeof r.advisory === "string" && r.advisory.includes("1 queued message"));
    check("(G) contextWarning ALSO present alongside the discard advisory", typeof r.contextWarning === "string" && r.contextWarning.includes("75%"));
  }

  // ===================== (H) EXHAUSTED: says so INSTEAD of a percentage, unconditionally =====================
  {
    // ctxInputTokens deliberately null AND ratio disabled (0) — the exhausted check must fire anyway.
    const { mgr, wkr, pty, sessions } = makeCase({ ratio: 0, ctxInputTokens: null });
    db.setContextExhausted(wkr, new Date().toISOString(), "Context exhausted");
    // Mirror the real contract on the PTY side too (decision 66ff7321): an exhausted session never
    // idle-delivers even though `busy` reads false — without this, the stub's own busy-only gate would
    // deliver immediately and never reach `deliverRedirect`'s exhausted/interrupt branch below.
    pty.setExhausted(wkr, true);
    const r1 = sessions.messageWorker(mgr, wkr, "ordinary note");
    check("(H) messageWorker: contextWarning fires despite null ctx + disabled ratio", typeof r1.contextWarning === "string");
    check("(H) names exhaustion, not a percentage", /exhaust/i.test(r1.contextWarning) && !/%/.test(r1.contextWarning));
    check("(H) advises worker_recycle", r1.contextWarning.includes("worker_recycle"));
    const r2 = sessions.redirectWorker(mgr, wkr, "ordinary redirect");
    check("(H) redirectWorker: same exhaustion advisory fires", typeof r2.contextWarning === "string" && /exhaust/i.test(r2.contextWarning));
    // @decision 66ff7321 — an exhausted target has nothing in flight to interrupt: never after-interrupt,
    // never pty.interruptForRedirect.
    check("(H) redirectWorker: exhausted target gets the ordinary hold, never after-interrupt", r2.landsAt !== "after-interrupt" && r2.interrupting !== true);
    check("(H) redirectWorker: no interrupt fired for the exhausted target", !pty.interrupts.includes(wkr));
  }

  // ===================== (I) DROPPED delivery: no contextWarning even though occupancy would fire =====================
  {
    const { mgr, wkr, pty, sessions } = makeCase({ ratio: 0.6, ctxInputTokens: 150_000 }); // r=0.75 — would fire if live
    pty.setLive(wkr, false); // worker gone — enqueueStdin reports deliveryState:"dropped"
    const r1 = sessions.messageWorker(mgr, wkr, "ordinary note");
    check("(I) messageWorker: dropped delivery", r1.delivered === false && r1.deliveryState === "dropped");
    check("(I) messageWorker: NO contextWarning on a dropped delivery", r1.contextWarning === undefined);
    const r2 = sessions.redirectWorker(mgr, wkr, "ordinary redirect");
    check("(I) redirectWorker: dropped delivery", r2.delivered === false && r2.deliveryState === "dropped");
    check("(I) redirectWorker: NO contextWarning on a dropped delivery", r2.contextWarning === undefined);
  }

  // ===================== (J) handleBusyEdge rising edge clears a prior exhaustion mark =====================
  // @decision 66ff7321 — a resume's first turn (busy false→true) must clear contextExhaustedAt on THIS
  // row.
  {
    const { wkr, sessions } = makeCase({ ratio: 0.6, ctxInputTokens: 100_000 });
    db.setContextExhausted(wkr, new Date().toISOString(), "Context exhausted");
    check("(J) setup: contextExhaustedAt is set", db.getSession(wkr).contextExhaustedAt != null);
    sessions.handleBusyEdge(wkr, true); // the real rising-edge chokepoint, not a hand-copied mirror of it
    check("(J) handleBusyEdge(busy=true) clears contextExhaustedAt", db.getSession(wkr).contextExhaustedAt === null);
  }

  // ===================== (K) CODEX HARNESS: no ctx telemetry → no contextWarning even above ratio =====================
  // card c10f9ea1: workerContextWarningFor must gate on contextTelemetryFor(worker.harness), same as every
  // other context-reading consumer — a codex worker must never get a ratio-based contextWarning,
  // structurally, not merely because codex never writes ctxInputTokens.
  {
    const { mgr, wkr, sessions } = makeCase({ ratio: 0.6, ctxInputTokens: 150_000, harness: "codex" }); // r=0.75 — would fire for claude
    const r1 = sessions.messageWorker(mgr, wkr, "ordinary note");
    check("(K) codex harness, ctx above ratio: NO contextWarning", r1.contextWarning === undefined);
    const r2 = sessions.redirectWorker(mgr, wkr, "ordinary redirect");
    check("(K) same for redirectWorker", r2.contextWarning === undefined);
    // Positive control: the EXHAUSTED signal is harness-independent and must still fire for this SAME
    // codex worker — proves (K) above is the ratio gate specifically, not "nothing ever fires for codex".
    db.setContextExhausted(wkr, new Date().toISOString(), "Context exhausted");
    const r3 = sessions.messageWorker(mgr, wkr, "ordinary note");
    check("(K) control: exhausted still fires for a codex worker (harness-independent)", typeof r3.contextWarning === "string" && /exhaust/i.test(r3.contextWarning));
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_message/worker_redirect carry a dispatch-time `contextWarning` advisory exactly " +
    "when the target worker's live context is at or above `workerContextWarnRatio` (never below, never " +
    "when disabled, never when ctxInputTokens is unmeasured, never on a dropped delivery), independent of " +
    "(and coexisting cleanly with) each tool's own other advisories."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
