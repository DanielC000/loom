// Regression guard for card 66b78175 — the same-sender coalesce run (pty/host.ts's drainPending
// same-sender branch, sibling to pty-agent-sender-coalesce.mjs) must equalize `proactive`, not just
// `route`/`senderId`/`kind`/hold-state/bounds.
//
// THE DEFECT THIS CLOSES: `drainPending`'s submit() call reads `drained[0]!.proactive` HEAD-ONLY (like
// route/senderId). Unlike route/senderId, the same-sender run's while-loop condition did NOT include
// `proactive` in its equality set — so two same-sender/same-route agent entries with DIFFERING
// `proactive` could coalesce into ONE turn, and the tail's `proactive:true` would be silently discarded
// (getActiveTurnIsProactive() would read false even though a proactive-tagged message was in the turn).
// Card 66b78175 verified this executes against the mechanism directly (not reachable via any production
// call site TODAY — every real proactive producer passes 9 args and omits senderId — but card 4458dd9e is
// actively considering threading senderId at those sites, which would make it live).
//
// THE REMEDY (chosen per card 66b78175 DoD-1, option (a) — cheapest, makes it safe by construction exactly
// like route/senderId): add `proactive` to the same-sender run's equality set, so a proactive/non-proactive
// mismatch BREAKS the run instead of silently coalescing. Rejected alternative (explicitly ruled out by the
// card): OR-ing the flags together in submit() — that would mis-tag a batch containing one proactive member
// as an entirely proactive (system-initiated) turn, which is wrong in the user-visible direction.
//
// This suite proves, against a fake pty injected via the createPty() seam — NO real claude, no daemon:
//   (A) same-sender, same-route, DIFFERING proactive (false head, true tail) — MUST NOT coalesce: two
//       separate turns, each correctly tagged via getActiveTurnIsProactive().
//   (B) same-sender, same-route, DIFFERING proactive, REVERSED (true head, false tail) — same guarantee
//       in the other direction, so the fix isn't accidentally directional.
//   (C) POSITIVE CONTROL: same-sender, same-route, SAME proactive (both true) — still coalesces into ONE
//       turn, proving the equality check doesn't just blanket-disable same-sender coalescing.
//
// Card a9e4240f (MAJOR-2): (A)/(B)/(C) above exercise ONLY the default `coalesceAgentMessages:false`
// same-sender branch (the one 66b78175/c9d9e496 fixed) — this file never set `coalesceAgentMessages`, which
// is exactly why the SIBLING legacy route-keyed branch (drainPending's `else`, taken whenever
// `coalesceAgentMessages:true`) kept reading `proactive` head-only, unnoticed. (D)/(E)/(F) below close that
// gap, against a SEPARATE host instance constructed with `{ coalesceAgentMessages: true }`:
//   (D) LEGACY branch, DIFFERING proactive (false head, true tail), NO senderId (mirrors every real
//       proactive producer, which omits it) — MUST NOT coalesce.
//   (E) LEGACY branch, DIFFERING proactive, REVERSED (true head, false tail) — same guarantee, non-directional.
//   (F) LEGACY branch POSITIVE CONTROL: SAME proactive (both true) — still coalesces into ONE turn.
// (D)/(E)/(F) also stand as the "default" row's own bound proven the other way: since every real proactive
// producer omits `senderId`, (A)/(B)/(C)'s `senderKey !== null` gate means the AGENT branch's equality check
// never even runs in production today — (D)/(E)/(F) are what actually exercises the reachable path.
//
// RUN (no daemon needed): node test/pty-agent-sender-coalesce-proactive.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set BEFORE
// importing host.js — paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-agent-coalesce-proactive-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

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
  onEngineSessionId() {},
  onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
};

const host = new TestPtyHost(events);
// Card a9e4240f: a SEPARATE host constructed with the legacy toggle on, so (D)/(E)/(F) exercise
// drainPending's route-keyed `else` branch instead of the same-sender `if` branch (A)/(B)/(C) cover.
const hostLegacy = new TestPtyHost(events, { coalesceAgentMessages: true });
const PASTE_START = "\x1b[200~";

