// Hermetic regression test for card a6c1d413 — "composerDirtyMarkedForGen is one scalar gating an
// additive composerDirtyLen total" (pty/host.ts).
//
// THE GAP (card body): `composerDirtyLen` accumulates ADDITIVELY across stacked, distinct unconfirmed
// give-ups, by design. But the pre-fix field gating both the increment-guard and the reset —
// `composerDirtyMarkedForGen: number | null` — was a SINGLE SCALAR, overwritten by whichever generation's
// give-up contributed most recently. `clearComposerDirtyOnConfirm` reset the ENTIRE `composerDirtyLen`
// total to 0 whenever `composerDirtyMarkedForGen === <the confirmed gen>` — so a confirmation for ANY
// generation OTHER than whichever one happened to be the most recent to mark was silently swallowed (a
// STUCK false-nonzero — the confirmed generation's own contribution never resolves), and a confirmation
// for the LATEST-marked generation reset the WHOLE stacked total in one shot, regardless of whether any
// EARLIER generation's own contribution had ever actually been individually proven resolved.
//
// ⚠️ VERIFIED AGAINST THE CARD'S OWN CITED SPECIMEN, NOT ADOPTED ON FAITH (per this project's standing
// "verify your manager's claims" worker doctrine): the card's own directly-observed specimen
// (docs/investigations/f779b3da-giveup-redrain-race/specimen1-daf64e68-full-trace.txt, gen4->gen5,
// 9669+3917=13586 all reset at gen5's CONFIRMED) resolved via `purgeConfirmedGiveUpRequeue`'s
// CONTENT-MATCH branch (line "GIVE-UP RECOVERY was a false negative (content-matched)"). Content-match is
// actually DECISIVE, transitive proof gen5's own clear-prefix (which unconditionally targets the FULL
// composerDirtyLen accumulated before its own paste, per submit()'s own doc) landed — so THAT specific
// reset was already sound under the pre-existing, well-reviewed invariant, not a manifestation of this
// bug. The genuinely unsound case — proven below — is the CONTENT-BLIND FIFO-position fallback, which
// carries none of that transitive proof, yet pre-fix code applied the exact same blind full-reset to it.
// This test exercises THAT path, not a replay of the exact daf64e68 byte counts.
//
// SCENARIO: A (gen1) and B (gen2, a wholly different message) each independently, genuinely give up
// (real drops — the fake pty below never emits output, so both are ordinary GIVE-UP RECOVERY, never
// SUPPRESSED), stacking composerDirtyLen additively — B's own dispatch runs its defensive clear-prefix for
// A's stray text first (submit()'s own unconditional behavior), then ALSO gives up, adding its own length
// on top. Two bare Stop hooks then arrive in sequence — content-blind (Stop never carries `prompt`), so
// BOTH route through purgeConfirmedGiveUpRequeue's FIFO-position fallback, oldest-first: hook 1 resolves
// gen1 (A), hook 2 resolves gen2 (B).
//
// THE ASSERTION THAT MATTERS (must go RED against pre-fix code): immediately after hook 1 (A's own,
// individual, content-blind confirmation), composerDirtyLen must read EXACTLY B's still-unresolved length
// — A's contribution resolved, B's SURVIVES untouched. Pre-fix code's single scalar (overwritten to B's
// gen when B gave up) causes hook 1 to hit a gate mismatch and no-op entirely: composerDirtyLen stays at
// A+B, misreporting A's own just-confirmed turn as still possibly-stranded, and only carries the correct
// FINAL total (0) after hook 2 as an accident of a later, unrelated confirmation blast-radius, not because
// A was ever actually, individually resolved. Verified RED against pre-fix code via the sanctioned
// `git show`/`git apply` revert recipe (this repo shares one stash stack across worktrees — never
// `git stash`).
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon, `pnpm build` then
// `node test/pty-composerdirtymarkedgens-per-generation.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-composerdirtygens-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;
const HOLD_MS = 30_000; // pinned large — mirrors pty-giveup-composerdirty-confirmed-clear.mjs: a Stop hook
                        // arriving while a requeued duplicate is still HELD must be what resolves it, not
                        // an unrelated background redrain racing in first.
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1"; // production default

const GIVE_UP_POLL_MS = 20;
const GIVE_UP_POLL_TIMEOUT_MS = 15_000;
// Card 259c15fa (see pty-giveup-clear.mjs's own doc): give-up's real completion is a chain of setTimeout
// hops that routinely overshoots a hand-computed sum — poll for the OBSERVED busy=false transition.
async function waitForBusyFalse(busyLog, sessionId, t0) {
  const remainingMs = Math.max(0, GIVE_UP_POLL_TIMEOUT_MS - (Date.now() - t0));
  try {
    await sharedWaitUntil(() => busyLog[sessionId]?.at(-1) === false, { timeoutMs: remainingMs, intervalMs: GIVE_UP_POLL_MS, label: "pty-composerdirtymarkedgens-per-generation: busy fell back to false" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
  }
}

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const fake = { ...base, write: () => {} }; // never emits output — every give-up here is a GENUINE drop
    fakes.push(fake);
    return fake;
  }
}

const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {},
  onRateLimited() {}, onExit() {},
};

const host = new TestPtyHost(events);
function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

