import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn COMPLETION NUDGE test (card 69246a6e) — when a slow spawn degrades to {opId,status:"pending"}
// and then FAILS before the worker ever starts (specimen: a persistent EPERM on the ~/.claude.json trust
// write, card 37b1ed5f), the manager used to get NO notice at all: the row silently went
// processState:"exited" with lastError set, discoverable only by reading worker_list. spawnWorkerTracked
// now wires PendingOpRegistry.attach's `onSettledAfterPending` to push a `[loom:spawn-failed]` nudge into
// the ASKING MANAGER's session the moment the async spawn actually fails — mirroring
// confirmWorkerMergeTracked's own settle-push shape (see merge-confirm-completion-nudge.mjs), scaled down
// to what this card needs: no notice at all on success (the worker's own worker_report is that signal).
//
// REAL git + a REAL PtyHost (fake createPty seam — no claude, no live daemon), mirroring
// merge-spawn-tracked.mjs's/merge-confirm-completion-nudge.mjs's in-process style, with a SPY subclass
// recording every enqueueStdin() call (kind is not observable through any public worker_list/
// listPendingSpawns surface, only at the enqueueStdin call boundary) and an INJECTABLE createPty() that
// can be told to throw once — simulating the real EPERM-in-ensureTrustedResilient shape (a synchronous
// throw inside spawnWorker's own live-flip try/catch, well AFTER createWorktree's real git work has
// already run — which is what provides the real wall-clock delay needed to cross the shrunk sync-wait
// budget below and force the pending-degrade path deterministically).
//
// Proves:
//   (1) PENDING then FAILS (the card's own specimen shape): exactly one [loom:spawn-failed] notice lands,
//       kind:"warning", naming the task id, carrying the SAME opId the pending response returned, the
//       thrown error text, and "re-call worker_spawn".
//   (2) PENDING then SUCCEEDS: zero notices — the worker's own report is the success signal, not a push.
//   (3) FAST path (settles well within the sync-wait budget): zero notices — onSettledAfterPending never
//       fires at all for a call that never degraded to pending (the ordinary, overwhelmingly common case).
//   (4) A long thrown error message is BOUNDED in the notice (card 69246a6e manager review) — never the
//       raw, unbounded Error#message.
//   (5) A TASKLESS pending spawn that fails also gets a notice (manager review: "a failed pending spawn is
//       silent either way"), worded "(taskless)" rather than a bogus task reference.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/spawn-completion-nudge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-scn-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { removeWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=scn@loom -c user.name=scn";
const now = new Date().toISOString();

