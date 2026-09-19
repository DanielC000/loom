import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_list/worker_status `codexBootStuck` test (card bba13405).
//
// THE OBSERVABILITY GAP THIS CLOSES: a Codex Harness Pilot manager's `daemon_restart` resumed a preserved
// codex worker that then NEVER FINISHED BOOTING — stuck before `model-loaded`. The manager checked
// `worker_status` TWICE, minutes apart, and it read `processState:"live"`, `resumability:"resumable"`,
// `busy:false` — EXACTLY what a healthy idle worker shows. `pendingQueueDepth` grew (1 -> 2) but on a
// QUIET wedged worker even that stays silent. `codexBootStuck` (pty/host.ts's `getCodexBootStuck`,
// CodexLive.bootStuckInfo) closes this: it goes non-null the instant codex's own boot-readiness ceiling
// fires without ever latching, durably readable on worker_list/worker_status long after the async
// `[loom:codex-boot-stuck]` notice fired — the exact case a manager reading the surface "well after the
// fact" (the reported incident) needs.
//
// WHAT THIS TEST PROVES:
//   (1) A RESUMED codex session (resumeId set, mirroring the real incident's daemon-restart resume) that
//       never reaches model-loaded reads `codexBootStuck` NON-NULL on worker_list AND worker_status, once
//       the shrunk boot-readiness ceiling fires.
//   (2) THE OLD HEALTH SURFACE STILL READS "HEALTHY" ALONGSIDE IT — processState:"live",
//       resumability:"resumable", busy:false — proving `codexBootStuck` is the ONLY field that
//       discriminates this from a genuinely idle worker (the exact defect the reported card names).
//   (3) A HEALTHY, fully-booted codex worker reads `codexBootStuck:null` (not merely "not yet stuck").
//   (4) A CLAUDE worker reads `codexBootStuck:null` structurally — never applicable to that harness.
//   (5) A worker not live in this process reads `codexBootStuck:null` (not a crash, not a wrong value).
//   (6) LATE SELF-RECOVERY clears `codexBootStuck` back to null on worker_list/worker_status too, not
//       just at the PtyHost level (codex-queue-state-machine.mjs already proves the PtyHost level).
//
// HERMETIC: a REAL PtyHost (codex path) driven by a FAKE, fully-scripted codex pty — no real codex
// process — wired into a REAL OrchestrationMcpRouter, same technique as
// worker-pending-queue-depth.mjs/codex-queue-state-machine.mjs.
//
// RED-BEFORE-GREEN (this project's own standing verification posture): run against the PRE-FIX code
// (`git stash`-equivalent revert of pty/host.ts's CodexLive.bootStuckInfo + getCodexBootStuck and
// mcp/orchestration.ts's codexBootStuck projection) — see the worker report for the exact commands used;
// every check below that references `codexBootStuck` failed (either `undefined` where `null` was
// expected, or the whole tool call rejected as an unknown response key) before the fix, and passes after.
//
// Card 448f1b4a: shrinks live.bootReady's fail-loud ceiling so this test doesn't need a real ~45s wait —
// same technique/constant as codex-queue-state-machine.mjs.
process.env.LOOM_CODEX_BOOT_READY_TIMEOUT_MS = "300";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-codex-boot-stuck-health-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// A fake, fully-scripted codex pty — mirrors codex-queue-state-machine.mjs's makeFakePty exactly (no real
// process, no OS-driven I/O; every "chunk" is pushed directly by this test).
function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  const writes = [];
  return {
    pid: 5150,
    write(data) { writes.push(data); },
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    push(text) { onDataCb?.(text); },
    writes,
  };
}

// Extends the shared claude-side seam (createSeamHost) — this test spawns BOTH a codex worker (scenarios
// 1/3/6, via the createCodexPty override below) and a real claude worker (scenario 4, "codexBootStuck is
// structurally not-applicable"), so both pty seams need faking, not just the codex one.
class FakeCodexHost extends createSeamHost(PtyHost) {
  constructor(events) {
    super(events);
    this.fakeCodexPtys = new Map();
  }
  createCodexPty(opts) {
    const fake = makeFakePty();
    this.fakeCodexPtys.set(opts.sessionId, fake);
    return fake;
  }
}

