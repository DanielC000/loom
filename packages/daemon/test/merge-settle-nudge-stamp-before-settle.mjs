import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card bba7a8ec (Code Review BLOCKING 1, ccb407eb durability) — a settle nudge's build stamp needs a deploy-
// staleness read (git, async). The op's settle marks its `pending_gate_ops` row settled SYNCHRONOUSLY, and boot's
// reconcile only recovers rows still `pending`; so a git await BETWEEN settle and enqueue would lose the one-shot
// terminal nudge to a restart in that window. The read must happen inside the op body, BEFORE settle, leaving
// settle → enqueue as one synchronous span.
//
// Drives the REAL SessionService.confirmWorkerMergeTracked down its async settle path (tiny sync budget + a
// slow throwing gate ⇒ `[loom:merge-unknown]`), UNPINNED (no staleness override): `resolveDeployStalenessAsync`
// is replaced by a 60 ms recording stub, `db.settlePendingGateOp` and the pty enqueue are wrapped, and the
// global ORDER of those three events is asserted.
//   (1) order is exactly [read, settle, enqueue] — the read precedes settle and nothing awaits in between.
//   (2) the nudge carries the stamp the pre-settle read produced ("[build: current ...").
//   (3) a REJECTING staleness read still delivers the nudge, with the honest "[build: not measured]" stamp.
// RED by a source mutant that drops the pre-settle read (stamp stays "not measured", read never precedes settle).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { STAMPED_STALENESS } from "./_deploy-staleness-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mssb-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mssb@loom -c user.name=mssb";
const now = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEST_SYNC_BUDGET_MS = 100; // forces the async settle path (the one that pushes a completion nudge)
const SLOW_THROW_MS = 400;

async function scenario(sfx, stalenessRead) {
  const reposDir = path.join(os.tmpdir(), `loom-mssb-repo-${sfx}`);
  registerForCleanup(reposDir);
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mssb\n");
  execSync(`git init -q && git config user.email mssb@loom && git config user.name mssb`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);

  const db = new Db();
  const mgrId = `mssb-mgr-${sfx}`, projId = `mssb-p-${sfx}`, taskId = `mssb-t-${sfx}`, workerId = `mssb-w-${sfx}`;
  db.insertProject({ id: projId, name: "MSSB", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MSSB-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, branch, worktreePath });

  const order = [];
  const calls = [];
  const pty = {
    stop() {}, isAlive() { return false; }, getPid() { return undefined; },
    enqueueStdin(sessionId, text) { calls.push({ sessionId, text }); if (sessionId === mgrId && /\[loom:merge-unknown\]/.test(text)) order.push("enqueue"); return { delivered: true }; },
  };
  const realSettle = db.settlePendingGateOp.bind(db);
  db.settlePendingGateOp = (...a) => { order.push("settle"); return realSettle(...a); };

  const sessions = new SessionService(db, pty, new OrchestrationControl(), {
    runGate: async () => { await sleep(SLOW_THROW_MS); throw new Error("Cannot use simple-git on a directory that does not exist"); },
    syncAttachBudgetMs: TEST_SYNC_BUDGET_MS,
    // deliberately NO `deployStaleness` pin: the stamp must come from the (replaced) async read below.
  });
  const claim = []; // [read, release]: the task claim must outlive the stamp read (card bba7a8ec S3)
  const realClear = sessions.clearMergeInFlightForTask.bind(sessions);
  sessions.clearMergeInFlightForTask = (...a) => { claim.push("release"); return realClear(...a); };
  sessions.resolveDeployStalenessAsync = async () => { order.push("read"); claim.push("read"); await sleep(60); return stalenessRead(); };

  const pending = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  const settled = pending.settled === false ? await sessions.pendingOps.awaitSettleByOpId(pending.op.opId, 30_000) : null;
  const nudge = calls.find((c) => c.sessionId === mgrId && /\[loom:merge-unknown\]/.test(c.text));
  db.close();
  return { pending, settled, order, nudge, claim };
}

