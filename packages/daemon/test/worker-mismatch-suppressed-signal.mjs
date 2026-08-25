import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_list/worker_status lastMismatchNoticeSuppressed PULL-read test (card c0323f8a, manager review).
//
// THE BUG THIS CLOSES: `Live.lastMismatchNoticeSuppressed` (pty/host.ts, the exact-repeat suppression's
// own durable count field) was added alongside `lastMismatchReplay`/`lastMismatchFusion` and given the
// SAME "manager-visible PULL surface" doc language — but, unlike those two siblings, was never actually
// wired into `mcp/orchestration.ts`'s worker_list/worker_status row shapes. The getter existed; nothing
// called it. A manager reading worker_list could never see that an alarm had been suppressed — exactly
// the "swallowed alarm with no reader" failure the field's own doc warns against. Mirrors
// worker-unconfirmed-delivery-signal.mjs's harness technique (a REAL PtyHost over the createPty() seam,
// wired into a REAL OrchestrationMcpRouter — no real claude, no daemon).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-mismatch-suppressed-signal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mismatch-suppressed-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    return { ...base, write: () => {} };
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retrofitted onto the shared _wait.mjs waitUntil (card 24d2e0ac): same timeoutMs/stepMs budget, still
// returns true/false — a thrown predicate is a real bug and should propagate, not fold into false.
const waitUntil = async (predicate, timeoutMs = 2000, stepMs = 5) => {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs: stepMs, label: "worker-mismatch-suppressed-signal: predicate" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return false;
  }
};
const hasPendingMismatchNotice = (sid) => host.getPendingEntries(sid).some((e) => e.text.includes("[loom:prompt-mismatch]"));

