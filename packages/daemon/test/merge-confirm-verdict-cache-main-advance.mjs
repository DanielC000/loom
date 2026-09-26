import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c06f876a — a cached merge REJECTION must not be replayed once canonical main has advanced since it was
// recorded (no new worker commits): "red because main was broken -> main fixed -> re-call" must re-gate for real.
// RED before the fix (the re-call replays the stale rejection, gateCalls stays 1); the no-advance control stays a
// cache hit (1555e361 anti-laundering: a plain re-call with NOTHING changed never re-gates).
// Real git repo/worktree; only the gate command is stubbed. Run: pnpm build, then node packages/daemon/test/merge-confirm-verdict-cache-main-advance.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

process.env.LOOM_GATE_RETRY_SETTLE_MS = "20"; // the retry-link scenarios below wait this long between links
process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcvc-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcvc@loom -c user.name=mcvc";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcvc\n");
  execSync(`git init -q && git config user.email mcvc@loom && git config user.name mcvc`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

function headSha(cwd) {
  return execSync(`git ${GIT_ID} rev-parse HEAD`, { cwd }).toString().trim();
}

async function setupWorkerProject(sfx, reposDir, gateCommand = "pnpm gate") {
  registerForCleanup(reposDir);
  const db = new Db();
  const mgrId = `mcvc-mgr-${sfx}`, projId = `mcvc-p-${sfx}`, taskId = `mcvc-t-${sfx}`, workerId = `mcvc-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  const config = { orchestration: { gateCommand } };
  db.insertProject({ id: projId, name: "MCVC", repoPath: repo, vaultPath: repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcvc-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcvc-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcvc-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCVC-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  const workerSha = headSha(worktreePath);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcvc-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { db, mgrId, projId, taskId, workerId, repo, worktreePath, branch, workerSha };
}


const mkSessions = (db, counter) => new SessionService(db, ptyStub, new OrchestrationControl(), {
  syncAttachBudgetMs: 60_000, runGate: async () => { counter.n++; return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; },
});

// (1) CONTROL: rejection, nothing moves, re-call -> cache hit (the anti-laundering polarity).
{
  const sfx = `ctl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { db, mgrId, workerId } = await setupWorkerProject(sfx, path.join(os.tmpdir(), `loom-mcvma-${sfx}`));
  const c = { n: 0 }; const s = mkSessions(db, c);
  const r1 = await settleTracked(() => s.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirm" });
  const r2 = await settleTracked(() => s.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirm" });
  check("(control) op 1 rejected after one real gate", r1.ok && r1.value.merged === false && c.n === 1);
  check("(control) unchanged re-call is a cache hit, no second gate", c.n === 1 && r2.cacheHit !== undefined && r2.ok && r2.value.opId === r1.value.opId);
}

// (2) NEVER-FORWARDED branch (main was not ahead at op 1): main advances afterwards, worker pushes nothing.
{
  const sfx = `nofwd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfx, path.join(os.tmpdir(), `loom-mcvma-${sfx}`));
  const c = { n: 0 }; const s = mkSessions(db, c);
  const r1 = await settleTracked(() => s.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirm" });
  check("(never-forwarded) op 1 rejected after one real gate", r1.ok && r1.value.merged === false && c.n === 1);
  fs.writeFileSync(path.join(repo, "main-fix.txt"), "main fixed\n");
  commitAll(repo, "main fixed", GIT_ID);
  const r2 = await settleTracked(() => s.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirm" });
  check("(never-forwarded) re-call after main advanced RE-GATES for real", c.n === 2 && r2.cacheHit === undefined);
}

// (3) FORWARDED branch (main was ahead at op 1, confirm's own forward moved the tip); main advances AGAIN afterwards.
{
  const sfx = `fwd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfx, path.join(os.tmpdir(), `loom-mcvma-${sfx}`));
  const c = { n: 0 }; const s = mkSessions(db, c);
  fs.writeFileSync(path.join(repo, "adv1.txt"), "1\n"); commitAll(repo, "adv1", GIT_ID);
  const r1 = await settleTracked(() => s.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirm" });
  check("(forwarded) op 1 rejected after one real gate", r1.ok && r1.value.merged === false && c.n === 1);
  fs.writeFileSync(path.join(repo, "adv2.txt"), "2\n"); commitAll(repo, "adv2", GIT_ID);
  const r2 = await settleTracked(() => s.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirm" });
  check("(forwarded) re-call after main advanced again RE-GATES for real", c.n === 2 && r2.cacheHit === undefined);
}

// (4) OLD-FORMAT IDENTITY (no |main: segment, e.g. minted before this card): never hits, reads as a MISS (re-gate), never throws.
{
  const { PendingOpRegistry } = await import("../dist/orchestration/pending-ops.js");
  const reg = new PendingOpRegistry();
  let calls = 0;
  const classify = (o) => (o.ok && o.value.merged ? "merged" : "rejected");
  const opts = (id) => ({ retainMs: 30, retainVerdictUntilSuperseded: true, verdictIdentity: id, classifyOutcome: classify });
  const OLD = "a".repeat(40) + "|mergeGate:on", NEW = "a".repeat(40) + "|main:" + "b".repeat(40) + "|mergeGate:on";
  await reg.attach("k-old", "merge", "m", 200, async () => { calls++; return { merged: false, opId: "o1" }; }, undefined, opts(OLD));
  const hit = await reg.attach("k-old", "merge", "m", 200, async () => { calls++; return { merged: false, opId: "o2" }; }, undefined, opts(OLD));
  check("(old-format control) an identical old-format identity is still a hit", calls === 1 && hit.cacheHit !== undefined);
  const miss = await reg.attach("k-old", "merge", "m", 200, async () => { calls++; return { merged: false, opId: "o3" }; }, undefined, opts(NEW));
  check("(old-format) a new-format identity against a stored old-format one MISSES and re-runs", calls === 2 && miss.cacheHit === undefined && miss.freshMint?.reason === "identity-mismatch");
}

console.log(failures === 0 ? "\n✅ ALL PASS — merge rejection re-gates when main advanced (card c06f876a)" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
