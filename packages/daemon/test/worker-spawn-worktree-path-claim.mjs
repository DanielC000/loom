import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// card a5d9c458 ROUND 3, item 2/3 — spawnWorker's OWN wiring of the worktree-path claim
// (reclaimWedgedWorktreePathForSpawn/claimedWorktreePaths), proven against a REAL spawnWorker call
// rather than the unit-level SessionService calls createworktree-wedge-reclaim.mjs already covers.
//
// Proves:
//   (1) the claim is PRESENT in SessionService's own claimedWorktreePaths set while createWorktree is
//       still in flight — i.e. it is taken SYNCHRONOUSLY, before the first await, exactly like
//       inFlightSpawnTaskIds (worker-spawn-toctou-race.mjs proves that one the same way: firing the
//       async call and inspecting state before awaiting it, relying on the synchronous-prefix guarantee).
//   (2) once createWorktree THROWS (a real failure, not a happy path), the claim is released — the Set
//       is EMPTY afterward — so the unit that minted the claim (reclaimWedgedWorktreePathForSpawn's own
//       returned `release()`) never leaks it, even on a failure path spawnWorker's outer `finally` reaches
//       via a thrown promise rejection rather than a normal return.
//   (4) card f487a493 — a REAL spawnWorker against a path already marked `removingWorktreePaths`
//       (a removal genuinely in flight) is REFUSED with the mutex's own rejection text, and nothing it
//       would have claimed is left dangling: `inFlightSpawnTaskIds`/the per-manager cap slot are both
//       released, `claimedWorktreePaths` carries no leaked claim for this path afterward, and the task's
//       board column never moved off `backlog`.
//
// REAL git + a REAL non-git directory (to force createWorktree to throw AFTER the claim is taken), NO
// claude, NO live daemon. Run: 1) build (pnpm build), 2) node test/worker-spawn-worktree-path-claim.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

