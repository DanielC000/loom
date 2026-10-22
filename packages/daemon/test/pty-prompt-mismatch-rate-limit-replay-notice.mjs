// Regression test for card d3edcee5's Code Review (94c25a95) Minor — `resumeAfterRateLimit`'s two paths
// broke the "single-member notice is byte-identical to pre-d3edcee5" claim:
//
// (a) NON-BLOCKED replay, null origin: `requeueGiveUpOrigin` nulls `live.giveUpOrigin` the instant a
//     give-up fires. If a NOTICE turn gave up and was requeued, then the session is separately rate-
//     limited before anything re-drains it, `resumeAfterRateLimit`'s `replayOrigin = live.giveUpOrigin`
//     reads `null` — the replay `submit()` call then ran with `origin: undefined`, which (pre-fix) reset
//     `live.lastSubmitExemptAsOwnNotice` to `false` even though the replayed TEXT is the exact same notice
//     that flag was already correctly stamped `true` for. Fixed: `submit()` now leaves
//     `lastSubmitExemptAsOwnNotice`/`lastPromptKind` UNTOUCHED when `origin` is `undefined` (see that
//     method's own doc) — this replay never changes `text` relative to `live.lastPrompt`, so the
//     previously-stamped values still describe it accurately.
//
// (b) BLOCKED replay (`stopping`/`drainHeld`), hard-coded kind: the blocked branch used to re-enqueue
//     `live.lastPrompt` with a LITERAL `kind: "agent"`, regardless of the original turn's real kind — so a
//     replayed "warning"-kind turn (a notice, an idle nudge, …) could never be recognized as exempt once
//     drained, and was mislabeled for every OTHER kind-sensitive drain decision too. Fixed: a new sticky
//     `Live.lastPromptKind` field (same lifecycle as the pre-existing `lastPromptRoute`/
//     `lastPromptProactive`/`lastPromptOwnerText`/`lastPromptSenderId` — set in `submit()`, survives a
//     give-up) replaces the literal.
//
// Both scenarios below mirror pty-giveup-rate-limit-replay-origin.mjs's own setup discipline (a direct
// `deliverHook(StopFailure, error:"rate_limit")` call sets `live.rateLimited`, independent of whatever
// give-up/busy state preceded it — no real claude, no real usage cap).
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon,
//   pnpm build && node test/pty-prompt-mismatch-rate-limit-replay-notice.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mismatch-rl-replay-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_HOLD_MS = "5000"; // generous — this test resolves well inside the hold

const { PtyHost, PROMPT_MISMATCH_NOTICE_TAG } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const logs = [];
const realLog = console.log.bind(console);
const realErr = console.error.bind(console);
console.log = (...a) => { if (typeof a[0] === "string") logs.push(a[0]); realLog(...a); };
console.error = (...a) => { if (typeof a[0] === "string") logs.push(a[0]); realErr(...a); };
const selfExemptFired = () => logs.some((l) => l.includes("prompt-mismatch-notice-self-exempt"));
const freshNoticeMinted = (sid) => host.getPendingEntries(sid).some((e) => e.text.startsWith(PROMPT_MISMATCH_NOTICE_TAG));

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

