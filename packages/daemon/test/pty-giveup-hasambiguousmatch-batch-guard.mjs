// Regression test for card 2b73179b — "fail closed in hasAmbiguousMatch when a resend matches more than
// one give-up batch."
//
// ROOT CAUSE: `Live.ambiguousDispatches` has TWO consumers reading the SAME map for the SAME hazard —
// "does a content match span more than one GENUINELY DISTINCT give-up event?" `purgeConfirmedGiveUpRequeue`
// (host.ts) was given a hard `batchId` guard by card bc0774c4: a content match spanning more than one
// batch is left COMPLETELY untouched rather than guessed at (an age-based tie-break was considered and
// REJECTED as refutable — see that method's own "CARD bc0774c4" doc block). `hasAmbiguousMatch` reads the
// exact same map for the exact same hazard but had NO `batchId` check at all — first-match-wins over
// `Map` insertion order, which silently performs exactly the oldest-first tie-break its sibling rejected.
//
// THE FIX: `hasAmbiguousMatch` now collects every candidate logicalId that matches `text` (by any of the
// four signature shapes it already tries — joined-as-is, member-as-is, joined-marked, member-marked), then
// applies the SAME single-`batchId` fail-closed rule `purgeConfirmedGiveUpRequeue` already uses: if the
// matches span more than one batch, return null (refuse to guess) instead of the first hit.
//
// This suite proves, against a fake pty that never emits output (every give-up here is a genuine drop):
//   (1) THE ASYMMETRY, reproduced directly (mirrors the reviewer's own executed RED HALF): two
//       INDEPENDENT single-member dispatches share byte-identical text and both give up under DIFFERENT
//       batchIds. `purgeConfirmedGiveUpRequeue` already refuses to attribute a content match spanning both
//       (card bc0774c4, covered by its own suite — reasserted here only as the contrast baseline).
//       Pre-fix, `hasAmbiguousMatch` against that SAME shared text GUESSES the older one anyway — the
//       asymmetry the card opens with, reproduced against real give-up machinery, not merely traced in
//       source.
//   (2) THE FIX for (1): `hasAmbiguousMatch` now returns null in the same situation — refusing to guess,
//       matching its sibling's own refusal instead of contradicting it.
//   (3) THE CONSEQUENCE CHAIN, reproduced (mirrors the reviewer's own executed trace): a COALESCED batch
//       [X,Y] gives up (its entry's full signature is the JOINED text, X+Y). A SEPARATE, later, single
//       dispatch of bare X ALSO gives up under its own batchId, and is driven to EXHAUSTION (its requeue
//       budget is spent — a bare, non-durable drop, so nothing durable survives for it anywhere: this is
//       the PARKED/exhausted-batch shape DoD-2 asks for, not merely "still live and held"). Pre-fix,
//       `hasAmbiguousMatch(bare X)` matches the coalesced batch's own X-member (via its per-member
//       signature) FIRST in Map iteration order and returns it — ignoring the separate, later, now-
//       terminally-exhausted dispatch entirely. A resend citing no id (the real production shape — a
//       manager with no idea which batch it means) auto-joins that WRONG, guessed chain. When the
//       coalesced batch's own genuine confirmation later arrives (the engine echoing the real JOINED
//       text), `purgeConfirmedGiveUpRequeue` content-matches ONLY the coalesced batch's two members (its
//       own `entry.len/hash` IS the joined signature; the exhausted batch's own entry is a DIFFERENT,
//       bare-X signature, so it never enters this match set at all) — a single batchId, so the purge
//       proceeds and sweeps the wrongly-auto-joined resend's own still-queued (never yet dispatched) copy
//       out of `pending`, firing `onDeliver("duplicate-of-confirmed-original")` on it. VERDICT (the one
//       link the card asked to be answered by execution, not argued): this is genuine CONTENT LOSS, not
//       merely mis-attribution — the resend's own text is never physically written to the pty by this
//       purge (it is spliced out of `pending` before ever being dispatched), and the batch it was actually
//       trying to redeliver for is permanently exhausted with nothing left anywhere to redrive it. The
//       shared byte-identical content did reach the engine once, embedded in the coalesced batch's own
//       JOINED write — but that is a coincidence of identical text, not a guarantee, and does not change
//       that THIS resend's own durable row is falsely marked resolved while never having been sent.
//   (4) THE FIX for (3): the same setup, but `hasAmbiguousMatch(bare X)` now returns null instead of
//       guessing — the resend self-roots a disconnected chain instead of being wrongly swept away by an
//       unrelated batch's confirmation. This trades a possible duplicate (if the exhausted batch's content
//       somehow also resurfaces) for never a silent loss — this project's own "fail toward a duplicate,
//       never a loss" principle (88f11385), the SAME trade `purgeConfirmedGiveUpRequeue` already made.
//   (5) CONTROL (regression): an ordinary, non-colliding single-batch `hasAmbiguousMatch` match is
//       untouched by the new batch-grouping step — same shape pty-giveup-marked-resend-autojoin.mjs and
//       pty-giveup-coalesced-membersig-resend.mjs already cover, reasserted here for a self-contained read.
//
// RUN (no daemon needed): node test/pty-giveup-hasambiguousmatch-batch-guard.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
//
// POSITIVE CONTROL (how this was actually verified to go RED on unfixed code): run against the pre-fix
// build (host.ts before this card's own `batchId` guard was added to `hasAmbiguousMatch`) — checks (2) and
// (4) fail exactly as predicted (a non-null, wrongly-guessed logicalId returned instead of null), and check
// (3)'s own consequence-chain assertion (the resend's copy purged as "duplicate-of-confirmed-original")
// PASSES pre-fix — i.e. the bad thing this card exists to prevent is shown actually happening pre-fix, not
// merely argued. `git diff -- src/pty/host.ts` was captured, `git checkout HEAD -- src/pty/host.ts` reverted
// the fix, `pnpm build && node test/pty-giveup-hasambiguousmatch-batch-guard.mjs` run against that reverted
// build, then `git apply` restored the fix and the same run went GREEN. See the worker's `done` report on
// this card for the exact transcript.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && (args[0].startsWith("[submit]") || args[0].startsWith("[give-up]"))) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && (args[0].startsWith("[submit]") || args[0].startsWith("[give-up]"))) submitLog.push(args[0]); realConsoleError(...args); };
console.warn = (...args) => { if (typeof args[0] === "string" && (args[0].startsWith("[submit]") || args[0].startsWith("[give-up]"))) submitLog.push(args[0]); realConsoleWarn(...args); };

