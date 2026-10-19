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
// success and retry-success), via a test-only seam (`preLandedLookupGitFactory`, same style as the
// pre-existing `alreadyLandedGitFactory`) threaded into the `if (gate)` block's own two
// `findLandedSquashCommit` calls (the first attempt and the retry). Rather than throwing to simulate a
// fault, the factory LANDS the branch for real (via `mergeBranch`, the same lower-level helper
// `merge-content-reachability.mjs` uses) as a side effect of the Nth matching `git log
// --grep=Loom-Worker-Branch` call — deterministic, no real timing/concurrency needed.
//   ⚠️ Card 89bc3b86 (finding 3): this seam now ALSO threads into TWO more call sites than when this
//   paragraph was first written — the EARLY `!fs.existsSync` short-circuit's own `finishSoloAlreadyLanded`
//   call (always its own match #1, correctly null here, since nothing has landed yet) and the LATER
//   `if (preLanded)` finalize block's OWN `finishSoloAlreadyLanded` call (its own trailing match, which
//   simply re-confirms the real landing once `if (gate)`'s own lookup already found it) — see scenario
//   (K) below, which deliberately faults that second one. (F)/(G)'s own match numbering is shifted by
//   one slot from this file's ORIGINAL design to account for the first of those two; read each
//   scenario's own comment for its current count, not the numbers in this paragraph.
//   (F) first-lookup-success leg: the landing happens on the `if (gate)` block's own first lookup — the
//       retry never fires. Expect merged:true, ALREADY_MERGED, task done, no mislabelled refusal.
//   (G) retry-success leg: the `if (gate)` block's own first lookup runs on a still-unlanded repo and
//       correctly returns null, triggering the retry; the landing happens on the retry.
//       Expect the same clean ALREADY_MERGED finish.
//   (K) card 89bc3b86 finding 3 — `finishSoloAlreadyLanded`'s own trailing re-lookup (not (F)/(G)'s) is
//       the one faulted; see its own header below.
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
//       actually fires; on the SECOND such call (the re-union attempt itself), RENAMES the real worktree
//       directory away before throwing — a genuine, if transient, vanish (card 89bc3b86's own
//       fs.existsSync-in-the-catch fix means a bare throw with the path still present no longer
//       classifies as worktreeMissing at all — see finding 4 below). The test renames it back before the
//       same-instance re-confirm and again before the fresh-instance recovery check, proving this isn't a
//       permanent stuck state either way.
//
// CARD 89bc3b86 ROUND 2 — a Code Review of the first round's fixes found a MAJOR and several smaller
// items, closed here:
//
// MAJOR: a worktree that vanishes during the gate-queue wait with MAIN UNCHANGED (only the worker's own
// late commit, or nothing at all, moved) skips `reunionAtAdmission`'s own re-union entirely — it only
// runs when `admissionHead !== gateBaseMainHead`. Flow then reaches `captureGatedTip` (called right
// before every real gate spawn), whose own `computeWorktreeGateStamp` read returns `head:null` for the
// gone worktree, throwing `GateWorktreeDirtyError` — caught as an ordinary `gate_worktree_dirty` mislabel,
// exactly the MINOR-1 bug round 1 fixed at a DIFFERENT call site. The gate-OFF/interval-skip `heldStamp`
// check (reached post-guard-wait, pre-gate, when the gate is disabled) has the identical shape. Fixed:
// both now check `fs.existsSync(worktreePath)` on a null head and route to the shared
// `refuseWorktreeMissingAtAdmission` helper (finding 4) instead.
//   (L) the queued-wait-no-main-move leg — holds the repo guard directly (same technique as (I)/(J)),
//       removes the worktree while held, releases with main UNTOUCHED. `captureGatedTip`'s own detection
//       is what fires here, not `reunionAtAdmission`.
//   (M) the gate-OFF `heldStamp` leg — same hold-then-remove technique, but the project has a
//       `gateCommand` configured WITH `orchestration.mergeGate:"off"` (a project with NO gateCommand at
//       all never reaches `if (gate)` at all), so the gate-disabled/inert-skip `heldStamp` check fires.
//
// Finding 2: nothing in this file goes RED without card 89bc3b86 round 1's `fs.existsSync`-in-the-catch
// fix (`mergeMainIntoWorktree`'s wtGit-construction catch, git/worktrees.ts). Scenario (N) exercises
// `mergeMainIntoWorktree` directly: a factory throws while the path genuinely still exists, asserting
// `worktreeMissing` is NOT set and the reason names the construction failure, never "worktree missing".
//
// Finding 3: (K)'s own "never cached" proof used to re-confirm on a FRESH `SessionService` (same gap
// finding 2 of round 1 closed for (H)) — fixed to re-confirm on the SAME instance instead.
//
// Run: 1) build daemon (pnpm build), 2) node test/worktree-gone-landing-unconfirmed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

useOwnLoomHome("loom-wtglu-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeBranch, mergeMainIntoWorktree } = await import("../dist/git/worktrees.js");
const { canonicalGit } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wtglu@loom -c user.name=wtglu";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const PASS_GATE = process.platform === "win32" ? "node -e \"process.exit(0)\"" : "true";
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, getPid() { return undefined; } };
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });

// Card 89bc3b86, scenarios (I)/(J): polls `gateQueueForManager` (the SAME read `gate_queue` uses) until a
// repo-guard-only wait for `repoPath` shows up QUEUED — i.e. the confirming op has already captured its
// own `gateBaseMainHead`/`preWaitBranchHead`/`inertSkip` and is now genuinely blocked behind the test's
// own directly-held guard. Mirrors `merge-gate-inert-diff.mjs`'s identical helper (same reasoning: a fixed
// sleep races real git-subprocess timing against this test's own hold/release).
async function waitUntilRepoGuardQueued(sessions, projId, repoPath, timeoutMs) {
  try {
    return await sharedWaitUntil(() => {
      const snap = sessions.gateQueueForManager(projId);
      return snap.repoGuardOnly.some((e) => e.phase === "queued" && e.repoPath === repoPath);
    }, { timeoutMs, intervalMs: 10, label: "worktree-gone-landing-unconfirmed: repo guard queued" });
  } catch (err) {
    if (err?.exhaustedOnThrow !== false) throw err;
    return false;
  }
}

