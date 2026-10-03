import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5439b7d2 — boot-reconcile's protected-worktree set must ALSO cover a session fleet-wide eligible for
// the ONGOING crash-recovery watchdog (a `session_died`/`worker_report_undelivered` trigger recorded on a
// PRIOR, otherwise-healthy daemon instance), not just this boot's OWN crash victims
// (`deriveCrashOrphanedWorkers`, already covered — see docs/decisions/5439b7d2-*.md for the full
// investigation). REAL git on temp repos, NO claude + NO live daemon — drives reconcileOrchestrationOnBoot()
// directly against an isolated LOOM_HOME, same shape as boot-reconcile-keep-work.mjs. Proves:
//   RED:  an eligible worker's CLEAN worktree (no commits ahead, no dirty files — so Pass B's own
//         worktreeHasWork() fail-safe does NOT save it) is GC'd when reconciled with TODAY's protected-set
//         construction (no fold-in) — the bug reproduces.
//   GREEN: the SAME shape survives once `listCrashRecoveryEligibleSessionIds` (orchestration/
//         crash-recovery-watcher.js) is folded into the protected set before reconcile runs.
//   CONTROL: an INELIGIBLE exited worker (resumability:'dead', so isCrashRecoveryEligible excludes it even
//         though it has the SAME session_died trigger) with an equally clean worktree is STILL GC'd under
//         the fold-in — protection is not blanket.
// Run: 1) build daemon, 2) node test/boot-reconcile-crash-recovery-eligible-protection.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-crep-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { listCrashRecoveryEligibleSessionIds } = await import("../dist/orchestration/crash-recovery-watcher.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=crep@loom -c user.name=crep";
const now = new Date().toISOString();

const db = new Db();
const control = new OrchestrationControl();
const sessions = new SessionService(db, {}, control);

function initRepo(repo, readme) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), readme);
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

// A worker row EXITED on a PRIOR (otherwise-healthy) daemon instance — mirrors recordUnexpectedExit's own
// effect: process_state already 'exited', a durable session_died trigger filed under its own id, no later
// session_recovered. `resumability` defaults 'resumable' (the eligible shape); the positive control passes
// 'dead' to prove the predicate still excludes it even with the identical trigger history.
function seedDiedWorker(p, { resumability = "resumable" } = {}) {
  db.insertProject({ id: p.projId, name: "CREP", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "CREP-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: "eng-" + p.mgrId, title: null, cwd: p.repo, processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({
    id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: "eng-" + p.workerId, title: null,
    cwd: p.worktreePath, processState: "exited", resumability, busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch,
  });
  db.appendEvent({
    id: randomUUID(), ts: now, managerSessionId: p.mgrId, workerSessionId: p.workerId, taskId: p.taskId,
    kind: "session_died", detail: { role: "worker" },
  });
}

// A genuinely CLEAN worktree — no commits ahead of base, no dirty files — so Pass B's own worktreeHasWork()
// fail-safe-to-keep can NEVER be the reason it survives; only PROTECTION (protectedWorktreePaths) can.
async function setupClean(p) {
  initRepo(p.repo, "# crep clean\n");
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  p.worktreePath = worktreePath; p.branch = branch;
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (tag) => ({ projId: `crep-${tag}-proj-${sfx}`, agentId: `crep-${tag}-top-${sfx}`, taskId: `crep-${tag}-task-${sfx}`, mgrId: `crep-${tag}-mgr-${sfx}`, workerId: `crep-${tag}-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-crep-${tag}-${sfx}`) });
const RED = mk("red");       // eligible, reconciled WITHOUT the fold-in
const GREEN = mk("green");   // eligible, reconciled WITH the fold-in
const CTRL = mk("ctrl");     // ineligible (resumability:'dead'), reconciled WITH the fold-in

try {
  // RED is seeded and reconciled FIRST, alone — reconcileOrchestrationOnBoot examines EVERY session in the
  // DB on each call, so GREEN/CTRL must not exist yet during the RED pass or it would GC their equally
  // clean, equally unprotected worktrees too (there is no protected set yet) and the GREEN/CONTROL
  // assertions below would no longer be testing what they claim to.
  await setupClean(RED);
  seedDiedWorker(RED);
  check(`(pre) ${RED.workerId} worktree exists before reconcile`, fs.existsSync(RED.worktreePath));

  // --- RED: today's call shape (no fold-in) — the eligible worker's worktree is GC'd. ---
  const rRed = await sessions.reconcileOrchestrationOnBoot(); // no protected set, exactly today's default
  check("(RED) eligible worker's CLEAN worktree is GC'd under today's protected-set construction (bug reproduces)", !fs.existsSync(RED.worktreePath));
  check("(RED) its branch is left alone (Pass A never finalizes an unlanded branch)", !!execSync(`git branch --list ${RED.branch}`, { cwd: RED.repo }).toString().trim());
  check("(RED) its task stays non-terminal", db.getTask(RED.taskId).columnKey === "in_progress");

  // Now seed GREEN + CTRL, fresh, for the fold-in pass.
  await setupClean(GREEN);
  await setupClean(CTRL);
  seedDiedWorker(GREEN);
  seedDiedWorker(CTRL, { resumability: "dead" });
  check(`(pre) ${GREEN.workerId} worktree exists before the fold-in reconcile`, fs.existsSync(GREEN.worktreePath));
  check(`(pre) ${CTRL.workerId} worktree exists before the fold-in reconcile`, fs.existsSync(CTRL.worktreePath));

  // --- fold-in: compute the SAME set index.ts now folds into protectedSessionIds ---
  const eligibleIds = listCrashRecoveryEligibleSessionIds(db, control);
  check("(fold-in) GREEN's worker IS reported eligible", eligibleIds.includes(GREEN.workerId));
  check("(fold-in) CTRL's worker (resumability:'dead') is NOT reported eligible despite the identical trigger", !eligibleIds.includes(CTRL.workerId));

  // --- GREEN: the fold-in protects the eligible worker's worktree. ---
  const protectedSet = new Set(eligibleIds);
  const rGreen = await sessions.reconcileOrchestrationOnBoot(protectedSet);
  check("(GREEN) eligible worker's CLEAN worktree SURVIVES once the fold-in is applied", fs.existsSync(GREEN.worktreePath));
  check("(GREEN) its task stays non-terminal (nothing finalized)", db.getTask(GREEN.taskId).columnKey === "in_progress");

  // --- CONTROL: the SAME reconcile call (same protected set) still GC's the ineligible worker. ---
  check("(CONTROL) ineligible exited worker's CLEAN worktree is STILL GC'd — protection is not blanket", !fs.existsSync(CTRL.worktreePath));
  check("(CONTROL) its task stays non-terminal too (never finalized, just not protected)", db.getTask(CTRL.taskId).columnKey === "in_progress");

  check("(agg) RED pass pruned exactly 1 worktree (its only candidate)", rRed.worktreesPruned === 1);
  check("(agg) GREEN pass pruned exactly 1 worktree (CTRL only — GREEN itself protected)", rGreen.worktreesPruned === 1);
} finally {
  db.close();
  for (const p of [RED, GREEN, CTRL]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot-reconcile Pass B no longer reclaims a clean worktree belonging to a session still eligible for the ongoing crash-recovery watchdog's own next tick (fleet-wide, independent of which daemon instance recorded its death), while an exited-but-INELIGIBLE worker's equally clean worktree is still reclaimed (protection is not blanket)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
