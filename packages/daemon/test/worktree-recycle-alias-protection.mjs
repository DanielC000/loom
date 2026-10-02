import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 40b63f1c: boot-reconcile Pass B keyed its liveness protection on the ITERATED SESSION ROW
// (`protectedSessionIds.has(s.id)`), not the worktree it names. A `worker_recycle` chain aliases ONE
// worktreePath across TWO session rows — `recycleWorker` (sessions/service.ts:9767-9768) never clears
// the predecessor's own worktreePath/branch/taskId; the fresh successor just carries the SAME values
// forward. The dangling predecessor (exited, NOT in protectedSessionIds) then passes every Pass B filter
// and reaps the SAME worktree the successor needs — the successor's own protection is never consulted,
// because the loop only ever asked "is THIS row protected?", never "does anyone still hold this
// worktree?". Pass C then deletes the branch too: its `listCheckedOutBranches` gate reads git state Pass
// B just destroyed 19s earlier in the real incident.
// REAL git on temp repos, NO claude + NO live daemon — drives reconcileOrchestrationOnBoot() directly
// against an isolated LOOM_HOME. Proves BOTH legs independently (DoD item 7's explicit requirement —
// fixing Pass B alone would leave branch deletion as the surviving half of the bug):
//   (A) a recycled successor PROTECTED via protectedSessionIds (about to be resumed — it is ALSO still
//       `exited` in the DB at the instant reconcile runs, since resumeFleetOnBoot hasn't spawned its pty
//       yet; this is the exact incident shape, not a simplification). The DANGLING predecessor row
//       sharing its worktreePath/branch must NOT cause Pass B to remove the worktree (leg 1) NOR Pass C
//       to delete the branch (leg 2).
//   (B) CONTROL: a recycle chain with NEITHER row protected (a genuinely abandoned chain — the daemon
//       crashed and nobody ever asked to resume it). The SAME 0-commit, clean-tree worktree shape IS
//       still GC'd and its branch IS still reclaimed — proves the fix protects only the genuinely-
//       live/protected case, not every aliased worktree unconditionally.
// RED-PROOFED against pre-fix code (git show <predecessor commit>:packages/daemon/src/sessions/service.ts,
// rebuilt, this test re-run): both (A leg 1) and (A leg 2) failed — the worktree was destroyed and the
// branch was deleted — while (B) already passed, confirming the discriminator is the fix, not the fixture.
//
// Card 9ac3a739 extends this file with the OTHER half of the same row-vs-path bug: Pass A (the orphaned-
// squash-merge FINISHER) had no path-based protection at all — only `protectedSessionIds.has(s.id)` on
// the iterated row. A landed recycle chain (the successor's squash already landed on main, carrying the
// trailer, but the daemon crashed BEFORE finalizeMerge's bookkeeping) let Pass A reach the DANGLING
// PREDECESSOR's row, find the SAME landed squash via the trailer, and finalize THROUGH the predecessor —
// destroying the shared worktree/branch the protected successor needs.
//   (C) a landed chain whose successor is protected (about to be resumed) — Pass A must defer to the
//       protected path and NOT finalize via the dangling predecessor.
//   (D) CONTROL: the same landed shape, nobody protected (abandoned) — Pass A SHOULD still finalize it
//       normally, proving the fix defers only the genuinely-protected case.
//   (E) a SEPARATE regression guard for the "already finalized" fix that rides along with the path fix:
//       a single (non-recycled) worker whose branch carries TWO landings over its lifetime (mirrors a
//       HELD branch's later range, card 13fc5227) — the FIRST already finalized (merge_done recorded),
//       the SECOND a fresh crash-orphan. Keying "already finalized" on the mere PRESENCE of a merge_done
//       for the branch (instead of comparing the landed commit's own time against the latest merge_done's
//       timestamp) would wrongly skip finalizing the second landing's orphan — this fixture proves it does not.
// Run: 1) build daemon, 2) node test/worktree-recycle-alias-protection.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wrap-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wrap@loom -c user.name=wrap";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const branchExists = (cwd, branch) => git(cwd, `branch --list ${branch}`) !== "";
// `git worktree list` prints forward slashes; createWorktree returns a native (backslash on Windows)
// path — normalize before substring-matching so this is a path check, not an accidental slash mismatch.
const isRegisteredWorktree = (repo, worktreePath) => git(repo, "worktree list").replace(/\\/g, "/").includes(worktreePath.replace(/\\/g, "/"));
const now = new Date().toISOString();

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wrap\n");
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  git(repo, "branch -M main");
  // A resolvable LOCAL origin/HEAD symbolic ref — no real remote needed (same recipe as
  // worktree-branch-gc.mjs's R1) — required for Pass C's branch-ref sweep to even consider this repo;
  // without it the repo is fail-closed skipped and leg 2 would prove nothing either way.
  git(repo, "symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main");
}

