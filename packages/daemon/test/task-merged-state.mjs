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
//   (6) card f9ada472 (d9332365's trailers-off degrade, analysis §2c): a task whose branch's content
//       genuinely landed on main, via a commit carrying NO `Loom-Worker-Branch:` trailer at all (exactly
//       what an `orchestration.commitTrailers:"off"` landing produces) STILL resolves merged:null here —
//       this scenario's fixture is a hand-rolled `execSync` commit with NO `mainline_landed_commits` row
//       behind it (no SessionService ever ran), so card aa09a59a's branch-keyed ledger fallback below
//       genuinely has nothing to find either; this is the one case neither the trailer scan nor the
//       ledger can ever close (pre-ledger history, or a landing this project's own merge code never
//       actually ran through). Scenario (1) above is this test's own polarity proof: the IDENTICAL reader
//       resolves a real sha for a trailer-carrying commit, so (6)'s null is the trailer's absence, not a
//       broken reader.
//   (7) card aa09a59a — the SAME trailer-less shape as (6), but with the `mainline_landed_commits` row a
//       REAL trailers-off `confirmWorkerMerge` landing would have written (`worker_branch`/
//       `worker_landed_tip` stamped). getTaskMergedInfo's trailer scan still misses it (no trailer was
//       ever written), but now falls back to the branch-keyed ledger read and resolves merged.sha ===
//       the landed commit, with verification:"ledger" — this is the actual fix for gap 2 of
//       docs/decisions/d9332365-optional-merge-commit-trailers.md ("every agent-facing `merged` field
//       reads `null` on a trailers-off project — in steady state, not just after a crash").
//   (8)/(9) card aa09a59a round 2, MAJOR fix — (3)'s own re-cut shape, but ALSO carrying the ledger row a
//       real PRIOR landing writes. Pre-fix, the branch-keyed ledger fallback had no notion of the
//       branch's LIVE tip and resolved the old, already-superseded squash as merged — bypassing the
//       re-task guard entirely. (8) is trailers-ON, (9) is trailers-OFF (the shape that actually shipped
//       the bug, since the ledger fallback is the only mechanism answering a trailers-off read at all).
//   (10) card aa09a59a round 2, test-gap close — the gone-branch ancestry re-verify (`mergeBase ===
//       landedSha`) is load-bearing: a ledger row pointing at a commit no longer reachable from `base`
//       (main reset/force-moved past it) must resolve null, never the stale sha.
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

const repo = path.join(os.tmpdir(), `loom-merged-state-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo }).toString();
git("init -q");
git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m init`);
const defaultBranch = git("rev-parse --abbrev-ref HEAD").trim();

const noRepoDir = path.join(os.tmpdir(), `loom-merged-state-no-repo-${Date.now()}-${process.pid}`);

