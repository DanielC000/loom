// `EnqueueStdinTail.headInsert` test for the REAL PtyHost.enqueueStdin (card dacc6d9e, CR round 2,
// finding 2): a HELD arrival passing `headInsert:true` must land at the FRONT of `live.pending` (index
// 0), not the FIFO tail, without flushing/superseding anything already queued — the mechanism
// `SessionService.redirectWorkerForContextInterrupt` uses so Trigger D's worker-context interrupt drains
// BEFORE the worker's own manager's already-queued direction, instead of behind it.
//
// Pins, against the REAL PtyHost state machine + a FAKE pty (createPty seam — NO real claude/daemon):
//   A. a plain (no headInsert) arrival still goes to the FIFO tail — byte-identical to before this field
//      existed;
//   B. a headInsert:true arrival jumps AHEAD of an already-queued, different-sender entry;
//   C. a SECOND headInsert:true arrival lands at the (new) front too — ahead of the FIRST headInsert
//      entry — never between two ordinary entries;
//   D. headInsert is a one-shot per-call option — it does not retroactively reorder anything already
//      queued, and a later PLAIN arrival still goes to the tail, behind every headInsert entry.
//   E. card dacc6d9e round 3 — the PRODUCTION shape under the default `coalesceAgentMessages:false` (this
//      host is constructed below with no override, so that is what this scenario exercises): an
//      agent-kind, null-sender head-inserted interrupt (kind:"agent" — `enqueueDurableMessage`'s own
//      `ctx.kind ?? "agent"` default; sender "system", null-mapped by `coalesceSenderIdentity` before
//      this reaches drainPending; headInsert:true) ahead of an already-queued SAME-MANAGER two-message
//      agent run. Proves it drains ALONE, as its own turn, never coalesced with the manager's run either
//      backward (onto the run) or forward (the run folding into it) — and that the manager's run is left
//      fully intact to coalesce together on its OWN next turn, exactly as docs/decisions/dacc6d9e-*.md's
//      round-3 correction explains (drainPending's same-sender extension loop, taken only when
//      `!coalesceAgentMessages`, is gated on `senderKey !== null`, so a null-sender head can never extend
//      into a run regardless of kind). Under the legacy `coalesceAgentMessages:true` toggle this
//      isolation does NOT hold (same record's round-3 finding 4, a named residual) — this scenario does
//      not exercise that toggle.
//   F. card 3dee1d51 — a give-up-held entry ALREADY sitting at the queue head (ineligible to drain —
//      `isGiveUpHeld`) is NOT dropped, and NOT reordered relative to what's queued behind it, when a
//      headInsert:true arrival lands: the new entry becomes the new front, the held entry and everything
//      after it are merely shifted back by one, in their original relative order. Nothing queued is ever
//      LOST by a head-insert — it only ever changes who's first.
//
// Sibling to pty-agent-sender-coalesce.mjs (the same-sender reorder this is independent of) and
// pty-route-coalesce.mjs (the route-keyed coalescing this does not interact with — headInsert entries in
// scenarios A-D are all `kind:"warning"` default, which that coalescing scan never matches; scenario E
// is deliberately `kind:"agent"` to exercise the real production shape instead).
// RUN (no daemon needed): node test/pty-head-insert.mjs  (build first: from packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASTE_START = "\x1b[200~";

const tmpHome = path.join(os.tmpdir(), `loom-head-insert-${Date.now()}-${process.pid}`);
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
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

function newSession(name) {
  const sid = `sess-hi-${name}`;
  host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sid, { hook_event_name: "SessionStart" });
  return sid;
}

