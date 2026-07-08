// end_me safety-gate test (card 3b015fc7) — the no-successor sibling of recycle_me. In-process: drives
// SessionService.endMe() against the REAL PtyHost state machine (a fake IPty injected via the
// createPty() seam, mirroring pty-coalesce-drain.mjs / pty-stop-queue.mjs) — NO real claude, no daemon,
// no network. Exercising the real PtyHost (not a hand-rolled stub) is deliberate: it's the only way to
// prove the kind:"agent" vs kind:"warning" queue classification actually gates end_me, not just an
// assumption about it.
//
// Proves all four DoD cases:
//   (PASS)     empty queue, no live workers → {stopped:true}; an `end_me_complete` event is recorded;
//              the pty's graceful-stop Ctrl-C is DEFERRED (not written before the tool call returns —
//              the "reply flushes before teardown" contract) but does land ~3s later.
//   (QUEUED)   an unconsumed kind:"agent" message is queued → {stopped:false, reason:"queued-inbound",
//              pending:N}; an `end_me_refused` event is recorded; the pty is NOT stopped.
//   (WORKERS)  a manager with ≥1 LIVE worker row → {stopped:false, reason:"live-workers", count:N}; an
//              `end_me_refused` event is recorded.
//   (WARNING)  a queued kind:"warning" nudge (idle/context/usage watchdog shape — the enqueueStdin
//              default kind) does NOT block — {stopped:true}, same as the empty-queue case.
//
// Run: 1) build daemon (pnpm build), 2) node test/end-me.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = path.join(os.tmpdir(), `loom-endme-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PtyHost } = await import("../dist/pty/host.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = new Date().toISOString();

// A fake IPty: records every write; onExit/kill are inert (endMe's assertions only need the WRITE side —
// whether/when the Ctrl-C interrupt landed — not a real process exit).
const fakes = new Map();
function makeFakePty(sessionId) {
  const writes = [];
  const fake = {
    pid: 4242,
    write: (d) => { writes.push(d); },
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill: () => {},
    resize: () => {},
    writes,
  };
  fakes.set(sessionId, fake);
  return fake;
}

class TestPtyHost extends PtyHost {
  createPty(opts) { return makeFakePty(opts.sessionId); }
}

const events = {
  onEngineSessionId() {},
  onBusy() {},
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
};

const host = new TestPtyHost(events);
const db = new Db();
const sessions = new SessionService(db, host, new OrchestrationControl());

const ETX = "\x03"; // Ctrl-C
const countCtrlC = (sid) => fakes.get(sid).writes.join("").split(ETX).length - 1;

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `endme-proj-${sfx}`, agentId = `endme-ag-${sfx}`;
db.insertProject({ id: projId, name: "EndMe", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });

function spawnManager(tag) {
  const id = `endme-${tag}-${sfx}`;
  db.insertSession({ id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  host.spawn({
    sessionId: id, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(id, { hook_event_name: "SessionStart" }); // → ready
  return id;
}

// Arms `busy` on the given session (a turn "in flight") so a SECOND enqueueStdin lands in the queue
// instead of delivering immediately — mirrors pty-coalesce-drain.mjs's PRIMER pattern.
function armBusy(id) {
  const r = host.enqueueStdin(id, "PRIMER_TURN");
  if (!r.delivered) throw new Error(`armBusy: PRIMER was not delivered immediately for ${id}`);
}

try {
  // ── (PASS) empty queue, no live workers → stopped, deferred graceful stop ─────────────────────────
  const PASS_ID = spawnManager("pass");
  const rPass = sessions.endMe(PASS_ID);
  check("(pass) endMe → {stopped:true}, no reason", rPass.stopped === true && rPass.reason === undefined);
  check("(pass) an end_me_complete event is recorded", db.listEvents(PASS_ID).some((e) => e.kind === "end_me_complete"));
  check("(pass) the graceful Ctrl-C has NOT landed yet (deferred — reply flushes before teardown)", countCtrlC(PASS_ID) === 0);
  await sleep(3200);
  check("(pass) the graceful Ctrl-C DOES land ~3s later", countCtrlC(PASS_ID) >= 1);

  // ── (QUEUED) an unconsumed kind:"agent" message queued → refused ──────────────────────────────────
  const QUEUED_ID = spawnManager("queued");
  armBusy(QUEUED_ID);
  const enq = host.enqueueStdin(QUEUED_ID, "[loom:from-manager]\nredirect", "system", undefined, undefined, "agent");
  check("(queued) setup: the agent-kind message QUEUED (not delivered)", enq.delivered === false);
  const rQueued = sessions.endMe(QUEUED_ID);
  check("(queued) endMe → {stopped:false, reason:\"queued-inbound\", pending:1}", rQueued.stopped === false && rQueued.reason === "queued-inbound" && rQueued.pending === 1);
  check("(queued) a message is returned telling the agent to drain + re-call", typeof rQueued.message === "string" && /re-call end_me/i.test(rQueued.message));
  check("(queued) an end_me_refused(reason:queued-inbound) event is recorded",
    db.listEvents(QUEUED_ID).some((e) => e.kind === "end_me_refused" && e.detail?.reason === "queued-inbound" && e.detail?.pending === 1));
  await sleep(200);
  check("(queued) the pty is NOT stopped — no Ctrl-C written", countCtrlC(QUEUED_ID) === 0);

  // ── (WORKERS) a manager with ≥1 LIVE worker → refused ──────────────────────────────────────────────
  const WORKERS_ID = spawnManager("workers");
  const workerId = `endme-workers-child-${sfx}`;
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: WORKERS_ID });
  const rWorkers = sessions.endMe(WORKERS_ID);
  check("(workers) endMe → {stopped:false, reason:\"live-workers\", count:1}", rWorkers.stopped === false && rWorkers.reason === "live-workers" && rWorkers.count === 1);
  check("(workers) an end_me_refused(reason:live-workers) event is recorded",
    db.listEvents(WORKERS_ID).some((e) => e.kind === "end_me_refused" && e.detail?.reason === "live-workers" && e.detail?.count === 1));
  await sleep(200);
  check("(workers) the pty is NOT stopped — no Ctrl-C written", countCtrlC(WORKERS_ID) === 0);
  // A worker whose process has since exited no longer counts — the gate re-derives liveness each call.
  db.setProcessState(workerId, "exited");
  const rWorkersAfterExit = sessions.endMe(WORKERS_ID);
  check("(workers) once the child exits, endMe passes", rWorkersAfterExit.stopped === true);

  // ── (WARNING) a queued kind:"warning" nudge does NOT block ─────────────────────────────────────────
  const WARN_ID = spawnManager("warn");
  armBusy(WARN_ID);
  const enqWarn = host.enqueueStdin(WARN_ID, "[loom:idle] you've been idle a while"); // default kind: "warning"
  check("(warning) setup: the warning-kind nudge QUEUED (not delivered)", enqWarn.delivered === false);
  const rWarn = sessions.endMe(WARN_ID);
  check("(warning) endMe → {stopped:true} — a warning-kind nudge does not gate", rWarn.stopped === true && rWarn.reason === undefined);
  check("(warning) an end_me_complete event is recorded", db.listEvents(WARN_ID).some((e) => e.kind === "end_me_complete"));
} finally {
  db.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — end_me: empty-queue+no-live-workers stops (deferred graceful Ctrl-C, reply flushes first); an unconsumed AGENT-kind queued message refuses (reason:queued-inbound); a manager with a live worker refuses (reason:live-workers) and re-passes once the worker exits; a queued WARNING-kind nudge does not block."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
