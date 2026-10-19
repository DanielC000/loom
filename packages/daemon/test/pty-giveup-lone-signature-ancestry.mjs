// Regression test for card 7a64f16b — "stop a lone stale give-up signature matching unrelated fresh
// text". Found by a0735d53's own worker during investigation, and already flagged as a KNOWN, pre-
// existing, deliberately-deferred limitation in docs/decisions/
// a0735d53-giveup-lineages-release-ungated-from-clearprefix-gate.md's "Known pre-existing limitation"
// section (see that record for the history). The aggravated PARKED sub-case lives in the sibling file
// `pty-giveup-lone-signature-ancestry-parked.mjs` (it needs a SMALL `GIVE_UP_HOLD_MS` to reach PARKED in
// bounded redrains — module-level env, can't coexist in one process with this file's generous hold).
//
// ROOT CAUSE: `purgeConfirmedGiveUpRequeueCore`'s content-match branch resolves a match purely on
// signature equality once exactly one logicalId holds it (`matchedLogicalIds.length === 1`) — with no
// check on whether the confirming hook's own text is actually that lineage's own echo, versus simply
// being the CURRENT, legitimately-outstanding generation's own fresh, UNRELATED submission that happens
// to share byte-identical text with an older, stale `ambiguousDispatches`/`retiredGiveUpSignatures`
// entry. `bc0774c4`'s ambiguity decline only guards a match spanning MORE than one distinct logicalId —
// it does not guard this single-stale-entry-vs-fresh-unrelated-text case at all.
//
// THE FIX: a CONTENT-ANCESTRY check. `live.lastPrompt` is the currently-outstanding write's own text (set
// by `submit()` in lockstep with `enterConfirmed=false`/`++submitGeneration`). When `submitWasOutstanding`
// is true AND the confirming hook's content ALSO equals `live.lastPrompt` (i.e. this hook is AT LEAST
// explainable as the current generation's own confirmation), the matched lineage is resolved ONLY if it
// is genuinely that SAME identity — either no later write has happened since its own archived batchId
// (the common self/retry/probe-C shape), or a later write's own `live.giveUpOrigin` shares the matched
// logicalId (the auto-joined-resend shape, card 844ca34e round 3). Otherwise the match is DECLINED (same
// "handled, not resolved" shape as the pre-existing bc0774c4 ambiguous-decline branch) — never a bare
// generation-NUMBER comparison alone, which would ALSO wrongly decline a genuine late echo of an older
// lineage whenever some OTHER, differently-texted write happens to be outstanding at the same moment (see
// scenario (b) below — this is the exact counter-example a first draft of this fix broke).
//
// Four scenarios here, all driven through the real `purgeConfirmedGiveUpRequeueCore` code path:
//   (a) THE BUG, FIXED: L1 gives up on short text; a totally separate, never-given-up, self-rooted
//       dispatch G3 — confirmed via its own expected hook — happens to carry BYTE-IDENTICAL text. G3's own
//       confirmation must NOT be allowed to resolve L1: L1's duplicate survives, L1's `giveUpLineages`
//       mark survives, `onGiveUpConfirmed` does NOT fire for L1, and a `DECLINED content match` log names
//       why. Positive-controlled in this session's own investigation (worker_report on card 7a64f16b):
//       pre-fix, this scenario produced a `CONFIRMED logicalId=<L1>` log, released L1's mark, purged its
//       duplicate, and fired `onGiveUpConfirmed` for L1 — a genuine, silent, permanent loss of L1's
//       content once purged inside the GIVE_UP_HOLD window.
//   (b) THE COUNTER-EXAMPLE A GENERATION-NUMBER-ONLY GATE WOULD BREAK: L1 gives up on text "continue"; a
//       SEPARATE write G3 with DIFFERENT text ("foo") is outstanding (no hook yet); THEN L1's own REAL
//       late echo ("continue") arrives. This hook unambiguously belongs to L1 (its content doesn't even
//       match G3's own outstanding text) and must resolve normally, despite G3 being outstanding at the
//       same moment. A gate keyed on `resolvedBatchId !== live.submitGeneration` alone (an earlier draft
//       of this fix) wrongly declined this — content ancestry does not.
//   (d) ARM 2 DIRECT (round 2, Code Review item 2): an UNRELATED, intervening turn confirms normally,
//       advancing `lastWriteGeneration` past L1's own archived batch — so arm 1 (same-batch-as-current)
//       genuinely cannot carry L1's resolution on its own terms. THEN a fresh write carrying L1's OWN
//       logicalId (simulating `hasAmbiguousMatch`'s auto-join — card 844ca34e round 3 — directly via the
//       `logicalId` tail override, no SessionService needed) lands at this LATER generation, byte-
//       identical to L1's own archived text. Only arm 2 (the resend's own `live.giveUpOrigin` sharing
//       L1's logicalId) can prove this is the SAME identity rather than a coincidence — this is the case
//       that goes RED if arm 2 is removed and only arm 1 remains.
//   (e) ROUND 2 ITEM 4: the widened 4a0af485 CONFIRMED-gen measurement log (host.ts ~9108) fires for a
//       DECLINE specifically when `ambiguousDispatches` is ALSO empty at hook time — directly seeds
//       `retiredGiveUpSignatures` with L1's own batch-1 signature and clears `ambiguousDispatches`
//       (the shape a redrain would otherwise produce, without needing a third-party identity to stay
//       outstanding — see the rate-limit-replay-origin.mjs investigation note for why that's non-trivial
//       to reach via a real redrain), then reproduces scenario (a)'s disjoint-identity collision. Both
//       `DECLINED content match` and the widened `CONFIRMED gen=` log must fire for the SAME hook.
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon,
//   pnpm build && node test/pty-giveup-lone-signature-ancestry.mjs
//
// NEGATIVE CONTROL (how this was verified to go RED on the pre-fix code, not merely asserted): before the
// fix landed, (a)'s own assertions were run against unfixed `purgeConfirmedGiveUpRequeueCore` (no
// ancestry check at all) and failed exactly as the bug predicts — a `CONFIRMED logicalId=<L1>` log fired,
// `giveUpLineages` released L1's mark, and L1's duplicate was purged from `live.pending`. An intermediate
// draft of the fix (gating on `resolvedBatchId !== live.submitGeneration` alone, with no content-ancestry
// check at all) was separately shown to break (b) AND several pre-existing recovery tests (auto-joined
// resend, self-collision, kickoff re-mint) — see the worker_report on card 7a64f16b for the exact
// commands and RED/GREEN transcripts for both the original bug and that intermediate draft.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-7a64f16b-ancestry-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1"; // production default
process.env.LOOM_GIVE_UP_HOLD_MS = "5000"; // generous — both scenarios resolve well inside the hold, with no sleep in between that could let it expire

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.warn = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleWarn(...args); };

