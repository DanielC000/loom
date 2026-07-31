import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 31df7e2f: the GC guard (worktreeHasWork) is CORRECT — it fails safe and keeps a worktree that
// still holds real work. The gap this card closes is OBSERVABILITY: `worktreesKept` used to surface as
// only a single boot-time console line, with no per-worktree detail and nothing queryable. This test
// proves the new `SessionService.getRetainedWorktrees()` surface:
//   (a) an UNMERGED-COMMIT worktree is reported with reason "unmerged-commits", a real commitsAhead, and
//       an age derived from the owning session's (backdated) lastActivity.
//   (b) a DIRTY (uncommitted) worktree is reported with reason "dirty-tree".
//   (c) NEGATIVE CONTROL: a clean, genuinely-merged worktree does NOT appear (it's reclaimed by Pass A
//       anyway, but this proves the surface doesn't just list everything).
//   (d) POSITIVE CONTROL FOR EXCLUSION: a PROTECTED (still-live) worker's worktree, holding a REAL
//       unmerged commit, is STILL absent — proving the surface reflects Pass B's actual retained set
//       (exited + unprotected + kept), not "every worktree with unmerged commits".
// worktreeHasWork itself is untouched — this test never calls it directly; it only proves the new
// read-time-derived reporting surface built on top of Pass B's existing keep decision.
// REAL git on temp repos, NO claude + NO live daemon. Run: 1) build daemon, 2) node test/worktree-retained-backlog.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wrb-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService, filterRetainedWorktreesByProject } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wrb@loom -c user.name=wrb";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

function seed(p, { lastActivity, protect }) {
  db.insertProject({ id: p.projId, name: p.projName, repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "WRB-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // A "live" worker (case d) is exited too — recoverStaleSessions marks EVERY prior-run session `exited`
  // at boot; what actually protects it is `protectedSessionIds`, passed explicitly to the reconcile call.
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
  if (protect) p.protectedSessionIds.add(p.workerId);
}

function initRepo(repo, readme) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), readme);
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

async function setupUnmergedCommit(p, ageDaysBack) {
  initRepo(p.repo, "# wrb unmerged-commit\n");
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "committed to branch, not merged\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p, { lastActivity: daysAgo(ageDaysBack) });
}

async function setupDirty(p, ageDaysBack) {
  initRepo(p.repo, "# wrb dirty\n");
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.mkdirSync(path.join(worktreePath, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "src", p.file), "uncommitted work\n"); // untracked, never committed
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p, { lastActivity: daysAgo(ageDaysBack) });
}

