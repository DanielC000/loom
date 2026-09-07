import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// PENDING-MERGE GUARD (card 0e5de8e6, origin finding: a real fleet false positive). A worker that had
// already reported `done`, been told by its manager to stand by ("nothing to do right now"), and gone
// idle while ITS OWN branch sat inside a `worker_merge_confirm` merge gate — running, healthy — was
// classified `stranded` by `classifyIdleWorker`: the manager's "stand by" `worker_message` counts as an
// ack (clears the parked-ack window), so once the worker went idle again with no FRESH report, the
// classifier fell straight through to the flat "finished a turn and did NOT call worker_report … may be
// done-but-unreported or stalled" nudge — which also recommended `worker_merge`/`worker_merge_confirm` on
// a branch that was ALREADY mid-gate. `worker_status`'s `pendingMerge` field already carried
// `{state:"running", ...}` for this exact worker at that exact moment; the watchdog simply never consulted
// it.
//
// Fix: `classifyIdleWorker` now calls `peekPendingMerge` (the SAME lineage-resolved lookup worker_status's
// `pendingMerge` field already uses) BEFORE any report-derived branch — exactly like the pre-existing
// PENDING-GATE GUARD for a worker's own `run_gate` self-check — and, when `state === "running"`, classifies
// `parked-merge` instead of falling through. Unlike `parked-gate` (fully suppressed), this is REWORDED, not
// silenced (card DoD-1): the nudge still fires, but names the real opId and says plainly that no action is
// needed, rather than recommending `worker_merge_confirm` on an already-in-flight branch.
//
// Asserts:
//   (a) THE ORIGIN INCIDENT, reproduced directly: worker reported `done`, manager replied ("stand by"),
//       worker went idle again with NO fresh report, merge gate RUNNING on its own branch → NOT classified
//       stranded; a REWORDED nudge is sent (not silence) naming the opId and "no action needed"; it does
//       NOT recommend worker_merge/worker_merge_confirm the way the old flat nudge did.
//   (b) worker NEVER reported at all, merge gate RUNNING → still `parked-merge` (not the flat "did NOT call
//       worker_report" nudge) — proves this is DAEMON-OWNED state, checked before any report-derived
//       branch, needing zero self-report cooperation (mirrors worker-idle-gate-parked.mjs case (a)).
//   (c) merge gate still QUEUED (never admitted by GateSemaphore) → STILL `parked-merge` — `state:"running"`
//       at the PendingOpRegistry level covers both queued-behind-the-cap and actually-executing (see
//       gatePhaseForOpId's own doc); the message names the queued phase rather than mislabeling it running.
//   (d) NEGATIVE CONTROL — the genuine case this watchdog exists to catch stays UNCHANGED: worker reported
//       `done`, manager replied, worker idle again, NO merge op running at all → the ORIGINAL flat stranded
//       nudge fires exactly as before this card (card DoD-3).
//   (e) merge op gone (settled + evicted, no retention) → reverts to the plain stranded nudge — the merge
//       check doesn't leak past the op's real lifecycle.
//   (f) RETENTION WINDOW: a just-settled ("done") merge op is still peek()-able briefly (MERGE_OP_RETAIN_MS)
//       — must NOT be misread as still-running/suppressed: `state` is "done", not "running", so this falls
//       through and the plain stranded nudge still fires (card DoD-2: a just-settled op is exactly the
//       moment a manager may still need to reconcile — e.g. a rejection — so it is deliberately NOT
//       suppressed here).
//
// RUN (no daemon needed): node test/worker-idle-merge-parked.mjs
//   Requires the daemon built first (reads ../dist/*.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-09-07T16:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-idle-merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `imp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `impa-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "IdleMergePark", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
    },
    getPendingEntries: () => [],
    // Card 2281009d: classifyIdleWorker also consults hasFirstTurnStarted before its broken-spawn branch —
    // this file's workers are meant to represent ones that genuinely ran (it tests the pending-merge
    // reconciliation, not broken-spawn detection), so this stubs it true unconditionally.
    hasFirstTurnStarted: () => true,
  };
  const control = new OrchestrationControl();
  const sessions = new SessionService(db, pty, control);
  return { dbFile, db, projId, agentId, alive, enqueued, sessions };
}

