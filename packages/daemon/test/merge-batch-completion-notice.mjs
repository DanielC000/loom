import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH COMPLETION NOTICE (card c35b60c4) — owner-reported: "batch merge produces separate merge
// notices... Just now a batch merge of 4 caused 4 separate message to be queued for the loom manager.
// This wastes 4 unnecessary turns. This should be 1 single message."
//
// ROOT CAUSE (established at source before this fix, sessions/service.ts): `mergeBatchTracked`'s `run`
// closure loops over every LANDED branch and calls `finishAlreadyMerged` for each — and EVERY one of them
// resolves the ALREADY_MERGED outcome (the batch's own single fast-forward already put every branch's
// work on main before this loop even starts — see that method's own header doc), so `finishAlreadyMerged`'s
// `alreadyFinalized` guard (built for the STALE-RETRY case, not this one) is `false` every time and its own
// `[loom:already-merged]` push fires once per branch — K pushes for one batch, none of them a duplicate the
// guard could catch. On top of that, the batch's own aggregate settle nudge (`[loom:merge-batch-done]`,
// fired only on the ASYNC path) already existed but only reported a bare count, and the suppressed
// per-branch text unconditionally called the outcome "ALREADY_MERGED" — misleading in a batch, where it is
// the ordinary success case (the affected manager `02edda85` hit this live and had to check `git log main`
// by hand to confirm the batch had actually passed).
//
// THE FIX: `finishAlreadyMerged` gained a `suppressNotify` flag (set ONLY by the batch call site), so the
// per-branch push never fires on the batch path; the aggregate `[loom:merge-batch-done]` notice is now the
// ONE place a batch's landed branches are ever announced, and it names every branch's task + branch + sha
// instead of a bare count, and never says "ALREADY_MERGED".
//
// RED PROOF (done by hand during development — see this card's own worker_report for the transcript): with
// sessions/service.ts reverted to pre-c35b60c4 HEAD, this exact test failed both discriminating assertions
// — 3 `[loom:already-merged]` pushes fired (one per landed branch) instead of 0, and the manager received 4
// total notices instead of 1. Restoring the fix makes it pass again.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-batch-completion-notice.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

async function waitUntil(predicate, timeoutMs, intervalMs = 200) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: "merge-batch-completion-notice: predicate" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return predicate();
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-mbcn-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mbcn@loom -c user.name=mbcn";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

class SeamHost extends createSeamHost(PtyHost) {}
// SPY: records every enqueueStdin() call (kind included) so the exact set of pushes reaching the manager
// can be asserted directly — mirrors merge-confirm-completion-nudge.mjs's identical SpyHost.
class SpyHost extends SeamHost {
  enqueueCalls = [];
  enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId) {
    this.enqueueCalls.push({ sessionId, text, kind });
    return super.enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId);
  }
}
const db = new Db();
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SpyHost(events);
// Small sync budget + a gate that outlives it — forces mergeBatchTracked onto the ASYNC settle path (the
// specimen's own shape: the manager's own call degrades to {settled:false} and learns the outcome only via
// the completion nudge), the path this card's fix actually changes.
const TEST_SYNC_BUDGET_MS = 500;
const SLOW_GATE_MS = 1500;
const svc = new SessionService(db, host, new OrchestrationControl(), { syncAttachBudgetMs: TEST_SYNC_BUDGET_MS });

function makeRepo() {
  const repo = path.join(os.tmpdir(), `loom-mbcn-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mbcn\n");
  execSync(`git init -q && git config user.email mbcn@loom && git config user.name mbcn`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

async function cutBranch(repo, projId, label, file, content) {
  const taskId = `mbcn-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, label, GIT_ID);
  return { taskId, branch, worktreePath };
}

const worktrees = [];
try {
  const P = `mbcn-proj-${sfx}`;
  const repo = makeRepo();
  // K=3 candidates, default maxConcurrentWorkers (3) — no override needed, and matches the DoD's "K≥3".
  db.insertProject({ id: P, name: "MBCN", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node -e "setTimeout(()=>process.exit(0), ${SLOW_GATE_MS})"` } }, createdAt: now, archivedAt: null });
  const agentId = `${P}-dev`;
  db.insertAgent({ id: agentId, projectId: P, name: "dev", startupPrompt: "", position: 0 });
  const mgrId = `${P}-mgr1`;
  db.insertSession({ id: mgrId, projectId: P, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const branchLabels = ["a", "b", "c"];
  const workers = [];
  for (const label of branchLabels) {
    const { taskId, branch, worktreePath } = await cutBranch(repo, P, label, `feature-${label}.txt`, `work ${label}\n`);
    worktrees.push(worktreePath);
    db.insertTask({ id: taskId, projectId: P, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerId = `${P}-wkr-${label}`;
    db.insertSession({ id: workerId, projectId: P, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    workers.push({ workerId, taskId, branch });
  }

  const first = await svc.mergeBatchTracked(mgrId, workers.map((w) => w.workerId));
  check("precondition: the batch degrades to pending past the sync-wait budget (the async path this fix changes)", first.settled === false);
  const opId = first.op?.opId;
  check("precondition: the pending response carries a real opId", typeof opId === "string" && opId.length > 0);

  await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === mgrId && /\[loom:merge-batch-done\]/.test(c.text)), 20_000);
  // Grace window for any (should-NOT-happen post-fix) trailing per-branch pushes to show up alongside the
  // aggregate notice — mirrors merge-confirm-completion-nudge.mjs's identical grace-window pattern.
  await new Promise((r) => setTimeout(r, 500));

  const managerNudges = host.enqueueCalls.filter((c) => c.sessionId === mgrId);
  const alreadyMergedNudges = managerNudges.filter((c) => /\[loom:already-merged\]/.test(c.text));
  const batchDoneNudges = managerNudges.filter((c) => /\[loom:merge-batch-done\]/.test(c.text));

  // ── THE DISCRIMINATING ASSERTIONS (card c35b60c4's DoD) ──────────────────────────────────────────────
  check("(1) fail-first: NO per-branch [loom:already-merged] push fired for this batch (each used to fire — see this file's RED PROOF)", alreadyMergedNudges.length === 0);
  check("(2) fail-first: exactly ONE manager-bound notice for the whole batch (not one per branch)", managerNudges.length === 1);
  check("(3) that one notice is the aggregate batch-done notice", batchDoneNudges.length === 1);
  for (const w of workers) {
    check(`(4) it names branch ${w.branch}`, !!batchDoneNudges[0] && batchDoneNudges[0].text.includes(w.branch));
    check(`(4) it names task ${w.taskId}`, !!batchDoneNudges[0] && batchDoneNudges[0].text.includes(w.taskId));
  }
  check("(5) it never describes a batched branch as ALREADY_MERGED (misleading — this is the ordinary success case)", !!batchDoneNudges[0] && !batchDoneNudges[0].text.includes("ALREADY_MERGED"));
  check("(6) it carries the batch's own opId (unambiguous which op this is about)", !!batchDoneNudges[0] && batchDoneNudges[0].text.includes(opId));
  check("(7) every branch actually landed on main (the underlying merge behavior is unchanged)", branchLabels.every((label) => fs.existsSync(path.join(repo, `feature-${label}.txt`))));

  // Per-branch `merge_done` events are still preserved (DoD-5) — only the manager-bound push collapses.
  const mergeDoneEvents = workers.map((w) => db.listEventsForWorker(w.workerId).filter((e) => e.kind === "merge_done"));
  check("(8) DoD-5: every landed branch still has its own merge_done event (only the notices collapse, not the bookkeeping)", mergeDoneEvents.every((evts) => evts.length === 1));
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
