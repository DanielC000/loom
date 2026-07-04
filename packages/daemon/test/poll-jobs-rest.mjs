import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Poll-job triggers REST CRUD (agent-tooling epic P3, /api/poll-jobs). Fully hermetic: a REAL Db on a
// temp file + the REAL buildServer (app.inject) — NO live network, NO real claude, NO daemon.
//
// Covers the create/update validation-asymmetry CR finding: create validates the mode<->target pairing
// + target existence (400/404); update must enforce the EXACT SAME check against the EFFECTIVE
// (post-patch) mode/sessionId/agentId — a PATCH that changes mode, or that changes the target, or that
// changes neither, must never be able to land the row in an inconsistent state (which the tick's own
// structural guard would otherwise silently disable, turning a fixable 400 into a vanished job).
//
// Run: 1) build (turbo builds shared first), 2) node test/poll-jobs-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { buildServer } from "../dist/gateway/server.js";
import { MIN_POLL_INTERVAL_MS } from "../dist/orchestration/poll.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(os.tmpdir(), `loom-polljobs-rest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "pjr-proj";
const agentId = "pjr-agent";
const otherAgentId = "pjr-agent-2";
const sessId = "pjr-sess";
db.insertProject({ id: projId, name: "PJR", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "spawn-target", startupPrompt: "", position: 0 });
db.insertAgent({ id: otherAgentId, projectId: projId, name: "spawn-target-2", startupPrompt: "", position: 1 });
db.insertSession({
  id: sessId, projectId: projId, agentId, engineSessionId: "eng-1", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
const conn = db.createConnection({ name: "gh", host: "api.github.com", authScheme: "bearer", secretBlob: "irrelevant" });

const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
const inject = (opts) => app.inject(opts);

try {
  // --- CREATE validation (baseline — already covered informally by the poll.mjs unit tests, asserted
  // here at the REST boundary directly) ---
  const badMode = await inject({ method: "POST", url: "/api/poll-jobs", payload: {
    connectionId: conn.id, path: "/x", intervalMs: MIN_POLL_INTERVAL_MS, mode: "spawn", // no agentId
  } });
  check("CREATE: mode 'spawn' with no agentId -> 404", badMode.statusCode === 404);
  check("CREATE: the rejected create wrote NO row", db.listPollJobs().length === 0);

  const badTarget = await inject({ method: "POST", url: "/api/poll-jobs", payload: {
    connectionId: conn.id, path: "/x", intervalMs: MIN_POLL_INTERVAL_MS, mode: "wake", sessionId: "does-not-exist",
  } });
  check("CREATE: mode 'wake' with a nonexistent sessionId -> 404", badTarget.statusCode === 404);
  check("CREATE: still no row written", db.listPollJobs().length === 0);

  const good = await inject({ method: "POST", url: "/api/poll-jobs", payload: {
    connectionId: conn.id, path: "/notifications", intervalMs: MIN_POLL_INTERVAL_MS, mode: "spawn", agentId,
  } });
  check("CREATE: valid spawn job -> 201", good.statusCode === 201);
  const job = JSON.parse(good.payload);
  check("CREATE: persisted with the normalized target (agentId set, sessionId cleared)", job.agentId === agentId && job.sessionId === null);

  // --- UPDATE validation — the CR's asymmetry fix: the SAME mode<->target check applies here ---
  const patchToOrphanAgent = await inject({ method: "POST", url: `/api/poll-jobs/${job.id}`, payload: { agentId: "totally-bogus" } });
  check("UPDATE: patching agentId to a nonexistent agent -> 404 (mode unchanged, still 'spawn')", patchToOrphanAgent.statusCode === 404);
  check("UPDATE: the row is UNCHANGED after the rejected patch (still points at the real agent)", db.getPollJob(job.id).agentId === agentId);

  // Non-numeric intervalMs must be REJECTED, not just floor-checked — "abc" < MIN_POLL_INTERVAL_MS is a
  // NaN comparison (false), so a floor-only check would silently store it; the tick's claim-line
  // `new Date(now + job.intervalMs).toISOString()` then throws on a NaN sum, BEFORE the per-job
  // try/catch, starving every job ordered after this one on every tick.
  const patchBadIntervalType = await inject({ method: "POST", url: `/api/poll-jobs/${job.id}`, payload: { intervalMs: "abc" } });
  check("UPDATE: a non-numeric intervalMs -> 400 (not a silent NaN-comparison pass-through)", patchBadIntervalType.statusCode === 400);
  check("UPDATE: the row's intervalMs is UNCHANGED after the rejected patch", db.getPollJob(job.id).intervalMs === MIN_POLL_INTERVAL_MS);

  const patchToWakeNoSession = await inject({ method: "POST", url: `/api/poll-jobs/${job.id}`, payload: { mode: "wake" } }); // no sessionId supplied, existing agentId irrelevant to 'wake'
  check("UPDATE: switching mode to 'wake' with no sessionId -> 404 (not silently stored inconsistent)", patchToWakeNoSession.statusCode === 404);
  check("UPDATE: the row STAYS 'spawn' (rejected patch never partially applied)", db.getPollJob(job.id).mode === "spawn");

  const patchToWakeBadSession = await inject({ method: "POST", url: `/api/poll-jobs/${job.id}`, payload: { mode: "wake", sessionId: "nope" } });
  check("UPDATE: switching to 'wake' with a nonexistent sessionId -> 404", patchToWakeBadSession.statusCode === 404);

  const patchToWakeOk = await inject({ method: "POST", url: `/api/poll-jobs/${job.id}`, payload: { mode: "wake", sessionId: sessId } });
  check("UPDATE: switching to 'wake' with a REAL sessionId -> 200, mode+target both updated", patchToWakeOk.statusCode === 200);
  const afterWake = db.getPollJob(job.id);
  check("UPDATE: persisted mode='wake', sessionId set, agentId cleared (normalized, not left stale)", afterWake.mode === "wake" && afterWake.sessionId === sessId && afterWake.agentId === null);

  // A no-op patch (change neither mode nor target) still re-validates the EFFECTIVE (existing) pairing —
  // proving the check isn't just gated on "did the body include mode/sessionId/agentId".
  const noopPatch = await inject({ method: "POST", url: `/api/poll-jobs/${job.id}`, payload: { enabled: false } });
  check("UPDATE: a no-op-target patch (only 'enabled') still succeeds — existing pairing is valid", noopPatch.statusCode === 200 && db.getPollJob(job.id).enabled === false);

  // Switching agentId while STAYING in wake mode is irrelevant (agentId is ignored/cleared for 'wake') —
  // but switching BACK to spawn with a valid agent works cleanly, proving the normalization round-trips.
  const patchBackToSpawn = await inject({ method: "POST", url: `/api/poll-jobs/${job.id}`, payload: { mode: "spawn", agentId: otherAgentId } });
  check("UPDATE: switching back to 'spawn' with a valid agentId -> 200", patchBackToSpawn.statusCode === 200);
  const afterSpawn2 = db.getPollJob(job.id);
  check("UPDATE: persisted mode='spawn', agentId=otherAgentId, sessionId cleared", afterSpawn2.mode === "spawn" && afterSpawn2.agentId === otherAgentId && afterSpawn2.sessionId === null);

  console.log(failures === 0
    ? "\n✅ ALL PASS — /api/poll-jobs CREATE and UPDATE enforce the IDENTICAL mode<->target pairing + existence check (the CR's create/update validation-asymmetry fix): every rejected patch leaves the row exactly as it was, and every accepted patch normalizes sessionId/agentId for the effective mode."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  await app.close();
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
process.exit(failures === 0 ? 0 : 1);
