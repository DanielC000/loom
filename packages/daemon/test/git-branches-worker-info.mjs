import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e03b7ee4 — follow-up to a044b33b (UI-only Git-tab search/fold), which deferred labelling
// `loom/*` branches with their card title + merged state because the DATA wasn't on the branches
// payload at all. This proves the DAEMON side of that gap is closed:
//
//   GET /api/projects/:id/git/branches now carries a `worker: [{branch, taskTitle, merged}]` array
//   alongside the existing `{current, all}` shape (unchanged, for existing consumers), covering every
//   `loom/*` branch with its resolved card title (via a batched `Db.getWorkerBranchTaskMap` — ONE query
//   for the whole project, not a per-branch lookup) and its git-derived merged flag (via
//   `resolveWorkerBranchInfo`, which reuses the SAME cached merged-commit-map machinery
//   `getTaskMergedInfo` itself uses — no per-branch git subprocess).
//
// Seeds two REAL worker branches on a real temp repo, each tied to a task via a session row
// (branch + task_id, the mapping's actual DB shape):
//   - a MERGED branch: the branch ref exists (no commits of its own — vacuously landed), and main
//     carries a later commit with a `Loom-Worker-Branch: <branch>` trailer naming it.
//   - an IN-FLIGHT branch: the branch ref exists and carries a real commit of its own; main has no
//     trailer commit naming it at all.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject, mirrors
// git-read-error-surfaced.mjs's harness), driving the built dist/ business logic.
//
// Run: 1) build (turbo builds shared first), 2) node test/git-branches-worker-info.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-git-branches-worker-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45325";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { taskKey } = await import("../dist/git/worktrees.js");
const { createProjectTask } = await import("../dist/mcp/tasks.js");

const repo = path.join(os.tmpdir(), `loom-git-branches-worker-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo }).toString();
git("init -q");
git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m init`);
const defaultBranch = git("rev-parse --abbrev-ref HEAD").trim();

const dbFile = path.join(tmpHome, "branches-worker.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

try {
  db.insertProject({ id: "pRepo", name: "Repo Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertAgent({ id: "a1", projectId: "pRepo", name: "Dev", startupPrompt: "x", position: 0, profileId: null });

  // MERGED branch: ref exists, no commits of its own (vacuously landed once main's trailer commit names
  // it) — mirrors mergeBranchLocked leaving the branch ref in place after a squash merge.
  const mergedTask = createProjectTask(db, "pRepo", { title: "Merged Feature" });
  const mergedBranch = `loom/${taskKey(mergedTask.id)}`;
  git(`branch ${mergedBranch}`);
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "feat(x): landed squash" -m "Loom-Worker-Branch: ${mergedBranch}"`);
  db.insertSession({
    id: "sMerged", projectId: "pRepo", agentId: "a1", engineSessionId: null, title: null, cwd: repo,
    processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "worker", parentSessionId: null, taskId: mergedTask.id, branch: mergedBranch,
  });

  // IN-FLIGHT branch: ref exists and carries a real commit of its own; main names no trailer for it.
  const inFlightTask = createProjectTask(db, "pRepo", { title: "In-Flight Feature" });
  const inFlightBranch = `loom/${taskKey(inFlightTask.id)}`;
  git(`checkout -q -b ${inFlightBranch}`);
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "wip: still working"`);
  git(`checkout -q ${defaultBranch}`);
  db.insertSession({
    id: "sInFlight", projectId: "pRepo", agentId: "a1", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "worker", parentSessionId: null, taskId: inFlightTask.id, branch: inFlightBranch,
  });

  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

  const res = await app.inject({ method: "GET", url: "/api/projects/pRepo/git/branches" });
  check("200 on a healthy repo", res.statusCode === 200);
  const body = res.json();

  check("existing `current`/`all` shape is unchanged", typeof body.current === "string" && Array.isArray(body.all));
  check("`all` lists both seeded branches", body.all.includes(mergedBranch) && body.all.includes(inFlightBranch));

  check("`worker` is a new parallel array", Array.isArray(body.worker));
  const wMerged = body.worker.find((w) => w.branch === mergedBranch);
  const wInFlight = body.worker.find((w) => w.branch === inFlightBranch);

  check("merged branch resolves its card title", wMerged?.taskTitle === "Merged Feature");
  check("merged branch resolves merged:true", wMerged?.merged === true);
  check("in-flight branch resolves its card title", wInFlight?.taskTitle === "In-Flight Feature");
  check("in-flight branch resolves merged:false (not landed)", wInFlight?.merged === false);

  // A `loom/*` branch with no task mapping (hand-created, no session row) still lists, just with no title.
  git(`branch loom/orphan000000`);
  const res2 = await app.inject({ method: "GET", url: "/api/projects/pRepo/git/branches" });
  const wOrphan = res2.json().worker.find((w) => w.branch === "loom/orphan000000");
  check("an unmapped loom/* branch resolves taskTitle:null (no session row)", wOrphan?.taskTitle === null);
  check("an unmapped loom/* branch resolves merged:false", wOrphan?.merged === false);
} finally {
  db.close();
  fs.rmSync(dbFile, { force: true });
  fs.rmSync(`${dbFile}-wal`, { force: true });
  fs.rmSync(`${dbFile}-shm`, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GET /api/projects/:id/git/branches carries a `worker:[{branch,taskTitle,merged}]` array (batched branch→task mapping + reused cached merged-commit map, no per-branch git call), leaving the existing `{current,all}` shape untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
