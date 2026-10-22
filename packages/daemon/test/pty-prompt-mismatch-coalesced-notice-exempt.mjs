// Regression test for card d3edcee5 — a coalesced batch containing Loom's own `[loom:prompt-mismatch]`
// notice as a NON-HEAD member defeated the 87d2dc95 loop-breaker, because `intendedIsOwnMismatchNotice`
// used to be a prefix test against the WHOLE joined `live.lastPrompt`: a different, non-notice "warning"
// message that gave up and got requeued (`requeueGiveUpOrigin` unshifts onto the FRONT of `live.pending`)
// can — once its hold expires — become `drainPending`'s HEAD and coalesce forward with an already-queued
// notice (route-keyed branch, same empty route/kind/proactive — no giveUpGen exclusion there, unlike the
// same-sender "agent" branch). The joined text then has the non-notice member FIRST, the prefix test
// misses the notice, and a FRESH notice gets minted about the batch's own mismatch — the self-sustaining
// loop 87d2dc95 was meant to close.
//
// THE FIX: `live.lastSubmitExemptAsOwnNotice` is now stamped by `submit()` directly from THAT CALL's own
// `origin` array (never from `lastPrompt`'s joined text): true iff `origin` is non-empty, EVERY member's
// own `kind` is `"warning"`, and at least one member is itself one of Loom's own notice tags. The
// kind-uniformity conjunct is load-bearing: under the opt-in `coalesceAgentMessages:true` legacy setting,
// `drainPending`'s route-keyed branch ignores `kind` entirely, so a batch can mix a notice with REAL
// `"agent"`-kind content (a manager redirect, a worker report, a human turn) — that must NEVER be
// silenced by a notice riding along. Full rule + rejected alternatives: docs/decisions/d3edcee5-*.md.
//
// SCENARIO (a) is the REAL reachable path (give-up + requeue + hold-expiry + push-then-drain coalescing),
// proven RED against a revert of host.ts: `git diff -- packages/daemon/src/pty/host.ts` captured outside
// the repo, `git checkout HEAD -- packages/daemon/src/pty/host.ts`, rebuild, re-run this file (scenario
// (a)'s three behavioral checks fail — no origin-derived field to read, no exemption, a fresh notice gets
// minted), then `git apply` the captured diff to restore and rebuild clean. SCENARIOS (b)/(c)/(d) use a
// DIRECT `submit()` call with a hand-built `origin` (same discipline as
// pty-giveup-coalesced-batch-bypass-every.mjs's own direct-call pattern) to isolate the flag's derivation
// from give-up/hold timing entirely.
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon,
//   pnpm build && node test/pty-prompt-mismatch-coalesced-notice-exempt.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-mismatch-coalesced-notice-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = "5";
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = "3";
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = "10";
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = "15";
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
const HOLD_MS = 10;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
const HOLD_WAIT = HOLD_MS + 30;
process.env.LOOM_MODE_LOG_POLL_MS = "5";

const { PtyHost, PROMPT_MISMATCH_NOTICE_TAG } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {}, onRateLimited() {}, onExit() {},
};
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}

function spawnReady(host, sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  return fakes[fakes.length - 1];
}

const logs = [];
const realLog = console.log.bind(console);
const realErr = console.error.bind(console);
console.log = (...a) => { if (typeof a[0] === "string") logs.push(a[0]); realLog(...a); };
console.error = (...a) => { if (typeof a[0] === "string") logs.push(a[0]); realErr(...a); };
const selfExemptFired = () => logs.some((l) => l.includes("prompt-mismatch-notice-self-exempt"));
const ordinaryMismatchFired = () => logs.some((l) => l.includes("[prompt-mismatch]"));
const freshNoticeMinted = (host, sid) => host.getPendingEntries(sid).some((e) => e.text.startsWith(PROMPT_MISMATCH_NOTICE_TAG));

