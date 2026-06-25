// Deterministic guard for interruptForRedirect (worker_redirect, Part 3 — the "land it NOW" steer).
//
// PROVES the gentle-interrupt + self-clear at the pty layer (no claude, no daemon):
//   • a single Esc (\x1b) is written to END a busy worker's current turn;
//   • an Esc-cancel fires NO Stop hook, so busy goes STALE — after a BOUNDED, env-overridable settle the
//     host SYNCHRONOUSLY clears busy and DRAINS a freshly-enqueued redirect as the next turn (one submit);
//   • flushPending splices+returns the held FIFO (with onDeliver) so the service can supersede it;
//   • it is a NO-OP (no Esc, no double-submit, no crash) when the session is `stopping`.
//
// Drives the settle via LOOM_REDIRECT_SETTLE_MS (set tiny BEFORE importing host.js). Sibling of
// pty-stop-queue.mjs / queued-message-durability.mjs (the createPty fake-pty seam).
//
// RUN (no daemon needed): from packages/daemon, after `pnpm build`: node test/pty-interrupt-redirect.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME + a TINY settle, set BEFORE importing host.js (paths.ts + the REDIRECT_SETTLE_MS
// const are read at import time).
const tmpHome = path.join(os.tmpdir(), `loom-redirect-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_REDIRECT_SETTLE_MS = "20"; // drive the bounded settle in ~ms
const SETTLE_MS = 20;

const { PtyHost } = await import("../dist/pty/host.js");

const fakes = [];
function makeFakePty() {
  const writes = [];
  let exitCb = null;
  const fake = {
    pid: 4242,
    write: (d) => { writes.push(d); },
    onData: () => ({ dispose() {} }),
    onExit: (cb) => { exitCb = cb; return { dispose() {} }; },
    kill: () => { exitCb?.({ exitCode: 0, signal: undefined }); },
    resize: () => {},
    writes,
    fireExit: (code = 0) => exitCb?.({ exitCode: code, signal: undefined }),
  };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }

const busyLog = [];
const events = { onEngineSessionId() {}, onBusy(_id, b) { busyLog.push(b); }, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

const ESC = "\x1b";
const ALPHA = "ALPHA_TURN", OLD = "OLD_DIRECTION", REDIRECT = "REDIRECT_NOW";

try {
  // ===================== Scenario 1: interrupt → settle clears busy → redirect drains =====================
  const SID = "redir-sess";
  host.spawn({
    sessionId: SID, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake = fakes[0];
  host.deliverHook(SID, { hook_event_name: "SessionStart" }); // → ready

  const written = () => fake.writes.join("");
  const countOf = (m) => written().split(m).length - 1;
  const lastBusy = () => busyLog[busyLog.length - 1];

  // A turn in flight (busy) + a HELD durable "old direction" carrying an onDeliver (mirrors a queued
  // manager message). interruptForRedirect should NOT fire it — the service flushes it first.
  const rA = host.enqueueStdin(SID, ALPHA);                       // delivered now → busy armed
  let oldSuperseded = null;
  const rOld = host.enqueueStdin(SID, OLD, "system", (reason) => { oldSuperseded = reason ?? "delivered"; }); // held
  check("setup: ALPHA in flight (busy), OLD held FIFO position 1", rA.delivered === true && rOld.delivered === false && rOld.position === 1);
  check("setup: busy armed", lastBusy() === true);

  // The SERVICE flushes the pending queue before enqueueing the authoritative redirect — exercise
  // flushPending directly here (the service-level test proves the wiring + the "superseded" reason).
  const flushed = host.flushPending(SID);
  check("flushPending: returned the held OLD entry WITH its onDeliver", flushed.length === 1 && flushed[0].text === OLD && typeof flushed[0].onDeliver === "function");
  check("flushPending: emptied the live FIFO", host.getPending(SID).length === 0);
  // The service would resolve it; simulate that to prove the callback carries a reason.
  flushed[0].onDeliver("superseded");
  check("flushPending: the flushed durable entry resolves with a 'superseded' reason", oldSuperseded === "superseded");

  // Enqueue the authoritative redirect — worker still BUSY (the ALPHA turn), so it is HELD (delivered:false).
  const rRedir = host.enqueueStdin(SID, REDIRECT, "system", () => {});
  check("redirect enqueued: held behind the busy turn (delivered:false)", rRedir.delivered === false && rRedir.position === 1);
  check("redirect not yet written to the pty", countOf(REDIRECT) === 0);

  // INTERRUPT: a single Esc cancels the in-flight turn. busy stays true (no Stop hook fires on an Esc).
  const escBefore = countOf(ESC);
  host.interruptForRedirect(SID);
  check("interrupt: wrote a single Esc (\\x1b) to cancel the in-flight turn", countOf(ESC) === escBefore + 1);
  check("interrupt: busy NOT cleared synchronously (no Stop hook yet)", lastBusy() === true);
  check("interrupt: redirect still HELD immediately after (settle hasn't fired)", countOf(REDIRECT) === 0);

  // After the bounded settle: busy is self-cleared (no Stop hook needed) and the redirect DRAINS as one
  // submit — note the drain RE-ARMS busy for the redirect turn, so the self-clear shows as a busy=false
  // edge in the log between the interrupt and the re-arm (the lasting state is busy=true for the new turn).
  const busyMarks = busyLog.length;
  await sleep(SETTLE_MS + 80);
  check("after settle: busy was self-cleared (a busy=false edge appears, with no Stop hook)", busyLog.slice(busyMarks).includes(false));
  check("after settle: the freshly-enqueued redirect DRAINED (written once)", countOf(REDIRECT) === 1);
  check("after settle: busy re-armed for the redirect turn (drain submitted it)", lastBusy() === true);
  check("after settle: the FIFO is empty (redirect was the only entry)", host.getPending(SID).length === 0);

  // The redirect turn is now in flight (drain re-armed busy via submit). A SECOND settle-drain must not
  // double-submit (idempotent) — there's nothing more to drain.
  await sleep(SETTLE_MS + 80);
  check("no double-submit: redirect still written exactly once", countOf(REDIRECT) === 1);

  // ===================== Scenario 2: NO-OP when the session is `stopping` =====================
  const SID2 = "redir-stop-sess";
  host.spawn({
    sessionId: SID2, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake2 = fakes[fakes.length - 1];
  host.deliverHook(SID2, { hook_event_name: "SessionStart" });
  host.enqueueStdin(SID2, ALPHA); // in-flight turn (busy)
  const written2 = () => fake2.writes.join("");
  const escCount2Before = written2().split(ESC).length - 1;

  // A graceful stop marks the session `stopping` (and clears its queue). interruptForRedirect must be a
  // pure no-op against a stopping session — don't fight the stop, don't write an Esc, don't crash.
  host.stop(SID2, "graceful");
  const escCount2AfterStop = written2().split(ESC).length - 1;
  host.interruptForRedirect(SID2);
  const escCount2AfterRedirect = written2().split(ESC).length - 1;
  check("stopping: interruptForRedirect wrote NO additional Esc (no-op while stopping)", escCount2AfterRedirect === escCount2AfterStop);
  // A late settle would also be a no-op (stopping) — verify nothing drains and no crash.
  await sleep(SETTLE_MS + 80);
  check("stopping: still no crash, queue stays clear", host.getPending(SID2).length === 0);

  // ===================== Scenario 3: NO-OP on a dead / idle session =====================
  const SID3 = "redir-idle-sess";
  host.spawn({
    sessionId: SID3, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake3 = fakes[fakes.length - 1];
  host.deliverHook(SID3, { hook_event_name: "SessionStart" }); // ready + IDLE (no in-flight turn)
  const escIdleBefore = fake3.writes.join("").split(ESC).length - 1;
  host.interruptForRedirect(SID3); // idle (busy=false) → nothing to interrupt
  check("idle: interruptForRedirect is a no-op (no Esc — nothing in flight to cancel)", (fake3.writes.join("").split(ESC).length - 1) === escIdleBefore);
  // Dead session: also a no-op (no throw).
  let threw = false;
  try { host.interruptForRedirect("no-such-session"); } catch { threw = true; }
  check("unknown session: interruptForRedirect is a safe no-op (no throw)", threw === false);
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — interruptForRedirect writes one Esc, self-clears stale busy after the bounded settle, drains the redirect as one turn, and is a no-op when stopping/idle/dead."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
