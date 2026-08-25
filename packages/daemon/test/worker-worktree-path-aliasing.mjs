import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e55371c1 — `worktreePathAliases` on worker_list/worker_status, the path-keyed worktree-aliasing
// signal that replaces the unsound `gen`/`recycledFrom` reading (that reading tracks RECYCLE CHAINS
// ONLY and gives NO evidence about worktree-path sharing — see db.ts's own doc on
// `listSessionsAtWorktreePath` for the mechanism).
//
// RED-PROOF (this is the whole point of the card): every "aliased" fixture below carries `gen:0` /
// `recycledFrom:null` on BOTH rows — i.e. NEITHER row is part of a recycle chain — so a `gen`/
// `recycledFrom`-based implementation would report these as clean (0 aliases) while the real signal
// must report 1. Cases:
//   (A) two LIVE rows, same worktreePath, neither in a recycle chain → BOTH report worktreePathAliases:1.
//   (B) one LIVE row, unique worktreePath → worktreePathAliases:0 (a MEASURED zero, not a null).
//   (C) MULTI-REPO: two rows, SAME taskId (so the SAME `branch` string, which carries no repo axis) but
//       DIFFERENT repoKey → DIFFERENT worktreePath strings → worktreePathAliases:0 for BOTH. This is the
//       exact case a branch-grouping check gets wrong; matching on the resolved path, not the task or the
//       branch, is what keeps it out.
//   (D) worker_status(id) parity — same value as the worker_list row for the same session.
//   (E) a pendingSpawn placeholder (no worktree exists yet) → worktreePathAliases:null, never 0.
//   (F) the CARD'S OWN COUNTEREXAMPLE SHAPE: one LIVE row + one DANGLING row sharing a worktreePath,
//       neither in a recycle chain → BOTH report worktreePathAliases:1.
//
// HERMETIC — real Db, stubbed SessionService surface (pendingMerge/spawns/dangling), no real git/pty.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-worktree-path-aliasing.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(os.tmpdir(), `loom-wwpa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-08-25T12:00:00.000Z";
const projId = "proj-wwpa";
const agentId = "agent-wwpa";
db.insertProject({ id: projId, name: "WWPA", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });

function seedWorker(id, { taskId, worktreePath, branch, repoKey, archived = false, processState = "live" }) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: worktreePath ?? projId,
    processState, resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "worker", parentSessionId: "mgr", taskId, worktreePath: worktreePath ?? null, branch: branch ?? null,
    repoKey: repoKey ?? null,
    // deliberately DEFAULT gen/recycledFrom (0/null) — NEITHER fixture below is part of a recycle chain,
    // which is the whole point: this proves the signal is NOT derived from gen/recycledFrom.
  });
  if (archived) db.archiveSession(id);
}

// (A) two LIVE rows, one worktreePath, neither in a recycle chain
seedWorker("w-a1", { taskId: "task-a", worktreePath: "WT/proj/aaaa", branch: "loom/aaaa" });
seedWorker("w-a2", { taskId: "task-a", worktreePath: "WT/proj/aaaa", branch: "loom/aaaa" });

// (B) one LIVE row, unique path
seedWorker("w-b1", { taskId: "task-b", worktreePath: "WT/proj/bbbb", branch: "loom/bbbb" });

// (C) multi-repo: same taskId → same branch string, DIFFERENT repoKey → DIFFERENT worktreePath
seedWorker("w-c1", { taskId: "task-c", worktreePath: "WT/proj/repoX/cccc", branch: "loom/cccc", repoKey: "repoX" });
seedWorker("w-c2", { taskId: "task-c", worktreePath: "WT/proj/repoY/cccc", branch: "loom/cccc", repoKey: "repoY" });

// (F) the card's own counterexample shape: LIVE + DANGLING sharing a path, neither recycled
seedWorker("w-f1", { taskId: "task-f", worktreePath: "WT/proj/ffff", branch: "loom/ffff" });
seedWorker("w-f2", { taskId: "task-f", worktreePath: "WT/proj/ffff", branch: "loom/ffff", archived: true, processState: "exited" });

const DANGLING_ENTRY = { workerSessionId: "w-f2", taskId: "task-f", branch: "loom/ffff", worktreePath: "WT/proj/ffff", lastActivity: now };
const PENDING_SPAWN = { opId: "op-spawn-1", kind: "spawn", key: "spawn:task-spawning", managerSessionId: "mgr", startedAt: now, state: "running", taskId: "task-spawning" };

