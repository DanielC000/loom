import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 298b826e — recycle freezes Profile.connections at the predecessor's value; do not "fix" this
// to re-resolve the live profile without a fresh owner decision — the owner deliberately chose to KEEP
// the freeze (Option B) rather than widen what recycle_me does.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, same hermetic shape as respawn-profile-attrs.mjs: isolated
// LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService driven against a FAKE pty via PtyHost's
// createPty() seam — no real claude, no daemon, no network.
//
// Run: 1) build (turbo builds shared first), 2) node test/connections-recycle-freeze-contract.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-conn-freeze-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
delete process.env.CLAUDE_CONFIG_DIR;  // see a92a0913 — an inherited value would bypass the override above

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const repo = path.join(os.tmpdir(), `loom-conn-freeze-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# connections-recycle-freeze-contract\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=cfc@loom -c user.name=cfc");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// BOTH rigs start with NO connections — the owner binds one to each profile AFTER the first spawn.
db.insertProfile({ id: "profMgr", name: "MgrRig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null, connections: [] });
db.insertProfile({ id: "profWorker", name: "WorkerRig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, connections: [] });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "MgrProfiled", startupPrompt: "MGR_PROMPT", position: 0, profileId: "profMgr" });
db.insertAgent({ id: "agentWorker", projectId: "pP", name: "WorkerProfiled", startupPrompt: "WORKER_PROMPT", position: 1, profileId: "profWorker" });
const tW = "22222222-2222-4222-8222-222222222222";
db.insertTask({ id: tW, projectId: "pP", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
  // mirrors respawn-profile-attrs.mjs: drives NO live OS pty, so resume/recycle's isAlive short-circuit
  // must report not-live for the (notionally stopped) predecessor to actually be recycled.
  isAlive() { return false; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

let workerWorktree = null, recycledWorktree = null;
try {
  // ===================== MANAGER: fresh spawn -> bind -> recycle keeps [] -> a NEW fresh spawn resolves =====================
  const mgr1 = svc.startManager("agentMgr", "GO");
  check("(mgr) fresh spawn while profile.connections=[] -> session.connections is []", JSON.stringify(db.getSession(mgr1.id).connections ?? []) === "[]");

  db.updateProfile("profMgr", { connections: ["conn-mgr-1"] }); // the owner binds AFTER mgr1 already started
  check("(mgr) profile now carries the newly-bound connection id", JSON.stringify(db.getProfile("profMgr").connections) === JSON.stringify(["conn-mgr-1"]));

  db.setBusy(mgr1.id, false);
  const mgr2 = await svc.recycleManager(mgr1.id, "CONTINUE: pick up the fleet.");
  check(
    "(mgr) PINNED CONTRACT: recycle_me's successor keeps [] (frozen from the predecessor), NOT the live profile's bound connection",
    JSON.stringify(db.getSession(mgr2.id).connections ?? []) === "[]",
  );

  const mgr3 = svc.startManager("agentMgr", "GO AGAIN");
  check(
    "(mgr) CONTRAST (polarity check): a genuinely FRESH startManager call (never recycled) DOES resolve the live profile's connections",
    JSON.stringify(db.getSession(mgr3.id).connections ?? []) === JSON.stringify(["conn-mgr-1"]),
  );

  // ===================== WORKER: fresh spawn -> bind -> recycle keeps [] -> a NEW fresh spawn resolves =====================
  const w1 = await svc.spawnWorker(mgr3.id, { taskId: tW, agentId: "agentWorker", kickoffPrompt: "GO" });
  workerWorktree = w1.worktreePath;
  check("(worker) fresh spawn while profile.connections=[] -> session.connections is []", JSON.stringify(db.getSession(w1.id).connections ?? []) === "[]");

  db.updateProfile("profWorker", { connections: ["conn-worker-1"] }); // bound AFTER w1 already started
  check("(worker) profile now carries the newly-bound connection id", JSON.stringify(db.getProfile("profWorker").connections) === JSON.stringify(["conn-worker-1"]));

  db.setBusy(w1.id, false);
  const w2 = await svc.recycleWorker(mgr3.id, w1.id, "HANDOFF: continue.");
  recycledWorktree = w2.worktreePath;
  check(
    "(worker) PINNED CONTRACT: recycleWorker's successor keeps [] (frozen from the predecessor), NOT the live profile's bound connection",
    JSON.stringify(db.getSession(w2.id).connections ?? []) === "[]",
  );

  // A second, DIFFERENT task so the contrast spawn doesn't collide with the already-claimed worktree above.
  const tW2 = "33333333-3333-4333-8333-333333333333";
  db.insertTask({ id: tW2, projectId: "pP", title: "t2", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
  const w3 = await svc.spawnWorker(mgr3.id, { taskId: tW2, agentId: "agentWorker", kickoffPrompt: "GO AGAIN" });
  check(
    "(worker) CONTRAST (polarity check): a genuinely FRESH spawnWorker call (never recycled) DOES resolve the live profile's connections",
    JSON.stringify(db.getSession(w3.id).connections ?? []) === JSON.stringify(["conn-worker-1"]),
  );
  try { await (await import("../dist/git/worktrees.js")).removeWorktree(repo, w3.worktreePath); } catch { /* best-effort */ }
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [workerWorktree, recycledWorktree].filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  cleanupPathSync(tmpHome);
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — connections is pinned on the session row at spawn and stays FROZEN across recycle (both recycleManager and recycleWorker) exactly per the documented contract; a connection bound to the profile after a session's first spawn is picked up only by a genuinely fresh spawn, never by recycle_me — pinned here so a future change to this freeze is deliberate, not accidental."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
