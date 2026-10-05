// Hermetic regression test for card 17339316 — the Enter-verify submit chain
// (sendEnterAndVerify/awaitReassertSettle/awaitGiveUpConfirmSettle/fireEnterAndVerify, pty/host.ts) must
// bind to the `Live` it started on BY IDENTITY, never re-derive it from `this.live.get(sessionId)` inside
// a timer callback.
//
// THE DEFECT (suspected, confirmed at source, fixed by this card): every link in this chain used to
// re-fetch `live` via `this.live.get(sessionId)` and key staleness ONLY on `live.submitGeneration !== gen`.
// `Live.submitGeneration` restarts at 0 on every fresh `Live` (a same-id respawn — worker_recycle/resume/
// fork — overwrites `this.live`'s map entry with a brand-new object), so an orphaned chain left running
// from the OLD generation could re-fetch the NEW generation's `Live` and find its own stale `gen`
// coincidentally matching the new session's own first submit (`++0 === 1`, the same value the old chain's
// own first submit produced) — causing an extra Enter write, a wrong retry count, or an early
// `setBusy(false)`/`requeueGiveUpOrigin` against the WRONG (new) session's real, unrelated, in-flight turn.
//
// THE FIX: every link now takes the originating `boundLive: Live` as an explicit parameter and bails via
// `if (this.live.get(sessionId) !== boundLive) return;` at its own top — mirroring `dismissMcpPrompt`/
// `runCycleToMode`'s own identity binding (card 096231e8) and `escalateGracefulStop`/
// `armCodexBusyStaleTimer`'s structural safety (closing over `live` directly, never re-fetching it).
//
// TEST DESIGN (avoids a self-inflicted race): gen2 is given NO Enter-verify chain of its OWN — its fields
// are set directly (mirroring the field-poking already used elsewhere in this suite, e.g.
// pty-prompt-mismatch.mjs's `host.live.get(sid).enterConfirmed = false`) to the exact state a real
// in-flight, unconfirmed gen2 turn would carry (`busy:true`, `submitGeneration:1`, `enterConfirmed:false`)
// — the SAME `submitGeneration` value gen1's orphaned chain captured as its own `gen`. This means gen2 has
// NO competing timer of its own racing the observation window: ANY write that lands on gen2's fake pty, or
// any change to gen2's busy/pending state, during this test is unambiguously attributable to gen1's
// orphaned chain — there is nothing else that could have produced it.
//
// HERMETIC, claude-free — a fake pty at the createPty() seam (mirrors pty-mode-cycle-respawn-identity.mjs /
// pty-giveup-false-negative.mjs). No real claude, no daemon, no network.
//
// RUN: pnpm build (from packages/daemon) then `node test/pty-enter-verify-timers-respawn-identity.mjs`.
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

