// Hermetic regression/documentation test for card d4b3fa6c: a SUPPRESSED-only give-up mark on
// `composerDirtyLen` has NO automatic clear path — not even once the SAME generation's own turn is later
// PROVEN to have started (a real UserPromptSubmit hook for that exact generation) or fully completes (a
// real Stop hook). This is a DELIBERATE, DOCUMENTED limitation this card closed via DOCUMENTing the field
// as non-authoritative + directing readers to `worker_flush` first — NOT via changing the clear mechanics
// (see the card body for why a candidate CLEAR fix was rejected: it risks a NEW double-enrollment bug in
// `Live.giveUpConfirmQueue` when `healIfStuck`'s own existing unconditional `requeueGiveUpOrigin` call
// later fires for the same generation a SUPPRESSED mark already enrolled).
//
// THE MECHANISM (traced in pty/host.ts's `fireEnterAndVerify`): the SUPPRESSED branch ("engine produced
// output after the final Enter write") marks `composerDirtyLen` ADDITIVE (`live.composerDirtyLen +=
// live.lastPrompt.length`) but — unlike the GIVE-UP RECOVERY branch and `healIfStuck`'s own backstop —
// never calls `requeueGiveUpOrigin`, so it never seeds `Live.ambiguousDispatches`/`Live.giveUpConfirmQueue`
// and never sets `Live.composerDirtyLenClearedByGen`. Both of `composerDirtyLen`'s clear paths
// (`clearComposerDirtyOnConfirm`, reached only via `purgeConfirmedGiveUpRequeue`'s content-match/FIFO-
// fallback branches; and the `composerDirtyLenClearedByGen === live.submitGeneration` gate on
// UserPromptSubmit/Stop) are therefore UNREACHABLE for a SUPPRESSED-only mark on ITS OWN generation — the
// field can ONLY ever clear via a wholly UNRELATED, LATER submit() (a fresh message) whose own defensive
// clear-prefix goes on to confirm.
//
// WHAT THIS PROVES THAT THE CARD'S OWN §OBSERVED-2 FINDING NEEDED (mgr #137's "this cannot have arrived by
// the named mechanism" — turnSeq:0, no turn completed): scenario (1) below shows the staleness is NOT
// gated on the turn completing at all — it is already permanent the INSTANT the SUPPRESSED mark fires, and
// stays stuck through BOTH the same generation's own UserPromptSubmit confirmation (mid-turn — the
// §OBSERVED-2 shape) AND its later Stop (post-turn — the §OBSERVED shape). Both production specimens are
// ONE mechanism observed at two different points on the same timeline, not two routes.
//
// Scenario (2) is the positive control (same technique as worker-composer-dirty-signal.mjs /
// pty-giveup-composerdirty-confirmed-clear.mjs): proves the SAME instrument (`getComposerDirtyLen`) CAN
// see a real clear — via a wholly separate, later, unrelated message on the SAME session — so scenario
// (1)'s persistence is a genuine finding about the SUPPRESSED path specifically, not a broken read.
//
// RUN (no daemon needed): node test/pty-giveup-suppressed-composerdirty-sticky.mjs
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
async function waitForCount(getCount, target, timeoutMs = 5000) {
  const t0 = Date.now();
  while (getCount() < target) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitForCount: timed out waiting for count to reach ${target} (stuck at ${getCount()})`);
    await sleep(2);
  }
}
// Card b64b3726 (see pty-giveup-false-negative.mjs's identical helper for the full reasoning): spin until
// the real clock has genuinely ticked PAST an observed Enter-write timestamp before emitting synthetic
// output, so the product's intentionally-strict `>` discriminator (same-ms reads as "no output after")
// isn't raced into a flaky RECOVERY instead of the intended SUPPRESSED outcome.
async function awaitClockPast(t) {
  while (Date.now() <= t) await sleep(1);
}
async function waitUntil(predicate, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    await sleep(2);
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-giveupsuppressedsticky-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
const SETTLE_BOUND = SETTLE_POLL * SETTLE_MAX_POLLS;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
const writeAt = (k) => ENTER_DELAY + (k - 1) * VERIFY_TIMEOUT + (k === MAX_ATTEMPTS && k > 1 ? SETTLE_BOUND : 0);
const giveUpAt = () => writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const enterWriteTimes = [];
    let onDataCb = null;
    const fake = {
      ...base,
      write: (d) => { writes.push(d); if (d === "\r") enterWriteTimes.push(Date.now()); },
      onData: (cb) => { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
      writes,
      enterWriteTimes,
      emitOutput: (s = ".") => { if (onDataCb) onDataCb(Buffer.from(s, "utf-8")); },
    };
    fakes.push(fake);
    return fake;
  }
}

const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {},
  onRateLimited() {}, onExit() {},
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
  return { fake, written: () => fake.writes.join(""), entryCount: () => fake.writes.join("").split("\r").length - 1 };
}

try {
  // ===== (1) SUPPRESSED mark survives its OWN generation's UserPromptSubmit confirm AND its later Stop ===
  {
    const SID = "sess-suppressed-sticky";
    const TEXT = "STRANDED_BUT_TURN_ACTUALLY_STARTED";
    const { fake, entryCount } = spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(1) setup: idle-submit delivered, busy armed", r.delivered === true && busyLog[SID]?.at(-1) === true);

    // Fool the discriminator exactly like pty-giveup-false-negative.mjs scenario (1): output after the
    // FINAL Enter write forces GIVE-UP SUPPRESSED (not RECOVERY).
    await waitForCount(entryCount, MAX_ATTEMPTS);
    await awaitClockPast(fake.enterWriteTimes[MAX_ATTEMPTS - 1]);
    fake.emitOutput("spinner-tick-after-final-enter");
    await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
    check("(1) GIVE-UP SUPPRESSED fired (busy still true)", busyLog[SID]?.at(-1) === true);
    check("(1) composerDirtyLen marked SYNCHRONOUSLY at suppression, exact stranded length",
      host.getComposerDirtyLen(SID) === TEXT.length);

    // The SAME generation's own turn is now PROVEN to have started — a real UserPromptSubmit hook for it.
    // turnSeq is still 0 here (no Stop yet) — this is exactly §OBSERVED-2's shape: mid-first-turn, busy,
    // no turn completed, composerDirtyLen still reads nonzero against a composer the confirmation just
    // proved is genuinely being used for a real, running turn.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    check("(1) enterConfirmed proof landed (busy reads true — a real turn, not a stuck one)",
      busyLog[SID]?.at(-1) === true);
    check("(1) THE FINDING: composerDirtyLen is STILL the stranded length after ITS OWN generation's " +
      "UserPromptSubmit hook confirmed — turn-completion is NOT what gates the staleness; it was already " +
      "permanent the instant SUPPRESSED fired",
      host.getComposerDirtyLen(SID) === TEXT.length);

    // The turn now fully completes — the §OBSERVED shape (post-completion, idle).
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(1) turn completed cleanly (busy false)", busyLog[SID]?.at(-1) === false);
    check("(1) composerDirtyLen is STILL stranded after the turn's own Stop — no automatic clear path " +
      "exists for a SUPPRESSED-only mark on its own generation (card d4b3fa6c's DOCUMENTED limitation)",
      host.getComposerDirtyLen(SID) === TEXT.length);
  }

  // ===== (2) POSITIVE CONTROL: the SAME instrument CAN see a real clear — via an unrelated LATER message =====
  {
    const SID = "sess-suppressed-sticky"; // reuse: composerDirtyLen is still stranded from scenario (1)
    const SECOND_TEXT = "A_LATER_UNRELATED_MESSAGE_THAT_CLEARS_IT";
    const r2 = host.enqueueStdin(SID, SECOND_TEXT);
    check("(2) setup: a fresh, unrelated message was delivered", r2.delivered === true);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" }); // this NEW generation's own confirm
    check("(2) THE ONLY CLEAR PATH: an unrelated LATER submit()'s own defensive clear-prefix, confirmed, " +
      "resets composerDirtyLen to 0 — proving scenario (1)'s persistence was a real finding about the " +
      "SUPPRESSED path, not a broken/vacuous read",
      host.getComposerDirtyLen(SID) === 0);
  }
} finally {
  for (const sid of ["sess-suppressed-sticky"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a GIVE-UP SUPPRESSED mark on composerDirtyLen has no automatic clear path: it survives " +
    "its own generation's UserPromptSubmit confirm (mid-turn, turnSeq still 0 — the §OBSERVED-2 shape) AND " +
    "its later Stop (post-turn, idle — the §OBSERVED shape), clearing ONLY via an unrelated later submit's " +
    "own confirmed clear-prefix — proving both production specimens are one mechanism, not two routes."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
