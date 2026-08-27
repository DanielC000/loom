// Hermetic regression test for card fa27d262 — "Enter-only drops a coalesced neighbour but marks it
// delivered" (pty/host.ts submit()/drainPending()).
//
// EVIDENCE LEVEL: the hazard was TRACED IN THE CODE (Code Review on card 4796f999's branch), then
// REPRODUCED in an earlier revision of THIS file (a mixed [giveUpGen-tagged, fresh] drain took the
// Enter-only path and wrote zero body bytes for the fresh neighbour while still firing its onDeliver —
// confirmed live against pre-fix code). THE FIX: `isGiveUpRedelivery` in submit() changed from
// `origin?.some((m) => m.giveUpGen !== undefined)` to `origin?.every(...)` — a mixed batch (any fresh
// member) now falls through to the full clear+repaste branch, which re-pastes the WHOLE joined text
// (every member's real body, fresh ones included) instead of trusting nothing was ever written. This file
// now asserts the FIXED behavior.
//
// THE HAZARD THIS GUARDS (pre-fix): `drainPending`'s run-collection loop can coalesce a `giveUpGen`-tagged
// entry (a message being re-delivered after its OWN earlier give-up) together with a FRESH neighbour that
// has never been attempted before, into ONE `drained` array — whenever they share a route+kind and
// neither is currently held. The old `some`-gated Enter-only branch trusted the WHOLE joined text off
// ANY single tagged member, writing ZERO body bytes for the entire batch — the fresh neighbour's body
// included — while `drainPending` still unconditionally fires `onDeliver()` for every drained entry
// afterward. The fresh message was reported delivered while its body never reached the composer: a
// silent loss the system believed it delivered.
//
// REACHABILITY, exactly as traced (each hop asserted below against the real code, not this comment):
//   1. C is enqueued while A's first turn is BUSY -> C queues (enqueueStdin's held/queued branch) and is
//      never itself given a give-up hold of its own.
//   2. A's own turn gives up -> requeueGiveUpOrigin unshifts A (giveUpGen stamped, held for
//      GIVE_UP_HOLD_MS) onto the FRONT of pending -> pending = [A(held), C(unheld)].
//   3. Nothing drains while A is held. Production holds the whole-session drain via drainHeld /
//      rateLimited / deferForHumanDraft for this window; this hermetic harness has no periodic reconcile
//      timer at all, so the SAME effect (no drain attempted while A is still held) falls out for free —
//      we simply don't call host.reconcile() until AFTER A's hold has expired.
//   4. A's hold expires -> the next drainPending() call's `findIndex` lands on A (now unheld, index 0) and
//      the route/kind-keyed run-collection loop extends forward to grab C too (same route — both
//      undefined -> "" — and same default "warning" kind) -> `drained = [A, C]`.
//   5. `isGiveUpRedelivery` is now FALSE (C, a member of `origin`, has no `giveUpGen`) even though A's own
//      giveUpGen is set and composer trust holds -> the fallback clear+repaste branch fires instead of
//      Enter-only, re-pasting the WHOLE joined [A, C] text.
//
// ⚠ WHAT THIS TEST PROVES AND DOES NOT: a hermetic fake-pty harness is a write-recorder, not a real
// terminal (see pty-enter-only-verifies-composer-trust.mjs's own header for the same caveat) — it proves
// the CODE now makes the correct decision (falls through to the full re-paste for a mixed batch, writing
// every member's real body) rather than independently witnessing real-terminal consequences.
//
// Verified RED against pre-fix code (temporarily, via the sanctioned `git diff`/`git checkout HEAD --`/
// `git apply` patch recipe, never `git stash` — this repo shares one stash stack across worktrees): with
// `isGiveUpRedelivery` back to `some`, this same scenario took Enter-only — C's body was absent from the
// burst while its onDeliver still fired, and no backspace was ever written. Re-running against the fix
// restores it: C's body is present, a backspace burst preceded it, and A's body is present too.
//
// Every assertion reads bytes physically written to the fake pty, or callback flags actually fired, by the
// REAL production drainPending()/submit() — never a value re-derived from the same computation it's
// compared against (project memory [[a-control-whose-two-sides-share-a-source-is-a-tautology]]).
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon, `pnpm build` then
// `node test/pty-enter-only-drops-coalesced-neighbour.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-coalescedloss-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;       // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600;   // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;       // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const HOLD_MS = 300;          // mirrors LOOM_GIVE_UP_HOLD_MS — same value pty-enter-only-verifies-composer-trust.mjs uses
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = "10";
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = "5";
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = "10";
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = "15";
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1"; // production default
process.env.LOOM_MODE_LOG_POLL_MS = "5";

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
  await waitUntil(() => busyLog[sid]?.length > sinceLen && busyLog[sid]?.at(-1) === false,
    { timeoutMs: 10_000, label });
}

