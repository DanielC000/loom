import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b801bad0 (fix round 4), DoD item 3 — `verifyLanded`'s POST-ff sha-mismatch shape
// (git/batch-merge.ts ~828: `post.sha !== targetSha`) is the ONE `branchDiverted` case where
// `observedBranch === expectedBaseBranch` — canonical is genuinely checked out on the right branch, only
// the sha is wrong, because something ELSE advanced mainline past this batch's own fast-forward target in
// the narrow window between the `--ff-only` landing and the post-ff re-read. Round 4's divertTail fix
// (sessions/service.ts) words THIS shape as "mainline moved past the batch's own fast-forward target ...
// the landing could not be confirmed", never the sibling "restore it" wording — there is nothing to
// restore when the checkout is already on the right branch.
//
// batch-merge-branch-diverted-no-fallback.mjs only ever exercises the OTHER branchDiverted shape (a PRE-ff
// divert, a stray checkout on a DIFFERENT branch — `observedBranch !== expectedBaseBranch`), so without
// this file the new conditional in `mergeBatchTracked`'s divertTail construction has no coverage at all.
//
// REAL git, REAL `mergeBatchTracked`, the SAME `batchFfGitFactory` test seam
// batch-merge-ff-unverified-no-fallback.mjs uses to intercept the post-ff combined read — but instead of
// making that second read THROW (that file's own `unverified` scenario), this one lets a SEPARATE, real git
// process land an extra commit on canonical mainline (same branch, new commit — simulating some other
// writer bypassing the in-process canonical lock) in the instant before the real post-ff re-read runs, so
// the re-read genuinely observes `post.sha !== targetSha` while `post.branch === expectedBaseBranch`.
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/batch-merge-mainline-advanced-post-ff.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-bmap-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmap", GIT_AUTHOR_EMAIL: "bmap@loom", GIT_COMMITTER_NAME: "bmap", GIT_COMMITTER_EMAIL: "bmap@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bmap@loom -c user.name=bmap";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

const P = { projId: `bmap-proj-${sfx}`, agentId: `bmap-agent-${sfx}`, mgrId: `bmap-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bmap-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# bmap\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "bmap@loom"); git(P.repo, "config", "user.name", "bmap");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const MAINREF = `refs/heads/${MAIN}`;
const canonBranch = () => git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const baseSha = git(P.repo, "rev-parse", "HEAD");

// Intercepts ONLY the SECOND combined `rev-parse HEAD --symbolic-full-name HEAD` read (verifyLanded's own
// post-ff re-read — the first is the pre-check/forfeit read inside `fastForwardCanonicalMain`): lands a
// real, independent commit on canonical mainline (SAME branch, new sha) right before delegating to the
// real read, so the re-read genuinely observes the externally-advanced state.
let combinedCalls = 0;
let externalAdvanceSha;
function mainlineAdvancesPostFfGitFactory(repoPath, blockTimeoutMs) {
  const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
  return {
    raw: async (args) => {
      if (Array.isArray(args) && args[0] === "rev-parse" && args.includes("--symbolic-full-name")) {
        combinedCalls++;
        if (combinedCalls > 1) {
          execFileSync("git", ["commit", "--allow-empty", "-m", "external advance (simulated bypass of the canonical lock)"], { cwd: repoPath, env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] });
          externalAdvanceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
        }
      }
      return real.raw(args);
    },
  };
}

const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
  syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, runGate: async () => ({ passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] }),
  batchFfGitFactory: mainlineAdvancesPostFfGitFactory,
});
db.insertProject({ id: P.projId, name: "BMAP", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

async function addWorker(tag) {
  const taskId = `bmap-${tag}-task-${sfx}`, workerId = `bmap-${tag}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `${tag}\n`);
  commitAll(worktreePath, `feat(x): change ${tag}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}

try {
  const w1 = await addWorker("a"), w2 = await addWorker("b");

  check("precondition: canonical is on mainline before the batch", canonBranch() === MAIN && git(P.repo, "rev-parse", "HEAD") === baseSha);
  const r = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
  check("settled synchronously", r.settled === true);
  const value = r.settled && r.ok ? r.value : { __unsettled: r };

  check("precondition: the injected factory's post-ff interception actually fired", combinedCalls > 1 && typeof externalAdvanceSha === "string");
  check("(1) the batch refuses, typed branchDiverted", value.ok === false && value.branchDiverted === true);
  check("(2) observedBranch === the expected mainline branch (the sha-mismatch shape, never a stray checkout)", value.fallback.length > 0 /* sanity: ran at all */ && canonBranch() === MAIN);
  check("(2) NO per-candidate fallback was started — every candidate reports started:false", Array.isArray(value.fallback) && value.fallback.length === 2 && value.fallback.every((f) => f.started === false));
  check("(3) canonical mainline genuinely advanced (to the EXTERNAL commit, never the batch's own landing)", git(P.repo, "rev-parse", MAINREF) === externalAdvanceSha);
  check("(3) neither candidate branch carries a squash/cherry-pick commit (no fallback landed anything)", git(P.repo, "log", "-1", "--format=%s", w1.branch) === "feat(x): change a" && git(P.repo, "log", "-1", "--format=%s", w2.branch) === "feat(x): change b");

  // Card b801bad0 (fix round 4) DoD item 3 — THE actual wording check: "mainline moved past", NEVER
  // "restore it" (there is nothing to restore — the checkout is already on the right branch).
  check("(4) the divertTail wording is the NEW \"mainline moved past\" guidance, not \"restore it\"", value.fallback.every((f) => /mainline moved past the batch.s own fast-forward target/i.test(f.reason)));
  check("(4) the divertTail wording does NOT use the stray-checkout \"restore it\" phrasing here", value.fallback.every((f) => !/restore it BEFORE any worker_merge_confirm/.test(f.reason)));
  check("(4) the wording still tells the manager to check git log before any worker_merge_confirm", value.fallback.every((f) => /check git log on .*BEFORE any worker_merge_confirm/i.test(f.reason)));

  const diverted = db.listEventsSince(0, 100000).filter((e) => e.kind === "batch_merge_branch_diverted" && e.detail?.projectId === P.projId);
  check("(5) exactly ONE durable batch_merge_branch_diverted event, observedBranch === expectedBranch (the sha-mismatch shape)", diverted.length === 1 && diverted[0].detail.expectedBranch === MAIN && diverted[0].detail.observedBranch === MAIN);

  db.close();
} finally {
  // (db instance closed above)
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a batch fast-forward's POST-ff sha-mismatch (mainline advanced past the batch's own target, same branch) is worded as \"mainline moved past\", never the stray-checkout \"restore it\" guidance."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
