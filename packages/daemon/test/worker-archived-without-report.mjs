import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_status / worker_list "archived without report" projection test (board card ae0b7891).
// HERMETIC, NO claude, NO external daemon: seeds a real Db (sessions + orchestration_events), drives
// SessionService.notifyManagerOfExitedWorker directly (the real event/nudge producer — see
// worker-exited-without-report.mjs for its own dedicated coverage) to seed realistic state, then drives
// the REAL manager MCP tools (worker_list / worker_status) in-process over an InMemoryTransport pair.
//
// The bug this guards: a worker whose pty exits WITHOUT ever calling worker_report is archived
// (archived_at stamped) by archiveOnExit exactly like a worker that reported and cleanly retired — it
// then simply vanishes from worker_list (Db.listWorkers hard-filters archived_at IS NULL). The OBVIOUS
// fix — derive an `archivedWithoutReport` flag from `reportedState === null` — is WRONG: a worker that
// calls worker_report(done, noChanges:true) and auto-retires appends a LATER `stop_worker` bookkeeping
// event (workerReport's autoRetireNoCommit branch), which becomes the worker's new MOST-RECENT event, so
// reportedState reads back to null even though the worker genuinely reported. Case (b) below is that
// exact false-positive trap, seeded faithfully (worker_report(done, noChanges:true) THEN a LATER
// stop_worker(reason:"no-commit-auto-retire") event, task moved to the `review` lane) — SessionService.
// isArchivedWithoutReport must read false here even though reportedState also reads null.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-archnorep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `ap-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `aa-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  // crashRecoveryMaxAttempts:0 (mirrors worker-exited-without-report.mjs case (b)) — keeps
  // notifyManagerOfExitedWorker's nudge wording on the definitive branch, not the provisional one.
  db.insertProject({ id: projId, name: "ArchNoReport", repoPath: projId, vaultPath: projId, config: { orchestration: { crashRecoveryMaxAttempts: 0 } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  const enqueued = [];
  const pty = {
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
    },
    getPendingEntries: () => [],
  };
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const router = new OrchestrationMcpRouter(db, sessions);
  return { dbFile, db, projId, agentId, enqueued, sessions, router };
}

function seedManager(e, id, { recycledFrom = null } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(),
    lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null, recycledFrom,
  });
}
function seedWorker(e, id, parentId, { processState = "exited", taskId = null, branch = null } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState, resumability: "resumable", busy: false, createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(),
    lastError: null, role: "worker", parentSessionId: parentId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
    worktreePath: null, branch,
  });
}
function seedTask(e, id, columnKey = "in_progress") {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, priority: "p2", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
const at = (sec) => new Date(Date.parse(NOW.toISOString()) + sec * 1000).toISOString();

async function driveMcp(e, managerId) {
  const server = e.router.buildServer(managerId, "manager");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "archived-without-report-test", version: "0" });
  await client.connect(clientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  const list = parse(await client.callTool({ name: "worker_list", arguments: {} }));
  const status = async (id) => parse(await client.callTool({ name: "worker_status", arguments: { workerSessionId: id } }));
  return { client, list, status };
}

function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============ (a) GENUINE UNREPORTED EXIT (vault-only shape: taskId set, 0 commits, no branch) ============
{
  const e = makeEnv();
  seedManager(e, "mgr-a");
  seedTask(e, "tk-a"); // stays "in_progress" — the worker never reported, so nothing moves it
  seedWorker(e, "wkr-a", "mgr-a", { processState: "exited", taskId: "tk-a", branch: null });

  // The real event/nudge producer, driven directly (its own gating is covered in
  // worker-exited-without-report.mjs) — intended:false, exactly the unexpected-exit shape.
  e.sessions.notifyManagerOfExitedWorker("wkr-a", false);
  // archiveOnExit (index.ts onExit) always runs before notifyManagerOfExitedWorker in production —
  // simulate that here so isArchivedWithoutReport sees the same archived_at state it would live.
  e.db.archiveSession("wkr-a");

  check("(a) SessionService.isArchivedWithoutReport reads true for a genuinely-unreported exit",
    e.sessions.isArchivedWithoutReport("wkr-a") === true);

  const { client, list, status } = await driveMcp(e, "mgr-a");
  const byId = Object.fromEntries(list.map((w) => [w.workerSessionId, w]));
  check("(a) worker_list does NOT let the worker silently vanish — it appears with archivedWithoutReport:true",
    byId["wkr-a"]?.archivedWithoutReport === true && byId["wkr-a"]?.taskId === "tk-a");

  const sA = await status("wkr-a");
  check("(a) worker_status(wkr-a).archivedWithoutReport === true", sA.archivedWithoutReport === true);
  await client.close();
  cleanup(e);
}

