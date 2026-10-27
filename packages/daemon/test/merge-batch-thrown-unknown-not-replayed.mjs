import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 7f86c02f — mergeBatchTracked's own classifyOutcome ALSO maps a thrown batch to "unknown",
// so this card's fix (one shared NEVER_CACHED_OUTCOMES set) applies to merge_batch automatically; see
// that record's "merge_batch's own throw classification" section for the mechanism this file proves.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-batch-thrown-unknown-not-replayed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mbtu-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mbtu@loom -c user.name=mbtu";
const git = (cwd, args) => execSync(`git ${GIT_ID} ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mbtu\n");
  execSync(`git init -q && git config user.email mbtu@loom && git config user.name mbtu`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function cutBranch(repo, projId, label, file, content) {
  const taskId = `mbtu-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, label, GIT_ID);
  return { taskId, branch, worktreePath };
}

const mergeDoneCount = (db, w) => db.listEventsForWorker(w).filter((e) => e.kind === "merge_done").length;
const commitCount = (repo) => Number(git(repo, "rev-list --count HEAD"));

const dbs = [];
const worktrees = [];
try {
  const repo = path.join(os.tmpdir(), `loom-mbtu-${sfx}`);
  makeRepo(repo);
  const projId = `mbtu-proj-${sfx}`;
  const agentId = `mbtu-agent-${sfx}`;
  const mgrId = `mbtu-mgr-${sfx}`;

  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: "MBTU", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const a = await cutBranch(repo, projId, "a", "feature-a.txt", "work a\n");
  const b = await cutBranch(repo, projId, "b", "feature-b.txt", "work b\n");
  worktrees.push(a.worktreePath, b.worktreePath);
  const wA = `mbtu-wkr-a-${sfx}`, wB = `mbtu-wkr-b-${sfx}`;
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }

  const base = commitCount(repo);
  let gateCalls = 0;
  // Throws on the FIRST call (simulating a real batch-gate infra failure), passes on every call after.
  const runGate = async () => { gateCalls++; if (gateCalls === 1) throw new Error("[mbtu] simulated batch gate infra failure"); return { passed: true }; };
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate, syncAttachBudgetMs: 60_000 });

  const r1 = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
  check("(1) the thrown batch settles ok:false", r1.settled === true && r1.ok === false);
  check("(1) classified as the honest non-answer, never a confirmed failure of either candidate", r1.error instanceof Error);
  check("(1) neither candidate's task moved — nothing was touched by the thrown gate", db.getTask(a.taskId)?.columnKey === "in_progress" && db.getTask(b.taskId)?.columnKey === "in_progress");
  check("(1) canonical repo untouched by the thrown attempt", commitCount(repo) === base);

  // Re-fire with the IDENTICAL workerSessionIds — the gate stub now passes (the transient fault cleared).
  const r2 = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
  check("(2) the re-fire is NEVER a cacheHit — \"unknown\" was never cached, this is a genuinely fresh run", r2.cacheHit === undefined);
  check("(2) the re-fire genuinely re-ran the gate (gateCalls went 1 -> 2, not stuck at 1 from a replay)", gateCalls === 2);
  check("(2) the re-fire settles ok:true and genuinely lands the batch", r2.settled === true && r2.ok === true && r2.value?.ok === true);
  check("(2) BOTH candidates landed", (r2.value?.landed?.length ?? 0) === 2);
  check("(2) exactly ONE new commit per candidate landed on main (no double squash from the thrown attempt)", commitCount(repo) === base + 2);
  check("(2) worker A: exactly one merge_done total", mergeDoneCount(db, wA) === 1);
  check("(2) worker B: exactly one merge_done total", mergeDoneCount(db, wB) === 1);
  check("(2) both tasks finished in their terminal (done) column", db.getTask(a.taskId)?.columnKey === "done" && db.getTask(b.taskId)?.columnKey === "done");

  // A THIRD call, same ids — ordinary re-fire semantics resume now that the batch genuinely landed
  // (this re-attaches/replays the SETTLED "landed" verdict, same as any other cacheable outcome).
  const r3 = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
  check("(3) a further re-fire after a real landing is safe and does not re-squash", r3.settled === true && commitCount(repo) === base + 2);
  check("(3) merge_done counts are STILL exactly one each — the third call never duplicates", mergeDoneCount(db, wA) === 1 && mergeDoneCount(db, wB) === 1);

} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — merge_batch's own thrown ('unknown') outcome is never cached or replayed either (NEVER_CACHED_OUTCOMES is one set shared with the solo path): a re-fire with the identical workerSessionIds genuinely re-assembles and re-gates, and each candidate still lands at most once."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
