// Hermetic regression test for card b932558c: composerDirtyLen must clear the moment a give-up is
// CONFIRMED — proven via `purgeConfirmedGiveUpRequeue`'s content-match branch — not stay dirty until
// some unrelated LATER submit()'s own defensive clear-prefix happens to confirm.
//
// THE SPECIMEN this closes (mgr #104, card b932558c): a worker's kickoff give-up'd (4 Enter attempts,
// none confirmed within the verify window), the daemon recovered busy and marked composerDirtyLen
// dirty (card 3ce3fa39's deferred-clear design) — but the give-up was a FALSE NEGATIVE: a confirming
// UserPromptSubmit hook arrived moments later, content-matched the stranded text byte-for-byte, and the
// daemon logged `CONFIRMED ... (content-matched)` and purged the still-queued duplicate. That log line
// is decisive, acted-upon proof the composer was NOT stranded. Pre-fix, `composerDirtyLen` stayed at
// the full stranded length for the ENTIRE 219s turn that followed — reading as a possibly-stuck
// composer to any manager checking `worker_list`/`my_context`, on a session that was in fact perfectly
// healthy and already running. See `worker-composer-dirty-signal.mjs`'s own header for why the field
// used to require a SUBSEQUENT submit() to ever clear (composerDirtyLenClearedByGen, host.ts
// ~4014/4191) — that gate is UNCHANGED by this fix; this test covers the NEW, SEPARATE clear path
// (`clearComposerDirtyOnConfirm`, gated on `composerDirtyMarkedForGen`) that fires the instant
// `purgeConfirmedGiveUpRequeue` itself proves a generation's turn actually started, with no new
// submit() required.
//
// Scenario (1) drives a GENUINE drop (mirrors pty-giveup-clear.mjs scenario 1 — no output ever emitted,
// so give-up is real RECOVERY, not SUPPRESSED) to populate `live.ambiguousDispatches`/composerDirtyLen,
// then delivers a confirming hook whose `prompt` content-matches the stranded text BEFORE the requeued
// duplicate's own hold expires (so the ONLY thing resolving it is the content-match path, never a
// redrain). THE ASSERTION THAT MATTERS: composerDirtyLen reads 0 immediately after that hook — WHILE
// busy is still true (the turn is genuinely running), not after some later Stop.
//
// Scenario (2) proves the SAME fix through `purgeConfirmedGiveUpRequeue`'s OTHER branch — the CONTENT-
// BLIND FIFO-position fallback (taken whenever a hook carries no `prompt`, e.g. a real Stop/StopFailure
// hook). A Stop hook is delivered directly (no intervening submit(), so the PRE-EXISTING
// `composerDirtyLenClearedByGen` gate — set only by a fresh submit()'s own defensive clear-prefix — never
// fires here at all, isolating this scenario to the NEW fix). Uses a Stop hook specifically (not another
// UserPromptSubmit) since Stop is the ONE call site that always omits `reportedPrompt` (host.ts's own
// `purgeConfirmedGiveUpRequeue` doc), guaranteeing the FIFO-position path, never content-match, resolves it.
//
// RUN (no daemon needed): node test/pty-giveup-composerdirty-confirmed-clear.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-giveupdirtyconfirm-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;
// Pinned LARGE (unlike pty-giveup-clear.mjs's HOLD_MS=10): this test must deliver its confirming hook
// WHILE the requeued duplicate is still HELD from drain (card 73d5c34a) — a hold that expires before the
// hook lands would let `host.reconcile()`'s own background timers redrain it first, contaminating the
// scenario this test exists to isolate (content-match confirming a STILL-HELD entry, not a redrained one).
const HOLD_MS = 30_000;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);

// Card 259c15fa (see pty-giveup-clear.mjs's own doc): give-up's real completion is a chain of setTimeout
// hops that routinely overshoots a hand-computed sum — poll for the OBSERVED busy=false transition.
const GIVE_UP_POLL_MS = 20;
const GIVE_UP_POLL_TIMEOUT_MS = 15_000;
async function waitForBusyFalse(busyLog, sessionId, t0) {
  while (busyLog[sessionId]?.at(-1) !== false && Date.now() - t0 < GIVE_UP_POLL_TIMEOUT_MS) await sleep(GIVE_UP_POLL_MS);
}

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const fake = { ...base, write: () => {} }; // never emits output — every give-up here is a GENUINE drop
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
}

