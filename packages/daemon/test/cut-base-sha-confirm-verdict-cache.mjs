import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0eaaa693 round 2 — exercises confirmWorkerMergeTracked's verdict-cache behavior for a
// forkPointDiverged refusal, mirroring merge-confirm-verdict-cache-quarantine.mjs's harness.
//
// ⚠️ HONEST SCOPE NOTE, found via an actual negative-control probe (revert ONLY the
// `NEVER_CACHED_OUTCOMES` entry for "fork-point-diverged", orchestration/pending-ops.ts; keep everything
// else): the probe did NOT go red, including against THIS file. That is not a flaw in this test — it is
// because this check's cache identity (`verdictIdentity = branch tip + main tip`) ALREADY fully captures
// forkPointDiverged's own truth condition: `cutBaseSha` is fixed per worker and the "current mainline
// target" it is checked against IS the exact same main-tip value baked into the identity. Unlike
// "quarantined"/"branch-diverted" (whose truth depends on a THIRD state axis — the quarantine latch, or
// which branch is checked out — genuinely independent of the identity), there is today no reachable state
// where the identity matches but this check's real answer differs, so the identity-gated
// `retainVerdictUntilSuperseded` cache (see confirmWorkerMergeTracked's own `verdictIdentity` doc) already
// busts correctly on its own whenever the real condition changes. The `NEVER_CACHED_OUTCOMES` entry is
// kept anyway, as harmless, pattern-consistent defense-in-depth for a possible FUTURE cutBaseSha re-stamp
// path (flagged, not yet built, by the round-2 Lead decision) that could change the answer without moving
// main — at which point this entry would become load-bearing and provable the same way "quarantined" is.
//
// What THIS file actually proves instead:
//   (1) a cross-lineage cutBaseSha refuses BEFORE any gate lane (gateCalls stays 0 — the advisory check).
//   (2) a re-call while the canonical checkout is STILL diverted is refused again, still no gate lane
//       (sanity: the REAL condition, not a cache, is still the blocker here).
//   (3) once the canonical checkout is switched back (the real condition is fixed, which ALSO changes the
//       cache identity's own main-tip component), a re-call does not replay a stale refusal — it genuinely
//       re-attempts (gate runs for real, cacheHit is absent) and actually merges.
//
// Run: 1) build (turbo builds shared first), 2) node test/cut-base-sha-confirm-verdict-cache.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-cbscvc-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=cbscvc@loom -c user.name=cbscvc";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

const reposDir = path.join(os.tmpdir(), `loom-cbscvc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
registerForCleanup(reposDir);
const repo = path.join(reposDir, "repo");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# cbscvc\n");
execSync(`git init -q && git config user.email cbscvc@loom && git config user.name cbscvc`, { cwd: repo });
commitAll(repo, "init", GIT_ID);
const defaultBranch = git(repo, "symbolic-ref --short HEAD");
const c0 = git(repo, "rev-parse HEAD");

// Main advances to c1 BEFORE the worker is cut — c1 is the worker's recorded cut base.
fs.writeFileSync(path.join(repo, "main-advance.txt"), "main advanced\n");
commitAll(repo, "main advances to c1", GIT_ID);
const c1 = git(repo, "rev-parse HEAD");

const db = new Db();
const mgrId = "cbscvc-mgr", projId = "cbscvc-p", taskId = "cbscvc-t", workerId = "cbscvc-w";
db.insertProject({ id: projId, name: "CBSCVC", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agent-cbscvc-m", projectId: projId, name: "m", startupPrompt: "", position: 0 });
db.insertAgent({ id: "agent-cbscvc-w", projectId: projId, name: "w", startupPrompt: "", position: 1 });
db.insertSession({ id: mgrId, projectId: projId, agentId: "agent-cbscvc-m", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
db.insertTask({ id: taskId, projectId: projId, title: "CBSCVC-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });

const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
fs.writeFileSync(path.join(worktreePath, "feature.txt"), "real work\n");
commitAll(worktreePath, "feature.txt", GIT_ID);
// The worker's recorded cutBaseSha is c1 (stamped directly — the derivation itself is covered by
// cut-base-sha-spawn.mjs; this file is about the CACHE identity, not the stamping).
db.insertSession({ id: workerId, projectId: projId, agentId: "agent-cbscvc-w", engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, cutBaseSha: c1 });

// Canonical checkout diverts to an UNRELATED branch "atlas", cut from c0 — BEFORE c1 ever existed, so c1
// is NOT an ancestor of atlas.
execFileSync("git", ["checkout", "-q", "-b", "atlas", c0], { cwd: repo });
fs.writeFileSync(path.join(repo, "atlas-only.txt"), "atlas work\n");
commitAll(repo, "atlas work", GIT_ID);
check("(setup) c1 is NOT an ancestor of atlas (the cross-lineage precondition)",
  (() => { try { execFileSync("git", ["merge-base", "--is-ancestor", c1, git(repo, "rev-parse HEAD")], { cwd: repo }); return false; } catch { return true; } })());

let gateCalls = 0;
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
  syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
});

try {
  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(1) op 1 settled, NOT merged, refused BEFORE any gate lane (the advisory pre-gate check)", r1.settled === true && r1.ok && r1.value.merged === false && gateCalls === 0);
  check("(1) op 1's result carries forkPointDiverged:true", r1.ok && r1.value.forkPointDiverged === true);
  // DIRECT classifyOutcome proof (not inferred from cache behavior): the retained peek, within
  // MERGE_OP_RETAIN_MS, exposes the classified outcome string verbatim.
  check("(1) the retained peek classifies this op as \"fork-point-diverged\" (never the generic \"rejected\")", sessions.peekPendingMerge(workerId)?.outcome === "fork-point-diverged");

  // (2) sanity: while canonical is STILL diverted, a re-call is refused again, still no gate lane — the
  // REAL condition is still the blocker here, not yet proof either way about the cache.
  const rStillDiverted = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(2) a re-call while STILL diverted is refused again, still no gate lane", rStillDiverted.settled === true && rStillDiverted.ok && rStillDiverted.value.merged === false && rStillDiverted.value.forkPointDiverged === true && gateCalls === 0);

  // Fix the REAL condition: canonical checkout returns to the default branch, where c1 genuinely is an
  // ancestor (main never incorporated atlas's commit).
  execFileSync("git", ["checkout", "-q", defaultBranch], { cwd: repo });
  check("(setup) canonical is back where c1 IS an ancestor", git(repo, "rev-parse HEAD") === c1);

  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(3) card 0eaaa693: after the real condition is fixed, the re-call does NOT replay the stale forkPointDiverged refusal — it genuinely re-attempts (gate runs for real)", gateCalls === 1 && r2.cacheHit === undefined);
  check("(3) op 2 actually merges (the worktree had real, mergeable work all along — only the divergence ever stood in the way)", r2.settled === true && r2.ok && r2.value.merged === true);
  check("(3) the feature file actually landed on the default branch", fs.existsSync(path.join(repo, "feature.txt")));
} finally {
  try { const { removeWorktree } = await import("../dist/git/worktrees.js"); await removeWorktree(repo, worktreePath); } catch { /* best-effort */ }
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a cross-lineage cutBaseSha refuses before any gate lane (the advisory pre-gate check), a re-call while still diverted refuses again with no gate lane, and once the real condition is fixed a re-call genuinely re-attempts (gate runs, no cacheHit) rather than replaying a stale refusal. See this file's own header for the honest scope note on NEVER_CACHED_OUTCOMES's own (currently unreachable) negative control."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
