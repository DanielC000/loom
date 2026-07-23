import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SUCCESSOR RESOLUTION DETERMINISM (card 386178a8, Code Reviewer finding) — db.ts's getSuccessor was
// `SELECT * FROM sessions WHERE recycled_from = ? LIMIT 1` with NO ORDER BY, silently assuming at most one
// row can share a recycled_from. Nothing enforced that: recycleWorker/recycleManager had no hasSuccessor
// guard (unlike recyclePlatformLead, which already refused a double recycle_me) — so a manager that
// recycles the SAME (already-recycled) worker or itself twice forks the lineage, and the forward walk
// (liveLineageSuccessor, which deliverSessionMessage/resolveSettleNudgeTarget use to route
// [loom:merge-done]/[loom:gate-done]/durable messages) would pick a sibling nondeterministically.
//
// Investigation (worker_report progress, this card) confirmed BOTH gaps are reachable through the real
// tool surface, not just at the DB layer: worker_list never excludes an already-recycled worker row
// (db.ts listWorkers only filters archived), so a manager can call worker_recycle on a stale id a second
// time; recycle_me is self-scoped and the predecessor's pty isn't hard-stopped until a deferred 3s
// timeout, so a duplicate/retried recycle_me in that window hits recycleManager again with zero extra
// conditions. recyclePlatformLead's own doc comment names "a double tool-call in one turn" as the exact
// threat its hasSuccessor guard exists to stop — a threat recycleManager shares but was never guarded
// against.
//
// Fix (both, per the card): (1) port recyclePlatformLead's hasSuccessor refusal, same shape + placement
// (before any teardown/spawn), into recycleWorker and recycleManager. (2) getSuccessor now orders
// `created_at DESC, rowid DESC` — created_at (ISO-8601, sorts lexicographically = chronologically) is the
// primary key; rowid DESC is a TOTAL-order tiebreak for two successors minted in the same millisecond,
// where created_at alone would tie and leave the pick nondeterministic again. This is defense-in-depth
// for any lineage that forked before these guards existed, or any path that bypasses them.
//
// Proves:
//   (A) WORKER: a normal single recycle succeeds (regression: the guard doesn't refuse a first recycle);
//       a SECOND recycleWorker on the same (now-recycled) worker id is REFUSED, no new row spawned, and
//       liveLineageSuccessor still resolves to the (only) live successor.
//   (B) MANAGER: identical shape — normal recycle succeeds, double recycleManager on the same predecessor
//       is refused, liveLineageSuccessor resolves correctly.
//   (C) FORKED LINEAGE (constructed by direct db insert, bypassing the new guards — proving the ORDER BY
//       itself, independent of whether the guards would have prevented it): getSuccessor deterministically
//       picks the newest row by created_at, and — for two successors minted in the SAME millisecond — the
//       rowid DESC tiebreak picks the later-inserted one, never an arbitrary pick.
//   (D) recyclePlatformLead's own existing double-recycle refusal is unchanged (not re-tested here in
//       full — platform-lead-recycle.mjs already owns that coverage; this file only proves the two
//       siblings that lacked it now match its shape).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService driven against a FAKE pty
// (createPty/stop seam), mirroring pending-op-settle-lineage.mjs's proven recycleWorker/recycleManager
// harness (real temp git repo + a real worktree for the worker case).
// Run: 1) build (turbo builds shared first), 2) node test/recycle-successor-determinism.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rsd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");
const { liveLineageSuccessor } = await import("../dist/sessions/platform-lead-prompt.js");

const GIT_ID = "-c user.email=rsd@loom -c user.name=rsd";
const now = new Date().toISOString();

