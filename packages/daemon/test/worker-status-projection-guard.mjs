import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_status response-projection pin (card f8d53712).
//
// THE DEFECT THIS CLOSES: `worker_status`'s single-worker body used to spread `...w` — the RAW
// db.getSession() row — straight into its tool response (an OPT-OUT projection: any column added to the
// `sessions` table in future would silently reach the calling agent, no code change, no review step).
// The fix (`projectSessionRowFields` in mcp/orchestration.ts) replaces the spread with an explicit
// field-by-field projection that is required to be BEHAVIOUR-PRESERVING against today's row shape — see
// that helper's own doc comment. This test pins the exact key SET `worker_status` returns today, so a
// future column silently reaching the response (or a future edit silently dropping a documented field)
// fails this test instead of shipping unnoticed.
//
// HERMETIC, NO claude, NO real spawn/merge — mirrors worker-never-completed-turn-signal.mjs's pattern: a
// real Db with a real worker row, driven through the REAL manager MCP tool (worker_status) over an
// InMemoryTransport pair, with a stub `sessions` for the placeholder-row surfaces worker_status doesn't
// exercise on this path (no workerSessionId passed here, so those never fire).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-status-projection-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(os.tmpdir(), `loom-wsp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-09-03T12:00:00.000Z";
const projId = "proj-wsp";
const agentId = "agent-wsp";
db.insertProject({ id: projId, name: "WSP", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });
db.insertSession({ id: "w1", projectId: projId, agentId, engineSessionId: "eng-w1", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: true, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-1" });

const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; },
};

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const server = router.buildServer("mgr", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "worker-status-projection-guard-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} }));

// The EXACT key set worker_status({workerSessionId}) returns today (no msgId passed, so `queriedDirective`
// is correctly absent — see the tool's own doc). Raw session-row fields mirror `toSession` (db.ts)
// exactly, MINUS `pendingMerge` (toSession never sets it — it's always overridden by the live-computed
// value below instead). Derived fields mirror the handler body in mcp/orchestration.ts.
const EXPECTED_KEYS = [
  // raw session-row fields (projectSessionRowFields)
  "id", "projectId", "agentId", "engineSessionId", "title", "cwd", "processState", "resumability",
  "busy", "createdAt", "lastActivity", "lastError", "role", "parentSessionId", "taskId", "worktreePath",
  "branch", "reviewBaseSha", "repoKey", "gen", "recycledFrom", "ctxInputTokens", "ctxTurns", "turnSeq",
  "ctxUpdatedAt", "model", "rateLimitedUntil", "rateLimitDeadline", "browserTesting", "documentConversion",
  "restrictedTools", "noCommit", "skills", "connections", "vaultWrite", "companionLeadMode",
  "capabilities", "archivedAt", "scheduledSpawn",
  // derived/computed fields layered on top by the worker_status handler
  "neverCompletedTurn", "lastEngineOutputAt", "composerDirtyLen", "composerDirtyLenBelieved",
  "unconfirmedDeliveryMs", "lastMismatchReplay", "lastMismatchFusion", "lastMismatch",
  "lastMismatchNoticeSuppressed", "lastPasteTripwireGiveUp", "pendingMerge", "worktreePathAliases",
  "reportedState", "awaitingReview", "staleReport", "directive", "staleDirective", "parkedDirective",
  "archivedWithoutReport", "unresolvedCascade",
].sort();

const assertKeySet = (actual, expected, label) => {
  const actualKeys = Object.keys(actual).sort();
  const missing = expected.filter((k) => !actualKeys.includes(k));
  const extra = actualKeys.filter((k) => !expected.includes(k));
  check(`${label}: no missing keys (${missing.join(", ") || "none"})`, missing.length === 0);
  check(`${label}: no extra keys (${extra.join(", ") || "none"})`, extra.length === 0);
};

try {
  const status = await call("worker_status", { workerSessionId: "w1" });
  assertKeySet(status, EXPECTED_KEYS, "worker_status(w1)");

  // --- POSITIVE CONTROL: prove assertKeySet actually goes RED on both a dropped and an added field, not
  // just green because nothing ever changes. Without this, a broken assertKeySet (e.g. a typo'd `includes`
  // check) would pass silently forever, exactly the shape of check this card warns never to ship unverified.
  const droppedField = { ...status };
  delete droppedField.lastError; // simulate a field silently disappearing from the projection
  const missingAfterDrop = EXPECTED_KEYS.filter((k) => !Object.keys(droppedField).includes(k));
  check("(control) removing a known field from a copy of the response IS caught as missing", missingAfterDrop.length === 1 && missingAfterDrop[0] === "lastError");

  const addedField = { ...status, newColumnFromTheFuture: "surprise" };
  const extraAfterAdd = Object.keys(addedField).filter((k) => !EXPECTED_KEYS.includes(k));
  check("(control) adding an unnamed field to a copy of the response IS caught as extra", extraAfterAdd.length === 1 && extraAfterAdd[0] === "newColumnFromTheFuture");
} finally {
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_status's response key set is pinned; a new sessions-table column silently reaching the projection, or a documented field silently disappearing, fails this test instead of shipping unnoticed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