// One recycle-chain fixture: a real, zero-commit, clean worktree shared by a predecessor + successor row
// — exactly `worker_recycle`'s own on-disk shape (createWorktree is the same primitive it reuses).
async function setupRecycleChain(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, predId = `wrap-${tag}-pred-${sfx}`, succId = `wrap-${tag}-succ-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  // The predecessor: `worker_recycle` hard-stops it but never clears its worktreePath/branch/taskId (see
  // recycleWorker) — the fresh successor row just carries the SAME values forward. It shows up here
  // exactly as it would at a real boot: exited, unprotected, worktree clean and 0 commits ahead.
  db.insertSession({ id: predId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  // The successor: SAME worktreePath/branch/taskId (the recycle contract). At the exact instant
  // boot-reconcile runs, it is ALSO still `exited` in the DB — resumeFleetOnBoot hasn't spawned its pty
  // yet — so ONLY protectedSessionIds (built from restart-intent / crash-orphaned-workers, BEFORE
  // reconcile runs) distinguishes it from an ordinary dead row. This is the exact incident shape, not a
  // simplification of it.
  db.insertSession({ id: succId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, recycledFrom: predId });
  return { projId, taskId, mgrId, predId, succId, worktreePath, branch, repo };
}

// Card 9ac3a739: a recycle chain whose successor's squash ALREADY LANDED on main (carries the
// Loom-Worker-Branch trailer) before the daemon crashed — mirrors `boot-reconcile.mjs`'s own squash-
// landing recipe. The worktree/branch/task are left exactly as a crash-before-finalize leaves them:
// task still in_progress, worktree + branch still present. The SUCCESSOR is the row that actually
// requested the merge (mirrors where `confirmWorkerMerge`'s review step really files `merge_request`,
// service.ts ~14245-14250) — the predecessor never did.
async function setupLandedRecycleChain(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, predId = `wrap-${tag}-pred-${sfx}`, succId = `wrap-${tag}-succ-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "change.txt"), "worker change\n");
  commitAll(worktreePath, "change", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}" -m "Loom-Worker-Branch: ${branch}"`, { cwd: repo });
  db.insertSession({ id: predId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  db.insertSession({ id: succId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, recycledFrom: predId });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: succId, taskId, kind: "merge_request", detail: { branch, filesChanged: 1, tip: branch } });
  return { projId, taskId, mgrId, predId, succId, worktreePath, branch, repo };
}

