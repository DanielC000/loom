// Regression tests for card a0735d53 (Code Review round 5 Minor, card 844ca34e) — the giveUpLineages
// release for a POSITIVE content match (`purgeResult.contentMatchedLogicalIds`) must fire UNCONDITIONALLY,
// never nested inside the `composerDirtyLenClearedByGen === submitGeneration` gate. That gate answers a
// different question (did THIS hook's own generation's clear-prefix land) and is false whenever a
// generation's FIRST-EVER write was a clean-composer plain paste (composerDirtyLen === 0 at write time) —
// that branch never touches composerDirtyLenClearedByGen at all (host.ts's plain full-paste branch).
//
//   (1) THE FIX, PROBE C SHAPE: a fresh message gives up on a genuinely clean composer (its first-ever
//       write), is requeued into the bounded GIVE_UP_HOLD, and — BEFORE any Enter-only redelivery/reconcile
//       pass ever runs — a late UserPromptSubmit hook arrives whose `prompt` is the engine's own WRAPPED
//       echo of the exact body Loom wrote. The purge call content-matches and decisively resolves this
//       generation (clearComposerDirtyOnConfirm, deletes the ambiguousDispatches entry) regardless of the
//       gate, but on main (pre-hoist) `composerDirtyLenClearedByGen` is still `null` (never set — the clean
//       branch doesn't touch it) while `submitGeneration` is `1`, so the gate is FALSE and the already-
//       proven-delivered giveUpLineages mark is left stuck. RED on main: the mark stays marked. GREEN
//       after the hoist: the mark is released.
//   (2) BOUNDARY, THE OTHER SIDE: two genuinely DISTINCT give-ups (two separate enqueueStdin calls, two
//       distinct logicalIds, two distinct batchIds/generations) share byte-identical text. A late wrapped
//       echo of that shared text matches BOTH logicalIds spanning two batchIds — the bc0774c4 AMBIGUOUS-
//       decline path — so `contentMatchedLogicalIds` comes back EMPTY and NEITHER mark is released. This
//       pins the AMBIGUOUS-decline boundary itself, which lives entirely in
//       `purgeConfirmedGiveUpRequeueCore` and passes with or without (1)'s hoist — included for
//       completeness alongside (1), not as evidence the hoist changed this path.
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon,
//   pnpm build && node test/pty-giveup-content-match-release-ungated.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-giveup-release-ungated-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
const HOLD_MS = 5_000; // deliberately LARGE relative to the test's own timings — the whole point of probe
                        // C is to confirm the hook WHILE still inside the hold, well before any reconcile.
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1"; // production default

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}

const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {}, onRateLimited() {}, onExit() {},
};

function spawnReady(host, sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  return fakes[fakes.length - 1];
}

async function waitForBusyFalseAfter(sid, sinceLen, label) {
  await sharedWaitUntil(() => busyLog[sid]?.length > sinceLen && busyLog[sid]?.at(-1) === false,
    { timeoutMs: 10_000, intervalMs: 2, label });
}

// Builds the engine's own paste-composer wrap exactly as `PASTED_CONTENT_WRAP_RE` requires it (host.ts):
// `\n\n<pasted_content id="ID">\n<inner>\n</pasted_content id="ID">\n`.
const pastedContentWrap = (id, inner) => `\n\n<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">\n`;

/** Drives a fresh message through exactly ONE give-up, on a genuinely CLEAN composer (this lineage's
 *  first-ever write) — and stops there, WITHOUT ever calling `host.reconcile()` or waiting out the hold.
 *  Leaves the lineage marked in `giveUpLineages`, its signature seeded in `ambiguousDispatches`, and —
 *  load-bearing for probe C — `composerDirtyLenClearedByGen` untouched (still whatever it was before this
 *  call; `null` for a fresh session), since the clean-composer plain-paste branch never sets that field. */
async function setupGiveUpOnlyOnCleanComposer(host, SID, TEXT) {
  const lenBefore = busyLog[SID]?.length ?? 0;
  const r = host.enqueueStdin(SID, TEXT, "system", undefined, undefined, "agent");
  if (!r.delivered) throw new Error("setup: not delivered immediately");
  await waitForBusyFalseAfter(SID, lenBefore, "setup: own give-up");
  const logicalId = host.getPendingEntries(SID)[0]?.id;
  if (logicalId === undefined) throw new Error("setup: no pending entry after give-up");
  return logicalId;
}