// Card 89bc3b86, scenarios (I)/(J): a repo with a baseline JS/TS source file committed on main, so the
// `docs/`-prefix allowlist's per-repo applicability guard (`repoTreeHasJsTsSourceFile`) actually applies —
// without this, every docs-only diff below would full-gate regardless of `isInertMergeDiff`, which would
// never reach the repo-guard-only wait this pair of scenarios exists to test. Mirrors `merge-gate-inert-
// diff.mjs`'s own `makeRepo`.
function makeInertCapableRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# wtglu-inert\n");
  mkdirp(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  execSync(`git init -q && git config user.email wtglu@loom && git config user.name wtglu`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

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

  // Shared setup for (F)/(G)/(K): worker worktree created, feature committed, then REMOVED. When
  // `preLand` is true, the branch is ALSO landed for real (via `mergeBranch`, through plain unfaulted
  // git — this helper never routes through any test factory) before the factory or SessionService are
  // even constructed, so every later read sees a stable, already-settled repo: no scenario below depends
  // on a fault-injected `git log` read racing against a real squash commit's own write visibility. Each
  // scenario's own factory instead decides, per match, whether to let a read see that real landing or to
  // fault it (throw) to simulate "not yet landed" — deterministic either way. `makeFactory({repo, branch})`
  // is called AFTER the repo/branch (and the real landing, if any) are settled.
  async function buildUnlandedGoneFixture(label, makeFactory, { preLand = false } = {}) {
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
    fs.rmSync(worktreePath, { recursive: true, force: true }); // genuinely gone

    if (preLand) {
      const landed = await mergeBranch(repo, branch, "WTGLU-TASK");
      if (!landed.ok) throw new Error(`(${label}) fixture setup: mergeBranch failed to pre-land: ${JSON.stringify(landed)}`);
    }

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

  // A `--grep=Loom-Worker-Branch`-matching `git log` call, wrapping real git — `faultMatches` names the
  // match numbers (1-based) that should THROW (simulating "the lookup came back ambiguous/not-yet-landed"
  // — `findLandedSquashCommit` fails safe to null on ANY error) instead of delegating to the real read.
  // Deterministic: the repo's real content never changes mid-test, so which matches are faulted is the
  // ONLY thing that varies the outcome, never real-git write-visibility timing.
  function makeFaultedMatchFactory({ repo, branch }, faultMatches) {
    let matchCount = 0;
    const factory = (p, ms) => {
      const real = canonicalGit(p, ms);
      return {
        raw: async (args) => {
          if (args[0] === "log" && args.some((a) => typeof a === "string" && a.startsWith("--grep=Loom-Worker-Branch"))) {
            matchCount++;
            if (faultMatches.includes(matchCount)) throw new Error(`fault-injected transient git error (card 89bc3b86 test, match ${matchCount})`);
          }
          return real.raw(args);
        },
      };
    };
    return { factory, get matchCount() { return matchCount; } };
  }

  // (F) MAJOR FIX — first-lookup-success leg: the `if (gate)` block's own first attempt finds the
  // (already-landed) branch immediately, no retry needed. Card 89bc3b86: `preLandedLookupGitFactory` now
  // ALSO threads into the EARLY `!fs.existsSync(worktreePath)` short-circuit's own `finishSoloAlreadyLanded`
  // call (match #1 — faulted here, so it still reads as "not yet landed", matching this scenario's
  // original intent) and into the LATER `if (preLanded)` finalize block's own `finishSoloAlreadyLanded`
  // call (match #3 — let through for real, confirming the real landing a second time).
  {
    const f = await buildUnlandedGoneFixture("F", (ctx) => makeFaultedMatchFactory(ctx, [1]), { preLand: true });
    dbs.push(f.db);

    const r1 = await f.sessions.confirmWorkerMergeTracked(f.mgrId, f.workerId);
    check("(F) the factory's git-log lookup fired exactly three times (early short-circuit, faulted + if(gate)'s own first attempt, real + finalize's own re-lookup, real)", f.counters.matchCount === 3);
    check("(F) settles ok:true", r1.settled === true && r1.ok === true);
    check("(F) merged:true (first lookup found the landing, no mislabelled gate_worktree_dirty)", r1.ok && r1.value.merged === true);
    check("(F) emptyKind ALREADY_MERGED", r1.ok && r1.value.emptyKind === "ALREADY_MERGED");
    check("(F) gateSkipped already-landed (no real gate ran)", r1.ok && r1.value.gateSkipped === "already-landed");
    check("(F) task moved to done", f.db.getTask(f.taskId)?.columnKey === "done");
    check("(F) does not carry the worktree_gone_landing_unconfirmed refusal", r1.ok && r1.value.worktreeGoneLandingUnconfirmed === undefined);
  }

  // (G) MAJOR FIX — retry-success leg: the `if (gate)` block's own first attempt is faulted (reads as
  // still-unlanded), triggering the retry; the retry reads the REAL (already-landed) content and finds
  // it. Card 89bc3b86: same one-slot-of-faulting shift as (F) above, for the same reason (the early
  // short-circuit's own now-threaded call is match #1, also faulted here).
  {
    const g = await buildUnlandedGoneFixture("G", (ctx) => makeFaultedMatchFactory(ctx, [1, 2]), { preLand: true });
    dbs.push(g.db);

    const r1 = await g.sessions.confirmWorkerMergeTracked(g.mgrId, g.workerId);
    check("(G) the factory's git-log lookup fired exactly four times (early short-circuit, faulted + if(gate)'s own first attempt, faulted + its retry, real + finalize's own re-lookup, real)", g.counters.matchCount === 4);
    check("(G) settles ok:true", r1.settled === true && r1.ok === true);
    check("(G) merged:true (the retry found the landing)", r1.ok && r1.value.merged === true);
    check("(G) emptyKind ALREADY_MERGED", r1.ok && r1.value.emptyKind === "ALREADY_MERGED");
    check("(G) task moved to done", g.db.getTask(g.taskId)?.columnKey === "done");
    check("(G) does not carry the worktree_gone_landing_unconfirmed refusal (the retry succeeded)", r1.ok && r1.value.worktreeGoneLandingUnconfirmed === undefined);
  }

  // (K) card 89bc3b86 finding 3 — preLanded ends up TRUTHY (the branch is pre-landed for real, before the
  // factory or SessionService even exist, same deterministic shape as (F)/(G) above), but
  // `finishSoloAlreadyLanded`'s OWN internal re-lookup (its `tipAcrossLandedCheck` call) then comes back
  // null (a second, independent ambiguity — the proof is no longer confirmable by the time finalize tries
  // to re-verify it), with the worktree ALSO gone. Pre-fix: this fell through into the ordinary
  // freshStamp/reuse logic, which reads a gone worktree as "unreadable" and mislabels the eventual
  // refusal as `gate_worktree_dirty` ("uncommitted changes") about a worktree that has none, stranding the
  // task `in_progress`. Chosen seam: reuses the EXISTING `preLandedLookupGitFactory` (no new seam) — it
  // now threads into `finishSoloAlreadyLanded`'s own internal lookup too (card 89bc3b86's fix). THREE
  // matches reach this one factory: (1) the EARLY short-circuit's own `finishSoloAlreadyLanded` call is
  // faulted (so it does NOT short-circuit the whole confirm immediately off the real pre-landed content —
  // this scenario needs to reach the `if (gate)` block, not finish at the early check); (2) the
  // `if (gate)` block's own outer `preLanded` lookup reads the real (already-landed) content, making
  // `preLanded` truthy; (3) the `if (preLanded)` finalize block's OWN call to `finishSoloAlreadyLanded`
  // is the other faulted match — the one this finding is actually about.
  {
    const f = await buildUnlandedGoneFixture("K", (ctx) => makeFaultedMatchFactory(ctx, [1, 3]), { preLand: true });
    dbs.push(f.db);

    const r1 = await f.sessions.confirmWorkerMergeTracked(f.mgrId, f.workerId);
    check("(K) the factory's git-log lookup fired exactly three times (early short-circuit, faulted + outer lookup, real + finalize's own re-lookup, faulted)", f.counters.matchCount === 3);
    check("(K) settles ok:true (the refusal is a RESULT, not a crash/mislabel)", r1.settled === true && r1.ok === true);
    check("(K) merged:false, named reason worktreeGoneLandingUnconfirmed:true (NOT the generic gate_worktree_dirty mislabel)", r1.ok && r1.value.merged === false && r1.value.worktreeGoneLandingUnconfirmed === true);
    check("(K) does not carry the generic gateWorktreeDirty shape", r1.ok && r1.value.gateWorktreeDirty === undefined);
    check("(K) reason text names the worktree being gone", r1.ok && /worktree is gone/.test(r1.value.reason ?? ""));
    check("(K) task column unchanged (still in_progress, not stranded as a mislabelled dirty-tree refusal)", f.db.getTask(f.taskId)?.columnKey === "in_progress");
    const rejected = f.db.listEventsForWorker(f.workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "worktree_gone_landing_unconfirmed");
    check("(K) a merge_rejected event is recorded with the named reason", rejected.length === 1);

    // Card 89bc3b86 round 2, finding 3: the ORIGINAL version of this check re-confirmed on a FRESH
    // SessionService — the exact gap round 1's own finding 2 (scenario (H)) closed, re-opened here.
    // `PendingOpRegistry`'s cache is per-instance; a fresh instance has nothing to hit regardless of
    // classification. Re-confirm on the SAME `sessions` instance (faultMatches [1,3] still fixed) instead:
    // its own EARLY short-circuit becomes match #4 — not in [1,3], so it reads the REAL (permanently
    // landed) content and finds it immediately. A replayed cache hit would have reproduced the SAME
    // merged:false refusal; genuinely re-running is what lets it instead correctly recover to merged:true.
    const r2 = await f.sessions.confirmWorkerMergeTracked(f.mgrId, f.workerId);
    check("(K) same-instance follow-up fired the factory a fourth time (its own early short-circuit, real)", f.counters.matchCount === 4);
    check("(K) same-instance follow-up carries NO cacheHit (genuinely re-ran, not replayed)", r2.cacheHit === undefined);
    check("(K) same-instance follow-up got a DIFFERENT opId than r1 (a fresh mint, not a replay)", r2.ok && r1.ok && r2.value.opId !== r1.value.opId);
    check("(K) same-instance follow-up actually finds the real landing (merged:true — a replay could never flip the verdict)", r2.ok && r2.value.merged === true);
    check("(K) task moved to done on the follow-up confirm", f.db.getTask(f.taskId)?.columnKey === "done");
  }

  // (N) card 89bc3b86 round 2, finding 2 — nothing in this file (pre-round-2) went RED without the
  // round-1 fs.existsSync-in-the-catch fix (mergeMainIntoWorktree's own wtGit-construction catch,
  // git/worktrees.ts). Exercises that function DIRECTLY, no confirmWorkerMerge machinery: a factory
  // throws on the worktree-path construction while the real directory genuinely still exists. Must NOT
  // classify worktreeMissing, and the reason must name the construction failure, never claim the
  // worktree is gone.
  {
    const sfx = `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = path.join(os.tmpdir(), `loom-wtglu-repo-${sfx}`);
    fs.mkdirSync(repo, { recursive: true });
    registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# wtglu\n");
    execSync(`git init -q && git config user.email wtglu@loom && git config user.name wtglu`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    const { worktreePath, branch } = await createWorktree(repo, `wtglu-proj-${sfx}`, `wtglu-task-${sfx}`);
    registerForCleanup(worktreePath);
    check("(N) PRECONDITION: the worktree directory genuinely exists on disk", fs.existsSync(worktreePath));

    const throwingFactory = (p, ms) => {
      if (p === worktreePath) throw new Error("fault-injected transient git error (card 89bc3b86 round 2 test, path still present)");
      return canonicalGit(p, ms);
    };
    const result = await mergeMainIntoWorktree(repo, worktreePath, { timeoutMs: 5_000, gitFactory: throwingFactory }, undefined, branch);
    check("(N) ok:false", result.ok === false);
    check("(N) NOT worktreeMissing — the path genuinely still exists, so the throw is a DIFFERENT failure", !result.worktreeMissing);
    check("(N) reason names the construction failure, not a claimed vanish", /failed to construct a git handle/.test(result.reason ?? ""));
    check("(N) reason does NOT claim the worktree no longer exists", !/no longer exists/.test(result.reason ?? ""));
    check("(N) the real worktree directory was never touched by this call (still on disk)", fs.existsSync(worktreePath));
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
    const parkedPath = `${worktreePath}.parked`;
    registerForCleanup(parkedPath);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "feature work\n");
    commitAll(worktreePath, "feat: add feature", GIT_ID);
    const headBeforeSibling = git(repo, "rev-parse HEAD");

    // `repoGit` (mainSha capture) is constructed BEFORE `wtGit` inside `mergeMainIntoWorktree` — so the
    // side effect must fire on the RETURNED HANDLE's first `raw()` call (the merge-base check, which runs
    // AFTER `mainSha` is already captured), never at factory-construction time, or it would advance main
    // before `mainSha` is read and the admission-time "moved" check would never see a difference.
    //
    // Card 89bc3b86: the SECOND (and every later) construction genuinely RENAMES the real worktree away
    // (not just throws) so `fs.existsSync(worktreePath)` is honestly false at the exact moment
    // `mergeMainIntoWorktree`'s own catch checks it (card 89bc3b86's fs.existsSync disambiguation — a
    // throw alone, with the path still present, now correctly classifies as a DIFFERENT, non-worktree-
    // missing failure instead, since the real directory is never otherwise touched). The vanish is still
    // only ever transient — restored explicitly by the test, below, before the recovery check.
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
      // SECOND (and any later) construction (the admission-time re-union itself): a genuine, real vanish.
      fs.renameSync(worktreePath, parkedPath);
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
    // Card 89bc3b86: the vanish is now a REAL (rename-away) removal at the moment of the catch — proving
    // fix 4's fs.existsSync disambiguation actually classified this correctly, not merely a throw with the
    // path still present (which would now classify as a DIFFERENT, non-worktreeMissing failure instead).
    check("(H) the real worktree directory genuinely does not exist under its own name right after the refusal", !fs.existsSync(worktreePath) && fs.existsSync(parkedPath));
    const rejected = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "worktree_missing_at_admission");
    check("(H) a merge_rejected event is recorded with the named reason", rejected.length === 1);

    // Card 89bc3b86 finding 2 (Code Review round 2 on c30952c1): the ORIGINAL version of this check
    // re-confirmed on a FRESH SessionService — `PendingOpRegistry`'s `untilSupersededVerdicts` cache is
    // per-instance and in-memory, so a fresh instance has nothing to hit regardless of whether
    // `worktree-missing-at-admission` is actually in `NEVER_CACHED_OUTCOMES`. A negative control (removing
    // that string from the set) left the old check green. Re-confirm on the SAME `sessions` instance
    // instead, worktree STILL genuinely parked (no restore): this hits the EARLY `!fs.existsSync(worktreePath)`
    // short-circuit before `unionMergeGitFactory` is ever reached again, so the factory's own construct
    // count does NOT advance — a DIFFERENT but equally never-cached classification
    // (`worktree-gone-landing-unconfirmed`, since nothing ever actually landed), proving a same-instance
    // re-confirm genuinely re-runs rather than replaying ANY stale worktree-gone verdict from the cache.
    const r1b = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
    check("(H) same-instance re-confirm settles ok:true (a real re-run, not a crash)", r1b.settled === true && r1b.ok === true);
    check("(H) same-instance re-confirm did NOT reach the union-merge factory again (early short-circuit, worktree still gone)", worktreePathConstructs === 2);
    check("(H) same-instance re-confirm carries NO cacheHit (genuinely re-ran, not replayed)", r1b.cacheHit === undefined);
    check("(H) same-instance re-confirm got a DIFFERENT opId than r1 (a fresh mint, not a replay)", r1b.ok && r1.ok && r1b.value.opId !== r1.value.opId);
    check("(H) same-instance re-confirm also refuses cleanly, merged:false", r1b.ok && r1b.value.merged === false);

    // NEVER CACHED + genuinely recoverable: restore the worktree, then a FRESH SessionService (no fault
    // factory) confirming the SAME worker now succeeds normally — the vanish was only ever transient, the
    // real worktree is fine.
    fs.renameSync(parkedPath, worktreePath);
    const sessions2 = new SessionService(db, ptyStub, new OrchestrationControl(), {
      reapWorktreeProcesses: async () => ({ killedPids: [] }), gitOpMs: 5_000, syncAttachBudgetMs: 60_000,
    });
    const r2 = await sessions2.confirmWorkerMergeTracked(mgrId, workerId);
    check("(H) a follow-up confirm with the fault cleared carries NO cacheHit (genuinely re-ran)", r2.cacheHit === undefined);
    check("(H) a follow-up confirm with the fault cleared actually merges (not a permanent stuck state)", r2.ok && r2.value.merged === true);
    check("(H) task moved to done on the follow-up confirm", db.getTask(taskId)?.columnKey === "done");
  }

  // ── (I) card 89bc3b86 finding 1, leg (a) — MAIN moved during the INERT-RECLASSIFY repo-guard-only wait,
  //        and the worktree is ALSO genuinely gone by the time the reclassification's own re-union runs.
  //        Round-2 Code Review on c30952c1: the pre-fix code folded `reunion.worktreeMissing` into the
  //        ordinary `reunionFailed` branch here, which — once admitted — would run a full real gate before
  //        the squash's own entry check refuses anyway (a wasted gate lane for a doomed merge). Mirrors
  //        `merge-gate-inert-diff.mjs` scenario (H)'s own "hold the repo guard directly from the test, land
  //        a real sibling commit on MAIN while held" technique, but ALSO removes the real worktree
  //        directory before releasing — the genuinely-gone leg this card's fix exists for. ────────────────
  {
    const sfx = `i-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const projId = `wtglu-proj-${sfx}`, agentId = `wtglu-agent-${sfx}`, taskId = `wtglu-task-${sfx}`;
    const mgrId = `wtglu-mgr-${sfx}`, workerId = `wtglu-wkr-${sfx}`;
    const repo = path.join(os.tmpdir(), `loom-wtglu-repo-${sfx}`);
    makeInertCapableRepo(repo);
    const db = new Db();
    dbs.push(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      reapWorktreeProcesses: async () => ({ killedPids: [] }), gitOpMs: 5_000, syncAttachBudgetMs: 60_000,
    });

    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    // Docs-only — provably inert against main BEFORE the wait (same precondition `isInertMergeDiff` needs).
    mkdirp(path.join(worktreePath, "docs"));
    fs.writeFileSync(path.join(worktreePath, "docs", "note.md"), "notes\n");
    commitAll(worktreePath, "docs: add note", GIT_ID);
    const headBeforeSibling = git(repo, "rev-parse HEAD");

    db.insertProject({ id: projId, name: "WTGLU-I", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "WTGLU-I-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    // Hold the repo-guard-only slot directly from the test — the SAME primitive the inert-skip path itself
    // calls (`GateSemaphore.acquireRepoGuardOnly`).
    const releaseTestHold = await sessions.gateSemaphore.acquireRepoGuardOnly({
      repoPath: repo, projectId: projId, sessionId: "test-holder", taskId: null, branch: null, opId: "test-holder-op-i",
    });

    const pConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId);
    const queued = await waitUntilRepoGuardQueued(sessions, projId, repo, 60000);
    check("(I) the confirm genuinely reached its own repo-guard-only wait before we release our hold", queued);

    // While held: land a real commit DIRECTLY on main (simulating a same-repo sibling landing while this
    // op waits), AND remove the real worktree directory — the leg this fix covers.
    mkdirp(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "sibling.ts"), "export const sibling = true;\n");
    commitAll(repo, "feat: sibling landed while queued", GIT_ID);
    fs.rmSync(worktreePath, { recursive: true, force: true });

    releaseTestHold();
    const r1 = await pConfirm;

    check("(I) settles ok:true (the refusal is a RESULT, not a crash)", r1.settled === true && r1.ok === true);
    check("(I) merged:false, named reason worktreeMissingAtAdmission:true", r1.ok && r1.value.merged === false && r1.value.worktreeMissingAtAdmission === true);
    check("(I) reason text names the worktree being gone", r1.ok && /no longer exists/.test(r1.value.reason ?? ""));
    check("(I) main HEAD only differs by the deliberate sibling commit (no squash landed)", git(repo, "rev-parse HEAD") !== headBeforeSibling && git(repo, "rev-list --count HEAD") === "2");
    check("(I) branch ref still exists (untouched)", git(repo, `branch --list ${branch}`) !== "");
    check("(I) task column unchanged (still in_progress)", db.getTask(taskId)?.columnKey === "in_progress");
    const rejected = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "worktree_missing_at_admission");
    check("(I) a merge_rejected event is recorded with the named reason", rejected.length === 1);
    // NOTE: unlike (J) below, this leg's FINAL classification is correct even without this card's fix —
    // `reunionAtAdmission`'s own pre-existing (c30952c1) check catches it too, just after first being
    // admitted through the real gate's queue (the "wasted queue wait" this card's own finding names, not
    // a wrong answer). This scenario therefore does NOT by itself discriminate the fix; (J) does.
  }

  // ── (J) card 89bc3b86 finding 1, leg (b) — ONLY the BRANCH moves during the wait (the db413510 trigger)
  //        — MAIN NEVER MOVES — and the worktree is gone by the time the reclassification's own re-union
  //        runs. Pre-fix: `postWaitHead` is still truthy even though it only equals `gateBaseMainHead` by
  //        coincidence, so the re-union still runs; the old code folded its `worktreeMissing` result into
  //        `reunionFailed`, which (per the card) went on to crash/mislabel one call later as a generic
  //        `gate_worktree_dirty` refusal instead of the correct `worktree_missing_at_admission`. Mirrors
  //        `merge-gate-inert-diff.mjs` scenario (J)'s own "hold the guard directly, commit to the BRANCH
  //        while held, main never moves" technique, plus removing the worktree before releasing. ─────────
  {
    const sfx = `j-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const projId = `wtglu-proj-${sfx}`, agentId = `wtglu-agent-${sfx}`, taskId = `wtglu-task-${sfx}`;
    const mgrId = `wtglu-mgr-${sfx}`, workerId = `wtglu-wkr-${sfx}`;
    const repo = path.join(os.tmpdir(), `loom-wtglu-repo-${sfx}`);
    makeInertCapableRepo(repo);
    const db = new Db();
    dbs.push(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      reapWorktreeProcesses: async () => ({ killedPids: [] }), gitOpMs: 5_000, syncAttachBudgetMs: 60_000,
    });

    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    mkdirp(path.join(worktreePath, "docs"));
    fs.writeFileSync(path.join(worktreePath, "docs", "note.md"), "notes\n");
    commitAll(worktreePath, "docs: add note", GIT_ID);

    db.insertProject({ id: projId, name: "WTGLU-J", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "WTGLU-J-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    const mainHeadBefore = git(repo, "rev-parse HEAD");

    const releaseTestHold = await sessions.gateSemaphore.acquireRepoGuardOnly({
      repoPath: repo, projectId: projId, sessionId: "test-holder", taskId: null, branch: null, opId: "test-holder-op-j",
    });

    const pConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId);
    const queued = await waitUntilRepoGuardQueued(sessions, projId, repo, 60000);
    check("(J) the confirm genuinely reached its own repo-guard-only wait before we release our hold", queued);

    // While held: commit a new, non-docs file directly to the worker's OWN branch (the worktree is still
    // present for this — a still-active worker committing further while its own merge waits), THEN remove
    // the real worktree directory. Main is NEVER touched — isolates the branch-only-move leg.
    mkdirp(path.join(worktreePath, "src"));
    fs.writeFileSync(path.join(worktreePath, "src", "late.ts"), "export const late = true;\n");
    commitAll(worktreePath, "feat: late commit during the guard wait", GIT_ID);
    const mainHeadStillDuringWait = git(repo, "rev-parse HEAD");
    check("(J) sanity: main genuinely never moved during the wait — isolates the branch-only case", mainHeadStillDuringWait === mainHeadBefore);
    fs.rmSync(worktreePath, { recursive: true, force: true });

    releaseTestHold();
    const r1 = await pConfirm;

    check("(J) settles ok:true (the refusal is a RESULT, not a crash/mislabel)", r1.settled === true && r1.ok === true);
    check("(J) merged:false, named reason worktreeMissingAtAdmission:true (NOT the generic gate_worktree_dirty mislabel)", r1.ok && r1.value.merged === false && r1.value.worktreeMissingAtAdmission === true);
    check("(J) does not carry the generic gateWorktreeDirty shape", r1.ok && r1.value.gateWorktreeDirty === undefined);
    check("(J) reason text names the worktree being gone", r1.ok && /no longer exists/.test(r1.value.reason ?? ""));
    check("(J) main HEAD is STILL completely unchanged (the branch-only move never touched it)", git(repo, "rev-parse HEAD") === mainHeadBefore);
    check("(J) branch ref still exists, including the late commit (untouched by any squash)", git(repo, `branch --list ${branch}`) !== "");
    check("(J) task column unchanged (still in_progress)", db.getTask(taskId)?.columnKey === "in_progress");
    const rejected = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "worktree_missing_at_admission");
    check("(J) a merge_rejected event is recorded with the named reason", rejected.length === 1);
  }

  // ── (L) card 89bc3b86 round 2, finding 1 (MAJOR) — the queued-wait-no-main-move leg. A REAL (non-inert)
  //        branch, so this takes the full `runExclusive` gate-admission path, never the inert-skip's own
  //        `acquireRepoGuardOnly`. Holding the repo guard directly from the test (the SAME `activeMergeRepos`
  //        registry `runExclusive`'s own `mergeRepoFree` admission check reads — `acquireRepoGuardOnly`
  //        writes to it too, see that method's own doc) blocks this confirm's admission exactly the same
  //        way it would block a same-repo sibling inert-skip. Main is NEVER touched — isolates the leg
  //        `reunionAtAdmission` cannot see (it only re-unions when main moved) from (I)'s own main-moved leg.
  //        The reviewer's own repro. ──────────────────────────────────────────────────────────────────────
  {
    const sfx = `l-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const projId = `wtglu-proj-${sfx}`, agentId = `wtglu-agent-${sfx}`, taskId = `wtglu-task-${sfx}`;
    const mgrId = `wtglu-mgr-${sfx}`, workerId = `wtglu-wkr-${sfx}`;
    const repo = path.join(os.tmpdir(), `loom-wtglu-repo-${sfx}`);
    makeInertCapableRepo(repo);
    const db = new Db();
    dbs.push(db);
    let gateCalls = 0;
    const fakeGate = async () => { gateCalls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      reapWorktreeProcesses: async () => ({ killedPids: [] }), gitOpMs: 5_000, syncAttachBudgetMs: 60_000,
      runGate: fakeGate,
    });

    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    // A REAL (non-docs) change — this must NOT be inert, or it takes (I)/(J)'s own repo-guard-only path.
    mkdirp(path.join(worktreePath, "src"));
    fs.writeFileSync(path.join(worktreePath, "src", "feat.ts"), "export const feat = true;\n");
    commitAll(worktreePath, "feat: add feature", GIT_ID);
    const mainHeadBefore = git(repo, "rev-parse HEAD");

    db.insertProject({ id: projId, name: "WTGLU-L", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "WTGLU-L-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    const releaseTestHold = await sessions.gateSemaphore.acquireRepoGuardOnly({
      repoPath: repo, projectId: projId, sessionId: "test-holder", taskId: null, branch: null, opId: "test-holder-op-l",
    });

    const pConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId);
    const queued = await sharedWaitUntil(() => sessions.gateQueueForManager(projId).queued.some((e) => e.gateType === "merge"), { timeoutMs: 60000, intervalMs: 10, label: "(L) confirm genuinely queued behind the held repo guard" });
    check("(L) the confirm genuinely reached the real gate-admission queue, blocked by the held repo guard", queued);

    // While held: remove the real worktree directory. Main is NEVER touched.
    fs.rmSync(worktreePath, { recursive: true, force: true });
    releaseTestHold();
    const r1 = await pConfirm;

    check("(L) settles ok:true (the refusal is a RESULT, not a crash/mislabel)", r1.settled === true && r1.ok === true);
    check("(L) merged:false, named reason worktreeMissingAtAdmission:true (NOT the generic gate_worktree_dirty mislabel)", r1.ok && r1.value.merged === false && r1.value.worktreeMissingAtAdmission === true);
    check("(L) does not carry the generic gateWorktreeDirty shape", r1.ok && r1.value.gateWorktreeDirty === undefined);
    check("(L) reason text names the worktree being gone", r1.ok && /no longer exists/.test(r1.value.reason ?? ""));
    check("(L) the fake gate command was NEVER spawned — refused before captureGatedTip's own spawn", gateCalls === 0);
    check("(L) main HEAD is completely unchanged (this leg never moves it)", git(repo, "rev-parse HEAD") === mainHeadBefore);
    check("(L) branch ref still exists (untouched)", git(repo, `branch --list ${branch}`) !== "");
    check("(L) task column unchanged (still in_progress)", db.getTask(taskId)?.columnKey === "in_progress");
    const rejected = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "worktree_missing_at_admission");
    check("(L) a merge_rejected event is recorded with the named reason", rejected.length === 1);
  }

  // ── (M) card 89bc3b86 round 2, finding 1 (MAJOR), the heldStamp leg — same hold-then-remove technique
  //        as (I)/(J), but `orchestration.mergeGate:"off"` (WITH a gateCommand still configured, so `gate`
  //        stays truthy and the `if (gate)` block — and its own inert-skip/heldStamp logic — is still
  //        entered; a project with NO gateCommand at all never reaches `if (gate)`, confirmed by a direct
  //        repro) makes `gateDisabled` true, routing into the gate-off/interval-skip `heldStamp` check
  //        instead of `captureGatedTip`. ──────────────────────────────────────────────────────────────────
  {
    const sfx = `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const projId = `wtglu-proj-${sfx}`, agentId = `wtglu-agent-${sfx}`, taskId = `wtglu-task-${sfx}`;
    const mgrId = `wtglu-mgr-${sfx}`, workerId = `wtglu-wkr-${sfx}`;
    const repo = path.join(os.tmpdir(), `loom-wtglu-repo-${sfx}`);
    makeInertCapableRepo(repo);
    const db = new Db();
    dbs.push(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      reapWorktreeProcesses: async () => ({ killedPids: [] }), gitOpMs: 5_000, syncAttachBudgetMs: 60_000,
    });

    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    // Docs-only — the gate-off `heldStamp` check this scenario targets is ONLY reached via `inertSkip`.
    mkdirp(path.join(worktreePath, "docs"));
    fs.writeFileSync(path.join(worktreePath, "docs", "note.md"), "notes\n");
    commitAll(worktreePath, "docs: add note", GIT_ID);
    const mainHeadBefore = git(repo, "rev-parse HEAD");

    // gateCommand CONFIGURED (so `gate` stays truthy — `if (gate)` is still entered) but
    // orchestration.mergeGate:"off" makes gateDisabled:true — the combination that routes into the
    // heldStamp check instead of captureGatedTip.
    db.insertProject({ id: projId, name: "WTGLU-M", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE, mergeGate: "off" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "WTGLU-M-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    const releaseTestHold = await sessions.gateSemaphore.acquireRepoGuardOnly({
      repoPath: repo, projectId: projId, sessionId: "test-holder", taskId: null, branch: null, opId: "test-holder-op-m",
    });

    const pConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId);
    const queued = await waitUntilRepoGuardQueued(sessions, projId, repo, 60000);
    check("(M) the confirm genuinely reached its own repo-guard-only wait before we release our hold", queued);

    fs.rmSync(worktreePath, { recursive: true, force: true });
    releaseTestHold();
    const r1 = await pConfirm;

    check("(M) settles ok:true (the refusal is a RESULT, not a crash/mislabel)", r1.settled === true && r1.ok === true);
    check("(M) merged:false, named reason worktreeMissingAtAdmission:true (NOT the generic gate_worktree_dirty mislabel)", r1.ok && r1.value.merged === false && r1.value.worktreeMissingAtAdmission === true);
    check("(M) does not carry the generic gateWorktreeDirty shape", r1.ok && r1.value.gateWorktreeDirty === undefined);
    check("(M) reason text names the worktree being gone", r1.ok && /no longer exists/.test(r1.value.reason ?? ""));
    check("(M) main HEAD is completely unchanged", git(repo, "rev-parse HEAD") === mainHeadBefore);
    check("(M) branch ref still exists (untouched)", git(repo, `branch --list ${branch}`) !== "");
    check("(M) task column unchanged (still in_progress)", db.getTask(taskId)?.columnKey === "in_progress");
    const rejected = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "worktree_missing_at_admission");
    check("(M) a merge_rejected event is recorded with the named reason", rejected.length === 1);
  }

  // ── (O) card ae1a53ac finding 4 — the FIRST pre-gate union-merge (no gate-queue wait at all — this is
  //        the EARLIEST of the four `mergeMainIntoWorktree` call sites) never checked `union.worktreeMissing`
  //        at all, falling through into the generic union_merge_failed rejection with the raw
  //        GitConstructError text. Seam-driven via the EXISTING `unionMergeGitFactory` test seam — the very
  //        FIRST construction attempt itself vanishes the real worktree directory before throwing (no
  //        sibling-commit side effect needed here, unlike (H): this is the FIRST union-merge call, never
  //        the later admission-time re-union). ──────────────────────────────────────────────────────────
  {
    const sfx = `o-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
    const parkedPath = `${worktreePath}.parked-o`;
    registerForCleanup(parkedPath);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "feature work\n");
    commitAll(worktreePath, "feat: add feature", GIT_ID);

    const unionMergeGitFactory = (p, ms) => {
      if (p !== worktreePath) return canonicalGit(p, ms);
      // The very first (and in this scenario, only) construction: a genuine, real vanish — same
      // rename-away technique as (H), just on the FIRST attempt instead of the second.
      fs.renameSync(worktreePath, parkedPath);
      throw new Error("Cannot use simple-git on a directory that does not exist (fault-injected, card ae1a53ac test)");
    };

    const db = new Db();
    dbs.push(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      reapWorktreeProcesses: async () => ({ killedPids: [] }), gitOpMs: 5_000, syncAttachBudgetMs: 60_000,
      unionMergeGitFactory,
    });
    db.insertProject({ id: projId, name: "WTGLU-O", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "WTGLU-O-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
    check("(O) settles ok:true (the refusal is a RESULT, not a crash/mislabel)", r1.settled === true && r1.ok === true);
    check("(O) merged:false, worktreeMissingAtAdmission:true (NOT the generic union_merge_failed mislabel)", r1.ok && r1.value.merged === false && r1.value.worktreeMissingAtAdmission === true);
    check("(O) reason is the SAME fixed string, never the raw GitConstructError text", r1.ok && r1.value.reason === "the worktree no longer exists");
    check("(O) task column unchanged (still in_progress)", db.getTask(taskId)?.columnKey === "in_progress");
    const rejectedO = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "worktree_missing_at_admission");
    check("(O) a merge_rejected event is recorded with the named reason", rejectedO.length === 1);
    const oldStyleO = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_rejected" && (e.detail?.reason === "union_merge_failed" || e.detail?.reason === "union_conflict"));
    check("(O) never recorded the OLD generic union_merge_failed/union_conflict reason", oldStyleO.length === 0);
  }

  // ── (P) card ae1a53ac finding 1 — the OVER-BROAD-DIRECTION test gap, `captureGatedTip`'s own leg: its
  //        `!fs.existsSync(worktreePath)` disambiguation (89bc3b86 round 2) routes a readable-but-present
  //        failure through the ordinary gateWorktreeDirty refusal — but nothing in this file ever exercised
  //        that leg, only (L)'s directory-genuinely-gone leg. Same hold-then-remove technique as (L), but
  //        removes only the worktree's own `.git` FILE (a `git worktree add` worktree's `.git` is a file,
  //        not a directory) — the directory itself stays on disk throughout, so
  //        `fs.existsSync(worktreePath)` reads true the whole time; `computeWorktreeGateStamp` still can't
  //        read HEAD (no gitdir pointer), giving `head:null` with the directory present. ──────────────────
  {
    const sfx = `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const projId = `wtglu-proj-${sfx}`, agentId = `wtglu-agent-${sfx}`, taskId = `wtglu-task-${sfx}`;
    const mgrId = `wtglu-mgr-${sfx}`, workerId = `wtglu-wkr-${sfx}`;
    const repo = path.join(os.tmpdir(), `loom-wtglu-repo-${sfx}`);
    makeInertCapableRepo(repo);
    const db = new Db();
    dbs.push(db);
    let gateCalls = 0;
    const fakeGate = async () => { gateCalls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      reapWorktreeProcesses: async () => ({ killedPids: [] }), gitOpMs: 5_000, syncAttachBudgetMs: 60_000,
      runGate: fakeGate,
    });

    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    // A REAL (non-docs) change — same reasoning as (L): this must take the full runExclusive admission
    // path, never the inert-skip's own acquireRepoGuardOnly.
    mkdirp(path.join(worktreePath, "src"));
    fs.writeFileSync(path.join(worktreePath, "src", "feat.ts"), "export const feat = true;\n");
    commitAll(worktreePath, "feat: add feature", GIT_ID);
    const mainHeadBefore = git(repo, "rev-parse HEAD");

    db.insertProject({ id: projId, name: "WTGLU-P", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "WTGLU-P-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    const releaseTestHold = await sessions.gateSemaphore.acquireRepoGuardOnly({
      repoPath: repo, projectId: projId, sessionId: "test-holder", taskId: null, branch: null, opId: "test-holder-op-p",
    });

    const pConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId);
    const queuedP = await sharedWaitUntil(() => sessions.gateQueueForManager(projId).queued.some((e) => e.gateType === "merge"), { timeoutMs: 60000, intervalMs: 10, label: "(P) confirm genuinely queued behind the held repo guard" });
    check("(P) the confirm genuinely reached the real gate-admission queue, blocked by the held repo guard", queuedP);

    // While held: remove ONLY the worktree's own `.git` file — the directory itself stays on disk.
    const gitFilePathP = path.join(worktreePath, ".git");
    check("(P) PRECONDITION: .git is a file (a worktree pointer), not a directory", fs.statSync(gitFilePathP).isFile());
    fs.rmSync(gitFilePathP, { force: true });
    releaseTestHold();
    const r1 = await pConfirm;

    check("(P) PRECONDITION held: the worktree directory itself genuinely still exists", fs.existsSync(worktreePath));
    check("(P) settles ok:true (the refusal is a RESULT, not a crash/mislabel)", r1.settled === true && r1.ok === true);
    check("(P) merged:false, the ORDINARY gateWorktreeDirty refusal (directory present, stamp unreadable)", r1.ok && r1.value.merged === false && r1.value.gateWorktreeDirty !== undefined);
    check("(P) does NOT carry worktreeMissingAtAdmission — the directory never vanished, only its gitdir pointer did", r1.ok && r1.value.worktreeMissingAtAdmission === undefined);
    check("(P) the fake gate command was NEVER spawned — refused before the gate's own spawn", gateCalls === 0);
    check("(P) main HEAD is completely unchanged", git(repo, "rev-parse HEAD") === mainHeadBefore);
    check("(P) branch ref still exists (untouched)", git(repo, `branch --list ${branch}`) !== "");
    check("(P) task column unchanged (still in_progress)", db.getTask(taskId)?.columnKey === "in_progress");
    const rejectedP = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "gate_worktree_dirty");
    check("(P) a merge_rejected event is recorded with the gate_worktree_dirty reason (never worktree_missing_at_admission)", rejectedP.length === 1);
  }

  // ── (Q) card ae1a53ac finding 1 — the OVER-BROAD-DIRECTION test gap, the `heldStamp` leg (mirrors (P)
  //        for `captureGatedTip`). Same hold-then-remove technique as (M), but removes only the worktree's
  //        own `.git` file — the directory stays on disk, so `fs.existsSync(worktreePath)` stays true and
  //        this must stay the ordinary gateWorktreeDirty refusal, never worktreeMissingAtAdmission. ───────
  {
    const sfx = `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const projId = `wtglu-proj-${sfx}`, agentId = `wtglu-agent-${sfx}`, taskId = `wtglu-task-${sfx}`;
    const mgrId = `wtglu-mgr-${sfx}`, workerId = `wtglu-wkr-${sfx}`;
    const repo = path.join(os.tmpdir(), `loom-wtglu-repo-${sfx}`);
    makeInertCapableRepo(repo);
    const db = new Db();
    dbs.push(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      reapWorktreeProcesses: async () => ({ killedPids: [] }), gitOpMs: 5_000, syncAttachBudgetMs: 60_000,
    });

    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    mkdirp(path.join(worktreePath, "docs"));
    fs.writeFileSync(path.join(worktreePath, "docs", "note.md"), "notes\n");
    commitAll(worktreePath, "docs: add note", GIT_ID);
    const mainHeadBefore = git(repo, "rev-parse HEAD");

    db.insertProject({ id: projId, name: "WTGLU-Q", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE, mergeGate: "off" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "WTGLU-Q-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    const releaseTestHold = await sessions.gateSemaphore.acquireRepoGuardOnly({
      repoPath: repo, projectId: projId, sessionId: "test-holder", taskId: null, branch: null, opId: "test-holder-op-q",
    });

    const pConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId);
    const queuedQ = await waitUntilRepoGuardQueued(sessions, projId, repo, 60000);
    check("(Q) the confirm genuinely reached its own repo-guard-only wait before we release our hold", queuedQ);

    const gitFilePathQ = path.join(worktreePath, ".git");
    check("(Q) PRECONDITION: .git is a file (a worktree pointer), not a directory", fs.statSync(gitFilePathQ).isFile());
    fs.rmSync(gitFilePathQ, { force: true });
    releaseTestHold();
    const r1 = await pConfirm;

    check("(Q) PRECONDITION held: the worktree directory itself genuinely still exists", fs.existsSync(worktreePath));
    check("(Q) settles ok:true (the refusal is a RESULT, not a crash/mislabel)", r1.settled === true && r1.ok === true);
    check("(Q) merged:false, the ORDINARY gateWorktreeDirty refusal (directory present, stamp unreadable)", r1.ok && r1.value.merged === false && r1.value.gateWorktreeDirty !== undefined);
    check("(Q) does NOT carry worktreeMissingAtAdmission", r1.ok && r1.value.worktreeMissingAtAdmission === undefined);
    check("(Q) main HEAD is completely unchanged", git(repo, "rev-parse HEAD") === mainHeadBefore);
    check("(Q) branch ref still exists (untouched)", git(repo, `branch --list ${branch}`) !== "");
    check("(Q) task column unchanged (still in_progress)", db.getTask(taskId)?.columnKey === "in_progress");
    const rejectedQ = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "gate_worktree_dirty");
    check("(Q) a merge_rejected event is recorded with the gate_worktree_dirty reason (never worktree_missing_at_admission)", rejectedQ.length === 1);
  }

  // ── (R) card ae1a53ac finding 2 — the ungated-landing PRE-STAMP's own `preStamp.head === null` check
  //        had NO `fs.existsSync` disambiguation at all (unlike its `heldStamp` twin, (Q)/(M) above): ANY
  //        unreadable stamp here — missing-directory or not — fell into the ordinary gateWorktreeDirty
  //        refusal. Two legs, same fixture shape: (R1) the worktree directory is genuinely gone — must now
  //        route to refuseWorktreeMissingAtAdmission; (R2) only the `.git` pointer is gone (the directory
  //        itself stays on disk) — must still go to the ordinary gateWorktreeDirty refusal, unchanged.
  //        This pre-stamp read runs BEFORE `acquireRepoGuardOnly` is ever taken, so there's no gate-queue
  //        wait to race — both legs vanish the worktree as a side effect of the pre-gate union-merge's own
  //        cheap no-write merge-base probe (the `unionMergeGitFactory` seam), deterministically, right
  //        before the preStamp read a moment later. ─────────────────────────────────────────────────────
  {
    async function buildR(label, { removeWhole }) {
      const sfx = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const projId = `wtglu-proj-${sfx}`, agentId = `wtglu-agent-${sfx}`, taskId = `wtglu-task-${sfx}`;
      const mgrId = `wtglu-mgr-${sfx}`, workerId = `wtglu-wkr-${sfx}`;
      const repo = path.join(os.tmpdir(), `loom-wtglu-repo-${sfx}`);
      makeInertCapableRepo(repo);
      const db = new Db();
      dbs.push(db);

      const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
      registerForCleanup(worktreePath);
      mkdirp(path.join(worktreePath, "docs"));
      fs.writeFileSync(path.join(worktreePath, "docs", `note-${label}.md`), "notes\n");
      commitAll(worktreePath, "docs: add note", GIT_ID);
      const mainHeadBefore = git(repo, "rev-parse HEAD");

      let sideEffectDone = false;
      const unionMergeGitFactory = (p, ms) => {
        if (p !== worktreePath) return canonicalGit(p, ms);
        const real = canonicalGit(p, ms);
        return {
          raw: async (args) => {
            const result = await real.raw(args);
            if (!sideEffectDone && args[0] === "merge-base") {
              sideEffectDone = true;
              // The union-merge's own cheap no-write probe just succeeded (main is already an ancestor);
              // vanish the worktree right after, before `mergeMainIntoWorktree` returns — simulating
              // "gone between the union-merge and the preStamp read a moment later" (this scenario), not
              // "gone during the union-merge's own probe itself" (finding 4, scenario (O), above).
              if (removeWhole) fs.rmSync(worktreePath, { recursive: true, force: true });
              else fs.rmSync(path.join(worktreePath, ".git"), { force: true });
            }
            return result;
          },
        };
      };

      // Card ae1a53ac (round 2 nit): counts whether `runUngatedLandingCheck`'s own injected gate ever
      // actually spawned — both legs here must refuse BEFORE this check ever runs at all (the pre-stamp
      // read sits strictly before it), so this must stay 0 on both.
      let landingCheckGateCalls = 0;
      const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
        reapWorktreeProcesses: async () => ({ killedPids: [] }), gitOpMs: 5_000, syncAttachBudgetMs: 60_000,
        unionMergeGitFactory,
        runGate: async () => { landingCheckGateCalls++; return { passed: true, steps: [] }; },
      });

      // mergeGateInterval (not "never") so skipReason is "gate-interval" — the ONLY skip reason this
      // check is scoped to (see ungated-landing-check.mjs's own negative control (4)); ungatedLandingCheckCommand
      // configured so the pre-stamp block is actually entered at all.
      db.insertProject({ id: projId, name: `WTGLU-${label.toUpperCase()}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE, mergeGate: "off", mergeGateInterval: 3, ungatedLandingCheckCommand: PASS_GATE } }, createdAt: now, archivedAt: null });
      db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
      db.insertTask({ id: taskId, projectId: projId, title: `WTGLU-${label.toUpperCase()}-TASK`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

      const stateBefore = JSON.stringify(db.getMergeGateState(projId));
      return { db, sessions, repo, projId, taskId, mgrId, workerId, worktreePath, branch, mainHeadBefore, stateBefore, gateCalls: () => landingCheckGateCalls };
    }

    // (R1) worktree genuinely gone right after the union-merge's own probe, before the pre-stamp read.
    {
      const f = await buildR("r1", { removeWhole: true });
      const r1 = await f.sessions.confirmWorkerMergeTracked(f.mgrId, f.workerId);
      check("(R1) settles ok:true", r1.settled === true && r1.ok === true);
      check("(R1) merged:false, worktreeMissingAtAdmission:true (NOT the generic gate_worktree_dirty mislabel)", r1.ok && r1.value.merged === false && r1.value.worktreeMissingAtAdmission === true);
      check("(R1) does not carry the generic gateWorktreeDirty shape", r1.ok && r1.value.gateWorktreeDirty === undefined);
      check("(R1) reason text names the worktree being gone", r1.ok && /no longer exists/.test(r1.value.reason ?? ""));
      check("(R1) task column unchanged (still in_progress)", f.db.getTask(f.taskId)?.columnKey === "in_progress");
      const rejectedR1 = f.db.listEventsForWorker(f.workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "worktree_missing_at_admission");
      check("(R1) a merge_rejected event is recorded with the named reason", rejectedR1.length === 1);
      check("(R1) the landing-check command NEVER ran (refused before the pre-stamp read's own caller reaches it)", f.gateCalls() === 0);
      check("(R1) the merge-gate interval state (counter, gateOwed, lastPassSha, ring) is COMPLETELY UNTOUCHED", JSON.stringify(f.db.getMergeGateState(f.projId)) === f.stateBefore);
    }

    // (R2) only `.git` gone — the directory itself stays on disk; must stay the ordinary dirty refusal.
    {
      const f = await buildR("r2", { removeWhole: false });
      const r1 = await f.sessions.confirmWorkerMergeTracked(f.mgrId, f.workerId);
      check("(R2) PRECONDITION: the worktree directory itself still exists", fs.existsSync(f.worktreePath));
      check("(R2) settles ok:true", r1.settled === true && r1.ok === true);
      check("(R2) merged:false, the ORDINARY gateWorktreeDirty refusal", r1.ok && r1.value.merged === false && r1.value.gateWorktreeDirty !== undefined);
      check("(R2) does NOT carry worktreeMissingAtAdmission", r1.ok && r1.value.worktreeMissingAtAdmission === undefined);
      check("(R2) main HEAD unchanged", git(f.repo, "rev-parse HEAD") === f.mainHeadBefore);
      const rejectedR2 = f.db.listEventsForWorker(f.workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "gate_worktree_dirty");
      check("(R2) a merge_rejected event is recorded with the gate_worktree_dirty reason", rejectedR2.length === 1);
      check("(R2) the landing-check command NEVER ran (refused before the pre-stamp read's own caller reaches it)", f.gateCalls() === 0);
      check("(R2) the merge-gate interval state (counter, gateOwed, lastPassSha, ring) is COMPLETELY UNTOUCHED", JSON.stringify(f.db.getMergeGateState(f.projId)) === f.stateBefore);
    }
  }
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a missing worktree + an unconfirmed already-landed lookup refuses cleanly (named reason, nothing touched, a recorded event, never cached) instead of crashing uncaught; the worktree-present path is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
