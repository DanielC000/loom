// Deterministic park-vs-reconcile-drain test for PtyHost (the §19c rate-limit park guard in pty/host.ts).
//
// Regression guard for the subtle resume-correctness bug: a usage-cap-killed turn PARKS the session
// (pty alive, lastPrompt = the killed turn, pending held intact for the post-resume replay). The park
// branch only skips the SYNCHRONOUS Stop drain — but the ~10s reconcile timer (and any incoming
// enqueueStdin) would still see busy=false and drain pending into the still-capped account, and submit()
// would OVERWRITE lastPrompt → the agent would resume with the WRONG content and never finish the
// interrupted turn. The fix: a per-session `rateLimited` flag (mirror of `stopping`) that SUPPRESSES
// drain/submit while parked, checked in drainPending AND enqueueStdin's idle-submit path, cleared on
// resumeAfterRateLimit. This test pins:
//   - a StopFailure rate_limit hook PARKS: busy falls, onRateLimited fires, pending is NOT drained;
//   - reconcile() (the timer body) is a NO-OP while parked — pending intact, no new submit, lastPrompt
//     un-clobbered (proven by the resume below re-submitting the ORIGINAL killed turn, not the queue);
//   - a message enqueued WHILE parked is HELD (never submitted into the capped account);
//   - resumeAfterRateLimit re-submits the ORIGINAL killed turn (lastPrompt survived), then the held
//     queue drains normally on the post-resume Stop.
//
// Exercises the real PtyHost state machine (submit/enqueueStdin/deliverHook/drainPending/reconcile/
// resumeAfterRateLimit) against a FAKE pty injected via the createPty() seam — NO real claude, no daemon,
// no network. Sibling to pty-coalesce-drain.mjs (coalesce) and rate-limit-cascade.mjs (the gateway path).
//
// RUN (no daemon needed): node test/pty-rate-limit-park-drain.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set BEFORE
// importing host.js — paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-rlpark-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");

// A fake IPty: records every write. The `\r` (Enter) + bracketed-paste end land via setTimeout in
// submit(), so the message BODY + paste-start are synchronous but the Enter assertion waits a beat.
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
const rateLimitedLog = [];
const events = {
  onEngineSessionId() {},
  onBusy(_id, busy) { busyLog.push(busy); },
  onContextStats() {},
  onRateLimited(id, until, detail) { rateLimitedLog.push({ id, until, detail }); },
  onExit() {},
};

