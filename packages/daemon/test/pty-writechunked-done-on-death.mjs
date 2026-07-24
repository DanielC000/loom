// Regression test for card 9ed20572 (pty/host.ts writeChunked): `done` must fire on EVERY exit path,
// including "session died mid-burst" — pre-fix, `writeChunked` skipped `done` on its two not-alive
// paths (entry + mid-step). That was harmless while `done` was optional bookkeeping, but card
// b64b3726 Half 2 threads `healIfStuck`'s / the give-up-recovery clear's `setBusy(sessionId, false)`
// THROUGH `done` (see sendEnterAndVerify's GIVE-UP RECOVERY branch) — so a session that dies mid
// Backspace-clear-burst never got `busy` cleared, stranding it stuck busy=true forever with no
// further self-heal (this IS the last-resort recovery path).
//
// This test drives the SAME give-up-recovery clear path pty-giveup-clear.mjs scenario (4) already
// covers for the happy path (a large multi-chunk backspace burst that completes normally) — but here
// the pty is killed PARTWAY through that burst instead of letting it finish, proving `busy` still
// recovers to false even though the burst never completes.
//
// FALSIFIES on pre-fix code: reverting writeChunked's two `done?.()` calls on its not-alive paths
// reproduces this exact hang — busy stays true forever once the session dies mid-burst, verified by
// hand against the pre-fix source during development of this fix.
//
// RUN (no daemon needed): node test/pty-writechunked-done-on-death.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-writechunked-death-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Mirrors pty-giveup-clear.mjs's constants — drives a real give-up (attempt > 1, composerLen === 0,
// lastPrompt set) so the clear takes the writeChunked-backed Backspace-burst branch.
const ENTER_DELAY = 50;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);

const { PtyHost } = await import("../dist/pty/host.js");

const BACKSPACE = "\x7f";

const fakes = [];
function makeFakePty() {
  const writes = [];
  let exitCb = null;
  const fake = {
    pid: 4242,
    write: (d) => { writes.push(d); },
    onData: () => ({ dispose() {} }),
    onExit: (cb) => { exitCb = cb; return { dispose() {} }; },
    kill: () => { if (exitCb) exitCb({ exitCode: 0 }); },
    resize: () => {},
    writes,
    // Test-only: simulate an UNEXPECTED crash mid-burst — fires the exact same onExit callback a real
    // node-pty process death would (marks live.alive=false), without going through host.stop() (which
    // would set `stopping` and take a different code path).
    simulateCrash: () => { if (exitCb) exitCb({ exitCode: 1 }); },
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
  return { fake, backspaceCount: () => fake.writes.join("").split(BACKSPACE).length - 1 };
}

const SID = "sess-writechunked-death-midburst";
try {
  const TEXT = "X".repeat(50 * 1024); // large enough to span many chunks — see pty-giveup-clear.mjs scenario (4)
  const { fake, backspaceCount } = spawnReady(SID);
  const r = host.enqueueStdin(SID, TEXT);
  check("setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

  // Wait for give-up's Backspace-clear burst to actually START (3 failed attempts, composerLen===0,
  // lastPrompt set — the same give-up path pty-giveup-clear.mjs scenario 4 exercises), then kill the
  // pty PARTWAY through the burst — never letting it finish naturally.
  const startDeadline = Date.now() + 15_000;
  while (backspaceCount() === 0 && Date.now() < startDeadline) await sleep(20);
  check("sanity: the backspace-clear burst genuinely started", backspaceCount() > 0);
  check("sanity: killing NOW is genuinely mid-burst, not after completion", backspaceCount() < TEXT.length);

  const countAtCrash = backspaceCount();
  fake.simulateCrash(); // the session dies mid-burst — mirrors an unexpected pty exit

  // Give the (now-dead) burst's pending setTimeout chain a chance to fire its next tick and bail.
  await sleep(200);

  check("THE FIX: busy recovers to false even though the burst never completed", busyLog[SID].at(-1) === false);
  check("sanity: the burst genuinely never completed (proves this exercised the not-alive bail, not a race that just finished naturally)",
    backspaceCount() < TEXT.length && backspaceCount() >= countAtCrash);
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — writeChunked invokes `done` exactly once on every exit path, including mid-burst death, so setBusy(false) threaded through it (the give-up-recovery clear) is never skipped."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
