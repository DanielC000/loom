// Regression test for card 7a64f16b round 2 (Code Review MAJOR, blocking) — content ancestry must key off
// the generation of the last ACTUAL submit() write, never the raw `live.submitGeneration` counter, because
// `healIfStuck` (pty/host.ts, ~11201-11234) bumps `submitGeneration++` WITHOUT ever writing anything, then
// calls `requeueGiveUpOrigin` (which NULLS `live.giveUpOrigin`) while `enterConfirmed` stays false and
// `lastPrompt` stays the stranded lineage's own text.
//
// THE BUG round 1's fix had: with the ancestry check keyed on `resolvedBatchId === live.submitGeneration`,
// a heal firing between L1's give-up and L1's own genuine late echo bumps `submitGeneration` to a value
// L1's own archived batchId no longer equals — `live.giveUpOrigin` is also null (healIfStuck nulled it,
// via requeueGiveUpOrigin, without ever supplying a NEW write's own origin) — so BOTH arms of the ancestry
// check read false, and L1's own genuine late echo is wrongly DECLINED. The Code Reviewer reproduced this
// exact shape (an 8s hold, `genBeforeHeal=1 genNow=2 ... DECLINED ... duplicateStillQueued=true`) and
// confirmed it disappears with the decline check removed entirely — i.e. round 1's fix, unpatched for
// this, actively regressed a genuine recovery that worked before this card existed at all.
//
// THE FIX: a new field, `Live.lastWriteGeneration`, stamped ONLY at submit()'s own `const gen =
// ++live.submitGeneration` (the one site that is an actual write) — never at any of the three OTHER
// `submitGeneration++` sites (healIfStuck here, `stop()`, `interruptForRedirect` — all three bump the
// counter purely to invalidate a stale verify-retry chain, none of them write anything). The ancestry
// check now compares a matched entry's own batchId against `lastWriteGeneration`, which a no-write heal
// bump can never move.
//
// HARNESS NOTE: `pty-healifstuck-clear.mjs` forces its false-suppress via a fake pty's `emitData` call,
// precisely timed against real `setTimeout`s, to make `lastOutputAt` advance without any turn ever
// confirming. This file does not need that choreography — `healIfStuck`'s own guard is a bare staleness
// check (`now - busySince > staleMs && now - lastOutputAt > staleMs`), so directly backdating
// `live.busySince`/`live.lastOutputAt` on the live, mutable `Live` object (reachable via `host.live.get`)
// triggers the SAME out-of-band heal branch deterministically, on the very next `host.reconcile()` call —
// no real-time wait, no synthetic engine output, and no risk of racing the real verify-timeout timers
// (LOOM_SUBMIT_MAX_ATTEMPTS is set generously high here specifically so the NORMAL give-up path, which
// clears busy on its own, never gets a chance to fire first and mask what this test is isolating).
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon,
//   pnpm build && node test/pty-giveup-lone-signature-ancestry-heal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-7a64f16b-heal-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "5"; // generously high — the heal must fire before the normal give-up path gets a chance to
process.env.LOOM_GIVE_UP_HOLD_MS = "5000"; // generous — this test resolves well inside the hold, no sleep in between
process.env.LOOM_FIRST_TURN_STALE_MS = "100";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.warn = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleWarn(...args); };

const busyLog = {};
const events = { onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {} };
class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    return { ...base, write: (d) => { writes.push(d); }, writes };
  }
}
const host = new SilentTestPtyHost(events);

function spawnReady(sessionId) {
  host.spawn({ sessionId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

try {
  const SID = "sess-heal-ancestry";
  const TEXT = "GENUINE_LATE_ECHO_AFTER_A_HEAL_MUST_STILL_RESOLVE";
  spawnReady(SID);
  const live = host.live.get(SID);

  host.enqueueStdin(SID, TEXT, "system", undefined, undefined, "agent");
  check("(setup) L1 delivered, busy armed", busyLog[SID]?.at(-1) === true);
  check("(setup) genBeforeHeal === 1 (both counters agree before any heal)",
    live.submitGeneration === 1 && live.lastWriteGeneration === 1);

  // Force healIfStuck's out-of-band stale-busy branch to fire on the NEXT reconcile() — directly, no
  // real-time wait and no fake engine output (see HARNESS NOTE above).
  live.busySince = Date.now() - 999_999;
  live.lastOutputAt = Date.now() - 999_999;
  host.reconcile();

  check("(setup) heal bumped submitGeneration WITHOUT writing — lastWriteGeneration stays at L1's own write",
    live.submitGeneration === 2 && live.lastWriteGeneration === 1);
  check("(setup) heal nulled giveUpOrigin (requeueGiveUpOrigin's own consume-once handoff)", live.giveUpOrigin === null);
  check("(setup) heal cleared busy", live.busy === false);
  check("(setup) heal archived L1 via the SAME give-up restore the normal path uses",
    submitLog.some((l) => l.includes("GIVE-UP RECOVERY: re-queued")));
  const l1LogicalId = host.getPendingEntries(SID)[0]?.id;
  check("(setup) L1 has a requeued (held) duplicate sitting in pending", l1LogicalId !== undefined);

  // L1's GENUINE late echo now arrives — content ancestry must resolve it (self-confirmation: L1's own
  // archived batchId, 1, equals `lastWriteGeneration`, 1 — the no-write heal bump to `submitGeneration`
  // (now 2) must never be read as "a different write happened").
  submitLog.length = 0;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT });

  check("(THE FIX) L1's genuine late echo RESOLVES (content-matched CONFIRMED), not declined",
    submitLog.some((l) => l.includes(`CONFIRMED logicalId=${l1LogicalId}`) && l.includes("content-matched")));
  check("(THE FIX) NOT declined — the bug round 1's fix would have introduced here",
    !submitLog.some((l) => l.includes("DECLINED content match")));
  check("(THE FIX) L1's requeued duplicate is purged (resolved, not left stranded)",
    !host.getPendingEntries(SID).some((m) => m.id === l1LogicalId));

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 7a64f16b round 2: a heal's out-of-band submitGeneration bump (no write) never "
    + "masquerades as a new write for content-ancestry purposes — L1's own genuine late echo still "
    + "resolves after a heal, exactly as it did before this card existed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
