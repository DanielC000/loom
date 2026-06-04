// inbox_pull — the manager's pull-its-own-inbox path (task 56033796). The late-`[loom:worker-report]`
// symptom was NOT duplicate delivery: the manager read each report proactively (worker_transcript)
// while the single busy-gated queued copy sat in live.pending (delivered:false) and later drained
// one-per-turn-boundary as a wasted turn. The fix gives the manager a way to CONSUME its own inbox.
//
// HERMETIC, claude-free. Three layers, no daemon / no real claude / no network:
//   (H) HOST  — PtyHost.consumePending: returns the queued FIFO AND clears it; a still-queued report
//               for a LIVE worker is returned (we never silently drop it); pulled messages do NOT
//               re-drain on a later Stop; an empty/unknown inbox returns [].
//   (S) SVC   — SessionService.pullManagerInbox: manager-gated wrapper that consumes the manager's
//               OWN queue and rejects a non-manager / unknown session.
//   (T) TOOL  — inbox_pull is registered MANAGER-only, never on the worker surface (the depth-1 gate).
//
// RUN (no daemon needed; build first): from packages/daemon → `pnpm build` then
//   node test/inbox-pull.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set it
// BEFORE importing host.js (paths.ts reads LOOM_HOME at import time) and create the logs dir. ---
const tmpHome = path.join(os.tmpdir(), `loom-inbox-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

// ============================ (H) HOST: PtyHost.consumePending ============================
{
  const { PtyHost } = await import("../dist/pty/host.js");

  // A fake IPty that records writes; onData/onExit are inert (host.ts never depends on them for the
  // busy/drain machine). Mirrors pty-busy-drain.mjs.
  const fakes = [];
  function makeFakePty() {
    const writes = [];
    const fake = { pid: 4242, write: (d) => { writes.push(d); }, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes };
    fakes.push(fake);
    return fake;
  }
  class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
  const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

  const host = new TestPtyHost(events);
  const SID = "mgr-sess";
  host.spawn({
    sessionId: SID, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake = fakes[0];
  const written = () => fake.writes.join("");
  const countOf = (m) => written().split(m).length - 1;
  const PASTE_START = "\x1b[200~";

  try {
    // Empty inbox → [].
    check("(H) consumePending on an empty inbox returns []", JSON.stringify(host.consumePending(SID)) === "[]");
    // Unknown session → [] (no throw).
    check("(H) consumePending on an unknown session returns []", JSON.stringify(host.consumePending("nope")) === "[]");

    // Mark ready, then take the session BUSY so subsequent enqueues queue instead of submitting —
    // exactly the busy-gated path a worker report hits when the manager is mid-turn.
    host.deliverHook(SID, { hook_event_name: "SessionStart" });
    host.enqueueStdin(SID, "FIRST_TURN");                 // idle → submits immediately, arms busy=true
    check("(H) precondition: the manager is now busy (a turn is in flight)", host.getPending(SID).length === 0);

    // Three inbound messages arrive while busy → they queue FIFO (delivered:false). One is a report
    // for a still-LIVE worker — it MUST come back from a pull (we never silently drop a live worker's report).
    const REPORT_LIVE = "[loom:worker-report] worker W-LIVE (task T1) — done: did the thing";
    const NUDGE = "[loom:worker-idle] worker W2 (task T2) finished a turn and is idle";
    const REPORT_DONE = "[loom:worker-report] worker W-DONE (task T3) — done: already merged";
    const q1 = host.enqueueStdin(SID, REPORT_LIVE);
    const q2 = host.enqueueStdin(SID, NUDGE);
    const q3 = host.enqueueStdin(SID, REPORT_DONE);
    check("(H) the three inbound messages queued busy-gated (delivered:false)",
      q1.delivered === false && q2.delivered === false && q3.delivered === false);
    check("(H) getPending shows the FIFO [REPORT_LIVE, NUDGE, REPORT_DONE]",
      JSON.stringify(host.getPending(SID)) === JSON.stringify([REPORT_LIVE, NUDGE, REPORT_DONE]));

    const writesBeforePull = fake.writes.length;
    // PULL: returns the whole inbox in FIFO order AND clears the queue. consumePending must NOT write
    // anything to the pty (it removes; it never submits) — so no new bytes and busy is untouched.
    const pulled = host.consumePending(SID);
    check("(H) pull returns the full inbox in FIFO order",
      JSON.stringify(pulled) === JSON.stringify([REPORT_LIVE, NUDGE, REPORT_DONE]));
    check("(H) pull INCLUDES the still-live worker's report (never silently dropped)", pulled.includes(REPORT_LIVE));
    check("(H) pull CLEARED the queue (getPending now empty)", host.getPending(SID).length === 0);
    check("(H) pull wrote NOTHING to the pty (consume removes, never submits)", fake.writes.length === writesBeforePull);

    // The whole point: a Stop AFTER pulling must NOT re-inject any of the pulled messages — they're
    // gone from the same live.pending, so the next turn boundary drains nothing.
    host.deliverHook(SID, { hook_event_name: "Stop" }); // lowers busy; queue empty → no drain
    check("(H) Stop after pull re-drains NOTHING (no wasted turn for a pulled message)",
      countOf(REPORT_LIVE) === 0 && countOf(NUDGE) === 0 && countOf(REPORT_DONE) === 0);

    // Sanity: only the original FIRST_TURN was ever submitted as a turn — pulling didn't manufacture one.
    check("(H) sanity: exactly ONE turn was ever submitted (the pre-pull FIRST_TURN)", countOf(PASTE_START) === 1);

    // Contrast control: WITHOUT a pull, a queued message still drains one-per-Stop (safety net intact).
    host.enqueueStdin(SID, "AGAIN_TURN"); // idle now → submits, busy=true
    host.enqueueStdin(SID, "QUEUED_NO_PULL"); // queues behind it
    host.deliverHook(SID, { hook_event_name: "Stop" }); // drains the one queued message
    check("(H) safety net intact: an un-pulled queued message STILL drains on the next Stop",
      countOf("QUEUED_NO_PULL") === 1 && host.getPending(SID).length === 0);
  } finally {
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
}

// ============================ (S) SVC: SessionService.pullManagerInbox ============================
{
  const { Db } = await import("../dist/db.js");
  const { SessionService } = await import("../dist/sessions/service.js");

  const dbFile = path.join(tmpHome, `svc-${Date.now()}.db`);
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });
  const mkSession = (id, role) => db.insertSession({
    id, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role,
  });
  mkSession("mgr", "manager");
  mkSession("wkr", "worker");

  // A stub pty: pullManagerInbox touches ONLY pty.consumePending — record which id it was asked to
  // consume and hand back a canned inbox, so we can assert the wrapper consumes the manager's OWN id.
  let consumedId = null;
  const stubPty = { consumePending: (id) => { consumedId = id; return ["[loom:worker-report] worker W (task T) — done: x", "[loom:worker-idle] ..."]; } };
  const svc = new SessionService(db, stubPty, /* control */ {});

  const r = svc.pullManagerInbox("mgr");
  check("(S) pullManagerInbox consumes the MANAGER's OWN session id", consumedId === "mgr");
  check("(S) pullManagerInbox returns {messages} from the pty queue",
    Array.isArray(r.messages) && r.messages.length === 2 && r.messages[0].startsWith("[loom:worker-report]"));

  let threwWorker = false, threwUnknown = false;
  try { svc.pullManagerInbox("wkr"); } catch { threwWorker = true; }
  try { svc.pullManagerInbox("ghost"); } catch { threwUnknown = true; }
  check("(S) pullManagerInbox REJECTS a non-manager (worker) session", threwWorker);
  check("(S) pullManagerInbox REJECTS an unknown session", threwUnknown);

  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ (T) TOOL SURFACE: registration seam ============================
{
  const { Db } = await import("../dist/db.js");
  const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

  const dbFile = path.join(tmpHome, `surface-${Date.now()}.db`);
  const db = new Db(dbFile);
  const router = new OrchestrationMcpRouter(db, {}); // sessions refs are only captured into callbacks, never invoked here
  const toolNames = (role) => Object.keys(router.buildServer("sid", role)._registeredTools);

  const managerTools = toolNames("manager");
  const workerTools = toolNames("worker");
  check("(T) inbox_pull IS registered on the MANAGER surface", managerTools.includes("inbox_pull"));
  check("(T) inbox_pull is NOT on the worker surface", !workerTools.includes("inbox_pull"));
  check("(T) the worker surface is still exactly { worker_report } (depth-1 gate held)",
    workerTools.length === 1 && workerTools[0] === "worker_report");

  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — consumePending returns+clears the inbox FIFO (live-worker report included, never dropped), pulled messages don't re-drain, the un-pulled safety-net drain still works; pullManagerInbox is manager-gated; inbox_pull is registered MANAGER-only."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
