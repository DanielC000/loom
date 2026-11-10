import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A TASKLESS reviewOf worker_spawn retry attaches to its in-flight spawn / is answered from the settled
// one (card 9ccf4bc5). DETERMINISTIC, CLAUDE-FREE, NETWORK-FREE: a real Db + SessionService over a fake
// pty seam and a real temp git repo, same shape as merge-spawn-tracked.mjs's SPAWN scenarios.
//
// Identity of a taskless review spawn = (manager lineage root, agentId, reviewOfWorkerSessionId OR
// reviewOfTaskId). Proves, for EACH reviewOf param:
//   (a) two concurrent Tracked calls with the same args -> ONE worker (in-flight attach).
//   (b) a re-call after settle -> the SAME worker, cacheHit set, never a second spawn.
//   (c) a different review target, or a different agentId -> a DIFFERENT worker (identity is not too coarse).
//   (d) the cached reviewer EXITED -> the re-call spawns a fresh one (never hands back a dead id).
//   (e) listPendingSpawns never leaks the synthetic key as a taskId.
// And: a taskless spawn WITHOUT reviewOf keeps today's semantics (two identical calls -> two workers).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const noReap = async () => ({ killedPids: [] });
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wsrr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const GIT_ID = "-c user.email=wsrr@loom -c user.name=wsrr";
const now = new Date().toISOString();
class SeamHost extends createSeamHost(PtyHost) {}
const db = new Db();
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const stopSeamPty = (id) => { try { host.stop(id, "hard"); } catch { /* best-effort */ } };
const svc = new SessionService(db, host, new OrchestrationControl(), { reapWorktreeProcesses: noReap, syncAttachBudgetMs: 60_000 });

