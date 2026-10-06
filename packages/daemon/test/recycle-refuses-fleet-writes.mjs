import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 92c20eb9 — a manager superseded by its own recycle successor stays role:"manager"/
// processState:"live" (and can still receive/execute MCP calls) for the whole recycle-settle window
// (RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS + poll, fire-and-forget off recycleManager/
// reattemptManagerOwnershipTransfer's RESOLVED branch — see docs/decisions/92c20eb9-...). Two distinct
// defects lived in that window, both keyed off isSupersededByRecycle (never bare hasSuccessor, which
// would wrongly refuse the halted-predecessor carve-out — see decision 386e4eb5/f1969787):
//
//   (A) spawnWorker (and reviveWorker, which wraps it) had NO check at all — a worker spawned/revived
//       by the retiring predecessor was parented to a manager about to be hard-stopped.
//   (B) selfHealWorkerLink (every manager-surface per-worker tool) could RELINK a worker already
//       correctly reparented onto the successor BACK onto the dying predecessor, since its lineage-based
//       ownership check doesn't account for supersession — undoing attemptManagerOwnershipTransfer's
//       correct reparent and orphaning the worker from the successor's worker_list.
//
// Proves, for BOTH recycle windows (recycle_me's fire-and-forget settle, and recycle_reattempt's
// RESOLVED branch):
//   (1) spawnWorker refuses with "...being retired (recycled); your successor <id> owns the fleet",
//       naming the REAL live successor id, with NO pty spawned (no side effect before the throw).
//   (2) the guard fires BEFORE any of spawnWorker's own downstream validation (order proof: the SAME
//       otherwise-invalid call that threw a DIFFERENT error pre-recycle throws the retirement error
//       post-recycle).
//   (3) reviveWorker (direct service call) throws the SAME error — proves the chokepoint reuse.
//   (4) worker_revive refuses AT THE MCP LAYER TOO (the real registered tool, via OrchestrationMcpRouter
//       + an in-memory MCP client) — so a future refactor that stops routing revive through spawnWorker
//       is caught here, not just at the service-method level.
//   (5) a read tool (worker_status) on a worker ALREADY reparented onto the successor does NOT relink it
//       back onto the superseded caller — parentSessionId stays the successor's, before and after.
//   (6) a write tool (worker_message) on that same worker is refused outright with the same error text,
//       and also leaves parentSessionId untouched.
//
// Also proves (Code Review e6c9a84c, Minor 4 — the HALTED carve-out): a HALTED predecessor (genuinely
// NOT superseded, per decision 386e4eb5/f1969787 — its ownership-transfer handoff is still unresolved) can
// already have had a worker's "workers" step succeed onto its successor (halting only blocks RETIRING the
// predecessor, not that reparent). selfHealWorkerLink must not relink that worker back just because the
// caller isn't (yet) superseded, and none of the 10 write tools — nor spawnWorker — must show the
// retirement error while genuinely halted (the carve-out is real: a halted predecessor still legitimately
// owns and can act on the rest of its fleet).
//
// Also proves (Code Review e6c9a84c, Minor 5): ALL 10 of selfHealWorkerLink's write-tool call sites —
// worker_stop, worker_message, worker_redirect, worker_recycle, worker_merge_confirm, merge_batch,
// worker_set_mode, worker_flush, worker_reap, worker_relink — refuse with the retirement error while
// superseded (not just worker_message), via a table-driven loop.
//
// Negative control (behavioural, per DoD): verified manually by temporarily reverting both guards
// (service.ts's spawnWorker check and orchestration.ts's callerSupersededError/selfHealWorkerLink guard)
// and re-running this file — every check above that currently PASSes goes RED (a worker is actually
// created/parented to the dying predecessor, or a worker gets relinked back) rather than failing for an
// unrelated reason (e.g. a missing export). Restored before commit. The HALTED-carve-out fix (Minor 4) was
// ALSO separately verified: reverting ONLY its own 2-line guard in selfHealWorkerLink (leaving the
// superseded-caller guard intact) turns the (B-halted) checks red while the (A)/(B) superseded-state
// checks stay green — proving this specific fix is load-bearing on its own, not merely redundant with the
// broader superseded-caller guard. Restored before commit.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService + PtyHost driven against the
// shared fake-pty seam (createSeamHost) — mirrors recycle-reattempt.mjs's and worker-revive.mjs's own
// harnesses. NO real git repo needed: every assertion here is a REFUSAL that fires before spawnWorker
// ever reaches its project/worktree lookup.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-refuses-fleet-writes.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rfw-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every settle bound BEFORE importing dist/** (mirrors recycle-reattempt.mjs). We never wait
// out the full settle in this file (every assertion runs INSIDE the window, before the hard-stop), but a
// short bound keeps the fire-and-forget settle loop from lingering noisily in the background.
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = "20";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = "10";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = "3600000";
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { isSupersededByRecycle } = await import("../dist/orchestration/crash-orphaned-workers.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map();
  stoppedIds = new Set();
  capture = [];
  createPty(opts) {
    this.capture.push(opts);
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    return pty;
  }
  stop(id, mode) { this.stoppedIds.add(id); return super.stop(id, mode); }
}

