import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5f3a394e: `runWorkerGate`'s `onSettledAfterPending` callback (and `confirmWorkerMergeTracked`'s own
// rejection path) compose the `[loom:deferred-trigger]` advisory appendix ONCE, as part of a one-shot
// completion nudge — see `deferred-trigger-nudge.mjs` for that push proven end to end. If the daemon
// crashes in the async gap between the op's tombstone settling and that nudge being enqueued (the window
// `deferredTriggerNotice`'s own doc + card `c4b70fe8` describe), the push is lost with no replay.
//
// DoD-1 of card 5f3a394e established this genuinely IS a defect, not a convenience layered on an
// independently self-resolving mechanism: `Task.deferredUntilEvent` NEVER auto-clears and carries no
// read-time re-resolution of its own anywhere in `tasks_get`/`tasks_list` (see that field's own doc,
// shared/src/types.ts) — `deferredTriggerNotice` (orchestration/deferred-trigger-notice.ts) is the ONLY
// code that ever joins a task's `deferredUntilEvent` against a gate run's `failedNames`.
//
// THE FIX (DoD-2): `gate_status` (mcp/orchestration.ts's `registerGateStatus`) now RECOMPUTES this SAME
// advisory at READ time, alongside its existing best-effort `timingBand` join — never fabricated, never
// able to fail the call, and (this is the point) NEVER DEPENDENT on the one-shot push having fired at
// all. `readFailedNamesForOp` reads the SAME durable gate-timing NDJSON the push itself reads, keyed only
// by opId, so it survives a daemon restart exactly like the tombstone's own persisted verdict does (card
// `4c5bf820`).
//
// This file never drives a real gate/merge execution and never composes or reads a completion nudge at
// all — it writes the durable tombstone (`Db.insertPendingGateOp`/`settlePendingGateOp`) and the durable
// gate-timing NDJSON row DIRECTLY, the same two artifacts a real crash-mid-settle would leave behind with
// the nudge never having been enqueued, then calls the REAL `gate_status` MCP TOOL (not the bare service
// method — the fix lives in the MCP layer, not `SessionService.gateStatus`) and proves the advisory is
// there anyway. Mirrors `gate-status-cross-project-redaction.mjs`'s harness (`OrchestrationMcpRouter`,
// `buildServer(...)._registeredTools["gate_status"].handler(...)`) exactly.
//
// Proves:
//   (1) RED-FIRST: with no matching `deferredUntilEvent` task yet, a settled FAIL op's `gate_status` reply
//       carries no `deferredTriggerNotice` at all.
//   (2) GREEN, NO NUDGE EVER FIRED: after a task on the SAME project annotates itself
//       `deferredUntilEvent:{kind:"gate-fail-naming"}` naming this run's own failed file — recorded
//       DIRECTLY via `updateTask`, never via any nudge-composition code path — the SAME `gate_status`
//       call now carries `deferredTriggerNotice`, with the real card id and file name, and the same
//       pointer/deadline wording the live nudge uses.
//   (3) READ-TIME, NOT SETTLE-TIME: the task's annotation is added AFTER the op already settled, and the
//       SAME opId is read twice — proving this isn't a value cached/computed once at settle and replayed,
//       it is re-derived fresh on every call against the board's CURRENT state.
//   (4) FAIL-ONLY: a PASSING settled op with an (unrealistic, deliberately adversarial) NDJSON row naming
//       a "failed" file never surfaces the advisory — the `result.passed === false` gate, not the mere
//       presence of a `failedNames`-bearing NDJSON row, is what controls this.
//   (5) CROSS-PROJECT: a foreign manager reading another project's failed op gets NO
//       `deferredTriggerNotice` — never even computed, same posture as `timingBand`.
//   (6) WORKER SURFACE: the scoped worker `gate_status` tool (a worker's own `run_gate` self-check) gets
//       the identical recomputed advisory, not just the manager's.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-status-deferred-trigger.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond, diagnostic) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diagnostic) console.log(`  actual: ${diagnostic()}`); }
};

