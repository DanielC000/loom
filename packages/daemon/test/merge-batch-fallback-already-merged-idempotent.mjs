import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 7f86c02f — condition 1 (batch-route half): an ALREADY-LANDED candidate, confirmed via
// merge_batch's fallback, must finish idempotently on re-confirm (no double squash, no duplicate
// merge_done). See that record's "Honest scope" section for why this is NOT a thrown-"unknown" case.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-batch-fallback-already-merged-idempotent.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mbfi-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mbfi@loom -c user.name=mbfi";
const git = (cwd, args) => execSync(`git ${GIT_ID} ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

function makePtyStub() {
  const calls = [];
  return {
    calls,
    stop() {}, isAlive() { return false; }, getPid() { return undefined; },
    enqueueStdin(sessionId, text) { calls.push({ sessionId, text }); return { delivered: true }; },
  };
}

async function setup(sfx) {
  const reposDir = path.join(os.tmpdir(), `loom-mbfi-repo-${sfx}`);
  registerForCleanup(reposDir);
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mbfi\n");
  execSync(`git init -q && git config user.email mbfi@loom && git config user.name mbfi`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);

  const db = new Db();
  const mgrId = `mbfi-mgr-${sfx}`, projId = `mbfi-p-${sfx}`, taskId = `mbfi-t-${sfx}`, workerId = `mbfi-w-${sfx}`;
  const config = { orchestration: { gateCommand: "pnpm gate" } };
  db.insertProject({ id: projId, name: "MBFI", repoPath: repo, vaultPath: repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mbfi-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mbfi-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mbfi-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MBFI-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mbfi-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  // Mirrors mergeBranch's OWN squash + trailer exactly (worktrees.ts's mergeBranchLocked) — a REAL
  // `git merge --squash` so findLandedSquashCommit's content check genuinely passes, the same way a real
  // predecessor's landed squash would.
  execSync(`git merge --squash ${branch}`, { cwd: repo });
  execSync(`git ${GIT_ID} commit -q -m "feat: MBFI-TASK" --trailer "Loom-Worker-Branch: ${branch}"`, { cwd: repo });

  return { db, repo, mgrId, projId, taskId, workerId, branch, worktreePath };
}

{
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { db, mgrId, repo, taskId, workerId } = await setup(sfx);
  const headBefore = git(repo, "rev-parse HEAD");
  const pty = makePtyStub();
  // No injected throw needed here (see the HONEST SCOPE note above) — a real gate stub is still supplied
  // so a surprise gate invocation (the shape genuinely changing underfoot) fails loudly instead of
  // silently passing through an untested code path.
  const sessions = new SessionService(db, pty, new OrchestrationControl(), {
    runGate: async () => { throw new Error("[test] unexpected gate invocation — the already-landed short-circuit should have skipped the gate entirely"); },
    syncAttachBudgetMs: 60_000,
  });

  const batchResult = await sessions.mergeBatchTracked(mgrId, [workerId]);
  check("(batch) a single candidate settles synchronously via the '< 2 eligible' early-fallback path", batchResult.settled === true);
  check("(batch) ok:true, nothing eligible to BATCH (routed to the per-branch fallback instead)", batchResult.ok === true && batchResult.value?.ok === false && batchResult.value?.reason === "nothing eligible to batch");
  const fb1 = batchResult.value?.fallback?.find((f) => f.workerSessionId === workerId);
  check("(batch) the fallback candidate's own confirm actually started", fb1 !== undefined && fb1.started === true);
  check("(batch) canonical repo gained NO new commit — the already-landed squash was only OBSERVED, never re-merged", git(repo, "rev-parse HEAD") === headBefore);
  check("(batch) EXACTLY ONE merge_done event filed via the fallback route", db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_done").length === 1);
  check("(batch) the task moved to a terminal (done) column", db.getTask(taskId)?.columnKey === "done");

  // Card 7f86c02f condition 1: a re-confirm AGAIN through the SAME batch entrypoint must finish
  // idempotently — never a double squash, never a duplicate merge_done. ("merged" stays cacheable —
  // only "unknown" joined NEVER_CACHED_OUTCOMES — so this exercises the ordinary ALREADY_MERGED
  // short-circuit via the batch route, proving it isn't disturbed by this card's fix.)
  const batchResult2 = await sessions.mergeBatchTracked(mgrId, [workerId]);
  check("(batch re-confirm) settles again via the same early-fallback path", batchResult2.settled === true);
  check("(batch re-confirm) canonical repo STILL gained no new commit — never squashed twice", git(repo, "rev-parse HEAD") === headBefore);
  check("(batch re-confirm) merge_done count STAYS at 1 — no duplicate filed by the re-confirm", db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_done").length === 1);
  check("(batch re-confirm) the task is still in its terminal (done) column", db.getTask(taskId)?.columnKey === "done");

  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the ALREADY_MERGED idempotent-finish path (exactly one merge_done, no double squash, task moved to done) works identically when reached via merge_batch's own fallback entrypoint, not just a solo worker_merge_confirm — and a re-confirm through the same batch route stays idempotent too."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
