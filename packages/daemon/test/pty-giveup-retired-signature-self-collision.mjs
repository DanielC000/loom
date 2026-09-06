// Regression test for card dbc7ffea's Code Review Major 2 — a message's OWN successive give-up cycles must
// never be mistaken for two GENUINELY DISTINCT give-up events by `purgeConfirmedGiveUpRequeue`'s
// batch-provenance discrimination (card bc0774c4), even when `GIVE_UP_REQUEUE_LIMIT >= 2`.
//
// THE MECHANISM: the possible-duplicate tag (`framePossibleDuplicate`) embeds only the message's
// `rootMsgId`, never the generation number — so a THIRD cycle's tagged text is byte-identical to a SECOND
// cycle's own tagged text (same logicalId, same tag, same original content). At `GIVE_UP_REQUEUE_LIMIT=3`:
// cycle 1 gives up (archived bare), cycle 2 gives up (archived TAGGED, batchId=2), cycle 3 gives up (KEPT —
// not exhausted — its CURRENT signature is the SAME tagged text, batchId=3). A late hook reporting that
// tagged text now matches BOTH the retired (batchId=2) and current (batchId=3) entries — ONE logicalId,
// TWO of its own batchIds. Pre-fix, `purgeConfirmedGiveUpRequeue` counted DISTINCT BATCHIDS alone and
// treated this as "2 distinct give-up batches" — the exact shape card bc0774c4's guard exists to catch for
// TWO SEPARATE messages — and declined to resolve a message that was never actually ambiguous, silently
// defeating this card's own purpose (a real duplicate then lands, though never a loss).
//
// THE FIX: group matches by logicalId FIRST. Exactly one logicalId, however many of its own batchIds
// matched, is never ambiguous by construction — resolve immediately. Only fall back to the batchId check
// once MULTIPLE DISTINCT logicalIds are involved (the case bc0774c4 actually targets).
//
// RUN: `pnpm build` (from packages/daemon) then `node test/pty-giveup-retired-signature-self-collision.mjs`.
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

const tmpHome = path.join(os.tmpdir(), `loom-giveup-self-collision-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";
const HOLD_MS = 200;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
// The whole point: THREE cycles of the SAME message, none of them exhausting.
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "3";

const { PtyHost, framePossibleDuplicate } = await import("../dist/pty/host.js");
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
const host = new SilentTestPtyHost(events);

function spawnReady(sessionId) {
  host.spawn({ sessionId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

try {
  const SID = "sess-self-collision";
  const TEXT = "SELF_COLLISION_ACROSS_OWN_CYCLES";
  spawnReady(SID);

  // ===== cycle 1: give up, held (archived at redrain below) =====
  const r1 = host.enqueueStdin(SID, TEXT);
  check("(setup) cycle 1 delivered immediately, busy armed", r1.delivered === true && busyLog[SID]?.at(-1) === true);
  await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  const entries1 = host.getPendingEntries(SID);
  check("(setup) cycle 1 gave up, requeued, held", entries1.length === 1);
  const LOGICAL_ID = entries1[0].id; // enqueueStdin's own first attempt: logicalId defaults to the message's own id
  const TAGGED_TEXT = framePossibleDuplicate(TEXT, LOGICAL_ID);

  // ===== cycle 2: redrain (archives cycle 1's bare signature), give up again (archived TAGGED at the NEXT ====
  // ===== redrain, batchId=2) — KEPT, not exhausted (limit=3) =====
  await sleepPast(HOLD_MS + 150, HOLD_MS, "past GIVE_UP_HOLD_MS (cycle 1 hold)");
  host.reconcile();
  await sharedWaitUntil(() => busyLog[SID]?.at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
  await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check("(setup) cycle 2 gave up, requeued, held (limit=3, not exhausted)", host.getPendingEntries(SID).length === 1);

  // ===== cycle 3: redrain (archives cycle 2's TAGGED signature, batchId=2), give up a THIRD time — its own ===
  // ===== CURRENT signature is the SAME tagged text (the tag embeds only rootMsgId, never the generation) — ==
  // ===== KEPT (requeues=3, NOT > limit=3) =====
  await sleepPast(HOLD_MS + 150, HOLD_MS, "past GIVE_UP_HOLD_MS (cycle 2 hold)");
  host.reconcile();
  await sharedWaitUntil(() => busyLog[SID]?.at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
  await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check("(setup) cycle 3 gave up, requeued, held (limit=3, still not exhausted — this is the self-collision setup)",
    host.getPendingEntries(SID).length === 1);

  // ===== THE TEST: a late hook reports the TAGGED text — matches BOTH cycle 2's ARCHIVED entry (batchId=2) ===
  // ===== AND cycle 3's CURRENT entry (batchId=3) — ONE logicalId, two of its OWN batchIds. Must resolve, ====
  // ===== not decline as a cross-message ambiguity. =============================================================
  submitLog.length = 0;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TAGGED_TEXT });
  check("(1) THE FIX: a message's OWN multi-cycle self-collision resolves (CONFIRMED, content-matched) rather than declining as cross-batch ambiguity",
    submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  check("(1) THE FIX: NO 'AMBIGUOUS content match ... distinct give-up batches' decline fired for this single-logicalId self-collision",
    !submitLog.some((l) => l.includes("AMBIGUOUS content match")));
  check("(1) cycle 3's held duplicate was purged — nothing left to drain a further physical write",
    host.getPendingEntries(SID).length === 0);

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card dbc7ffea's batch-provenance discrimination now groups by logicalId before it ever " +
    "looks at batchId: a single message's own successive give-up cycles (GIVE_UP_REQUEUE_LIMIT >= 2) never " +
    "get mistaken for two genuinely distinct give-up events sharing byte-identical text, while the ORIGINAL " +
    "cross-message collision case (pty-giveup-distinct-collision-provenance.mjs) still declines correctly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