function makeHarness() {
  const db = new Db();
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onReady(id) { db.setReachedReady(id); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
  };
  const host = new SeamHost(events);
  let sessions;
  host.events.onExit = (id, code, info) => {
    db.setProcessState(id, "exited");
    db.setBusy(id, false);
    const exited = db.getSession(id);
    if (exited) sessions.archiveOnExit(exited);
    if (exited) sessions.reconcileNeverStartedRecycleSuccessor(id, info.intended);
  };
  sessions = new SessionService(db, host, new OrchestrationControl());
  return { db, host, sessions };
}

function seedProject(db, id) {
  const now = new Date().toISOString();
  const repo = path.join(tmpHome, `repo-${id}`); // never touched on disk — every assertion refuses
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.setProjectConfig(id, { permission: { startupModeCycles: 0 } }); // markReady synchronously off one SessionStart
  return { repo };
}

/** Seeds a live worker onto `managerId` (mirrors recycle-reattempt.mjs's own seedFleet) so
 *  attemptManagerOwnershipTransfer reparents it onto the successor during recycleManager/reattempt. */
function seedLiveWorker(db, projectId, managerId) {
  const now = new Date().toISOString();
  const workerId = `${managerId}-worker`;
  db.insertTask({ id: `${managerId}-task`, projectId, title: "t", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: workerId, projectId, agentId: `${projectId}-mgr`, engineSessionId: "eng-w", title: null, cwd: projectId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: managerId, taskId: `${managerId}-task` });
  return { workerId };
}

/** Seeds a MERGED worker + follow-up card so reviveWorker's own validation chain (role/parent/merge_done/
 *  transcript/follow-up-task) passes and the call genuinely reaches spawnWorker (mirrors worker-revive.mjs's
 *  own fixture, trimmed to exactly what reviveWorker's checks require). */
function seedRevivableWorker(db, projectId, managerId, id) {
  const now = new Date().toISOString();
  const OLD_CWD = path.join(tmpHome, `gone-${id}`); // never created on disk — revive is refused before any fs read of it
  const ENG = `eng-${id}`;
  const tpath = engineTranscriptPath(OLD_CWD, ENG);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "x" } }) + "\n");
  const origTaskId = `${id}-orig`, fixTaskId = `${id}-fix`;
  db.insertTask({ id: origTaskId, projectId, title: "feat(x): original", body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
  db.updateTask(origTaskId, { mergedSha: "abc1234" });
  db.insertTask({ id: fixTaskId, projectId, title: "fix(x): follow-up", body: "", columnKey: "backlog", position: 2, createdAt: now, updatedAt: now });
  db.insertSession({
    id, projectId, agentId: `${projectId}-mgr`, engineSessionId: ENG, title: null, cwd: OLD_CWD, processState: "exited",
    resumability: "dead", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
    parentSessionId: managerId, taskId: origTaskId, worktreePath: OLD_CWD, branch: "loom/old",
  });
  db.appendEvent({ id: `ev-${id}`, ts: now, managerSessionId: managerId, workerSessionId: id, taskId: origTaskId, kind: "merge_done", detail: { branch: "loom/old" } });
  return { fixTaskId };
}

/** Forces reattemptManagerOwnershipTransfer's halt branch (mirrors recycle-reattempt.mjs's own helper). */
function stubWakesPermanentFailure() {
  const original = Db.prototype.reparentWakes;
  Db.prototype.reparentWakes = function () { throw new Error("injected PERMANENT failure (test)"); };
  return () => { Db.prototype.reparentWakes = original; };
}

/** Drives the real registered MCP tool (never the bare service method) for `managerSessionId`. */
async function mcpClientFor(db, sessions, host, managerSessionId) {
  const router = new OrchestrationMcpRouter(db, sessions, {}, host);
  const server = router.buildServer(managerSessionId, "manager");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "recycle-refuses-fleet-writes-test", version: "0" });
  await client.connect(clientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));
  return { client, call };
}

