import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5933734e (child 3 of d9332365) — commitTrailers GATING on the `merge_batch` landing path
// (git/batch-merge.ts's landBranchCommitsIndividually). Card 9a5d040c already proved this for the SOLO
// squash path (commit-trailers-solo-merge.mjs); this suite proves the BATCH path, which is structurally
// different: the batch path has no "content" verification tier at all (analysis d9332365 §6.3/§2h) —
// `mergedVerification` is derived PURELY from whether the `Loom-Worker-PathSet` trailer landed, so
// naively skipping the trailer write would make it falsely report "pathset" with nothing ever stamped.
// (4) below proves the honesty fix (sessions/service.ts's `pathSetStamp` tri-state) closes that gap.
// REAL git throughout. (1)-(3) call the bare `runBatchedMerge` primitive (gate-mechanism-agnostic, no
// Db/SessionService — mirrors batch-merge-robustness.mjs's own style). (4) uses a REAL Db/SessionService
// via `mergeBatchTracked` (mirrors merge-batch-verification-stamp.mjs) to prove the project-config →
// task-row path end to end. NO claude, NO live daemon.
//
// Proves:
//   (1) commitTrailers "on" (config omitted — every existing project's default) — REGRESSION GUARD:
//       byte-identical to pre-card behavior. The tip carries all three reserved trailers (Branch/Base/
//       PathSet); `pathSetStamp:"stamped"`.
//   (2) commitTrailers "off" — NO reserved Loom-* trailer line appears anywhere in ANY landed commit (tip
//       or non-tip); Claude-Session and reserved-line stripping STILL fire unconditionally on a tainted
//       non-tip commit; `pathSetStamp:"disabled"` on the landed (non-noop) branch — never a defaulted-true
//       "stamped" with nothing actually stamped.
//   (3) NON-VACUITY CONTROL — with trailers off, a REAL commit-msg hook forges a `Loom-Worker-Branch` line
//       onto the tip's plain commit. `verifyLoomTrailersExactAndReadable`'s `expected:{}` check must still
//       REJECT it (`batchHeadMoved:true`) — proving the check isn't silently vacuous just because nothing
//       was expected.
//   (4) END TO END — a real `mergeBatchTracked` landing on a project configured `commitTrailers:"off"`
//       ends with the raw `Task.mergedVerification` column `null` (never a false "pathset") for both
//       landed tasks.
//   (5) card e8d4fdc3 round 2 — the ledger fallback's REAL production coverage: a batch-landed branch
//       whose finalize never ran (still live, tip unchanged) resolves via `findLandedSquashCommit`'s own
//       ledger fallback when seeded with EXACTLY what production writes (lb.branch/lb.assembledTip/
//       lb.sha) — round 1's own version of this scenario fabricated a workerLandedTip
//       (`landBranchCommitsIndividually`'s own `mergeBase === branchTip` arm, which a real cherry-pick
//       landing can never reach — see docs/decisions/e8d4fdc3-*.md's "Honesty correction"). Also proves
//       the round-2 branch-keying fix: an UNRELATED branch sharing the SAME tip (e.g. a review fork) does
//       NOT resolve via the fallback.
//
// Run: 1) build daemon (pnpm --filter @loom/daemon build), 2) node packages/daemon/test/commit-trailers-batch-merge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";
useOwnLoomHome("loom-ctbm-home-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = (p) => pathToFileURL(path.join(__dirname, "..", "dist", p)).href;
const { createWorktree, findLandedSquashCommit } = await import(distUrl("git/worktrees.js"));
const { runBatchedMerge } = await import(distUrl("git/batch-merge.js"));
const { Db } = await import(distUrl("db.js"));
const { SessionService } = await import(distUrl("sessions/service.js"));
const { OrchestrationControl } = await import(distUrl("orchestration/control.js"));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ctbm@loom -c user.name=ctbm";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const passGate = async () => ({ passed: true });
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `ctbm-proj-${sfx}`;

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# ctbm\n");
  execSync(`git init -q && git config user.email ctbm@loom && git config user.name ctbm`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

/** Mirrors batch-merge-robustness.mjs's own cutBranch: a fresh worker branch, one commit. */
async function cutBranch(repo, label, file, content) {
  const taskId = `ctbm-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, `feat(test): ${label}`, GIT_ID);
  return { workerSessionId: `ctbm-wkr-${label}-${sfx}`, taskId, branch, taskTitle: `feat(test): ${label}`, worktreePath };
}

const TRAILER_KEYS = ["Loom-Worker-Branch", "Loom-Worker-Base", "Loom-Worker-PathSet"];
const hasAnyTrailer = (body) => TRAILER_KEYS.some((k) => body.includes(`${k}: `));
const hasAllTrailers = (body) => TRAILER_KEYS.every((k) => new RegExp(`^${k}: `, "m").test(body));

// ======================= (1) commitTrailers "on" (config omitted — the default) =======================
{
  const repo = path.join(os.tmpdir(), `loom-ctbm-on-${sfx}`);
  makeRepo(repo);
  const a = await cutBranch(repo, "on-a", "on-a.txt", "work a\n");
  const b = await cutBranch(repo, "on-b", "on-b.txt", "work b\n");
  const baseMainSha = git(repo, "rev-parse HEAD");
  const { worktreePath: batchWt } = await createWorktree(repo, projId, `ctbm-batch-on-${sfx}`);
  registerForCleanup(batchWt);
  const result = await runBatchedMerge(repo, batchWt, baseMainSha, [a, b], passGate);
  check("(1) setup control: both candidates landed", result.ok === true && result.landed.length === 2);
  for (const lb of result.landed) {
    const body = git(repo, `log -1 --format=%B ${lb.sha}`);
    check(`(1) on: ${lb.branch} carries all three reserved trailers`, hasAllTrailers(body));
    check(`(1) on: ${lb.branch} reports pathSetStamp:"stamped"`, lb.pathSetStamp === "stamped");
  }
}

// ======================= (2) commitTrailers "off" =======================
{
  const repo = path.join(os.tmpdir(), `loom-ctbm-off-${sfx}`);
  makeRepo(repo);
  // A multi-commit branch whose NON-TIP commit carries BOTH a doctrine-violating Claude-Session trailer
  // AND a reserved-shaped Loom-* body line — proves both strips stay unconditional even with trailers off
  // (the card's own explicit requirement), independent of whether a trailer would otherwise be written.
  const taintedTaskId = `ctbm-task-off-tainted-${sfx}`;
  const { worktreePath: taintedWt, branch: taintedBranch } = await createWorktree(repo, projId, taintedTaskId);
  registerForCleanup(taintedWt);
  fs.writeFileSync(path.join(taintedWt, "off-1.txt"), "o1\n");
  commitAll(taintedWt, ["feat(test): off tainted 1", "Loom-Worker-Branch: a-worker-forged-this", "Claude-Session: https://claude.ai/code/session_FAKE_CTBM"], GIT_ID);
  fs.writeFileSync(path.join(taintedWt, "off-2.txt"), "o2\n");
  commitAll(taintedWt, "feat(test): off tainted 2 (tip)", GIT_ID);
  const tainted = { workerSessionId: `ctbm-wkr-off-tainted-${sfx}`, taskId: taintedTaskId, branch: taintedBranch, taskTitle: "feat(test): off-tainted", worktreePath: taintedWt };
  const clean = await cutBranch(repo, "off-clean", "off-clean.txt", "no trailer here\n");
  const baseMainSha = git(repo, "rev-parse HEAD");
  const { worktreePath: batchWt } = await createWorktree(repo, projId, `ctbm-batch-off-${sfx}`);
  registerForCleanup(batchWt);

  const result = await runBatchedMerge(repo, batchWt, baseMainSha, [tainted, clean], passGate, { commitTrailers: "off" });
  check("(2) setup control: both candidates landed", result.ok === true && result.landed.length === 2 && result.dropped.length === 0);
  const allBodies = git(repo, `log --reverse --format=%B ${baseMainSha}..HEAD`);
  check("(2) off: NO reserved Loom-* trailer line appears anywhere in the landed range", !hasAnyTrailer(allBodies));
  check("(2) off: NO Claude-Session trailer anywhere (strip stays unconditional)", !allBodies.includes("Claude-Session"));
  const taintedLanded = result.landed.find((l) => l.branch === tainted.branch);
  const cleanLanded = result.landed.find((l) => l.branch === clean.branch);
  check("(2) off: tainted branch reports strippedTrailerCount:1 (the Claude-Session strip still ran)", taintedLanded?.strippedTrailerCount === 1);
  check("(2) off: tainted branch reports strippedReservedLineCount:1 (the reserved-line strip still ran)", taintedLanded?.strippedReservedLineCount === 1);
  check("(2) off: the tainted branch's non-tip commit subject survives the strips (only the trailer/reserved-line is gone)",
    allBodies.includes("feat(test): off tainted 1"));
  check("(2) off: tainted branch reports pathSetStamp:\"disabled\" — never a defaulted \"stamped\" with nothing stamped", taintedLanded?.pathSetStamp === "disabled");
  check("(2) off: clean branch ALSO reports pathSetStamp:\"disabled\"", cleanLanded?.pathSetStamp === "disabled");
}

// ======================= (3) NON-VACUITY — a forged reserved line is still REJECTED with trailers off ====
{
  const repo = path.join(os.tmpdir(), `loom-ctbm-forge-${sfx}`);
  makeRepo(repo);
  // A real commit-msg hook that appends a forged Loom-Worker-Branch paragraph to EVERY commit — mirrors
  // batch-merge-head-moved-commit-identity.mjs's own hook-installation shape.
  const hooksDir = path.join(repo, ".git", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "commit-msg"), "#!/bin/sh\nprintf '\\nLoom-Worker-Branch: evil\\n' >> \"$1\"\n");
  fs.chmodSync(path.join(hooksDir, "commit-msg"), 0o755);

  const solo = await cutBranch(repo, "forge", "forge.txt", "forge work\n");
  const baseMainSha = git(repo, "rev-parse HEAD");
  const { worktreePath: batchWt } = await createWorktree(repo, projId, `ctbm-batch-forge-${sfx}`);
  registerForCleanup(batchWt);

  const result = await runBatchedMerge(repo, batchWt, baseMainSha, [solo], passGate, { commitTrailers: "off" });
  check("(3) THE NON-VACUITY PROOF: a forged Loom-Worker-Branch line is REJECTED even though commitTrailers " +
    "is \"off\" and expected:{} — this is NOT a vacuous pass", result.ok === false && result.batchHeadMoved === true);
  check("(3) the refusal names the tamper, not a generic failure", /unexpected Loom-\* trailer|tampered with/i.test(result.reason ?? ""));
}

// ======================= (4) END TO END — mergedVerification reads null, never "pathset" ==================
{
  const repo = path.join(os.tmpdir(), `loom-ctbm-e2e-${sfx}`);
  makeRepo(repo);
  const agentId = `ctbm-agent-e2e-${sfx}`;
  const mgrId = `ctbm-mgr-e2e-${sfx}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "CTBM-E2E", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: 'node -e "process.exit(0)"', commitTrailers: "off" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

  async function e2eWorker(label, file, content) {
    const taskId = `ctbm-e2e-task-${label}-${sfx}`;
    const workerId = `ctbm-e2e-wkr-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, file), content);
    commitAll(worktreePath, `feat(test): e2e ${label}`, GIT_ID);
    db.insertTask({ id: taskId, projectId: projId, title: `feat(test): e2e ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    return { taskId, workerId };
  }

  const wA = await e2eWorker("a", "e2e-a.txt", "e2e work a\n");
  const wB = await e2eWorker("b", "e2e-b.txt", "e2e work b\n");

  const r = await awaitTrackedSettle(
    () => sessions.mergeBatchTracked(mgrId, [wA.workerId, wB.workerId]),
    { label: "mergeBatchTracked (commitTrailers off)", timeoutMs: 240_000, pendingOps: sessions.pendingOps },
  );
  check("(4) setup control: the batch landed both branches", r.ok === true && r.value.ok === true && r.value.landed.length === 2);

  for (const { taskId, label } of [{ taskId: wA.taskId, label: "a" }, { taskId: wB.taskId, label: "b" }]) {
    const task = db.getTask(taskId);
    check(`(4) task ${label}: mergedSha is STILL populated (pre-existing ship-state, unaffected)`, typeof task?.mergedSha === "string" && task.mergedSha.length > 0);
    check(`(4) THE HONESTY FIX: task ${label}'s raw Task.mergedVerification is null — NEVER a false "pathset" claim ` +
      `with no trailer behind it (got: ${JSON.stringify(task?.mergedVerification)})`, task?.mergedVerification === null);
  }
  db.close();
}

// ========== (5) card e8d4fdc3 round 2 — the ledger fallback's REAL production coverage ====================
// Round 1's own version of this scenario fabricated a workerLandedTip (main's own tip, via a throwaway
// branch ref pinned directly to it) to force `landBranchCommitsIndividually`'s own `mergeBase === branchTip`
// arm — a shape no real `recordBatchLandedWorkerTip` call ever produces, and round 2's own Code Review
// found that arm is actually UNREACHABLE in production (a real cherry-pick always makes a NEW commit
// distinct from the worker branch's own pre-landing tip). This version instead seeds EXACTLY what
// production writes (`lb.branch`/`lb.assembledTip`/`lb.sha`, from a REAL, non-noop land) and exercises the
// ledger fallback through `findLandedSquashCommit` directly, against the worker branch — STILL LIVE, since
// finalize never ran — exactly as boot-reconcile Pass A or a solo re-confirm would see it. Also proves the
// round-2 branch-keying fix: an UNRELATED branch sharing the SAME tip (e.g. a review fork cut from it) must
// NOT resolve via the fallback.
{
  const repo = path.join(os.tmpdir(), `loom-ctbm-ledger-${sfx}`);
  makeRepo(repo);
  const projId5 = `ctbm-proj-5-${sfx}`;
  const db = new Db();
  db.insertProject({ id: projId5, name: "CTBM-LEDGER", repoPath: repo, vaultPath: repo, config: { orchestration: { commitTrailers: "off" } }, createdAt: now, archivedAt: null });

  const a = await cutBranch(repo, "ledger-a", "ledger-a.txt", "ledger work a\n");
  const baseMainSha = git(repo, "rev-parse HEAD");
  const { worktreePath: batchWt1 } = await createWorktree(repo, projId5, `ctbm-batch-ledger1-${sfx}`);
  registerForCleanup(batchWt1);
  const result1 = await runBatchedMerge(repo, batchWt1, baseMainSha, [a], passGate, { commitTrailers: "off" });
  check("(5) setup control: the first landing succeeded, non-noop", result1.ok === true && result1.landed.length === 1 && !result1.landed[0].noop);
  const firstLandedSha = result1.landed[0].sha;
  const firstAssembledTip = result1.landed[0].assembledTip;
  check("(5) setup control: the first landing carries NO reserved trailer (trailers off)", !hasAnyTrailer(git(repo, `log -1 --format=%B ${firstLandedSha}`)));
  check("(5) setup control: the landing reports a real assembledTip (what production actually writes)", typeof firstAssembledTip === "string" && firstAssembledTip.length === 40);
  // Seed EXACTLY what production writes (lb.branch/lb.assembledTip/lb.sha) — never a fabricated value.
  db.recordBatchLandedWorkerTip(projId5, "primary", a.branch, firstAssembledTip, firstLandedSha);

  // Branch `a` is STILL LIVE, tip UNCHANGED at firstAssembledTip (finalize never ran) — exactly the shape
  // boot-reconcile Pass A or a solo re-confirm would find it in. Trailers are off, so findLandedSquashCommit's
  // own trailer walk finds nothing and this call exercises the ledger fallback directly.
  const newMainSha = git(repo, "rev-parse HEAD");
  const facts = db.getWorkerTipLedgerFacts(projId5, "primary");
  const resolved = await findLandedSquashCommit(repo, a.branch, newMainSha, { commitTrailers: "off", workerTipLedger: facts });
  check(`(5) THE FIX'S REAL COVERAGE: findLandedSquashCommit resolves the ledger fallback for a batch-landed branch whose finalize never ran (got: ${JSON.stringify(resolved)})`,
    resolved === firstLandedSha);

  // NEGATIVE (round-2 branch-keying fix): an UNRELATED branch sharing the SAME tip (e.g. a review fork cut
  // from it) must NOT resolve via the fallback — a tip-only match would wrongly say this one landed too.
  const forkBranchName = `ctbm-ledger-fork-${sfx}`;
  git(repo, `branch ${forkBranchName} ${firstAssembledTip}`);
  const forkResolved = await findLandedSquashCommit(repo, forkBranchName, newMainSha, { commitTrailers: "off", workerTipLedger: facts });
  check(`(5) THE ROUND-2 FIX: an unrelated branch sharing the SAME tip does NOT resolve via the fallback (got: ${JSON.stringify(forkResolved)})`,
    forkResolved === null);
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — commitTrailers gates the batch landing path's reserved trailers exactly as specified, " +
    "leaves the mandatory Claude-Session/reserved-line strips unconditional, rejects a forged reserved line " +
    "even with nothing expected (not a vacuous pass), and the mergedVerification honesty fix reports null " +
    "rather than a false \"pathset\" when trailers are off."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