// (1)+(2): a normal read
{
  const r = await scenario(`a-${Date.now()}`, () => STAMPED_STALENESS);
  check("(fixture) the confirm degraded to the async settle path and settled", r.pending.settled === false && r.settled !== null);
  check(`(1) the global order is exactly [read, settle, enqueue] — the staleness read precedes settle, and settle → enqueue has no git await between them (got ${JSON.stringify(r.order)})`,
    JSON.stringify(r.order) === JSON.stringify(["read", "settle", "enqueue"]));
  check("(2) the nudge was delivered and carries the stamp the PRE-settle read produced", !!r.nudge && /\[build: current \(running code built 2026-01-01/.test(r.nudge.text));
  check(`(2b) the task claim is released only AFTER the stamp read, never during it (got ${JSON.stringify(r.claim)})`, r.claim[0] === "read" && r.claim.slice(1).length >= 1 && r.claim.slice(1).every((x) => x === "release"));
}
// (3): a REJECTING read
{
  const r = await scenario(`b-${Date.now()}`, () => { throw new Error("boom: git exploded"); });
  check("(3) a rejecting staleness read still delivers the one-shot nudge (never lost to a git failure)", !!r.nudge);
  check("(3) ...with the honest not-measured stamp", !!r.nudge && /\[build: not measured\]/.test(r.nudge.text));
  check(`(3) order still [read, settle, enqueue] (got ${JSON.stringify(r.order)})`, JSON.stringify(r.order) === JSON.stringify(["read", "settle", "enqueue"]));
}

// ================= (4) merge_batch and (5) run_gate: the same [read, settle, enqueue] order, UNPINNED =================
// Each op kind has its OWN stamp-read site (mergeBatchTracked's `.finally`, runWorkerGate's `withSettleStamp`); the solo
// scenario above cannot see a regression in either. A mutant that moves one path's read into its settle callback (an
// `await` between settle and enqueue — the ccb407eb shape) leaves the other paths green and turns THAT path's order RED.
const GATE_PASS = { passed: true, steps: [{ step: "node packages/daemon/test/x.mjs", durationMs: 5, status: 0 }] };

async function batchScenario(sfx) {
  const reposDir = path.join(os.tmpdir(), `loom-mssb-brepo-${sfx}`);
  registerForCleanup(reposDir);
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mssb\n");
  fs.writeFileSync(path.join(repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  fs.mkdirSync(path.join(repo, "packages", "daemon", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(repo, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
  fs.mkdirSync(path.join(repo, "packages", "daemon", "test"), { recursive: true });
  fs.writeFileSync(path.join(repo, "packages", "daemon", "test", "x.mjs"), "// stub\n");
  execSync(`git init -q && git config user.email mssb@loom && git config user.name mssb`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);

  const db = new Db();
  const mgrId = `mssb-bmgr-${sfx}`, projId = `mssb-bp-${sfx}`, agentId = `mssb-bagent-${sfx}`;
  db.insertProject({ id: projId, name: "MSSB", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "node packages/daemon/test/x.mjs" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const workerIds = [];
  for (const n of ["a", "b"]) {
    const taskId = `mssb-bt-${n}-${sfx}`, workerId = `mssb-bw-${n}-${sfx}`;
    db.insertTask({ id: taskId, projectId: projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "src", `${n}.ts`), `export const ${n} = 1;\n`);
    commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    workerIds.push(workerId);
  }

  const order = [];
  const calls = [];
  const pty = {
    stop() {}, isAlive() { return false; }, getPid() { return undefined; },
    enqueueStdin(sessionId, text) { calls.push({ sessionId, text }); if (sessionId === mgrId && /\[loom:merge-batch-/.test(text)) order.push("enqueue"); return { delivered: true }; },
  };
  const realSettle = db.settlePendingGateOp.bind(db);
  db.settlePendingGateOp = (...a) => { order.push("settle"); return realSettle(...a); };
  const sessions = new SessionService(db, pty, new OrchestrationControl(), {
    runGate: async () => { await sleep(SLOW_THROW_MS); return GATE_PASS; },
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
    syncAttachBudgetMs: TEST_SYNC_BUDGET_MS,
  });
  const claim = []; // [read, release, release]: every candidate's task claim must outlive the stamp read (S3)
  const realClear = sessions.clearMergeInFlightForTask.bind(sessions);
  sessions.clearMergeInFlightForTask = (...a) => { claim.push("release"); return realClear(...a); };
  sessions.resolveDeployStalenessAsync = async () => { order.push("read"); claim.push("read"); await sleep(60); return STAMPED_STALENESS; };

  const pending = await sessions.mergeBatchTracked(mgrId, workerIds);
  const settled = pending.settled === false ? await sessions.pendingOps.awaitSettleByOpId(pending.op.opId, 60_000) : null;
  const nudge = calls.find((c) => c.sessionId === mgrId && /\[loom:merge-batch-/.test(c.text));
  db.close();
  return { pending, settled, order, nudge, claim };
}
{
  const r = await batchScenario(`c-${Date.now()}`);
  check("(4 fixture) the batch degraded to the async settle path and settled", r.pending.settled === false && r.settled !== null);
  check(`(4) merge_batch: global order is exactly [read, settle, enqueue] (got ${JSON.stringify(r.order)})`, JSON.stringify(r.order) === JSON.stringify(["read", "settle", "enqueue"]));
  check("(4) merge_batch: the nudge carries the stamp the PRE-settle read produced", !!r.nudge && /\[build: current \(running code built 2026-01-01/.test(r.nudge.text));
  check(`(4b) merge_batch: every task claim is released only AFTER the stamp read (got ${JSON.stringify(r.claim)})`, r.claim[0] === "read" && r.claim.slice(1).length >= 1 && r.claim.slice(1).every((x) => x === "release"));
}

async function runGateScenario(sfx) {
  const reposDir = path.join(os.tmpdir(), `loom-mssb-grepo-${sfx}`);
  registerForCleanup(reposDir);
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mssb\n");
  execSync(`git init -q && git config user.email mssb@loom && git config user.name mssb`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const db = new Db();
  const mgrId = `mssb-gmgr-${sfx}`, projId = `mssb-gp-${sfx}`, agentId = `mssb-gagent-${sfx}`, workerId = `mssb-gw-${sfx}`;
  db.insertProject({ id: projId, name: "MSSB", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node -e "setTimeout(()=>process.exit(0), ${SLOW_THROW_MS})"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const { worktreePath, branch } = await createWorktree(repo, projId, `mssb-gt-${sfx}`);
  registerForCleanup(worktreePath);
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath, branch });

  const order = [];
  const calls = [];
  const pty = {
    stop() {}, isAlive() { return false; }, getPid() { return undefined; },
    enqueueStdin(sessionId, text) { calls.push({ sessionId, text }); if (sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(text)) order.push("enqueue"); return { delivered: true }; },
  };
  const realSettle = db.settlePendingGateOp.bind(db);
  db.settlePendingGateOp = (...a) => { order.push("settle"); return realSettle(...a); };
  const sessions = new SessionService(db, pty, new OrchestrationControl(), { syncAttachBudgetMs: TEST_SYNC_BUDGET_MS });
  sessions.resolveDeployStalenessAsync = async () => { order.push("read"); await sleep(60); return STAMPED_STALENESS; };

  const pending = await sessions.runWorkerGate(workerId);
  const settled = pending.settled === false ? await sessions.pendingOps.awaitSettleByOpId(pending.op.opId, 60_000) : null;
  const nudge = calls.find((c) => c.sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(c.text));
  db.close();
  return { pending, settled, order, nudge };
}
{
  const r = await runGateScenario(`d-${Date.now()}`);
  check("(5 fixture) run_gate degraded to the async settle path and settled", r.pending.settled === false && r.settled !== null);
  check(`(5) run_gate: global order is exactly [read, settle, enqueue] (got ${JSON.stringify(r.order)})`, JSON.stringify(r.order) === JSON.stringify(["read", "settle", "enqueue"]));
  check("(5) run_gate: the nudge carries the stamp the PRE-settle read produced", !!r.nudge && /\[build: current \(running code built 2026-01-01/.test(r.nudge.text));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the settle nudge's staleness read happens before settle, so settle → enqueue is one synchronous span, and a failed read still delivers."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