// Fake pty: no real claude/signals. isAlive() reflects stop() immediately (SeamHost's fake pty never
// fires a real onExit), so recycleWorker's synchronous "wait until the old pty is actually gone" poll
// (packages/daemon/src/sessions/service.ts) returns on its first check instead of spinning its ~5s budget.
class SeamHost extends PtyHost {
  spawned = [];
  stoppedIds = new Set();
  createPty(opts) { this.spawned.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop(id, mode) { this.stoppedIds.add(id); }
  isAlive(id) { return !this.stoppedIds.has(id); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const db = new Db();
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-rsd-repo-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# rsd\n");
  execSync(`git init -q && git config user.email rsd@loom && git config user.name rsd && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  return repo;
}

const worktrees = [];
try {
  // ==================== (A) WORKER — normal recycle, then a REFUSED double recycle ====================
  {
    const P = "rsd-worker", repo = makeRepo("worker");
    const { worktreePath, branch } = await createWorktree(repo, P, "wa");
    db.insertProject({ id: P, name: "RSD-Worker", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertTask({ id: "wa", projectId: P, title: "wa", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const mgrId = `${P}-mgr1`, workerAId = `${P}-wkrA`;
    db.insertSession({ id: mgrId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "wa", worktreePath, branch });

    check("(A pre) hasSuccessor(worker) is FALSE before any recycle", db.hasSuccessor(workerAId) === false);
    const spawnsBefore = host.spawned.length;
    const workerB = await svc.recycleWorker(mgrId, workerAId, "handoff one — normal recycle");
    check("(A) normal recycle succeeds (regression: the guard does not refuse a FIRST recycle)", !!workerB && workerB.id !== workerAId && workerB.recycledFrom === workerAId);
    check("(A) a fresh pty was spawned for the successor", host.spawned.length === spawnsBefore + 1);
    check("(A) hasSuccessor(worker A) is now TRUE", db.hasSuccessor(workerAId) === true);
    db.setProcessState(workerAId, "exited"); // fake pty never fires a real onExit — stamp it dead, as it genuinely would be

    // A SECOND recycleWorker on the SAME (now-recycled) worker id — the exact scenario the card flags:
    // a stale cached id, or a duplicate/retried worker_recycle tool call.
    const spawnsBeforeDouble = host.spawned.length;
    let doubleErr = null;
    try { await svc.recycleWorker(mgrId, workerAId, "handoff two — should be refused"); } catch (e) { doubleErr = e.message; }
    check("(A) double recycle on the same worker is REFUSED", doubleErr === "this worker has already been recycled — its successor is live");
    check("(A) double recycle spawned NOTHING (no fork)", host.spawned.length === spawnsBeforeDouble);
    check("(A) getSuccessor(worker A) resolves to the ONE real successor", db.getSuccessor(workerAId)?.id === workerB.id);
    check("(A) liveLineageSuccessor(worker A) resolves to the live successor", liveLineageSuccessor(db, workerAId)?.id === workerB.id);

    worktrees.push([repo, worktreePath]);
  }

  // ==================== (B) MANAGER — normal recycle, then a REFUSED double recycle ====================
  {
    const P = "rsd-manager", repo = makeRepo("manager");
    db.insertProject({ id: P, name: "RSD-Manager", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    const mgrAId = `${P}-mgrA`;
    db.insertSession({ id: mgrAId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    check("(B pre) hasSuccessor(manager) is FALSE before any recycle", db.hasSuccessor(mgrAId) === false);
    const spawnsBefore = host.spawned.length;
    const mgrB = await svc.recycleManager(mgrAId, "continuation one — normal recycle");
    check("(B) normal recycle succeeds (regression: the guard does not refuse a FIRST recycle)", !!mgrB && mgrB.id !== mgrAId && mgrB.recycledFrom === mgrAId);
    check("(B) a fresh pty was spawned for the successor", host.spawned.length === spawnsBefore + 1);
    check("(B) hasSuccessor(manager A) is now TRUE", db.hasSuccessor(mgrAId) === true);
    db.setProcessState(mgrAId, "exited"); // recycleManager only defers a real hard-stop (3s); the fake pty never fires the onExit that would flip this in production — stamp it dead, as it genuinely would be

    // A SECOND recycleManager on the SAME predecessor — recycle_me is self-scoped and the predecessor's
    // pty isn't hard-stopped until a deferred 3s timeout, so this models a duplicate/retried call landing
    // inside that live window.
    const spawnsBeforeDouble = host.spawned.length;
    let doubleErr = null;
    try { await svc.recycleManager(mgrAId, "continuation two — should be refused"); } catch (e) { doubleErr = e.message; }
    check("(B) double recycle on the same manager is REFUSED", doubleErr === "this manager has already been recycled — its successor is live");
    check("(B) double recycle spawned NOTHING (no fork)", host.spawned.length === spawnsBeforeDouble);
    check("(B) getSuccessor(manager A) resolves to the ONE real successor", db.getSuccessor(mgrAId)?.id === mgrB.id);
    check("(B) liveLineageSuccessor(manager A) resolves to the live successor", liveLineageSuccessor(db, mgrAId)?.id === mgrB.id);
  }

  // ==================== (C) FORKED LINEAGE (direct db insert, bypassing the guards) ====================
  // Proves the ORDER BY itself is deterministic, independent of whether the new guards would have
  // prevented the fork — defense-in-depth for a lineage forked before the guards existed, or any path
  // that bypasses recycleWorker/recycleManager/recyclePlatformLead entirely.
  {
    const P = "rsd-forked";
    db.insertProject({ id: P, name: "RSD-Forked", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-a`, projectId: P, name: "A", startupPrompt: "", position: 0, profileId: null });
    const mk = (id, extra) => db.insertSession({ id, projectId: P, agentId: `${P}-a`, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", ...extra });

    // --- distinct created_at: the row with the LOWER rowid (inserted first) has the NEWER timestamp —
    // proves created_at, not insertion order, is the primary sort key. ---
    const rootId = `${P}-root`, childNewerTsId = `${P}-child-newer-ts`, childOlderTsId = `${P}-child-older-ts`;
    mk(rootId, {});
    const tNewer = new Date(Date.now() + 60_000).toISOString(); // clearly later
    const tOlder = new Date(Date.now() - 60_000).toISOString(); // clearly earlier
    mk(childNewerTsId, { recycledFrom: rootId, createdAt: tNewer }); // inserted FIRST (lower rowid), NEWER timestamp
    mk(childOlderTsId, { recycledFrom: rootId, createdAt: tOlder }); // inserted SECOND (higher rowid), OLDER timestamp
    check("(C) getSuccessor picks the row with the NEWER created_at, regardless of insertion order",
      db.getSuccessor(rootId)?.id === childNewerTsId);

    // --- tied created_at: the LATER-INSERTED row (higher rowid) wins — the tiebreak that keeps the pick
    // deterministic even when two successors are minted in the same millisecond. ---
    const rootTieId = `${P}-root-tie`, firstInsertedId = `${P}-tie-first`, secondInsertedId = `${P}-tie-second`;
    mk(rootTieId, {});
    const tied = new Date().toISOString();
    mk(firstInsertedId, { recycledFrom: rootTieId, createdAt: tied });  // lower rowid
    mk(secondInsertedId, { recycledFrom: rootTieId, createdAt: tied }); // higher rowid — should win
    check("(C) getSuccessor picks the LATER-INSERTED row on a created_at TIE (rowid DESC tiebreak)",
      db.getSuccessor(rootTieId)?.id === secondInsertedId);

    check("(C) hasSuccessor is unaffected by the ORDER BY change (still a plain existence check)",
      db.hasSuccessor(rootId) === true && db.hasSuccessor(rootTieId) === true);
  }
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  db.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recycleWorker + recycleManager now refuse a second recycle of an already-recycled session (mirroring recyclePlatformLead's guard), and getSuccessor deterministically picks the newest successor (created_at DESC, rowid DESC tiebreak) under any reachable — or even directly-forked — recycle sequence. Normal single-recycle lineage walks (liveLineageSuccessor) are unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
