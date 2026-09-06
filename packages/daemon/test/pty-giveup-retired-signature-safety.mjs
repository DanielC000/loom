// Regression test for card dbc7ffea's own `retiredGiveUpSignatures` archive (host.ts) — the NEW surface
// that fix introduced. `pty-giveup-exhausted-remint-purge-decline.mjs` proves the archive correctly
// RESOLVES the specimen it was built for; this file proves the archive does NOT introduce a new way to
// wrongly purge a genuinely-unconfirmed message, per the manager's own review of the checkpoint (a test
// that only exercises the OLD, pre-archive code path is not evidence about the new one).
//
// TWO SHAPES, both exercised against the archive specifically (not just the pre-existing live-map path
// pty-giveup-distinct-collision-provenance.mjs already covers):
//
//   (1) CROSS-logicalId: an archived (retired) signature for logicalId A, matched by a confirming hook,
//       must resolve ONLY A's own still-held duplicate — never a completely unrelated logicalId B's own
//       genuinely-held, genuinely-unconfirmed entry. If the archive is keyed by logicalId this holds by
//       construction, but "by construction" is a claim about code just written — asserted directly here.
//
//   (2) BATCH PROVENANCE, spanning the archive: `purgeConfirmedGiveUpRequeue`'s existing batch-provenance
//       discrimination (card bc0774c4) must apply IDENTICALLY when one of the colliding signatures lives in
//       `retiredGiveUpSignatures` and the other lives in the live `ambiguousDispatches` map — a
//       byte-identical-text collision spanning two genuinely distinct give-up events (different batchIds)
//       must resolve NEITHER, exactly as it already does when both collide within the live map alone
//       (pty-giveup-distinct-collision-provenance.mjs). The held, genuinely-unconfirmed side must not only
//       survive the ambiguous hook untouched, but go on to actually DELIVER once its own bounded hold
//       expires — fail toward a duplicate, never toward a loss (mirrors
//       pty-giveup-hold-until-confirmed.mjs scenario (4)'s own "THE DELIVERY" check, applied to this new
//       archive-spanning shape).
//
// RUN: `pnpm build` (from packages/daemon) then `node test/pty-giveup-retired-signature-safety.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil, sleepPast } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };
console.warn = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleWarn(...args); };

