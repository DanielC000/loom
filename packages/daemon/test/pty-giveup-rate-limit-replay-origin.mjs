// Regression test for card 7a64f16b round 2 (Code Review item 1, second half) — `resumeAfterRateLimit`
// now threads the killed turn's own `live.giveUpOrigin` through its replay (both the direct `submit()`
// path and the `enqueueStdin`-via-`logicalId` blocked path).
//
// INVESTIGATION NOTE (reported as part of this round's own DoD): the Code Review's own hypothesized
// shape — "if it replays L1's own text, L1's genuine echo is now declined and a duplicate follows" via
// `purgeConfirmedGiveUpRequeueCore`'s content-ancestry DECLINE — could NOT be constructed as a reachable
// repro for the single-prior-give-up case this file first tried. Tracing it: `retireResolvedArchiveEntries`
// (called unconditionally on every `turnEnded:true` hook, including the rate-limiting StopFailure itself)
// sweeps a logicalId's retired signature the instant nothing in `ambiguousDispatches` or `live.pending`
// still references it — and a redrain already moves a giveUpGen-tagged entry's "current" slot to
// `retiredGiveUpSignatures` BEFORE the rate limit even hits (card 4a0af485 Major 2). By the time the SAME
// rate-limiting StopFailure hook fires, that redrained identity's own pending reference is already gone
// (consumed into the now-in-flight write) — so the ONE retired signature a later replay-confirmation
// could have coincidentally matched is swept away in the SAME hook call that parks the session, before
// `resumeAfterRateLimit` is ever invoked. This is NOT a claim that no reachable shape exists (a coalesced
// multi-member origin, or a second pending duplicate under the same logicalId, were not exhaustively
// tried) — it is a report that this specific, simplest construction is not one.
//
// WHAT THIS FILE PROVES INSTEAD — a MORE SEVERE, directly-reachable consequence of the SAME missing-
// origin gap, on the UNBLOCKED (direct `submit()`) replay path specifically: pre-fix, `submit(..., origin:
// undefined, ...)` meant `live.giveUpOrigin` was NULLED for the replay's own write. If THAT replay then
// itself genuinely gives up (no confirming hook ever arrives — indistinguishable from the original rate-
// limited turn simply failing again), `requeueGiveUpOrigin` early-returns on `!origin` — NOT a wrongly-
// declined ancestry match, but a BARE, SILENT, UNTRACEABLE DROP: no archive entry, no requeue, nothing
// left in `live.pending` — the exact "a give-up there has no origin to restore" the field's own pre-
// existing doc already named as a known limitation of this function, now closed for the common
// (non-blocked) path by this fix's `replayOrigin` capture.
//
// SECOND SCENARIO — THE BLOCKED PATH (card 7edd420b's own `stopping`/`drainHeld` gate): when an unrelated
// stop or companion-upgrade hold is mid-flight, `resumeAfterRateLimit` routes the replay through
// `enqueueStdin` instead of a direct `submit()`. That path carries identity via the `logicalId` tail
// override (the HEAD member only — the same single-entry-mint limit any fresh `enqueueStdin` call has),
// never a raw `origin` array. Proves the held entry that lands in `live.pending` carries the killed
// turn's own logicalId, not a fresh, self-rooted one that would be disjoint for any later content-
// ancestry check.
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon,
//   pnpm build && node test/pty-giveup-rate-limit-replay-origin.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-7a64f16b-rl-origin-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_HOLD_MS = "5000"; // generous — this test resolves well inside the hold

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

async function waitForBusyFalseAfter(sid, sinceLen, label) {
  await sharedWaitUntil(() => busyLog[sid]?.length > sinceLen && busyLog[sid]?.at(-1) === false,
    { timeoutMs: 10_000, intervalMs: 2, label });
}

