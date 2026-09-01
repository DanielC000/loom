// Regression guard for card eac3464d DoD-1/DoD-2/DoD-3/DoD-4, EXTENDED by card e01687ea DoD-3 (scenario
// (I) below) — SAME-SENDER coalescing for agent-kind queued messages (pty/host.ts's drainPending
// same-sender branch + enqueueStdin's reorder-on-enqueue + its per-entry leapfrog fairness cap).
//
// Card eac3464d's own DoD-0 measured that 65.8% of worker-report deliveries and 64% of merge-rejection
// deliveries in a real production log window went through drainPending's one-per-turn "agent"-kind path
// — and that under the live default (`coalesceAgentMessages` off), an agent-kind head NEVER coalesced
// with anything, regardless of route or sender. The owner (2026-08-28) asked for same-sender bursts to
// concatenate into one turn while keeping DIFFERENT senders' directives one-per-turn — this is that fix.
//
// This suite proves, against a fake pty injected via the createPty() seam — NO real claude, no daemon:
//   (A) two queued messages from the SAME sender coalesce into ONE turn (one submit, one busy re-arm,
//       both onDeliver fire, FIFO order, DRAIN_SEPARATOR joins them);
//   (B) two queued messages from DIFFERENT senders do NOT coalesce — each drains as its own turn (the
//       2026-07-03 cross-sender guarantee this card's own DoD-0 confirmed is what must survive intact);
//   (C) DoD-2's enqueue-time reorder: sender A, then sender B, then sender A again (interleaved) — the
//       second A message jumps ahead of B's queued message so drainPending has something adjacent to
//       coalesce it with; B's message is untouched and drains on the NEXT turn;
//   (D) DoD-4's COUNT bound: a same-sender run longer than AGENT_COALESCE_MAX_COUNT stops at the bound —
//       the excess stays queued for a later turn, never one unbounded write;
//   (E) DoD-4's BYTES bound: two same-sender messages whose combined size exceeds
//       AGENT_COALESCE_MAX_BYTES do NOT coalesce, even though they're adjacent and same-sender.
//   (H) card 438973ce: EVERY coalesced member's ownerText is attributed (getRecentOwnerTurns), not just
//       drained[0]'s — the regression this specific file was extended for.
//   (I) card e01687ea DoD-3: the reorder's fairness cap is REAL — a quiet entry can be leapfrogged at most
//       AGENT_COALESCE_MAX_COUNT times (via a per-entry `leapfrogCount`), not the unbounded leapfrogging
//       the old (false) "lookback window ages it out" comment claimed prevented this.
//
// give-up/re-mint (giveUpGen-tagged) EXCLUSION from both the coalescing and the reorder is covered
// separately in pty-agent-coalesce-giveup-exclusion.mjs — it needs the real (slow, verify-timeout-driven)
// give-up machinery, which this file deliberately avoids so its own timing stays cheap and default-paced
// (mirrors pty-coalesce-drain.mjs's own default-timeout approach, sibling to this suite).
//
// RUN (no daemon needed): node test/pty-agent-sender-coalesce.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set BEFORE
// importing host.js — paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-agent-coalesce-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

// AGENT_COALESCE_MAX_COUNT/_MAX_BYTES are module-level consts (`Number(process.env...) || default`),
// read ONCE at import — pin both small and DETERMINISTIC so (D) and (E) don't depend on the shipped
// defaults ever drifting. Every scenario below is designed to fit comfortably under these pinned values
// except (D)/(E) themselves, which deliberately exceed them.
process.env.LOOM_AGENT_COALESCE_MAX_COUNT = "3";
process.env.LOOM_AGENT_COALESCE_MAX_BYTES = "200";

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
const SEP = "────────"; // the visible coalesce separator (host.ts DRAIN_SEPARATOR)
const ENTER = "\r";
const PASTE_START = "\x1b[200~";

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
    lastBusy: () => busyLog[sessionId]?.at(-1),
    busyLenAt: () => busyLog[sessionId]?.length ?? 0,
  };
}

