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
  // Resumes `recycled` (the CURRENT live worker on task A) rather than the original `worker` — the
  // original now has a successor (recycleWorker above), and resume() structurally refuses to resurrect a
  // superseded session (hasSuccessor guard) alongside its live successor.
  const engId = "33333333-4444-5555-6666-777777777777";
  db.setEngineSessionId(recycled.id, engId);
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  host.enqueued.length = 0;
  svc.resume(recycled.id);
  const resumeMsg = host.enqueued.find((e) => e.sessionId === recycled.id);
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
  ? "\n✅ ALL PASS — cross-session sharing PROVEN (a note written in one session is retrieved and injected into a DIFFERENT, freshly-spawned worker session's kickoff via spawnWorker on a real worktree branch); pinned-always + FTS5-related-on-match both land; fresh-spawn injection covers spawnWorker/startManager/startNew; resume() injects via enqueueStdin as kind:\"warning\"; a zero-notes project stays byte-identical to composeWorkerStartupPrompt alone with no tag anywhere and no resume enqueue — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