// Card 9ac3a739 (manager amendment; RELABELED round 2 — see below): ONE branch name carries TWO
// landings, via TWO DIFFERENT worker rows. Landing #1 (worker X) is finalized completely and normally
// (worktree removed, branch deleted, task done, merge_done recorded under X's own id) — a REAL prior
// landing, not a simulated one. Worker Y then lands a SECOND, independent squash on the SAME branch
// name — but the daemon crashes BEFORE Y's own finalize. Proves "already finalized" must be keyed on
// the SPECIFIC landing, never on the mere presence of ANY merge_done for the branch — a presence-only
// check would wrongly skip Y's crash-orphaned landing just because X's unrelated, OLDER landing on the
// same branch name already has one.
//
// ROUND 2 RELABEL: this fixture passes on the PRE-round-1 parent too (that code never consulted
// branch-wide `merge_done` presence at all, so there was nothing for a presence-only check to get
// wrong yet) — it is a guard against a naive presence-only implementation of this card's OWN fix, never
// proof that round 1 (or round 2's seq-based replacement) was itself a regression-free improvement.
//
// Y's worktree is added at a MANUALLY-CHOSEN, DIFFERENT path (`git worktree add`, not a second
// `createWorktree` call) — DELIBERATELY, not for convenience. `createWorktree`'s own worktree path is
// ALSO a pure function of taskId (same `key = taskKey(taskId)` the branch name uses), so a genuine
// re-task calling `createWorktree` again for the SAME taskId reuses X's EXACT stale worktreePath too —
// which, discovered while building this fixture, confuses X's OWN already-finalized row: its
// `worktreeOnDisk` check reads whatever now lives at that shared path (Y's fresh worktree), not whether
// X's OWN landing is still outstanding, so X's row stops early-outing and Pass A can re-process it. That
// is a genuine, pre-existing, SEPARATE defect (triggered by ANY path-reusing re-task, independent of
// this card's fix) — flagged in this card's `worker_report`, not fixed here. Sidestepping it (a distinct
// path for Y) isolates the ONE thing this fixture is actually for: the branch-keyed timestamp check.
//
// (A single worker row carrying two REAL finalizeMerge calls for itself is a THIRD, separate shape and
// is deliberately NOT exercised here either: finalizeMerge has its OWN internal, row-id-keyed replay
// guard — `hadPriorMergeDone`, @decision sha:61446519/daaf7fc9 — that intentionally skips re-moving the
// task column on a SECOND call for the SAME worker id, precisely because a held branch's only real
// finalizeMerge call is its late-range release: it is never preceded by an earlier merge_done of its
// own. A re-task (or, as here, a held-then-released branch) mints a brand-new worker id instead, so
// that guard never applies to either real-world shape.)
async function setupRetaskTwoLandings(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  // Dispatch #1 (worker X): lands and is finalized COMPLETELY and normally — worktree gone, branch
  // deleted, task done, merge_done recorded under X's own id.
  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  fs.writeFileSync(path.join(first.worktreePath, "a.txt"), "first\n");
  commitAll(first.worktreePath, "a", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${first.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-1" -m "Loom-Worker-Branch: ${first.branch}"`, { cwd: repo });
  fs.rmSync(first.worktreePath, { recursive: true, force: true });
  execSync(`git worktree prune`, { cwd: repo });
  git(repo, `branch -D ${first.branch}`);
  db.updateTask(taskId, { columnKey: "done" });
  const landing1Ts = new Date(Date.now() - 60_000).toISOString(); // unambiguously before landing #2 below
  db.appendEvent({ id: randomUUID(), ts: landing1Ts, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_done", detail: { branch: first.branch } });

  // Worker Y: the SAME branch name, reused — but a worktree manually added at a DIFFERENT physical
  // path (see the header comment above for why this isn't just `createWorktree` again). Lands a SECOND,
  // independent squash, but crashes BEFORE finalize (no merge_done for Y yet).
  db.updateTask(taskId, { columnKey: "in_progress" });
  const worktreePathY = `${first.worktreePath}-y`;
  execSync(`git worktree add -b ${first.branch} "${worktreePathY}"`, { cwd: repo });
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePathY, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: worktreePathY, branch: first.branch });
  fs.writeFileSync(path.join(worktreePathY, "b.txt"), "second\n");
  commitAll(worktreePathY, "b", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${first.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-2" -m "Loom-Worker-Branch: ${first.branch}"`, { cwd: repo });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: first.branch } });
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: worktreePathY, branch: first.branch, repo };
}

// Card 9ac3a739 ROUND 2 item 2: a landed recycle chain whose SUCCESSOR already has its OWN merge_request
// + merge_done on record (simulating its real finalize having already run) while the shared worktree/
// branch are STILL PRESENT on disk — the residual shape `worktreeGcWarning`'s own promise exists for
// (the other row's own `gcWorktreeDir` call left them behind). Pass A must NOT call a full
// `finalizeMerge` through the DANGLING PREDECESSOR for this (that would re-move the task column / refile
// a duplicate merge_done — the original m1 bug); it must run the cleanup-only path instead (gc the dir +
// a CAS branch delete), touching no task bookkeeping at all.
//
// Neither row is explicitly protected (an abandoned chain, like fixture D) — `lastActivity` is set so
// the PREDECESSOR sorts BEFORE the successor in `listAllSessionsIncludingArchived`'s `ORDER BY
// last_activity DESC` read, so Pass A deterministically visits the predecessor first and exercises the
// sibling-cleanup branch (never the successor's own separate, and equally valid, own-row-retry branch —
// `codescape-reingest-replay-guard.mjs` already covers that one).
async function setupSiblingCleanupOnly(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, predId = `wrap-${tag}-pred-${sfx}`, succId = `wrap-${tag}-succ-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "change.txt"), "worker change\n");
  commitAll(worktreePath, "change", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}" -m "Loom-Worker-Branch: ${branch}"`, { cwd: repo });
  const predLastActivity = new Date(Date.parse(now) + 2000).toISOString();
  db.insertSession({ id: predId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: predLastActivity, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  db.insertSession({ id: succId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, recycledFrom: predId });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: succId, taskId, kind: "merge_request", detail: { branch, filesChanged: 1, tip: branch, repoKey: null } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: succId, taskId, kind: "merge_done", detail: { branch, repoKey: null } });
  return { projId, taskId, mgrId, predId, succId, worktreePath, branch, repo };
}

// Card 9ac3a739 ROUND 2 item 4: the Pass A2 "re-task stale alert" case. Worker X lands and is finalized
// completely (merge_request then merge_done, both real DB events). The task is then re-tasked (column
// back to in_progress) and worker Y is dispatched onto the SAME branch NAME, files its OWN merge_request
// — but the daemon crashes before Y's own finalize, and (for this fixture only) the task is left/returned
// to a terminal column by some other means. A row-id-only OR branch-PRESENCE-only `hasTerminal` check
// wrongly reads X's OLD, unrelated merge_done as resolving Y's own, LATER, still-unresolved
// merge_request, stranding Y's MERGE REQUEST alert forever. The two events collide at the SAME
// millisecond `ts` deliberately (a fast, back-to-back test run does this for free) — only `seq` (never
// `ts`) can correctly order them, which is the whole point of this fixture. No real git is needed: Pass
// A2 is DB-event-only.
function setupRetaskStaleAlert(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: path.join(repo, "never-on-disk-x"), branch: `loom/wrap-${tag}` });
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: path.join(repo, "never-on-disk-y"), branch: `loom/wrap-${tag}` });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: `loom/wrap-${tag}`, filesChanged: 1, tip: `loom/wrap-${tag}`, repoKey: null } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_done", detail: { branch: `loom/wrap-${tag}`, repoKey: null } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: `loom/wrap-${tag}`, filesChanged: 1, tip: `loom/wrap-${tag}`, repoKey: null } });
  return { projId, taskId, mgrId, workerXId, workerYId, branch: `loom/wrap-${tag}`, repo };
}