try {
  const SID = "sess-rl-replay-origin";
  const TEXT = "M_HITS_A_RATE_LIMIT_ON_ITS_VERY_FIRST_WRITE_THEN_REPLAYS_THEN_GIVES_UP_AGAIN";
  spawnReady(SID);
  const live = host.live.get(SID);

  // ===== M's FIRST-EVER write (gen 1) hits a rate limit directly — no give-up has happened yet =====
  host.enqueueStdin(SID, TEXT, "system", undefined, undefined, "agent");
  check("(setup) M delivered immediately, busy armed", busyLog[SID]?.at(-1) === true);
  const mLogicalId = live.giveUpOrigin?.[0]?.logicalId;
  check("(setup) M's own giveUpOrigin is set at write time", mLogicalId !== undefined);

  host.deliverHook(SID, { hook_event_name: "StopFailure", error: "rate_limit" });
  check("(setup) the session is now parked (rateLimited)", live.rateLimited === true && live.busy === false);
  check("(setup) nothing archived yet — M never gave up, only got rate-limited",
    live.ambiguousDispatches.size === 0 && live.retiredGiveUpSignatures.size === 0);

  // ===== THE FIX: resumeAfterRateLimit replays it (gen 2) — the NOT-blocked (direct submit()) path =====
  const lenBeforeReplay = busyLog[SID]?.length ?? 0;
  const resumed = host.resumeAfterRateLimit(SID);
  check("(setup) resume reported success", resumed === true);
  check("(setup) the replay re-armed busy (a genuine new write happened)", live.busy === true);
  check("(THE FIX) the replay's own giveUpOrigin carries M's SAME logicalId — NOT null",
    live.giveUpOrigin !== null && live.giveUpOrigin.some((m) => m.logicalId === mLogicalId));

  // ===== THIS replay ALSO genuinely gives up (no confirming hook ever arrives) =====
  await waitForBusyFalseAfter(SID, lenBeforeReplay, "replay give-up");
  check("(THE FIX) the replay's OWN give-up is properly archived and requeued — NOT a silent drop",
    submitLog.some((l) => l.includes("GIVE-UP RECOVERY: re-queued")));
  check("(THE FIX) M's content survives as a genuinely requeued, redeliverable duplicate — never vanished",
    host.getPendingEntries(SID).some((m) => m.text === TEXT && m.id === mLogicalId));
  check("(THE FIX) M's identity is now properly archived (ambiguousDispatches), so a later genuine echo can still resolve it",
    live.ambiguousDispatches.get(mLogicalId) !== undefined);

  try { host.stop(SID, "hard"); } catch { /* ignore */ }

  // ===== THE FIX, BLOCKED PATH: resumeAfterRateLimit's OTHER branch (stopping/drainHeld) also threads ====
  // ===== the killed turn's own identity through, via enqueueStdin's `logicalId` tail override ============
  {
    const SID2 = "sess-rl-replay-origin-blocked";
    const TEXT2 = "N_HITS_A_RATE_LIMIT_THEN_RESUMES_WHILE_DRAIN_IS_HELD";
    spawnReady(SID2);
    const live2 = host.live.get(SID2);

    host.enqueueStdin(SID2, TEXT2, "system", undefined, undefined, "agent");
    check("(blocked setup) N delivered immediately, busy armed", busyLog[SID2]?.at(-1) === true);
    const nLogicalId = live2.giveUpOrigin?.[0]?.logicalId;
    check("(blocked setup) N's own giveUpOrigin is set at write time", nLogicalId !== undefined);

    host.deliverHook(SID2, { hook_event_name: "StopFailure", error: "rate_limit" });
    check("(blocked setup) the session is now parked (rateLimited)", live2.rateLimited === true && live2.busy === false);

    // Card 7edd420b's own blocked gate: an unrelated stop/companion-upgrade hold can be mid-flight when
    // resume fires — set directly here (same as this file's own direct Live manipulation elsewhere)
    // rather than orchestrating a real overlapping stop/upgrade, since only `drainHeld`'s truthiness is
    // load-bearing for THIS branch choice, not how it got set.
    live2.drainHeld = true;
    const resumed2 = host.resumeAfterRateLimit(SID2);
    check("(blocked) resume reported success", resumed2 === true);
    check("(blocked) resume did NOT submit into the pty — busy stays false (held, not written)", live2.busy === false);

    const held = live2.pending.find((m) => m.text === TEXT2);
    check("(THE FIX, blocked path) the held entry exists in live.pending", held !== undefined);
    check("(THE FIX, blocked path) the held entry's logicalId equals N's own — carried through the `logicalId` tail override, not a fresh self-rooted id",
      held?.logicalId === nLogicalId);

    live2.drainHeld = false;
    try { host.stop(SID2, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 7a64f16b round 2: resumeAfterRateLimit's replay now carries the killed turn's "
    + "own identity through BOTH paths — the non-blocked direct submit() (live.giveUpOrigin, so a SECOND "
    + "give-up on the replay itself is properly archived and requeued instead of silently dropped) and the "
    + "blocked enqueueStdin path (the logicalId tail override, so the held entry is NOT a fresh, disjoint "
    + "identity)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