const tmpHome = path.join(os.tmpdir(), `loom-gst-dtrig-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { GATE_TIMING_NDJSON_PATH } = await import("../dist/orchestration/gate-timing-band.js");

const dbFile = path.join(tmpHome, "gst-dtrig.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

// Writes a real `run-summary` NDJSON row DIRECTLY — the durable artifact a real gate spawn writes via
// test-daemon.mjs, and the ONLY thing `readFailedNamesForOp` ever reads. No nudge-composition code is
// ever invoked to produce this row.
function writeRunSummary(opId, failedNames) {
  fs.mkdirSync(path.dirname(GATE_TIMING_NDJSON_PATH), { recursive: true });
  const row = { kind: "run-summary", opId, poolSize: 1, testCount: 1, executedCount: 1, failedCount: failedNames.length, durationMs: 5, failedNames };
  fs.appendFileSync(GATE_TIMING_NDJSON_PATH, JSON.stringify(row) + "\n");
}

try {
  const sessions = new SessionService(
    db,
    { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null },
    new OrchestrationControl(),
    {},
  );
  const router = new OrchestrationMcpRouter(db, sessions);

  db.insertProject({ id: "pA", name: "Project A", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pB", name: "Project B", repoPath: "pB", vaultPath: "pB", config: {}, archivedAt: null, createdAt: now });
  db.insertAgent({ id: "aA", projectId: "pA", name: "Mgr A", startupPrompt: "MGR", position: 0 });
  db.insertAgent({ id: "aB", projectId: "pB", name: "Mgr B", startupPrompt: "MGR", position: 0 });
  db.insertSession({ id: "mgrA", projectId: "pA", agentId: "aA", engineSessionId: null, title: null, cwd: "pA", processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: "mgrB", projectId: "pB", agentId: "aB", engineSessionId: null, title: null, cwd: "pB", processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const workerTaskId = randomUUID();
  db.insertTask({ id: workerTaskId, projectId: "pA", title: "GST-DTRIG-WORKER-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: "wkrA", projectId: "pA", agentId: "aA", engineSessionId: null, title: null, cwd: "pA", processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrA", taskId: workerTaskId });

  const serverA = router.buildServer("mgrA", "manager");
  const serverB = router.buildServer("mgrB", "manager");
  const workerServerA = router.buildServer("wkrA", "worker");
  const callGateStatusAs = async (server, opId) => JSON.parse((await server._registeredTools["gate_status"].handler({ opId })).content[0].text);

  // ── (1)-(3) settled FAIL op, NDJSON row present, NO nudge ever composed ────────────────────────────────
  const failOpId = "33333333-0000-4000-8000-000000000fa1";
  db.insertPendingGateOp({ opId: failOpId, kind: "gate", key: "k-dtrig-fail", ownerSessionId: "wkrA", projectId: "pA", taskId: workerTaskId, branch: "loom/dtrig", startedAt: now, state: "pending", surfacedPending: true });
  db.settlePendingGateOp(failOpId, { kind: "fail", payload: { reason: "gate did not pass", gateDetail: { phase: "test", exitCode: 1, signal: null, timedOut: false } } });
  writeRunSummary(failOpId, ["widget.spec.js"]);

  const beforeAnnotation = await callGateStatusAs(serverA, failOpId);
  check("(1, RED-FIRST) settled fail op resolves, no deferredTriggerNotice yet (no matching task exists)",
    beforeAnnotation.state === "settled" && beforeAnnotation.passed === false && beforeAnnotation.deferredTriggerNotice === undefined,
    () => JSON.stringify({ state: beforeAnnotation.state, passed: beforeAnnotation.passed, deferredTriggerNotice: beforeAnnotation.deferredTriggerNotice }));

  const deferredTaskId = randomUUID();
  db.insertTask({ id: deferredTaskId, projectId: "pA", title: "watching for widget.spec.js to fail again", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now, deferred: true, deferredReason: "parked on this exact gate-fail event resurfacing" });
  // Recorded DIRECTLY — never through any nudge-composition code path, and strictly AFTER the op above
  // already settled, proving (3): this isn't a value frozen at settle time.
  db.updateTask(deferredTaskId, { deferredUntilEvent: { kind: "gate-fail-naming", key: "widget.spec.js" } });

  const afterAnnotation = await callGateStatusAs(serverA, failOpId);
  check("(2, GREEN, NO NUDGE) the SAME opId now carries deferredTriggerNotice — recomputed at read time, no nudge ever pushed",
    typeof afterAnnotation.deferredTriggerNotice === "string" && afterAnnotation.deferredTriggerNotice.length > 0,
    () => JSON.stringify(afterAnnotation.deferredTriggerNotice));
  check("(2) it names the real failed file (from the REAL run-summary.failedNames, not a stub)",
    afterAnnotation.deferredTriggerNotice?.includes("this red names widget.spec.js"));
  check("(2) it names the matching card's real id", afterAnnotation.deferredTriggerNotice?.includes(deferredTaskId));
  check("(2) it carries the required pointer+deadline wording", afterAnnotation.deferredTriggerNotice?.includes("not itself a specimen") && afterAnnotation.deferredTriggerNotice?.includes("~20 min"));
  check("(3, READ-TIME) a second, independent read of the SAME opId agrees — genuinely re-derived, not a one-shot side effect of the first call",
    (await callGateStatusAs(serverA, failOpId)).deferredTriggerNotice === afterAnnotation.deferredTriggerNotice);

  // ── (4) FAIL-ONLY — a PASSING op with an adversarial NDJSON row never surfaces the advisory ────────────
  const passOpId = "33333333-0000-4000-8000-000000000fa2";
  db.insertPendingGateOp({ opId: passOpId, kind: "gate", key: "k-dtrig-pass", ownerSessionId: "wkrA", projectId: "pA", taskId: workerTaskId, branch: "loom/dtrig", startedAt: now, state: "pending", surfacedPending: true });
  db.settlePendingGateOp(passOpId, { kind: "pass", payload: {} });
  // Adversarial: names the SAME file the deferred task above watches for, on a PASS verdict — proves the
  // gate is `result.passed === false`, not merely "an NDJSON row with failedNames exists".
  writeRunSummary(passOpId, ["widget.spec.js"]);
  const passResult = await callGateStatusAs(serverA, passOpId);
  check("(4, FAIL-ONLY) a passing op never carries the advisory even when its own NDJSON row names a watched file",
    passResult.state === "settled" && passResult.passed === true && passResult.deferredTriggerNotice === undefined,
    () => JSON.stringify({ passed: passResult.passed, deferredTriggerNotice: passResult.deferredTriggerNotice }));

  // ── (5) CROSS-PROJECT — a foreign manager gets no advisory at all for project A's failed op ────────────
  const foreignFail = await callGateStatusAs(serverB, failOpId);
  check("(5, precondition) the op is still resolvable at all cross-project (genuinely unscoped for a manager)", foreignFail.state === "settled");
  check("(5, CROSS-PROJECT) deferredTriggerNotice is absent for a foreign project's manager — never even computed",
    foreignFail.deferredTriggerNotice === undefined, () => JSON.stringify(foreignFail.deferredTriggerNotice));

  // ── (6) WORKER SURFACE — the scoped worker gate_status tool gets the identical recomputed advisory ─────
  const workerFail = await callGateStatusAs(workerServerA, failOpId);
  check("(6, WORKER SURFACE) the worker's own scoped gate_status ALSO carries the recomputed advisory",
    workerFail.deferredTriggerNotice === afterAnnotation.deferredTriggerNotice,
    () => JSON.stringify(workerFail.deferredTriggerNotice));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — gate_status recomputes the [loom:deferred-trigger] advisory at READ time from the durable gate-timing NDJSON + the board's CURRENT deferredUntilEvent state, independent of whether the one-shot completion nudge (which composes the identical text) ever fired — proven RED-first (no notice before the annotation exists), GREEN with no nudge ever pushed, re-derived (not cached) across repeated reads and across the annotation being added strictly after settle, gated to real failures only (a passing op with an adversarial matching NDJSON row stays silent), redacted (never computed) cross-project, and identical on the worker's own scoped surface."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
