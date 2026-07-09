import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// [loom:merge-rejected] RECONCILE-BEFORE-NOTIFY test (Auditor finding 8fb05b2d, task 606c40bf). REAL git
// on temp repos, NO claude and NO live daemon — drives SessionService.confirmWorkerMerge() directly
// against an isolated LOOM_HOME (mirrors merge-orphaned-to-main.mjs / merge-confirm-idempotent.mjs's
// in-process style), with a pty stub that RECORDS every enqueueStdin call so notify delivery can be
// counted directly.
//
// THE BUG: after a `worker_merge_confirm` client-timeout, a manager manually squash-merged the task
// itself; the daemon then delivered `[loom:merge-rejected] … build gate failed …` TWICE, well AFTER the
// task was already merged + its card closed — burning the manager's turns confirming a stale echo. THIS
// is the NOTIFICATION side (distinct from the merge-staging idempotency already covered by
// merge-confirm-idempotent.mjs/56dce332).
//
// THE FIX: before sending the `[loom:merge-rejected]` pty notify, reconcile against CURRENT state and
// suppress it (the merge_rejected event + the confirmWorkerMerge return value are UNCHANGED — only the
// notify is suppressed) when the branch's work is already reachable from main, or the task's card is
// already terminal (Done), or an identical rejection was already recorded for this worker/task.
//
// Proves:
//   (A) BASELINE: gate fails, task not Done, branch not merged → notify DOES fire (genuine, unresolved).
//   (B) SUPPRESSED — branch already reachable from main (an out-of-band manual squash-merge, still
//       carrying the deterministic Loom-Worker-Branch trailer): notify suppressed, event still recorded.
//   (C) SUPPRESSED — the task's card is already in the terminal (Done) lane: notify suppressed.
//   (D) DE-DUPE: two confirmWorkerMerge calls reproducing the SAME rejection (a client-timeout retry
//       re-running the whole op from scratch) notify exactly ONCE, not twice.
//
// Also proves the `notified` field (card 9eea3901 — the async double-notify fix) is threaded correctly
// on EVERY rejection return: `notified: !suppressed` on each of (A)/(B)/(C)/(D) above, so
// confirmWorkerMergeTracked's completion callback (merge-confirm-completion-nudge.mjs) can rely on it to
// skip a redundant generic `[loom:merge-failed]` echo only when the rich notify actually fired.
// Run: 1) build daemon (pnpm build), 2) node test/merge-reject-notify-suppress.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mrs-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mrs@loom -c user.name=mrs";
const now = new Date().toISOString();

const db = new Db();
// confirmWorkerMerge only touches pty.stop / pty.isAlive / pty.enqueueStdin on these paths; a no-pty
// worker row (processState 'exited') is !isAlive anyway. enqueueStdin RECORDS instead of no-op-ing, so
// notify delivery can be asserted directly.
const notifies = [];
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(managerSessionId, msg) { notifies.push({ managerSessionId, msg }); } };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());
const notifyCount = (mgrId) => notifies.filter((n) => n.managerSessionId === mgrId).length;
const mergeRejectedEvents = (mgrId) => db.listEvents(mgrId).filter((e) => e.kind === "merge_rejected");

const FAIL_GATE = 'node -e "process.exit(1)"';

