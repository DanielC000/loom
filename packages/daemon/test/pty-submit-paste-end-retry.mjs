// Regression test for card 97558183 — "worker reports SILENTLY LOST": a dropped closing
// BRACKET_PASTE_END (\x1b[201~) write in submit() strands Claude Code's Ink TUI mid-paste, so
// sendEnterAndVerify's retried `\r` is swallowed as paste CONTENT (never a submit) and every attempt
// fails, losing the whole turn (a worker_report, most critically).
//
// The fix (sendEnterAndVerify in host.ts): every RETRY (attempt > 1) re-asserts a zero-length
// `START+END` pair as ONE write, before the `\r` — never a bare END alone (unverified whether Ink
// recognizes an out-of-context terminator the same way; see the doc comment on sendEnterAndVerify).
// A zero-length START+END pair is well-defined either way:
//   - idle (the paste already closed, only Enter dropped) → true no-op, no content change;
//   - still mid-paste (the bug) → END is found in the byte stream and the paste closes (a few stray
//     literal marker bytes may fold into the paste content, but the turn recovers instead of being lost).
//
// This test drives the real PtyHost state machine against a FAKE pty (the createPty() seam — no real
// claude), asserting the exact BYTES this host writes, matching the sibling pty-submit-verify-retry.mjs
// pattern (card 9549e322) this extends. It CANNOT model Ink's own paste state machine (a real-TUI
// behavior, not hermetically verifiable) — that live confirmation is the Lead's, on the next daemon
// restart. What IS hermetically verifiable, and what this test asserts:
//   (a) a withheld confirmation's retry re-asserts START+END before each retried Enter;
//   (b) the FIRST attempt (immediately after submit()'s own END write) does NOT redundantly re-assert —
//       only retries (attempt > 1) do, so the common happy-path write shape is unchanged;
//   (c) give-up recovery writes NO clear/interrupt bytes at all (LEAVE-AS-IS per card ee082fbb's Lead
//       ruling — deferred pending a real-claude spike on clear-efficacy) — so a genuine human draft
//       (or the stranded turn text itself) is never touched, regardless of composerLen.
//
// RUN (no daemon needed): node test/pty-submit-paste-end-retry.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Sleep until `targetMs` has elapsed since `t0` — an ABSOLUTE-offset wait so an earlier await's own
 *  jitter can't compound into a later checkpoint's margin (mirrors the sibling verify-retry test). */
async function sleepUntil(t0, targetMs) {
  const remaining = targetMs - (Date.now() - t0);
  if (remaining > 0) await sleep(remaining);
}

const tmpHome = path.join(os.tmpdir(), `loom-pasteendretry-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS — generous relative to host scheduling jitter
const MAX_ATTEMPTS = 3;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
const writeAt = (k) => ENTER_DELAY + (k - 1) * VERIFY_TIMEOUT;

const { PtyHost } = await import("../dist/pty/host.js");

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

const busyLog = {};
const events = {
  onEngineSessionId() {},
  onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
};

const host = new TestPtyHost(events);
const ENTER = "\r";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const REASSERT = PASTE_START + PASTE_END; // the zero-length defensive pair sendEnterAndVerify re-sends

function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { fake, writes: () => fake.writes, countOf: (m) => fake.writes.join("").split(m).length - 1 };
}

try {
  // ===================== (a)+(b) withheld confirmation → retry re-asserts START+END before Enter =====
  {
    const SID = "sess-pasteend-retry";
    const { writes, countOf } = spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, "REPORT_STRANDED");
    check("(a) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    await sleepUntil(t0, writeAt(1) + VERIFY_TIMEOUT / 2); // safely after write 1, safely before write 2
    check("(b) attempt 1 written NO re-assert pair — only submit()'s own END + the bare Enter",
      countOf(REASSERT) === 0 && countOf(ENTER) === 1);

    // Withhold confirmation entirely — models the dropped END: Ink stays mid-paste, swallowing the bare
    // `\r` as content. The OLD code would just re-send another bare `\r` here, forever swallowed too.
    await sleepUntil(t0, writeAt(2) + VERIFY_TIMEOUT / 2); // safely after write 2, safely before write 3
    check("(a) RETRY 2 re-asserted the START+END pair exactly once before its Enter", countOf(REASSERT) === 1);
    check("(a) the re-assert pair was written strictly BEFORE the 2nd Enter (order matters — closes the paste first)",
      writes().indexOf(REASSERT) < writes().lastIndexOf(ENTER));
    check("(a) exactly 2 Enter attempts written so far", countOf(ENTER) === 2);

    await sleepUntil(t0, writeAt(3) + VERIFY_TIMEOUT / 2); // safely after write 3
    check("(a) RETRY 3 re-asserted the pair again (every retry, not just the first)", countOf(REASSERT) === 2);
    check("(a) exactly 3 Enter attempts written (bounded by MAX_ATTEMPTS)", countOf(ENTER) === 3);

    // Confirm this time (models the re-asserted END finally landing and the retry's Enter registering).
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(a) confirmation recovers busy — the turn was NOT lost", busyLog[SID].at(-1) === false);
    const reassertsAtEnd = countOf(REASSERT);
    await sleep(VERIFY_TIMEOUT);
    check("(a) no further re-assert/Enter writes after confirmation", countOf(REASSERT) === reassertsAtEnd);
  }

  // ===================== (c) give-up recovery writes NO clear/interrupt bytes — draft/text preserved =====
  {
    const SID = "sess-pasteend-giveup";
    const { countOf } = spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, "NEVER_CONFIRMED_EITHER");
    check("(c) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // Never confirm anything — exhaust every attempt (each retry still re-asserting START+END).
    await sleepUntil(t0, writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT + VERIFY_TIMEOUT / 2);
    check("(c) all attempts exhausted (bounded, not infinite)", countOf(ENTER) === MAX_ATTEMPTS);
    check("(c) retries still re-asserted the pair (this fix applies through give-up, not just early retries)",
      countOf(REASSERT) === MAX_ATTEMPTS - 1);
    check("(c) GIVE-UP: busy recovered to false (session not wedged)", busyLog[SID].at(-1) === false);
    // LEAVE-AS-IS (card ee082fbb Lead ruling): give-up must NOT write a Ctrl-U (\x15) or any other
    // clear/interrupt byte — clearing is deferred pending a real-claude spike on clear-efficacy, so
    // whatever is in the composer (a human draft OR the stranded turn text) is left untouched, not
    // blindly wiped. This must hold regardless of composerLen (0 or >0) since no clear path exists at all.
    check("(c) give-up wrote NO Ctrl-U / kill-line byte (no blind composer clear)", countOf("\x15") === 0);
  }
} finally {
  for (const sid of ["sess-pasteend-retry", "sess-pasteend-giveup"]) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — sendEnterAndVerify's retries re-assert a zero-length START+END pair before each retried Enter (never on the first attempt), recovering a turn stranded by a dropped closing paste marker instead of losing it after 4 failed attempts; give-up still writes no blind composer clear."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
