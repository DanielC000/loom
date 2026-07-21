import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// gate_status(opId) (card edc1ec12, Platform-Audit finding 7afa6ea9) — the read-only diagnostic that would
// have instantly falsified "the gate is wedged/flaky" in the audit's cited incident: a caller holding an
// opId from a `run_gate`/`worker_merge_confirm` {status:"pending"} response can check whether that run is
// still queued, actually running (and for how long), or already gone (settled/never existed) — WITHOUT
// waiting for the eventual completion nudge.
//
// Proves:
//   (unit) GateSemaphore.findByOpId locates a RUNNING entry and a QUEUED entry by the opId carried on
//          their GateDescriptor, and returns undefined for an opId with no live entry (never existed, or
//          already settled) — the exact lookup gate_status is built on.
//   (e2e)  SessionService.gateStatus, via the REAL runWorkerGate AND confirmWorkerMergeTracked (an
//          injected `runGate` seam controls timing without a real spawn): "running" while genuinely
//          in-flight, with a plausible elapsedMs, and "not_found" once the op has settled — proving this
//          never surfaces a terminal result itself, only live run state.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gst-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GateSemaphore } = await import("../dist/orchestration/gate-semaphore.js");

const GIT_ID = "-c user.email=gst@loom -c user.name=gst";
const now = new Date().toISOString();

// ── (unit) GateSemaphore.findByOpId ──────────────────────────────────────────────────────────────────
{
  const sem = new GateSemaphore();
  let releaseHolder;
  const holder = () => new Promise((res) => { releaseHolder = res; });
  const pRun = sem.runExclusive(1, { gateType: "merge", projectId: "P", sessionId: "s1", opId: "op-running" }, () => holder());
  const pQueued = sem.runExclusive(1, { gateType: "worker", projectId: "P", sessionId: "s2", opId: "op-queued" }, async () => "second");
  await sleep(20); // let pRun acquire the lane + pQueued queue behind it

  const running = sem.findByOpId("op-running");
  check("(unit) findByOpId locates the RUNNING entry by its descriptor's opId", running !== undefined && running.phase === "running" && running.opId === "op-running");
  const queued = sem.findByOpId("op-queued");
  check("(unit) findByOpId locates the QUEUED entry by its descriptor's opId", queued !== undefined && queued.phase === "queued" && queued.opId === "op-queued");
  check("(unit) an unknown opId returns undefined", sem.findByOpId("nope") === undefined);

  releaseHolder("done");
  await Promise.all([pRun, pQueued]);
  check("(unit) once settled, the SAME opId is no longer found (live-only lookup, never a terminal result)", sem.findByOpId("op-running") === undefined);
}

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# gst\n");
  execSync(`git init -q && git config user.email gst@loom && git config user.name gst && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const dbs = [];
const worktrees = [];
try {
  // ── (e2e, gate kind) sessions.gateStatus reflects a REAL runWorkerGate op's live state ──────────────
  {
    const P = `gst-gate-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P, name: "GST", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    const taskId = `${P}-task`, workerId = `${P}-wkr`;
    db.insertTask({ id: taskId, projectId: P, title: "GST-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId, worktreePath, branch });

    let releaseGate;
    const fakeGate = () => new Promise((res) => { releaseGate = res; });
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    // The injected fakeGate never resolves on its own — runWorkerGate genuinely degrades to pending past
    // SYNC_ATTACH_BUDGET_MS (12s, not injectable — same wait every completion-nudge test already pays).
    const first = await sessions.runWorkerGate(workerId);
    check("(e2e gate) degrades to pending past the sync-wait budget", first.settled === false);
    const opId = first.op.opId;

    const status = sessions.gateStatus(opId);
    check("(e2e gate) gate_status reports state:\"running\" while genuinely in flight", status.state === "running" && status.gateType === "worker");
    check("(e2e gate) elapsedMs is a plausible number (at least the sync-wait budget already elapsed)", typeof status.elapsedMs === "number" && status.elapsedMs >= 0);

    releaseGate({ passed: true });
    await sleep(200); // let the settle .then() microtask actually clear the semaphore registry entry
    const after = sessions.gateStatus(opId);
    check("(e2e gate) once settled, gate_status reports \"not_found\" — it never surfaces a terminal result itself", after.state === "not_found" && after.gateType === null && after.elapsedMs === null);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GateSemaphore.findByOpId locates a running/queued entry by its descriptor's opId (and nothing once settled), and SessionService.gateStatus reports \"running\" with a plausible elapsedMs for a genuinely in-flight gate op and \"not_found\" once it settles — never a terminal result of its own."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