// Card 9ac3a739 ROUND 3 item 1: `Db.latestEventSeqForBranch`'s own repoKey filter, exercised through
// Pass A's "already finalized" check — a Code Review of 4b116328 mutated that filter to always-match
// (dropping the repoKey comparison) and ALL 12 existing repoKey-scoped tests in this suite stayed green,
// because none of them actually drive `latestEventSeqForBranch` itself: they exercise `isBranchHeld`'s
// OWN, separate repoKey filter instead. This fixture is DANGLING-PREDECESSOR shaped like F above, but the
// pre-seeded merge_done on the shared branch is stamped `repoKey: "other"` — a DIFFERENT repo than this
// row's own primary (`null`) scope. A mutated always-match filter would wrongly read that "other"-scoped
// merge_done as resolving THIS row's primary-scope finalize, taking the cleanup-only path (no task move,
// no own merge_done) instead of a correct, GENUINE full finalize.
async function setupRepoScopedFullFinalize(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, predId = `wrap-${tag}-pred-${sfx}`, succId = `wrap-${tag}-succ-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "change.txt"), "worker change\n");
  commitAll(worktreePath, "change", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}" -m "Loom-Worker-Branch: ${branch}"`, { cwd: repo });
  const predLastActivity = new Date(Date.parse(now) + 2000).toISOString(); // sorts BEFORE succ, same discipline as F
  db.insertSession({ id: predId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: predLastActivity, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  db.insertSession({ id: succId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, recycledFrom: predId });
  // succId's OWN "finalize" is scoped to a DIFFERENT repo ("other") — predId's own scope is primary (null; no repoKey column set).
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: succId, taskId, kind: "merge_request", detail: { branch, filesChanged: 1, tip: branch, repoKey: "other" } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: succId, taskId, kind: "merge_done", detail: { branch, repoKey: "other" } });
  return { projId, taskId, mgrId, predId, succId, worktreePath, branch, repo };
}

// Card 9ac3a739 ROUND 3 item 1 (A2 half): the SAME repoKey-scoping defect, but through Pass A2's
// `hasTerminal` check instead of Pass A's — DB-event-only, no real git, mirrors G
// (`setupRetaskStaleAlert`) exactly except worker X's merge_done is stamped `repoKey: "other"` instead of
// `null`. Worker Y's own merge_request stays primary-scoped (`null`). A mutated always-match filter would
// wrongly read X's "other"-scoped merge_done as resolving Y's own, later, still-unresolved primary-scope
// merge_request, stranding Y's MERGE REQUEST alert forever.
function setupRepoScopedStaleAlert(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: path.join(repo, "never-on-disk-x"), branch: `loom/wrap-${tag}` });
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: path.join(repo, "never-on-disk-y"), branch: `loom/wrap-${tag}` });
  // ORDER (deliberate, matches the card's own fixture description exactly): Y's primary-scope
  // merge_request is filed FIRST (lower seq), X's "other"-scope merge_done LATER (higher seq) — the
  // OPPOSITE order from fixture G's (where the unrelated merge_done is OLDER). With this order, seq-
  // ordering ALONE would (wrongly) read X's later, higher-seq merge_done as resolving Y's earlier
  // request if the repoKey filter were not actually scoping by repo — isolating the repoKey axis from
  // the seq-ordering axis, unlike G.
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: `loom/wrap-${tag}`, filesChanged: 1, tip: `loom/wrap-${tag}`, repoKey: null } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: `loom/wrap-${tag}`, filesChanged: 1, tip: `loom/wrap-${tag}`, repoKey: "other" } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_done", detail: { branch: `loom/wrap-${tag}`, repoKey: "other" } });
  return { projId, taskId, mgrId, workerXId, workerYId, branch: `loom/wrap-${tag}`, repo };
}

// Card 9ac3a739 ROUND 3 item 3: the sibling cleanup-only path (fixture F's shape) must mirror
// finalizeMerge's own order — check the live branch tip against the LANDED one BEFORE touching the
// worktree. Here the branch moved AFTER the sibling's own finalize (a real `Loom-Landed-Tip` trailer
// pins the tip the squash actually ran on; a later commit on the shared worktree's branch advances past
// it) — the worktree must be KEPT (nothing removed), the branch must be KEPT at its moved tip (nothing
// deleted), and a `merge_branch_retained` notice must be filed, exactly like a solo finalize's own tip
// guard.
async function setupSiblingCleanupTipMoved(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, predId = `wrap-${tag}-pred-${sfx}`, succId = `wrap-${tag}-succ-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "change.txt"), "worker change\n");
  commitAll(worktreePath, "change", GIT_ID);
  const tipAtSquash = git(worktreePath, "rev-parse HEAD"); // the tip the squash actually ran on — pinned into the trailer below
  execSync(`git ${GIT_ID} merge --squash ${branch}`, { cwd: repo });
  commitAll(repo, [`WRAP-${tag}`, `Loom-Worker-Branch: ${branch}\nLoom-Landed-Tip: ${tipAtSquash}`], GIT_ID);
  // The branch MOVES again after this landing — an EMPTY commit on the SAME shared worktree/branch (no
  // net file content, so the squash-detection's own content-reachability check — `git diff --name-only
  // mergeBase..branch` vacuously empty — still resolves this as landed; a late commit that touched a
  // FILE would instead make Pass A read the branch as not-yet-landed at all, a DIFFERENT, already-safe
  // path this fixture is not for). Exactly the shape a sibling row's cleanup-only path must never destroy.
  execSync(`git ${GIT_ID} commit -q --allow-empty -m late`, { cwd: worktreePath });
  const lateTip = git(worktreePath, "rev-parse HEAD");
  const predLastActivity = new Date(Date.parse(now) + 2000).toISOString();
  db.insertSession({ id: predId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: predLastActivity, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  db.insertSession({ id: succId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, recycledFrom: predId });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: succId, taskId, kind: "merge_request", detail: { branch, filesChanged: 1, tip: branch, repoKey: null } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: succId, taskId, kind: "merge_done", detail: { branch, repoKey: null } });
  return { projId, taskId, mgrId, predId, succId, worktreePath, branch, repo, tipAtSquash, lateTip };
}

