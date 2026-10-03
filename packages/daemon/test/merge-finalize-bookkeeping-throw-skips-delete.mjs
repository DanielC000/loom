import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e34d475c, Round 4 — EXCEPTION-SEMANTICS PIN for the `finalizeMerge` tail extraction.
//
// `@decision sha:252e57ec` mandates deleteBranch run LAST, strictly AFTER the durable terminal
// bookkeeping (task column move + the `merge_done` event) is committed — so a crash/throw during that
// bookkeeping must leave the branch ref UNTOUCHED (never deleted), and the whole `finalizeMerge` call
// must reject (never silently swallow the throw and continue to the delete). Round 4 extracted
// `finalizeMerge`'s worktree-removal + guarded-CAS-branch-delete tail into a shared helper (also used by
// boot-reconcile Pass A's own-row/sibling cleanup-only path) with a `betweenRemovalAndDelete` callback
// seam carrying that bookkeeping — this test PINS that the exception semantics are IDENTICAL across that
// extraction: the callback is invoked un-wrapped (no try/catch around it), so a throw inside it propagates
// straight out of the helper (and so out of `finalizeMerge`) BEFORE the delete step is ever reached.
//
// Forces the throw deterministically via the SAME `db.appendEvent` monkeypatch pattern used elsewhere in
// this suite (batch-guard-release-on-throw.mjs, merge-gate-red-any-end.mjs, …): the merge_done append
// itself is the very first bookkeeping write `finalizeMerge` makes, so throwing there exercises the whole
// callback body un-wrapped, upstream of the branch-delete step.
// Run: 1) build daemon (pnpm build), 2) node test/merge-finalize-bookkeeping-throw-skips-delete.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mfbt-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mfbt@loom -c user.name=mfbt";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const repo = path.join(os.tmpdir(), `loom-mfbt-repo-${sfx}`);
const projId = `mfbt-proj-${sfx}`, agentId = `mfbt-agent-${sfx}`, taskId = `mfbt-task-${sfx}`;
const mgrId = `mfbt-mgr-${sfx}`, workerId = `mfbt-wkr-${sfx}`;

const db = new Db();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

try {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mfbt\n");
  execSync(`git init -q && git config user.email mfbt@loom && git config user.name mfbt`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const { createWorktree } = await import("../dist/git/worktrees.js");
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feat.txt"), "worker change\n");
  commitAll(worktreePath, "feat", GIT_ID);

  db.insertProject({ id: projId, name: "MFBT", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MFBT-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  // Inject the throw on the FIRST `merge_done` append only — never interferes with any OTHER event kind
  // (`merge_branch_retained`, etc.) this same call graph might also append.
  const origAppendEvent = db.appendEvent.bind(db);
  let fired = false;
  db.appendEvent = (e) => {
    if (!fired && e.kind === "merge_done") { fired = true; throw new Error("injected merge_done bookkeeping failure"); }
    return origAppendEvent(e);
  };

  let threw = null;
  try {
    await sessions.confirmWorkerMerge(mgrId, workerId);
  } catch (e) {
    threw = e;
  }

  check("(throw) confirmWorkerMerge REJECTED — the bookkeeping throw propagates, never swallowed", threw !== null && /injected merge_done bookkeeping failure/.test(threw.message));
  check("(throw) the merge_done append was actually reached (fired exactly once)", fired === true);
  check("(throw) branch ref SURVIVES — the CAS delete is NEVER reached when bookkeeping throws before it",
    git(repo, `branch --list ${branch}`) !== "");
  check("(throw) NO merge_done event was recorded (the throw happened on that very append)",
    db.listEventsForWorker(workerId).every((e) => e.kind !== "merge_done"));
  // Pins the REST of today's ordering too, so the whole picture (not just the delete) is proven
  // unchanged by the extraction: the task-column move runs BEFORE the merge_done append in the existing
  // bookkeeping block, so it has ALREADY happened by the time the throw fires.
  check("(throw) the task column move already landed before the throw (pre-existing ordering, unchanged)",
    db.getTask(taskId).columnKey === "done");
} finally {
  db.close();
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a throw inside finalizeMerge's terminal bookkeeping (task column move + merge_done) propagates straight out of confirmWorkerMerge and the branch-delete step is never reached — identical before and after the Round-4 tail extraction into a shared helper."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
