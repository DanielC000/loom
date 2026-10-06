import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_list/worker_status `lastMismatchPastedContentWrapReplay` field test (card 79999395).
//
// THE GAP THIS CLOSES: the `confirmed-pasted-content-wrap-replay` arm (card dc92f4b6) wrote
// `live.mismatchResolvedGens` only — no worker_list/worker_status pull surface at all. A manager could not
// see this arm fired without reading daemon-output.log's own `[prompt-mismatch-arm]` line directly. This
// test proves the new field (`Live.lastMismatchPastedContentWrapReplay` /
// `getLastMismatchPastedContentWrapReplay`), mirroring `lastMismatchFusion`'s own shape/contract, is
// correctly surfaced on both tools for the real confirmed shape, stays null for an unrelated/negative-
// control mismatch (so it never falsely claims this arm fired), and a router built without a PtyHost stays
// byte-compatible. Mirrors worker-mismatch-generic-signal.mjs's own harness technique (a REAL PtyHost over
// the createPty() seam, wired into a REAL OrchestrationMcpRouter — no real claude, no daemon) and reuses
// pty-prompt-mismatch-pasted-content-wrap-replay.mjs's own scenario-1/scenario-2 fixtures for the positive
// and negative cases respectively.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-mismatch-pasted-content-wrap-replay-signal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pcwr-signal-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost, framePossibleDuplicate } = await import("../dist/pty/host.js");
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

const dbFile = path.join(os.tmpdir(), `loom-pcwr-signal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const seededActivity = "2026-10-06T12:00:00.000Z";
const projId = "proj-pcwr-signal";
const agentId = "agent-pcwr-signal";
db.insertProject({ id: projId, name: "PcwrSignal", repoPath: projId, vaultPath: projId, config: {}, createdAt: seededActivity, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });
for (const id of ["w-replay", "w-unrelated", "w-not-in-pty"]) {
  db.insertSession({ id, projectId: projId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: `task-${id}` });
}

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

const pastedContentWrap = (id, inner) => `\n\n<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">\n`;
const ROOT_MSG_ID = "79999395-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub), {}, host);
async function connectAs(sessionId, role) {
  const server = router.buildServer(sessionId, role);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: `pcwr-signal-test-${sessionId}`, version: "0" });
  await client.connect(clientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  return { call: async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} })) };
}

const mgrClient = await connectAs("mgr", "manager");