function seed(p, gateCommand, columnKey = "in_progress") {
  db.insertProject({ id: p.projId, name: "MRS", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MRS-TASK", body: "", columnKey, position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mrs\n");
  execSync(`git init -q && git config user.email mrs@loom && git config user.name mrs && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `mrs-${label}-proj-${sfx}`, agentId: `mrs-${label}-agent-${sfx}`, taskId: `mrs-${label}-task-${sfx}`,
  mgrId: `mrs-${label}-mgr-${sfx}`, workerId: `mrs-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mrs-${label}-${sfx}`), file,
});
const A = mk("a", "feat-a.txt"); // (A) genuine reject: not merged, not done → notify fires
const B = mk("b", "feat-b.txt"); // (B) suppressed: branch already reachable from main
const C = mk("c", "feat-c.txt"); // (C) suppressed: card already Done
const D = mk("d", "feat-d.txt"); // (D) de-dupe: 2 identical calls → ONE notify

try {
  // ── (A) BASELINE: gate fails, task not Done, branch not merged → notify DOES fire ──────────────────
  makeRepo(A);
  {
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    fs.writeFileSync(path.join(worktreePath, A.file), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${A.file}"`, { cwd: worktreePath });
    A.worktreePath = worktreePath; A.branch = branch;
    seed(A, FAIL_GATE);

    const confirmA = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(A) merged:false (gate failed)", confirmA.merged === false);
    check("(A) notify IS delivered (genuine, unresolved rejection)", notifyCount(A.mgrId) === 1);
    check("(A) merge_rejected event recorded, NOT marked suppressed",
      mergeRejectedEvents(A.mgrId).some((e) => e.detail?.reason === "gate" && !e.detail?.suppressed));
    check("(A) canonical repo untouched", !fs.existsSync(path.join(A.repo, A.file)));
    check("(A) notified:true (the rich notify fired — a completion echo would be redundant)", confirmA.notified === true);
  }

  // ── (B) SUPPRESSED: the branch's work is already reachable from main (an out-of-band manual merge) ──
  makeRepo(B);
  {
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    fs.writeFileSync(path.join(worktreePath, B.file), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${B.file}"`, { cwd: worktreePath });
    B.worktreePath = worktreePath; B.branch = branch;
    // Simulate the incident: the manager manually squash-merged the branch out-of-band WHILE the
    // daemon's own confirmWorkerMerge run is about to fail its gate (e.g. a stale client-timeout retry).
    const landed = await mergeBranch(B.repo, branch, "MRS manual merge");
    check("(B) precondition: branch's work already landed in main (trailer present)", landed.ok === true);
    seed(B, FAIL_GATE);

    const confirmB = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(B) merged:false (gate still reports failed — return contract unchanged)", confirmB.merged === false);
    check("(B) notify SUPPRESSED (branch already reachable from main)", notifyCount(B.mgrId) === 0);
    check("(B) merge_rejected event STILL recorded, marked suppressed",
      mergeRejectedEvents(B.mgrId).some((e) => e.detail?.reason === "gate" && e.detail?.suppressed === true));
    check("(B) notified:false (no rich notify fired — the async completion nudge must still tell the manager)", confirmB.notified === false);
  }

  // ── (C) SUPPRESSED: the task's card is already in the terminal (Done) lane ─────────────────────────
  makeRepo(C);
  {
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    fs.writeFileSync(path.join(worktreePath, C.file), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${C.file}"`, { cwd: worktreePath });
    C.worktreePath = worktreePath; C.branch = branch;
    seed(C, FAIL_GATE, "done"); // card already terminal — e.g. the manager closed it another way

    const confirmC = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(C) merged:false (gate still reports failed — return contract unchanged)", confirmC.merged === false);
    check("(C) notify SUPPRESSED (card already Done)", notifyCount(C.mgrId) === 0);
    check("(C) merge_rejected event STILL recorded, marked suppressed",
      mergeRejectedEvents(C.mgrId).some((e) => e.detail?.reason === "gate" && e.detail?.suppressed === true));
    check("(C) notified:false (no rich notify fired — the async completion nudge must still tell the manager)", confirmC.notified === false);
  }

  // ── (D) DE-DUPE: a repeat confirm reproducing the SAME rejection notifies only ONCE ─────────────────
  makeRepo(D);
  {
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    fs.writeFileSync(path.join(worktreePath, D.file), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${D.file}"`, { cwd: worktreePath });
    D.worktreePath = worktreePath; D.branch = branch;
    seed(D, FAIL_GATE);

    const confirmD1 = await sessions.confirmWorkerMerge(D.mgrId, D.workerId); // the ORIGINAL run
    const confirmD2 = await sessions.confirmWorkerMerge(D.mgrId, D.workerId); // a stale retry re-running from scratch
    check("(D) both calls report merged:false", confirmD1.merged === false && confirmD2.merged === false);
    check("(D) notify delivered EXACTLY ONCE across both calls (not a stale-echo double-notify)", notifyCount(D.mgrId) === 1);
    check("(D) TWO merge_rejected events recorded (audit trail intact), the SECOND marked suppressed",
      mergeRejectedEvents(D.mgrId).length === 2 && mergeRejectedEvents(D.mgrId).filter((e) => e.detail?.suppressed === true).length === 1);
    check("(D) notified:true on the FIRST call (rich notify fired), notified:false on the SECOND (de-duped)",
      confirmD1.notified === true && confirmD2.notified === false);
  }
} finally {
  db.close();
  for (const p of [A, B, C, D]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — [loom:merge-rejected] reconciles against current state before notifying: suppressed when the branch is already reachable from main or the card is Done, and de-duped so a repeat rejection never notifies twice; a genuine unresolved rejection still notifies."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
