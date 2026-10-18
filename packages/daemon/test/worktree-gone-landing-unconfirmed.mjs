import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c30952c1 — regression guard for `worktreeGoneLandingUnconfirmed`. Decision record:
// docs/decisions/c30952c1-worktree-gone-landing-unconfirmed.md (full investigation + fix narrative, not
// restated here). REAL git on temp repos, NO claude and NO live daemon — drives
// SessionService.confirmWorkerMergeTracked() directly against an isolated LOOM_HOME, same style as
// merge-confirm-leaked-worktree-idempotent.mjs.
//
// THE BUG (pre-fix): `findLandedSquashCommit` fails safe to `null` on ANY failure, including a timeout
// (its own catch-all) — indistinguishable from "genuinely not landed". With the worker's worktree ALSO
// gone, the pre-gate `if (gate)` block fell through into `mergeMainIntoWorktree(repoPath, worktreePath,
// ...)`, whose first line assumes the worktree exists and threw an UNCAUGHT `GitConstructError` before
// any try/catch — reaching the operator as a bare `{error: "Cannot use simple-git on a directory that
// does not exist"}` with zero orchestration events recorded (not even merge_landing_started).
//
// THE FIX: right before that call, when `preLanded` is null and the worktree is missing, retry the
// lookup once (same bounded timeout), then refuse with a distinct, never-cached reason
// (`worktree_gone_landing_unconfirmed`) instead of letting the crash propagate.
//
// SCENARIOS (mirror the investigation's C/D/E):
//   (C) worktree gone, content landed OUT OF BAND (no Loom-Worker-Branch trailer — undetectable by the
//       lookup, standing in for a timeout-degraded false negative: both produce the identical `null`).
//   (D) worktree gone, content genuinely NEVER landed at all — same refusal, proving the fix is general
//       to "worktree gone + lookup null", not specific to one cause of the null.
//   (E) worktree PRESENT (task forced terminal instead, triggering the early check's OTHER disjunct) —
//       regression guard for the UNAFFECTED path: real gate runs, squash correctly stages nothing
//       (STAGE_EMPTY_RETRY), no crash, no new refusal.
// Each of (C)/(D) also asserts: unchanged main HEAD / branch / task column, a recorded merge_rejected
// event, and that a SECOND confirm genuinely re-runs (no `cacheHit`) rather than replaying a cached verdict.
//
// CODE REVIEW ROUND 2 (card c30952c1) found a MAJOR + a MINOR this file didn't yet cover:
//
// MAJOR: when `preLanded` ends up truthy (first lookup OR the retry) WHILE the worktree is gone, the
// existing `if (preLanded)` finalize shortcut used to gate on `computeWorktreeGateStamp(worktreePath)
// .head !== null` — always `null` for a missing directory, so it fell through into the ordinary gate
// path and mislabelled the refusal as `gate_worktree_dirty` ("uncommitted changes") about a worktree
// that has none, leaving the task stuck in_progress. Fixed: skip the stamp entirely when the worktree is
// missing and finish directly. Scenarios (F)/(G) below pin BOTH legs that reach this code (first-lookup-
// success and retry-success), via a NEW test-only seam (`preLandedLookupGitFactory`, same style as the
// pre-existing `alreadyLandedGitFactory`) threaded ONLY into the `if (gate)` block's own two
// `findLandedSquashCommit` calls (the first attempt and the retry) — chosen because no EXISTING seam
// reaches those two calls (the early `!fs.existsSync` short-circuit's own lookup, and the batch-fallback
// fault-injection tests' `alreadyLandedGitFactory`, both reach DIFFERENT call sites — see
// batch-fallback-already-landed-lookup-fault-injection-timeout.mjs's own header for why). Rather than
// throwing to simulate a fault, the factory LANDS the branch for real (via `mergeBranch`, the same
// lower-level helper `merge-content-reachability.mjs` uses) as a side effect of the Nth matching
// `git log --grep=Loom-Worker-Branch` call — deterministic, no real timing/concurrency needed: the EARLY
// short-circuit's own (unfaulted) lookup runs against a genuinely not-yet-landed repo and correctly
// returns null (falling through, exactly like scenarios C/D), and only the `if (gate)` block's own
// lookup(s) — the ones this seam controls — ever see the landing.
//   (F) first-lookup-success leg: the landing happens on the FIRST `if (gate)` lookup (match #1) — the
//       retry never fires. Expect merged:true, ALREADY_MERGED, task done, no mislabelled refusal.
//   (G) retry-success leg: the first `if (gate)` lookup (match #1) runs on a still-unlanded repo and
//       correctly returns null, triggering the retry; the landing happens on the retry (match #2).
//       Expect the same clean ALREADY_MERGED finish.
//
// MINOR 1: `mergeMainIntoWorktree` is ALSO called for admission-time re-union (after a gate-queue wait of
// possibly minutes), and used to construct its worktree git handle OUTSIDE any try — a worktree that
// vanished DURING that wait threw the same uncaught GitConstructError there too. Fixed: that construction
// now lives inside `mergeMainIntoWorktree`'s own try, returning `{ok:false, worktreeMissing:true, ...}`;
// the admission-time caller maps it to a new, distinct, never-cached reason
// (`worktree_missing_at_admission` / `worktreeMissingAtAdmission`) rather than the unrelated
// `worktree_gone_landing_unconfirmed` (this path never touches landedness at all).
//   (H) seam-driven, via the EXISTING `unionMergeGitFactory` test seam (already threaded into both the
//       pre-gate union-merge AND the admission-time re-union): on the FIRST call matching the worktree
//       path, advances canonical main as a side effect (deterministically simulating "a sibling landed
//       while this op waited in the gate queue", with no real concurrency needed) before returning the
//       real git handle, so the admission-time re-union's own `admissionHead !== gateBaseMainHead` check
//       actually fires; on the SECOND such call (the re-union attempt itself), throws the same
//       `GitConstructError`-shaped failure a genuinely-vanished worktree would produce. The real worktree
//       is never touched, so a plain follow-up confirm (fresh SessionService, no fault) proves this isn't
//       a permanent stuck state.
//
// Run: 1) build daemon (pnpm build), 2) node test/worktree-gone-landing-unconfirmed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-wtglu-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");
const { canonicalGit } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wtglu@loom -c user.name=wtglu";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const PASS_GATE = process.platform === "win32" ? "node -e \"process.exit(0)\"" : "true";
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, getPid() { return undefined; } };

