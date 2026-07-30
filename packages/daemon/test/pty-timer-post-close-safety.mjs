import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c54d1ea0 — codescape-lifecycle-hooks.mjs's use-after-close race, generalized into a deterministic
// regression guard (RED first, no waiting on gate contention/timing luck to reproduce).
//
// THE BUG: pty/host.ts's readiness-fallback (READY_FALLBACK_MS, default 20s) and kickoff-guarantee
// (STARTUP_PROMPT_GRACE_MS, default 10s) timers exist to force a session to `ready`/submit its kickoff
// when a real claude process never sends the expected hooks — both guard purely on `live.alive`/
// `live.stopping`, exactly like every other stray timer in this file (escalateGracefulStop's timers use
// the identical pattern, deliberately: "each timer is an inert no-op" once alive flips false). That's
// SOUND in production: a real daemon's Db shares the whole process lifetime with PtyHost, and a real
// `pty.kill()` always fires the real node-pty exit event.
//
// It broke a TEST that (a) creates its OWN Db, (b) spawns a fake-pty session and never stops it before
// closing that Db, and (c) uses a fake pty whose `kill()` is a no-op. Under load (the reported failure
// was cap=2 concurrent=2 with contention), the block's real wall-clock crossed the ~30s combined window,
// the kickoff-guarantee timer fired `submit()` → `setBusy(true)` → the test's own `onBusy` handler →
// `Db.setBusy` → `prepare()` on the already-closed connection → the reported uncaught TypeError.
//
// THE FIX (test-side — codescape-lifecycle-hooks.mjs / codescape-mcp-spawn.mjs): every session id
// spawned in a block is now explicitly `stopSession(id, "hard")`-ed BEFORE that block's `db.close()`.
// `PtyHost.stop()` sets `live.stopping = true` SYNCHRONOUSLY — which alone is enough to keep both timers
// from ever reaching `submit()`/`setBusy` (scheduleKickoffGuarantee routes a `stopping` session through
// `enqueueStdin` instead, and `enqueueStdin`'s own immediate-submit branch is itself gated on
// `!live.stopping`). Both files' fake pty fixture was ALSO fixed so `kill()` genuinely invokes the
// `onExit` callback host.ts registers (mirroring a real node-pty exit) — the fixture's `onExit()` used to
// discard that callback entirely, which is real fixture debt independent of this specific crash (it left
// `PtyHost.stop()` structurally unable to ever flip `live.alive` false for these fake sessions) but is
// NOT what actually prevents this crash; the `stopping` guard is. This test exercises the FIXED fixture,
// matching what both files now ship.
//
// (RED / positive control) a session that is NEVER stopped before its Db closes — reproducing exactly
//   what a never-torn-down session (e.g. codescape-lifecycle-hooks.mjs's `mgr`, which this card traced
//   the crash to) does — DOES reach the closed Db and throw. Proves this check can genuinely fail; a
//   check that can't fail isn't a check.
// (GREEN / the fix) a session that IS `stop()`-ped before its Db closes never reaches it, deterministically.
//
// Grace/fallback windows are read at import time — set tiny here so both timers are FORCED to fire well
// within this test's own bounded wait; no gate contention or timing luck needed to reproduce.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpHome = path.join(os.tmpdir(), `loom-pty-timer-close-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_READY_FALLBACK_MS = "20";
process.env.LOOM_STARTUP_PROMPT_GRACE_MS = "20";

const { PtyHost } = await import("../dist/pty/host.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors better-sqlite3's real `TypeError: The database connection is not open` (the exact throw the
// reported crash hit at Db.setBusy → Database.prepare) without needing a real sqlite file — deterministic
// open/close state under the test's own control.
class FakeDb {
  constructor() { this.open = true; this.busyCalls = []; }
  close() { this.open = false; }
  setBusy(id, busy) {
    if (!this.open) throw new TypeError("The database connection is not open");
    this.busyCalls.push({ id, busy });
  }
}

// The FIXED fake pty — kill() genuinely invokes the onExit callback host.ts registers, exactly like
// codescape-lifecycle-hooks.mjs's / codescape-mcp-spawn.mjs's post-fix SeamHost.
function makeFixedFakePty() {
  let exitCb = null;
  return {
    pid: 4242, write() {},
    onData() { return { dispose() {} }; },
    onExit(cb) { exitCb = cb; return { dispose() {} }; },
    kill() { exitCb?.({ exitCode: 0 }); },
    resize() {},
  };
}

async function runScenario(label, { stopBeforeClose }) {
  const db = new FakeDb();
  let caught = null;
  class TestHost extends PtyHost { createPty() { return makeFixedFakePty(); } }
  const host = new TestHost({
    onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
    onBusy(id, busy) { try { db.setBusy(id, busy); } catch (e) { caught = e; } },
  });

  const sessionId = `pty-timer-${label}`;
  host.spawn({
    sessionId, cwd: tmpHome, startupPrompt: "orchestrate task tk",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  // Never deliver SessionStart/UserPromptSubmit/Stop — the fake session never reaches a real turn, so
  // BOTH the readiness fallback and the kickoff guarantee are forced onto their own timers, exactly the
  // "CLI's own auto-submit never lands" shape scheduleKickoffGuarantee's own doc comment describes.

  if (stopBeforeClose) host.stop(sessionId, "hard");
  db.close();

  // Bounded wait past BOTH windows (READY_FALLBACK_MS + STARTUP_PROMPT_GRACE_MS, ~40ms combined here)
  // with generous slack — long enough for the full timer chain to fire if it's going to, without needing
  // real gate contention.
  await sleep(500);

  try { host.stop(sessionId, "hard"); } catch { /* best-effort cleanup regardless of scenario outcome */ }
  return caught;
}

const neverStoppedCaught = await runScenario("never-stopped", { stopBeforeClose: false });
check("(RED / positive control) a session NEVER stopped before its Db closes reaches the closed Db and throws — proves this check can genuinely fail",
  neverStoppedCaught instanceof TypeError && /database connection is not open/i.test(neverStoppedCaught.message));

const stoppedCaught = await runScenario("stopped-first", { stopBeforeClose: true });
check("(GREEN / the fix) a session stop()-ped BEFORE its Db closes never reaches it — no throw",
  stoppedCaught === null);

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — pty/host.ts's readiness-fallback + kickoff-guarantee timers reach a session's onBusy handler if (and only if) that session was never stopped before its owning resource (here, a Db standing in for the real one) closed; explicitly stopping every live session before teardown — the fix codescape-lifecycle-hooks.mjs / codescape-mcp-spawn.mjs now both apply — deterministically prevents it, with no dependence on gate contention or timing luck to prove either direction."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
