import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_merge_confirm STALE-RETRY + NO-GATE-WARNING tests (Platform findings 864e79fe, 8363e602). REAL
// git on temp repos, NO claude and NO live daemon — drives SessionService.confirmWorkerMerge() directly
// against an isolated LOOM_HOME (mirrors merge-confirm-idempotent.mjs's in-process style).
//
// THE BUG (864e79fe): after a SUCCESSFUL confirmWorkerMerge (worktree removed, branch deleted), a stale
// retry landing later (e.g. a client-timeout on the original call, followed by a re-poll after the
// pending-op entry already settled+evicted — see confirmWorkerMergeTracked) re-invoked confirmWorkerMerge
// for real. It ran the gate again in the now-REMOVED worktree directory — a `spawn` with a nonexistent
// `cwd` fails (ENOENT), so the gate step's `passed` came back false — and the retry falsely reported
// "build gate failed" for a merge that had already SUCCEEDED.
//
// THE FIX: confirmWorkerMerge detects this EARLY — before touching the gate/stranded-check/merge — by
// checking BOTH (a) the worktree is gone from disk and (b) the branch's work is reachable from main via
// the deterministic Loom-Worker-Branch trailer (findLandedSquashCommit) — and finishes idempotently
// (merged:true, emptyKind:'ALREADY_MERGED') without re-running anything.
//
// THE OTHER BUG (8363e602): with no gateCommand configured, a successful merge silently rubber-stamped
// with no signal that it was never verified.
// THE FIX: a successful merge with no gate configured now carries `warning` naming it unverified.
//
// Proves:
//   (a) a SECOND confirm call for the SAME worker, after the first already merged + retired the
//       worktree/branch, returns merged:true/ALREADY_MERGED — NOT a false "build gate failed" — even
//       though the (still-configured, would-otherwise-pass) gate command can no longer even run (its cwd
//       is gone), and lands NO additional commit on main. It also carries `notified:true` and the SAME
//       correlation `opId` shape as any other confirm — but does NOT push a SECOND
//       `[loom:already-merged]` pty nudge for a manager who was already told by the FIRST call's own
//       finalize (card 369d8824's "already consumed" facet — a stale echo across a resume/retry).
//   (b) a successful merge with NO gateCommand configured carries an explicit `warning` field.
//   (c) a successful merge WITH a passing gateCommand carries NO `warning` field (contrast).
// Run: 1) build daemon (pnpm build), 2) node test/merge-confirm-stale-retry-idempotent.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcs-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcs@loom -c user.name=mcs";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const PASS_GATE = 'node -e "process.exit(0)"';

const db = new Db();
// confirmWorkerMerge only touches pty.stop / pty.isAlive / pty.enqueueStdin / pty.getPid on these paths; a
// no-pty worker row (processState 'exited') is !isAlive anyway, so a stub keeps the test hermetic. Records
// every enqueueStdin() call so scenario (a) can prove the stale-retry's own [loom:already-merged] push is
// suppressed (not merely that the RETURN VALUE looks idempotent).
const enqueueCalls = [];
const ptyStub = {
  stop() {}, isAlive() { return false; }, getPid() { return undefined; },
  enqueueStdin(sessionId, text) { enqueueCalls.push({ sessionId, text }); },
};
// Inject a fake reap seam — WITHOUT this, scenarios (a)/(c) (a configured, passing gateCommand) fall
// through confirmWorkerMerge's pre-gate sweep to the REAL OS process enumerator, which shells out
// (powershell Get-CimInstance / a /proc walk) even though it's bounded and matches nothing here. Keeps
// this suite fully hermetic, matching worktree-process-reap.mjs's own injected stub.
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
  reapWorktreeProcesses: async () => ({ killedPids: [] }),
});

