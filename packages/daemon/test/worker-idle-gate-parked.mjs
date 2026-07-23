import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// PENDING-GATE GUARD (card 8e0bd254, origin finding a4bfe6d9): a worker parked on its OWN `run_gate`
// call used to be classifiable ONLY via a self-reported `worker_report({awaiting:"background"})` flag
// (card c36bac53) — but a worker that goes idle on a pending gate WITHOUT ever calling worker_report
// first (the common case: run_gate degrades to {status:"pending"} and the worker's turn just ends) got
// NO such flag, so classifyIdleWorker fell through to the flat "did NOT call worker_report … may be
// stalled" nudge — a false alarm observed ~4-5 times per gate-running worker across three separate
// orchestrator transcripts (see the card body). Prior patches (ab21da21, 1c95a89b, cf94e19) only fixed
// the wording for the self-report half; the false alarms continued because most gate parks never carry
// the flag in the first place.
//
// Fix: a pending `run_gate` is a DAEMON-OWNED op, directly observable via
// `PendingOpRegistry.peek(\`gate:${workerSessionId}\`)` — classifyIdleWorker now consults it BEFORE any
// report-derived branch, so it classifies correctly with ZERO self-report. Fresh (started under
// BACKGROUND_PARK_STALE_MINUTES ago) suppresses the manager nudge ENTIRELY — no manager turn burned.
// Stale (the gate has been "running" longer than a real gate plausibly takes) escalates to an
// actionable nudge, mirroring parked-background-stale's decay shape.
//
// This test drives the REAL sessions.pendingOps (SessionService's own PendingOpRegistry instance, a
// plain class field — no mock) directly, mirroring worker-run-gate.mjs case (E)'s technique of talking
// to PendingOpRegistry.attach() straight, rather than waiting out the real 12s SYNC_ATTACH_BUDGET_MS via
// runWorkerGate itself.
//
// CARD 865c528e (p1 follow-up): the staleness check above originally measured elapsed time off
// PendingOpRegistry's own `startedAt` — op REGISTRATION time (when `run_gate` was CALLED) — and compared
// it against a threshold calibrated to real gate RUN time. Those are different clocks: a gate queued
// behind the daemon-global GateSemaphore cap accrues registration-time elapsed unboundedly while genuinely
// executing for zero seconds, so a busy fleet could misclassify a perfectly healthy queued gate as wedged
// and recommend `worker_stop`/`worker_recycle` on it. Fixed by reading the LIVE GateSemaphore registry (by
// the op's own `opId`, the same lookup `gate_status` uses) to get the real phase and, for a RUNNING
// (admitted) gate, its true admission timestamp — see (c2) below for the queued-never-stale case this adds.
//
// Asserts:
//   (a) a FRESH pending gate, worker NEVER called worker_report at all → NO nudge (was: false "did NOT
//       call worker_report" alarm) and isWorkerGenuinelyStranded() is FALSE.
//   (b) a FRESH pending gate even when the worker DID call worker_report(progress) with no `awaiting`
//       flag → STILL no nudge (the structural signal wins over/needs no self-report at all).
//   (c) a STALE pending gate — genuinely ADMITTED (running) > BACKGROUND_PARK_STALE_MINUTES ago — → a
//       nudge IS sent, names the staleness, points at worker_transcript, and does NOT claim "no reply
//       owed" or "awaiting your reply" (neither is known to be true for a possibly-wedged gate).
//   (c2) a QUEUED (never admitted) gate, however long it's been queued → NO nudge, ever — the origin bug
//       this card fixes, reproduced directly.
//   (d) once the gate op is gone (settled/evicted) with no report on record, classification correctly
//       reverts to the ORIGINAL stranded nudge — the gate check doesn't leak past the op's real lifecycle.
//   (e) card 50c1e0d0's settle-grace RETENTION window (still peek()-able briefly after settle, unlike (d)'s
//       plain eviction) must NOT be misread as still-running: a retained view's `state` is "done"/"failed",
//       so the PENDING-GATE GUARD (which only ever matches `state === "running"`) correctly falls through
//       and the ORIGINAL stranded nudge still fires — the retention window can't suppress a nudge the
//       manager should get by making a just-settled gate look like it's still in flight.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-07-22T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-idle-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `igp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `igpa-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "IdleGatePark", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
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
  };
  const control = new OrchestrationControl();
  const sessions = new SessionService(db, pty, control);
  return { dbFile, db, projId, agentId, alive, enqueued, sessions };
}

