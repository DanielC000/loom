import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cd390610: `redriveInFlightByMsgId` (sessions/service.ts) used to be cleared ONLY by a held entry's
// own `onDeliver` (drain) — never by a pty EXIT. `pty/host.ts`'s exit cleanup empties `live.pending`
// directly, without firing `onDeliver` (deliberate — the durable record must stay unresolved so a LATER
// boot's recovery scan can still redrive it). But that also meant the in-flight mark survived a dead pty
// FOREVER within the same process:
//   1. a redrive is held on worker W (in-flight marked, durable record still unresolved);
//   2. W's pty dies before draining it;
//   3. EVERY later same-process redrive attempt for W (notably W's OWN resume/live-flip) hits the
//      in-flight guard and returns "reEnqueued" WITHOUT actually enqueueing anything;
//   4. the durable record never resolves, so `workerReport`'s pending-direction guard refuses EVERY
//      `done` from W until the whole daemon restarts (a fresh process starts with an empty Set).
// Fix: `clearRedriveInFlightForExit(recipientId)` clears exactly that recipient's own held marks the
// instant its pty exits — so a later same-process redrive (the resume live-flip) can actually retry
// instead of being blocked by a stale mark from a dead pty. It's called from `onPtyExit(sessionId)` (the
// SessionService entry point index.ts's `PtyHostEvents.onExit` actually calls — see that method's own
// doc), grouped there with the setProcessState/setBusy exit bookkeeping so a test can drive the real
// onExit-facing call instead of reaching into `clearRedriveInFlightForExit` directly (a prior version of
// this file did exactly that, which meant deleting the clear call from inside the real production method
// would have left this test green — see `onPtyExit`'s own doc for why it exists).
//
// THIS FILE PROVES BOTH HALVES IN ONE RUN, using the real guard logic unchanged in both scenarios — the
// only difference is whether `onPtyExit` (the fix's real call site) is invoked at the simulated pty exit,
// exactly mirroring whether the fix exists at all:
//   (NO-CLEANUP) `onPtyExit` is never called — byte-identical to pre-fix code (which never had this
//       method, or `clearRedriveInFlightForExit`, or any call site for it) — and reproduces the bug
//       exactly: the same-process resume is blocked, the durable record stays unresolved, and
//       workerReport(done) is REFUSED forever (RED).
//   (WITH-CLEANUP) `onPtyExit(recipientId)` is called, exactly mirroring the real `PtyHostEvents.onExit`
//       wiring (`sessions.onPtyExit(sessionId)` in index.ts) — the same-process resume succeeds, the
//       message delivers, the durable record resolves, and workerReport(done) is ALLOWED (GREEN).
//
// Each scenario mints the manager's direction on a SEPARATE, throwaway PtyStub/SessionService pair (its
// own held copy is then abandoned — exactly like an original dispatch whose process later restarts), then
// drives the actual redrive-under-test on a SECOND pair sharing the same Db — mirroring
// queued-message-liveflip-redrive.mjs's own boot-vs-pre-boot split, so the FIFO a redrive attempt observes
// always starts genuinely empty, never pre-seeded by the mint call's own held copy.
//
// In-process: NO claude, NO live daemon, NO real git (worktreePath exists but isn't a git repo, so
// precheckWorkerDone fails safe to ALLOW — same technique as worker-report-pending-guard.mjs — isolating
// the ONLY differentiator under test: the stuck/cleared in-flight mark).
// Run: 1) build daemon (pnpm build), 2) node test/redrive-inflight-cleared-on-pty-exit.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ricp-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Same contract-faithful PtyStub as queued-message-liveflip-redrive.mjs: a session must be `live` to
// receive; a `busy`/not-ready recipient QUEUES + stores onDeliver; an idle one delivers immediately.
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  enqueueStdin(id, text, _source = "system", onDeliver) {
    if (!this.live.has(id)) return { delivered: false };
    if (!this.busy.has(id)) return { delivered: true };
    const a = this.q.get(id) ?? []; a.push({ text, onDeliver }); this.q.set(id, a);
    return { delivered: false, position: a.length };
  }
  drainOne(id) { const a = this.q.get(id) ?? []; const m = a.shift(); if (m?.onDeliver) m.onDeliver(); return m?.text; }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
  // Simulate a pty DEATH without draining (session exited, FIFO lost): held copies vanish, onDeliver never fires.
  killWithoutDrain(id) { this.q.set(id, []); }
}

const dispatchCount = (pty, id, marker) => pty.getPending(id).filter((t) => t.includes(marker)).length;

function mk(tag) {
  return {
    projId: `ricp-${tag}-proj-${sfx}`, agentId: `ricp-${tag}-ag-${sfx}`, taskId: `ricp-${tag}-task-${sfx}`,
    mgrId: `ricp-${tag}-mgr-${sfx}`, workerId: `ricp-${tag}-wkr-${sfx}`,
    repo: path.join(os.tmpdir(), `loom-ricp-${tag}-repo-${sfx}`),
    worktreePath: path.join(os.tmpdir(), `loom-ricp-${tag}-wt-${sfx}`),
    branch: `loom/${tag}-${sfx}`,
  };
}