function seed(p, gateCommand) {
  db.insertProject({ id: p.projId, name: "MCS", repoPath: p.repo, vaultPath: p.repo, config: gateCommand ? { orchestration: { gateCommand } } : {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MCS-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mcs\n");
  execSync(`git init -q && git config user.email mcs@loom && git config user.name mcs && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `mcs-${label}-proj-${sfx}`, agentId: `mcs-${label}-agent-${sfx}`, taskId: `mcs-${label}-task-${sfx}`,
  mgrId: `mcs-${label}-mgr-${sfx}`, workerId: `mcs-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mcs-${label}-${sfx}`), file,
});
const A = mk("a", "feat-a.txt"); // (a) stale retry after a prior successful merge
const B = mk("b", "feat-b.txt"); // (b) no gate configured → warning
const C = mk("c", "feat-c.txt"); // (c) gate configured + passes → no warning

try {
  // ── (a) STALE RETRY: a second confirm after the first already merged + retired everything ───────────
  makeRepo(A);
  {
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    fs.writeFileSync(path.join(worktreePath, A.file), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${A.file}"`, { cwd: worktreePath });
    A.worktreePath = worktreePath; A.branch = branch;
    seed(A, PASS_GATE);

    const confirmA1 = await sessions.confirmWorkerMerge(A.mgrId, A.workerId); // the ORIGINAL, real call
    check("(a) first confirm merges successfully", confirmA1.merged === true);
    check("(a) precondition: worktree removed after the first confirm", !fs.existsSync(A.worktreePath));
    check("(a) precondition: branch deleted after the first confirm", git(A.repo, `branch --list ${A.branch}`) === "");
    check("(a) task moved to done", db.getTask(A.taskId).columnKey === "done");

    const headAfterFirst = git(A.repo, "rev-parse HEAD");
    // A STALE RETRY: the worker session row is untouched by finalizeMerge (only the git branch + worktree
    // dir are retired), so a second call against the SAME workerSessionId is exactly the shape a
    // pending-op re-attach-after-eviction retry takes. The gate is STILL configured (and would still pass
    // if it could run) — the OLD bug was that it ran anyway, in a now-nonexistent cwd, and failed.
    const enqueueCountBeforeRetry = enqueueCalls.length;
    const confirmA2 = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(a) SECOND confirm reports merged:true (not a false 'build gate failed')", confirmA2.merged === true);
    check("(a) SECOND confirm is distinguishable as ALREADY_MERGED", confirmA2.emptyKind === "ALREADY_MERGED");
    check("(a) SECOND confirm's reason is undefined (not a gate-failure reason)", confirmA2.reason === undefined);
    check("(a) NO additional commit landed on main from the second confirm", git(A.repo, "rev-parse HEAD") === headAfterFirst);
    check("(a) SECOND confirm still carries notified:true (owns the announcement either way)", confirmA2.notified === true);
    check("(a) SECOND confirm carries its OWN opId, distinct from the first call's", typeof confirmA2.opId === "string" && confirmA2.opId !== confirmA1.opId);
    check("(a) the STALE retry pushes NO [loom:already-merged] echo — the manager was already told by the FIRST call's finalize (card 369d8824)",
      enqueueCalls.length === enqueueCountBeforeRetry);
  }

  // ── (b) NO GATE CONFIGURED: a successful merge carries an explicit unverified warning ─────────────────
  makeRepo(B);
  {
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    fs.writeFileSync(path.join(worktreePath, B.file), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${B.file}"`, { cwd: worktreePath });
    B.worktreePath = worktreePath; B.branch = branch;
    seed(B, undefined); // no gateCommand at all

    const confirmB = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(b) merges successfully with no gate configured", confirmB.merged === true);
    check("(b) carries an explicit unverified warning", typeof confirmB.warning === "string" && /unverified/i.test(confirmB.warning) && /gate/i.test(confirmB.warning));
  }

  // ── (c) GATE CONFIGURED + PASSES: a successful merge carries NO warning (contrast) ─────────────────────
  makeRepo(C);
  {
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    fs.writeFileSync(path.join(worktreePath, C.file), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${C.file}"`, { cwd: worktreePath });
    C.worktreePath = worktreePath; C.branch = branch;
    seed(C, PASS_GATE);

    const confirmC = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(c) merges successfully with a passing gate", confirmC.merged === true);
    check("(c) carries NO warning (the merge WAS verified)", confirmC.warning === undefined);
  }
} finally {
  db.close();
  for (const p of [A, B, C]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a stale confirm retry after a prior successful merge finishes idempotently (ALREADY_MERGED) instead of falsely failing the gate against a removed worktree, pushes NO duplicate [loom:already-merged] echo (card 369d8824), and a successful merge with no gateCommand configured explicitly says so instead of silently rubber-stamping."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
