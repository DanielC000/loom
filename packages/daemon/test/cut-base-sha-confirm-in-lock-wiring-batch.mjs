import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0eaaa693 round 3 (Code Review 2026-10-21, Major findings #1 and #2), CORRECTED + EXTENDED in
// round 4 (Code Review 2026-10-21 round 2) — closes real gaps the round-2 tests could not see because the
// ADVISORY pre-gate check always decided the outcome first. BATCH-WIRING third (card d10f1f92): split out
// of cut-base-sha-confirm-in-lock-wiring.mjs to bring the combined file back under its per-file gate
// budget, then split again (the first batch split alone still ran ~45-60s quiet and spiked well past that
// under real host contention) — this file keeps only the two scenarios that actually discriminate the
// batch in-lock cutBaseSha wiring itself; see cut-base-sha-confirm-in-lock-wiring-solo.mjs for the
// solo-path siblings (d)/(1)/(3)/(h), and cut-base-sha-confirm-in-lock-wiring-batch-extra.mjs for the two
// batch-adjacent scenarios ((e) the pre-existing forfeit fallback, (i) the cutBaseUnknown stamp) that are
// real coverage but do NOT themselves discriminate this wiring.
//
//   (f) BATCH PROBE FAILURE (closes round-3 gaps iii+v, found by round-4 verification: no test exercised
//       either site at all) — a transient git failure recurring on EVERY matching `merge-base` call for
//       one candidate's cutBaseSha (a value that IS a genuine ancestor; nothing really diverged) must make
//       the advisory pre-filter fall through (gap v — the candidate is never pulled to stranded fallback
//       on an inconclusive read) AND make the in-lock check (`landBranchCommitsIndividually`, fed by the
//       SAME `batchFfGitFactory` seam) refuse it as `forkPointUnverified` (gap iii — never
//       `forkPointDiverged`, with the honest "could not verify, re-confirm" wording). A second, ordinary
//       candidate (a DIFFERENT, unfaulted cutBaseSha) lands normally alongside it, proving the fault is
//       scoped to the one candidate and the batch isn't aborted.
//   (g) BATCH IN-LOCK WIRING, confirmed divergence (closes round-3 gap x — a prior scenario, now in
//       cut-base-sha-confirm-in-lock-wiring-batch-extra.mjs as (e), was wrongly credited with proving
//       this): mirrors scenario (d)'s solo mechanism (cut-base-sha-confirm-in-lock-wiring-solo.mjs),
//       transplanted to batch. A REAL, PRE-EXISTING cross-lineage divergence (canonical never moves again
//       after the stray candidate is cut — the batch's own FORFEIT check (e) exercises can never fire
//       here), with the stray candidate's ADVISORY probe faulted to fail exactly ONCE so it falls through
//       past the pre-filter and reaches assembly; the in-lock check's own (second, unfaulted) probe then
//       correctly determines the real divergence and drops it as `forkPointDiverged`, while an ordinary
//       candidate lands normally. THIS is the scenario that would go RED if `cutBaseSha: c.cutBaseSha`
//       were dropped from `batchCandidates` (mergeBatchTracked, service.ts ~21366) — without it,
//       `landBranchCommitsIndividually`'s own `if (cutBaseSha !== undefined)` guard skips the ancestry
//       check entirely and the stray candidate's commits cherry-pick onto the batch worktree with no
//       file-level conflict, landing cleanly instead of being caught. Verified with a real RED/GREEN
//       negative control against this exact source line (card d10f1f92's own DoD).
//
// Mirrors cut-base-sha-confirm-verdict-cache.mjs's harness (a stubbed `runGate` counting real gate
// invocations) plus `batchFfGitFactory` fault injection, the SAME seam this round's source fix also
// threads the advisory probes through (service.ts). ONE shared `Db` across both scenarios below (each
// uses its own uniquely-prefixed ids, same as cut-base-sha-confirm-and-batch.mjs's own pattern).
//
// Run: 1) build (turbo builds shared first), 2) node test/cut-base-sha-confirm-in-lock-wiring-batch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-cbsilw-b-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const simpleGit = (await import("simple-git")).default;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=cbsilw@loom -c user.name=cbsilw";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
// Shared across every scenario below (own-prefixed ids per scenario, no cross-scenario collision).
const db = new Db();

function freshRepo(tag) {
  const reposDir = path.join(os.tmpdir(), `loom-cbsilw-b-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
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
  // (f) BATCH PROBE FAILURE (round 4, closes gaps iii+v): a transient git failure recurs on EVERY
  // matching merge-base call for the "probe" candidate's cutBaseSha (c0 — a GENUINE ancestor; nothing
  // really diverged). The advisory pre-filter must fall through on its own probe failure (gap v — never
  // pulling "probe" to stranded fallback on an inconclusive read), so the gate runs with "probe" still a
  // live candidate; the in-lock check (fed by the SAME batchFfGitFactory seam, reading the batch
  // worktree fresh) must then refuse it as forkPointUnverified (gap iii — never forkPointDiverged,
  // nothing landed for it). "good" carries a DIFFERENT, unfaulted cutBaseSha and lands normally alongside
  // it, proving the fault is scoped to one candidate and the batch itself is not aborted.
  // ===================================================================================
  {
    const repo = freshRepo("probebatch");
    const c0 = git(repo, "rev-parse HEAD");
    // Main advances to c1 BEFORE "good" is cut, so "good"'s own cutBaseSha (c1) is a DIFFERENT value from
    // "probe"'s (c0) — the fault injector below matches on the exact cutBaseSha value, so a collision
    // would wrongly fault BOTH candidates' own ancestry checks instead of just "probe"'s.
    fs.writeFileSync(path.join(repo, "main-advance.txt"), "main advanced\n");
    commitAll(repo, "main advances to c1", GIT_ID);
    const c1 = git(repo, "rev-parse HEAD");

    const mgrId = "cbsilw-pb-mgr", projId = "cbsilw-pb-p";
    db.insertProject({ id: projId, name: "CBSILW-PB", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate", maxConcurrentWorkers: 20 } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "agent-cbsilw-pb-m", projectId: projId, name: "m", startupPrompt: "", position: 0 });
    db.insertAgent({ id: "agent-cbsilw-pb-w", projectId: projId, name: "w", startupPrompt: "", position: 1 });
    db.insertSession({ id: mgrId, projectId: projId, agentId: "agent-cbsilw-pb-m", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const taskProbeId = "cbsilw-pb-t-probe", workerProbeId = "cbsilw-pb-w-probe";
    db.insertTask({ id: taskProbeId, projectId: projId, title: "probe", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath: probeWt, branch: probeBranch } = await createWorktree(repo, projId, taskProbeId);
    fs.writeFileSync(path.join(probeWt, "probe.txt"), "probe work\n");
    commitAll(probeWt, "probe work", GIT_ID);
    db.insertSession({ id: workerProbeId, projectId: projId, agentId: "agent-cbsilw-pb-w", engineSessionId: null, title: null, cwd: probeWt, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskProbeId, worktreePath: probeWt, branch: probeBranch, cutBaseSha: c0 });

    const taskGoodId = "cbsilw-pb-t-good", workerGoodId = "cbsilw-pb-w-good";
    db.insertTask({ id: taskGoodId, projectId: projId, title: "good", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });
    const { worktreePath: goodWt, branch: goodBranch } = await createWorktree(repo, projId, taskGoodId);
    fs.writeFileSync(path.join(goodWt, "good.txt"), "good work\n");
    commitAll(goodWt, "good work", GIT_ID);
    db.insertSession({ id: workerGoodId, projectId: projId, agentId: "agent-cbsilw-pb-w", engineSessionId: null, title: null, cwd: goodWt, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskGoodId, worktreePath: goodWt, branch: goodBranch, cutBaseSha: c1 });

    // Fails EVERY matching merge-base call for the probe worker's cutBaseSha (c0) — both the advisory's
    // own probe (reading the canonical repo) and the in-lock check's own probe (reading the batch
    // worktree, under the lock). c0 is a genuine ancestor of c1 (the batch's own cut point); the throw is
    // the ONLY reason either check can't confirm it.
    let probeMatchCount = 0;
    const batchFfGitFactory = (p) => {
      const g = simpleGit(p);
      return { raw: async (args) => {
        if (args[0] === "merge-base" && args[1] === c0) {
          probeMatchCount++;
          throw new Error("simulated transient git timeout (batch probe, recurring)");
        }
        return g.raw(args);
      } };
    };

    let gateCalls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, batchFfGitFactory, runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
    });

    const batch = await sessions.mergeBatchTracked(mgrId, [workerProbeId, workerGoodId]);
    // 2 real gate runs, not 1: ONE for the batch's own assembled-tree gate (covering "good"'s landing —
    // proves gap v, the advisory fell through instead of pulling "probe" to stranded fallback), and a
    // SECOND for the solo re-gate `runFallback` dispatches for the in-lock-dropped "probe" candidate
    // (its real cutBaseSha genuinely IS an ancestor, so that unfaulted solo retry lands it independently
    // — a legitimate, separate consequence this scenario doesn't need to suppress or assert further on).
    check("(f) exactly 2 real gate runs occurred (the batch's own assembled-tree gate, plus the solo re-gate runFallback dispatches for the in-lock-dropped probe candidate)", gateCalls === 2);
    check("(f) at least 2 real merge-base calls were faulted (the advisory's own probe + the in-lock's own probe, both on the SAME cutBaseSha)", probeMatchCount >= 2);
    check("(f) the batch settled", batch.settled === true && batch.ok === true);
    const landedIdsF = (batch.value?.landed ?? []).map((l) => l.workerSessionId);
    check("(f) the GOOD candidate landed via assembly", landedIdsF.includes(workerGoodId));
    check("(f) the PROBE candidate did NOT land via assembly (closes gap iii: the in-lock check refused it rather than silently landing on an unverified probe)", !landedIdsF.includes(workerProbeId));
    // Round 5 (Code Review ff5de408, item 3): "good" carried a REAL cutBaseSha (c1) — its own merge_done
    // must NEVER be stamped cutBaseUnknown:true, only a genuinely null/legacy cutBaseSha earns that flag.
    check("(f) the GOOD candidate's merge_done carries NO cutBaseUnknown (it had a real recorded cut base)",
      !db.listEventsForWorker(workerGoodId).some((e) => e.kind === "merge_done" && e.detail?.cutBaseUnknown === true));
    const probeFallback = (batch.value?.fallback ?? []).find((f) => f.workerSessionId === workerProbeId);
    check("(f) the probe candidate's drop reason is the honest \"could not verify\"/\"re-confirm\" wording, never the recycling-can't-clear-it remedy (proves classified forkPointUnverified, never forkPointDiverged)",
      /could not verify/i.test(probeFallback?.reason ?? "") && !/cannot be cleared by recycling/i.test(probeFallback?.reason ?? ""));
  }

  // ===================================================================================
  // (g) BATCH IN-LOCK WIRING, confirmed divergence (round 4, closes gap x — scenario (e), now in
  // cut-base-sha-confirm-in-lock-wiring-batch-extra.mjs, was WRONGLY credited with proving this; see its
  // own corrected header note there). Mirrors the solo sibling file's own scenario (d) mechanism,
  // transplanted to batch: a REAL, PRE-EXISTING cross-lineage divergence where canonical NEVER MOVES AGAIN
  // after the stray candidate is cut (the batch's own FORFEIT check, that (e)'s real subject, can never
  // fire here), with the stray candidate's ADVISORY probe faulted to fail
  // EXACTLY ONCE so it falls through past the pre-filter and reaches assembly; the in-lock check's own
  // (second, unfaulted) probe then correctly determines the real divergence and drops it as
  // forkPointDiverged, while an ordinary candidate lands normally. THIS is the scenario that discriminates
  // `cutBaseSha: c.cutBaseSha` actually reaching `batchCandidates` (service.ts ~21366): without it,
  // landBranchCommitsIndividually's own `if (cutBaseSha !== undefined)` guard skips the ancestry check
  // entirely, and the stray candidate's commits cherry-pick onto the batch worktree with no file-level
  // conflict — landing cleanly instead of being caught (round-4 verification proved this exact collapse
  // with a negative control).
  // ===================================================================================
  {
    const repo = freshRepo("divergebatch");
    const defaultBranch = git(repo, "symbolic-ref --short HEAD");
    const c0 = git(repo, "rev-parse HEAD");

    const mgrId = "cbsilw-db-mgr", projId = "cbsilw-db-p";
    db.insertProject({ id: projId, name: "CBSILW-DB", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate", maxConcurrentWorkers: 20 } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "agent-cbsilw-db-m", projectId: projId, name: "m", startupPrompt: "", position: 0 });
    db.insertAgent({ id: "agent-cbsilw-db-w", projectId: projId, name: "w", startupPrompt: "", position: 1 });
    db.insertSession({ id: mgrId, projectId: projId, agentId: "agent-cbsilw-db-m", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    // "good" cut from c0 while canonical is still on the default branch (ordinary).
    const taskGoodId = "cbsilw-db-t-good", workerGoodId = "cbsilw-db-w-good";
    db.insertTask({ id: taskGoodId, projectId: projId, title: "good", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath: goodWt, branch: goodBranch } = await createWorktree(repo, projId, taskGoodId);
    fs.writeFileSync(path.join(goodWt, "good.txt"), "good work\n");
    commitAll(goodWt, "good work", GIT_ID);
    db.insertSession({ id: workerGoodId, projectId: projId, agentId: "agent-cbsilw-db-w", engineSessionId: null, title: null, cwd: goodWt, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskGoodId, worktreePath: goodWt, branch: goodBranch, cutBaseSha: c0 });

    // Canonical diverts to "atlas" (cut from c0) — "stray" is cut WHILE canonical is on atlas, so its
    // REAL cut base is atlas's own tip (same pattern as cut-base-sha-confirm-and-batch.mjs scenario 2).
    execFileSync("git", ["checkout", "-q", "-b", "atlas", c0], { cwd: repo });
    fs.writeFileSync(path.join(repo, "atlas-only.txt"), "atlas work\n");
    commitAll(repo, "atlas work", GIT_ID);
    const atlasTip = git(repo, "rev-parse HEAD");

    const taskStrayId = "cbsilw-db-t-stray", workerStrayId = "cbsilw-db-w-stray";
    db.insertTask({ id: taskStrayId, projectId: projId, title: "stray", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });
    const { worktreePath: strayWt, branch: strayBranch } = await createWorktree(repo, projId, taskStrayId);
    fs.writeFileSync(path.join(strayWt, "stray.txt"), "stray work\n");
    commitAll(strayWt, "stray work", GIT_ID);
    db.insertSession({ id: workerStrayId, projectId: projId, agentId: "agent-cbsilw-db-w", engineSessionId: null, title: null, cwd: strayWt, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskStrayId, worktreePath: strayWt, branch: strayBranch, cutBaseSha: atlasTip });

    // Canonical returns to the default branch (still at c0; atlas never incorporated) — the FINAL
    // mainline the batch is cut from, and it NEVER MOVES AGAIN (no gate-time canonical move at all, so
    // the FORFEIT check scenario (e) exercises can never fire here).
    execFileSync("git", ["checkout", "-q", defaultBranch], { cwd: repo });
    check("(g setup) canonical is back on the default branch at c0 — atlas's tip is NOT an ancestor",
      git(repo, "rev-parse HEAD") === c0 &&
      (() => { try { execFileSync("git", ["merge-base", "--is-ancestor", atlasTip, c0], { cwd: repo }); return false; } catch { return true; } })());

    // Fails ONLY the FIRST matching merge-base call for stray's cutBaseSha (the ADVISORY's own probe,
    // reading the canonical repo) — the in-lock check's own (second, successful) call then correctly
    // determines the real answer against the (unmoving) batch worktree.
    let matchCount = 0;
    const batchFfGitFactory = (p) => {
      const g = simpleGit(p);
      return { raw: async (args) => {
        if (args[0] === "merge-base" && args[1] === atlasTip) {
          matchCount++;
          if (matchCount === 1) throw new Error("simulated transient git timeout (batch advisory probe only)");
        }
        return g.raw(args);
      } };
    };

    let gateCalls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, batchFfGitFactory, runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
    });

    const batch = await sessions.mergeBatchTracked(mgrId, [workerGoodId, workerStrayId]);
    check("(g) the batch gate DID run for real (the advisory's OWN probe failed and fell through, never pulling stray to stranded fallback on an inconclusive read)", gateCalls === 1);
    check("(g) the batch settled", batch.settled === true && batch.ok === true);
    const landedIdsG = (batch.value?.landed ?? []).map((l) => l.workerSessionId);
    check("(g) the GOOD candidate landed via assembly", landedIdsG.includes(workerGoodId));
    check("(g) the STRAY candidate did NOT land via assembly (closes gap x: the in-lock check — fed by batchCandidates' own cutBaseSha field — actually caught the real divergence)", !landedIdsG.includes(workerStrayId));
    const strayFallback = (batch.value?.fallback ?? []).find((f) => f.workerSessionId === workerStrayId);
    check("(g) the stray candidate's drop reason names the fork-point divergence and the corrected remedy (classified forkPointDiverged, never forkPointUnverified)",
      /not an ancestor|cut from/.test(strayFallback?.reason ?? "") && /cannot be cleared by recycling/i.test(strayFallback?.reason ?? ""));
    check("(g) the stray candidate's own file did NOT land on the default branch", !fs.existsSync(path.join(repo, "stray.txt")));
    check("(g) the good candidate's own file DID land on the default branch", fs.existsSync(path.join(repo, "good.txt")));
    // Round 5 (Code Review ff5de408, item 3) — same NO-stamp check as (f) above, on the other batch
    // wiring path's own "good" landing.
    check("(g) the GOOD candidate's merge_done carries NO cutBaseUnknown (it had a real recorded cut base)",
      !db.listEventsForWorker(workerGoodId).some((e) => e.kind === "merge_done" && e.detail?.cutBaseUnknown === true));
  }
} finally {
  // best-effort; registerForCleanup already covers the repos/LOOM_HOME above
  try { db.close(); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — (g) proves the batch in-lock wiring with a reachable pre-existing-divergence shape; (f) proves a transient probe failure on a batch candidate falls through the advisory and refuses forkPointUnverified in-lock, never forkPointDiverged. See cut-base-sha-confirm-in-lock-wiring-solo.mjs for the solo-path siblings (d)/(1)/(3)/(h), and cut-base-sha-confirm-in-lock-wiring-batch-extra.mjs for the batch-adjacent (e)/(i)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
