import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// GATE_STATUS TIMING-BAND WIRING test (card 19c0ef1e). `gate-timing-band.mjs` already proves
// `computeGateTimingBand`'s own logic (stratification, self-exclusion, the complete+zero-failure filter,
// bounded reads) in isolation; this proves the wiring the card's DoD actually asked for — that a REAL
// `gate_status(opId)` MCP tool call, for a REAL settled worker-gate op, returns a `timingBand` computed
// from that op's own gate-timing NDJSON row, at the ACTUAL MCP tool-call boundary (not just the service
// method) — the "a read path a manager will actually use" requirement.
//
// RED-PROVEN per /worker doctrine: hand-verified to FAIL against the pre-card dist (no `timingBand` field
// existed on the return type or the handler at all, so `status.timingBand` read `undefined` even with a
// matching NDJSON row present).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-status-timing-band.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gstb-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { GATE_TIMING_NDJSON_PATH } = await import("../dist/orchestration/gate-timing-band.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID = "-c user.email=gstb@loom -c user.name=gstb";
const now = new Date().toISOString();

function ndjsonRow(obj) {
  return JSON.stringify(obj) + "\n";
}

const dbs = [];
const worktrees = [];
try {
  const P = `gstb-${Date.now()}`;
  const repo = path.join(os.tmpdir(), `${P}-repo`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# gstb\n");
  execSync(`git init -q && git config user.email gstb@loom && git config user.name gstb && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

  const db = new Db();
  dbs.push(db);
  db.insertProject({ id: P, name: "GSTB", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
  const taskId = `${P}-task`, workerId = `${P}-wkr`;
  db.insertTask({ id: taskId, projectId: P, title: "GSTB-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, P, taskId);
  worktrees.push(worktreePath);
  db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId, worktreePath, branch });

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const fastGate = async () => ({ passed: true });
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fastGate });

  const result = await sessions.runWorkerGate(workerId);
  check("(precondition) the gate settles INLINE and passes", result.settled === true && result.ok === true && result.value.passed === true);
  const opId = result.value.opId;
  check("(precondition) a real opId was minted", typeof opId === "string" && opId.length > 0);

  // Fabricate the gate-timing NDJSON exactly as test-daemon.mjs's appendGateTimingRow would have, for
  // THIS op's own opId — proving the join key (LOOM_GATE_OP_ID -> run-summary.opId) that makes this
  // feature possible in production. Several historical CLEAN runs in the SAME stratum give a real band.
  fs.mkdirSync(path.dirname(GATE_TIMING_NDJSON_PATH), { recursive: true });
  let ndjson = "";
  ndjson += ndjsonRow({ kind: "run-summary", opId: "hist-1", poolSize: 3, testCount: 700, executedCount: 700, failedCount: 0, durationMs: 800_000 });
  ndjson += ndjsonRow({ kind: "run-summary", opId: "hist-2", poolSize: 3, testCount: 700, executedCount: 700, failedCount: 0, durationMs: 900_000 });
  ndjson += ndjsonRow({ kind: "run-summary", opId: "hist-3-failed", poolSize: 3, testCount: 700, executedCount: 700, failedCount: 1, durationMs: 5_000_000 });
  ndjson += ndjsonRow({ kind: "run-summary", opId, poolSize: 3, testCount: 700, executedCount: 700, failedCount: 0, durationMs: 850_000 });
  fs.writeFileSync(GATE_TIMING_NDJSON_PATH, ndjson);
  registerForCleanup(path.dirname(GATE_TIMING_NDJSON_PATH));

  // ── At the service layer — `timingBand` is DELIBERATELY NOT wired here (card 19c0ef1e): it's attached
  // only at the MCP tool-call boundary below, so `SessionService.gateStatus` (extensively tested
  // elsewhere, e.g. gate-status.mjs/gate-status-reduced-gate-facts.mjs) stays byte-identical and
  // synchronous — `computeGateTimingBand` is async (it reads a file) and gate_status is not. ─────────────
  const status = sessions.gateStatus(opId);
  check("(service) settled and passed", status.state === "settled" && status.passed === true);
  check("(service) timingBand is NOT present here by design — only at the MCP tool boundary below", status.timingBand === undefined);

  // ── At the REAL MCP tool-call boundary (manager surface) — the actual DoD-1 "read path" ─────────────────
  const router = new OrchestrationMcpRouter(db, sessions);
  const server = router.buildServer(workerId, "worker");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "gate-status-timing-band", version: "0" });
  await client.connect(clientT);
  const toolStatus = JSON.parse((await client.callTool({ name: "gate_status", arguments: { opId } })).content[0].text);
  await client.close();

  check("(MCP tool call) gate_status reports the same settled/passed verdict", toolStatus.state === "settled" && toolStatus.passed === true);
  check("(MCP tool call — THE FIX) timingBand is present at the actual tool-call boundary", toolStatus.timingBand !== undefined);
  const band = toolStatus.timingBand;
  check("(MCP tool call) band echoes THIS op's own stratum (poolSize:3, testCount:700)", band?.poolSize === 3 && band?.testCount === 700);
  // Only testCount:700 exists anywhere in this fixture, so there is nothing for MIN_BAND_N widening to
  // reach even though the clean count (2) is below the widen threshold — testCountSpan stays degenerate.
  check("(MCP tool call) testCountSpan stays [700,700] — nothing else in the fixture to widen into", band?.testCountSpan?.[0] === 700 && band?.testCountSpan?.[1] === 700);
  check("(MCP tool call) n excludes the failing historical run — only the 2 clean ones", band?.n === 2);
  check("(MCP tool call) nExact equals n (no widening possible in this fixture)", band?.nExact === 2);
  check("(MCP tool call) nUnfiltered counts all 3 historical rows (2 clean + 1 failed), excluding this run itself", band?.nUnfiltered === 3);
  check("(MCP tool call) medianSec is the average of the 2 clean historical runs (800s, 900s) = 850s", band?.medianSec === 850);
  check("(MCP tool call) instrument names its producer", typeof band?.instrument === "string" && band.instrument.includes("durationMs"));
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 19c0ef1e: gate_status(opId), at the real MCP tool-call boundary, now returns a timingBand for a settled op whose opId has a matching gate-timing NDJSON row — stratified, self-excluded, and filtered to clean historical runs, exactly as computeGateTimingBand's own unit test proves in isolation."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