try {
  // ===================== PRIMARY REPRO: default kind ("warning"), coalesceAgentMessages OFF (default) ====
  {
    const host = new TestPtyHost(events);
    const SID = "sess-coalesced-loss-warning-kind";
    const TEXT_A = "GIVEUP_RETRIED_MESSAGE_A_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const TEXT_C = "FRESH_NEVER_ATTEMPTED_MESSAGE_C_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const fake = spawnReady(host, SID);

    let deliveredA = false;
    let deliveredC = false;

    let lenBefore = busyLog[SID]?.length ?? 0;
    const rA = host.enqueueStdin(SID, TEXT_A, "system", () => { deliveredA = true; });
    check("setup: A delivered immediately (idle-submit), busy armed",
      rA.delivered === true && busyLog[SID].at(-1) === true);

    // Hop 1: C enqueued WHILE A's first turn is still busy -> C QUEUES (never delivered on its own,
    // never itself given a give-up hold).
    const rC = host.enqueueStdin(SID, TEXT_C, "system", () => { deliveredC = true; });
    check("hop 1: C enqueued while A busy -> C is QUEUED, not delivered", rC.delivered === false && rC.queued === true);
    check("hop 1: neither onDeliver has fired yet", deliveredA === false && deliveredC === false);

    // Hop 2: A's own turn gives up -> requeued (giveUpGen stamped) at the FRONT of pending, held.
    await waitForBusyFalseAfter(SID, lenBefore, "A's own give-up (RECOVERY)");
    const pendingAfterGiveUp = host.getPendingEntries(SID);
    check("hop 2: pending is now [A (requeued, giveUpGen set), C (still fresh, no giveUpGen)]",
      pendingAfterGiveUp.length === 2
      && pendingAfterGiveUp[0].text === TEXT_A && pendingAfterGiveUp[0].giveUpGen !== undefined
      && pendingAfterGiveUp[1].text === TEXT_C && pendingAfterGiveUp[1].giveUpGen === undefined);
    check("hop 2: A's own onDeliver has NOT fired yet — the immediate-submit path deliberately does not "
      + "invoke onDeliver (see enqueueStdin's own doc: a message delivered straight as a turn is never "
      + "persisted as session_message_queued, so there is nothing to resolve there)",
      deliveredA === false);
    check("hop 2: C's onDeliver has NOT fired — it is only queued, never yet handed to the recipient",
      deliveredC === false);

    // Hop 3: nothing drains while A is held — this harness has no periodic reconcile timer, so simply not
    // calling reconcile() until A's hold (GIVE_UP_HOLD_MS) has expired reproduces exactly that.
    check("hop 5 precondition: composer trust is intact (no intervening clear) before the redrain",
      host.getComposerDirtyLenBelieved(SID) === host.getComposerDirtyLen(SID)
      && host.getComposerDirtyLen(SID) === TEXT_A.length);
    await sleep(HOLD_MS + 30);

    // Hop 4: A's hold has now expired -> the next drainPending() lands on A and coalesces C into the SAME
    // drain (same route — both undefined -> "" — and same default "warning" kind).
    const writesBefore = fake.writes.length;
    host.reconcile();
    const burst = fake.writes.slice(writesBefore).join("");

    // Hop 5 / THE FIX: isGiveUpRedelivery is now FALSE for this mixed batch (C has no giveUpGen), so the
    // fallback clear+repaste branch fires instead of Enter-only — the WHOLE joined [A, C] text is written,
    // never silently dropped.
    check("THE FIX, half 1: C's real body bytes ARE physically written to the pty — this is the assertion "
      + "that goes RED against pre-fix code (C's body absent, Enter-only fired on the mixed batch)",
      burst.includes(TEXT_C));
    check("THE FIX, half 2: C's onDeliver fired — and now correctly so, since its body really was written "
      + "in this same burst (not a silent loss — delivered means delivered)", deliveredC === true);
    check("THE FIX: A's own body/frame is written too (the fallback re-pastes the FULL joined text, not "
      + "just C's share of it)", burst.includes(TEXT_A));
    check("THE FIX: a backspace burst preceded the repaste (the full clear+repaste branch, not Enter-only "
      + "— Enter-only writes zero backspaces)", burst.includes("\x7f"));
    check("sanity: A's own onDeliver ALSO fired on this same redrain (drainPending fires onDeliver for "
      + "every drained entry, unconditionally — CLAUDE.md's preserved invariant, deliberately unchanged by "
      + "this fix; see this file's header for why the fix point is isGiveUpRedelivery, not onDeliver)",
      deliveredA === true);

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card fa27d262: a mixed [giveUpGen-tagged, fresh] coalesced drain no longer takes the "
    + "Enter-only path — isGiveUpRedelivery now requires EVERY member of the batch to have already been "
    + "physically written once, so a single fresh neighbour routes the whole batch to the full "
    + "clear+repaste branch, which writes every member's real body. Verified RED against pre-fix code (see "
    + "this file's header)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
