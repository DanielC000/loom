import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Reused-verdict merge confirm vs. the idle-worker watchdog (card 6119778b, reported by the Selbstläufer
// manager 2026-09-21, n=2 same day).
//
// THE BUG: `classifyIdleWorker`'s PENDING-MERGE GUARD (sessions/service.ts) reads `pendingMerge.state`
// as "running" for the ENTIRE lifetime of a `worker_merge_confirm` op — including a REUSED verdict's real
// (but gate-less) squash/worktree-cleanup work (`gateRan:false`, `reusedOpId` set). If the periodic
// idle-worker tick classifies+enqueues a `[loom:worker-idle]` "its merge gate ... runs ... you'll get a
// [loom:merge-done]/[loom:merge-failed] nudge when it does" notice WHILE the confirm call is still
// mid-flight (the manager busy running that very tool call), that promise is already false the instant
// the call returns SYNCHRONOUSLY (EXACTLY-ONE-SIGNAL, decision 187f5b76 — no separate settle nudge is
// ever coming for a call that already returned its full result inline). The queued nudge then drains on
// the manager's next turn, describing a merge that has ALREADY settled — worker_list already empty, the
// squash already on main — directly contradicting what the manager just measured.
//
// THE FIX: `confirmWorkerMerge`'s Green path and `finishAlreadyMerged` both now purge any still-queued
// `[loom:worker-idle]`/`[loom:worker-spawn-broken]` nudge for the retiring worker (via
// `PtyHost.purgeQueuedWorkerIdleNudges`) BEFORE the hard-stop — the SAME evaluation-vs-delivery-gap fix
// task 69a128b0 already applied to `recycleWorker` (see idle-nudge-recycle-purge.mjs), applied to the
// merge-settle edge instead of the recycle edge.
//
// HERMETIC — a REAL PtyHost (fake pty backend whose kill() synchronously fires the REAL captured onExit
// callback, mirroring idle-nudge-recycle-purge.mjs's SeamHost) driving a REAL Db + SessionService (with
// an INJECTED `runGate` seam so the self-check settles instantly without spawning a real gate command,
// mirroring merge-gate-reuse.mjs) over a REAL git repo + worktree (`createWorktree`), and a REAL
// `confirmWorkerMergeTracked()` call — not a fabricated merge_done event.
//
// THE RACE ITSELF IS REPRODUCED, NOT ASSUMED: `PendingOpRegistry.attach()` registers its entry
// SYNCHRONOUSLY, before `run()`'s first internal `await` — but `confirmWorkerMergeTracked` itself does a
// real `await resolveGitRef(...)` (a genuine async git spawn) BEFORE ever calling `attach()`, so there is
// a real window where `sessions.confirmWorkerMergeTracked(...)` has been called but the "merge:<worker>"
// op is not yet registered. This test polls `pendingOps.peek()` (an OBSERVABLE, real-state check — never
// a fixed sleep) until the op is genuinely "running", THEN fires the real classification/notify call at
// that exact moment — reproducing what the periodic idle-watcher tick would do if it landed in that same
// window — before letting the real confirm settle.
//
// Asserts:
//   (1) PRECONDITION — the race is real: the op is observed "running" mid-flight, and
//       notifyManagerOfIdleWorker (called at that moment, manager genuinely busy) queues a
//       `[loom:worker-idle]` nudge naming THIS confirm's real opId — proving RED is reachable at all.
//   (2) THE FIX — once the real confirm settles (gateRan:false, reusedOpId set — a genuine reuse), that
//       stale nudge is gone from the manager's queue; it can never drain describing an already-settled
//       merge.
//   (3) NOT OVER-SUPPRESSED — an unrelated worker's own genuine queued idle nudge, present in the SAME
//       manager queue at the same time, survives untouched (the purge is scoped by workerSessionId, not a
//       blanket queue flush).
//
// RUN (no daemon needed): node test/merge-reuse-idle-nudge-purge.mjs
//   Requires the daemon built first (reads ../dist/*.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mrinp-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { PtyHost } = await import("../dist/pty/host.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mrinp@loom -c user.name=mrinp";
const now = new Date().toISOString();

// Same fake-pty shape as idle-nudge-recycle-purge.mjs: kill() synchronously fires the REAL captured
// onExit callback, so confirmWorkerMerge's hard-stop-then-poll wait loop resolves deterministically fast
// instead of spinning its full ~5s bound.
const exitCbs = new Map();
function makeFakePty(sessionId) {
  const writes = [];
  return {
    pid: 4242,
    write: (d) => { writes.push(d); },
    onData: () => ({ dispose() {} }),
    onExit(cb) { exitCbs.set(sessionId, cb); return { dispose() {} }; },
    kill() { const cb = exitCbs.get(sessionId); if (cb) cb({ exitCode: 0 }); },
    resize: () => {},
    writes,
  };
}
class TestPtyHost extends PtyHost { createPty(opts) { return makeFakePty(opts.sessionId); } }

let sessions;
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  onBusy: (sessionId, busy) => {
    db.setBusy(sessionId, busy);
    if (!busy) sessions.notifyManagerOfIdleWorker(sessionId);
    else sessions.purgeStaleIdleNudgeForReengagedWorker(sessionId);
  },
};

