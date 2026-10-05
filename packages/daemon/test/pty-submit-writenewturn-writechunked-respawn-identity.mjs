// Hermetic regression test for card c228b237 — submit()'s `writeNewTurn` closure (the paste-bracket
// writer) AND `writeChunked`'s own internal chunk-burst `step()` (pty/host.ts) must bind to the `Live`
// they started on BY IDENTITY, never re-derive it from `this.live.get(sessionId)` inside a deferred
// callback. Same bug class as card 17339316 (see docs/decisions/17339316-enter-verify-timers-pinned-to-
// live-identity.md), found while fixing it — see docs/decisions/c228b237-writenewturn-and-writechunked-
// pinned-to-live-identity.md for the full record.
//
// THE DEFECT (confirmed at source, fixed by this card): `writeChunked`'s `step()` used to re-fetch `live`
// via `this.live.get(sessionId)` on every chunk tick, and `writeNewTurn`'s own entry check + its deferred
// writeChunked `done` callback did the same. A same-id respawn (worker_recycle/resume/fork) replaces
// `this.live`'s map entry for `sessionId` with a brand-new `Live`; an orphaned burst/callback left running
// from the OLD generation would re-fetch the NEW generation's `Live`, pass its `alive` check, and keep
// writing — the stale turn's remaining BODY/backspace chunks, then the bracket-end marker — into the NEW
// generation's real pty.
//
// THE FIX: `writeChunked` captures `pinned = this.live.get(sessionId)` once at entry and `step()` bails via
// `if (this.live.get(sessionId) !== pinned) return;` BEFORE writing a chunk or calling `finish()`/`done` (a
// respawn never gets the old caller's `done`, unlike the not-alive/killed path, which still fires it — see
// the decision record for why). `writeNewTurn` bails the same way against the `live` it already closes over
// from submit()'s own scope (no new parameter needed, unlike the Enter-verify chain).
//
// THREE SCENARIOS, each proving the same invariant — a session (gen2) that never submits/writes anything of
// its own receives ZERO pty writes from an orphaned gen1 chain across a respawn. All three actually exercise
// ONLY `writeChunked`'s own `step()` identity check (card c228b237's "site 1") under a different call path —
// `writeNewTurn`'s own two checks ("site 2", its entry re-fetch, and "site 3", its deferred `done`-callback
// re-fetch) are UNREACHABLE defense-in-depth once site 1 is fixed: `step()` never calls `done` across a
// mismatch, so `writeNewTurn` can never actually observe one, in ANY of A/B/C below (confirmed by mutation
// testing — reverting both writeNewTurn checks together still leaves this suite green). See the decision
// record's site-2/3 bullets, and scenario D below for the one thing this suite DOES prove about `done` itself.
//   A. submit()'s writeNewTurn: a multi-chunk MESSAGE BODY mid-flight through writeChunked when gen1 is
//      respawned (exercises writeChunked's step() re-fetch; does NOT reach writeNewTurn's deferred `done`
//      callback mismatch branch — step() already stops calling it first).
//   B. submit()'s defensive clear-prefix: a composerDirtyLen>0 backspace burst (writeNewTurn used as that
//      burst's OWN `done` callback, exercising the SAME step() re-fetch as A — not writeNewTurn's own
//      entry check, "site 2", for the same reason) mid-flight when gen1 is respawned.
//   C. writeStdin's own chunked burst (shared writeChunked call, no `done`) mid-flight when gen1 is
//      respawned — plus a POSITIVE regression check that an *unrespawned* multi-chunk writeStdin still
//      delivers every chunk, in order, reconstructing the original text (the fix must not break delivery).
//
// A FOURTH scenario (D) calls writeChunked directly with a spy `done` and asserts the spy is never invoked
// across a respawn — the one assertion in this suite that actually exercises `done`'s own respawn behavior
// (card c228b237's "Do not call finish()/done from writeChunked's step() on a respawn"), proven against a
// real positive control (a stopped Live's writeChunked DOES fire `done` synchronously on its not-alive exit).
//
// TEST DESIGN (avoids a self-inflicted race, mirrors pty-enter-verify-timers-respawn-identity.mjs): gen2 in
// each scenario never calls submit()/enqueueStdin/writeStdin itself, so ANY write landing on its fake pty
// during the observation window is unambiguously attributable to the orphaned gen1 chain.
//
// HERMETIC, claude-free — a fake pty at the createPty() seam. No real claude, no daemon, no network.
//
// RUN: pnpm build (from packages/daemon) then `node test/pty-submit-writenewturn-writechunked-respawn-identity.mjs`.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNeverWithControl } from "./_timing-guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForCount(getCount, target, timeoutMs = 5000) {
  const t0 = Date.now();
  while (getCount() < target) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitForCount: timed out waiting for count to reach ${target} (stuck at ${getCount()})`);
    await sleep(2);
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-writenewturn-respawn-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Small chunk size + a real delay between ticks — spans the body/backspace burst across many setTimeout
// ticks so there's plenty of real time to respawn mid-burst deterministically (via waitForCount), unlike
// the production default (1024B/8ms) which would require a much larger payload to get the same margin.
const CHUNK_BYTES = 20;
const CHUNK_DELAY_MS = 25;
const ENTER_DELAY = 20; // mirrors LOOM_SUBMIT_ENTER_DELAY_MS — not load-bearing for these scenarios
process.env.LOOM_PTY_WRITE_CHUNK_BYTES = String(CHUNK_BYTES);
process.env.LOOM_PTY_WRITE_CHUNK_DELAY_MS = String(CHUNK_DELAY_MS);
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
const OBSERVE_MARGIN_MS = 400;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = new Map(); // sessionId -> fake (last spawn wins, like fakes[] in the sibling test)
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => writes.push(d), onData: () => ({ dispose() {} }), writes };
    fakes.set(opts.sessionId, fake);
    return fake;
  }
}
const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {}, onRateLimited() {}, onExit() {},
};
const host = new TestPtyHost(events);

function spawnFresh(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake = fakes.get(sessionId);
  host.deliverHook(sessionId, { hook_event_name: "SessionStart", session_id: `eng-${sessionId}-gen1` });
  return { fake, live: host.live.get(sessionId) };
}
function respawn(sessionId, genTag) {
  // `cwd` is REQUIRED here (not merely for realism): PtyHost.spawn()'s own non-codex branch calls
  // removeStaleCodexDoctrineArtifact(opts.cwd, ...) fire-and-forget, and an undefined cwd throws inside
  // path.join — an unhandled rejection that crashes the whole test process once the event loop gets a
  // turn (observed directly: omitting cwd here crashes deterministically once this test's own
  // assertNeverWithControl wait gives the microtask queue time to run).
  host.spawn({
    sessionId, cwd: tmpHome, resumeId: `eng-${sessionId}-${genTag}`,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    resumeModeTarget: "acceptEdits",
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake = fakes.get(sessionId);
  host.deliverHook(sessionId, { hook_event_name: "SessionStart", session_id: `eng-${sessionId}-${genTag}` });
  return { fake, live: host.live.get(sessionId) };
}

async function runLeakScenario({ label, sessionId, armGen1, waitBeforeRespawn, windowMs }) {
  const { fake: gen1Fake, live: gen1Live } = spawnFresh(sessionId);
  armGen1(gen1Live, gen1Fake, sessionId);
  await waitBeforeRespawn(gen1Fake, gen1Live);

  const { fake: gen2Fake, live: gen2Live } = respawn(sessionId, "gen2");
  check(`[${label}] respawn minted a genuinely NEW Live and a NEW fake pty`,
    gen2Live !== gen1Live && gen2Fake !== gen1Fake);
  check(`[${label}] gen2 is ready/idle and never submits/writes anything of its own`,
    gen2Live.busy === false && gen2Fake.writes.length === 0);

  const controlSid = `${sessionId}-control`;
  const { fake: controlFake } = spawnFresh(controlSid);
  let probe = { fake: controlFake };
  const anyLeak = () => probe.fake.writes.length > 0;

  const noLeak = await assertNeverWithControl({
    label: `[${label}] the orphaned gen1 chain never writes into gen2's pty`,
    check: anyLeak,
    windowMs,
    intervalMs: 10,
    positiveControl: async () => {
      const before = anyLeak();
      host.writeStdin(controlSid, "positive-control-probe-write"); // real production write surface
      const wentRed = !before && anyLeak();
      probe = { fake: gen2Fake }; // retarget to the real target only AFTER the control resolved
      return wentRed;
    },
  });
  check(`[${label}] no orphaned write ever landed on gen2's pty, proven against a real positive control`,
    noLeak);
  check(`[${label}] gen2's pty received ZERO writes total (nothing else could have written to it)`,
    gen2Fake.writes.length === 0);

  try { host.stop(controlSid, "hard"); } catch { /* ignore */ }
  try { host.stop(sessionId, "hard"); } catch { /* ignore */ }
}

