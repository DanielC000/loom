// Repeated-identical-call detector (card 2d8d2e42) — PURE, dependency-free unit tests, no daemon/db/pty.
// Mirrors tool-attribution.mjs's own style (same PtyHost-adjacent tracker shape, same test harness).
// Run (after a build): node test/repeated-call-tracker.mjs
import { RepeatedCallTracker, REPEATED_CALL_THRESHOLD } from "../dist/pty/repeated-call-tracker.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const N = REPEATED_CALL_THRESHOLD;
check("REPEATED_CALL_THRESHOLD is the card's own suggested N=5 (not silently redefined elsewhere)", N === 5);

// --- RED-FIRST: below N, the detector must emit NOTHING (this is the literal DoD-1 assertion — "assert
// today's code emits NOTHING" before the Nth call) ---------------------------------------------------
{
  const t = new RepeatedCallTracker();
  for (let i = 1; i < N; i++) {
    const r = t.record("s1", "gate_status", "hash-A");
    check(`call ${i}/${N} to the same tool+args -> count=${i}, NOT fired`, r.count === i && r.firedAtThreshold === false);
  }
}

// --- GREEN: call N flips the signal ---------------------------------------------------------------
{
  const t = new RepeatedCallTracker();
  for (let i = 1; i < N; i++) t.record("s2", "gate_status", "hash-A");
  const rN = t.record("s2", "gate_status", "hash-A");
  check(`call ${N}/${N} identical -> count=${N}, FIRES`, rN.count === N && rN.firedAtThreshold === true);
}

// --- escalation: fires again at 2N, 3N, ... (not just the first crossing) — DoD-3's own wording rides on
// exactly this count/threshold pair, no separate counter needed -------------------------------------
{
  const t = new RepeatedCallTracker();
  let lastFired = null;
  for (let i = 1; i <= 3 * N; i++) {
    const r = t.record("s3", "gate_status", "hash-A");
    if (r.firedAtThreshold) lastFired = r.count;
  }
  check("fires again at 2N", (() => { const t2 = new RepeatedCallTracker(); let fired2N = false; for (let i = 1; i <= 2 * N; i++) { const r = t2.record("s3b", "gate_status", "hash-A"); if (i === 2 * N) fired2N = r.firedAtThreshold; } return fired2N; })());
  check("last fire across 3N calls lands exactly at 3N (fires at every multiple, none skipped)", lastFired === 3 * N);
}

// --- a DIFFERENT tool breaks the streak (no cross-tool bleed) ----------------------------------------
{
  const t = new RepeatedCallTracker();
  for (let i = 1; i < N; i++) t.record("s4", "gate_status", "hash-A");
  const r = t.record("s4", "worker_status", "hash-A"); // same session, same argsHash, DIFFERENT tool
  check("a different tool resets the streak to count=1, even with the same argsHash", r.count === 1 && r.firedAtThreshold === false);
}

// --- DIFFERENT arguments to the SAME tool breaks the streak (identical-ARGS, not just identical-tool) --
{
  const t = new RepeatedCallTracker();
  for (let i = 1; i < N; i++) t.record("s5", "gate_status", "hash-A");
  const r = t.record("s5", "gate_status", "hash-B"); // same tool, DIFFERENT args
  check("different arguments reset the streak to count=1, even to the same tool", r.count === 1 && r.firedAtThreshold === false);
}

// --- volume alone is NOT the signal: many DIFFERENT calls in a row never fires (bound #1 — this is not a
// rate limit) ------------------------------------------------------------------------------------------
{
  const t = new RepeatedCallTracker();
  let anyFired = false;
  for (let i = 1; i <= 3 * N; i++) {
    const r = t.record("s6", "gate_status", `hash-${i}`); // every call carries DIFFERENT args
    if (r.firedAtThreshold) anyFired = true;
  }
  check("3N calls with all-different arguments never fires (call volume alone is not the signal)", anyFired === false);
}

// --- turn boundary: resetTurn (the Stop/StopFailure hook site) breaks a streak that hasn't reached N ---
{
  const t = new RepeatedCallTracker();
  for (let i = 1; i < N; i++) t.record("s7", "gate_status", "hash-A"); // N-1 identical calls, one short of firing
  t.resetTurn("s7"); // a Stop fired — this is a NEW turn now
  const r = t.record("s7", "gate_status", "hash-A"); // same tool+args as before the reset
  check("resetTurn drops the streak even mid-count — a repeat never spans a Stop boundary", r.count === 1 && r.firedAtThreshold === false);
}

// --- turn boundary: N identical calls SPLIT across two turns (N-1 then Stop then 1 more) must NOT fire -
// this is the direct DoD-1 negative: "no Stop boundary between them" is a REQUIREMENT, not an incidental --
{
  const t = new RepeatedCallTracker();
  for (let i = 1; i < N; i++) t.record("s8", "gate_status", "hash-A");
  t.resetTurn("s8"); // turn boundary between the (N-1)th and Nth identical call
  const r = t.record("s8", "gate_status", "hash-A");
  check(`${N} identical calls split across a Stop boundary never fires (would wrongly fire if resetTurn were a no-op)`, r.firedAtThreshold === false);
}

// --- session isolation: two sessions never share a streak --------------------------------------------
{
  const t = new RepeatedCallTracker();
  for (let i = 1; i < N; i++) t.record("s9a", "gate_status", "hash-A");
  const other = t.record("s9b", "gate_status", "hash-A"); // different session, same tool+args
  check("a different session's identical calls never contribute to another session's streak", other.count === 1);
}

// --- forget (session-exit cleanup): drops the bucket, same discipline as resetTurn -------------------
{
  const t = new RepeatedCallTracker();
  for (let i = 1; i < N; i++) t.record("s10", "gate_status", "hash-A");
  t.forget("s10");
  const r = t.record("s10", "gate_status", "hash-A");
  check("forget drops the streak (session-exit cleanup, mirrors resetTurn)", r.count === 1);
}

console.log(failures === 0 ? `ALL PASS (${N} = REPEATED_CALL_THRESHOLD)` : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
