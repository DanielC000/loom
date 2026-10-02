import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 396d6602 Code Review follow-up: the merge/gate `onSettle` hooks in sessions/service.ts derive and
// persist a verdict (`deriveMergeGateVerdict`/`deriveWorkerGateVerdict` + `db.settlePendingGateOp(opId,
// verdict)`). Before this card, a throw from EITHER step (a bad derive, or the DB write itself — SQLITE_BUSY,
// disk full) left the durable `pending_gate_ops` row stuck at `state:'pending'` forever, even though the op
// itself genuinely settled — the next boot's `reconcileOrphanedGateOps` would then nudge "no verdict was
// ever reached, re-confirm/re-run" for an op that actually merged or passed. Each hook now falls back to a
// verdict-less `settlePendingGateOp(opId)` on that throw, so the row always leaves 'pending'.
//
// This is the INTEGRATION-level proof against the REAL service.ts hooks + a real `pending_gate_ops` table —
// distinct from pending-ops-registry.mjs's UNIT-level proof that a throwing `onSettle` opt itself can't
// corrupt PendingOpRegistry's own in-memory bookkeeping. Both are needed: that file proves the REGISTRY
// isolates the hook; this file proves the PRODUCTION hook's own fallback actually reaches the real DB row.
//
// RED on pre-fix service.ts: `onSettle: (outcome, opId) => { this.db.settlePendingGateOp(opId,
// derive...(outcome)); pruneGateSpillsClassified(this.db); }` had no try/catch at all — a throwing write
// left the row at `state:'pending'` (confirmed by reverting the service.ts hooks to that shape and
// re-running this file: both rows below stayed 'pending' instead of 'settled').
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/pending-gate-op-settle-write-failure.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-pgoswf-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID = "-c user.email=pgoswf@loom -c user.name=pgoswf";
const now = new Date().toISOString();
const dbs = [];
const worktrees = [];

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# pgoswf\n");
  execSync(`git init -q && git config user.email pgoswf@loom && git config user.name pgoswf`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const fakeGatePass = async (gate) => ({ passed: true, steps: [{ step: gate, durationMs: 5, status: 0 }], outputTail: "ok" });

// Throws on the FIRST call that carries a real verdict (the hook's own derive+write), then delegates to
// the real implementation on every later call — including the production hook's own fallback
// verdict-less call, so this proves THAT call actually reaches the real DB row rather than merely
// asserting "something settled it eventually".
function installThrowOnceSettle(db) {
  const real = db.settlePendingGateOp.bind(db);
  let thrown = false;
  db.settlePendingGateOp = (opId, verdict) => {
    if (!thrown && verdict !== undefined) {
      thrown = true;
      throw new Error("simulated settlePendingGateOp verdict write failure (SQLITE_BUSY)");
    }
    return real(opId, verdict);
  };
  return () => thrown;
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

try {
  // ── GATE path (SessionService.runWorkerGate's onSettle hook) ────────────────────────────────────────
  {
    const db = new Db(); dbs.push(db);
    const agentId = `pgoswf-gate-agent-${sfx}`, mgrId = `pgoswf-gate-mgr-${sfx}`;
    const projId = `pgoswf-gate-proj-${sfx}`, workerId = `pgoswf-gate-wkr-${sfx}`;
    const repo = path.join(os.tmpdir(), `loom-pgoswf-gate-${sfx}`);
    const worktreePath = path.join(os.tmpdir(), `loom-pgoswf-gate-wt-${sfx}`);
    db.insertProject({ id: projId, name: "PGOSWF-GATE", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath, branch: "loom/gate-only" });

    const wasThrown = installThrowOnceSettle(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGatePass });
    const r = await sessions.runWorkerGate(workerId);
    check("(gate) precondition: the self-check itself settled normally, unaffected by the throwing write", r.settled === true && r.ok === true && r.value.passed === true);
    check("(gate) precondition: the simulated verdict-write throw actually fired", wasThrown() === true);
    const row = db.findPendingGateOpByOpId(r.value.opId);
    check("(gate) THE FIX: the durable row is SETTLED, not stuck 'pending', despite the verdict write throwing", row.kind === "found" && row.record.state === "settled");
  }

  // ── MERGE path (SessionService.confirmWorkerMergeTracked's onSettle hook) ──────────────────────────
  {
    const db = new Db(); dbs.push(db);
    const agentId = `pgoswf-merge-agent-${sfx}`, mgrId = `pgoswf-merge-mgr-${sfx}`;
    const projId = `pgoswf-merge-proj-${sfx}`, workerId = `pgoswf-merge-wkr-${sfx}`, taskId = `pgoswf-merge-task-${sfx}`;
    const repo = path.join(os.tmpdir(), `loom-pgoswf-merge-${sfx}`);
    makeRepo(repo);
    db.insertProject({ id: projId, name: "PGOSWF-MERGE", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "PGOSWF-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
    commitAll(worktreePath, "feature.txt", GIT_ID);
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    const wasThrown = installThrowOnceSettle(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGatePass });
    const r = await sessions.confirmWorkerMergeUntilSettled(mgrId, workerId);
    if (!r.settled) throw new Error("merge did not settle within confirmWorkerMergeUntilSettled's own bounded ceiling — a genuine stall, not a sync-attach-budget race");
    check("(merge) precondition: the merge itself settled normally, unaffected by the throwing write", r.value.merged === true);
    check("(merge) precondition: the simulated verdict-write throw actually fired", wasThrown() === true);
    const row = db.findPendingGateOpByOpId(r.value.opId);
    check("(merge) THE FIX: the durable row is SETTLED, not stuck 'pending', despite the verdict write throwing", row.kind === "found" && row.record.state === "settled");
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 396d6602 CR follow-up: a throwing verdict derive/write inside the merge/gate " +
    "onSettle hooks (sessions/service.ts) falls back to a verdict-less settle, so the durable " +
    "pending_gate_ops row always leaves 'pending' — never stuck there forever for an op that actually " +
    "settled — on BOTH the gate (runWorkerGate) and merge (confirmWorkerMergeTracked) hooks."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
