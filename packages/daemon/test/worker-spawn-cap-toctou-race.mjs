import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn CONCURRENCY-CAP TOCTOU race (the cap-axis sibling of worker-spawn-toctou-race.mjs).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty() seam), a real temp git repo behind createWorktree.
//
// The bug (pre-existing, surfaced by the same-task spawn-race Code-Reviewer gate): spawnWorker counted only
// LIVE DB rows for the cap (`liveWorkers >= cap`) BEFORE `await createWorktree`, and a worker row is inserted
// only AFTER that await. So N concurrent worker_spawn calls for DIFFERENT taskIds each observed liveWorkers
// unchanged (none had inserted yet) and ALL passed the cap check → the fleet overshot maxConcurrentWorkers by
// up to N-1. Same TOCTOU class as the same-task double-create race, on the cap axis.
//
// The fix: admit the cap atomically with the per-taskId claim — count the in-flight claims
// (`liveWorkers + inFlightSpawnTaskIds.size >= cap`), checked in the SAME no-await window as the claim's
// test-and-set, BEFORE `await createWorktree`. Each in-flight claim WILL become a live worker, so counting it
// makes a concurrent burst admit exactly `cap` and reject the rest cleanly — each BEFORE createWorktree, so a
// rejected spawn leaves no orphan worktree/branch.
//
// Why DETERMINISTIC (no sleeps / no luck): calling an async fn runs its synchronous prefix immediately, up to
// the first await (here createWorktree, BELOW the cap admit + claim). Firing N+1 spawns without awaiting
// between them runs each prefix to completion in turn: call K's cap check observes the (K-1) prior claims
// already in the in-flight set. With cap=N, calls 1..N admit and call N+1 is rejected — exactly, every run.
//
// Proves (cap=N, N+1 overlapping spawns on N+1 DISTINCT tasks):
//   (1) exactly N spawns fulfil, exactly 1 is rejected with the existing "concurrency cap reached" error;
//   (2) exactly N live workers exist (the fleet did NOT overshoot the cap);
//   (3) exactly N worktrees/branches were created — the rejected spawn left NO orphan (it rejected before
//       createWorktree);
//   (4) the claims were RELEASED — after one of the N exits (a slot frees), a fresh single spawn succeeds.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-cap-toctou-race.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wcap-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-wcap-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-cap-toctou-race test\n");
execSync(`git init -q && git add . && git -c user.email=ws@loom -c user.name=ws commit -q -m init`, { cwd: repo });

const CAP = 2; // cap=N; we fire N+1 overlapping spawns for N+1 distinct tasks.
const now = new Date().toISOString();
const db = new Db();
// Per-project config override flows through resolveConfig(project.config) → orchestration.maxConcurrentWorkers.
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: CAP } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

// N+1 distinct tasks (so this is purely the cap axis — every spawn targets a DIFFERENT task, never the
// same-task double-create race).
const tasks = [];
for (let i = 0; i < CAP + 1; i++) {
  const id = randomUUID();
  db.insertTask({ id, projectId: "pP", title: `t${i}`, body: "", columnKey: "backlog", position: i + 1, priority: "p2", createdAt: now, updatedAt: now });
  tasks.push(id);
}

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
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
  // ===================== fire N+1 OVERLAPPING spawns for N+1 DISTINCT tasks, then settle =====================
  // No await between calls: each runs its synchronous prefix (through the cap admit + the per-taskId claim)
  // to the first await (createWorktree). Call K's cap check sees the (K-1) prior claims already in flight.
  const promises = tasks.map((t) => svc.spawnWorker("mgr1", { taskId: t, agentId: "agentDev", kickoffPrompt: "GO" }));
  const settled = await Promise.allSettled(promises);

  const fulfilled = settled.filter((r) => r.status === "fulfilled");
  const rejected = settled.filter((r) => r.status === "rejected");
  for (const r of fulfilled) if (r.value?.worktreePath) worktrees.push(r.value.worktreePath);

  // ===================== (1) exactly CAP admit, the rest rejected with the cap error =====================
  check(`(1) exactly ${CAP} overlapping spawns fulfil`, fulfilled.length === CAP);
  check(`(1) exactly ${tasks.length - CAP} spawn rejected`, rejected.length === tasks.length - CAP);
  check("(1) every rejection names the concurrency cap",
    rejected.length > 0 && rejected.every((r) => /concurrency cap reached/.test(String(r.reason?.message))));

  // ===================== (2) exactly CAP live workers — the fleet did NOT overshoot the cap =====================
  const live = db.listLiveWorkers().filter((w) => w.parentSessionId === "mgr1");
  check(`(2) exactly ${CAP} live workers (no overshoot)`, live.length === CAP);
  // Each live worker holds a DISTINCT task (proves these are different-task spawns, not a same-task collapse).
  const liveTaskIds = new Set(live.map((w) => w.taskId));
  check(`(2) the ${CAP} live workers hold DISTINCT tasks`, liveTaskIds.size === CAP);

  // ===================== (3) exactly CAP worktrees/branches — the rejected spawn left NO orphan =====================
  for (const w of fulfilled) check(`(3) winner worktree exists on disk`, !!w.value?.worktreePath && fs.existsSync(w.value.worktreePath));
  const branches = execSync("git branch --list", { cwd: repo, encoding: "utf8" })
    .split("\n").map((l) => l.replace(/^[*+]?\s*/, "").trim()).filter(Boolean);
  const loomBranches = branches.filter((b) => b.startsWith("loom/"));
  check(`(3) exactly ${CAP} worktree branches exist — the rejected spawn created none (no orphan)`, loomBranches.length === CAP);

  // ===================== (4) claims RELEASED + cap re-admits once a slot frees =====================
  // A cap-rejected spawn must not have left a lingering claim; and once a live worker exits (a slot frees),
  // a fresh spawn for the previously-rejected task must succeed.
  const freed = live[0];
  db.setProcessState(freed.id, "exited"); // deterministically free the slot (the fake pty never really exits)
  const rejectedTask = tasks.find((t) => !liveTaskIds.has(t));
  // If the cap overshot (the bug), every task already has a live worker and there is no free task to re-spawn —
  // surface that as a clean FAIL rather than throwing on a `taskId: undefined`.
  if (!rejectedTask) {
    check("(4) a previously-rejected task exists to re-spawn (cap did not overshoot)", false);
  } else {
    const wNext = await svc.spawnWorker("mgr1", { taskId: rejectedTask, agentId: "agentDev", kickoffPrompt: "GO" });
    worktrees.push(wNext.worktreePath);
    check("(4) after a slot frees, a fresh spawn for the rejected task succeeds (claims released, cap re-admits)",
      wNext.role === "worker" && wNext.taskId === rejectedTask && db.getSession(wNext.id).processState === "live");
    check("(4) still exactly CAP live workers after the re-admit (one exited, one spawned)",
      db.listLiveWorkers().filter((w) => w.parentSessionId === "mgr1").length === CAP);
  }
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? `\n✅ ALL PASS — ${CAP + 1} overlapping worker_spawn calls for DISTINCT tasks (cap=${CAP}) admit exactly ${CAP}, reject the rest with the cap error, leave exactly ${CAP} live workers + ${CAP} worktrees/branches (no overshoot, no orphan), and the cap re-admits once a slot frees — claude-free, network-free.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
