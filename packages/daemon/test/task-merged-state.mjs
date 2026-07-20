import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9983eed6 — project_task_get / list_all_tasks (+ their in-project siblings tasks_get / tasks_list,
// which share the SAME backing functions) surface a card's git-derived MERGED/ship state, so an operator
// reading a card sees ground truth instead of a drift-prone predecessor handoff. Resolved via the task's
// DETERMINISTIC branch (loom/<taskKey(id)>) + the `Loom-Worker-Branch:` commit trailer — NOT by matching
// title text against the commit subject (see git/worktrees.ts getTaskMergedInfo's doc comment for why).
// HERMETIC: a real temp git repo (execSync) + a real Db, driving the built business logic directly
// (dist/mcp/tasks.js + dist/git/worktrees.js) — no daemon, no real claude.
//
// Proves:
//   (1) a task whose deterministic branch has a landed squash commit (one on the repo's default branch
//       carrying "Loom-Worker-Branch: <branch>") resolves merged:{sha,date} on BOTH getProjectTask and
//       listProjectTasks, matching that commit's short sha + a parseable ISO date.
//   (1b) the per-repo map cache invalidates on the NEXT HEAD move — a task that lands via a commit made
//        AFTER the cache was already warm still resolves, not served a stale pre-landing snapshot.
//   (2) a task with no matching commit anywhere in history resolves merged:null (never merged).
//   (3) the re-task ancestry guard: when the SAME branch ref still exists and DESCENDS from its own prior
//       squash commit (a re-spawned task carrying NEW live work over a landed one), merged resolves to
//       null — never a stale "merged" claim for a task that's actually back in progress.
//   (4) title text is IRRELEVANT to the match — a task's title never matches the commit subject at all in
//       this test, proving the mechanism keys off the trailer, not toConventionalSubject/title text.
//   (5) a project whose repoPath isn't a real git repo (vault-only project shape) fails safe to
//       merged:null, never throws.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-merged-state.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { getProjectTask, listProjectTasks, createProjectTask } = await import("../dist/mcp/tasks.js");
const { taskKey } = await import("../dist/git/worktrees.js");

const repo = path.join(os.tmpdir(), `loom-merged-state-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo }).toString();
git("init -q");
git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m init`);
const defaultBranch = git("rev-parse --abbrev-ref HEAD").trim();

const noRepoDir = path.join(os.tmpdir(), `loom-merged-state-no-repo-${Date.now()}`);

const file = path.join(os.tmpdir(), `loom-merged-state-${Date.now()}.db`);
const db = new Db(file);
const now = new Date().toISOString();

try {
  db.insertProject({ id: "pRepo", name: "Repo Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pNoRepo", name: "No Repo", repoPath: noRepoDir, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });

  // (1)/(4) a task whose branch has a landed squash commit — title deliberately does NOT match the
  // commit subject, proving the mechanism keys off the trailer, not the title.
  const merged1 = createProjectTask(db, "pRepo", { title: "some other title entirely" });
  const branch1 = `loom/${taskKey(merged1.id)}`;
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "feat(x): landed squash" -m "Loom-Worker-Branch: ${branch1}"`);
  const mergedSha = git("log -1 --format=%H").trim();

  const got1 = await getProjectTask(db, "pRepo", merged1.id);
  check("(1) getProjectTask resolves merged for a landed task", !!got1.merged);
  check("(1)/(4) merged.sha is the landed commit's short sha (matched via trailer, not title)", got1.merged?.sha === mergedSha.slice(0, 7));
  check("(1) merged.date is a parseable ISO date", !isNaN(Date.parse(got1.merged?.date ?? "")));

  const list1 = await listProjectTasks(db, "pRepo", { includeBody: true });
  const row1 = list1.find((t) => t.id === merged1.id);
  check("(1) listProjectTasks ALSO resolves merged for the same task", row1?.merged?.sha === mergedSha.slice(0, 7));

  // (1b) cache freshness: a SECOND task landing via a NEW commit (after the map above was already built
  // + cached) must still resolve — proving the cache invalidates on the next HEAD move, not served stale.
  const merged1b = createProjectTask(db, "pRepo", { title: "another landed task" });
  const branch1b = `loom/${taskKey(merged1b.id)}`;
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "fix(y): second landing" -m "Loom-Worker-Branch: ${branch1b}"`);
  const mergedSha1b = git("log -1 --format=%H").trim();
  const got1b = await getProjectTask(db, "pRepo", merged1b.id);
  check("(1b) cache invalidates on a new HEAD: a task merged AFTER the map was cached still resolves", got1b.merged?.sha === mergedSha1b.slice(0, 7));

  // (2) a task with no matching commit at all.
  const unmerged = createProjectTask(db, "pRepo", { title: "never merged" });
  const got2 = await getProjectTask(db, "pRepo", unmerged.id);
  check("(2) an unmerged/backlog task resolves merged:null", got2.merged === null);
  const row2 = (await listProjectTasks(db, "pRepo", { includeBody: true })).find((t) => t.id === unmerged.id);
  check("(2) listProjectTasks ALSO resolves merged:null for the unmerged task", row2?.merged === null);

  // (3) re-task ancestry guard: the branch ref STILL EXISTS and DESCENDS from its own prior squash — a
  // re-spawned task carrying NEW live work — must resolve null, not a stale "merged" claim.
  const retask = createProjectTask(db, "pRepo", { title: "re-spawned task" });
  const branch3 = `loom/${taskKey(retask.id)}`;
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "chore: first landing" -m "Loom-Worker-Branch: ${branch3}"`);
  git(`branch ${branch3}`);
  git(`checkout -q ${branch3}`);
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "new live work on the re-cut branch"`);
  git(`checkout -q ${defaultBranch}`);
  const got3 = await getProjectTask(db, "pRepo", retask.id);
  check("(3) a re-cut branch descending from its own prior squash resolves merged:null (guard)", got3.merged === null);

  // (5) a project whose repoPath isn't a real git repo fails safe to merged:null, never throws.
  const noRepoTask = createProjectTask(db, "pNoRepo", { title: "no repo project task" });
  const got5 = await getProjectTask(db, "pNoRepo", noRepoTask.id);
  check("(5) a project with no real repoPath fails safe to merged:null (no throw)", got5.merged === null);
} finally {
  db.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — getProjectTask/listProjectTasks resolve a task's git-derived merged state via the deterministic loom/<taskKey> branch + Loom-Worker-Branch trailer (never title text), stay fresh across a cache-invalidating new landing, and fail safe to null for a never-merged task, a no-repo project, and a re-cut branch still carrying new live work over its own prior squash."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
