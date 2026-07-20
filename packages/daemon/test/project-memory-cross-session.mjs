import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Project-scoped SHARED agent memory (card 2fd9abf9) — the LOAD-BEARING cross-session-sharing proof the
// card's DoD calls out explicitly: "write in session A, spawn a worker on a worktree branch, assert the
// note is in ITS injected kickoff — a same-session test is NOT sufficient". DETERMINISTIC + CLAUDE-FREE +
// NETWORK-FREE, mirroring browser-testing-spawn.mjs's SeamHost pattern: a REAL Db + SessionService driven
// against a FAKE pty injected via PtyHost's createPty()/enqueueStdin() seams, with a real temp git repo
// backing spawnWorker's createWorktree. The only thing faked is the claude pty itself.
//
// Also covers:
//   - the fresh-spawn injection point for spawnWorker (the DoD scenario) AND startNew/startManager,
//   - the RESUME injection point (enqueueStdin, kind:"warning" — never "agent" direction),
//   - the fully-additive guard: a project with ZERO memory notes produces a BYTE-IDENTICAL startupPrompt
//     to a spawn with no project-memory logic at all (no [loom:project-memory] tag anywhere).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-cross-session.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pm-xsession-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { composeWorkerStartupPrompt } = await import("../dist/sessions/worker-prompt.js");
const { PROJECT_MEMORY_TAG } = await import("../dist/sessions/project-memory-recall.js");

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-pm-xsession-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# project-memory-cross-session test\n");
execSync(`git init -q && git add . && git -c user.email=pm@loom -c user.name=pm commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
const projA = "pA"; // has memory notes
const projB = "pB"; // ZERO memory notes — additive guard
db.insertProject({ id: projA, name: "Project A", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: projB, name: "Project B", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "mgrAgentA", projectId: projA, name: "Manager", startupPrompt: "MANAGER_PROMPT_A", position: 0, profileId: null });
db.insertAgent({ id: "workerAgentA", projectId: projA, name: "Dev", startupPrompt: "WORKER_PROMPT_A", position: 1, profileId: null });
db.insertAgent({ id: "mgrAgentB", projectId: projB, name: "Manager", startupPrompt: "MANAGER_PROMPT_B", position: 0, profileId: null });
db.insertAgent({ id: "workerAgentB", projectId: projB, name: "Dev", startupPrompt: "WORKER_PROMPT_B", position: 1, profileId: null });
db.insertSession({ id: "mgrA", projectId: projA, agentId: "mgrAgentA", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
db.insertSession({ id: "mgrB", projectId: projB, agentId: "mgrAgentB", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const tA = "11111111-1111-4111-8111-111111111111";
const tB = "22222222-2222-4222-8222-222222222222";
db.insertTask({ id: tA, projectId: projA, title: "Fix the flaky vite dev-server port bug", body: "the dev server sometimes binds a random port when 5317 is taken", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: tB, projectId: projB, title: "Unrelated task", body: "nothing to do with any note", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; this.enqueued = []; }
  createPty(opts) { this.capture.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  // resume()'s already-live short-circuit consults pty.isAlive: this capture seam drives NO live OS pty,
  // so report not-live — the test resumes a (notionally stopped) session to inspect its resume behavior.
  isAlive() { return false; }
  // Bypass the real queue/ready-gate machinery entirely (it depends on a real spawned+ready pty) — we
  // only care THAT the resume half calls enqueueStdin with the right text/kind, not delivery mechanics.
  enqueueStdin(sessionId, text, source, _onDeliver, _route, kind = "warning") {
    this.enqueued.push({ sessionId, text, source, kind });
    return { delivered: false };
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

const worktrees = [];
try {
  // ===================== "session A" writes a project-scoped note (simulates memory_write from a
  // DIFFERENT session on the same project — this is the fleet-shared write, not a same-session hack) =====================
  const cfg = (await import("@loom/shared")).resolveConfig(db.getProject(projA).config).memory;
  db.upsertProjectMemory(projA, {
    key: "vite-port-gotcha",
    title: "Vite dev-server port gotcha",
    text: "vite binds a random port instead of 5317 when the default port is already taken by another process — check the actual bound port in the startup log line before assuming 5317.",
  }, cfg.maxNotes);
  db.upsertProjectMemory(projA, {
    key: "always-pinned-fact",
    text: "this project's daemon default port is 4317 — always pinned, injected on EVERY kickoff regardless of match.",
    pinned: true,
  }, cfg.maxNotes);

  // ===================== THE DoD SCENARIO: a fresh worker spawn on a worktree branch, dispatched via
  // spawnWorker (manager → worker), must see the note in its OWN injected kickoff =====================
  const kickoff = "Please fix the flaky vite dev-server port issue described on the task.";
  const worker = await svc.spawnWorker("mgrA", { taskId: tA, agentId: "workerAgentA", kickoffPrompt: kickoff });
  worktrees.push(worker.worktreePath);
  const workerOpts = optsFor(worker.id);
  check("(cross-session) spawnWorker's captured startupPrompt carries the PROJECT_MEMORY_TAG",
    typeof workerOpts?.startupPrompt === "string" && workerOpts.startupPrompt.includes(PROJECT_MEMORY_TAG));
  check("(cross-session) the FTS5-MATCHED related note (written in a DIFFERENT session) is in the worker's kickoff",
    workerOpts.startupPrompt.includes("vite binds a random port"));
  check("(cross-session) the PINNED note rides too, even though the kickoff text never mentions it",
    workerOpts.startupPrompt.includes("daemon default port is 4317"));
  check("(cross-session) the worker's own agent prompt + manager kickoff are STILL present (append, not replace)",
    workerOpts.startupPrompt.includes("WORKER_PROMPT_A") && workerOpts.startupPrompt.includes(kickoff));

  // ===================== fix #5 (code review): recycleWorker is a FRESH spawn (no --resume) — it must
  // ALSO get project memory injected, exactly like spawnWorker, or a context-limit recycle silently loses
  // every note its predecessor saw =====================
  host.capture.length = 0;
  const handoff = "Handing off: still investigating the vite dev-server port binding issue, no fix landed yet.";
  const recycled = await svc.recycleWorker("mgrA", worker.id, handoff);
  worktrees.push(recycled.worktreePath);
  const recycledOpts = optsFor(recycled.id);
  check("(recycle) recycleWorker's captured startupPrompt carries the PROJECT_MEMORY_TAG",
    typeof recycledOpts?.startupPrompt === "string" && recycledOpts.startupPrompt.includes(PROJECT_MEMORY_TAG));
  check("(recycle) the FTS5-MATCHED related note (matched against the HANDOFF text) is in the recycled kickoff",
    recycledOpts.startupPrompt.includes("vite binds a random port"));
  check("(recycle) the PINNED note rides too on a recycle spawn",
    recycledOpts.startupPrompt.includes("daemon default port is 4317"));
  check("(recycle) the handoff text itself is still present (append, not replace)",
    recycledOpts.startupPrompt.includes(handoff));

  // ===================== FRESH-SPAWN STAMP (card ea648f89 follow-up): recycleWorker's own fresh-spawn
  // project-memory injection (just proven above) must ALSO stamp the resume-dedup map with what it just
  // showed `recycled` — otherwise the map is empty at this session's first resume() call, which would
  // treat "no prior digest" as license to redundantly re-inject the SAME block the fresh spawn already
  // carried. Run IMMEDIATELY after recycleWorker, before any further memory_write, so nothing has changed
  // since the stamp — this is the clean "nothing to see" case the fix targets. =====================
  {
    const engIdRecycled = "55555555-6666-7777-8888-999999999999";
    db.setEngineSessionId(recycled.id, engIdRecycled);
    const tpathRecycled = engineTranscriptPath(repo, engIdRecycled);
    fs.mkdirSync(path.dirname(tpathRecycled), { recursive: true });
    fs.writeFileSync(tpathRecycled, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

    host.enqueued.length = 0;
    svc.resume(recycled.id);
    check("(fresh-spawn stamp) the recycled worker's FIRST resume enqueues NOTHING project-memory-related — recycleWorker's own fresh-spawn kickoff already showed it the identical block",
      !host.enqueued.some((e) => e.sessionId === recycled.id && e.text.includes(PROJECT_MEMORY_TAG)));

    // a genuinely NEW pinned note (rides regardless of search text) changes the digest — the very next
    // resume must still inject it: the dedup must never go silent on real new content.
    db.upsertProjectMemory(projA, {
      key: "new-note-after-recycle-stamp",
      title: "New note added after the recycle fresh-spawn stamp",
      text: "this note was written after recycleWorker's own stamp and must still reach the very next resume.",
      pinned: true,
    }, cfg.maxNotes);
    host.enqueued.length = 0;
    svc.resume(recycled.id);
    const recycleDedupMsg = host.enqueued.find((e) => e.sessionId === recycled.id);
    check("(fresh-spawn stamp) a resume AFTER a genuinely new note still enqueues (the digest changed since the fresh-spawn stamp)",
      !!recycleDedupMsg && recycleDedupMsg.text.includes(PROJECT_MEMORY_TAG));
    check("(fresh-spawn stamp) the new note's content is present in the re-injected block",
      recycleDedupMsg?.text.includes("written after recycleWorker's own stamp"));
  }

  // ===================== additive guard: a DIFFERENT project with ZERO memory notes spawns a
  // BYTE-IDENTICAL startupPrompt to composeWorkerStartupPrompt alone (no tag, no injection at all) =====================
  const kickoffB = "Do the unrelated task.";
  const workerB = await svc.spawnWorker("mgrB", { taskId: tB, agentId: "workerAgentB", kickoffPrompt: kickoffB });
  worktrees.push(workerB.worktreePath);
  const workerBOpts = optsFor(workerB.id);
  const expectedUnmodified = composeWorkerStartupPrompt("WORKER_PROMPT_B", kickoffB, workerB.worktreePath);
  check("(additive) zero-notes project: worker startupPrompt is BYTE-IDENTICAL to composeWorkerStartupPrompt alone",
    workerBOpts.startupPrompt === expectedUnmodified);
  check("(additive) zero-notes project: no PROJECT_MEMORY_TAG anywhere in the kickoff",
    !workerBOpts.startupPrompt.includes(PROJECT_MEMORY_TAG));

  // ===================== startNew / startManager fresh-spawn injection points =====================
  host.capture.length = 0;
  const mgrFresh = svc.startManager("mgrAgentA");
  const mgrFreshOpts = optsFor(mgrFresh.id);
  check("(startManager) a fresh manager spawn on project A ALSO gets the pinned note",
    mgrFreshOpts?.startupPrompt?.includes(PROJECT_MEMORY_TAG) && mgrFreshOpts.startupPrompt.includes("daemon default port is 4317"));

  host.capture.length = 0;
  const workerFreshNew = svc.startNew("workerAgentA");
  const workerFreshOpts = optsFor(workerFreshNew.id);
  check("(startNew) a fresh generic spawn on project A ALSO gets the pinned note",
    workerFreshOpts?.startupPrompt?.includes(PROJECT_MEMORY_TAG) && workerFreshOpts.startupPrompt.includes("daemon default port is 4317"));

  // ===================== RESUME injection point (enqueueStdin, kind defaults to "warning") =====================
  // A RAW session inserted directly (never spawned through svc, mirroring mgrA/mgrB above) — unlike
  // `recycled`, it carries NO prior entry in the resume-dedup map, so its first resume is guaranteed to
  // inject regardless of the fresh-spawn stamping proven above, cleanly isolating "resume CAN inject" from
  // "a fresh spawn's own stamp dedups its first resume". Task-bound to tA so its kickoffText still matches
  // the FTS5-related note, same as the original scenario this section proved.
  const rawWorkerId = "rawWorkerA";
  const rawEngId = "33333333-4444-5555-6666-777777777777";
  db.insertSession({
    id: rawWorkerId, projectId: projA, agentId: "workerAgentA", engineSessionId: rawEngId, title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", taskId: tA,
  });
  const tpath = engineTranscriptPath(repo, rawEngId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  host.enqueued.length = 0;
  svc.resume(rawWorkerId);
  const resumeMsg = host.enqueued.find((e) => e.sessionId === rawWorkerId);
  check("(resume) resume() enqueues a project-memory recall turn (task-bound worker still matches its own task)",
    !!resumeMsg && resumeMsg.text.includes(PROJECT_MEMORY_TAG));
  check("(resume) the recall carries the pinned note", resumeMsg?.text.includes("daemon default port is 4317"));
  check("(resume) injected as kind:\"warning\" (operational/coalescible), NEVER \"agent\" direction",
    resumeMsg?.kind === "warning");

  // ===================== resume on the ZERO-notes project enqueues NOTHING project-memory-related =====================
  const engIdB = "88888888-9999-aaaa-bbbb-cccccccccccc";
  db.setEngineSessionId(workerB.id, engIdB);
  const tpathB = engineTranscriptPath(repo, engIdB);
  fs.mkdirSync(path.dirname(tpathB), { recursive: true });
  fs.writeFileSync(tpathB, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  host.enqueued.length = 0;
  svc.resume(workerB.id);
  check("(resume additive) zero-notes project: NO project-memory enqueue at all",
    !host.enqueued.some((e) => e.sessionId === workerB.id && e.text.includes(PROJECT_MEMORY_TAG)));

  // ===================== RESUME DEDUP (card ea648f89): the resume half re-retrieves on EVERY resume
  // (idle-nudge resumes, wakes, crash/restart recovery) with no change-detection — re-injecting the
  // IDENTICAL framed block verbatim every time. Observed live as 3 consecutive identical injections on one
  // manager, flagged unprompted as noise. Fix: hash the framed block and compare against the digest
  // persisted from the session's LAST injection (in-memory, keyed by session id — see
  // lastProjectMemoryDigest in service.ts); skip the enqueue when unchanged, but still inject when a
  // genuinely NEW/edited note changes the digest. =====================
  host.enqueued.length = 0;
  svc.resume(rawWorkerId); // same session, SAME notes as its last resume above — nothing changed
  check("(dedup) a resume with NO change since the last injection enqueues NOTHING project-memory-related",
    !host.enqueued.some((e) => e.sessionId === rawWorkerId && e.text.includes(PROJECT_MEMORY_TAG)));

  db.upsertProjectMemory(projA, {
    key: "new-note-after-dedup",
    title: "New note added after the dedup baseline",
    text: "this note was written AFTER the session's last injected digest and must reach the next resume.",
    pinned: true,
  }, cfg.maxNotes);
  host.enqueued.length = 0;
  svc.resume(rawWorkerId);
  const dedupResumeMsg = host.enqueued.find((e) => e.sessionId === rawWorkerId);
  check("(dedup) a resume AFTER a genuinely new note enqueues the recall again (the digest changed)",
    !!dedupResumeMsg && dedupResumeMsg.text.includes(PROJECT_MEMORY_TAG));
  check("(dedup) the new note's content is present in the re-injected block ('sees notes written since last spawn' is preserved)",
    dedupResumeMsg?.text.includes("written AFTER the session's last injected digest"));

  host.enqueued.length = 0;
  svc.resume(rawWorkerId); // immediately again, no further writes — must dedup against the JUST-updated digest too
  check("(dedup) a resume right after the delta injection ALSO dedups (the newly-persisted digest is the new baseline)",
    !host.enqueued.some((e) => e.sessionId === rawWorkerId && e.text.includes(PROJECT_MEMORY_TAG)));

  // ===================== task 1b27e123: recycleManager is a FRESH spawn (no --resume) — it must ALSO get
  // project memory appended to its composed startup prompt, exactly like recycleWorker/spawnWorker, or a
  // context-limit MANAGER recycle silently loses every note its predecessor saw. The continuation text
  // deliberately avoids "vite"/"port" wording so its digest matches what a plain resume of the successor
  // will later compute from the agent's own startup prompt (a manager carries no taskId) — isolating the
  // dedup-stamp proof from the "related note matches differently at resume time" complication
  // recycleWorker's task-bound handoff doesn't have. =====================
  host.capture.length = 0;
  const managerContinuation = "Handing off: nothing task-specific to report, general fleet status only.";
  const recycledManager = await svc.recycleManager("mgrA", managerContinuation);
  const recycledManagerOpts = optsFor(recycledManager.id);
  check("(recycleManager) captured startupPrompt carries the PROJECT_MEMORY_TAG",
    typeof recycledManagerOpts?.startupPrompt === "string" && recycledManagerOpts.startupPrompt.includes(PROJECT_MEMORY_TAG));
  check("(recycleManager) the PINNED note rides on a manager recycle spawn",
    recycledManagerOpts.startupPrompt.includes("daemon default port is 4317"));
  check("(recycleManager) the continuation handoff text itself is still present (append, not replace)",
    recycledManagerOpts.startupPrompt.includes(managerContinuation));
  check("(recycleManager) the successor's own agent warm-up prompt is still present too",
    recycledManagerOpts.startupPrompt.includes("MANAGER_PROMPT_A"));

  // FRESH-SPAWN STAMP (card ea648f89, extended to this seed point): the recycled manager's FIRST resume
  // must not redundantly re-show the identical block recycleManager's own fresh-spawn kickoff already
  // carried.
  {
    const engIdMgr = "dddddddd-eeee-ffff-0000-111111111111";
    db.setEngineSessionId(recycledManager.id, engIdMgr);
    const tpathMgr = engineTranscriptPath(repo, engIdMgr);
    fs.mkdirSync(path.dirname(tpathMgr), { recursive: true });
    fs.writeFileSync(tpathMgr, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

    host.enqueued.length = 0;
    svc.resume(recycledManager.id);
    check("(recycleManager fresh-spawn stamp) the recycled manager's FIRST resume enqueues NOTHING project-memory-related",
      !host.enqueued.some((e) => e.sessionId === recycledManager.id && e.text.includes(PROJECT_MEMORY_TAG)));

    db.upsertProjectMemory(projA, {
      key: "new-note-after-manager-recycle-stamp",
      title: "New note added after the manager recycle fresh-spawn stamp",
      text: "this note was written after recycleManager's own stamp and must still reach the very next resume.",
      pinned: true,
    }, cfg.maxNotes);
    host.enqueued.length = 0;
    svc.resume(recycledManager.id);
    const mgrDedupMsg = host.enqueued.find((e) => e.sessionId === recycledManager.id);
    check("(recycleManager fresh-spawn stamp) a resume AFTER a genuinely new note still enqueues (the digest changed)",
      !!mgrDedupMsg && mgrDedupMsg.text.includes(PROJECT_MEMORY_TAG));
    check("(recycleManager fresh-spawn stamp) the new note's content is present in the re-injected block",
      mgrDedupMsg?.text.includes("written after recycleManager's own stamp"));
  }

  // ===================== task 1b27e123: forkSession has NO startup prompt of its own (--fork-session
  // carries the SOURCE transcript forward, mirrors resume()'s "resume injects nothing" invariant) — it
  // must inject project memory via enqueueStdin instead, exactly like resume() does, or a forked session
  // would silently lose every note its source saw =====================
  const forkSrcId = "forkSrcA";
  const forkSrcEngId = "eeeeeeee-ffff-0000-1111-222222222222";
  db.insertSession({
    id: forkSrcId, projectId: projA, agentId: "workerAgentA", engineSessionId: forkSrcEngId, title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker",
  });
  const forkSrcTpath = engineTranscriptPath(repo, forkSrcEngId);
  fs.mkdirSync(path.dirname(forkSrcTpath), { recursive: true });
  fs.writeFileSync(forkSrcTpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

  host.enqueued.length = 0;
  const forked = svc.forkSession(forkSrcId);
  const forkMsg = host.enqueued.find((e) => e.sessionId === forked.id);
  check("(fork) forkSession enqueues a project-memory recall turn for the new fork session id",
    !!forkMsg && forkMsg.text.includes(PROJECT_MEMORY_TAG));
  check("(fork) the PINNED note rides on a fork spawn",
    forkMsg?.text.includes("daemon default port is 4317"));
  check("(fork) injected as kind:\"warning\" (operational/coalescible, never \"agent\" direction, mirrors resume())",
    forkMsg?.kind === "warning");

  // FRESH-SPAWN STAMP: the fork's OWN first resume must not redundantly re-show the identical block
  // forkSession's own inject already delivered. The fork carries no taskId (by design — the Session
  // literal in forkSession deliberately omits it, unrelated to this feature), and neither does its
  // source (forkSrcId), so BOTH forkSession's own search text and the fork's later resume() search text
  // fall back to the SAME agent startup prompt — same digest either way.
  {
    const forkEngId = "ffffffff-0000-1111-2222-333333333333";
    db.setEngineSessionId(forked.id, forkEngId);
    const forkTpath = engineTranscriptPath(repo, forkEngId);
    fs.mkdirSync(path.dirname(forkTpath), { recursive: true });
    fs.writeFileSync(forkTpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

    host.enqueued.length = 0;
    svc.resume(forked.id);
    check("(fork fresh-spawn stamp) the fork's FIRST resume enqueues NOTHING project-memory-related",
      !host.enqueued.some((e) => e.sessionId === forked.id && e.text.includes(PROJECT_MEMORY_TAG)));

    db.upsertProjectMemory(projA, {
      key: "new-note-after-fork-stamp",
      title: "New note added after the fork fresh-spawn stamp",
      text: "this note was written after forkSession's own stamp and must still reach the very next resume.",
      pinned: true,
    }, cfg.maxNotes);
    host.enqueued.length = 0;
    svc.resume(forked.id);
    const forkDedupMsg = host.enqueued.find((e) => e.sessionId === forked.id);
    check("(fork fresh-spawn stamp) a resume AFTER a genuinely new note still enqueues (the digest changed)",
      !!forkDedupMsg && forkDedupMsg.text.includes(PROJECT_MEMORY_TAG));
    check("(fork fresh-spawn stamp) the new note's content is present in the re-injected block",
      forkDedupMsg?.text.includes("written after forkSession's own stamp"));
  }

  // ===================== additive guard: forking a session on the ZERO-notes project enqueues NOTHING
  // project-memory-related =====================
  const forkSrcBId = "forkSrcB";
  const forkSrcBEngId = "12121212-3434-4343-8565-565656565656";
  db.insertSession({
    id: forkSrcBId, projectId: projB, agentId: "workerAgentB", engineSessionId: forkSrcBEngId, title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker",
  });
  const forkSrcBTpath = engineTranscriptPath(repo, forkSrcBEngId);
  fs.mkdirSync(path.dirname(forkSrcBTpath), { recursive: true });
  fs.writeFileSync(forkSrcBTpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  host.enqueued.length = 0;
  const forkedB = svc.forkSession(forkSrcBId);
  check("(fork additive) zero-notes project: NO project-memory enqueue at all",
    !host.enqueued.some((e) => e.sessionId === forkedB.id && e.text.includes(PROJECT_MEMORY_TAG)));
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of worktrees.filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — cross-session sharing PROVEN (a note written in one session is retrieved and injected into a DIFFERENT, freshly-spawned worker session's kickoff via spawnWorker on a real worktree branch); pinned-always + FTS5-related-on-match both land; fresh-spawn injection covers spawnWorker/startManager/startNew/recycleWorker/recycleManager; resume() and forkSession both inject via enqueueStdin as kind:\"warning\"; a zero-notes project stays byte-identical to composeWorkerStartupPrompt alone with no tag anywhere and no resume/fork enqueue; a resume with an unchanged project-memory digest does NOT re-inject (whether unchanged since a PRIOR resume or since the session's own FRESH-SPAWN/recycle/fork kickoff), while a genuinely new note still reaches the very next resume every time (card ea648f89) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
