// Hermetic regression test for the give-up CLEAR (pty/host.ts sendEnterAndVerify, card ee082fbb).
//
// When submit()'s Enter never confirms after SUBMIT_MAX_ATTEMPTS, the session gives up and recovers
// busy (card 9549e322) — but until now it left the stranded injection sitting in the composer, so the
// NEXT turn would concatenate onto it. This test guards the fix: on give-up, the host writes an exact
// Backspace(`\x7f`) burst — one per character of the injected text (`live.lastPrompt`) — to un-type it,
// but ONLY when `composerLen === 0` proves the composer holds NOTHING but that stranded injection (no
// human draft was ever touched, so the human-draft-preservation guard, card e1829591, is never at risk).
//
// The exact clear MECHANISM (why exact-backspace, not a blind Ctrl-U/Esc) was validated against a REAL
// claude engine — see test/_probe-composer-clear.mjs and _probe-composer-clear-2.mjs (manual, not part
// of this hermetic suite; requires a logged-in `claude`). Findings baked into this fix, summarized in the
// sendEnterAndVerify doc comment: the TUI collapses a long/multi-line paste into a single placeholder
// token; Ctrl-U cleared that placeholder but SILENTLY STRANDED earlier lines of a short un-collapsed
// multi-line paste (confirmed via the engine's own transcript); Esc needed a second press and left the
// composer worse off combined with another key; exact-backspace reliably emptied every case tested.
//
// This hermetic test can only assert the BYTES-WRITTEN half (a fake pty can't model Ink's paste/composer
// state machine) — it proves the daemon writes the RIGHT clear byte count IFF composerLen===0, and never
// touches the pty on a give-up while a human draft is present. The real-engine half is the probe above.
//
// RUN (no daemon needed): node test/pty-giveup-clear.mjs
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