const dbFile = path.join(os.tmpdir(), `loom-mismatch-suppressed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const seededActivity = "2026-08-07T12:00:00.000Z";
const projId = "proj-mismatch-suppressed";
const agentId = "agent-mismatch-suppressed";
db.insertProject({ id: projId, name: "MismatchSuppressed", repoPath: projId, vaultPath: projId, config: {}, createdAt: seededActivity, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });
db.insertSession({ id: "w-suppressed", projectId: projId, agentId, engineSessionId: "eng-w-suppressed", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-suppressed" });
db.insertSession({ id: "w-clean", projectId: projId, agentId, engineSessionId: "eng-w-clean", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-clean" });
db.insertSession({ id: "w-not-in-pty", projectId: projId, agentId, engineSessionId: "eng-w-other", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-other" });

const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; },
};

function spawnReady(targetHost, sessionId) {
  targetHost.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  targetHost.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub), {}, host);
async function connectAs(sessionId, role) {
  const server = router.buildServer(sessionId, role);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: `mismatch-suppressed-test-${sessionId}`, version: "0" });
  await client.connect(clientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  return { call: async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} })) };
}

const mgrClient = await connectAs("mgr", "manager");

try {
  // ============== (1) A GENUINE SUPPRESSION — driven the same way pty-prompt-mismatch.mjs scenario 14
  // drives it (force enterConfirmed:false between two identical UserPromptSubmit hooks — this suite's own
  // job is only to prove the WIRING, not re-prove the suppression logic itself, already covered there). ==
  {
    const SID = "w-suppressed";
    spawnReady(host, SID);
    const stranded = "leftover text from a prior turn";
    const intended = "the message this turn actually intended to submit";
    host.enqueueStdin(SID, intended);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: stranded + intended });
    const enqueued = await waitUntil(() => hasPendingMismatchNotice(SID));
    check("(1) setup: the first occurrence's notice actually enqueues", enqueued);

    check("(1) PtyHost level: no suppression recorded yet (only one occurrence so far)", host.getLastMismatchNoticeSuppressed(SID) === null);

    host.live.get(SID).enterConfirmed = false; // force the SAME (gen, hashes) to be re-examined
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: stranded + intended });
    const suppressed = host.getLastMismatchNoticeSuppressed(SID);
    check("(1) PtyHost level: a suppression is now recorded, count:1", suppressed?.count === 1 && typeof suppressed?.gen === "number" && typeof suppressed?.writtenHash === "string" && typeof suppressed?.reportedHash === "string");

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(1) worker_list: lastMismatchNoticeSuppressed is now VISIBLE over MCP — the exact gap this card closes",
      row?.lastMismatchNoticeSuppressed !== null && row?.lastMismatchNoticeSuppressed !== undefined
      && row.lastMismatchNoticeSuppressed.count === 1
      && row.lastMismatchNoticeSuppressed.gen === suppressed.gen
      && row.lastMismatchNoticeSuppressed.writtenHash === suppressed.writtenHash
      && row.lastMismatchNoticeSuppressed.reportedHash === suppressed.reportedHash);

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(1) worker_status: same shape, same values", status?.lastMismatchNoticeSuppressed?.count === 1
      && status.lastMismatchNoticeSuppressed.gen === suppressed.gen);

    // A FURTHER repeat of the SAME signature must accumulate the count, visible over MCP too.
    host.live.get(SID).enterConfirmed = false;
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: stranded + intended });
    const list2 = await mgrClient.call("worker_list");
    const row2 = list2.find((w) => w.workerSessionId === SID);
    check("(1) worker_list: a further repeat increments count to 2 over MCP (not reset)", row2?.lastMismatchNoticeSuppressed?.count === 2);
  }

  // ============== (2) A WORKER WITH NO SUPPRESSION — reads null, not a fabricated zero-count struct =====
  {
    const SID = "w-clean";
    spawnReady(host, SID);
    host.enqueueStdin(SID, "an entirely ordinary, correctly-delivered turn");
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "an entirely ordinary, correctly-delivered turn" });

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(2) worker_list: a clean worker with no suppression reads lastMismatchNoticeSuppressed:null", row?.lastMismatchNoticeSuppressed === null);

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(2) worker_status: same null", status.lastMismatchNoticeSuppressed === null);
  }

  // ============== (3) NULL for a session not live in THIS PtyHost process ==============
  {
    const list = await mgrClient.call("worker_list");
    const other = list.find((w) => w.workerSessionId === "w-not-in-pty");
    check("(3) worker_list: a worker never spawned in this process reads lastMismatchNoticeSuppressed:null", other && other.lastMismatchNoticeSuppressed === null);

    const status = await mgrClient.call("worker_status", { workerSessionId: "w-not-in-pty" });
    check("(3) worker_status: same null", status.lastMismatchNoticeSuppressed === null);
  }

  // ============== (4) byte-compat: a router built the OLD way (no pty arg) still works ==============
  {
    const routerNoPty = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
    const server = routerNoPty.buildServer("mgr", "manager");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "mismatch-suppressed-nopty-test", version: "0" });
    await client.connect(clientT);
    const list = JSON.parse((await client.callTool({ name: "worker_list", arguments: {} })).content[0].text);
    check("(4) a router with no PtyHost wired still returns worker_list without throwing", Array.isArray(list) && list.length === 3);
    check("(4) every row reads lastMismatchNoticeSuppressed:null when no PtyHost was wired", list.every((w) => w.lastMismatchNoticeSuppressed === null));
  }
} finally {
  for (const sid of ["w-suppressed", "w-clean"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — lastMismatchNoticeSuppressed (pty/host.ts's getLastMismatchNoticeSuppressed, card c0323f8a) is now wired into worker_list/worker_status exactly like its lastMismatchReplay/lastMismatchFusion siblings: visible over MCP the instant a suppression fires, its count accumulating across repeats, null for a clean worker (not a fabricated zero-count struct), null for a session not live in this process, and byte-compatible on a router built without a PtyHost. Closes the gap where the field existed but no manager could ever read it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
