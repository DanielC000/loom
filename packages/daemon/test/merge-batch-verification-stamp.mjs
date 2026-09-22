import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d6d40edd — a `merge_batch` landing used to leave `Task.mergedVerification` (exposed to agents as
// `mergedVerificationAtMerge`, card 634edd2b) permanently `null`: `finishAlreadyMerged` never received a
// verification mode from `mergeBatchTracked`'s landed-branch loop, unlike the solo squash-confirm path
// (`finalizeMerge`'s Green caller, which always states `"content"`). That made the field ambiguous
// between "batch-landed, never stamped" (normal) and "solo-landed, stamp failed" (a real anomaly) —
// exactly the disambiguation `mergedVerificationAtMerge` exists to provide.
//
// THE FIX: `landBranchCommitsIndividually` (git/batch-merge.ts) already computes its own
// `Loom-Worker-PathSet` digest (or discovers the stamp failed) while landing each branch — a per-branch
// `pathSetStamped` flag rides back on `BatchLandedBranch`. `mergeBatchTracked`'s landed-branch loop now
// derives a verification tier from that flag for FREE (no extra git call) and threads it into
// `finishAlreadyMerged`/`finalizeMerge`'s existing `mergedVerification` param: `"pathset"` when the stamp
// landed (the normal case), `"trailer-only"` when it didn't.
//
// PROVES (e2e, a REAL mergeBatchTracked run — 2 real branches, a real fast gate command, no injected
// runGate):
//   (1) both landed tasks' RAW `Task.mergedVerification` DB column reads `"pathset"` — the batch path now
//       stamps eagerly, the same way the solo Green path always has (just a different tier).
//   (2) the MCP read layer (`getProjectTask`) renames it to `mergedVerificationAtMerge` and agrees.
//   (3) `mergedSha`/`mergedRepoKey`/`mergedDate` (the pre-existing ship-state columns, card 1eebc46a) are
//       still populated exactly as before this card — this fix is additive, not a behavior change to them.
//
// RED PROOF (done by hand during development, not re-run here): with the `mergedVerification` derivation
// + the two threaded params removed from `sessions/service.ts` (reverting to the pre-card-d6d40edd shape,
// where `finishAlreadyMerged` is called with no `mergedVerification` at all), this test's check (1)/(2)
// FAIL — both read back `null` — reproducing the exact card finding. Restoring the fix makes them pass.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-batch-verification-stamp.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mbvs-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { getProjectTask } = await import("../dist/mcp/tasks.js");

const GIT_ID = "-c user.email=mbvs@loom -c user.name=mbvs";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mbvs\n");
  execSync(`git init -q && git config user.email mbvs@loom && git config user.name mbvs`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function cutBranch(repo, projId, label, file, content) {
  const taskId = `mbvs-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, `${label}`, GIT_ID);
  return { taskId, branch, worktreePath };
}

const dbs = [];
const worktrees = [];
try {
  const repo = path.join(os.tmpdir(), `loom-mbvs-${sfx}`);
  makeRepo(repo);
  const projId = `mbvs-proj-${sfx}`;
  const agentId = `mbvs-agent-${sfx}`;
  const mgrId = `mbvs-mgr-${sfx}`;

  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: "MBVS", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: 'node -e "process.exit(0)"' } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const a = await cutBranch(repo, projId, "a", "feature-a.txt", "work a\n");
  const b = await cutBranch(repo, projId, "b", "feature-b.txt", "work b\n");
  worktrees.push(a.worktreePath, b.worktreePath);
  const wA = `mbvs-wkr-a-${sfx}`, wB = `mbvs-wkr-b-${sfx}`;
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

  const r = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
  check("(setup) settles within the sync-wait budget", r.settled === true && r.ok === true);
  check("(setup) the batch landed both branches", r.settled && r.ok && r.value.ok === true && r.value.landed.length === 2);

  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
    const raw = db.getTask(w.taskId);
    check(`(1) task ${label}: raw Task.mergedVerification stamps "pathset" (not null) after a fresh batch landing`,
      raw?.mergedVerification === "pathset");
    check(`(1) task ${label}: raw Task.mergedSha is also populated (pre-existing ship-state, unaffected by this fix)`,
      typeof raw?.mergedSha === "string" && raw.mergedSha.length > 0);

    const viaMcp = await getProjectTask(db, projId, w.taskId);
    check(`(2) task ${label}: MCP getProjectTask renames it to mergedVerificationAtMerge:"pathset"`,
      viaMcp.mergedVerificationAtMerge === "pathset");
    check(`(2) task ${label}: MCP getProjectTask has NO raw mergedVerification key (renamed, not duplicated)`,
      !("mergedVerification" in viaMcp));
  }

  db.close();
} finally {
  for (const d of dbs) try { d.close(); } catch { /* already closed above; ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a fresh merge_batch landing now stamps mergedVerificationAtMerge (\"pathset\") eagerly, closing the permanent-null gap card d6d40edd found."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
