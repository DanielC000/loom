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
// Card 2c9582d3: poll for an actual OUTCOME instead of sleeping to a single wall-clock deadline computed
// by summing nominal constants. The give-up/confirm-settle chain this test exercises is several CHAINED
// setTimeout hops (verify-timeout -> confirm-settle poll -> writeChunked -> setBusy); under real host
// scheduling contention each hop's callback can individually fire late, and that per-hop drift
// accumulates across the chain, blowing through a fixed deadline's small constant slack (measured: this
// exact double-FAIL reproduces under synthetic sibling-process CPU load with no code change — see the
// card for the measurement). Waiting for the outcome instead of a guessed total keeps the test correct
// regardless of how much contention the host is under, without changing what it discriminates: if
// suppression fired instead of recovery, `predicate` never turns true (nothing in this fake pty ever
// confirms a hook to flip `enterConfirmed`), so this still fails — just after `timeoutMs` elapses.
async function waitUntil(predicate, { timeoutMs, pollMs = 20 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(pollMs);
  }
  return predicate();
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
// Card 441499ee: after the verify-timeout elapses with no confirmation, GIVE-UP now takes ONE more short,
// bounded, OBSERVED wait for `enterConfirmed` (awaitGiveUpConfirmSettle) before actually committing to
// RECOVERY — nothing in this fake pty ever fires a confirming HOOK (only raw `emitData`, which this file's
// own probe response is NOT a hook), so that wait always maxes out its bound too.
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
// The exact bytes `sendEnterAndVerify` writes for every retry's (attempt > 1) paste-reassert — see
// host.ts's own `BRACKET_PASTE_START + BRACKET_PASTE_END` write in that method. Attempts 2..MAX_ATTEMPTS
// each write ONE of these (MAX_ATTEMPTS - 1 total across a full give-up chain); the LAST one written is
// the FINAL attempt's — the one whose settle window this test targets.
const REASSERT_PASTE = "\x1b[200~\x1b[201~";
const FINAL_REASSERT_COUNT = MAX_ATTEMPTS - 1;

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
  const r = host.enqueueStdin(SID, TEXT);
  check("setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

  // Card 231e0c0f: converting the CHECK below to `waitUntil` (card 2c9582d3) fixed only the OBSERVATION
  // half of this test's timing dependency. The STIMULUS — firing the provoked response — is the half that
  // PRODUCES the outcome being checked, and a blind computed-offset `sleepUntil` here would still be an
  // independent wall-clock guess at when the FINAL attempt's reassert lands, racing the same settle window
  // the CHECK now waits on correctly. The generalizable lesson: a "fixed" timing test needs BOTH halves
  // examined — the assertion AND whatever drives the system before it. Fix: wait for the FINAL attempt's
  // own paste-reassert to actually land on the fake pty's `writes` (an OBSERVED condition), then fire
  // immediately — this guarantees landing inside the settle window (which starts exactly when that write
  // lands) regardless of host scheduling contention, instead of merely being likely to.
  const reasserted = await waitUntil(
    () => fake.writes.filter((w) => w === REASSERT_PASTE).length >= FINAL_REASSERT_COUNT,
    { timeoutMs: 10_000, pollMs: 2 },
  );
  check("setup: the final attempt's own paste-reassert landed on the wire", reasserted);
  fake.emitData("\x1b[<u\x1b[>1u\x1b[>4;2m"); // the probe-observed provoked-response shape; only its timing matters here

  // Give-up (if it were going to fire suppressed OR recovered) is anchored at the FINAL attempt's own
  // reassert write time + SETTLE_BOUND + VERIFY_TIMEOUT, PLUS the post-give-up confirm-settle wait (card
  // 441499ee) before RECOVERY actually commits. Poll for busy to actually recover instead of
  // sleeping to that nominal deadline (see waitUntil's doc above) — bounded generously (15s: several
  // times the ~2s nominal chain, and above what synthetic heavy-contention measurement reproduced) so a
  // genuine regression back to false-suppression still fails, just not on a hair-trigger margin.
  const recovered = await waitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 15_000, pollMs: 20 });

  check("ABSORBED: the settle-window response did NOT cause a suppression — busy recovered to false",
    recovered);
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