const loomHome = useOwnLoomHome("loom-wswpc-home-");
fs.mkdirSync(path.join(loomHome, "logs"), { recursive: true });
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { resolveWorktreePath, normForCompare, removeWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- a REAL git repo (the happy-path project) + a plain NON-git directory (createWorktree throws there: ---
// --- its own `git rev-parse HEAD` has no local catch, so the throw propagates past the synchronous claim) ---
const goodRepo = path.join(os.tmpdir(), `loom-wswpc-good-${Date.now()}-${process.pid}`);
fs.mkdirSync(goodRepo, { recursive: true });
fs.writeFileSync(path.join(goodRepo, "README.md"), "# worker-spawn-worktree-path-claim test\n");
execSync(`git init -q`, { cwd: goodRepo });
commitAll(goodRepo, "init", "-c user.email=wswpc@loom -c user.name=wswpc");

const notARepo = path.join(os.tmpdir(), `loom-wswpc-notarepo-${Date.now()}-${process.pid}`);
fs.mkdirSync(notARepo, { recursive: true });
fs.writeFileSync(path.join(notARepo, "placeholder.txt"), "not a git repository\n");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pBad", name: "Bad", repoPath: notARepo, vaultPath: notARepo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgrBad", projectId: "pBad", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDevBad", projectId: "pBad", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgrBad", projectId: "pBad", agentId: "agentMgrBad", engineSessionId: null, title: null,
  cwd: notARepo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const taskBad = randomUUID();
db.insertTask({ id: taskBad, projectId: "pBad", title: "throws", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

class SeamHost extends createSeamHost(PtyHost) {}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const worktrees = [];
try {
  // ===================== (1) the claim is PRESENT while createWorktree is still in flight =====================
  const expectedPath = resolveWorktreePath("pBad", taskBad);
  const p = svc.spawnWorker("mgrBad", { taskId: taskBad, agentId: "agentDevBad", kickoffPrompt: "GO" });
  // No await yet: the synchronous prefix (cap checks, resolveRepo, reclaimWedgedWorktreePathForSpawn)
  // has already run by the time this next line executes, and `await createWorktree(...)` is the FIRST
  // await spawnWorker's try block hits — so the claim must already be in the Set right here.
  check("(1) the claim is present in claimedWorktreePaths while createWorktree is still in flight",
    svc.claimedWorktreePaths.has(normForCompare(expectedPath)));

  // ===================== (2) createWorktree THROWS (notARepo has no HEAD to rev-parse) → the claim releases =====================
  let threw = null;
  try { await p; } catch (e) { threw = e; }
  check("(2) spawnWorker's promise actually REJECTED (createWorktree really threw, this isn't a dead test)", threw !== null);
  check("(2) the claim is RELEASED after the throw — claimedWorktreePaths is empty",
    svc.claimedWorktreePaths.size === 0);
  check("(2) no session row was ever inserted for the failed spawn", db.listAllSessions().filter((s) => s.taskId === taskBad).length === 0);

  // ===================== (3) sanity: the SAME claim machinery still lets an ORDINARY spawn succeed =====================
  db.insertProject({ id: "pGood", name: "Good", repoPath: goodRepo, vaultPath: goodRepo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgrGood", projectId: "pGood", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: "agentDevGood", projectId: "pGood", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
  db.insertSession({ id: "mgrGood", projectId: "pGood", agentId: "agentMgrGood", engineSessionId: null, title: null,
    cwd: goodRepo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const taskGood = randomUUID();
  db.insertTask({ id: taskGood, projectId: "pGood", title: "succeeds", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

  const winner = await svc.spawnWorker("mgrGood", { taskId: taskGood, agentId: "agentDevGood", kickoffPrompt: "GO" });
  worktrees.push(winner.worktreePath);
  check("(3) a normal spawn still succeeds after the failed one (claim fully released, not stuck)",
    winner.role === "worker" && winner.taskId === taskGood && db.getSession(winner.id).processState === "live");
  check("(3) its claim was ALSO released once live (the Set is empty again)", svc.claimedWorktreePaths.size === 0);

  // ===================== (4) card f487a493 — spawnWorker against a path marked REMOVING ⇒ refused, nothing leaked =====================
  // reclaimWedgedWorktreePathForSpawn's mutual-exclusion check (round 3, a5d9c458) refuses outright when
  // this exact path is already marked `removingWorktreePaths` — a removal is genuinely in flight against
  // it. Proves the refusal's rejection text, AND that nothing it would have claimed is left dangling: the
  // per-taskId/cap-slot claims spawnWorker itself takes are released via its outer `finally`, and
  // `claimedWorktreePaths` carries no leaked entry for this path afterward (the source's own ordering —
  // the `removingWorktreePaths` check runs BEFORE the `.add()` — is read off worktrees.ts/service.ts
  // directly; this end-state check can't itself prove that ordering, only that nothing was left behind).
  db.insertProject({ id: "pRemoving", name: "Removing", repoPath: goodRepo, vaultPath: goodRepo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgrRemoving", projectId: "pRemoving", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: "agentDevRemoving", projectId: "pRemoving", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
  db.insertSession({ id: "mgrRemoving", projectId: "pRemoving", agentId: "agentMgrRemoving", engineSessionId: null, title: null,
    cwd: goodRepo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const taskRemoving = randomUUID();
  db.insertTask({ id: taskRemoving, projectId: "pRemoving", title: "removing-marked", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

  const removingPath = resolveWorktreePath("pRemoving", taskRemoving);
  const normRemoving = normForCompare(removingPath);
  svc.removingWorktreePaths.add(normRemoving); // simulate a removal genuinely in flight against this exact path
  let removingThrew = null;
  try {
    await svc.spawnWorker("mgrRemoving", { taskId: taskRemoving, agentId: "agentDevRemoving", kickoffPrompt: "GO" });
  } catch (e) {
    removingThrew = e;
  } finally {
    svc.removingWorktreePaths.delete(normRemoving); // this test's own injected mark, not the daemon's — clean it up
  }
  check("(4) spawnWorker against a REMOVING-marked path REFUSED (threw) with the rejection text",
    removingThrew !== null && /removal in progress for this path, retry shortly/.test(removingThrew.message));
  check("(4) inFlightSpawnTaskIds released the taskId (not leaked)", !svc.inFlightSpawnTaskIds.has(taskRemoving));
  check("(4) the per-manager cap slot was released (not leaked)", !svc.inFlightSpawnCountByManager.has("mgrRemoving"));
  check("(4) claimedWorktreePaths carries no leaked claim for this path after the refusal",
    !svc.claimedWorktreePaths.has(normRemoving));
  check("(4) the task's board column is UNCHANGED (still backlog, never moved)", db.getTask(taskRemoving).columnKey === "backlog");
  check("(4) no session row was ever inserted for the refused spawn", db.listAllSessions().filter((s) => s.taskId === taskRemoving).length === 0);
} finally {
  for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(goodRepo, wt); } catch { /* best-effort */ } }
  db.close();
  try { fs.rmSync(goodRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(notARepo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — spawnWorker's own worktree-path claim is taken synchronously (present while createWorktree is still in flight) and is released by the unit that minted it on EITHER outcome — a thrown createWorktree failure or a normal live spawn — leaving nothing leaked for the next spawn to collide with. A spawn against a path already marked REMOVING is refused outright, with its own cap/claim bookkeeping released and the task's board column untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