try {
  // ---- Scenario A: a multi-chunk MESSAGE BODY mid-flight through writeChunked, respawned mid-burst ----
  // 9 chunks of CHUNK_BYTES=20 (180 chars) at CHUNK_DELAY_MS=25 each — respawn after 2 land, leaving 7
  // chunks (plus the bracket-end + Enter-delay tail) that a pre-fix writeChunked/writeNewTurn would
  // misdirect into gen2's pty.
  const TEXT_A = "A".repeat(180);
  await runLeakScenario({
    label: "A: writeNewTurn body chunking",
    sessionId: "sess-wnt-respawn-a",
    armGen1: (live, fake, sid) => {
      const r = host.enqueueStdin(sid, TEXT_A);
      check("(A setup) gen1's message delivered via the immediate-submit path, busy armed",
        r.delivered === true && busyLog[sid]?.at(-1) === true);
    },
    waitBeforeRespawn: async (fake) => {
      // bracket-start (1) + at least 2 body chunks landed, with 9 - 2 = 7 chunks still pending.
      await waitForCount(() => fake.writes.length, 3);
    },
    windowMs: CHUNK_DELAY_MS * 10 + ENTER_DELAY + OBSERVE_MARGIN_MS,
  });

  // ---- Scenario B: the defensive clear-prefix (composerDirtyLen>0) backspace burst, respawned mid-burst.
  // ---- `writeNewTurn` itself is deferred as THIS burst's own `done` callback, which exercises the SAME
  // ---- writeChunked step() re-fetch as scenario A (site 1) — NOT writeNewTurn's own entry check (site 2),
  // ---- which never observes a mismatch here either; see the test header above.
  const BODY_B = "B".repeat(60); // 3 more chunks once writeNewTurn eventually fires
  await runLeakScenario({
    label: "B: backspace-burst-deferred writeNewTurn",
    sessionId: "sess-wnt-respawn-b",
    armGen1: (live, fake, sid) => {
      // Field-poking (same technique pty-enter-verify-timers-respawn-identity.mjs / pty-prompt-mismatch.mjs
      // already use) to force submit() into its composerDirtyLen>0 && composerLen===0 defensive-clear
      // branch (3ce3fa39) — NOT the give-up-redelivery branch, since `origin` is omitted below.
      live.composerDirtyLen = 100; // 5 backspace chunks at CHUNK_BYTES=20
      live.composerDirtyLenBelieved = 100;
      const r = host.enqueueStdin(sid, BODY_B);
      check("(B setup) gen1's message delivered via the immediate-submit path, busy armed",
        r.delivered === true && busyLog[sid]?.at(-1) === true);
    },
    waitBeforeRespawn: async (fake) => {
      // bracket-start... no: the backspace burst itself has NO leading bracket-start write (that only
      // happens once writeNewTurn fires). Wait for 2 of the 5 backspace chunks, leaving 3 pending plus
      // writeNewTurn's own bracket-start + BODY_B's 3 chunks + bracket-end, all still to come.
      await waitForCount(() => fake.writes.length, 2);
    },
    windowMs: CHUNK_DELAY_MS * 8 + CHUNK_DELAY_MS * 3 + ENTER_DELAY + OBSERVE_MARGIN_MS,
  });

  // ---- Scenario C: writeStdin's own chunked burst (shared writeChunked, no `done`), respawned mid-burst
  const TEXT_C = "C".repeat(140); // 7 chunks
  await runLeakScenario({
    label: "C: writeStdin raw chunking",
    sessionId: "sess-wnt-respawn-c",
    armGen1: (live, fake, sid) => { host.writeStdin(sid, TEXT_C); },
    waitBeforeRespawn: async (fake) => {
      await waitForCount(() => fake.writes.length, 2); // 5 of 7 chunks still pending
    },
    windowMs: CHUNK_DELAY_MS * 10 + OBSERVE_MARGIN_MS,
  });

  // ---- Scenario C's positive regression check: an UNRESPAWNED multi-chunk writeStdin must still deliver
  // every chunk, in order, reconstructing the original text exactly — the fix must not break delivery.
  const TEXT_OK = "The quick brown fox jumps over the lazy dog. ".repeat(4); // > one chunk, ASCII-only
  const { fake: okFake } = spawnFresh("sess-wnt-respawn-c-ok");
  await new Promise((resolve) => {
    host.writeStdin("sess-wnt-respawn-c-ok", TEXT_OK);
    const deadline = Date.now() + CHUNK_DELAY_MS * 20 + OBSERVE_MARGIN_MS;
    const poll = () => {
      if (okFake.writes.join("").length >= TEXT_OK.length || Date.now() > deadline) { resolve(); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
  check("(C regression) an unrespawned multi-chunk writeStdin delivers every chunk, in order, " +
    "reconstructing the original text exactly", okFake.writes.join("") === TEXT_OK);
  check("(C regression) delivery actually spanned more than one chunk (the check above isn't vacuous)",
    okFake.writes.length > 1);
  try { host.stop("sess-wnt-respawn-c-ok", "hard"); } catch { /* ignore */ }

  // ---- Scenario D: writeChunked's own `done` spy, called DIRECTLY (bypassing submit()/writeStdin), must
  // ---- NEVER fire across a respawn — card c228b237's "Do not call finish()/done from writeChunked's
  // ---- step() on a respawn (identity mismatch)". This is the one assertion in this suite that actually
  // ---- exercises `done`'s own respawn behavior (A/B/C above only ever observe gen2's pty writes).
  const sidD = "sess-wnt-respawn-d";
  const TEXT_D = "D".repeat(140); // 7 chunks
  const { fake: fakeD } = spawnFresh(sidD);
  let doneCallsD = 0;
  host.writeChunked(sidD, TEXT_D, () => { doneCallsD++; });
  await waitForCount(() => fakeD.writes.length, 2); // 5 of 7 chunks still pending

  const { live: gen2LiveD } = respawn(sidD, "gen2");
  check("[D setup] respawn minted a genuinely new Live", host.live.get(sidD) === gen2LiveD);

  const noDoneLeak = await assertNeverWithControl({
    label: "[D] writeChunked's done spy is never called across a respawn",
    check: () => doneCallsD > 0,
    windowMs: CHUNK_DELAY_MS * 10 + OBSERVE_MARGIN_MS,
    intervalMs: 10,
    positiveControl: async () => {
      // A stopped (not-alive) Live's writeChunked DOES fire `done` synchronously on its not-alive exit
      // (card 9ed20572) — proves the spy mechanism itself is capable of going "red" before trusting its
      // silence in the real run above.
      const sidControl = `${sidD}-control`;
      spawnFresh(sidControl);
      host.stop(sidControl, "hard");
      let controlFired = false;
      host.writeChunked(sidControl, "control-text", () => { controlFired = true; });
      return controlFired;
    },
  });
  check("[D] no stray done-callback fire ever landed across the respawn, proven against a real positive control",
    noDoneLeak);
  check("[D] the done spy fired exactly zero times total", doneCallsD === 0);
  try { host.stop(sidD, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — writeChunked's own internal chunk-burst step() identity check (card c228b237's " +
    "\"site 1\") holds across a same-id respawn under three distinct call paths (writeNewTurn's body " +
    "write, the defensive backspace burst, and writeStdin's raw chunking): an orphaned burst left running " +
    "across a respawn can no longer write stale chunks — body, backspace, or bracket markers — into the " +
    "new generation's real pty, and its `done` callback itself is never fired across that same mismatch " +
    "(scenario D). writeNewTurn's own two checks (\"site 2\"/\"site 3\") are UNREACHABLE defense-in-depth " +
    "that no scenario here exercises — site 1 already filters any mismatch before either could ever " +
    "observe one — and an unrespawned multi-chunk write still delivers in full, in order."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