function seedManager(e, id) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(60), lastActivity: minutesAgo(60), lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
}
function seedWorker(e, id, parentId, taskId, { idleMin = 60 } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "worker",
    parentSessionId: parentId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
}
function seedTask(e, id, columnKey = "in_progress") {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// Registers a RUNNING "merge" op for `workerId` in PendingOpRegistry, never settling on its own (a
// dangling promise), mirroring worker-idle-gate-parked.mjs's `seedRunningGate` but under the `merge:`
// key/kind confirmWorkerMergeTracked actually uses. Also mirrors it into the LIVE GateSemaphore registry
// so `gatePhaseForOpId` can distinguish queued vs. running exactly as production does.
async function seedRunningMerge(e, workerId, managerId, { phase = "running" } = {}) {
  await e.sessions.pendingOps.attach(
    `merge:${workerId}`, "merge", managerId, 10,
    () => new Promise(() => { /* never resolves */ }),
  );
  const opId = e.sessions.pendingOps.entries.get(`merge:${workerId}`).opId;
  e.sessions.gateSemaphore.registry.set(opId, {
    id: opId,
    descriptor: { gateType: "merge", projectId: e.projId, sessionId: workerId, taskId: null, branch: null, opId },
    priority: "low",
    enqueuedAt: Date.now(),
    startedAt: phase === "running" ? Date.now() : null,
    lastOutputAt: null,
  });
  return opId;
}

// ============ (a) THE ORIGIN INCIDENT: reported done, acked ("stand by"), merge RUNNING → no stall ======
{
  const e = makeEnv();
  seedManager(e, "mgr-a");
  seedTask(e, "tk-a", "in_progress");
  seedWorker(e, "wkr-a", "mgr-a", "tk-a");
  // status "progress" (not "done"): this classifier's `active`-column reconciliation depends on the
  // project's OWN board config (a "done"/review-role mapping can move the task off the active lane —
  // see columnKeyForProjectRole), which is orthogonal to what this test is verifying. "progress" keeps
  // the task in the active lane regardless of board config, mirroring how the sibling
  // worker-idle-gate-parked.mjs test isolates the SAME ackedSince mechanism the same way.
  const r = await e.sessions.workerReport("wkr-a", { status: "progress", summary: "shipped the fix, awaiting merge" });
  check("(a setup) workerReport(progress) succeeds", r.reported === true);
  e.sessions.messageWorker("mgr-a", "wkr-a", "stand by, nothing to do right now");
  const opId = await seedRunningMerge(e, "wkr-a", "mgr-a");

  check("(a) isWorkerGenuinelyStranded is FALSE for a merge-parked worker", e.sessions.isWorkerGenuinelyStranded("wkr-a") === false);

  e.sessions.notifyManagerOfIdleWorker("wkr-a");
  const nudge = e.enqueued.find((x) => x.id === "mgr-a" && /worker-idle/.test(x.text));
  check("(a) a nudge IS sent (reworded, not silenced — card DoD-1)", !!nudge);
  check("(a) it names the real merge opId", !!nudge && nudge.text.includes(opId));
  check("(a) it says no action is needed", !!nudge && /no action needed/.test(nudge.text));
  check("(a) it does NOT claim the worker 'did NOT call worker_report'", !!nudge && !/did NOT call worker_report/.test(nudge.text));
  check("(a) it does NOT recommend worker_merge/worker_merge_confirm on the in-flight branch", !!nudge && !/worker_merge/.test(nudge.text));
  cleanup(e);
}

// ============ (b) worker NEVER reported at all, merge RUNNING → still parked-merge, no self-report =======
{
  const e = makeEnv();
  seedManager(e, "mgr-b");
  seedTask(e, "tk-b", "in_progress");
  seedWorker(e, "wkr-b", "mgr-b", "tk-b");
  const opId = await seedRunningMerge(e, "wkr-b", "mgr-b");

  check("(b) isWorkerGenuinelyStranded is FALSE even with zero self-report", e.sessions.isWorkerGenuinelyStranded("wkr-b") === false);
  e.sessions.notifyManagerOfIdleWorker("wkr-b");
  const nudge = e.enqueued.find((x) => x.id === "mgr-b" && /worker-idle/.test(x.text));
  check("(b) the reworded parked-merge nudge fires with zero self-report needed", !!nudge && nudge.text.includes(opId));
  check("(b) it does NOT fall back to the flat 'did NOT call worker_report' wording", !!nudge && !/did NOT call worker_report/.test(nudge.text));
  cleanup(e);
}

// ============ (c) merge still QUEUED (never admitted) → still parked-merge, phase reflected ==============
{
  const e = makeEnv();
  seedManager(e, "mgr-c");
  seedTask(e, "tk-c", "in_progress");
  seedWorker(e, "wkr-c", "mgr-c", "tk-c");
  const opId = await seedRunningMerge(e, "wkr-c", "mgr-c", { phase: "queued" });

  check("(c) isWorkerGenuinelyStranded is FALSE for a queued (not yet admitted) merge", e.sessions.isWorkerGenuinelyStranded("wkr-c") === false);
  e.sessions.notifyManagerOfIdleWorker("wkr-c");
  const nudge = e.enqueued.find((x) => x.id === "mgr-c" && /worker-idle/.test(x.text));
  check("(c) a reworded nudge still fires for a queued merge", !!nudge && nudge.text.includes(opId));
  check("(c) it names the queued phase rather than claiming it's running", !!nudge && /queued/.test(nudge.text));
  cleanup(e);
}

// ============ (d) NEGATIVE CONTROL — same shape as (a) but NO merge op at all → genuine stall unchanged ===
// Card DoD-3: the fix must not weaken the case this watchdog exists to catch. Same report/ack sequence as
// (a), but with no pendingMerge — the ORIGINAL flat stranded nudge must fire exactly as before this card.
{
  const e = makeEnv();
  seedManager(e, "mgr-d");
  seedTask(e, "tk-d", "in_progress");
  seedWorker(e, "wkr-d", "mgr-d", "tk-d");
  const r = await e.sessions.workerReport("wkr-d", { status: "progress", summary: "shipped the fix, awaiting merge" });
  check("(d setup) workerReport(progress) succeeds", r.reported === true);
  e.sessions.messageWorker("mgr-d", "wkr-d", "stand by, nothing to do right now");
  // No seedRunningMerge call — this is the genuine acked-then-stalled-again shape with NOTHING pending.

  check("(d) isWorkerGenuinelyStranded is TRUE with no pending merge — the genuine case is unaffected", e.sessions.isWorkerGenuinelyStranded("wkr-d") === true);
  e.sessions.notifyManagerOfIdleWorker("wkr-d");
  const nudge = e.enqueued.find((x) => x.id === "mgr-d" && /worker-idle/.test(x.text));
  check("(d) the ORIGINAL flat stranded nudge fires, unchanged", !!nudge && /did NOT call worker_report/.test(nudge.text));
  cleanup(e);
}

// ============ (e) merge op gone (settled/evicted, no retention) → reverts to plain stranded ==============
{
  const e = makeEnv();
  seedManager(e, "mgr-e");
  seedTask(e, "tk-e", "in_progress");
  seedWorker(e, "wkr-e", "mgr-e", "tk-e");
  await seedRunningMerge(e, "wkr-e", "mgr-e");
  check("(e setup) the merge op is registered as running", e.sessions.pendingOps.peek("merge:wkr-e")?.state === "running");
  e.sessions.pendingOps.entries.delete("merge:wkr-e");
  check("(e setup) peek() now finds nothing", e.sessions.pendingOps.peek("merge:wkr-e") === undefined);

  check("(e) isWorkerGenuinelyStranded reverts to TRUE once the merge op is gone", e.sessions.isWorkerGenuinelyStranded("wkr-e") === true);
  e.sessions.notifyManagerOfIdleWorker("wkr-e");
  const nudge = e.enqueued.find((x) => x.id === "mgr-e" && /worker-idle/.test(x.text));
  check("(e) the ORIGINAL stranded nudge fires once there's no pending merge left to explain the idle state",
    !!nudge && /did NOT call worker_report/.test(nudge.text));
  cleanup(e);
}

// ============ (f) RETENTION WINDOW: a just-settled ("done") merge must NOT read as still-running =========
// Card DoD-2: a just-settled op is deliberately NOT suppressed — it's exactly the moment a manager may need
// to reconcile (e.g. a rejection). Mirrors worker-idle-gate-parked.mjs case (e), driving a GENUINE settle
// (via retainMs) rather than a manual entries.delete, so PendingOpRegistry itself populates the retained
// view exactly as confirmWorkerMergeTracked does in production.
{
  const e = makeEnv();
  seedManager(e, "mgr-f");
  seedTask(e, "tk-f", "in_progress");
  seedWorker(e, "wkr-f", "mgr-f", "tk-f");

  const key = "merge:wkr-f";
  await e.sessions.pendingOps.attach(
    key, "merge", "mgr-f", 500,
    async () => ({ merged: true }),
    undefined,
    { retainMs: 5_000, classifyOutcome: (o) => (!o.ok ? "failed" : o.value.merged ? "merged" : "rejected") },
  );
  const retained = e.sessions.pendingOps.peek(key);
  check("(f setup) the settled op is still peek()-able (retained, not evicted like (e))", !!retained);
  check("(f setup) the retained view's state is NOT \"running\"", !!retained && retained.state !== "running");

  check("(f) isWorkerGenuinelyStranded reverts to TRUE — a retained (settled) merge is never mistaken for a running one",
    e.sessions.isWorkerGenuinelyStranded("wkr-f") === true);
  e.sessions.notifyManagerOfIdleWorker("wkr-f");
  const nudge = e.enqueued.find((x) => x.id === "mgr-f" && /worker-idle/.test(x.text));
  check("(f) the ORIGINAL stranded nudge fires — a just-settled merge is deliberately NOT suppressed (card DoD-2)",
    !!nudge && /did NOT call worker_report/.test(nudge.text));
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a worker parked because ITS OWN branch is inside a manager-initiated merge gate is auto-classified straight from PendingOpRegistry (the same lookup worker_status's pendingMerge already uses); the origin incident (reported+acked+merge-running, misclassified stranded) is fixed with a REWORDED nudge, not silence; it needs zero self-report cooperation and correctly names a queued phase; the genuine no-merge stalled case is completely unaffected; and classification correctly reverts to plain stranded once the merge op is actually gone or has just settled (deliberately not suppressed, unlike the gate case)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