// ============ (b) noChanges AUTO-RETIRE — the false-positive trap the naive fix would hit ============
{
  const e = makeEnv();
  seedManager(e, "mgr-b");
  seedTask(e, "tk-b");
  seedWorker(e, "wkr-b", "mgr-b", { processState: "exited", taskId: "tk-b", branch: "loom/tk-b" });

  // Faithfully mirror workerReport()'s real sequence for a declared no-op done (report.noChanges:true):
  // (1) task moves to the `review` lane, (2) a worker_report(done, noChanges:true) event is recorded,
  // (3) the autoRetireNoCommit branch appends a LATER stop_worker(reason:"no-commit-auto-retire") event —
  // this is the event that pushes reportedState back to null even though the worker DID report.
  e.db.updateTask("tk-b", { columnKey: "review" });
  e.db.appendEvent({
    id: randomUUID(), ts: at(10), managerSessionId: "mgr-b", workerSessionId: "wkr-b", taskId: "tk-b",
    kind: "worker_report", detail: { status: "done", summary: "nothing to change", noChanges: true },
  });
  e.db.appendEvent({
    id: randomUUID(), ts: at(20), managerSessionId: "mgr-b", workerSessionId: "wkr-b", taskId: "tk-b",
    kind: "stop_worker", detail: { reason: "no-commit-auto-retire", trigger: "declared-no-op" },
  });
  // The auto-retire path's own pty.stop is a deliberate Loom stop — intended:true — so
  // notifyManagerOfExitedWorker returns immediately and records NOTHING (verified directly too, below).
  e.sessions.notifyManagerOfExitedWorker("wkr-b", true);
  e.db.archiveSession("wkr-b");

  check("(b) precondition: reportedState WOULD read null here too (the ambiguity this card fixes)",
    e.db.listEventsForWorker("wkr-b").at(-1)?.kind === "stop_worker");
  check("(b) precondition: NO worker_exited_without_report event was ever recorded",
    !e.db.listEventsForWorker("wkr-b").some((ev) => ev.kind === "worker_exited_without_report"));
  check("(b) SessionService.isArchivedWithoutReport reads FALSE for a noChanges auto-retired worker",
    e.sessions.isArchivedWithoutReport("wkr-b") === false);

  const { client, list, status } = await driveMcp(e, "mgr-b");
  const byId = Object.fromEntries(list.map((w) => [w.workerSessionId, w]));
  check("(b) worker_list: the auto-retired worker is ABSENT (archived, same as today — no new false row)",
    !("wkr-b" in byId));

  const sB = await status("wkr-b");
  check("(b) worker_status(wkr-b).archivedWithoutReport === false (no false alarm on the healthy path)",
    sB.archivedWithoutReport === false);
  await client.close();
  cleanup(e);
}

