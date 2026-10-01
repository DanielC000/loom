import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4ee527d1 — the GIT-DEPENDENT half of the worker-retirement-cancels-wakes fix (see
// worker-retired-cancels-wakes.mjs for the non-git sites + the resume() defense-in-depth proof + the
// crash-path control; this file does not repeat those). confirmWorkerMerge's Green path,
// finishAlreadyMerged (the ALREADY_MERGED finish — shared by the solo already-merged confirm AND
// mergeBatchTracked's per-landed-branch finalize), and the noChanges/noCommit auto-retire branch of
// workerReport all need a REAL git worktree (precheckWorkerDone's zeroAhead check, and the merge machinery
// itself, both do real git reads), so they're isolated here rather than folded into the lighter fake-pty
// harness.
//
// Proves:
//   (A) confirmWorkerMerge's solo Green hard-stop cancels the merged worker's pending wake and files
//       worker_retired(reason:"merge_confirm").
//   (B) finishAlreadyMerged (reached via the ALREADY_MERGED classification — the branch's work already
//       landed in main before the confirm call) does the SAME.
//   (C) the noChanges/noCommit auto-retire branch of workerReport does the SAME (reason starts with
//       "auto_retire:").
//
// Minimal harness (mirrors merge-confirm-solo-owner-recycle.mjs's own stub-pty style — no PtyHost seam
// needed; confirmWorkerMerge only touches pty.stop/isAlive/enqueueStdin/purge*, all stubbed): a REAL git
// repo + REAL createWorktree/mergeBranch, a fake synchronous gate, and a REAL WakeService wired to the
// REAL SessionService.resume so the wake-cancellation is asserted against the real DB row, not a mock.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-retired-merge-confirm.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wrmc-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=wrmc@loom -c user.name=wrmc";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const write = (dir, f, c) => fs.writeFileSync(path.join(dir, f), c);

const repo = path.join(os.tmpdir(), `loom-wrmc-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
registerForCleanup(repo);
write(repo, "README.md", "# wrmc\n");
execSync(`git init -q && git config user.email wrmc@loom && git config user.name wrmc`, { cwd: repo });
commitAll(repo, "init", GIT_ID);

const worktrees = [];
let db;
try {
  db = new Db();
  const P = `wrmc-proj-${sfx}`;
  db.insertProject({ id: P, name: "WRMC", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "node -e \"process.exit(0)\"" } }, createdAt: now, archivedAt: null });
  const agentId = `${P}-dev`;
  db.insertAgent({ id: agentId, projectId: P, name: "dev", startupPrompt: "", position: 0 });
  const baseSession = (id, role, extra = {}) => ({ id, projectId: P, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role, ...extra });

  const ptyStub = {
    stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: false }; },
    purgeQueuedWorkerIdleNudges() { return []; },
    purgeQueuedWorkerReportNudgesForWorker() { return []; },
    getActiveTurnOrigin() { return null; },
  };
  const fakeGate = async () => ({ passed: true });
  const svc = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, gateOpRetainMs: 0 });
  const wakes = new WakeService({
    db, pty: ptyStub, resume: (id) => svc.resume(id),
    enqueueDurable: (id, text, ctx) => svc.enqueueSystemNudge(id, text, ctx),
  });

  let n = 0;
  async function scenario(opts = {}) {
    const tag = `t${++n}`;
    const mgr = `${P}-${tag}-mgr`;
    db.insertSession(baseSession(mgr, "manager"));
    const taskId = `wrmc-task-${tag}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    if (!opts.noCommit) {
      write(worktreePath, `${tag}.txt`, `x\n`);
      commitAll(worktreePath, `feat(test): ${tag}`, GIT_ID);
    }
    db.insertTask({ id: taskId, projectId: P, title: `feat(test): ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerId = `${P}-${tag}-wkr`;
    db.insertSession(baseSession(workerId, "worker", { cwd: worktreePath, processState: opts.processState ?? "exited", parentSessionId: mgr, taskId, worktreePath, branch }));
    const { wakeId } = wakes.schedule(workerId, { delaySeconds: 60, note: `${tag} wake` });
    return { tag, mgr, workerId, taskId, worktreePath, branch, wakeId };
  }

  // ── (A) confirmWorkerMerge solo Green path ──
  {
    const s = await scenario();
    const r = await svc.confirmWorkerMerge(s.mgr, s.workerId);
    check("(A) precondition: solo confirm merged (Green, not ALREADY_MERGED)", r.merged === true && r.emptyKind === undefined);
    check("(A) the merged worker's wake is CANCELLED", db.listWakesForSession(s.workerId).length === 0 && db.getWake(s.wakeId) === undefined);
    const retired = db.listEventsForWorker(s.workerId).find((e) => e.kind === "worker_retired");
    check("(A) a worker_retired event is filed, reason merge_confirm", !!retired && retired.detail?.reason === "merge_confirm");
    check("(A) the event records it cancelled exactly 1 wake", retired?.detail?.cancelledWakes === 1);
    worktrees.push(s.worktreePath); // already merged/removed by finalize — kept for symmetry with the recipe this mirrors
  }

  // ── (B) finishAlreadyMerged (ALREADY_MERGED) ──
  {
    const s = await scenario();
    // Land the branch into main directly (writes the deterministic Loom-Worker-Branch trailer) WITHOUT
    // deleting the branch ref or touching the worktree — simulating a merge that landed out-of-band
    // before this confirm call (mirrors merge-confirm-completion-nudge.mjs scenario (5)'s own recipe).
    const landed = await mergeBranch(repo, s.branch, `WRMC ${s.tag} already-merged`);
    check("(B pre) branch landed in main with its trailer, worktree still present, task NOT terminal",
      landed.ok === true && fs.existsSync(s.worktreePath) && db.getTask(s.taskId).columnKey !== "done");

    const r = await svc.confirmWorkerMerge(s.mgr, s.workerId);
    check("(B) precondition: confirm resolved via the ALREADY_MERGED route", r.merged === true);
    check("(B) the already-merged worker's wake is CANCELLED", db.listWakesForSession(s.workerId).length === 0 && db.getWake(s.wakeId) === undefined);
    const retired = db.listEventsForWorker(s.workerId).find((e) => e.kind === "worker_retired");
    check("(B) a worker_retired event is filed, reason merge_confirm", !!retired && retired.detail?.reason === "merge_confirm");
  }

  // ── (C) noChanges/noCommit auto-retire branch of workerReport ──
  {
    // A worktree with ZERO commits ahead of base (createWorktree's own fresh branch, untouched — never
    // commit anything) is exactly precheckWorkerDone's zeroAhead:true shape, needed for the auto-retire
    // branch to even be reachable.
    const s = await scenario({ noCommit: true, processState: "live" });
    const r = await svc.workerReport(s.workerId, { status: "done", summary: "investigated — nothing needed changing", noChanges: true });
    check("(C) precondition: the report auto-retired (0 commits ahead + declared no-op)", r.autoRetired === true && r.reported === true);
    check("(C) the auto-retired worker's wake is CANCELLED", db.listWakesForSession(s.workerId).length === 0 && db.getWake(s.wakeId) === undefined);
    const retired = db.listEventsForWorker(s.workerId).find((e) => e.kind === "worker_retired");
    check("(C) a worker_retired event is filed, reason auto_retire:declared-no-op", !!retired && retired.detail?.reason === "auto_retire:declared-no-op");
  }
} finally {
  if (db) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — retireWorkerSession cancels the merged/auto-retired worker's pending wake and files the durable worker_retired marker at all three git-dependent retirement sites: confirmWorkerMerge's solo Green hard-stop, finishAlreadyMerged (the ALREADY_MERGED route, shared with mergeBatchTracked's per-landed-branch finalize), and the noChanges/noCommit auto-retire branch of workerReport."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