try {
  // ===================== (1) THE FIX: content-matched CONFIRMED clears composerDirtyLen immediately, ======
  // ===================== WHILE the turn is still running — the whole point of card b932558c ==============
  {
    const SID = "sess-giveup-confirmed";
    const TEXT = "SPECIMEN_KICKOFF_TEXT_THAT_GIVES_UP_THEN_CONFIRMS";
    spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(1) setup: idle-submit delivered, busy armed", r.delivered === true && busyLog[SID]?.at(-1) === true);

    // No output ever emitted by this fake — a genuine drop, i.e. real GIVE-UP RECOVERY (not SUPPRESSED).
    await waitForBusyFalse(busyLog, SID, t0);
    check("(1) GIVE-UP RECOVERY landed: busy fell back to false", busyLog[SID]?.at(-1) === false);
    check("(1) composerDirtyLen marked dirty at give-up, synchronously, exactly the stranded length",
      host.getComposerDirtyLen(SID) === TEXT.length);
    check("(1) sanity: the requeued duplicate is still HELD in pending (hold pinned large — not yet redrained)",
      host.getPendingEntries(SID).length === 1);

    // THE CONFIRMING HOOK: content-matches the stranded text exactly — this is the false-negative-recovery
    // path (purgeConfirmedGiveUpRequeue's content-match branch), never a fresh submit()'s own clear-prefix.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT });
    check("(1) the confirming hook re-armed busy — the turn is now genuinely running",
      busyLog[SID]?.at(-1) === true);
    check("(1) the still-held duplicate was purged by the content-match (never redrained/double-delivered)",
      host.getPendingEntries(SID).length === 0);

    // THE ASSERTION THAT MATTERS: composerDirtyLen is 0 RIGHT NOW, mid-turn (busy still true) — not after
    // some later Stop, and not requiring any further submit() to ever arrive.
    check("(1) THE FIX: composerDirtyLen reads 0 immediately on CONFIRMED, while the turn is still running",
      host.getComposerDirtyLen(SID) === 0);

    // The turn finishes normally afterward — composerDirtyLen must stay 0, not get re-marked or misbehave.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(1) turn finalized cleanly", busyLog[SID]?.at(-1) === false);
    check("(1) composerDirtyLen stays 0 after Stop too", host.getComposerDirtyLen(SID) === 0);
  }

  // ===================== (2) THE FIFO-POSITION FALLBACK: a Stop hook (no `prompt` at all — the content- ===
  // ===================== match branch is structurally unreachable) still clears composerDirtyLen, via the =
  // ===================== SAME fix's OTHER call site inside purgeConfirmedGiveUpRequeue ====================
  {
    const SID = "sess-giveup-stop-confirms";
    const TEXT = "STRANDED_TEXT_CONFIRMED_BY_A_BARE_STOP_HOOK";
    spawnReady(SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(2) setup: idle-submit delivered, busy armed", r.delivered === true && busyLog[SID]?.at(-1) === true);

    await waitForBusyFalse(busyLog, SID, t0);
    check("(2) GIVE-UP RECOVERY landed: busy fell back to false", busyLog[SID]?.at(-1) === false);
    check("(2) composerDirtyLen marked dirty at give-up", host.getComposerDirtyLen(SID) === TEXT.length);

    // A bare Stop hook — no `prompt` field at all, so purgeConfirmedGiveUpRequeue's content-match branch
    // is skipped entirely (its own guard requires `typeof reportedPrompt === "string"`) and resolution
    // falls all the way through to the CONTENT-BLIND FIFO-position fallback (host.ts's own doc: "the
    // pre-card FIFO-position logic, UNCHANGED — it still runs verbatim whenever content matching can't
    // apply"). No submit() has run since the original give-up, so the PRE-EXISTING
    // `composerDirtyLenClearedByGen` gate (null here) cannot be what clears this — only the NEW fix can.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(2) THE FIX (FIFO-fallback branch): composerDirtyLen clears to 0 on a bare Stop hook confirming this generation, with no subsequent submit() ever having run",
      host.getComposerDirtyLen(SID) === 0);
    check("(2) sanity: the held duplicate was purged by the fallback (never redrained/double-delivered)",
      host.getPendingEntries(SID).length === 0);
  }
} finally {
  for (const sid of ["sess-giveup-confirmed", "sess-giveup-stop-confirms"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — composerDirtyLen clears to 0 the moment a give-up is CONFIRMED, whether by purgeConfirmedGiveUpRequeue's content-match branch (while the turn is still running) or its content-blind FIFO-position fallback (a bare Stop hook) — in both cases with no subsequent submit() ever required."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