function seedManager(e, id, { idleMin = 60 } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "manager",
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

// Registers a RUNNING "gate" op for `workerId` in PendingOpRegistry, never settling on its own (a
// dangling promise — no timer, so it can't keep the test process alive). Mirrors worker-run-gate.mjs
// case (E)'s direct-attach technique. `attach`'s own waitMs is short so this call itself resolves
// quickly (it just degrades to {settled:false}), leaving the entry installed in the registry's
// `entries` map for peek() to find.
//
// ALSO mirrors the op into the LIVE GateSemaphore registry (card 865c528e) — the real `runWorkerGate`
// always registers both (PendingOpRegistry via `attach`, GateSemaphore via `runExclusive`); this test
// drives them directly rather than waiting out a real gate command. `phase` controls whether the
// semaphore entry is ADMITTED ("running", `startedAt` stamped now) or still QUEUED ("queued",
// `startedAt` stays null) — the exact distinction classifyIdleWorker's fix reads to tell a genuinely
// wedged gate apart from an unbounded, perfectly healthy queue wait.
async function seedRunningGate(e, workerId, { phase = "running" } = {}) {
  await e.sessions.pendingOps.attach(
    `gate:${workerId}`, "gate", workerId, 10,
    () => new Promise(() => { /* never resolves */ }),
  );
  const opId = e.sessions.pendingOps.entries.get(`gate:${workerId}`).opId;
  e.sessions.gateSemaphore.registry.set(opId, {
    id: opId,
    descriptor: { gateType: "worker", projectId: e.projId, sessionId: workerId, taskId: null, branch: null, opId },
    priority: "low",
    enqueuedAt: Date.now(),
    startedAt: phase === "running" ? Date.now() : null,
  });
  return opId;
}

// ============ (a) FRESH pending gate, worker NEVER reported at all → NO nudge ============
{
  const e = makeEnv();
  seedManager(e, "mgr-a");
  seedTask(e, "tk-a", "in_progress");
  seedWorker(e, "wkr-a", "mgr-a", "tk-a", { idleMin: 60 });
  await seedRunningGate(e, "wkr-a");

  check("(a) isWorkerGenuinelyStranded is FALSE for a gate-parked worker", e.sessions.isWorkerGenuinelyStranded("wkr-a") === false);

  e.sessions.notifyManagerOfIdleWorker("wkr-a");
  check("(a) NO nudge at all is sent to the manager (not even a queued one) — zero manager turns burned",
    !e.enqueued.some((x) => x.id === "mgr-a"));
  cleanup(e);
}

// ============ (b) FRESH pending gate, worker DID call worker_report(progress) with no `awaiting` =======
// Proves the structural fix needs no self-report cooperation at all — the OLD flat "did NOT call
// worker_report" nudge doesn't fire (that's covered by (a)), but neither does the parked-ack "awaiting
// your reply" nudge a bare progress report would normally draw (worker-idle-background-park.mjs case 1).
{
  const e = makeEnv();
  seedManager(e, "mgr-b");
  seedTask(e, "tk-b", "in_progress");
  seedWorker(e, "wkr-b", "mgr-b", "tk-b", { idleMin: 60 });
  const r = await e.sessions.workerReport("wkr-b", { status: "progress", summary: "started the gate, ending my turn" });
  check("(b setup) workerReport succeeds", r.reported === true);
  await seedRunningGate(e, "wkr-b");

  e.sessions.notifyManagerOfIdleWorker("wkr-b");
  check("(b) the pending-gate signal wins over the plain progress report — still NO nudge",
    !e.enqueued.some((x) => x.id === "mgr-b" && /worker-idle/.test(x.text)));
  cleanup(e);
}

// ============ (c) STALE pending gate — ADMITTED (running) > BACKGROUND_PARK_STALE_MINUTES ago → nudge ===
{
  const e = makeEnv();
  seedManager(e, "mgr-c");
  seedTask(e, "tk-c", "in_progress");
  seedWorker(e, "wkr-c", "mgr-c", "tk-c", { idleMin: 60 });
  const opId = await seedRunningGate(e, "wkr-c", { phase: "running" });
  // Backdate the LIVE GATESEMAPHORE entry's admission `startedAt` (card 865c528e fix target) — NOT
  // PendingOpRegistry's own `startedAt`, which is registration time and must play no part in staleness
  // any more. classifyIdleWorker computes staleness off the REAL wall clock (Date.now()), not this
  // file's fixed NOW constant (which only paces seedManager/seedWorker's lastActivity fields) — so the
  // backdate must be relative to the real clock too, or the offset (and thus which side of the 20-min
  // bound it lands on) would depend on how far NOW happens to drift from whenever this test actually runs.
  e.sessions.gateSemaphore.registry.get(opId).startedAt = Date.now() - 25 * 60_000;

  e.sessions.notifyManagerOfIdleWorker("wkr-c");
  const nudge = e.enqueued.find((x) => x.id === "mgr-c" && /worker-idle/.test(x.text));
  check("(c) a [loom:worker-idle] nudge IS sent for a genuinely stale (admitted, still running) gate park", !!nudge);
  check("(c) it names the staleness (~N min) and the run_gate op", !!nudge && /run_gate/.test(nudge.text) && /min/.test(nudge.text));
  check("(c) it points at worker_transcript to check what actually happened", !!nudge && /worker_transcript/.test(nudge.text));
  check("(c) it does NOT falsely promise 'no reply owed'", !!nudge && !/no reply owed/.test(nudge.text));
  check("(c) it does NOT falsely claim 'awaiting your reply' either", !!nudge && !/awaiting your reply/.test(nudge.text));
  cleanup(e);
}

// ============ (c2) QUEUED (never admitted) gate, way past the threshold → NO nudge (card 865c528e) =======
// This is the origin bug, reproduced directly: a gate that has been QUEUED behind the daemon-global
// GateSemaphore cap for far longer than BACKGROUND_PARK_STALE_MINUTES — but never actually ADMITTED, so
// zero seconds of real gate runtime have elapsed — must NEVER read as wedged. Before the fix, this
// classified purely off PendingOpRegistry's own (registration-time) `startedAt`, which is set the moment
// `run_gate` is called regardless of admission — so an op queued this long would have falsely tripped
// `parked-gate-stale` and recommended `worker_stop`/`worker_recycle` on a perfectly healthy queued gate.
{
  const e = makeEnv();
  seedManager(e, "mgr-c2");
  seedTask(e, "tk-c2", "in_progress");
  seedWorker(e, "wkr-c2", "mgr-c2", "tk-c2", { idleMin: 60 });
  const opId = await seedRunningGate(e, "wkr-c2", { phase: "queued" });
  // Backdate BOTH clocks together, mirroring how they'd actually drift in production: PendingOpRegistry's
  // own `startedAt` (registration — stamped the instant `run_gate` was CALLED) and the semaphore's
  // `enqueuedAt` (queue entry — stamped moments later, same call). Backdating ONLY `enqueuedAt` would
  // pass even under the OLD buggy code by accident (its registration-time clock would still read
  // "just now" and never trip the threshold) — this reproduces the real bug: a long-registered,
  // never-admitted op. This op has NEVER been admitted — `startedAt` stays null throughout.
  e.sessions.pendingOps.entries.get("gate:wkr-c2").startedAt = new Date(Date.now() - 40 * 60_000).toISOString();
  e.sessions.gateSemaphore.registry.get(opId).enqueuedAt = Date.now() - 40 * 60_000;

  check("(c2) isWorkerGenuinelyStranded is FALSE for a queued (not yet admitted) gate, no matter how long queued",
    e.sessions.isWorkerGenuinelyStranded("wkr-c2") === false);
  e.sessions.notifyManagerOfIdleWorker("wkr-c2");
  check("(c2) NO nudge at all is sent — a queued gate must never be misread as wedged/stale",
    !e.enqueued.some((x) => x.id === "mgr-c2"));
  cleanup(e);
}

// ============ (d) gate op gone (settled/evicted), no report on record → reverts to plain stranded ======
{
  const e = makeEnv();
  seedManager(e, "mgr-d");
  seedTask(e, "tk-d", "in_progress");
  seedWorker(e, "wkr-d", "mgr-d", "tk-d", { idleMin: 60 });
  await seedRunningGate(e, "wkr-d");
  check("(d setup) the gate op is registered as running", e.sessions.pendingOps.peek("gate:wkr-d")?.state === "running");
  // Simulate the op having settled and been evicted (PendingOpRegistry's evict-on-settle — see its class
  // doc) with NO retained view either — this test's own seedRunningGate() drives a manual attach() call
  // that (unlike the real runWorkerGate, which passes retainMs as of card 50c1e0d0) never opts into
  // retention, so a direct `entries.delete` here fully clears this key exactly as a real settle would.
  e.sessions.pendingOps.entries.delete("gate:wkr-d");
  check("(d setup) peek() now finds nothing", e.sessions.pendingOps.peek("gate:wkr-d") === undefined);

  check("(d) isWorkerGenuinelyStranded reverts to TRUE once the gate op is gone", e.sessions.isWorkerGenuinelyStranded("wkr-d") === true);
  e.sessions.notifyManagerOfIdleWorker("wkr-d");
  const nudge = e.enqueued.find((x) => x.id === "mgr-d" && /worker-idle/.test(x.text));
  check("(d) the ORIGINAL stranded nudge fires once there's no pending gate left to explain the idle state",
    !!nudge && /did NOT call worker_report/.test(nudge.text));
  cleanup(e);
}

// ============ (e) RETENTION WINDOW: a just-settled (retained) gate op must NOT read as still-running =====
{
  const e = makeEnv();
  seedManager(e, "mgr-e");
  seedTask(e, "tk-e", "in_progress");
  seedWorker(e, "wkr-e", "mgr-e", "tk-e", { idleMin: 60 });

  // Mirrors the REAL runWorkerGate wiring (retainMs + classifyOutcome) — unlike (d)'s manual
  // entries.delete, this drives the op through a GENUINE settle so PendingOpRegistry itself populates
  // the retained cache exactly as production code does.
  const key = "gate:wkr-e";
  await e.sessions.pendingOps.attach(
    key, "gate", "wkr-e", 500,
    async () => ({ ran: true, passed: true }),
    undefined,
    { retainMs: 5_000, classifyOutcome: (o) => (!o.ok ? "errored" : o.value.passed ? "passed" : "failed") },
  );
  const retained = e.sessions.pendingOps.peek(key);
  check("(e setup) the settled op is still peek()-able (retained, not evicted like (d))", !!retained);
  check("(e setup) the retained view's state is NOT \"running\"", !!retained && retained.state !== "running");

  check("(e) isWorkerGenuinelyStranded reverts to TRUE — a retained (settled) gate is never mistaken for a running one",
    e.sessions.isWorkerGenuinelyStranded("wkr-e") === true);
  e.sessions.notifyManagerOfIdleWorker("wkr-e");
  const nudge = e.enqueued.find((x) => x.id === "mgr-e" && /worker-idle/.test(x.text));
  check("(e) the ORIGINAL stranded nudge fires — the retention window does NOT suppress it as still-parked",
    !!nudge && /did NOT call worker_report/.test(nudge.text));
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a worker parked on its OWN pending run_gate is auto-classified straight from PendingOpRegistry with zero self-report; a fresh gate park costs its manager no nudge at all; a stale one escalates with honest wording; classification correctly reverts to plain stranded once the gate op is actually gone; and card 50c1e0d0's settle-grace retention window never makes a just-settled gate misread as still-parked."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
