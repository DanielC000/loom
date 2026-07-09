import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_merge_confirm COMPLETION NUDGE test — when a gate genuinely takes a while, worker_merge_confirm
// degrades to {opId,status:"pending"} and the manager used to have no way to learn the outcome without
// spin-polling (re-calling the tool / worker_list.pendingMerge). confirmWorkerMergeTracked now wires
// PendingOpRegistry.attach's `onSettledAfterPending` to push a `[loom:merge-done]`/`[loom:merge-failed]`
// nudge into the ASKING MANAGER's session the moment the async gate/merge actually terminates — even if
// the manager never re-polls.
//
// REAL git + a REAL PtyHost (fake createPty seam — no claude, no live daemon), mirroring
// merge-spawn-tracked.mjs's in-process style, with a SPY subclass recording every enqueueStdin() call so
// the exact text + kind pushed to the manager can be asserted directly (kind is not observable through
// any public getPending*/worker_list surface, only at the enqueueStdin call boundary itself).
//
// NOT tunable-fast: SYNC_ATTACH_BUDGET_MS (12s) is not injectable, so proving the REAL async/pending path
// through the REAL confirmWorkerMergeTracked needs a gate that outlives it — ~13-16s wall-clock per
// scenario. Still fully hermetic (in-process, no daemon, no network).
//
// Proves:
//   (1) MERGED, async: the completion nudge fires exactly once, kind:"warning", naming the worker + "merged".
//   (2) GATE-FAILED, async: the completion nudge fires exactly once, kind:"warning", naming the worker +
//       the gate-failure reason — DISTINCT from the pre-existing `[loom:merge-rejected]` rejectNotify
//       (which already fires unconditionally on every gate failure, sync or async) — both may land, but
//       only this new one carries the `[loom:merge-done]`/`[loom:merge-failed]` completion-signal tag.
//   (3) FAST path (gate resolves well within the sync-wait budget): NO completion nudge fires at all — the
//       synchronous caller already has the outcome inline; a push here would double-notify.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-completion-nudge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-mcn-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mcn@loom -c user.name=mcn";
const now = new Date().toISOString();

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
// SPY: records every enqueueStdin() call (incl. `kind`, the 6th arg — not observable via any public
// getPending*/worker_list surface) then delegates to the real implementation so queueing/delivery
// behavior is otherwise completely unaffected.
class SpyHost extends SeamHost {
  enqueueCalls = [];
  enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId) {
    this.enqueueCalls.push({ sessionId, text, kind });
    return super.enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId);
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const db = new Db();
const host = new SpyHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

