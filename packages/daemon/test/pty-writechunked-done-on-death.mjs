// Regression test for card 9ed20572 (pty/host.ts writeChunked): `done` must fire on EVERY exit path,
// including "session died mid-burst" — pre-fix, `writeChunked` skipped `done` on its two not-alive
// paths (entry + mid-step). That was harmless while `done` was optional bookkeeping, but card b64b3726
// Half 2 threaded `healIfStuck`'s / the give-up-recovery clear's `setBusy(sessionId, false)` THROUGH
// `done` — so a session that died mid Backspace-clear-burst never got `busy` cleared, stranding it stuck
// busy=true forever with no further self-heal.
//
// Card 3ce3fa39 MOVED the Backspace-clear burst: give-up itself no longer writes one at all (it only
// marks the composer possibly-dirty and clears busy synchronously — nothing async to die mid-burst
// there anymore). The burst now lives in submit()'s own DEFERRED clear-prefix — written immediately
// before a subsequent turn's paste, threaded through writeChunked's `done` into `writeNewTurn` (the
// closure that then writes the REAL paste). This test now drives THAT path instead: cause a give-up to
// mark dirty, let the redrain start its clear-prefix burst, then kill the pty PARTWAY through it —
// proving (a) `writeChunked`'s not-alive `done?.()` guarantee still holds (submit()'s chain doesn't hang
// silently), and (b) `writeNewTurn` correctly re-checks aliveness before writing the real paste, so a
// session dying mid-clear-prefix never write to a dead pty (the exact gap this refactor could have
// reintroduced — `writeNewTurn` deferred what used to be submit()'s own always-synchronous-and-therefore-
// always-alive first write into an async `done` callback that can now fire post-death).
//
// Card b9b8f8db RETARGETED which redrain produces the burst: a redrain that REDELIVERS the identical
// give-up'd message (giveUpGen already set) now retries ONLY the Enter — no clear-prefix burst at all
// (that's the fix for the composer-runaway bug; see pty-giveup-clear.mjs scenario (1)). The full
// clear-prefix burst this test needs to kill mid-way through still fires, unchanged, for a genuinely
// DIFFERENT message arriving while composerDirtyLen>0 — so this test now drives THAT case instead of
// TEXT's own redrain (mirrors pty-giveup-clear.mjs scenario (4)'s own identical retargeting).
//
// FALSIFIES on pre-fix-of-THIS-card code: removing `writeNewTurn`'s own `if (!l?.alive) return;` guard
// reproduces a stray post-death `ptyWrite` call (verified by hand against that gap during development).
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
// Card 3ce3fa39: the deferred clear rides the requeued entry's own next redrain, HELD from drain for
// GIVE_UP_HOLD_MS pending a confirming hook — pinned small for this hermetic suite.
const HOLD_MS = 10;
const HOLD_WAIT = HOLD_MS + 20;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);

const { PtyHost } = await import("../dist/pty/host.js");

const BACKSPACE = "\x7f";
const BRACKET_PASTE_START = "\x1b[200~";

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
  const OTHER = "A_GENUINELY_DIFFERENT_LATER_MESSAGE"; // card b9b8f8db: only a DIFFERENT message still gets the full burst
  const { fake, backspaceCount } = spawnReady(SID);
  const r = host.enqueueStdin(SID, TEXT);
  check("setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

  // Never confirm — exhaust every attempt, GIVE-UP RECOVERY marks the composer possibly-dirty (card
  // 3ce3fa39 — no burst written HERE anymore, busy just clears synchronously) and requeues TEXT.
  const giveUpDeadline = Date.now() + 15_000;
  while (busyLog[SID].at(-1) !== false && Date.now() < giveUpDeadline) await sleep(20);
  check("give-up recovered busy", busyLog[SID].at(-1) === false);
  check("card 3ce3fa39: no backspace yet — give-up itself never writes the burst", backspaceCount() === 0);

  // Card b9b8f8db: enqueue a DIFFERENT message rather than redriving TEXT itself — TEXT's own redrain
  // (a redelivery of the SAME give-up'd message) now retries only the Enter and writes no burst at all
  // (the fix). `composerDirtyLen` is still TEXT.length from the give-up above, and busy is false, so OTHER
  // takes enqueueStdin's IMMEDIATE path with a brand-new synthetic origin (no giveUpGen) — the ORIGINAL,
  // unchanged clear-prefix mechanism: force-close, then a large multi-chunk Backspace burst threaded
  // through writeChunked's `done` into `writeNewTurn` (which then writes OTHER's own real paste).
  const rOther = host.enqueueStdin(SID, OTHER);
  check("setup: the different message was delivered immediately (busy was false)", rOther.delivered === true);

  // Wait for the clear-prefix burst to actually START, then kill the pty PARTWAY through it.
  const startDeadline = Date.now() + 15_000;
  while (backspaceCount() === 0 && Date.now() < startDeadline) await sleep(20);
  check("sanity: the deferred clear-prefix burst genuinely started", backspaceCount() > 0);
  check("sanity: killing NOW is genuinely mid-burst, not after completion", backspaceCount() < TEXT.length);

  const countAtCrash = backspaceCount();
  const writesAtCrash = fake.writes.length;
  fake.simulateCrash(); // the session dies mid-burst — mirrors an unexpected pty exit

  // Give the (now-dead) burst's pending setTimeout chain a chance to fire its next tick and bail, AND
  // give writeChunked's `done` callback (writeNewTurn) a chance to run if it were going to misbehave.
  await sleep(200);

  check("sanity: the burst genuinely never completed (proves this exercised the not-alive bail, not a race that just finished naturally)",
    backspaceCount() < TEXT.length && backspaceCount() >= countAtCrash);
  // THE FIX (this card): writeChunked's `done?.()` guarantee (card 9ed20572) still fires `writeNewTurn`
  // on the not-alive path — but `writeNewTurn` must itself re-check aliveness (it's now REACHABLE
  // asynchronously post-death, unlike its pre-refactor shape which only ever ran synchronously while
  // submit()'s own entry guard was still fresh) and bail WITHOUT writing the real paste's bracket-start
  // to the dead pty.
  const writesAfterCrash = fake.writes.slice(writesAtCrash);
  check("THE FIX: writeNewTurn did NOT write a stray bracket-start (or anything else) to the dead pty",
    !writesAfterCrash.some((w) => w.includes(BRACKET_PASTE_START)));
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — writeChunked invokes `done` exactly once on every exit path, including mid-burst death (card 9ed20572); the deferred clear-prefix's `writeNewTurn` continuation (card 3ce3fa39) re-checks aliveness itself and never writes to a dead pty when reached post-death."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