try {
  const SID = "sess-stacked-gens";
  const TEXT_A = "MESSAGE_A_FIRST_TO_GIVE_UP_AND_STACK_DIRTY_AAAAAAAAAAAAAAAAAAAAAA";
  const TEXT_B = "MESSAGE_B_SECOND_DIFFERENT_MESSAGE_ITS_OWN_GIVEUP_STACKS_ON_TOP_BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  spawnReady(SID);

  // ===== A (gen1) gives up genuinely — the first, sole contributor ==========================================
  let t0 = Date.now();
  const rA = host.enqueueStdin(SID, TEXT_A);
  check("setup: A delivered immediately, busy armed", rA.delivered === true && busyLog[SID]?.at(-1) === true);
  await waitForBusyFalse(busyLog, SID, t0);
  check("setup: A's own give-up (RECOVERY) landed: busy fell back to false", busyLog[SID]?.at(-1) === false);
  check("setup: composerDirtyLen marked dirty at A's give-up, exactly A's own length",
    host.getComposerDirtyLen(SID) === TEXT_A.length);
  check("setup: A is requeued (held) — pending holds exactly A",
    host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT_A);

  // ===== B (gen2, a DIFFERENT message) dispatches while A sits held — its own clear-prefix targets A's ======
  // ===== stray text, then B's OWN Enter ALSO genuinely gives up, stacking additively on top =================
  t0 = Date.now();
  const rB = host.enqueueStdin(SID, TEXT_B);
  check("setup: B delivered immediately while A sits held", rB.delivered === true);
  check("setup: B's clear-prefix zeroed composerDirtyLenBelieved synchronously (optimistic reading)",
    host.getComposerDirtyLenBelieved(SID) === 0);
  check("setup: composerDirtyLen is unchanged so far — still just A's conservative total",
    host.getComposerDirtyLen(SID) === TEXT_A.length);

  await waitForBusyFalse(busyLog, SID, t0);
  check("setup: B's own give-up (RECOVERY) landed: busy fell back to false", busyLog[SID]?.at(-1) === false);
  check("setup: composerDirtyLen is now ADDITIVE — A's length plus B's own, both stacked",
    host.getComposerDirtyLen(SID) === TEXT_A.length + TEXT_B.length);
  const pendingAfterBothGiveUps = host.getPendingEntries(SID);
  check("setup: pending now holds BOTH requeued duplicates, B (freshest hold) ahead of A (long-held)",
    pendingAfterBothGiveUps.length === 2
    && pendingAfterBothGiveUps[0].text === TEXT_B && pendingAfterBothGiveUps[1].text === TEXT_A);

  // ===== ISOLATING THE MECHANISM UNDER TEST ==================================================================
  // A SEPARATE, PRE-EXISTING, unaffected-by-this-card mechanism (`composerDirtyLenClearedByGen ===
  // live.submitGeneration`, card 3ce3fa39 — see the field's own doc) ALSO unconditionally zeroes
  // composerDirtyLen on ANY hook, whenever the CURRENT generation's own dispatch already stamped it (which
  // it always does, synchronously, the instant ANY dispatch runs while composerDirtyLen>0 — B's own dispatch
  // above already did exactly that). That gate is checked and fires INSIDE `deliverHook`'s own hook handler,
  // BEFORE `purgeConfirmedGiveUpRequeue` (and therefore `clearComposerDirtyOnConfirm`) ever runs — so
  // delivering a real hook here would confound the two mechanisms: a green run couldn't tell you which one
  // actually resolved anything. That OTHER gate is sound on its own terms (a confirmed Enter for the
  // CURRENT generation proves the composer is genuinely empty NOW, regardless of history) and is not this
  // card's concern. Neutralize it here — exactly mirroring "no submit() has run since the give-up we're
  // confirming" (this file's own sibling, pty-giveup-composerdirty-confirmed-clear.mjs scenario 2, does the
  // same by construction, never dispatching a THIRD message) — and drive `purgeConfirmedGiveUpRequeue`
  // directly, the same call `deliverHook`'s own Stop/UserPromptSubmit handlers make, isolating exactly the
  // mechanism this card fixes.
  const live = host.live.get(SID);
  live.composerDirtyLenClearedByGen = null;

  // ===== HOOK 1: a bare Stop hook (content-blind — Stop never carries `prompt`) — routes through the ========
  // ===== FIFO-position fallback, resolving the OLDEST outstanding generation first: A (gen1) ================
  host["purgeConfirmedGiveUpRequeue"](SID, live, true);
  check("THE FIX — hook 1 resolves A's OWN contribution individually: composerDirtyLen reads EXACTLY "
    + "B's still-unresolved length (A resolved, B SURVIVES untouched) — this is the assertion that goes "
    + "RED against pre-fix code (which would still read A+B here, since its single scalar was already "
    + "overwritten to B's generation by the time A's confirmation arrives, silently dropping it)",
    host.getComposerDirtyLen(SID) === TEXT_B.length);
  check("hook 1: A's requeued duplicate was purged (a confirmed give-up, not a genuine loss)",
    host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT_B);

  // ===== HOOK 2: a second bare Stop hook — FIFO front is now B (gen2); resolves B's own remaining entry =====
  host["purgeConfirmedGiveUpRequeue"](SID, live, true);
  check("hook 2: B's own contribution resolves too — composerDirtyLen reads 0, both generations genuinely "
    + "accounted for (not merely coincidentally zero)",
    host.getComposerDirtyLen(SID) === 0 && host.getComposerDirtyLenBelieved(SID) === 0);
  check("hook 2: B's requeued duplicate was purged too — pending is empty",
    host.getPendingEntries(SID).length === 0);
} finally {
  try { host.stop("sess-stacked-gens", "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — composerDirtyLen tracks each stacked generation's contribution independently: an "
    + "individual generation's own confirmation resolves ONLY its own share, never silently drops (stuck "
    + "false-nonzero) nor blindly wipes an unrelated generation's still-unresolved share (false-zero)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
