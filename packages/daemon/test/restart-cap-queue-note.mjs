import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a1b79655 — a cap-queued worker_spawn intent is silently discarded by a daemon restart.
//
// THE FINDING (checkpoint, code-cited): CapQueueRegistry is deliberately IN-MEMORY ONLY (see its own
// class doc) and is never re-populated on boot — any daemon restart (crash, dev-watch, or a deliberate
// `daemon_restart`) wipes it unconditionally, with no error and no trace. That loss is BY DESIGN (the
// manager approved: no persistence). The defect this test proves fixed is the CONTRACT + VISIBILITY gap
// around it: the tool descriptions used to imply survival was unconditional ("no daemon restart needed"),
// and a manager whose queued intent WAS dropped by a `daemon_restart` got no notice at all.
//
// THE FIX (two additive halves):
//   (A) requestDaemonRestart now snapshots each captured manager's/platform's still-live cap-queued
//       intents (PUBLIC projection only) into RestartIntent.capQueued right before exit — the one restart
//       flavor with a window to act before the process (and the in-memory registry) dies.
//   (B) resumeFleetOnBoot reads that snapshot back and appends/sends an explicit note naming each dropped
//       entry (opId/task/kickoffLabel) to the affected manager/platform — EVEN for a bystander that would
//       otherwise resume completely silently — mirroring the EXISTING draftNote (composer-dirty
//       disclosure) mechanism this same function already uses for the analogous unsent-draft loss.
//   This is INFORMATIONAL ONLY: nothing here re-queues or re-admits a dropped intent (that would be the
//   persistence the card's DoD explicitly forbids) — it only tells the manager what's gone.
//
// Proves:
//   (A1) a cap-rejected spawn's PUBLIC-projection entry is captured into the written restart-intent under
//        the requesting manager's own sessionId.
//   (A2) a sibling manager/platform with NO cap-queued entries gets no key in the snapshot at all.
//   (A3) both-directions control: when NOBODY has a cap-queued entry, `capQueued` is absent from the
//        written intent entirely (not an empty object) — mirrors `pending`'s own absent-when-empty shape.
//   (B1) a manager that would OTHERWISE resume SILENTLY (no workers, no queued I/O, no stranded board
//        work) still gets a minimal note-only turn when it had a dropped cap-queued entry — the exact
//        pre-fix silent-loss case this card is about.
//   (B2) the control bystander manager (no dropped entries) resumes truly silently — NO enqueued turn
//        (no regression to the existing draftNote/no-op-wake behavior).
//   (B3) an "affected" manager (queued I/O replayed → gets the full re-orient nudge anyway) ALSO carries
//        the dropped-entry note appended to that nudge.
//   (B4) the deploy REQUESTER's own "code is live" nudge carries the note when IT had a dropped entry.
//
// Run: 1) build daemon, 2) node test/restart-cap-queue-note.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rcqn-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
delete process.env.LOOM_SUPERVISED;

