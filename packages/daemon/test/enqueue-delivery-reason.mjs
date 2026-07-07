// Regression guard for `enqueueStdin`'s `reason` field (dead-drop vs held), which distinguishes its
// two `delivered:false` outcomes — previously indistinguishable at a glance, so a manager reading
// `worker_message`'s result could conflate "dropped" (the worker is gone, nothing will ever deliver
// this) with "queued" (the worker is busy, it WILL land at its next turn boundary).
//
// Exercises the real PtyHost against a FAKE pty injected via the createPty() seam — NO real claude,
// no daemon, no network. Fully in-process and hermetic (mirrors pty-busy-drain.mjs).
//
// RUN (after a build): node test/enqueue-delivery-reason.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-enqreason-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");

function makeFakePty() {
  return {
    pid: 4242,
    write: () => {},
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill: () => {},
    resize: () => {},
  };
}

class TestPtyHost extends PtyHost {
  createPty() { return makeFakePty(); }
}

const events = {
  onEngineSessionId() {},
  onBusy() {},
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
};

const host = new TestPtyHost(events);

try {
  // ===== dead/unknown session: never spawned → the host has no live entry at all =====
  const deadResult = host.enqueueStdin("no-such-session", "hello");
  check("dead session: delivered:false", deadResult.delivered === false);
  check("dead session: reason is session-dead (dropped, not queued)", deadResult.reason === "session-dead");
  check("dead session: no position (never queued)", deadResult.position === undefined);

  // ===== live + busy session: the message is HELD FIFO, will deliver later =====
  const SID = "sess-busy";
  host.spawn({
    sessionId: SID,
    cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 },
    sessionEnv: {},
  });
  host.deliverHook(SID, { hook_event_name: "SessionStart" });

  const primer = host.enqueueStdin(SID, "PRIMER"); // submits immediately, arms busy
  check("primer: delivered immediately on an idle session", primer.delivered === true);

  const busyResult = host.enqueueStdin(SID, "QUEUED_MSG");
  check("busy session: delivered:false (held, not dropped)", busyResult.delivered === false);
  check("busy session: reason is held", busyResult.reason === "held");
  check("busy session: position is 1", busyResult.position === 1);

  // ===== live + idle session: delivered immediately, unchanged shape =====
  host.deliverHook(SID, { hook_event_name: "Stop" }); // drains QUEUED_MSG, re-arms busy
  host.deliverHook(SID, { hook_event_name: "Stop" }); // second Stop on an empty queue → idle

  const idleResult = host.enqueueStdin(SID, "IDLE_MSG");
  check("idle session: delivered:true", idleResult.delivered === true);
  check("idle session: no reason on a successful delivery", idleResult.reason === undefined);
  check("idle session: no position on a successful delivery", idleResult.position === undefined);
} finally {
  try { host.stop("sess-busy", "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — enqueueStdin's delivered:false carries a distinct reason (session-dead vs held); delivered:true is unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
