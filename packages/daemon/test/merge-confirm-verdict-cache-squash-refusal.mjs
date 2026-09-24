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

// ── (f) THE GATE PASSES, THEN THE SQUASH REFUSES (Code Review MAJOR 2): a forwarded branch whose gate PASSED but
//        whose squash was refused by the canonical checkout (dirty overlap) is NOT a gate-failed rejection and
//        must not get the new stamp — after the human cleans the checkout the re-call must re-gate + merge, not
//        replay the refusal. Doubles as the UNSTAMPED-FALLBACK case: op 2's freshMint.priorIdentity is the OLD
//        pre-forward identity (workerSha), proving `identityFromValue` returned undefined and verdictIdentity stood.
{
  const sfx = `sq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcvc-sq-${sfx}`);
  const { db, mgrId, workerId, repo, workerSha } = await setupWorkerProject(sfx, reposDir);
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; if (gateCalls === 1) fs.writeFileSync(path.join(repo, "feature.txt"), "live overlap appeared DURING the gate\n"); return { passed: true, steps: [] }; },
  });
  fs.writeFileSync(path.join(repo, "main-advance.txt"), "advanced\n");
  commitAll(repo, "main advanced", GIT_ID);
  // The gate stub itself dirties the canonical checkout at a path the branch also touches WHILE the gate runs, so the
  // refusal lands in the squash phase AFTER a passing gate (an admission-time refusal would never reach the gate).
  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(gate-pass-squash-refused) op 1 settled, NOT merged (squash refused after a PASSING gate) — fixture sanity", r1.settled === true && r1.ok && r1.value.merged === false && gateCalls === 1);
  check("(gate-pass-squash-refused) op 1 carries NO gatedIdentity (only a gate-FAILED rejection is stamped)", r1.ok && r1.value.gatedIdentity === undefined);
  fs.rmSync(path.join(repo, "feature.txt"));
  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(gate-pass-squash-refused) after the human cleans the checkout the re-call does NOT replay the refusal — it re-gates", gateCalls === 2 && r2.cacheHit === undefined);
  check("(gate-pass-squash-refused) UNSTAMPED FALLBACK: the old pre-forward identity was cached (priorIdentity === workerSha)", r2.freshMint?.priorIdentity === workerSha);
}

// ── (g) TIP MOVES DURING THE GATE, THEN IS RESET BACK TO WHERE IT STARTED (card 8b1fb28f re-review: the ABA shape).
//        Two variants, deliberately separated because they need DIFFERENT machinery:
//        (g1) reset AFTER op 1 settles, before the re-call: settle-time tip (F) != captured tip (T), so
//             `confirmGatedIdentity` drops the stamp (the verdict describes a tree the gate saw moving); the old pre-forward
//             identity stands, T != it, so the re-call re-gates. This is the case that goes RED when
//             `confirmGatedIdentity` is mutated to `return v` (without the drop the stamp T matches the reset tip → cache hit).
//        (g2) reset INSIDE the gate stub, before it fails: settle-time tip == captured tip, so NOTHING observable at settle
//             distinguishes it from a gate that never saw movement — the stamp survives and the re-call is a cache hit.
//             Pinned as the known LIMIT of a tip-compare (not an endorsement).
{
  for (const variant of ["g1-reset-after-settle", "g2-reset-inside-gate"]) {
    const sfx = `aba-${variant}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-mcvc-aba-${sfx}`);
    const { db, mgrId, workerId, repo, worktreePath } = await setupWorkerProject(sfx, reposDir);
    let gateCalls = 0;
    let capturedTip;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000,
      runGate: async () => {
        gateCalls++;
        if (gateCalls === 1) {
          capturedTip = headSha(worktreePath); // == the tip captured just before this spawn
          fs.writeFileSync(path.join(worktreePath, "fix.txt"), "fix\n"); commitAll(worktreePath, "fix mid-gate", GIT_ID);
          if (variant === "g2-reset-inside-gate") execSync(`git reset --hard ${capturedTip}`, { cwd: worktreePath });
        }
        return { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
      },
    });
    fs.writeFileSync(path.join(repo, "main-advance.txt"), "advanced\n");
    commitAll(repo, "main advanced", GIT_ID);
    const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
    check(`(${variant}) op 1 settled + rejected`, r1.settled === true && r1.ok && r1.value.merged === false && gateCalls === 1);
    if (variant === "g1-reset-after-settle") execSync(`git reset --hard ${capturedTip}`, { cwd: worktreePath });
    check(`(${variant} setup) the branch tip is back at the tip the gate started on`, headSha(worktreePath) === capturedTip);
    const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
    if (variant === "g1-reset-after-settle") {
      check("(g1) the re-call RE-GATES: the stamp was dropped because the tip had moved at settle (RED if confirmGatedIdentity is mutated to return v)", gateCalls === 2 && r2.cacheHit === undefined);
    } else {
      check("(g2) PIN (known limit): a move-and-reset entirely inside the gate is invisible to a settle-time tip compare — cache hit at the captured tip", gateCalls === 1 && r2.cacheHit?.identity === capturedTip);
    }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMergeTracked verdict cache: a gate that passes but whose squash refuses (f), and a tip moved during the gate then reset (g1/g2, the ABA shape), behave as pinned. Other scenarios are in merge-confirm-verdict-cache.mjs and merge-confirm-verdict-cache-retry-links.mjs."
  : `\n❌ ${failures} FAILURE(S).`);

// Card 82bb198a: this file previously had NO exit-code decision at all — Node's default exit(0)
// applied regardless of `failures`, so the gate's exit-code-only verdict (test-daemon.mjs `runOne`)
// reported PASS even with printed FAIL lines above. registerForCleanup (imported above) already
// installs _tmp-fixture.mjs's `exit`-event sync backstop, so a plain process.exit here still gets
// guaranteed cleanup — matching the corpus's own dominant idiom rather than inventing a second one.
process.exit(failures === 0 ? 0 : 1);
