// Regression guard for card f41d6617 finding [5] (Code Reviewer session 6382bdb6): drainPending's
// same-sender coalesce loop used to bound AGENT_COALESCE_MAX_BYTES against `m.text.length` (PRISTINE
// text) for every candidate, but the actual write is `joinSubmittedText(drained, …)`, which joins
// members with DRAIN_SEPARATOR (12 chars) and can append a `[loom:mint-time]` annotation per member.
// So a run whose PRISTINE lengths summed to exactly the bound could still write MORE than the bound
// once joined — the reviewer measured (MAX_BYTES=200, five 40-char same-sender members): pristine sum
// exactly 200 (admitted under the old accounting), actual written body 248 chars (200 + 4×12).
//
// This suite is the reviewer's own ready-made shape, run against the REAL drainPending path (a fake pty
// injected via the createPty() seam — no real claude, no daemon):
//   (K) five same-sender 40-char messages, MAX_BYTES=200: under the OLD (pristine-length) accounting all
//       five would coalesce into one turn (200 <= 200), writing 248 actual chars — OVER the bound. Under
//       the FIX, the bound is checked against the projected JOINED length (this candidate's own annotated
//       length + DRAIN_SEPARATOR), so the run stops after 4 members (160 + 3×12 = 196, <= 200) and the 5th
//       stays queued for a later turn.
//
// RUN (no daemon needed): node test/pty-agent-coalesce-byte-accounting.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set BEFORE
// importing host.js — paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-agent-coalesce-bytes-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

// AGENT_COALESCE_MAX_COUNT/_MAX_BYTES are module-level consts (`Number(process.env...) || default`),
// read ONCE at import. COUNT is pinned generously high so it never binds first — this file is testing
// the BYTES accounting specifically, and a low count cap (as in pty-agent-sender-coalesce.mjs, pinned to
// 3 there) would stop the run before the byte bound ever gets a chance to matter.
process.env.LOOM_AGENT_COALESCE_MAX_COUNT = "10";
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

const events = {
  onEngineSessionId() {},
  onBusy() {},
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
};

const host = new TestPtyHost(events);
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

// Five same-sender, exactly-40-char messages, distinguishable by a "MSGn_" prefix.
const msg = (n) => `MSG${n}_`.padEnd(40, "x");

try {
  // ===================== (K) the reviewer's ready-made shape =====================
  {
    const SID = "sess-byte-accounting";
    const { written, countOf } = spawnReady(SID);
    primeBusy(SID);
    await sleep(250); // let PRIMER's async paste-end + Enter flush before measuring the drain below

    const bodies = [1, 2, 3, 4, 5].map(msg);
    check("(K) setup sanity: each body is exactly 40 chars", bodies.every((b) => b.length === 40));
    check("(K) setup sanity: PRISTINE sum of all five is exactly the pinned bound (200) — the boundary case",
      bodies.reduce((a, b) => a + b.length, 0) === 200);

    for (const b of bodies) {
      host.enqueueStdin(SID, b, "system", undefined, undefined, "agent", undefined, undefined, false, "sender-bytes-acct");
    }
    check("(K) setup: all 5 queued, adjacent, same sender", host.getPending(SID).length === 5);

    const pasteBefore = countOf(PASTE_START);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(K) exactly ONE submit for this turn", countOf(PASTE_START) - pasteBefore === 1);

    const turn = written();
    check("(K) FIX: turn carries messages 1-4", [1, 2, 3, 4].every((n) => turn.includes(msg(n))));
    check("(K) FIX: turn does NOT carry message 5 — admitting it would write 248 chars, over the 200 bound",
      !turn.includes(msg(5)));
    check("(K) FIX: message 5 is left queued for a later turn — never dropped, never over-the-bound",
      JSON.stringify(host.getPending(SID)) === JSON.stringify([msg(5)]));

    // Pin the actual written length of the coalesced body: 4 members × 40 chars + 3 separators × 12
    // chars = 196 — under the 200 bound. (Extract just the joined segment between the bracketed-paste
    // markers so trailing PRIMER/Enter bytes from earlier writes don't pollute the measurement.)
    const pasteEndIdx = turn.lastIndexOf("\x1b[201~");
    const startIdx = turn.lastIndexOf(PASTE_START, pasteEndIdx) + PASTE_START.length;
    const joinedBody = turn.slice(startIdx, pasteEndIdx);
    check(`(K) FIX: the actual written/joined body is 196 chars (measured: ${joinedBody.length}) — within the 200 bound`,
      joinedBody.length === 196);
  }
} finally {
  for (const fake of fakes) { try { fake.kill(); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the same-sender coalesce byte bound is enforced against the JOINED/written length, not pristine per-message text length."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