const file = path.join(os.tmpdir(), `loom-merged-state-${Date.now()}-${process.pid}.db`);
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

  // (6) card f9ada472: content genuinely lands, but the commit carries NO Loom-Worker-Branch trailer at
  // all — exactly the shape a commitTrailers:"off" landing produces, with NO ledger row behind it either
  // (a hand-rolled execSync commit, never a real confirmWorkerMerge). Deliberately the SAME file-write +
  // commit shape as (1)'s genuine landing above, minus the trailer, so the only variable is the trailer's
  // presence — and (7) below is this scenario's own twin, adding back the ledger row a real landing
  // would have written.
  const noTrailer = createProjectTask(db, "pRepo", { title: "feat(x): trailers-off landing" });
  const branch6 = `loom/${taskKey(noTrailer.id)}`;
  fs.writeFileSync(path.join(repo, "notrailer.txt"), "trailers-off content\n");
  git("add -A");
  git(`-c user.email=x@loom -c user.name=x commit -q -m "feat(x): trailers-off landing"`); // no Loom-Worker-Branch trailer
  const noTrailerSha = git("log -1 --format=%H").trim();
  check("(6) setup control: the landed commit carries NO Loom-Worker-Branch trailer", !git(`log -1 --format=%B ${noTrailerSha}`).includes("Loom-Worker-Branch:"));
  const got6 = await getProjectTask(db, "pRepo", noTrailer.id);
  check("(6) a genuinely-landed but trailer-less AND ledger-less task resolves merged:null, never a throw", got6.merged === null);
  const row6 = (await listProjectTasks(db, "pRepo", { includeBody: true })).find((t) => t.id === noTrailer.id);
  check("(6) listProjectTasks ALSO resolves merged:null for the trailer-less landing (never a false merged:true)", row6?.merged === null);
  check("(6) polarity check: the SAME branch (`loom/<taskKey>`) WOULD have resolved if the trailer had been written — proven by scenario (1)'s own identical reader finding a real sha there", typeof got1.merged?.sha === "string");

  // (7) card aa09a59a — the SAME trailer-less shape as (6), but WITH the mainline_landed_commits row a
  // real trailers-off confirmWorkerMerge would have written (worker_branch/worker_landed_tip stamped).
  // `tip` is this commit's OWN sha (the thing actually on mainline); `workerLandedTip` is a plausible
  // worker-branch pre-squash tip — never git-resolved by the branch-only fallback, so a dummy sha is fine.
  const ledgerBacked = createProjectTask(db, "pRepo", { title: "feat(x): trailers-off landing, ledger-backed" });
  const branch7 = `loom/${taskKey(ledgerBacked.id)}`;
  fs.writeFileSync(path.join(repo, "ledgerbacked.txt"), "trailers-off content with a ledger row\n");
  git("add -A");
  git(`-c user.email=x@loom -c user.name=x commit -q -m "feat(x): ledger-backed trailers-off landing"`); // no Loom-Worker-Branch trailer
  const ledgerBackedSha = git("log -1 --format=%H").trim();
  const ledgerBackedBase = git(`log -1 --format=%H ${ledgerBackedSha}^`).trim();
  db.recordMainlineLandedCommit("pRepo", "primary", defaultBranch, ledgerBackedSha, ledgerBackedBase, "f".repeat(40), branch7);
  const got7 = await getProjectTask(db, "pRepo", ledgerBacked.id);
  check("(7) a trailers-off landing WITH a ledger row resolves merged non-null via the branch-keyed ledger fallback", !!got7.merged);
  check("(7) merged.sha is the ledger-recorded landed commit's short sha", got7.merged?.sha === ledgerBackedSha.slice(0, 7));
  check("(7) verification reports the NEW \"ledger\" tier, never silently reusing content/pathset/trailer-only", got7.merged?.verification === "ledger");
  check("(7) merged.date is a parseable ISO date (the commit's own authored date, re-read via git)", !isNaN(Date.parse(got7.merged?.date ?? "")));
  const row7 = (await listProjectTasks(db, "pRepo", { includeBody: true })).find((t) => t.id === ledgerBacked.id);
  check("(7) listProjectTasks ALSO resolves the ledger-backed landing the same way", row7?.merged?.sha === ledgerBackedSha.slice(0, 7) && row7?.merged?.verification === "ledger");

  // (8) card aa09a59a round 2, MAJOR fix — the branch-keyed ledger fallback used to bypass the re-task
  // guard: same re-cut shape as (3) (trailers ON — the landed commit carries its trailer), but now ALSO
  // carrying the mainline_landed_commits row a real landing writes unconditionally, independent of
  // commitTrailers config (docs/decisions/e8d4fdc3-*.md round 1/2). Pre-fix, getTaskMergedInfo's own
  // trailer-map lookup correctly returned null (the re-task guard inside resolveMergedCommitMapHit), but
  // then fell through to the branch-keyed ledger fallback — which had no notion of the branch's LIVE tip
  // and resolved the old, already-superseded squash as merged.
  const retaskOn = createProjectTask(db, "pRepo", { title: "re-spawned task, trailers on, ledger-backed" });
  const branch8 = `loom/${taskKey(retaskOn.id)}`;
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "chore: first landing (trailers on)" -m "Loom-Worker-Branch: ${branch8}"`);
  const landedSha8 = git("log -1 --format=%H").trim();
  const landedBase8 = git(`log -1 --format=%H ${landedSha8}^`).trim();
  db.recordMainlineLandedCommit("pRepo", "primary", defaultBranch, landedSha8, landedBase8, "e".repeat(40), branch8);
  git(`branch ${branch8}`);
  git(`checkout -q ${branch8}`);
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "new live work on the re-cut branch (trailers on)"`);
  git(`checkout -q ${defaultBranch}`);
  const got8 = await getProjectTask(db, "pRepo", retaskOn.id);
  check("(8) MAJOR FIX: a re-cut branch with a ledger row from its PRIOR landing resolves merged:null (trailers on) — never the old squash via the ledger fallback", got8.merged === null);
  const row8 = (await listProjectTasks(db, "pRepo", { includeBody: true })).find((t) => t.id === retaskOn.id);
  check("(8) listProjectTasks ALSO resolves merged:null for the re-cut, ledger-backed task (trailers on)", row8?.merged === null);

  // (9) card aa09a59a round 2 — the SAME re-cut-with-ledger-row bug as (8), but trailers-OFF shaped (no
  // trailer at all, like (7)'s own landing). The branch-keyed ledger fallback is the ONLY mechanism that
  // ever answers a trailers-off read at all, so this is the shape that actually shipped the bug.
  const retaskOff = createProjectTask(db, "pRepo", { title: "feat(x): re-spawned, trailers off, ledger-backed" });
  const branch9 = `loom/${taskKey(retaskOff.id)}`;
  fs.writeFileSync(path.join(repo, "retask-ledgeroff.txt"), "trailers-off content, later re-cut\n");
  git("add -A");
  git(`-c user.email=x@loom -c user.name=x commit -q -m "feat(x): trailers-off landing, later re-cut"`); // no Loom-Worker-Branch trailer
  const landedSha9 = git("log -1 --format=%H").trim();
  const landedBase9 = git(`log -1 --format=%H ${landedSha9}^`).trim();
  db.recordMainlineLandedCommit("pRepo", "primary", defaultBranch, landedSha9, landedBase9, "d".repeat(40), branch9);
  git(`branch ${branch9}`);
  git(`checkout -q ${branch9}`);
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "new live work on the re-cut branch (trailers off)"`);
  git(`checkout -q ${defaultBranch}`);
  const got9 = await getProjectTask(db, "pRepo", retaskOff.id);
  check("(9) MAJOR FIX: a re-cut branch with a ledger row (trailers off) resolves merged:null — never the old squash via the ledger fallback", got9.merged === null);
  const row9 = (await listProjectTasks(db, "pRepo", { includeBody: true })).find((t) => t.id === retaskOff.id);
  check("(9) listProjectTasks ALSO resolves merged:null for the re-cut, ledger-backed task (trailers off)", row9?.merged === null);

  // (10) card aa09a59a round 2, MAJOR test gap — the gone-branch ancestry re-verify
  // (`lookupGoneBranchLedgerSha`'s `mergeBase === landedSha` check in git/worktrees.ts) is load-bearing:
  // a ledger row can point at a commit that is no longer reachable from `base` at all (main reset/
  // force-moved past it after the row was written) — the branch itself is GONE (never created here), so
  // this exercises the branch-ABSENT arm, not (8)/(9)'s branch-PRESENT arm. `divergentSha` is committed
  // on a sibling branch that is never merged into `defaultBranch` and is deleted immediately after, so it
  // is unreachable from `defaultBranch` by construction — standing in for "main moved past it".
  git(`checkout -q -b divergent-reset-sibling ${defaultBranch}`);
  fs.writeFileSync(path.join(repo, "divergent.txt"), "never reaches main\n");
  git("add -A");
  git(`-c user.email=x@loom -c user.name=x commit -q -m "divergent commit, never merged into main"`);
  const divergentSha = git("log -1 --format=%H").trim();
  git(`checkout -q ${defaultBranch}`);
  git(`branch -D divergent-reset-sibling`);
  const resetPast = createProjectTask(db, "pRepo", { title: "ledger row past a reset main" });
  const branch10 = `loom/${taskKey(resetPast.id)}`;
  db.recordMainlineLandedCommit("pRepo", "primary", defaultBranch, divergentSha, defaultBranch, "c".repeat(40), branch10);
  const got10 = await getProjectTask(db, "pRepo", resetPast.id);
  check("(10) TEST-GAP CLOSE: a ledger row no longer reachable from base (main reset/force-moved past it) resolves merged:null — the ancestry re-verify is load-bearing", got10.merged === null);
} finally {
  db.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — getProjectTask/listProjectTasks resolve a task's git-derived merged state via the deterministic loom/<taskKey> branch + Loom-Worker-Branch trailer (never title text), stay fresh across a cache-invalidating new landing, and fail safe to null for a never-merged task, a no-repo project, a re-cut branch still carrying new live work over its own prior squash (with or without a ledger row from the prior landing, trailers on or off), and a ledger row no longer reachable from base."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
