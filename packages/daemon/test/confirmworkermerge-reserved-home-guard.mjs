import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 37e15c26 round 2 (Code Review 81164192 of 430455ea, MAJOR) — `SessionService.confirmWorkerMerge`
// resolves `repoPath` LIVE on EVERY call (`resolveRepoByKey(project, worker.repoKey)`), not just once at
// worktree-cut time. The failing route round 1 missed: a merge is rejected (worktree/branch retained,
// worker stopped) -> the project's repo is REBOUND to a LOOM_HOME-shaped git repo (`checkRepoRebind`
// only blocks a LIVE worktree session, never a stopped worker whose worktree/branch is merely retained)
// -> a re-confirm then runs the squash/commit/update-ref straight against LOOM_HOME/.git. This test
// drives `confirmWorkerMerge` DIRECTLY against exactly that shape: an exited worker with a retained
// worktree, whose project repoPath is rebound to a reserved-home-shaped repo, then re-confirmed.
//
// See docs/decisions/37e15c26-refuse-reserved-home-worktree-and-manager-session-start.md (round 2
// section) for the full narrative.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: own temp LOOM_HOME (useOwnLoomHome + requireHermeticEnv), real
// git on temp repos, a stub pty (no real claude, no live daemon) — mirrors
// merge-canonical-dirty-overlap-backstop.mjs's in-process confirmWorkerMerge style.
//
// Covers:
//   (A) REBIND TO LOOM_HOME ITSELF (raw-path equality) — refused, gate never ran, LOOM_HOME's own repo
//       untouched, worktree/branch left retained (not deleted), no merge_rejected-shaped false success.
//   (B) REBIND TO A NON-GIT DESCENDANT of LOOM_HOME — the critical bypass (createWorktree's own (a) case,
//       mirrored at THIS chokepoint): refused via the toplevel probe, not just the raw-path check.
//   (C) NEGATIVE CONTROL — the SAME worker, no rebind (repoPath stays the ordinary original repo),
//       confirmWorkerMerge actually SUCCEEDS and lands the branch — proves the new guard does not
//       false-refuse an ordinary re-confirm.
//
// Run: 1) build, 2) node test/confirmworkermerge-reserved-home-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Card 8378984b: {fresh:true} — initRepo(loomHome) below unconditionally `git checkout -b main`s the
// home itself; under a reused LOOM_HOME that already carries a `main` branch from an earlier run of this
// same file, that throws outright instead of running this file's actual assertions.
const loomHome = fs.realpathSync(useOwnLoomHome("loom-confirmmerge-ophome-", { fresh: true }));

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=cmrh@loom -c user.name=cmrh";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const readText = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n"); // core.autocrlf may rewrite line endings on checkout
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "checkout", "-b", "main");
  git(dir, "config", "user.email", "cmrh@loom");
  git(dir, "config", "user.name", "cmrh");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
  commitAll(dir, "seed", GIT_ID);
}

// Give LOOM_HOME itself a real .git — the exact shape a real host carries.
initRepo(loomHome);
const loomHomeHeadBefore = git(loomHome, "rev-parse", "HEAD").trim();
const loomHomeBranchesBefore = git(loomHome, "branch", "--list").trim();

const now = new Date().toISOString();
const db = new Db();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function markerCommand(markerPath) {
  const forJs = markerPath.replace(/\\/g, "/");
  return `node -e "require('fs').writeFileSync('${forJs}','1')"`;
}

let caseIdx = 0;
const freshIds = () => { caseIdx++; return { projId: `cmrh-proj-${caseIdx}`, taskId: `cmrh-task-${caseIdx}`, agentId: `cmrh-agent-${caseIdx}`, mgrId: `cmrh-mgr-${caseIdx}`, workerId: `cmrh-wkr-${caseIdx}` }; };

/** Sets up ONE ordinary-repo worker (a real worktree+branch, a real commit on it), with the project
 *  bound to the ORIGINAL ordinary repo and the worker row reconciled "exited" with the worktree RETAINED
 *  — the exact post-rejected-merge shape this card's hazard requires. */
