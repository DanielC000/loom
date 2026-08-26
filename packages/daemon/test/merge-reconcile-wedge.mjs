import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Boot-reconcile Pass-A wedged-repoKey test (card c33f94b2). REAL git on a temp repo, NO claude and NO
// live daemon — drives SessionService.reconcileOrchestrationOnBoot() directly against an isolated
// LOOM_HOME. Proves the three things the card's DoD-5 asks for:
//   (a) a repoKey that cannot resolve is tracked DISTINCTLY from a generic/transient failure (never
//       "retry next boot" — a dedicated wedge counter/detail/warn, and escalates past a threshold).
//   (b) a genuine branch-gone record (task done, merge_request, no terminal event, no repoKey issue) is
//       resolved by Pass A2 exactly as before — a non-regression control.
//   (c) THE INTERACTION: a session that is BOTH branch-gone-resolvable (Pass A2's own criteria) AND has
//       an unresolvable repoKey. This is the Platform Lead's addendum hypothesis, made falsifiable: does
//       the repoKey failure block Pass A2's resolution from ever taking effect on a LATER boot's Pass A?
//       Answer, verified here: NO — Pass A2 still fires in the SAME boot (it never resolves a repo at
//       all), but pre-fix, Pass A's own early-out ran AFTER repoKey resolution, so it would have kept
//       throwing on this session every subsequent boot even after Pass A2 cleared it. This test proves
//       the fix (reordering the early-out ahead of repoKey resolution): boot 2 for this session is a
//       clean skip, no throw, no wedge entry left behind.
// Run: 1) build daemon, 2) node test/merge-reconcile-wedge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mrw-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(" ")); realWarn(...a); };
const warnsMatching = (needle) => warns.filter((w) => w.includes(needle));

const GIT_ID = "-c user.email=mrw@loom -c user.name=mrw";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// A tiny real repo — never actually touched by the wedged sessions below (they throw on repoKey
// resolution before any git op), but reconcile needs a real project.repoPath to resolve `project`.
const repo = path.join(os.tmpdir(), `loom-mrw-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# mrw\n");
execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

const projId = `mrw-proj-${sfx}`;
// db test constructor: (db, opts, control) — the escalate threshold is lowered to 2 attempts so the
// test doesn't need to simulate days of elapsed wall-clock time to prove escalation fires.
const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl(), { mergeReconcileEscalateAttempts: 2, mergeReconcileEscalateMs: 24 * 60 * 60_000 });

db.insertProject({ id: projId, name: "MRW", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, repos: [] });
db.insertAgent({ id: `mrw-agent-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });

function seedSession(p, { taskColumn, withMergeRequest }) {
  db.insertTask({ id: p.taskId, projectId: projId, title: "MRW-TASK", body: "", columnKey: taskColumn, position: 1, createdAt: now, updatedAt: now });
  db.insertSession({
    id: p.mgrId, projectId: projId, agentId: `mrw-agent-${sfx}`, engineSessionId: null, title: null, cwd: repo,
    processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  db.insertSession({
    id: p.workerId, projectId: projId, agentId: `mrw-agent-${sfx}`, engineSessionId: null, title: null,
    cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch,
    repoKey: p.repoKey,
  });
  if (withMergeRequest) {
    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: p.mgrId, workerSessionId: p.workerId, taskId: p.taskId, kind: "merge_request", detail: { branch: p.branch } });
  }
}

// --- (a) wedge-only: repoKey unresolvable, task NEVER done, no merge_request — Pass A2 can never touch
//     it either, so this session is genuinely, permanently stuck until a human intervenes. ---
const A = {
  taskId: `mrw-a-task-${sfx}`, mgrId: `mrw-a-mgr-${sfx}`, workerId: `mrw-a-wkr-${sfx}`,
  worktreePath: path.join(os.tmpdir(), `loom-mrw-a-worktree-${sfx}`), // deliberately never created on disk
  branch: `loom/mrw-a-${sfx}`, repoKey: "ghost-repo",
};
seedSession(A, { taskColumn: "in_progress", withMergeRequest: false });

// --- (c) the interaction: repoKey unresolvable AND task is done + has a merge_request + no terminal
//     event — exactly Pass A2's own resolution criteria, independent of repoKey. ---
const C = {
  taskId: `mrw-c-task-${sfx}`, mgrId: `mrw-c-mgr-${sfx}`, workerId: `mrw-c-wkr-${sfx}`,
  worktreePath: path.join(os.tmpdir(), `loom-mrw-c-worktree-${sfx}`), // deliberately never created on disk
  branch: `loom/mrw-c-${sfx}`, repoKey: "ghost-repo",
};
seedSession(C, { taskColumn: "done", withMergeRequest: true });

const hasTerminal = (workerId) => db.listEventsForWorker(workerId).some((e) => e.kind === "merge_done" || e.kind === "merge_rejected");

