import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_list/worker_status `contextTelemetry` signal test (card 5a8a74e1).
//
// THE DEFECT THIS CLOSES: worker-status-projection-guard.mjs only pins that `contextTelemetry` is PRESENT
// in the response's key set — it never asserts what VALUE the field actually carries. A key-presence pin
// would stay green even if `contextTelemetryFor` were silently swapped for a function that always returns
// `true`, or if a placeholder row's `null` regressed to a plain `false` — exactly the "unknown rendered as
// a confident value" inversion this card exists to prevent. This test drives the real
// `contextTelemetryFor`/`HarnessCapabilities.contextTelemetry` wiring through the REAL worker_list/
// worker_status tools and asserts the VALUE on every row shape that carries the field.
//
// HERMETIC, NO claude, NO real spawn/merge — mirrors worker-never-completed-turn-signal.mjs's pattern
// exactly: a real Db with real worker rows, driven through the REAL manager MCP tools (worker_list/
// worker_status) over an InMemoryTransport pair, with a stub `sessions` for the placeholder-row surfaces.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-context-telemetry-signal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(os.tmpdir(), `loom-wcts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-09-22T12:00:00.000Z";
const projId = "proj-wcts";
const agentId = "agent-wcts";
db.insertProject({ id: projId, name: "WCTS", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });

// (w-claude) harness OMITTED entirely — the real shape every existing claude worker row has (harness has
// no explicit "claude" literal anywhere; absence IS the shipped default — card 41f35bfe).
db.insertSession({ id: "w-claude", projectId: projId, agentId, engineSessionId: "eng-w-claude", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: true, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-claude" });
// (w-codex) harness explicitly "codex" — the structurally-unmeasurable case this card exists to surface.
db.insertSession({ id: "w-codex", projectId: projId, agentId, engineSessionId: "eng-w-codex", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: true, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-codex", harness: "codex" });
// (w-codex-archived) a FIFTH row shape: a real Session (harness "codex") surfaced via the
// `archivedUnreported` placeholder category, which projects `contextTelemetry` the same way the live-
// worker rows above do (`contextTelemetryFor(w.harness)`) but through a different call site — flagged at
// merge review as untested (card 5a8a74e1).
db.insertSession({ id: "w-codex-archived", projectId: projId, agentId, engineSessionId: "eng-w-codex-archived", title: null, cwd: projId, processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-codex-archived", harness: "codex" });
db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: "mgr", workerSessionId: "w-codex-archived", taskId: "task-codex-archived", kind: "worker_exited_without_report", detail: {} });

const PENDING_SPAWN = { opId: "op-sp-1", kind: "spawn", key: "spawn:task-spawning", managerSessionId: "mgr", startedAt: now, state: "running", taskId: "task-spawning" };
const CAP_QUEUED = { opId: "op-cq-1", agentId, taskId: "task-capq", kickoffLabel: "cap-queued worker", queuedAt: now };
const DANGLING = { workerSessionId: "w-dangling", taskId: "task-dangling", branch: "loom/w-dangling", worktreePath: "/tmp/wcts-dangling", lastActivity: now };

const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return [PENDING_SPAWN]; },
  listCapQueuedSpawns(managerSessionId) { return managerSessionId === "mgr" ? [CAP_QUEUED] : []; },
  isArchivedWithoutReport(id) { return id === "w-codex-archived"; },
  async getDanglingWorkers() { return [DANGLING]; },
};

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const server = router.buildServer("mgr", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "worker-context-telemetry-signal-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} }));

try {
  const list = await call("worker_list");

  const claude = list.find((w) => w.workerSessionId === "w-claude");
  check("(w-claude) worker_list: contextTelemetry is true (claude has hook-based capture)", claude && claude.contextTelemetry === true);

  const codex = list.find((w) => w.workerSessionId === "w-codex");
  check("(w-codex) worker_list: contextTelemetry is false (no hook relay — see codex-adapter.ts's own doc)", codex && codex.contextTelemetry === false);
  check("(w-claude) vs (w-codex): SAME null ctxInputTokens signature (both never completed a turn), DIFFERENT contextTelemetry — the exact discrimination this field exists to provide", claude.ctxInputTokens === codex.ctxInputTokens && claude.contextTelemetry !== codex.contextTelemetry);

  // --- worker_status carries the same field, same values, for a single worker ---
  const statusClaude = await call("worker_status", { workerSessionId: "w-claude" });
  check("(w-claude) worker_status: contextTelemetry true, matching worker_list", statusClaude.contextTelemetry === true);
  const statusCodex = await call("worker_status", { workerSessionId: "w-codex" });
  check("(w-codex) worker_status: contextTelemetry false, matching worker_list", statusCodex.contextTelemetry === false);

  // --- THE BRANCH MOST LIKELY TO REGRESS SILENTLY (flagged at merge review): every placeholder row with
  // no live pty or no tracked harness must read `null` — NEVER a silent `false`, which would misreport a
  // genuinely-undetermined harness as "structurally unmeasurable" instead of "not yet knowable here". ---
  const pendingSpawn = list.find((w) => w.workerSessionId === null && w.pendingSpawn);
  check("(pendingSpawn placeholder) contextTelemetry is null — no worktree/pty exists yet, not a measured false", pendingSpawn && pendingSpawn.contextTelemetry === null);
  check("(pendingSpawn placeholder) contextTelemetry is null, NOT the boolean false (strict, not merely falsy)", pendingSpawn.contextTelemetry !== false);

  const capQueued = list.find((w) => w.workerSessionId === null && w.capQueued);
  check("(capQueued placeholder) contextTelemetry is null — the intent never started at all", capQueued && capQueued.contextTelemetry === null);
  check("(capQueued placeholder) contextTelemetry is null, NOT the boolean false (strict, not merely falsy)", capQueued.contextTelemetry !== false);

  const dangling = list.find((w) => w.processState === "dangling");
  check("(dangling placeholder) contextTelemetry is null — harness isn't tracked on an already-stopped DanglingWorkerEntry", dangling && dangling.contextTelemetry === null);
  check("(dangling placeholder) contextTelemetry is null, NOT the boolean false (strict, not merely falsy)", dangling.contextTelemetry !== false);

  // --- THE FIFTH ROW SHAPE, flagged at merge review: `archivedUnreported` is a REAL Session (harness IS
  // tracked, unlike the three placeholders above), so it must read the MEASURED value, not null. ---
  const archivedUnreported = list.find((w) => w.workerSessionId === "w-codex-archived");
  check("(archivedUnreported row) is actually present in worker_list", !!archivedUnreported && archivedUnreported.archivedWithoutReport === true);
  check("(archivedUnreported row) contextTelemetry is false — same codex harness, same contextTelemetryFor call, a DIFFERENT call site (fleetView's archivedUnreported map, not the live-worker map)", archivedUnreported.contextTelemetry === false);
} finally {
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_list/worker_status's `contextTelemetry` reads true for claude, false for codex (a genuinely measured value, not a key-presence pin alone), null (never a silent false) on every placeholder row with no determinable harness, and the measured false value on the archivedUnreported row's own separate call site too."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