async function setupExitedRetainedWorker() {
  const ids = freshIds();
  const marker = path.join(fs.realpathSync(mkdtempManaged("loom-cmrh-marker-")), "marker.log");
  const origRepo = path.join(fs.realpathSync(mkdtempManaged("loom-cmrh-origrepo-")), "repo");
  initRepo(origRepo);
  const { worktreePath, branch } = await createWorktree(origRepo, ids.projId, ids.taskId);
  fs.writeFileSync(path.join(worktreePath, "shared.txt"), "worker-version\n");
  commitAll(worktreePath, "worker change", GIT_ID);

  db.insertProject({ id: ids.projId, name: "CMRH", repoPath: origRepo, vaultPath: origRepo, config: { orchestration: { gateCommand: markerCommand(marker) } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: ids.agentId, projectId: ids.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: ids.taskId, projectId: ids.projId, title: "CMRH-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: ids.mgrId, projectId: ids.projId, agentId: ids.agentId, engineSessionId: null, title: null, cwd: origRepo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // EXITED worker, worktree RETAINED on disk (never removed) — mirrors "merge was rejected, worktree kept".
  db.insertSession({ id: ids.workerId, projectId: ids.projId, agentId: ids.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ids.mgrId, taskId: ids.taskId, worktreePath, branch });

  return { ...ids, marker, origRepo, worktreePath, branch };
}

try {
  // ===== (A) REBIND to LOOM_HOME itself (raw-path equality) =====
  {
    const w = await setupExitedRetainedWorker();
    db.updateProject(w.projId, { repoPath: loomHome, vaultPath: loomHome });
    const confirm = await sessions.confirmWorkerMerge(w.mgrId, w.workerId);
    check("(A) RED on round-1 code, GREEN on the fix: confirmWorkerMerge refuses a re-confirm whose project repo is now LOOM_HOME itself",
      confirm.merged === false && /operational home directory/i.test(confirm.reason ?? ""));
    check("(A) GATE NEVER RAN — marker file absent (refused before any gate command, let alone a squash)", !fs.existsSync(w.marker));
    check("(A) LOOM_HOME's own repo HEAD is UNCHANGED", git(loomHome, "rev-parse", "HEAD").trim() === loomHomeHeadBefore);
    check("(A) LOOM_HOME's own repo gained NO new branch", git(loomHome, "branch", "--list").trim() === loomHomeBranchesBefore);
    check("(A) the worker's retained worktree is UNTOUCHED (still present, still carries its own commit)",
      fs.existsSync(w.worktreePath) && git(w.worktreePath, "log", "--oneline", "-1").includes("worker change"));
    check("(A) the branch itself still exists in the ORIGINAL repo (never deleted)", git(w.origRepo, "branch", "--list", w.branch).trim() !== "");
    check("(A) task was NOT moved to a terminal column", db.getTask(w.taskId).columnKey !== "done");
  }

  // ===== (B) REBIND to a NON-GIT DESCENDANT of LOOM_HOME — the critical toplevel-probe bypass =====
  {
    const w = await setupExitedRetainedWorker();
    const descendant = path.join(loomHome, "workspaces", `rebind-descendant-${w.projId}`);
    fs.mkdirSync(descendant, { recursive: true });
    db.updateProject(w.projId, { repoPath: descendant, vaultPath: descendant });
    const confirm = await sessions.confirmWorkerMerge(w.mgrId, w.workerId);
    check("(B) RED on round-1 code, GREEN on the fix: confirmWorkerMerge refuses a re-confirm whose rebound repo is a non-git DESCENDANT of LOOM_HOME (git would otherwise walk up to LOOM_HOME/.git)",
      confirm.merged === false && /operational home directory/i.test(confirm.reason ?? ""));
    check("(B) GATE NEVER RAN", !fs.existsSync(w.marker));
    check("(B) LOOM_HOME's own repo HEAD is STILL UNCHANGED", git(loomHome, "rev-parse", "HEAD").trim() === loomHomeHeadBefore);
    check("(B) LOOM_HOME's own repo gained NO new branch", git(loomHome, "branch", "--list").trim() === loomHomeBranchesBefore);
  }

  // ===== (C) NEGATIVE CONTROL: the SAME shape, but NO rebind — confirmWorkerMerge actually succeeds =====
  {
    const w = await setupExitedRetainedWorker();
    const confirm = await sessions.confirmWorkerMerge(w.mgrId, w.workerId);
    check("(C) NEGATIVE CONTROL: confirmWorkerMerge against the ORIGINAL (never rebound) repo is NOT refused by this guard",
      confirm.merged === true);
    check("(C) …the gate actually ran (marker present) — proves (A)/(B)'s refusal is this guard, not some other precondition",
      fs.existsSync(w.marker));
    check("(C) …the branch's content really landed on the original repo",
      readText(path.join(w.origRepo, "shared.txt")) === "worker-version\n");
  }
} finally {
  db.close(); // free the WAL handle before removing the temp dir (Windows)
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMerge refuses a solo re-confirm whose LIVE-resolved repoPath has been rebound to LOOM_HOME itself or a non-git descendant of it, leaves the worktree/branch/task untouched either way, and an ordinary (never rebound) re-confirm still succeeds normally."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