const bootStuckEvents = [];
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {},
  onBusy() {}, onExit() {},
  onCodexBootStuck(sessionId, info) { bootStuckEvents.push({ sessionId, info }); },
};
const host = new FakeCodexHost(events);

const dbFile = path.join(os.tmpdir(), `loom-codex-boot-stuck-health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-09-19T00:47:09.642Z"; // the real incident's own restart instant — see card bba13405
const projId = "proj-codex-boot-stuck";
const agentId = "agent-codex-boot-stuck";
db.insertProject({ id: projId, name: "CodexBootStuckHealth", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });
// `w-stuck-resumed`: seeded exactly like the real incident's own resumed worker row — processState:"live",
// resumability:"resumable", busy:false — the SAME shape a genuinely healthy idle worker carries.
db.insertSession({ id: "w-stuck-resumed", projectId: projId, agentId, engineSessionId: "eng-w-stuck", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-stuck", harness: "codex" });
db.insertSession({ id: "w-healthy-codex", projectId: projId, agentId, engineSessionId: "eng-w-healthy", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-healthy", harness: "codex" });
db.insertSession({ id: "w-claude", projectId: projId, agentId, engineSessionId: "eng-w-claude", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-claude" });
db.insertSession({ id: "w-not-in-pty", projectId: projId, agentId, engineSessionId: "eng-w-other", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-other", harness: "codex" });

const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; },
};

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub), {}, host);
async function connectAs(sessionId, role) {
  const server = router.buildServer(sessionId, role);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: `codex-boot-stuck-health-test-${sessionId}`, version: "0" });
  await client.connect(clientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  return { call: async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} })) };
}
const mgrClient = await connectAs("mgr", "manager");

try {
  // ============== (1)+(2) A RESUMED codex session that never boots ==============
  {
    const SID = "w-stuck-resumed";
    // `resumeId` set (never a startupPrompt) — mirrors a real daemon-restart resume, exactly the shape
    // the reported incident's own worker was spawned under. The fake pty ignores real argv, but this
    // still exercises the SAME `isCodexResumeSpawn`/no-kickoff-to-deliver code path spawnCodexProcess
    // takes for a genuine resume.
    host.spawn({
      sessionId: SID, cwd: "/fake/codex/worktree-stuck", permission: {}, geometry: { cols: 120, rows: 40 },
      sessionEnv: {}, role: "worker", harness: "codex", resumeId: "engine-session-resumed-abc",
    });
    check("(setup) bootReady is false immediately after a resume spawn with no ready+model-loaded frame fed", host.liveCodex.get(SID).bootReady === false);

    // Never feed a ready/model-loaded frame — this session must never boot, matching the incident.
    await waitUntil(() => bootStuckEvents.some((e) => e.sessionId === SID), { label: "onCodexBootStuck fires for the resumed, never-booting session" });

    check("(1) PtyHost level: getCodexBootStuck reads non-null once the ceiling fires", host.getCodexBootStuck(SID) !== null);

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(1) worker_list: codexBootStuck is non-null, over MCP", row?.codexBootStuck !== null && row?.codexBootStuck !== undefined);
    check("(1) worker_list: codexBootStuck names 'ready marker' and 'model-loaded' as unmet", Array.isArray(row?.codexBootStuck?.unmet) && row.codexBootStuck.unmet.includes("ready marker") && row.codexBootStuck.unmet.includes("model-loaded"));
    check("(1) worker_list: codexBootStuck carries a numeric 'at' and the resolved timeoutMs", typeof row?.codexBootStuck?.at === "number" && row?.codexBootStuck?.timeoutMs === 300);

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(1) worker_status: same non-null shape", status?.codexBootStuck !== null && status?.codexBootStuck !== undefined && Array.isArray(status.codexBootStuck.unmet));

    // (2) THE DEFECT THIS CARD CLOSES: every OTHER health field still reads exactly like a healthy idle
    // worker — codexBootStuck is the ONLY discriminator. Assert the old fields' misleading readings
    // directly, so this test documents (and would catch a regression in) the exact gap the incident found.
    check("(2) worker_status: processState STILL reads 'live' — indistinguishable from healthy on this field alone", status.processState === "live");
    check("(2) worker_status: resumability STILL reads 'resumable' — indistinguishable from healthy on this field alone", status.resumability === "resumable");
    check("(2) worker_status: busy STILL reads false — indistinguishable from healthy on this field alone", status.busy === false);
    check("(2) worker_status: codexBootStuck is what actually discriminates this from a real healthy worker", status.codexBootStuck !== null);
  }

  // ============== (3) A HEALTHY, fully-booted codex worker reads codexBootStuck:null ==============
  {
    const SID = "w-healthy-codex";
    host.spawn({
      sessionId: SID, cwd: "/fake/codex/worktree-healthy", permission: {}, geometry: { cols: 120, rows: 40 },
      sessionEnv: {}, role: "worker", harness: "codex",
    });
    const pty = host.fakeCodexPtys.get(SID);
    pty.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
    check("(3) PtyHost level: bootReady latched for the healthy session", host.liveCodex.get(SID).bootReady === true);
    check("(3) PtyHost level: getCodexBootStuck reads null for a healthy, fully-booted session", host.getCodexBootStuck(SID) === null);

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(3) worker_list: codexBootStuck:null for a healthy codex worker (never fired, not merely absent)", row?.codexBootStuck === null);
    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(3) worker_status: same null", status?.codexBootStuck === null);
  }

  // ============== (4) A CLAUDE worker reads codexBootStuck:null — structurally never applicable ==============
  {
    host.spawn({
      sessionId: "w-claude", cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.deliverHook("w-claude", { hook_event_name: "SessionStart" });
    check("(4) PtyHost level: getCodexBootStuck returns null for a claude-kind Live (never in liveCodex)", host.getCodexBootStuck("w-claude") === null);

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === "w-claude");
    check("(4) worker_list: codexBootStuck:null for a claude worker", row?.codexBootStuck === null);
    const status = await mgrClient.call("worker_status", { workerSessionId: "w-claude" });
    check("(4) worker_status: same null", status?.codexBootStuck === null);
  }

  // ============== (5) NOT LIVE in this process -> codexBootStuck:null over MCP ==============
  {
    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === "w-not-in-pty");
    check("(5) worker_list: a worker never spawned in this process reads codexBootStuck:null", row && row.codexBootStuck === null);
    const status = await mgrClient.call("worker_status", { workerSessionId: "w-not-in-pty" });
    check("(5) worker_status: same null", status.codexBootStuck === null);
  }

  // ============== (6) LATE SELF-RECOVERY clears codexBootStuck on worker_list/worker_status too ==============
  {
    const SID = "w-stuck-resumed";
    const stuckPty = host.fakeCodexPtys.get(SID);
    stuckPty.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
    check("(6) PtyHost level: a LATE boot-readiness still latches normally, clearing bootStuckInfo", host.getCodexBootStuck(SID) === null);

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(6) worker_list: codexBootStuck reverts to null once the session genuinely recovers — not permanently flagged", row?.codexBootStuck === null);
    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(6) worker_status: same null after recovery", status?.codexBootStuck === null);
  }
} finally {
  for (const sid of ["w-stuck-resumed", "w-healthy-codex", "w-claude"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — codexBootStuck (pty/host.ts's getCodexBootStuck, CODEX-ONLY) closes card bba13405's own gap: a resumed codex session wedged before model-loaded reads processState/resumability/busy exactly like a healthy idle worker on worker_list/worker_status, and codexBootStuck is the ONLY field that discriminates it — null for a healthy codex worker, a claude worker, or a session not live in this process, and it clears back to null on a genuine late self-recovery rather than staying permanently flagged."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
