import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A landed card's `tasks_get.mergeGate` carries the landing's gate provenance, read from the durable `merge_done` event.
// REAL git on temp repos + an injected `runGate` seam (same harness shape as merge-gate-interval.mjs).
//   (G) a GATED landing: mergeGate {gateRan:true, gateOpId = the merge's own opId, gatedTip = the head that gate ran on,
//       skipReason:null}; the SAME opId + head appear on the build_gate gate_history row (passed, gateRan, gatedTip).
//   (I) an interval-SKIPPED landing: mergeGate {gateRan:false, skipReason:"gate-interval", gateOpId:null, gatedTip:null}
//       and its gate_history row is outcome "skipped" with gatedTip null.
//   (L) a legacy merge_done (no gateProvenance) reads gateRan:null (unknown), never false; a card with no landing reads null.
// NOT COVERED: the batch (merge_batch) stamp, the reused-self-check and inert-docs-only stamps (same producer line, different inputs).
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-provenance.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";
const noReap = async () => ({ killedPids: [] });

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mgprov-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { getProjectTask, resolveMergeGateProvenance } = await import("../dist/mcp/tasks.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mgprov@loom -c user.name=mgprov";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const SHA40 = /^[0-9a-f]{40}$/;

const P = { projId: `mgprov-proj-${sfx}`, agentId: `mgprov-agent-${sfx}`, mgrId: `mgprov-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mgprov-${sfx}`) };
mkdirp(P.repo);
registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# mgprov\n");
execSync(`git init -q && git config user.email mgprov@loom && git config user.name mgprov`, { cwd: P.repo });
commitAll(P.repo, "init", GIT_ID);

const db = new Db();
// Interval N=1 with the gate off: landing 1 goes ungated, landing 2 is the periodic GATED landing.
db.insertProject({ id: P.projId, name: "MGPROV", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate", mergeGate: "off", mergeGateInterval: 1 } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
let gateCalls = 0;
const sessions = new SessionService(db, { stop() {}, isAlive() { return false; }, enqueueStdin() {} }, new OrchestrationControl(), {
  syncAttachBudgetMs: 60_000,
  runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
  reapWorktreeProcesses: noReap,
});
const worktrees = [];
async function addWorker(n) {
  const taskId = `mgprov-${n}-task-${sfx}`;
  const workerId = `mgprov-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  worktrees.push(worktreePath);
  mkdirp(path.join(worktreePath, "src"));
  fs.writeFileSync(path.join(worktreePath, "src", `${n}.ts`), `export const ${n} = 1;\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
const confirm = async (workerId) => {
  const r = await awaitTrackedSettle(() => sessions.confirmWorkerMergeTracked(P.mgrId, workerId), { label: "confirmWorkerMergeTracked", timeoutMs: 240_000, pendingOps: sessions.pendingOps });
  return r.ok ? r.value : { __unsettled: r };
};

try {
  const w1 = await addWorker("a");
  const w2 = await addWorker("b");

  // (I) interval-skipped landing
  const v1 = await confirm(w1.workerId);
  check("(I) landing 1 merged ungated (interval skip), gate not called", v1.merged === true && v1.skipReason === "gate-interval" && gateCalls === 0);
  const t1 = await getProjectTask(db, P.projId, w1.taskId);
  check("(I) merged proves the landing in git (precondition of mergeGate)", t1.merged != null);
  check("(I) mergeGate = {gateRan:false, skipReason:gate-interval, gateOpId:null, gatedTip:null}",
    t1.mergeGate?.gateRan === false && t1.mergeGate.skipReason === "gate-interval" && t1.mergeGate.gateOpId === null && t1.mergeGate.gatedTip === null);
  const row1 = db.listGateEvents({ projectId: P.projId, limit: 10, offset: 0 }).items.find((r) => r.taskId === w1.taskId && r.gateType === "merge");
  check("(I) gate_history row: skipped, gateRan:false, gatedTip null", row1?.outcome === "skipped" && row1.gateRan === false && row1.gatedTip === null);

  // (G) gated landing
  const v2 = await confirm(w2.workerId);
  check("(G) landing 2 is the periodic GATED landing (gate called once, gateRan:true)", v2.merged === true && gateCalls === 1 && v2.gateRan === true);
  const t2 = await getProjectTask(db, P.projId, w2.taskId);
  const g = t2.mergeGate;
  check("(G) mergeGate.gateRan true, skipReason null, gateOpId = the merge's own opId", g?.gateRan === true && g.skipReason === null && g.gateOpId === v2.opId);
  check("(G) mergeGate.gatedTip is a full 40-hex sha", typeof g?.gatedTip === "string" && SHA40.test(g.gatedTip));
  const row2 = db.listGateEvents({ projectId: P.projId, limit: 10, offset: 0 }).items.find((r) => r.taskId === w2.taskId && r.gateType === "merge");
  check("(G) the SAME opId + head are on the passed build_gate gate_history row (the join the card asks for)",
    row2?.passed === true && row2.gateRan === true && row2.opId === g?.gateOpId && row2.gatedTip === g?.gatedTip);
  check("(G) the gated head is the branch's content: it names a commit that exists in the repo",
    (() => { try { execFileSync("git", ["cat-file", "-e", `${g.gatedTip}^{commit}`], { cwd: P.repo }); return true; } catch { return false; } })());

  // (L) legacy / absent
  const legacyTask = `mgprov-legacy-task-${sfx}`;
  db.insertTask({ id: legacyTask, projectId: P.projId, title: "feat(x): legacy", body: "", columnKey: "done", position: 2, createdAt: now, updatedAt: now });
  check("(L) a card with no merge_done reads null", resolveMergeGateProvenance(db, db.getTask(legacyTask)) === null);
  db.appendEvent({ id: `mgprov-legacy-evt-${sfx}`, ts: now, managerSessionId: P.mgrId, workerSessionId: w1.workerId, taskId: legacyTask, kind: "merge_done", detail: { branch: "loom/legacy", repoKey: null, mergedSha: "abcdef0123456789" } });
  const legacy = resolveMergeGateProvenance(db, db.getTask(legacyTask));
  check("(L) a pre-stamp merge_done reads gateRan:null (UNKNOWN, never false)", legacy?.gateRan === null && legacy.gateOpId === null && legacy.gatedTip === null);
} finally {
  for (const w of worktrees) { try { fs.rmSync(w, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
