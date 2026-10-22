import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0eaaa693 round 3 (Code Review 2026-10-21, Major findings #1 and #2), CORRECTED + EXTENDED in
// round 4 (Code Review 2026-10-21 round 2) — closes real gaps the round-2 tests could not see because the
// ADVISORY pre-gate check always decided the outcome first. SOLO half (card d10f1f92): split out of
// cut-base-sha-confirm-in-lock-wiring.mjs to bring the combined file back under its per-file gate budget
// (that file alone needed ~90-120s; the batch scenarios are the expensive half — see
// cut-base-sha-confirm-in-lock-wiring-batch.mjs for those). This file holds every scenario that proves the
// wiring through the SOLO path (confirmWorkerMergeTracked -> mergeBranch), never mergeBatchTracked:
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
//
// Mirrors cut-base-sha-confirm-verdict-cache.mjs's harness (a stubbed `runGate` counting real gate
// invocations) plus `soloMergeGitFactory` fault injection, the SAME seam this round's source fix threads
// the advisory probes through (service.ts). ONE shared `Db` across all three scenarios below (each uses
// its own uniquely-prefixed ids, same as the batch sibling file already does) — cuts three of this file's
// four `new Db()` calls, the cheapest safe "shared fixture setup" trim available without touching any
// assertion.
//
// Run: 1) build (turbo builds shared first), 2) node test/cut-base-sha-confirm-in-lock-wiring-solo.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-cbsilw-s-home-${Date.now()}-${process.pid}`);
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
  const reposDir = path.join(os.tmpdir(), `loom-cbsilw-s-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
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

    // Card 426f9bdb: awaits the real settle rather than taking a possible `{settled:false}` first result
    // as final — mirrors cut-base-sha-confirm-and-batch.mjs's own fix; see that file's scenario (1) for
    // why this is deliberately NOT forced to a tiny `syncAttachBudgetMs` (a fast, NEVER_CACHED_OUTCOMES
    // refusal can settle faster than a forced-tiny-budget poll round-trip, causing a mint storm instead
    // of a clean pending-then-settled sequence).
    const r = await awaitTrackedSettle(
      () => sessions.confirmWorkerMergeTracked(mgrId, workerId),
      { label: "(d) confirmWorkerMergeTracked", timeoutMs: 60_000, pendingOps: sessions.pendingOps },
    );
    check("(d) the gate DID run for real (the advisory's OWN probe failed and fell through, never refusing on an inconclusive read)", gateCalls === 1);
    check("(d) op settled, NOT merged", r.settled === true && r.ok && r.value.merged === false);
    check("(d) classified forkPointDiverged BY THE IN-LOCK CHECK (proves mergeBranch actually received worker.cutBaseSha — if it had received undefined, this would land cleanly instead)",
      r.ok && r.value.forkPointDiverged === true && !r.value.gateBaseInvalidated);
    const mergeRejectedEvents = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_rejected");
    check("(d) the merge_rejected event carries NO phase:\"advisory-pre-gate\" (it was caught in-lock, not by the advisory)",
      mergeRejectedEvents.some((e) => e.detail?.reason === "fork_point_diverged" && e.detail?.phase !== "advisory-pre-gate"));
  }

  // ===================================================================================
  // (1)+(3) PROBE FAILURE at the IN-LOCK check: classified forkPointUnverified (never forkPointDiverged),
  // and the entry is load-bearing — a clean re-call (nothing moved) genuinely re-attempts and merges.
  // ===================================================================================
  {
    const repo = freshRepo("probe");
    const c1 = git(repo, "rev-parse HEAD");
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
    // fallthrough is NOT what's exercised here (that is scenario (d) above's own territory); this
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

    // Card 426f9bdb: awaits the real settle (see scenario (d)'s own comment above for why no forced budget).
    const r1 = await awaitTrackedSettle(
      () => sessions.confirmWorkerMergeTracked(mgrId, workerId),
      { label: "(1 in-lock) confirmWorkerMergeTracked r1", timeoutMs: 60_000, pendingOps: sessions.pendingOps },
    );
    check("(1 in-lock) the gate ran (the ADVISORY's own merge-base call succeeded cleanly)", gateCalls === 1);
    check("(1 in-lock) exactly one simulated merge-base failure occurred (the IN-LOCK call)", mbFails === 1);
    check("(1 in-lock) r1 refused, classified forkPointUnverified (NEVER forkPointDiverged) by a transient in-lock probe failure",
      r1.settled === true && r1.ok && r1.value.merged === false && r1.value.forkPointUnverified === true && !r1.value.forkPointDiverged);
    check("(1 in-lock) the refusal says \"could not verify\"/\"re-confirm\", never the recycling-can't-clear-it remedy",
      /could not verify/i.test(r1.value.reason ?? "") && !/cannot be cleared by recycling/i.test(r1.value.reason ?? ""));
    check("(1 in-lock) canonical repo untouched by the refused squash", git(repo, "rev-parse HEAD") === c1);

    const r2 = await awaitTrackedSettle(
      () => sessions.confirmWorkerMergeTracked(mgrId, workerId),
      { label: "(3) confirmWorkerMergeTracked r2", timeoutMs: 60_000, pendingOps: sessions.pendingOps },
    );
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

    // Card 426f9bdb: awaits the real settle (see scenario (d)'s own comment above for why no forced budget).
    const r = await awaitTrackedSettle(
      () => sessions.confirmWorkerMergeTracked(mgrId, workerId),
      { label: "(h) confirmWorkerMergeTracked", timeoutMs: 60_000, pendingOps: sessions.pendingOps },
    );
    check("(h) the gate ran (the ADVISORY's own rev-parse HEAD call succeeded cleanly)", gateCalls === 1);
    check("(h) exactly one simulated rev-parse HEAD failure occurred (the IN-LOCK call)", rpFails === 1);
    check("(h) refused, classified forkPointUnverified (NEVER forkPointDiverged) — the in-lock check's OWN target-tip read failed, not checkCutBaseAncestry's merge-base call",
      r.settled === true && r.ok && r.value.merged === false && r.value.forkPointUnverified === true && !r.value.forkPointDiverged);
    check("(h) the refusal says \"could not verify\"/\"re-confirm\", never the generic \"squash was attempted... Re-task a rebase\" fallthrough wording",
      /could not verify/i.test(r.value.reason ?? "") && !/Re-task a rebase/i.test(r.value.reason ?? "") && !/squash was attempted/i.test(r.value.reason ?? ""));
    check("(h) canonical repo untouched by the refused squash", git(repo, "rev-parse HEAD") === c1);
  }
} finally {
  // best-effort; registerForCleanup already covers the repos/LOOM_HOME above
  try { db.close(); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the in-lock cut-base-ancestry check (not the advisory) is what actually catches a real cross-lineage divergence for solo (d), proving the authoritative mergeBranch wiring is real; (1)+(3) prove the probeFailed/forkPointDiverged split for solo plus that forkPointUnverified is load-bearing in NEVER_CACHED_OUTCOMES; and (h) proves the in-lock check's own target-tip rev-parse HEAD failure is likewise classified forkPointUnverified with the honest wording, never the generic squash-was-attempted fallthrough. See cut-base-sha-confirm-in-lock-wiring-batch.mjs for the batch-path siblings (e)/(f)/(g)/(i)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
