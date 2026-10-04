import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9f5ae011 — mergeBranchLocked's own squash/commit-step cleanup (`resetOrSkip`) can itself be
// CONFIRMED kill-timed-out, leaving the canonical repo genuinely staged-dirty from THIS merge's own
// squash. `mergeBranch`'s return carries a structural `transient`/`residuePossible` signal for this shape,
// threaded through `confirmWorkerMergeTracked`/`classifyOutcome` as `soloMergeTransient`, classified
// `"solo-merge-transient"` and added to `NEVER_CACHED_OUTCOMES`.
//
// ⚠️ ROUND 2 CORRECTION (manager ruling, CR 905669e4 of 82c7038d): round 1's own header here claimed half
// (b) below proved a pre-fix CACHING defect. It did not — `squashRefusedResult` → `"squash-refused"` is
// ALREADY in `NEVER_CACHED_OUTCOMES` (@decision fb525c31), and pre-fix this shape fell through to exactly
// that generic bucket (see `docs/decisions/9f5ae011-*.md`'s round-2 section for the full trace). The REAL
// delta this card makes is the CLASSIFICATION (a more specific, better-worded never-cached outcome than
// the generic squash-refused bucket) and the RETRY mechanism, not caching. So, relabeled:
//  (a) is NOT "proof of a historical residue bug" — it's a check that THIS TEST'S OWN fault injection
//      (the fake factory's throw) actually left the real squash's staged content sitting in the index,
//      i.e. that the fixture behaves as claimed, before trusting anything built on top of it.
//  (b) is NOT "proof a cached verdict used to replay" — it's a REGRESSION GUARD on `"solo-merge-transient"`
//      staying in `NEVER_CACHED_OUTCOMES` going forward (a future edit that drops it from that set would
//      otherwise go unnoticed until a real incident).
//
// This file proves the fix end-to-end through the REAL `confirmWorkerMergeTracked` flow, via a REAL-git-
// backed passthrough `soloMergeGitFactory` (same shape as merge-confirm-verdict-cache-quarantine.mjs's own
// solo-squash scenario) that intercepts the squash's own "commit" call (always fails, confirmed-kill-
// shaped) and its cleanup's "reset --hard" call (behavior varies per scenario below) — no real hung hook
// or host load needed.
//
// ROUND 2 ALSO adds the retry-GATING fix's own test coverage (manager-approved Option B): the retry now
// fires ONLY on a TYPED confirmed-kill marker (`treeDeathConfirmed`, never "any non-quarantine error"),
// and ONLY after safely removing a leaked `.git/index.lock` the confirmed kill left behind
// (`removeLeakedCanonicalIndexLockIfSafe`'s own guards: confirmed-kill, fresh mtime, mutex held by
// construction). Five scenarios below, using a REAL `.git/index.lock` file on disk (never a real kill):
//  [POSITIVE]      confirmed-kill + a FRESH leaked lock -> lock removed, retry fires, retry succeeds for
//                  real (genuine recovery: no residue at all, since the real reset actually ran clean).
//  [NO-LOCK]       confirmed-kill + NO lock ever left behind -> nothing to remove, retried anyway, retry
//                  succeeds for real (round 3 ruling: a confirmed kill with no lock MAY retry once).
//  [NO-MARKER]     an UNRELATED, non-kill-shaped reset failure -> never retried, lock (if any) untouched.
//  [OLD-MTIME]     confirmed-kill + a lock that PREDATES this attempt -> guard refuses, never retried,
//                  lock untouched, result still classifies `soloMergeTransient:true` (this IS the shape
//                  half (b) above guards).
//  [UNCONFIRMED]   an UNCONFIRMED kill -> quarantined, never retried, lock untouched (the removal helper
//                  is never even reached on this path).
//  [ALWAYS-CONFIRMED] (round 4) every attempt, including the retry, throws a confirmed-kill, no lock ever
//                  written -> retried exactly once and never loops (regression guard on the `!isRetry`
//                  gate in `resetOrSkip`'s retry condition).
// Also discriminates the `GIT_OP_TIMEOUT_MS` floor (CR minor): each scenario configures a `gitOpMs` BELOW
// that floor and asserts every reset call actually received the FLOORED value, not the small configured
// one — without this, the floor could be deleted and this file would never notice.
//
// ROUND 3 note: [POSITIVE]'s lock now also crosses `removeLeakedCanonicalIndexLockIfSafe`'s new persistence
// check (a real, short — `LOCK_PERSISTENCE_CHECK_DELAY_MS` — witnessed wait before removal), adding that
// much wall-clock to this scenario; nothing else about it changes. The new upper-bound guard (a lock must
// not postdate the kill's own confirmation) and the persistence check's unstable/disappeared branches are
// NOT covered here — they need a lock whose mtime is precisely timed relative to `killConfirmedAt`, which
// this black-box, real-git-backed fixture cannot control deterministically.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-verdict-cache-solo-merge-transient.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcvcsmt-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, GIT_OP_TIMEOUT_MS } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcvcsmt@loom -c user.name=mcvcsmt";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
// Below GIT_OP_TIMEOUT_MS (15000ms) and above GIT_TIMEOUT_FLOOR_MS (1000ms, sessions/service.ts) — if
// resetOrSkip's own floor were ever deleted, the fake factory would observe THIS value instead.
const SMALL_GIT_OP_MS = 2_000;

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcvcsmt\n");
  execSync(`git init -q && git config user.email mcvcsmt@loom && git config user.name mcvcsmt`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function setupWorkerProject(sfx, reposDir) {
  registerForCleanup(reposDir);
  const db = new Db();
  const mgrId = `mcvcsmt-mgr-${sfx}`, projId = `mcvcsmt-p-${sfx}`, taskId = `mcvcsmt-t-${sfx}`, workerId = `mcvcsmt-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  const config = { orchestration: { gateCommand: "pnpm gate" } };
  db.insertProject({ id: projId, name: "MCVCSMT", repoPath: repo, vaultPath: repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcvcsmt-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcvcsmt-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcvcsmt-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCVCSMT-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcvcsmt-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { db, mgrId, projId, taskId, workerId, repo, worktreePath, branch };
}

/** `resetHandler({repoPath, attemptNumber})` decides what the FAKE factory's "reset --hard" call does on
 *  each attempt (1 = original, 2 = retry, if a retry ever happens) — everything else (the squash's own
 *  "commit" call, and any other raw call) is REAL-git-backed passthrough or the fixed confirmed-kill-
 *  shaped commit failure that drives every scenario into `resetOrSkip` in the first place. */
function makeScenarioFactory(resetHandler, state) {
  return (repoPath, blockTimeoutMs) => ({
    raw: async (args) => {
      const rawArgs = Array.isArray(args[0]) ? args[0] : args;
      if (rawArgs[0] === "commit") {
        state.commitCalls++;
        throw new Error("git commit (canonical, squash-merge) exceeded 500ms (git child killed): Abort signal received");
      }
      if (rawArgs[0] === "reset" && rawArgs[1] === "--hard") {
        state.resetCalls++;
        state.resetTimeoutsSeen.push(blockTimeoutMs);
        return resetHandler({ repoPath, attemptNumber: state.resetCalls });
      }
      return execFileSync("git", rawArgs, { cwd: repoPath, encoding: "utf8" });
    },
  });
}

async function runScenario(name, resetHandler) {
  const sfx = `t-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcvcsmt-${sfx}`);
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfx, reposDir);
  const state = { commitCalls: 0, resetCalls: 0, resetTimeoutsSeen: [] };
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    gitOpMs: SMALL_GIT_OP_MS,
    runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
    soloMergeGitFactory: makeScenarioFactory(resetHandler, state),
  });
  const lockPath = path.join(repo, ".git", "index.lock");
  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  return { db, sessions, mgrId, workerId, repo, lockPath, state, r1, getGateCalls: () => gateCalls };
}

const dbs = [];
const CONFIRMED = "git reset --hard (canonical, commit-failure cleanup) exceeded 500ms (git child killed): Abort signal received";
const UNCONFIRMED = "git reset --hard (canonical, commit-failure cleanup) exceeded 500ms (git child killed): Abort signal received (process tree not fully confirmed dead)";

// ===== [POSITIVE] confirmed-kill + a FRESH leaked lock -> removed, retried, retry succeeds for real =====
{
  const { db, repo, lockPath, state, r1 } = await runScenario("positive", async ({ repoPath, attemptNumber }) => {
    if (attemptNumber === 1) {
      fs.writeFileSync(path.join(repoPath, ".git", "index.lock"), ""); // the confirmed-killed reset's own leaked lock
      throw new Error(CONFIRMED);
    }
    return execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repoPath, encoding: "utf8" }); // real retry
  });
  dbs.push(db);
  check("[positive] settled, not merged (the commit call itself still fails — only the cleanup recovers)", r1.settled === true && r1.ok && r1.value.merged === false);
  check("[positive] NOT quarantined", r1.ok && r1.value.quarantined !== true);
  check("[positive] NOT soloMergeTransient — the cleanup genuinely succeeded this time, no residue to flag", r1.ok && r1.value.soloMergeTransient !== true);
  check("[positive] the cleanup reset was retried exactly once (two attempts total)", state.resetCalls === 2);
  check("[positive] both reset attempts received the FLOORED timeout, not the small configured gitOpMs", state.resetTimeoutsSeen.length === 2 && state.resetTimeoutsSeen.every((t) => t === GIT_OP_TIMEOUT_MS));
  check("[positive] the leaked lock is actually gone from disk", !fs.existsSync(lockPath));
  const stagedAfter = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" }).trim();
  check("[positive] GENUINE RECOVERY: the canonical repo's index is actually clean — the real retried reset ran for real", stagedAfter === "");
  check("[positive] reason does not claim residue or a leaked lock (there is none)", r1.ok && !/residue|index\.lock/i.test(r1.value.reason ?? ""));
}

// ===== [NO-LOCK] confirmed-kill + NO lock ever left behind -> nothing to remove, retried anyway, recovers
// (round 3 ruling, card 9f5ae011: a confirmed kill with no lock present MAY retry once — nothing to
// remove, and the retried reset takes its own lock) =====
{
  const { db, repo, lockPath, state, r1 } = await runScenario("no-lock", async ({ repoPath, attemptNumber }) => {
    if (attemptNumber === 1) {
      throw new Error(CONFIRMED); // confirmed-kill-shaped, but this attempt never wrote a lock at all
    }
    return execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repoPath, encoding: "utf8" }); // real retry
  });
  dbs.push(db);
  check("[no-lock] settled, not merged", r1.settled === true && r1.ok && r1.value.merged === false);
  check("[no-lock] NOT quarantined", r1.ok && r1.value.quarantined !== true);
  check("[no-lock] NOT soloMergeTransient — nothing to remove, so the retry fires anyway and genuinely recovers", r1.ok && r1.value.soloMergeTransient !== true);
  check("[no-lock] the cleanup reset was retried exactly once (two attempts total) even though no lock was ever present", state.resetCalls === 2);
  check("[no-lock] still no lock on disk", !fs.existsSync(lockPath));
  const stagedAfter = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" }).trim();
  check("[no-lock] GENUINE RECOVERY: the canonical repo's index is actually clean", stagedAfter === "");
}

// ===== [NO-MARKER] an UNRELATED, non-kill-shaped reset failure -> never retried, any lock untouched =====
{
  const { db, lockPath, state, r1 } = await runScenario("no-marker", async ({ repoPath }) => {
    fs.writeFileSync(path.join(repoPath, ".git", "index.lock"), ""); // an unrelated lock just happens to be sitting there
    throw new Error("fatal: unable to write new index file"); // NOT confirmed-kill-shaped, NOT unconfirmed-shaped
  });
  dbs.push(db);
  check("[no-marker] settled, not merged", r1.settled === true && r1.ok && r1.value.merged === false);
  check("[no-marker] NOT quarantined", r1.ok && r1.value.quarantined !== true);
  check("[no-marker] NOT soloMergeTransient — an unrelated failure is never the confirmed-kill-residue shape", r1.ok && r1.value.soloMergeTransient !== true);
  check("[no-marker] never retried — the OLD over-broad gate ('any non-quarantine error') would have retried this; the fix must not", state.resetCalls === 1);
  check("[no-marker] the lock is left completely untouched — the removal guard is never even reached on this path", fs.existsSync(lockPath));
}

// ===== [OLD-MTIME] confirmed-kill + a lock PREDATING this attempt -> guard refuses, never retried =====
{
  const { db, sessions, mgrId, workerId, repo, lockPath, state, r1, getGateCalls } = await runScenario("old-mtime", async ({ repoPath }) => {
    const lp = path.join(repoPath, ".git", "index.lock");
    if (!fs.existsSync(lp)) {
      fs.writeFileSync(lp, "");
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lp, old, old); // predates attemptStartedAt — must never be removed
    }
    throw new Error(CONFIRMED); // same confirmed-kill shape as [positive] — only the lock's age differs
  });
  dbs.push(db);
  check("[old-mtime] settled, not merged", r1.settled === true && r1.ok && r1.value.merged === false);
  check("[old-mtime] NOT quarantined — a confirmed kill of our own cleanup is never a quarantine", r1.ok && r1.value.quarantined !== true);
  check("[old-mtime] carries soloMergeTransient:true — a genuine confirmed kill the guard correctly declined to retry into", r1.ok && r1.value.soloMergeTransient === true);
  check("[old-mtime] never retried — retrying into a lock that predates this attempt would just fail identically", state.resetCalls === 1);
  check("[old-mtime] the single reset attempt still received the FLOORED timeout", state.resetTimeoutsSeen.length === 1 && state.resetTimeoutsSeen[0] === GIT_OP_TIMEOUT_MS);
  check("[old-mtime] the stale lock is left untouched", fs.existsSync(lockPath));
  check("[old-mtime] the give-up text names the leaked .git/index.lock as a likely cause", r1.ok && /index\.lock/.test(r1.value.reason ?? ""));
  check("[old-mtime] the give-up text says later merges refuse at the staged-dirt check until a human cleans up", r1.ok && /staged-dirt/.test(r1.value.reason ?? ""));
  check("[old-mtime] detailText names the EXACT check an operator needs to run", /git diff --cached/.test(r1.value.detailText ?? ""));
  check("[old-mtime] detailText does NOT claim nothing changed — residue is possible for this shape", !/nothing was changed/i.test(r1.value.detailText ?? ""));

  // REGRESSION GUARD (relabeled half (b), round 2): `"solo-merge-transient"` must stay in
  // `NEVER_CACHED_OUTCOMES` — a plain re-confirm at the SAME branch head must genuinely re-attempt (the
  // gate re-runs), never replay the stale verdict from the until-superseded cache. The residue op1 left is
  // OUR OWN squash's (never unknown pre-existing dirt), so clear it for real FIRST — exactly as the
  // result's own guidance instructs a human — or the entry-time staged-dirt check would refuse admission
  // before the gate ever got a chance to re-run, which would prove nothing about the cache. The scenario's
  // own resetHandler re-manufactures a fresh (but still artificially old-mtime'd) lock on this next call,
  // so the SAME honest transient failure is expected again — this is still a genuine re-attempt, not a hit.
  try { fs.rmSync(lockPath, { force: true }); } catch { /* best-effort — may already be gone */ }
  execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repo });
  const gateCallsBefore = getGateCalls();
  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("[old-mtime, re-confirm] NOT served from the until-superseded verdict cache", r2.cacheHit === undefined);
  check("[old-mtime, re-confirm] a REAL new gate run happened, not a replay", getGateCalls() === gateCallsBefore + 1);
  check("[old-mtime, re-confirm] still settles as the same honest transient failure (the scenario re-manufactures the same stale-lock shape)", r2.settled === true && r2.ok && r2.value.merged === false && r2.value.soloMergeTransient === true);
  // Final cleanup of the fixture's own residue, mirroring what a human would actually do.
  try { fs.rmSync(lockPath, { force: true }); } catch { /* best-effort fixture cleanup */ }
  execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repo });
}

// ===== [ALWAYS-CONFIRMED] every reset attempt — including the RETRY itself — throws CONFIRMED, and no
// lock is ever written. REGRESSION GUARD (round 4) for the `!isRetry` gate on `if (!isRetry &&
// treeDeathConfirmed(e))` in `resetOrSkip`: drop that gate and the retry's OWN confirmed-kill would ALSO
// match, re-entering the lock-removal-and-retry branch and looping instead of giving up after one retry.
// Capped at a small attempt count (not unbounded) so a reintroduced bug fails the `resetCalls === 2`
// assertion below instead of hanging the suite. =====
{
  const { db, lockPath, state, r1 } = await runScenario("always-confirmed", async ({ attemptNumber }) => {
    if (attemptNumber > 5) throw new Error("test-cap-exceeded — resetOrSkip retried more than once; the !isRetry gate may have regressed");
    throw new Error(CONFIRMED); // confirmed-kill-shaped on EVERY attempt; never writes a lock
  });
  dbs.push(db);
  check("[always-confirmed] settled, not merged", r1.settled === true && r1.ok && r1.value.merged === false);
  check("[always-confirmed] NOT quarantined — a confirmed kill of the cleanup (even on retry) is never a quarantine", r1.ok && r1.value.quarantined !== true);
  check("[always-confirmed] carries soloMergeTransient:true — the RETRY's own confirmed kill is also transient, not silently swallowed", r1.ok && r1.value.soloMergeTransient === true);
  check("[always-confirmed] retried EXACTLY ONCE (two attempts total) — never loops on a repeat confirmed-kill from the retry itself", state.resetCalls === 2);
  check("[always-confirmed] still no lock on disk (none was ever written)", !fs.existsSync(lockPath));
}

// ===== [UNCONFIRMED] an UNCONFIRMED kill -> quarantined, never retried, lock never touched =====
{
  const { db, lockPath, state, r1 } = await runScenario("unconfirmed", async ({ repoPath }) => {
    fs.writeFileSync(path.join(repoPath, ".git", "index.lock"), "");
    throw new Error(UNCONFIRMED);
  });
  dbs.push(db);
  check("[unconfirmed] settled, not merged", r1.settled === true && r1.ok && r1.value.merged === false);
  check("[unconfirmed] carries quarantined:true", r1.ok && r1.value.quarantined === true);
  check("[unconfirmed] NOT soloMergeTransient — quarantine and transient are mutually exclusive", r1.ok && r1.value.soloMergeTransient !== true);
  check("[unconfirmed] never retried — an unconfirmed kill must fail CLOSED, never race a possibly-still-alive child", state.resetCalls === 1);
  check("[unconfirmed] the lock is left completely untouched — the removal helper is never reached on this (quarantine) path", fs.existsSync(lockPath));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the solo-merge cleanup retry fires ONLY on a typed confirmed-kill marker and ONLY after " +
    "safely removing a leaked .git/index.lock (never on an unrelated failure, never on an unconfirmed kill, " +
    "never against a lock predating the attempt, and never loops when the RETRY itself is also confirmed-" +
    "killed); when it can, recovery is genuine (no residue at all); when it can't, the result truthfully " +
    "names the leaked lock and the staged-dirt refusal it causes, and is never served from the until-" +
    "superseded verdict cache."
  : `\n❌ ${failures} FAILURE(S).`);
for (const db of dbs) try { db.close(); } catch { /* best-effort */ }
process.exit(failures === 0 ? 0 : 1);
