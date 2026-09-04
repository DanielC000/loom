import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ba41b402 defect 1: a worker STOPPED (archived) before its work was merged is otherwise invisible
// to worker_list — archiveOnExit archives every exited worker-role session unconditionally, and
// listWorkers/fleetView filter archived_at IS NULL. This proves the new
// `SessionService.getDanglingWorkers()` surface (wired into fleetView as an ADDITIVE `processState:
// "dangling"` row, same convention as the existing pendingSpawn/cap-queued placeholders):
//
//   (A) TASKED, genuinely unmerged (task.mergedSha null) + a real commit on the branch → APPEARS.
//   (B) TASKED, but the TASK already shows a mergedSha (simulating a sibling branch or a superseding fix
//       having shipped the task under a DIFFERENT branch — measured for real on this project: 334766209ca5/
//       519072235f5d's content landed as 049954da61c5, and fe8f48e20cde's task was resolved by
//       f5994214094c, neither same-named nor same-diff) → EXCLUDED, regardless of THIS branch's own
//       content — the discriminator is the task, not the branch.
//   (C) TASKLESS, ZERO commits ahead of main (the Code-Reviewer-rig shape: spawned taskless by
//       convention, filesChanged:0 is its CORRECT outcome) → EXCLUDED. This is the manager-REQUIRED fix:
//       "always surface taskless" would permanently flag every code review as dangling.
//   (D) TASKLESS, WITH a real commit ahead of main → APPEARS (the other half of the required test — a
//       build that surfaces nothing at all would also pass a test that only covers (C)).
//   (E) EXISTENCE CHECK: an (A)-shaped fixture whose worktree dir is removed from disk before the read →
//       EXCLUDED — current truth, not a stale snapshot (closes the open item: nothing else deletes a
//       stopped-but-unmerged worktree outside of an actual merge, but a human/later-GC cleanup must still
//       drop the row on the next read with no new boot needed).
//   (F) NEGATIVE CONTROL: a LIVE (never archived) worker, same unmerged shape as (A) → EXCLUDED — only
//       an archived candidate qualifies at all; this proves the surface isn't just "any unmerged branch".
//   (G) LINEAGE: an archived worker parented to a RECYCLED PREDECESSOR manager (the exact incident shape —
//       a manager recovering a branch its own earlier session had stopped) → still APPEARS to the
//       successor querying it (lineage-tolerant, mirrors orchestration.ts's archivedUnreported category).
//   (H) CROSS-LINEAGE NEGATIVE CONTROL: an archived worker parented to a COMPLETELY UNRELATED manager →
//       EXCLUDED from this manager's view.
//
// REAL git on temp repos, NO claude + NO live daemon. Run: 1) build daemon, 2) node test/worker-list-dangling.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wld-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wld@loom -c user.name=wld";

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function initRepo(repo, readme) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), readme);
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

function commitToBranch(worktreePath, file) {
  fs.writeFileSync(path.join(worktreePath, file), "committed to branch, not merged\n");
  commitAll(worktreePath, `${file}`, GIT_ID);
}

// mk(tag) allocates a fresh, isolated project + repo + id set for one scenario.
const mk = (tag) => ({
  tag,
  projId: `wld-${tag}-proj-${sfx}`, projName: `WLD-${tag.toUpperCase()}-${sfx}`,
  agentId: `wld-${tag}-agent-${sfx}`, taskId: `wld-${tag}-task-${sfx}`,
  mgrId: `wld-${tag}-mgr-${sfx}`, workerId: `wld-${tag}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-wld-${tag}-${sfx}`),
});

