// Regression guard for card f286919e: the coalesced turn's `activeTurnSenderId` (Companion Trust Window)
// and `activeTurnOwnerText` (Companion injection-guard Primitive A) must be derived from the SAME check,
// so a MULTI-SENDER coalesced batch can never leave them naming different chat members.
//
// THE DEFECT this closes: `submit()` used to attribute owner text via a loop over EVERY `origin` member
// (card 438973ce, `341d6b20`) — so `activeTurnOwnerText` ended as the LAST member's text — while
// `activeTurnSenderId` stayed `drained[0]!.senderId` — the HEAD's. In the DEFAULT agent-kind coalescing
// branch (pty-agent-sender-coalesce.mjs's own suite) this can never diverge, because that branch enforces
// `senderId` equality as part of its own run condition. But the LEGACY `coalesceAgentMessages:true`
// full-coalesce (drainPending's ROUTE-KEYED branch) has NO per-member sender check — it folds the whole
// same-route run together regardless of sender — so a batch spanning two senders could end up with member
// B's attested words paired with member A's sender id, letting a companion trust window warmed for A cover
// an act actually requested by B.
//
// THE FIX (this card): `submit()` now computes a single `originSenderId` — the batch's one common sender
// when every `origin` member agrees, else null — and uses it to gate BOTH facts: owner-text attribution
// only happens (and `activeTurnSenderId` is only pinned to a real id) when the whole batch is single-
// sender; a multi-sender batch nulls BOTH together (fail closed) rather than let one survive without the
// other.
//
// This suite proves, against a fake pty injected via the createPty() seam — NO real claude, no daemon,
// with `coalesceAgentMessages: true` (the ONLY way drainPending's route-keyed branch ever mixes senders):
//   (K) two queued messages from DIFFERENT senders, same route, both authored (ownerText) — the legacy
//       branch still coalesces them into ONE turn (unchanged — that's its own existing contract), but
//       `activeTurnSenderId` AND `activeTurnOwnerText` are BOTH null afterward, and NEITHER body was
//       attributed into `recentOwnerTurns` — never "head's sender id, tail's words".
//   (L) POSITIVE CONTROL: two queued messages from the SAME sender, same route, under the SAME legacy
//       toggle — they still agree (sender id + the LAST message's owner text), proving the null-both path
//       above is a genuine multi-sender-only branch, not a general regression that nulls everything.
//
// RUN (no daemon needed): node test/pty-multisender-coalesce-attribution.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set BEFORE
// importing host.js — paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-multisender-coalesce-${Date.now()}-${process.pid}`);
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

// The LEGACY toggle: `coalesceAgentMessages: true` is the ONLY way drainPending's route-keyed branch ever
// folds messages from DIFFERENT senders into one turn — see the file header.
const host = new TestPtyHost(events, { coalesceAgentMessages: true });
const PASTE_START = "\x1b[200~";
const ROUTE = { channel: "test-channel", chatId: "group-1" }; // ONE route, per the card's DoD-2

function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return {
    fake,
    written: () => fake.writes.join(""),
    countOf: (m) => fake.writes.join("").split(m).length - 1,
  };
}

/** Put the session mid-turn (busy) so subsequent enqueueStdin calls are HELD/queued, not submitted
 *  immediately (mirrors pty-agent-sender-coalesce.mjs's own PRIMER setup). */
function primeBusy(sessionId) {
  const r = host.enqueueStdin(sessionId, "PRIMER_TURN");
  if (!r.delivered) throw new Error(`primeBusy(${sessionId}): PRIMER was not delivered immediately`);
}

try {
  // ===================== (K) MULTI-SENDER legacy coalesce: sender key + owner text must BOTH null =====================
  {
    const SID = "sess-multisender-legacy";
    const { countOf } = spawnReady(SID);
    check("(K) setup: fresh session has no owner-turn history yet", host.getRecentOwnerTurns(SID).length === 0);
    check("(K) setup: fresh session has no active sender id yet", host.getActiveTurnSenderId(SID) === null);
    primeBusy(SID);
    await sleep(250); // let PRIMER's async paste-end + Enter flush before measuring the drain below

    const rA = host.enqueueStdin(SID, "MULTI_MSG_FROM_A", "system", undefined, ROUTE, "agent", undefined, "owner said: message from A", false, "member-a");
    const rB = host.enqueueStdin(SID, "MULTI_MSG_FROM_B", "system", undefined, ROUTE, "agent", undefined, "owner said: message from B", false, "member-b");
    check("(K) setup: both queued behind busy, same route, DIFFERENT senders", rA.delivered === false && rB.delivered === false);

    const pasteBefore = countOf(PASTE_START);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(K) UNCHANGED: the legacy route-keyed branch still coalesces cross-sender into ONE turn",
      countOf(PASTE_START) - pasteBefore === 1);
    const turn = host.getPending(SID);
    check("(K) UNCHANGED: queue fully drained (pending empty)", turn.length === 0);

    check("(K) FIX: activeTurnSenderId is NULL — never the head's (\"member-a\") nor the tail's (\"member-b\")",
      host.getActiveTurnSenderId(SID) === null);
    check("(K) FIX: activeTurnOwnerText is NULL — never attested under a mismatched sender",
      host.getActiveTurnOwnerText(SID) === null);
    check("(K) FIX: NEITHER member's words were attributed into recentOwnerTurns — the whole batch failed CLOSED",
      host.getRecentOwnerTurns(SID).length === 0);
  }

  // ===================== (L) POSITIVE CONTROL: SAME sender under the SAME legacy toggle still agrees =====================
  {
    const SID = "sess-samesender-legacy";
    spawnReady(SID);
    primeBusy(SID);
    await sleep(250);

    const rA1 = host.enqueueStdin(SID, "SAME_SENDER_MSG_ONE", "system", undefined, ROUTE, "agent", undefined, "owner said: msg one", false, "member-only");
    const rA2 = host.enqueueStdin(SID, "SAME_SENDER_MSG_TWO", "system", undefined, ROUTE, "agent", undefined, "owner said: msg two", false, "member-only");
    check("(L) setup: both queued, same route, SAME sender", rA1.delivered === false && rA2.delivered === false);

    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(L) CONTROL: activeTurnSenderId agrees with the (only) sender",
      host.getActiveTurnSenderId(SID) === "member-only");
    check("(L) CONTROL: activeTurnOwnerText is the LAST member's text — attribution runs normally when single-sender",
      host.getActiveTurnOwnerText(SID) === "owner said: msg two");
    check("(L) CONTROL: BOTH members' words landed in recentOwnerTurns, newest-first — the null-both path is multi-sender-only, not a general regression",
      JSON.stringify(host.getRecentOwnerTurns(SID)) === JSON.stringify(["owner said: msg two", "owner said: msg one"]));
  }
} finally {
  for (const fake of fakes) { try { fake.kill(); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a multi-sender legacy-coalesced batch nulls BOTH the trust-window sender key and the attested owner text together (fail closed); a same-sender batch under the same toggle still agrees on both."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
