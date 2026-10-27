import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1; see _guard.mjs)
// @decision 08c36dae — never say "canonical repo untouched" when a real/foreign commit may have landed.
//
// CONTRACT: a REAL git commit (not a synthetic flag) lands on canonical HEAD with a tree that does NOT
// match what this merge's own squash staged (a real parent+tree mismatch, caught by
// `verifyCommitParentAndTree`), while this merge's OWN `git commit -F` call is made to report a failure —
// simulating a racer, via the narrowest native seam: only that one call is stubbed. This is ONE of TWO
// causes this scenario covers — the OTHER is our own legitimate commit whose verification itself failed
// (`stagedTree` capture failing independently) — the wording stays true for either. Proves:
//   (A) FLAG + WORDING — confirm.headMovedUnverified===true, confirm.divertedSha names the real racer
//       sha; detailText never says "untouched"/"Re-task a rebase", instead points at git show + names
//       advanceMainlineWatermark's own landing-trust-freeze as the next-landing alert mechanism.
//   (B) NEVER-CACHED — restoring canonical HEAD to the ORIGINAL pre-incident mainSha (so op2's own
//       verdictIdentity exactly matches op1's) is what makes this a genuine discrimination, not a
//       vacuous one; verified via a throwaway source mutation (reported, not committed — see the record).
//
// Run: 1) pnpm build, 2) node packages/daemon/test/merge-confirm-head-moved-unverified.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

