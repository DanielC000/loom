import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0eaaa693 round 3 (Code Review 2026-10-21, Major findings #1 and #2), CORRECTED + EXTENDED in
// round 4 (Code Review 2026-10-21 round 2). BATCH-ADJACENT half (card d10f1f92, second batch split): the
// first batch-half split (cut-base-sha-confirm-in-lock-wiring-batch.mjs's own predecessor, 4 scenarios)
// still ran ~45-60s quiet and spiked well past that under real host contention — this file holds the two
// scenarios that are real, useful coverage but do NOT themselves discriminate the batch in-lock cutBaseSha
// wiring (that proof lives in cut-base-sha-confirm-in-lock-wiring-batch.mjs's own (f)/(g); see
// cut-base-sha-confirm-in-lock-wiring-solo.mjs for the cheaper solo-path siblings (d)/(1)/(3)/(h)):
//
//   (e) ⚠️ this scenario does NOT prove the batch in-lock cutBaseSha wiring, despite an earlier round's
//       own comment claiming it did. Diagnosed directly (a standalone harness reproducing this exact
//       setup, printing the real result): the candidates' cut base (c1) IS a trivial ancestor of the
//       batch WORKTREE's own HEAD at assembly time (assembly cuts the worktree from c1 BEFORE the stubbed
//       gate ever runs, and the mid-gate `git reset --hard`+commit only moves the CANONICAL repo, never
//       the already-cut batch worktree) — so both candidates' own cutBaseSha ancestry check passes
//       CLEANLY inside assembly, and BOTH land into the batch worktree without the cutBaseSha wiring ever
//       refusing anything. What actually catches this scenario is the batch's own, PRE-EXISTING, entirely
//       UNRELATED "forfeit" mechanism (`fastForwardCanonicalMain`'s `currentMainSha !== expectedBaseSha`
//       check, `git/batch-merge.ts` ~line 972, documented at `FastForwardResult.forfeited`, ~line 887 —
//       the same family as solo's own `gateBaseInvalidated`): canonical main advanced DURING the gate, so
//       the fast-forward step refuses, and the WHOLE batch falls back to a per-candidate solo re-gate for
//       EVERY candidate — never a per-candidate drop from the in-lock cutBaseSha check at all. Kept as its
//       own scenario (it's a real, useful proof that the forfeit/fallback path handles real
//       cutBaseSha-carrying candidates correctly, without regressing), but its assertions below are
//       reworded to what it ACTUALLY proves — see cut-base-sha-confirm-in-lock-wiring-batch.mjs's own
//       scenario (g) for the batch in-lock wiring proof this scenario's own round-3 label incorrectly
//       claimed to be.
//   (i) round 5 (Code Review ff5de408, item 3): the batch-assembly `cutBaseUnknown` stamp was untested in
//       BOTH directions — the sibling file's (f)/(g) only ever land candidates with a REAL cutBaseSha, so
//       a regression that stamped it unconditionally would pass unnoticed. A legacy (no cutBaseSha)
//       candidate lands alongside an ordinary one; only the legacy one's merge_done carries the stamp.
//
// Mirrors cut-base-sha-confirm-verdict-cache.mjs's harness (a stubbed `runGate` counting real gate
// invocations). ONE shared `Db` across both scenarios below (each uses its own uniquely-prefixed ids,
// same as cut-base-sha-confirm-and-batch.mjs's own pattern).
//
// Run: 1) build (turbo builds shared first), 2) node test/cut-base-sha-confirm-in-lock-wiring-batch-extra.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-cbsilw-be-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=cbsilw@loom -c user.name=cbsilw";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
// Shared across every scenario below (own-prefixed ids per scenario, no cross-scenario collision).
const db = new Db();

function freshRepo(tag) {
  const reposDir = path.join(os.tmpdir(), `loom-cbsilw-be-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  registerForCleanup(reposDir);
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# cbsilw ${tag}\n`);
  execSync(`git init -q && git config user.email cbsilw@loom && git config user.name cbsilw`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

try {
  // ===================================================================================
  // (e) ⚠️ ROUND 4 CORRECTION: this does NOT exercise the batch in-lock cutBaseSha wiring — see this
  // file's own header for the full diagnosis. It proves the batch's PRE-EXISTING "forfeit" mechanism
  // (fastForwardCanonicalMain, batch-merge.ts ~972) correctly falls every candidate back to a per-branch
  // re-gate when canonical main advances during the gate, and that neither candidate's bookkeeping is
  // wrongly stamped cutBaseUnknown:true along the way (both carry a REAL cutBaseSha). See
  // cut-base-sha-confirm-in-lock-wiring-batch.mjs's own scenario (g) for the actual batch in-lock
  // cutBaseSha wiring proof.
  // ===================================================================================
  {
    const repo = freshRepo("batch");
    const c0 = git(repo, "rev-parse HEAD");
    fs.writeFileSync(path.join(repo, "main-advance.txt"), "main advanced\n");
    commitAll(repo, "main advances to c1", GIT_ID);
    const c1 = git(repo, "rev-parse HEAD");

    const mgrId = "cbsilw-b-mgr", projId = "cbsilw-b-p";
    db.insertProject({ id: projId, name: "CBSILW-B", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate", maxConcurrentWorkers: 20 } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "agent-cbsilw-b-m", projectId: projId, name: "m", startupPrompt: "", position: 0 });
    db.insertAgent({ id: "agent-cbsilw-b-w", projectId: projId, name: "w", startupPrompt: "", position: 1 });
    db.insertSession({ id: mgrId, projectId: projId, agentId: "agent-cbsilw-b-m", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const taskGoodId = "cbsilw-b-t-good", workerGoodId = "cbsilw-b-w-good";
    db.insertTask({ id: taskGoodId, projectId: projId, title: "good", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath: goodWt, branch: goodBranch } = await createWorktree(repo, projId, taskGoodId);
    fs.writeFileSync(path.join(goodWt, "good.txt"), "good work\n");
    commitAll(goodWt, "good work", GIT_ID);
    db.insertSession({ id: workerGoodId, projectId: projId, agentId: "agent-cbsilw-b-w", engineSessionId: null, title: null, cwd: goodWt, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskGoodId, worktreePath: goodWt, branch: goodBranch, cutBaseSha: c1 });

    const taskGood2Id = "cbsilw-b-t-good2", workerGood2Id = "cbsilw-b-w-good2";
    db.insertTask({ id: taskGood2Id, projectId: projId, title: "good2", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });
    const { worktreePath: good2Wt, branch: good2Branch } = await createWorktree(repo, projId, taskGood2Id);
    fs.writeFileSync(path.join(good2Wt, "good2.txt"), "good2 work\n");
    commitAll(good2Wt, "good2 work", GIT_ID);
    db.insertSession({ id: workerGood2Id, projectId: projId, agentId: "agent-cbsilw-b-w", engineSessionId: null, title: null, cwd: good2Wt, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskGood2Id, worktreePath: good2Wt, branch: good2Branch, cutBaseSha: c1 });

    let batchGateCalls = 0;
    const sessionsB = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000,
      runGate: async () => {
        batchGateCalls++;
        execFileSync("git", ["reset", "--hard", c0], { cwd: repo });
        fs.writeFileSync(path.join(repo, "unrelated-batch.txt"), "unrelated work replacing c1's lineage\n");
        commitAll(repo, "mainline reset/rebased mid-batch-gate", GIT_ID);
        return { passed: true, steps: [] };
      },
    });

    // Card 426f9bdb: awaits the real settle rather than taking a possible `{settled:false}` first result
    // as final — mirrors cut-base-sha-confirm-and-batch.mjs scenario (2)'s own fix. Deliberately NOT
    // forced to a tiny `syncAttachBudgetMs` here (see cut-base-sha-confirm-in-lock-wiring-solo.mjs's own
    // comment for why that's unsafe for a fast, NEVER_CACHED outcome under a stubbed runGate).
    const batch = await awaitTrackedSettle(
      () => sessionsB.mergeBatchTracked(mgrId, [workerGoodId, workerGood2Id]),
      { label: "(e) mergeBatchTracked", timeoutMs: 60_000 },
    );
    check("(e) the batch settled", batch.settled === true && batch.ok === true);
    check("(e) the batch gate DID run for real (advisory passed clean for both candidates)", batchGateCalls === 1);
    const landedIds = (batch.value?.landed ?? []).map((l) => l.workerSessionId);
    const fallbackIds = (batch.value?.fallback ?? []).map((f) => f.workerSessionId);
    check("(e) NEITHER candidate landed via assembly (this is the FORFEIT fallback, not an in-lock cutBaseSha drop — see this scenario's own corrected header note)",
      !landedIds.includes(workerGoodId) && !landedIds.includes(workerGood2Id));
    check("(e) both were routed to the per-branch fallback (batch not aborted; forfeited, never a per-candidate drop)",
      fallbackIds.includes(workerGoodId) && fallbackIds.includes(workerGood2Id));
    check("(e) the fallback reason names canonical main advancing since the batch was cut (the FORFEIT wording, never a cutBaseSha/fork-point message — note the forfeit message itself legitimately says \"this batch was cut from\", so the negative check is on the fork-point-specific phrasing, not the substring \"cut from\")",
      (batch.value?.fallback ?? []).every((f) => /canonical main advanced/i.test(f.reason ?? "") && !/fork point|worker's branch was cut from/i.test(f.reason ?? "")));
    // Neither candidate has a null/unknown cutBaseSha (both were stamped c1) — so neither should EVER
    // carry cutBaseUnknown:true on its own merge_done/merge_rejected bookkeeping.
    const anyCutBaseUnknown = db.listEventsForWorker(workerGoodId).some((e) => e.detail?.cutBaseUnknown === true)
      || db.listEventsForWorker(workerGood2Id).some((e) => e.detail?.cutBaseUnknown === true);
    check("(e) neither candidate's events carry cutBaseUnknown:true (both had a REAL recorded cutBaseSha)", !anyCutBaseUnknown);
  }

  // ===================================================================================
  // (i) round 5 (Code Review ff5de408, item 3): the batch-assembly `cutBaseUnknown` stamp
  // (service.ts ~21686, `finishAlreadyMerged`'s own call inside the batch landing loop) was untested in
  // BOTH directions — cut-base-sha-confirm-in-lock-wiring-batch.mjs's own (f)/(g) only ever land
  // candidates with a REAL cutBaseSha, so a regression that stamped `cutBaseUnknown:true` unconditionally
  // on every landed candidate (not just a legacy null one) would have passed every existing test in this
  // file unnoticed. A LEGACY candidate (no recorded cutBaseSha — constructed directly, never through
  // spawnWorker, mirroring cut-base-sha-confirm-and-batch.mjs scenario 3's own pattern) lands alongside an
  // ORDINARY one through the real batch assembly path; only the legacy candidate's own merge_done must
  // carry the stamp.
  // ===================================================================================
  {
    const repo = freshRepo("legacybatch");
    const c0 = git(repo, "rev-parse HEAD");

    const mgrId = "cbsilw-lb-mgr", projId = "cbsilw-lb-p";
    db.insertProject({ id: projId, name: "CBSILW-LB", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate", maxConcurrentWorkers: 20 } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "agent-cbsilw-lb-m", projectId: projId, name: "m", startupPrompt: "", position: 0 });
    db.insertAgent({ id: "agent-cbsilw-lb-w", projectId: projId, name: "w", startupPrompt: "", position: 1 });
    db.insertSession({ id: mgrId, projectId: projId, agentId: "agent-cbsilw-lb-m", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    // "good" — a REAL recorded cutBaseSha (c0).
    const taskGoodId = "cbsilw-lb-t-good", workerGoodId = "cbsilw-lb-w-good";
    db.insertTask({ id: taskGoodId, projectId: projId, title: "good", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath: goodWt, branch: goodBranch } = await createWorktree(repo, projId, taskGoodId);
    fs.writeFileSync(path.join(goodWt, "good.txt"), "good work\n");
    commitAll(goodWt, "good work", GIT_ID);
    db.insertSession({ id: workerGoodId, projectId: projId, agentId: "agent-cbsilw-lb-w", engineSessionId: null, title: null, cwd: goodWt, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskGoodId, worktreePath: goodWt, branch: goodBranch, cutBaseSha: c0 });

    // "legacy" — NO cutBaseSha at all (predates card 0eaaa693), same as
    // cut-base-sha-confirm-and-batch.mjs scenario 3's direct construction.
    const taskLegacyId = "cbsilw-lb-t-legacy", workerLegacyId = "cbsilw-lb-w-legacy";
    db.insertTask({ id: taskLegacyId, projectId: projId, title: "legacy", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });
    const { worktreePath: legacyWt, branch: legacyBranch } = await createWorktree(repo, projId, taskLegacyId);
    fs.writeFileSync(path.join(legacyWt, "legacy.txt"), "legacy work\n");
    commitAll(legacyWt, "legacy work", GIT_ID);
    db.insertSession({ id: workerLegacyId, projectId: projId, agentId: "agent-cbsilw-lb-w", engineSessionId: null, title: null, cwd: legacyWt, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskLegacyId, worktreePath: legacyWt, branch: legacyBranch });
    check("(i setup) the legacy candidate's own session row carries no cutBaseSha", db.getSession(workerLegacyId)?.cutBaseSha == null);

    let gateCalls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
    });

    // Card 426f9bdb: awaits the real settle (see scenario (e)'s own comment above for why no forced budget).
    const batch = await awaitTrackedSettle(
      () => sessions.mergeBatchTracked(mgrId, [workerGoodId, workerLegacyId]),
      { label: "(i) mergeBatchTracked", timeoutMs: 60_000 },
    );
    check("(i) the batch gate DID run for real", gateCalls === 1);
    check("(i) the batch settled", batch.settled === true && batch.ok === true);
    const landedIdsI = (batch.value?.landed ?? []).map((l) => l.workerSessionId);
    check("(i) BOTH candidates landed via assembly", landedIdsI.includes(workerGoodId) && landedIdsI.includes(workerLegacyId));
    check("(i) the LEGACY candidate's merge_done DOES carry cutBaseUnknown:true (the grandfathering signal)",
      db.listEventsForWorker(workerLegacyId).some((e) => e.kind === "merge_done" && e.detail?.cutBaseUnknown === true));
    check("(i) the GOOD candidate's merge_done carries NO cutBaseUnknown (it had a real recorded cut base — proves the stamp is per-candidate, not unconditional)",
      !db.listEventsForWorker(workerGoodId).some((e) => e.kind === "merge_done" && e.detail?.cutBaseUnknown === true));
  }
} finally {
  // best-effort; registerForCleanup already covers the repos/LOOM_HOME above
  try { db.close(); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — (e) is corrected to prove the batch's pre-existing FORFEIT fallback, not the cutBaseSha wiring (that proof lives in cut-base-sha-confirm-in-lock-wiring-batch.mjs's own (g)); and (i) proves the batch-assembly cutBaseUnknown stamp fires ONLY for a legacy candidate, never an ordinary one landing alongside it. See cut-base-sha-confirm-in-lock-wiring-solo.mjs for the solo-path siblings (d)/(1)/(3)/(h)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
