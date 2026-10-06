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
//
// Card e5458ccd extends M (now resolved, not escalated) and adds Q/R/S: generation-safe attribution of a
// stale row's own landing (solo-squash union-chain via verifyReviewedTipChain directly, and a BATCH
// landing via a sha-parameterized content match — neither ever keyed on the shared branch name), and a
// Pass A2 staleGeneration guard (scope addition #2). See docs/decisions/e5458ccd-*.md for the full design.
//
// Card b4080777 adds Z: X's lifecycle ends at the NEW `merge_landing_aborted` kind (a refused batch
// fast-forward's own terminal event, fired after X's own `merge_landing_started`) rather than a crash —
// a DECIDED outcome, mirroring P's own shape (merge_cancelled), never attempted attribution or escalated.
// The real event-write mechanics (mergeBatchTracked, forfeited/branchDiverted/ff-quarantined/unverified)
// are covered end-to-end by merge-landing-aborted-batch-refusal.mjs; this fixture is the cheaper, focused
// proof that `resolveStaleGenerationOwnLanding`'s lifecycle QUERY actually picks the new kind up as
// `latest` and its predicate already treats it as decided — see docs/decisions/b4080777-*.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { simpleGit } from "simple-git";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wrap-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { deriveAwaitingReview } = await import("../dist/orchestration/report-resolution.js");
const { mainlineWatermarkKey } = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wrap@loom -c user.name=wrap";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const branchExists = (cwd, branch) => git(cwd, `branch --list ${branch}`) !== "";
// `git worktree list` prints forward slashes; createWorktree returns a native (backslash on Windows)
// path — normalize before substring-matching so this is a path check, not an accidental slash mismatch.
const isRegisteredWorktree = (repo, worktreePath) => git(repo, "worktree list").replace(/\\/g, "/").includes(worktreePath.replace(/\\/g, "/"));
const now = new Date().toISOString();

// Card 21b53e6a MINOR #4 (Code Review 620da79c): fixture K's own checks (below) assert only END STATE
// (worktree/branch gone, task done, Y has its own merge_done, X's event count unchanged) — and that end
// state is IDENTICAL whether X is correctly skipped outright, or (pre-fix) X incorrectly runs the
// sibling-cleanup-only path against Y's real, live artifacts first (X already has its own merge_done, so
// that wrong-identity action files no NEW event either — it is silent). A `gitFactory` spy/seam (same
// shape as pass-a-stuck-worktree-no-replay.mjs's round-5 delete-attempt spy) is the only way to actually
// discriminate: X and Y share the EXACT same branch name (a real re-task reuse), so the delete call
// itself is textually identical either way — only the CALL COUNT tells the two worlds apart. Delegates
// every op to the real git, so this is safe to share as the ONE gitFactory for the whole combined
// reconcile call below (every other fixture's git ops pass through untouched).
const branchDeleteAttempts = [];
const branchDeleteSpyFactory = (repoPath, blockTimeoutMs) => {
  const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
  return {
    raw: async (args) => {
      if (Array.isArray(args) && (
        (args[0] === "branch" && args[1] === "-D") ||
        (args[0] === "update-ref" && args[1] === "-d")
      )) branchDeleteAttempts.push({ repoPath, args });
      return real.raw(args);
    },
  };
};

const db = new Db();
// Round 3 item 3: a bare `{}` pty stub made every `enqueueDurableMessage` call inside the escalate paths
// (resolveStaleGenerationOwnLanding / escalateWedgedMergeReconcile) THROW on `this.pty.enqueueStdin` —
// silently swallowed by their own best-effort try/catch, so no `session_message_queued` row was EVER
// persisted for ANY fixture in this file. A minimal `enqueueStdin` stub returning `delivered:false` (the
// "held" shape `EnqueueResult` uses) lets that durable record actually get written, which is what the new
// undelivered-nudge-count checks below (M/N/P) need to be able to discriminate at all.
const pty = { enqueueStdin: () => ({ delivered: false, deliveryState: "queued" }) };
const sessions = new SessionService(db, pty, new OrchestrationControl());

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

// Card 21b53e6a. Fixtures K-N below exercise the REAL re-task shape — createWorktree() called a SECOND
// time for the SAME taskId (not fixture E's manual sidestep to a different path) — which is the exact
// path/branch-reuse defect this card fixes. `listAllSessionsIncludingArchived` orders by
// `last_activity DESC`, so X's `lastActivity` is stamped LATEST so Pass A visits X first (the card's own
// stated repro precondition); `createdAt` is stamped with X EARLIER than Y (a real re-task's generations
// are always chronologically ordered this way) since that is what currentGenerationIds compares across
// lineage groups.
const xLastActivityFor = (baseNow) => new Date(Date.parse(baseNow) + 20_000).toISOString();
const yCreatedAtFor = (baseNow) => new Date(Date.parse(baseNow) + 10_000).toISOString();

// Fixture K: X genuinely landed+finalized itself (own merge_done already recorded), THEN its exact
// worktreePath/branch is reused by re-task Y via a REAL second createWorktree() call. Y lands and
// crash-orphans (own merge_request, no merge_done). Pre-fix: X's cheap early-out never fires (worktreeOnDisk
// reads Y's live dir), X incorrectly runs the cleanup-only path on Y's real artifacts under X's identity.
// Post-fix: X is recognized as stale and skipped outright; Y's own row (the current generation) finalizes
// normally, under its OWN id.
async function setupRealRetaskFinalized(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  fs.writeFileSync(path.join(first.worktreePath, "a.txt"), "first\n");
  commitAll(first.worktreePath, "a", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${first.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-1" -m "Loom-Worker-Branch: ${first.branch}"`, { cwd: repo });
  fs.rmSync(first.worktreePath, { recursive: true, force: true });
  execSync(`git worktree prune`, { cwd: repo });
  git(repo, `branch -D ${first.branch}`);
  db.updateTask(taskId, { columnKey: "done" });
  db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() - 60_000).toISOString(), managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_done", detail: { branch: first.branch } });

  db.updateTask(taskId, { columnKey: "in_progress" });
  const second = await createWorktree(repo, projId, taskId); // REAL reuse: SAME path/branch as X's (gone) worktree
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "b.txt"), "second\n");
  commitAll(second.worktreePath, "b", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-2" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: repo });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo };
}

// Fixture L: X is genuinely ABANDONED — crashed before ever calling worker_merge (no merge_request, no
// merge_done at all). Re-task Y reuses X's exact path (a real createWorktree() REUSE/recut, since the dir
// is still on disk) and lands, crash-orphaning before its own finalize. Pre-fix (this is the SEVERE,
// PERMANENT variant, reproduced end-to-end at source before this card's fix): X's early-out fails to fire,
// X falls through to a GENUINE finalizeMerge call under its own wrong identity (alreadyFinalized(X) and
// finalizedElsewhere(X) both false), misattributing Y's landing's merge_done to X and permanently stranding
// Y's own merge_request (X's fresh merge_done outranks it by seq on every later boot). Post-fix: X is
// skipped outright (stale, no merge_request of its own — nothing to resolve or escalate); Y finalizes under
// its OWN id.
async function setupRealRetaskAbandoned(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  // No commit, no merge_request, no merge_done — genuinely abandoned mid-work.

  const second = await createWorktree(repo, projId, taskId); // REUSE path (dir still present) → recut branch
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "b.txt"), "second\n");
  commitAll(second.worktreePath, "b", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-2" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: repo });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo };
}