// ============ (c) SELF-CLEARING — resolving the strand clears the flag, no permanent nag ============
{
  const e = makeEnv();
  seedManager(e, "mgr-c");
  seedTask(e, "tk-c");
  seedWorker(e, "wkr-c", "mgr-c", { processState: "exited", taskId: "tk-c", branch: null });

  e.sessions.notifyManagerOfExitedWorker("wkr-c", false);
  e.db.archiveSession("wkr-c");
  check("(c) precondition: flagged true while the task is still unresolved", e.sessions.isArchivedWithoutReport("wkr-c") === true);

  // The manager resolves it by hand (e.g. found the deliverable, moved the card off the active lane).
  e.db.updateTask("tk-c", { columnKey: "review" });
  check("(c) isArchivedWithoutReport flips back to false once the task leaves the active lane",
    e.sessions.isArchivedWithoutReport("wkr-c") === false);

  const { client, list } = await driveMcp(e, "mgr-c");
  check("(c) worker_list no longer surfaces the resolved worker as archivedWithoutReport",
    !list.some((w) => w.workerSessionId === "wkr-c"));
  await client.close();
  cleanup(e);
}

// ============ (d) INTENDED STOP (manager worker_stop / recycle) — never flagged ============
{
  const e = makeEnv();
  seedManager(e, "mgr-d");
  seedTask(e, "tk-d");
  seedWorker(e, "wkr-d", "mgr-d", { processState: "exited", taskId: "tk-d", branch: null });

  e.sessions.notifyManagerOfExitedWorker("wkr-d", true); // intended:true = a manager-issued stop
  e.db.archiveSession("wkr-d");
  check("(d) an intended stop never records worker_exited_without_report",
    !e.db.listEventsForWorker("wkr-d").some((ev) => ev.kind === "worker_exited_without_report"));
  check("(d) isArchivedWithoutReport reads false for an intended stop", e.sessions.isArchivedWithoutReport("wkr-d") === false);
  cleanup(e);
}

// ============ (e) RECYCLE LINEAGE — a SUCCESSOR manager must still see a PREDECESSOR's strand ============
// Card 93609ef3's own reasoning applies verbatim: recycleManager only re-parents LIVE workers
// (reparentLiveWorkers), so an ALREADY-EXITED worker (which an archived-without-report worker always
// is) keeps parentSessionId pointing at the now-retired predecessor forever. An exact parentSessionId
// match would silently hide it from the successor — exactly the manager who most needs to see it, since
// it inherited the task. workerReadableByManager (the SAME lineage-tolerant predicate worker_status
// already gates reads through) must be what the new archivedUnreported category uses too.
{
  const e = makeEnv();
  seedManager(e, "mgr-e-old"); // the predecessor — recycled away, but still the worker's parentSessionId
  seedTask(e, "tk-e");
  seedWorker(e, "wkr-e", "mgr-e-old", { processState: "exited", taskId: "tk-e", branch: null });

  e.sessions.notifyManagerOfExitedWorker("wkr-e", false);
  e.db.archiveSession("wkr-e");
  check("(e) precondition: flagged for the OLD (predecessor) manager", e.sessions.isArchivedWithoutReport("wkr-e") === true);

  // The manager recycles — a fresh successor session, `recycledFrom` pointing at the predecessor. The
  // worker row is untouched (still parentSessionId:"mgr-e-old") because it was already exited, not live.
  seedManager(e, "mgr-e-new", { recycledFrom: "mgr-e-old" });

  const { client, list, status } = await driveMcp(e, "mgr-e-new");
  const byId = Object.fromEntries(list.map((w) => [w.workerSessionId, w]));
  check("(e) the SUCCESSOR manager's worker_list still surfaces the predecessor's archived-unreported worker (lineage, not exact parent match)",
    byId["wkr-e"]?.archivedWithoutReport === true);

  const sE = await status("wkr-e");
  check("(e) the successor's worker_status(wkr-e) also reads archivedWithoutReport:true (not 'not your worker')",
    sE.archivedWithoutReport === true && sE.error === undefined);
  await client.close();
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_status/worker_list surface archivedWithoutReport: a worker whose pty exited without ever calling worker_report is flagged true and stays VISIBLE in worker_list (instead of silently vanishing), while a worker that reported done(noChanges:true) and cleanly auto-retired — whose reportedState is ALSO ambiguously null — is correctly flagged false with no new phantom row. The signal self-clears once the manager resolves the task, and a manager-intended stop is never flagged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
