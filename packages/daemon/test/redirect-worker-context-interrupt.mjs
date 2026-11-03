import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Service-level guard for SessionService.redirectWorkerForContextInterrupt (card dacc6d9e, Trigger D).
// NO claude, NO live daemon. In-process Db + SessionService (+ its REAL internal GateSemaphore) + a
// contract-faithful PtyStub, mirroring redirect-worker.mjs's own harness exactly.
//
// PROVES the two things context-watcher-worker-ratios.mjs's injected stub can't reach, because that
// file never exercises the real SessionService/GateSemaphore:
//   (A) hasLiveGateForSession REFUSAL — a real, live gate op (admitted via `runExclusive`, a "running"
//       state) for the worker's own session id makes redirectWorkerForContextInterrupt return
//       fired:false, reason:"gate-in-flight", WITHOUT ever calling deliverRedirect (no interrupt, no
//       redirect_worker event); once the gate settles, the SAME call fires normally. The OTHER THREE live
//       states `hasLiveGateForSession` also covers (CR round 2 widened it to four independent reads — see
//       that method's own doc) are exercised separately below: scenario (C) the genuinely QUEUED gate
//       state, (D) the squash-only state, (E) the repo-guard-only state, and (F, CR round 3) the
//       pending-merge-call pre-admission state (`peekPendingMerge(...)?.state === "running"`).
//   (B) supersedeQueue:false + headInsert:true (CR round 2) — a worker's PRE-EXISTING queued MANAGER
//       direction SURVIVES this interrupt (unlike redirectWorker's own default, which supersedes it) AND
//       drains in the CORRECT ORDER: the interrupt's own text delivers FIRST, as its own turn (headInsert
//       places it at the queue's front); the manager's direction — a DIFFERENT sender, so never part of
//       that same drain — stays undelivered until its OWN later turn.
//
// Run: 1) build daemon, 2) node test/redirect-worker-context-interrupt.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME BEFORE importing db.js (paths.ts reads it at import time).
const tmpHome = path.join(os.tmpdir(), `loom-redirwci-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// CR round 2 (card dacc6d9e): this stub used to be UNFAITHFUL in one load-bearing way —
// `interruptForRedirect` dumped the ENTIRE queue as a single delivery, hiding the real host's actual
// behavior (drainPending releases only the LEADING SAME-SENDER run per settle; a different-sender entry
// behind it needs its OWN later Stop-triggered drain). Fixed: `enqueueStdin` now honors the real
// `EnqueueStdinTail.headInsert` option (`tail.headInsert` → unshift, not push) and tracks each entry's
// `senderId` (positional arg 10 — never the literal `"system"` `_source` string, which both a worker's
// own manager-direction and a Loom-originated interrupt share and so can never discriminate a real
// sender run); `interruptForRedirect` now drains only ONE sender-run (mirrors the real Esc→settle→drain,
// which ends ONE turn, not the whole queue) via the new `drainNext`, which a caller invokes again to
// model each SUBSEQUENT Stop-triggered drain.
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
const proj = `rwci-proj-${sfx}`, agent = `rwci-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null, recycledFrom: o.recycledFrom ?? null,
});