const sessionsStub = {
  peekPendingMerge() { return undefined; },
  gatePhaseForOpId() { return null; },
  listPendingSpawns(managerSessionId) { return managerSessionId === "mgr" ? [PENDING_SPAWN] : []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers(managerSessionId) { return managerSessionId === "mgr" ? [DANGLING_ENTRY] : []; },
};

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const server = router.buildServer("mgr", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "worker-worktree-path-aliasing-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} }));

try {
  const list = await call("worker_list");
  const row = (id) => list.find((w) => w.workerSessionId === id);

  // --- (A) RED-PROOF: gen:0/recycledFrom:null on BOTH rows, yet they must report aliased ---
  check("(A) w-a1 is gen:0/recycledFrom:null (not a recycle chain) — the fixture precondition",
    db.getSession("w-a1").gen === 0 && db.getSession("w-a1").recycledFrom === null);
  check("(A) w-a2 is gen:0/recycledFrom:null (not a recycle chain) — the fixture precondition",
    db.getSession("w-a2").gen === 0 && db.getSession("w-a2").recycledFrom === null);
  check("(A) w-a1 reports worktreePathAliases:1 (RED against a gen/recycledFrom-based check, which would say 0)",
    row("w-a1")?.worktreePathAliases === 1);
  check("(A) w-a2 reports worktreePathAliases:1 (symmetric)", row("w-a2")?.worktreePathAliases === 1);

  // --- (B) MEASURED zero, not aliased ---
  check("(B) w-b1 reports worktreePathAliases:0 — a MEASURED zero (not null)", row("w-b1")?.worktreePathAliases === 0);

  // --- (C) multi-repo: same branch string, different repoKey → NOT aliased ---
  check("(C) w-c1/w-c2 share a branch string", db.getSession("w-c1").branch === db.getSession("w-c2").branch);
  check("(C) w-c1/w-c2 have DIFFERENT worktreePath (repoKey axis)",
    db.getSession("w-c1").worktreePath !== db.getSession("w-c2").worktreePath);
  check("(C) w-c1 reports worktreePathAliases:0 — the multi-repo false-positive case, correctly excluded",
    row("w-c1")?.worktreePathAliases === 0);
  check("(C) w-c2 reports worktreePathAliases:0 (symmetric)", row("w-c2")?.worktreePathAliases === 0);

  // --- (D) worker_status parity ---
  const status = await call("worker_status", { workerSessionId: "w-a1" });
  check("(D) worker_status(w-a1) reports the SAME worktreePathAliases as worker_list", status.worktreePathAliases === 1);

  // --- (E) no worktree yet → null, never 0 ---
  const spawning = list.find((w) => w.processState === "starting");
  check("(E) a pendingSpawn placeholder reports worktreePathAliases:null (no worktree exists yet)",
    spawning && spawning.worktreePathAliases === null);

  // --- (F) the card's own counterexample: LIVE + DANGLING sharing a path, neither recycled ---
  const danglingRow = list.find((w) => w.processState === "dangling" && w.workerSessionId === "w-f2");
  check("(F) w-f1 (gen:0/recycledFrom:null) is gen/recycledFrom-clean — the fixture precondition",
    db.getSession("w-f1").gen === 0 && db.getSession("w-f1").recycledFrom === null);
  check("(F) w-f2 (gen:0/recycledFrom:null) is gen/recycledFrom-clean — the fixture precondition",
    db.getSession("w-f2").gen === 0 && db.getSession("w-f2").recycledFrom === null);
  check("(F) the LIVE row w-f1 reports worktreePathAliases:1 (aliased with the DANGLING row)",
    row("w-f1")?.worktreePathAliases === 1);
  check("(F) the DANGLING row w-f2 ALSO reports worktreePathAliases:1 (symmetric)",
    danglingRow && danglingRow.worktreePathAliases === 1);
} finally {
  db.close();
  fs.rmSync(dbFile, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worktreePathAliases is a real path-keyed signal (RED against gen/recycledFrom-clean fixtures that ARE aliased), correctly excludes the multi-repo same-branch/different-repoKey case, is null (not 0) when no worktree exists yet, and agrees between worker_list and worker_status."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
