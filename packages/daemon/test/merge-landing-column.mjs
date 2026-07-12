import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// mergeLanding ColumnRole test (board card 6812df4d). REAL git on temp repos, NO claude and NO live
// daemon — drives SessionService.confirmWorkerMerge() directly against an isolated LOOM_HOME (mirrors
// merge-confirm-idempotent.mjs's in-process style).
//
// Proves finalizeMerge's target-column resolution (service.ts):
//   (a) a project whose board has a column with role "mergeLanding" (NOT its terminal column) → a
//       merged card lands THERE, not on the terminal column.
//   (b) a project with NO mergeLanding column (the PLATFORM_DEFAULTS board) → a merged card lands on
//       the terminal column exactly as before this role existed (byte-identical fallback, regression pin).
// Run: 1) build daemon (pnpm build), 2) node test/merge-landing-column.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mlc-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mlc@loom -c user.name=mlc";
const now = new Date().toISOString();

const db = new Db();
// confirmWorkerMerge only touches pty.stop / pty.isAlive / pty.enqueueStdin on these paths; a no-pty
// worker row (processState 'exited') is !isAlive anyway, so a stub keeps the test hermetic.
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function seed(p, config) {
  db.insertProject({ id: p.projId, name: "MLC", repoPath: p.repo, vaultPath: p.repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MLC-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mlc\n");
  execSync(`git init -q && git config user.email mlc@loom && git config user.name mlc && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `mlc-${label}-proj-${sfx}`, agentId: `mlc-${label}-agent-${sfx}`, taskId: `mlc-${label}-task-${sfx}`,
  mgrId: `mlc-${label}-mgr-${sfx}`, workerId: `mlc-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mlc-${label}-${sfx}`), file,
});
const A = mk("a", "feat-a.txt"); // (a) board WITH a mergeLanding column
const B = mk("b", "feat-b.txt"); // (b) board with NO mergeLanding column (default) → terminal fallback

try {
  // ── (a) a board with a "mergeLanding" column (not terminal) lands a merged card THERE ─────────────
  makeRepo(A);
  {
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    fs.writeFileSync(path.join(worktreePath, A.file), "part 1\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${A.file}"`, { cwd: worktreePath });
    A.worktreePath = worktreePath; A.branch = branch;
    seed(A, {
      kanbanColumns: [
        { key: "backlog", label: "Backlog", role: "defaultLanding" },
        { key: "in_progress", label: "In Progress", role: "active" },
        { key: "merged", label: "Merged", role: "mergeLanding" },
        { key: "done", label: "Done", role: "terminal" },
      ],
    });

    const confirmA = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(a) merge succeeds", confirmA.merged === true);
    check("(a) task lands on the mergeLanding column ('merged'), NOT terminal ('done')",
      db.getTask(A.taskId).columnKey === "merged");
    check("(a) worktree removed after the merge", !fs.existsSync(A.worktreePath));
  }

  // ── (b) a board with NO mergeLanding column falls back to terminal exactly as today ────────────────
  makeRepo(B);
  {
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    fs.writeFileSync(path.join(worktreePath, B.file), "part 1\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${B.file}"`, { cwd: worktreePath });
    B.worktreePath = worktreePath; B.branch = branch;
    seed(B, {}); // {} → resolveConfig falls back to PLATFORM_DEFAULTS.kanbanColumns (no mergeLanding role)

    const confirmB = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(b) merge succeeds", confirmB.merged === true);
    check("(b) task lands on the terminal column ('done') — byte-identical to pre-mergeLanding behavior",
      db.getTask(B.taskId).columnKey === "done");
    check("(b) worktree removed after the merge", !fs.existsSync(B.worktreePath));
  }
} finally {
  db.close();
  for (const p of [A, B]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — finalizeMerge lands a merged card on the project's mergeLanding column when one is configured, and falls back to terminal (byte-identical to today) when it isn't."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
