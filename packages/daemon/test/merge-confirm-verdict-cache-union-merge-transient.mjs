import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8c3d6c04 — `classifyOutcome` had no branch for a union-merge failure's root cause: a TRANSIENT
// git-child condition (a confirmed-kill timeout, or an EAGAIN/EMFILE/ENFILE/EBUSY spawn error) fell through
// to the generic `outcome.value.merged ? "merged" : "rejected"` fallback exactly like a real content
// conflict does. "rejected" is NOT in `NEVER_CACHED_OUTCOMES`, so it WAS eligible for
// `retainVerdictUntilSuperseded` caching, gated only by `verdictIdentity` (branch head + main tip, resolved
// BEFORE the union-merge itself runs). When the union-merge fails WITHOUT moving the branch tip — exactly
// the shape of a transient failure that did not land — a re-confirm at the same identity would replay the
// stale rejection instead of genuinely re-attempting the merge.
//
// This file proves the fix end-to-end through the REAL `confirmWorkerMergeTracked` flow (not just
// `mergeMainIntoWorktree` in isolation — see union-merge-transient-classification.mjs for that unit-level
// proof): a FAKE `unionMergeGitFactory` (card 8c3d6c04 TEST SEAM) makes the pre-gate union-merge fail with a
// confirmed-kill-timeout-shaped error every time it's invoked, counting invocations so a re-call's behavior
// is observable directly (a cache hit makes the count stay flat; a real re-attempt bumps it) — independent
// of (and in addition to) the registry's own `cacheHit` field.
//
// ROUND 2 (same card, Code Review 47c5815f of 5045a6ed) adds two more scenarios: a worktree already dirty
// BEFORE the pre-gate union-merge (reuses the existing never-cached `gateWorktreeDirty` outcome, never
// `unionMergeTransient`), and the ADMISSION-TIME re-union's own threading (`AdmissionReunionFailedError`'s
// `transient` arg → `rejectAdmissionReunionFailure` → `unionMergeTransient` + honest cause text) via the
// real "main advances during the queue wait" seam `merge-gate-reuse-admission.mjs`'s scenario (O) uses, with
// a PROXYING factory (real `canonicalGit`, intercepted only on the admission-time reunion's own merge
// attempt) since that seam needs a real repo + gate semaphore a full hand-rolled fake can't drive. Also
// closes every `Db` it opens before exit (previously left for `beforeExit`/`exit`, which logged a harmless
// but noisy EBUSY on the temp `LOOM_HOME`'s sqlite file).
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-verdict-cache-union-merge-transient.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerForCleanup, mkdtempManaged } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcvcumt-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);
const { canonicalGit } = await import(pathToFileURL(path.join(distGitDir, "bounded.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcvcumt@loom -c user.name=mcvcumt";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcvcumt\n");
  execSync(`git init -q && git config user.email mcvcumt@loom && git config user.name mcvcumt`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function setupWorkerProject(sfx, reposDir, gateCommand = "pnpm gate") {
  registerForCleanup(reposDir);
  const db = new Db();
  const mgrId = `mcvcumt-mgr-${sfx}`, projId = `mcvcumt-p-${sfx}`, taskId = `mcvcumt-t-${sfx}`, workerId = `mcvcumt-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  const config = { orchestration: { gateCommand } };
  db.insertProject({ id: projId, name: "MCVCUMT", repoPath: repo, vaultPath: repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcvcumt-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcvcumt-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcvcumt-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCVCUMT-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcvcumt-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { db, mgrId, projId, taskId, workerId, repo, worktreePath, branch };
}

// A fake union-merge git factory: EVERY invocation of the actual merge call fails with a
// confirmed-kill-timeout-shaped error (never a real conflict) — counts how many times the merge itself was
// actually attempted (`state.mergeAttempts`), which is the direct, cache-independent observable this file
// uses to tell "replayed from cache" (count stays flat) apart from "genuinely re-attempted" (count rises).
function makeTransientUnionMergeFactory(state) {
  return (_repoPathArg, _ms) => ({
    async raw(args) {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === "rev-parse" && a.includes("HEAD") && !a.includes("-q")) return `${"b".repeat(40)}\n`;
      if (a[0] === "rev-parse" && a.includes("-q")) throw new Error("fatal: needed a single revision");
      if (a[0] === "merge-base") throw new Error("fake: no merge-base (never landed)");
      if (a[0] === "config") throw new Error("fake: no identity configured");
      // `includes`, not `a[0] ===`: computeWorktreeGateStamp's own status read is prefixed with
      // `-c core.quotePath=false`, unlike verifyWorktreeCleanAt's bare `status --porcelain ...`.
      if (a.includes("status")) return "";
      if (a[0] === "ls-files") return ""; // never conflicted
      if (a.includes("merge") && a.includes("--no-edit")) {
        state.mergeAttempts++;
        throw new Error("git merge main into worktree exceeded 50ms (hung git child?)");
      }
      if (a.includes("merge") && a.includes("--abort")) return "";
      throw new Error(`fake git: unhandled args ${JSON.stringify(a)}`);
    },
  });
}

const dbs = [];

{
  const sfx = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcvcumt-${sfx}`);
  const { db, mgrId, workerId } = await setupWorkerProject(sfx, reposDir);
  dbs.push(db);
  const state = { mergeAttempts: 0 };
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
    unionMergeGitFactory: makeTransientUnionMergeFactory(state),
  });

  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(op 1) settled, NOT merged, never reached the gate", r1.settled === true && r1.ok && r1.value.merged === false && gateCalls === 0);
  check("(op 1) reason is a union-merge failure (not a conflict)", r1.ok && /union merge failed|exceeded \d+ms/.test(r1.value.reason ?? "") && r1.value.quarantined !== true);
  check("(op 1) carries unionMergeTransient:true", r1.ok && r1.value.unionMergeTransient === true);
  // Round 2, item 2: this fake's merge call ALWAYS throws the same confirmed-kill-timeout-shaped error
  // (never recovers via abort), so `residueNote`/`residuePossible` is ALWAYS true here — the honest wording
  // must mention retrying/re-confirming WITHOUT ever claiming "nothing was changed" (staged content may be
  // sitting in the worktree). The companion unit test (union-merge-transient-classification.mjs) proves the
  // OTHER wording (the plain "nothing was changed" case, for a spawn-error-only transient with no residue).
  check("(op 1) detailText mentions re-confirming and retrying", r1.ok && /re-confirm/i.test(r1.value.detailText ?? "") && /retry/i.test(r1.value.detailText ?? ""));
  check("(op 1) detailText does NOT claim nothing changed — residue is possible for this shape", r1.ok && !/nothing was changed/i.test(r1.value.detailText ?? ""));
  check("(op 1) detailText names the possible leftover merge content", r1.ok && /partial, uncommitted merge content/.test(r1.value.detailText ?? ""));
  check("(op 1) the merge was genuinely attempted (plus the one internal retry mergeMainIntoWorktree performs)", state.mergeAttempts >= 1);
  const attemptsAfterOp1 = state.mergeAttempts;

  // THE REGRESSION THIS FILE EXISTS FOR: a plain re-call, same branch head (the failure never moved it) —
  // pre-fix this would classify as plain "rejected" (cacheable) and replay op 1's verdict with ZERO new
  // merge attempts. Post-fix it must classify "union-merge-transient" (NEVER_CACHED_OUTCOMES) and genuinely
  // re-attempt.
  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(op 2 — re-confirm) NOT served from the until-superseded verdict cache", r2.cacheHit === undefined);
  check("(op 2 — re-confirm) a REAL new merge attempt happened (count rose), not a replay", state.mergeAttempts > attemptsAfterOp1);
  check("(op 2 — re-confirm) still settles as the same honest transient failure (the fake factory never clears)", r2.settled === true && r2.ok && r2.value.merged === false && r2.value.unionMergeTransient === true);
}

// ── DIRTY WORKTREE (round 2, item 4), end-to-end: a worktree already dirty before the pre-gate union-merge
// reuses the EXISTING never-cached `gateWorktreeDirty`/"worktree-dirty" outcome, never `unionMergeTransient`.
// A REAL uncommitted change drives computeWorktreeGateStamp's dirt check for real (not faked).
function makeDirtyWorktreeFactory() {
  return (_p, _ms) => ({
    async raw(args) {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === "rev-parse" && a.includes("HEAD") && !a.includes("-q")) return `${"b".repeat(40)}\n`;
      if (a[0] === "rev-parse" && a.includes("-q")) throw new Error("fatal: needed a single revision");
      if (a[0] === "merge-base") throw new Error("fake: no merge-base (never landed)");
      if (a[0] === "config") throw new Error("fake: no identity configured");
      if (a.includes("status")) return " M feature.txt\0";
      if (a[0] === "ls-files") return "";
      if (a.includes("diff")) return "";
      if (a.includes("merge") && a.includes("--no-edit")) throw new Error("error: Your local changes to the following files would be overwritten by merge:\n\tfeature.txt\nPlease commit your changes or stash them before you merge.");
      if (a.includes("merge") && a.includes("--abort")) return "";
      throw new Error(`fake git: unhandled args ${JSON.stringify(a)}`);
    },
  });
}
{
  const sfx = `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcvcumt-${sfx}`);
  const { db, mgrId, workerId, worktreePath } = await setupWorkerProject(sfx, reposDir);
  dbs.push(db);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "locally modified, never committed\n");
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
    unionMergeGitFactory: makeDirtyWorktreeFactory(),
  });

  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(dirty, op 1) settled, NOT merged, never reached the gate", r1.settled === true && r1.ok && r1.value.merged === false && gateCalls === 0);
  check("(dirty, op 1) carries gateWorktreeDirty (reused outcome), phase before-gate", r1.ok && r1.value.gateWorktreeDirty?.phase === "before-gate");
  check("(dirty, op 1) does NOT carry unionMergeTransient — dirt is its own classification", r1.ok && !r1.value.unionMergeTransient);
  check("(dirty, op 1) detailText tells a human to commit/discard, never 'transient'", r1.ok && /commit or discard/i.test(r1.value.detailText ?? "") && !/transient/i.test(r1.value.detailText ?? ""));

  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(dirty, op 2 — re-confirm) NOT served from cache ('worktree-dirty' is in NEVER_CACHED_OUTCOMES)", r2.cacheHit === undefined);
  check("(dirty, op 2 — re-confirm) still settles as the same dirty refusal (nothing cleaned it up)", r2.settled === true && r2.ok && r2.value.gateWorktreeDirty?.phase === "before-gate");
}