// Fixture M: X has its OWN genuine, attributable landing — it squashed onto main (real Loom-Worker-Branch +
// Loom-Landed-Tip trailers, the SAME trailer a real solo squash stamps) and filed its OWN merge_request
// recording that exact pre-squash tip, but crashed before its own finalize. Re-task Y then reuses the path.
// ROUND 2 (Code Review 620da79c, Majors #1/#2) REMOVED round 1's unsafe DB-only attribution by matching
// this trailer (drifted whenever main moved; its merge_done leaked the shared branch into generation-blind
// readers). CARD e5458ccd now RESOLVES this fixture again, via a generation-SAFE path: `verifyReviewedTipChain`
// called DIRECTLY against X's own recorded tip (never `reviewedTipVerdict`, which would pick Y's), and the
// resulting merge_done is recorded under X's OWN session id with `detail.branch: null` — never the shared
// branch. X also carries its own `worker_report(done)` here, so this fixture doubles as the "name the
// resolver" proof (manager concern #2): `deriveAwaitingReview` (report-resolution.ts), reading X's own
// session-scoped event list, is what sees the null-branch merge_done and clears X's awaitingReview.
async function setupRealRetaskOwnLandingAttributable(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  // Concern #2 (manager, card e5458ccd): X's own worker_report(done) — the one `deriveAwaitingReview` must
  // see resolved once X's own attribution lands, below.
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "worker_report", detail: { status: "done", summary: "x work" } });
  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x work\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD"); // the tip X's OWN review captured, BEFORE the squash
  execSync(`git ${GIT_ID} merge --squash ${first.branch}`, { cwd: repo });
  commitAll(repo, [`WRAP-${tag}-x`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${xTip}`], GIT_ID);
  const xLandedSha = git(repo, "rev-parse HEAD");
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} }); // card 1ac74580: a real confirm genuinely reached its own landing write
  // X crashes here — worktree/branch left exactly as a crash before finalize leaves them.

  const second = await createWorktree(repo, projId, taskId); // REUSE path → fresh branch off current main (now includes X's landed squash)
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
  commitAll(second.worktreePath, "y", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-y" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: repo });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo, xTip, xLandedSha };
}

// Fixture N: X files its OWN merge_request (claims a reviewed tip) AND genuinely reaches its own landing
// write (merge_landing_started — card 1ac74580), but NOTHING ever actually lands with that tip — models a
// worker whose confirm attempt is real but whose claim can never be verified (the squash itself failed, or
// a tip that simply never made it onto main). Per manager direction: this must escalate ONCE (a durable
// nudge naming the worker/task/remedy) rather than being silently left unresolved forever, and must NOT
// re-escalate on a later boot once already escalated. (Fixture Y, below, is the SIBLING case this card
// adds — a merge_request with NO merge_landing_started, i.e. reviewed but never confirmed at all — which
// must now no-op instead of escalating.)
async function setupRealRetaskOwnLandingUnresolvable(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: "deadbeef".padEnd(40, "0") } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} }); // card 1ac74580: a real confirm genuinely reached its own landing write

  const second = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "b.txt"), "second\n");
  commitAll(second.worktreePath, "b", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-2" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: repo });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo };
}

// Fixture Y: card 1ac74580 — the exact false-positive the card removes (real specimen: worker 3a7b77c6 on
// card f900237d, reviewed 11:23Z, re-tasked 11:27Z — never confirmed at all). X files its OWN
// merge_request (a real review happened) but NEVER reaches its own landing write — no
// merge_landing_started, no squash, nothing. A manager simply looked at the review and re-tasked the
// worktree before ever calling worker_merge_confirm. Pre-fix, `resolveStaleGenerationOwnLanding` could not
// tell this apart from fixture N (a genuine crashed confirm attempt) — both read as "merge_request, no
// terminal event" — and escalated X with a false "[loom:merge-orphaned] … may need to be redone". Post-fix:
// a bare merge_request with no merge_landing_started after it is review-only — no-op, never attempt
// attribution, never escalate, never touch git for this row at all.
async function setupRealRetaskReviewOnlyNeverConfirmed(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  // X's real work exists on its own branch (a manager genuinely reviewed it — worker_merge's own
  // merge_request) but X is re-tasked before worker_merge_confirm is EVER called. No squash, no
  // merge_landing_started, nothing else — this IS the review-only shape, not a simplification of it.
  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x work, reviewed but never confirmed\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD");
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip } });

  const second = await createWorktree(repo, projId, taskId); // re-task reuses X's exact path/branch
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
  commitAll(second.worktreePath, "y", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-y" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: repo });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo, xTip };
}

// Fixture Z: card b4080777 — X's own confirm genuinely reached `merge_landing_started` (a real attempt),
// but the batch fast-forward that followed it was REFUSED (forfeited/branchDiverted/ff-quarantined/a
// generic ff failure) before X was re-tasked — so X's lifecycle now ends at the NEW `merge_landing_aborted`
// kind, never a crash with nothing after the marker. A DECIDED outcome, mirroring fixture P's shape
// (merge_cancelled) rather than N's (unresolvable, escalates). Pre-card b4080777 this kind didn't exist, so
// X's lifecycle would have stayed at the bare `merge_landing_started` fixtures M/N/.../X already cover —
// this fixture is specifically about the NEW terminal kind itself being recognized, not a crash scenario.
async function setupRealRetaskOwnLandingBatchFfRefused(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x work\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD");
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: { batch: true } });
  // The batch's fast-forward is refused right here (mergeBatchTracked's own centralized write, card
  // b4080777) — X is re-tasked before anything else could happen to its row.
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_aborted", detail: { batch: true, reason: "batch_ff_refused" } });

  const second = await createWorktree(repo, projId, taskId); // re-task reuses X's exact path/branch
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
  commitAll(second.worktreePath, "y", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-y" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: repo });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo, xTip };
}

// Fixture P: card 21b53e6a ROUND 3 item 1 — X files its OWN merge_request but a manager reviewed it and
// CANCELLED it (a real merge_cancelled event, chronologically AFTER the merge_request) before the re-task
// ever happened — a DECIDED outcome, not a stuck landing. Pre-fix, `resolveStaleGenerationOwnLanding`
// read only `eventPresence.hasMergeRequest` and escalated X anyway, even though the merge_request was
// already resolved. Post-fix: the latest lifecycle event for X is its OWN merge_cancelled, so X is a
// silent no-op — never tracked in the one-shot store, never enqueues a nudge.
async function setupRealRetaskOwnLandingDecided(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: "deadbeef".padEnd(40, "0") } });
  // A real review decision — the manager cancelled X's own merge_request BEFORE the re-task happened.
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_cancelled", detail: { branch: first.branch, cancelled: true } });

  const second = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "b.txt"), "second\n");
  commitAll(second.worktreePath, "b", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-2" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: repo });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo };
}

// Fixture O: card 21b53e6a ROUND 2, MAJOR #3 — a worker P lands its own squash and files its own
// merge_request, then crash-orphans before its own finalize. A manager's `worker_recycle` on P carries
// the SAME worktreePath/branch forward to a fresh successor row (the recycle contract — unlike a
// re-task, NO second createWorktree call: a recycle reuses P's exact path) — but the successor's spawn
// FAILS, and the failure path (any of recycleWorker/recycleManager/recyclePlatformLead/
// reconcileNeverStartedRecycleSuccessor's own catch) NULLS the dead successor F's `recycledFrom` and
// files a `recycle_failed` event naming F as `detail.failedSuccessorId` — the one durable fact that
// survives the nulling. F's `createdAt` is LATER than P's (a real recycle always happens after its
// predecessor). Pre-fix: F's nulled `recycledFrom` makes it indistinguishable from a genuinely fresh
// generation sharing P's path, and its newer `createdAt` wins the head-selection tiebreak over P — P
// gets wrongly treated as the STALE generation (escalated instead of finalized) while F, which never
// did any work of its own, wrongly inherits P's real landing under its own id. Post-fix: F is excluded
// from `currentGenerationIds` outright via `listFailedRecycleSuccessorIds`, so P is the sole current
// generation and finalizes normally under its OWN id; F (no merge_request of its own) is never touched.
async function setupFailedRecyclePathAlias(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, pId = `wrap-${tag}-p-${sfx}`, fId = `wrap-${tag}-f-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "p.txt"), "p work\n");
  commitAll(worktreePath, "p", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}" -m "Loom-Worker-Branch: ${branch}"`, { cwd: repo });
  db.insertSession({ id: pId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: pId, taskId, kind: "merge_request", detail: { branch, filesChanged: 1, tip: branch, repoKey: null } });
  // P crashes here, before its own finalize — exactly as a crash-before-finalize leaves the worktree/branch.

  const fCreatedAt = new Date(Date.parse(now) + 10_000).toISOString();
  db.insertSession({ id: fId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: fCreatedAt, lastActivity: fCreatedAt, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, recycledFrom: null });
  db.appendEvent({ id: randomUUID(), ts: fCreatedAt, managerSessionId: mgrId, workerSessionId: fId, taskId, kind: "recycle_failed", detail: { recycledFrom: pId, failedSuccessorId: fId, error: "simulated spawn failure" } });
  return { projId, taskId, mgrId, pId, fId, worktreePath, branch, repo };
}

