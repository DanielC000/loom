import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SPLIT OFF merge-confirm-verdict-cache.mjs (card 4e8e2d82): carries ONLY scenarios (f) (gate passes, squash refuses)
// and (g) (tip moved then reset — the ABA shape); (a)-(c)/(e) live in merge-confirm-verdict-cache.mjs and (h/i/j)
// in merge-confirm-verdict-cache-retry-links.mjs. The description below covers all three.
//
// Regression/behavioral tests for card 615967c5 — the until-superseded merge verdict cache is keyed on a
// branch tip that Loom's OWN pre-gate union-merge advances, so the cached-verdict guarantee silently never
// applied to a branch that was behind main. The fix does NOT change the caching (a re-gate of a moved base
// is semantically correct) — it makes the re-mint SELF-ANNOUNCING via `AttachResult.freshMint`, so a
// caller can never mistake an invisible re-run for a replayed cached verdict.
//
// DoD-4's own framing: "a settled verdict on a branch that was NEVER behind main, re-called with no new
// commits, must still return the CACHED verdict" — this is the case the original reporter explicitly
// could NOT manufacture (they refused to fabricate a failed merge) and flagged as UNTESTED behaviorally.
// This file is that test, plus its (b) counterpart: a behind-main branch re-call announces
// identity-mismatch (renamed by card a98f97bd from "base-advanced" — an OBSERVED field, not an assertion
// of cause) with both identities; and its (c) counterpart: the SAME renamed value fires when the mismatch
// is instead caused by the worker pushing its own new commit, with no main advance at all.
//
// Exercises `SessionService.confirmWorkerMergeTracked` directly against a REAL git repo/worktree (no
// stubbed git — only the gate command itself is stubbed, same seam merge-rest-route-tracked.mjs uses),
// since the identity resolution this card is about (`resolveGitRef`, `mergeMainIntoWorktree`) is real git
// plumbing that a synthetic in-memory PendingOpRegistry test (pending-ops-registry.mjs) can't exercise.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-verdict-cache-squash-refusal.mjs
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
// (r) gate passes, canonical dirtied at a path the branch touches DURING the gate -> squash refuses; human cleans; re-confirm.
{
  const sfx = `nb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcvc-nb-${sfx}`);
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfx, reposDir);
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    runGate: async () => { gateCalls++; if (gateCalls === 1) fs.writeFileSync(path.join(repo, "feature.txt"), "live overlap appeared DURING the gate\n"); return { passed: true, steps: [] }; },
  });
  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(never-behind) op 1 settled, NOT merged (squash refused after a PASSING gate) — fixture sanity", r1.settled === true && r1.ok && r1.value.merged === false && gateCalls === 1);
  console.log("  r1 reason:", r1.ok ? r1.value.reason : r1.error);
  fs.rmSync(path.join(repo, "feature.txt"));
  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  console.log("  r2 cacheHit:", r2.cacheHit, "gateCalls:", gateCalls, "merged:", r2.ok && r2.value.merged);
  check("(never-behind) after the checkout is cleaned the re-confirm is NOT a replay of the stale refusal (cacheHit undefined)", r2.cacheHit === undefined);
  check("(never-behind) the re-confirm actually landed the merge", r2.ok && r2.value.merged === true);
}
// (p) ADMISSION preflight: the canonical checkout is ALREADY dirty on a path the branch touches -> refused BEFORE any gate.
//     A premature re-call (still dirty) is refused fast again with ZERO gate runs (never-cache must not burn a lane);
//     after the human cleans it, the re-call is a real attempt that gates + lands.
{
  const sfx = `pre-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfx, path.join(os.tmpdir(), `loom-mcvc-pre-${sfx}`));
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; return { passed: true, steps: [] }; } });
  fs.writeFileSync(path.join(repo, "feature.txt"), "dirty before admission\n");
  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(preflight) op 1 refused at admission, no gate run", r1.settled === true && r1.ok && r1.value.merged === false && gateCalls === 0);
  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(preflight) PREMATURE re-call (still dirty) is a fresh refusal, NOT a replay, and spends NO gate", r2.cacheHit === undefined && r2.ok && r2.value.merged === false && gateCalls === 0);
  fs.rmSync(path.join(repo, "feature.txt"));
  const r3 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(preflight) after cleaning, the re-call gates once and lands", r3.cacheHit === undefined && r3.ok && r3.value.merged === true && gateCalls === 1);
}

// (e) POLARITY PIN: STAGE_EMPTY_RETRY is about the BRANCH (no diff vs main), so it STILL replays from the cache.
{
  const sfx = `emp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { db, mgrId, workerId, worktreePath } = await setupWorkerProject(sfx, path.join(os.tmpdir(), `loom-mcvc-emp-${sfx}`));
  execSync(`git reset --hard HEAD~1`, { cwd: worktreePath }); // branch is now 0 commits ahead: nothing to squash
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; return { passed: true, steps: [] }; } });
  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  console.log("  empty r1:", r1.ok ? JSON.stringify({ merged: r1.value.merged, emptyKind: r1.value.emptyKind, reason: r1.value.reason }) : r1.error, "gateCalls:", gateCalls);
  check("(stage-empty) op 1 refused as STAGE_EMPTY_RETRY — fixture sanity", r1.settled === true && r1.ok && r1.value.merged === false && r1.value.emptyKind === "STAGE_EMPTY_RETRY");
  const gatesAfter1 = gateCalls;
  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(stage-empty) the re-call REPLAYS the cached refusal (cacheHit set, no new gate)", r2.cacheHit !== undefined && gateCalls === gatesAfter1);
}

// (s) STRUCTURAL PIN: every squash-blocking refusal site routes through the ONE squashRefusedResult constructor.
{
  const src = fs.readFileSync(new URL("../src/sessions/service.ts", import.meta.url), "utf8");
  const literalSites = (src.match(/rejectNotify\("canonical_(staged_dirt|dirty_overlap)"/g) ?? []).length;
  const wrapped = (src.match(/return squashRefusedResult\(\{ merged: false/g) ?? []).length;
  check(`(structural) 3 admission canonical_* refusals + the 1 squash-time refusal all wrapped (literal sites=${literalSites}, wrapped=${wrapped}; scope: service.ts)`, literalSites === 3 && wrapped === 4);
  check("(structural) classifyOutcome reads the single marker", /outcome\.value\.squashRefused \? "squash-refused"/.test(src));
  const po = fs.readFileSync(new URL("../src/orchestration/pending-ops.ts", import.meta.url), "utf8");
  check("(structural) squash-refused is in NEVER_CACHED_OUTCOMES", /NEVER_CACHED_OUTCOMES[^\n]*"squash-refused"/.test(po));
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