const dbFile = path.join(process.env.LOOM_HOME, "mrinp.db");
const db = new Db(dbFile);
const projId = "mrinp-proj", agentId = "mrinp-agent", taskId = "mrinp-task";
const mgrId = "mrinp-mgr", wkrId = "mrinp-wkr";
const repo = path.join(os.tmpdir(), `loom-mrinp-repo-${Date.now()}-${process.pid}`);

let calls = 0;
const fakeGate = async () => { calls++; return { passed: true }; };

const host = new TestPtyHost(events);
sessions = new SessionService(db, host, new OrchestrationControl(), { runGate: fakeGate });

function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: process.env.LOOM_HOME,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" }); // ready synchronously (startupModeCycles:0)
}

let worktreePath;
try {
  // ── Real git repo + worktree ────────────────────────────────────────────────────────────────────────
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mrinp\n");
  execSync(`git init -q && git config user.email mrinp@loom && git config user.name mrinp`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);

  // setProjectConfig REPLACES config_json wholesale (never merges) — both overrides must land in the SAME
  // insertProject call, or a later setProjectConfig call wipes the gateCommand this test's reuse
  // precondition depends on.
  db.insertProject({ id: projId, name: "MRINP", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" }, permission: { startupModeCycles: 0 } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MRINP-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: `eng-${mgrId}`, title: null, cwd: process.env.LOOM_HOME, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const created = await createWorktree(repo, projId, taskId);
  worktreePath = created.worktreePath;
  const branch = created.branch;
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work for mrinp\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  db.insertSession({ id: wkrId, projectId: projId, agentId, engineSessionId: `eng-${wkrId}`, title: null, cwd: worktreePath, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  // A second, wholly UNRELATED worker — for the NOT-OVER-SUPPRESSED check (3) below: its own genuine
  // queued idle nudge must survive the FIRST worker's merge settling, proving the purge is scoped by
  // workerSessionId (a text-prefix match), not a blanket flush of the manager's whole queue.
  const wkrId2 = "mrinp-wkr2", taskId2 = "mrinp-task2";
  db.insertTask({ id: taskId2, projectId: projId, title: "MRINP-TASK-2", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });
  db.insertSession({ id: wkrId2, projectId: projId, agentId, engineSessionId: `eng-${wkrId2}`, title: null, cwd: process.env.LOOM_HOME, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskId2 });

  spawnReady(mgrId);

  // ── Worker's own green self-check (the reuse precondition) ─────────────────────────────────────────
  const selfCheck = await sessions.runWorkerGate(wkrId);
  check("setup: self-check settled green", selfCheck.settled === true && selfCheck.ok === true && selfCheck.value.passed === true);
  check("setup: gate called exactly once (the self-check)", calls === 1);

  // ── The manager is genuinely BUSY, exactly as it is for the real turn that calls worker_merge_confirm —
  //    armed the SAME proven way idle-nudge-recycle-purge.mjs does: the worker's own report delivers LIVE
  //    to the idle manager, which arms busy=true via the M1 optimistic set (a real turn boundary, not a
  //    synthetic flag flip). ─────────────────────────────────────────────────────────────────────────────
  const reportResult = await sessions.workerReport(wkrId, { status: "progress", summary: "self-check green, awaiting merge" });
  check("setup: the worker's report delivered live (manager was idle)", reportResult.deliveryStatus === "delivered-live");
  check("setup: manager is busy (armed by the just-delivered report)", db.getSession(mgrId).busy === true);

  // ── The UNRELATED second worker goes idle-and-unreported WHILE the manager is busy — its own queued
  //    nudge must survive everything below (scenario (3)). Real UserPromptSubmit+Stop cycle (card
  //    2281009d — SessionStart alone isn't proof a turn ran); Stop's busy(false) edge fires
  //    notifyManagerOfIdleWorker automatically via this test's own events.onBusy wiring. ────────────────
  spawnReady(wkrId2);
  host.deliverHook(wkrId2, { hook_event_name: "UserPromptSubmit" });
  host.deliverHook(wkrId2, { hook_event_name: "Stop" });
  const unrelatedNudgeBefore = host.getPendingEntries(mgrId).find((e) => e.text.startsWith(`[loom:worker-idle] worker ${wkrId2} `));
  check("(3) setup: the UNRELATED worker's own genuine idle nudge is queued (manager busy)", !!unrelatedNudgeBefore);

  // ── Kick off the REAL confirm (not yet awaited) ─────────────────────────────────────────────────────
  let confirmSettled = false;
  const confirmPromise = sessions.confirmWorkerMergeTracked(mgrId, wkrId).then((r) => { confirmSettled = true; return r; });

  // ── Poll REAL state until the merge op is genuinely "running" (never a fixed sleep — a bounded ceiling
  //    on an OBSERVABLE, real-state check, not a wait-then-assert). `setImmediate` alone under-samples a
  //    multi-git-subprocess async window; a short real setTimeout between checks gives each poll a wider
  //    wall-clock ceiling (bounded well under confirmWorkerMergeTracked's own 12s sync-attach budget). ──
  const mergeKey = `merge:${wkrId}`;
  let observedOpId = null;
  for (let i = 0; i < 4000 && !observedOpId && !confirmSettled; i++) {
    const p = sessions.pendingOps.peek(mergeKey);
    if (p && p.state === "running") observedOpId = p.opId;
    else await new Promise((r) => setTimeout(r, 2));
  }
  check("(1) precondition: the confirm's own merge op was observed genuinely RUNNING mid-flight", !!observedOpId);

  // ── Fire the real classification/notify AT that exact moment — reproduces the periodic idle-watcher
  //    tick landing inside the race window, on the REAL, unmodified classifyIdleWorker/notify path. ────
  sessions.notifyManagerOfIdleWorker(wkrId);
  const queuedMidFlight = host.getPendingEntries(mgrId);
  const staleNudge = queuedMidFlight.find((e) => e.text.startsWith(`[loom:worker-idle] worker ${wkrId} `));
  check("(1) a nudge naming this worker IS queued (manager busy, so it queues rather than delivers live)", !!staleNudge);
  check("(1) it names the confirm's REAL opId as its merge gate", !!staleNudge && staleNudge.text.includes(observedOpId));
  check("(1) it claims the gate 'runs' and promises a future settle nudge", !!staleNudge && /runs on its own branch/.test(staleNudge.text) && /\[loom:merge-done\]/.test(staleNudge.text));

  // ── Let the REAL confirm settle ──────────────────────────────────────────────────────────────────────
  const confirm = await confirmPromise;
  check("confirm: settled (not still pending)", confirm.settled === true);
  const value = confirm.settled && confirm.ok ? confirm.value : undefined;
  check("confirm: merged:true", value?.merged === true);
  check("confirm: gateRan:false — a GENUINE reuse, not a real gate run", value?.gateRan === false);
  check("confirm: reusedOpId === the self-check's own opId", value?.reusedOpId === selfCheck.value.opId);
  check("confirm: the gate command was never called a second time", calls === 1);

  // ── (2) THE FIX: the stale nudge naming the now-settled confirm's opId must be gone ─────────────────
  const queuedAfter = host.getPendingEntries(mgrId);
  check("(2) the STALE '[loom:worker-idle] worker <this> ... merge gate <opId> ... running' nudge is purged once the reused-verdict merge settles",
    !queuedAfter.some((e) => e.text.startsWith(`[loom:worker-idle] worker ${wkrId} `) && e.text.includes(observedOpId)));

  // ── (3) NOT OVER-SUPPRESSED: the unrelated second worker's own genuine nudge is untouched ───────────
  check("(3) the UNRELATED worker's own queued idle nudge survives — the purge is scoped by workerSessionId, not a blanket queue flush",
    queuedAfter.some((e) => e.text.startsWith(`[loom:worker-idle] worker ${wkrId2} `)));
} finally {
  try { db.close(); } catch { /* ignore */ }
  if (worktreePath) cleanupPathSync(worktreePath);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a worker's REUSED-verdict merge confirm (gateRan:false, reusedOpId set) purges any [loom:worker-idle] nudge that raced its own PendingOpRegistry op as 'running', so a manager busy mid-call never later drains a nudge describing a merge that already settled synchronously and promising a [loom:merge-done]/[loom:merge-failed] follow-up that (per EXACTLY-ONE-SIGNAL) was never coming."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