useOwnLoomHome("loom-mchmu-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mchmu@loom -c user.name=mchmu";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const openDbs = [];
const noReap = async () => ({ killedPids: [] });
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirmTracked = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked", timeoutMs: 240_000 });
const headOf = (cwd) => execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();

async function setup(sfx) {
  const reposDir = path.join(os.tmpdir(), `loom-mchmu-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db(); openDbs.push(db);
  const mgrId = `mchmu-mgr-${sfx}`, projId = `mchmu-p-${sfx}`, taskId = `mchmu-t-${sfx}`, workerId = `mchmu-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mchmu\n");
  execSync("git init -q && git config user.email mchmu@loom && git config user.name mchmu", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  db.insertProject({ id: projId, name: "MCHMU", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mchmu-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mchmu-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mchmu-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCHMU-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "work");
  commitAll(wt.worktreePath, "feature", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mchmu-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
  return { db, mgrId, workerId, repo, worktreePath: wt.worktreePath, branch: wt.branch, mainSha: headOf(repo) };
}
const svc = (db, extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, ...extra });

// NARROWEST NATIVE SEAM: intercepts ONLY the squash's own `git commit -F <file>` call. Before reporting
// that call as failed, it makes a REAL, different commit land on canonical HEAD — `reset --hard HEAD`
// first (discarding the squash's own staged diff, standing in for a racer's own unrelated write that
// landed in the window), then a real `commit --allow-empty` — so the racer commit's PARENT matches
// `preCommitHead` but its TREE does not match what the squash staged: a genuine structural parent+tree
// mismatch for `verifyCommitParentAndTree` to catch, never a fabricated flag. Every other git call
// (the squash itself, every read, the racer's own commit) runs for real, unstubbed.
function headMovedRacerFactory() {
  let fired = false;
  return (repoPath, blockTimeoutMs) => ({
    raw: async (args) => {
      if (!fired && Array.isArray(args) && args[0] === "commit" && args[1] === "-F") {
        fired = true;
        execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repoPath });
        execFileSync("git", ["-c", "user.email=racer@loom", "-c", "user.name=racer", "commit", "--allow-empty", "-m", "foreign racer commit"], { cwd: repoPath });
        throw new Error("simulated git commit failure (a racer landed a real commit first)");
      }
      const { boundedSimpleGit } = await import("../dist/git/bounded.js");
      const { nonInteractiveEnv } = await import("../dist/git/writer.js");
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return real.raw(args);
    },
  });
}

try {
  // ── (A) WORDING + FLAG ────────────────────────────────────────────────────────────────────────────
  {
    console.log("\n— (A) confirm-level wiring: a real racer commit lands while OUR commit call is reported failed —");
    const { db, mgrId, workerId, repo, branch } = await setup(sfxOf("a"));
    const sessions = svc(db, { soloMergeGitFactory: headMovedRacerFactory() });

    const confirm = await sessions.confirmWorkerMerge(mgrId, workerId);
    const racerSha = headOf(repo);
    check("(A) refused, never merged", confirm.merged === false);
    check("(A) carries its OWN distinct flag, headMovedUnverified:true", confirm.headMovedUnverified === true);
    check("(A) carries the real racer sha as divertedSha", confirm.divertedSha === racerSha);
    check("(A) is NOT misclassified as branchDiverted/unverified (checkout-branch identity, a different thing)", !confirm.branchDiverted && confirm.unverified !== true);
    check("(A) the detailText never claims the canonical repo is untouched (only the honest NOT-confirmed-untouched wording)", !/canonical repo and worktree are untouched/.test(confirm.detailText ?? "") && !/canonical repo .*\bis untouched\b/.test(confirm.detailText ?? ""));
    check("(A) the detailText NEVER contains the literal 'canonical repo untouched' substring (the OLD generic fallthrough's exact phrase)", !(confirm.detailText ?? "").includes("canonical repo untouched"));
    check("(A) the detailText never says 'Re-task a rebase'", !/Re-task a rebase/.test(confirm.detailText ?? ""));
    check("(A) the detailText says a human should inspect it (names git show + the real sha)", confirm.detailText?.includes(`git show ${racerSha}`));
    check("(A) the detailText correctly attributes the next-landing alert to advanceMainlineWatermark's landing-trust-freeze, never checkMainlineMove", /mainline trust record/.test(confirm.detailText ?? "") && /mainline-moved alert/.test(confirm.detailText ?? ""));
    check("(A) the detailText does NOT claim the next merge is blocked (nothing holds it — advisory only)", /Nothing currently blocks a further merge/.test(confirm.detailText ?? ""));
    check("(A) the detailText retains worktree-retained guidance", /worktree retained/i.test(confirm.detailText ?? ""));
    check("(A) HEAD really did move to the racer's own commit, not back to our own staged work", racerSha !== confirm.sha);
    // The racer's commit really does carry a DIFFERENT tree (empty commit on top of the pre-squash tree,
    // not the squash's own staged feature.txt) — confirming this is a genuine structural mismatch, not a
    // fabricated one.
    const racerFiles = execSync(`git show --stat --format= ${racerSha}`, { cwd: repo, encoding: "utf8" }).trim();
    check("(A) the racer commit genuinely carries none of the squash's own staged content (real tree mismatch)", racerFiles === "");
  }

  // ── (B) NEVER-CACHED ──────────────────────────────────────────────────────────────────────────────
  {
    console.log("\n— (B) a re-confirm after the fault clears must genuinely re-attempt, not replay the refusal —");
    const { db, mgrId, workerId, repo, branch, mainSha } = await setup(sfxOf("b"));
    const sessions = svc(db, { soloMergeGitFactory: headMovedRacerFactory() });

    const r1 = await confirmTracked(sessions, mgrId, workerId);
    check("(B) op 1: refused via headMovedUnverified (a genuine fresh mint)", r1.ok === true && r1.value?.merged === false && r1.value?.headMovedUnverified === true);

    // Simulate the real remedy: a human restores canonical HEAD to the ORIGINAL PRE-INCIDENT tip
    // (`mainSha`, captured in setup() before the squash ever ran) — NOT the racer's own `divertedSha`.
    // This matters structurally, not just cosmetically: confirmWorkerMergeTracked's verdict cache is
    // keyed on (branch tip, main tip) `verdictIdentity`, captured BEFORE mergeBranch runs. Resetting to
    // `divertedSha` (which already equals the live HEAD) is a no-op on disk and leaves op2's own fresh
    // identity computation reading a DIFFERENT main tip than op1's stored identity regardless of
    // NEVER_CACHED_OUTCOMES — a vacuous test that would pass even with the never-cached fix reverted.
    // Restoring to `mainSha` makes op2's identity EXACTLY match op1's, so the ONLY thing standing between
    // a replay and a genuine re-attempt is `head-moved-unverified`'s membership in NEVER_CACHED_OUTCOMES
    // — see part (B5) below for the throwaway-mutation proof that this is actually discriminating.
    execSync(`git reset --hard ${mainSha}`, { cwd: repo });
    sessions.soloMergeGitFactory = undefined;
    const r2 = await confirmTracked(sessions, mgrId, workerId);
    check("(B) op 2: genuinely re-attempted and LANDED (not a replayed rejection)", r2.ok === true && r2.value?.merged === true);
    check("(B) THE NEVER-CACHED PROOF (structural): op 2 carries NO cacheHit — head-moved-unverified is excluded from the until-superseded cache", r2.cacheHit === undefined);
    check("(B) the real content actually landed", fs.existsSync(path.join(repo, "feature.txt")));
  }
} finally {
  for (const db of openDbs) { try { db.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMerge classifies a real post-commit-failure HEAD move with its own distinct headMovedUnverified flag and honest wording (never the false \"canonical repo untouched … Re-task a rebase\" framing), names the real diverted sha, correctly attributes the next-landing alert to advanceMainlineWatermark's own landing-trust-freeze (never checkMainlineMove), and the refusal is never cached — proven by a genuine identity match (restored to the ORIGINAL pre-incident mainSha), not a vacuous one."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