function seed(db, p) {
  // worktreePath EXISTS but is NOT a git repo ⇒ workerReport's done-precheck git step throws and fails
  // SAFE to allow, so the pending-direction guard (gated on the durable record) is the sole differentiator.
  fs.mkdirSync(p.repo, { recursive: true });
  fs.mkdirSync(p.worktreePath, { recursive: true });
  db.insertProject({ id: p.projId, name: "RICP", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "RICP-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

// Mint the manager's direction while W is busy on a THROWAWAY pty/session pair, abandoned right after —
// models the original dispatch's own held copy living only in a process that's about to restart (the
// actual redrive-under-test, below, always starts from a genuinely empty FIFO on a fresh pair).
function mintHeldDirection(db, p, text) {
  const mintPty = new PtyStub();
  const mintSessions = new SessionService(db, mintPty, new OrchestrationControl());
  mintPty.setLive(p.mgrId); mintPty.setLive(p.workerId); mintPty.setBusy(p.workerId);
  const r = mintSessions.messageWorker(p.mgrId, p.workerId, text);
  db.setProcessState(p.workerId, "exited"); // the minting process's own pty is now gone
  return r;
}

const db = new Db();
const all = [];

try {
  // ===================== NO-CLEANUP — reproduces the stuck done-guard (RED) =====================
  {
    const P = mk("red"); all.push(P); seed(db, P);
    const TEXT = "STOP — redo the approach";
    const r = mintHeldDirection(db, P, TEXT);
    check("(RED) manager direction HELD + persisted (durable record unresolved)",
      r.delivered === false && db.listUnresolvedQueuedMessagesForWorker(P.workerId).length === 1);

    // Step 1: a redrive is held on W (e.g. its own resume live-flip, or a boot scan) — in-flight marked.
    // Fresh pty/session pair: the FIFO genuinely starts empty (the mint process's own copy is gone).
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    db.setProcessState(P.workerId, "live"); pty.setLive(P.mgrId); pty.setLive(P.workerId); pty.setBusy(P.workerId);
    sessions.redriveUndeliveredMessagesForRecipient(P.workerId);
    check("(RED) step 1: the redrive is held on W (in-flight, still unresolved)",
      dispatchCount(pty, P.workerId, TEXT) === 1 && db.listUnresolvedQueuedMessagesForWorker(P.workerId).length === 1);

    // Step 2: W's pty dies before draining it — WITHOUT the fix's cleanup (the pre-fix shape: this
    // method/call site never existed), the in-flight mark survives the dead pty.
    pty.killWithoutDrain(P.workerId);
    db.setProcessState(P.workerId, "exited");

    // Step 3: W is resumed (live-flip) — SAME process, SAME SessionService instance (the in-flight Set
    // is process-local, not per-pty-instance). The stale mark blocks this redrive from ever happening.
    db.setProcessState(P.workerId, "live"); pty.setLive(P.workerId); pty.setBusy(P.workerId);
    sessions.redriveUndeliveredMessagesForRecipient(P.workerId);
    check("(RED) step 3: the same-process resume is BLOCKED by the stale in-flight mark (never re-enqueued)",
      dispatchCount(pty, P.workerId, TEXT) === 0);
    check("(RED) the durable record is PERMANENTLY stuck unresolved (no further redrive will ever clear it)",
      db.listUnresolvedQueuedMessagesForWorker(P.workerId).length === 1);

    // Step 4: workerReport's pending-direction guard refuses EVERY done — the stuck done-guard this card
    // is about. The worker never actually sees the direction (it was never re-delivered), yet the guard
    // still fires because the durable record looks exactly like genuinely-unconsumed direction.
    pty.setBusy(P.workerId, false);
    const rpt = await sessions.workerReport(P.workerId, { status: "done", summary: "finished my work" });
    check("(RED) workerReport(done) is REFUSED — the stuck done-guard (card cd390610's own symptom)",
      rpt.reported === false && rpt.refused === true);
    check("(RED) task STAYS in_progress", db.getTask(P.taskId).columnKey === "in_progress");
  }

  // ===================== WITH-CLEANUP — the fix (GREEN) =====================
  {
    const G = mk("green"); all.push(G); seed(db, G);
    const TEXT = "STOP — redo the approach";
    const r = mintHeldDirection(db, G, TEXT);
    check("(GREEN) manager direction HELD + persisted (durable record unresolved)",
      r.delivered === false && db.listUnresolvedQueuedMessagesForWorker(G.workerId).length === 1);

    // Step 1: same as RED — a redrive is held on W, on a fresh pty/session pair.
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    db.setProcessState(G.workerId, "live"); pty.setLive(G.mgrId); pty.setLive(G.workerId); pty.setBusy(G.workerId);
    sessions.redriveUndeliveredMessagesForRecipient(G.workerId);
    check("(GREEN) step 1: the redrive is held on W (in-flight, still unresolved)",
      dispatchCount(pty, G.workerId, TEXT) === 1 && db.listUnresolvedQueuedMessagesForWorker(G.workerId).length === 1);

    // Step 2: W's pty dies before draining it — THIS TIME the real production entry point runs, exactly
    // mirroring index.ts's real `PtyHostEvents.onExit` wiring (`sessions.onPtyExit(sessionId)`), not just
    // the clear helper directly — so deleting the clear call from inside `onPtyExit` would turn this RED.
    pty.killWithoutDrain(G.workerId);
    sessions.onPtyExit(G.workerId);

    // Step 3: W is resumed (live-flip), SAME process — the cleared mark lets this redrive actually run.
    db.setProcessState(G.workerId, "live"); pty.setLive(G.workerId); pty.setBusy(G.workerId);
    sessions.redriveUndeliveredMessagesForRecipient(G.workerId);
    check("(GREEN) step 3: the same-process resume SUCCEEDS (re-enqueued onto the new pty)",
      dispatchCount(pty, G.workerId, TEXT) === 1);
    check("(GREEN) the durable record is still unresolved until it actually drains", db.listUnresolvedQueuedMessagesForWorker(G.workerId).length === 1);

    // Step 4: the message finally drains on W's next turn — resolves the durable record for real.
    const drained = pty.drainOne(G.workerId);
    check("(GREEN) the re-driven message delivers on W's next turn", typeof drained === "string" && drained.includes(TEXT));
    check("(GREEN) delivery RESOLVED the durable record (zero unresolved)", db.listUnresolvedQueuedMessagesForWorker(G.workerId).length === 0);

    // Step 5: workerReport(done) is now ALLOWED — the stuck done-guard is resolved.
    pty.setBusy(G.workerId, false); // idle, as a real worker would be at its next turn boundary
    const rpt = await sessions.workerReport(G.workerId, { status: "done", summary: "finished my work" });
    check("(GREEN) workerReport(done) is ALLOWED — the done-guard is no longer stuck", rpt.reported === true && !rpt.refused);
    check("(GREEN) task moves to review", db.getTask(G.taskId).columnKey === "review");
  }

  // ===================== NO REGRESSION — a GENUINELY concurrent in-flight redrive (DIFFERENT recipient)
  // ===================== is untouched by another recipient's exit cleanup =====================
  {
    const A = mk("other-a"); all.push(A); seed(db, A);
    const B = mk("other-b"); all.push(B); seed(db, B);
    const TEXT_A = "A's own instruction", TEXT_B = "B's own instruction";
    const rA = mintHeldDirection(db, A, TEXT_A);
    const rB = mintHeldDirection(db, B, TEXT_B);
    check("(scope) both A and B held + persisted at mint", rA.delivered === false && rB.delivered === false);

    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    db.setProcessState(A.workerId, "live"); pty.setLive(A.mgrId); pty.setLive(A.workerId); pty.setBusy(A.workerId);
    db.setProcessState(B.workerId, "live"); pty.setLive(B.mgrId); pty.setLive(B.workerId); pty.setBusy(B.workerId);
    sessions.redriveUndeliveredMessagesForRecipient(A.workerId);
    sessions.redriveUndeliveredMessagesForRecipient(B.workerId);
    check("(scope) both A and B are genuinely in-flight (held, unresolved)",
      db.listUnresolvedQueuedMessagesForWorker(A.workerId).length === 1
      && db.listUnresolvedQueuedMessagesForWorker(B.workerId).length === 1);

    // A's pty exits; its cleanup must NOT disturb B's own still-genuinely-in-flight redrive. Drives the
    // same real production entry point as the GREEN scenario above.
    pty.killWithoutDrain(A.workerId);
    sessions.onPtyExit(A.workerId);

    // B is STILL live with its FIFO intact (never exited) — a redundant redrive attempt for B must still
    // be blocked by its own (still-valid) in-flight mark, proving A's cleanup was scoped to A alone.
    sessions.redriveUndeliveredMessagesForRecipient(B.workerId);
    check("(scope) B's own in-flight mark is UNAFFECTED by A's exit cleanup (still blocks a duplicate)",
      dispatchCount(pty, B.workerId, TEXT_B) === 1); // still exactly 1, not 2 (no double-enqueue)

    // And A, now resumed, DOES get its own redrive — proving the cleanup actually worked for A too.
    db.setProcessState(A.workerId, "live"); pty.setLive(A.workerId); pty.setBusy(A.workerId);
    sessions.redriveUndeliveredMessagesForRecipient(A.workerId);
    check("(scope) A's own resume succeeds after its cleanup (the cleanup did its job for A)",
      dispatchCount(pty, A.workerId, TEXT_A) === 1);
  }

  db.close();
} finally {
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const p of all) {
    try { fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — without the fix's exit cleanup, a worker whose pty dies while holding a redriven message is PERMANENTLY stuck (same-process resume blocked, done-guard refused forever); with it (onPtyExit, the real method PtyHostEvents.onExit calls in index.ts), the same-process resume succeeds, the message delivers, and workerReport(done) is allowed — scoped to exactly the exiting recipient, leaving a different recipient's own genuinely in-flight redrive untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