const RETIRED_RE = /being retired \(recycled\); your successor ([a-zA-Z0-9-]+) owns the fleet/;

/** Code Review e6c9a84c, Minor 5 — every manager-surface WRITE tool that calls selfHealWorkerLink, with
 *  minimal args that pass each tool's own zod schema (never reached — every one of these is refused
 *  before any of its own logic runs, by `callerSupersededError()`, the FIRST thing each handler does). */
const TEN_WRITE_TOOLS = (workerId) => [
  { name: "worker_stop", args: { workerSessionId: workerId } },
  { name: "worker_message", args: { workerSessionId: workerId, text: "hi" } },
  { name: "worker_redirect", args: { workerSessionId: workerId, text: "hi" } },
  { name: "worker_recycle", args: { workerSessionId: workerId, handoffSummary: "hi" } },
  { name: "worker_merge_confirm", args: { workerSessionId: workerId } },
  { name: "merge_batch", args: { workerSessionIds: [workerId] } },
  { name: "worker_set_mode", args: { workerSessionId: workerId, mode: "auto" } },
  { name: "worker_flush", args: { workerSessionId: workerId } },
  { name: "worker_reap", args: { workerSessionId: workerId } },
  { name: "worker_relink", args: { workerSessionId: workerId } },
];

async function assertAllRefuseRetirement(call, workerId, label) {
  for (const { name, args } of TEN_WRITE_TOOLS(workerId)) {
    const result = await call(name, args);
    check(`(${label}) ${name} refuses with the retirement error`,
      typeof result.error === "string" && RETIRED_RE.test(result.error));
  }
}

async function assertNoneRefuseRetirement(call, workerId, label) {
  for (const { name, args } of TEN_WRITE_TOOLS(workerId)) {
    const result = await call(name, args);
    const gotRetired = typeof result.error === "string" && RETIRED_RE.test(result.error);
    check(`(${label}) ${name} does NOT return the retirement error while halted (unsuperseded)`, !gotRetired);
  }
}

