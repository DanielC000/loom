// Hermetic regression test for card b64b3726 Half 2 (pty/host.ts healIfStuck).
//
// Code Reviewer finding on 71de1f9c's branch: give-up recovery (card ee082fbb's exact-Backspace composer
// clear) can be SUPPRESSED by output that lands after the final Enter write WITHOUT the Enter having
// landed — our own paste-reassert write provokes a deterministic engine response (probe-confirmed,
// test/_probe-empty-paste-provocation.mjs), and a viewer's repaint() (Ctrl-L) can too. When that happens,
// `live.enterConfirmed` stays false FOREVER (nothing can flip it: the only writer, submit(), only runs
// when `!live.busy`, and busy is stuck true) — so the session is a genuine give-up that was wrongly
// suppressed. Pre-fix, `healIfStuck`'s stale-busy self-heal clears `busy` but never un-types the
// composer, so the stranded injection survives and the NEXT drainPending submit pastes on top of it —
// reintroducing the exact concatenation card ee082fbb fixed.
//
// This test forces that false-suppress DETERMINISTICALLY (no reliance on real engine timing): a fake pty
// that can synthetically fire an output chunk lets us make `lastOutputAt > enterWrittenAt` true for the
// FINAL Enter attempt without ever confirming the turn, exactly modelling the suppressed case. It then
// proves (1) pre-fix the composer is left stranded (busy clears, backspaces === 0) and (2) post-fix
// `healIfStuck` completes the clear (busy clears, backspaces === lastPrompt.length) — plus the most
// important non-regression case: a session that legitimately went on to submit (a late but real
// UserPromptSubmit before the stale window elapses) must NEVER be heal-cleared.
//
// Card b64b3726 Half 1 (sendEnterAndVerify's own reassert-settle sequencing) ABSORBS the FAST case of the
// false-suppress vector this test used to exercise — a response landing DURING the pre-Enter settle wait no
// longer reaches the anchor at all. This test's `emitData` calls are timed to land AFTER that settle window
// closes (see `writeAt`'s Half-1-aware formula below), so they now model the RESIDUAL case Half 1 does NOT
// fix (a slow-tail vector-1 response, or a human repaint()) — see test/pty-reassert-settle.mjs for the
// direct regression test of the absorbed FAST case.
//
// RUN (no daemon needed): node test/pty-healifstuck-clear.mjs
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