const restart = await import("../dist/orchestration/restart.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { CapQueueRejectedError } = await import("../dist/orchestration/cap-queue.js");
// Card 062fa934, Code Review CRITICAL — every resumeFleetOnBoot call below must inject this explicitly;
// see _deploy-staleness-fixture.mjs's own doc for why (a real, unmocked deploy-signature read can flip
// the "now LIVE" wording this file's (B4) check asserts unconditionally).
const { CLEAN_STALENESS } = await import("./_deploy-staleness-fixture.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// PtyHost stand-in: covers every seam requestDaemonRestart/resumeFleetOnBoot touch (mirrors the
// PtyStub(C) shapes in restart-intent.mjs / restart-draft-loss-note.mjs).
class PtyStub {
  constructor() { this.q = new Map(); }
  enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
  getPending(id) { return [...(this.q.get(id) ?? [])]; }
  getPersistablePendingSnapshot() { return { texts: [], holds: {}, mintedAt: {} }; }
  isComposerDirty() { return false; }
  waitForMcpSeen() { return Promise.resolve(true); } // card df5e37e7
}
const flush = () => new Promise((r) => setTimeout(r, 0));

// ===================== PART A — the CAPTURE half: requestDaemonRestart snapshots capQueue =====================
{
  const db = new Db();
  const pty = new PtyStub();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const proj = `rcqn-A-proj-${sfx}`, mgrAgent = `rcqn-A-mgrag-${sfx}`, devAgent = `rcqn-A-devag-${sfx}`;
  const mgrA = `rcqn-A-mgrA-${sfx}`, mgrB = `rcqn-A-mgrB-${sfx}`, fillerWorker = `rcqn-A-filler-${sfx}`;
  const taskX = `rcqn-A-taskX-${sfx}`;
  try {
    db.insertProject({ id: proj, name: "A", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: { orchestration: { maxConcurrentWorkers: 1 } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: mgrAgent, projectId: proj, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: devAgent, projectId: proj, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertTask({ id: taskX, projectId: proj, title: "task X", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    // cwd MUST be a real, existing dir — liveFleetResumeSet() filters on fs.existsSync(cwd).
    const mkMgr = (id) => db.insertSession({ id, projectId: proj, agentId: mgrAgent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    mkMgr(mgrA);
    mkMgr(mgrB); // sibling manager with NO cap-queued entries — the (A2) control
    // Fill mgrA's cap (1) with a LIVE worker row inserted DIRECTLY — the cap-admit check
    // (db.listWorkers(managerSessionId).filter(processState==='live')) only ever reads the DB, and it
    // runs BEFORE createWorktree, so a cap-rejected spawnWorker call below never touches the filesystem —
    // no real git repo needed at all.
    db.insertSession({ id: fillerWorker, projectId: proj, agentId: devAgent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrA });

    // --- record a cap-rejected spawn for mgrA (the entry the restart must snapshot) ---
    let rejected = null;
    try {
      await sessions.spawnWorker(mgrA, { taskId: taskX, agentId: devAgent, kickoffPrompt: "GO X — this is the kickoff the restart snapshot must capture" });
    } catch (e) {
      rejected = e;
    }
    check("(A setup) the spawn was rejected purely by the concurrency cap", rejected instanceof CapQueueRejectedError);
    check("(A setup) the rejection carries the recorded capQueued marker", !!rejected?.capQueued && rejected.capQueued.taskId === taskX);

    // --- drive a real supervised restart via the deps injection seam (fake instant build, captured exit) ---
    const fakeRunStep = async () => ({ code: 0, out: "" });
    const exitCalls = [];
    process.env.LOOM_SUPERVISED = "1";
    let result;
    try {
      result = await sessions.requestDaemonRestart(mgrA, "verify capQueued snapshot", {
        buildDeps: { runStep: fakeRunStep },
        exit: (code) => exitCalls.push(code),
      });
    } finally {
      delete process.env.LOOM_SUPERVISED;
    }
    check("(A setup) the supervised restart reports restarting:true", result.restarting === true);

    const written = restart.readRestartIntent();
    check("(A1) the written intent carries a capQueued snapshot for mgrA with exactly 1 entry",
      Array.isArray(written?.capQueued?.[mgrA]) && written.capQueued[mgrA].length === 1);
    const entry = written?.capQueued?.[mgrA]?.[0];
    check("(A1) the snapshotted entry matches the rejected spawn's opId/taskId/kickoffLabel",
      !!entry && entry.opId === rejected.capQueued.opId && entry.taskId === taskX
      && entry.kickoffLabel.includes("this is the kickoff"));
    check("(A1) the snapshot is the PUBLIC projection only — no kickoffPrompt field leaked onto disk",
      !!entry && !("kickoffPrompt" in entry));
    // Positive control for the check above (code review nit): a negative-polarity assertion ("field NOT
    // present") passes just as happily on a shape change underneath it. Prove it isn't vacuous by reading
    // the INTERNAL registry entry (white-box: TS `private` erased at runtime — same pattern
    // worker-spawn-cap-queue.mjs's whiteboxed `svc.capQueue.entries` access uses) and confirming
    // kickoffPrompt genuinely EXISTS there — the field is real, it's just deliberately excluded from the
    // public projection that gets written to disk, not absent because the whole shape drifted.
    const internalEntry = sessions.capQueue.takeOldest(mgrA);
    check("(A1 control) positive control: the INTERNAL registry entry DOES carry a real kickoffPrompt",
      !!internalEntry && typeof internalEntry.kickoffPrompt === "string" && internalEntry.kickoffPrompt.includes("this is the kickoff"));
    check("(A2) a sibling manager (mgrB) with NO cap-queued entries gets no key in the snapshot at all",
      !written?.capQueued || !(mgrB in written.capQueued));

    restart.clearRestartIntent();
  } finally {
    db.close();
  }
}

// --- (A3) both-directions control: when NOBODY has a cap-queued entry, `capQueued` is ABSENT from the
//     written intent entirely (not an empty object) — mirrors `pending`'s own absent-when-empty contract. ---
{
  const db = new Db();
  const pty = new PtyStub();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const proj = `rcqn-A3-proj-${sfx}`, mgrAgent = `rcqn-A3-mgrag-${sfx}`;
  const mgrC = `rcqn-A3-mgrC-${sfx}`;
  try {
    db.insertProject({ id: proj, name: "A3", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: mgrAgent, projectId: proj, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertSession({ id: mgrC, projectId: proj, agentId: mgrAgent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const fakeRunStep = async () => ({ code: 0, out: "" });
    process.env.LOOM_SUPERVISED = "1";
    try {
      await sessions.requestDaemonRestart(mgrC, "verify no capQueued key when nothing queued", {
        buildDeps: { runStep: fakeRunStep }, exit: () => {},
      });
    } finally {
      delete process.env.LOOM_SUPERVISED;
    }
    const written = restart.readRestartIntent();
    check("(A3) with nothing cap-queued anywhere, the written intent has NO capQueued key at all",
      written != null && !("capQueued" in written));
    restart.clearRestartIntent();
  } finally {
    db.close();
  }
}

// --- (A4) entry-count cap (code review MINOR): a manager whose registry holds MORE than the snapshot's
//     defensive cap gets a TRUNCATED, non-silent snapshot — the truncation is surfaced (not silent) via a
//     "(+N more not shown)" suffix on the last kept entry's own kickoffLabel. Mirrors PENDING_MAX_MSGS's
//     own defensive-cap reasoning three lines above the capture site. ---
{
  const db = new Db();
  const pty = new PtyStub();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const proj = `rcqn-A4-proj-${sfx}`, mgrAgent = `rcqn-A4-mgrag-${sfx}`, devAgent = `rcqn-A4-devag-${sfx}`;
  const mgrD = `rcqn-A4-mgrD-${sfx}`, fillerWorker = `rcqn-A4-filler-${sfx}`;
  try {
    db.insertProject({ id: proj, name: "A4", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: { orchestration: { maxConcurrentWorkers: 1 } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: mgrAgent, projectId: proj, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: devAgent, projectId: proj, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertSession({ id: mgrD, projectId: proj, agentId: mgrAgent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    // Fill the cap with a DIRECTLY-inserted live worker row (same trick as Part A) — every spawn below is
    // cap-rejected before it ever reaches createWorktree, so no real git repo is needed even at this volume.
    db.insertSession({ id: fillerWorker, projectId: proj, agentId: devAgent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrD });

    const TOTAL = 25; // > the snapshot's 20-entry cap
    for (let i = 0; i < TOTAL; i++) {
      const tid = `rcqn-A4-task-${i}-${sfx}`;
      db.insertTask({ id: tid, projectId: proj, title: `task ${i}`, body: "", columnKey: "backlog", position: i, priority: "p2", createdAt: now, updatedAt: now });
      try { await sessions.spawnWorker(mgrD, { taskId: tid, agentId: devAgent, kickoffPrompt: `GO task ${i}` }); } catch { /* expected: cap-rejected every time (cap=1, filled) */ }
    }
    check(`(A4 setup) all ${TOTAL} spawns were cap-queued in the live registry`, sessions.capQueue.listByManager(mgrD).length === TOTAL);

    const fakeRunStep = async () => ({ code: 0, out: "" });
    process.env.LOOM_SUPERVISED = "1";
    try {
      await sessions.requestDaemonRestart(mgrD, "verify entry-count cap", { buildDeps: { runStep: fakeRunStep }, exit: () => {} });
    } finally {
      delete process.env.LOOM_SUPERVISED;
    }
    const written = restart.readRestartIntent();
    check(`(A4) the written snapshot is CLIPPED to 20 entries, not all ${TOTAL}`,
      Array.isArray(written?.capQueued?.[mgrD]) && written.capQueued[mgrD].length === 20);
    const lastKept = written?.capQueued?.[mgrD]?.[19];
    check("(A4) the truncation is surfaced (NOT silent) via a '(+N more not shown)' suffix on the last kept entry",
      !!lastKept && lastKept.kickoffLabel.includes(`(+${TOTAL - 20} more not shown)`));
    restart.clearRestartIntent();
  } finally {
    db.close();
  }
}

// ===================== PART B — the NOTIFY half: resumeFleetOnBoot discloses what was dropped =====================
{
  const db = new Db();
  const proj = `rcqn-B-proj-${sfx}`, agent = `rcqn-B-ag-${sfx}`;
  try {
    db.insertProject({ id: proj, name: "B", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
    const mk = (id, o = {}) => db.insertSession({
      id, projectId: proj, agentId: agent, engineSessionId: `eng-${id}`,
      title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown",
      busy: false, createdAt: now, lastActivity: now, lastError: null,
      role: o.role ?? null, parentSessionId: o.parentSessionId ?? null,
      taskId: null, worktreePath: null, branch: null,
    });
    const id = {
      silentMgr: `rcqn-B-silentmgr-${sfx}`,       // 0 workers, empty board → would OTHERWISE resume SILENTLY
      silentMgrClean: `rcqn-B-silentmgrclean-${sfx}`, // control: same shape, NO dropped entries
      affectedMgr: `rcqn-B-affectedmgr-${sfx}`,   // gets the FULL re-orient nudge anyway (queued I/O)
      requester: `rcqn-B-requester-${sfx}`,
    };
    mk(id.silentMgr, { role: "manager" });
    mk(id.silentMgrClean, { role: "manager" });
    mk(id.affectedMgr, { role: "manager" });
    mk(id.requester, { role: "manager" });

    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const droppedFor = (mgrId, n) => [{
      opId: `op-${mgrId}-${n}`, managerSessionId: mgrId, agentId: `dev-${mgrId}`,
      taskId: `task-${mgrId}-${n}`, kickoffLabel: `dropped kickoff for ${mgrId} #${n}`,
      queuedAt: now,
    }];
    const intent = {
      reason: "routine restart", managerSessionId: id.requester, requestedAt: now,
      resume: [
        { sessionId: id.silentMgr, role: "manager", parentSessionId: null },
        { sessionId: id.silentMgrClean, role: "manager", parentSessionId: null },
        { sessionId: id.affectedMgr, role: "manager", parentSessionId: null },
        { sessionId: id.requester, role: "manager", parentSessionId: null },
      ],
      // (B3) affectedMgr also has real queued I/O so it takes the "affected" (full re-orient) branch,
      // independent of its dropped cap-queued entry.
      pending: { [id.affectedMgr]: ["a queued manager message"] },
      capQueued: {
        [id.silentMgr]: droppedFor(id.silentMgr, 1),
        [id.affectedMgr]: droppedFor(id.affectedMgr, 1),
        [id.requester]: droppedFor(id.requester, 1),
        // id.silentMgrClean deliberately has NO key — the (B2) control.
      },
    };
    sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
    await flush();
    const q = (i) => pty.getPending(i);
    const hasNote = (i, n) => q(i).some((m) => /DROPPED by this restart/.test(m) && m.includes(`op-${i}-${n}`) && m.includes(`task-${i}-${n}`) && m.includes(`dropped kickoff for ${i} #${n}`));

    check("(B1) a bystander manager that would OTHERWISE resume SILENTLY still gets a minimal note-only turn naming the dropped entry",
      hasNote(id.silentMgr, 1) && q(id.silentMgr).length === 1);
    check("(B2) the control bystander manager (NO dropped entries) resumes truly silently — NO enqueued turn (no regression)",
      q(id.silentMgrClean).length === 0);
    check("(B3) the 'affected' manager's FULL re-orient nudge also carries the dropped-entry note",
      // length===2: replayPending() replays the queued pending message FIRST (a separate enqueue), THEN
      // the full re-orient nudge itself (carrying the note) — unlike B1/B4, which have no pending I/O.
      hasNote(id.affectedMgr, 1) && q(id.affectedMgr).length === 2 && q(id.affectedMgr).some((m) => /queued message/.test(m)));
    check("(B4) the deploy requester's own 'code is live' nudge carries the note when it had a dropped entry",
      hasNote(id.requester, 1) && q(id.requester).length === 1 && /code is now LIVE/.test(q(id.requester)[0]));
  } finally {
    db.close();
  }
}

// ===================== PART C — MALFORMED capQueued entries must be skipped (logged), never crash =====================
// resumeFleetOnBoot and abort the WHOLE fleet resume (code review, BLOCKING: pre-fix, capQueuedNote had none
// of replayPending's defensive shape-handling — a non-array value, or a null/foreign-shaped array element,
// threw uncaught. resumeFleetOnBoot has no per-call try/catch and clearRestartIntent() has already run by
// the time this fires (index.ts), so the throw would abort resuming every LATER session in the fleet with
// the intent file already gone — unrecoverable without a human. Mirrors restart-giveup-hold.mjs's case (5),
// the existing regression test for the identical invariant on `pending`'s own sibling reader.)
{
  const db = new Db();
  const proj = `rcqn-C-proj-${sfx}`, agent = `rcqn-C-ag-${sfx}`;
  try {
    db.insertProject({ id: proj, name: "C", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
    const mk = (id, o = {}) => db.insertSession({
      id, projectId: proj, agentId: agent, engineSessionId: `eng-${id}`,
      title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown",
      busy: false, createdAt: now, lastActivity: now, lastError: null,
      role: o.role ?? null, parentSessionId: o.parentSessionId ?? null,
      taskId: null, worktreePath: null, branch: null,
    });
    const id = {
      notAnArray: `rcqn-C-notarray-${sfx}`, // capQueued[id] is an OBJECT, not an array — wrong TYPE entirely
      mixed: `rcqn-C-mixed-${sfx}`,         // capQueued[id] is an array mixing valid + malformed elements
      laterGood: `rcqn-C-later-${sfx}`,     // comes AFTER the malformed ones in `resume` — proves the loop kept going
    };
    mk(id.notAnArray, { role: "manager" });
    mk(id.mixed, { role: "manager" });
    mk(id.laterGood, { role: "manager" });

    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const validEntry = (mgrId, n) => ({ opId: `op-${mgrId}-${n}`, managerSessionId: mgrId, agentId: `dev-${mgrId}`, taskId: `task-${mgrId}-${n}`, kickoffLabel: `kickoff ${mgrId} #${n}`, queuedAt: now });
    const badIntent = {
      reason: "deploy", managerSessionId: id.laterGood, requestedAt: now,
      resume: [
        { sessionId: id.notAnArray, role: "manager", parentSessionId: null },
        { sessionId: id.mixed, role: "manager", parentSessionId: null },
        { sessionId: id.laterGood, role: "manager", parentSessionId: null },
      ],
      capQueued: {
        [id.notAnArray]: { foo: "bar" }, // wrong TYPE entirely — not an array at all
        [id.mixed]: [validEntry(id.mixed, 1), null, "a bare string", { opId: 5, kickoffLabel: null }, validEntry(id.mixed, 2)],
        [id.laterGood]: [validEntry(id.laterGood, 1)],
      },
    };
    let threw = null;
    try { sessions.resumeFleetOnBoot(badIntent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS }); } catch (e) { threw = e; }
    await flush();
    check("(C) resumeFleetOnBoot did NOT throw on malformed capQueued entries — THE BLOCKING code-review finding",
      threw === null);

    const q = (i) => pty.getPending(i);
    check("(C) a non-array capQueued[id] degrades to no note (not a crash) — this manager resumes silently",
      q(id.notAnArray).length === 0);
    const mixedNote = q(id.mixed).find((m) => /DROPPED by this restart/.test(m));
    check("(C) a mixed array skips the null/string/malformed elements and still reports the 2 VALID entries",
      !!mixedNote && mixedNote.includes("⚠️ 2 cap-queued")
      && mixedNote.includes(`op-${id.mixed}-1`) && mixedNote.includes(`op-${id.mixed}-2`));
    check("(C) the malformed elements never leak into the rendered note text",
      !!mixedNote && !mixedNote.includes("a bare string"));
    check("(C) a LATER session in the resume list still gets its OWN normal note — the loop was NOT aborted by the earlier malformed entries",
      q(id.laterGood).some((m) => /DROPPED by this restart/.test(m) && m.includes(`op-${id.laterGood}-1`)));
  } finally {
    db.close();
  }
}

fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — requestDaemonRestart snapshots each manager's/platform's still-live cap-queued worker_spawn " +
    "intents (public projection only, absent when nothing queued) into the restart-intent right before exit, and " +
    "resumeFleetOnBoot discloses exactly what was dropped to the affected manager/platform — even one that would " +
    "otherwise resume completely silently — while an unaffected sibling's resume is untouched (no regression)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