const R_PROTECTED = path.join(os.tmpdir(), `loom-wrap-a-${sfx}`);
const R_CONTROL = path.join(os.tmpdir(), `loom-wrap-b-${sfx}`);
const R_LANDED_PROTECTED = path.join(os.tmpdir(), `loom-wrap-c-${sfx}`);
const R_LANDED_CONTROL = path.join(os.tmpdir(), `loom-wrap-d-${sfx}`);
const R_HELD_TWO_LANDINGS = path.join(os.tmpdir(), `loom-wrap-e-${sfx}`);
const R_SIBLING_CLEANUP = path.join(os.tmpdir(), `loom-wrap-f-${sfx}`);
const R_RETASK_STALE_ALERT = path.join(os.tmpdir(), `loom-wrap-g-${sfx}`);
const R_REPO_SCOPED_FULL_FINALIZE = path.join(os.tmpdir(), `loom-wrap-h-${sfx}`);
const R_REPO_SCOPED_STALE_ALERT = path.join(os.tmpdir(), `loom-wrap-i-${sfx}`);
const R_SIBLING_CLEANUP_TIP_MOVED = path.join(os.tmpdir(), `loom-wrap-j-${sfx}`);
let A, B, C, D, E, F, G, H, I, J;

try {
  A = await setupRecycleChain("a", R_PROTECTED);
  B = await setupRecycleChain("b", R_CONTROL);
  C = await setupLandedRecycleChain("c", R_LANDED_PROTECTED);
  D = await setupLandedRecycleChain("d", R_LANDED_CONTROL);
  E = await setupRetaskTwoLandings("e", R_HELD_TWO_LANDINGS);
  F = await setupSiblingCleanupOnly("f", R_SIBLING_CLEANUP);
  G = setupRetaskStaleAlert("g", R_RETASK_STALE_ALERT);
  H = await setupRepoScopedFullFinalize("h", R_REPO_SCOPED_FULL_FINALIZE);
  I = setupRepoScopedStaleAlert("i", R_REPO_SCOPED_STALE_ALERT);
  J = await setupSiblingCleanupTipMoved("j", R_SIBLING_CLEANUP_TIP_MOVED);

  // --- sanity: both fixtures start identical (real worktree registered, branch exists, 0 commits, clean) ---
  check("(pre-A) worktree registered before reconcile", fs.existsSync(A.worktreePath) && isRegisteredWorktree(A.repo, A.worktreePath));
  check("(pre-A) branch exists before reconcile", branchExists(A.repo, A.branch));
  check("(pre-B) worktree registered before reconcile", fs.existsSync(B.worktreePath) && isRegisteredWorktree(B.repo, B.worktreePath));
  check("(pre-B) branch exists before reconcile", branchExists(B.repo, B.branch));
  check("(pre-C) worktree present before reconcile", fs.existsSync(C.worktreePath));
  check("(pre-C) branch exists before reconcile", branchExists(C.repo, C.branch));
  check("(pre-C) task starts in_progress (crash before finalize)", db.getTask(C.taskId).columnKey === "in_progress");
  check("(pre-C) HEAD carries the Loom-Worker-Branch trailer", git(C.repo, "log -1 --format=%b").includes(`Loom-Worker-Branch: ${C.branch}`));
  check("(pre-D) worktree present before reconcile", fs.existsSync(D.worktreePath));
  check("(pre-D) branch exists before reconcile", branchExists(D.repo, D.branch));
  check("(pre-E) re-dispatched worktree present before reconcile", fs.existsSync(E.worktreePath));
  check("(pre-E) re-dispatched branch exists before reconcile", branchExists(E.repo, E.branch));
  check("(pre-E) worker X's landing #1 merge_done already recorded (under X's OWN id)", db.listEventsForWorker(E.workerXId).some((ev) => ev.kind === "merge_done"));
  check("(pre-E) worker Y (the re-dispatch) has NO merge_done of its own yet", db.listEventsForWorker(E.workerYId).every((ev) => ev.kind !== "merge_done"));
  check("(pre-F) worktree present before reconcile", fs.existsSync(F.worktreePath));
  check("(pre-F) branch exists before reconcile", branchExists(F.repo, F.branch));
  check("(pre-F) successor already has its OWN merge_done (simulated prior finalize)", db.listEventsForWorker(F.succId).some((ev) => ev.kind === "merge_done"));
  check("(pre-F) predecessor has NO merge_done of its own", db.listEventsForWorker(F.predId).every((ev) => ev.kind !== "merge_done"));
  check("(pre-G) worker X's landing already finalized (merge_request + merge_done, under X's OWN id)", db.listEventsForWorker(G.workerXId).some((ev) => ev.kind === "merge_done"));
  check("(pre-G) worker Y (the re-task) has its OWN merge_request but NO terminal event yet", db.listEventsForWorker(G.workerYId).some((ev) => ev.kind === "merge_request") && db.listEventsForWorker(G.workerYId).every((ev) => ev.kind !== "merge_done" && ev.kind !== "merge_rejected"));
  check("(pre-G) task already shows terminal (demonstrably-landed signal A2 gates on)", db.getTask(G.taskId).columnKey === "done");
  check("(pre-H) worktree present before reconcile", fs.existsSync(H.worktreePath));
  check("(pre-H) branch exists before reconcile", branchExists(H.repo, H.branch));
  check("(pre-H) the only existing merge_done on the branch is scoped to a DIFFERENT repo (\"other\"), not primary", db.listEventsForBranch(H.branch, "merge_done").every((ev) => ev.detail?.repoKey === "other"));
  check("(pre-H) predecessor has NO merge_done of its own", db.listEventsForWorker(H.predId).every((ev) => ev.kind !== "merge_done"));
  check("(pre-I) worker X's landing finalized in a DIFFERENT repo scope (\"other\"), not primary", db.listEventsForWorker(I.workerXId).some((ev) => ev.kind === "merge_done" && ev.detail?.repoKey === "other"));
  check("(pre-I) worker Y has its OWN primary-scoped merge_request but NO terminal event yet", db.listEventsForWorker(I.workerYId).some((ev) => ev.kind === "merge_request" && ev.detail?.repoKey === null) && db.listEventsForWorker(I.workerYId).every((ev) => ev.kind !== "merge_done" && ev.kind !== "merge_rejected"));
  check("(pre-I) task already shows terminal (demonstrably-landed signal A2 gates on)", db.getTask(I.taskId).columnKey === "done");
  check("(pre-J) worktree present before reconcile", fs.existsSync(J.worktreePath));
  check("(pre-J) branch exists before reconcile, moved past the squash's own Loom-Landed-Tip", branchExists(J.repo, J.branch) && git(J.repo, `rev-parse ${J.branch}`) === J.lateTip && J.lateTip !== J.tipAtSquash);
  check("(pre-J) successor already has its OWN merge_done (simulated prior finalize)", db.listEventsForWorker(J.succId).some((ev) => ev.kind === "merge_done"));
  check("(pre-J) predecessor has NO merge_done of its own", db.listEventsForWorker(J.predId).every((ev) => ev.kind !== "merge_done"));

  // --- THE RECONCILE --- A's successor and C's successor are protected (about to be resumed); B/D/E are
  // not protected at all (abandoned/genuine crash). Session insertion order above is predecessor-then-
  // successor for both recycle chains — the fix must hold regardless of which aliased row a pass happens
  // to visit first, which is exactly why the protection set is built ONCE, up front, from ALL rows, rather
  // than decided per-row during iteration.
  const r = await sessions.reconcileOrchestrationOnBoot(new Set([A.succId, C.succId]));

  // (C) Pass A must defer to the protected successor's path and NOT finalize via the dangling predecessor.
  check("(C) worktree SURVIVES (Pass A deferred to the protected successor's path)", fs.existsSync(C.worktreePath));
  check("(C) branch SURVIVES", branchExists(C.repo, C.branch));
  check("(C) task stays in_progress (not force-finalized via the predecessor)", db.getTask(C.taskId).columnKey === "in_progress");
  check("(C) no merge_done was filed for the dangling PREDECESSOR id", db.listEventsForWorker(C.predId).every((ev) => ev.kind !== "merge_done"));

  // (D, control) the same landed shape, unprotected — Pass A SHOULD still finalize it normally.
  check("(D control) worktree IS finalized/removed (no protection applies)", !fs.existsSync(D.worktreePath));
  check("(D control) branch IS deleted (no protection applies)", !branchExists(D.repo, D.branch));
  check("(D control) task moved off in_progress (finalized)", db.getTask(D.taskId).columnKey !== "in_progress");
  check(
    "(D control) exactly one merge_done filed, through whichever aliased row Pass A reached",
    [...db.listEventsForWorker(D.predId), ...db.listEventsForWorker(D.succId)].filter((ev) => ev.kind === "merge_done").length === 1,
  );

  // (E) worker Y's crash-orphaned re-task landing must still be finalized — worker X's OLDER, unrelated
  // merge_done on the SAME (reused) branch name must NOT make the branch-keyed check think Y's landing
  // is already done too.
  check("(E) worktree IS finalized/removed (Y's re-task landing was finished)", !fs.existsSync(E.worktreePath));
  check("(E) branch IS deleted (again)", !branchExists(E.repo, E.branch));
  check("(E) task moved off in_progress", db.getTask(E.taskId).columnKey !== "in_progress");
  check("(E) worker Y now has its OWN merge_done", db.listEventsForWorker(E.workerYId).some((ev) => ev.kind === "merge_done"));

  // (F) round 2 item 2: the PREDECESSOR (dangling, unprotected, no own merge_done) must run the
  // cleanup-only path — gc the shared dir + CAS-delete the branch — NEVER a full finalizeMerge, since
  // the successor's own (simulated) finalize already did the real bookkeeping.
  check("(F) worktree IS cleaned up (sibling cleanup-only path ran)", !fs.existsSync(F.worktreePath));
  check("(F) branch IS deleted (CAS delete ran)", !branchExists(F.repo, F.branch));
  check("(F) task bookkeeping did NOT run through the predecessor (column never force-moved)", db.getTask(F.taskId).columnKey === "in_progress");
  check("(F) no SECOND merge_done was filed for the dangling predecessor", db.listEventsForWorker(F.predId).every((ev) => ev.kind !== "merge_done"));
  check(
    "(F) still exactly ONE merge_done total for the branch (the pre-seeded one — no duplicate, no full finalize ran)",
    [...db.listEventsForWorker(F.predId), ...db.listEventsForWorker(F.succId)].filter((ev) => ev.kind === "merge_done").length === 1,
  );

  // (G) round 2 item 4: Pass A2 must fire the reconciling merge_done for worker Y — X's OLDER, unrelated
  // merge_done on the reused branch name must NOT make the (seq-ordered, never ts/presence) check think
  // Y's own, LATER merge_request is already resolved.
  check("(G) worker Y now has a reconciling merge_done", db.listEventsForWorker(G.workerYId).some((ev) => ev.kind === "merge_done" && ev.detail?.reconciled === true));
  check("(G) worker X's own events are untouched (still exactly one merge_done)", db.listEventsForWorker(G.workerXId).filter((ev) => ev.kind === "merge_done").length === 1);

  // (H) round 3 item 1: the pre-seeded merge_done is scoped to a DIFFERENT repo ("other") than this
  // row's own primary scope (null) — `latestEventSeqForBranch`'s repoKey filter must NOT let it satisfy
  // predId's own finalize. Pass A must therefore run a GENUINE, FULL finalize through predId (not the
  // cleanup-only path): worktree removed, branch deleted via finalizeMerge's own delete, task moved off
  // in_progress, and a BRAND-NEW merge_done filed under predId's OWN id, primary-scoped.
  check("(H) worktree IS finalized/removed (a full finalize ran through predId)", !fs.existsSync(H.worktreePath));
  check("(H) branch IS deleted (finalizeMerge's own delete ran, not a no-op cleanup-only skip)", !branchExists(H.repo, H.branch));
  check("(H) task moved off in_progress (full finalize's own task bookkeeping ran — the cleanup-only path never touches the task)", db.getTask(H.taskId).columnKey !== "in_progress");
  check("(H) predecessor now has its OWN, primary-scoped merge_done — proves a GENUINE full finalize ran through IT, not a dedup/no-op", db.listEventsForWorker(H.predId).some((ev) => ev.kind === "merge_done" && (ev.detail?.repoKey ?? null) === null));
  check(
    "(H) exactly 2 merge_done total for the branch now (succ's pre-existing \"other\"-scoped one + pred's own fresh primary one — a mutated always-match repoKey filter would have taken the cleanup-only path instead and left this at 1)",
    [...db.listEventsForWorker(H.predId), ...db.listEventsForWorker(H.succId)].filter((ev) => ev.kind === "merge_done").length === 2,
  );

  // (I) round 3 item 1 (A2 half): the SAME repoKey-scoping defect, through Pass A2's `hasTerminal`
  // instead. Worker X's merge_done is scoped to a DIFFERENT repo ("other") — it must NOT satisfy worker
  // Y's own, later, primary-scoped merge_request. A2 must fire Y's own reconciling merge_done, and (round
  // 3 item 2) stamp it with Y's own resolved repoKey (null/primary), never omitted.
  check("(I) worker Y now has a reconciling merge_done", db.listEventsForWorker(I.workerYId).some((ev) => ev.kind === "merge_done" && ev.detail?.reconciled === true));
  check("(I) worker Y's reconciling merge_done is stamped with its OWN resolved repoKey (null/primary), not omitted", db.listEventsForWorker(I.workerYId).some((ev) => ev.kind === "merge_done" && ev.detail?.reconciled === true && Object.prototype.hasOwnProperty.call(ev.detail, "repoKey") && ev.detail.repoKey === null));
  check("(I) worker X's own events are untouched (still exactly one, \"other\"-scoped merge_done)", db.listEventsForWorker(I.workerXId).filter((ev) => ev.kind === "merge_done").length === 1);

  // (J) round 3 item 3: the shared branch moved AFTER the sibling's own finalize (past the squash's own
  // Loom-Landed-Tip trailer) — the cleanup-only path must check the tip BEFORE touching anything, remove
  // NOTHING on a mismatch, and file the same merge_branch_retained notice a solo finalize's own tip guard
  // would.
  check("(J) worktree is KEPT (tip mismatch — nothing was removed)", fs.existsSync(J.worktreePath));
  check("(J) branch is KEPT at its moved (late-commit) tip — never reverted, never deleted", branchExists(J.repo, J.branch) && git(J.repo, `rev-parse ${J.branch}`) === J.lateTip);
  check("(J) task stays in_progress (no finalize bookkeeping ran through either row)", db.getTask(J.taskId).columnKey === "in_progress");
  check("(J) a merge_branch_retained notice (source: solo) was filed for the moved branch", db.listEventsForBranch(J.branch, "merge_branch_retained").some((ev) => ev.detail?.source === "solo"));
  check("(J) predecessor still has no own merge_done (no full finalize ran either)", db.listEventsForWorker(J.predId).every((ev) => ev.kind !== "merge_done"));

  // (A leg 1) Pass B must NOT destroy the worktree the live/protected successor needs.
  check("(A leg 1) worktree directory SURVIVES intact", fs.existsSync(A.worktreePath));
  check("(A leg 1) worktree stays REGISTERED in git (not deregistered)", isRegisteredWorktree(A.repo, A.worktreePath));
  // (A leg 2) Pass C's own listCheckedOutBranches gate reads whatever Pass B left behind — this only
  // survives if Pass B genuinely left the worktree checked out, not merely if Pass C were independently
  // patched. This is the leg that proves fixing Pass B alone is NOT enough on its own to leave branch
  // deletion unfixed — it must actually compose correctly with Pass C's existing gate.
  check("(A leg 2) branch SURVIVES (Pass C's checked-out-elsewhere gate reads Pass B's now-intact worktree)", branchExists(A.repo, A.branch));

  // (B, control) the genuinely-abandoned chain — same shape, no protection anywhere — is STILL cleaned
  // up: proves the fix protects only the genuinely-live/protected case, not every aliased worktree.
  check("(B control) worktree IS GC'd (no protection applies)", !fs.existsSync(B.worktreePath));
  check("(B control) branch IS reclaimed (no protection applies)", !branchExists(B.repo, B.branch));

  check("(counts) exactly 2 worktrees pruned (B's Pass B GC + F's Pass A sibling-cleanup — A's aliased pair decided ONCE, not twice)", r.worktreesPruned === 2);
  check("(counts) exactly 1 branch reclaimed via Pass C's sweep (B only — F's branch was CAS-deleted directly by Pass A, never Pass C)", r.branchesReclaimed === 1);
  check("(counts) A's protected worktree was NOT counted as a suspected-still-live left-on-disk failure either", r.worktreesLeftOnDiskSuspectedLive === 0);
  check("(counts) exactly 2 stale merges resolved (G's worker Y + I's worker Y)", r.staleMergesResolved === 2);

  // --- idempotent second run: A's and C's protected worktrees still need to survive a SECOND pass with
  // the SAME protectedSessionIds (mirrors a boot that runs reconcile more than once, or a retry) ---
  const r2 = await sessions.reconcileOrchestrationOnBoot(new Set([A.succId, C.succId]));
  check("(idem) A's worktree still survives a second reconcile pass", fs.existsSync(A.worktreePath));
  check("(idem) A's branch still survives a second reconcile pass", branchExists(A.repo, A.branch));
  check("(idem) C's worktree still survives a second reconcile pass", fs.existsSync(C.worktreePath));
  check("(idem) C's branch still survives a second reconcile pass", branchExists(C.repo, C.branch));
  check("(idem) second pass prunes/reclaims nothing new (B/D/E already gone)", r2.worktreesPruned === 0 && r2.branchesReclaimed === 0);
  check("(idem) second pass finalizes nothing new (C still correctly deferred, not re-finalized)", r2.mergesFinished === 0);
  check("(idem) J's worktree still survives a second reconcile pass (tip still mismatched)", fs.existsSync(J.worktreePath));
  check("(idem) J's branch still survives a second reconcile pass, still at its moved tip", branchExists(J.repo, J.branch) && git(J.repo, `rev-parse ${J.branch}`) === J.lateTip);
} finally {
  db.close();
  for (const p of [A, B, C, D, E, F, G, H, I, J]) {
    if (!p) continue;
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot-reconcile Pass B now keys liveness protection on the WORKTREE (not the iterated session row): a worker_recycle chain's dangling predecessor can no longer reap the live/protected successor's worktree, and Pass C's existing checked-out-elsewhere gate then correctly reads that intact state and keeps the branch too — while a genuinely-abandoned chain with no protection anywhere is still cleaned up normally. Pass A now shares that SAME path-based protection (card 9ac3a739): a landed recycle chain's dangling predecessor can no longer finalize through a protected successor's shared worktree/branch, an abandoned landed chain is still finalized normally, and keying \"already finalized\" on the specific landing (not the mere presence of any merge_done for the branch) still finishes a second landing's crash-orphan even when an earlier landing on the same branch already has its own merge_done. ROUND 2: \"already finalized\" is now DB event SEQ order (never git commit time, never ts/rowid), repo-scoped, and checked AFTER isBranchHeld — a dangling predecessor whose branch was already finalized through a sibling row now runs a cleanup-only path (gc the dir + a CAS branch delete) instead of a full finalize, while an own-row cleanup retry (merge_done present, worktree still on disk) is exempted outright and always falls through to the ordinary finalizeMerge call. The identical seq rule now also drives Pass A2's branch-gone resolver, fixing a re-task case where an OLDER, unrelated merge_done on a reused branch name could strand a LATER worker's own still-unresolved merge_request forever. ROUND 3: `latestEventSeqForBranch`'s own repoKey filter is now exercised directly (not just `isBranchHeld`'s) — a merge_done scoped to a DIFFERENT repo can no longer satisfy a dangling predecessor's own primary-scope finalize (Pass A now runs the genuine full finalize instead of a wrong cleanup-only skip) nor a sibling worker's own primary-scope merge_request (Pass A2 still fires its own reconciling merge_done, now correctly stamped with that worker's own repoKey). ROUND 3 item 3: the cleanup-only path itself now checks the live tip against the landed one BEFORE touching anything — a branch that moved after a sibling's finalize is KEPT (nothing removed, nothing deleted) and a merge_branch_retained notice is filed, exactly like a solo finalize's own tip guard."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