async function setupMerged(p) {
  initRepo(p.repo, "# wrb merged\n");
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "real merged work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });
  execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "WRB-TASK" -m "Loom-Worker-Branch: ${branch}"`, { cwd: p.repo });
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p, { lastActivity: daysAgo(1) });
}

async function setupProtectedLive(p) {
  initRepo(p.repo, "# wrb protected-live\n");
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "real in-flight commit on a live worker\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p, { lastActivity: now, protect: true });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (tag, file) => ({
  projId: `wrb-${tag}-proj-${sfx}`, projName: `WRB-${tag.toUpperCase()}-${sfx}`, agentId: `wrb-${tag}-top-${sfx}`, taskId: `wrb-${tag}-task-${sfx}`,
  mgrId: `wrb-${tag}-mgr-${sfx}`, workerId: `wrb-${tag}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-wrb-${tag}-${sfx}`), file, protectedSessionIds: null,
});
// A and B belong to TWO DIFFERENT PROJECTS (distinct projId + projName) — this is what lets this test
// observe the projectId/projectName attribution bug (card fixing 90fffe03): a single-project fixture
// can't tell "attributed to the right project" apart from "attributed to A project".
const A = mk("a", "feat.txt");   // unmerged commit, 5 days stale
const B = mk("b", "work.txt");   // dirty/uncommitted, 2 days stale
const C = mk("c", "done.txt");   // clean merged — negative control
const D = mk("d", "live.txt");   // protected live worker with real unmerged commits — exclusion control

const protectedSessionIds = new Set();
for (const p of [A, B, C, D]) p.protectedSessionIds = protectedSessionIds;

try {
  await setupUnmergedCommit(A, 5);
  await setupDirty(B, 2);
  await setupMerged(C);
  await setupProtectedLive(D);

  const r = await sessions.reconcileOrchestrationOnBoot(protectedSessionIds);
  check("(pre) reconcile kept exactly 2 worktrees (A unmerged-commit + B dirty)", r.worktreesKept === 2);
  check("(pre) reconcile finished 1 merge (C)", r.mergesFinished === 1);
  check("(pre) C's worktree was actually removed", !fs.existsSync(C.worktreePath));
  check("(pre) D (protected) worktree untouched, still on disk", fs.existsSync(D.worktreePath));

  const { count, entries } = await sessions.getRetainedWorktrees();
  const byPath = new Map(entries.map((e) => [e.worktreePath, e]));

  check("count matches entries.length", count === entries.length);
  check("exactly 2 entries reported (A + B only)", entries.length === 2);

  // (a) unmerged-commit worktree — full shape check.
  const a = byPath.get(A.worktreePath);
  check("(a) unmerged-commit worktree PRESENT", !!a);
  if (a) {
    check("(a) reason=unmerged-commits", a.reason === "unmerged-commits");
    check("(a) commitsAhead >= 1", typeof a.commitsAhead === "number" && a.commitsAhead >= 1);
    check("(a) branch matches", a.branch === A.branch);
    check("(a) sessionId matches the worker", a.sessionId === A.workerId);
    check("(a) taskId matches", a.taskId === A.taskId);
    // AGE SIGNAL (card 31df7e2f item 2) — derived from the owning session's (backdated) lastActivity.
    check(`(a) ageDays reflects the 5-day-backdated lastActivity (got ${a.ageDays})`, a.ageDays >= 4 && a.ageDays <= 6);
    // PROJECT ATTRIBUTION (card fixing 90fffe03) — A and B are DIFFERENT projects; this asserts a is
    // attributed to ITS OWN project, not merely to A project (the bug: 40 entries, 2 misattributed).
    check("(a) projectId matches A's OWN project", a.projectId === A.projId);
    check("(a) projectName matches A's OWN project", a.projectName === A.projName);
    check("(a) projectId is NOT B's project", a.projectId !== B.projId);
  }

  // (b) dirty/uncommitted worktree.
  const b = byPath.get(B.worktreePath);
  check("(b) dirty worktree PRESENT", !!b);
  if (b) {
    check("(b) reason=dirty-tree", b.reason === "dirty-tree");
    check(`(b) ageDays reflects the 2-day-backdated lastActivity (got ${b.ageDays})`, b.ageDays >= 1 && b.ageDays <= 3);
    // PROJECT ATTRIBUTION — b must carry ITS OWN (different) project, never A's.
    check("(b) projectId matches B's OWN project", b.projectId === B.projId);
    check("(b) projectName matches B's OWN project", b.projectName === B.projName);
    check("(b) projectId is NOT A's project", b.projectId !== A.projId);
  }

  // (c) NEGATIVE CONTROL: clean merged worktree — never appears (already reclaimed, and even if it
  // somehow lingered it holds no work).
  check("(c) NEGATIVE CONTROL — clean merged worktree ABSENT from the surface", !byPath.has(C.worktreePath));

  // (d) POSITIVE CONTROL FOR EXCLUSION: a real, unmerged, still-on-disk worktree that is ABSENT only
  // because its session is PROTECTED (live) — proves the surface is Pass B's retained set, not a blanket
  // "any worktree with unmerged commits" scan.
  check("(d) EXCLUSION CONTROL — protected live worker's worktree ABSENT despite real unmerged commits", !byPath.has(D.worktreePath));

  // --- `?projectId=` filter (mgr review on card fixing 90fffe03: the filter ITSELF needs coverage, not
  // just per-entry attribution — an untested filter that silently returns an empty/wrong set to a human
  // doing a destructive reclaim is a second instance of the exact bug this card fixes). Exercised via the
  // pure predicate that backs the route (`filterRetainedWorktreesByProject`), not real HTTP scaffolding —
  // the route itself is a one-line pass-through to this function.
  const full = { count, entries };

  // (1) filtering by A's project returns A's entry and EXCLUDES B's — BOTH directions asserted. A
  // one-sided check ("A is present") alone would also pass a filter that returns everything unfiltered;
  // a one-sided "B is absent" alone would also pass a filter that always returns nothing.
  const byA = filterRetainedWorktreesByProject(full, A.projId);
  check("(filter) byA count matches entries.length", byA.count === byA.entries.length);
  check("(filter) byA INCLUDES A's entry", byA.entries.some((e) => e.worktreePath === A.worktreePath));
  check("(filter) byA EXCLUDES B's entry", !byA.entries.some((e) => e.worktreePath === B.worktreePath));

  // (2) a projectId matching NOTHING returns a real, well-formed empty set — distinguishable from a
  // silent error or an accidental fall-through to the unfiltered set.
  const byNobody = filterRetainedWorktreesByProject(full, "wrb-no-such-project-at-all");
  check("(filter) unknown projectId returns count 0", byNobody.count === 0);
  check("(filter) unknown projectId returns entries:[] (not an error, not the full unfiltered set)", Array.isArray(byNobody.entries) && byNobody.entries.length === 0);

  // (3) THE INVARIANT THE CARD CARES ABOUT MOST: omitting the param returns the full daemon-wide set,
  // byte-identical to the unfiltered call — narrowing must never be the default or mandatory.
  const omitted = filterRetainedWorktreesByProject(full, undefined);
  check("(filter) omitted projectId returns the SAME count as the unfiltered read", omitted.count === full.count);
  check("(filter) omitted projectId returns entries byte-identical to the unfiltered read", JSON.stringify(omitted.entries) === JSON.stringify(full.entries));
  check("(filter) omitted projectId returns the SAME object reference (no narrowing copy at all)", omitted === full);

  // --- idempotent second read: re-deriving at read time gives the same answer without another boot ---
  const second = await sessions.getRetainedWorktrees();
  check("(idem) a second read (no new boot) reports the same 2 entries", second.count === 2);

  // --- read-time truth: cleaning up A by hand (simulating a human GC'ing it) removes it from the NEXT
  // read WITHOUT a new boot/reconcile — proves this isn't a boot-time-cached snapshot.
  fs.rmSync(A.worktreePath, { recursive: true, force: true });
  const afterManualCleanup = await sessions.getRetainedWorktrees();
  check("(read-time) A no longer reported after being removed by hand, no new boot needed", !afterManualCleanup.entries.some((e) => e.worktreePath === A.worktreePath));
  check("(read-time) B still reported (untouched)", afterManualCleanup.entries.some((e) => e.worktreePath === B.worktreePath));
} finally {
  db.close();
  for (const p of [A, B, C, D]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the retained-worktree backlog is queryable (getRetainedWorktrees), reports per-entry reason + age derived at READ time (not a boot-time cache), and correctly EXCLUDES a clean/merged worktree and a protected-live worker's worktree — it reflects Pass B's actual retained set, not everything with unmerged commits."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