/** Put the session mid-turn (busy) so subsequent enqueueStdin calls are HELD/queued, not submitted
 *  immediately (mirrors pty-coalesce-drain.mjs's own "PRIMER" setup). */
function primeBusy(sessionId) {
  const r = host.enqueueStdin(sessionId, "PRIMER_TURN");
  if (!r.delivered) throw new Error(`primeBusy(${sessionId}): PRIMER was not delivered immediately`);
}

try {
  // ===================== (A) SAME-SENDER coalesces into ONE turn =====================
  {
    const SID = "sess-same-sender";
    const { written, countOf, lastBusy, busyLenAt } = spawnReady(SID);
    primeBusy(SID);
    await sleep(250); // let PRIMER's async paste-end + Enter flush before measuring the drain below

    const delivered = [];
    const r1 = host.enqueueStdin(SID, "SENDER_A_MSG_ONE", "system", () => delivered.push(1), undefined, "agent", undefined, undefined, false, "sender-a");
    const r2 = host.enqueueStdin(SID, "SENDER_A_MSG_TWO", "system", () => delivered.push(2), undefined, "agent", undefined, undefined, false, "sender-a");
    check("(A) setup: both queued behind busy", r1.delivered === false && r2.delivered === false);
    check("(A) setup: FIFO order is [MSG_ONE, MSG_TWO] (no reorder needed — already adjacent)",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["SENDER_A_MSG_ONE", "SENDER_A_MSG_TWO"]));

    const pasteBefore = countOf(PASTE_START);
    const busyLenBefore = busyLenAt();
    host.deliverHook(SID, { hook_event_name: "Stop" });

    check("(A) COALESCE: exactly ONE submit for both same-sender messages", countOf(PASTE_START) - pasteBefore === 1);
    check("(A) COALESCE: queue fully drained (pending empty)", host.getPending(SID).length === 0);
    check("(A) COALESCE: both onDeliver callbacks fired, in order", JSON.stringify(delivered) === JSON.stringify([1, 2]));
    check("(A) COALESCE: exactly ONE busy re-arm (false then true)",
      busyLog[SID].slice(busyLenBefore).join(",") === "false,true" && lastBusy() === true);
    const turn = written();
    const i1 = turn.indexOf("SENDER_A_MSG_ONE"), i2 = turn.indexOf("SENDER_A_MSG_TWO");
    check("(A) COALESCE: both bodies present, FIFO order, joined by the visible separator",
      i1 >= 0 && i2 >= 0 && i1 < i2 && countOf(SEP) - 0 >= 1);
  }

  // ===================== (B) DIFFERENT senders do NOT coalesce (the 2026-07-03 guarantee) =====================
  {
    const SID = "sess-cross-sender";
    const { written, countOf, lastBusy, busyLenAt } = spawnReady(SID);
    primeBusy(SID);
    await sleep(250);

    const delivered = [];
    const rA = host.enqueueStdin(SID, "SENDER_A_ONLY_MSG", "system", () => delivered.push("A"), undefined, "agent", undefined, undefined, false, "sender-a");
    const rB = host.enqueueStdin(SID, "SENDER_B_ONLY_MSG", "system", () => delivered.push("B"), undefined, "agent", undefined, undefined, false, "sender-b");
    check("(B) setup: both queued, FIFO order [A, B] (no same-sender anchor for B to jump onto)",
      rA.delivered === false && rB.delivered === false &&
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["SENDER_A_ONLY_MSG", "SENDER_B_ONLY_MSG"]));

    let pasteBefore = countOf(PASTE_START);
    let busyLenBefore = busyLenAt();
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(B) turn 1: exactly ONE submit, for sender A ALONE", countOf(PASTE_START) - pasteBefore === 1);
    check("(B) turn 1: only A delivered so far — B is UNTOUCHED, still queued", JSON.stringify(delivered) === JSON.stringify(["A"]));
    check("(B) turn 1: sender B's message is NOT folded into A's turn", !written().includes("SENDER_B_ONLY_MSG"));
    check("(B) turn 1: one busy re-arm", busyLog[SID].slice(busyLenBefore).join(",") === "false,true" && lastBusy() === true);
    check("(B) turn 1: B still sitting in pending", JSON.stringify(host.getPending(SID)) === JSON.stringify(["SENDER_B_ONLY_MSG"]));
    await sleep(250);

    // Turn 2: B drains alone on the NEXT Stop — proving cross-sender stayed one-per-turn, not silently dropped.
    pasteBefore = countOf(PASTE_START);
    busyLenBefore = busyLenAt();
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(B) turn 2: exactly ONE submit, for sender B ALONE", countOf(PASTE_START) - pasteBefore === 1);
    check("(B) turn 2: both A and B eventually delivered, as TWO separate turns", JSON.stringify(delivered) === JSON.stringify(["A", "B"]));
    check("(B) turn 2: queue now empty", host.getPending(SID).length === 0);
  }

  // ===================== (C) DoD-2 reorder: interleaved arrivals still coalesce same-sender =====================
  {
    const SID = "sess-reorder";
    const { written, countOf } = spawnReady(SID);
    primeBusy(SID);
    await sleep(250);

    const rA1 = host.enqueueStdin(SID, "REORDER_A_ONE", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-a");
    const rB1 = host.enqueueStdin(SID, "REORDER_B_ONE", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-b");
    check("(C) setup: pre-reorder FIFO is [A1, B1]",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["REORDER_A_ONE", "REORDER_B_ONE"]));
    check("(C) setup: positions before A2 arrives are 1 and 2", rA1.position === 1 && rB1.position === 2);

    // Sender A's SECOND message arrives after B's — DoD-2 says it should jump ahead of B, landing right
    // after A's own last queued entry instead of at the tail.
    const rA2 = host.enqueueStdin(SID, "REORDER_A_TWO", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-a");
    check("(C) DoD-2: A2 REORDERED ahead of B1 — FIFO is now [A1, A2, B1], not [A1, B1, A2]",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["REORDER_A_ONE", "REORDER_A_TWO", "REORDER_B_ONE"]));
    check("(C) DoD-2: A2's reported position (1-based) reflects where it ACTUALLY landed (2), not the FIFO tail (3)",
      rA2.position === 2);

    const pasteBefore = countOf(PASTE_START);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(C) turn 1: exactly ONE submit — A1+A2 coalesced (now adjacent thanks to the reorder)",
      countOf(PASTE_START) - pasteBefore === 1);
    const turn1 = written();
    check("(C) turn 1: both A bodies present, B's is NOT", turn1.includes("REORDER_A_ONE") && turn1.includes("REORDER_A_TWO") && !turn1.includes("REORDER_B_ONE"));
    check("(C) turn 1: B1 untouched, still queued alone", JSON.stringify(host.getPending(SID)) === JSON.stringify(["REORDER_B_ONE"]));
  }

  // ===================== (D) DoD-4 COUNT bound: a same-sender run longer than the cap stops at it =====================
  {
    const SID = "sess-count-bound";
    const { written, countOf } = spawnReady(SID);
    primeBusy(SID);
    await sleep(250);

    // MAX_COUNT pinned to 3 above — 4 same-sender messages must NOT all coalesce into one turn.
    for (const n of [1, 2, 3, 4]) {
      host.enqueueStdin(SID, `COUNT_BOUND_MSG_${n}`, "system", undefined, undefined, "agent", undefined, undefined, false, "sender-count");
    }
    check("(D) setup: all 4 queued, adjacent, same sender", host.getPending(SID).length === 4);

    const pasteBefore = countOf(PASTE_START);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(D) BOUND: exactly ONE submit for this turn", countOf(PASTE_START) - pasteBefore === 1);
    const turn1 = written();
    check("(D) BOUND: turn 1 carries messages 1-3, NOT message 4 (stops at AGENT_COALESCE_MAX_COUNT=3)",
      turn1.includes("COUNT_BOUND_MSG_1") && turn1.includes("COUNT_BOUND_MSG_2") && turn1.includes("COUNT_BOUND_MSG_3") && !turn1.includes("COUNT_BOUND_MSG_4"));
    check("(D) BOUND: message 4 is left queued for a later turn — never dropped, never over-coalesced",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["COUNT_BOUND_MSG_4"]));
  }

  // ===================== (E) DoD-4 BYTES bound: same-sender, adjacent, but too big together =====================
  {
    const SID = "sess-bytes-bound";
    const { written, countOf } = spawnReady(SID);
    primeBusy(SID);
    await sleep(250);

    // MAX_BYTES pinned to 200 above. Two ~150-char same-sender bodies sum well past that, so they must
    // NOT coalesce even though they're adjacent, same-sender, and well under the COUNT bound.
    const BIG_A = "BYTES_BOUND_HEAD_" + "x".repeat(150);
    const BIG_B = "BYTES_BOUND_TAIL_" + "y".repeat(150);
    check("(E) setup sanity: the two bodies alone fit under 200 (so a genuine cap, not a giant single message)",
      BIG_A.length < 200 && BIG_B.length < 200);
    check("(E) setup sanity: COMBINED they exceed AGENT_COALESCE_MAX_BYTES=200", BIG_A.length + BIG_B.length > 200);
    host.enqueueStdin(SID, BIG_A, "system", undefined, undefined, "agent", undefined, undefined, false, "sender-bytes");
    host.enqueueStdin(SID, BIG_B, "system", undefined, undefined, "agent", undefined, undefined, false, "sender-bytes");

    const pasteBefore = countOf(PASTE_START);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(E) BOUND: exactly ONE submit for this turn", countOf(PASTE_START) - pasteBefore === 1);
    const turn1 = written();
    check("(E) BOUND: turn 1 carries ONLY the head — the byte cap stopped the second body from folding in",
      turn1.includes(BIG_A) && !turn1.includes(BIG_B));
    check("(E) BOUND: the second body is left queued, not dropped", JSON.stringify(host.getPending(SID)) === JSON.stringify([BIG_B]));
  }
  // ===================== (F) NULL-sender messages never coalesce/reorder with each other =====================
  // A real, pre-existing shape: some production callers (the restart-replay seam, the kickoff give-up
  // remint) enqueue kind:"agent" text with senderId deliberately omitted. Two such omitted-sender
  // messages must NOT be treated as "the same sender" just because both are null/undefined — identity
  // can't be established from an absent id. Caught during this card's own implementation (not a
  // hypothetical): the first draft's `(a.senderId ?? null) === (b.senderId ?? null)` equality made two
  // unrelated null-sender entries match, which would have folded them together.
  {
    const SID = "sess-null-sender";
    const { written, countOf } = spawnReady(SID);
    primeBusy(SID);
    await sleep(250);

    // Neither call passes a senderId (positional arg 10 omitted) — mirrors the real restart-replay/
    // kickoff-remint call shape.
    const r1 = host.enqueueStdin(SID, "NULL_SENDER_MSG_ONE", "system", undefined, undefined, "agent");
    const r2 = host.enqueueStdin(SID, "NULL_SENDER_MSG_TWO", "system", undefined, undefined, "agent");
    check("(F) setup: NO reorder — FIFO stays [ONE, TWO], byte-identical to pre-eac3464d push-to-tail",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["NULL_SENDER_MSG_ONE", "NULL_SENDER_MSG_TWO"]));
    check("(F) setup: position is the plain tail for both (no reorder ever attempted)", r1.position === 1 && r2.position === 2);

    const pasteBefore = countOf(PASTE_START);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(F) NO COALESCE: exactly ONE submit, for MSG_ONE alone — two null-sender entries never merge",
      countOf(PASTE_START) - pasteBefore === 1);
    const turn1 = written();
    check("(F) NO COALESCE: only MSG_ONE's body is in this turn, MSG_TWO's is not",
      turn1.includes("NULL_SENDER_MSG_ONE") && !turn1.includes("NULL_SENDER_MSG_TWO"));
    check("(F) NO COALESCE: MSG_TWO stays queued, untouched, for its own separate turn",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["NULL_SENDER_MSG_TWO"]));
  }
  // ===================== (G) a held/give-up entry between a match and the tail is NEVER reordered past =====================
  // Manager review finding (card eac3464d): the reorder loop's own comment claims a give-up-held/
  // giveUpGen entry "keeps its FIFO/front position untouched", but a bare `continue` on such an entry
  // does not STOP the backward scan — it only skips that ONE candidate and keeps looking further back,
  // so a match found on the far side of it produces an `insertAt` BEFORE it, shifting its index. Traced:
  // pending=[A(sender S), H(held, sender S)], a NEW same-sender B arrives — `continue` would find A as a
  // match and splice B in between A and H (H's index moves from 1 to 2); the comment says this must NOT
  // happen. `giveUpGen` itself isn't constructible via the public enqueueStdin API outside a real give-up
  // cycle (covered separately, slowly, in pty-agent-coalesce-giveup-exclusion.mjs) — but `isGiveUpHeld`
  // feeds the EXACT SAME `continue`/`break` branch and IS constructible directly via the `giveUpHeldUntil`
  // tail param, so this is a faithful, fast proxy for the identical code path.
  {
    const SID = "sess-held-wall";
    spawnReady(SID);
    primeBusy(SID);
    await sleep(250);

    const FAR_FUTURE = Date.now() + 60_000; // stays held for the whole test — never expires mid-run
    host.enqueueStdin(SID, "WALL_A", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-wall");
    const rH = host.enqueueStdin(SID, "WALL_H_HELD", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-wall", FAR_FUTURE);
    check("(G) setup: H (held) landed right after A — both same-sender, H reorders onto A same as any fresh message would",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["WALL_A", "WALL_H_HELD"]));
    check("(G) setup: H's queue position is 2 (index 1)", rH.position === 2);

    // A THIRD same-sender message arrives with H (held) sitting between the tail and A. It must NOT
    // reorder past H onto A — H's position must stay EXACTLY where it is.
    const rB = host.enqueueStdin(SID, "WALL_B", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-wall");
    check("(G) FIX: pending is [A, H, B] — B did NOT jump past H onto A; H's position is genuinely untouched",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["WALL_A", "WALL_H_HELD", "WALL_B"]));
    check("(G) FIX: B's reported position is the tail (3), not a reorder onto A (2) — it had nothing eligible to anchor onto",
      rB.position === 3);
  }
  // ===================== (H) card 438973ce: owner-text attribution for EVERY coalesced member =====================
  // `drainPending` used to submit a coalesced turn with only `drained[0]!.ownerText` — `submit()` calls
  // `attributeOwnerText` ONCE, so members 2..N of a same-sender coalesced run were never attributed into
  // `recentOwnerTurns`/`activeTurnOwnerText`, even though both bodies land in the SAME written turn. This
  // proves the fix against the REAL coalescing path (not a fake pty): two same-route/same-senderId owner
  // messages coalesce into one turn, and BOTH bodies must show up via `getRecentOwnerTurns`.
  {
    const SID = "sess-owner-text-attrib";
    const { countOf } = spawnReady(SID);
    // Checked immediately at spawn, BEFORE primeBusy/sleep below — a fresh session's owner-turn ring is
    // empty by construction (nothing has ever called attributeOwnerText for it), so this is independent of
    // the sleep that follows, not a fixed-wait-then-negative-check on anything actually settling.
    check("(H) setup: fresh session has no owner-turn history yet", host.getRecentOwnerTurns(SID).length === 0);
    primeBusy(SID);
    await sleep(250);

    const r1 = host.enqueueStdin(SID, "OWNER_COALESCE_MSG_ONE", "system", undefined, undefined, "agent", undefined, "owner said msg one", false, "sender-owner-attrib");
    const r2 = host.enqueueStdin(SID, "OWNER_COALESCE_MSG_TWO", "system", undefined, undefined, "agent", undefined, "owner said msg two", false, "sender-owner-attrib");
    check("(H) setup: both queued, same sender, FIFO [ONE, TWO]",
      r1.delivered === false && r2.delivered === false &&
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["OWNER_COALESCE_MSG_ONE", "OWNER_COALESCE_MSG_TWO"]));

    const pasteBefore = countOf(PASTE_START);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(H) COALESCE: exactly ONE submit for both same-sender owner messages", countOf(PASTE_START) - pasteBefore === 1);

    check("(H) FIX: getRecentOwnerTurns returns BOTH bodies, newest-first, in FIFO-attributed order",
      JSON.stringify(host.getRecentOwnerTurns(SID)) === JSON.stringify(["owner said msg two", "owner said msg one"]));
    check("(H) FIX: getActiveTurnOwnerText reflects the LAST drained member (msg two), not just the head",
      host.getActiveTurnOwnerText(SID) === "owner said msg two");
  }
  // ===================== (I) card e01687ea: the reorder's FAIRNESS CAP is real, not just a lookback window =====================
  // The FAIRNESS BOUND comment above the reorder (host.ts) used to claim the AGENT_COALESCE_MAX_COUNT
  // lookback window itself capped how many times a quiet OTHER-sender entry could be leapfrogged. MEASURED
  // FALSE (card e01687ea): the reorder always inserts immediately in front of whatever already sits after
  // the sender's last entry, so a quiet entry's absolute index grows in lockstep with the window and it
  // NEVER ages out — reproduced here with MAX_COUNT pinned to 3 (env above): a naive scan would let
  // sender-fair-a leapfrog the quiet entry unboundedly. This proves the REAL fix — a per-entry
  // `leapfrogCount` that freezes an entry once it's been displaced AGENT_COALESCE_MAX_COUNT times.
  {
    const SID = "sess-fairness-cap";
    spawnReady(SID);
    primeBusy(SID);
    await sleep(250);

    host.enqueueStdin(SID, "FAIR_A1", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-fair-a");
    host.enqueueStdin(SID, "FAIR_QUIET", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-fair-quiet");
    check("(I) setup: [A1, QUIET]", JSON.stringify(host.getPending(SID)) === JSON.stringify(["FAIR_A1", "FAIR_QUIET"]));

    // sender-fair-a bursts A2..A4 — MAX_COUNT (3) worth of leapfrogs over the quiet entry. Each one must
    // still land right in front of QUIET (the reorder itself is unaffected below the cap).
    for (const n of [2, 3, 4]) {
      host.enqueueStdin(SID, `FAIR_A${n}`, "system", undefined, undefined, "agent", undefined, undefined, false, "sender-fair-a");
    }
    check("(I) below cap: QUIET leapfrogged exactly 3 times, still sitting at the tail",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["FAIR_A1", "FAIR_A2", "FAIR_A3", "FAIR_A4", "FAIR_QUIET"]));

    // A5: QUIET has now been displaced AGENT_COALESCE_MAX_COUNT (3) times — the cap must refuse a 4th
    // leapfrog. A5 lands at the true FIFO tail, BEHIND QUIET, instead of leapfrogging it again.
    const rA5 = host.enqueueStdin(SID, "FAIR_A5", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-fair-a");
    check("(I) AT CAP: A5 does NOT leapfrog QUIET a 4th time — QUIET is frozen in place",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["FAIR_A1", "FAIR_A2", "FAIR_A3", "FAIR_A4", "FAIR_QUIET", "FAIR_A5"]));
    check("(I) AT CAP: A5's reported position is the true tail (6), not a leapfrog onto A4 (5)", rA5.position === 6);

    // A6/A7: once QUIET is frozen, further same-sender arrivals coalesce onto the new tail (A5/A6) exactly
    // as usual — QUIET stays permanently parked, never displaced again, never blocking new same-sender
    // coalescing either.
    host.enqueueStdin(SID, "FAIR_A6", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-fair-a");
    host.enqueueStdin(SID, "FAIR_A7", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-fair-a");
    check("(I) AFTER CAP: QUIET stays frozen at its position; new arrivals pile up after it, not before",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["FAIR_A1", "FAIR_A2", "FAIR_A3", "FAIR_A4", "FAIR_QUIET", "FAIR_A5", "FAIR_A6", "FAIR_A7"]));
  }
  // ===================== (J) card e01687ea code-review follow-up: a FROZEN entry is still a legitimate MATCH target for its OWN sender =====================
  // Code Review finding: the leapfrogCount freeze check used to run BEFORE the same-sender match check, so
  // an entry that had reached the cap (by sitting right after a DIFFERENT sender's growing chain and being
  // repeatedly leapfrogged by it) would `break` the scan before ever getting a chance to match a LATER
  // arrival from its OWN sender+route — even though matching it is always safe (a match inserts strictly
  // AFTER the matched entry's own index, so it can never displace the entry it matches). This reproduces
  // exactly that shape: sender-X's X1 sits right after sender-J's chain and gets frozen by J's own bursts,
  // then sender-X sends X2 — which MUST still land right after X1, not fall back to the FIFO tail.
  {
    const SID = "sess-frozen-still-matches-own-sender";
    spawnReady(SID);
    primeBusy(SID);
    await sleep(250);

    host.enqueueStdin(SID, "FROZEN_J1", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-frozen-j");
    host.enqueueStdin(SID, "FROZEN_X1", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-frozen-x");
    check("(J) setup: [J1, X1] — X1 sits right after J1, the only spot a J arrival can leapfrog it from",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["FROZEN_J1", "FROZEN_X1"]));

    // Each subsequent J arrival matches the PRIOR J entry and reorders onto it — which sits right before
    // X1, so every one of these leapfrogs X1 by exactly one. Three of them drive X1's leapfrogCount to
    // exactly the cap (3).
    for (const n of [2, 3, 4]) {
      host.enqueueStdin(SID, `FROZEN_J${n}`, "system", undefined, undefined, "agent", undefined, undefined, false, "sender-frozen-j");
    }
    check("(J) setup: X1 has been leapfrogged to the cap (3) by sender-J's own chain",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["FROZEN_J1", "FROZEN_J2", "FROZEN_J3", "FROZEN_J4", "FROZEN_X1"]));

    // A 5th J message: X1 is now frozen (cap reached) — this must NOT leapfrog it again, so J5 falls back
    // to the FIFO tail, mirroring scenario (I)'s own AT-CAP behavior.
    host.enqueueStdin(SID, "FROZEN_J5", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-frozen-j");
    check("(J) setup: J5 does NOT leapfrog the frozen X1 — falls back to the tail",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["FROZEN_J1", "FROZEN_J2", "FROZEN_J3", "FROZEN_J4", "FROZEN_X1", "FROZEN_J5"]));

    // THE FIX: sender-X sends X2. X1 is frozen, but it is STILL X2's correct, safe match (X2 lands strictly
    // AFTER X1's own index, so matching it never displaces X1 further) — X2 must reorder onto X1, not fall
    // back to the tail behind J5.
    const rX2 = host.enqueueStdin(SID, "FROZEN_X2", "system", undefined, undefined, "agent", undefined, undefined, false, "sender-frozen-x");
    check("(J) FIX: X2 reorders onto its OWN frozen sender X1 — [J1..J4, X1, X2, J5], not [..., J5, X2]",
      JSON.stringify(host.getPending(SID)) === JSON.stringify(["FROZEN_J1", "FROZEN_J2", "FROZEN_J3", "FROZEN_J4", "FROZEN_X1", "FROZEN_X2", "FROZEN_J5"]));
    check("(J) FIX: X2's reported position (6) reflects landing right after X1, not the FIFO tail (7)", rX2.position === 6);
  }
} finally {
  for (const fake of fakes) { try { fake.kill(); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — same-sender agent-kind messages coalesce (bounded by count+bytes, reordered ahead of other senders on enqueue, with a REAL per-entry leapfrog cap on how much a quiet entry can be delayed); different senders still drain one-per-turn."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