function makeRepo() {
  const repo = path.join(os.tmpdir(), `loom-mcn-repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcn\n");
  execSync(`git init -q && git config user.email mcn@loom && git config user.name mcn && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  return repo;
}
function seedProject(projId, repo, gateCommand) {
  db.insertProject({ id: projId, name: "MCN", repoPath: repo, vaultPath: repo, config: gateCommand ? { orchestration: { gateCommand } } : {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${projId}-mgr`, projectId: projId, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: `${projId}-dev`, projectId: projId, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
  db.insertSession({ id: `${projId}-mgr1`, projectId: projId, agentId: `${projId}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}

const worktrees = [];
try {
  // ============================ (1) MERGED, async: completion nudge fires exactly once ============================
  {
    const P = "mcn-merged", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t1");
    fs.writeFileSync(path.join(worktreePath, "feat1.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat1`, { cwd: worktreePath });
    // A gate that outlives SYNC_ATTACH_BUDGET_MS (12s) then exits 0.
    seedProject(P, repo, `node -e "setTimeout(()=>process.exit(0), 13000)"`);
    const mgrId = `${P}-mgr1`, workerId = `${P}-wkr`;
    db.insertTask({ id: "t1", projectId: P, title: "t1", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "t1", worktreePath, branch });

    const t0 = Date.now();
    const first = await svc.confirmWorkerMergeTracked(mgrId, workerId);
    const elapsed = Date.now() - t0;
    check(`(1) degrades to pending past the sync-wait budget (elapsed=${elapsed}ms)`, first.settled === false && elapsed >= 9_000);
    check("(1) NO completion nudge yet — the op is still running in the background", !host.enqueueCalls.some((c) => c.sessionId === mgrId && /\[loom:merge-(done|failed)\]/.test(c.text)));

    await sleep(5_000); // let the 13s gate actually finish + the terminal callback fire
    const nudges = host.enqueueCalls.filter((c) => c.sessionId === mgrId && /\[loom:merge-(done|failed)\]/.test(c.text));
    check("(1) exactly ONE completion nudge landed for this worker", nudges.length === 1);
    check("(1) it's the MERGED/success nudge, naming the worker", nudges[0] && /\[loom:merge-done\]/.test(nudges[0].text) && nudges[0].text.includes(workerId));
    check("(1) pushed with kind:\"warning\" (a Loom operational nudge — same-route coalescing is correct)", nudges[0] && nudges[0].kind === "warning");
    check("(1) the merge actually landed on main (the underlying behavior is unchanged)", fs.existsSync(path.join(repo, "feat1.txt")));
    worktrees.push([repo, undefined]); // already merged/removed — no worktree left to clean up, kept for symmetry
  }

  // ============================ (2) GATE-FAILED, async: completion nudge names the failure reason ============================
  {
    const P = "mcn-gate-failed", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t2");
    fs.writeFileSync(path.join(worktreePath, "feat2.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat2`, { cwd: worktreePath });
    // A gate that outlives SYNC_ATTACH_BUDGET_MS (12s) then exits non-zero.
    seedProject(P, repo, `node -e "setTimeout(()=>process.exit(1), 13000)"`);
    const mgrId = `${P}-mgr1`, workerId = `${P}-wkr`;
    db.insertTask({ id: "t2", projectId: P, title: "t2", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "t2", worktreePath, branch });

    const first = await svc.confirmWorkerMergeTracked(mgrId, workerId);
    check("(2) degrades to pending past the sync-wait budget", first.settled === false);

    await sleep(5_000); // let the 13s gate actually finish (non-zero) + the terminal callback fire
    const nudges = host.enqueueCalls.filter((c) => c.sessionId === mgrId && /\[loom:merge-(done|failed)\]/.test(c.text));
    check("(2) exactly ONE completion nudge landed for this worker", nudges.length === 1);
    check("(2) it's the FAILED nudge, naming the worker + the gate-failure reason", nudges[0] && /\[loom:merge-failed\]/.test(nudges[0].text) && nudges[0].text.includes(workerId) && /build gate failed/.test(nudges[0].text));
    check("(2) pushed with kind:\"warning\"", nudges[0] && nudges[0].kind === "warning");
    check("(2) fail-closed: worktree retained (gate failed, nothing merged)", fs.existsSync(worktreePath));
    worktrees.push([repo, worktreePath]);
  }

  // ============================ (3) FAST path: no completion nudge — the sync caller already has it inline ============================
  {
    const P = "mcn-fast", repo = makeRepo();
    const { worktreePath, branch } = await createWorktree(repo, P, "t3");
    fs.writeFileSync(path.join(worktreePath, "feat3.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat3`, { cwd: worktreePath });
    seedProject(P, repo); // no gateCommand — resolves synchronously
    const mgrId = `${P}-mgr1`, workerId = `${P}-wkr`;
    db.insertTask({ id: "t3", projectId: P, title: "t3", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "t3", worktreePath, branch });

    const r = await svc.confirmWorkerMergeTracked(mgrId, workerId);
    check("(3) settles within the sync-wait budget (fast path)", r.settled === true && r.ok === true && r.value.merged === true);
    check("(3) the fast path stays byte-identical — NO completion nudge ever fires for it", !host.enqueueCalls.some((c) => c.sessionId === mgrId && /\[loom:merge-(done|failed)\]/.test(c.text)));
  }
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMergeTracked pushes a [loom:merge-done]/[loom:merge-failed] completion nudge (kind:\"warning\") into the asking manager's session exactly once when an async gate/merge reaches a terminal state (merged, gate-failed), and never on the already-fast synchronous path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
