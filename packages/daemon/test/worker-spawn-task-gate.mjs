import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn taskId-validation gate (PL Auditor finding #1, P1 — prevents silent work loss).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like worker-spawn-agent-gate.mjs: isolated
// LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService driven against a FAKE pty (createPty() seam).
// A real temp git repo backs spawnWorker's createWorktree; the only thing faked is the claude pty.
//
// The bug: worker_spawn validated agentId ("does not resolve to an existing agent") but NOT taskId. A
// manager once passed a TRUNCATED taskId with a trailing space + a placeholder kickoff → the spawn
// SUCCEEDED, binding a live worker to a bogus task string (a zombie) while the real task stayed in
// backlog. The fix mirrors the agentId existence guard for taskId, BEFORE any worktree/session side
// effect, so a bad id creates NOTHING.
//
// Proves the DoD points:
//   (1) a truncated taskId WITH a trailing space is REJECTED (the exact repro) — no worktree/session;
//   (2) a malformed/unknown taskId is REJECTED;
//   (3) an empty / whitespace-only taskId is a TASKLESS spawn (card 2514e6e1) — NOT rejected. Trim-to-empty
//       is treated the same as an omitted taskId (both mean "no task"), so this now SPAWNS a taskless
//       worker (own worktree, taskId null, no card touched) instead of erroring — see
//       worker-spawn-taskless.mjs for the dedicated taskless-path coverage.
//   (4) a taskId that exists but belongs to ANOTHER project is REJECTED (project-scoped);
//   (5) a terminal (done-lane) taskId is REJECTED — pick a non-terminal task;
//   (6) a VALID non-terminal taskId still SPAWNS (binds the worker, moves the card, creates the worktree).
//   + after every rejection: NO worktree dir was allocated AND NO worker session row was created.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-task-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// assert that an async call rejects, and that its message includes `needle`.
const rejects = async (label, fn, needle) => {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  const ok = threw != null && (!needle || String(threw.message).includes(needle));
  check(`${label}${ok || !threw ? "" : ` (got: ${threw.message})`}`, ok);
};

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wstg-${Date.now()}-${process.pid}`);
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
const repo = path.join(os.tmpdir(), `loom-wstg-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-task-gate test\n");
execSync(`git init -q && git add . && git -c user.email=ws@loom -c user.name=ws commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// Two projects (kanbanColumns: backlog…done; terminal role → "done"). pP's cap is raised above the
// default (3): this file now spawns FOUR live workers on pP across its scenarios — the two NEW taskless
// spawns from (3)/(3') on top of the pre-existing (6)/(trim) tasked ones — none of which are stopped
// mid-test, so the default cap would spuriously reject a later legitimate spawn.
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 6 } }, createdAt: now, archivedAt: null });
db.insertProject({ id: "pOther", name: "Other", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// A plain (profile-less) worker agent in pP — role resolves null ⇒ allowed as a worker.
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
// Tasks: a real non-terminal (backlog) one, a terminal (done) one in pP, and one in the OTHER project.
// taskTrim is a second backlog task used to prove trailing-whitespace normalization on a FRESH spawn (the
// live-worker-on-task guard now rejects a SECOND live worker on taskGood, so trim can't re-spawn onto it).
const taskGood = randomUUID(), taskDone = randomUUID(), taskOther = randomUUID(), taskTrim = randomUUID();
db.insertTask({ id: taskGood, projectId: "pP", title: "real", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: taskDone, projectId: "pP", title: "done", body: "", columnKey: "done", position: 2, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: taskOther, projectId: "pOther", title: "elsewhere", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: taskTrim, projectId: "pP", title: "trim", body: "", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

// "no worktree allocated" = the project's worktree dir was never created (createWorktree mkdirs it).
const ptWorktreeDir = path.join(tmpHome, "worktrees", "pP");
const noSideEffects = () => !fs.existsSync(ptWorktreeDir) && db.listWorkers("mgr1").length === 0;

const worktrees = [];
try {
  // ===================== rejections — a bad id must create NOTHING =====================
  // (1) the EXACT repro: a truncated UUID with a trailing space. Trim leaves it truncated. card 3e9e1d9f
  // added id-PREFIX resolution (MIN_ID_PREFIX_LEN=8) — a truncation of 8+ chars is now a LEGITIMATE
  // unambiguous prefix and correctly SPAWNS (see worker-spawn-task-prefix.mjs), so this repro must
  // truncate BELOW that floor to still exercise "truncated ⇒ rejected, no zombie spawn".
  await rejects("(1) truncated taskId with a trailing space is rejected",
    () => svc.spawnWorker("mgr1", { taskId: `${taskGood.slice(0, 5)} `, agentId: "agentDev", kickoffPrompt: "GO" }), "does not resolve");
  // (2) a malformed / unknown id (well-formed-looking but no such task).
  await rejects("(2) malformed/unknown taskId is rejected",
    () => svc.spawnWorker("mgr1", { taskId: randomUUID(), agentId: "agentDev", kickoffPrompt: "GO" }), "does not resolve");
  // (4) a real task, but in ANOTHER project (project-scoped existence — mirrors agentId's project scoping).
  await rejects("(4) a taskId from another project is rejected",
    () => svc.spawnWorker("mgr1", { taskId: taskOther, agentId: "agentDev", kickoffPrompt: "GO" }), "does not resolve");
  // (5) a terminal (done-lane) task — pick a non-terminal one.
  await rejects("(5) a terminal/done taskId is rejected",
    () => svc.spawnWorker("mgr1", { taskId: taskDone, agentId: "agentDev", kickoffPrompt: "GO" }), "terminal");

  // After every GENUINE rejection: NO worktree dir was allocated AND NO worker session row was created.
  check("(side-effects) no worktree dir allocated + no worker session created by any rejected spawn", noSideEffects());
  // The rejected ids never moved a card: the done task is still in `done`, the other-project task untouched.
  check("(side-effects) terminal task stayed in its done lane (a rejected spawn never moved it)",
    db.getTask(taskDone).columnKey === "done");

  // (3) empty / whitespace-only taskId is now a TASKLESS spawn, not a rejection (card 2514e6e1) — trim-to-
  // empty means the same "no task" as an omitted taskId. Proves it SPAWNS (taskId null, own worktree, no
  // card touched) rather than throwing; checked AFTER the noSideEffects() assertion above since — unlike
  // the genuine rejections (1,2,4,5) — a taskless spawn DOES have side effects (its own worktree/session),
  // just none of them a board-card move. The dedicated worker-spawn-taskless.mjs covers this path in depth.
  const wsWhitespace = await svc.spawnWorker("mgr1", { taskId: "   ", agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wsWhitespace.worktreePath);
  check("(3) whitespace-only taskId spawns a TASKLESS worker (taskId null, not rejected)",
    wsWhitespace.role === "worker" && wsWhitespace.taskId === null && !!wsWhitespace.worktreePath && fs.existsSync(wsWhitespace.worktreePath));
  const wsEmpty = await svc.spawnWorker("mgr1", { taskId: "", agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wsEmpty.worktreePath);
  check("(3') empty taskId spawns a TASKLESS worker (taskId null, not rejected)",
    wsEmpty.role === "worker" && wsEmpty.taskId === null && wsEmpty.worktreePath !== wsWhitespace.worktreePath);

  // ===================== (6) a VALID non-terminal taskId still SPAWNS =====================
  const w = await svc.spawnWorker("mgr1", { taskId: taskGood, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(w.worktreePath);
  check("(6) valid non-terminal taskId spawns a worker (role=worker, bound to the task)",
    w.role === "worker" && w.taskId === taskGood && w.agentId === "agentDev");
  check("(6) the worktree was created on disk for the valid spawn", !!w.worktreePath && fs.existsSync(w.worktreePath));
  check("(6) the worker row persists with the validated taskId", db.getSession(w.id).taskId === taskGood);
  check("(6) the card moved OUT of backlog into the active lane (default config ⇒ in_progress)",
    db.getTask(taskGood).columnKey === "in_progress");

  // A trailing-space on an OTHERWISE-VALID id is NORMALIZED by trim and accepted (robustness, not rejection).
  // Use a FRESH task (taskTrim): the live-worker-on-task guard now rejects a second live worker on taskGood,
  // so this proves trim normalization without colliding with that guard.
  const w2 = await svc.spawnWorker("mgr1", { taskId: `  ${taskTrim}  `, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(w2.worktreePath);
  check("(trim) surrounding whitespace on a valid id is trimmed and accepted (binds the real task)",
    w2.role === "worker" && w2.taskId === taskTrim);
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of worktrees.filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_spawn validates a NON-EMPTY taskId BEFORE any side effect: a truncated/trailing-space/wrong-project/terminal id is rejected with the agentId-style error and creates NO worktree or session; an empty/whitespace-only (or omitted) taskId now spawns a TASKLESS worker instead of erroring (card 2514e6e1); a valid non-terminal id still spawns exactly as before — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