// ── ADMISSION-TIME THREADING (round 2, item 3): AdmissionReunionFailedError's `transient` arg →
// `rejectAdmissionReunionFailure` → `unionMergeTransient` + honest cause text, via the SAME real
// "main advances during the queue wait" seam merge-gate-reuse-admission.mjs's scenario (O) uses — but here
// the admission-time re-union itself fails TRANSIENTLY (a confirmed-kill-timeout), not with a real conflict.
// A PROXYING factory (real canonicalGit, intercepted ONLY on the SECOND "merge --no-edit" call — the
// admission-time reunion's own attempt, never the pre-gate one) is required: computeOwedLanding has no part
// here, but the admission queue-wait mechanism needs a REAL repo/gate semaphore, which a full hand-rolled
// fake can't drive.
{
  const sfx = `adm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const repo = mkdtempManaged(`loom-mcvcumt-adm-repo-${sfx}-`);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "mcvcumt@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "mcvcumt"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcvcumt-adm\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=mcvcumt@loom", "-c", "user.name=mcvcumt", "commit", "-q", "-m", "init"], { cwd: repo });

  const db = new Db(); dbs.push(db);
  const projId = `mcvcumt-adm-p-${sfx}`, taskId = `mcvcumt-adm-t-${sfx}`, mgrId = `mcvcumt-adm-mgr-${sfx}`, workerId = `mcvcumt-adm-w-${sfx}`;
  db.insertProject({ id: projId, name: "MCVCUMT-ADM", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcvcumt-adm-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertAgent({ id: `agent-mcvcumt-adm-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCVCUMT-ADM-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcvcumt-adm-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature-adm.txt"), "work\n");
  commitAll(worktreePath, "feature-adm.txt", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcvcumt-adm-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  // Main must already be AHEAD of the branch's fork point before the FIRST confirm — otherwise the
  // pre-gate union-merge takes the "already caught up" shortcut and never calls `git merge --no-edit` at
  // all, and the admission-time reunion below would then be the FIRST (not second) real merge attempt.
  fs.writeFileSync(path.join(repo, "main-pre-advance.txt"), "main pre-advance\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=mcvcumt@loom", "-c", "user.name=mcvcumt", "commit", "-q", "-m", "main pre-advance"], { cwd: repo });

  const admState = { mergeCalls: 0 };
  const proxyFailSecondMergeCall = (p, ms) => {
    const real = canonicalGit(p, ms);
    return {
      async raw(args) {
        const a = Array.isArray(args) ? args : [args];
        if (a.includes("merge") && a.includes("--no-edit")) {
          admState.mergeCalls++;
          if (admState.mergeCalls === 2) throw new Error("git merge main into worktree exceeded 50ms (hung git child?)");
        }
        return real.raw(args);
      },
    };
  };
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    runGate: async () => { gateCalls++; return { passed: true }; },
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
    unionMergeGitFactory: proxyFailSecondMergeCall,
  });

  let releaseHolder;
  const holderPromise = new Promise((resolve) => { releaseHolder = resolve; });
  const holderRun = sessions.gateSemaphore.runExclusive(
    1, { gateType: "merge", projectId: `mcvcumt-adm-holder-${sfx}`, sessionId: `mcvcumt-adm-holder-sess-${sfx}` }, () => holderPromise,
  );

  const confirmPromise = sessions.confirmWorkerMerge(mgrId, workerId);
  const queueDeadline = Date.now() + 20_000;
  let queued = false;
  while (Date.now() <= queueDeadline) {
    if (sessions.gateSemaphore.snapshot().queued >= 1) { queued = true; break; }
    await new Promise((r) => setTimeout(r, 5));
  }
  check("(admission-threading) precondition: confirmWorkerMerge is genuinely queued (pre-gate union-merge already ran once, cleanly)", queued && admState.mergeCalls === 1);
  if (!queued) {
    releaseHolder();
    await Promise.allSettled([holderRun, confirmPromise]);
  } else {
    // Main advances WHILE queued, on a file the worker's branch never touches — a trivial, non-conflicting
    // re-union, so the ONLY reason the admission-time attempt fails is the injected transient error.
    fs.writeFileSync(path.join(repo, "main-advance.txt"), "main advance\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=mcvcumt@loom", "-c", "user.name=mcvcumt", "commit", "-q", "-m", "main advance during queue"], { cwd: repo });

    releaseHolder();
    await holderRun;
    const confirm = await confirmPromise;

    check("(admission-threading) the gate NEVER ran — the admission-time re-union fails before the gate spawns", gateCalls === 0);
    check("(admission-threading) confirmWorkerMerge REJECTS — a defined, observable outcome", confirm.merged === false);
    check("(admission-threading) the SECOND merge attempt (admission-time) is the one that failed", admState.mergeCalls === 2);
    check("(admission-threading) carries unionMergeTransient:true (AdmissionReunionFailedError's transient arg threaded through)", confirm.unionMergeTransient === true);
    check("(admission-threading) the cause text says transient git/host condition, never a content conflict", /transient git\/host condition/.test(confirm.detailText ?? "") && !/conflicts with this branch/.test(confirm.detailText ?? ""));
    check("(admission-threading) worktree retained for a retry", fs.existsSync(worktreePath) === true);
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a transient union-merge failure (confirmed-kill-timeout-shaped) classifies distinctly " +
    "from an ordinary rejection, is never cached, and a plain re-confirm at the same branch head genuinely " +
    "re-attempts the merge instead of replaying the stale verdict. A dirty worktree classifies as the " +
    "existing never-cached worktree-dirty outcome instead. And the admission-time re-union's own transient " +
    "arg threads through AdmissionReunionFailedError into an honest unionMergeTransient result."
  : `\n❌ ${failures} FAILURE(S).`);
for (const db of dbs) try { db.close(); } catch { /* best-effort, mirrors merge-gate-reuse-admission.mjs */ }
process.exit(failures === 0 ? 0 : 1);