try {
  // ============== (1) POSITIVE — the real confirmed shape (dc92f4b6 scenario 1's own fixture) ==============
  {
    const SID = "w-replay";
    spawnReady(host, SID);
    const kickoffText = "K".repeat(500);
    const remint = framePossibleDuplicate(kickoffText, ROOT_MSG_ID);

    host.enqueueStdin(SID, kickoffText); // gen=1, never confirmed
    host.deliverHook(SID, { hook_event_name: "Stop" }); // clears busy without confirming gen=1

    host.enqueueStdin(SID, remint); // gen=2, now written and current
    const reported = pastedContentWrap("pcwr", kickoffText);
    const beforeDetect = Date.now();
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: reported });
    const afterDetect = Date.now();

    check("(1) sanity — this really is the confirmed-pasted-content-wrap-replay class at the PtyHost level",
      host.getLastMismatchPastedContentWrapReplay(SID) !== null
      && host.getLastMismatchUnmatched(SID) === null
      && host.getLastMismatchReplay(SID) === null && host.getLastMismatchFusion(SID) === null);

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(1) RED-PROOF — worker_list surfaces the confirmed replay via the NAMED field, not left null",
      row?.lastMismatchPastedContentWrapReplay !== null && row?.lastMismatchPastedContentWrapReplay !== undefined
      && row.lastMismatchPastedContentWrapReplay.gen === 2
      && row.lastMismatchPastedContentWrapReplay.recognizedGen === 1);
    check("(1) its own named field agrees with the three plain siblings all staying null",
      row.lastMismatchReplay === null && row.lastMismatchFusion === null);
    check("(1) detectedAt is a real wall-clock timestamp taken at detection",
      typeof row.lastMismatchPastedContentWrapReplay.detectedAt === "number"
      && row.lastMismatchPastedContentWrapReplay.detectedAt >= beforeDetect
      && row.lastMismatchPastedContentWrapReplay.detectedAt <= afterDetect);
    // reportedLen/intendedLen describe THIS turn (gen=2): reported is the engine's wrapped echo, intended
    // is gen=2's OWN full tagged re-mint (`remint`, longer than kickoffText) — same convention as
    // lastMismatchFusion's own reportedLen/intendedLen, which also describe the current turn, not the
    // matched/recognized earlier one.
    check("(1) reportedLen/intendedLen are carried through (same shape as lastMismatchFusion)",
      row.lastMismatchPastedContentWrapReplay.reportedLen === reported.length
      && row.lastMismatchPastedContentWrapReplay.intendedLen === remint.length);

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(1) worker_status: same shape, same values",
      status?.lastMismatchPastedContentWrapReplay?.gen === 2
      && status.lastMismatchPastedContentWrapReplay.recognizedGen === 1
      && status.lastMismatchPastedContentWrapReplay.detectedAt === row.lastMismatchPastedContentWrapReplay.detectedAt);
  }

  // ============== (2) NEGATIVE CONTROL — an unrelated, genuinely-lost mismatch must NOT set this field ====
  {
    const SID = "w-unrelated";
    spawnReady(host, SID);
    const kickoffText = "L".repeat(500);
    const remint = framePossibleDuplicate(kickoffText, ROOT_MSG_ID);

    host.enqueueStdin(SID, kickoffText); // gen=1, never confirmed
    host.deliverHook(SID, { hook_event_name: "Stop" });

    const unrelatedContent = "Z".repeat(500); // genuinely unrelated wrapped content — dc92f4b6 scenario 2's own shape
    host.enqueueStdin(SID, remint); // gen=2, now written and current
    const reported = pastedContentWrap("pcwr", unrelatedContent);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: reported });

    check("(2) sanity — this is still classified unmatchable at the PtyHost level, not the confirmed-replay arm",
      host.getLastMismatchUnmatched(SID) !== null && host.getLastMismatchPastedContentWrapReplay(SID) === null);

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(2) NEGATIVE CONTROL — worker_list reads lastMismatchPastedContentWrapReplay:null for a genuine, unrelated loss (never a false positive)",
      row?.lastMismatchPastedContentWrapReplay === null);

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(2) worker_status: same null", status.lastMismatchPastedContentWrapReplay === null);
  }

  // ============== (3) NULL for a session not live in THIS PtyHost process ==============
  {
    const list = await mgrClient.call("worker_list");
    const other = list.find((w) => w.workerSessionId === "w-not-in-pty");
    check("(3) worker_list: a worker never spawned in this process reads lastMismatchPastedContentWrapReplay:null",
      other && other.lastMismatchPastedContentWrapReplay === null);

    const status = await mgrClient.call("worker_status", { workerSessionId: "w-not-in-pty" });
    check("(3) worker_status: same null", status.lastMismatchPastedContentWrapReplay === null);
  }

  // ============== (4) byte-compat: a router built the OLD way (no pty arg) still works ==============
  {
    const routerNoPty = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
    const server = routerNoPty.buildServer("mgr", "manager");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "pcwr-signal-nopty-test", version: "0" });
    await client.connect(clientT);
    const list = JSON.parse((await client.callTool({ name: "worker_list", arguments: {} })).content[0].text);
    check("(4) a router with no PtyHost wired still returns worker_list without throwing", Array.isArray(list) && list.length === 3);
    check("(4) every row reads lastMismatchPastedContentWrapReplay:null when no PtyHost was wired", list.every((w) => w.lastMismatchPastedContentWrapReplay === null));
  }
} finally {
  for (const sid of ["w-replay", "w-unrelated"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `lastMismatchPastedContentWrapReplay` (card 79999395) exposes worker_list/worker_status's own NAMED pull surface for the `confirmed-pasted-content-wrap-replay` arm (card dc92f4b6), mirroring lastMismatchFusion's shape/contract: the real confirmed shape (a late engine echo wrapping an earlier generation's own recorded write) surfaces gen/recognizedGen/reportedLen/intendedLen/detectedAt correctly on both tools, a genuinely unrelated/unmatchable loss reads null (never a false positive for this arm), a worker not live in this process reads null, and a router built without a PtyHost stays byte-compatible."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
