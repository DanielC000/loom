import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_list/worker_status INTRA-TURN liveness signal test.
//
// SYMPTOM this closes: a worker busy in one long engine turn shows a FROZEN `lastActivity` (that
// DB-persisted timestamp only moves at turn boundaries — hook events), so a healthy long-running turn
// was indistinguishable from a genuine wedge without spending a worker_transcript pull. FIX: surface
// `lastEngineOutputAt` — pty/host.ts's in-memory `Live.lastOutputAt`, already stamped on every engine-
// output chunk (it already fed the busy-stale self-heal) — on worker_list/worker_status, distinct from
// the DB `lastActivity`.
//
// HERMETIC: a REAL PtyHost (like pty-busy-drain.mjs) driven by a FAKE pty injected via the createPty()
// seam — no real claude, no daemon — wired into a REAL OrchestrationMcpRouter (like
// worker-list-pending-ops.mjs) over a real Db + InMemoryTransport. Proves:
//   1. lastEngineOutputAt ADVANCES as simulated engine-output chunks land, within a single turn (no
//      Stop/hook boundary in between) — both at the PtyHost level and through worker_list/worker_status.
//   2. It stays DISTINCT from lastActivity: the DB lastActivity is seeded once and never moves in this
//      test, while lastEngineOutputAt keeps advancing — the two fields track different things.
//   3. A worker producing NO further output shows a STALE lastEngineOutputAt (the wedge case): it freezes
//      once the fake engine stops emitting, even though time keeps passing.
//   4. Byte-compatible: every existing worker_list/worker_status field is unchanged, and a router built
//      WITHOUT a pty (the pre-existing 3-arg constructor call every other test uses) still works — every
//      row just reads lastEngineOutputAt:null instead of throwing.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-liveness-signal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Hermetic LOOM_HOME (paths.ts/host.ts read LOOM_HOME/LOGS_DIR as MODULE-TOP-LEVEL consts, fixed
// at first import) — set it BEFORE any dist/ import, and import everything dynamically so nothing
// resolves paths.ts against a stale env (e.g. the outer test-daemon.mjs harness's own per-test
// LOOM_HOME, whose logs/ dir this test never created). A static top-of-file `import` would be hoisted
// and run before this line regardless of source order — hence dynamic import() for every dist/ module. ---
const tmpHome = path.join(os.tmpdir(), `loom-liveness-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- A fake IPty whose onData callback is CAPTURED so the test can feed simulated engine-output
// chunks on demand (unlike pty-busy-drain.mjs's inert onData, we need to actually invoke it here). ---
const fakes = [];
function makeFakePty() {
  const writes = [];
  let dataCb = () => {};
  const fake = {
    pid: 5150,
    write: (d) => { writes.push(d); },
    onData: (cb) => { dataCb = cb; return { dispose() { dataCb = () => {}; } }; },
    onExit: () => ({ dispose() {} }),
    kill: () => {},
    resize: () => {},
    writes,
    emit: (chunk) => dataCb(chunk),
  };
  fakes.push(fake);
  return fake;
}

class TestPtyHost extends PtyHost {
  createPty() { return makeFakePty(); }
}

const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
};

const dbFile = path.join(os.tmpdir(), `loom-liveness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const seededActivity = "2026-07-04T12:00:00.000Z"; // frozen — never touched again in this test
const projId = "proj-liveness";
const agentId = "agent-liveness";
db.insertProject({ id: projId, name: "Liveness", repoPath: projId, vaultPath: projId, config: {}, createdAt: seededActivity, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });
db.insertSession({ id: "w-live", projectId: projId, agentId, engineSessionId: "eng-w-live", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: true, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-live" });
db.insertSession({ id: "w-not-in-pty", projectId: projId, agentId, engineSessionId: "eng-w-other", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-other" });

const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
};

const host = new TestPtyHost(events);
host.spawn({
  sessionId: "w-live",
  cwd: tmpHome,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 },
  sessionEnv: {},
});
const fake = fakes[0];
host.deliverHook("w-live", { hook_event_name: "SessionStart" });

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub), {}, host);
const server = router.buildServer("mgr", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "worker-liveness-signal-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} }));

try {
  // ===================== (1) PtyHost-level: getLastOutputAt advances on each output chunk =====================
  const t0 = host.getLastOutputAt("w-live");
  check("(1) getLastOutputAt seeded a number at spawn time", typeof t0 === "number");

  await sleep(30);
  fake.emit("assistant is thinking...\n");
  const t1 = host.getLastOutputAt("w-live");
  check("(1) getLastOutputAt ADVANCED after a simulated engine-output chunk", typeof t1 === "number" && t1 > t0);

  await sleep(30);
  fake.emit("...still working, tool call in flight...\n");
  const t2 = host.getLastOutputAt("w-live");
  check("(1) getLastOutputAt ADVANCES AGAIN on a second chunk — WITHIN the same turn (no Stop/hook in between)", t2 > t1);

  // ===================== (2) worker_list/worker_status surface it, distinct from lastActivity =====================
  const list = await call("worker_list");
  const live = list.find((w) => w.workerSessionId === "w-live");
  check("(2) worker_list row exposes lastEngineOutputAt", live && typeof live.lastEngineOutputAt === "number");
  check("(2) worker_list's lastEngineOutputAt matches the PtyHost's live value", live.lastEngineOutputAt === t2);
  check("(2) lastActivity is UNCHANGED (still the seeded DB value) — it never moved", live.lastActivity === seededActivity);
  check("(2) lastEngineOutputAt is far more recent than lastActivity — they track DIFFERENT things", live.lastEngineOutputAt > Date.parse(seededActivity));

  const status = await call("worker_status", { workerSessionId: "w-live" });
  check("(2) worker_status also exposes lastEngineOutputAt, matching worker_list", status.lastEngineOutputAt === live.lastEngineOutputAt);
  check("(2) worker_status's lastActivity is likewise the frozen DB value", status.lastActivity === seededActivity);

  // Existing fields stay byte-compatible alongside the new one.
  check("(2) existing fields (busy/processState/branch) are untouched", live.busy === true && live.processState === "live" && live.branch === null);

  await sleep(30);
  fake.emit("final chunk before the turn ends...\n");
  const list2 = await call("worker_list");
  const live2 = list2.find((w) => w.workerSessionId === "w-live");
  check("(2) a THIRD chunk advances lastEngineOutputAt again, read live through worker_list", live2.lastEngineOutputAt > live.lastEngineOutputAt);

  // ===================== (3) the wedge case: no further output → the signal goes STALE =====================
  const staleBaseline = live2.lastEngineOutputAt;
  await sleep(60); // time passes, but the fake engine emits NOTHING more
  const list3 = await call("worker_list");
  const live3 = list3.find((w) => w.workerSessionId === "w-live");
  check("(3) with no further engine output, lastEngineOutputAt FREEZES (does not advance) — the wedge signal", live3.lastEngineOutputAt === staleBaseline);
  check("(3) meanwhile real time has clearly moved past it", Date.now() - live3.lastEngineOutputAt >= 60);

  // ===================== (4) a session this PtyHost never spawned reads null, not a throw =====================
  const other = list3.find((w) => w.workerSessionId === "w-not-in-pty");
  check("(4) a worker not live in THIS process reads lastEngineOutputAt:null (no crash)", other && other.lastEngineOutputAt === null);

  // ===================== (4b) byte-compat: a router built the OLD way (no pty arg) still works =====================
  const routerNoPty = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
  const serverNoPty = routerNoPty.buildServer("mgr", "manager");
  const [clientT2, serverT2] = InMemoryTransport.createLinkedPair();
  await serverNoPty.connect(serverT2);
  const client2 = new Client({ name: "worker-liveness-signal-nopty-test", version: "0" });
  await client2.connect(clientT2);
  const list4 = JSON.parse((await client2.callTool({ name: "worker_list", arguments: {} })).content[0].text);
  check("(4b) a 3-arg (no pty) router still returns worker_list without throwing", Array.isArray(list4) && list4.length === 2);
  check("(4b) every row reads lastEngineOutputAt:null when no PtyHost was wired", list4.every((w) => w.lastEngineOutputAt === null));
} finally {
  try { host.stop("w-live", "hard"); } catch { /* ignore */ }
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — lastEngineOutputAt (pty/host.ts's Live.lastOutputAt, surfaced on worker_list/worker_status) ADVANCES on every simulated engine-output chunk WITHIN a single turn, stays distinct from the turn-boundary lastActivity, freezes (goes stale) once output stops — the wedge signal — and is fully byte-compatible: a router built without a PtyHost still works, reading null."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