const tmpHome = path.join(os.tmpdir(), `loom-giveup-retired-sig-safety-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";
const HOLD_MS = 200;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
// GIVE_UP_REQUEUE_LIMIT is read ONCE at module-load time (dist/pty/host.js) — it cannot vary within one
// process, so both scenarios below share this single value (1), same as the file this one is a sibling to
// (pty-giveup-exhausted-remint-purge-decline.mjs). Neither scenario needs a "kept" (not-yet-exhausted)
// second cycle to make its point.
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
const busyLog = {};
const events = { onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {} };
class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}

function spawnReady(host, sessionId) {
  host.spawn({ sessionId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

try {
  // ===== (1) CROSS-logicalId: an archived signature for A must never touch an unrelated B ==================
  {
    const host = new SilentTestPtyHost(events);
    const SID = "sess-retired-cross-logicalid";
    const TEXT_A = "RETIRED_ARCHIVE_TARGET_A";
    const TEXT_B = "COMPLETELY_UNRELATED_HELD_B";
    spawnReady(host, SID);

    // ----- drive A through cycle 1 (give up, held), redrain (archives A's bare signature), then cycle 2 -----
    // ----- EXHAUSTS for real (limit=1, no re-mint wired here) — nothing of A's own is left in `pending`; -----
    // ----- the ONLY trace of A is its archived (retired) signature, exactly like the primary specimen -------
    const rA = host.enqueueStdin(SID, TEXT_A);
    check("(1 setup) A delivered immediately, busy armed", rA.delivered === true && busyLog[SID]?.at(-1) === true);
    await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    check("(1 setup) A's cycle 1 gave up, requeued", host.getPendingEntries(SID).filter((m) => m.text === TEXT_A).length === 1);

    await sleepPast(HOLD_MS + 150, HOLD_MS, "past GIVE_UP_HOLD_MS (A's cycle 1 hold)");
    host.reconcile(); // redrains A for cycle 2 — THIS is where drainPending archives A's cycle-1 bare signature
    await sharedWaitUntil(() => busyLog[SID]?.at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
    await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    check("(1 setup) A's cycle 2 EXHAUSTED for real (limit=1) — nothing of A's own left in pending",
      host.getPendingEntries(SID).length === 0);

    // ----- B: a completely separate, later dispatch, own logicalId, genuinely still unconfirmed -----
    submitLog.length = 0;
    const rB = host.enqueueStdin(SID, TEXT_B);
    check("(1 setup) B delivered immediately (separate generation), busy armed", rB.delivered === true && busyLog[SID]?.at(-1) === true);
    await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    check("(1 setup) B ALSO gave up, requeued, held", host.getPendingEntries(SID).some((m) => m.text === TEXT_B));

    // ----- a hook reports A's ORIGINAL bare text — matches ONLY the ARCHIVED (retired) signature, not =====
    // ----- B's, not A's own current (post-redrain) entry ==================================================
    submitLog.length = 0;
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT_A });
    check("(1) THE ARCHIVE FIRES: A's retired (archived) signature content-matches this late hook",
      submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
    check("(1) CROSS-logicalId ISOLATION: B's completely unrelated, genuinely-unconfirmed entry SURVIVES untouched — A's own resolution (nothing of A's own was even left in pending to purge) never reaches it",
      host.getPendingEntries(SID).some((m) => m.text === TEXT_B));
    check("(1) B is still exactly ONE entry — the archive match didn't duplicate or otherwise mutate it",
      host.getPendingEntries(SID).filter((m) => m.text === TEXT_B).length === 1);

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (2) BATCH PROVENANCE spanning the archive: a byte-identical-text collision between a RETIRED ======
  // ===== entry (C) and a live, genuinely distinct entry (D) must resolve NEITHER ============================
  {
    const host = new SilentTestPtyHost(events);
    const SID = "sess-retired-batch-provenance";
    const SHARED_TEXT = "SHARED_BYTE_IDENTICAL_ACROSS_TWO_DISTINCT_EVENTS";
    spawnReady(host, SID);

    // ----- C: give up once (cycle 1, held), redrain (archives SHARED_TEXT's bare signature under C's own ---
    // ----- logicalId/batchId), then let cycle 2 exhaust for real (limit=1) — C's CURRENT entry ends up ------
    // ----- holding the TAGGED text, so only the RETIRED entry still matches the bare SHARED_TEXT -----------
    const rC = host.enqueueStdin(SID, SHARED_TEXT);
    check("(2 setup) C delivered immediately, busy armed", rC.delivered === true && busyLog[SID]?.at(-1) === true);
    await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    check("(2 setup) C's cycle 1 gave up, requeued, held", host.getPendingEntries(SID).length === 1);

    await sleepPast(HOLD_MS + 150, HOLD_MS, "past GIVE_UP_HOLD_MS (C's cycle 1 hold)");
    host.reconcile(); // redrains C — archives C's bare SHARED_TEXT signature into retiredGiveUpSignatures
    await sharedWaitUntil(() => busyLog[SID]?.at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
    await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    check("(2 setup) C's cycle 2 EXHAUSTED for real (limit=1) — nothing of C's own left in pending",
      host.getPendingEntries(SID).length === 0);

    // ----- D: a SEPARATE, later dispatch — own logicalId, own batchId, genuinely still unconfirmed — that ---
    // ----- happens to carry the IDENTICAL text as C's own ORIGINAL (now-archived) write ---------------------
    submitLog.length = 0;
    const rD = host.enqueueStdin(SID, SHARED_TEXT);
    check("(2 setup) D delivered immediately (a genuinely separate event), busy armed", rD.delivered === true && busyLog[SID]?.at(-1) === true);
    await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    check("(2 setup) D ALSO gave up, requeued, held — genuinely unconfirmed", host.getPendingEntries(SID).length === 1);

    // ----- a hook reports SHARED_TEXT — matches BOTH the retired (C) and live (D) stores, under TWO ---------
    // ----- genuinely distinct batchIds. Content alone cannot tell which (if either) it confirms. ------------
    submitLog.length = 0;
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: SHARED_TEXT });
    check("(2) THE FIX (spanning the archive): an AMBIGUOUS content match was logged, naming 2 distinct batches (current+retired combined)",
      submitLog.some((l) => l.includes("AMBIGUOUS content match") && l.includes("2 distinct give-up batches")));
    check("(2) NO content-matched CONFIRMED log fired for this hook (nothing was attributed)",
      !submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
    check("(2) LOSS-SAFETY: D's genuinely-unconfirmed entry SURVIVES this ambiguous hook untouched",
      host.getPendingEntries(SID).some((m) => m.text === SHARED_TEXT));

    // The ambiguous UserPromptSubmit hook itself set busy=true (the daemon now believes SOME turn is
    // running) even though nothing was actually confirmed — a phantom turn, exactly like
    // pty-giveup-exhausted-remint-purge-decline.mjs's own DECLINE-era handling. Close it with a Stop hook
    // before D can ever be redrained, or reconcile() below is a no-op (still busy) and the DELIVERY check
    // below would trivially read busy's stale `true` without D ever actually having redrained.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(2) busy clears after the phantom turn's Stop", busyLog[SID]?.at(-1) === false);

    // THE DELIVERY (mirrors pty-giveup-hold-until-confirmed.mjs scenario 4): surviving the ambiguous hook is
    // not enough on its own — D must still actually be DELIVERED once its own bounded hold expires, proving
    // this is fail-toward-a-duplicate, never a silent loss, for this NEW archive-spanning shape too.
    await sleepPast(HOLD_MS + 150, HOLD_MS, "past GIVE_UP_HOLD_MS (D's own hold)");
    host.reconcile();
    check("(2) THE DELIVERY: D is genuinely redrained once its own hold expires — busy re-armed",
      busyLog[SID]?.at(-1) === true);
    check("(2) pending is empty — D is no longer sitting unresolved", host.getPendingEntries(SID).length === 0);

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card dbc7ffea's retiredGiveUpSignatures archive purges only the logicalId it actually " +
    "matches (a completely unrelated, genuinely-held logicalId is never touched), and the pre-existing " +
    "batch-provenance discrimination applies identically when one side of a byte-identical-text collision " +
    "lives in the archive and the other in the live map — resolving neither and leaving the genuinely- " +
    "unconfirmed one to still actually deliver once its own bounded hold expires."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