try {
  // ===== (1) THE FIX, PROBE C SHAPE: a late wrapped echo DURING the hold (no redelivery has happened
  //           yet, so composerDirtyLenClearedByGen was never stamped for this generation) still releases
  //           the already-content-proven mark. =====
  {
    const host = new TestPtyHost(events);
    const SID = "sess-probe-c-ungated-release";
    const TEXT_Z = "PROBE_C_Z_GIVES_UP_ON_A_CLEAN_COMPOSER_THEN_A_LATE_WRAPPED_ECHO_ARRIVES_DURING_THE_HOLD_ZZZZZ";
    spawnReady(host, SID);
    const live = host.live.get(SID);

    const zLogicalId = await setupGiveUpOnlyOnCleanComposer(host, SID, TEXT_Z);
    check("(1) setup: Z is marked after its own give-up", live.giveUpLineages.has(zLogicalId));
    check("(1) setup: composerDirtyLenClearedByGen was never stamped for this generation (probe C's load-bearing precondition — the clean-composer plain-paste branch doesn't touch it)",
      live.composerDirtyLenClearedByGen !== live.submitGeneration);

    // Still well inside GIVE_UP_HOLD_MS (5000ms) — no reconcile(), no redelivery, nothing has touched
    // composerDirtyLenClearedByGen since the give-up fired.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: pastedContentWrap("w1", TEXT_Z) });

    check("(1) THE FIX, THE ASSERTION THAT GOES RED ON main (pre-hoist): a wrapped echo of Z's own exact "
      + "body content-matches DURING the hold, before any redelivery ever stamped the unrelated "
      + "composerDirtyLenClearedByGen gate — Z's giveUpLineages mark IS released anyway",
      !live.giveUpLineages.has(zLogicalId));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (2) BOUNDARY: an AMBIGUOUS content match (two distinct logicalIds, two distinct batchIds,
  //           byte-identical text) still releases NOTHING — pins bc0774c4's decline itself; this
  //           boundary passes with or without (1)'s hoist, not evidence the hoist changed it. =====
  {
    const host = new TestPtyHost(events);
    const SID = "sess-probe-c-ambiguous-no-release";
    const TEXT_SHARED = "AMBIGUOUS_SHARED_TEXT_TWO_DISTINCT_GIVE_UPS_BYTE_IDENTICAL_AAAAAAAAAAAAAAAAAAAA";
    spawnReady(host, SID);
    const live = host.live.get(SID);

    const id1 = await setupGiveUpOnlyOnCleanComposer(host, SID, TEXT_SHARED);
    check("(2) setup: first give-up (id1) is marked", live.giveUpLineages.has(id1));

    // A SECOND, genuinely distinct enqueue of the SAME text — PtyHost.enqueueStdin (unlike
    // sessions/service.ts's enqueueDurableMessage) never auto-joins by content, so this mints a fresh
    // logicalId/generation rather than reusing id1's.
    const id2 = await setupGiveUpOnlyOnCleanComposer(host, SID, TEXT_SHARED);
    check("(2) setup: second give-up (id2) is marked, and is a DISTINCT logicalId from id1", live.giveUpLineages.has(id2) && id2 !== id1);

    // One confirming hook, one shared signature — matches BOTH id1 and id2, spanning two distinct
    // batchIds (their two distinct generations) — the bc0774c4 AMBIGUOUS-decline shape.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: pastedContentWrap("w2", TEXT_SHARED) });

    check("(2) BOUNDARY: an ambiguous match spanning 2 distinct logicalIds/batchIds releases NEITHER mark — id1 stays marked",
      live.giveUpLineages.has(id1));
    check("(2) BOUNDARY: an ambiguous match spanning 2 distinct logicalIds/batchIds releases NEITHER mark — id2 stays marked",
      live.giveUpLineages.has(id2));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card a0735d53: the giveUpLineages content-match release now fires UNCONDITIONALLY "
    + "(never gated on composerDirtyLenClearedByGen), releasing a proven content match even during the "
    + "GIVE_UP_HOLD before any redelivery ever stamped that unrelated gate (1), while an AMBIGUOUS match "
    + "spanning distinct logicalIds/batchIds still correctly releases nothing (2)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