function makeSilentHost(events) {
  class SilentTestPtyHost extends createSeamHost(PtyHost) {
    createPty(opts) {
      const base = super.createPty(opts);
      const writes = [];
      return { ...base, write: (d) => { writes.push(d); }, writes };
    }
  }
  return new SilentTestPtyHost(events);
}

function spawnReady(host, sessionId) {
  host.spawn({ sessionId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

async function waitForBusyFalseAfter(busyLog, sid, sinceLen, label) {
  await sharedWaitUntil(() => busyLog[sid]?.length > sinceLen && busyLog[sid]?.at(-1) === false,
    { timeoutMs: 10_000, intervalMs: 2, label });
}

try {
  // ===== (a) THE BUG, FIXED: a lone stale signature must not resolve off an unrelated, never-given-up =====
  // ===== dispatch's own fresh, coincidentally-identical confirmation ========================================
  {
    const SID = "sess-7a64f16b-a";
    const busyLog = {};
    const giveUpConfirmedLog = [];
    const host = makeSilentHost({
      onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {},
      onGiveUpConfirmed(sessionId, logicalId, latencyMs) { giveUpConfirmedLog.push({ sessionId, logicalId, latencyMs }); },
    });
    const COLLISION_TEXT = "continue";
    spawnReady(host, SID);
    const live = host.live.get(SID);

    const lenBeforeL1 = busyLog[SID]?.length ?? 0;
    const rL1 = host.enqueueStdin(SID, COLLISION_TEXT, "system", undefined, undefined, "agent");
    check("(a) setup: L1 delivered immediately, busy armed", rL1.delivered === true && busyLog[SID]?.at(-1) === true);
    await waitForBusyFalseAfter(busyLog, SID, lenBeforeL1, "(a) L1 give-up");
    check("(a) setup: L1 genuinely gave up (RECOVERY)", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));
    const l1LogicalId = host.getPendingEntries(SID)[0]?.id;
    check("(a) setup: L1 has a requeued duplicate sitting ambiguous in pending", l1LogicalId !== undefined &&
      host.getPendingEntries(SID).filter((m) => m.text === COLLISION_TEXT).length === 1);
    check("(a) setup: L1 is marked in giveUpLineages after its own give-up", live.giveUpLineages.has(l1LogicalId));

    // G3: an entirely SEPARATE, FRESH generation — never given up at all — self-rooted (its own distinct
    // logicalId, no auto-join), whose own text ALSO happens to be byte-identical to L1's archived
    // signature. Confirmed via its OWN expected hook, well within SUBMIT_VERIFY_TIMEOUT_MS of its own
    // write, so G3 itself never gives up.
    submitLog.length = 0;
    const rG3 = host.enqueueStdin(SID, COLLISION_TEXT, "system", undefined, undefined, "agent");
    check("(a) setup: G3 delivered immediately, busy armed", rG3.delivered === true && busyLog[SID]?.at(-1) === true);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: COLLISION_TEXT }); // G3's own, legitimate, expected confirmation

    check("(a) THE FIX: a DECLINED content match log fired, naming L1's logicalId",
      submitLog.some((l) => l.includes("DECLINED content match") && l.includes(l1LogicalId)));
    check("(a) THE FIX: NO content-matched CONFIRMED log fired for L1 off G3's hook",
      !submitLog.some((l) => l.includes(`CONFIRMED logicalId=${l1LogicalId}`)));
    check("(a) THE FIX: L1's giveUpLineages mark is RETAINED (not wrongly released)", live.giveUpLineages.has(l1LogicalId));
    check("(a) THE FIX: L1's requeued duplicate SURVIVES — the only remaining chance to redeliver its content is intact",
      host.getPendingEntries(SID).some((m) => m.id === l1LogicalId));
    check("(a) THE FIX: onGiveUpConfirmed did NOT fire for L1 off G3's unrelated hook",
      !giveUpConfirmedLog.some((e) => e.logicalId === l1LogicalId));
    // Round 2, Code Review item 4: NOT asserted here on purpose — the 4a0af485 CONFIRMED-gen log's own
    // pre-existing gate (`hadNoAmbiguityBeforeThisHook`) reads `live.ambiguousDispatches.size === 0`,
    // which is false in THIS scenario (L1's entry is what's being matched against). That log's widening
    // is covered instead by scenario (e) below, which directly seeds `ambiguousDispatches` empty /
    // `retiredGiveUpSignatures` non-empty to reach the sub-case where the widening is actually observable.

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (b) THE COUNTER-EXAMPLE: L1's own REAL late echo must still resolve even while a DIFFERENT, ======
  // ===== differently-texted write is genuinely outstanding at the same moment ===============================
  {
    const SID = "sess-7a64f16b-b";
    const busyLog = {};
    const giveUpConfirmedLog = [];
    const host = makeSilentHost({
      onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {},
      onGiveUpConfirmed(sessionId, logicalId, latencyMs) { giveUpConfirmedLog.push({ sessionId, logicalId, latencyMs }); },
    });
    spawnReady(host, SID);
    const live = host.live.get(SID);

    const lenBeforeL1 = busyLog[SID]?.length ?? 0;
    host.enqueueStdin(SID, "continue", "system", undefined, undefined, "agent");
    await waitForBusyFalseAfter(busyLog, SID, lenBeforeL1, "(b) L1 give-up");
    const l1LogicalId = host.getPendingEntries(SID)[0]?.id;
    check("(b) setup: L1 gave up and is marked", live.giveUpLineages.has(l1LogicalId));

    // G3: DIFFERENT text, written and left genuinely outstanding — no hook delivered for it yet.
    const rG3 = host.enqueueStdin(SID, "foo", "system", undefined, undefined, "agent");
    check("(b) setup: G3 delivered, busy armed, STILL outstanding (no hook yet)", rG3.delivered === true && busyLog[SID]?.at(-1) === true);

    // L1's REAL late echo arrives now, while G3 is still outstanding and unconfirmed.
    submitLog.length = 0;
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "continue" });

    check("(b) L1's late echo content-matches and resolves DESPITE G3 being outstanding with different text",
      submitLog.some((l) => l.includes(`CONFIRMED logicalId=${l1LogicalId}`) && l.includes("content-matched")));
    check("(b) NOT declined — content ancestry correctly distinguishes this from scenario (a)",
      !submitLog.some((l) => l.includes("DECLINED content match")));
    check("(b) L1's giveUpLineages mark is released", !live.giveUpLineages.has(l1LogicalId));
    check("(b) L1's requeued duplicate is purged (resolved, not left to redrain as a duplicate)",
      !host.getPendingEntries(SID).some((m) => m.id === l1LogicalId));
    check("(b) onGiveUpConfirmed fired for L1", giveUpConfirmedLog.some((e) => e.logicalId === l1LogicalId));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (d) ARM 2 DIRECT: a fresh write carrying an OLDER lineage's own logicalId (the auto-joined- ====
  // ===== resend shape, card 844ca34e round 3) at a LATER generation than that lineage's own archived ====
  // ===== batch — only the giveUpOrigin-overlap arm (never same-batch-as-current) can resolve this =========
  {
    const SID = "sess-7a64f16b-d";
    const busyLog = {};
    const giveUpConfirmedLog = [];
    const host = makeSilentHost({
      onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {},
      onGiveUpConfirmed(sessionId, logicalId, latencyMs) { giveUpConfirmedLog.push({ sessionId, logicalId, latencyMs }); },
    });
    const TEXT = "RESENT_BY_LOGICALID_AT_A_LATER_GENERATION_THAN_ITS_OWN_ARCHIVED_BATCH";
    spawnReady(host, SID);
    const live = host.live.get(SID);

    const lenBeforeL1 = busyLog[SID]?.length ?? 0;
    host.enqueueStdin(SID, TEXT, "system", undefined, undefined, "agent");
    await waitForBusyFalseAfter(busyLog, SID, lenBeforeL1, "(d) L1 give-up");
    const l1LogicalId = host.getPendingEntries(SID)[0]?.id;
    check("(d) setup: L1 gave up, archived at batch 1", live.ambiguousDispatches.get(l1LogicalId)?.batchId === 1);

    // An INTERVENING, unrelated, normally-confirmed write advances the generation counter BEFORE the
    // resend — so `lastWriteGeneration` is genuinely NOT 1 by the time the resend writes (same-batch-as-
    // current, arm 1, is unavailable here on its own terms, not merely skipped).
    submitLog.length = 0;
    const rUnrelated = host.enqueueStdin(SID, "UNRELATED_INTERVENING_TURN", "system", undefined, undefined, "agent");
    check("(d) setup: an unrelated turn confirms normally in between", rUnrelated.delivered === true);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "UNRELATED_INTERVENING_TURN" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(d) setup: lastWriteGeneration is now 2 (the unrelated turn's own write)", live.lastWriteGeneration === 2);
    check("(d) setup: L1's batch-1 archive is untouched by the unrelated turn", live.ambiguousDispatches.get(l1LogicalId)?.batchId === 1);

    // THE RESEND: a fresh dispatch carrying L1's OWN logicalId (simulating hasAmbiguousMatch's auto-join —
    // see card 844ca34e round 3 — without needing the full SessionService/enqueueDurableMessage machinery),
    // at generation 3, byte-identical to L1's own archived text.
    submitLog.length = 0;
    const rResend = host.enqueueStdin(SID, TEXT, "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, { logicalId: l1LogicalId });
    check("(d) setup: the resend delivered immediately, busy armed", rResend.delivered === true && busyLog[SID]?.at(-1) === true);
    check("(d) setup: lastWriteGeneration is now 3 (the resend's own write) — genuinely NOT L1's own batch (1)",
      live.lastWriteGeneration === 3);
    check("(d) setup: the resend's own giveUpOrigin carries L1's SAME logicalId",
      (live.giveUpOrigin ?? []).some((m) => m.logicalId === l1LogicalId));

    // The resend's own confirming hook arrives — content matches L1's archived batch-1 signature too
    // (byte-identical text), but `resolvedBatchId` (1) !== `lastWriteGeneration` (3): ONLY the giveUpOrigin
    // overlap (arm 2) can prove this is the SAME identity, not a coincidence.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT });

    check("(d) ARM 2: the resend RESOLVES L1 via giveUpOrigin overlap — NOT declined (this is what goes RED if arm 2 is removed)",
      submitLog.some((l) => l.includes(`CONFIRMED logicalId=${l1LogicalId}`) && l.includes("content-matched")) &&
      !submitLog.some((l) => l.includes("DECLINED content match")));
    check("(d) ARM 2: L1's giveUpLineages mark is released", !live.giveUpLineages.has(l1LogicalId));
    check("(d) ARM 2: onGiveUpConfirmed fired for L1", giveUpConfirmedLog.some((e) => e.logicalId === l1LogicalId));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (e) ROUND 2 item 4: the widened 4a0af485 CONFIRMED-gen log fires for a DECLINE specifically ======
  // ===== when `ambiguousDispatches` is ALSO empty — a match against `retiredGiveUpSignatures` alone =======
  {
    const SID = "sess-7a64f16b-e";
    const busyLog = {};
    const host = makeSilentHost({
      onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {},
    });
    const TEXT = "RETIRED_ONLY_MATCH_SO_THE_WIDENED_CONFIRMED_GEN_LOG_CAN_FIRE_ON_A_DECLINE";
    spawnReady(host, SID);
    const live = host.live.get(SID);

    const lenBeforeL1 = busyLog[SID]?.length ?? 0;
    host.enqueueStdin(SID, TEXT, "system", undefined, undefined, "agent");
    await waitForBusyFalseAfter(busyLog, SID, lenBeforeL1, "(e) L1 give-up");
    const l1LogicalId = host.getPendingEntries(SID)[0]?.id;
    check("(e) setup: L1 gave up, archived at batch 1", live.ambiguousDispatches.get(l1LogicalId)?.batchId === 1);

    // Directly move L1's archive from the CURRENT slot to RETIRED-ONLY (the shape a redrain would
    // otherwise produce — see the rate-limit-replay-origin.mjs investigation note for why reaching this
    // via a real redrain here would also need a THIRD-PARTY identity to still be outstanding, since the
    // redrain itself consumes L1 as the current write). `ambiguousDispatches.size === 0` is the ONLY
    // precondition `hadNoAmbiguityBeforeThisHook` reads — direct manipulation is the cheap, honest way to
    // reach it without re-deriving a multi-cycle give-up scenario this round deliberately didn't build.
    const archived = live.ambiguousDispatches.get(l1LogicalId);
    live.retiredGiveUpSignatures.set(l1LogicalId, [archived]);
    live.ambiguousDispatches.delete(l1LogicalId);
    check("(e) setup: ambiguousDispatches is now empty, retiredGiveUpSignatures holds L1's own batch-1 signature",
      live.ambiguousDispatches.size === 0 && live.retiredGiveUpSignatures.get(l1LogicalId)?.[0]?.batchId === 1);

    // G3: an entirely separate, self-rooted, never-given-up dispatch whose own text happens to be
    // byte-identical to L1's retired-only signature — same disjoint-identity shape as scenario (a), but
    // this time `ambiguousDispatches` is empty so `hadNoAmbiguityBeforeThisHook` reads true.
    submitLog.length = 0;
    const rG3 = host.enqueueStdin(SID, TEXT, "system", undefined, undefined, "agent");
    check("(e) setup: G3 delivered immediately, busy armed", rG3.delivered === true && busyLog[SID]?.at(-1) === true);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT });

    check("(e) ROUND 2 item 4: DECLINED content match fired, naming L1's logicalId",
      submitLog.some((l) => l.includes("DECLINED content match") && l.includes(l1LogicalId)));
    check("(e) ROUND 2 item 4: the widened CONFIRMED-gen log ALSO fires for this decline (ambiguousDispatches was empty)",
      submitLog.some((l) => /^\[submit\] .* CONFIRMED gen=2 logicalId=/.test(l)));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 7a64f16b: a lone stale give-up signature no longer resolves off an unrelated, "
    + "never-given-up dispatch's own coincidentally-identical confirmation (a), a genuine late echo of an "
    + "older lineage still resolves despite a differently-texted write being outstanding (b), an "
    + "auto-joined resend at a LATER generation than its own archived batch still resolves via the "
    + "giveUpOrigin-overlap arm specifically (d), and the widened CONFIRMED-gen measurement log fires for "
    + "a decline against a retired-only signature (e)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