function seedProject(p) {
  db.insertProject({ id: p.projId, name: p.projName, repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({
    id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
}

function seedWorker(p, { worktreePath, branch, taskId, archived, parentId }) {
  if (taskId) {
    db.insertTask({ id: taskId, projectId: p.projId, title: "WLD-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  }
  db.insertSession({
    id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: worktreePath,
    processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: parentId ?? p.mgrId, taskId: taskId ?? null,
    worktreePath, branch,
  });
  // insertSession does NOT bind archived_at at all (verified by reading its INSERT column list — not a
  // silent-no-op assumption) — archiving is a distinct write, mirroring how archiveOnExit itself is a
  // separate UPDATE after the row already exists.
  if (archived) db.archiveSession(p.workerId);
}

const A = mk("a"); // tasked, genuinely unmerged
const B = mk("b"); // tasked, task already merged (different branch/fix shipped it)
const C = mk("c"); // taskless, zero commits (Code Reviewer shape)
const D = mk("d"); // taskless, with commits
const E = mk("e"); // existence check: worktree removed from disk
const F = mk("f"); // negative control: live (never archived)
const G = mk("g"); // lineage: predecessor-owned, successor queries
const H = mk("h"); // cross-lineage negative control — a DIFFERENT MANAGER in G's SAME project (the
// scoping question is manager-lineage, not project), so H reuses G's project/agent rather than its own
// freshly-minted (and never-inserted) ones.
H.projId = G.projId;
H.agentId = G.agentId;

try {
  // --- (A) tasked, genuinely unmerged ---
  seedProject(A);
  initRepo(A.repo, "# wld-a\n");
  { const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    commitToBranch(worktreePath, "a.txt");
    seedWorker(A, { worktreePath, branch, taskId: A.taskId, archived: true }); A.worktreePath = worktreePath; }

  // --- (B) tasked, task already shows a mergedSha (a DIFFERENT branch/fix shipped it) ---
  seedProject(B);
  initRepo(B.repo, "# wld-b\n");
  { const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    commitToBranch(worktreePath, "b.txt");
    seedWorker(B, { worktreePath, branch, taskId: B.taskId, archived: true }); B.worktreePath = worktreePath;
    db.updateTask(B.taskId, { mergedSha: "abc1234" }); }

  // --- (C) taskless, ZERO commits ahead of main ---
  seedProject(C);
  initRepo(C.repo, "# wld-c\n");
  { const { worktreePath, branch } = await createWorktree(C.repo, C.projId, `wld-c-wt-${sfx}`);
    // no commit — the branch sits exactly at the repo's HEAD (the Code-Reviewer taskless shape)
    seedWorker(C, { worktreePath, branch, taskId: null, archived: true }); C.worktreePath = worktreePath; }

  // --- (D) taskless, WITH a real commit ahead of main ---
  seedProject(D);
  initRepo(D.repo, "# wld-d\n");
  { const { worktreePath, branch } = await createWorktree(D.repo, D.projId, `wld-d-wt-${sfx}`);
    commitToBranch(worktreePath, "d.txt");
    seedWorker(D, { worktreePath, branch, taskId: null, archived: true }); D.worktreePath = worktreePath; }

  // --- (E) existence check: same shape as (A), but its worktree dir is gone by read time ---
  seedProject(E);
  initRepo(E.repo, "# wld-e\n");
  { const { worktreePath, branch } = await createWorktree(E.repo, E.projId, E.taskId);
    commitToBranch(worktreePath, "e.txt");
    seedWorker(E, { worktreePath, branch, taskId: E.taskId, archived: true }); E.worktreePath = worktreePath; }

  // --- (F) negative control: LIVE worker (never archived), same unmerged shape as (A) ---
  seedProject(F);
  initRepo(F.repo, "# wld-f\n");
  { const { worktreePath, branch } = await createWorktree(F.repo, F.projId, F.taskId);
    commitToBranch(worktreePath, "f.txt");
    seedWorker(F, { worktreePath, branch, taskId: F.taskId, archived: false }); F.worktreePath = worktreePath; }

  // --- (G)/(H) lineage: ONE project, THREE managers — a predecessor (OLD), its recycled successor
  // (NEW, recycledFrom OLD) which does the querying, and a genuinely unrelated third manager (OTHER).
  seedProject(G);
  db.insertSession({
    id: `${G.mgrId}-old`, projectId: G.projId, agentId: G.agentId, engineSessionId: null, title: null, cwd: G.repo,
    processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  db.insertSession({
    id: `${G.mgrId}-new`, projectId: G.projId, agentId: G.agentId, engineSessionId: null, title: null, cwd: G.repo,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", recycledFrom: `${G.mgrId}-old`,
  });
  db.insertSession({
    id: `${H.mgrId}-other`, projectId: G.projId, agentId: G.agentId, engineSessionId: null, title: null, cwd: G.repo,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  initRepo(G.repo, "# wld-g\n");
  { const { worktreePath, branch } = await createWorktree(G.repo, G.projId, G.taskId);
    commitToBranch(worktreePath, "g.txt");
    seedWorker(G, { worktreePath, branch, taskId: G.taskId, archived: true, parentId: `${G.mgrId}-old` }); G.worktreePath = worktreePath; }
  { const { worktreePath, branch } = await createWorktree(G.repo, G.projId, H.taskId);
    commitToBranch(worktreePath, "h.txt");
    seedWorker(H, { worktreePath, branch, taskId: H.taskId, archived: true, parentId: `${H.mgrId}-other` }); H.worktreePath = worktreePath; }

  // ============================== assertions ==============================

  const a = await sessions.getDanglingWorkers(A.mgrId);
  check("(A) tasked genuinely-unmerged worker APPEARS", a.some((e) => e.workerSessionId === A.workerId));
  const aEntry = a.find((e) => e.workerSessionId === A.workerId);
  check("(A) reports the correct branch", aEntry?.branch && aEntry.branch.length > 0);
  check("(A) reports the correct taskId", aEntry?.taskId === A.taskId);
  check("(A) reports the correct worktreePath", aEntry?.worktreePath === A.worktreePath);

  const b = await sessions.getDanglingWorkers(B.mgrId);
  check("(B) tasked-but-task-already-merged worker EXCLUDED (task-level mergedSha wins over this branch's own content)",
    !b.some((e) => e.workerSessionId === B.workerId));

  const c = await sessions.getDanglingWorkers(C.mgrId);
  check("(C) taskless + ZERO commits (Code-Reviewer shape) EXCLUDED — the manager-required fix",
    !c.some((e) => e.workerSessionId === C.workerId));

  const d = await sessions.getDanglingWorkers(D.mgrId);
  check("(D) taskless + WITH commits APPEARS — proves (C)'s exclusion isn't just 'taskless always excluded'",
    d.some((e) => e.workerSessionId === D.workerId));
  // (D) again — the taskless git-rev-list result is memoized per (sessionId, archivedAt); a repeat call
  // must still correctly include D from the CACHED value, not merely from a second live git call.
  const dAgain = await sessions.getDanglingWorkers(D.mgrId);
  check("(D) a SECOND call still APPEARS (exercises the memoized commitsAheadOfMain path)",
    dAgain.some((e) => e.workerSessionId === D.workerId));

  // (E) precondition: appears before cleanup, exactly like (A).
  const eBefore = await sessions.getDanglingWorkers(E.mgrId);
  check("(E) precondition — appears BEFORE its worktree is removed", eBefore.some((e) => e.workerSessionId === E.workerId));
  fs.rmSync(E.worktreePath, { recursive: true, force: true });
  const eAfter = await sessions.getDanglingWorkers(E.mgrId);
  check("(E) EXCLUDED after its worktree is removed by hand, no new boot needed (current truth)",
    !eAfter.some((e) => e.workerSessionId === E.workerId));

  const f = await sessions.getDanglingWorkers(F.mgrId);
  check("(F) NEGATIVE CONTROL — a LIVE (never archived) worker with the same unmerged shape as (A) is EXCLUDED",
    !f.some((e) => e.workerSessionId === F.workerId));

  const g = await sessions.getDanglingWorkers(`${G.mgrId}-new`);
  check("(G) LINEAGE — an archived worker parented to a recycled PREDECESSOR still APPEARS to the successor",
    g.some((e) => e.workerSessionId === G.workerId));
  check("(G) does NOT also surface (H)'s unrelated-manager worker", !g.some((e) => e.workerSessionId === H.workerId));

  const hFromG = await sessions.getDanglingWorkers(`${H.mgrId}-other`);
  check("(H) CROSS-LINEAGE CONTROL — the unrelated manager sees its OWN worker", hFromG.some((e) => e.workerSessionId === H.workerId));
  check("(H) but NOT (G)'s predecessor-owned worker", !hFromG.some((e) => e.workerSessionId === G.workerId));
} finally {
  db.close();
  for (const p of [A, B, C, D, E, F, G, H]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — getDanglingWorkers surfaces a stopped-but-genuinely-unmerged worker (task-level mergedSha, not branch content/existence), correctly EXCLUDES a taskless zero-commit rig (the Code Reviewer shape) while still surfacing a taskless worker with real commits, respects current on-disk truth, ignores live workers, and is lineage- (not exact-parent-) scoped."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