class SeamHost extends createSeamHost(PtyHost) {}
// SPY (mirrors merge-confirm-completion-nudge.mjs's SpyHost) + an INJECTABLE createPty failure: setting
// `failCreatePtyWith` to an Error makes the NEXT createPty() call throw it once (then clear itself), so a
// scenario can simulate the real EPERM-in-ensureTrustedResilient shape without touching production code.
class SpyHost extends SeamHost {
  enqueueCalls = [];
  failCreatePtyWith = null;
  enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId) {
    this.enqueueCalls.push({ sessionId, text, kind });
    return super.enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId);
  }
  createPty(opts) {
    if (this.failCreatePtyWith) {
      const err = this.failCreatePtyWith;
      this.failCreatePtyWith = null;
      throw err;
    }
    return super.createPty(opts);
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
// TINY on purpose: a REAL createWorktree() git op (which runs BEFORE createPty is ever reached) reliably
// takes far longer than this, so every call below using `svcTiny` deterministically degrades to
// {settled:false} — no artificial subprocess delay needed (unlike merge-confirm-completion-nudge.mjs,
// which needs a real GATE subprocess to outlast its budget; spawn has no gate-shaped step to delay).
const TINY_SYNC_BUDGET_MS = 1;
// GENEROUS, mirroring merge-spawn-tracked.mjs's own GENEROUS_SYNC_BUDGET_MS: scenario (3) wants the
// SYNCHRONOUS-settle shape (the ordinary, overwhelmingly common case), never a host-speed race.
const GENEROUS_SYNC_BUDGET_MS = 60_000;
const svcTiny = new SessionService(db, host, new OrchestrationControl(), { syncAttachBudgetMs: TINY_SYNC_BUDGET_MS });
const svcFast = new SessionService(db, host, new OrchestrationControl(), { syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });

function makeRepo() {
  const repo = path.join(os.tmpdir(), `loom-scn-repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo); // removeWorktree(repo, wt) below only removes the WORKTREE, never this bare repo dir
  fs.writeFileSync(path.join(repo, "README.md"), "# scn\n");
  execSync(`git init -q && git config user.email scn@loom && git config user.name scn`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
function seedProject(projId, repo) {
  db.insertProject({ id: projId, name: "SCN", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${projId}-mgr`, projectId: projId, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: `${projId}-dev`, projectId: projId, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
  db.insertSession({ id: `${projId}-mgr1`, projectId: projId, agentId: `${projId}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}
// A leftover worktree from a FAILED spawn (createWorktree succeeded, createPty then threw) has no
// surviving `.value` to read a worktreePath off — recover it by project id instead (one worktree per
// scenario's own fresh project).
function leftoverWorktreePaths(projId) {
  return db.listAllSessions().filter((s) => s.projectId === projId && s.worktreePath).map((s) => s.worktreePath);
}
function spawnFailedNudges(mgrId) {
  return host.enqueueCalls.filter((c) => c.sessionId === mgrId && /\[loom:spawn-failed\]/.test(c.text));
}

const worktrees = [];
try {
  // ============================ (1) PENDING then FAILS — the card's own specimen shape ============================
  {
    const P = "scn-fail", repo = makeRepo();
    seedProject(P, repo);
    const mgrId = `${P}-mgr1`, taskId = randomUUID();
    db.insertTask({ id: taskId, projectId: P, title: "t1", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    host.failCreatePtyWith = new Error("EPERM: operation not permitted, open 'C:\\Users\\x\\.claude.json'");
    const r = await svcTiny.spawnWorkerTracked(mgrId, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(1) degrades to pending (a real createWorktree outlasts the 1ms budget)", r.settled === false);
    check("(1) NO notice yet — the failing spawn is still running in the background", spawnFailedNudges(mgrId).length === 0);
    const opId1 = r.op.opId;
    check("(1) the pending response carries a real opId", typeof opId1 === "string" && opId1.length > 0);

    await waitUntil(() => spawnFailedNudges(mgrId).length > 0, { timeoutMs: 20_000, label: "(1) [loom:spawn-failed] nudge" });
    const nudges = spawnFailedNudges(mgrId);
    check("(1) exactly ONE [loom:spawn-failed] notice landed", nudges.length === 1);
    check("(1) pushed with kind:\"warning\" (a Loom operational nudge)", nudges[0]?.kind === "warning");
    check("(1) names the task id", nudges[0]?.text.includes(`task ${taskId}`));
    check("(1) carries the SAME opId the pending response returned", nudges[0]?.text.includes(`[op ${opId1}]`));
    check("(1) carries the thrown error text", nudges[0]?.text.includes("EPERM: operation not permitted"));
    check("(1) tells the manager to re-call worker_spawn", nudges[0]?.text.includes("re-call worker_spawn"));
    check("(1) the worker row reads exited with lastError set (reconcileFailedSpawn's own doc)", db.listAllSessions().some((s) => s.projectId === P && s.processState === "exited" && typeof s.lastError === "string"));
    worktrees.push(...leftoverWorktreePaths(P).map((wt) => [repo, wt]));
  }

  // ============================ (2) PENDING then SUCCEEDS — no notice, the worker's own report is the signal ============================
  {
    const P = "scn-success", repo = makeRepo();
    seedProject(P, repo);
    const mgrId = `${P}-mgr1`, taskId = randomUUID();
    db.insertTask({ id: taskId, projectId: P, title: "t2", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    const r = await svcTiny.spawnWorkerTracked(mgrId, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(2) degrades to pending (a real createWorktree outlasts the 1ms budget)", r.settled === false);

    await waitUntil(() => !svcTiny.listPendingSpawns(mgrId).some((op) => op.taskId === taskId), { timeoutMs: 20_000, label: "(2) pending spawn settles" });
    // No grace sleep needed here (unlike merge-confirm-completion-nudge.mjs's own trailing-echo check): the
    // onSettledAfterPending callback returns IMMEDIATELY on `outcome.ok === true` (see the fix's own
    // comment in service.ts), synchronously inside the SAME identity-guarded settle branch that evicts the
    // pendingOps entry this waitUntil just observed gone — there is no async gap in which a notice could
    // still be in flight once listPendingSpawns reflects settle.
    check("(2) the worker actually went live", db.listLiveWorkers().some((w) => w.taskId === taskId));
    check("(2) ZERO [loom:spawn-failed] notices on a successful pending spawn", spawnFailedNudges(mgrId).length === 0);
    const liveWorker = db.listLiveWorkers().find((w) => w.taskId === taskId);
    worktrees.push([repo, liveWorker.worktreePath]);
    try { host.stop(liveWorker.id, "hard"); } catch { /* best-effort cleanup */ }
  }

  // ============================ (3) FAST path — settles within budget, onSettledAfterPending never fires ============================
  {
    const P = "scn-fast", repo = makeRepo();
    seedProject(P, repo);
    const mgrId = `${P}-mgr1`, taskId = randomUUID();
    db.insertTask({ id: taskId, projectId: P, title: "t3", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    const r = await svcFast.spawnWorkerTracked(mgrId, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(3) settles synchronously within the generous budget", r.settled === true && r.ok === true);
    // No grace sleep needed: a call that never degrades to pending never sets `fresh.surfacedPending`, so
    // PendingOpRegistry.attach structurally never invokes onSettledAfterPending at all for it (see
    // pending-ops.ts's own `if (fresh.surfacedPending)` guard) — there is nothing in flight to wait out.
    check("(3) ZERO [loom:spawn-failed] notices on the ordinary fast path", spawnFailedNudges(mgrId).length === 0);
    worktrees.push([repo, r.value.worktreePath]);
    try { host.stop(r.value.id, "hard"); } catch { /* best-effort cleanup */ }
  }

  // ============================ (4) a long thrown error is BOUNDED in the notice ============================
  {
    const P = "scn-trunc", repo = makeRepo();
    seedProject(P, repo);
    const mgrId = `${P}-mgr1`, taskId = randomUUID();
    db.insertTask({ id: taskId, projectId: P, title: "t4", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    const hugeMessage = "E".repeat(1000);
    host.failCreatePtyWith = new Error(hugeMessage);
    const r = await svcTiny.spawnWorkerTracked(mgrId, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(4) degrades to pending", r.settled === false);

    await waitUntil(() => spawnFailedNudges(mgrId).length > 0, { timeoutMs: 20_000, label: "(4) [loom:spawn-failed] nudge" });
    const nudges = spawnFailedNudges(mgrId);
    check("(4) exactly ONE notice", nudges.length === 1);
    check("(4) the RAW 1000-char message is NOT embedded verbatim", nudges[0] && !nudges[0].text.includes(hugeMessage));
    check("(4) a BOUNDED, ellipsis-marked excerpt (300 chars + \u2026) is embedded instead", nudges[0]?.text.includes(`${"E".repeat(300)}\u2026`));
    worktrees.push(...leftoverWorktreePaths(P).map((wt) => [repo, wt]));
  }

  // ============================ (5) TASKLESS pending spawn that FAILS also gets a notice ============================
  {
    const P = "scn-taskless", repo = makeRepo();
    seedProject(P, repo);
    const mgrId = `${P}-mgr1`;

    host.failCreatePtyWith = new Error("EPERM: taskless specimen");
    const r = await svcTiny.spawnWorkerTracked(mgrId, { agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(5) degrades to pending", r.settled === false);
    const opId5 = r.op.opId;

    await waitUntil(() => spawnFailedNudges(mgrId).length > 0, { timeoutMs: 20_000, label: "(5) [loom:spawn-failed] nudge" });
    const nudges = spawnFailedNudges(mgrId);
    check("(5) exactly ONE notice for the taskless spawn", nudges.length === 1);
    check("(5) worded \"(taskless)\" rather than a bogus task reference", nudges[0]?.text.includes("task (taskless)"));
    check("(5) still carries the opId + error text", nudges[0]?.text.includes(`[op ${opId5}]`) && nudges[0]?.text.includes("EPERM: taskless specimen"));
    worktrees.push(...leftoverWorktreePaths(P).map((wt) => [repo, wt]));
  }
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — spawnWorkerTracked now wires onSettledAfterPending: a pending spawn that fails before the worker starts pushes exactly one [loom:spawn-failed] notice (task-ful AND taskless) naming the opId + a BOUNDED error excerpt, a pending spawn that succeeds pushes nothing (the worker's own report is the signal), and the ordinary fast (never-degraded) path never fires the hook at all."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