try {
  // ======================================================================================
  // PART A — recycle_me window: recycleManager's own fire-and-forget settle
  // ======================================================================================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rfw-a";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId: liveW } = seedLiveWorker(db, P, m1.id); // reparented onto m2 below
    const { fixTaskId } = seedRevivableWorker(db, P, m1.id, "srcA");

    // ---- (pre) sanity: an ordinary, never-recycled manager is NOT refused by the new guard ----
    check("(A pre) m1 is not superseded before recycling", isSupersededByRecycle(db, m1.id) === false);
    let preErr = null;
    try { await sessions.spawnWorker(m1.id, { agentId: "", kickoffPrompt: "x" }); } catch (e) { preErr = e; }
    check("(A pre) a bad-agentId spawnWorker call throws its ORDINARY validation error pre-recycle (not retirement)",
      preErr && /requires an explicit worker agentId/.test(preErr.message) && !RETIRED_RE.test(preErr.message));

    const m2 = await sessions.recycleManager(m1.id, "handoff — recycle_me window");
    check("(A) m1 is now superseded by m2 (hasSuccessor, no halt)", isSupersededByRecycle(db, m1.id) === true);
    check("(A) the live worker was reparented onto m2 during recycleManager", db.getSession(liveW)?.parentSessionId === m2.id);
    check("(A) the predecessor has NOT been hard-stopped yet (still inside the settle window)", !host.stoppedIds.has(m1.id));
    // Baseline AFTER m2's own legitimate spawn — every check below proves a REFUSED call creates no pty.
    const captureBefore = host.capture.length;

    // ---- (1) spawnWorker refuses, names the REAL successor, no side effect ----
    let err1 = null;
    try { await sessions.spawnWorker(m1.id, { agentId: `${P}-mgr`, kickoffPrompt: "x" }); } catch (e) { err1 = e; }
    const m1Match = RETIRED_RE.exec(err1?.message ?? "");
    check("(A1) spawnWorker refuses with the retirement error", !!m1Match);
    check("(A1) the refusal names the REAL live successor id", m1Match?.[1] === m2.id);
    check("(A1) no pty was spawned by the refused call", host.capture.length === captureBefore);

    // ---- (2) the guard runs BEFORE spawnWorker's own downstream validation (order proof) ----
    let err2 = null;
    try { await sessions.spawnWorker(m1.id, { agentId: "", kickoffPrompt: "x" }); } catch (e) { err2 = e; }
    check("(A2) the SAME bad-agentId call now throws the RETIREMENT error post-recycle, not the agentId error",
      RETIRED_RE.test(err2?.message ?? "") && !/requires an explicit worker agentId/.test(err2?.message ?? ""));

    // ---- (3) reviveWorker (direct service call) reuses the SAME chokepoint ----
    let err3 = null;
    try { await sessions.reviveWorker(m1.id, { workerSessionId: "srcA", taskId: fixTaskId }); } catch (e) { err3 = e; }
    check("(A3) reviveWorker throws the SAME retirement error (chokepoint reuse)", RETIRED_RE.test(err3?.message ?? ""));
    check("(A3) no pty was spawned by the refused revive either", host.capture.length === captureBefore);

    // ---- (4) worker_revive refuses AT THE MCP LAYER TOO ----
    const { call: callAsM1 } = await mcpClientFor(db, sessions, host, m1.id);
    const reviveResult = await callAsM1("worker_revive", { workerSessionId: "srcA", taskId: fixTaskId });
    check("(A4) the REGISTERED worker_revive MCP tool refuses with the retirement error",
      typeof reviveResult.error === "string" && RETIRED_RE.test(reviveResult.error));
    check("(A4) still no pty spawned via the MCP-layer call", host.capture.length === captureBefore);

    // ---- (5) a READ tool does not relink the already-correctly-reparented worker back ----
    const statusResult = await callAsM1("worker_status", { workerSessionId: liveW });
    check("(A5) worker_status succeeds (lineage-readable) rather than erroring", statusResult.id === liveW);
    check("(A5) the worker's parentSessionId STAYS m2 — the read did NOT relink it back onto m1",
      db.getSession(liveW)?.parentSessionId === m2.id);

    // ---- (6) ALL 10 write tools refuse outright and also leave parentSessionId untouched ----
    await assertAllRefuseRetirement(callAsM1, liveW, "A6");
    check("(A6) parentSessionId is STILL m2 after exercising all 10 refused write tools", db.getSession(liveW)?.parentSessionId === m2.id);
  }

  // ======================================================================================
  // PART B — recycle_reattempt window: the RESOLVED branch's own fire-and-forget settle
  // ======================================================================================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rfw-b";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId: liveW } = seedLiveWorker(db, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — forcing a halt");
    unstub();
    check("(B setup) the recycle halted (ownership-transfer unresolved)", db.listEventsForSession(m2.id).some((e) => e.kind === "recycle_ownership_transfer_failed"));
    check("(B setup) the live worker still reparented onto m2 even though the halt fired", db.getSession(liveW)?.parentSessionId === m2.id);
    check("(B pre) m1 is NOT superseded while genuinely halted (the carve-out)", isSupersededByRecycle(db, m1.id) === false);

    // ---- Minor 4 (e6c9a84c): the HALTED carve-out — m1 is NOT superseded, but liveW already belongs to
    // m2 (the "workers" step succeeded even though "wakes" halted the retirement). selfHealWorkerLink must
    // not relink it back just because the caller isn't superseded, and nothing here may show the
    // retirement error either (m1 genuinely still owns the rest of its fleet while halted). ----
    {
      const { call: callAsM1Halted } = await mcpClientFor(db, sessions, host, m1.id);
      const statusHalted = await callAsM1Halted("worker_status", { workerSessionId: liveW });
      check("(B-halted) worker_status succeeds (lineage-readable) while genuinely halted", statusHalted.id === liveW);
      check("(B-halted) parentSessionId STAYS m2 — a halted (unsuperseded) predecessor must not relink its successor's worker back",
        db.getSession(liveW)?.parentSessionId === m2.id);

      await assertNoneRefuseRetirement(callAsM1Halted, liveW, "B-halted");
      check("(B-halted) parentSessionId is STILL m2 after exercising all 10 tools while halted",
        db.getSession(liveW)?.parentSessionId === m2.id);

      // spawnWorker must not show the retirement error either while genuinely halted — use the SAME
      // side-effect-free bad-agentId shape as (A pre)/(A2) so this never touches disk/worktrees.
      let errHalted = null;
      try { await sessions.spawnWorker(m1.id, { agentId: "", kickoffPrompt: "x" }); } catch (e) { errHalted = e; }
      check("(B-halted) spawnWorker does NOT throw the retirement error while genuinely halted",
        !RETIRED_RE.test(errHalted?.message ?? "") && /requires an explicit worker agentId/.test(errHalted?.message ?? ""));
    }

    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-b" });
    check("(B pre) m2 reached real ready", host.hasReachedReady(m2.id) === true);

    const captureBefore = host.capture.length;
    const result = await sessions.reattemptManagerOwnershipTransfer(m1.id, "B handoff — ownership is whole now");
    check("(B) reattempt resolved", result.outcome === "resolved" && result.successorId === m2.id);
    check("(B) m1 is now superseded going forward (ordinary retired-predecessor semantics)", isSupersededByRecycle(db, m1.id) === true);
    check("(B) the predecessor has NOT been hard-stopped yet (resolve() returns before settle fires)", !host.stoppedIds.has(m1.id));

    // ---- (1) spawnWorker refuses in THIS window too, naming the real successor ----
    let errB1 = null;
    try { await sessions.spawnWorker(m1.id, { agentId: `${P}-mgr`, kickoffPrompt: "x" }); } catch (e) { errB1 = e; }
    const mB1Match = RETIRED_RE.exec(errB1?.message ?? "");
    check("(B1) spawnWorker refuses with the retirement error in the recycle_reattempt window", !!mB1Match);
    check("(B1) the refusal names the real successor id", mB1Match?.[1] === m2.id);
    check("(B1) no pty was spawned", host.capture.length === captureBefore);

    // ---- (5)/(6) selfHealWorkerLink: read does not relink back, write refuses outright ----
    const { call: callAsM1 } = await mcpClientFor(db, sessions, host, m1.id);
    const statusResult = await callAsM1("worker_status", { workerSessionId: liveW });
    check("(B5) worker_status succeeds (lineage-readable)", statusResult.id === liveW);
    check("(B5) parentSessionId STAYS m2 after the read in this window too", db.getSession(liveW)?.parentSessionId === m2.id);

    await assertAllRefuseRetirement(callAsM1, liveW, "B6");
    check("(B6) parentSessionId is still m2 after exercising all 10 refused write tools", db.getSession(liveW)?.parentSessionId === m2.id);
  }
} finally {
  // best-effort cleanup — a leaked temp LOOM_HOME under os.tmpdir() is harmless but tidy up anyway.
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — spawnWorker/reviveWorker and all 10 selfHealWorkerLink write tools refuse a manager superseded by its own recycle successor, in BOTH the recycle_me and recycle_reattempt windows, naming the real successor; a read tool never relinks a correctly-reparented worker back; and a genuinely HALTED (unsuperseded) predecessor is neither refused nor allowed to relink a worker already owned by its successor."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