const host = new TestPtyHost(events);
const SID = "sess-rlpark";
const KILLED = "INTERRUPTED_TURN"; // the turn the cap kills — must replay verbatim on resume
const MSG1 = "[loom:from-manager]\nQUEUED_ONE", MSG2 = "[loom:from-manager]\nQUEUED_TWO";
const PARKED_MSG = "[loom:from-manager]\nSENT_WHILE_PARKED"; // arrives during the park — must be HELD
const PASTE_START = "\x1b[200~";
const ENTER = "\r";

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
  // ── A turn in flight (the one the cap will kill): submitted immediately, lastPrompt := KILLED. ──
  const rp = host.enqueueStdin(SID, KILLED);
  check("setup: the to-be-killed turn submitted immediately (busy armed)", rp.delivered === true && lastBusy() === true);
  await sleep(120); // let the async paste-end + Enter flush so later assertions measure only new work

  // Two manager messages queued behind the busy turn — held intact for the post-resume drain.
  const r1 = host.enqueueStdin(SID, MSG1, "system");
  const r2 = host.enqueueStdin(SID, MSG2, "system");
  check("setup: both messages QUEUED behind the busy turn (positions 1,2)",
    r1.delivered === false && r1.position === 1 && r2.delivered === false && r2.position === 2);
  check("setup: pending FIFO is [MSG1, MSG2]",
    JSON.stringify(host.getPending(SID)) === JSON.stringify([MSG1, MSG2]));

  const pasteAfterSetup = countOf(PASTE_START); // baseline: KILLED's single submit

  // ═══════════════ THE PARK: a StopFailure rate_limit hook parks the session ═══════════════
  host.deliverHook(SID, { hook_event_name: "StopFailure", error: "rate_limit" });

  check("PARK: onRateLimited fired exactly once for this session", rateLimitedLog.length === 1 && rateLimitedLog[0].id === SID);
  check("PARK: busy fell to false (the killed turn ended)", lastBusy() === false);
  check("PARK: the held queue was NOT drained (pending still [MSG1, MSG2])",
    JSON.stringify(host.getPending(SID)) === JSON.stringify([MSG1, MSG2]));
  check("PARK: no new submit on the park (paste count unchanged — the synchronous drain was skipped)",
    countOf(PASTE_START) === pasteAfterSetup);

  // ════════ THE BUG: the ~10s reconcile timer must be a NO-OP while parked (not clobber lastPrompt) ════════
  host.reconcile();
  check("RECONCILE: still parked — pending NOT drained by the timer (still [MSG1, MSG2])",
    JSON.stringify(host.getPending(SID)) === JSON.stringify([MSG1, MSG2]));
  check("RECONCILE: no new submit (the reconcile drain was suppressed by the rate-limit guard)",
    countOf(PASTE_START) === pasteAfterSetup);

  // A message arriving WHILE parked must be HELD (never submitted into the still-capped account, never
  // clobbering lastPrompt via the idle-submit path). It joins the held FIFO.
  const rp2 = host.enqueueStdin(SID, PARKED_MSG, "system");
  check("PARKED-ENQUEUE: a message sent while parked is HELD, not submitted (delivered:false, position:3)",
    rp2.delivered === false && rp2.position === 3);
  check("PARKED-ENQUEUE: no new submit (idle-submit path suppressed while parked)",
    countOf(PASTE_START) === pasteAfterSetup);
  check("PARKED-ENQUEUE: pending FIFO is now [MSG1, MSG2, PARKED_MSG]",
    JSON.stringify(host.getPending(SID)) === JSON.stringify([MSG1, MSG2, PARKED_MSG]));

  // ═══════════════ THE RESUME: re-submits the ORIGINAL killed turn (lastPrompt un-clobbered) ═══════════════
  const writesBeforeResume = written();
  const ok = host.resumeAfterRateLimit(SID);
  check("RESUME: resumeAfterRateLimit returned true (session live)", ok === true);
  check("RESUME: exactly ONE new submit (the replay)", countOf(PASTE_START) === pasteAfterSetup + 1);
  check("RESUME: busy re-armed (the replayed turn is in flight)", lastBusy() === true);

  // The definitive lastPrompt check: the resumed turn is the ORIGINAL killed turn, NOT the drained queue.
  const resumeWrite = written().slice(writesBeforeResume.length);
  check("RESUME: the replayed turn IS the interrupted turn (lastPrompt survived the reconcile)",
    resumeWrite.includes(KILLED));
  check("RESUME: the replay did NOT clobber-resubmit the queued messages",
    !resumeWrite.includes("QUEUED_ONE") && !resumeWrite.includes("SENT_WHILE_PARKED"));

  // After resume, the held queue drains normally on the next Stop (the park flag is cleared).
  await sleep(120); // flush the resume turn's async Enter
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("POST-RESUME: the held queue finally drained on the post-resume Stop (pending empty)",
    host.getPending(SID).length === 0);
  const turn = written();
  const i1 = turn.lastIndexOf("QUEUED_ONE"), i2 = turn.lastIndexOf("QUEUED_TWO"), i3 = turn.lastIndexOf("SENT_WHILE_PARKED");
  check("POST-RESUME: all three held messages drained, FIFO order preserved", i1 >= 0 && i2 >= 0 && i3 >= 0 && i1 < i2 && i2 < i3);
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a rate-limit park survives the reconcile timer: pending is held (not drained), lastPrompt is un-clobbered, the interrupted turn replays verbatim on resume, and the held queue drains only after resume."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