async function waitForBusyFalse(sid) {
  await sharedWaitUntil(() => busyLog[sid]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
}

try {
  // ===== (a) NON-BLOCKED: a notice turn gives up (nulling live.giveUpOrigin), is then rate-limited, and =====
  // ===== resumeAfterRateLimit's direct submit() replay must still exempt it (no fresh notice minted) =====
  {
    const SID = "sess-rl-replay-notice";
    const NOTICE_TEXT = `${PROMPT_MISMATCH_NOTICE_TAG} a fake mismatch notice body, long enough to stay clearly above any small-bucket bound XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`;
    spawnReady(SID);
    const live = host.live.get(SID);

    host.enqueueStdin(SID, NOTICE_TEXT, "system", undefined, undefined, "warning");
    check("(a) setup: notice delivered immediately, busy armed", busyLog[SID]?.at(-1) === true);
    check("(a) setup: live.lastSubmitExemptAsOwnNotice is true right after the original write",
      live.lastSubmitExemptAsOwnNotice === true);

    // The notice's OWN write never confirms — a genuine give-up, same shape as pty-giveup-requeue.mjs.
    await waitForBusyFalse(SID);
    check("(a) setup: the notice was genuinely requeued (giveUpGen tagged), not dropped",
      host.getPendingEntries(SID).some((m) => m.text === NOTICE_TEXT && m.giveUpGen !== undefined));
    check("(a) THE BUG PRECONDITION: requeueGiveUpOrigin nulled live.giveUpOrigin",
      live.giveUpOrigin === null);
    check("(a) sticky field survives the give-up untouched (give-up itself never calls submit())",
      live.lastSubmitExemptAsOwnNotice === true);

    // The session is separately rate-limited (independent of the give-up above — a real usage-cap StopFailure
    // can arrive regardless of whatever give-up/hold state the session is currently in).
    host.deliverHook(SID, { hook_event_name: "StopFailure", error: "rate_limit" });
    check("(a) setup: the session is now parked (rateLimited)", live.rateLimited === true);

    logs.length = 0;
    const resumed = host.resumeAfterRateLimit(SID);
    check("(a) setup: resume reported success, took the NON-blocked (direct submit()) path",
      resumed === true && live.busy === true);
    check("(a) THE FIX, WHITE-BOX: the null-origin replay left lastSubmitExemptAsOwnNotice TRUE — RED pre-fix (would read false)",
      live.lastSubmitExemptAsOwnNotice === true);

    logs.length = 0;
    const MISMATCHED = "a completely different reported string for the rate-limit-replay case, well above the small-bucket bound XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: MISMATCHED });
    // TIMING-GUARD-SAFE: sync-probe-no-macrotask — same reasoning as pty-prompt-mismatch-coalesced-notice-
    // exempt.mjs scenario (a): a single zero-delay timer registered AFTER deliverHook is guaranteed
    // (macrotask FIFO) to run after whatever setTimeout(fn, 0) deliverHook itself may have scheduled.
    await new Promise((r) => setTimeout(r, 0));
    check("(a) THE FIX: the loop-breaker self-exempts the replayed notice — RED pre-fix",
      selfExemptFired());
    check("(a) THE FIX: no FRESH notice was minted about the replayed notice's own mismatch — RED pre-fix",
      !freshNoticeMinted(SID));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (b) BLOCKED: same give-up + rate-limit setup, but resumeAfterRateLimit's `drainHeld` branch =====
  // ===== must re-enqueue with the ORIGINAL kind ("warning"), never a hard-coded "agent" =====
  {
    const SID = "sess-rl-replay-notice-blocked";
    const NOTICE_TEXT = `${PROMPT_MISMATCH_NOTICE_TAG} a second fake mismatch notice body for the blocked path XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`;
    spawnReady(SID);
    const live = host.live.get(SID);

    host.enqueueStdin(SID, NOTICE_TEXT, "system", undefined, undefined, "warning");
    check("(b) setup: notice delivered immediately, busy armed", busyLog[SID]?.at(-1) === true);
    await waitForBusyFalse(SID);
    check("(b) setup: live.lastPromptKind is \"warning\" (the real kind, stamped at the original write)",
      live.lastPromptKind === "warning");

    host.deliverHook(SID, { hook_event_name: "StopFailure", error: "rate_limit" });
    check("(b) setup: the session is now parked (rateLimited)", live.rateLimited === true);

    // Card 7edd420b's own blocked gate — set directly (only drainHeld's truthiness is load-bearing for
    // this branch choice, not how it got set; same discipline as pty-giveup-rate-limit-replay-origin.mjs).
    live.drainHeld = true;
    const resumed = host.resumeAfterRateLimit(SID);
    check("(b) setup: resume reported success, did NOT write into the pty (held, not blocked)",
      resumed === true && live.busy === false);

    const held = host.getPendingEntries(SID).find((m) => m.text === NOTICE_TEXT);
    check("(b) setup: the held entry exists in live.pending", held !== undefined);
    check("(b) THE FIX: the held entry's kind is \"warning\" — RED pre-fix (would be hard-coded \"agent\")",
      held?.kind === "warning");

    live.drainHeld = false;
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  console.log = realLog; console.error = realErr;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card d3edcee5's rate-limit-replay Minor is fixed: a notice turn that gave up (nulling "
    + "live.giveUpOrigin) and is then rate-limit-replayed via the NON-blocked path stays exempt (the sticky "
    + "lastSubmitExemptAsOwnNotice/lastPromptKind fields are left untouched when submit() receives no "
    + "origin, never reset to the no-origin default), and the BLOCKED (drainHeld) path re-enqueues with the "
    + "turn's real kind via the new sticky Live.lastPromptKind field, never a hard-coded \"agent\"."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
