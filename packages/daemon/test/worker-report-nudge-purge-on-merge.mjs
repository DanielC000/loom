import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 84a2eb2d: `purgeQueuedWorkerReportNudge` (d09d58e7) only ever fires from `worker_report_get` —
// so a manager that learns a report's content SOME OTHER WAY (the live specimen: reading git directly,
// then firing a merge/batch) leaves the queued `[loom:worker-report]` nudge to drain later as a wasted
// turn confirming something already landed.
//
// The fix: `SessionService.finalizeMerge` (the ONE writer both a solo `confirmWorkerMerge` and a
// `merge_batch` land through — see finalizeMerge's own doc on this) now calls
// `purgeQueuedWorkerReportNudgesOnMerge` right after it appends that worker's `merge_done` event — an
// OBJECTIVE, terminal signal, never an inference — via the new `PtyHost.purgeQueuedWorkerReportNudgesForWorker`.
//
// UNLIKE the report-id-keyed sibling (worker-report-nudge-purge.mjs, DoD-5: never purge by worker id, since
// a still-unread EARLIER report must survive a LATER report's own read), THIS purge is deliberately
// WORKER-scoped: once `merge_done` fires, that worker's task lifecycle is over, so every still-queued report
// nudge for it — whichever one(s) never drained — is unconditionally stale. Section (M) below proves that
// scoping directly.
//
// Also proves the fail-safe-toward-delivering boundary (DoD-3): a `merge_request` (review START, before any
// merge decision — d09d58e7's sibling report-resolution.ts doc explains why that kind never counts as
// "resolved" either) must NEVER purge a queued report nudge — section (N).
//
// HERMETIC — a REAL PtyHost (fake pty backend) + REAL git worktrees (mirrors merge-landing-column.mjs), a
// REAL Db + SessionService. No real claude, no network, no live daemon, no gateCommand configured (so
// confirmWorkerMerge's build/DoD gate never runs — same shape merge-landing-column.mjs already proves).
//
//   (U) UNIT — PtyHost.purgeQueuedWorkerReportNudgesForWorker: removes every reportEventId-tagged entry
//              FROM one worker regardless of which report it tags, leaves a DIFFERENT worker's own
//              report-tagged entry and an untagged entry untouched, FIFO preserved, dead session a no-op.
//   (F) FAIL-FIRST — the card's actual incident shape: a worker reports `done` while its manager is BUSY
//       (queues), the manager NEVER calls worker_report_get, then confirms the merge directly. The queued
//       nudge must be purged the instant merge_done lands.
//   (M) MULTI — a worker files `progress` then `done` (TWO queued nudges, two distinct reportEventIds)
//       before its manager ever looks. Once the branch is merged, BOTH are purged — this is the
//       WORKER-scoped, not report-id-scoped, behavior this card deliberately introduces.
//   (N) NEGATIVE CONTROL — `reviewWorkerMerge` (fires `merge_request` only, no merge decision made) must
//       NEVER purge the queued nudge; it survives, still genuinely undelivered.
//   (D) DURABLE — a purged entry resolves its durable session_message_queued record honestly.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-report-nudge-purge-on-merge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wrnpom-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new (createSeamHost(PtyHost))(events);
function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" }); // mark ready (startupModeCycles:0 -> synchronous)
}

const dbFile = path.join(tmpHome, "wrnpom.db");
const db = new Db(dbFile);
const sessions = new SessionService(db, host, new OrchestrationControl());
const now = new Date().toISOString();
const GIT_ID = "-c user.email=wrnpom@loom -c user.name=wrnpom";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function insertSession(projectId, agentId, id, opts) {
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: opts.cwd ?? projectId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, ...opts,
  });
}

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# wrnpom\n");
  execSync(`git init -q && git config user.email wrnpom@loom && git config user.name wrnpom`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
}

/** Sets up ONE project-backed worker: real repo + worktree + a committed change, manager+worker sessions
 *  spawned live, manager primed busy so a subsequent workerReport() call QUEUES rather than delivering.
 *  Each scenario gets its OWN project (repoPath must point at that scenario's OWN real repo — a shared
 *  project row with one fixed repoPath cannot serve multiple independent real repos). */
