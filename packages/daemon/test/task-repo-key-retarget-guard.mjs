import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Multi-repo epic 49136451 phase 2 — the REQUIRED ADDITION, WIDENED by Code Review Major 1.
//
// THE HOLE the first cut of this guard had: it matched `process_state='live'` only, but a rejected merge
// or a plain `worker_stop` RETAINS a worker's worktree + branch by design (so the manager can recover /
// re-task) — the session goes `exited` while its worktree/branch are still very much alive on disk.
// Reachable sequence: worker on task T (repoKey "svc-a") commits → merge REJECTED (gate failure, worktree
// + branch retained) → manager stops the worker (now `exited`) → manager retargets task.repoKey to
// "svc-b" (the OLD live-only guard doesn't fire — nothing is "live") → manager later re-confirms the
// merge on that SAME session → the merge correctly lands on the SESSION's stamped repo (svc-a), but
// ship-state now scans the task's CURRENT repoKey (svc-b) — the card reads as never-merged, permanently,
// with no error anywhere. Fix: the guard now checks EVERY session ever bound to the task (any
// process_state) for a worktree still on disk OR an undeleted branch — either signal blocks the retarget.
//
// Proves:
//   (1) THE GUARD: worktree still on disk (even though the session is `exited`) -> retarget REFUSED.
//   (2) worktree removed from disk but the BRANCH still exists in its repo -> STILL refused.
//   (3) once BOTH the worktree is gone AND the branch is deleted -> the retarget succeeds.
//   (4) CONTROL: an unrelated task (no session at all) retargets normally, unaffected.
//   (5) the REST route (POST /api/tasks/:id) shares the identical widened guard.
//   (6) THE INVARIANT (independent of whatever guard sits in front of it): force the divergence directly
//       at the DB layer (bypassing the guard entirely), then confirm the merge on that session and assert
//       it lands on the SESSION's stamped repo, never the task's now-different current repoKey.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE, REAL git repos (the branch-existence check needs real git),
// modeled on multi-repo-worker-lifecycle.mjs (spawnWorker/confirmWorkerMerge) + task-repo-key.mjs (MCP).
//
// Run: 1) build (turbo builds shared first), 2) node test/task-repo-key-retarget-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-repokey-retarget-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { deleteBranch } = await import("../dist/git/worktrees.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const GIT_ID = "-c user.email=rtg@loom -c user.name=rtg";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function initRepo(repo, readme) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), readme);
  execSync(`git init -q && git config user.email rtg@loom && git config user.name rtg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  isAlive() { return false; }
}
function makeHost(db) {
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  return new SeamHost(events);
}

const repoPrimary = path.join(os.tmpdir(), `loom-rtg-primary-${sfx}`);
const repoA = path.join(os.tmpdir(), `loom-rtg-svc-a-${sfx}`);
const repoB = path.join(os.tmpdir(), `loom-rtg-svc-b-${sfx}`);
initRepo(repoPrimary, "# rtg primary\n");
initRepo(repoA, "# rtg svc-a\n");
initRepo(repoB, "# rtg svc-b\n");

// A gate that always FAILS — used to force a REJECTED merge (worktree + branch RETAINED) so a session can
// go `exited` while still holding a real worktree on disk, the exact reachable sequence Major 1 closes.
const failGate = process.platform === "win32" ? "node -e \"process.exit(1)\"" : "node -e \"process.exit(1)\"";

const db = new Db(path.join(tmpHome, "test.db"));
const sessions = new SessionService(db, makeHost(db), new OrchestrationControl(), {
  reapWorktreeProcesses: async () => ({ killedPids: [] }),
});

const projId = `rtg-proj-${sfx}`;
db.insertProject({
  id: projId, name: "RTG", repoPath: repoPrimary, vaultPath: repoPrimary,
  config: { orchestration: { maxConcurrentWorkers: 10 } },
  createdAt: now, archivedAt: null, reserved: false,
  repos: [
    { key: "svc-a", path: repoA, gateCommand: failGate },
    { key: "svc-b", path: repoB },
  ],
});
db.insertAgent({ id: "mgrAgent", projectId: projId, name: "Mgr", startupPrompt: "", position: 0, profileId: null });
db.insertAgent({ id: "wkrAgent", projectId: projId, name: "Worker", startupPrompt: "", position: 1, profileId: null });

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

const parse = (res) => JSON.parse(res.content[0].text);
const connectServer = async (server) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "task-repo-key-retarget-guard-test", version: "0" });
  await client.connect(clientT);
  return { client, call: async (name, args) => parse(await client.callTool({ name, arguments: args })) };
};

const worktreesToClean = [];
try {
  const mgr = sessions.startManager("mgrAgent");

  // =====================================================================================================
  // (1)-(3) THE GUARD: worktree-exists / branch-exists / both-gone, via the reachable "rejected merge,
  // then exited" sequence — no live session anywhere in this whole block.
  // =====================================================================================================
  const taskGuard = `rtg-task-guard-${sfx}`;
  db.insertTask({ id: taskGuard, projectId: projId, title: "Guard card", body: "", columnKey: "in_progress", position: 1, priority: "p2", repoKey: "svc-a", createdAt: now, updatedAt: now });
  const wGuard = await sessions.spawnWorker(mgr.id, { taskId: taskGuard, agentId: "wkrAgent", kickoffPrompt: "GO" });
  worktreesToClean.push(wGuard.worktreePath);
  fs.writeFileSync(path.join(wGuard.worktreePath, "change.txt"), "work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "change.txt"`, { cwd: wGuard.worktreePath });

  const rejected = await sessions.confirmWorkerMerge(mgr.id, wGuard.id);
  check("(setup) merge REJECTED (the failing gate did its job)", rejected.merged === false);
  check("(setup) worktree RETAINED on disk after the reject", fs.existsSync(wGuard.worktreePath));

  // "manager stops the worker" — process_state exited, worktree/branch fields UNCHANGED (worker_stop never
  // clears them; only a SUCCESSFUL finalizeMerge does).
  db.setProcessState(wGuard.id, "exited");
  check("(setup) session is now exited, NOT live", db.getSession(wGuard.id)?.processState === "exited");
  check("(setup) worktreePath/branch are still stamped on the (now exited) session row", !!db.getSession(wGuard.id)?.worktreePath && !!db.getSession(wGuard.id)?.branch);

  const inProj = await connectServer(new TaskMcpRouter(db, wakes).buildServer(projId, mgr.id));

  // ---- (1) worktree STILL on disk, session EXITED -> refused (THIS is Major 1's fix; the old code let
  // this straight through because it only ever checked process_state='live'). ----
  const blocked1 = await inProj.call("tasks_update", { id: taskGuard, repoKey: "svc-b" });
  check("(1) retarget refused while the worktree is still on disk, even though the session is exited", typeof blocked1.error === "string");
  check("(1) error names the reason", /worktree on disk|undeleted branch/i.test(blocked1.error ?? ""));
  check("(1) repoKey UNCHANGED", db.getTask(taskGuard)?.repoKey === "svc-a");

  // ---- (2) worktree dir physically removed (simulating a later GC/manual cleanup), branch left intact ->
  // STILL refused, because the branch itself still exists in svc-a. ----
  fs.rmSync(wGuard.worktreePath, { recursive: true, force: true });
  check("(setup) worktree dir is now genuinely gone from disk", !fs.existsSync(wGuard.worktreePath));
  const blocked2 = await inProj.call("tasks_update", { id: taskGuard, repoKey: "svc-b" });
  check("(2) retarget STILL refused once the worktree is gone but the branch survives", typeof blocked2.error === "string");
  check("(2) repoKey still UNCHANGED", db.getTask(taskGuard)?.repoKey === "svc-a");

  // ---- (3) branch actually deleted too -> the retarget now succeeds. `git worktree prune` first: the
  // dir above was removed with a plain fs.rmSync (never told to git), so its admin entry is still
  // registered and `branch -D` would otherwise refuse "used by worktree". ----
  execSync("git worktree prune", { cwd: repoA });
  await deleteBranch(repoA, wGuard.branch);
  const allowed = await inProj.call("tasks_update", { id: taskGuard, repoKey: "svc-b" });
  check("(3) retarget succeeds once BOTH the worktree is gone AND the branch is deleted", !allowed.error);
  check("(3) repoKey actually changed", db.getTask(taskGuard)?.repoKey === "svc-b");

  // =====================================================================================================
  // (4) CONTROL: an unrelated task with no session at all retargets normally.
  // =====================================================================================================
  const taskControl = `rtg-task-control-${sfx}`;
  db.insertTask({ id: taskControl, projectId: projId, title: "Control card", body: "", columnKey: "backlog", position: 2, priority: "p2", repoKey: "svc-a", createdAt: now, updatedAt: now });
  const controlResult = await inProj.call("tasks_update", { id: taskControl, repoKey: "svc-b" });
  check("(4) an unrelated task with no session retargets normally", !controlResult.error);
  check("(4) taskGuard's earlier state is unaffected by this unrelated retarget", db.getTask(taskGuard)?.repoKey === "svc-b");

  await inProj.client.close();

  // =====================================================================================================
  // (5) REST route (POST /api/tasks/:id) shares the identical widened guard.
  // =====================================================================================================
  const taskRest = `rtg-task-rest-${sfx}`;
  db.insertTask({ id: taskRest, projectId: projId, title: "REST-guarded card", body: "", columnKey: "in_progress", position: 3, priority: "p2", repoKey: "svc-a", createdAt: now, updatedAt: now });
  const wRest = await sessions.spawnWorker(mgr.id, { taskId: taskRest, agentId: "wkrAgent", kickoffPrompt: "GO" });
  worktreesToClean.push(wRest.worktreePath);
  fs.writeFileSync(path.join(wRest.worktreePath, "change.txt"), "work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "change.txt"`, { cwd: wRest.worktreePath });
  await sessions.confirmWorkerMerge(mgr.id, wRest.id); // rejected (failGate) — worktree/branch retained
  db.setProcessState(wRest.id, "exited");

  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
  const badRest = await app.inject({ method: "POST", url: `/api/tasks/${taskRest}`, payload: { repoKey: "svc-b" } });
  check("(5) REST retarget refused while the exited session's worktree is still on disk", badRest.statusCode === 400);
  check("(5) repoKey UNCHANGED", db.getTask(taskRest)?.repoKey === "svc-a");

  fs.rmSync(wRest.worktreePath, { recursive: true, force: true });
  execSync("git worktree prune", { cwd: repoA });
  await deleteBranch(repoA, wRest.branch);
  const okRest = await app.inject({ method: "POST", url: `/api/tasks/${taskRest}`, payload: { repoKey: "svc-b" } });
  check("(5) REST retarget succeeds once the worktree AND branch are both gone", okRest.statusCode === 200);

  // =====================================================================================================
  // (6) THE INVARIANT: bypass the guard directly at the DB layer (a stale doc/manual DB edit — NOT a
  // reachable Loom write path, but this pins the behavior the whole phase rests on, independent of
  // whatever guard happens to sit in front of it). Confirm the merge and assert it lands on the SESSION's
  // stamped repo, never the task's now-diverged current repoKey.
  // =====================================================================================================
  const taskInvariant = `rtg-task-invariant-${sfx}`;
  db.insertTask({ id: taskInvariant, projectId: projId, title: "Invariant card", body: "", columnKey: "in_progress", position: 4, priority: "p2", repoKey: "svc-b", createdAt: now, updatedAt: now });
  // svc-b has NO gateCommand, so this merge is uncontested (green-by-default) — isolates the invariant
  // under test (which repo the squash lands on) from gate behavior.
  const wInvariant = await sessions.spawnWorker(mgr.id, { taskId: taskInvariant, agentId: "wkrAgent", kickoffPrompt: "GO" });
  worktreesToClean.push(wInvariant.worktreePath);
  check("(6) setup: worker's session is stamped repoKey='svc-b' (the repo its worktree is ACTUALLY in)", db.getSession(wInvariant.id)?.repoKey === "svc-b");
  fs.writeFileSync(path.join(wInvariant.worktreePath, "invariant-change.txt"), "invariant work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "invariant-change.txt"`, { cwd: wInvariant.worktreePath });

  // DIRECTLY at the DB layer — bypassing checkTaskRepoKeyRebind entirely — retarget the TASK to svc-a
  // while the worker's worktree is still live in svc-b. This is the divergence: task says svc-a, the
  // session (and its physical worktree) says svc-b.
  db.updateTask(taskInvariant, { repoKey: "svc-a" });
  check("(6) setup: task.repoKey now diverges from the session's stamped repoKey", db.getTask(taskInvariant)?.repoKey === "svc-a" && db.getSession(wInvariant.id)?.repoKey === "svc-b");

  const confirmInvariant = await sessions.confirmWorkerMerge(mgr.id, wInvariant.id);
  check("(6) THE INVARIANT: the merge still lands", confirmInvariant.merged === true);
  check("(6) THE INVARIANT: the squash landed on the SESSION's repo (svc-b), not the task's CURRENT repoKey (svc-a)",
    fs.existsSync(path.join(repoB, "invariant-change.txt")) && !fs.existsSync(path.join(repoA, "invariant-change.txt")));
} finally {
  db.close();
  for (const wt of worktreesToClean) { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ } }
  for (const d of [repoPrimary, repoA, repoB, tmpHome]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the task.repoKey retarget guard is now WIDER than process_state='live': it blocks while ANY session bound to the task still holds a worktree on disk OR an undeleted branch, closing the reachable 'rejected merge -> worker_stop -> retarget -> re-confirm' sequence that used to slip past the live-only check; an unrelated task is unaffected; both the MCP and REST surfaces share the identical guard; and — independent of the guard — a forced divergence (task.repoKey written directly at the DB layer) still resolves a merge against the SESSION's stamped repo, never the task's current one, pinning the invariant the whole design rests on."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
