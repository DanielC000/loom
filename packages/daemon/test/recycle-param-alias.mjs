import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_recycle/recycle_me param-name alias (card 24ea80b2): both tools carry the SAME "handoff
// summary" concept under two different names — worker_recycle takes `handoffSummary`, recycle_me
// takes `continuationPrompt` — so an agent that's used to one tool's name eats a validation
// round-trip calling the other. Fix: BOTH tools now accept BOTH names as aliases at the
// tool-input-schema boundary in mcp/orchestration.ts (each tool's ORIGINAL canonical param still
// works unchanged; the alias is mapped to it before calling into sessions/service.ts, which is
// untouched). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like my-context-gate.mjs: an
// isolated temp DB, the REAL OrchestrationMcpRouter over an in-process MCP InMemoryTransport (no
// HTTP, no daemon, no pty) — `sessions` is a STUB SessionService that just records what it was
// called with, so this test proves the ALIAS RESOLUTION at the tool boundary in isolation from the
// real (heavy, worktree/pty-driving) recycle mechanics already covered by recycle.mjs/recycle-handoff.mjs.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-param-alias.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function tmpDbFile(tag) {
  return path.join(os.tmpdir(), `loom-rpa-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}
function rmDb(file) { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } } }

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const file = tmpDbFile("main");
const db = new Db(file);
const now = new Date().toISOString();
db.insertProject({ id: "pR", name: "Recycle Alias", repoPath: "/r", vaultPath: "/r", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "aR", projectId: "pR", name: "r", startupPrompt: "", position: 0 });
db.insertSession({
  id: "mgrR", projectId: "pR", agentId: "aR", engineSessionId: null, title: null, cwd: "/r",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

// A stub SessionService: records exactly what recycleWorker/recycleManager were called with, so the
// test asserts the ALIAS RESOLUTION happening at the tool boundary (orchestration.ts), not the real
// (heavy) recycle mechanics.
const calls = { recycleWorker: [], recycleManager: [] };
const sessions = {
  async recycleWorker(managerSessionId, workerSessionId, handoffSummary) {
    calls.recycleWorker.push({ managerSessionId, workerSessionId, handoffSummary });
    return { id: `fresh-${calls.recycleWorker.length}`, gen: 1, recycledFrom: workerSessionId };
  },
  async recycleManager(oldManagerId, continuationPrompt) {
    calls.recycleManager.push({ oldManagerId, continuationPrompt });
    return { id: `fresh-mgr-${calls.recycleManager.length}`, gen: 1 };
  },
};

try {
  const server = new OrchestrationMcpRouter(db, sessions).buildServer("mgrR", "manager");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "recycle-param-alias-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // ===================== worker_recycle =====================
  // (1) The ORIGINAL canonical `handoffSummary` param still works unchanged (no regression).
  const r1 = await call("worker_recycle", { workerSessionId: "wkr1", handoffSummary: "HS-canonical" });
  check("(1) worker_recycle({handoffSummary}) still works (regression)", r1.newWorkerSessionId === "fresh-1" && !r1.error);
  check("(1) worker_recycle({handoffSummary}) — sessions.recycleWorker got the handoffSummary text",
    calls.recycleWorker[0].handoffSummary === "HS-canonical");

  // (2) The NEW `continuationPrompt` alias (recycle_me's name for the same concept) resolves too.
  const r2 = await call("worker_recycle", { workerSessionId: "wkr2", continuationPrompt: "CP-as-alias" });
  check("(2) worker_recycle({continuationPrompt}) — alias accepted, no schema-validation error", r2.newWorkerSessionId === "fresh-2" && !r2.error);
  check("(2) worker_recycle({continuationPrompt}) — the aliased text reached sessions.recycleWorker as the handoff summary",
    calls.recycleWorker[1].handoffSummary === "CP-as-alias");

  // (3) If BOTH are given, the tool's own canonical `handoffSummary` wins.
  const r3 = await call("worker_recycle", { workerSessionId: "wkr3", handoffSummary: "HS-wins", continuationPrompt: "CP-loses" });
  check("(3) worker_recycle({handoffSummary, continuationPrompt}) — handoffSummary (canonical) wins",
    calls.recycleWorker[2].handoffSummary === "HS-wins");

  // (4) Neither given → a clear error, not a schema-validation throw.
  const r4 = await call("worker_recycle", { workerSessionId: "wkr4" });
  check("(4) worker_recycle({}) — neither param → explicit error naming both", typeof r4.error === "string" && r4.error.includes("handoffSummary") && r4.error.includes("continuationPrompt"));
  check("(4) worker_recycle({}) — sessions.recycleWorker was NOT called for the missing-param case", calls.recycleWorker.length === 3);

  // ===================== recycle_me =====================
  // (5) The ORIGINAL canonical `continuationPrompt` param still works unchanged (no regression).
  const m1 = await call("recycle_me", { continuationPrompt: "CP-canonical" });
  check("(5) recycle_me({continuationPrompt}) still works (regression)", m1.newManagerSessionId === "fresh-mgr-1" && !m1.error);
  check("(5) recycle_me({continuationPrompt}) — sessions.recycleManager got the continuationPrompt text",
    calls.recycleManager[0].continuationPrompt === "CP-canonical");

  // (6) The NEW `handoffSummary` alias (worker_recycle's name for the same concept) resolves too.
  const m2 = await call("recycle_me", { handoffSummary: "HS-as-alias" });
  check("(6) recycle_me({handoffSummary}) — alias accepted, no schema-validation error", m2.newManagerSessionId === "fresh-mgr-2" && !m2.error);
  check("(6) recycle_me({handoffSummary}) — the aliased text reached sessions.recycleManager as the continuation prompt",
    calls.recycleManager[1].continuationPrompt === "HS-as-alias");

  // (7) If BOTH are given, the tool's own canonical `continuationPrompt` wins.
  const m3 = await call("recycle_me", { continuationPrompt: "CP-wins", handoffSummary: "HS-loses" });
  check("(7) recycle_me({continuationPrompt, handoffSummary}) — continuationPrompt (canonical) wins",
    calls.recycleManager[2].continuationPrompt === "CP-wins");

  // (8) Neither given → a clear error, not a schema-validation throw.
  const m4 = await call("recycle_me", {});
  check("(8) recycle_me({}) — neither param → explicit error naming both", typeof m4.error === "string" && m4.error.includes("continuationPrompt") && m4.error.includes("handoffSummary"));
  check("(8) recycle_me({}) — sessions.recycleManager was NOT called for the missing-param case", calls.recycleManager.length === 3);

  await client.close();
} finally {
  db.close();
  rmDb(file);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_recycle and recycle_me each accept BOTH `handoffSummary` and `continuationPrompt` as aliases at the tool boundary (mapped to the existing sessions/service.ts arg, untouched), each tool's original canonical param still works unchanged, and omitting both errors clearly instead of throwing a schema-validation error."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