const tmpHome = path.join(os.tmpdir(), `loom-healclear-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;      // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600;  // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;      // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const FIRST_TURN_STALE = 400; // mirrors LOOM_FIRST_TURN_STALE_MS — small so the pre-first-turn heal window is fast to test
// Card b64b3726 Half 1: the FINAL attempt now waits (bounded, observed) for its own paste-reassert to
// settle BEFORE writing Enter. This test's own emitData calls (below) fire AFTER that settle window closes
// — modelling the RESIDUAL case Half 1 does NOT fix (a slow-tail vector-1 response, or a human repaint(),
// landing genuinely after Enter) — so writeAt() must account for the settle bound too.
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
const SETTLE_BOUND = SETTLE_POLL * SETTLE_MAX_POLLS; // 50ms
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_FIRST_TURN_STALE_MS = String(FIRST_TURN_STALE);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
const writeAt = (k) => ENTER_DELAY + (k - 1) * VERIFY_TIMEOUT + (k === MAX_ATTEMPTS && k > 1 ? SETTLE_BOUND : 0);
const giveUpAt = () => writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT;

const { PtyHost } = await import("../dist/pty/host.js");

const BACKSPACE = "\x7f";
const BUSY_STALE_MS = 500; // small override for the post-first-turn (busySince) heal path — see scenario (2)

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
    // Test-only: synthetically fire an output chunk, exactly like a real engine's onData would — this is
    // how we force `live.lastOutputAt` to advance without ever confirming a turn (the false-suppress).
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
  return { fake, written: () => fake.writes.join(""), backspaceCount: () => fake.writes.join("").split(BACKSPACE).length - 1 };
}

try {
  // ===================== (1) FALSE-SUPPRESS on a session's FIRST turn: pre-fix leaves the composer =====
  // ===================== stranded forever; post-fix healIfStuck (FIRST_TURN_STALE_MS path) clears it ===
  {
    const host = new TestPtyHost(events);
    const SID = "sess-heal-firstturn";
    const TEXT = "STRANDED_FIRST_TURN_BODY"; // exact backspace count the clear must un-type
    const { fake, backspaceCount } = spawnReady(host, SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(1) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // Force the false-suppress: shortly after the FINAL attempt's own Enter write (but before that
    // attempt's own verify-timeout elapses), synthesize engine output. This makes
    // `lastOutputAt > enterWrittenAt` true for the final attempt WITHOUT any turn ever having started —
    // exactly the confound the probe found (our own re-assert response, or a viewer's repaint()).
    await sleepUntil(t0, writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT / 3);
    fake.emitData("\x1b[<u\x1b[>1u\x1b[>4;2m"); // the probe-observed provoked-response shape; the bytes don't matter, only that lastOutputAt advances

    await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
    check("(1) GIVE-UP SUPPRESSED: busy is STILL true past the normal give-up point (suppression fired)",
      busyLog[SID].at(-1) === true);
    check("(1) sanity: no clear was attempted AT give-up time (suppression skipped the give-up branch entirely)",
      backspaceCount() === 0);

    // Now let healIfStuck's stale-busy window elapse and drive the periodic heal directly — mirrors
    // index.ts's real setInterval-wired reconcile().
    await sleepUntil(t0, giveUpAt() + FIRST_TURN_STALE + FIRST_TURN_STALE / 2);
    host.reconcile();
    await sleep(50); // writeChunked's done callback fires on the next tick for a short burst
    check("(1) healIfStuck eventually recovers busy (the stale-busy self-heal still fires)",
      busyLog[SID].at(-1) === false);
    check(`(1) COMPLETED BACKSTOP: healIfStuck wrote exactly ${TEXT.length} backspaces to clear the orphaned injection`,
      backspaceCount() === TEXT.length);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (2) Same false-suppress, but on a session's SECOND turn (busySince/busyStaleMs =
  // ===================== path, not the first-turn path) — proves the fix isn't first-turn-special-cased ==
  {
    const host = new TestPtyHost(events, { busyStaleMs: BUSY_STALE_MS });
    const SID = "sess-heal-laterturn";
    const FIRST_TEXT = "FIRST_TURN_CONFIRMED_NORMALLY";
    const SECOND_TEXT = "STRANDED_SECOND_TURN_BODY";
    const { fake, backspaceCount } = spawnReady(host, SID);

    // Turn 1: confirm+end normally so firstTurnStarted flips true (post-fix healIfStuck now uses
    // `busyStaleMs`, not `FIRST_TURN_STALE_MS`, for every turn after this one).
    const r1 = host.enqueueStdin(SID, FIRST_TEXT);
    check("(2) setup: turn 1 delivered", r1.delivered === true && busyLog[SID].at(-1) === true);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(2) setup: turn 1 confirmed+ended normally", busyLog[SID].at(-1) === false);

    // Turn 2: force the same false-suppress as scenario (1).
    const t0 = Date.now();
    const r2 = host.enqueueStdin(SID, SECOND_TEXT);
    check("(2) setup: turn 2 delivered, busy armed", r2.delivered === true && busyLog[SID].at(-1) === true);
    await sleepUntil(t0, writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT / 3);
    fake.emitData("\x1b[<u\x1b[>1u\x1b[>4;2m");
    await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
    check("(2) GIVE-UP SUPPRESSED on turn 2 too", busyLog[SID].at(-1) === true);

    await sleepUntil(t0, giveUpAt() + BUSY_STALE_MS + BUSY_STALE_MS / 2);
    host.reconcile();
    await sleep(50);
    check("(2) healIfStuck (busyStaleMs path) eventually recovers busy", busyLog[SID].at(-1) === false);
    check(`(2) COMPLETED BACKSTOP on the busyStaleMs path too: exactly ${SECOND_TEXT.length} backspaces written`,
      backspaceCount() === SECOND_TEXT.length);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (3) MOST IMPORTANT — a session that legitimately went on to submit (a late but ==
  // ===================== real UserPromptSubmit arriving before staleMs elapses) must NEVER be heal-cleared
  {
    const host = new TestPtyHost(events);
    const SID = "sess-heal-legit-late-confirm";
    const TEXT = "LEGIT_TURN_SLOW_HOOK_BODY";
    const { fake, backspaceCount } = spawnReady(host, SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(3) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // Force the SAME suppression as scenario (1) — from the daemon's point of view this looks identical
    // to a genuine drop up to this point.
    await sleepUntil(t0, writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT / 3);
    fake.emitData("\x1b[<u\x1b[>1u\x1b[>4;2m");
    await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
    check("(3) GIVE-UP SUPPRESSED (same as scenario 1 up to here)", busyLog[SID].at(-1) === true);

    // Unlike scenario (1): the REAL hook eventually catches up BEFORE the FIRST_TURN_STALE_MS window
    // elapses — this is the ~79%-of-give-ups "slow hook, not a real drop" population 71de1f9c measured.
    // A real UserPromptSubmit sets enterConfirmed=true AND re-arms busySince (rising edge), so this
    // session must never reach healIfStuck's stale-busy branch at all.
    await sleepUntil(t0, giveUpAt() + FIRST_TURN_STALE / 4);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(3) the late-but-real turn confirmed and ended normally", busyLog[SID].at(-1) === false);

    // Now run reconcile() repeatedly across what WOULD have been the stale window for scenario (1) — must
    // be a complete no-op: busy is already false, nothing to heal, and CRITICALLY no backspace is ever
    // written (this is the assertion that fails if the `enterConfirmed` guard is ever removed from
    // healIfStuck — busySince/lastOutputAt alone are not enough to gate the clear).
    for (let i = 0; i < 4; i++) { host.reconcile(); await sleep(FIRST_TURN_STALE / 3); }
    check("(3) NO heal-time clear ever fired for a session that legitimately went on to submit",
      backspaceCount() === 0);
    check("(3) busy stayed false throughout (healIfStuck never re-triggered on the settled session)",
      busyLog[SID].at(-1) === false);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  // best-effort cleanup — each scenario used its own host instance
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — healIfStuck completes the give-up backstop (clears an orphaned composer left by a false suppression, on both the first-turn and later-turn stale paths) without ever touching a session that legitimately went on to submit."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
