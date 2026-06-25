// Deterministic coalesce-drain test for PtyHost (drainPending splice-all in pty/host.ts).
//
// Regression guard for the worker-redirect fix (card 3e8c9cea): drainPending must deliver the ENTIRE
// pending FIFO as ONE concatenated, framed turn — NOT one-per-Stop. Before the fix, drainPending
// shift()'d a SINGLE entry then submit()'d, and submit() re-arms busy SYNCHRONOUSLY (M1), so the rest
// couldn't drain until the NEXT Stop hook. That asymmetry (a worker had no consumePending equivalent)
// let 3 superseding manager redirects replay one-at-a-time. This test pins the coalesce:
//   - 3 messages queued while busy → ONE Stop hook → ALL THREE drain as ONE submit;
//   - exactly ONE busy re-arm and exactly ONE Enter (`\r`) written (one turn, not three);
//   - every entry's onDeliver fires (every durable session_message_queued record resolves);
//   - FIFO order preserved in the single concatenated turn, joined by a visible separator.
//
// Exercises the real PtyHost state machine (submit/enqueueStdin/deliverHook/drainPending) against a
// FAKE pty injected via the createPty() seam — NO real claude, no daemon, no network. Sibling to
// pty-busy-drain.mjs (M1/M2) and pty-stop-queue.mjs (sticky-stop).
//
// RUN (no daemon needed): node test/pty-coalesce-drain.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set BEFORE
// importing host.js — paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-coalesce-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");

// A fake IPty: records every write; onData/onExit are inert (the busy/drain machine never depends on
// them). The `\r` (Enter) and the bracketed-paste end land via setTimeout in submit(), so the test
// waits a beat before asserting on them.
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

class TestPtyHost extends PtyHost {
  createPty() { return makeFakePty(); }
}

const busyLog = [];
const events = {
  onEngineSessionId() {},
  onBusy(_id, busy) { busyLog.push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
};

const host = new TestPtyHost(events);
const SID = "sess-coalesce";
const PRIMER = "PRIMER_TURN";
const MSG1 = "[loom:from-manager]\nREDIRECT_ONE", MSG2 = "[loom:from-manager]\nREDIRECT_TWO", MSG3 = "[loom:from-manager]\nREDIRECT_THREE";
const SEP = "────────"; // the visible coalesce separator (host.ts DRAIN_SEPARATOR)
const ENTER = "\r";
const PASTE_START = "\x1b[200~";

host.spawn({
  sessionId: SID, cwd: tmpHome,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
const fake = fakes[0];
check("spawn used the injected fake pty (no real claude)", !!fake && host.isAlive(SID) === true);

const written = () => fake.writes.join("");
const countOf = (m) => written().split(m).length - 1;
const lastBusy = () => busyLog[busyLog.length - 1];

// SessionStart → ready (startupModeCycles:0 marks ready synchronously).
host.deliverHook(SID, { hook_event_name: "SessionStart" });

try {
  // A turn in flight, so the messages we enqueue next are HELD (busy) rather than submitted immediately.
  const rp = host.enqueueStdin(SID, PRIMER);
  check("setup: PRIMER delivered immediately (turn in flight), busy armed", rp.delivered === true && lastBusy() === true);
  // Let the PRIMER's async paste-end + Enter flush, so the post-Stop `\r` assertion measures only the drain.
  await sleep(250);

  // Three durable-tracked messages queued while busy — each carries an onDeliver callback (the
  // session_message_queued resolution the real durable-message path attaches).
  const delivered = [];
  const r1 = host.enqueueStdin(SID, MSG1, "system", () => delivered.push(1));
  const r2 = host.enqueueStdin(SID, MSG2, "system", () => delivered.push(2));
  const r3 = host.enqueueStdin(SID, MSG3, "system", () => delivered.push(3));
  check("setup: all three messages QUEUED behind busy (positions 1,2,3)",
    r1.delivered === false && r1.position === 1 && r2.position === 2 && r3.position === 3);
  check("setup: pending FIFO is [MSG1, MSG2, MSG3]",
    JSON.stringify(host.getPending(SID)) === JSON.stringify([MSG1, MSG2, MSG3]));
  check("setup: nothing drained yet (no onDeliver fired)", delivered.length === 0);

  // Snapshot the write/busy state right before the single Stop hook.
  const pasteBefore = countOf(PASTE_START);
  const crBefore = countOf(ENTER);
  const busyLenBefore = busyLog.length;

  // ===================== THE COALESCE: one Stop drains ALL THREE as ONE turn =====================
  host.deliverHook(SID, { hook_event_name: "Stop" });

  // Synchronous assertions (the splice + concat + submit happen in the Stop's same tick).
  check("COALESCE: exactly ONE submit — a single bracketed paste added (not three)",
    countOf(PASTE_START) - pasteBefore === 1);
  check("COALESCE: queue fully drained in one shot (pending empty)", host.getPending(SID).length === 0);
  check("COALESCE: all THREE onDeliver callbacks fired", JSON.stringify(delivered) === JSON.stringify([1, 2, 3]));
  // Exactly ONE busy re-arm: the Stop lowered busy (false) then the single coalesced submit re-armed it (true).
  check("COALESCE: busy fell (false) then ONE drain re-armed it (true) — a single re-arm",
    busyLog.slice(busyLenBefore).join(",") === "false,true" && lastBusy() === true);

  // FIFO order preserved in the single concatenated turn, separated by the visible rule.
  const turn = written();
  const i1 = turn.indexOf("REDIRECT_ONE"), i2 = turn.indexOf("REDIRECT_TWO"), i3 = turn.indexOf("REDIRECT_THREE");
  check("COALESCE: all three message bodies present in the one turn", i1 >= 0 && i2 >= 0 && i3 >= 0);
  check("COALESCE: FIFO order preserved (MSG1 < MSG2 < MSG3 in the concatenated text)", i1 < i2 && i2 < i3);
  check("COALESCE: a visible separator joins them (two separators for three messages)", countOf(SEP) === 2);

  // The Enter lands a beat later (setTimeout in submit) — wait, then assert exactly ONE `\r` for the drain.
  await sleep(250);
  check("COALESCE: exactly ONE Enter (`\\r`) written for the whole drain (one turn, not three)",
    countOf(ENTER) - crBefore === 1);
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — drainPending coalesces the WHOLE FIFO into ONE turn (one submit, one re-arm, one Enter; all onDeliver fire; FIFO order kept)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
