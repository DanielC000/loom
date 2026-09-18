import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9f7f2b50 — DoD-3: a durable-audit orchestration_event must SURVIVE deleteAgent (unlike the ordinary
// cascade that destroys every event tied to the deleted agent's sessions) AND stay reachable by a
// project-scoped read afterward — surviving-but-unfindable is the failure af08f7e8 already hit once.
//
// Covers:
//   (A) deleteAgent DESTROYS a session-scoped bookkeeping event (worker_report) — the unchanged baseline.
//   (B) deleteAgent SPARES a durable-audit event (worker_gate) — the row survives with a dangling session id.
//   (C) that surviving row is still reachable via listOrchestrationEventsBounded's project-scoped read,
//       because appendEvent stamped detail.projectId on it at write time (the findability half — a
//       row that merely "survives" but resolves to a NULL project is still the af08f7e8 failure shape).
//   (D) [contrast] deleteProject still cascades a durable-audit event — the one deliberately-total wipe.
//
// Run: 1) build (turbo builds shared first), 2) node test/durable-audit-event-survives-agent-delete.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-durable-audit-event-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");

const dbFile = path.join(tmpHome, "durable-audit.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

function mkProject(id) {
  db.insertProject({ id, name: id, repoPath: `/tmp/${id}`, vaultPath: `/tmp/${id}`, config: {}, createdAt: now, archivedAt: null });
  const agentId = `${id}-agent`, mgrId = `${id}-mgr`;
  db.insertAgent({ id: agentId, projectId: id, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({
    id: mgrId, projectId: id, agentId, engineSessionId: `eng-${id}`, title: null, cwd: id,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  return { projectId: id, agentId, mgrId };
}

// ===== (A) + (B): deleteAgent cascades bookkeeping but spares durable audit =====
{
  const proj = mkProject("dae-agent");
  const bookkeepingId = randomUUID();
  const durableId = randomUUID();
  db.appendEvent({ id: bookkeepingId, ts: now, managerSessionId: proj.mgrId, kind: "worker_report", detail: { ok: true } });
  db.appendEvent({ id: durableId, ts: now, managerSessionId: proj.mgrId, kind: "worker_gate", detail: { passed: true } });

  const beforeAll = db.listOrchestrationEventsBounded({ sessionId: proj.mgrId, limit: 10, offset: 0 });
  check("(setup) both events exist before delete", beforeAll.items.some((r) => r.id === bookkeepingId) && beforeAll.items.some((r) => r.id === durableId));

  db.deleteAgent(proj.agentId);

  const bookkeepingRows = db.listOrchestrationEventsBounded({ kind: ["worker_report"], sessionId: proj.mgrId, limit: 10, offset: 0 });
  check("(A) a session-scoped bookkeeping event (worker_report) is GONE after deleteAgent — zero rows, not merely a non-match", bookkeepingRows.items.length === 0);

  const durableRows = db.listOrchestrationEventsBounded({ kind: ["worker_gate"], sessionId: proj.mgrId, limit: 10, offset: 0 });
  const survived = durableRows.items.find((r) => r.id === durableId);
  check("(B) a durable-audit event (worker_gate) SURVIVES deleteAgent", survived !== undefined);

  // ===== (C) the surviving row stays reachable by a PROJECT-scoped read (the findability half) =====
  const byProject = db.listOrchestrationEventsBounded({ kind: ["worker_gate"], projectId: proj.projectId, limit: 10, offset: 0 });
  check("(C) the surviving durable event is still findable by projectId after its session is gone", byProject.items.some((r) => r.id === durableId));
  check("(C) its resolved projectId matches the deleted agent's own project (via the detail.projectId write-time stamp)", byProject.items.find((r) => r.id === durableId)?.projectId === proj.projectId);

  // Negative control: an UNRELATED project's scoped read must NOT see it.
  const otherProj = mkProject("dae-agent-unrelated");
  const byOtherProject = db.listOrchestrationEventsBounded({ kind: ["worker_gate"], projectId: otherProj.projectId, limit: 10, offset: 0 });
  check("(negative control) an unrelated project's scoped read does NOT see the surviving event", byOtherProject.items.every((r) => r.id !== durableId));
}

// ===== (D) [contrast] deleteProject still cascades a durable-audit event — the deliberate full purge =====
{
  const proj = mkProject("dae-project");
  const durableId = randomUUID();
  db.appendEvent({ id: durableId, ts: now, managerSessionId: proj.mgrId, kind: "worker_gate", detail: { passed: true } });

  const before = db.listOrchestrationEventsBounded({ kind: ["worker_gate"], projectId: proj.projectId, limit: 10, offset: 0 });
  check("(D) setup: the durable event exists before deleteProject", before.items.some((r) => r.id === durableId));

  db.deleteProject(proj.projectId);

  const after = db.listOrchestrationEventsBounded({ kind: ["worker_gate"], sessionId: proj.mgrId, limit: 10, offset: 0 });
  check("(D) deleteProject DOES cascade a durable-audit event too — the one deliberate full wipe", after.items.every((r) => r.id !== durableId));
}

try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — deleteAgent's cascade now excludes durable-audit event kinds (they survive with a dangling session id, findable via the detail.projectId write-time stamp), while ordinary bookkeeping events are still cascaded as before; deleteProject remains a deliberate full purge of both."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
