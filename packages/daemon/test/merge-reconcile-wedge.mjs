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
import { commitAll } from "./_git-commit.mjs";

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

const infos = [];
const realInfo = console.info;
console.info = (...a) => { infos.push(a.join(" ")); realInfo(...a); };
const infosMatching = (needle) => infos.filter((w) => w.includes(needle));

const GIT_ID = "-c user.email=mrw@loom -c user.name=mrw";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// A tiny real repo — never actually touched by the wedged sessions below (they throw on repoKey
// resolution before any git op), but reconcile needs a real project.repoPath to resolve `project`.
const repo = path.join(os.tmpdir(), `loom-mrw-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# mrw\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", GIT_ID);

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

// --- second project, DELIBERATELY configured with zero kanban columns — the one way
//     columnKeyForProjectRole(..., "terminal") returns undefined (columnKeyForRole's own "empty board"
//     case; kanbanColumns:[] is an explicit override, not an absent one, so resolveConfig's `??` does
//     NOT fall back to the platform default). Needed for scenario E below: a session's task_id is a
//     deliberately SOFT link (no FK — see the `sessions` table's own doc), so a deleted task also makes
//     `getTask(...)?.columnKey` undefined — pairing the two `undefined`s is the only way to actually
//     exercise the `undefined === undefined` trap the fix below guards against. ---
const projId2 = `mrw-proj2-${sfx}`;
db.insertProject({ id: projId2, name: "MRW2-EMPTY-BOARD", repoPath: repo, vaultPath: repo, config: { kanbanColumns: [] }, createdAt: now, archivedAt: null, repos: [] });
db.insertAgent({ id: `mrw-agent2-${sfx}`, projectId: projId2, name: "t2", startupPrompt: "", position: 0 });

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

// --- (d) card 6f73da1a: repoKey unresolvable AND task is done AND no merge_request was EVER filed —
//     a declared no-commit completion (e.g. worker_report done noChanges:true, auto-retired) that never
//     touched any repo. Distinct from (c): there is no dangling merge for Pass A2 to resolve either —
//     nothing was ever pending. This must never even become a tracked wedge, on the FIRST boot. ---
const D = {
  taskId: `mrw-d-task-${sfx}`, mgrId: `mrw-d-mgr-${sfx}`, workerId: `mrw-d-wkr-${sfx}`,
  worktreePath: path.join(os.tmpdir(), `loom-mrw-d-worktree-${sfx}`), // deliberately never created on disk
  branch: `loom/mrw-d-${sfx}`, repoKey: "ghost-repo",
};
seedSession(D, { taskColumn: "done", withMergeRequest: false });

// --- (e) the manager's post-review ask: same shape as D (no merge_request, no worktree) BUT on the
//     empty-board project AND with taskId pointing at a task row that was NEVER inserted (simulates a
//     deleted task — task_id is a soft link, so this is a legitimate, reachable state). Both sides of
//     the old bare `===` would read undefined here — this must NOT be treated as terminal; it must stay
//     on the genuinely-wedged path (like scenario A), never silently skipped. ---
const E = {
  taskId: `mrw-e-task-${sfx}`, mgrId: `mrw-e-mgr-${sfx}`, workerId: `mrw-e-wkr-${sfx}`,
  worktreePath: path.join(os.tmpdir(), `loom-mrw-e-worktree-${sfx}`), // deliberately never created on disk
  branch: `loom/mrw-e-${sfx}`, repoKey: "ghost-repo",
};
// NO db.insertTask(E.taskId, ...) — the task row is deliberately absent.
db.insertSession({
  id: E.mgrId, projectId: projId2, agentId: `mrw-agent2-${sfx}`, engineSessionId: null, title: null, cwd: repo,
  processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
db.insertSession({
  id: E.workerId, projectId: projId2, agentId: `mrw-agent2-${sfx}`, engineSessionId: null, title: null,
  cwd: E.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "worker", parentSessionId: E.mgrId, taskId: E.taskId, worktreePath: E.worktreePath, branch: E.branch,
  repoKey: E.repoKey,
});
// (no merge_request event for E — mirrors D's "never attempted" shape)

// --- (f) card 1d10aea9: Pass A2's OWN terminal check (`getTask(...)?.columnKey !== terminalKey`, the
//     SECOND loop, independent of Pass A's `isTerminalTask` fixed by scenario E above) has the identical
//     undefined===undefined shape. Same double-degenerate setup as E (empty-board project, deleted task)
//     but WITH a merge_request on record and no terminal event — Pass A2's OWN criteria for "resolve a
//     dangling merge via the event trail". Pre-fix, the bare `!==` reads undefined!==undefined as false
//     and does NOT `continue`, so Pass A2 fabricates a merge_done for a session that (as far as anything
//     can actually tell — the task is gone, the project has no terminal column at all) was never
//     confirmed landed. Post-fix it must fall through and stay genuinely wedged, like E. ---
const F = {
  taskId: `mrw-f-task-${sfx}`, mgrId: `mrw-f-mgr-${sfx}`, workerId: `mrw-f-wkr-${sfx}`,
  worktreePath: path.join(os.tmpdir(), `loom-mrw-f-worktree-${sfx}`), // deliberately never created on disk
  branch: `loom/mrw-f-${sfx}`, repoKey: "ghost-repo",
};
// NO db.insertTask(F.taskId, ...) — the task row is deliberately absent (simulated delete).
db.insertSession({
  id: F.mgrId, projectId: projId2, agentId: `mrw-agent2-${sfx}`, engineSessionId: null, title: null, cwd: repo,
  processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
db.insertSession({
  id: F.workerId, projectId: projId2, agentId: `mrw-agent2-${sfx}`, engineSessionId: null, title: null,
  cwd: F.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "worker", parentSessionId: F.mgrId, taskId: F.taskId, worktreePath: F.worktreePath, branch: F.branch,
  repoKey: F.repoKey,
});
db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: F.mgrId, workerSessionId: F.workerId, taskId: F.taskId, kind: "merge_request", detail: { branch: F.branch } });

const hasTerminal = (workerId) => db.listEventsForWorker(workerId).some((e) => e.kind === "merge_done" || e.kind === "merge_rejected");

try {
  check("(pre) scenario A worktree absent from disk", !fs.existsSync(A.worktreePath));
  check("(pre) scenario C worktree absent from disk", !fs.existsSync(C.worktreePath));
  check("(pre) scenario C task starts done", db.getTask(C.taskId).columnKey === "done");
  check("(pre) scenario C has a dangling merge_request (no terminal event)", !hasTerminal(C.workerId));
  check("(pre) scenario D worktree absent from disk", !fs.existsSync(D.worktreePath));
  check("(pre) scenario D task starts done", db.getTask(D.taskId).columnKey === "done");
  check("(pre) scenario D has NO merge_request on record", !db.listEventsForWorker(D.workerId).some((e) => e.kind === "merge_request"));
  check("(pre) scenario E worktree absent from disk", !fs.existsSync(E.worktreePath));
  check("(pre) scenario E's task row is genuinely absent (simulated delete)", db.getTask(E.taskId) === undefined);
  check("(pre) scenario E has NO merge_request on record", !db.listEventsForWorker(E.workerId).some((e) => e.kind === "merge_request"));
  check("(pre) scenario F worktree absent from disk", !fs.existsSync(F.worktreePath));
  check("(pre) scenario F's task row is genuinely absent (simulated delete)", db.getTask(F.taskId) === undefined);
  check("(pre) scenario F HAS a dangling merge_request (no terminal event)",
    db.listEventsForWorker(F.workerId).some((e) => e.kind === "merge_request") && !hasTerminal(F.workerId));

  // ═══════════════ BOOT 1 ═══════════════
  const r1 = await sessions.reconcileOrchestrationOnBoot();

  // (a) tracked as a WEDGE, not a generic failure — mergesFailed still counts it (nothing is silently
  // dropped from the aggregate), but mergeReconcileWedged distinguishes it, and mergeFailureDetails names it.
  check("(1a) reconcile counted the wedge in mergesFailed", r1.mergesFailed >= 1);
  check("(1a) reconcile counted exactly the wedge(s) expected this boot in mergeReconcileWedged", r1.mergeReconcileWedged === 4); // A, C, E, and F all wedge on boot 1
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
  // Exactly ONE stale-merge resolution this boot (scenario C) — if scenario F below also got fabricated
  // a merge_done, this count would be 2, silently masking the bug behind an otherwise-correct-looking number.
  check("(1c) staleMergesResolved counts ONLY scenario C, not a fabricated resolution for F too", r1.staleMergesResolved === 1);

  // (d) THE FIX UNDER TEST: scenario D never requested a merge at all, so it must NEVER be tracked as a
  // wedge — not even a single "attempt" — despite its repoKey being just as unresolvable as A's/C's.
  const detailD1 = r1.mergeFailureDetails.find((d) => d.sessionId === D.workerId);
  check("(1d) scenario D is NOT in mergeFailureDetails on boot 1 (never even attempted)", detailD1 === undefined);
  check("(1d) scenario D never accumulated a wedge entry", db.getMergeReconcileWedge(D.workerId) === undefined);
  check("(1d) mergeReconcileWedged counted A, C, E, and F, not D", r1.mergeReconcileWedged === 4);
  check("(1d) a named info log explains the skip (worker + branch, not silent)",
    infosMatching(D.workerId).some((w) => w.includes(D.branch) && w.includes("never requested a merge")));
  check("(1d) scenario D got NO merge_done event (this was never a merge, real or reconstructed)",
    !db.listEventsForWorker(D.workerId).some((e) => e.kind === "merge_done"));

  // (e) THE HARDENING UNDER TEST (post-review ask): scenario E has NO merge_request and NO worktree —
  // identical shape to D — but its task row is absent AND its project resolves no terminal column at
  // all. The bare `getTask(...)?.columnKey === columnKeyForProjectRole(...)` comparison would read
  // undefined === undefined here and wrongly treat it as terminal, silently skipping a session that (as
  // far as Pass A can actually tell) might still have real work. It must instead fall through exactly
  // like scenario A: genuinely wedged, not silently cleared.
  const detailE1 = r1.mergeFailureDetails.find((d) => d.sessionId === E.workerId);
  check("(1e) scenario E IS wedged on boot 1 (the undefined===undefined trap must NOT read as terminal)", detailE1?.wedged === true);
  check("(1e) scenario E's wedge entry was recorded (not silently skipped)", db.getMergeReconcileWedge(E.workerId)?.attempts === 1);
  check("(1e) NO 'never requested a merge' skip log fired for scenario E (it did NOT take the no-op path)",
    infosMatching(E.workerId).length === 0);
  check("(1e) scenario E got NO merge_done event", !db.listEventsForWorker(E.workerId).some((e) => e.kind === "merge_done"));

  // (f) card 1d10aea9 — THE FIX UNDER TEST: scenario F has a REAL dangling merge_request and no terminal
  // event, exactly Pass A2's own resolution criteria — but its task row is absent AND its project resolves
  // no terminal column at all, so `getTask(...)?.columnKey !== terminalKey` compares undefined !== undefined
  // pre-fix. That reads `false` (they "match"), so the bare `!==` guard does NOT `continue` and Pass A2
  // fabricates a merge_done for a session nothing actually confirms landed. Post-fix it must fall through
  // and stay genuinely wedged — like E, never silently "resolved".
  const detailF1 = r1.mergeFailureDetails.find((d) => d.sessionId === F.workerId);
  check("(1f) scenario F IS wedged on boot 1 (Pass A's own repoKey wedge, unaffected by Pass A2)", detailF1?.wedged === true);
  check("(1f) scenario F got NO fabricated merge_done from Pass A2 (the undefined===undefined trap)", !hasTerminal(F.workerId));
  check("(1f) scenario F's merge_request is still the only event on record (no merge_done appended)",
    db.listEventsForWorker(F.workerId).filter((e) => e.kind === "merge_done").length === 0);

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

  // (d) stays clean on a second boot too — no wedge entry ever accumulates, idempotent.
  const detailD2 = r2.mergeFailureDetails.find((d) => d.sessionId === D.workerId);
  check("(2d) scenario D still not wedged on boot 2", detailD2 === undefined);
  check("(2d) scenario D still has no wedge entry", db.getMergeReconcileWedge(D.workerId) === undefined);

  // (e) still genuinely wedged on boot 2 too — attempts bump like A, never silently cleared.
  const detailE2 = r2.mergeFailureDetails.find((d) => d.sessionId === E.workerId);
  check("(2e) scenario E still wedged on boot 2", detailE2?.wedged === true);
  check("(2e) scenario E's attempts bumped to 2 (not reset, not cleared)", db.getMergeReconcileWedge(E.workerId)?.attempts === 2);

  // (f) scenario F still genuinely wedged on boot 2 too — never silently cleared by a fabricated resolution.
  const detailF2 = r2.mergeFailureDetails.find((d) => d.sessionId === F.workerId);
  check("(2f) scenario F still wedged on boot 2", detailF2?.wedged === true);
  check("(2f) scenario F's attempts bumped to 2 (not reset, not cleared)", db.getMergeReconcileWedge(F.workerId)?.attempts === 2);
  check("(2f) scenario F STILL has no merge_done event", !hasTerminal(F.workerId));

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
  console.info = realInfo;
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a Pass-A session with an unresolvable repoKey is tracked as a distinct, named, escalating wedge (never a bare 'retry next boot' count); a genuine branch-gone record still resolves via Pass A2 unaffected; a session that is BOTH (Pass A2-resolvable AND repoKey-wedged) is no longer re-thrown on every subsequent boot once Pass A2 clears it; (card 6f73da1a) a session that never requested a merge at all, with its task already terminal, is never tracked as a wedge in the first place — a deliberate, named, idempotent skip instead of an unresolvable-repoKey throw retried forever; Pass A's own terminal-task check stays fail-closed even when a deleted task's absent columnKey and an empty-board project's absent terminal key would otherwise both read undefined and accidentally compare equal; and (card 1d10aea9) Pass A2's OWN terminal check, ten lines below, stays fail-closed on that same double-undefined combination too — a REAL dangling merge_request on a deleted-task/empty-board session is never fabricated into a false merge_done."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