try {
  // ===================== Unknown session throws =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    let threw = null;
    try { sessions.redirectWorkerForContextInterrupt("no-such-worker", "hi"); } catch (e) { threw = e.message; }
    check("unknown session throws 'session not found'", threw === "session not found");
  }

  // ===================== (A) hasLiveGateForSession REFUSAL, queued + running, then clears =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rwci-a-mgr-${sfx}`, wkr = `rwci-a-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);

    check("(A) setup: hasLiveGateForSession is false before any gate runs", sessions.hasLiveGateForSession(wkr) === false);

    // Hold a REAL gate slot open against this worker's OWN session id (gateType "worker", mirrors a
    // run_gate self-check) — unresolved until we release it below.
    let releaseGate;
    const held = new Promise((resolve) => { releaseGate = resolve; });
    const gateRun = sessions.gateSemaphore.runExclusive(
      1, { gateType: "worker", projectId: proj, sessionId: wkr }, () => held, "low",
    );

    // Give the semaphore's own admission microtask a turn to settle (runExclusive's fast path is sync
    // when uncontended, but await a microtask to be certain the registry entry is visible).
    await Promise.resolve();
    check("(A) a real gate held for this worker's session id → hasLiveGateForSession is true", sessions.hasLiveGateForSession(wkr) === true);

    const refused = sessions.redirectWorkerForContextInterrupt(wkr, "Your context is at ~90%...");
    check("(A) refused while the gate is live: fired:false", refused.fired === false);
    check("(A) refused: reason is gate-in-flight", refused.reason === "gate-in-flight");
    check("(A) refused: no interrupt was sent to the worker", pty.interrupts.length === 0);
    check("(A) refused: NO redirect_worker event was recorded (deliverRedirect never ran)", db.listEventsForWorker(wkr).filter((e) => e.kind === "redirect_worker").length === 0);
    check("(A) refused: the worker's queue is untouched (nothing enqueued at all)", pty.getPending(wkr).length === 0 && pty.delivered.length === 0);

    releaseGate();
    await gateRun;
    check("(A) setup: once the gate settles, hasLiveGateForSession is false again", sessions.hasLiveGateForSession(wkr) === false);

    const fired = sessions.redirectWorkerForContextInterrupt(wkr, "Your context is at ~90%...");
    check("(A) once the gate clears, the SAME call now fires", fired.fired === true);
    check("(A) fired: the worker was interrupted (held, busy)", pty.interrupts.includes(wkr));
    check("(A) fired: a redirect_worker event is now recorded", db.listEventsForWorker(wkr).filter((e) => e.kind === "redirect_worker").length === 1);
  }

  // ===================== (B) supersedeQueue:false — the worker's own queued MANAGER direction survives =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rwci-b-mgr-${sfx}`, wkr = `rwci-b-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: null });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr); // worker is mid-turn

    // The manager's own real, pre-existing direction, held because the worker is busy.
    const pre = sessions.messageWorker(mgr, wkr, "MANAGER DIRECTION — keep going on part 2");
    check("(B) setup: the manager's direction is HELD (busy worker) + persisted", pre.delivered === false);
    check("(B) setup: 1 undelivered durable message before the interrupt", db.listUndeliveredQueuedMessages().some((e) => e.detail.text.includes("MANAGER DIRECTION")));
    check("(B) setup: the manager's direction is in the worker's live queue", pty.getPending(wkr).some((t) => t.includes("MANAGER DIRECTION")));

    const r = sessions.redirectWorkerForContextInterrupt(wkr, "Your context is at ~90%, near exhaustion...");
    check("(B) the interrupt fires (held, busy worker)", r.fired === true && r.result.interrupting === true);

    // CR round 2 (card dacc6d9e): `headInsert` places the interrupt at the FRONT of the queue, and
    // `interruptForRedirect`'s own Esc→settle→drain releases only ONE sender-run (its own text) — the
    // manager's pre-existing direction is a DIFFERENT sender and so is NOT part of that same drain. It
    // must still be sitting, undelivered, in the live queue right after the interrupt's own turn settles.
    check("(B) ORDER: the interrupt's own text is delivered FIRST, as its own turn", pty.delivered.length === 1 && pty.delivered[0].text.startsWith("[loom:worker-context-interrupt:redirect]"));
    check("(B) ORDER: the manager's direction is NOT yet delivered — it's a different sender-run", !pty.delivered.some((d) => d.text.includes("MANAGER DIRECTION")));
    check("(B) ORDER: the manager's direction is still sitting in the live queue after the interrupt's own drain", pty.getPending(wkr).some((t) => t.includes("MANAGER DIRECTION")));

    // Card dacc6d9e correction 2: unlike redirectWorker's own default (supersedeQueue:true, which
    // resolves the superseded entry with reason:"superseded" and never lets its content reach the
    // worker), this interrupt never flushes/supersedes at all — nothing has resolved the manager's
    // direction yet (it hasn't drained), so there is NO delivery event of any kind for it so far.
    check("(B) SURVIVES (pre-drain): no session_message_delivered event at all yet for the manager's direction", db.listEventsForWorker(wkr).filter((e) => e.detail?.msgId === pre.msgId && e.kind === "session_message_delivered").length === 0);

    // Model the NEXT Stop-triggered drain (the manager's direction's own turn, now that the interrupt's
    // turn has settled) — this is what actually resolves it, as a PLAIN delivery, never "superseded".
    pty.drainNext(wkr);
    check("(B) ORDER: the manager's direction is now delivered SECOND, as its own separate turn", pty.delivered.length === 2 && pty.delivered[1].text.includes("MANAGER DIRECTION"));

    const preMsgEvents = db.listEventsForWorker(wkr).filter((e) => e.detail?.msgId === pre.msgId);
    check("(B) SURVIVES: the manager's direction resolves as a PLAIN delivery, never superseded", preMsgEvents.some((e) => e.kind === "session_message_delivered" && e.detail?.reason === undefined));
    check("(B) SURVIVES: no session_message_delivered/superseded marker was recorded for it", preMsgEvents.filter((e) => e.kind === "session_message_delivered" && e.detail?.reason === "superseded").length === 0);

    check("(B) the worker's queue is now drained (both turns settled)", pty.getPending(wkr).length === 0);
    check("(B) the manager's own direction reached the worker, UNCHANGED", pty.delivered.some((d) => d.id === wkr && d.text.includes("MANAGER DIRECTION")));
    check("(B) the interrupt's own bespoke-tagged text ALSO reached the worker", pty.delivered.some((d) => d.id === wkr && d.text.startsWith("[loom:worker-context-interrupt:redirect]") && d.text.includes("near exhaustion")));

    const evt = db.listEventsForWorker(wkr).filter((e) => e.kind === "redirect_worker");
    check("(B) a redirect_worker event is recorded, filed under the OWNING MANAGER", evt.length === 1 && evt[0].managerSessionId === mgr);
  }

  // ===================== (C) hasLiveGateForSession: the genuinely QUEUED branch =====================
  // CR round 2, finding 4: test (A) above only ever exercises the "running" live state (admitted
  // immediately by `runExclusive`) — it never proves the ALSO-TRUE "queued" case the original header
  // claimed. This block does: hold the cap (1) with a DIFFERENT op first, then mint a second op for the
  // worker's OWN session id that can only sit QUEUED behind it.
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rwci-c-mgr-${sfx}`, wkr = `rwci-c-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);

    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    const firstRun = sessions.gateSemaphore.runExclusive(1, { gateType: "merge", projectId: proj, sessionId: `rwci-c-other-${sfx}` }, () => firstHeld, "high");
    await Promise.resolve();

    let releaseSecond;
    const secondHeld = new Promise((resolve) => { releaseSecond = resolve; });
    const secondRun = sessions.gateSemaphore.runExclusive(1, { gateType: "worker", projectId: proj, sessionId: wkr }, () => secondHeld, "low");
    await Promise.resolve();
    check("(C) setup: the worker's own op is QUEUED (cap=1, held by a different op)", sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === wkr && e.phase === "queued"));

    check("(C) hasLiveGateForSession is TRUE while merely QUEUED (never admitted yet)", sessions.hasLiveGateForSession(wkr) === true);
    const refused = sessions.redirectWorkerForContextInterrupt(wkr, "Your context is at ~90%...");
    check("(C) refused while queued: fired:false, reason gate-in-flight", refused.fired === false && refused.reason === "gate-in-flight");

    releaseFirst();
    await firstRun; // frees the cap slot → the queued worker op is admitted and starts running `fn`
    check("(C) setup: once admitted, the worker's op now reads RUNNING", sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === wkr && e.phase === "running"));
    check("(C) still refused while RUNNING (the other live state)", sessions.redirectWorkerForContextInterrupt(wkr, "...").fired === false);

    releaseSecond();
    await secondRun;
    check("(C) once fully settled, hasLiveGateForSession is false again", sessions.hasLiveGateForSession(wkr) === false);
    check("(C) the SAME call now fires", sessions.redirectWorkerForContextInterrupt(wkr, "...").fired === true);
  }

  // ===================== (D) hasLiveGateForSession: the SQUASH-ONLY branch (CR round 2, finding 3) =====================
  // A merge that has already passed its own gate command but is still mid-squash (its `fn` called
  // `holdRepoGuardOnExit`) is deleted from the live registry `snapshot()` — invisible to it entirely —
  // and surfaces ONLY via `squashOnlySnapshot()`. Before this round's widening, `hasLiveGateForSession`
  // never consulted it.
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rwci-d-mgr-${sfx}`, wkr = `rwci-d-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);

    const repoPath = `rwci-d-repo-${sfx}`;
    const opId = `rwci-d-op-${sfx}`;
    await sessions.gateSemaphore.runExclusive(
      1, { gateType: "merge", projectId: proj, sessionId: wkr, repoPath, opId },
      async (_startedAt, _signal, _hooks, _getCap, holdRepoGuardOnExit) => { holdRepoGuardOnExit(); return "ok"; },
      "high",
    );
    check("(D) setup: the gate has settled but is now mid-squash — invisible to snapshot()", !sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === wkr));
    check("(D) setup: squashOnlySnapshot() reports it for this worker's session id", sessions.gateSemaphore.squashOnlySnapshot().some((e) => e.sessionId === wkr));

    check("(D) hasLiveGateForSession is TRUE via the squash-only branch", sessions.hasLiveGateForSession(wkr) === true);
    const refused = sessions.redirectWorkerForContextInterrupt(wkr, "Your context is at ~90%...");
    check("(D) refused while mid-squash: fired:false, reason gate-in-flight", refused.fired === false && refused.reason === "gate-in-flight");

    sessions.gateSemaphore.endSquash(repoPath, opId);
    check("(D) once the squash ends, hasLiveGateForSession is false again", sessions.hasLiveGateForSession(wkr) === false);
    check("(D) once the squash ends, the SAME call now fires", sessions.redirectWorkerForContextInterrupt(wkr, "...").fired === true);
  }

  // ===================== (E) hasLiveGateForSession: the REPO-GUARD-ONLY branch (CR round 2, finding 3) =====================
  // An inert-diff-skip / gate-interval / gate-disabled landing holds ONLY `acquireRepoGuardOnly` — it
  // never admits through the cap/registry at all, so `snapshot()`/`squashOnlySnapshot()` both miss it;
  // only `repoGuardOnlySnapshot()` sees it.
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rwci-e-mgr-${sfx}`, wkr = `rwci-e-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);

    const repoPath = `rwci-e-repo-${sfx}`;
    const opId = `rwci-e-op-${sfx}`;
    const release = await sessions.gateSemaphore.acquireRepoGuardOnly({ repoPath, opId, projectId: proj, sessionId: wkr, taskId: null, branch: null });
    check("(E) setup: repoGuardOnlySnapshot() reports a holding entry for this worker's session id", sessions.gateSemaphore.repoGuardOnlySnapshot().some((e) => e.sessionId === wkr && e.phase === "holding"));
    check("(E) setup: never admitted through the cap/registry at all", !sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === wkr));

    check("(E) hasLiveGateForSession is TRUE via the repo-guard-only branch", sessions.hasLiveGateForSession(wkr) === true);
    const refused = sessions.redirectWorkerForContextInterrupt(wkr, "Your context is at ~90%...");
    check("(E) refused while repo-guard-only held: fired:false, reason gate-in-flight", refused.fired === false && refused.reason === "gate-in-flight");

    release();
    check("(E) once released, hasLiveGateForSession is false again", sessions.hasLiveGateForSession(wkr) === false);
    check("(E) once released, the SAME call now fires", sessions.redirectWorkerForContextInterrupt(wkr, "...").fired === true);
  }

  // ===================== (F) hasLiveGateForSession: the PENDING-MERGE-CALL branch (CR round 3) =====================
  // `SessionService.peekPendingMerge(sessionId)?.state === "running"` — a `worker_merge_confirm` CALL is
  // "running" the instant it's MINTED (`PendingOpRegistry.attach()` registers the entry synchronously,
  // before `run()`'s own first `await`), well BEFORE the op ever reaches gate admission. This is the
  // fourth, independent live state `hasLiveGateForSession` reads (docs/decisions/dacc6d9e-*.md Round 2,
  // finding 3) — distinct from (A)/(C)/(D)/(E) above: it never touches `GateSemaphore` at all (no
  // snapshot/squashOnlySnapshot/repoGuardOnlySnapshot entry exists for this worker throughout), so it
  // proves this read is load-bearing on its own, not merely redundant with the other three.
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `rwci-f-mgr-${sfx}`, wkr = `rwci-f-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr);

    check("(F) setup: hasLiveGateForSession is false before any merge-confirm call", sessions.hasLiveGateForSession(wkr) === false);

    // Mint a "merge" pending op directly against the real PendingOpRegistry (the same registry
    // confirmWorkerMergeTracked attaches to, keyed `merge:${workerSessionId}`) and hold it open — never
    // reaching GateSemaphore at all, mirroring a real confirm call still in its pre-admission prep window
    // (resolveGitRef/readMainlineHead awaits, before its own `attach()`/gate call). `owner: undefined` is
    // the untyped-test permissive path (card 94725dcb) — no production caller does this.
    let releaseMerge;
    const mergeHeld = new Promise((resolve) => { releaseMerge = resolve; });
    const mergeKey = `merge:${wkr}`;
    const mergeOpPromise = sessions.pendingOps.attach(mergeKey, "merge", mgr, 10, () => mergeHeld, undefined, {}, undefined);
    await Promise.resolve(); // let attach()'s own synchronous mint (before run()'s first await) land

    check("(F) setup: the merge-confirm op is minted and RUNNING, pre-admission", sessions.pendingOps.peek(mergeKey)?.state === "running");
    check("(F) setup: peekPendingMerge sees it for this worker's own session id", sessions.peekPendingMerge(wkr)?.state === "running");
    check("(F) setup: no gate was ever touched — snapshot/squashOnlySnapshot/repoGuardOnlySnapshot are all empty for this worker",
      !sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === wkr)
      && !sessions.gateSemaphore.squashOnlySnapshot().some((e) => e.sessionId === wkr)
      && !sessions.gateSemaphore.repoGuardOnlySnapshot().some((e) => e.sessionId === wkr));

    check("(F) hasLiveGateForSession is TRUE via the pending-merge-call branch alone", sessions.hasLiveGateForSession(wkr) === true);
    const refused = sessions.redirectWorkerForContextInterrupt(wkr, "Your context is at ~90%...");
    check("(F) refused while the merge-confirm call is pre-admission: fired:false, reason gate-in-flight", refused.fired === false && refused.reason === "gate-in-flight");
    check("(F) refused: no interrupt was sent to the worker", !pty.interrupts.includes(wkr));
    check("(F) refused: NO redirect_worker event was recorded (deliverRedirect never ran)", db.listEventsForWorker(wkr).filter((e) => e.kind === "redirect_worker").length === 0);

    releaseMerge();
    await mergeOpPromise; // let the op settle so the registry entry clears and this scenario leaves nothing behind
    check("(F) once the merge-confirm call settles, hasLiveGateForSession is false again", sessions.hasLiveGateForSession(wkr) === false);
    check("(F) once settled, the SAME call now fires", sessions.redirectWorkerForContextInterrupt(wkr, "...").fired === true);
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — redirectWorkerForContextInterrupt refuses (fired:false, reason:gate-in-flight) while a real gate-in-flight condition holds for the worker's own session id — proven across all FOUR live states hasLiveGateForSession covers (running, genuinely QUEUED, squash-only, repo-guard-only — all via GateSemaphore) PLUS the independent pending-merge-call pre-admission state (via PendingOpRegistry, never touching GateSemaphore at all) — retries cleanly once each clears, and — unlike redirectWorker's own default — NEVER supersedes the worker's queue AND head-inserts ahead of it, so a pre-existing MANAGER direction survives the interrupt intact, drains strictly AFTER it as its own separate turn, and still reaches the worker unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
