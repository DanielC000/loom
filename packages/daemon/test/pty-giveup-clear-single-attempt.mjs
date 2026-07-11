// Hermetic regression test for the give-up clear's PASTE-OPEN safety edge (pty/host.ts sendEnterAndVerify,
// card ee082fbb CR item ②) — a SEPARATE process from pty-giveup-clear.mjs because SUBMIT_MAX_ATTEMPTS is
// read from env once at import time and this file needs it pinned to 1, the one config where the clear
// must NOT fire.
//
// sendEnterAndVerify's `if (attempt > 1) live.pty.write(BRACKET_PASTE_START + BRACKET_PASTE_END)` re-
// asserts (and so, per card 97558183, converges toward CLOSING) the paste bracket before every retried
// Enter. Give-up only clears the composer when `attempt > 1` proves that re-assert already ran for the
// give-up attempt — the one signal available that the paste is likely closed. With SUBMIT_MAX_ATTEMPTS=1
// (env-only; production always defaults to 4), give-up fires at attempt===1, where NO re-assert has ever
// been sent — paste-open is unverified, so the clear must be skipped (falling back to the pre-fix stray-
// text concatenation) rather than risk folding raw Backspace bytes in AS PASTE CONTENT, which would be
// worse than the pre-fix behavior it's supposed to improve on.
//
// RUN (no daemon needed): node test/pty-giveup-clear-single-attempt.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sleepUntil(t0, targetMs) {
  const remaining = targetMs - (Date.now() - t0);
  if (remaining > 0) await sleep(remaining);
}

const tmpHome = path.join(os.tmpdir(), `loom-giveupclear1-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;
const VERIFY_TIMEOUT = 600;
const MAX_ATTEMPTS = 1; // the degenerate config under test — give-up fires at attempt===1, no re-assert ever ran
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
const giveUpAt = () => ENTER_DELAY + VERIFY_TIMEOUT;

const { PtyHost } = await import("../dist/pty/host.js");

const BACKSPACE = "\x7f";

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

function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { fake, backspaceCount: () => fake.writes.join("").split(BACKSPACE).length - 1, entryCount: () => fake.writes.join("").split("\r").length - 1 };
}

try {
  const SID = "sess-giveup-single-attempt";
  const TEXT = "STRANDED_AT_ATTEMPT_ONE";
  const { backspaceCount, entryCount } = spawnReady(SID);
  const t0 = Date.now();
  const r = host.enqueueStdin(SID, TEXT);
  check("setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

  // Never confirm — give-up fires right after attempt 1's own verify window, with NO retry (and so no
  // START+END re-assert) ever having run.
  await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
  check("exactly 1 Enter attempt was written (MAX_ATTEMPTS=1 — no retries)", entryCount() === 1);
  check("GIVE-UP RECOVERY: busy fell back to false", busyLog[SID].at(-1) === false);
  check("PASTE-OPEN SAFETY: NO backspace clear was written when give-up fires at attempt===1 (no re-assert ever ran, paste-open unverified)",
    backspaceCount() === 0);
} finally {
  try { host.stop("sess-giveup-single-attempt", "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — with SUBMIT_MAX_ATTEMPTS=1, give-up recovers busy but skips the composer clear (no paste-reassert ever ran, so paste-open can't be ruled out) — the residual-risk guard from card ee082fbb's CR holds."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