try {
  check("(pre) scenario A worktree absent from disk", !fs.existsSync(A.worktreePath));
  check("(pre) scenario C worktree absent from disk", !fs.existsSync(C.worktreePath));
  check("(pre) scenario C task starts done", db.getTask(C.taskId).columnKey === "done");
  check("(pre) scenario C has a dangling merge_request (no terminal event)", !hasTerminal(C.workerId));

  // ═══════════════ BOOT 1 ═══════════════
  const r1 = await sessions.reconcileOrchestrationOnBoot();

  // (a) tracked as a WEDGE, not a generic failure — mergesFailed still counts it (nothing is silently
  // dropped from the aggregate), but mergeReconcileWedged distinguishes it, and mergeFailureDetails names it.
  check("(1a) reconcile counted the wedge in mergesFailed", r1.mergesFailed >= 1);
  check("(1a) reconcile counted exactly the wedge(s) expected this boot in mergeReconcileWedged", r1.mergeReconcileWedged === 2); // A and C both wedge on boot 1
  const detailA1 = r1.mergeFailureDetails.find((d) => d.sessionId === A.workerId);
  check("(1a) mergeFailureDetails names scenario A as wedged", detailA1?.wedged === true);
  check("(1a) mergeFailureDetails carries a wedgedSince timestamp", typeof detailA1?.wedgedSince === "string" && detailA1.wedgedSince.length > 0);
  check("(1a) mergeFailureDetails carries attempts=1 on first sighting", detailA1?.attempts === 1);
  check("(1a) per-session warn names the worker + branch (not a bare count)",
    warnsMatching(A.workerId).some((w) => w.includes(A.branch) && w.includes("permanently wedged")));
  check("(1a) aggregated boot-summary warn names the project (not just a count)",
    warnsMatching("permanently wedged on an unresolvable repoKey").some((w) => w.includes("MRW") && w.includes(A.workerId.slice(0, 8))));
  check("(1a) NOT escalated yet (1 attempt < threshold of 2)", db.getMergeReconcileWedge(A.workerId)?.escalated === false);
  check("(1a) NO [loom:merge-orphaned] escalation fired yet", warnsMatching(`escalated [loom:merge-orphaned]`).filter((w) => w.includes(A.workerId)).length === 0);

  // (c) Pass A wedges it too (repoKey resolution comes first for a session that ISN'T yet finalized)...
  const detailC1 = r1.mergeFailureDetails.find((d) => d.sessionId === C.workerId);
  check("(1c) scenario C ALSO wedged on boot 1 (not yet finalized, so repoKey resolution still runs)", detailC1?.wedged === true);
  // ...but Pass A2 (same boot, no repoKey dependency at all) independently resolves it via the event trail.
  check("(1c) Pass A2 emitted the branch-gone merge_done for scenario C in the SAME boot", r1.staleMergesResolved === 1 && hasTerminal(C.workerId));

  // ═══════════════ BOOT 2 — the crux ═══════════════
  const r2 = await sessions.reconcileOrchestrationOnBoot();

  // (c) THE HYPOTHESIS TEST: scenario C is now already-finalized (merge_done exists) AND its worktree is
  // still absent — Pass A's early-out must fire BEFORE repoKey resolution, so no throw, no new wedge
  // attempt, and its wedge entry (recorded on boot 1) is cleared.
  const detailC2 = r2.mergeFailureDetails.find((d) => d.sessionId === C.workerId);
  check("(2c) scenario C is NO LONGER wedged on boot 2 (Pass A2's resolution took effect)", detailC2 === undefined);
  check("(2c) scenario C's wedge entry was cleared from tracking", db.getMergeReconcileWedge(C.workerId) === undefined);
  check("(2c) scenario C's merge_done is still exactly one (Pass A2 idempotent, no duplicate)",
    db.listEventsForWorker(C.workerId).filter((e) => e.kind === "merge_done").length === 1);

  // (a) scenario A is STILL genuinely wedged (never finalized by anything) — attempts bump, firstWedgedAt
  // is preserved (distinguishing "deferred once" from "wedged since <the original date>"), and past the
  // (test-lowered) threshold of 2 attempts it escalates — exactly once.
  const detailA2 = r2.mergeFailureDetails.find((d) => d.sessionId === A.workerId);
  check("(2a) scenario A wedged again on boot 2", detailA2?.wedged === true);
  check("(2a) attempts bumped to 2 (not reset)", detailA2?.attempts === 2);
  check("(2a) wedgedSince UNCHANGED across boots (first-seen, not last-attempt)", detailA2?.wedgedSince === detailA1?.wedgedSince);
  check("(2a) NOW escalated (attempts=2 crossed the test threshold of 2)", db.getMergeReconcileWedge(A.workerId)?.escalated === true);
  check("(2a) escalation nudge attempted exactly once", warnsMatching(`escalated [loom:merge-orphaned]`).filter((w) => w.includes(A.workerId)).length === 1);

  // ═══════════════ BOOT 3 — escalation is one-shot, not re-fired every boot past threshold ═══════════════
  const r3 = await sessions.reconcileOrchestrationOnBoot();
  const detailA3 = r3.mergeFailureDetails.find((d) => d.sessionId === A.workerId);
  check("(3a) scenario A still wedged (genuinely permanent — no branch-gone path can ever reach it)", detailA3?.wedged === true && detailA3?.attempts === 3);
  check("(3a) escalation NOT re-fired a second time (idempotent past threshold)",
    warnsMatching(`escalated [loom:merge-orphaned]`).filter((w) => w.includes(A.workerId)).length === 1);
} finally {
  console.warn = realWarn;
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a Pass-A session with an unresolvable repoKey is tracked as a distinct, named, escalating wedge (never a bare 'retry next boot' count); a genuine branch-gone record still resolves via Pass A2 unaffected; and a session that is BOTH (Pass A2-resolvable AND repoKey-wedged) is no longer re-thrown on every subsequent boot once Pass A2 clears it — confirming the reorder fix for the addendum's short-circuit hypothesis."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
