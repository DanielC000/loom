import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn PHANTOM-LIVE row on a pre-pty synchronous throw (card fa1b77c1).
//
// The bug: spawnWorker (sessions/service.ts) flips a worker row to processState:"live"
// (setProcessState) BEFORE the pty is started. Several synchronous statements run between that flip
// and pty.spawn's own try/catch (project-memory retrieval + digest stamp, codescape-injection-status
// resolution) — NONE of them were wrapped in a catch. If any of them throws, the row is stranded
// "live" with no process behind it: a PHANTOM-LIVE worker that silently occupies a concurrency slot
// until a human notices and worker_stop's it by hand.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a
// FAKE pty (createPty() seam) and a real temp git repo behind createWorktree. The throw is forced by
// monkeypatching SessionService.prototype.stampProjectMemoryDigest (one of the exact pre-pty
// statements named on the card) — the same prototype-patch technique
// worker-spawn-cap-inflight-live-double-count.mjs already uses for GitReader.prototype.log.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-prespawn-throw-marks-exited.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wspt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-wspt-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-prespawn-throw-marks-exited test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=ws@loom -c user.name=ws");

const CAP = 2;
const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: CAP } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

const taskA = randomUUID();
db.insertTask({ id: taskA, projectId: "pP", title: "task A", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

class SeamHost extends createSeamHost(PtyHost) {}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

// --- force a synchronous throw in a pre-pty step: stampProjectMemoryDigest runs AFTER the row is
// flipped 'live' and BEFORE pty.spawn's own try/catch (see the card's traced statement list). TS
// `private` is erased at runtime — the same prototype-patch technique the sibling cap test already
// relies on for GitReader.prototype.log. ---
const INJECTED_MESSAGE = "injected pre-spawn throw (worker-spawn-prespawn-throw-marks-exited test)";
const originalStamp = SessionService.prototype.stampProjectMemoryDigest;
SessionService.prototype.stampProjectMemoryDigest = function () {
  throw new Error(INJECTED_MESSAGE);
};

const worktrees = [];
try {
  let spawnError;
  try {
    await svc.spawnWorker("mgr1", { taskId: taskA, agentId: "agentDev", kickoffPrompt: "GO A" });
  } catch (e) {
    spawnError = e;
  }

  check("(setup precondition) the injected pre-spawn throw actually propagated out of spawnWorker",
    !!spawnError && String(spawnError.message).includes(INJECTED_MESSAGE));

  // The row exists (insertSession ran before the throw) — find it by taskId rather than trusting a
  // returned id (spawnWorker rejected, so it never returned one).
  const rows = db.listWorkers("mgr1").filter((w) => w.taskId === taskA);
  check("(setup precondition) exactly one worker row was created for the task despite the throw", rows.length === 1);
  const row = rows[0];
  if (row?.worktreePath) worktrees.push(row.worktreePath);

  check("worker row ends processState:'exited', NOT stranded 'live', after a pre-spawn throw",
    row?.processState === "exited");
  check("worker row's lastError carries the injected throw's own message (the catch's second effect)",
    typeof row?.lastError === "string" && row.lastError.includes(INJECTED_MESSAGE));

  const capacity = svc.getWorkerCapacity("mgr1");
  check("manager capacity shows NO live worker for this manager after the pre-spawn throw", capacity.live === 0);
  check("manager capacity shows NO lingering in-flight claim either (outer finally released it)", capacity.inFlight === 0);
  check("manager capacity is fully free again (cap - live - inFlight == cap)", capacity.free === CAP);
} finally {
  SessionService.prototype.stampProjectMemoryDigest = originalStamp;
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? `\n✅ ALL PASS — a synchronous throw in a pre-pty step (stampProjectMemoryDigest) after the row goes live leaves it 'exited', not phantom-live, and frees the manager's cap slot.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
