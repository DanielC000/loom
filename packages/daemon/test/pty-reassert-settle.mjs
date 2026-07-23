// Hermetic regression test for card b64b3726 Half 1 (pty/host.ts sendEnterAndVerify's reassert-settle
// sequencing).
//
// Code Reviewer finding: the FINAL attempt's own paste-reassert (`BRACKET_PASTE_START + BRACKET_PASTE_END`,
// written for every `attempt > 1` immediately before that attempt's Enter) is itself an output source that
// can land AFTER `enterWrittenAt` — the anchor card 71de1f9c's give-up-suppression check reads — without the
// Enter ever having landed. Probe-confirmed real (test/_probe-empty-paste-provocation.mjs): a bare
// START+END provokes a deterministic ~16-byte TUI response some (cadence-dependent) fraction of the time,
// and when it does fire, latency is bimodal (fast ~1-8ms majority, slow ~800-1400ms residual — see
// REASSERT_SETTLE_POLL_MS's doc comment in host.ts for the full measured distribution).
//
// The fix: on the FINAL attempt only, write the reassert, then wait (bounded, observed) for ITS OWN
// response to land BEFORE writing Enter and capturing `enterWrittenAt` — so a FAST response is absorbed
// into the pre-Enter window instead of landing after the anchor. This test proves exactly that: a
// synthetic output chunk timed to land DURING the settle window must NOT cause a suppression — the give-up
// branch must read it as "no output after MY enterWrittenAt" and proceed with the NORMAL give-up recovery
// (busy clears, the stranded injection is backspace-cleared) — exactly as if no confounding output had ever
// occurred. Pre-fix (no settle-wait), this same timing would have landed the response after the
// (earlier, undelayed) enterWrittenAt and caused a false GIVE-UP SUPPRESSED — watched to fail against the
// true parent commit below.
//
// RUN (no daemon needed): node test/pty-reassert-settle.mjs
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

const tmpHome = path.join(os.tmpdir(), `loom-reassertsettle-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;      // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600;  // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;      // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const SETTLE_POLL = 10;      // mirrors LOOM_REASSERT_SETTLE_POLL_MS
const SETTLE_MAX_POLLS = 5;  // mirrors LOOM_REASSERT_SETTLE_MAX_POLLS
const SETTLE_BOUND = SETTLE_POLL * SETTLE_MAX_POLLS; // 50ms
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
// The FINAL attempt's own re-assert is written at this (pre-settle-wait) point — same as every attempt's
// write point pre-Half-1. Its Enter, post-Half-1, is written only after the settle wait resolves.
const reassertWriteAt = (k) => ENTER_DELAY + (k - 1) * VERIFY_TIMEOUT;

const { PtyHost } = await import("../dist/pty/host.js");

const BACKSPACE = "\x7f";

const fakes = [];
function makeFakePty() {
  const writes = [];
  let onDataCb = null;
  const fake = {
    pid: 4242,
    write: (d) => { writes.push(d); },
    onData: (cb) => { onDataCb = cb; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
    kill: () => {},
    resize: () => {},
    writes,
    emitData: (d) => { if (onDataCb) onDataCb(d); },
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

function spawnReady(host, sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { fake, backspaceCount: () => fake.writes.join("").split(BACKSPACE).length - 1 };
}

try {
  // ===================== FAST provoked response, timed to land DURING the settle window ================
  // ===================== -> ABSORBED: no suppression, normal give-up recovery + clear fires =============
  const host = new TestPtyHost(events);
  const SID = "sess-reassert-absorbed";
  const TEXT = "STRANDED_BUT_RECOVERABLE_BODY";
  const { fake, backspaceCount } = spawnReady(host, SID);
  const t0 = Date.now();
  const r = host.enqueueStdin(SID, TEXT);
  check("setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

  // Fire shortly after the FINAL attempt's re-assert is written, well INSIDE the settle window (which
  // spans [reassertWriteAt, reassertWriteAt + SETTLE_BOUND)).
  await sleepUntil(t0, reassertWriteAt(MAX_ATTEMPTS) + Math.floor(SETTLE_BOUND / 4));
  fake.emitData("\x1b[<u\x1b[>1u\x1b[>4;2m"); // the probe-observed provoked-response shape; only its timing matters here

  // Give-up (if it were going to fire suppressed OR recovered) is now anchored at
  // reassertWriteAt(MAX_ATTEMPTS) + SETTLE_BOUND + VERIFY_TIMEOUT — wait comfortably past that.
  await sleepUntil(t0, reassertWriteAt(MAX_ATTEMPTS) + SETTLE_BOUND + VERIFY_TIMEOUT + VERIFY_TIMEOUT / 2);

  check("ABSORBED: the settle-window response did NOT cause a suppression — busy recovered to false",
    busyLog[SID].at(-1) === false);
  check(`ABSORBED: normal give-up recovery ALSO ran its composer clear — exactly ${TEXT.length} backspaces written`,
    backspaceCount() === TEXT.length);

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a fast paste-reassert response landing inside the settle window is absorbed before the anchor, so it no longer causes a false give-up suppression."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
