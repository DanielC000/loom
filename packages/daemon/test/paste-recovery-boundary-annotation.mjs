// Regression test for card 1c47454b — the ANNOTATION RENDERING half of "a redelivery frame asserts 'you
// have not seen this' — false for ANY consumed message, EITHER direction". HERMETIC — real PtyHost
// (fake pty via the createPty seam), no daemon, no real claude.
//
// paste-recovery-boundary-carry.mjs proves the PLUMBING: `carryPendingToSuccessor` (recycleWorker /
// recycleManager) and the daemon-restart replay both thread a carried paste-recovery notice's
// `mintedAtWallClock` through onto the successor, while DELIBERATELY OMITTING `mintedAtGen` — producing
// the exact parameter shape {mintedAtGen: undefined, mintedAtWallClock: <predecessor's stamp>} on the far
// side of a boundary. THIS FILE proves what `annotatePasteRecoveryAge` actually RENDERS given that shape,
// against a REAL successor session whose own `submitGeneration` is genuinely LOW (0 or 1 — the manager's
// own "the real 0-vs-47 case" framing) while the predecessor's `mintedAtGen` was HIGH (47).
//
// THE TRAP THIS GUARDS AGAINST (manager's own warning while reviewing the plan): `submitGeneration` is a
// PER-SESSION counter that restarts at 0 for a fresh successor. Threading `mintedAtGen` VERBATIM across
// the boundary is UNIT-INCOMPATIBLE — `annotatePasteRecoveryAge`'s own `currentGen <= mintedAtGen` guard
// would then read "0 <= 47" as "delivered before anything else ran, nothing to disclose" and silently
// produce NO annotation. That is the EXACT SAME silent nothing the original bug produces, just moved one
// call deeper — a naive "just thread mintedAtGen through" fix would pass a plumbing test but still be
// dead code at the point that matters. This file drives that naive shape DIRECTLY (scenario A) and shows
// it is inert, then drives the ACTUAL fix's shape (scenario B) and shows it discloses correctly.
//
// (A) NAIVE-FIX TRAP, reproduced directly: a carried entry arrives with BOTH `mintedAtGen: 47` (as if
//     verbatim-threaded — the mistake the manager warned against) AND `mintedAtWallClock` set, drained by
//     a session whose own `submitGeneration` is genuinely 1 (< 47) at drain time. Asserts the annotation
//     is ABSENT — proving that shape is silently broken, exactly like the original bug.
// (B) THE ACTUAL FIX: the SAME scenario, but with `mintedAtGen` OMITTED (exactly what
//     `carryPendingToSuccessor`/the restart replay now do) and `mintedAtWallClock` still set. Asserts the
//     annotation IS PRESENT, states an absolute wall-clock time (not a generation count), and tells the
//     reader to compare it against their own handoff/transcript.
// (C) IN-SESSION CONTROL (branch-selection sanity, not the boundary case): when `mintedAtGen` genuinely
//     reflects an IN-SESSION mint (currentGen > mintedAtGen) and `mintedAtWallClock` is ALSO set, card
//     2d36337e now discloses BOTH the generation count AND the same absolute wall-clock time — a relative
//     count alone can't tell the recipient whether this predates a SPECIFIC later message they already
//     read; the cross-boundary-only "BEFORE this session began" phrasing still stays exclusive to (B).
//
// (D) card 2d36337e — ORDERING ANNOTATION under REAL queue mechanics, not a hand-fed generation number:
//     enqueue an unrelated message B FIRST, then a recovery entry for A SECOND (both held behind an
//     in-flight setup turn — the same relative order the Stop-hook's own mintedAtGen-capture-before-drain
//     race produces when B is already queued at collapse-detection time; see host.ts:4304-4308's own
//     comment). Real `drainPending` then delivers B as its own turn (agent-kind messages drain ONE per
//     turn), bumping `submitGeneration` for real, before A's recovery gets its own turn. Asserts the
//     rendered annotation reflects that real intervening turn (a non-zero generation count) AND still
//     carries A's original absolute send time. ⚠️ SCOPE: this exercises real FIFO ordering + the
//     annotation logic, NOT the Stop-hook's own collapse-DETECTION code (detectBarePastePlaceholderTripwire
//     firing off a transcript read, the synchronous mintedAtGen snapshot, the setTimeout(0) mint) — this
//     hermetic fake-pty harness has no wired transcript to trigger that path, so `mintedAtGen`/
//     `mintedAtWallClock` are hand-supplied here exactly as the real mint site would have captured them,
//     to isolate and test what happens DOWNSTREAM of a real detection. The detection path IS covered
//     end-to-end elsewhere: `paste-placeholder-tripwire.mjs` scenario (m) drives a REAL transcript-backed
//     collapse detection, a REAL already-queued unrelated message draining ahead of the recovery mint, and
//     now (card 2d36337e) asserts the SAME "Originally sent at <ISO>" disclosure this scenario checks —
//     this file's (D) is the narrower, faster-to-read companion for the annotation/ordering logic alone.
//
// Run (no daemon needed): node test/paste-recovery-boundary-annotation.mjs
//   Requires the daemon built first (reads ../dist/*): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pollUntil } from "./_timing-guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-prba-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { buildPasteRecoveryText, PASTE_RECOVERY_TAG } = await import("../dist/orchestration/paste-tripwire.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, pid: 4321, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}
const host = new TestPtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const SID = "sess-prba";
host.spawn({
  sessionId: SID, cwd: tmpHome,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
const fake = fakes[0];

try {
  host.deliverHook(SID, { hook_event_name: "SessionStart" });
  check("spawn used the injected fake pty (no real claude)", !!fake && host.isAlive(SID) === true);

  const PREDECESSOR_MINTED_GEN = 47; // the "real 0-vs-47 case" the manager named while reviewing the plan
  const MINTED_WALLCLOCK = Date.now() - 7 * 60_000; // minted 7 minutes ago, on the (now-gone) predecessor

  // ===================== (A) NAIVE-FIX TRAP: mintedAtGen verbatim-threaded across the boundary ============
  {
    // Occupy the session with an ordinary turn (busy=true, submitGeneration -> 1) so the recovery entry
    // below QUEUES instead of delivering immediately — mirrors a carried entry landing on an already-busy
    // successor. This is turn 1 for this fresh session, so its own submitGeneration is genuinely LOW (1)
    // by the time the recovery entry drains — the manager's "0-vs-47" framing, concretely.
    const setup = host.enqueueStdin(SID, "[loom:test] setup turn (A)");
    if (!setup.delivered) throw new Error("test setup: (A) setup turn did not submit immediately");

    const naiveText = buildPasteRecoveryText("content lost before the boundary (A)");
    const held = host.enqueueStdin(
      SID, naiveText, "system", undefined, undefined, "agent",
      undefined, undefined, undefined, undefined, undefined, undefined, randomUUID(),
      PREDECESSOR_MINTED_GEN, MINTED_WALLCLOCK, // BOTH fields — simulates a naive verbatim-thread of mintedAtGen
    );
    check("(A) setup: the naive-shape entry queues behind the in-flight setup turn", held.delivered === false && held.queued === true);

    const writesBeforeSetupStop = fake.writes.length;
    host.deliverHook(SID, { hook_event_name: "Stop" }); // settles setup turn; drains the naive-shape entry next
    await sleep(10);
    const drained = fake.writes.slice(writesBeforeSetupStop).join("");
    check("(A) setup: the naive-shape entry is what actually drained", drained.includes(naiveText.slice(PASTE_RECOVERY_TAG.length + 1, PASTE_RECOVERY_TAG.length + 30)));
    check("(A) THE TRAP: with mintedAtGen=47 carried verbatim against a successor at submitGeneration=1 (1 <= 47), the annotation is ABSENT — silently inert, the SAME bug one call deeper",
      drained.includes(PASTE_RECOVERY_TAG) && !/generation(s)? ago/.test(drained) && !/minted at/i.test(drained));

    // Resolve cleanly before the next scenario.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
  }

  // ===================== (B) THE ACTUAL FIX: mintedAtGen OMITTED, mintedAtWallClock carried ===============
  {
    const setup = host.enqueueStdin(SID, "[loom:test] setup turn (B)");
    if (!setup.delivered) throw new Error("test setup: (B) setup turn did not submit immediately");

    const fixedText = buildPasteRecoveryText("content lost before the boundary (B)");
    const held = host.enqueueStdin(
      SID, fixedText, "system", undefined, undefined, "agent",
      undefined, undefined, undefined, undefined, undefined, undefined, randomUUID(),
      undefined, MINTED_WALLCLOCK, // mintedAtGen OMITTED — exactly what carryPendingToSuccessor/replayPending now do
    );
    check("(B) setup: the fixed-shape entry queues behind the in-flight setup turn", held.delivered === false && held.queued === true);

    const writesBeforeSetupStop = fake.writes.length;
    host.deliverHook(SID, { hook_event_name: "Stop" });
    await sleep(10);
    const drained = fake.writes.slice(writesBeforeSetupStop).join("");
    check("(B) THE FIX: the delivered recovery still carries the recovery tag", drained.includes(PASTE_RECOVERY_TAG));
    check("(B) THE FIX: the delivered recovery still carries the ORIGINAL lost content", drained.includes("content lost before the boundary (B)"));
    check("(B) THE FIX: with mintedAtGen absent, the annotation IS PRESENT — an absolute wall-clock disclosure, not silence",
      new RegExp(`minted at ${new Date(MINTED_WALLCLOCK).toISOString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(drained));
    check("(B) THE FIX: the disclosure names the boundary explicitly (before this session began)", /before this session began/i.test(drained));
    check("(B) THE FIX: the disclosure does NOT use the in-session generation-count wording (that would be a unit error against a fresh successor)",
      !/generation(s)? ago/.test(drained));
    check("(B) THE FIX: the disclosure tells the reader to check their own handoff/transcript",
      /handoff|transcript/i.test(drained));

    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
  }

  // ===================== (C) IN-SESSION CONTROL: generation wording still wins when genuinely in-session ===
  {
    const setup = host.enqueueStdin(SID, "[loom:test] setup turn (C)");
    if (!setup.delivered) throw new Error("test setup: (C) setup turn did not submit immediately");

    // mintedAtGen=0 is genuinely IN-SESSION here (this session's own submitGeneration is already several
    // turns in by (C), so currentGen > 0 at drain time) — mintedAtWallClock is ALSO set. Card 2d36337e:
    // this branch now discloses BOTH the generation count AND the same absolute wall-clock time the
    // cross-boundary branch uses (see annotatePasteRecoveryAge's own doc, host.ts) — a relative count
    // alone can't tell the recipient whether this predates a SPECIFIC later message they already read.
    // Still asserts the cross-boundary-only "minted at ... BEFORE this session began" phrasing is ABSENT
    // — the two branches stay distinguishable, just no longer wall-clock-vs-generation exclusive.
    const inSessionText = buildPasteRecoveryText("content lost within this same session (C)");
    const held = host.enqueueStdin(
      SID, inSessionText, "system", undefined, undefined, "agent",
      undefined, undefined, undefined, undefined, undefined, undefined, randomUUID(),
      0, MINTED_WALLCLOCK,
    );
    check("(C) setup: the in-session-shape entry queues behind the in-flight setup turn", held.delivered === false && held.queued === true);

    const writesBeforeSetupStop = fake.writes.length;
    host.deliverHook(SID, { hook_event_name: "Stop" });
    await sleep(10);
    const drained = fake.writes.slice(writesBeforeSetupStop).join("");
    check("(C) setup: the in-session-shape entry is what actually drained (positive signal the wait was sufficient before the negative conjunct below inspects it)",
      drained.includes(PASTE_RECOVERY_TAG) && drained.includes("content lost within this same session (C)"));
    check("(C) CONTROL: an in-session mint (mintedAtGen present + stale) still uses generation wording",
      /generation(s)? ago/.test(drained));
    check("(C) THE WIDENED FIX: the in-session branch now ALSO discloses the absolute original-send time, not just a relative generation count",
      new RegExp(`Originally sent at ${new Date(MINTED_WALLCLOCK).toISOString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(drained));
    check("(C) CONTROL: the cross-boundary-only phrasing (\"minted at ... BEFORE this session began\") stays absent — the two branches remain distinguishable",
      !/minted at \d{4}-.*before this session began/i.test(drained));

    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
  }

  // ===================== (D) card 2d36337e — ORDERING ANNOTATION under REAL queue mechanics =============
  {
    const setup = host.enqueueStdin(SID, "[loom:test] setup turn (D)");
    if (!setup.delivered) throw new Error("test setup: (D) setup turn did not submit immediately");

    // B is enqueued FIRST — real peer traffic already queued when the Stop hook detecting A's collapse
    // fires, matching the exact race host.ts:4304-4308's own comment names (mintedAtGen is captured
    // synchronously BEFORE that same Stop hook's own drainPending call can dispatch an already-queued
    // message).
    const bText = "[loom:test] message B — queued BEFORE A's recovery is minted (D)";
    const heldB = host.enqueueStdin(SID, bText, "system", undefined, undefined, "agent");
    check("(D) setup: B queues behind the in-flight setup turn", heldB.delivered === false && heldB.queued === true);

    // Recovery-A is enqueued SECOND, reproducing the real FIFO consequence of that race — its OWN enqueue
    // call genuinely happens after B's, not a simulated ordering. mintedAtGen=0 (comfortably stale by this
    // point in the run, same technique as (C)) stands in for the real mint site's synchronous snapshot.
    const aOriginalSentAt = Date.now() - 3 * 60_000; // A was "originally sent" 3 minutes before this recovery mint
    const recoveryAText = buildPasteRecoveryText("content lost — this is message A, recovered (D)");
    const heldA = host.enqueueStdin(
      SID, recoveryAText, "system", undefined, undefined, "agent",
      undefined, undefined, undefined, undefined, undefined, undefined, randomUUID(),
      0, aOriginalSentAt,
    );
    check("(D) setup: A's recovery queues behind B — real FIFO order, not asserted, produced", heldA.delivered === false && heldA.queued === true);

    // "agent"-kind entries drain ONE per turn (host.ts drainPending: `head.kind === "agent" → splice(startIdx, 1)`)
    // — so B, being first in the FIFO, gets its own turn before A's recovery does. Card 1addef27
    // (fixed-wait-negative-guard): wait on the OBSERVABLE completion signal (B's write actually landing),
    // not a fixed clock, before asserting A's absence below — a too-short guessed window would pass the
    // negative check for the wrong reason (not-yet-drained, not genuinely still-queued).
    const writesBeforeB = fake.writes.length;
    host.deliverHook(SID, { hook_event_name: "Stop" }); // settles setup; drains B next
    const bLanded = await pollUntil(() => fake.writes.length > writesBeforeB, { timeoutMs: 2000, intervalMs: 5 });
    check("(D) setup: B's write genuinely landed before this scenario inspects it (positive signal the wait was sound before the negative conjunct below relies on it)", bLanded);
    const bDrained = fake.writes.slice(writesBeforeB).join("");
    check("(D) B is what actually drained first", bDrained.includes(bText));
    check("(D) A's recovery has NOT drained yet (still one turn behind)", !bDrained.includes("this is message A, recovered (D)"));

    const writesBeforeA = fake.writes.length;
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" }); // settles B's turn; drains A's recovery next
    const aLanded = await pollUntil(() => fake.writes.length > writesBeforeA, { timeoutMs: 2000, intervalMs: 5 });
    check("(D) setup: A's recovery write genuinely landed before this scenario inspects it", aLanded);
    const aDrained = fake.writes.slice(writesBeforeA).join("");
    check("(D) THE REPRO: A's recovery drains AFTER B, under real queue mechanics (not a hand-fed generation number) — the exact ordering the card describes",
      aDrained.includes("this is message A, recovered (D)"));
    check("(D) THE FIX: the delivered recovery discloses that a real turn (B) ran since A was minted",
      /generation(s)? ago/.test(aDrained));
    check("(D) THE FIX: the disclosure carries A's own original absolute send time, directly comparable against when the recipient read B",
      new RegExp(`Originally sent at ${new Date(aOriginalSentAt).toISOString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(aDrained));

    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
  }
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a carried paste-recovery notice's age evidence renders correctly at the exact boundary shape the fix produces: threading mintedAtGen verbatim across a boundary (the naive-fix trap) is silently inert against a successor's genuinely-low submitGeneration, exactly like the original bug; the actual fix (mintedAtGen omitted, mintedAtWallClock carried) discloses an absolute mint time instead; a genuinely in-session mint (C) now discloses BOTH generation count and absolute send time (card 2d36337e); and under REAL queue mechanics (D), a recovery enqueued after an unrelated message genuinely drains after it (the ordering defect, reproduced) while still carrying its own original send time for the recipient to compare."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