function spawnReady(sessionId, hostRef = host) {
  hostRef.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  hostRef.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return {
    fake,
    written: () => fake.writes.join(""),
    countOf: (m) => fake.writes.join("").split(m).length - 1,
  };
}

/** Put the session mid-turn (busy) so subsequent enqueueStdin calls are HELD/queued, not submitted
 *  immediately (mirrors pty-agent-sender-coalesce.mjs's own "PRIMER" setup). */
function primeBusy(sessionId, hostRef = host) {
  const r = hostRef.enqueueStdin(sessionId, "PRIMER_TURN");
  if (!r.delivered) throw new Error(`primeBusy(${sessionId}): PRIMER was not delivered immediately`);
}

try {
  // ===================== (A) DIFFERING proactive (false head, true tail) MUST NOT coalesce =====================
  {
    const SID = "sess-proactive-mismatch-ft";
    const { written, countOf } = spawnReady(SID);
    primeBusy(SID);
    await sleep(250); // let PRIMER's async paste-end + Enter flush before measuring the drain below

    const r1 = host.enqueueStdin(SID, "PROACTIVE_MISMATCH_FT_HEAD", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-mismatch-ft");
    const r2 = host.enqueueStdin(SID, "PROACTIVE_MISMATCH_FT_TAIL", "system", undefined, undefined, "agent", undefined, undefined, true, "sender-mismatch-ft");
    check("(A) setup: both queued behind busy, adjacent, same sender+route",
      r1.delivered === false && r2.delivered === false &&
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["PROACTIVE_MISMATCH_FT_HEAD", "PROACTIVE_MISMATCH_FT_TAIL"]));

    let pasteBefore = countOf(PASTE_START);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(A) turn 1: exactly ONE submit, for the HEAD (proactive:false) ALONE — the mismatch broke the run",
      countOf(PASTE_START) - pasteBefore === 1);
    check("(A) turn 1: only the head's body is in this turn, the proactive tail is NOT folded in",
      written().includes("PROACTIVE_MISMATCH_FT_HEAD") && !written().includes("PROACTIVE_MISMATCH_FT_TAIL"));
    check("(A) turn 1: getActiveTurnIsProactive() correctly reads FALSE for the non-proactive head's turn",
      host.getActiveTurnIsProactive(SID) === false);
    check("(A) turn 1: the proactive tail stays queued, untouched — not dropped, not silently absorbed",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["PROACTIVE_MISMATCH_FT_TAIL"]));
    await sleep(250);

    pasteBefore = countOf(PASTE_START);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(A) turn 2: exactly ONE submit, for the TAIL (proactive:true) ALONE, as its own turn",
      countOf(PASTE_START) - pasteBefore === 1);
    check("(A) turn 2: getActiveTurnIsProactive() correctly reads TRUE for the proactive tail's own turn",
      host.getActiveTurnIsProactive(SID) === true);
    check("(A) turn 2: queue now empty", host.getPending(SID).length === 0);
  }

  // ===================== (B) DIFFERING proactive, REVERSED (true head, false tail) — same guarantee =====================
  {
    const SID = "sess-proactive-mismatch-tf";
    const { written, countOf } = spawnReady(SID);
    primeBusy(SID);
    await sleep(250);

    const r1 = host.enqueueStdin(SID, "PROACTIVE_MISMATCH_TF_HEAD", "system", undefined, undefined, "agent", undefined, undefined, true, "sender-mismatch-tf");
    const r2 = host.enqueueStdin(SID, "PROACTIVE_MISMATCH_TF_TAIL", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-mismatch-tf");
    check("(B) setup: both queued behind busy, adjacent, same sender+route",
      r1.delivered === false && r2.delivered === false &&
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["PROACTIVE_MISMATCH_TF_HEAD", "PROACTIVE_MISMATCH_TF_TAIL"]));

    let pasteBefore = countOf(PASTE_START);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(B) turn 1: exactly ONE submit, for the HEAD (proactive:true) ALONE — the mismatch broke the run",
      countOf(PASTE_START) - pasteBefore === 1);
    check("(B) turn 1: only the head's body is in this turn, the non-proactive tail is NOT folded in",
      written().includes("PROACTIVE_MISMATCH_TF_HEAD") && !written().includes("PROACTIVE_MISMATCH_TF_TAIL"));
    check("(B) turn 1: getActiveTurnIsProactive() correctly reads TRUE for the proactive head's turn",
      host.getActiveTurnIsProactive(SID) === true);
    check("(B) turn 1: the non-proactive tail stays queued, untouched",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["PROACTIVE_MISMATCH_TF_TAIL"]));
    await sleep(250);

    pasteBefore = countOf(PASTE_START);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(B) turn 2: exactly ONE submit, for the TAIL (proactive:false) ALONE, as its own turn",
      countOf(PASTE_START) - pasteBefore === 1);
    check("(B) turn 2: getActiveTurnIsProactive() correctly reads FALSE for the non-proactive tail's own turn",
      host.getActiveTurnIsProactive(SID) === false);
    check("(B) turn 2: queue now empty", host.getPending(SID).length === 0);
  }

  // ===================== (C) POSITIVE CONTROL: SAME proactive (both true) still coalesces =====================
  // Proves the equality check specifically discriminates on a MISMATCH — it doesn't just blanket-disable
  // same-sender coalescing outright, which would make (A)/(B) pass for the wrong reason.
  {
    const SID = "sess-proactive-match";
    const { written, countOf } = spawnReady(SID);
    primeBusy(SID);
    await sleep(250);

    const r1 = host.enqueueStdin(SID, "PROACTIVE_MATCH_ONE", "system", undefined, undefined, "agent", undefined, undefined, true, "sender-match");
    const r2 = host.enqueueStdin(SID, "PROACTIVE_MATCH_TWO", "system", undefined, undefined, "agent", undefined, undefined, true, "sender-match");
    check("(C) setup: both queued, same sender+route+proactive",
      r1.delivered === false && r2.delivered === false &&
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["PROACTIVE_MATCH_ONE", "PROACTIVE_MATCH_TWO"]));

    const pasteBefore = countOf(PASTE_START);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(C) COALESCE: exactly ONE submit for both same-proactive messages", countOf(PASTE_START) - pasteBefore === 1);
    check("(C) COALESCE: both bodies present in the single turn",
      written().includes("PROACTIVE_MATCH_ONE") && written().includes("PROACTIVE_MATCH_TWO"));
    check("(C) COALESCE: getActiveTurnIsProactive() correctly reads TRUE for the coalesced turn",
      host.getActiveTurnIsProactive(SID) === true);
    check("(C) COALESCE: queue fully drained", host.getPending(SID).length === 0);
  }

  // ===================== (D) LEGACY BRANCH: DIFFERING proactive (false head, true tail) MUST NOT coalesce =====================
  // Card a9e4240f MAJOR-2. `coalesceAgentMessages:true` routes drainPending to the route-keyed `else`
  // branch regardless of kind — no senderId is set (real proactive producers never set one), so this could
  // NEVER reach the (A)/(B)/(C) same-sender branch; it is the ONLY branch this scenario actually takes.
  {
    const SID = "sess-legacy-proactive-mismatch-ft";
    const { written, countOf } = spawnReady(SID, hostLegacy);
    primeBusy(SID, hostLegacy);
    // TIMING-GUARD-SAFE: sync-early-return — the setup check right below (r1.delivered === false &&
    // r2.delivered === false) is decided SYNCHRONOUSLY inside primeBusy()'s own enqueueStdin call: M1
    // (pty-busy-drain.mjs's own doc) arms `live.busy` optimistically before that call even returns, with no
    // await in between, so r1/r2's queue-not-deliver outcome is already fixed before this sleep starts.
    // Verified directly: the same setup+assertion with the sleep removed entirely still passes. This sleep
    // exists only to let PRIMER's own async paste-end + Enter flush land before the LATER Stop-hook-driven
    // checks below measure the drain (mirrors (A)/(B)/(C)'s identical pre-existing pattern above).
    await sleep(250);

    const r1 = hostLegacy.enqueueStdin(SID, "LEGACY_MISMATCH_FT_HEAD", "system", undefined, undefined, "agent", undefined, undefined, false);
    const r2 = hostLegacy.enqueueStdin(SID, "LEGACY_MISMATCH_FT_TAIL", "system", undefined, undefined, "agent", undefined, undefined, true);
    check("(D) setup: both queued behind busy, adjacent, same route, no senderId, legacy toggle ON",
      r1.delivered === false && r2.delivered === false &&
      JSON.stringify(hostLegacy.getPending(SID)) === JSON.stringify(["LEGACY_MISMATCH_FT_HEAD", "LEGACY_MISMATCH_FT_TAIL"]));

    let pasteBefore = countOf(PASTE_START);
    hostLegacy.deliverHook(SID, { hook_event_name: "Stop" });
    check("(D) turn 1: exactly ONE submit, for the HEAD (proactive:false) ALONE — the mismatch broke the legacy run",
      countOf(PASTE_START) - pasteBefore === 1);
    check("(D) turn 1: only the head's body is in this turn, the proactive tail is NOT folded in",
      written().includes("LEGACY_MISMATCH_FT_HEAD") && !written().includes("LEGACY_MISMATCH_FT_TAIL"));
    check("(D) turn 1: getActiveTurnIsProactive() correctly reads FALSE for the non-proactive head's turn",
      hostLegacy.getActiveTurnIsProactive(SID) === false);
    check("(D) turn 1: the proactive tail stays queued, untouched — not dropped, not silently absorbed",
      JSON.stringify(hostLegacy.getPending(SID)) === JSON.stringify(["LEGACY_MISMATCH_FT_TAIL"]));
    await sleep(250);

    pasteBefore = countOf(PASTE_START);
    hostLegacy.deliverHook(SID, { hook_event_name: "Stop" });
    check("(D) turn 2: exactly ONE submit, for the TAIL (proactive:true) ALONE, as its own turn",
      countOf(PASTE_START) - pasteBefore === 1);
    check("(D) turn 2: getActiveTurnIsProactive() correctly reads TRUE for the proactive tail's own turn",
      hostLegacy.getActiveTurnIsProactive(SID) === true);
    check("(D) turn 2: queue now empty", hostLegacy.getPending(SID).length === 0);
  }

  // ===================== (E) LEGACY BRANCH: DIFFERING proactive, REVERSED (true head, false tail) =====================
  {
    const SID = "sess-legacy-proactive-mismatch-tf";
    const { written, countOf } = spawnReady(SID, hostLegacy);
    primeBusy(SID, hostLegacy);
    // TIMING-GUARD-SAFE: sync-early-return — see (D)'s identical site above for the verified reasoning
    // (M1's synchronous busy-arm decides this setup check's outcome before this sleep starts; removing the
    // sleep entirely still passes it).
    await sleep(250);

    const r1 = hostLegacy.enqueueStdin(SID, "LEGACY_MISMATCH_TF_HEAD", "system", undefined, undefined, "agent", undefined, undefined, true);
    const r2 = hostLegacy.enqueueStdin(SID, "LEGACY_MISMATCH_TF_TAIL", "system", undefined, undefined, "agent", undefined, undefined, false);
    check("(E) setup: both queued, same route, no senderId, legacy toggle ON",
      r1.delivered === false && r2.delivered === false &&
      JSON.stringify(hostLegacy.getPending(SID)) === JSON.stringify(["LEGACY_MISMATCH_TF_HEAD", "LEGACY_MISMATCH_TF_TAIL"]));

    let pasteBefore = countOf(PASTE_START);
    hostLegacy.deliverHook(SID, { hook_event_name: "Stop" });
    check("(E) turn 1: exactly ONE submit, for the HEAD (proactive:true) ALONE — the mismatch broke the legacy run",
      countOf(PASTE_START) - pasteBefore === 1);
    check("(E) turn 1: only the head's body is in this turn, the non-proactive tail is NOT folded in",
      written().includes("LEGACY_MISMATCH_TF_HEAD") && !written().includes("LEGACY_MISMATCH_TF_TAIL"));
    check("(E) turn 1: getActiveTurnIsProactive() correctly reads TRUE for the proactive head's turn",
      hostLegacy.getActiveTurnIsProactive(SID) === true);
    check("(E) turn 1: the non-proactive tail stays queued, untouched",
      JSON.stringify(hostLegacy.getPending(SID)) === JSON.stringify(["LEGACY_MISMATCH_TF_TAIL"]));
    await sleep(250);

    pasteBefore = countOf(PASTE_START);
    hostLegacy.deliverHook(SID, { hook_event_name: "Stop" });
    check("(E) turn 2: exactly ONE submit, for the TAIL (proactive:false) ALONE, as its own turn",
      countOf(PASTE_START) - pasteBefore === 1);
    check("(E) turn 2: getActiveTurnIsProactive() correctly reads FALSE for the non-proactive tail's own turn",
      hostLegacy.getActiveTurnIsProactive(SID) === false);
    check("(E) turn 2: queue now empty", hostLegacy.getPending(SID).length === 0);
  }

  // ===================== (F) LEGACY BRANCH POSITIVE CONTROL: SAME proactive (both true) still coalesces =====================
  // Proves the new equality check discriminates on a MISMATCH only — it doesn't blanket-disable the legacy
  // route-keyed branch's coalescing outright, which would make (D)/(E) pass for the wrong reason.
  {
    const SID = "sess-legacy-proactive-match";
    const { written, countOf } = spawnReady(SID, hostLegacy);
    primeBusy(SID, hostLegacy);
    await sleep(250);

    const r1 = hostLegacy.enqueueStdin(SID, "LEGACY_MATCH_ONE", "system", undefined, undefined, "agent", undefined, undefined, true);
    const r2 = hostLegacy.enqueueStdin(SID, "LEGACY_MATCH_TWO", "system", undefined, undefined, "agent", undefined, undefined, true);
    check("(F) setup: both queued, same route+proactive, legacy toggle ON",
      r1.delivered === false && r2.delivered === false &&
      JSON.stringify(hostLegacy.getPending(SID)) === JSON.stringify(["LEGACY_MATCH_ONE", "LEGACY_MATCH_TWO"]));

    const pasteBefore = countOf(PASTE_START);
    hostLegacy.deliverHook(SID, { hook_event_name: "Stop" });
    check("(F) COALESCE: exactly ONE submit for both same-proactive messages", countOf(PASTE_START) - pasteBefore === 1);
    check("(F) COALESCE: both bodies present in the single turn",
      written().includes("LEGACY_MATCH_ONE") && written().includes("LEGACY_MATCH_TWO"));
    check("(F) COALESCE: getActiveTurnIsProactive() correctly reads TRUE for the coalesced turn",
      hostLegacy.getActiveTurnIsProactive(SID) === true);
    check("(F) COALESCE: queue fully drained", hostLegacy.getPending(SID).length === 0);
  }
} finally {
  for (const fake of fakes) { try { fake.kill(); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a same-sender/same-route run with DIFFERING `proactive` breaks instead of silently coalescing (in both head/tail orderings), while a matching-`proactive` run still coalesces as before. The LEGACY route-keyed branch (coalesceAgentMessages:true) — the branch every real proactive producer's lack of senderId actually routes through — carries the same guarantee."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
