// Deterministic busy-gate / drain-ordering test for PtyHost (M1 + M2 invariants in pty/host.ts).
//
// This is the CLAUDE-FREE regression guard for the two concurrency invariants that previously had
// only LIVE (real-claude) coverage (messaging.mjs / usage-limit-resume.mjs):
//   M1 — submit() arms busy=true SYNCHRONOUSLY (the optimistic set), so a concurrent enqueueStdin
//        QUEUES rather than racing the still-pending Enter.
//   M2 — on Stop, busy is lowered and the FIFO is drained in the SAME synchronous tick (no await
//        between them), so exactly ONE queued message drains per Stop, in FIFO order, with no
//        interleave of a concurrently-enqueued turn.
//
// It exercises the real PtyHost state machine (submit/enqueueStdin/deliverHook/drainPending) against
// a FAKE pty injected via the createPty() seam — NO real claude, NO ~/.claude.json trust writes, no
// daemon, no network. Fully in-process and hermetic.
//
// RUN (no daemon needed): node test/pty-busy-drain.mjs
//   Requires the daemon to be built first (reads ../dist/pty/host.js): from packages/daemon, run
//   `pnpm build` (or `npm run build`) then `node test/pty-busy-drain.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME: host.ts opens a per-session log under LOGS_DIR (= $LOOM_HOME/logs) in
// spawn(). Point it at a throwaway temp dir BEFORE importing host.js (paths.ts reads LOOM_HOME at
// import time), and create the logs dir so createWriteStream succeeds. ---
const tmpHome = path.join(os.tmpdir(), `loom-ptytest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");

// --- A fake IPty: records every write; onData/onExit are inert. host.ts only uses pid/write/
// onData/onExit/kill, and never depends on onData/onExit firing for the busy/drain machine. ---
const fakes = [];
function makeFakePty() {
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
  fakes.push(fake);
  return fake;
}

// Subclass overrides the ONE seam (createPty) → no real spawn, no FS/trust side effects.
class TestPtyHost extends PtyHost {
  createPty() { return makeFakePty(); }
}

// Recording events sink: capture the busy transition log (mirrors the daemon's onBusy persistence).
const busyLog = [];
const events = {
  onEngineSessionId() {},
  onBusy(_id, busy) { busyLog.push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
};

const host = new TestPtyHost(events);
const SID = "sess-test";
const ALPHA = "ALPHA_MSG", BETA = "BETA_MSG", GAMMA = "GAMMA_MSG", DELTA = "DELTA_MSG";

// Spawn WITHOUT a startup prompt → busy starts false, no optimistic set yet (clean slate to drive).
host.spawn({
  sessionId: SID,
  cwd: tmpHome,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 },
  sessionEnv: {},
});
const fake = fakes[0];
check("spawn used the injected fake pty (no real claude)", !!fake && host.isAlive(SID) === true);

// Concatenated record of everything written to the pty, and an occurrence counter for a marker.
const written = () => fake.writes.join("");
const countOf = (marker) => written().split(marker).length - 1;
const lastBusy = () => busyLog[busyLog.length - 1];

// A (re)spawned session is NOT ready until SessionStart (the boot-readiness gate that fixes the
// resume-injection race; the ready-gate itself is covered in pty-resume-readiness.mjs). With
// startupModeCycles:0, SessionStart marks ready synchronously — drive it so the M1/M2 immediate-submit
// assertions below hold.
host.deliverHook(SID, { hook_event_name: "SessionStart" });

try {
  // ===================== M1 — optimistic, synchronous busy =====================
  // First enqueue on an idle session submits IMMEDIATELY. Crucially, submit() must arm busy
  // SYNCHRONOUSLY before returning — we assert that by checking the very next enqueue QUEUES.
  const r1 = host.enqueueStdin(SID, ALPHA);
  check("M1: first enqueue on idle session delivered immediately", r1.delivered === true && r1.position === undefined);
  // The optimistic busy set is synchronous → onBusy(true) already recorded, with NO event-loop turn
  // having run between submit() and this line.
  check("M1: submit() armed busy=true SYNCHRONOUSLY (onBusy(true) recorded before any yield)", lastBusy() === true);

  // A concurrent enqueue (next call) now sees busy=true and QUEUES rather than racing ALPHA's
  // pending Enter — this is the whole point of the optimistic set.
  const r2 = host.enqueueStdin(SID, BETA);
  check("M1: concurrent enqueue QUEUES behind the synchronous busy (position 1, not delivered)", r2.delivered === false && r2.position === 1);
  check("M1: BETA was queued, NOT written to the pty", countOf(BETA) === 0);
  check("M1: ALPHA WAS written (the immediate submit)", countOf(ALPHA) === 1);
  check("M1: pending FIFO holds exactly [BETA]", JSON.stringify(host.getPending(SID)) === JSON.stringify([BETA]));

  // ===================== M2 — drain ordering: FIFO, one-per-Stop, no interleave =====================
  // Enqueue two more while still busy — they must stack FIFO behind BETA.
  const r3 = host.enqueueStdin(SID, GAMMA);
  const r4 = host.enqueueStdin(SID, DELTA);
  check("M2: GAMMA queued at position 2", r3.delivered === false && r3.position === 2);
  check("M2: DELTA queued at position 3", r4.delivered === false && r4.position === 3);
  check("M2: pending FIFO is [BETA, GAMMA, DELTA]", JSON.stringify(host.getPending(SID)) === JSON.stringify([BETA, GAMMA, DELTA]));

  const busyLenBeforeStop = busyLog.length;
  // First Stop: lowers busy then (same tick) drains exactly ONE — the FIFO head BETA — re-arming busy.
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("M2: Stop drained exactly ONE — BETA written once", countOf(BETA) === 1);
  check("M2: Stop did NOT also drain GAMMA/DELTA (no interleave)", countOf(GAMMA) === 0 && countOf(DELTA) === 0);
  check("M2: pending advanced to [GAMMA, DELTA]", JSON.stringify(host.getPending(SID)) === JSON.stringify([GAMMA, DELTA]));
  // The drain happened in the same tick as lowering busy → the transition log shows false THEN true,
  // and busy is re-armed (true) so the next enqueue would queue again, not race.
  check("M2: busy fell (false) then the drain re-armed it (true), in order", busyLog.slice(busyLenBeforeStop).join(",") === "false,true" && lastBusy() === true);

  // Second Stop: drains GAMMA (FIFO preserved).
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("M2: second Stop drained GAMMA (FIFO order held)", countOf(GAMMA) === 1 && countOf(DELTA) === 0);
  check("M2: pending advanced to [DELTA]", JSON.stringify(host.getPending(SID)) === JSON.stringify([DELTA]));

  // Third Stop: drains DELTA — queue now empty, busy re-armed for the in-flight DELTA turn.
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("M2: third Stop drained DELTA — queue empty", countOf(DELTA) === 1 && host.getPending(SID).length === 0);
  check("M2: busy re-armed for the drained DELTA turn", lastBusy() === true);

  // Fourth Stop on an empty queue: lowers busy and writes nothing more (no phantom drain).
  const writesBeforeIdleStop = fake.writes.length;
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("M2: Stop on an empty queue lowers busy and stays idle", lastBusy() === false);
  check("M2: Stop on an empty queue writes nothing more (no phantom drain)", fake.writes.length === writesBeforeIdleStop);

  // ===================== sanity: each turn went out as a distinct bracketed paste =====================
  // Four turns submitted total (ALPHA, BETA, GAMMA, DELTA) → four paste-start markers.
  const PASTE_START = "\x1b[200~";
  check("Sanity: exactly four turns submitted as bracketed pastes (no dropped/duplicated turn)", countOf(PASTE_START) === 4);
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — M1 (synchronous optimistic busy) + M2 (FIFO one-per-Stop drain, no interleave) hold, claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
