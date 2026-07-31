// Regression test for card bc0774c4 — "purge-by-signature can drop a genuinely distinct byte-identical
// message — fail toward duplicate, never toward loss".
//
// ROOT CAUSE being guarded: `purgeConfirmedGiveUpRequeue`'s content-match branch purged EVERY
// `Live.ambiguousDispatches` entry whose `{len,hash}` signature matched a confirming hook's `hook.prompt`,
// with no notion of WHICH give-up event produced that entry. `requeueGiveUpOrigin` deliberately seeds every
// member of ONE coalesced drain with the identical joined signature (so one hook resolves the whole batch)
// — but two GENUINELY DISTINCT dispatches (two separate give-up events) that happen to carry byte-identical
// text are indistinguishable from one coalesced batch by signature alone (no hash collision needed, P=1
// once two such entries coexist). Pre-fix, one confirming hook purged BOTH, firing `onDeliver
// ("duplicate-of-confirmed-original")` on both and permanently resolving the still-undelivered one's
// durable row — `recoverUndeliveredMessagesOnBoot` never redrives a resolved row, so this was a genuine,
// silent, permanent message loss.
//
// THE FIX: every `Live.ambiguousDispatches` entry now also carries a `batchId` (the `gen` every member of
// ONE `requeueGiveUpOrigin` call is seeded under). A content match purges only when every matched entry
// shares ONE `batchId`; a match spanning more than one batch is left COMPLETELY untouched rather than
// guessed at (an age-based "purge the oldest batch" tie-break was considered and REJECTED — see host.ts's
// own "CARD bc0774c4 — BATCH-PROVENANCE DISCRIMINATION" doc block for the concrete counter-trace: a
// YOUNGER batch's held entry can redrain under a brand-new `submitGeneration` and confirm normally while an
// OLDER same-signature batch is still sitting genuinely unconfirmed — "purge the oldest" would then purge
// the OLDER one, which was never actually confirmed, which is still loss through a narrower door).
//
// This suite proves, against a fake pty that never emits output (so every give-up here is a genuine drop):
//   (1) RED-FIRST SHAPE (see below for how this was actually positive-controlled against unfixed code):
//       two INDEPENDENT dispatches — not a coalesced drain — carrying byte-identical text both give up, so
//       both sit ambiguous under DIFFERENT batchIds. A single confirming hook matching that text must NOT
//       purge either one: content alone cannot tell which (if either) it actually confirms, and the manager
//       review on this card demonstrated that an age-based tie-break is refutable, not merely imperfect —
//       so the only safe outcome is BOTH survive. This directly covers the reachability case the manager
//       flagged ("two batches, hook matching the YOUNGER one, assert the older is not silently resolved"):
//       since content can't distinguish "confirms A" from "confirms B" here, the fix's own bar is that
//       NEITHER is silently resolved regardless of which one a hook might "really" mean.
//   (2) REGRESSION, on a fresh session: an ordinary, non-colliding single-batch confirmation still
//       content-matches and purges cleanly exactly as before this card — the fix's new grouping-by-batchId
//       step is a no-op for the by-far-common case (already covered by pty-giveup-content-match-attribution
//       and pty-giveup-coalesced-content-match; reasserted here for a self-contained read). Run on a
//       SEPARATE session rather than reusing (1)'s, deliberately: a Stop hook carries no `prompt` at all, so
//       ending (1)'s synthetic confirmation with one would exercise the SEPARATE, content-blind
//       FIFO-position fallback instead (a pre-existing mechanism this card does not touch) and conflate the
//       two.
//
// RUN (no daemon needed): node test/pty-giveup-distinct-collision-provenance.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
//
// POSITIVE CONTROL (how this was actually verified to go RED on unfixed code, not merely asserted): before
// this file existed, `git stash` was used to temporarily revert host.ts's card-bc0774c4 changes (the
// `batchId` field/type, its stamping in `requeueGiveUpOrigin`, and the batch-grouping check in
// `purgeConfirmedGiveUpRequeue`) while leaving this test file in place, then `pnpm build && node
// test/pty-giveup-distinct-collision-provenance.mjs` was run against that reverted build. Check (1) failed
// exactly as predicted — BOTH dispatch A's and dispatch B's pending copies were purged by the single
// confirming hook, and `onDeliver("duplicate-of-confirmed-original")` fired for both — the RED case
// (silent loss of whichever one was NOT actually confirmed). `git stash pop` restored the fix, and the
// same run went GREEN. See the worker's `done` report on card bc0774c4 for the exact command transcript.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    await sleep(2);
  }
}

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };
console.warn = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleWarn(...args); };