const repo = path.join(os.tmpdir(), `loom-wsrr-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
registerForCleanup(repo);
fs.writeFileSync(path.join(repo, "README.md"), "# wsrr\n");
execSync(`git init -q && git config user.email wsrr@loom && git config user.name wsrr`, { cwd: repo });
commitAll(repo, "init", GIT_ID);

const P = "wsrr";
db.insertProject({ id: P, name: "WSRR", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 40 } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "mgrA", projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "devA", projectId: P, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertAgent({ id: "crA", projectId: P, name: "CR", startupPrompt: "CR", position: 2, profileId: null });
db.insertAgent({ id: "crB", projectId: P, name: "CR2", startupPrompt: "CR2", position: 3, profileId: null });
db.insertSession({ id: "mgr1", projectId: P, agentId: "mgrA", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

const mkTask = (title) => { const id = randomUUID(); db.insertTask({ id, projectId: P, title, body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now }); return id; };

const worktrees = [];
const track = (r) => { if (r.settled && r.ok) worktrees.push(r.value.worktreePath); return r; };
const reviewerCount = () => db.listAllSessions().filter((s) => s.role === "worker" && s.taskId == null).length;

try {
  // Two reviewed authors (tasked workers), so there are two distinct review targets per param.
  const taskX = mkTask("author X"), taskY = mkTask("author Y");
  const authorX = await svc.spawnWorker("mgr1", { taskId: taskX, agentId: "devA", kickoffPrompt: "GO X" });
  const authorY = await svc.spawnWorker("mgr1", { taskId: taskY, agentId: "devA", kickoffPrompt: "GO Y" });
  worktrees.push(authorX.worktreePath, authorY.worktreePath);

  const PARAMS = [
    ["reviewOfWorkerSessionId", authorX.id, authorY.id],
    ["reviewOfTaskId", taskX, taskY],
  ];
  for (const [param, targetX, targetY] of PARAMS) {
    const L = `(${param})`;
    const args = (agentId, target) => ({ agentId, kickoffPrompt: "review it", [param]: target });

    // (a) concurrent -> one worker. No await between the calls (deterministic attach, see merge-spawn-tracked).
    const before = reviewerCount();
    const [r1, r2] = await Promise.all([svc.spawnWorkerTracked("mgr1", args("crA", targetX)), svc.spawnWorkerTracked("mgr1", args("crA", targetX))]);
    track(r1); track(r2);
    const bothOk = r1.settled && r1.ok && r2.settled && r2.ok;
    check(`${L} (a) both concurrent calls settle ok`, bothOk);
    check(`${L} (a) both resolve to the SAME worker`, bothOk && r1.value.id === r2.value.id);
    check(`${L} (a) exactly ONE taskless worker row was created`, reviewerCount() === before + 1);
    check(`${L} (a) the worker is a review spawn (reviewOf present) and taskless`, bothOk && !!r1.value.reviewOf && r1.value.taskId === null);

    // (b) settled re-call -> same worker from cache.
    const again = await svc.spawnWorkerTracked("mgr1", args("crA", targetX));
    check(`${L} (b) post-settle re-call returns the SAME worker`, again.settled && again.ok && bothOk && again.value.id === r1.value.id);
    check(`${L} (b) it is a genuine cache hit (spawnWorker not re-run)`, again.cacheHit !== undefined);
    check(`${L} (b) still exactly ONE new worker row`, reviewerCount() === before + 1);

    // (c) different target / different agent -> a different worker.
    const otherTarget = track(await svc.spawnWorkerTracked("mgr1", args("crA", targetY)));
    check(`${L} (c) a different review target spawns a DIFFERENT worker`, otherTarget.ok && bothOk && otherTarget.value.id !== r1.value.id && otherTarget.cacheHit === undefined);
    const otherAgent = track(await svc.spawnWorkerTracked("mgr1", args("crB", targetX)));
    check(`${L} (c) a different agentId spawns a DIFFERENT worker`, otherAgent.ok && bothOk && otherAgent.value.id !== r1.value.id && otherAgent.cacheHit === undefined);

    const otherKickoff = track(await svc.spawnWorkerTracked("mgr1", { ...args("crA", targetX), kickoffPrompt: "re-review after new commits, different brief" }));
    check(`${L} (c) a different kickoffPrompt (same target+agent) spawns a DIFFERENT worker, not reused`, otherKickoff.ok && bothOk && otherKickoff.value.id !== r1.value.id && otherKickoff.cacheHit === undefined);
    const sameTrimmed = await svc.spawnWorkerTracked("mgr1", { ...args("crA", targetX), kickoffPrompt: "  review it \n" });
    check(`${L} (c) a kickoff differing only by surrounding whitespace is still the same retry`, sameTrimmed.ok && bothOk && sameTrimmed.value.id === r1.value.id);

    // (e) no synthetic-key leak while pending/after.
    check(`${L} (e) listPendingSpawns never exposes a review key as a taskId`, svc.listPendingSpawns("mgr1").every((op) => op.taskId === null || !String(op.taskId).startsWith("review:")));

    // (d) cached reviewer exited -> re-call spawns fresh, not the dead id.
    stopSeamPty(r1.value.id);
    check(`${L} (d) precondition: cached reviewer reads as exited`, db.getSession(r1.value.id).processState !== "live");
    const fresh = track(await svc.spawnWorkerTracked("mgr1", args("crA", targetX)));
    check(`${L} (d) re-call after the cached worker exited spawns a NEW worker (not served from cache)`, fresh.ok && fresh.value.id !== r1.value.id && fresh.cacheHit === undefined);
    for (const r of [fresh, otherTarget, otherAgent, otherKickoff]) if (r.ok) stopSeamPty(r.value.id);
  }

  // Control: taskless WITHOUT reviewOf keeps today's semantics — identical calls make two workers.
  const t1 = track(await svc.spawnWorkerTracked("mgr1", { agentId: "crA", kickoffPrompt: "spike" }));
  const t2 = track(await svc.spawnWorkerTracked("mgr1", { agentId: "crA", kickoffPrompt: "spike" }));
  check("(control) taskless spawn WITHOUT reviewOf: two identical calls -> two DIFFERENT workers", t1.ok && t2.ok && t1.value.id !== t2.value.id && t2.cacheHit === undefined);
  for (const r of [t1, t2]) if (r.ok) stopSeamPty(r.value.id);
  stopSeamPty(authorX.id); stopSeamPty(authorY.id);
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0 ? "\n✅ ALL PASS — taskless reviewOf spawn retries attach/reuse on both reviewOf params." : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