const reposToClean = [];
async function setupWorker(label, file) {
  const projId = `wrnpom-proj-${label}-${sfx}`, agentId = `wrnpom-agent-${label}-${sfx}`;
  const taskId = `wrnpom-task-${label}-${sfx}`;
  const mgrId = `wrnpom-mgr-${label}-${sfx}`;
  const workerId = `wrnpom-wkr-${label}-${sfx}`;
  const repo = path.join(os.tmpdir(), `loom-wrnpom-repo-${label}-${sfx}`);
  reposToClean.push(repo);
  makeRepo(repo);
  db.insertProject({ id: projId, name: `WRNPOM-${label}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "", position: 0 });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), "part 1\n");
  commitAll(worktreePath, file, GIT_ID);

  db.insertTask({ id: taskId, projectId: projId, title: `WRNPOM-${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  insertSession(projId, agentId, mgrId, { role: "manager" });
  insertSession(projId, agentId, workerId, { role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, cwd: worktreePath });
  spawnReady(mgrId);
  spawnReady(workerId);
  const primer = host.enqueueStdin(mgrId, "PRIMER"); // idle -> delivers now, arms busy so a report holds
  check(`(${label}) setup: primer delivered + armed busy`, primer.delivered === true);
  return { taskId, mgrId, workerId, repo, worktreePath, branch };
}

try {
  // ============================ (U) UNIT: purgeQueuedWorkerReportNudgesForWorker on the raw PtyHost =========
  {
    const SID = "u-sess";
    spawnReady(SID);
    const primer = host.enqueueStdin(SID, "PRIMER");
    check("(U) setup: primer delivered + armed busy", primer.delivered === true);
    host.enqueueStdin(SID, "report-A-from-w1", "system", undefined, undefined, "agent", undefined, undefined, undefined, "worker-1", { reportEventId: "ra" });
    host.enqueueStdin(SID, "direction-1", "system", undefined, undefined, "agent"); // no reportEventId, no senderId -> untagged
    host.enqueueStdin(SID, "report-B-from-w1", "system", undefined, undefined, "agent", undefined, undefined, undefined, "worker-1", { reportEventId: "rb" }); // SAME worker, DIFFERENT reportEventId
    host.enqueueStdin(SID, "report-C-from-w2", "system", undefined, undefined, "agent", undefined, undefined, undefined, "worker-2", { reportEventId: "rc" }); // DIFFERENT worker
    // NOT asserting exact order: enqueueStdin reorders a same-sender agent-kind arrival to land right after
    // that sender's own last queued entry (see CLAUDE.md) — B-from-w1 may land adjacent to A-from-w1 rather
    // than at the FIFO tail. Assert membership/count only; the FIFO-among-worker-1's-own-entries check below
    // is what actually matters for this section.
    check("(U) setup: all 4 entries queued", host.getPendingEntries(SID).length === 4
      && ["report-A-from-w1", "direction-1", "report-B-from-w1", "report-C-from-w2"].every((t) => host.getPending(SID).includes(t)));

    const removed = host.purgeQueuedWorkerReportNudgesForWorker(SID, "worker-1");
    check("(U) purge returns BOTH worker-1 entries (different reportEventIds), relative FIFO order among themselves", removed.length === 2 && removed[0].text === "report-A-from-w1" && removed[1].text === "report-B-from-w1");
    check("(U) purge removed both worker-1 entries, left direction-1 and worker-2's own report untouched",
      host.getPendingEntries(SID).length === 2 && host.getPending(SID).includes("direction-1") && host.getPending(SID).includes("report-C-from-w2"));

    const again = host.purgeQueuedWorkerReportNudgesForWorker(SID, "worker-1");
    check("(U) re-purging the same worker is a safe no-op (nothing left)", again.length === 0);

    const deadSession = host.purgeQueuedWorkerReportNudgesForWorker("no-such-session", "worker-2");
    check("(U) purge on a dead/unknown session returns [] rather than throwing", deadSession.length === 0);

    host.purgeQueuedWorkerReportNudgesForWorker(SID, "worker-2"); // clean up so it can't leak into another section
  }

  // ============================ (F) FAIL-FIRST: the card's actual incident shape =============================
  {
    const { mgrId, workerId } = await setupWorker("f", "feat-f.txt");

    const r = await sessions.workerReport(workerId, { status: "done", summary: "MERGE-PURGE-MARKER-F" });
    check("(F) report HELD, not delivered now ('queued')", r.deliveryStatus === "queued");
    check("(F) the queued nudge sits on the manager's FIFO", host.getPending(mgrId).some((t) => t.includes("MERGE-PURGE-MARKER-F")));
    const undelivBefore = db.listUndeliveredQueuedMessages();
    check("(D) setup: the report has a durable session_message_queued record before the merge", undelivBefore.some((e) => e.detail?.text?.includes("MERGE-PURGE-MARKER-F")));

    // The manager NEVER calls worker_report_get — it acts on the branch directly (the incident's own
    // description: "verified at source ... fired the batch").
    const confirm = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(F) merge succeeds", confirm.merged === true);

    const afterMerge = host.getPending(mgrId);
    check("(F) THE FIX: the queued report nudge is now PURGED — no wasted turn confirming already-landed work", !afterMerge.some((t) => t.includes("MERGE-PURGE-MARKER-F")));

    const undelivAfter = db.listUndeliveredQueuedMessages();
    check("(D) the purged entry's durable record is resolved — never reads as lost", !undelivAfter.some((e) => e.detail?.text?.includes("MERGE-PURGE-MARKER-F")));
  }

  // ============================ (M) MULTI: worker-scoped, unlike the report-id-keyed sibling ================
  {
    const { mgrId, workerId } = await setupWorker("m", "feat-m.txt");

    const r1 = await sessions.workerReport(workerId, { status: "progress", summary: "MERGE-PURGE-MARKER-M-progress" });
    check("(M) report 1 (progress) HELD ('queued')", r1.deliveryStatus === "queued");
    const r2 = await sessions.workerReport(workerId, { status: "done", summary: "MERGE-PURGE-MARKER-M-done" });
    check("(M) report 2 (done) HELD ('queued')", r2.deliveryStatus === "queued");
    check("(M) setup: BOTH queued, distinct reportEventIds",
      host.getPending(mgrId).some((t) => t.includes("MERGE-PURGE-MARKER-M-progress")) &&
      host.getPending(mgrId).some((t) => t.includes("MERGE-PURGE-MARKER-M-done")));

    const confirm = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(M) merge succeeds", confirm.merged === true);

    const afterMerge = host.getPending(mgrId);
    check("(M) WORKER-SCOPED: the EARLIER progress nudge is ALSO purged (unlike d09d58e7's report-id-only purge)", !afterMerge.some((t) => t.includes("MERGE-PURGE-MARKER-M-progress")));
    check("(M) the done nudge is purged too", !afterMerge.some((t) => t.includes("MERGE-PURGE-MARKER-M-done")));
  }

  // ============================ (N) NEGATIVE CONTROL: merge_request alone must never purge ===================
  {
    const { mgrId, workerId } = await setupWorker("n", "feat-n.txt");

    const r = await sessions.workerReport(workerId, { status: "done", summary: "MERGE-PURGE-MARKER-N-must-survive" });
    check("(N) report HELD ('queued')", r.deliveryStatus === "queued");

    // Review-start ONLY — no merge decision made yet (the manager "pulled up the diff").
    const review = await sessions.reviewWorkerMerge(mgrId, workerId);
    check("(N) setup: review ran (merge_request recorded)", review.filesChanged >= 1);

    const afterReview = host.getPending(mgrId);
    check("(N) FAIL-SAFE (DoD-3): merge_request alone must NOT purge the queued report nudge", afterReview.some((t) => t.includes("MERGE-PURGE-MARKER-N-must-survive")));

    const undeliv = db.listUndeliveredQueuedMessages();
    check("(N) the report's durable record is STILL genuinely undelivered", undeliv.some((e) => e.detail?.text?.includes("MERGE-PURGE-MARKER-N-must-survive")));

    // Clean up (leave nothing merged/dangling for this worker's worktree).
    host.stop(workerId, "hard");
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (const repo of reposToClean) { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PtyHost.purgeQueuedWorkerReportNudgesForWorker drops EVERY reportEventId-tagged queued nudge from one worker (any report, FIFO preserved, a different worker's own report and untagged entries untouched, dead session a safe no-op); finalizeMerge now calls it right after appending merge_done, so a queued report nudge is purged the instant a manager finalizes that worker's branch WITHOUT ever calling worker_report_get (the card's real incident) — worker-scoped (an earlier UNREAD progress report is purged too, unlike d09d58e7's report-id-only purge, because the worker's task lifecycle is genuinely over once merge_done lands) — while merge_request alone (review-start, before any merge decision) never purges anything, and every purged entry resolves its durable record honestly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
