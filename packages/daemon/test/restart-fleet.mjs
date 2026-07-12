import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Multi-session fleet restart/resume test (P1 17df54c5). NO claude, NO live daemon, NO process.exit —
// drives SessionService + the restart module directly against an isolated LOOM_HOME. Proves the fix
// for "daemon_restart resumes ONLY the requesting manager": the WHOLE live cross-project fleet is
// captured, protected, and resumed.
//
//   (1) CAPTURE — liveFleetResumeSet() enumerates EVERY live session across ALL projects (managers,
//       workers, plain, even a rate-limited/parked one), with role + manager linkage preserved, and
//       EXCLUDES exited + archived sessions.
//   (2) RESUME-ON-BOOT — resumeFleetOnBoot() re-resumes every captured session (injecting nothing into
//       the resume itself); the REQUESTER gets its "code is live" re-prompt, other managers a neutral
//       continuation note, workers their task nudge, a plain session NOTHING; a PARKED session is
//       resumed live but its nudge/pending replay are WITHHELD (usage hold honored); pending FIFOs are
//       replayed in order BEFORE the nudge; an unresumable session lands in `failed` with no nudge.
//   (3) PROTECTION — with protectedSessionIds == the full resumed set, the boot reconcile touches NONE
//       of the fleet's worktrees (every project's workers survive); WITHOUT it the same worktrees are
//       reclaimed (so the protection — not luck — is what saves the whole fleet).
//   (4) BACK-COMPAT — an OLD-format intent (flat workerSessionIds, no `resume`) is tolerated: it
//       degrades to the requester + its workers without crashing; the NEW `resume` array round-trips.
// Run: 1) build daemon, 2) node test/restart-fleet.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rf-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const restart = await import("../dist/orchestration/restart.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=rf@loom -c user.name=rf";
const now = new Date().toISOString();
const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h: a live park
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// A minimal PTY stub: a resumed pty is not-ready, so every enqueueStdin QUEUES (host.ts's ready-gated
// path) and getPending returns a copy — exactly what the boot resume + replay rely on. Claude-free.
class PtyStub {
  constructor() { this.q = new Map(); }
  isAlive() { return false; } // resumed rows are not-live; let resume()'s already-live short-circuit fall through to spawn/guards
  enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
  getPending(id) { return [...(this.q.get(id) ?? [])]; }
  isComposerDirty() { return false; } // claude-free stub: no live composer to be dirty — liveFleetResumeSet() calls this per session
}

const db = new Db();
const pty = new PtyStub();
const sessions = new SessionService(db, pty, new OrchestrationControl());