const tmpHome = path.join(os.tmpdir(), `loom-enterverify-respawn-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 120; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 3;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
// Orphaned-chain worst case from gen1's own attempt-1 Enter write: VERIFY_TIMEOUT (attempt1→2) +
// VERIFY_TIMEOUT (attempt2→3, immediate re-fire — attempt 2 !== MAX_ATTEMPTS so no settle wait) + settle
// (attempt 3 IS MAX_ATTEMPTS) + VERIFY_TIMEOUT (attempt3's own give-up decision) + give-up-confirm-settle.
const ORPHAN_CHAIN_WORST_CASE_MS = VERIFY_TIMEOUT * 3 + SETTLE_POLL * SETTLE_MAX_POLLS * 2;
const OBSERVE_MARGIN_MS = 300;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = {
      ...base, write: (d) => writes.push(d),
      onData: () => ({ dispose() {} }),
      writes,
    };
    fakes.push(fake);
    return fake;
  }
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
const enterCount = (fake) => fake.writes.filter((w) => w === "\r").length;
const reassertCount = (fake) => fake.writes.filter((w) => w === "\x1b[200~\x1b[201~").length;

try {
  const A = "sess-enter-verify-respawn";
  const TEXT1 = "GEN1_MESSAGE_LEFT_UNCONFIRMED_ON_PURPOSE";

  // ---- gen1: submit a message, leave its Enter genuinely unconfirmed ----
  host.spawn({
    sessionId: A, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(A, { hook_event_name: "SessionStart", session_id: "eng-gen1" });
  const gen1Fake = fakes[fakes.length - 1];
  const gen1Live = host.live.get(A);

  const r1 = host.enqueueStdin(A, TEXT1);
  check("(setup) gen1's message delivered via the immediate-submit path, busy armed",
    r1.delivered === true && busyLog[A]?.at(-1) === true);
  await waitForCount(() => enterCount(gen1Fake), 1);
  check("(setup) gen1 wrote exactly its attempt-1 Enter, never confirmed", enterCount(gen1Fake) === 1);
  check("(setup) gen1's own Live still carries the unconfirmed generation",
    gen1Live.enterConfirmed === false && gen1Live.submitGeneration === 1);

  // ---- respawn the SAME sessionId mid-chain, before gen1's own verify-timeout ever fires ----
  host.spawn({
    sessionId: A, cwd: tmpHome, resumeId: "eng-gen2",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    resumeModeTarget: "acceptEdits",
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const gen2Fake = fakes[fakes.length - 1];
  const gen2Live = host.live.get(A);
  check("(setup) the respawn minted a genuinely NEW Live and a NEW fake pty",
    gen2Live !== gen1Live && gen2Fake !== gen1Fake);
  host.deliverHook(A, { hook_event_name: "SessionStart", session_id: "eng-gen2" });
  check("(setup) gen2 is ready, idle, and its own generation counter restarted at 0",
    gen2Live.busy === false && gen2Live.submitGeneration === 0 && gen2Live.enterConfirmed === true);

  // ---- THE COLLISION, set up directly (no competing chain of gen2's own to race — see file header): put
  // gen2 into the exact state a real, unconfirmed, in-flight gen2 turn at generation 1 would carry. This is
  // the SAME field-poking technique already used elsewhere in this suite (e.g. pty-prompt-mismatch.mjs's
  // `host.live.get(sid).enterConfirmed = false`) — gen2 never calls submit()/enqueueStdin itself, so NOTHING
  // but the orphaned gen1 chain can ever act on gen2Live or gen2Fake for the rest of this test.
  gen2Live.busy = true;
  gen2Live.submitGeneration = 1; // THE COLLISION: identical to gen1's orphaned chain's own captured `gen`
  gen2Live.enterConfirmed = false;
  check("(setup) gen2 now carries the exact colliding state (same generation number, genuinely unconfirmed)",
    gen2Live.submitGeneration === gen1Live.submitGeneration && gen2Live.enterConfirmed === false && gen2Live.busy === true);

  // ---- let gen1's entire orphaned chain run to its natural conclusion (every retry, then give-up) ----
  // Routed through assertNeverWithControl (fixed-wait-negative-guard.mjs's own requirement for any fixed
  // wait paired with a negative assertion) rather than a bare `sleep` + look-once: the window is the SAME
  // ORPHAN_CHAIN_WORST_CASE_MS budget, but the check now fails FAST the instant anything lands, and its
  // own positiveControl proves the check mechanism can actually go true before trusting it stayed false.
  //
  // The positiveControl runs on a throwaway, unrelated control session/fake (mirrors
  // pty-ready-fallback-race.mjs's own "a FRESH control session" convention) — never on gen2Fake/gen2Live
  // directly, since assertNeverWithControl's own contract runs positiveControl BEFORE the real observation
  // window with the SAME `check` reference, and arming a real write/busy-flip directly on gen2 would leave
  // residue that the subsequent real window would then (wrongly) read as the violation under test. `probe`
  // is a mutable indirection `check()` reads through: the control phase points it at the throwaway target,
  // then (only once the control has already proven itself) retargets it to gen2 for the real run.
  host.spawn({
    sessionId: "sess-enter-verify-respawn-control", cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const controlFake = fakes[fakes.length - 1];
  const controlLive = host.live.get("sess-enter-verify-respawn-control");
  let probe = { fake: controlFake, live: controlLive, sid: "sess-enter-verify-respawn-control" };
  const anyOrphanInterference = () =>
    probe.fake.writes.length > 0 || probe.live.busy !== true || probe.live.enterConfirmed !== false
    || host.getPending(probe.sid).length > 0;

  const noOrphanInterference = await assertNeverWithControl({
    label: "the orphaned gen1 chain never writes into, clears busy on, flips enterConfirmed on, or " +
      "phantom-requeues against gen2",
    check: anyOrphanInterference,
    windowMs: ORPHAN_CHAIN_WORST_CASE_MS + OBSERVE_MARGIN_MS,
    intervalMs: 20,
    positiveControl: async () => {
      // Prove the instrument on a THROWAWAY target first: arm the exact same `busy` flip the orphaned
      // chain's give-up branch would wrongly perform, via the host's own real setBusy — not a hand-set
      // field — so the control exercises the identical production call surface being guarded against.
      controlLive.busy = true;
      controlLive.enterConfirmed = false;
      const before = anyOrphanInterference();
      host.setBusy("sess-enter-verify-respawn-control", false, "positive-control-probe");
      const wentRed = !before && anyOrphanInterference();
      // Retarget the SAME `check` (via `probe`) at the real gen2 fake/live for the observation window that
      // follows — only now, after the control has already resolved and been measured.
      probe = { fake: gen2Fake, live: gen2Live, sid: A };
      return wentRed;
    },
  });
  check("the orphaned gen1 chain left gen2 completely untouched (writes/busy/enterConfirmed/pending), " +
    "proven against a real positive control (not merely a fixed wait that never saw a violation)",
    noOrphanInterference);

  check("gen2's pty received ZERO writes from the orphaned gen1 chain (nothing else could have written to it)",
    gen2Fake.writes.length === 0);
  check("gen2's busy was NEVER wrongly cleared by the orphaned gen1 chain's give-up (the colliding true we set survives untouched)",
    gen2Live.busy === true);
  check("gen2's enterConfirmed was NEVER flipped by the orphaned gen1 chain", gen2Live.enterConfirmed === false);
  check("gen2's pending queue was NOT phantom-populated by the orphaned gen1 chain's requeueGiveUpOrigin",
    host.getPending(A).length === 0);
  check("gen1's own (dead) fake pty received nothing further either — the orphaned chain never found its own generation alive again",
    enterCount(gen1Fake) === 1 && reassertCount(gen1Fake) === 0);
  try { host.stop("sess-enter-verify-respawn-control", "hard"); } catch { /* ignore */ }
} finally {
  try { host.stop("sess-enter-verify-respawn", "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Enter-verify submit chain (sendEnterAndVerify/awaitReassertSettle/" +
    "awaitGiveUpConfirmSettle/fireEnterAndVerify) is pinned to the Live it started on by identity: an " +
    "orphaned chain left running across a same-id respawn can no longer write into, or clear busy / " +
    "phantom-requeue against, the new generation's real in-flight turn — even when the new generation's " +
    "submitGeneration coincidentally matches the stale captured gen."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