const tmpHome = path.join(os.tmpdir(), `loom-hasambig-batch-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_HOLD_MS = "10"; // short — scenario (3) deliberately wants a held entry to redrain

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
  // =========================================================================================================
  // (1)/(2) THE ASYMMETRY — two INDEPENDENT single-member dispatches sharing byte-identical text, both give
  // up under DIFFERENT batchIds. Mirrors pty-giveup-distinct-collision-provenance.mjs's own setup exactly
  // (reasserted here as the direct contrast baseline this card's own RED HALF exhibited).
  // =========================================================================================================
  const SID1 = "sess-hasambig-asymmetry";
  const COLLISION_TEXT = "SAME_BYTE_IDENTICAL_TEXT_TWO_INDEPENDENT_DISPATCHES";
  spawnReady(SID1);

  host.enqueueStdin(SID1, COLLISION_TEXT);
  check("(1 setup) dispatch A delivered immediately, busy armed", busyLog[SID1]?.at(-1) === true);
  await sharedWaitUntil(() => busyLog[SID1]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check("(1 setup) dispatch A genuinely gave up", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));

  submitLog.length = 0;
  host.enqueueStdin(SID1, COLLISION_TEXT);
  check("(1 setup) dispatch B delivered immediately (a SEPARATE generation), busy armed", busyLog[SID1]?.at(-1) === true);
  await sharedWaitUntil(() => busyLog[SID1]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check("(1 setup) dispatch B ALSO genuinely gave up", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));
  check("(1 setup) BOTH A and B sit ambiguous, sharing one signature, TWO copies in pending",
    host.getPendingEntries(SID1).filter((m) => m.text === COLLISION_TEXT).length === 2);

  // CONTRAST BASELINE: purgeConfirmedGiveUpRequeue already refuses this (card bc0774c4) — reasserted here
  // via its own public surface (a confirming hook), not re-testing it, just establishing the sibling's
  // already-correct behavior right next to the sibling under test.
  submitLog.length = 0;
  host.deliverHook(SID1, { hook_event_name: "UserPromptSubmit", prompt: COLLISION_TEXT });
  check("(1) CONTRAST: purgeConfirmedGiveUpRequeue refuses to attribute (2 distinct batches)",
    submitLog.some((l) => l.includes("AMBIGUOUS content match") && l.includes("2 distinct give-up batches")));
  check("(1) CONTRAST: neither A's nor B's copy was purged by the refusal",
    host.getPendingEntries(SID1).filter((m) => m.text === COLLISION_TEXT).length === 2);

  // THE ASYMMETRY / THE FIX: hasAmbiguousMatch against the SAME shared text, same live ambiguity.
  // Pre-fix: returns a non-null, GUESSED logicalId (first-match-wins over Map insertion order) — the
  // asymmetry this card exists to close. Post-fix: returns null, matching the sibling's own refusal above.
  const guess1 = host.hasAmbiguousMatch(SID1, COLLISION_TEXT);
  check("(1)/(2) hasAmbiguousMatch on a match spanning 2 distinct batches returns null (fails closed, no longer guesses) — pre-fix this returns a non-null logicalId, reproducing the asymmetry the sibling method already closed",
    guess1 === null);

  try { host.stop(SID1, "hard"); } catch { /* ignore */ }

  // =========================================================================================================
  // (3)/(4) THE CONSEQUENCE CHAIN — a COALESCED batch [X,Y] (its own entry signature is the JOINED text)
  // plus a SEPARATE, later, single dispatch of bare X, driven to EXHAUSTION (a bare, non-durable drop — the
  // PARKED/no-further-redrive shape). hasAmbiguousMatch(bare X) can match EITHER via per-member signature
  // (the coalesced batch's own X-member) or via full-entry signature (the exhausted batch, single-member so
  // its own entry IS the bare-X signature) — two DIFFERENT signature shapes landing on the SAME plain text,
  // spanning two DIFFERENT batchIds. purgeConfirmedGiveUpRequeue only ever checks the full-entry shape, so
  // it can NEVER see this particular collision (the exhausted batch's entry never matches the JOINED
  // confirmation) — it is hasAmbiguousMatch's OWN job to catch it.
  // =========================================================================================================
  const SID2 = "sess-hasambig-consequence";
  const DRAIN_SEPARATOR = "\n\n────────\n\n"; // mirrors host.ts's own DRAIN_SEPARATOR literal
  const TEXT_X = "COALESCED_MEMBER_X_ALSO_DISPATCHED_SEPARATELY";
  const TEXT_Y = "COALESCED_MEMBER_Y_NEVER_DISPATCHED_ALONE";
  const JOINED_TEXT = TEXT_X + DRAIN_SEPARATOR + TEXT_Y;
  spawnReady(SID2);

  // kickstart turn, confirmed cleanly so it never itself gives up
  host.enqueueStdin(SID2, "KICKSTART_TURN", "system", undefined, undefined, "agent");
  check("(3 setup) kickstart delivered immediately, busy armed", busyLog[SID2]?.at(-1) === true);
  host.deliverHook(SID2, { hook_event_name: "UserPromptSubmit", prompt: "KICKSTART_TURN" });

  // batch1 = COALESCED [X, Y]: both queued while busy, drained together as ONE physical write on Stop
  const rX = host.enqueueStdin(SID2, TEXT_X, "system", undefined, undefined, "warning");
  const rY = host.enqueueStdin(SID2, TEXT_Y, "system", undefined, undefined, "warning");
  check("(3 setup) both X and Y HELD (busy) — queued to coalesce", rX.delivered === false && rY.delivered === false);
  host.deliverHook(SID2, { hook_event_name: "Stop" });
  check("(3 setup) the coalesced drain went out as ONE turn (busy re-armed)", busyLog[SID2]?.at(-1) === true);
  check("(3 setup) the ACTUAL write contains the JOINED text (proves coalescing fired, not two turns)",
    fakes.at(-1).writes.join("").includes(JOINED_TEXT));

  submitLog.length = 0;
  await sharedWaitUntil(() => busyLog[SID2]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check("(3 setup) the coalesced batch genuinely gave up", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));
  const pendingAfterBatch1 = host.getPendingEntries(SID2);
  check("(3 setup) BOTH X and Y are requeued, sitting ambiguous", pendingAfterBatch1.some((m) => m.text === TEXT_X) && pendingAfterBatch1.some((m) => m.text === TEXT_Y));

  // batch2 = a SEPARATE, single, later dispatch of bare X (worker now idle — own fresh generation)
  submitLog.length = 0;
  host.enqueueStdin(SID2, TEXT_X, "system", undefined, undefined, "warning");
  check("(3 setup) batch2 (bare X) delivered immediately as its own generation, busy armed", busyLog[SID2]?.at(-1) === true);
  await sharedWaitUntil(() => busyLog[SID2]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check("(3 setup) batch2 genuinely gave up (kept, requeues=1)", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));

  // Drive ONLY batch2 to exhaustion, WITHOUT disturbing batch1's own still-held X/Y entries. A natural
  // reconcile()+hold-expiry redrive was tried first and rejected: both batch1's own entries and batch2's
  // entry are "warning"-kind, which coalesces regardless of sender/position (see this repo's own
  // CLAUDE.md — "only Loom warning/system injections coalesce regardless of sender") — once ALL of their
  // holds expire, a single reconcile() drains and coalesces EVERY eligible entry together into one turn,
  // which then gives up as a WHOLE and exhausts batch1's own requeue budget too, defeating the "batch1
  // stays live" precondition this scenario needs. Simulating the drop DIRECTLY (remove batch2's own still-
  // front-most pending copy) reproduces the exact terminal STATE `requeueGiveUpOrigin`'s own exceeded-
  // budget branch produces (a lingering `ambiguousDispatches` entry with nothing left in `pending`) without
  // depending on a timing-sensitive coalescing race to get there deterministically.
  const liveBeforeDrop = host.live.get(SID2);
  const batch2Index = liveBeforeDrop.pending.findIndex((m) => m.text === TEXT_X);
  check("(3 setup) batch2's own copy is the front-most X entry (unshifted after batch1's)", batch2Index === 0);
  liveBeforeDrop.pending.splice(batch2Index, 1);
  console.log(`[test] sess-hasambig-consequence simulated batch2's requeue-budget exhaustion by directly dropping its pending copy (index ${batch2Index}) — its ambiguousDispatches entry (batchId from its own give-up) is left untouched, exactly like requeueGiveUpOrigin's own exceeded-budget branch would leave it`);
  const pendingAfterBatch2Exhausted = host.getPendingEntries(SID2);
  check("(3 setup) exactly ONE copy of X remains in pending (batch1's own requeued member) — batch2 left NO copy of its own anywhere",
    pendingAfterBatch2Exhausted.filter((m) => m.text === TEXT_X).length === 1);
  check("(3 setup) batch1's own X and Y are UNTOUCHED, still sitting requeued (this test never reconciled them)",
    pendingAfterBatch2Exhausted.some((m) => m.text === TEXT_X) && pendingAfterBatch2Exhausted.some((m) => m.text === TEXT_Y));

  // THE GUESS: hasAmbiguousMatch(bare X) — pre-fix returns batch1's X-member logicalId (matches via
  // memberSig, first in Map insertion order), silently ignoring the separate, now-exhausted batch2.
  const guess2 = host.hasAmbiguousMatch(SID2, TEXT_X);

  // THE CONSEQUENCE: simulate the real production resend path — enqueue a "resend" carrying the SAME
  // (pre-fix, wrongly) guessed logicalId, exactly what SessionService.enqueueDurableMessage's
  // `rootMsgId = ctx.rootMsgId ?? ctx.resendOf ?? autoJoinedId ?? msgId` would do with `autoJoinedId =
  // hasAmbiguousMatch(...)`. Keep the worker busy so the resend HOLDS (queues) rather than dispatching
  // immediately — it must still be sitting, undispatched, in `pending` when batch1's confirmation arrives,
  // exactly like a real manual resend queued behind other work.
  host.enqueueStdin(SID2, "STOPGAP_KEEPS_WORKER_BUSY", "system", undefined, undefined, "agent");
  host.deliverHook(SID2, { hook_event_name: "UserPromptSubmit" }); // confirms the stopgap cleanly, busy stays true

  let resendPending;
  if (guess2 !== null) {
    // PRE-FIX shape: hasAmbiguousMatch guessed something — enqueue the resend joined to that guess, exactly
    // as enqueueDurableMessage would, and prove the consequence: batch1's own real confirmation wrongly
    // resolves this resend too.
    host.enqueueStdin(SID2, TEXT_X, "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, { logicalId: guess2 });
    check("(3) the resend HOLDS (worker busy), sitting in pending under the (wrongly) guessed logicalId — now TWO copies of X (batch1's own requeued member + the resend)",
      host.getPendingEntries(SID2).filter((m) => m.text === TEXT_X).length === 2);

    submitLog.length = 0;
    host.deliverHook(SID2, { hook_event_name: "UserPromptSubmit", prompt: JOINED_TEXT }); // batch1's OWN real confirmation
    resendPending = host.getPendingEntries(SID2);
    check("(3) THE CONSEQUENCE, EXECUTED: batch1's genuine confirmation purged BOTH its own copy AND the WRONGLY auto-joined resend as a \"false negative\" content match — the resend's content was never actually written, and the batch it was really about (batch2) is PARKED with nothing left to redrive: this is CONTENT LOSS, not merely mis-attribution",
      submitLog.filter((l) => l.includes("GIVE-UP RECOVERY was a false negative (content-matched)")).length >= 2 && resendPending.filter((m) => m.text === TEXT_X).length === 0);
  } else {
    // POST-FIX shape: hasAmbiguousMatch correctly refused. Prove the fix's own cost is bounded — a resend
    // with NO guess self-roots (a fresh logicalId, never colliding with batch1's), so batch1's later
    // confirmation must NOT touch it.
    check("(4) THE FIX: hasAmbiguousMatch refused to guess (null) instead of wrongly joining the resend to an unrelated batch", guess2 === null);
    const freshId = "self-rooted-resend-probe";
    host.enqueueStdin(SID2, TEXT_X, "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, { logicalId: freshId });
    check("(4 setup) two copies of X now sit in pending (batch1's own requeued member + the self-rooted resend)",
      host.getPendingEntries(SID2).filter((m) => m.text === TEXT_X).length === 2);
    submitLog.length = 0;
    host.deliverHook(SID2, { hook_event_name: "UserPromptSubmit", prompt: JOINED_TEXT }); // batch1's OWN real confirmation — correctly purges ONLY batch1's own X/Y (matching logicalIds), never touches the resend's unrelated freshId
    resendPending = host.getPendingEntries(SID2);
    check("(4) THE FIX, CONSEQUENCE: batch1's own copy is correctly purged (unaffected by this card) while the self-rooted resend SURVIVES untouched — exactly ONE copy of X remains, and it is the resend's own — no longer silently swept away",
      submitLog.some((l) => l.includes("GIVE-UP RECOVERY was a false negative (content-matched)")) && resendPending.filter((m) => m.text === TEXT_X).length === 1);
  }

  try { host.stop(SID2, "hard"); } catch { /* ignore */ }

  // =========================================================================================================
  // (5) CONTROL (regression): an ordinary, non-colliding single-batch hasAmbiguousMatch match is untouched.
  // =========================================================================================================
  const SID3 = "sess-hasambig-regression-control";
  const UNRELATED_TEXT = "UNRELATED_SINGLE_BATCH_TEXT_NO_COLLISION";
  spawnReady(SID3);
  host.enqueueStdin(SID3, UNRELATED_TEXT);
  await sharedWaitUntil(() => busyLog[SID3]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  const guess3 = host.hasAmbiguousMatch(SID3, UNRELATED_TEXT);
  check("(5) CONTROL: an ordinary single-batch match still resolves to a real logicalId (the new grouping step is a no-op for the common case)", guess3 !== null);
  try { host.stop(SID3, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — hasAmbiguousMatch now fails closed (returns null) when a content match spans more than one give-up batch, matching purgeConfirmedGiveUpRequeue's own already-fixed refusal (card bc0774c4) instead of silently performing the oldest-first tie-break that fix explicitly rejected — closing a real, executed content-loss chain (a wrongly-auto-joined resend gets swept away by an unrelated batch's confirmation while the batch it was actually about sits permanently exhausted) — while an ordinary, non-colliding match is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