const tmpHome = path.join(os.tmpdir(), `loom-giveup-distinct-collision-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_HOLD_MS = "5000"; // generous — this test resolves/asserts before any hold expires

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
const host = new SilentTestPtyHost(events);

function spawnReady(sessionId) {
  host.spawn({ sessionId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

try {
  const SID = "sess-distinct-collision";
  const COLLISION_TEXT = "SAME_BYTE_IDENTICAL_TEXT_TWO_INDEPENDENT_DISPATCHES";
  spawnReady(SID);

  // ===== dispatch A: idle-immediate, then a genuine give-up (silent pty never confirms) =====
  const rA = host.enqueueStdin(SID, COLLISION_TEXT);
  check("(setup) dispatch A delivered immediately, busy armed", rA.delivered === true && busyLog[SID]?.at(-1) === true);
  await waitUntil(() => busyLog[SID]?.at(-1) === false);
  check("(setup) dispatch A genuinely gave up (RECOVERY)", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));
  check("(setup) dispatch A's copy is requeued, sitting ambiguous in pending",
    host.getPendingEntries(SID).filter((m) => m.text === COLLISION_TEXT).length === 1);

  // ===== dispatch B: an ENTIRELY SEPARATE, later dispatch — NOT a coalesced drain of A, its own fresh =====
  // ===== enqueueStdin call, delivered immediately because A's give-up already cleared busy — that ALSO ====
  // ===== happens to carry byte-identical text, and ALSO genuinely gives up ===================================
  submitLog.length = 0;
  const rB = host.enqueueStdin(SID, COLLISION_TEXT);
  check("(setup) dispatch B delivered immediately (a SEPARATE generation, not a coalesced batch with A), busy armed",
    rB.delivered === true && busyLog[SID]?.at(-1) === true);
  await waitUntil(() => busyLog[SID]?.at(-1) === false);
  check("(setup) dispatch B ALSO genuinely gave up (RECOVERY)", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));
  check("(setup) BOTH A and B now sit ambiguous, sharing one signature, TWO copies in pending",
    host.getPendingEntries(SID).filter((m) => m.text === COLLISION_TEXT).length === 2);

  // ===== (1) THE FIX: a single confirming hook matching the shared text arrives. Content alone cannot =====
  // ===== tell which of A/B (if either) it actually confirms — the safe, fail-toward-duplicate answer is ===
  // ===== NEITHER gets purged. (Positive-controlled against unfixed code — see this file's own header — ====
  // ===== unfixed code purges BOTH here, which is the exact silent loss this card exists to close.) =========
  submitLog.length = 0;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: COLLISION_TEXT });
  check("(1) THE FIX: an AMBIGUOUS multi-batch content match was logged, naming 2 distinct batches",
    submitLog.some((l) => l.includes("AMBIGUOUS content match") && l.includes("2 distinct give-up batches")));
  check("(1) THE FIX: NO content-matched CONFIRMED log fired for this hook (nothing was attributed)",
    !submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  check("(1) THE FIX: BOTH A's and B's copies SURVIVE untouched — neither silently resolved as a duplicate (this is the manager-requested case: the OLDER of the two is not silently resolved just because content matched)",
    host.getPendingEntries(SID).filter((m) => m.text === COLLISION_TEXT).length === 2);

  // Deliberately NO Stop hook here — this UserPromptSubmit represents a LATE, synthetic re-confirmation of
  // an already-recovered give-up (exactly mirroring pty-giveup-content-match-attribution.mjs's own "gen 1's
  // own late confirmation arrives" step, which likewise sends UserPromptSubmit alone). A Stop hook carries
  // no `prompt` field at all (see `purgeConfirmedGiveUpRequeue`'s own doc), so it would fall straight
  // through to the PRE-EXISTING, content-BLIND FIFO-position fallback — a SEPARATE, already-documented
  // mechanism this card does not touch — and conflate that unrelated mechanism's own behavior with this
  // card's content-match fix. Test (2) below exercises the ordinary single-batch path on its own fresh
  // session instead, precisely to keep the two mechanisms from entangling in one assertion.
  try { host.stop(SID, "hard"); } catch { /* ignore */ }

  // ===== (2) unrelated resolution, on a FRESH session: the batch-grouping step this card adds is a no-op =====
  // ===== for the by-far-common case — a single, non-colliding batch still content-matches and purges =========
  // ===== cleanly exactly as before this card (regression, same shape pty-giveup-content-match-attribution ===
  // ===== and pty-giveup-coalesced-content-match already cover — reasserted here in the SAME file as the ======
  // ===== collision case for a self-contained read) ============================================================
  const SID2 = "sess-distinct-collision-unrelated-regression";
  const UNRELATED_TEXT = "UNRELATED_SINGLE_BATCH_TEXT";
  spawnReady(SID2);
  submitLog.length = 0;
  const rC = host.enqueueStdin(SID2, UNRELATED_TEXT);
  check("(setup) unrelated dispatch C delivered immediately, busy armed", rC.delivered === true && busyLog[SID2]?.at(-1) === true);
  await waitUntil(() => busyLog[SID2]?.at(-1) === false);
  check("(setup) unrelated dispatch C genuinely gave up (RECOVERY)", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));

  submitLog.length = 0;
  host.deliverHook(SID2, { hook_event_name: "UserPromptSubmit", prompt: UNRELATED_TEXT });
  check("(2) an unrelated single-batch confirmation still content-matches and purges cleanly",
    submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  check("(2) unrelated dispatch C's copy is purged from pending",
    !host.getPendingEntries(SID2).some((m) => m.text === UNRELATED_TEXT));

  try { host.stop(SID2, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a content match spanning more than one give-up batch (two genuinely distinct dispatches sharing byte-identical text) resolves NEITHER rather than guessing, closing the silent-loss residual card 4a0af485 documented and card bc0774c4 fixes, while an unrelated single-batch confirmation is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