try {
  const host = new TestPtyHost(events);

  // ===== (a) THE REACHABLE DEFECT — real give-up + requeue + hold-expiry + push-then-drain coalescing =====
  // ===== puts a non-notice warning AHEAD of an already-queued notice in ONE drained batch =================
  {
    const SID = "sess-a-coalesced-real-path";
    const OTHER_WARNING = "SOME_OTHER_WARNING_NOT_A_NOTICE_XXXXXXXXXXXXXXXXXXXX";
    const NOTICE_TEXT = `${PROMPT_MISMATCH_NOTICE_TAG} a fake mismatch notice body, long enough to stay clearly above any small-bucket bound XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`;
    spawnReady(host, SID);

    const r1 = host.enqueueStdin(SID, OTHER_WARNING);
    check("(a) setup: OTHER_WARNING delivered immediately, busy armed", r1.delivered === true && busyLog[SID].at(-1) === true);
    await waitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    const afterGiveUp = host.getPendingEntries(SID);
    check("(a) setup: OTHER_WARNING requeued (not dropped)", afterGiveUp.length === 1 && afterGiveUp[0].text === OTHER_WARNING);

    // TIMING-GUARD-SAFE: scripted-duration-margin — HOLD_MS is a test-authored env var (LOOM_GIVE_UP_HOLD_MS),
    // not an unobservable real-world event; HOLD_WAIT (HOLD_MS + 30) is sized with a stated safe margin over
    // that same scripted duration, and the check below is POSITIVE ("coalesced"), not a negative assertion —
    // an insufficient wait would leave OTHER_WARNING still held, so the batch would NOT coalesce and this
    // check would correctly fail loud, never silently pass for the wrong reason.
    await sleep(HOLD_WAIT); // OTHER_WARNING's hold expires — it's eligible again, still at the front
    logs.length = 0;
    const r2 = host.enqueueStdin(SID, NOTICE_TEXT, "system", undefined, undefined, "warning");
    check("(a) setup: enqueueStdin's own push-then-drain coalesced both into ONE batch",
      r2.delivered === true && r2.deliveryState === "handed-off" && host.getPendingEntries(SID).length === 0);

    const live = host.live.get(SID);
    check("(a) setup: live.lastPrompt is a JOINED batch containing BOTH members (notice NOT first)",
      (live.lastPrompt ?? "").includes(OTHER_WARNING) && (live.lastPrompt ?? "").includes(NOTICE_TEXT)
      && !(live.lastPrompt ?? "").replace(/^\[loom:possible-duplicate root:[0-9a-f]{8}\]\s*/, "").startsWith(PROMPT_MISMATCH_NOTICE_TAG));
    check("(a) THE FIX, WHITE-BOX: live.lastSubmitExemptAsOwnNotice is true (every member is kind:\"warning\", one is the notice)",
      live.lastSubmitExemptAsOwnNotice === true);

    logs.length = 0;
    const MISMATCHED = "a completely different reported string, long enough to stay clearly above the small-bucket bound XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: MISMATCHED });
    // TIMING-GUARD-SAFE: sync-probe-no-macrotask — the notice-mint path (host.ts) schedules its enqueue via
    // a single setTimeout(fn, 0); macrotasks run FIFO, so this LATER-registered zero-delay timer is
    // guaranteed to resolve only after that one has already run. Both checks below read synchronously
    // right after, no further await in between.
    await new Promise((r) => setTimeout(r, 0));
    check("(a) THE FIX: the loop-breaker DID self-exempt this batch — RED on a revert of card d3edcee5",
      selfExemptFired());
    check("(a) THE FIX: no FRESH [loom:prompt-mismatch] notice was minted about the notice's own mismatch — RED on a revert",
      !freshNoticeMinted(host, SID));
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (b) coalesceAgentMessages:true, batch=[notice, REAL agent content]: mismatch detection must ======
  // ===== still FIRE — a notice must never silence a lost/garbled human/agent message riding alongside =====
  {
    const hostOn = new TestPtyHost(events, { coalesceAgentMessages: true });
    const SID = "sess-b-mixed-kind-not-exempt";
    const NOTICE_TEXT = `${PROMPT_MISMATCH_NOTICE_TAG} a fake mismatch notice body XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`;
    const AGENT_TEXT = "REAL_AGENT_CONTENT_A_MANAGER_REDIRECT_OR_WORKER_REPORT_MUST_NEVER_BE_SILENCED_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    spawnReady(hostOn, SID);
    const joined = `${NOTICE_TEXT}\n\n────────\n\n${AGENT_TEXT}`;
    const origin = [
      { id: "b1", logicalId: "b1", text: NOTICE_TEXT, kind: "warning" },
      { id: "b2", logicalId: "b2", text: AGENT_TEXT, kind: "agent" },
    ];
    logs.length = 0;
    hostOn["submit"](SID, joined, undefined, undefined, undefined, undefined, "test-mixed-kind", origin);
    const live = hostOn.live.get(SID);
    check("(b) setup: live.lastPrompt is the joined [notice, agent] batch, notice IS the head",
      live.lastPrompt === joined);
    check("(b) THE FIX, WHITE-BOX: live.lastSubmitExemptAsOwnNotice is FALSE (an agent-kind member rides along)",
      live.lastSubmitExemptAsOwnNotice === false);

    logs.length = 0;
    const MISMATCHED = "a completely different reported string for the mixed-kind batch, well above the small-bucket bound XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    hostOn.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: MISMATCHED });
    // TIMING-GUARD-SAFE: sync-probe-no-macrotask — same reasoning as scenario (a) above: a single
    // zero-delay timer registered AFTER deliverHook is guaranteed (macrotask FIFO) to run after whatever
    // setTimeout(fn, 0) deliverHook itself may have scheduled.
    await new Promise((r) => setTimeout(r, 0));
    check("(b) THE FIX: mismatch detection STILL FIRES for a mixed-kind batch (no self-exempt)",
      !selfExemptFired() && ordinaryMismatchFired());
    try { hostOn.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (c) a SINGLE notice member: exempt — byte-identical to the pre-d3edcee5 (87d2dc95) behavior =====
  {
    const SID = "sess-c-single-notice-exempt";
    const NOTICE_TEXT = `${PROMPT_MISMATCH_NOTICE_TAG} a lone mismatch notice body XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`;
    spawnReady(host, SID);
    const origin = [{ id: "c1", logicalId: "c1", text: NOTICE_TEXT, kind: "warning" }];
    logs.length = 0;
    host["submit"](SID, NOTICE_TEXT, undefined, undefined, undefined, undefined, "test-single-notice", origin);
    const live = host.live.get(SID);
    check("(c) THE UNCHANGED CASE, WHITE-BOX: a single notice member still sets the flag true",
      live.lastSubmitExemptAsOwnNotice === true);

    logs.length = 0;
    const MISMATCHED = "a completely different reported string for the single-notice case, well above the small-bucket bound XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: MISMATCHED });
    // TIMING-GUARD-SAFE: sync-probe-no-macrotask — same reasoning as scenario (a) above.
    await new Promise((r) => setTimeout(r, 0));
    check("(c) THE UNCHANGED CASE: a lone notice still self-exempts (87d2dc95's original case, unregressed)",
      selfExemptFired());
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (d) a SINGLE ordinary (non-notice) warning: not exempt — mismatch detection fires normally =====
  {
    const SID = "sess-d-single-ordinary-not-exempt";
    const ORDINARY_TEXT = "AN_ORDINARY_WARNING_NEVER_A_NOTICE_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    spawnReady(host, SID);
    const origin = [{ id: "d1", logicalId: "d1", text: ORDINARY_TEXT, kind: "warning" }];
    logs.length = 0;
    host["submit"](SID, ORDINARY_TEXT, undefined, undefined, undefined, undefined, "test-single-ordinary", origin);
    const live = host.live.get(SID);
    check("(d) THE UNCHANGED CASE, WHITE-BOX: a single ordinary warning leaves the flag false",
      live.lastSubmitExemptAsOwnNotice === false);

    logs.length = 0;
    const MISMATCHED = "a completely different reported string for the ordinary-warning case, well above the small-bucket bound XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: MISMATCHED });
    // TIMING-GUARD-SAFE: sync-probe-no-macrotask — same reasoning as scenario (a) above.
    await new Promise((r) => setTimeout(r, 0));
    check("(d) THE UNCHANGED CASE: an ordinary warning's own mismatch is NOT exempted (fires normally)",
      !selfExemptFired() && ordinaryMismatchFired());
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  console.log = realLog; console.error = realErr;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card d3edcee5: a coalesced batch's own-notice exemption is derived from submit()'s own "
    + "`origin` array (every member kind:\"warning\", at least one a Loom notice), never from a prefix test "
    + "on the joined `lastPrompt` string — closing the reachable loop where a non-notice give-up-requeued "
    + "warning lands ahead of an already-queued notice, while a mixed-kind coalesceAgentMessages:true batch "
    + "still gets real mismatch detection for its agent/human content."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
