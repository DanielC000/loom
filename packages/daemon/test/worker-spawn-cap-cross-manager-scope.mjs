import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn CROSS-MANAGER cap-admission SCOPE-MISMATCH race (card 7234688b).
//
// THE BUG (pre-fix): the concurrency-cap admit summed a DAEMON-GLOBAL in-flight-spawn count
// (`inFlightSpawnTaskIds.size`) against a PER-MANAGER live-worker count (`db.listWorkers(managerSessionId)`).
// The two terms of `liveWorkers + inFlightSpawnTaskIds.size >= cap` had DIFFERENT SCOPES: a manager could be
// genuinely BELOW its own cap and still get cap-rejected purely because a totally unrelated SIBLING manager
// happened to have its own worker_spawn in flight at that instant. That claim is held for the manager's ENTIRE
// worktree-provisioning window (createWorktree: a bounded install up to PROVISION_TIMEOUT_MS plus a bounded
// build up to PROVISION_BUILD_TIMEOUT_MS, git/worktrees.ts) — seconds to minutes, not a microsecond TOCTOU — so
// this was reachable any time two managers' spawns overlapped, which is ordinary on a multi-project daemon.
//
// A single-manager test structurally cannot see this: it needs TWO managers sharing ONE SessionService (one
// daemon), with manager B's spawn deliberately left mid-claim (before its first `await createWorktree`
// resolves) while manager A — genuinely below its OWN cap — tries to spawn a DIFFERENT task.
//
// THE FIX: scope the cap-admission's in-flight term to the calling manager (inFlightSpawnCountByManager),
// leaving the existing daemon-global `inFlightSpawnTaskIds` Set untouched for its OWN, correctly-global,
// per-taskId duplicate-spawn guard (a taskId is unique daemon-wide, so that guard has no scope problem).
//
// Proves:
//   (1) manager A (1 of cap=2 live — genuinely below its own cap) is ADMITTED for a new task even while
//       manager B's own spawn for a DIFFERENT task is still mid-claim (before B's createWorktree resolves).
//   (2) manager B's own spawn also succeeds normally — the fix doesn't block B either.
//   (3) no overshoot: after both settle, A has exactly CAP live workers and B has exactly 1.
//
// RED-PROOF (see the worker's own report for the raw run log): reverting the fix on service.ts alone and
// re-running this file against the pre-fix admit logic reproduces assertion (1) failing — A's spawn is
// rejected with "concurrency cap reached" purely because of B's in-flight claim, despite A being 1-of-2 live.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-cap-cross-manager-scope.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wxmgr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-wxmgr-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-cap-cross-manager-scope test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=wxmgr@loom -c user.name=wxmgr");

const CAP = 2; // per-manager cap, shared config for both managers on this one project
const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pX", name: "X", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: CAP } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pX", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pX", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgrA", projectId: "pX", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
db.insertSession({ id: "mgrB", projectId: "pX", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

const taskA0 = randomUUID(); // A's PRE-EXISTING live worker (puts A at 1-of-CAP — below cap, not empty)
const taskA1 = randomUUID(); // A's NEW spawn — the one that must NOT be affected by B's in-flight claim
const taskB1 = randomUUID(); // B's spawn — deliberately left mid-claim during the race
const tasks = [[taskA0, "A0"], [taskA1, "A1"], [taskB1, "B1"]];
tasks.forEach(([id, title], i) => {
  db.insertTask({ id, projectId: "pX", title, body: "", columnKey: "backlog", position: i + 1, priority: "p2", createdAt: now, updatedAt: now });
});

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
  // ===================== setup: A has ONE pre-existing live worker (1 of CAP=2 — below cap) =====================
  const a0 = await svc.spawnWorker("mgrA", { taskId: taskA0, agentId: "agentDev", kickoffPrompt: "GO A0" });
  check("(setup) A's pre-existing worker (A0) is live", a0.processState === "live");
  worktrees.push(a0.worktreePath);

  // ===================== the racing interleaving: B's spawn left MID-CLAIM, then A tries to spawn =====================
  // No await between these two calls: each async fn runs its synchronous prefix (through the cap admit + the
  // per-taskId/per-manager claim) up to its FIRST await (createWorktree). Firing B first means B's claim is
  // already recorded in the shared bookkeeping by the time A's synchronous prefix runs its own cap check.
  const bPromise = svc.spawnWorker("mgrB", { taskId: taskB1, agentId: "agentDev", kickoffPrompt: "GO B1" });
  const aPromise = svc.spawnWorker("mgrA", { taskId: taskA1, agentId: "agentDev", kickoffPrompt: "GO A1" });
  const [bResult, aResult] = await Promise.allSettled([bPromise, aPromise]);

  // ===================== (1) A — genuinely below its OWN cap — is admitted despite B's mid-claim =====================
  check("(1) manager A's spawn is ADMITTED (1-of-2 live, below its own cap) despite manager B's unrelated in-flight claim",
    aResult.status === "fulfilled");
  if (aResult.status === "rejected") {
    console.log(`    (diagnostic) A's spawn was rejected: ${aResult.reason?.message}`);
  } else {
    worktrees.push(aResult.value.worktreePath);
  }

  // ===================== (2) B's own spawn succeeds too — the fix doesn't block B either =====================
  check("(2) manager B's own spawn succeeds normally", bResult.status === "fulfilled");
  if (bResult.status === "fulfilled") worktrees.push(bResult.value.worktreePath);

  // ===================== (3) no overshoot: A has exactly CAP live workers, B has exactly 1 =====================
  const liveA = db.listWorkers("mgrA").filter((w) => w.processState === "live");
  const liveB = db.listWorkers("mgrB").filter((w) => w.processState === "live");
  check(`(3) manager A has exactly ${CAP} live workers (A0 + the newly-admitted A1, no overshoot)`, liveA.length === CAP);
  check("(3) manager B has exactly 1 live worker (B1)", liveB.length === 1);
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
  ? "\n✅ ALL PASS — a manager genuinely below its own concurrency cap is admitted even while a totally unrelated SIBLING manager's worker_spawn is mid-claim (before its own createWorktree resolves) — the cap-admission comparison is scoped per-manager, matching maxConcurrentWorkers' own documented per-manager semantics — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
