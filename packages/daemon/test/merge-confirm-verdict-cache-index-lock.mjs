import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 62c4953a round 2 (Code Review 6ed0d5da, B1) — `confirmWorkerMerge`'s own preflight (the staged/
// dirty/untracked overlap probes, sessions/service.ts) takes `withCanonicalIndexLock` BEFORE `mergeBranch`
// ever runs, but its catch block only handled `RepoQuarantinedError` — a `CanonicalIndexLockPresentError`
// escaped uncaught, classified `"unknown"` (NOT in `NEVER_CACHED_OUTCOMES`), and got CACHED by the
// until-superseded verdict cache: a human removing the lock still got the stale refusal replayed forever.
//
// CR repro (quoted): "confirmWorkerMergeUntilSettled against a temp repo with a planted 0-byte
// .git/index.lock. R1 refuses (genuinely-new). unlink the lock. R2 returns the SAME error with
// cacheHit:true."
//
// THE FIX: that preflight now opts in to `withCanonicalIndexLock`'s own `{checkIndexLock:true}` check and
// catches `CanonicalIndexLockPresentError` explicitly, returning the typed `indexLockPresent:true` shape
// (mirroring the quarantine branch right there) — which `classifyOutcome` already maps to
// `"canonical-index-lock-present"`, a string already in `NEVER_CACHED_OUTCOMES`.
//
// Modelled directly on merge-confirm-verdict-cache-quarantine.mjs's own setup/assertion shape.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-verdict-cache-index-lock.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcvcil-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcvcil@loom -c user.name=mcvcil";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcvcil\n");
  execSync(`git init -q && git config user.email mcvcil@loom && git config user.name mcvcil`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

function plantIndexLock(repo) {
  const lockPath = path.join(repo, ".git", "index.lock");
  fs.writeFileSync(lockPath, "");
  return lockPath;
}

async function setupWorkerProject(sfx, reposDir, gateCommand = "pnpm gate") {
  registerForCleanup(reposDir);
  const db = new Db();
  const mgrId = `mcvcil-mgr-${sfx}`, projId = `mcvcil-p-${sfx}`, taskId = `mcvcil-t-${sfx}`, workerId = `mcvcil-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  const config = { orchestration: { gateCommand } };
  db.insertProject({ id: projId, name: "MCVCIL", repoPath: repo, vaultPath: repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcvcil-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcvcil-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcvcil-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCVCIL-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcvcil-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { db, mgrId, projId, taskId, workerId, repo, worktreePath, branch };
}

// ── PREFLIGHT INDEX-LOCK REFUSAL: indexLockPresent:true, BEFORE any gate lane, NEVER cached ──────────────
{
  const sfx = `il-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcvcil-${sfx}`);
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfx, reposDir);
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
  });

  const lockPath = plantIndexLock(repo);
  check("(setup) the canonical repo really has a real .git/index.lock on disk", fs.existsSync(lockPath));

  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(preflight) op 1 settled, NOT merged, refused by the lock BEFORE any gate lane", r1.settled === true && r1.ok && r1.value.merged === false && gateCalls === 0);
  check("(preflight) op 1's result carries indexLockPresent:true", r1.ok && r1.value.indexLockPresent === true);
  check("(preflight) op 1's reason names the specific reason code and the lock path", r1.ok && /canonical_index_lock_present/.test(r1.value.reason ?? "") && (r1.value.reason ?? "").includes(lockPath));

  // A plain re-call while STILL locked is refused again — isolates "the lock persists" from "the verdict
  // cache serves a stale reply", which the NEXT assertion (after removing the lock) is actually about.
  const rStillLocked = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(preflight) a re-call while STILL locked is refused again, still no gate lane", rStillLocked.settled === true && rStillLocked.ok && rStillLocked.value.merged === false && rStillLocked.value.indexLockPresent === true && gateCalls === 0);

  fs.rmSync(lockPath);
  check("(setup) the lock is removed", !fs.existsSync(lockPath));

  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(preflight) B1 FIX: after the lock is removed, the re-call does NOT replay the stale refusal — it actually re-attempts (gate runs for real)", gateCalls === 1 && r2.cacheHit === undefined);
  check("(preflight) op 2 actually merges (the worktree had real, mergeable work all along — only the lock ever stood in the way)", r2.settled === true && r2.ok && r2.value.merged === true);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMergeTracked's preflight refuses before any gate lane while a real " +
    "canonical .git/index.lock is present (indexLockPresent:true, named path+reason), and — the B1 fix " +
    "this file proves — the refusal is NEVER cached: once the lock is removed, a plain re-confirm at the " +
    "SAME commit actually re-attempts instead of replaying the stale refusal."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
