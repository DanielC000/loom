import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 20ff76de — `midSessionModalSince` on worker_list / worker_status: the manager-visible read of the
// mid-session modal hold (epoch-ms since held, null when not held). Real PtyHost over a fake pty + real Db +
// the REAL manager MCP router (InMemoryTransport), same technique as worker-unconfirmed-delivery-signal.mjs.
// Proves: null on a healthy live worker (positive control that the field is read at all), a NUMBER while a
// worker is held on a modal, null again once a human types into it. The exhaustive key-set pin lives in
// worker-status-projection-guard.mjs.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-list-mid-session-modal-since.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const waitUntil = async (pred, timeoutMs) => {
  try { return await sharedWaitUntil(pred, { timeoutMs, intervalMs: 10, label: "worker-list-mid-session-modal-since" }); }
  catch (err) { if (err?.exhaustedOnThrow !== false) throw err; return false; }
};

const tmpHome = path.join(os.tmpdir(), `loom-wlmms-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "10";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "60";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "3";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const fakes = new Map();
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    let dataCb = null;
    const fake = { ...base, write: () => {}, onData: (cb) => { dataCb = cb; return { dispose() {} }; }, feed: (s) => dataCb?.(s) };
    fakes.set(opts.sessionId, fake);
    return fake;
  }
}
const stuck = [];
const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onClaudeBootDialogStuck(id, info) { stuck.push({ id, info }); },
};
const dbFile = path.join(os.tmpdir(), `loom-wlmms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const t = "2026-11-11T12:00:00.000Z";
const projId = "proj-wlmms", agentId = "agent-wlmms";
db.insertProject({ id: projId, name: "WLMMS", repoPath: projId, vaultPath: projId, config: {}, createdAt: t, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
const mkSession = (id, role, parent) => db.insertSession({ id, projectId: projId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: t, lastActivity: t, lastError: null, role, parentSessionId: parent ?? null, taskId: null, worktreePath: null, branch: null });
mkSession("mgr", "manager"); mkSession("w-held", "worker", "mgr"); mkSession("w-free", "worker", "mgr");

const sessionsStub = {
  peekPendingMerge() { return undefined; }, listPendingSpawns() { return []; }, listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; }, async getDanglingWorkers() { return []; },
};
const host = new TestPtyHost(events);
const spawnWorker = (id) => {
  host.spawn({ sessionId: id, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker" });
  host.deliverHook(id, { hook_event_name: "SessionStart", session_id: `eng-${id}` });
  return fakes.get(id);
};
const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub), {}, host);
const server = router.buildServer("mgr", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "wlmms-test", version: "0" });
await client.connect(clientT);
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args ?? {} })).content[0].text);
const rowOf = async (id) => (await call("worker_list")).find((r) => r.workerSessionId === id);

try {
  const ff = spawnWorker("w-free");
  ff.feed("● Reading file…");
  const fh = spawnWorker("w-held");
  fh.feed("Some brand-new Claude Code prompt\n❯ 1. Yes\n  2. No\nEnter to confirm · Esc to cancel");
  host.submit("w-held", "do the thing");
  check("(setup) the modal engaged the hold on w-held", await waitUntil(() => stuck.some((e) => e.id === "w-held" && e.info.phase === "mid-session"), 3000));

  const free = await rowOf("w-free");
  check("(control) worker_list: a healthy live worker carries the field, null (so the field IS read)", free && "midSessionModalSince" in free && free.midSessionModalSince === null);
  const row = await rowOf("w-held");
  check("(1) worker_list: a held worker's midSessionModalSince is a non-null epoch-ms NUMBER", typeof row?.midSessionModalSince === "number" && row.midSessionModalSince > 0 && row.midSessionModalSince <= Date.now());
  const status = await call("worker_status", { workerSessionId: "w-held" });
  check("(1) worker_status: same field, same non-null reading", typeof status.midSessionModalSince === "number");
  check("(1) worker_status: a healthy worker reads null", (await call("worker_status", { workerSessionId: "w-free" })).midSessionModalSince === null);

  host.writeStdin("w-held", "y"); // human raw bytes alone never release the episode
  check("(2) worker_list: still non-null after raw human bytes (they are not evidence)", typeof (await rowOf("w-held"))?.midSessionModalSince === "number");
  host.releaseModalHoldByHuman("w-held", { force: true }); // the explicit human release
  check("(2) worker_list: null again once the human releases the held session", (await rowOf("w-held"))?.midSessionModalSince === null);
} finally {
  for (const id of ["w-held", "w-free"]) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\n✅ ALL PASS — midSessionModalSince on worker_list/worker_status" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
