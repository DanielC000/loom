import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0eaaa693 round 3 (Code Review 2026-10-21, Major findings #1 and #2), CORRECTED + EXTENDED in
// round 4 (Code Review 2026-10-21 round 2) — closes real gaps the round-2 tests could not see because the
// ADVISORY pre-gate check always decided the outcome first:
//
//   (d) SOLO AUTHORITATIVE WIRING: passing `worker.cutBaseSha` into `mergeBranch` (service.ts
//       confirmWorkerMerge) was UNTESTED in isolation — every round-2 scenario had the advisory already
//       refuse (or correctly pass) BEFORE the in-lock check's own wiring ever mattered. A real run showed
//       the obvious "move canonical HEAD inside the stubbed gate" shape is structurally UNREACHABLE for
//       solo: `requireCanonicalHead`'s own gateBaseInvalidated check (worktrees.ts, decision eda70da6)
//       fires FIRST on ANY canonical-HEAD movement during the gate and wins before the cutBaseSha check
//       is ever reached. Proves the wiring via a reachable path instead: a REAL, PRE-EXISTING cross-
//       lineage divergence where the ADVISORY's own probe (not the real world) fails once and falls
//       through, so the gate runs on a tree never actually cleared, and the in-lock check (fed by an
//       UNCHANGING canonical HEAD throughout — gateBaseInvalidated never fires) is what catches it.
//       Asserts `gateCalls===1` and that the merge_rejected event carries no `phase:"advisory-pre-gate"`.
//   (e) ⚠️ ROUND 4 CORRECTION — this scenario does NOT prove the batch in-lock cutBaseSha wiring, despite
//       round 3's own comment here claiming it did. Diagnosed directly (a standalone harness reproducing
//       this exact setup, printing the real result): the candidates' cut base (c1) IS a trivial ancestor
//       of the batch WORKTREE's own HEAD at assembly time (assembly cuts the worktree from c1 BEFORE the
//       stubbed gate ever runs, and the mid-gate `git reset --hard`+commit only moves the CANONICAL repo,
//       never the already-cut batch worktree) — so both candidates' own cutBaseSha ancestry check passes
//       CLEANLY inside assembly, and BOTH land into the batch worktree without the cutBaseSha wiring ever
//       refusing anything. What actually catches this scenario is the batch's own, PRE-EXISTING, entirely
//       UNRELATED "forfeit" mechanism (`fastForwardCanonicalMain`'s `currentMainSha !== expectedBaseSha`
//       check, `git/batch-merge.ts` ~line 972, documented at `FastForwardResult.forfeited`, ~line 887 —
//       the same family as solo's own `gateBaseInvalidated`): canonical main advanced DURING the gate, so
//       the fast-forward step refuses, and the WHOLE batch falls back to a per-candidate solo re-gate for
//       EVERY candidate — never a per-candidate drop from the in-lock cutBaseSha check at all. Kept as its
//       own scenario (it's a real, useful proof that the forfeit/fallback path handles real
//       cutBaseSha-carrying candidates correctly, without regressing), but its assertions below are
//       reworded to what it ACTUALLY proves — see scenario (g) for the batch in-lock wiring proof this
//       scenario's own round-3 label incorrectly claimed to be.
//   (f) BATCH PROBE FAILURE (closes round-3 gaps iii+v, found by round-4 verification: no test exercised
//       either site at all) — a transient git failure recurring on EVERY matching `merge-base` call for
//       one candidate's cutBaseSha (a value that IS a genuine ancestor; nothing really diverged) must make
//       the advisory pre-filter fall through (gap v — the candidate is never pulled to stranded fallback
//       on an inconclusive read) AND make the in-lock check (`landBranchCommitsIndividually`, fed by the
//       SAME `batchFfGitFactory` seam) refuse it as `forkPointUnverified` (gap iii — never
//       `forkPointDiverged`, with the honest "could not verify, re-confirm" wording). A second, ordinary
//       candidate (a DIFFERENT, unfaulted cutBaseSha) lands normally alongside it, proving the fault is
//       scoped to the one candidate and the batch isn't aborted.
//   (g) BATCH IN-LOCK WIRING, confirmed divergence (closes round-3 gap x — the wiring (e) was wrongly
//       credited with proving): mirrors scenario (d)'s solo mechanism, transplanted to batch. A REAL,
//       PRE-EXISTING cross-lineage divergence (canonical never moves again after the stray candidate is
//       cut — the batch's own FORFEIT check above can never fire here, unlike (e)), with the stray
//       candidate's ADVISORY probe faulted to fail exactly ONCE so it falls through past the pre-filter
//       and reaches assembly; the in-lock check's own (second, unfaulted) probe then correctly determines
//       the real divergence and drops it as `forkPointDiverged`, while an ordinary candidate lands
//       normally. THIS is the scenario that would go RED if `cutBaseSha: c.cutBaseSha` were dropped from
//       `batchCandidates` (mergeBatchTracked, service.ts ~21366) — without it, `landBranchCommitsIndividually`'s
//       own `if (cutBaseSha !== undefined)` guard skips the ancestry check entirely and the stray
//       candidate's commits cherry-pick onto the batch worktree with no file-level conflict, landing
//       cleanly instead of being caught.
//   (1) PROBE FAILURE vs CONFIRMED DIVERGENCE, solo in-lock side: a `soloMergeGitFactory` fault makes the
//       SECOND matching `merge-base` call (the in-lock check's own — the FIRST is the advisory's, which
//       must succeed cleanly for this scenario, proving the advisory's own probeFailed fallthrough from a
//       DIFFERENT angle than scenario (d)) throw once, simulating a transient git error. Proves the
//       in-lock check classifies this as `forkPointUnverified` (never `forkPointDiverged`), with honest
//       "could not verify, re-confirm" wording, never the recycling/fresh-worker remedy.
//   (3) "fork-point-unverified" IS load-bearing in NEVER_CACHED_OUTCOMES: the SAME transient-failure
//       scenario's SECOND confirm call (nothing in the real world moved — same identity) must genuinely
//       re-attempt and merge, not replay r1's stale refusal from the until-superseded verdict cache.
//       Adapted from the Code Reviewer's own fault-injection shape
//       (0e0d27cb-bf95-4fcd-aed6-34e116aa06c5/probe/transient-cache-probe.mjs), landed here as a real test.
//   (h) round 5 (Code Review ff5de408, item 4): the IN-LOCK check's OWN `rev-parse HEAD` read (the fresh
//       canonical target-tip read right before checkCutBaseAncestry is called) is a DIFFERENT git call
//       from the "merge-base" probe (1 in-lock) above covers — before this round, its catch block
//       returned a plain {ok:false, reason} with no forkPointUnverified flag, falling through to the
//       generic merge-failed branch's "squash was attempted... Re-task a rebase" wording (both false and
//       misdirecting here). Faults ONLY the second matching "rev-parse HEAD" call (the in-lock one; the
//       first is the advisory's own, which must succeed so the gate genuinely runs).
//   (i) round 5 (Code Review ff5de408, item 3): the batch-assembly `cutBaseUnknown` stamp was untested in
//       BOTH directions — (f)/(g) only ever land candidates with a REAL cutBaseSha, so a regression that
//       stamped it unconditionally would pass unnoticed. A legacy (no cutBaseSha) candidate lands
//       alongside an ordinary one; only the legacy one's merge_done carries the stamp.
//
// Mirrors cut-base-sha-confirm-verdict-cache.mjs's harness (a stubbed `runGate` counting real gate
// invocations) plus `soloMergeGitFactory`/`batchFfGitFactory` fault injection, the SAME seams this round's
// source fix now also threads the advisory probes through (service.ts).
//
// Run: 1) build (turbo builds shared first), 2) node test/cut-base-sha-confirm-in-lock-wiring.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-cbsilw-home-${Date.now()}-${process.pid}`);
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

function freshRepo(tag) {
  const reposDir = path.join(os.tmpdir(), `loom-cbsilw-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
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
  // (d) SOLO in-lock wiring: a REAL, PRE-EXISTING cross-lineage divergence, where the ADVISORY's OWN
  // probe (not the real world) fails transiently and falls through — so the gate runs on a tree that was
  // never actually cleared — and the IN-LOCK check (fed by the SAME canonical HEAD throughout, so
  // gateBaseInvalidated never fires — nothing moved mid-gate here) is what actually catches the real
  // divergence and refuses. (NOTE: an earlier version of this scenario tried moving canonical HEAD INSIDE
  // the stubbed gate instead, as the round-3 kickoff described — that is structurally UNREACHABLE for the
  // solo path: `requireCanonicalHead`'s own gateBaseInvalidated check [worktrees.ts, decision eda70da6]
  // runs BEFORE the cutBaseSha check and refuses FIRST on ANY canonical-HEAD movement during the gate,
  // confirmed by a real run — see this file's own commit message for the repro. This scenario proves the
  // SAME wiring fact — mergeBranch receives worker.cutBaseSha, not undefined — via a reachable path.)
  // ===================================================================================
  {
    const repo = freshRepo("solo");
    const base = git(repo, "rev-list --max-parents=0 HEAD"); // the repo's own root commit
    fs.writeFileSync(path.join(repo, "main-advance.txt"), "main advanced\n");
    commitAll(repo, "main advances to c1", GIT_ID);
    const c1 = git(repo, "rev-parse HEAD");

    const db = new Db();
    const mgrId = "cbsilw-mgr", projId = "cbsilw-p", taskId = "cbsilw-t", workerId = "cbsilw-w";
    db.insertProject({ id: projId, name: "CBSILW", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "agent-cbsilw-m", projectId: projId, name: "m", startupPrompt: "", position: 0 });
    db.insertAgent({ id: "agent-cbsilw-w", projectId: projId, name: "w", startupPrompt: "", position: 1 });
    db.insertSession({ id: mgrId, projectId: projId, agentId: "agent-cbsilw-m", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertTask({ id: taskId, projectId: projId, title: "CBSILW-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "real work\n");
    commitAll(worktreePath, "feature.txt", GIT_ID);
    db.insertSession({ id: workerId, projectId: projId, agentId: "agent-cbsilw-w", engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, cutBaseSha: c1 });

    // Canonical checkout diverts to an UNRELATED "atlas" branch, cut from `base` — BEFORE c1 ever
    // existed — and STAYS there for the rest of this scenario (nothing moves again, so
    // gateBaseInvalidated's own check never fires: requireCanonicalHead is captured against this SAME,
    // unchanging tip).
    execFileSync("git", ["checkout", "-q", "-b", "atlas", base], { cwd: repo });
    fs.writeFileSync(path.join(repo, "atlas-only.txt"), "atlas work\n");
    commitAll(repo, "atlas work", GIT_ID);
    check("(d setup) c1 is NOT an ancestor of atlas (the real, pre-existing cross-lineage precondition)",
      (() => { try { execFileSync("git", ["merge-base", "--is-ancestor", c1, git(repo, "rev-parse HEAD")], { cwd: repo }); return false; } catch { return true; } })());

    // Fails ONLY the FIRST matching merge-base call (the advisory's own) — simulating the advisory's OWN
    // probe failing transiently despite the real divergence genuinely being present. The in-lock's own
    // (second, successful) call then correctly determines the real answer.
    let matchCount = 0;
    const soloMergeGitFactory = (p) => {
      const g = simpleGit(p);
      return { raw: async (args) => {
        if (args[0] === "merge-base" && args[1] === c1) {
          matchCount++;
          if (matchCount === 1) throw new Error("simulated transient git timeout (advisory probe only)");
        }
        return g.raw(args);
      } };
    };
    let gateCalls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, soloMergeGitFactory, runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
    });

    const r = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
    check("(d) the gate DID run for real (the advisory's OWN probe failed and fell through, never refusing on an inconclusive read)", gateCalls === 1);
    check("(d) op settled, NOT merged", r.settled === true && r.ok && r.value.merged === false);
    check("(d) classified forkPointDiverged BY THE IN-LOCK CHECK (proves mergeBranch actually received worker.cutBaseSha — if it had received undefined, this would land cleanly instead)",
      r.ok && r.value.forkPointDiverged === true && !r.value.gateBaseInvalidated);
    const mergeRejectedEvents = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_rejected");
    check("(d) the merge_rejected event carries NO phase:\"advisory-pre-gate\" (it was caught in-lock, not by the advisory)",
      mergeRejectedEvents.some((e) => e.detail?.reason === "fork_point_diverged" && e.detail?.phase !== "advisory-pre-gate"));
  }

  // ===================================================================================
  // (e) ⚠️ ROUND 4 CORRECTION: this does NOT exercise the batch in-lock cutBaseSha wiring — see this
  // file's own header for the full diagnosis. It proves the batch's PRE-EXISTING "forfeit" mechanism
  // (fastForwardCanonicalMain, batch-merge.ts ~972) correctly falls every candidate back to a per-branch
  // re-gate when canonical main advances during the gate, and that neither candidate's bookkeeping is
  // wrongly stamped cutBaseUnknown:true along the way (both carry a REAL cutBaseSha). See scenario (g)
  // below for the actual batch in-lock cutBaseSha wiring proof.
  // ===================================================================================
  {
    const repo = freshRepo("batch");
    const defaultBranch = git(repo, "symbolic-ref --short HEAD");
    const c0 = git(repo, "rev-parse HEAD");
    fs.writeFileSync(path.join(repo, "main-advance.txt"), "main advanced\n");
    commitAll(repo, "main advances to c1", GIT_ID);
    const c1 = git(repo, "rev-parse HEAD");

    const db = new Db();
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

    const batch = await sessionsB.mergeBatchTracked(mgrId, [workerGoodId, workerGood2Id]);
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

    const db = new Db();
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
  // (g) BATCH IN-LOCK WIRING, confirmed divergence (round 4, closes gap x — the wiring (e) was WRONGLY
  // credited with proving; see (e)'s own corrected header note). Mirrors scenario (d)'s solo mechanism,
  // transplanted to batch: a REAL, PRE-EXISTING cross-lineage divergence where canonical NEVER MOVES
  // AGAIN after the stray candidate is cut (the batch's own FORFEIT check, scenario (e)'s real subject,
  // can never fire here), with the stray candidate's ADVISORY probe faulted to fail EXACTLY ONCE so it
  // falls through past the pre-filter and reaches assembly; the in-lock check's own (second, unfaulted)
  // probe then correctly determines the real divergence and drops it as forkPointDiverged, while an
  // ordinary candidate lands normally. THIS is the scenario that discriminates `cutBaseSha: c.cutBaseSha`
  // actually reaching `batchCandidates` (service.ts ~21366): without it, landBranchCommitsIndividually's
  // own `if (cutBaseSha !== undefined)` guard skips the ancestry check entirely, and the stray
  // candidate's commits cherry-pick onto the batch worktree with no file-level conflict — landing cleanly
  // instead of being caught (round-4 verification proved this exact collapse with a negative control).
  // ===================================================================================
  {
    const repo = freshRepo("divergebatch");
    const defaultBranch = git(repo, "symbolic-ref --short HEAD");
    const c0 = git(repo, "rev-parse HEAD");

    const db = new Db();
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

  // ===================================================================================
  // (1)+(3) PROBE FAILURE at the IN-LOCK check: classified forkPointUnverified (never forkPointDiverged),
  // and the entry is load-bearing — a clean re-call (nothing moved) genuinely re-attempts and merges.
  // ===================================================================================
  {
    const repo = freshRepo("probe");
    const c1 = git(repo, "rev-parse HEAD");
    const db = new Db();
    const mgrId = "cbsilw-p-mgr", projId = "cbsilw-p-p", taskId = "cbsilw-p-t", workerId = "cbsilw-p-w";
    db.insertProject({ id: projId, name: "CBSILW-P", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "agent-cbsilw-p-m", projectId: projId, name: "m", startupPrompt: "", position: 0 });
    db.insertAgent({ id: "agent-cbsilw-p-w", projectId: projId, name: "w", startupPrompt: "", position: 1 });
    db.insertSession({ id: mgrId, projectId: projId, agentId: "agent-cbsilw-p-m", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertTask({ id: taskId, projectId: projId, title: "fix(daemon): probe", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "real work\n");
    commitAll(worktreePath, "feature.txt", GIT_ID);
    db.insertSession({ id: workerId, projectId: projId, agentId: "agent-cbsilw-p-w", engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, cutBaseSha: c1 });

    // Fails ONLY the SECOND matching merge-base call (the in-lock check's own, read fresh under the lock)
    // — the FIRST (the advisory's) must succeed cleanly, proving the advisory's own probeFailed
    // fallthrough is NOT what's exercised here (that is scenario (d)/(e) above's own territory); this
    // isolates the IN-LOCK check's probeFailed handling specifically.
    let matchCount = 0, mbFails = 0;
    const soloMergeGitFactory = (p) => {
      const g = simpleGit(p);
      return { raw: async (args) => {
        if (args[0] === "merge-base" && args[1] === c1) {
          matchCount++;
          if (matchCount === 2) { mbFails++; throw new Error("simulated transient git timeout"); }
        }
        return g.raw(args);
      } };
    };
    let gateCalls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, soloMergeGitFactory, runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
    });

    const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
    check("(1 in-lock) the gate ran (the ADVISORY's own merge-base call succeeded cleanly)", gateCalls === 1);
    check("(1 in-lock) exactly one simulated merge-base failure occurred (the IN-LOCK call)", mbFails === 1);
    check("(1 in-lock) r1 refused, classified forkPointUnverified (NEVER forkPointDiverged) by a transient in-lock probe failure",
      r1.settled === true && r1.ok && r1.value.merged === false && r1.value.forkPointUnverified === true && !r1.value.forkPointDiverged);
    check("(1 in-lock) the refusal says \"could not verify\"/\"re-confirm\", never the recycling-can't-clear-it remedy",
      /could not verify/i.test(r1.value.reason ?? "") && !/cannot be cleared by recycling/i.test(r1.value.reason ?? ""));
    check("(1 in-lock) canonical repo untouched by the refused squash", git(repo, "rev-parse HEAD") === c1);

    const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
    check("(3) r2 (transient cleared, nothing else moved — SAME identity as r1) genuinely re-attempts and merges, NOT a cached replay of r1's stale refusal",
      r2.settled === true && r2.ok && r2.value.merged === true && r2.cacheHit === undefined);
    check("(3) exactly 2 real gate runs total (r1 + r2) — r2 was a genuine re-attempt, not served from cache", gateCalls === 2);
  }

  // ===================================================================================
  // (h) round 5: the IN-LOCK check's OWN `rev-parse HEAD` read (the fresh canonical target tip read
  // immediately before checkCutBaseAncestry is called, mergeBranchLocked ~8626) — a DIFFERENT git call
  // from checkCutBaseAncestry's own "merge-base" probe scenario (1 in-lock) above already covers. Before
  // round 5 this catch returned a plain {ok:false, reason} with no forkPointUnverified flag, so it fell
  // through to the generic merge-failed branch's "squash was attempted... Re-task a rebase" wording —
  // both false (nothing was ever squashed) and misdirecting (a rebase of this branch touches nothing
  // here). Faults ONLY the SECOND matching "rev-parse HEAD" call: the FIRST is the advisory's own
  // (soloMergeGitFactory-fed) read for advisoryTip, which must succeed cleanly so the gate genuinely runs;
  // the in-lock check's own (second) read is what throws, under the lock, with nothing else moved.
  // ===================================================================================
  {
    const repo = freshRepo("revparseprobe");
    const c1 = git(repo, "rev-parse HEAD");
    const db = new Db();
    const mgrId = "cbsilw-rp-mgr", projId = "cbsilw-rp-p", taskId = "cbsilw-rp-t", workerId = "cbsilw-rp-w";
    db.insertProject({ id: projId, name: "CBSILW-RP", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "agent-cbsilw-rp-m", projectId: projId, name: "m", startupPrompt: "", position: 0 });
    db.insertAgent({ id: "agent-cbsilw-rp-w", projectId: projId, name: "w", startupPrompt: "", position: 1 });
    db.insertSession({ id: mgrId, projectId: projId, agentId: "agent-cbsilw-rp-m", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertTask({ id: taskId, projectId: projId, title: "fix(daemon): revparseprobe", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "real work\n");
    commitAll(worktreePath, "feature.txt", GIT_ID);
    db.insertSession({ id: workerId, projectId: projId, agentId: "agent-cbsilw-rp-w", engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, cutBaseSha: c1 });

    let rpMatchCount = 0, rpFails = 0;
    const soloMergeGitFactory = (p) => {
      const g = simpleGit(p);
      return { raw: async (args) => {
        // args.length===2 excludes `readHeadShaAndBranch`'s combined "rev-parse HEAD --symbolic-full-name
        // HEAD" (4 args, the expectedMainlineBranch pre-check). Faults the THIRD plain 2-arg match, not
        // the second: #1 is the advisory's own read; #2 is `requireCanonicalHead`'s own gate-base
        // rev-parse (it fires here because this harness's fake runGate never threads a real
        // gateBaseBranchHead through, so `branchStableSinceGateBase` reads false) — discovered by a real
        // run going RED on THAT check's own wording ("failed to verify canonical HEAD before honoring
        // this merge's gate...") instead of the cut-base check's. #3 is the cut-base check's own read.
        if (args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD") {
          rpMatchCount++;
          if (rpMatchCount === 3) { rpFails++; throw new Error("simulated transient git timeout (in-lock rev-parse HEAD)"); }
        }
        return g.raw(args);
      } };
    };
    let gateCalls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, soloMergeGitFactory, runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
    });

    const r = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
    check("(h) the gate ran (the ADVISORY's own rev-parse HEAD call succeeded cleanly)", gateCalls === 1);
    check("(h) exactly one simulated rev-parse HEAD failure occurred (the IN-LOCK call)", rpFails === 1);
    check("(h) refused, classified forkPointUnverified (NEVER forkPointDiverged) — the in-lock check's OWN target-tip read failed, not checkCutBaseAncestry's merge-base call",
      r.settled === true && r.ok && r.value.merged === false && r.value.forkPointUnverified === true && !r.value.forkPointDiverged);
    check("(h) the refusal says \"could not verify\"/\"re-confirm\", never the generic \"squash was attempted... Re-task a rebase\" fallthrough wording",
      /could not verify/i.test(r.value.reason ?? "") && !/Re-task a rebase/i.test(r.value.reason ?? "") && !/squash was attempted/i.test(r.value.reason ?? ""));
    check("(h) canonical repo untouched by the refused squash", git(repo, "rev-parse HEAD") === c1);
  }

  // ===================================================================================
  // (i) round 5 (Code Review ff5de408, item 3): the batch-assembly `cutBaseUnknown` stamp
  // (service.ts ~21686, `finishAlreadyMerged`'s own call inside the batch landing loop) was untested in
  // BOTH directions — (f)/(g) above only ever land candidates that carry a REAL cutBaseSha, so a
  // regression that stamped `cutBaseUnknown:true` unconditionally on every landed candidate (not just a
  // legacy null one) would have passed every existing test in this file unnoticed. A LEGACY candidate
  // (no recorded cutBaseSha — constructed directly, never through spawnWorker, mirroring
  // cut-base-sha-confirm-and-batch.mjs scenario 3's own pattern) lands alongside an ORDINARY one through
  // the real batch assembly path; only the legacy candidate's own merge_done must carry the stamp.
  // ===================================================================================
  {
    const repo = freshRepo("legacybatch");
    const c0 = git(repo, "rev-parse HEAD");

    const db = new Db();
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

    const batch = await sessions.mergeBatchTracked(mgrId, [workerGoodId, workerLegacyId]);
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
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the in-lock cut-base-ancestry check (not the advisory) is what actually catches a real cross-lineage divergence for solo (d), proving the authoritative mergeBranch wiring is real; (e) is corrected to prove the batch's pre-existing FORFEIT fallback, not the cutBaseSha wiring; (g) now proves the batch in-lock wiring with a reachable pre-existing-divergence shape; (f) proves a transient probe failure on a batch candidate falls through the advisory and refuses forkPointUnverified in-lock, never forkPointDiverged; (1)+(3) prove the same split for solo plus that forkPointUnverified is load-bearing in NEVER_CACHED_OUTCOMES; (h) proves the in-lock check's own target-tip rev-parse HEAD failure is likewise classified forkPointUnverified with the honest wording, never the generic squash-was-attempted fallthrough; and (i) proves the batch-assembly cutBaseUnknown stamp fires ONLY for a legacy candidate, never an ordinary one landing alongside it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