const tmpHome = path.join(os.tmpdir(), `loom-giveupclear-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
const writeAt = (k) => ENTER_DELAY + (k - 1) * VERIFY_TIMEOUT;
const giveUpAt = () => writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT;

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
// Deterministic (non-timing-based) capture for scenario (4): when armed for a session id, records the
// backspace count AT THE EXACT MOMENT each onBusy event fires for it — synchronous with the event, so it
// can never race wall-clock scheduling. `getCount` is set per-scenario (a fresh closure over that
// scenario's own fake pty), avoided globally since each scenario spawns its own fake.
const busySnapshot = { sid: null, getCount: null, events: [] };
const events = {
  onEngineSessionId() {},
  onBusy(id, busy) {
    (busyLog[id] ??= []).push(busy);
    if (id === busySnapshot.sid) busySnapshot.events.push({ busy, count: busySnapshot.getCount() });
  },
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
  return { fake, written: () => fake.writes.join(""), backspaceCount: () => fake.writes.join("").split(BACKSPACE).length - 1 };
}

try {
  // ===================== (1) composer-clean give-up → the stranded injection IS cleared =====================
  {
    const SID = "sess-giveup-clean";
    const TEXT = "STRANDED_REPORT_BODY"; // 20 chars — the exact count the clear must un-type
    const { written, backspaceCount } = spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(1) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // Never deliver ANY confirming hook, and never touch the raw composer (composerLen stays 0 the whole
    // time — the daemon's own pty.write from submit() never counts toward it). Wait past give-up.
    await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
    check("(1) GIVE-UP RECOVERY: busy fell back to false", busyLog[SID].at(-1) === false);
    check(`(1) CLEAR: exactly ${TEXT.length} backspaces were written to un-type the stranded injection`,
      backspaceCount() === TEXT.length);
    // Sanity: the clear bytes land AFTER the give-up point in the write stream (not mixed into the retry
    // Enters/paste-reasserts that preceded it).
    const giveUpTailIdx = written().lastIndexOf(TEXT) + TEXT.length; // rough anchor: after the body's last occurrence
    const firstBackspaceIdx = written().indexOf(BACKSPACE);
    check("(1) the backspace burst appears AFTER the turn body in the write stream", firstBackspaceIdx > giveUpTailIdx - TEXT.length);
  }

  // ===================== (2) HUMAN-DRAFT SAFETY: composer-dirty give-up → NEVER cleared =====================
  {
    const SID = "sess-giveup-dirty";
    const TEXT = "ANOTHER_STRANDED_REPORT";
    const { written, backspaceCount } = spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(2) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // A human starts typing a draft partway through the failed retries — composerLen goes >0. This must
    // be treated EXACTLY like a genuine human draft (card e1829591: never destroy a user's uncommitted
    // draft) even though what's actually in the real TUI composer right now is the daemon's OWN stranded
    // paste (writeStdin can't distinguish the two — that's the whole point of the composerLen===0 gate:
    // it conservatively assumes a human might be mid-edit and refuses to touch the box at all).
    await sleepUntil(t0, writeAt(1) + VERIFY_TIMEOUT / 2);
    host.writeStdin(SID, "h"); // one printable char → composerLen becomes 1 ("composer-dirty")

    await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
    check("(2) GIVE-UP RECOVERY: busy still falls back to false even when dirty", busyLog[SID].at(-1) === false);
    check("(2) HUMAN-DRAFT SAFETY: NO backspace clear was written while composerLen > 0",
      backspaceCount() === 0);
    check("(2) sanity: the human's own keystroke DID reach the pty (writeStdin never withholds real human bytes)",
      written().includes("h"));
  }

  // ===================== (3) confirmed turn (no give-up) → NEVER clears (existing happy path intact) =====
  {
    const SID = "sess-confirmed-no-giveup";
    const TEXT = "CONFIRMED_NORMALLY";
    const { backspaceCount } = spawnReady(SID);
    const r = host.enqueueStdin(SID, TEXT);
    check("(3) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(3) turn confirmed+ended normally", busyLog[SID].at(-1) === false);
    await sleep(VERIFY_TIMEOUT + VERIFY_TIMEOUT / 2); // well past where a give-up would have fired if the fix mis-armed
    check("(3) NO clear byte was ever written on a normally-confirmed turn (give-up path never triggers)",
      backspaceCount() === 0);
  }

  // ===================== (4) LARGE injection (multi-chunk burst) → busy stays true until the WHOLE =====
  // ===================== backspace burst finishes, not just its first chunk (card ee082fbb CR item ①) ===
  // writeChunked (host.ts) is only SYNCHRONOUS up to PTY_WRITE_CHUNK_BYTES (1024, not env-overridable) —
  // a larger burst spans multiple 8ms-apart ticks. The fix threads setBusy(false) through writeChunked's
  // `done` callback (fired after the LAST chunk) instead of calling it alongside the (non-blocking) burst
  // kickoff — otherwise busy would drop mid-burst, reopening enqueueStdin's immediate-submit gate onto a
  // pty FIFO that still has trailing backspace chunks queued behind it (a silent interleaved-turn race).
  {
    const SID = "sess-giveup-large";
    const TEXT = "X".repeat(50 * 1024); // 50 chunks of 1024 — several event-loop ticks worth of burst
    const { backspaceCount } = spawnReady(SID);
    // Arm the deterministic snapshot for THIS session: onBusy(SID, *) will now also record the backspace
    // count synchronous with the event itself — no wall-clock guessing needed (a fixed offset would have
    // to account for pasteSettleExtraMs's paste-size-scaled initial delay AND the chunk-pacing timers,
    // and would still be racy under host jitter; this is exact regardless of either).
    busySnapshot.sid = SID;
    busySnapshot.getCount = backspaceCount;
    const r = host.enqueueStdin(SID, TEXT);
    check("(4) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    // Poll (generously bounded, not timing-precise) until give-up's busy=false has landed.
    const t0 = Date.now();
    while (busyLog[SID].at(-1) !== false && Date.now() - t0 < 15_000) await sleep(50);
    check("(4) give-up eventually recovered busy (bounded poll didn't time out)", busyLog[SID].at(-1) === false);

    check("(4) the FULL burst landed by the time give-up completed (all TEXT.length backspaces written)",
      backspaceCount() === TEXT.length);
    const falseEvents = busySnapshot.events.filter((e) => e.busy === false);
    check("(4) exactly one busy=false event was recorded for this session", falseEvents.length === 1);
    check("(4) busy is cleared ONLY AFTER the burst fully completes (setBusy threaded through writeChunked's done) — " +
      `snapshot at the busy=false event showed ${falseEvents[0]?.count} of ${TEXT.length} backspaces`,
      falseEvents[0]?.count === TEXT.length);
    // Sanity: this is a MULTI-chunk burst (proves the snapshot mechanism is actually exercising the race
    // window this test guards, not trivially passing because the whole burst fit in one synchronous chunk).
    check("(4) sanity: the burst genuinely spanned multiple chunks (TEXT exceeds one PTY_WRITE_CHUNK_BYTES)",
      TEXT.length > 1024);
  }
} finally {
  for (const sid of ["sess-giveup-clean", "sess-giveup-dirty", "sess-confirmed-no-giveup", "sess-giveup-large"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — give-up clears the stranded injection with an exact-count Backspace burst IFF composerLen===0 (a human draft mid-retry is NEVER touched), and a normally-confirmed turn never triggers a clear."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
