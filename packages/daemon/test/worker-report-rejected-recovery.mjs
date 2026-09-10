import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 36e43a98: a `worker_report(done)` REFUSED by the pending-direction guard (sessions/service.ts,
// the `reason: "pending-direction"` branch) used to append a `worker_report_rejected` event whose
// `detail` carried ONLY `{reason, queued, msgIds, repeat}` — the report's own `summary` was never
// persisted anywhere, and `worker_report_get` only ever looked at `kind === "worker_report"` events, so
// a refused report was permanently unreachable. The live incident: a worker's full done report was
// refused, and its NEXT report said "see my previous message" about content that had vanished.
//
// HERMETIC, NO daemon, NO claude: sandboxed HOME, a real Db, the REAL SessionService.workerReport() (for
// the refusal) and the REAL OrchestrationMcpRouter driven in-process over InMemoryTransport (for the
// recovery read) — mirrors worker-report-pending-guard.mjs's seeding + worker-report-recovery.mjs's MCP
// harness.
//
// Proves:
//   (1) workerReport(done) is REFUSED while manager direction is unresolved (unchanged guard behavior).
//   (2) THE FIX: the resulting worker_report_rejected event's OWN detail carries the report's summary/
//       status/prUrl/noChanges — not just the refusal metadata.
//   (3) THE FIX: worker_report_get (workerSessionId, no eventId) — the MOST RECENT event for this
//       worker right after the refusal is the rejection itself — recovers that exact summary, BYTE-
//       IDENTICAL, marks it `rejected: true`, and carries the refusal's own reason/queued/msgIds/repeat.
//   (4) worker_report_get BY the rejected event's own eventId also recovers it (not just the "latest"
//       default path).
//   (5) Negative control: a DIFFERENT worker with only a genuine (non-refused) worker_report event is
//       NOT marked `rejected` — the flag doesn't leak onto an accepted report.
// Run: 1) build daemon (pnpm build), 2) node test/worker-report-rejected-recovery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sandboxHome = mkdtempManaged("loom-wrrr-home-");
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
process.env.LOOM_HOME = path.join(sandboxHome, ".loom");
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

const dbFile = path.join(os.tmpdir(), `loom-wrrr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `wrrr-proj-${sfx}`, agentId = `wrrr-ag-${sfx}`, taskId = `wrrr-task-${sfx}`;
const mgrId = `wrrr-mgr-${sfx}`, wkrId = `wrrr-wkr-${sfx}`, otherWkrId = `wrrr-wkr-other-${sfx}`;
const repo = path.join(sandboxHome, "repo");
fs.mkdirSync(repo, { recursive: true });

db.insertProject({ id: projId, name: "WRRR", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertTask({ id: taskId, projectId: projId, title: "WRRR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
// worktreePath does NOT exist (no git repo) — the done-precheck's `fs.existsSync(worktreePath)` guard is
// false, so it's skipped entirely and the pending-direction guard is the sole gate exercised here (same
// isolation trick as worker-report-pending-guard.mjs, just via nonexistence rather than a non-git dir).
const worktreePath = path.join(sandboxHome, "does-not-exist");
db.insertSession({ id: wkrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch: `loom/${sfx}` });
db.insertSession({ id: otherWkrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath, branch: `loom/other-${sfx}` });

// Queue an UNRESOLVED from-manager instruction so the pending-direction guard fires.
const msgId = randomUUID();
db.appendEvent({
  id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: wkrId, taskId,
  kind: "session_message_queued", detail: { msgId, text: "[loom:from-manager]\nSTOP — redo it", sender: mgrId },
});

const ptyStub = { enqueueStdin() { return { delivered: true }; } };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

// ═══════════════════════════ (1)+(2) REFUSAL + persisted content ═══════════════════════════════════════
const DISTINCTIVE_SUMMARY = "DISTINCTIVE-REPORT-BODY-" + "X".repeat(300) + "-END-MARKER-QQQ";
const rReport = await sessions.workerReport(wkrId, {
  status: "done", summary: DISTINCTIVE_SUMMARY, prUrl: "https://example.com/pr/9", noChanges: false,
});
check("(1) workerReport(done) REFUSED while manager direction is unresolved", rReport.reported === false && rReport.refused === true);
check("(1) task stays in_progress (not moved)", db.getTask(taskId).columnKey === "in_progress");

const rejectedEvent = db.listEventsForWorker(wkrId).filter((e) => e.kind === "worker_report_rejected").at(-1);
check("(2) fixture sanity: a worker_report_rejected event was recorded", !!rejectedEvent);
check("(2) THE FIX: the rejected event's OWN detail carries the report's summary, byte-identical",
  rejectedEvent?.detail?.summary === DISTINCTIVE_SUMMARY);
check("(2) THE FIX: status/prUrl/noChanges round-trip on the rejected event",
  rejectedEvent?.detail?.status === "done" && rejectedEvent?.detail?.prUrl === "https://example.com/pr/9" && rejectedEvent?.detail?.noChanges === undefined);
check("(2) the refusal's own metadata is still present (reason/queued/msgIds/repeat unchanged)",
  rejectedEvent?.detail?.reason === "pending-direction" && rejectedEvent?.detail?.queued === 1 && Array.isArray(rejectedEvent?.detail?.msgIds) && rejectedEvent?.detail?.repeat === false);

// A GENUINE report for the OTHER worker (never refused) — the negative control for (5).
const genuineEvt = { id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: otherWkrId, taskId: null, kind: "worker_report", detail: { status: "done", summary: "genuine-unrelated-report" } };
db.appendEvent(genuineEvt);

// ═══════════════════════════ MCP harness for worker_report_get ═════════════════════════════════════════
const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessions));
const server = router.buildServer(mgrId, "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "worker-report-rejected-recovery-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

// ═══════════════════════════ (3) worker_report_get: default (latest) recovers the refusal ═══════════════
const latest = await call("worker_report_get", { workerSessionId: wkrId });
check("(3) THE FIX: worker_report_get (no eventId) reaches the REFUSED report — no 'no worker_report recorded' error", latest.error === undefined);
check("(3) eventId matches the worker_report_rejected event's own id", latest.eventId === rejectedEvent.id);
check("(3) summary is BYTE-IDENTICAL to the refused report's own body", latest.summary === DISTINCTIVE_SUMMARY);
check("(3) status/prUrl round-trip through worker_report_get", latest.status === "done" && latest.prUrl === "https://example.com/pr/9");
check("(3) marked rejected:true so a manager can tell it apart from a landed report", latest.rejected === true);
check("(3) the refusal's own reason/queued/msgIds/repeat surface too", latest.reason === "pending-direction" && latest.queued === 1 && Array.isArray(latest.msgIds) && latest.repeat === false);
check("(3) taskId carried through", latest.taskId === taskId);

// ═══════════════════════════ (4) worker_report_get BY the rejected event's own eventId ═══════════════════
const byId = await call("worker_report_get", { workerSessionId: wkrId, eventId: rejectedEvent.id });
check("(4) fetching BY the rejected event's own id ALSO recovers it", byId.eventId === rejectedEvent.id && byId.summary === DISTINCTIVE_SUMMARY && byId.rejected === true);
const byPrefix = await call("worker_report_get", { workerSessionId: wkrId, eventId: rejectedEvent.id.slice(0, 8) });
check("(4) an unambiguous 8-char id-prefix resolves the same way", byPrefix.eventId === rejectedEvent.id);

// ═══════════════════════════ (5) negative control: an accepted report is never marked rejected ═══════════
const genuine = await call("worker_report_get", { workerSessionId: otherWkrId });
check("(5) a genuine (non-refused) worker_report is recovered normally", genuine.eventId === genuineEvt.id && genuine.summary === "genuine-unrelated-report");
check("(5) negative control: rejected is NOT set on a genuine report (flag doesn't leak)", genuine.rejected === undefined);

await client.close();
try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — a worker_report(done) refused by the pending-direction guard now persists its own " +
    "summary/status/prUrl/noChanges on the worker_report_rejected event, and worker_report_get recovers " +
    "it (byte-identical, marked rejected:true) both as the default 'latest' and by explicit eventId — " +
    "without ever marking a genuine, accepted report as rejected."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