// Seed helpers — distinct ids so sections don't interfere.
const mkProject = (id, repo) => db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
const mkAgent = (id, projId) => db.insertAgent({ id, projectId: projId, name: "t", startupPrompt: "", position: 0 });
const mkTask = (id, projId) => db.insertTask({ id, projectId: projId, title: id, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
// A HELD card (Board Hold Model): non-terminal column, but the owner's brake is set — hasPendingBoardWork
// must treat this the same as no card at all (excluded, not "pending").
const mkHeldTask = (id, projId) => db.insertTask({ id, projectId: projId, title: id, body: "", columnKey: "in_progress", position: 1, held: true, createdAt: now, updatedAt: now });
function mkSession(o) {
  db.insertSession({
    id: o.id, projectId: o.projId, agentId: o.agentId, engineSessionId: o.engineSessionId ?? `eng-${o.id}`,
    // cwd defaults to a REAL dir (os.tmpdir) — liveFleetResumeSet() now filters out sessions whose cwd
    // is gone (the ghost-resume guard), so a non-existent default would wrongly drop every seeded row.
    title: null, cwd: o.cwd ?? os.tmpdir(), processState: o.processState ?? "live", resumability: "unknown",
    busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: o.role ?? null, parentSessionId: o.parentSessionId ?? null,
    taskId: o.taskId ?? null, worktreePath: o.worktreePath ?? null, branch: o.branch ?? null,
  });
  if (o.archived) db.archiveSession(o.id);
  if (o.parkedUntil) db.setRateLimitedUntil(o.id, o.parkedUntil, "usage limit — parked");
  if (o.busy) db.setBusy(o.id, true); // busy-at-capture (card b5664b5b Problem B)
}

const repoRoots = [];
const transcriptDirs = []; // real ~/.claude/projects/<encoded> dirs created for the ghost-resume test
try {
  // ============================ (1) CAPTURE — liveFleetResumeSet ============================
  // Project A: managerA + 2 workers (one PARKED) + a plain session. Project B: managerB + 1 worker.
  // Noise that must be EXCLUDED: an exited worker, and an archived (but otherwise live) worker.
  const A = { proj: `rf-A-${sfx}`, agent: `rf-A-ag-${sfx}` };
  const B = { proj: `rf-B-${sfx}`, agent: `rf-B-ag-${sfx}` };
  mkProject(A.proj, "/tmp/rf-A"); mkAgent(A.agent, A.proj);
  mkProject(B.proj, "/tmp/rf-B"); mkAgent(B.agent, B.proj);
  const id = {
    mgrA: `rf-mgrA-${sfx}`, wkrA1: `rf-wkrA1-${sfx}`, wkrA2: `rf-wkrA2-${sfx}`, plainA: `rf-plainA-${sfx}`,
    mgrB: `rf-mgrB-${sfx}`, wkrB1: `rf-wkrB1-${sfx}`,
    exitedW: `rf-exited-${sfx}`, archivedW: `rf-archived-${sfx}`,
  };
  mkSession({ id: id.mgrA, projId: A.proj, agentId: A.agent, role: "manager" });
  mkSession({ id: id.wkrA1, projId: A.proj, agentId: A.agent, role: "worker", parentSessionId: id.mgrA, busy: true });
  mkSession({ id: id.wkrA2, projId: A.proj, agentId: A.agent, role: "worker", parentSessionId: id.mgrA, parkedUntil: future });
  mkSession({ id: id.plainA, projId: A.proj, agentId: A.agent, role: null }); // plain phase-1 session
  mkSession({ id: id.mgrB, projId: B.proj, agentId: B.agent, role: "manager" });
  mkSession({ id: id.wkrB1, projId: B.proj, agentId: B.agent, role: "worker", parentSessionId: id.mgrB });
  mkSession({ id: id.exitedW, projId: A.proj, agentId: A.agent, role: "worker", parentSessionId: id.mgrA, processState: "exited" });
  mkSession({ id: id.archivedW, projId: B.proj, agentId: B.agent, role: "worker", parentSessionId: id.mgrB, archived: true });

  const fleet = sessions.liveFleetResumeSet();
  const byId = new Map(fleet.map((e) => [e.sessionId, e]));
  check("(1) capture returns exactly the 6 LIVE sessions across both projects", fleet.length === 6);
  check("(1) captures managerA (role manager, no parent)", byId.get(id.mgrA)?.role === "manager" && byId.get(id.mgrA)?.parentSessionId === null);
  check("(1) captures workerA1 with manager linkage", byId.get(id.wkrA1)?.role === "worker" && byId.get(id.wkrA1)?.parentSessionId === id.mgrA);
  check("(1) captures the busy-at-capture flag (workerA1 busy, managerA idle) — card b5664b5b Problem B",
    byId.get(id.wkrA1)?.busy === true && byId.get(id.mgrA)?.busy === false);
  check("(1) captures the PARKED workerA2 too (still live)", byId.has(id.wkrA2) && byId.get(id.wkrA2)?.parentSessionId === id.mgrA);
  check("(1) captures the plain (role-null) session", byId.has(id.plainA) && byId.get(id.plainA)?.role === null);
  check("(1) captures the OTHER project's managerB + workerB1", byId.get(id.mgrB)?.role === "manager" && byId.get(id.wkrB1)?.parentSessionId === id.mgrB);
  check("(1) EXCLUDES the exited worker", !byId.has(id.exitedW));
  check("(1) EXCLUDES the archived worker", !byId.has(id.archivedW));

  // ============================ (2) RESUME-ON-BOOT — resumeFleetOnBoot ============================
  // Build an intent from the capture, add a DEAD worker (resumeOne returns false) + a pending FIFO on
  // workerA1, and resume with managerA as the requester.
  const deadW = `rf-dead-${sfx}`;
  mkSession({ id: deadW, projId: B.proj, agentId: B.agent, role: "worker", parentSessionId: id.mgrB });
  const resumeSet = [
    ...fleet,
    { sessionId: deadW, role: "worker", parentSessionId: id.mgrB },
  ];
  const pendingSnap = { [id.wkrA1]: ["wkrA1 pending #1 (worker_report frame)", "wkrA1 pending #2"] };
  const intent = { reason: "deploy merged daemon code", managerSessionId: id.mgrA, resume: resumeSet, pending: pendingSnap, requestedAt: now };

  const resumeCalls = [];
  const resumeOne = (sid) => { resumeCalls.push(sid); return sid !== deadW; }; // dead worker is unresumable
  const result = sessions.resumeFleetOnBoot(intent, { resumeOne });

  check("(2) every non-dead session resumed (6)", result.resumed.length === 6 && !result.resumed.includes(deadW));
  check("(2) the dead worker is in `failed`", result.failed.includes(deadW) && result.failed.length === 1);
  check("(2) the parked worker is reported skippedParked", result.skippedParked.includes(id.wkrA2) && result.skippedParked.length === 1);
  check("(2) resume injects NOTHING — resumeOne is called with a bare id only (no prompt arg)", resumeCalls.every((c) => typeof c === "string") && resumeCalls.length === 7);

  // Requester managerA: ONE message — its "code is now LIVE" re-prompt.
  const mgrAq = pty.getPending(id.mgrA);
  check("(2) requester gets exactly its 'code is live' re-prompt", mgrAq.length === 1 && mgrAq[0].includes("now LIVE") && mgrAq[0].includes("[loom:daemon-restarted]"));
  // workerA1: pending replayed IN ORDER, THEN the worker continuation nudge.
  const wA1q = pty.getPending(id.wkrA1);
  check("(2) workerA1 pending FIFO replayed in order before the nudge",
    wA1q.length === 3 && wA1q[0] === pendingSnap[id.wkrA1][0] && wA1q[1] === pendingSnap[id.wkrA1][1] && wA1q[2].includes("Continue your assigned task"));
  // Parked workerA2: resumed live, but NO nudge + NO replay (usage hold honored).
  check("(2) PARKED workerA2 received NO enqueued message (park honored)", pty.getPending(id.wkrA2).length === 0);
  // Plain session: resumed, no orchestration loop → no nudge.
  check("(2) plain session received NO nudge", pty.getPending(id.plainA).length === 0);
  // Other manager B: the neutral continuation note (NOT the requester's framing).
  const mgrBq = pty.getPending(id.mgrB);
  check("(2) other manager B gets the neutral 'you were resumed' note", mgrBq.length === 1 && mgrBq[0].includes("Another manager restarted") && !mgrBq[0].includes("now LIVE"));
  check("(2) other project's worker B1 gets the worker task nudge", pty.getPending(id.wkrB1).length === 1 && pty.getPending(id.wkrB1)[0].includes("Continue your assigned task"));
  check("(2) the dead (failed) worker received NO nudge", pty.getPending(deadW).length === 0);

  // ============================ (3) PROTECTION — full set keeps every project's worktree ===========
  // Two real repos, each with a CLEAN (0-commit, safe-to-discard) worktree of an EXITED worker — i.e.
  // exactly what boot-reconcile would reclaim. With the full fleet protected, NEITHER is touched; run
  // unprotected and BOTH are reclaimed — so the protection (not the P0 work-guard) is what saved them.
  const P = [{ key: "PA" }, { key: "PB" }];
  for (const p of P) {
    p.proj = `rf-${p.key}-proj-${sfx}`; p.agent = `rf-${p.key}-ag-${sfx}`; p.task = `rf-${p.key}-task-${sfx}`;
    p.mgr = `rf-${p.key}-mgr-${sfx}`; p.worker = `rf-${p.key}-wkr-${sfx}`;
    p.repo = path.join(os.tmpdir(), `loom-rf-${p.key}-${sfx}`);
    repoRoots.push(p.repo);
    fs.mkdirSync(p.repo, { recursive: true });
    fs.writeFileSync(path.join(p.repo, "README.md"), `# ${p.key}\n`);
    execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
    const wt = await createWorktree(p.repo, p.proj, p.task); // fresh branch at main — clean, 0-ahead
    p.worktreePath = wt.worktreePath; p.branch = wt.branch;
    mkProject(p.proj, p.repo); mkAgent(p.agent, p.proj); mkTask(p.task, p.proj);
    mkSession({ id: p.mgr, projId: p.proj, agentId: p.agent, role: "manager", cwd: p.repo });
    // Exited at boot (recoverStaleSessions equivalent) — Pass B's GC target absent protection.
    mkSession({ id: p.worker, projId: p.proj, agentId: p.agent, role: "worker", parentSessionId: p.mgr, taskId: p.task, worktreePath: p.worktreePath, branch: p.branch, cwd: p.worktreePath, processState: "exited" });
  }
  // Full-fleet protection set, derived the way boot does, from an intent naming both projects' workers.
  const protIntent = {
    reason: "deploy", managerSessionId: P[0].mgr, requestedAt: now,
    resume: P.flatMap((p) => [
      { sessionId: p.mgr, role: "manager", parentSessionId: null },
      { sessionId: p.worker, role: "worker", parentSessionId: p.mgr },
    ]),
  };
  const protectedIds = restart.protectedIdsFromIntent(protIntent);
  check("(3-pre) both project worktrees present before reconcile", P.every((p) => fs.existsSync(p.worktreePath)));
  check("(3) protected set spans BOTH projects' workers", P.every((p) => protectedIds.has(p.worker)));

  const rProt = await sessions.reconcileOrchestrationOnBoot(protectedIds);
  check("(3) protected reconcile touched no fleet worktree (0 finished, 0 pruned)", rProt.mergesFinished === 0 && rProt.worktreesPruned === 0);
  check("(3) BOTH projects' worktrees SURVIVE under full-fleet protection", P.every((p) => fs.existsSync(p.worktreePath)));

  const rUnprot = await sessions.reconcileOrchestrationOnBoot(); // no protection
  check("(3) WITHOUT protection the same worktrees are reclaimed (proves protection saved them)", P.every((p) => !fs.existsSync(p.worktreePath)));

  // ============================ (4) BACK-COMPAT — old-format intent tolerated ======================
  const oldIntent = { reason: "pre-deploy daemon", managerSessionId: id.mgrB, workerSessionIds: [id.wkrB1], requestedAt: now };
  const degraded = restart.resumeSetFromIntent(oldIntent);
  check("(4) old-format resumeSetFromIntent degrades to requester (manager) + its workers",
    degraded.length === 2 && degraded[0].sessionId === id.mgrB && degraded[0].role === "manager" && degraded[1].sessionId === id.wkrB1 && degraded[1].role === "worker" && degraded[1].parentSessionId === id.mgrB);
  const oldProt = restart.protectedIdsFromIntent(oldIntent);
  check("(4) old-format protectedIdsFromIntent covers the requester + its workers", oldProt.has(id.mgrB) && oldProt.has(id.wkrB1));
  // Boot resume over an old-format intent must not crash and must route the requester/worker nudges.
  const pty2 = new PtyStub();
  const sessions2 = new SessionService(db, pty2, new OrchestrationControl());
  const oldResult = sessions2.resumeFleetOnBoot(oldIntent, { resumeOne: () => true });
  check("(4) old-format boot resume brings back the requester + its workers without crashing", oldResult.resumed.length === 2 && oldResult.failed.length === 0);
  check("(4) old-format requester gets the 'code is live' re-prompt", pty2.getPending(id.mgrB).some((m) => m.includes("now LIVE")));
  check("(4) old-format worker gets the task nudge", pty2.getPending(id.wkrB1).some((m) => m.includes("Continue your assigned task")));

  // The NEW `resume` array round-trips through the on-disk intent file (write → read).
  restart.writeRestartIntent(intent);
  const readBack = restart.readRestartIntent();
  check("(4) NEW resume array round-trips on disk (full fleet persisted)",
    readBack && Array.isArray(readBack.resume) && readBack.resume.length === resumeSet.length && readBack.resume[0].sessionId === resumeSet[0].sessionId);
  restart.clearRestartIntent();

  // ============================ (5) GHOST-RESUME GUARD (worktree/cwd removed) ======================
  // A worker whose task merged + worktree was GC'd can still be flagged `live` with a VALID engine
  // transcript — the transcript lives under ~/.claude keyed by cwd, so it SURVIVES the worktree's
  // removal and the pre-existing transcript guard passes. Without a cwd guard, boot fleet-resume then
  // spawns a doomed `claude --resume` into the now-missing cwd that dies code=1 (the ghost resume).
  const ghostMissingCwd = path.join(os.tmpdir(), `loom-rf-gone-${sfx}`); // deliberately NEVER created
  check("(5-pre) the ghost cwd really is absent on disk", !fs.existsSync(ghostMissingCwd));

  // (5a) Belt-and-suspenders: liveFleetResumeSet() SKIPS a live session whose cwd is already gone, so a
  // dead-worktree row never even enters the restart intent — while an intact-cwd session is still kept.
  const ghostCapId = `rf-ghostcap-${sfx}`;
  mkSession({ id: ghostCapId, projId: A.proj, agentId: A.agent, role: "worker", parentSessionId: id.mgrA, cwd: ghostMissingCwd });
  const fleet2Ids = new Set(sessions.liveFleetResumeSet().map((e) => e.sessionId));
  check("(5a) liveFleetResumeSet EXCLUDES a live session whose cwd is gone", !fleet2Ids.has(ghostCapId));
  check("(5a) an intact-cwd live session is STILL captured (guard is surgical)", fleet2Ids.has(id.mgrA));

  // (5b) resume() ITSELF refuses a missing cwd EVEN with a live engine transcript — proving the NEW cwd
  // guard (not the pre-existing transcript guard) is what stops the doomed spawn. Materialize a real
  // transcript at the computed path so engineTranscriptExists passes, then resume into the missing cwd
  // and assert: throws (worktree/cwd missing), marks resumability:"dead", and spawns NO pty.
  const ghostResId = `rf-ghostres-${sfx}`;
  const ghostEng = `eng-${ghostResId}`;
  const tFile = engineTranscriptPath(ghostMissingCwd, ghostEng);
  fs.mkdirSync(path.dirname(tFile), { recursive: true });
  transcriptDirs.push(path.dirname(tFile));
  fs.writeFileSync(tFile, JSON.stringify({ type: "user", message: { content: "seed" } }) + "\n");
  mkSession({ id: ghostResId, projId: A.proj, agentId: A.agent, engineSessionId: ghostEng, role: "worker", parentSessionId: id.mgrA, cwd: ghostMissingCwd });
  // A spawn-recording pty so we can prove resume() never reached pty.spawn for the missing cwd.
  class SpawnRecPty {
    constructor() { this.spawns = []; this.q = new Map(); }
    isAlive() { return false; } // the ghost row is not-live; let resume()'s already-live short-circuit fall through to the cwd-missing guard
    spawn(o) { this.spawns.push(o); }
    enqueueStdin(i, t) { const a = this.q.get(i) ?? []; a.push(t); this.q.set(i, a); return { delivered: false, position: a.length }; }
    getPending(i) { return [...(this.q.get(i) ?? [])]; }
  }
  const recPty = new SpawnRecPty();
  const sessions5 = new SessionService(db, recPty, new OrchestrationControl());
  let threw = null;
  try { sessions5.resume(ghostResId); } catch (e) { threw = e; }
  check("(5b) resume() THROWS when cwd is missing (even with a live transcript)", !!threw && /worktree\/cwd missing/.test(String(threw?.message)));
  check("(5b) resume() marks the session resumability:dead", db.getSession(ghostResId)?.resumability === "dead");
  check("(5b) resume() spawned NO pty (no doomed --resume)", recPty.spawns.length === 0);

  // ============================ (6) NUDGE COVERAGE — reviewer roles, run-exclusion, converged mgr ====
  // P1 + folded #7 + card 90058589 + card b5664b5b. Standing reviewers (auditor/workspace-auditor/setup)
  // resume with NO startup prompt; a reviewer that was MID-RUN (busy) at capture would otherwise sit idle
  // until a human types "continue", so it gets a [loom:daemon-restarted] nudge — but an already-IDLE reviewer
  // resumes SILENTLY (card b5664b5b Problem B: its next due wake/schedule re-engages it, so a nudge only
  // burned a turn). A `run` (runs don't resume — see shared/types.ts SessionRole) gets NONE. And a non-causal
  // bystander manager/platform with 0 live workers AND an EMPTY board now resumes SILENTLY too (card b5664b5b
  // A+C1 — the old "lightweight FYI" was itself a wasted turn); one with a PENDING board card the idle-watcher
  // will NEVER independently re-surface — i.e. suppressed via the idle-watcher's unanswered-cap ESCALATION,
  // with no natural re-arm (61cc91c6) — still gets the full "re-check your workers" re-orient; and the
  // deploy REQUESTER is NEVER short-circuited. (A merely 'snoozed'/deliberately-'suppressed'-via-idle_report
  // manager's pending board is covered independently by the idle-watcher's own cadence — see
  // restart-wake-classification.mjs for that full per-cause matrix; this file keeps ONE escalation-cause
  // regression guard for the original card 90058589 scenario.)
  // C.proj is an EMPTY board (no tasks) — its 0-worker managers are GENUINELY converged.
  // C2.proj has ≥1 PENDING card (mkTask lands at "in_progress" = the `active` lane, non-terminal and NOT
  // held) — its 0-worker managers are NOT converged despite a stale ESCALATED-suppressed idle-policy (card
  // 90058589: a manager that deploys mid-queue sits at 0 live workers but still has pending work).
  // C3.proj's ONLY card is HELD (Board Hold Model) — the owner's brake, checked in ANY column now, not a
  // `blocked` column. hasPendingBoardWork must exclude it exactly like C's empty board, NOT count it like
  // C2's genuine pending card.
  const C = { proj: `rf-C-${sfx}`, agent: `rf-C-ag-${sfx}` };
  const C2 = { proj: `rf-C2-${sfx}`, agent: `rf-C2-ag-${sfx}` };
  const C3 = { proj: `rf-C3-${sfx}`, agent: `rf-C3-ag-${sfx}` };
  mkProject(C.proj, "/tmp/rf-C"); mkAgent(C.agent, C.proj);
  mkProject(C2.proj, "/tmp/rf-C2"); mkAgent(C2.agent, C2.proj);
  mkProject(C3.proj, "/tmp/rf-C3"); mkAgent(C3.agent, C3.proj);
  mkTask(`rf-C2-pending-${sfx}`, C2.proj); // one PENDING card on C2's board (column "in_progress")
  mkHeldTask(`rf-C3-held-${sfx}`, C3.proj); // one HELD card on C3's board — must NOT count as pending
  const cid = {
    auditor: `rf-auditor-${sfx}`, wsAuditor: `rf-wsaud-${sfx}`, setup: `rf-setup-${sfx}`, run: `rf-run-${sfx}`,
    reqMgr: `rf-reqMgr-${sfx}`, convMgr: `rf-convMgr-${sfx}`, pendMgr: `rf-pendMgr-${sfx}`,
    activeMgr: `rf-activeMgr-${sfx}`, activeWkr: `rf-activeWkr-${sfx}`, heldMgr: `rf-heldMgr-${sfx}`,
  };
  mkSession({ id: cid.auditor, projId: C.proj, agentId: C.agent, role: "auditor" });
  mkSession({ id: cid.wsAuditor, projId: C.proj, agentId: C.agent, role: "workspace-auditor" });
  mkSession({ id: cid.setup, projId: C.proj, agentId: C.agent, role: "setup" });
  mkSession({ id: cid.run, projId: C.proj, agentId: C.agent, role: "run" });
  // reqMgr: the REQUESTER on C2 (suppressed idle-policy + 0 workers + a PENDING board card). It must
  // ALWAYS get the full "code is live — continue/verify" nudge — the requester is never FYI-short-circuited.
  mkSession({ id: cid.reqMgr, projId: C2.proj, agentId: C2.agent, role: "manager" });
  db.setIdleNudgePolicy(cid.reqMgr, "suppressed");
  // convMgr: a NON-requesting TRULY-converged manager (empty C board + 0 workers + last reported WAITING →
  // policy "snoozed"). Still gets the lightweight FYI (the genuine bystander-converged case is preserved).
  mkSession({ id: cid.convMgr, projId: C.proj, agentId: C.agent, role: "manager" });
  db.setIdleNudgePolicy(cid.convMgr, "snoozed", future);
  // pendMgr: a NON-requesting manager on C2 (0 workers + a PENDING board card), suppressed via the
  // idle-watcher's unanswered-cap ESCALATION (mirrors idle-watcher.ts's escalation branch exactly —
  // appendEvent('idle_escalated') THEN setIdleNudgePolicy, no resetIdleNudgeState first) — the one
  // 'suppressed' cause with NO natural re-arm (61cc91c6), so the pending board makes it NON-converged
  // → full nudge, same as the original card 90058589 scenario.
  mkSession({ id: cid.pendMgr, projId: C2.proj, agentId: C2.agent, role: "manager" });
  db.appendEvent({ id: `rf-pend-esc-evt-${sfx}`, ts: now, managerSessionId: cid.pendMgr, kind: "idle_escalated", detail: { reason: "unanswered_cap", unanswered: 2 } });
  db.setIdleNudgePolicy(cid.pendMgr, "suppressed");
  // activeMgr: a NON-requesting manager WITH a live worker → full re-check nudge (the control).
  mkSession({ id: cid.activeMgr, projId: C.proj, agentId: C.agent, role: "manager" });
  mkSession({ id: cid.activeWkr, projId: C.proj, agentId: C.agent, role: "worker", parentSessionId: cid.activeMgr });
  // heldMgr: a NON-requesting manager on C3 (suppressed idle-policy + 0 workers + a HELD-only board). The
  // held card must NOT be counted as pending — it resumes SILENTLY just like the genuinely-empty C board.
  mkSession({ id: cid.heldMgr, projId: C3.proj, agentId: C3.agent, role: "manager" });
  db.setIdleNudgePolicy(cid.heldMgr, "suppressed");

  const pty6 = new PtyStub();
  const sessions6 = new SessionService(db, pty6, new OrchestrationControl());
  const intent6 = {
    reason: "deploy", managerSessionId: cid.reqMgr, requestedAt: now,
    resume: [
      { sessionId: cid.auditor, role: "auditor", parentSessionId: null, busy: true }, // mid-run ⇒ nudged
      { sessionId: cid.wsAuditor, role: "workspace-auditor", parentSessionId: null }, // idle ⇒ silent
      { sessionId: cid.setup, role: "setup", parentSessionId: null }, // idle ⇒ silent
      { sessionId: cid.run, role: "run", parentSessionId: null },
      { sessionId: cid.reqMgr, role: "manager", parentSessionId: null },
      { sessionId: cid.convMgr, role: "manager", parentSessionId: null },
      { sessionId: cid.pendMgr, role: "manager", parentSessionId: null },
      { sessionId: cid.activeMgr, role: "manager", parentSessionId: null },
      { sessionId: cid.activeWkr, role: "worker", parentSessionId: cid.activeMgr },
      { sessionId: cid.heldMgr, role: "manager", parentSessionId: null },
    ],
  };
  sessions6.resumeFleetOnBoot(intent6, { resumeOne: () => true });
  const n6 = (i) => pty6.getPending(i);

  check("(6a) a BUSY-at-capture auditor gets a [loom:daemon-restarted] continue nudge",
    n6(cid.auditor).length === 1 && n6(cid.auditor)[0].includes("[loom:daemon-restarted]") && /continue your work/i.test(n6(cid.auditor)[0]));
  check("(6a) an IDLE-at-capture workspace-auditor resumes SILENTLY (card b5664b5b Problem B)",
    n6(cid.wsAuditor).length === 0);
  check("(6a) an IDLE-at-capture setup reviewer resumes SILENTLY (card b5664b5b Problem B)",
    n6(cid.setup).length === 0);
  check("(6b) a `run` session gets NO nudge (runs don't resume)", n6(cid.run).length === 0);
  // (6c) convergence is gated on the BOARD, not the stale idle-policy alone (card 90058589).
  // The REQUESTER is never FYI-short-circuited — it always gets the full "code is live, verify + continue".
  const reqMsg = n6(cid.reqMgr);
  check("(6c) the deploy REQUESTER (pending board) gets the FULL code-live nudge, NOT the FYI",
    reqMsg.length === 1 && reqMsg[0].includes("now LIVE") && /verify the live behavior/i.test(reqMsg[0]) && !/no action is needed/i.test(reqMsg[0]));
  // A NON-requesting manager ESCALATED-suppressed (no natural re-arm) + 0 workers but a PENDING board card
  // is NOT converged — the regression fix: it gets the full re-check nudge, not the wrong "no action" FYI.
  const pendMsg = n6(cid.pendMgr);
  check("(6c) a non-requesting manager with a PENDING board (escalated-suppressed policy) gets the FULL re-check nudge",
    pendMsg.length === 1 && /re-check your workers/i.test(pendMsg[0]) && !/no action is needed/i.test(pendMsg[0]));
  // card b5664b5b A+C1: a NON-requesting manager that is TRULY converged (empty board + 0 workers) now
  // resumes SILENTLY — the old "lightweight FYI" was itself a wasted turn it claimed to save.
  const convMsg = n6(cid.convMgr);
  check("(6c) a truly-converged NON-requesting manager (empty board) resumes SILENTLY (no FYI turn)",
    convMsg.length === 0);
  // Control: an active manager (still has a live worker) gets the FULL re-check nudge — gate is precise.
  const activeMsg = n6(cid.activeMgr);
  check("(6c) an active manager (live worker) still gets the FULL re-check nudge",
    activeMsg.length === 1 && /re-check your workers/i.test(activeMsg[0]) && !/no action is needed/i.test(activeMsg[0]));
  // Board Hold Model: a HELD-only board must NOT count as pending work — a stale suppressed idle-policy
  // + 0 workers + a held card resumes SILENTLY, same as C's genuinely-empty board (not C2's real pending card).
  const heldMsg = n6(cid.heldMgr);
  check("(6c) a non-requesting manager whose ONLY board card is HELD resumes SILENTLY (held is never pending)",
    heldMsg.length === 0);
} finally {
  db.close();
  for (const repo of repoRoots) {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  for (const dir of transcriptDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a daemon_restart captures the WHOLE live cross-project fleet, resumes every session (requester re-prompted, affected managers re-checked, busy-at-capture standing reviewers nudged while idle ones + converged 0-worker managers resume SILENTLY, `run` excluded, plain/parked honored, dead skipped), protects every project's worktree, tolerates an old-format intent, and refuses a ghost resume whose worktree/cwd was removed (no doomed --resume spawn)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