// Fixture Q: card e5458ccd item 2 — a BATCH landing (no `Loom-Landed-Tip` trailer at all; a batch cherry-
// picks each branch's own commits individually onto main). `verifyReviewedTipChain` cannot apply (it only
// walks two-parent merge-of-main commits) — attribution here goes through `recordedTipContentLanded`
// instead: X's own recorded tip is diffed against the landing's own `Loom-Worker-Base` trailer (the
// landed base, a real commit sha — `d62dad73`), never the live branch ref (which now belongs to Y).
async function setupRealRetaskOwnLandingBatchAttributable(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "worker_report", detail: { status: "done", summary: "x work" } });
  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x work\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD");
  const preLandSha = git(repo, "rev-parse HEAD"); // main's tip BEFORE landing X's change — the batch's own "Loom-Worker-Base"
  // Simulate a BATCH landing: cherry-pick X's own commit individually onto main (never a merge-of-main
  // commit — no Loom-Landed-Tip trailer), exactly as landBranchCommitsIndividually (batch-merge.ts) does.
  execSync(`git ${GIT_ID} cherry-pick --no-commit ${xTip}`, { cwd: repo });
  commitAll(repo, [`WRAP-${tag}-x`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${preLandSha}\nLoom-Worker-PathSet: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef`], GIT_ID);
  const xLandedSha = git(repo, "rev-parse HEAD");
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} }); // card 1ac74580: a real confirm genuinely reached its own landing write
  // X crashes here — worktree/branch left exactly as a crash before finalize leaves them.

  const second = await createWorktree(repo, projId, taskId); // re-task reuses X's exact path/branch
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
  commitAll(second.worktreePath, "y", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-y" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: repo });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo, xTip, xLandedSha };
}

// Fixture R: card e5458ccd — the branch name carries TWO distinct generations' trailer commits by the
// time reconcile runs (X's own older landing, Y's newer one — both REAL solo squashes with their own
// Loom-Landed-Tip). Proves the all-candidates scan never stops at the first/newest match:
// verifyReviewedTipChain correctly REJECTS Y's unrelated commit against X's own reviewed tip (not a merge
// of main from X's perspective) before trying X's own older candidate, which verifies.
async function setupRealRetaskTwoAttributableLandings(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x work\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD");
  execSync(`git ${GIT_ID} merge --squash ${first.branch}`, { cwd: repo });
  commitAll(repo, [`WRAP-${tag}-x`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${xTip}`], GIT_ID);
  const xLandedSha = git(repo, "rev-parse HEAD");
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} }); // card 1ac74580: a real confirm genuinely reached its own landing write
  // X crashes here.

  const second = await createWorktree(repo, projId, taskId); // re-task reuses X's exact path/branch name
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
  commitAll(second.worktreePath, "y", GIT_ID);
  const yTip = git(second.worktreePath, "rev-parse HEAD");
  // Y ALSO lands a full, realistic solo squash (its own Loom-Landed-Tip) — a SECOND, NEWER trailer commit
  // on the SAME branch name, unrelated to X's own reviewed tip.
  execSync(`git ${GIT_ID} merge --squash ${second.branch}`, { cwd: repo });
  commitAll(repo, [`WRAP-${tag}-y`, `Loom-Worker-Branch: ${second.branch}\nLoom-Landed-Tip: ${yTip}`], GIT_ID);
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch, tip: yTip } });
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo, xTip, xLandedSha };
}

// Fixture S: scope addition #2 (card e5458ccd) — Pass A2 was generation-blind. Stale X has its OWN
// UNRESOLVABLE merge_request (escalates in Pass A; no merge_done is ever filed for it). The CURRENT
// generation Y never files a merge_request of its own at all (e.g. a noChanges:true done report + a
// human moving the card) — yet the task is independently terminal from the start. Pre-fix: A2 would
// wrongly file a `merge_done` for X keyed on `detail.branch: s.branch` — the branch SHARED with Y —
// aliasing Y's own branch-scoped bookkeeping exactly as 21b53e6a's own Do-not forbids. Post-fix: A2 skips
// X outright (staleGeneration), leaving it exactly as Pass A's own escalation left it.
async function setupPassA2StaleGenerationBlindness(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: "deadbeef".padEnd(40, "0") } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} }); // card 1ac74580: a real confirm genuinely reached its own landing write

  const second = await createWorktree(repo, projId, taskId); // re-task reuses X's exact path/branch
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  // Y never files a merge_request of its own — the task is already "done" from insertTask above.
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo };
}

// Fixture T: Round 2 item 1 (Code Review 72b64bc9, BLOCKING) — the stale-generation scan must resolve the
// SAME stored mainline watermark ref Pass A uses, never bare "HEAD". X's own solo-squash landing (real
// Loom-Landed-Tip = xTip, a trivial hop-0 chain match) is committed onto a STRAY branch diverted from
// main, never onto main itself — only Y's own, later, independent landing is genuinely on main. The
// watermark is stamped to "main". Canonical is left diverted (checked out on the stray branch) at the
// instant reconcile runs — the exact precondition that makes a bare "HEAD" scan disagree with the
// resolved mainline ref. A correct, ref-scoped scan must never see the stray commit and must escalate X;
// the old bare-"HEAD" scan would wrongly attribute X to its own stray commit.
async function setupMainlineWatermarkScopedScan(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x work\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD");
  db.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: git(repo, "rev-parse HEAD") }));

  git(repo, "checkout -q -b strayT");
  execSync(`git ${GIT_ID} merge --squash ${first.branch}`, { cwd: repo });
  commitAll(repo, [`WRAP-${tag}-x`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${xTip}`], GIT_ID);
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} }); // card 1ac74580: a real confirm genuinely reached its own landing write
  // X crashes here — its own squash landed, but on the STRAY branch, never on main.

  git(repo, "checkout -q main"); // back to main — Y's own re-task and landing must be genuinely clean
  const second = await createWorktree(repo, projId, taskId); // re-task reuses X's exact path/branch
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
  commitAll(second.worktreePath, "y", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-y" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: repo });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });

  git(repo, "checkout -q strayT"); // divert canonical AGAIN — the precondition at the instant reconcile runs
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo, xTip };
}

// Fixture U: Round 2 item 3's own "a Q variant where main moves on an unrelated file" — main advances on
// a file X's own branch never touched, AFTER X's worktree forks but BEFORE X's batch landing runs, so
// `Loom-Worker-Base` (the landing's own recorded base) is AHEAD of X's true fork point. The two-dot
// `recordedBase..recordedTip` diff this card originally shipped would surface that unrelated file too and
// fail closed; the merge-base-scoped diff isolates X's own real delta and must still attribute.
async function setupBatchAttributionSurvivesUnrelatedMainMove(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId); // forks off main's CURRENT tip (T0)
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });

  // Main moves on a file X's own branch never touches, AFTER X forked (T0) but BEFORE X's own landing.
  fs.writeFileSync(path.join(repo, "unrelated.txt"), "main moved\n");
  commitAll(repo, "main: unrelated change", GIT_ID);

  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x work\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD");
  const preLandSha = git(repo, "rev-parse HEAD"); // T1 — main's tip AFTER the unrelated move, X's own Loom-Worker-Base
  execSync(`git ${GIT_ID} cherry-pick --no-commit ${xTip}`, { cwd: repo });
  commitAll(repo, [`WRAP-${tag}-x`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${preLandSha}\nLoom-Worker-PathSet: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef`], GIT_ID);
  const xLandedSha = git(repo, "rev-parse HEAD");
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} }); // card 1ac74580: a real confirm genuinely reached its own landing write
  // X crashes here.

  const second = await createWorktree(repo, projId, taskId); // re-task reuses X's exact path/branch
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
  commitAll(second.worktreePath, "y", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-y" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: repo });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo, xTip, xLandedSha };
}

// Fixture V: Round 3 item 1 (BLOCKING, Code Review e2f31180) — verifyReviewedTipChain's OWN reachability
// checks must use the resolved mainline watermark ref, never the function's own bare-"HEAD" default. The
// candidate SCAN was already ref-scoped in Round 2 (fixture T); this is the WALK *inside*
// verifyReviewedTipChain, a separate bare-"HEAD" site that scan fix never touched. X's branch unions with
// a FOREIGN branch (never main) before its own squash lands — the trailer records that UNION commit as
// Loom-Landed-Tip. Canonical is diverted onto the foreign branch ITSELF at reconcile time: a bare-"HEAD"
// walk sees the foreign merge partner as trivially "on HEAD" and wrongly certifies the union as clean
// (accepting unreviewed foreign content as part of X's accounted landing); a watermark-scoped walk
// correctly finds the foreign commit unreachable from the real "refs/heads/main" and escalates instead.
async function setupMainRefDivertedUnionTrap(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x work\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD");
  db.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: git(repo, "rev-parse HEAD") }));

  // A FOREIGN branch, never merged into main. X's worktree unions with IT instead of main — the walk must
  // reject this regardless of what canonical's bare HEAD happens to be checked out on.
  git(repo, "checkout -q -b foreignV");
  fs.writeFileSync(path.join(repo, "foreign.txt"), "foreign content\n");
  commitAll(repo, "foreign work", GIT_ID);
  const foreignTip = git(repo, "rev-parse HEAD");
  git(repo, "checkout -q main");
  execSync(`git ${GIT_ID} merge -q --no-edit ${foreignTip}`, { cwd: first.worktreePath });
  const unionTip = git(first.worktreePath, "rev-parse HEAD");

  // X "lands": squash the worktree's current diff onto main; the trailer records the UNION tip (never
  // xTip) as Loom-Landed-Tip — exactly what a HELD branch's union-before-squash would record.
  execSync(`git ${GIT_ID} merge --squash ${first.branch}`, { cwd: repo });
  commitAll(repo, [`WRAP-${tag}-x`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${unionTip}`], GIT_ID);
  const xLandedSha = git(repo, "rev-parse HEAD");
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} }); // card 1ac74580: a real confirm genuinely reached its own landing write
  // X crashes here.

  const second = await createWorktree(repo, projId, taskId); // re-task reuses X's exact path/branch
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
  commitAll(second.worktreePath, "y", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "WRAP-${tag}-y" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: repo });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });

  // Divert canonical HEAD onto the foreign branch itself, at the instant reconcile runs — the exact
  // precondition a bare-"HEAD" walk would accept.
  git(repo, "checkout -q foreignV");
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo, xTip, unionTip, foreignTip, xLandedSha };
}

// Fixture W: Round 3 item 4/5 — an unreadable mainline watermark (a row IS present but fails to parse)
// must be a transient no-op, never a one-shot escalation. X carries a genuinely attributable landing
// (trivial hop-0 Loom-Landed-Tip match, same shape as fixture M) — proving attribution is never even
// ATTEMPTED while the watermark can't be read, not merely that it fails.
async function setupStaleAttributionWatermarkUnreadable(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x work\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD");
  execSync(`git ${GIT_ID} merge --squash ${first.branch}`, { cwd: repo });
  commitAll(repo, [`WRAP-${tag}-x`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${xTip}`], GIT_ID);
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} }); // card 1ac74580: a real confirm genuinely reached its own landing write
  // The watermark row is PRESENT but fails to parse as a MainlineWatermark — "unreadable", never "absent".
  db.setMeta(mainlineWatermarkKey(projId, "primary"), "not valid json at all");
  // X crashes here.

  const second = await createWorktree(repo, projId, taskId); // re-task reuses X's exact path/branch
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  // Y has real work of its own (kept by Pass B / not reclaimed by Pass C) but never lands this boot — the
  // assertions below are scoped to X's own stale-path outcome only.
  fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
  commitAll(second.worktreePath, "y", GIT_ID);
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo, xTip };
}