async function buildFixture(label, { landOutOfBand, keepWorktree }) {
  const sfx = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projId = `wtglu-proj-${sfx}`, agentId = `wtglu-agent-${sfx}`, taskId = `wtglu-task-${sfx}`;
  const mgrId = `wtglu-mgr-${sfx}`, workerId = `wtglu-wkr-${sfx}`;
  const repo = path.join(os.tmpdir(), `loom-wtglu-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# wtglu\n");
  execSync(`git init -q && git config user.email wtglu@loom && git config user.name wtglu`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);

  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
    gitOpMs: 5_000,
    syncAttachBudgetMs: 60_000,
  });

  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "feat.txt"), "feature work\n");
  commitAll(worktreePath, "feat: add feature", GIT_ID);

  if (landOutOfBand) {
    // Lands the branch's content onto main WITHOUT Loom's own merge machinery — no Loom-Worker-Branch
    // trailer gets stamped, so findLandedSquashCommit's grep has nothing to find: the stand-in for
    // "really landed, but the lookup can't see it" (same observable null as a timeout-degraded lookup).
    execSync(`git merge --squash ${branch}`, { cwd: repo });
    execFileSync("git", [...GIT_ID.split(" "), "commit", "-q", "-m", "feat: add feature (landed out of band, no trailer)"], { cwd: repo });
  }

  db.insertProject({ id: projId, name: "WTGLU", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "WTGLU-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  if (keepWorktree) db.updateTask(taskId, { columnKey: "done" }); // forces taskAlreadyTerminal:true without removing the worktree
  else fs.rmSync(worktreePath, { recursive: true, force: true }); // genuinely gone, same precondition as !fs.existsSync(worktreePath)

  return { db, sessions, repo, projId, taskId, mgrId, workerId, worktreePath, branch };
}

const dbs = [];

try {
  // (C) worktree gone, content landed OUT OF BAND (undetectable).
  {
    const f = await buildFixture("C", { landOutOfBand: true, keepWorktree: false });
    dbs.push(f.db);
    const headBefore = git(f.repo, "rev-parse HEAD");

    const r1 = await f.sessions.confirmWorkerMergeTracked(f.mgrId, f.workerId);
    check("(C) settles (not a thrown error)", r1.settled === true);
    check("(C) ok:true (the refusal is a RESULT, not a caught error)", r1.ok === true);
    check("(C) merged:false", r1.ok && r1.value.merged === false);
    check("(C) named reason worktreeGoneLandingUnconfirmed:true", r1.ok && r1.value.worktreeGoneLandingUnconfirmed === true);
    check("(C) reason text names the worktree being gone", r1.ok && /worktree is gone/.test(r1.value.reason ?? ""));
    check("(C) detailText does NOT claim a timeout (the code doesn't know that)", r1.ok && !/timed out/i.test(r1.value.detailText ?? ""));
    check("(C) detailText says nothing was touched", r1.ok && /nothing was touched/.test(r1.value.detailText ?? ""));
    check("(C) main HEAD unchanged", git(f.repo, "rev-parse HEAD") === headBefore);
    check("(C) branch ref still exists (untouched)", git(f.repo, `branch --list ${f.branch}`) !== "");
    check("(C) task column unchanged (still in_progress)", f.db.getTask(f.taskId)?.columnKey === "in_progress");
    const rejected = f.db.listEventsForWorker(f.workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "worktree_gone_landing_unconfirmed");
    check("(C) a merge_rejected event is recorded with the named reason", rejected.length === 1);

    // NEVER CACHED: a second confirm must genuinely re-run (a fresh opId, no cacheHit) rather than
    // replaying this refusal from the until-superseded verdict cache.
    const r2 = await f.sessions.confirmWorkerMergeTracked(f.mgrId, f.workerId);
    check("(C) second confirm settles ok:true again", r2.settled === true && r2.ok === true);
    check("(C) second confirm carries NO cacheHit (genuinely re-ran)", r2.cacheHit === undefined);
    check("(C) second confirm gets a DIFFERENT opId (a fresh mint, not a replay)", r2.ok && r2.value.opId !== r1.value.opId);
    check("(C) second confirm is the SAME named refusal again (worktree still gone)", r2.ok && r2.value.worktreeGoneLandingUnconfirmed === true);
  }

  // (D) worktree gone, content genuinely NEVER landed — same refusal, proving it's general to the
  // "worktree gone + lookup null" shape, not specific to the out-of-band-landing cause of the null.
  {
    const f = await buildFixture("D", { landOutOfBand: false, keepWorktree: false });
    dbs.push(f.db);
    const headBefore = git(f.repo, "rev-parse HEAD");

    const r1 = await f.sessions.confirmWorkerMergeTracked(f.mgrId, f.workerId);
    check("(D) settles (not a thrown error)", r1.settled === true);
    check("(D) ok:true", r1.ok === true);
    check("(D) named reason worktreeGoneLandingUnconfirmed:true", r1.ok && r1.value.worktreeGoneLandingUnconfirmed === true);
    check("(D) main HEAD unchanged", git(f.repo, "rev-parse HEAD") === headBefore);
    check("(D) branch ref still exists", git(f.repo, `branch --list ${f.branch}`) !== "");
    check("(D) task column unchanged", f.db.getTask(f.taskId)?.columnKey === "in_progress");
    const rejected = f.db.listEventsForWorker(f.workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "worktree_gone_landing_unconfirmed");
    check("(D) a merge_rejected event is recorded", rejected.length === 1);

    const r2 = await f.sessions.confirmWorkerMergeTracked(f.mgrId, f.workerId);
    check("(D) second confirm carries NO cacheHit", r2.cacheHit === undefined);
    check("(D) second confirm gets a DIFFERENT opId", r2.ok && r2.value.opId !== r1.value.opId);
  }

  // (E) REGRESSION GUARD — worktree PRESENT: the unaffected path must stay exactly as before this card.
  {
    const f = await buildFixture("E", { landOutOfBand: true, keepWorktree: true });
    dbs.push(f.db);
    check("(E) PRECONDITION: the worktree directory is still on disk", fs.existsSync(f.worktreePath));

    const r1 = await f.sessions.confirmWorkerMergeTracked(f.mgrId, f.workerId);
    check("(E) settles ok:true (no crash)", r1.settled === true && r1.ok === true);
    check("(E) merged:false, emptyKind STAGE_EMPTY_RETRY (the real gate ran and the squash correctly staged nothing)", r1.ok && r1.value.merged === false && r1.value.emptyKind === "STAGE_EMPTY_RETRY");
    check("(E) does NOT carry the new worktreeGoneLandingUnconfirmed refusal", r1.ok && r1.value.worktreeGoneLandingUnconfirmed === undefined);
    const passed = f.db.listEventsForWorker(f.workerId).filter((e) => e.kind === "build_gate" && e.detail?.passed === true);
    check("(E) the real gate actually ran (build_gate event, passed:true)", passed.length === 1);
  }

  // Shared setup for (F)/(G): worker worktree created, feature committed, then REMOVED — but NOT landed
  // onto main at all yet (the fixture itself lands nothing; each scenario's own factory does, as a side
  // effect of the matching `if (gate)` lookup call it wants to make succeed). `makeFactory({repo, branch})`
  // is called AFTER the repo/branch are known, so the factory never needs a forward reference.
  async function buildUnlandedGoneFixture(label, makeFactory) {
    const sfx = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const projId = `wtglu-proj-${sfx}`, agentId = `wtglu-agent-${sfx}`, taskId = `wtglu-task-${sfx}`;
    const mgrId = `wtglu-mgr-${sfx}`, workerId = `wtglu-wkr-${sfx}`;
    const repo = path.join(os.tmpdir(), `loom-wtglu-repo-${sfx}`);
    fs.mkdirSync(repo, { recursive: true });
    registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# wtglu\n");
    execSync(`git init -q && git config user.email wtglu@loom && git config user.name wtglu`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);

    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "feature work\n");
    commitAll(worktreePath, "feat: add feature", GIT_ID);
    fs.rmSync(worktreePath, { recursive: true, force: true }); // genuinely gone, nothing landed yet

    const counters = makeFactory({ repo, branch });
    const db = new Db();
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      reapWorktreeProcesses: async () => ({ killedPids: [] }), gitOpMs: 5_000, syncAttachBudgetMs: 60_000,
      preLandedLookupGitFactory: counters.factory,
    });
    db.insertProject({ id: projId, name: "WTGLU", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "WTGLU-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    return { db, sessions, repo, projId, taskId, mgrId, workerId, worktreePath, branch, counters };
  }

  // A `--grep=Loom-Worker-Branch`-matching `git log` call, wrapping real git — `onMatch(matchCount)` runs
  // BEFORE delegating, so it can land the branch (or not) depending on which call number this is.
  function makeLandingOnMatchFactory({ repo, branch }, onMatch) {
    let matchCount = 0;
    const factory = (p, ms) => {
      const real = canonicalGit(p, ms);
      return {
        raw: async (args) => {
          if (args[0] === "log" && args.some((a) => typeof a === "string" && a.startsWith("--grep=Loom-Worker-Branch"))) {
            matchCount++;
            await onMatch(matchCount, repo, branch);
          }
          return real.raw(args);
        },
      };
    };
    return { factory, get matchCount() { return matchCount; } };
  }

  // (F) MAJOR FIX — first-lookup-success leg: the landing happens on match #1, no retry needed.
  {
    const f = await buildUnlandedGoneFixture("F", (ctx) => makeLandingOnMatchFactory(ctx, async (n, repo, branch) => {
      if (n === 1) await mergeBranch(repo, branch, "WTGLU-TASK");
    }));
    dbs.push(f.db);

    const r1 = await f.sessions.confirmWorkerMergeTracked(f.mgrId, f.workerId);
    check("(F) the factory's git-log lookup actually fired exactly once (no retry needed)", f.counters.matchCount === 1);
    check("(F) settles ok:true", r1.settled === true && r1.ok === true);
    check("(F) merged:true (first lookup found the landing, no mislabelled gate_worktree_dirty)", r1.ok && r1.value.merged === true);
    check("(F) emptyKind ALREADY_MERGED", r1.ok && r1.value.emptyKind === "ALREADY_MERGED");
    check("(F) gateSkipped already-landed (no real gate ran)", r1.ok && r1.value.gateSkipped === "already-landed");
    check("(F) task moved to done", f.db.getTask(f.taskId)?.columnKey === "done");
    check("(F) does not carry the worktree_gone_landing_unconfirmed refusal", r1.ok && r1.value.worktreeGoneLandingUnconfirmed === undefined);
  }

  // (G) MAJOR FIX — retry-success leg: match #1 runs on a still-unlanded repo (correctly null), the
  // landing happens on match #2 (the retry).
  {
    const g = await buildUnlandedGoneFixture("G", (ctx) => makeLandingOnMatchFactory(ctx, async (n, repo, branch) => {
      if (n === 2) await mergeBranch(repo, branch, "WTGLU-TASK");
    }));
    dbs.push(g.db);

    const r1 = await g.sessions.confirmWorkerMergeTracked(g.mgrId, g.workerId);
    check("(G) the factory's git-log lookup fired exactly twice (first attempt + retry)", g.counters.matchCount === 2);
    check("(G) settles ok:true", r1.settled === true && r1.ok === true);
    check("(G) merged:true (the retry found the landing)", r1.ok && r1.value.merged === true);
    check("(G) emptyKind ALREADY_MERGED", r1.ok && r1.value.emptyKind === "ALREADY_MERGED");
    check("(G) task moved to done", g.db.getTask(g.taskId)?.columnKey === "done");
    check("(G) does not carry the worktree_gone_landing_unconfirmed refusal (the retry succeeded)", r1.ok && r1.value.worktreeGoneLandingUnconfirmed === undefined);
  }

  // (H) MINOR 1 — the worktree vanishing DURING the gate-queue wait, discovered at admission-time
  // re-union. Seam-driven via the EXISTING `unionMergeGitFactory` test seam (threaded into both the
  // pre-gate union-merge and the admission-time re-union) — no new seam needed here.
  {
    const sfx = `H-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const projId = `wtglu-proj-${sfx}`, agentId = `wtglu-agent-${sfx}`, taskId = `wtglu-task-${sfx}`;
    const mgrId = `wtglu-mgr-${sfx}`, workerId = `wtglu-wkr-${sfx}`;
    const repo = path.join(os.tmpdir(), `loom-wtglu-repo-${sfx}`);
    fs.mkdirSync(repo, { recursive: true });
    registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# wtglu\n");
    execSync(`git init -q && git config user.email wtglu@loom && git config user.name wtglu`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);

    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "feature work\n");
    commitAll(worktreePath, "feat: add feature", GIT_ID);
    const headBeforeSibling = git(repo, "rev-parse HEAD");

    // `repoGit` (mainSha capture) is constructed BEFORE `wtGit` inside `mergeMainIntoWorktree` — so the
    // side effect must fire on the RETURNED HANDLE's first `raw()` call (the merge-base check, which runs
    // AFTER `mainSha` is already captured), never at factory-construction time, or it would advance main
    // before `mainSha` is read and the admission-time "moved" check would never see a difference.
    let worktreePathConstructs = 0;
    const unionMergeGitFactory = (p, ms) => {
      if (p !== worktreePath) return canonicalGit(p, ms);
      worktreePathConstructs++;
      if (worktreePathConstructs === 1) {
        const real = canonicalGit(p, ms);
        let sideEffectDone = false;
        return {
          raw: async (args) => {
            if (!sideEffectDone) {
              sideEffectDone = true;
              // Deterministically simulates "a sibling landed while this op waited in the gate queue"
              // with no real concurrency needed — this is what makes the admission-time re-union's own
              // `admissionHead !== gateBaseMainHead` check actually fire below.
              fs.writeFileSync(path.join(repo, "sibling.txt"), "sibling landed while queued\n");
              commitAll(repo, "feat: sibling landed during the queue wait", GIT_ID);
            }
            return real.raw(args);
          },
        };
      }
      // SECOND construction (the admission-time re-union itself): simulate the worktree having vanished.
      throw new Error("Cannot use simple-git on a directory that does not exist (fault-injected, card c30952c1 test)");
    };

    const db = new Db();
    dbs.push(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      reapWorktreeProcesses: async () => ({ killedPids: [] }), gitOpMs: 5_000, syncAttachBudgetMs: 60_000,
      unionMergeGitFactory,
    });
    db.insertProject({ id: projId, name: "WTGLU", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "WTGLU-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
    check("(H) the fault factory actually fired twice (the side-effect commit + the simulated vanish)", worktreePathConstructs === 2);
    check("(H) settles ok:true (the refusal is a RESULT, not a caught/thrown error)", r1.settled === true && r1.ok === true);
    check("(H) merged:false, named reason worktreeMissingAtAdmission:true", r1.ok && r1.value.merged === false && r1.value.worktreeMissingAtAdmission === true);
    check("(H) reason text names the worktree being gone", r1.ok && /no longer exists/.test(r1.value.reason ?? ""));
    check("(H) detailText says nothing was touched", r1.ok && /nothing was touched/.test(r1.value.detailText ?? ""));
    check("(H) main HEAD only differs by the deliberate sibling commit (no squash landed)", git(repo, "rev-parse HEAD") !== headBeforeSibling && git(repo, "rev-list --count HEAD") === "2");
    check("(H) branch ref still exists (untouched)", git(repo, `branch --list ${branch}`) !== "");
    check("(H) task column unchanged (still in_progress)", db.getTask(taskId)?.columnKey === "in_progress");
    check("(H) the real worktree directory was NEVER actually touched (still on disk)", fs.existsSync(worktreePath));
    const rejected = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "worktree_missing_at_admission");
    check("(H) a merge_rejected event is recorded with the named reason", rejected.length === 1);

    // NEVER CACHED + genuinely recoverable: a FRESH SessionService (no fault factory) confirming the SAME
    // worker now succeeds normally — the "vanish" was only ever simulated, the real worktree is fine.
    const sessions2 = new SessionService(db, ptyStub, new OrchestrationControl(), {
      reapWorktreeProcesses: async () => ({ killedPids: [] }), gitOpMs: 5_000, syncAttachBudgetMs: 60_000,
    });
    const r2 = await sessions2.confirmWorkerMergeTracked(mgrId, workerId);
    check("(H) a follow-up confirm with the fault cleared carries NO cacheHit (genuinely re-ran)", r2.cacheHit === undefined);
    check("(H) a follow-up confirm with the fault cleared actually merges (not a permanent stuck state)", r2.ok && r2.value.merged === true);
    check("(H) task moved to done on the follow-up confirm", db.getTask(taskId)?.columnKey === "done");
  }
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a missing worktree + an unconfirmed already-landed lookup refuses cleanly (named reason, nothing touched, a recorded event, never cached) instead of crashing uncaught; the worktree-present path is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
