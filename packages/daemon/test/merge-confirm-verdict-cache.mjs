import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression/behavioral tests for card 615967c5 — the until-superseded merge verdict cache is keyed on a
// branch tip that Loom's OWN pre-gate union-merge advances, so the cached-verdict guarantee silently never
// applied to a branch that was behind main. The fix does NOT change the caching (a re-gate of a moved base
// is semantically correct) — it makes the re-mint SELF-ANNOUNCING via `AttachResult.freshMint`, so a
// caller can never mistake an invisible re-run for a replayed cached verdict.
//
// DoD-4's own framing: "a settled verdict on a branch that was NEVER behind main, re-called with no new
// commits, must still return the CACHED verdict" — this is the case the original reporter explicitly
// could NOT manufacture (they refused to fabricate a failed merge) and flagged as UNTESTED behaviorally.
// This file is that test, plus its (b) counterpart: a behind-main branch re-call announces base-advanced
// with both identities.
//
// Exercises `SessionService.confirmWorkerMergeTracked` directly against a REAL git repo/worktree (no
// stubbed git — only the gate command itself is stubbed, same seam merge-rest-route-tracked.mjs uses),
// since the identity resolution this card is about (`resolveGitRef`, `mergeMainIntoWorktree`) is real git
// plumbing that a synthetic in-memory PendingOpRegistry test (pending-ops-registry.mjs) can't exercise.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-verdict-cache.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";

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
  execSync(`git init -q && git config user.email mcvc@loom && git config user.name mcvc && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

function headSha(cwd) {
  return execSync(`git ${GIT_ID} rev-parse HEAD`, { cwd }).toString().trim();
}

async function setupWorkerProject(sfx, reposDir) {
  registerForCleanup(reposDir);
  const db = new Db();
  const mgrId = `mcvc-mgr-${sfx}`, projId = `mcvc-p-${sfx}`, taskId = `mcvc-t-${sfx}`, workerId = `mcvc-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  const config = { orchestration: { gateCommand: "pnpm gate" } };
  db.insertProject({ id: projId, name: "MCVC", repoPath: repo, vaultPath: repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcvc-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcvc-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcvc-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCVC-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt"`, { cwd: worktreePath });
  const workerSha = headSha(worktreePath);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcvc-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { db, mgrId, projId, taskId, workerId, repo, worktreePath, branch, workerSha };
}

// ── (a) THE ACTUAL DELIBERATE, PREVIOUSLY-UNTESTED DELIVERABLE (card 615967c5, DoD-4a): a settled verdict
//        on a branch that was NEVER behind main, re-called with no new commits, must still return the
//        CACHED verdict — no second gate run, freshMint absent (the signal a cache hit is distinguishable
//        by). This is `1555e361`'s central claim, verified here for the first time.
{
  const sfx = `same-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcvc-same-${sfx}`);
  const { db, mgrId, workerId } = await setupWorkerProject(sfx, reposDir);
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    runGate: async () => { gateCalls++; return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; },
  });

  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(same-identity) op 1 settled", r1.settled === true && r1.ok === true);
  check("(same-identity) op 1 was rejected (gate stub always fails)", r1.ok && r1.value.merged === false);
  check("(same-identity) op 1 announces genuinely-new (nothing cached yet)", r1.freshMint?.reason === "genuinely-new");
  check("(same-identity) the gate ran exactly once for op 1", gateCalls === 1);

  // No new commits — main never moved (single-commit repo, no other branch touched it), the worker made no
  // further commits. A plain re-call with NOTHING changed must return the CACHED rejection, not run a
  // second real gate.
  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(same-identity) op 2 settled", r2.settled === true && r2.ok === true);
  check("(same-identity) the gate did NOT run a second time — POSITIVE CONTROL for the cache hit", gateCalls === 1);
  check("(same-identity) op 2 returns the SAME cached opId, not a fresh one", r2.ok && r1.ok && r2.value.opId === r1.value.opId);
  check("(same-identity) op 2 carries NO freshMint — the cache-hit signal", r2.freshMint === undefined);
}

// ── (b) BASE-ADVANCED: a branch that WAS behind main gets its tip advanced by THIS call's OWN pre-gate
//        union-merge (mergeMainIntoWorktree) — so a re-call's freshly-resolved identity no longer matches
//        the cached verdict's, even though the WORKER pushed no new commits at all. The re-call must
//        announce base-advanced with BOTH the cached (prior) identity and the current tip — never a silent
//        re-run indistinguishable from a cache hit.
{
  const sfx = `adv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcvc-adv-${sfx}`);
  const { db, mgrId, workerId, repo, worktreePath, workerSha } = await setupWorkerProject(sfx, reposDir);
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    runGate: async () => { gateCalls++; return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; },
  });

  // Advance MAIN (in the canonical repo, not the worktree) — the worker's branch is now genuinely behind.
  fs.writeFileSync(path.join(repo, "main-advance.txt"), "advanced\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "main advanced"`, { cwd: repo });
  const mainShaAfterAdvance = headSha(repo);
  check("(base-advanced setup) main genuinely moved past the worker's branch point", mainShaAfterAdvance !== workerSha);

  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(base-advanced) op 1 settled", r1.settled === true && r1.ok === true);
  check("(base-advanced) op 1 was rejected (gate stub always fails)", r1.ok && r1.value.merged === false);
  check("(base-advanced) op 1 announces genuinely-new — nothing was cached before this call", r1.freshMint?.reason === "genuinely-new");
  check("(base-advanced) the gate ran exactly once for op 1", gateCalls === 1);

  // op 1's OWN pre-gate union-merge (mergeMainIntoWorktree) should have advanced the worktree's branch tip
  // to a NEW commit that unions the worker's work with main's advance — never the worker's original sha.
  const shaAfterOp1 = headSha(worktreePath);
  check("(base-advanced) op 1's own union-merge advanced the branch tip past the worker's original commit", shaAfterOp1 !== workerSha);

  // The worker pushed NOTHING new — this re-call's only difference from a plain poll is that the branch
  // tip moved underneath the cache, entirely via Loom's own prior confirm.
  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(base-advanced) op 2 settled", r2.settled === true && r2.ok === true);
  check("(base-advanced) the gate genuinely ran a SECOND time — this is real re-gating, not a cache replay", gateCalls === 2);
  check("(base-advanced) op 2 is a genuinely fresh op (different opId from op 1)", r2.ok && r1.ok && r2.value.opId !== r1.value.opId);
  check("(base-advanced) op 2 announces base-advanced", r2.freshMint?.reason === "base-advanced");
  check("(base-advanced) op 2's priorIdentity is the CACHED verdict's identity (the worker's original commit, resolved BEFORE op 1's union-merge ran)", r2.freshMint?.priorIdentity === workerSha);
  check("(base-advanced) op 2's currentIdentity is the branch's tip AS OF op 2's own call (op 1's union-merge result)", r2.freshMint?.currentIdentity === shaAfterOp1);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMergeTracked verdict cache (card 615967c5): a settled verdict on a branch that was NEVER behind main, re-called with no new commits, still returns the CACHED verdict (no second gate run, no freshMint) — DoD-4a, previously unverified behaviorally; and a behind-main branch's own pre-gate union-merge advances the identity the cache is keyed on, so a re-call genuinely re-gates and SELF-ANNOUNCES it via freshMint:{reason:\"base-advanced\", priorIdentity, currentIdentity} instead of looking like an invisible re-run — DoD-4b."
  : `\n❌ ${failures} FAILURE(S).`);