// Fixture X: Round 3 item 4/5's second branch — a WELL-FORMED watermark naming a branch that no longer
// resolves (renamed/deleted) must ALSO be a transient no-op, same as the unreadable case above but via
// the OTHER early-return in attributeStaleGenerationOwnLanding.
async function setupStaleAttributionWatermarkUnresolvableRef(tag, repo) {
  initRepo(repo);
  const projId = `wrap-${tag}-proj-${sfx}`, agentId = `wrap-${tag}-agent-${sfx}`, taskId = `wrap-${tag}-task-${sfx}`;
  const mgrId = `wrap-${tag}-mgr-${sfx}`, workerXId = `wrap-${tag}-workerx-${sfx}`, workerYId = `wrap-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `WRAP-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `WRAP-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x work\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD");
  execSync(`git ${GIT_ID} merge --squash ${first.branch}`, { cwd: repo });
  commitAll(repo, [`WRAP-${tag}-x`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${xTip}`], GIT_ID);
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} }); // card 1ac74580: a real confirm genuinely reached its own landing write
  // A well-formed watermark row naming a branch that does not exist as a real ref in this repo.
  db.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "ghost-branch-never-created", sha: git(repo, "rev-parse HEAD") }));
  // X crashes here.

  const second = await createWorktree(repo, projId, taskId); // re-task reuses X's exact path/branch
  db.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
  commitAll(second.worktreePath, "y", GIT_ID);
  return { projId, taskId, mgrId, workerXId, workerYId, worktreePath: second.worktreePath, branch: second.branch, repo, xTip };
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
const R_REAL_RETASK_FINALIZED = path.join(os.tmpdir(), `loom-wrap-k-${sfx}`);
const R_REAL_RETASK_ABANDONED = path.join(os.tmpdir(), `loom-wrap-l-${sfx}`);
const R_REAL_RETASK_OWN_LANDING_OK = path.join(os.tmpdir(), `loom-wrap-m-${sfx}`);
const R_REAL_RETASK_OWN_LANDING_UNRESOLVABLE = path.join(os.tmpdir(), `loom-wrap-n-${sfx}`);
const R_FAILED_RECYCLE_PATH_ALIAS = path.join(os.tmpdir(), `loom-wrap-o-${sfx}`);
const R_REAL_RETASK_OWN_LANDING_DECIDED = path.join(os.tmpdir(), `loom-wrap-p-${sfx}`);
const R_REAL_RETASK_OWN_LANDING_BATCH_OK = path.join(os.tmpdir(), `loom-wrap-q-${sfx}`);
const R_REAL_RETASK_TWO_ATTRIBUTABLE = path.join(os.tmpdir(), `loom-wrap-r-${sfx}`);
const R_PASS_A2_STALE_BLINDNESS = path.join(os.tmpdir(), `loom-wrap-s-${sfx}`);
const R_MAINLINE_WATERMARK_SCAN = path.join(os.tmpdir(), `loom-wrap-t-${sfx}`);
const R_BATCH_UNRELATED_MAIN_MOVE = path.join(os.tmpdir(), `loom-wrap-u-${sfx}`);
const R_MAIN_REF_DIVERTED_UNION_TRAP = path.join(os.tmpdir(), `loom-wrap-v-${sfx}`);
const R_WATERMARK_UNREADABLE = path.join(os.tmpdir(), `loom-wrap-w-${sfx}`);
const R_WATERMARK_UNRESOLVABLE_REF = path.join(os.tmpdir(), `loom-wrap-x-${sfx}`);
const R_REVIEW_ONLY_NEVER_CONFIRMED = path.join(os.tmpdir(), `loom-wrap-y-${sfx}`);
const R_BATCH_FF_REFUSED = path.join(os.tmpdir(), `loom-wrap-z-${sfx}`);
let A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X, Y, Z;

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
  K = await setupRealRetaskFinalized("k", R_REAL_RETASK_FINALIZED);
  L = await setupRealRetaskAbandoned("l", R_REAL_RETASK_ABANDONED);
  M = await setupRealRetaskOwnLandingAttributable("m", R_REAL_RETASK_OWN_LANDING_OK);
  N = await setupRealRetaskOwnLandingUnresolvable("n", R_REAL_RETASK_OWN_LANDING_UNRESOLVABLE);
  O = await setupFailedRecyclePathAlias("o", R_FAILED_RECYCLE_PATH_ALIAS);
  P = await setupRealRetaskOwnLandingDecided("p", R_REAL_RETASK_OWN_LANDING_DECIDED);
  Q = await setupRealRetaskOwnLandingBatchAttributable("q", R_REAL_RETASK_OWN_LANDING_BATCH_OK);
  R = await setupRealRetaskTwoAttributableLandings("r", R_REAL_RETASK_TWO_ATTRIBUTABLE);
  S = await setupPassA2StaleGenerationBlindness("s", R_PASS_A2_STALE_BLINDNESS);
  T = await setupMainlineWatermarkScopedScan("t", R_MAINLINE_WATERMARK_SCAN);
  U = await setupBatchAttributionSurvivesUnrelatedMainMove("u", R_BATCH_UNRELATED_MAIN_MOVE);
  V = await setupMainRefDivertedUnionTrap("v", R_MAIN_REF_DIVERTED_UNION_TRAP);
  W = await setupStaleAttributionWatermarkUnreadable("w", R_WATERMARK_UNREADABLE);
  X = await setupStaleAttributionWatermarkUnresolvableRef("x", R_WATERMARK_UNRESOLVABLE_REF);
  Y = await setupRealRetaskReviewOnlyNeverConfirmed("y", R_REVIEW_ONLY_NEVER_CONFIRMED);
  Z = await setupRealRetaskOwnLandingBatchFfRefused("z", R_BATCH_FF_REFUSED);

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

  // --- pre-K/L/M/N sanity: the REAL re-task shape (a second createWorktree() call) lands Y on the EXACT
  // same stale path/branch X's own DB row still names, via a real git reuse/recut, not a sidestep. ---
  check("(pre-K) X's stale worktreePath equals Y's real (reused) worktreePath", K.worktreePath && db.getSession(K.workerXId).worktreePath === K.worktreePath);
  check("(pre-K) X's stale branch equals Y's real (reused) branch", K.branch && db.getSession(K.workerXId).branch === K.branch);
  check("(pre-K) X already has its OWN merge_done (a real prior finalize)", db.listEventsForWorker(K.workerXId).some((ev) => ev.kind === "merge_done"));
  check("(pre-K) Y has its OWN merge_request but no terminal event yet", db.listEventsForWorker(K.workerYId).some((ev) => ev.kind === "merge_request") && db.listEventsForWorker(K.workerYId).every((ev) => ev.kind !== "merge_done"));
  check("(pre-K) Y's worktree/branch are the live ones on disk", fs.existsSync(K.worktreePath) && branchExists(K.repo, K.branch));
  check("(pre-L) X's stale worktreePath equals Y's real (reused) worktreePath", L.worktreePath && db.getSession(L.workerXId).worktreePath === L.worktreePath);
  check("(pre-L) X has NO merge activity of its own at all (genuinely abandoned)", db.listEventsForWorker(L.workerXId).length === 0);
  check("(pre-L) Y has its OWN merge_request but no terminal event yet", db.listEventsForWorker(L.workerYId).some((ev) => ev.kind === "merge_request") && db.listEventsForWorker(L.workerYId).every((ev) => ev.kind !== "merge_done"));
  check("(pre-M) X's stale worktreePath equals Y's real (reused) worktreePath", M.worktreePath && db.getSession(M.workerXId).worktreePath === M.worktreePath);
  check("(pre-M) X's own landing (on main) carries the Loom-Landed-Tip trailer matching its OWN reviewed tip", git(M.repo, `log -1 --format=%B ${M.xLandedSha}`).includes(`Loom-Landed-Tip: ${M.xTip}`));
  check("(pre-M) X has its OWN merge_request (with its reviewed tip) but no merge_done yet", db.listEventsForWorker(M.workerXId).some((ev) => ev.kind === "merge_request" && ev.detail?.tip === M.xTip) && db.listEventsForWorker(M.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(pre-N) X has its OWN unverifiable merge_request but no merge_done yet", db.listEventsForWorker(N.workerXId).some((ev) => ev.kind === "merge_request") && db.listEventsForWorker(N.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(pre-O) P's worktree/branch present before reconcile", fs.existsSync(O.worktreePath) && branchExists(O.repo, O.branch));
  check("(pre-O) P has its OWN merge_request but no merge_done yet", db.listEventsForWorker(O.pId).some((ev) => ev.kind === "merge_request") && db.listEventsForWorker(O.pId).every((ev) => ev.kind !== "merge_done"));
  check("(pre-O) F is named as the failed successor on a recycle_failed event, and has NO merge activity of its own", db.listEventsForWorker(O.fId).some((ev) => ev.kind === "recycle_failed" && ev.detail?.failedSuccessorId === O.fId) && db.listEventsForWorker(O.fId).every((ev) => ev.kind !== "merge_request" && ev.kind !== "merge_done"));
  check("(pre-O) F's own recycledFrom is NULLED (the failed-recycle shape)", db.getSession(O.fId).recycledFrom == null);
  check("(pre-P) X's stale worktreePath equals Y's real (reused) worktreePath", P.worktreePath && db.getSession(P.workerXId).worktreePath === P.worktreePath);
  check("(pre-P) X's own merge_request is followed by its OWN merge_cancelled — the latest lifecycle event is NOT the merge_request", (() => {
    const evs = db.listEventsForWorker(P.workerXId).filter((ev) => ["merge_request", "merge_done", "merge_rejected", "merge_cancelled"].includes(ev.kind));
    return evs.length === 2 && evs[0].kind === "merge_request" && evs[1].kind === "merge_cancelled";
  })());
  check("(pre-Q) X's own BATCH landing (no Loom-Landed-Tip) carries Loom-Worker-Branch + Loom-Worker-Base", git(Q.repo, `log -1 --format=%B ${Q.xLandedSha}`).includes(`Loom-Worker-Branch: ${Q.branch}`) && !git(Q.repo, `log -1 --format=%B ${Q.xLandedSha}`).includes("Loom-Landed-Tip"));
  check("(pre-Q) X has its OWN worker_report(done) + merge_request, no merge_done yet", db.listEventsForWorker(Q.workerXId).some((ev) => ev.kind === "worker_report") && db.listEventsForWorker(Q.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(pre-R) the shared branch carries TWO distinct Loom-Worker-Branch trailer commits (X's + Y's)", git(R.repo, `log --format=%H -F --grep=${JSON.stringify(`Loom-Worker-Branch: ${R.branch}`)}`).trim().split("\n").filter(Boolean).length === 2);
  check("(pre-S) X's own merge_request is unresolvable (bogus tip), no merge_done yet", db.listEventsForWorker(S.workerXId).some((ev) => ev.kind === "merge_request") && db.listEventsForWorker(S.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(pre-S) task is ALREADY terminal, and Y never filed a merge_request of its own", db.getTask(S.taskId).columnKey === "done" && db.listEventsForWorker(S.workerYId).every((ev) => ev.kind !== "merge_request"));
  check("(pre-T) canonical is diverted to the STRAY branch at the instant reconcile is about to run", git(T.repo, "symbolic-ref --short HEAD") === "strayT");
  // The branch NAME is shared with Y (the re-task), so main legitimately carries Y's OWN trailer commit
  // for the same branch string — check the SPECIFIC Loom-Landed-Tip value (X's own xTip), not bare branch presence.
  check("(pre-T) the stray branch carries the commit whose Loom-Landed-Tip is X's own reviewed tip", git(T.repo, "log strayT --format=%B").includes(`Loom-Landed-Tip: ${T.xTip}`));
  check("(pre-T) main's own history carries NO such commit", !git(T.repo, "log main --format=%B").includes(`Loom-Landed-Tip: ${T.xTip}`));
  check("(pre-T) a watermark is stamped pointing at main", (() => { try { return JSON.parse(db.getMeta(mainlineWatermarkKey(T.projId, "primary"))).branch === "main"; } catch { return false; } })());
  check("(pre-U) main carries the unrelated-file commit made between X's fork and X's own landing", git(U.repo, "log --oneline main").includes("unrelated change"));
  check("(pre-U) X's own batch landing carries no Loom-Landed-Tip (content-match path)", !git(U.repo, `log -1 --format=%B ${U.xLandedSha}`).includes("Loom-Landed-Tip"));
  check("(pre-V) canonical is diverted onto the FOREIGN branch at the instant reconcile is about to run", git(V.repo, "symbolic-ref --short HEAD") === "foreignV");
  check("(pre-V) X's own landed trailer commit records the UNION tip (a merge with the foreign branch, never main)", git(V.repo, `show -s --format=%B ${V.xLandedSha}`).includes(`Loom-Landed-Tip: ${V.unionTip}`));
  // `^main` would be consumed by cmd.exe's caret-escape on Windows under execSync's shell — use
  // `merge-base --is-ancestor` (no caret) instead; it exits non-zero when NOT an ancestor.
  check("(pre-V) the foreign branch's own tip is NOT reachable from real main", (() => { try { git(V.repo, `merge-base --is-ancestor ${V.foreignTip} main`); return false; } catch { return true; } })());
  check("(pre-W) X's own landing is trivially attributable (hop-0 Loom-Landed-Tip match) IF the watermark could be read", git(W.repo, "log main --format=%B").includes(`Loom-Landed-Tip: ${W.xTip}`));
  check("(pre-W) the stored watermark row fails to parse as JSON", (() => { try { JSON.parse(db.getMeta(mainlineWatermarkKey(W.projId, "primary"))); return false; } catch { return true; } })());
  check("(pre-X) X's own landing is trivially attributable IF the watermark's branch resolved", git(X.repo, "log main --format=%B").includes(`Loom-Landed-Tip: ${X.xTip}`));
  check("(pre-X) the stored watermark names a branch that does not exist in this repo", !branchExists(X.repo, JSON.parse(db.getMeta(mainlineWatermarkKey(X.projId, "primary"))).branch));
  check("(pre-Y) X's stale worktreePath equals Y's real (reused) worktreePath", Y.worktreePath && db.getSession(Y.workerXId).worktreePath === Y.worktreePath);
  check("(pre-Y) X has its OWN merge_request (a real review happened) but NOTHING after it — no merge_landing_started, no terminal event", (() => {
    const evs = db.listEventsForWorker(Y.workerXId).filter((ev) => ["merge_request", "merge_landing_started", "merge_done", "merge_rejected", "merge_cancelled"].includes(ev.kind));
    return evs.length === 1 && evs[0].kind === "merge_request";
  })());
  check("(pre-Y) X's own real commit never reached main — a real review, never a real landing attempt", !git(Y.repo, "log main --format=%H").includes(Y.xTip));
  check("(pre-Z) X's lifecycle ends at the NEW merge_landing_aborted kind, after its own merge_landing_started", (() => {
    const kinds = db.listEventsForWorker(Z.workerXId).map((ev) => ev.kind);
    return kinds[kinds.length - 1] === "merge_landing_aborted" && kinds.includes("merge_landing_started") && kinds.includes("merge_request");
  })());

  // --- THE RECONCILE --- A's successor and C's successor are protected (about to be resumed); B/D/E are
  // not protected at all (abandoned/genuine crash). Session insertion order above is predecessor-then-
  // successor for both recycle chains — the fix must hold regardless of which aliased row a pass happens
  // to visit first, which is exactly why the protection set is built ONCE, up front, from ALL rows, rather
  // than decided per-row during iteration. `branchDeleteSpyFactory` (card 21b53e6a MINOR #4) is shared
  // across every fixture here — see its own header comment above.
  const r = await sessions.reconcileOrchestrationOnBoot(new Set([A.succId, C.succId]), { gitFactory: branchDeleteSpyFactory });

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

  // (K) card 21b53e6a, Tier A — a REAL re-task reused X's exact path/branch via a second createWorktree()
  // call. X is a stale generation (already finalized itself, long ago) and must be skipped outright; Y
  // (the current generation) finalizes normally, under its OWN id.
  check("(K) worktree IS finalized/removed, under Y's own processing", !fs.existsSync(K.worktreePath));
  check("(K) branch IS deleted, under Y's own processing", !branchExists(K.repo, K.branch));
  check("(K) task moved off in_progress (Y's own finalize ran)", db.getTask(K.taskId).columnKey !== "in_progress");
  check("(K) worker Y now has its OWN merge_done", db.listEventsForWorker(K.workerYId).some((ev) => ev.kind === "merge_done"));
  check("(K) worker X's events are UNTOUCHED — still exactly its one original merge_done, nothing new filed under its id", db.listEventsForWorker(K.workerXId).length === 1 && db.listEventsForWorker(K.workerXId)[0].kind === "merge_done");
  // MINOR #4 (Code Review 620da79c): the END-STATE checks above stay green even if X had wrongly run
  // the sibling-cleanup-only path first (it would be silent — X already has its own merge_done, so no
  // NEW event is filed either way, and the worktree/branch end up gone either way). The delete-attempt
  // COUNT is the only thing that discriminates: Y's own GENUINE finalize goes through `finalizeMerge`,
  // which never threads `gitFactory` at all (invisible to this spy either way) — but X's WRONGFUL
  // cleanup-only action (alreadyFinalized:true for X's own row, pre-fix) takes the SAME sibling
  // cleanup-only path fixture F exercises, which DOES thread `gitFactory`. So a correctly-skipped X
  // leaves ZERO recorded attempts for K's branch; RED-proofed against the pre-round-1 parent (service.ts
  // before card 21b53e6a's `currentGenerationIds`/staleGeneration existed at all): this check read 1,
  // not 0 (`git show 967be1e5~1:packages/daemon/src/sessions/service.ts`, rebuilt, this test re-run).
  check("(K) ZERO branch-delete attempts recorded for K's branch (X never ran the wrong-identity cleanup-only delete)",
    branchDeleteAttempts.filter((a) => a.args.some((x) => typeof x === "string" && x.includes(K.branch))).length === 0);
  // Round 3 item 4: a positive control for the check above — fixture F's own branch (a REAL sibling
  // cleanup-only delete, see (F) below) must record >=1 attempt on this SAME spy, proving the spy can
  // actually see a real delete rather than being a dead probe that would read 0 either way.
  check("(K positive control) fixture F's branch recorded >=1 delete attempt on the SAME spy — K's zero above is a true negative, not a dead probe",
    branchDeleteAttempts.filter((a) => a.args.some((x) => typeof x === "string" && x.includes(F.branch))).length >= 1);

  // (L) card 21b53e6a, Tier B — X is genuinely abandoned (no merge activity of its own at all). RED-proofed
  // against pre-fix code: X's early-out failed to fire (worktreeOnDisk read Y's live dir), X fell through
  // to a GENUINE finalizeMerge call under its own identity, misattributing Y's landing to X and PERMANENTLY
  // stranding Y's own merge_request (X's fresh merge_done outranked it by seq on every later boot).
  check("(L) worktree IS finalized/removed, under Y's own processing", !fs.existsSync(L.worktreePath));
  check("(L) branch IS deleted, under Y's own processing", !branchExists(L.repo, L.branch));
  check("(L) task moved off in_progress (Y's own finalize ran)", db.getTask(L.taskId).columnKey !== "in_progress");
  check("(L) worker Y now has its OWN merge_done (not misattributed to X)", db.listEventsForWorker(L.workerYId).some((ev) => ev.kind === "merge_done"));
  check("(L) worker X has NO events filed under its id at all — it was never touched", db.listEventsForWorker(L.workerXId).length === 0);

  // (M) card e5458ccd: round 2 escalated X despite an attributable landing; the generation-safe attribution
  // path now RESOLVES it instead — verified via verifyReviewedTipChain against X's OWN recorded tip,
  // recorded under X's OWN session id with `detail.branch: null` (never the shared branch).
  check("(M) worker X GETS a merge_done — attributed via the generation-safe path", db.listEventsForWorker(M.workerXId).some((ev) => ev.kind === "merge_done" && ev.detail?.branch === null && ev.detail?.staleGenerationAttributed === true));
  check("(M) that merge_done records X's OWN landed sha, not a guess", db.listEventsForWorker(M.workerXId).find((ev) => ev.kind === "merge_done")?.detail?.attributedLandedSha === M.xLandedSha);
  check("(M) worker X is NEVER tracked in the one-shot escalation store (attribution succeeded, nothing to escalate)", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== M.workerXId));
  check("(M) NO undelivered nudge was enqueued for X (attribution succeeded)", db.listUndeliveredQueuedMessages().filter((e) => e.workerSessionId === M.mgrId).length === 0);
  check("(M) worker Y is still independently finalized (current generation, unaffected)", db.listEventsForWorker(M.workerYId).some((ev) => ev.kind === "merge_done"));
  // Manager concern #1 (task-keyed readers): X's shared taskId must never leak into a BRANCH-scoped reader.
  check("(M) listEventsForBranch(branch, 'merge_done') returns ONLY Y's own event — X's null-branch attribution never aliases branch-scoped readers", db.listEventsForBranch(M.branch, "merge_done").every((ev) => ev.workerSessionId === M.workerYId));
  check("(M) task board state (mergedSha) reflects Y's OWN landing, not X's older one", db.getTask(M.taskId).mergedSha === git(M.repo, "rev-parse HEAD").slice(0, 7));
  // Manager concern #2 (name the resolver): deriveAwaitingReview (report-resolution.ts), reading X's OWN
  // session-scoped event list, is the reader that clears X's worker_report(done) out of awaitingReview
  // once it finds the null-branch merge_done AFTER it.
  check("(M) deriveAwaitingReview resolves X's own worker_report(done) via the null-branch merge_done", !deriveAwaitingReview(db.listEventsForWorker(M.workerXId)).awaitingReview);

  // (N) card 21b53e6a, manager-directed gap: a stale row with its OWN merge_request that can NEVER be
  // attributed (no commit anywhere carries its claimed tip) escalates ONCE rather than being silently
  // left unresolved forever — never a guess, never a fabricated merge_done.
  check("(N) worker X gets NO merge_done (unattributable — never guessed)", db.listEventsForWorker(N.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(N) tracked as escalated in the one-shot store", db.listStaleGenerationUnresolved().some((e) => e.sessionId === N.workerXId && e.escalated === true));
  check("(N) worker Y is unaffected by X's unresolved alert", db.listEventsForWorker(N.workerYId).some((ev) => ev.kind === "merge_done"));
  // Round 3 item 3 (N's twin of M's check above).
  check("(N) exactly ONE undelivered nudge enqueued to the manager (not the app_meta flag — the real durable message)",
    db.listUndeliveredQueuedMessages().filter((e) => e.workerSessionId === N.mgrId).length === 1);

  // (Y) card 1ac74580 — N's sibling, and the exact false-positive this card removes (real specimen: worker
  // 3a7b77c6 on card f900237d). X's merge_request has NOTHING after it at all — no merge_landing_started,
  // unlike N — so this is review-only: no-op. Pre-fix (bare "latest.kind !== merge_request" check, no
  // merge_landing_started distinction) this escalated X exactly like N — RED-proofed by temporarily
  // reverting the predicate above and re-running this file before restoring it (see this card's
  // worker_report for the before/after).
  check("(Y) worker X gets NO merge_done — never even attempted (no landing write was ever reached)", db.listEventsForWorker(Y.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(Y) worker X is NEVER tracked in the one-shot escalation store — review-only is a no-op, not an escalation", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== Y.workerXId));
  check("(Y) NO undelivered nudge was enqueued to the manager for X's review-only merge_request — THE discriminating assertion against fixture N immediately above", db.listUndeliveredQueuedMessages().filter((e) => e.workerSessionId === Y.mgrId).length === 0);
  check("(Y) worker X's own event log is completely untouched — still exactly its one original merge_request, nothing appended by reconcile at all", db.listEventsForWorker(Y.workerXId).length === 1);
  check("(Y) worker Y (the re-task) is still independently finalized, unaffected", db.listEventsForWorker(Y.workerYId).some((ev) => ev.kind === "merge_done"));

  // (Z) card b4080777 — X's lifecycle ends at merge_landing_aborted (a refused batch fast-forward's own
  // terminal event), a DECIDED outcome exactly like P's merge_cancelled — never attempted attribution,
  // never escalated. Pre-card (merge_landing_aborted didn't exist, so the query at the predicate's own
  // lifecycle read wouldn't even fetch it): X's lifecycle would read as ending at merge_landing_started,
  // triggering an attempted attribution that fails (no real landing exists for this fixture) and escalates
  // — RED-proofed by temporarily reverting the `listEventsForWorkerKinds` array edit (dropping
  // "merge_landing_aborted") and re-running this file.
  check("(Z) worker X gets NO merge_done — never attributed (no real landing exists for this fixture)", db.listEventsForWorker(Z.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(Z) worker X is NEVER tracked in the one-shot escalation store — a decided outcome never escalates", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== Z.workerXId));
  check("(Z) NO undelivered nudge was enqueued to the manager for X's aborted batch landing", db.listUndeliveredQueuedMessages().filter((e) => e.workerSessionId === Z.mgrId).length === 0);
  check("(Z) worker X's own event log is completely untouched by reconcile — still exactly its 3 original events", db.listEventsForWorker(Z.workerXId).length === 3);
  check("(Z) worker Y (the re-task) is still independently finalized, unaffected", db.listEventsForWorker(Z.workerYId).some((ev) => ev.kind === "merge_done"));

  // (Q) card e5458ccd item 2 — the BATCH-landing content-match path (no Loom-Landed-Tip at all).
  check("(Q) worker X GETS a merge_done via the content-match path (Loom-Worker-Base, never the live branch ref)", db.listEventsForWorker(Q.workerXId).some((ev) => ev.kind === "merge_done" && ev.detail?.branch === null && ev.detail?.attributedLandedSha === Q.xLandedSha));
  check("(Q) worker X is never tracked as escalated", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== Q.workerXId));
  check("(Q) worker Y is still independently finalized, unaffected", db.listEventsForWorker(Q.workerYId).some((ev) => ev.kind === "merge_done"));
  check("(Q) deriveAwaitingReview resolves X's own worker_report(done)", !deriveAwaitingReview(db.listEventsForWorker(Q.workerXId)).awaitingReview);
  check("(Q) listEventsForBranch(branch, 'merge_done') returns ONLY Y's own event", db.listEventsForBranch(Q.branch, "merge_done").every((ev) => ev.workerSessionId === Q.workerYId));

  // (R) card e5458ccd — TWO distinct trailer commits share the branch name; the all-candidates scan must
  // never stop at the first/newest (Y's, unrelated) match — it must keep trying until X's OWN older
  // candidate verifies.
  check("(R) worker X GETS a merge_done attributed to its OWN landed sha, never Y's newer one", db.listEventsForWorker(R.workerXId).some((ev) => ev.kind === "merge_done" && ev.detail?.attributedLandedSha === R.xLandedSha));
  check("(R) worker X is never tracked as escalated", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== R.workerXId));
  check("(R) worker Y is independently finalized under its OWN id, unaffected", db.listEventsForWorker(R.workerYId).some((ev) => ev.kind === "merge_done"));

  // (S) scope addition #2 (card e5458ccd) — Pass A2 must skip a stale row outright, never filing a
  // shared-branch-keyed merge_done for it even when the current generation never filed its own
  // merge_request at all.
  check("(S) worker X gets NO merge_done (Pass A's own attribution attempt failed — unresolvable tip)", db.listEventsForWorker(S.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(S) Pass A2 did NOT file a shared-branch-keyed merge_done for stale X", db.listEventsForBranch(S.branch, "merge_done").length === 0);
  check("(S) worker X has no new events beyond its original merge_request — A2 never touched it", db.listEventsForWorker(S.workerXId).filter((ev) => ev.kind === "merge_request" || ev.kind === "merge_done").length === 1);
  // Round 2 item 5: name Y's OWN side effects explicitly, not only the aggregate counts below.
  check("(S) Y's own worktree IS GC'd by Pass B (0 commits of its own, disposable)", !fs.existsSync(S.worktreePath));
  check("(S) Y's own branch IS reclaimed by Pass C (0 commits ahead ⇒ trivially merged)", !branchExists(S.repo, S.branch));

  // (T) Round 2 item 1 (BLOCKING): the stale-generation scan must scope to the stored mainline watermark
  // ref, never bare "HEAD" — canonical sits on the stray branch at reconcile time, and the only commit
  // carrying X's own trailer is on THAT stray branch, invisible to a scan correctly scoped to main.
  check("(T) worker X gets NO merge_done — the stray commit is invisible to a ref-scoped scan", db.listEventsForWorker(T.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(T) worker X is tracked as escalated (correctly could not verify)", db.listStaleGenerationUnresolved().some((e) => e.sessionId === T.workerXId && e.escalated === true));
  check("(T) worker Y is still independently finalized on main, unaffected by the divert", db.listEventsForWorker(T.workerYId).some((ev) => ev.kind === "merge_done"));
  check("(T) main's own ref never advanced past Y's own landing (the stray commit never leaked onto it)", !git(T.repo, "log --oneline main").includes(`WRAP-t-x`));

  // (U) Round 2 item 3: an unrelated main move strictly between X's fork and its own batch landing must
  // NOT defeat content-match attribution — the merge-base-scoped diff isolates X's own real delta.
  check("(U) worker X GETS a merge_done via content-match, despite main moving on an unrelated file", db.listEventsForWorker(U.workerXId).some((ev) => ev.kind === "merge_done" && ev.detail?.attributedLandedSha === U.xLandedSha));
  check("(U) worker X is never tracked as escalated", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== U.workerXId));
  check("(U) worker Y is still independently finalized, unaffected", db.listEventsForWorker(U.workerYId).some((ev) => ev.kind === "merge_done"));

  // (V) Round 3 item 1 (BLOCKING): verifyReviewedTipChain's OWN reachability walk must use the resolved
  // mainline watermark ref, never bare "HEAD" — the foreign-branch union must be rejected regardless of
  // what canonical's current checkout happens to be.
  check("(V) worker X gets NO merge_done — the foreign-branch union is correctly rejected, not certified", db.listEventsForWorker(V.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(V) worker X is tracked as escalated (correctly could not verify the chain)", db.listStaleGenerationUnresolved().some((e) => e.sessionId === V.workerXId && e.escalated === true));
  check("(V) worker Y is still independently finalized on main, unaffected", db.listEventsForWorker(V.workerYId).some((ev) => ev.kind === "merge_done"));

  // (W) Round 3 item 4: an unreadable watermark is a transient no-op, never a one-shot escalation — even
  // though X's own landing would have attributed trivially had the watermark been readable.
  check("(W) worker X gets NO merge_done (watermark unreadable — attribution never attempted)", db.listEventsForWorker(W.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(W) worker X is NEVER tracked in the one-shot escalation store (a transient read failure retries, it does not escalate)", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== W.workerXId));
  check("(W) NO undelivered nudge was enqueued for X's unreadable-watermark case", db.listUndeliveredQueuedMessages().filter((e) => e.workerSessionId === W.mgrId).length === 0);

  // (X) Round 3 item 4/5: a well-formed watermark naming an unresolvable ref is the SAME transient no-op,
  // via the other early-return branch.
  check("(X) worker X gets NO merge_done (watermark names an unresolvable ref — attribution never attempted)", db.listEventsForWorker(X.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(X) worker X is NEVER tracked in the one-shot escalation store", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== X.workerXId));
  check("(X) NO undelivered nudge was enqueued for X's unresolvable-ref case", db.listUndeliveredQueuedMessages().filter((e) => e.workerSessionId === X.mgrId).length === 0);

  // (P) card 21b53e6a ROUND 3 item 1 — X's OWN merge_request was already DECIDED (a real merge_cancelled
  // on record) before the re-task happened; this must NOT escalate at all — never tracked in the one-shot
  // store, never enqueues a nudge, and never files a merge_done. Pre-fix (bare `hasMergeRequest` check,
  // no lifecycle-order check) this fixture escalated X anyway — RED-proofed (see worker_report) by
  // temporarily reverting the lifecycle-order guard and re-running this file before restoring it.
  check("(P) worker X gets NO merge_done", db.listEventsForWorker(P.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(P) worker X is NEVER tracked in the one-shot escalation store (a decided outcome never escalates)", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== P.workerXId));
  check("(P) NO undelivered nudge was enqueued to the manager for X's decided merge_request", db.listUndeliveredQueuedMessages().filter((e) => e.workerSessionId === P.mgrId).length === 0);
  check("(P) worker Y is still independently finalized (current generation, unaffected)", db.listEventsForWorker(P.workerYId).some((ev) => ev.kind === "merge_done"));

  // (O) card 21b53e6a ROUND 2, MAJOR #3 — P (crash-orphaned before its own finalize) is the sole current
  // generation once F (a failed recycle successor sharing P's exact worktreePath/branch) is excluded
  // from currentGenerationIds; P finalizes NORMALLY under its own id. F never did any work of its own
  // (no merge_request), so it is a pure no-op — never touched, never escalated.
  check("(O) P's worktree IS finalized/removed under its OWN processing", !fs.existsSync(O.worktreePath));
  check("(O) P's branch IS deleted under its OWN processing", !branchExists(O.repo, O.branch));
  check("(O) task moved off in_progress (P's own finalize ran)", db.getTask(O.taskId).columnKey !== "in_progress");
  check("(O) P now has its OWN merge_done", db.listEventsForWorker(O.pId).some((ev) => ev.kind === "merge_done"));
  check("(O) F has no merge_done filed under its id — it was never processed as a landing at all", db.listEventsForWorker(O.fId).every((ev) => ev.kind !== "merge_done"));
  check("(O) F's own events are UNTOUCHED — still exactly its one recycle_failed event, nothing new filed under its id", db.listEventsForWorker(O.fId).length === 1);

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

  // S's own current-generation row (Y) never commits anything on its re-tasked branch — Pass B's
  // worktreeHasWork correctly reads it as disposable (0 commits, clean tree) exactly like B's, and Pass
  // C's `--merged` sweep correctly reclaims its branch too (a branch with zero commits of its own is
  // trivially identical to, hence merged into, main) — a genuine, expected side effect of S's own setup,
  // not a Pass A/A2 regression (S's whole point is Pass A2 never touching X; it says nothing about Y).
  check("(counts) exactly 3 worktrees pruned (B's + S's own Pass B GC + F's Pass A sibling-cleanup — A's aliased pair decided ONCE, not twice)", r.worktreesPruned === 3);
  check("(counts) exactly 2 branches reclaimed via Pass C's sweep (B + S — F's branch was CAS-deleted directly by Pass A, never Pass C)", r.branchesReclaimed === 2);
  check("(counts) A's protected worktree was NOT counted as a suspected-still-live left-on-disk failure either", r.worktreesLeftOnDiskSuspectedLive === 0);
  check("(counts) exactly 2 stale merges resolved (G's worker Y + I's worker Y — S's own A2-eligible row is skipped outright by the staleGeneration guard)", r.staleMergesResolved === 2);
  check("(counts) exactly 4 stale-generation own-landings escalated this boot (N + S's own X + T's own X + V's own X — M/Q/R/U attribute, W/X are transient no-ops, never escalated)", r.staleGenerationUnresolvedEscalated === 4);

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
  // (idem N) card 21b53e6a round 2: N is never "resolved" — it legitimately re-checks every boot (the
  // counter reflects "still unresolved this boot", same philosophy as mergeFailureDetails/wedgedThisBoot
  // elsewhere in this function); the ONE-SHOT guarantee is scoped to the NUDGE itself, not this count:
  // `attempts` bumps while `escalated` stays true, proving the second pass's own call exited before
  // re-sending (see resolveStaleGenerationOwnLanding's own doc).
  // Card 1ac74580: N's X now permanently carries its own merge_request PLUS the merge_landing_started
  // marker added for this fixture (a real confirm genuinely reached its landing write, it just never
  // verified) — exactly 2 events forever, never a 3rd (no merge_done, never re-filed on retry).
  check("(idem) N's worker X still has exactly its original merge_request + merge_landing_started and no merge_done, forever", db.listEventsForWorker(N.workerXId).length === 2 && db.listEventsForWorker(N.workerXId).every((ev) => ev.kind !== "merge_done"));
  // Round 3 item 3: the real proof the "no second nudge" claim above is true — count the ACTUAL durable
  // messages across BOTH passes (r and r2 combined), not just the app_meta flag's own attempts counter.
  check("(idem) N still has exactly ONE undelivered nudge after BOTH passes (no second enqueue on the retry)",
    db.listUndeliveredQueuedMessages().filter((e) => e.workerSessionId === N.mgrId).length === 1);
  check(
    "(idem) N's escalation entry stays one-shot (escalated:true, attempts bumped — the SECOND pass's own retry, no second nudge)",
    db.listStaleGenerationUnresolved().some((e) => e.sessionId === N.workerXId && e.escalated === true && e.attempts === 2),
  );
  // (idem Y) card 1ac74580: review-only stays a no-op FOREVER — the second pass must not retroactively
  // escalate it either (no `merge_landing_started` to re-check on retry, since no-op never enters the
  // one-shot store in the first place).
  check("(idem) Y's worker X still has exactly one merge_request and nothing else, forever", db.listEventsForWorker(Y.workerXId).length === 1);
  check("(idem) Y still has NO undelivered nudge after BOTH passes", db.listUndeliveredQueuedMessages().filter((e) => e.workerSessionId === Y.mgrId).length === 0);
  check("(idem) Y's worker X never enters the one-shot escalation store, even after a second pass", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== Y.workerXId));
  // (idem M/Q/R) card e5458ccd: attribution is ONE-SHOT via the SAME `alreadyFinalized` early-out every
  // legacy no-branch merge_done already used — the second pass must find X already finalized (via the
  // null-branch key) and never re-attempt attribution, never file a second event, never spawn git again.
  check("(idem) M's worker X still has exactly ONE merge_done after a second pass (early-out, no re-attribution)", db.listEventsForWorker(M.workerXId).filter((ev) => ev.kind === "merge_done").length === 1);
  check("(idem) M's worker X never appears in the escalation store after a second pass either (attributed, not escalated)", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== M.workerXId));
  check("(idem) M still has NO undelivered nudge after BOTH passes (attribution succeeded, no escalation)", db.listUndeliveredQueuedMessages().filter((e) => e.workerSessionId === M.mgrId).length === 0);
  check("(idem) Q's worker X still has exactly ONE merge_done after a second pass", db.listEventsForWorker(Q.workerXId).filter((ev) => ev.kind === "merge_done").length === 1);
  check("(idem) R's worker X still has exactly ONE merge_done after a second pass", db.listEventsForWorker(R.workerXId).filter((ev) => ev.kind === "merge_done").length === 1);
  check("(idem) S's worker X still has no merge_done, and A2 still never touched it on the second pass either", db.listEventsForWorker(S.workerXId).every((ev) => ev.kind !== "merge_done") && db.listEventsForBranch(S.branch, "merge_done").length === 0);
  check("(idem) T's worker X still has no merge_done, forever (the stray commit never becomes visible)", db.listEventsForWorker(T.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(idem) U's worker X still has exactly ONE merge_done after a second pass", db.listEventsForWorker(U.workerXId).filter((ev) => ev.kind === "merge_done").length === 1);
  check("(idem) V's worker X still has no merge_done, forever (the foreign-branch union never becomes valid)", db.listEventsForWorker(V.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(idem) W's worker X still has no merge_done after a second pass (still watermark-unreadable, never escalated)", db.listEventsForWorker(W.workerXId).every((ev) => ev.kind !== "merge_done") && db.listStaleGenerationUnresolved().every((e) => e.sessionId !== W.workerXId));
  check("(idem) X's worker X still has no merge_done after a second pass (still watermark-unresolvable, never escalated)", db.listEventsForWorker(X.workerXId).every((ev) => ev.kind !== "merge_done") && db.listStaleGenerationUnresolved().every((e) => e.sessionId !== X.workerXId));
  check("(idem) O's worker P stays finalized (no re-finalize), F still untouched", db.listEventsForWorker(O.pId).filter((ev) => ev.kind === "merge_done").length === 1 && db.listEventsForWorker(O.fId).length === 1);
  check("(idem) P's worker X still never escalated, forever (a decided outcome never escalates on retry either)", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== P.workerXId) && db.listUndeliveredQueuedMessages().filter((e) => e.workerSessionId === P.mgrId).length === 0);
} finally {
  db.close();
  for (const p of [A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U]) {
    if (!p) continue;
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot-reconcile Pass B now keys liveness protection on the WORKTREE (not the iterated session row): a worker_recycle chain's dangling predecessor can no longer reap the live/protected successor's worktree, and Pass C's existing checked-out-elsewhere gate then correctly reads that intact state and keeps the branch too — while a genuinely-abandoned chain with no protection anywhere is still cleaned up normally. Pass A now shares that SAME path-based protection (card 9ac3a739): a landed recycle chain's dangling predecessor can no longer finalize through a protected successor's shared worktree/branch, an abandoned landed chain is still finalized normally, and keying \"already finalized\" on the specific landing (not the mere presence of any merge_done for the branch) still finishes a second landing's crash-orphan even when an earlier landing on the same branch already has its own merge_done. ROUND 2: \"already finalized\" is now DB event SEQ order (never git commit time, never ts/rowid), repo-scoped, and checked AFTER isBranchHeld — a dangling predecessor whose branch was already finalized through a sibling row now runs a cleanup-only path (gc the dir + a CAS branch delete) instead of a full finalize. (Card e34d475c: an own-row cleanup retry — merge_done present, worktree still on disk — now runs that SAME cleanup-only path too, instead of the ordinary finalizeMerge call this round originally routed it through; see that card's own record.) The identical seq rule now also drives Pass A2's branch-gone resolver, fixing a re-task case where an OLDER, unrelated merge_done on a reused branch name could strand a LATER worker's own still-unresolved merge_request forever. ROUND 3: `latestEventSeqForBranch`'s own repoKey filter is now exercised directly (not just `isBranchHeld`'s) — a merge_done scoped to a DIFFERENT repo can no longer satisfy a dangling predecessor's own primary-scope finalize (Pass A now runs the genuine full finalize instead of a wrong cleanup-only skip) nor a sibling worker's own primary-scope merge_request (Pass A2 still fires its own reconciling merge_done, now correctly stamped with that worker's own repoKey). ROUND 3 item 3: the cleanup-only path itself now checks the live tip against the landed one BEFORE touching anything — a branch that moved after a sibling's finalize is KEPT (nothing removed, nothing deleted) and a merge_branch_retained notice is filed, exactly like a solo finalize's own tip guard."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
