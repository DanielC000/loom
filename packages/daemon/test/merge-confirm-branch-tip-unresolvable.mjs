import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1; see _guard.mjs)
// Card 56c10535 Round 3, item 2 (Code Review a9e8a86b): mergeBranchLocked's `branchTipUnresolvable`
// refusal (git/worktrees.ts) used to fall into `confirmWorkerMerge`'s GENERIC merge_failed branch
// (service.ts), which tells the manager "squash was attempted but never committed … Re-task a rebase" —
// both false for this refusal: nothing was ever attempted, and a rebase cannot fix a branch that's
// genuinely gone or ambiguous. This file proves the WIRING: a real `SessionService.confirmWorkerMerge`
// call that hits an unresolvable squash target gets its OWN distinct classification and wording, and
// that the refusal is never cached (a re-call that can resolve the branch for real must genuinely land).
//
//   (A) WORDING + FLAG — `confirm.branchTipUnresolvable === true`, never `confirm.conflict`, and
//       `detailText` carries the honest remedy (never "squash was attempted"/"Re-task a rebase").
//   (B) NEVER-CACHED — the SAME op, called via `confirmWorkerMergeTracked`: op 1 hits the fault and
//       refuses; op 2 (the fault removed, the real branch resolves fine) must genuinely MERGE, not
//       replay a cached rejection. Structural proof: op 2 carries no `cacheHit`.
//
// Seam: `squashTargetUnresolvable` (test/_late-commit-seam.mjs) — makes mergeBranchLocked's OWN
// squash-target `for-each-ref` lookup come back empty, without touching anything else
// `confirmWorkerMerge`'s own earlier preconditions read (the branch is REAL and untouched throughout;
// only this one call is faked).
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-branch-tip-unresolvable.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcbtu-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
// Dynamic, not static: _late-commit-seam.mjs itself dynamically imports ../dist/git/bounded.js (which
// transitively reaches paths.js's module-scope LOOM_HOME constant) — a STATIC import here would resolve
// that chain before this file's own LOOM_HOME assignment above ever runs, freezing the wrong (real) home.
const { squashTargetUnresolvable } = await import("./_late-commit-seam.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcbtu@loom -c user.name=mcbtu";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const openDbs = [];
const noReap = async () => ({ killedPids: [] });
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirmTracked = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked", timeoutMs: 240_000 });
const headOf = (cwd) => execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();

async function setup(sfx) {
  const reposDir = path.join(os.tmpdir(), `loom-mcbtu-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db(); openDbs.push(db);
  const mgrId = `mcbtu-mgr-${sfx}`, projId = `mcbtu-p-${sfx}`, taskId = `mcbtu-t-${sfx}`, workerId = `mcbtu-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcbtu\n");
  execSync("git init -q && git config user.email mcbtu@loom && git config user.name mcbtu", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  db.insertProject({ id: projId, name: "MCBTU", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcbtu-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcbtu-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcbtu-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCBTU-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "work");
  commitAll(wt.worktreePath, "feature", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcbtu-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
  return { db, mgrId, workerId, repo, worktreePath: wt.worktreePath, branch: wt.branch, mainSha: headOf(repo) };
}
const svc = (db, extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, ...extra });

try {
  // ── (A) WORDING + FLAG ────────────────────────────────────────────────────────────────────────────
  {
    console.log("\n— (A) confirm-level wiring: the squash-target resolve comes back empty —");
    const { db, mgrId, workerId, repo, branch, mainSha } = await setup(sfxOf("a"));
    const sessions = svc(db, { soloMergeGitFactory: squashTargetUnresolvable(branch) });

    const confirm = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(A) refused, never merged", confirm.merged === false);
    check("(A) carries its OWN distinct flag, branchTipUnresolvable:true", confirm.branchTipUnresolvable === true);
    check("(A) is NOT misclassified as a conflict", confirm.conflict !== true);
    check("(A) the detailText states nothing was squashed", /nothing was squashed/.test(confirm.detailText ?? ""));
    check("(A) the detailText never claims a squash was attempted (the generic merge_failed wording)", !/squash was attempted/.test(confirm.detailText ?? ""));
    check("(A) the detailText never says 'Re-task a rebase' (the generic — and here actively wrong — remedy)", !/Re-task a rebase/.test(confirm.detailText ?? ""));
    check("(A) the detailText instead says this is a BRANCH problem, not a rebase", /BRANCH problem, not a rebase/.test(confirm.detailText ?? ""));
    check("(A) nothing landed — HEAD unchanged", headOf(repo) === mainSha);
  }

  // ── (B) NEVER-CACHED ──────────────────────────────────────────────────────────────────────────────
  {
    console.log("\n— (B) a re-confirm after the fault clears must genuinely re-attempt, not replay the refusal —");
    const { db, mgrId, workerId, repo, branch, mainSha } = await setup(sfxOf("b"));
    const sessions = svc(db, { soloMergeGitFactory: squashTargetUnresolvable(branch) });

    const r1 = await confirmTracked(sessions, mgrId, workerId);
    check("(B) op 1: refused via branchTipUnresolvable (a genuine fresh mint)", r1.ok === true && r1.value?.merged === false && r1.value?.branchTipUnresolvable === true);
    check("(B) op 1: nothing landed", headOf(repo) === mainSha);

    // Remove the fault — the branch resolves for real now. A cached rejection would replay op 1's
    // refusal verbatim (and the branch would never land); the actual fix re-derives and merges.
    sessions.soloMergeGitFactory = undefined;
    const r2 = await confirmTracked(sessions, mgrId, workerId);
    check("(B) op 2: genuinely re-attempted and LANDED (not a replayed rejection)", r2.ok === true && r2.value?.merged === true);
    check("(B) THE NEVER-CACHED PROOF (structural): op 2 carries NO cacheHit — branch-tip-unresolvable is excluded from the until-superseded cache", r2.cacheHit === undefined);
    check("(B) the real content actually landed", fs.existsSync(path.join(repo, "feature.txt")));
  }
} finally {
  for (const db of openDbs) { try { db.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMerge classifies an unresolvable squash target with its own distinct branchTipUnresolvable flag and honest wording (never the generic merge_failed/\"Re-task a rebase\" framing), and the refusal is never cached — a re-confirm after the fault clears genuinely re-attempts and lands."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
