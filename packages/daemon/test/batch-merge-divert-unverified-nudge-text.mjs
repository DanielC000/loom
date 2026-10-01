import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b801bad0 (fix round 4), DoD item 5 — the two async settle nudges' own TEXT, never exercised by any
// existing test: batch-merge-branch-diverted-no-fallback.mjs and batch-merge-ff-unverified-no-fallback.mjs
// both settle SYNCHRONOUSLY (`r.settled === true`), so neither ever reaches the `onSettledAfterPending`
// closure in sessions/service.ts that actually builds the `[loom:merge-batch-diverted]`/
// `[loom:merge-batch-unverified]` nudge text — the fallback `reason` strings those two files DO check are
// a DIFFERENT code path (`runFallback`'s own tail), built independently of the nudge message builder.
//
// Forces the async/pending path with a tiny `syncAttachBudgetMs` (the same DI seam
// merge-batch-drop-reasons.mjs already uses for this exact purpose), so `mergeBatchTracked` degrades to
// `{settled:false}` regardless of how fast the real gate/assembly actually runs, and the eventual settle
// is observed only via the pushed nudge — exactly how a real degraded manager would see it.
//
//   (A) branchDiverted (same divert-from-inside-runGate seam as batch-merge-branch-diverted-no-fallback.mjs):
//       the nudge is `[loom:merge-batch-diverted]` and carries "Restore the canonical checkout to the
//       expected mainline branch BEFORE any worker_merge_confirm".
//   (B) ff-unverified (same batchFfGitFactory post-read-fails seam as
//       batch-merge-ff-unverified-no-fallback.mjs): the nudge is `[loom:merge-batch-unverified]` and
//       carries round 4's new addition — "confirm canonical is checked out on the mainline branch before
//       any worker_merge_confirm" — alongside the pre-existing "check git log ... ALREADY_MERGED" guidance.
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/batch-merge-divert-unverified-nudge-text.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-bmdun-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GitWriter } = await import("../dist/git/writer.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmdun", GIT_AUTHOR_EMAIL: "bmdun@loom", GIT_COMMITTER_NAME: "bmdun", GIT_COMMITTER_EMAIL: "bmdun@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bmdun@loom -c user.name=bmdun";
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });

function makeRepo(sfx) {
  const repo = path.join(os.tmpdir(), `loom-bmdun-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmdun\n");
  git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmdun@loom"); git(repo, "config", "user.name", "bmdun");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

async function addWorker(db, repo, projId, agentId, mgrId, tag, sfx) {
  const taskId = `bmdun-${tag}-task-${sfx}`, workerId = `bmdun-${tag}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: projId, title: `feat(x): change ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `${tag}\n`);
  commitAll(worktreePath, `feat(x): change ${tag}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}

try {
  // ── (A) branchDiverted — the [loom:merge-batch-diverted] nudge ─────────────────────────────────────────
  {
    const sfx = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = makeRepo(sfx);
    const P = { projId: `bmdun-a-proj-${sfx}`, agentId: `bmdun-a-agent-${sfx}`, mgrId: `bmdun-a-mgr-${sfx}` };
    const nudges = [];
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const db = new Db();
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 1, reapWorktreeProcesses: noReap,
      runGate: async () => { await new GitWriter(repo).createBranch(`bmdun-stray-${sfx}`); return { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] }; },
    });
    const orig = sessions.enqueueDurableMessage.bind(sessions);
    sessions.enqueueDurableMessage = (target, text, ...rest) => { nudges.push({ target, text: String(text) }); return orig(target, text, ...rest); };
    db.insertProject({ id: P.projId, name: "BMDUN-A", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const w1 = await addWorker(db, repo, P.projId, P.agentId, P.mgrId, "a", sfx), w2 = await addWorker(db, repo, P.projId, P.agentId, P.mgrId, "b", sfx);

    const r = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
    check("(A) precondition: the batch degraded to pending (tiny syncAttachBudgetMs)", r.settled === false);
    await waitUntil(() => nudges.some((n) => n.target === P.mgrId && /\[loom:merge-batch-diverted\]/.test(n.text)), { timeoutMs: 30_000, intervalMs: 50, label: "merge-batch-diverted settle nudge" });
    const nudge = nudges.find((n) => n.target === P.mgrId && /\[loom:merge-batch-diverted\]/.test(n.text)).text;
    check("(A) the nudge carries the restore-checkout guidance", /Restore the canonical checkout to the expected mainline branch BEFORE any worker_merge_confirm/.test(nudge));
    check("(A) the nudge states NOTHING was started", /NOTHING was started/.test(nudge));

    db.close();
  }

  // ── (B) ff-unverified — the [loom:merge-batch-unverified] nudge ────────────────────────────────────────
  {
    const sfx = `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = makeRepo(sfx);
    const P = { projId: `bmdun-b-proj-${sfx}`, agentId: `bmdun-b-agent-${sfx}`, mgrId: `bmdun-b-mgr-${sfx}` };
    const nudges = [];
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const db = new Db();
    let combinedCalls = 0;
    function postReadFailsGitFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (Array.isArray(args) && args[0] === "rev-parse" && args.includes("--symbolic-full-name")) {
            combinedCalls++;
            if (combinedCalls > 1) throw new Error("git rev-parse timed out after 10000ms");
          }
          return real.raw(args);
        },
      };
    }
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 1, reapWorktreeProcesses: noReap, runGate: async () => ({ passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] }),
      batchFfGitFactory: postReadFailsGitFactory,
    });
    const orig = sessions.enqueueDurableMessage.bind(sessions);
    sessions.enqueueDurableMessage = (target, text, ...rest) => { nudges.push({ target, text: String(text) }); return orig(target, text, ...rest); };
    db.insertProject({ id: P.projId, name: "BMDUN-B", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const w1 = await addWorker(db, repo, P.projId, P.agentId, P.mgrId, "a", sfx), w2 = await addWorker(db, repo, P.projId, P.agentId, P.mgrId, "b", sfx);

    const r = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
    check("(B) precondition: the batch degraded to pending (tiny syncAttachBudgetMs)", r.settled === false);
    await waitUntil(() => nudges.some((n) => n.target === P.mgrId && /\[loom:merge-batch-unverified\]/.test(n.text)), { timeoutMs: 30_000, intervalMs: 50, label: "merge-batch-unverified settle nudge" });
    const nudge = nudges.find((n) => n.target === P.mgrId && /\[loom:merge-batch-unverified\]/.test(n.text)).text;
    check("(B) the nudge carries the pre-existing git-log/ALREADY_MERGED guidance", /check git log on the mainline branch/.test(nudge) && /ALREADY_MERGED/.test(nudge));
    check("(B) (DoD item 4) the nudge ALSO carries the NEW checkout-confirmation guidance", /confirm canonical is checked out on the mainline branch before any worker_merge_confirm/.test(nudge));
    check("(B) the nudge states NOTHING further was started", /NOTHING further was started/.test(nudge));

    db.close();
  }
} finally {
  // (db instances closed above)
}

console.log(failures === 0
  ? "\n✅ ALL PASS — both async merge_batch settle nudges ([loom:merge-batch-diverted] and [loom:merge-batch-unverified]) carry their own dedicated manager guidance, including round 4's checkout-confirmation addition to the unverified nudge."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