try {
  // ===== A. Plain arrival (no headInsert) still goes to the FIFO tail =====
  {
    const sid = newSession("A");
    host.enqueueStdin(sid, "PRIMER"); // a turn in flight, so the next enqueues are HELD
    host.enqueueStdin(sid, "first", "system", undefined, undefined, "warning", undefined, undefined, undefined, "mgr-a");
    host.enqueueStdin(sid, "second", "system", undefined, undefined, "warning", undefined, undefined, undefined, "mgr-a");
    check("A: plain arrivals keep FIFO order, byte-identical to before headInsert existed", eq(host.getPending(sid), ["first", "second"]));
  }

  // ===== B. headInsert:true jumps AHEAD of an already-queued, different-sender entry =====
  {
    const sid = newSession("B");
    host.enqueueStdin(sid, "PRIMER");
    host.enqueueStdin(sid, "MANAGER_DIRECTION", "system", undefined, undefined, "agent", undefined, undefined, undefined, "mgr-b");
    check("B: setup — the manager's direction queued first, alone", eq(host.getPending(sid), ["MANAGER_DIRECTION"]));

    host.enqueueStdin(sid, "CONTEXT_INTERRUPT", "system", undefined, undefined, "warning", undefined, undefined, undefined, "system", { headInsert: true });
    check("B: headInsert entry jumps to the FRONT, ahead of the pre-existing entry", eq(host.getPending(sid), ["CONTEXT_INTERRUPT", "MANAGER_DIRECTION"]));
  }

  // ===== C. A second headInsert:true lands at the (new) front — never between two ordinary entries =====
  {
    const sid = newSession("C");
    host.enqueueStdin(sid, "PRIMER");
    host.enqueueStdin(sid, "ordinary-1", "system", undefined, undefined, "warning", undefined, undefined, undefined, "mgr-c");
    host.enqueueStdin(sid, "head-1", "system", undefined, undefined, "warning", undefined, undefined, undefined, "system", { headInsert: true });
    check("C: setup — first headInsert entry is at the front", eq(host.getPending(sid), ["head-1", "ordinary-1"]));

    host.enqueueStdin(sid, "head-2", "system", undefined, undefined, "warning", undefined, undefined, undefined, "system", { headInsert: true });
    check("C: a second headInsert entry lands at the NEW front, ahead of the first one too", eq(host.getPending(sid), ["head-2", "head-1", "ordinary-1"]));
  }

  // ===== D. headInsert is one-shot per call — a later PLAIN arrival still goes to the tail =====
  {
    const sid = newSession("D");
    host.enqueueStdin(sid, "PRIMER");
    host.enqueueStdin(sid, "ordinary-1", "system", undefined, undefined, "warning", undefined, undefined, undefined, "mgr-d");
    host.enqueueStdin(sid, "head-1", "system", undefined, undefined, "warning", undefined, undefined, undefined, "system", { headInsert: true });
    host.enqueueStdin(sid, "ordinary-2", "system", undefined, undefined, "warning", undefined, undefined, undefined, "mgr-d-2");
    check("D: a later plain arrival still lands at the tail, behind the headInsert entry", eq(host.getPending(sid), ["head-1", "ordinary-1", "ordinary-2"]));
  }

  // ===== E. PRODUCTION SHAPE: an agent-kind, null-sender headInsert interrupt drains ALONE, ahead of a
  // queued same-manager agent run (card dacc6d9e round 3 — see the file-header comment above) =====
  {
    const sid = newSession("E");
    const fake = fakes[fakes.length - 1];
    host.enqueueStdin(sid, "PRIMER");
    await sleep(250); // let PRIMER's async paste-end + Enter flush before the queue below is built

    host.enqueueStdin(sid, "MANAGER_DIRECTION_ONE", "system", undefined, undefined, "agent", undefined, undefined, false, "mgr-e");
    host.enqueueStdin(sid, "MANAGER_DIRECTION_TWO", "system", undefined, undefined, "agent", undefined, undefined, false, "mgr-e");
    check("E: setup — the manager's two-message run is queued, adjacent, same sender",
      eq(host.getPending(sid), ["MANAGER_DIRECTION_ONE", "MANAGER_DIRECTION_TWO"]));

    // The interrupt itself: kind:"agent" (never "warning" — see the round-3 decision-record correction),
    // sender "system" (null-maps via coalesceSenderIdentity), headInsert:true — the exact shape
    // redirectWorkerForContextInterrupt produces.
    host.enqueueStdin(sid, "CONTEXT_INTERRUPT_E", "system", undefined, undefined, "agent", undefined, undefined, false, "system", { headInsert: true });
    check("E: the interrupt jumps to the FRONT, ahead of the manager's already-queued run",
      eq(host.getPending(sid), ["CONTEXT_INTERRUPT_E", "MANAGER_DIRECTION_ONE", "MANAGER_DIRECTION_TWO"]));

    const countPaste = () => fake.writes.join("").split(PASTE_START).length - 1;
    const pasteBefore1 = countPaste();
    host.deliverHook(sid, { hook_event_name: "Stop" });
    check("E: exactly ONE submit for the interrupt's own turn", countPaste() - pasteBefore1 === 1);
    const turn1 = fake.writes.join("");
    check("E: that turn carries ONLY the interrupt's own body — not coalesced with the manager's run",
      turn1.includes("CONTEXT_INTERRUPT_E") && !turn1.includes("MANAGER_DIRECTION_ONE") && !turn1.includes("MANAGER_DIRECTION_TWO"));
    check("E: the manager's run is untouched — still queued, still adjacent, for its own turn next",
      eq(host.getPending(sid), ["MANAGER_DIRECTION_ONE", "MANAGER_DIRECTION_TWO"]));

    await sleep(250); // let the interrupt's own turn settle before driving the next Stop
    const pasteBefore2 = countPaste();
    host.deliverHook(sid, { hook_event_name: "Stop" });
    check("E: on the NEXT turn, the manager's run coalesces into exactly ONE submit", countPaste() - pasteBefore2 === 1);
    const turn2 = fake.writes.join("").slice(turn1.length);
    check("E: that turn carries BOTH of the manager's messages, joined into one write",
      turn2.includes("MANAGER_DIRECTION_ONE") && turn2.includes("MANAGER_DIRECTION_TWO"));
    check("E: the queue is now fully drained", host.getPending(sid).length === 0);
  }

  // ===== F. A give-up-held entry already at the head is NOT dropped or reordered by a headInsert arrival =====
  {
    const sid = newSession("F");
    host.enqueueStdin(sid, "PRIMER");
    // A held entry (held until far in the future — never expires within this test): positional arg 11 is
    // `giveUpHeldUntil` on this overload. `isGiveUpHeld` keeps it ineligible to drain, but it still
    // occupies a real slot in `live.pending`.
    host.enqueueStdin(sid, "HELD_ENTRY", "system", undefined, undefined, "warning", undefined, undefined, undefined, "mgr-f", Date.now() + 60_000);
    host.enqueueStdin(sid, "ordinary-f", "system", undefined, undefined, "warning", undefined, undefined, undefined, "mgr-f2");
    check("F: setup — the held entry sits at the head, the ordinary entry behind it", eq(host.getPending(sid), ["HELD_ENTRY", "ordinary-f"]));

    host.enqueueStdin(sid, "EMERGENCY_F", "system", undefined, undefined, "agent", undefined, undefined, false, "system", { headInsert: true });
    check("F: the headInsert entry becomes the new front — nothing queued is dropped, and the held/ordinary entries keep their original relative order, just shifted back by one",
      eq(host.getPending(sid), ["EMERGENCY_F", "HELD_ENTRY", "ordinary-f"]));
  }
} finally {
  for (const sid of ["sess-hi-A", "sess-hi-B", "sess-hi-C", "sess-hi-D", "sess-hi-E", "sess-hi-F"]) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — enqueueStdin's headInsert option places a HELD arrival at the FRONT of live.pending (ahead of any pre-existing entry, including a prior headInsert one or a give-up-held one), is a one-shot per-call option that never retroactively reorders anything or drops anything queued, and a plain arrival stays FIFO byte-identical to before this option existed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
